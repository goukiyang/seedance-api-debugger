import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { MAX_STUDIO_GENERATED_BYTES, MAX_STUDIO_GENERATED_BASE64, STUDIO_RECOVERY_MS, STUDIO_CHECKPOINT_RETENTION_MS, STUDIO_MAX_DOWNLOAD_ATTEMPTS, STUDIO_DOWNLOAD_WINDOW_MS, STUDIO_DOWNLOAD_EXTENDED_MS } from './limits';
import { prisma } from '@/lib/prisma';
import { openStudioImageStream, classifyStudioDownloadError, StudioImageDownloadError, type StudioDownloadDiagnostics } from './media';

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
function directory(id: string) {
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(id)) throw new Error('Invalid delivery identity');
  return path.join(root(), id);
}
async function writePrivate(id: string, name: string, bytes: string | Buffer) {
  const dir = directory(id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(root(), 0o700);
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

type StudioReceipt = { taskId: string; ownerId: string; localRequestId: string; batchId: string; fingerprint: string;
  submittedAt: number; returnedAt?: number; status?: number; upstreamRequestId?: string; headerName?: string };
export async function beginStudioRequest(task: Identity & { batch_id: string; fingerprint: string; snapshot_json: string | null }) {
  // Exclusive durable marker: never resend an upstream POST after a crash or ambiguous response.
  const dir = directory(task.id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(root(), 0o700); await fs.chmod(dir, 0o700);
  let snapshot: Record<string, unknown> = {};
  try { snapshot = JSON.parse(task.snapshot_json || '{}'); } catch {}
  const receipt: StudioReceipt = { taskId: task.id, ownerId: task.owner_id, localRequestId: typeof snapshot.requestId === 'string' ? snapshot.requestId : task.batch_id,
    batchId: task.batch_id, fingerprint: task.fingerprint, submittedAt: Date.now() };
  const handle = await fs.open(path.join(dir, 'request.json'), 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); } finally { await handle.close(); }
  const folder = await fs.open(dir, 'r'); try { await folder.sync(); } finally { await folder.close(); }
}
export async function recordStudioResponse(task: Identity, response: Response) {
  const file = path.join(directory(task.id), 'request.json');
  const receipt: StudioReceipt = JSON.parse(await fs.readFile(file, 'utf8'));
  if (receipt.taskId !== task.id || receipt.ownerId !== task.owner_id) throw new Error('Request identity mismatch');
  receipt.returnedAt = Date.now(); receipt.status = response.status;
  for (const name of ['x-request-id', 'request-id', 'x-ms-request-id']) {
    const id = response.headers.get(name);
    if (id && /^[a-zA-Z0-9_.:-]{1,200}$/.test(id)) { receipt.upstreamRequestId = id; receipt.headerName = name; break; }
  }
  await writePrivate(task.id, 'request.json', JSON.stringify(receipt));
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
export async function studioDeliveryStatus(task: Identity & { status: string; usage_json?: string | null }) {
  const record = await readStudioDelivery(task).catch(() => null);
  let receipt: StudioReceipt | null = null;
  try { receipt = JSON.parse(await fs.readFile(path.join(directory(task.id), 'request.json'), 'utf8')); } catch {}
  let completed: { requestId?: string; upstreamRequestId?: string; validation?: StudioDelivery['validation']; responseStatus?: number; returnedAt?: number } = {};
  if (task.status === 'succeeded') {
    try { completed = JSON.parse(task.usage_json || '{}').studioDelivery || {}; } catch {}
  }
  const running = task.status === 'running';
  return { phase: task.status === 'queued' ? 'queued' : task.status === 'succeeded' ? 'ready'
    : running ? record?.phase || 'provider' : record ? 'stopped' : task.status === 'uncertain' ? 'unknown' : 'failed',
    receivedBytes: record?.receivedBytes, expectedBytes: record?.expectedBytes,
    recoveryAvailable: running && Boolean(record && studioDeliveryCanRetry(record)),
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
  await fs.rm(directory(task.id), { recursive: true, force: true });
}

// Only filenames derived from a validated task id are used. Signed URLs stay outside public/ and the DB/API.
export async function downloadStudioDelivery(record: StudioDelivery, signal: AbortSignal,
  openStream: typeof openStudioImageStream = openStudioImageStream, attemptMs = STUDIO_DOWNLOAD_WINDOW_MS,
  assertLease: () => Promise<void> = async () => {}): Promise<Buffer> {
  if (record.expiresAt <= Date.now()) throw new StudioImageDownloadError('download_source_expired');
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
      const active = await prisma.imageStudioTask.findFirst({ where: { id: entry.name, status: { in: ['queued', 'running'] } }, select: { id: true } });
      if (!active) await fs.rm(dir, { recursive: true, force: true });
    }
  }
  lastCleanup = now;
}
