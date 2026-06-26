import type {
  CreateVideoInput,
  GenerationMode,
  LocalStatus,
  ProviderCreateResponse,
  ProviderStatusResponse,
} from '@/types';
import {
  VOLCENGINE_IP_CREATE_TASK_PATH,
  getVolcengineIpApiSettings,
  isVolcengineIpApiReady,
} from '@/lib/integrations/volcengine-ip';

export const VOLCENGINE_IP_VIDEO_PROVIDER = 'volcengine_ark';

type VolcengineIpErrorCategory =
  | 'auth'
  | 'permission'
  | 'quota'
  | 'rate_limit'
  | 'content_safety'
  | 'asset'
  | 'provider'
  | 'network'
  | 'unknown';

type VolcengineIpContentItem =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string }; role?: string }
  | { type: 'video_url'; video_url: { url: string }; role?: string }
  | { type: 'audio_url'; audio_url: { url: string }; role?: string };

export type VolcengineIpCreatePayload = {
  model: string;
  content: VolcengineIpContentItem[];
  callback_url?: string;
  client_request_id?: string;
  duration?: number;
  ratio?: string;
  resolution?: string;
  seed?: number;
  generate_audio?: boolean;
  return_last_frame?: boolean;
  watermark?: boolean;
  service_tier?: string;
  execution_expires_after?: number;
};

type NormalizedVolcengineIpError = {
  code: string;
  category: VolcengineIpErrorCategory;
  retryable: boolean;
  userMessage: string;
  providerMessage?: string;
  statusCode?: number;
};

type PrivateConfig = {
  apiKey: string;
  model: string;
  baseUrl: string;
};

export type VolcengineIpRequestOptions = {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  signal?: AbortSignal;
};

export type VolcengineIpTaskListParams = {
  page_num?: number;
  page_size?: number;
  filter_status?: string;
  filter_task_ids?: string[];
  filter_model?: string;
  filter_created_after?: string;
  filter_created_before?: string;
};

export type VolcengineIpTaskListResult = {
  items: unknown[];
  total?: number;
  raw: unknown;
};

export type VolcengineIpDeleteTaskResult = {
  provider_task_id: string;
  deleted: boolean;
  raw: unknown;
};

export class VolcengineIpConfigurationError extends Error {
  code = 'volcengine_ip_not_configured';
  missing: Array<'api_key' | 'model'>;

  constructor(missing: Array<'api_key' | 'model'>) {
    super(`volcengine_ip_not_configured: missing ${missing.join(', ')}`);
    this.name = 'VolcengineIpConfigurationError';
    this.missing = missing;
  }
}

export class VolcengineIpRequestError extends Error {
  code = 'volcengine_ip_request_failed';
  statusCode?: number;
  normalized: NormalizedVolcengineIpError;
  raw?: unknown;

  constructor(input: {
    statusCode?: number;
    normalized: NormalizedVolcengineIpError;
    raw?: unknown;
  }) {
    super(input.normalized.providerMessage || input.normalized.userMessage);
    this.name = 'VolcengineIpRequestError';
    this.statusCode = input.statusCode;
    this.normalized = input.normalized;
    this.raw = input.raw;
  }
}

function cleanBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '');
}

function addUrlItems(
  content: VolcengineIpContentItem[],
  type: 'image_url' | 'video_url' | 'audio_url',
  urls: string[] | undefined,
  role?: string,
  limit?: number,
) {
  for (const rawUrl of (urls || []).slice(0, limit || urls?.length || 0)) {
    const url = rawUrl.trim();
    if (!url) continue;
    if (type === 'image_url') content.push({ type, image_url: { url }, role });
    if (type === 'video_url') content.push({ type, video_url: { url }, role });
    if (type === 'audio_url') content.push({ type, audio_url: { url }, role });
  }
}

