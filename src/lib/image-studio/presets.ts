import { randomUUID } from 'crypto';
import { prisma } from '@/lib/prisma';
import { DEFAULT_STUDIO_PRIMARY_MAX, MAX_REFERENCE_IMAGES } from './limits';
import { IMAGE_STUDIO_MODELS, defaultImageResolution, normalizeImageStudioQuality, normalizeImageResolution } from './model-catalog';
import { normalizeStudioRatio } from './ratios';
import { saveStudioModule, StudioModuleError, validStudioModuleId } from './modules';
import { canManageStudioPreset, canUseCompanyTemplates as canUseCompanyTemplatesForUser, canViewStudioPreset, type ImageStudioIdentity } from './access';
import { studioTemplateAssetUrl } from './media';
import { getStudioModuleFixedReferences, getStudioPresetsFixedReferences, getStudioPresetFixedReferences, parseStudioFixedReferences, setStudioPresetFixedReferences, type StudioFixedReference } from './fixed-references';
import { studioVisibleAssetWhere } from './protected-assets';
import { getStudioModuleStyleIds, parseStudioStyleIds, resolveStudioStyleReferences, setStudioPresetStyleIds } from './style-groups';
import { defaultStudioReferencePolicy, getStudioPresetReferencePolicy, parseStudioReferencePolicy, setStudioPresetReferencePolicy, validateStudioReferenceCounts, StudioReferencePolicyError, type StudioReferencePolicy } from './reference-policy';

export { canUseCompanyTemplatesForUser as canUseCompanyTemplates };

type PresetDraft = {
  scope?: unknown; name?: unknown; groupName?: unknown; prompt?: unknown; context?: unknown;
  model?: unknown; quality?: unknown; resolution?: unknown; count?: unknown; aspectRatio?: unknown;
  bannerAssetId?: unknown; referenceIds?: unknown; referenceLimit?: unknown; sourceModuleId?: unknown; fixedReferences?: unknown;
  styleGroupIds?: unknown; referencePolicy?: unknown;
};

function parseIds(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_REFERENCE_IMAGES || value.some(item => typeof item !== 'string' || !item)) {
    throw new StudioModuleError(`模板参考图片无效（最多 ${MAX_REFERENCE_IMAGES} 张）`);
  }
  return value as string[];
}

function parsePreset(row: { reference_ids: string }) {
  try { return parseIds(JSON.parse(row.reference_ids)); } catch { return []; }
}

export async function listStudioPresets(user: ImageStudioIdentity) {
  const rows = await prisma.imageStudioPreset.findMany({
    where: { OR: [{ owner_id: user.id }, { is_shared: true }] },
    orderBy: [{ scope: 'asc' }, { updated_at: 'desc' }],
  });
  const visibleRows = rows.filter(row => canViewStudioPreset(user, row));
  const fixedByPreset = await getStudioPresetsFixedReferences(user, visibleRows);
  const referencePolicies = await Promise.all(visibleRows.map(async row => [row.id, await getStudioPresetReferencePolicy(row.owner_id, row.id, parsePreset(row), row.reference_limit)] as const));
  const policyByPreset = new Map(referencePolicies);
  const assetIds = visibleRows.flatMap(row => [...parsePreset(row), ...(fixedByPreset.get(row.id) || []).map(reference => reference.assetId)]);
  const bannerIds = visibleRows.map(row => row.banner_asset_id).filter((id): id is string => Boolean(id));
  const assets = await prisma.asset.findMany({ where: { id: { in: Array.from(new Set([...assetIds, ...bannerIds])) }, status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(user)] }, select: { id: true, owner_id: true, original_url: true, thumbnail_url: true, width: true, height: true } });
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  return visibleRows.map(row => {
    const ids = parsePreset(row);
    const visibleIds = ids.filter(id => {
      const asset = byId.get(id);
      return Boolean(asset && asset.owner_id === row.owner_id);
    });
    const storedPolicy = policyByPreset.get(row.id);
    const referencePolicy = storedPolicy
      ? { ...storedPolicy, primaryIds: storedPolicy.primaryIds.filter(id => visibleIds.includes(id)) }
      : undefined;
    const canSeeContext = user.role === 'admin' || row.owner_id === user.id;
    const toPayload = (id: string) => {
      const asset = byId.get(id);
      if (!asset || asset.owner_id !== row.owner_id) return null;
      return { id, originalUrl: studioTemplateAssetUrl(id), thumbnailUrl: studioTemplateAssetUrl(id, true), width: asset.width, height: asset.height };
    };
    return {
      id: row.id, name: row.name, scope: row.scope, groupName: row.group_name, prompt: row.prompt, context: canSeeContext ? row.context : '', revision: row.updated_at.toISOString(),
      isShared: row.is_shared,
      canManageSharing: canManageStudioPreset(user, row),
      model: row.model, quality: normalizeImageStudioQuality(row.model, row.quality), resolution: normalizeImageResolution(row.model, row.resolution || defaultImageResolution(row.model)), count: row.count, referenceLimit: Math.max(1, Math.min(MAX_REFERENCE_IMAGES, Number(row.reference_limit) || DEFAULT_STUDIO_PRIMARY_MAX)), referencePolicy,
      aspectRatio: row.aspect_ratio, contextConfigured: Boolean(row.context.trim()),
      images: ids.map(toPayload).filter((item): item is NonNullable<ReturnType<typeof toPayload>> => Boolean(item)),
      fixedReferenceCount: (fixedByPreset.get(row.id) || []).length,
      fixedReferences: (user.role === 'admin' ? fixedByPreset.get(row.id) || [] : []).map(reference => {
        const asset = byId.get(reference.assetId);
        const available = Boolean(asset && asset.owner_id === row.owner_id);
        return { id: reference.assetId, originalUrl: available ? studioTemplateAssetUrl(reference.assetId) : null,
          thumbnailUrl: available ? studioTemplateAssetUrl(reference.assetId, true) : null,
          width: available ? asset?.width ?? null : null, height: available ? asset?.height ?? null : null,
          note: canSeeContext ? reference.note : '', available };
      }),
      banner: row.banner_asset_id ? toPayload(row.banner_asset_id) : null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  });
}

