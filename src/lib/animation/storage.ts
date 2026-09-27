import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, realpath, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { prisma } from '@/lib/prisma';
import type { AnimationFileInfo, AnimationFileRole } from './types';
import { AnimationError } from './http';

const execFileAsync = promisify(execFile);
export const ANIMATION_MAX_UPLOAD_BYTES = 128 * 1024 * 1024;
export const ANIMATION_MAX_DOCUMENT_BYTES = 1024 * 1024 * 1024;
export const ANIMATION_MAX_DOCUMENT_FILES = 256;
export const ANIMATION_STORAGE_RESERVE_BYTES = BigInt(64) * BigInt(1024) * BigInt(1024);
export const ANIMATION_MAX_ARCHIVE_EXPANDED_BYTES = 512 * 1024 * 1024;
export const ANIMATION_IMPORT_RESERVED_BYTES = BigInt(6) * BigInt(1024) * BigInt(1024) * BigInt(1024);
export const ANIMATION_CANDIDATE_RESERVED_BYTES = BigInt(ANIMATION_MAX_UPLOAD_BYTES) * BigInt(2) + BigInt(64) * BigInt(1024) * BigInt(1024);
export const ANIMATION_JOB_RESERVED_BYTES = BigInt(10) * BigInt(1024) * BigInt(1024) * BigInt(1024);

export type StoredFileMetadata = AnimationFileInfo & { blob_key: string };
export type StreamedUpload = { path: string; bytes: number; sha256: string };

export function hasAnimationStorageCapacity(
  availableBytes: bigint,
  reservedJobBytes: bigint,
  reservedUploadBytes: bigint,
  requestedBytes: bigint,
  safetyReserveBytes: bigint = ANIMATION_STORAGE_RESERVE_BYTES,
) {
  return availableBytes >= safetyReserveBytes + reservedJobBytes + reservedUploadBytes + requestedBytes;
}

function isWithin(root: string, candidate: string) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function createOrResolveStorageRoot(requestedRoot: string, publicRoot: string) {
  const missing: string[] = [];
  let existing = requestedRoot;
  while (true) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw new AnimationError('动画存储目录配置无效', 503, 'STORAGE_UNAVAILABLE');
      missing.push(path.basename(existing));
      existing = parent;
    }
  }

  let current = await realpath(existing);
  if (!(await stat(current)).isDirectory()) throw new AnimationError('动画存储目录配置无效', 503, 'STORAGE_UNAVAILABLE');
  const parts = missing.reverse();
  const prospective = path.resolve(current, ...parts);
  if (isWithin(publicRoot, current) || isWithin(publicRoot, prospective)) {
    throw new AnimationError('动画存储目录必须位于网站公开目录之外', 503, 'STORAGE_UNAVAILABLE');
  }

  for (const part of parts) {
    const next = path.join(current, part);
    await mkdir(next, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const info = await lstat(next).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new AnimationError('动画存储目录含无效符号链接', 503, 'STORAGE_UNAVAILABLE');
    const resolved = await realpath(next);
    if (resolved !== next || isWithin(publicRoot, resolved)) throw new AnimationError('动画存储目录含无效符号链接', 503, 'STORAGE_UNAVAILABLE');
    current = resolved;
  }
  return current;
}

async function ensurePrivateChildDirectory(parent: string, name: string) {
  const directory = path.join(parent, name);
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new AnimationError('动画私有目录无效', 503, 'STORAGE_UNAVAILABLE');
  const resolved = await realpath(directory);
  if (resolved !== directory || !isWithin(parent, resolved) || resolved === parent) {
    throw new AnimationError('动画私有目录含无效符号链接', 503, 'STORAGE_UNAVAILABLE');
  }
  return resolved;
}

