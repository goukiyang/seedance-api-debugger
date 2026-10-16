import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { StudioReceipt } from './delivery';
import { MAX_STUDIO_GENERATED_BASE64, MAX_STUDIO_GENERATED_BYTES } from './limits';
import { isPrivateNetworkHost } from '@/lib/media/public-url';
import { sanitizeStudioResponseDiagnostics, type StudioResponseDiagnostics, type StudioResponseOutputCandidate } from './response-diagnostics';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_CANDIDATES = 4;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const WRAPPERS = ['response', 'result', 'body', 'data'];
const FORMATS = ['png', 'jpeg', 'webp', 'avif', 'tiff'];
const MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', tiff: 'image/tiff' };
let cleanupCursor = '';

export type StudioResponseEvidenceTask = {
  id: string; owner_id: string; batch_id: string; fingerprint: string; model: string; snapshot_json: string | null;
};
type EvidenceIdentity = {
  taskId: string; ownerId: string; batchId: string; fingerprint: string; localRequestId: string;
  channelId: string; configRevision: string; model: string; submittedAt: number; returnedAt: number; status: number;
};
type CandidateSource = Pick<StudioResponseOutputCandidate, 'kind' | 'location' | 'wrapperPath' | 'ordinal'> & { unconfirmed: true };
type ImageCandidate = CandidateSource & {
  storageKind: 'image'; file: string; bytes: number; sha256: string; format: string; mimeType: string; width: number; height: number;
};
type UrlCandidate = CandidateSource & { storageKind: 'url'; url: string; urlLength: number; urlSha256: string };
type Rejection = { ordinal: number; reason: 'candidate_limit' | 'source_invalid' | 'response_incomplete' | 'base64_invalid'
  | 'total_bytes_limit' | 'image_invalid' | 'mime_mismatch' | 'url_invalid' };
type Manifest = {
  schema: 'studio.response-evidence.v1'; identity: EvidenceIdentity; responseSha256: string;
  createdAt: number; expiresAt: number; diagnostic: StudioResponseDiagnostics;
  candidates: Array<ImageCandidate | UrlCandidate>; rejected: Rejection[];
};
export type StudioResponseEvidence = {
  diagnostic: StudioResponseDiagnostics; responseSha256: string; createdAt: number; expiresAt: number;
  confirmedOutput: false; recoveryAuthorized: false;
  candidates: Array<CandidateSource & ({ storageKind: 'image'; bytes: number; sha256: string; format: string; mimeType: string; width: number; height: number }
    | { storageKind: 'url'; hasUrl: true; urlLength: number })>;
  rejected: Rejection[];
};

function failure(code: 'identity' | 'invalid' | 'conflict' | 'write_failed') {
  return new Error(`studio_response_evidence_${code}`);
}
function sha256(value: Buffer | string) { return createHash('sha256').update(value).digest('hex'); }
function isHash(value: unknown): value is string { return typeof value === 'string' && value.length === 64 && HASH.test(value); }
function missing(cause: unknown) { return (cause as NodeJS.ErrnoException)?.code === 'ENOENT'; }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function taskDirectory(task: StudioResponseEvidenceTask) { return sha256(task.id); }

function identityFor(task: StudioResponseEvidenceTask, receipt: StudioReceipt): EvidenceIdentity {
  let snapshot: Record<string, unknown>;
  try { snapshot = JSON.parse(task.snapshot_json || '{}'); } catch { throw failure('identity'); }
  const channel = object(snapshot?.imageChannel) ? snapshot.imageChannel : null;
  if (!object(snapshot) || !channel || !['gemini-nano-banana-2.1', 'gemini-3-pro-image-preview'].includes(task.model)
    || snapshot.model !== task.model || typeof snapshot.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(snapshot.requestId)
    || typeof channel.channelId !== 'string' || !/^(original|shared|banana|fluxport|image-[a-f0-9-]{36})$/i.test(channel.channelId)
    || typeof channel.configRevision !== 'string' || channel.configRevision.length !== 36 || !UUID.test(channel.configRevision)
    || !/^[a-zA-Z0-9-]{1,120}$/.test(task.id) || !/^[a-zA-Z0-9_-]{1,180}$/.test(task.owner_id)
    || !/^[a-zA-Z0-9-]{1,120}$/.test(task.batch_id) || !isHash(task.fingerprint)
    || receipt.taskId !== task.id || receipt.ownerId !== task.owner_id || receipt.batchId !== task.batch_id
    || receipt.fingerprint !== task.fingerprint || receipt.localRequestId !== snapshot.requestId
    || receipt.channelId !== channel.channelId || receipt.configRevision !== channel.configRevision
    || !integer(receipt.submittedAt) || receipt.submittedAt <= 0 || !integer(receipt.returnedAt)
    || receipt.returnedAt < receipt.submittedAt || !integer(receipt.status) || receipt.status < 100 || receipt.status > 599) throw failure('identity');
  return { taskId: task.id, ownerId: task.owner_id, batchId: task.batch_id, fingerprint: task.fingerprint,
    localRequestId: receipt.localRequestId, channelId: channel.channelId, configRevision: channel.configRevision,
    model: task.model, submittedAt: receipt.submittedAt, returnedAt: receipt.returnedAt, status: receipt.status };
}
function sameIdentity(a: unknown, b: EvidenceIdentity) {
  return object(a) && Object.entries(b).every(([key, value]) => a[key] === value)
    && Object.keys(a).length === Object.keys(b).length;
}