export function buildVolcengineIpCreatePayload(
  input: CreateVideoInput & { generation_mode: GenerationMode; model: string; service_tier?: string },
): VolcengineIpCreatePayload {
  const model = input.model.trim();
  if (!model) throw new Error('火山 IP 生成缺少 Model ID');

  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('火山 IP 生成缺少提示词');

  const mediaContent: VolcengineIpContentItem[] = [];

  switch (input.generation_mode) {
    case 'first_last_frame':
      addUrlItems(mediaContent, 'image_url', [
        input.first_frame_base64_data || input.first_frame_url || '',
      ], 'first_frame', 1);
      addUrlItems(mediaContent, 'image_url', [
        input.last_frame_base64_data || input.last_frame_url || '',
      ], 'last_frame', 1);
      break;
    case 'smart_multi_frame':
      addUrlItems(
        mediaContent,
        'image_url',
        input.frame_image_base64_data?.length ? input.frame_image_base64_data : input.frame_image_urls,
        'reference_image',
        9,
      );
      break;
    case 'all_in_one_reference':
    default:
      addUrlItems(
        mediaContent,
        'image_url',
        input.reference_image_base64_data?.length ? input.reference_image_base64_data : input.reference_image_urls,
        'reference_image',
        9,
      );
      addUrlItems(mediaContent, 'video_url', input.reference_video_urls, 'reference_video', 3);
      addUrlItems(mediaContent, 'audio_url', input.reference_audio_urls, 'reference_audio', 3);
      break;
  }

  // 火山官方示例以文本项开头，再跟参考素材；这里按官方顺序生成 content。
  const content: VolcengineIpContentItem[] = [{ type: 'text', text: prompt }, ...mediaContent];

  const payload: VolcengineIpCreatePayload = { model, content };
  const clientRequestId = (input.client_request_id || input.clientRequestId || '').trim();

  if (input.callback_url) payload.callback_url = input.callback_url;
  if (clientRequestId) payload.client_request_id = clientRequestId;
  if (input.duration !== undefined) payload.duration = input.duration;
  if (input.ratio) payload.ratio = input.ratio;
  if (input.resolution) payload.resolution = input.resolution;
  if (input.seed !== undefined && input.seed >= 0) payload.seed = input.seed;
  if (input.generate_audio !== undefined) payload.generate_audio = input.generate_audio;
  if (input.return_last_frame !== undefined) payload.return_last_frame = input.return_last_frame;
  if (input.watermark !== undefined) payload.watermark = input.watermark;
  if (input.service_tier) payload.service_tier = input.service_tier;
  if (input.execution_expires_after !== undefined) {
    payload.execution_expires_after = input.execution_expires_after;
  }

  return payload;
}

export function mapVolcengineTaskStatus(status?: string | null): LocalStatus {
  const normalized = (status || '').trim().toLowerCase();
  if (['succeeded', 'success', 'completed', 'complete'].includes(normalized)) return 'succeeded';
  if (['failed', 'fail', 'error', 'expired'].includes(normalized)) return 'failed';
  if (['cancelled', 'canceled', 'deleted', 'delete'].includes(normalized)) return 'cancelled';
  if (['queued', 'created', 'pending', 'submitted'].includes(normalized)) return 'submitted';
  return 'running';
}

