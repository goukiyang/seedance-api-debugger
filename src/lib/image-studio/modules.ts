import { prisma } from '@/lib/prisma';
import { normalizeStudioRatio } from './ratios';
import { getImageStudioSettings, IMAGE_STUDIO_MODELS, type ImageStudioSettings } from './settings';
import { defaultImageStudioQuality, defaultImageResolution, normalizeImageStudioQuality, normalizeImageResolution, type ImageResolution } from './model-catalog';
import { DEFAULT_STUDIO_PRIMARY_MAX, MAX_REFERENCE_IMAGES } from './limits';
import { canViewStudioPreset, type ImageStudioIdentity, type StudioPresetAccessRow } from './access';
import { studioAssetUrl, studioTemplateAssetUrl } from './media';
import { getStudioModuleFixedReferences, parseStudioFixedReferences, removeStudioModuleFixedReferences, setStudioModuleFixedReferences, setStudioPresetFixedReferences, StudioFixedReferenceError } from './fixed-references';
import { getStudioModuleStyleIds, getStudioStyleGroup, parseStudioStyleIds, resolveStudioStyleReferences, setStudioModuleStyleIds, setStudioPresetStyleIds, studioStyleDTO, StudioStyleError } from './style-groups';
import { studioVisibleAssetWhere } from './protected-assets';
import { getStudioModuleReferencePolicy, parseStudioReferencePolicy, removeStudioModuleReferencePolicy, setStudioModuleReferencePolicy, setStudioPresetReferencePolicy, validateStudioReferenceCounts, StudioReferencePolicyError, type StudioReferencePolicy } from './reference-policy';

export const defaultStudioModuleId = (ownerId: string) => `default-${ownerId}`;
export class StudioModuleError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function validStudioModuleId(id: unknown, ownerId: string): id is string {
  return typeof id === 'string' && (id === defaultStudioModuleId(ownerId) || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));
}

export type StudioModuleGenerationConfig = {
  model: typeof IMAGE_STUDIO_MODELS[number];
  quality: import('./model-catalog').ImageStudioQuality;
  resolution: ImageResolution;
  prices: Record<typeof IMAGE_STUDIO_MODELS[number], number | null>;
};

export function resolveStudioModuleGenerationConfig(
  row: { model?: string | null; quality?: string | null; resolution?: string | null; prices_json?: string | null } | null | undefined,
  fallback: ImageStudioSettings,
): StudioModuleGenerationConfig {
  const model = row?.model && IMAGE_STUDIO_MODELS.includes(row.model as StudioModuleGenerationConfig['model'])
    ? row.model as StudioModuleGenerationConfig['model']
    : fallback.model;
  // Prices are global rules. Keep the legacy column readable for old records,
  // but never let a module override the shared administrator setting.
  return {
    model,
    quality: normalizeImageStudioQuality(model, row?.quality),
    resolution: normalizeImageResolution(model, row?.resolution || defaultImageResolution(model)),
    prices: { ...fallback.prices },
  };
}

type StudioModuleRow = {
  id: string; name: string; prompt: string; context: string; model?: string | null; quality?: string | null; group_name?: string | null; banner_asset_id?: string | null; prices_json?: string | null; reproduce_task_id?: string | null; source_preset_id?: string | null;
  count: number; reference_limit?: number; aspect_ratio?: string; resolution?: string | null; reference_ids: string[] | string; revision: number; created_at: Date; updated_at: Date;
};

