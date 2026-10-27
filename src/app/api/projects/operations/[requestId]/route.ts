import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import { getProjectCreateOperation, ProjectOperationError } from '@/lib/projects/operations';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, props: { params: Promise<{ requestId: string }> }) {
  const params = await props.params;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    return NextResponse.json(await getProjectCreateOperation(user, params.requestId), { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message, ...(error instanceof ProjectOperationError ? { code: error.code } : {}) }, { status: error.status });
    return NextResponse.json({ error: '暂时无法核对创建结果，请保留原创建信息后重试查询' }, { status: 500 });
  }
}
