import { NextRequest, NextResponse } from 'next/server';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import {
  getGenerationDashboardData,
  normalizeDashboardResolution,
  type DashboardRangeKey,
  type DashboardCurrencyTotal,
} from '@/lib/admin/generation-dashboard';
import { amountMicrosToCnyEstimate, amountMinorToCnyEstimate } from '@/lib/costs/currency';
import { displayUserName } from '@/lib/users/display';

export const dynamic = 'force-dynamic';

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function rangeKey(value: string | null): DashboardRangeKey | undefined {
  if (value === 'all' || value === '7d' || value === '30d' || value === 'month' || value === 'custom') return value;
  return undefined;
}

function totalsText(totals: DashboardCurrencyTotal[]) {
  return totals.map((item) => `${item.amount_micros} micros ${item.currency}`).join('; ');
}

function totalsCnyText(totals: DashboardCurrencyTotal[]) {
  return totals
    .map((item) => amountMicrosToCnyEstimate(item.amount_micros, item.currency))
    .filter(Boolean)
    .join('; ');
}

function taskOfficialCostText(task: {
  official_amount_micros: number | null;
  official_amount_minor: number | null;
  official_currency: string | null;
}) {
  if (task.official_amount_micros !== null && task.official_amount_micros !== undefined) {
    return `${task.official_amount_micros} micros ${task.official_currency || ''}`.trim();
  }
  if (task.official_amount_minor !== null && task.official_amount_minor !== undefined) {
    return `${task.official_amount_minor} minor ${task.official_currency || ''}`.trim();
  }
  return 'pending_official';
}

function taskOfficialCostCnyText(task: {
  official_amount_micros: number | null;
  official_amount_minor: number | null;
  official_currency: string | null;
}) {
  if (task.official_amount_micros !== null && task.official_amount_micros !== undefined) {
    return amountMicrosToCnyEstimate(task.official_amount_micros, task.official_currency);
  }
  if (task.official_amount_minor !== null && task.official_amount_minor !== undefined) {
    return amountMinorToCnyEstimate(task.official_amount_minor, task.official_currency);
  }
  return '';
}

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);

    const searchParams = request.nextUrl.searchParams;
    const resolution = searchParams.get('resolution');
    const dashboard = await getGenerationDashboardData({
      range: rangeKey(searchParams.get('range')),
      dateFrom: searchParams.get('date_from'),
      dateTo: searchParams.get('date_to'),
      projectId: searchParams.get('project_id'),
      ownerUserId: searchParams.get('owner_user_id'),
      resolution: resolution ? normalizeDashboardResolution(resolution) : null,
    });

    const trendExtra = (item: typeof dashboard.trends.day[number]) => [
      `duration_seconds=${item.duration_seconds}`,
      `regular_task_count=${Math.max(0, item.task_count - (item.enhance_task_count || 0))}`,
      `enhance_task_count=${item.enhance_task_count || 0}`,
      `date_from=${item.date_from}`,
      `date_to=${item.date_to}`,
    ].join(';');
    const rows: unknown[][] = [
      ['section', 'key', 'label', 'count', 'succeeded', 'failed', 'points', 'official_costs', 'official_costs_cny_estimate', 'extra'],
      ['summary', 'range', dashboard.range.label, dashboard.kpis.total_tasks, dashboard.kpis.succeeded_tasks, dashboard.kpis.failed_tasks, dashboard.kpis.total_points, totalsText(dashboard.kpis.official_costs), totalsCnyText(dashboard.kpis.official_costs), `warnings=${dashboard.kpis.warning_count}`],
      ...dashboard.resolution_breakdown.map((item) => ['resolution', item.key, item.label, item.count, item.succeeded, item.failed, item.points, totalsText(item.official_costs), totalsCnyText(item.official_costs), `pending_official=${item.pending_official_count}`]),
      ...dashboard.project_breakdown.map((item) => ['project', item.key, item.label, item.count, item.succeeded, item.failed, item.points, totalsText(item.official_costs), totalsCnyText(item.official_costs), `pending_official=${item.pending_official_count}`]),
      ...dashboard.member_ranking.map((item) => ['member', item.key, item.label, item.count, item.succeeded, item.failed, item.points, totalsText(item.official_costs), totalsCnyText(item.official_costs), `pending_official=${item.pending_official_count}`]),
      ...dashboard.trends.day.map((item) => ['trend_day', item.key, item.label, item.task_count, '', '', item.points, totalsText(item.official_costs), totalsCnyText(item.official_costs), trendExtra(item)]),
      ...dashboard.trends.week.map((item) => ['trend_week', item.key, item.label, item.task_count, '', '', item.points, totalsText(item.official_costs), totalsCnyText(item.official_costs), trendExtra(item)]),
      ...dashboard.trends.month.map((item) => ['trend_month', item.key, item.label, item.task_count, '', '', item.points, totalsText(item.official_costs), totalsCnyText(item.official_costs), trendExtra(item)]),
      ...dashboard.warnings.map((item) => ['warning', item.type, item.title, item.count, '', '', '', '', '', item.detail]),
      ['recent_tasks', 'task_id', 'prompt', 'status', 'resolution', 'duration', 'points', 'official_cost', 'official_cost_cny_estimate', 'project_or_owner'],
      ...dashboard.recent_tasks.map((task) => [
        'recent_tasks',
        task.id,
        task.prompt,
        task.local_status,
        task.resolution,
        task.duration,
        task.actual_cost ?? task.estimated_cost ?? '',
        taskOfficialCostText(task),
        taskOfficialCostCnyText(task),
        `${task.project?.name || '未归属项目'} / ${task.owner ? displayUserName(task.owner) : '未知成员'}`,
      ]),
    ];

    const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n');
    const today = new Date().toISOString().slice(0, 10);

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="generation-dashboard-${today}.csv"`,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[AdminGenerationDashboardExport] Failed:', error);
    return NextResponse.json({ error: '导出驾驶舱失败' }, { status: 500 });
  }
}
