import { assertNoPreparationRejection } from './preparation-receipts';
import type { Prisma, VideoCreationIntent } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { pricingFingerprint } from '@/lib/pricing/catalog';
import { quoteVideoPricing, requireVideoPricingRevision, type VideoPricingInput } from '@/lib/pricing/video';
import { resolveVideoPricingContext, issueVideoPricingCredential } from '@/lib/pricing/video-context';
import { assertProjectActiveInTransaction } from '@/lib/projects/permissions';
import { creditCents } from '@/lib/credits/precision';
import { CreationError, creationIdentity, type VideoCreationSpec, type VideoCreationIntentDTO, type IntentState } from './contract';
import { assertVideoCreationReady, readCreationContext, type CreationDb } from './context';
import { readCreationAvailability, creationNeedsApproval } from './availability';
import { creationTaskLineage, readCreationSource, creationParent, assertCreationLineageUnlocked } from './lineage';
import { consumeCreationApproval } from './approval';

const INPUT_FIELDS = ['provider', 'model', 'generation_mode', 'prompt', 'ratio', 'duration', 'resolution', 'seed',
  'generate_audio', 'return_last_frame', 'watermark', 'draft', 'resolution_approval_confirmed',
  'reference_image_urls', 'reference_video_urls', 'reference_audio_urls', 'first_frame_url', 'last_frame_url', 'frame_image_urls',
  'reference_image_ids', 'reference_album_ids', 'template_studio_run_id', 'template_studio_assets',
  'source_task_id', 'source_draft_task_id', 'tool_version', 'fps', 'multiview_generation', 'multiview_settings',
  'canvas_document_id', 'canvas_node_id', 'workspace_id', 'preset_id', 'lora_id', 'audio_prompt', 'music_prompt',
  'scene', 'video_url', 'template_id', 'agent_run_id', 'selected_agent_plan_key', 'agent_prompt_snapshot', 'final_prompt_snapshot', 'prompt_user_edited', 'roleMediaContext', 'first_frame_asset_id', 'last_frame_asset_id', 'template_studio_parameters', 'omni_reference_task_type', 'promptMentions'] as const;
