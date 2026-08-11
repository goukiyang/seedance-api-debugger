import { prisma } from '@/lib/prisma';
import { isVideoDeliveryFastPathTask } from './delivery-policy';

export const VIDEO_DELIVERY_STATUS_PENDING = 'pending';
export const VIDEO_DELIVERY_STATUS_RUNNING = 'running';
export const VIDEO_DELIVERY_STATUS_SUCCEEDED = 'succeeded';
export const VIDEO_DELIVERY_STATUS_FAILED = 'failed';

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

type DeliveryJobClient = {
  findUnique: (args: unknown) => Promise<VideoDeliveryJobRecord | null>;
  findFirst: (args: unknown) => Promise<VideoDeliveryJobRecord | null>;
  create: (args: unknown) => Promise<VideoDeliveryJobRecord>;
  update: (args: unknown) => Promise<VideoDeliveryJobRecord>;
  updateMany: (args: unknown) => Promise<{ count: number }>;
};

export type VideoDeliveryJobRecord = {
  id: string;
  task_id: string;
  status: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  locked_at: Date | null;
  locked_by: string | null;
  last_error: string | null;
  payload_json: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
};

type EnqueueOptions = {
  priority?: number;
  force?: boolean;
  payload?: Record<string, unknown> | null;
  now?: Date;
};

type ClaimOptions = {
  workerId: string;
  now?: Date;
  lockTimeoutMs?: number;
};

function deliveryJobs() {
  return (prisma as unknown as { videoDeliveryJob: DeliveryJobClient }).videoDeliveryJob;
}

export function isVideoDeliveryJobTerminal(status: string | null | undefined) {
  return status === VIDEO_DELIVERY_STATUS_SUCCEEDED || status === VIDEO_DELIVERY_STATUS_FAILED;
}

export function nextVideoDeliveryRunAfter(attempts: number, from = new Date()) {
  if (attempts <= 0) return from;
  const delaySeconds = Math.min(2 ** Math.max(0, attempts - 1) * 60, 15 * 60);
  return new Date(from.getTime() + delaySeconds * 1000);
}

function stringifyPayload(payload: Record<string, unknown> | null | undefined) {
  if (!payload) return null;
  try {
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

export async function enqueueVideoDeliveryJob(taskId: string, options: EnqueueOptions = {}) {
  const now = options.now || new Date();
  const task = await prisma.videoTask.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      provider: true,
      generation_mode: true,
      public_video_url: true,
    },
  });
  if (!task) {
    return { queued: false, skippedReason: 'task_not_found' as const };
  }
  if (!isVideoDeliveryFastPathTask(task)) {
    return { queued: false, skippedReason: 'not_fast_path_task' as const };
  }

  if (task.public_video_url) {
    await prisma.videoTask.update({
      where: { id: taskId },
      data: {
        delivery_status: VIDEO_DELIVERY_STATUS_SUCCEEDED,
        delivery_completed_at: now,
        delivery_error: null,
      },
    });
    return { queued: false, skippedReason: 'already_public' as const };
  }

  const priority = options.priority ?? 0;
  const payloadJson = stringifyPayload(options.payload);
  const existing = await deliveryJobs().findUnique({ where: { task_id: taskId } });

  if (existing && existing.status === VIDEO_DELIVERY_STATUS_SUCCEEDED && !options.force) {
    return { queued: false, skippedReason: 'job_already_succeeded' as const, job: existing };
  }
  if (
    existing
    && !options.force
    && (existing.status === VIDEO_DELIVERY_STATUS_PENDING || existing.status === VIDEO_DELIVERY_STATUS_RUNNING)
  ) {
    return { queued: true, job: existing, alreadyExists: true };
  }

  const job = existing
    ? await deliveryJobs().update({
        where: { id: existing.id },
        data: {
          status: VIDEO_DELIVERY_STATUS_PENDING,
          priority: Math.max(existing.priority, priority),
          run_after: now,
          locked_at: null,
          locked_by: null,
          last_error: null,
          payload_json: payloadJson ?? existing.payload_json,
          completed_at: null,
        },
      })
    : await deliveryJobs().create({
        data: {
          task_id: taskId,
          status: VIDEO_DELIVERY_STATUS_PENDING,
          priority,
          max_attempts: DEFAULT_MAX_ATTEMPTS,
          run_after: now,
          payload_json: payloadJson,
        },
      });

  await prisma.videoTask.update({
    where: { id: taskId },
    data: {
      delivery_status: VIDEO_DELIVERY_STATUS_PENDING,
      delivery_queued_at: now,
      delivery_error: null,
    },
  });

  return { queued: true, job };
}

