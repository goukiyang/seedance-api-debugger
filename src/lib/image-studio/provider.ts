import { IMAGE_STUDIO_MODELS } from './settings';
import { readStudioImage, StudioImageDownloadError, type StudioDownloadDiagnostics } from './media';
import { MAX_REFERENCE_IMAGES, MAX_STUDIO_GENERATED_BASE64, MAX_STUDIO_GENERATED_BYTES } from './limits';
import { isGeminiImageModel, isValidImageDimension } from '@/lib/image-generation/resolution';
import type { ImageGenerationChannelProtocol } from '@/lib/integrations/image-generation-channel';
import { isPrivateNetworkHost } from '@/lib/media/public-url';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import https from 'node:https';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

function unsafeAddress(value: string) {
  return isPrivateNetworkHost(value) || /^(0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|1(9[28])\.0\.0\.|198\.(18|19)\.|2(2[4-9]|[3-5]\d)\.)/.test(value);
}
async function vettedApiUrl(value: string, signal: AbortSignal) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || unsafeAddress(url.hostname)) throw new Error('unsafe_api_url');
  const combined = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    const abort = () => reject(new Error('api_dns_timeout'));
    if (combined.aborted) { abort(); return; }
    combined.addEventListener('abort', abort, { once: true });
    lookup(url.hostname, { all: true, family: 4 }).then(resolve, reject).finally(() => combined.removeEventListener('abort', abort));
  });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(address => unsafeAddress(address.address))) throw new Error('unsafe_api_address');
  return { url, address: addresses[0] };
}
/** DNS only: no supplier HTTP request or credential is sent during configuration validation. */
export async function validateStudioProviderApiBaseUrl(value: string): Promise<{ ok: true; url: string } | { ok: false; code: string }> {
  try { const result = await vettedApiUrl(value, AbortSignal.timeout(10000)); return { ok: true, url: result.url.href.replace(/\/$/, '') }; }
  catch { return { ok: false, code: 'image_channel_unsafe_api_url' }; }
}
async function fetchPinnedApi(url: URL, init: RequestInit): Promise<Response> {
  const signal = init.signal || AbortSignal.timeout(300000);
  const vetted = await vettedApiUrl(url.href.replace(/\?.*$/, ''), signal);
  // A query is allowed only on a URL built here, never on an administrator-supplied API base.
  if (vetted.url.origin !== url.origin) throw new Error('api_origin_changed');
  const request = new Request(url, init);
  const bytes = init.body == null ? undefined : Buffer.from(await request.arrayBuffer());
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const upstream = https.request(url, { method: init.method || 'GET', headers: Object.fromEntries(request.headers),
      signal, family: 4, lookup: (_hostname, _options, callback) => callback(null, vetted.address.address, vetted.address.family) }, response => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach(item => headers.append(key, item)); else if (value !== undefined) headers.set(key, value);
      }
      const status = response.statusCode || 502;
      if ([204, 205, 304].includes(status)) { response.resume(); resolve(new Response(null, { status, headers })); }
      else resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers }));
    });
    upstream.once('error', reject);
    upstream.end(bytes);
  });
}
async function boundedJson(response: Response, maximum: number) {
  if (!response.body) throw new StudioProviderError('response', 'empty_response', response.status);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
      if (size > maximum) throw new Error('oversize'); chunks.push(next.value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new StudioProviderError('response', 'invalid_or_oversize_response', response.status); }
  finally { await reader.cancel().catch(() => {}); }
}

export type StudioImageInput = { bytes: Uint8Array; mimeType: string };
function safeUsage(value: unknown, depth = 0): unknown {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return null;
  return Object.fromEntries(Object.entries(value).slice(0, 40).flatMap(([key, item]) => {
    if (!/^[a-zA-Z_]{1,60}$/.test(key)) return [];
    const safe = safeUsage(item, depth + 1);
    return safe === null ? [] : [[key, safe]];
  }));
}

const GEMINI_IMAGE_MODELS = new Set([
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
]);
function boundedPollDelay(value: unknown) {
  return Math.min(30000, Math.max(2000, typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 2000));
}

export class StudioProviderError extends Error {
  constructor(public stage: 'request' | 'response' | 'download', public code: string, public status?: number, public diagnostics?: StudioDownloadDiagnostics, public retryable = false) {
    super(`图片服务处理失败（${code}）`);
    this.name = 'StudioProviderError';
  }
}