export async function getAnimationStorageRoot() {
  const configured = process.env.ANIMATION_STORAGE_ROOT || path.join(process.cwd(), 'storage', 'animation');
  if (!path.isAbsolute(configured)) throw new AnimationError('动画存储目录配置无效', 503, 'STORAGE_UNAVAILABLE');
  const requestedRoot = path.resolve(configured);
  const publicRoot = await realpath(path.join(process.cwd(), 'public')).catch(() => path.resolve(process.cwd(), 'public'));
  if (isWithin(publicRoot, requestedRoot)) throw new AnimationError('动画存储目录必须位于网站公开目录之外', 503, 'STORAGE_UNAVAILABLE');
  const root = await createOrResolveStorageRoot(requestedRoot, publicRoot);
  await chmod(root, 0o700).catch(() => undefined);
  return root;
}

export async function createAnimationTempDirectory() {
  const root = await getAnimationStorageRoot();
  const tempRootReal = await ensurePrivateChildDirectory(root, '.tmp');
  const directory = path.join(tempRootReal, randomUUID());
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

export async function removeAnimationTempDirectory(directory: string) {
  const root = await getAnimationStorageRoot();
  const tempRootPath = path.join(root, '.tmp');
  const tempRootInfo = await lstat(tempRootPath).catch(() => null);
  if (!tempRootInfo?.isDirectory() || tempRootInfo.isSymbolicLink()) return;
  const tempRoot = await realpath(tempRootPath).catch(() => null);
  if (!tempRoot || tempRoot !== tempRootPath || !isWithin(root, tempRoot) || tempRoot === root) return;
  if (!tempRoot || !path.isAbsolute(directory)) return;
  const target = path.resolve(directory);
  if (!isWithin(tempRoot, target) || target === tempRoot || path.dirname(target) !== tempRoot) return;
  const info = await lstat(target).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) return;
  const resolved = await realpath(target).catch(() => null);
  if (resolved !== target || !isWithin(tempRoot, resolved)) return;
  await rm(target, { recursive: true, force: true });
}

export async function preflightAnimationStorage(requiredBytes: bigint = BigInt(ANIMATION_MAX_UPLOAD_BYTES)) {
  const root = await getAnimationStorageRoot();
  const info = await statfs(root, { bigint: true });
  const available = info.bavail * info.bsize;
  if (available < requiredBytes + ANIMATION_STORAGE_RESERVE_BYTES) {
    throw new AnimationError('动画存储空间不足，请稍后重试', 507, 'INSUFFICIENT_STORAGE');
  }
}

export async function reserveAnimationUpload(reservedBytes: bigint, maxConcurrent = 2) {
  await preflightAnimationStorage(reservedBytes);
  const root = await getAnimationStorageRoot();
  const space = await statfs(root, { bigint: true });
  const available = space.bavail * space.bsize;
  const reservationId = randomUUID();
  const reserved = await prisma.$transaction(async (tx) => {
    await tx.animationQueueState.upsert({
      where: { id: 'global' },
      create: { id: 'global', active_count: 0, reserved_storage_bytes: BigInt(0) },
      update: { active_count: { increment: 0 } },
    });
    await tx.animationUploadState.upsert({
      where: { id: 'global' },
      create: { id: 'global', active_count: 0, reserved_storage_bytes: BigInt(0) },
      update: {},
    });
    const now = new Date();
    const expired = await tx.animationUploadReservation.findMany({ where: { expires_at: { lt: now } }, select: { id: true } });
    if (expired.length) await tx.animationUploadReservation.deleteMany({ where: { id: { in: expired.map((item) => item.id) } } });
    const active = await tx.animationUploadReservation.aggregate({ _count: { _all: true }, _sum: { reserved_bytes: true } });
    const uploadReservedBytes = active._sum.reserved_bytes ?? BigInt(0);
    await tx.animationUploadState.update({
      where: { id: 'global' },
      data: { active_count: active._count._all, reserved_storage_bytes: uploadReservedBytes },
    });
    const queue = await tx.animationQueueState.findUnique({ where: { id: 'global' }, select: { reserved_storage_bytes: true } });
    const jobReservedBytes = queue?.reserved_storage_bytes ?? BigInt(0);
    if (!hasAnimationStorageCapacity(available, jobReservedBytes, uploadReservedBytes, reservedBytes)) return false;
    const result = await tx.animationUploadState.updateMany({
      where: {
        id: 'global',
        active_count: { lt: maxConcurrent },
        reserved_storage_bytes: { lte: available - ANIMATION_STORAGE_RESERVE_BYTES - jobReservedBytes - reservedBytes },
      },
      data: { active_count: { increment: 1 }, reserved_storage_bytes: { increment: reservedBytes } },
    });
    if (result.count !== 1) return false;
    await tx.animationUploadReservation.create({
      data: { id: reservationId, reserved_bytes: reservedBytes, expires_at: new Date(now.getTime() + 15 * 60 * 1000) },
    });
    return true;
  });
  if (!reserved) throw new AnimationError('上传队列或空间预算已满，请稍后重试', 429, 'UPLOAD_CAPACITY_REACHED');
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await prisma.$transaction(async (tx) => {
      const removed = await tx.animationUploadReservation.deleteMany({ where: { id: reservationId } });
      if (removed.count !== 1) return;
      await tx.animationUploadState.updateMany({
        where: { id: 'global', active_count: { gt: 0 }, reserved_storage_bytes: { gte: reservedBytes } },
        data: { active_count: { decrement: 1 }, reserved_storage_bytes: { decrement: reservedBytes } },
      });
    });
  };
}

