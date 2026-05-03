import type { Prisma, VideoTask } from '@prisma/client';

export const LONG_FROZEN_HOURS = 2;

export function getLongFrozenCutoff() {
  return new Date(Date.now() - LONG_FROZEN_HOURS * 60 * 60 * 1000);
}

export function buildRefundRelevantWhere(): Prisma.VideoTaskWhereInput {
  return {
    OR: [
      { frozen_cost: { gt: 0 }, local_status: { in: ['failed', 'cancelled'] } },
      { frozen_cost: { gt: 0 }, created_at: { lte: getLongFrozenCutoff() } },
      { actual_cost: { gt: 0 }, refund_amount: null },
    ],
  };
}

export function getTaskAttentionFlags(task: Pick<VideoTask, 'id' | 'local_status' | 'frozen_cost' | 'actual_cost' | 'refund_amount' | 'created_at'>, abnormalTaskIds: Set<string>) {
  const longFrozenCutoff = getLongFrozenCutoff();
  const frozenCost = task.frozen_cost ?? 0;
  const actualCost = task.actual_cost ?? 0;
  const refundAmount = task.refund_amount ?? 0;
  const createdAt = new Date(task.created_at);

  return {
    abnormal: abnormalTaskIds.has(task.id),
    still_frozen: frozenCost > 0,
    long_frozen: frozenCost > 0 && createdAt <= longFrozenCutoff,
    refund_relevant:
      (frozenCost > 0 && ['failed', 'cancelled'].includes(task.local_status)) ||
      (frozenCost > 0 && createdAt <= longFrozenCutoff) ||
      (actualCost > 0 && refundAmount === 0),
  };
}
