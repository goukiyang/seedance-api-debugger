import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canUseCompanyTemplates, type ImageStudioIdentity } from './access';
import { parseStudioFixedReferences, type StudioFixedReference } from './fixed-references';
import { MAX_REFERENCE_IMAGES } from './limits';
import { studioVisibleAssetWhere } from './protected-assets';

const PREFIX = 'studio_style_group_v1:';
const selectionKey = (moduleId: string) => `studio_style_selection_v1:${moduleId}`;
type Client = Pick<Prisma.TransactionClient, 'platformSetting' | 'asset' | 'imageStudioModule' | 'imageStudioPreset'>;
export type StudioStyleGroup = {
  id: string; ownerId: string; name: string; coverAssetId: string; references: StudioFixedReference[];
  revision: number; deleted?: boolean;
};
export class StudioStyleError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
function identity(user: ImageStudioIdentity) {
  if (!canUseCompanyTemplates(user)) throw new StudioStyleError('仅限公司账号使用风格组', 403);
}
export function canManageStudioStyle(user: ImageStudioIdentity, group: Pick<StudioStyleGroup, 'ownerId'>) {
  return canUseCompanyTemplates(user) && (user.role === 'admin' || group.ownerId === user.id);
}
function decode(value: string): StudioStyleGroup {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.ownerId !== 'string' || typeof parsed.name !== 'string'
      || typeof parsed.coverAssetId !== 'string' || !Number.isInteger(parsed.revision)) throw new Error();
    return { ...parsed, references: parseStudioFixedReferences(parsed.references) };
  } catch { throw new StudioStyleError('风格组暂时无法读取', 503); }
}
export function parseStudioStyleIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_REFERENCE_IMAGES
    || value.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) throw new StudioStyleError('风格组选择无效');
  return Array.from(new Set(value as string[]));
}
export async function getStudioStyleGroup(user: ImageStudioIdentity, id: string, client: Client = prisma) {
  identity(user);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new StudioStyleError('风格组不存在', 404);
  const row = await client.platformSetting.findUnique({ where: { key: `${PREFIX}${id}` }, select: { value_json: true } });
  if (!row) throw new StudioStyleError('风格组已删除或不存在', 404);
  const group = decode(row.value_json);
  if (group.deleted) throw new StudioStyleError('风格组已删除，请重新选择', 409);
  return group;
}
export async function studioStyleDTO(user: ImageStudioIdentity, group: StudioStyleGroup, client: Client = prisma) {
  const canManage = canManageStudioStyle(user, group);
  const assets = canManage ? await client.asset.findMany({ where: { id: { in: group.references.map(ref => ref.assetId) }, type: 'image', status: 'active' },
    select: { id: true, width: true, height: true } }) : [];
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  return { id: group.id, name: group.name, revision: group.revision, canManage,
    coverUrl: `/api/image-studio/style-groups/${group.id}/cover?revision=${group.revision}`,
    referenceCount: group.references.length,
    ...(canManage ? { coverAssetId: group.coverAssetId, references: group.references.map(ref => {
      const asset = byId.get(ref.assetId);
      return { id: ref.assetId, note: ref.note, available: Boolean(asset), width: asset?.width || null, height: asset?.height || null,
        originalUrl: asset ? `/api/image-studio/style-groups/${group.id}/assets/${ref.assetId}` : null,
        thumbnailUrl: asset ? `/api/image-studio/style-groups/${group.id}/assets/${ref.assetId}?thumbnail=1` : null };
    }) } : {}),
  };
}
export async function listStudioStyleGroups(user: ImageStudioIdentity, cursor?: string) {
  identity(user);
  const rows = await prisma.platformSetting.findMany({ where: { key: { startsWith: PREFIX, ...(cursor ? { gt: `${PREFIX}${cursor}` } : {}) } },
    orderBy: { key: 'asc' }, take: 49, select: { key: true, value_json: true } });
  const page = rows.slice(0, 48);
  const groups = page.map(row => decode(row.value_json)).filter(group => !group.deleted);
  return { groups: await Promise.all(groups.map(group => studioStyleDTO(user, group))),
    nextCursor: rows.length > 48 ? page[page.length - 1].key.slice(PREFIX.length) : null };
}
export async function getStudioModuleStyleIds(ownerId: string, moduleId: string, client: Client = prisma, kind: 'module' | 'preset' = 'module') {
  const row = await client.platformSetting.findUnique({ where: { key: kind === 'preset' ? `studio_style_preset_selection_v1:${moduleId}` : selectionKey(moduleId) }, select: { value_json: true } });
  if (!row) return [];
  try {
    const value = JSON.parse(row.value_json);
    if (value.ownerId !== ownerId) throw new Error();
    return parseStudioStyleIds(value.ids);
  } catch { throw new StudioStyleError('已保存的风格组选择无法读取', 503); }
}
export async function resolveStudioStyleReferences(user: ImageStudioIdentity, ids: string[], client: Client = prisma) {
  const groups = await Promise.all(ids.map(id => getStudioStyleGroup(user, id, client)));
  const references = groups.flatMap(group => group.references);
  if (references.length > MAX_REFERENCE_IMAGES) throw new StudioStyleError(`风格组图片合计不能超过 ${MAX_REFERENCE_IMAGES} 张`);
  return { groups, references };
}
export async function setStudioModuleStyleIds(user: ImageStudioIdentity, moduleId: string, value: unknown, client: Client = prisma) {
  const ids = parseStudioStyleIds(value);
  const studioModule = await client.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: user.id }, select: { id: true } });
  if (!studioModule) throw new StudioStyleError('模板不存在或无权修改', 403);
  await resolveStudioStyleReferences(user, ids, client);
  const valueJson = JSON.stringify({ ownerId: user.id, ids });
  await client.platformSetting.upsert({ where: { key: selectionKey(moduleId) },
    create: { key: selectionKey(moduleId), value_json: valueJson, updated_by: user.id },
    update: { value_json: valueJson, updated_by: user.id } });
}
export async function setStudioPresetStyleIds(user: ImageStudioIdentity, presetId: string, value: unknown, client: Client = prisma) {
  const ids = parseStudioStyleIds(value);
  const preset = await client.imageStudioPreset.findFirst({ where: { id: presetId, owner_id: user.id }, select: { id: true } });
  if (!preset) throw new StudioStyleError('模板不存在或无权修改', 403);
  await resolveStudioStyleReferences(user, ids, client);
  const key = `studio_style_preset_selection_v1:${presetId}`;
  const valueJson = JSON.stringify({ ownerId: user.id, ids });
  await client.platformSetting.upsert({ where: { key }, create: { key, value_json: valueJson, updated_by: user.id }, update: { value_json: valueJson, updated_by: user.id } });
}
export async function saveStudioStyleGroup(user: ImageStudioIdentity, body: Record<string, unknown>) {
  identity(user);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 80) throw new StudioStyleError('风格组名称须为 1–80 字');
  const id = body.id == null ? randomUUID() : String(body.id);
  return prisma.$transaction(async tx => {
    const current = body.id == null ? null : await getStudioStyleGroup(user, id, tx);
    if (current && !canManageStudioStyle(user, current)) throw new StudioStyleError('只有管理员或创建者能修改风格组', 403);
    if (current && body.revision !== current.revision) throw new StudioStyleError('风格组已更新，请重新打开后编辑', 409);
    let references: StudioFixedReference[];
    try { references = parseStudioFixedReferences(body.references); } catch (error) { throw new StudioStyleError((error as Error).message); }
    const mergeIds = body.mergeIds === undefined ? [] : parseStudioStyleIds(body.mergeIds);
    const merge = await resolveStudioStyleReferences(user, mergeIds, tx);
    if (merge.groups.some(group => !canManageStudioStyle(user, group))) throw new StudioStyleError('只有管理员或创建者能合并风格组内容', 403);
    references = [...references, ...merge.references];
    if (!references.length || references.length > MAX_REFERENCE_IMAGES) throw new StudioStyleError(`风格组须包含 1–${MAX_REFERENCE_IMAGES} 张图片`);
    const coverAssetId = typeof body.coverAssetId === 'string' ? body.coverAssetId : references[0].assetId;
    if (!references.some(ref => ref.assetId === coverAssetId)) throw new StudioStyleError('请从组内图片选择封面');
    const existingIds = new Set([...(current?.references || []), ...merge.references].map(ref => ref.assetId));
    const ids = Array.from(new Set(references.map(ref => ref.assetId)));
    const visible = await studioVisibleAssetWhere(user, tx);
    const assets = await tx.asset.findMany({ where: { id: { in: ids }, type: 'image', status: 'active', AND: [visible,
      ...(user.role === 'admin' ? [] : [{ OR: [{ owner_id: user.id }, { id: { in: Array.from(existingIds) } }] }]) ] }, select: { id: true } });
    if (assets.length !== ids.length) throw new StudioStyleError('组内图片不存在或无权查看', 403);
    const group: StudioStyleGroup = { id, ownerId: current?.ownerId || user.id, name, coverAssetId, references, revision: (current?.revision || 0) + 1 };
    const valueJson = JSON.stringify(group);
    if (current) {
      const changed = await tx.platformSetting.updateMany({ where: { key: `${PREFIX}${id}`, value_json: JSON.stringify(current) }, data: { value_json: valueJson, updated_by: user.id } });
      if (!changed.count) throw new StudioStyleError('风格组已更新，请重新打开后编辑', 409);
    } else await tx.platformSetting.create({ data: { key: `${PREFIX}${id}`, value_json: valueJson, updated_by: user.id } });
    return studioStyleDTO(user, group, tx);
  }, { timeout: 15000 });
}
export async function deleteStudioStyleGroup(user: ImageStudioIdentity, id: string, revision: unknown) {
  return prisma.$transaction(async tx => {
    const group = await getStudioStyleGroup(user, id, tx);
    if (!canManageStudioStyle(user, group)) throw new StudioStyleError('只有管理员或创建者能删除风格组', 403);
    if (group.revision !== revision) throw new StudioStyleError('风格组已更新，请刷新后再删除', 409);
    // Keep the private binding for historical tasks; deleting a group never
    // removes original images or makes their URLs public again.
    const changed = await tx.platformSetting.updateMany({ where: { key: `${PREFIX}${id}`, value_json: JSON.stringify(group) },
      data: { value_json: JSON.stringify({ ...group, deleted: true, revision: group.revision + 1 }), updated_by: user.id } });
    if (!changed.count) throw new StudioStyleError('风格组已更新，请刷新后再删除', 409);
  });
}
