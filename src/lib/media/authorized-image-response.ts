import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readStudioDetail, readStudioPreview, readStudioThumbnail, statStudioDisplayImage } from '@/lib/image-studio/media';
import { mediaPreviewResponse } from './preview-response';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { hdDirectory, lookupHd, requestHd } from './hd-derivatives';
import { previewMime } from './preview-response';
import { imageEtagMatches, imageStatEtag, isImagePrefetch } from './image-validators';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';

export type ImageVariant = 'thumbnail' | 'preview' | 'detail' | 'original' | 'download' | 'hd' | 'hd-description' | 'hd-download';
export const privateImageHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };

function notPrepared() {
  return Response.json({ error: '图片尚未准备好，请直接打开查看' }, { status: 409, headers: privateImageHeaders });
}

function imageFileResponse(request: Request, file: string, headers: Headers, unchanged: boolean) {
  if (unchanged || request.method === 'HEAD') {
    if (unchanged) headers.delete('Content-Length');
    return new Response(null, { status: unchanged ? 304 : 200, headers });
  }
  request.signal.throwIfAborted();
  const stream = createReadStream(file);
  const abort = () => stream.destroy(new Error('media_request_aborted'));
  request.signal.addEventListener('abort', abort, { once: true });
  stream.once('close', () => request.signal.removeEventListener('abort', abort));
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers });
}

// The caller must finish its existing owner/source/download permission checks first.
export async function authorizedImageResponse(request: Request, source: string, variant: ImageVariant, mime: string, fileName?: string, started = performance.now()) {
  const prepared = performance.now();
  const readOnly = request.method === 'HEAD' || isImagePrefetch(request);
  let response: Response;
  if (['hd', 'hd-description', 'hd-download'].includes(variant)) {
    const job = readOnly ? await lookupHd(source) : await requestHd(source, new URL(request.url).searchParams.get('hd-priority') === 'recent' ? 2 : 1);
    const rawMime = previewMime(source, mime);
    if (variant === 'hd-description') {
      if (isImagePrefetch(request) && job?.status !== 'ready') return notPrepared();
      if (request.method === 'HEAD') return new Response(null, { headers: { ...privateImageHeaders, 'Content-Type': 'application/json' } });
      return Response.json({ policy: 'hd-f-v1', sourceVersion: job?.version || null,
        status: job?.status || 'skipped', reason: job?.reason || (!job ? 'remote_version_unknown' : null),
        ...(job?.status === 'ready' ? { width: job.width, height: job.height, bytes: job.bytes,
          format: job.format === 'original' ? rawMime.split('/')[1] : job.format,
          mime: job.format === 'original' ? rawMime : job.mime, original: job.format === 'original' } : {}) }, { headers: privateImageHeaders });
    }
    if (!job || job.status !== 'ready') return Response.json({ error: '高清图尚未准备好，可先查看或下载原图' }, { status: 409, headers: privateImageHeaders });
    const requestedVersion = new URL(request.url).searchParams.get('hd-version');
    if (requestedVersion && requestedVersion !== job.version) return Response.json({ error: '图片已更新，请重新打开' }, { status: 409, headers: privateImageHeaders });
    if (job.format === 'original') {
      if (variant === 'hd') response = await mediaPreviewResponse(request, source, rawMime, `protected-hd-original:${job.key}`);
      else {
      const etag = `"${job.key}"`;
      response = !request.headers.has('range') && imageEtagMatches(request.headers.get('if-none-match'), etag)
        ? new Response(null, { status: 304, headers: { ...privateImageHeaders, 'Content-Type': rawMime } }) : await mediaPreviewResponse(request, source, rawMime);
      response.headers.set('ETag', etag);
      }
    }
    else {
      if (!job.file || !/^[a-f0-9]{64}\.(avif|webp)$/.test(job.file)) throw new Error('invalid_hd_manifest');
      const file = path.join(hdDirectory(), job.file);
      const info = await fs.stat(file);
      if (info.size !== job.bytes) throw new Error('invalid_hd_file');
      const etag = variant === 'hd' ? imageStatEtag(info, `protected-hd:${job.key}`) : `"${job.key}"`;
      const unchanged = imageEtagMatches(request.headers.get('if-none-match'), etag);
      const headers = new Headers({ ...privateImageHeaders, 'Content-Type': job.mime!, ETag: etag, 'Content-Length': String(info.size) });
      response = imageFileResponse(request, file, headers, unchanged);
    }
    const extension = (job.format === 'original' ? rawMime.split('/')[1] : job.format) || 'image';
    response.headers.set('Content-Disposition', variant === 'hd-download'
      ? `attachment; filename*=UTF-8''${encodeURIComponent(`${(fileName || 'image').replace(/\.[^.]+$/, '').replace(/[\r\n]/g, '')}-hd.${extension}`).replace(/'/g, '%27')}` : 'inline');
    response.headers.set('X-Image-Source-Version', job.version);
  } else if (variant === 'original' || variant === 'download') {
    if (isImagePrefetch(request) && !siteUploadPathFromUrl(source) && !(source.startsWith('/') && !source.startsWith('//'))) return notPrepared();
    response = await mediaPreviewResponse(request, source, mime, variant === 'original' ? 'protected-inline-original-v1' : undefined);
    response.headers.set('Content-Disposition', variant === 'download'
      ? `attachment; filename*=UTF-8''${encodeURIComponent((fileName || 'image').replace(/[\r\n]/g, '')).replace(/'/g, '%27')}` : 'inline');
  } else {
    if (readOnly) {
      const meta = await statStudioDisplayImage(source, variant as 'thumbnail' | 'preview' | 'detail');
      if (!meta) return notPrepared();
      const headers = new Headers({ ...privateImageHeaders, ETag: meta.etag, 'X-Image-Source-Version': meta.etag,
        'Content-Type': 'image/webp', 'Content-Length': String(meta.size), 'Content-Disposition': 'inline' });
      response = imageFileResponse(request, meta.file, headers, imageEtagMatches(request.headers.get('if-none-match'), meta.etag));
    } else {
      const bytes = await (variant === 'thumbnail' ? readStudioThumbnail(source) : variant === 'detail' ? readStudioDetail(source) : readStudioPreview(source));
      const meta = await statStudioDisplayImage(source, variant as 'thumbnail' | 'preview' | 'detail');
      const etag = meta?.etag || `"${createHash('sha256').update(bytes).digest('hex')}"`;
      const headers = new Headers({ ...privateImageHeaders, ETag: etag, ...(meta ? { 'X-Image-Source-Version': meta.etag } : {}),
        'Content-Type': 'image/webp', 'Content-Length': String(meta?.size || bytes.length), 'Content-Disposition': 'inline' });
      const unchanged = imageEtagMatches(request.headers.get('if-none-match'), etag);
      response = meta ? imageFileResponse(request, meta.file, headers, unchanged) : new Response(unchanged ? null : new Uint8Array(bytes), { status: unchanged ? 304 : 200, headers });
      if (unchanged) response.headers.delete('Content-Length');
    }
  }
  response.headers.set('Server-Timing', `access;dur=${(prepared - started).toFixed(1)},media;dur=${(performance.now() - prepared).toFixed(1)}`);
  response.headers.set('X-Media-Request-Id', randomUUID());
  return response;
}
