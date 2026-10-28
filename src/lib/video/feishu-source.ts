import { createHash } from 'node:crypto';
import { constants, openAsBlob } from 'node:fs';
import { mkdtemp, mkdir, open, realpath, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { TosClient } from '@volcengine/tos-sdk';
import { VIDEO_FEISHU_MAX_BYTES, VideoFeishuError } from './feishu-contract';
import type { authorizedVideoFeishuTask } from './feishu-notification';

type Task = Awaited<ReturnType<typeof authorizedVideoFeishuTask>>['task'];
type Bytes = AsyncIterable<Uint8Array> & { destroy?: () => void };
type Origin = { size: number; version: string; stream: () => Promise<Bytes>; current: () => Promise<boolean>; close: () => Promise<void> };
export type PreparedVideoFeishuSource = {
  version: string; hash: string | null; mode: 'video' | 'link'; reason: string | null;
  video: Blob | null; cover: Blob | null; durationMs: number | null;
  current: () => Promise<boolean>; close: () => Promise<void>;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unavailable = () => new VideoFeishuError('original_not_ready', 409, false, true);
export function videoFeishuSourceStamp(task: Task) {
  return hash([task.id, task.local_video_path, task.public_video_storage_provider, task.public_video_storage_key,
    task.public_video_url, task.public_video_file_size, task.public_video_cached_at?.toISOString() || null]);
}
const sameStat = (a: Awaited<ReturnType<typeof stat>>, b: Awaited<ReturnType<typeof stat>>) => a.isFile() && b.isFile()
  && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

async function localOrigin(task: Task): Promise<Origin | null> {
  if (!task.local_video_path) return null;
  // This is the existing b9 cache receipt, not an arbitrary persisted URL/path.
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(task.id) || task.local_video_path !== `/videos/${task.id}.mp4`) throw unavailable();
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const root = await realpath(path.join(process.cwd(), 'public', 'videos'));
    const file = path.join(root, `${task.id}.mp4`);
    if (await realpath(path.join(process.cwd(), 'public', task.local_video_path)) !== file) throw unavailable();
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const initial = await handle.stat();
    if (!initial.isFile() || initial.size < 1 || !Number.isSafeInteger(initial.size)) throw unavailable();
    const fd = handle;
    const current = async () => {
      try { return await realpath(path.join(process.cwd(), 'public', task.local_video_path!)) === file
        && sameStat(initial, await stat(file)) && sameStat(initial, await fd.stat()); } catch { return false; }
    };
    return { size: initial.size, version: hash([videoFeishuSourceStamp(task), root, initial.dev, initial.ino, initial.size, initial.mtimeMs, initial.ctimeMs]),
      stream: async () => fd.createReadStream({ autoClose: false }), current, close: async () => { await fd.close(); } };
  } catch (error) {
    await handle?.close();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw unavailable();
  }
}

