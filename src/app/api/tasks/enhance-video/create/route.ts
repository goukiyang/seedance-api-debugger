import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { readFile, stat } from 'fs/promises';
import type { VideoTask } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getSessionUser, errorJson } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { assertCanViewTask, getProjectForGeneration } from '@/lib/projects/permissions';
import { assertCanGenerateInVideoCard } from '@/lib/video-cards/permissions';
import { calculateEnhanceVideoEstimatedCost } from '@/lib/pricing';
import { allocateTaskCredits, settleTaskCredits } from '@/lib/credits/policy';
import {
  allocateProjectTaskBudget,
  settleProjectTaskBudget,
  shouldBillProjectBudget,
} from '@/lib/projects/budget';
import {
  createProviderApiRequest,
  markProviderApiRequestAccepted,
  markProviderApiRequestFailed,
  recordTaskCostEstimate,
  recordTaskCostSettlement,
} from '@/lib/costs/ledger';
import {
  createEnhanceVideoTask,
  redactAiMediaKitLog,
  requestMediaUploadUrl,
  uploadMediaToAiMediaKit,
} from '@/lib/provider/aimediakit-enhance-video';
import {
  aiMediaKitSettingsToRequestOptions,
  getAiMediaKitApiSettings,
  isAiMediaKitApiReady,
} from '@/lib/integrations/aimediakit';
import {
  assertEnhanceVideoSourceTaskAllowed,
  buildEnhanceVideoProviderInput,
  normalizeEnhanceVideoCreateBody,
  validateEnhanceVideoUrl,
} from '@/lib/tasks/enhance-video-create';
import { startTaskLocalization } from '@/lib/video/task-localization-runner';

const LOCAL_UPLOAD_SAFE_MAX_BYTES = 512 * 1024 * 1024;

type SourceTask = Pick<VideoTask,
  | 'id'
  | 'provider'
  | 'provider_task_id'
  | 'generation_mode'
  | 'prompt'
  | 'local_status'
  | 'result_video_url'
  | 'local_video_path'
  | 'duration'
  | 'resolution'
  | 'ratio'
  | 'project_id'
  | 'video_card_id'
  | 'owner_user_id'
  | 'user_id'
  | 'retention_status'
>;

class CreditError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

function jsonError(message: string, status = 400, code = 'ENHANCE_VIDEO_CREATE_FAILED') {
  return NextResponse.json({ error: code, message }, { status });
}

function publicVideoFilePath(localVideoPath: string) {
  if (!localVideoPath.startsWith('/videos/')) {
    throw new Error('本地视频路径不在 public/videos 目录');
  }
  const publicDir = path.resolve(process.cwd(), 'public');
  const videosDir = path.resolve(publicDir, 'videos');
  const absolutePath = path.resolve(publicDir, localVideoPath.replace(/^\/+/, ''));
  if (!absolutePath.startsWith(`${videosDir}${path.sep}`)) {
    throw new Error('本地视频路径无效');
  }
  return absolutePath;
}

async function uploadLocalVideoForEnhance(
  task: SourceTask,
  providerOptions: { apiKey?: string; baseUrl?: string },
) {
  if (!task.local_video_path) return null;

  const filePath = publicVideoFilePath(task.local_video_path);
  const info = await stat(filePath);
  if (!info.isFile() || info.size <= 0) {
    throw new Error('本地视频文件不可读');
  }
  if (info.size > LOCAL_UPLOAD_SAFE_MAX_BYTES) {
    throw new Error('本地视频超过当前服务端安全上传上限，请改用公网视频 URL');
  }

  const fileName = path.basename(filePath) || `${task.id}.mp4`;
  const uploadTicket = await requestMediaUploadUrl({
    file_name: fileName,
    content_type: 'video/mp4',
    content_length: info.size,
    media_type: 'video',
    client_token: `enhance-upload:${task.id}`,
  }, providerOptions);
  const file = await readFile(filePath);
  await uploadMediaToAiMediaKit({
    upload_url: uploadTicket.upload_url,
    method: uploadTicket.method,
    upload_headers: uploadTicket.upload_headers,
    body: new Blob([new Uint8Array(file)], { type: 'video/mp4' }),
  });

  return uploadTicket.file_id;
}

