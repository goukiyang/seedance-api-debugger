import { openUntrustedImage } from '@/lib/media/decode-image';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { safeFetch, SafeFetchError } from '@/lib/net/safe-fetch';
import { resolveInside } from '@/lib/fs/resolve-inside';
import type { Metadata } from 'sharp';
import { createHash, randomUUID } from 'node:crypto';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { MAX_STUDIO_GENERATED_BYTES } from './limits';
import { setTimeout as delay } from 'node:timers/promises';
import { imageStatEtag } from '@/lib/media/image-validators';
import { mediaRoot } from '@/lib/media/storage-roots';

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
  const bytes = await readStudioDisplayImage(url, 'thumbnail');
  // Only an authorized web read prepares follow-up displays; no worker or bulk prewarming.
  void readStudioPreview(url).catch(() => {});
  return bytes;
}

export async function readStudioPreview(url: string): Promise<Buffer> {
  return readStudioDisplayImage(url, 'preview');
}
export async function readStudioDetail(url: string): Promise<Buffer> { return readStudioDisplayImage(url, 'detail'); }

type StudioDisplayVariant = 'thumbnail' | 'preview' | 'detail';
async function studioDisplayLocation(url: string, variant: StudioDisplayVariant) {
  const size = variant === 'thumbnail' ? 640 : variant === 'preview' ? 1600 : 2048;
  const quality = variant === 'thumbnail' ? 78 : variant === 'preview' ? 70 : 75;
  let version = `remote-${Math.floor(Date.now() / 60000)}`;
  const local = siteUploadPathFromUrl(url);
  if (local) {
    const root = await fs.realpath(mediaRoot('uploads'));
    const file = await resolveInside(root, decodeURIComponent(local.slice('/uploads/'.length)));
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error('素材路径无效');
    const stat = await fs.stat(file);
    if (!stat.isFile() || !stat.size) throw new Error('图片文件不可用');
    version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  }
  const key = createHash('sha256').update(`webp-${size}-q${quality}-v2:${version}:${url}`).digest('hex');
  const directory = mediaRoot('display');
  const file = path.join(directory, `${key}.webp`);
  return { size, quality, directory, file, key };
}

