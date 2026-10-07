import { createHash, randomUUID } from 'node:crypto';
import { bindModuleContextVersion, MODULE_CONTEXT_VERSION_RULE, snapshotModuleContextVersion, withContextVersionRetry } from './context-version';
import type { ImageStudioTask, Prisma } from '@prisma/client';
import { studioDeliveryStatus } from './delivery';
import { prisma } from '@/lib/prisma';
import { allocateTaskCredits, settleTaskCredits } from '@/lib/credits/policy';
import { getImageStudioSettings } from './settings';
import { getImageGenerationSettingsForModel, isImageGenerationApiReady, isStudioImageGenerationProvider } from '@/lib/integrations/image-generation';
import { defaultStudioModuleId, resolveStudioModuleGenerationConfig, validStudioModuleId } from './modules';
import { canUseCompanyTemplates, canViewStudioPreset, type ImageStudioIdentity } from './access';
import { resolveStudioAspectRatio, normalizeStudioRatio } from './ratios';
import { imageOutputSize, normalizeImageResolution, IMAGE_RESOLUTION_OPTIONS, supportsStudioFourToOne, studioFourToOneIssue } from '@/lib/image-generation/resolution';
import { MAX_REFERENCE_IMAGES } from './limits';
import { IMAGE_STUDIO_MODEL_COST_USD, IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_QUALITY_OPTIONS } from './model-catalog';
import { studioAssetUrl, studioTemplateAssetUrl } from './media';
import { displayUserName } from '@/lib/users/display';
import { getStudioModuleFixedReferences, parseStudioFixedReferences, type StudioFixedReference } from './fixed-references';
import { getStudioModuleStyleIds, parseStudioStyleIds, resolveStudioStyleReferences, StudioStyleError } from './style-groups';
import { studioVisibleAssetWhere } from './protected-assets';
import { defaultStudioReferencePolicy, getStudioModuleReferencePolicy, mapStudioReferencePolicy, parseStudioReferencePolicy, validateStudioReferenceCounts, StudioReferencePolicyError, type StudioReferencePolicy } from './reference-policy';
import { DEFAULT_STUDIO_PRIMARY_MAX } from './limits';
import type { AvatarCandidate, AvatarLayout } from '@/lib/avatar-random/types';
import { isAvatarSheet, validateSheetCandidates } from '@/lib/avatar-random/layout';
import { evolutionCapability, parseEvolution, resolveEvolution, evolutionInstructions } from './evolution';
import { studioTemplateTaskWhere } from './task-visibility';

export class StudioError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

type StudioTaskDraft = {
  moduleContext?: string;
  globalContext?: string;
  fixedReferences?: StudioFixedReference[];
  styleGroupIds?: string[];
  referencePolicy?: StudioReferencePolicy;
};

const MAX_STYLE_GROUP_NOTE_LENGTH = 8000;
type StudioTaskStyleGroupSnapshot = { id: string; name: string; revision: number; referenceCount: number; ownerId?: string; note?: string };
type StudioTaskStyleReferenceGroup = StudioTaskStyleGroupSnapshot & { references: StudioFixedReference[] };

function parseHistoricalStyleGroups(value: unknown): StudioTaskStyleGroupSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.name !== 'string') return [];
    return [{ id: record.id, name: record.name,
      revision: Number.isInteger(record.revision) ? Number(record.revision) : 0,
      referenceCount: Number.isInteger(record.referenceCount) ? Math.max(0, Math.min(MAX_REFERENCE_IMAGES, Number(record.referenceCount))) : 0,
      ...(typeof record.ownerId === 'string' ? { ownerId: record.ownerId } : {}),
      ...(typeof record.note === 'string' && record.note.length <= MAX_STYLE_GROUP_NOTE_LENGTH ? { note: record.note } : {}) }];
  });
}

function parseStudioTaskDraft(value: unknown, referenceIds: string[]): StudioTaskDraft | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioError('当前生成草稿无效');
  const record = value as Record<string, unknown>;
  const allowed = ['moduleContext', 'globalContext', 'fixedReferences', 'styleGroupIds', 'referencePolicy'];
  if (Object.keys(record).some(key => !allowed.includes(key))) throw new StudioError('当前生成草稿包含不支持的字段');
  if (record.moduleContext !== undefined && (typeof record.moduleContext !== 'string' || record.moduleContext.length > 20000)) throw new StudioError('模块上下文最多 20000 字');
  if (record.globalContext !== undefined && (typeof record.globalContext !== 'string' || record.globalContext.length > 20000)) throw new StudioError('通用上下文最多 20000 字');
  const draft: StudioTaskDraft = {};
  if (record.moduleContext !== undefined) draft.moduleContext = record.moduleContext as string;
  if (record.globalContext !== undefined) draft.globalContext = record.globalContext as string;
  if (record.fixedReferences !== undefined) {
    try { draft.fixedReferences = parseStudioFixedReferences(record.fixedReferences); }
    catch (error) { throw new StudioError((error as Error).message); }
  }
  if (record.styleGroupIds !== undefined) {
    try { draft.styleGroupIds = parseStudioStyleIds(record.styleGroupIds); }
    catch (error) {
      if (error instanceof StudioStyleError) throw new StudioError(error.message, error.status);
      throw error;
    }
  }
  if (record.referencePolicy !== undefined) {
    try { draft.referencePolicy = parseStudioReferencePolicy(record.referencePolicy, referenceIds); }
    catch (error) { throw new StudioError((error as Error).message, Number((error as { status?: unknown }).status) || 400); }
  }
  return draft;
}