async function resolveSourceVideoUrl(
  task: SourceTask,
  providerOptions: { apiKey?: string; baseUrl?: string },
) {
  if (task.result_video_url) {
    try {
      return validateEnhanceVideoUrl(task.result_video_url);
    } catch {
      // Provider 临时 URL 不可用时，继续尝试本地缓存上传。
    }
  }

  const uploaded = await uploadLocalVideoForEnhance(task, providerOptions);
  if (uploaded) return uploaded;

  throw new Error('源任务没有可用于超分的视频 URL 或本地缓存文件');
}

async function releaseFrozenCreditsAfterProviderFailure(
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
        data: { frozen_cost: 0, actual_cost: 0, refund_amount: settlement.refundedAmount },
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
      data: { frozen_cost: 0, actual_cost: 0, refund_amount: settlement.refundedAmount },
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
        reason: `超分任务创建失败，返还冻结 ${settlement.refundedAmount} 点`,
        metadata_json: JSON.stringify({
          allocations: settlement.allocations,
          expired_closed: settlement.expiredClosedAmount,
        }),
      },
    });

    await recordTaskCostSettlement(tx, failedTask, 'failed', userId);
  });
}

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await getSessionUser(request);
  } catch {
    return errorJson('请先登录后再创建超分任务', 401);
  }
  if (user.status !== 'active') {
    return errorJson('账号已被禁用，无法创建超分任务', 403);
  }
  const aiMediaKitSettings = await getAiMediaKitApiSettings();
  if (!isAiMediaKitApiReady(aiMediaKitSettings)) {
    return errorJson('请先到 API 设置启用 AI MediaKit 并保存 API Key', 500);
  }
  const aiMediaKitRequestOptions = aiMediaKitSettingsToRequestOptions(aiMediaKitSettings);

  let body;
  try {
    body = normalizeEnhanceVideoCreateBody(await request.json());
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : '请求参数无效', 400, 'INVALID_REQUEST');
  }

  let sourceTask: SourceTask | null = null;
  let sourceVideoUrl = body.videoUrl;
  if (body.sourceTaskId) {
    sourceTask = await prisma.videoTask.findUnique({
      where: { id: body.sourceTaskId },
      select: {
        id: true,
        provider: true,
        provider_task_id: true,
        generation_mode: true,
        prompt: true,
        local_status: true,
        result_video_url: true,
        local_video_path: true,
        duration: true,
        resolution: true,
        ratio: true,
        project_id: true,
        video_card_id: true,
        owner_user_id: true,
        user_id: true,
        retention_status: true,
      },
    });
    if (!sourceTask) return jsonError('源任务不存在', 404, 'SOURCE_TASK_NOT_FOUND');
    try {
      await assertCanViewTask(user, sourceTask);
    } catch (error) {
      if (error instanceof AuthError) return jsonError(error.message, error.status, 'SOURCE_TASK_FORBIDDEN');
      throw error;
    }
    if (sourceTask.local_status !== 'succeeded') {
      return jsonError('源任务还没有成功产出视频，不能发起超分', 400, 'SOURCE_TASK_NOT_READY');
    }
    try {
      assertEnhanceVideoSourceTaskAllowed(sourceTask);
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : '源任务不支持超分', 400, 'SOURCE_TASK_UNSUPPORTED');
    }
  } else if (body.videoUrl) {
    sourceVideoUrl = body.videoUrl;
  } else {
    return jsonError('必须提供 source_task_id 或 video_url', 400, 'INVALID_REQUEST');
  }

  const videoCardId = body.videoCardId || sourceTask?.video_card_id || null;
  if (!videoCardId) {
    return jsonError('必须提供 video_card_id，超分任务需要写入项目和视频卡成本闭环', 400, 'VIDEO_CARD_REQUIRED');
  }

  const requestedVideoCard = await prisma.videoCard.findUnique({
    where: { id: videoCardId },
    select: { id: true, project_id: true },
  });
  if (!requestedVideoCard) return jsonError('视频卡不存在', 404, 'VIDEO_CARD_NOT_FOUND');
  if (sourceTask?.project_id && sourceTask.project_id !== requestedVideoCard.project_id) {
    return jsonError('首版不支持把其他项目的源任务超分到当前视频卡', 400, 'CROSS_PROJECT_ENHANCE_UNSUPPORTED');
  }

  let project;
  let videoCard;
  try {
    project = await getProjectForGeneration(user, requestedVideoCard.project_id);
    const videoCardAccess = await assertCanGenerateInVideoCard(user, project.id, requestedVideoCard.id);
    videoCard = videoCardAccess.videoCard;
  } catch (error) {
    if (error instanceof AuthError) return jsonError(error.message, error.status, 'PROJECT_FORBIDDEN');
    throw error;
  }

  const duration = body.durationSeconds || sourceTask?.duration || null;
  if (!duration) {
    return jsonError('无法确认源视频时长，请传入 duration 后再创建超分任务', 400, 'DURATION_REQUIRED');
  }

  const pricing = calculateEnhanceVideoEstimatedCost({
    duration,
    resolution: body.resolution,
    toolVersion: body.toolVersion,
    fps: body.fps,
  });
  const estimatedCost = pricing.estimatedCost;
  const billingScope = shouldBillProjectBudget(project) ? 'project' : 'user';
  const billingAccountId = billingScope === 'project' ? project.id : user.id;
  const idempotencyKey = body.idempotencyKey || undefined;

  if (idempotencyKey) {
    const existing = await prisma.videoTask.findUnique({
      where: { user_id_idempotency_key: { user_id: user.id, idempotency_key: idempotencyKey } },
    });
    if (existing) {
      if (existing.video_card_id && existing.video_card_id !== videoCard.id) {
        return jsonError('同一个幂等键已绑定到其他视频卡', 409, 'IDEMPOTENCY_CONFLICT');
      }
      return NextResponse.json({
        id: existing.id,
        provider_task_id: existing.provider_task_id,
        status: existing.local_status,
        estimated_cost: existing.estimated_cost,
        frozen_cost: existing.frozen_cost,
        deduplicated: true,
        project_id: existing.project_id,
        video_card_id: existing.video_card_id,
        billing_scope: existing.billing_scope,
        billing_account_id: existing.billing_account_id,
        created_at: existing.created_at,
      });
    }
  }

  if (sourceTask) {
    try {
      sourceVideoUrl = await resolveSourceVideoUrl(sourceTask, aiMediaKitRequestOptions);
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : '源视频不可用', 400, 'SOURCE_VIDEO_UNAVAILABLE');
    }
  }
  if (!sourceVideoUrl) {
    return jsonError('源视频不可用', 400, 'SOURCE_VIDEO_UNAVAILABLE');
  }

  let createdTask: VideoTask;
  try {
    createdTask = await prisma.$transaction(async (tx) => {
      const task = await tx.videoTask.create({
        data: {
          provider: 'volcengine_mediakit',
          model: 'enhance-video',
          generation_mode: 'enhance_video',
          prompt: sourceTask
            ? `视频超分/画质增强：${sourceTask.prompt.slice(0, 80) || sourceTask.id}`
            : '视频超分/画质增强：外部视频 URL',
          source_type: 'web',
          source_label: 'AI MediaKit 视频超分',
          source_request_id: idempotencyKey || null,
          source_metadata_json: JSON.stringify({
            source_task_id: sourceTask?.id || null,
            source_provider: sourceTask?.provider || null,
            source_provider_task_id: sourceTask?.provider_task_id || null,
          }),
          ratio: sourceTask?.ratio || null,
          duration,
          resolution: body.resolution,
          seed: -1,
          generate_audio: false,
          return_last_frame: false,
          watermark: false,
          local_status: 'submitted',
          user_id: user.id,
          owner_user_id: user.id,
          project_id: project.id,
          video_card_id: videoCard.id,
          visibility: project.type === 'personal' ? 'private' : 'project',
          estimated_cost: estimatedCost,
          frozen_cost: estimatedCost,
          pricing_snapshot: JSON.stringify(pricing),
          pricing_rule_id: pricing.pricingRuleId,
          idempotency_key: idempotencyKey || null,
          billing_scope: billingScope,
          billing_account_id: billingAccountId,
          params_json: JSON.stringify({
            source_task_id: sourceTask?.id || null,
            source_video_kind: sourceVideoUrl.split(':', 1)[0],
            tool_version: body.toolVersion,
            scene: body.scene,
            resolution: body.resolution,
            fps: body.fps,
            duration,
            pricing,
          }),
        },
      });

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
              reason: `超分任务创建冻结 ${estimatedCost} 点`,
              metadata_json: JSON.stringify({ allocations: freeze.allocations }),
            },
          });
        }
      } catch (error) {
        throw new CreditError(
          error instanceof Error ? error.message : billingScope === 'project' ? '项目预算不足' : '点数不足',
          billingScope === 'project' ? 'INSUFFICIENT_PROJECT_BUDGET' : 'INSUFFICIENT_CREDITS',
        );
      }

      const updatedTask = await tx.videoTask.update({
        where: { id: task.id },
        data: { credit_freeze_snapshot: freezeSnapshot },
      });
      await tx.operationLog.create({
        data: {
          operator_id: user.id,
          action: 'enhance_video_create',
          target_type: 'VideoTask',
          target_id: task.id,
          detail: JSON.stringify({
            project_id: project.id,
            video_card_id: videoCard.id,
            source_task_id: sourceTask?.id || null,
            estimated_cost: estimatedCost,
            billing_scope: billingScope,
          }),
        },
      });
      await recordTaskCostEstimate(tx, updatedTask, pricing, user.id);
      return updatedTask;
    });
  } catch (error) {
    if (error instanceof CreditError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: 400 });
    }
    throw error;
  }

  const providerInput = buildEnhanceVideoProviderInput({
    videoUrl: sourceVideoUrl,
    toolVersion: body.toolVersion,
    scene: body.scene,
    resolution: body.resolution,
    fps: body.fps,
    clientToken: createdTask.id,
  });
  let providerRequestId: string | null = null;
  try {
    await prisma.videoTask.update({
      where: { id: createdTask.id },
      data: {
        provider_client_request_id: createdTask.id,
        provider_payload_json: JSON.stringify(redactAiMediaKitLog(providerInput)),
      },
    });

    const providerRequest = await createProviderApiRequest({
      task: createdTask,
      endpoint: 'aimediakit.enhanceVideo',
      method: 'POST',
      idempotencyKey: idempotencyKey || null,
      requestPayload: redactAiMediaKitLog(providerInput),
    });
    providerRequestId = providerRequest.id;

    const providerResult = await createEnhanceVideoTask(providerInput, aiMediaKitRequestOptions);
    await prisma.videoTask.update({
      where: { id: createdTask.id },
      data: {
        provider_task_id: providerResult.provider_task_id,
        raw_create_response: JSON.stringify(redactAiMediaKitLog(providerResult.raw)),
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

    startTaskLocalization(createdTask.id);

    return NextResponse.json({
      id: createdTask.id,
      provider_task_id: providerResult.provider_task_id,
      status: 'submitted',
      provider: 'volcengine_mediakit',
      model: 'enhance-video',
      generation_mode: 'enhance_video',
      estimated_cost: estimatedCost,
      frozen_cost: estimatedCost,
      pricing,
      project_id: project.id,
      video_card_id: videoCard.id,
      source_task_id: sourceTask?.id || null,
      billing_scope: billingScope,
      billing_account_id: billingAccountId,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? redactAiMediaKitLog(error.message) : 'AI MediaKit 调用异常';
    if (providerRequestId) {
      await markProviderApiRequestFailed({
        requestId: providerRequestId,
        errorCode: 'PROVIDER_CREATE_FAILED',
        errorMessage,
      }).catch(() => {});
    }
    await releaseFrozenCreditsAfterProviderFailure(createdTask.id, user.id, estimatedCost, errorMessage);
    return NextResponse.json(
      {
        error: 'PROVIDER_CREATE_FAILED',
        message: '视频超分服务异常，已返还冻结点数',
        task_id: createdTask.id,
      },
      { status: 502 },
    );
  }
}
