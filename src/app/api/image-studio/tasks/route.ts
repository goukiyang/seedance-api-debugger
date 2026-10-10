import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { deleteStudioResult, listStudioTasks, StudioError, submitStudioBatch } from '@/lib/image-studio/tasks';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { ContextVersionError } from '@/lib/image-studio/context-version';
import { studioTemplateEntrySnapshot } from '@/lib/image-studio/viewer-receipts';

export const dynamic = 'force-dynamic';
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
    const result = await listStudioTasks(user.id, params.get('cursor') || undefined, moduleId, user.role === 'admin', params.get('taskId') || undefined, params.get('requestId') || undefined, likedOnly);
    return NextResponse.json({ ...result, ...(likedOnly ? { viewerId: user.id } : {}), ...(entrySnapshot ? { entrySnapshot } : {}) }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  }
  catch (error) { return NextResponse.json({ error: error instanceof StudioError ? error.message : '生成记录读取失败，请重试' }, { status: error instanceof StudioError ? error.status : 503 }); }
}
export async function POST(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '仅限公司飞书账号使用图片生成' }, { status: 403 });
  try {
    const batchId = await submitStudioBatch(user.id, await request.json());
    return NextResponse.json({ batchId }, { status: 202 });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: '提交内容无效' }, { status: 400 });
    if (error instanceof StudioError || error instanceof ContextVersionError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof Error && error.message.startsWith('点数不足')) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ error: '提交结果待确认，请查询这次提交，不要重复新建任务' }, { status: 503 });
  }
}
