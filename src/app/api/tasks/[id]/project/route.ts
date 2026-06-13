import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanViewTask, getProjectAccess, logProjectAction } from '@/lib/projects/permissions';
import { recordTaskProjectTransfer } from '@/lib/costs/ledger';

export const dynamic = 'force-dynamic';

async function assertCanMoveTaskProject(user: NonNullable<Awaited<ReturnType<typeof getSession>>>, task: {
  id: string;
  project_id: string | null;
  owner_user_id: string | null;
  user_id: string | null;
}, targetProjectId: string) {
  if (user.role === 'admin') return;

  if (task.project_id) {
    const sourceAccess = await getProjectAccess(user, task.project_id);
    if (!sourceAccess.canManageProject) {
      throw new AuthError('只有项目负责人或管理员可以移动项目任务', 403);
    }
  } else {
    const ownerId = task.owner_user_id || task.user_id;
    if (ownerId !== user.id) {
      throw new AuthError('无权移动此任务', 403);
    }
  }

  const targetAccess = await getProjectAccess(user, targetProjectId);
  if (!targetAccess.project) throw new AuthError('目标项目不存在', 404);
  if (!targetAccess.canManageProject) {
    throw new AuthError('只有目标项目负责人或管理员可以把任务移入该项目', 403);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const body = await request.json();
    const targetProjectId = typeof body.project_id === 'string' && body.project_id.trim()
      ? body.project_id.trim()
      : '';
    const targetVideoCardId = typeof body.video_card_id === 'string' && body.video_card_id.trim()
      ? body.video_card_id.trim()
      : typeof body.videoCardId === 'string' && body.videoCardId.trim()
        ? body.videoCardId.trim()
        : '';
    const reason = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim()
      : '项目成本归属调整';

    if (!targetProjectId) {
      return NextResponse.json({ error: '目标项目不能为空' }, { status: 400 });
    }
    if (!targetVideoCardId) {
      return NextResponse.json({ error: '移动任务必须选择目标项目下的视频卡，不能产生未归档任务' }, { status: 400 });
    }

    const task = await prisma.videoTask.findUnique({
      where: { id: params.id },
      include: {
        project: { select: { id: true, name: true, type: true } },
        video_card: { select: { id: true, project_id: true, current_best_task_id: true, final_task_id: true } },
      },
    });
    if (!task) return NextResponse.json({ error: '任务不存在' }, { status: 404 });

    await assertCanViewTask(user, task);
    await assertCanMoveTaskProject(user, task, targetProjectId);

    const targetAccess = await getProjectAccess(user, targetProjectId);
    const targetProject = targetAccess.project;
    if (!targetProject) return NextResponse.json({ error: '目标项目不存在' }, { status: 404 });
    if (targetProject.status !== 'active') {
      return NextResponse.json({ error: '目标项目不是进行中状态，不能移入任务' }, { status: 400 });
    }
    if (targetProject.type === 'system') {
      return NextResponse.json({ error: '不能把任务移入系统项目' }, { status: 400 });
    }

    const targetVideoCard = await prisma.videoCard.findUnique({
      where: { id: targetVideoCardId },
      select: { id: true, project_id: true, title: true, status: true },
    });
    if (!targetVideoCard) {
      return NextResponse.json({ error: '目标视频卡不存在' }, { status: 404 });
    }
    if (targetVideoCard.project_id !== targetProjectId) {
      return NextResponse.json({ error: '目标视频卡不属于目标项目' }, { status: 400 });
    }
    if (targetVideoCard.status === 'sealed' || targetVideoCard.status === 'archived') {
      return NextResponse.json({ error: '目标视频卡已封板或归档，不能移入任务' }, { status: 400 });
    }

    if (task.project_id === targetProjectId && task.video_card_id === targetVideoCardId) {
      return NextResponse.json({ task, unchanged: true });
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (task.project_id !== targetProjectId) {
        await recordTaskProjectTransfer(tx, task, task.project_id, targetProjectId, reason, user.id);
      }

      if (task.video_card_id && task.video_card_id !== targetVideoCardId && task.video_card) {
        const sourceCardUpdate: Record<string, null> = {};
        if (task.video_card.current_best_task_id === task.id) sourceCardUpdate.current_best_task_id = null;
        if (task.video_card.final_task_id === task.id) sourceCardUpdate.final_task_id = null;
        if (Object.keys(sourceCardUpdate).length > 0) {
          await tx.videoCard.update({
            where: { id: task.video_card_id },
            data: sourceCardUpdate,
          });
        }
      }

      return tx.videoTask.update({
        where: { id: task.id },
        data: {
          project_id: targetProjectId,
          video_card_id: targetVideoCardId,
          version_role: 'normal',
          visibility: targetProject.type === 'personal' ? 'private' : 'project',
          cost_allocation_status: 'allocated',
        },
        include: {
          project: { select: { id: true, name: true, type: true } },
          video_card: { select: { id: true, title: true, objective: true, status: true, project_id: true } },
        },
      });
    });

    await logProjectAction(user.id, task.project_id === targetProjectId ? 'task_video_card_move' : 'task_project_move', 'VideoTask', task.id, {
      from_project_id: task.project_id,
      to_project_id: targetProjectId,
      from_video_card_id: task.video_card_id,
      to_video_card_id: targetVideoCardId,
      reason,
    });

    return NextResponse.json({ task: updated });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[TaskProjectMove] Failed:', error);
    return NextResponse.json(
      { error: '移动任务失败', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
