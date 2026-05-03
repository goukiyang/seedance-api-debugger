import { NextRequest, NextResponse } from 'next/server';
import { getAdminUser, errorJson } from '@/lib/auth/api-helpers';
import { addTaskOperationLog, refreshTaskFromProvider } from '@/lib/video-task-admin';

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

  try {
    const task = await refreshTaskFromProvider(params.id);
    await addTaskOperationLog({
      operatorId: admin.id,
      taskId: params.id,
      action: 'task_recheck',
      reason,
      extra: {
        provider_status: task.provider_status,
        local_status: task.local_status,
      },
    });
    return NextResponse.json({ ok: true, task });
  } catch (error) {
    return errorJson(error instanceof Error ? error.message : '复查失败', 400);
  }
}
