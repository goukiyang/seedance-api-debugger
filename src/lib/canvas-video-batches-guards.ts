import { settleVideoCreationBatch } from '@/lib/creation/settlement';
import { createHash, createHmac } from 'node:crypto';
import { requireLegacySessionSecret } from '@/lib/security/secrets';
import { signPurpose } from '@/lib/security/signatures';
import type { Prisma, VideoTask } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { assertCanViewTask, assertProjectActiveInTransaction } from '@/lib/projects/permissions';
import { creditCents } from '@/lib/credits/precision';
import { getH3ApiSettings } from '@/lib/integrations/h3';
import { getVolcengineIpApiSettings } from '@/lib/integrations/volcengine-ip';
import { VOLCENGINE_IP_VIDEO_PROVIDER } from '@/lib/provider/volcengine-ip';
import { canGenerateInVideoCardStatus } from '@/lib/video-cards/permissions';
import { CANVAS_VIDEO_BATCH_WRITES_ENABLED } from './canvas-video-batches-build-mode';
import { CANVAS_VIDEO_BATCH_CAPABILITY, CANVAS_VIDEO_BATCH_UPGRADE_URL, canvasBatchObject,
  hasCanvasVideoBatchCapability, parseCanvasVideoBatchReference, canvasVideoCount,
  canvasVideoChildState, canvasVideoBatchIsSettled, canvasVideoBatchState,
  type CanvasVideoBatchReference } from './canvas-video-batch-contract';

