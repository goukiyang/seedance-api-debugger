import type { Prisma } from '@prisma/client';
import { taskThumbnailProjection, type TaskThumbnailProjectionSource } from './task-thumbnail-projection';
import { parseMultiviewActionBinding, type MultiviewActionBinding } from './multiview-action-contract';

/** This object is written only after the server has accepted a private recipe. */
export type MultiviewPrivateTaskMarker = { kind: 'multiview' | 'multiview-action'; schema: 1; recipeVersion: string;
  actionBinding?: MultiviewActionBinding };
export type TaskProtectionSource = { source_metadata_json: string | null };
export const MULTIVIEW_PRIVATE_MODULE = 'multiview' as const;
export const MULTIVIEW_PRIVATE_SCHEMA = 1 as const;
export const MULTIVIEW_PUBLIC_TASK_TITLE = '3D多视图';
export const MULTIVIEW_ACTION_PUBLIC_TASK_TITLE = '同步动作视频';
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export function multiviewPrivateTaskMarker(recipeVersion: string): MultiviewPrivateTaskMarker {
  if (!/^1\.0\.(?:0|[1-9]\d{0,15})$/.test(recipeVersion)) throw new Error('私有配方版本无效');
  return { kind: MULTIVIEW_PRIVATE_MODULE, schema: MULTIVIEW_PRIVATE_SCHEMA, recipeVersion };
}
export function multiviewActionPrivateTaskMarker(binding: MultiviewActionBinding): MultiviewPrivateTaskMarker {
  const parsed = parseMultiviewActionBinding(binding);
  if (!parsed) throw new Error('动作视频绑定无效');
  return { kind: 'multiview-action', schema: 1, recipeVersion: 'action-v1', actionBinding: parsed };
}
export function isPrivateMultiviewActionTask(task: TaskProtectionSource): boolean {
  const marker = metadata(task)?.protected_module;
  return record(marker) && marker.kind === 'multiview-action';
}

function metadata(task: TaskProtectionSource): Record<string, unknown> | null {
  // A partial SELECT is not evidence that a task is public. Callers must select
  // the protection column (nullable on real legacy rows) or load it by identity.
  if (!Object.prototype.hasOwnProperty.call(task, 'source_metadata_json') || task.source_metadata_json === undefined) {
    throw new Error('任务保护字段未加载，不能返回任务详情');
  }
  if (task.source_metadata_json === null || task.source_metadata_json === '') return null;
  try {
    const value: unknown = JSON.parse(task.source_metadata_json);
    return record(value) ? value : null;
  } catch {
    // Preserve corrupt protected records as protected, never fall back to a
    // legacy spread. Unrelated malformed historical metadata is not reclassified.
    return /"protected_module"\s*:/.test(task.source_metadata_json) ? { protected_module: null } : null;
  }
}

export function isPrivateMultiviewTask(task: TaskProtectionSource): boolean {
  const value = metadata(task);
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, 'protected_module'));
}

/** Execution/retry must validate the version, not merely see a protected bit. */
export function readMultiviewPrivateTaskMarker(task: TaskProtectionSource): MultiviewPrivateTaskMarker | null {
  const value = metadata(task);
  if (!value || !Object.prototype.hasOwnProperty.call(value, 'protected_module')) return null;
  const marker = value.protected_module;
  if (record(marker) && marker.kind === 'multiview-action' && marker.schema === 1 && marker.recipeVersion === 'action-v1') {
    const binding = parseMultiviewActionBinding(marker.actionBinding);
    if (binding) return multiviewActionPrivateTaskMarker(binding);
  }
  if (!record(marker) || marker.kind !== MULTIVIEW_PRIVATE_MODULE || marker.schema !== MULTIVIEW_PRIVATE_SCHEMA
    || typeof marker.recipeVersion !== 'string' || !/^1\.0\.(?:0|[1-9]\d{0,15})$/.test(marker.recipeVersion)) {
    throw new Error('该任务的私有配方记录暂时无法确认，请保留原任务并联系管理员');
  }
  return multiviewPrivateTaskMarker(marker.recipeVersion);
}

