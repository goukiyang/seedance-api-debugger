import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { assertCanUseToolFlow, parseIdList, validateToolFlowGraph } from '@/lib/tools/toolflow';
import { createToolFlowRun, listToolFlowRuns } from '@/lib/tools/toolflow-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertInternalOnly(user, '外部账号无权读取工具流运行。');
    await assertCanUseToolFlow(user, params.id);
    return NextResponse.json({ runs: await listToolFlowRuns(user, params.id) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[ToolFlow] Run list failed:', error);
    return NextResponse.json({ error: '工具流运行读取失败' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertInternalOnly(user, '外部账号无权运行工具流。');
    const flow = await assertCanUseToolFlow(user, params.id);
    validateToolFlowGraph(JSON.parse(flow.graph_json));
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const inputAssetIds = parseIdList(body.input_asset_ids || body.inputAssetIds);
    const run = await createToolFlowRun(user, flow.id, inputAssetIds);
    return NextResponse.json({ success: true, run }, { status: 202 });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[ToolFlow] Run create failed:', error);
    return NextResponse.json({ error: '工具流运行创建失败' }, { status: 500 });
  }
}
