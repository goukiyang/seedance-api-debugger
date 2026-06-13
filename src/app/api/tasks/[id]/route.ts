import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { recordContentAuditLog } from '@/lib/content-audit';
import {
  normalizeTaskDeleteReason,
  TASK_RETENTION_ADMIN_HIDDEN,
  TASK_RETENTION_USER_DELETED,
} from '@/lib/tasks/retention';

export const dynamic = 'force-dynamic';

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const reason = normalizeTaskDeleteReason(body.reason) || '用户从任务列表移除';

    const task = await prisma.videoTask.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        user_id: true,
        owner_user_id: true,
        project_id: true,
        retention_status: true,
      },
    });

    if (!task) return NextResponse.json({ error: '任务不存在' }, { status: 404 });

    const ownerId = task.owner_user_id || task.user_id;
    if (ownerId !== user.id) {
      return NextResponse.json({ error: '只能移除自己的任务' }, { status: 403 });
    }

    if (task.retention_status === TASK_RETENTION_ADMIN_HIDDEN) {
      return NextResponse.json({ error: '任务已由管理员隐藏，不能自行操作' }, { status: 403 });
    }

    if (task.retention_status === TASK_RETENTION_USER_DELETED) {
      return NextResponse.json({ success: true, task, unchanged: true });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const nextTask = await tx.videoTask.update({
        where: { id: task.id },
        data: {
          retention_status: TASK_RETENTION_USER_DELETED,
          user_deleted_at: new Date(),
          user_deleted_by: user.id,
          delete_reason: reason,
        },
      });

      await recordContentAuditLog({
        actorUserId: user.id,
        action: 'user_delete_task',
        contentType: 'task',
        contentId: task.id,
        ownerUserId: ownerId,
        projectId: task.project_id,
        detail: { reason },
      }, tx);

      return nextTask;
    });

    return NextResponse.json({ success: true, task: updated });
  } catch (error) {
    console.error('[TaskRetention] Delete error:', error);
    return NextResponse.json(
      { error: '任务移除失败', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
