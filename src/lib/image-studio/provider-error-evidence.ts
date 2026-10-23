import { prisma } from '@/lib/prisma';
import type { ImageStudioTask, Prisma } from '@prisma/client';
import { readStudioAsyncReceipt, readStudioRequestReceipt } from './delivery';
import { MAX_PROVIDER_ERROR_BYTES, mergeStudioProviderErrorDiagnostics, parseStudioProviderErrorDiagnostics,
  providerErrorId, providerErrorObject, sameStudioProviderErrorBinding, sanitizeStudioProviderErrorFrozen,
  type StudioProviderErrorBinding, type StudioProviderErrorFrozen, type StudioProviderErrorObservation,
  type StudioProviderErrorReadResult } from './provider-error-diagnostics';

const PREFIX = 'image_provider_error_v1:';
type Client = Pick<Prisma.TransactionClient, 'platformSetting' | 'imageStudioTask'>;
function snapshotFor(task: ImageStudioTask): Record<string, unknown> {
  const snapshot: unknown = JSON.parse(task.snapshot_json || '{}');
  if (!providerErrorObject(snapshot)) throw new Error('provider_error_identity_invalid');
  return snapshot;
}
/** All identity comes from an independently loaded original task and its durable receipts. */
async function identityFor(task: ImageStudioTask): Promise<{ binding: StudioProviderErrorBinding; frozen: StudioProviderErrorFrozen }> {
  const snapshot = snapshotFor(task), channel = providerErrorObject(snapshot.imageChannel) ? snapshot.imageChannel : null;
  if (!providerErrorId(task.id) || !providerErrorId(task.owner_id) || !/^[a-f0-9]{64}$/.test(task.fingerprint)) throw new Error('provider_error_identity_invalid');
  const channelId = channel ? providerErrorId(channel.channelId) : null, configRevision = channel ? providerErrorId(channel.configRevision) : null;
  if (channel && (!channelId || !configRevision)) throw new Error('provider_error_identity_invalid');
  const receipt = await readStudioRequestReceipt(task);
  if (receipt && (receipt.taskId !== task.id || receipt.ownerId !== task.owner_id || receipt.batchId !== task.batch_id
    || receipt.fingerprint !== task.fingerprint || receipt.localRequestId !== (snapshot.requestId || task.batch_id)
    || (receipt.channelId || null) !== channelId || (receipt.configRevision || null) !== configRevision
    || !providerErrorId(receipt.localRequestId))) throw new Error('provider_error_identity_invalid');
  const asyncReceipt = channel ? await readStudioAsyncReceipt(task) : null;
  return { binding: { taskId: task.id, ownerId: task.owner_id, fingerprint: task.fingerprint, channelId, configRevision,
    localRequestId: receipt ? receipt.localRequestId : null, providerTaskId: asyncReceipt?.providerTaskId || null },
    frozen: sanitizeStudioProviderErrorFrozen({ model: task.model, resolution: snapshot.resolution,
      requestedRatio: task.aspect_ratio, resolvedRatio: snapshot.resolvedAspectRatio, expectedSize: task.output_size }) };
}
function sameTask(a: ImageStudioTask, b: ImageStudioTask) {
  return a.id === b.id && a.owner_id === b.owner_id && a.fingerprint === b.fingerprint && a.snapshot_json === b.snapshot_json
    && a.batch_id === b.batch_id && a.model === b.model && a.output_size === b.output_size && a.aspect_ratio === b.aspect_ratio;
}
/** Short independent CAS only. No business row is written and no ledger transaction waits on logging. */
export async function recordStudioProviderErrorDiagnostics(task: ImageStudioTask, observation: StudioProviderErrorObservation) {
  const original = await prisma.imageStudioTask.findUnique({ where: { id: task.id } });
  if (!original || !sameTask(original, task) || !task.lease_token || original.lease_token !== task.lease_token
    || original.status !== task.status || !original.lease_until || original.lease_until <= new Date()) throw new Error('provider_error_writer_stale');
  const identity = await identityFor(original);
  const key = `${PREFIX}${task.id}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const saved = await prisma.$transaction(async (tx: Client) => {
        const held = await tx.imageStudioTask.findFirst({ where: { id: original.id, owner_id: original.owner_id,
          fingerprint: original.fingerprint, snapshot_json: original.snapshot_json, status: original.status,
          lease_token: task.lease_token, lease_until: { gt: new Date() } }, select: { id: true } });
        if (!held) throw new Error('provider_error_writer_stale');
        const row = await tx.platformSetting.findUnique({ where: { key }, select: { id: true, value_json: true } });
        if (!row && observation.onlyIfRecorded) return true;
        const current = row ? parseStudioProviderErrorDiagnostics(row.value_json, identity.binding) : null;
        // Never overwrite an unreadable record: it may be an incompatible or differently bound writer.
        if (row && !current) throw new Error('provider_error_record_invalid');
        const value_json = JSON.stringify(mergeStudioProviderErrorDiagnostics(current, identity.binding, identity.frozen, observation));
        if (Buffer.byteLength(value_json) > MAX_PROVIDER_ERROR_BYTES) throw new Error('provider_error_record_oversize');
        if (!row) { await tx.platformSetting.create({ data: { key, value_json, updated_by: original.owner_id } }); return true; }
        return (await tx.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json }, data: { value_json } })).count === 1;
      }, { maxWait: 1000, timeout: 2000 });
      if (saved) return;
    } catch (error) {
      if ((error as { code?: string })?.code !== 'P2002' || attempt === 1) throw error;
    }
  }
  throw new Error('provider_error_cas_conflict');
}
/** Shared by all worker paths; diagnostics failure is isolated from original response/settlement durability. */
export function createStudioProviderErrorRecorder(task: ImageStudioTask) {
  let serial: Promise<void> = Promise.resolve();
  return (observation: StudioProviderErrorObservation): Promise<void> => {
    serial = serial.then(() => recordStudioProviderErrorDiagnostics(task, observation)).catch(() => {
      console.warn('[image-provider-error]', JSON.stringify({ taskId: task.id, code: 'capture_unavailable' }));
    });
    return serial;
  };
}
/** Caller performs admin authorization first. Recheck schema, byte limits and task binding on every read. */
export async function readStudioProviderErrorDiagnostics(taskId: string): Promise<StudioProviderErrorReadResult> {
  try {
    if (!providerErrorId(taskId)) return { state: 'unavailable', diagnostics: null };
    const task = await prisma.imageStudioTask.findUnique({ where: { id: taskId } });
    if (!task) return { state: 'not_collected', diagnostics: null };
    const row = await prisma.platformSetting.findUnique({ where: { key: `${PREFIX}${task.id}` }, select: { value_json: true } });
    if (!row) return { state: 'not_collected', diagnostics: null };
    const identity = await identityFor(task);
    const diagnostics = parseStudioProviderErrorDiagnostics(row.value_json, identity.binding);
    if (!diagnostics || !sameStudioProviderErrorBinding(diagnostics.binding, identity.binding)) return { state: 'unavailable', diagnostics: null };
    // A receipt that became available later can strengthen, but never replace, the original identity.
    if (diagnostics.binding.providerTaskId !== null && diagnostics.binding.providerTaskId !== identity.binding.providerTaskId) return { state: 'unavailable', diagnostics: null };
    diagnostics.frozen = identity.frozen;
    return { state: 'recorded', diagnostics };
  } catch { return { state: 'unavailable', diagnostics: null }; }
}
