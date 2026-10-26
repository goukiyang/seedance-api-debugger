import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';
import { assertMultiviewWorkSource, multiviewWorkActor, readMultiviewWorkFile } from './multiview-works';
import { parseMultiviewWorkManifest } from './multiview-work-contract';

const PREFIX = 'multiview_output_registration_v1:';
const ACTIVATION = PREFIX + 'activation';
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const unavailable = () => new Error('作品成品仍保留，可复用素材暂未登记，后台会继续核对原保存记录。');
const receiptKey = (workId: string, revision: number) => `${PREFIX}receipt:${workId}:${revision}`;
type Prepared = { role: string; sha256: string; bytes: number; width: number; height: number; mime: 'image/png';
  originalUrl: string; thumbnailUrl: string; thumbnailSha256: string; thumbnailBytes: number };

async function activation() {
  const row = await prisma.platformSetting.findUnique({ where: { key: ACTIVATION }, select: { value_json: true } });
  if (!row) return null;
  let value: unknown;
  try { value = JSON.parse(row.value_json); } catch { throw unavailable(); }
  if (!record(value) || value.schema !== 1 || typeof value.activatedAt !== 'string' || !Number.isFinite(Date.parse(value.activatedAt))) throw unavailable();
  return new Date(value.activatedAt);
}

async function uploadsRoot() {
  const root = await fs.realpath(path.join(process.cwd(), 'public/uploads'));
  const entry = await fs.lstat(root);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw unavailable();
  if (process.env.NODE_ENV === 'production') {
    const [data, system] = await Promise.all([fs.lstat('/data'), fs.stat('/')]);
    if (!data.isDirectory() || data.isSymbolicLink() || data.dev === system.dev || entry.dev !== data.dev
      || root !== '/data/video-api-debugger/var-lib/uploads') throw unavailable();
  }
  const disk = await fs.statfs(root);
  if (disk.bavail * disk.bsize < 5 * 1024 ** 3) throw unavailable();
  return root;
}

async function privateDirectory(root: string, ownerId: string) {
  const components = ['multiview-outputs', sha(ownerId).slice(0, 40)];
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || await fs.realpath(current) !== current) throw unavailable();
  }
  return { directory: current, url: `/uploads/${components.join('/')}` };
}

async function readLocal(root: string, raw: string, expectedHash?: string, expectedBytes?: number) {
  const local = siteUploadPathFromUrl(raw);
  if (!local) throw unavailable();
  const file = path.resolve(root, local.slice('/uploads/'.length));
  if (!file.startsWith(root + path.sep) || await fs.realpath(file) !== file) throw unavailable();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 8 || before.size > 256 * 1024 ** 2
      || expectedBytes !== undefined && before.size !== expectedBytes) throw unavailable();
    const bytes = await handle.readFile(), after = await handle.stat();
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || expectedHash && sha(bytes) !== expectedHash) throw unavailable();
    return bytes;
  } finally { await handle.close(); }
}

/** Publish exact validated output bytes without an HTTP request or public-upload grant. */
async function publish(root: string, ownerId: string, bytes: Buffer, extension: 'png' | 'webp') {
  const target = await privateDirectory(root, ownerId), hash = sha(bytes);
  const name = `${hash}.${extension}`, destination = path.join(target.directory, name), url = `${target.url}/${name}`;
  const existing = await fs.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) { await readLocal(root, url, hash, bytes.length); return url; }
  const temporary = path.join(target.directory, `.prepare-${randomUUID()}`);
  const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes); await handle.sync();
  } finally { await handle.close(); }
  try {
    await fs.link(temporary, destination).catch(error => { if (error.code !== 'EEXIST') throw error; });
  } finally { await fs.unlink(temporary).catch(() => undefined); }
  await readLocal(root, url, hash, bytes.length);
  return url;
}

async function explicitSave(workId: string, ownerId: string, revision: number, since: Date, db: Pick<Prisma.TransactionClient, 'multiviewWorkMutation'> = prisma) {
  const mutations = await db.multiviewWorkMutation.findMany({ where: { work_id: workId, actor_id: ownerId,
    action: { in: ['create', 'save', 'branch'] }, created_at: { gte: since } }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }] });
  for (const mutation of mutations) {
    let value: unknown;
    try { value = JSON.parse(mutation.receipt_json); } catch { throw unavailable(); }
    if (!record(value) || value.state !== 'committed' || value.workId !== workId || value.mutationId !== mutation.mutation_id
      || value.action !== mutation.action || !Number.isSafeInteger(value.draftRevision)) throw unavailable();
    if (value.draftRevision === revision) return mutation;
  }
  return null;
}

