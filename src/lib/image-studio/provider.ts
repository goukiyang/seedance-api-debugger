import { IMAGE_STUDIO_MODELS } from './settings';
import { readStudioImage, StudioImageDownloadError, type StudioDownloadDiagnostics } from './media';
import { MAX_REFERENCE_IMAGES, MAX_STUDIO_GENERATED_BASE64, MAX_STUDIO_GENERATED_BYTES } from './limits';
import { assertImageResolutionSupported, isGeminiImageModel, isValidImageDimension } from '@/lib/image-generation/resolution';
import { normalizeStudioRatio } from './ratios';
import type { ImageGenerationChannelProtocol } from '@/lib/integrations/image-generation-channel';
import { isPrivateNetworkHost } from '@/lib/media/public-url';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import https from 'node:https';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { buildStudioResponseDiagnostics, collectStudioResponseOutputCandidates, type StudioResponseDiagnostics,
  type StudioResponseOutputCandidate, type StudioResponseObservation } from './response-diagnostics';
import { buildStudioProviderErrorEvent, providerErrorObject, sanitizeStudioProviderErrorRequest, studioProviderErrorEventKey,
  type StudioProviderErrorObservation, type StudioProviderErrorRequest, type StudioProviderErrorPhase,
  type StudioProviderErrorEvent } from './provider-error-diagnostics';

