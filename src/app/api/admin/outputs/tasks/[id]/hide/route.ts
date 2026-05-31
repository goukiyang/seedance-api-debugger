import { NextRequest, NextResponse } from 'next/server';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { prisma } from '@/lib/prisma';
import { recordContentAuditLog } from '@/lib/content-audit';
import {
  normalizeTaskDeleteReason,
  TASK_RETENTION_ADMIN_HIDDEN,
} from '@/lib/tasks/retention';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const admin = await getAdminUser(request);
    const body = await request.json().catch(() => ({}));
    const reason = normalizeTaskDeleteReason(body.reason) || '管理员隐藏产出';

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

    const ownerId = task.owner_user_id || task.user_id || null;
    const updated = await prisma.$transaction(async (tx) => {
      const nextTask = await tx.videoTask.update({
        where: { id: task.id },
        data: {
          retention_status: TASK_RETENTION_ADMIN_HIDDEN,
          admin_hidden_at: new Date(),
          admin_hidden_by: admin.id,
          delete_reason: reason,
        },
      });

      await recordContentAuditLog({
        actorUserId: admin.id,
        action: 'admin_hide_task',
        contentType: 'task',
        contentId: task.id,
        ownerUserId: ownerId,
        projectId: task.project_id,
        detail: { reason, previous_retention_status: task.retention_status },
      }, tx);

      return nextTask;
    });

    return NextResponse.json({ success: true, task: updated });
  } catch (error) {
    console.error('[AdminOutputs] Hide task error:', error);
    const status = error && typeof error === 'object' && 'status' in error
      ? Number((error as { status?: number }).status) || 500
      : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '隐藏任务失败' },
      { status },
    );
  }
}
