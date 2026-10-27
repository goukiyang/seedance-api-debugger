import { toVideoTaskView, videoTaskViewSelect } from '@/lib/dto/video-task';
import { createdPageOrder, createdPageRequest } from '@/lib/pagination/created-page';
import { PaginationError } from '@/lib/pagination/cursor';
import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { VOLCENGINE_IP_VIDEO_PROVIDER } from '@/lib/provider/volcengine-ip';
import { getTaskWhereForUser } from '@/lib/projects/permissions';
import { assertCanViewVideoCard } from '@/lib/video-cards/permissions';
import type { DtoViewer } from '@/lib/dto/user';
import type { TaskProtectionSource } from '@/lib/video/multiview-task-privacy';

export const dynamic = 'force-dynamic';

function serializeTaskListItem<T extends {
  id: string;
  local_status: string | null;
  user_id?: string | null;
  owner_user_id?: string | null;
  retention_status?: string | null;
  public_video_url?: string | null;
  local_video_path?: string | null;
  result_video_url?: string | null;
  result_last_frame_url?: string | null;
  delivery_status?: string | null;
  error_message?: string | null;
} & TaskProtectionSource>(task: T, viewer: DtoViewer) {
  const ownerId = task.owner_user_id || task.user_id || null;

  return { ...toVideoTaskView(task, viewer),
    can_delete: Boolean(ownerId && ownerId === viewer.id && task.retention_status !== 'admin_hidden') };
}

export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: '请先登录后再查看任务列表' },
        { status: 401 },
      );
    }
    assertInternalOnly(user, '外部账号请使用 IP 任务列表。');

    const searchParams = request.nextUrl.searchParams;
    const projectId = searchParams.get('project_id');
    const videoCardId = searchParams.get('video_card_id');
    const includeAll = user.role === 'admin' && searchParams.get('include_all') === 'true';
    const includeDeleted = user.role === 'admin' && searchParams.get('include_deleted') === 'true';
    const baseWhere = await getTaskWhereForUser(user, projectId, {
      includeAdminAll: includeAll,
      includeDeleted,
    });
    if (videoCardId) await assertCanViewVideoCard(user, videoCardId);
    const where = {
      AND: [
        baseWhere,
        { provider: { not: VOLCENGINE_IP_VIDEO_PROVIDER } },
        ...(videoCardId ? [{ video_card_id: videoCardId }] : []),
      ],
    };

    const paging = createdPageRequest(request, user, ['video-tasks', projectId, videoCardId, includeAll, includeDeleted], { defaultLimit: 20, maxLimit: 100 });
    if (paging.anchor) paging.assertAnchor(await prisma.videoTask.findFirst({ where: { AND: [where, paging.anchor] }, select: { id: true } }));

    const total = await prisma.videoTask.count({ where });

    const tasks = await prisma.videoTask.findMany({
      where: paging.anchor ? { AND: [where, paging.seek] } : where,
      orderBy: createdPageOrder,
      skip: paging.skip,
      take: paging.take,
      select: videoTaskViewSelect,
    });

    const result = paging.finish(tasks, total);
    return NextResponse.json({
      tasks: result.items.map((task) => serializeTaskListItem(task, user)),
      pagination: result.pagination,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof PaginationError) return NextResponse.json({ error: error.message }, { status: error.status, headers: { 'Cache-Control': 'private, no-store' } });
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: 'Forbidden', message: error.message },
        { status: error.status },
      );
    }

    return apiErrorResponse(error);
  }
});
