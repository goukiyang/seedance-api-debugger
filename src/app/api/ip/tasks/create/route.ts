import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import path from 'path';
import fs from 'fs';
import { prisma } from '@/lib/prisma';
import { getSessionUser, errorJson } from '@/lib/auth/api-helpers';
import { calculateEstimatedCost } from '@/lib/pricing';
import { addAssetToWorkspace, getOrCreateWorkspace } from '@/lib/assets/workspace';
import { validatePromptReferences, renderPromptWithAssets } from '@/lib/assets/collection';
import { createTaskSnapshot } from '@/lib/assets/snapshot';
import {
  VOLCENGINE_IP_VIDEO_PROVIDER,
  VolcengineIpConfigurationError,
  VolcengineIpRequestError,
  buildVolcengineIpCreatePayload,
  createVolcengineIpVideoTask,
  safeVolcengineIpUserMessage,
} from '@/lib/provider/volcengine-ip';
import {
  PROVIDER_REFERENCE_IMAGE_MAX_PIXELS,
  ensureProviderSafeReferenceImageUrl,
  getProviderSafeImageResizeDimensions,
  isProviderReferenceImageSizeError,
  providerReferenceImageSizeMessage,
} from '@/lib/provider/reference-image-safety';
import {
  getVolcengineIpApiSettings,
  isVolcengineIpApiReady,
} from '@/lib/integrations/volcengine-ip';
import { AuthError } from '@/lib/auth/session';
import { getProjectForGeneration } from '@/lib/projects/permissions';
import { assertCanGenerateInVideoCard } from '@/lib/video-cards/permissions';
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
  assertCanUseReferenceImage,
  getAuthorizedReferenceImagesForUse,
  uniquePreserveOrder,
} from '@/lib/reference-albums/permissions';
import {
  ensureWorkspaceImageAssetsHaveReferenceImages,
  importReferenceImageUrlsToSite,
  ReferenceImportError,
} from '@/lib/assets/reference-import';
import { allocateTaskCredits, settleTaskCredits } from '@/lib/credits/policy';
import {
  allocateProjectTaskBudget,
  settleProjectTaskBudget,
  shouldBillProjectBudget,
} from '@/lib/projects/budget';
import { consumeApprovalForTask, findUsableApproval } from '@/lib/approvals';
import { notifyProjectOwner } from '@/lib/notifications';
import { evaluatePaidGenerationGuard, paidGenerationGuardError } from '@/lib/tasks/paid-generation-guard';
import { startTaskLocalization } from '@/lib/video/task-localization-runner';
import type { CreateVideoInput, GenerationMode, VideoResolution, VideoDuration } from '@/types';

const VALID_GENERATION_MODES: GenerationMode[] = [
  'all_in_one_reference',
  'first_last_frame',
  'smart_multi_frame',
];
const VALID_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const VALID_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const VALID_RESOLUTIONS = ['480p', '720p', '1080p'];

function cleanSourceMetadata(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ['source', 'canvas_document_id', 'canvas_node_id', 'mode']) {
    const raw = source[key];
    if (typeof raw === 'string' && raw.trim()) result[key] = raw.trim().slice(0, 240);
  }
  return result;
}

function cleanClientName(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : null;
}

function parseJsonRecord(value: string | null | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

type IpIdempotentTask = {
  id: string;
  local_status: string;
  estimated_cost: number | null;
  frozen_cost: number | null;
  created_at: Date;
  source_type: string | null;
  source_label: string | null;
  source_request_id: string | null;
  project_id: string | null;
  video_card_id: string | null;
  template_id: string | null;
  agent_run_id: string | null;
  selected_agent_plan_key: string | null;
  billing_scope: string | null;
  billing_account_id: string | null;
};

function ipDeduplicatedTaskResponse(existing: IpIdempotentTask) {
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
    project_id: existing.project_id,
    video_card_id: existing.video_card_id,
    template_id: existing.template_id,
    agent_run_id: existing.agent_run_id,
    selected_agent_plan_key: existing.selected_agent_plan_key,
    billing_scope: existing.billing_scope,
    billing_account_id: existing.billing_account_id,
  });
}

function isPrismaUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function volcengineProviderErrorMessage(error: unknown) {
  if (error instanceof VolcengineIpConfigurationError) {
    return '请先在 API 整合页配置并启用火山 IP 生成 API';
  }
  if (error instanceof VolcengineIpRequestError) {
    return error.normalized.userMessage;
  }
  return safeVolcengineIpUserMessage(
    error instanceof Error ? error.message : null,
    '火山 IP 调用异常',
  ) || '火山 IP 调用异常';
}

function volcengineProviderErrorCode(error: unknown) {
  if (error instanceof VolcengineIpConfigurationError) {
    return error.code;
  }
  if (error instanceof VolcengineIpRequestError) {
    return error.normalized.code;
  }
  return 'PROVIDER_CREATE_FAILED';
}

