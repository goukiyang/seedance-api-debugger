import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getCostLedgerAuditSummary } from '@/lib/costs/audit';
import { displayUserName } from '@/lib/users/display';

export type DashboardRangeKey = 'all' | '7d' | '30d' | 'month' | 'custom';
export type DashboardResolutionKey = '480p' | '720p' | '1080p' | 'unknown';
export type DashboardWarningTone = 'danger' | 'warning' | 'info';
export type DashboardTrendGranularity = 'day' | 'week' | 'month';

export const DASHBOARD_RESOLUTIONS: DashboardResolutionKey[] = ['480p', '720p', '1080p', 'unknown'];
const KNOWN_RESOLUTIONS = new Set<DashboardResolutionKey>(['480p', '720p', '1080p']);
const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const FINAL_PROVIDER_COST_STATUSES = new Set(['official_confirmed', 'reconciled', 'failed_no_charge']);
const MAX_CUSTOM_RANGE_DAYS = 180;

export type GenerationDashboardQuery = {
  range?: DashboardRangeKey;
  dateFrom?: Date | string | null;
  dateTo?: Date | string | null;
  projectId?: string | null;
  ownerUserId?: string | null;
  resolution?: DashboardResolutionKey | null;
};

export type DashboardCurrencyTotal = {
  currency: string;
  amount_micros: number;
  amount_minor: number;
};

export type DashboardUserSummary = {
  id: string;
  name: string | null;
  username: string;
  email: string;
  avatar_url: string | null;
  account_type: string;
};

export type DashboardRange = {
  key: DashboardRangeKey;
  label: string;
  date_from: string;
  date_to: string;
  max_custom_days: number;
};

export type DashboardKpis = {
  total_tasks: number;
  succeeded_tasks: number;
  failed_tasks: number;
  running_tasks: number;
  pending_tasks: number;
  total_duration_seconds: number;
  total_points: number;
  frozen_points: number;
  refund_points: number;
  official_costs: DashboardCurrencyTotal[];
  average_official_costs: DashboardCurrencyTotal[];
  official_cost_per_second: DashboardCurrencyTotal[];
  official_cost_task_count: number;
  official_cost_duration_seconds: number;
  pending_official_count: number;
  warning_count: number;
};

export type DashboardBreakdownItem = {
  key: string;
  label: string;
  user?: DashboardUserSummary | null;
  count: number;
  succeeded: number;
  failed: number;
  duration_seconds: number;
  points: number;
  official_costs: DashboardCurrencyTotal[];
  official_cost_per_second: DashboardCurrencyTotal[];
  official_cost_duration_seconds: number;
  pending_official_count: number;
  href: string;
};

export type DashboardWarning = {
  id: string;
  type: string;
  tone: DashboardWarningTone;
  title: string;
  count: number;
  detail: string;
  href: string;
};

export type DashboardRecentTask = {
  id: string;
  prompt: string;
  local_status: string;
  provider: string;
  generation_mode: string;
  provider_cost_status: string;
  model: string;
  resolution: DashboardResolutionKey;
  raw_resolution: string | null;
  duration: number | null;
  ratio: string | null;
  actual_cost: number | null;
  estimated_cost: number | null;
  frozen_cost: number | null;
  refund_amount: number | null;
  result_video_url: string | null;
  result_last_frame_url: string | null;
  local_video_path: string | null;
  official_amount_micros: number | null;
  official_amount_minor: number | null;
  official_currency: string | null;
  created_at: string;
  completed_at: string | null;
  owner: DashboardUserSummary | null;
  project: {
    id: string;
    name: string;
    type: string;
    status: string;
  } | null;
  href: string;
};

export type DashboardTrendBucket = {
  key: string;
  label: string;
  date_from: string;
  date_to: string;
  task_count: number;
  enhance_task_count: number;
  duration_seconds: number;
  points: number;
  official_costs: DashboardCurrencyTotal[];
};

export type GenerationDashboardData = {
  range: DashboardRange;
  filters: {
    project_id: string | null;
    owner_user_id: string | null;
    resolution: DashboardResolutionKey | null;
  };
  kpis: DashboardKpis;
  resolution_breakdown: DashboardBreakdownItem[];
  project_breakdown: DashboardBreakdownItem[];
  member_ranking: DashboardBreakdownItem[];
  trends: Record<DashboardTrendGranularity, DashboardTrendBucket[]>;
  warnings: DashboardWarning[];
  recent_tasks: DashboardRecentTask[];
  data_notes: string[];
};

