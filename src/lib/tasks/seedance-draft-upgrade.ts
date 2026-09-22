import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { calculateEstimatedCost } from '@/lib/pricing';
import { assertCanGenerateInVideoCard } from '@/lib/video-cards/permissions';
import { getProjectForGeneration } from '@/lib/projects/permissions';
import { consumeApprovalForTask, findUsableApproval } from '@/lib/approvals';
import { allocateTaskCredits, settleTaskCredits } from '@/lib/credits/policy';
import { allocateProjectTaskBudget, settleProjectTaskBudget, shouldBillProjectBudget } from '@/lib/projects/budget';
import {
  createProviderApiRequest,
  markProviderApiRequestAccepted,
  markProviderApiRequestFailed,
  recordTaskCostEstimate,
  recordTaskCostSettlement,
} from '@/lib/costs/ledger';
import {
  createSeedanceDraftUpgradeTask,
  getVideoTaskStatusByClientRequestId,
} from '@/lib/provider/jimeng';
import {
  buildSeedanceDraftUpgradePayload,
  isSeedanceDraftUpgradeEnabled,
  SEEDANCE_DRAFT_CONTRACT_VERSION,
} from '@/lib/provider/seedance-draft';
import { SEEDANCE_2_5_MODEL_ID } from '@/lib/provider/seedance-models';
import { startTaskLocalization } from '@/lib/video/task-localization-runner';

export class DraftUpgradeError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = 'DRAFT_UPGRADE_FAILED',
  ) {
    super(message);
  }
}

export type DraftUpgradeInput = {
  user: SessionUser;
  draftTaskId: string;
  resolutionApprovalConfirmed: boolean;
  resolutionApprovalId?: string | null;
  idempotencyKey?: string | null;
  sourceType?: 'web' | 'codex_api';
  sourceLabel?: string | null;
  sourceRequestId?: string | null;
};

type DraftTaskForUpgrade = {
  id: string;
  provider: string;
  model: string;
  generation_mode: string;
  prompt: string;
  ratio: string | null;
  duration: number | null;
  seed: number | null;
  generate_audio: boolean;
  return_last_frame: boolean;
  watermark: boolean;
  reference_image_urls: string | null;
  reference_video_urls: string | null;
  reference_audio_urls: string | null;
  first_frame_url: string | null;
  last_frame_url: string | null;
  frame_image_urls: string | null;
  workspace_id: string | null;
  project_id: string | null;
  video_card_id: string | null;
  owner_user_id: string | null;
  user_id: string | null;
  local_status: string;
  is_draft: boolean;
  provider_draft_task_id: string | null;
  retention_status: string;
};

function isAmbiguousProviderError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /超时|timeout|timed out|fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message);
}

function isValidApprovalBase(task: { id: string; video_card_id: string | null; version_role: string }, draft: DraftTaskForUpgrade, videoCardId: string) {
  return task.video_card_id === videoCardId
    && (['candidate', 'current_best', 'final'].includes(task.version_role) || task.id === draft.id);
}

async function findApprovalForUpgrade(input: {
  projectId: string;
  videoCardId: string;
  draft: DraftTaskForUpgrade;
  approvalId?: string | null;
}) {
  const approval = input.approvalId
    ? await prisma.approvalRecord.findFirst({
        where: {
          id: input.approvalId,
          type: 'resolution_1080p',
          status: 'approved',
          project_id: input.projectId,
          video_card_id: input.videoCardId,
        },
      })
    : await prisma.$transaction((tx) => findUsableApproval(tx, {
        type: 'resolution_1080p',
        projectId: input.projectId,
        videoCardId: input.videoCardId,
      }));

  if (!approval) {
    throw new DraftUpgradeError('未找到有效的 1080p 审批记录，请先在审批中心申请并通过审批', 403, 'RESOLUTION_APPROVAL_REQUIRED');
  }
  if (approval.video_card_id !== input.videoCardId) {
    throw new DraftUpgradeError('1080p 审批必须绑定当前视频卡', 403, 'RESOLUTION_APPROVAL_SCOPE_INVALID');
  }
  if (approval.usage_limit !== null && approval.used_count >= approval.usage_limit) {
    throw new DraftUpgradeError('1080p 审批额度已用尽，请重新申请', 403, 'RESOLUTION_APPROVAL_EXHAUSTED');
  }
  if (approval.expires_at && approval.expires_at <= new Date()) {
    throw new DraftUpgradeError('1080p 审批已过期，请重新申请', 403, 'RESOLUTION_APPROVAL_EXPIRED');
  }
  if (!approval.task_id) {
    throw new DraftUpgradeError('1080p 审批缺少基准任务，请重新申请', 403, 'RESOLUTION_APPROVAL_BASE_MISSING');
  }
  const baseTask = await prisma.videoTask.findUnique({
    where: { id: approval.task_id },
    select: { id: true, video_card_id: true, version_role: true },
  });
  if (!baseTask || !isValidApprovalBase(baseTask, input.draft, input.videoCardId)) {
    throw new DraftUpgradeError('1080p 审批基准任务不属于当前视频卡的候选、当前最佳、最终版或当前 Draft', 403, 'RESOLUTION_APPROVAL_BASE_INVALID');
  }
  return approval;
}

