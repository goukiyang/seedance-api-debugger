import { createHmac, timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { resolveSitePublicBaseUrl } from '@/lib/assets/site-url';
import { getVolcengineIpTaskStatus } from '@/lib/provider/volcengine-ip';
import { startTaskLocalization } from '@/lib/video/task-localization-runner';
import { apiProviderOptions } from './admission';
import { CustomerApiError } from './auth';

function callbackSignature(taskId: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32 || secret === 'dev-secret-change-in-production') {
    throw new CustomerApiError('CALLBACK_UNAVAILABLE', '任务回执服务尚未配置。', 503);
  }
  return createHmac('sha256', secret).update(`customer-api-provider:v1:${taskId}`).digest('hex');
}

export function apiVideoCallbackUrl(taskId: string) {
  const origin = resolveSitePublicBaseUrl();
  if (!origin?.startsWith('https://')) throw new CustomerApiError('CALLBACK_UNAVAILABLE', '任务回执需要 HTTPS 站点地址。', 503);
  return `${origin}/api/internal/customer-video/${taskId}?signature=${callbackSignature(taskId)}`;
}

export async function recoverApiProviderCallback(taskId: string, signature: string, providerId: unknown) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(taskId) || !/^[a-f0-9]{64}$/.test(signature) ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(callbackSignature(taskId)))) {
    throw new CustomerApiError('NOT_FOUND', '任务不存在。', 404);
  }
  return reconcileProviderId(taskId, providerId);
}

export async function reconcileCustomerApiRequest(actorId: string, apiRequestId: string, providerId: unknown) {
  const receipt = await prisma.apiRequest.findUnique({ where: { id: apiRequestId }, select: { task_id: true } });
  if (!receipt) throw new CustomerApiError('NOT_FOUND', '原请求不存在。', 404);
  await reconcileProviderId(receipt.task_id, providerId, actorId);
  return { saved: true };
}

async function reconcileProviderId(taskId: string, providerId: unknown, actorId?: string) {
  if (typeof providerId !== 'string' || !/^[A-Za-z0-9_-]{8,180}$/.test(providerId)) {
    throw new CustomerApiError('INVALID_CALLBACK', '任务回执号无效。');
  }
  const task = await prisma.videoTask.findUnique({ where: { id: taskId }, select: {
    id: true, source_type: true, provider_task_id: true, provider_client_request_id: true, local_status: true,
  } });
  if (task?.source_type !== 'customer_api' || task.provider_client_request_id !== taskId) {
    throw new CustomerApiError('NOT_FOUND', '任务不存在。', 404);
  }
  if (task.provider_task_id === providerId) return;
  if (task.provider_task_id || task.local_status !== 'submitted') {
    throw new CustomerApiError('CALLBACK_CONFLICT', '原任务已有不同回执或已经结束。', 409);
  }
  const options = await apiProviderOptions(task);
  if (!options) throw new CustomerApiError('CALLBACK_UNAVAILABLE', '原任务供应商线路暂不可查询。', 503);
  const upstream = await getVolcengineIpTaskStatus(providerId, options);
  if ((actorId || upstream.client_request_id) && upstream.client_request_id !== taskId) {
    throw new CustomerApiError('CALLBACK_CONFLICT', '供应商回执与原请求不符。', 409);
  }
  const bound = await prisma.$transaction(async tx => {
    const claimed = await tx.videoTask.updateMany({
      where: { id: taskId, source_type: 'customer_api', provider_task_id: null, local_status: 'submitted', provider_client_request_id: taskId },
      data: { provider_task_id: providerId, error_code: null, error_message: null },
    });
    if (!claimed.count) {
      const current = await tx.videoTask.findUnique({ where: { id: taskId }, select: { provider_task_id: true } });
      if (current?.provider_task_id !== providerId) throw new CustomerApiError('CALLBACK_CONFLICT', '原任务回执已变化。', 409);
      return false;
    }
    if (actorId) {
      const actor = await tx.user.findUnique({ where: { id: actorId } });
      if (!actor || actor.role !== 'admin' || actor.status !== 'active' || actor.account_type !== 'internal'
        || actor.expires_at && actor.expires_at <= new Date()) throw new CustomerApiError('ADMIN_REQUIRED', '管理员身份已失效。', 403);
      await tx.operationLog.create({ data: { operator_id: actorId, action: 'customer_api_reconcile_provider', target_type: 'video_task',
        target_id: taskId, detail: JSON.stringify({ provider_task_id: providerId }) } });
    }
    await tx.providerApiRequest.updateMany({ where: { task_id: taskId, endpoint: 'volcengine_ip.createContentsGenerationsTask' },
      data: { status: 'accepted', provider_task_id: providerId, error_code: null, error_message: null } });
    return true;
  });
  if (bound) startTaskLocalization(taskId, { generateThumbnail: false });
}
