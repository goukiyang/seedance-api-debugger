import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());

function numberArg(name: string, fallback: number) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function hasArg(name: string) {
  return process.argv.includes(name);
}

function log(message: string, details?: Record<string, unknown>) {
  if (details) {
    console.log(`[backfill-public-video-delivery] ${message}`, details);
    return;
  }
  console.log(`[backfill-public-video-delivery] ${message}`);
}

async function runQueueBackfill() {
  const apply = hasArg('--apply');
  const limit = Math.min(numberArg('--limit', 50), 200);
  const days = numberArg('--days', 7);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const { prisma } = await import('../src/lib/prisma');
  const { enqueueVideoDeliveryJob } = await import('../src/lib/video/delivery-queue');
  const { isVideoDeliveryFastPathTask } = await import('../src/lib/video/delivery-policy');

  try {
    const candidates = await prisma.videoTask.findMany({
      where: {
        created_at: { gte: since },
        local_status: 'succeeded',
        public_video_url: null,
        result_video_url: { not: null },
      },
      select: {
        id: true,
        provider: true,
        generation_mode: true,
        created_at: true,
        completed_at: true,
        result_video_url: true,
        public_video_url: true,
        delivery_status: true,
      },
      orderBy: { completed_at: 'desc' },
      take: limit,
    });
    const fastPathCandidates = candidates.filter(isVideoDeliveryFastPathTask);

    if (!apply) {
      console.log(JSON.stringify({
        mode: 'queue-dry-run',
        limit,
        window_days: days,
        candidates: fastPathCandidates.length,
        sample_task_ids: fastPathCandidates.slice(0, 10).map((task) => task.id),
        next_step: '确认数量后执行 npm run video:delivery-backfill -- --queue --apply --days <D> --limit <N>',
      }, null, 2));
      return;
    }

    const results = [];
    for (const task of fastPathCandidates) {
      const result = await enqueueVideoDeliveryJob(task.id, {
        priority: 1,
        payload: { source: 'backfill_public_video_delivery' },
      });
      results.push({ task_id: task.id, queued: result.queued, skipped_reason: result.skippedReason ?? null });
    }

    console.log(JSON.stringify({
      mode: 'queue-apply',
      window_days: days,
      considered: fastPathCandidates.length,
      queued: results.filter((item) => item.queued).length,
      skipped: results.filter((item) => !item.queued).length,
      results,
    }, null, 2));
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

async function runDirectBackfill() {
  const apply = hasArg('--apply');
  const limit = numberArg('--limit', 20);
  const { prisma } = await import('../src/lib/prisma');
  const { ensurePublicVideoDelivery } = await import('../src/lib/video/public-delivery');

  const where = {
    local_status: 'succeeded',
    public_video_url: null,
    retention_status: { in: ['active', 'retained'] },
    OR: [
      { local_video_path: { not: null } },
      { result_video_url: { not: null } },
    ],
  };

  try {
    const [total, tasks] = await Promise.all([
      prisma.videoTask.count({ where }),
      prisma.videoTask.findMany({
        where,
        orderBy: [{ completed_at: 'desc' }, { created_at: 'desc' }],
        take: limit,
        select: {
          id: true,
          provider: true,
          local_status: true,
          provider_task_id: true,
          result_video_url: true,
          result_last_frame_url: true,
          local_video_path: true,
          public_video_url: true,
          public_video_storage_provider: true,
          public_video_storage_key: true,
          public_video_file_size: true,
          public_video_cached_at: true,
          completed_at: true,
          created_at: true,
        },
      }),
    ]);

    log('Candidate tasks loaded.', { mode: 'direct', apply, limit, total, batch: tasks.length });
    if (!apply) {
      tasks.forEach((task) => {
        log('Would backfill task.', {
          taskId: task.id,
          hasLocalVideo: Boolean(task.local_video_path),
          hasProviderUrl: Boolean(task.result_video_url),
          previousAttempt: task.public_video_storage_provider || null,
          completedAt: task.completed_at?.toISOString() || null,
        });
      });
      return;
    }

    let success = 0;
    let fallback = 0;
    let failed = 0;

    for (const task of tasks) {
      try {
        const result = await ensurePublicVideoDelivery(task);
        if (result.success) success += 1;
        else if (result.fallback || result.skipped) fallback += 1;
        else failed += 1;
        log('Backfilled task.', {
          taskId: task.id,
          success: result.success,
          storageProvider: result.storage_provider || null,
          hasPublicUrl: Boolean(result.public_video_url),
          fallback: result.fallback || false,
          skipped: result.skipped || false,
          message: result.message || result.warning || null,
        });
      } catch (error) {
        failed += 1;
        log('Task backfill failed.', {
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    log('Batch complete.', {
      totalCandidates: total,
      processed: tasks.length,
      success,
      fallback,
      failed,
    });
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

async function main() {
  if (hasArg('--queue')) {
    await runQueueBackfill();
    return;
  }
  await runDirectBackfill();
}

main().catch((error) => {
  console.error('[backfill-public-video-delivery] Fatal error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
