import { route as apiRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { getToolFlowRun, updateToolFlowRun, toolFlowQuoteCookieName } from '@/lib/tools/toolflow-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(_request: NextRequest, props: { params: Promise<{ runId: string }> }) {
  const params = await props.params;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertInternalOnly(user, '外部账号无权读取工具流运行。');
    return NextResponse.json({ run: await getToolFlowRun(user, params.runId) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[ToolFlow] Run read failed:', error);
    return NextResponse.json({ error: '工具流运行读取失败' }, { status: 500 });
  }
});

export const PATCH = apiRoute({ access: 'user', rateLimit: false }, async function PATCH(request: NextRequest, props: { params: Promise<{ runId: string }> }) {
  const params = await props.params;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertInternalOnly(user, '外部账号无权更新工具流运行。');
    const body = await request.json() as Record<string, unknown>;
    const quote = body.quote && typeof body.quote === 'object' && !Array.isArray(body.quote)
      ? body.quote as Record<string, unknown> : null;
    const expiresAt = typeof quote?.expiresAt === 'string' ? quote.expiresAt : '';
    const owned = body.action === 'retry' ? await getToolFlowRun(user, params.runId) : null;
    const proof = owned && expiresAt ? request.cookies.get(toolFlowQuoteCookieName(owned.flow_id, expiresAt))?.value : undefined;
    return NextResponse.json({ success: true, run: await updateToolFlowRun(user, params.runId, body, proof) });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[ToolFlow] Run update failed:', error);
    return NextResponse.json({ error: '工具流运行更新失败' }, { status: 500 });
  }
});
