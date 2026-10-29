import { createHash } from 'node:crypto';
import { defaultImageResolution, imageOutputSize } from '@/lib/image-generation/resolution';
import {
  LOCAL_GPU_IMAGE_CHANNEL_ID,
  LOCAL_GPU_IMAGE_MODELS,
  LOCAL_GPU_QWEN_PROFILE,
  type LocalGpuImageModel,
} from './local-gpu-image-contract';

export { LOCAL_GPU_IMAGE_CHANNEL_ID, LOCAL_GPU_IMAGE_MODELS, type LocalGpuImageModel } from './local-gpu-image-contract';

const HEALTH_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const QUERY_TIMEOUT_MS = 20_000;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_CREATE_BYTES = 65_536;
const MAX_OUTPUT_BYTES = 30 * 1024 * 1024;
const API_PATH = '/api/local-images';
const DEFAULT_POLL_MS = 4_000;

export type LocalGpuImageConfig = {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  configRevision: string;
};

export type LocalGpuHealth = {
  ready: boolean;
  reason: string | null;
  supportedModels: LocalGpuImageModel[];
  configurationError?: boolean;
};

export type LocalGpuJobIdentity = {
  taskId: string;
  queryIdentity: 'provider_task_id' | 'client_request_id';
  pollAfterMs: number;
};

export class LocalGpuImageError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly kind: 'offline' | 'rejected' | 'unknown' | 'failed' | 'invalid',
    public readonly status?: number,
    public readonly identity?: LocalGpuJobIdentity,
  ) {
    super(message);
    this.name = 'LocalGpuImageError';
  }
}

