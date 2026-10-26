import { prisma } from '@/lib/prisma';
import { studioOutputTaskWhere, studioTaskHasViewableOutput } from '@/lib/image-studio/dimension-mismatch';
import { requestHd } from './hd-derivatives';

const safeFailure = (error: unknown) => {
  const code = error instanceof Error ? error.message : '';
  return ['source_missing', 'source_unreadable', 'hd_registration_pending', 'invalid_hd_manifest',
    'hd_storage_unavailable', 'hd_storage_root_invalid', 'hd_storage_root_not_configured'].includes(code)
    ? code : 'registration_unavailable';
};

// Call only after the outer asset/task/settlement transaction has committed.
// A fresh read prevents rolled-back or merely prepared files entering the queue.
// Registration cannot change delivery or billing, and bounded discovery remains
// responsible for a crash or a failed registration between commit and this call.
export async function registerCommittedStudioHd(taskId: string): Promise<boolean> {
  try {
    const task = await prisma.imageStudioTask.findFirst({
      where: { id: taskId, deleted_at: null, AND: [studioOutputTaskWhere] },
      select: { status: true, asset_id: true, usage_json: true, owner_id: true },
    });
    if (!task || !studioTaskHasViewableOutput(task) || !task.asset_id) return false;
    const asset = await prisma.asset.findFirst({
      where: { id: task.asset_id, owner_id: task.owner_id, type: 'image', status: 'active' },
      select: { id: true, owner_id: true, original_url: true, metadata_json: true },
    });
    if (!asset) return false;
    let preserveText = false;
    try { preserveText = JSON.parse(asset.metadata_json || '{}').preserveText === true; }
    catch { /* Missing legacy metadata does not alter the original. */ }
    const job = await requestHd(asset.original_url, 0, preserveText, undefined,
      { owner: { kind: 'asset', id: asset.id, ownerId: asset.owner_id } });
    if (!job) console.error('[studio-hd-registration]', JSON.stringify({ taskId, code: 'source_version_unknown' }));
    return Boolean(job);
  } catch (error) {
    // Do not include paths, source URLs, supplier responses or stacks here.
    console.error('[studio-hd-registration]', JSON.stringify({ taskId, code: safeFailure(error) }));
    return false;
  }
}
