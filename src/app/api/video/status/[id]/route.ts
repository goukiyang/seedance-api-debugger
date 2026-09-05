import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { VOLCENGINE_IP_VIDEO_PROVIDER } from '@/lib/provider/volcengine-ip';
import { finalizeVideoTaskStatus, isTerminalLocalStatus } from '@/lib/video/task-finalizer';
import { enqueueVideoDeliveryJob } from '@/lib/video/delivery-queue';
import { isCodexInternalServiceUser } from '@/lib/integrations/codex';
import { isVideoDeliveryFastPathTask } from '@/lib/video/delivery-policy';
import { visibleProviderErrorMessage } from '@/lib/provider/error-message';
import {
  taskThumbnailProjection,
  type TaskThumbnailProjectionSource,
} from '@/lib/video/task-thumbnail-projection';

export const dynamic = 'force-dynamic';

function serializeTaskIdentity<T extends {
  id: string;
  owner?: unknown;
  user?: unknown;
  public_video_url?: string | null;
  local_video_path?: string | null;
  result_video_url?: string | null;
  result_last_frame_url?: string | null;
  error_message?: string | null;
  local_status?: string | null;
}>(task: T) {
  return {
    ...task,
    owner: task.owner || task.user || null,
    submitted_user: task.user || null,
    error_message: task.local_status === 'failed'
      ? visibleProviderErrorMessage(task.error_message)
      : task.error_message,
    ...taskThumbnailProjection(task as T & TaskThumbnailProjectionSource),
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const taskId = params.id;
    const forceProviderRefresh = request.nextUrl.searchParams.get('refresh') === 'true'
      || request.nextUrl.searchParams.get('force_refresh') === 'true';
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: '未登录', message: '请先登录' }, { status: 401 });
    }
    // Codex API 的后台绑定服务账号没有飞书身份，但它是管理员显式配置的
    // 内部普通账号；允许它查询自己生成任务的标准状态，普通邮箱账号仍走外部拦截。
    const codexInternalServiceUser = await isCodexInternalServiceUser(user);
    if (!codexInternalServiceUser) {
      assertInternalOnly(user, '外部账号请使用 IP 任务状态接口。');
    }

    const task = await prisma.videoTask.findUnique({
      where: { id: taskId },
      include: {
        project: { select: { id: true, name: true, type: true } },
        video_card: { select: { id: true, title: true, objective: true, status: true, project_id: true } },
        generation_template: { select: { id: true, name: true, template_key: true, version: true, status: true } },
        owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
        user: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
      },
    });

    if (!task) {
      return NextResponse.json(
        { error: 'Task not found', message: `Task ${taskId} not found` },
        { status: 404 },
      );
    }
    if (task.provider === VOLCENGINE_IP_VIDEO_PROVIDER) {
      return NextResponse.json(
        { error: '任务是 IP 生成任务', message: '请使用 IP 任务状态接口查询此任务' },
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
      return NextResponse.json(serializeTaskIdentity(task));
    }

    const fastPathDelivery = isVideoDeliveryFastPathTask(task);
    const shouldRefreshProvider = forceProviderRefresh && !isTerminalLocalStatus(task.local_status);
    const shouldFinalizeProviderStatus = !(fastPathDelivery && isTerminalLocalStatus(task.local_status));
    const finalizeResult: Awaited<ReturnType<typeof finalizeVideoTaskStatus>> = shouldFinalizeProviderStatus
      ? await finalizeVideoTaskStatus(taskId, {
          forceProviderRefresh: shouldRefreshProvider,
          cacheOnSuccess: !fastPathDelivery,
          generateThumbnail: !fastPathDelivery,
          createdBy: user.id,
        })
      : {
          task,
          statusRefreshed: false,
          terminal: true,
          skippedReason: 'terminal_fast_path_status_cached',
        };

    if (
      finalizeResult.task
      && finalizeResult.task.local_status === 'succeeded'
      && fastPathDelivery
    ) {
      await enqueueVideoDeliveryJob(taskId, {
        priority: shouldRefreshProvider ? 8 : 3,
        payload: { source: 'status_route' },
      });
    }

    const responseTask = await prisma.videoTask.findUnique({
      where: { id: taskId },
      include: {
        project: { select: { id: true, name: true, type: true } },
        video_card: { select: { id: true, title: true, objective: true, status: true, project_id: true } },
        generation_template: { select: { id: true, name: true, template_key: true, version: true, status: true } },
        owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
        user: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
      },
    });

    if (!responseTask || !finalizeResult.task) {
      return NextResponse.json(
        { error: 'Task not found', message: `Task ${taskId} not found` },
        { status: 404 },
      );
    }

    if (finalizeResult.providerError) {
      return NextResponse.json({
        ...serializeTaskIdentity(responseTask),
        error_message: visibleProviderErrorMessage(responseTask.error_message || finalizeResult.providerError),
      });
    }

    return NextResponse.json(serializeTaskIdentity(responseTask));
  } catch (error) {
    console.error('Get task status error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