export type CanvasBatchDb = Prisma.TransactionClient;
export class CanvasVideoBatchError extends AuthError {
  constructor(message: string, status = 409, public readonly code = 'canvas_video_batch_conflict',
    public readonly details: Record<string, unknown> = {}) { super(message, status); }
}
export function assertCanvasVideoBatchCreateEnabled() {
  if (!CANVAS_VIDEO_BATCH_WRITES_ENABLED || process.env.CANVAS_VIDEO_BATCH_CREATE_ENABLED === '0') {
    throw new CanvasVideoBatchError('批量视频处于保护模式，原任务可继续查看，暂不开始新视频', 503, 'canvas_video_batch_guard');
  }
}
export function canvasBatchCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canvasBatchCanonical).join(',')}]`;
  if (canvasBatchObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canvasBatchCanonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function canvasBatchHash(value: unknown) { return createHash('sha256').update(canvasBatchCanonical(value)).digest('hex'); }
export async function canvasVideoRouteFingerprint(provider: unknown, db: CanvasBatchDb = prisma, existing?: string) {
  let routing: unknown;
  if (provider === 'volcengine_ip') routing = await getVolcengineIpApiSettings(db);
  else if (provider === 'h3') {
    const settings = await getH3ApiSettings(db);
    routing = { enabled: settings.enabled, base_url: settings.base_url, api_token: settings.api_token,
      default_preset_id: settings.default_preset_id, default_lora_id: settings.default_lora_id };
  } else routing = { base_url: process.env.SEEDANCE_BASE_URL || 'https://etc.seedance-api.net/server/api', api_key: process.env.SEEDANCE_API_KEY || '' };
  // Only a keyed irreversible identity is stored; never provider credentials themselves.
  const payload = canvasBatchCanonical({ provider, routing });
  if (existing && /^[a-f0-9]{64}$/.test(existing)) {
    return createHmac('sha256', requireLegacySessionSecret()).update(payload).digest('hex');
  }
  return signPurpose('pricing', payload, 'hex');
}
export function canvasBatchBusinessFingerprint(body: Record<string, unknown>) {
  const { pricing_quote_token: _token, pricing_revision: _revision, pricing_fingerprint_version: _version,
    max_estimated_cost: _maximum, canvas_video_batch: _batch, required_capabilities: _caps, ...stable } = body;
  return canvasBatchHash(stable);
}
export function canvasVideoNodeIdentity(body: Record<string, unknown>) {
  const metadata = canvasBatchObject(body.source_metadata) ? body.source_metadata : {};
  return { documentId: String(body.canvas_document_id || metadata.canvas_document_id || ''),
    nodeId: String(body.canvas_node_id || metadata.canvas_node_id || '') };
}
export async function requireCanvasVideoBatchDocumentCapability(db: CanvasBatchDb, documentId: string, capabilities: unknown) {
  if (hasCanvasVideoBatchCapability(capabilities)) return;
  const used = await db.canvasVideoBatch.findFirst({ where: { document_id: documentId }, select: { id: true } });
  if (used) throw new CanvasVideoBatchError('此画布已使用批量视频，请升级页面后保存；当前草稿保留', 426,
    'canvas_video_batch_capability_required', { required_capabilities: [CANVAS_VIDEO_BATCH_CAPABILITY], upgrade_url: CANVAS_VIDEO_BATCH_UPGRADE_URL });
}
export type CanvasVideoAdmission = { reference: CanvasVideoBatchReference; childRevision: number; fingerprint: string };

export async function assertCanvasVideoBatchDedupe(user: SessionUser, admission: CanvasVideoAdmission | null,
  task: { id: string; user_id: string | null; idempotency_key: string | null }) {
  if (!admission) return;
  const child = await prisma.canvasVideoBatchChild.findUnique({ where: { id: admission.reference.child_id }, include: { batch: true } });
  if (!child || child.batch_id !== admission.reference.batch_id || child.task_id !== task.id
    || child.batch.owner_user_id !== user.id || task.user_id !== user.id || task.idempotency_key !== child.idempotency_key) {
    throw new CanvasVideoBatchError('原请求的父子任务绑定待核对，请只查询原批次', 409, 'canvas_video_batch_unconfirmed');
  }
}

function reference(body: Record<string, unknown>) {
  try { return parseCanvasVideoBatchReference(body.canvas_video_batch); }
  catch (error) { throw new CanvasVideoBatchError((error as Error).message, 400, 'canvas_video_batch_invalid'); }
}
export function canvasVideoBatchTaskResponse(task: VideoTask) {
  return { id: task.id, provider: task.provider, provider_task_id: task.provider_task_id, status: task.local_status,
    model: task.model, estimated_cost: task.estimated_cost, frozen_cost: task.frozen_cost, created_at: task.created_at,
    project_id: task.project_id, video_card_id: task.video_card_id, deduplicated: true, fingerprint_verified: true };
}

/** Runs before any early dedupe; caller data is replaced, not merged, with the frozen server input. */
export async function restoreCanvasVideoBatchCreate(user: SessionUser, received: Record<string, unknown>, endpoint: 'ordinary' | 'ip'):
  Promise<{ body: Record<string, unknown>; admission: CanvasVideoAdmission | null; existingTask: VideoTask | null }> {
  const ref = reference(received);
  if (!ref) {
    if (typeof received.idempotency_key === 'string' && received.idempotency_key.startsWith('cvb:')) throw new CanvasVideoBatchError('批次原号必须携带父子身份', 400, 'canvas_video_batch_required');
    let count;
    try { count = canvasVideoCount(received.count); }
    catch (error) { throw new CanvasVideoBatchError((error as Error).message, 400, 'canvas_video_count_invalid'); }
    if (count !== 1) throw new CanvasVideoBatchError('批量视频须先确认完整报价并准备批次', 400, 'canvas_video_batch_required');
    if (typeof received.idempotency_key === 'string' && await prisma.canvasVideoBatchChild.findUnique({
      where: { idempotency_key: received.idempotency_key }, select: { id: true },
    })) throw new CanvasVideoBatchError('此原请求属于视频批次，请查询原批次', 409, 'canvas_video_batch_required');
    return { body: received, admission: null, existingTask: null };
  }
  const child = await prisma.canvasVideoBatchChild.findUnique({ where: { id: ref.child_id }, include: { batch: true } });
  if (!child || child.batch_id !== ref.batch_id || child.batch.owner_user_id !== user.id) throw new CanvasVideoBatchError('视频批次不存在或无权访问', 404);
  if (received.idempotency_key !== undefined && received.idempotency_key !== child.idempotency_key) throw new CanvasVideoBatchError('子请求编号与原批次不同，未重新提交');
  const frozen = JSON.parse(child.frozen_input_json) as Record<string, unknown>;
  if ((frozen.provider === 'volcengine_ip' ? 'ip' : 'ordinary') !== endpoint) throw new CanvasVideoBatchError('子请求必须使用原视频通道');
  if (canvasBatchBusinessFingerprint(frozen) !== child.business_fingerprint) throw new CanvasVideoBatchError('原批次冻结内容无法确认，已停止受理', 503);
  if (child.task_id) {
    const task = await prisma.videoTask.findUnique({ where: { id: child.task_id } });
    const metadata = task ? JSON.parse(task.source_metadata_json || '{}') : null;
    if (!task || task.user_id !== user.id || task.idempotency_key !== child.idempotency_key
      || task.project_id !== child.batch.project_id || task.video_card_id !== child.batch.video_card_id
      || task.video_branch_id !== child.batch.video_branch_id || task.model !== frozen.model
      || task.provider !== (frozen.provider === 'volcengine_ip' ? VOLCENGINE_IP_VIDEO_PROVIDER : frozen.provider)
      || task.source_request_id !== frozen.source_request_id || metadata?.canvas_document_id !== child.batch.document_id
      || metadata?.canvas_node_id !== child.batch.node_id) {
      throw new CanvasVideoBatchError('原子任务绑定待核对，请只查询原请求', 409, 'canvas_video_batch_unconfirmed');
    }
    await assertCanViewTask(user, task);
    return { body: frozen, admission: null, existingTask: task };
  }
  if (child.state !== 'prepared' || !child.batch.active_node_key) throw new CanvasVideoBatchError('本子项已停止或明确拒绝，不会重新生成', 409,
    'canvas_video_batch_child_sealed', { rejection_receipt: child.rejection_receipt ? JSON.parse(child.rejection_receipt) : null });
  if (ref.child_revision !== child.revision) throw new CanvasVideoBatchError('原子请求报价版本已结束，请查询原批次', 409, 'canvas_video_batch_child_changed');
  assertCanvasVideoBatchCreateEnabled();
  const admission = { reference: ref, childRevision: child.revision, fingerprint: child.business_fingerprint };
  if (await canvasVideoRouteFingerprint(frozen.provider, prisma, child.route_fingerprint) !== child.route_fingerprint || child.quote_expires_at.getTime() <= Date.now()) {
    await sealCanvasVideoQuoteAttempt(user, admission);
    throw new CanvasVideoBatchError('原报价已过期或通道配置已变化，请重新确认未开始子项报价', 409, 'canvas_video_batch_requote_required');
  }
  return { body: { ...frozen, pricing_revision: child.quote_revision, ...(child.quote_token ? { pricing_quote_token: child.quote_token } : {}),
    max_estimated_cost: child.authorized_maximum / 100, canvas_video_batch: ref },
    admission,
    existingTask: null };
}

/** Same transaction as VideoTask creation, approval consumption and its only credit reserve. */
export async function assertCanvasVideoAdmission(db: CanvasBatchDb, user: SessionUser, body: Record<string, unknown>,
  admission: CanvasVideoAdmission | null, input: { projectId: string; videoCardId: string | null; branchId: string | null; amount: number }) {
  const { documentId, nodeId } = canvasVideoNodeIdentity(body);
  if (!documentId && !nodeId && !admission) return;
  if (!documentId || !nodeId) throw new CanvasVideoBatchError('画布视频归属不完整', 400);
  const doc = await db.canvasDocument.findUnique({ where: { id: documentId } });
  if (!doc || doc.owner_user_id !== user.id || doc.project_id !== input.projectId || doc.status !== 'active') throw new CanvasVideoBatchError('原画布已关闭或归属变化，尚未生成', 409);
  await assertProjectActiveInTransaction(db, user, input.projectId);
  if (input.videoCardId) {
    const card = await db.videoCard.findUnique({ where: { id: input.videoCardId }, select: { project_id: true, status: true } });
    if (!card || card.project_id !== input.projectId || !canGenerateInVideoCardStatus(card.status)) throw new CanvasVideoBatchError('视频卡已关闭或归属变化，尚未生成', 403);
  }
  if (input.branchId) {
    const branch = await db.videoBranch.findUnique({ where: { id: input.branchId }, select: { video_card_id: true, status: true } });
    if (!branch || branch.video_card_id !== input.videoCardId || ['closed', 'merged', 'promoted'].includes(branch.status)) throw new CanvasVideoBatchError('原视频分支已关闭或归属变化，尚未生成', 403);
  }
  const snapshot = JSON.parse(doc.document_json);
  if (!snapshot.canvas?.nodes?.some((node: { id: string }) => node.id === nodeId)) throw new CanvasVideoBatchError('原画布节点已移除，尚未生成', 409);
  let slot = await db.canvasVideoBatch.findUnique({ where: { active_node_key: canvasBatchHash([user.id, documentId, nodeId]) } });
  if (!admission) {
    await requireCanvasVideoBatchDocumentCapability(db, doc.id, body.required_capabilities);
    if (slot) {
      const children = await db.canvasVideoBatchChild.findMany({ where: { batch_id: slot.id } });
      const tasks = await db.videoTask.findMany({ where: { id: { in: children.flatMap(child => child.task_id ? [child.task_id] : []) } } });
      for (const task of tasks) await assertCanViewTask(user, task, db);
      const states = children.map(child => canvasVideoChildState(child, tasks.find(task => task.id === child.task_id)));
      if (children.length === slot.count && canvasVideoBatchIsSettled(states)) {
        await db.canvasVideoBatch.update({ where: { id: slot.id }, data: { active_node_key: null,
          state: canvasVideoBatchState(states), revision: { increment: 1 } } });
        slot = null;
      }
    }
    if (slot) throw new CanvasVideoBatchError('本节点仍有原视频批次，请先查看或停止未开始子项', 409, 'canvas_video_batch_active', { batch_id: slot.id });
    if (typeof body.idempotency_key === 'string' && await db.canvasVideoBatchChild.findUnique({ where: { idempotency_key: body.idempotency_key }, select: { id: true } })) {
      throw new CanvasVideoBatchError('原子请求缺少批次身份，尚未生成');
    }
    return;
  }
  assertCanvasVideoBatchCreateEnabled();
  const child = await db.canvasVideoBatchChild.findUnique({ where: { id: admission.reference.child_id }, include: { batch: true } });
  if (!child || child.batch_id !== admission.reference.batch_id || child.batch.owner_user_id !== user.id
    || child.batch.document_id !== doc.id || child.batch.node_id !== nodeId || slot?.id !== child.batch_id
    || child.batch.project_id !== input.projectId || child.batch.video_card_id !== input.videoCardId
    || child.batch.video_branch_id !== input.branchId || child.idempotency_key !== body.idempotency_key
    || child.business_fingerprint !== admission.fingerprint) throw new CanvasVideoBatchError('原批次归属或输入不一致，尚未生成');
  if (child.task_id) throw new CanvasVideoBatchError('原子任务已受理，请查询该任务', 409, 'canvas_video_batch_child_accepted', { existing_task_id: child.task_id });
  if (child.state !== 'prepared' || child.revision !== admission.childRevision) throw new CanvasVideoBatchError('本子项已停止或报价已更新，请查询原批次', 409, 'canvas_video_batch_child_changed');
  if (await canvasVideoRouteFingerprint(body.provider, db, child.route_fingerprint) !== child.route_fingerprint) throw new CanvasVideoBatchError('原通道配置已变化，请重新确认未开始子项', 409, 'canvas_video_batch_requote_required');
  if (child.quote_expires_at.getTime() <= Date.now()) throw new CanvasVideoBatchError('报价已过期，请重新确认未开始子项', 409, 'canvas_video_batch_requote_required');
  const amount = creditCents(input.amount);
  if (amount < 0 || amount > child.authorized_maximum || child.batch.admitted_total + amount > child.batch.authorized_total) {
    throw new CanvasVideoBatchError('本次费用超过已确认上限，尚未生成', 409, 'canvas_video_batch_ceiling');
  }
  // CAS serializes all siblings against the shared parent ceiling and cancellation revision.
  const claimed = await db.canvasVideoBatch.updateMany({ where: { id: child.batch_id, revision: child.batch.revision,
    active_node_key: child.batch.active_node_key, admitted_total: child.batch.admitted_total },
    data: { admitted_total: { increment: amount }, revision: { increment: 1 }, state: 'processing' } });
  if (claimed.count !== 1) throw new CanvasVideoBatchError('批次同时发生变化，请查询原批次后继续');
}
export async function bindCanvasVideoBatchTask(db: CanvasBatchDb, admission: CanvasVideoAdmission | null, taskId: string, amount: number) {
  if (!admission) return;
  const bound = await db.canvasVideoBatchChild.updateMany({ where: { id: admission.reference.child_id,
    batch_id: admission.reference.batch_id, revision: admission.childRevision, state: 'prepared', task_id: null },
    data: { task_id: taskId, state: 'accepted', admitted_amount: creditCents(amount), revision: { increment: 1 } } });
  if (bound.count !== 1) throw new CanvasVideoBatchError('子任务原号已变化，已停止重复受理');
}

export async function sealCanvasVideoPreparedChildren(db: CanvasBatchDb, input: {
  ownerId: string; documentId: string; removedNodeIds?: string[]; batchId?: string; reason: string;
}) {
  const batches = await db.canvasVideoBatch.findMany({ where: { owner_user_id: input.ownerId, document_id: input.documentId,
    ...(input.batchId ? { id: input.batchId } : {}),
    ...(input.removedNodeIds ? { node_id: { in: input.removedNodeIds } } : {}) }, include: { children: true } });
  for (const batch of batches) {
    const receipt = JSON.stringify({ code: 'canvas_video_batch_stopped', reason: input.reason, batch_id: batch.id, at: new Date().toISOString() });
    await db.canvasVideoBatchChild.updateMany({ where: { batch_id: batch.id, state: 'prepared', task_id: null },
      data: { state: 'cancelled', rejection_receipt: receipt, revision: { increment: 1 } } });
    const allUnstarted = batch.children.every(child => !child.task_id);
    const stopped = await db.canvasVideoBatch.updateMany({ where: { id: batch.id, revision: batch.revision }, data: { state: 'stopped', revision: { increment: 1 },
      ...(allUnstarted ? { active_node_key: null } : {}) } });
    if (stopped.count !== 1) throw new CanvasVideoBatchError('原批次同时变化，未覆盖原受理状态');
    await settleVideoCreationBatch(db, { batchId: batch.id });
  }
}

async function sealCanvasVideoQuoteAttempt(user: SessionUser, admission: CanvasVideoAdmission) {
  await prisma.$transaction(async db => {
    const child = await db.canvasVideoBatchChild.findUnique({ where: { id: admission.reference.child_id }, include: { batch: true } });
    if (!child || child.batch.owner_user_id !== user.id || child.batch_id !== admission.reference.batch_id
      || child.task_id || child.state !== 'prepared' || child.revision !== admission.childRevision) return;
    if (await db.videoTask.findUnique({ where: { user_id_idempotency_key: { user_id: user.id, idempotency_key: child.idempotency_key } }, select: { id: true } })) return;
    const sealed = await db.canvasVideoBatchChild.updateMany({ where: { id: child.id, revision: child.revision, state: 'prepared', task_id: null },
      data: { quote_expires_at: new Date(0), revision: { increment: 1 }, rejection_receipt: JSON.stringify({
        code: 'canvas_video_batch_requote_required', child_id: child.id, request_id: child.request_id,
        rejected_revision: child.revision, at: new Date().toISOString() }) } });
    if (sealed.count === 1) await db.canvasVideoBatch.update({ where: { id: child.batch_id }, data: { revision: { increment: 1 } } });
  });
}

/** A definitive pre-admission 4xx can seal only a still-unbound original child. */
export async function recordCanvasVideoBatchRejection(user: SessionUser, admission: CanvasVideoAdmission | null,
  status: number, payload: Record<string, unknown> | null) {
  if (admission && status === 409 && ['canvas_video_batch_requote_required', 'pricing_quote_changed',
    'pricing_context_invalid', 'pricing_context_changed'].includes(String(payload?.code))) {
    await sealCanvasVideoQuoteAttempt(user, admission); return;
  }
  if (!admission || status < 400 || status >= 500 || status === 409 || status === 429 || payload?.id || payload?.task_id || payload?.existing_task_id) return;
  await prisma.$transaction(async db => {
    const child = await db.canvasVideoBatchChild.findUnique({ where: { id: admission.reference.child_id }, include: { batch: true } });
    if (!child || child.batch.owner_user_id !== user.id || child.batch_id !== admission.reference.batch_id || child.task_id
      || child.state !== 'prepared' || child.revision !== admission.childRevision) return;
    const task = await db.videoTask.findUnique({ where: { user_id_idempotency_key: { user_id: user.id, idempotency_key: child.idempotency_key } }, select: { id: true } });
    if (task) return;
    const receipt = { code: 'canvas_video_batch_rejected', http_status: status, child_id: child.id,
      request_id: child.request_id, message: '原子项在任务受理前被明确拒绝，未重新提交', at: new Date().toISOString() };
    await db.canvasVideoBatchChild.updateMany({ where: { id: child.id, revision: child.revision, state: 'prepared', task_id: null },
      data: { state: 'rejected', rejection_receipt: JSON.stringify(receipt), revision: { increment: 1 } } });
    await db.canvasVideoBatch.update({ where: { id: child.batch_id }, data: { revision: { increment: 1 } } });
  });
}
