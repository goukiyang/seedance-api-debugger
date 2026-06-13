import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanManageProject, assertCanViewProject, logProjectAction } from '@/lib/projects/permissions';
import { adjustProjectBudget, getProjectBudgetSummary } from '@/lib/projects/budget';

export const dynamic = 'force-dynamic';

function parseAmount(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

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
    const targetBudget = parseAmount(body.budget_credits ?? body.budgetCredits);
    if (targetBudget === null || targetBudget < 0) {
      return NextResponse.json({ error: 'budget_credits 必须是非负数字' }, { status: 400 });
    }

    const reason = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim()
      : '管理员调整公共项目预算';
    const idempotencyKey = typeof body.idempotency_key === 'string' && body.idempotency_key.trim()
      ? body.idempotency_key.trim()
      : null;

    const budget = await prisma.$transaction(async (tx) => {
      const before = await getProjectBudgetSummary(tx, params.id);
      const delta = targetBudget - before.budget_credits;
      if (delta !== 0) {
        await adjustProjectBudget(tx, {
          projectId: params.id,
          amount: delta,
          operatorId: user.id,
          reason,
          idempotencyKey,
        });
      }
      return getProjectBudgetSummary(tx, params.id);
    });

    await logProjectAction(user.id, 'project_budget_update', 'project', params.id, {
      budget_credits: targetBudget,
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