type StudioProviderErrorRecorder = (observation: StudioProviderErrorObservation) => Promise<void>;
/** Diagnostic body consumption is bounded independently; original HTTP/code/retry decisions remain with callers. */
async function readProviderErrorBody(response: Response, originalSignal: AbortSignal) {
  let value: unknown; let bodyRead: StudioProviderErrorEvent['bodyRead'] = 'not_read';
  const hash = createHash('sha256'); let length = 0, complete = false;
  const observation = (): StudioResponseObservation => ({ httpStatus: response.status, contentType: response.headers.get('content-type'),
    responseBytes: length, responseSha256: hash.digest('hex'), bodyComplete: complete,
    parseOutcome: bodyRead === 'timeout' || bodyRead === 'not_read' ? 'read_error' : bodyRead });
  if (!response.body) { bodyRead = 'empty_body'; return { value, bodyRead, observation: observation(), hadBody: false }; }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = response.body.getReader(); }
  catch { bodyRead = 'read_error'; return { value, bodyRead, observation: observation(), hadBody: true }; }
  const controller = new AbortController(), signal = controller.signal;
  const forwardAbort = () => controller.abort(originalSignal.reason);
  // Own a referenced total deadline: Node 20's inline timeout/any sources may be weakly held.
  const deadline = setTimeout(() => controller.abort(), 1000); deadline.ref();
  const chunks: Uint8Array[] = [];
  const abort = () => { void reader.cancel().catch(() => {}); };
  try {
    signal.addEventListener('abort', abort, { once: true });
    originalSignal.addEventListener('abort', forwardAbort, { once: true });
    if (originalSignal.aborted) forwardAbort();
    for (;;) {
      if (signal.aborted) { bodyRead = 'timeout'; break; }
      let fail: (() => void) | undefined;
      const next = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        fail = () => reject(new Error('diagnostic_read_aborted'));
        signal.addEventListener('abort', fail, { once: true });
        reader.read().then(resolve, reject);
        if (signal.aborted) fail();
      }).finally(() => { if (fail) signal.removeEventListener('abort', fail); });
      if (signal.aborted) { bodyRead = 'timeout'; break; }
      if (next.done) { complete = true; bodyRead = length ? 'valid_json' : 'empty_body'; break; }
      const remaining = 64 * 1024 - length, oversize = next.value.byteLength > remaining;
      const bounded = oversize ? next.value.subarray(0, remaining) : next.value;
      length += bounded.byteLength; hash.update(bounded); chunks.push(bounded);
      if (oversize) { bodyRead = 'oversize'; break; }
    }
    if (bodyRead === 'valid_json') {
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { bodyRead = 'invalid_json'; }
    }
  } catch { bodyRead = signal.aborted ? 'timeout' : 'read_error'; }
  finally {
    clearTimeout(deadline); originalSignal.removeEventListener('abort', forwardAbort);
    signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {});
  }
  return { value, bodyRead, observation: observation(), hadBody: true };
}
function providerErrorCollector(model: string, resumed: boolean, callback?: StudioProviderErrorRecorder) {
  let request = sanitizeStudioProviderErrorRequest({ dispatchObserved: false, model });
  let phase: StudioProviderErrorPhase = resumed ? 'summary' : 'initial_request';
  let status: number | undefined, payload: unknown, bodyRead: StudioProviderErrorEvent['bodyRead'] = 'not_read';
  let identityEvidence: StudioProviderErrorEvent['identityEvidence'] = resumed ? 'not_independently_verified' : 'not_applicable';
  let captured = false, omittedEvents = 0;
  const events = new Map<string, StudioProviderErrorObservation>();
  return {
    request(value: StudioProviderErrorRequest) { request = value; },
    phase(value: StudioProviderErrorPhase, httpStatus?: number) {
      phase = value; status = httpStatus; payload = undefined; bodyRead = 'not_read'; captured = false;
      identityEvidence = value === 'summary' || value === 'result' ? 'not_independently_verified' : 'not_applicable';
    },
    body(value: unknown, read: StudioProviderErrorEvent['bodyRead'], identity?: StudioProviderErrorEvent['identityEvidence']) {
      payload = identity === 'conflict' ? undefined : value; bodyRead = read; if (identity) identityEvidence = identity;
    },
    capture(code?: string, onlyIfRecorded = false) {
      if (!callback || code === 'async_pending') return;
      const event = buildStudioProviderErrorEvent({ phase, dispatchObserved: request.dispatchObserved,
        transportHttpStatus: status, payload, bodyRead, localCode: code, identityEvidence });
      const key = studioProviderErrorEventKey(event), previous = events.get(key);
      if (previous && onlyIfRecorded) return;
      if (previous) { event.observedAt = previous.event.observedAt; event.occurrences = Math.min(1_000_000, previous.event.occurrences + 1); }
      if (!previous && events.size >= 16) {
        const values = Array.from(events.entries());
        const firstSpecific = values.findIndex(([, observation]) => observation.event.providerReasonCode !== null);
        const victim = values.find(([, _observation], index) => index > 0 && index !== firstSpecific);
        if (victim) { omittedEvents = Math.min(1_000_000, omittedEvents + victim[1].event.occurrences); events.delete(victim[0]); }
      }
      events.set(key, { request, event, onlyIfRecorded }); captured = !onlyIfRecorded;
    },
    failure(error: unknown) {
      if (captured) return;
      if (error instanceof StudioProviderError) {
        if (error.stage === 'download') { phase = 'download'; status = error.status; payload = undefined; }
        this.capture(error.code);
      } else this.capture();
    },
    async flush() {
      if (!callback) return;
      let first = true;
      for (const observation of Array.from(events.values())) {
        try { await callback({ ...observation, ...(first && omittedEvents ? { omittedEvents } : {}) }); }
        catch { console.warn('[image-provider-error] capture_unavailable'); }
        first = false;
      }
    },
  };
}
type StudioProviderErrorCollector = ReturnType<typeof providerErrorCollector>;
function observeOriginalProviderBody(diagnostics: StudioProviderErrorCollector, value: unknown,
  bodyRead: StudioProviderErrorEvent['bodyRead'], taskId: string) {
  const identity = providerErrorObject(value) ? value.task_id || value.id : undefined;
  diagnostics.body(value, bodyRead, identity ? identity === taskId ? 'verified' : 'conflict' : 'not_independently_verified');
}

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
type StudioResponseEvidenceRecorder = (diagnostic: StudioResponseDiagnostics, candidates: StudioResponseOutputCandidate[]) => Promise<void>;
type StudioJsonObserver = (value: unknown, observation: StudioResponseObservation) => Promise<void>;
async function boundedJson(response: Response, maximum: number, observe?: StudioJsonObserver) {
  const hash = observe ? createHash('sha256') : undefined;
  let size = 0; let complete = false;
  const record = (value: unknown, parseOutcome: StudioResponseObservation['parseOutcome']) => observe?.(value, {
    httpStatus: response.status, contentType: response.headers.get('content-type'), responseBytes: size,
    responseSha256: hash!.digest('hex'), bodyComplete: complete, parseOutcome,
  });
  if (!response.body) { await record(undefined, 'empty_body'); throw new StudioProviderError('response', 'empty_response', response.status); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let oversize = false;
  try {
    for (;;) { const next = await reader.read(); if (next.done) { complete = true; break; }
      size += next.value.byteLength; hash?.update(next.value);
      if (size > maximum) { oversize = true; throw new Error('oversize'); } chunks.push(next.value); }
  } catch {
    await record(undefined, oversize ? 'oversize' : 'read_error');
    throw new StudioProviderError('response', 'invalid_or_oversize_response', response.status);
  }
  finally { await reader.cancel().catch(() => {}); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { await record(undefined, 'invalid_json'); throw new StudioProviderError('response', 'invalid_or_oversize_response', response.status); }
  await record(value, 'valid_json');
  return value as any;
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
  'gemini-nano-banana-2.1',
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
]);
function boundedPollDelay(value: unknown) {
  return Math.min(30000, Math.max(2000, typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 2000));
}

type StudioPollPhase = 'waiting' | 'summary_request' | 'summary_body' | 'result_request' | 'result_body';
type StudioPollStatus = 'pending' | 'queued' | 'dispatching' | 'running' | 'processing' | 'success' | 'failed'
  | 'uncertain' | 'client_disconnected' | 'paused' | 'canceled';
export type StudioPollDiagnostics = {
  scope: 'original_task_poll_window'; phaseAtStop: StudioPollPhase;
  lastAttemptPhase: Exclude<StudioPollPhase, 'waiting'> | null;
  getTransportCalls: number; lastHttpStatus: number | null; lastProviderStatus: StudioPollStatus | null;
  summaryNotFound?: true;
  lastErrorCategory: 'http_non_success' | 'invalid_or_oversize_response' | 'empty_response'
    | 'transport_or_abort' | 'provider_terminal' | 'identity_conflict' | null;
};
const POLL_STATUSES = new Set<StudioPollStatus>(['pending', 'queued', 'dispatching', 'running', 'processing', 'success', 'failed',
  'uncertain', 'client_disconnected', 'paused', 'canceled']);

export class StudioProviderError extends Error {
  constructor(public stage: 'request' | 'response' | 'download', public code: string, public status?: number, public diagnostics?: StudioDownloadDiagnostics, public retryable = false, public poll?: StudioPollDiagnostics) {
    super(`图片服务处理失败（${code}）`);
    this.name = 'StudioProviderError';
  }
}

// Keep GPT image requests isolated from the existing Gemini/Seedream adapters.
export async function requestStudioImages(params: Parameters<typeof requestStudioImagesImplementation>[0],
  fetcher: typeof fetch = fetch, readImage: typeof readStudioImage = readStudioImage): Promise<{ images: string[]; usage: unknown }> {
  const diagnostics = providerErrorCollector(params.model, Boolean(params.resumeAsync), params.onProviderErrorDiagnostics);
  try { return await requestStudioImagesImplementation(params, fetcher, readImage, diagnostics); }
  catch (error) { diagnostics.failure(error); throw error; }
  finally { await diagnostics.flush(); }
}
async function requestStudioImagesImplementation(params: {
  baseUrl: string; apiKey: string; model: string; prompt: string;
  upstreamModel?: string;
  provider?: 'musk' | 'ai_media_vip';
  protocol?: ImageGenerationChannelProtocol;
  idempotencyKey?: string;
  resumeAsync?: { taskId: string; pollAfterMs?: number; expiresAt?: string };
  asyncQueryMode?: 'single';
  onAsyncAccepted?: (receipt: { taskId: string; pollAfterMs?: number; expiresAt?: string }) => Promise<void>;
  quality?: string;
  count: number; images: StudioImageInput[]; signal: AbortSignal; ratio?: string;
  downloadSignal?: AbortSignal;
  deliverRemoteImage?: (url: string, usage: unknown) => Promise<Buffer>;
  persistBase64Image?: (value: string, usage: unknown) => Promise<void>;
  recordResponse?: (response: Response) => Promise<void>;
  recordResponseEvidence?: StudioResponseEvidenceRecorder;
  onProviderErrorDiagnostics?: StudioProviderErrorRecorder;
  size?: string;
  allowFourToOne?: boolean;
  ratioContractVersion?: 2;
}, fetcher: typeof fetch, readImage: typeof readStudioImage, diagnostics: StudioProviderErrorCollector): Promise<{ images: string[]; usage: unknown }> {
  if (params.asyncQueryMode === 'single' && !params.resumeAsync) throw new StudioProviderError('request', 'async_original_identity_required');
  if (!IMAGE_STUDIO_MODELS.includes(params.model as typeof IMAGE_STUDIO_MODELS[number])) throw new Error('不支持的图片模型');
  if (params.model === 'gemini-nano-banana-2.1') {
    if (params.quality !== undefined && params.quality !== 'auto') throw new Error('Banana 2.1 不支持所选图片质量；尚未向供应商提交');
    const native = params.protocol === 'gemini_native' || !params.protocol && params.provider !== 'ai_media_vip';
    if (native && params.size !== undefined) assertImageResolutionSupported(params.model, params.size);
  }
  if (params.upstreamModel !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(params.upstreamModel)) throw new Error('供应商型号名称无效');
  if (!Number.isInteger(params.count) || params.count < 1 || params.count > 8) throw new Error('生成张数必须为 1 到 8');
  if (params.images.length > MAX_REFERENCE_IMAGES) throw new Error(`最多使用 ${MAX_REFERENCE_IMAGES} 张参考图`);
  const standardRatioContract = params.ratioContractVersion === 2;
  const requestRatio = standardRatioContract && params.ratio ? normalizeStudioRatio(params.ratio) : params.ratio;
  const allowFourToOne = standardRatioContract || params.allowFourToOne === true && params.protocol === 'openai_images';
  const sendRatio = Boolean(requestRatio && (standardRatioContract || allowFourToOne && requestRatio === '4:1'));
  if (params.size && params.protocol !== 'gemini_native' && (params.protocol === 'openai_images' || !isGeminiImageModel(params.model) || params.provider === 'ai_media_vip') && !isValidImageDimension(params.size, allowFourToOne)) {
    throw new Error('生成尺寸无效');
  }
  const transport: typeof fetch = params.protocol && fetcher === fetch ? fetchPinnedApi as typeof fetch : fetcher;
  if (params.protocol === 'gemini_native' || !params.protocol && params.provider !== 'ai_media_vip' && GEMINI_IMAGE_MODELS.has(params.model)) {
    if (params.resumeAsync) throw new StudioProviderError('request', 'gemini_async_not_supported');
    return requestGeminiStudioImages(standardRatioContract ? { ...params, ratio: requestRatio === 'auto' ? undefined : requestRatio } : params, transport, readImage, diagnostics);
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
    if (sendRatio) form.set('ratio', requestRatio!);
    params.images.forEach((image, index) => {
      form.append('image[]', new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), `reference-${index + 1}.${image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType === 'image/webp' ? 'webp' : 'png'}`);
    });
    body = form;
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ model: params.upstreamModel || params.model, prompt: params.prompt, n: params.count, output_format: 'png', ...(params.size ? { size: params.size } : {}),
      ...(sendRatio ? { ratio: requestRatio } : {}), ...(params.quality && params.quality !== 'auto' ? { quality: params.quality } : {}) });
  }
  let value: any;
  let response: Response | undefined;
  let asyncTask = params.resumeAsync;
  if (!asyncTask) {
    const serialized = body instanceof FormData ? { model: body.get('model'), quality: body.get('quality') ?? 'omitted', size: body.get('size'),
      ratio: body.get('ratio'), n: Number(body.get('n')) } : JSON.parse(body as string);
    diagnostics.request(sanitizeStudioProviderErrorRequest({ dispatchObserved: true, endpointKind: params.images.length ? 'edits' : 'generations',
      protocol: 'openai_images', model: params.model, sentModel: serialized.model, quality: serialized.quality ?? 'omitted',
      size: serialized.size, ratio: serialized.ratio, n: serialized.n, referenceCount: params.images.length }));
    diagnostics.phase('initial_request');
    try { response = await transport(url, { method: 'POST', headers, body, signal: params.signal, redirect: params.protocol ? 'error' : 'follow' }); }
    catch { throw new StudioProviderError('request', params.signal.aborted ? 'timeout' : 'network'); }
    await params.recordResponse?.(response);
    diagnostics.phase('initial_request', response.status);
    if (!response.ok) { const observed = await readProviderErrorBody(response, params.signal);
      diagnostics.body(observed.value, observed.bodyRead); throw new StudioProviderError('request', 'http_error', response.status); }
    value = await boundedJson(response, params.count * MAX_STUDIO_GENERATED_BASE64 + 1024 * 1024,
      async (body, observation) => { diagnostics.body(body, observation.parseOutcome); });
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
    const single = params.asyncQueryMode === 'single';
    const queryDeadline = AbortSignal.timeout(single ? 10000 : 60000);
    const querySignal = AbortSignal.any([params.signal, queryDeadline]);
    let pollDelay = boundedPollDelay(asyncTask.pollAfterMs);
    let lastObservation: 'pending' | 'interrupted' | 'unconfirmed' = 'interrupted';
    let readingQuery = false;
    // These are application polling phases, not DNS/TCP/TLS timing. Only values
    // actually observed in this window are recorded; no upstream text is copied.
    const poll: StudioPollDiagnostics = { scope: 'original_task_poll_window', phaseAtStop: 'waiting', lastAttemptPhase: null,
      getTransportCalls: 0, lastHttpStatus: null, lastProviderStatus: null, lastErrorCategory: null };
    const phase = (value: StudioPollPhase) => { poll.phaseAtStop = value; if (value !== 'waiting') poll.lastAttemptPhase = value; };
    for (;;) {
      try {
        phase('waiting');
        if (!single) await delay(pollDelay, undefined, { signal: querySignal });
        querySignal.throwIfAborted();
        readingQuery = true;
        phase('summary_request'); poll.getTransportCalls++; poll.lastErrorCategory = null;
        diagnostics.phase('summary');
        const polled = await transport(pollUrl, { method: 'GET', headers: { Authorization: `Bearer ${params.apiKey}` }, signal: querySignal, redirect: 'error' });
        poll.lastHttpStatus = polled.status;
        diagnostics.phase('summary', polled.status);
        if (polled.status === 404) poll.summaryNotFound = true; else delete poll.summaryNotFound;
        if (!polled.ok) { poll.lastErrorCategory = 'http_non_success'; lastObservation = 'interrupted'; readingQuery = false;
          const observed = await readProviderErrorBody(polled, querySignal); observeOriginalProviderBody(diagnostics, observed.value, observed.bodyRead, asyncTask.taskId);
          diagnostics.capture('async_query_interrupted');
          if (single) throw new StudioProviderError('response', 'async_query_interrupted', polled.status, undefined, true, { ...poll });
          pollDelay = Math.min(10000, Math.max(5000, pollDelay * 2)); continue; }
        phase('summary_body');
        const task = await boundedJson(polled, 1024 * 1024, async (_body, observation) => {
          // Success JSON is considered only after independent task-id comparison below.
          diagnostics.body(undefined, observation.parseOutcome);
        });
        poll.lastErrorCategory = null;
        poll.lastProviderStatus = typeof task?.status === 'string' && POLL_STATUSES.has(task.status as StudioPollStatus) ? task.status as StudioPollStatus : null;
        if ((task.task_id || task.id) && (task.task_id || task.id) !== asyncTask.taskId) {
          diagnostics.body(undefined, 'valid_json', 'conflict'); throw new StudioProviderError('response', 'async_task_identity_conflict');
        }
        diagnostics.body(task, 'valid_json', (task.task_id || task.id) === asyncTask.taskId ? 'verified' : 'not_independently_verified');
        if (task.status === 'failed') throw new StudioProviderError('response', 'async_failed', polled.status);
        if (['uncertain', 'client_disconnected', 'paused', 'canceled'].includes(task.status)) throw new StudioProviderError('response', 'async_unconfirmed', polled.status);
        if (task.status !== 'success') {
          lastObservation = ['pending', 'queued', 'dispatching', 'running', 'processing'].includes(task.status) ? 'pending' : 'unconfirmed';
          if (single) throw new StudioProviderError('response', lastObservation === 'pending' ? 'async_pending' : 'async_query_unconfirmed', polled.status, undefined, true, { ...poll });
          readingQuery = false; pollDelay = boundedPollDelay(task.poll_after_ms); continue;
        }
        diagnostics.capture(undefined, true);
        const assets = Array.isArray(task.assets) ? task.assets : [];
        if (assets.length) {
          value = { data: assets.map((asset: any) => {
            if (typeof asset.signed_url === 'string' && asset.signed_url) return { url: asset.signed_url };
            const authenticatedUrl = asset.download_url || asset.url;
            // An asset/link expiry is never written back as task status or a
            // query-retention deadline. Keep it local to this download only.
            return { url: authenticatedUrl, authenticatedAsset: true, expiresAt: asset.expires_at || task.expires_at || asyncTask!.expiresAt };
          }), usage: task.usage };
        } else {
          // Only after success: the raw result is not a polling endpoint.
          const resultUrl = new URL(pollUrl); resultUrl.search = '';
          phase('result_request'); poll.getTransportCalls++; poll.lastErrorCategory = null;
          diagnostics.phase('result');
          const result = await transport(resultUrl, { method: 'GET', headers: { Authorization: `Bearer ${params.apiKey}` }, signal: querySignal, redirect: 'error' });
          poll.lastHttpStatus = result.status;
          diagnostics.phase('result', result.status);
          if (!result.ok) { poll.lastErrorCategory = 'http_non_success'; const observed = await readProviderErrorBody(result, querySignal);
            observeOriginalProviderBody(diagnostics, observed.value, observed.bodyRead, asyncTask.taskId);
            throw new StudioProviderError('response', 'async_query_interrupted', result.status, undefined, true); }
          phase('result_body');
          value = await boundedJson(result, params.count * MAX_STUDIO_GENERATED_BASE64 + 1024 * 1024,
            async (body, observation) => { observeOriginalProviderBody(diagnostics, body, observation.parseOutcome, asyncTask!.taskId); });
          poll.lastErrorCategory = null;
        }
        break;
      } catch (error) {
        diagnostics.failure(error);
        if (error instanceof StudioProviderError && ['async_failed', 'async_unconfirmed', 'async_task_identity_conflict'].includes(error.code)) {
          poll.lastErrorCategory = error.code === 'async_task_identity_conflict' ? 'identity_conflict' : 'provider_terminal';
          error.poll = { ...poll }; throw error;
        }
        if (poll.phaseAtStop !== 'waiting') {
          poll.lastErrorCategory = error instanceof StudioProviderError && error.code === 'invalid_or_oversize_response' ? 'invalid_or_oversize_response'
            : error instanceof StudioProviderError && error.code === 'empty_response' ? 'empty_response'
              : poll.lastErrorCategory === 'http_non_success' ? 'http_non_success' : 'transport_or_abort';
        }
        if (single) throw new StudioProviderError('response', error instanceof StudioProviderError ? error.code : 'async_query_interrupted',
          error instanceof StudioProviderError ? error.status : undefined, undefined, true, { ...poll });
        if (querySignal.aborted) throw new StudioProviderError('response', readingQuery || params.signal.aborted || lastObservation === 'interrupted' ? 'async_query_interrupted' : lastObservation === 'pending' ? 'async_pending' : 'async_query_unconfirmed', undefined, undefined, true, { ...poll });
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
  diagnostics.capture(undefined, true);
  return { images, usage };
}

async function requestGeminiStudioImages(params: {
  baseUrl: string; apiKey: string; model: string; prompt: string;
  upstreamModel?: string;
  count: number; images: StudioImageInput[]; signal: AbortSignal; ratio?: string; size?: string;
  recordResponse?: (response: Response) => Promise<void>;
  recordResponseEvidence?: StudioResponseEvidenceRecorder;
  persistBase64Image?: (value: string, usage: unknown) => Promise<void>;
  deliverRemoteImage?: (url: string, usage: unknown) => Promise<Buffer>;
  downloadSignal?: AbortSignal;
  protocol?: ImageGenerationChannelProtocol;
}, fetcher: typeof fetch, readImage: typeof readStudioImage, diagnostics: StudioProviderErrorCollector): Promise<{ images: string[]; usage: unknown }> {
  const url = new URL(params.baseUrl);
  const basePath = url.pathname.replace(/\/$/, '').replace(/\/v1$/, '').replace(/\/v1beta$/, '');
  url.pathname = `${basePath}/v1beta/models/${encodeURIComponent(params.upstreamModel || params.model)}:generateContent`;
  const parts: Array<Record<string, unknown>> = [{ text: params.prompt }];
  for (const image of params.images) {
    parts.push({ inlineData: { mimeType: image.mimeType, data: Buffer.from(image.bytes).toString('base64') } });
  }
  const serialized = { contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: {
    ...(params.ratio ? { aspectRatio: params.ratio } : {}), ...(params.size ? { imageSize: params.size } : {}),
  } } };
  diagnostics.request(sanitizeStudioProviderErrorRequest({ dispatchObserved: true, endpointKind: 'generateContent', protocol: 'gemini_native',
    model: params.model, sentModel: params.upstreamModel || params.model, quality: 'omitted',
    size: serialized.generationConfig.imageConfig.imageSize, ratio: serialized.generationConfig.imageConfig.aspectRatio,
    n: params.count, referenceCount: parts.length - 1 }));
  diagnostics.phase('initial_request');
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${params.apiKey}` },
      body: JSON.stringify(serialized),
      signal: params.signal,
      redirect: params.protocol ? 'error' : 'follow',
    });
  } catch {
    throw new StudioProviderError('request', params.signal.aborted ? 'timeout' : 'network');
  }
  await params.recordResponse?.(response);
  diagnostics.phase('initial_request', response.status);
  let captured: { diagnostic: StudioResponseDiagnostics; candidates: StudioResponseOutputCandidate[] } | undefined;
  let evidenceUnavailable = false;
  const recordEvidence = async (trustedImage?: string) => {
    if (!captured || !params.recordResponseEvidence) return;
    const candidates = trustedImage ? captured.candidates.filter(candidate => candidate.value !== trustedImage) : captured.candidates;
    try { await params.recordResponseEvidence(captured.diagnostic, candidates); }
    catch { evidenceUnavailable = true; } // The caller logs only a fixed safe code; valid delivery is not blocked.
  };
  let value: any;
  if (!response.ok) {
    const observed = await readProviderErrorBody(response, params.signal); diagnostics.body(observed.value, observed.bodyRead);
    if (params.recordResponseEvidence) {
      captured = { diagnostic: buildStudioResponseDiagnostics(observed.value, observed.observation), candidates: [] };
      await recordEvidence();
    }
    // Preserve native parsing errors for empty/malformed replies while the HTTP status remains observable.
    if (observed.bodyRead === 'empty_body') throw new StudioProviderError('response', observed.hadBody ? 'invalid_or_oversize_response' : 'empty_response', response.status);
    if (observed.bodyRead === 'invalid_json' || observed.bodyRead === 'read_error') throw new StudioProviderError('response', 'invalid_or_oversize_response', response.status);
    throw new StudioProviderError('request', 'http_error', response.status);
  }
  try {
    value = await boundedJson(response, params.count * MAX_STUDIO_GENERATED_BASE64 + 1024 * 1024,
      async (body, observation) => {
        diagnostics.body(body, observation.parseOutcome);
        if (params.recordResponseEvidence) captured = { diagnostic: buildStudioResponseDiagnostics(body, observation),
          candidates: response.ok && observation.parseOutcome === 'valid_json' ? collectStudioResponseOutputCandidates(body) : [] };
      });
  } catch (error) { await recordEvidence(); throw error; }
  if (!response.ok) { await recordEvidence(); throw new StudioProviderError('request', 'http_error', response.status); }
  type NativeOutput = { kind: 'inline' | 'url'; value: string };
  let outputs: NativeOutput[];
  try {
    outputs = (value?.candidates || []).flatMap((candidate: { content?: { parts?: Array<Record<string, unknown>> } }) => candidate.content?.parts || [])
      .map((part: Record<string, unknown>) => {
        const inline = (part.inlineData || part.inline_data) as { data?: unknown } | undefined;
        if (typeof inline?.data === 'string' && inline.data.length) return { kind: 'inline' as const, value: inline.data };
        const file = (part.fileData || part.file_data) as { mimeType?: unknown; mime_type?: unknown; fileUri?: unknown; file_uri?: unknown } | undefined;
        if (!file) return null;
        const mime = file.mimeType ?? file.mime_type;
        if (typeof mime !== 'string' || !['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/tiff'].includes(mime)) {
          throw new StudioProviderError('response', 'unsupported_output', response.status);
        }
        const source = file.fileUri ?? file.file_uri;
        if (typeof source !== 'string' || !source.length || source.length > 16384 || source !== source.trim()
          || /[\u0000-\u0020\u007f\\]/.test(source)) throw new StudioImageDownloadError('download_unsafe_url');
        let parsed: URL;
        try { parsed = new URL(source); } catch { throw new StudioImageDownloadError('download_unsafe_url'); }
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new StudioImageDownloadError('download_unsafe_url');
        return { kind: 'url' as const, value: source };
      })
      .filter((output: NativeOutput | null): output is NativeOutput => output !== null);
  } catch (error) {
    await recordEvidence();
    if (error instanceof StudioProviderError) throw error;
    if (error instanceof StudioImageDownloadError) throw new StudioProviderError('download', error.code, error.status, error.diagnostics, error.retryable);
    throw new StudioProviderError('response', 'unsupported_output', response.status);
  }
  if (!outputs.length) { await recordEvidence(); throw new StudioProviderError('response', evidenceUnavailable ? 'response_evidence_unavailable' : 'empty_output', response.status); }
  if (outputs.length !== params.count) { await recordEvidence(); throw new StudioProviderError('response', 'unexpected_count', response.status); }
  const usage = safeUsage(value.usageMetadata || value.usage);
  const images: string[] = [];
  for (const output of outputs) {
    if (output.kind === 'inline') { images.push(output.value); continue; }
    try {
      const downloaded = params.deliverRemoteImage ? await params.deliverRemoteImage(output.value, usage)
        : await readImage(output.value, params.downloadSignal || params.signal);
      images.push(downloaded.toString('base64'));
    } catch (error) {
      await recordEvidence();
      throw new StudioProviderError('download', error instanceof StudioImageDownloadError ? error.code : 'download_invalid_or_unreadable', error instanceof StudioImageDownloadError ? error.status : undefined, error instanceof StudioImageDownloadError ? error.diagnostics : undefined, error instanceof StudioImageDownloadError && error.retryable);
    }
  }
  // Only the instrumented native channel uses the early original checkpoint.
  // It precedes diagnostic I/O; do not duplicate its bytes in the isolated sidecar.
  let trustedImage: string | undefined;
  if (params.recordResponseEvidence && params.persistBase64Image && outputs.length === 1 && outputs[0].kind === 'inline') {
    try { await params.persistBase64Image(images[0], usage); trustedImage = images[0]; }
    catch (error) { await recordEvidence(); throw error; }
  }
  await recordEvidence(trustedImage);
  diagnostics.capture(undefined, true);
  return { images, usage };
}