export async function streamRequestToFile(request: Request, filePath: string, maxBytes = ANIMATION_MAX_UPLOAD_BYTES): Promise<StreamedUpload> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new AnimationError('上传大小无效', 400, 'INVALID_CONTENT_LENGTH');
    if (parsed > maxBytes) throw new AnimationError('上传文件超过大小限制', 413, 'UPLOAD_TOO_LARGE');
  }
  if (!request.body) throw new AnimationError('上传内容为空', 400, 'EMPTY_UPLOAD');
  const output = await open(filePath, 'wx', 0o600);
  const reader = request.body.getReader();
  const hash = createHash('sha256');
  let bytes = 0;
  let completed = false;
  try {
    while (true) {
      if (request.signal.aborted) throw new AnimationError('上传已中断', 400, 'UPLOAD_ABORTED');
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AnimationError('上传文件超过大小限制', 413, 'UPLOAD_TOO_LARGE');
      }
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const result = await output.write(value, offset, value.byteLength - offset, null);
        offset += result.bytesWritten;
      }
    }
    if (!bytes) throw new AnimationError('上传内容为空', 400, 'EMPTY_UPLOAD');
    await output.sync();
    completed = true;
    return { path: filePath, bytes, sha256: hash.digest('hex') };
  } finally {
    reader.releaseLock();
    await output.close();
    if (!completed) await rm(filePath, { force: true }).catch(() => undefined);
  }
}

async function readPrefix(filePath: string, length: number) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

export function sanitizeAnimationFilename(value: string | null | undefined, fallback = 'animation-file') {
  if (typeof value !== 'string') {
    if (fallback) return fallback;
    throw new AnimationError('文件名无效', 400, 'INVALID_FILENAME');
  }
  const name = value.normalize('NFC').trim();
  if (!name || name.length > 200 || /[\\/\u0000-\u001f\u007f]/.test(name) || name === '.' || name === '..') {
    if (fallback && value == null) return fallback;
    throw new AnimationError('文件名无效', 400, 'INVALID_FILENAME');
  }
  return name;
}

export async function validateAnimationZip(filePath: string) {
  const prefix = await readPrefix(filePath, 4);
  if (prefix.length < 4 || prefix[0] !== 0x50 || prefix[1] !== 0x4b || ![0x03, 0x05, 0x07].includes(prefix[2]) || ![0x04, 0x06, 0x08].includes(prefix[3])) {
    throw new AnimationError('文件不是有效的 ZIP 动画包', 415, 'INVALID_ARCHIVE');
  }
}

