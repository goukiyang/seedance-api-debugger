import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import sharp from 'sharp';
import { createHash, randomUUID } from 'node:crypto';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { isPrivateNetworkHost } from '@/lib/media/public-url';
import { MAX_STUDIO_GENERATED_BYTES } from './limits';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_BYTES = 20 * 1024 * 1024;

export function studioAssetUrl(assetId: string, thumbnail = false) {
  return `/api/image-studio/assets/${encodeURIComponent(assetId)}${thumbnail ? '?thumbnail=1' : ''}`;
}

export function studioTemplateAssetUrl(assetId: string, thumbnail = false) {
  return `/api/image-studio/template-assets/${encodeURIComponent(assetId)}${thumbnail ? '?thumbnail=1' : ''}`;
}

const thumbnailJobs = new Map<string, Promise<Buffer>>();
let thumbnailActive = 0;
const thumbnailWaiters: Array<() => void> = [];

// Call only after the asset route has checked the current viewer's permissions.
export async function readStudioThumbnail(url: string): Promise<Buffer> {
  return readStudioDisplayImage(url, false);
}

export async function readStudioPreview(url: string): Promise<Buffer> {
  return readStudioDisplayImage(url, true);
}

async function readStudioDisplayImage(url: string, preview: boolean): Promise<Buffer> {
  const size = preview ? 2048 : 640;
  const quality = preview ? 88 : 78;
  const key = createHash('sha256').update(`${preview ? 'webp-2048-q88-v1' : 'webp-640-v1'}:${url}`).digest('hex');
  const directory = path.join(process.cwd(), 'storage', 'studio-thumbnails');
  const file = path.join(directory, `${key}.webp`);
  try { return await fs.readFile(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const pending = thumbnailJobs.get(key);
  if (pending) return pending;
  if (thumbnailJobs.size >= 32) throw new Error('缩略图处理中，请稍后重试');
  const job = (async () => {
    if (thumbnailActive >= 2) await new Promise<void>(resolve => thumbnailWaiters.push(resolve));
    else thumbnailActive += 1;
    try {
      const original = await readStudioImage(url);
      const bytes = await sharp(original, { limitInputPixels: 40_000_000, animated: false })
        .rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true }).webp({ quality }).toBuffer();
      await fs.mkdir(directory, { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, bytes); await fs.rename(temporary, file); }
      finally { await fs.unlink(temporary).catch(() => {}); }
      return bytes;
    } finally {
      const next = thumbnailWaiters.shift();
      if (next) next(); else thumbnailActive -= 1;
    }
  })();
  thumbnailJobs.set(key, job);
  try { return await job; } finally { thumbnailJobs.delete(key); }
}

export async function readStudioImage(url: string, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const local = siteUploadPathFromUrl(url);
  if (local) {
    const root = await fs.realpath(path.join(process.cwd(), 'public/uploads'));
    const file = await fs.realpath(path.resolve(process.cwd(), 'public', local.replace(/^\/+/, '')));
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error('素材路径无效');
    const stat = await fs.stat(file);
    if (stat.size > MAX_STUDIO_GENERATED_BYTES || !stat.isFile()) throw new Error('图片文件过大');
    return fs.readFile(file);
  }
  for (let attempt = 0; ; attempt++) {
    try { return await downloadStudioImage(url, signal, 0); }
    catch (error) {
      const failure = classifyStudioDownloadError(error);
      if (attempt >= 1 || !failure.retryable || signal?.aborted) throw failure;
      try { await delay(1000, undefined, { signal }); }
      catch { throw new StudioImageDownloadError('download_aborted'); }
    }
  }
}

export class StudioImageDownloadError extends Error {
  constructor(public code: string, public status?: number, public retryable = false) {
    super(code);
    this.name = 'StudioImageDownloadError';
  }
}

function classifyStudioDownloadError(error: unknown): StudioImageDownloadError {
  if (error instanceof StudioImageDownloadError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ABORT_ERR') return new StudioImageDownloadError('download_aborted');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new StudioImageDownloadError('download_dns_failed', undefined, true);
  if (code === 'ETIMEDOUT') return new StudioImageDownloadError('download_timeout', undefined, true);
  if (code && /CERT|TLS|SSL/.test(code)) return new StudioImageDownloadError('download_tls_failed');
  return new StudioImageDownloadError('download_network_failed', undefined, true);
}

async function downloadStudioImage(url: string, signal: AbortSignal | undefined, redirects: number): Promise<Buffer> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new StudioImageDownloadError('download_invalid_url'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || isPrivateNetworkHost(parsed.hostname)) throw new StudioImageDownloadError('download_unsafe_url');
  const addresses = await lookup(parsed.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some(entry => isPrivateNetworkHost(entry.address)
    || /^(0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|1(9[28])\.0\.0\.|198\.(18|19)\.|2(2[4-9]|[3-5]\d)\.)/.test(entry.address))) throw new StudioImageDownloadError('download_unsafe_address');
  // Pin the vetted address so DNS cannot change between validation and download.
  return new Promise((resolve, reject) => {
    const request = https.get(parsed, {
      // The vetted lookup returns one IPv4 address, not an auto-family address list.
      family: 4, signal,
      lookup: (_hostname, _options, callback) => callback(null, addresses[0].address, addresses[0].family),
    }, response => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.destroy();
        if (!location || redirects >= 3) { reject(new StudioImageDownloadError('download_redirect_limit', status)); return; }
        let next: string;
        try { next = new URL(location, parsed).href; }
        catch { reject(new StudioImageDownloadError('download_invalid_url')); return; }
        // Every hop is revalidated and DNS-pinned; never forward API credentials.
        resolve(downloadStudioImage(next, signal, redirects + 1));
        return;
      }
      if (status !== 200) { response.destroy(); reject(new StudioImageDownloadError('download_http_error', status, [408, 429, 500, 502, 503, 504].includes(status))); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_STUDIO_GENERATED_BYTES) request.destroy(new StudioImageDownloadError('download_size_limit'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        if (!response.complete || !bytes) reject(new StudioImageDownloadError('download_incomplete', status, true));
        else resolve(Buffer.concat(chunks));
      });
      response.on('aborted', () => reject(new StudioImageDownloadError('download_incomplete', status, true)));
      response.on('error', reject);
    });
    const timer = setTimeout(() => request.destroy(new StudioImageDownloadError('download_timeout', undefined, true)), 60000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
}

export async function normalizeStudioImage(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('图片文件大小无效');
  const png = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false }).png().toBuffer();
  if (png.length > MAX_BYTES) throw new Error('图片转换后超过 20MB，请压缩后重试');
  return png;
}

export class StudioImageDeliveryError extends Error {
  constructor(public code: string, public bytes: number) {
    super(code);
    this.name = 'StudioImageDeliveryError';
  }
}

// Generated 4K images must not inherit the reference-upload 20MB ceiling.
// Keep full resolution and lossless PNG; never silently downscale paid output.
export async function normalizeGeneratedStudioImage(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_STUDIO_GENERATED_BYTES) {
    throw new StudioImageDeliveryError('generated_input_size_limit', bytes.length);
  }
  let png: Buffer;
  try {
    png = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false })
      .png({ compressionLevel: 6 }).toBuffer();
  } catch {
    throw new StudioImageDeliveryError('generated_image_decode_failed', bytes.length);
  }
  if (png.length > MAX_STUDIO_GENERATED_BYTES) {
    throw new StudioImageDeliveryError('generated_png_size_limit', png.length);
  }
  return png;
}
