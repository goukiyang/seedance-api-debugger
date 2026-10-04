import { prisma } from '@/lib/prisma';
const prefix = (owner: string) => `asset-library-removal:v1:${owner}:`;
export async function removedLibraryAssetIds(owner: string) {
  const rows = await prisma.platformSetting.findMany({ where: { key: { startsWith: prefix(owner) } }, select: { key: true, value_json: true } });
  return rows.filter(row => JSON.parse(row.value_json).removed === true).map(row => row.key.slice(prefix(owner).length));
}
export async function setLibraryAssetRemoved(owner: string, id: string, removed: boolean) {
  if (typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('素材编号无效');
  const asset = await prisma.asset.findFirst({ where: { id, owner_id: owner, status: 'active' } });
  if (!asset) throw new Error('只能删除自己拥有且仍可使用的素材');
  const key = `${prefix(owner)}${id}`, value_json = JSON.stringify({ removed, updatedAt: new Date().toISOString() });
  await prisma.platformSetting.upsert({ where: { key }, create: { key, value_json, updated_by: owner }, update: { value_json, updated_by: owner } });
}