async function settleDraftUpgradeFailure(input: {
  taskId: string;
  userId: string;
  frozenAmount: number;
  errorMessage: string;
  errorCode: string;
}) {
  await prisma.$transaction(async (tx) => {
    const task = await tx.videoTask.findUnique({ where: { id: input.taskId } });
    if (!task || ['succeeded', 'failed', 'cancelled'].includes(task.local_status)) return;

    const existingSettlement = await tx.creditLedger.findFirst({
      where: {
        related_task_id: input.taskId,
        type: { in: ['task_success_deduct', 'task_failed_refund'] },
      },
    });
    if (existingSettlement) return;

    const consumedApprovals = await tx.approvalUsage.findMany({
      where: { task_id: input.taskId },
      select: { approval_id: true },
    });
    if (consumedApprovals.length > 0) {
      await tx.approvalUsage.deleteMany({ where: { task_id: input.taskId } });
      for (const usage of consumedApprovals) {
        await tx.approvalRecord.updateMany({
          where: { id: usage.approval_id, used_count: { gt: 0 } },
          data: { used_count: { decrement: 1 } },
        });
      }
    }

    await tx.videoTask.update({
      where: { id: input.taskId },
      data: {
        local_status: 'failed',
        error_code: input.errorCode,
        error_message: input.errorMessage,
        completed_at: new Date(),
      },
    });

    const frozenAmount = Math.max(0, Number(task.frozen_cost ?? input.frozenAmount));
    if (frozenAmount <= 0) {
      const failedTask = await tx.videoTask.update({
        where: { id: input.taskId },
        data: { frozen_cost: 0, actual_cost: 0, refund_amount: 0 },
      });
      await recordTaskCostSettlement(tx, failedTask, 'failed', input.userId);
      return;
    }

    if (task.billing_scope === 'project' && task.project_id) {
      const settlement = await settleProjectTaskBudget(tx, {
        projectId: task.project_id,
        taskId: task.id,
        terminalStatus: 'failed',
        frozenAmount,
        freezeSnapshot: task.credit_freeze_snapshot,
        operatorId: input.userId,
      });
      const failedTask = await tx.videoTask.update({
        where: { id: task.id },
        data: { frozen_cost: 0, actual_cost: 0, refund_amount: settlement.refundedAmount },
      });
      await recordTaskCostSettlement(tx, failedTask, 'failed', input.userId);
      return;
    }

    const settlement = await settleTaskCredits(tx, {
      taskId: task.id,
      userId: input.userId,
      terminalStatus: 'failed',
      frozenAmount,
      freezeSnapshot: task.credit_freeze_snapshot,
    });
    const failedTask = await tx.videoTask.update({
      where: { id: task.id },
      data: { frozen_cost: 0, actual_cost: 0, refund_amount: settlement.refundedAmount },
    });
    await tx.creditLedger.create({
      data: {
        user_id: input.userId,
        type: 'task_failed_refund',
        amount: settlement.refundedAmount,
        balance_before: settlement.balanceBefore,
        balance_after: settlement.balanceAfter,
        frozen_before: settlement.frozenBefore,
        frozen_after: settlement.frozenAfter,
        related_task_id: task.id,
        reason: `Draft 升级提交失败，返还 ${settlement.refundedAmount} 点`,
        metadata_json: JSON.stringify({ error_code: input.errorCode }),
      },
    });
    await recordTaskCostSettlement(tx, failedTask, 'failed', input.userId);
  });
}

