import { parseMultiviewGenerationSnapshot } from '@/lib/video/multiview-generation-contract';
import { getCreditSummary } from '@/lib/credits/policy';
import { getProjectBudgetSummary } from '@/lib/projects/budget';
import { creditCents } from '@/lib/credits/precision';
import type { SessionUser } from '@/lib/auth/session';
import { isSeedanceVideoDuration } from '@/lib/provider/seedance-models';
import { creationParent, assertCreationLineageUnlocked } from './lineage';
import { CreationError } from './contract';
import type { VideoCreationIntent } from '@prisma/client';
import type { CreationAvailability, CreationPayer, VideoCreationSpec } from './contract';
import type { CreationDb } from './context';
export function creationNeedsApproval(projectType: string, spec: VideoCreationSpec) {
  return projectType !== 'personal' && spec.input.resolution === '1080p' && spec.action !== 'enhance';
}
export async function readCreationAvailability(db: CreationDb, intent: VideoCreationIntent, projectType: string, payer: CreationPayer, user?: SessionUser, quotedCost?: number): Promise<CreationAvailability> {
  const spec = JSON.parse(intent.spec_json) as VideoCreationSpec;
  const reasons: CreationAvailability['reasons'] = [];
  if (spec.action === 'generate' && spec.entry !== 'multiview' && (typeof spec.input.prompt !== 'string' || !spec.input.prompt.trim())) reasons.push({ code: 'creation_prompt_required', message: '请填写本次视频提示词', field: 'prompt', action: 'fix_input' });
  if (spec.entry === 'multiview' && !parseMultiviewGenerationSnapshot(spec.input.multiview_generation)) reasons.push({ code: 'creation_multiview_invalid', message: '旋转预设或图1记录暂时无法确认，原输入保留', field: 'multiview_generation', action: 'fix_input' });
  if (spec.input.provider === 'seedance' && !isSeedanceVideoDuration(Number(spec.input.duration), String(spec.input.model))) reasons.push({ code: 'creation_duration_invalid', message: '当前时长不在所选模型范围内，原值保留，请重新选择', field: 'duration', action: 'fix_input' });
  if (user) {
    const parent = creationParent(spec);
    if (parent) { try { await assertCreationLineageUnlocked(db, user, parent, spec.project_id); } catch (cause) { if (cause instanceof CreationError) reasons.push({ code: cause.code, message: cause.message, field: cause.field, action: cause.action }); else throw cause; } }
    if (quotedCost !== undefined) {
      if (payer.kind === 'project') { const budget = await getProjectBudgetSummary(db, payer.id); if (budget.block_reason || creditCents(budget.available_credits) < creditCents(quotedCost * spec.count)) reasons.push({ code: 'creation_budget_insufficient', message: budget.block_reason || '项目预算不足以覆盖本次创作', field: 'project_id', action: 'request_approval' }); }
      else { const credits = await getCreditSummary(db, user); if (creditCents(credits.available) < creditCents(quotedCost * spec.count)) reasons.push({ code: 'creation_credits_insufficient', message: '可用点数不足以覆盖本次创作，请先补足额度', field: 'credits', action: 'fix_input' }); }
    }
  }
  if (['accepted', 'batch_active', 'batch_settled', 'closed', 'rejected'].includes(intent.state)) reasons.push({
    code: 'creation_original_required', message: '此请求已有处理结果，请核对原任务', field: 'intent_id', action: 'query_original' });
  if (payer.kind !== intent.payer_kind || payer.id !== intent.payer_account_id) reasons.push({ code: 'creation_payer_changed', message: '付款范围已变化，请重新确认尚未受理的内容', field: 'project_id', action: 'requote' });
  if (creationNeedsApproval(projectType, spec)) {
    const approval = await db.approvalRecord.findFirst({ where: { type: 'video_creation_1080p', status: 'approved',
      creation_intent_id: intent.id, intent_revision: intent.revision, scope_hash: intent.quote_business_hash,
      expires_at: { gt: new Date() } } });
    if (!approval || !approval.usage_limit || approval.used_count >= approval.usage_limit
      || approval.used_cost_cents >= approval.authorized_cost_cents) reasons.push({ code: 'creation_approval_required',
      message: spec.baseline_task_id ? '本次高清创作需要有效批准' : '请先选择有权使用的已完成基准视频，再申请高清',
      field: 'resolution_approval_id', action: 'request_approval' });
  }
  return { canSubmit: reasons.length === 0, reasons, contextRevision: intent.quote_business_hash, quoteState: 'ready', payer };
}