// Keep GPT image requests isolated from the existing Gemini/Seedream adapters.
export async function requestStudioImages(params: {
  baseUrl: string; apiKey: string; model: string; prompt: string;
  upstreamModel?: string;
  provider?: 'musk' | 'ai_media_vip';
  protocol?: ImageGenerationChannelProtocol;
  idempotencyKey?: string;
  resumeAsync?: { taskId: string; pollAfterMs?: number; expiresAt?: string };
  onAsyncAccepted?: (receipt: { taskId: string; pollAfterMs?: number; expiresAt?: string }) => Promise<void>;
  quality?: string;
  count: number; images: StudioImageInput[]; signal: AbortSignal; ratio?: string;
  downloadSignal?: AbortSignal;
  deliverRemoteImage?: (url: string, usage: unknown) => Promise<Buffer>;
  persistBase64Image?: (value: string, usage: unknown) => Promise<void>;
  recordResponse?: (response: Response) => Promise<void>;
  size?: string;
  allowFourToOne?: boolean;
}, fetcher: typeof fetch = fetch, readImage: typeof readStudioImage = readStudioImage): Promise<{ images: string[]; usage: unknown }> {
  if (!IMAGE_STUDIO_MODELS.includes(params.model as typeof IMAGE_STUDIO_MODELS[number])) throw new Error('不支持的图片模型');
  if (params.upstreamModel !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(params.upstreamModel)) throw new Error('供应商型号名称无效');
  if (!Number.isInteger(params.count) || params.count < 1 || params.count > 8) throw new Error('生成张数必须为 1 到 8');
  if (params.images.length > MAX_REFERENCE_IMAGES) throw new Error(`最多使用 ${MAX_REFERENCE_IMAGES} 张参考图`);
  const allowFourToOne = params.allowFourToOne === true && params.protocol === 'openai_images';
  if (params.size && params.protocol !== 'gemini_native' && (params.protocol === 'openai_images' || !isGeminiImageModel(params.model) || params.provider === 'ai_media_vip') && !isValidImageDimension(params.size, allowFourToOne)) {
    throw new Error('生成尺寸无效');
  }
  const transport: typeof fetch = params.protocol && fetcher === fetch ? fetchPinnedApi as typeof fetch : fetcher;
  if (params.protocol === 'gemini_native' || !params.protocol && params.provider !== 'ai_media_vip' && GEMINI_IMAGE_MODELS.has(params.model)) {
    if (params.resumeAsync) throw new StudioProviderError('request', 'gemini_async_not_supported');
    return requestGeminiStudioImages(params, transport);
  }
  const url = new URL(params.baseUrl);
  const basePath = url.pathname.replace(/\/$/, '').replace(/\/v1(?:\/images\/(?:generations|edits))?$/, '');
  url.pathname = `${basePath}/v1/images/${params.images.length ? 'edits' : 'generations'}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${params.apiKey}` };
  if (params.idempotencyKey) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(params.idempotencyKey)) throw new StudioProviderError('request', 'invalid_idempotency_key');
    headers['Idempotency-Key'] = params.idempotencyKey;
  }
  let body: BodyInit;
  if (params.images.length) {
    const form = new FormData();
    form.set('model', params.upstreamModel || params.model);
    form.set('prompt', params.prompt);
    form.set('n', String(params.count));
    form.set('output_format', 'png');
    if (params.quality && params.quality !== 'auto') form.set('quality', params.quality);
    if (params.size) form.set('size', params.size);
    if (allowFourToOne && params.ratio === '4:1') form.set('ratio', params.ratio);
    params.images.forEach((image, index) => {
      form.append('image[]', new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), `reference-${index + 1}.${image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType === 'image/webp' ? 'webp' : 'png'}`);
    });
    body = form;
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ model: params.upstreamModel || params.model, prompt: params.prompt, n: params.count, output_format: 'png', ...(params.size ? { size: params.size } : {}),
      ...(allowFourToOne && params.ratio === '4:1' ? { ratio: params.ratio } : {}), ...(params.quality && params.quality !== 'auto' ? { quality: params.quality } : {}) });
  }
  let value: any;
  let response: Response | undefined;
  let asyncTask = params.resumeAsync;
  if (!asyncTask) {
    try { response = await transport(url, { method: 'POST', headers, body, signal: params.signal, redirect: params.protocol ? 'error' : 'follow' }); }
    catch { throw new StudioProviderError('request', params.signal.aborted ? 'timeout' : 'network'); }
    await params.recordResponse?.(response);
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new StudioProviderError('request', 'http_error', response.status); }
    value = await boundedJson(response, params.count * MAX_STUDIO_GENERATED_BASE64 + 1024 * 1024);
    if (response.status === 202) {
      const taskId = value.task_id || value.id;
      if (typeof taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,180}$/.test(taskId)) throw new StudioProviderError('response', 'async_receipt_invalid', 202);
      if (!params.onAsyncAccepted) throw new StudioProviderError('response', 'async_receipt_storage_required', 202);
      asyncTask = { taskId, pollAfterMs: boundedPollDelay(value.poll_after_ms),
        ...(typeof value.expires_at === 'string' && Number.isFinite(Date.parse(value.expires_at)) ? { expiresAt: value.expires_at } : {}) };
      // Save the exact task identity before any query or outcome interpretation.
      await params.onAsyncAccepted(asyncTask);
    }
  }
  if (asyncTask) {
    if (!/^[a-zA-Z0-9_-]{1,180}$/.test(asyncTask.taskId)) throw new StudioProviderError('response', 'async_receipt_invalid');
    const pollUrl = new URL(url); pollUrl.pathname = `${basePath}/v1/images/tasks/${encodeURIComponent(asyncTask.taskId)}`; pollUrl.search = '?view=summary';
    const queryDeadline = AbortSignal.timeout(60000);
    const querySignal = AbortSignal.any([params.signal, queryDeadline]);
    let pollDelay = boundedPollDelay(asyncTask.pollAfterMs);
    let lastObservation: 'pending' | 'interrupted' | 'unconfirmed' = 'interrupted';
    let readingQuery = false;
    for (;;) {
      try {
        await delay(pollDelay, undefined, { signal: querySignal });
        readingQuery = true;
        const polled = await transport(pollUrl, { method: 'GET', headers: { Authorization: `Bearer ${params.apiKey}` }, signal: querySignal, redirect: 'error' });
        if (!polled.ok) { lastObservation = 'interrupted'; readingQuery = false; await polled.body?.cancel().catch(() => {}); pollDelay = Math.min(10000, Math.max(5000, pollDelay * 2)); continue; }
        const task = await boundedJson(polled, 1024 * 1024);
        if ((task.task_id || task.id) && (task.task_id || task.id) !== asyncTask.taskId) throw new StudioProviderError('response', 'async_task_identity_conflict');
        if (task.status === 'failed') throw new StudioProviderError('response', 'async_failed', polled.status);
        if (['uncertain', 'client_disconnected', 'paused', 'canceled'].includes(task.status)) throw new StudioProviderError('response', 'async_unconfirmed', polled.status);
        if (task.status !== 'success') {
          lastObservation = ['pending', 'queued', 'running', 'processing'].includes(task.status) ? 'pending' : 'unconfirmed';
          readingQuery = false; pollDelay = boundedPollDelay(task.poll_after_ms); continue;
        }
        const assets = Array.isArray(task.assets) ? task.assets : [];
        if (assets.length) {
          value = { data: assets.map((asset: any) => {
            if (typeof asset.signed_url === 'string' && asset.signed_url) return { url: asset.signed_url };
            const authenticatedUrl = asset.download_url || asset.url;
            return { url: authenticatedUrl, authenticatedAsset: true, expiresAt: task.expires_at || asyncTask!.expiresAt };
          }), usage: task.usage };
        } else {
          // Only after success: the raw result is not a polling endpoint.
          const resultUrl = new URL(pollUrl); resultUrl.search = '';
          const result = await transport(resultUrl, { method: 'GET', headers: { Authorization: `Bearer ${params.apiKey}` }, signal: querySignal, redirect: 'error' });
          if (!result.ok) { await result.body?.cancel().catch(() => {}); throw new StudioProviderError('response', 'async_query_interrupted', result.status, undefined, true); }
          value = await boundedJson(result, params.count * MAX_STUDIO_GENERATED_BASE64 + 1024 * 1024);
        }
        break;
      } catch (error) {
        if (error instanceof StudioProviderError && ['async_failed', 'async_unconfirmed', 'async_task_identity_conflict'].includes(error.code)) throw error;
        if (querySignal.aborted) throw new StudioProviderError('response', readingQuery || params.signal.aborted || lastObservation === 'interrupted' ? 'async_query_interrupted' : lastObservation === 'pending' ? 'async_pending' : 'async_query_unconfirmed', undefined, undefined, true);
        lastObservation = 'interrupted'; readingQuery = false;
        pollDelay = Math.min(10000, Math.max(5000, pollDelay * 2));
      }
    }
  }
  if (!Array.isArray(value?.data) || !value.data.length) throw new StudioProviderError('response', 'empty_output', response?.status);
  if (value.data.length > params.count) throw new StudioProviderError('response', 'unexpected_count', response?.status);
  const usage = safeUsage(value.usage);
  const images: string[] = [];
  for (const item of value.data) {
    if (typeof item?.b64_json === 'string' && item.b64_json.length) {
      if (item.b64_json.length > MAX_STUDIO_GENERATED_BASE64) throw new StudioProviderError('response', 'image_too_large', response?.status);
      await params.persistBase64Image?.(item.b64_json, usage);
      images.push(item.b64_json);
    } else if (typeof item?.url === 'string' && item.url.length) {
      try {
        if (new URL(item.url, item.authenticatedAsset ? url : undefined).protocol !== 'https:') throw new StudioImageDownloadError('download_unsafe_url');
        if (item.authenticatedAsset) {
          const assetUrl = new URL(item.url, url);
          if (assetUrl.origin !== url.origin || assetUrl.username || assetUrl.password || !item.expiresAt
            || !Number.isFinite(Date.parse(item.expiresAt)) || Date.parse(item.expiresAt) <= Date.now()) throw new StudioImageDownloadError('download_unsafe_url');
          const downloaded = await transport(assetUrl, { method: 'GET', headers: { Authorization: `Bearer ${params.apiKey}` }, signal: params.downloadSignal || params.signal, redirect: 'error' });
          if (!downloaded.ok || !downloaded.body) { await downloaded.body?.cancel().catch(() => {}); throw new StudioImageDownloadError('download_http_error', downloaded.status); }
          const chunks: Uint8Array[] = []; let length = 0; const reader = downloaded.body.getReader();
          try { for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength;
            if (length > MAX_STUDIO_GENERATED_BYTES) throw new StudioImageDownloadError('download_size_limit'); chunks.push(next.value); } }
          finally { await reader.cancel().catch(() => {}); }
          const encoded = Buffer.concat(chunks).toString('base64'); await params.persistBase64Image?.(encoded, usage); images.push(encoded);
        } else images.push((await (params.deliverRemoteImage ? params.deliverRemoteImage(item.url, usage)
          : readImage(item.url, params.downloadSignal || params.signal))).toString('base64'));
      } catch (error) {
        throw new StudioProviderError('download', error instanceof StudioImageDownloadError ? error.code : 'download_invalid_or_unreadable', error instanceof StudioImageDownloadError ? error.status : undefined, error instanceof StudioImageDownloadError ? error.diagnostics : undefined, error instanceof StudioImageDownloadError && error.retryable);
      }
    } else {
      throw new StudioProviderError('response', 'unsupported_output', response?.status);
    }
  }
  return { images, usage };
}

