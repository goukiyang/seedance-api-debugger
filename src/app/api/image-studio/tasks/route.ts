import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { deleteStudioResult, listStudioTasks, cancelQueuedChannelTask, StudioError, submitStudioBatch, studioBusinessErrorStatus } from '@/lib/image-studio/tasks';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { ContextVersionError } from '@/lib/image-studio/context-version';
import { studioTemplateEntrySnapshot } from '@/lib/image-studio/viewer-receipts';
import { QueueCapacityError, QueueMaintenanceError } from '@/lib/image-studio/queue-capacity';
import { ImageGenerationChannelError } from '@/lib/integrations/image-generation';
import { listStudioResultFeed } from '@/lib/image-studio/result-feed';
import { StudioPinError } from '@/lib/image-studio/result-pins';
import { STUDIO_RESULT_FEED } from '@/lib/image-studio/result-pin-types';
import { requestStudioAsyncRecheck, StudioAsyncRecoveryError } from '@/lib/image-studio/async-recovery';
import { VideoFeishuError } from '@/lib/video/feishu-contract';
import { videoFeishuErrorText } from '@/lib/video/feishu-errors';
import { submitStudioWithCurrentPricing, logImagePricingFailure } from '@/lib/image-studio/billing-quote-service';

export const dynamic = 'force-dynamic';
export async function PATCH(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (user.status !== 'active' || !canUseCompanyTemplates(user)) return NextResponse.json({ error: '无权操作图片任务' }, { status: 403 });
  let recheck = false;
  try {
    const body = await request.json();
    if (body.action === 'recheck') {
      recheck = true;
      if (typeof body.id !== 'string' || !/^[a-zA-Z0-9-]{1,120}$/.test(body.id)
        || typeof body.requestId !== 'string' || body.requestId.length > 180) throw new StudioError('原任务核对参数无效', 400);
      const result = await requestStudioAsyncRecheck(user.id, body.id, body.requestId);
      return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
    }
    if (body.action !== 'cancel' || typeof body.id !== 'string' || !/^[a-zA-Z0-9-]{1,120}$/.test(body.id)) throw new StudioError('取消参数无效', 400);
    const cancelled = await cancelQueuedChannelTask(user.id, body.id);
    return NextResponse.json({ cancelled, message: '未受理排队任务已取消，原记录保留；没有取消供应商任务' });
  } catch (error) {
    const expected = error instanceof StudioError || error instanceof StudioAsyncRecoveryError;
    return NextResponse.json({ error: expected ? error.message : recheck
      ? '原任务核对状态暂未确认，请刷新原记录；没有重新生成或改变费用预留'
      : '取消未确认，请重新读取原任务；未承诺释放费用',
    ...(error instanceof StudioAsyncRecoveryError ? { code: error.code } : {}) },
    { status: expected ? error.status : 503, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  }
}
export async function DELETE(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '图片不存在或无权访问' }, { status: 404 });
  try { await deleteStudioResult(user.id, (await request.json()).id); return NextResponse.json({ deleted: true }); }
  catch (error) {
    if (error instanceof StudioError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: '删除未确认，请重试；不会重复删除其他图片' }, { status: 503 });
  }
}
export async function GET(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '仅限公司飞书账号使用图片生成' }, { status: 403 });
  try {
    const params = request.nextUrl.searchParams;
    const moduleId = params.get('moduleId') || undefined;
    const likedOnly = params.get('liked') === '1';
    const entering = !likedOnly && params.get('attention') === 'entry' && moduleId && !params.has('cursor') && !params.has('taskId') && !params.has('requestId');
    const entrySnapshot = entering ? await studioTemplateEntrySnapshot(user.id, moduleId) : undefined;
    const pinnedFeed = params.get('feed') === STUDIO_RESULT_FEED && moduleId && !params.has('taskId') && !params.has('requestId');
    const result = pinnedFeed
      ? await listStudioResultFeed(user, moduleId, params.get('cursor') || undefined, likedOnly)
      : await listStudioTasks(user.id, params.get('cursor') || undefined, moduleId, user.role === 'admin', params.get('taskId') || undefined, params.get('requestId') || undefined, likedOnly);
    return NextResponse.json({ ...result, ...(likedOnly ? { viewerId: user.id } : {}), ...(entrySnapshot ? { entrySnapshot } : {}) }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  }
  catch (error) { return NextResponse.json({ error: error instanceof StudioError || error instanceof StudioPinError ? error.message : '生成记录读取失败，请重试' }, { status: error instanceof StudioError || error instanceof StudioPinError ? error.status : 503 }); }
}
export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '仅限公司飞书账号使用图片生成' }, { status: 403 });
  try {
    const body = await request.json();
    if (body.currentFixedPricing !== undefined) {
      const result = await submitStudioWithCurrentPricing(user.id, body);
      return NextResponse.json(result, { status: 'batchId' in result ? 202 : 200,
        headers: { 'Cache-Control': 'private, no-store' } });
    }
    const batchId = await submitStudioBatch(user.id, body);
    return NextResponse.json({ batchId }, { status: 202 });
  } catch (error) {
    logImagePricingFailure('acceptance', error, startedAt);
    if (error instanceof VideoFeishuError) return NextResponse.json({ error: videoFeishuErrorText(error.code), code: error.code, submitted: false }, { status: error.status });
    if (error instanceof ImageGenerationChannelError) return NextResponse.json({ error: error.message, code: error.code, submitted: false }, { status: error.status });
    if (error instanceof QueueCapacityError || error instanceof QueueMaintenanceError) return NextResponse.json({ error: error.message, code: error.code, submitted: false }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: '提交内容无效' }, { status: 400 });
    if (error instanceof StudioError || error instanceof ContextVersionError) return NextResponse.json({ error: error.message }, { status: error.status });
    const status = studioBusinessErrorStatus(error);
    if (status && error instanceof Error) return NextResponse.json({ error: error.message, submitted: false }, { status });
    if (error instanceof Error && error.message.startsWith('点数不足')) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ error: '提交结果待确认，请查询这次提交，不要重复新建任务' }, { status: 503 });
  }
}
