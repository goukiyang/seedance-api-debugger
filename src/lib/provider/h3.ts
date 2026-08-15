import type { LocalStatus, ProviderCreateResponse, ProviderStatusResponse } from '@/types';
import {
  H3_DEFAULT_PRESET_ID,
  H3_GENERATE_PATH,
  H3_HEALTH_PATH,
  H3_PRESETS_PATH,
  H3_PRESET_OPTIONS,
  getH3ApiSettings,
  h3SettingsToRequestOptions,
  isH3PresetId,
  type H3PresetId,
} from '@/lib/integrations/h3';

export const H3_VIDEO_PROVIDER = 'h3';
export const H3_ALLOWED_PRESET_IDS = H3_PRESET_OPTIONS.map((option) => option.id);
export const H3_ALLOWED_ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const;
export const H3_INTERNAL_OUTPUT_SCHEME = 'h3-internal-output://';

type H3AspectRatio = typeof H3_ALLOWED_ASPECT_RATIOS[number];
type H3FetchOptions = {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  apiToken?: string;
  adminToken?: string;
  signal?: AbortSignal;
  idempotencyKey?: string | null;
};

export type H3GenerateInput = {
  preset_id?: string;
  prompt: string;
  audio_prompt?: string | null;
  music_prompt?: string | null;
  aspect_ratio?: string;
  duration_sec?: number;
  seed?: number;
  first_frame?: string | null;
  last_frame?: string | null;
  metadata?: Record<string, unknown>;
  width?: number;
  height?: number;
};

export type H3GeneratePayload = {
  preset_id: H3PresetId;
  prompt: string;
  audio_prompt?: string;
  music_prompt?: string;
  aspect_ratio: H3AspectRatio;
  duration_sec: number;
  seed: number;
  first_frame?: string;
  last_frame?: string;
  metadata?: Record<string, unknown>;
};

export type H3ReferenceImageUploadInput = {
  filename: string;
  contentB64: string;
};

export type H3ReferenceImageUploadResult = {
  filename: string;
  original_filename?: string;
  size_bytes?: number;
  sha256?: string;
  width?: number;
  height?: number;
  mime_type?: string;
  raw: unknown;
};

export type H3JobOutput = {
  index: number;
  filename?: string;
  kind?: string;
  type?: string;
  download_url?: string;
  content_type?: string;
  size_bytes?: number;
  duration_sec?: number;
  width?: number;
  height?: number;
  fps?: number;
  sha256?: string;
};

export type H3OutputsResult = {
  job_id: string;
  outputs: H3JobOutput[];
  raw: unknown;
};

export class H3ConfigurationError extends Error {
  code = 'h3_not_configured';

  constructor(message = 'H3 本地生成服务未配置，请管理员先在 API 设置页填写 H3 地址和用户 token。') {
    super(message);
    this.name = 'H3ConfigurationError';
  }
}

export class H3RequestError extends Error {
  code = 'h3_request_failed';
  statusCode?: number;
  retryAfterSeconds?: number;
  raw?: unknown;

  constructor(input: {
    message: string;
    statusCode?: number;
    retryAfterSeconds?: number;
    raw?: unknown;
  }) {
    super(input.message);
    this.name = 'H3RequestError';
    this.statusCode = input.statusCode;
    this.retryAfterSeconds = input.retryAfterSeconds;
    this.raw = input.raw;
  }
}

export type H3BillingInfo = {
  charged?: boolean;
  cost?: number;
  currency?: string | null;
  cost_model?: string | null;
};

export type H3QueueInfo = {
  paused?: boolean;
  pending?: number;
  running?: number;
  max_pending_jobs?: number;
  active?: number;
  max_active_jobs?: number;
};

export type H3HealthResponse = {
  api?: string;
  version?: string;
  public_base_url?: string | null;
  worker_url?: string;
  default_preset?: string;
  preset_count?: number;
  billing?: H3BillingInfo;
  worker?: { worker?: string; comfyui?: string };
  queue?: H3QueueInfo;
};

function cleanBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '');
}

function cleanPathSegment(value: string) {
  return encodeURIComponent(value.trim());
}

function cleanOptionalString(value: string | null | undefined) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeRetryAfter(value: string | null) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

