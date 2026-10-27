import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { finalizeVideoTaskStatus } from '@/lib/video/task-finalizer';
import { enqueueVideoDeliveryJob } from '@/lib/video/delivery-queue';
import { getExternalCallbackUrlFromParams } from '@/lib/video/delivery-policy';
import { projectPrivateMultiviewTask } from '@/lib/video/multiview-task-privacy';
import { isPublicHttpUrl } from '@/lib/media/public-url';
import { verifyVideoCallbackToken } from '@/lib/video/callback-auth';
import { requireSecret } from '@/lib/security/secrets';
import { withApiErrors } from '@/lib/http/api-error';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function extractString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extractProviderTaskId(payload: Record<string, unknown>) {
  const data = nestedRecord(payload.data);
  return extractString(payload.provider_task_id)
    || extractString(payload.task_id)
    || extractString(payload.id)
    || extractString(payload.taskId)
    || extractString(data?.provider_task_id)
    || extractString(data?.task_id)
    || extractString(data?.id)
    || extractString(data?.taskId);
}

async function readCallbackPayload(request: NextRequest) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return nestedRecord(parsed) || {};
  } catch {
    return { raw: text.slice(0, 4000) };
  }
}

function mergeForwardStatus(
  paramsJson: string | null,
  status: Record<string, unknown>,
) {
  let params: Record<string, unknown> = {};
  try {
    const parsed = paramsJson ? JSON.parse(paramsJson) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      params = parsed as Record<string, unknown>;
    }
  } catch {
    params = {};
  }
  const current = nestedRecord(params.videoDeliveryCallback) || {};
  return JSON.stringify({
    ...params,
    videoDeliveryCallback: {
      ...current,
      externalForward: status,
    },
  });
}

async function forwardExternalCallback(input: {
  taskId: string;
  paramsJson: string | null;
  payload: Record<string, unknown>;
}) {
  const externalCallbackUrl = getExternalCallbackUrlFromParams(input.paramsJson);
  if (!externalCallbackUrl) return { forwarded: false, reason: 'no_external_callback' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(externalCallbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...input.payload,
        sd2_task_id: input.taskId,
      }),
      signal: controller.signal,
    });
    const status = {
      forwarded: response.ok,
      status: response.status,
      at: new Date().toISOString(),
    };
    await prisma.videoTask.update({
      where: { id: input.taskId },
      data: { params_json: mergeForwardStatus(input.paramsJson, status) },
    });
    return status;
  } catch (error) {
    const status = {
      forwarded: false,
      error: 'external_callback_failed',
      at: new Date().toISOString(),
    };
    await prisma.videoTask.update({
      where: { id: input.taskId },
      data: { params_json: mergeForwardStatus(input.paramsJson, status) },
    });
    return status;
  } finally {
    clearTimeout(timeout);
  }
}

export const POST = withApiErrors(async (request: NextRequest) => {
  try { requireSecret('videoCallback'); } catch {
    return NextResponse.json(
      { error: 'callback_secret_not_configured', message: '视频回调密钥未配置' },
      { status: 503 },
    );
  }
  const token = request.nextUrl.searchParams.get('token') || request.headers.get('x-video-delivery-token');
  const taskIdFromQuery = request.nextUrl.searchParams.get('taskId')?.trim() || null;
  if (!token || !taskIdFromQuery || taskIdFromQuery.length > 200) {
    return NextResponse.json({ error: 'invalid_callback_token' }, { status: 401 });
  }

  const task = await prisma.videoTask.findUnique({ where: { id: taskIdFromQuery } });
  if (!task || !verifyVideoCallbackToken({ taskId: task.id, createdAt: task.created_at, token })) {
    return NextResponse.json({ error: 'invalid_callback_token' }, { status: 401 });
  }
  const payload = await readCallbackPayload(request);
  const providerTaskId = extractProviderTaskId(payload);
  if (providerTaskId && task.provider_task_id && providerTaskId !== task.provider_task_id) {
    return NextResponse.json({ error: 'callback_task_mismatch' }, { status: 409 });
  }

  const finalizeResult = await finalizeVideoTaskStatus(task.id, {
    forceProviderRefresh: true,
    cacheOnSuccess: false,
    generateThumbnail: false,
  });
  const finalTask = finalizeResult.task || task;

  let enqueueResult: Awaited<ReturnType<typeof enqueueVideoDeliveryJob>> | null = null;
  if (finalTask.local_status === 'succeeded') {
    enqueueResult = await enqueueVideoDeliveryJob(task.id, {
      priority: 10,
      payload: { source: 'provider_callback' },
    });
  }

  const forwardResult = await forwardExternalCallback({
    taskId: task.id,
    paramsJson: finalTask.params_json || task.params_json,
    payload: (() => {
      const safe = projectPrivateMultiviewTask({ ...finalTask, source_metadata_json: task.source_metadata_json }) as unknown as Record<string, unknown>;
      const resultVideoUrl = finalTask.local_status === 'succeeded'
        ? [finalTask.public_video_url, finalTask.result_video_url].find(value => {
          if (!isPublicHttpUrl(value)) return false;
          const url = new URL(value!);
          return !url.username && !url.password && !url.pathname.startsWith('/api/provider/seedance/callback');
        }) || null : null;
      return { task_id: safe.id, local_status: safe.local_status, provider_status: safe.provider_status,
        result_video_url: resultVideoUrl,
        play_url: safe.play_url, download_url: safe.download_url, thumbnail_url: safe.thumbnail_url,
        delivery_status: safe.delivery_status,
        error_code: safe.local_status === 'failed' ? 'VIDEO_TASK_FAILED' : null,
        error_message: safe.local_status === 'failed' ? '视频生成失败，请在任务详情查看。' : null };
    })(),
  });

  return NextResponse.json({
    ok: true,
    task_id: task.id,
    local_status: finalTask.local_status,
    delivery_queued: enqueueResult?.queued ?? false,
    delivery_skipped_reason: enqueueResult?.skippedReason ?? null,
    external_callback: forwardResult,
  });
});
