import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getAdminUser, errorJson } from '@/lib/auth/api-helpers';
import { addTaskOperationLog } from '@/lib/video-task-admin';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  let admin;
  try {
    admin = await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const body = await request.json().catch(() => ({}));
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) return errorJson('reason 为必填', 400);

  const task = await prisma.videoTask.findUnique({ where: { id: params.id } });
  if (!task) return errorJson('任务不存在', 404);

  const updatedTask = await prisma.videoTask.update({
    where: { id: params.id },
    data: {
      local_status: 'failed',
      completed_at: task.completed_at || new Date(),
      error_code: task.error_code || 'ADMIN_MARKED_FAILED',
      error_message: task.error_message || `管理员标记失败：${reason}`,
    },
  });

  await addTaskOperationLog({
    operatorId: admin.id,
    taskId: params.id,
    action: 'task_mark_failed',
    reason,
    extra: {
      previous_local_status: task.local_status,
      previous_provider_status: task.provider_status,
    },
  });

  return NextResponse.json({ ok: true, task: updatedTask });
}