export async function validateAnimationCandidate(filePath: string, role: 'video' | 'candidate', name: string) {
  if (role === 'candidate') {
    const metadata = await sharp(filePath, { limitInputPixels: 16_000_000, animated: false }).metadata();
    if (metadata.format !== 'png' || !metadata.width || !metadata.height || metadata.width * metadata.height > 16_000_000) {
      throw new AnimationError('候选图片必须是可读取的 PNG 文件', 415, 'INVALID_PNG');
    }
    await sharp(filePath, { limitInputPixels: 16_000_000, animated: false }).ensureAlpha().resize(1, 1).raw().toBuffer();
    return { mime: 'image/png', width: metadata.width, height: metadata.height };
  }

  if (path.extname(name).toLowerCase() !== '.mp4') throw new AnimationError('原片必须是 MP4 文件', 415, 'INVALID_MP4');
  const prefix = await readPrefix(filePath, 12);
  if (prefix.length < 12 || prefix.toString('ascii', 4, 8) !== 'ftyp') throw new AnimationError('原片不是有效的 MP4 文件', 415, 'INVALID_MP4');
  const binary = process.env.FFPROBE_PATH || 'ffprobe';
  let stdout: string;
  try {
    const result = await execFileAsync(binary, [
      '-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=codec_type,width,height,avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames:format=format_name,duration',
      '-of', 'json', filePath,
    ], { timeout: 20_000, maxBuffer: 32 * 1024 });
    stdout = String(result.stdout || '{}');
  } catch {
    throw new AnimationError('MP4 无法读取或服务端缺少 ffprobe', 415, 'INVALID_MP4');
  }
  let parsed: {
    streams?: Array<{ codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; nb_frames?: string; nb_read_frames?: string }>;
    format?: { format_name?: string; duration?: string };
  };
  try { parsed = JSON.parse(stdout); } catch { throw new AnimationError('MP4 无法读取', 415, 'INVALID_MP4'); }
  const stream = parsed.streams?.find((item) => item.codec_type === 'video');
  const formats = parsed.format?.format_name?.split(',') || [];
  const duration = Number(parsed.format?.duration);
  const parseRate = (rate: string | undefined) => {
    if (!rate) return 0;
    const [numerator, denominator = '1'] = rate.split('/');
    const value = Number(numerator) / Number(denominator);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  const countedFrames = Number(stream?.nb_read_frames || stream?.nb_frames);
  const estimatedFrames = Math.ceil(duration * Math.max(parseRate(stream?.avg_frame_rate), parseRate(stream?.r_frame_rate)));
  const totalFrames = Number.isFinite(countedFrames) && countedFrames > 0 ? countedFrames : estimatedFrames;
  if (!stream?.width || !stream.height || stream.width * stream.height > 16_000_000
    || !formats.includes('mp4') || !Number.isFinite(duration) || duration <= 0 || duration > 120
    || !Number.isFinite(totalFrames) || totalFrames <= 0 || totalFrames > 7_200) {
    throw new AnimationError('MP4 缺少有效视频流', 415, 'INVALID_MP4');
  }
  return { mime: 'video/mp4', width: stream.width, height: stream.height };
}

export async function inspectLocalAnimationFile(filePath: string, name: string, role: AnimationFileRole, dimensions?: { width: number | null; height: number | null }) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > ANIMATION_MAX_DOCUMENT_BYTES) {
    throw new AnimationError('动画文件无效', 422, 'INVALID_MEDIA_FILE');
  }
  const digest = createHash('sha256');
  const handle = await open(filePath, 'r');
  try {
    const chunk = Buffer.alloc(256 * 1024);
    let position = 0;
    while (position < info.size) {
      const result = await handle.read(chunk, 0, Math.min(chunk.length, info.size - position), position);
      if (!result.bytesRead) throw new AnimationError('动画文件读取不完整', 422, 'INVALID_MEDIA_FILE');
      digest.update(chunk.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return {
    id: randomUUID(),
    name: sanitizeAnimationFilename(name),
    role,
    mime: role === 'video' ? 'video/mp4' : 'image/png',
    bytes: info.size,
    sha256: digest.digest('hex'),
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
  } satisfies AnimationFileInfo;
}

export async function publishAnimationBlob(sourcePath: string, expectedSha256?: string) {
  const root = await getAnimationStorageRoot();
  const sourceInfo = await lstat(sourcePath);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new AnimationError('动画文件无效', 422, 'INVALID_MEDIA_FILE');
  const rootReal = await realpath(root);
  const stageReal = await ensurePrivateChildDirectory(rootReal, '.staging');
  const stageName = randomUUID();
  const stagePath = path.join(stageReal, stageName);
  const blobKey = randomUUID();
  const target = path.join(rootReal, blobKey);
  try {
    await copyFile(sourcePath, stagePath, constants.COPYFILE_EXCL);
    await chmod(stagePath, 0o600);
    const stagedInfo = await stat(stagePath);
    const copiedHash = await hashFile(stagePath);
    if (stagedInfo.size !== sourceInfo.size || (expectedSha256 && copiedHash !== expectedSha256)) {
      throw new AnimationError('动画文件校验失败', 422, 'FILE_HASH_MISMATCH');
    }
    await rename(stagePath, target);
    return { blob_key: blobKey, path: target, sha256: copiedHash, bytes: sourceInfo.size };
  } catch (error) {
    await rm(stagePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeAnimationBlob(blobKey: string) {
  try {
    const resolved = await resolveAnimationBlob(blobKey);
    await rm(resolved.path, { force: true });
  } catch {
    return;
  }
}

export async function resolveAnimationBlob(blobKey: string) {
  if (!/^[0-9a-f-]{36}$/.test(blobKey)) throw new AnimationError('文件不存在', 404, 'NOT_FOUND');
  const root = await getAnimationStorageRoot();
  const target = path.join(root, blobKey);
  const info = await lstat(target).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new AnimationError('文件不存在', 404, 'NOT_FOUND');
  const actualRoot = await realpath(root);
  const actualFile = await realpath(target).catch(() => null);
  if (!actualFile || !isWithin(actualRoot, actualFile) || actualFile === actualRoot) throw new AnimationError('文件不存在', 404, 'NOT_FOUND');
  return { path: actualFile, bytes: info.size };
}

export async function hashFile(filePath: string) {
  const digest = createHash('sha256');
  const handle = await open(filePath, 'r');
  try {
    const info = await handle.stat();
    const chunk = Buffer.alloc(256 * 1024);
    let position = 0;
    while (position < info.size) {
      const result = await handle.read(chunk, 0, Math.min(chunk.length, info.size - position), position);
      if (!result.bytesRead) throw new AnimationError('动画文件读取不完整', 422, 'INVALID_MEDIA_FILE');
      digest.update(chunk.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return digest.digest('hex');
}

export async function writeAnimationReconcileManifest(id: string, value: unknown) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new AnimationError('恢复记录无效', 500, 'RECONCILE_FAILED');
  const root = await getAnimationStorageRoot();
  const realDirectory = await ensurePrivateChildDirectory(root, '.reconcile');
  const temporary = path.join(realDirectory, `${id}.${randomUUID()}.tmp`);
  const destination = path.join(realDirectory, `${id}.json`);
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  await rename(temporary, destination);
  return destination;
}

export async function getAnimationReconcileDirectory() {
  return ensurePrivateChildDirectory(await getAnimationStorageRoot(), '.reconcile');
}

export async function assertAnimationSourceInDirectory(sourcePath: string, directory: string) {
  const sourceInfo = await lstat(sourcePath).catch(() => null);
  if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink()) throw new AnimationError('动画处理器返回的文件位置无效', 422, 'INVALID_MEDIA_FILE');
  const root = await realpath(directory);
  const source = await realpath(sourcePath).catch(() => null);
  const info = source ? await lstat(source).catch(() => null) : null;
  if (!source || !info?.isFile() || info.isSymbolicLink() || !isWithin(root, source) || source === root) {
    throw new AnimationError('动画处理器返回的文件位置无效', 422, 'INVALID_MEDIA_FILE');
  }
  return source;
}

export async function animationFileStat(filePath: string) {
  const resolved = await realpath(filePath);
  const info = await stat(resolved);
  if (!info.isFile()) throw new AnimationError('动画文件无效', 422, 'INVALID_MEDIA_FILE');
  return info;
}
