import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession } from '@/lib/auth/session';
import { isExternalUser } from '@/lib/access/external-role';
import { assertCanViewTask } from '@/lib/projects/permissions';
import {
  VOLCENGINE_IP_VIDEO_PROVIDER,
  safeVolcengineIpUserMessage,
} from '@/lib/provider/volcengine-ip';
import { finalizeVideoTaskStatus } from '@/lib/video/task-finalizer';
import { taskThumbnailProjection } from '@/lib/video/task-thumbnail-projection';

export const dynamic = 'force-dynamic';

const IP_TASK_STATUS_INCLUDE = {
  project: { select: { id: true, name: true, type: true } },
  video_card: { select: { id: true, title: true, objective: true, status: true, project_id: true } },
  generation_template: { select: { id: true, name: true, template_key: true, version: true, status: true } },
  owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
  user: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
} as const;

function redactIpTaskForExternal<T extends Record<string, unknown>>(task: T) {
  return {
    ...task,
    provider_task_id: null,
    source_request_id: null,
    public_video_storage_key: null,
    template_id: null,
    agent_run_id: null,
    selected_agent_plan_key: null,
    provider_cost_currency: null,
    provider_official_amount_minor: null,
    provider_final_amount_minor: null,
    provider_official_amount_micros: null,
    provider_final_amount_micros: null,
    generation_template: null,
  };
}

function serializeTaskForIpStatus<T extends {
  owner?: unknown;
  user?: unknown;
  id: string;
  provider: string;
  model?: string | null;
  provider_task_id: string | null;
  prompt: string;
  source_type?: string | null;
  source_label?: string | null;
  source_request_id?: string | null;
  generation_mode: string;
  ratio: string | null;
  duration: number | null;
  resolution: string | null;
  seed?: number | null;
  generate_audio?: boolean | null;
  return_last_frame?: boolean | null;
  watermark?: boolean | null;
  reference_image_ids?: string | null;
  reference_image_urls?: string | null;
  reference_video_urls?: string | null;
  reference_audio_urls?: string | null;
  first_frame_url?: string | null;
  last_frame_url?: string | null;
  frame_image_urls?: string | null;
  local_status: string;
  provider_status: string | null;
  delivery_status?: string | null;
  result_video_url: string | null;
  result_last_frame_url: string | null;
  local_video_path: string | null;
  public_video_url?: string | null;
  public_video_storage_provider?: string | null;
  public_video_storage_key?: string | null;
  public_video_file_size?: number | null;
  public_video_cached_at?: Date | null;
  error_message: string | null;
  project_id: string | null;
  video_card_id: string | null;
  template_id?: string | null;
  agent_run_id?: string | null;
  selected_agent_plan_key?: string | null;
  prompt_user_edited?: boolean | null;
  provider_cost_currency: string | null;
  provider_official_amount_minor: number | null;
  provider_final_amount_minor: number | null;
  provider_official_amount_micros: number | null;
  provider_final_amount_micros: number | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}>(task: T, options: { external?: boolean } = {}) {
  const visibleTask = (
    options.external ? redactIpTaskForExternal(task as T & Record<string, unknown>) : task
  ) as T;
  return {
    id: visibleTask.id,
    provider: visibleTask.provider,
    model: visibleTask.model ?? null,
    provider_task_id: visibleTask.provider_task_id,
    prompt: visibleTask.prompt,
    source_type: visibleTask.source_type ?? null,
    source_label: visibleTask.source_label ?? null,
    source_request_id: visibleTask.source_request_id ?? null,
    generation_mode: visibleTask.generation_mode,
    ratio: visibleTask.ratio,
    duration: visibleTask.duration,
    resolution: visibleTask.resolution,
    seed: visibleTask.seed ?? null,
    generate_audio: visibleTask.generate_audio ?? null,
    return_last_frame: visibleTask.return_last_frame ?? null,
    watermark: visibleTask.watermark ?? null,
    reference_image_ids: visibleTask.reference_image_ids ?? null,
    reference_image_urls: visibleTask.reference_image_urls ?? null,
    reference_video_urls: visibleTask.reference_video_urls ?? null,
    reference_audio_urls: visibleTask.reference_audio_urls ?? null,
    first_frame_url: visibleTask.first_frame_url ?? null,
    last_frame_url: visibleTask.last_frame_url ?? null,
    frame_image_urls: visibleTask.frame_image_urls ?? null,
    local_status: visibleTask.local_status,
    provider_status: visibleTask.provider_status,
    ...taskThumbnailProjection({
      ...visibleTask,
      result_video_url: null,
      result_last_frame_url: null,
    }),
    result_video_url: null,
    result_last_frame_url: null,
    local_video_path: visibleTask.local_video_path,
    public_video_url: visibleTask.public_video_url ?? null,
    public_video_storage_provider: visibleTask.public_video_storage_provider ?? null,
    public_video_storage_key: visibleTask.public_video_storage_key ?? null,
    public_video_file_size: visibleTask.public_video_file_size ?? null,
    public_video_cached_at: visibleTask.public_video_cached_at ?? null,
    error_message: safeVolcengineIpUserMessage(visibleTask.error_message),
    project_id: visibleTask.project_id,
    video_card_id: visibleTask.video_card_id,
    template_id: visibleTask.template_id ?? null,
    agent_run_id: visibleTask.agent_run_id ?? null,
    selected_agent_plan_key: visibleTask.selected_agent_plan_key ?? null,
    prompt_user_edited: visibleTask.prompt_user_edited ?? false,
    provider_cost_currency: visibleTask.provider_cost_currency,
    provider_official_amount_minor: visibleTask.provider_official_amount_minor,
    provider_final_amount_minor: visibleTask.provider_final_amount_minor,
    provider_official_amount_micros: visibleTask.provider_official_amount_micros,
    provider_final_amount_micros: visibleTask.provider_final_amount_micros,
    project: 'project' in visibleTask ? visibleTask.project : null,
    video_card: 'video_card' in visibleTask ? visibleTask.video_card : null,
    generation_template: 'generation_template' in visibleTask ? visibleTask.generation_template : null,
    owner: visibleTask.owner || visibleTask.user || null,
    submitted_user: visibleTask.user || null,
    created_at: visibleTask.created_at,
    updated_at: visibleTask.updated_at,
    completed_at: visibleTask.completed_at,
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
      include: IP_TASK_STATUS_INCLUDE,
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
      return NextResponse.json(serializeTaskForIpStatus(task, { external: isExternalUser(user) }));
    }

    const finalizeResult = await finalizeVideoTaskStatus(taskId, {
      forceProviderRefresh,
      cacheOnSuccess: true,
      generateThumbnail: true,
      createdBy: user.id,
    });

    const responseTask = await prisma.videoTask.findUnique({
      where: { id: taskId },
      include: IP_TASK_STATUS_INCLUDE,
    });

    if (!responseTask || !finalizeResult.task) {
      return NextResponse.json(
        { error: 'Task not found', message: `Task ${taskId} not found` },
        { status: 404 },
      );
    }

    if (finalizeResult.providerError) {
      return NextResponse.json({
        ...serializeTaskForIpStatus(responseTask, { external: isExternalUser(user) }),
        error_message: safeVolcengineIpUserMessage(responseTask.error_message)
          || '火山任务状态同步失败，请稍后重试。',
      });
    }

    return NextResponse.json(serializeTaskForIpStatus(responseTask, { external: isExternalUser(user) }));
  } catch (error) {
    console.error('[IpVideoStatus] Get task status error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
