import { CreationError } from '@/lib/creation/contract';
import { assertVideoCreationReady, readCreationContext } from '@/lib/creation/context';
import { creationSpecHash, creationSubmissionSpec } from '@/lib/creation/intents';
import { validateCreationBatchApproval } from '@/lib/creation/approval';
import { creationParent, assertCreationLineageUnlocked } from '@/lib/creation/lineage';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma, type CanvasVideoBatch, type CanvasVideoBatchChild } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { assertCanEditCanvasDocument } from '@/lib/canvas-documents';
import { assertCanViewTask, assertProjectActiveInTransaction, getProjectAccess } from '@/lib/projects/permissions';
import { canGenerateInVideoCardStatus } from '@/lib/video-cards/permissions';
import { getProjectBudgetSummary, shouldBillProjectBudget } from '@/lib/projects/budget';
import { getCreditSummary } from '@/lib/credits/policy';
import { creditCents, creditsFromCents, sumCredits } from '@/lib/credits/precision';
import { findUsableApproval } from '@/lib/approvals';
import { quoteVideoPricing, assertVideoPricingAcceptance } from '@/lib/pricing/video';
import { resolveVideoPricingContext, issueVideoPricingCredential } from '@/lib/pricing/video-context';
import { parseSeedanceVideoModel } from '@/lib/provider/seedance-models';
import { getVolcengineIpApiSettings, isVolcengineIpApiReady } from '@/lib/integrations/volcengine-ip';
import { isVolcengineIpModelId, volcengineIpModelResolutions } from '@/lib/integrations/volcengine-ip-models';
import { getH3ApiSettings, H3_PRESET_OPTIONS, isH3Operational } from '@/lib/integrations/h3';
import { assertCanUseReferenceImage } from '@/lib/reference-albums/permissions';
import { CANVAS_VIDEO_BATCH_CAPABILITY, canvasBatchId, canvasBatchObject, canvasVideoCount,
  canvasVideoChildState, canvasVideoBatchState, canvasVideoBatchIsSettled } from './canvas-video-batch-contract';
import { CanvasVideoBatchError, assertCanvasVideoBatchCreateEnabled, canvasBatchHash, canvasBatchBusinessFingerprint,
  canvasVideoRouteFingerprint, sealCanvasVideoPreparedChildren, type CanvasBatchDb } from './canvas-video-batches-guards';

type Body = Record<string, unknown>;
type Batch = CanvasVideoBatch & { children: CanvasVideoBatchChild[] };
type ChildQuote = { id: string; ordinal: number; request_id: string; idempotency_key: string; fingerprint: string;
  route_fingerprint: string; amount: number; pricing_revision: string | null; pricing_token: string | null };
type QuoteEnvelope = { v: 1; actor: string; request_id: string; request_hash: string; batch_id: string | null;
  revision: number | null; expires: number; total: number; children: ChildQuote[] };
type BatchOperation = { hash: string; action: string; revision: number; applied_at: string };
const QUOTE_TTL = 300000;
const MAX_INPUT_BYTES = 262144;
const inputFields = new Set(['prompt', 'promptMentions', 'model', 'provider', 'generation_mode', 'ratio', 'duration', 'resolution',
  'seed', 'generate_audio', 'return_last_frame', 'watermark', 'draft', 'project_id', 'video_card_id', 'video_branch_id',
  'reference_image_ids', 'reference_image_urls', 'reference_video_urls', 'reference_audio_urls', 'first_frame_url', 'last_frame_url',
  'first_frame_image_id', 'last_frame_image_id', 'final_prompt_snapshot', 'prompt_user_edited', 'client_name', 'source_metadata',
  'canvas_document_id', 'canvas_node_id', 'idempotency_key', 'source_request_id', 'resolution_approval_id',
  'pricing_revision', 'pricing_quote_token', 'pricing_fingerprint_version', 'max_estimated_cost', 'count', 'required_capabilities',
  'creation_contract_version', 'intent_id', 'intent_revision', 'continuation', 'baseline_task_id', 'input_source_task_ids']);

