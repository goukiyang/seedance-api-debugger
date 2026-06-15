/**
 * Seedance 2.0 Video Generation API Provider
 * 
 * 按官方 Step1/Step2 结构设计：
 * - Step1: create task → 只返回 id
 * - Step2: query status → 返回完整结果含 video_url
 * 
 * Model: dreamina-seedance-2-0-260128
 * Docs: https://docs.byteplus.com/en/docs/ModelArk/1520757
 */

import type { CreateVideoInput, GenerationMode, LocalStatus, ProviderCreateResponse, ProviderStatusResponse } from '@/types';
import { normalizeProviderErrorMessage } from './error-message';

// ============================================================================
// Environment Configuration
// ============================================================================

const SEEDANCE_API_KEY = process.env.SEEDANCE_API_KEY || '';
const SEEDANCE_BASE_URL = process.env.SEEDANCE_BASE_URL || 'https://etc.seedance-api.net/server/api';

// ============================================================================
// Utilities
// ============================================================================

function maskKey(key: string): string {
  if (!key || key.length < 12) return '***';
  return `${key.substring(0, 4)}...${key.substring(key.length - 4)}`;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }

  return undefined;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return undefined;
}

function redactProviderResponseForLog(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactProviderResponseForLog(item));
  }

  if (!value || typeof value !== 'object') return value;

  return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>((acc, [key, current]) => {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.includes('token') ||
      normalizedKey.includes('secret') ||
      normalizedKey.includes('signature') ||
      normalizedKey.includes('authorization') ||
      normalizedKey.includes('api_key')
    ) {
      acc[key] = '[redacted]';
    } else if (normalizedKey.includes('url') && typeof current === 'string') {
      acc[key] = maskVideoUrl(current);
    } else {
      acc[key] = redactProviderResponseForLog(current);
    }
    return acc;
  }, {});
}

// ============================================================================
// Provider Config
// ============================================================================

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
// Status Mapping (Step2)
// ============================================================================

/**
 * 将官方 status 映射为本地 local_status
 * 注意：未知状态按 running 处理，不要直接判 failed
 */
export function mapProviderStatus(status?: string): LocalStatus {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'running':
    case 'processing':
    case 'in_progress':
      return 'running';
    case 'queued':
    case 'created':
    case 'pending':
      return 'submitted';
    default:
      // 未知状态按 running 处理，保留 raw_status_response 用于调试
      console.warn(`[mapProviderStatus] Unknown status: ${status}, treating as 'running'`);
      return 'running';
  }
}

// ============================================================================
// Build Content Array (按生成模式)
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

  // 1. 文本 prompt
  content.push({
    type: 'text',
    text: input.prompt,
  });

  // 2. 根据生成模式添加素材
  switch (input.generation_mode) {
    case 'all_in_one_reference':
      // 全能参考：支持图片、视频、音频混合参考
      // 图片最多 9 张；优先使用 base64 data URL
      if (input.reference_image_base64_data && input.reference_image_base64_data.length > 0) {
        for (const dataUrl of input.reference_image_base64_data.slice(0, 9)) {
          content.push({
            type: 'image_url',
            image_url: { url: dataUrl },
            role: 'reference_image',
          });
        }
      } else if (input.reference_image_urls && input.reference_image_urls.length > 0) {
        for (const url of input.reference_image_urls.slice(0, 9)) {
          if (!url) continue;
          content.push({
            type: 'image_url',
            image_url: { url },
            role: 'reference_image',
          });
        }
      }
      // 视频最多 3 个
      if (input.reference_video_urls && input.reference_video_urls.length > 0) {
        for (const url of input.reference_video_urls.slice(0, 3)) {
          content.push({
            type: 'video_url',
            video_url: { url },
            role: 'reference_video',
          });
        }
      }
      // 音频最多 3 个
      if (input.reference_audio_urls && input.reference_audio_urls.length > 0) {
        for (const url of input.reference_audio_urls.slice(0, 3)) {
          content.push({
            type: 'audio_url',
            audio_url: { url },
            role: 'reference_audio',
          });
        }
      }
      break;

    case 'first_last_frame':
      // 首尾帧：首帧必填，尾帧可选；优先 base64
      if (input.first_frame_base64_data) {
        content.push({
          type: 'image_url',
          image_url: { url: input.first_frame_base64_data },
          role: 'first_frame',
        });
      } else if (input.first_frame_url) {
        content.push({
          type: 'image_url',
          image_url: { url: input.first_frame_url },
          role: 'first_frame',
        });
      }
      if (input.last_frame_base64_data) {
        content.push({
          type: 'image_url',
          image_url: { url: input.last_frame_base64_data },
          role: 'last_frame',
        });
      } else if (input.last_frame_url) {
        content.push({
          type: 'image_url',
          image_url: { url: input.last_frame_url },
          role: 'last_frame',
        });
      }
      break;

    case 'smart_multi_frame':
      // 智能多帧：多张顺序帧图；优先 base64
      if (input.frame_image_base64_data && input.frame_image_base64_data.length > 0) {
        for (const dataUrl of input.frame_image_base64_data) {
          if (!dataUrl) continue;
          content.push({
            type: 'image_url',
            image_url: { url: dataUrl },
            role: 'reference_image',
          });
        }
      } else if (input.frame_image_urls && input.frame_image_urls.length > 0) {
        for (const url of input.frame_image_urls) {
          if (!url) continue;
          content.push({
            type: 'image_url',
            image_url: { url },
            role: 'reference_image',
          });
        }
      }
      break;
  }

  return content;
}

