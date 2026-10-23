import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import sharp from 'sharp';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { hdReadonlyDb } from './hd-readonly-db';
import { HD_CONTROL_PROTOCOL, HD_RETRY_POLICY, HdControl, HdResourceSample, hdManualReason, hdResourceTransition, hdRunState, sampleHdResources } from './hd-resource-state';
import { HD_MAX_PIXELS as MAX_PIXELS, HD_VALIDATION_VERSION, HdOutputIntegrityError, validateHdOutput, hdEncoderParameters, type HdIntegrity } from './hd-encoder';
import { hdDirectory, hdWorkerLockPath, assertHdStorageRoot, HD_UPLOAD_DIRECTORY_ACCESS, HD_OUTPUT_DIRECTORY_ACCESS } from './hd-storage-root';
import { HD_IMAGE_PROTOCOL, HdProcessorError, assertHdExecutionExited, hdImageProcessorStopping, runHdImageProcessor, type HdImageResult, type HdProcessorIdentity, type HdChildClose, type HdGroupExit } from './hd-image-processor';
export type { HdControl, HdResourceSample } from './hd-resource-state';
export { hdDirectory, hdWorkerLockPath, assertHdStorageRoot, HD_UPLOAD_DIRECTORY_ACCESS, HD_OUTPUT_DIRECTORY_ACCESS } from './hd-storage-root';
export { HD_VALIDATION_VERSION } from './hd-encoder';
export type { HdIntegrity } from './hd-encoder';