export function parseStudioRequest(body: Record<string, unknown>) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StudioError('提交内容无效');
  if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)) throw new StudioError('提交编号无效');
  if (typeof body.prompt !== 'string' || body.prompt.length > 20000) throw new StudioError('画面描述不能超过 20000 字');
  if (!Number.isInteger(body.count) || Number(body.count) < 1 || Number(body.count) > 8) throw new StudioError('生成张数必须为 1 到 8');
  if (!Number.isInteger(body.revision)) throw new StudioError('请刷新生成设置');
  if (!Array.isArray(body.referenceIds) || body.referenceIds.length > MAX_REFERENCE_IMAGES || body.referenceIds.some(id => typeof id !== 'string' || id.length > 100)) throw new StudioError(`最多使用 ${MAX_REFERENCE_IMAGES} 张有效参考图`);
  const referenceIds = body.referenceIds as string[];
  const draft = parseStudioTaskDraft(body.draft, referenceIds);
  let evolution;
  try { evolution = parseEvolution(body.evolution); } catch (error) { throw new StudioError((error as Error).message); }
  let aspectRatio: string | undefined;
  try { if (body.aspectRatio !== undefined) aspectRatio = normalizeStudioRatio(body.aspectRatio); }
  catch (error) { throw new StudioError((error as Error).message); }
  let resolution: string | undefined;
  if (body.resolution !== undefined) {
    if (typeof body.resolution !== 'string' || !IMAGE_RESOLUTION_OPTIONS.includes(body.resolution as typeof IMAGE_RESOLUTION_OPTIONS[number])) throw new StudioError('分辨率设置无效');
    resolution = body.resolution;
  }
  const moduleRevision = body.moduleRevision === undefined ? undefined : Number(body.moduleRevision);
  const model = body.model === undefined ? undefined : body.model;
  if (model !== undefined && (typeof model !== 'string' || !IMAGE_STUDIO_MODELS.includes(model as typeof IMAGE_STUDIO_MODELS[number]))) throw new StudioError('生成模型无效');
  const quality = body.quality === undefined ? undefined : body.quality;
  if (quality !== undefined && (typeof quality !== 'string' || quality.length > 30)) throw new StudioError('图片质量无效');
  if (moduleRevision !== undefined && (!Number.isInteger(moduleRevision) || moduleRevision < 0)) throw new StudioError('模块已更新，请刷新后重试', 409);
  const reproduceFromTaskId = body.reproduceFromTaskId === undefined ? undefined : body.reproduceFromTaskId;
  if (reproduceFromTaskId !== undefined && (typeof reproduceFromTaskId !== 'string' || reproduceFromTaskId.length > 120)) throw new StudioError('历史生成记录无效', 400);
  return { requestId: body.requestId, prompt: body.prompt.trim(), count: Number(body.count), revision: Number(body.revision), moduleRevision, reproduceFromTaskId, referenceIds, ...(evolution ? { evolution } : {}), ...(draft !== undefined ? { draft } : {}), ...(aspectRatio !== undefined ? { aspectRatio } : {}), ...(resolution !== undefined ? { resolution } : {}), ...(model !== undefined ? { model: model as typeof IMAGE_STUDIO_MODELS[number] } : {}), ...(quality !== undefined ? { quality: quality as string } : {}) };
}

function parseHistoricalFixedReferences(value: unknown): StudioFixedReference[] {
  if (!Array.isArray(value)) throw new StudioError('历史固定参考图快照无效', 409);
  const references = value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new StudioError('历史固定参考图快照无效', 409);
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id) throw new StudioError('历史固定参考图快照无效', 409);
    return { assetId: record.id, note: typeof record.note === 'string' ? record.note : '' };
  });
  try { return parseStudioFixedReferences(references); }
  catch { throw new StudioError('历史固定参考图快照无效', 409); }
}

