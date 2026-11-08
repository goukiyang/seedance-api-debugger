import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
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
import { captureImageGenerationRequestChannel, captureImageGenerationChannel } from '@/lib/integrations/image-generation';
import { assertUsageProject } from '@/lib/admin/usage-attribution';
import { defaultStudioReferencePolicy } from '@/lib/image-studio/reference-policy';
import { MAX_REFERENCE_IMAGES } from '@/lib/image-studio/limits';
import { canReadStudioAsset, studioVisibleAssetWhere } from '@/lib/image-studio/protected-assets';
import { QueueCapacityError, QueueMaintenanceError } from '@/lib/image-studio/queue-capacity';
import { ownedLabAsset, persistLabFace, labOutput, readLabReference } from './media';
import { labIndependentDraft } from './contexts';
import { faceLabPrompt, resultLabPrompt, labViewPrompt } from './prompts';
import { labConfig, labConfigVersions, labId, labReference, labText, listLabWorkspaces, parseLabDraft, planKey, readLabPlan, readLabWorkspace, receiptKey, workspaceKey } from './store';
import { characterLabOperations, characterLabSlotsOverlap, sameLabReference, type CharacterLabOperation } from './types';
import type { CharacterLabBootstrap, CharacterLabPlan, CharacterLabQuote, CharacterLabTask, CharacterLabWorkspace, CharacterLabWorkspacePayload } from './types';

// The compatible recovery build keeps paired results readable while closing fresh generation.
export const CHARACTER_LAB_BODY_PAIRS_ENABLED = true;
export const CHARACTER_LAB_RECIPE_WRITES_ENABLED = true;
export const CHARACTER_LAB_GRID_WRITES_ENABLED = true;

