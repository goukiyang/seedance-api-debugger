import type { Prisma, Project } from '@prisma/client';

type BudgetClient = Prisma.TransactionClient;
type ProjectBillingShape = Pick<Project, 'id' | 'type'>;

export type ProjectBudgetSnapshot = {
  source_type: 'project_budget';
  project_id: string;
  account_id: string;
  amount: number;
};

export function shouldBillProjectBudget(project: ProjectBillingShape) {
  return project.type === 'public';
}

function assertPositiveAmount(amount: number, label: string) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`${label} 必须大于 0`);
  }
}

function parseProjectBudgetSnapshot(value: string | null | undefined, fallback: ProjectBudgetSnapshot) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as Partial<ProjectBudgetSnapshot>;
    if (
      parsed?.source_type === 'project_budget'
      && typeof parsed.project_id === 'string'
      && typeof parsed.account_id === 'string'
      && Number(parsed.amount) > 0
    ) {
      return {
        source_type: 'project_budget' as const,
        project_id: parsed.project_id,
        account_id: parsed.account_id,
        amount: Number(parsed.amount),
      };
    }
  } catch {
    // 老任务没有项目预算快照时走 fallback。
  }
  return fallback;
}

export async function ensureProjectBudgetAccount(
  tx: BudgetClient,
  projectId: string,
  createdBy?: string | null,
) {
  return tx.projectBudgetAccount.upsert({
    where: { project_id: projectId },
    update: {},
    create: {
      project_id: projectId,
      budget_credits: 0,
      used_credits: 0,
      frozen_credits: 0,
      currency: 'credits',
      status: 'active',
      created_by: createdBy || null,
    },
  });
}

export async function getProjectBudgetSummary(tx: BudgetClient, projectId: string) {
  const account = await tx.projectBudgetAccount.findUnique({ where: { project_id: projectId } });
  if (!account) {
    return {
      id: null,
      project_id: projectId,
      budget_credits: 0,
      used_credits: 0,
      frozen_credits: 0,
      available_credits: 0,
      currency: 'credits',
      status: 'active',
      usage_ratio: 0,
      committed_ratio: 0,
      risk_level: 'normal',
      updated_at: null,
    };
  }
  const available = Math.max(0, account.budget_credits - account.used_credits - account.frozen_credits);
  const usageRatio = account.budget_credits > 0
    ? Math.min(1, account.used_credits / account.budget_credits)
    : 0;
  const committedRatio = account.budget_credits > 0
    ? Math.min(1, (account.used_credits + account.frozen_credits) / account.budget_credits)
    : 0;

  return {
    id: account.id,
    project_id: account.project_id,
    budget_credits: account.budget_credits,
    used_credits: account.used_credits,
    frozen_credits: account.frozen_credits,
    available_credits: available,
    currency: account.currency,
    status: account.status,
    usage_ratio: usageRatio,
    committed_ratio: committedRatio,
    risk_level: committedRatio >= 1 ? 'exhausted' : committedRatio >= 0.9 ? 'critical' : committedRatio >= 0.7 ? 'warning' : 'normal',
    updated_at: account.updated_at,
  };
}

export async function adjustProjectBudget(
  tx: BudgetClient,
  input: {
    projectId: string;
    amount: number;
    operatorId: string;
    reason?: string | null;
    idempotencyKey?: string | null;
  },
) {
  if (!Number.isFinite(input.amount) || input.amount === 0) {
    throw new Error('预算调整金额不能为 0');
  }
  if (input.idempotencyKey) {
    const existing = await tx.projectBudgetLedger.findUnique({
      where: { idempotency_key: input.idempotencyKey },
    });
    if (existing) return existing;
  }

  const account = await ensureProjectBudgetAccount(tx, input.projectId, input.operatorId);
  const nextBudget = account.budget_credits + input.amount;
  const minimumBudget = account.used_credits + account.frozen_credits;
  if (nextBudget < minimumBudget) {
    throw new Error(`预算不能低于已用和冻结合计 ${minimumBudget} 点`);
  }

  const updated = await tx.projectBudgetAccount.update({
    where: { id: account.id },
    data: {
      budget_credits: nextBudget,
      status: nextBudget <= account.used_credits + account.frozen_credits ? 'exhausted' : 'active',
    },
  });

  return tx.projectBudgetLedger.create({
    data: {
      project_id: input.projectId,
      account_id: account.id,
      type: input.amount > 0 ? 'budget_grant' : 'budget_adjust',
      amount: input.amount,
      budget_before: account.budget_credits,
      budget_after: updated.budget_credits,
      used_before: account.used_credits,
      used_after: updated.used_credits,
      frozen_before: account.frozen_credits,
      frozen_after: updated.frozen_credits,
      operator_id: input.operatorId,
      reason: input.reason || (input.amount > 0 ? '项目预算追加' : '项目预算调整'),
      idempotency_key: input.idempotencyKey || null,
      metadata_json: JSON.stringify({ currency: updated.currency }),
    },
  });
}

