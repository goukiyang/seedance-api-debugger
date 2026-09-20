import { prisma } from '@/lib/prisma';

export const defaultStudioModuleId = (ownerId: string) => `default-${ownerId}`;
export class StudioModuleError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function validStudioModuleId(id: unknown, ownerId: string): id is string {
  return typeof id === 'string' && (id === defaultStudioModuleId(ownerId) || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));
}
async function moduleDTO(row: { id: string; name: string; prompt: string; context: string; count: number; reference_ids: string; revision: number; created_at: Date; updated_at: Date }, ownerId: string, saved = true, isAdmin = false) {
  const ids = JSON.parse(row.reference_ids) as string[];
  const assets = await prisma.asset.findMany({ where: { id: { in: ids }, owner_id: ownerId, status: 'active', type: 'image' },
    select: { id: true, original_url: true, thumbnail_url: true } });
  return { id: row.id, name: row.name, prompt: row.prompt, count: row.count, revision: row.revision, saved,
    contextConfigured: Boolean(row.context.trim()), ...(isAdmin ? { context: row.context } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
    images: ids.flatMap(id => { const asset = assets.find(item => item.id === id); return asset ? [{ id, originalUrl: asset.original_url, thumbnailUrl: asset.thumbnail_url }] : []; }) };
}
export async function listStudioModules(ownerId: string, cursor?: string, isAdmin = false) {
  const defaultId = defaultStudioModuleId(ownerId);
  const rows = await prisma.imageStudioModule.findMany({ where: { owner_id: ownerId, id: { not: defaultId } },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: 13, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
  const visible = rows.slice(0, 12);
  const modules = await Promise.all(visible.map(row => moduleDTO(row, ownerId, true, isAdmin)));
  if (!cursor) {
    const first = await prisma.imageStudioModule.findFirst({ where: { id: defaultId, owner_id: ownerId } });
    modules.unshift(await moduleDTO(first || { id: defaultId, name: '模块 1', prompt: '', context: '', count: 1, reference_ids: '[]', revision: 0, created_at: new Date(0), updated_at: new Date(0) }, ownerId, Boolean(first), isAdmin));
  }
  return { modules, nextCursor: rows.length > 12 ? visible[visible.length - 1].id : null };
}
export async function saveStudioModule(ownerId: string, body: Record<string, unknown>, createOnly = false, isAdmin = false) {
  if (!body || !validStudioModuleId(body.id, ownerId)) throw new StudioModuleError('模块编号无效');
  const id = body.id;
  if (body.context !== undefined && !isAdmin) throw new StudioModuleError('仅管理员可以编辑上下文', 403);
  if (body.context !== undefined && (typeof body.context !== 'string' || body.context.length > 20000)) throw new StudioModuleError('模块上下文最多 20000 字');
  const name = createOnly ? '未命名模块' : body.name;
  const prompt = createOnly ? '' : body.prompt;
  const count = createOnly ? 1 : body.count;
  const ids = createOnly ? [] : body.referenceIds;
  const revision = createOnly ? 0 : body.revision;
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || typeof prompt !== 'string' || prompt.length > 12000
    || !Number.isInteger(count) || Number(count) < 1 || Number(count) > 8 || !Number.isInteger(revision) || Number(revision) < 0
    || !Array.isArray(ids) || ids.length > 2 || ids.some(item => typeof item !== 'string' || !item || item.length > 100)) throw new StudioModuleError('模块内容无效，请检查名称、张数和参考图片');
  const row = await prisma.$transaction(async tx => {
    const current = await tx.imageStudioModule.findUnique({ where: { id } });
    if (current && current.owner_id !== ownerId) throw new StudioModuleError('无权修改这个模块', 403);
    if (current && createOnly) return current;
    if ((current?.revision || 0) !== revision) throw new StudioModuleError('模块已在其他页面保存，请刷新后核对；当前草稿仍在本页', 409);
    const assets = await tx.asset.count({ where: { id: { in: ids as string[] }, owner_id: ownerId, type: 'image', status: 'active' } });
    if (assets !== new Set(ids).size) throw new StudioModuleError('参考图片已不可用或无权使用', 403);
    const data = { name: name.trim(), prompt, count: Number(count), reference_ids: JSON.stringify(ids), revision: Number(revision) + 1,
      ...(typeof body.context === 'string' && isAdmin ? { context: body.context } : {}) };
    if (!current) return tx.imageStudioModule.create({ data: { id, owner_id: ownerId, ...data } });
    const changed = await tx.imageStudioModule.updateMany({ where: { id, owner_id: ownerId, revision: Number(revision) }, data });
    if (!changed.count) throw new StudioModuleError('模块已在其他页面保存，请刷新后核对', 409);
    return tx.imageStudioModule.findUniqueOrThrow({ where: { id } });
  }, { timeout: 15000 });
  return moduleDTO(row, ownerId, true, isAdmin);
}
