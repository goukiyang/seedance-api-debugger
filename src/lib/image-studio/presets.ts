import { randomUUID } from 'crypto';
import { prisma } from '@/lib/prisma';
import { MAX_REFERENCE_IMAGES } from './limits';
import { IMAGE_STUDIO_MODELS, normalizeImageStudioQuality } from './model-catalog';
import { normalizeStudioRatio } from './ratios';
import { saveStudioModule, StudioModuleError } from './modules';

type PresetDraft = {
  scope?: unknown; name?: unknown; groupName?: unknown; prompt?: unknown; context?: unknown;
  model?: unknown; quality?: unknown; count?: unknown; aspectRatio?: unknown;
  bannerAssetId?: unknown; referenceIds?: unknown; referenceLimit?: unknown;
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

export async function listStudioPresets(_userId: string, _isAdmin: boolean) {
  const rows = await prisma.imageStudioPreset.findMany({
    // The library is readable by every signed-in user. Applying a preset
    // creates a private module copy, so the source preset remains immutable.
    where: { OR: [{ scope: 'admin' }, { scope: 'creator' }] },
    orderBy: [{ scope: 'asc' }, { updated_at: 'desc' }],
  });
  const assetIds = rows.flatMap(parsePreset);
  const bannerIds = rows.map(row => row.banner_asset_id).filter((id): id is string => Boolean(id));
  const assets = await prisma.asset.findMany({ where: { id: { in: Array.from(new Set([...assetIds, ...bannerIds])) }, status: 'active', type: 'image' }, select: { id: true, original_url: true, thumbnail_url: true } });
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  return rows.map(row => {
    const ids = parsePreset(row);
    return {
      id: row.id, name: row.name, scope: row.scope, groupName: row.group_name, prompt: row.prompt, context: row.context, revision: row.updated_at.toISOString(),
      model: row.model, quality: normalizeImageStudioQuality(row.model, row.quality), count: row.count, referenceLimit: Math.max(1, Math.min(MAX_REFERENCE_IMAGES, Number(row.reference_limit) || MAX_REFERENCE_IMAGES)),
      aspectRatio: row.aspect_ratio, contextConfigured: Boolean(row.context.trim()),
      images: ids.flatMap(id => { const asset = byId.get(id); return asset ? [{ id, originalUrl: asset.original_url, thumbnailUrl: asset.thumbnail_url }] : []; }),
      banner: row.banner_asset_id && byId.get(row.banner_asset_id) ? { id: row.banner_asset_id, originalUrl: byId.get(row.banner_asset_id)!.original_url, thumbnailUrl: byId.get(row.banner_asset_id)!.thumbnail_url } : null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  });
}

export async function saveStudioPreset(userId: string, body: PresetDraft, isAdmin: boolean) {
  const scope = body.scope === 'admin' ? 'admin' : body.scope === 'creator' ? 'creator' : '';
  if (!scope || (scope === 'admin' && !isAdmin)) throw new StudioModuleError('没有保存该模板类型的权限', 403);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const groupName = typeof body.groupName === 'string' ? body.groupName.trim() || '未分组' : '未分组';
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  const context = typeof body.context === 'string' ? body.context : '';
  const model = typeof body.model === 'string' && IMAGE_STUDIO_MODELS.includes(body.model as never) ? body.model : '';
  const count = Number(body.count);
  const referenceLimit = body.referenceLimit === undefined ? MAX_REFERENCE_IMAGES : Number(body.referenceLimit);
  const ids = parseIds(body.referenceIds);
  if (!name || name.length > 80 || prompt.length > 20000 || context.length > 20000 || groupName.length > 40 || !model || !Number.isInteger(count) || count < 1 || count > 8 || !Number.isInteger(referenceLimit) || referenceLimit < 1 || referenceLimit > MAX_REFERENCE_IMAGES || ids.length > referenceLimit) throw new StudioModuleError('模板内容无效');
  const aspectRatio = normalizeStudioRatio(body.aspectRatio);
  const quality = normalizeImageStudioQuality(model, body.quality);
  const bannerAssetId = body.bannerAssetId == null ? null : String(body.bannerAssetId);
  const owned = await prisma.asset.findMany({ where: { id: { in: Array.from(new Set([...ids, ...(bannerAssetId ? [bannerAssetId] : [])])) }, owner_id: userId, status: 'active', type: 'image' }, select: { id: true } });
  if (owned.length !== new Set([...ids, ...(bannerAssetId ? [bannerAssetId] : [])]).size) throw new StudioModuleError('模板参考图片不存在或无权使用', 403);
  return prisma.imageStudioPreset.create({ data: { id: randomUUID(), owner_id: userId, scope, name, group_name: groupName, prompt, context, model, quality, count, reference_limit: referenceLimit, aspect_ratio: aspectRatio, banner_asset_id: bannerAssetId, reference_ids: JSON.stringify(ids) } });
}

export async function applyStudioPreset(userId: string, presetId: string, isAdmin: boolean) {
  const preset = await prisma.imageStudioPreset.findFirst({ where: { id: presetId, OR: [{ scope: 'admin' }, { scope: 'creator' }] } });
  if (!preset) throw new StudioModuleError('模板不存在或无权使用', 404);
  const ids = parsePreset(preset);
  const allIds = Array.from(new Set([...ids, ...(preset.banner_asset_id ? [preset.banner_asset_id] : [])]));
  const sources = await prisma.asset.findMany({ where: { id: { in: allIds }, owner_id: preset.owner_id, status: 'active', type: 'image' } });
  if (sources.length !== allIds.length) throw new StudioModuleError('模板引用的图片已不可用，请重新保存模板', 409);
  const assetMap = new Map<string, string>();
  await prisma.$transaction(async tx => {
    for (const source of sources) {
      if (source.owner_id === userId) { assetMap.set(source.id, source.id); continue; }
      const clone = await tx.asset.create({ data: { owner_id: userId, type: source.type, original_url: source.original_url, thumbnail_url: source.thumbnail_url, file_name: source.file_name, mime_type: source.mime_type, width: source.width, height: source.height, file_size: source.file_size, hash: null, status: 'active' } });
      assetMap.set(source.id, clone.id);
    }
  });
  return saveStudioModule(userId, { id: randomUUID(), revision: 0, name: preset.name, prompt: preset.prompt, context: preset.context, model: preset.model, quality: preset.quality, count: preset.count, referenceLimit: preset.reference_limit, aspectRatio: preset.aspect_ratio, groupName: preset.group_name, bannerAssetId: preset.banner_asset_id ? assetMap.get(preset.banner_asset_id) : null, referenceIds: ids.map(id => assetMap.get(id)).filter(Boolean) }, false, isAdmin);
}