async function moduleDTO(row: StudioModuleRow, ownerId: string, settings: ImageStudioSettings, saved = true, isAdmin = false, sourcePreset?: StudioPresetAccessRow & { id: string }, identity?: ImageStudioIdentity) {
  const ids = Array.isArray(row.reference_ids) ? row.reference_ids : JSON.parse(row.reference_ids) as string[];
  const protectedSource = !isAdmin && Boolean(row.source_preset_id) && sourcePreset?.owner_id !== ownerId;
  const fixedReferences = await getStudioModuleFixedReferences(ownerId, row.id);
  const user = identity || await prisma.user.findUniqueOrThrow({ where: { id: ownerId }, select: { id: true, role: true, account_type: true, feishu_user_id: true, feishu_open_id: true, feishu_union_id: true, feishu_tenant_key: true } });
  const styleGroupIds = await getStudioModuleStyleIds(ownerId, row.id);
  const styleGroups = await Promise.all(styleGroupIds.map(async id => {
    try { return await studioStyleDTO(user, await getStudioStyleGroup(user, id)); }
    catch (error) {
      if (error instanceof StudioStyleError && [404, 409].includes(error.status)) return { id, name: '风格组已删除', referenceCount: 0, canManage: false, coverUrl: null, unavailable: true };
      throw error;
    }
  }));
  let reproductionState: { fixedReferenceCount: number; styleGroups: Array<{ id: string; name: string; referenceCount: number; coverUrl: string; canManage: false }> } | null = null;
  if (row.reproduce_task_id) {
    const sourceTask = await prisma.imageStudioTask.findFirst({ where: { id: row.reproduce_task_id, owner_id: ownerId }, select: { snapshot_json: true } });
    try {
      const snapshot = JSON.parse(sourceTask?.snapshot_json || '{}');
      reproductionState = { fixedReferenceCount: Array.isArray(snapshot.fixedReferenceImages) ? snapshot.fixedReferenceImages.length : 0,
        styleGroups: Array.isArray(snapshot.styleGroups) ? snapshot.styleGroups.filter((group: { id?: unknown; name?: unknown }) => typeof group.id === 'string' && typeof group.name === 'string')
          .map((group: { id: string; name: string; referenceCount?: number }) => ({ id: group.id, name: group.name, referenceCount: Number(group.referenceCount) || 0, coverUrl: `/api/image-studio/style-groups/${group.id}/cover`, canManage: false })) : [] };
    } catch { reproductionState = null; }
  }
  const assetIds = [...ids, ...(isAdmin ? fixedReferences.map(reference => reference.assetId) : []), ...(row.banner_asset_id ? [row.banner_asset_id] : [])];
  const assets = await prisma.asset.findMany({ where: { id: { in: assetIds }, ...(isAdmin ? {} : { owner_id: ownerId }), status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(user)] },
    select: { id: true, original_url: true, thumbnail_url: true, width: true, height: true } });
  const generation = resolveStudioModuleGenerationConfig(row, settings);
  const quality = normalizeImageStudioQuality(generation.model, row.quality);
  const referenceLimit = Math.max(1, Math.min(MAX_REFERENCE_IMAGES, Number(row.reference_limit) || DEFAULT_STUDIO_PRIMARY_MAX));
  const visibleTransientIds = ids.filter(id => assets.some(asset => asset.id === id));
  let referencePolicy;
  try { referencePolicy = await getStudioModuleReferencePolicy(ownerId, row.id, visibleTransientIds, referenceLimit); }
  catch (error) {
    if (error instanceof StudioReferencePolicyError) throw new StudioModuleError(error.message, error.status);
    throw error;
  }
  const latestTask = row.id.startsWith('default-') ? null : await prisma.imageStudioTask.findFirst({
    where: { module_id: row.id, owner_id: ownerId, status: 'succeeded', deleted_at: null, asset_id: { not: null } },
    orderBy: { finished_at: 'desc' },
    select: { asset_id: true, snapshot_json: true },
  });
  const latestResult = latestTask?.asset_id
    ? await prisma.asset.findFirst({ where: { id: latestTask.asset_id, owner_id: ownerId, status: 'active', type: 'image' }, select: { id: true } })
    : null;
  let representativeReference: string | null = null;
  try {
    const parsed = latestTask?.snapshot_json ? JSON.parse(latestTask.snapshot_json) as {
      primaryReferenceImages?: Array<{ id?: unknown }>;
      transientReferenceImages?: Array<{ id?: unknown }>;
      referenceImages?: Array<{ id?: unknown }>;
    } : null;
    const representative = parsed?.primaryReferenceImages?.[0] ?? parsed?.transientReferenceImages?.[0] ?? parsed?.referenceImages?.[0];
    if (isAdmin && typeof representative?.id === 'string') representativeReference = studioTemplateAssetUrl(representative.id, true);
  } catch { representativeReference = null; }
  const banner = row.banner_asset_id ? assets.find(item => item.id === row.banner_asset_id) : null;
  return { id: row.id, name: row.name, prompt: row.prompt, count: row.count, referenceLimit, referencePolicy, aspectRatio: row.aspect_ratio || 'auto', resolution: generation.resolution, revision: row.revision, saved,
    model: generation.model, quality, groupName: row.group_name || '未分组', banner: banner ? { id: banner.id, originalUrl: studioTemplateAssetUrl(banner.id), thumbnailUrl: studioTemplateAssetUrl(banner.id, true), width: banner.width, height: banner.height } : null,
    cover: latestResult ? { resultUrl: studioAssetUrl(latestResult.id), thumbnailUrl: studioAssetUrl(latestResult.id, true), referenceUrl: representativeReference } : null,
    prices: generation.prices, unitCredits: generation.prices[generation.model],
    reproduceFromTaskId: row.reproduce_task_id || null, sourcePresetId: row.source_preset_id || null,
    sourcePresetShared: row.source_preset_id ? Boolean(sourcePreset && (sourcePreset.owner_id === ownerId || sourcePreset.is_shared)) : null,
    sourcePresetCanManageSharing: Boolean(sourcePreset && isAdmin && sourcePreset.scope === 'admin' && sourcePreset.owner_id === ownerId),
    contextEditable: !protectedSource,
    fixedReferencesEditable: isAdmin && (!sourcePreset || sourcePreset.owner_id === ownerId),
    fixedReferenceCount: fixedReferences.length,
    styleGroupIds, styleGroups, reproductionState,
    contextConfigured: Boolean(row.context.trim()), context: protectedSource ? '' : row.context,
    createdAt: row.created_at, updatedAt: row.updated_at,
    images: ids.flatMap(id => { const asset = assets.find(item => item.id === id); return asset ? [{ id, originalUrl: studioTemplateAssetUrl(id), thumbnailUrl: studioTemplateAssetUrl(id, true), width: asset.width, height: asset.height }] : []; }),
    fixedReferences: (isAdmin ? fixedReferences : []).map(reference => {
      const asset = assets.find(item => item.id === reference.assetId);
      const available = Boolean(asset);
      return { id: reference.assetId, originalUrl: available ? studioTemplateAssetUrl(reference.assetId) : null,
        thumbnailUrl: available ? studioTemplateAssetUrl(reference.assetId, true) : null,
        width: asset?.width || null, height: asset?.height || null, note: protectedSource ? '' : reference.note, available };
    }) };
}
export async function listStudioModules(ownerId: string, cursor?: string, isAdmin = false, requestedIds?: string[], identity?: ImageStudioIdentity) {
  const settings = await getImageStudioSettings();
  const defaultId = defaultStudioModuleId(ownerId);
  const rows = await prisma.imageStudioModule.findMany({ where: { owner_id: ownerId, id: { not: defaultId, ...(requestedIds ? { in: requestedIds } : {}) } },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: 13, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
  const includeDefault = !cursor && (!requestedIds || requestedIds.includes(defaultId));
  const defaultRow = includeDefault ? await prisma.imageStudioModule.findFirst({ where: { id: defaultId, owner_id: ownerId } }) : null;
  const sourceIds = [...rows, ...(defaultRow ? [defaultRow] : [])].map(row => row.source_preset_id).filter((id): id is string => Boolean(id));
  const sourceRows = sourceIds.length ? await prisma.imageStudioPreset.findMany({ where: { id: { in: sourceIds } }, select: { id: true, owner_id: true, scope: true, is_shared: true } }) : [];
  const sourceById = new Map(sourceRows.map(row => [row.id, row]));
  // Keep an old personal copy visible after sharing is turned off so its
  // already-submitted results remain discoverable. The task transaction is
  // the authoritative check for whether a new generation may start.
  const visible = rows.slice(0, 12);
  const modules = await Promise.all(visible.map(row => moduleDTO(row, ownerId, settings, true, isAdmin, row.source_preset_id ? sourceById.get(row.source_preset_id) : undefined, identity)));
  if (includeDefault) {
    modules.unshift(await moduleDTO(defaultRow || { id: defaultId, name: '模块 1', prompt: '', context: '', count: 1, reference_limit: DEFAULT_STUDIO_PRIMARY_MAX, reference_ids: [], revision: 0, created_at: new Date(0), updated_at: new Date(0) }, ownerId, settings, Boolean(defaultRow), isAdmin, defaultRow?.source_preset_id ? sourceById.get(defaultRow.source_preset_id) : undefined, identity));
  }
  // Navigation must describe all saved modules, not just the first content page.
  const directory = !cursor && !requestedIds ? await prisma.imageStudioModule.findMany({
    where: { owner_id: ownerId }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, group_name: true },
  }) : undefined;
  return { modules, nextCursor: rows.length > 12 ? visible[visible.length - 1].id : null,
    ...(directory ? { directory: [
      ...(directory.some(item => item.id === defaultId) ? [] : [{ id: defaultId, name: '模块 1', groupName: '未分组' }]),
      ...directory.map(item => ({ id: item.id, name: item.name, groupName: item.group_name || '未分组' })),
    ] } : {}) };
}
export async function deleteStudioModule(ownerId: string, id: unknown, revision: unknown) {
  if (!validStudioModuleId(id, ownerId) || !Number.isInteger(revision)) throw new StudioModuleError('模板参数无效');
  if (id === defaultStudioModuleId(ownerId)) throw new StudioModuleError('默认模板需要保留，请删除其他模板');
  await prisma.$transaction(async tx => {
    const current = await tx.imageStudioModule.findFirst({ where: { id, owner_id: ownerId } });
    if (!current) return;
    if (current.revision !== revision) throw new StudioModuleError('模板已更新，请刷新后再删除', 409);
    const pending = await tx.imageStudioTask.count({ where: { owner_id: ownerId, module_id: id, status: { in: ['queued', 'running'] } } });
    if (pending) throw new StudioModuleError('模板还有生成中的任务，请完成后再删除', 409);
    // Tasks and assets have independent ownership and remain available in assets.
    await removeStudioModuleFixedReferences(ownerId, id, tx);
    await tx.platformSetting.deleteMany({ where: { key: `studio_style_selection_v1:${id}` } });
    await removeStudioModuleReferencePolicy(ownerId, id, tx);
    await tx.imageStudioModule.deleteMany({ where: { id, owner_id: ownerId, revision: current.revision } });
  });
}

export async function saveStudioModule(ownerId: string, body: Record<string, unknown>, createOnly = false, isAdmin = false, forcedSourcePresetId?: string, sourceIdentity?: ImageStudioIdentity) {
  if (!body || !validStudioModuleId(body.id, ownerId)) throw new StudioModuleError('模块编号无效');
  const id = body.id;
  let aspectRatio: string | undefined;
  try { if (body.aspectRatio !== undefined) aspectRatio = normalizeStudioRatio(body.aspectRatio); }
  catch (error) { throw new StudioModuleError((error as Error).message); }
  if (body.context !== undefined && (typeof body.context !== 'string' || body.context.length > 20000)) throw new StudioModuleError('模块上下文最多 20000 字');
  const model = body.model === undefined ? undefined : body.model;
  if (model !== undefined && !IMAGE_STUDIO_MODELS.includes(model as typeof IMAGE_STUDIO_MODELS[number])) {
    throw new StudioModuleError('模块模型无效');
  }
  const quality = body.quality === undefined ? undefined : body.quality;
  if (quality !== undefined && typeof quality !== 'string') throw new StudioModuleError('图片质量设置无效');
  const groupName = body.groupName === undefined ? undefined : body.groupName;
  if (groupName !== undefined && (typeof groupName !== 'string' || groupName.trim().length > 40)) throw new StudioModuleError('模块分组名称最多 40 字');
  const bannerAssetId = body.bannerAssetId === undefined ? undefined : body.bannerAssetId;
  if (bannerAssetId !== undefined && bannerAssetId !== null && (typeof bannerAssetId !== 'string' || bannerAssetId.length > 100)) throw new StudioModuleError('模块 banner 图片无效');
  const reproduceFromTaskId = body.reproduceFromTaskId === undefined ? undefined : body.reproduceFromTaskId;
  if (reproduceFromTaskId !== undefined && reproduceFromTaskId !== null
    && (typeof reproduceFromTaskId !== 'string' || reproduceFromTaskId.length > 120)) throw new StudioModuleError('历史生成记录无效');
  const name = createOnly ? '未命名模块' : body.name;
  const prompt = createOnly ? '' : body.prompt;
  const count = createOnly ? 1 : body.count;
  const ids = createOnly ? [] : body.referenceIds;
  if (!Array.isArray(ids) || ids.length > MAX_REFERENCE_IMAGES || ids.some(item => typeof item !== 'string' || !item || item.length > 100)) throw new StudioModuleError(`模块内容无效，请检查名称、张数和参考图片（最多 ${MAX_REFERENCE_IMAGES} 张）`);
  let referencePolicy: StudioReferencePolicy | undefined;
  if (!createOnly && body.referencePolicy !== undefined) {
    try { referencePolicy = parseStudioReferencePolicy(body.referencePolicy, ids as string[]); }
    catch (error) {
      if (error instanceof StudioReferencePolicyError) throw new StudioModuleError(error.message, error.status);
      throw error;
    }
  }
  const savedModuleLimit = !createOnly && body.referenceLimit === undefined && !referencePolicy
    ? await prisma.imageStudioModule.findFirst({ where: { id, owner_id: ownerId }, select: { reference_limit: true } })
    : null;
  const referenceLimitValue = createOnly ? DEFAULT_STUDIO_PRIMARY_MAX
    : body.referenceLimit !== undefined ? body.referenceLimit
      : referencePolicy?.primaryMax ?? savedModuleLimit?.reference_limit ?? DEFAULT_STUDIO_PRIMARY_MAX;
  const referenceLimit = Number(referenceLimitValue);
  let fixedReferences: ReturnType<typeof parseStudioFixedReferences> | undefined;
  if (body.fixedReferences !== undefined) {
    if (!isAdmin) throw new StudioModuleError('固定模板图只能由管理员修改', 403);
    try { fixedReferences = parseStudioFixedReferences(body.fixedReferences); }
    catch (error) { throw new StudioModuleError((error as Error).message); }
  }
  const revision = createOnly ? 0 : body.revision;
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || typeof prompt !== 'string' || prompt.length > 20000
    || !Number.isInteger(count) || Number(count) < 1 || Number(count) > 8 || !Number.isInteger(referenceLimit) || referenceLimit < 1 || referenceLimit > MAX_REFERENCE_IMAGES
    || !Number.isInteger(revision) || Number(revision) < 0) throw new StudioModuleError(`模块内容无效，请检查名称、张数和参考图片（最多 ${MAX_REFERENCE_IMAGES} 张）`);
  if (!referencePolicy && (ids as string[]).length > referenceLimit) {
    throw new StudioModuleError(`旧版保存请求最多支持 ${referenceLimit} 张参考图`);
  }
  const row = await prisma.$transaction(async tx => {
    const identity = sourceIdentity || await tx.user.findUniqueOrThrow({ where: { id: ownerId }, select: { id: true, role: true, account_type: true, feishu_user_id: true, feishu_open_id: true, feishu_union_id: true, feishu_tenant_key: true } });
    const current = await tx.imageStudioModule.findUnique({ where: { id } });
    if (current && current.owner_id !== ownerId) throw new StudioModuleError('无权修改这个模块', 403);
    if (current && createOnly) return current;
    if ((current?.revision || 0) !== revision) throw new StudioModuleError('模块已在其他页面保存，请刷新后核对；当前草稿仍在本页', 409);
    if (current?.source_preset_id && fixedReferences !== undefined) {
      const source = await tx.imageStudioPreset.findUnique({ where: { id: current.source_preset_id }, select: { owner_id: true } });
      if (source?.owner_id !== ownerId) throw new StudioModuleError('共享模板固定图由原模板管理，不能在副本中修改', 403);
    }
    let protectedSource = false;
    if (current?.source_preset_id && !isAdmin) {
      const source = await tx.imageStudioPreset.findUnique({ where: { id: current.source_preset_id }, select: { owner_id: true } });
      protectedSource = !source || source.owner_id !== ownerId;
      if (protectedSource) {
        const currentFixedReferences = fixedReferences === undefined ? [] : await getStudioModuleFixedReferences(ownerId, id, tx);
        const contextMatches = body.context === undefined || body.context === current.context;
        const fixedReferencesMatch = fixedReferences === undefined || (fixedReferences.length === currentFixedReferences.length
          && fixedReferences.every((reference, index) => reference.assetId === currentFixedReferences[index].assetId && reference.note === currentFixedReferences[index].note));
        if (!contextMatches || !fixedReferencesMatch) throw new StudioModuleError('共享模板的内部上下文和固定参考图只能由创建者修改', 403);
        fixedReferences = undefined;
      }
    }
    const assets = await tx.asset.count({ where: { id: { in: ids as string[] }, owner_id: ownerId, type: 'image', status: 'active', AND: [await studioVisibleAssetWhere(identity, tx)] } });
    if (assets !== new Set(ids as string[]).size) throw new StudioModuleError('参考图片已不可用或无权使用', 403);
    if (reproduceFromTaskId) {
      const source = await tx.imageStudioTask.findFirst({ where: { id: reproduceFromTaskId, owner_id: ownerId, snapshot_json: { not: null } }, select: { id: true } });
      if (!source) throw new StudioModuleError('历史生成记录不存在或无权复现', 403);
    }
    const selectedModel = model || current?.model || (await getImageStudioSettings()).model;
    const selectedQuality = quality !== undefined
      ? normalizeImageStudioQuality(String(selectedModel), String(quality))
      : createOnly
        ? defaultImageStudioQuality(String(selectedModel))
        : normalizeImageStudioQuality(String(selectedModel), current?.quality);
    const selectedResolution = normalizeImageResolution(String(selectedModel), body.resolution !== undefined ? body.resolution : current?.resolution);
    const data = { name: name.trim(), prompt, count: Number(count), reference_limit: referenceLimit, reference_ids: JSON.stringify(ids), revision: Number(revision) + 1,
      ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
      ...(model !== undefined ? { model: model as string } : {}),
      quality: selectedQuality, resolution: selectedResolution,
      ...(groupName !== undefined ? { group_name: groupName.trim() || '未分组' } : {}),
      ...(bannerAssetId !== undefined ? { banner_asset_id: bannerAssetId } : {}),
      ...(reproduceFromTaskId !== undefined ? { reproduce_task_id: reproduceFromTaskId } : {}),
      ...(forcedSourcePresetId !== undefined ? { source_preset_id: forcedSourcePresetId } : {}),
      ...(typeof body.context === 'string' && !protectedSource ? { context: body.context } : {}) };
    if (bannerAssetId) {
      const banner = await tx.asset.findFirst({ where: { id: bannerAssetId, owner_id: ownerId, type: 'image', status: 'active' }, select: { id: true } });
      if (!banner) throw new StudioModuleError('banner 图片不存在或无权使用', 403);
    }
    if (forcedSourcePresetId) {
      const source = await tx.imageStudioPreset.findUnique({ where: { id: forcedSourcePresetId }, select: { id: true, owner_id: true, scope: true, is_shared: true } });
      const sourceUser = sourceIdentity || { id: ownerId, role: isAdmin ? 'admin' : 'user', account_type: 'internal', feishu: null } as const;
      if (!source || !canViewStudioPreset(sourceUser, source)) throw new StudioModuleError('模板已停止共享，不能保存新的配置', 403);
    }
    const saved = !current
      ? await tx.imageStudioModule.create({ data: { id, owner_id: ownerId, ...data } })
      : await (async () => {
        const changed = await tx.imageStudioModule.updateMany({ where: { id, owner_id: ownerId, revision: Number(revision) }, data });
        if (!changed.count) throw new StudioModuleError('模块已在其他页面保存，请刷新后核对', 409);
        return tx.imageStudioModule.findUniqueOrThrow({ where: { id } });
      })();
    if (fixedReferences) {
      try { await setStudioModuleFixedReferences(ownerId, id, fixedReferences, tx); }
      catch (error) {
        if (error instanceof StudioFixedReferenceError) throw new StudioModuleError(error.message, error.status);
        throw error;
      }
    }
    if (referencePolicy) {
      try { await setStudioModuleReferencePolicy(ownerId, id, referencePolicy, ids as string[], tx); }
      catch (error) {
        if (error instanceof StudioReferencePolicyError) throw new StudioModuleError(error.message, error.status);
        throw error;
      }
    }
    try {
      if (body.styleGroupIds !== undefined) await setStudioModuleStyleIds(identity, id, body.styleGroupIds, tx);
      const selectedIds = body.styleGroupIds === undefined ? await getStudioModuleStyleIds(ownerId, id, tx) : parseStudioStyleIds(body.styleGroupIds);
      const selected = await resolveStudioStyleReferences(identity, selectedIds, tx);
      const fixed = await getStudioModuleFixedReferences(ownerId, id, tx);
      const effectivePolicy = referencePolicy || await getStudioModuleReferencePolicy(ownerId, id, ids as string[], referenceLimit, tx);
      validateStudioReferenceCounts(effectivePolicy, ids as string[], fixed.length, selected.references.length);
    } catch (error) {
      if (error instanceof StudioStyleError || error instanceof StudioReferencePolicyError) throw new StudioModuleError(error.message, error.status);
      throw error;
    }
    // An administrator's bound module is the canonical source for the shared
    // preset. Personal copies created from that preset stay independent.
    if (isAdmin && current?.source_preset_id) {
      const source = await tx.imageStudioPreset.findUnique({ where: { id: current.source_preset_id }, select: { owner_id: true, scope: true } });
      if (source?.owner_id === ownerId && source.scope === 'admin') {
        await tx.imageStudioPreset.update({ where: { id: current.source_preset_id }, data: {
          name: saved.name, group_name: saved.group_name, prompt: saved.prompt, context: saved.context,
          model: saved.model || 'gemini-3.1-flash-image-preview', quality: saved.quality, resolution: saved.resolution, count: saved.count,
          reference_limit: saved.reference_limit, aspect_ratio: saved.aspect_ratio,
          banner_asset_id: saved.banner_asset_id, reference_ids: saved.reference_ids,
        } });
        if (fixedReferences) {
          try { await setStudioPresetFixedReferences(ownerId, current.source_preset_id, fixedReferences, tx); }
          catch (error) {
            if (error instanceof StudioFixedReferenceError) throw new StudioModuleError(error.message, error.status);
            throw error;
          }
        }
        if (referencePolicy) {
          try { await setStudioPresetReferencePolicy(ownerId, current.source_preset_id, referencePolicy, ids as string[], tx); }
          catch (error) {
            if (error instanceof StudioReferencePolicyError) throw new StudioModuleError(error.message, error.status);
            throw error;
          }
        }
        if (body.styleGroupIds !== undefined) await setStudioPresetStyleIds(identity, current.source_preset_id, body.styleGroupIds, tx);
      }
    }
    return saved;
  }, { timeout: 15000 });
  const source = row.source_preset_id ? await prisma.imageStudioPreset.findUnique({ where: { id: row.source_preset_id }, select: { id: true, owner_id: true, scope: true, is_shared: true } }) : undefined;
  return moduleDTO(row, ownerId, await getImageStudioSettings(), true, isAdmin, source || undefined, sourceIdentity);
}
