import type { Prisma } from '@prisma/client';
import { countSynchronousImageAdmissions } from './synchronous-admission';
import { studioTaskStates } from './pricing-state';
import { isStudioReleaseBlocked } from './release-maintenance';
import packageInfo from '../../../package.json';

export const ACTIVE_IMAGE_TASK_STATUSES = studioTaskStates(['queued', 'running', 'channel_queued', 'channel_running']);

export class QueueCapacityError extends Error {
  readonly code = 'image_queue_capacity';
  readonly status = 429;
  constructor(capacity?: { active: number; requested: number; limit: number }) {
    super(capacity
      ? `当前账号已有 ${capacity.active} 张排队或生成，本次 ${capacity.requested} 张会超过同时 ${capacity.limit} 张上限；待核对原请求不占生成名额。`
      : '当前账号图片任务已达容量限制，请等待已有任务结束。');
    this.name = 'QueueCapacityError';
  }
}

export class QueueMaintenanceError extends Error {
  readonly code = 'image_queue_maintenance';
  readonly status = 503;
  constructor() {
    super('图片生成正在维护，尚未新建任务；已有任务和结果保留。');
    this.name = 'QueueMaintenanceError';
  }
}

/** Shared drain marker is visible to the web process and compatible image worker. */
export function assertImageStudioAdmissionOpen() {
  if (imageStudioAcceptedOnlyMode() || isStudioReleaseBlocked()) throw new QueueMaintenanceError();
}

/** Only server process configuration or the actual guard package may select this mode. */
export function imageStudioAcceptedOnlyMode() {
  return process.env.STUDIO_ACCEPTED_ONLY === '1' || /\+trace03-guard\.\d+$/.test(packageInfo.version);
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