// Metadata only: neither missing derivatives nor remote versions start preparation.
export async function statStudioDisplayImage(url: string, variant: StudioDisplayVariant) {
  if (!siteUploadPathFromUrl(url)) return null;
  const location = await studioDisplayLocation(url, variant);
  try {
    const root = await fs.realpath(location.directory);
    const file = await fs.realpath(location.file);
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error('display_boundary');
    const info = await fs.stat(file);
    if (!info.isFile() || !info.size) return null;
    return { file, size: info.size, etag: imageStatEtag(info, `studio-${variant}-${location.key}`) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export async function preparedStudioDisplayFile(url: string, variant: StudioDisplayVariant) {
  const location = await studioDisplayLocation(url, variant);
  const file = await fs.realpath(location.file);
  if (file !== location.file || !(await fs.stat(file)).isFile()) throw new Error('display_boundary');
  return file;
}

async function readStudioDisplayImage(url: string, variant: StudioDisplayVariant): Promise<Buffer> {
  const { size, quality, directory, file, key } = await studioDisplayLocation(url, variant);
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
      const bytes = await (await openUntrustedImage(original, 'ordinary', { animated: false }))
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
    const root = await fs.realpath(mediaRoot('uploads'));
    const file = await resolveInside(root, decodeURIComponent(local.slice('/uploads/'.length)));
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error('素材路径无效');
    const stat = await fs.stat(file);
    if (stat.size > MAX_STUDIO_GENERATED_BYTES || !stat.isFile()) throw new Error('图片文件过大');
    return fs.readFile(file);
  }
  const started = Date.now();
  const deadline = AbortSignal.timeout(180000);
  const downloadSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const metrics: StudioDownloadDiagnostics = { phase: 'dns', attempt: 1, redirects: 0, receivedBytes: 0, elapsedMs: 0 };
  for (let attempt = 0; ; attempt++) {
    metrics.attempt = attempt + 1;
    try { return await downloadStudioImage(url, downloadSignal, 0, metrics); }
    catch (error) {
      const failure = deadline.aborted ? new StudioImageDownloadError('download_total_timeout')
        : signal?.aborted ? new StudioImageDownloadError('download_aborted') : classifyStudioDownloadError(error);
      failure.diagnostics = { ...metrics, elapsedMs: Date.now() - started };
      if (attempt >= 1 || !failure.retryable || downloadSignal.aborted) throw failure;
      try { await delay(1000, undefined, { signal: downloadSignal }); }
      catch { throw new StudioImageDownloadError(deadline.aborted ? 'download_total_timeout' : 'download_aborted', undefined, false, failure.diagnostics); }
    }
  }
}

export type StudioDownloadDiagnostics = {
  phase: 'dns' | 'connect' | 'headers' | 'body';
  attempt: number; redirects: number; receivedBytes: number; expectedBytes?: number; elapsedMs: number; httpStatus?: number;
  host?: string;
};
export class StudioImageDownloadError extends Error {
  constructor(public code: string, public status?: number, public retryable = false, public diagnostics?: StudioDownloadDiagnostics) {
    super(code);
    this.name = 'StudioImageDownloadError';
  }
}

export function classifyStudioDownloadError(error: unknown): StudioImageDownloadError {
  if (error instanceof StudioImageDownloadError) return error;
  if (error instanceof SafeFetchError) return new StudioImageDownloadError(
    error.code === 'TOO_LARGE' ? 'download_size_limit' : error.code === 'ADDRESS_NOT_ALLOWED' ? 'download_unsafe_address'
      : error.code === 'TIMEOUT' ? error.phase === 'connect' ? 'download_connect_timeout'
        : error.phase === 'headers' ? 'download_headers_timeout' : error.phase === 'body' ? 'download_body_timeout' : 'download_total_timeout' : 'download_network_failed', undefined,
    error.code === 'TIMEOUT' || error.code === 'UPSTREAM_ERROR');
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ABORT_ERR') return new StudioImageDownloadError('download_aborted');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new StudioImageDownloadError('download_dns_failed', undefined, true);
  if (code === 'ETIMEDOUT') return new StudioImageDownloadError('download_timeout', undefined, true);
  if (code && /CERT|TLS|SSL/.test(code)) return new StudioImageDownloadError('download_tls_failed');
  return new StudioImageDownloadError('download_network_failed', undefined, true);
}

async function downloadStudioImage(url: string, signal: AbortSignal, redirects: number, metrics: StudioDownloadDiagnostics): Promise<Buffer> {
  const response = await openStudioImageStream(url, signal, metrics, {}, redirects);
  if (response.statusCode !== 200) { response.destroy(); throw new StudioImageDownloadError('download_http_error', response.statusCode); }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    metrics.receivedBytes = bytes;
    if (bytes > MAX_STUDIO_GENERATED_BYTES) { response.destroy(); throw new StudioImageDownloadError('download_size_limit', response.statusCode); }
    chunks.push(Buffer.from(chunk));
  }
  if (!response.complete || !bytes || (metrics.expectedBytes !== undefined && bytes !== metrics.expectedBytes)) throw new StudioImageDownloadError('download_incomplete', response.statusCode, true);
  return Buffer.concat(chunks);
}

// Shared SSRF boundary for memory reads and recoverable file downloads.
export async function openStudioImageStream(url: string, signal: AbortSignal, metrics: StudioDownloadDiagnostics,
  headers: Record<string, string> = {}, redirects = 0): Promise<import('node:http').IncomingMessage> {
  if (redirects !== 0 || !url.startsWith('https:')) throw new StudioImageDownloadError('download_unsafe_url');
  metrics.phase = 'dns'; metrics.redirects = 0; metrics.receivedBytes = 0;
  metrics.expectedBytes = undefined; metrics.httpStatus = undefined;
  try {
    // Paid 4K outputs retain their existing 96MB delivery ceiling; reference probes use 20MB.
    const response = await safeFetch(url, { headers, signal, maxBytes: MAX_STUDIO_GENERATED_BYTES,
      timeoutMs: 600_000, allowRedirects: true, addressIndex: metrics.attempt - 1, headersTimeoutMs: 60_000,
      onPhase: (phase, hops) => { metrics.phase = phase; metrics.redirects = hops; } });
    const status = response.status;
    metrics.httpStatus = status; metrics.phase = 'body';
    if (status !== 200 && status !== 206 && !(status === 416 && headers.Range)) {
      await response.body?.cancel();
      throw new StudioImageDownloadError('download_http_error', status, [408, 429, 500, 502, 503, 504].includes(status));
    }
    const length = response.headers.get('content-length');
    if (length !== null) metrics.expectedBytes = Number(length);
    // Keep the existing Node stream/status/header/complete contract for resumable delivery.
    const stream = (response.body ? Readable.fromWeb(response.body as import('node:stream/web').ReadableStream) : Readable.from([])) as import('node:http').IncomingMessage;
    stream.statusCode = status;
    stream.headers = Object.fromEntries(response.headers);
    stream.complete = !response.body;
    stream.once('end', () => { stream.complete = true; });
    return stream;
  } catch (error) {
    if (error instanceof SafeFetchError) {
      throw classifyStudioDownloadError(error);
    }
    throw error;
  }
}

export async function normalizeStudioImage(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('图片文件大小无效');
  const png = await (await openUntrustedImage(bytes, 'ordinary', { animated: false })).png().toBuffer();
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
export type StudioOutputRequirements = { format?: string; size?: string; transparent?: boolean };
export async function validateGeneratedStudioImage(bytes: Buffer, requirements: StudioOutputRequirements = {},
  recordValidation?: (validation: { originalFormat: string; storedFormat: string; width: number; height: number; requestedSize?: string; transparentPixels?: number }) => Promise<void>) {
  if (!bytes.length || bytes.length > MAX_STUDIO_GENERATED_BYTES) {
    throw new StudioImageDeliveryError('generated_input_size_limit', bytes.length);
  }
  let png: Buffer;
  let metadata: Metadata;
  try {
    metadata = await (await openUntrustedImage(bytes, 'ordinary', { animated: false })).metadata();
    if (!['png', 'jpeg', 'webp', 'avif', 'tiff'].includes(metadata.format || '') || (metadata.pages || 1) !== 1) throw new Error('Unsupported output');
    png = await (await openUntrustedImage(bytes, 'ordinary', { animated: false }))
      .timeout({ seconds: 45 })
      .png({ compressionLevel: 6 }).toBuffer();
  } catch {
    throw new StudioImageDeliveryError('generated_image_decode_failed', bytes.length);
  }
  if (png.length > MAX_STUDIO_GENERATED_BYTES) {
    throw new StudioImageDeliveryError('generated_png_size_limit', png.length);
  }
  const validation = { originalFormat: metadata.format!, storedFormat: 'png', width: metadata.width!, height: metadata.height!, requestedSize: requirements.size, transparentPixels: undefined as number | undefined };
  await recordValidation?.(validation);
  if (requirements.format && metadata.format !== requirements.format) throw new StudioImageDeliveryError('generated_format_mismatch', bytes.length);
  if (requirements.size && /^\d+x\d+$/.test(requirements.size)) {
    const [width, height] = requirements.size.split('x').map(Number);
    if (metadata.width !== width || metadata.height !== height) throw new StudioImageDeliveryError('generated_dimensions_mismatch', bytes.length);
  }
  if (requirements.transparent) {
    if (!metadata.hasAlpha) throw new StudioImageDeliveryError('generated_alpha_missing', bytes.length);
    const { data, info } = await (await openUntrustedImage(png, 'ordinary'))
      .timeout({ seconds: 45 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let transparentPixels = 0;
    for (let i = info.channels - 1; i < data.length; i += info.channels) if (data[i] < 255) transparentPixels++;
    validation.transparentPixels = transparentPixels;
    await recordValidation?.(validation);
    if (!transparentPixels) throw new StudioImageDeliveryError('generated_transparency_missing', bytes.length);
  }
  return { png, validation };
}
export async function normalizeGeneratedStudioImage(bytes: Buffer) { return (await validateGeneratedStudioImage(bytes)).png; }
