import type { Prisma } from '@prisma/client';

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
  return tx.approvalRecord.update({
    where: { id: input.approvalId },
    data: {
      status: approved ? 'approved' : 'rejected',
      approver_user_id: input.approverUserId,
      decision_reason: input.reason || null,
      approved_at: approved ? new Date() : null,
      rejected_at: approved ? null : new Date(),
      expires_at: approved
        ? (input.expiresAt === undefined ? approval.expires_at || defaultExpiresAt() : input.expiresAt)
        : approval.expires_at,
    },
  });
}
