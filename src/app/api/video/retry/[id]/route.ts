import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { createVideoTask, isApiKeyConfigured } from '@/lib/provider/jimeng';
import { AuthError, getSession } from '@/lib/auth/session';
import { getProjectForGeneration } from '@/lib/projects/permissions';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: '请先登录后再重试视频任务' },
        { status: 401 },
      );
    }
    if (user.role !== 'admin') {
      return NextResponse.json(
        { error: 'Forbidden', message: '该接口仅管理员可用，请使用任务创建接口重新提交' },
        { status: 403 },
      );
    }

    const originalTaskId = params.id;

    if (!isApiKeyConfigured()) {
      return NextResponse.json(
        { error: 'API key not configured', message: '请在环境变量中配置 SEEDANCE_API_KEY' },
        { status: 500 }
      );
    }

    const originalTask = await prisma.videoTask.findUnique({
      where: { id: originalTaskId },
    });

    if (!originalTask) {
      return NextResponse.json(
        { error: 'Task not found', message: `Task ${originalTaskId} not found` },
        { status: 404 }
      );
    }

    let retryProject;
    try {
      retryProject = await getProjectForGeneration(user, originalTask.project_id || null);
    } catch (error) {
      if (error instanceof AuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    let paramsJson: Record<string, unknown> = {};
    try {
      if (originalTask.params_json) {
        paramsJson = JSON.parse(originalTask.params_json);
      }
    } catch {
      // ignore
    }

    // Parse reference arrays
    const referenceImageUrls = originalTask.reference_image_urls
      ? JSON.parse(originalTask.reference_image_urls) as string[]
      : [];
    const referenceVideoUrls = originalTask.reference_video_urls
      ? JSON.parse(originalTask.reference_video_urls) as string[]
      : [];
    const referenceAudioUrls = originalTask.reference_audio_urls
      ? JSON.parse(originalTask.reference_audio_urls) as string[]
      : [];
    const frameImageUrls = originalTask.frame_image_urls
      ? JSON.parse(originalTask.frame_image_urls) as string[]
      : [];

    // Create new local task
    const newTask = await prisma.videoTask.create({
      data: {
        provider: originalTask.provider,
        model: originalTask.model,
        generation_mode: originalTask.generation_mode,
        prompt: originalTask.prompt,
        ratio: originalTask.ratio ?? '16:9',
        duration: originalTask.duration ?? 5,
        resolution: originalTask.resolution ?? '480p',
        seed: originalTask.seed ?? -1,
        generate_audio: originalTask.generate_audio,
        return_last_frame: originalTask.return_last_frame,
        watermark: originalTask.watermark,
        reference_image_urls: originalTask.reference_image_urls,
        reference_video_urls: originalTask.reference_video_urls,
        reference_audio_urls: originalTask.reference_audio_urls,
        first_frame_url: originalTask.first_frame_url,
        last_frame_url: originalTask.last_frame_url,
        frame_image_urls: originalTask.frame_image_urls,
        workspace_id: originalTask.workspace_id,
        user_id: originalTask.user_id || user.id,
        owner_user_id: originalTask.owner_user_id || originalTask.user_id || user.id,
        project_id: retryProject.id,
        visibility: originalTask.visibility,
        billing_scope: originalTask.billing_scope || 'user',
        billing_account_id: originalTask.billing_account_id || originalTask.user_id || user.id,
        params_json: originalTask.params_json,
        local_status: 'submitted',
      },
    });

    try {
      await prisma.videoTask.update({
        where: { id: newTask.id },
        data: { provider_client_request_id: newTask.id },
      });

      const providerResult = await createVideoTask({
        prompt: originalTask.prompt,
        generation_mode: originalTask.generation_mode as 'all_in_one_reference' | 'first_last_frame' | 'smart_multi_frame',
        ratio: originalTask.ratio as '21:9' | '16:9' | '4:3' | '1:1' | '3:4' | '9:16' || '16:9',
        duration: originalTask.duration as 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 || 5,
        resolution: originalTask.resolution as '480p' | '720p' | '1080p' || '480p',
        clientRequestId: newTask.id,
        client_request_id: newTask.id,
        seed: originalTask.seed ?? -1,
        generate_audio: originalTask.generate_audio,
        return_last_frame: originalTask.return_last_frame,
        watermark: originalTask.watermark,
        reference_image_urls: referenceImageUrls,
        reference_video_urls: referenceVideoUrls,
        reference_audio_urls: referenceAudioUrls,
        first_frame_url: originalTask.first_frame_url ?? undefined,
        last_frame_url: originalTask.last_frame_url ?? undefined,
        frame_image_urls: frameImageUrls,
      });

      const updatedTask = await prisma.videoTask.update({
        where: { id: newTask.id },
        data: {
          provider_task_id: providerResult.provider_task_id,
          raw_create_response: JSON.stringify(providerResult.raw),
        },
      });

      return NextResponse.json({
        id: updatedTask.id,
        provider_task_id: updatedTask.provider_task_id,
        status: updatedTask.local_status,
        created_at: updatedTask.created_at,
      });
    } catch (apiError) {
      await prisma.videoTask.update({
        where: { id: newTask.id },
        data: {
          local_status: 'failed',
          error_message: apiError instanceof Error ? apiError.message : 'Unknown error',
        },
      });

      return NextResponse.json(
        {
          error: 'API call failed',
          message: apiError instanceof Error ? apiError.message : 'Unknown error',
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('[RetryTask] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
