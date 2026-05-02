/**
 * Seedance 2.0 Video Generation API Provider
 *
 * 按官方 Step1/Step2 结构设计：
 * - Step1: create task → 只返回 id（异步，不等待生成完成）
 * - Step2: query status → 返回完整结果含 video_url
 *
 * Model: dreamina-seedance-2-0-260128
 * Docs: https://docs.byteplus.com/en/docs/ModelArk/1520757
 */

import type { CreateVideoInput, GenerationMode, LocalStatus, ProviderCreateResponse, ProviderStatusResponse } from '@/types';

// ============================================================================
// Environment Configuration
// ============================================================================

const SEEDANCE_API_KEY = process.env.SEEDANCE_API_KEY || '';
const SEEDANCE_BASE_URL = process.env.SEEDANCE_BASE_URL || 'https://etc.seedance-api.net/server/api';
// fetch 超时（毫秒）；超过此时间 abort，避免无限等待
const FETCH_TIMEOUT_MS = 30_000;

export interface SeedanceConfig {
  baseUrl: string;
  model: string;
  apiKeyMasked: string;
}

export function getProviderConfig(): SeedanceConfig {
  return {
    baseUrl: SEEDANCE_BASE_URL,
    model: 'dreamina-seedance-2-0-260128',
    apiKeyMasked: maskKey(SEEDANCE_API_KEY),
  };
}

export function isApiKeyConfigured(): boolean {
  return Boolean(SEEDANCE_API_KEY && SEEDANCE_API_KEY.length > 0);
}

// ============================================================================
// Utilities
// ============================================================================

function maskKey(key: string): string {
  if (!key || key.length < 12) return '***';
  return `${key.substring(0, 4)}...${key.substring(key.length - 4)}`;
}

/**
 * 从 URL 提取 host（不打印完整签名参数）
 */
function extractUrlHost(url: string): string {
  if (!url || url === 'data:...') return 'inline-base64';
  if (url.startsWith('data:')) return 'inline-base64';
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    if (url.startsWith('/')) return 'relative-path';
    return 'unknown';
  }
}

/**
 * 对 fetch 添加超时 wrapper
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit & { signal?: AbortSignal },
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// Structured Error Types（用于精确区分 524 来源）
// ============================================================================

export interface ProviderErrorContext {
  /** HTTP 状态码（如 524, 502, 503, 504, 500 等） */
  httpStatus: number;
  /** 错误来源：local_fetch_timeout | provider_gateway_timeout | provider_http_error | parse_error | unknown */
  source: 'local_fetch_timeout' | 'provider_gateway_timeout' | 'provider_http_error' | 'parse_error' | 'unknown';
  /** 错误码字符串（如 "524", "502"） */
  code: string;
  /** 从响应 body 提取的错误消息 */
  providerMessage?: string;
  /** AWS / 平台 RequestId */
  requestId?: string;
  /** 原始错误消息 */
  rawMessage: string;
  /** 脱敏后的 payload 摘要 */
  payloadSummary: {
    endpoint: string;
    model: string;
    generationMode: string;
    promptLength: number;
    contentItemCount: number;
    referenceImageCount: number;
    referenceImageHosts: string[];
    totalPayloadSizeKb: number;
  };
}

/**
 * 将 ProviderErrorContext 格式化为用户友好的前端展示对象
 */
