import type { Prisma, VideoTask } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getVideoTaskStatus } from '@/lib/provider/jimeng';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

function buildProviderTaskUpdate(task: VideoTask, statusResult: Awaited<ReturnType<typeof getVideoTaskStatus>>) {
  const updateData: Prisma.VideoTaskUpdateInput = {
    provider_status: statusResult.provider_status,
    local_status: statusResult.local_status,
    raw_status_response: JSON.stringify(statusResult.raw),
  };

  if (statusResult.result_video_url) updateData.result_video_url = statusResult.result_video_url;
  if (statusResult.result_last_frame_url) updateData.result_last_frame_url = statusResult.result_last_frame_url;
  if (statusResult.provider_model) updateData.model = statusResult.provider_model;
  if (statusResult.seed !== undefined) updateData.seed = statusResult.seed;
  if (statusResult.resolution) updateData.resolution = statusResult.resolution;
  if (statusResult.ratio) updateData.ratio = statusResult.ratio;
  if (statusResult.duration !== undefined) updateData.duration = statusResult.duration;
  if (statusResult.error_message) updateData.error_message = statusResult.error_message;

  if (TERMINAL_STATUSES.has(statusResult.local_status) && !task.completed_at) {
    updateData.completed_at = new Date();
  }

  return updateData;
}

export async function refreshTaskFromProvider(taskId: string) {
  const task = await prisma.videoTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error('任务不存在');
  if (!task.provider_task_id) return task;

  try {
    const statusResult = await getVideoTaskStatus(task.provider_task_id);
    const updatedTask = await prisma.videoTask.update({
      where: { id: taskId },
      data: buildProviderTaskUpdate(task, statusResult),
    });

    if (
      TERMINAL_STATUSES.has(statusResult.local_status) &&
      task.user_id &&
      task.frozen_cost &&
      task.frozen_cost > 0
    ) {
      await settleTask(taskId, task.user_id, task.frozen_cost, statusResult.local_status);
      return prisma.videoTask.findUniqueOrThrow({ where: { id: taskId } });
    }

    return updatedTask;
  } catch (error) {
    const updatedTask = await prisma.videoTask.update({
      where: { id: taskId },
      data: {
        provider_status: 'unknown',
        local_status: TERMINAL_STATUSES.has(task.local_status) ? task.local_status : 'running',
        raw_status_response: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      },
    });
    return updatedTask;
  }
}

export async function settleTask(
  taskId: string,
  userId: string,
  frozenAmount: number,
  terminalStatus: string,
) {
  await prisma.$transaction(async (tx) => {
    const freshTask = await tx.videoTask.findUnique({ where: { id: taskId } });
    if (!freshTask || !freshTask.frozen_cost || freshTask.frozen_cost <= 0) return;

    const account = await tx.creditAccount.findUnique({ where: { user_id: userId } });
    if (!account) return;

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
    } else {
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
    }
  });
}

export async function addTaskOperationLog(input: {
  operatorId: string;
  taskId: string;
  action: string;
  reason: string;
  extra?: Record<string, unknown>;
}) {
  await prisma.operationLog.create({
    data: {
      operator_id: input.operatorId,
      action: input.action,
      target_type: 'VideoTask',
      target_id: input.taskId,
      detail: JSON.stringify({
        reason: input.reason,
        ...(input.extra || {}),
      }),
    },
  });
}

export async function manualRefundTask(input: {
  taskId: string;
  operatorId: string;
  reason: string;
}) {
  return prisma.$transaction(async (tx) => {
    const task = await tx.videoTask.findUnique({ where: { id: input.taskId } });
    if (!task) throw new Error('任务不存在');
    if (!task.user_id) throw new Error('任务未关联用户，无法退款');

    const existingRefund = await tx.creditLedger.findFirst({
      where: {
        related_task_id: input.taskId,
        type: { in: ['manual_refund', 'task_failed_refund'] },
      },
    });
    if (existingRefund || (task.refund_amount ?? 0) > 0) {
      return {
        alreadyRefunded: true,
        refundAmount: task.refund_amount ?? existingRefund?.amount ?? 0,
        mode: 'already_refunded',
      };
    }

    const account = await tx.creditAccount.findUnique({ where: { user_id: task.user_id } });
    if (!account) throw new Error('点数账户不存在');

    let refundAmount = 0;
    let balanceAfter = account.balance;
    let frozenAfter = account.frozen_credits;
    let mode: 'release_frozen' | 'balance_refund';

    if (task.frozen_cost && task.frozen_cost > 0) {
      refundAmount = task.frozen_cost;
      frozenAfter = Math.max(0, account.frozen_credits - refundAmount);
      mode = 'release_frozen';

      await tx.creditAccount.update({
        where: { user_id: task.user_id },
        data: { frozen_credits: frozenAfter },
      });

      await tx.videoTask.update({
        where: { id: input.taskId },
        data: { frozen_cost: 0, refund_amount: (task.refund_amount ?? 0) + refundAmount },
      });
    } else if (task.actual_cost && task.actual_cost > 0) {
      refundAmount = task.actual_cost;
      balanceAfter = account.balance + refundAmount;
      mode = 'balance_refund';

      await tx.creditAccount.update({
        where: { user_id: task.user_id },
        data: {
          balance: balanceAfter,
          monthly_used: Math.max(0, account.monthly_used - refundAmount),
          total_used: Math.max(0, account.total_used - refundAmount),
        },
      });

      await tx.videoTask.update({
        where: { id: input.taskId },
        data: { refund_amount: (task.refund_amount ?? 0) + refundAmount },
      });
    } else {
      throw new Error('任务没有可退款的冻结点数或已结算点数');
    }

    await tx.creditLedger.create({
      data: {
        user_id: task.user_id,
        type: 'manual_refund',
        amount: refundAmount,
        balance_before: account.balance,
        balance_after: balanceAfter,
        frozen_before: account.frozen_credits,
        frozen_after: frozenAfter,
        related_task_id: input.taskId,
        operator_id: input.operatorId,
        reason: input.reason,
      },
    });

    await tx.operationLog.create({
      data: {
        operator_id: input.operatorId,
        action: 'task_manual_refund',
        target_type: 'VideoTask',
        target_id: input.taskId,
        detail: JSON.stringify({
          reason: input.reason,
          refund_amount: refundAmount,
          mode,
          local_status: task.local_status,
        }),
      },
    });

    return {
      alreadyRefunded: false,
      refundAmount,
      mode,
    };
  });
}
