import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { finalizeVideoTaskStatus } from '@/lib/video/task-finalizer';

export const dynamic = 'force-dynamic';

function serializeTaskIdentity<T extends { owner?: unknown; user?: unknown }>(task: T) {
  return {
    ...task,
    owner: task.owner || task.user || null,
    submitted_user: task.user || null,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const taskId = params.id;
    const forceProviderRefresh = request.nextUrl.searchParams.get('refresh') === 'true'
      || request.nextUrl.searchParams.get('force_refresh') === 'true';
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: '未登录', message: '请先登录' }, { status: 401 });
    }

    const task = await prisma.videoTask.findUnique({
      where: { id: taskId },
      include: {
        project: { select: { id: true, name: true, type: true } },
        video_card: { select: { id: true, title: true, objective: true, status: true, project_id: true } },
        owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
        user: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
      },
    });

    if (!task) {
      return NextResponse.json(
        { error: 'Task not found', message: `Task ${taskId} not found` },
        { status: 404 },
      );
    }

    try {
      await assertCanViewTask(user, task);
    } catch (error) {
      if (error instanceof AuthError) {
        return NextResponse.json({ error: '权限不足', message: error.message }, { status: error.status });
      }
      throw error;
    }

    if (!task.provider_task_id) {
      return NextResponse.json(serializeTaskIdentity(task));
    }

    const finalizeResult = await finalizeVideoTaskStatus(taskId, {
      forceProviderRefresh,
      cacheOnSuccess: true,
      generateThumbnail: true,
      createdBy: user.id,
    });

    const responseTask = await prisma.videoTask.findUnique({
      where: { id: taskId },
      include: {
        project: { select: { id: true, name: true, type: true } },
        video_card: { select: { id: true, title: true, objective: true, status: true, project_id: true } },
        owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
        user: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
      },
    });

    if (!responseTask || !finalizeResult.task) {
      return NextResponse.json(
        { error: 'Task not found', message: `Task ${taskId} not found` },
        { status: 404 },
      );
    }

    if (finalizeResult.providerError) {
      return NextResponse.json({
        ...serializeTaskIdentity(responseTask),
        error_message: responseTask.error_message || finalizeResult.providerError,
      });
    }

    return NextResponse.json(serializeTaskIdentity(responseTask));
  } catch (error) {
    console.error('Get task status error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
