import type { UsageQuery } from '@/lib/admin/usage-types';

export type UsageView = 'overview' | 'members' | 'projects';
export type QueryPatch = Record<string, string | number | null | undefined>;

export const USAGE_PATHS: Record<UsageView, string> = {
  overview: '/admin', members: '/admin/users', projects: '/admin/projects',
};

// Directory searches can contain names. Keep them, record keywords, and response
// bodies out of browser persistence, even though they may be explicit URL input.
const STORED_KEYS = new Set([
  'range', 'year', 'month', 'quarter', 'half', 'date_from', 'date_to', 'time_zone',
  'grain', 'owner_user_id', 'project_id', 'kind', 'source_kind', 'result_ready', 'model', 'provider', 'status',
  'cost_status', 'attribution', 'resolution', 'retention_status', 'page',
  'page_size', 'sort', 'members_page', 'projects_page', 'records_page', 'members_sort', 'projects_sort',
]);

export function defaultUsageSearch() {
  const date = new Date();
  return new URLSearchParams({
    range: 'month', year: String(date.getFullYear()), month: String(date.getMonth() + 1),
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    grain: 'day', page: '1', page_size: '30', sort: 'newest',
  });
}

export function withLocalTimeZone(params: URLSearchParams) {
  const next = new URLSearchParams(params);
  if (!next.has('time_zone')) next.set('time_zone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  // Old bookmarked date filters remain a custom range. Explicit invalid ranges
  // pass through unchanged, so the API can explain the invalid input.
  if (!next.has('range') && (next.has('date_from') || next.has('date_to'))) next.set('range', 'custom');
  return next;
}

export function patchUsageSearch(search: string, patch: QueryPatch, resetPages = true) {
  const next = new URLSearchParams(search);
  if (resetPages) for (const key of ['page', 'records_page', 'members_page', 'projects_page']) next.delete(key);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === '') next.delete(key);
    else next.set(key, String(value));
  }
  return next;
}

export function usageHref(view: UsageView, search: string, patch: QueryPatch = {}) {
  const params = patchUsageSearch(search, patch, false);
  return `${USAGE_PATHS[view]}${params.size ? `?${params}` : ''}`;
}

export function safeStoredSearch(search: string) {
  const result: Record<string, string> = {};
  for (const [key, value] of Array.from(new URLSearchParams(search).entries())) {
    if (!STORED_KEYS.has(key) || value.length > 180 || !/^[A-Za-z0-9_./:+-]+$/.test(value)) continue;
    result[key] = value;
  }
  return result;
}

export function readStoredSearch(value: unknown): URLSearchParams | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = new URLSearchParams();
  for (const [key, item] of Object.entries(value)) if (typeof item === 'string') input.set(key, item);
  const safe = safeStoredSearch(input.toString());
  if (!Object.keys(safe).length) return null;
  if (safe.range && !['month', 'quarter', 'half', 'year', 'recent6m', 'all', 'custom', '7d', '30d'].includes(safe.range)) return null;
  if (safe.grain && !['day', 'week', 'month'].includes(safe.grain)) return null;
  for (const key of ['sort', 'members_sort', 'projects_sort']) {
    if (safe[key] && !['newest', 'oldest', 'usage', 'cost', 'name'].includes(safe[key])) return null;
  }
  for (const [key, values] of Object.entries({ kind: ['video', 'image', 'text', 'flow', 'cutout'],
    source_kind: ['video_task', 'image_task', 'video_studio_run', 'agent_text_step', 'role_run', 'role_attempt', 'toolflow_run', 'cutout_receipt'],
    result_ready: ['ready', 'not_ready', 'unknown'],
    cost_status: ['confirmed', 'pending', 'conflict', 'unconnected'], attribution: ['frozen', 'legacy_current', 'legacy_snapshot', 'unassigned', 'conflict'],
    retention_status: ['active', 'user_deleted', 'admin_hidden', 'retained', 'unknown'] })) {
    if (safe[key] && !values.includes(safe[key])) return null;
  }
  for (const key of ['owner_user_id', 'project_id']) if (safe[key] && !/^[A-Za-z0-9_-]{1,128}$/.test(safe[key])) return null;
  for (const [key, max] of [['month', 12], ['quarter', 4], ['half', 2], ['year', 9998]] as const) {
    if (safe[key] && (!/^\d+$/.test(safe[key]) || Number(safe[key]) < 1 || Number(safe[key]) > max)) return null;
  }
  for (const key of ['page', 'members_page', 'projects_page', 'records_page']) {
    if (safe[key] && (!/^\d+$/.test(safe[key]) || Number(safe[key]) < 1 || Number(safe[key]) > 1_000_000)) return null;
  }
  if (safe.page_size && !['20', '30', '50', '100'].includes(safe.page_size)) return null;
  try { if (safe.time_zone) new Intl.DateTimeFormat('zh-CN', { timeZone: safe.time_zone }); } catch { return null; }
  const selectors: Record<string, string[]> = { month: ['year', 'month'], quarter: ['year', 'quarter'], half: ['year', 'half'], year: ['year'], custom: ['date_from', 'date_to'] };
  const range = safe.range || (safe.date_from || safe.date_to ? 'custom' : 'month');
  if (['year', 'month', 'quarter', 'half', 'date_from', 'date_to'].some(key => safe[key] && !(selectors[range] || []).includes(key))) return null;
  for (const key of ['date_from', 'date_to']) {
    if (!safe[key]) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(safe[key])) return null;
    const [year, month, day] = safe[key].split('-').map(Number);
    const date = new Date(0); date.setUTCFullYear(year, month - 1, day);
    if (year < 1 || year > 9998 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  }
  if (range === 'custom' && (!safe.date_from || !safe.date_to || safe.date_from > safe.date_to)) return null;
  return new URLSearchParams(safe);
}

export function actualRangeLabel(query: UsageQuery) {
  if (!query.startUtc && !query.endUtc) return '全部时间';
  try {
    const format = new Intl.DateTimeFormat('zh-CN', { timeZone: query.time_zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const start = query.startUtc ? format.format(new Date(query.startUtc)) : '最早记录';
    // The server range is [start, end). The last included millisecond gives the
    // calendar end date without subtracting a local day across daylight saving.
    const end = query.endUtc ? format.format(new Date(Date.parse(query.endUtc) - 1)) : '当前';
    return `${start} 至 ${end}`;
  } catch { return '实际日期待确认'; }
}