async function resolveOptions(options: H3FetchOptions = {}, requireToken: 'none' | 'api' | 'admin' = 'api') {
  let baseUrl = options.baseUrl;
  let apiToken = options.apiToken;
  let adminToken = options.adminToken;

  if (!baseUrl || (requireToken === 'api' && !apiToken) || (requireToken === 'admin' && !adminToken)) {
    const settings = await getH3ApiSettings();
    const resolved = h3SettingsToRequestOptions(settings);
    baseUrl = baseUrl || resolved.baseUrl;
    apiToken = apiToken || resolved.apiToken;
    adminToken = adminToken || resolved.adminToken;
  }

  if (!baseUrl) throw new H3ConfigurationError('H3 API 地址未配置');
  if (requireToken === 'api' && !apiToken) throw new H3ConfigurationError();
  if (requireToken === 'admin' && !adminToken) {
    throw new H3ConfigurationError('H3 队列管理缺少管理员 token，请先在 API 设置页配置。');
  }

  return {
    baseUrl: cleanBaseUrl(baseUrl),
    apiToken,
    adminToken,
    fetchImpl: options.fetchImpl || fetch,
    signal: options.signal,
  };
}

async function readResponseBody(response: Response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  const text = await response.text().catch(() => '');
  return text || null;
}

function messageForHttpStatus(status: number, body: unknown) {
  const providerMessage = body && typeof body === 'object'
    ? String((body as Record<string, unknown>).message || (body as Record<string, unknown>).error || '')
    : typeof body === 'string'
      ? body
      : '';
  if (status === 400) return providerMessage || 'H3 请求参数无效。';
  if (status === 401) return 'H3 用户 token 无效或缺失，请管理员检查 API 设置。';
  if (status === 403) return 'H3 管理员权限不足，请检查 admin token。';
  if (status === 404) return 'H3 任务或输出不存在。';
  if (status === 502) return 'H3 worker 或 ComfyUI 上游异常，请稍后重试。';
  if (status === 503) return providerMessage || 'H3 队列已满或工作站不可用，请稍后重试。';
  return providerMessage || `H3 请求失败（HTTP ${status}）`;
}

async function requestJson<T>(
  path: string,
  options: H3FetchOptions & {
    method?: string;
    body?: unknown;
    token?: 'none' | 'api' | 'admin';
  } = {},
): Promise<T> {
  const tokenKind = options.token || 'api';
  const resolved = await resolveOptions(options, tokenKind);
  const token = tokenKind === 'api' ? resolved.apiToken : tokenKind === 'admin' ? resolved.adminToken : undefined;
  const idempotencyKey = cleanOptionalString(options.idempotencyKey);
  const headers: Record<string, string> = {
    ...(token ? authHeaders(token) : {}),
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
  };
  const response = await resolved.fetchImpl(`${resolved.baseUrl}${path}`, {
    method: options.method || (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: resolved.signal,
  });
  const responseBody = await readResponseBody(response);

  if (!response.ok) {
    throw new H3RequestError({
      statusCode: response.status,
      retryAfterSeconds: normalizeRetryAfter(response.headers.get('retry-after')),
      message: messageForHttpStatus(response.status, responseBody),
      raw: responseBody,
    });
  }

  return responseBody as T;
}

export function buildH3GeneratePayload(input: H3GenerateInput): H3GeneratePayload {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('H3 生成缺少提示词');

  const presetId = input.preset_id || H3_DEFAULT_PRESET_ID;
  if (!isH3PresetId(presetId)) {
    throw new Error(`H3 preset 只允许 ${H3_ALLOWED_PRESET_IDS.join(', ')}`);
  }

  const aspectRatio = input.aspect_ratio || '16:9';
  if (!H3_ALLOWED_ASPECT_RATIOS.includes(aspectRatio as H3AspectRatio)) {
    throw new Error(`H3 比例只允许 ${H3_ALLOWED_ASPECT_RATIOS.join(', ')}`);
  }

  const durationSec = input.duration_sec === undefined ? 5 : Number(input.duration_sec);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error('H3 时长必须是有效秒数');
  }
  if (durationSec > 15) throw new Error('H3 时长最多 15 秒');

  const seed = input.seed === undefined ? -1 : Number(input.seed);
  if (!Number.isSafeInteger(seed) || seed < -1) {
    throw new Error('H3 seed 只允许 -1 或安全整数');
  }

  const payload: H3GeneratePayload = {
    preset_id: presetId,
    prompt,
    aspect_ratio: aspectRatio as H3AspectRatio,
    duration_sec: Math.floor(durationSec),
    seed,
  };
  const audioPrompt = cleanOptionalString(input.audio_prompt);
  const musicPrompt = cleanOptionalString(input.music_prompt);
  const firstFrame = cleanOptionalString(input.first_frame);
  const lastFrame = cleanOptionalString(input.last_frame);

  if (audioPrompt) payload.audio_prompt = audioPrompt;
  if (musicPrompt) payload.music_prompt = musicPrompt;
  if (firstFrame) payload.first_frame = firstFrame;
  if (lastFrame) payload.last_frame = lastFrame;
  if (input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)) {
    payload.metadata = input.metadata;
  }

  return payload;
}

