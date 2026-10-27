import { toVideoTaskView, videoTaskViewSelect } from '@/lib/dto/video-task';
import { createdPageOrder, createdPageRequest } from '@/lib/pagination/created-page';
import { PaginationError } from '@/lib/pagination/cursor';
import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import {
  VOLCENGINE_IP_VIDEO_PROVIDER,
  safeVolcengineIpUserMessage,
} from '@/lib/provider/volcengine-ip';
import { getTaskWhereForUser } from '@/lib/projects/permissions';
import { assertCanViewVideoCard } from '@/lib/video-cards/permissions';
import { taskThumbnailProjection } from '@/lib/video/task-thumbnail-projection';

export const dynamic = 'force-dynamic';

export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: '请先登录后再查看任务列表' },
        { status: 401 },
      );
    }

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
        { provider: VOLCENGINE_IP_VIDEO_PROVIDER },
        ...(videoCardId ? [{ video_card_id: videoCardId }] : []),
      ],
    };

    const paging = createdPageRequest(request, user, ['ip-video-tasks', projectId, videoCardId, includeAll, includeDeleted], { defaultLimit: 20, maxLimit: 50, minOnePage: true });
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
      tasks: result.items.map((task) => {
        return {
        ...toVideoTaskView(task, user),
        result_video_url: null,
        result_last_frame_url: null,
        ...taskThumbnailProjection({
          id: task.id, local_status: task.local_status, delivery_status: task.delivery_status,
          public_video_url: task.public_video_url, local_video_path: task.local_video_path,
        }),
        error_message: safeVolcengineIpUserMessage(task.error_message),
      };
      }),
      pagination: result.pagination,
    });
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
