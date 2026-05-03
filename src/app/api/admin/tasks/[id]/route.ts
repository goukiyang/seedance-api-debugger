import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getAdminUser, errorJson } from '@/lib/auth/api-helpers';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const task = await prisma.videoTask.findUnique({
    where: { id: params.id },
    include: {
      user: {
        select: { id: true, name: true, username: true, email: true },
      },
    },
  });

  if (!task) return errorJson('任务不存在', 404);

  const [ledgerEntries, operationLogs] = await Promise.all([
    prisma.creditLedger.findMany({
      where: { related_task_id: params.id },
      include: {
        user: { select: { id: true, name: true, username: true } },
      },
      orderBy: { created_at: 'asc' },
    }),
    prisma.operationLog.findMany({
      where: {
        target_type: 'VideoTask',
        target_id: params.id,
      },
      include: {
        operator: { select: { id: true, name: true, username: true } },
      },
      orderBy: { created_at: 'desc' },
    }),
  ]);

  return NextResponse.json({
    ...task,
    attention_flags: {
      abnormal: operationLogs.some((log) => log.action === 'task_mark_abnormal' || log.action === 'task_mark_failed'),
      still_frozen: (task.frozen_cost ?? 0) > 0,
      refund_relevant:
        ((task.frozen_cost ?? 0) > 0 && ['failed', 'cancelled'].includes(task.local_status)) ||
        ((task.actual_cost ?? 0) > 0 && (task.refund_amount ?? 0) === 0),
    },
    ledger_entries: ledgerEntries,
    operation_logs: operationLogs,
  });
}