function pickNestedString(value: unknown, paths: string[][]) {
  for (const path of paths) {
    let current = value;
    for (const key of path) {
      if (!current || typeof current !== 'object') {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[key];
    }
    if (typeof current === 'string' && current.trim()) return current.trim();
    if (typeof current === 'number' && Number.isFinite(current)) return String(current);
  }
  return undefined;
}

function pickNestedValue(value: unknown, paths: string[][]) {
  for (const path of paths) {
    let current = value;
    for (const key of path) {
      if (!current || typeof current !== 'object') {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[key];
    }
    if (current !== undefined && current !== null) return current;
  }
  return undefined;
}

function pickNestedNumber(value: unknown, paths: string[][]) {
  const current = pickNestedValue(value, paths);
  if (typeof current === 'number' && Number.isFinite(current)) return current;
  if (typeof current === 'string' && current.trim() && Number.isFinite(Number(current))) {
    return Number(current);
  }
  return undefined;
}

function categorizeVolcengineError(code: string, statusCode?: number): VolcengineIpErrorCategory {
  const normalized = code.toLowerCase();
  if (statusCode === 401 || normalized.includes('apikey') || normalized.includes('authentication')) return 'auth';
  if (
    statusCode === 403 ||
    normalized.includes('accessdenied') ||
    normalized.includes('permission') ||
    normalized.includes('modelnotopen') ||
    normalized.includes('notopen') ||
    normalized.includes('not activated')
  ) {
    return 'permission';
  }
  if (statusCode === 429 || normalized.includes('ratelimit')) return 'rate_limit';
  if (normalized.includes('quota') || normalized.includes('overdue') || normalized.includes('balance')) return 'quota';
  if (
    normalized.includes('sensitive') ||
    normalized.includes('copyright') ||
    normalized.includes('safety') ||
    normalized.includes('risk')
  ) {
    return 'content_safety';
  }
  if (
    normalized.includes('asset') ||
    normalized.includes('tos') ||
    normalized.includes('download') ||
    normalized.includes('url')
  ) {
    return 'asset';
  }
  if (statusCode && statusCode >= 500) return 'provider';
  if (normalized.includes('timeout') || normalized.includes('network')) return 'network';
  return 'unknown';
}

function userMessageForCategory(category: VolcengineIpErrorCategory) {
  switch (category) {
    case 'auth':
      return '火山 API Key 无效或未配置，请管理员检查 API 整合页配置。';
    case 'permission':
      return '当前火山账号没有这个模型、接口或素材权限，请确认模型已开通。';
    case 'quota':
      return '火山资源包、余额或额度不足，请先补充额度后再生成。';
    case 'rate_limit':
      return '火山请求太频繁，请稍后重试。';
    case 'content_safety':
      return '火山内容安全或版权审核未通过，请调整提示词或素材授权信息。';
    case 'asset':
      return '火山无法使用当前素材，请检查素材 URL、asset:// 权限或素材审核状态。';
    case 'provider':
      return '火山服务暂时异常，请稍后重试。';
    case 'network':
      return '连接火山服务超时或网络异常，请稍后重试。';
    default:
      return '火山生成失败，请查看后台错误详情。';
  }
}

function normalizeVolcengineIpError(input: {
  statusCode?: number;
  raw?: unknown;
  fallbackMessage?: string;
}): NormalizedVolcengineIpError {
  const code = pickNestedString(input.raw, [
    ['error', 'code'],
    ['error', 'Code'],
    ['Error', 'Code'],
    ['ResponseMetadata', 'Error', 'Code'],
    ['code'],
    ['Code'],
  ]) || (input.statusCode ? `HTTP_${input.statusCode}` : 'VOLCENGINE_IP_UNKNOWN_ERROR');
  const providerMessage = pickNestedString(input.raw, [
    ['error', 'message'],
    ['error', 'Message'],
    ['Error', 'Message'],
    ['ResponseMetadata', 'Error', 'Message'],
    ['message'],
    ['Message'],
  ]) || input.fallbackMessage;
  const category = categorizeVolcengineError(code, input.statusCode);

  return {
    code,
    category,
    retryable: category === 'rate_limit' || category === 'network' || category === 'provider',
    userMessage: userMessageForCategory(category),
    providerMessage,
    statusCode: input.statusCode,
  };
}

function redactUrl(raw: string) {
  try {
    const parsed = new URL(raw);
    parsed.search = parsed.search ? 'redacted=1' : '';
    return parsed.toString();
  } catch {
    return raw.length > 80 ? `${raw.slice(0, 80)}...` : raw;
  }
}

export function redactVolcengineIpLog<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redactVolcengineIpLog(item)) as T;
  if (!value || typeof value !== 'object') return value;

  return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>((acc, [key, current]) => {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.includes('authorization') ||
      normalizedKey.includes('api_key') ||
      normalizedKey.includes('apikey') ||
      normalizedKey.includes('token') ||
      normalizedKey.includes('secret') ||
      normalizedKey.includes('signature')
    ) {
      acc[key] = '[redacted]';
    } else if (normalizedKey.includes('url') && typeof current === 'string') {
      acc[key] = redactUrl(current);
    } else {
      acc[key] = redactVolcengineIpLog(current);
    }
    return acc;
  }, {}) as T;
}

