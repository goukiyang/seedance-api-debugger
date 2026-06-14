import type { Prisma } from '@prisma/client';

type VideoCardSuggestionClient = Prisma.TransactionClient;

export type SimilarVideoCard = {
  id: string;
  title: string;
  objective: string | null;
  status: string;
  platform: string | null;
  ratio: string | null;
  score: number;
  reasons: string[];
};

function normalizeText(value: string | null | undefined) {
  return (value || '')
    .toLowerCase()
    .replace(/[^0-9a-z\u3400-\u9fff\uf900-\ufaff]+/g, '')
    .trim();
}

function textScore(a: string | null | undefined, b: string | null | undefined) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return 0;
  if (left === right) return 60;
  if (left.includes(right) || right.includes(left)) return 42;
  const minLength = Math.min(left.length, right.length);
  let samePrefix = 0;
  while (samePrefix < minLength && left[samePrefix] === right[samePrefix]) samePrefix += 1;
  return samePrefix >= 4 ? Math.min(28, samePrefix * 4) : 0;
}

export function buildVideoCardTitleSuggestion(input: {
  scene?: string | null;
  objective?: string | null;
  platform?: string | null;
  ratio?: string | null;
}) {
  const parts = [
    input.scene,
    input.objective,
    input.platform,
    input.ratio,
  ]
    .map((part) => typeof part === 'string' ? part.trim() : '')
    .filter(Boolean);
  if (parts.length === 0) return '未命名视频目标';
  return parts.join(' · ').slice(0, 80);
}

export async function findSimilarVideoCards(
  tx: VideoCardSuggestionClient,
  input: {
    projectId: string;
    title: string;
    objective?: string | null;
    platform?: string | null;
    ratio?: string | null;
    excludeId?: string | null;
    limit?: number;
  },
) {
  const cards = await tx.videoCard.findMany({
    where: {
      project_id: input.projectId,
      id: input.excludeId ? { not: input.excludeId } : undefined,
      status: { notIn: ['merged', 'discarded'] },
    },
    orderBy: { updated_at: 'desc' },
    take: 80,
    select: {
      id: true,
      title: true,
      objective: true,
      status: true,
      platform: true,
      ratio: true,
    },
  });

  const scored = cards.map((card) => {
    const reasons: string[] = [];
    let score = textScore(card.title, input.title);
    if (score >= 42) reasons.push('标题相似');
    const objectiveScore = textScore(card.objective, input.objective);
    if (objectiveScore >= 28) reasons.push('目标相似');
    score += Math.floor(objectiveScore * 0.7);
    if (input.platform && card.platform === input.platform) {
      score += 12;
      reasons.push('平台相同');
    }
    if (input.ratio && card.ratio === input.ratio) {
      score += 12;
      reasons.push('比例相同');
    }
    return { ...card, score, reasons };
  });

  return scored
    .filter((card) => card.score >= 42)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit || 5) satisfies SimilarVideoCard[];
}

export async function getVideoCardArchiveAnomalies(
  tx: VideoCardSuggestionClient,
  projectId: string,
) {
  const unfiledTasks = await tx.videoTask.findMany({
    where: { project_id: projectId, video_card_id: null },
    orderBy: { created_at: 'desc' },
    take: 50,
    select: {
      id: true,
      prompt: true,
      local_status: true,
      created_at: true,
      estimated_cost: true,
      actual_cost: true,
    },
  });
  const mismatchedTasks = await tx.$queryRaw<Array<{
    id: string;
    prompt: string;
    local_status: string;
    created_at: string;
    project_id: string;
    video_card_id: string;
    card_project_id: string;
  }>>`
    SELECT t.id, t.prompt, t.local_status, t.created_at, t.project_id, t.video_card_id, c.project_id AS card_project_id
    FROM VideoTask t
    JOIN VideoCard c ON t.video_card_id = c.id
    WHERE t.project_id = ${projectId}
      AND t.video_card_id IS NOT NULL
      AND t.project_id <> c.project_id
    ORDER BY t.created_at DESC
    LIMIT 50
  `;

  return {
    unfiled_tasks: unfiledTasks,
    project_card_mismatches: mismatchedTasks,
    total_count: unfiledTasks.length + mismatchedTasks.length,
  };
}