async function checkDirectory(dir: string) {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== 0o700
    || await fs.realpath(dir) !== dir) throw failure('invalid');
  return stat;
}
async function evidenceRoot(create = false) {
  const storage = path.join(process.cwd(), 'storage');
  if (create) await fs.mkdir(storage, { recursive: true, mode: 0o700 });
  const realStorage = await fs.realpath(storage);
  if (process.env.NODE_ENV === 'production' && !realStorage.startsWith('/data/')) throw new Error('studio_response_evidence_storage_not_data');
  const root = path.join(realStorage, 'studio-response-evidence');
  if (create) await fs.mkdir(root, { mode: 0o700 }).catch(cause => { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; });
  await checkDirectory(root);
  if (create) await syncDirectory(realStorage);
  return root;
}
async function syncDirectory(dir: string) {
  const handle = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeFile(dir: string, name: string, value: string | Buffer) {
  await checkDirectory(dir);
  const handle = await fs.open(path.join(dir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
}
async function readFile(dir: string, name: string, maximum: number, expectedSize?: number, expectedHash?: string) {
  await checkDirectory(dir);
  const file = path.join(dir, name);
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o7777) !== 0o600 || before.nlink !== 1
    || before.size > maximum || expectedSize !== undefined && before.size !== expectedSize || await fs.realpath(file) !== file) throw failure('invalid');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.mode !== before.mode) throw failure('invalid');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const next = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!next.bytesRead) throw failure('invalid');
      offset += next.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    const after = await handle.stat();
    if (extra.bytesRead || bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || expectedHash !== undefined && sha256(bytes) !== expectedHash) throw failure('invalid');
    return bytes;
  } finally { await handle.close(); }
}
async function readManifest(dir: string): Promise<Manifest> {
  const digest = (await readFile(dir, 'manifest.sha256', 64, 64)).toString('ascii');
  if (!isHash(digest)) throw failure('invalid');
  const bytes = await readFile(dir, 'manifest.json', MAX_MANIFEST_BYTES, undefined, digest);
  return JSON.parse(bytes.toString('utf8')) as Manifest;
}
function sourceFor(candidate: StudioResponseOutputCandidate): CandidateSource | null {
  const pairs: Record<string, string[]> = { inline_data: ['candidate_content_part_inlineData', 'candidate_content_part_inline_data'], b64_json: ['data_b64_json'], url: ['data_url'] };
  if (!candidate || !['inline_data', 'b64_json', 'url'].includes(candidate.kind) || !pairs[candidate.kind].includes(candidate.location) || !Array.isArray(candidate.wrapperPath)
    || candidate.wrapperPath.length > 2 || !candidate.wrapperPath.every(value => WRAPPERS.includes(value))
    || !integer(candidate.ordinal) || candidate.ordinal >= MAX_CANDIDATES) return null;
  return { kind: candidate.kind, location: candidate.location, wrapperPath: [...candidate.wrapperPath], ordinal: candidate.ordinal, unconfirmed: true };
}
function safeUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.length || value.length > 16384 || value !== value.trim() || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return url.protocol === 'https:' && !url.username && !url.password && host.includes('.')
      && !isPrivateNetworkHost(host) && host !== '::' && !host.startsWith('::ffff:')
      && !host.endsWith('.localhost') && !host.endsWith('.internal') && !host.endsWith('.lan')
      && !/^(0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|192\.0\.0\.|198\.(1[89])\.|2(2[4-9]|[3-5]\d)\.)/.test(host);
  } catch { return false; }
}
function decode(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !value.length || value.length > MAX_STUDIO_GENERATED_BASE64 || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length && bytes.toString('base64') === value ? bytes : null;
}
async function imageMetadata(bytes: Buffer) {
  const options = { limitInputPixels: 40_000_000, animated: false, failOn: 'warning' as const };
  const metadata = await sharp(bytes, options).metadata();
  if (!FORMATS.includes(metadata.format || '') || (metadata.pages || 1) !== 1
    || !integer(metadata.width) || !integer(metadata.height) || metadata.width < 1 || metadata.height < 1
    || metadata.width > 16384 || metadata.height > 16384 || metadata.width * metadata.height > 40_000_000) throw failure('invalid');
  // Force full decoding, but retain the supplier's exact original bytes.
  await sharp(bytes, options).timeout({ seconds: 45 }).stats();
  return { format: metadata.format!, mimeType: MIME[metadata.format!], width: metadata.width, height: metadata.height };
}
function safeEvidence(manifest: Manifest, diagnostic: StudioResponseDiagnostics): StudioResponseEvidence {
  return { diagnostic, responseSha256: manifest.responseSha256, createdAt: manifest.createdAt, expiresAt: manifest.expiresAt,
    confirmedOutput: false, recoveryAuthorized: false, rejected: manifest.rejected.map(value => ({ ordinal: value.ordinal, reason: value.reason })),
    candidates: manifest.candidates.map((candidate): StudioResponseEvidence['candidates'][number] => ({ kind: candidate.kind, location: candidate.location,
      wrapperPath: [...candidate.wrapperPath], ordinal: candidate.ordinal, unconfirmed: true,
      ...(candidate.storageKind === 'url' ? { storageKind: 'url' as const, hasUrl: true as const, urlLength: candidate.urlLength }
        : { storageKind: 'image' as const, bytes: candidate.bytes, sha256: candidate.sha256, format: candidate.format,
          mimeType: candidate.mimeType, width: candidate.width, height: candidate.height }) })) };
}

