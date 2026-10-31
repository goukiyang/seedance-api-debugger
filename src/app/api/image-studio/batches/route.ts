import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { createStudioBatch, getStudioBatchItemInputMain, listStudioBatches, studioBatchView, updateStudioBatch, quoteStudioBatchContinuation } from '@/lib/image-studio/batches';
import { StudioError, studioBusinessErrorStatus } from '@/lib/image-studio/tasks';
import { quoteStudioBatch } from '@/lib/image-studio/batch-billing-quote';
import { logImagePricingFailure } from '@/lib/image-studio/billing-quote-service';
import { QueueCapacityError, QueueMaintenanceError } from '@/lib/image-studio/queue-capacity';
import { ImageGenerationChannelError } from '@/lib/integrations/image-generation';
import { VideoFeishuError } from '@/lib/video/feishu-contract';
import { videoFeishuErrorText } from '@/lib/video/feishu-errors';
import { ContextVersionError } from '@/lib/image-studio/context-version';
import { isPrivatePromptError } from '@/lib/security/private-prompts.server';
import { rejectStudioSubmission, studioSubmitFailureDetail, StudioSubmitReceiptError, validStudioSubmitRequestId } from '@/lib/image-studio/submit-receipts.server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
async function handle(request: NextRequest, write = false) {
  const startedAt = Date.now();
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '仅限公司飞书账号使用' }, { status: 403 });
  let submittedBody: Record<string, unknown> | undefined, creating = false;
  try {
    if (write) {
      if (Number(request.headers.get('content-length') || 0) > 128 * 1024) throw new StudioError('本批提交内容过大');
      const reader = request.body?.getReader();
      if (!reader) throw new StudioError('提交内容无效');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 128 * 1024) { await reader.cancel(); throw new StudioError('本批提交内容过大'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = JSON.parse(raw);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StudioError('提交内容无效');
      submittedBody = body as Record<string, unknown>;
      if (request.method === 'POST' && body.action === 'quote') return NextResponse.json(body.id
        ? await quoteStudioBatchContinuation(user.id, body) : await quoteStudioBatch(user.id, body), { headers: { 'Cache-Control': 'private, no-store' } });
      if (request.method === 'PATCH') { await updateStudioBatch(user.id, body); return NextResponse.json({ batch: await studioBatchView(user.id, body.id) }); }
      creating = true;
      const id = await createStudioBatch(user.id, body);
      return NextResponse.json({ batch: await studioBatchView(user.id, id) }, { status: 202 });
    }
    const id = request.nextUrl.searchParams.get('id');
    const mode = request.nextUrl.searchParams.get('mode');
    if (mode === 'input-main') {
      if (!id) throw new StudioError('批次编号无效');
      const ordinal = Number(request.nextUrl.searchParams.get('ordinal'));
      return NextResponse.json(await getStudioBatchItemInputMain(user, id, ordinal), { headers: privateHeaders });
    }
    if (mode) throw new StudioError('批次读取方式无效');
    const requestId = request.nextUrl.searchParams.get('requestId');
    if (requestId && !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) throw new StudioError('提交编号无效');
    if (id || requestId) {
      const { createHash } = await import('node:crypto');
      return NextResponse.json({ batch: await studioBatchView(user.id, id || createHash('sha256').update(`${user.id}:${requestId}`).digest('hex')) }, { headers: privateHeaders });
    }
    return NextResponse.json(await listStudioBatches(user.id, request.nextUrl.searchParams.get('cursor') || undefined), { headers: privateHeaders });
  } catch (error) {
    const expected = error instanceof VideoFeishuError || error instanceof ImageGenerationChannelError
      || error instanceof QueueCapacityError || error instanceof QueueMaintenanceError || error instanceof StudioError
      || error instanceof ContextVersionError || error instanceof StudioSubmitReceiptError || isPrivatePromptError(error);
    const detail = studioSubmitFailureDetail(error, 'batch-api');
    const requestId = validStudioSubmitRequestId(submittedBody?.requestId) ? submittedBody.requestId : undefined;
    if (creating) logImagePricingFailure('acceptance', error, startedAt, requestId, detail.stage);
    const receipt = creating && requestId && expected
      ? await rejectStudioSubmission(user.id, requestId, detail).catch(() => null) : null;
    const status = expected ? error.status : error instanceof SyntaxError ? 400 : studioBusinessErrorStatus(error) || 503;
    const message = error instanceof VideoFeishuError ? videoFeishuErrorText(error.code)
      : expected ? (error as Error).message : error instanceof SyntaxError ? '提交内容无效'
        : write ? '操作结果待确认，请查询原批次，不要重复新建' : '批次读取失败，请重试';
    return NextResponse.json({ error: message, code: receipt?.code || detail.code,
      ...(creating && requestId ? { requestId } : {}), ...(receipt ? { receipt, submitted: false } : {}) }, { status, headers: privateHeaders });
  }
}
export const GET = (request: NextRequest) => handle(request);
export const POST = (request: NextRequest) => handle(request, true);
export const PATCH = (request: NextRequest) => handle(request, true);