// Matching the structural key also excludes corrupt/unknown protected versions.
// The client source-metadata allowlist cannot persist this key.
export function privateMultiviewTaskWhere(): Prisma.VideoTaskWhereInput {
  return { source_metadata_json: { contains: '"protected_module"' } };
}
export function ordinaryVideoTaskWhere(): Prisma.VideoTaskWhereInput {
  return { OR: [{ source_metadata_json: null }, { NOT: privateMultiviewTaskWhere() }] };
}
export function safeVideoTaskKeywordWhere(keyword: string): Prisma.VideoTaskWhereInput {
  return { OR: [
    { id: { contains: keyword } },
    { AND: [ordinaryVideoTaskWhere(), { prompt: { contains: keyword } }] },
    ...(MULTIVIEW_PUBLIC_TASK_TITLE.includes(keyword) || MULTIVIEW_ACTION_PUBLIC_TASK_TITLE.includes(keyword) ? [privateMultiviewTaskWhere()] : []),
  ] };
}

export function privateMultiviewFailure(error: unknown, status?: unknown): { code: string; message: string } | null {
  if (!error && status !== 'failed') return null;
  const text = typeof error === 'string' ? error.toLowerCase() : '';
  if (/insufficient|余额|点数不足|积分不足/.test(text)) return { code: 'CREDITS_UNAVAILABLE', message: '点数不足或费用状态待确认，请先核对余额和原任务账单。' };
  if (/permission|forbidden|无权|权限|access.denied/.test(text)) return { code: 'INPUT_PERMISSION_CHANGED', message: '输入素材或项目权限已变化，请保留原任务并重新核对有权使用的素材。' };
  if (/image|图片|reference|参考图/.test(text) && /invalid|unavailable|missing|不存在|不可用|失效|format|格式/.test(text)) {
    return { code: 'INPUT_UNAVAILABLE', message: '生成服务无法使用本次输入图片，请核对本人主图；系统参考图由管理员处理。' };
  }
  if (/moderation|safety|违规|审核|content.policy/.test(text)) return { code: 'PROVIDER_CONTENT_REJECTED', message: '生成服务未通过本次内容审核；请调整本人输入或补充要求，不要反复提交相同内容。' };
  if (/timeout|network|connect|查询|超时|网络|unknown|待确认/.test(text) && status !== 'failed') {
    return { code: 'ORIGINAL_REQUEST_CHECK_REQUIRED', message: '原任务状态暂时无法确认，请继续核对这个任务，不要重新提交。' };
  }
  return { code: 'GENERATION_NOT_COMPLETED', message: '本次生成未完成，原任务和输入仍保留；请核对原任务状态及费用，再决定是否主动重试。' };
}

const scalarKeys = [
  'id', 'user_id', 'owner_user_id', 'project_id', 'video_card_id', 'video_branch_id',
  'provider', 'model', 'generation_mode', 'ratio', 'duration', 'resolution', 'seed',
  'generate_audio', 'return_last_frame', 'watermark', 'local_status', 'provider_status',
  'retention_status', 'visibility', 'estimated_cost', 'frozen_cost', 'actual_cost',
  'charged_cost', 'refunded_cost', 'refund_amount', 'billing_scope', 'billing_account_id', 'billing_status',
  'provider_cost_status', 'provider_cost_currency', 'provider_estimated_amount_minor', 'provider_rule_amount_minor',
  'provider_official_amount_minor', 'provider_final_amount_minor', 'provider_official_amount_micros', 'provider_final_amount_micros',
  'provider_billing_status', 'provider_billing_time', 'provider_cost_confirmed_at', 'provider_cost_reconciled_at',
  'cost_allocation_status', 'version_role', 'can_delete',
  'delivery_status', 'created_at', 'updated_at', 'submitted_at', 'completed_at',
  'started_at', 'succeeded_at', 'failed_at', 'deleted_at', 'is_draft', 'retry_count',
  // The owner's own request key: the multiview page matches its poll to the original submission by it.
  'idempotency_key',
] as const;
const pricingKeys = ['estimatedCost', 'actualCost', 'frozenCost', 'duration', 'resolution', 'rate', 'currency',
  'unit', 'unitPrice', 'pointsPerYuan', 'pricingRuleId', 'pricingRuleName', 'pricingRuleVersion', 'pricingPolicyRevision',
  'baseCostPerSecond', 'internalMultiplier', 'finalCostPerSecond', 'formula', 'model', 'toolVersion', 'fps',
  'costSource', 'confidence', 'pricing_revision', 'policyApplied'] as const;