/** No sensitive output payload is returned, and no candidate is a delivery or recovery authorization. */
export async function readStudioResponseEvidence(task: StudioResponseEvidenceTask, receipt: StudioReceipt): Promise<StudioResponseEvidence | null> {
  const identity = identityFor(task, receipt);
  let dir: string;
  try { dir = path.join(await evidenceRoot(), taskDirectory(task)); await checkDirectory(dir); }
  catch (cause) { if (missing(cause)) return null; throw failure('invalid'); }
  try {
    const manifest = await readManifest(dir);
    if (manifest.schema !== 'studio.response-evidence.v1' || !sameIdentity(manifest.identity, identity)
      || !isHash(manifest.responseSha256) || !integer(manifest.createdAt) || manifest.createdAt < identity.returnedAt
      || manifest.expiresAt !== identity.returnedAt + RETENTION_MS || manifest.createdAt > manifest.expiresAt
      || !Array.isArray(manifest.candidates) || manifest.candidates.length > MAX_CANDIDATES
      || !Array.isArray(manifest.rejected) || manifest.rejected.length > MAX_CANDIDATES + 1) throw failure('invalid');
    const diagnostic = sanitizeStudioResponseDiagnostics(manifest.diagnostic);
    if (diagnostic.observation.responseSha256 !== manifest.responseSha256 || diagnostic.observation.httpStatus !== identity.status) throw failure('invalid');
    if (manifest.candidates.length && (!diagnostic.observation.bodyComplete || diagnostic.observation.parseOutcome !== 'valid_json')) throw failure('invalid');
    if (manifest.expiresAt <= Date.now()) return null;
    let totalBytes = 0;
    const seen = new Set<number>();
    const rejectionReasons = ['candidate_limit', 'source_invalid', 'response_incomplete', 'base64_invalid', 'total_bytes_limit', 'image_invalid', 'mime_mismatch', 'url_invalid'];
    for (const rejected of manifest.rejected) if (!integer(rejected?.ordinal) || rejected.ordinal > MAX_CANDIDATES || !rejectionReasons.includes(rejected.reason)) throw failure('invalid');
    for (const candidate of manifest.candidates) {
      if (!sourceFor(candidate as StudioResponseOutputCandidate) || candidate.unconfirmed !== true || seen.has(candidate.ordinal)) throw failure('invalid');
      seen.add(candidate.ordinal);
      if (candidate.storageKind === 'url') {
        if (candidate.kind !== 'url' || !safeUrl(candidate.url) || candidate.url.length !== candidate.urlLength || sha256(candidate.url) !== candidate.urlSha256) throw failure('invalid');
      } else if (candidate.storageKind === 'image') {
        if (candidate.kind === 'url' || candidate.file !== `candidate-${candidate.ordinal}.image`
          || !integer(candidate.bytes) || candidate.bytes <= 0 || !isHash(candidate.sha256) || !FORMATS.includes(candidate.format)
          || candidate.mimeType !== MIME[candidate.format] || !integer(candidate.width) || !integer(candidate.height)
          || candidate.width < 1 || candidate.height < 1 || candidate.width > 16384 || candidate.height > 16384
          || candidate.width * candidate.height > 40_000_000 || (totalBytes += candidate.bytes) > MAX_STUDIO_GENERATED_BYTES) throw failure('invalid');
        await readFile(dir, candidate.file, MAX_STUDIO_GENERATED_BYTES, candidate.bytes, candidate.sha256);
      } else throw failure('invalid');
    }
    return safeEvidence(manifest, diagnostic);
  } catch { throw failure('invalid'); }
}