type DashboardTask = Awaited<ReturnType<typeof fetchDashboardTasks>>[number];

function startOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

function parseDateInput(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDate(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localDateFromIso(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function addDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function addMonths(date: Date, months: number) {
  const copy = new Date(date);
  copy.setMonth(copy.getMonth() + months);
  return copy;
}

function startOfWeek(date: Date) {
  const copy = startOfDay(date);
  const day = copy.getDay();
  const daysFromMonday = (day + 6) % 7;
  copy.setDate(copy.getDate() - daysFromMonday);
  return copy;
}

function startOfMonth(date: Date) {
  return startOfDay(new Date(date.getFullYear(), date.getMonth(), 1));
}

function clampCustomStart(start: Date, end: Date) {
  const minStart = new Date(end.getTime() - (MAX_CUSTOM_RANGE_DAYS - 1) * 24 * 60 * 60 * 1000);
  return start < minStart ? minStart : start;
}

export function parseDashboardRange(
  query: GenerationDashboardQuery,
  now = new Date(),
  bounds: { earliestDate?: Date | string | null } = {},
): DashboardRange {
  const key = query.range || 'all';
  const todayEnd = endOfDay(now);
  let start: Date;
  let end: Date = todayEnd;
  let label: string;

  if (key === 'all') {
    const earliest = parseDateInput(bounds.earliestDate);
    start = earliest ? startOfDay(earliest) : startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
    if (start > end) start = startOfDay(end);
    label = '全部';
  } else if (key === '7d') {
    start = startOfDay(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000));
    label = '近 7 天';
  } else if (key === '30d') {
    start = startOfDay(new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000));
    label = '近 30 天';
  } else if (key === 'custom') {
    const parsedEnd = parseDateInput(query.dateTo);
    end = parsedEnd ? endOfDay(parsedEnd) : todayEnd;
    const parsedStart = parseDateInput(query.dateFrom);
    start = parsedStart ? startOfDay(parsedStart) : startOfDay(new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000));
    start = clampCustomStart(start, end);
    if (start > end) start = startOfDay(end);
    label = `${isoDate(start)} 至 ${isoDate(end)}`;
  } else {
    start = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
    label = '本月';
  }

  return {
    key,
    label,
    date_from: isoDate(start),
    date_to: isoDate(end),
    max_custom_days: MAX_CUSTOM_RANGE_DAYS,
  };
}

export function normalizeDashboardResolution(value: string | null | undefined): DashboardResolutionKey {
  const normalized = value?.trim().toLowerCase();
  if (normalized === '480p' || normalized === '720p' || normalized === '1080p') return normalized;
  return 'unknown';
}

export function officialCostMicros(task: {
  provider_official_amount_micros: number | null;
  provider_official_amount_minor: number | null;
}) {
  if (task.provider_official_amount_micros !== null && task.provider_official_amount_micros !== undefined) {
    return task.provider_official_amount_micros;
  }
  if (task.provider_official_amount_minor !== null && task.provider_official_amount_minor !== undefined) {
    return task.provider_official_amount_minor * 10_000;
  }
  return null;
}

function taskActorId(task: { owner_user_id: string | null; user_id: string | null }) {
  return task.owner_user_id || task.user_id || null;
}

function normalizedCurrency(value: string | null | undefined) {
  return value?.trim().toUpperCase() || 'UNKNOWN';
}

function addCurrency(total: Map<string, number>, currency: string | null | undefined, amountMicros: number | null) {
  if (amountMicros === null || amountMicros === undefined) return;
  const key = normalizedCurrency(currency);
  total.set(key, (total.get(key) || 0) + amountMicros);
}

function addCurrencySeconds(total: Map<string, number>, currency: string | null | undefined, seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const key = normalizedCurrency(currency);
  total.set(key, (total.get(key) || 0) + seconds);
}

function sumMapValues(total: Map<string, number>) {
  return Array.from(total.values()).reduce((sum, value) => sum + value, 0);
}

