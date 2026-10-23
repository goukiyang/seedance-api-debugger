import { pricingFingerprint } from '@/lib/pricing/catalog';
import type { VideoCreationIntent } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { creditCents } from '@/lib/credits/precision';
import { quoteVideoPricing, type VideoPricingInput } from '@/lib/pricing/video';
import { resolveVideoPricingContext } from '@/lib/pricing/video-context';
import { videoDeliveryStageForTask } from '@/lib/video/delivery-status';
import { assertProjectActiveInTransaction } from '@/lib/projects/permissions';
import { CreationError, type VideoCreationSpec } from './contract';
import { assertVideoCreationReady, readCreationContext, type CreationDb } from './context';
import { creationNeedsApproval } from './availability';
import { readCreationSource } from './lineage';

export function videoIntentChildKeys(intent: Pick<VideoCreationIntent, 'id' | 'count'>) {
  return intent.count === 1 ? ['single'] : Array.from({ length: intent.count }, (_, ordinal) => `intent:${intent.id}:${ordinal + 1}`);
}
export async function requestVideoCreationApproval(user: SessionUser, id: string, body: Record<string, unknown>) {
  await assertVideoCreationReady();
  const intent = await prisma.videoCreationIntent.findUnique({ where: { id } });
  if (!intent || intent.owner_id !== user.id) throw new CreationError('创作请求不存在', 404);
  const spec = JSON.parse(intent.spec_json) as VideoCreationSpec;
  if (body.expected_revision !== intent.revision || !['prepared', 'awaiting_approval', 'ready', 'batch_active'].includes(intent.state)) throw new CreationError('创作内容已变化，请先核对原请求');
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 2000) : '';
  if (!reason) throw new CreationError('请填写本次高清创作的用途', 400, 'creation_approval_reason_required');
  const context = await readCreationContext(user, spec.project_id, spec.video_card_id);
  if (!creationNeedsApproval(context.project.type, spec)) throw new CreationError('此请求不需要项目高清批准', 400);
  if (!spec.baseline_task_id) throw new CreationError('请先选择合法的已完成基准视频', 400, 'creation_baseline_required');
  const baseline = await readCreationSource(prisma, user, spec.baseline_task_id);
  if (baseline.project_id !== spec.project_id || baseline.local_status !== 'succeeded'
    || !videoDeliveryStageForTask(baseline).stableDownloadReady) throw new CreationError('基准视频必须属于当前项目，且完整成品已就绪', 409, 'creation_baseline_unavailable');
  if (spec.video_card_id && (baseline.video_card_id !== spec.video_card_id || !['candidate','current_best','final'].includes(baseline.version_role) && !(spec.action === 'draft_upgrade' && baseline.id === spec.input.source_draft_task_id))) throw new CreationError('原视频卡的高清基准仍须属于原卡候选、最佳或最终版', 409, 'creation_legacy_baseline_invalid');
  const input = { ...spec.input, project_id: spec.project_id, video_card_id: spec.video_card_id };
  const pricingContext = spec.input.provider === 'volcengine_ip' ? undefined : await resolveVideoPricingContext(user, input, spec.action === 'draft_upgrade' ? 'draft_upgrade' : 'create');
  const quote = await quoteVideoPricing({ ...spec.input, provider: spec.input.provider || (spec.entry === 'ip' ? 'volcengine_ip' : 'seedance'),
    context: pricingContext } as VideoPricingInput);
  if (!intent.batch_id && quote.revision !== intent.pricing_revision) throw new CreationError('报价规则已变化，请重新确认未受理内容', 409, 'creation_requote_required', 'pricing_revision', 'requote');
  const perChild = creditCents(quote.pricing.estimatedCost);
  if (perChild <= 0) throw new CreationError('当前报价无法形成合法的正数审批预算，请联系项目负责人', 409, 'creation_approval_budget_unavailable');
  return prisma.$transaction(async tx => {
    await assertProjectActiveInTransaction(tx, user, spec.project_id);
    const fresh = await tx.videoCreationIntent.findUniqueOrThrow({ where: { id } });
    if (fresh.revision !== intent.revision || fresh.quote_business_hash !== intent.quote_business_hash || fresh.state !== intent.state) throw new CreationError('创作请求已变化，请重新读取');
    const children = fresh.batch_id ? await tx.canvasVideoBatchChild.findMany({ where: { batch_id: fresh.batch_id, state: 'prepared', task_id: null }, orderBy: { ordinal: 'asc' } }) : null;
    const batch = fresh.batch_id ? await tx.canvasVideoBatch.findUniqueOrThrow({ where: { id: fresh.batch_id } }) : null;
    if (batch && body.expected_batch_revision !== batch.revision) throw new CreationError('批次已变化，请先读取未受理子项');
    const childKeys = children ? children.map(child => `intent:${id}:${child.ordinal}`) : videoIntentChildKeys(fresh);
    if (!childKeys.length) throw new CreationError('没有尚未受理的子项，不再申请批准');
    const authorizationRound = batch ? batch.authorization_round + 1 : 1;
    const authorizationHash = batch ? pricingFingerprint({ intent_id: id, spec_revision: fresh.revision, authorization_round: authorizationRound,
      payer: context.payer, pricing_revision: quote.revision, children: children!.map(child => ({ key: `intent:${id}:${child.ordinal}`, business_hash: child.business_fingerprint, maximum: perChild })) }) : fresh.quote_business_hash;
    const existing = await tx.approvalRecord.findFirst({ where: { creation_intent_id: id, intent_revision: fresh.revision,
      scope_hash: authorizationHash, status: 'pending' }, orderBy: { created_at: 'desc' } });
    if (existing) {
      const scope = JSON.parse(existing.scope_json || '{}');
      if (JSON.stringify(scope.child_keys) === JSON.stringify(childKeys)) return existing;
    }
    const scope = { version: 2, intent_id: id, intent_revision: fresh.revision,
      authorization_round: authorizationRound, batch_id: batch?.id || null, batch_revision: batch?.revision || null,
      owner_id: user.id, entry: spec.entry, action: spec.action, project_id: spec.project_id,
      payer_kind: fresh.payer_kind, payer_account_id: fresh.payer_account_id, baseline_task_id: baseline.id,
      input_hash: fresh.input_hash, quote_business_hash: fresh.quote_business_hash, pricing_revision: quote.revision,
      child_keys: childKeys, child_authorizations: childKeys.map((key, index) => ({ key, maximum: perChild,
        business_hash: children?.[index]?.business_fingerprint || fresh.input_hash })),
      provider: spec.input.provider || 'seedance', model: spec.input.model, resolution: spec.input.resolution,
      ratio: spec.input.ratio, duration: spec.input.duration, count: childKeys.length };
    const approval = await tx.approvalRecord.create({ data: { type: 'video_creation_1080p', project_id: spec.project_id,
      task_id: baseline.id, video_card_id: spec.video_card_id, requester_user_id: user.id, reason, creation_intent_id: id, intent_revision: fresh.revision,
      scope_hash: authorizationHash, billing_scope: fresh.payer_kind, billing_account_id: fresh.payer_account_id,
      usage_limit: childKeys.length, authorized_cost_cents: perChild * childKeys.length,
      scope_json: JSON.stringify(scope), requested_payload_json: JSON.stringify({ intended_use: reason, quota_count: childKeys.length,
        estimated_budget_credits: perChild * childKeys.length / 100 }), expires_at: new Date(Date.now() + 14 * 86400000) } });
    if (!fresh.batch_id) await tx.videoCreationIntent.updateMany({ where: { id, revision: fresh.revision, state: fresh.state }, data: { state: 'awaiting_approval' } });
    return approval;
  });
}
export async function consumeCreationApproval(tx: CreationDb, user: SessionUser, intent: VideoCreationIntent, spec: VideoCreationSpec,
  projectType: string, accepted: { taskId: string; cost: number; childKey?: string; authorizationRevision?: number; approvalScopeHash?: string; businessHash?: string; pricingRevision?: string | null }, approvalId: unknown) {
  if (!creationNeedsApproval(projectType, spec)) return;
  if (typeof approvalId !== 'string') throw new CreationError('本次高清创作需要有效批准', 409, 'creation_approval_required', 'resolution_approval_id', 'request_approval');
  const approval = await tx.approvalRecord.findUnique({ where: { id: approvalId } });
  const key = accepted.childKey || 'single', amount = creditCents(accepted.cost), now = new Date();
  const prior = await tx.approvalUsage.findUnique({ where: {
    approval_id_creation_intent_id_child_key: { approval_id: approvalId, creation_intent_id: intent.id, child_key: key },
  } });
  if (prior) {
    if (prior.task_id !== accepted.taskId) throw new CreationError('此批准子项已用于原任务，请查询原结果');
    return;
  }
  if (!approval || approval.type !== 'video_creation_1080p' || approval.status !== 'approved'
    || !approval.expires_at || approval.expires_at <= now || approval.creation_intent_id !== intent.id
    || approval.intent_revision !== intent.revision || approval.scope_hash !== (accepted.approvalScopeHash || intent.quote_business_hash)
    || approval.project_id !== intent.project_id || approval.requester_user_id !== user.id
    || approval.billing_scope !== intent.payer_kind || approval.billing_account_id !== intent.payer_account_id) throw new CreationError('本次高清批准已失效，请重新申请未受理内容', 409, 'creation_approval_required', 'resolution_approval_id', 'request_approval');
  const scope = JSON.parse(approval.scope_json || '{}');
  const authorized = scope.child_authorizations?.find((child: { key: string }) => child.key === key);
  if (scope.version !== 2 || scope.input_hash !== intent.input_hash || scope.pricing_revision !== (accepted.pricingRevision || intent.pricing_revision)
    || !authorized || accepted.businessHash && authorized.business_hash !== accepted.businessHash || amount < 0 || amount > authorized.maximum || !approval.usage_limit
    || scope.authorization_round !== (accepted.authorizationRevision || 1)) throw new CreationError('批准范围与本次子项不一致，原任务未重新提交');
  const baseline = await readCreationSource(tx, user, approval.task_id || '');
  if (baseline.project_id !== intent.project_id || spec.video_card_id && (baseline.video_card_id !== spec.video_card_id || !['candidate','current_best','final'].includes(baseline.version_role) && !(spec.action === 'draft_upgrade' && baseline.id === spec.input.source_draft_task_id)) || baseline.local_status !== 'succeeded'
    || !videoDeliveryStageForTask(baseline).stableDownloadReady) throw new CreationError('本次批准基准已不可用，请重新选择');
  const occupied = await tx.approvalRecord.updateMany({ where: { id: approval.id, revision: approval.revision,
    status: 'approved', expires_at: { gt: now }, used_count: { lt: approval.usage_limit },
    used_cost_cents: { lte: approval.authorized_cost_cents - amount } },
  data: { used_count: { increment: 1 }, used_cost_cents: { increment: amount }, revision: { increment: 1 } } });
  if (occupied.count !== 1) throw new CreationError('批准余量已变化，请核对原请求');
  await tx.approvalUsage.create({ data: { approval_id: approval.id, task_id: accepted.taskId, user_id: user.id,
    creation_intent_id: intent.id, intent_revision: intent.revision, authorization_revision: accepted.authorizationRevision || 1,
    child_key: key, authorized_cost_cents: amount, metadata_json: JSON.stringify({ version: 2, scope_hash: approval.scope_hash }) } });
}