export async function submitStudioBatch(ownerId: string, body: Record<string, unknown>, avatar?: { layout?: AvatarLayout; candidates: AvatarCandidate[]; onQueued?: (tx: Prisma.TransactionClient, batchId: string) => Promise<void> }, preparation?: { save: (tx: Prisma.TransactionClient, data: Prisma.ImageStudioTaskUncheckedCreateInput) => Promise<void> }) {
  const input = parseStudioRequest(body);
  const moduleId = body.moduleId;
  const sheet = Boolean(avatar && isAvatarSheet(avatar));
  if (avatar && (moduleId !== undefined || input.draft !== undefined || input.reproduceFromTaskId || (sheet ? input.count !== 1 || input.aspectRatio !== '1:1' : avatar.candidates.length !== input.count))) throw new StudioError('人物任务排版无效或继承了模板设置');
  if (sheet) { try { validateSheetCandidates(avatar!.candidates, input.referenceIds, avatar!.layout); } catch (e) { throw new StudioError((e as Error).message); } }
  if (moduleId !== undefined && !validStudioModuleId(moduleId, ownerId)) throw new StudioError('模块编号无效');
  const batchId = createHash('sha256').update(`${ownerId}:${input.requestId}`).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify({ ...input, requestId: undefined, ...(moduleId ? { moduleId } : {}), ...(avatar ? { avatar: avatar.candidates, ...(sheet ? { avatarLayout: avatar!.layout } : {}) } : {}) })).digest('hex');
  const previous = await prisma.imageStudioTask.findFirst({ where: { batch_id: batchId, owner_id: ownerId } });
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new StudioError('提交编号已用于其他请求，请重新提交', 409);
    return batchId;
  }
  const settings = await getImageStudioSettings();
  if (settings.revision !== input.revision) throw new StudioError('生成规则或通用上下文已更新，请重新读取设置后确认提交', 409);
  await withContextVersionRetry(() => prisma.$transaction(async tx => {
    const duplicate = await tx.imageStudioTask.findFirst({ where: { batch_id: batchId, owner_id: ownerId } });
    if (duplicate) {
      if (duplicate.fingerprint !== fingerprint) throw new StudioError('提交编号冲突', 409);
      return;
    }
    const user = await tx.user.findUnique({ where: { id: ownerId }, select: {
      id: true, role: true, account_type: true, status: true,
      user_profile: true,
      feishu_user_id: true, feishu_open_id: true, feishu_union_id: true, feishu_tenant_key: true,
    } });
    if (!user || user.status !== 'active') throw new StudioError('当前账号无法生成', 403);
    const identity: ImageStudioIdentity = user;
    if (!canUseCompanyTemplates(identity)) throw new StudioError('仅限公司飞书账号生成图片', 403);
    const workspace = moduleId ? await tx.imageStudioModule.findFirst({ where: { id: moduleId as string, owner_id: ownerId } }) : null;
    if (moduleId && moduleId !== defaultStudioModuleId(ownerId) && !workspace) throw new StudioError('模块不存在或无权使用', 403);
    const reproduceFromTaskId = input.reproduceFromTaskId || (!input.draft ? workspace?.reproduce_task_id : undefined);
    let sourcePresetId = workspace?.source_preset_id || null;
    if (reproduceFromTaskId) sourcePresetId = null;
    let sourcePresetOwnerId: string | null = null;
    if (workspace?.source_preset_id) {
      const source = await tx.imageStudioPreset.findUnique({ where: { id: workspace.source_preset_id }, select: { owner_id: true, scope: true, is_shared: true } });
      if (!reproduceFromTaskId && (!source || !canViewStudioPreset(identity, source))) throw new StudioError('该模板已停止共享，不能新建任务', 403);
      sourcePresetOwnerId = source?.owner_id || null;
    }
    const moduleContextEditable = user.role === 'admin' || !workspace?.source_preset_id || sourcePresetOwnerId === ownerId;
    const fixedReferencesEditable = user.role === 'admin' && (!workspace?.source_preset_id || sourcePresetOwnerId === ownerId);
    if (input.draft?.moduleContext !== undefined && !moduleContextEditable) throw new StudioError('共享模板的内部上下文只能由创建者修改', 403);
    if (input.draft?.fixedReferences !== undefined && !fixedReferencesEditable) throw new StudioError('固定模板图只能由管理员修改原模板', 403);
    if (input.draft?.globalContext !== undefined && user.role !== 'admin') throw new StudioError('通用上下文只能由管理员修改', 403);
    if (workspace && input.moduleRevision !== undefined && workspace.revision !== input.moduleRevision) throw new StudioError('模块已在其他页面更新，请刷新后核对', 409);
    const requestedModel = input.model || workspace?.model || settings.model;
    if (input.quality !== undefined && !(IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[requestedModel as keyof typeof IMAGE_STUDIO_MODEL_QUALITY_OPTIONS] as readonly string[] | undefined)?.includes(input.quality)) throw new StudioError('当前模型不支持所选图片质量');
    const generation = resolveStudioModuleGenerationConfig({ ...workspace, ...(input.model ? { model: input.model } : {}), ...(input.quality !== undefined ? { quality: input.quality } : {}) }, settings);
    const imageApi = await getImageGenerationSettingsForModel(generation.model, tx);
    if(avatar && (input.referenceIds.length ? !imageApi.supports_image_to_image : !imageApi.supports_text_to_image)) throw new StudioError('当前图片通道不支持本次文字或原图参考生成',409);
    if (!isStudioImageGenerationProvider(imageApi.provider) || !isImageGenerationApiReady(imageApi)) {
      throw new StudioError(generation.model.startsWith('gemini-') ? 'Banana 专用通道尚未配置，请管理员在后台 API 设置填写专用 Key' : '图片专用 API 尚未配置', 503);
    }
    const price = generation.prices[generation.model];
    if (price === null || !Number.isInteger(price) || price < 0 || price > 100000) throw new StudioError('管理员尚未设置当前模块的有效生成积分', 409);
    let snapshotGlobalContext = avatar ? '' : user.role === 'admin' && input.draft?.globalContext !== undefined ? input.draft.globalContext : settings.context;
    let snapshotModuleContext = input.draft?.moduleContext !== undefined ? input.draft.moduleContext : workspace?.context || '';
    let templateFixedReferences: StudioFixedReference[] = [];
    let styleGroupIds: string[] = [];
    let styleGroupSnapshot: StudioTaskStyleGroupSnapshot[] = [];
    let styleReferenceGroups: StudioTaskStyleReferenceGroup[] = [];
    let historicalReferenceOwners: Record<string, string> = {};
    const freshlySelectedStyleIds = new Set<string>();
    let historicalSnapshot: Record<string, unknown> | null = null;
    const referenceIds = input.referenceIds;
    if (reproduceFromTaskId) {
      const source = await tx.imageStudioTask.findFirst({ where: { id: reproduceFromTaskId, owner_id: ownerId }, select: { source_preset_id: true, snapshot_json: true } });
      if (!source?.snapshot_json) throw new StudioError('历史记录缺少可恢复上下文，请按当前模块重新生成', 409);
      try {
        const sourceSnapshot = JSON.parse(source.snapshot_json) as Record<string, unknown>;
        historicalSnapshot = sourceSnapshot;
        const historicalSourcePresetId = source.source_preset_id || (typeof sourceSnapshot.sourcePresetId === 'string' ? sourceSnapshot.sourcePresetId : null);
        if (historicalSourcePresetId) {
          const historicalSource = await tx.imageStudioPreset.findUnique({ where: { id: historicalSourcePresetId }, select: { owner_id: true, scope: true, is_shared: true } });
          if (!historicalSource || !canViewStudioPreset(identity, historicalSource)) throw new StudioError('该模板已停止共享，不能新建任务', 403);
          sourcePresetId = historicalSourcePresetId;
        }
        const configuredFixed = Array.isArray(sourceSnapshot.fixedReferenceImages)
            ? parseHistoricalFixedReferences(sourceSnapshot.fixedReferenceImages)
          : [];
        const configuredTemplateFixedCount = Math.max(0, Math.min(configuredFixed.length,
          Number.isInteger(sourceSnapshot.templateFixedCount) ? Number(sourceSnapshot.templateFixedCount) : configuredFixed.length));
        templateFixedReferences = configuredFixed.slice(0, configuredTemplateFixedCount);
        const historicalStyleReferences = configuredFixed.slice(configuredTemplateFixedCount);
        styleGroupIds = sourceSnapshot.styleGroupIds === undefined ? [] : parseStudioStyleIds(sourceSnapshot.styleGroupIds);
        if (Array.isArray(sourceSnapshot.styleGroups)) {
          styleGroupSnapshot = parseHistoricalStyleGroups(sourceSnapshot.styleGroups);
        } else {
          const styles = await resolveStudioStyleReferences(identity, styleGroupIds, tx);
          styleGroupSnapshot = styles.groups.map(group => {
            const note = (group as { note?: unknown }).note;
            return { id: group.id, name: group.name, revision: group.revision, referenceCount: group.references.length,
              ownerId: group.ownerId, ...(typeof note === 'string' ? { note } : {}) };
          });
        }
        let styleOffset = 0;
        for (const group of styleGroupSnapshot) {
          const references = historicalStyleReferences.slice(styleOffset, styleOffset + group.referenceCount);
          styleOffset += references.length;
          styleReferenceGroups.push({ ...group, references });
        }
        if (styleOffset < historicalStyleReferences.length) {
          const references = historicalStyleReferences.slice(styleOffset);
          styleReferenceGroups.push({ id: 'historical-style-references', name: '历史风格参考图', revision: 0, referenceCount: references.length, references });
        }
        if (input.draft?.styleGroupIds !== undefined) {
          styleGroupIds = input.draft.styleGroupIds;
          const selected = await resolveStudioStyleReferences(identity, styleGroupIds, tx);
          styleGroupSnapshot = selected.groups.map(group => ({ id: group.id, name: group.name, revision: group.revision,
            referenceCount: group.references.length, ownerId: group.ownerId, ...(group.note ? { note: group.note } : {}) }));
          styleReferenceGroups = selected.groups.map((group, index) => ({ ...styleGroupSnapshot[index], references: group.references }));
          for (const group of selected.groups) for (const reference of group.references) freshlySelectedStyleIds.add(reference.assetId);
        } else {
          // Keep historical notes and images, but recheck that their groups are still usable.
          await resolveStudioStyleReferences(identity, styleGroupIds, tx);
        }
        if (sourceSnapshot.authorizedReferenceOwners && typeof sourceSnapshot.authorizedReferenceOwners === 'object') {
          historicalReferenceOwners = Object.fromEntries(Object.entries(sourceSnapshot.authorizedReferenceOwners as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
        }
        if (typeof sourceSnapshot.globalContext !== 'string' || typeof sourceSnapshot.moduleContext !== 'string') {
          throw new StudioError('这条旧记录没有保存完整上下文，无法完整复现；请退出历史复现后使用当前设置', 409);
        }
        // Reproduction must use the recorded contexts, including deliberately empty ones.
        snapshotGlobalContext = sourceSnapshot.globalContext;
        snapshotModuleContext = sourceSnapshot.moduleContext;
      } catch (error) {
        if (error instanceof StudioError) throw error;
        if (error instanceof StudioStyleError) throw new StudioError(error.message, error.status);
        throw new StudioError('历史记录缺少可恢复上下文，请按当前模块重新生成', 409);
      }
    } else {
      if (workspace) templateFixedReferences = await getStudioModuleFixedReferences(ownerId, workspace.id, tx);
      if (!reproduceFromTaskId && input.draft?.fixedReferences !== undefined) {
        const requestedIds = input.draft.fixedReferences.map(reference => reference.assetId);
        const uniqueRequestedIds = Array.from(new Set(requestedIds));
        const authorizedOriginalIds = Array.from(new Set(templateFixedReferences.map(reference => reference.assetId)));
        const visibleOwned = await tx.asset.findMany({ where: { id: { in: uniqueRequestedIds }, owner_id: ownerId, status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(identity, tx)] }, select: { id: true } });
        const originalFixed = await tx.asset.findMany({ where: { id: { in: uniqueRequestedIds.filter(id => authorizedOriginalIds.includes(id)) }, status: 'active', type: 'image' }, select: { id: true } });
        const permittedIds = new Set([...visibleOwned, ...originalFixed].map(asset => asset.id));
        if (permittedIds.size !== uniqueRequestedIds.length) throw new StudioError('固定参考图不存在或无权使用', 403);
        templateFixedReferences = input.draft.fixedReferences;
      }
      try {
        styleGroupIds = input.draft?.styleGroupIds !== undefined
          ? input.draft.styleGroupIds
          : workspace ? await getStudioModuleStyleIds(ownerId, workspace.id, tx) : [];
        const styles = await resolveStudioStyleReferences(identity, styleGroupIds, tx);
        styleGroupSnapshot = styles.groups.map(group => {
          const note = (group as { note?: unknown }).note;
          return { id: group.id, name: group.name, revision: group.revision, referenceCount: group.references.length,
            ownerId: group.ownerId, ...(typeof note === 'string' ? { note } : {}) };
        });
        styleReferenceGroups = styles.groups.map(group => {
          const note = (group as { note?: unknown }).note;
          return { id: group.id, name: group.name, revision: group.revision, referenceCount: group.references.length,
            ownerId: group.ownerId, ...(typeof note === 'string' ? { note } : {}), references: group.references };
        });
      } catch (error) {
        if (error instanceof StudioStyleError) throw new StudioError(error.message, error.status);
        throw error;
      }
    }
    let referencePolicy: StudioReferencePolicy;
    if (avatar) referencePolicy = { ...defaultStudioReferencePolicy(referenceIds), primaryIds: avatar.candidates[0]?.baselineAssetId ? [avatar.candidates[0].baselineAssetId] : [], useFixedReferences: false };
    else if (input.draft?.referencePolicy) referencePolicy = input.draft.referencePolicy;
    else if (reproduceFromTaskId && historicalSnapshot?.referencePolicy !== undefined) {
      try { referencePolicy = mapStudioReferencePolicy(historicalSnapshot.referencePolicy, referenceIds); }
      catch { throw new StudioError('历史参考图角色设置无效，请按当前模块重新选择参考图', 409); }
    } else if (reproduceFromTaskId) {
      referencePolicy = defaultStudioReferencePolicy(referenceIds, workspace?.reference_limit);
    } else {
      try {
        referencePolicy = await getStudioModuleReferencePolicy(ownerId, typeof moduleId === 'string' ? moduleId : defaultStudioModuleId(ownerId), referenceIds, workspace?.reference_limit ?? DEFAULT_STUDIO_PRIMARY_MAX);
      } catch (error) {
        if (error instanceof StudioReferencePolicyError) throw new StudioError(error.message, error.status);
        throw error;
      }
    }
    const uniqueTransientIds = Array.from(new Set(referenceIds));
    const primaryIdSet = new Set(referencePolicy.primaryIds);
    const primaryReferenceIds = uniqueTransientIds.filter(id => primaryIdSet.has(id));
    const auxiliaryTransientIds = uniqueTransientIds.filter(id => !primaryIdSet.has(id));
    const includeTemplateFixed = referencePolicy.useFixedReferences;
    const actualTemplateFixedReferences = includeTemplateFixed ? templateFixedReferences : [];
    const actualStyleReferenceGroups = styleReferenceGroups;
    const actualFixedReferences = [...actualTemplateFixedReferences, ...actualStyleReferenceGroups.flatMap(group => group.references)];
    const auxiliaryCount = auxiliaryTransientIds.length + actualFixedReferences.length;
    try { validateStudioReferenceCounts(referencePolicy, referenceIds, templateFixedReferences.length, actualStyleReferenceGroups.reduce((total, group) => total + group.references.length, 0), true); }
    catch (error) { throw new StudioError((error as Error).message); }
    const baseContext = [snapshotGlobalContext.trim(), snapshotModuleContext.trim()].filter(Boolean).join('\n\n---\n模块上下文：\n');
    if (!input.prompt.trim() && !baseContext.trim() && primaryReferenceIds.length + auxiliaryCount === 0) throw new StudioError('请填写画面描述、上下文或添加参考图片');
    const referenceDescriptors: Array<{ id: string; role: 'primary' | 'transient-auxiliary' | 'template-fixed' | 'style-fixed'; label: string; note?: string; styleGroupId?: string }> = [];
    primaryReferenceIds.forEach((id, index) => referenceDescriptors.push({ id, role: 'primary', label: `主图 ${index + 1}（主图${'一二三四五六七八九十'[index]}，主要内容）` }));
    auxiliaryTransientIds.forEach((id, index) => referenceDescriptors.push({ id, role: 'transient-auxiliary', label: `辅助参考图 ${index + 1}` }));
    actualTemplateFixedReferences.forEach((reference, index) => referenceDescriptors.push({ id: reference.assetId, role: 'template-fixed', label: `模板${String.fromCharCode(65 + index)}（辅助参考）`, note: reference.note }));
    for (const group of actualStyleReferenceGroups) {
      group.references.forEach((reference, index) => referenceDescriptors.push({ id: reference.assetId, role: 'style-fixed', label: `风格组「${group.name}」图片 ${index + 1}（辅助参考）`, note: reference.note, styleGroupId: group.id }));
    }
    const orderedReferenceIds = referenceDescriptors.map(reference => reference.id);
    const actualFixedIds = Array.from(new Set(actualFixedReferences.map(reference => reference.assetId)));
    const referenceInstructions = referenceDescriptors.map((reference, index) =>
      `实际第 ${index + 1} 张：${reference.label}${reference.note !== undefined ? `；备注（JSON 字符串）：${JSON.stringify(reference.note)}` : ''}`
    ).join('\n');
    const styleNoteInstructions = actualStyleReferenceGroups.flatMap(group => {
      const note = group.note?.trim();
      const labels = referenceDescriptors.filter(reference => reference.styleGroupId === group.id).map(reference => reference.label);
      return note && labels.length ? [`风格组「${group.name}」备注（适用于${labels.join('、')}；仅作辅助指导，不替代主参考图主体）：${JSON.stringify(note)}`] : [];
    }).join('\n');
    const roleInstructions = primaryReferenceIds.length
      ? '主图承担画面主要内容，模板中未特别指定对象的主要处理要求默认指向主图。多张主图的具体分工以模板和本次要求为准，不默认融合，也不将后续主图降为辅助参考。普通参考、模板固定图和风格组仅提供明确指定的辅助信息，不得擅自用其中的主体替换主图主体。素材备注只约束对应素材的用途，不改变主图与辅助参考的角色。'
      : '本次没有主图，按文字要求生成。辅助参考仅提供指定的辅助信息，不自动将其中的主体当作生成主体。';
    const historicalEvolution = historicalSnapshot?.evolution;
    const evolutionRequest = input.evolution || (historicalEvolution ? parseEvolution({ direction: (historicalEvolution as { direction: string }).direction, manual: (historicalEvolution as { manual: boolean }).manual }) : undefined);
    const capability = evolutionCapability({ id: workspace?.id, context: snapshotModuleContext });
    if (evolutionRequest && !capability && !historicalEvolution) throw new StudioError('当前模板不支持演化方向');
    let evolution;
    try { if (evolutionRequest) evolution = resolveEvolution(evolutionRequest, input.prompt, capability || { version: 1, defaultDirection: 'increase' }); }
    catch (error) { throw new StudioError((error as Error).message); }
    const context = [baseContext.trim(), evolution ? evolutionInstructions(evolution) : '', referenceInstructions ? `${roleInstructions}\n\n参考图顺序与作用（编号与实际发送次序一致）：\n${referenceInstructions}` : '',
      styleNoteInstructions ? `风格组补充说明：\n${styleNoteInstructions}` : '']
      .filter(Boolean).join('\n\n---\n');
    const active = await tx.imageStudioTask.count({ where: { owner_id: ownerId, status: { in: ['queued', 'running'] } } });
    if (!preparation && active + input.count > 8) throw new StudioError('最多同时生成 8 张，请等待当前任务完成', 429);
    const visibleTransient = await tx.asset.count({ where: { id: { in: uniqueTransientIds }, owner_id: ownerId, status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(identity, tx)] } });
    if (visibleTransient !== uniqueTransientIds.length) throw new StudioError('本次参考图已不可用或无权查看', 403);
    const actualReferenceIds = Array.from(new Set(orderedReferenceIds));
    const references = await tx.asset.findMany({ where: { id: { in: actualReferenceIds }, status: 'active', type: 'image',
      OR: [{ owner_id: ownerId }, { id: { in: actualFixedIds } }] },
      select: { id: true, owner_id: true, original_url: true, thumbnail_url: true, file_name: true, mime_type: true, width: true, height: true, file_size: true, hash: true } });
    const referencesById = new Map(references.map(reference => [reference.id, reference]));
    if (orderedReferenceIds.some(id => !referencesById.has(id))) throw new StudioError('固定参考图或本次参考图已不可用，或当前账号无权使用', 403);
    if (reproduceFromTaskId && references.some(ref => actualFixedIds.includes(ref.id) && !freshlySelectedStyleIds.has(ref.id) && ref.owner_id !== (historicalReferenceOwners[ref.id] || ownerId))) throw new StudioError('历史参考图归属已变化，请重新选择风格组或模板', 403);
    const referenceSnapshot = referenceDescriptors.map(referenceDescriptor => {
      const id = referenceDescriptor.id;
      const reference = referencesById.get(id);
      return { id, originalUrl: reference ? studioTemplateAssetUrl(id) : null, thumbnailUrl: reference ? studioTemplateAssetUrl(id, true) : null,
        fileName: reference?.file_name || null, mimeType: reference?.mime_type || null, width: reference?.width || null,
        height: reference?.height || null, fileSize: reference?.file_size || null, hash: reference?.hash || null,
        referenceRole: referenceDescriptor.role,
        ...(referenceDescriptor.note !== undefined ? { note: referenceDescriptor.note } : {}) };
    });
    const fixedReferenceSnapshot = referenceSnapshot.filter(reference => reference.referenceRole === 'template-fixed' || reference.referenceRole === 'style-fixed');
    const transientReferenceSnapshot = referenceSnapshot.filter(reference => reference.referenceRole === 'primary' || reference.referenceRole === 'transient-auxiliary');
    const primaryReferenceSnapshot = referenceSnapshot.filter(reference => reference.referenceRole === 'primary');
    const auxiliaryReferenceSnapshot = referenceSnapshot.filter(reference => reference.referenceRole !== 'primary');
    const requestedAspectRatio = input.aspectRatio || 'auto';
    const firstReference = primaryReferenceIds.map(id => referencesById.get(id)).find(reference => reference?.width && reference?.height) || null;
    const ratioResolution = resolveStudioAspectRatio(requestedAspectRatio, firstReference);
    const aspectRatio = ratioResolution.requested;
    const resolvedAspectRatio = ratioResolution.resolved;
    const aspectRatioSource = ratioResolution.source;
    const ratioIssue = studioFourToOneIssue(resolvedAspectRatio, supportsStudioFourToOne(generation.model, imageApi.provider));
    if (ratioIssue) throw new StudioError(ratioIssue);
    const resolution = normalizeImageResolution(generation.model, input.resolution || generation.resolution, imageApi.provider);
    const outputSize = imageOutputSize(generation.model, resolution, resolvedAspectRatio, imageApi.provider);
    const moduleContextVersion = await bindModuleContextVersion(snapshotModuleContext, tx);
    const snapshot = JSON.stringify({
      version: 1,
      requestId: input.requestId, batchId, inputFingerprint: fingerprint,
      referenceImages: referenceSnapshot,
      fixedReferenceImages: fixedReferenceSnapshot,
      templateFixedCount: actualTemplateFixedReferences.length,
      primaryReferenceImages: primaryReferenceSnapshot,
      auxiliaryReferenceImages: auxiliaryReferenceSnapshot,
      styleGroupIds, styleGroups: styleGroupSnapshot,
      referencePolicy: { ...referencePolicy, primaryIds: primaryReferenceIds },
      authorizedReferenceOwners: Object.fromEntries(references.map(ref => [ref.id, ref.owner_id])),
      transientReferenceImages: transientReferenceSnapshot,
      globalContext: snapshotGlobalContext,
      moduleContext: snapshotModuleContext,
      moduleContextVersion, moduleContextVersionRule: MODULE_CONTEXT_VERSION_RULE,
      moduleId: workspace?.id || moduleId || null,
      sourcePresetId,
      reproducedFromTaskId: reproduceFromTaskId || null,
      moduleName: workspace?.name || null,
      prompt: input.prompt,
      ...(evolution ? { evolution } : {}),
      model: generation.model,
      quality: generation.quality,
      prices: generation.prices,
      unitCredits: price,
      count: input.count,
      aspectRatio,
      resolvedAspectRatio,
      aspectRatioSource,
      resolution,
      outputSize: outputSize || null,
      resolvedOutputSize: outputSize || null,
      outputFormat: 'png',
      settingsRevision: settings.revision,
        moduleRevision: workspace?.revision ?? null,
    });
    for (let i = 0; i < input.count; i++) {
      const id = `${batchId}-${i}`;
      const candidate = sheet ? undefined : avatar?.candidates[i];
      const taskPrompt = candidate?.prompt || input.prompt;
      const freeze = !preparation && price > 0 ? await allocateTaskCredits(tx, user, price, id) : null;
      const taskData: Prisma.ImageStudioTaskUncheckedCreateInput = {
        id, batch_id: batchId, owner_id: ownerId, module_id: moduleId as string | undefined, source_preset_id: sourcePresetId, ordinal: i + 1, fingerprint,
        prompt: taskPrompt, context, revision: settings.revision, model: generation.model,
        quality: generation.quality,
        provider_cost_usd: IMAGE_STUDIO_MODEL_COST_USD[generation.model as keyof typeof IMAGE_STUDIO_MODEL_COST_USD], snapshot_json: sheet ? JSON.stringify({ ...JSON.parse(snapshot), avatarLayout: avatar!.layout, avatar: { layout: avatar!.layout, cells: avatar!.candidates } }) : candidate ? JSON.stringify({ ...JSON.parse(snapshot), prompt: taskPrompt, avatar: candidate }) : snapshot,
        aspect_ratio: aspectRatio, output_size: outputSize,
        reference_ids: JSON.stringify(orderedReferenceIds), unit_credits: price, freeze_snapshot: freeze?.snapshot,
      };
      if (preparation) await preparation.save(tx, taskData);
      else await tx.imageStudioTask.create({ data: taskData });
      if (freeze) await tx.creditLedger.create({ data: {
        user_id: ownerId, type: 'task_freeze', amount: -price,
        balance_before: freeze.balance_before, balance_after: freeze.balance_after,
        frozen_before: freeze.frozen_before, frozen_after: freeze.frozen_after,
        related_task_id: id, idempotency_key: `image-studio:freeze:${id}`, reason: '图片生成冻结积分',
        metadata_json: JSON.stringify({ allocations: freeze.allocations }),
      } });
    }
    if (avatar?.onQueued) await avatar.onQueued(tx, batchId);
  }, { timeout: 15000 }));
  return batchId;
}