export function normalizeVideoCreationSpec(body: Record<string, unknown>): VideoCreationSpec {
  if (Buffer.byteLength(JSON.stringify(body)) > 262144) throw new CreationError('创作输入过大', 400, 'creation_input_invalid');
  const action = body.action || 'generate', entry = body.entry || 'ordinary';
  if (!['generate', 'enhance', 'draft_upgrade'].includes(String(action))
    || !['ordinary', 'ip', 'template', 'canvas', 'multiview', 'enhance', 'draft_upgrade'].includes(String(entry))) throw new CreationError('创作入口无效', 400);
  const project = creationIdentity(body.project_id, 'project_id')!, card = creationIdentity(body.video_card_id, 'video_card_id', true),
    branch = creationIdentity(body.video_branch_id, 'video_branch_id', true);
  if (!card && branch) throw new CreationError('没有原视频卡时不能指定方向', 400, 'creation_branch_invalid');
  const continuation = body.continuation as Record<string, unknown> | undefined;
  const mode = continuation?.mode || 'new';
  if (!['new', 'continue'].includes(String(mode))) throw new CreationError('接续方式无效', 400);
  const parent = mode === 'continue' ? creationIdentity(continuation?.parent_task_id, 'parent_task_id')! : undefined;
  const count = body.count === undefined ? 1 : body.count;
  if (!Number.isInteger(count) || ![1, 2, 4].includes(count as number)) throw new CreationError('生成数量无效', 400);
  const sourceIds = body.input_source_task_ids === undefined ? [] : body.input_source_task_ids;
  if (!Array.isArray(sourceIds) || sourceIds.length > 16) throw new CreationError('素材来源无效', 400);
  const input = Object.fromEntries(INPUT_FIELDS.filter(key => body[key] !== undefined).map(key => [key, body[key]]));
  if (typeof input.model !== 'string' || !input.model || typeof input.duration !== 'number' || !Number.isFinite(input.duration)
    || input.duration <= 0 || input.duration > 3600 || typeof input.resolution !== 'string') throw new CreationError('型号、时长或分辨率无效，未提交生成', 400, 'creation_spec_invalid');
  return { version: 2, action: action as VideoCreationSpec['action'], entry: entry as VideoCreationSpec['entry'],
    project_id: project, video_card_id: card, video_branch_id: branch, continuation: { mode: mode as 'new' | 'continue', ...(parent ? { parent_task_id: parent } : {}) },
    baseline_task_id: creationIdentity(body.baseline_task_id, 'baseline_task_id', true),
    input_source_task_ids: sourceIds.map(id => creationIdentity(id, 'input_source_task_ids')!), count: count as number, input };
}
export const creationSpecHash = (spec: VideoCreationSpec) => pricingFingerprint(spec);
export function creationSubmissionSpec(body: Record<string, unknown>, intent: VideoCreationIntent) {
  const saved = JSON.parse(intent.spec_json) as VideoCreationSpec;
  return normalizeVideoCreationSpec({ ...saved.input, ...body, action: saved.action, entry: saved.entry,
    count: saved.count, continuation: body.continuation || saved.continuation,
    baseline_task_id: body.baseline_task_id === undefined ? saved.baseline_task_id : body.baseline_task_id,
    input_source_task_ids: body.input_source_task_ids === undefined ? saved.input_source_task_ids : body.input_source_task_ids });
}
async function projectIntent(user: SessionUser, intent: VideoCreationIntent, db: CreationDb, quotedCost?: number): Promise<VideoCreationIntentDTO> {
  const base: VideoCreationIntentDTO = { id: intent.id, request_id: intent.request_id, contract_version: 2, revision: intent.revision,
    state: intent.state as IntentState, accepted_task_id: intent.accepted_task_id, batch_id: intent.batch_id,
    created_at: intent.created_at.toISOString(), updated_at: intent.updated_at.toISOString() };
  try {
    const context = await readCreationContext(user, intent.project_id, null, db);
    const approval = await db.approvalRecord.findFirst({ where: { creation_intent_id: intent.id, intent_revision: intent.revision }, orderBy: { created_at: 'desc' } });
    const approved = await db.approvalRecord.findFirst({ where: { creation_intent_id: intent.id, intent_revision: intent.revision, status: 'approved', expires_at: { gt: new Date() }, ...(intent.batch_id ? {} : { scope_hash: intent.quote_business_hash }) }, orderBy: { created_at: 'desc' } });
    const approvalScope = approval ? JSON.parse(approval.scope_json || '{}') : {};
    return { ...base, project_id: intent.project_id, spec: JSON.parse(intent.spec_json), payer: context.payer,
      pricing_revision: intent.pricing_revision, quote_business_hash: intent.quote_business_hash,
      approval_id: approved?.id || null,
      ...(approval ? { approval: { id: approval.id, status: approval.status, reason: approval.decision_reason,
        expires_at: approval.expires_at?.toISOString() || null, remaining_count: Math.max(0, (approval.usage_limit || 0) - approval.used_count), authorization_round: approvalScope.authorization_round, batch_revision: approvalScope.batch_revision } } : {}),
      availability: await readCreationAvailability(db, intent, context.project.type, context.payer, user, quotedCost) };
  } catch (error) {
    if (error instanceof CreationError && error.status < 500 || error instanceof Error && 'status' in error && Number(error.status) < 500) return base;
    throw error;
  }
}
export async function getVideoCreationIntent(user: SessionUser, id: string, db: CreationDb = prisma) {
  await assertVideoCreationReady(db, false);
  const intent = await db.videoCreationIntent.findUnique({ where: { id } });
  if (!intent || intent.owner_id !== user.id) throw new CreationError('创作请求不存在', 404, 'creation_not_found');
  return projectIntent(user, intent, db);
}
export async function prepareVideoCreationIntent(user: SessionUser, body: Record<string, unknown>) {
  await assertVideoCreationReady(prisma, false);
  const requestId = creationIdentity(body.request_id, 'request_id')!;
  const previous = await prisma.videoCreationIntent.findUnique({ where: { owner_id_request_id: { owner_id: user.id, request_id: requestId } } });
  // Accepted/closed original receipts always win over later page parameters.
  if (previous && ['accepted', 'closed', 'batch_active', 'batch_settled'].includes(previous.state)) return projectIntent(user, previous, prisma);
  await assertVideoCreationReady();
  await assertNoPreparationRejection(prisma, user.id, requestId, body);
  const spec = normalizeVideoCreationSpec(body), inputHash = creationSpecHash(spec);
  const context = await readCreationContext(user, spec.project_id, spec.video_card_id);
  const parentId = creationParent(spec);
  if (parentId) await assertCreationLineageUnlocked(prisma, user, parentId, spec.project_id);
  for (const id of spec.input_source_task_ids) await readCreationSource(prisma, user, id);
  const pricingBody = { ...spec.input, project_id: spec.project_id, video_card_id: spec.video_card_id };
  const pricingContext = spec.action === 'enhance' || spec.input.provider === 'volcengine_ip' ? undefined : await resolveVideoPricingContext(user, pricingBody, spec.action === 'draft_upgrade' ? 'draft_upgrade' : 'create');
  const provider = spec.action === 'enhance' ? 'volcengine_mediakit' : spec.input.provider || (spec.entry === 'ip' ? 'volcengine_ip' : 'seedance');
  const quote = await quoteVideoPricing({ ...spec.input, provider, model: spec.input.model, duration: spec.input.duration,
    resolution: spec.input.resolution, toolVersion: spec.input.tool_version, context: pricingContext } as VideoPricingInput);
  requireVideoPricingRevision(quote, body.pricing_revision);
  const businessHash = pricingFingerprint({ spec, payer: context.payer, pricing_revision: quote.revision,
    per_child_cost_cents: creditCents(quote.pricing.estimatedCost), count: spec.count });
  const row = await prisma.$transaction(async tx => {
    await assertProjectActiveInTransaction(tx, user, spec.project_id);
    const current = await tx.videoCreationIntent.findUnique({ where: { owner_id_request_id: { owner_id: user.id, request_id: requestId } } });
    await assertNoPreparationRejection(tx, user.id, requestId, body);
    const data = { action: spec.action, entry: spec.entry, project_id: spec.project_id, legacy_card_id: spec.video_card_id,
      parent_task_id: parentId, baseline_task_id: spec.baseline_task_id, count: spec.count, payer_kind: context.payer.kind,
      payer_account_id: context.payer.id, input_hash: inputHash, spec_json: JSON.stringify(spec), pricing_revision: quote.revision,
      quote_business_hash: businessHash, state: creationNeedsApproval(context.project.type, spec) ? 'awaiting_approval' : 'ready' };
    if (!current) return tx.videoCreationIntent.create({ data: { ...data, owner_id: user.id, request_id: requestId } });
    if (current && ['accepted', 'closed', 'batch_active', 'batch_settled'].includes(current.state)) return current;
    if (current.input_hash === inputHash && current.quote_business_hash === businessHash) return current;
    if (!['prepared', 'awaiting_approval', 'ready'].includes(current.state) || current.batch_id || current.accepted_task_id
      || body.expected_revision !== current.revision
      || await tx.videoTask.count({ where: { creation_intent_id: current.id } })
      || await tx.approvalUsage.count({ where: { creation_intent_id: current.id } })) throw new CreationError('创作请求已变化，请核对原请求；未重新生成', 409, 'creation_revision_conflict');
    const updated = await tx.videoCreationIntent.updateMany({ where: { id: current.id, revision: current.revision, state: current.state },
      data: { ...data, revision: { increment: 1 } } });
    if (updated.count !== 1) throw new CreationError('创作请求已变化，请重新读取原请求');
    return tx.videoCreationIntent.findUniqueOrThrow({ where: { id: current.id } });
  });
  return { ...await projectIntent(user, row, prisma, quote.pricing.estimatedCost), quote: { estimated_cost: quote.pricing.estimatedCost, pricing_revision: quote.revision,
    ...(pricingContext ? { pricing_quote_token: issueVideoPricingCredential(pricingContext, quote.revision, quote.pricing.estimatedCost) } : {}) } };
}
export async function closeVideoCreationIntent(user: SessionUser, id: string, expectedRevision: number) {
  await assertVideoCreationReady();
  return prisma.$transaction(async tx => {
    const intent = await tx.videoCreationIntent.findUnique({ where: { id } });
    if (!intent || intent.owner_id !== user.id) throw new CreationError('创作请求不存在', 404);
    if (intent.accepted_task_id || intent.batch_id || ['accepted', 'batch_active', 'batch_settled'].includes(intent.state)) return projectIntent(user, intent, tx);
    if (intent.state === 'closed') return projectIntent(user, intent, tx);
    if (intent.revision !== expectedRevision || await tx.videoTask.count({ where: { creation_intent_id: id } })
      || await tx.canvasVideoBatch.count({ where: { creation_intent_id: id } })
      || await tx.approvalUsage.count({ where: { creation_intent_id: id } })) throw new CreationError('原请求存在处理证据，请核对原结果', 409, 'creation_original_required', 'intent_id', 'query_original');
    const sealed = await tx.videoCreationIntent.updateMany({ where: { id, revision: expectedRevision, state: intent.state,
      accepted_task_id: null, batch_id: null }, data: { state: 'closed' } });
    if (sealed.count !== 1) throw new CreationError('原请求已变化，请核对原结果');
    return projectIntent(user, { ...intent, state: 'closed' }, tx);
  });
}

