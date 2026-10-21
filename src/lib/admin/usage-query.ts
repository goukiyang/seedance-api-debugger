import type { UsageQuery, UsageRange, UsageSourceKind } from './usage-types';

// Compatibility alias; the shared contract owns all independent table controls.
export type UsageTableQuery = UsageQuery;

const ranges: UsageRange[] = ['month', 'quarter', 'half', 'year', 'recent6m', 'all', 'custom', '7d', '30d'];
const sources: UsageSourceKind[] = ['video_task', 'image_task', 'video_studio_run', 'agent_text_step', 'role_run', 'role_attempt', 'toolflow_run', 'cutout_receipt'];
const sorts: UsageQuery['sort'][] = ['newest', 'oldest', 'usage', 'cost', 'name'];
const keys = new Set(['range', 'year', 'month', 'quarter', 'half', 'date_from', 'date_to', 'time_zone', 'grain',
  'owner_user_id', 'project_id', 'kind', 'source_kind', 'model', 'provider', 'status', 'cost_status', 'attribution', 'resolution',
  'keyword', 'retention_status', 'result_ready', 'page', 'page_size', 'sort', 'members_page', 'projects_page', 'records_page',
  'members_sort', 'projects_sort', 'members_search', 'projects_search', 'type']);

export class UsageQueryError extends Error {
  readonly status = 400;
}
function invalid(key: string): never { throw new UsageQueryError(`使用分析条件 ${key} 无效，请重新选择`); }

const localDateFormatters = new Map<string, Intl.DateTimeFormat>();
export function usageLocalDate(date: Date, timeZone: string): string {
  let formatter = localDateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', era: 'short' });
    if (localDateFormatters.size >= 32) localDateFormatters.delete(localDateFormatters.keys().next().value!);
    localDateFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || '';
  const year = Number(get('year'));
  return `${String(get('era') === 'BC' ? 1 - year : year).padStart(4, '0')}-${get('month')}-${get('day')}`;
}

function utcDate(year: number, month: number, day: number) {
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  value.setUTCHours(0, 0, 0, 0);
  return value;
}