export async function finishStudioTask(task: ImageStudioTask, status: 'succeeded' | 'failed' | 'uncertain', data: { assetId?: string; preparedAsset?: Prisma.AssetUncheckedCreateInput; error?: string; usage?: unknown } = {}) {
  return prisma.$transaction(async tx => {
    const changed = await tx.imageStudioTask.updateMany({
      where: { id: task.id, status: 'running', lease_token: task.lease_token, lease_until: { gt: new Date() } },
      data: { status, asset_id: data.assetId, error: status === 'succeeded' ? null : data.error, usage_json: data.usage ? JSON.stringify(data.usage) : undefined,
        lease_until: null, lease_token: null, finished_at: new Date() },
    });
    if (!changed.count) return false;
    if (status === 'succeeded' && data.preparedAsset) {
      const prepared = data.preparedAsset;
      if (prepared.owner_id !== task.owner_id || !prepared.hash || prepared.type !== 'image') throw new Error('Output ownership mismatch');
      const asset = await tx.asset.upsert({ where: { owner_id_hash: { owner_id: task.owner_id, hash: prepared.hash } },
        create: prepared, update: { thumbnail_url: prepared.thumbnail_url, width: prepared.width, height: prepared.height } });
      if (asset.status !== 'active' || asset.mime_type !== 'image/png' || asset.original_url !== prepared.original_url
        || !asset.thumbnail_url || asset.width !== prepared.width || asset.height !== prepared.height) throw new Error('Output asset unavailable');
      await tx.imageStudioTask.update({ where: { id: task.id }, data: { asset_id: asset.id } });
    }
    if (task.unit_credits === 0) return true;
    const settlement = await settleTaskCredits(tx, { taskId: task.id, userId: task.owner_id,
      terminalStatus: status, frozenAmount: task.unit_credits, freezeSnapshot: task.freeze_snapshot });
    await tx.creditLedger.create({ data: {
      user_id: task.owner_id, type: status === 'succeeded' ? 'task_success_deduct' : 'task_failed_refund',
      amount: status === 'succeeded' ? -settlement.actualCost : settlement.refundedAmount,
      balance_before: settlement.balanceBefore, balance_after: settlement.balanceAfter,
      frozen_before: settlement.frozenBefore, frozen_after: settlement.frozenAfter,
      related_task_id: task.id, idempotency_key: `image-studio:settle:${task.id}`,
      reason: status === 'succeeded' ? '图片已保存，结算积分' : '图片未交付，释放冻结积分',
      metadata_json: JSON.stringify({ allocations: settlement.allocations, expired_closed: settlement.expiredClosedAmount }),
    } });
    return true;
  }, { timeout: 15000 });
}

