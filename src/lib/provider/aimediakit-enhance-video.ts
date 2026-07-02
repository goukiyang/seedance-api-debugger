import type { LocalStatus, ProviderCreateResponse, ProviderStatusResponse } from '@/types';
import { normalizeProviderErrorMessage } from './error-message';

export const AI_MEDIAKIT_DEFAULT_BASE_URL = 'https://mediakit.cn-beijing.volces.com';
export const AI_MEDIAKIT_ENHANCE_VIDEO_PATH = '/api/v1/tools/enhance-video';
export const AI_MEDIAKIT_TASK_STATUS_PATH = '/api/v1/tasks';
export const AI_MEDIAKIT_REQUEST_UPLOAD_PATH = '/api/v1/tools-sync/request-media-upload-url';

const ENHANCE_VIDEO_RESOLUTIONS = ['240p', '360p', '480p', '540p', '720p', '1080p', '2k', '4k'] as const;
const ENHANCE_VIDEO_SCENES = ['common', 'ugc', 'short_series', 'aigc', 'old_film'] as const;
const ENHANCE_VIDEO_TOOL_VERSIONS = ['standard', 'professional'] as const;
const ENHANCE_VIDEO_ALLOWED_URL_PROTOCOLS = ['http:', 'https:', 'mediakit:', 'vod:', 'tos:'] as const;

export type EnhanceVideoToolVersion = typeof ENHANCE_VIDEO_TOOL_VERSIONS[number];
export type EnhanceVideoScene = typeof ENHANCE_VIDEO_SCENES[number];
export type EnhanceVideoResolution = typeof ENHANCE_VIDEO_RESOLUTIONS[number];

export interface AiMediaKitConfig {
  baseUrl: string;
  apiKeyConfigured: boolean;
  ready: boolean;
  missing: Array<'api_key'>;
}

export interface AiMediaKitRequestOptions {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  baseUrl?: string;
  signal?: AbortSignal;
}

export interface EnhanceVideoCreateInput {
  video_url: string;
  tool_version?: EnhanceVideoToolVersion;
  scene?: EnhanceVideoScene;
  resolution?: EnhanceVideoResolution;
  resolution_limit?: number;
  fps?: number;
  client_token?: string;
  callback_url?: string;
}

export interface EnhanceVideoCreatePayload {
  video_url: string;
  tool_version?: EnhanceVideoToolVersion;
  scene?: EnhanceVideoScene;
  resolution?: EnhanceVideoResolution;
  resolution_limit?: number;
  fps?: number;
  client_token?: string;
  callback_url?: string;
}

export interface EnhanceVideoCreateResponse extends ProviderCreateResponse {
  provider_task_id: string;
  raw: unknown;
}

export interface AiMediaKitErrorDetail {
  code?: string;
  message?: string;
  type?: string;
  param?: string;
  request_id?: string;
}

export interface EnhanceVideoStatusResponse extends ProviderStatusResponse {
  provider_task_id: string;
  provider_status: string;
  local_status: LocalStatus;
  result_video_url?: string;
  duration?: number;
  frames_per_second?: number;
  resolution?: string;
  tool_version?: string;
  error?: AiMediaKitErrorDetail;
  raw: unknown;
}

export interface RequestMediaUploadUrlInput {
  file_name: string;
  content_type?: string;
  content_length?: number;
  media_type?: string;
  client_token?: string;
}

export interface RequestMediaUploadUrlResponse {
  file_id: string;
  method: string;
  upload_headers: Record<string, string>;
  upload_url: string;
  raw: unknown;
}

export interface UploadMediaToAiMediaKitInput {
  upload_url: string;
  method: string;
  upload_headers: Record<string, string>;
  body: BodyInit;
}

export interface UploadMediaToAiMediaKitResponse {
  ok: boolean;
  status: number;
  raw: unknown;
}

export class AiMediaKitConfigurationError extends Error {
  code = 'aimediakit_not_configured';
  missing: Array<'api_key'>;

  constructor(missing: Array<'api_key'>) {
    super(`aimediakit_not_configured: missing ${missing.join(', ')}`);
    this.name = 'AiMediaKitConfigurationError';
    this.missing = missing;
  }
}

export class AiMediaKitRequestError extends Error {
  code = 'aimediakit_request_failed';
  statusCode?: number;
  error: AiMediaKitErrorDetail;
  raw?: unknown;

