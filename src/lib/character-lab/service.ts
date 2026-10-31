import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { getImageStudioSettings } from '@/lib/image-studio/settings';
import { prepareImageBillingQuote } from '@/lib/image-studio/billing-quote-service';
import { imageBillingView } from '@/lib/image-studio/billing-contract';
import { StudioError, publicImageTaskStatus, submitStudioBatch, studioBusinessErrorStatus } from '@/lib/image-studio/tasks';
import { studioTaskHasViewableOutput, studioOutputMismatch, studioDimensionMismatchNotice } from '@/lib/image-studio/dimension-mismatch';
import { studioAssetUrl } from '@/lib/image-studio/media';
import { getPricingImageChannelOptions } from '@/lib/pricing/image';
import { IMAGE_STUDIO_MODELS, normalizeImageStudioQuality } from '@/lib/image-studio/model-catalog';
import { normalizeImageResolution } from '@/lib/image-generation/resolution';
import { resolveImageGenerationRequestChannel } from '@/lib/integrations/image-generation-defaults';
import { captureImageGenerationRequestChannel } from '@/lib/integrations/image-generation';
import { assertUsageProject } from '@/lib/admin/usage-attribution';
import { defaultStudioReferencePolicy } from '@/lib/image-studio/reference-policy';
import { MAX_REFERENCE_IMAGES } from '@/lib/image-studio/limits';
import { canReadStudioAsset, studioVisibleAssetWhere } from '@/lib/image-studio/protected-assets';
import { QueueCapacityError, QueueMaintenanceError } from '@/lib/image-studio/queue-capacity';
import { ownedLabAsset, persistLabFace, labOutput } from './media';
import { faceLabPrompt, resultLabPrompt } from './prompts';
import { labConfig, labConfigVersions, labId, labText, listLabWorkspaces, parseLabDraft, planKey, readLabPlan, readLabWorkspace, receiptKey, workspaceKey } from './store';
import type { CharacterLabBootstrap, CharacterLabPlan, CharacterLabQuote, CharacterLabTask, CharacterLabWorkspace, CharacterLabWorkspacePayload } from './types';

