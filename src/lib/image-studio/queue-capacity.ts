import type { Prisma } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import { countSynchronousImageAdmissions } from './synchronous-admission';

export const ACTIVE_IMAGE_TASK_STATUSES = ['queued', 'running', 'channel_queued', 'channel_running'] as const;

export class QueueCapacityError extends Error {
  readonly code = 'image_queue_capacity';
  readonly status = 429;
  constructor(capacity?: { active: number; requested: number; limit: number }) {
    super(capacity
      ? `当前账号全部图片任务已有 ${capacity.active} 张未结束，本次 ${capacity.requested} 张会超过同时 ${capacity.limit} 张上限，请等待已有任务结束。`
      : '当前账号图片任务已达容量限制，请等待已有任务结束。');
    this.name = 'QueueCapacityError';
  }
}

export class QueueMaintenanceError extends Error {
  readonly code = 'image_queue_maintenance';
  readonly status = 503;
  constructor() {
    super('图片生成正在切换维护，任务已保留待继续');
    this.name = 'QueueMaintenanceError';
  }
}

/** Shared drain marker is visible to the web process and compatible image worker. */
export function assertImageStudioAdmissionOpen() {
  if (fs.existsSync(path.join(process.cwd(), 'storage', 'image-studio-drain'))) throw new QueueMaintenanceError();
}

/** Pure shared capacity rule used by every image-task producer. */
export function imageStudioQueueCapacity(activeCount: number, requestedCount: number, limit = 8) {
  if (![activeCount, requestedCount, limit].every(Number.isSafeInteger) || activeCount < 0 || requestedCount < 0 || limit < 0) {
    throw new TypeError('Image queue capacity inputs must be non-negative safe integers');
  }
  return {
    active: activeCount,
    requested: requestedCount,
    limit,
    remaining: Math.max(0, limit - activeCount),
    allowed: activeCount + requestedCount <= limit,
  } as const;
}

/** Count and capacity check must run in the caller's task-creation transaction. */
export async function reserveImageStudioQueueCapacity(
  tx: Pick<Prisma.TransactionClient, 'imageStudioTask' | 'platformSetting'>,
  ownerId: string,
  requestedCount: number,
) {
  assertImageStudioAdmissionOpen();
  const activeCount = await tx.imageStudioTask.count({
    where: { owner_id: ownerId, status: { in: [...ACTIVE_IMAGE_TASK_STATUSES] } },
  });
  const synchronousCount = await countSynchronousImageAdmissions(tx, ownerId);
  const capacity = imageStudioQueueCapacity(activeCount + synchronousCount, requestedCount);
  if (!capacity.allowed) throw new QueueCapacityError(capacity);
  return capacity;
}