export function videoFeishuRemoteLocation(task: Task) {
  const provider = task.public_video_storage_provider, key = task.public_video_storage_key;
  const stem = `seedance-video-${task.id}`.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  if (!['r2', 'tos'].includes(provider || '') || !key || !/^seedance-videos\/[A-Za-z0-9_-]{1,220}\.mp4$/.test(key)
    || !key.startsWith(`seedance-videos/${stem}-`)) throw unavailable();
  const base = process.env[provider === 'r2' ? 'R2_PUBLIC_BASE_URL' : 'TOS_PUBLIC_BASE_URL'];
  if (!base || !task.public_video_url) throw unavailable();
  try {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw unavailable();
    const expected = `${base.replace(/\/+$/, '')}/${key}`;
    if (task.public_video_url !== expected) throw unavailable();
  } catch { throw unavailable(); }
  return { provider: provider as 'r2' | 'tos', key };
}
async function remoteOrigin(task: Task): Promise<Origin> {
  const { provider, key } = videoFeishuRemoteLocation(task);
  let head: () => Promise<{ size: number; etag: string; version: string | undefined }>;
  let stream: (etag: string, version?: string) => Promise<Bytes>;
  let close: () => Promise<void>;
  if (provider === 'r2') {
    const account = process.env.R2_ACCOUNT_ID, accessKeyId = process.env.R2_ACCESS_KEY_ID, secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucket = process.env.R2_BUCKET;
    if (!account || !/^[a-f0-9]{32}$/.test(account) || !accessKeyId || !secretAccessKey || !bucket) throw unavailable();
    const client = new S3Client({ region: 'auto', endpoint: `https://${account}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1 });
    head = async () => {
      const item = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(10_000) });
      return { size: Number(item.ContentLength), etag: item.ETag || '', version: item.VersionId };
    };
    stream = async (etag, version) => {
      const item = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, IfMatch: etag, VersionId: version }), { abortSignal: AbortSignal.timeout(60_000) });
      if (!item.Body) throw unavailable();
      return item.Body as Bytes;
    };
    close = async () => { client.destroy(); };
  } else {
    const accessKeyId = process.env.TOS_ACCESS_KEY, accessKeySecret = process.env.TOS_SECRET_KEY, bucket = process.env.TOS_BUCKET;
    const endpoint = process.env.TOS_ENDPOINT || 'https://tos-ap-southeast-1.volces.com';
    const endpointUrl = new URL(endpoint.startsWith('https://') ? endpoint : `https://${endpoint}`);
    if (!accessKeyId || !accessKeySecret || !bucket || endpointUrl.protocol !== 'https:' || endpointUrl.username || endpointUrl.password
      || endpointUrl.pathname !== '/' || endpointUrl.search || endpointUrl.hash || !/^tos-[a-z0-9-]+\.volces\.com$/.test(endpointUrl.hostname)) throw unavailable();
    const client = new TosClient({ accessKeyId, accessKeySecret, region: process.env.TOS_REGION || 'ap-southeast-1', endpoint: endpointUrl.host,
      requestTimeout: 60_000, connectionTimeout: 10_000, maxRetryCount: 0 });
    head = async () => {
      const item = await client.headObject({ bucket, key });
      return { size: Number(item.data['content-length']), etag: item.data.etag || '', version: item.data['x-tos-version-id'] };
    };
    stream = async (etag, versionId) => (await client.getObjectV2({ bucket, key, ifMatch: etag, versionId, dataType: 'stream' })).data.content as Bytes;
    close = async () => { /* TOS owns no per-source file descriptor. */ };
  }
  try {
    const initial = await head();
    if (!Number.isSafeInteger(initial.size) || initial.size < 1 || !initial.etag || initial.etag.length > 256
      || task.public_video_file_size !== null && task.public_video_file_size !== initial.size) throw unavailable();
    return { size: initial.size, version: hash([videoFeishuSourceStamp(task), initial]), stream: () => stream(initial.etag, initial.version),
      current: async () => { try { const next = await head(); return hash(initial) === hash(next); } catch { return false; } }, close };
  } catch { await close(); throw unavailable(); }
}
export function videoFeishuSizeMode(size: number) {
  if (!Number.isSafeInteger(size) || size < 1) throw unavailable();
  return size > VIDEO_FEISHU_MAX_BYTES ? 'link' as const : 'video' as const;
}
async function copyBounded(origin: Origin, destination: string) {
  const output = await open(destination, 'wx', 0o600), digest = createHash('sha256');
  let input: Bytes | undefined, count = 0, header = Buffer.alloc(0);
  const until = Date.now() + 60_000;
  const deadline = setTimeout(() => input?.destroy?.(), 60_000);
  try {
    input = await origin.stream();
    if (Date.now() >= until) throw unavailable();
    for await (const chunk of input) {
      if (Date.now() >= until) throw unavailable();
      count += chunk.byteLength;
      if (count > VIDEO_FEISHU_MAX_BYTES || count > origin.size) throw unavailable();
      if (header.length < 32) header = Buffer.concat([header, chunk.subarray(0, 32 - header.length)]);
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = (await output.write(chunk, offset, chunk.byteLength - offset)).bytesWritten;
        if (written < 1) throw unavailable();
        offset += written;
      }
    }
    if (count !== origin.size || !await origin.current()) throw unavailable();
    return { hash: digest.digest('hex'), mp4: videoFeishuMp4Header(header) };
  } finally { clearTimeout(deadline); input?.destroy?.(); await output.close(); }
}
export function videoFeishuMp4Header(header: Uint8Array) {
  const bytes = Buffer.from(header);
  return bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp'
    && /^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash)$/.test(bytes.toString('ascii', 8, 12));
}
function command(binary: string, args: string[], timeout: number) {
  return new Promise<string>((resolve, reject) => execFile(binary, args, { timeout, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
    if (error) reject(unavailable()); else resolve(stdout);
  }));
}
export function videoFeishuProbe(value: unknown): { supported: boolean; durationMs: number } {
  const item = value as { format?: { format_name?: string; duration?: string }; streams?: { codec_type?: string; duration?: string }[] };
  const duration = Number(item?.format?.duration), streams = item?.streams;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 24 * 3600 || !Array.isArray(streams)) throw unavailable();
  return { supported: Boolean(item.format?.format_name?.split(',').includes('mp4') && streams.some(stream => stream.codec_type === 'video')),
    durationMs: Math.round(duration * 1000) };
}
export async function prepareVideoFeishuSource(task: Task): Promise<PreparedVideoFeishuSource> {
  let origin: Origin | null = null, directory: string | null = null;
  try {
    origin = await localOrigin(task) || await remoteOrigin(task);
    const source = origin;
    const close = async () => { await source.close(); if (directory) await rm(directory, { recursive: true, force: true }); };
    if (videoFeishuSizeMode(source.size) === 'link') return { version: source.version, hash: null, mode: 'link', reason: 'video_oversize',
      video: null, cover: null, durationMs: null, current: source.current, close };
    if (typeof openAsBlob !== 'function') throw new VideoFeishuError('runtime_blob_stream_unavailable', 503);
    // Private bounded copies are disposable; never reuse a public thumbnail with no source-version receipt.
    const root = process.env.NODE_ENV === 'production' ? '/data/video-api-debugger/var-lib/storage/video-feishu-tmp' : path.join(os.tmpdir(), 'video-feishu');
    await mkdir(root, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(path.join(await realpath(root), 'delivery-'));
    const videoPath = path.join(directory, 'original.mp4'), coverPath = path.join(directory, 'cover.jpg');
    const copied = await copyBounded(source, videoPath), contentHash = copied.hash;
    if (!copied.mp4) return { version: source.version, hash: contentHash, mode: 'link', reason: 'video_format_unsupported',
      video: null, cover: null, durationMs: null, current: source.current, close };
    const probe = videoFeishuProbe(JSON.parse(await command('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries',
      'format=format_name,duration:stream=codec_type', '-of', 'json', videoPath], 15_000)));
    if (!probe.supported) return { version: source.version, hash: contentHash, mode: 'link', reason: 'video_format_unsupported',
      video: null, cover: null, durationMs: null, current: source.current, close };
    let cover: Blob | null = null;
    try {
      await command('ffmpeg', ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-ss', String(Math.min(2.5, probe.durationMs / 2000)),
        '-i', videoPath, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '4', '-y', coverPath], 15_000);
      const info = await stat(coverPath);
      if (info.isFile() && info.size > 0 && info.size <= 1024 * 1024) cover = await openAsBlob(coverPath, { type: 'image/jpeg' });
    } catch { /* The official media cover is optional; never substitute an unrelated cached frame. */ }
    return { version: source.version, hash: contentHash, mode: 'video', reason: null,
      video: await openAsBlob(videoPath, { type: 'video/mp4' }), cover, durationMs: probe.durationMs, current: source.current, close };
  } catch (error) {
    await origin?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    if (error instanceof VideoFeishuError) throw error;
    throw unavailable();
  }
}
