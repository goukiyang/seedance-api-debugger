import { toUserSummary, type DtoViewer } from './user';

// New database columns do not become browser fields without an explicit addition here.
export const videoTaskScalarFields = [
  'id', 'provider', 'model', 'generation_mode', 'prompt', 'source_type', 'source_label',
  'ratio', 'duration', 'resolution', 'seed', 'generate_audio', 'return_last_frame', 'watermark',
  'reference_image_urls', 'reference_video_urls', 'reference_audio_urls', 'first_frame_url', 'last_frame_url',
  'frame_image_urls', 'reference_image_ids', 'reference_album_ids', 'execution_expires_after',
  'local_status', 'provider_status', 'is_draft', 'draft_upgrade_mode', 'source_draft_task_id', 'draft_contract_version',
  'result_video_url', 'result_last_frame_url', 'local_video_path', 'public_video_url', 'public_video_storage_provider',
  'public_video_file_size', 'public_video_cached_at', 'delivery_status', 'delivery_queued_at', 'delivery_started_at',
  'delivery_completed_at', 'delivery_attempts', 'delivery_error', 'error_message', 'error_code',
  'user_id', 'owner_user_id', 'project_id', 'video_card_id', 'video_branch_id', 'creation_intent_id',
  'creation_contract_version', 'derived_from_task_id', 'derivation_kind', 'lineage_root_task_id',
  'visibility', 'version_role', 'prompt_user_edited', 'retention_status', 'user_deleted_at', 'user_deleted_by',
  'admin_hidden_at', 'admin_hidden_by', 'restored_at', 'restored_by', 'delete_reason',
  'estimated_cost', 'actual_cost', 'frozen_cost', 'refund_amount', 'charged_cost', 'refunded_cost',
  'billing_scope', 'billing_account_id', 'billing_status', 'cost_allocation_status',
  'created_at', 'updated_at', 'completed_at', 'submitted_at', 'started_at', 'succeeded_at', 'failed_at', 'deleted_at',
  'can_delete', 'retry_count', 'idempotency_key', 'provider_accepted', 'protected_module', 'module_path',
  'stable_download_ready', 'preview_available', 'playable_available', 'play_url', 'download_url', 'thumbnail_url', 'retry_after_ms',
] as const;
export const internalVideoTaskFields = [
  'provider_task_id', 'provider_draft_task_id', 'provider_client_request_id', 'source_request_id',
  'template_id', 'agent_run_id', 'selected_agent_plan_key', 'template_studio_run_id',
  'provider_cost_status', 'provider_cost_currency', 'provider_estimated_amount_minor', 'provider_rule_amount_minor',
  'provider_official_amount_minor', 'provider_final_amount_minor', 'provider_official_amount_micros', 'provider_final_amount_micros',
  'provider_billing_status', 'provider_billing_time', 'provider_cost_confirmed_at', 'provider_cost_reconciled_at',
] as const;
const pricingFields = ['estimatedCost', 'actualCost', 'frozenCost', 'duration', 'resolution', 'rate', 'currency',
  'unit', 'unitPrice', 'pointsPerYuan', 'pricingRuleId', 'pricingRuleName', 'pricingRuleVersion', 'pricingPolicyRevision',
  'baseCostPerSecond', 'internalMultiplier', 'finalCostPerSecond', 'formula', 'model', 'toolVersion', 'fps',
  'costSource', 'confidence', 'pricing_revision', 'policyApplied'] as const;
const relationFields = {
  project: ['id', 'name', 'type'],
  video_card: ['id', 'title', 'objective', 'status', 'project_id'],
  generation_template: ['id', 'name', 'template_key', 'version', 'status'],
  delivery_stage: ['key', 'label', 'message', 'stableDownloadReady', 'previewAvailable'],
} as const;
export type VideoTaskFields<T> = Pick<T, Extract<keyof T, typeof videoTaskScalarFields[number] | typeof internalVideoTaskFields[number]
  | 'pricing_snapshot' | 'owner' | 'user' | 'submitted_user' | keyof typeof relationFields>>;
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function scalar(value: unknown) { return value === null || typeof value === 'string' || typeof value === 'boolean'
  || typeof value === 'number' && Number.isFinite(value) || value instanceof Date; }
