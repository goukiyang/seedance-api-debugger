import type { NextRequest } from 'next/server';
import { route } from '@/lib/http/route';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { isPrivateMultiviewTask } from '@/lib/video/multiview-task-privacy';
import { taskDebugJson } from '@/lib/dto/task-debug';

export const dynamic = 'force-dynamic';
export const GET = route({ access: 'admin', rateLimit: false }, async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const user = await getSession();
  if (!user || user.role !== 'admin') return Response.json({ error: '无权访问' }, { status: 403 });
  const { id } = await context.params;
  const task = await prisma.videoTask.findUnique({ where: { id }, select: {
    id: true, user_id: true, owner_user_id: true, project_id: true, visibility: true, retention_status: true,
    source_metadata_json: true, raw_create_response: true, raw_status_response: true,
    params_json: true, provider_payload_json: true, reference_images_json: true,
  } });
  const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
  if (!task || isPrivateMultiviewTask(task)) return Response.json({ error: '调试信息不可访问' }, { status: 404, headers });
  await assertCanViewTask(user, task);
  return Response.json({ id: task.id, raw_create_response: taskDebugJson(task.raw_create_response),
    raw_status_response: taskDebugJson(task.raw_status_response), params_json: taskDebugJson(task.params_json),
    provider_payload_json: taskDebugJson(task.provider_payload_json), reference_images_json: taskDebugJson(task.reference_images_json),
  }, { headers });
});