  constructor(input: {
    statusCode?: number;
    error: AiMediaKitErrorDetail;
    raw?: unknown;
  }) {
    super(formatAiMediaKitError(input.error) || 'AI MediaKit 请求失败');
    this.name = 'AiMediaKitRequestError';
    this.statusCode = input.statusCode;
    this.error = redactAiMediaKitErrorDetail(input.error);
    this.raw = input.raw;
  }
}

function readApiKey() {
  return (process.env.AI_MEDIAKIT_API_KEY || '').trim();
}

function cleanBaseUrl(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return AI_MEDIAKIT_DEFAULT_BASE_URL;
  return trimmed.replace(/\/+$/, '');
}

export function getAiMediaKitConfig(): AiMediaKitConfig {
  const apiKey = readApiKey();
  const missing: AiMediaKitConfig['missing'] = [];
  if (!apiKey) missing.push('api_key');

  return {
    baseUrl: cleanBaseUrl(process.env.AI_MEDIAKIT_BASE_URL),
    apiKeyConfigured: Boolean(apiKey),
    ready: missing.length === 0,
    missing,
  };
}

export function isAiMediaKitConfigured(): boolean {
  return Boolean(readApiKey());
}

async function resolvePrivateConfig(options?: AiMediaKitRequestOptions) {
  let configuredApiKey = readApiKey();
  let configuredBaseUrl = process.env.AI_MEDIAKIT_BASE_URL || '';

  if (!options?.apiKey) {
    const { getAiMediaKitApiSettings } = await import('@/lib/integrations/aimediakit');
    const settings = await getAiMediaKitApiSettings();
    configuredApiKey = settings.api_key || configuredApiKey;
    configuredBaseUrl = settings.base_url || configuredBaseUrl;
  }

  const apiKey = (options?.apiKey || configuredApiKey).trim();
  const baseUrl = cleanBaseUrl(options?.baseUrl || configuredBaseUrl);

  if (!apiKey) {
    throw new AiMediaKitConfigurationError(['api_key']);
  }

  return { apiKey, baseUrl };
}

function isAllowedValue<T extends readonly string[]>(value: string | undefined, allowed: T): value is T[number] {
  return Boolean(value && (allowed as readonly string[]).includes(value));
}

function validateClientToken(clientToken?: string) {
  if (clientToken === undefined) return;
  if (clientToken.length > 64) {
    throw new Error('client_token 最多 64 个字符');
  }
  for (const char of clientToken) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code > 0x7e) {
      throw new Error('client_token 只能包含 ASCII 可打印字符');
    }
  }
}

function normalizeVideoUrl(videoUrl?: string) {
  const trimmed = videoUrl?.trim();
  if (!trimmed) {
    throw new Error('AI MediaKit 画质增强缺少 video_url');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('video_url 协议只允许 http://、https://、mediakit://、vod://、tos://');
  }

  if (!ENHANCE_VIDEO_ALLOWED_URL_PROTOCOLS.includes(parsed.protocol as typeof ENHANCE_VIDEO_ALLOWED_URL_PROTOCOLS[number])) {
    throw new Error('video_url 协议只允许 http://、https://、mediakit://、vod://、tos://');
  }

  return trimmed;
}

export function validateEnhanceVideoCreateInput(input: EnhanceVideoCreateInput) {
  normalizeVideoUrl(input.video_url);

  if (input.tool_version && !isAllowedValue(input.tool_version, ENHANCE_VIDEO_TOOL_VERSIONS)) {
    throw new Error('tool_version 只允许 standard 或 professional');
  }

  if (input.scene && !isAllowedValue(input.scene, ENHANCE_VIDEO_SCENES)) {
    throw new Error('scene 取值无效');
  }

  if (input.resolution && !isAllowedValue(input.resolution, ENHANCE_VIDEO_RESOLUTIONS)) {
    throw new Error('resolution 只允许 240p/360p/480p/540p/720p/1080p/2k/4k');
  }

  if (input.resolution && input.resolution_limit !== undefined) {
    throw new Error('resolution 与 resolution_limit 不能同时传');
  }

  if (input.resolution_limit !== undefined) {
    if (!Number.isFinite(input.resolution_limit) || input.resolution_limit < 128 || input.resolution_limit > 2160) {
      throw new Error('resolution_limit 必须在 128 到 2160 之间');
    }
  }

  if (input.fps !== undefined) {
    if (!Number.isFinite(input.fps) || input.fps < 15 || input.fps > 120) {
      throw new Error('fps 必须在 15 到 120 之间');
    }
  }

  validateClientToken(input.client_token);
}