export async function registerSavedMultiviewOutputs(workId: string): Promise<boolean> {
  const since = await activation();
  if (!since) return false;
  const work = await prisma.multiviewWork.findUnique({ where: { id: workId } });
  if (!work || work.removed_at || work.ready_revision === null || !work.ready_recipe_json || !work.ready_manifest_json) return false;
  const key = receiptKey(work.id, work.ready_revision);
  if (await prisma.platformSetting.findUnique({ where: { key }, select: { id: true } })) return false;
  const accepted = await explicitSave(work.id, work.owner_id, work.ready_revision, since);
  if (!accepted) return false; // An automatic waiting_source intent is not an explicit save.
  const user = await multiviewWorkActor(work.owner_id);
  await assertMultiviewWorkSource(user, work.source_task_id);
  const manifest = parseMultiviewWorkManifest(work.ready_manifest_json, JSON.parse(work.ready_recipe_json), work.ready_revision, sha(work.ready_recipe_json));
  if (!manifest) throw unavailable();
  const root = await uploadsRoot(), prepared: Prepared[] = [];
  for (const entry of manifest.files.filter(file => file.role === 'collage' || file.role.startsWith('frame-'))) {
    if (entry.mime !== 'image/png' || !entry.width || !entry.height) throw unavailable();
    const file = await readMultiviewWorkFile(user, work.id, entry.role, work.ready_revision);
    let bytes: Buffer;
    try { bytes = await file.handle.readFile(); } finally { await file.handle.close(); }
    if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) throw unavailable();
    const thumbnail = await sharp(bytes, { animated: false, limitInputPixels: 64_000_000 }).timeout({ seconds: 45 })
      .resize(640, 640, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    const originalUrl = await publish(root, user.id, bytes, 'png');
    const thumbnailUrl = await publish(root, user.id, thumbnail, 'webp');
    prepared.push({ role: entry.role, sha256: entry.sha256, bytes: entry.bytes, width: entry.width, height: entry.height,
      mime: 'image/png', originalUrl, thumbnailUrl, thumbnailSha256: sha(thumbnail), thumbnailBytes: thumbnail.length });
  }
  if (prepared.length !== manifest.frameCount + 1) throw unavailable();
  const existing = await prisma.asset.findMany({ where: { owner_id: user.id, hash: { in: prepared.map(item => item.sha256) } } });
  const byHash = new Map(existing.flatMap(asset => asset.hash ? [[asset.hash, asset] as const] : []));
  const checked = new Map<string, Prepared>();
  for (const item of prepared) {
    const asset = byHash.get(item.sha256);
    if (asset?.status !== undefined && asset.status !== 'active') continue;
    if (!asset) { checked.set(item.role, item); continue; }
    if (asset.type !== 'image' || asset.mime_type !== 'image/png' || asset.file_size !== item.bytes
      || asset.width !== item.width || asset.height !== item.height || !await canReadStudioAsset(user, asset)) throw unavailable();
    await readLocal(root, asset.original_url, item.sha256, item.bytes);
    const thumbnailUrl = asset.thumbnail_url || item.thumbnailUrl;
    const thumbnail = await readLocal(root, thumbnailUrl);
    const thumbnailInfo = await sharp(thumbnail, { animated: false, limitInputPixels: 40_000_000 }).metadata();
    if (!['png', 'jpeg', 'webp'].includes(thumbnailInfo.format || '')) throw unavailable();
    checked.set(item.role, { ...item, originalUrl: asset.original_url, thumbnailUrl,
      thumbnailSha256: sha(thumbnail), thumbnailBytes: thumbnail.length });
  }
  return prisma.$transaction(async db => {
    const prior = await db.platformSetting.findUnique({ where: { key }, select: { id: true } });
    if (prior) return false;
    const fresh = await db.multiviewWork.findUnique({ where: { id: work.id } });
    if (!fresh || fresh.removed_at || fresh.owner_id !== user.id || fresh.ready_revision !== work.ready_revision
      || fresh.ready_manifest_json !== work.ready_manifest_json || fresh.ready_recipe_json !== work.ready_recipe_json) return false;
    await assertMultiviewWorkSource(user, work.source_task_id, db);
    const mutation = await explicitSave(work.id, user.id, work.ready_revision!, since, db);
    if (!mutation || mutation.id !== accepted.id || mutation.request_hash !== accepted.request_hash) throw unavailable();
    const outputs = [];
    for (const item of prepared) {
      const current = await db.asset.findUnique({ where: { owner_id_hash: { owner_id: user.id, hash: item.sha256 } } });
      if (current && current.status !== 'active') {
        outputs.push({ state: 'unavailable', role: item.role, assetId: current.id, sha256: item.sha256 });
        continue; // Never resurrect an explicitly removed or hidden asset.
      }
      const bound = checked.get(item.role);
      if (!bound || current?.id !== byHash.get(item.sha256)?.id || current && (current.original_url !== bound.originalUrl
        || current.file_size !== item.bytes || current.mime_type !== 'image/png' || current.width !== item.width || current.height !== item.height
        || current.thumbnail_url !== null && current.thumbnail_url !== bound.thumbnailUrl)) throw unavailable();
      let meta: Record<string, unknown> = {};
      if (current?.metadata_json) {
        const parsed: unknown = JSON.parse(current.metadata_json);
        if (!record(parsed)) throw unavailable();
        meta = parsed;
      }
      const asset = current ? await db.asset.update({ where: { id: current.id }, data: {
        metadata_json: JSON.stringify({ ...meta, multiviewOutput: { schema: 1 } }),
        ...(current.thumbnail_url ? {} : { thumbnail_url: bound.thumbnailUrl }),
      } }) : await db.asset.create({ data: { id: randomUUID(), owner_id: user.id, type: 'image', status: 'active',
        original_url: bound.originalUrl, thumbnail_url: bound.thumbnailUrl, file_name: `3D多视图-${item.role}.png`,
        mime_type: 'image/png', file_size: item.bytes, width: item.width, height: item.height, hash: item.sha256,
        metadata_json: JSON.stringify({ source: 'multiview-output', multiviewOutput: { schema: 1 } }) } });
      outputs.push({ state: 'registered', ...bound, assetId: asset.id });
    }
    await db.platformSetting.create({ data: { key, updated_by: user.id, value_json: JSON.stringify({ schema: 1,
      state: 'registered', ownerId: user.id, workId: work.id, readyRevision: work.ready_revision,
      mutationId: mutation.mutation_id, mutationRowId: mutation.id, mutationRequestHash: mutation.request_hash, outputs }) } });
    await db.multiviewWork.updateMany({ where: { id: work.id, status: 'ready', ready_revision: work.ready_revision,
      last_error: '成品已经就绪，可复制和下载；素材入口暂未同步，后台会核对这次原保存记录后继续同步。' }, data: { last_error: null } });
    return true;
  });
}

