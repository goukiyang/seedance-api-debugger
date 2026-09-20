import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { deleteStudioResult, listStudioTasks, StudioError, submitStudioBatch } from '@/lib/image-studio/tasks';

export const dynamic = 'force-dynamic';
export async function DELETE(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  try { await deleteStudioResult(user.id, (await request.json()).id); return NextResponse.json({ deleted: true }); }
  catch (error) {
    if (error instanceof StudioError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: '删除未确认，请重试；不会重复删除其他图片' }, { status: 503 });
  }
}
export async function GET(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  try { return NextResponse.json(await listStudioTasks(user.id, request.nextUrl.searchParams.get('cursor') || undefined, request.nextUrl.searchParams.get('moduleId') || undefined), { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return NextResponse.json({ error: '生成记录读取失败，请重试' }, { status: 503 }); }
}
export async function POST(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  try {
    const batchId = await submitStudioBatch(user.id, await request.json());
    return NextResponse.json({ batchId }, { status: 202 });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: '提交内容无效' }, { status: 400 });
    if (error instanceof StudioError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof Error && error.message.startsWith('点数不足')) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ error: '提交未确认，请点击重试提交，不要重复新建任务' }, { status: 503 });
  }
}
