import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { Readable, Transform } from 'node:stream';
import { NextResponse } from 'next/server';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { isPrivateNetworkHost } from './public-url';

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

function deadline<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('media_request_aborted'));
    if (signal.aborted) { pending.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// Caller must authorize the stored resource first. Never accept a caller-supplied proxy URL.
export async function mediaPreviewResponse(request: Request, source: string, fallbackMime: string): Promise<NextResponse> {
  const local = siteUploadPathFromUrl(source) || (source.startsWith('/') && !source.startsWith('//') ? source.split(/[?#]/)[0] : null);
  const contentType = previewMime(source, fallbackMime);
  if (local) {
    const publicRoot = path.resolve(process.cwd(), 'public');
    const decoded = decodeURIComponent(local);
    const candidate = path.resolve(publicRoot, decoded.replace(/^\/+/, ''));
    if (!candidate.startsWith(`${publicRoot}${path.sep}`)) return mediaError('素材路径无效', 400);
    let file: string;
    try { file = await realpath(candidate); } catch { return mediaError('文件不存在', 404); }
    const roots = await Promise.all(['uploads', 'videos'].map(dir => realpath(path.join(publicRoot, dir)).catch(() => '')));
    if (!roots.some(root => root && file.startsWith(`${root}${path.sep}`))) return mediaError('素材路径无效', 400);
    const info = await stat(file);
    if (!info.isFile() || !info.size) return mediaError('文件不可用', 404);
    const rangeHeader = request.method === 'HEAD' ? null : request.headers.get('range');
    const range = rangeHeader ? parsePreviewRange(rangeHeader, info.size) : null;
    const headers = { ...privateHeaders, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' };
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

// Public-only transport: pinned DNS and every redirect are checked; no cookies or authorization are forwarded.
export function fetchPublicMedia(request: Request, source: string, fallbackMime: string) {
  return remotePreview(request, source, fallbackMime, AbortSignal.any([request.signal, AbortSignal.timeout(600000)]), 0);
}

async function remotePreview(request: Request, source: string, fallbackMime: string, signal: AbortSignal, redirects: number): Promise<NextResponse> {
  const url = new URL(source);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || isPrivateNetworkHost(url.hostname)) return mediaError('媒体地址不可用', 503);
  const addresses = await deadline(lookup(url.hostname, { all: true, family: 4 }), AbortSignal.any([signal, AbortSignal.timeout(10000)]));
  if (!addresses.length || addresses.some(({ address }) => isPrivateNetworkHost(address) || /^(0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|1(9[28])\.0\.0\.|198\.(18|19)\.|2(2[4-9]|[3-5]\d)\.)/.test(address))) return mediaError('媒体地址不可用', 503);
  signal.throwIfAborted();
  const range = request.method === 'HEAD' ? null : request.headers.get('range');
  if (range && (!/^bytes=(\d*)-(\d*)$/.test(range) || range.length > 80)) return mediaError('请求范围无效', 416);
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const upstream = client.request(url, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET', signal, family: 4,
      lookup: (_host, _options, callback) => callback(null, addresses[0].address, addresses[0].family),
      headers: { 'Accept-Encoding': 'identity', ...(range ? { Range: range } : {}) },
    }, response => {
      clearTimeout(headersTimer);
      const status = response.statusCode || 502;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.destroy();
        if (!location || redirects >= 3) { resolve(mediaError('媒体跳转失败', 502)); return; }
        let next: URL;
        try { next = new URL(location, url); } catch { resolve(mediaError('媒体地址不可用', 502)); return; }
        if (url.protocol === 'https:' && next.protocol !== 'https:') { resolve(mediaError('媒体跳转不安全', 502)); return; }
        resolve(remotePreview(request, next.href, fallbackMime, signal, redirects + 1));
        return;
      }
      const headers = new Headers(privateHeaders);
      if (status === 416) {
        const value = response.headers['content-range'];
        if (value && /^bytes \*\/\d+$/.test(value)) headers.set('Content-Range', value);
        response.destroy(); resolve(new NextResponse(null, { status, headers })); return;
      }
      if (status !== 200 && status !== 206) { response.destroy(); resolve(mediaError(status === 404 ? '媒体文件不存在' : '媒体暂时无法访问', status === 404 ? 404 : 502)); return; }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); resolve(mediaError('媒体编码响应无效', 502)); return; }
      const length = Number(response.headers['content-length']);
      if (length > MAX_REMOTE_BYTES) { response.destroy(); resolve(mediaError('媒体文件过大', 413)); return; }
      const mime = (response.headers['content-type'] || '').split(';')[0].trim();
      if (mime && !/^(image|video|audio)\//.test(mime) && mime !== 'application/octet-stream') { response.destroy(); resolve(mediaError('返回内容不是媒体文件', 502)); return; }
      headers.set('Content-Type', /^(image|video|audio)\/[\w.+-]+$/.test(mime) ? mime : fallbackMime);
      if (response.headers['content-length'] && Number.isSafeInteger(length) && length >= 0) headers.set('Content-Length', String(length));
      if (response.headers['accept-ranges'] === 'bytes') headers.set('Accept-Ranges', 'bytes');
      if (status === 206) {
        const contentRange = response.headers['content-range'];
        if (!contentRange || !/^bytes \d+-\d+\/\d+$/.test(contentRange)) { response.destroy(); resolve(mediaError('媒体分段响应无效', 502)); return; }
        headers.set('Content-Range', contentRange);
        headers.set('Accept-Ranges', 'bytes');
      }
      if (request.method === 'HEAD') { response.destroy(); resolve(new NextResponse(null, { status, headers })); return; }
      let received = 0;
      const limited = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        callback(received > MAX_REMOTE_BYTES ? new Error('media_size_limit') : null, chunk);
      } });
      response.setTimeout(60000, () => response.destroy(new Error('media_idle_timeout')));
      response.on('error', error => limited.destroy(error));
      limited.once('close', () => { response.destroy(); upstream.destroy(); });
      response.pipe(limited);
      resolve(new NextResponse(Readable.toWeb(limited) as ReadableStream<Uint8Array>, { status, headers }));
    });
    const headersTimer = setTimeout(() => upstream.destroy(new Error('media_headers_timeout')), 30000);
    upstream.once('error', reject);
    upstream.once('close', () => clearTimeout(headersTimer));
    upstream.end();
  });
}
