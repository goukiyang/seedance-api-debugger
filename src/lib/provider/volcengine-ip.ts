import type { CreateVideoInput, GenerationMode, LocalStatus } from '@/types';

export const VOLCENGINE_IP_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
export const VOLCENGINE_IP_CREATE_TASK_PATH = '/contents/generations/tasks';

export type VolcengineIpErrorCategory =
  | 'auth'
  | 'permission'
  | 'quota'
  | 'rate_limit'
  | 'content_safety'
  | 'asset'
  | 'provider'
  | 'network'
  | 'unknown';

export interface VolcengineIpProviderConfig {
  baseUrl: string;
  createTaskUrl: string;
  model: string;
  apiKeyMasked: string;
  ready: boolean;
  missing: Array<'api_key' | 'model'>;
}

export type VolcengineIpContentItem =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string }; role?: string }
  | { type: 'video_url'; video_url: { url: string }; role?: string }
  | { type: 'audio_url'; audio_url: { url: string }; role?: string };

export interface VolcengineIpCreatePayload {
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
}

export interface NormalizedVolcengineIpError {
  code: string;
  category: VolcengineIpErrorCategory;
  retryable: boolean;
  userMessage: string;
  providerMessage?: string;
  statusCode?: number;
}

function cleanBaseUrl(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) return VOLCENGINE_IP_DEFAULT_BASE_URL;
  return trimmed.replace(/\/+$/, '');
}

function readApiKey() {
  return (process.env.VOLCENGINE_IP_API_KEY || process.env.ARK_API_KEY || '').trim();
}

function readModel() {
  return (process.env.VOLCENGINE_IP_MODEL || process.env.ARK_MODEL || '').trim();
}

function maskSecret(value: string) {
  if (!value) return '未配置';
  if (value.length < 12) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function getVolcengineIpProviderConfig(): VolcengineIpProviderConfig {
  const apiKey = readApiKey();
  const model = readModel();
  const baseUrl = cleanBaseUrl(process.env.VOLCENGINE_IP_BASE_URL || process.env.ARK_BASE_URL);
  const missing: VolcengineIpProviderConfig['missing'] = [];

  if (!apiKey) missing.push('api_key');
  if (!model) missing.push('model');

  return {
    baseUrl,
    createTaskUrl: `${baseUrl}${VOLCENGINE_IP_CREATE_TASK_PATH}`,
    model,
    apiKeyMasked: maskSecret(apiKey),
    ready: missing.length === 0,
    missing,
  };
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
  input: CreateVideoInput & { generation_mode: GenerationMode; model: string },
): VolcengineIpCreatePayload {
  const model = input.model.trim();
  if (!model) {
    throw new Error('火山 IP 生成缺少 Model ID');
  }

  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new Error('火山 IP 生成缺少提示词');
  }

  const content: VolcengineIpContentItem[] = [{ type: 'text', text: prompt }];

  switch (input.generation_mode) {
    case 'first_last_frame':
      addUrlItems(content, 'image_url', [
        input.first_frame_base64_data || input.first_frame_url || '',
      ], 'first_frame', 1);
      addUrlItems(content, 'image_url', [
        input.last_frame_base64_data || input.last_frame_url || '',
      ], 'last_frame', 1);
      break;
    case 'smart_multi_frame':
      addUrlItems(
        content,
        'image_url',
        input.frame_image_base64_data?.length ? input.frame_image_base64_data : input.frame_image_urls,
        'reference_image',
      );
      break;
    case 'all_in_one_reference':
    default:
      addUrlItems(
        content,
        'image_url',
        input.reference_image_base64_data?.length ? input.reference_image_base64_data : input.reference_image_urls,
        'reference_image',
        9,
      );
      addUrlItems(content, 'video_url', input.reference_video_urls, 'reference_video', 3);
      addUrlItems(content, 'audio_url', input.reference_audio_urls, 'reference_audio', 3);
      break;
  }

  const payload: VolcengineIpCreatePayload = { model, content };
  const clientRequestId = (input.client_request_id || input.clientRequestId || '').trim();

  if (input.callback_url) payload.callback_url = input.callback_url;
  if (clientRequestId) payload.client_request_id = clientRequestId;
  if (input.duration !== undefined) payload.duration = input.duration;
  if (input.ratio) payload.ratio = input.ratio;
  if (input.resolution) payload.resolution = input.resolution;
  if (input.seed !== undefined) payload.seed = input.seed;
  if (input.generate_audio !== undefined) payload.generate_audio = input.generate_audio;
  if (input.return_last_frame !== undefined) payload.return_last_frame = input.return_last_frame;
  if (input.watermark !== undefined) payload.watermark = input.watermark;
  if (input.execution_expires_after !== undefined) {
    payload.execution_expires_after = input.execution_expires_after;
  }

  return payload;
}

export function mapVolcengineTaskStatus(status?: string | null): LocalStatus {
  const normalized = (status || '').trim().toLowerCase();
  if (['succeeded', 'success', 'completed', 'complete'].includes(normalized)) return 'succeeded';
  if (['failed', 'fail', 'error'].includes(normalized)) return 'failed';
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
  }
  return undefined;
}

function categorizeVolcengineError(code: string, statusCode?: number): VolcengineIpErrorCategory {
  const normalized = code.toLowerCase();
  if (statusCode === 401 || normalized.includes('apikey') || normalized.includes('unauthorized')) return 'auth';
  if (statusCode === 403 || normalized.includes('permission') || normalized.includes('forbidden')) return 'permission';
  if (statusCode === 429 || normalized.includes('ratelimit') || normalized.includes('rate_limit')) return 'rate_limit';
  if (normalized.includes('quota') || normalized.includes('balance') || normalized.includes('arrears')) return 'quota';
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

function isRetryableVolcengineError(category: VolcengineIpErrorCategory, statusCode?: number) {
  return category === 'rate_limit' || category === 'network' || category === 'provider' || Boolean(statusCode && statusCode >= 500);
}

function userMessageForCategory(category: VolcengineIpErrorCategory) {
  switch (category) {
    case 'auth':
      return '火山 API Key 无效或未配置，请管理员检查服务端密钥。';
    case 'permission':
      return '当前火山账号没有这个模型、素材或接口权限，请管理员确认开通状态。';
    case 'quota':
      return '火山资源包、余额或额度不足，请先补充额度后再生成。';
    case 'rate_limit':
      return '火山请求太频繁，系统会稍后重试。';
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

export function normalizeVolcengineIpError(input: {
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
    retryable: isRetryableVolcengineError(category, input.statusCode),
    userMessage: userMessageForCategory(category),
    providerMessage,
    statusCode: input.statusCode,
  };
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

export function redactVolcengineIpLog<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactVolcengineIpLog(item)) as T;
  }
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
