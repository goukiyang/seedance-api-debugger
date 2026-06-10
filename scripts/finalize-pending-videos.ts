import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());

type PendingTask = {
  id: string;
  local_status: string;
  local_video_path: string | null;
  result_video_url: string | null;
  created_at: Date;
};

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
    console.log(`[finalize-pending-videos] ${message}`, details);
    return;
  }
  console.log(`[finalize-pending-videos] ${message}`);
}

function taskReason(task: PendingTask) {
  if (task.local_status === 'succeeded' && !task.local_video_path) {
    return 'succeeded_missing_local_video';
  }
  return 'needs_provider_status_refresh';
}

async function main() {
  const limit = numberArg('--limit', 20);
  const maxSeconds = numberArg('--max-seconds', 90);
  const dryRun = hasArg('--dry-run');
  const startedAt = Date.now();
  const { prisma } = await import('../src/lib/prisma');
  const { finalizeVideoTaskStatus } = await import('../src/lib/video/task-finalizer');

  const tasks = await prisma.videoTask.findMany({
    where: {
      provider_task_id: { not: null },
      OR: [
        { local_status: { in: ['submitted', 'running'] } },
        {
          local_status: 'succeeded',
          local_video_path: null,
          result_video_url: { not: null },
        },
      ],
    },
    orderBy: { created_at: 'asc' },
    take: limit,
    select: {
      id: true,
      local_status: true,
      local_video_path: true,
      result_video_url: true,
      created_at: true,
    },
  });

  if (tasks.length === 0) {
    log('No pending video tasks found.');
    await prisma.$disconnect();
    return;
  }

  log(`Found ${tasks.length} candidate task(s).`, { dryRun, limit, maxSeconds });

  let processed = 0;
  let terminal = 0;
  let cached = 0;
  let thumbnail = 0;
  let failed = 0;

  for (const task of tasks) {
    if ((Date.now() - startedAt) / 1000 > maxSeconds) {
      log('Max runtime reached; stop this batch.', { processed, maxSeconds });
      break;
    }

    const reason = taskReason(task);
    if (dryRun) {
      log('Would finalize task.', {
        taskId: task.id,
        status: task.local_status,
        reason,
        createdAt: task.created_at.toISOString(),
      });
      continue;
    }

    try {
      const result = await finalizeVideoTaskStatus(task.id, {
        forceProviderRefresh: task.local_status !== 'succeeded',
        cacheOnSuccess: true,
        generateThumbnail: true,
      });
      processed += 1;
      if (result.terminal) terminal += 1;
      if (result.cacheResult?.success) cached += 1;
      if (result.thumbnailResult?.success) thumbnail += 1;

      log('Finalized task.', {
        taskId: task.id,
        previousStatus: task.local_status,
        currentStatus: result.task?.local_status || null,
        localVideoPath: result.task?.local_video_path || null,
        terminal: result.terminal,
        cacheSuccess: result.cacheResult?.success ?? null,
        thumbnailSuccess: result.thumbnailResult?.success ?? null,
        providerError: result.providerError ? 'yes' : 'no',
      });
    } catch (error) {
      failed += 1;
      log('Task finalize failed.', {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log('Batch complete.', {
    processed,
    terminal,
    cached,
    thumbnail,
    failed,
  });

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('[finalize-pending-videos] Fatal error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
