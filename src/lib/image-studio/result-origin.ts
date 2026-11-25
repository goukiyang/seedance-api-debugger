import { prisma } from '../prisma';
import { frozenStudioInputMainIds } from './input-main';

export type StudioResultOrigin = { state: 'ready'; assetId: string }
  | { state: 'not-generated' | 'none' | 'unknown' | 'multiple' };

/** Only the unique, explicitly frozen direct input of this owner's exact result. */
export async function studioResultOrigin(ownerId: string, resultAssetId: string,
  client: Pick<typeof prisma, 'imageStudioTask'> = prisma): Promise<StudioResultOrigin> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(resultAssetId)) return { state: 'unknown' };
  const task = await client.imageStudioTask.findFirst({ where: { owner_id: ownerId, asset_id: resultAssetId, deleted_at: null },
    orderBy: { created_at: 'desc' }, select: { snapshot_json: true, reference_ids: true } });
  if (!task) return { state: 'not-generated' };
  const ids = frozenStudioInputMainIds(task.snapshot_json, task.reference_ids);
  if (ids === null || ids.includes(resultAssetId)) return { state: 'unknown' };
  if (!ids.length) return { state: 'none' };
  if (ids.length !== 1) return { state: 'multiple' };
  return { state: 'ready', assetId: ids[0] };
}

export async function studioResultOriginAsset(ownerId: string, resultAssetId: string,
  client: Pick<typeof prisma, 'imageStudioTask'> = prisma) {
  const origin = await studioResultOrigin(ownerId, resultAssetId, client);
  return origin.state === 'ready' ? origin.assetId : null;
}