/** Invalid candidates are recorded as fixed reasons; actual filesystem failures remain visible to the caller. */
export async function recordStudioResponseEvidence(task: StudioResponseEvidenceTask, receipt: StudioReceipt,
  diagnosticInput: StudioResponseDiagnostics, candidates: readonly StudioResponseOutputCandidate[]): Promise<StudioResponseEvidence> {
  const identity = identityFor(task, receipt);
  const diagnostic = sanitizeStudioResponseDiagnostics(diagnosticInput);
  const responseSha256 = diagnostic.observation.responseSha256;
  if (!isHash(responseSha256) || diagnostic.observation.httpStatus !== identity.status
    || identity.returnedAt > Date.now() || identity.returnedAt + RETENTION_MS <= Date.now()) throw failure('identity');
  const previous = await readStudioResponseEvidence(task, receipt);
  if (previous) {
    if (previous.responseSha256 !== responseSha256) throw failure('conflict');
    return previous;
  }
  let staging: string | undefined;
  try {
    const root = await evidenceRoot(true);
    const name = taskDirectory(task);
    staging = path.join(root, `.stage-${name}-${randomUUID()}`);
    await fs.mkdir(staging, { mode: 0o700 });
    const manifest: Manifest = { schema: 'studio.response-evidence.v1', identity, responseSha256,
      createdAt: Date.now(), expiresAt: identity.returnedAt + RETENTION_MS, diagnostic, candidates: [], rejected: [] };
    const seen = new Set<number>();
    let totalBytes = 0;
    if (candidates.length > MAX_CANDIDATES) manifest.rejected.push({ ordinal: MAX_CANDIDATES, reason: 'candidate_limit' });
    for (let index = 0; index < Math.min(candidates.length, MAX_CANDIDATES); index++) {
      const candidate = candidates[index];
      const source = sourceFor(candidate);
      const reject = (reason: Rejection['reason']) => manifest.rejected.push({ ordinal: source?.ordinal ?? index, reason });
      if (!source || seen.has(source.ordinal)) { reject('source_invalid'); continue; }
      seen.add(source.ordinal);
      if (!diagnostic.observation.bodyComplete || diagnostic.observation.parseOutcome !== 'valid_json') { reject('response_incomplete'); continue; }
      if (source.kind === 'url') {
        if (!safeUrl(candidate.value)) { reject('url_invalid'); continue; }
        manifest.candidates.push({ ...source, storageKind: 'url', url: candidate.value, urlLength: candidate.value.length, urlSha256: sha256(candidate.value) });
        continue;
      }
      // Check the remaining aggregate budget before allocating the next decoded buffer.
      if (typeof candidate.value === 'string' && candidate.value.length % 4 === 0) {
        const padding = candidate.value.endsWith('==') ? 2 : candidate.value.endsWith('=') ? 1 : 0;
        if (candidate.value.length / 4 * 3 - padding > MAX_STUDIO_GENERATED_BYTES - totalBytes) { reject('total_bytes_limit'); continue; }
      }
      const bytes = decode(candidate.value);
      if (!bytes) { reject('base64_invalid'); continue; }
      if (bytes.length + totalBytes > MAX_STUDIO_GENERATED_BYTES) { reject('total_bytes_limit'); continue; }
      totalBytes += bytes.length;
      let metadata: Awaited<ReturnType<typeof imageMetadata>>;
      try { metadata = await imageMetadata(bytes); } catch { reject('image_invalid'); continue; }
      if (candidate.mimeType !== 'unknown' && candidate.mimeType !== metadata.mimeType) { reject('mime_mismatch'); continue; }
      const file = `candidate-${source.ordinal}.image`;
      await writeFile(staging, file, bytes);
      manifest.candidates.push({ ...source, storageKind: 'image', file, bytes: bytes.length, sha256: sha256(bytes), ...metadata });
    }
    const manifestBytes = JSON.stringify(manifest);
    if (Buffer.byteLength(manifestBytes) > MAX_MANIFEST_BYTES) throw failure('invalid');
    await writeFile(staging, 'manifest.json', manifestBytes);
    await writeFile(staging, 'manifest.sha256', sha256(manifestBytes));
    await syncDirectory(staging);
    try { await fs.rename(staging, path.join(root, name)); staging = undefined; }
    catch (cause) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((cause as NodeJS.ErrnoException).code || '')) throw cause;
      const existing = await readStudioResponseEvidence(task, receipt);
      if (!existing || existing.responseSha256 !== responseSha256) throw failure('conflict');
      return existing;
    }
    await syncDirectory(root);
    return safeEvidence(manifest, diagnostic);
  } catch (cause) {
    if (cause instanceof Error && cause.message === 'studio_response_evidence_conflict') throw cause;
    throw failure('write_failed');
  } finally { if (staging) await removePrivateDirectory(staging).catch(() => {}); }
}

