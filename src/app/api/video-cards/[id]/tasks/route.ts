import { toVideoTaskView, videoTaskViewSelect } from '@/lib/dto/video-task';
import { createdPageOrder, createdPageRequest } from '@/lib/pagination/created-page';
import { PaginationError } from '@/lib/pagination/cursor';
import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanManageVideoCard, assertCanViewVideoCard } from '@/lib/video-cards/permissions';
import { USER_VISIBLE_TASK_RETENTION_STATUSES } from '@/lib/tasks/retention';
import { moveTasksBetweenVideoCards } from '@/lib/video-cards/workflow';

export const dynamic = 'force-dynamic';

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim());
}

export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: '未登录', message: '请先登录后再查看视频卡任务' }, { status: 401 });
    }

    await assertCanViewVideoCard(user, params.id);

    const where = user.role === 'admin'
      ? { video_card_id: params.id }
      : { video_card_id: params.id, retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] } };

    const paging = createdPageRequest(request, user, ['card-tasks', params.id], { defaultLimit: 30, maxLimit: 80, minOnePage: true });
    if (paging.anchor) paging.assertAnchor(await prisma.videoTask.findFirst({ where: { AND: [where, paging.anchor] }, select: { id: true } }));

    const [total, tasks] = await Promise.all([
      prisma.videoTask.count({ where }),
      prisma.videoTask.findMany({
        where: paging.anchor ? { AND: [where, paging.seek] } : where,
        orderBy: createdPageOrder,
        skip: paging.skip,
        take: paging.take,
        select: videoTaskViewSelect,
      }),
    ]);

    const result = paging.finish(tasks, total);
    return NextResponse.json({
      tasks: result.items.map((task) => toVideoTaskView(task, user)),
      pagination: result.pagination,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof PaginationError) return NextResponse.json({ error: error.message }, { status: error.status, headers: { 'Cache-Control': 'private, no-store' } });
    if (error instanceof AuthError) {
      return NextResponse.json({ error: '权限不足', message: error.message }, { status: error.status });
    }

    return apiErrorResponse(error);
  }
});

export const PATCH = apiRoute({ access: 'user', rateLimit: false }, async function PATCH(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: '未登录', message: '请先登录后再整理视频卡任务' }, { status: 401 });
    }

    await assertCanManageVideoCard(user, params.id);
    const body = await request.json();
    const action = optionalString(body.action);
    if (action !== 'move') {
      return NextResponse.json({ error: 'action 必须是 move' }, { status: 400 });
    }

    const targetCardId = optionalString(body.target_video_card_id ?? body.targetVideoCardId);
    if (!targetCardId) return NextResponse.json({ error: '必须选择目标视频卡' }, { status: 400 });
    await assertCanManageVideoCard(user, targetCardId);

    const result = await prisma.$transaction((tx) => moveTasksBetweenVideoCards(tx, {
      sourceCardId: params.id,
      targetCardId,
      taskIds: stringList(body.task_ids ?? body.taskIds),
      actorUserId: user.id,
      reason: optionalString(body.reason),
      targetBranchId: optionalString(body.target_branch_id ?? body.targetBranchId),
    }));

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: '权限不足', message: error.message }, { status: error.status });
    }
    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return apiErrorResponse(error);
  }
});
