import type { ApprovalRecord, Prisma } from '@prisma/client';
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

export function validateApprovalPayload(input: {
  type: ApprovalType;
  projectId?: string | null;
  payload?: Record<string, unknown>;
}) {
  const payload = input.payload || {};
  if (input.type === 'project_create') {
    const projectName = payloadString(payload, 'project_name') || payloadString(payload, 'projectName');
    if (!projectName) throw new Error('公共项目立项必须填写项目名称');
    const initialBudget = payloadNumber(payload, 'initial_budget_credits') ?? payloadNumber(payload, 'initialBudgetCredits') ?? 0;
    if (initialBudget < 0) throw new Error('初始预算不能小于 0');
  }
  if (input.type === 'budget_increase') {
    if (!input.projectId) throw new Error('追加预算审批必须关联公共项目');
    const amount = payloadNumber(payload, 'amount') ?? payloadNumber(payload, 'amount_credits') ?? payloadNumber(payload, 'amountCredits');
    if (!amount || amount <= 0) throw new Error('追加预算金额必须大于 0');
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

  return approval.project_id;
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
    and.push({
      OR: [
        { video_card_id: input.videoCardId },
        { video_card_id: null },
      ],
    });
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
    payload: input.payload,
  });

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

  return tx.approvalRecord.update({
    where: { id: input.approvalId },
    data: {
      status: approved ? 'approved' : 'rejected',
      approver_user_id: input.approverUserId,
      project_id: effectProjectId || approval.project_id,
      decision_reason: input.reason || null,
      approved_at: approved ? new Date() : null,
      rejected_at: approved ? null : new Date(),
      expires_at: approved
        ? (input.expiresAt === undefined ? approval.expires_at || defaultExpiresAt() : input.expiresAt)
        : approval.expires_at,
    },
  });
}
