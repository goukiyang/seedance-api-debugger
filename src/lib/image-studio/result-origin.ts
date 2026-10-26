import { prisma } from '../prisma';

/** First direct (primary) input image of the user's own image-studio task whose output is this asset; null if none. */
export async function studioResultOriginAsset(ownerId: string, resultAssetId: string, client: Pick<typeof prisma, 'imageStudioTask'> = prisma) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(resultAssetId)) return null;
  const task = await client.imageStudioTask.findFirst({ where: { owner_id: ownerId, asset_id: resultAssetId }, orderBy: { created_at: 'desc' }, select: { snapshot_json: true } });
  try {
    const snapshot = JSON.parse(task?.snapshot_json || '{}') as { primaryReferenceImages?: Array<{ id?: unknown }> };
    const id = snapshot.primaryReferenceImages?.find(item => typeof item?.id === 'string')?.id;
    return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id) && id !== resultAssetId ? id : null;
  } catch { return null; }
}
