import type { ApiRequest } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { finalizeVideoTaskStatus } from '@/lib/video/task-finalizer';
import { CustomerApiError, type ApiContext } from './auth';
import { apiOutputFile } from './output';

export async function ownApiTask(context: ApiContext, id: string) {
  const receipt = await prisma.apiRequest.findFirst({ where: { id, customer_id: context.customer.id } });
  if (!receipt) throw new CustomerApiError('TASK_NOT_FOUND', '任务不存在。', 404);
  return receipt;
}

export async function projectApiTask(context: ApiContext, receipt: ApiRequest, refresh = true) {
  if (receipt.customer_id !== context.customer.id) throw new CustomerApiError('TASK_NOT_FOUND', '任务不存在。', 404);
  let task = await prisma.videoTask.findUnique({ where: { id: receipt.task_id } });
  if (!task || task.user_id !== context.user.id || task.source_type !== 'customer_api') throw new CustomerApiError('TASK_NOT_FOUND', '任务不存在。', 404);
  let queryUnavailable = false;
  if (refresh && task.provider_task_id) {
    try {
      const result = await finalizeVideoTaskStatus(task.id, { cacheOnSuccess: true, generateThumbnail: false, createdBy: context.user.id });
      queryUnavailable = Boolean(result.providerError);
    } catch { queryUnavailable = true; }
    task = await prisma.videoTask.findUnique({ where: { id: receipt.task_id } }) || task;
  }
  const settlement = await prisma.creditLedger.findFirst({ where: { related_task_id: task.id, user_id: context.user.id,
    type: { in: ['task_success_deduct', 'task_failed_refund'] } }, select: { type: true, amount: true } });
  const ready = task.local_status === 'succeeded' ? await apiOutputFile(task.id) : null;
  const status = ['succeeded', 'failed', 'cancelled', 'canceled'].includes(task.local_status)
    ? task.local_status === 'canceled' ? 'cancelled' : task.local_status
    : !task.provider_task_id ? 'submission_unconfirmed' : task.local_status === 'running' ? 'running' : 'submitted';
  return { id: receipt.id, request_id: receipt.request_id, status,
    delivery_status: ready ? 'ready' : status === 'succeeded' ? 'pending' : 'not_ready',
    fee_status: settlement ? settlement.type === 'task_success_deduct' ? 'charged' : 'refunded' : 'reserved',
    reserved_points: receipt.reserved_points, charged_points: settlement ? settlement.type === 'task_success_deduct' ? Math.abs(settlement.amount) : 0 : null,
    content_url: ready ? `/api/v1/video/tasks/${receipt.id}/content` : null,
    content_bytes: ready?.bytes ?? null, content_sha256: ready?.sha256 ?? null,
    retry_after_seconds: ready || ['failed', 'cancelled'].includes(status) ? null : 10,
    query_unavailable: queryUnavailable, resubmit_allowed: false,
    created_at: receipt.created_at.toISOString(), completed_at: task.completed_at?.toISOString() ?? null };
}
