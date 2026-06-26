import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertCanViewTask } from '@/lib/projects/permissions';
import {
  VOLCENGINE_IP_VIDEO_PROVIDER,
  safeVolcengineIpUserMessage,
} from '@/lib/provider/volcengine-ip';
import { finalizeVideoTaskStatus } from '@/lib/video/task-finalizer';

export const dynamic = 'force-dynamic';

const IP_TASK_STATUS_INCLUDE = {
  project: { select: { id: true, name: true, type: true } },
  video_card: { select: { id: true, title: true, objective: true, status: true, project_id: true } },
  generation_template: { select: { id: true, name: true, template_key: true, version: true, status: true } },
  owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
  user: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
} as const;

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
}>(task: T) {
  return {
    id: task.id,
    provider: task.provider,
    model: task.model ?? null,
    provider_task_id: task.provider_task_id,
    prompt: task.prompt,
    source_type: task.source_type ?? null,
    source_label: task.source_label ?? null,
    source_request_id: task.source_request_id ?? null,
    generation_mode: task.generation_mode,
    ratio: task.ratio,
    duration: task.duration,
    resolution: task.resolution,
    seed: task.seed ?? null,
    generate_audio: task.generate_audio ?? null,
    return_last_frame: task.return_last_frame ?? null,
    watermark: task.watermark ?? null,
    reference_image_ids: task.reference_image_ids ?? null,
    reference_image_urls: task.reference_image_urls ?? null,
    reference_video_urls: task.reference_video_urls ?? null,
    reference_audio_urls: task.reference_audio_urls ?? null,
    first_frame_url: task.first_frame_url ?? null,
    last_frame_url: task.last_frame_url ?? null,
    frame_image_urls: task.frame_image_urls ?? null,
    local_status: task.local_status,
    provider_status: task.provider_status,
    result_video_url: null,
    result_last_frame_url: null,
    local_video_path: task.local_video_path,
    public_video_url: task.public_video_url ?? null,
    public_video_storage_provider: task.public_video_storage_provider ?? null,
    public_video_storage_key: task.public_video_storage_key ?? null,
    public_video_file_size: task.public_video_file_size ?? null,
    public_video_cached_at: task.public_video_cached_at ?? null,
    error_message: safeVolcengineIpUserMessage(task.error_message),
    project_id: task.project_id,
    video_card_id: task.video_card_id,
    template_id: task.template_id ?? null,
    agent_run_id: task.agent_run_id ?? null,
    selected_agent_plan_key: task.selected_agent_plan_key ?? null,
    prompt_user_edited: task.prompt_user_edited ?? false,
    provider_cost_currency: task.provider_cost_currency,
    provider_official_amount_minor: task.provider_official_amount_minor,
    provider_final_amount_minor: task.provider_final_amount_minor,
    provider_official_amount_micros: task.provider_official_amount_micros,
    provider_final_amount_micros: task.provider_final_amount_micros,
    project: 'project' in task ? task.project : null,
    video_card: 'video_card' in task ? task.video_card : null,
    generation_template: 'generation_template' in task ? task.generation_template : null,
    owner: task.owner || task.user || null,
    submitted_user: task.user || null,
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed_at: task.completed_at,
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
      return NextResponse.json(serializeTaskForIpStatus(task));
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
        ...serializeTaskForIpStatus(responseTask),
        error_message: safeVolcengineIpUserMessage(responseTask.error_message)
          || '火山任务状态同步失败，请稍后重试。',
      });
    }

    return NextResponse.json(serializeTaskForIpStatus(responseTask));
  } catch (error) {
    console.error('[IpVideoStatus] Get task status error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
