import { CreationError } from '@/lib/creation/contract';
import { prepareVideoCreationIntent } from '@/lib/creation/intents';
import { assertCreationLineageUnlocked } from '@/lib/creation/lineage';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession, AuthError } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import {
  assertCanViewTask,
  getProjectForGeneration,
} from '@/lib/projects/permissions';
import { VOLCENGINE_IP_VIDEO_PROVIDER } from '@/lib/provider/volcengine-ip';
import { quoteVideoPricing, requireVideoPricingRevision, videoPricingError } from '@/lib/pricing/video';
import { resolveVideoPricingContext, savedVideoPricingContextInput } from '@/lib/pricing/video-context';
import { uniquePreserveOrder } from '@/lib/reference-albums/permissions';
import { isPrivateMultiviewTask, isPrivateMultiviewActionTask, projectSelectedMultiviewTask, readMultiviewPrivateTaskMarker } from '@/lib/video/multiview-task-privacy';
import { createPrivateMultiviewRetry } from '@/lib/video/multiview-private-create.server';
import {
  PAID_GENERATION_INTENT_HEADER,
  PAID_GENERATION_INTENT_USER_AUTHORIZED,
  PAID_GENERATION_REASON_HEADER,
  userRetryGenerationReason,
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
    assertInternalOnly(user, '外部账号无权重试普通生成任务。');

    const originalTask = await prisma.videoTask.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        source_metadata_json: true,
        provider: true,
        model: true,
        local_status: true,
        error_code: true,
        frozen_cost: true,
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
        video_card_id: true,
        video_branch_id: true,
        params_json: true, creation_contract_version: true, creation_intent_id: true, lineage_root_task_id: true,
      },
    });

    if (!originalTask) {
      return NextResponse.json({ error: '任务不存在', message: `任务 ${params.id} 不存在` }, { status: 404 });
    }
    if (originalTask.provider === VOLCENGINE_IP_VIDEO_PROVIDER) {
      return NextResponse.json(
        { error: 'IP_RETRY_NOT_SUPPORTED', message: 'IP 生成任务不能走普通重试，请回到 IP 生成页重新提交' },
        { status: 400 },
      );
    }

    try {
      await assertCanViewTask(user, originalTask);
    } catch (error) {
      if (error instanceof AuthError) {
        return NextResponse.json({ error: '无权重试', message: error.message }, { status: error.status });
      }
      throw error;
    }

    const acceptedRetry = await prisma.videoTask.findUnique({ where: { user_id_idempotency_key: {
      user_id: user.id, idempotency_key: `video-retry:${originalTask.id}` } } });
    if (acceptedRetry) {
      await assertCanViewTask(user, acceptedRetry);
      if (isPrivateMultiviewTask(originalTask)) {
        const originalMarker = readMultiviewPrivateTaskMarker(originalTask);
        const retryMarker = readMultiviewPrivateTaskMarker(acceptedRetry);
        if (!retryMarker || retryMarker.recipeVersion !== originalMarker?.recipeVersion) {
          return NextResponse.json({ error: 'RETRY_RECEIPT_CONFLICT', message: '原重试回执与私有配方不一致，请保留原任务并联系管理员；未重新提交。' }, { status: 409 });
        }
      }
      return NextResponse.json(projectSelectedMultiviewTask({ id: acceptedRetry.id, local_status: acceptedRetry.local_status,
        provider_task_id: acceptedRetry.provider_task_id, source_metadata_json: acceptedRetry.source_metadata_json }),
      { headers: { 'Cache-Control': 'private, no-store' } });
    }
    if (isPrivateMultiviewTask(originalTask)) {
      if (isPrivateMultiviewActionTask(originalTask)) return NextResponse.json({ error: 'MULTIVIEW_ACTION_REQUOTE_REQUIRED',
        message: '请回同步动作视频修改动作并确认新费用；原任务未重发。', target_path: '/multiview' }, { status: 409 });
      if (originalTask.local_status !== 'failed' || originalTask.error_code?.includes('UNCONFIRMED') || originalTask.frozen_cost !== 0) {
        return NextResponse.json({ error: '原请求尚未确认失败，请查询原任务；未重新生成' }, { status: 409 });
      }
      if (originalTask.provider !== 'seedance' || originalTask.generation_mode !== 'all_in_one_reference') {
        return NextResponse.json({ error: 'RETRY_PROVIDER_UNSUPPORTED',
          message: '此任务请通过原生成入口重新获取报价；原任务未重发。', target_path: '/multiview' }, { status: 409 });
      }
      const requested = await request.json().catch(() => ({})) as Record<string, unknown>;
      const response = await createPrivateMultiviewRetry(request, {
        originalTaskId: originalTask.id, idempotencyKey: `video-retry:${originalTask.id}`,
        pricingRevision: typeof requested.pricing_revision === 'string' ? requested.pricing_revision : undefined,
        pricingQuoteToken: typeof requested.pricing_quote_token === 'string' ? requested.pricing_quote_token : undefined,
        maxEstimatedCost: typeof requested.max_estimated_cost === 'number' ? requested.max_estimated_cost : Number.NaN,
      });
      response.headers.set('Cache-Control', 'private, no-store');
      return response;
    }
    if (originalTask.provider && !['seedance', 'h3'].includes(originalTask.provider)) {
      return NextResponse.json({ error: 'RETRY_PROVIDER_UNSUPPORTED', message: '此任务不能转到普通生成重试，请从原生成入口重新获取报价；原任务未重发' }, { status: 409 });
    }
    if (!originalTask.video_card_id && originalTask.creation_contract_version !== 2) {
      return NextResponse.json(
        { error: 'VIDEO_CARD_REQUIRED', message: '历史任务尚未归档到视频卡，不能直接重试' },
        { status: 400 },
      );
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
    if (originalTask.local_status !== 'failed' || originalTask.error_code?.includes('UNCONFIRMED') || originalTask.frozen_cost !== 0) {
      return NextResponse.json({ error: '原请求尚未确认失败，请查询原任务；未重新生成' }, { status: 409 });
    }
    const requested = await request.json().catch(() => ({})) as Record<string, unknown>;
    const pricingContext = await resolveVideoPricingContext(user, savedVideoPricingContextInput(originalTask));
    const pricing = await quoteVideoPricing({ provider: originalTask.provider === 'h3' ? 'h3' : 'seedance',
      model: originalTask.model || '', resolution: originalTask.resolution || asString(paramsJson.resolution, '480p'),
      duration: originalTask.duration || asNumber(paramsJson.duration, 5), context: pricingContext });
    requireVideoPricingRevision(pricing, requested.pricing_revision);
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

    if (originalTask.lineage_root_task_id && originalTask.project_id) await assertCreationLineageUnlocked(prisma, user, originalTask.id, originalTask.project_id);
    const retryBody: Record<string, unknown> = {
      provider: originalTask.provider === 'h3' ? 'h3' : 'seedance',
      model: originalTask.model,
      idempotency_key: `video-retry:${originalTask.id}`,
      pricing_revision: requested.pricing_revision,
      pricing_quote_token: requested.pricing_quote_token,
      ...(requested.pricing_quote_token ? { pricing_fingerprint_version: 2 } : {}),
      max_estimated_cost: requested.max_estimated_cost,
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
      video_card_id: originalTask.video_card_id,
      video_branch_id: originalTask.video_branch_id,
      reference_image_urls: uniquePreserveOrder(preferredReferenceImageUrls),
      reference_video_urls: parseJsonArray(originalTask.reference_video_urls),
      reference_audio_urls: parseJsonArray(originalTask.reference_audio_urls),
      first_frame_url: originalTask.first_frame_url
        || (typeof paramsJson.firstFrameUrl === 'string' && paramsJson.firstFrameUrl.trim() ? paramsJson.firstFrameUrl : undefined),
      last_frame_url: originalTask.last_frame_url
        || (typeof paramsJson.lastFrameUrl === 'string' && paramsJson.lastFrameUrl.trim() ? paramsJson.lastFrameUrl : undefined),
      frame_image_urls: parseJsonArray(originalTask.frame_image_urls),
    };

    if (originalTask.lineage_root_task_id) retryBody.continuation = { mode: 'continue', parent_task_id: originalTask.id };
    if (originalTask.creation_contract_version === 2) {
      const previousIntent = originalTask.creation_intent_id ? await prisma.videoCreationIntent.findUnique({ where: { id: originalTask.creation_intent_id } }) : null;
      const oldSpec = previousIntent ? parseJsonObject(previousIntent.spec_json) : {};
      Object.assign(retryBody, { creation_contract_version: 2, entry: 'ordinary', continuation: { mode: 'continue', parent_task_id: originalTask.id }, baseline_task_id: oldSpec.baseline_task_id || null });
      const prepared = await prepareVideoCreationIntent(user, { ...retryBody, request_id: retryBody.idempotency_key });
      if (!prepared.availability?.canSubmit) return NextResponse.json({ error: 'CREATION_APPROVAL_REQUIRED', message: '本次继续需要重新核对条件，请从原任务的继续调整入口处理', intent_id: prepared.id, reasons: prepared.availability?.reasons }, { status: 409 });
      Object.assign(retryBody, { intent_id: prepared.id, intent_revision: prepared.revision, resolution_approval_id: prepared.approval_id || null });
    }

    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    headers.set('x-tab-id', request.headers.get('x-tab-id') || 'default');
    headers.set(PAID_GENERATION_INTENT_HEADER, PAID_GENERATION_INTENT_USER_AUTHORIZED);
    headers.set(PAID_GENERATION_REASON_HEADER, userRetryGenerationReason('video', originalTask.id));

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
    if (error instanceof CreationError) return NextResponse.json({ error: error.code, code: error.code, message: error.message }, { status: error.status });
    const pricingError = videoPricingError(error);
    if (pricingError) return NextResponse.json({ error: pricingError.message, code: pricingError.code }, { status: pricingError.status });
    console.error('[RetryTask]', error);
    return NextResponse.json(
      { error: '内部服务异常', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
