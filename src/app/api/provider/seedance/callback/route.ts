import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { finalizeVideoTaskStatus } from '@/lib/video/task-finalizer';
import { enqueueVideoDeliveryJob } from '@/lib/video/delivery-queue';
import { getExternalCallbackUrlFromParams } from '@/lib/video/delivery-policy';

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

function callbackSecret() {
  const expected = (process.env.VIDEO_DELIVERY_CALLBACK_SECRET || process.env.SEEDANCE_CALLBACK_SECRET || '').trim();
  return expected || null;
}

function verifyCallbackRequest(request: NextRequest, expected: string) {
  const token = request.nextUrl.searchParams.get('token') || request.headers.get('x-video-delivery-token');
  return token === expected;
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
      error: error instanceof Error ? error.message : String(error),
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

export async function POST(request: NextRequest) {
  const expectedSecret = callbackSecret();
  if (!expectedSecret) {
    return NextResponse.json(
      { error: 'callback_secret_not_configured', message: '视频回调密钥未配置' },
      { status: 503 },
    );
  }
  if (!verifyCallbackRequest(request, expectedSecret)) {
    return NextResponse.json({ error: 'invalid_callback_token' }, { status: 401 });
  }

  const payload = await readCallbackPayload(request);
  const taskIdFromQuery = request.nextUrl.searchParams.get('taskId')?.trim() || null;
  const providerTaskId = extractProviderTaskId(payload);
  const task = taskIdFromQuery
    ? await prisma.videoTask.findUnique({ where: { id: taskIdFromQuery } })
    : providerTaskId
      ? await prisma.videoTask.findFirst({ where: { provider_task_id: providerTaskId } })
      : null;

  if (!task) {
    return NextResponse.json(
      { error: 'task_not_found', message: '未找到对应的视频任务' },
      { status: 404 },
    );
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
    payload,
  });

  return NextResponse.json({
    ok: true,
    task_id: task.id,
    local_status: finalTask.local_status,
    delivery_queued: enqueueResult?.queued ?? false,
    delivery_skipped_reason: enqueueResult?.skippedReason ?? null,
    external_callback: forwardResult,
  });
}
