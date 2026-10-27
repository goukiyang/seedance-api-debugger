import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { safeFetch, SafeFetchError } from '@/lib/net/safe-fetch';
import { resolveInside } from '@/lib/fs/resolve-inside';
import { imageEtagMatches, imageStatEtag } from './image-validators';
import { mediaRoot } from './storage-roots';

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
const MAX_REMOTE_BYTES = 2 * 1024 * 1024 * 1024;
const mimeTypes: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg' };

export function previewMime(url: string, fallback: string) {
  let pathname = url.split(/[?#]/)[0];
  try { pathname = new URL(url).pathname; } catch {}
  return mimeTypes[path.extname(pathname).toLowerCase()] || (/^(image|video|audio)\/[\w.+-]+$/.test(fallback) ? fallback : 'application/octet-stream');
}

export function parsePreviewRange(value: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start || (!match[1] && Number(match[2]) <= 0)) return null;
  return { start, end };
}

function mediaError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: privateHeaders });
}

// Caller must authorize the stored resource first. Never accept a caller-supplied proxy URL.
export async function mediaPreviewResponse(request: Request, source: string, fallbackMime: string, inlineImagePolicy?: string): Promise<NextResponse> {
  const local = siteUploadPathFromUrl(source) || (source.startsWith('/') && !source.startsWith('//') ? source.split(/[?#]/)[0] : null);
  const contentType = previewMime(source, fallbackMime);
  if (local) {
    let file: string;
    try {
      const decoded = decodeURIComponent(local);
      const match = /^\/(uploads|videos)\/(.+)$/.exec(decoded);
      if (!match) return mediaError('素材路径无效', 400);
      file = await resolveInside(mediaRoot(match[1] as 'uploads' | 'videos'), match[2]);
    } catch { return mediaError('文件不存在或路径无效', 404); }
    const info = await stat(file);
    if (!info.isFile() || !info.size) return mediaError('文件不可用', 404);
    const imageHeaders = inlineImagePolicy && contentType.startsWith('image/')
      ? { ETag: imageStatEtag(info, inlineImagePolicy), 'X-Image-Source-Version': imageStatEtag(info, inlineImagePolicy) } : undefined;
    // Weak image validators do not participate in the existing Range/If-Range contract.
    if (imageHeaders && !request.headers.has('range') && imageEtagMatches(request.headers.get('if-none-match'), imageHeaders.ETag)) {
      return new NextResponse(null, { status: 304, headers: { ...privateHeaders, ...imageHeaders, 'Content-Type': contentType } });
    }
    const rangeHeader = request.method === 'HEAD' ? null : request.headers.get('range');
    const range = rangeHeader ? parsePreviewRange(rangeHeader, info.size) : null;
    const headers = { ...privateHeaders, ...imageHeaders, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' };
    if (rangeHeader && !range) return new NextResponse(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${info.size}` } });
    const responseHeaders = { ...headers, 'Content-Length': String(range ? range.end - range.start + 1 : info.size), ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${info.size}` } : {}) };
    if (request.method === 'HEAD') return new NextResponse(null, { headers: responseHeaders });
    request.signal.throwIfAborted();
    const stream = createReadStream(file, range || undefined);
    const abort = () => stream.destroy(new Error('media_request_aborted'));
    request.signal.addEventListener('abort', abort, { once: true });
    stream.once('close', () => request.signal.removeEventListener('abort', abort));
    return new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers: responseHeaders });
  }
  return fetchPublicMedia(request, source, contentType);
}

// Public-only transport; authorization remains the caller's responsibility.
export async function fetchPublicMedia(request: Request, source: string, fallbackMime: string): Promise<NextResponse> {
  const range = request.method === 'HEAD' ? null : request.headers.get('range');
  if (range && (!/^bytes=(\d*)-(\d*)$/.test(range) || range.length > 80)) return mediaError('请求范围无效', 416);
  try {
    const response = await safeFetch(source, { method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: range ? { Range: range } : {}, maxBytes: MAX_REMOTE_BYTES, timeoutMs: 600_000, allowRedirects: true, signal: request.signal });
    const status = response.status;
    const headers = new Headers(privateHeaders);
    if (status === 416) {
      const contentRange = response.headers.get('content-range');
      if (contentRange && /^bytes \*\/\d+$/.test(contentRange)) headers.set('Content-Range', contentRange);
      return new NextResponse(null, { status, headers });
    }
    if (status !== 200 && status !== 206) return mediaError(status === 404 ? '媒体文件不存在' : '媒体暂时无法访问', status === 404 ? 404 : 502);
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim();
    if (mime && !/^(image|video|audio)\//.test(mime) && mime !== 'application/octet-stream') {
      await response.body?.cancel(); return mediaError('返回内容不是媒体文件', 502);
    }
    headers.set('Content-Type', /^(image|video|audio)\/[\w.+-]+$/.test(mime) ? mime : fallbackMime);
    for (const name of ['content-length', 'accept-ranges']) {
      const value = response.headers.get(name); if (value) headers.set(name, value);
    }
    if (status === 206) {
      const contentRange = response.headers.get('content-range');
      if (!contentRange || !/^bytes \d+-\d+\/\d+$/.test(contentRange)) { await response.body?.cancel(); return mediaError('媒体分段响应无效', 502); }
      headers.set('Content-Range', contentRange); headers.set('Accept-Ranges', 'bytes');
    }
    return new NextResponse(response.body, { status, headers });
  } catch (error) {
    if (error instanceof SafeFetchError && error.code === 'TOO_LARGE') return mediaError('媒体文件过大', 413);
    if (error instanceof SafeFetchError && error.code === 'ADDRESS_NOT_ALLOWED') return mediaError('媒体地址不可用', 503);
    return mediaError('媒体暂时无法访问', 502);
  }
}