export async function claimNextVideoDeliveryJob(options: ClaimOptions) {
  const now = options.now || new Date();
  const staleBefore = new Date(now.getTime() - (options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS));
  const job = await deliveryJobs().findFirst({
    where: {
      OR: [
        { status: VIDEO_DELIVERY_STATUS_PENDING, run_after: { lte: now } },
        { status: VIDEO_DELIVERY_STATUS_RUNNING, locked_at: { lte: staleBefore } },
      ],
    },
    orderBy: [
      { priority: 'desc' },
      { run_after: 'asc' },
      { created_at: 'asc' },
    ],
  });
  if (!job) return null;

  const claim = await deliveryJobs().updateMany({
    where: {
      id: job.id,
      OR: [
        { status: VIDEO_DELIVERY_STATUS_PENDING, run_after: { lte: now } },
        { status: VIDEO_DELIVERY_STATUS_RUNNING, locked_at: { lte: staleBefore } },
      ],
    },
    data: {
      status: VIDEO_DELIVERY_STATUS_RUNNING,
      attempts: { increment: 1 },
      locked_at: now,
      locked_by: options.workerId,
      last_error: null,
    },
  });
  if (claim.count !== 1) return null;

  const claimed = await deliveryJobs().findUnique({ where: { id: job.id } });
  if (!claimed) return null;

  await prisma.videoTask.update({
    where: { id: claimed.task_id },
    data: {
      delivery_status: VIDEO_DELIVERY_STATUS_RUNNING,
      delivery_started_at: now,
      delivery_attempts: claimed.attempts,
      delivery_error: null,
    },
  });

  return claimed;
}

export async function completeVideoDeliveryJob(job: VideoDeliveryJobRecord, details: {
  now?: Date;
  publicVideoUrl: string;
  storageProvider: string | null;
  storageKey: string | null;
  fileSize: number | null;
}) {
  const now = details.now || new Date();
  const completion = await deliveryJobs().updateMany({
    where: {
      id: job.id,
      status: VIDEO_DELIVERY_STATUS_RUNNING,
      locked_at: job.locked_at,
      locked_by: job.locked_by,
    },
    data: {
      status: VIDEO_DELIVERY_STATUS_SUCCEEDED,
      locked_at: null,
      locked_by: null,
      last_error: null,
      completed_at: now,
    },
  });
  const updated = await deliveryJobs().findUnique({ where: { id: job.id } });
  if (!updated) {
    throw new Error(`视频交付任务 ${job.id} 不存在`);
  }
  if (completion.count !== 1) {
    return updated;
  }

  await prisma.videoTask.update({
    where: { id: job.task_id },
    data: {
      public_video_url: details.publicVideoUrl,
      public_video_storage_provider: details.storageProvider,
      public_video_storage_key: details.storageKey,
      public_video_file_size: details.fileSize,
      public_video_cached_at: now,
      delivery_status: VIDEO_DELIVERY_STATUS_SUCCEEDED,
      delivery_completed_at: now,
      delivery_attempts: updated.attempts,
      delivery_error: null,
    },
  });

  return updated;
}

export async function failVideoDeliveryJob(job: VideoDeliveryJobRecord, error: unknown, options: { now?: Date } = {}) {
  const now = options.now || new Date();
  const message = error instanceof Error ? error.message : String(error);
  const terminal = job.attempts >= job.max_attempts;
  const status = terminal ? VIDEO_DELIVERY_STATUS_FAILED : VIDEO_DELIVERY_STATUS_PENDING;
  const runAfter = terminal ? job.run_after : nextVideoDeliveryRunAfter(job.attempts, now);

  const failure = await deliveryJobs().updateMany({
    where: {
      id: job.id,
      status: VIDEO_DELIVERY_STATUS_RUNNING,
      locked_at: job.locked_at,
      locked_by: job.locked_by,
    },
    data: {
      status,
      run_after: runAfter,
      locked_at: null,
      locked_by: null,
      last_error: message,
      completed_at: terminal ? now : null,
    },
  });
  const updated = await deliveryJobs().findUnique({ where: { id: job.id } });
  if (!updated) {
    throw new Error(`视频交付任务 ${job.id} 不存在`);
  }
  if (failure.count !== 1) {
    return updated;
  }

  await prisma.videoTask.update({
    where: { id: job.task_id },
    data: {
      delivery_status: status,
      delivery_attempts: job.attempts,
      delivery_error: message,
      delivery_completed_at: terminal ? now : null,
    },
  });

  return updated;
}
