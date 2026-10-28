import { randomUUID } from 'node:crypto';
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
      local_status: true,
      provider_task_id: true,
      result_video_url: true,
    },
  });
  if (!task) {
    return { queued: false, skippedReason: 'task_not_found' as const };
  }
  if (!isVideoDeliveryFastPathTask(task)) {
    return { queued: false, skippedReason: 'not_fast_path_task' as const };
  }
  if (task.local_status !== 'succeeded' || !task.result_video_url && !task.public_video_url) {
    return { queued: false, skippedReason: 'original_not_ready' as const };
  }

  if (task.public_video_url) {
    return { queued: false, skippedReason: 'already_public' as const };
  }

  const priority = options.priority ?? 0;
  const newId = randomUUID();
  // Reads precede the conditional write, avoiding a SQLite deferred-read/write upgrade under concurrent retries.
  const tx = prisma;
  {
    const existing = await tx.videoDeliveryJob.findUnique({ where: { task_id: taskId } });
    const present = existing || await tx.videoDeliveryJob.upsert({ where: { task_id: taskId }, update: {},
      create: { id: newId, task_id: taskId, status: VIDEO_DELIVERY_STATUS_PENDING, priority,
        max_attempts: DEFAULT_MAX_ATTEMPTS, run_after: now, payload_json: stringifyPayload(options.payload) } });
    if (present.id !== newId || existing) {
      if (present.status === VIDEO_DELIVERY_STATUS_PENDING || present.status === VIDEO_DELIVERY_STATUS_RUNNING) {
        return { queued: true, job: present, alreadyExists: true, retryable: false };
      }
      if (present.status !== VIDEO_DELIVERY_STATUS_FAILED || !options.force || present.locked_by || present.locked_at) {
        return { queued: false, skippedReason: present.status === VIDEO_DELIVERY_STATUS_FAILED ? 'job_failed_requires_explicit_retry' as const
          : 'job_already_succeeded' as const, job: present, retryable: present.status === VIDEO_DELIVERY_STATUS_FAILED };
      }
      let prior: Record<string, unknown> = {};
      try { const parsed = JSON.parse(present.payload_json || '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) prior = parsed; } catch { /* Preserve the original raw payload below. */ }
      const history = Array.isArray(prior.recoveries) ? prior.recoveries : [];
      const budget = present.attempts + DEFAULT_MAX_ATTEMPTS;
      if (!Number.isSafeInteger(budget) || budget > 2147483647) throw new Error('Video save retry budget unavailable');
      const payload = JSON.stringify({ ...prior, source: options.payload?.source || prior.source,
        ...(present.payload_json && !Object.keys(prior).length ? { previousPayload: present.payload_json } : {}),
        recoveries: [...history, { requestedAt: now.toISOString(), previousAttempts: present.attempts,
          previousMaxAttempts: present.max_attempts, previousError: present.last_error, previousCompletedAt: present.completed_at }] });
      const changed = await tx.videoDeliveryJob.updateMany({ where: { id: present.id, status: VIDEO_DELIVERY_STATUS_FAILED,
        attempts: present.attempts, max_attempts: present.max_attempts, updated_at: present.updated_at, locked_at: null, locked_by: null },
      data: { status: VIDEO_DELIVERY_STATUS_PENDING, priority: Math.max(present.priority, priority), max_attempts: budget,
        run_after: now, completed_at: null, payload_json: payload } });
      if (changed.count !== 1) {
        const actual = await tx.videoDeliveryJob.findUnique({ where: { id: present.id } });
        return { queued: actual?.status === VIDEO_DELIVERY_STATUS_PENDING || actual?.status === VIDEO_DELIVERY_STATUS_RUNNING,
          job: actual || present, alreadyExists: true, retryable: false };
      }
    }
    await tx.videoTask.updateMany({ where: { id: taskId, local_status: 'succeeded',
      provider_task_id: task.provider_task_id, result_video_url: task.result_video_url,
      OR: [{ delivery_status: null }, { delivery_status: VIDEO_DELIVERY_STATUS_FAILED }] }, data: { delivery_status: VIDEO_DELIVERY_STATUS_PENDING,
      delivery_queued_at: now, delivery_error: null, delivery_completed_at: null } });
    const job = await tx.videoDeliveryJob.findUnique({ where: { id: present.id } });
    return { queued: true, job: job!, alreadyExists: Boolean(existing), retryable: false };
  }
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
  if (job.attempts >= job.max_attempts) {
    const exhausted = await deliveryJobs().updateMany({ where: { id: job.id, status: job.status, attempts: job.attempts,
      locked_at: job.locked_at, locked_by: job.locked_by }, data: { status: VIDEO_DELIVERY_STATUS_FAILED,
      locked_at: null, locked_by: null, completed_at: now, last_error: job.last_error || 'Video save attempts exhausted' } });
    if (exhausted.count === 1) await prisma.videoTask.updateMany({ where: { id: job.task_id, delivery_status: job.status },
      data: { delivery_status: VIDEO_DELIVERY_STATUS_FAILED, delivery_error: job.last_error || 'Video save attempts exhausted' } });
    return null;
  }

  const claim = await deliveryJobs().updateMany({
    where: {
      id: job.id,
      attempts: job.attempts,
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
  if (!claimed || claimed.locked_by !== options.workerId || claimed.attempts !== job.attempts + 1
    || claimed.locked_at?.getTime() !== now.getTime()) return null;

  await prisma.videoTask.updateMany({
    where: { id: claimed.task_id, video_delivery_jobs: { some: { id: claimed.id, status: VIDEO_DELIVERY_STATUS_RUNNING,
      attempts: claimed.attempts, locked_by: claimed.locked_by, locked_at: claimed.locked_at } } },
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
  now?: Date; publicVideoUrl: string; storageProvider: string | null; storageKey: string | null; fileSize: number | null;
  source?: { provider_task_id: string | null; result_video_url: string | null };
}) {
  const now = details.now || new Date();
  return prisma.$transaction(async tx => {
    const changed = await tx.videoDeliveryJob.updateMany({ where: { id: job.id, status: VIDEO_DELIVERY_STATUS_RUNNING,
      locked_at: job.locked_at, locked_by: job.locked_by, attempts: job.attempts },
    data: { status: VIDEO_DELIVERY_STATUS_SUCCEEDED, locked_at: null, locked_by: null, last_error: null, completed_at: now } });
    if (changed.count !== 1) throw new Error('VIDEO_SAVE_LEASE_LOST');
    const saved = await tx.videoTask.updateMany({ where: { id: job.task_id, local_status: 'succeeded', ...details.source },
      data: { public_video_url: details.publicVideoUrl, public_video_storage_provider: details.storageProvider,
        public_video_storage_key: details.storageKey, public_video_file_size: details.fileSize,
        public_video_cached_at: now, delivery_status: VIDEO_DELIVERY_STATUS_SUCCEEDED,
        delivery_completed_at: now, delivery_attempts: job.attempts, delivery_error: null } });
    if (saved.count !== 1) throw new Error('VIDEO_SAVE_SOURCE_CHANGED');
    return (await tx.videoDeliveryJob.findUnique({ where: { id: job.id } }))!;
  });
}

export async function failVideoDeliveryJob(job: VideoDeliveryJobRecord, error: unknown, options: { now?: Date } = {}) {
  const now = options.now || new Date();
  const message = error instanceof Error ? error.message : String(error);
  const terminal = job.attempts >= job.max_attempts;
  const status = terminal ? VIDEO_DELIVERY_STATUS_FAILED : VIDEO_DELIVERY_STATUS_PENDING;
  const runAfter = terminal ? job.run_after : nextVideoDeliveryRunAfter(job.attempts, now);
  return prisma.$transaction(async tx => {
    const changed = await tx.videoDeliveryJob.updateMany({ where: { id: job.id, status: VIDEO_DELIVERY_STATUS_RUNNING,
      locked_at: job.locked_at, locked_by: job.locked_by, attempts: job.attempts }, data: {
      status, run_after: runAfter, locked_at: null, locked_by: null, last_error: message, completed_at: terminal ? now : null } });
    if (changed.count === 1) await tx.videoTask.update({ where: { id: job.task_id }, data: {
      delivery_status: status, delivery_attempts: job.attempts, delivery_error: message, delivery_completed_at: terminal ? now : null } });
    return (await tx.videoDeliveryJob.findUnique({ where: { id: job.id } }))!;
  });
}

/** Renewal changes only the current claim; it never grants a fresh attempt. */
export async function renewVideoDeliveryJob(job: VideoDeliveryJobRecord, now = new Date()) {
  const changed = await deliveryJobs().updateMany({ where: { id: job.id, status: VIDEO_DELIVERY_STATUS_RUNNING,
    locked_at: job.locked_at, locked_by: job.locked_by, attempts: job.attempts }, data: { locked_at: now } });
  if (changed.count !== 1) return false;
  job.locked_at = now;
  return true;
}

export function videoDeliveryProjection(task: { local_status?: string | null; delivery_status?: string | null;
  delivery_attempts?: number | null; delivery_error?: string | null; result_video_url?: string | null;
  public_video_url?: string | null; local_video_path?: string | null }) {
  return { delivery_status: task.delivery_status || null, delivery_attempts: task.delivery_attempts || 0,
    delivery_error: task.delivery_error || null,
    delivery_retryable: task.local_status === 'succeeded' && task.delivery_status === VIDEO_DELIVERY_STATUS_FAILED
      && Boolean(task.result_video_url) && !task.public_video_url };
}