type StoredPlan = CharacterLabPlan & { inputFingerprint: string };
type Receipt = { state: 'prepared' | 'submitting' | 'accepted' | 'rejected'; error?: string };
const batchId = (owner: string, id: string) => createHash('sha256').update(`${owner}:${id}`).digest('hex');
const quoteKey = (owner: string, id: string) => `character-lab:v1:${owner}:quote:${id}`;
export function publicLabPlan(user: SessionUser, plan: CharacterLabPlan): CharacterLabPlan {
  const { frozenReferenceContext, ...visible } = plan;
  return user.role === 'admin' ? plan : { ...visible, prompt: '' };
}
export async function labBootstrap(): Promise<Omit<CharacterLabBootstrap, 'workspaces'>> {
  const [settings, imageChannels, config, configVersions] = await Promise.all([getImageStudioSettings(), getPricingImageChannelOptions(), labConfig(), labConfigVersions()]);
  return { settings: { model: settings.model, revision: settings.revision, imageChannels }, config, configVersions };
}
export async function labBootstrapFor(user: SessionUser): Promise<CharacterLabBootstrap> {
  const [base, workspaces] = await Promise.all([labBootstrap(), listLabWorkspaces(user.id)]);
  if (user.role === 'admin') return { ...base, workspaces };
  const config = Object.fromEntries(Object.entries(base.config).map(([key, value]) => [key, typeof value === 'string' ? '' : value])) as typeof base.config;
  return { ...base, config, configVersions: [], workspaces };
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
  return { plan: publicLabPlan(user, plan), task, submissionState: state };
}
export async function labWorkspaceState(user: SessionUser, id: string, includeViews = false): Promise<CharacterLabWorkspacePayload> {
  const workspace = await readLabWorkspace(user.id, id);
  const records = await prisma.platformSetting.findMany({ where: { key: { startsWith: `character-lab:v1:${user.id}:plan:` } }, orderBy: { created_at: 'desc' } });
  const ownPlans = records.map(row => JSON.parse(row.value_json) as CharacterLabPlan).filter(plan => plan.workspaceId === id);
  workspace.draft = labIndependentDraft(workspace.draft, ownPlans, workspace.views);
  const plans = ownPlans.filter(plan => includeViews || !plan.operation);
  const [taskByRequestId, receipts] = await Promise.all([tasksForPlans(user, plans), prisma.platformSetting.findMany({ where: { key: { in: plans.map(plan => receiptKey(user.id, plan.id)) } } })]);
  const byReceipt = new Map(receipts.map(row => [row.key, (JSON.parse(row.value_json) as Receipt).state]));
  const candidateSource = workspace.draft.sourceAssetId ? await prisma.asset.findFirst({ where: { id: workspace.draft.sourceAssetId, owner_id: user.id, type: 'image', status: 'active' }, select: { id: true, file_name: true, original_url: true } }) : null;
  const source = candidateSource && await canReadStudioAsset(user, candidateSource) ? candidateSource : null;
  return { workspace, plans: plans.map(plan => publicLabPlan(user, plan)), taskByRequestId,
    submissionByRequestId: Object.fromEntries(plans.map(plan => [plan.id, taskByRequestId[plan.id] ? 'accepted' : byReceipt.get(receiptKey(user.id, plan.id)) || 'prepared'])),
    sourceAsset: source ? { id: source.id, fileName: source.file_name, url: studioAssetUrl(source.id), thumbnailUrl: studioAssetUrl(source.id, true) } : null };
}
function submission(plan: CharacterLabPlan): Record<string, unknown> {
  return { requestId: plan.id, projectId: plan.projectId, prompt: plan.prompt,
    personalPrompt: plan.operation ? plan.adjustment : [plan.context, plan.adjustment].filter(Boolean).join('\n\n'), count: 1,
    revision: plan.settingsRevision, referenceIds: plan.referenceIds, model: plan.model, channelId: plan.channelId,
    ...(plan.imageChannel ? { imageChannel: plan.imageChannel } : {}), quality: plan.quality, resolution: plan.resolution,
    aspectRatio: plan.aspectRatio, draft: { referencePolicy: defaultStudioReferencePolicy(plan.referenceIds) } };
}
async function assertLabSlotClear(db: Pick<Prisma.TransactionClient, 'platformSetting' | 'imageStudioTask'>, userId: string, plan: Pick<CharacterLabPlan, 'workspaceId' | 'kind' | 'operation' | 'slotScoped'>) {
  const receipts = await db.platformSetting.findMany({
    where: { key: { startsWith: `character-lab:v1:${userId}:receipt:` }, value_json: JSON.stringify({ state: 'submitting' }) },
    select: { key: true },
  });
  if (!receipts.length) return;
  const records = await db.platformSetting.findMany({
    where: { key: { in: receipts.map(receipt => planKey(userId, receipt.key.slice(receipt.key.lastIndexOf(':') + 1))) } },
    select: { value_json: true },
  });
  const batches = records.map(row => JSON.parse(row.value_json) as CharacterLabPlan).filter(other =>
    other.workspaceId === plan.workspaceId && (!plan.slotScoped || !other.slotScoped || characterLabSlotsOverlap(other, plan)))
    .map(other => batchId(userId, other.id));
  if (!batches.length) return;
  const accepted = await db.imageStudioTask.findMany({
    where: { owner_id: userId, batch_id: { in: batches } }, distinct: ['batch_id'], select: { batch_id: true },
  });
  if (accepted.length !== batches.length) throw new StudioError('此处的原提交结果待确认，请先核对原请求；输入与已有结果保留', 409);
}
export async function prepareLab(user: SessionUser, body: Record<string, unknown>) {
  if (body.contextProtocol !== undefined && body.contextProtocol !== 1) throw new StudioError('上下文版本不受支持，请刷新页面', 409);
  if (body.recipeProtocol !== undefined && body.recipeProtocol !== 1) throw new StudioError('生成配方版本不受支持，请刷新页面', 409);
  if (body.recipeProtocol === 1 && !CHARACTER_LAB_RECIPE_WRITES_ENABLED) throw new StudioError('当前恢复版本仅查看已有配方，暂不创建新配方', 409);
  const workspaceId = labId(body.workspaceId, '角色项目'), requestId = labId(body.requestId, '提交');
  if (body.kind !== 'faces' && body.kind !== 'result') throw new StudioError('生成阶段无效');
  const kind = body.kind;
  if (body.operation !== undefined && !characterLabOperations.includes(body.operation as CharacterLabOperation)) throw new StudioError('生成用途无效');
  const operation = body.operation as CharacterLabOperation | undefined;
  if (operation === 'body-pair' && !CHARACTER_LAB_BODY_PAIRS_ENABLED) throw new StudioError('当前恢复版本暂不新建正背面任务，原有记录仍可查看和选用', 409);
  const refinement = operation === 'refine-face' || operation === 'refine-side';
  if (body.layoutProtocol !== undefined && body.layoutProtocol !== 1) throw new StudioError('候选布局版本不受支持，请刷新页面', 409);
  if (body.layoutProtocol === 1 && !CHARACTER_LAB_GRID_WRITES_ENABLED) throw new StudioError('当前恢复版本仅查看已有候选，暂不创建新版布局', 409);
  const layout = body.layoutProtocol === 1;
  if (operation && kind !== (refinement ? 'faces' : 'result')) throw new StudioError('生成用途与输出不匹配');
  const slotScoped = operation !== undefined || body.workbench === 2 ? true as const : undefined;
  const draft = parseLabDraft(body.draft);
  delete draft.views;
  const input = refinement || layout && operation === 'body-pair' ? labReference(body.input) : null;
  const description = operation ? labText(body.description ?? (refinement ? '' : operation === 'side' ? draft.sideDescription || '' : body.contextProtocol === 1 ? draft.bodyDescription || '' : draft.context), 3000, refinement ? '微调描述' : '角色补充') : '';
  if (refinement && (!input || !description)) throw new StudioError('请选择要微调的图片并填写修改要求');
  await readLabWorkspace(user.id, workspaceId);
  const inputFingerprint = createHash('sha256').update(JSON.stringify({ workspaceId, kind, draft, operation, slotScoped, ...(operation ? { input, description } : {}), ...(body.contextProtocol === 1 ? { contextProtocol: 1 } : {}), ...(layout ? { layoutProtocol: 1 } : {}) })).digest('hex');
  const existing = await prisma.platformSetting.findUnique({ where: { key: planKey(user.id, requestId) } });
  if (existing) {
    const plan = JSON.parse(existing.value_json) as StoredPlan;
    if (plan.inputFingerprint !== inputFingerprint) throw new StudioError('原提交编号属于另一组参数，请查询原记录', 409);
    return plan;
  }
  if (body.contextProtocol !== 1) throw new StudioError('上下文已独立，请刷新页面后生成；已有输入与原记录保留', 409);
  const personal = operation === 'side' ? draft.sideDescription : operation?.startsWith('body-') ? draft.bodyDescription : !operation && kind === 'faces' ? draft.faceDescription : '';
  if (personal === undefined) throw new StudioError('请刷新页面读取独立补充输入', 409);
  if (operation && !refinement && description !== personal) throw new StudioError('当前补充与此生成区域不一致，请重新读取', 409);
  await assertLabSlotClear(prisma, user.id, { workspaceId, kind, operation, slotScoped });
  if (!draft.sourceAssetId) throw new StudioError('请先选择一张原始角色素材');
  await ownedLabAsset(user, draft.sourceAssetId);
  if (!IMAGE_STUDIO_MODELS.includes(draft.model as typeof IMAGE_STUDIO_MODELS[number])) throw new StudioError('当前图片模型无效');
  await prisma.$transaction(tx => assertUsageProject(tx, user, draft.projectId));
  const [settings, config] = await Promise.all([getImageStudioSettings(), labConfig()]);
  const settingsSource = draft.settingsSource?.target === (operation || kind) ? await readLabPlan(user.id, draft.settingsSource.planId) : null;
  if (settingsSource && (settingsSource.workspaceId !== workspaceId || settingsSource.sourceAssetId !== draft.sourceAssetId)) throw new StudioError('沿用设置来自另一角色或原图，请重新选择', 409);
  const quality = normalizeImageStudioQuality(draft.model, draft.quality), resolution = normalizeImageResolution(draft.model, draft.resolution);
  if (quality !== draft.quality || resolution !== draft.resolution) throw new StudioError('当前画质或分辨率不受此型号支持，请重新选择；原参数保留', 409);
  let references = [draft.sourceAssetId];
  let previousResultPlanId: string | null = null;
  if (operation === 'refine-face' || operation === 'side' || operation === 'refine-side') {
    const front = operation === 'refine-face' ? input : draft.mainFace;
    if (!front) throw new StudioError('请先选择正脸');
    await readLabReference(user, workspaceId, draft.sourceAssetId, front, 'faces');
    references = [await persistLabFace(user, front)];
    if (operation === 'refine-side' && input) {
      const side = await readLabReference(user, workspaceId, draft.sourceAssetId, input, 'side');
      if (!sameLabReference(side.mainFace, draft.mainFace)) throw new StudioError('侧脸对应旧正脸，请先为当前正脸制作侧脸', 409);
      references.push(await persistLabFace(user, input));
    }
  } else if (operation === 'body-pair' && input) {
    const previous = await readLabPlan(user.id, input.planId);
    if (input.cell !== undefined || previous.operation !== 'body-pair' || previous.workspaceId !== workspaceId || previous.sourceAssetId !== draft.sourceAssetId) throw new StudioError('身体微调须选择当前角色的完整正背面组', 409);
    references.push((await labOutput(user, previous)).asset.id);
  } else if (!operation && kind === 'result') {
    if (!draft.mainFace) throw new StudioError('请先选择主面部');
    const hasAdjustment = Boolean(draft.adjustment.trim()) || draft.adjustmentCell !== null;
    const choices = [draft.mainFace, ...draft.auxiliaryFaces];
    if (new Set(choices.map(choice => `${choice.planId}:${choice.cell}`)).size !== choices.length) throw new StudioError('主面部与辅助参考不能重复');
    if (choices.length + 1 + (draft.resultPlanId && hasAdjustment ? 1 : 0) > MAX_REFERENCE_IMAGES) throw new StudioError('原素材、已选面部与调整前成品合计超出参考图上限，请减少辅助参考');
    for (const choice of choices) {
      await readLabReference(user, workspaceId, draft.sourceAssetId, choice, 'faces');
      references.push(await persistLabFace(user, choice));
    }
    if (draft.resultPlanId && hasAdjustment) {
      const previous = await readLabPlan(user.id, draft.resultPlanId);
      if (previous.kind !== 'result' || previous.operation || previous.workspaceId !== workspaceId) throw new StudioError('原成品归属无效');
      const { asset } = await labOutput(user, previous);
      references.push(asset.id); previousResultPlanId = previous.id;
    }
  }
  const effective = await resolveImageGenerationRequestChannel(draft.model, draft.channelId, undefined, quality) || 'original';
  const imageChannel = effective !== 'original' ? await captureImageGenerationRequestChannel(draft.model, quality, draft.channelId) : undefined;
  const prompt = operation ? labViewPrompt(config, operation, description, layout ? { count: draft.count, bodyInput: Boolean(input) } : undefined)
    : kind === 'faces' ? faceLabPrompt(config, draft) : resultLabPrompt(config, draft, Boolean(previousResultPlanId));
  if (prompt.length > 20000) throw new StudioError('规则和本次描述合计过长，请精简后再生成');
  const plan: StoredPlan = { id: requestId, workspaceId, kind, createdAt: new Date().toISOString(), sourceAssetId: draft.sourceAssetId,
    count: refinement && !layout ? 4 : draft.count, diversity: draft.diversity, context: operation ? '' : kind === 'faces' ? draft.faceDescription! : draft.context,
    mainFace: operation === 'side' || operation === 'refine-side' || !operation && kind === 'result' ? draft.mainFace : null,
    auxiliaryFaces: !operation && kind === 'result' ? draft.auxiliaryFaces : [], auxiliaryFeatures: !operation && kind === 'result' ? draft.auxiliaryFeatures : '',
    adjustment: operation ? description : kind === 'result' ? draft.adjustment : '', adjustmentCell: !operation && kind === 'result' ? draft.adjustmentCell : null,
    previousResultPlanId, configRevision: config.revision, prompt, model: draft.model, channelId: draft.channelId,
    quality, resolution, aspectRatio: kind === 'faces' || operation === 'side' || operation === 'body-pair' ? '1:1' : '2:3', settingsRevision: settings.revision,
    referenceIds: references, projectId: draft.projectId, ...(imageChannel ? { imageChannel } : {}),
    ...(operation ? { operation } : {}), ...(input ? { input } : {}), ...(slotScoped ? { slotScoped } : {}),
    contextProtocol: 1,
    ...(layout && (kind === 'faces' || operation === 'side') ? { outputLayout: 'grid' as const } : {}),
    ...(body.recipeProtocol === 1 ? { recipeProtocol: 1 as const } : {}),
    ...(settingsSource ? { origin: { planId: settingsSource.id, mode: 'current' as const } } : {}), inputFingerprint };
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
export async function reproduceLab(user: SessionUser, body: Record<string, unknown>) {
  if (!CHARACTER_LAB_RECIPE_WRITES_ENABLED) throw new StudioError('当前恢复版本仅查看已有配方，暂不创建新配方', 409);
  const source = await readLabPlan(user.id, labId(body.sourcePlanId, '原生成'));
  if (source.outputLayout === 'grid' && !CHARACTER_LAB_GRID_WRITES_ENABLED) throw new StudioError('当前恢复版本仅查看已有新版候选', 409);
  if (source.operation === 'body-front' || source.operation === 'body-back') throw new StudioError('旧版单面记录可沿用设置；新的正背面须一起生成', 409);
  const workspace = await readLabWorkspace(user.id, labId(body.workspaceId, '角色项目'));
  if (source.workspaceId !== workspace.id || source.sourceAssetId !== workspace.draft.sourceAssetId) throw new StudioError('原设置属于另一角色或原图，当前输入保留', 409);
  if (source.operation === 'body-pair' && !CHARACTER_LAB_BODY_PAIRS_ENABLED) throw new StudioError('当前恢复版本暂不新建正背面任务', 409);
  const id = labId(body.requestId, '提交');
  const inputFingerprint = createHash('sha256').update(JSON.stringify({ sourcePlanId: source.id, workspaceId: workspace.id, mode: 'historical' })).digest('hex');
  const existing = await prisma.platformSetting.findUnique({ where: { key: planKey(user.id, id) } });
  if (existing) {
    const original = JSON.parse(existing.value_json) as StoredPlan;
    if (original.inputFingerprint !== inputFingerprint) throw new StudioError('原提交编号属于另一份设置，请查询原记录', 409);
    return original;
  }
  await assertLabSlotClear(prisma, user.id, source);
  const { task: originalTask } = await labOutput(user, source);
  const referenceSnapshot = JSON.parse(originalTask.snapshot_json || '{}').referenceImages as Array<{ id?: string; hash?: string }> | undefined;
  for (const reference of source.referenceIds) {
    const asset = await ownedLabAsset(user, reference), expected = referenceSnapshot?.find(item => item.id === reference)?.hash;
    if (expected && asset.hash !== expected) throw new StudioError('原参考图内容已变化，请沿用当前设置重新确认参考', 409);
  }
  await prisma.$transaction(tx => assertUsageProject(tx, user, source.projectId));
  const settings = await getImageStudioSettings();
  const plan: StoredPlan = { ...source, id, createdAt: new Date().toISOString(), settingsRevision: settings.revision,
    recipeProtocol: 1, frozenReferenceContext: originalTask.context, origin: { planId: source.id, mode: 'historical' }, inputFingerprint };
  await prisma.$transaction(async tx => {
    await assertLabSlotClear(tx, user.id, plan);
    await tx.platformSetting.create({ data: { key: planKey(user.id, id), value_json: JSON.stringify(plan), updated_by: user.id } });
    await tx.platformSetting.create({ data: { key: receiptKey(user.id, id), value_json: JSON.stringify({ state: 'prepared' }), updated_by: user.id } });
  });
  return plan;
}
export async function quoteLab(user: SessionUser, id: string) {
  const plan = await readLabPlan(user.id, id);
  const state = await labPlanState(user, id);
  if (state.task || state.submissionState !== 'prepared') throw new StudioError('原提交已受理、待确认或已结束，请查询原记录；新生成需重新确认', 409);
  const imageChannel = plan.imageChannel ?? await captureImageGenerationRequestChannel(plan.model, plan.quality, plan.channelId)
    ?? await captureImageGenerationChannel(plan.model, 'original');
  const quote = await prepareImageBillingQuote(user.id, { ...submission(plan), imageChannel }, undefined, undefined, undefined, 0, plan.id);
  const key = quoteKey(user.id, plan.id);
  const value_json = JSON.stringify({ ...quote, characterLabSourceVersion: 2 });
  await prisma.platformSetting.upsert({ where: { key }, create: { key, value_json, updated_by: user.id }, update: { value_json, updated_by: user.id } });
  return quote;
}
export async function submitLab(user: SessionUser, body: Record<string, unknown>) {
  const plan = await readLabPlan(user.id, labId(body.planId, '生成'));
  const accepted = await prisma.imageStudioTask.findFirst({ where: { owner_id: user.id, batch_id: batchId(user.id, plan.id) }, select: { batch_id: true } });
  if (accepted) return { batchId: accepted.batch_id };
  const receipt = await prisma.platformSetting.findUnique({ where: { key: receiptKey(user.id, plan.id) } });
  if (!receipt || (JSON.parse(receipt.value_json) as Receipt).state !== 'prepared') throw new StudioError('原提交结果待确认或已结束，请查询原记录，不要重复生成', 409);
  if (plan.recipeProtocol === 1 && !CHARACTER_LAB_RECIPE_WRITES_ENABLED) throw Object.assign(new StudioError('当前恢复版本暂不创建新配方，原有记录仍可查看和选用', 409), { submitted: false });
  if (plan.operation === 'body-pair' && !CHARACTER_LAB_BODY_PAIRS_ENABLED) throw Object.assign(new StudioError('当前恢复版本暂不新建正背面任务，原有记录仍可查看和选用', 409), { submitted: false });
  if (plan.outputLayout === 'grid' && !CHARACTER_LAB_GRID_WRITES_ENABLED) throw Object.assign(new StudioError('当前恢复版本暂不提交新版候选', 409), { submitted: false });
  const storedQuote = await prisma.platformSetting.findUnique({ where: { key: quoteKey(user.id, plan.id) } });
  if (!storedQuote) throw new StudioError('请先获取本次生成报价');
  const quote = JSON.parse(storedQuote.value_json) as CharacterLabQuote & { characterLabSourceVersion?: number };
  if (quote.characterLabSourceVersion !== 2) throw new StudioError('角色工具报价来源已更新，请重新获取本次报价；原提交编号与输入保留', 409);
  if (Date.parse(quote.expiresAt) <= Date.now() || (body.billingQuoteId || null) !== quote.billingQuoteId
    || (body.pricingRevision || undefined) !== quote.pricingRevision || body.maxEstimatedCost !== quote.estimatedCredits) throw new StudioError('报价已过期或与本次确认不一致，请重新报价', 409);
  // A durable send marker prevents an unknown transport result being resent after reload.
  await prisma.$transaction(async tx => {
    await assertLabSlotClear(tx, user.id, plan);
    const updated = await tx.platformSetting.updateMany({
      where: { key: receiptKey(user.id, plan.id), value_json: receipt.value_json },
      data: { value_json: JSON.stringify({ state: 'submitting' }) },
    });
    if (!updated.count) throw new StudioError('原提交已在处理中，请查询原记录', 409);
  });
  try {
    const result = await submitStudioBatch(user.id, { ...submission(plan),
      ...(quote.imageChannel ? { imageChannel: quote.imageChannel } : {}),
      ...(quote.billingQuoteId ? { billingQuoteId: quote.billingQuoteId } : {}), ...(quote.pricingRevision ? { pricingRevision: quote.pricingRevision } : {}), maxEstimatedCost: quote.estimatedCredits }, undefined, undefined, undefined, undefined, undefined, undefined, plan.id);
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
  if (plan.kind !== 'result' || plan.operation || plan.workspaceId !== workspace.id) throw new StudioError('成品归属不匹配');
  await labOutput(user, plan);
  const name = labText(body.name, 80, '作品名称') || workspace.name;
  const now = new Date().toISOString();
  const next: CharacterLabWorkspace = { ...workspace, revision: workspace.revision + 1, updatedAt: now,
    savedResults: [...workspace.savedResults.filter(result => result.planId !== plan.id), { planId: plan.id, name, savedAt: now }] };
  const row = await prisma.platformSetting.findUniqueOrThrow({ where: { key: workspaceKey(user.id, workspace.id) } });
  if ((JSON.parse(row.value_json) as CharacterLabWorkspace).revision !== workspace.revision || !(await prisma.platformSetting.updateMany({ where: { key: row.key, value_json: row.value_json }, data: { value_json: JSON.stringify(next), updated_by: user.id } })).count) throw new StudioError('角色项目已更新，请重新读取', 409);
  return next;
}
