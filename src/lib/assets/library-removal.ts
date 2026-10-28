import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import { USER_VISIBLE_TASK_RETENTION_STATUSES } from '@/lib/tasks/retention';

const prefix = (owner: string) => `asset-library-removal:v1:${owner}:`;
// Separate keys keep new resource markers intact when running the 0.41.0 helper.
const resourcePrefix = (owner: string) => `resource-library-removal:v1:${owner}:`;
const identityPattern = /^(asset|video_task|reference_image):([a-zA-Z0-9_-]{1,100})$/;
export type LibraryRemovals = { asset: string[]; video_task: string[]; reference_image: string[] };
export type LibraryRemovalState = { identity: string; status: 'removed' | 'available' | 'unavailable' };

export async function readOwnLibraryRemovalStates(owner: string, identities: string[], db: Prisma.TransactionClient = prisma): Promise<LibraryRemovalState[]> {
  if (!Array.isArray(identities) || identities.length > 60 || identities.some(value => typeof value !== 'string' || !identityPattern.test(value))) throw new Error('素材编号无效');
  const unique = [...new Set(identities)];
  const ids = (kind: string) => unique.filter(identity => identity.startsWith(`${kind}:`)).map(identity => identity.slice(kind.length + 1));
  const available = new Set<string>();
  const assets = ids('asset'), tasks = ids('video_task'), references = ids('reference_image');
  if (assets.length) for (const row of await db.asset.findMany({ where: { id: { in: assets }, owner_id: owner, status: 'active' }, select: { id: true }, take: assets.length })) available.add(`asset:${row.id}`);
  if (tasks.length) for (const row of await db.videoTask.findMany({ where: { id: { in: tasks },
    OR: [{ owner_user_id: owner }, { owner_user_id: null, user_id: owner }], local_status: 'succeeded',
    retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] } }, select: { id: true }, take: tasks.length })) available.add(`video_task:${row.id}`);
  if (references.length) for (const row of await db.referenceImage.findMany({ where: { id: { in: references }, owner_user_id: owner,
    asset_id: null, status: 'active', album: { status: 'active' } }, select: { id: true }, take: references.length })) available.add(`reference_image:${row.id}`);
  const markerKey = (identity: string) => identity.startsWith('asset:') ? `${prefix(owner)}${identity.slice(6)}` : `${resourcePrefix(owner)}${identity}`;
  const keys = [...available].map(markerKey);
  const rows = keys.length ? await db.platformSetting.findMany({ where: { key: { in: keys } }, select: { key: true, value_json: true }, take: keys.length }) : [];
  const removed = new Set(rows.filter(row => JSON.parse(row.value_json)?.removed === true).map(row => row.key));
  return unique.map<LibraryRemovalState>(identity => ({ identity, status: !available.has(identity) ? 'unavailable' : removed.has(markerKey(identity)) ? 'removed' : 'available' }));
}

export async function removedLibraryResources(owner: string): Promise<LibraryRemovals> {
  const rows = await prisma.platformSetting.findMany({ where: { OR: [
    { key: { startsWith: prefix(owner) } }, { key: { startsWith: resourcePrefix(owner) } },
  ] }, select: { key: true, value_json: true } });
  const result: LibraryRemovals = { asset: [], video_task: [], reference_image: [] };
  for (const row of rows) {
    if (JSON.parse(row.value_json)?.removed !== true) continue;
    const identity = row.key.startsWith(prefix(owner))
      ? `asset:${row.key.slice(prefix(owner).length)}` : row.key.slice(resourcePrefix(owner).length);
    const match = identityPattern.exec(identity);
    if (match) result[match[1] as keyof LibraryRemovals].push(match[2]);
  }
  return result;
}

export async function setLibraryResourceRemoved(owner: string, identity: unknown, removed: boolean) {
  const match = typeof identity === 'string' ? identityPattern.exec(identity) : null;
  if (!match) throw new Error('素材编号无效');
  const [, kind, id] = match;
  const owned = kind === 'asset'
    ? await prisma.asset.findFirst({ where: { id, owner_id: owner, ...(removed ? { status: 'active' } : {}) }, select: { id: true } })
    : kind === 'video_task'
      ? await prisma.videoTask.findFirst({ where: { id,
        OR: [{ owner_user_id: owner }, { owner_user_id: null, user_id: owner }],
        ...(removed ? { local_status: 'succeeded', retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] } } : {}),
      }, select: { id: true } })
      : await prisma.referenceImage.findFirst({ where: { id, owner_user_id: owner,
        ...(removed ? { asset_id: null, status: 'active', album: { status: 'active' } } : {}),
      }, select: { id: true } });
  if (!owned) throw new Error('只能操作自己拥有的素材；资源可能已失效或归属已变更');
  const key = kind === 'asset' ? `${prefix(owner)}${id}` : `${resourcePrefix(owner)}${identity}`;
  const value_json = JSON.stringify({ removed, updatedAt: new Date().toISOString() });
  await prisma.platformSetting.upsert({ where: { key }, create: { key, value_json, updated_by: owner }, update: { value_json, updated_by: owner } });
}
