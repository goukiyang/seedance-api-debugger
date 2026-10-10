import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { hdReadonlyDb } from './hd-readonly-db';

export const HD_POLICY = 'hd-f-v1';
const MAX_PIXELS = 40_000_000;
const ROOT_RESERVE = 512000 * 1024;
const DATA_RESERVE = 2 * 1024 * 1024 * 1024;
export type HdJob = {
  key: string; source: string; version: string; policy: string; priority: number;
  status: 'queued' | 'running' | 'ready' | 'failed' | 'skipped'; reason?: string;
  attempts: number; updatedAt: string; preserveText: boolean;
  format?: 'avif' | 'webp' | 'original'; mime?: string; bytes?: number;
  width?: number; height?: number; file?: string; batch?: string;
};
export const hdDirectory = () => path.join(process.cwd(), 'storage', 'hd-derivatives');
const jobPath = (key: string) => path.join(hdDirectory(), `${key}.json`);
const now = () => new Date().toISOString();
export async function atomicHdJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600 }); await fs.rename(tmp, file); }
  finally { await fs.unlink(tmp).catch(() => {}); }
}
export async function hdSource(source: string) {
  const local = siteUploadPathFromUrl(source);
  if (!local) return null;
  const root = await fs.realpath(path.join(process.cwd(), 'public/uploads'));
  const file = await fs.realpath(path.resolve(process.cwd(), 'public', decodeURIComponent(local).replace(/^\/+/, '')));
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error('source_boundary');
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
      || !Number.isInteger(job.priority) || typeof job.preserveText !== 'boolean') throw new Error('invalid_hd_manifest');
    return job;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
