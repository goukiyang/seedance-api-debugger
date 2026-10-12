import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Asset } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';
import { uploadDigest, uploadFileVersion, uploadIdentity, verifyExistingUpload, releaseVerifiedUpload, privateUploadDirectory, VerifiedUploadError } from './verified-upload';
import { siteUploadPathFromUrl } from './site-url';

export const UPLOAD_SIMILARITY_ALGORITHM = 'imagehash-phash8-colorhash3-exif-alpha-wb-v1';
type State = 'queued' | 'running' | 'ready' | 'failed' | 'unsupported' | 'expired';
type Fingerprint = { phash: string; blackPhash: string; colorhash: string; opaque: boolean; width: number; height: number };
type Job = { version: 1; ownerId: string; assetId: string; hash: string; sourceVersion: string; algorithmVersion: string;
  state: State; attempts: number; createdAt: string; updatedAt: string; lease?: string; leaseUntil?: number; fingerprint?: Fingerprint; error?: string };
export type UploadSimilarityStatus = { state: State | 'disabled' | 'unavailable'; coverage: 'new_uploads_only'; algorithmVersion?: string };
const prefix = 'upload_similarity_v1:';
const ownerPrefix = (owner: string) => `${prefix}${uploadDigest(owner)}:`;
const keyFor = (owner: string, assetId: string) => `${ownerPrefix(owner)}${assetId}`;
const pairKey = (owner: string, left: Job, right: Job) => `upload_similarity_pair_v1:${uploadDigest(owner)}:${uploadDigest(JSON.stringify([
  [left.assetId, left.sourceVersion], [right.assetId, right.sourceVersion]].sort((a, b) => a[0].localeCompare(b[0]))))}:${UPLOAD_SIMILARITY_ALGORITHM}`;
