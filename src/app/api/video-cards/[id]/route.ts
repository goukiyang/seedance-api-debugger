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

function serializeDeliverySpecs(card: {
  delivery_specs_json?: string | null;
  platform?: string | null;
  ratio?: string | null;
  duration?: number | null;
  target_resolution?: string | null;
}) {
  if (card.delivery_specs_json) {
    try {
      const parsed = JSON.parse(card.delivery_specs_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // 规格快照解析失败时回退为当前字段，避免详情接口 500。
    }
  }
  return {
    platform: card.platform || null,
    ratio: card.ratio || null,
    duration: card.duration || null,
    target_resolution: card.target_resolution || null,
  };
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
    original_ratio: card.original_ratio,
    ratio_locked: card.ratio_locked,
    ratio_change_reason: card.ratio_change_reason,
    delivery_specs: serializeDeliverySpecs(card),
    merged_into_card_id: card.merged_into_card_id,
    merged_at: card.merged_at,
    merge_reason: card.merge_reason,
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
    select: { id: true, video_card_id: true, project_id: true, version_role: true, ratio: true },
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

    const lifecycleAction = asOptionalString(body.action);
    if (lifecycleAction === 'archive' || lifecycleAction === 'discard') {
      if (access.videoCard.is_fallback) {
        return NextResponse.json({ error: '系统兜底视频卡不能归档或废弃' }, { status: 400 });
      }
      if (['sealed', 'merged', 'archived', 'discarded'].includes(access.videoCard.status)) {
        return NextResponse.json(
          { error: '视频卡当前状态不允许归档或废弃，请在详情页按现有工作流处理' },
          { status: 400 },
        );
      }

      if (lifecycleAction === 'discard') {
        const [taskCount, branchCount] = await Promise.all([
          prisma.videoTask.count({ where: { video_card_id: params.id } }),
          prisma.videoBranch.count({ where: { video_card_id: params.id } }),
        ]);
        const hasHistory = taskCount > 0
          || branchCount > 0
          || Boolean(access.videoCard.current_best_task_id)
          || Boolean(access.videoCard.final_task_id);
        if (hasHistory) {
          return NextResponse.json(
            { error: '视频卡已有任务、最终版或分支，不能废弃；请改为归档' },
            { status: 409 },
          );
        }
      }

      await prisma.videoCard.update({
        where: { id: params.id },
        data: { status: lifecycleAction === 'archive' ? 'archived' : 'discarded' },
      });
      await logProjectAction(user.id, `video_card_${lifecycleAction}`, 'video_card', params.id, {
        project_id: access.videoCard.project_id,
        previous_status: access.videoCard.status,
      });
      const videoCard = await getSerializableVideoCard(params.id);
      return NextResponse.json({ video_card: videoCard, action: lifecycleAction });
    }

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
    if (hasOwn(body, 'ratio')) {
      const nextRatio = asNullableString(body.ratio);
      const ratioChanged = nextRatio !== access.videoCard.ratio;
      if (ratioChanged && (
        access.videoCard.project.type === 'public'
        || access.videoCard.ratio_locked
        || Boolean(access.videoCard.final_task_id)
      )) {
        return NextResponse.json(
          { error: '此视频卡比例已进入交付规格约束，变更比例需要先走比例变更审批' },
          { status: 403 },
        );
      }
      data.ratio = nextRatio;
      if (nextRatio && !access.videoCard.original_ratio) data.original_ratio = access.videoCard.ratio || nextRatio;
      if (nextRatio) data.ratio_locked = true;
    }
    if (hasOwn(body, 'ratio_locked') || hasOwn(body, 'ratioLocked')) {
      const nextLocked = body.ratio_locked ?? body.ratioLocked;
      if (nextLocked === false) {
        if (access.videoCard.project.type === 'public' || Boolean(access.videoCard.final_task_id)) {
          return NextResponse.json(
            { error: '公共项目或已有最终版的视频卡不能直接解锁比例，请走比例变更审批' },
            { status: 403 },
          );
        }
        const unlockReason = asOptionalString(body.ratio_unlock_reason ?? body.ratioUnlockReason);
        if (!unlockReason) {
          return NextResponse.json({ error: '解锁比例必须填写原因' }, { status: 400 });
        }
        data.ratio_locked = false;
        data.ratio_change_reason = unlockReason;
      } else if (nextLocked === true) {
        data.ratio_locked = true;
      }
    }
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
    if (
      hasOwn(body, 'platform')
      || hasOwn(body, 'ratio')
      || hasOwn(body, 'duration')
      || hasOwn(body, 'target_resolution')
      || hasOwn(body, 'targetResolution')
    ) {
      data.delivery_specs_json = JSON.stringify({
        platform: data.platform ?? access.videoCard.platform ?? null,
        ratio: data.ratio ?? access.videoCard.ratio ?? null,
        duration: data.duration ?? access.videoCard.duration ?? null,
        target_resolution: data.target_resolution ?? access.videoCard.target_resolution ?? null,
        source: 'video_card_update',
        updated_by: user.id,
      });
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
    if (finalTaskId) {
      const task = await assertTaskInVideoCard(finalTaskId, params.id);
      if (
        access.videoCard.project.type === 'public'
        && access.videoCard.ratio
        && task.ratio
        && task.ratio !== access.videoCard.ratio
      ) {
        return NextResponse.json(
          { error: '公共项目最终版必须符合视频卡交付比例；偏离比例需要先走比例变更审批' },
          { status: 403 },
        );
      }
    }
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
