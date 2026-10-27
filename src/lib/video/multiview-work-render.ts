import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import sharp from '../media/sharp';
import { AuthError } from '@/lib/auth/session';
import { multiviewDimensions } from './multiview-contract';
import { MultiviewError, multiviewInfoForWork, multiviewSourceVersion, renderMultiviewWork } from './multiview';
import { isMultiviewWorkId, parseMultiviewWorkManifest, type MultiviewWorkManifest, type MultiviewWorkFileRole } from './multiview-work-contract';
import { assertMultiviewWorkSource, assertMultiviewWorkReference, claimNextMultiviewWork, completeMultiviewWork, failMultiviewWork,
  initializeMultiviewWork, multiviewWorkActor, multiviewWorkDirectory, type MultiviewWorkLease } from './multiview-works';
import { registerNextSavedMultiviewOutputs } from './multiview-output-assets.server';

const GiB = 1024 ** 3;
export const MULTIVIEW_WORK_RESOURCE_POLICY = Object.freeze({
  totalBytes: 64 * GiB, minimumFreeBytes: 5 * GiB, maximumRevisionBytes: 1.5 * GiB,
  minimumAvailableMemory: 2 * GiB, renderTimeoutMs: 8 * 60 * 1000, inventoryEntries: 100000,
});
const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const unavailable = (message: string) => new MultiviewError(message, 503);
class MultiviewResourceWait extends MultiviewError {
  constructor(message: string) { super(message, 503); }
}
function resourceFailure(error: unknown): never {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['ENOENT', 'ENODEV', 'ESTALE', 'EBUSY', 'ENOSPC', 'EDQUOT', 'EIO'].includes(code)) {
    throw new MultiviewResourceWait('服务器资源暂不可用，作品会在恢复后继续准备；配方与已有成果保留。');
  }
  throw error;
}
let active = false;