function stableUuid(input: string) {
  const bytes = Buffer.from(createHash('sha256').update(input).digest('hex').slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeBaseUrl(raw: string) {
  if (!raw) return '';
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new LocalGpuImageError('本地 GPU 接口地址配置无效', 'local_gpu_config_invalid', 'invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new LocalGpuImageError('本地 GPU 接口地址配置无效', 'local_gpu_config_invalid', 'invalid');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

/** Server-only environment configuration. Never expose this object through an HTTP DTO. */
export function readLocalGpuImageConfig(env: NodeJS.ProcessEnv = process.env): LocalGpuImageConfig {
  const enabled = env.LOCAL_GPU_IMAGE_ENABLED === 'true';
  const baseUrl = normalizeBaseUrl((env.LOCAL_GPU_IMAGE_BASE_URL || '').trim());
  const apiKey = (env.LOCAL_GPU_IMAGE_API_KEY || '').trim();
  if (apiKey.length > 500) throw new LocalGpuImageError('本地 GPU Key 配置无效', 'local_gpu_config_invalid', 'invalid');
  const configRevision = stableUuid(JSON.stringify({ version: 2, baseUrl, profile: LOCAL_GPU_QWEN_PROFILE,
    keyDigest: apiKey ? createHash('sha256').update(apiKey).digest('hex') : '', models: LOCAL_GPU_IMAGE_MODELS }));
  return { enabled, baseUrl, apiKey, configRevision };
}

function endpoint(config: LocalGpuImageConfig, path: string, query?: Record<string, string>) {
  if (!path.startsWith('/')) throw new Error('Local GPU path must be absolute');
  const url = new URL(normalizeBaseUrl(config.baseUrl));
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
  url.search = '';
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
  return url;
}

function headers(config: LocalGpuImageConfig, extra?: Record<string, string>) {
  return { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json', ...extra };
}

async function readJson(response: Response) {
  let text: string;
  try { text = await response.text(); }
  catch { throw new LocalGpuImageError('本地 GPU 返回读取中断', 'local_gpu_invalid_response', 'invalid', response.status); }
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new LocalGpuImageError('本地 GPU 返回内容过大', 'local_gpu_invalid_response', 'invalid', response.status);
  try {
    const value: unknown = text ? JSON.parse(text) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
    return value as Record<string, unknown>;
  }
  catch { throw new LocalGpuImageError('本地 GPU 返回格式无效', 'local_gpu_invalid_response', 'invalid', response.status); }
}

function safePollAfter(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(3_000, Math.min(5_000, Math.floor(number))) : DEFAULT_POLL_MS;
}

function validIdentity(value: unknown) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value) ? value : null;
}

function supportedModels(value: unknown): LocalGpuImageModel[] {
  if (!Array.isArray(value)) return [];
  return value.some(item => {
    if (!item || typeof item !== 'object') return false;
    const row = item as Record<string, unknown>;
    return row.modelId === LOCAL_GPU_QWEN_PROFILE.id && row.available === true
      && row.executionProfileId === LOCAL_GPU_QWEN_PROFILE.id;
  }) ? [...LOCAL_GPU_IMAGE_MODELS] : [];
}

export async function checkLocalGpuImageHealth(config = readLocalGpuImageConfig(), fetcher: typeof fetch = fetch): Promise<LocalGpuHealth> {
  if (!config.enabled) return { ready: false, reason: '本地 GPU 通道未启用', supportedModels: [] };
  if (!config.baseUrl || !config.apiKey) return { ready: false, reason: '本地 GPU 后端尚未配置', supportedModels: [] };
  try {
    const response = await fetcher(endpoint(config, `${API_PATH}/models`), { method: 'GET', headers: headers(config),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS), redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) return { ready: false,
        reason: '本地 GPU 调用 Key 或访问权限配置有误', supportedModels: [], configurationError: true };
      return { ready: false, reason: '本地 GPU Worker 离线或暂不可用', supportedModels: [] };
    }
    const body = await readJson(response);
    const models = supportedModels(body.models);
    if (!models.length) return { ready: false, reason: '本地 GPU Qwen BF16 未就绪或 Worker 离线', supportedModels: [] };
    return { ready: true, reason: null, supportedModels: models };
  } catch {
    return { ready: false, reason: '本地 GPU Worker 离线', supportedModels: [] };
  }
}

export async function assertLocalGpuImageWorkerReady(model: string, config = readLocalGpuImageConfig(), fetcher: typeof fetch = fetch) {
  const health = await checkLocalGpuImageHealth(config, fetcher);
  if (!health.ready || !health.supportedModels.includes(model as LocalGpuImageModel)) {
    throw new LocalGpuImageError(health.reason || '本地 GPU Worker 未加载所选模型',
      health.configurationError ? 'local_gpu_auth_failed' : 'local_gpu_worker_offline', health.configurationError ? 'rejected' : 'offline');
  }
  return health;
}

async function request(config: LocalGpuImageConfig, url: URL, init: RequestInit, timeoutMs: number, fetcher: typeof fetch) {
  return fetcher(url, { ...init, signal: init.signal || AbortSignal.timeout(timeoutMs), redirect: 'error' });
}

function acceptedIdentity(body: Record<string, unknown>): LocalGpuJobIdentity | null {
  const taskId = validIdentity(body.taskId);
  if (taskId) return { taskId, queryIdentity: 'provider_task_id', pollAfterMs: safePollAfter(body.pollAfterMs) };
  return null;
}

function dimensions(size: string | undefined, ratio: string | undefined) {
  const resolved = size || imageOutputSize(LOCAL_GPU_QWEN_PROFILE.id, defaultImageResolution(LOCAL_GPU_QWEN_PROFILE.id), ratio || '1:1', 'local_gpu', true);
  const [width, height] = resolved.split('x').map(Number);
  if (!/^\d+x\d+$/.test(resolved) || ![width, height].every(value => Number.isSafeInteger(value) && value >= 256 && value <= 3840 && value % 16 === 0)
    || width * height < 131_072 || width * height > LOCAL_GPU_QWEN_PROFILE.maxPixels
    || (width > height * 3 && width !== height * 4) || height > width * 3) {
    throw new LocalGpuImageError('Qwen 不支持所选尺寸；请调整尺寸后再生成', 'local_gpu_size_invalid', 'invalid');
  }
  return { width, height };
}

function errorCode(body: Record<string, unknown>) {
  return typeof body.error === 'string' ? body.error : '';
}

export async function submitLocalGpuImageJob(input: {
  config?: LocalGpuImageConfig;
  requestId: string;
  model: LocalGpuImageModel;
  prompt: string;
  quality: string;
  size?: string;
  ratio?: string;
  fetcher?: typeof fetch;
}): Promise<LocalGpuJobIdentity> {
  const config = input.config || readLocalGpuImageConfig();
  const fetcher = input.fetcher || fetch;
  if (!LOCAL_GPU_IMAGE_MODELS.includes(input.model)) {
    throw new LocalGpuImageError('本地 GPU 不支持所选模型', 'local_gpu_model_invalid', 'invalid');
  }
  if (!validIdentity(input.requestId) || typeof input.prompt !== 'string' || !Array.from(input.prompt).length || Array.from(input.prompt).length > 4000) {
    throw new LocalGpuImageError('Qwen 请求编号或提示词不符合接口要求（提示词最多 4000 字）', 'local_gpu_request_invalid', 'invalid');
  }
  const { width, height } = dimensions(input.size, input.ratio);
  const requestBody = JSON.stringify({ requestId: input.requestId, executionProfileId: LOCAL_GPU_QWEN_PROFILE.id,
    params: { prompt: input.prompt, negativePrompt: '', width, height,
      seed: createHash('sha256').update(input.requestId).digest().readUInt32BE(0) }, projectId: null });
  if (Buffer.byteLength(requestBody, 'utf8') > MAX_CREATE_BYTES) {
    throw new LocalGpuImageError('Qwen 请求正文过大', 'local_gpu_request_invalid', 'invalid');
  }
  const fallback: LocalGpuJobIdentity = { taskId: input.requestId, queryIdentity: 'client_request_id', pollAfterMs: DEFAULT_POLL_MS };
  try {
    const response = await request(config, endpoint(config, `${API_PATH}/tasks`), {
      method: 'POST', headers: headers(config, { 'Content-Type': 'application/json' }),
      body: requestBody,
    }, REQUEST_TIMEOUT_MS, fetcher);
    if (!response.ok) {
      const code = errorCode(await readJson(response).catch(() => ({})));
      if (response.status === 401 || response.status === 403) {
        throw new LocalGpuImageError('本地 GPU 调用 Key 或访问权限配置有误', 'local_gpu_auth_failed', 'rejected', response.status);
      }
      if (response.status === 429) {
        throw new LocalGpuImageError('本地 GPU 队列已满；稍后核对原请求', 'local_gpu_queue_full', 'unknown', response.status, fallback);
      }
      if (response.status === 409 && code === 'IDEMPOTENCY_CONFLICT') {
        throw new LocalGpuImageError('本地 GPU 原请求正文冲突，请管理员核对', 'local_gpu_identity_conflict', 'unknown', response.status, fallback);
      }
      if (response.status === 503 && ['WORKER_OFFLINE', 'PROFILE_NOT_QUALIFIED'].includes(code)) {
        throw new LocalGpuImageError('本地 GPU Worker 或 Qwen BF16 暂不可用；稍后核对原请求',
          'local_gpu_unavailable', 'unknown', response.status, fallback);
      }
      // A conflicting/timed-out request can already exist. Only look it up; never resend.
      if (response.status >= 400 && response.status < 500 && ![408, 409, 425].includes(response.status)) {
        throw new LocalGpuImageError('本地 GPU 拒绝了本次任务', 'local_gpu_rejected', 'rejected', response.status);
      }
      throw new LocalGpuImageError('本地 GPU 提交结果待确认', 'local_gpu_submit_unknown', 'unknown', response.status, fallback);
    }
    let body: Record<string, unknown>;
    try { body = await readJson(response); }
    catch (error) {
      if (error instanceof LocalGpuImageError && error.code === 'local_gpu_invalid_response') {
        throw new LocalGpuImageError('本地 GPU 提交结果待确认', 'local_gpu_submit_unknown', 'unknown', response.status, fallback);
      }
      throw error;
    }
    if (body.requestId !== undefined && body.requestId !== input.requestId) {
      throw new LocalGpuImageError('本地 GPU 返回的原请求编号不一致', 'local_gpu_identity_conflict', 'unknown', response.status, fallback);
    }
    if (body.requestId !== input.requestId || !(response.status === 202 && body.replayed === false || response.status === 200 && body.replayed === true)) {
      throw new LocalGpuImageError('本地 GPU 提交回执无法确认', 'local_gpu_submit_unknown', 'unknown', response.status, fallback);
    }
    const identity = acceptedIdentity(body);
    if (!identity) throw new LocalGpuImageError('本地 GPU 未返回任务编号', 'local_gpu_submit_unknown', 'unknown', response.status, fallback);
    return identity;
  } catch (error) {
    if (error instanceof LocalGpuImageError) throw error;
    throw new LocalGpuImageError('本地 GPU 提交结果待确认', 'local_gpu_submit_unknown', 'unknown', undefined, fallback);
  }
}

function outputId(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  return validIdentity(row.outputId);
}

export async function queryLocalGpuImageJob(input: {
  config?: LocalGpuImageConfig;
  identity: LocalGpuJobIdentity;
  fetcher?: typeof fetch;
}): Promise<{ state: 'pending'; identity: LocalGpuJobIdentity } | { state: 'reconciling'; identity: LocalGpuJobIdentity }
  | { state: 'success'; providerTaskId: string; outputId: string } | { state: 'failed' }> {
  const config = input.config || readLocalGpuImageConfig();
  const fetcher = input.fetcher || fetch;
  if (!validIdentity(input.identity.taskId)) throw new LocalGpuImageError('本地 GPU 原请求编号无效', 'local_gpu_identity_conflict', 'unknown', undefined, input.identity);
  const url = input.identity.queryIdentity === 'provider_task_id'
    ? endpoint(config, `${API_PATH}/tasks/${encodeURIComponent(input.identity.taskId)}`)
    : endpoint(config, `${API_PATH}/requests/${encodeURIComponent(input.identity.taskId)}`);
  let response: Response;
  try { response = await request(config, url, { method: 'GET', headers: headers(config) }, QUERY_TIMEOUT_MS, fetcher); }
  catch { throw new LocalGpuImageError('本地 GPU 原任务状态暂未确认', 'local_gpu_query_unknown', 'unknown', undefined, input.identity); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) throw new LocalGpuImageError('本地 GPU 调用 Key 或访问权限配置有误', 'local_gpu_auth_failed', 'rejected', response.status, input.identity);
    if (response.status === 404) throw new LocalGpuImageError('本地 GPU 原任务状态暂未确认', 'local_gpu_query_unknown', 'unknown', 404, input.identity);
    throw new LocalGpuImageError('本地 GPU 原任务查询中断', 'local_gpu_query_unknown', 'unknown', response.status, input.identity);
  }
  let body: Record<string, unknown>;
  try { body = await readJson(response); }
  catch (error) {
    if (error instanceof LocalGpuImageError && error.code === 'local_gpu_invalid_response') {
      throw new LocalGpuImageError('本地 GPU 原任务状态暂未确认', 'local_gpu_query_unknown', 'unknown', response.status, input.identity);
    }
    throw error;
  }
  const returnedTaskId = validIdentity(body.taskId);
  if (input.identity.queryIdentity === 'client_request_id' && body.requestId !== input.identity.taskId) {
    throw new LocalGpuImageError('本地 GPU 返回的原请求编号不一致', 'local_gpu_identity_conflict', 'unknown', response.status, input.identity);
  }
  if (input.identity.queryIdentity === 'provider_task_id' && returnedTaskId !== input.identity.taskId) {
    throw new LocalGpuImageError('本地 GPU 返回的原任务编号不一致', 'local_gpu_identity_conflict', 'unknown', response.status, input.identity);
  }
  const providerTaskId = returnedTaskId;
  if (!providerTaskId) throw new LocalGpuImageError('本地 GPU 原任务编号无法确认', 'local_gpu_identity_conflict', 'unknown', response.status, input.identity);
  // The request lookup is a receipt only: it has no status or outputs. Follow its original task with a GET.
  if (input.identity.queryIdentity === 'client_request_id') {
    return queryLocalGpuImageJob({ config, fetcher, identity: { taskId: providerTaskId, queryIdentity: 'provider_task_id', pollAfterMs: DEFAULT_POLL_MS } });
  }
  const state = typeof body.status === 'string' ? body.status.toLowerCase() : '';
  if (['failed', 'cancelled'].includes(state)) return { state: 'failed' };
  if (['queued', 'leased', 'running', 'uploading', 'reconciling'].includes(state)) {
    return { state: state === 'reconciling' ? 'reconciling' : 'pending', identity: { taskId: providerTaskId, queryIdentity: 'provider_task_id', pollAfterMs: safePollAfter(body.pollAfterMs) } };
  }
  if (state !== 'succeeded') {
    throw new LocalGpuImageError('本地 GPU 原任务状态暂未确认', 'local_gpu_query_unknown', 'unknown', response.status, input.identity);
  }
  const outputs = Array.isArray(body.outputs) ? body.outputs : [];
  const id = outputs.length === 1 && outputId(outputs[0]) === 'image-1' ? 'image-1' : null;
  if (!id) throw new LocalGpuImageError('本地 GPU 已完成任务但没有可下载结果', 'local_gpu_output_missing', 'invalid', response.status);
  return { state: 'success', providerTaskId, outputId: id };
}

export async function downloadLocalGpuImageOutput(input: {
  config?: LocalGpuImageConfig;
  providerTaskId: string;
  outputId: string;
  fetcher?: typeof fetch;
}): Promise<Buffer> {
  const config = input.config || readLocalGpuImageConfig();
  const fetcher = input.fetcher || fetch;
  let response: Response;
  if (input.outputId !== 'image-1' || !validIdentity(input.providerTaskId)) {
    throw new LocalGpuImageError('本地 GPU 原图编号无效', 'local_gpu_output_invalid', 'invalid');
  }
  try { response = await request(config, endpoint(config, `${API_PATH}/tasks/${encodeURIComponent(input.providerTaskId)}/outputs/image-1`),
    { method: 'GET', headers: headers(config, { Accept: 'image/png' }) }, QUERY_TIMEOUT_MS, fetcher); }
  catch { throw new LocalGpuImageError('本地 GPU 原图下载中断', 'local_gpu_download_unknown', 'unknown'); }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {});
    throw new LocalGpuImageError('本地 GPU 调用 Key 或访问权限配置有误', 'local_gpu_auth_failed', 'rejected', response.status);
  }
  if (response.status !== 200 || !response.body || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'image/png') {
    await response.body?.cancel().catch(() => {});
    throw new LocalGpuImageError('本地 GPU 原图暂不可下载', 'local_gpu_download_unknown', 'unknown', response.status);
  }
  const expectedLength = Number(response.headers.get('content-length'));
  const expectedSha256 = response.headers.get('x-content-sha256') || '';
  if (!Number.isSafeInteger(expectedLength) || expectedLength <= 0 || expectedLength > MAX_OUTPUT_BYTES
    || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    await response.body.cancel().catch(() => {});
    throw new LocalGpuImageError('本地 GPU 原图完整性信息缺失或无效', 'local_gpu_download_unknown', 'unknown');
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_OUTPUT_BYTES || length > expectedLength) throw new LocalGpuImageError('本地 GPU 原图超过交付长度', 'local_gpu_download_unknown', 'unknown');
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof LocalGpuImageError) throw error;
    throw new LocalGpuImageError('本地 GPU 原图下载中断；稍后读取原图', 'local_gpu_download_unknown', 'unknown');
  } finally { await reader.cancel().catch(() => {}); }
  if (!length) throw new LocalGpuImageError('本地 GPU 原图为空', 'local_gpu_output_empty', 'invalid');
  const bytes = Buffer.concat(chunks);
  if (length !== expectedLength || createHash('sha256').update(bytes).digest('hex') !== expectedSha256.toLowerCase()) {
    throw new LocalGpuImageError('本地 GPU 原图下载不完整；稍后读取原图', 'local_gpu_download_unknown', 'unknown');
  }
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR'
    || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20)
    || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > LOCAL_GPU_QWEN_PROFILE.maxPixels) {
    throw new LocalGpuImageError('本地 GPU 返回的 PNG 或图片尺寸无效', 'local_gpu_output_invalid', 'invalid');
  }
  // The existing asset chain fully decodes the PNG; a size mismatch alone must not discard a usable original.
  return bytes;
}