async function requestGeminiStudioImages(params: {
  baseUrl: string; apiKey: string; model: string; prompt: string;
  upstreamModel?: string;
  count: number; images: StudioImageInput[]; signal: AbortSignal; ratio?: string; size?: string;
  recordResponse?: (response: Response) => Promise<void>;
  protocol?: ImageGenerationChannelProtocol;
}, fetcher: typeof fetch): Promise<{ images: string[]; usage: unknown }> {
  const url = new URL(params.baseUrl);
  const basePath = url.pathname.replace(/\/$/, '').replace(/\/v1$/, '').replace(/\/v1beta$/, '');
  url.pathname = `${basePath}/v1beta/models/${encodeURIComponent(params.upstreamModel || params.model)}:generateContent`;
  const parts: Array<Record<string, unknown>> = [{ text: params.prompt }];
  for (const image of params.images) {
    parts.push({ inlineData: { mimeType: image.mimeType, data: Buffer.from(image.bytes).toString('base64') } });
  }
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${params.apiKey}` },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: {
            ...(params.ratio ? { aspectRatio: params.ratio } : {}),
            ...(params.size ? { imageSize: params.size } : {}),
          },
        },
      }),
      signal: params.signal,
      redirect: params.protocol ? 'error' : 'follow',
    });
  } catch {
    throw new StudioProviderError('request', params.signal.aborted ? 'timeout' : 'network');
  }
  await params.recordResponse?.(response);
  const value = await boundedJson(response, params.count * MAX_STUDIO_GENERATED_BASE64 + 1024 * 1024);
  if (!response.ok) throw new StudioProviderError('request', 'http_error', response.status);
  const images = (value?.candidates || []).flatMap((candidate: { content?: { parts?: Array<Record<string, unknown>> } }) => candidate.content?.parts || [])
    .map((part: Record<string, unknown>) => {
      const inline = (part.inlineData || part.inline_data) as { data?: unknown } | undefined;
      return typeof inline?.data === 'string' ? inline.data : null;
    })
    .filter((image: unknown): image is string => typeof image === 'string' && image.length > 0);
  if (!images.length) throw new StudioProviderError('response', 'empty_output', response.status);
  if (images.length !== params.count) throw new StudioProviderError('response', 'unexpected_count', response.status);
  return { images: images.slice(0, params.count), usage: safeUsage(value.usageMetadata || value.usage) };
}
