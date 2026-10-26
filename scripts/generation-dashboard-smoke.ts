import { getGenerationDashboardData, parseDashboardRange } from '../src/lib/admin/generation-dashboard';
import { prisma } from '../src/lib/prisma';
import { displayUserName } from '../src/lib/users/display';

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

function localDateFromIso(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function monthKey(date: Date) {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}`;
}

function officialCostMicros(task: {
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

function isEnhanceTask(task: {
  provider: string;
  generation_mode: string;
}) {
  return task.generation_mode === 'enhance_video' || task.provider === 'volcengine_mediakit';
}

async function expectedCompletedMonthlyOutputs(range: { date_from: string; date_to: string }) {
  const tasks = await prisma.videoTask.findMany({
    where: {
      local_status: 'succeeded',
      completed_at: {
        gte: startOfDay(localDateFromIso(range.date_from)),
        lte: endOfDay(localDateFromIso(range.date_to)),
      },
    },
    select: {
      completed_at: true,
      provider: true,
      generation_mode: true,
      duration: true,
      provider_cost_currency: true,
      provider_official_amount_minor: true,
      provider_official_amount_micros: true,
    },
  });
  const expected = new Map<string, { count: number; enhanceCount: number; duration: number; officialMicros: number }>();
  tasks.forEach((task) => {
    if (!task.completed_at) return;
    const key = monthKey(task.completed_at);
    const bucket = expected.get(key) || { count: 0, enhanceCount: 0, duration: 0, officialMicros: 0 };
    bucket.count += 1;
    if (isEnhanceTask(task)) bucket.enhanceCount += 1;
    bucket.duration += Math.max(0, task.duration ?? 0);
    bucket.officialMicros += officialCostMicros(task) ?? 0;
    expected.set(key, bucket);
  });
  return expected;
}

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
  const expectedMonthlyOutputs = await expectedCompletedMonthlyOutputs(allDashboard.range);
  allDashboard.trends.month.forEach((bucket) => {
    const expected = expectedMonthlyOutputs.get(bucket.key) || { count: 0, enhanceCount: 0, duration: 0, officialMicros: 0 };
    const officialMicros = bucket.official_costs.reduce((sum, item) => sum + item.amount_micros, 0);
    if (bucket.task_count !== expected.count) {
      throw new Error(`按月趋势产出数与真实完成产出不一致：${bucket.key} trend=${bucket.task_count}, completed=${expected.count}`);
    }
    if ((bucket.enhance_task_count || 0) !== expected.enhanceCount) {
      throw new Error(`按月趋势超分数与真实完成产出不一致：${bucket.key} trend=${bucket.enhance_task_count || 0}, completed=${expected.enhanceCount}`);
    }
    if (bucket.duration_seconds !== expected.duration) {
      throw new Error(`按月趋势秒数与真实完成产出不一致：${bucket.key} trend=${bucket.duration_seconds}, completed=${expected.duration}`);
    }
    if (officialMicros !== expected.officialMicros) {
      throw new Error(`按月趋势成本与真实完成产出不一致：${bucket.key} trend=${officialMicros}, completed=${expected.officialMicros}`);
    }
  });

  const projectIds = allDashboard.project_breakdown
    .map((item) => item.key)
    .filter((key) => key !== 'unassigned');
  const personalProjects = await prisma.project.findMany({
    where: { id: { in: projectIds }, type: 'personal' },
    select: {
      id: true,
      owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
    },
  });
  personalProjects.forEach((project) => {
    const item = allDashboard.project_breakdown.find((entry) => entry.key === project.id);
    if (!item) throw new Error(`个人默认项目缺少成本占比项：${project.id}`);
    const expectedLabel = `${displayUserName(project.owner)}的默认项目`;
    if (item.label !== expectedLabel) {
      throw new Error(`个人默认项目显示名异常：${project.id} label=${item.label}, expected=${expectedLabel}`);
    }
    if (!item.user || item.user.id !== project.owner.id) {
      throw new Error(`个人默认项目没有绑定负责人头像来源：${project.id}`);
    }
    if (project.owner.avatar_url && item.user.avatar_url !== project.owner.avatar_url) {
      throw new Error(`个人默认项目负责人头像未透传：${project.id}`);
    }
  });

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

  const currentRangeExpectedOutputs = await expectedCompletedMonthlyOutputs(dashboard.range);
  const expectedCurrentOutputCount = Array.from(currentRangeExpectedOutputs.values()).reduce((sum, item) => sum + item.count, 0);
  const dayTrendTaskCount = dashboard.trends.day.reduce((sum, item) => sum + item.task_count, 0);
  if (dayTrendTaskCount !== expectedCurrentOutputCount) {
    throw new Error(`按日趋势产出数与真实完成产出不一致：trend=${dayTrendTaskCount}, completed=${expectedCurrentOutputCount}`);
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
    completed_month_outputs_checked: allDashboard.trends.month.map((item) => ({
      key: item.key,
      task_count: item.task_count,
      regular_task_count: Math.max(0, item.task_count - (item.enhance_task_count || 0)),
      enhance_task_count: item.enhance_task_count || 0,
      duration_seconds: item.duration_seconds,
      official_cost_micros: item.official_costs.reduce((sum, total) => sum + total.amount_micros, 0),
    })),
    personal_project_display_checked: personalProjects.length,
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
