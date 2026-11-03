import 'server-only';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { authorizedImageResponse, type ImageVariant } from '@/lib/media/authorized-image-response';
import { mediaPreviewResponse, parsePreviewRange, previewMime } from '@/lib/media/preview-response';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { getWorkAccess, type WorkAccess } from './access';
import { resolveWorkPreviewFile } from './preview-files';
import { WorkError } from './types';
import { workHeaders } from './http';

async function privatePreview(request: Request, file: string) {
  const info = await stat(file);
  if (!info.isFile() || !info.size) throw new WorkError('成品预览暂不可用', 404);
  const rangeHeader = request.method === 'HEAD' ? null : request.headers.get('range');
  const range = rangeHeader ? parsePreviewRange(rangeHeader, info.size) : null;
  const headers = new Headers({ ...workHeaders, 'Content-Type': path.extname(file) === '.mp4' ? 'video/mp4' : path.extname(file) === '.webp' ? 'image/webp' : 'image/jpeg', 'Accept-Ranges': 'bytes', 'Content-Disposition': 'inline' });
  if (rangeHeader && !range) { headers.set('Content-Range', `bytes */${info.size}`); return new Response(null, { status: 416, headers }); }
  headers.set('Content-Length', String(range ? range.end - range.start + 1 : info.size));
  if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`);
  if (request.method === 'HEAD') return new Response(null, { headers });
  request.signal.throwIfAborted();
  const stream = createReadStream(file, range || undefined);
  const abort = () => stream.destroy(new Error('work_media_aborted'));
  request.signal.addEventListener('abort', abort, { once: true });
  stream.once('close', () => request.signal.removeEventListener('abort', abort));
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers });
}
async function storedPreview(request: Request, source: string) {
  const privateFile = await resolveWorkPreviewFile(source);
  if (privateFile) return privatePreview(request, privateFile);
  if (!siteUploadPathFromUrl(source) && !source.startsWith('/videos/') && !/^https?:\/\//.test(source)) throw new WorkError('成品预览尚未就绪', 409);
  // The stored 640/poster reference is read as-is. No image/HD/ffmpeg job starts in a GET.
  return mediaPreviewResponse(request, source, previewMime(source, 'image/webp'));
}

async function originalVideo(request: Request, access: WorkAccess) {
  const { media } = access;
  if (!access.canDownload || !media.source_url) throw new WorkError('未获得原件权限', 403);
  const local = siteUploadPathFromUrl(media.source_url) || (media.source_url.startsWith('/videos/') ? media.source_url : null);
  const exists = local ? await stat(path.join(process.cwd(), 'public', local.replace(/^\/+/, ''))).then(info => info.isFile()).catch(error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  }) : false;
  if (!media.video_task_id || exists) return mediaPreviewResponse(request, media.source_url, 'video/mp4');
  const task = await prisma.videoTask.findUnique({ where: { id: media.video_task_id } });
  if (!task || !media.source_updated_at) throw new WorkError('原视频保存记录暂不可用', 409);
  // SDK access is reached only after original permission and exact Work-version checks.
  const { openWorkStoredVideo } = await import('./video-storage');
  const source = await openWorkStoredVideo(task, { videoTaskId: task.id, sourceUrl: media.source_url, sourceUpdatedAt: media.source_updated_at }, request.signal);
  try {
    const rangeHeader = request.method === 'HEAD' ? null : request.headers.get('range');
    const range = rangeHeader ? parsePreviewRange(rangeHeader, source.size) : null;
    const headers = new Headers({ ...workHeaders, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Disposition': 'inline' });
    if (rangeHeader && !range) { await source.close(); headers.set('Content-Range', `bytes */${source.size}`); return new Response(null, { status: 416, headers }); }
    headers.set('Content-Length', String(range ? range.end - range.start + 1 : source.size));
    if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${source.size}`);
    if (request.method === 'HEAD') { await source.close(); return new Response(null, { headers }); }
    if (!await source.current()) throw new WorkError('原视频版本已变化，请重新打开当前作品', 409, 'WORKS_VERSION_CHANGED');
    const bytes = await source.stream(range || undefined), stream = Readable.from(bytes);
    const abort = () => { bytes.destroy?.(); stream.destroy(new Error('work_media_aborted')); };
    request.signal.addEventListener('abort', abort, { once: true });
    stream.once('close', () => { request.signal.removeEventListener('abort', abort); void source.close(); });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers });
  } catch (error) { await source.close(); throw error; }
}
export async function workMediaResponse(request: Request, user: SessionUser, workId: string) {
  const params = new URL(request.url).searchParams, version = params.get('version'), variant = params.get('variant') || 'preview';
  if (!version || !['thumbnail', 'preview', 'detail', 'original', 'download', 'hd', 'hd-description', 'hd-download'].includes(variant)) throw new WorkError('成品版本或读取方式无效');
  const access = await getWorkAccess(user, workId);
  if (!access?.canPreview) throw new WorkError('成品已不可用或当前无权查看', 404);
  if (version !== access.media.id) throw new WorkError('成品版本已变化，请重新打开当前作品', 409, 'WORKS_VERSION_CHANGED');
  const { work, media } = access;
  let response: Response;
  if (['original', 'hd', 'hd-description', 'hd-download'].includes(variant)) {
    if (work.medium !== 'image' || !(access.canDownload || access.reuse) || !media.source_url
      || variant === 'hd-download' && !access.canDownload) throw new WorkError('当前未获得此成品的原件权限', 403);
    const asset = media.asset_id ? await prisma.asset.findUnique({ where: { id: media.asset_id }, select: { mime_type: true, file_name: true } }) : null;
    // Work reads reuse published HD files. Existing background consumers own production.
    const headers = new Headers(request.headers); headers.set('X-Image-Read-Intent', 'status');
    response = await authorizedImageResponse(new Request(request, { headers }), media.source_url, variant as ImageVariant,
      asset?.mime_type || 'image/png', asset?.file_name || `${work.title}.png`);
  } else if (variant === 'thumbnail') {
    if (!media.thumbnail_url) throw new WorkError('封面仍在准备，成品记录已保留', 404);
    response = await storedPreview(request, media.thumbnail_url);
  } else if (variant === 'download') {
    if (!access.canDownload || !media.source_url) throw new WorkError('当前仅可预览成品，未获得原件下载权限', 403);
    const asset = media.asset_id ? await prisma.asset.findUnique({ where: { id: media.asset_id }, select: { mime_type: true, file_name: true } }) : null;
    response = work.medium === 'image' ? await authorizedImageResponse(request, media.source_url, 'download', asset?.mime_type || 'image/png', asset?.file_name || `${work.title}.png`)
      : await originalVideo(request, access);
    if (work.medium === 'video') response.headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${work.title.replace(/[\r\n]/g, '')}.mp4`).replace(/'/g, '%27')}`);
  } else if (work.medium === 'image') {
    if (variant === 'detail' && (access.canDownload || access.reuse) && media.source_url) {
      const asset = media.asset_id ? await prisma.asset.findUnique({ where: { id: media.asset_id }, select: { mime_type: true } }) : null;
      response = await authorizedImageResponse(request, media.source_url, 'original', asset?.mime_type || 'image/png');
    } else {
      if (!media.thumbnail_url) throw new WorkError('成品预览仍在准备', 409);
      response = await storedPreview(request, media.thumbnail_url);
    }
  } else if (variant === 'detail' && access.canDownload && media.source_url) response = await originalVideo(request, access);
  else if (media.preview_status === 'ready' && media.preview_url) response = await storedPreview(request, media.preview_url);
  else throw new WorkError('视频预览仍在后台准备，原作品已保留', 409);
  for (const [name, value] of Object.entries(workHeaders)) response.headers.set(name, value);
  response.headers.set('X-Work-Media-Version', media.id);
  return response;
}