export async function createSeedanceDraftUpgrade(input: DraftUpgradeInput) {
  if (!isSeedanceDraftUpgradeEnabled()) {
    throw new DraftUpgradeError('供应商 Draft 升级接口尚未完成核验，暂不能生成 1080p', 503, 'DRAFT_UPGRADE_DISABLED');
  }
  if (!input.draftTaskId || input.draftTaskId.includes('/') || input.draftTaskId.length > 120) {
    throw new DraftUpgradeError('只允许传入本地 Draft 任务 ID', 400, 'LOCAL_DRAFT_ID_REQUIRED');
  }
  if (!input.resolutionApprovalConfirmed) {
    throw new DraftUpgradeError('1080p 生成需要先确认审批通过', 403, 'RESOLUTION_APPROVAL_REQUIRED');
  }

  const draft = await prisma.videoTask.findUnique({
    where: { id: input.draftTaskId },
    select: {
      id: true,
      provider: true,
      model: true,
      generation_mode: true,
      prompt: true,
      ratio: true,
      duration: true,
      seed: true,
      generate_audio: true,
      return_last_frame: true,
      watermark: true,
      reference_image_urls: true,
      reference_video_urls: true,
      reference_audio_urls: true,
      first_frame_url: true,
      last_frame_url: true,
      frame_image_urls: true,
      workspace_id: true,
      project_id: true,
      video_card_id: true,
      owner_user_id: true,
      user_id: true,
      local_status: true,
      is_draft: true,
      provider_draft_task_id: true,
      retention_status: true,
    },
  });

  if (!draft) throw new DraftUpgradeError('Draft 任务不存在', 404, 'DRAFT_NOT_FOUND');
  if (draft.retention_status === 'admin_hidden' || draft.retention_status === 'user_deleted') {
    throw new DraftUpgradeError('Draft 任务已被隐藏或移除，不能继续升级', 404, 'DRAFT_NOT_VISIBLE');
  }
  if (draft.provider !== 'seedance' || draft.model !== SEEDANCE_2_5_MODEL_ID || !draft.is_draft) {
    throw new DraftUpgradeError('只有 Seedance 2.5 样片 Draft 才能升级到 1080p', 400, 'DRAFT_MODEL_INVALID');
  }
  if (draft.local_status !== 'succeeded') {
    throw new DraftUpgradeError('请先等待样片 Draft 完成，再生成 1080p', 409, 'DRAFT_NOT_READY');
  }
  if (!draft.provider_draft_task_id) {
    throw new DraftUpgradeError('样片缺少供应商 Draft ID，不能安全升级', 409, 'DRAFT_PROVIDER_ID_MISSING');
  }
  if (!draft.project_id || !draft.video_card_id) {
    throw new DraftUpgradeError('Draft 未绑定项目视频卡，不能生成正式结果', 400, 'DRAFT_SCOPE_MISSING');
  }

  await assertCanGenerateInVideoCard(input.user, draft.project_id, draft.video_card_id);
  const project = await getProjectForGeneration(input.user, draft.project_id);
  const videoCard = await prisma.videoCard.findUnique({
    where: { id: draft.video_card_id },
    select: { id: true, project_id: true, status: true },
  });
  if (!videoCard || videoCard.project_id !== project.id) {
    throw new DraftUpgradeError('视频卡不存在或不属于当前项目', 404, 'VIDEO_CARD_NOT_FOUND');
  }

  const approval = project.type !== 'personal'
    ? await findApprovalForUpgrade({
        projectId: project.id,
        videoCardId: videoCard.id,
        draft,
        approvalId: input.resolutionApprovalId,
      })
    : null;

  const duration = Math.max(4, Math.min(15, draft.duration || 5));
  const pricing = calculateEstimatedCost('1080p', duration, draft.model);
  const estimatedCost = pricing.estimatedCost;
  const billingScope = shouldBillProjectBudget(project) ? 'project' : 'user';
  const billingAccountId = billingScope === 'project' ? project.id : input.user.id;
  const idempotencyKey = input.idempotencyKey?.trim() || null;

  if (idempotencyKey) {
    const existing = await prisma.videoTask.findFirst({
      where: {
        user_id: input.user.id,
        idempotency_key: idempotencyKey,
        source_draft_task_id: draft.id,
      },
      select: {
        id: true,
        provider_task_id: true,
        local_status: true,
        estimated_cost: true,
        source_draft_task_id: true,
      },
    });
    if (existing) return { ...existing, deduplicated: true, pending_confirmation: existing.local_status === 'submitted' && !existing.provider_task_id };
  }

  const sourceMetadata = {
    source_type: input.sourceType || 'web',
    source_label: input.sourceLabel || 'Seedance Draft 升级',
    source_request_id: input.sourceRequestId || idempotencyKey,
    draft_task_id: draft.id,
    draft_contract_version: SEEDANCE_DRAFT_CONTRACT_VERSION,
  };
  const taskParams = {
    source_draft_task_id: draft.id,
    model: draft.model,
    resolution: '1080p',
    ratio: draft.ratio,
    duration,
    locked_from_draft: true,
    resolution_approval_id: approval?.id || null,
    source: sourceMetadata,
  };

  let task = await prisma.$transaction(async (tx) => {
    const created = await tx.videoTask.create({
      data: {
        provider: 'seedance',
        model: draft.model,
        generation_mode: draft.generation_mode,
        prompt: draft.prompt,
        source_type: input.sourceType || 'web',
        source_label: input.sourceLabel || 'Seedance Draft 升级',
        source_request_id: input.sourceRequestId || idempotencyKey,
        source_metadata_json: JSON.stringify(sourceMetadata),
        ratio: draft.ratio,
        duration,
        resolution: '1080p',
        seed: draft.seed,
        generate_audio: draft.generate_audio,
        return_last_frame: draft.return_last_frame,
        watermark: draft.watermark,
        reference_image_urls: draft.reference_image_urls,
        reference_video_urls: draft.reference_video_urls,
        reference_audio_urls: draft.reference_audio_urls,
        first_frame_url: draft.first_frame_url,
        last_frame_url: draft.last_frame_url,
        frame_image_urls: draft.frame_image_urls,
        local_status: 'submitted',
        is_draft: false,
        provider_draft_task_id: draft.provider_draft_task_id,
        draft_upgrade_mode: 'draft_upgrade',
        source_draft_task_id: draft.id,
        draft_contract_version: SEEDANCE_DRAFT_CONTRACT_VERSION,
        user_id: input.user.id,
        owner_user_id: input.user.id,
        project_id: project.id,
        video_card_id: videoCard.id,
        visibility: project.type === 'personal' ? 'private' : 'project',
        estimated_cost: estimatedCost,
        frozen_cost: estimatedCost,
        pricing_snapshot: JSON.stringify(pricing),
        pricing_rule_id: pricing.pricingRuleId,
        idempotency_key: idempotencyKey,
        billing_scope: billingScope,
        billing_account_id: billingAccountId,
        workspace_id: draft.workspace_id,
        params_json: JSON.stringify(taskParams),
        provider_payload_json: JSON.stringify({
          model: draft.model,
          content: [{ type: 'draft_task', draft_task: { id: draft.provider_draft_task_id } }],
          resolution: '1080p',
          contract_version: SEEDANCE_DRAFT_CONTRACT_VERSION,
        }),
      },
    });

    if (approval) {
      const freshApproval = await tx.approvalRecord.findFirst({
        where: { id: approval.id, type: 'resolution_1080p', status: 'approved' },
      });
      if (!freshApproval || !freshApproval.task_id) throw new DraftUpgradeError('1080p 审批在提交时已不可用', 409, 'RESOLUTION_APPROVAL_RACE');
      const baseTask = await tx.videoTask.findUnique({
        where: { id: freshApproval.task_id },
        select: { id: true, video_card_id: true, version_role: true },
      });
      if (!baseTask || !isValidApprovalBase(baseTask, draft, videoCard.id)) {
        throw new DraftUpgradeError('1080p 审批基准任务已变化，请重新申请审批', 409, 'RESOLUTION_APPROVAL_BASE_CHANGED');
      }
      await consumeApprovalForTask(tx, {
        approvalId: freshApproval.id,
        taskId: created.id,
        userId: input.user.id,
        metadata: { project_id: project.id, video_card_id: videoCard.id, baseline_task_id: freshApproval.task_id, resolution: '1080p', draft_task_id: draft.id },
      });
    }

    let freezeSnapshot = '[]';
    if (estimatedCost > 0) {
      if (billingScope === 'project') {
        const freeze = await allocateProjectTaskBudget(tx, {
          projectId: project.id,
          taskId: created.id,
          amount: estimatedCost,
          operatorId: input.user.id,
        });
        freezeSnapshot = freeze.snapshot;
      } else {
        const freeze = await allocateTaskCredits(tx, {
          id: input.user.id,
          role: input.user.role,
          account_type: input.user.account_type,
          user_profile: input.user.user_profile,
          status: input.user.status,
        }, estimatedCost, created.id);
        freezeSnapshot = freeze.snapshot;
        await tx.creditLedger.create({
          data: {
            user_id: input.user.id,
            type: 'task_freeze',
            amount: -estimatedCost,
            balance_before: freeze.balance_before,
            balance_after: freeze.balance_after,
            frozen_before: freeze.frozen_before,
            frozen_after: freeze.frozen_after,
            related_task_id: created.id,
            reason: `Draft 升级冻结 ${estimatedCost} 点`,
            metadata_json: JSON.stringify({ draft_task_id: draft.id, allocations: freeze.allocations }),
          },
        });
      }
    }

    const withFreeze = await tx.videoTask.update({
      where: { id: created.id },
      data: { credit_freeze_snapshot: freezeSnapshot },
    });
    await recordTaskCostEstimate(tx, withFreeze, pricing, input.user.id);
    return withFreeze;
  });

  const clientRequestId = task.id;
  const providerPayload = buildSeedanceDraftUpgradePayload({
    model: draft.model,
    providerDraftTaskId: draft.provider_draft_task_id,
    clientRequestId,
  });
  let providerRequest: Awaited<ReturnType<typeof createProviderApiRequest>> | null = null;
  try {
    providerRequest = await createProviderApiRequest({
      task,
      endpoint: 'seedance.draftUpgrade',
      method: 'POST',
      idempotencyKey,
      requestPayload: providerPayload,
    });
    await prisma.videoTask.update({
      where: { id: task.id },
      data: { provider_client_request_id: clientRequestId },
    });
    const providerResult = await createSeedanceDraftUpgradeTask({
      model: draft.model,
      providerDraftTaskId: draft.provider_draft_task_id,
      clientRequestId,
    });
    task = await prisma.videoTask.update({
      where: { id: task.id },
      data: {
        provider_task_id: providerResult.provider_task_id,
        raw_create_response: JSON.stringify(providerResult.raw),
        local_status: 'submitted',
      },
    });
    await markProviderApiRequestAccepted({
      requestId: providerRequest.id,
      task,
      providerTaskId: providerResult.provider_task_id,
      responseSummary: { provider_task_id: providerResult.provider_task_id, source_draft_task_id: draft.id },
    });
    startTaskLocalization(task.id);
    return {
      id: task.id,
      task_id: task.id,
      provider_task_id: providerResult.provider_task_id,
      source_draft_task_id: draft.id,
      status: 'submitted',
      estimated_cost: estimatedCost,
      deduplicated: false,
    };
  } catch (error) {
    if (providerRequest && isAmbiguousProviderError(error)) {
      try {
        const recovered = await getVideoTaskStatusByClientRequestId(clientRequestId);
        if (recovered.provider_task_id && recovered.provider_task_id !== clientRequestId) {
          task = await prisma.videoTask.update({
            where: { id: task.id },
            data: {
              provider_task_id: recovered.provider_task_id,
              provider_status: recovered.provider_status,
              raw_status_response: JSON.stringify(recovered.raw),
              error_message: null,
            },
          });
          await markProviderApiRequestAccepted({
            requestId: providerRequest.id,
            task,
            providerTaskId: recovered.provider_task_id,
            responseSummary: { recovered_by: 'clientRequestId', source_draft_task_id: draft.id },
          });
          startTaskLocalization(task.id);
          return {
            id: task.id,
            task_id: task.id,
            provider_task_id: recovered.provider_task_id,
            source_draft_task_id: draft.id,
            status: recovered.local_status,
            estimated_cost: estimatedCost,
            pending_confirmation: false,
            recovered_by_client_request_id: true,
          };
        }
      } catch {
        // 查询也失败时保留 submitted + provider request pending，交给恢复任务重试。
      }

      await prisma.videoTask.update({
        where: { id: task.id },
        data: { error_message: '提交结果待确认，系统会按请求 ID 自动恢复，请勿重复提交。' },
      });
      return {
        id: task.id,
        task_id: task.id,
        provider_task_id: null,
        source_draft_task_id: draft.id,
        status: 'pending_confirmation',
        estimated_cost: estimatedCost,
        pending_confirmation: true,
      };
    }

    const message = error instanceof Error ? error.message : 'Seedance Draft 升级提交失败';
    if (providerRequest) {
      await markProviderApiRequestFailed({
        requestId: providerRequest.id,
        errorCode: 'DRAFT_UPGRADE_CREATE_FAILED',
        errorMessage: message,
        responseSummary: { source_draft_task_id: draft.id },
      }).catch(() => {});
    }
    await settleDraftUpgradeFailure({
      taskId: task.id,
      userId: input.user.id,
      frozenAmount: estimatedCost,
      errorMessage: 'Draft 升级提交失败，已返还本次冻结点数。',
      errorCode: 'DRAFT_UPGRADE_CREATE_FAILED',
    });
    throw new DraftUpgradeError('Draft 升级提交失败，已返还本次冻结点数', 502, 'DRAFT_UPGRADE_CREATE_FAILED');
  }
}
