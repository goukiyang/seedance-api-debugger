import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { assertToolFlowProjectAccess, validateToolFlowGraph } from '@/lib/tools/toolflow';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function clean(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertInternalOnly(user, '外部账号无权使用工具流。');
    const projectId = clean(request.nextUrl.searchParams.get('project_id')) || null;
    await assertToolFlowProjectAccess(user, projectId);
    const flows = await prisma.toolFlow.findMany({
      where: {
        status: { not: 'deleted' },
        ...(projectId ? { project_id: projectId } : {}),
        owner_id: user.id,
      },
      orderBy: { updated_at: 'desc' },
      take: 100,
      select: { id: true, owner_id: true, project_id: true, name: true, visibility: true, status: true, version: true, graph_json: true, created_at: true, updated_at: true },
    });
    return NextResponse.json({ flows: flows.map(flow => ({ ...flow, visibility: 'private' })) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[ToolFlow] List failed:', error);
    return NextResponse.json({ error: '工具流读取失败' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertInternalOnly(user, '外部账号无权使用工具流。');
    const body = await request.json() as Record<string, unknown>;
    if (JSON.stringify(body.graph || {}).length > 1_900_000) throw new AuthError('工具流内容过大，不能把大图或二进制写入画布 JSON', 413);
    const graph = validateToolFlowGraph(body.graph);
    const projectId = clean(body.project_id || body.projectId) || null;
    await assertToolFlowProjectAccess(user, projectId);
    const name = clean(body.name, '未命名工具流').slice(0, 120);
    const visibility = 'private';
    const flowId = clean(body.id);
    const existing = flowId ? await prisma.toolFlow.findUnique({ where: { id: flowId } }) : null;
    if (existing && existing.owner_id !== user.id) throw new AuthError('无权编辑此工具流', 403);
    const saved = existing
      ? await prisma.toolFlow.update({
          where: { id: existing.id },
          data: { name, project_id: projectId || existing.project_id, visibility, graph_json: JSON.stringify(graph), version: { increment: 1 }, status: 'active' },
        })
      : await prisma.toolFlow.create({
          data: { owner_id: user.id, project_id: projectId, name, visibility, status: 'active', graph_json: JSON.stringify(graph) },
        });
    return NextResponse.json({ success: true, flow: saved });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[ToolFlow] Save failed:', error);
    return NextResponse.json({ error: '工具流保存失败' }, { status: 500 });
  }
}
