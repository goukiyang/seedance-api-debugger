import type { CutoutJob, CutoutKind } from './types';

const kinds = new Set(['cutout', 'characters', 'crop', 'split_preview', 'split_region', 'split_merge', 'split_export']);
const statuses = new Set(['queued', 'running', 'succeeded', 'failed', 'canceled']);
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function hasResultFile(value: Record<string, unknown>) {
  return ['result_url', 'trim_url', 'canvas_url', 'zip_url', 'manifest_url', 'contact_sheet_url']
    .some(key => typeof value[key] === 'string' && /^\/api\/cutout\/v1\/results\/[^/?#]+\/[^/?#]+$/.test(value[key] as string));
}
export function isCutoutJob(value: unknown, expected?: { id?: string; kind?: CutoutKind }): value is CutoutJob {
  if (!isRecord(value) || typeof value.job_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.job_id)
    || typeof value.kind !== 'string' || !kinds.has(value.kind) || typeof value.status !== 'string' || !statuses.has(value.status)
    || typeof value.created_at !== 'number' || !Number.isFinite(value.created_at) || value.created_at < 0
    || typeof value.updated_at !== 'number' || !Number.isFinite(value.updated_at) || value.updated_at < 0
    || expected?.id && value.job_id !== expected.id || expected?.kind && value.kind !== expected.kind) return false;
  if (value.result != null && !isRecord(value.result) || value.error != null && !isRecord(value.error)
    || value.parameters != null && !isRecord(value.parameters)) return false;
  if (value.status === 'succeeded') {
    const result = value.result;
    if (!isRecord(result) || result.success === false || result.items != null && !Array.isArray(result.items)) return false;
    return hasResultFile(result)
      || Array.isArray(result.items) && result.items.length > 0 && result.items.every(item => isRecord(item) && hasResultFile(item))
      || isRecord(result.item) && hasResultFile(result.item);
  }
  return true;
}
