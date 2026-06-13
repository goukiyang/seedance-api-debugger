import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';
import { buildRefundRelevantWhere, getLongFrozenCutoff, getTaskAttentionFlags } from '@/lib/admin-task-attention';

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_FLOW_DAYS = 7;
const RECENT_TASK_LIMIT = 8;
const TOP_USAGE_USERS_LIMIT = 5;

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function formatDayKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function sumNumber(values: Array<number | null | undefined>): number {
  return values.reduce<number>((total, value) => total + (typeof value === 'number' ? value : 0), 0);
}

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const longFrozenCutoff = getLongFrozenCutoff();
  const now = new Date();
  const past24h = new Date(now.getTime() - DAY_MS);
  const flowStart = startOfDay(new Date(now.getTime() - (RECENT_FLOW_DAYS - 1) * DAY_MS));

  const [
    abnormalLogs,
    stillFrozenCount,
    longFrozenCount,
    failedCount,
    refundRelevantCount,
    runningCount,
    submittedCount,
    created24hCount,
    completed24hCount,
    failed24hCount,
    cancelled24hCount,
    globalAttentionTasks,
    recentTasks,
    flowTasks,
    creditAggregate,
    creditAccounts,
    topUsageAccounts,
    deductionLedgers7d,
    refundLedgers7d,
    grantLedgers7d,
    userTotalCount,
    disabledUserCount,
    activeResourceCount,
    disabledResourceCount,
    activePricingCount,
    disabledPricingCount,
  ] = await Promise.all([
    prisma.operationLog.findMany({
      where: {
        target_type: 'VideoTask',
        action: { in: ['task_mark_abnormal', 'task_mark_failed'] },
        target_id: { not: null },
      },
      select: { target_id: true },
    }),
    prisma.videoTask.count({ where: { frozen_cost: { gt: 0 } } }),
    prisma.videoTask.count({ where: { frozen_cost: { gt: 0 }, created_at: { lte: longFrozenCutoff } } }),
    prisma.videoTask.count({ where: { local_status: 'failed' } }),
    prisma.videoTask.count({ where: buildRefundRelevantWhere() }),
    prisma.videoTask.count({ where: { local_status: 'running' } }),
    prisma.videoTask.count({ where: { local_status: 'submitted' } }),
    prisma.videoTask.count({ where: { created_at: { gte: past24h } } }),
    prisma.videoTask.count({ where: { completed_at: { gte: past24h }, local_status: 'succeeded' } }),
    prisma.videoTask.count({ where: { completed_at: { gte: past24h }, local_status: 'failed' } }),
    prisma.videoTask.count({ where: { completed_at: { gte: past24h }, local_status: 'cancelled' } }),
    prisma.videoTask.findMany({
      where: {
        OR: [
          { local_status: 'failed' },
          { frozen_cost: { gt: 0 }, created_at: { lte: longFrozenCutoff } },
          buildRefundRelevantWhere(),
        ],
      },
      select: { id: true },
    }),
    prisma.videoTask.findMany({
      where: {
        OR: [
          { local_status: { in: ['submitted', 'running', 'failed'] } },
          { frozen_cost: { gt: 0 } },
          { created_at: { gte: past24h } },
        ],
      },
      include: {
        user: { select: { id: true, name: true, username: true, email: true } },
      },
      orderBy: [{ frozen_cost: 'desc' }, { created_at: 'desc' }],
      take: RECENT_TASK_LIMIT,
    }),
    prisma.videoTask.findMany({
      where: {
        OR: [
          { created_at: { gte: flowStart } },
          { completed_at: { gte: flowStart } },
        ],
      },
      select: {
        id: true,
        created_at: true,
        completed_at: true,
        local_status: true,
      },
      orderBy: { created_at: 'asc' },
    }),
    prisma.creditAccount.aggregate({
      _sum: {
        balance: true,
        frozen_credits: true,
        monthly_used: true,
        total_used: true,
      },
      _count: { id: true },
    }),
    prisma.creditAccount.findMany({
      select: {
        balance: true,
        frozen_credits: true,
      },
    }),
    prisma.creditAccount.findMany({
      where: {
        OR: [
          { monthly_used: { gt: 0 } },
          { frozen_credits: { gt: 0 } },
        ],
      },
      take: TOP_USAGE_USERS_LIMIT,
      orderBy: [
        { monthly_used: 'desc' },
        { frozen_credits: 'desc' },
        { total_used: 'desc' },
      ],
      select: {
        user_id: true,
        balance: true,
        frozen_credits: true,
        monthly_used: true,
        total_used: true,
        user: {
          select: {
            id: true,
            name: true,
            username: true,
            email: true,
          },
        },
      },
    }),
    prisma.creditLedger.findMany({
      where: {
        type: 'task_success_deduct',
        created_at: { gte: flowStart },
      },
      select: { amount: true },
    }),
    prisma.creditLedger.findMany({
      where: {
        type: { in: ['task_failed_refund', 'manual_refund'] },
        created_at: { gte: flowStart },
      },
      select: { amount: true },
    }),
    prisma.creditLedger.findMany({
      where: {
        type: { in: ['admin_grant', 'system_adjust', 'periodic_grant'] },
        created_at: { gte: flowStart },
      },
      select: { amount: true },
    }),
    prisma.user.count(),
    prisma.user.count({ where: { status: 'disabled' } }),
    prisma.sharedResource.count({ where: { status: 'active' } }),
    prisma.sharedResource.count({ where: { status: 'disabled' } }),
    prisma.pricingRule.count({ where: { status: 'active' } }),
    prisma.pricingRule.count({ where: { status: 'disabled' } }),
  ]);

  const abnormalTaskIds = new Set(
    abnormalLogs
      .map((log) => log.target_id)
      .filter((targetId): targetId is string => Boolean(targetId)),
  );

  const recentTaskIds = recentTasks.map((task) => task.id);
  const recentTaskOperations = recentTaskIds.length > 0
    ? await prisma.operationLog.findMany({
        where: {
          target_type: 'VideoTask',
          target_id: { in: recentTaskIds },
          action: { in: ['task_mark_abnormal', 'task_mark_failed', 'task_note', 'task_manual_refund'] },
        },
        orderBy: { created_at: 'desc' },
        include: {
          operator: { select: { id: true, name: true, username: true } },
        },
      })
    : [];

  const operationByTaskId = new Map<string, typeof recentTaskOperations>();
  for (const operation of recentTaskOperations) {
    const targetId = operation.target_id || '';
    const list = operationByTaskId.get(targetId) || [];
    list.push(operation);
    operationByTaskId.set(targetId, list);
  }

  const exceptionTaskIds = new Set<string>(abnormalTaskIds);
  for (const task of globalAttentionTasks) exceptionTaskIds.add(task.id);

  const recentFlowMap = new Map<string, {
    date: string;
    created_count: number;
    completed_count: number;
    failed_count: number;
    cancelled_count: number;
  }>();

  for (let index = 0; index < RECENT_FLOW_DAYS; index += 1) {
    const currentDay = new Date(flowStart.getTime() + index * DAY_MS);
    recentFlowMap.set(formatDayKey(currentDay), {
      date: formatDayKey(currentDay),
      created_count: 0,
      completed_count: 0,
      failed_count: 0,
      cancelled_count: 0,
    });
  }

  for (const task of flowTasks) {
    const createdKey = formatDayKey(startOfDay(new Date(task.created_at)));
    const createdBucket = recentFlowMap.get(createdKey);
    if (createdBucket) createdBucket.created_count += 1;

    if (task.completed_at) {
      const completedKey = formatDayKey(startOfDay(new Date(task.completed_at)));
      const completedBucket = recentFlowMap.get(completedKey);
      if (completedBucket) {
        if (task.local_status === 'succeeded') completedBucket.completed_count += 1;
        if (task.local_status === 'failed') completedBucket.failed_count += 1;
        if (task.local_status === 'cancelled') completedBucket.cancelled_count += 1;
      }
    }
  }

  const accountsWithFrozenCount = creditAccounts.filter((account) => (account.frozen_credits ?? 0) > 0).length;
  const atRiskAccountCount = creditAccounts.filter((account) => (account.frozen_credits ?? 0) > 0 && account.balance <= account.frozen_credits).length;

  return NextResponse.json({
    generated_at: now.toISOString(),
    summary: {
      attention_now_count: exceptionTaskIds.size,
      abnormal_count: abnormalTaskIds.size,
      still_frozen_count: stillFrozenCount,
      long_frozen_count: longFrozenCount,
      failed_count: failedCount,
      refund_relevant_count: refundRelevantCount,
      submitted_count: submittedCount,
      running_count: runningCount,
    },
    queue_snapshot: {
      submitted_count: submittedCount,
      running_count: runningCount,
      created_24h_count: created24hCount,
      completed_24h_count: completed24hCount,
      failed_24h_count: failed24hCount,
      cancelled_24h_count: cancelled24hCount,
    },
    recent_tasks: recentTasks.map((task) => ({
      id: task.id,
      provider: task.provider,
      model: task.model,
      prompt: task.prompt,
      resolution: task.resolution,
      duration: task.duration,
      local_status: task.local_status,
      provider_status: task.provider_status,
      estimated_cost: task.estimated_cost,
      actual_cost: task.actual_cost,
      frozen_cost: task.frozen_cost,
      refund_amount: task.refund_amount,
      created_at: task.created_at,
      completed_at: task.completed_at,
      user: task.user,
      attention_flags: getTaskAttentionFlags(task, abnormalTaskIds),
      latest_operation: (operationByTaskId.get(task.id) || [])[0] || null,
    })),
    recent_flow: Array.from(recentFlowMap.values()),
    credit_usage: {
      total_accounts: creditAggregate._count.id,
      total_balance: creditAggregate._sum.balance ?? 0,
      total_frozen: creditAggregate._sum.frozen_credits ?? 0,
      current_monthly_used_field_total: creditAggregate._sum.monthly_used ?? 0,
      total_used: creditAggregate._sum.total_used ?? 0,
      accounts_with_frozen_count: accountsWithFrozenCount,
      at_risk_account_count: atRiskAccountCount,
      deducted_7d: Math.abs(sumNumber(deductionLedgers7d.map((entry) => entry.amount))),
      refunded_7d: sumNumber(refundLedgers7d.map((entry) => entry.amount)),
      granted_7d: sumNumber(grantLedgers7d.map((entry) => entry.amount)),
      top_usage_users: topUsageAccounts.map((account) => ({
        user_id: account.user_id,
        user: account.user,
        balance: account.balance,
        frozen_credits: account.frozen_credits,
        monthly_used: account.monthly_used,
        total_used: account.total_used,
      })),
    },
    quick_links: {
      users_total_count: userTotalCount,
      disabled_user_count: disabledUserCount,
      active_resource_count: activeResourceCount,
      disabled_resource_count: disabledResourceCount,
      active_pricing_rule_count: activePricingCount,
      disabled_pricing_rule_count: disabledPricingCount,
    },
  });
}