type StoredPlan = CharacterLabPlan & { inputFingerprint: string };
type Receipt = { state: 'prepared' | 'submitting' | 'accepted' | 'rejected'; error?: string };
const batchId = (owner: string, id: string) => createHash('sha256').update(`${owner}:${id}`).digest('hex');
const quoteKey = (owner: string, id: string) => `character-lab:v1:${owner}:quote:${id}`;
export async function labBootstrap(): Promise<Omit<CharacterLabBootstrap, 'workspaces'>> {
  const [settings, imageChannels, config, configVersions] = await Promise.all([getImageStudioSettings(), getPricingImageChannelOptions(), labConfig(), labConfigVersions()]);
  return { settings: { model: settings.model, revision: settings.revision, imageChannels }, config, configVersions };
}
export async function labBootstrapFor(user: SessionUser): Promise<CharacterLabBootstrap> {
  const [base, workspaces] = await Promise.all([labBootstrap(), listLabWorkspaces(user.id)]);
  return { ...base, workspaces };
}
async function tasksForPlans(user: SessionUser, plans: CharacterLabPlan[]) {
  const tasks = await prisma.imageStudioTask.findMany({ where: { owner_id: user.id, batch_id: { in: plans.map(plan => batchId(user.id, plan.id)) }, deleted_at: null } });
  const outputIds = tasks.flatMap(task => task.asset_id ? [task.asset_id] : []);
  const assets = await prisma.asset.findMany({ where: { owner_id: user.id, status: 'active', type: 'image', id: { in: outputIds }, AND: [await studioVisibleAssetWhere(user, prisma, outputIds)] },
    select: { id: true, width: true, height: true } });
  const byAsset = new Map(assets.map(asset => [asset.id, asset]));
  const byBatch = new Map(tasks.map(task => [task.batch_id, task]));
  const mapped: Record<string, CharacterLabTask | null> = {};
  for (const plan of plans) {
    const task = byBatch.get(batchId(user.id, plan.id));
    if (!task) { mapped[plan.id] = null; continue; }
    const mismatch = studioOutputMismatch(task), asset = studioTaskHasViewableOutput(task) ? byAsset.get(task.asset_id || '') : undefined;
    mapped[plan.id] = { id: task.id, status: publicImageTaskStatus(task.status),
      error: mismatch && asset ? studioDimensionMismatchNotice(mismatch.validation) : task.error,
      resultDisposition: mismatch ? mismatch.code === 'generated_format_mismatch' ? 'format_mismatch' : 'dimensions_mismatch' : null,
      billing: imageBillingView(task, user.id, false),
      asset: asset ? { ...asset, url: studioAssetUrl(asset.id), thumbnailUrl: studioAssetUrl(asset.id, true) } : null };
  }
  return mapped;
}
export async function labPlanState(user: SessionUser, id: string) {
  const plan = await readLabPlan(user.id, id), task = (await tasksForPlans(user, [plan]))[plan.id];
  const receipt = await prisma.platformSetting.findUnique({ where: { key: receiptKey(user.id, id) } });
  const state = task ? 'accepted' : receipt ? (JSON.parse(receipt.value_json) as Receipt).state : 'prepared';
  return { plan, task, submissionState: state };
}
export async function labWorkspaceState(user: SessionUser, id: string): Promise<CharacterLabWorkspacePayload> {
  const workspace = await readLabWorkspace(user.id, id);
  const records = await prisma.platformSetting.findMany({ where: { key: { startsWith: `character-lab:v1:${user.id}:plan:` } }, orderBy: { created_at: 'desc' } });
  const plans = records.map(row => JSON.parse(row.value_json) as CharacterLabPlan).filter(plan => plan.workspaceId === id);
  const [taskByRequestId, receipts] = await Promise.all([tasksForPlans(user, plans), prisma.platformSetting.findMany({ where: { key: { in: plans.map(plan => receiptKey(user.id, plan.id)) } } })]);
  const byReceipt = new Map(receipts.map(row => [row.key, (JSON.parse(row.value_json) as Receipt).state]));
  const candidateSource = workspace.draft.sourceAssetId ? await prisma.asset.findFirst({ where: { id: workspace.draft.sourceAssetId, owner_id: user.id, type: 'image', status: 'active' }, select: { id: true, file_name: true, original_url: true } }) : null;
  const source = candidateSource && await canReadStudioAsset(user, candidateSource) ? candidateSource : null;
  return { workspace, plans, taskByRequestId,
    submissionByRequestId: Object.fromEntries(plans.map(plan => [plan.id, taskByRequestId[plan.id] ? 'accepted' : byReceipt.get(receiptKey(user.id, plan.id)) || 'prepared'])),
    sourceAsset: source ? { id: source.id, fileName: source.file_name, url: studioAssetUrl(source.id), thumbnailUrl: studioAssetUrl(source.id, true) } : null };
}
function submission(plan: CharacterLabPlan): Record<string, unknown> {
  return { requestId: plan.id, projectId: plan.projectId, prompt: plan.prompt, count: 1,
    revision: plan.settingsRevision, referenceIds: plan.referenceIds, model: plan.model, channelId: plan.channelId,
    ...(plan.imageChannel ? { imageChannel: plan.imageChannel } : {}), quality: plan.quality, resolution: plan.resolution,
    aspectRatio: plan.aspectRatio, draft: { referencePolicy: defaultStudioReferencePolicy(plan.referenceIds) } };
}
export async function prepareLab(user: SessionUser, body: Record<string, unknown>) {
  const workspaceId = labId(body.workspaceId, '角色项目'), requestId = labId(body.requestId, '提交');
  if (body.kind !== 'faces' && body.kind !== 'result') throw new StudioError('生成阶段无效');
  const kind = body.kind;
  const draft = parseLabDraft(body.draft);
  await readLabWorkspace(user.id, workspaceId);
  const inputFingerprint = createHash('sha256').update(JSON.stringify({ workspaceId, kind, draft })).digest('hex');
  const existing = await prisma.platformSetting.findUnique({ where: { key: planKey(user.id, requestId) } });
  if (existing) {
    const plan = JSON.parse(existing.value_json) as StoredPlan;
    if (plan.inputFingerprint !== inputFingerprint) throw new StudioError('原提交编号属于另一组参数，请查询原记录', 409);
    return plan;
  }
  const oldPlans = await prisma.platformSetting.findMany({ where: { key: { startsWith: `character-lab:v1:${user.id}:plan:` } }, select: { value_json: true } });
  const related = oldPlans.map(row => JSON.parse(row.value_json) as CharacterLabPlan).filter(plan => plan.workspaceId === workspaceId);
  const sending = await prisma.platformSetting.findMany({ where: { key: { in: related.map(plan => receiptKey(user.id, plan.id)) }, value_json: JSON.stringify({ state: 'submitting' }) }, select: { key: true } });
  for (const row of sending) {
    const originalId = row.key.slice(row.key.lastIndexOf(':') + 1);
    if (!await prisma.imageStudioTask.findFirst({ where: { owner_id: user.id, batch_id: batchId(user.id, originalId) }, select: { id: true } })) throw new StudioError('此角色的原提交结果待确认，请先核对原请求；输入与已有结果保留', 409);
  }
  if (!draft.sourceAssetId) throw new StudioError('请先选择一张原始角色素材');
  await ownedLabAsset(user, draft.sourceAssetId);
  if (!IMAGE_STUDIO_MODELS.includes(draft.model as typeof IMAGE_STUDIO_MODELS[number])) throw new StudioError('当前图片模型无效');
  await prisma.$transaction(tx => assertUsageProject(tx, user, draft.projectId));
  const [settings, config] = await Promise.all([getImageStudioSettings(), labConfig()]);
  const quality = normalizeImageStudioQuality(draft.model, draft.quality), resolution = normalizeImageResolution(draft.model, draft.resolution);
  if (quality !== draft.quality || resolution !== draft.resolution) throw new StudioError('当前画质或分辨率不受此型号支持，请重新选择；原参数保留', 409);
  const references = [draft.sourceAssetId];
  let previousResultPlanId: string | null = null;
  if (kind === 'result') {
    if (!draft.mainFace) throw new StudioError('请先选择主面部');
    const choices = [draft.mainFace, ...draft.auxiliaryFaces];
    if (new Set(choices.map(choice => `${choice.planId}:${choice.cell}`)).size !== choices.length) throw new StudioError('主面部与辅助参考不能重复');
    if (choices.length + 1 + (draft.resultPlanId && draft.adjustment.trim() ? 1 : 0) > MAX_REFERENCE_IMAGES) throw new StudioError('原素材、已选面部与调整前成品合计超出参考图上限，请减少辅助参考');
    for (const choice of choices) {
      const source = await readLabPlan(user.id, choice.planId);
      if (source.workspaceId !== workspaceId || source.sourceAssetId !== draft.sourceAssetId) throw new StudioError('面部参考来自其他角色或原素材，请重新选择', 409);
      references.push(await persistLabFace(user, choice));
    }
    if (draft.resultPlanId && draft.adjustment.trim()) {
      const previous = await readLabPlan(user.id, draft.resultPlanId);
      if (previous.kind !== 'result' || previous.workspaceId !== workspaceId) throw new StudioError('原成品归属无效');
      const { asset } = await labOutput(user, previous);
      references.push(asset.id); previousResultPlanId = previous.id;
    }
  }
  const effective = await resolveImageGenerationRequestChannel(draft.model, draft.channelId, undefined, quality) || 'original';
  const imageChannel = effective !== 'original' ? await captureImageGenerationRequestChannel(draft.model, quality, draft.channelId) : undefined;
  const prompt = kind === 'faces' ? faceLabPrompt(config, draft) : resultLabPrompt(config, draft, Boolean(previousResultPlanId));
  if (prompt.length > 20000) throw new StudioError('规则和本次描述合计过长，请精简后再生成');
  const plan: StoredPlan = { id: requestId, workspaceId, kind, createdAt: new Date().toISOString(), sourceAssetId: draft.sourceAssetId,
    count: draft.count, diversity: draft.diversity, context: draft.context, mainFace: kind === 'result' ? draft.mainFace : null,
    auxiliaryFaces: kind === 'result' ? draft.auxiliaryFaces : [], auxiliaryFeatures: draft.auxiliaryFeatures,
    adjustment: kind === 'result' ? draft.adjustment : '', adjustmentCell: kind === 'result' ? draft.adjustmentCell : null,
    previousResultPlanId, configRevision: config.revision, prompt, model: draft.model, channelId: draft.channelId,
    quality, resolution, aspectRatio: kind === 'faces' ? '1:1' : '2:3', settingsRevision: settings.revision,
    referenceIds: references, projectId: draft.projectId, ...(imageChannel ? { imageChannel } : {}), inputFingerprint };
  await prisma.$transaction(async tx => {
    const collision = await tx.platformSetting.findUnique({ where: { key: planKey(user.id, requestId) } });
    if (collision) {
      if ((JSON.parse(collision.value_json) as StoredPlan).inputFingerprint !== inputFingerprint) throw new StudioError('原提交编号参数不一致', 409);
      return;
    }
    if (!await tx.platformSetting.findUnique({ where: { key: workspaceKey(user.id, workspaceId) } })) throw new StudioError('角色项目已不可用', 409);
    await tx.platformSetting.create({ data: { key: planKey(user.id, requestId), value_json: JSON.stringify(plan), updated_by: user.id } });
    await tx.platformSetting.create({ data: { key: receiptKey(user.id, requestId), value_json: JSON.stringify({ state: 'prepared' }), updated_by: user.id } });
  });
  return readLabPlan(user.id, requestId);
}
export async function quoteLab(user: SessionUser, id: string) {
  const plan = await readLabPlan(user.id, id);
  const state = await labPlanState(user, id);
  if (state.task || state.submissionState !== 'prepared') throw new StudioError('原提交已受理、待确认或已结束，请查询原记录；新生成需重新确认', 409);
  const quote = await prepareImageBillingQuote(user.id, submission(plan));
  const key = quoteKey(user.id, plan.id);
  await prisma.platformSetting.upsert({ where: { key }, create: { key, value_json: JSON.stringify(quote), updated_by: user.id }, update: { value_json: JSON.stringify(quote), updated_by: user.id } });
  return quote;
}
export async function submitLab(user: SessionUser, body: Record<string, unknown>) {
  const plan = await readLabPlan(user.id, labId(body.planId, '生成'));
  const accepted = await prisma.imageStudioTask.findFirst({ where: { owner_id: user.id, batch_id: batchId(user.id, plan.id) }, select: { batch_id: true } });
  if (accepted) return { batchId: accepted.batch_id };
  const receipt = await prisma.platformSetting.findUnique({ where: { key: receiptKey(user.id, plan.id) } });
  if (!receipt || (JSON.parse(receipt.value_json) as Receipt).state !== 'prepared') throw new StudioError('原提交结果待确认或已结束，请查询原记录，不要重复生成', 409);
  const storedQuote = await prisma.platformSetting.findUnique({ where: { key: quoteKey(user.id, plan.id) } });
  if (!storedQuote) throw new StudioError('请先获取本次生成报价');
  const quote = JSON.parse(storedQuote.value_json) as CharacterLabQuote;
  if (Date.parse(quote.expiresAt) <= Date.now() || (body.billingQuoteId || null) !== quote.billingQuoteId
    || (body.pricingRevision || undefined) !== quote.pricingRevision || body.maxEstimatedCost !== quote.estimatedCredits) throw new StudioError('报价已过期或与本次确认不一致，请重新报价', 409);
  // A durable send marker prevents an unknown transport result being resent after reload.
  if (!(await prisma.platformSetting.updateMany({ where: { key: receiptKey(user.id, plan.id), value_json: receipt.value_json }, data: { value_json: JSON.stringify({ state: 'submitting' }) } })).count) throw new StudioError('原提交已在处理中，请查询原记录', 409);
  try {
    const result = await submitStudioBatch(user.id, { ...submission(plan),
      ...(quote.imageChannel ? { imageChannel: quote.imageChannel } : {}),
      ...(quote.billingQuoteId ? { billingQuoteId: quote.billingQuoteId } : {}), ...(quote.pricingRevision ? { pricingRevision: quote.pricingRevision } : {}), maxEstimatedCost: quote.estimatedCredits });
    await prisma.platformSetting.update({ where: { key: receiptKey(user.id, plan.id) }, data: { value_json: JSON.stringify({ state: 'accepted' }) } });
    return { batchId: result };
  } catch (error) {
    const nowAccepted = await prisma.imageStudioTask.findFirst({ where: { owner_id: user.id, batch_id: batchId(user.id, plan.id) }, select: { batch_id: true } });
    if (nowAccepted) return { batchId: nowAccepted.batch_id };
    const known = studioBusinessErrorStatus(error) || (error instanceof QueueCapacityError || error instanceof QueueMaintenanceError ? error.status : null);
    if (known) await prisma.platformSetting.update({ where: { key: receiptKey(user.id, plan.id) }, data: { value_json: JSON.stringify({ state: 'rejected', error: error instanceof Error ? error.message : '本次未受理' }) } });
    throw Object.assign(error instanceof Error ? error : new Error('原提交结果待确认，请查询原记录'), { submitted: known ? false : null });
  }
}
export async function saveLabResult(user: SessionUser, body: Record<string, unknown>) {
  const workspace = await readLabWorkspace(user.id, labId(body.workspaceId)), plan = await readLabPlan(user.id, labId(body.planId));
  if (!Number.isInteger(body.revision) || workspace.revision !== body.revision) throw new StudioError('角色项目已更新，请重读后保存；成品保留', 409);
  if (plan.kind !== 'result' || plan.workspaceId !== workspace.id) throw new StudioError('成品归属不匹配');
  await labOutput(user, plan);
  const name = labText(body.name, 80, '作品名称') || workspace.name;
  const now = new Date().toISOString();
  const next: CharacterLabWorkspace = { ...workspace, revision: workspace.revision + 1, updatedAt: now,
    savedResults: [...workspace.savedResults.filter(result => result.planId !== plan.id), { planId: plan.id, name, savedAt: now }] };
  const row = await prisma.platformSetting.findUniqueOrThrow({ where: { key: workspaceKey(user.id, workspace.id) } });
  if ((JSON.parse(row.value_json) as CharacterLabWorkspace).revision !== workspace.revision || !(await prisma.platformSetting.updateMany({ where: { key: row.key, value_json: row.value_json }, data: { value_json: JSON.stringify(next), updated_by: user.id } })).count) throw new StudioError('角色项目已更新，请重新读取', 409);
  return next;
}
