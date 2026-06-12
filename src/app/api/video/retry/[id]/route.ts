import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession, AuthError } from '@/lib/auth/session';
import {
  assertCanViewTask,
  getProjectForGeneration,
} from '@/lib/projects/permissions';
import { uniquePreserveOrder } from '@/lib/reference-albums/permissions';
import {
  PAID_GENERATION_INTENT_HEADER,
  PAID_GENERATION_INTENT_USER_AUTHORIZED,
  PAID_GENERATION_REASON_HEADER,
} from '@/lib/tasks/paid-generation-guard';

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: '未登录', message: '请先登录后再重试任务' }, { status: 401 });
    }

    const originalTask = await prisma.videoTask.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        prompt: true,
        generation_mode: true,
        ratio: true,
        duration: true,
        resolution: true,
        seed: true,
        generate_audio: true,
        return_last_frame: true,
        watermark: true,
        reference_image_urls: true,
        reference_image_ids: true,
        reference_video_urls: true,
        reference_audio_urls: true,
        first_frame_url: true,
        last_frame_url: true,
        frame_image_urls: true,
        project_id: true,
        params_json: true,
      },
    });

    if (!originalTask) {
      return NextResponse.json({ error: '任务不存在', message: `任务 ${params.id} 不存在` }, { status: 404 });
    }

    try {
      await assertCanViewTask(user, originalTask);
    } catch (error) {
      if (error instanceof AuthError) {
        return NextResponse.json({ error: '无权重试', message: error.message }, { status: error.status });
      }
      throw error;
    }

    let retryProject;
    try {
      retryProject = await getProjectForGeneration(user, originalTask.project_id || null);
    } catch (error) {
      if (error instanceof AuthError) {
        return NextResponse.json({ error: '无权重试', message: error.message }, { status: error.status });
      }
      throw error;
    }

    const paramsJson = parseJsonObject(originalTask.params_json);
    const referenceImageIds = uniquePreserveOrder(parseJsonArray(originalTask.reference_image_ids));
    const referenceImageUrls = parseJsonArray(originalTask.reference_image_urls).slice(0, 9);

    let preferredReferenceImageUrls = [...referenceImageUrls];
    if (preferredReferenceImageUrls.length === 0 && referenceImageIds.length > 0) {
      const referenceImages = await prisma.referenceImage.findMany({
        where: { id: { in: referenceImageIds } },
        include: {
          asset: {
            select: { original_url: true },
          },
        },
      });
      const imagesById = new Map(referenceImages.map((image) => [image.id, image]));
      const recovered = [];
      const missingIds = [];

      for (const imageId of referenceImageIds) {
        const image = imagesById.get(imageId);
        if (!image) {
          missingIds.push(imageId);
          continue;
        }
        const sourceUrl = image.asset?.original_url || image.url;
        if (sourceUrl) recovered.push(sourceUrl);
      }

      if (missingIds.length === 0 && recovered.length > 0) {
        preferredReferenceImageUrls = recovered;
      } else if (referenceImageUrls.length === 0 && recovered.length === 0) {
        return NextResponse.json(
          { error: '重试失败', message: '原始任务参考图无法恢复（图源已失效）' },
          { status: 400 },
        );
      }
    }

    const retryBody = {
      prompt: originalTask.prompt,
      generation_mode: originalTask.generation_mode,
      ratio: originalTask.ratio || asString(paramsJson.ratio, '16:9'),
      duration: originalTask.duration || asNumber(paramsJson.duration, 5),
      resolution: originalTask.resolution || asString(paramsJson.resolution, '480p'),
      seed: originalTask.seed ?? asNumber(paramsJson.seed, -1),
      generate_audio: true,
      return_last_frame: originalTask.return_last_frame ?? asBoolean(paramsJson.returnLastFrame, false),
      watermark: originalTask.watermark ?? asBoolean(paramsJson.watermark, false),
      resolution_approval_confirmed: asBoolean(paramsJson.resolutionApprovalConfirmed, false),
      project_id: retryProject.id,
      reference_image_urls: uniquePreserveOrder(preferredReferenceImageUrls),
      reference_video_urls: parseJsonArray(originalTask.reference_video_urls),
      reference_audio_urls: parseJsonArray(originalTask.reference_audio_urls),
      first_frame_url: originalTask.first_frame_url
        || (typeof paramsJson.firstFrameUrl === 'string' && paramsJson.firstFrameUrl.trim() ? paramsJson.firstFrameUrl : undefined),
      last_frame_url: originalTask.last_frame_url
        || (typeof paramsJson.lastFrameUrl === 'string' && paramsJson.lastFrameUrl.trim() ? paramsJson.lastFrameUrl : undefined),
      frame_image_urls: parseJsonArray(originalTask.frame_image_urls),
    };

    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    headers.set('x-tab-id', request.headers.get('x-tab-id') || 'default');
    headers.set(PAID_GENERATION_INTENT_HEADER, PAID_GENERATION_INTENT_USER_AUTHORIZED);
    headers.set(PAID_GENERATION_REASON_HEADER, `用户通过后台重试任务 ${originalTask.id}`);

    const cookie = request.headers.get('cookie');
    if (cookie) headers.set('cookie', cookie);

    const createResponse = await fetch(new URL('/api/tasks/create', request.url), {
      method: 'POST',
      headers,
      body: JSON.stringify(retryBody),
      cache: 'no-store',
    });

    const data = await createResponse.json();
    if (!createResponse.ok) {
      return NextResponse.json(
        { error: data.error || '重试失败', message: data.message || '任务重试失败', details: data.details || null },
        { status: createResponse.status },
      );
    }

    return NextResponse.json(data, { status: createResponse.status });
  } catch (error) {
    console.error('[RetryTask]', error);
    return NextResponse.json(
      { error: '内部服务异常', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
