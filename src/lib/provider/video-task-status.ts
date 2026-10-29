import type { ProviderStatusResponse } from '@/types';
import { getAiMediaKitTaskStatus } from './aimediakit-enhance-video';
import { H3_VIDEO_PROVIDER, getH3TaskStatus } from './h3';
import { getVideoTaskStatus } from './jimeng';
import { VOLCENGINE_IP_VIDEO_PROVIDER, getVolcengineIpTaskStatus } from './volcengine-ip';
import { isPrivateMultiviewTask } from '../video/multiview-task-privacy';
import { hasVideoPromptGroups } from '../video/prompt-groups';

export const VIDEO_TASK_PROVIDER_SEEDANCE = 'seedance';
export const VIDEO_TASK_PROVIDER_VOLCENGINE_MEDIAKIT = 'volcengine_mediakit';
export const VIDEO_TASK_PROVIDER_H3 = H3_VIDEO_PROVIDER;

export type ProviderStatusTask = {
  provider?: string | null;
  model?: string | null;
  provider_task_id: string | null;
  source_metadata_json?: string | null;
};

export type RefreshProviderResultTask = ProviderStatusTask & {
  id: string;
  result_last_frame_url?: string | null;
};

export type ProviderStatusQueryContext = { sensitiveRecipe?: boolean };
export type ProviderStatusFetcher = (providerTaskId: string) => Promise<ProviderStatusResponse>;
export type SeedanceProviderStatusFetcher = (
  providerTaskId: string,
  context?: ProviderStatusQueryContext,
) => Promise<ProviderStatusResponse>;

export type ProviderStatusFetchers = {
  seedance: SeedanceProviderStatusFetcher;
  volcengineIp: ProviderStatusFetcher;
  aiMediaKitEnhanceVideo: ProviderStatusFetcher;
  h3: ProviderStatusFetcher;
};

export type ProviderStatusRouterOptions = {
  fetchers?: ProviderStatusFetchers;
};

export type RefreshedProviderResultUrl = {
  result_video_url: string;
  result_last_frame_url: string | null;
  raw: unknown;
};

const defaultFetchers: ProviderStatusFetchers = {
  seedance: getVideoTaskStatus,
  volcengineIp: getVolcengineIpTaskStatus,
  aiMediaKitEnhanceVideo: getAiMediaKitTaskStatus,
  h3: getH3TaskStatus,
};

function normalizeProvider(provider: string | null | undefined) {
  return (provider || VIDEO_TASK_PROVIDER_SEEDANCE).trim().toLowerCase();
}

function fetcherForProvider(provider: string, fetchers: ProviderStatusFetchers) {
  if (provider === VIDEO_TASK_PROVIDER_SEEDANCE) return fetchers.seedance;
  if (provider === VOLCENGINE_IP_VIDEO_PROVIDER) return fetchers.volcengineIp;
  if (provider === VIDEO_TASK_PROVIDER_VOLCENGINE_MEDIAKIT) return fetchers.aiMediaKitEnhanceVideo;
  if (provider === VIDEO_TASK_PROVIDER_H3) return fetchers.h3;
  throw new Error(`暂不支持的任务 Provider: ${provider}`);
}

function seedanceQueryContext(task: ProviderStatusTask): ProviderStatusQueryContext {
  if (!Object.prototype.hasOwnProperty.call(task, 'source_metadata_json') || task.source_metadata_json === undefined) {
    // Cache refreshes use legacy partial rows. Missing protection metadata is
    // not evidence that provider logs are safe, and must not cause another DB read.
    return { sensitiveRecipe: true };
  }
  return { sensitiveRecipe: isPrivateMultiviewTask({ source_metadata_json: task.source_metadata_json }) || hasVideoPromptGroups(task) };
}

function numericUsage(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(['completion_tokens', 'prompt_tokens', 'total_tokens', 'input_tokens', 'output_tokens',
    'video_seconds', 'duration', 'frames'].filter(key => typeof source[key] === 'number' && Number.isFinite(source[key]))
    .map(key => [key, source[key] as number]));
}

export async function getProviderTaskStatus(
  task: ProviderStatusTask,
  options: ProviderStatusRouterOptions = {},
): Promise<ProviderStatusResponse> {
  // 这里只按 provider 选择查询函数；落库、扣费和状态最终化仍由调用方负责。
  const providerTaskId = task.provider_task_id?.trim();
  if (!providerTaskId) {
    throw new Error('查询任务状态缺少 provider_task_id');
  }

  const provider = normalizeProvider(task.provider);
  const fetchers = options.fetchers || defaultFetchers;
  let result: ProviderStatusResponse;
  try { result = await (provider === VIDEO_TASK_PROVIDER_SEEDANCE
    ? fetchers.seedance(providerTaskId, seedanceQueryContext(task))
    : fetcherForProvider(provider, fetchers)(providerTaskId)); }
  catch (error) { if (hasVideoPromptGroups(task)) throw new Error('原任务状态暂时无法核对，请稍后查询同一任务'); throw error; }
  if (!hasVideoPromptGroups(task)) return result;
  // Keep billing facts while excluding free-form supplier diagnostics and echoed input.
  const usage = numericUsage(result.usage);
  const safe = { ...result, provider_model: task.model || undefined, provider_status: result.local_status, usage,
    error_message: result.error_message ? '视频服务未完成本次生成，请核对原任务及费用。' : undefined };
  return { ...safe, raw: { provider_status: result.local_status, local_status: result.local_status,
    actual_cost: result.actual_cost, currency_or_credit_type: result.currency_or_credit_type,
    billing_status: result.billing_status, billing_time: result.billing_time, usage } };
}

export async function refreshProviderTaskResultUrl(
  task: RefreshProviderResultTask,
  options: ProviderStatusRouterOptions = {},
): Promise<RefreshedProviderResultUrl | null> {
  // 用于签名结果 URL 过期后的轻量刷新；不在 Provider 层直接写数据库。
  const refreshed = await getProviderTaskStatus(task, options);
  if (!refreshed.result_video_url) return null;

  return {
    result_video_url: refreshed.result_video_url,
    result_last_frame_url: refreshed.result_last_frame_url || task.result_last_frame_url || null,
    raw: refreshed.raw,
  };
}
