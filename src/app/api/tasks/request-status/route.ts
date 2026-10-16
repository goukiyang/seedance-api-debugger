import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertFeatureAllowed } from '@/lib/access/feature-guard';
import { prisma } from '@/lib/prisma';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { VOLCENGINE_IP_VIDEO_PROVIDER } from '@/lib/provider/volcengine-ip';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user || user.status !== 'active') return NextResponse.json({ error: '请先登录', safeToResubmit: false }, { status: 401, headers });
    assertFeatureAllowed(user, 'standard_generate', '外部账号请使用原 IP 任务查询入口');
    const key = request.nextUrl.searchParams.get('idempotency_key')?.trim();
    if (!key || key.length > 200) return NextResponse.json({ error: '请求号无效', safeToResubmit: false }, { status: 400, headers });
    const task = await prisma.videoTask.findUnique({
      where: { user_id_idempotency_key: { user_id: user.id, idempotency_key: key } },
      select: { id: true, user_id: true, owner_user_id: true, local_status: true, project_id: true, video_card_id: true, retention_status: true, provider: true },
    });
    if (task) await assertCanViewTask(user, task);
    if (task?.provider === VOLCENGINE_IP_VIDEO_PROVIDER) return NextResponse.json({ error: '请通过原 IP 任务查询入口确认', safeToResubmit: false }, { status: 400, headers });
    return NextResponse.json({ task: task ? { id: task.id, status: task.local_status, project_id: task.project_id, video_card_id: task.video_card_id } : null,
      lookup: task ? 'found' : 'not_found', safeToResubmit: false }, { headers });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message, safeToResubmit: false }, { status: error.status, headers });
    return NextResponse.json({ error: '原请求暂时无法确认，请稍后查询同一请求号', safeToResubmit: false }, { status: 503, headers });
  }
}