// ============================================================================
// Step1: Create Video Task (只返回 id)
// ============================================================================

export async function createVideoTask(
  input: CreateVideoInput & { generation_mode: GenerationMode }
): Promise<ProviderCreateResponse> {
  if (!isApiKeyConfigured()) {
    throw new Error('API key not configured');
  }

  const endpoint = `${SEEDANCE_BASE_URL}/call`;
  const model = 'dreamina-seedance-2-0-260128';

  // 构建 content 数组
  const content = buildContentArray(input);

  // 构建 payload
  const payload: Record<string, unknown> = {
    apiKey: SEEDANCE_API_KEY,
    model,
    content,
  };
  const clientRequestId = input.clientRequestId || input.client_request_id;

  // 添加可选参数
  if (clientRequestId) {
    payload.clientRequestId = clientRequestId;
  }
  if (input.duration) {
    payload.duration = input.duration;
  }
  if (input.ratio) {
    payload.ratio = input.ratio;
  }
  if (input.resolution) {
    payload.resolution = input.resolution;
  }
  if (input.seed !== undefined) {
    payload.seed = input.seed;
  }
  if (input.generate_audio !== undefined) {
    payload.generate_audio = input.generate_audio;
  }
  if (input.return_last_frame !== undefined) {
    payload.return_last_frame = input.return_last_frame;
  }
  if (input.watermark !== undefined) {
    payload.watermark = input.watermark;
  }
  if (input.callback_url) {
    payload.callback_url = input.callback_url;
  }
  if (input.execution_expires_after) {
    payload.execution_expires_after = input.execution_expires_after;
  }

  console.log('\n========== Step1: Create Video Task ==========');
  console.log(`Endpoint:  ${endpoint}`);
  console.log(`Model:     ${model}`);
  console.log(`Mode:      ${input.generation_mode}`);
  console.log(`Prompt:    ${input.prompt?.slice(0, 100)}...`);
  console.log(`Duration:  ${input.duration || 'default'}s`);
  console.log(`Ratio:     ${input.ratio || 'default'}`);
  console.log(`Resolution: ${input.resolution || 'default'}`);
  console.log(`Seed:      ${input.seed ?? 'random'}`);
  console.log(`ClientReq: ${clientRequestId || '(none)'}`);
  console.log(`Content:   ${content.length} items`);
  console.log(`API Key:   ${maskKey(SEEDANCE_API_KEY)}`);
  console.log('================================================\n');

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    
    // 处理空响应或非 JSON 响应
    let data: Record<string, unknown> = {};
    if (responseText.trim()) {
      try {
        data = JSON.parse(responseText);
      } catch {
        throw new Error(`Invalid JSON response: ${responseText.slice(0, 200)}`);
      }
    }

    console.log(`[Create] HTTP Status: ${response.status}`);
    console.log(`[Create] Response:`, JSON.stringify(data, null, 2));

    if (!response.ok) {
      throw new Error(`Create video task failed: ${response.status} ${JSON.stringify(data)}`);
    }

    // 关键：只解析 id
    const providerTaskId = data.id as string;
    if (!providerTaskId) {
      throw new Error(`Create video task missing id: ${JSON.stringify(data)}`);
    }

    console.log(`\n✅ Step1 Complete: provider_task_id = ${providerTaskId}\n`);

    return {
      provider_task_id: providerTaskId,
      raw: data,
    };
  } catch (error) {
    console.error('\n❌ Step1 Create failed:', error);
    throw error;
  }
}

// ============================================================================
// Step2: Get Video Task Status (返回完整结果)
// ============================================================================

