import { getGenerationDashboardData, parseDashboardRange } from '../src/lib/admin/generation-dashboard';

async function main() {
  const allRange = parseDashboardRange(
    { range: 'all' },
    new Date('2026-07-02T12:00:00+08:00'),
    { earliestDate: new Date('2026-05-15T09:30:00+08:00') },
  );
  if (allRange.key !== 'all' || allRange.label !== '全部' || allRange.date_from !== '2026-05-15' || allRange.date_to !== '2026-07-02') {
    throw new Error(`全部范围异常：${JSON.stringify(allRange)}`);
  }

  const allDashboard = await getGenerationDashboardData({ range: 'all' });
  if (allDashboard.range.key !== 'all' || allDashboard.range.label !== '全部') {
    throw new Error(`全部驾驶舱范围异常：${JSON.stringify(allDashboard.range)}`);
  }
  if (!allDashboard.trends.month.length) {
    throw new Error('全部范围缺少按月趋势数据');
  }
  if (allDashboard.range.date_from.slice(0, 7) !== allDashboard.range.date_to.slice(0, 7) && allDashboard.trends.month.length < 2) {
    throw new Error(`全部范围跨月但月趋势不足：${JSON.stringify(allDashboard.range)}`);
  }

  const dashboard = await getGenerationDashboardData({ range: 'month' });
  const resolutionKeys = dashboard.resolution_breakdown.map((item) => item.key).sort();
  const expectedKeys = ['1080p', '480p', '720p', 'unknown'];
  const hasOnlyExpectedResolutionKeys = resolutionKeys.length === expectedKeys.length
    && resolutionKeys.every((key, index) => key === expectedKeys[index]);

  if (!hasOnlyExpectedResolutionKeys) {
    throw new Error(`清晰度聚合键异常：${resolutionKeys.join(', ')}`);
  }

  if (!dashboard.data_notes.some((note) => note.includes('actual_cost 是平台点数'))) {
    throw new Error('缺少点数和美元成本口径说明');
  }

  const dayTrendTaskCount = dashboard.trends.day.reduce((sum, item) => sum + item.task_count, 0);
  if (dayTrendTaskCount !== dashboard.kpis.total_tasks) {
    throw new Error(`按日趋势任务数与 KPI 不一致：trend=${dayTrendTaskCount}, kpi=${dashboard.kpis.total_tasks}`);
  }

  if (!dashboard.trends.week.length || !dashboard.trends.month.length) {
    throw new Error('缺少按周或按月趋势数据');
  }

  if (dashboard.trends.day.some((item) => item.duration_seconds < 0)) {
    throw new Error('趋势生成秒数不能为负数');
  }

  console.log(JSON.stringify({
    ok: true,
    all_range: allDashboard.range,
    all_month_buckets: allDashboard.trends.month.length,
    range: dashboard.range,
    total_tasks: dashboard.kpis.total_tasks,
    resolution_keys: resolutionKeys,
    trend: {
      day_buckets: dashboard.trends.day.length,
      week_buckets: dashboard.trends.week.length,
      month_buckets: dashboard.trends.month.length,
      day_task_count: dayTrendTaskCount,
      day_duration_seconds: dashboard.trends.day.reduce((sum, item) => sum + item.duration_seconds, 0),
    },
    warning_types: dashboard.warnings.map((warning) => warning.type),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