/** Validates an entire unstarted set before the parent/reauthorization CAS. Never consumes Usage. */
export async function validateCreationBatchApproval(db: CreationDb, user: SessionUser, intent: VideoCreationIntent,
  input: { approvalId: unknown; round: number; batchRevision?: number; children: Array<{ key: string; business_hash: string; maximum: number; pricing_revision: string | null }> }) {
  const spec = JSON.parse(intent.spec_json) as VideoCreationSpec;
  const context = await readCreationContext(user, intent.project_id, spec.video_card_id, db);
  if (context.payer.kind !== intent.payer_kind || context.payer.id !== intent.payer_account_id) throw new CreationError('付款范围已变化，未更新授权');
  if (!creationNeedsApproval(context.project.type, spec)) return { approvalId: null, scopeHash: null };
  const approval = typeof input.approvalId === 'string' ? await db.approvalRecord.findUnique({ where: { id: input.approvalId } }) : null;
  const scope = approval ? JSON.parse(approval.scope_json || '{}') : {};
  if (!approval || approval.type !== 'video_creation_1080p' || approval.status !== 'approved' || !approval.expires_at || approval.expires_at <= new Date()
    || approval.creation_intent_id !== intent.id || approval.intent_revision !== intent.revision || approval.requester_user_id !== user.id
    || approval.project_id !== intent.project_id || approval.billing_scope !== intent.payer_kind || approval.billing_account_id !== intent.payer_account_id
    || scope.version !== 2 || scope.input_hash !== intent.input_hash || scope.authorization_round !== input.round
    || input.batchRevision !== undefined && scope.batch_revision !== input.batchRevision
    || !Array.isArray(scope.child_authorizations) || scope.child_authorizations.length !== input.children.length
    || approval.used_count + input.children.length > (approval.usage_limit || 0)
    || approval.used_cost_cents + input.children.reduce((sum, child) => sum + child.maximum, 0) > approval.authorized_cost_cents
    || input.children.some(child => !scope.child_authorizations.some((allowed: { key: string; business_hash: string; maximum: number }) =>
      allowed.key === child.key && allowed.business_hash === child.business_hash && allowed.maximum >= child.maximum)
      || scope.pricing_revision !== child.pricing_revision)) throw new CreationError('当前批准不足以覆盖这些未受理子项，请重新申请', 409, 'creation_approval_required', 'resolution_approval_id', 'request_approval');
  return { approvalId: approval.id, scopeHash: approval.scope_hash };
}
