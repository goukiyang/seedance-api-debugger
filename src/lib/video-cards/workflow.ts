import type { Prisma } from '@prisma/client';

type VideoCardClient = Prisma.TransactionClient;

async function assertSameProjectCards(tx: VideoCardClient, sourceCardId: string, targetCardId: string) {
  if (sourceCardId === targetCardId) throw new Error('不能操作同一张视频卡');
  const [source, target] = await Promise.all([
    tx.videoCard.findUnique({ where: { id: sourceCardId } }),
    tx.videoCard.findUnique({ where: { id: targetCardId } }),
  ]);
  if (!source || !target) throw new Error('视频卡不存在');
  if (source.project_id !== target.project_id) throw new Error('只能在同一个项目内整理视频卡');
  if (['sealed', 'archived', 'merged', 'discarded'].includes(target.status)) {
    throw new Error('目标视频卡不可接收生成记录');
  }
  return { source, target };
}

export async function moveTasksBetweenVideoCards(
  tx: VideoCardClient,
  input: {
    sourceCardId: string;
    targetCardId: string;
    taskIds: string[];
    actorUserId: string;
    reason?: string | null;
    targetBranchId?: string | null;
  },
) {
  const taskIds = Array.from(new Set(input.taskIds.filter(Boolean)));
  if (taskIds.length === 0) throw new Error('请选择要移动的生成记录');
  const { source, target } = await assertSameProjectCards(tx, input.sourceCardId, input.targetCardId);

  if (input.targetBranchId) {
    const branch = await tx.videoBranch.findFirst({
      where: { id: input.targetBranchId, video_card_id: target.id, status: { in: ['exploring', 'candidate', 'primary'] } },
    });
    if (!branch) throw new Error('目标方向分支不存在或不可用');
  }

  const matched = await tx.videoTask.findMany({
    where: { id: { in: taskIds }, video_card_id: source.id },
    select: { id: true },
  });
  if (matched.length !== taskIds.length) throw new Error('部分生成记录不属于当前视频卡');

  await tx.videoTask.updateMany({
    where: { id: { in: taskIds }, video_card_id: source.id },
    data: {
      video_card_id: target.id,
      video_branch_id: input.targetBranchId || null,
    },
  });

  const sourcePatch: Prisma.VideoCardUpdateInput = {};
  if (source.current_best_task_id && taskIds.includes(source.current_best_task_id)) sourcePatch.current_best_task = { disconnect: true };
  if (source.final_task_id && taskIds.includes(source.final_task_id)) sourcePatch.final_task = { disconnect: true };
  if (Object.keys(sourcePatch).length > 0) {
    await tx.videoCard.update({ where: { id: source.id }, data: sourcePatch });
  }

  await tx.operationLog.create({
    data: {
      operator_id: input.actorUserId,
      action: 'video_card_tasks_move',
      target_type: 'video_card',
      target_id: source.id,
      detail: JSON.stringify({
        source_video_card_id: source.id,
        target_video_card_id: target.id,
        task_ids: taskIds,
        target_branch_id: input.targetBranchId || null,
        reason: input.reason || null,
      }),
    },
  });

  return { moved_count: matched.length, source_video_card_id: source.id, target_video_card_id: target.id };
}

export async function mergeVideoCard(
  tx: VideoCardClient,
  input: {
    sourceCardId: string;
    targetCardId: string;
    actorUserId: string;
    reason?: string | null;
  },
) {
  const { source, target } = await assertSameProjectCards(tx, input.sourceCardId, input.targetCardId);
  const moved = await tx.videoTask.updateMany({
    where: { video_card_id: source.id },
    data: { video_card_id: target.id, video_branch_id: null },
  });
  const updated = await tx.videoCard.update({
    where: { id: source.id },
    data: {
      status: 'merged',
      merged_into_card_id: target.id,
      merged_at: new Date(),
      merge_reason: input.reason || null,
      current_best_task_id: null,
      final_task_id: null,
    },
  });
  await tx.operationLog.create({
    data: {
      operator_id: input.actorUserId,
      action: 'video_card_merge',
      target_type: 'video_card',
      target_id: source.id,
      detail: JSON.stringify({
        source_video_card_id: source.id,
        target_video_card_id: target.id,
        moved_task_count: moved.count,
        reason: input.reason || null,
      }),
    },
  });
  return { video_card: updated, moved_task_count: moved.count };
}

export async function splitVideoCard(
  tx: VideoCardClient,
  input: {
    sourceCardId: string;
    taskIds: string[];
    actorUserId: string;
    title: string;
    reason?: string | null;
  },
) {
  const taskIds = Array.from(new Set(input.taskIds.filter(Boolean)));
  if (taskIds.length === 0) throw new Error('请选择要拆分的生成记录');
  const source = await tx.videoCard.findUnique({ where: { id: input.sourceCardId } });
  if (!source) throw new Error('视频卡不存在');
  if (['sealed', 'archived', 'merged', 'discarded'].includes(source.status)) {
    throw new Error('当前视频卡不可拆分');
  }

  const matched = await tx.videoTask.findMany({
    where: { id: { in: taskIds }, video_card_id: source.id },
    select: { id: true },
  });
  if (matched.length !== taskIds.length) throw new Error('部分生成记录不属于当前视频卡');

  const newCard = await tx.videoCard.create({
    data: {
      project_id: source.project_id,
      title: input.title,
      objective: source.objective,
      status: 'active',
      owner_user_id: source.owner_user_id,
      platform: source.platform,
      ratio: source.ratio,
      duration: source.duration,
      target_resolution: source.target_resolution,
      original_ratio: source.original_ratio || source.ratio,
      ratio_locked: source.ratio_locked,
      delivery_specs_json: source.delivery_specs_json,
      budget_credits: source.budget_credits,
      budget_currency: source.budget_currency,
      created_by: input.actorUserId,
    },
  });

  await tx.videoTask.updateMany({
    where: { id: { in: taskIds }, video_card_id: source.id },
    data: { video_card_id: newCard.id, video_branch_id: null },
  });

  const sourcePatch: Prisma.VideoCardUpdateInput = {};
  if (source.current_best_task_id && taskIds.includes(source.current_best_task_id)) sourcePatch.current_best_task = { disconnect: true };
  if (source.final_task_id && taskIds.includes(source.final_task_id)) sourcePatch.final_task = { disconnect: true };
  if (Object.keys(sourcePatch).length > 0) {
    await tx.videoCard.update({ where: { id: source.id }, data: sourcePatch });
  }

  await tx.operationLog.create({
    data: {
      operator_id: input.actorUserId,
      action: 'video_card_split',
      target_type: 'video_card',
      target_id: source.id,
      detail: JSON.stringify({
        source_video_card_id: source.id,
        new_video_card_id: newCard.id,
        task_ids: taskIds,
        reason: input.reason || null,
      }),
    },
  });

  return { video_card: newCard, moved_task_count: matched.length };
}
