import { prisma } from '@/lib/prisma';
import { normalizeStudioRatio } from './ratios';
import { getImageStudioSettings, IMAGE_STUDIO_MODELS, type ImageStudioSettings } from './settings';
import { normalizeImageStudioQuality } from './model-catalog';
import { MAX_REFERENCE_IMAGES } from './limits';

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
  prices: Record<typeof IMAGE_STUDIO_MODELS[number], number | null>;
};

export function resolveStudioModuleGenerationConfig(
  row: { model?: string | null; quality?: string | null; prices_json?: string | null } | null | undefined,
  fallback: ImageStudioSettings,
): StudioModuleGenerationConfig {
  const model = row?.model && IMAGE_STUDIO_MODELS.includes(row.model as StudioModuleGenerationConfig['model'])
    ? row.model as StudioModuleGenerationConfig['model']
    : fallback.model;
  // Prices are global rules. Keep the legacy column readable for old records,
  // but never let a module override the shared administrator setting.
  return { model, quality: normalizeImageStudioQuality(model, row?.quality), prices: { ...fallback.prices } };
}

type StudioModuleRow = {
  id: string; name: string; prompt: string; context: string; model?: string | null; quality?: string | null; group_name?: string | null; banner_asset_id?: string | null; prices_json?: string | null; reproduce_task_id?: string | null;
  count: number; aspect_ratio?: string; reference_ids: string[] | string; revision: number; created_at: Date; updated_at: Date;
};

async function moduleDTO(row: StudioModuleRow, ownerId: string, settings: ImageStudioSettings, saved = true, _isAdmin = false) {
  const ids = Array.isArray(row.reference_ids) ? row.reference_ids : JSON.parse(row.reference_ids) as string[];
  const assetIds = [...ids, ...(row.banner_asset_id ? [row.banner_asset_id] : [])];
  const assets = await prisma.asset.findMany({ where: { id: { in: assetIds }, owner_id: ownerId, status: 'active', type: 'image' },
    select: { id: true, original_url: true, thumbnail_url: true } });
  const generation = resolveStudioModuleGenerationConfig(row, settings);
  const quality = normalizeImageStudioQuality(generation.model, row.quality);
  const banner = row.banner_asset_id ? assets.find(item => item.id === row.banner_asset_id) : null;
  return { id: row.id, name: row.name, prompt: row.prompt, count: row.count, aspectRatio: row.aspect_ratio || 'auto', revision: row.revision, saved,
    model: generation.model, quality, groupName: row.group_name || '未分组', banner: banner ? { id: banner.id, originalUrl: banner.original_url, thumbnailUrl: banner.thumbnail_url } : null, prices: generation.prices, unitCredits: generation.prices[generation.model],
    reproduceFromTaskId: row.reproduce_task_id || null,
    // The module is already restricted to ownerId. A user's own context is safe
    // to return, while the separate global context remains admin-only.
    contextConfigured: Boolean(row.context.trim()), context: row.context,
    createdAt: row.created_at, updatedAt: row.updated_at,
    images: ids.flatMap(id => { const asset = assets.find(item => item.id === id); return asset ? [{ id, originalUrl: asset.original_url, thumbnailUrl: asset.thumbnail_url }] : []; }) };
}
export async function listStudioModules(ownerId: string, cursor?: string, isAdmin = false) {
  const settings = await getImageStudioSettings();
  const defaultId = defaultStudioModuleId(ownerId);
  const rows = await prisma.imageStudioModule.findMany({ where: { owner_id: ownerId, id: { not: defaultId } },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: 13, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
  const visible = rows.slice(0, 12);
  const modules = await Promise.all(visible.map(row => moduleDTO(row, ownerId, settings, true, isAdmin)));
  if (!cursor) {
    const first = await prisma.imageStudioModule.findFirst({ where: { id: defaultId, owner_id: ownerId } });
    modules.unshift(await moduleDTO(first || { id: defaultId, name: '模块 1', prompt: '', context: '', count: 1, reference_ids: [], revision: 0, created_at: new Date(0), updated_at: new Date(0) }, ownerId, settings, Boolean(first), isAdmin));
  }
  return { modules, nextCursor: rows.length > 12 ? visible[visible.length - 1].id : null };
}
export async function saveStudioModule(ownerId: string, body: Record<string, unknown>, createOnly = false, isAdmin = false) {
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
  const revision = createOnly ? 0 : body.revision;
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || typeof prompt !== 'string' || prompt.length > 20000
    || !Number.isInteger(count) || Number(count) < 1 || Number(count) > 8 || !Number.isInteger(revision) || Number(revision) < 0
    || !Array.isArray(ids) || ids.length > MAX_REFERENCE_IMAGES || ids.some(item => typeof item !== 'string' || !item || item.length > 100)) throw new StudioModuleError(`模块内容无效，请检查名称、张数和参考图片（最多 ${MAX_REFERENCE_IMAGES} 张）`);
  const row = await prisma.$transaction(async tx => {
    const current = await tx.imageStudioModule.findUnique({ where: { id } });
    if (current && current.owner_id !== ownerId) throw new StudioModuleError('无权修改这个模块', 403);
    if (current && createOnly) return current;
    if ((current?.revision || 0) !== revision) throw new StudioModuleError('模块已在其他页面保存，请刷新后核对；当前草稿仍在本页', 409);
    const assets = await tx.asset.count({ where: { id: { in: ids as string[] }, owner_id: ownerId, type: 'image', status: 'active' } });
    if (assets !== new Set(ids).size) throw new StudioModuleError('参考图片已不可用或无权使用', 403);
    if (reproduceFromTaskId) {
      const source = await tx.imageStudioTask.findFirst({ where: { id: reproduceFromTaskId, owner_id: ownerId, snapshot_json: { not: null } }, select: { id: true } });
      if (!source) throw new StudioModuleError('历史生成记录不存在或无权复现', 403);
    }
    const selectedModel = model || current?.model || (await getImageStudioSettings()).model;
    const data = { name: name.trim(), prompt, count: Number(count), reference_ids: JSON.stringify(ids), revision: Number(revision) + 1,
      ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
      ...(model !== undefined ? { model: model as string } : {}),
      ...(quality !== undefined ? { quality: normalizeImageStudioQuality(String(selectedModel), String(quality)) } : {}),
      ...(groupName !== undefined ? { group_name: groupName.trim() || '未分组' } : {}),
      ...(bannerAssetId !== undefined ? { banner_asset_id: bannerAssetId } : {}),
      ...(reproduceFromTaskId !== undefined ? { reproduce_task_id: reproduceFromTaskId } : {}),
      ...(typeof body.context === 'string' ? { context: body.context } : {}) };
    if (bannerAssetId) {
      const banner = await tx.asset.findFirst({ where: { id: bannerAssetId, owner_id: ownerId, type: 'image', status: 'active' }, select: { id: true } });
      if (!banner) throw new StudioModuleError('banner 图片不存在或无权使用', 403);
    }
    if (!current) return tx.imageStudioModule.create({ data: { id, owner_id: ownerId, ...data } });
    const changed = await tx.imageStudioModule.updateMany({ where: { id, owner_id: ownerId, revision: Number(revision) }, data });
    if (!changed.count) throw new StudioModuleError('模块已在其他页面保存，请刷新后核对', 409);
    return tx.imageStudioModule.findUniqueOrThrow({ where: { id } });
  }, { timeout: 15000 });
  return moduleDTO(row, ownerId, await getImageStudioSettings(), true, isAdmin);
}
