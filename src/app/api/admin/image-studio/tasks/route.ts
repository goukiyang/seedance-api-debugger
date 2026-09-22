import { NextRequest, NextResponse } from 'next/server';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { listAdminStudioTasks } from '@/lib/image-studio/tasks';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
    const params = request.nextUrl.searchParams;
    const cursor = params.get('cursor')?.trim() || undefined;
    const moduleId = params.get('moduleId')?.trim() || undefined;
    const ownerId = params.get('ownerId')?.trim() || undefined;
    if (cursor && cursor.length > 120) return NextResponse.json({ error: '分页编号无效' }, { status: 400 });
    if (moduleId && moduleId.length > 120) return NextResponse.json({ error: '模块编号无效' }, { status: 400 });
    if (ownerId && ownerId.length > 120) return NextResponse.json({ error: '用户编号无效' }, { status: 400 });
    return NextResponse.json(await listAdminStudioTasks(cursor, moduleId, ownerId), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[Admin/ImageStudioTasks] List failed:', error);
    return NextResponse.json({ error: '图片任务审计读取失败，请重试' }, { status: 503 });
  }
}
