import type { Prisma } from '@prisma/client';

type ReviewClient = Prisma.TransactionClient;

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

export async function buildProjectReviewSummary(tx: ReviewClient, projectId: string) {
  const [project, cards, tasks] = await Promise.all([
    tx.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, type: true, status: true } }),
    tx.videoCard.findMany({ where: { project_id: projectId } }),
    tx.videoTask.findMany({
      where: { project_id: projectId },
      select: {
        id: true,
        video_card_id: true,
        local_status: true,
        actual_cost: true,
        estimated_cost: true,
        resolution: true,
        duration: true,
        ratio: true,
        provider_cost_currency: true,
        provider_final_amount_micros: true,
        provider_official_amount_micros: true,
        version_role: true,
      },
    }),
  ]);
  if (!project) throw new Error('项目不存在');

  const resolutionDistribution: Record<string, number> = {};
  const ratioDistribution: Record<string, number> = {};
  const cardCredits = new Map<string, number>();
  let totalCredits = 0;
  let officialMicros = 0;
  let failedCount = 0;
  let finalTaskCount = 0;
  const finalCosts: number[] = [];

  for (const task of tasks) {
    const charged = task.actual_cost || 0;
    totalCredits += charged;
    if (task.video_card_id) cardCredits.set(task.video_card_id, (cardCredits.get(task.video_card_id) || 0) + charged);
    if (task.local_status === 'failed' || task.local_status === 'cancelled') failedCount += 1;
    if (task.version_role === 'final') {
      finalTaskCount += 1;
      finalCosts.push(charged);
    }
    const resolution = task.resolution || 'unknown';
    const ratio = task.ratio || 'unknown';
    resolutionDistribution[resolution] = (resolutionDistribution[resolution] || 0) + 1;
    ratioDistribution[ratio] = (ratioDistribution[ratio] || 0) + 1;
    officialMicros += task.provider_final_amount_micros ?? task.provider_official_amount_micros ?? 0;
  }

  const mostExpensive = Array.from(cardCredits.entries()).sort((a, b) => b[1] - a[1])[0] || null;
  const mostExpensiveCard = mostExpensive
    ? cards.find((card) => card.id === mostExpensive[0]) || null
    : null;
  const averageFinalCost = finalCosts.length > 0
    ? finalCosts.reduce((sum, value) => sum + value, 0) / finalCosts.length
    : 0;
  const budgetSuggestion = Math.max(totalCredits * 1.2, averageFinalCost * Math.max(1, cards.length) * 1.25);

  return {
    project,
    video_card_count: cards.length,
    task_count: tasks.length,
    total_credits: round2(totalCredits),
    total_amount_micros: officialMicros,
    final_task_count: finalTaskCount,
    average_final_credits: round2(averageFinalCost),
    failure_rate: tasks.length > 0 ? round2(failedCount / tasks.length) : 0,
    most_expensive_video_card: mostExpensiveCard
      ? { id: mostExpensiveCard.id, title: mostExpensiveCard.title, charged_credits: round2(mostExpensive?.[1] || 0) }
      : null,
    resolution_distribution: resolutionDistribution,
    ratio_distribution: ratioDistribution,
    budget_suggestion_credits: round2(budgetSuggestion),
    budget_suggestion_reason: tasks.length > 0
      ? '按本项目总消耗和最终版平均成本上浮估算，作为下一次同类项目预算起点。'
      : '项目暂无有效消耗，建议先按视频卡预算或人工评估填入。',
    generated_at: new Date().toISOString(),
  };
}

export async function generateProjectReviewCard(
  tx: ReviewClient,
  input: {
    projectId: string;
    actorUserId: string;
  },
) {
  const summary = await buildProjectReviewSummary(tx, input.projectId);
  const card = await tx.reviewCard.create({
    data: {
      project_id: input.projectId,
      status: 'generated',
      summary_json: JSON.stringify(summary),
      total_credits: summary.total_credits,
      total_amount_micros: summary.total_amount_micros,
      currency: 'CNY',
      video_card_count: summary.video_card_count,
      final_task_count: summary.final_task_count,
      failure_rate: summary.failure_rate,
      budget_suggestion_credits: summary.budget_suggestion_credits,
      budget_suggestion_reason: summary.budget_suggestion_reason,
      generated_by: input.actorUserId,
      generated_at: new Date(),
    },
  });
  await tx.operationLog.create({
    data: {
      operator_id: input.actorUserId,
      action: 'project_review_card_generate',
      target_type: 'review_card',
      target_id: card.id,
      detail: JSON.stringify({ project_id: input.projectId, total_credits: summary.total_credits }),
    },
  });
  return card;
}
