import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { createToolFlowQuoteProof, getToolFlowQuote, toolFlowQuoteCookieName } from '@/lib/tools/toolflow-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertInternalOnly(user, '外部账号无权读取工具流报价。');
    const quote = await getToolFlowQuote(user, params.id);
    const response = NextResponse.json(quote, {
      headers: { 'Cache-Control': 'no-store' },
    });
    response.cookies.set(toolFlowQuoteCookieName(params.id, quote.expiresAt), createToolFlowQuoteProof(user.id, quote), {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60,
      path: `/api/tools/ultimate-canvas/flows/${encodeURIComponent(params.id)}`,
    });
    return response;
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[ToolFlow] Quote failed:', error);
    return NextResponse.json({ error: '工具流报价读取失败' }, { status: 500 });
  }
}
