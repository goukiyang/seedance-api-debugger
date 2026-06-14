import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanManageProject, assertCanViewProject, logProjectAction } from '@/lib/projects/permissions';
import { adjustProjectBudget, ensureProjectBudgetAccount, getProjectBudgetSummary } from '@/lib/projects/budget';

export const dynamic = 'force-dynamic';

function parseAmount(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const BUDGET_STATUSES = new Set(['active', 'frozen', 'exhausted', 'cancelled']);
const RECONCILIATION_STATUSES = new Set(['normal', 'pending', 'abnormal', 'reconciled']);

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    await assertCanViewProject(user, params.id);
    const summary = await prisma.$transaction((tx) => getProjectBudgetSummary(tx, params.id));
    return NextResponse.json({ budget: summary });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[ProjectBudget] Detail error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    if (user.role !== 'admin') {
      return NextResponse.json({ error: '只有管理员可以直接调整项目预算，负责人追加预算需走审批' }, { status: 403 });
    }

    const access = await assertCanManageProject(user, params.id);
    const project = access.project;
    if (!project) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
    if (project.type !== 'public') {
      return NextResponse.json({ error: '只有公共项目使用项目预算池' }, { status: 400 });
    }

    const body = await request.json();
    const hasBudget = body.budget_credits !== undefined || body.budgetCredits !== undefined;
    const targetBudget = hasBudget ? parseAmount(body.budget_credits ?? body.budgetCredits) : null;
    if (hasBudget && (targetBudget === null || targetBudget < 0)) {
      return NextResponse.json({ error: 'budget_credits 必须是非负数字' }, { status: 400 });
    }
    const nextStatus = optionalString(body.status);
    const nextReconciliationStatus = optionalString(body.reconciliation_status ?? body.reconciliationStatus);
    const freezeReason = optionalString(body.freeze_reason ?? body.freezeReason);
    if (nextStatus && !BUDGET_STATUSES.has(nextStatus)) {
      return NextResponse.json({ error: '预算账户状态无效' }, { status: 400 });
    }
    if (nextReconciliationStatus && !RECONCILIATION_STATUSES.has(nextReconciliationStatus)) {
      return NextResponse.json({ error: '预算对账状态无效' }, { status: 400 });
    }
    if (nextStatus === 'frozen' && !freezeReason) {
      return NextResponse.json({ error: '冻结预算账户必须填写原因' }, { status: 400 });
    }
    if (!hasBudget && !nextStatus && !nextReconciliationStatus) {
      return NextResponse.json({ error: '缺少预算或状态变更内容' }, { status: 400 });
    }

    const reason = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim()
      : '管理员调整公共项目预算';
    const idempotencyKey = typeof body.idempotency_key === 'string' && body.idempotency_key.trim()
      ? body.idempotency_key.trim()
      : null;

    const budget = await prisma.$transaction(async (tx) => {
      const before = await getProjectBudgetSummary(tx, params.id);
      const delta = targetBudget === null ? 0 : targetBudget - before.budget_credits;
      if (delta !== 0) {
        await adjustProjectBudget(tx, {
          projectId: params.id,
          amount: delta,
          operatorId: user.id,
          reason,
          idempotencyKey,
        });
      }
      if (nextStatus || nextReconciliationStatus) {
        const account = await ensureProjectBudgetAccount(tx, params.id, user.id);
        await tx.projectBudgetAccount.update({
          where: { id: account.id },
          data: {
            ...(nextStatus ? {
              status: nextStatus,
              freeze_reason: nextStatus === 'frozen' ? freezeReason : null,
            } : {}),
            ...(nextReconciliationStatus ? { reconciliation_status: nextReconciliationStatus } : {}),
          },
        });
      }
      return getProjectBudgetSummary(tx, params.id);
    });

    await logProjectAction(user.id, 'project_budget_update', 'project', params.id, {
      budget_credits: targetBudget,
      status: nextStatus,
      freeze_reason: nextStatus === 'frozen' ? freezeReason : undefined,
      reconciliation_status: nextReconciliationStatus,
      reason,
    });

    return NextResponse.json({ budget });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[ProjectBudget] Update error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
