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
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (!reason) return errorJson('reason 为必填', 400);
  if (!note) return errorJson('note 为必填', 400);

  const task = await prisma.videoTask.findUnique({ where: { id: params.id } });
  if (!task) return errorJson('任务不存在', 404);

  await addTaskOperationLog({
    operatorId: admin.id,
    taskId: params.id,
    action: 'task_note',
    reason,
    extra: {
      note,
      local_status: task.local_status,
      provider_status: task.provider_status,
    },
  });

  return NextResponse.json({ ok: true });
}
