import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readStudioDetail, readStudioPreview, readStudioThumbnail, statStudioDisplayImage } from '@/lib/image-studio/media';
import { mediaPreviewResponse } from './preview-response';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { hdControl, hdDirectory, hdRepresentationVersion, lookupHd, requestHd, type HdRequestContext } from './hd-derivatives';
import { hdEncoderStrategy } from './hd-encoder';
import { previewMime } from './preview-response';
import { imageEtagMatches, imageStatEtag, isImagePrefetch } from './image-validators';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { comparisonOriginalVersion } from './image-comparison-version';
import { COMPARISON_VERSION_HEADER, COMPARISON_VERSION_PARAM, validComparisonVersion } from './image-comparison-contract';

export type ImageVariant = 'thumbnail' | 'preview' | 'detail' | 'original' | 'download' | 'hd' | 'hd-description' | 'hd-download';
export const privateImageHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };

/** A denied authenticated open can only remove its own page interest. */
export async function discardHdViewingInterest(request: Request, requesterId: string) {
  if (request.method === 'HEAD' || isImagePrefetch(request) || request.headers.get('x-image-read-intent') === 'status') return;
  const token = request.headers.get('x-image-view-token');
  if (!token || !/^[a-f0-9-]{36}$/.test(token)) return;
  // Permission rejection remains the response even when scheduler storage is
  // unavailable. The bounded interest also expires without an exit request.
  await (await import('./hd-scheduler')).removeHdViewingToken(requesterId, token).catch(() => {});
}

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
export async function authorizedImageResponse(request: Request, source: string, variant: ImageVariant, mime: string, fileName?: string, started = performance.now(), context?: HdRequestContext) {
  const prepared = performance.now();
  const statusOnly = request.headers.get('x-image-read-intent') === 'status';
  const readOnly = request.method === 'HEAD' || isImagePrefetch(request) || statusOnly;
  const expectedComparison = new URL(request.url).searchParams.get(COMPARISON_VERSION_PARAM);
  const checkComparison = Boolean(expectedComparison && ['original', 'download', 'hd', 'hd-description', 'hd-download'].includes(variant));
  let comparisonVersion: string | null = null;
  if (checkComparison) {
    comparisonVersion = await comparisonOriginalVersion(source);
    if (!validComparisonVersion(expectedComparison) || !comparisonVersion) return Response.json({ error: '暂时无法核对原图版本，请重试读取' }, { status: 503, headers: privateImageHeaders });
    if (comparisonVersion !== expectedComparison) return Response.json({ error: '原图版本已变化，请主动选择当前图片' }, { status: 409, headers: privateImageHeaders });
  }
  let response: Response;
  if (['hd', 'hd-description', 'hd-download'].includes(variant)) {
    const token = request.headers.get('x-image-view-token');
    const viewToken = token && /^[a-f0-9-]{36}$/.test(token) ? token : undefined;
    const job = readOnly ? await lookupHd(source) : await requestHd(source, 1, undefined, undefined,
      context ? { ...context, viewToken } : undefined);
    const rawMime = previewMime(source, mime);
    if (variant === 'hd-description') {
      if (isImagePrefetch(request) && job?.status !== 'ready') return notPrepared();
      if (request.method === 'HEAD') return new Response(null, { headers: { ...privateImageHeaders, 'Content-Type': 'application/json' } });
      let processingAvailability = await hdControl().then(value => value.state).catch(() => 'unknown');
      const schedulingKnown = !job || !['queued', 'running'].includes(job.status) || await (await import('./hd-scheduler'))
        .readHdScheduler().then(value => Boolean(value.entries[job.key])).catch(() => false);
      if (!schedulingKnown && processingAvailability === 'active') processingAvailability = 'unknown';
      const stages = ['queued', 'reading', 'encoding', 'validating', 'publishing'];
      const errors = ['source_missing', 'source_unreadable', 'source_changed', 'source_incompatible', 'temporary_io', 'encode_timeout',
        'output_integrity', 'published_integrity', 'worker_integrity_failure', 'hd_child_exit_unknown', 'capacity_guard', 'retry_limit', 'original_smaller',
        'existing_webp', 'multi_frame', 'pixel_limit', 'high_bit_depth', 'wide_gamut', 'unverified_color_profile'];
      const representationVersion = job?.status === 'ready' ? await hdRepresentationVersion(source, job) : undefined;
      return Response.json({ policy: 'hd-f-v1', sourceVersion: job?.version || null,
        status: job?.status || 'skipped', reason: !job ? 'not_registered' : errors.includes(job.reason || '') ? job.reason : null,
        processingAvailability, ...(job?.stage && stages.includes(job.stage) ? { stage: job.stage } : {}),
        ...(job?.retryAt ? { retryAt: job.retryAt } : {}), ...(!schedulingKnown ? { errorKind: 'scheduling_unconfirmed' }
          : job?.errorKind && errors.includes(job.errorKind) ? { errorKind: job.errorKind } : {}),
        ...(job ? { encodingStrategy: hdEncoderStrategy(job.encoderStrategy) } : {}), ...(representationVersion ? { representationVersion } : {}),
        ...(job?.status === 'ready' ? { width: job.width, height: job.height, bytes: job.bytes,
          format: job.format === 'original' ? rawMime.split('/')[1] : job.format,
          mime: job.format === 'original' ? rawMime : job.mime, original: job.format === 'original' } : {}) }, { headers: privateImageHeaders });
    }
    if (!job || job.status !== 'ready') return Response.json({ error: '高清图尚未准备好，可先查看或下载原图' }, { status: 409, headers: privateImageHeaders });
    const requestedVersion = new URL(request.url).searchParams.get('hd-version');
    if (requestedVersion && requestedVersion !== job.version) return Response.json({ error: '图片已更新，请重新打开' }, { status: 409, headers: privateImageHeaders });
    const representationVersion = await hdRepresentationVersion(source, job);
    const requestedRepresentation = new URL(request.url).searchParams.get('hd-representation');
    if (requestedRepresentation && requestedRepresentation !== representationVersion) return Response.json({ error: '图片副本已更新，请重新打开' }, { status: 409, headers: privateImageHeaders });
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
    if (representationVersion) response.headers.set('X-Image-Representation-Version', representationVersion);
  } else if (variant === 'original' || variant === 'download') {
    if (isImagePrefetch(request)) return notPrepared();
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
  if (checkComparison) {
    const after = await comparisonOriginalVersion(source);
    if (!after || after !== comparisonVersion) {
      void response.body?.cancel().catch(() => {});
      return Response.json({ error: after ? '原图版本已变化，请主动选择当前图片' : '暂时无法核对原图版本，请重试读取' },
        { status: after ? 409 : 503, headers: privateImageHeaders });
    }
    response.headers.set(COMPARISON_VERSION_HEADER, after);
  }
  response.headers.set('Server-Timing', `access;dur=${(prepared - started).toFixed(1)},media;dur=${(performance.now() - prepared).toFixed(1)}`);
  response.headers.set('X-Media-Request-Id', randomUUID());
  return response;
}
