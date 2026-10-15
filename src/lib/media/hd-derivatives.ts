import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import sharp from 'sharp';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { hdReadonlyDb } from './hd-readonly-db';
import { HD_CONTROL_PROTOCOL, HD_RESOURCE_POLICY, HdControl, HdResourceSample, hdManualReason, hdResourceTransition, hdRunState, sampleHdResources } from './hd-resource-state';
export type { HdControl, HdResourceSample } from './hd-resource-state';

export const HD_POLICY = 'hd-f-v1';
export const HD_VALIDATION_VERSION = 'hd-output-integrity-v2';
const MAX_PIXELS = 40_000_000;
const ROOT_RESERVE = 512000 * 1024;
const DATA_RESERVE = 2 * 1024 * 1024 * 1024;
type HdIntegrityCheck = { expected: unknown; actual: unknown; ok: boolean };
export type HdIntegrity = { version: string; checks: Record<string, HdIntegrityCheck>; failedChecks: string[] };
type HdEncoder = {
  policy: string; validation: string; sourceSha256: string; libraries: typeof sharp.versions;
  parameters: { format: 'avif' | 'webp'; lossless: boolean; quality?: number; chromaSubsampling?: string; effort: number; orientation: string; bitdepth: number };
};
type HdAttempt = {
  attempt: number; startedAt: string; finishedAt?: string; sourceVersion: string;
  encoder?: HdEncoder; status: HdJob['status']; reason?: string; integrity?: HdIntegrity;
};
export type HdJob = {
  key: string; source: string; version: string; policy: string; priority: number;
  status: 'queued' | 'running' | 'ready' | 'failed' | 'skipped'; reason?: string;
  attempts: number; updatedAt: string; preserveText: boolean;
  format?: 'avif' | 'webp' | 'original'; mime?: string; bytes?: number;
  width?: number; height?: number; file?: string; batch?: string;
  attemptLimit?: number; attemptHistory?: HdAttempt[]; integrity?: HdIntegrity;
  retryHistory?: Array<{ at: string; previousAttempts: number; reason?: string; manifest: string }>;
  retryAt?: string; isolatedReason?: 'source_missing' | 'source_unreadable';
};
export const hdDirectory = () => path.join(process.cwd(), 'storage', 'hd-derivatives');
const jobPath = (key: string) => path.join(hdDirectory(), `${key}.json`);
const now = () => new Date().toISOString();
export const HD_UPLOAD_DIRECTORY_ACCESS = constants.R_OK | constants.X_OK;
export const HD_OUTPUT_DIRECTORY_ACCESS = constants.R_OK | constants.W_OK | constants.X_OK;
export async function assertHdDirectoryAccess(access: typeof fs.access = fs.access) {
  await access(await fs.realpath(path.join(process.cwd(), 'public/uploads')), HD_UPLOAD_DIRECTORY_ACCESS);
  await access(await fs.realpath(hdDirectory()), HD_OUTPUT_DIRECTORY_ACCESS);
}
export async function atomicHdJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(tmp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(tmp, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  finally { await fs.unlink(tmp).catch(() => {}); }
}
export async function hdSource(source: string) {
  const local = siteUploadPathFromUrl(source);
  if (!local) return null;
  // Failure of the shared root is a global storage problem. Only errors from an
  // individual path inside a readable root may be isolated.
  const root = await fs.realpath(path.join(process.cwd(), 'public/uploads'));
  await fs.access(root, HD_UPLOAD_DIRECTORY_ACCESS);
  let file: string;
  try { file = await fs.realpath(path.resolve(process.cwd(), 'public', decodeURIComponent(local).replace(/^\/+/, ''))); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error('source_missing');
    if (code === 'EACCES') throw new Error('source_unreadable');
    throw error;
  }
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error('source_boundary');
  try { await fs.access(file, 4); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EACCES') throw new Error('source_unreadable'); throw error; }
  const stat = await fs.stat(file);
  if (!stat.isFile() || !stat.size) throw new Error('source_missing');
  const version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  return { file, version, size: stat.size };
}
export async function readHdJob(key: string): Promise<HdJob | null> {
  if (!/^[a-f0-9]{64}$/.test(key)) return null;
  try {
    const job = JSON.parse(await fs.readFile(jobPath(key), 'utf8')) as HdJob;
    if (job.key !== key || job.policy !== HD_POLICY || typeof job.source !== 'string' || typeof job.version !== 'string'
      || !['queued', 'running', 'ready', 'failed', 'skipped'].includes(job.status) || !Number.isInteger(job.attempts)
      || !Number.isInteger(job.priority) || typeof job.preserveText !== 'boolean'
      || (job.attemptLimit !== undefined && (!Number.isSafeInteger(job.attemptLimit) || job.attemptLimit < 3))
      || (job.attemptHistory !== undefined && !Array.isArray(job.attemptHistory))
      || (job.retryHistory !== undefined && !Array.isArray(job.retryHistory))) throw new Error('invalid_hd_manifest');
    return job;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
// Short manifest lease, shared by web, inventory and the dedicated worker.
export async function withHdLease<T>(key: string, action: () => Promise<T>): Promise<T | null> {
  if (!/^(?:[a-f0-9]{64}|control|discovery)$/.test(key)) throw new Error('invalid_hd_lease');
  const lock = path.join(hdDirectory(), `${key}.lock`);
  await fs.mkdir(hdDirectory(), { recursive: true, mode: 0o700 });
  try { await fs.mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let owner: { pid: number; host: string; token: string };
    try { owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')); }
    catch {
      // Another owner may still be durably writing its identity. Do not reclaim
      // or classify that short creation window as an unknown stale lease.
      if (Date.now() - (await fs.stat(lock)).mtimeMs < 5000) return null;
      throw new Error('hd_lease_conflict');
    }
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.host !== os.hostname() || typeof owner.token !== 'string') throw new Error('hd_lease_conflict');
    try { process.kill(owner.pid, 0); return null; }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('hd_lease_conflict'); }
    const stale = `${lock}.${randomUUID()}.expired`;
    try { await fs.rename(lock, stale); await fs.unlink(path.join(stale, 'owner.json')); await fs.rmdir(stale); } catch { throw new Error('hd_lease_conflict'); }
    try { await fs.mkdir(lock); } catch { return null; }
  }
  const token = randomUUID();
  await atomicHdJson(path.join(lock, 'owner.json'), { pid: process.pid, host: os.hostname(), token });
  const heartbeat = setInterval(() => { const date = new Date(); void fs.utimes(lock, date, date).catch(() => {}); }, 15000);
  try { return await action(); }
  finally {
    clearInterval(heartbeat);
    const owned = await fs.readFile(path.join(lock, 'owner.json'), 'utf8').then(text => JSON.parse(text).token === token).catch(() => false);
    if (owned) { await fs.unlink(path.join(lock, 'owner.json')); await fs.rmdir(lock); }
  }
}
const withLease = withHdLease;
async function withControlLease<T>(action: () => Promise<T>): Promise<T | null> {
  // A live short control write is contention, not permission to overwrite it.
  // Wait on the lock condition for at most half a second, then return conflict.
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await withLease('control', action);
    if (result !== null) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return null;
}
async function hdRequestIdentity(source: string, preserveText?: boolean) {
  const current = await hdSource(source);
  if (!current) return null; // Unknown remote versions never become permanent derivative keys.
  if (preserveText === undefined) {
    const local = siteUploadPathFromUrl(source)!;
    const assets = await hdReadonlyDb.asset.findMany({ where: { status: 'active', type: 'image', original_url: { endsWith: local } }, select: { metadata_json: true } });
    preserveText = assets.some(asset => { try { return JSON.parse(asset.metadata_json || '{}').preserveText === true; } catch { return false; } });
  }
  const key = createHash('sha256').update(JSON.stringify({ file: current.file, version: current.version,
    policy: HD_POLICY, format: 'alpha-or-text-lossless-webp-otherwise-avif', q: 95, chroma: '4:4:4', effort: 6, orientation: 'auto', color: '8bit-srgb',
    library: sharp.versions, preserveText })).digest('hex');
  return { current, key, preserveText: Boolean(preserveText) };
}

export async function lookupHd(source: string) {
  const identity = await hdRequestIdentity(source);
  if (!identity) return null;
  const { current, key, preserveText } = identity;
  const job = await readHdJob(key);
  if (!job) return null;
  if (job.version !== current.version || job.preserveText !== preserveText) throw new Error('invalid_hd_manifest');
  if (job.status !== 'ready') return job;
  const common = Number.isSafeInteger(job.bytes) && job.bytes! > 0
    && Number.isSafeInteger(job.width) && job.width! > 0 && Number.isSafeInteger(job.height) && job.height! > 0;
  let valid = common && job.format === 'original' && job.bytes === current.size;
  if (common && ['avif', 'webp'].includes(job.format || '') && job.file === `${key}.${job.format}` && job.mime === `image/${job.format}`) {
    valid = await (async () => {
      const root = await fs.realpath(hdDirectory());
      const file = await fs.realpath(path.join(root, job.file!));
      if (!file.startsWith(`${root}${path.sep}`)) return false;
      const info = await fs.stat(file);
      return info.isFile() && info.size === job.bytes;
    })().catch(() => false);
  }
  return valid ? job : { ...job, status: 'failed' as const, reason: 'published_integrity' };
}

export async function requestHd(source: string, priority = 1, preserveText?: boolean, batch?: string) {
  const identity = await hdRequestIdentity(source, preserveText);
  if (!identity) return null;
  const { current, key } = identity;
  preserveText = identity.preserveText;
  let existing = await readHdJob(key);
  if (existing?.status === 'ready' && existing.format !== 'original') {
    const valid = existing.file && /^[a-f0-9]{64}\.(avif|webp)$/.test(existing.file)
      && await fs.stat(path.join(hdDirectory(), existing.file)).then(stat => stat.isFile() && stat.size === existing!.bytes).catch(() => false);
    if (!valid) {
      await withLease(key, async () => {
        const job = await readHdJob(key);
        if (job?.status === 'ready') await atomicHdJson(jobPath(key), { ...job, status: 'failed', reason: 'published_integrity', updatedAt: now() });
      });
      await setHdControl(true, 'published_integrity');
      existing = await readHdJob(key);
    }
  }
  if (existing && existing.priority <= priority) return existing;
  const result = await withLease(key, async () => {
    const found = await readHdJob(key);
    const job: HdJob = found ? { ...found, priority: Math.min(priority, found.priority) } : {
      key, source, version: current.version, policy: HD_POLICY, priority, preserveText: Boolean(preserveText),
      attempts: 0, status: 'queued', updatedAt: now(), ...(batch ? { batch } : {}),
    };
    await atomicHdJson(jobPath(key), job);
    return job;
  });
  // A claim held by another process is not a durable registration receipt.
  if (!result && !existing) throw new Error('hd_registration_pending');
  return result || existing!;
}
export async function listHdJobs() {
  const names = await fs.readdir(hdDirectory()).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  const jobs: HdJob[] = [];
  for (const name of names) if (/^[a-f0-9]{64}\.json$/.test(name)) {
    const job = await readHdJob(name.slice(0, -5)); if (job) jobs.push(job);
  }
  return jobs;
}
export async function hdCapacity(reserve = 0) {
  const root = await fs.statfs('/');
  const data = await fs.statfs(await fs.realpath(path.join(process.cwd(), 'storage')));
  const rootFree = root.bavail * root.bsize;
  const dataFree = data.bavail * data.bsize;
  const rootDevice = (await fs.stat('/')).dev;
  const dataDevice = (await fs.stat(await fs.realpath(path.join(process.cwd(), 'storage')))).dev;
  return { rootFree, dataFree, rootReserve: ROOT_RESERVE, dataReserve: DATA_RESERVE,
    separateDataMount: rootDevice !== dataDevice,
    safe: rootFree > ROOT_RESERVE && dataFree > DATA_RESERVE + reserve && rootDevice !== dataDevice };
}
export async function hdControl(): Promise<HdControl> {
  let raw = '';
  try {
    raw = await fs.readFile(path.join(hdDirectory(), 'control.json'), 'utf8');
    const control = JSON.parse(raw) as HdControl;
    if (typeof control.paused !== 'boolean' || (control.reason !== undefined && typeof control.reason !== 'string')
      || (control.updatedAt !== undefined && (typeof control.updatedAt !== 'string' || !Number.isFinite(Date.parse(control.updatedAt))))) throw new Error('invalid_hd_control');
    if (control.protocol !== undefined && control.protocol !== HD_CONTROL_PROTOCOL) throw new Error('invalid_hd_control');
    if (control.revision !== undefined && (!Number.isSafeInteger(control.revision) || control.revision < 0)) throw new Error('invalid_hd_control');
    if (control.history !== undefined && !Array.isArray(control.history)) throw new Error('invalid_hd_control');
    if (control.reason === 'resource_wait' && (!control.wait || !Number.isFinite(Date.parse(control.wait.since))
      || !Number.isFinite(Date.parse(control.wait.nextCheckAt)) || !Number.isInteger(control.wait.stableSamples)
      || control.wait.stableSamples < 0 || !Number.isInteger(control.wait.checks) || control.wait.checks < 0
      || (control.wait.stableSince !== undefined && !Number.isFinite(Date.parse(control.wait.stableSince))))) throw new Error('invalid_hd_control');
    return { ...control, revision: control.revision || 0, state: hdRunState(control), token: createHash('sha256').update(raw).digest('hex') };
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { paused: false, updatedAt: undefined, state: 'active', revision: 0, token: 'absent' }; throw error; }
}
async function writeHdControl(current: HdControl, value: Omit<HdControl, 'token'>) {
  const changedState = value.state !== current.state || value.reason !== current.reason;
  const revision = current.revision + 1;
  const history = [...(current.history || []), ...(changedState ? [{ at: now(), state: value.state, reason: value.reason, revision, resource: value.resource }] : [])].slice(-40);
  // token is derived from the actual bytes, including legacy revisions, never trusted from JSON.
  const persisted = { ...value, token: undefined };
  await atomicHdJson(path.join(hdDirectory(), 'control.json'), { ...persisted, protocol: HD_CONTROL_PROTOCOL, revision, updatedAt: changedState ? now() : current.updatedAt, history });
  return hdControl();
}
export async function setHdControl(paused: boolean, reason?: string, expectedToken?: string) {
  if (!paused) return (await recheckHdResources({ expectedToken, allowManualResume: true })).control;
  const result = await withControlLease(async () => {
    const current = await hdControl();
    if (expectedToken && current.token !== expectedToken) throw new Error('hd_control_conflict');
    if (hdManualReason(reason) && current.state === 'hard_pause' && current.reason !== 'load_guard') return current;
    if (current.state === 'hard_pause' && current.reason !== 'load_guard' && !hdManualReason(reason)) return current;
    const state = hdRunState({ paused, reason });
    if (state === 'resource_wait') throw new Error('hd_resource_check_required');
    return writeHdControl(current, { ...current, paused, reason, state, wait: undefined });
  });
  if (!result) throw new Error('hd_control_conflict');
  return result;
}
export type HdResourceCheckOptions = {
  expectedToken?: string; allowManualResume?: boolean;
  sample?: () => Promise<HdResourceSample>; clock?: () => number;
};
export async function recheckHdResources(options: HdResourceCheckOptions = {}) {
  const before = await hdControl();
  if (options.expectedToken && options.expectedToken !== before.token) throw new Error('hd_control_conflict');
  if (before.state === 'hard_pause' && before.reason !== 'load_guard') throw new Error('hd_hard_pause_requires_review');
  if (before.state === 'manual_pause' && !options.allowManualResume) return { control: before, changed: false, conflict: false };
  const clock = options.clock || Date.now;
  const sample = options.sample ? await options.sample() : await (async () => {
    let safe: boolean | null = null;
    try {
      await assertHdDirectoryAccess();
      safe = (await hdCapacity()).safe;
    } catch { /* Shared permissions, mount and capacity unknown are hard stops. */ }
    return sampleHdResources(safe, clock);
  })();
  const result = await withControlLease(async () => {
    const current = await hdControl();
    if (current.token !== before.token) return { control: current, changed: false, conflict: true };
    const next = hdResourceTransition(current, sample, clock(), options.allowManualResume);
    if (!next) return { control: current, changed: false, conflict: false };
    return { control: await writeHdControl(current, next), changed: true, conflict: false };
  });
  return result || { control: await hdControl(), changed: false, conflict: true };
}
async function preserveFailedHd(job: HdJob) {
  const manifest = path.join('history', job.key, `${randomUUID()}.json`);
  // Save the entire old failure before changing its status or retry budget.
  await atomicHdJson(path.join(hdDirectory(), manifest), job);
  job.retryHistory = [...(job.retryHistory || []), { at: now(), previousAttempts: job.attempts, reason: job.reason, manifest }];
}
export async function retryHdKey(key: string, expectedVersion: string) {
  if (!/^[a-f0-9]{64}$/.test(key) || !expectedVersion) throw new Error('invalid_hd_retry_target');
  return withLease(key, async () => {
    const job = await readHdJob(key);
    if (!job || job.version !== expectedVersion || (await hdSource(job.source))?.version !== expectedVersion) throw new Error('hd_retry_source_changed');
    if (job.status === 'queued') return job; // Repeating the same request does not grant a further retry budget.
    if (job.status !== 'failed') throw new Error('hd_retry_requires_failed');
    await preserveFailedHd(job);
    // attempts remains a lifetime count for this targeted recovery; allow up to three new attempts.
    job.attemptLimit = job.attempts + 3;
    job.status = 'queued'; job.updatedAt = now();
    await atomicHdJson(jobPath(key), job);
    return job;
  });
}
export async function retryFailedHd() {
  for (const job of await listHdJobs()) if (job.status === 'failed') await withLease(job.key, async () => {
    const fresh = await readHdJob(job.key);
    if (fresh?.status === 'failed') {
      await preserveFailedHd(fresh);
      await atomicHdJson(jobPath(job.key), { ...fresh, status: 'queued', attempts: 0, attemptLimit: undefined, updatedAt: now() });
    }
  });
}
export async function hdStatus() {
  const discovery = await import('./hd-discovery');
  const checkpoint = await discovery.readHdDiscoveryCheckpoint().catch(() => null);
  const jobs = await listHdJobs();
  const counts = { queued: 0, running: 0, ready: 0, failed: 0, skipped: 0 };
  const reasons: Record<string, number> = {};
  let lastSuccessMs: number | null = null, lastProgressMs: number | null = null;
  const completion = (timestamp: string | undefined, successful: boolean) => {
    const value = timestamp ? Date.parse(timestamp) : NaN;
    if (!Number.isFinite(value)) return;
    lastProgressMs = Math.max(lastProgressMs ?? value, value);
    if (successful) lastSuccessMs = Math.max(lastSuccessMs ?? value, value);
  };
  for (const job of jobs) { counts[job.status]++; if (job.reason) reasons[job.reason] = (reasons[job.reason] || 0) + 1; }
  for (const job of jobs) {
    // Old ready manifests predate attempt history; their final publication timestamp
    // remains usable. queued.updatedAt only means queued/reprioritized, never progress.
    if (job.status === 'ready') completion(job.updatedAt, true);
    for (const attempt of job.attemptHistory || []) completion(attempt.finishedAt, attempt.status === 'ready');
  }
  const batches: Array<{ id: string; knownLocalOriginals: number; counts: typeof counts; notQueued: number; remoteVersionUnknown: number; unavailable: number }> = [];
  const names = await fs.readdir(hdDirectory()).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const byKey = new Map(jobs.map(job => [job.key, job]));
  const oldKeys = new Set<string>();
  for (const name of names.filter(name => /^ui30-old-[0-9]+\.inventory\.json$/.test(name))) {
    const inventory = JSON.parse(await fs.readFile(path.join(hdDirectory(), name), 'utf8'));
    const batchCounts = { queued: 0, running: 0, ready: 0, failed: 0, skipped: 0 };
    for (const key of inventory.jobs as string[]) { oldKeys.add(key); const job = byKey.get(key); if (job) batchCounts[job.status]++; }
    batches.push({ id: inventory.batch, knownLocalOriginals: inventory.uniqueLocalOriginals, counts: batchCounts,
      notQueued: inventory.uniqueLocalOriginals - Object.values(batchCounts).reduce((sum, count) => sum + count, 0),
      remoteVersionUnknown: inventory.remoteVersionUnknown, unavailable: inventory.unavailable });
  }
  const newCounts = { queued: 0, running: 0, ready: 0, failed: 0, skipped: 0 };
  for (const job of jobs) if (!oldKeys.has(job.key)) newCounts[job.status]++;
  const control = await hdControl();
  const stallThresholdMs = 10 * 60 * 1000;
  const resumedMs = control.wait?.since ? Date.parse(control.wait.since) : control.updatedAt ? Date.parse(control.updatedAt) : NaN;
  const capturedMs = Date.now();
  const pending = counts.queued + counts.running > 0;
  const started = Number.isFinite(resumedMs) ? resumedMs : Math.min(...jobs.filter(job => ['queued', 'running'].includes(job.status)).map(job => Date.parse(job.updatedAt)));
  const stalled = pending && control.state !== 'manual_pause' && Number.isFinite(started)
    && capturedMs - started > stallThresholdMs && (lastProgressMs === null || capturedMs - lastProgressMs > stallThresholdMs);
  const isolated = await discovery.listHdIsolations();
  const isolation = { total: isolated.filter(item => !item.resolvedAt).length,
    retrying: isolated.filter(item => !item.resolvedAt && item.retryAt).length,
    held: isolated.filter(item => !item.resolvedAt && !item.retryAt).length };
  return { policy: HD_POLICY, counts, reasons, batches, newCounts, control, capacity: await hdCapacity(), total: jobs.length,
    state: control.state, resource: control.resource || null, waitSince: control.wait?.since || null, isolation,
    discovery: await discovery.hdDiscoveryStatus(checkpoint),
    lastSuccessAt: lastSuccessMs === null ? null : new Date(lastSuccessMs).toISOString(),
    lastProgressAt: lastProgressMs === null ? null : new Date(lastProgressMs).toISOString(), stalled, stallThresholdMs };
}
export function selectHdJob(jobs: HdJob[], consecutiveNew: number, batch: string, clock = Date.now()) {
  const pending = jobs.filter(job => ['queued', 'running'].includes(job.status) && (!job.retryAt || Date.parse(job.retryAt) <= clock))
    .sort((a, b) => a.priority - b.priority || a.updatedAt.localeCompare(b.updatedAt));
  return (consecutiveNew >= 4 ? pending.find(job => job.status === 'queued' && job.batch === batch) : undefined) || pending[0];
}
export function hdEligibility(meta: sharp.Metadata) {
  if (meta.format === 'webp') return 'existing_webp';
  if ((meta.pages || 1) !== 1) return 'multi_frame';
  if (!meta.width || !meta.height || meta.width * meta.height > MAX_PIXELS) return 'pixel_limit';
  if ((meta.depth && meta.depth !== 'uchar') || (meta.bitsPerSample && meta.bitsPerSample > 8)) return 'high_bit_depth';
  if (meta.space !== 'srgb' && meta.space !== 'b-w') return 'wide_gamut';
  // An unclassified ICC profile is not silently converted into a claimed sRGB equivalent.
  if (meta.hasProfile) return 'unverified_color_profile';
  return null;
}
class HdOutputIntegrityError extends Error {
  constructor(readonly integrity: HdIntegrity) { super('output_integrity'); }
}
export async function validateHdOutput(inputFile: string, meta: sharp.Metadata, outputFile: string, format: 'avif' | 'webp'): Promise<HdIntegrity> {
  const integrity: HdIntegrity = { version: HD_VALIDATION_VERSION, checks: {}, failedChecks: [] };
  const check = (name: string, expected: unknown, actual: unknown, ok: boolean) => {
    integrity.checks[name] = { expected, actual, ok };
    if (!ok) integrity.failedChecks.push(name);
  };
  let output: sharp.Metadata;
  try {
    output = await sharp(outputFile, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).metadata();
    check('output_metadata', 'readable', 'readable', true);
  } catch {
    check('output_metadata', 'readable', 'decode_failed', false);
    throw new HdOutputIntegrityError(integrity);
  }
  const rotated = [5, 6, 7, 8].includes(meta.orientation || 1);
  check('width', rotated ? meta.height : meta.width, output.width ?? null, output.width === (rotated ? meta.height : meta.width));
  check('height', rotated ? meta.width : meta.height, output.height ?? null, output.height === (rotated ? meta.width : meta.height));
  let alphaMatches = Boolean(output.hasAlpha) === Boolean(meta.hasAlpha);
  let inputIsOpaque: boolean | null = null;
  // Lossless WebP can omit a redundant alpha channel. Only a complete input decode
  // proving every pixel opaque permits this exception; true transparency is still protected.
  if (meta.hasAlpha && !output.hasAlpha && format === 'webp' && output.format === 'webp') {
    try {
      inputIsOpaque = (await sharp(inputFile, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).timeout({ seconds: 120 }).stats()).isOpaque;
      check('input_opaque_decode', true, inputIsOpaque, inputIsOpaque === true);
      alphaMatches = inputIsOpaque === true;
    } catch {
      check('input_opaque_decode', true, 'decode_failed', false);
    }
  }
  check('alpha', { hasAlpha: Boolean(meta.hasAlpha), opaqueOmissionAllowed: format === 'webp' }, { hasAlpha: Boolean(output.hasAlpha), inputIsOpaque }, alphaMatches);
  check('pages', 1, output.pages || 1, (output.pages || 1) === 1);
  check('color', ['srgb', 'b-w'], output.space ?? null, ['srgb', 'b-w'].includes(output.space || ''));
  check('bitdepth', '<=8', output.bitsPerSample || 8, (output.bitsPerSample || 8) <= 8);
  check('depth', 'uchar', output.depth ?? null, output.depth === 'uchar');
  check('format', format === 'avif' ? 'heif' : 'webp', output.format ?? null, output.format === (format === 'avif' ? 'heif' : 'webp'));
  try {
    await sharp(outputFile, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).timeout({ seconds: 120 }).stats();
    check('output_full_decode', 'complete', 'complete', true);
  } catch {
    check('output_full_decode', 'complete', 'decode_failed', false);
  }
  if (integrity.failedChecks.length) throw new HdOutputIntegrityError(integrity);
  return integrity;
}
async function assertTargetedHdWorkerLock() {
  if (process.platform !== 'linux') throw new Error('hd_targeted_requires_worker_lock');
  const lock = await fs.stat(path.join(process.cwd(), 'storage', 'hd-worker.lock'), { bigint: true }).catch(() => null);
  if (!lock?.isFile()) throw new Error('hd_targeted_requires_worker_lock');
  const major = ((lock.dev >> BigInt(8)) & BigInt(0xfff)) | ((lock.dev >> BigInt(32)) & BigInt(0xfffff000));
  const minor = (lock.dev & BigInt(0xff)) | ((lock.dev >> BigInt(12)) & BigInt(0xffffff00));
  const locks = await fs.readFile('/proc/locks', 'utf8');
  const held = locks.split('\n').some(line => {
    const match = /^\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([a-f0-9]+):([a-f0-9]+):(\d+)\s/i.exec(line);
    // --no-fork makes this Node PID the unique lock owner; a parent-held lock
    // must not authorize several children to encode different keys concurrently.
    return match && Number(match[1]) === process.pid
      && BigInt(`0x${match[2]}`) === major && BigInt(`0x${match[3]}`) === minor && BigInt(match[4]) === lock.ino;
  });
  if (!held) throw new Error('hd_targeted_requires_worker_lock');
}
export type HdProcessDependencies = {
  capacity?: typeof hdCapacity; clock?: () => number; validate?: typeof validateHdOutput;
  assertWorkerLock?: () => Promise<void>; beforePublish?: () => Promise<void>;
};
export async function processHdJob(key: string, pausedSourceVersion?: string, dependencies: HdProcessDependencies = {}) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid_hd_process_target');
  const capacity = dependencies.capacity || hdCapacity;
  const timestamp = () => new Date((dependencies.clock || Date.now)()).toISOString();
  if (pausedSourceVersion !== undefined) await (dependencies.assertWorkerLock || assertTargetedHdWorkerLock)();
  return withLease(key, async () => {
    const job = await readHdJob(key);
    const control = await hdControl();
    if (pausedSourceVersion !== undefined) {
      // A bounded operator probe processes one key without releasing the global queue.
      if (!control.paused || !['operator_pause', 'admin_pause', 'output_integrity'].includes(control.reason || '')) throw new Error('hd_targeted_requires_safe_pause');
      if (!job || job.status !== 'queued') throw new Error('hd_targeted_requires_queued');
      if (job.version !== pausedSourceVersion || (await hdSource(job.source))?.version !== pausedSourceVersion) throw new Error('hd_targeted_source_changed');
    } else if (!job || !['queued', 'running'].includes(job.status) || control.paused) return;
    if (!job) return;
    if (job.retryAt && Date.parse(job.retryAt) > (dependencies.clock || Date.now)()) return;
    const receiptFile = path.join(hdDirectory(), `${key}.publish.json`);
    const receipt = await fs.readFile(receiptFile, 'utf8').then(text => JSON.parse(text) as { job: HdJob; temporary: string }).catch(error => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    if (receipt) {
      // A crash after output rename must finish the durable registration, not
      // spend another encoding attempt. Unknown receipts remain a hard stop.
      if (receipt.job.key !== key || receipt.job.version !== job.version || receipt.job.status !== 'ready'
        || receipt.job.integrity?.version !== HD_VALIDATION_VERSION || receipt.job.integrity.failedChecks.length
        || (await hdSource(job.source))?.version !== job.version) throw new Error('hd_publish_receipt_invalid');
      const source = await hdSource(job.source);
      if (!source) throw new Error('hd_publish_receipt_invalid');
      const meta = await sharp(source.file, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).metadata();
      // A durable receipt proves the publication intent, not that a file left on
      // disk still decodes correctly. Recheck before completing ready registration.
      try {
        if (receipt.job.format === 'original') {
          if (receipt.job.bytes !== source.size || receipt.job.width !== ([5, 6, 7, 8].includes(meta.orientation || 1) ? meta.height : meta.width)
            || receipt.job.height !== ([5, 6, 7, 8].includes(meta.orientation || 1) ? meta.width : meta.height)) throw new Error('hd_publish_receipt_invalid');
          await sharp(source.file, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).timeout({ seconds: 120 }).stats();
        } else {
          if (!['avif', 'webp'].includes(receipt.job.format || '') || !new RegExp(`^${key}\\.(avif|webp)$`).test(receipt.job.file || '')) throw new Error('hd_publish_receipt_invalid');
          const target = path.join(hdDirectory(), receipt.job.file!);
          const exists = await fs.stat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (!exists && !new RegExp(`^${key}\\.(avif|webp)\\.[a-f0-9-]+\\.tmp$`).test(receipt.temporary)) throw new Error('hd_publish_receipt_invalid');
          await (dependencies.validate || validateHdOutput)(source.file, meta, exists ? target : path.join(hdDirectory(), receipt.temporary), receipt.job.format as 'avif' | 'webp');
        }
      } catch (error) {
        await setHdControl(true, error instanceof HdOutputIntegrityError ? 'output_integrity' : 'worker_integrity_failure');
        throw error;
      }
      const resumed = await withControlLease(async () => {
        const fresh = await hdControl();
        if (fresh.state === 'hard_pause') return false;
        if (receipt.job.format !== 'original') {
          if (!/^[a-f0-9]{64}\.(avif|webp)$/.test(receipt.job.file || '') || !receipt.job.file!.startsWith(key)) throw new Error('hd_publish_receipt_invalid');
          const destination = path.join(hdDirectory(), receipt.job.file!);
          const exists = await fs.stat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (!exists) {
            if (!new RegExp(`^${key}\\.(avif|webp)\\.[a-f0-9-]+\\.tmp$`).test(receipt.temporary)) throw new Error('hd_publish_receipt_invalid');
            await fs.rename(path.join(hdDirectory(), receipt.temporary), destination);
          }
          const info = await fs.stat(destination);
          if (!info.isFile() || info.size !== receipt.job.bytes) throw new Error('hd_publish_receipt_invalid');
        }
        await atomicHdJson(jobPath(key), receipt.job);
        await fs.unlink(receiptFile);
        return true;
      });
      if (!resumed) throw new Error('hd_control_conflict');
      return;
    }
    let temporary = '';
    let attempt: HdAttempt | undefined;
    try {
      if (job.attempts >= (job.attemptLimit ?? 3)) { job.status = 'failed'; job.reason = 'retry_limit'; return; }
      const interrupted = job.attemptHistory?.[job.attemptHistory.length - 1];
      if (interrupted?.status === 'running' && !interrupted.finishedAt) Object.assign(interrupted, { finishedAt: timestamp(), status: 'failed', reason: 'worker_interrupted' });
      job.status = 'running'; job.attempts++; job.updatedAt = timestamp();
      job.reason = undefined; job.integrity = undefined; job.retryAt = undefined; job.isolatedReason = undefined;
      attempt = { attempt: job.attempts, startedAt: job.updatedAt, sourceVersion: job.version, status: 'running' };
      job.attemptHistory = [...(job.attemptHistory || []), attempt];
      await atomicHdJson(jobPath(key), job);
      const input = await hdSource(job.source);
      if (!input || input.version !== job.version) { job.status = 'skipped'; job.reason = 'source_changed'; return; }
      const meta = await sharp(input.file, { limitInputPixels: false, animated: true }).metadata().catch(error => {
        if (!(error as NodeJS.ErrnoException).code && /unsupported image format|corrupt header|invalid.*(?:image|header)|improper image header|premature end|Input file is missing/i.test((error as Error).message)) throw new Error('source_incompatible');
        throw error;
      });
      const reason = hdEligibility(meta);
      if (reason) { job.status = 'skipped'; job.reason = reason; return; }
      const reserve = input.size * 3 + meta.width! * meta.height! * 8;
      if (!(await capacity(reserve)).safe) {
        job.status = 'queued'; job.attempts--; job.reason = 'capacity_guard';
        if (pausedSourceVersion === undefined) await setHdControl(true, 'capacity_guard');
        return;
      }
      const format = meta.hasAlpha || job.preserveText ? 'webp' : 'avif';
      attempt.encoder = { policy: HD_POLICY, validation: HD_VALIDATION_VERSION,
        sourceSha256: createHash('sha256').update(await fs.readFile(path.join(process.cwd(), 'src/lib/media/hd-derivatives.ts'))).digest('hex'),
        libraries: { ...sharp.versions }, parameters: { format, lossless: format === 'webp', effort: 6, orientation: 'auto', bitdepth: 8,
          ...(format === 'avif' ? { quality: 95, chromaSubsampling: '4:4:4' } : {}) } };
      const filename = `${key}.${format}`;
      temporary = path.join(hdDirectory(), `${filename}.${randomUUID()}.tmp`);
      const image = sharp(input.file, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).rotate().timeout({ seconds: 120 });
      await (format === 'webp' ? image.webp({ lossless: true, effort: 6 }) : image.avif({ quality: 95, chromaSubsampling: '4:4:4', effort: 6, bitdepth: 8 })).toFile(temporary);
      await fs.chmod(temporary, 0o600);
      job.integrity = await (dependencies.validate || validateHdOutput)(input.file, meta, temporary, format);
      attempt.integrity = job.integrity;
      const rotated = [5, 6, 7, 8].includes(meta.orientation || 1);
      const width = rotated ? meta.height : meta.width, height = rotated ? meta.width : meta.height;
      const outputStat = await fs.stat(temporary);
      const outputHandle = await fs.open(temporary, 'r');
      try { await outputHandle.sync(); } finally { await outputHandle.close(); }
      if ((await hdSource(job.source))?.version !== job.version) { job.status = 'skipped'; job.reason = 'source_changed'; return; }
      if (!(await capacity()).safe) {
        if (pausedSourceVersion === undefined) await setHdControl(true, 'capacity_guard');
        job.status = 'queued'; job.reason = 'capacity_guard'; return;
      }
      Object.assign(job, { width, height, bytes: outputStat.size, format, mime: `image/${format}` });
      if (format === 'avif' && outputStat.size >= input.size) {
        Object.assign(job, { status: 'ready', format: 'original', mime: `image/${meta.format === 'jpg' ? 'jpeg' : meta.format}`, bytes: input.size, reason: 'original_smaller', file: undefined });
      } else {
        Object.assign(job, { status: 'ready', file: filename, reason: undefined });
      }
      if (attempt) Object.assign(attempt, { finishedAt: timestamp(), status: 'ready', reason: job.reason });
      job.updatedAt = timestamp();
      await dependencies.beforePublish?.();
      const published = await withControlLease(async () => {
        const freshControl = await hdControl();
        if (pausedSourceVersion !== undefined && freshControl.token !== control.token) throw new Error('hd_targeted_control_changed');
        if (pausedSourceVersion === undefined && freshControl.state === 'hard_pause') throw new Error('hd_publish_control_hold');
        // The receipt, rename and ready manifest all sit inside the same control
        // and job leases. Administrative/hard stops cannot interleave publication.
        await atomicHdJson(receiptFile, { job, temporary: temporary ? path.basename(temporary) : '' });
        if (job.format !== 'original') { await fs.rename(temporary, path.join(hdDirectory(), filename)); temporary = ''; }
        await atomicHdJson(jobPath(key), job);
        await fs.unlink(receiptFile);
        return true;
      });
      if (!published) throw new Error('hd_publish_control_hold');
    } catch (error) {
      if (error instanceof HdOutputIntegrityError) {
        job.integrity = error.integrity;
        if (attempt) attempt.integrity = error.integrity;
      }
      const message = (error as Error).message;
      const sourceFailure = ['source_missing', 'source_unreadable'].includes(message);
      const held = ['hd_publish_control_hold', 'hd_targeted_control_changed'].includes(message);
      job.status = sourceFailure && job.attempts < (job.attemptLimit ?? 3) || held ? 'queued' : message === 'source_incompatible' ? 'skipped' : 'failed';
      job.reason = sourceFailure || held || message === 'source_incompatible' || message === 'output_integrity' ? message : 'worker_integrity_failure';
      if (sourceFailure) {
        job.isolatedReason = message as HdJob['isolatedReason'];
        if (job.status === 'queued') job.retryAt = new Date((dependencies.clock || Date.now)() + Math.min(30 * 60_000, 60_000 * 5 ** (job.attempts - 1))).toISOString();
      } else if (!held && message !== 'source_incompatible' && pausedSourceVersion === undefined) await setHdControl(true, job.reason);
    } finally {
      // Never destroy an output still referenced by an interrupted publish receipt.
      const publicationPending = await fs.stat(receiptFile).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; });
      if (!publicationPending) {
        if (temporary) await fs.unlink(temporary).catch(() => {});
        if (attempt) Object.assign(attempt, { finishedAt: timestamp(), status: job.status, reason: job.reason });
        job.updatedAt = timestamp(); await atomicHdJson(jobPath(key), job);
      }
    }
  });
}
