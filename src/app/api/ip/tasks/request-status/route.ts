import { projectVideoPromptGroupTask } from '@/lib/video/multiview-task-privacy';
import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import { authenticateCodexVideoApi, hasCodexApiAuthSignal, CodexApiAuthError } from '@/lib/integrations/codex';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { prisma } from '@/lib/prisma';
import { VOLCENGINE_IP_VIDEO_PROVIDER } from '@/lib/provider/volcengine-ip';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' };

export async function GET(request: NextRequest) {
  try {
    const user = hasCodexApiAuthSignal(request) ? (await authenticateCodexVideoApi(request)).user : await getSession();
    if (!user || user.status !== 'active') return NextResponse.json({ error: '请先登录', safeToResubmit: false }, { status: 401, headers });
    const expectedActor = request.headers.get('x-app-session-user');
    if (expectedActor && expectedActor !== user.id) return NextResponse.json({ error: '账号已变化，请切回原账号查询原请求', safeToResubmit: false }, { status: 409, headers });
    const key = request.nextUrl.searchParams.get('idempotency_key')?.trim();
    if (!key || key.length > 200) return NextResponse.json({ error: '请求号无效', safeToResubmit: false }, { status: 400, headers });
    const task = await prisma.videoTask.findFirst({
      where: { user_id: user.id, idempotency_key: key, provider: VOLCENGINE_IP_VIDEO_PROVIDER },
      select: {
        id: true, user_id: true, owner_user_id: true, retention_status: true, source_metadata_json: true,
        model: true, provider: true, local_status: true, error_code: true, error_message: true,
        estimated_cost: true, frozen_cost: true, created_at: true, project_id: true, video_card_id: true,
      },
    });
    if (task) await assertCanViewTask(user, task);
    const projected = task ? projectVideoPromptGroupTask(task) : null;
    const { source_metadata_json: _private, ...safeTask } = projected || {};
    return NextResponse.json({ task: task ? {
      ...safeTask, status: task.local_status,
      ...(task.error_code === 'IP_SUBMISSION_UNCONFIRMED' ? { error_code: task.error_code } : {}),
      message: task.error_code === 'IP_SUBMISSION_UNCONFIRMED'
        ? '上游是否受理尚未确认，请勿重复提交，点数保留冻结，联系管理员核对。' : undefined,
    } : null, lookup: task ? 'found' : 'not_found', safeToResubmit: false }, { headers });
  } catch (error) {
    if (error instanceof CodexApiAuthError || error instanceof AuthError) return NextResponse.json({ error: error.message, safeToResubmit: false }, { status: error.status, headers });
    return NextResponse.json({ error: '原请求暂时无法确认，请稍后查询同一请求号', safeToResubmit: false }, { status: 503, headers });
  }
}
