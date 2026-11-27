import type { ApiRequest } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { CustomerApiError, recheckApiContext, type ApiContext, type ApiTx } from './auth';
import { apiOutputFile } from './output';

export async function ownApiTask(context: ApiContext, id: string) {
  const receipt = await prisma.apiRequest.findFirst({ where: { id, customer_id: context.customer.id } });
  if (!receipt) throw new CustomerApiError('TASK_NOT_FOUND', '任务不存在。', 404);
  return receipt;
}

export async function projectApiTask(context: ApiContext, receipt: ApiRequest) {
  if (receipt.customer_id !== context.customer.id) throw new CustomerApiError('TASK_NOT_FOUND', '任务不存在。', 404);
  const task = await prisma.videoTask.findUnique({ where: { id: receipt.task_id } });
  if (!task || task.user_id !== context.user.id || task.source_type !== 'customer_api') throw new CustomerApiError('TASK_NOT_FOUND', '任务不存在。', 404);
  const settlement = await prisma.creditLedger.findFirst({ where: { related_task_id: task.id, user_id: context.user.id,
    type: { in: ['task_success_deduct', 'task_failed_refund'] } }, select: { type: true, amount: true } });
  const ready = task.local_status === 'succeeded' ? await apiOutputFile(task.id).catch(() => null) : null;
  const status = ['succeeded', 'failed', 'cancelled', 'canceled'].includes(task.local_status)
    ? task.local_status === 'canceled' ? 'cancelled' : task.local_status
    : !task.provider_task_id ? 'submission_unconfirmed' : task.local_status === 'running' ? 'running' : 'submitted';
  const submissionNeedsReview = status === 'submission_unconfirmed' &&
    (task.error_code === 'IP_SUBMISSION_UNCONFIRMED' || Date.now() - task.created_at.getTime() >= 5 * 60_000);
  const deliveryFailed = status === 'succeeded' && !ready &&
    (task.delivery_status === 'succeeded' || (task.delivery_attempts ?? 0) >= 6 && task.delivery_status !== 'running');
  return { id: receipt.id, request_id: receipt.request_id, agent_id: receipt.agent_id, status,
    delivery_status: ready ? 'ready' : deliveryFailed ? 'failed' : status === 'succeeded' ? 'pending' : 'not_ready',
    delivery_retryable: deliveryFailed && !receipt.delivery_recovery_used && Boolean(task.result_video_url),
    fee_status: settlement ? settlement.type === 'task_success_deduct' ? 'charged' : 'refunded' : 'reserved',
    reserved_points: receipt.reserved_points, charged_points: settlement ? settlement.type === 'task_success_deduct' ? Math.abs(settlement.amount) : 0 : null,
    content_url: ready ? `/api/v1/video/tasks/${receipt.id}/content` : null,
    content_bytes: ready?.bytes ?? null, content_sha256: ready?.sha256 ?? null,
    retry_after_seconds: ready || deliveryFailed || submissionNeedsReview || ['failed', 'cancelled'].includes(status) ? null : 10,
    review_required: submissionNeedsReview || deliveryFailed, resubmit_allowed: false,
    created_at: receipt.created_at.toISOString(), completed_at: task.completed_at?.toISOString() ?? null };
}

export async function recoverApiDelivery(context: ApiContext, receipt: ApiRequest) {
  const task = await projectApiTask(context, receipt);
  if (task.delivery_status === 'ready' || task.delivery_status === 'pending') return task;
  if (!task.delivery_retryable) throw new CustomerApiError('DELIVERY_RECOVERY_UNAVAILABLE', '保存需要管理员核对原任务。', 409);
  await queueApiDeliveryRecovery(receipt, tx => recheckApiContext(tx, context, 'content:read'));
  return projectApiTask(context, { ...receipt, delivery_recovery_used: true });
}

export async function queueApiDeliveryRecovery(receipt: Pick<ApiRequest, 'id' | 'task_id' | 'customer_id'>, authorize: (tx: ApiTx) => Promise<unknown>) {
  return prisma.$transaction(async tx => {
    await authorize(tx);
    const claimed = await tx.apiRequest.updateMany({
      where: { id: receipt.id, customer_id: receipt.customer_id, delivery_recovery_used: false },
      data: { delivery_recovery_used: true },
    });
    if (!claimed.count) return false;
    const queued = await tx.videoTask.updateMany({ where: { id: receipt.task_id, source_type: 'customer_api',
      local_status: 'succeeded', result_video_url: { not: null }, OR: [
        { delivery_status: 'succeeded' }, { delivery_status: 'failed', delivery_attempts: { gte: 6 } },
      ] }, data: { delivery_attempts: 0, delivery_status: 'pending', delivery_started_at: null, delivery_error: null, local_video_path: null } });
    if (!queued.count) throw new CustomerApiError('DELIVERY_CHANGED', '原任务保存状态已变化，请重新查询。', 409);
    return true;
  });
}
