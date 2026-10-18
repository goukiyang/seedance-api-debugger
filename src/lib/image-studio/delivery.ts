import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { MAX_STUDIO_GENERATED_BYTES, MAX_STUDIO_GENERATED_BASE64, STUDIO_RECOVERY_MS, STUDIO_CHECKPOINT_RETENTION_MS, STUDIO_MAX_DOWNLOAD_ATTEMPTS, STUDIO_DOWNLOAD_WINDOW_MS, STUDIO_DOWNLOAD_EXTENDED_MS } from './limits';
import { prisma } from '@/lib/prisma';
import { openStudioImageStream, classifyStudioDownloadError, StudioImageDownloadError, type StudioDownloadDiagnostics } from './media';
import { studioGenerationDetailSuperseded } from './delivery-display';
import { cleanupStudioResponseEvidence } from './response-evidence';
import { studioOutputMismatch as studioDimensionMismatch, studioTaskHasViewableOutput } from './dimension-mismatch';
import { validStudioProviderWait, type StudioProviderWait } from './provider-wait';

const root = () => path.join(process.cwd(), 'storage', 'studio-delivery');
let lastCleanup = 0;
type Identity = { id: string; owner_id: string };
export type StudioDelivery = {
  taskId: string; ownerId: string; url: string; usage: unknown; expiresAt: number;
  attempts: number; etag?: string; expectedBytes?: number; complete?: boolean;
  kind?: 'url' | 'base64'; receivedBytes?: number;
  outputHash?: string;
  recoveries?: number;
  phase?: 'download' | 'recover' | 'validate' | 'save' | 'stopped'; code?: string;
  validation?: { originalFormat: string; storedFormat: string; width: number; height: number; requestedSize?: string; transparentPixels?: number };
};
function directory(id: string, billing = false) {
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(id)) throw new Error('Invalid delivery identity');
  return path.join(billing ? path.join(process.cwd(), 'storage', 'studio-billing') : root(), id);
}
async function writePrivate(id: string, name: string, bytes: string | Buffer, billing = false) {
  const dir = directory(id, billing);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(dir), 0o700);
  await fs.chmod(dir, 0o700);
  const temporary = path.join(dir, `${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, path.join(dir, name));
    const folder = await fs.open(dir, 'r');
    try { await folder.sync(); } finally { await folder.close(); }
  } finally { await fs.unlink(temporary).catch(() => {}); }
}
async function save(record: StudioDelivery) { await writePrivate(record.taskId, 'source.json', JSON.stringify(record)); }

export type StudioReceipt = { taskId: string; ownerId: string; localRequestId: string; batchId: string; fingerprint: string;
  submittedAt: number; returnedAt?: number; status?: number; upstreamRequestId?: string; headerName?: string;
  gatewayRequestId?: string; billingScope?: string | null; channelId?: string; configRevision?: string;
  dispatchState?: 'prepared' | 'held' | 'attempted'; inputManifest?: StudioInputManifest };
type AsyncIdentity = Identity & { snapshot_json: string | null };
export type StudioAsyncReceipt = StudioProviderWait & { schema: 'image.async-receipt.v1' | 'image.async-receipt.v2'; taskId: string; ownerId: string;
  channelId: string; configRevision: string; providerTaskId: string; pollAfterMs: number; acceptedAt: number;
  localRequestId?: string; fingerprint?: string;
  resultReady?: true;
  expiresAt?: string; state: 'accepted' | 'success' | 'failed'; waitingStatus?: 'pending' | 'retrying' | 'unconfirmed' };
export type StudioInputManifest = { schema: 'image.input-manifest.v1'; entries: Array<{ id: string; ownerId: string; ordinal: number;
  sourceSha256: string; sourceBytes: number; frozenHashMatched: boolean | null; sourceVersion?: string;
  normalizedSha256: string; normalizedBytes: number; mimeType: 'image/png' }> };
type CoreTask = AsyncIdentity & { batch_id: string; fingerprint: string; billing_scope?: string | null };
export type StudioCorePending = { schema: 'image.core-pending.v1'; request: StudioReceipt; async?: StudioAsyncReceipt };
export type StudioCoreReceiptAdapters = {
  updateBilling?: (receipt: StudioReceipt) => Promise<void>;
  fault?: (stage: 'pending-request' | 'pending-billing' | 'request' | 'request-billing' | 'async' | 'async-billing' | 'database') => void | Promise<void>;
};
export class StudioCoreReceiptError extends Error {
  providerNotBefore?: number;
  constructor(public readonly code: 'core_receipt_pending' | 'core_receipt_identity_conflict', public readonly durable: boolean) {
    super(code); this.name = 'StudioCoreReceiptError';
  }
}
function newContract(task: AsyncIdentity) {
  try { return JSON.parse(task.snapshot_json || '{}').ratioContractVersion === 3; } catch { return false; }
}
function sameRequestIdentity(a: StudioReceipt, b: StudioReceipt) {
  return ['taskId', 'ownerId', 'localRequestId', 'batchId', 'fingerprint', 'submittedAt', 'channelId', 'configRevision', 'billingScope']
    .every(key => a[key as keyof StudioReceipt] === b[key as keyof StudioReceipt]);
}
function mergeAsyncObservations(a: StudioAsyncReceipt, b: StudioAsyncReceipt): StudioAsyncReceipt {
  if (['schema', 'taskId', 'ownerId', 'channelId', 'configRevision', 'providerTaskId', 'acceptedAt', 'expiresAt', 'localRequestId', 'fingerprint']
    .some(key => a[key as keyof StudioAsyncReceipt] !== b[key as keyof StudioAsyncReceipt])
    || a.state !== 'accepted' && b.state !== 'accepted' && a.state !== b.state) throw new StudioCoreReceiptError('core_receipt_identity_conflict', true);
  const later = (a.providerNotBefore || 0) >= (b.providerNotBefore || 0) ? a : b;
  return { ...a, pollAfterMs: Math.max(a.pollAfterMs, b.pollAfterMs), state: a.state === 'accepted' ? b.state : a.state,
    ...(a.resultReady || b.resultReady ? { resultReady: true } : {}),
    ...(later.providerNotBefore ? { providerNotBefore: later.providerNotBefore,
      providerWaitSource: a.providerWaitSource === 'invalid-conservative' || b.providerWaitSource === 'invalid-conservative'
        ? 'invalid-conservative' : later.providerWaitSource } : {}) };
}
function assertCoreIdentity(task: CoreTask, pending: StudioCorePending) {
  const receipt = pending.request, expected = asyncIdentity(task);
  let requestId: unknown; try { requestId = JSON.parse(task.snapshot_json || '{}').requestId; } catch {}
  if (pending.schema !== 'image.core-pending.v1' || !receipt || receipt.taskId !== task.id || receipt.ownerId !== task.owner_id
    || receipt.batchId !== task.batch_id || receipt.fingerprint !== task.fingerprint || receipt.localRequestId !== (requestId || task.batch_id)
    || receipt.channelId !== expected.channelId || receipt.configRevision !== expected.configRevision
    || receipt.billingScope !== task.billing_scope || !Number.isSafeInteger(receipt.submittedAt)
    || receipt.status !== undefined && (!Number.isSafeInteger(receipt.status) || receipt.status < 100 || receipt.status > 599)
    || receipt.returnedAt !== undefined && (!Number.isSafeInteger(receipt.returnedAt) || receipt.returnedAt < receipt.submittedAt)
    || pending.async && (pending.async.taskId !== task.id || pending.async.ownerId !== task.owner_id
      || pending.async.channelId !== expected.channelId || pending.async.configRevision !== expected.configRevision
      || pending.async.localRequestId !== receipt.localRequestId || pending.async.fingerprint !== receipt.fingerprint
      || !/^[a-zA-Z0-9_-]{1,180}$/.test(pending.async.providerTaskId) || !validStudioProviderWait(pending.async))) {
    throw new StudioCoreReceiptError('core_receipt_identity_conflict', true);
  }
}
async function readBoundedCoreFile(task: Identity, name: string, billing: boolean) {
  const file = path.join(directory(task.id, billing), name);
  try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) throw new Error('core_receipt_invalid');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function readStudioCorePending(task: CoreTask): Promise<StudioCorePending | null> {
  let found: StudioCorePending | null = null;
  for (const billing of [false, true]) {
    const value = await readBoundedCoreFile(task, 'core-pending.json', billing) as StudioCorePending | null;
    if (!value) continue;
    assertCoreIdentity(task, value);
    if (found && (!sameRequestIdentity(found.request, value.request)
      || found.request.gatewayRequestId && value.request.gatewayRequestId && found.request.gatewayRequestId !== value.request.gatewayRequestId
      || found.async && value.async && found.async.providerTaskId !== value.async.providerTaskId)) throw new StudioCoreReceiptError('core_receipt_identity_conflict', true);
    if (found?.async && value.async) { found = { ...(found as StudioCorePending), async: mergeAsyncObservations(found.async, value.async) }; continue; }
    // A crash between the two writes may leave one copy at headers-only.
    found = !found || value.async && !found.async || (value.async?.providerNotBefore || 0) > (found.async?.providerNotBefore || 0)
      || value.async?.resultReady && !found.async?.resultReady
      || !found.request.returnedAt ? value : found;
  }
  return found;
}
async function writeCorePending(task: CoreTask, pending: StudioCorePending, adapters: StudioCoreReceiptAdapters) {
  assertCoreIdentity(task, pending);
  const bytes = JSON.stringify(pending);
  if (Buffer.byteLength(bytes) > 32768) throw new Error('core_receipt_size_limit');
  let durable = false, failure: unknown;
  for (const billing of [false, true]) {
    try { await adapters.fault?.(billing ? 'pending-billing' : 'pending-request'); await writePrivate(task.id, 'core-pending.json', bytes, billing); durable = true; }
    catch (error) { failure = error; }
  }
  if (failure) throw new StudioCoreReceiptError('core_receipt_pending', durable);
}
async function applyCorePending(task: CoreTask, pending: StudioCorePending, adapters: StudioCoreReceiptAdapters) {
  assertCoreIdentity(task, pending);
  for (const billing of [false, true]) {
    const request = await readBoundedCoreFile(task, 'request.json', billing) as StudioReceipt | null;
    if (request && (!sameRequestIdentity(request, pending.request)
      || request.gatewayRequestId && request.gatewayRequestId !== pending.request.gatewayRequestId
      || request.upstreamRequestId && request.upstreamRequestId !== pending.request.upstreamRequestId
      || request.status !== undefined && request.status !== pending.request.status)) throw new StudioCoreReceiptError('core_receipt_identity_conflict', true);
    const async = await readBoundedCoreFile(task, 'async.json', billing) as StudioAsyncReceipt | null;
    if (async && (!pending.async || async.providerTaskId !== pending.async.providerTaskId || async.ownerId !== task.owner_id
      || async.channelId !== pending.async.channelId || async.configRevision !== pending.async.configRevision
      || async.acceptedAt !== pending.async.acceptedAt || async.expiresAt !== pending.async.expiresAt
      || async.localRequestId !== pending.async.localRequestId || async.fingerprint !== pending.async.fingerprint)) throw new StudioCoreReceiptError('core_receipt_identity_conflict', true);
    if (async && pending.async) pending = { ...pending, async: mergeAsyncObservations(async, pending.async) };
  }
  try {
    for (const billing of [false, true]) {
      await adapters.fault?.(billing ? 'request-billing' : 'request');
      await writePrivate(task.id, 'request.json', JSON.stringify(pending.request), billing);
      if (pending.async) { await adapters.fault?.(billing ? 'async-billing' : 'async'); await writePrivate(task.id, 'async.json', JSON.stringify(pending.async), billing); }
    }
    await adapters.fault?.('database');
    await (adapters.updateBilling || updateStudioCoreBilling)(pending.request);
  } catch (error) { if (error instanceof StudioCoreReceiptError) throw error; throw new StudioCoreReceiptError('core_receipt_pending', true); }
  // Removing either completed sidecar is safe: all core copies and DB association already exist.
  for (const billing of [false, true]) await fs.unlink(path.join(directory(task.id, billing), 'core-pending.json')).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  return pending.async || null;
}
async function updateStudioCoreBilling(receipt: StudioReceipt) {
  if (!receipt.billingScope || receipt.status === undefined) return;
  const current = await prisma.imageStudioTask.findUnique({ where: { id: receipt.taskId } });
  if (!current || current.owner_id !== receipt.ownerId || current.batch_id !== receipt.batchId || current.fingerprint !== receipt.fingerprint
    || current.billing_scope !== receipt.billingScope || current.gateway_request_id && current.gateway_request_id !== receipt.gatewayRequestId) {
    throw new StudioCoreReceiptError('core_receipt_identity_conflict', true);
  }
  if (current.billing_settled_at || current.actual_credits !== null) return; // Never reopen a completed accounting decision.
  const prefix = receipt.channelId && receipt.channelId !== 'original' ? 'channel_' : '';
  if (current.gateway_request_id === (receipt.gatewayRequestId || null)
    && ![`${prefix}awaiting_response`, null].includes(current.billing_status)) return;
  const changed = await prisma.imageStudioTask.updateMany({ where: { id: receipt.taskId, owner_id: receipt.ownerId,
    batch_id: receipt.batchId, fingerprint: receipt.fingerprint, billing_scope: receipt.billingScope, billing_settled_at: null, actual_credits: null,
    billing_status: current.billing_status,
    OR: [{ gateway_request_id: null }, { gateway_request_id: receipt.gatewayRequestId || null }] },
    data: { gateway_request_id: receipt.gatewayRequestId || null,
      billing_status: `${prefix}${receipt.gatewayRequestId ? 'pending' : 'unmatched'}`, billing_next_check_at: new Date() } });
  if (!changed.count) throw new StudioCoreReceiptError('core_receipt_pending', true);
}
export async function repairStudioCoreReceipt(task: CoreTask, adapters: StudioCoreReceiptAdapters = {}) {
  try {
    const pending = await readStudioCorePending(task);
    return pending ? await applyCorePending(task, pending, adapters) : null;
  } catch (error) {
    if (error instanceof StudioCoreReceiptError) throw error;
    throw new StudioCoreReceiptError(error instanceof SyntaxError || error instanceof Error && error.message === 'core_receipt_invalid'
      ? 'core_receipt_identity_conflict' : 'core_receipt_pending', false);
  }
}
/** Internal recovery authority only; a prepared marker alone is never an accepted request. */
export async function hasStudioAcceptedRecoveryIdentity(task: CoreTask, async?: StudioAsyncReceipt | null, delivery?: StudioDelivery | null) {
  const request = await readStudioRequestReceipt(task);
  if (!request || request.taskId !== task.id || request.ownerId !== task.owner_id || request.batchId !== task.batch_id
    || request.fingerprint !== task.fingerprint || !request.returnedAt || !request.status || request.status < 200 || request.status >= 300
    || request.dispatchState === 'held') return false;
  let snapshot: Record<string, unknown>; try { snapshot = JSON.parse(task.snapshot_json || '{}'); } catch { return false; }
  if (request.localRequestId !== (snapshot.requestId || task.batch_id)) return false;
  if (async) {
    const expected = asyncIdentity(task);
    return request.channelId === expected.channelId && request.configRevision === expected.configRevision
      && async.taskId === task.id && async.ownerId === task.owner_id && async.channelId === expected.channelId
      && async.configRevision === expected.configRevision && /^[a-zA-Z0-9_-]{1,180}$/.test(async.providerTaskId);
  }
  return Boolean(delivery?.complete && delivery.taskId === task.id && delivery.ownerId === task.owner_id);
}
function asyncIdentity(task: AsyncIdentity) {
  let snapshot;
  try { snapshot = JSON.parse(task.snapshot_json || '{}').imageChannel; } catch {}
  if (!snapshot || typeof snapshot.channelId !== 'string' || typeof snapshot.configRevision !== 'string') throw new Error('Async channel identity unavailable');
  return { channelId: snapshot.channelId, configRevision: snapshot.configRevision };
}
export async function readStudioRequestReceipt(task: Identity): Promise<StudioReceipt | null> {
  let found: StudioReceipt | null = null;
  for (const billing of [false, true]) {
    try { const value = JSON.parse(await fs.readFile(path.join(directory(task.id, billing), 'request.json'), 'utf8')) as StudioReceipt;
      if (value.taskId !== task.id || value.ownerId !== task.owner_id) throw new Error('Request receipt ownership mismatch');
      if (found && (!sameRequestIdentity(found, value)
        || found.gatewayRequestId && value.gatewayRequestId && found.gatewayRequestId !== value.gatewayRequestId
        || found.upstreamRequestId && value.upstreamRequestId && found.upstreamRequestId !== value.upstreamRequestId
        || found.status !== undefined && value.status !== undefined && found.status !== value.status)) throw new Error('Request receipt identity conflict');
      if (!found || value.returnedAt && !found.returnedAt) found = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return found;
}
export async function readStudioAsyncReceipt(task: AsyncIdentity): Promise<StudioAsyncReceipt | null> {
  const expected = asyncIdentity(task);
  let found: StudioAsyncReceipt | null = null;
  let snapshot: Record<string, unknown> = {}; try { snapshot = JSON.parse(task.snapshot_json || '{}'); } catch {}
  for (const billing of [false, true]) {
    try { const value = JSON.parse(await fs.readFile(path.join(directory(task.id, billing), 'async.json'), 'utf8')) as StudioAsyncReceipt;
      if (!['image.async-receipt.v1', 'image.async-receipt.v2'].includes(value.schema) || value.taskId !== task.id || value.ownerId !== task.owner_id
        || value.channelId !== expected.channelId || value.configRevision !== expected.configRevision
        || !/^[a-zA-Z0-9_-]{1,180}$/.test(value.providerTaskId) || !Number.isFinite(value.acceptedAt)
        || !Number.isSafeInteger(value.pollAfterMs) || value.pollAfterMs < 2000 || value.pollAfterMs > 30000
        || (value.expiresAt !== undefined && (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))))
        || !['accepted', 'success', 'failed'].includes(value.state)
        || value.schema === 'image.async-receipt.v2' && !validStudioProviderWait(value)
        || value.schema === 'image.async-receipt.v2' && (value.localRequestId !== snapshot.requestId
          || value.fingerprint !== (task as CoreTask).fingerprint || value.resultReady !== undefined && value.resultReady !== true)
        || value.schema === 'image.async-receipt.v1' && (value.providerNotBefore !== undefined || value.providerWaitSource !== undefined || value.resultReady !== undefined)) throw new Error('Async receipt identity mismatch');
      if (found && (found.providerTaskId !== value.providerTaskId || found.acceptedAt !== value.acceptedAt || found.schema !== value.schema
        || found.expiresAt !== value.expiresAt || found.localRequestId !== value.localRequestId || found.fingerprint !== value.fingerprint)) throw new Error('Async receipt identity conflict');
      found = found ? mergeAsyncObservations(found, value) : value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return found;
}
export async function createStudioAsyncReceipt(task: AsyncIdentity, accepted: StudioProviderWait & { taskId: string; pollAfterMs?: number; expiresAt?: string }) {
  const identity = asyncIdentity(task);
  if (!/^[a-zA-Z0-9_-]{1,180}$/.test(accepted.taskId)) throw new Error('Invalid upstream task identity');
  const previous = await readStudioAsyncReceipt(task);
  if (previous) { if (previous.providerTaskId !== accepted.taskId) throw new Error('Async task identity changed'); return previous; }
  const receipt: StudioAsyncReceipt = { schema: newContract(task) ? 'image.async-receipt.v2' : 'image.async-receipt.v1', taskId: task.id, ownerId: task.owner_id, ...identity,
    providerTaskId: accepted.taskId, pollAfterMs: Math.min(30000, Math.max(2000, Math.floor(accepted.pollAfterMs || 2000))),
    ...(typeof accepted.expiresAt === 'string' && Number.isFinite(Date.parse(accepted.expiresAt)) ? { expiresAt: accepted.expiresAt } : {}),
    acceptedAt: Date.now(), state: 'accepted', waitingStatus: 'pending',
    ...(newContract(task) ? { localRequestId: JSON.parse(task.snapshot_json || '{}').requestId, fingerprint: (task as CoreTask).fingerprint } : {}),
    ...(newContract(task) && validStudioProviderWait(accepted) ? { providerNotBefore: accepted.providerNotBefore, providerWaitSource: accepted.providerWaitSource } : {}) };
  await writePrivate(task.id, 'async.json', JSON.stringify(receipt));
  await writePrivate(task.id, 'async.json', JSON.stringify(receipt), true);
  return receipt;
}
export async function updateStudioAsyncReceipt(receipt: StudioAsyncReceipt, changes: StudioProviderWait & { state?: StudioAsyncReceipt['state']; pollAfterMs?: number; waitingStatus?: StudioAsyncReceipt['waitingStatus'] }) {
  changes = { state: changes.state, pollAfterMs: changes.pollAfterMs, waitingStatus: changes.waitingStatus,
    providerNotBefore: changes.providerNotBefore, providerWaitSource: changes.providerWaitSource };
  if (!validStudioProviderWait(changes)) throw new Error('Invalid async wait observation');
  if (receipt.schema === 'image.async-receipt.v1') { changes = { state: changes.state, pollAfterMs: changes.pollAfterMs, waitingStatus: changes.waitingStatus }; }
  if (changes.providerNotBefore !== undefined && (receipt.providerNotBefore || 0) > changes.providerNotBefore) {
    changes = { ...changes, providerNotBefore: receipt.providerNotBefore,
      providerWaitSource: changes.providerWaitSource === 'invalid-conservative' ? changes.providerWaitSource : receipt.providerWaitSource };
  }
  // Optional values must not erase a previously durable state or wait.
  changes = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
  Object.assign(receipt, changes, { pollAfterMs: Math.min(30000, Math.max(2000, Math.floor(changes.pollAfterMs || receipt.pollAfterMs))) });
  await writePrivate(receipt.taskId, 'async.json', JSON.stringify(receipt));
  await writePrivate(receipt.taskId, 'async.json', JSON.stringify(receipt), true);
}
export async function beginStudioRequest(task: Identity & { batch_id: string; fingerprint: string; snapshot_json: string | null; billing_scope?: string | null }) {
  // Exclusive durable marker: never resend an upstream POST after a crash or ambiguous response.
  const dir = directory(task.id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(root(), 0o700); await fs.chmod(dir, 0o700);
  let snapshot: Record<string, unknown> = {};
  try { snapshot = JSON.parse(task.snapshot_json || '{}'); } catch {}
  const receipt: StudioReceipt = { taskId: task.id, ownerId: task.owner_id, localRequestId: typeof snapshot.requestId === 'string' ? snapshot.requestId : task.batch_id,
    batchId: task.batch_id, fingerprint: task.fingerprint, submittedAt: Date.now(), billingScope: task.billing_scope };
  if (snapshot.imageChannel && typeof snapshot.imageChannel === 'object') {
    const channel = snapshot.imageChannel as { channelId?: unknown; configRevision?: unknown };
    if (typeof channel.channelId !== 'string' || typeof channel.configRevision !== 'string') throw new Error('Invalid frozen request channel');
    receipt.channelId = channel.channelId; receipt.configRevision = channel.configRevision;
    receipt.dispatchState = 'prepared';
  }
  const previous = receipt.channelId ? await readStudioRequestReceipt(task) : null;
  if (previous) {
    if (previous.dispatchState !== 'held' || previous.channelId !== receipt.channelId
      || previous.configRevision !== receipt.configRevision || previous.fingerprint !== task.fingerprint
      || previous.returnedAt !== undefined || previous.status !== undefined) throw new Error('Request already attempted');
    await writePrivate(task.id, 'request.json', JSON.stringify({ ...previous, dispatchState: 'prepared' }));
    return;
  }
  const handle = await fs.open(path.join(dir, 'request.json'), 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); } finally { await handle.close(); }
  const folder = await fs.open(dir, 'r'); try { await folder.sync(); } finally { await folder.close(); }
}
/** A held intent is provably before the transport call; it is not an accepted receipt. */
export async function setStudioUnsentRequestState(task: Identity, state: 'held' | 'attempted') {
  const receipt = await readStudioRequestReceipt(task);
  if (!receipt?.channelId || receipt.dispatchState !== 'prepared' || receipt.status !== undefined
    || receipt.returnedAt !== undefined) throw new Error('Unsent request identity unavailable');
  await writePrivate(task.id, 'request.json', JSON.stringify({ ...receipt, dispatchState: state }));
}
function responseReceipt(receipt: StudioReceipt, response: Response): StudioReceipt {
  receipt = { ...receipt };
  receipt.returnedAt = receipt.returnedAt || Date.now(); receipt.status = response.status;
  const gateway = response.headers.get('x-oneapi-request-id');
  if (gateway && /^[a-zA-Z0-9_.:-]{1,200}$/.test(gateway)) receipt.gatewayRequestId = gateway;
  for (const name of ['x-request-id', 'request-id', 'x-ms-request-id']) {
    const id = response.headers.get(name);
    if (id && /^[a-zA-Z0-9_.:-]{1,200}$/.test(id)) { receipt.upstreamRequestId = id; receipt.headerName = name; break; }
  }
  return receipt;
}
export async function recordStudioResponse(task: Identity, response: Response, adapters: StudioCoreReceiptAdapters = {}) {
  if ('snapshot_json' in task && newContract(task as CoreTask)) {
    const coreTask = task as CoreTask;
    const prior = await readStudioCorePending(coreTask);
    const request = prior?.request || await readStudioRequestReceipt(task);
    if (!request) throw new StudioCoreReceiptError('core_receipt_identity_conflict', false);
    const pending: StudioCorePending = { schema: 'image.core-pending.v1', request: responseReceipt(request, response), ...(prior?.async ? { async: prior.async } : {}) };
    await writeCorePending(coreTask, pending, adapters);
    await applyCorePending(coreTask, pending, adapters);
    return;
  }
  const file = path.join(directory(task.id), 'request.json');
  const receipt: StudioReceipt = JSON.parse(await fs.readFile(file, 'utf8'));
  if (receipt.taskId !== task.id || receipt.ownerId !== task.owner_id) throw new Error('Request identity mismatch');
  receipt.returnedAt = Date.now(); receipt.status = response.status;
  const gateway = response.headers.get('x-oneapi-request-id');
  if (gateway && /^[a-zA-Z0-9_.:-]{1,200}$/.test(gateway)) receipt.gatewayRequestId = gateway;
  for (const name of ['x-request-id', 'request-id', 'x-ms-request-id']) {
    const id = response.headers.get(name);
    if (id && /^[a-zA-Z0-9_.:-]{1,200}$/.test(id)) { receipt.upstreamRequestId = id; receipt.headerName = name; break; }
  }
  await writePrivate(task.id, 'request.json', JSON.stringify(receipt));
  // The accounting receipt survives delivery cleanup, including failures before
  // image decoding. It contains no URL, image bytes, prompt or credentials.
  await writePrivate(task.id, 'request.json', JSON.stringify(receipt), true);
  if (receipt.billingScope) {
    const changed = await prisma.imageStudioTask.updateMany({ where: { id: task.id, owner_id: task.owner_id,
      billing_scope: receipt.billingScope, OR: [{ gateway_request_id: null }, { gateway_request_id: receipt.gatewayRequestId || null }] },
      data: { gateway_request_id: receipt.gatewayRequestId || null,
        billing_status: `${receipt.channelId ? 'channel_' : ''}${receipt.gatewayRequestId ? 'pending' : 'unmatched'}`, billing_next_check_at: new Date() } });
    if (!changed.count) throw new Error('Billing receipt identity conflict');
  }
}
/** The 202 body is read even if headers-only persistence failed. No GET is allowed before this completes. */
export async function recordStudioAsyncAcceptance(task: CoreTask, response: Response,
  accepted: StudioProviderWait & { taskId: string; pollAfterMs?: number; expiresAt?: string }, adapters: StudioCoreReceiptAdapters = {}) {
  if (!newContract(task)) return createStudioAsyncReceipt(task, accepted);
  const prior = await readStudioCorePending(task);
  const request = prior?.request || await readStudioRequestReceipt(task);
  if (!request || !/^[a-zA-Z0-9_-]{1,180}$/.test(accepted.taskId) || !validStudioProviderWait(accepted)) throw new StudioCoreReceiptError('core_receipt_identity_conflict', false);
  const existing = await readStudioAsyncReceipt(task);
  if (existing && existing.providerTaskId !== accepted.taskId || prior?.async && prior.async.providerTaskId !== accepted.taskId) throw new StudioCoreReceiptError('core_receipt_identity_conflict', true);
  const receipt: StudioAsyncReceipt = prior?.async || existing || { schema: 'image.async-receipt.v2', taskId: task.id, ownerId: task.owner_id,
    ...asyncIdentity(task), providerTaskId: accepted.taskId, pollAfterMs: Math.min(30000, Math.max(2000, Math.floor(accepted.pollAfterMs || 2000))),
    localRequestId: request.localRequestId, fingerprint: task.fingerprint,
    acceptedAt: Date.now(), state: 'accepted', waitingStatus: 'pending',
    ...(typeof accepted.expiresAt === 'string' && Number.isFinite(Date.parse(accepted.expiresAt)) ? { expiresAt: accepted.expiresAt } : {}),
    ...(accepted.providerNotBefore !== undefined ? { providerNotBefore: accepted.providerNotBefore, providerWaitSource: accepted.providerWaitSource } : {}) };
  const pending: StudioCorePending = { schema: 'image.core-pending.v1', request: responseReceipt(request, response), async: receipt };
  await writeCorePending(task, pending, adapters);
  return await applyCorePending(task, pending, adapters) || receipt;
}
export async function recordStudioInputManifest(task: CoreTask, manifest: StudioInputManifest) {
  if (!newContract(task)) return;
  const receipt = await readStudioRequestReceipt(task);
  if (!receipt || receipt.status !== undefined || receipt.dispatchState === 'attempted') throw new Error('input_manifest_request_already_attempted');
  const pending: StudioCorePending = { schema: 'image.core-pending.v1', request: { ...receipt, inputManifest: manifest } };
  await writeCorePending(task, pending, {});
  await applyCorePending(task, pending, {});
}
/** A new provider wait is core scheduling state and follows the same repair journal. */
export async function recordStudioAsyncProgress(task: CoreTask, receipt: StudioAsyncReceipt, changes: StudioProviderWait & { pollAfterMs?: number; resultReady?: true }) {
  if (receipt.schema === 'image.async-receipt.v1') { await updateStudioAsyncReceipt(receipt, changes); return; }
  const request = await readStudioRequestReceipt(task);
  if (!request || !validStudioProviderWait(changes)) throw new StudioCoreReceiptError('core_receipt_identity_conflict', false);
  const next = { ...receipt, pollAfterMs: Math.min(30000, Math.max(2000, Math.floor(changes.pollAfterMs || receipt.pollAfterMs))),
    ...(changes.resultReady ? { resultReady: true as const } : {}),
    ...((changes.providerNotBefore || 0) > (receipt.providerNotBefore || 0) || changes.providerWaitSource === 'invalid-conservative'
      ? { providerNotBefore: Math.max(changes.providerNotBefore || 0, receipt.providerNotBefore || 0), providerWaitSource: changes.providerWaitSource } : {}) };
  const pending: StudioCorePending = { schema: 'image.core-pending.v1', request, async: next };
  await writeCorePending(task, pending, {});
  const complete = await applyCorePending(task, pending, {});
  Object.assign(receipt, complete || next);
}
export function decodeStudioBase64(value: string) {
  if (!value.length || value.length > MAX_STUDIO_GENERATED_BASE64 || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new StudioImageDownloadError('generated_base64_invalid');
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > MAX_STUDIO_GENERATED_BYTES || bytes.toString('base64') !== value) throw new StudioImageDownloadError('generated_base64_invalid');
  return bytes;
}
export async function createStudioBase64Delivery(task: Identity, value: string, usage: unknown) {
  const bytes = decodeStudioBase64(value);
  const existing = await readStudioDelivery(task);
  if (existing) throw new Error('Delivery already recorded');
  const record: StudioDelivery = { taskId: task.id, ownerId: task.owner_id, url: '', kind: 'base64', usage,
    expiresAt: Date.now() + STUDIO_RECOVERY_MS, attempts: 0, complete: false, expectedBytes: bytes.length, outputHash: createHash('sha256').update(bytes).digest('hex'), phase: 'validate' };
  await save(record);
  await writePrivate(task.id, 'image.part', bytes);
  record.complete = true; record.receivedBytes = bytes.length;
  await save(record);
  return record;
}
export async function updateStudioDelivery(record: StudioDelivery, changes: Partial<StudioDelivery>) {
  Object.assign(record, changes); await save(record);
}
export async function studioDeliveryStatus(task: Identity & { status: string; usage_json?: string | null; asset_id?: string | null }) {
  const record = await readStudioDelivery(task).catch(() => null);
  let receipt: StudioReceipt | null = null;
  try { receipt = await readStudioRequestReceipt(task); } catch {}
  let completed: { requestId?: string; upstreamRequestId?: string; validation?: StudioDelivery['validation']; responseStatus?: number; returnedAt?: number } = {};
  if (task.status === 'succeeded' || studioDimensionMismatch(task)) {
    try { completed = JSON.parse(task.usage_json || '{}').studioDelivery || {}; } catch {}
  }
  const running = task.status === 'running' || task.status === 'channel_running';
  let asyncReceipt: StudioAsyncReceipt | null = null;
  if ('snapshot_json' in task) asyncReceipt = await readStudioAsyncReceipt(task as AsyncIdentity).catch(() => null);
  // The recovery record is identity-bound and contains no provider URL or key.
  // A financial unknown is not an active generation and does not reopen POST.
  const asyncRecovery = task.status === 'uncertain' && !studioTaskHasViewableOutput(task) && 'snapshot_json' in task
    ? await (await import('./async-recovery')).readStudioAsyncRecovery(task as import('@prisma/client').ImageStudioTask).catch(() => null)
    : null;
  const providerCheck = running && 'snapshot_json' in task
    ? await (await import('./async-recovery')).readStudioActiveProviderCheck(task as import('@prisma/client').ImageStudioTask).catch(() => null) : null;
  return { phase: task.status === 'queued' || task.status === 'channel_queued' ? 'queued' : task.status === 'succeeded' || studioTaskHasViewableOutput(task) ? 'ready'
    : running ? record?.phase || 'provider' : record ? 'stopped' : task.status === 'uncertain' ? 'unknown' : 'failed',
    accepted: Boolean(asyncReceipt),
    acceptedAt: asyncReceipt && Number.isFinite(asyncReceipt.acceptedAt) && asyncReceipt.acceptedAt > 0 ? asyncReceipt.acceptedAt : undefined,
    waitingStatus: asyncReceipt && ['pending', 'retrying', 'unconfirmed'].includes(asyncReceipt.waitingStatus || '') ? asyncReceipt.waitingStatus : undefined,
    ...(asyncRecovery ? { asyncRecovery } : {}),
    ...(providerCheck ? { providerCheck } : {}),
    ...(asyncReceipt?.providerNotBefore ? { providerNotBefore: asyncReceipt.providerNotBefore } : {}),
    generationDetailSuperseded: studioGenerationDetailSuperseded(task.status, record, asyncReceipt),
    receivedBytes: record?.receivedBytes, expectedBytes: record?.expectedBytes,
    recoveryAvailable: running && Boolean(asyncReceipt && asyncReceipt.state !== 'failed' || record && studioDeliveryCanRetry(record)),
    checkpointRetained: Boolean(record), validation: record?.validation || completed.validation,
    // No signed URL, usage, private file path, prompt or Base64 leaves this boundary.
    responseStatus: receipt?.status ?? completed.responseStatus, returnedAt: receipt?.returnedAt ?? completed.returnedAt,
    requestId: receipt?.taskId === task.id && receipt.ownerId === task.owner_id ? receipt.localRequestId : completed.requestId,
    upstreamRequestId: receipt?.taskId === task.id && receipt.ownerId === task.owner_id ? receipt.upstreamRequestId : completed.upstreamRequestId };
}
export async function readStudioDelivery(task: Identity): Promise<StudioDelivery | null> {
  let record: StudioDelivery;
  try { record = JSON.parse(await fs.readFile(path.join(directory(task.id), 'source.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Delivery checkpoint unreadable'); }
  if (record.taskId !== task.id || record.ownerId !== task.owner_id || typeof record.url !== 'string'
    || !Number.isFinite(record.expiresAt) || !Number.isInteger(record.attempts) || record.attempts < 0) throw new Error('Invalid delivery checkpoint');
  return record;
}
export async function createStudioDelivery(task: Identity, url: string, usage: unknown) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || url.length > 16384) throw new StudioImageDownloadError('download_unsafe_url');
  const existing = await readStudioDelivery(task);
  if (existing) {
    if (existing.url !== url) throw new Error('Delivery source changed');
    return existing;
  }
  const record: StudioDelivery = { taskId: task.id, ownerId: task.owner_id, url, kind: 'url', usage, expiresAt: Date.now() + STUDIO_RECOVERY_MS, attempts: 0, phase: 'download' };
  await save(record);
  return record;
}
export function studioDeliveryCanRetry(record: StudioDelivery) {
  return record.expiresAt > Date.now() && (record.recoveries || 0) < STUDIO_MAX_DOWNLOAD_ATTEMPTS && (record.complete || record.attempts < STUDIO_MAX_DOWNLOAD_ATTEMPTS);
}
export async function discardStudioDelivery(task: Identity) {
  await preserveStudioBillingReceipt(task);
  await fs.rm(directory(task.id), { recursive: true, force: true });
}

// Only a verified immutable async identity may retire a local download
// checkpoint before querying that same upstream task. Receipts are never removed.
export async function resetStudioAsyncDelivery(task: AsyncIdentity, providerTaskId: string) {
  const receipt = await readStudioAsyncReceipt(task);
  if (!receipt || receipt.providerTaskId !== providerTaskId || receipt.state === 'failed') throw new Error('Async checkpoint reset identity mismatch');
  await preserveStudioBillingReceipt(task);
  await writePrivate(task.id, 'async.json', JSON.stringify(receipt), true);
  for (const name of ['source.json', 'image.part']) {
    await fs.unlink(path.join(directory(task.id), name)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
}

export async function preserveStudioBillingReceipt(task: Identity) {
  // Pending core evidence is accounting state, not an expiring delivery diagnostic.
  const pending = await readBoundedCoreFile(task, 'core-pending.json', false);
  if (pending) {
    if (!('snapshot_json' in task) || !('batch_id' in task) || !('fingerprint' in task)) throw new Error('Core receipt preservation identity unavailable');
    const core = await readStudioCorePending(task as CoreTask);
    if (core) await writePrivate(task.id, 'core-pending.json', JSON.stringify(core), true);
  }
  let receipt: StudioReceipt;
  try { receipt = JSON.parse(await fs.readFile(path.join(directory(task.id), 'request.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (receipt.taskId !== task.id || receipt.ownerId !== task.owner_id) throw new Error('Billing receipt ownership mismatch');
  await writePrivate(task.id, 'request.json', JSON.stringify(receipt), true);
}

// Only filenames derived from a validated task id are used. Signed URLs stay outside public/ and the DB/API.
export async function downloadStudioDelivery(record: StudioDelivery, signal: AbortSignal,
  openStream: typeof openStudioImageStream = openStudioImageStream, attemptMs = STUDIO_DOWNLOAD_WINDOW_MS,
  assertLease: () => Promise<void> = async () => {}): Promise<Buffer> {
  if (!record.complete && record.expiresAt <= Date.now()) throw new StudioImageDownloadError('download_source_expired');
  const file = path.join(directory(record.taskId), 'image.part');
  if (record.kind === 'base64' && !record.complete) {
    const bytes = await fs.readFile(file).catch(() => Buffer.alloc(0));
    if (bytes.length !== record.expectedBytes || !record.outputHash || createHash('sha256').update(bytes).digest('hex') !== record.outputHash) {
      throw new StudioImageDownloadError('generated_checkpoint_incomplete');
    }
    record.complete = true; record.receivedBytes = bytes.length; await save(record);
  }
  if (!record.complete && record.etag && record.expectedBytes && record.expectedBytes <= MAX_STUDIO_GENERATED_BYTES) {
    const size = await fs.stat(file).then(stat => stat.isFile() ? stat.size : -1).catch(() => -1);
    if (size === record.expectedBytes) {
      // A process may stop after the last file write but before recording completion.
      record.complete = true;
      await save(record);
    }
  }
  if (record.complete) {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size !== record.expectedBytes || stat.size > MAX_STUDIO_GENERATED_BYTES) throw new StudioImageDownloadError('download_incomplete');
    return fs.readFile(file);
  }
  if (record.attempts >= STUDIO_MAX_DOWNLOAD_ATTEMPTS) throw new StudioImageDownloadError('download_retry_limit');
  record.attempts += 1;
  record.phase = record.attempts > 1 ? 'recover' : 'download';
  await save(record);
  const deadline = new AbortController();
  const combined = AbortSignal.any([signal, deadline.signal]);
  const started = Date.now();
  let lastProgress = started, progressed = false, extended = false;
  let timer: ReturnType<typeof setTimeout>;
  const expire = () => {
    const remaining = Math.min(started + STUDIO_DOWNLOAD_EXTENDED_MS, record.expiresAt) - Date.now();
    if (!extended && progressed && Date.now() - lastProgress < 60_000 && remaining > 0) {
      extended = true; timer = setTimeout(() => deadline.abort(), remaining);
    } else deadline.abort();
  };
  timer = setTimeout(expire, Math.max(1, Math.min(attemptMs, record.expiresAt - started)));
  const metrics: StudioDownloadDiagnostics = { phase: 'dns', attempt: record.attempts, redirects: 0, receivedBytes: 0, elapsedMs: 0 };
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let response: Awaited<ReturnType<typeof openStream>> | undefined;
  try {
    let offset = await fs.stat(file).then(stat => stat.size).catch(error => {
      if (error.code === 'ENOENT') return 0;
      throw error;
    });
    if (!record.etag || !Number.isSafeInteger(offset) || offset > MAX_STUDIO_GENERATED_BYTES) offset = 0;
    const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
    if (offset) { headers.Range = `bytes=${offset}-`; headers['If-Range'] = record.etag!; }
    await assertLease();
    response = await openStream(record.url, combined, metrics, headers);
    const status = response.statusCode;
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new StudioImageDownloadError('download_encoding_unsupported', status);
    const lengthHeader = response.headers['content-length'];
    const length = typeof lengthHeader === 'string' && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : undefined;
    let expected = length;
    if (status === 416) {
      const total = /^bytes \*\/(\d+)$/.exec(String(response.headers['content-range'] || ''));
      if (!offset || !record.etag || response.headers.etag !== record.etag || !total || Number(total[1]) !== offset || offset !== record.expectedBytes) {
        throw new StudioImageDownloadError('download_invalid_range', status);
      }
      // Full decoding in the worker is still mandatory; length alone is never delivery success.
      record.complete = true; record.receivedBytes = offset; record.phase = 'validate'; await save(record);
      return fs.readFile(file);
    } else if (status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(response.headers['content-range'] || ''));
      if (!offset || !range || Number(range[1]) !== offset || Number(range[2]) + 1 !== Number(range[3])
        || (length !== undefined && length !== Number(range[3]) - offset)
        || response.headers.etag !== record.etag || (record.expectedBytes !== undefined && Number(range[3]) !== record.expectedBytes)) {
        throw new StudioImageDownloadError('download_invalid_range', status);
      }
      expected = Number(range[3]);
    } else if (status === 200) {
      if (offset && response.headers.etag !== record.etag) throw new StudioImageDownloadError('download_object_changed', status);
      // Preserve the previous partial as bounded diagnostics before restarting from zero.
      if (offset) await fs.rename(file, path.join(directory(record.taskId), 'previous.part'));
      offset = 0;
      record.etag = typeof response.headers.etag === 'string' && /^"[^\r\n]*"$/.test(response.headers.etag) ? response.headers.etag : undefined;
    } else throw new StudioImageDownloadError('download_http_error', status);
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected <= 0 || expected > MAX_STUDIO_GENERATED_BYTES)) throw new StudioImageDownloadError('download_size_limit', status);
    record.expectedBytes = expected;
    handle = await fs.open(file, offset ? 'a' : 'w', 0o600);
    await save(record);
    let received = offset;
    let lastLogged = started;
    let lastLeaseCheck = started;
    metrics.expectedBytes = expected;
    for await (const chunk of response) {
      combined.throwIfAborted();
      const bytes = Buffer.from(chunk);
      if (Date.now() - lastLeaseCheck >= 5000) { await assertLease(); lastLeaseCheck = Date.now(); }
      if (received + bytes.length > MAX_STUDIO_GENERATED_BYTES || (expected !== undefined && received + bytes.length > expected)) throw new StudioImageDownloadError('download_size_limit', status);
      let written = 0;
      while (written < bytes.length) {
        const result = await handle.write(bytes, written, bytes.length - written);
        if (!result.bytesWritten) throw new Error('Incomplete file write');
        written += result.bytesWritten;
      }
      received += bytes.length;
      if (bytes.length) { progressed = true; lastProgress = Date.now(); }
      metrics.receivedBytes = received;
      if (Date.now() - lastLogged >= 30_000) {
        await handle.sync(); record.receivedBytes = received; await save(record);
        console.info('[image-delivery]', JSON.stringify({ taskId: record.taskId, ...metrics, elapsedMs: Date.now() - started }));
        lastLogged = Date.now();
      }
    }
    if (!response.complete || !received || (expected !== undefined && received !== expected)) throw new StudioImageDownloadError('download_incomplete', status, true);
    await handle.sync();
    await handle.close(); handle = undefined;
    record.expectedBytes = received;
    record.complete = true;
    record.receivedBytes = received; record.phase = 'validate';
    await save(record);
    console.info('[image-delivery]', JSON.stringify({ taskId: record.taskId, host: new URL(record.url).hostname, ...metrics, elapsedMs: Date.now() - started, complete: true }));
    return fs.readFile(file);
  } catch (error) {
    const failure = deadline.signal.aborted ? new StudioImageDownloadError('download_total_timeout', metrics.httpStatus, true)
      : signal.aborted ? new StudioImageDownloadError('download_aborted', metrics.httpStatus, true) : classifyStudioDownloadError(error);
    failure.diagnostics = { ...metrics, elapsedMs: Date.now() - started };
    record.receivedBytes = metrics.receivedBytes; record.code = failure.code;
    await handle?.sync(); await save(record);
    console.error('[image-delivery]', JSON.stringify({ taskId: record.taskId, host: new URL(record.url).hostname, code: failure.code, ...failure.diagnostics }));
    throw failure;
  } finally {
    clearTimeout(timer!);
    response?.destroy();
    await handle?.close();
  }
}

export async function cleanupStudioDeliveries(now = Date.now()) {
  if (now - lastCleanup < 5 * 60_000) return;
  await cleanupStudioResponseEvidence(now).catch(() => {
    // An unreadable diagnostic sidecar must not stop the original delivery queue.
    console.error('[image-response-evidence]', JSON.stringify({ code: 'cleanup_unavailable' }));
  });
  const entries = await fs.readdir(root(), { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9-]{1,120}$/.test(entry.name)) continue;
    const dir = directory(entry.name);
    const stat = await fs.stat(dir);
    // Keep expired records long enough for a worker to settle; remove abandoned files within one day.
    if (now - stat.mtimeMs > STUDIO_CHECKPOINT_RETENTION_MS) {
      const active = await prisma.imageStudioTask.findFirst({ where: { id: entry.name, status: { in: ['queued', 'running', 'channel_queued', 'channel_running'] } }, select: { id: true } });
      if (!active) {
        const task = await prisma.imageStudioTask.findUnique({ where: { id: entry.name } });
        if (task?.status === 'uncertain') {
          try {
            if (await (await import('./async-recovery')).retainStudioAsyncCheckpoint(task)) continue;
          } catch {
            // Missing permission or a damaged schedule is not permission to
            // erase the only retained result before the worker can inspect it.
            console.error('[image-async-recovery]', JSON.stringify({ taskId: task.id, code: 'cleanup_recovery_unavailable' }));
            continue;
          }
        }
        if (task) await preserveStudioBillingReceipt(task);
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  }
  lastCleanup = now;
}
