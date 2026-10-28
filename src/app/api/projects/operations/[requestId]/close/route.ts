import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import { closeProjectCreateOperation, ProjectOperationError } from '@/lib/projects/operations';

export const dynamic = 'force-dynamic';

export async function POST(_request: NextRequest, { params }: { params: { requestId: string } }) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    const expectedActor = _request.headers.get('x-app-session-user');
    if (expectedActor && expectedActor !== user.id) return NextResponse.json({ error: '账号已变化，请回原账号核对原操作', code: 'PROJECT_ACTOR_CHANGED' }, { status: 409, headers: { 'Cache-Control': 'private, no-store' } });
    return NextResponse.json(await closeProjectCreateOperation(user, params.requestId), { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message, ...(error instanceof ProjectOperationError ? { code: error.code } : {}) }, { status: error.status });
    return NextResponse.json({ error: '尚未确认结束，请保留原创建信息并继续核对' }, { status: 500 });
  }
}
