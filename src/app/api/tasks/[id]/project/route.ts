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
    const reason = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim()
      : '项目成本归属调整';

    if (!targetProjectId) {
      return NextResponse.json({ error: '目标项目不能为空' }, { status: 400 });
    }

    const task = await prisma.videoTask.findUnique({
      where: { id: params.id },
      include: {
        project: { select: { id: true, name: true, type: true } },
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

    if (task.project_id === targetProjectId) {
      return NextResponse.json({ task, unchanged: true });
    }

    const updated = await prisma.$transaction(async (tx) => {
      await recordTaskProjectTransfer(tx, task, task.project_id, targetProjectId, reason, user.id);

      return tx.videoTask.update({
        where: { id: task.id },
        data: {
          project_id: targetProjectId,
          video_card_id: null,
          version_role: 'normal',
          visibility: targetProject.type === 'personal' ? 'private' : 'project',
          cost_allocation_status: 'allocated',
        },
        include: {
          project: { select: { id: true, name: true, type: true } },
        },
      });
    });

    await logProjectAction(user.id, 'task_project_move', 'VideoTask', task.id, {
      from_project_id: task.project_id,
      to_project_id: targetProjectId,
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
