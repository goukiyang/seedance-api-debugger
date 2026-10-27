import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
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
import { toVideoTaskDetail, videoTaskDetailSelect } from '@/lib/dto/video-task-detail';
import { getVideoTaskStatusByClientRequestId } from '@/lib/provider/jimeng';
import { isPrivateMultiviewTask, privateMultiviewFailure } from '@/lib/video/multiview-task-privacy';

export const dynamic = 'force-dynamic';

export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let protectedTask = false;
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
      select: videoTaskDetailSelect,
    });

    if (!task) {
      return NextResponse.json(
        { error: 'Task not found', message: `Task ${taskId} not found` },
        { status: 404 },
      );
    }
    protectedTask = isPrivateMultiviewTask(task);
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
      if (task.draft_upgrade_mode === 'draft_upgrade' && task.provider_client_request_id) {
        try {
          const recovered = await getVideoTaskStatusByClientRequestId(task.provider_client_request_id);
          if (recovered.provider_task_id && recovered.provider_task_id !== task.provider_client_request_id) {
            await prisma.videoTask.update({
              where: { id: task.id },
              data: {
                provider_task_id: recovered.provider_task_id,
                provider_status: recovered.provider_status,
                raw_status_response: JSON.stringify(recovered.raw),
                error_message: null,
              },
            });
            const recoveredTask = await prisma.videoTask.findUnique({
              where: { id: task.id },
              select: videoTaskDetailSelect,
            });
            if (recoveredTask) return NextResponse.json(toVideoTaskDetail(recoveredTask, user), { headers: { 'Cache-Control': 'private, no-store' } });
          }
        } catch {
          // Provider 查询失败时保留 submitted，下一次轮询继续按 clientRequestId 恢复。
        }
      }
      return NextResponse.json(toVideoTaskDetail(task, user), { headers: { 'Cache-Control': 'private, no-store' } });
    }

    const fastPathDelivery = isVideoDeliveryFastPathTask(task);
    const shouldRefreshProvider = forceProviderRefresh && !isTerminalLocalStatus(task.local_status);
    const shouldFinalizeProviderStatus = !(fastPathDelivery && isTerminalLocalStatus(task.local_status));
    const finalizeResult = shouldFinalizeProviderStatus
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
          providerError: undefined,
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
      select: videoTaskDetailSelect,
    });

    if (!responseTask || !finalizeResult.task) {
      return NextResponse.json(
        { error: 'Task not found', message: `Task ${taskId} not found` },
        { status: 404 },
      );
    }

    if (finalizeResult.providerError) {
      return NextResponse.json({ ...toVideoTaskDetail(responseTask, user),
        error_message: protectedTask
          ? privateMultiviewFailure(responseTask.error_message || finalizeResult.providerError, responseTask.local_status)?.message ?? null
          : visibleProviderErrorMessage(responseTask.error_message || finalizeResult.providerError),
      }, { headers: { 'Cache-Control': 'private, no-store' } });
    }

    return NextResponse.json(toVideoTaskDetail(responseTask, user), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (protectedTask) {
      const failure = privateMultiviewFailure(error instanceof Error ? error.message : '', 'unknown');
      console.error('Get protected multiview task status error:', failure?.code);
      return NextResponse.json({ error: failure?.code || 'TASK_STATUS_UNAVAILABLE',
        message: failure?.message || '原任务状态暂时无法确认，请稍后继续核对这个任务。' },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
    }

    return apiErrorResponse(error);
  }
});