export async function getH3Health(options: H3FetchOptions = {}) {
  return requestJson<H3HealthResponse>(H3_HEALTH_PATH, { ...options, token: 'none' });
}

export async function listH3Presets(options: H3FetchOptions = {}) {
  return requestJson<unknown>(H3_PRESETS_PATH, { ...options, token: 'api' });
}

export async function uploadH3ReferenceImage(
  input: H3ReferenceImageUploadInput,
  options: H3FetchOptions = {},
): Promise<H3ReferenceImageUploadResult> {
  const filename = input.filename.trim();
  if (!filename) throw new Error('H3 参考图缺少文件名');
  if (!input.contentB64.trim()) throw new Error('H3 参考图缺少 base64 内容');

  const raw = await requestJson<Record<string, unknown>>('/api/h3/inputs/images', {
    ...options,
    token: 'api',
    method: 'POST',
    body: {
      filename,
      content_b64: input.contentB64,
    },
  });

  const h3Filename = typeof raw.filename === 'string' ? raw.filename.trim() : '';
  if (!h3Filename) throw new H3RequestError({ message: 'H3 参考图上传响应缺少 filename', raw });

  return {
    filename: h3Filename,
    original_filename: typeof raw.original_filename === 'string' ? raw.original_filename : undefined,
    size_bytes: typeof raw.size_bytes === 'number' ? raw.size_bytes : undefined,
    sha256: typeof raw.sha256 === 'string' ? raw.sha256 : undefined,
    width: typeof raw.width === 'number' ? raw.width : undefined,
    height: typeof raw.height === 'number' ? raw.height : undefined,
    mime_type: typeof raw.mime_type === 'string' ? raw.mime_type : undefined,
    raw,
  };
}

export async function createH3VideoJob(
  input: H3GenerateInput,
  options: H3FetchOptions = {},
): Promise<ProviderCreateResponse> {
  const payload = buildH3GeneratePayload(input);
  const raw = await requestJson<Record<string, unknown>>(H3_GENERATE_PATH, {
    ...options,
    token: 'api',
    method: 'POST',
    body: payload,
  });
  const jobId = typeof raw.job_id === 'string' ? raw.job_id.trim() : '';
  if (!jobId) throw new H3RequestError({ message: 'H3 创建任务响应缺少 job_id', raw });
  return { provider_task_id: jobId, raw };
}

function mapH3JobStatus(status?: string | null): LocalStatus {
  const normalized = (status || '').trim().toLowerCase();
  if (normalized === 'done') return 'succeeded';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'deleted') return 'cancelled';
  if (['pending', 'dispatching', 'queued'].includes(normalized)) return 'submitted';
  if (normalized === 'running') return 'running';
  return 'running';
}

function firstVideoOutput(outputs: unknown): H3JobOutput | null {
  if (!Array.isArray(outputs)) return null;
  for (const item of outputs) {
    if (!item || typeof item !== 'object') continue;
    const output = item as H3JobOutput;
    if (output.kind === 'video' || output.filename?.toLowerCase().endsWith('.mp4') || output.download_url) {
      return output;
    }
  }
  return null;
}

export function h3InternalOutputUrl(jobId: string, index = 0) {
  return `${H3_INTERNAL_OUTPUT_SCHEME}${jobId}/${index}`;
}

export function isH3InternalOutputUrl(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(H3_INTERNAL_OUTPUT_SCHEME);
}

export function parseH3InternalOutputUrl(value: string | null | undefined) {
  if (!isH3InternalOutputUrl(value)) return null;
  const tail = value.slice(H3_INTERNAL_OUTPUT_SCHEME.length);
  const [jobId, indexText] = tail.split('/');
  const index = Number(indexText);
  if (!jobId || !Number.isInteger(index) || index < 0) return null;
  return { jobId, index };
}

