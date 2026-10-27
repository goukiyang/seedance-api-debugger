import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
import { NextRequest, NextResponse } from 'next/server';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { prisma } from '@/lib/prisma';
import { recordContentAuditLog } from '@/lib/content-audit';
import { toVideoTaskView, videoTaskViewSelect } from '@/lib/dto/video-task';
import { TASK_RETENTION_ACTIVE } from '@/lib/tasks/retention';

export const dynamic = 'force-dynamic';

export const POST = apiRoute({ access: 'admin', rateLimit: false }, async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const admin = await getAdminUser(request);
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
        select: videoTaskViewSelect,
        where: { id: task.id },
        data: {
          retention_status: TASK_RETENTION_ACTIVE,
          user_deleted_at: null,
          user_deleted_by: null,
          admin_hidden_at: null,
          admin_hidden_by: null,
          delete_reason: null,
          restored_at: new Date(),
          restored_by: admin.id,
        },
      });

      await recordContentAuditLog({
        actorUserId: admin.id,
        action: 'admin_restore_task',
        contentType: 'task',
        contentId: task.id,
        ownerUserId: ownerId,
        projectId: task.project_id,
        detail: { previous_retention_status: task.retention_status },
      }, tx);

      return nextTask;
    });

    return NextResponse.json({ success: true, task: toVideoTaskView(updated, admin) });
  } catch (error) {
    return apiErrorResponse(error);
  }
});