export function formatProviderError(ctx: ProviderErrorContext): {
  title: string;
  code: string;
  message: string;
  reasons: string[];
  actions: { label: string; action: string }[];
  details: Record<string, unknown>;
} {
  const { httpStatus, source, code, providerMessage, requestId, payloadSummary } = ctx;

  if (source === 'local_fetch_timeout') {
    return {
      title: `网络请求超时 (${code})`,
      code,
      message: `向 Seedance 服务发送请求超时（${FETCH_TIMEOUT_MS / 1000}s）`,
      reasons: [
        '网络连接不稳定或 VPN/代理干扰',
        '本地服务器到 Seedance 网关的路由故障',
        `payload 过大（${payloadSummary.totalPayloadSizeKb}KB）导致发送超时`,
        'Seedance 服务端网关无响应',
      ],
      actions: [
        { label: '稍后重试', action: 'retry' },
        { label: '复制错误', action: 'copy' },
        { label: '查看调试信息', action: 'debug' },
      ],
      details: {
        httpStatus,
        source,
        providerMessage,
        requestId,
        payloadSummary,
      },
    };
  }

  if (source === 'provider_gateway_timeout') {
    return {
      title: `Seedance 服务响应超时 (${code})`,
      code,
      message: providerMessage || 'Seedance 网关超时，服务处理超时或不可用',
      reasons: [
        'Seedance 服务处理超时（生成任务过大或服务器繁忙）',
        '参考图数量过多或图片过大',
        `当前 payload：${payloadSummary.referenceImageCount} 张参考图，约 ${payloadSummary.totalPayloadSizeKb}KB`,
        '服务器负载过高或服务临时不可用',
      ],
      actions: [
        { label: '稍后重试', action: 'retry' },
        { label: '减少参考图', action: 'retry_hint_refs' },
        { label: '复制错误', action: 'copy' },
        { label: '查看调试信息', action: 'debug' },
      ],
      details: {
        httpStatus,
        source,
        providerMessage,
        requestId,
        payloadSummary,
      },
    };
  }

  if (source === 'provider_http_error') {
    return {
      title: `Seedance 请求失败 (${code})`,
      code,
      message: providerMessage || `HTTP ${httpStatus} 错误`,
      reasons: [
        `Seedance 服务返回 HTTP ${httpStatus}`,
        providerMessage || '服务处理异常',
      ],
      actions: [
        { label: '稍后重试', action: 'retry' },
        { label: '复制错误', action: 'copy' },
        { label: '查看调试信息', action: 'debug' },
      ],
      details: {
        httpStatus,
        source,
        providerMessage,
        requestId,
        payloadSummary,
      },
    };
  }

  return {
    title: `创建任务失败 (${code})`,
    code,
    message: providerMessage || ctx.rawMessage,
    reasons: ['未知错误，请查看详情'],
    actions: [
      { label: '稍后重试', action: 'retry' },
      { label: '复制错误', action: 'copy' },
      { label: '查看调试信息', action: 'debug' },
    ],
    details: {
      httpStatus,
      source,
      providerMessage,
      requestId,
      payloadSummary,
    },
  };
}

// ============================================================================
// Content Array Builder（不变）
// ============================================================================

interface ContentItem {
  type: string;
  text?: string;
  image_url?: { url: string };
  video_url?: { url: string };
  audio_url?: { url: string };
  role?: string;
}

export function buildContentArray(input: CreateVideoInput & { generation_mode: GenerationMode }): ContentItem[] {
  const content: ContentItem[] = [];
  content.push({ type: 'text', text: input.prompt });

  switch (input.generation_mode) {
    case 'all_in_one_reference':
      if (input.reference_image_base64_data?.length) {
        for (const dataUrl of input.reference_image_base64_data.slice(0, 9)) {
          content.push({ type: 'image_url', image_url: { url: dataUrl }, role: 'reference_image' });
        }
      } else if (input.reference_image_urls?.length) {
        for (const url of input.reference_image_urls.slice(0, 9)) {
          if (!url) continue;
          content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' });
        }
      }
      if (input.reference_video_urls?.length) {
        for (const url of input.reference_video_urls.slice(0, 3)) {
          content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' });
        }
      }
      if (input.reference_audio_urls?.length) {
        for (const url of input.reference_audio_urls.slice(0, 3)) {
          content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' });
        }
      }
      break;

    case 'first_last_frame':
      if (input.first_frame_base64_data) {
        content.push({ type: 'image_url', image_url: { url: input.first_frame_base64_data }, role: 'first_frame' });
      } else if (input.first_frame_url) {
        content.push({ type: 'image_url', image_url: { url: input.first_frame_url }, role: 'first_frame' });
      }
      if (input.last_frame_base64_data) {
        content.push({ type: 'image_url', image_url: { url: input.last_frame_base64_data }, role: 'last_frame' });
      } else if (input.last_frame_url) {
        content.push({ type: 'image_url', image_url: { url: input.last_frame_url }, role: 'last_frame' });
      }
      break;

    case 'smart_multi_frame':
      if (input.frame_image_base64_data?.length) {
        for (const dataUrl of input.frame_image_base64_data) {
          if (!dataUrl) continue;
          content.push({ type: 'image_url', image_url: { url: dataUrl }, role: 'reference_image' });
        }
      } else if (input.frame_image_urls?.length) {
        for (const url of input.frame_image_urls) {
          if (!url) continue;
          content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' });
        }
      }
      break;
  }

  return content;
}

