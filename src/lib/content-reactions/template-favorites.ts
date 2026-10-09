import 'server-only';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { ReactionError } from './content';
import type { TemplateFavoriteMutation, TemplateFavoriteOrganization } from './types';

type Entry = { groupId: string | null; alias: string | null };
type Library = { schemaVersion: 1; ownerId: string; revision: number; groups: Array<{ id: string; name: string }>; entries: Record<string, Entry> };
type Reader = Pick<Prisma.TransactionClient, 'platformSetting' | 'contentReaction'>;
const libraryKey = (ownerId: string) => `template_favorites_v1:${ownerId}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const conflict = () => new ReactionError('分组已在其他页面变化，草稿已保留，请刷新后重试', 409);

export function favoriteEntry(library: Library, key: string): Entry {
  return own(library.entries, key) ? library.entries[key] : { groupId: null, alias: null };
}

export async function readTemplateFavoriteLibrary(ownerId: string, client: Reader = prisma) {
  const row = await client.platformSetting.findUnique({ where: { key: libraryKey(ownerId) } });
  if (!row) return { row, library: { schemaVersion: 1, ownerId, revision: 0, groups: [], entries: {} } as Library };
  try {
    const library = JSON.parse(row.value_json) as Library;
    if (library.schemaVersion !== 1 || library.ownerId !== ownerId || !Number.isSafeInteger(library.revision) || library.revision < 0
      || !Array.isArray(library.groups) || library.groups.length > 100 || !library.entries || typeof library.entries !== 'object' || Array.isArray(library.entries)) throw new Error();
    const ids = new Set<string>();
    for (const group of library.groups) {
      if (!group || typeof group.id !== 'string' || !uuid.test(group.id) || ids.has(group.id) || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 60) throw new Error();
      ids.add(group.id);
    }
    for (const entry of Object.values(library.entries)) {
      if (!entry || typeof entry !== 'object' || !(entry.alias === null || typeof entry.alias === 'string' && entry.alias.length <= 120)
        || !(entry.groupId === null || typeof entry.groupId === 'string' && ids.has(entry.groupId))) throw new Error();
    }
    return { row, library };
  } catch { throw new ReactionError('个人分组暂时无法读取，原喜欢仍保留，请稍后重试', 503); }
}

export async function favoriteOrganization(library: Library, client: Reader = prisma): Promise<TemplateFavoriteOrganization> {
  const rows = await client.contentReaction.findMany({ where: { user_id: library.ownerId, category: 'template', OR: [{ liked: true }, { favorited: true }] }, select: { content_key: true } });
  const counts = new Map<string, number>();
  let ungroupedCount = 0;
  for (const row of rows) {
    const group = favoriteEntry(library, row.content_key).groupId;
    if (group) counts.set(group, (counts.get(group) || 0) + 1); else ungroupedCount++;
  }
  return { ownerId: library.ownerId, revision: library.revision, groups: library.groups.map(group => ({ ...group, count: counts.get(group.id) || 0 })), total: rows.length, ungroupedCount };
}

export async function getTemplateFavoriteOrganization(user: SessionUser) {
  const { library } = await readTemplateFavoriteLibrary(user.id);
  return favoriteOrganization(library);
}

export async function changeTemplateFavorites(user: SessionUser, input: TemplateFavoriteMutation) {
  if (!input || input.viewerId !== user.id) throw new ReactionError('账号已变化，请重新打开我的喜欢', 409);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || typeof input.requestId !== 'string' || !uuid.test(input.requestId)) throw new ReactionError('保存版本无效');
  const action = input.action;
  if (!['create-group', 'rename-group', 'delete-group', 'move', 'rename'].includes(action)) throw new ReactionError('管理操作无效');
  const groupId = 'groupId' in input ? input.groupId : null;
  if (['create-group', 'rename-group', 'delete-group'].includes(action) && (typeof groupId !== 'string' || !uuid.test(groupId))) throw new ReactionError('分组编号无效');
  if (action === 'move' && !(groupId === null || typeof groupId === 'string' && uuid.test(groupId))) throw new ReactionError('分组编号无效');
  const name = 'name' in input && typeof input.name === 'string' ? input.name.trim() : null;
  if (['create-group', 'rename-group'].includes(action) && (!name || name.length > 60)) throw new ReactionError('分组名称需为1至60字');
  if (action === 'rename' && !(input.name === null || typeof input.name === 'string' && name && name.length <= 120)) throw new ReactionError('显示名称需为1至120字，重置请使用原名');
  const contentKey = 'key' in input ? input.key : null;
  if (['move', 'rename'].includes(action) && (typeof contentKey !== 'string' || !contentKey || contentKey.length > 5000)) throw new ReactionError('喜欢编号无效');
  const fingerprint = createHash('sha256').update(JSON.stringify([user.id, action, groupId, name, contentKey, input.expectedRevision])).digest('hex');
  const receiptKey = `template_favorites_request_v1:${user.id}:${input.requestId}`;
  try {
    return await prisma.$transaction(async tx => {
      const actor = await tx.user.findUnique({ where: { id: user.id }, select: { status: true, expires_at: true } });
      if (!actor || actor.status !== 'active' || actor.expires_at && actor.expires_at <= new Date()) throw new ReactionError('账号暂不可用', 403);
      const receipt = await tx.platformSetting.findUnique({ where: { key: receiptKey } });
      const { row, library } = await readTemplateFavoriteLibrary(user.id, tx);
      if (receipt) {
        const previous = JSON.parse(receipt.value_json);
        if (previous.ownerId !== user.id || previous.fingerprint !== fingerprint) throw new ReactionError('重复请求内容不一致', 409);
        return { organization: await favoriteOrganization(library, tx), requestId: input.requestId };
      }
      if (library.revision !== input.expectedRevision) throw conflict();
      if (contentKey !== null) {
        const mark = await tx.contentReaction.findUnique({ where: { user_id_content_key: { user_id: user.id, content_key: contentKey } } });
        if (!mark || mark.category !== 'template' || !(mark.liked || mark.favorited)) throw new ReactionError('这条喜欢已取消，请刷新列表', 409);
      }
      const group = library.groups.find(item => item.id === groupId);
      if (action === 'create-group') {
        if (group || library.groups.length >= 100) throw new ReactionError(group ? '分组编号已存在，请重新读取' : '最多可建立100个分组', 409);
        library.groups.push({ id: groupId!, name: name! });
      } else if (action === 'rename-group') {
        if (!group) throw new ReactionError('分组已删除，草稿仍保留，请刷新', 409);
        group.name = name!;
      } else if (action === 'delete-group') {
        if (!group) throw new ReactionError('分组已删除，请刷新', 409);
        library.groups = library.groups.filter(item => item.id !== groupId);
        for (const entry of Object.values(library.entries)) if (entry.groupId === groupId) entry.groupId = null;
      } else if (contentKey !== null) {
        if (action === 'move' && groupId !== null && !group) throw new ReactionError('目标分组已删除，请重新选择', 409);
        const entry = { ...favoriteEntry(library, contentKey) };
        if (action === 'move') entry.groupId = groupId;
        else entry.alias = name;
        Object.defineProperty(library.entries, contentKey, { value: entry, enumerable: true, writable: true, configurable: true });
      }
      library.revision++;
      const value_json = JSON.stringify(library);
      if (Buffer.byteLength(value_json, 'utf8') > 1024 * 1024) throw new ReactionError('个人组织记录已满，请先清理分组名称', 400);
      const data = { value_json, updated_by: user.id };
      if (row) {
        const updated = await tx.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json }, data });
        if (updated.count !== 1) throw conflict();
      } else await tx.platformSetting.create({ data: { key: libraryKey(user.id), ...data } });
      await tx.platformSetting.create({ data: { key: receiptKey, value_json: JSON.stringify({ ownerId: user.id, fingerprint, revision: library.revision }), updated_by: user.id } });
      return { organization: await favoriteOrganization(library, tx), requestId: input.requestId };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2028', 'P2034'].includes(error.code)) throw conflict();
    throw error;
  }
}
