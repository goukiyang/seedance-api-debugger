import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { VOLCENGINE_IP_VIDEO_PROVIDER } from '@/lib/provider/volcengine-ip';
import { finalizeVideoTaskStatus, isTerminalLocalStatus } from '@/lib/video/task-finalizer';
import { enqueueVideoDeliveryJob } from '@/lib/video/delivery-queue';
import { isVideoDeliveryFastPathTask } from '@/lib/video/delivery-policy';
import { videoDeliveryStageForTask } from '@/lib/video/delivery-status';
import { shouldExposeTaskThumbnailUrl } from '@/lib/video/thumbnail-availability';

export const dynamic = 'force-dynamic';

function retryAfterMsForStage(stageKey: ReturnType<typeof videoDeliveryStageForTask>['key']) {
  if (stageKey === 'generating') return 5_000;
  if (stageKey === 'preparing') return 3_000;
  if (stageKey === 'unavailable') return 10_000;
  return null;
}

function serializeTaskIdentity<T extends {
  id: string;
  owner?: unknown;
  user?: unknown;
  public_video_url?: string | null;
  local_video_path?: string | null;
  result_video_url?: string | null;
  result_last_frame_url?: string | null;
}>(task: T) {
  const deliveryStage = videoDeliveryStageForTask(task as T & Parameters<typeof videoDeliveryStageForTask>[0]);
  const thumbnailUrl = shouldExposeTaskThumbnailUrl({
    publicVideoUrl: task.public_video_url,
    localVideoPath: task.local_video_path,
    resultVideoUrl: task.result_video_url,
    resultLastFrameUrl: task.result_last_frame_url,
  }) ? `/api/video/thumbnail/${task.id}` : null;
  return {
    ...task,
    owner: task.owner || task.user || null,
    submitted_user: task.user || null,
    delivery_stage: deliveryStage,
    stable_download_ready: deliveryStage.stableDownloadReady,
    preview_available: deliveryStage.previewAvailable,
    play_url: deliveryStage.previewAvailable ? `/api/video/play/${task.id}` : null,
    download_url: deliveryStage.stableDownloadReady ? `/api/video/download/${task.id}` : null,
    thumbnail_url: thumbnailUrl,
    retry_after_ms: retryAfterMsForStage(deliveryStage.key),
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
        error_message: responseTask.error_message || finalizeResult.providerError,
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
