import { prisma } from '../prisma';
import { frozenStudioInputMainIds } from './input-main';

export type StudioResultOrigin = { state: 'ready'; assetId: string }
  | { state: 'not-generated' | 'none' | 'unknown' | 'multiple' };

/** Only the unique direct input recorded for this owner's exact result. */
export async function studioResultOrigin(ownerId: string, resultAssetId: string,
  client: Pick<typeof prisma, 'imageStudioTask'> = prisma): Promise<StudioResultOrigin> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(resultAssetId)) return { state: 'unknown' };
  const task = await client.imageStudioTask.findFirst({ where: { owner_id: ownerId, asset_id: resultAssetId, deleted_at: null },
    orderBy: { created_at: 'desc' }, select: { snapshot_json: true, reference_ids: true } });
  if (!task) return { state: 'not-generated' };
  const ids = frozenStudioInputMainIds(task.snapshot_json, task.reference_ids)
    ?? legacyStudioCoverInput(task.snapshot_json, task.reference_ids);
  if (ids === null || ids.includes(resultAssetId)) return { state: 'unknown' };
  if (!ids.length) return { state: 'none' };
  if (ids.length !== 1) return { state: 'multiple' };
  return { state: 'ready', assetId: ids[0] };
}

function legacyStudioCoverInput(snapshotJson: string | null, referenceIdsJson: string): string[] | null {
  try {
    const snapshot = JSON.parse(snapshotJson ?? 'null') as { version?: unknown; referenceImages?: unknown } | null;
    if (!snapshot || snapshot.version !== 1) return null;
    // Before input roles existed, both fields stored the same direct input list.
    const roleFields = ['referencePolicy', 'primaryReferenceImages', 'auxiliaryReferenceImages',
      'fixedReferenceImages', 'templateReferenceImages', 'styleGroupIds', 'styleGroups'];
    if (roleFields.some(field => Object.hasOwn(snapshot, field))) return null;

    const actual = JSON.parse(referenceIdsJson) as unknown;
    const frozen = snapshot.referenceImages;
    if (!Array.isArray(actual) || actual.length !== 1 || !Array.isArray(frozen) || frozen.length !== 1) return null;
    const [id] = actual;
    const [reference] = frozen;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,120}$/.test(id) || !reference
      || typeof reference !== 'object' || Object.hasOwn(reference, 'referenceRole') || reference.id !== id) return null;
    return [id];
  } catch {
    return null;
  }
}

export async function studioResultOriginAsset(ownerId: string, resultAssetId: string,
  client: Pick<typeof prisma, 'imageStudioTask'> = prisma) {
  const origin = await studioResultOrigin(ownerId, resultAssetId, client);
  return origin.state === 'ready' ? origin.assetId : null;
}
