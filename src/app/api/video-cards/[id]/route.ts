import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { logProjectAction } from '@/lib/projects/permissions';
import {
  assertCanManageVideoCard,
  assertCanViewVideoCard,
} from '@/lib/video-cards/permissions';
import { getVideoCardSummaryMap, serializeVideoCardSummary } from '@/lib/video-cards/summary';

export const dynamic = 'force-dynamic';

function asOptionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNullableString(value: unknown) {
  if (value === null) return null;
  return asOptionalString(value);
}

function asOptionalNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasOwn(body: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function serializeTaskPreview(task: null | {
  id: string;
  prompt: string;
  local_status: string;
  local_video_path: string | null;
  result_video_url: string | null;
  created_at: Date;
}) {
  if (!task) return null;
  return {
    id: task.id,
    prompt: task.prompt,
    local_status: task.local_status,
    local_video_path: task.local_video_path,
    result_video_url: task.result_video_url,
    created_at: task.created_at,
  };
}

async function getSerializableVideoCard(id: string) {
  const card = await prisma.videoCard.findUnique({
    where: { id },
    include: {
      project: { select: { id: true, name: true, type: true, status: true } },
      owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
      creator: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
      sealedBy: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
      current_best_task: {
        select: { id: true, prompt: true, local_status: true, local_video_path: true, result_video_url: true, created_at: true },
      },
      final_task: {
        select: { id: true, prompt: true, local_status: true, local_video_path: true, result_video_url: true, created_at: true },
      },
    },
  });
  if (!card) return null;
  const summaryMap = await getVideoCardSummaryMap([card.id]);
  const summary = summaryMap.get(card.id);
  return {
    id: card.id,
    project_id: card.project_id,
    project: card.project,
    title: card.title,
    objective: card.objective,
    status: card.status,
    owner_user_id: card.owner_user_id,
    owner: card.owner,
    creator: card.creator,
    platform: card.platform,
    ratio: card.ratio,
    duration: card.duration,
    target_resolution: card.target_resolution,
    budget_credits: card.budget_credits,
    budget_currency: card.budget_currency,
    current_best_task_id: card.current_best_task_id,
    final_task_id: card.final_task_id,
    current_best_task: serializeTaskPreview(card.current_best_task),
    final_task: serializeTaskPreview(card.final_task),
    is_fallback: card.is_fallback,
    sealed_at: card.sealed_at,
    sealed_by: card.sealed_by,
    sealedBy: card.sealedBy,
    created_by: card.created_by,
    created_at: card.created_at,
    updated_at: card.updated_at,
    summary: summary ? serializeVideoCardSummary(summary) : null,
  };
}

async function assertTaskInVideoCard(taskId: string, videoCardId: string) {
  const task = await prisma.videoTask.findUnique({
    where: { id: taskId },
    select: { id: true, video_card_id: true, project_id: true, version_role: true },
  });
  if (!task || task.video_card_id !== videoCardId) {
    throw new AuthError('任务不属于此视频卡', 400);
  }
  return task;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const access = await assertCanViewVideoCard(user, params.id);
    const videoCard = await getSerializableVideoCard(params.id);
    if (!videoCard) return NextResponse.json({ error: '视频卡不存在' }, { status: 404 });

    return NextResponse.json({
      video_card: videoCard,
      permissions: {
        can_generate: access.canGenerate,
        can_manage: access.canManage,
        project_role: access.projectAccess?.role || null,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[VideoCard] Detail error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const access = await assertCanManageVideoCard(user, params.id);
    const body = await request.json() as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    const lockedForDirectChanges = access.videoCard.status === 'sealed' || access.videoCard.status === 'archived';

    if (hasOwn(body, 'status')) {
      return NextResponse.json(
        { error: '视频卡状态不能直接修改；封板请使用封板操作，重开或归档需要走审批/专用流程' },
        { status: 400 },
      );
    }

    if (lockedForDirectChanges && Object.keys(body).length > 0) {
      return NextResponse.json(
        { error: '视频卡已封板或归档，不能直接修改；如需继续请走重开审批或复制新视频卡' },
        { status: 403 },
      );
    }

    if (hasOwn(body, 'title')) {
      const title = asOptionalString(body.title);
      if (!title) return NextResponse.json({ error: '视频卡标题不能为空' }, { status: 400 });
      data.title = title;
    }
    if (hasOwn(body, 'objective')) data.objective = asNullableString(body.objective);
    if (hasOwn(body, 'platform')) data.platform = asNullableString(body.platform);
    if (hasOwn(body, 'ratio')) data.ratio = asNullableString(body.ratio);
    if (hasOwn(body, 'duration')) data.duration = asOptionalNumber(body.duration);
    if (hasOwn(body, 'target_resolution') || hasOwn(body, 'targetResolution')) {
      data.target_resolution = asNullableString(body.target_resolution ?? body.targetResolution);
    }
    if (hasOwn(body, 'budget_credits') || hasOwn(body, 'budgetCredits')) {
      data.budget_credits = asOptionalNumber(body.budget_credits ?? body.budgetCredits);
    }
    if (hasOwn(body, 'budget_currency') || hasOwn(body, 'budgetCurrency')) {
      data.budget_currency = asOptionalString(body.budget_currency ?? body.budgetCurrency) || 'credits';
    }
    if (body.seal === true) {
      data.status = 'sealed';
      data.sealed_at = new Date();
      data.sealed_by = user.id;
    }

    const currentBestTaskId = hasOwn(body, 'current_best_task_id')
      ? asNullableString(body.current_best_task_id)
      : hasOwn(body, 'currentBestTaskId')
        ? asNullableString(body.currentBestTaskId)
        : undefined;
    const finalTaskId = hasOwn(body, 'final_task_id')
      ? asNullableString(body.final_task_id)
      : hasOwn(body, 'finalTaskId')
        ? asNullableString(body.finalTaskId)
        : undefined;
    const candidateTaskId = hasOwn(body, 'candidate_task_id')
      ? asNullableString(body.candidate_task_id)
      : hasOwn(body, 'candidateTaskId')
        ? asNullableString(body.candidateTaskId)
        : undefined;

    if (currentBestTaskId) await assertTaskInVideoCard(currentBestTaskId, params.id);
    if (finalTaskId) await assertTaskInVideoCard(finalTaskId, params.id);
    if (candidateTaskId) {
      const task = await assertTaskInVideoCard(candidateTaskId, params.id);
      if (
        task.version_role === 'current_best'
        || task.version_role === 'final'
        || access.videoCard.current_best_task_id === candidateTaskId
        || access.videoCard.final_task_id === candidateTaskId
      ) {
        return NextResponse.json({ error: '当前最佳或最终版不能降级为候选' }, { status: 400 });
      }
    }

    await prisma.$transaction(async (tx) => {
      if (candidateTaskId !== undefined && candidateTaskId) {
        await tx.videoTask.update({
          where: { id: candidateTaskId },
          data: { version_role: 'candidate' },
        });
      }

      if (currentBestTaskId !== undefined) {
        data.current_best_task_id = currentBestTaskId;
        await tx.videoTask.updateMany({
          where: { video_card_id: params.id, version_role: 'current_best' },
          data: { version_role: 'normal' },
        });
        if (currentBestTaskId) {
          await tx.videoTask.update({ where: { id: currentBestTaskId }, data: { version_role: 'current_best' } });
        }
      }

      if (finalTaskId !== undefined) {
        data.final_task_id = finalTaskId;
        await tx.videoTask.updateMany({
          where: { video_card_id: params.id, version_role: 'final' },
          data: { version_role: 'normal' },
        });
        if (finalTaskId) {
          await tx.videoTask.update({ where: { id: finalTaskId }, data: { version_role: 'final' } });
          if (!data.status) data.status = 'finalized';
        }
      }

      await tx.videoCard.update({
        where: { id: params.id },
        data,
      });
    });

    await logProjectAction(user.id, 'video_card_update', 'video_card', params.id, {
      project_id: access.videoCard.project_id,
      updated_fields: Object.keys(data),
      candidate_task_id: candidateTaskId ?? undefined,
      current_best_task_id: currentBestTaskId ?? undefined,
      final_task_id: finalTaskId ?? undefined,
    });

    const videoCard = await getSerializableVideoCard(params.id);
    return NextResponse.json({ video_card: videoCard });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[VideoCard] Update error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
