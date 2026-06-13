import { NextRequest, NextResponse } from 'next/server';
import { getAdminUser, errorJson } from '@/lib/auth/api-helpers';
import { manualRefundTask } from '@/lib/video-task-admin';

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
    const result = await manualRefundTask({
      taskId: params.id,
      operatorId: admin.id,
      reason,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return errorJson(error instanceof Error ? error.message : '退款失败', 400);
  }
}