export function buildEnhanceVideoCreatePayload(input: EnhanceVideoCreateInput): EnhanceVideoCreatePayload {
  validateEnhanceVideoCreateInput(input);

  const payload: EnhanceVideoCreatePayload = {
    video_url: normalizeVideoUrl(input.video_url),
  };

  if (input.tool_version) payload.tool_version = input.tool_version;
  if (input.scene) payload.scene = input.scene;
  if (input.resolution) payload.resolution = input.resolution;
  if (input.resolution_limit !== undefined) payload.resolution_limit = input.resolution_limit;
  if (input.fps !== undefined) payload.fps = input.fps;
  if (input.client_token) payload.client_token = input.client_token;
  if (input.callback_url) payload.callback_url = input.callback_url;

  return payload;
}

export function mapAiMediaKitTaskStatus(status?: string | null): LocalStatus {
  const normalized = (status || '').trim().toLowerCase();
  if (['completed', 'succeeded', 'success', 'complete', 'done', 'finished'].includes(normalized)) return 'succeeded';
  if (['failed', 'failure', 'error'].includes(normalized)) return 'failed';
  if (['cancelled', 'canceled'].includes(normalized)) return 'cancelled';
  if (['queued', 'created', 'pending'].includes(normalized)) return 'submitted';
  if (['running', 'processing', 'in_progress'].includes(normalized)) return 'running';
  return 'running';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function pickNestedValue(value: unknown, paths: string[][]) {
  for (const path of paths) {
    let current = value;
    for (const key of path) {
      if (!isRecord(current)) {
        current = undefined;
        break;
      }
      current = current[key];
    }
    if (current !== undefined && current !== null) return current;
  }
  return undefined;
}

function pickNestedString(value: unknown, paths: string[][]) {
  const picked = pickNestedValue(value, paths);
  if (typeof picked === 'string' && picked.trim()) return picked.trim();
  if (typeof picked === 'number' && Number.isFinite(picked)) return String(picked);
  return undefined;
}

function pickNestedNumber(value: unknown, paths: string[][]) {
  const picked = pickNestedValue(value, paths);
  if (typeof picked === 'number' && Number.isFinite(picked)) return picked;
  if (typeof picked === 'string' && picked.trim() && Number.isFinite(Number(picked))) return Number(picked);
  return undefined;
}

function stringFromScalar(value: unknown) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return '';
}

function headersToRecord(headers?: HeadersInit) {
  const record: Record<string, string> = {};
  if (!headers) return record;

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      record[key] = value;
    }
    return record;
  }

  for (const [key, value] of Object.entries(headers)) {
    record[key] = String(value);
  }
  return record;
}

function normalizeUploadHeaders(value: unknown) {
  if (value === undefined || value === null) return {};

  if (isRecord(value)) {
    return Object.entries(value).reduce<Record<string, string>>((acc, [key, headerValue]) => {
      acc[key] = String(headerValue);
      return acc;
    }, {});
  }

  if (Array.isArray(value)) {
    return value.reduce<Record<string, string>>((acc, item) => {
      if (Array.isArray(item) && item.length >= 2) {
        acc[String(item[0])] = String(item[1]);
        return acc;
      }
      if (isRecord(item)) {
        const key = stringFromScalar(item.key ?? item.name ?? item.header);
        if (key) acc[key] = stringFromScalar(item.value ?? item.val ?? item.header_value);
      }
      return acc;
    }, {});
  }

  return null;
}

function getHeaderValue(headers: Record<string, string>, key: string) {
  const normalized = key.toLowerCase();
  return Object.entries(headers).find(([currentKey]) => currentKey.toLowerCase() === normalized)?.[1];
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw_text: text };
  }
}

function redactUrl(raw: string) {
  try {
    const parsed = new URL(raw);
    parsed.search = 'redacted=1';
    return parsed.toString();
  } catch {
    return raw.length > 80 ? `${raw.slice(0, 80)}...` : raw;
  }
}

