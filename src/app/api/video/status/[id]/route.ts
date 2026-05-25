import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getVideoTaskStatus, mapProviderStatus } from '@/lib/provider/jimeng';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { recordProviderReportedCharge, recordTaskCostSettlement } from '@/lib/costs/ledger';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const taskId = params.id;
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: '未登录', message: '请先登录' }, { status: 401 });
    }

    const task = await prisma.videoTask.findUnique({
      where: { id: taskId },
      include: {
        project: { select: { id: true, name: true, type: true } },
      },
    });

    if (!task) {
      return NextResponse.json(
        { error: 'Task not found', message: `Task ${taskId} not found` },
        { status: 404 }
      );
    }

    try {
      await assertCanViewTask(user, task);
    } catch (error) {
      if (error instanceof AuthError) {
        return NextResponse.json({ error: '权限不足', message: error.message }, { status: error.status });
      }
      throw error;
    }

    if (task.provider_task_id) {
      try {
        const statusResult = await getVideoTaskStatus(task.provider_task_id);

        const updateData: Record<string, unknown> = {
          provider_status: statusResult.provider_status,
          local_status: statusResult.local_status,
          raw_status_response: JSON.stringify(statusResult.raw),
        };
        addProviderBillingUpdate(updateData, statusResult);

        if (statusResult.result_video_url) {
          updateData.result_video_url = statusResult.result_video_url;
        }
        if (statusResult.result_last_frame_url) {
          updateData.result_last_frame_url = statusResult.result_last_frame_url;
        }
        if (statusResult.provider_model) {
          updateData.model = statusResult.provider_model;
        }
        if (statusResult.seed !== undefined) {
          updateData.seed = statusResult.seed;
        }
        if (statusResult.resolution) {
          updateData.resolution = statusResult.resolution;
        }
        if (statusResult.ratio) {
          updateData.ratio = statusResult.ratio;
        }
        if (statusResult.duration !== undefined) {
          updateData.duration = statusResult.duration;
        }
        if (statusResult.error_message) {
          updateData.error_message = statusResult.error_message;
        }

        const isTerminal = ['succeeded', 'failed', 'cancelled'].includes(statusResult.local_status);
        if (isTerminal && !task.completed_at) {
          updateData.completed_at = new Date();
        }

        await prisma.videoTask.update({
          where: { id: taskId },
          data: updateData,
        });

        // --- Settlement: only for user-bound tasks with frozen_cost > 0 ---
        if (isTerminal && task.user_id && task.frozen_cost && task.frozen_cost > 0) {
          await settleTask(taskId, task.user_id, task.frozen_cost, statusResult.local_status);
        }

        await recordOfficialProviderCharge(taskId, user.id, statusResult);

        const responseTask = await prisma.videoTask.findUnique({
          where: { id: taskId },
          include: {
            project: { select: { id: true, name: true, type: true } },
          },
        });

        return NextResponse.json(responseTask);
      } catch (apiError) {
        console.error('Provider status query error:', apiError);

        const updateData: Record<string, unknown> = {
          provider_status: 'unknown',
          local_status: 'running',
          raw_status_response: JSON.stringify({ error: apiError instanceof Error ? apiError.message : String(apiError) }),
        };
        await prisma.videoTask.update({
          where: { id: taskId },
          data: updateData,
        });
        const updatedTask = await prisma.videoTask.findUnique({
          where: { id: taskId },
          include: {
            project: { select: { id: true, name: true, type: true } },
          },
        });
        if (!updatedTask) {
          return NextResponse.json(
            { error: 'Task not found', message: `Task ${taskId} not found` },
            { status: 404 },
          );
        }
        return NextResponse.json({
          ...updatedTask,
          error_message: updatedTask.error_message || (apiError instanceof Error ? apiError.message : 'Failed to query status'),
        });
      }
    }

    return NextResponse.json(task);
  } catch (error) {
    console.error('Get task status error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

type ProviderBillingStatus = {
  provider_task_id?: string | null;
  usage?: unknown;
  actual_cost?: number | string | null;
  currency_or_credit_type?: string | null;
  billing_status?: string | null;
  billing_time?: number | string | null;
  client_request_id?: string | null;
  raw?: unknown;
};

function normalizeCurrency(value: unknown) {
  if (typeof value !== 'string') return null;
  const currency = value.trim().toUpperCase();
  if (!currency) return null;
  if (!/^[A-Z0-9_-]{2,32}$/.test(currency)) return null;
  return currency;
}

function normalizeActualCost(value: unknown) {
  const amount = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() ? Number(value) : NaN);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return amount;
}

function toAmountMicros(actualCost: number) {
  return Math.round(actualCost * 1_000_000);
}

function normalizeBillingTime(value: unknown) {
  const numericValue = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() ? Number(value.trim()) : NaN);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return null;
  return Math.floor(numericValue);
}

