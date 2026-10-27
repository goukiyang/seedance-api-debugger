import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { finishTaskReuseOperation, closeLegacyTaskReuseScope, taskReuseRequest, TaskReuseOperationError, taskReusePrivateHeaders } from '@/lib/navigation/task-reuse-operation.server';

export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401, headers: taskReusePrivateHeaders });
    assertInternalOnly(user, '当前账号无权结束此复用操作');
    const body = await request.json().catch(() => null);
    if (body?.legacy === true && body.protocolVersion === 1) {
      if (!/^[A-Za-z0-9_-]{1,96}$/.test(body.tabId || '') || !/^[A-Za-z0-9_-]{1,128}$/.test(body.workspaceId || '') || request.headers.get('x-tab-id') !== body.tabId) throw new TaskReuseOperationError('REUSE_LEGACY_SCOPE_INVALID', '旧复用现场无法确认，当前输入保留。', 400);
      return NextResponse.json(await closeLegacyTaskReuseScope(user, params.id, body.tabId, body.workspaceId), { headers: taskReusePrivateHeaders });
    }
    if (!body || body.protocolVersion !== 2) return NextResponse.json({ code: 'REUSE_LEGACY_CLOSE_UNAVAILABLE', error: '请先核对原复用现场。', canClose: false }, { status: 409, headers: taskReusePrivateHeaders });
    const identity = taskReuseRequest(body, user.id, params.id, request.headers.get('x-tab-id'));
    const outcome = await finishTaskReuseOperation(user, params.id, identity, { close: true });
    return NextResponse.json(outcome.body, { status: outcome.status, headers: taskReusePrivateHeaders });
  } catch (error) {
    if (error instanceof TaskReuseOperationError || error instanceof AuthError)
      return NextResponse.json({ error: error.message, code: error instanceof TaskReuseOperationError ? error.code : 'REUSE_PERMISSION_DENIED' }, { status: error.status, headers: taskReusePrivateHeaders });
    console.error('[TaskReuseClose]', error);
    return NextResponse.json({ code: 'REUSE_CLOSE_UNKNOWN', error: '暂未确认结束，原复用记录保留，请继续核对原操作。' }, { status: 503, headers: taskReusePrivateHeaders });
  }
}
