import fs from 'node:fs/promises';
import { constants as fsConstants, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Prisma, type Asset } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { siteUploadPathFromUrl } from './site-url';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';

export class VerifiedUploadError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
export type VerifiedUpload = { file: string; hash: string; bytes: number; mimeType: string; type: 'image' | 'video' | 'audio';
  width: number | null; height: number | null; version: string; extension: string; sourceVersion?: string; temporary?: boolean };
export type UploadReceipt = { requestId: string; verified: true; assetDisposition: 'new' | 'reused'; sourceVersion: string };
const limits = { image: 30 * 1024 * 1024, video: 200 * 1024 * 1024, audio: 15 * 1024 * 1024 };
const formats: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' };
const execFileAsync = promisify(execFile);
export const uploadDigest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function assertUploadOwner(expected: unknown, ownerId: string) {
  if (expected !== undefined && expected !== null && expected !== ownerId) throw new VerifiedUploadError('SESSION_CHANGED', '登录账号已变化，请重新打开上传入口', 409);
}
export function uploadRequestId(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new VerifiedUploadError('UPLOAD_REQUEST_INVALID', '上传编号无效', 400);
  return value;
}
export function verifiedUploadFailure(error: VerifiedUploadError) {
  return { error: error.message, code: error.code, message: error.message,
    ...(error.code === 'UPLOAD_NOT_ACCEPTED' ? { notAccepted: true } : {}) };
}
export async function releaseVerifiedUpload(proof: VerifiedUpload | null | undefined) {
  if (proof?.temporary) await fs.unlink(proof.file).catch(() => {});
}
export async function uploadIdentity(ownerId: string) {
  const user = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true, role: true, account_type: true, status: true,
    feature_profile_id: true, feishu_user_id: true, feishu_open_id: true, feishu_union_id: true, feishu_tenant_key: true } });
  if (!user || user.status !== 'active') throw new VerifiedUploadError('UPLOAD_OWNER_UNAVAILABLE', '当前账号不可上传', 403);
  return user;
}
const PRIVATE_UPLOAD_MINIMUM_FREE_BYTES = 2 * 1024 ** 3;
const PRIVATE_UPLOAD_PROJECT_ROOT = '/data/video-api-debugger';
const PRIVATE_UPLOAD_CANONICAL_DIRECTORY = '/data/video-api-debugger/var-lib/storage/verified-uploads';
const PRIVATE_UPLOAD_PYTHON = '/usr/bin/python3';
const PRIVATE_UPLOAD_PYTHON_REAL = '/usr/bin/python3.12';
const PRIVATE_UPLOAD_GROUP_PROBE_SCHEMA = 'video-api-debugger.upload-private-parent.v1';
const PRIVATE_UPLOAD_GROUP_PROBE_SOURCE = String.raw`import errno
import grp
import json
import os
import pwd

DIRECTORY = "/data/video-api-debugger/var-lib/storage"
NSSWITCH = "/etc/nsswitch.conf"

def nss_sources(database):
    with open(NSSWITCH, "r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.split("#", 1)[0].strip()
            if not line or ":" not in line:
                continue
            name, value = line.split(":", 1)
            if name.strip() == database:
                return value.split()
    raise RuntimeError("missing nss database")

def acl_absent(name):
    try:
        os.getxattr(DIRECTORY, name, follow_symlinks=False)
    except OSError as error:
        return error.errno == errno.ENODATA
    return False

runtime_uid = os.getuid()
runtime_gid = os.getgid()
primary_group_uids = sorted({entry.pw_uid for entry in pwd.getpwall() if entry.pw_gid == runtime_gid})
group = grp.getgrgid(runtime_gid)
explicit_member_uids = sorted({pwd.getpwnam(name).pw_uid for name in group.gr_mem})
print(json.dumps({
    "schema": "video-api-debugger.upload-private-parent.v1",
    "directory": DIRECTORY,
    "runtimeUid": runtime_uid,
    "runtimeGid": runtime_gid,
    "primaryGroupUids": primary_group_uids,
    "explicitMemberUids": explicit_member_uids,
    "passwdSources": nss_sources("passwd"),
    "groupSources": nss_sources("group"),
    "accessAclAbsent": acl_absent("system.posix_acl_access"),
    "defaultAclAbsent": acl_absent("system.posix_acl_default"),
}, separators=(",", ":"), sort_keys=True))`;
type PrivateUploadFilesystem = Pick<typeof fs, 'access' | 'lstat' | 'mkdir' | 'readlink' | 'realpath' | 'stat' | 'statfs'>;
export type PrivateUploadGroupProbeRequest = { directory: string; runtimeUid: number; runtimeGid: number };
export type PrivateUploadDirectoryRuntime = {
  filesystem: PrivateUploadFilesystem;
  platform: NodeJS.Platform;
  cwd: string;
  runtimeUid: number | undefined;
  runtimeGid: number | undefined;
  systemRoot: string;
  trustedProjectRoot: string;
  trustedCanonicalDirectory: string;
  probeTrustedGroupWritableParent: (request: PrivateUploadGroupProbeRequest) => Promise<string>;
};
function privateUploadDirectoryInvalid(): never {
  throw new VerifiedUploadError('UPLOAD_PRIVATE_DIRECTORY_INVALID', '上传服务暂不可用，请稍后核对或重试原上传', 503);
}
function sameFilesystemEntry(left: Awaited<ReturnType<typeof fs.lstat>>, right: Awaited<ReturnType<typeof fs.lstat>>) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid;
}
async function requiredPrivateUploadEntry(filesystem: PrivateUploadFilesystem, entry: string) {
  try { return await filesystem.lstat(entry); }
  catch (error) {
    if (['EACCES', 'ELOOP', 'ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) privateUploadDirectoryInvalid();
    throw error;
  }
}
async function requiredPrivateUploadStat(filesystem: PrivateUploadFilesystem, entry: string) {
  try { return await filesystem.stat(entry); }
  catch (error) {
    if (['EACCES', 'ELOOP', 'ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) privateUploadDirectoryInvalid();
    throw error;
  }
}
async function requiredPrivateUploadRealpath(filesystem: PrivateUploadFilesystem, entry: string) {
  try { return await filesystem.realpath(entry); }
  catch (error) {
    if (['EACCES', 'ELOOP', 'ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) privateUploadDirectoryInvalid();
    throw error;
  }
}
async function requiredPrivateUploadLink(filesystem: PrivateUploadFilesystem, entry: string) {
  try { return await filesystem.readlink(entry); }
  catch (error) {
    if (['EACCES', 'EINVAL', 'ELOOP', 'ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) privateUploadDirectoryInvalid();
    throw error;
  }
}
async function assertPrivateUploadCapacity(filesystem: PrivateUploadFilesystem, directory: string) {
  let capacity: Awaited<ReturnType<typeof fs.statfs>>;
  try { capacity = await filesystem.statfs(directory); }
  catch (error) {
    if (['EACCES', 'ELOOP', 'ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) privateUploadDirectoryInvalid();
    throw error;
  }
  if (capacity.bavail * capacity.bsize < PRIVATE_UPLOAD_MINIMUM_FREE_BYTES) {
    throw new VerifiedUploadError('UPLOAD_CAPACITY_GUARD', '上传空间不足，请稍后重试', 503);
  }
}
function trustedPrivateUploadParents(projectRoot: string, canonical: string) {
  if (canonical !== path.join(projectRoot, 'var-lib', 'storage', 'verified-uploads')) privateUploadDirectoryInvalid();
  return [path.dirname(projectRoot), projectRoot, path.join(projectRoot, 'var-lib'), path.join(projectRoot, 'var-lib', 'storage')];
}
type PrivateUploadGroupProbeResult = {
  schema: string;
  directory: string;
  runtimeUid: number;
  runtimeGid: number;
  primaryGroupUids: number[];
  explicitMemberUids: number[];
  passwdSources: string[];
  groupSources: string[];
  accessAclAbsent: boolean;
  defaultAclAbsent: boolean;
};
function exactStringArray(value: unknown, expected: string[]): value is string[] {
  return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]);
}
function exactIntegerArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(entry => Number.isSafeInteger(entry) && entry >= 0);
}
function parsePrivateUploadGroupProbe(output: string, request: PrivateUploadGroupProbeRequest) {
  let value: unknown;
  try { value = JSON.parse(output); } catch { privateUploadDirectoryInvalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) privateUploadDirectoryInvalid();
  const result = value as Partial<PrivateUploadGroupProbeResult>;
  const expectedKeys = ['accessAclAbsent', 'defaultAclAbsent', 'directory', 'explicitMemberUids', 'groupSources',
    'passwdSources', 'primaryGroupUids', 'runtimeGid', 'runtimeUid', 'schema'];
  if (!exactStringArray(Object.keys(result).sort(), expectedKeys)
    || result.schema !== PRIVATE_UPLOAD_GROUP_PROBE_SCHEMA || result.directory !== request.directory
    || result.runtimeUid !== request.runtimeUid || result.runtimeGid !== request.runtimeGid
    || !exactIntegerArray(result.primaryGroupUids) || result.primaryGroupUids.length !== 1
    || result.primaryGroupUids[0] !== request.runtimeUid
    || !exactIntegerArray(result.explicitMemberUids)
    || result.explicitMemberUids.some(uid => uid !== request.runtimeUid) || result.explicitMemberUids.length > 1
    || !exactStringArray(result.passwdSources, ['files', 'systemd'])
    || !exactStringArray(result.groupSources, ['files', 'systemd'])
    || result.accessAclAbsent !== true || result.defaultAclAbsent !== true) privateUploadDirectoryInvalid();
}
async function assertTrustedPrivateUploadParent(runtime: PrivateUploadDirectoryRuntime, directory: string,
  dataDevice: number | bigint) {
  const { filesystem, runtimeUid, runtimeGid } = runtime;
  if (runtimeUid === undefined) privateUploadDirectoryInvalid();
  const stat = await requiredPrivateUploadEntry(filesystem, directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== dataDevice || ![0, runtimeUid].includes(stat.uid)
    || (stat.mode & 0o002) !== 0 || await requiredPrivateUploadRealpath(filesystem, directory) !== directory) privateUploadDirectoryInvalid();
  if ((stat.mode & 0o020) === 0) return;
  const trustedWritableParent = path.dirname(runtime.trustedCanonicalDirectory);
  if (directory !== trustedWritableParent || (stat.mode & 0o7777) !== 0o775
    || runtimeGid === undefined || !Number.isSafeInteger(runtimeGid) || runtimeGid < 0
    || stat.uid !== runtimeUid || stat.gid !== runtimeGid) privateUploadDirectoryInvalid();
  const request = { directory, runtimeUid, runtimeGid };
  let output: string;
  try { output = await runtime.probeTrustedGroupWritableParent(request); }
  catch { privateUploadDirectoryInvalid(); }
  if (typeof output !== 'string') privateUploadDirectoryInvalid();
  parsePrivateUploadGroupProbe(output, request);
}
export async function resolvePrivateUploadDirectory(runtime: PrivateUploadDirectoryRuntime) {
  const { filesystem, platform } = runtime;
  const storage = await requiredPrivateUploadRealpath(filesystem, path.join(runtime.cwd, 'storage'));
  const storageStat = await requiredPrivateUploadStat(filesystem, storage);
  const systemStat = await filesystem.stat(runtime.systemRoot);
  if (platform === 'linux' && (!storage.startsWith(`${runtime.trustedProjectRoot}${path.sep}`)
    || !storageStat.isDirectory() || storageStat.dev === systemStat.dev)) {
    throw new VerifiedUploadError('UPLOAD_DATA_MOUNT_REQUIRED', '上传数据盘暂不可用', 503);
  }
  await assertPrivateUploadCapacity(filesystem, storage);
  const directory = path.join(storage, 'verified-uploads');
  if (platform !== 'linux') {
    await filesystem.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const entry = await requiredPrivateUploadEntry(filesystem, directory);
  if (!entry.isSymbolicLink()) {
    if (!entry.isDirectory() || (entry.mode & 0o077) !== 0 || await requiredPrivateUploadRealpath(filesystem, directory) !== directory) privateUploadDirectoryInvalid();
    return directory;
  }
  if (platform !== 'linux' || runtime.runtimeUid === undefined || !Number.isSafeInteger(runtime.runtimeUid)
    || runtime.runtimeUid < 0 || await requiredPrivateUploadLink(filesystem, directory) !== runtime.trustedCanonicalDirectory) privateUploadDirectoryInvalid();

  const canonical = runtime.trustedCanonicalDirectory;
  const canonicalStat = await requiredPrivateUploadEntry(filesystem, canonical);
  if (!storageStat.isDirectory() || ![0, runtime.runtimeUid].includes(storageStat.uid) || (storageStat.mode & 0o022) !== 0
    || !canonicalStat.isDirectory() || canonicalStat.isSymbolicLink() || (canonicalStat.mode & 0o7777) !== 0o700
    || canonicalStat.uid !== runtime.runtimeUid
    || await requiredPrivateUploadRealpath(filesystem, canonical) !== canonical
    || await requiredPrivateUploadRealpath(filesystem, directory) !== canonical) privateUploadDirectoryInvalid();
  if (canonicalStat.dev !== storageStat.dev) {
    throw new VerifiedUploadError('UPLOAD_DATA_MOUNT_REQUIRED', '上传数据盘暂不可用', 503);
  }
  for (const parent of trustedPrivateUploadParents(runtime.trustedProjectRoot, canonical)) {
    await assertTrustedPrivateUploadParent(runtime, parent, storageStat.dev);
  }
  try { await filesystem.access(canonical, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK); }
  catch { privateUploadDirectoryInvalid(); }
  await assertPrivateUploadCapacity(filesystem, canonical);

  const finalEntry = await requiredPrivateUploadEntry(filesystem, directory);
  const finalCanonical = await requiredPrivateUploadEntry(filesystem, canonical);
  if (!sameFilesystemEntry(entry, finalEntry) || !sameFilesystemEntry(canonicalStat, finalCanonical)
    || await requiredPrivateUploadLink(filesystem, directory) !== canonical || await requiredPrivateUploadRealpath(filesystem, directory) !== canonical
    || await requiredPrivateUploadRealpath(filesystem, canonical) !== canonical) privateUploadDirectoryInvalid();
  return canonical;
}
async function assertPrivateUploadProbeDirectory(directory: string, mode: number) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o7777) !== mode
    || await fs.realpath(directory) !== directory) privateUploadDirectoryInvalid();
}
async function assertPrivateUploadProbeFile(file: string, mode: number) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o7777) !== mode
    || await fs.realpath(file) !== file) privateUploadDirectoryInvalid();
}
async function trustedGroupWritablePrivateUploadProbe(request: PrivateUploadGroupProbeRequest) {
  const runtimeUid = process.getuid?.(), runtimeGid = process.getgid?.();
  if (request.directory !== path.dirname(PRIVATE_UPLOAD_CANONICAL_DIRECTORY)
    || request.runtimeUid !== runtimeUid || request.runtimeGid !== runtimeGid) privateUploadDirectoryInvalid();
  await assertPrivateUploadProbeDirectory('/usr', 0o755);
  await assertPrivateUploadProbeDirectory('/usr/bin', 0o755);
  await assertPrivateUploadProbeDirectory('/etc', 0o755);
  await assertPrivateUploadProbeFile('/etc/passwd', 0o644);
  await assertPrivateUploadProbeFile('/etc/group', 0o644);
  await assertPrivateUploadProbeFile('/etc/nsswitch.conf', 0o644);
  const interpreter = await fs.lstat(PRIVATE_UPLOAD_PYTHON);
  if (!interpreter.isSymbolicLink() || interpreter.uid !== 0
    || await fs.readlink(PRIVATE_UPLOAD_PYTHON) !== path.basename(PRIVATE_UPLOAD_PYTHON_REAL)) privateUploadDirectoryInvalid();
  const realInterpreter = await fs.realpath(PRIVATE_UPLOAD_PYTHON);
  if (realInterpreter !== PRIVATE_UPLOAD_PYTHON_REAL) privateUploadDirectoryInvalid();
  const realInterpreterStat = await fs.lstat(realInterpreter);
  if (!realInterpreterStat.isFile() || realInterpreterStat.isSymbolicLink() || realInterpreterStat.uid !== 0
    || (realInterpreterStat.mode & 0o7777) !== 0o755) privateUploadDirectoryInvalid();
  const { stdout, stderr } = await execFileAsync(PRIVATE_UPLOAD_PYTHON, ['-I', '-c', PRIVATE_UPLOAD_GROUP_PROBE_SOURCE], {
    timeout: 2000,
    maxBuffer: 4096,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', NODE_ENV: 'production' },
    windowsHide: true,
  });
  if (stderr !== '' || !stdout.endsWith('\n') || stdout.slice(0, -1).includes('\n')) privateUploadDirectoryInvalid();
  return stdout.slice(0, -1);
}
export async function privateUploadDirectory() {
  return resolvePrivateUploadDirectory({
    filesystem: fs,
    platform: process.platform,
    cwd: process.cwd(),
    runtimeUid: process.getuid?.(),
    runtimeGid: process.getgid?.(),
    systemRoot: '/',
    trustedProjectRoot: PRIVATE_UPLOAD_PROJECT_ROOT,
    trustedCanonicalDirectory: PRIVATE_UPLOAD_CANONICAL_DIRECTORY,
    probeTrustedGroupWritableParent: trustedGroupWritablePrivateUploadProbe,
  });
}
export async function uploadFileVersion(file: string) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || !stat.size) throw new VerifiedUploadError('UPLOAD_FILE_UNAVAILABLE', '原文件暂不可用');
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
export async function uploadFileHash(file: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
function uploadKind(mimeType: string) {
  const type = mimeType.split('/')[0];
  if (!['image', 'video', 'audio'].includes(type)) throw new VerifiedUploadError('UPLOAD_TYPE_INVALID', '不支持的文件类型', 400);
  return type as VerifiedUpload['type'];
}
async function verifyBitmap(file: string, bytes: number) {
  const handle = await fs.open(file, 'r'), header = Buffer.alloc(128);
  let read = 0;
  try { read = (await handle.read(header, 0, header.length, 0)).bytesRead; } finally { await handle.close(); }
  if (read < 26 || header.toString('latin1', 0, 2) !== 'BM' || header.readUInt32LE(2) !== bytes) throw new Error('bmp_header');
  const dibSize = header.readUInt32LE(14);
  if (![12, 40, 52, 56, 64, 108, 124].includes(dibSize) || bytes < 14 + dibSize || read < Math.min(14 + dibSize, header.length)) throw new Error('bmp_dib');
  const width = dibSize === 12 ? header.readUInt16LE(18) : header.readInt32LE(18);
  const height = dibSize === 12 ? header.readUInt16LE(20) : Math.abs(header.readInt32LE(22));
  const planes = header.readUInt16LE(dibSize === 12 ? 22 : 26), bpp = header.readUInt16LE(dibSize === 12 ? 24 : 28);
  const offset = header.readUInt32LE(10);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > 40_000_000
    || planes !== 1 || ![1, 4, 8, 16, 24, 32].includes(bpp) || offset < 14 + dibSize || offset >= bytes) throw new Error('bmp_bounds');
  const { stdout } = await execFileAsync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-f', 'bmp_pipe', '-show_entries',
    'stream=codec_name,codec_type,width,height', '-of', 'json', file], { timeout: 15000, maxBuffer: 65536 });
  const metadata = JSON.parse(stdout) as { streams?: Array<{ codec_name?: string; codec_type?: string; width?: number; height?: number }> };
  const stream = metadata.streams?.[0];
  if (metadata.streams?.length !== 1 || stream?.codec_name !== 'bmp' || stream.codec_type !== 'video'
    || stream.width !== width || stream.height !== height) throw new Error('bmp_codec');
  const decoded = await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode',
    '-threads', '2', '-f', 'bmp_pipe', '-i', file, '-map', '0:v:0', '-threads', '2', '-progress', 'pipe:1', '-nostats', '-f', 'null', '-'], { timeout: 45000, maxBuffer: 65536 });
  const frames = Array.from(decoded.stdout.matchAll(/^frame=(\d+)\s*$/gm));
  if (frames.length === 0 || frames[frames.length - 1][1] !== '1' || !/^progress=end\s*$/m.test(decoded.stdout)) throw new Error('bmp_complete_frame');
  return { width, height };
}
export async function inspectUpload(file: string, declared: string, hash: string, bytes: number): Promise<VerifiedUpload> {
  const mimeType = declared.split(';')[0].trim().toLowerCase(), type = uploadKind(mimeType);
  if (!bytes || bytes > limits[type]) throw new VerifiedUploadError('UPLOAD_SIZE_INVALID', '文件大小超出上传限制', 400);
  const version = await uploadFileVersion(file);
  let width: number | null = null, height: number | null = null;
  let extension = '';
  if (type === 'image') {
    try {
      if (mimeType === 'image/bmp') {
        ({ width, height } = await verifyBitmap(file, bytes)); extension = 'bmp';
      } else {
        const image = sharp(file, { animated: true, limitInputPixels: 40_000_000, failOn: 'warning' }).timeout({ seconds: 45 });
        const meta = await image.metadata();
        if (!meta.format || formats[meta.format] !== mimeType || !meta.width || !meta.height
          || meta.width * meta.height > 40_000_000 || (meta.pages || 1) > 100) throw new Error('format');
        await image.stats(); // Complete decode, not only a filename or MIME header.
        width = meta.width; height = meta.pageHeight || meta.height; extension = meta.format === 'jpeg' ? 'jpg' : meta.format;
      }
    } catch { throw new VerifiedUploadError('UPLOAD_IMAGE_INVALID', '图片内容或格式无法完整验证，请重新选择文件', 400); }
  } else {
    const handle = await fs.open(file, 'r');
    const header = Buffer.alloc(64);
    try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
    const text = (start: number, end: number) => header.subarray(start, end).toString('latin1');
    const detected = text(0, 4) === 'OggS' ? 'audio/ogg'
      : ['RIFF', 'RIFX', 'RF64', 'BW64'].includes(text(0, 4)) && text(8, 12) === 'WAVE' ? 'audio/wav'
      : text(0, 3) === 'ID3' || header[0] === 0xff && (header[1] & 0xe0) === 0xe0 ? 'audio/mpeg'
      : text(4, 8) === 'ftyp' ? (text(8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4')
      : header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ? 'video/webm' : '';
    const movFamily = mimeType === 'video/mp4' || mimeType === 'video/quicktime';
    // MOV can legitimately begin with moov/mdat/wide/free and MP4/MOV share
    // a demuxer. Probe the actual container family rather than its first brand.
    if (!movFamily && detected !== mimeType) throw new VerifiedUploadError('UPLOAD_TYPE_MISMATCH', '文件实际类型与上传声明不一致', 400);
    try {
      const { stdout } = await execFileAsync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=format_name,duration', '-of', 'json', file], { timeout: 15000, maxBuffer: 65536 });
      const metadata = JSON.parse(stdout);
      const streams = metadata.streams as Array<{ codec_type: string; width?: number; height?: number }>;
      const primary = streams?.find(stream => stream.codec_type === type);
      const containers = String(metadata.format?.format_name || '').split(',');
      if (movFamily && !containers.some(name => name === 'mov' || name === 'mp4')
        || mimeType === 'audio/wav' && !containers.includes('wav')) throw new Error('media_container');
      if (!primary || !Number.isFinite(Number(metadata.format?.duration)) || Number(metadata.format.duration) <= 0
        || type === 'video' && (!primary.width || !primary.height || primary.width * primary.height > 40_000_000)) throw new Error('media_metadata');
      // Read every stream packet/frame, with strict decoder errors and bounded
      // CPU time. A valid header alone is not a complete media upload.
      await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode', '-threads', '2', '-i', file, '-map', type === 'video' ? '0:v:0' : '0:a:0', '-threads', '2', '-f', 'null', '-'], { timeout: 90000, maxBuffer: 65536 });
      if (type === 'video') { width = primary.width!; height = primary.height!; }
    } catch { throw new VerifiedUploadError('UPLOAD_MEDIA_INVALID', '媒体无法完整验证，请检查文件或稍后重试', 400); }
    extension = ({ 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' } as Record<string, string>)[mimeType];
  }
  if (await uploadFileVersion(file) !== version) throw new VerifiedUploadError('UPLOAD_SOURCE_CHANGED', '文件验证期间已变化');
  return { file, hash, bytes, mimeType, type, width, height, version, extension };
}
export async function stageVerifiedUpload(body: AsyncIterable<Uint8Array>, declaredMime: string, expectedBytes: number, expectedHash?: string) {
  const type = uploadKind(declaredMime), directory = await privateUploadDirectory();
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > limits[type]
    || expectedHash !== undefined && !/^[a-f0-9]{64}$/.test(expectedHash)) throw new VerifiedUploadError('UPLOAD_IDENTITY_INVALID', '文件身份或大小无效', 400);
  const file = path.join(directory, `${randomUUID()}.upload`), handle = await fs.open(file, 'wx', 0o600);
  const digest = createHash('sha256'); let bytes = 0;
  try {
    const iterator = body[Symbol.asyncIterator]();
    const deadline = Date.now() + 180000;
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const item = await Promise.race([iterator.next(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new VerifiedUploadError('UPLOAD_BODY_TIMEOUT', '上传文件接收超时，未登记', 408)), Math.max(1, deadline - Date.now()));
      })]).finally(() => clearTimeout(timer));
      if (item.done) break;
      const chunk = item.value;
      bytes += chunk.byteLength;
      if (bytes > expectedBytes || bytes > limits[type]) throw new VerifiedUploadError('UPLOAD_SIZE_MISMATCH', '上传文件大小不一致', 400);
      digest.update(chunk); await handle.writeFile(chunk);
    }
    await handle.sync(); await handle.close();
    const hash = digest.digest('hex');
    if (bytes !== expectedBytes || expectedHash && hash !== expectedHash) throw new VerifiedUploadError('UPLOAD_HASH_MISMATCH', '上传内容与文件校验信息不一致', 400);
    return { ...await inspectUpload(file, declaredMime, hash, bytes), temporary: true };
  } catch (error) { await handle.close().catch(() => {}); await fs.unlink(file).catch(() => {}); throw error; }
}
export async function verifyExistingUpload(asset: Asset, ownerId: string) {
  if (asset.owner_id !== ownerId || asset.status !== 'active' || !asset.hash) throw new VerifiedUploadError('UPLOAD_EXISTING_INACTIVE', '相同图片的原记录已隐藏或移除，原记录保留');
  const user = await uploadIdentity(ownerId);
  if (!await canReadStudioAsset(user, asset)) throw new VerifiedUploadError('UPLOAD_ASSET_UNAVAILABLE', '这张图片当前不可使用', 403);
  if (asset.file_size <= 0 || asset.file_size > limits[uploadKind(asset.mime_type)]) throw new VerifiedUploadError('UPLOAD_EXISTING_FILE_INVALID', '已有原件大小无法安全核实');
  const local = siteUploadPathFromUrl(asset.original_url);
  if (asset.original_url.startsWith('api-private://uploads/')) {
    const { privateMediaPath } = await import('@/lib/customer-api/private-media');
    const file = await privateMediaPath(asset.original_url, uploadDigest(ownerId));
    if (!file || (await fs.stat(file)).size !== asset.file_size || await uploadFileHash(file) !== asset.hash) {
      throw new VerifiedUploadError('UPLOAD_EXISTING_FILE_INVALID', '已有私有原件校验失败，未覆盖。');
    }
    return inspectUpload(file, asset.mime_type, asset.hash, asset.file_size);
  }
  if (!local) {
    const base = process.env.R2_PUBLIC_BASE_URL?.replace(/\/+$/, '');
    const ownerPrefix = `seedance-direct-uploads/${uploadDigest(ownerId).slice(0, 16)}/`;
    if (!base || !asset.original_url.startsWith(`${base}/${ownerPrefix}`) || !process.env.R2_ACCOUNT_ID
      || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_BUCKET) return null;
    const key = asset.original_url.slice(base.length + 1);
    if (key.includes('?') || key.includes('#') || key.includes('..')) return null;
    const client = new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
    const command = { Bucket: process.env.R2_BUCKET, Key: key };
    const head = await client.send(new HeadObjectCommand(command), { abortSignal: AbortSignal.timeout(30000) });
    if (head.ContentLength !== asset.file_size || !head.ETag) throw new VerifiedUploadError('UPLOAD_SOURCE_CHANGED', '已有远程原文件已变化');
    const object = await client.send(new GetObjectCommand(command), { abortSignal: AbortSignal.timeout(180000) });
    if (!object.Body || object.ETag !== head.ETag) throw new VerifiedUploadError('UPLOAD_SOURCE_CHANGED', '已有远程原文件已变化');
    const proof = await stageVerifiedUpload(object.Body as AsyncIterable<Uint8Array>, asset.mime_type, asset.file_size, asset.hash);
    try {
      const after = await client.send(new HeadObjectCommand(command), { abortSignal: AbortSignal.timeout(30000) });
      if (after.ETag !== head.ETag || after.ContentLength !== head.ContentLength) throw new VerifiedUploadError('UPLOAD_SOURCE_CHANGED', '远程原文件验证期间已变化');
      return { ...proof, sourceVersion: `r2:${uploadDigest(key)}:${head.ETag}:${head.ContentLength}:${asset.hash}` };
    } catch (error) { await releaseVerifiedUpload(proof); throw error; }
  }
  const root = await fs.realpath(path.join(process.cwd(), 'public/uploads'));
  const file = await fs.realpath(path.join(process.cwd(), 'public', local.replace(/^\/+/, ''))).catch(() => null);
  if (!file || !file.startsWith(`${root}${path.sep}`)) throw new VerifiedUploadError('UPLOAD_EXISTING_FILE_INVALID', '已有原文件无法验证，未修改原记录');
  const version = await uploadFileVersion(file), stat = await fs.stat(file);
  if (stat.size !== asset.file_size || await uploadFileHash(file) !== asset.hash) throw new VerifiedUploadError('UPLOAD_EXISTING_FILE_INVALID', '已有原文件校验异常，未覆盖原文件');
  const proof = await inspectUpload(file, asset.mime_type, asset.hash, stat.size);
  if (proof.version !== version) throw new VerifiedUploadError('UPLOAD_SOURCE_CHANGED', '已有原文件已变化');
  return proof;
}
export async function findVerifiedOwnUpload(ownerId: string, hash: string, mimeType?: string, bytes?: number) {
  const asset = await prisma.asset.findUnique({ where: { owner_id_hash: { owner_id: ownerId, hash } } });
  if (!asset) return null;
  if (asset.status !== 'active') throw new VerifiedUploadError('UPLOAD_EXISTING_INACTIVE', '相同图片的原记录已隐藏或移除，未自动恢复');
  if (mimeType && asset.mime_type !== mimeType || bytes !== undefined && asset.file_size !== bytes) throw new VerifiedUploadError('UPLOAD_IDENTITY_MISMATCH', '已有文件身份不一致，原记录保留');
  const proof = await verifyExistingUpload(asset, ownerId);
  return proof ? { asset, proof } : null;
}
export async function publishVerifiedFile(proof: VerifiedUpload, directory: string, name: string) {
  await privateUploadDirectory();
  await fs.mkdir(directory, { recursive: true });
  const root = await fs.realpath(directory), file = path.join(root, name);
  const uploadRoot = await fs.realpath(path.join(process.cwd(), 'public/uploads'));
  if (!root.startsWith(`${uploadRoot}${path.sep}`) || process.platform === 'linux' && (!root.startsWith('/data/video-api-debugger/')
    || (await fs.stat(root)).dev === (await fs.stat('/')).dev)) throw new VerifiedUploadError('UPLOAD_DATA_MOUNT_REQUIRED', '原文件数据目录暂不可用', 503);
  if (path.basename(name) !== name || await uploadFileVersion(proof.file) !== proof.version) throw new VerifiedUploadError('UPLOAD_SOURCE_CHANGED', '上传源已变化');
  const existing = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) {
    if (!existing.isFile() || existing.size !== proof.bytes || await uploadFileHash(file) !== proof.hash) throw new VerifiedUploadError('UPLOAD_STORED_FILE_INVALID', '已有文件占位异常，未覆盖原文件');
    return file;
  }
  const temporary = path.join(root, `.${randomUUID()}.upload`);
  try {
    await fs.copyFile(proof.file, temporary, 1); await fs.chmod(temporary, 0o644);
    const handle = await fs.open(temporary, 'r'); try { await handle.sync(); } finally { await handle.close(); }
    try { await fs.link(temporary, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const final = await fs.lstat(file);
    if (!final.isFile() || final.size !== proof.bytes || await uploadFileHash(file) !== proof.hash) throw new VerifiedUploadError('UPLOAD_STORED_FILE_INVALID', '文件并发发布校验失败，未覆盖原件');
    return file;
  } finally { await fs.unlink(temporary).catch(() => {}); }
}
type StoredReceipt = { assetId: string; fingerprint: string; disposition: 'new' | 'reused'; hash: string; bytes: number; mimeType: string };
const receiptKey = (ownerId: string, requestId: string) => `upload_receipt_v2:${uploadDigest(ownerId)}:${uploadDigest(requestId)}`;
export async function readVerifiedUploadReceipt(ownerId: string, requestId: string, fingerprint: string) {
  const row = await prisma.platformSetting.findUnique({ where: { key: receiptKey(ownerId, requestId) } });
  if (!row) return null;
  const receipt = JSON.parse(row.value_json) as StoredReceipt;
  if (receipt.fingerprint !== fingerprint) throw new VerifiedUploadError('UPLOAD_REQUEST_CONFLICT', '上传编号已用于其它文件');
  const asset = await prisma.asset.findUnique({ where: { id: receipt.assetId } });
  if (!asset || asset.owner_id !== ownerId || asset.status !== 'active') throw new VerifiedUploadError('UPLOAD_EXISTING_INACTIVE', '原上传结果已不可用，未重新上传或恢复');
  if (asset.hash !== receipt.hash || asset.file_size !== receipt.bytes || asset.mime_type !== receipt.mimeType) throw new VerifiedUploadError('UPLOAD_SOURCE_CHANGED', '原上传结果身份已变化，未修改或恢复');
  const proof = await verifyExistingUpload(asset, ownerId);
  if (!proof) throw new VerifiedUploadError('UPLOAD_EXISTING_FILE_INVALID', '原上传结果无法完整确认，未修改原记录');
  return { asset, proof, reused: receipt.disposition === 'reused' };
}
export async function registerVerifiedUpload(input: { ownerId: string; proof: VerifiedUpload; fileName: string; originalUrl: string;
  thumbnailUrl: string | null; requestId?: string; fingerprint?: string; width?: number | null; height?: number | null;
  authorize?: (tx: Prisma.TransactionClient) => Promise<void> }) {
  await uploadIdentity(input.ownerId);
  const existing = await prisma.asset.findUnique({ where: { owner_id_hash: { owner_id: input.ownerId, hash: input.proof.hash } } });
  const existingProof = existing ? await verifyExistingUpload(existing, input.ownerId) : null;
  if (existing && !existingProof) throw new VerifiedUploadError('UPLOAD_EXISTING_FILE_INVALID', '已有远程原件无法安全核实，原记录保留');
  await releaseVerifiedUpload(existingProof);
  const key = input.requestId ? receiptKey(input.ownerId, input.requestId) : null;
  const fingerprint = input.fingerprint || uploadDigest(JSON.stringify([input.proof.hash, input.proof.bytes, input.proof.mimeType]));
  const register = async (db: Prisma.TransactionClient) => {
    await input.authorize?.(db);
    const currentUser = await db.user.findUnique({ where: { id: input.ownerId } });
    if (!currentUser || currentUser.status !== 'active') throw new VerifiedUploadError('UPLOAD_OWNER_UNAVAILABLE', '当前账号不可上传', 403);
    const fresh = await db.asset.findUnique({ where: { owner_id_hash: { owner_id: input.ownerId, hash: input.proof.hash } } });
    if (fresh && (fresh.status !== 'active' || !await canReadStudioAsset(currentUser, fresh, db))) throw new VerifiedUploadError('UPLOAD_EXISTING_INACTIVE', '原记录不可复用，未修改隐藏状态');
    if (fresh && fresh.id !== existing?.id) throw new VerifiedUploadError('UPLOAD_CONCURRENT_WINNER', '同时上传结果待核实，请查询原上传');
    if (fresh && (fresh.original_url !== existing?.original_url || fresh.hash !== input.proof.hash || fresh.mime_type !== input.proof.mimeType
      || fresh.file_size !== input.proof.bytes)) throw new VerifiedUploadError('UPLOAD_SOURCE_CHANGED', '原上传记录已变化，未覆盖');
    const asset = fresh || await db.asset.create({ data: { id: randomUUID(), owner_id: input.ownerId, type: input.proof.type,
      original_url: input.originalUrl, thumbnail_url: input.thumbnailUrl, file_name: path.basename(input.fileName || 'upload.bin'),
      mime_type: input.proof.mimeType, file_size: input.proof.bytes, hash: input.proof.hash,
      width: input.proof.width ?? input.width ?? null, height: input.proof.height ?? input.height ?? null, status: 'active',
      metadata_json: JSON.stringify({ uploadIntegrity: { version: 'verified-upload-v2', hash: input.proof.hash } }) } });
    let reused = Boolean(fresh);
    if (key) {
      const found = await db.platformSetting.findUnique({ where: { key } });
      if (found) {
        const saved = JSON.parse(found.value_json) as StoredReceipt;
        if (saved.assetId !== asset.id || saved.fingerprint !== fingerprint) throw new VerifiedUploadError('UPLOAD_REQUEST_CONFLICT', '上传编号与原结果不一致');
        reused = saved.disposition === 'reused';
      } else await db.platformSetting.create({ data: { key, value_json: JSON.stringify({ assetId: asset.id, fingerprint, disposition: fresh ? 'reused' : 'new', hash: input.proof.hash, bytes: input.proof.bytes, mimeType: input.proof.mimeType }), updated_by: input.ownerId } });
    }
    return { asset, reused };
  };
  try { return await prisma.$transaction(register); }
  catch (error) {
    if ((error as { code?: string }).code !== 'P2002' && !(error instanceof VerifiedUploadError && error.code === 'UPLOAD_CONCURRENT_WINNER')) throw error;
    const winner = await findVerifiedOwnUpload(input.ownerId, input.proof.hash, input.proof.mimeType, input.proof.bytes);
    if (!winner) throw new VerifiedUploadError('UPLOAD_CONCURRENT_UNCONFIRMED', '并发上传结果尚未确认，未覆盖原记录');
    // Re-enter only after verifying the same-owner active winner; no blind retry/upsert.
    try {
    const receipt = key ? await readVerifiedUploadReceipt(input.ownerId, input.requestId!, fingerprint) : null;
    if (receipt) { await releaseVerifiedUpload(receipt.proof); return { asset: receipt.asset, reused: receipt.reused }; }
    if (key) await prisma.$transaction(async db => {
      await input.authorize?.(db);
      const currentUser = await db.user.findUnique({ where: { id: input.ownerId } });
      const fresh = await db.asset.findUnique({ where: { id: winner.asset.id } });
      if (!currentUser || currentUser.status !== 'active' || !fresh || fresh.owner_id !== input.ownerId || fresh.status !== 'active'
        || fresh.hash !== input.proof.hash || fresh.original_url !== winner.asset.original_url || !await canReadStudioAsset(currentUser, fresh, db)) throw new VerifiedUploadError('UPLOAD_CONCURRENT_UNCONFIRMED', '同时上传结果已变化');
      await db.platformSetting.create({ data: { key, value_json: JSON.stringify({ assetId: winner.asset.id, fingerprint, disposition: 'reused', hash: input.proof.hash, bytes: input.proof.bytes, mimeType: input.proof.mimeType }), updated_by: input.ownerId } });
    }).catch(async failure => {
      if ((failure as { code?: string }).code !== 'P2002') throw failure;
      const saved = await readVerifiedUploadReceipt(input.ownerId, input.requestId!, fingerprint);
      if (!saved) throw failure;
      await releaseVerifiedUpload(saved.proof);
    });
    return { asset: winner.asset, reused: true };
    } finally { await releaseVerifiedUpload(winner.proof); }
  }
}
