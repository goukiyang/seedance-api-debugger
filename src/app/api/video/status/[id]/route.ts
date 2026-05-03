import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getVideoTaskStatus, mapProviderStatus } from '@/lib/provider/jimeng';
import { getSession } from '@/lib/auth/session';

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
    });

    if (!task) {
      return NextResponse.json(
        { error: 'Task not found', message: `Task ${taskId} not found` },
        { status: 404 }
      );
    }

    if (user.role !== 'admin') {
      if (!task.user_id) {
        return NextResponse.json({ error: '权限不足', message: '无权查看此任务' }, { status: 403 });
      }
      if (user.id !== task.user_id) {
        return NextResponse.json({ error: '权限不足', message: '无权查看此任务' }, { status: 403 });
      }
    }

    if (task.provider_task_id) {
      try {
        const statusResult = await getVideoTaskStatus(task.provider_task_id);

        const updateData: Record<string, unknown> = {
          provider_status: statusResult.provider_status,
          local_status: statusResult.local_status,
          raw_status_response: JSON.stringify(statusResult.raw),
        };

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

        const updatedTask = await prisma.videoTask.update({
          where: { id: taskId },
          data: updateData,
        });

        // --- Settlement: only for user-bound tasks with frozen_cost > 0 ---
        if (isTerminal && task.user_id && task.frozen_cost && task.frozen_cost > 0) {
          await settleTask(taskId, task.user_id, task.frozen_cost, statusResult.local_status);
        }

        return NextResponse.json(updatedTask);
      } catch (apiError) {
        console.error('Provider status query error:', apiError);

        const updateData: Record<string, unknown> = {
          provider_status: 'unknown',
          local_status: 'running',
          raw_status_response: JSON.stringify({ error: apiError instanceof Error ? apiError.message : String(apiError) }),
        };
        const updatedTask = await prisma.videoTask.update({
          where: { id: taskId },
          data: updateData,
        });
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
    }
  });
}
