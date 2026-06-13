import type { Prisma } from '@prisma/client';

type BranchClient = Prisma.TransactionClient;

const ACTIVE_BRANCH_STATUSES = ['exploring', 'candidate', 'primary'];
const MAX_ACTIVE_BRANCHES = 5;

export function isActiveBranchStatus(status: string) {
  return ACTIVE_BRANCH_STATUSES.includes(status);
}

export async function getBranchSummaries(tx: BranchClient, videoCardId: string) {
  const branches = await tx.videoBranch.findMany({
    where: { video_card_id: videoCardId },
    orderBy: [{ is_primary: 'desc' }, { created_at: 'asc' }],
  });
  const tasks = await tx.videoTask.groupBy({
    by: ['video_branch_id'],
    where: { video_card_id: videoCardId, video_branch_id: { not: null } },
    _count: { _all: true },
    _sum: {
      estimated_cost: true,
      actual_cost: true,
      provider_final_amount_micros: true,
      provider_official_amount_micros: true,
    },
  });
  const summaryByBranch = new Map(tasks.map((row) => [row.video_branch_id, row]));
  return branches.map((branch) => {
    const summary = summaryByBranch.get(branch.id);
    return {
      ...branch,
      summary: {
        task_count: summary?._count._all || 0,
        estimated_credits: summary?._sum.estimated_cost || 0,
        charged_credits: summary?._sum.actual_cost || 0,
        official_amount_micros: summary?._sum.provider_final_amount_micros
          ?? summary?._sum.provider_official_amount_micros
          ?? 0,
      },
    };
  });
}

export async function createVideoBranch(
  tx: BranchClient,
  input: {
    videoCardId: string;
    title: string;
    description?: string | null;
    createdBy: string;
    isPrimary?: boolean;
    confirmOverLimit?: boolean;
  },
) {
  const activeCount = await tx.videoBranch.count({
    where: {
      video_card_id: input.videoCardId,
      status: { in: ACTIVE_BRANCH_STATUSES },
    },
  });
  if (activeCount >= MAX_ACTIVE_BRANCHES && !input.confirmOverLimit) {
    throw new Error(`当前视频卡已有 ${activeCount} 个活跃方向，继续新增需要负责人确认`);
  }

  const shouldBePrimary = input.isPrimary || activeCount === 0;
  if (shouldBePrimary) {
    await tx.videoBranch.updateMany({
      where: { video_card_id: input.videoCardId },
      data: { is_primary: false, status: 'candidate' },
    });
  }

  return tx.videoBranch.create({
    data: {
      video_card_id: input.videoCardId,
      title: input.title,
      description: input.description || null,
      status: shouldBePrimary ? 'primary' : 'exploring',
      is_primary: shouldBePrimary,
      created_by: input.createdBy,
    },
  });
}

export async function setPrimaryBranch(
  tx: BranchClient,
  input: {
    videoCardId: string;
    branchId: string;
    actorUserId: string;
  },
) {
  const branch = await tx.videoBranch.findFirst({
    where: { id: input.branchId, video_card_id: input.videoCardId },
  });
  if (!branch) throw new Error('方向分支不存在');
  if (!isActiveBranchStatus(branch.status)) throw new Error('只有活跃方向可以设为主方向');

  await tx.videoBranch.updateMany({
    where: { video_card_id: input.videoCardId },
    data: { is_primary: false, status: 'candidate' },
  });
  const updated = await tx.videoBranch.update({
    where: { id: input.branchId },
    data: { is_primary: true, status: 'primary' },
  });
  await tx.operationLog.create({
    data: {
      operator_id: input.actorUserId,
      action: 'video_branch_set_primary',
      target_type: 'video_branch',
      target_id: input.branchId,
      detail: JSON.stringify({ video_card_id: input.videoCardId }),
    },
  });
  return updated;
}

export async function closeBranch(
  tx: BranchClient,
  input: {
    videoCardId: string;
    branchId: string;
    actorUserId: string;
    reason?: string | null;
  },
) {
  const branch = await tx.videoBranch.findFirst({
    where: { id: input.branchId, video_card_id: input.videoCardId },
  });
  if (!branch) throw new Error('方向分支不存在');
  if (branch.is_primary) throw new Error('主方向不能直接关闭，请先设置其他主方向');

  const updated = await tx.videoBranch.update({
    where: { id: input.branchId },
    data: { status: 'closed', closed_at: new Date(), is_primary: false },
  });
  await tx.operationLog.create({
    data: {
      operator_id: input.actorUserId,
      action: 'video_branch_close',
      target_type: 'video_branch',
      target_id: input.branchId,
      detail: JSON.stringify({ video_card_id: input.videoCardId, reason: input.reason || null }),
    },
  });
  return updated;
}