export function redactAiMediaKitText(value: string): string {
  return value
    .replace(/\b(?:https?|mediakit|vod|tos):\/\/[^\s"'<>]+/gi, (url) => redactUrl(url))
    .replace(
      /\b(?:upload_url|authorization|api[_\s-]?key|apikey|auth_key|token|secret|signature|x-tos-signature)\b\s*[:=]\s*[^&\s,;)]+/gi,
      (match) => {
        const separator = match.includes(':') ? ':' : '=';
        const key = match.split(separator)[0]?.trim() || 'secret';
        return `${key}${separator} [redacted]`;
      },
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\bupload_url\b/gi, '[redacted_upload_url]');
}

function redactOptionalText(value?: string) {
  return value ? redactAiMediaKitText(value) : undefined;
}

function redactAiMediaKitErrorDetail(error: AiMediaKitErrorDetail): AiMediaKitErrorDetail {
  return {
    code: redactOptionalText(error.code),
    message: redactOptionalText(error.message),
    type: redactOptionalText(error.type),
    param: redactOptionalText(error.param),
    request_id: redactOptionalText(error.request_id),
  };
}

export function redactAiMediaKitLog<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactAiMediaKitLog(item)) as T;
  }
  if (typeof value === 'string') return redactAiMediaKitText(value) as T;
  if (!isRecord(value)) return value;

  return Object.entries(value).reduce<Record<string, unknown>>((acc, [key, current]) => {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === 'upload_url' ||
      normalizedKey.includes('authorization') ||
      normalizedKey.includes('api_key') ||
      normalizedKey.includes('apikey') ||
      normalizedKey.includes('auth_key') ||
      normalizedKey.includes('token') ||
      normalizedKey.includes('secret') ||
      normalizedKey.includes('signature')
    ) {
      acc[key] = '[redacted]';
    } else if (normalizedKey.includes('url') && typeof current === 'string') {
      acc[key] = redactUrl(current);
    } else if (typeof current === 'string') {
      acc[key] = redactAiMediaKitText(current);
    } else {
      acc[key] = redactAiMediaKitLog(current);
    }
    return acc;
  }, {}) as T;
}

export function parseAiMediaKitError(raw: unknown): AiMediaKitErrorDetail | undefined {
  const errorValue = pickNestedValue(raw, [
    ['error'],
    ['data', 'error'],
    ['result', 'error'],
    ['ResponseMetadata', 'Error'],
  ]) || raw;

  const detail: AiMediaKitErrorDetail = {
    code: pickNestedString(errorValue, [['code'], ['Code'], ['error_code'], ['errorCode']])
      || pickNestedString(raw, [['code'], ['Code']]),
    message: redactOptionalText(
      stringFromScalar(errorValue)
      || pickNestedString(errorValue, [['message'], ['Message'], ['error_message'], ['errorMessage'], ['msg'], ['detail']])
      || pickNestedString(raw, [['message'], ['Message']]),
    ),
    type: pickNestedString(errorValue, [['type'], ['Type']])
      || pickNestedString(raw, [['type'], ['Type']]),
    param: pickNestedString(errorValue, [['param'], ['Param']])
      || pickNestedString(raw, [['param'], ['Param']]),
    request_id: pickNestedString(errorValue, [['request_id'], ['requestId'], ['RequestId']])
      || pickNestedString(raw, [['request_id'], ['requestId'], ['RequestId'], ['ResponseMetadata', 'RequestId']]),
  };

  if (detail.code || detail.message || detail.type || detail.param) {
    return detail;
  }
  return undefined;
}

export function formatAiMediaKitError(error?: AiMediaKitErrorDetail) {
  if (!error) return undefined;
  const message = redactAiMediaKitText(error.message || normalizeProviderErrorMessage(error) || 'AI MediaKit 任务失败');
  const prefix = error.code ? `[${error.code}] ` : '';
  const suffix = [
    error.type ? `type=${error.type}` : '',
    error.param ? `param=${error.param}` : '',
    error.request_id ? `request_id=${error.request_id}` : '',
  ].filter(Boolean);

  return redactAiMediaKitText(suffix.length ? `${prefix}${message} (${suffix.join(', ')})` : `${prefix}${message}`);
}

