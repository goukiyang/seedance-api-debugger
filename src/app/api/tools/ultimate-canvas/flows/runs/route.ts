import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { listToolFlowRuns } from '@/lib/tools/toolflow-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertInternalOnly(user, '外部账号无权读取工具流运行。');
    const flowId = request.nextUrl.searchParams.get('flow_id')?.trim() || undefined;
    const runs = await listToolFlowRuns(user, flowId);
    return NextResponse.json({ runs }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[ToolFlow] Runs list failed:', error);
    return NextResponse.json({ error: '工具流运行读取失败' }, { status: 500 });
  }
}