export async function mergeBranch(
  tx: BranchClient,
  input: {
    videoCardId: string;
    sourceBranchId: string;
    targetBranchId: string;
    actorUserId: string;
    reason?: string | null;
  },
) {
  if (input.sourceBranchId === input.targetBranchId) throw new Error('不能把方向合并到自身');
  const [source, target] = await Promise.all([
    tx.videoBranch.findFirst({ where: { id: input.sourceBranchId, video_card_id: input.videoCardId } }),
    tx.videoBranch.findFirst({ where: { id: input.targetBranchId, video_card_id: input.videoCardId } }),
  ]);
  if (!source || !target) throw new Error('合并方向不存在');
  if (!isActiveBranchStatus(target.status)) throw new Error('目标方向不是活跃方向');

  await tx.videoTask.updateMany({
    where: { video_card_id: input.videoCardId, video_branch_id: input.sourceBranchId },
    data: { video_branch_id: input.targetBranchId },
  });
  const updated = await tx.videoBranch.update({
    where: { id: input.sourceBranchId },
    data: {
      status: 'merged',
      is_primary: false,
      merged_into_branch_id: input.targetBranchId,
      closed_at: new Date(),
    },
  });
  await tx.operationLog.create({
    data: {
      operator_id: input.actorUserId,
      action: 'video_branch_merge',
      target_type: 'video_branch',
      target_id: input.sourceBranchId,
      detail: JSON.stringify({
        video_card_id: input.videoCardId,
        target_branch_id: input.targetBranchId,
        reason: input.reason || null,
      }),
    },
  });
  return updated;
}

export async function promoteBranchToVideoCard(
  tx: BranchClient,
  input: {
    videoCardId: string;
    branchId: string;
    actorUserId: string;
    title?: string | null;
    reason?: string | null;
  },
) {
  const [sourceCard, branch] = await Promise.all([
    tx.videoCard.findUnique({ where: { id: input.videoCardId } }),
    tx.videoBranch.findFirst({ where: { id: input.branchId, video_card_id: input.videoCardId } }),
  ]);
  if (!sourceCard || !branch) throw new Error('方向分支不存在');
  if (branch.status === 'promoted') throw new Error('方向已升格为独立视频卡');

  const promotedCard = await tx.videoCard.create({
    data: {
      project_id: sourceCard.project_id,
      title: input.title || `${sourceCard.title} - ${branch.title}`,
      objective: branch.description || sourceCard.objective,
      status: 'active',
      owner_user_id: sourceCard.owner_user_id,
      platform: sourceCard.platform,
      ratio: sourceCard.ratio,
      duration: sourceCard.duration,
      target_resolution: sourceCard.target_resolution,
      original_ratio: sourceCard.original_ratio || sourceCard.ratio,
      ratio_locked: sourceCard.ratio_locked,
      delivery_specs_json: sourceCard.delivery_specs_json,
      budget_credits: sourceCard.budget_credits,
      budget_currency: sourceCard.budget_currency,
      created_by: input.actorUserId,
    },
  });

  await tx.videoTask.updateMany({
    where: { video_card_id: input.videoCardId, video_branch_id: input.branchId },
    data: { video_card_id: promotedCard.id },
  });
  const updated = await tx.videoBranch.update({
    where: { id: input.branchId },
    data: {
      status: 'promoted',
      is_primary: false,
      promoted_card_id: promotedCard.id,
      closed_at: new Date(),
    },
  });
  await tx.operationLog.create({
    data: {
      operator_id: input.actorUserId,
      action: 'video_branch_promote_to_card',
      target_type: 'video_branch',
      target_id: input.branchId,
      detail: JSON.stringify({
        source_video_card_id: input.videoCardId,
        promoted_video_card_id: promotedCard.id,
        reason: input.reason || null,
      }),
    },
  });
  return { branch: updated, videoCard: promotedCard };
}