export async function allocateProjectTaskBudget(
  tx: BudgetClient,
  input: {
    projectId: string;
    taskId: string;
    amount: number;
    operatorId: string;
  },
) {
  assertPositiveAmount(input.amount, '任务预算预占金额');
  const idempotencyKey = `project_budget_freeze:${input.taskId}`;
  const existing = await tx.projectBudgetLedger.findUnique({ where: { idempotency_key: idempotencyKey } });
  if (existing) {
    const account = await tx.projectBudgetAccount.findUnique({ where: { id: existing.account_id } });
    if (!account) throw new Error('项目预算账户不存在');
    return {
      snapshot: JSON.stringify({
        source_type: 'project_budget',
        project_id: input.projectId,
        account_id: account.id,
        amount: input.amount,
      } satisfies ProjectBudgetSnapshot),
      budgetBefore: existing.budget_before,
      budgetAfter: existing.budget_after,
      usedBefore: existing.used_before,
      usedAfter: existing.used_after,
      frozenBefore: existing.frozen_before,
      frozenAfter: existing.frozen_after,
    };
  }

  const account = await ensureProjectBudgetAccount(tx, input.projectId, input.operatorId);
  if (account.status !== 'active') {
    throw new Error('项目预算不可用，请先追加预算或恢复预算状态');
  }

  const available = account.budget_credits - account.used_credits - account.frozen_credits;
  if (input.amount > available) {
    throw new Error(`项目预算不足，需要 ${input.amount} 点，当前可用 ${Math.max(0, available)} 点`);
  }

  const updated = await tx.projectBudgetAccount.update({
    where: { id: account.id },
    data: {
      frozen_credits: account.frozen_credits + input.amount,
      status: available - input.amount <= 0 ? 'exhausted' : account.status,
    },
  });

  await tx.projectBudgetLedger.create({
    data: {
      project_id: input.projectId,
      account_id: account.id,
      type: 'task_freeze',
      amount: -input.amount,
      budget_before: account.budget_credits,
      budget_after: updated.budget_credits,
      used_before: account.used_credits,
      used_after: updated.used_credits,
      frozen_before: account.frozen_credits,
      frozen_after: updated.frozen_credits,
      related_task_id: input.taskId,
      operator_id: input.operatorId,
      reason: `任务创建冻结项目预算 ${input.amount} 点`,
      idempotency_key: idempotencyKey,
      metadata_json: JSON.stringify({ currency: updated.currency }),
    },
  });

  return {
    snapshot: JSON.stringify({
      source_type: 'project_budget',
      project_id: input.projectId,
      account_id: account.id,
      amount: input.amount,
    } satisfies ProjectBudgetSnapshot),
    budgetBefore: account.budget_credits,
    budgetAfter: updated.budget_credits,
    usedBefore: account.used_credits,
    usedAfter: updated.used_credits,
    frozenBefore: account.frozen_credits,
    frozenAfter: updated.frozen_credits,
  };
}

export async function settleProjectTaskBudget(
  tx: BudgetClient,
  input: {
    projectId: string;
    taskId: string;
    terminalStatus: string;
    frozenAmount: number;
    freezeSnapshot?: string | null;
    operatorId?: string | null;
  },
) {
  assertPositiveAmount(input.frozenAmount, '任务预算结算金额');
  const idempotencyKey = `project_budget_settle:${input.taskId}`;
  const existing = await tx.projectBudgetLedger.findUnique({ where: { idempotency_key: idempotencyKey } });
  if (existing) {
    return {
      actualCost: existing.type === 'task_success_deduct' ? input.frozenAmount : 0,
      refundedAmount: existing.type === 'task_failed_refund' ? input.frozenAmount : 0,
      budgetBefore: existing.budget_before,
      budgetAfter: existing.budget_after,
      usedBefore: existing.used_before,
      usedAfter: existing.used_after,
      frozenBefore: existing.frozen_before,
      frozenAfter: existing.frozen_after,
      snapshot: null,
    };
  }

  const fallbackAccount = await ensureProjectBudgetAccount(tx, input.projectId, input.operatorId);
  const snapshot = parseProjectBudgetSnapshot(input.freezeSnapshot, {
    source_type: 'project_budget',
    project_id: input.projectId,
    account_id: fallbackAccount.id,
    amount: input.frozenAmount,
  });
  const account = await tx.projectBudgetAccount.findUnique({ where: { id: snapshot.account_id } });
  if (!account) throw new Error('项目预算账户不存在');

  const settledAmount = Math.min(account.frozen_credits, snapshot.amount);
  const succeeded = input.terminalStatus === 'succeeded';
  const nextFrozen = Math.max(0, account.frozen_credits - settledAmount);
  const nextUsed = succeeded ? account.used_credits + settledAmount : account.used_credits;
  const nextAvailable = account.budget_credits - nextUsed - nextFrozen;
  const nextStatus = nextAvailable <= 0 ? 'exhausted' : 'active';

  const updated = await tx.projectBudgetAccount.update({
    where: { id: account.id },
    data: {
      used_credits: nextUsed,
      frozen_credits: nextFrozen,
      status: account.status === 'cancelled' ? account.status : nextStatus,
    },
  });

  await tx.projectBudgetLedger.create({
    data: {
      project_id: input.projectId,
      account_id: account.id,
      type: succeeded ? 'task_success_deduct' : 'task_failed_refund',
      amount: succeeded ? -settledAmount : settledAmount,
      budget_before: account.budget_credits,
      budget_after: updated.budget_credits,
      used_before: account.used_credits,
      used_after: updated.used_credits,
      frozen_before: account.frozen_credits,
      frozen_after: updated.frozen_credits,
      related_task_id: input.taskId,
      operator_id: input.operatorId || null,
      reason: succeeded
        ? `任务成功，实扣项目预算 ${settledAmount} 点`
        : `任务${input.terminalStatus === 'failed' ? '失败' : '取消'}，释放项目预算 ${settledAmount} 点`,
      idempotency_key: idempotencyKey,
      metadata_json: JSON.stringify({ snapshot, terminal_status: input.terminalStatus }),
    },
  });

  return {
    actualCost: succeeded ? settledAmount : 0,
    refundedAmount: succeeded ? 0 : settledAmount,
    budgetBefore: account.budget_credits,
    budgetAfter: updated.budget_credits,
    usedBefore: account.used_credits,
    usedAfter: updated.used_credits,
    frozenBefore: account.frozen_credits,
    frozenAfter: updated.frozen_credits,
    snapshot,
  };
}
