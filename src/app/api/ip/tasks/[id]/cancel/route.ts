import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { VOLCENGINE_IP_VIDEO_PROVIDER, deleteVolcengineIpVideoTask } from '@/lib/provider/volcengine-ip';
import { settleTask } from '@/lib/video/task-finalizer';

export const dynamic = 'force-dynamic';

const CANCELLABLE_LOCAL_STATUSES = new Set(['submitted', 'running']);

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const task = await prisma.videoTask.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        provider: true,
        provider_task_id: true,
        provider_status: true,
        local_status: true,
        user_id: true,
        owner_user_id: true,
        frozen_cost: true,
      },
    });

    if (!task) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
    if (task.provider !== VOLCENGINE_IP_VIDEO_PROVIDER) {
      return NextResponse.json({ error: '任务不是 IP 生成任务' }, { status: 400 });
    }

    const ownerId = task.owner_user_id || task.user_id;
    if (user.role !== 'admin' && ownerId !== user.id) {
      return NextResponse.json({ error: '只能取消自己的 IP 生成任务' }, { status: 403 });
    }
    if (!task.provider_task_id) {
      return NextResponse.json({ error: '任务缺少火山任务 ID，无法取消' }, { status: 400 });
    }
    if (!CANCELLABLE_LOCAL_STATUSES.has(task.local_status)) {
      return NextResponse.json({ error: '当前任务状态不能取消' }, { status: 409 });
    }

    const providerResult = await deleteVolcengineIpVideoTask(task.provider_task_id);
    const updated = await prisma.videoTask.update({
      where: { id: task.id },
      data: {
        local_status: 'cancelled',
        provider_status: 'cancelled',
        raw_status_response: JSON.stringify(providerResult.raw),
        completed_at: new Date(),
      },
    });

    if (ownerId && task.frozen_cost && task.frozen_cost > 0) {
      await settleTask(task.id, ownerId, task.frozen_cost, 'cancelled');
    }

    return NextResponse.json({
      ok: true,
      task: updated,
      provider_task_id: task.provider_task_id,
      provider_deleted: providerResult.deleted,
    });
  } catch (error) {
    console.error('[IpTaskCancel] Cancel failed:', error);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return NextResponse.json({ error: '任务不存在' }, { status: 404 });
    }
    return NextResponse.json(
      { error: '取消火山 IP 生成任务失败', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
