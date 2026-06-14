import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getSession, AuthError, type SessionUser } from '@/lib/auth/session';
import { getProjectAccess, logProjectAction } from '@/lib/projects/permissions';
import { recordTaskProjectTransfer } from '@/lib/costs/ledger';

export const dynamic = 'force-dynamic';

type MovableTask = Prisma.VideoTaskGetPayload<{
  include: {
    project: { select: { id: true; name: true; type: true } };
    video_card: { select: { id: true; project_id: true; current_best_task_id: true; final_task_id: true } };
  };
}>;

function normalizeItemIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean),
  ));
}

function videoTaskIds(itemIds: string[]) {
  return itemIds
    .filter((id) => id.startsWith('video_task:'))
    .map((id) => id.slice('video_task:'.length))
    .filter(Boolean);
}

async function assertCanMoveTaskProject(user: SessionUser, task: {
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
    if (ownerId !== user.id) throw new AuthError('无权移动此任务', 403);
  }

  const targetAccess = await getProjectAccess(user, targetProjectId);
  if (!targetAccess.project) throw new AuthError('目标项目不存在', 404);
  if (!targetAccess.canManageProject) {
    throw new AuthError('只有目标项目负责人或管理员可以把任务移入该项目', 403);
  }
}

function moveError(taskId: string, message: string) {
  return { task_id: taskId, ok: false, message };
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const itemIds = normalizeItemIds(body.item_ids ?? body.itemIds);
    const taskIds = videoTaskIds(itemIds);
    const targetProjectId = typeof body.target_project_id === 'string' && body.target_project_id.trim()
      ? body.target_project_id.trim()
      : typeof body.project_id === 'string' && body.project_id.trim()
        ? body.project_id.trim()
        : '';
    const targetVideoCardId = typeof body.target_video_card_id === 'string' && body.target_video_card_id.trim()
      ? body.target_video_card_id.trim()
      : typeof body.video_card_id === 'string' && body.video_card_id.trim()
        ? body.video_card_id.trim()
        : '';
    const reason = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim()
      : '资产管理批量移动';

    if (itemIds.length === 0) return NextResponse.json({ error: '请选择要移动的资产' }, { status: 400 });
    if (taskIds.length === 0) return NextResponse.json({ error: '当前批量移动第一版只支持视频任务资产' }, { status: 400 });
    if (!targetProjectId) return NextResponse.json({ error: '目标项目不能为空' }, { status: 400 });
    if (!targetVideoCardId) return NextResponse.json({ error: '移动视频任务必须选择目标视频卡' }, { status: 400 });
    if (taskIds.length > 50) return NextResponse.json({ error: '单次最多移动 50 个视频任务' }, { status: 413 });

    const targetAccess = await getProjectAccess(user, targetProjectId);
    const targetProject = targetAccess.project;
    if (!targetProject) return NextResponse.json({ error: '目标项目不存在' }, { status: 404 });
    if (!targetAccess.canManageProject) {
      return NextResponse.json({ error: '只有目标项目负责人或管理员可以把任务移入该项目' }, { status: 403 });
    }
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
    if (!targetVideoCard) return NextResponse.json({ error: '目标视频卡不存在' }, { status: 404 });
    if (targetVideoCard.project_id !== targetProjectId) {
      return NextResponse.json({ error: '目标视频卡不属于目标项目' }, { status: 400 });
    }
    if (targetVideoCard.status === 'sealed' || targetVideoCard.status === 'archived') {
      return NextResponse.json({ error: '目标视频卡已封板或归档，不能移入任务' }, { status: 400 });
    }

    const tasks = await prisma.videoTask.findMany({
      where: { id: { in: taskIds } },
      include: {
        project: { select: { id: true, name: true, type: true } },
        video_card: { select: { id: true, project_id: true, current_best_task_id: true, final_task_id: true } },
      },
    });
    const taskById = new Map(tasks.map((task) => [task.id, task]));

    const results = [];
    for (const taskId of taskIds) {
      const task = taskById.get(taskId);
      if (!task) {
        results.push(moveError(taskId, '任务不存在'));
        continue;
      }

      try {
        await assertCanMoveTaskProject(user, task, targetProjectId);
        if (task.project_id === targetProjectId && task.video_card_id === targetVideoCardId) {
          results.push({ task_id: task.id, ok: true, unchanged: true });
          continue;
        }

        await prisma.$transaction(async (tx) => {
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

          await tx.videoTask.update({
            where: { id: task.id },
            data: {
              project_id: targetProjectId,
              video_card_id: targetVideoCardId,
              version_role: 'normal',
              visibility: targetProject.type === 'personal' ? 'private' : 'project',
              cost_allocation_status: 'allocated',
            },
          });
        });

        await logProjectAction(user.id, 'asset_library_bulk_move_task', 'VideoTask', task.id, {
          from_project_id: task.project_id,
          to_project_id: targetProjectId,
          from_video_card_id: task.video_card_id,
          to_video_card_id: targetVideoCardId,
          reason,
        });

        results.push({ task_id: task.id, ok: true, unchanged: false });
      } catch (error) {
        results.push(moveError(task.id, error instanceof Error ? error.message : '移动失败'));
      }
    }

    const moved = results.filter((result) => result.ok && !('unchanged' in result && result.unchanged)).length;
    const unchanged = results.filter((result) => result.ok && 'unchanged' in result && result.unchanged).length;
    const failed = results.length - moved - unchanged;

    return NextResponse.json({
      success: failed === 0,
      moved,
      unchanged,
      failed,
      results,
    }, { status: failed === results.length ? 400 : 200 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[AssetLibraryBulkMove] Failed:', error);
    return NextResponse.json(
      { error: '批量移动失败', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
