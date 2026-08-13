import { loadEnvConfig } from '@next/env';
import { prisma } from '../src/lib/prisma';
import { isVideoDeliveryFastPathTask } from '../src/lib/video/delivery-policy';

loadEnvConfig(process.cwd());

function numberArg(name: string, fallback: number) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return Math.round(sorted[index]);
}

function average(values: number[]) {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function secondsBetween(start: Date | null | undefined, end: Date | null | undefined) {
  if (!start || !end) return null;
  const seconds = Math.round((end.getTime() - start.getTime()) / 1000);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function summarize(values: Array<number | null>) {
  const clean = values.filter((value): value is number => typeof value === 'number');
  return {
    count: clean.length,
    average_seconds: average(clean),
    p50_seconds: percentile(clean, 0.5),
    p90_seconds: percentile(clean, 0.9),
  };
}

function countBy(values: string[]) {
  return values.reduce<Record<string, number>>((acc, value) => {
    const key = value || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

async function main() {
  const days = numberArg('--days', 7);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const tasks = await prisma.videoTask.findMany({
    where: {
      created_at: { gte: since },
      local_status: 'succeeded',
    },
    select: {
      id: true,
      provider: true,
      generation_mode: true,
      created_at: true,
      completed_at: true,
      public_video_url: true,
      public_video_cached_at: true,
      delivery_status: true,
      delivery_queued_at: true,
      delivery_started_at: true,
      delivery_completed_at: true,
      delivery_error: true,
    },
  });

  const fastPathTasks = tasks.filter(isVideoDeliveryFastPathTask);
  const stableDownloadAt = fastPathTasks.map((task) => task.public_video_cached_at || task.delivery_completed_at || null);

  console.log(JSON.stringify({
    window_days: days,
    generated_at: new Date().toISOString(),
    total_succeeded_tasks: tasks.length,
    fast_path_succeeded_tasks: fastPathTasks.length,
    readiness_counts: {
      stable_download_ready: fastPathTasks.filter((task) => Boolean(task.public_video_url)).length,
      missing_stable_download: fastPathTasks.filter((task) => !task.public_video_url).length,
      delivery_status: countBy(fastPathTasks.map((task) => task.delivery_status || 'unset')),
      delivery_failed: fastPathTasks.filter((task) => task.delivery_status === 'failed' || task.delivery_error).length,
    },
    submit_to_provider: summarize(fastPathTasks.map((task) => secondsBetween(task.created_at, task.completed_at))),
    provider_to_ingest_start: summarize(fastPathTasks.map((task) => secondsBetween(task.completed_at, task.delivery_started_at))),
    ingest_queue_wait: summarize(fastPathTasks.map((task) => secondsBetween(task.delivery_queued_at, task.delivery_started_at))),
    ingest_start_to_public: summarize(fastPathTasks.map((task) => secondsBetween(task.delivery_started_at, task.public_video_cached_at))),
    provider_to_stable_download: summarize(fastPathTasks.map((task, index) => secondsBetween(task.completed_at, stableDownloadAt[index]))),
    submit_to_stable_download: summarize(fastPathTasks.map((task, index) => secondsBetween(task.created_at, stableDownloadAt[index]))),
    queued_to_stable_download: summarize(fastPathTasks.map((task, index) => secondsBetween(task.delivery_queued_at, stableDownloadAt[index]))),
    delivery_start_to_finish: summarize(fastPathTasks.map((task) => secondsBetween(task.delivery_started_at, task.delivery_completed_at))),
    metric_notes: [
      'ingest_start_to_public 目前覆盖本地缓存、对象存储上传和写回 public_video_url 的合计耗时。',
      '本地缓存完成时间、截图完成时间当前没有独立数据库时间戳，因此不输出虚假百分比或虚假分段。',
    ],
  }, null, 2));
}

main()
  .catch((error) => {
    console.error('[video-delivery-metrics] failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