const SENSITIVE_USER_MESSAGE_PATTERN = /https?:\/\/|x-tos-|x-amz-|signature|credential|authorization|api[_ -]?key|apikey|token|secret|bearer|responsemetadata|火山返回|modelnotopen|accessdenied|invalidparameter/i;

export function safeVolcengineIpUserMessage(
  message: string | null | undefined,
  fallback = '火山任务处理失败，请管理员查看后台错误详情。',
) {
  const trimmed = typeof message === 'string' ? message.trim() : '';
  if (!trimmed) return null;
  if (SENSITIVE_USER_MESSAGE_PATTERN.test(trimmed)) return fallback;
  return trimmed.slice(0, 300);
}

async function resolvePrivateConfig(
  options: VolcengineIpRequestOptions | undefined,
  requireModel: boolean,
): Promise<PrivateConfig> {
  const settings = await getVolcengineIpApiSettings();
  const apiKey = (options?.apiKey || settings.api_key || '').trim();
  const model = (options?.model || settings.default_model || '').trim();
  const baseUrl = cleanBaseUrl(options?.baseUrl || settings.base_url);
  const missing: Array<'api_key' | 'model'> = [];

  if (!options?.apiKey && !isVolcengineIpApiReady(settings)) {
    if (!settings.api_key) missing.push('api_key');
    if (!settings.default_model) missing.push('model');
    throw new VolcengineIpConfigurationError(missing.length ? missing : ['api_key']);
  }
  if (!apiKey) missing.push('api_key');
  if (requireModel && !model) missing.push('model');
  if (missing.length) throw new VolcengineIpConfigurationError(missing);

  return { apiKey, model, baseUrl };
}

function buildTaskUrl(baseUrl: string, providerTaskId?: string) {
  if (!providerTaskId) return `${baseUrl}${VOLCENGINE_IP_CREATE_TASK_PATH}`;
  return `${baseUrl}${VOLCENGINE_IP_CREATE_TASK_PATH}/${encodeURIComponent(providerTaskId)}`;
}

async function readResponseBody(response: Response) {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw_text: text };
  }
}