// Short manifest lease, shared by web, inventory and the dedicated worker.
async function withLease<T>(key: string, action: () => Promise<T>): Promise<T | null> {
  const lock = path.join(hdDirectory(), `${key}.lock`);
  await fs.mkdir(hdDirectory(), { recursive: true, mode: 0o700 });
  try { await fs.mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const age = Date.now() - (await fs.stat(lock)).mtimeMs;
    if (age < 180000) return null;
    const stale = `${lock}.${randomUUID()}.expired`;
    try { await fs.rename(lock, stale); await fs.rmdir(stale); } catch { return null; }
    try { await fs.mkdir(lock); } catch { return null; }
  }
  const heartbeat = setInterval(() => { const date = new Date(); void fs.utimes(lock, date, date).catch(() => {}); }, 15000);
  try { return await action(); }
  finally { clearInterval(heartbeat); await fs.rmdir(lock).catch(() => {}); }
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
  return result || existing || { key, source, version: current.version, policy: HD_POLICY, priority,
    preserveText: Boolean(preserveText), attempts: 0, status: 'queued' as const, updatedAt: now() };
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
export async function hdControl() {
  try {
    const control = JSON.parse(await fs.readFile(path.join(hdDirectory(), 'control.json'), 'utf8')) as { paused: boolean; reason?: string };
    if (typeof control.paused !== 'boolean' || (control.reason !== undefined && typeof control.reason !== 'string')) throw new Error('invalid_hd_control');
    return control;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { paused: false }; throw error; }
}
export async function setHdControl(paused: boolean, reason?: string) {
  await atomicHdJson(path.join(hdDirectory(), 'control.json'), { paused, reason, updatedAt: now() });
}
export async function retryFailedHd() {
  for (const job of await listHdJobs()) if (job.status === 'failed') await withLease(job.key, async () => {
    const fresh = await readHdJob(job.key);
    if (fresh?.status === 'failed') await atomicHdJson(jobPath(job.key), { ...fresh, status: 'queued', attempts: 0, updatedAt: now() });
  });
}
export async function hdStatus() {
  const jobs = await listHdJobs();
  const counts = { queued: 0, running: 0, ready: 0, failed: 0, skipped: 0 };
  const reasons: Record<string, number> = {};
  for (const job of jobs) { counts[job.status]++; if (job.reason) reasons[job.reason] = (reasons[job.reason] || 0) + 1; }
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
  return { policy: HD_POLICY, counts, reasons, batches, newCounts, control: await hdControl(), capacity: await hdCapacity(), total: jobs.length };
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
export async function processHdJob(key: string) {
  return withLease(key, async () => {
    const job = await readHdJob(key);
    if (!job || !['queued', 'running'].includes(job.status) || (await hdControl()).paused) return;
    let temporary = '';
    try {
      if (job.attempts >= 3) { job.status = 'failed'; job.reason = 'retry_limit'; return; }
      job.status = 'running'; job.attempts++; job.updatedAt = now();
      await atomicHdJson(jobPath(key), job);
      const input = await hdSource(job.source);
      if (!input || input.version !== job.version) { job.status = 'skipped'; job.reason = 'source_changed'; return; }
      const meta = await sharp(input.file, { limitInputPixels: false, animated: true }).metadata();
      const reason = hdEligibility(meta);
      if (reason) { job.status = 'skipped'; job.reason = reason; return; }
      const reserve = input.size * 3 + meta.width! * meta.height! * 8;
      if (!(await hdCapacity(reserve)).safe) { job.status = 'queued'; job.attempts--; await setHdControl(true, 'capacity_guard'); return; }
      const format = meta.hasAlpha || job.preserveText ? 'webp' : 'avif';
      const filename = `${key}.${format}`;
      temporary = path.join(hdDirectory(), `${filename}.${randomUUID()}.tmp`);
      const image = sharp(input.file, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).rotate().timeout({ seconds: 120 });
      await (format === 'webp' ? image.webp({ lossless: true, effort: 6 }) : image.avif({ quality: 95, chromaSubsampling: '4:4:4', effort: 6, bitdepth: 8 })).toFile(temporary);
      await fs.chmod(temporary, 0o600);
      const output = await sharp(temporary, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).metadata();
      const rotated = [5, 6, 7, 8].includes(meta.orientation || 1);
      const width = rotated ? meta.height : meta.width, height = rotated ? meta.width : meta.height;
      if (output.width !== width || output.height !== height || Boolean(output.hasAlpha) !== Boolean(meta.hasAlpha)
        || (output.pages || 1) !== 1 || !['srgb', 'b-w'].includes(output.space || '')
        || (output.bitsPerSample || 8) > 8 || output.depth !== 'uchar'
        || output.format !== (format === 'avif' ? 'heif' : 'webp')) throw new Error('output_integrity');
      await sharp(temporary, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).stats();
      const outputStat = await fs.stat(temporary);
      if ((await hdSource(job.source))?.version !== job.version) { job.status = 'skipped'; job.reason = 'source_changed'; return; }
      if (!(await hdCapacity()).safe) { await setHdControl(true, 'capacity_guard'); job.status = 'queued'; return; }
      Object.assign(job, { width, height, bytes: outputStat.size, format, mime: `image/${format}` });
      if (format === 'avif' && outputStat.size >= input.size) {
        Object.assign(job, { status: 'ready', format: 'original', mime: `image/${meta.format === 'jpg' ? 'jpeg' : meta.format}`, bytes: input.size, reason: 'original_smaller', file: undefined });
      } else {
        await fs.rename(temporary, path.join(hdDirectory(), filename)); temporary = '';
        Object.assign(job, { status: 'ready', file: filename, reason: undefined });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = ['EIO', 'EBUSY', 'EAGAIN', 'ETIMEDOUT'].includes(code || '');
      job.status = transient && job.attempts < 3 ? 'queued' : 'failed';
      job.reason = (error as Error).message === 'output_integrity' ? 'output_integrity' : transient ? 'temporary_io' : 'decode_or_source_failed';
      if (job.reason === 'output_integrity') await setHdControl(true, 'output_integrity');
    } finally {
      if (temporary) await fs.unlink(temporary).catch(() => {});
      job.updatedAt = now(); await atomicHdJson(jobPath(key), job);
    }
  });
}
