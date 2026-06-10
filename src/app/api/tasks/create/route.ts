import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { prisma } from '@/lib/prisma';
import { getSessionUser, errorJson } from '@/lib/auth/api-helpers';
import { calculateEstimatedCost } from '@/lib/pricing';
import { getOrCreateWorkspace } from '@/lib/assets/workspace';
import { validatePromptReferences, renderPromptWithAssets } from '@/lib/assets/collection';
import { createTaskSnapshot } from '@/lib/assets/snapshot';
import { createVideoTask, buildContentArray, isApiKeyConfigured } from '@/lib/provider/jimeng';
import { AuthError } from '@/lib/auth/session';
import { getProjectForGeneration } from '@/lib/projects/permissions';
import {
  authenticateCodexVideoApi,
  CodexApiAuthError,
  hasCodexApiAuthSignal,
  webRequestSource,
  type GenerationRequestSource,
} from '@/lib/integrations/codex';
import {
  createProviderApiRequest,
  markProviderApiRequestAccepted,
  markProviderApiRequestFailed,
  recordTaskCostEstimate,
  recordTaskCostSettlement,
} from '@/lib/costs/ledger';
import {
  getAuthorizedReferenceImagesForUse,
  uniquePreserveOrder,
} from '@/lib/reference-albums/permissions';
import {
  ensureWorkspaceImageAssetsHaveReferenceImages,
  importReferenceImageUrlsToSite,
  ReferenceImportError,
} from '@/lib/assets/reference-import';
import { allocateTaskCredits, settleTaskCredits } from '@/lib/credits/policy';
import { evaluatePaidGenerationGuard, paidGenerationGuardError } from '@/lib/tasks/paid-generation-guard';
import type { CreateVideoInput, GenerationMode, VideoResolution, VideoDuration } from '@/types';

const VALID_GENERATION_MODES: GenerationMode[] = [
  'all_in_one_reference',
  'first_last_frame',
  'smart_multi_frame',
];
const VALID_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const VALID_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const VALID_RESOLUTIONS = ['480p', '720p', '1080p'];