// ============================================================================
// Step1: Create Video Task（重写，含完整调试日志 + 错误分类）
// ============================================================================

export async function createVideoTask(
  input: CreateVideoInput & { generation_mode: GenerationMode }
): Promise<ProviderCreateResponse> {
  if (!isApiKeyConfigured()) {
    throw new Error('API key not configured');
  }

  const endpoint = `${SEEDANCE_BASE_URL}/call`;
  const model = 'dreamina-seedance-2-0-260128';
  const content = buildContentArray(input);

  // 构建 payload（包含 apiKey 供下游验证）
  const payload: Record<string, unknown> = {
    apiKey: SEEDANCE_API_KEY,
    model,
    content,
  };
  if (input.duration) payload.duration = input.duration;
  if (input.ratio) payload.ratio = input.ratio;
  if (input.resolution) payload.resolution = input.resolution;
  if (input.seed !== undefined) payload.seed = input.seed;
  if (input.generate_audio !== undefined) payload.generate_audio = input.generate_audio;
  if (input.return_last_frame !== undefined) payload.return_last_frame = input.return_last_frame;
  if (input.watermark !== undefined) payload.watermark = input.watermark;
  if (input.callback_url) payload.callback_url = input.callback_url;
  if (input.execution_expires_after) payload.execution_expires_after = input.execution_expires_after;

  // ---- 脱敏调试日志：payload 摘要 ----
  const referenceImageHosts = [
    ...(input.reference_image_base64_data?.map(() => 'inline-base64') ?? []),
    ...(input.reference_image_urls?.map(extractUrlHost) ?? []),
  ];

  // 计算 payload 大致体积（不打印 base64 内容）
  const payloadJson = JSON.stringify(payload);
  const payloadSizeKb = Math.round(Buffer.byteLength(payloadJson, 'utf8') / 1024);

  console.log('\n========== [DEBUG] Step1: Create Video Task ==========');
  console.log(`Endpoint:              ${endpoint}`);
  console.log(`Model:                 ${model}`);
  console.log(`Mode:                  ${input.generation_mode}`);
  console.log(`Prompt length:         ${input.prompt?.length ?? 0} chars`);
  console.log(`Content items:         ${content.length}`);
  console.log(`Reference images:      ${referenceImageHosts.length}`);
  console.log(`  Hosts:               ${Array.from(new Set(referenceImageHosts)).join(', ')}`);
  console.log(`Payload size:          ~${payloadSizeKb} KB`);
  console.log(`Timeout:               ${FETCH_TIMEOUT_MS / 1000}s`);
  console.log(`API Key:               ${maskKey(SEEDANCE_API_KEY)}`);
  console.log('======================================================\n');

  let response: Response;
  let responseText = '';
  let httpStatus = 0;

  try {
    response = await fetchWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payloadJson,
      },
      FETCH_TIMEOUT_MS
    );
    httpStatus = response.status;
    responseText = await response.text();
  } catch (fetchErr: unknown) {
    // 区分 AbortError（本地超时）vs 网络错误
    const isAbort = fetchErr instanceof DOMException && fetchErr.name === 'AbortError';
    const isTimeout = isAbort || (fetchErr instanceof Error && fetchErr.message.includes('aborted'));

    console.error(`\n[Create] Fetch failed: ${isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR'} - ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);

    const ctx: ProviderErrorContext = {
      httpStatus: 0,
      source: isTimeout ? 'local_fetch_timeout' : 'unknown',
      code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      rawMessage: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
      payloadSummary: {
        endpoint,
        model,
        generationMode: input.generation_mode,
        promptLength: input.prompt?.length ?? 0,
        contentItemCount: content.length,
        referenceImageCount: referenceImageHosts.length,
        referenceImageHosts: Array.from(new Set(referenceImageHosts)),
        totalPayloadSizeKb: payloadSizeKb,
      },
    };

    const err = new Error(`Create video task failed: ${ctx.code} - ${ctx.rawMessage}`) as Error & { providerContext?: ProviderErrorContext };
    err.providerContext = ctx;
    throw err;
  }

  // ---- 解析响应 ----
  let data: Record<string, unknown> = {};
  try {
    if (responseText.trim()) {
      data = JSON.parse(responseText);
    }
  } catch {
    console.warn(`[Create] Non-JSON response (HTTP ${httpStatus}): ${responseText.slice(0, 200)}`);
  }

  // ---- 提取 RequestId（通用字段，支持多种响应结构）----
  const requestId =
    (data.ResponseMetadata as Record<string, unknown>)?.RequestId as string ||
    (data.request_id as string) ||
    (data.RequestId as string) ||
    (data.id as string) ||
    undefined;

  const providerMessage =
    (data.error as string) ||
    (data.message as string) ||
    (data.error_message as string) ||
    (data.msg as string) ||
    undefined;

  console.log(`[Create] HTTP Status:  ${httpStatus}`);
  console.log(`[Create] RequestId:    ${requestId ?? '(none)'}`);
  console.log(`[Create] ProviderMsg:  ${providerMessage ?? '(none)'}`);
  console.log(`[Create] Response:     ${responseText.slice(0, 500)}`);

  // ---- 错误分类 + 抛出带上下文的标准错误 ----
  if (!response.ok) {
    let source: ProviderErrorContext['source'] = 'provider_http_error';
    if (httpStatus === 524 || httpStatus === 504) {
      source = 'provider_gateway_timeout';
    } else if (httpStatus === 502 || httpStatus === 503) {
      source = 'provider_gateway_timeout';
    } else if (httpStatus === 500) {
      source = 'provider_http_error';
    }

    const ctx: ProviderErrorContext = {
      httpStatus,
      source,
      code: String(httpStatus),
      providerMessage,
      requestId,
      rawMessage: `HTTP ${httpStatus}: ${providerMessage || responseText.slice(0, 100)}`,
      payloadSummary: {
        endpoint,
        model,
        generationMode: input.generation_mode,
        promptLength: input.prompt?.length ?? 0,
        contentItemCount: content.length,
        referenceImageCount: referenceImageHosts.length,
        referenceImageHosts: Array.from(new Set(referenceImageHosts)),
        totalPayloadSizeKb: payloadSizeKb,
      },
    };

    console.error(`\n[Create] Provider error (source=${source}): HTTP ${httpStatus} - ${providerMessage}`);

    const err = new Error(`Create video task failed: ${httpStatus} ${JSON.stringify(data)}`) as Error & { providerContext?: ProviderErrorContext };
    err.providerContext = ctx;
    throw err;
  }

  // ---- 成功：只解析 id ----
  const providerTaskId = data.id as string;
  if (!providerTaskId) {
    const errMsg = `Create video task missing id in response: ${responseText.slice(0, 200)}`;
    console.error(`\n[Create] ${errMsg}`);
    throw new Error(errMsg);
  }

  console.log(`\n✅ Step1 Complete: provider_task_id = ${providerTaskId}`);
  if (requestId) console.log(`   RequestId = ${requestId}`);

  return { provider_task_id: providerTaskId, raw: data };
}

// ============================================================================
// Step2: Get Video Task Status
// ============================================================================

export async function getVideoTaskStatus(
  providerTaskId: string
): Promise<ProviderStatusResponse> {
  const endpoint = `${SEEDANCE_BASE_URL}/getResult`;
  const payload = { id: providerTaskId };

  console.log('\n---------- [DEBUG] Step2: Query Task Status ----------');
  console.log(`Endpoint:    ${endpoint}`);
  console.log(`Task ID:     ${providerTaskId}`);
  console.log(`API Key:     ${maskKey(SEEDANCE_API_KEY)}`);
  console.log('-------------------------------------------------------\n');

  let response: Response;
  try {
    response = await fetchWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      FETCH_TIMEOUT_MS
    );
  } catch (fetchErr: unknown) {
    const isTimeout =
      (fetchErr instanceof DOMException && fetchErr.name === 'AbortError') ||
      (fetchErr instanceof Error && fetchErr.message.includes('aborted'));

    const err = new Error(
      `Get video task status failed: ${isTimeout ? 'TIMEOUT' : fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`
    );
    throw err;
  }

  const responseText = await response.text();
  let data: Record<string, unknown> = {};
  if (responseText.trim()) {
    try { data = JSON.parse(responseText); } catch {}
  }

  if (!response.ok) {
    throw new Error(`Get video task failed: ${response.status} ${responseText.slice(0, 200)}`);
  }

  const officialStatus = data.status as string | undefined;
  const localStatus = mapProviderStatus(officialStatus);
  const content = data.content as Record<string, unknown> | undefined;
  const resultVideoUrl = content?.video_url as string | undefined;
  const resultLastFrameUrl = content?.last_frame_url as string | undefined;
  const errorMessage = (data.error || data.message) as string | undefined;
  const requestId =
    (data.ResponseMetadata as Record<string, unknown>)?.RequestId as string ||
    (data.request_id as string) ||
    undefined;

  if (localStatus === 'succeeded') {
    console.log(`\n✅ Step2 Complete: status = succeeded`);
    console.log(`   Video URL: ${resultVideoUrl ? maskVideoUrl(resultVideoUrl) : '(none)'}`);
  } else if (localStatus === 'failed') {
    console.log(`\n❌ Step2 Complete: status = failed - ${errorMessage || 'unknown'}`);
  } else {
    console.log(`\n⏳ Step2 Complete: status = ${officialStatus || 'unknown'} (${localStatus})`);
  }
  if (requestId) console.log(`   RequestId = ${requestId}`);

  return {
    provider_task_id: providerTaskId,
    provider_status: officialStatus || 'unknown',
    local_status: localStatus,
    result_video_url: resultVideoUrl,
    result_last_frame_url: resultLastFrameUrl,
    error_message: errorMessage,
    provider_model: data.model as string | undefined,
    seed: data.seed as number | undefined,
    resolution: data.resolution as string | undefined,
    ratio: data.ratio as string | undefined,
    duration: data.duration as number | undefined,
    frames_per_second: data.framespersecond as number | undefined,
    service_tier: data.service_tier as string | undefined,
    execution_expires_after: data.execution_expires_after as number | undefined,
    usage: data.usage as unknown | undefined,
    raw: data,
  };
}

function maskVideoUrl(url?: string): string {
  if (!url) return '(none)';
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}?X-Tos-Expires=***&X-Tos-Signature=***`;
  } catch {
    return url.slice(0, 60) + '...';
  }
}

// ============================================================================
// Status Mapping
// ============================================================================

export function mapProviderStatus(status?: string): LocalStatus {
  switch (status) {
    case 'succeeded': return 'succeeded';
    case 'failed': return 'failed';
    case 'cancelled':
    case 'canceled': return 'cancelled';
    case 'running':
    case 'processing':
    case 'in_progress': return 'running';
    case 'queued':
    case 'created':
    case 'pending': return 'submitted';
    default:
      console.warn(`[mapProviderStatus] Unknown status: ${status}, treating as 'running'`);
      return 'running';
  }
}

// ============================================================================
// Test Connection
// ============================================================================

export async function testConnection(): Promise<{ success: boolean; message: string }> {
  if (!isApiKeyConfigured()) {
    return { success: false, message: 'API key not configured' };
  }
  return { success: true, message: 'API key configured' };
}