function pick(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined && scalar(value[key])).map(key => [key, value[key]]));
}

export function projectVideoTaskFields<T extends object>(task: T, options: { external?: boolean; viewer?: DtoViewer } = {}): VideoTaskFields<T> {
  const source = task as Record<string, unknown>;
  const result: Record<string, unknown> = pick(source, options.external ? videoTaskScalarFields : [...videoTaskScalarFields, ...internalVideoTaskFields]);
  for (const key of ['error_message', 'delivery_error']) {
    const message = result[key];
    if (typeof message === 'string' && /https?:\/\/|\bbearer\s+\S+|\b(?:api[_-]?key|authorization|cookie|(?:access[_-]?|refresh[_-]?)?token|secret|password|sig(?:nature)?)["']?\s*[:=]/i.test(message)) {
      result[key] = key === 'delivery_error' ? '文件交付详情需管理员核对，请保留原任务。' : '错误详情需管理员核对，请保留原任务，不要重复提交。';
    }
  }
  for (const key of ['owner', 'user', 'submitted_user'] as const) {
    if (source[key] === null) result[key] = null;
    else if (isRecord(source[key])) result[key] = toUserSummary(source[key], options.viewer);
  }
  for (const [key, keys] of Object.entries(relationFields)) {
    if (options.external && key === 'generation_template') continue;
    if (source[key] === null) result[key] = null;
    else if (isRecord(source[key])) result[key] = pick(source[key], keys);
  }
  if (typeof source.pricing_snapshot === 'string') {
    try { const value: unknown = JSON.parse(source.pricing_snapshot); result.pricing_snapshot = isRecord(value) ? JSON.stringify(pick(value, pricingFields)) : null; }
    catch { result.pricing_snapshot = null; }
  } else if (source.pricing_snapshot === null) result.pricing_snapshot = null;
  if (typeof source.id === 'string' && /^[a-zA-Z0-9_-]{1,180}$/.test(source.id)) {
    const id = encodeURIComponent(source.id);
    for (const key of ['result_video_url', 'local_video_path', 'public_video_url']) {
      if (typeof source[key] === 'string' && source[key]) result[key] = `/m/video/${id}/preview`;
    }
    if (typeof source.result_last_frame_url === 'string' && source.result_last_frame_url) result.result_last_frame_url = `/m/video-frame/${id}/original`;
    for (const [key, role] of [['reference_image_urls', 'image'], ['reference_video_urls', 'video'],
      ['reference_audio_urls', 'audio'], ['frame_image_urls', 'frame']] as const) {
      if (typeof source[key] !== 'string') continue;
      try {
        const values: unknown = JSON.parse(source[key] as string);
        result[key] = JSON.stringify(Array.isArray(values) ? values.slice(0, 100).flatMap((value, index) =>
          typeof value === 'string' && value ? [`/m/video-input/${id}--${role}--${index}/preview`] : []) : []);
      } catch { result[key] = '[]'; }
    }
    for (const [key, role] of [['first_frame_url', 'first'], ['last_frame_url', 'last']] as const) {
      if (typeof source[key] === 'string' && source[key]) result[key] = `/m/video-input/${id}--${role}--0/preview`;
    }
  } else {
    for (const key of ['result_video_url', 'local_video_path', 'public_video_url', 'result_last_frame_url',
      'reference_image_urls', 'reference_video_urls', 'reference_audio_urls', 'frame_image_urls',
      'first_frame_url', 'last_frame_url', 'play_url', 'download_url', 'thumbnail_url']) delete result[key];
  }
  return result as VideoTaskFields<T>;
}
