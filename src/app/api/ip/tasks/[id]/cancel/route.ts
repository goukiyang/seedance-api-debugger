import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import {
  VOLCENGINE_IP_VIDEO_PROVIDER,
  deleteVolcengineIpVideoTask,
  getVolcengineIpTaskStatus,
  safeVolcengineIpUserMessage,
} from '@/lib/provider/volcengine-ip';
import { settleTask } from '@/lib/video/task-finalizer';

export const dynamic = 'force-dynamic';

const CANCELLABLE_LOCAL_STATUSES = new Set(['submitted', 'running']);
const IP_CANCEL_TASK_SELECT = {
  id: true,
  provider: true,
  provider_task_id: true,
  provider_status: true,
  local_status: true,
  frozen_cost: true,
  actual_cost: true,
  refund_amount: true,
  completed_at: true,
  updated_at: true,
} as const;

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
        updated_at: true,
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

    const current = await getVolcengineIpTaskStatus(task.provider_task_id);
    if (current.provider_status !== 'queued') {
      return NextResponse.json({ error: '只有仍在排队的任务可以取消，运行中的任务不能取消或退款。' }, { status: 409 });
    }
    const providerResult = await deleteVolcengineIpVideoTask(task.provider_task_id);
    const confirmed = await getVolcengineIpTaskStatus(task.provider_task_id).catch(() => null);
    if (confirmed?.local_status !== 'cancelled') {
      await prisma.videoTask.updateMany({
        where: { id: task.id, local_status: { in: ['submitted', 'running'] } },
        data: { error_code: 'IP_CANCEL_UNCONFIRMED', error_message: '取消请求已发送，但尚未确认取消成功。点数暂不退回，请勿重复生成，等待状态同步或联系管理员核对。' },
      });
      return NextResponse.json({ ok: false, pending: true, message: '取消结果待确认，尚未退款。' }, { status: 202 });
    }
    const changed = await prisma.videoTask.updateMany({
      where: { id: task.id, local_status: { in: ['submitted', 'running'] }, updated_at: task.updated_at },
      data: {
        local_status: 'cancelled',
        provider_status: 'cancelled',
        raw_status_response: JSON.stringify(providerResult.raw),
        completed_at: new Date(),
        error_code: null,
        error_message: null,
      },
    });

    if (!changed.count) {
      return NextResponse.json({ error: '任务状态已变化，请刷新查看实际结果，未重复退款。' }, { status: 409 });
    }

    if (ownerId && task.frozen_cost && task.frozen_cost > 0) {
      await settleTask(task.id, ownerId, task.frozen_cost, 'cancelled');
    }

    const responseTask = await prisma.videoTask.findUnique({
      where: { id: task.id },
      select: IP_CANCEL_TASK_SELECT,
    });

    return NextResponse.json({
      ok: true,
      task: responseTask,
      provider_task_id: task.provider_task_id,
      provider_deleted: providerResult.deleted,
    });
  } catch (error) {
    console.error('[IpTaskCancel] Cancel failed:', error);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return NextResponse.json({ error: '任务不存在' }, { status: 404 });
    }
    return NextResponse.json(
      {
        error: '取消火山 IP 生成任务失败',
        message: safeVolcengineIpUserMessage(
          error instanceof Error ? error.message : null,
          '取消火山 IP 生成任务失败，请稍后重试。',
        ) || '取消火山 IP 生成任务失败，请稍后重试。',
      },
      { status: 500 },
    );
  }
}
