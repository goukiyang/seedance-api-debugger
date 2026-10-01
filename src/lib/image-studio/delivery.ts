import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_STUDIO_GENERATED_BYTES } from './limits';
import { openStudioImageStream, classifyStudioDownloadError, StudioImageDownloadError, type StudioDownloadDiagnostics } from './media';

const TTL_MS = 30 * 60_000;
const MAX_ATTEMPTS = 6;
const root = () => path.join(process.cwd(), 'storage', 'studio-delivery');
let lastCleanup = 0;
type Identity = { id: string; owner_id: string };
export type StudioDelivery = {
  taskId: string; ownerId: string; url: string; usage: unknown; expiresAt: number;
  attempts: number; etag?: string; expectedBytes?: number; complete?: boolean;
};
function directory(id: string) {
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(id)) throw new Error('Invalid delivery identity');
  return path.join(root(), id);
}
async function save(record: StudioDelivery) {
  const dir = directory(record.taskId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(root(), 0o700);
  await fs.chmod(dir, 0o700);
  const temporary = path.join(dir, `${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, path.join(dir, 'source.json'));
  } finally { await fs.unlink(temporary).catch(() => {}); }
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
  const record: StudioDelivery = { taskId: task.id, ownerId: task.owner_id, url, usage, expiresAt: Date.now() + TTL_MS, attempts: 0 };
  await save(record);
  return record;
}
export function studioDeliveryCanRetry(record: StudioDelivery) {
  return record.expiresAt > Date.now() && record.attempts < MAX_ATTEMPTS;
}
export async function discardStudioDelivery(task: Identity) {
  await fs.rm(directory(task.id), { recursive: true, force: true });
}

// Only filenames derived from a validated task id are used. Signed URLs stay outside public/ and the DB/API.
export async function downloadStudioDelivery(record: StudioDelivery, signal: AbortSignal,
  openStream: typeof openStudioImageStream = openStudioImageStream, attemptMs = 180_000): Promise<Buffer> {
  if (record.expiresAt <= Date.now()) throw new StudioImageDownloadError('download_source_expired');
  const file = path.join(directory(record.taskId), 'image.part');
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
  if (record.attempts >= MAX_ATTEMPTS) throw new StudioImageDownloadError('download_retry_limit');
  record.attempts += 1;
  await save(record);
  const deadline = AbortSignal.timeout(Math.max(1, Math.min(attemptMs, record.expiresAt - Date.now())));
  const combined = AbortSignal.any([signal, deadline]);
  const started = Date.now();
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
    response = await openStream(record.url, combined, metrics, headers);
    const status = response.statusCode;
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new StudioImageDownloadError('download_encoding_unsupported', status);
    const lengthHeader = response.headers['content-length'];
    const length = typeof lengthHeader === 'string' && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : undefined;
    let expected = length;
    if (status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(response.headers['content-range'] || ''));
      if (!offset || !range || Number(range[1]) !== offset || Number(range[2]) + 1 !== Number(range[3])
        || (length !== undefined && length !== Number(range[3]) - offset)
        || response.headers.etag !== record.etag || (record.expectedBytes !== undefined && Number(range[3]) !== record.expectedBytes)) {
        throw new StudioImageDownloadError('download_invalid_range', status);
      }
      expected = Number(range[3]);
    } else if (status === 200) {
      offset = 0;
      record.etag = typeof response.headers.etag === 'string' && /^"[^\r\n]*"$/.test(response.headers.etag) ? response.headers.etag : undefined;
    } else throw new StudioImageDownloadError('download_http_error', status);
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected <= 0 || expected > MAX_STUDIO_GENERATED_BYTES)) throw new StudioImageDownloadError('download_size_limit', status);
    record.expectedBytes = expected;
    handle = await fs.open(file, offset ? 'a' : 'w', 0o600);
    await save(record);
    let received = offset;
    let lastLogged = started;
    metrics.expectedBytes = expected;
    for await (const chunk of response) {
      combined.throwIfAborted();
      const bytes = Buffer.from(chunk);
      if (received + bytes.length > MAX_STUDIO_GENERATED_BYTES || (expected !== undefined && received + bytes.length > expected)) throw new StudioImageDownloadError('download_size_limit', status);
      let written = 0;
      while (written < bytes.length) {
        const result = await handle.write(bytes, written, bytes.length - written);
        if (!result.bytesWritten) throw new Error('Incomplete file write');
        written += result.bytesWritten;
      }
      received += bytes.length;
      metrics.receivedBytes = received;
      if (Date.now() - lastLogged >= 30_000) {
        console.info('[image-delivery]', JSON.stringify({ taskId: record.taskId, ...metrics, elapsedMs: Date.now() - started }));
        lastLogged = Date.now();
      }
    }
    if (!response.complete || !received || (expected !== undefined && received !== expected)) throw new StudioImageDownloadError('download_incomplete', status, true);
    await handle.sync();
    await handle.close(); handle = undefined;
    record.expectedBytes = received;
    record.complete = true;
    await save(record);
    console.info('[image-delivery]', JSON.stringify({ taskId: record.taskId, host: new URL(record.url).hostname, ...metrics, elapsedMs: Date.now() - started, complete: true }));
    return fs.readFile(file);
  } catch (error) {
    const failure = deadline.aborted ? new StudioImageDownloadError('download_total_timeout', metrics.httpStatus, true)
      : signal.aborted ? new StudioImageDownloadError('download_aborted', metrics.httpStatus, true) : classifyStudioDownloadError(error);
    failure.diagnostics = { ...metrics, elapsedMs: Date.now() - started };
    console.error('[image-delivery]', JSON.stringify({ taskId: record.taskId, host: new URL(record.url).hostname, code: failure.code, ...failure.diagnostics }));
    throw failure;
  } finally {
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
    if (now - stat.mtimeMs > 24 * 60 * 60_000) await fs.rm(dir, { recursive: true, force: true });
  }
  lastCleanup = now;
}
