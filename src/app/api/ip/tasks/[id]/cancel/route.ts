import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
import { transitionVideoTask } from '@/lib/video/task-state';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { toVideoTaskView } from '@/lib/dto/video-task';
import { isExternalUser } from '@/lib/access/external-role';
import { getSession } from '@/lib/auth/session';
import {
  VOLCENGINE_IP_VIDEO_PROVIDER,
  deleteVolcengineIpVideoTask,
  getVolcengineIpTaskStatus,
  safeVolcengineIpUserMessage,
} from '@/lib/provider/volcengine-ip';

export const dynamic = 'force-dynamic';

const CANCELLABLE_LOCAL_STATUSES = new Set(['submitted', 'running']);
const IP_CANCEL_TASK_SELECT = {
  id: true,
  source_metadata_json: true,
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

export const POST = apiRoute({ access: 'user', rateLimit: false }, async function POST(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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
        state_version: true,
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
    const changed = await transitionVideoTask(task.id, task, 'cancelled', {
      provider_status: 'cancelled', raw_status_response: JSON.stringify(providerResult.raw),
      error_code: null, error_message: null,
    });
    if (!changed.changed) return NextResponse.json({ error: '任务状态已变化，请刷新查看实际结果，未重复退款。' }, { status: 409 });

    const responseTask = await prisma.videoTask.findUnique({
      where: { id: task.id },
      select: IP_CANCEL_TASK_SELECT,
    });

    return NextResponse.json({
      ok: true,
      task: responseTask ? toVideoTaskView(responseTask, user) : null,
      ...(!isExternalUser(user) ? { provider_task_id: task.provider_task_id } : {}),
      provider_deleted: providerResult.deleted,
    });
  } catch (error) {

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return NextResponse.json({ error: '任务不存在' }, { status: 404 });
    }
    return apiErrorResponse(error);
  }
});