/** Must be called inside the ORIGINAL task/credit/usage acceptance transaction, after task creation. */
export async function acceptVideoCreationIntent(tx: Prisma.TransactionClient, user: SessionUser, body: Record<string, unknown>,
  accepted: { taskId: string; cost: number; pricingRevision: string | null; batchChildId?: string }) {
  if (body.creation_contract_version !== 2) return;
  await assertVideoCreationReady(tx);
  const id = creationIdentity(body.intent_id, 'intent_id')!, intent = await tx.videoCreationIntent.findUnique({ where: { id } });
  if (!intent || intent.owner_id !== user.id) throw new CreationError('创作请求不存在', 404);
  if (intent.accepted_task_id === accepted.taskId) return;
  const child = accepted.batchChildId ? await tx.canvasVideoBatchChild.findUnique({ where: { id: accepted.batchChildId }, include: { batch: true } }) : null;
  const isBatch = Boolean(accepted.batchChildId), childKey = child ? `intent:${id}:${child.ordinal}` : 'single';
  if (!isBatch && intent.count !== 1) throw new CreationError('多视频须从原父批逐子项受理，未创建单个替代任务');
  if (isBatch && (!child || child.batch.creation_intent_id !== id || child.batch.owner_user_id !== user.id
    || intent.batch_id !== child.batch_id || child.intent_spec_revision !== intent.revision || child.state !== 'prepared'
    || child.task_id || child.idempotency_key !== body.idempotency_key || !child.authorization_revision)) {
    throw new CreationError('原批次子项身份或授权已变化，请查询原批次');
  }
  if (intent.revision !== body.intent_revision || (!isBatch && !['ready', 'awaiting_approval', 'prepared'].includes(intent.state))
    || isBatch && intent.state !== 'batch_active' || intent.state === 'closed') throw new CreationError('原创作请求已结束或变化，未重新生成');
  const spec = creationSubmissionSpec(body, intent);
  if (creationSpecHash(spec) !== intent.input_hash || (child ? child.quote_revision : intent.pricing_revision) !== accepted.pricingRevision
    || intent.request_id !== body.idempotency_key && !isBatch) throw new CreationError('本次内容与原创作请求不一致，请核对原请求', 409, 'creation_input_changed');
  const context = await readCreationContext(user, intent.project_id, spec.video_card_id, tx);
  if (context.payer.kind !== intent.payer_kind || context.payer.id !== intent.payer_account_id) throw new CreationError('付款范围已变化，请重新确认尚未受理的内容');
  const quoteHash = pricingFingerprint({ spec, payer: context.payer, pricing_revision: accepted.pricingRevision,
    per_child_cost_cents: creditCents(accepted.cost), count: spec.count });
  if (quoteHash !== intent.quote_business_hash && !isBatch) throw new CreationError('原报价金额已变化，请重新确认未受理内容', 409, 'creation_requote_required', 'pricing_revision', 'requote');
  await assertProjectActiveInTransaction(tx, user, intent.project_id);
  await consumeCreationApproval(tx, user, intent, spec, context.project.type,
    { ...accepted, childKey, authorizationRevision: child?.authorization_revision || 1, approvalScopeHash: child?.approval_scope_hash || undefined, businessHash: child ? child.authorization_revision === 1 ? intent.input_hash : child.business_fingerprint : undefined }, child ? child.approval_record_id : body.resolution_approval_id);
  const lineage = await creationTaskLineage(tx, user, spec, accepted.taskId);
  await tx.videoTask.update({ where: { id: accepted.taskId }, data: { creation_intent_id: id, creation_contract_version: 2, ...lineage } });
  if (!isBatch) {
    const updated = await tx.videoCreationIntent.updateMany({ where: { id, revision: intent.revision, state: intent.state,
      accepted_task_id: null, batch_id: null }, data: { state: 'accepted', accepted_task_id: accepted.taskId } });
    if (updated.count !== 1) throw new CreationError('原创作请求已被另一个操作处理，请核对原号');
  }
}