export async function claimStudioTask() {
  const candidate = await prisma.imageStudioTask.findFirst({ where: { status: 'queued' }, orderBy: { created_at: 'asc' } });
  if (!candidate) return null;
  const leaseToken = randomUUID();
  const changed = await prisma.imageStudioTask.updateMany({ where: { id: candidate.id, status: 'queued' },
    data: { status: 'running', lease_token: leaseToken, lease_until: new Date(Date.now() + 10 * 60 * 1000) } });
  return changed.count ? { ...candidate, status: 'running', lease_token: leaseToken } : null;
}

export async function listStudioTasks(ownerId: string, cursor?: string, moduleId?: string, isAdmin = false, taskId?: string, requestId?: string) {
  if (moduleId && !validStudioModuleId(moduleId, ownerId)) throw new StudioError('模块编号无效');
  if (taskId !== undefined && (typeof taskId !== 'string' || !taskId || taskId.length > 120)) throw new StudioError('历史生成记录无效');
  if (requestId !== undefined && !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) throw new StudioError('提交编号无效');
  const where: Prisma.ImageStudioTaskWhereInput = { ...studioTemplateTaskWhere(ownerId, moduleId, taskId !== undefined || Boolean(requestId)),
    ...(requestId ? { batch_id: createHash('sha256').update(`${ownerId}:${requestId}`).digest('hex') } : {}) };
  const rows = taskId !== undefined
    ? await prisma.imageStudioTask.findFirst({ where: { ...where, id: taskId } }).then(task => task ? [task] : [])
    : await prisma.imageStudioTask.findMany({ where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 25,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
  const items = taskId !== undefined ? rows : rows.slice(0, 24);
  const outputAssetIds = items.flatMap(item => item.asset_id ? [item.asset_id] : []);
  const referenceIds = Array.from(new Set(items.flatMap(item => {
    try { return JSON.parse(item.reference_ids) as string[]; } catch { return []; }
  })));
  const assets = await prisma.asset.findMany({ where: { id: { in: [...outputAssetIds, ...referenceIds] }, ...(isAdmin ? {} : { owner_id: ownerId }), status: 'active' },
    select: { id: true, original_url: true, thumbnail_url: true, width: true, height: true, file_size: true } });
  const assetById = new Map(assets.map(asset => [asset.id, asset]));
  const owner = items.length ? await prisma.user.findUnique({ where: { id: ownerId },
    select: { id: true, name: true, username: true, avatar_url: true } }) : null;
  const publicOwner = owner ? { id: owner.id, name: displayUserName(owner), avatar_url: owner.avatar_url } : null;
  const deliveries = new Map(await Promise.all(items.map(async task => [task.id, await studioDeliveryStatus(task)] as const)));
  const contextVersions = new Map(await Promise.all(items.map(async task => [task.id, await snapshotModuleContextVersion(task.snapshot_json)] as const)));
  return { tasks: items.map(task => {
    const snapshot = publicStudioSnapshot(task, assetById, isAdmin, ownerId);
    return { id: task.id, batchId: task.batch_id, ordinal: task.ordinal,
      owner: publicOwner,
      delivery: deliveries.get(task.id),
      prompt: task.prompt, model: task.model, quality: task.quality, status: task.status, error: task.error, unitCredits: task.unit_credits,
      providerCostUsd: task.provider_cost_usd,
      aspectRatio: task.aspect_ratio, outputSize: task.output_size,
      createdAt: task.created_at, finishedAt: task.finished_at, referenceIds: snapshot.transientReferenceImages.map(image => image.id),
      snapshot: { ...snapshot, moduleContextVersion: contextVersions.get(task.id)?.code ?? null, moduleContextVersionState: contextVersions.get(task.id)?.state ?? 'missing' },
      asset: assetById.get(task.asset_id || '') ? { ...assetById.get(task.asset_id || '')!, original_url: studioAssetUrl(task.asset_id!), thumbnail_url: studioAssetUrl(task.asset_id!, true) } : null,
    };
  }), ...(taskId !== undefined ? {} : { nextCursor: rows.length > 24 ? items[items.length - 1].id : null }) };
}

export async function listAdminStudioTasks(cursor?: string, moduleId?: string, ownerId?: string) {
  const rows = await prisma.imageStudioTask.findMany({
    where: {
      ...(moduleId ? { module_id: moduleId } : {}),
      ...(ownerId ? { owner_id: ownerId } : {}),
    },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take: 25,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const assetIds = rows.flatMap(task => task.asset_id ? [task.asset_id] : []);
  const assets = assetIds.length
    ? await prisma.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, original_url: true, thumbnail_url: true, width: true, height: true, status: true } })
    : [];
  const ownerIds = Array.from(new Set(rows.map(task => task.owner_id)));
  const owners = ownerIds.length
    ? await prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true, username: true, email: true, avatar_url: true } })
    : [];
  const assetById = new Map(assets.map(asset => [asset.id, asset]));
  const ownerById = new Map(owners.map(owner => [owner.id, owner]));
  const items = rows.slice(0, 24).map(task => ({
    id: task.id,
    batchId: task.batch_id,
    ownerId: task.owner_id,
    owner: ownerById.get(task.owner_id) || null,
    moduleId: task.module_id,
    ordinal: task.ordinal,
    prompt: task.prompt,
    model: task.model,
    status: task.status,
    deletedAt: task.deleted_at,
    error: task.error,
    unitCredits: task.unit_credits,
    providerCostUsd: task.provider_cost_usd,
    aspectRatio: task.aspect_ratio,
    outputSize: task.output_size,
    createdAt: task.created_at,
    finishedAt: task.finished_at,
    asset: assetById.get(task.asset_id || '') || null,
  }));
  return { tasks: items, nextCursor: rows.length > 24 ? items[items.length - 1].id : null };
}