async function requestVolcengineIpJson(
  url: string,
  init: RequestInit,
  config: PrivateConfig,
  options?: VolcengineIpRequestOptions,
) {
  const fetchImpl = options?.fetchImpl || globalThis.fetch;
  if (!fetchImpl) {
    throw new VolcengineIpRequestError({
      normalized: normalizeVolcengineIpError({
        raw: { error: { code: 'NetworkError', message: 'fetch is not available' } },
      }),
    });
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: options?.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        ...(init.headers || {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'network error';
    throw new VolcengineIpRequestError({
      normalized: normalizeVolcengineIpError({
        raw: { error: { code: 'NetworkError', message } },
        fallbackMessage: message,
      }),
    });
  }

  const body = await readResponseBody(response);
  if (!response.ok) {
    throw new VolcengineIpRequestError({
      statusCode: response.status,
      normalized: normalizeVolcengineIpError({ statusCode: response.status, raw: body }),
      raw: redactVolcengineIpLog(body),
    });
  }

  const providerErrorBody = pickNestedValue(body, [
    ['error'],
    ['Error'],
    ['ResponseMetadata', 'Error'],
  ]);
  const topLevelErrorCode = pickNestedString(body, [['code'], ['Code']]);
  const hasKnownSuccessShape = Boolean(
    pickNestedString(body, [['id'], ['task_id'], ['data', 'id'], ['data', 'task_id'], ['result', 'id'], ['result', 'task_id']])
    || Array.isArray(pickNestedValue(body, [['items'], ['data', 'items'], ['tasks'], ['data', 'tasks'], ['result', 'items']])),
  );
  if (providerErrorBody || (topLevelErrorCode && !hasKnownSuccessShape)) {
    throw new VolcengineIpRequestError({
      statusCode: response.status,
      normalized: normalizeVolcengineIpError({ statusCode: response.status, raw: body }),
      raw: redactVolcengineIpLog(body),
    });
  }

  return body;
}

function parseCreateResponse(raw: unknown): ProviderCreateResponse {
  const providerTaskId = pickNestedString(raw, [
    ['id'],
    ['task_id'],
    ['data', 'id'],
    ['data', 'task_id'],
    ['result', 'id'],
    ['result', 'task_id'],
  ]);

  if (!providerTaskId) {
    throw new VolcengineIpRequestError({
      normalized: normalizeVolcengineIpError({
        raw: { error: { code: 'InvalidCreateTaskResponse', message: 'missing task id' } },
      }),
      raw: redactVolcengineIpLog(raw),
    });
  }

  return { provider_task_id: providerTaskId, raw };
}

export function parseVolcengineIpStatusResponse(
  raw: unknown,
  fallbackTaskId?: string,
): ProviderStatusResponse {
  const providerTaskId = pickNestedString(raw, [
    ['id'],
    ['task_id'],
    ['data', 'id'],
    ['data', 'task_id'],
    ['result', 'id'],
    ['result', 'task_id'],
  ]) || fallbackTaskId || '';
  const providerStatus = pickNestedString(raw, [
    ['status'],
    ['data', 'status'],
    ['result', 'status'],
    ['task', 'status'],
  ]) || 'running';
  const resultVideoUrl = pickNestedString(raw, [
    ['content', 'video_url'],
    ['content', 'video_url', 'url'],
    ['data', 'content', 'video_url'],
    ['data', 'content', 'video_url', 'url'],
    ['result', 'content', 'video_url'],
    ['result', 'content', 'video_url', 'url'],
    ['output', 'video_url'],
    ['video_url'],
  ]);
  const resultLastFrameUrl = pickNestedString(raw, [
    ['content', 'last_frame_url'],
    ['content', 'last_frame_url', 'url'],
    ['data', 'content', 'last_frame_url'],
    ['data', 'content', 'last_frame_url', 'url'],
    ['result', 'content', 'last_frame_url'],
    ['result', 'content', 'last_frame_url', 'url'],
    ['output', 'last_frame_url'],
    ['last_frame_url'],
  ]);
  const rawError = pickNestedValue(raw, [
    ['error'],
    ['data', 'error'],
    ['result', 'error'],
    ['ResponseMetadata', 'Error'],
  ]);
  const normalizedError = rawError ? normalizeVolcengineIpError({ raw }) : null;

  return {
    provider_task_id: providerTaskId,
    provider_status: providerStatus,
    local_status: mapVolcengineTaskStatus(providerStatus),
    result_video_url: resultVideoUrl,
    result_last_frame_url: resultLastFrameUrl,
    error_message: normalizedError?.providerMessage || normalizedError?.userMessage,
    provider_model: pickNestedString(raw, [['model'], ['data', 'model'], ['result', 'model']]),
    seed: pickNestedNumber(raw, [['seed'], ['data', 'seed'], ['result', 'seed']]),
    resolution: pickNestedString(raw, [['resolution'], ['data', 'resolution'], ['result', 'resolution']]),
    ratio: pickNestedString(raw, [['ratio'], ['data', 'ratio'], ['result', 'ratio']]),
    duration: pickNestedNumber(raw, [['duration'], ['data', 'duration'], ['result', 'duration']]),
    usage: pickNestedValue(raw, [['usage'], ['data', 'usage'], ['result', 'usage']]),
    billing_status: pickNestedString(raw, [['billing_status'], ['data', 'billing_status'], ['result', 'billing_status']]),
    billing_time: pickNestedNumber(raw, [['billing_time'], ['data', 'billing_time'], ['result', 'billing_time']]),
    client_request_id: pickNestedString(raw, [['client_request_id'], ['data', 'client_request_id'], ['result', 'client_request_id']]),
    raw,
  };
}

function parseTaskListResponse(raw: unknown): VolcengineIpTaskListResult {
  const items = pickNestedValue(raw, [
    ['items'],
    ['data', 'items'],
    ['tasks'],
    ['data', 'tasks'],
    ['result', 'items'],
  ]);

  return {
    items: Array.isArray(items) ? items : [],
    total: pickNestedNumber(raw, [
      ['total'],
      ['data', 'total'],
      ['total_count'],
      ['data', 'total_count'],
    ]),
    raw,
  };
}

export async function createVolcengineIpVideoTask(
  input: CreateVideoInput & { generation_mode: GenerationMode; model?: string; service_tier?: string },
  options?: VolcengineIpRequestOptions,
): Promise<ProviderCreateResponse> {
  const config = await resolvePrivateConfig(options, true);
  const payload = buildVolcengineIpCreatePayload({
    ...input,
    model: input.model?.trim() || config.model,
  });
  const raw = await requestVolcengineIpJson(
    buildTaskUrl(config.baseUrl),
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    config,
    options,
  );

  return parseCreateResponse(raw);
}

export async function getVolcengineIpTaskStatus(
  providerTaskId: string,
  options?: VolcengineIpRequestOptions,
): Promise<ProviderStatusResponse> {
  const taskId = providerTaskId.trim();
  if (!taskId) throw new Error('火山 IP 查询缺少任务 ID');

  const config = await resolvePrivateConfig(options, false);
  const raw = await requestVolcengineIpJson(
    buildTaskUrl(config.baseUrl, taskId),
    { method: 'GET' },
    config,
    options,
  );

  return parseVolcengineIpStatusResponse(raw, taskId);
}

export async function listVolcengineIpTasks(
  params: VolcengineIpTaskListParams = {},
  options?: VolcengineIpRequestOptions,
): Promise<VolcengineIpTaskListResult> {
  const config = await resolvePrivateConfig(options, false);
  const url = new URL(buildTaskUrl(config.baseUrl));

  if (params.page_num !== undefined) url.searchParams.set('page_num', String(params.page_num));
  if (params.page_size !== undefined) url.searchParams.set('page_size', String(params.page_size));
  if (params.filter_status) url.searchParams.set('filter.status', params.filter_status);
  if (params.filter_model) url.searchParams.set('filter.model', params.filter_model);
  if (params.filter_created_after) url.searchParams.set('filter.created_after', params.filter_created_after);
  if (params.filter_created_before) url.searchParams.set('filter.created_before', params.filter_created_before);
  for (const taskId of params.filter_task_ids || []) {
    const trimmed = taskId.trim();
    if (trimmed) url.searchParams.append('filter.task_ids', trimmed);
  }

  const raw = await requestVolcengineIpJson(url.toString(), { method: 'GET' }, config, options);
  return parseTaskListResponse(raw);
}

export async function deleteVolcengineIpVideoTask(
  providerTaskId: string,
  options?: VolcengineIpRequestOptions,
): Promise<VolcengineIpDeleteTaskResult> {
  const taskId = providerTaskId.trim();
  if (!taskId) throw new Error('火山 IP 删除缺少任务 ID');

  const config = await resolvePrivateConfig(options, false);
  const raw = await requestVolcengineIpJson(
    buildTaskUrl(config.baseUrl, taskId),
    { method: 'DELETE' },
    config,
    options,
  );

  return { provider_task_id: taskId, deleted: true, raw };
}
