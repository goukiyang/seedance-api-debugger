import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import type { CanvasRoleMediaBinding, CanvasRoleWork } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { assertLiveNode, assertRoleCollaborationWritable, ownedRun, type RoleDb } from './permissions';
import { roleMutation } from './repository';
import { currentRoleGrant } from './advancement';
import { isRoleCollaborationReadOnly } from './guard';
import { assertCurrentMaterials, assertEffectiveInputs, latestWorks, taskRequirements, workInputDigest } from './work';
import { originalIdentity, imageTaskOriginal } from './media';
import { COLLABORATION_CAPABILITY, digest, identifier, integer, pointCents, record, RoleError, text,
  type JsonRecord, type RoleSnapshot } from './types';

type MediaContext = {
  schema: 'role.media.v1'; ownerId: string; documentId: string; workflowId: string; runId: string;
  workId: string; workRevision: number; requirementsRevision: number; outputSlotId: string;
  inputDigest: string; generationNodeId: string; kind: 'image' | 'video'; expiresAt: string; signature: string;
};
export type RoleMediaSubmission = { user: SessionUser; context: unknown; generationNodeId: string };
type MediaSource = { kind: 'image' | 'video'; taskId: string; requestId: string; ordinal: number;
  model: string; providerId: string | null; reservedPoints: number };

const sourceKind = (kind: MediaSource['kind']) => kind === 'image' ? 'image_studio_task' : 'video_task';

function signature(payload: Omit<MediaContext, 'signature'>) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret === 'dev-secret-change-in-production') throw new RoleError('媒体来源签名尚未配置，未提交生成', 503, 'media_signing_unavailable');
  return createHmac('sha256', secret).update('canvas-role-media-v1\0' + digest(payload)).digest('hex');
}
function readContext(raw: unknown): MediaContext {
  if (!record(raw) || raw.schema !== 'role.media.v1' || !['image', 'video'].includes(String(raw.kind))) throw new RoleError('角色媒体来源无效');
  const payload: Omit<MediaContext, 'signature'> = {
    schema: 'role.media.v1', ownerId: identifier(raw.ownerId), documentId: identifier(raw.documentId),
    workflowId: identifier(raw.workflowId), runId: identifier(raw.runId), workId: identifier(raw.workId),
    workRevision: integer(raw.workRevision), requirementsRevision: integer(raw.requirementsRevision),
    outputSlotId: text(raw.outputSlotId, 160, true), inputDigest: text(raw.inputDigest, 64, true),
    generationNodeId: identifier(raw.generationNodeId), kind: raw.kind as 'image' | 'video', expiresAt: text(raw.expiresAt, 40, true),
  };
  const supplied = typeof raw.signature === 'string' && /^[a-f0-9]{64}$/.test(raw.signature) ? raw.signature : '';
  if (!supplied || !/^[a-f0-9]{64}$/.test(payload.inputDigest) || !Number.isFinite(Date.parse(payload.expiresAt))
    || !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(signature(payload), 'hex'))) throw new RoleError('角色媒体来源签名无效', 403, 'media_context_invalid');
  return { ...payload, signature: supplied };
}

// Include only role requests in the existing fingerprint; legacy serialization is unchanged.
export function roleMediaFingerprint(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const { signature: _signature, ...context } = readContext(raw);
  return digest(context);
}

async function mediaWork(db: RoleDb, user: SessionUser, workId: string, write: boolean) {
  const work = await db.canvasRoleWork.findUnique({ where: { id: identifier(workId) } });
  if (!work) throw new RoleError('工作不存在', 404, 'work_not_found');
  const { run, document } = await ownedRun(db, user, work.role_task_run_id, write);
  return { work, run, document };
}

