import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';
import { assertMultiviewWorkReference } from './multiview-works';
import { isMultiviewWorkFileRole } from './multiview-work-contract';

/** Historical groups are proven only by existing registration receipts. No
 * production history is rewritten, and ordinary uploads sharing bytes survive. */
export async function multiviewOutputGroups(user: SessionUser, removedIds: string[] = []) {
  const owner = await prisma.user.findUnique({ where: { id: user.id }, select: { id: true, name: true, username: true, email: true } });
  const works = await prisma.multiviewWork.findMany({ where: { owner_id: user.id, save_state: { not: 'intent' } }, orderBy: { created_at: 'desc' } });
  const groups = [], dedicatedIds = new Set<string>();
  const removed = new Set(removedIds);
  for (const work of works) {
    try { await assertMultiviewWorkReference(user, work); }
    catch (error) { if (error instanceof AuthError && [403, 404].includes(error.status)) continue; throw error; }
    const receipts = await prisma.platformSetting.findMany({ where: { key: { startsWith: `multiview_output_registration_v1:receipt:${work.id}:` } }, select: { value_json: true } });
    const candidates = receipts.flatMap(row => {
      try {
        const value = JSON.parse(row.value_json);
        if (value.schema !== 1 || value.state !== 'registered' || value.ownerId !== user.id || value.workId !== work.id
          || !Number.isSafeInteger(value.readyRevision) || !Array.isArray(value.outputs)) return [];
        return [value as { readyRevision: number; outputs: Array<{ state: string; role: string; assetId: string; sha256: string }> }];
      } catch { return []; }
    }).sort((a, b) => Number(b.outputs.every(value => value.state === 'registered')) - Number(a.outputs.every(value => value.state === 'registered')) || b.readyRevision - a.readyRevision);
    let selected = false;
    for (const candidate of candidates) {
      const output = candidate.outputs;
      if (![4, 5, 9].includes(output.length) || output.some(value => !['registered', 'unavailable'].includes(value.state) || typeof value.assetId !== 'string')
        || new Set(output.map(value => value.role)).size !== output.length || !output.some(value => value.role === 'collage')
        || output.filter(value => value.role.startsWith('frame-') && isMultiviewWorkFileRole(value.role)).length !== output.length - 1) continue;
      const assets = await prisma.asset.findMany({ where: { id: { in: output.map(value => value.assetId) }, owner_id: user.id } });
      const byId = new Map(assets.map(asset => [asset.id, asset]));
      for (const asset of assets) {
        try { if (JSON.parse(asset.metadata_json || '{}').source === 'multiview-output') dedicatedIds.add(asset.id); } catch { /* Ordinary uploads remain visible. */ }
      }
      if (selected) continue;
      const readable = new Set<string>();
      for (const entry of output) {
        const asset = byId.get(entry.assetId);
        if (entry.state === 'registered' && asset && asset.status === 'active' && !removed.has(asset.id) && asset.hash === entry.sha256 && await canReadStudioAsset(user, asset)) readable.add(asset.id);
      }
      const sorted = output.slice().sort((a, b) => a.role === 'collage' ? -1 : b.role === 'collage' ? 1 : a.role.localeCompare(b.role, undefined, { numeric: true }));
      for (const asset of assets) {
        try { if (JSON.parse(asset.metadata_json || '{}').source === 'multiview-output') dedicatedIds.add(asset.id); } catch { /* Unproven ordinary assets remain visible. */ }
      }
      const available = sorted.filter(entry => readable.has(entry.assetId));
      if (!work.removed_at) groups.push({ work, revision: candidate.readyRevision, assets: available.map(entry => ({ ...byId.get(entry.assetId)!, owner })),
        roles: available.map(entry => entry.role), frameCount: output.length - 1, missing: output.length - available.length,
        syncing: work.ready_revision !== candidate.readyRevision || output.some(value => value.state !== 'registered'), coverAssetId: available.find(entry => entry.role === 'collage')?.assetId || null });
      selected = true;
    }
  }
  return { groups, dedicatedIds };
}