async function removePrivateDirectory(dir: string) {
  await checkDirectory(dir);
  const names = await fs.readdir(dir);
  if (names.some(name => name !== 'manifest.json' && name !== 'manifest.sha256' && !/^candidate-[0-3]\.image$/.test(name))) return false;
  for (const name of names) {
    const stat = await fs.lstat(path.join(dir, name));
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1) return false;
  }
  for (const name of names) await fs.unlink(path.join(dir, name));
  await fs.rmdir(dir);
  return true;
}

/** Independent seven-day retention; never edits delivery, receipts, task state or financial records. */
export async function cleanupStudioResponseEvidence(now = Date.now()) {
  if (!integer(now)) throw failure('invalid');
  let root: string;
  try { root = await evidenceRoot(); } catch (cause) { if (missing(cause)) return { scanned: 0, removed: 0 }; throw failure('invalid'); }
  const names = (await fs.readdir(root)).filter(name => /^[a-f0-9]{64}$/.test(name) || /^\.stage-[a-f0-9]{64}-[a-f0-9-]{36}$/.test(name)).sort();
  const pivot = names.findIndex(name => name > cleanupCursor);
  const ordered = pivot < 0 ? names : [...names.slice(pivot), ...names.slice(0, pivot)];
  let scanned = 0, removed = 0;
  for (const name of ordered.slice(0, 128)) {
    scanned++; cleanupCursor = name;
    const dir = path.join(root, name);
    try {
      const stat = await checkDirectory(dir);
      let expiresAt = stat.mtimeMs + RETENTION_MS;
      if (!name.startsWith('.stage-')) {
        try {
          const manifest = await readManifest(dir);
          if (manifest.schema === 'studio.response-evidence.v1' && integer(manifest.identity?.returnedAt)
            && manifest.expiresAt === manifest.identity.returnedAt + RETENTION_MS) expiresAt = manifest.expiresAt;
        } catch { /* Damaged evidence still ages out; deletion below only accepts our fixed private files. */ }
      }
      if (expiresAt <= now && await removePrivateDirectory(dir)) removed++;
    } catch { /* A concurrent writer, invalid entry or unreadable evidence is never followed or force-deleted. */ }
  }
  if (removed) await syncDirectory(root);
  return { scanned, removed };
}