export async function POST(request: NextRequest) {
  let user;
  let requestSource: GenerationRequestSource = webRequestSource(request);

  if (hasCodexApiAuthSignal(request)) {
    try {
      const codexContext = await authenticateCodexVideoApi(request);
      user = codexContext.user;
      requestSource = codexContext.source;
    } catch (error) {
      if (error instanceof CodexApiAuthError) {
        return errorJson(error.message, error.status);
      }
      throw error;
    }
  } else {
    try {
      user = await getSessionUser(request);
    } catch {
      return errorJson('请先登录后再生成视频', 401);
    }
  }

  if (user.status !== 'active') {
    return errorJson('账号已被禁用，无法生成', 403);
  }

  if (!isApiKeyConfigured()) {
    return errorJson('请在环境变量中配置 SEEDANCE_API_KEY', 500);
  }

  const body = await request.json();

  // --- Validation ---
  if (!body.prompt || typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return errorJson('提示词不能为空', 400);
  }

  const generationMode: GenerationMode = body.generation_mode || 'all_in_one_reference';
  if (!VALID_GENERATION_MODES.includes(generationMode)) {
    return errorJson(`generation_mode 必须是 ${VALID_GENERATION_MODES.join(', ')}`, 400);
  }

  const ratio = body.ratio || '16:9';
  const duration: VideoDuration = body.duration || 5;
  const resolution: VideoResolution = body.resolution || '720p';

  if (!VALID_RATIOS.includes(ratio)) return errorJson('ratio 无效', 400);
  if (!VALID_DURATIONS.includes(duration)) return errorJson('duration 必须是 4-15', 400);
  if (!VALID_RESOLUTIONS.includes(resolution)) return errorJson('resolution 无效', 400);

  const paidGenerationGuard = evaluatePaidGenerationGuard({ request, body, requestSource });
  if (!paidGenerationGuard.allowed) {
    return NextResponse.json(paidGenerationGuardError(paidGenerationGuard), { status: 403 });
  }

  let project;
  try {
    project = await getProjectForGeneration(
      user,
      typeof body.project_id === 'string' && body.project_id.trim() ? body.project_id.trim() : null,
    );
  } catch (error) {
    if (error instanceof AuthError) return errorJson(error.message, error.status);
    throw error;
  }

  // --- Pricing ---
  const pricing = calculateEstimatedCost(resolution, duration);
  const estimatedCost = pricing.estimatedCost;

  // --- Idempotency ---
  const idempotencyKey: string | undefined = body.idempotency_key || undefined;
  if (idempotencyKey) {
    const existing = await prisma.videoTask.findUnique({
      where: { user_id_idempotency_key: { user_id: user.id, idempotency_key: idempotencyKey } },
    });
    if (existing) {
      return NextResponse.json({
        id: existing.id,
        status: existing.local_status,
        estimated_cost: existing.estimated_cost,
        frozen_cost: existing.frozen_cost,
        created_at: existing.created_at,
        deduplicated: true,
        source_type: existing.source_type,
        source_label: existing.source_label,
        source_request_id: existing.source_request_id,
      });
    }
  }

  // --- Workspace + Reference Image Preparation ---
  const tabId = request.headers.get('x-tab-id') || 'default';
  const bodySourceRequestId = typeof body.source_request_id === 'string' && body.source_request_id.trim()
    ? body.source_request_id.trim()
    : typeof body.codex_request_id === 'string' && body.codex_request_id.trim()
      ? body.codex_request_id.trim()
      : null;
  const sourceRequestId = requestSource.source_request_id || bodySourceRequestId || idempotencyKey || null;
  const sourceMetadata: Record<string, unknown> = {
    ...requestSource.source_metadata,
    tab_id: tabId,
    idempotency_key: idempotencyKey || null,
    body_source_request_id: bodySourceRequestId,
    client_name: typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim() : null,
    paid_generation_guard: paidGenerationGuard.metadata,
  };
  const { id: workspaceId } = await getOrCreateWorkspace(tabId, user.id);

  let requestedReferenceImageIds = uniquePreserveOrder(
    Array.isArray(body.reference_image_ids)
      ? body.reference_image_ids
      : Array.isArray(body.referenceImageIds)
        ? body.referenceImageIds
        : [],
  );

  let requestedReferenceImageUrls = uniquePreserveOrder(
    Array.isArray(body.reference_image_urls)
      ? body.reference_image_urls
      : Array.isArray(body.referenceImageUrls)
        ? body.referenceImageUrls
        : [],
  );

  if (requestedReferenceImageIds.length + requestedReferenceImageUrls.length > 9) {
    return NextResponse.json({ error: '单次生成最多选择 9 张参考图' }, { status: 400 });
  }

  if (requestSource.source_type === 'codex_api' && requestedReferenceImageUrls.length > 0) {
    try {
      const importedReferences = await importReferenceImageUrlsToSite({
        user,
        workspaceId,
        projectId: project.id,
        sourceRequestId,
        sourceLabel: requestSource.source_label,
        urls: requestedReferenceImageUrls,
      });
      requestedReferenceImageIds = uniquePreserveOrder([
        ...requestedReferenceImageIds,
        ...importedReferences.map((item) => item.referenceImageId),
      ]);
      requestedReferenceImageUrls = [];
      sourceMetadata.imported_reference_images = importedReferences.map((item) => ({
        asset_id: item.assetId,
        reference_image_id: item.referenceImageId,
        original_url: item.originalUrl,
      }));
    } catch (error) {
      if (error instanceof ReferenceImportError) {
        return NextResponse.json(
          { error: error.code, message: error.message },
          { status: error.status },
        );
      }
      throw error;
    }
  }

  const workspaceReferenceBackfill = await ensureWorkspaceImageAssetsHaveReferenceImages({
    user,
    workspaceId,
    projectId: project.id,
    sourceRequestId,
    sourceLabel: requestSource.source_label,
    metadataSource: requestSource.source_type === 'codex_api' ? 'codex_api_workspace' : 'web_workspace',
  });
  if (workspaceReferenceBackfill.length > 0) {
    sourceMetadata.workspace_reference_backfill = workspaceReferenceBackfill.map((item) => ({
      asset_id: item.assetId,
      reference_image_id: item.referenceImageId,
    }));
  }

  const workspaceReferenceImageIds = uniquePreserveOrder(
    (await prisma.workspaceAsset.findMany({
      where: {
        workspace_id: workspaceId,
        reference_image_id: { not: null },
      },
      orderBy: { sort_order: 'asc' },
      select: { reference_image_id: true },
    })).map((item) => item.reference_image_id || ''),
  );

  if (requestedReferenceImageIds.length > 0) {
    const workspaceIdSet = new Set(workspaceReferenceImageIds);
    const missingFromWorkspace = requestedReferenceImageIds.filter((id) => !workspaceIdSet.has(id));
    if (missingFromWorkspace.length > 0) {
      return NextResponse.json(
        { error: 'REFERENCE_IMAGE_NOT_IN_WORKSPACE', message: '参考图必须先加入当前生成工作台' },
        { status: 400 },
      );
    }
  }

  if (requestedReferenceImageIds.length === 0 && requestedReferenceImageUrls.length > 9) {
    return NextResponse.json({ error: '单次生成最多选择 9 张参考图' }, { status: 400 });
  }

  const generationReferenceImageIds = requestedReferenceImageIds.length > 0
    ? requestedReferenceImageIds
    : requestedReferenceImageUrls.length > 0
      ? []
      : workspaceReferenceImageIds;
  if (generationReferenceImageIds.length > 9) {
    return NextResponse.json({ error: '单次生成最多选择 9 张参考图' }, { status: 400 });
  }
  let generationReferenceImages: Awaited<ReturnType<typeof getAuthorizedReferenceImagesForUse>> = [];
  try {
    generationReferenceImages = generationReferenceImageIds.length > 0
      ? await getAuthorizedReferenceImagesForUse(user, generationReferenceImageIds)
      : [];
  } catch (error) {
    if (error instanceof AuthError) return errorJson(error.message, error.status);
    throw error;
  }
  const generationReferenceAlbumIds = uniquePreserveOrder(generationReferenceImages.map((image) => image.album_id));

  const { preparedImages, prepareErrors, summary: prepSummary } = await prepareReferenceImages(
    workspaceId,
    generationReferenceImageIds,
    requestedReferenceImageUrls,
  );

  if (prepSummary.total > 0 && preparedImages.length === 0 && prepSummary.skipped > 0) {
    return NextResponse.json(
      { error: 'REFERENCE_IMAGE_NOT_PUBLIC', message: '参考图无法生成公网 URL', details: { errors: prepareErrors } },
      { status: 400 },
    );
  }

  // --- Build mode-specific reference arrays ---
  let referenceImageUrls: string[] = [];
  let firstFrameUrl: string | undefined = body.first_frame_url;
  let lastFrameUrl: string | undefined = body.last_frame_url;
  let frameImageUrls: string[] = body.frame_image_urls ? [...body.frame_image_urls] : [];
  const referenceVideoUrls: string[] = body.reference_video_urls ? [...body.reference_video_urls].slice(0, 3) : [];
  const referenceAudioUrls: string[] = body.reference_audio_urls ? [...body.reference_audio_urls].slice(0, 3) : [];

  switch (generationMode) {
    case 'all_in_one_reference':
      referenceImageUrls = preparedImages.map((img) => img.originalUrl).slice(0, 9);
      break;
    case 'first_last_frame':
      if (!firstFrameUrl) firstFrameUrl = preparedImages[0]?.originalUrl;
      if (!firstFrameUrl) return errorJson('首尾帧模式必须提供首帧图片', 400);
      break;
    case 'smart_multi_frame':
      if (frameImageUrls.length === 0) frameImageUrls = preparedImages.map((img) => img.originalUrl);
      if (frameImageUrls.length < 2) return errorJson('智能多帧模式至少需要 2 张图片', 400);
      break;
  }

  // --- Prompt validation + rendering ---
  const promptValidation = await validatePromptReferences(body.prompt, workspaceId);
  if (!promptValidation.valid) {
    return NextResponse.json(
      { error: 'PROMPT_REFERENCE_ERROR', message: `prompt 中引用的图号不存在: ${promptValidation.missing.join(', ')}` },
      { status: 400 },
    );
  }
  const { promptRendered, assetMapping } = await renderPromptWithAssets(body.prompt, workspaceId, generationMode);

  // --- Build provider input ---
  const seed = body.seed ?? -1;
  const generateAudio = body.generate_audio ?? true;
  const returnLastFrame = body.return_last_frame ?? false;
  const watermark = body.watermark ?? false;

  const providerInput: CreateVideoInput = {
    prompt: promptRendered,
    generation_mode: generationMode,
    ratio: ratio as CreateVideoInput['ratio'],
    duration: duration as CreateVideoInput['duration'],
    resolution: resolution as CreateVideoInput['resolution'],
    seed,
    generate_audio: generateAudio,
    return_last_frame: returnLastFrame,
    watermark,
    reference_image_urls: referenceImageUrls,
    reference_video_urls: referenceVideoUrls,
    reference_audio_urls: referenceAudioUrls,
    first_frame_url: firstFrameUrl,
    last_frame_url: lastFrameUrl,
    frame_image_urls: frameImageUrls,
    callback_url: body.callback_url,
    execution_expires_after: body.execution_expires_after,
  };

  // --- Create snapshot ---
  const content = buildContentArray(providerInput);
  const snapshot = await createTaskSnapshot({
    workspaceId,
    generationMode,
    promptRaw: body.prompt,
    input: providerInput,
    providerPayloadJson: JSON.stringify({ content_item_count: content.length, referenceCount: preparedImages.length }),
  });

  // --- Credit check + freeze + create single VideoTask in ONE transaction ---
  let taskId: string;
  let createdTask!: {
    id: string;
    user_id: string | null;
    owner_user_id: string | null;
    project_id: string | null;
    provider: string;
    provider_task_id: string | null;
    model: string;
    resolution: string | null;
    duration: number | null;
    estimated_cost: number | null;
    pricing_rule_id: string | null;
    pricing_snapshot: string | null;
  };
  try {
    const result = await prisma.$transaction(async (tx) => {
      const task = await tx.videoTask.create({
        data: {
          provider: 'seedance',
          model: 'dreamina-seedance-2-0-260128',
          generation_mode: generationMode,
          prompt: body.prompt.trim(),
          source_type: requestSource.source_type,
          source_label: requestSource.source_label,
          source_request_id: sourceRequestId,
          source_metadata_json: JSON.stringify(sourceMetadata),
          ratio,
          duration,
          resolution,
          seed,
          generate_audio: generateAudio,
          return_last_frame: returnLastFrame,
          watermark,
          reference_image_urls: referenceImageUrls.length > 0 ? JSON.stringify(referenceImageUrls) : null,
          reference_album_ids: generationReferenceAlbumIds.length > 0 ? JSON.stringify(generationReferenceAlbumIds) : null,
          reference_image_ids: generationReferenceImageIds.length > 0 ? JSON.stringify(generationReferenceImageIds) : null,
          reference_video_urls: referenceVideoUrls.length > 0 ? JSON.stringify(referenceVideoUrls) : null,
          reference_audio_urls: referenceAudioUrls.length > 0 ? JSON.stringify(referenceAudioUrls) : null,
          first_frame_url: firstFrameUrl || null,
          last_frame_url: lastFrameUrl || null,
          frame_image_urls: frameImageUrls.length > 0 ? JSON.stringify(frameImageUrls) : null,
          local_status: 'submitted',
          user_id: user.id,
          owner_user_id: user.id,
          project_id: project.id,
          visibility: project.type === 'personal' ? 'private' : 'project',
          estimated_cost: estimatedCost,
          frozen_cost: estimatedCost,
          pricing_snapshot: JSON.stringify(pricing),
          pricing_rule_id: pricing.pricingRuleId,
          idempotency_key: idempotencyKey || null,
          billing_scope: 'user',
          billing_account_id: user.id,
          workspace_id: workspaceId,
          snapshot_id: snapshot.id,
          params_json: JSON.stringify({
            ratio, duration, resolution, seed,
            generateAudio, returnLastFrame, watermark,
            referenceAlbumIds: generationReferenceAlbumIds,
            referenceImageIds: generationReferenceImageIds,
            preparedImages: preparedImages.map((img) => ({ name: img.name, originalUrl: img.originalUrl, sourceType: img.sourceType })),
            prepSummary,
            source: {
              type: requestSource.source_type,
              label: requestSource.source_label,
              requestId: sourceRequestId,
              paidGenerationGuard: paidGenerationGuard.metadata,
            },
          }),
        },
      });

      let freeze;
      try {
        freeze = await allocateTaskCredits(tx, {
          id: user.id,
          role: user.role,
          account_type: user.account_type,
          user_profile: user.user_profile,
          status: user.status,
        }, estimatedCost, task.id);
      } catch (error) {
        throw new CreditError(
          error instanceof Error ? error.message : '点数不足',
          'INSUFFICIENT_CREDITS',
        );
      }

      await tx.videoTask.update({
        where: { id: task.id },
        data: { credit_freeze_snapshot: freeze.snapshot },
      });

      await tx.creditLedger.create({
        data: {
          user_id: user.id,
          type: 'task_freeze',
          amount: -estimatedCost,
          balance_before: freeze.balance_before,
          balance_after: freeze.balance_after,
          frozen_before: freeze.frozen_before,
          frozen_after: freeze.frozen_after,
          related_task_id: task.id,
          reason: `任务创建冻结 ${estimatedCost} 点`,
          metadata_json: JSON.stringify({ allocations: freeze.allocations }),
        },
      });

      await tx.operationLog.create({
        data: {
          operator_id: user.id,
          action: requestSource.source_type === 'codex_api' ? 'generation_create_codex_api' : 'generation_create',
          target_type: 'VideoTask',
          target_id: task.id,
          detail: JSON.stringify({
            project_id: project.id,
            owner_user_id: user.id,
            estimated_cost: estimatedCost,
            reference_album_ids: generationReferenceAlbumIds,
            reference_image_ids: generationReferenceImageIds,
            source_type: requestSource.source_type,
            source_label: requestSource.source_label,
            source_request_id: sourceRequestId,
            paid_generation_guard: paidGenerationGuard.metadata,
          }),
        },
      });

      await recordTaskCostEstimate(tx, task, pricing, user.id);

      return task;
    });

    taskId = result.id;
    createdTask = result;
  } catch (err) {
    if (err instanceof CreditError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: 400 });
    }
    throw err;
  }

  // --- Call Seedance provider DIRECTLY (no internal HTTP) ---
  let providerRequestId: string | null = null;
  try {
    providerInput.clientRequestId = taskId;
    providerInput.client_request_id = taskId;
    await prisma.videoTask.update({
      where: { id: taskId },
      data: { provider_client_request_id: taskId },
    });

    const providerRequest = await createProviderApiRequest({
      task: createdTask,
      endpoint: 'seedance.createVideoTask',
      method: 'POST',
      idempotencyKey: idempotencyKey || null,
      requestPayload: {
        ...providerInput,
        source: {
          type: requestSource.source_type,
          label: requestSource.source_label,
          requestId: sourceRequestId,
          paidGenerationGuard: paidGenerationGuard.metadata,
        },
      },
    });
    providerRequestId = providerRequest.id;

    const providerResult = await createVideoTask(providerInput);

    await prisma.videoTask.update({
      where: { id: taskId },
      data: {
        provider_task_id: providerResult.provider_task_id,
        raw_create_response: JSON.stringify(providerResult.raw),
        local_status: 'submitted',
      },
    });

    await markProviderApiRequestAccepted({
      requestId: providerRequest.id,
      task: { ...createdTask, provider_task_id: providerResult.provider_task_id },
      providerTaskId: providerResult.provider_task_id,
      responseSummary: {
        provider_task_id: providerResult.provider_task_id,
        response_keys: providerResult.raw && typeof providerResult.raw === 'object'
          ? Object.keys(providerResult.raw as Record<string, unknown>)
          : [],
      },
    });

    return NextResponse.json({
      id: taskId,
      provider_task_id: providerResult.provider_task_id,
      status: 'submitted',
      estimated_cost: estimatedCost,
      frozen_cost: estimatedCost,
      pricing,
      workspace_id: workspaceId,
      project_id: project.id,
      snapshot_id: snapshot.id,
      prompt_rendered: promptRendered,
      asset_mapping: assetMapping,
      reference_album_ids: generationReferenceAlbumIds,
      reference_image_ids: generationReferenceImageIds,
      source_type: requestSource.source_type,
      source_label: requestSource.source_label,
      source_request_id: sourceRequestId,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    if (providerRequestId) {
      await markProviderApiRequestFailed({
        requestId: providerRequestId,
        errorCode: 'PROVIDER_CREATE_FAILED',
        errorMessage: err instanceof Error ? err.message : 'Seedance 调用异常',
      }).catch(() => {});
    }
    await handleProviderFailure(
      taskId,
      user.id,
      estimatedCost,
      err instanceof Error ? err.message : 'Seedance 调用异常',
    );
    return NextResponse.json(
      {
        error: 'PROVIDER_CREATE_FAILED',
        message: '视频生成服务异常，已返还冻结点数',
        task_id: taskId,
      },
      { status: 502 },
    );
  }
}

// --- Failure handler: release frozen credits in a single transaction ---
async function handleProviderFailure(
  taskId: string,
  userId: string,
  frozenAmount: number,
  errorMessage: string,
) {
  await prisma.$transaction(async (tx) => {
    const existingSettlement = await tx.creditLedger.findFirst({
      where: {
        related_task_id: taskId,
        type: { in: ['task_success_deduct', 'task_failed_refund'] },
      },
    });
    if (existingSettlement) return;

    const taskBeforeSettlement = await tx.videoTask.findUnique({ where: { id: taskId } });
    if (!taskBeforeSettlement) return;

    await tx.videoTask.update({
      where: { id: taskId },
      data: {
        local_status: 'failed',
        error_message: errorMessage,
        error_code: 'PROVIDER_CREATE_FAILED',
        completed_at: new Date(),
      },
    });

    const settlement = await settleTaskCredits(tx, {
      taskId,
      userId,
      terminalStatus: 'failed',
      frozenAmount,
      freezeSnapshot: taskBeforeSettlement.credit_freeze_snapshot,
    });

    const failedTask = await tx.videoTask.update({
      where: { id: taskId },
      data: {
        frozen_cost: 0,
        actual_cost: 0,
        refund_amount: settlement.refundedAmount,
      },
    });

    await tx.creditLedger.create({
      data: {
        user_id: userId,
        type: 'task_failed_refund',
        amount: settlement.refundedAmount,
        balance_before: settlement.balanceBefore,
        balance_after: settlement.balanceAfter,
        frozen_before: settlement.frozenBefore,
        frozen_after: settlement.frozenAfter,
        related_task_id: taskId,
        reason: `任务创建失败，返还冻结 ${settlement.refundedAmount} 点`,
        metadata_json: JSON.stringify({
          allocations: settlement.allocations,
          expired_closed: settlement.expiredClosedAmount,
        }),
      },
    });

    await recordTaskCostSettlement(tx, failedTask, 'failed', userId);
  });
}

// --- Reference image preparation (extracted from /api/video/create) ---
interface PreparedRefImage {
  name: string;
  originalUrl: string;
  sourceType: 'upload' | 'gallery' | 'external';
  order: number;
}

async function prepareReferenceImages(
  workspaceId: string,
  preferredReferenceImageIds: string[] = [],
  preferredReferenceImageUrls: string[] = [],
): Promise<{
  preparedImages: PreparedRefImage[];
  prepareErrors: string[];
  summary: { total: number; publicUrl: number; r2Uploaded: number; skipped: number; hasLocalPath: boolean };
}> {
  const selectedIds = uniquePreserveOrder(preferredReferenceImageIds).slice(0, 9);
  const selectedReferenceImageUrls = uniquePreserveOrder(preferredReferenceImageUrls).slice(0, 9);
  const prepareErrors: string[] = [];
  let skipped = 0;

  let imageItems: Array<{ asset: { id: string; file_name: string | null; original_url: string; type: string } | null; originalUrl: string }> = [];

  const workspaceReferenceAssets = await prisma.workspaceAsset.findMany({
    where: { workspace_id: workspaceId },
    include: { asset: true },
    orderBy: { sort_order: 'asc' },
  });

  if (selectedIds.length > 0) {
    const workspaceMap = new Map<string, NonNullable<typeof workspaceReferenceAssets[number]['asset']>>();
    for (const wa of workspaceReferenceAssets) {
      if (wa.reference_image_id) {
        workspaceMap.set(wa.reference_image_id, wa.asset);
      }
    }

    for (const referenceImageId of selectedIds) {
      const asset = workspaceMap.get(referenceImageId);
      if (!asset) {
        prepareErrors.push(`[${referenceImageId}] 参考图未在当前生成工作台内`);
        skipped += 1;
        continue;
      }

      if (asset.type !== 'image') {
        prepareErrors.push(`[${referenceImageId}] 参考图素材不是图片`);
        skipped += 1;
        continue;
      }

      imageItems.push({ asset, originalUrl: asset.original_url });
    }
  } else if (selectedReferenceImageUrls.length > 0) {
    const matchedAssets = await prisma.asset.findMany({
      where: { original_url: { in: selectedReferenceImageUrls } },
    });
    const matchedByUrl = new Map(matchedAssets.map((asset) => [asset.original_url, asset]));

    for (const rawUrl of selectedReferenceImageUrls) {
      const asset = matchedByUrl.get(rawUrl) ?? null;
      if (asset && asset.type !== 'image') {
        prepareErrors.push(`[${rawUrl}] 参考图素材不是图片`);
        skipped += 1;
        continue;
      }
      imageItems.push({ asset: asset ? {
        id: asset.id,
        file_name: asset.file_name,
        original_url: asset.original_url,
        type: asset.type,
      } : null, originalUrl: rawUrl });
    }
  } else {
    imageItems = workspaceReferenceAssets
      .filter((item) => item.asset.type === 'image')
      .map((item) => ({ asset: {
        id: item.asset.id,
        file_name: item.asset.file_name,
        original_url: item.asset.original_url,
        type: item.asset.type,
      }, originalUrl: item.asset.original_url }));
  }

  imageItems = imageItems.slice(0, 9);

  const preparedImages: PreparedRefImage[] = [];
  let publicUrl = 0;
  let r2Uploaded = 0;
  let hasLocalPath = false;

  for (let i = 0; i < imageItems.length; i++) {
    const item = imageItems[i];
    const originalUrl = item.originalUrl;
    const isPublicUrl = originalUrl.startsWith('https://') && !isLocalhostHost(originalUrl);
    const isR2 = originalUrl.includes('.r2.') || originalUrl.includes('r2.dev') || originalUrl.includes('.toscdn.');
    const isLocalPath = originalUrl.startsWith('/');

    if (isPublicUrl) {
      publicUrl += 1;
      preparedImages.push({
        name: item.asset?.file_name || `图${i + 1}`,
        originalUrl,
        sourceType: isR2 ? 'upload' : 'external',
        order: i,
      });
      continue;
    }

    if (isLocalPath) {
      hasLocalPath = true;
      const localFilePath = path.join(process.cwd(), 'public', originalUrl.replace(/^\/+/, ''));
      if (!fs.existsSync(localFilePath)) {
        skipped += 1;
        prepareErrors.push(`[${i + 1}] 本地文件不存在: ${originalUrl}`);
        continue;
      }

      const buffer = fs.readFileSync(localFilePath);
      const ext = path.extname(localFilePath).slice(1).toLowerCase();
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        bmp: 'image/bmp',
      };
      const mimeType = mimeMap[ext] || 'image/jpeg';

      let r2PublicUrl: string | null = null;
      try {
        const { uploadPublicAsset } = await import('@/lib/assets/public-storage');
        const fileName = item.asset?.file_name || path.basename(originalUrl) || `image.${ext}`;
        const pubResult = await uploadPublicAsset(buffer, fileName, mimeType);
        r2PublicUrl = pubResult.publicUrl;
      } catch (err) {
        skipped += 1;
        prepareErrors.push(`[${i + 1}] R2 上传失败: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      if (item.asset?.id) {
        await prisma.asset.update({
          where: { id: item.asset.id },
          data: { original_url: r2PublicUrl },
        }).catch(() => {});
      }

      r2Uploaded += 1;
      preparedImages.push({
        name: item.asset?.file_name || `图${i + 1}`,
        originalUrl: r2PublicUrl,
        sourceType: 'upload',
        order: i,
      });
      continue;
    }

    skipped += 1;
    prepareErrors.push(`[${i + 1}] 非公网 URL: ${originalUrl}`);
  }

  return {
    preparedImages,
    prepareErrors,
    summary: {
      total: selectedIds.length > 0
        ? selectedIds.length
        : selectedReferenceImageUrls.length > 0
          ? selectedReferenceImageUrls.length
          : imageItems.length,
      publicUrl,
      r2Uploaded,
      skipped,
      hasLocalPath,
    },
  };
}

function isLocalhostHost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.startsWith('192.168.') || u.hostname.startsWith('10.') || u.hostname.startsWith('172.');
  } catch { return false; }
}

class CreditError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}
