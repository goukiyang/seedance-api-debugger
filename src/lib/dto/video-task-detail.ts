import type { Prisma } from '@prisma/client';
import { isExternalUser } from '@/lib/access/external-role';
import { isPrivateMultiviewTask } from '@/lib/video/multiview-task-privacy';
import { toVideoTaskView, videoTaskViewSelect } from './video-task';
import type { DtoViewer } from './user';
import { taskThumbnailProjection } from '@/lib/video/task-thumbnail-projection';

export const videoTaskDetailSelect = { ...videoTaskViewSelect, raw_status_response: true, provider_usage_snapshot: true,
  params_json: true, provider_payload_json: true } as const satisfies Prisma.VideoTaskSelect;
export type VideoTaskDetailSource = Prisma.VideoTaskGetPayload<{ select: typeof videoTaskDetailSelect }>;
type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | null => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
function json(value: string | null | undefined) {
  if (!value || value.length > 2 * 1024 * 1024) return null;
  try { return record(JSON.parse(value)); } catch { return null; }
}
function text(value: unknown, max = 512): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max)
    : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
}
function numeric(value: unknown): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return null;
  const number = Number(value); return Number.isFinite(number) ? number : null;
}
function first<T>(rows: JsonRecord[], keys: string[], convert: (value: unknown) => T | null): T | null {
  for (const row of rows) for (const key of keys) { const value = convert(row[key]); if (value !== null) return value; }
  return null;
}
function seconds(value: number | null) { return value === null ? null : value < 60 ? `${Math.round(value)} 秒` : `约 ${Math.round(value / 60)} 分钟`; }
const riskLabels: Record<string, string> = {
  long_720p_oom_risk: '15 秒 720P 显存风险高，建议改用 LightX2V、降低分辨率或缩短秒数',
  high_vram_margin: '显存余量偏低', above_benchmark_frame_count: '帧数超过当前 benchmark 范围',
};

export function videoTaskDetails(task: VideoTaskDetailSource, viewer: DtoViewer) {
  if (isPrivateMultiviewTask(task)) return { provider_billing: null, h3_runtime: null,
    enhance_source_task_id: null, enhance_details: null, resolved_mode: null, reference_assets: [] };
  const external = isExternalUser(viewer);
  const raw = json(task.raw_status_response);
  const rows = [raw, record(raw?.data), record(raw?.result), record(raw?.response)].filter((value): value is JsonRecord => Boolean(value));
  const params = json(task.params_json), payload = json(task.provider_payload_json);
  const usageValue = json(task.provider_usage_snapshot) || rows.map(row => record(row.usage)).find(Boolean) || null;
  const number = (keys: string[]) => first(rows, keys, numeric);
  const string = (keys: string[]) => first(rows, keys, text);
  const detail = rows.map(row => record(row.progress_detail)).find(Boolean) || null;
  const progress = number(['progress', 'percent']);
  const flags = rows.flatMap(row => Array.isArray(row.risk_flags) ? row.risk_flags : [])
    .filter((value): value is string => typeof value === 'string' && Object.hasOwn(riskLabels, value));
  const referenceAssets = Array.isArray(params?.referenceAssets) ? params.referenceAssets.slice(0, 100).flatMap(value => {
    const entry = record(value); if (!entry) return [];
    const localAssetId = text(entry.localAssetId), providerAssetId = text(entry.providerAssetId), originalUrl = text(entry.originalUrl, 8192);
    if (!localAssetId || !providerAssetId || !originalUrl) return [];
    const mediaUrl = /^[a-zA-Z0-9_-]{1,180}$/.test(localAssetId) ? `/m/asset/${encodeURIComponent(localAssetId)}/preview` : null;
    if (!mediaUrl) return [];
    return [{ localAssetId, provider: text(entry.provider) || '', providerAssetId, originalUrl: mediaUrl,
      name: text(entry.name) || '', providerPreviewUrl: mediaUrl,
      providerStatus: text(entry.providerStatus, 80), order: numeric(entry.order) ?? 0 }];
  }).sort((a, b) => a.order - b.order) : [];
  return {
    provider_billing: external ? null : {
      actualCost: number(['actual_cost', 'actualCost']),
      currency: task.provider_cost_currency || string(['currency_or_credit_type', 'currencyOrCreditType', 'currency']),
      billingStatus: task.provider_billing_status || string(['billing_status', 'billingStatus']),
      billingTime: task.provider_billing_time || number(['billing_time', 'billingTime']) || string(['billing_time', 'billingTime']),
      usageTotalTokens: usageValue ? first([usageValue], ['total_tokens', 'totalTokens'], numeric) : null,
      completionTokens: usageValue ? first([usageValue], ['completion_tokens', 'completionTokens'], numeric) : null,
      providerTaskId: task.provider_task_id || string(['provider_task_id', 'providerTaskId', 'task_id', 'id']),
      clientRequestId: task.provider_client_request_id || string(['clientRequestId', 'client_request_id', 'client_requestId']),
    },
    h3_runtime: task.provider !== 'h3' ? null : {
      progressText: detail ? [first([detail], ['stage', 'phase', 'label'], text), seconds(first([detail], ['elapsed_sec', 'elapsed_seconds'], numeric))].filter(Boolean).join(' · ') || null
        : progress === null ? null : `${Math.round(progress * 100)}%`,
      estimatedRuntimeText: seconds(number(['estimated_runtime_sec'])),
      recommendedTimeoutText: seconds(number(['recommended_timeout_sec'])),
      riskText: flags.length ? [...new Set(flags)].map(flag => riskLabels[flag]).join('；') : null,
      errorCode: string(['error_code', 'code']),
    },
    enhance_source_task_id: ['enhance_video'].includes(task.generation_mode) || task.provider === 'volcengine_mediakit' ? text(params?.source_task_id) : null,
    enhance_details: task.generation_mode === 'enhance_video' || task.provider === 'volcengine_mediakit' ? {
      tool_version: text(params?.tool_version, 80), scene: text(params?.scene, 80),
      source_video_kind: text(params?.source_video_kind, 80), fps: numeric(params?.fps),
    } : null,
    resolved_mode: text(payload?.resolved_mode, 80), reference_assets: referenceAssets,
  };
}

export function toVideoTaskDetail(task: VideoTaskDetailSource, viewer: DtoViewer) {
  return { ...toVideoTaskView(task, viewer), ...videoTaskDetails(task, viewer) };
}

export function toIpVideoTaskDetail(task: VideoTaskDetailSource, viewer: DtoViewer, safeError: string | null) {
  return { ...toVideoTaskDetail(task, viewer),
    ...taskThumbnailProjection({ id: task.id, local_status: task.local_status, delivery_status: task.delivery_status,
      public_video_url: task.public_video_url, local_video_path: task.local_video_path }),
    result_video_url: null, result_last_frame_url: null, error_message: safeError,
  };
}