export async function getVideoTaskStatus(
  providerTaskId: string
): Promise<ProviderStatusResponse> {
  const endpoint = `${SEEDANCE_BASE_URL}/getResult`;

  const payload = {
    id: providerTaskId,
  };

  console.log('\n---------- Step2: Query Task Status ----------');
  console.log(`Endpoint:    ${endpoint}`);
  console.log(`Task ID:     ${providerTaskId}`);
  console.log(`API Key:     ${maskKey(SEEDANCE_API_KEY)}`);
  console.log('-------------------------------------------\n');

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    
    // 处理空响应或非 JSON 响应
    let data: Record<string, unknown> = {};
    if (responseText.trim()) {
      try {
        data = JSON.parse(responseText);
      } catch {
        throw new Error(`Invalid JSON response: ${responseText.slice(0, 200)}`);
      }
    }

    console.log(`[Status] HTTP Status: ${response.status}`);
    console.log(`[Status] Response:`, JSON.stringify(redactProviderResponseForLog(data), null, 2));

    if (!response.ok) {
      throw new Error(`Get video task failed: ${response.status} ${JSON.stringify(data)}`);
    }

    // 解析官方返回结构
    const officialStatus = data.status as string | undefined;
    const localStatus = mapProviderStatus(officialStatus);
    const content = data.content as Record<string, unknown> | undefined;

    // 提取视频地址
    const resultVideoUrl = content?.video_url as string | undefined;

    // 提取尾帧地址
    const resultLastFrameUrl = content?.last_frame_url as string | undefined;

    // 提取错误信息
    const errorMessage = normalizeProviderErrorMessage(data.error ?? data.message);

    // 提取扩展字段
    const providerModel = data.model as string | undefined;
    const seed = data.seed as number | undefined;
    const resolution = data.resolution as string | undefined;
    const ratio = data.ratio as string | undefined;
    const duration = data.duration as number | undefined;
    const framesPerSecond = data.framespersecond as number | undefined;
    const serviceTier = data.service_tier as string | undefined;
    const executionExpiresAfter = data.execution_expires_after as number | undefined;
    const usage = data.usage as unknown | undefined;
    const actualCost = pickNumber(data, ['actual_cost', 'actualCost']);
    const currencyOrCreditType = pickString(data, ['currency_or_credit_type', 'currencyOrCreditType', 'currency']);
    const billingStatus = pickString(data, ['billing_status', 'billingStatus']);
    const billingTime = pickNumber(data, ['billing_time', 'billingTime']);
    const clientRequestId = pickString(data, ['clientRequestId', 'client_request_id', 'client_requestId']);
    const providerTaskIdFromRaw = pickString(data, ['id', 'provider_task_id', 'providerTaskId', 'task_id']) || providerTaskId;

    // 状态日志
    if (localStatus === 'succeeded') {
      console.log(`\n✅ Step2 Complete: status = succeeded`);
      console.log(`   Video URL: ${resultVideoUrl ? maskVideoUrl(resultVideoUrl) : '(none)'}`);
      console.log(`   Model:     ${providerModel || '(none)'}`);
      console.log(`   Seed:      ${seed ?? 'N/A'}`);
      console.log(`   Resolution: ${resolution || '(none)'}`);
      console.log(`   Ratio:     ${ratio || '(none)'}`);
      console.log(`   Duration:  ${duration ?? 'N/A'}s`);
      console.log(`   FPS:       ${framesPerSecond ?? 'N/A'}\n`);
      console.log(`   Billing:   ${actualCost ?? 'N/A'} ${currencyOrCreditType || ''} (${billingStatus || 'unknown'})\n`);
    } else if (localStatus === 'failed') {
      console.log(`\n❌ Step2 Complete: status = failed`);
      console.log(`   Error: ${errorMessage || 'Unknown error'}\n`);
    } else {
      console.log(`\n⏳ Step2 Complete: status = ${officialStatus || 'unknown'} (${localStatus})\n`);
    }

    return {
      provider_task_id: providerTaskIdFromRaw,
      provider_status: officialStatus || 'unknown',
      local_status: localStatus,
      result_video_url: resultVideoUrl,
      result_last_frame_url: resultLastFrameUrl,
      error_message: errorMessage,
      // 扩展字段
      provider_model: providerModel,
      seed: seed,
      resolution: resolution,
      ratio: ratio,
      duration: duration,
      frames_per_second: framesPerSecond,
      service_tier: serviceTier,
      execution_expires_after: executionExpiresAfter,
      usage: usage,
      actual_cost: actualCost,
      currency_or_credit_type: currencyOrCreditType,
      billing_status: billingStatus,
      billing_time: billingTime,
      client_request_id: clientRequestId,
      raw: data,
    };
  } catch (error) {
    console.error('\n❌ Step2 Query failed:', error);
    throw error;
  }
}

// ============================================================================
// Helper: Mask Video URL (安全显示)
// ============================================================================

function maskVideoUrl(url?: string): string {
  if (!url) return '(none)';
  try {
    const parsed = new URL(url);
    // 只显示域名和路径，不显示签名参数
    return `${parsed.origin}${parsed.pathname}?X-Tos-Expires=***&X-Tos-Signature=***`;
  } catch {
    return url.slice(0, 60) + '...';
  }
}

// ============================================================================
// Test Connection
// ============================================================================

export async function testConnection(): Promise<{ success: boolean; message: string }> {
  console.log('\n========== Test Connection ==========');
  console.log(`Base URL:  ${SEEDANCE_BASE_URL}`);
  console.log(`API Key:   ${maskKey(SEEDANCE_API_KEY)}`);
  console.log('====================================\n');

  if (!isApiKeyConfigured()) {
    return {
      success: false,
      message: 'API key not configured',
    };
  }

  return {
    success: true,
    message: 'API key configured',
  };
}