function volcengineProviderHttpStatus(error: unknown) {
  if (error instanceof VolcengineIpConfigurationError) return 500;
  if (error instanceof VolcengineIpRequestError) {
    switch (error.normalized.category) {
      case 'auth':
        return 401;
      case 'permission':
        return 403;
      case 'quota':
        return 402;
      case 'rate_limit':
        return 429;
      case 'content_safety':
      case 'asset':
        return 400;
      case 'provider':
      case 'network':
        return 502;
      default:
        return error.statusCode && error.statusCode >= 400 && error.statusCode < 500
          ? error.statusCode
          : 502;
    }
  }
  return 502;
}

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

  const volcengineSettings = await getVolcengineIpApiSettings();
  if (!isVolcengineIpApiReady(volcengineSettings)) {
    return errorJson('请先在 API 整合页配置并启用火山 IP 生成 API', 500);
  }

  const body = await request.json();
  const requestedModel = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim().slice(0, 160)
    : null;
  const selectedModel = requestedModel || volcengineSettings.default_model;

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
  const resolutionApprovalConfirmed = body.resolution_approval_confirmed === true || body.resolutionApprovalConfirmed === true;
  const requestedTemplateId = typeof body.template_id === 'string' && body.template_id.trim() ? body.template_id.trim() : null;
  const requestedAgentRunId = typeof body.agent_run_id === 'string' && body.agent_run_id.trim() ? body.agent_run_id.trim() : null;
  const selectedAgentPlanKey = typeof body.selected_agent_plan_key === 'string' && body.selected_agent_plan_key.trim()
    ? body.selected_agent_plan_key.trim().slice(0, 16)
    : null;
  const agentPromptSnapshot = typeof body.agent_prompt_snapshot === 'string' && body.agent_prompt_snapshot.trim()
    ? body.agent_prompt_snapshot.trim().slice(0, 12000)
    : null;
  const finalPromptSnapshot = typeof body.final_prompt_snapshot === 'string' && body.final_prompt_snapshot.trim()
    ? body.final_prompt_snapshot.trim().slice(0, 12000)
    : body.prompt.trim();
  const promptUserEdited = body.prompt_user_edited === true;

  if (!VALID_RATIOS.includes(ratio)) return errorJson('ratio 无效', 400);
  if (!VALID_DURATIONS.includes(duration)) return errorJson('duration 必须是 4-15', 400);
  if (!VALID_RESOLUTIONS.includes(resolution)) return errorJson('resolution 无效', 400);

  const paidGenerationGuard = evaluatePaidGenerationGuard({ request, body, requestSource });
  if (!paidGenerationGuard.allowed) {
    return NextResponse.json(paidGenerationGuardError(paidGenerationGuard), { status: 403 });
  }

  const requestedProjectId = typeof body.project_id === 'string' && body.project_id.trim()
    ? body.project_id.trim()
    : null;
  const requestedVideoCardId = typeof body.video_card_id === 'string' && body.video_card_id.trim()
    ? body.video_card_id.trim()
    : typeof body.videoCardId === 'string' && body.videoCardId.trim()
      ? body.videoCardId.trim()
      : null;
  const requestedResolutionApprovalId = typeof body.resolution_approval_id === 'string' && body.resolution_approval_id.trim()
    ? body.resolution_approval_id.trim()
    : typeof body.resolutionApprovalId === 'string' && body.resolutionApprovalId.trim()
      ? body.resolutionApprovalId.trim()
      : null;
  const requestedVideoBranchId = typeof body.video_branch_id === 'string' && body.video_branch_id.trim()
    ? body.video_branch_id.trim()
    : typeof body.videoBranchId === 'string' && body.videoBranchId.trim()
      ? body.videoBranchId.trim()
      : null;

  if (!requestedVideoCardId) {
    return errorJson('必须先选择视频卡，生成任务才能写入项目成本闭环', 400);
  }

  const requestedVideoCard = await prisma.videoCard.findUnique({
    where: { id: requestedVideoCardId },
    select: { id: true, project_id: true },
  });
  if (!requestedVideoCard) {
    return errorJson('视频卡不存在', 404);
  }
  if (requestedProjectId && requestedProjectId !== requestedVideoCard.project_id) {
    return errorJson('视频卡不属于当前项目', 400);
  }

  let project;
  let videoCard;
  try {
    project = await getProjectForGeneration(user, requestedVideoCard.project_id);
    const videoCardAccess = await assertCanGenerateInVideoCard(user, project.id, requestedVideoCard.id);
    videoCard = videoCardAccess.videoCard;
  } catch (error) {
    if (error instanceof AuthError) return errorJson(error.message, error.status);
    throw error;
  }

  let generationTemplate: { id: string; status: string } | null = null;
  if (requestedTemplateId) {
    generationTemplate = await prisma.generationTemplate.findFirst({
      where: {
        id: requestedTemplateId,
        OR: user.role === 'admin' ? [{ status: { in: ['draft', 'active'] } }] : [{ status: 'active' }],
      },
      select: { id: true, status: true },
    });
    if (!generationTemplate) return errorJson('模板不存在或不可用', 404);
  }

  let agentRun: { id: string; template_id: string; user_id: string; video_card_id: string | null } | null = null;
  if (requestedAgentRunId) {
    agentRun = await prisma.agentRun.findUnique({
      where: { id: requestedAgentRunId },
      select: { id: true, template_id: true, user_id: true, video_card_id: true },
    });
    if (!agentRun) return errorJson('Agent 执行链路不存在', 404);
    if (agentRun.user_id !== user.id && user.role !== 'admin') return errorJson('Agent 执行链路不属于当前用户', 403);
    if (generationTemplate && agentRun.template_id !== generationTemplate.id) return errorJson('Agent 执行链路与当前模板不一致', 400);
    if (agentRun.video_card_id && agentRun.video_card_id !== videoCard.id) return errorJson('Agent 执行链路与当前视频卡不一致', 400);
    if (!generationTemplate) {
      generationTemplate = { id: agentRun.template_id, status: 'active' };
    }
  }

  if (project.type !== 'personal' && resolution === '1080p') {
    if (!resolutionApprovalConfirmed) {
      return errorJson('1080p 生成需要先确认审批通过', 403);
    }
    const baselineTaskId = videoCard.final_task_id || videoCard.current_best_task_id;
    const candidateCount = await prisma.videoTask.count({
      where: {
        video_card_id: videoCard.id,
        version_role: { in: ['candidate', 'current_best', 'final'] },
      },
    });
    if (!baselineTaskId && candidateCount === 0) {
      return errorJson('1080p 必须基于候选、当前最佳或最终版任务，不能在无基准版本的视频卡上直接生成', 403);
    }
    const approval = requestedResolutionApprovalId
      ? await prisma.approvalRecord.findFirst({
          where: {
            id: requestedResolutionApprovalId,
            type: 'resolution_1080p',
            status: 'approved',
            project_id: project.id,
            video_card_id: videoCard.id,
          },
        })
      : await prisma.$transaction((tx) => findUsableApproval(tx, {
          type: 'resolution_1080p',
          projectId: project.id,
          videoCardId: videoCard.id,
        }));
    if (!approval) {
      const rejectedApproval = await prisma.approvalRecord.findFirst({
        where: {
          type: 'resolution_1080p',
          status: 'rejected',
          project_id: project.id,
          video_card_id: videoCard.id,
        },
        orderBy: [{ rejected_at: 'desc' }, { created_at: 'desc' }],
        select: { decision_reason: true, reason: true },
      });
      if (rejectedApproval) {
        const reason = rejectedApproval.decision_reason || rejectedApproval.reason || '未填写原因';
        return errorJson(`1080p 审批已拒绝：${reason}`, 403);
      }
      return errorJson('未找到有效的 1080p 审批记录，请先在审批中心申请并通过审批', 403);
    }
    if (approval.video_card_id !== videoCard.id) {
      return errorJson('1080p 审批必须绑定当前视频卡，不能跨视频卡或使用项目级通配审批', 403);
    }
    if (approval.usage_limit !== null && approval.used_count >= approval.usage_limit) {
      return errorJson('1080p 审批额度已用尽，请重新申请', 403);
    }
    if (approval.expires_at && approval.expires_at <= new Date()) {
      return errorJson('1080p 审批已过期，请重新申请', 403);
    }
    if (!approval.task_id) {
      return errorJson('1080p 审批缺少基准任务，请重新申请', 403);
    }
    const approvalBaseTask = await prisma.videoTask.findUnique({
      where: { id: approval.task_id },
      select: { id: true, video_card_id: true, version_role: true },
    });
    if (
      !approvalBaseTask
      || approvalBaseTask.video_card_id !== videoCard.id
      || !['candidate', 'current_best', 'final'].includes(approvalBaseTask.version_role)
    ) {
      return errorJson('1080p 审批基准任务不属于当前视频卡候选/当前最佳/最终版', 403);
    }
  }

  if (videoCard.ratio_locked && videoCard.ratio && ratio !== videoCard.ratio) {
    return errorJson(`此视频卡已锁定比例 ${videoCard.ratio}，变更比例需要先通过比例变更审批`, 403);
  }

  let videoBranch: { id: string; title: string; status: string; is_primary: boolean } | null = null;
  if (requestedVideoBranchId) {
    const branch = await prisma.videoBranch.findUnique({
      where: { id: requestedVideoBranchId },
      select: { id: true, video_card_id: true, title: true, status: true, is_primary: true },
    });
    if (!branch || branch.video_card_id !== videoCard.id) {
      return errorJson('方向分支不属于当前视频卡', 400);
    }
    if (['closed', 'merged', 'promoted'].includes(branch.status)) {
      return errorJson('方向分支已关闭、合并或升格，不能继续生成', 403);
    }
    videoBranch = branch;
  }

  // --- Pricing ---
  const pricing = calculateEstimatedCost(resolution, duration);
  const estimatedCost = pricing.estimatedCost;
  const billingScope = shouldBillProjectBudget(project) ? 'project' : 'user';
  const billingAccountId = billingScope === 'project' ? project.id : user.id;

  // --- Idempotency ---
  const idempotencyKey: string | undefined = body.idempotency_key || undefined;
  if (idempotencyKey) {
    const existing = await prisma.videoTask.findUnique({
      where: { user_id_idempotency_key: { user_id: user.id, idempotency_key: idempotencyKey } },
    });
    if (existing) {
      if (existing.provider !== VOLCENGINE_IP_VIDEO_PROVIDER) {
        return errorJson('同一个幂等键已绑定到普通生成任务，不能用于 IP 生成', 409);
      }
      if (existing.video_card_id && existing.video_card_id !== videoCard.id) {
        return errorJson('同一个幂等键已绑定到其他视频卡', 409);
      }
      return ipDeduplicatedTaskResponse(existing);
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
  const cleanedSourceMetadata = cleanSourceMetadata(body.source_metadata);
  const clientName = cleanClientName(body.client_name);
  const isUltimateCanvasRequest = clientName === 'ultimate_canvas'
    || cleanedSourceMetadata.source === 'ultimate_canvas';
  const effectiveSourceLabel = isUltimateCanvasRequest ? '无线画布' : requestSource.source_label;
  const sourceMetadata: Record<string, unknown> = {
    ...requestSource.source_metadata,
    ...cleanedSourceMetadata,
    ...(isUltimateCanvasRequest ? { source: 'ultimate_canvas' } : {}),
    tab_id: tabId,
    idempotency_key: idempotencyKey || null,
    body_source_request_id: bodySourceRequestId,
    client_name: clientName,
    source_label: effectiveSourceLabel,
    requested_model: requestedModel,
    selected_model: selectedModel,
    admin_default_model: volcengineSettings.default_model,
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
        sourceLabel: effectiveSourceLabel,
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
    sourceLabel: effectiveSourceLabel,
    metadataSource: requestSource.source_type === 'codex_api' ? 'codex_api_workspace' : 'web_workspace',
  });
  if (workspaceReferenceBackfill.length > 0) {
    sourceMetadata.workspace_reference_backfill = workspaceReferenceBackfill.map((item) => ({
      asset_id: item.assetId,
      reference_image_id: item.referenceImageId,
    }));
  }

  let workspaceReferenceImageIds = uniquePreserveOrder(
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
    let missingFromWorkspace = requestedReferenceImageIds.filter((id) => !workspaceIdSet.has(id));
    if (missingFromWorkspace.length > 0 && isUltimateCanvasRequest) {
      const importedToWorkspace: Array<{
        asset_id: string;
        reference_image_id: string;
        workspace_asset_id: string;
      }> = [];

      for (const referenceImageId of missingFromWorkspace) {
        const image = await assertCanUseReferenceImage(user, referenceImageId);
        if (!image.asset_id) continue;
        const workspaceAssetId = await addAssetToWorkspace(
          workspaceId,
          image.asset_id,
          'reference_image',
          user.id,
          { referenceImageId: image.id, allowSharedAsset: true },
        );
        importedToWorkspace.push({
          asset_id: image.asset_id,
          reference_image_id: image.id,
          workspace_asset_id: workspaceAssetId,
        });
        workspaceIdSet.add(image.id);
      }

      if (importedToWorkspace.length > 0) {
        sourceMetadata.canvas_reference_workspace_import = importedToWorkspace;
        workspaceReferenceImageIds = uniquePreserveOrder([
          ...workspaceReferenceImageIds,
          ...importedToWorkspace.map((item) => item.reference_image_id),
        ]);
        missingFromWorkspace = requestedReferenceImageIds.filter((id) => !workspaceIdSet.has(id));
      }
    }

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

  let preparedImages: PreparedRefImage[];
  let prepareErrors: string[];
  let prepSummary: { total: number; publicUrl: number; r2Uploaded: number; skipped: number; hasLocalPath: boolean };
  try {
    ({ preparedImages, prepareErrors, summary: prepSummary } = await prepareReferenceImages(
      workspaceId,
      generationReferenceImageIds,
      requestedReferenceImageUrls,
    ));
  } catch (error) {
    console.error('[IpTasksCreate] Reference image preparation failed:', error);
    return NextResponse.json(
      {
        error: 'REFERENCE_IMAGE_PREP_FAILED',
        message: `参考图处理失败：${error instanceof Error ? error.message : '服务临时异常'}`,
      },
      { status: 400 },
    );
  }

  if (prepSummary.total > 0 && preparedImages.length === 0 && prepSummary.skipped > 0) {
    const referenceImageFailure = buildReferenceImagePreparationFailure(prepareErrors);
    return NextResponse.json(
      { error: referenceImageFailure.error, message: referenceImageFailure.message, details: { errors: prepareErrors } },
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
      if (!lastFrameUrl) lastFrameUrl = preparedImages[1]?.originalUrl;
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
  const content = buildVolcengineIpCreatePayload({
    ...providerInput,
    model: selectedModel,
  }).content;
  const snapshot = await createTaskSnapshot({
    workspaceId,
    generationMode,
    promptRaw: body.prompt,
    input: providerInput,
    providerPayloadJson: JSON.stringify({ content_item_count: content.length, referenceCount: preparedImages.length }),
  });
  const taskParams = {
    ratio, duration, resolution, seed,
    generateAudio, returnLastFrame, watermark, resolutionApprovalConfirmed,
    referenceAlbumIds: generationReferenceAlbumIds,
    referenceImageIds: generationReferenceImageIds,
    videoCardId: videoCard.id,
    videoBranchId: videoBranch?.id || null,
    templateId: generationTemplate?.id || null,
    agentRunId: agentRun?.id || null,
    selectedAgentPlanKey,
    promptUserEdited,
    preparedImages: preparedImages.map((img) => ({
      name: img.name,
      originalUrl: img.originalUrl,
      sourceType: img.sourceType,
      providerSafeResize: img.providerSafeResize,
    })),
    prepSummary,
    source: {
      type: requestSource.source_type,
      label: effectiveSourceLabel,
      requestId: sourceRequestId,
      paidGenerationGuard: paidGenerationGuard.metadata,
    },
  };

  // --- Credit check + freeze + create single VideoTask in ONE transaction ---
  let taskId: string;
  let createdTask!: {
    id: string;
    user_id: string | null;
    owner_user_id: string | null;
    project_id: string | null;
    video_card_id: string | null;
    provider: string;
    provider_task_id: string | null;
    model: string;
    resolution: string | null;
    duration: number | null;
    estimated_cost: number | null;
    pricing_rule_id: string | null;
    pricing_snapshot: string | null;
    billing_scope: string;
    billing_account_id: string | null;
  };
  try {
    const result = await prisma.$transaction(async (tx) => {
      const task = await tx.videoTask.create({
        data: {
          provider: VOLCENGINE_IP_VIDEO_PROVIDER,
          model: selectedModel,
          generation_mode: generationMode,
          prompt: body.prompt.trim(),
          source_type: requestSource.source_type,
          source_label: effectiveSourceLabel,
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
          video_card_id: videoCard.id,
          video_branch_id: videoBranch?.id || null,
          template_id: generationTemplate?.id || null,
          agent_run_id: agentRun?.id || null,
          selected_agent_plan_key: selectedAgentPlanKey,
          agent_prompt_snapshot: agentPromptSnapshot,
          final_prompt_snapshot: finalPromptSnapshot,
          prompt_user_edited: promptUserEdited,
          visibility: project.type === 'personal' ? 'private' : 'project',
          estimated_cost: estimatedCost,
          frozen_cost: estimatedCost,
          pricing_snapshot: JSON.stringify(pricing),
          pricing_rule_id: pricing.pricingRuleId,
          idempotency_key: idempotencyKey || null,
          billing_scope: billingScope,
          billing_account_id: billingAccountId,
          workspace_id: workspaceId,
          snapshot_id: snapshot.id,
          params_json: JSON.stringify(taskParams),
        },
      });

      if (project.type !== 'personal' && resolution === '1080p') {
        const approval = requestedResolutionApprovalId
          ? await tx.approvalRecord.findFirst({
              where: {
                id: requestedResolutionApprovalId,
                type: 'resolution_1080p',
                status: 'approved',
                project_id: project.id,
                video_card_id: videoCard.id,
              },
            })
          : await findUsableApproval(tx, {
              type: 'resolution_1080p',
              projectId: project.id,
              videoCardId: videoCard.id,
            });
        if (!approval) throw new Error('未找到可用的 1080p 审批额度');
        if (approval.video_card_id !== videoCard.id) throw new Error('1080p 审批必须绑定当前视频卡');
        if (!approval.task_id) throw new Error('1080p 审批缺少基准任务');
        const baseTask = await tx.videoTask.findUnique({
          where: { id: approval.task_id },
          select: { id: true, video_card_id: true, version_role: true },
        });
        if (
          !baseTask
          || baseTask.video_card_id !== videoCard.id
          || !['candidate', 'current_best', 'final'].includes(baseTask.version_role)
        ) {
          throw new Error('1080p 审批基准任务不属于当前视频卡候选/当前最佳/最终版');
        }
        await consumeApprovalForTask(tx, {
          approvalId: approval.id,
          taskId: task.id,
          userId: user.id,
          metadata: {
            project_id: project.id,
            video_card_id: videoCard.id,
            baseline_task_id: approval.task_id,
            resolution,
            estimated_cost: estimatedCost,
          },
        });
        await tx.videoTask.update({
          where: { id: task.id },
          data: {
            params_json: JSON.stringify({
              ...taskParams,
              resolutionApprovalId: approval.id,
              resolutionApprovalBaselineTaskId: approval.task_id,
            }),
          },
        });
      }

      let freezeSnapshot: string;
      try {
        if (billingScope === 'project') {
          const freeze = await allocateProjectTaskBudget(tx, {
            projectId: project.id,
            taskId: task.id,
            amount: estimatedCost,
            operatorId: user.id,
          });
          freezeSnapshot = freeze.snapshot;
        } else {
          const freeze = await allocateTaskCredits(tx, {
            id: user.id,
            role: user.role,
            account_type: user.account_type,
            user_profile: user.user_profile,
            status: user.status,
          }, estimatedCost, task.id);
          freezeSnapshot = freeze.snapshot;

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
              metadata_json: JSON.stringify({ allocations: freeze.allocations, source_metadata: sourceMetadata }),
            },
          });
        }
      } catch (error) {
        throw new CreditError(
          error instanceof Error ? error.message : billingScope === 'project' ? '项目预算不足' : '点数不足',
          billingScope === 'project' ? 'INSUFFICIENT_PROJECT_BUDGET' : 'INSUFFICIENT_CREDITS',
        );
      }

      await tx.videoTask.update({
        where: { id: task.id },
        data: { credit_freeze_snapshot: freezeSnapshot },
      });

      await tx.operationLog.create({
        data: {
          operator_id: user.id,
          action: requestSource.source_type === 'codex_api' ? 'generation_create_codex_api' : 'generation_create',
          target_type: 'VideoTask',
          target_id: task.id,
          detail: JSON.stringify({
            project_id: project.id,
            video_card_id: videoCard.id,
            template_id: generationTemplate?.id || null,
            agent_run_id: agentRun?.id || null,
            selected_agent_plan_key: selectedAgentPlanKey,
            owner_user_id: user.id,
            estimated_cost: estimatedCost,
            billing_scope: billingScope,
            billing_account_id: billingAccountId,
            reference_album_ids: generationReferenceAlbumIds,
            reference_image_ids: generationReferenceImageIds,
            source_type: requestSource.source_type,
            source_label: effectiveSourceLabel,
            source_request_id: sourceRequestId,
            source_metadata: sourceMetadata,
            paid_generation_guard: paidGenerationGuard.metadata,
          }),
        },
      });

      await recordTaskCostEstimate(tx, task, pricing, user.id);

      if (agentRun) {
        await tx.agentRun.update({
          where: { id: agentRun.id },
          data: {
            video_task_id: task.id,
            video_card_id: videoCard.id,
            status: 'submitted',
            selected_plan_key: selectedAgentPlanKey || undefined,
            final_prompt_snapshot: finalPromptSnapshot,
            user_edited: promptUserEdited,
          },
        });
        if (selectedAgentPlanKey) {
          await tx.templateMemory.create({
            data: {
              template_id: generationTemplate?.id || agentRun.template_id,
              user_id: user.id,
              agent_run_id: agentRun.id,
              video_task_id: task.id,
              memory_type: 'plan_selected',
              signal: 'positive',
              summary: `用户选择了方案 ${selectedAgentPlanKey}`,
              metadata_json: JSON.stringify({ planKey: selectedAgentPlanKey, prompt_user_edited: promptUserEdited }),
            },
          });
        }
      }

      return task;
    });

    taskId = result.id;
    createdTask = result;
  } catch (err) {
    if (idempotencyKey && isPrismaUniqueConstraintError(err)) {
      const existing = await prisma.videoTask.findUnique({
        where: { user_id_idempotency_key: { user_id: user.id, idempotency_key: idempotencyKey } },
      });
      if (existing) {
        if (existing.provider !== VOLCENGINE_IP_VIDEO_PROVIDER) {
          return errorJson('同一个幂等键已绑定到普通生成任务，不能用于 IP 生成', 409);
        }
        if (existing.video_card_id && existing.video_card_id !== videoCard.id) {
          return errorJson('同一个幂等键已绑定到其他视频卡', 409);
        }
        return ipDeduplicatedTaskResponse(existing);
      }
    }
    if (err instanceof CreditError) {
      if (err.code === 'INSUFFICIENT_PROJECT_BUDGET') {
        await prisma.$transaction((tx) => notifyProjectOwner(tx, {
          projectId: project.id,
          actorUserId: user.id,
          type: 'project_budget_insufficient',
          title: '项目预算不足',
          body: err.message,
          metadata: {
            attempted_cost: estimatedCost,
            video_card_id: videoCard.id,
          },
        })).catch((notificationError) => {
          console.error('[TasksCreate] Failed to notify project budget shortage:', notificationError);
        });
      }
      return NextResponse.json({ error: err.code, message: err.message }, { status: 400 });
    }
    throw err;
  }

  // --- Call Volcengine Ark provider DIRECTLY (no internal HTTP) ---
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
      endpoint: 'volcengine_ip.createContentsGenerationsTask',
      method: 'POST',
      idempotencyKey: idempotencyKey || null,
      requestPayload: {
        ...providerInput,
        model: selectedModel,
        source: {
          type: requestSource.source_type,
          label: effectiveSourceLabel,
          requestId: sourceRequestId,
          paidGenerationGuard: paidGenerationGuard.metadata,
        },
      },
    });
    providerRequestId = providerRequest.id;

    const providerResult = await createVolcengineIpVideoTask({
      ...providerInput,
      model: selectedModel,
    });

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

    if (agentRun) {
      await prisma.$transaction(async (tx) => {
        await tx.agentRun.update({
          where: { id: agentRun.id },
          data: {
            status: 'submitted',
            video_task_id: taskId,
            final_prompt_snapshot: finalPromptSnapshot,
            user_edited: promptUserEdited,
          },
        });
        await tx.agentRunStep.create({
          data: {
            agent_run_id: agentRun.id,
            step_key: 'volcengine_ip_submit',
            title: '火山 IP 执行',
            input_json: JSON.stringify({ task_id: taskId, template_id: generationTemplate?.id || null }),
            output_json: JSON.stringify({ provider_task_id: providerResult.provider_task_id, status: 'submitted' }),
            sort_order: 6,
          },
        });
        await tx.templateMemory.create({
          data: {
            template_id: generationTemplate?.id || agentRun.template_id,
            user_id: user.id,
            agent_run_id: agentRun.id,
            video_task_id: taskId,
            memory_type: 'task_result',
            signal: 'neutral',
            summary: '任务已提交火山 IP 生成接口，等待生成结果回写',
            metadata_json: JSON.stringify({ provider_task_id: providerResult.provider_task_id }),
          },
        });
      });
    }

    startTaskLocalization(taskId);
    const referenceImageResizeSummary = buildReferenceImageResizeSummary(preparedImages);

    return NextResponse.json({
      id: taskId,
      provider_task_id: providerResult.provider_task_id,
      status: 'submitted',
      estimated_cost: estimatedCost,
      frozen_cost: estimatedCost,
      pricing,
      workspace_id: workspaceId,
      project_id: project.id,
      video_card_id: videoCard.id,
      template_id: generationTemplate?.id || null,
      agent_run_id: agentRun?.id || null,
      selected_agent_plan_key: selectedAgentPlanKey,
      billing_scope: billingScope,
      billing_account_id: billingAccountId,
      snapshot_id: snapshot.id,
      prompt_rendered: promptRendered,
      asset_mapping: assetMapping,
      reference_album_ids: generationReferenceAlbumIds,
      reference_image_ids: generationReferenceImageIds,
      reference_image_notice: referenceImageResizeSummary
        ? `已自动把 ${referenceImageResizeSummary.resized_count} 张过大的参考图压缩到平台允许尺寸，原图不会被修改。`
        : null,
      reference_image_resize_summary: referenceImageResizeSummary,
      source_type: requestSource.source_type,
      source_label: effectiveSourceLabel,
      source_request_id: sourceRequestId,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    const providerErrorMessage = volcengineProviderErrorMessage(err);
    const providerErrorCode = volcengineProviderErrorCode(err);
    const providerHttpStatus = volcengineProviderHttpStatus(err);
    const userFacingProviderMessage = isProviderReferenceImageSizeError(providerErrorMessage)
      ? `${providerReferenceImageSizeMessage(providerErrorMessage)} 已返还冻结点数。`
      : `${providerErrorMessage}，已返还冻结点数`;
    if (providerRequestId) {
      await markProviderApiRequestFailed({
        requestId: providerRequestId,
        errorCode: providerErrorCode,
        errorMessage: providerErrorMessage,
      }).catch(() => {});
    }
    await handleProviderFailure(
      taskId,
      user.id,
      estimatedCost,
      providerErrorMessage,
    );
    if (agentRun) {
      await prisma.$transaction(async (tx) => {
        await tx.agentRun.update({
          where: { id: agentRun.id },
          data: {
            status: 'failed',
            error_message: providerErrorMessage,
            completed_at: new Date(),
          },
        });
        await tx.agentRunStep.create({
          data: {
            agent_run_id: agentRun.id,
            step_key: 'volcengine_ip_failed',
            title: '火山 IP 执行失败',
            input_json: JSON.stringify({ task_id: taskId }),
            output_json: JSON.stringify({ error: providerErrorMessage }),
            sort_order: 6,
          },
        });
        await tx.templateMemory.create({
          data: {
            template_id: generationTemplate?.id || agentRun.template_id,
            user_id: user.id,
            agent_run_id: agentRun.id,
            video_task_id: taskId,
            memory_type: 'task_result',
            signal: 'negative',
            summary: '火山 IP 提交失败，已返还冻结点数',
            metadata_json: JSON.stringify({ error: providerErrorMessage }),
          },
        });
      }).catch(() => {});
    }
    return NextResponse.json(
      {
        error: 'PROVIDER_CREATE_FAILED',
        message: userFacingProviderMessage,
        task_id: taskId,
      },
      { status: providerHttpStatus },
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

    const consumedApprovals = await tx.approvalUsage.findMany({
      where: { task_id: taskId },
      select: { approval_id: true },
    });
    if (consumedApprovals.length > 0) {
      await tx.approvalUsage.deleteMany({ where: { task_id: taskId } });
      for (const usage of consumedApprovals) {
        await tx.approvalRecord.updateMany({
          where: { id: usage.approval_id, used_count: { gt: 0 } },
          data: { used_count: { decrement: 1 } },
        });
      }
    }

    await tx.videoTask.update({
      where: { id: taskId },
      data: {
        local_status: 'failed',
        error_message: errorMessage,
        error_code: 'PROVIDER_CREATE_FAILED',
        completed_at: new Date(),
      },
    });

    if (taskBeforeSettlement.billing_scope === 'project' && taskBeforeSettlement.project_id) {
      const settlement = await settleProjectTaskBudget(tx, {
        projectId: taskBeforeSettlement.project_id,
        taskId,
        terminalStatus: 'failed',
        frozenAmount,
        freezeSnapshot: taskBeforeSettlement.credit_freeze_snapshot,
        operatorId: userId,
      });

      const failedTask = await tx.videoTask.update({
        where: { id: taskId },
        data: {
          frozen_cost: 0,
          actual_cost: 0,
          refund_amount: settlement.refundedAmount,
        },
      });

      await recordTaskCostSettlement(tx, failedTask, 'failed', userId);
      return;
    }

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
          source_metadata: parseJsonRecord(taskBeforeSettlement.source_metadata_json),
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
  providerSafeResize?: {
    originalWidth?: number;
    originalHeight?: number;
    outputWidth?: number;
    outputHeight?: number;
    originalPixels?: number;
    maxPixels?: number;
  };
}

function buildReferenceImageResizeSummary(preparedImages: PreparedRefImage[]) {
  const resizedItems = preparedImages.filter((image) => image.providerSafeResize);
  if (resizedItems.length === 0) return null;
  return {
    resized_count: resizedItems.length,
    max_pixels: PROVIDER_REFERENCE_IMAGE_MAX_PIXELS,
    items: resizedItems.map((image) => ({
      name: image.name,
      original_width: image.providerSafeResize?.originalWidth ?? null,
      original_height: image.providerSafeResize?.originalHeight ?? null,
      output_width: image.providerSafeResize?.outputWidth ?? null,
      output_height: image.providerSafeResize?.outputHeight ?? null,
      original_pixels: image.providerSafeResize?.originalPixels ?? null,
      max_pixels: image.providerSafeResize?.maxPixels ?? PROVIDER_REFERENCE_IMAGE_MAX_PIXELS,
    })),
  };
}

function buildReferenceImagePreparationFailure(prepareErrors: string[]) {
  const joinedErrors = prepareErrors.join('；');
  if (isProviderReferenceImageSizeError(joinedErrors)) {
    return {
      error: 'REFERENCE_IMAGE_TOO_LARGE',
      message: '参考图尺寸过大，系统已尝试自动压缩到合规尺寸，但这张图处理失败。请换一张更小的图，或先压缩后再提交。',
    };
  }
  return {
    error: 'REFERENCE_IMAGE_NOT_PUBLIC',
    message: '参考图无法生成公网 URL，请换一张可访问的图片后重试。',
  };
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

  let imageItems: Array<{
    asset: {
      id: string;
      file_name: string | null;
      original_url: string;
      type: string;
      width: number | null;
      height: number | null;
      mime_type: string | null;
    } | null;
    originalUrl: string;
  }> = [];

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
        width: asset.width,
        height: asset.height,
        mime_type: asset.mime_type,
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
        width: item.asset.width,
        height: item.asset.height,
        mime_type: item.asset.mime_type,
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
      let providerUrl = originalUrl;
      let sourceType: PreparedRefImage['sourceType'] = isR2 ? 'upload' : 'external';
      let providerSafeResize: PreparedRefImage['providerSafeResize'];
      if (item.asset) {
        const shouldResize = Boolean(getProviderSafeImageResizeDimensions(item.asset.width, item.asset.height));
        try {
          const safeReference = await ensureProviderSafeReferenceImageUrl({ originalUrl, asset: item.asset });
          providerUrl = safeReference.providerUrl;
          if (safeReference.resized) {
            r2Uploaded += 1;
            sourceType = 'upload';
            providerSafeResize = {
              originalWidth: safeReference.width,
              originalHeight: safeReference.height,
              outputWidth: safeReference.outputWidth,
              outputHeight: safeReference.outputHeight,
              originalPixels: safeReference.originalPixels,
              maxPixels: safeReference.maxPixels,
            };
          }
        } catch (error) {
          skipped += 1;
          const rawMessage = error instanceof Error ? error.message : String(error);
          const message = shouldResize || isProviderReferenceImageSizeError(rawMessage)
            ? providerReferenceImageSizeMessage(rawMessage)
            : `参考图处理失败: ${rawMessage}`;
          prepareErrors.push(`[${i + 1}] ${message}`);
          continue;
        }
      }
      publicUrl += 1;
      preparedImages.push({
        name: item.asset?.file_name || `图${i + 1}`,
        originalUrl: providerUrl,
        sourceType,
        order: i,
        providerSafeResize,
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