async function requestAiMediaKitJson(
  path: string,
  init: RequestInit,
  config: { apiKey: string; baseUrl: string },
  options?: AiMediaKitRequestOptions,
) {
  const fetchImpl = options?.fetchImpl || globalThis.fetch;
  if (!fetchImpl) {
    throw new AiMediaKitRequestError({
      error: { code: 'NetworkError', message: 'fetch is not available', type: 'network' },
    });
  }

  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}${path}`, {
      ...init,
      signal: options?.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...headersToRecord(init.headers),
        Authorization: `Bearer ${config.apiKey}`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'network error';
    throw new AiMediaKitRequestError({
      error: { code: 'NetworkError', message: redactAiMediaKitText(message), type: 'network' },
    });
  }

  const body = await readResponseBody(response);
  if (!response.ok) {
    throw new AiMediaKitRequestError({
      statusCode: response.status,
      error: parseAiMediaKitError(body) || { code: `HTTP_${response.status}`, message: 'AI MediaKit 请求失败' },
      raw: redactAiMediaKitLog(body),
    });
  }

  return body;
}

export function parseEnhanceVideoCreateResponse(raw: unknown): EnhanceVideoCreateResponse {
  const providerTaskId = pickNestedString(raw, [
    ['task_id'],
    ['id'],
    ['data', 'task_id'],
    ['data', 'id'],
    ['result', 'task_id'],
    ['result', 'id'],
  ]);

  if (!providerTaskId) {
    throw new AiMediaKitRequestError({
      error: { code: 'InvalidCreateTaskResponse', message: 'AI MediaKit 创建响应缺少 task_id' },
      raw: redactAiMediaKitLog(raw),
    });
  }

  return {
    provider_task_id: providerTaskId,
    raw,
  };
}

export function parseEnhanceVideoStatusResponse(
  raw: unknown,
  fallbackTaskId?: string,
): EnhanceVideoStatusResponse {
  const providerTaskId = pickNestedString(raw, [
    ['task_id'],
    ['id'],
    ['data', 'task_id'],
    ['data', 'id'],
    ['result', 'task_id'],
    ['result', 'id'],
  ]) || fallbackTaskId || '';
  const providerStatus = pickNestedString(raw, [
    ['status'],
    ['data', 'status'],
    ['result', 'status'],
  ]) || 'unknown';
  const error = parseAiMediaKitError(raw);

  return {
    provider_task_id: providerTaskId,
    provider_status: providerStatus,
    local_status: mapAiMediaKitTaskStatus(providerStatus),
    result_video_url: pickNestedString(raw, [
      ['result', 'video_url'],
      ['result', 'video_url', 'url'],
      ['data', 'result', 'video_url'],
      ['data', 'result', 'video_url', 'url'],
      ['output', 'video_url'],
      ['video_url'],
    ]),
    duration: pickNestedNumber(raw, [
      ['result', 'duration'],
      ['data', 'result', 'duration'],
      ['output', 'duration'],
      ['duration'],
    ]),
    frames_per_second: pickNestedNumber(raw, [
      ['result', 'fps'],
      ['data', 'result', 'fps'],
      ['output', 'fps'],
      ['fps'],
    ]),
    resolution: pickNestedString(raw, [
      ['result', 'resolution'],
      ['data', 'result', 'resolution'],
      ['output', 'resolution'],
      ['resolution'],
    ]),
    tool_version: pickNestedString(raw, [
      ['result', 'tool_version'],
      ['data', 'result', 'tool_version'],
      ['output', 'tool_version'],
      ['tool_version'],
    ]),
    error_message: formatAiMediaKitError(error) || redactOptionalText(normalizeProviderErrorMessage(pickNestedValue(raw, [['error']]))),
    error,
    raw: redactAiMediaKitLog(raw),
  };
}

export function parseRequestMediaUploadUrlResponse(raw: unknown): RequestMediaUploadUrlResponse {
  const fileId = pickNestedString(raw, [
    ['file_id'],
    ['data', 'file_id'],
    ['result', 'file_id'],
  ]);
  const method = pickNestedString(raw, [
    ['method'],
    ['data', 'method'],
    ['result', 'method'],
  ]);
  const uploadUrl = pickNestedString(raw, [
    ['upload_url'],
    ['data', 'upload_url'],
    ['result', 'upload_url'],
  ]);
  const uploadHeaders = pickNestedValue(raw, [
    ['upload_headers'],
    ['data', 'upload_headers'],
    ['result', 'upload_headers'],
  ]);
  const normalizedUploadHeaders = normalizeUploadHeaders(uploadHeaders);

  if (!fileId || !method || !uploadUrl || normalizedUploadHeaders === null) {
    throw new AiMediaKitRequestError({
      error: { code: 'InvalidUploadUrlResponse', message: 'AI MediaKit 上传地址响应缺少必要字段' },
      raw: redactAiMediaKitLog(raw),
    });
  }

  return {
    file_id: fileId,
    method,
    upload_url: uploadUrl,
    upload_headers: normalizedUploadHeaders,
    raw,
  };
}

export async function createEnhanceVideoTask(
  input: EnhanceVideoCreateInput,
  options?: AiMediaKitRequestOptions,
): Promise<EnhanceVideoCreateResponse> {
  const config = await resolvePrivateConfig(options);
  const payload = buildEnhanceVideoCreatePayload(input);
  const raw = await requestAiMediaKitJson(
    AI_MEDIAKIT_ENHANCE_VIDEO_PATH,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    config,
    options,
  );

  return parseEnhanceVideoCreateResponse(raw);
}

export async function getAiMediaKitTaskStatus(
  providerTaskId: string,
  options?: AiMediaKitRequestOptions,
): Promise<EnhanceVideoStatusResponse> {
  const taskId = providerTaskId.trim();
  if (!taskId) {
    throw new Error('AI MediaKit 查询缺少任务 ID');
  }

  const config = await resolvePrivateConfig(options);
  const raw = await requestAiMediaKitJson(
    `${AI_MEDIAKIT_TASK_STATUS_PATH}/${encodeURIComponent(taskId)}`,
    { method: 'GET' },
    config,
    options,
  );

  return parseEnhanceVideoStatusResponse(raw, taskId);
}

export async function requestMediaUploadUrl(
  input: RequestMediaUploadUrlInput,
  options?: AiMediaKitRequestOptions,
): Promise<RequestMediaUploadUrlResponse> {
  const fileName = input.file_name.trim();
  if (!fileName) {
    throw new Error('AI MediaKit 上传地址申请缺少 file_name');
  }
  if (input.content_length !== undefined) {
    if (!Number.isFinite(input.content_length) || !Number.isInteger(input.content_length) || input.content_length <= 0) {
      throw new Error('content_length 必须是正整数');
    }
  }
  validateClientToken(input.client_token);

  const payload: Record<string, unknown> = {
    file_name: fileName,
  };
  if (input.content_type) payload.content_type = input.content_type;
  if (input.content_length !== undefined) payload.content_length = input.content_length;
  if (input.media_type) payload.media_type = input.media_type;
  if (input.client_token) payload.client_token = input.client_token;

  const config = await resolvePrivateConfig(options);
  const raw = await requestAiMediaKitJson(
    AI_MEDIAKIT_REQUEST_UPLOAD_PATH,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    config,
    options,
  );

  return parseRequestMediaUploadUrlResponse(raw);
}

export async function uploadMediaToAiMediaKit(
  input: UploadMediaToAiMediaKitInput,
  options?: AiMediaKitRequestOptions,
): Promise<UploadMediaToAiMediaKitResponse> {
  const fetchImpl = options?.fetchImpl || globalThis.fetch;
  if (!fetchImpl) {
    throw new AiMediaKitRequestError({
      error: { code: 'NetworkError', message: 'fetch is not available', type: 'network' },
    });
  }

  const headers = headersToRecord(input.upload_headers);
  const contentType = getHeaderValue(headers, 'Content-Type') || '';
  if (contentType.toLowerCase().includes('multipart/form-data')) {
    throw new Error('AI MediaKit 上传必须使用原始二进制，禁止 multipart/form-data');
  }
  if (typeof FormData !== 'undefined' && input.body instanceof FormData) {
    throw new Error('AI MediaKit 上传必须使用原始二进制，禁止 FormData');
  }

  let response: Response;
  try {
    response = await fetchImpl(input.upload_url, {
      method: input.method || 'PUT',
      headers,
      body: input.body,
      signal: options?.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'media upload failed';
    throw new AiMediaKitRequestError({
      error: { code: 'UploadNetworkError', message: redactAiMediaKitText(message), type: 'network' },
    });
  }

  const raw = await readResponseBody(response);
  if (!response.ok) {
    throw new AiMediaKitRequestError({
      statusCode: response.status,
      error: parseAiMediaKitError(raw) || { code: `HTTP_${response.status}`, message: 'AI MediaKit 上传失败' },
      raw: redactAiMediaKitLog(raw),
    });
  }

  return {
    ok: response.ok,
    status: response.status,
    raw,
  };
}
