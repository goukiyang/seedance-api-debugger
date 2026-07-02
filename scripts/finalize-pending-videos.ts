import { loadEnvConfig } from '@next/env';
import {
  isStaleSubmittedWithoutProvider,
  isFinalizeCandidate,
  selectFinalizeCandidates,
  taskFinalizeReason,
  type PendingFinalizeCandidate,
} from '../src/lib/video/finalize-pending-candidates';

loadEnvConfig(process.cwd());

type AppPrismaClient = (typeof import('../src/lib/prisma'))['prisma'];
type SettleTaskFn = typeof import('../src/lib/video/task-finalizer').settleTask;

type PendingTask = PendingFinalizeCandidate & {
  id: string;
  provider_task_id: string | null;
  local_status: string;
  local_video_path: string | null;
  result_video_url: string | null;
  created_at: Date;
  frozen_cost: number | null;
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

function stringArg(name: string) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function log(message: string, details?: Record<string, unknown>) {
  if (details) {
    console.log(`[finalize-pending-videos] ${message}`, details);
    return;
  }
  console.log(`[finalize-pending-videos] ${message}`);
}

async function failStaleSubmittedWithoutProvider(
  prisma: AppPrismaClient,
  settleTask: SettleTaskFn,
  taskId: string,
  orphanMinAgeMinutes: number,
) {
  const now = new Date();
  const failedTask = await prisma.$transaction(async (tx) => {
    const freshTask = await tx.videoTask.findUnique({ where: { id: taskId } });
    if (!freshTask || !isStaleSubmittedWithoutProvider(freshTask, now, orphanMinAgeMinutes)) {
      return null;
    }

    const consumedApprovals = await tx.approvalUsage.findMany({
      where: { task_id: taskId },
      select: { approval_id: true },
    });
    if (consumedApprovals.length > 0) {
      await tx.approvalUsage.deleteMany({ where: { task_id: taskId } });
      for (const usage of consumedApprovals) {
        await tx.approvalRecord.updateMany({
          where: { id: usage.approval_id, used_count: { gt: 0 } },
          data: { used_count: { decrement: 1 } },
        });
      }
    }

    return tx.videoTask.update({
      where: { id: taskId },
      data: {
        local_status: 'failed',
        provider_status: 'failed',
        error_code: 'MISSING_PROVIDER_TASK_ID',
        error_message: '任务提交后没有拿到外部任务号，已自动失败并返还冻结点数。',
        raw_status_response: JSON.stringify({
          error: 'MISSING_PROVIDER_TASK_ID',
          finalized_by: 'finalize-pending-videos',
        }),
        completed_at: now,
      },
    });
  });

  if (!failedTask) {
    return { task: null, settled: false };
  }

  if (failedTask.user_id && failedTask.frozen_cost && failedTask.frozen_cost > 0) {
    await settleTask(taskId, failedTask.user_id, failedTask.frozen_cost, 'failed');
  }

  const settledTask = await prisma.videoTask.findUnique({ where: { id: taskId } });
  return { task: settledTask || failedTask, settled: Boolean(failedTask.frozen_cost && failedTask.frozen_cost > 0) };
}

async function main() {
  const limit = numberArg('--limit', 20);
  const maxSeconds = numberArg('--max-seconds', 1800);
  const orphanMinAgeMinutes = numberArg('--orphan-min-age-minutes', 30);
  const cacheTimeoutSeconds = numberArg('--cache-timeout-seconds', 900);
  const missingLocalMaxAgeDays = numberArg('--missing-local-max-age-days', 2);
  const taskId = stringArg('--task-id');
  const dryRun = hasArg('--dry-run');
  const startedAt = Date.now();
  const { prisma } = await import('../src/lib/prisma');
  const { finalizeVideoTaskStatus, settleTask } = await import('../src/lib/video/task-finalizer');

  const select = {
    id: true,
    provider_task_id: true,
    local_status: true,
    local_video_path: true,
    result_video_url: true,
    created_at: true,
    updated_at: true,
    completed_at: true,
    frozen_cost: true,
  };

  let tasks: PendingTask[];
  if (taskId) {
    const task = await prisma.videoTask.findFirst({
      where: {
        id: taskId,
      },
      select,
    });
    tasks = task && isFinalizeCandidate(task) ? [task] : [];
  } else {
    const statusRefreshTasks = await prisma.videoTask.findMany({
      where: {
        provider_task_id: { not: null },
        local_status: { in: ['submitted', 'running'] },
      },
      orderBy: [
        { updated_at: 'asc' },
        { created_at: 'asc' },
      ],
      take: limit,
      select,
    });

    const orphanLimit = Math.max(0, limit - statusRefreshTasks.length);
    const staleOrphanTasks = orphanLimit > 0
      ? await prisma.videoTask.findMany({
          where: {
            provider_task_id: null,
            local_status: 'submitted',
            frozen_cost: { gt: 0 },
            created_at: { lte: new Date(Date.now() - orphanMinAgeMinutes * 60 * 1000) },
          },
          orderBy: [
            { created_at: 'asc' },
          ],
          take: orphanLimit,
          select,
        })
      : [];

    const missingLocalLimit = Math.max(0, limit - statusRefreshTasks.length - staleOrphanTasks.length);
    const missingLocalTasks = missingLocalLimit > 0
      ? await prisma.videoTask.findMany({
          where: {
            provider_task_id: { not: null },
            local_status: 'succeeded',
            local_video_path: null,
            result_video_url: { not: null },
            created_at: { gte: new Date(Date.now() - missingLocalMaxAgeDays * 24 * 60 * 60 * 1000) },
          },
          orderBy: [
            { completed_at: 'desc' },
            { created_at: 'desc' },
          ],
          take: missingLocalLimit,
          select,
        })
      : [];

    tasks = selectFinalizeCandidates([...statusRefreshTasks, ...staleOrphanTasks, ...missingLocalTasks], limit);
  }

  if (tasks.length === 0) {
    log(taskId ? 'Target task is not eligible for finalization.' : 'No pending video tasks found.', taskId ? { taskId } : undefined);
    await prisma.$disconnect();
    return;
  }

  log(`Found ${tasks.length} candidate task(s).`, {
    dryRun,
    limit,
    maxSeconds,
    cacheTimeoutSeconds,
    missingLocalMaxAgeDays,
    taskId,
  });

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

    const isStaleOrphan = isStaleSubmittedWithoutProvider(task, new Date(), orphanMinAgeMinutes);
    const reason = isStaleOrphan
      ? 'stale_submitted_missing_provider_task_id'
      : taskFinalizeReason(task);
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
      if (isStaleOrphan) {
        const result = await failStaleSubmittedWithoutProvider(prisma, settleTask, task.id, orphanMinAgeMinutes);
        processed += result.task ? 1 : 0;
        terminal += result.task ? 1 : 0;

        log('Finalized stale submitted task without provider id.', {
          taskId: task.id,
          currentStatus: result.task?.local_status || null,
          frozenCost: result.task?.frozen_cost || null,
          refundAmount: result.task?.refund_amount || null,
          settled: result.settled,
        });
        continue;
      }

      const result = await finalizeVideoTaskStatus(task.id, {
        forceProviderRefresh: task.local_status !== 'succeeded',
        cacheOnSuccess: true,
        generateThumbnail: true,
        cacheTimeoutMs: cacheTimeoutSeconds * 1000,
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