function calendarDate(year: number, month: number, day = 1) {
  const value = utcDate(year, month, day);
  return `${String(value.getUTCFullYear()).padStart(4, '0')}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}

export function shiftUsageDate(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number);
  return calendarDate(year, month, day + days);
}

function shiftCalendarMonths(date: string, months: number) {
  const [year, month, day] = date.split('-').map(Number);
  const target = utcDate(year, month + months, 1);
  const targetYear = target.getUTCFullYear(), targetMonth = target.getUTCMonth() + 1;
  const lastDay = utcDate(targetYear, targetMonth + 1, 0).getUTCDate();
  return calendarDate(targetYear, targetMonth, Math.min(day, lastDay));
}

// First instant on/after this local calendar date. Searching date boundaries rather
// than subtracting a fixed offset handles 23/25-hour days and midnight DST changes.
export function usageDateStartUtc(date: string, timeZone: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const center = utcDate(year, month, day).getTime();
  let low = center - 48 * 60 * 60 * 1000;
  let high = center + 48 * 60 * 60 * 1000;
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', era: 'short' });
  const local = (time: number) => {
    const p = formatter.formatToParts(new Date(time));
    const read = (type: string) => p.find(item => item.type === type)?.value || '';
    const y = Number(read('year'));
    return utcDate(read('era') === 'BC' ? 1 - y : y, Number(read('month')), Number(read('day'))).getTime();
  };
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (local(mid) < center) low = mid + 1;
    else high = mid;
  }
  return new Date(low).toISOString();
}

/** Custom date_to is inclusive, like the old date picker. UTC endUtc is exclusive.
 * recent6m = local today minus six calendar months, clamped to that month's
 * last day, through today inclusive. It is neither 180 days nor six month bins.
 * Callers should omit time selectors that do not belong to the chosen range.
 */
export function parseUsageQuery(params: URLSearchParams, now = new Date()): UsageQuery {
  if (!Number.isFinite(now.getTime())) invalid('now');
  params.forEach((_value, key) => {
    if (!keys.has(key) || params.getAll(key).length !== 1) invalid(key);
  });
  const text = (key: string, max: number, pattern?: RegExp): string | null => {
    const value = params.get(key);
    if (value === null) return null;
    if (!value || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || pattern && !pattern.test(value)) invalid(key);
    return value;
  };
  const enumeration = <T extends string>(key: string, values: readonly T[], fallback: T): T => {
    const value = text(key, 128);
    if (value === null) return fallback;
    if (!values.includes(value as T)) invalid(key);
    return value as T;
  };
  const optionalEnum = <T extends string>(key: string, values: readonly T[]): T | null => {
    if (!params.has(key)) return null;
    return enumeration(key, values, values[0]);
  };
  const integer = (key: string, min: number, max: number, fallback: number) => {
    const value = text(key, 10, /^\d+$/);
    if (value === null) return fallback;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max) invalid(key);
    return n;
  };
  const timeZone = text('time_zone', 100) || 'UTC';
  try {
    if (/^[+-]/.test(timeZone)) invalid('time_zone');
    new Intl.DateTimeFormat('en-US', { timeZone }).format(now);
  } catch { invalid('time_zone'); }
  const today = usageLocalDate(now, timeZone);
  const [thisYear, thisMonth] = today.split('-').map(Number);
  const range = enumeration('range', ranges, params.has('date_from') || params.has('date_to') ? 'custom' : 'month');
  const selectors: Record<UsageRange, string[]> = { month: ['year', 'month'], quarter: ['year', 'quarter'], half: ['year', 'half'],
    year: ['year'], custom: ['date_from', 'date_to'], recent6m: [], all: [], '7d': [], '30d': [] };
  for (const key of ['year', 'month', 'quarter', 'half', 'date_from', 'date_to']) {
    if (params.has(key) && !selectors[range].includes(key)) invalid(`${range}/${key}`);
  }
  const year = integer('year', 1, 9998, thisYear);
  const month = integer('month', 1, 12, thisMonth);
  const quarter = integer('quarter', 1, 4, Math.ceil(thisMonth / 3));
  const half = integer('half', 1, 2, thisMonth <= 6 ? 1 : 2);
  const date = (key: string) => {
    const value = text(key, 10, /^\d{4}-\d{2}-\d{2}$/);
    if (value === null) return null;
    const [y, m, d] = value.split('-').map(Number);
    if (y < 1 || y > 9998 || calendarDate(y, m, d) !== value) invalid(key);
    return value;
  };
  const dateFrom = date('date_from'), dateTo = date('date_to');
  let start: string | null = null, end: string | null = null;
  switch (range) {
    case 'month': start = calendarDate(year, month); end = calendarDate(year, month + 1); break;
    case 'quarter': start = calendarDate(year, (quarter - 1) * 3 + 1); end = calendarDate(year, quarter * 3 + 1); break;
    case 'half': start = calendarDate(year, (half - 1) * 6 + 1); end = calendarDate(year, half * 6 + 1); break;
    case 'year': start = calendarDate(year, 1); end = calendarDate(year + 1, 1); break;
    case 'recent6m': start = shiftCalendarMonths(today, -6); end = shiftUsageDate(today, 1); break;
    case '7d': case '30d': start = shiftUsageDate(today, range === '7d' ? -6 : -29); end = shiftUsageDate(today, 1); break;
    case 'custom':
      if (!dateFrom || !dateTo || dateFrom > dateTo) invalid('date_from/date_to');
      start = dateFrom; end = shiftUsageDate(dateTo, 1); break;
    case 'all': break;
  }
  if (params.has('type')) enumeration('type', ['summary', 'records'] as const, 'records');
  const token = /^[a-zA-Z0-9_./:+-]+$/;
  const result: UsageQuery = {
    range, year, month, quarter, half, date_from: dateFrom, date_to: dateTo, time_zone: timeZone,
    grain: enumeration('grain', ['day', 'week', 'month'] as const, 'day'),
    owner_user_id: text('owner_user_id', 128, /^[a-zA-Z0-9_-]+$/), project_id: text('project_id', 128, /^[a-zA-Z0-9_-]+$/),
    kind: optionalEnum('kind', ['video', 'image', 'text', 'flow', 'cutout'] as const),
    source_kind: optionalEnum('source_kind', sources),
    model: text('model', 160, token), provider: text('provider', 128, token), status: text('status', 64, token),
    cost_status: optionalEnum('cost_status', ['confirmed', 'pending', 'conflict', 'unconnected'] as const),
    attribution: optionalEnum('attribution', ['frozen', 'legacy_current', 'legacy_snapshot', 'unassigned', 'conflict'] as const),
    resolution: text('resolution', 40, /^[a-zA-Z0-9_.xX-]+$/), keyword: text('keyword', 120),
    retention_status: optionalEnum('retention_status', ['active', 'user_deleted', 'admin_hidden', 'retained', 'unknown'] as const),
    result_ready: optionalEnum('result_ready', ['ready', 'not_ready', 'unknown'] as const),
    page: integer('page', 1, 1_000_000_000, 1),
    page_size: Number(enumeration('page_size', ['20', '30', '50', '100'] as const, '30')) as UsageQuery['page_size'],
    sort: enumeration('sort', sorts, 'newest'),
    startUtc: start ? usageDateStartUtc(start, timeZone) : null,
    endUtc: end ? usageDateStartUtc(end, timeZone) : null,
  };
  for (const key of ['members_page', 'projects_page', 'records_page'] as const) {
    if (params.has(key)) result[key] = integer(key, 1, 1_000_000_000, 1);
  }
  for (const key of ['members_sort', 'projects_sort'] as const) {
    if (params.has(key)) result[key] = enumeration(key, sorts, result.sort);
  }
  for (const key of ['members_search', 'projects_search'] as const) {
    if (params.has(key)) result[key] = text(key, 120);
  }
  return result;
}

// Canonical URL projection also avoids sending inactive calendar selectors back.
export function usageQuerySearchParams(query: UsageQuery, includeTables = true): URLSearchParams {
  const params = new URLSearchParams({ range: query.range, time_zone: query.time_zone, grain: query.grain });
  const rangeKeys: Partial<Record<UsageRange, Array<keyof UsageQuery>>> = {
    month: ['year', 'month'], quarter: ['year', 'quarter'], half: ['year', 'half'], year: ['year'], custom: ['date_from', 'date_to'],
  };
  for (const key of [...(rangeKeys[query.range] || []), 'owner_user_id', 'project_id', 'kind', 'source_kind', 'model', 'provider', 'status',
    'cost_status', 'attribution', 'resolution', 'keyword', 'retention_status', 'result_ready'] as Array<keyof UsageQuery>) {
    const value = query[key];
    if (value !== null && value !== undefined) params.set(key, String(value));
  }
  if (includeTables) {
    for (const key of ['page', 'page_size', 'sort', 'members_page', 'projects_page', 'records_page',
      'members_sort', 'projects_sort', 'members_search', 'projects_search'] as const) {
      const value = query[key];
      if (value !== null && value !== undefined) params.set(key, String(value));
    }
  }
  return params;
}