export async function getH3JobStatus(jobId: string, options: H3FetchOptions = {}) {
  return requestJson<Record<string, unknown>>(`/api/h3/jobs/${cleanPathSegment(jobId)}`, {
    ...options,
    token: 'api',
  });
}

export async function getH3TaskStatus(
  jobId: string,
  options: H3FetchOptions = {},
): Promise<ProviderStatusResponse> {
  const raw = await getH3JobStatus(jobId, options);
  const providerStatus = typeof raw.status === 'string' ? raw.status : 'unknown';
  const localStatus = mapH3JobStatus(providerStatus);
  const output = firstVideoOutput(raw.outputs);
  const resolved = raw.resolved && typeof raw.resolved === 'object'
    ? raw.resolved as Record<string, unknown>
    : {};
  const request = raw.request && typeof raw.request === 'object'
    ? raw.request as Record<string, unknown>
    : {};
  const preset = typeof raw.preset === 'string'
    ? raw.preset
    : typeof request.preset_id === 'string'
      ? request.preset_id
      : undefined;
  const seed = typeof resolved.seed === 'number'
    ? resolved.seed
    : typeof request.seed === 'number'
      ? request.seed
      : undefined;

  if (localStatus === 'succeeded' && !output) {
    const errorMessage = 'H3 任务已完成但没有返回视频输出';
    return {
      provider_task_id: jobId,
      provider_status: providerStatus,
      local_status: 'failed',
      provider_model: preset,
      seed,
      ratio: typeof request.aspect_ratio === 'string' ? request.aspect_ratio : undefined,
      duration: typeof request.duration_sec === 'number' ? request.duration_sec : undefined,
      error_message: errorMessage,
      raw: {
        ...raw,
        code: 'h3_done_without_output',
        error: errorMessage,
      },
    };
  }

  return {
    provider_task_id: jobId,
    provider_status: providerStatus,
    local_status: localStatus,
    result_video_url: localStatus === 'succeeded' && output ? h3InternalOutputUrl(jobId, output.index || 0) : undefined,
    provider_model: preset,
    seed,
    ratio: typeof request.aspect_ratio === 'string' ? request.aspect_ratio : undefined,
    duration: typeof request.duration_sec === 'number' ? request.duration_sec : undefined,
    error_message: typeof raw.error === 'string' ? raw.error : undefined,
    raw,
  };
}

export async function listH3JobOutputs(jobId: string, options: H3FetchOptions = {}): Promise<H3OutputsResult> {
  const raw = await requestJson<Record<string, unknown>>(`/api/h3/jobs/${cleanPathSegment(jobId)}/outputs`, {
    ...options,
    token: 'api',
  });
  return {
    job_id: typeof raw.job_id === 'string' ? raw.job_id : jobId,
    outputs: Array.isArray(raw.outputs) ? raw.outputs as H3JobOutput[] : [],
    raw,
  };
}

export async function downloadH3JobOutput(jobId: string, index: number, options: H3FetchOptions = {}) {
  const resolved = await resolveOptions(options, 'api');
  const response = await resolved.fetchImpl(
    `${resolved.baseUrl}/api/h3/jobs/${cleanPathSegment(jobId)}/outputs/${index}`,
    {
      method: 'GET',
      headers: authHeaders(resolved.apiToken || ''),
      signal: resolved.signal,
    },
  );
  if (!response.ok) {
    const body = await readResponseBody(response);
    throw new H3RequestError({
      statusCode: response.status,
      retryAfterSeconds: normalizeRetryAfter(response.headers.get('retry-after')),
      message: messageForHttpStatus(response.status, body),
      raw: body,
    });
  }
  return {
    contentType: response.headers.get('content-type') || 'video/mp4',
    data: await response.arrayBuffer(),
  };
}

export async function getH3QueueState(options: H3FetchOptions = {}) {
  return requestJson<unknown>('/api/h3/queue', { ...options, token: 'admin' });
}

export async function postH3AdminAction(path: string, body: Record<string, unknown>, options: H3FetchOptions = {}) {
  return requestJson<unknown>(path, {
    ...options,
    token: 'admin',
    method: 'POST',
    body,
  });
}
