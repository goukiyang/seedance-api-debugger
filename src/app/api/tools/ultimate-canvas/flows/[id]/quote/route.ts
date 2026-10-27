import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { createToolFlowQuoteProof, getToolFlowQuote, toolFlowQuoteCookieName } from '@/lib/tools/toolflow-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertInternalOnly(user, '外部账号无权读取工具流报价。');
    const runId = request.nextUrl.searchParams.get('retryRunId');
    const nodeId = request.nextUrl.searchParams.get('retryNodeId');
    if (Boolean(runId) !== Boolean(nodeId)) throw new AuthError('重试报价缺少原运行或节点', 400);
    const quote = await getToolFlowQuote(user, params.id, runId && nodeId ? { runId, nodeId } : undefined);
    const response = NextResponse.json(quote, {
      headers: { 'Cache-Control': 'no-store' },
    });
    response.cookies.set(toolFlowQuoteCookieName(params.id, quote.expiresAt), createToolFlowQuoteProof(user.id, quote), {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60,
      path: '/api/tools/ultimate-canvas/flows',
    });
    return response;
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[ToolFlow] Quote failed:', error);
    return NextResponse.json({ error: '工具流报价读取失败' }, { status: 500 });
  }
}