export const HD_POLICY = 'hd-f-v1';
export const HD_EXECUTION_EVIDENCE_PROTOCOL = 'hd-execution-evidence-v1';
const ROOT_RESERVE = 512000 * 1024;
const DATA_RESERVE = 2 * 1024 * 1024 * 1024;
type HdEncoder = {
  policy: string; validation: string; sourceSha256: string; libraries: typeof sharp.versions;
  parameters: { format: 'avif' | 'webp'; lossless: boolean; quality?: number; chromaSubsampling?: string; effort: number; orientation: string; bitdepth: number };
};
type HdAttempt = {
  attempt: number; startedAt: string; finishedAt?: string; sourceVersion: string;
  encoder?: HdEncoder; status: HdJob['status']; reason?: string; integrity?: HdIntegrity;
  executionId?: string; processor?: HdProcessorIdentity; childClose?: HdChildClose; groupExit?: HdGroupExit;
};
type HdVerification = {
  executionId: string; sourceVersion: string; operation: 'validate' | 'verify-original'; startedAt: string; finishedAt?: string;
  processor?: HdProcessorIdentity; childClose?: HdChildClose; groupExit?: HdGroupExit;
};
function validHdExecutionEvidence(value: Pick<HdAttempt, 'executionId' | 'processor' | 'childClose' | 'groupExit'>) {
  if (!value || typeof value !== 'object') return false;
  const { executionId, processor, childClose, groupExit } = value;
  return !(executionId !== undefined && !/^[a-f0-9-]{36}$/.test(executionId)
    || processor !== undefined && (!processor || processor.executionId !== executionId || !Number.isSafeInteger(processor.pid)
      || processor.pid <= 1 || processor.groupId !== processor.pid || typeof processor.host !== 'string' || !/^\d+$/.test(processor.startTicks))
    || childClose !== undefined && (!childClose || childClose.executionId !== executionId || !Number.isFinite(Date.parse(childClose.observedAt))
      || childClose.code !== null && !Number.isInteger(childClose.code)
      || childClose.signal !== null && !/^SIG[A-Z0-9]+$/.test(childClose.signal))
    || groupExit !== undefined && (!groupExit || groupExit.executionId !== executionId || groupExit.evidenceKind !== 'process-group-gone'
      || !Number.isFinite(Date.parse(groupExit.confirmedAt))));
}
export type HdJob = {
  key: string; source: string; version: string; policy: string; priority: number;
  status: 'queued' | 'running' | 'ready' | 'failed' | 'skipped'; reason?: string;
  attempts: number; updatedAt: string; preserveText: boolean;
  format?: 'avif' | 'webp' | 'original'; mime?: string; bytes?: number;
  width?: number; height?: number; file?: string; batch?: string;
  attemptLimit?: number; attemptHistory?: HdAttempt[]; integrity?: HdIntegrity;
  verificationHistory?: HdVerification[];
  retryHistory?: Array<{ at: string; previousAttempts: number; reason?: string; manifest: string }>;
  retryAt?: string; isolatedReason?: 'source_missing' | 'source_unreadable';
  protocol?: 'hd-job-v2'; queueRole?: HdQueueRole; stage?: HdJobStage; executionId?: string;
  executionEvidenceProtocol?: typeof HD_EXECUTION_EVIDENCE_PROTOCOL;
  errorKind?: string; lastProgressAt?: string; executionExitedAt?: string;
  processor?: HdProcessorIdentity; diagnostic?: { stage: string; code?: string; message?: string };
  publicationPending?: boolean; // Read-only queue projection, never a new status.
};
export type HdQueueRole = 'viewer' | 'new' | 'historical';
export type HdJobStage = 'queued' | 'reading' | 'encoding' | 'validating' | 'publishing';
export const HD_PRIORITY = Object.freeze({ new: 0, viewer: 1, recent: 2, historical: 3 });
export const hdQueueRole = (job: Pick<HdJob, 'priority' | 'queueRole'>): HdQueueRole => job.queueRole || (job.priority === 1 ? 'viewer' : job.priority === 0 ? 'new' : 'historical');
const roleRank: Record<HdQueueRole, number> = { viewer: 0, new: 1, historical: 2 };
const jobPath = (key: string) => path.join(hdDirectory(), `${key}.json`);
const now = () => new Date().toISOString();
export async function assertHdDirectoryAccess(access: typeof fs.access = fs.access) {
  await access(await fs.realpath(path.join(process.cwd(), 'public/uploads')), HD_UPLOAD_DIRECTORY_ACCESS);
  await assertHdStorageRoot(access);
}
export async function atomicHdJson(file: string, value: unknown) {
  if (process.env.NODE_ENV === 'production') await assertHdStorageRoot();
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
  if (process.env.NODE_ENV === 'production') await assertHdStorageRoot();
  try {
    const job = JSON.parse(await fs.readFile(jobPath(key), 'utf8')) as HdJob;
    if (job.key !== key || job.policy !== HD_POLICY || typeof job.source !== 'string' || typeof job.version !== 'string'
      || !['queued', 'running', 'ready', 'failed', 'skipped'].includes(job.status) || !Number.isInteger(job.attempts)
      || !Number.isInteger(job.priority) || typeof job.preserveText !== 'boolean'
      || (job.attemptLimit !== undefined && (!Number.isSafeInteger(job.attemptLimit) || job.attemptLimit < 3))
      || (job.attemptHistory !== undefined && (!Array.isArray(job.attemptHistory) || job.attemptHistory.some(attempt => !validHdExecutionEvidence(attempt))))
      || (job.verificationHistory !== undefined && (!Array.isArray(job.verificationHistory) || job.verificationHistory.some(value =>
        !validHdExecutionEvidence(value) || !value.executionId || typeof value.sourceVersion !== 'string'
        || !['validate', 'verify-original'].includes(value.operation) || !Number.isFinite(Date.parse(value.startedAt))
        || value.finishedAt !== undefined && !Number.isFinite(Date.parse(value.finishedAt)))))
      || (job.retryHistory !== undefined && !Array.isArray(job.retryHistory))
      || (job.protocol !== undefined && job.protocol !== 'hd-job-v2')
      || (job.executionEvidenceProtocol !== undefined && job.executionEvidenceProtocol !== HD_EXECUTION_EVIDENCE_PROTOCOL)
      || (job.queueRole !== undefined && !['viewer', 'new', 'historical'].includes(job.queueRole))
      || (job.stage !== undefined && !['queued', 'reading', 'encoding', 'validating', 'publishing'].includes(job.stage))
      || (job.executionId !== undefined && !/^[a-f0-9-]{36}$/.test(job.executionId))
      || (job.retryAt !== undefined && !Number.isFinite(Date.parse(job.retryAt)))
      || (job.lastProgressAt !== undefined && !Number.isFinite(Date.parse(job.lastProgressAt)))
      || (job.executionExitedAt !== undefined && !Number.isFinite(Date.parse(job.executionExitedAt)))
      || (job.processor !== undefined && (!/^[a-f0-9-]{36}$/.test(job.processor.executionId) || !Number.isSafeInteger(job.processor.pid)
        || job.processor.pid <= 1 || job.processor.groupId !== job.processor.pid || typeof job.processor.host !== 'string' || !/^\d+$/.test(job.processor.startTicks)))) throw new Error('invalid_hd_manifest');
    const executions = [...(job.attemptHistory || []), ...(job.verificationHistory || [])].map(value => value.executionId).filter(Boolean);
    if (new Set(executions).size !== executions.length) throw new Error('invalid_hd_manifest');
    return job;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
// Short manifest lease, shared by web, inventory and the dedicated worker.
export async function withHdLease<T>(key: string, action: () => Promise<T>): Promise<T | null> {
  if (!/^(?:[a-f0-9]{64}|control|discovery)$/.test(key)) throw new Error('invalid_hd_lease');
  const lock = path.join(hdDirectory(), `${key}.lock`);
  if (process.env.NODE_ENV === 'production') await assertHdStorageRoot();
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
export async function hdRequestIdentity(source: string, preserveText?: boolean) {
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
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 3) throw new Error('invalid_hd_priority');
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
  const requestedRole = hdQueueRole({ priority });
  if (existing && (existing.status === 'ready' || roleRank[hdQueueRole(existing)] <= roleRank[requestedRole])) return existing;
  const result = await withLease(key, async () => {
    const found = await readHdJob(key);
    const queueRole = found && roleRank[hdQueueRole(found)] <= roleRank[requestedRole] ? hdQueueRole(found) : requestedRole;
    const job: HdJob = found ? { ...found, priority: Math.min(priority, found.priority), protocol: 'hd-job-v2', queueRole } : {
      key, source, version: current.version, policy: HD_POLICY, priority, preserveText: Boolean(preserveText),
      attempts: 0, status: 'queued', protocol: 'hd-job-v2', queueRole, stage: 'queued', updatedAt: now(), ...(batch ? { batch } : {}),
    };
    await atomicHdJson(jobPath(key), job);
    return job;
  });
  // A claim held by another process is not a durable registration receipt.
  if (!result && !existing) throw new Error('hd_registration_pending');
  return result || existing!;
}
export async function listHdJobs() {
  if (process.env.NODE_ENV === 'production') await assertHdStorageRoot();
  const names: string[] = await fs.readdir(hdDirectory()).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  const jobs: HdJob[] = [];
  for (const name of names) if (/^[a-f0-9]{64}\.json$/.test(name)) {
    const job = await readHdJob(name.slice(0, -5));
    if (job) jobs.push(names.includes(job.key + '.publish.json') ? { ...job, publicationPending: true } : job);
  }
  for (const name of names.filter(name => /^[a-f0-9]{64}\.publish\.json$/.test(name))) if (!jobs.some(job => job.key === name.slice(0, -13))) throw new Error('hd_publish_unknown');
  return jobs;
}
export async function hdCapacity(reserve = 0) {
  const root = await fs.statfs('/');
  const directory = await assertHdStorageRoot();
  const data = await fs.statfs(directory.root);
  const rootFree = root.bavail * root.bsize;
  const dataFree = data.bavail * data.bsize;
  const rootDevice = (await fs.stat('/')).dev;
  const dataDevice = directory.device;
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
    if (control.diagnostic !== undefined && (!Number.isFinite(Date.parse(control.diagnostic.at)) || typeof control.diagnostic.phase !== 'string'
      || typeof control.diagnostic.code !== 'string' || typeof control.diagnostic.message !== 'string' || control.diagnostic.message.length > 240)) throw new Error('invalid_hd_control');
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
export function hdWorkerFailureSummary(error: unknown, phase = 'startup') {
  const value = error instanceof Error ? error : new Error('unknown_worker_failure');
  const trusted = /^(?:hd_[a-z0-9_]+|invalid_(?:hd|discovery)_[a-z0-9_]+|capacity_guard|storage_check_unknown|source_boundary|output_integrity|worker_integrity_failure)$/;
  const errno = (error as NodeJS.ErrnoException | null)?.code;
  const code = trusted.test(value.message) ? value.message : typeof errno === 'string' && /^[A-Z0-9_]{1,40}$/.test(errno) ? errno : 'unknown_worker_failure';
  const message = value.message.replace(/\s+/g, ' ').replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    .replace(/\/(?:[^\s'"<>]+\/)*[^\s'"<>]*/g, '[path]')
    .replace(/(?:key|token|password|secret|authorization)\s*[:=]\s*\S+/gi, '[credential]')
    .replace(/[a-zA-Z0-9_=-]{40,}/g, '[identifier]').slice(0, 240);
  return { at: now(), phase: /^[a-z_]{1,32}$/.test(phase) ? phase : 'unknown', code, message };
}
export async function recordHdWorkerFailure(error: unknown, phase?: string) {
  const diagnostic = hdWorkerFailureSummary(error, phase);
  const result = await withControlLease(async () => {
    const current = await hdControl();
    const reason = current.state === 'hard_pause' && current.reason !== 'load_guard' ? current.reason
      : diagnostic.code === 'unknown_worker_failure' || /^[A-Z0-9_]+$/.test(diagnostic.code) ? 'worker_integrity_failure' : diagnostic.code;
    return writeHdControl(current, { ...current, paused: true, state: 'hard_pause', reason, wait: undefined, diagnostic });
  });
  if (!result) throw new Error('hd_control_conflict');
  return result;
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
  if ((await hdControl()).state === 'hard_pause') throw new Error('hd_hard_pause_requires_review');
  return withLease(key, async () => {
    if ((await hdControl()).state === 'hard_pause') throw new Error('hd_hard_pause_requires_review');
    const job = await readHdJob(key);
    if (!job || job.version !== expectedVersion || (await hdSource(job.source))?.version !== expectedVersion) throw new Error('hd_retry_source_changed');
    if (job.status === 'queued') return job; // Repeating the same request does not grant a further retry budget.
    if (job.status !== 'failed') throw new Error('hd_retry_requires_failed');
    if (!isHdRetryableFailure(job)) throw new Error('hd_retry_requires_review');
    if (job.processor) await assertHdExecutionExited(job.processor);
    if (await fs.stat(path.join(hdDirectory(), key + '.publish.json')).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('hd_publish_unknown');
    await preserveFailedHd(job);
    // attempts remains a lifetime count for this targeted recovery; allow up to three new attempts.
    job.attemptLimit = job.attempts + 3;
    job.status = 'queued'; job.stage = 'queued'; job.retryAt = undefined; job.updatedAt = now();
    await atomicHdJson(jobPath(key), job);
    return job;
  });
}
export async function retryFailedHd() {
  if ((await hdControl()).state === 'hard_pause') throw new Error('hd_hard_pause_requires_review');
  for (const job of await listHdJobs()) if (isHdRetryableFailure(job)) await retryHdKey(job.key, job.version);
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
    if (job.lastProgressAt) completion(job.lastProgressAt, false);
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
  const processingJob = jobs.find(job => job.status === 'running');
  const processingAttempt = processingJob?.attemptHistory?.[processingJob.attemptHistory.length - 1];
  const processing = processingJob ? { key: processingJob.key, stage: processingJob.stage || null, executionId: processingJob.executionId || null,
    startedAt: processingAttempt?.startedAt || null, lastProgressAt: processingJob.lastProgressAt || null,
    attempt: processingJob.attempts, attemptLimit: processingJob.attemptLimit ?? 3 } : null;
  const retries = jobs.filter(job => job.status === 'queued' && job.retryAt);
  const futureRetries = retries.filter(job => Date.parse(job.retryAt!) > capturedMs);
  const retry = { waiting: futureRetries.length, due: retries.length - futureRetries.length,
    exhausted: jobs.filter(job => isHdRetryableFailure(job) && job.attempts >= (job.attemptLimit ?? 3)).length,
    nextRetryAt: futureRetries.map(job => job.retryAt!).sort()[0] || null };
  return { policy: HD_POLICY, counts, reasons, batches, newCounts, control, capacity: await hdCapacity(), total: jobs.length,
    state: control.state, resource: control.resource || null, waitSince: control.wait?.since || null, isolation, processing, retry,
    discovery: await discovery.hdDiscoveryStatus(checkpoint),
    lastSuccessAt: lastSuccessMs === null ? null : new Date(lastSuccessMs).toISOString(),
    lastProgressAt: lastProgressMs === null ? null : new Date(lastProgressMs).toISOString(), stalled, stallThresholdMs };
}
export type HdFairnessState = { consecutiveViewer: number; consecutiveForeground: number };
export const HD_FAIRNESS_POLICY = Object.freeze({ viewerBurst: 2, foregroundBurst: 4 });
export function nextHdFairness(state: HdFairnessState, job: HdJob): HdFairnessState {
  const role = hdQueueRole(job);
  return { consecutiveViewer: role === 'viewer' ? Math.min(HD_FAIRNESS_POLICY.viewerBurst, state.consecutiveViewer + 1) : 0,
    consecutiveForeground: role === 'historical' ? 0 : Math.min(HD_FAIRNESS_POLICY.foregroundBurst, state.consecutiveForeground + 1) };
}
export function selectHdJob(jobs: HdJob[], fairness: number | HdFairnessState, batch: string, clock = Date.now()) {
  const state = typeof fairness === 'number' ? { consecutiveViewer: 0, consecutiveForeground: fairness } : fairness;
  const pending = jobs.filter(job => job.publicationPending || ['queued', 'running'].includes(job.status) && (!job.retryAt || Date.parse(job.retryAt) <= clock))
    .sort((a, b) => Number(Boolean(b.publicationPending)) - Number(Boolean(a.publicationPending))
      || roleRank[hdQueueRole(a)] - roleRank[hdQueueRole(b)] || a.updatedAt.localeCompare(b.updatedAt) || a.key.localeCompare(b.key));
  if (pending[0]?.publicationPending) return pending[0];
  const historical = pending.find(job => hdQueueRole(job) === 'historical' && job.batch === batch)
    || pending.find(job => hdQueueRole(job) === 'historical');
  if (state.consecutiveForeground >= HD_FAIRNESS_POLICY.foregroundBurst && historical) return historical;
  if (state.consecutiveViewer >= HD_FAIRNESS_POLICY.viewerBurst) return pending.find(job => hdQueueRole(job) === 'new') || historical || pending[0];
  return pending[0];
}
export { hdEligibility, validateHdOutput } from './hd-encoder';
export async function assertHdWorkerLock() {
  if (process.platform !== 'linux') throw new Error('hd_targeted_requires_worker_lock');
  const lock = await fs.stat(hdWorkerLockPath(), { bigint: true }).catch(() => null);
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
  processor?: typeof runHdImageProcessor;
};
const retryDelay = (attempt: number) => HD_RETRY_POLICY.delaysMs[Math.min(Math.max(attempt - 1, 0), HD_RETRY_POLICY.delaysMs.length - 1)];
export function isHdRetryableFailure(job: HdJob) {
  const kind = job.errorKind || job.reason;
  return job.status === 'failed' && (['source_missing', 'source_unreadable', 'temporary_io'].includes(kind || '')
    || kind === 'encode_timeout' && Boolean(job.executionExitedAt && Number.isFinite(Date.parse(job.executionExitedAt))));
}
async function privateHdRun(key: string, executionId: string) {
  const root = await fs.realpath(hdDirectory());
  const runs = path.join(root, '.runs');
  await fs.mkdir(runs, { recursive: true, mode: 0o700 });
  if (await fs.realpath(runs) !== runs) throw new Error('hd_output_boundary');
  const directory = path.join(runs, key + '.' + executionId);
  await fs.mkdir(directory, { mode: 0o700 });
  if (await fs.realpath(directory) !== directory) throw new Error('hd_output_boundary');
  return directory;
}
async function cleanupHdRun(directory: string) {
  // Only the two fixed filenames in this execution's newly-created directory.
  // Unknown files/directories remain evidence instead of recursive deletion.
  for (const format of ['avif', 'webp']) await fs.unlink(path.join(directory, 'output.' + format)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await fs.rmdir(directory).catch(error => { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; });
}
const hdFileVersion = (stat: Awaited<ReturnType<typeof fs.stat>>) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
async function assertHdProcessorOutput(result: HdImageResult, job: HdJob, input: { file: string; version: string; size: number }, directory: string) {
  if (result.key !== job.key || result.executionId !== job.executionId || result.sourceVersion !== job.version
    || result.inputFile !== input.file || result.workDirectory !== directory || result.metadata.bytes !== input.size
    || JSON.stringify(result.libraries) !== JSON.stringify(sharp.versions)) throw new Error('hd_child_protocol');
  if (result.skipped || result.originalVerified) return;
  const format = result.metadata.hasAlpha || job.preserveText ? 'webp' : 'avif';
  if (result.format !== format || JSON.stringify(result.parameters) !== JSON.stringify(hdEncoderParameters(format))
    || result.outputFile !== 'output.' + format) throw new Error('hd_child_protocol');
  const file = path.join(directory, result.outputFile);
  if (await fs.realpath(file) !== file) throw new Error('hd_output_boundary');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== result.bytes || !stat.size || hdFileVersion(stat) !== result.outputVersion) throw new Error('output_integrity');
  // A same-size replacement must not be accepted from a different generation.
  const current = await readHdJob(job.key);
  if (current?.executionId !== job.executionId || current.version !== job.version) throw new Error('hd_execution_changed');
}

export async function processHdJob(key: string, pausedSourceVersion?: string, dependencies: HdProcessDependencies = {}) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid_hd_process_target');
  const capacity = dependencies.capacity || hdCapacity;
  const processor = dependencies.processor || runHdImageProcessor;
  const clock = dependencies.clock || Date.now;
  const timestamp = () => new Date(clock()).toISOString();
  if (pausedSourceVersion !== undefined) await (dependencies.assertWorkerLock || assertHdWorkerLock)();
  let leaseHeld = false;
  return withLease(key, async () => {
    leaseHeld = true;
    let deferEvidence = false;
    const lateEvidence: Array<{ save: () => Promise<void>; resolve: () => void; reject: (error: unknown) => void }> = [];
    try {
    const job = await readHdJob(key);
    // Normal callbacks already own this key lease. A genuinely late close may
    // reacquire it, but can only amend its exact historical execution record.
    const observeAttempt = async (executionId: string, number: number | null, version: string, patch: Partial<HdAttempt>, top: Partial<HdJob> = {}) => {
      if ([patch.processor, patch.childClose, patch.groupExit].some(value => value && value.executionId !== executionId)) throw new Error('hd_execution_changed');
      const save = async () => {
        const fresh = await readHdJob(key);
        const history = number === null ? fresh?.verificationHistory : fresh?.attemptHistory;
        const matches = history?.filter(value => value.executionId === executionId && (number === null || (value as HdAttempt).attempt === number) && value.sourceVersion === version) || [];
        if (!fresh || matches.length !== 1) throw new Error('hd_execution_changed');
        const target = matches[0];
        if (patch.childClose && target.childClose && JSON.stringify(target.childClose) !== JSON.stringify(patch.childClose)) throw new Error('hd_execution_changed');
        if (patch.groupExit && target.groupExit) patch = { ...patch, groupExit: target.groupExit };
        Object.assign(target, patch);
        const current = leaseHeld && fresh.version === version && (number === null
          ? fresh.verificationHistory?.[fresh.verificationHistory.length - 1]?.executionId === executionId && fresh.executionId === job?.executionId
          : fresh.executionId === executionId);
        if (current) Object.assign(fresh, top);
        await atomicHdJson(jobPath(key), fresh);
        const localHistory = number === null ? job?.verificationHistory : job?.attemptHistory;
        const local = localHistory?.find(value => value.executionId === executionId && (number === null || (value as HdAttempt).attempt === number) && value.sourceVersion === version);
        if (leaseHeld && local) Object.assign(local, patch);
        if (current && job) Object.assign(job, top);
      };
      if (leaseHeld) {
        // A real close delivered after the processor returned must not race the
        // caller's publication/final manifest write under this same lease.
        if (deferEvidence) return new Promise<void>((resolve, reject) => { lateEvidence.push({ save, resolve, reject }); });
        return save();
      }
      try { if (await withLease(key, async () => { await save(); return true; }) !== true) throw new Error('hd_lease_conflict'); }
      catch (error) { await setHdControl(true, 'worker_integrity_failure'); throw error; }
    };
    const control = await hdControl();
    const receiptFile = path.join(hdDirectory(), key + '.publish.json');
    const receipt = await fs.readFile(receiptFile, 'utf8').then(text => JSON.parse(text) as {
      job: HdJob; temporary: string; protocol?: string; executionId?: string; sourceVersion?: string;
    }).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (pausedSourceVersion !== undefined) {
      if (!control.paused || !['operator_pause', 'admin_pause', 'output_integrity'].includes(control.reason || '')) throw new Error('hd_targeted_requires_safe_pause');
      if (!job || job.status !== 'queued') throw new Error('hd_targeted_requires_queued');
      if (job.version !== pausedSourceVersion || (await hdSource(job.source))?.version !== pausedSourceVersion) throw new Error('hd_targeted_source_changed');
    } else if (!job || !['queued', 'running'].includes(job.status) && !receipt || control.paused) return;
    if (!job || !receipt && job.retryAt && Date.parse(job.retryAt) > clock()) return;
    // Even a running manifest cannot authorize a new encoder until the recorded
    // prior process and its group have been proved gone.
    if (job.processor) {
      try {
        await assertHdExecutionExited(job.processor); job.executionExitedAt = timestamp();
        const previous = job.attemptHistory?.find(value => value.executionId === job.processor!.executionId && value.sourceVersion === job.version)
          || job.verificationHistory?.find(value => value.executionId === job.processor!.executionId && value.sourceVersion === job.version);
        if (previous) await observeAttempt(previous.executionId!, 'attempt' in previous ? previous.attempt : null, previous.sourceVersion,
          { groupExit: { executionId: previous.executionId!, confirmedAt: job.executionExitedAt, evidenceKind: 'process-group-gone' } },
          { executionExitedAt: job.executionExitedAt });
      }
      catch (error) { await setHdControl(true, 'hd_child_exit_unknown'); throw error; }
    }
    if (receipt) {
      let verificationDirectory = '';
      let verificationExited = true;
      let verification: HdVerification | undefined;
      try {
        if (!receipt.job || receipt.job.key !== key || receipt.job.version !== job.version || receipt.job.status !== 'ready'
          || receipt.job.policy !== HD_POLICY || receipt.job.source !== job.source || receipt.job.preserveText !== job.preserveText
          || receipt.job.integrity?.version !== HD_VALIDATION_VERSION || receipt.job.integrity.failedChecks.length
          || receipt.protocol !== undefined && (receipt.protocol !== 'hd-publish-v2' || receipt.executionId !== job.executionId
            || receipt.job.executionId !== job.executionId || receipt.sourceVersion !== job.version)) throw new Error('hd_publish_receipt_invalid');
        const input = await hdSource(job.source);
        if (!input || input.version !== job.version) throw new Error('hd_publish_receipt_invalid');
        const verificationId = randomUUID();
        job.executionEvidenceProtocol = HD_EXECUTION_EVIDENCE_PROTOCOL;
        verification = { executionId: verificationId, sourceVersion: job.version,
          operation: receipt.job.format === 'original' ? 'verify-original' : 'validate', startedAt: timestamp() };
        job.verificationHistory = [...(job.verificationHistory || []), verification];
        await atomicHdJson(jobPath(key), job);
        verificationDirectory = await privateHdRun(key, verificationId);
        let candidate = '';
        let candidateVersion = '';
        if (receipt.job.format !== 'original') {
          if (!['avif', 'webp'].includes(receipt.job.format || '') || receipt.job.file !== key + '.' + receipt.job.format
            || receipt.job.mime !== 'image/' + receipt.job.format) throw new Error('hd_publish_receipt_invalid');
          const target = path.join(hdDirectory(), receipt.job.file);
          const exists = await fs.stat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (!exists && !new RegExp('^' + key + '\\.(avif|webp)\\.[a-f0-9-]+\\.tmp$').test(receipt.temporary)) throw new Error('hd_publish_receipt_invalid');
          candidate = exists ? target : path.join(hdDirectory(), receipt.temporary);
          const root = await fs.realpath(hdDirectory());
          if (!(await fs.realpath(candidate)).startsWith(root + path.sep)) throw new Error('hd_output_boundary');
          const info = await fs.lstat(candidate);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== receipt.job.bytes) throw new Error('hd_publish_receipt_invalid');
          candidateVersion = hdFileVersion(info);
          await fs.copyFile(candidate, path.join(verificationDirectory, 'output.' + receipt.job.format), fsConstants.COPYFILE_EXCL);
        }
        const verified = await processor({ protocol: HD_IMAGE_PROTOCOL, key, executionId: verificationId, sourceVersion: job.version,
          inputFile: input.file, workDirectory: verificationDirectory, preserveText: job.preserveText,
          operation: receipt.job.format === 'original' ? 'verify-original' : 'validate', candidateFormat: receipt.job.format === 'original' ? undefined : receipt.job.format as 'avif' | 'webp' },
        { onSpawn: async identity => {
          // Receipt generation remains the original publication identity; this
          // independent verification process has its own durable PID/start ID.
          job.processor = identity; job.stage = 'validating'; job.lastProgressAt = timestamp(); verificationExited = false;
          verification!.processor = identity;
          await observeAttempt(verificationId, null, job.version, { processor: identity }, { processor: identity, stage: job.stage, lastProgressAt: job.lastProgressAt });
        }, onClose: observation => observeAttempt(verificationId, null, verification!.sourceVersion, { childClose: observation }),
        onGroupExit: async observation => {
          await observeAttempt(verificationId, null, verification!.sourceVersion, { groupExit: observation }); verificationExited = true;
        }, onStage: async stage => {
          job.stage = stage; job.lastProgressAt = timestamp(); await atomicHdJson(jobPath(key), job);
        } });
        deferEvidence = true; verificationExited = true;
        verification.finishedAt = timestamp(); await atomicHdJson(jobPath(key), job);
        const width = [5, 6, 7, 8].includes(verified.metadata.orientation) ? verified.metadata.height : verified.metadata.width;
        const height = [5, 6, 7, 8].includes(verified.metadata.orientation) ? verified.metadata.width : verified.metadata.height;
        if (verified.metadata.bytes !== input.size || width !== receipt.job.width || height !== receipt.job.height
          || (receipt.job.format === 'original' ? !verified.originalVerified || receipt.job.bytes !== input.size : verified.bytes !== receipt.job.bytes)
          || (await hdSource(job.source))?.version !== job.version) throw new Error('hd_publish_receipt_invalid');
        if (candidate && hdFileVersion(await fs.lstat(candidate)) !== candidateVersion) throw new Error('hd_publish_receipt_invalid');
        const resumed = await withControlLease(async () => {
          const fresh = await hdControl();
          if (fresh.state === 'hard_pause' || hdImageProcessorStopping()) return false;
          if (receipt.job.format !== 'original') {
            const destination = path.join(hdDirectory(), receipt.job.file!);
            const exists = await fs.stat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
            if (exists && candidate !== destination || !exists && candidate === destination) throw new Error('hd_publish_receipt_invalid');
            if (!exists) await fs.rename(candidate, destination);
            const info = await fs.stat(destination);
            if (!info.isFile() || info.size !== receipt.job.bytes) throw new Error('hd_publish_receipt_invalid');
          }
          for (const publishedAttempt of receipt.job.attemptHistory || []) {
            if (!publishedAttempt.executionId) continue;
            const observed = job.attemptHistory?.find(value => value.executionId === publishedAttempt.executionId
              && value.attempt === publishedAttempt.attempt && value.sourceVersion === publishedAttempt.sourceVersion);
            if (observed) for (const field of ['processor', 'childClose', 'groupExit'] as const)
              if (observed[field]) Object.assign(publishedAttempt, { [field]: observed[field] });
          }
          receipt.job.verificationHistory = job.verificationHistory;
          receipt.job.executionEvidenceProtocol = HD_EXECUTION_EVIDENCE_PROTOCOL;
          await atomicHdJson(jobPath(key), receipt.job);
          await fs.unlink(receiptFile);
          return true;
        });
        if (!resumed) throw new Error('hd_publish_control_hold');
        return;
      } catch (error) {
        deferEvidence = true;
        if (error instanceof HdProcessorError) verificationExited = error.exited;
        await setHdControl(true, error instanceof HdProcessorError && error.kind === 'output_integrity' ? 'output_integrity' : 'worker_integrity_failure');
        throw error;
      } finally {
        if (verification && !verification.finishedAt) {
          verification.finishedAt = timestamp();
          // This is the caller's final write, not a child callback. It already
          // owns the lease and must precede deferred late observations.
          await atomicHdJson(jobPath(key), job);
        }
        if (verificationDirectory && verificationExited) await cleanupHdRun(verificationDirectory);
      }
    }
    for (const format of ['avif', 'webp']) {
      const published = await fs.lstat(path.join(hdDirectory(), key + '.' + format)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (published) { await setHdControl(true, 'hd_publish_unknown'); throw new Error('hd_publish_unknown'); }
    }
    let temporary = '', directory = '';
    let attempt: HdAttempt | undefined;
    let executionExited = true;
    try {
      if (job.attempts >= (job.attemptLimit ?? 3)) { job.status = 'failed'; job.reason = 'retry_limit'; return; }
      const interrupted = job.attemptHistory?.[job.attemptHistory.length - 1];
      if (interrupted?.status === 'running' && !interrupted.finishedAt) Object.assign(interrupted, { finishedAt: timestamp(), status: 'failed', reason: 'worker_interrupted' });
      job.status = 'running'; job.attempts++; job.updatedAt = timestamp(); job.protocol = 'hd-job-v2';
      job.executionEvidenceProtocol = HD_EXECUTION_EVIDENCE_PROTOCOL;
      job.stage = 'reading'; job.executionId = randomUUID(); job.lastProgressAt = timestamp();
      job.processor = undefined; job.executionExitedAt = undefined; job.errorKind = undefined; job.diagnostic = undefined;
      job.reason = undefined; job.integrity = undefined; job.retryAt = undefined; job.isolatedReason = undefined;
      attempt = { attempt: job.attempts, startedAt: job.updatedAt, sourceVersion: job.version, status: 'running', executionId: job.executionId };
      job.attemptHistory = [...(job.attemptHistory || []), attempt];
      await atomicHdJson(jobPath(key), job);
      const input = await hdSource(job.source);
      if (!input || input.version !== job.version) { job.status = 'skipped'; job.reason = 'source_changed'; return; }
      directory = await privateHdRun(key, job.executionId);
      const executionId = job.executionId, attemptNumber = attempt.attempt, sourceVersion = attempt.sourceVersion;
      const result = await processor({ protocol: HD_IMAGE_PROTOCOL, key, executionId, sourceVersion: job.version,
        inputFile: input.file, workDirectory: directory, preserveText: job.preserveText, operation: 'encode' }, {
        onSpawn: async identity => {
          executionExited = false;
          if (identity.executionId !== executionId) throw new Error('hd_execution_changed');
          // Retain the known fork identity for the failure manifest too, even
          // when the first durable spawn write itself fails.
          attempt!.processor = identity; job.processor = identity;
          await observeAttempt(executionId, attemptNumber, sourceVersion, { processor: identity }, { processor: identity });
        },
        onClose: observation => observeAttempt(executionId, attemptNumber, sourceVersion, { childClose: observation }),
        onGroupExit: async observation => {
          await observeAttempt(executionId, attemptNumber, sourceVersion, { groupExit: observation }, { executionExitedAt: observation.confirmedAt });
          if (leaseHeld && job.executionId === executionId) executionExited = true;
        },
        onStage: async stage => {
          job.stage = stage; job.lastProgressAt = timestamp(); job.updatedAt = timestamp();
          await atomicHdJson(jobPath(key), job);
        },
        onPrepared: async metadata => {
          const safe = (await capacity(input.size * 3 + metadata.width * metadata.height * 8)).safe;
          if (!safe && pausedSourceVersion === undefined) await setHdControl(true, 'capacity_guard');
          return safe;
        },
      });
      deferEvidence = true; executionExited = true; job.executionExitedAt = timestamp();
      await assertHdProcessorOutput(result, job, input, directory);
      if (result.skipped) { job.status = 'skipped'; job.reason = result.skipped; return; }
      const format = result.format!;
      temporary = path.join(directory, result.outputFile!);
      // The optional dependency is only an offline fault seam; production has
      // already performed this same complete validation in the isolated child.
      if (dependencies.validate) {
        const meta = await sharp(input.file, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).metadata();
        await dependencies.validate(input.file, meta, temporary, format);
      }
      job.integrity = result.integrity; attempt.integrity = result.integrity;
      attempt.encoder = { policy: HD_POLICY, validation: HD_VALIDATION_VERSION,
        sourceSha256: createHash('sha256').update(await fs.readFile(path.join(process.cwd(), 'src/lib/media/hd-encoder.ts'))).digest('hex'),
        libraries: { ...sharp.versions }, parameters: hdEncoderParameters(format) };
      const width = [5, 6, 7, 8].includes(result.metadata.orientation) ? result.metadata.height : result.metadata.width;
      const height = [5, 6, 7, 8].includes(result.metadata.orientation) ? result.metadata.width : result.metadata.height;
      if ((await hdSource(job.source))?.version !== job.version) { job.status = 'skipped'; job.reason = 'source_changed'; return; }
      if (!(await capacity()).safe) {
        if (pausedSourceVersion === undefined) await setHdControl(true, 'capacity_guard');
        job.status = 'queued'; job.reason = 'capacity_guard'; return;
      }
      const filename = key + '.' + format;
      Object.assign(job, { width, height, bytes: result.bytes, format, mime: 'image/' + format });
      if (format === 'avif' && result.bytes! >= input.size) {
        Object.assign(job, { format: 'original', mime: 'image/' + (result.metadata.originalFormat === 'jpg' ? 'jpeg' : result.metadata.originalFormat), bytes: input.size, reason: 'original_smaller', file: undefined });
      } else Object.assign(job, { file: filename, reason: undefined });
      job.stage = 'publishing'; job.lastProgressAt = timestamp();
      await atomicHdJson(jobPath(key), job);
      await dependencies.beforePublish?.();
      const published = await withControlLease(async () => {
        const freshControl = await hdControl();
        if (pausedSourceVersion !== undefined && freshControl.token !== control.token) throw new Error('hd_targeted_control_changed');
        if (hdImageProcessorStopping() || pausedSourceVersion === undefined && freshControl.state === 'hard_pause') throw new Error('hd_publish_control_hold');
        const fresh = await readHdJob(key);
        if (!fresh || fresh.executionId !== job.executionId || fresh.version !== job.version) throw new Error('hd_execution_changed');
        if ((await hdSource(job.source))?.version !== job.version) throw new Error('source_changed');
        if (job.format !== 'original') {
          if (hdFileVersion(await fs.lstat(temporary)) !== result.outputVersion) throw new Error('output_integrity');
          // Preserve the legacy receipt basename so compatible recovery readers
          // can finish a crash on either side of rename without re-encoding.
          const durableTemporary = path.join(hdDirectory(), filename + '.' + job.executionId + '.tmp');
          await fs.rename(temporary, durableTemporary); temporary = durableTemporary;
          const handle = await fs.open(temporary, 'r');
          try { await handle.sync(); } finally { await handle.close(); }
        }
        job.status = 'ready'; job.stage = undefined; job.updatedAt = timestamp(); job.lastProgressAt = job.updatedAt;
        Object.assign(attempt!, { finishedAt: timestamp(), status: 'ready', reason: job.reason });
        await atomicHdJson(receiptFile, { protocol: 'hd-publish-v2', executionId: job.executionId, sourceVersion: job.version,
          job, temporary: job.format === 'original' ? '' : path.basename(temporary) });
        if (job.format !== 'original') { await fs.rename(temporary, path.join(hdDirectory(), filename)); temporary = ''; }
        await atomicHdJson(jobPath(key), job);
        await fs.unlink(receiptFile);
        return true;
      });
      if (!published) throw new Error('hd_publish_control_hold');
    } catch (error) {
      deferEvidence = true;
      const processorError = error instanceof HdProcessorError ? error : null;
      if (processorError) {
        executionExited = processorError.exited;
        if (processorError.exited) job.executionExitedAt = timestamp();
        job.diagnostic = processorError.diagnostic;
      }
      const integrity = error instanceof HdOutputIntegrityError ? error.integrity : processorError?.integrity;
      if (integrity) { job.integrity = integrity; if (attempt) attempt.integrity = integrity; }
      const reported = processorError?.kind || (error as Error).message;
      const known = ['source_missing', 'source_unreadable', 'source_changed', 'source_incompatible', 'temporary_io', 'encode_timeout',
        'output_integrity', 'worker_integrity_failure', 'hd_publish_control_hold', 'hd_targeted_control_changed', 'hd_shutdown',
        'capacity_guard', 'hd_child_exit_unknown', 'hd_child_protocol', 'hd_child_abnormal_exit', 'hd_child_spawn_failure',
        'hd_execution_changed', 'hd_processor_busy', 'hd_output_boundary', 'source_boundary'];
      let message = known.includes(reported) ? reported : 'worker_integrity_failure';
      if (!processorError) {
        const diagnostic = hdWorkerFailureSummary(error, job.stage || 'reading');
        job.diagnostic = { stage: job.stage || 'reading', code: diagnostic.code, message: diagnostic.message };
      }
      if (['source_missing', 'source_unreadable', 'temporary_io', 'encode_timeout'].includes(message)) {
        try { await assertHdDirectoryAccess(); }
        catch (sharedError) {
          message = 'storage_check_unknown';
          const diagnostic = hdWorkerFailureSummary(sharedError, job.stage || 'reading');
          job.diagnostic = { stage: job.stage || 'reading', code: diagnostic.code, message: diagnostic.message };
        }
      }
      const sourceFailure = ['source_missing', 'source_unreadable'].includes(message);
      const temporaryFailure = sourceFailure || ['temporary_io', 'encode_timeout'].includes(message) && executionExited;
      const held = ['hd_publish_control_hold', 'hd_targeted_control_changed', 'hd_shutdown'].includes(message);
      const capacityHold = message === 'capacity_guard';
      const skipped = ['source_incompatible', 'source_changed'].includes(message);
      const receiptPending = await fs.stat(receiptFile).then(() => true).catch(cause => { if (cause.code === 'ENOENT') return false; throw cause; });
      job.status = skipped ? 'skipped' : !receiptPending && (held || capacityHold || temporaryFailure && job.attempts < (job.attemptLimit ?? 3)) ? 'queued' : 'failed';
      job.errorKind = message;
      job.reason = temporaryFailure || held || capacityHold || skipped || ['output_integrity', 'hd_child_exit_unknown', 'storage_check_unknown'].includes(message) ? message : 'worker_integrity_failure';
      if (sourceFailure) job.isolatedReason = message as HdJob['isolatedReason'];
      if (temporaryFailure && !receiptPending && job.status === 'queued') job.retryAt = new Date(clock() + retryDelay(job.attempts)).toISOString();
      if (capacityHold && job.attempts > 0) job.attempts--;
      if (receiptPending || !executionExited || !temporaryFailure && !held && !capacityHold && !skipped) {
        if (pausedSourceVersion === undefined) await setHdControl(true, receiptPending ? 'hd_publish_unknown' : job.reason);
      }
    } finally {
      // Never destroy a file referenced by a receipt, nor an unconfirmed child
      // execution. A new supervisor must explain those before starting a writer.
      const publicationPending = await fs.stat(receiptFile).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; });
      if (!publicationPending) {
        if (executionExited) {
          if (temporary) await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
          if (directory) await cleanupHdRun(directory);
        }
        if (attempt) Object.assign(attempt, { finishedAt: timestamp(), status: job.status, reason: job.reason });
        if (job.status === 'queued') job.stage = 'queued';
        else if (job.status !== 'running') job.stage = undefined;
        job.updatedAt = timestamp(); await atomicHdJson(jobPath(key), job);
      }
    }
    } finally {
      try {
        while (lateEvidence.length) {
          const item = lateEvidence.shift()!;
          try { await item.save(); item.resolve(); }
          catch (error) { item.reject(error); await setHdControl(true, 'worker_integrity_failure'); throw error; }
        }
      } finally { leaseHeld = false; }
    }
  });
}
