import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, stat, realpath, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { ZipFile } from 'yazl';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { mediaPreviewResponse } from '@/lib/media/preview-response';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { isSafeTaskId } from './thumbnail';
import { multiviewDimensions, validMultiviewLayout, type MultiviewInfo, type MultiviewLayout } from './multiview-contract';

const exec = promisify(execFile);
const MAX_VIDEO = 128 * 1024 * 1024;
const MAX_CACHE = 1024 * 1024 * 1024;
const TTL = 24 * 60 * 60 * 1000;
const inflight = new Map<string, Promise<unknown>>();
let workCount = 0;
let exportCount = 0;
export class MultiviewError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
type Source = { version: string; source: string; local: string | null };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function authorizedSource(user: SessionUser, id: string): Promise<Source> {
  if (!isSafeTaskId(id)) throw new MultiviewError('视频编号无效');
  const task = await prisma.videoTask.findUnique({ where: { id } });
  if (!task) throw new MultiviewError('视频不存在', 404);
  await assertCanViewTask(user, task);
  if (task.local_status !== 'succeeded') throw new MultiviewError('请等待原视频生成完成', 409);
  const source = task.local_video_path || task.public_video_url || task.result_video_url;
  if (!source || source.startsWith('h3-internal-output:')) throw new MultiviewError('原视频还在保存，请稍后从原视频重试', 409);
  const relative = siteUploadPathFromUrl(source) || (source.startsWith('/') && !source.startsWith('//') ? source : null);
  if (relative) {
    const root = path.resolve(process.cwd(), 'public');
    const candidate = path.resolve(root, decodeURIComponent(relative.split(/[?#]/)[0]).replace(/^\/+/, ''));
    if (!candidate.startsWith(`${root}${path.sep}`)) throw new MultiviewError('原视频路径无效');
    const file = await realpath(candidate).catch(() => null);
    const allowed = await Promise.all(['videos', 'uploads'].map(dir => realpath(path.join(root, dir)).catch(() => null)));
    if (!file || !allowed.some(base => base && file.startsWith(`${base}${path.sep}`))) throw new MultiviewError('原视频文件暂不可用', 404);
    const info = await stat(file);
    if (!info.isFile() || !info.size || info.size > MAX_VIDEO) throw new MultiviewError('3D多视图目前支持 128MB 以内的视频');
    return { source, local: file, version: digest(`${id}:${file}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`) };
  }
  // Only persisted, already-authorized sources enter the existing pinned-DNS media transport.
  if (!/^https?:\/\//i.test(source)) throw new MultiviewError('原视频尚无可读取文件', 409);
  return { source, local: null, version: digest(`${id}:${source}`) };
}

async function cacheRoot() {
  if (process.env.NODE_ENV === 'production') {
    const [data, system] = await Promise.all([stat('/data'), stat('/')]);
    if (data.dev === system.dev || !data.isDirectory()) throw new MultiviewError('数据盘暂不可用，原视频保持不变', 503);
  }
  const root = process.env.NODE_ENV === 'production'
    ? '/data/video-api-debugger/var-lib/storage/multiview-cache' : path.join(process.cwd(), '.cache', 'multiview');
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}
async function pruneCache(root: string, keep: string) {
  const directories = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name));
  const items = await Promise.all(directories.map(async entry => {
    const dir = path.join(root, entry.name);
    const files = await readdir(dir, { withFileTypes: true });
    const sizes = await Promise.all(files.filter(file => file.isFile()).map(file => stat(path.join(dir, file.name)).catch(() => null)));
    return { dir, key: entry.name, size: sizes.reduce((n, file) => n + (file?.size || 0), 0), time: Math.max(0, ...sizes.map(file => file?.mtimeMs || 0)) };
  }));
  let total = items.reduce((n, item) => n + item.size, 0);
  let count = items.length;
  for (const item of items.sort((a, b) => a.time - b.time)) {
    if (item.key === keep || Array.from(inflight.keys()).some(key => key.startsWith(item.key))) continue;
    if (Date.now() - item.time > TTL || total > MAX_CACHE - MAX_VIDEO || count > 32) {
      await rm(item.dir, { recursive: true, force: true });
      total -= item.size;
      count -= 1;
    }
  }
  if (total > MAX_CACHE) throw new MultiviewError('临时图片空间已满，请稍后重试；原视频未改变', 503);
}
async function once<T>(key: string, action: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  if (workCount >= 2) throw new MultiviewError('正在处理其他图片，请稍后重试这一格', 429);
  workCount += 1;
  const pending = action();
  inflight.set(key, pending);
  try { return await pending; } finally { inflight.delete(key); workCount -= 1; }
}
async function atomicWrite(file: string, data: Buffer | string) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, data, { mode: 0o600 }); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}
async function downloadSource(source: Source, dir: string, request: Request) {
  if (source.local) return source.local;
  const target = path.join(dir, 'source.mp4');
  if (await stat(target).then(info => info.size > 0 && info.size <= MAX_VIDEO).catch(() => false)) return target;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await mediaPreviewResponse(new Request(request.url, { signal: AbortSignal.any([request.signal, controller.signal]) }), source.source, 'video/mp4');
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_VIDEO) {
      await response.body?.cancel(); throw new MultiviewError('原视频暂无法读取或超过 128MB', 503);
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = []; let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > MAX_VIDEO) throw new MultiviewError('3D多视图目前支持 128MB 以内的视频');
        chunks.push(Buffer.from(chunk.value));
      }
    } finally { await reader.cancel().catch(() => undefined); }
    if (!bytes) throw new MultiviewError('原视频文件为空', 503);
    await atomicWrite(target, Buffer.concat(chunks));
    return target;
  } finally { clearTimeout(timeout); controller.abort(); }
}
const inputFlags = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi'];
async function preparation(user: SessionUser, id: string, request: Request, expected?: string | null) {
  const source = await authorizedSource(user, id);
  if (expected && expected !== source.version) throw new MultiviewError('原视频版本已改变，请重新打开；旧选帧不会覆盖新原片', 409);
  const root = await cacheRoot();
  const dir = path.join(root, source.version);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let info: MultiviewInfo | undefined;
  try {
    const saved = JSON.parse(await readFile(path.join(dir, 'info.json'), 'utf8')) as MultiviewInfo;
    if (saved.sourceVersion === source.version && saved.taskId === id && saved.timestamps.length) info = saved;
  } catch {}
  if (!info) info = await once(`${source.version}:prepare`, async () => {
    await pruneCache(root, source.version);
    const file = await downloadSource(source, dir, request);
    const { stdout } = await exec(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', ...inputFlags, '-threads', '1', '-select_streams', 'v:0',
      '-show_frames', '-show_entries', 'stream=width,height:stream_tags=rotate:stream_side_data=rotation:format=duration:frame=best_effort_timestamp_time', '-of', 'json', file],
    { timeout: 60000, maxBuffer: 4 * 1024 * 1024, signal: request.signal });
    const raw = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number; tags?: { rotate?: string }; side_data_list?: Array<{ rotation?: number }> }>; format?: { duration?: string }; frames?: Array<{ best_effort_timestamp_time?: string }> };
    const stream = raw.streams?.[0]; const duration = Number(raw.format?.duration);
    let width = Number(stream?.width), height = Number(stream?.height);
    const rotation = Number(stream?.side_data_list?.find(item => typeof item.rotation === 'number')?.rotation ?? stream?.tags?.rotate ?? 0);
    if (Math.abs(rotation % 180) === 90) [width, height] = [height, width];
    const timestamps = raw.frames?.map(frame => Number(frame.best_effort_timestamp_time)) || [];
    const start = timestamps[0] || 0;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 180 || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 16777216
      || timestamps.length < 8 || timestamps.length > 21600 || timestamps.some((time, index) => !Number.isFinite(time) || (index > 0 && time < timestamps[index - 1]))) {
      throw new MultiviewError('目前支持 3 分钟以内、至少 8 帧且不超过 1600 万像素的视频');
    }
    const result: MultiviewInfo = { taskId: id, sourceVersion: source.version, width, height, duration, timestamps: timestamps.map(time => time - start) };
    await atomicWrite(path.join(dir, 'info.json'), JSON.stringify(result));
    return result;
  });
  return { source, dir, info };
}
export async function multiviewInfo(user: SessionUser, id: string, request: Request) {
  const prepared = await preparation(user, id, request);
  if ((await authorizedSource(user, id)).version !== prepared.source.version) throw new MultiviewError('原视频已改变，请重新打开', 409);
  return prepared.info;
}
async function frameFile(prepared: Awaited<ReturnType<typeof preparation>>, frame: number, request: Request) {
  if (!Number.isInteger(frame) || frame < 0 || frame >= prepared.info.timestamps.length) throw new MultiviewError('帧位置无效');
  const output = path.join(prepared.dir, `frame-${frame}.png`);
  if (await stat(output).then(info => info.isFile() && info.size > 0).catch(() => false)) return output;
  await once(`${prepared.source.version}:frame:${frame}`, async () => {
    const entries = (await readdir(prepared.dir)).filter(name => /^frame-\d+\.png$/.test(name));
    const cached = await Promise.all(entries.map(async name => ({ name, info: await stat(path.join(prepared.dir, name)).catch(() => null) })));
    let bytes = cached.reduce((sum, item) => sum + (item.info?.size || 0), 0);
    let count = cached.length;
    for (const item of cached.sort((a, b) => (a.info?.mtimeMs || 0) - (b.info?.mtimeMs || 0))) {
      if (count < 48 && bytes < 256 * 1024 * 1024 - prepared.info.width * prepared.info.height * 4) break;
      const number = Number(item.name.slice(6, -4));
      if (inflight.has(`${prepared.source.version}:frame:${number}`)) continue;
      await rm(path.join(prepared.dir, item.name), { force: true }); bytes -= item.info?.size || 0; count -= 1;
    }
    const file = await downloadSource(prepared.source, prepared.dir, request);
    const temp = `${output}.${randomUUID()}.tmp.png`;
    try {
      await exec(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-v', 'error', '-threads', '1', ...inputFlags, '-i', file,
        '-an', '-sn', '-dn', '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-fps_mode', 'vfr', '-filter_threads', '1', '-threads', '1', '-compression_level', '3', temp],
      { timeout: 60000, maxBuffer: 512 * 1024, signal: request.signal });
      const metadata = await sharp(temp, { limitInputPixels: 16777216 }).metadata();
      if (metadata.width !== prepared.info.width || metadata.height !== prepared.info.height) throw new MultiviewError('原帧尺寸发生变化，请重开原视频', 409);
      await rename(temp, output);
    } finally { await rm(temp, { force: true }); }
  });
  return output;
}
export async function multiviewFrame(user: SessionUser, id: string, request: Request, version: string, frame: number) {
  const prepared = await preparation(user, id, request, version);
  const output = await frameFile(prepared, frame, request);
  if ((await authorizedSource(user, id)).version !== version) throw new MultiviewError('原视频已改变，请重新打开', 409);
  return readFile(output);
}
export async function multiviewExport(user: SessionUser, id: string, request: Request, body: Record<string, unknown>) {
  // Limit the entire export, including cached-frame buffers, not only the final encoder.
  if (exportCount >= 1) throw new MultiviewError('另一个导出正在准备，请稍后重试；当前选帧保持不变', 429);
  exportCount += 1;
  try { return await createMultiviewExport(user, id, request, body); }
  finally { exportCount -= 1; }
}
async function createMultiviewExport(user: SessionUser, id: string, request: Request, body: Record<string, unknown>) {
  if (typeof body.version !== 'string' || !/^[a-f0-9]{64}$/.test(body.version) || !Array.isArray(body.frames)
    || !body.frames.length || body.frames.length > 8 || !body.frames.every(Number.isInteger) || !validMultiviewLayout(body.layout)
    || !['png', 'zip'].includes(String(body.format))) throw new MultiviewError('导出设置无效');
  const prepared = await preparation(user, id, request, body.version);
  const frames = body.frames as number[];
  const layout: MultiviewLayout = body.layout;
  const dimensions = multiviewDimensions(prepared.info, frames.length, layout);
  if (body.format === 'png' && dimensions.width * dimensions.height > 64000000) throw new MultiviewError('拼图超过 6400 万像素，请减少图片数量或留白，或下载原尺寸单图包；不会缩小原图');
  const files: Buffer[] = [];
  for (const frame of frames) files.push(await readFile(await frameFile(prepared, frame, request)));
  if ((await authorizedSource(user, id)).version !== body.version) throw new MultiviewError('原视频已改变，请重新打开', 409);
  if (body.format === 'png') {
    const columns = Math.min(layout.columns, frames.length);
    const data = await once(`${prepared.source.version}:export:${digest(JSON.stringify(body))}`, () => sharp({ create: { ...dimensions, channels: 3, background: layout.background } }).composite(files.map((input, index) => ({ input,
      left: layout.margin + (index % columns) * (prepared.info.width + layout.gap),
      top: layout.margin + Math.floor(index / columns) * (prepared.info.height + layout.gap) }))).png().toBuffer());
    return { data, mime: 'image/png', name: `multiview-${id}.png` };
  }
  const data = await once(`${prepared.source.version}:export:${digest(JSON.stringify(body))}`, async () => {
  const zip = new ZipFile();
  files.forEach((file, index) => zip.addBuffer(file, `view-${String(index + 1).padStart(2, '0')}.png`, { compress: false }));
  zip.addBuffer(Buffer.from(JSON.stringify({ taskId: id, sourceVersion: body.version, width: prepared.info.width, height: prepared.info.height,
    frames: frames.map((frame, index) => ({ file: `view-${String(index + 1).padStart(2, '0')}.png`, frame, time: prepared.info.timestamps[frame],
      name: Array.isArray(body.names) && typeof body.names[index] === 'string' ? body.names[index].slice(0, 40) : '' })),
    note: '从原视频选帧，角度由用户确认；未缩放、裁剪或去除背景。' }, null, 2)), 'frames.json');
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on('data', chunk => chunks.push(chunk)); zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject); zip.on('error', reject);
  });
  zip.end();
  return result;
  });
  return { data, mime: 'application/zip', name: `multiview-${id}.zip` };
}
export function multiviewFailure(error: unknown) {
  if (error instanceof MultiviewError || error instanceof AuthError) return { status: error.status, message: error.message };
  return { status: 503, message: '图片暂未准备好，请重试当前操作；原视频和选帧不变' };
}