async function activeMediaWork(db: RoleDb, user: SessionUser, workId: string) {
  assertRoleCollaborationWritable();
  const current = await mediaWork(db, user, workId, true);
  const { work, run, document } = current;
  const requirements = await taskRequirements(db, run.id, run.requirements_revision);
  const { control, authorization, grant } = await currentRoleGrant(db, user, run, requirements);
  if (run.paused || run.status !== 'active' || control.pause_reason) throw new RoleError('本任务未授权或已暂停，请回角色工作查看', 409, 'media_authorization_required');
  const graph = JSON.parse(document.document_json);
  if (document.schema_version < 5 || !graph.requiredCapabilities?.includes(COLLABORATION_CAPABILITY)) throw new RoleError('请用当前角色协作页面保存画布后继续', 426, 'collaboration_capability_required');
  if (work.requirements_revision !== run.requirements_revision || !['ready', 'working', 'revision'].includes(work.phase)
    || (await latestWorks(db, run.id, run.requirements_revision)).find(item => item.node_id === work.node_id)?.id !== work.id) throw new RoleError('这是历史或尚未就绪的工作，未提交媒体生成', 409, 'media_work_changed');
  if (await db.canvasRoleMediaBinding.findFirst({ where: { run_id: run.id, OR: [
    { state: { in: ['unknown', 'source_unavailable'] } }, { fee_state: 'unknown', settlement_applied: false },
  ] }, select: { id: true } })) throw new RoleError('原媒体请求或费用仍未知，请先查询原任务，不会新发生成', 409, 'media_unknown_pending');
  const pendingSources = await db.canvasRoleMediaBinding.findMany({ where: { run_id: run.id, settlement_applied: false },
    select: { source_kind: true, source_task_id: true } });
  const imageIds = pendingSources.filter(item => item.source_kind === 'image_studio_task').map(item => item.source_task_id);
  const videoIds = pendingSources.filter(item => item.source_kind === 'video_task').map(item => item.source_task_id);
  const unknownImage = imageIds.length && await db.imageStudioTask.findFirst({ where: { id: { in: imageIds }, OR: [
    { status: { in: ['uncertain', 'channel_uncertain'] } },
    { billing_mode: 'actual', billing_settled_at: { not: null }, actual_amount_micros: null, billing_status: { not: 'channel_cancelled' } },
  ] }, select: { id: true } });
  const unknownVideo = videoIds.length && await db.videoTask.findFirst({ where: { id: { in: videoIds },
    local_status: { notIn: ['succeeded', 'failed', 'cancelled'] }, OR: [
      { local_status: { in: ['unknown', 'submission_unconfirmed'] } }, { error_code: { contains: 'UNCONFIRMED' } },
    ] }, select: { id: true } });
  if (unknownImage || unknownVideo) throw new RoleError('原生成器仍记录未知请求或费用，请先查询原任务', 409, 'media_unknown_pending');
  assertLiveNode(work, document.document_json);
  const participant = requirements.participants.find(item => item.nodeId === work.node_id && item.participation !== 'excluded');
  const role: RoleSnapshot = JSON.parse(work.snapshot_json).role;
  if (requirements.schema !== 'role.requirements.v2' || requirements.workflowId !== control.workflow_id
    || !participant || (role.executor.kind === 'person' ? role.executor.userId !== user.id
      : role.executor.kind !== 'ai' || !participant.ownerMaySubmit)) throw new RoleError('本次分工未允许本人提交媒体成果', 403, 'media_submission_forbidden');
  await assertCurrentMaterials(db, user, document.document_json, requirements);
  await assertEffectiveInputs(db, work, requirements, document.document_json, user);
  if (authorization.granted_by !== user.id || grant.schema !== 'role.authorization.v2'
    || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now() || !Array.isArray(grant.media)) throw new RoleError('任务授权与当前要求不匹配', 409, 'media_grant_changed');
  return { ...current, control, grant, authorization, requirements };
}

