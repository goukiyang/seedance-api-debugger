import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertCanViewTask } from '@/lib/projects/permissions';
import {
  VOLCENGINE_IP_VIDEO_PROVIDER,
  safeVolcengineIpUserMessage,
} from '@/lib/provider/volcengine-ip';
import { finalizeVideoTaskStatus } from '@/lib/video/task-finalizer';
import { toIpVideoTaskDetail, videoTaskDetailSelect } from '@/lib/dto/video-task-detail';

export const dynamic = 'force-dynamic';

export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const taskId = params.id;
    const forceProviderRefresh = request.nextUrl.searchParams.get('refresh') === 'true'
      || request.nextUrl.searchParams.get('force_refresh') === 'true';
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: '未登录', message: '请先登录' }, { status: 401 });
    }

    const task = await prisma.videoTask.findUnique({
      where: { id: taskId },
      select: videoTaskDetailSelect,
    });

    if (!task) {
      return NextResponse.json(
        { error: 'Task not found', message: `Task ${taskId} not found` },
        { status: 404 },
      );
    }
    if (task.provider !== VOLCENGINE_IP_VIDEO_PROVIDER) {
      return NextResponse.json(
        { error: '任务不是 IP 生成任务', message: '请使用普通任务状态接口查询此任务' },
        { status: 400 },
      );
    }

    try {
      await assertCanViewTask(user, task);
    } catch (error) {
      if (error instanceof AuthError) {
        return NextResponse.json({ error: '权限不足', message: error.message }, { status: error.status });
      }
      throw error;
    }

    if (!task.provider_task_id) {
      return NextResponse.json(toIpVideoTaskDetail(task, user, safeVolcengineIpUserMessage(task.error_message)));
    }

    const finalizeResult = await finalizeVideoTaskStatus(taskId, {
      forceProviderRefresh,
      cacheOnSuccess: true,
      generateThumbnail: true,
      createdBy: user.id,
    });

    const responseTask = await prisma.videoTask.findUnique({
      where: { id: taskId },
      select: videoTaskDetailSelect,
    });

    if (!responseTask || !finalizeResult.task) {
      return NextResponse.json(
        { error: 'Task not found', message: `Task ${taskId} not found` },
        { status: 404 },
      );
    }

    if (finalizeResult.providerError) {
      return NextResponse.json({
        ...toIpVideoTaskDetail(responseTask, user, safeVolcengineIpUserMessage(responseTask.error_message)),
        error_message: safeVolcengineIpUserMessage(responseTask.error_message)
          || '火山任务状态同步失败，请稍后重试。',
      });
    }

    return NextResponse.json(toIpVideoTaskDetail(responseTask, user, safeVolcengineIpUserMessage(responseTask.error_message)));
  } catch (error) {

    return apiErrorResponse(error);
  }
});
