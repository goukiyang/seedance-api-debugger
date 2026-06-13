import { getGenerationDashboardData } from '../src/lib/admin/generation-dashboard';

async function main() {
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