export async function createRoleMediaContext(user: SessionUser, workId: string, body: JsonRecord) {
  assertRoleCollaborationWritable();
  return roleMutation(user, body, `role_media_context:${identifier(workId)}`,
    db => mediaWork(db, user, workId, true), async db => {
      const { work, run, document, control, grant, requirements, authorization } = await activeMediaWork(db, user, workId);
      if (integer(body.base_revision) !== work.revision || integer(body.requirements_revision) !== run.requirements_revision) throw new RoleError('工作已更新，请保留输入后重新打开生成器', 409, 'revision_conflict');
      const kind = body.kind;
      if (kind !== 'image' && kind !== 'video') throw new RoleError('请选择图片或视频生成器');
      if (!grant.media.some(item => item.kind === kind)) throw new RoleError('本任务没有此媒体生成授权，请在范围与预算中明确授权', 409, 'media_scope_missing');
      const generationNodeId = identifier(body.generation_node_id);
      const node = JSON.parse(document.document_json).canvas.nodes.find((item: JsonRecord) => item.id === generationNodeId);
      if (node?.type !== kind) throw new RoleError('请先保存对应的原生成节点', 409, 'media_node_missing');
      const outputSlotId = text(body.outputSlotId, 160, true);
      const items = requirements.participants.find(item => item.nodeId === work.node_id)?.deliverableItems
        || JSON.parse(work.snapshot_json).role.requiredItems || [];
      if (!(items.length ? items.includes(outputSlotId) || /^item-\d+$/.test(outputSlotId) && Number(outputSlotId.slice(5)) < items.length : outputSlotId === 'output')) throw new RoleError('此交付项不属于本次工作', 409, 'media_output_slot_invalid');
      const payload: Omit<MediaContext, 'signature'> = {
        schema: 'role.media.v1', ownerId: user.id, documentId: document.id, workflowId: control.workflow_id,
        runId: run.id, workId: work.id, workRevision: work.revision, requirementsRevision: work.requirements_revision,
        outputSlotId, inputDigest: workInputDigest(work, requirements), generationNodeId, kind,
        expiresAt: new Date(Math.min(Date.now() + 10 * 60_000, authorization.expires_at.getTime(), Date.parse(grant.expiresAt))).toISOString(),
      };
      return { objectId: work.id, result: { context: { ...payload, signature: signature(payload) }, expiresAt: payload.expiresAt,
        workId: work.id, runId: run.id, outputSlotId, media: grant.media.filter(item => item.kind === kind) } };
    });
}

export async function bindRoleMediaTask(db: RoleDb, submission: RoleMediaSubmission, source: MediaSource) {
  assertRoleCollaborationWritable();
  const context = readContext(submission.context);
  const { user } = submission;
  if (context.ownerId !== user.id || context.kind !== source.kind || context.generationNodeId !== submission.generationNodeId
    || Date.parse(context.expiresAt) <= Date.now()) throw new RoleError('媒体来源已过期或目标已变化，请重新打开生成器', 409, 'media_context_expired');
  const { work, run, document, control, grant, requirements } = await activeMediaWork(db, user, context.workId);
  if (document.id !== context.documentId || control.workflow_id !== context.workflowId || run.id !== context.runId
    || work.revision !== context.workRevision || run.requirements_revision !== context.requirementsRevision
    || workInputDigest(work, requirements) !== context.inputDigest) throw new RoleError('任务或材料已变化，未提交媒体生成', 409, 'media_context_changed');
  const node = JSON.parse(document.document_json).canvas.nodes.find((item: JsonRecord) => item.id === context.generationNodeId);
  if (node?.type !== source.kind) throw new RoleError('原生成节点已移除，未提交', 409, 'media_node_missing');
  const origin = node.data?.roleMediaOrigin;
  if (origin && (origin.ownerId !== user.id || origin.workId !== work.id || origin.runId !== run.id
    || origin.documentId !== document.id || origin.outputSlotId !== context.outputSlotId)) throw new RoleError('原生成节点的固定角色归属已变化', 409, 'media_context_changed');
  const points = pointCents(source.reservedPoints);
  const allowed = grant.media.find(item => item.kind === source.kind && item.model === source.model && item.providerId === source.providerId);
  if (!allowed) throw new RoleError('模型或供应商超出媒体授权，请回任务重新授权', 409, 'media_scope_changed');
  if (!Number.isSafeInteger(grant.pointLimit) || grant.pointLimit < 0 || run.budget_points_limit == null
    || run.reserved_points + run.settled_points + points > Math.min(grant.pointLimit, run.budget_points_limit)) throw new RoleError('本任务总点数额度不足，未提交媒体生成', 409, 'role_budget_exceeded');
  const kind = sourceKind(source.kind);
  const prior = await db.canvasRoleMediaBinding.findUnique({ where: { source_kind_source_task_id: { source_kind: kind, source_task_id: source.taskId } } });
  const contextDigest = roleMediaFingerprint(context)!;
  if (prior) {
    if (prior.context_digest !== contextDigest || prior.work_id !== work.id) throw new RoleError('原媒体任务已绑定其他工作', 409, 'media_binding_conflict');
    return prior;
  }
  const batch = await db.canvasRoleMediaBinding.aggregate({ where: { work_id: work.id,
    source_kind: kind, source_request_id: source.requestId }, _sum: { reserved_points: true } });
  if ((batch._sum.reserved_points || 0) + points > pointCents(allowed.maxPoints)) throw new RoleError('本次整批媒体点数超出授权，请回任务重新授权', 409, 'media_scope_changed');
  const changed = await db.canvasRoleTaskRun.updateMany({ where: { id: run.id, revision: run.revision,
    paused: false, status: 'active', requirements_revision: context.requirementsRevision },
    data: { reserved_points: { increment: points }, revision: { increment: 1 } } });
  if (changed.count !== 1) throw new RoleError('任务预算同时发生变化，请保留原请求后核对', 409, 'revision_conflict');
  return db.canvasRoleMediaBinding.create({ data: {
    id: randomUUID(), run_id: run.id, work_id: work.id, requirements_revision: context.requirementsRevision,
    batch_ordinal: integer(source.ordinal, 0), reserved_points: points, input_digest: context.inputDigest,
    context_digest: contextDigest, generation_node_id: context.generationNodeId, output_slot_id: context.outputSlotId,
    source_kind: kind, source_task_id: identifier(source.taskId), source_request_id: text(source.requestId, 200, true),
    state: 'pending', fee_state: 'reserved', next_check_at: new Date(),
    receipt_json: JSON.stringify({ workRevision: context.workRevision, grantId: control.active_grant_id,
      model: source.model, providerId: source.providerId, authorization: 'owner_generator_confirmation' }),
  } });
}