export function publicStudioSnapshot(task: Pick<ImageStudioTask, 'snapshot_json' | 'prompt' | 'model' | 'quality' | 'reference_ids' | 'aspect_ratio' | 'output_size'>, assets: Map<string, { id: string; original_url: string; thumbnail_url: string | null; width: number | null; height: number | null }>, isAdmin: boolean, viewerOwnerId?: string) {
  let parsed: Record<string, unknown> = {};
  try { parsed = task.snapshot_json ? JSON.parse(task.snapshot_json) as Record<string, unknown> : {}; } catch { parsed = {}; }
  const fallbackReferences = (() => {
    try { return (JSON.parse(task.reference_ids) as string[]).map(id => { const asset = assets.get(id); return { id, originalUrl: asset ? studioTemplateAssetUrl(id) : null, thumbnailUrl: asset ? studioTemplateAssetUrl(id, true) : null, width: asset?.width || null, height: asset?.height || null }; }); }
    catch { return []; }
  })();
  const snapshotReferences = Array.isArray(parsed.referenceImages) && parsed.referenceImages.length ? parsed.referenceImages : fallbackReferences;
  const snapshotFixedReferences = Array.isArray(parsed.fixedReferenceImages) ? parsed.fixedReferenceImages : [];
  const snapshotTransientReferences = Array.isArray(parsed.transientReferenceImages)
    ? parsed.transientReferenceImages
    : snapshotFixedReferences.length ? [] : snapshotReferences;
  const transientIds = snapshotTransientReferences.flatMap(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string' ? [(item as Record<string, unknown>).id as string] : []);
  let referencePolicy: StudioReferencePolicy;
  try {
    referencePolicy = parsed.referencePolicy === undefined
      ? defaultStudioReferencePolicy(transientIds)
      : mapStudioReferencePolicy(parsed.referencePolicy, transientIds);
  } catch {
    referencePolicy = defaultStudioReferencePolicy(transientIds);
  }
  const primaryIdSet = new Set(referencePolicy.primaryIds);
  const snapshotPrimaryReferences = Array.isArray(parsed.primaryReferenceImages)
    ? parsed.primaryReferenceImages.filter(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string' && primaryIdSet.has((item as Record<string, unknown>).id as string))
    : snapshotTransientReferences.filter(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string' && primaryIdSet.has((item as Record<string, unknown>).id as string));
  const snapshotTransientAuxiliaryReferences = snapshotTransientReferences.filter(item => {
    if (!item || typeof item !== 'object') return false;
    const record = item as Record<string, unknown>;
    return record.referenceRole === 'transient-auxiliary' || (record.referenceRole !== 'primary' && typeof record.id === 'string' && !primaryIdSet.has(record.id));
  });
  const snapshotAuxiliaryReferences = Array.isArray(parsed.auxiliaryReferenceImages)
    ? parsed.auxiliaryReferenceImages.filter(item => {
      if (!item || typeof item !== 'object') return false;
      const record = item as Record<string, unknown>;
      if (typeof record.id !== 'string') return false;
      return typeof record.referenceRole === 'string' ? record.referenceRole !== 'primary' : !primaryIdSet.has(record.id);
    })
    : snapshotReferences.filter(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string' && !primaryIdSet.has((item as Record<string, unknown>).id as string));
  const mapReference = (item: unknown) => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      if (typeof record.id !== 'string') return null;
      const asset = assets.get(record.id);
      return {
        id: record.id,
        originalUrl: asset ? studioTemplateAssetUrl(record.id) : null,
        thumbnailUrl: asset ? studioTemplateAssetUrl(record.id, true) : null,
        fileName: typeof record.fileName === 'string' ? record.fileName : null,
        mimeType: typeof record.mimeType === 'string' ? record.mimeType : null,
        width: typeof record.width === 'number' ? record.width : asset?.width || null,
        height: typeof record.height === 'number' ? record.height : asset?.height || null,
        fileSize: typeof record.fileSize === 'number' ? record.fileSize : null,
        hash: typeof record.hash === 'string' ? record.hash : null,
        ...(typeof record.note === 'string' ? { note: isAdmin ? record.note : '' } : {}),
        available: Boolean(asset),
      };
    };
  const referenceImages = (isAdmin ? snapshotReferences : snapshotTransientReferences).map(mapReference).filter((item): item is NonNullable<typeof item> => item !== null);
  const fixedReferenceImages = (isAdmin ? snapshotFixedReferences : []).map(mapReference).filter((item): item is NonNullable<typeof item> => item !== null);
  const transientReferenceImages = snapshotTransientReferences.map(mapReference).filter((item): item is NonNullable<typeof item> => item !== null);
  const primaryReferenceImages = snapshotPrimaryReferences.map(mapReference).filter((item): item is NonNullable<typeof item> => item !== null);
  const auxiliaryReferenceImages = (isAdmin ? snapshotAuxiliaryReferences : snapshotTransientAuxiliaryReferences).map(mapReference).filter((item): item is NonNullable<typeof item> => item !== null);
  const sourceAvailable = typeof task.snapshot_json === 'string' && task.snapshot_json.length > 0
    && ((typeof parsed.globalContext === 'string' && typeof parsed.moduleContext === 'string'
      && Boolean(String(parsed.globalContext).trim() || String(parsed.moduleContext).trim())) || snapshotReferences.length > 0 || Boolean(typeof parsed.prompt === 'string' ? parsed.prompt.trim() : task.prompt.trim()));
  const count = Number.isInteger(parsed.count) && Number(parsed.count) >= 1 && Number(parsed.count) <= 8 ? Number(parsed.count) : 1;
  const unitCredits = typeof parsed.unitCredits === 'number' && Number.isFinite(parsed.unitCredits) ? parsed.unitCredits : null;
  return {
    prompt: typeof parsed.prompt === 'string' ? parsed.prompt : task.prompt,
    evolution: parsed.evolution && typeof parsed.evolution === 'object' && ['increase', 'decrease'].includes(String((parsed.evolution as Record<string, unknown>).direction))
      ? { direction: (parsed.evolution as Record<string, unknown>).direction, manual: (parsed.evolution as Record<string, unknown>).manual === true } : null,
    model: typeof parsed.model === 'string' ? parsed.model : task.model,
    quality: typeof parsed.quality === 'string' ? parsed.quality : task.quality,
    count,
    aspectRatio: typeof parsed.aspectRatio === 'string' ? parsed.aspectRatio : task.aspect_ratio,
    resolvedAspectRatio: typeof parsed.resolvedAspectRatio === 'string' ? parsed.resolvedAspectRatio : task.aspect_ratio,
    aspectRatioSource: typeof parsed.aspectRatioSource === 'string' ? parsed.aspectRatioSource : 'model-default',
    resolution: typeof parsed.resolution === 'string' ? parsed.resolution : null,
    outputSize: typeof parsed.outputSize === 'string' ? parsed.outputSize : task.output_size,
    globalContext: isAdmin && typeof parsed.globalContext === 'string' ? parsed.globalContext : '',
    moduleContext: isAdmin && typeof parsed.moduleContext === 'string' ? parsed.moduleContext : '',
    unitCredits,
    sourceAvailable,
    contextAvailable: typeof parsed.globalContext === 'string' && typeof parsed.moduleContext === 'string',
    contextConfigured: Boolean((typeof parsed.globalContext === 'string' && parsed.globalContext.trim()) || (typeof parsed.moduleContext === 'string' && parsed.moduleContext.trim())),
    referenceImages,
    fixedReferenceImages,
    primaryReferenceImages,
    auxiliaryReferenceImages,
    referencePolicy,
    fixedReferenceCount: snapshotFixedReferences.length,
    templateFixedCount: typeof parsed.templateFixedCount === 'number' ? parsed.templateFixedCount : snapshotFixedReferences.length,
    styleGroupIds: Array.isArray(parsed.styleGroupIds) ? parsed.styleGroupIds.filter(id => typeof id === 'string') : [],
    styleGroups: Array.isArray(parsed.styleGroups) ? parsed.styleGroups.flatMap(value => {
      if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.name !== 'string') return [];
      const canViewNote = isAdmin || (typeof viewerOwnerId === 'string' && value.ownerId === viewerOwnerId);
      return [{ id: value.id, name: value.name, referenceCount: typeof value.referenceCount === 'number' ? value.referenceCount : 0,
        ...(canViewNote && typeof value.note === 'string' ? { note: value.note } : {}),
        coverUrl: `/api/image-studio/style-groups/${value.id}/cover`, canManage: false as const }];
    }) : [],
    transientReferenceImages,
  };
}

export async function deleteStudioResult(ownerId: string, id: unknown) {
  if (typeof id !== 'string' || id.length > 100 || !id) throw new StudioError('图片编号无效');
  const task = await prisma.imageStudioTask.findFirst({ where: { id, owner_id: ownerId } });
  if (!task) throw new StudioError('图片不存在或无权删除', 404);
  if (task.deleted_at) throw new StudioError('这条记录已经删除', 409);
  // Hide the result or failed record, not the shared asset or immutable billing/task history.
  await prisma.imageStudioTask.updateMany({ where: { id, owner_id: ownerId, deleted_at: null }, data: { deleted_at: new Date() } });
}
