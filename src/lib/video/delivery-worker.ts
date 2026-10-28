import { prisma } from '@/lib/prisma';
import {
  claimNextVideoDeliveryJob,
  completeVideoDeliveryJob,
  failVideoDeliveryJob,
  renewVideoDeliveryJob,
  type VideoDeliveryJobRecord,
} from './delivery-queue';
import { ensurePublicVideoDeliveryFromProvider } from './public-delivery';
import { wakeMultiviewWorkForTask } from './multiview-works';
import { VIDEO_SAVE_TOTAL_TIMEOUT_MS } from './save-lock';

type WorkerOptions = {
  workerId?: string;
  limit?: number;
  lockTimeoutMs?: number;
};

export type VideoDeliveryWorkerResult = {
  processed: number;
  succeeded: number;
  failed: number;
  empty: boolean;
};

function defaultWorkerId() {
  return `video-delivery-${process.pid}-${Date.now()}`;
}

async function loadTaskForDelivery(taskId: string) {
  return prisma.videoTask.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      provider: true,
      generation_mode: true,
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
    },
  });
}

export async function processVideoDeliveryJob(job: VideoDeliveryJobRecord) {
  const task = await loadTaskForDelivery(job.task_id);
  if (!task) {
    throw new Error(`视频交付任务 ${job.id} 对应的 VideoTask 不存在`);
  }
  if (task.local_status !== 'succeeded') {
    throw new Error(`视频任务尚未成功，当前状态：${task.local_status || 'unknown'}`);
  }

  const controller = new AbortController();
  let renewal: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (!renewal) renewal = renewVideoDeliveryJob(job).then(held => { if (!held) controller.abort(); })
      .catch(() => { controller.abort(); }).finally(() => { renewal = null; });
  }, 20_000);
  let result: Awaited<ReturnType<typeof ensurePublicVideoDeliveryFromProvider>>;
  try {
    result = await ensurePublicVideoDeliveryFromProvider(task, { cacheTimeoutMs: VIDEO_SAVE_TOTAL_TIMEOUT_MS,
      saveFence: { jobId: job.id, workerId: job.locked_by!, attempt: job.attempts }, signal: controller.signal });
  } finally { clearInterval(timer); if (renewal) await renewal; }
  if (controller.signal.aborted) throw new Error('VIDEO_SAVE_LEASE_LOST');
  if (!result.success || !result.public_video_url) {
    throw new Error(result.message || result.error || '稳定视频交付未完成');
  }

  const completed = await completeVideoDeliveryJob(job, {
    publicVideoUrl: result.public_video_url,
    storageProvider: result.storage_provider ?? null,
    storageKey: result.storage_key ?? null,
    fileSize: result.file_size ?? null,
    source: { provider_task_id: task.provider_task_id, result_video_url: result.cacheResult?.result_video_url || task.result_video_url },
  });
  // This only wakes an existing intent. A work failure must never reverse successful video delivery.
  try { await wakeMultiviewWorkForTask(task.id); }
  catch { console.warn('[video-delivery-worker] multiview work wake deferred to its persistent consumer'); }
  try { await (await import('./feishu-notification')).wakeVideoFeishuAfterOriginalReady(task.id); }
  catch { console.warn('[video-delivery-worker] notification wake deferred to its existing consumer'); }
  return completed;
}

export async function processVideoDeliveryQueueBatch(options: WorkerOptions = {}): Promise<VideoDeliveryWorkerResult> {
  const workerId = options.workerId || defaultWorkerId();
  const limit = Math.max(1, Math.min(options.limit ?? 5, 50));
  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  for (let index = 0; index < limit; index += 1) {
    const job = await claimNextVideoDeliveryJob({
      workerId,
      lockTimeoutMs: options.lockTimeoutMs,
    });
    if (!job) break;

    processed += 1;
    try {
      await processVideoDeliveryJob(job);
      succeeded += 1;
    } catch (error) {
      failed += 1;
      await failVideoDeliveryJob(job, error);
    }
  }

  return {
    processed,
    succeeded,
    failed,
    empty: processed === 0,
  };
}