export async function reconcileRoleMediaBindings(user: SessionUser, runId: string): Promise<unknown> {
  const { run: owned } = await ownedRun(prisma, user, identifier(runId));
  const rows = await prisma.canvasRoleMediaBinding.findMany({ where: { run_id: runId },
    orderBy: [{ updated_at: 'asc' }, { id: 'asc' }], take: 101 });
  if (isRoleCollaborationReadOnly()) return { bindings: rows.slice(0, 100).map(binding => storedBindingView(binding, owned.document_id)),
    limited: rows.length > 100, resend: false, readOnly: true };
  const bindings: JsonRecord[] = [];
  for (const row of rows.slice(0, 100)) {
    bindings.push(await prisma.$transaction(async db => {
      assertRoleCollaborationWritable();
      const { run } = await ownedRun(db, user, runId);
      const binding = await db.canvasRoleMediaBinding.findUniqueOrThrow({ where: { id: row.id } });
      const work = await db.canvasRoleWork.findUniqueOrThrow({ where: { id: binding.work_id } });
      let state = 'pending', feeState = 'pending', settledPoints: number | null = null;
      let refs: JsonRecord[] = [], receipt: JsonRecord = JSON.parse(binding.receipt_json);
      let recovery: string;
      if (binding.source_kind === 'image_studio_task') {
        recovery = '/template-studio?type=image';
        const task = await db.imageStudioTask.findUnique({ where: { id: binding.source_task_id } });
        if (!task || task.owner_id !== user.id) { state = 'source_unavailable'; feeState = 'unknown'; }
        else {
          receipt = { ...receipt, taskStatus: task.status, billingStatus: task.billing_status, requestId: task.gateway_request_id,
            amountMicros: task.actual_amount_micros };
          feeState = task.billing_status;
          const billKnown = task.billing_mode !== 'actual' || task.actual_amount_micros != null
            || task.billing_status === 'channel_cancelled';
          if (task.billing_settled_at && task.actual_credits != null && billKnown) settledPoints = pointCents(task.actual_credits);
          if (!billKnown && task.billing_settled_at) feeState = 'unknown';
          if (task.status === 'succeeded') {
            try { refs = [(await imageTaskOriginal(db, user, task.id)).snapshot]; state = 'ready'; }
            catch (error) { if (!(error instanceof RoleError)) throw error; state = 'original_unavailable'; }
          } else if (['failed', 'cancelled'].includes(task.status)) state = 'failed';
          else if (['uncertain', 'channel_uncertain'].includes(task.status)) state = 'unknown';
        }
      } else if (binding.source_kind === 'video_task') {
        recovery = `/tools/ultimate-canvas?document_id=${encodeURIComponent(run.document_id)}&focus_node_id=${encodeURIComponent(binding.generation_node_id)}`;
        const task = await db.videoTask.findUnique({ where: { id: binding.source_task_id } });
        if (!task || task.owner_user_id !== user.id || task.user_id !== user.id) { state = 'source_unavailable'; feeState = 'unknown'; }
        else {
          await assertCanViewTask(user, task);
          receipt = { ...receipt, taskStatus: task.local_status, providerBillingStatus: task.provider_billing_status };
          const terminal = ['succeeded', 'failed', 'cancelled'].includes(task.local_status);
          if (terminal && task.actual_cost != null && task.frozen_cost === 0) settledPoints = pointCents(task.actual_cost);
          feeState = settledPoints != null ? 'settled' : terminal ? 'unknown' : 'pending';
          if (task.local_status === 'succeeded') {
            try { refs = [(await originalIdentity(db, user, { taskId: task.id })).snapshot]; state = 'ready'; }
            catch (error) { if (!(error instanceof RoleError)) throw error; state = 'original_unavailable'; }
          } else if (terminal) state = 'failed';
          else if (['unknown', 'submission_unconfirmed'].includes(task.local_status) || task.error_code?.includes('UNCONFIRMED')) state = 'unknown';
        }
      } else throw new RoleError('媒体原任务类型无效，已停止回收', 409, 'media_binding_conflict');
      const savedRefs: unknown = JSON.parse(binding.original_refs_json);
      if (Array.isArray(savedRefs) && savedRefs.length) {
        if (refs.length && digest(refs) !== digest(savedRefs)) state = 'original_changed';
        refs = savedRefs.filter(record);
      }
      const requirements = await taskRequirements(db, run.id, work.requirements_revision);
      const late = run.requirements_revision !== binding.requirements_revision
        || work.revision !== receipt.workRevision
        || workInputDigest(work, requirements) !== binding.input_digest
        || (await latestWorks(db, run.id, run.requirements_revision)).find(item => item.node_id === work.node_id)?.id !== work.id;
      if (state === 'ready' && late) state = 'late';
      // A source settlement never freezes/deducts credits again. CAS accounts it in this run once.
      if (settledPoints != null && !binding.settlement_applied) {
        const applied = await db.canvasRoleMediaBinding.updateMany({ where: { id: binding.id, settlement_applied: false },
          data: { settlement_applied: true, settled_points: settledPoints } });
        if (applied.count === 1) {
          if (run.reserved_points < binding.reserved_points) throw new RoleError('原媒体预留与任务额度不一致，已停止回收', 409, 'media_reservation_conflict');
          await db.canvasRoleTaskRun.update({ where: { id: run.id }, data: {
            reserved_points: { decrement: binding.reserved_points }, settled_points: { increment: settledPoints }, revision: { increment: 1 },
          } });
        }
      }
      const waiting = ['pending', 'unknown'].includes(state) || settledPoints == null;
      if ((state === 'unknown' || feeState === 'unknown') && !run.paused && run.status === 'active') {
        await db.canvasRoleTaskRun.update({ where: { id: run.id }, data: { paused: true, revision: { increment: 1 } } });
        await db.canvasRoleRunControl.updateMany({ where: { run_id: run.id }, data: {
          pause_reason: 'media_unknown_pending', revision: { increment: 1 },
        } });
      }
      await db.canvasRoleMediaBinding.update({ where: { id: binding.id }, data: {
        state, fee_state: feeState, original_refs_json: JSON.stringify(refs), receipt_json: JSON.stringify(receipt),
        next_check_at: waiting ? new Date(Date.now() + 15_000) : null,
      } });
      return { id: binding.id, workId: work.id, runId: run.id, outputSlotId: binding.output_slot_id,
        requirementsRevision: binding.requirements_revision, state, feeState, attachments: refs,
        reservedPoints: binding.reserved_points / 100, settledPoints: settledPoints == null ? null : settledPoints / 100,
        settlementApplied: binding.settlement_applied || settledPoints != null, sourceKind: binding.source_kind,
        sourceTaskId: binding.source_task_id, recovery, late };
    }, { timeout: 15000 }));
  }
  return { bindings, limited: rows.length > 100, resend: false };
}

