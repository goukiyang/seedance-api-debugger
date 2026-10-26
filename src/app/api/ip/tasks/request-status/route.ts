import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { VOLCENGINE_IP_VIDEO_PROVIDER } from '@/lib/provider/volcengine-ip';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const user = await getSession();
  if (!user || user.status !== 'active') return NextResponse.json({ error: '请先登录' }, { status: 401 });
  const key = request.nextUrl.searchParams.get('idempotency_key')?.trim();
  if (!key || key.length > 200) return NextResponse.json({ error: '请求号无效' }, { status: 400 });
  const task = await prisma.videoTask.findFirst({
    where: { user_id: user.id, idempotency_key: key, provider: VOLCENGINE_IP_VIDEO_PROVIDER },
    select: {
      id: true, model: true, provider: true, local_status: true, error_code: true, error_message: true,
      estimated_cost: true, frozen_cost: true, created_at: true, project_id: true, video_card_id: true,
    },
  });
  return NextResponse.json({ task: task ? {
    ...task, status: task.local_status,
    message: task.error_code === 'IP_SUBMISSION_UNCONFIRMED'
      ? '上游是否受理尚未确认，请勿重复提交，点数保留冻结，联系管理员核对。' : undefined,
  } : null }, { headers: { 'Cache-Control': 'no-store' } });
}
