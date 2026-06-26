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

async function main() {
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

  log('Candidate tasks loaded.', { apply, limit, total, batch: tasks.length });
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
    await prisma.$disconnect();
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

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('[backfill-public-video-delivery] Fatal error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