function rootDirectory() {
  return process.env.NODE_ENV === 'production' ? '/data/video-api-debugger/var-lib/storage/multiview-works'
    : path.join(process.cwd(), '.cache', 'multiview-works');
}
/** Create each component only after rejecting links; never traverse a supplied symlink. */
async function secureDirectory(directory: string) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let entry = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!entry) {
      await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      entry = await lstat(current);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw unavailable('作品目录暂不可用，原配方与已保存成果保持不变。');
  }
  if (await realpath(absolute) !== absolute) throw unavailable('作品目录核对未完成，已暂停准备。');
}
async function storageRoot() {
  if (process.env.NODE_ENV === 'production') {
    const [data, system] = await Promise.all([lstat('/data'), stat('/')]).catch(resourceFailure);
    if (!data.isDirectory() || data.isSymbolicLink() || data.dev === system.dev || await realpath('/data').catch(resourceFailure) !== '/data') {
      if (data.isDirectory() && !data.isSymbolicLink() && data.dev === system.dev) {
        throw new MultiviewResourceWait('数据盘暂不可用，作品会在恢复后继续准备；原配方与成果保留。');
      }
      throw unavailable('数据盘路径核对未完成，作品目录未写入；原配方与成果保留。');
    }
  }
  const root = rootDirectory();
  await secureDirectory(root).catch(resourceFailure);
  await chmod(root, 0o700).catch(resourceFailure);
  return root;
}
async function usedBytes(root: string) {
  let entries = 0, bytes = 0;
  const directories = [root];
  while (directories.length) {
    const directory = directories.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > MULTIVIEW_WORK_RESOURCE_POLICY.inventoryEntries) throw new MultiviewResourceWait('作品存储目录需要整理，已暂停新的拼图准备；已有成果保留。');
      const file = path.join(directory, entry.name);
      const metadata = await lstat(file);
      if (metadata.isSymbolicLink()) throw unavailable('作品存储目录核对未完成，已暂停新的准备。');
      if (metadata.isDirectory()) directories.push(file);
      else if (metadata.isFile()) bytes += metadata.size;
      else throw unavailable('作品存储目录含未知文件类型，已暂停新的准备。');
      if (bytes > MULTIVIEW_WORK_RESOURCE_POLICY.totalBytes) return bytes;
    }
  }
  return bytes;
}
async function availableMemory() {
  if (process.platform !== 'linux') return os.freemem();
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(await readFile('/proc/meminfo', 'utf8').catch(resourceFailure));
  if (!match) throw new MultiviewResourceWait('暂时无法核对服务器余量，作品稍后继续准备。');
  return Number(match[1]) * 1024;
}
async function assertCapacity(root: string, reservation: number) {
  if (!Number.isSafeInteger(reservation) || reservation < 1 || reservation > MULTIVIEW_WORK_RESOURCE_POLICY.maximumRevisionBytes) {
    throw new MultiviewResourceWait('本次拼图文件超出准备上限，原配方与已保存成果保留。');
  }
  const [disk, used] = await Promise.all([statfs(root), usedBytes(root)]).catch(resourceFailure);
  const free = disk.bavail * disk.bsize;
  if (free - reservation < MULTIVIEW_WORK_RESOURCE_POLICY.minimumFreeBytes || used + reservation > MULTIVIEW_WORK_RESOURCE_POLICY.totalBytes) {
    throw new MultiviewResourceWait('作品空间暂不足，配方已保留；空间恢复后可继续准备，已有成果不受影响。');
  }
}
/** Called only for a claimed intent; resource waits release that lease without spending a retry. */
export async function multiviewWorkAdmission() {
  if (os.loadavg()[0] > Math.max(2, os.cpus().length * 1.25) || await availableMemory() < MULTIVIEW_WORK_RESOURCE_POLICY.minimumAvailableMemory) {
    throw new MultiviewResourceWait('服务器正在处理其他任务，作品稍后继续准备。');
  }
  const root = await storageRoot();
  await assertCapacity(root, MULTIVIEW_WORK_RESOURCE_POLICY.maximumRevisionBytes);
  return root;
}
export async function multiviewWorkLockPath() {
  const root = await storageRoot();
  return path.join(path.dirname(root), 'multiview-works.lock');
}
export async function assertMultiviewWorkConsumerLock(lockPath?: string) {
  if (process.platform !== 'linux') throw unavailable('作品后台处理需要 Linux 的系统文件锁，当前运行环境不支持。');
  const file = lockPath || await multiviewWorkLockPath();
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw unavailable('作品后台处理缺少有效的独占锁。');
  const lock = await stat(file, { bigint: true });
  const major = ((lock.dev >> BigInt(8)) & BigInt(0xfff)) | ((lock.dev >> BigInt(32)) & BigInt(0xfffff000));
  const minor = (lock.dev & BigInt(0xff)) | ((lock.dev >> BigInt(12)) & BigInt(0xffffff00));
  const held = (await readFile('/proc/locks', 'utf8')).split('\n').some(line => {
    const match = /^\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([a-f0-9]+):([a-f0-9]+):(\d+)\s/i.exec(line);
    return Boolean(match && Number(match[1]) === process.pid && BigInt(`0x${match[2]}`) === major
      && BigInt(`0x${match[3]}`) === minor && BigInt(match[4]) === lock.ino);
  });
  if (!held) throw unavailable('作品后台处理未持有自己的跨版本独占锁。');
}
async function writePrivate(file: string, data: Buffer | string) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(data); await handle.sync(); }
  finally { await handle.close(); }
}
async function readPrivate(file: string, maximumBytes: number) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.mode & 0o077 || metadata.size < 1 || metadata.size > maximumBytes) throw unavailable('作品文件校验未完成，未标记为已保存。');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (current.dev !== metadata.dev || current.ino !== metadata.ino || current.size !== metadata.size) throw unavailable('作品文件正在变化，请稍后重试。');
    const data = await handle.readFile();
    if (data.length !== current.size) throw unavailable('作品文件尚未完整写入。');
    return data;
  } finally { await handle.close(); }
}
async function imageMetadata(data: Buffer, mime: 'image/png' | 'image/jpeg', width?: number, height?: number, decode = true) {
  const magic = mime === 'image/png' ? data.subarray(0, 8).equals(pngMagic) : data[0] === 255 && data[1] === 216 && data[data.length - 2] === 255 && data[data.length - 1] === 217;
  if (!magic) throw unavailable('作品图片格式校验未完成，未标记为已保存。');
  const image = sharp(data, { limitInputPixels: 64000000, failOn: 'warning' }).timeout({ seconds: 60 });
  const metadata = await image.metadata();
  if (metadata.format !== (mime === 'image/png' ? 'png' : 'jpeg') || !metadata.width || !metadata.height
    || width !== undefined && metadata.width !== width || height !== undefined && metadata.height !== height) throw unavailable('作品图片尺寸校验未完成。');
  if (decode) await image.stats(); // A readable header alone does not prove a complete image.
  return { width: metadata.width, height: metadata.height };
}
const crcTable = Array.from({ length: 256 }, (_, initial) => {
  let value = initial;
  for (let i = 0; i < 8; i++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(data: Buffer) {
  let value = 0xffffffff;
  for (let index = 0; index < data.length; index++) value = crcTable[(value ^ data[index]) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
/** Validate the bounded archive, including each stored PNG and the original frame mapping. */
function validateZip(data: Buffer, frames: Array<{ bytes: number; sha256: string }>, lease: MultiviewWorkLease) {
  const recipe = lease.recipe!, info = lease.info!;
  const end = data.length - 22;
  if (end < 0 || data.readUInt32LE(end) !== 0x06054b50 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6)
    || data.readUInt16LE(end + 8) !== frames.length + 1 || data.readUInt16LE(end + 10) !== frames.length + 1
    || data.readUInt16LE(end + 20)) throw unavailable('单图包尚未完整写入。');
  const centralStart = data.readUInt32LE(end + 16), centralSize = data.readUInt32LE(end + 12);
  if (centralStart + centralSize !== end) throw unavailable('单图包目录校验未完成。');
  let offset = centralStart;
  const seen = new Set<string>();
  for (let index = 0; index <= frames.length; index++) {
    if (offset + 46 > end || data.readUInt32LE(offset) !== 0x02014b50) throw unavailable('单图包目录不完整。');
    const method = data.readUInt16LE(offset + 10), compressed = data.readUInt32LE(offset + 20), bytes = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28), extraLength = data.readUInt16LE(offset + 30), commentLength = data.readUInt16LE(offset + 32);
    const local = data.readUInt32LE(offset + 42), next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end || local + 30 > centralStart || data.readUInt32LE(local) !== 0x04034b50 || ![0, 8].includes(method)
      || data.readUInt16LE(offset + 8) & 1) throw unavailable('单图包格式校验未完成。');
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (seen.has(name)) throw unavailable('单图包出现重复文件。');
    seen.add(name);
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    if (start + compressed > centralStart || data.readUInt16LE(local + 8) !== method
      || data.subarray(local + 30, local + 30 + data.readUInt16LE(local + 26)).toString('utf8') !== name) throw unavailable('单图包文件长度不完整。');
    const packed = data.subarray(start, start + compressed);
    const imageIndex = /^view-0[1-8]\.png$/.test(name) ? Number(name.slice(5, 7)) - 1 : -1;
    if (imageIndex >= frames.length || imageIndex < 0 && name !== 'frames.json' || name === 'frames.json' && bytes > 20000) throw unavailable('单图包文件清单不匹配。');
    const content = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: name === 'frames.json' ? 20000 : frames[imageIndex].bytes });
    if (content.length !== bytes || crc32(content) !== data.readUInt32LE(offset + 16)) throw unavailable('单图包内容校验未完成。');
    if (imageIndex >= 0) {
      if (content.length !== frames[imageIndex].bytes || hash(content) !== frames[imageIndex].sha256) throw unavailable('单图包与已保存单帧不一致。');
    } else {
      const mapping = JSON.parse(content.toString('utf8'));
      if (mapping.taskId !== lease.sourceTaskId || mapping.sourceVersion !== lease.sourceVersion || mapping.width !== info.width
        || mapping.height !== info.height || !Array.isArray(mapping.frames) || mapping.frames.length !== frames.length
        || mapping.frames.some((frame: { file: string; frame: number; time: number; name: string }, i: number) => frame.file !== `view-${String(i + 1).padStart(2, '0')}.png`
          || frame.frame !== recipe.slots[i].frame || frame.time !== info.timestamps[recipe.slots[i].frame] || frame.name !== recipe.slots[i].name)) {
        throw unavailable('单图包选帧信息不一致。');
      }
    }
    offset = next;
  }
  if (offset !== end || seen.size !== frames.length + 1 || !seen.has('frames.json')) throw unavailable('单图包缺少文件。');
}
async function validateDirectory(directory: string, lease: MultiviewWorkLease, signal: AbortSignal) {
  await secureDirectory(directory);
  const raw = await readPrivate(path.join(directory, 'manifest.json'), 30000);
  const manifest = parseMultiviewWorkManifest(JSON.parse(raw.toString('utf8')), lease.recipe!, lease.draftRevision, lease.recipeHash!);
  if (!manifest) throw unavailable('作品成品清单不完整，未标记为已保存。');
  const expectedDimensions = multiviewDimensions(lease.info!, lease.recipe!.slots.length, lease.recipe!.layout);
  if (manifest.width !== expectedDimensions.width || manifest.height !== expectedDimensions.height) throw unavailable('作品拼图尺寸与配方不一致。');
  const names = (await readdir(directory)).sort();
  if (JSON.stringify(names) !== JSON.stringify(['manifest.json', ...manifest.files.map(file => file.file)].sort())
    || new Set(manifest.files.map(file => file.file)).size !== manifest.files.length) throw unavailable('作品文件清单不一致。');
  const frames: Array<{ bytes: number; sha256: string }> = [];
  let zip: Buffer | null = null, bytes = raw.length;
  for (const entry of manifest.files) {
    signal.throwIfAborted();
    const data = await readPrivate(path.join(directory, entry.file), MULTIVIEW_WORK_RESOURCE_POLICY.maximumRevisionBytes);
    bytes += data.length;
    if (data.length !== entry.bytes || hash(data) !== entry.sha256) throw unavailable('作品文件长度或内容校验未完成。');
    if (entry.role === 'zip') zip = data;
    else {
      const fullSize = entry.role !== 'thumbnail' ? entry.role === 'collage' ? expectedDimensions : lease.info! : undefined;
      const size = await imageMetadata(data, entry.mime as 'image/png' | 'image/jpeg', fullSize?.width, fullSize?.height);
      if (size.width !== entry.width || size.height !== entry.height || entry.role === 'thumbnail' && (size.width > 960 || size.height > 960)) throw unavailable('作品图片尺寸与清单不一致。');
      if (entry.role.startsWith('frame-')) frames[lease.recipe!.slots.findIndex(slot => `frame-${slot.id}` === entry.role)] = { bytes: entry.bytes, sha256: entry.sha256 };
    }
  }
  if (bytes > MULTIVIEW_WORK_RESOURCE_POLICY.maximumRevisionBytes || !zip || frames.length !== lease.recipe!.slots.length || frames.some(frame => !frame)) throw unavailable('作品文件不完整或超出准备上限。');
  validateZip(zip, frames, lease);
  signal.throwIfAborted();
  return manifest;
}
async function publish(lease: MultiviewWorkLease, signal: AbortSignal) {
  const user = await multiviewWorkActor(lease.ownerId);
  await assertMultiviewWorkReference(user, { owner_id: lease.ownerId, source_task_id: lease.sourceTaskId, source_id: lease.sourceId || null });
  const access = lease.sourceId ? { kind: 'work' as const, id: lease.workId } : undefined;
  if (await multiviewSourceVersion(user, lease.sourceTaskId, access) !== lease.sourceVersion) throw new MultiviewError('原视频已变化，原配方和已保存成果保留。', 409);
  const root = await storageRoot();
  const destination = await multiviewWorkDirectory(lease.ownerId, lease.workId, lease.draftRevision);
  if (!destination.startsWith(`${root}${path.sep}`) || !isMultiviewWorkId(lease.ownerId) || !isMultiviewWorkId(lease.workId)) throw unavailable('作品文件位置校验未完成。');
  const existing = await lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) return validateDirectory(destination, lease, signal); // An interrupted CAS may have already published this immutable revision.
  const dimensions = multiviewDimensions(lease.info!, lease.recipe!.slots.length, lease.recipe!.layout);
  const estimate = Math.ceil((dimensions.width * dimensions.height + lease.info!.width * lease.info!.height * lease.recipe!.slots.length * 2) * 4 + 1024 * 1024);
  await assertCapacity(root, estimate);
  let rendered: Awaited<ReturnType<typeof renderMultiviewWork>> | null = await renderMultiviewWork(user, lease.sourceTaskId, lease.recipe!, signal, access);
  const thumbnail = await sharp(rendered.collage, { limitInputPixels: 64000000 }).resize({ width: 960, height: 960, fit: 'inside', withoutEnlargement: true }).timeout({ seconds: 60 }).jpeg({ quality: 82 }).toBuffer();
  signal.throwIfAborted();
  const parent = path.dirname(destination);
  await secureDirectory(parent);
  await chmod(path.dirname(parent), 0o700); await chmod(parent, 0o700);
  const temporary = path.join(parent, `.pending-${lease.draftRevision}-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  let published = false;
  try {
    const images: Array<{ role: MultiviewWorkFileRole; file: string; mime: 'image/png' | 'image/jpeg'; data: Buffer }> = [{ role: 'thumbnail', file: 'thumbnail.jpg', mime: 'image/jpeg', data: thumbnail },
      { role: 'collage', file: 'collage.png', mime: 'image/png', data: rendered.collage },
      ...rendered.frames.map(frame => ({ role: `frame-${frame.slotId}` as const, file: `frame-${frame.slotId}.png`, mime: 'image/png' as const, data: frame.data }))];
    const manifest: MultiviewWorkManifest = { schema: 1, sourceVersion: lease.sourceVersion!, revision: lease.draftRevision,
      recipeHash: lease.recipeHash!, ...dimensions, frameCount: lease.recipe!.slots.length, files: [] };
    const total = images.reduce((sum, item) => sum + item.data.length, rendered.zip.length);
    await assertCapacity(root, total + 30000);
    for (const image of images) {
      signal.throwIfAborted();
      const size = await imageMetadata(image.data, image.mime, undefined, undefined, false);
      await writePrivate(path.join(temporary, image.file), image.data);
      manifest.files.push({ role: image.role, file: image.file, mime: image.mime, bytes: image.data.length, sha256: hash(image.data), ...size });
    }
    await writePrivate(path.join(temporary, 'frames.zip'), rendered.zip);
    manifest.files.push({ role: 'zip', file: 'frames.zip', mime: 'application/zip', bytes: rendered.zip.length, sha256: hash(rendered.zip) });
    await writePrivate(path.join(temporary, 'manifest.json'), JSON.stringify(manifest));
    // Release the encoder buffers before rereading the immutable files for full decode/integrity checks.
    images.length = 0; rendered = null;
    await validateDirectory(temporary, lease, signal);
    await assertMultiviewWorkReference(await multiviewWorkActor(lease.ownerId), { owner_id: lease.ownerId, source_task_id: lease.sourceTaskId, source_id: lease.sourceId || null });
    if (await multiviewSourceVersion(user, lease.sourceTaskId, access) !== lease.sourceVersion) throw new MultiviewError('原视频已变化，旧选帧未套用新视频。', 409);
    signal.throwIfAborted();
    const temporaryHandle = await open(temporary, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await temporaryHandle.sync(); } finally { await temporaryHandle.close(); }
    // The consumer's global flock and the database lease serialize publishers. Never replace an existing revision.
    if (await lstat(destination).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; })) throw unavailable('该修订已有文件，未覆盖现有成果。');
    await rename(temporary, destination); published = true;
    const directoryHandle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    return manifest;
  } finally {
    // Only this invocation's unpublished temporary directory is removed; immutable revisions and history are retained.
    if (!published) await rm(temporary, { recursive: true, force: true });
  }
}
export type MultiviewWorkProcessResult = { state: 'empty' | 'ready' | 'superseded' | 'waiting' | 'failed'; workId?: string };
/** One claim only. The dedicated consumer holds the cross-release flock for its entire lifetime. */
export async function processNextMultiviewWork(): Promise<MultiviewWorkProcessResult> {
  if (active) throw unavailable('已有作品正在准备。');
  active = true;
  let lease: MultiviewWorkLease | null = null;
  const signal = AbortSignal.timeout(MULTIVIEW_WORK_RESOURCE_POLICY.renderTimeoutMs);
  try {
    await assertMultiviewWorkConsumerLock();
    const { cleanAbandonedMultiviewSources } = await import('./multiview-source-cleanup.server');
    await cleanAbandonedMultiviewSources().catch(() => { console.warn('multiview_source_cleanup_deferred'); });
    const registeredWork = await registerNextSavedMultiviewOutputs(multiviewWorkAdmission);
    if (registeredWork) return { state: 'ready', workId: registeredWork };
    lease = await claimNextMultiviewWork();
    if (!lease) return { state: 'empty' };
    await multiviewWorkAdmission();
    const user = await multiviewWorkActor(lease.ownerId);
    await assertMultiviewWorkReference(user, { owner_id: lease.ownerId, source_task_id: lease.sourceTaskId, source_id: lease.sourceId || null });
    const source = lease.sourceId ? null : await assertMultiviewWorkSource(user, lease.sourceTaskId);
    const access = lease.sourceId ? { kind: 'work' as const, id: lease.workId } : undefined;
    if (source && ['failed', 'cancelled', 'canceled'].includes(source.local_status)) {
      await failMultiviewWork(lease, '原视频未完成，本作品未生成成品；原任务历史保留。', { retryable: false });
      return { state: 'failed', workId: lease.workId };
    }
    if (source && source.local_status !== 'succeeded') {
      await failMultiviewWork(lease, '等待原视频完成和归档；不会重新生成或扣费。', { waitingSource: true });
      return { state: 'waiting', workId: lease.workId };
    }
    if (lease.sourceVersion && await multiviewSourceVersion(user, lease.sourceTaskId, access) !== lease.sourceVersion) {
      await failMultiviewWork(lease, '原视频已变化，原配方和已保存成果保留。', { sourceChanged: true, retryable: false });
      return { state: 'failed', workId: lease.workId };
    }
    if (!lease.recipe || !lease.info || !lease.sourceVersion) {
      const info = await multiviewInfoForWork(user, lease.sourceTaskId, undefined, signal, access);
      lease = await initializeMultiviewWork(lease, info);
      if (!lease) return { state: 'superseded' };
    }
    const manifest = await publish(lease, signal);
    signal.throwIfAborted();
    const committed = await completeMultiviewWork(lease, manifest);
    return { state: committed ? 'ready' : 'superseded', workId: lease.workId };
  } catch (error) {
    if (!lease) throw error;
    const authorization = error instanceof AuthError;
    const changed = error instanceof MultiviewError && error.status === 409 && /已变化|已改变|版本已改变/.test(error.message);
    const waiting = error instanceof MultiviewError && error.status === 409 && !changed;
    const resourceWait = error instanceof MultiviewResourceWait;
    const message = authorization ? '账号或来源权限已变化，作品暂不可读取；原配方与已保存文件保留。'
      : changed || error instanceof MultiviewError ? (error as Error).message : '作品暂未准备完成，原配方与上次成果保留；稍后可重试本地文件处理。';
    await failMultiviewWork(lease, message, { waitingSource: waiting, resourceWait, sourceChanged: changed, retryable: !authorization && !changed });
    return { state: waiting || resourceWait ? 'waiting' : 'failed', workId: lease.workId };
  } finally { active = false; }
}