function parseJob(value: string): Job {
  const job = JSON.parse(value) as Job;
  if (job.version !== 1 || typeof job.ownerId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(job.assetId)
    || !/^[a-f0-9]{64}$/.test(job.hash) || typeof job.sourceVersion !== 'string' || !job.sourceVersion
    || job.algorithmVersion !== UPLOAD_SIMILARITY_ALGORITHM || !['queued', 'running', 'ready', 'failed', 'unsupported', 'expired'].includes(job.state)
    || !Number.isInteger(job.attempts) || job.attempts < 0 || job.attempts > 3) throw new Error('similarity_record_invalid');
  return job;
}
async function authorizedAsset(ownerId: string, id: string) {
  const user = await uploadIdentity(ownerId);
  const asset = await prisma.asset.findUnique({ where: { id } });
  if (!asset || asset.owner_id !== ownerId || asset.status !== 'active' || asset.type !== 'image' || !await canReadStudioAsset(user, asset)) {
    throw new VerifiedUploadError('SIMILARITY_ASSET_UNAVAILABLE', '图片已不可用或无权查看', 404);
  }
  return asset;
}
export async function uploadSimilarityPolicy() {
  const row = await prisma.platformSetting.findUnique({ where: { key: 'upload_similarity_settings_v1' } });
  if (!row) return { enabled: false, phashLimit: 0, colorLimit: 0 };
  try {
    const value = JSON.parse(row.value_json);
    const enabled = value.enabled === true && value.algorithmVersion === UPLOAD_SIMILARITY_ALGORITHM
      && value.calibration?.status === 'accepted' && /^[a-f0-9]{64}$/.test(value.calibration?.evidenceSha || '')
      && Number.isInteger(value.phashLimit) && value.phashLimit >= 0 && value.phashLimit <= 12
      && Number.isInteger(value.colorLimit) && value.colorLimit >= 0 && value.colorLimit <= 12;
    return { enabled, phashLimit: enabled ? value.phashLimit as number : 0, colorLimit: enabled ? value.colorLimit as number : 0 };
  } catch { return { enabled: false, phashLimit: 0, colorLimit: 0 }; }
}
export async function enqueueUploadSimilarity(asset: Asset) {
  if (asset.type !== 'image' || !asset.hash || asset.status !== 'active') return;
  // Only the verified registration path may add new-upload records; no helper
  // invocation can silently turn historical Assets into a backfill.
  const integrity = asset.metadata_json ? JSON.parse(asset.metadata_json).uploadIntegrity : null;
  if (integrity?.version !== 'verified-upload-v2' || integrity.hash !== asset.hash) return;
  await privateUploadDirectory(); // Fail closed for new runtime/index writes without the real data mount.
  const owned = await authorizedAsset(asset.owner_id, asset.id);
  const local = siteUploadPathFromUrl(owned.original_url);
  const root = await fs.realpath(path.join(process.cwd(), 'public/uploads'));
  const file = local ? await fs.realpath(path.join(process.cwd(), 'public', local.replace(/^\/+/, ''))).catch(() => null) : null;
  if (!file || !file.startsWith(`${root}${path.sep}`)) return;
    const stamp = new Date().toISOString();
    const job: Job = { version: 1, ownerId: asset.owner_id, assetId: asset.id, hash: asset.hash,
      sourceVersion: await uploadFileVersion(file), algorithmVersion: UPLOAD_SIMILARITY_ALGORITHM,
      state: owned.mime_type === 'image/bmp' ? 'unsupported' : 'queued', attempts: 0, createdAt: stamp, updatedAt: stamp,
      ...(owned.mime_type === 'image/bmp' ? { error: 'bmp_fingerprint_unsupported' } : {}) };
    // Called only for a newly committed upload. Repeated receipt reads do not re-index.
    await prisma.platformSetting.create({ data: { key: keyFor(asset.owner_id, asset.id), value_json: JSON.stringify(job), updated_by: asset.owner_id } })
      .catch(error => { if ((error as { code?: string }).code !== 'P2002') throw error; });
}
export async function uploadSimilarityStatus(ownerId: string, assetId: string): Promise<UploadSimilarityStatus> {
  await authorizedAsset(ownerId, assetId);
  if (!(await uploadSimilarityPolicy()).enabled) return { state: 'disabled', coverage: 'new_uploads_only', algorithmVersion: UPLOAD_SIMILARITY_ALGORITHM };
  const row = await prisma.platformSetting.findUnique({ where: { key: keyFor(ownerId, assetId) } });
  return { state: row ? parseJob(row.value_json).state : 'unavailable', coverage: 'new_uploads_only', algorithmVersion: UPLOAD_SIMILARITY_ALGORITHM };
}
async function readyJob(ownerId: string, assetId: string) {
  const asset = await authorizedAsset(ownerId, assetId);
  const row = await prisma.platformSetting.findUnique({ where: { key: keyFor(ownerId, assetId) } });
  if (!row) return { asset, job: null };
  const job = parseJob(row.value_json);
  if (job.ownerId !== ownerId || job.assetId !== asset.id || job.hash !== asset.hash) throw new VerifiedUploadError('SIMILARITY_VERSION_CHANGED', '图片来源已变化，请重新查看');
  // Only new uploads with immutable local originals enter this index. Fingerprint
  // computation already fully verified bytes; read-only candidates check the
  // same real file/stat version instead of decoding hundreds of originals.
  const local = siteUploadPathFromUrl(asset.original_url);
  const root = await fs.realpath(path.join(process.cwd(), 'public/uploads'));
  const file = local ? await fs.realpath(path.join(process.cwd(), 'public', local.replace(/^\/+/, ''))).catch(() => null) : null;
  if (!file || !file.startsWith(`${root}${path.sep}`) || await uploadFileVersion(file) !== job.sourceVersion) throw new VerifiedUploadError('SIMILARITY_VERSION_CHANGED', '图片来源已变化，旧相似结果不再使用');
  return { asset, job };
}
function distance(left: string, right: string) {
  if (left.length !== right.length || !/^[a-f0-9]+$/.test(left) || !/^[a-f0-9]+$/.test(right)) throw new Error('similarity_fingerprint_invalid');
  let count = 0;
  for (let i = 0; i < left.length; i++) { let value = parseInt(left[i], 16) ^ parseInt(right[i], 16); while (value) { count += value & 1; value >>= 1; } }
  return count;
}
export async function uploadSimilarityCandidates(ownerId: string, assetId: string, cursor?: string) {
  const owned = await authorizedAsset(ownerId, assetId), policy = await uploadSimilarityPolicy();
  const empty = { state: 'disabled' as string, coverage: 'new_uploads_only' as const, algorithmVersion: UPLOAD_SIMILARITY_ALGORITHM,
    sourceVersion: null as string | null, candidates: [] as Array<{ assetId: string; sourceVersion: string; width: number | null; height: number | null; mimeType: string; fileSize: number; fileName: string; phashDistance: number; colorDistance: number }>, limited: false, nextCursor: null as string | null };
  if (!policy.enabled) return empty;
  const source = await readyJob(ownerId, owned.id);
  if (!source.job?.fingerprint || source.job.state !== 'ready') return { ...empty, state: source.job?.state || 'unavailable', sourceVersion: source.job?.sourceVersion || null };
  const scope = ownerPrefix(ownerId);
  if (cursor && !/^[a-zA-Z0-9_-]{1,160}$/.test(cursor)) throw new VerifiedUploadError('SIMILARITY_CURSOR_INVALID', '分页位置无效', 400);
  const rows = await prisma.platformSetting.findMany({ where: { key: { gte: scope, lt: `${scope}\uffff`, ...(cursor ? { gt: `${scope}${cursor}` } : {}) } }, orderBy: { key: 'asc' }, take: 201 });
  const candidates: typeof empty.candidates = [];
  let lastKey: string | null = null, visited = 0;
  for (const row of rows.slice(0, 200)) {
    lastKey = row.key; visited++;
    let other: Job;
    try { other = parseJob(row.value_json); } catch { continue; }
    if (other.ownerId !== ownerId || other.assetId === assetId || other.state !== 'ready' || !other.fingerprint) continue;
    // Check current authority before comparing, not just before displaying a name.
    const current = await readyJob(ownerId, other.assetId).catch(() => null);
    if (!current?.job?.fingerprint || current.job.state !== 'ready') continue;
    if (source.job.fingerprint.opaque !== current.job.fingerprint.opaque) continue;
    const phashDistance = Math.max(distance(source.job.fingerprint.phash, current.job.fingerprint.phash), distance(source.job.fingerprint.blackPhash, current.job.fingerprint.blackPhash));
    const colorDistance = distance(source.job.fingerprint.colorhash, current.job.fingerprint.colorhash);
    if (phashDistance > policy.phashLimit || colorDistance > policy.colorLimit) continue;
    if (await prisma.platformSetting.findUnique({ where: { key: pairKey(ownerId, source.job, current.job) } })) continue;
    const fresh = await readyJob(ownerId, current.asset.id).catch(() => null);
    if (!fresh?.job || fresh.job.sourceVersion !== current.job.sourceVersion) continue;
    candidates.push({ assetId: fresh.asset.id, sourceVersion: fresh.job.sourceVersion, width: fresh.asset.width, height: fresh.asset.height,
      mimeType: fresh.asset.mime_type, fileSize: fresh.asset.file_size, fileName: fresh.asset.file_name, phashDistance, colorDistance });
    if (candidates.length >= 10) break;
  }
  const finalSource = await readyJob(ownerId, assetId);
  if (finalSource.job?.sourceVersion !== source.job.sourceVersion) throw new VerifiedUploadError('SIMILARITY_VERSION_CHANGED', '当前图片已变化');
  const limited = rows.length > visited;
  return { ...empty, state: 'ready', sourceVersion: source.job.sourceVersion, candidates, limited, nextCursor: limited && lastKey ? lastKey.slice(scope.length) : null };
}
export async function keepUploadSimilarityPair(ownerId: string, input: { assetId: string; candidateAssetId: string; sourceVersion: string; candidateSourceVersion: string; algorithmVersion: string }) {
  const policy = await uploadSimilarityPolicy();
  if (!policy.enabled) throw new VerifiedUploadError('SIMILARITY_DISABLED', '相似提示尚未启用，未保存配对决定');
  if (input.algorithmVersion !== UPLOAD_SIMILARITY_ALGORITHM || input.assetId === input.candidateAssetId) throw new VerifiedUploadError('SIMILARITY_PAIR_INVALID', '相似图片配对无效', 400);
  const left = await readyJob(ownerId, input.assetId), right = await readyJob(ownerId, input.candidateAssetId);
  if (!left.job?.fingerprint || !right.job?.fingerprint || left.job.state !== 'ready' || right.job.state !== 'ready'
    || left.job.sourceVersion !== input.sourceVersion || right.job.sourceVersion !== input.candidateSourceVersion) throw new VerifiedUploadError('SIMILARITY_VERSION_CHANGED', '图片版本已变化，未保存决定');
  if (left.job.fingerprint.opaque !== right.job.fingerprint.opaque
    || Math.max(distance(left.job.fingerprint.phash, right.job.fingerprint.phash), distance(left.job.fingerprint.blackPhash, right.job.fingerprint.blackPhash)) > policy.phashLimit
    || distance(left.job.fingerprint.colorhash, right.job.fingerprint.colorhash) > policy.colorLimit) throw new VerifiedUploadError('SIMILARITY_PAIR_INVALID', '当前图片不在受权候选范围内', 409);
  const key = pairKey(ownerId, left.job, right.job);
  await prisma.$transaction(async db => {
    const user = await db.user.findUnique({ where: { id: ownerId } });
    if (!user || user.status !== 'active') throw new VerifiedUploadError('SIMILARITY_ASSET_UNAVAILABLE', '当前账号不可使用', 403);
    for (const asset of [left.asset, right.asset]) {
      const fresh = await db.asset.findUnique({ where: { id: asset.id } });
      if (!fresh || fresh.owner_id !== ownerId || fresh.status !== 'active' || fresh.original_url !== asset.original_url || !await canReadStudioAsset(user, fresh, db)) throw new VerifiedUploadError('SIMILARITY_ASSET_UNAVAILABLE', '图片权限已变化，未保存决定', 403);
    }
    for (const job of [left.job!, right.job!]) {
      const current = await db.platformSetting.findUnique({ where: { key: keyFor(ownerId, job.assetId) } });
      if (!current || current.value_json !== JSON.stringify(job)) throw new VerifiedUploadError('SIMILARITY_VERSION_CHANGED', '指纹版本已变化，未保存决定');
    }
    await db.platformSetting.upsert({ where: { key }, create: { key, value_json: JSON.stringify({ decision: 'keep_both', source: [left.job, right.job].map(job => ({ assetId: job!.assetId, sourceVersion: job!.sourceVersion })), algorithmVersion: UPLOAD_SIMILARITY_ALGORITHM }), updated_by: ownerId }, update: {} });
  });
  return { kept: true, saved: true, success: true, action: 'keep_both' as const };
}
async function computeFingerprint(file: string): Promise<Fingerprint> {
  const python = process.env.UPLOAD_SIMILARITY_PYTHON || '/data/video-api-debugger/upload-similarity/runtime/bin/python';
  const runtime = await fs.realpath(path.dirname(python));
  if (!runtime.startsWith('/data/video-api-debugger/upload-similarity/')) throw new Error('similarity_runtime_unavailable');
  const lockDirectory = await privateUploadDirectory();
  const lock = path.join(lockDirectory, 'similarity-compute.lock');
  const handle = await fs.open(lock, 'a', 0o600); await handle.close();
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/flock', ['--no-fork', '-n', lock, '/usr/bin/nice', '-n', '10', python, path.join(process.cwd(), 'scripts/upload-similarity.py'), file], {
      env: { NODE_ENV: process.env.NODE_ENV === 'development' ? 'development' : process.env.NODE_ENV === 'test' ? 'test' : 'production',
        PATH: '/usr/bin:/bin', OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const timer = setTimeout(() => child.kill('SIGTERM'), 65000);
    child.stdout.on('data', bytes => { output += String(bytes); if (output.length > 8192) child.kill('SIGTERM'); });
    child.stderr.resume(); child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || output.length > 8192) return reject(new Error('similarity_compute_failed'));
      try {
        const value = JSON.parse(output) as Fingerprint & { unsupported?: boolean; algorithmVersion?: string };
        if (value.unsupported === true) return reject(new Error('similarity_unsupported'));
        if (value.algorithmVersion !== UPLOAD_SIMILARITY_ALGORITHM || !/^[a-f0-9]{16}$/.test(value.phash) || !/^[a-f0-9]{16}$/.test(value.blackPhash) || !/^[a-f0-9]{11}$/.test(value.colorhash)
          || typeof value.opaque !== 'boolean' || !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width <= 0 || value.height <= 0 || value.width * value.height > 40_000_000) throw new Error('invalid');
        resolve(value);
      } catch { reject(new Error('similarity_result_invalid')); }
    });
  });
}
export async function processOneUploadSimilarity() {
  await privateUploadDirectory();
  const mutexKey = 'upload_similarity_worker_v1', token = randomUUID();
  await prisma.platformSetting.create({ data: { key: mutexKey, value_json: JSON.stringify({ leaseUntil: 0 }) } }).catch(error => { if ((error as { code?: string }).code !== 'P2002') throw error; });
  const mutex = (await prisma.platformSetting.findUnique({ where: { key: mutexKey } }))!;
  const state = JSON.parse(mutex.value_json);
  if (typeof state.leaseUntil !== 'number' || state.leaseUntil > Date.now()) return false;
  let held = JSON.stringify({ token, leaseUntil: Date.now() + 600000 });
  if (!(await prisma.platformSetting.updateMany({ where: { key: mutexKey, value_json: mutex.value_json }, data: { value_json: held } })).count) return false;
  let lost = false;
  let renewal: Promise<void> = Promise.resolve();
  const heartbeat = setInterval(() => {
    renewal = renewal.then(async () => {
      if (lost) return;
      const previous = held, next = JSON.stringify({ token, leaseUntil: Date.now() + 600000 });
      const result = await prisma.platformSetting.updateMany({ where: { key: mutexKey, value_json: previous }, data: { value_json: next } });
      if (!result.count) lost = true; else held = next;
    }).catch(() => { lost = true; });
  }, 30000);
  try {
    const rows = await prisma.platformSetting.findMany({ where: { key: { gte: prefix, lt: `${prefix}\uffff` }, OR: [{ value_json: { contains: '"state":"queued"' } }, { value_json: { contains: '"state":"running"' } }] }, orderBy: { key: 'asc' }, take: 40 });
    for (const row of rows) {
      let job: Job; try { job = parseJob(row.value_json); } catch { continue; }
      if (job.state === 'running' && (job.leaseUntil || 0) > Date.now()) continue;
      if (job.attempts >= 3) {
        await prisma.platformSetting.updateMany({ where: { key: row.key, value_json: row.value_json }, data: { value_json: JSON.stringify({ ...job, state: 'failed', lease: undefined, leaseUntil: undefined, error: 'attempt_limit' }) } });
        continue;
      }
      const working = { ...job, state: 'running' as const, attempts: job.attempts + 1, lease: token, leaseUntil: Date.now() + 600000, updatedAt: new Date().toISOString() };
      const claimed = JSON.stringify(working);
      if (!(await prisma.platformSetting.updateMany({ where: { key: row.key, value_json: row.value_json }, data: { value_json: claimed } })).count) continue;
      let proof: Awaited<ReturnType<typeof verifyExistingUpload>> = null;
      let finished: Job;
      try {
        const asset = await authorizedAsset(job.ownerId, job.assetId);
        proof = await verifyExistingUpload(asset, job.ownerId);
        if (!proof || proof.hash !== job.hash || (proof.sourceVersion || proof.version) !== job.sourceVersion) throw new Error('similarity_source_changed');
        const fingerprint = await computeFingerprint(proof.file);
        const fresh = await authorizedAsset(job.ownerId, job.assetId), after = await verifyExistingUpload(fresh, job.ownerId);
        try { if (!after || after.hash !== job.hash || (after.sourceVersion || after.version) !== job.sourceVersion || lost) throw new Error('similarity_source_changed'); }
        finally { await releaseVerifiedUpload(after); }
        finished = { ...working, state: 'ready', fingerprint, lease: undefined, leaseUntil: undefined, updatedAt: new Date().toISOString() };
      } catch (error) {
        const reason = error instanceof Error && error.message === 'similarity_source_changed' ? 'source_changed'
          : error instanceof Error && error.message === 'similarity_unsupported' ? 'unsupported' : 'compute_unavailable';
        finished = { ...working, state: reason === 'source_changed' ? 'expired' : reason === 'unsupported' ? 'unsupported' : working.attempts < 3 ? 'queued' : 'failed', error: reason, lease: undefined, leaseUntil: undefined, updatedAt: new Date().toISOString() };
      } finally { await releaseVerifiedUpload(proof!); }
      await renewal;
      if (lost || working.leaseUntil <= Date.now()) throw new Error('similarity_worker_lease_lost');
      await prisma.$transaction(async db => {
        const current = await db.platformSetting.findUnique({ where: { key: mutexKey } });
        const lease = current ? JSON.parse(current.value_json) : null;
        if (lease?.token !== token || lease.leaseUntil <= Date.now()) throw new Error('similarity_worker_lease_lost');
        await db.platformSetting.updateMany({ where: { key: row.key, value_json: claimed }, data: { value_json: JSON.stringify(finished) } });
      });
      return true;
    }
    return false;
  } finally { clearInterval(heartbeat); await renewal; await prisma.platformSetting.updateMany({ where: { key: mutexKey, value_json: held }, data: { value_json: JSON.stringify({ leaseUntil: 0 }) } }); }
}