function storedBindingView(binding: CanvasRoleMediaBinding, documentId: string): JsonRecord {
  const refs: unknown = JSON.parse(binding.original_refs_json);
  return { id: binding.id, workId: binding.work_id, runId: binding.run_id, outputSlotId: binding.output_slot_id,
    requirementsRevision: binding.requirements_revision, state: binding.state, feeState: binding.fee_state,
    attachments: Array.isArray(refs) ? refs.filter(record) : [], reservedPoints: binding.reserved_points / 100,
    settledPoints: binding.settled_points == null ? null : binding.settled_points / 100, settlementApplied: binding.settlement_applied,
    sourceKind: binding.source_kind, sourceTaskId: binding.source_task_id, late: binding.state === 'late',
    recovery: binding.source_kind === 'image_studio_task' ? '/template-studio?type=image'
      : `/tools/ultimate-canvas?document_id=${encodeURIComponent(documentId)}&focus_node_id=${encodeURIComponent(binding.generation_node_id)}` };
}

export async function adoptRoleMediaBinding(db: RoleDb, user: SessionUser, work: CanvasRoleWork, bindingId: string): Promise<{ attachments: JsonRecord[]; bindingId: string }> {
  assertRoleCollaborationWritable();
  const { run, document } = await ownedRun(db, user, work.role_task_run_id, true);
  const current = await db.canvasRoleWork.findUniqueOrThrow({ where: { id: work.id } });
  if (current.revision !== work.revision || current.requirements_revision !== run.requirements_revision
    || (await latestWorks(db, run.id, run.requirements_revision)).find(item => item.node_id === current.node_id)?.id !== current.id) throw new RoleError('工作已更新，请打开当前稿再采用', 409, 'revision_conflict');
  assertLiveNode(current, document.document_json);
  const binding = await db.canvasRoleMediaBinding.findUnique({ where: { id: identifier(bindingId) } });
  const sourceWork = binding && await db.canvasRoleWork.findUnique({ where: { id: binding.work_id } });
  if (!binding || binding.run_id !== run.id || sourceWork?.node_id !== current.node_id
    || !['ready', 'late'].includes(binding.state)) throw new RoleError('此媒体原件尚不可采用，或不属于本岗位', 409, 'media_binding_unavailable');
  const raw: unknown = JSON.parse(binding.original_refs_json);
  if (!Array.isArray(raw) || !raw.length || raw.length > 20) throw new RoleError('原件尚未回收，请查询原媒体任务', 409, 'media_original_missing');
  const attachments: JsonRecord[] = [];
  for (const ref of raw) {
    if (!record(ref)) throw new RoleError('媒体原件引用无效');
    if (binding.source_kind === 'image_studio_task' ? ref.imageTaskId !== binding.source_task_id
      : binding.source_kind !== 'video_task' || ref.taskId !== binding.source_task_id) throw new RoleError('原件与固定媒体任务不匹配', 409, 'media_binding_conflict');
    const source = await originalIdentity(db, user, ref);
    if (source.snapshot.sourceDigest !== ref.sourceDigest) throw new RoleError('原件已失效或变化，未采用替代内容', 409, 'original_changed');
    attachments.push({ ...source.snapshot, mediaBindingId: binding.id, outputSlotId: binding.output_slot_id,
      sourceWorkId: binding.work_id, sourceRequirementsRevision: binding.requirements_revision,
      selection: { mediaBindingId: binding.id, sourceDigest: source.snapshot.sourceDigest } });
  }
  return { attachments, bindingId: binding.id };
}
