import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import type { Prisma } from '@prisma/client';
import type { UiDocument, JsonObject } from './types';
export const uiKey = (owner: string, kind: string, id: string) => `ui-design:v1:${owner}:${kind}:${uiId(id)}`;
export function uiId(value: unknown) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(value)) throw new AuthError('设计记录编号无效', 400);
  return value;
}
export async function readUiDocument(owner: string, kind: string, id: string, db: Pick<Prisma.TransactionClient, 'platformSetting'> = prisma) {
  const row = await db.platformSetting.findUnique({ where: { key: uiKey(owner, kind, id) } });
  if (!row) throw new AuthError('设计记录不存在或无权读取', 404);
  const doc = JSON.parse(row.value_json) as UiDocument;
  if (doc.ownerId !== owner || doc.id !== id) throw new AuthError('设计记录归属不符', 403);
  return doc;
}
export async function saveUiDocument(owner: string, kind: string, id: string, revision: number, data: JsonObject, archived = false) {
  if (!Number.isSafeInteger(revision) || revision < 0 || !data || typeof data !== 'object' || Array.isArray(data)) throw new AuthError('保存内容无效', 400);
  const serialized = JSON.stringify(data);
  if (serialized.length > 4_000_000 || /data:image\//.test(serialized)) throw new AuthError('请先登记图片为素材引用；单条设计资料最多 4 MB，输入保留', 413);
  return prisma.$transaction(async tx => {
    const key = uiKey(owner, kind, id), row = await tx.platformSetting.findUnique({ where: { key } });
    const current = row ? JSON.parse(row.value_json) as UiDocument : null;
    if ((current?.revision || 0) !== revision) throw new AuthError('此记录已在另一页更新，当前草稿保留；可查看服务器版本后继续', 409);
    const result: UiDocument = { id, ownerId: owner, revision: revision + 1, updatedAt: new Date().toISOString(), archived, data };
    const value_json = JSON.stringify(result);
    if (row) {
      if (!(await tx.platformSetting.updateMany({ where: { key, value_json: row.value_json }, data: { value_json, updated_by: owner } })).count) throw new AuthError('保存发生冲突，当前草稿保留', 409);
    } else await tx.platformSetting.create({ data: { key, value_json, updated_by: owner } });
    return result;
  });
}
export async function listUiDocuments(owner: string, kind: string, cursor?: string) {
  const prefix = `ui-design:v1:${owner}:${kind}:`;
  if (cursor && !cursor.startsWith(prefix)) throw new AuthError('分页位置无效', 400);
  const rows = await prisma.platformSetting.findMany({ where: { key: { startsWith: prefix, ...(cursor ? { gt: cursor } : {}) } }, orderBy: { key: 'asc' }, take: 21 });
  const page = rows.slice(0, 20).map(row => JSON.parse(row.value_json) as UiDocument);
  return { records: page.filter(doc => !doc.archived).map(doc => ({ id: doc.id, revision: doc.revision, updatedAt: doc.updatedAt,
    name: doc.data.name || doc.data.state?.projectName || '未命名设计', projectId: doc.data.projectId || null })), nextCursor: rows.length > 20 ? rows[19].key : null };
}
