import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { parseTaskReuseOperationRequest } from '@/lib/navigation/task-reuse-intent';
import { readTaskReuseOperation, legacyTaskReuseCloseCapability, TaskReuseOperationError, taskReusePrivateHeaders } from '@/lib/navigation/task-reuse-operation.server';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401, headers: taskReusePrivateHeaders });
    assertInternalOnly(user, '当前账号无权读取此复用操作');
    const query = request.nextUrl.searchParams;
    const identity = parseTaskReuseOperationRequest({ protocolVersion: 2, requestId: query.get('requestId'), nonce: query.get('nonce'),
      requestHash: query.get('requestHash'), surface: query.get('surface'), tabId: query.get('tabId'), workspaceId: query.get('workspaceId'), expectedWorkspaceAssets: [] });
    if (!identity) {
      const tabId = query.get('tabId') || '', workspaceId = query.get('workspaceId') || '';
      if (!/^[A-Za-z0-9_-]{1,96}$/.test(tabId) || !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) return NextResponse.json({ code: 'REUSE_LEGACY_RESULT_UNKNOWN', error: '旧复用结果无法确认，原现场尚未核对。', canClose: false }, { status: 409, headers: taskReusePrivateHeaders });
      const capability = await legacyTaskReuseCloseCapability(user, tabId, workspaceId);
      return NextResponse.json({ code: 'REUSE_LEGACY_RESULT_UNKNOWN', error: capability.canClose ? '旧复用结果无法补查；现可保留当前输入并结束旧等待。' : '旧复用结果无法确认，旧写入封口证明尚未就绪。', canClose: capability.canClose }, { status: 409, headers: taskReusePrivateHeaders });
    }
    const outcome = await readTaskReuseOperation(user, params.id, identity);
    return NextResponse.json(outcome.body, { status: outcome.status, headers: taskReusePrivateHeaders });
  } catch (error) {
    if (error instanceof TaskReuseOperationError || error instanceof AuthError)
      return NextResponse.json({ error: error.message, code: error instanceof TaskReuseOperationError ? error.code : 'REUSE_PERMISSION_DENIED' }, { status: error.status, headers: taskReusePrivateHeaders });
    console.error('[TaskReuseStatus]', error);
    return NextResponse.json({ code: 'REUSE_RESULT_UNKNOWN', error: '原复用结果暂时无法核对，请保留原操作。' }, { status: 503, headers: taskReusePrivateHeaders });
  }
}