function assertActor(user: SessionUser) {
  assertInternalOnly(user, '外部账号无权使用无限画布。');
  if (user.status !== 'active') throw new AuthError('账号已被禁用', 403);
}
function checkedId(value: unknown, label: string) {
  if (!canvasBatchId(value)) throw new CanvasVideoBatchError(`${label}无效`, 400, 'canvas_video_batch_invalid');
  return value;
}
function optionalId(value: unknown) { return value === undefined || value === null || value === '' ? null : checkedId(value, '归属编号'); }
function checkSafeInput(value: unknown, depth = 0): void {
  if (depth > 24) throw new CanvasVideoBatchError('输入层级过深', 400);
  if (Array.isArray(value)) { for (const item of value) checkSafeInput(item, depth + 1); return; }
  if (canvasBatchObject(value)) for (const [key, item] of Object.entries(value)) {
    if (/^(?:__proto__|constructor|prototype|api[_-]?key|access[_-]?token|authorization|password|secret|cookie)$/i.test(key)) throw new CanvasVideoBatchError('输入含不允许保存的凭据字段', 400);
    checkSafeInput(item, depth + 1);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new CanvasVideoBatchError('输入数值无效', 400);
  if (typeof value === 'string' && /^\s*(?:data:|blob:|javascript:)/i.test(value)) throw new CanvasVideoBatchError('请先上传素材再准备视频批次', 400);
}
function normalizeInput(raw: unknown, documentId: string, nodeId: string): Body {
  if (!canvasBatchObject(raw) || Buffer.byteLength(JSON.stringify(raw)) > MAX_INPUT_BYTES) throw new CanvasVideoBatchError('视频批次输入无效或过大', 400);
  checkSafeInput(raw);
  if (Object.keys(raw).some(key => !inputFields.has(key))) throw new CanvasVideoBatchError('批次包含不支持的输入，请保留单视频协议或移除额外操作', 400);
  if (raw.count !== undefined && ![1, 2, 4].includes(raw.count as number)) throw new CanvasVideoBatchError('视频数量无效', 400);
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim() || typeof raw.model !== 'string' || !raw.model.trim()) throw new CanvasVideoBatchError('请保留明确的提示词和视频型号', 400);
  if (!['seedance', 'volcengine_ip', 'h3'].includes(String(raw.provider))) throw new CanvasVideoBatchError('请保留原视频通道，不能自动换商', 400);
  checkedId(raw.project_id, '项目编号');
  if (raw.creation_contract_version !== 2 || raw.video_card_id) checkedId(raw.video_card_id, '视频卡编号');
  if (raw.creation_contract_version === 2 && !raw.video_card_id && raw.video_branch_id) throw new CanvasVideoBatchError('无卡新作不能指定旧方向', 400);
  const branch = optionalId(raw.video_branch_id);
  if (raw.canvas_document_id && raw.canvas_document_id !== documentId || raw.canvas_node_id && raw.canvas_node_id !== nodeId) throw new CanvasVideoBatchError('画布归属与输入不同', 400);
  const metadata = canvasBatchObject(raw.source_metadata) ? raw.source_metadata : {};
  if (metadata.canvas_document_id && metadata.canvas_document_id !== documentId || metadata.canvas_node_id && metadata.canvas_node_id !== nodeId) throw new CanvasVideoBatchError('画布来源与输入不同', 400);
  const { pricing_quote_token: _token, pricing_revision: _revision, pricing_fingerprint_version: _fp,
    max_estimated_cost: _max, idempotency_key: _key, source_request_id: _source, count: _count, required_capabilities: _cap, ...input } = raw;
  return { ...input, provider: raw.provider, model: raw.model.trim(), video_card_id: optionalId(raw.video_card_id), video_branch_id: branch,
    client_name: 'ultimate_canvas', canvas_document_id: documentId, canvas_node_id: nodeId,
    source_metadata: { ...metadata, source: 'ultimate_canvas', provider: raw.provider, canvas_document_id: documentId, canvas_node_id: nodeId },
    required_capabilities: [CANVAS_VIDEO_BATCH_CAPABILITY] };
}
async function assertScope(db: CanvasBatchDb, user: SessionUser, input: Body, documentId: string, nodeId: string) {
  const doc = await db.canvasDocument.findUnique({ where: { id: documentId } });
  if (!doc || doc.owner_user_id !== user.id || doc.status !== 'active' || doc.project_id !== input.project_id) throw new CanvasVideoBatchError('原画布已关闭或归属变化', 409);
  await assertProjectActiveInTransaction(db, user, String(input.project_id));
  if (input.creation_contract_version === 2) {
    await assertVideoCreationReady(db);
    await readCreationContext(user, String(input.project_id), optionalId(input.video_card_id), db);
  }
  const nodes = JSON.parse(doc.document_json).canvas?.nodes;
  if (!Array.isArray(nodes) || !nodes.some((node: { id: string }) => node.id === nodeId)) throw new CanvasVideoBatchError('请先保存当前视频节点', 409);
  const card = input.video_card_id ? await db.videoCard.findUnique({ where: { id: String(input.video_card_id) } }) : null;
  if (input.video_card_id && (!card || card.project_id !== doc.project_id || !canGenerateInVideoCardStatus(card.status))) throw new CanvasVideoBatchError('视频卡已关闭或不属于当前项目', 403);
  if (input.video_branch_id) {
    const branch = await db.videoBranch.findUnique({ where: { id: String(input.video_branch_id) } });
    if (!branch || branch.video_card_id !== card?.id || ['closed', 'merged', 'promoted'].includes(branch.status)) throw new CanvasVideoBatchError('视频分支已关闭或归属不同', 403);
  }
  return doc;
}
async function preflightResources(db: CanvasBatchDb, user: SessionUser, input: Body, count: number, total: number, verifyFunds = true) {
  const project = await db.project.findUnique({ where: { id: String(input.project_id) } });
  if (!project) throw new AuthError('项目不存在', 404);
  if (input.creation_contract_version !== 2 && project.type !== 'personal' && input.resolution === '1080p') {
    const approval = input.resolution_approval_id ? await db.approvalRecord.findFirst({ where: { id: String(input.resolution_approval_id),
      type: 'resolution_1080p', status: 'approved', project_id: project.id, video_card_id: String(input.video_card_id) } })
      : await findUsableApproval(db, { type: 'resolution_1080p', projectId: project.id, videoCardId: String(input.video_card_id) });
    if (!approval || approval.expires_at && approval.expires_at <= new Date()
      || approval.usage_limit !== null && approval.used_count + count > approval.usage_limit || !approval.task_id) throw new CanvasVideoBatchError('当前同卡 1080p 审批不足以覆盖所有未开始视频，请先补齐审批', 403, 'canvas_video_batch_approval_insufficient');
    const baseline = await db.videoTask.findUnique({ where: { id: approval.task_id }, select: { video_card_id: true, version_role: true } });
    if (!baseline || baseline.video_card_id !== input.video_card_id || !['candidate', 'current_best', 'final'].includes(baseline.version_role)) throw new CanvasVideoBatchError('1080p 原审批基准不再有效', 403);
  }
  // Quotation is read-only. Confirmation reuses normal quota readiness, never a parent reserve.
  if (!verifyFunds) return;
  if (shouldBillProjectBudget(project)) {
    const budget = await getProjectBudgetSummary(db, project.id);
    if (budget.block_reason || creditCents(budget.available_credits) < total) throw new CanvasVideoBatchError(budget.block_reason || '项目预算不足以覆盖本批全部未开始视频', 403, 'canvas_video_batch_balance_insufficient');
  } else {
    const summary = await getCreditSummary(db, user);
    if (creditCents(summary.available) < total) throw new CanvasVideoBatchError('当前可用点数不足以覆盖本批全部未开始视频', 403, 'canvas_video_batch_balance_insufficient');
  }
}
async function assertInputMedia(user: SessionUser, input: Body) {
  if (input.reference_image_ids !== undefined) {
    if (!Array.isArray(input.reference_image_ids) || input.reference_image_ids.length > 12) throw new CanvasVideoBatchError('参考图片清单无效', 400);
    for (const imageId of input.reference_image_ids) await assertCanUseReferenceImage(user, checkedId(imageId, '素材编号'));
  }
}
async function quoteChild(user: SessionUser, input: Body, db: CanvasBatchDb = prisma) {
  const provider = input.provider as 'seedance' | 'volcengine_ip' | 'h3';
  const model = String(input.model), resolution = String(input.resolution), duration = Number(input.duration);
  if (!['480p', '720p', '1080p'].includes(resolution) || !Number.isInteger(duration)) throw new CanvasVideoBatchError('视频规格无效，原输入保留', 400);
  if (provider === 'seedance') {
    const parsed = parseSeedanceVideoModel(model);
    if (!parsed.ok || parsed.model !== model) throw new CanvasVideoBatchError('当前视频型号无法确认，原选择保留', 400);
  } else if (provider === 'volcengine_ip') {
    const settings = await getVolcengineIpApiSettings(db);
    if (!isVolcengineIpApiReady(settings) || !isVolcengineIpModelId(model) && model !== settings.default_model
      || !volcengineIpModelResolutions(model).includes(resolution)) throw new CanvasVideoBatchError('原 IP 通道或型号规格暂不可用', 409);
  } else {
    if (!isH3Operational(await getH3ApiSettings(db)) || !H3_PRESET_OPTIONS.some(option => option.id === model)) throw new CanvasVideoBatchError('原 H3 通道尚未就绪', 409);
  }
  // IP admission uses the existing IP quote without an ordinary-video context.
  const context = provider === 'volcengine_ip' ? undefined : await resolveVideoPricingContext(user, input, 'create', db);
  const quote = await quoteVideoPricing({ provider, model, resolution, duration, context }, db);
  return { quote, token: context ? issueVideoPricingCredential(context, quote.revision, quote.pricing.estimatedCost) : null };
}
function signQuote(encoded: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) throw new CanvasVideoBatchError('安全报价服务未就绪', 503);
  return createHmac('sha256', secret).update(`canvas-video-batch-v1\0${encoded}`).digest('base64url');
}
function issueQuote(value: QuoteEnvelope) {
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encoded}.${signQuote(encoded)}`;
}
function verifyQuote(raw: unknown, user: SessionUser): QuoteEnvelope {
  try {
    if (typeof raw !== 'string' || raw.length > 32768) throw new Error();
    const parts = raw.split('.');
    if (parts.length !== 2) throw new Error();
    const expected = Buffer.from(signQuote(parts[0])), given = Buffer.from(parts[1]);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error();
    const value: QuoteEnvelope = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (value.v !== 1 || value.actor !== user.id || !Number.isSafeInteger(value.expires) || value.expires <= Date.now()
      || value.expires > Date.now() + QUOTE_TTL + 1000 || ![2, 4].includes(value.children.length)
      && !value.batch_id) throw new Error();
    return value;
  } catch (error) {
    if (error instanceof CanvasVideoBatchError && error.status === 503) throw error;
    throw new CanvasVideoBatchError('报价已过期或与原批次不同，请重新确认未开始子项', 409, 'canvas_video_batch_requote_required');
  }
}
async function ownedBatch(user: SessionUser, batchId: string, db: CanvasBatchDb = prisma): Promise<Batch> {
  const batch = await db.canvasVideoBatch.findUnique({ where: { id: checkedId(batchId, '批次编号') }, include: { children: { orderBy: { ordinal: 'asc' } } } });
  if (!batch || batch.owner_user_id !== user.id) throw new AuthError('批次不存在或无权访问', 404);
  const access = await getProjectAccess(user, batch.project_id, db);
  if (!access.canView) throw new AuthError('无权查看原批次项目', 403);
  return batch;
}
async function statesFor(batch: Batch, user: SessionUser, db: CanvasBatchDb = prisma) {
  const taskIds = batch.children.flatMap(child => child.task_id ? [child.task_id] : []);
  const tasks = await db.videoTask.findMany({ where: { id: { in: taskIds } } });
  for (const task of tasks) await assertCanViewTask(user, task, db);
  return batch.children.map(child => canvasVideoChildState(child, tasks.find(task => task.id === child.task_id)));
}
export async function projectCanvasVideoBatch(user: SessionUser, batch: Batch) {
  const states = await statesFor(batch, user);
  return { id: batch.id, contract_version: batch.contract_version, creation_intent_id: batch.creation_intent_id, authorization_round: batch.authorization_round, request_id: batch.client_request_id, document_id: batch.document_id,
    dispatch_limit: 1,
    node_id: batch.node_id, project_id: batch.project_id, video_card_id: batch.video_card_id, video_branch_id: batch.video_branch_id,
    count: batch.count, state: canvasVideoBatchState(states), revision: batch.revision,
    authorized_total: creditsFromCents(batch.authorized_total), admitted_total: creditsFromCents(batch.admitted_total),
    accepted_count: batch.children.filter(child => child.task_id).length, prepared_count: states.filter(state => state === 'prepared').length,
    created_at: batch.created_at.toISOString(), updated_at: batch.updated_at.toISOString(),
    children: batch.children.map((child, index) => {
      const input = JSON.parse(child.frozen_input_json);
      return { id: child.id, ordinal: child.ordinal, request_id: child.request_id, idempotency_key: child.idempotency_key,
        state: states[index], provider: input.provider, revision: child.revision, authorized_maximum: creditsFromCents(child.authorized_maximum),
        quote_expires_at: child.quote_expires_at.toISOString(), task_id: child.task_id,
        rejection_receipt: child.rejection_receipt ? JSON.parse(child.rejection_receipt) : null,
        create_url: input.provider === 'volcengine_ip' ? '/api/ip/tasks/create' : '/api/tasks/create',
        create_body: { idempotency_key: child.idempotency_key, canvas_video_batch: { batch_id: batch.id, child_id: child.id,
          contract_version: 1, child_revision: child.revision } } };
    }) };
}

export async function quoteCanvasVideoBatch(user: SessionUser, body: Body) {
  assertActor(user);
  let input: Body, requestId: string, requestHash: string, count: number, batch: Batch | null = null;
  if (body.batch_id) {
    batch = await ownedBatch(user, String(body.batch_id));
    input = JSON.parse(batch.frozen_input_json);
    requestId = batch.client_request_id; requestHash = batch.request_hash;
    count = batch.children.filter(child => child.state === 'prepared' && !child.task_id).length;
    if (!count || !batch.active_node_key) throw new CanvasVideoBatchError('本批次没有可重新报价的未开始子项');
  } else {
    if (![1, 2].includes(Number(body.contract_version))) throw new CanvasVideoBatchError('批次协议无效', 400);
    requestId = checkedId(body.request_id, '原请求编号');
    const documentId = checkedId(body.document_id, '画布编号'), nodeId = checkedId(body.node_id, '节点编号');
    let parsedCount;
    try { parsedCount = canvasVideoCount(body.count); } catch (error) { throw new CanvasVideoBatchError((error as Error).message, 400); }
    if (parsedCount === 1) throw new CanvasVideoBatchError('单视频沿原生成协议，无需建立批次', 400);
    count = parsedCount; input = normalizeInput(body.input, documentId, nodeId);
    if ((body.contract_version === 2) !== (input.creation_contract_version === 2)) throw new CanvasVideoBatchError('父批与视频创作协议不一致，未生成', 400);
    requestHash = canvasBatchHash({ documentId, nodeId, count, input });
  }
  const documentId = batch?.document_id || String(body.document_id), nodeId = batch?.node_id || String(body.node_id);
  await assertCanEditCanvasDocument(user, documentId, String(input.project_id));
  await assertInputMedia(user, input);
  await assertScope(prisma, user, input, documentId, nodeId);
  const children: ChildQuote[] = [];
  const pending = batch?.children.filter(child => child.state === 'prepared' && !child.task_id);
  for (let index = 0; index < count; index++) {
    const ordinal = pending?.[index].ordinal || index + 1;
    const identity = canvasBatchHash([user.id, requestId, ordinal]);
    const request = pending?.[index].request_id || `cvbr-${identity.slice(0, 40)}`;
    const childInput = pending ? JSON.parse(pending[index].frozen_input_json) as Body : { ...input,
      idempotency_key: `cvb:${identity}`, source_request_id: `ultimate_canvas:${nodeId}:${request}` };
    const { quote, token } = await quoteChild(user, childInput);
    children.push({ id: pending?.[index].id || `cvbc-${identity}`, ordinal, request_id: request,
      idempotency_key: String(childInput.idempotency_key), fingerprint: canvasBatchBusinessFingerprint(childInput),
      route_fingerprint: await canvasVideoRouteFingerprint(childInput.provider), amount: creditCents(quote.pricing.estimatedCost), pricing_revision: quote.revision, pricing_token: token });
  }
  const total = creditCents(sumCredits(children.map(child => creditsFromCents(child.amount))));
  await preflightResources(prisma, user, input, count, total, false);
  const envelope: QuoteEnvelope = { v: 1, actor: user.id, request_id: requestId, request_hash: requestHash,
    batch_id: batch?.id || null, revision: batch?.revision || null, expires: Date.now() + QUOTE_TTL, total, children };
  return { contract_version: 1, request_id: requestId, batch_id: batch?.id || null, count,
    dispatch_limit: 1,
    authorized_total: creditsFromCents((batch?.admitted_total || 0) + total), remaining_total: creditsFromCents(total),
    quote_expires_at: new Date(envelope.expires).toISOString(), quote_token: issueQuote(envelope),
    children: children.map(child => ({ ordinal: child.ordinal, request_id: child.request_id, idempotency_key: child.idempotency_key,
      authorized_maximum: creditsFromCents(child.amount), pricing_revision: child.pricing_revision })) };
}

export async function prepareCanvasVideoBatch(user: SessionUser, body: Body) {
  assertActor(user);
  if (![1, 2].includes(Number(body.contract_version))) throw new CanvasVideoBatchError('批次协议无效', 400);
  const requestId = checkedId(body.request_id, '原请求编号'), documentId = checkedId(body.document_id, '画布编号'), nodeId = checkedId(body.node_id, '节点编号');
  let count;
  try { count = canvasVideoCount(body.count); } catch (error) { throw new CanvasVideoBatchError((error as Error).message, 400); }
  if (count === 1) throw new CanvasVideoBatchError('单视频沿原协议', 400);
  const input = normalizeInput(body.input, documentId, nodeId), requestHash = canvasBatchHash({ documentId, nodeId, count, input });
  if ((body.contract_version === 2) !== (input.creation_contract_version === 2)) throw new CanvasVideoBatchError('父批与视频创作协议不一致，未生成', 400);
  const prior = await prisma.canvasVideoBatch.findUnique({ where: { owner_user_id_client_request_id: { owner_user_id: user.id, client_request_id: requestId } }, include: { children: true } });
  if (prior) {
    if (prior.request_hash !== requestHash) throw new CanvasVideoBatchError('原请求编号已绑定其他内容，请查询原批次', 409, 'canvas_video_batch_payload_mismatch');
    return { batch: await projectCanvasVideoBatch(user, await ownedBatch(user, prior.id)) };
  }
  assertCanvasVideoBatchCreateEnabled();
  const quote = verifyQuote(body.quote_token, user);
  if (quote.batch_id || quote.request_id !== requestId || quote.request_hash !== requestHash || quote.children.length !== count) throw new CanvasVideoBatchError('确认报价与本次完整输入不同，尚未开始');
  await assertInputMedia(user, input);
  try {
    const batch = await prisma.$transaction(async db => {
      await assertScope(db, user, input, documentId, nodeId);
      const key = canvasBatchHash([user.id, documentId, nodeId]);
      const active = await db.canvasVideoBatch.findUnique({ where: { active_node_key: key }, include: { children: true } });
      if (active) {
        const states = await statesFor(active, user, db);
        if (!canvasVideoBatchIsSettled(states)) throw new CanvasVideoBatchError('此节点仍有原批次待处理，请先查看原结果或停止未开始项', 409, 'canvas_video_batch_active', { batch_id: active.id });
        await db.canvasVideoBatch.update({ where: { id: active.id }, data: { active_node_key: null, state: canvasVideoBatchState(states), revision: { increment: 1 } } });
      }
      // A new batch cannot overlap an older single-video POST already admitted at this node.
      const singles = await db.videoTask.findMany({ where: { user_id: user.id, project_id: String(input.project_id),
        local_status: { notIn: ['succeeded', 'failed', 'cancelled'] }, source_metadata_json: { contains: documentId } },
        select: { source_metadata_json: true } });
      if (singles.some(task => { const meta = JSON.parse(task.source_metadata_json || '{}'); return meta.canvas_document_id === documentId && meta.canvas_node_id === nodeId; })) throw new CanvasVideoBatchError('本节点仍有原视频任务，请先核对原任务');
      await preflightResources(db, user, input, count, quote.total);
      const batchId = `cvb-${canvasBatchHash([user.id, requestId])}`;
      const creationIntent = input.creation_contract_version === 2 ? await db.videoCreationIntent.findUnique({ where: { id: checkedId(input.intent_id, '创作意图') } }) : null;
      if (input.creation_contract_version === 2 && (!creationIntent || creationIntent.owner_id !== user.id || creationIntent.revision !== input.intent_revision
        || creationIntent.request_id !== requestId || creationIntent.count !== count || creationIntent.batch_id || creationIntent.accepted_task_id
        || !['ready', 'awaiting_approval', 'prepared'].includes(creationIntent.state)
        || creationSpecHash(creationSubmissionSpec(input, creationIntent)) !== creationIntent.input_hash)) throw new CreationError('原创作意图已变化，请核对原请求');
      if (creationIntent) {
        const parent = creationParent(JSON.parse(creationIntent.spec_json));
        if (parent) await assertCreationLineageUnlocked(db, user, parent, creationIntent.project_id);
      }
      const authorization = creationIntent ? await validateCreationBatchApproval(db, user, creationIntent, { approvalId: input.resolution_approval_id, round: 1,
        children: quote.children.map(child => ({ key: `intent:${creationIntent.id}:${child.ordinal}`, business_hash: creationIntent.input_hash, maximum: child.amount, pricing_revision: child.pricing_revision })) }) : null;
      const children = [];
      for (const child of quote.children) {
        const childInput = { ...input, idempotency_key: child.idempotency_key,
          source_request_id: `ultimate_canvas:${nodeId}:${child.request_id}` };
        if (canvasBatchBusinessFingerprint(childInput) !== child.fingerprint) throw new CanvasVideoBatchError('子项报价输入不一致');
        const fresh = await quoteChild(user, childInput, db);
        if (await canvasVideoRouteFingerprint(input.provider, db) !== child.route_fingerprint) throw new CanvasVideoBatchError('视频通道配置已变化，请重新确认报价');
        await assertVideoPricingAcceptance(fresh.quote, child.pricing_revision, db);
        if (creditCents(fresh.quote.pricing.estimatedCost) !== child.amount) throw new CanvasVideoBatchError('子项价格已变化，请重新确认', 409, 'canvas_video_batch_requote_required');
        children.push({ id: child.id, ordinal: child.ordinal, request_id: child.request_id, idempotency_key: child.idempotency_key,
          business_fingerprint: child.fingerprint, route_fingerprint: child.route_fingerprint,
          frozen_input_json: JSON.stringify(childInput), authorized_maximum: child.amount,
          quote_revision: child.pricing_revision, quote_token: child.pricing_token, quote_expires_at: new Date(quote.expires),
          ...(creationIntent ? { intent_spec_revision: creationIntent.revision, authorization_revision: 1, approval_record_id: authorization?.approvalId, approval_scope_hash: authorization?.scopeHash } : {}) });
      }
      if (creationIntent) {
        const accepted = await db.videoCreationIntent.updateMany({ where: { id: creationIntent.id, revision: creationIntent.revision, state: creationIntent.state, batch_id: null, accepted_task_id: null }, data: { state: 'batch_active', batch_id: batchId } });
        if (accepted.count !== 1) throw new CreationError('原请求已被另一操作处理，请查询原批次');
      }
      return db.canvasVideoBatch.create({ data: { id: batchId, owner_user_id: user.id, document_id: documentId, node_id: nodeId,
        project_id: String(input.project_id), video_card_id: optionalId(input.video_card_id), video_branch_id: optionalId(input.video_branch_id),
        client_request_id: requestId, request_hash: requestHash, count, contract_version: body.contract_version === 2 ? 2 : 1, creation_intent_id: creationIntent?.id || null, frozen_input_json: JSON.stringify(input),
        authorized_total: quote.total, active_node_key: key, children: { create: children } }, include: { children: { orderBy: { ordinal: 'asc' } } } });
    }, { timeout: 15000 });
    return { batch: await projectCanvasVideoBatch(user, batch) };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await prisma.canvasVideoBatch.findUnique({ where: { owner_user_id_client_request_id: { owner_user_id: user.id, client_request_id: requestId } } });
      if (existing?.request_hash === requestHash) return { batch: await projectCanvasVideoBatch(user, await ownedBatch(user, existing.id)) };
      throw new CanvasVideoBatchError('此节点或原请求正在并发受理，请只查询原请求', 409, 'canvas_video_batch_write_conflict');
    }
    throw error;
  }
}

export async function readCanvasVideoBatch(user: SessionUser, batchId: string, operationId?: string | null) {
  assertActor(user);
  const batch = await ownedBatch(user, batchId);
  const operations = JSON.parse(batch.operations_json) as Record<string, BatchOperation>;
  const operation = operationId ? operations[checkedId(operationId, '原操作编号')] : null;
  return { batch: await projectCanvasVideoBatch(user, batch), ...(operationId ? { operation: operation
    ? { state: 'applied', operation_id: operationId, action: operation.action, revision: operation.revision, applied_at: operation.applied_at }
    : { state: 'unconfirmed', operation_id: operationId } } : {}) };
}
export async function queryCanvasVideoBatches(user: SessionUser, params: URLSearchParams) {
  assertActor(user);
  if (params.has('request_id')) {
    const requestId = checkedId(params.get('request_id'), '原请求编号');
    const batch = await prisma.canvasVideoBatch.findUnique({ where: { owner_user_id_client_request_id: { owner_user_id: user.id, client_request_id: requestId } } });
    return batch ? { state: 'accepted', ...await readCanvasVideoBatch(user, batch.id) } : { state: 'unconfirmed', batch: null };
  }
  const documentId = checkedId(params.get('document_id'), '画布编号'), nodeId = checkedId(params.get('node_id'), '节点编号');
  // History is owner-scoped independently of current/deleted node JSON.
  const doc = await prisma.canvasDocument.findUnique({ where: { id: documentId } });
  const historical = await prisma.canvasVideoBatch.findFirst({ where: { owner_user_id: user.id, document_id: documentId, node_id: nodeId } });
  if ((!doc || doc.owner_user_id !== user.id) && !historical) throw new AuthError('画布历史不存在或无权查看', 404);
  const cursor = params.get('cursor');
  const rows = await prisma.canvasVideoBatch.findMany({ where: { owner_user_id: user.id, document_id: documentId, node_id: nodeId },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 21,
    ...(cursor ? { cursor: { id: checkedId(cursor, '历史游标') }, skip: 1 } : {}) });
  const page = rows.slice(0, 20);
  const batches = [];
  for (const row of page) batches.push((await readCanvasVideoBatch(user, row.id)).batch);
  return { batches, next_cursor: rows.length > 20 ? page[page.length - 1].id : null };
}

export async function mutateCanvasVideoBatch(user: SessionUser, batchId: string, body: Body) {
  assertActor(user);
  const operationId = checkedId(body.operation_id, '操作编号');
  if (!['stop', 'reauthorize'].includes(String(body.action)) || !Number.isSafeInteger(body.revision)) throw new CanvasVideoBatchError('批次操作或版本号无效', 400);
  const operationHash = canvasBatchHash(body);
  await prisma.$transaction(async db => {
    const batch = await ownedBatch(user, batchId, db);
    const operations = JSON.parse(batch.operations_json) as Record<string, BatchOperation>;
    if (operations[operationId]) {
      if (operations[operationId].hash !== operationHash) throw new CanvasVideoBatchError('此操作编号已用于其他内容');
      return;
    }
    if (body.revision !== batch.revision) throw new CanvasVideoBatchError('批次已变化，请查询原批次后继续', 409, 'canvas_video_batch_revision_conflict');
    if (Object.keys(operations).length >= 256) throw new CanvasVideoBatchError('本批次已达到操作记录上限，请保留原任务并停止新增操作');
    if (body.action === 'stop') {
      await sealCanvasVideoPreparedChildren(db, { ownerId: user.id, documentId: batch.document_id,
        batchId: batch.id, reason: `explicit_stop:${operationId}` });
    } else {
      const quote = verifyQuote(body.quote_token, user);
      assertCanvasVideoBatchCreateEnabled();
      if (quote.batch_id !== batch.id || quote.revision !== batch.revision || quote.request_hash !== batch.request_hash) throw new CanvasVideoBatchError('新报价与当前未开始子项不同');
      const pending = batch.children.filter(child => child.state === 'prepared' && !child.task_id);
      if (!pending.length || pending.length !== quote.children.length || !batch.active_node_key) throw new CanvasVideoBatchError('未开始子项已变化，请重新查询');
      const input = JSON.parse(batch.frozen_input_json) as Body;
      await assertScope(db, user, input, batch.document_id, batch.node_id);
      await preflightResources(db, user, input, pending.length, quote.total);
      const creationIntent = batch.creation_intent_id ? await db.videoCreationIntent.findUniqueOrThrow({ where: { id: batch.creation_intent_id } }) : null;
      if (creationIntent && (creationIntent.batch_id !== batch.id || creationIntent.state !== 'batch_active')) throw new CreationError('原批次意图已变化');
      const round = batch.authorization_round + 1;
      const authorization = creationIntent ? await validateCreationBatchApproval(db, user, creationIntent, { approvalId: body.resolution_approval_id, round, batchRevision: batch.revision,
        children: quote.children.map(child => ({ key: `intent:${creationIntent.id}:${child.ordinal}`, business_hash: child.fingerprint, maximum: child.amount, pricing_revision: child.pricing_revision })) }) : null;
      for (const child of pending) {
        const revised = quote.children.find(item => item.id === child.id);
        if (!revised || revised.fingerprint !== child.business_fingerprint) throw new CanvasVideoBatchError('原子项输入已变化，未重新生成');
        const frozen = JSON.parse(child.frozen_input_json) as Body;
        const fresh = await quoteChild(user, frozen, db);
        if (await canvasVideoRouteFingerprint(input.provider, db) !== revised.route_fingerprint) throw new CanvasVideoBatchError('视频通道再次变化，请重新确认报价');
        await assertVideoPricingAcceptance(fresh.quote, revised.pricing_revision, db);
        if (creditCents(fresh.quote.pricing.estimatedCost) !== revised.amount) throw new CanvasVideoBatchError('价格再次变化，请重新确认');
        if (creationIntent && await db.approvalUsage.count({ where: { creation_intent_id: creationIntent.id, child_key: `intent:${creationIntent.id}:${child.ordinal}` } })) throw new CreationError('此子项已存在原受理证据，请查询原任务');
        const revisedChild = await db.canvasVideoBatchChild.updateMany({ where: { id: child.id, revision: child.revision, state: 'prepared', task_id: null }, data: { authorized_maximum: revised.amount,
          route_fingerprint: revised.route_fingerprint, quote_revision: revised.pricing_revision,
          quote_token: revised.pricing_token, quote_expires_at: new Date(quote.expires), revision: { increment: 1 },
          ...(creationIntent ? { authorization_revision: round, approval_record_id: authorization?.approvalId, approval_scope_hash: authorization?.scopeHash } : {}) } });
        if (revisedChild.count !== 1) throw new CreationError('子项已被受理，未覆盖原授权');
      }
      const authorizedBatch = await db.canvasVideoBatch.updateMany({ where: { id: batch.id, revision: batch.revision, active_node_key: batch.active_node_key }, data: { authorized_total: batch.admitted_total + quote.total, revision: { increment: 1 }, ...(creationIntent ? { authorization_round: round } : {}) } });
      if (authorizedBatch.count !== 1) throw new CreationError('原批次已被并发受理，未覆盖原授权');
    }
    const updated = await db.canvasVideoBatch.findUniqueOrThrow({ where: { id: batch.id }, select: { revision: true } });
    operations[operationId] = { hash: operationHash, action: String(body.action), revision: updated.revision, applied_at: new Date().toISOString() };
    await db.canvasVideoBatch.update({ where: { id: batch.id }, data: { operations_json: JSON.stringify(operations) } });
  }, { timeout: 15000 });
  return readCanvasVideoBatch(user, batchId, operationId);
}