export async function saveStudioPreset(user: ImageStudioIdentity, body: PresetDraft) {
  if (!canUseCompanyTemplatesForUser(user)) throw new StudioModuleError('仅限公司飞书账号使用共享模板', 403);
  const userId = user.id;
  const isAdmin = user.role === 'admin';
  const scope = body.scope === 'admin' ? 'admin' : body.scope === 'creator' ? 'creator' : '';
  if (!scope || (scope === 'admin' && !isAdmin)) throw new StudioModuleError('没有保存该模板类型的权限', 403);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const groupName = typeof body.groupName === 'string' ? body.groupName.trim() || '未分组' : '未分组';
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  const context = typeof body.context === 'string' ? body.context : '';
  const model = typeof body.model === 'string' && IMAGE_STUDIO_MODELS.includes(body.model as never) ? body.model : '';
  const count = Number(body.count);
  const ids = parseIds(body.referenceIds);
  let referencePolicy: StudioReferencePolicy | undefined;
  if (body.referencePolicy !== undefined) {
    try { referencePolicy = parseStudioReferencePolicy(body.referencePolicy, ids); }
    catch (error) {
      if (error instanceof StudioReferencePolicyError) throw new StudioModuleError(error.message, error.status);
      throw error;
    }
  }
  const referenceLimit = body.referenceLimit === undefined
    ? referencePolicy?.primaryMax ?? DEFAULT_STUDIO_PRIMARY_MAX
    : Number(body.referenceLimit);
  let fixedReferences: StudioFixedReference[] | undefined;
  if (body.fixedReferences !== undefined) {
    if (!isAdmin) throw new StudioModuleError('固定模板图只能由管理员修改', 403);
    try { fixedReferences = parseStudioFixedReferences(body.fixedReferences); }
    catch (error) { throw new StudioModuleError((error as Error).message); }
  }
  if (!name || name.length > 80 || prompt.length > 20000 || context.length > 20000 || groupName.length > 40 || !model || !Number.isInteger(count) || count < 1 || count > 8 || !Number.isInteger(referenceLimit) || referenceLimit < 1 || referenceLimit > MAX_REFERENCE_IMAGES || ids.length > MAX_REFERENCE_IMAGES) throw new StudioModuleError('模板内容无效');
  if (!referencePolicy && ids.length > referenceLimit) {
    throw new StudioModuleError(`旧版保存请求最多支持 ${referenceLimit} 张参考图`);
  }
  const aspectRatio = normalizeStudioRatio(body.aspectRatio);
  const quality = normalizeImageStudioQuality(model, body.quality);
  const resolution = normalizeImageResolution(model, body.resolution || defaultImageResolution(model));
  const bannerAssetId = body.bannerAssetId == null ? null : String(body.bannerAssetId);
  const sourceModuleId = body.sourceModuleId == null ? null : String(body.sourceModuleId);
  if (sourceModuleId && (!isAdmin || !validStudioModuleId(sourceModuleId, userId))) throw new StudioModuleError('模板来源模块无效', 403);
  return prisma.$transaction(async tx => {
    if (sourceModuleId) {
      const sourceModule = await tx.imageStudioModule.findFirst({ where: { id: sourceModuleId, owner_id: userId }, select: { id: true } });
      if (!sourceModule) throw new StudioModuleError('模板来源模块不存在或无权使用', 403);
    }
    const presetFixedReferences = fixedReferences === undefined
      ? sourceModuleId ? await getStudioModuleFixedReferences(userId, sourceModuleId, tx) : []
      : fixedReferences;
    const styleIds = body.styleGroupIds === undefined ? [] : parseStudioStyleIds(body.styleGroupIds);
    const styles = await resolveStudioStyleReferences(user, styleIds, tx);
    try { validateStudioReferenceCounts(referencePolicy || defaultStudioReferencePolicy(ids, referenceLimit), ids, presetFixedReferences.length, styles.references.length); }
    catch (error) { throw new StudioModuleError((error as Error).message); }
    const assetIds = Array.from(new Set([...ids, ...presetFixedReferences.map(reference => reference.assetId), ...(bannerAssetId ? [bannerAssetId] : [])]));
    const owned = await tx.asset.findMany({ where: { id: { in: assetIds }, owner_id: userId, status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(user, tx)] }, select: { id: true } });
    if (owned.length !== assetIds.length) throw new StudioModuleError('模板参考图片不存在或无权使用', 403);
    const created = await tx.imageStudioPreset.create({ data: { id: randomUUID(), owner_id: userId, scope, name, group_name: groupName, prompt, context, model, quality, resolution, count, reference_limit: referenceLimit, aspect_ratio: aspectRatio, banner_asset_id: bannerAssetId, reference_ids: JSON.stringify(ids) } });
    await setStudioPresetFixedReferences(userId, created.id, presetFixedReferences, tx);
    await setStudioPresetStyleIds(user, created.id, styleIds, tx);
    if (referencePolicy) {
      try { await setStudioPresetReferencePolicy(userId, created.id, referencePolicy, ids, tx); }
      catch (error) {
        if (error instanceof StudioReferencePolicyError) throw new StudioModuleError(error.message, error.status);
        throw error;
      }
    }
    if (sourceModuleId) {
      await tx.imageStudioModule.update({ where: { id: sourceModuleId }, data: { source_preset_id: created.id } });
    }
    return created;
  });
}