function currencyTotals(total: Map<string, number>, divisor = 1): DashboardCurrencyTotal[] {
  return Array.from(total.entries())
    .map(([currency, amountMicros]) => {
      const value = Math.round(amountMicros / divisor);
      return {
        currency,
        amount_micros: value,
        amount_minor: Math.round(value / 10_000),
      };
    })
    .filter((item) => item.amount_micros !== 0)
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

function currencyPerSecondTotals(costTotal: Map<string, number>, secondsTotal: Map<string, number>): DashboardCurrencyTotal[] {
  return Array.from(costTotal.entries())
    .map(([currency, amountMicros]) => {
      const seconds = secondsTotal.get(currency) || 0;
      if (seconds <= 0) return null;
      const value = Math.round(amountMicros / seconds);
      return {
        currency,
        amount_micros: value,
        amount_minor: Math.round(value / 10_000),
      };
    })
    .filter((item): item is DashboardCurrencyTotal => Boolean(item && item.amount_micros !== 0))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

function outputParams(range: DashboardRange, extra: Record<string, string | null | undefined>) {
  const params = new URLSearchParams({
    date_from: range.date_from,
    date_to: range.date_to,
  });
  Object.entries(extra).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  return `/admin/outputs?${params.toString()}`;
}

function costsHref(anchor?: string) {
  return anchor ? `/admin/costs#${anchor}` : '/admin/costs';
}

type DashboardTrendAccumulator = DashboardTrendBucket & { currencyMap: Map<string, number> };
type DashboardBreakdownAccumulator = DashboardBreakdownItem & {
  currencyMap: Map<string, number>;
  officialCostDurationMap: Map<string, number>;
};

function trendStart(date: Date, granularity: DashboardTrendGranularity) {
  if (granularity === 'week') return startOfWeek(date);
  if (granularity === 'month') return startOfMonth(date);
  return startOfDay(date);
}

function nextTrendStart(date: Date, granularity: DashboardTrendGranularity) {
  if (granularity === 'week') return addDays(date, 7);
  if (granularity === 'month') return addMonths(date, 1);
  return addDays(date, 1);
}

function trendKey(date: Date, granularity: DashboardTrendGranularity) {
  if (granularity === 'month') return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}`;
  return isoDate(date);
}

function trendLabel(date: Date, granularity: DashboardTrendGranularity) {
  if (granularity === 'month') return `${date.getMonth() + 1}月`;
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return granularity === 'week' ? `${month}-${day} 周` : `${month}-${day}`;
}

function createTrendBucket(start: Date, rangeStart: Date, rangeEnd: Date, granularity: DashboardTrendGranularity): DashboardTrendAccumulator {
  const nextStart = nextTrendStart(start, granularity);
  const bucketFrom = start < rangeStart ? rangeStart : start;
  const bucketToCandidate = endOfDay(addDays(nextStart, -1));
  const bucketTo = bucketToCandidate > rangeEnd ? rangeEnd : bucketToCandidate;
  return {
    key: trendKey(start, granularity),
    label: trendLabel(start, granularity),
    date_from: isoDate(bucketFrom),
    date_to: isoDate(bucketTo),
    task_count: 0,
    enhance_task_count: 0,
    duration_seconds: 0,
    points: 0,
    official_costs: [],
    currencyMap: new Map<string, number>(),
  };
}

function finalizeTrendBucket(bucket: DashboardTrendAccumulator): DashboardTrendBucket {
  return {
    key: bucket.key,
    label: bucket.label,
    date_from: bucket.date_from,
    date_to: bucket.date_to,
    task_count: bucket.task_count,
    enhance_task_count: bucket.enhance_task_count,
    duration_seconds: bucket.duration_seconds,
    points: bucket.points,
    official_costs: currencyTotals(bucket.currencyMap),
  };
}

function isEnhanceTrendTask(task: Pick<DashboardTask, 'provider' | 'generation_mode'>) {
  return task.generation_mode === 'enhance_video' || task.provider === 'volcengine_mediakit';
}

function buildOutputTrendBuckets(tasks: DashboardTask[], range: DashboardRange, granularity: DashboardTrendGranularity): DashboardTrendBucket[] {
  const rangeStart = startOfDay(localDateFromIso(range.date_from));
  const rangeEnd = endOfDay(localDateFromIso(range.date_to));
  const buckets = new Map<string, DashboardTrendAccumulator>();
  let cursor = trendStart(rangeStart, granularity);

  while (cursor <= rangeEnd) {
    const bucket = createTrendBucket(cursor, rangeStart, rangeEnd, granularity);
    buckets.set(bucket.key, bucket);
    cursor = nextTrendStart(cursor, granularity);
  }

  tasks.forEach((task) => {
    if (task.local_status !== 'succeeded' || !task.completed_at) return;
    const bucketKey = trendKey(trendStart(task.completed_at, granularity), granularity);
    const bucket = buckets.get(bucketKey);
    if (!bucket) return;
    const officialAmount = officialCostMicros(task);
    bucket.task_count += 1;
    if (isEnhanceTrendTask(task)) bucket.enhance_task_count += 1;
    bucket.duration_seconds += Math.max(0, task.duration ?? 0);
    bucket.points += task.actual_cost ?? 0;
    addCurrency(bucket.currencyMap, task.provider_cost_currency, officialAmount);
  });

  return Array.from(buckets.values()).map(finalizeTrendBucket);
}

function createAccumulator(
  key: string,
  label: string,
  href: string,
  user?: DashboardBreakdownItem['user'],
): DashboardBreakdownAccumulator {
  return {
    key,
    label,
    user,
    count: 0,
    succeeded: 0,
    failed: 0,
    duration_seconds: 0,
    points: 0,
    official_costs: [],
    official_cost_per_second: [],
    official_cost_duration_seconds: 0,
    pending_official_count: 0,
    href,
    currencyMap: new Map<string, number>(),
    officialCostDurationMap: new Map<string, number>(),
  };
}

function finalizeAccumulator(item: DashboardBreakdownAccumulator): DashboardBreakdownItem {
  return {
    key: item.key,
    label: item.label,
    user: item.user,
    count: item.count,
    succeeded: item.succeeded,
    failed: item.failed,
    duration_seconds: item.duration_seconds,
    points: item.points,
    official_costs: currencyTotals(item.currencyMap),
    official_cost_per_second: currencyPerSecondTotals(item.currencyMap, item.officialCostDurationMap),
    official_cost_duration_seconds: sumMapValues(item.officialCostDurationMap),
    pending_official_count: item.pending_official_count,
    href: item.href,
  };
}

async function fetchDashboardTasks(where: Prisma.VideoTaskWhereInput) {
  return prisma.videoTask.findMany({
    where,
    orderBy: { created_at: 'desc' },
    select: {
      id: true,
      prompt: true,
      source_type: true,
      source_label: true,
      local_status: true,
      provider: true,
      generation_mode: true,
      provider_task_id: true,
      model: true,
      resolution: true,
      duration: true,
      ratio: true,
      estimated_cost: true,
      actual_cost: true,
      frozen_cost: true,
      refund_amount: true,
      provider_cost_status: true,
      provider_official_amount_minor: true,
      provider_official_amount_micros: true,
      provider_cost_currency: true,
      result_video_url: true,
      result_last_frame_url: true,
      local_video_path: true,
      project_id: true,
      owner_user_id: true,
      user_id: true,
      cost_allocation_status: true,
      created_at: true,
      completed_at: true,
      owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
      user: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
      project: {
        select: {
          id: true,
          name: true,
          type: true,
          status: true,
          owner_user_id: true,
          owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
        },
      },
      _count: { select: { cost_ledgers: true } },
    },
  });
}

function taskMatchesResolution(task: DashboardTask, resolution?: DashboardResolutionKey | null) {
  if (!resolution) return true;
  return normalizeDashboardResolution(task.resolution) === resolution;
}

function buildDashboardScopeWhere(query: GenerationDashboardQuery): Prisma.VideoTaskWhereInput {
  const where: Prisma.VideoTaskWhereInput = {};

  if (query.projectId) {
    where.project_id = query.projectId === 'unassigned' ? null : query.projectId;
  }
  if (query.ownerUserId) {
    where.OR = [
      { owner_user_id: query.ownerUserId },
      { user_id: query.ownerUserId },
    ];
  }
  return where;
}

function buildTaskWhere(range: DashboardRange, query: GenerationDashboardQuery): Prisma.VideoTaskWhereInput {
  const where: Prisma.VideoTaskWhereInput = {
    ...buildDashboardScopeWhere(query),
    created_at: {
      gte: startOfDay(localDateFromIso(range.date_from)),
      lte: endOfDay(localDateFromIso(range.date_to)),
    },
  };
  return where;
}

function buildOutputTrendWhere(range: DashboardRange, query: GenerationDashboardQuery): Prisma.VideoTaskWhereInput {
  return {
    ...buildDashboardScopeWhere(query),
    local_status: 'succeeded',
    completed_at: {
      gte: startOfDay(localDateFromIso(range.date_from)),
      lte: endOfDay(localDateFromIso(range.date_to)),
    },
  };
}

function ownerSummary(task: DashboardTask) {
  const owner = task.owner || task.user;
  if (!owner) return null;
  return {
    id: owner.id,
    name: owner.name,
    username: owner.username,
    email: owner.email,
    avatar_url: owner.avatar_url,
    account_type: owner.account_type,
  };
}

function userSummary(user: DashboardTask['owner'] | NonNullable<DashboardTask['project']>['owner'] | null | undefined): DashboardUserSummary | null {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    avatar_url: user.avatar_url,
    account_type: user.account_type,
  };
}

function projectBreakdownLabel(project: DashboardTask['project'] | null) {
  if (!project) return '未归属项目';
  if (project.type === 'personal') {
    const ownerName = displayUserName(project.owner);
    return ownerName === '未知用户' ? '个人默认项目' : `${ownerName}的默认项目`;
  }
  return project.name;
}

function isTerminal(task: DashboardTask) {
  return TERMINAL_TASK_STATUSES.has(task.local_status);
}

function pendingOfficialCost(task: DashboardTask) {
  return isTerminal(task) && !FINAL_PROVIDER_COST_STATUSES.has(task.provider_cost_status || '');
}

function addTaskToAccumulator(item: DashboardBreakdownAccumulator, task: DashboardTask) {
  const officialAmount = officialCostMicros(task);
  const durationSeconds = Math.max(0, task.duration ?? 0);
  item.count += 1;
  item.succeeded += task.local_status === 'succeeded' ? 1 : 0;
  item.failed += task.local_status === 'failed' ? 1 : 0;
  item.duration_seconds += durationSeconds;
  item.points += task.actual_cost ?? 0;
  item.pending_official_count += pendingOfficialCost(task) ? 1 : 0;
  addCurrency(item.currencyMap, task.provider_cost_currency, officialAmount);
  if (officialAmount !== null) addCurrencySeconds(item.officialCostDurationMap, task.provider_cost_currency, durationSeconds);
}

function buildWarning(params: {
  id: string;
  type: string;
  tone: DashboardWarningTone;
  title: string;
  count: number;
  detail: string;
  href: string;
}) {
  if (params.count <= 0) return null;
  return params;
}

function buildWarnings(tasks: DashboardTask[], range: DashboardRange, auditSummary: Awaited<ReturnType<typeof getCostLedgerAuditSummary>>, providerFailureCount: number, stalePendingCount: number): DashboardWarning[] {
  const duplicateProviderIds = new Map<string, number>();
  tasks.forEach((task) => {
    const providerTaskId = task.provider_task_id?.trim();
    if (!providerTaskId) return;
    duplicateProviderIds.set(providerTaskId, (duplicateProviderIds.get(providerTaskId) || 0) + 1);
  });
  const duplicateCount = Array.from(duplicateProviderIds.values()).filter((count) => count > 1).length;
  const failedPossibleChargeCount = tasks.filter((task) => (
    ['failed', 'cancelled'].includes(task.local_status)
    && Boolean(task.provider_task_id)
    && task.provider_cost_status !== 'failed_no_charge'
  )).length;
  const missingLocalVideoCount = tasks.filter((task) => (
    task.local_status === 'succeeded'
    && !task.local_video_path
    && !task.result_video_url
    && !task.result_last_frame_url
  )).length;
  const terminalMissingLedgerCount = tasks.filter((task) => isTerminal(task) && task._count.cost_ledgers === 0).length;

  return [
    buildWarning({
      id: 'pending-official-cost',
      type: 'pending_official_cost',
      tone: 'warning',
      title: '待官方确认成本',
      count: tasks.filter(pendingOfficialCost).length,
      detail: '终态任务仍未拿到官方扣费或对账结果，需要在计费与成本页处理。',
      href: costsHref('pending-costs'),
    }),
    buildWarning({
      id: 'failed-possible-charge',
      type: 'failed_possible_charge',
      tone: 'danger',
      title: '失败任务可能已收费',
      count: failedPossibleChargeCount,
      detail: '失败或取消任务已有 Provider ID，但尚未标记为失败未收费。',
      href: costsHref('pending-costs'),
    }),
    buildWarning({
      id: 'unassigned-project',
      type: 'unassigned_project',
      tone: 'warning',
      title: '未归属项目',
      count: tasks.filter((task) => !task.project_id).length,
      detail: '没有项目归属的生成无法稳定做项目成本占比，需要补归属或转入未归属池。',
      href: outputParams(range, { project_id: 'unassigned' }),
    }),
    buildWarning({
      id: 'unallocated-cost',
      type: 'unallocated_cost',
      tone: 'warning',
      title: '成本未分摊',
      count: tasks.filter((task) => task.cost_allocation_status !== 'allocated').length + auditSummary.amount_ledgers_without_allocation_count,
      detail: '有金额账本或任务成本没有明确分摊到项目、用户、任务或未归属池。',
      href: costsHref('audit-checks'),
    }),
    buildWarning({
      id: 'provider-request-failed',
      type: 'provider_request_failed',
      tone: 'danger',
      title: 'Provider 请求失败',
      count: providerFailureCount,
      detail: '外部生成请求失败，可能影响成功率和成本判断。',
      href: costsHref('provider-errors'),
    }),
    buildWarning({
      id: 'stale-pending-provider-request',
      type: 'stale_pending_provider_request',
      tone: 'warning',
      title: 'Provider 请求长时间 pending',
      count: stalePendingCount,
      detail: '超过 30 分钟未结束的 Provider 请求需要确认是否漏更新或超时。',
      href: costsHref('audit-checks'),
    }),
    buildWarning({
      id: 'duplicate-provider-task-id',
      type: 'duplicate_provider_task_id',
      tone: 'danger',
      title: '重复官方任务 ID',
      count: duplicateCount + auditSummary.duplicate_provider_task_ids.length,
      detail: '同一个官方任务 ID 出现在多个内部任务，会影响对账和追溯。',
      href: costsHref('audit-checks'),
    }),
    buildWarning({
      id: 'missing-local-video',
      type: 'missing_local_video',
      tone: 'info',
      title: '完成任务缺少视频源',
      count: missingLocalVideoCount,
      detail: '成功任务没有本地视频或远端视频地址，产出留存和预览可能不完整。',
      href: outputParams(range, { status: 'succeeded' }),
    }),
    buildWarning({
      id: 'terminal-missing-cost-ledger',
      type: 'terminal_missing_cost_ledger',
      tone: 'warning',
      title: '终态任务缺成本账本',
      count: terminalMissingLedgerCount + auditSummary.terminal_tasks_without_cost_ledger_count,
      detail: '终态任务至少应有成本结算、失败未收费或官方扣费账本。',
      href: costsHref('audit-checks'),
    }),
  ].filter((item): item is DashboardWarning => Boolean(item));
}

export async function getGenerationDashboardData(query: GenerationDashboardQuery = {}): Promise<GenerationDashboardData> {
  const allRangeBounds = query.range === 'all' || !query.range
    ? await prisma.videoTask.aggregate({
        where: buildDashboardScopeWhere(query),
        _min: { created_at: true },
      })
    : null;
  const range = parseDashboardRange(query, new Date(), { earliestDate: allRangeBounds?._min.created_at });
  const requestedResolution = query.resolution ? normalizeDashboardResolution(query.resolution) : null;
  const where = buildTaskWhere(range, query);
  const trendWhere = buildOutputTrendWhere(range, query);
  const requestWhere: Prisma.ProviderApiRequestWhereInput = {
    created_at: {
      gte: startOfDay(localDateFromIso(range.date_from)),
      lte: endOfDay(localDateFromIso(range.date_to)),
    },
  };
  if (query.projectId && query.projectId !== 'unassigned') requestWhere.project_id = query.projectId;
  if (query.ownerUserId) requestWhere.user_id = query.ownerUserId;

  const [allTasks, allTrendTasks, auditSummary, providerFailureCount, stalePendingCount] = await Promise.all([
    fetchDashboardTasks(where),
    fetchDashboardTasks(trendWhere),
    getCostLedgerAuditSummary(),
    prisma.providerApiRequest.count({ where: { ...requestWhere, status: 'failed' } }),
    prisma.providerApiRequest.count({
      where: {
        ...requestWhere,
        status: 'pending',
        created_at: { lt: new Date(Date.now() - 30 * 60 * 1000) },
      },
    }),
  ]);

  const tasks = allTasks.filter((task) => taskMatchesResolution(task, requestedResolution));
  const trendTasks = allTrendTasks.filter((task) => taskMatchesResolution(task, requestedResolution));
  const officialTotal = new Map<string, number>();
  const officialCostDurationTotal = new Map<string, number>();
  const resolutionMap = new Map<DashboardResolutionKey, DashboardBreakdownAccumulator>();
  const projectMap = new Map<string, DashboardBreakdownAccumulator>();
  const memberMap = new Map<string, DashboardBreakdownAccumulator>();

  DASHBOARD_RESOLUTIONS.forEach((resolution) => {
    resolutionMap.set(resolution, createAccumulator(
      resolution,
      resolution === 'unknown' ? '未记录' : resolution,
      outputParams(range, { resolution }),
    ));
  });

  let totalPoints = 0;
  let totalDurationSeconds = 0;
  let frozenPoints = 0;
  let refundPoints = 0;
  let officialTaskCount = 0;
  let succeededTasks = 0;
  let failedTasks = 0;
  let runningTasks = 0;
  let pendingTasks = 0;
  let pendingOfficialCount = 0;

  tasks.forEach((task) => {
    const officialAmount = officialCostMicros(task);
    const durationSeconds = Math.max(0, task.duration ?? 0);
    const resolution = normalizeDashboardResolution(task.resolution);
    const projectKey = task.project_id || 'unassigned';
    const projectLabel = projectBreakdownLabel(task.project);
    const projectOwner = userSummary(task.project?.owner);
    const actorId = taskActorId(task) || 'unknown';
    const actor = task.owner || task.user;
    const actorLabel = actor?.name || actor?.username || '未知成员';

    totalPoints += task.actual_cost ?? 0;
    totalDurationSeconds += durationSeconds;
    frozenPoints += task.frozen_cost ?? 0;
    refundPoints += task.refund_amount ?? 0;
    succeededTasks += task.local_status === 'succeeded' ? 1 : 0;
    failedTasks += task.local_status === 'failed' ? 1 : 0;
    runningTasks += task.local_status === 'running' ? 1 : 0;
    pendingTasks += ['draft', 'submitted'].includes(task.local_status) ? 1 : 0;
    pendingOfficialCount += pendingOfficialCost(task) ? 1 : 0;
    if (officialAmount !== null) {
      officialTaskCount += 1;
      addCurrency(officialTotal, task.provider_cost_currency, officialAmount);
      addCurrencySeconds(officialCostDurationTotal, task.provider_cost_currency, durationSeconds);
    }

    addTaskToAccumulator(resolutionMap.get(resolution)!, task);

    if (!projectMap.has(projectKey)) {
      projectMap.set(projectKey, createAccumulator(
        projectKey,
        projectLabel,
        outputParams(range, { project_id: projectKey }),
        projectOwner,
      ));
    }
    addTaskToAccumulator(projectMap.get(projectKey)!, task);

    if (!memberMap.has(actorId)) {
      memberMap.set(actorId, createAccumulator(
        actorId,
        actorLabel,
        outputParams(range, { owner_user_id: actorId === 'unknown' ? null : actorId }),
        actor ? {
          id: actor.id,
          name: actor.name,
          username: actor.username,
          email: actor.email,
          avatar_url: actor.avatar_url,
          account_type: actor.account_type,
        } : null,
      ));
    }
    addTaskToAccumulator(memberMap.get(actorId)!, task);
  });

  const warnings = buildWarnings(tasks, range, auditSummary, providerFailureCount, stalePendingCount);

  return {
    range,
    filters: {
      project_id: query.projectId || null,
      owner_user_id: query.ownerUserId || null,
      resolution: requestedResolution,
    },
    kpis: {
      total_tasks: tasks.length,
      succeeded_tasks: succeededTasks,
      failed_tasks: failedTasks,
      running_tasks: runningTasks,
      pending_tasks: pendingTasks,
      total_duration_seconds: totalDurationSeconds,
      total_points: totalPoints,
      frozen_points: frozenPoints,
      refund_points: refundPoints,
      official_costs: currencyTotals(officialTotal),
      average_official_costs: currencyTotals(officialTotal, Math.max(officialTaskCount, 1)),
      official_cost_per_second: currencyPerSecondTotals(officialTotal, officialCostDurationTotal),
      official_cost_task_count: officialTaskCount,
      official_cost_duration_seconds: sumMapValues(officialCostDurationTotal),
      pending_official_count: pendingOfficialCount,
      warning_count: warnings.reduce((sum, warning) => sum + warning.count, 0),
    },
    resolution_breakdown: Array.from(resolutionMap.values()).map(finalizeAccumulator),
    project_breakdown: Array.from(projectMap.values())
      .map(finalizeAccumulator)
      .sort((a, b) => b.count - a.count || b.points - a.points)
      .slice(0, 8),
    member_ranking: Array.from(memberMap.values())
      .map(finalizeAccumulator)
      .sort((a, b) => b.count - a.count || b.points - a.points)
      .slice(0, 8),
    trends: {
      day: buildOutputTrendBuckets(trendTasks, range, 'day'),
      week: buildOutputTrendBuckets(trendTasks, range, 'week'),
      month: buildOutputTrendBuckets(trendTasks, range, 'month'),
    },
    warnings,
    recent_tasks: tasks.slice(0, 10).map((task) => ({
      id: task.id,
      prompt: task.prompt,
      local_status: task.local_status,
      provider: task.provider,
      generation_mode: task.generation_mode,
      provider_cost_status: task.provider_cost_status,
      model: task.model,
      resolution: normalizeDashboardResolution(task.resolution),
      raw_resolution: task.resolution,
      duration: task.duration,
      ratio: task.ratio,
      actual_cost: task.actual_cost,
      estimated_cost: task.estimated_cost,
      frozen_cost: task.frozen_cost,
      refund_amount: task.refund_amount,
      result_video_url: task.result_video_url,
      result_last_frame_url: task.result_last_frame_url,
      local_video_path: task.local_video_path,
      official_amount_micros: task.provider_official_amount_micros,
      official_amount_minor: task.provider_official_amount_minor,
      official_currency: task.provider_cost_currency,
      created_at: task.created_at.toISOString(),
      completed_at: task.completed_at?.toISOString() || null,
      owner: ownerSummary(task),
      project: task.project,
      href: `/tasks/${task.id}?return_to=${encodeURIComponent('/admin')}`,
    })),
    data_notes: [
      '顶部 KPI、拆分榜和最近任务按 VideoTask.created_at 计算。',
      '趋势图按成功任务的 VideoTask.completed_at 计算实际产出；失败、排队、未完成和跨月未完成任务不计入对应月份的视频条数。',
      '趋势图里的超分视频条数按 generation_mode=enhance_video 或 provider=volcengine_mediakit 的成功产出单独拆分。',
      '官方成本优先读取 provider_official_amount_micros，回退 provider_official_amount_minor；没有官方金额时显示“待官方确认”。',
      '每秒均价按“同币种官方成本 / 同币种且有视频时长的秒数”计算；未确认官方金额或没有时长的任务不进入秒价分母。',
      'actual_cost 是平台点数扣除，不是美元；estimated_cost 是预估点数，不能代表真实扣费。',
      '清晰度只归一为 480p / 720p / 1080p / 未记录，模型只作为明细字段。',
      '无 project_id 的任务归入“未归属项目”，并计入异常预警。',
    ],
  };
}