function billingTimeToDate(value: number | null) {
  if (!value) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function stringifySnapshot(value: unknown) {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function addProviderBillingUpdate(updateData: Record<string, unknown>, statusResult: ProviderBillingStatus) {
  const currency = normalizeCurrency(statusResult.currency_or_credit_type);
  const actualCost = normalizeActualCost(statusResult.actual_cost);
  const billingTime = normalizeBillingTime(statusResult.billing_time);
  const amountMicros = actualCost === null ? null : toAmountMicros(actualCost);

  if (statusResult.usage !== undefined) {
    updateData.provider_usage_snapshot = stringifySnapshot(statusResult.usage);
  }
  if (statusResult.billing_status) {
    updateData.provider_billing_status = statusResult.billing_status;
  }
  if (billingTime !== null) {
    updateData.provider_billing_time = billingTimeToDate(billingTime);
  }
  if (statusResult.client_request_id) {
    updateData.provider_client_request_id = statusResult.client_request_id;
  }
  if (currency) {
    updateData.provider_cost_currency = currency;
  }
  if (amountMicros !== null) {
    updateData.provider_official_amount_micros = amountMicros;
    updateData.provider_final_amount_micros = amountMicros;
  }
}

function buildProviderReportedCharge(statusResult: ProviderBillingStatus) {
  const actualCost = normalizeActualCost(statusResult.actual_cost);
  const currency = normalizeCurrency(statusResult.currency_or_credit_type);
  if (actualCost === null || !currency) return null;

  const billingStatus = typeof statusResult.billing_status === 'string'
    ? statusResult.billing_status
    : null;
  const billingTime = normalizeBillingTime(statusResult.billing_time);
  const clientRequestId = typeof statusResult.client_request_id === 'string'
    ? statusResult.client_request_id
    : null;
  const providerTaskId = typeof statusResult.provider_task_id === 'string'
    ? statusResult.provider_task_id
    : null;
  const billingDate = billingTimeToDate(billingTime);

  return {
    actualCost,
    currency,
    billingStatus,
    billingTime: billingDate ?? billingTime,
    usage: statusResult.usage,
    clientRequestId,
    providerTaskId,
    raw: statusResult.raw,
  };
}

async function recordOfficialProviderCharge(
  taskId: string,
  createdBy: string,
  statusResult: ProviderBillingStatus,
) {
  const charge = buildProviderReportedCharge(statusResult);
  if (!charge) return;

  await prisma.$transaction(async (tx) => {
    const freshTask = await tx.videoTask.findUnique({ where: { id: taskId } });
    if (!freshTask) return;

    await recordProviderReportedCharge(tx, freshTask, charge, createdBy);
  });
}

async function settleTask(
  taskId: string,
  userId: string,
  frozenAmount: number,
  terminalStatus: string,
) {
  await prisma.$transaction(async (tx) => {
    // Re-read task inside transaction to ensure idempotency
    const freshTask = await tx.videoTask.findUnique({ where: { id: taskId } });
    if (!freshTask || !freshTask.frozen_cost || freshTask.frozen_cost <= 0) return;

    const account = await tx.creditAccount.findUnique({ where: { user_id: userId } });
    if (!account) return;

    // Double-check: no duplicate ledger entry for this task settlement
    const existingSettlement = await tx.creditLedger.findFirst({
      where: {
        related_task_id: taskId,
        type: { in: ['task_success_deduct', 'task_failed_refund'] },
      },
    });
    if (existingSettlement) return;

    const frozenBefore = account.frozen_credits;
    const frozenAfter = Math.max(0, frozenBefore - frozenAmount);

    if (terminalStatus === 'succeeded') {
      const actualCost = frozenAmount;

      await tx.videoTask.update({
        where: { id: taskId },
        data: { frozen_cost: 0, actual_cost: actualCost },
      });

      await tx.creditAccount.update({
        where: { user_id: userId },
        data: {
          balance: account.balance - actualCost,
          frozen_credits: frozenAfter,
          monthly_used: account.monthly_used + actualCost,
          total_used: account.total_used + actualCost,
        },
      });

      await tx.creditLedger.create({
        data: {
          user_id: userId,
          type: 'task_success_deduct',
          amount: -actualCost,
          balance_before: account.balance,
          balance_after: account.balance - actualCost,
          frozen_before: frozenBefore,
          frozen_after: frozenAfter,
          related_task_id: taskId,
          reason: `任务成功，扣除 ${actualCost} 点`,
        },
      });

      await recordTaskCostSettlement(tx, freshTask, terminalStatus, userId);
    } else {
      // failed / cancelled → full refund
      await tx.videoTask.update({
        where: { id: taskId },
        data: { frozen_cost: 0, refund_amount: frozenAmount },
      });

      await tx.creditAccount.update({
        where: { user_id: userId },
        data: { frozen_credits: frozenAfter },
      });

      await tx.creditLedger.create({
        data: {
          user_id: userId,
          type: 'task_failed_refund',
          amount: frozenAmount,
          balance_before: account.balance,
          balance_after: account.balance,
          frozen_before: frozenBefore,
          frozen_after: frozenAfter,
          related_task_id: taskId,
          reason: `任务${terminalStatus === 'failed' ? '失败' : '取消'}，返还冻结 ${frozenAmount} 点`,
        },
      });

      await recordTaskCostSettlement(tx, freshTask, terminalStatus, userId);
    }
  });
}