function scalar(value: unknown) { return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Date; }
const providerStatuses = new Set(['created', 'init', 'submitted', 'pending', 'queued', 'waiting', 'running', 'processing',
  'generating', 'in_progress', 'progress', 'succeeded', 'success', 'completed', 'done', 'finished', 'ready',
  'failed', 'error', 'failure', 'cancelled', 'canceled', 'aborted', 'rejected', 'expired', 'timeout', 'unknown']);
function relation(value: unknown, keys: string[]) {
  if (!record(value)) return value === null ? null : undefined;
  return Object.fromEntries(keys.filter(key => scalar(value[key]) && value[key] !== undefined).map(key => [key, value[key]]));
}

/** Positive allowlist for every browser surface, including the task owner. */
export function projectPrivateMultiviewTask<T extends object & TaskProtectionSource>(task: T): T {
  if (!isPrivateMultiviewTask(task)) return task;
  const source = task as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of scalarKeys) if (source[key] !== undefined && scalar(source[key])) result[key] = source[key];
  // Upstream status is free text until normalized. It must not echo a recipe
  // simply because its property name is on the public allowlist.
  if (result.provider_status !== undefined && result.provider_status !== null) {
    const status = typeof result.provider_status === 'string' ? result.provider_status.toLowerCase() : '';
    result.provider_status = providerStatuses.has(status) ? status : 'unknown';
  }
  // Only whether the supplier accepted the task is shown, never its upstream id.
  const upstreamId = source.provider_task_id;
  result.provider_accepted = typeof upstreamId === 'string' && upstreamId.length > 0 && upstreamId !== source.id
    && upstreamId !== source.provider_client_request_id && upstreamId !== source.idempotency_key;
  const title = isPrivateMultiviewActionTask(task) ? MULTIVIEW_ACTION_PUBLIC_TASK_TITLE : MULTIVIEW_PUBLIC_TASK_TITLE;
  Object.assign(result, { prompt: title, source_label: title,
    protected_module: true, module_path: '/multiview', reference_image_ids: null, reference_image_urls: null });
  const error = privateMultiviewFailure(source.error_message, source.local_status);
  result.error_message = error?.message ?? null;
  result.error_code = error?.code ?? null;
  for (const key of ['project', 'video_card', 'owner', 'user'] as const) {
    const projected = relation(source[key], key === 'project' ? ['id', 'name', 'type'] : key === 'video_card'
      ? ['id', 'title', 'objective', 'status', 'project_id'] : ['id', 'name', 'username', 'avatar_url', 'account_type']);
    if (projected !== undefined) result[key] = projected;
  }
  if (source.submitted_user !== undefined) result.submitted_user = relation(source.submitted_user, ['id', 'name', 'username', 'avatar_url', 'account_type']);
  if (typeof source.pricing_snapshot === 'string') {
    try {
      const pricing: unknown = JSON.parse(source.pricing_snapshot);
      result.pricing_snapshot = record(pricing) ? JSON.stringify(Object.fromEntries(pricingKeys
        .filter(key => pricing[key] !== undefined && scalar(pricing[key])).map(key => [key, pricing[key]]))) : null;
    } catch { result.pricing_snapshot = null; }
  }
  if (typeof source.id === 'string' && typeof source.local_status === 'string') {
    Object.assign(result, taskThumbnailProjection(task as unknown as TaskThumbnailProjectionSource));
  }
  return result as T;
}

/** Partial legacy DTOs must not acquire the newly selected internal column. */
export function projectSelectedMultiviewTask<T extends object & TaskProtectionSource>(task: T): Omit<T, 'source_metadata_json'> {
  if (isPrivateMultiviewTask(task)) return projectPrivateMultiviewTask(task);
  const { source_metadata_json: _protection, ...publicFields } = task;
  return publicFields;
}

/** Ledger source details are internal even when the ledger belongs to the actor. */
export function privateMultiviewLedgerMetadata(value: string | null, protectedTask = false): string | null {
  if (!value) return value;
  let data: unknown;
  try { data = JSON.parse(value); } catch { return protectedTask || value.includes('protected_module') ? null : value; }
  if (!record(data)) return protectedTask ? null : value;
  const source = data.source_metadata;
  if (!protectedTask && (!record(source) || !Object.prototype.hasOwnProperty.call(source, 'protected_module'))) return value;
  const allowed = ['task_id', 'taskId', 'amount', 'quantity', 'currency', 'billing_scope', 'unused_released'];
  return JSON.stringify(Object.fromEntries(allowed.filter(key => scalar(data[key]) && data[key] !== undefined).map(key => [key, data[key]])));
}