/** Single consumer, exact durable receipt join; no bulk history backfill. */
export async function registerNextSavedMultiviewOutputs(admit: () => Promise<unknown>): Promise<string | null> {
  const since = await activation();
  if (!since) return null;
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT w.id FROM MultiviewWork w
    LEFT JOIN PlatformSetting p ON p.key = ${PREFIX + 'receipt:'} || w.id || ':' || w.ready_revision
    WHERE w.status = 'ready' AND w.removed_at IS NULL AND w.ready_revision IS NOT NULL
      AND w.next_attempt_at <= ${new Date()} AND p.id IS NULL
      AND EXISTS (SELECT 1 FROM MultiviewWorkMutation m WHERE m.work_id = w.id AND m.actor_id = w.owner_id
        AND m.action IN ('create','save','branch') AND m.created_at >= ${since}
        AND CASE WHEN json_valid(m.receipt_json) THEN json_extract(m.receipt_json, '$.state') = 'committed'
          AND json_extract(m.receipt_json, '$.draftRevision') = w.ready_revision ELSE 0 END)
    ORDER BY w.updated_at ASC, w.id ASC LIMIT 1`);
  const row = rows[0];
  if (!row) return null;
  try { await admit(); await registerSavedMultiviewOutputs(row.id); }
  catch {
    await prisma.multiviewWork.updateMany({ where: { id: row.id, status: 'ready' }, data: {
      next_attempt_at: new Date(Date.now() + 60_000),
      last_error: '成品已经就绪，可复制和下载；素材入口暂未同步，后台会核对这次原保存记录后继续同步。',
    } });
    // Keep the ready artifact and original save receipt. A restart resumes only
    // this local output-registration step, never a generation or a second save.
  }
  return row.id;
}
