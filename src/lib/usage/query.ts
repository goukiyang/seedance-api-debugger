import type { PublicUsageScope, UsagePublicQuery } from './dto';
import { UsageQueryError, usageDateStartUtc, usageLocalDate } from '@/lib/admin/usage-query';

export { UsageQueryError };
const keys = new Set(['month', 'time_zone', 'type', 'project_id', 'member_owner_id', 'status', 'keyword', 'sort', 'page', 'limit']);
const invalid = (key: string): never => { throw new UsageQueryError(`用量条件 ${key} 无效，请重新选择`); };

export function parseUsageQuery(params: URLSearchParams, scope: PublicUsageScope, now = new Date()): UsagePublicQuery {
  if (!Number.isFinite(now.getTime())) invalid('now');
  params.forEach((_value, key) => {
    if (!keys.has(key) || params.getAll(key).length !== 1 || scope.kind === 'self' && key === 'member_owner_id') invalid(key);
  });
  const text = (key: string, max: number, pattern?: RegExp): string | null => {
    const value = params.get(key);
    if (value === null) return null;
    if (!value || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || pattern && !pattern.test(value)) invalid(key);
    return value;
  };
  const choice = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const value = text(key, 64);
    if (value === null) return fallback;
    if (!allowed.includes(value as T)) invalid(key);
    return value as T;
  };
  const integer = (key: string, max: number, fallback: number) => {
    const value = text(key, 12, /^\d+$/);
    const result = value === null ? fallback : Number(value);
    if (!Number.isSafeInteger(result) || result < 1 || result > max) invalid(key);
    return result;
  };
  const timeZone = text('time_zone', 100) || 'UTC';
  try {
    if (/^[+-]/.test(timeZone)) invalid('time_zone');
    new Intl.DateTimeFormat('en-US', { timeZone }).format(now);
  } catch { invalid('time_zone'); }
  const month = text('month', 7, /^\d{4}-(0[1-9]|1[0-2])$/) || usageLocalDate(now, timeZone).slice(0, 7);
  if (Number(month.slice(0, 4)) < 1 || Number(month.slice(0, 4)) > 9998) invalid('month');
  const project = text('project_id', 128, /^[A-Za-z0-9_-]+$/);
  const member = text('member_owner_id', 128, /^[A-Za-z0-9_-]+$/);
  if (scope.kind === 'project' && (project !== null && project !== scope.projectId || member !== null && member !== (scope.memberOwnerId || null))) invalid('project_id/member_owner_id');
  return {
    month, time_zone: timeZone, type: choice('type', ['video', 'image', 'other'] as const, 'video'),
    project_id: scope.kind === 'project' ? scope.projectId : project,
    member_owner_id: scope.kind === 'project' ? scope.memberOwnerId || null : null,
    status: text('status', 64, /^[A-Za-z0-9_-]+$/), keyword: text('keyword', 120),
    sort: choice('sort', ['newest', 'oldest', 'cost'] as const, 'newest'),
    page: integer('page', 1_000_000_000, 1), limit: integer('limit', 50, 20),
  };
}

export function shiftUsageMonth(month: string, delta: number): string {
  const [year, number] = month.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, number - 1 + delta, 1);
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function usageMonthRange(query: Pick<UsagePublicQuery, 'month' | 'time_zone'>) {
  return { startUtc: usageDateStartUtc(`${query.month}-01`, query.time_zone),
    endUtc: usageDateStartUtc(`${shiftUsageMonth(query.month, 1)}-01`, query.time_zone), timeZone: query.time_zone };
}
