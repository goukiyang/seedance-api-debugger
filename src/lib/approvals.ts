import type { ApprovalRecord, Prisma } from '@prisma/client';
import { createInAppNotification, notifyProjectOwner } from '@/lib/notifications';
import { adjustProjectBudget, ensureProjectBudgetAccount } from '@/lib/projects/budget';

type ApprovalClient = Prisma.TransactionClient;

export const APPROVAL_TYPES = [
  'project_create',
  'budget_increase',
  'resolution_1080p',
  'ratio_change',
  'video_card_reopen',
] as const;

export type ApprovalType = typeof APPROVAL_TYPES[number];

export function normalizeApprovalType(value: unknown): ApprovalType | null {
  return APPROVAL_TYPES.includes(value as ApprovalType) ? value as ApprovalType : null;
}

function defaultExpiresAt(days = 14) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function parsePayload(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function payloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function payloadNumber(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInt(payload: Record<string, unknown>, key: string) {
  const parsed = payloadNumber(payload, key);
  if (parsed === null) return null;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function validateApprovalPayload(input: {
  type: ApprovalType;
  projectId?: string | null;
  videoCardId?: string | null;
  taskId?: string | null;
  payload?: Record<string, unknown>;
}) {
  const payload = input.payload || {};
  if (input.type === 'project_create') {
    const projectName = payloadString(payload, 'project_name') || payloadString(payload, 'projectName');
    if (!projectName) throw new Error('公共项目立项必须填写项目名称');
    const initialBudget = payloadNumber(payload, 'initial_budget_credits') ?? payloadNumber(payload, 'initialBudgetCredits') ?? 0;
    if (initialBudget < 0) throw new Error('初始预算不能小于 0');
    if (initialBudget > 0 && !payloadString(payload, 'budget_purpose') && !payloadString(payload, 'budgetPurpose')) {
      throw new Error('预算记账申请必须填写预算用途');
    }
  }
  if (input.type === 'budget_increase') {
    if (!input.projectId) throw new Error('追加预算审批必须关联公共项目');
    const amount = payloadNumber(payload, 'amount') ?? payloadNumber(payload, 'amount_credits') ?? payloadNumber(payload, 'amountCredits');
    if (!amount || amount <= 0) throw new Error('追加预算金额必须大于 0');
    if (!payloadString(payload, 'budget_purpose') && !payloadString(payload, 'budgetPurpose')) {
      throw new Error('追加预算必须填写预算用途');
    }
  }
  if (input.type === 'resolution_1080p') {
    if (!input.projectId) throw new Error('1080p 审批必须关联项目');
    if (!input.videoCardId) throw new Error('1080p 审批必须关联视频卡');
    if (!input.taskId) throw new Error('1080p 审批必须绑定基准任务');
    const quota = positiveInt(payload, 'quota_count') ?? positiveInt(payload, 'quotaCount');
    if (!quota) throw new Error('1080p 审批必须填写额度次数');
    const budget = payloadNumber(payload, 'estimated_budget_credits') ?? payloadNumber(payload, 'estimatedBudgetCredits');
    if (!budget || budget <= 0) throw new Error('1080p 审批必须填写额度预算');
    if (!payloadString(payload, 'intended_use') && !payloadString(payload, 'intendedUse')) {
      throw new Error('1080p 审批必须填写预计用途');
    }
  }
  if (input.type === 'ratio_change') {
    if (!input.projectId || !input.videoCardId) throw new Error('比例变更审批必须关联项目和视频卡');
    const targetRatio = payloadString(payload, 'target_ratio') || payloadString(payload, 'targetRatio');
    if (!targetRatio) throw new Error('比例变更审批必须填写目标比例');
    if (!payloadString(payload, 'change_reason') && !payloadString(payload, 'changeReason')) {
      throw new Error('比例变更审批必须填写变更原因');
    }
  }
  if (input.type === 'video_card_reopen') {
    if (!input.projectId || !input.videoCardId) throw new Error('视频卡重开审批必须关联项目和视频卡');
    if (!payloadString(payload, 'reopen_reason') && !payloadString(payload, 'reopenReason')) {
      throw new Error('视频卡重开审批必须填写重开原因');
    }
  }
}

async function applyProjectCreateApproval(
  tx: ApprovalClient,
  approval: ApprovalRecord,
  approverUserId: string,
) {
  // 立项审批通过后才创建公共项目，避免“有审批记录但没有业务实体”。
  const payload = parsePayload(approval.requested_payload_json);
  const name = payloadString(payload, 'project_name') || payloadString(payload, 'projectName');
  if (!name) throw new Error('公共项目立项审批缺少项目名称');
  const description = payloadString(payload, 'project_description') || payloadString(payload, 'projectDescription');
  const initialBudget = payloadNumber(payload, 'initial_budget_credits') ?? payloadNumber(payload, 'initialBudgetCredits') ?? 0;
  if (initialBudget < 0) throw new Error('初始预算不能小于 0');

  const project = await tx.project.create({
    data: {
      name,
      description,
      type: 'public',
      visibility: 'private',
      owner_user_id: approval.requester_user_id,
      created_by: approval.requester_user_id,
      status: 'active',
    },
  });

  await tx.projectMember.create({
    data: {
      project_id: project.id,
      user_id: approval.requester_user_id,
      role: 'project_owner',
      joined_by: approverUserId,
    },
  });

  await ensureProjectBudgetAccount(tx, project.id, approverUserId);
  if (initialBudget > 0) {
    await adjustProjectBudget(tx, {
      projectId: project.id,
      amount: initialBudget,
      operatorId: approverUserId,
      reason: `公共项目立项审批初始预算：${approval.reason || name}`,
      idempotencyKey: `approval:${approval.id}:project_create_initial_budget`,
    });
  }

  await tx.operationLog.create({
    data: {
      operator_id: approverUserId,
      action: 'approval_effect_project_create',
      target_type: 'project',
      target_id: project.id,
      detail: JSON.stringify({
        approval_id: approval.id,
        requester_user_id: approval.requester_user_id,
        initial_budget_credits: initialBudget,
      }),
    },
  });

  await createInAppNotification(tx, {
    targetUserId: approval.requester_user_id,
    actorUserId: approverUserId,
    type: 'approval_project_create_approved',
    title: '公共项目立项已通过',
    body: `项目「${name}」已创建，初始预算 ${initialBudget} 点。`,
    projectId: project.id,
    approvalId: approval.id,
    metadata: { initial_budget_credits: initialBudget },
  });

  return project.id;
}

async function applyBudgetIncreaseApproval(
  tx: ApprovalClient,
  approval: ApprovalRecord,
  approverUserId: string,
) {
  // 追加预算必须走项目预算账本，不能只把审批状态改成 approved。
  if (!approval.project_id) throw new Error('追加预算审批缺少项目 ID');
  const project = await tx.project.findUnique({
    where: { id: approval.project_id },
    select: { id: true, type: true, status: true },
  });
  if (!project) throw new Error('追加预算审批关联项目不存在');
  if (project.type !== 'public') throw new Error('只有公共项目可以走预算追加审批');
  if (project.status !== 'active') throw new Error('项目不是进行中状态，不能追加预算');

  const payload = parsePayload(approval.requested_payload_json);
  const amount = payloadNumber(payload, 'amount') ?? payloadNumber(payload, 'amount_credits') ?? payloadNumber(payload, 'amountCredits');
  if (!amount || amount <= 0) throw new Error('追加预算金额必须大于 0');

  await adjustProjectBudget(tx, {
    projectId: approval.project_id,
    amount,
    operatorId: approverUserId,
    reason: `追加预算审批通过：${approval.reason || '项目预算追加'}`,
    idempotencyKey: `approval:${approval.id}:budget_increase`,
  });

  await tx.operationLog.create({
    data: {
      operator_id: approverUserId,
      action: 'approval_effect_budget_increase',
      target_type: 'project',
      target_id: approval.project_id,
      detail: JSON.stringify({
        approval_id: approval.id,
        amount_credits: amount,
      }),
    },
  });

  await notifyProjectOwner(tx, {
    projectId: approval.project_id,
    actorUserId: approverUserId,
    approvalId: approval.id,
    type: 'approval_budget_increase_approved',
    title: '追加预算已入账',
    body: `项目预算已追加 ${amount} 点。`,
    metadata: { amount_credits: amount },
  });

  return approval.project_id;
}

async function applyRatioChangeApproval(
  tx: ApprovalClient,
  approval: ApprovalRecord,
  approverUserId: string,
) {
  if (!approval.video_card_id) throw new Error('比例变更审批缺少视频卡 ID');
  const payload = parsePayload(approval.requested_payload_json);
  const targetRatio = payloadString(payload, 'target_ratio') || payloadString(payload, 'targetRatio');
  const changeReason = payloadString(payload, 'change_reason') || payloadString(payload, 'changeReason') || approval.reason || '比例变更审批通过';
  if (!targetRatio) throw new Error('比例变更审批缺少目标比例');

  const card = await tx.videoCard.findUnique({
    where: { id: approval.video_card_id },
    select: { id: true, project_id: true, ratio: true, original_ratio: true },
  });
  if (!card) throw new Error('比例变更审批关联视频卡不存在');

  await tx.videoCard.update({
    where: { id: card.id },
    data: {
      ratio: targetRatio,
      original_ratio: card.original_ratio || card.ratio,
      ratio_locked: true,
      ratio_change_reason: changeReason,
    },
  });

  await tx.operationLog.create({
    data: {
      operator_id: approverUserId,
      action: 'approval_effect_ratio_change',
      target_type: 'video_card',
      target_id: card.id,
      detail: JSON.stringify({
        approval_id: approval.id,
        project_id: card.project_id,
        previous_ratio: card.ratio,
        target_ratio: targetRatio,
        reason: changeReason,
      }),
    },
  });

  await notifyProjectOwner(tx, {
    projectId: card.project_id,
    videoCardId: card.id,
    actorUserId: approverUserId,
    approvalId: approval.id,
    type: 'approval_ratio_change_approved',
    title: '视频卡比例变更已通过',
    body: `目标比例已变更为 ${targetRatio}。`,
    metadata: { previous_ratio: card.ratio, target_ratio: targetRatio },
  });

  return card.project_id;
}

async function applyVideoCardReopenApproval(
  tx: ApprovalClient,
  approval: ApprovalRecord,
  approverUserId: string,
) {
  if (!approval.video_card_id) throw new Error('视频卡重开审批缺少视频卡 ID');
  const payload = parsePayload(approval.requested_payload_json);
  const reopenReason = payloadString(payload, 'reopen_reason') || payloadString(payload, 'reopenReason') || approval.reason || '重开审批通过';
  const targetStatus = payloadString(payload, 'target_status') || payloadString(payload, 'targetStatus') || 'active';
  if (!['draft', 'active', 'reviewing'].includes(targetStatus)) {
    throw new Error('视频卡重开目标状态无效');
  }

  const card = await tx.videoCard.findUnique({
    where: { id: approval.video_card_id },
    select: { id: true, project_id: true, status: true, sealed_at: true, sealed_by: true },
  });
  if (!card) throw new Error('视频卡重开审批关联视频卡不存在');
  if (card.status !== 'sealed' && card.status !== 'archived') {
    throw new Error('只有已封板或已归档视频卡需要重开审批');
  }

  await tx.videoCard.update({
    where: { id: card.id },
    data: {
      status: targetStatus,
      sealed_at: null,
      sealed_by: null,
    },
  });

  await tx.operationLog.create({
    data: {
      operator_id: approverUserId,
      action: 'approval_effect_video_card_reopen',
      target_type: 'video_card',
      target_id: card.id,
      detail: JSON.stringify({
        approval_id: approval.id,
        project_id: card.project_id,
        previous_status: card.status,
        target_status: targetStatus,
        previous_sealed_at: card.sealed_at,
        previous_sealed_by: card.sealed_by,
        reason: reopenReason,
      }),
    },
  });

  await notifyProjectOwner(tx, {
    projectId: card.project_id,
    videoCardId: card.id,
    actorUserId: approverUserId,
    approvalId: approval.id,
    type: 'approval_video_card_reopen_approved',
    title: '视频卡重开已通过',
    body: `视频卡已恢复为${targetStatus}状态，可以继续整理或生成。`,
    metadata: { previous_status: card.status, target_status: targetStatus },
  });

  return card.project_id;
}

export async function findValidApproval(
  tx: ApprovalClient,
  input: {
    type: ApprovalType;
    projectId?: string | null;
    videoCardId?: string | null;
    taskId?: string | null;
  },
) {
  const now = new Date();
  const and: Prisma.ApprovalRecordWhereInput[] = [
    {
      OR: [
        { expires_at: null },
        { expires_at: { gt: now } },
      ],
    },
  ];
  if (input.videoCardId) {
    if (input.type === 'resolution_1080p' || input.type === 'ratio_change' || input.type === 'video_card_reopen') {
      and.push({ video_card_id: input.videoCardId });
    } else {
      and.push({
        OR: [
          { video_card_id: input.videoCardId },
          { video_card_id: null },
        ],
      });
    }
  }

  return tx.approvalRecord.findFirst({
    where: {
      type: input.type,
      status: 'approved',
      ...(input.projectId ? { project_id: input.projectId } : {}),
      ...(input.taskId ? { task_id: input.taskId } : {}),
      AND: and,
    },
    orderBy: [{ approved_at: 'desc' }, { created_at: 'desc' }],
  });
}

export async function findUsableApproval(
  tx: ApprovalClient,
  input: {
    type: ApprovalType;
    projectId?: string | null;
    videoCardId?: string | null;
    taskId?: string | null;
  },
) {
  const approval = await findValidApproval(tx, input);
  if (!approval) return null;
  if (approval.usage_limit !== null && approval.used_count >= approval.usage_limit) return null;
  return approval;
}

export async function consumeApprovalForTask(
  tx: ApprovalClient,
  input: {
    approvalId: string;
    taskId: string;
    userId: string;
    metadata?: Record<string, unknown>;
  },
) {
  const approval = await tx.approvalRecord.findUnique({ where: { id: input.approvalId } });
  if (!approval || approval.status !== 'approved') throw new Error('审批记录不可用');
  if (approval.expires_at && approval.expires_at <= new Date()) throw new Error('审批记录已过期');
  if (approval.usage_limit !== null && approval.used_count >= approval.usage_limit) {
    throw new Error('审批额度已用尽');
  }

  await tx.approvalUsage.create({
    data: {
      approval_id: approval.id,
      task_id: input.taskId,
      user_id: input.userId,
      amount: 1,
      metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
    },
  });

  return tx.approvalRecord.update({
    where: { id: approval.id },
    data: {
      used_count: { increment: 1 },
      task_id: approval.task_id || input.taskId,
    },
  });
}

export async function createApprovalRequest(
  tx: ApprovalClient,
  input: {
    type: ApprovalType;
    requesterUserId: string;
    projectId?: string | null;
    videoCardId?: string | null;
    taskId?: string | null;
    reason?: string | null;
    scope?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    expiresAt?: Date | null;
  },
) {
  validateApprovalPayload({
    type: input.type,
    projectId: input.projectId,
    videoCardId: input.videoCardId,
    taskId: input.taskId,
    payload: input.payload,
  });
  const usageLimit = input.type === 'resolution_1080p'
    ? (positiveInt(input.payload || {}, 'quota_count') ?? positiveInt(input.payload || {}, 'quotaCount') ?? 1)
    : null;

  return tx.approvalRecord.create({
    data: {
      type: input.type,
      status: 'pending',
      requester_user_id: input.requesterUserId,
      project_id: input.projectId || null,
      video_card_id: input.videoCardId || null,
      task_id: input.taskId || null,
      reason: input.reason || null,
      scope_json: input.scope ? JSON.stringify(input.scope) : null,
      requested_payload_json: input.payload ? JSON.stringify(input.payload) : null,
      usage_limit: usageLimit,
      expires_at: input.expiresAt === undefined ? defaultExpiresAt() : input.expiresAt,
    },
  });
}

export async function decideApproval(
  tx: ApprovalClient,
  input: {
    approvalId: string;
    approverUserId: string;
    action: 'approve' | 'reject';
    reason?: string | null;
    expiresAt?: Date | null;
  },
) {
  const approval = await tx.approvalRecord.findUnique({ where: { id: input.approvalId } });
  if (!approval) throw new Error('审批记录不存在');
  if (approval.status !== 'pending') throw new Error('只能处理待审批记录');

  const approved = input.action === 'approve';
  let effectProjectId: string | null = null;
  if (approved && approval.type === 'project_create') {
    effectProjectId = await applyProjectCreateApproval(tx, approval, input.approverUserId);
  }
  if (approved && approval.type === 'budget_increase') {
    effectProjectId = await applyBudgetIncreaseApproval(tx, approval, input.approverUserId);
  }
  if (approved && approval.type === 'ratio_change') {
    effectProjectId = await applyRatioChangeApproval(tx, approval, input.approverUserId);
  }
  if (approved && approval.type === 'video_card_reopen') {
    effectProjectId = await applyVideoCardReopenApproval(tx, approval, input.approverUserId);
  }

  if (!approved) {
    await createInAppNotification(tx, {
      targetUserId: approval.requester_user_id,
      actorUserId: input.approverUserId,
      type: `approval_${approval.type}_rejected`,
      title: '审批已拒绝',
      body: input.reason || approval.reason || '未填写拒绝原因',
      projectId: approval.project_id,
      videoCardId: approval.video_card_id,
      approvalId: approval.id,
    });
  }

  return tx.approvalRecord.update({
    where: { id: input.approvalId },
    data: {
      status: approved ? 'approved' : 'rejected',
      approver_user_id: input.approverUserId,
      project_id: effectProjectId || approval.project_id,
      effect_status: approved ? 'applied' : 'skipped',
      effect_error: null,
      decision_reason: input.reason || null,
      approved_at: approved ? new Date() : null,
      rejected_at: approved ? null : new Date(),
      expires_at: approved
        ? (input.expiresAt === undefined ? approval.expires_at || defaultExpiresAt() : input.expiresAt)
        : approval.expires_at,
    },
  });
}