export async function setStudioPresetSharing(user: ImageStudioIdentity, presetId: string, isShared: boolean) {
  const preset = await prisma.imageStudioPreset.findUnique({ where: { id: presetId } });
  if (!preset || !canManageStudioPreset(user, preset)) {
    throw new StudioModuleError('只有模板创建管理员可以修改共享状态', 403);
  }
  return prisma.imageStudioPreset.update({ where: { id: presetId }, data: { is_shared: isShared } });
}

export async function applyStudioPreset(user: ImageStudioIdentity, presetId: string) {
  const userId = user.id;
  const { preset, ids, fixedReferences, sources, styleGroupIds, referencePolicy } = await prisma.$transaction(async tx => {
    const preset = await tx.imageStudioPreset.findUnique({ where: { id: presetId } });
    if (!preset || !canViewStudioPreset(user, preset)) throw new StudioModuleError('模板不存在或无权使用', 404);
    const ids = parsePreset(preset);
    const fixedReferences = await getStudioPresetFixedReferences(user, preset, tx);
    const styleGroupIds = await getStudioModuleStyleIds(preset.owner_id, preset.id, tx, 'preset');
    const referencePolicy = await getStudioPresetReferencePolicy(preset.owner_id, preset.id, ids, preset.reference_limit, tx);
    const styles = await resolveStudioStyleReferences(user, styleGroupIds, tx);
    try { validateStudioReferenceCounts(referencePolicy, ids, fixedReferences.length, styles.references.length); }
    catch (error) { throw new StudioModuleError((error as Error).message, 409); }
    const allIds = Array.from(new Set([...ids, ...fixedReferences.map(reference => reference.assetId), ...(preset.banner_asset_id ? [preset.banner_asset_id] : [])]));
    const sources = await tx.asset.findMany({ where: { id: { in: allIds }, owner_id: preset.owner_id, status: 'active', type: 'image' } });
    if (sources.length !== allIds.length) throw new StudioModuleError('模板引用的图片已不可用，请重新保存模板', 409);
    return { preset, ids, fixedReferences, sources, styleGroupIds, referencePolicy };
  });
  const assetMap = new Map<string, string>();
  await prisma.$transaction(async tx => {
    for (const source of sources) {
      if (fixedReferences.some(reference => reference.assetId === source.id)) continue;
      if (source.owner_id === userId) { assetMap.set(source.id, source.id); continue; }
      const clone = await tx.asset.create({ data: { owner_id: userId, type: source.type, original_url: source.original_url, thumbnail_url: source.thumbnail_url, file_name: source.file_name, mime_type: source.mime_type, width: source.width, height: source.height, file_size: source.file_size, hash: null, status: 'active' } });
      assetMap.set(source.id, clone.id);
    }
  });
  const copiedReferenceIds = ids.map(id => assetMap.get(id)).filter((id): id is string => Boolean(id));
  const copiedPrimaryIds = referencePolicy.primaryIds.map(id => assetMap.get(id)).filter((id): id is string => Boolean(id));
  return saveStudioModule(userId, { id: randomUUID(), revision: 0, name: preset.name, prompt: preset.prompt, context: preset.context, model: preset.model, quality: preset.quality, resolution: preset.resolution, count: preset.count, referenceLimit: preset.reference_limit, referencePolicy: { ...referencePolicy, primaryIds: copiedPrimaryIds }, aspectRatio: preset.aspect_ratio, groupName: preset.group_name, bannerAssetId: preset.banner_asset_id ? assetMap.get(preset.banner_asset_id) || null : null, referenceIds: copiedReferenceIds, styleGroupIds }, false, user.role === 'admin', preset.id, user);
}
