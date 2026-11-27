import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { apiError, apiJson, authenticateCustomerApi, CustomerApiError, readJson, requestId } from '@/lib/customer-api/auth';
import { normalizeVideoInput } from '@/lib/customer-api/contracts';
import { apiRequestFingerprint, availableApiModels, createApiQuote, originalApiRequest, prepareApiAdmission, rememberRejectedApiRequest, submissionRetry } from '@/lib/customer-api/admission';
import { createIpVideo } from '@/lib/video/ip-create';
import { ownApiTask, projectApiTask, recoverApiDelivery } from '@/lib/customer-api/tasks';
import { beginApiUpload, recoverApiUpload, releaseApiUpload, transferApiUpload } from '@/lib/customer-api/uploads';
import { publicUsage } from '@/lib/customer-api/usage';
import { apiOutputFile } from '@/lib/customer-api/output';
import { privateFileResponse } from '@/lib/customer-api/file-response';
import { VerifiedUploadError } from '@/lib/assets/verified-upload';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handle(request: NextRequest, { params }: { params: { path: string[] } }) {
  try {
    const p = params.path, route = p.join('/'), method = request.method;
    if (route === 'models' && method === 'GET') return apiJson({ models: await availableApiModels(await authenticateCustomerApi(request, 'models:read')) });
    if (route === 'usage' && method === 'GET') {
      const context = await authenticateCustomerApi(request, 'usage:read');
      const cursor = request.nextUrl.searchParams.get('cursor') || undefined;
      if (cursor && !/^[a-zA-Z0-9_-]{8,128}$/.test(cursor)) throw new CustomerApiError('INVALID_CURSOR', '分页游标无效。');
      const agentId = request.nextUrl.searchParams.get('agent_id') || undefined;
      if (agentId && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(agentId)) throw new CustomerApiError('INVALID_AGENT_ID', 'Agent 标识无效。');
      return apiJson(await publicUsage(context, cursor, agentId));
    }
    if (route === 'assets/uploads' && method === 'POST') return apiJson(await beginApiUpload(await authenticateCustomerApi(request, 'assets:write'), await readJson(request)), 201);
    if (p[0] === 'assets' && p[1] === 'uploads' && p.length >= 3 && p.length <= 4) {
      const context = await authenticateCustomerApi(request, 'assets:write');
      if (p.length === 3 && method === 'GET') return apiJson(await recoverApiUpload(context, p[2]));
      if (p[3] === 'transfer' && method === 'PUT') return apiJson(await transferApiUpload(context, p[2], request));
      if (p[3] === 'release' && method === 'POST') return apiJson(await releaseApiUpload(context, p[2]));
      if (['complete', 'recover'].includes(p[3]) && method === 'POST') return apiJson(await recoverApiUpload(context, p[2], p[3] === 'recover'));
    }
    if (route === 'video/quotes' && method === 'POST') return await createApiQuote(await authenticateCustomerApi(request, 'video:write'), await readJson(request));
    if (route === 'video/tasks' && method === 'POST') {
      const context = await authenticateCustomerApi(request, 'video:write');
      const id = requestId(request.headers.get('idempotency-key')), body = await readJson(request);
      if (Object.keys(body).some(k => !['quote_id', 'input'].includes(k)) || typeof body.quote_id !== 'string' || body.quote_id.length > 128) throw new CustomerApiError('INVALID_INPUT', '需要 quote_id 与 input，不接受站内归属参数。');
      const input = normalizeVideoInput(body.input);
      const fingerprint = apiRequestFingerprint(input);
      try {
        const prepared = await prepareApiAdmission(context, id, body.quote_id, input, fingerprint);
        if (prepared.original) return apiJson(await projectApiTask(context, prepared.original));
        const response = await createIpVideo(request, context.user, { source_type: 'customer_api', source_label: '客户 API', source_request_id: id,
          source_metadata: { customer_api: true, agent_id: context.key.agent_id, api_key_id: context.key.id } }, prepared.body!, prepared.admission);
        const original = await originalApiRequest(context, id, fingerprint);
        if (original) return apiJson(await projectApiTask(context, original), 202);
        const internal = await response.json().catch(() => ({}));
        if (internal.error === 'PAID_GENERATION_AUTH_REQUIRED') throw new CustomerApiError('PAID_GENERATION_AUTH_REQUIRED', '请按接入协议显式声明本次为已获授权的真实扣费生成。', 403);
        if (internal.code === 'INSUFFICIENT_CREDITS' || internal.error === 'INSUFFICIENT_CREDITS') throw new CustomerApiError('INSUFFICIENT_BALANCE', 'API 可用长期余额不足。', 402);
        throw new CustomerApiError('REQUEST_NOT_ACCEPTED', '本次尚未受理，请核对参数、素材与客户配置。', response.status >= 400 && response.status < 500 ? response.status : 503);
      } catch (error) {
        const original = await originalApiRequest(context, id, fingerprint);
        if (original) return apiJson(await projectApiTask(context, original), 202);
        const retry = submissionRetry(error);
        if (retry && error instanceof CustomerApiError) {
          const accepted = await rememberRejectedApiRequest(context, id, fingerprint, error.code, retry);
          if (accepted) return apiJson(await projectApiTask(context, accepted), 202);
          return apiError(error, retry);
        }
        throw error;
      }
    }
    if (p[0] === 'video' && p[1] === 'requests' && p.length === 3 && method === 'GET') {
      const context = await authenticateCustomerApi(request, 'video:read');
      const id = requestId(p[2]);
      const scope = { customer_id: context.customer.id, request_id: id };
      const [original, rejected] = await prisma.$transaction([
        prisma.apiRequest.findUnique({ where: { customer_id_request_id: scope } }),
        prisma.apiRequestRejection.findUnique({ where: { customer_id_request_id: scope } }),
      ]);
      if (original) return apiJson(await projectApiTask(context, original));
      if (rejected) return apiJson({ request_id: id, status: 'rejected', code: rejected.code, retry: rejected.retry });
      return apiJson({ request_id: id, status: 'not_found', resubmit_allowed: false, message: '尚未找到原请求；不能据此换号重发。' }, 404);
    }
    if (p[0] === 'video' && p[1] === 'tasks' && p.length >= 3 && p.length <= 4) {
      const content = p[3] === 'content', recovery = p[3] === 'recover-delivery';
      const context = await authenticateCustomerApi(request, content || recovery ? 'content:read' : 'video:read');
      const receipt = await ownApiTask(context, p[2]);
      if (p.length === 3 && method === 'GET') return apiJson(await projectApiTask(context, receipt));
      if (recovery && method === 'POST') return apiJson(await recoverApiDelivery(context, receipt), 202);
      if (content && ['GET', 'HEAD'].includes(method)) {
        const task = await prisma.videoTask.findUnique({ where: { id: receipt.task_id }, select: { user_id: true, local_status: true } });
        if (!task || task.user_id !== context.user.id) throw new CustomerApiError('TASK_NOT_FOUND', '任务不存在。', 404);
        const file = task.local_status === 'succeeded' && await apiOutputFile(receipt.task_id);
        if (!file) throw new CustomerApiError('CONTENT_NOT_READY', '视频文件尚未准备好，请继续查询原任务。', 409);
        return privateFileResponse(request, file.file, file.bytes, 'video/mp4', `${receipt.id}.mp4`);
      }
    }
    throw new CustomerApiError('NOT_FOUND', '接口或请求方法不存在。', 404);
  } catch (error) {
    if (error instanceof VerifiedUploadError) return apiError(new CustomerApiError(error.code, '上传未完成，请检查文件并查询原上传票据。', error.status));
    return apiError(error, request.method === 'POST' && params.path.join('/') === 'video/tasks'
      && error instanceof CustomerApiError && error.code === 'RATE_LIMIT' ? 'same_request' : undefined);
  }
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const HEAD = handle;
