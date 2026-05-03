import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { refreshTaskFromProvider } from '@/lib/video-task-admin';

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

    const task = await prisma.videoTask.findFirst({
      where: {
        id: taskId,
        user_id: user.id,
      },
    });

    if (!task) {
      return NextResponse.json(
        { error: 'Task not found', message: `Task ${taskId} not found or not accessible` },
        { status: 404 }
      );
    }

    if (task.provider_task_id) {
      try {
        const updatedTask = await refreshTaskFromProvider(taskId);
        const ledgerEntries = await getTaskLedgerEntries(taskId, user.id);

        return NextResponse.json({
          ...updatedTask,
          ledger_entries: ledgerEntries,
        });
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
        const ledgerEntries = await getTaskLedgerEntries(taskId, user.id);

        return NextResponse.json({
          ...updatedTask,
          error_message: updatedTask.error_message || (apiError instanceof Error ? apiError.message : 'Failed to query status'),
          ledger_entries: ledgerEntries,
        });
      }
    }

    const ledgerEntries = await getTaskLedgerEntries(taskId, user.id);

    return NextResponse.json({
      ...task,
      ledger_entries: ledgerEntries,
    });
  } catch (error) {
    console.error('Get task status error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

async function getTaskLedgerEntries(taskId: string, userId: string) {
  return prisma.creditLedger.findMany({
    where: {
      user_id: userId,
      related_task_id: taskId,
    },
    orderBy: { created_at: 'asc' },
  });
}
