import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';

const OFFICIAL_CARD_COST_EVENTS = ['official_charge', 'adjustment', 'reversal'];

export interface VideoCardSummary {
  video_card_id: string;
  task_count: number;
  succeeded_count: number;
  failed_count: number;
  running_count: number;
  estimated_credits: number;
  charged_credits: number;
  refunded_credits: number;
  official_cost_totals: Array<{ currency: string; amount_minor: number; amount_micros: number }>;
  resolution_distribution: Record<string, number>;
}

function emptySummary(videoCardId: string): VideoCardSummary {
  return {
    video_card_id: videoCardId,
    task_count: 0,
    succeeded_count: 0,
    failed_count: 0,
    running_count: 0,
    estimated_credits: 0,
    charged_credits: 0,
    refunded_credits: 0,
    official_cost_totals: [],
    resolution_distribution: {},
  };
}

function normalizeCurrency(currency: string | null | undefined) {
  return (currency || 'CNY').trim().toUpperCase();
}

function addOfficialCost(
  totals: Map<string, { currency: string; amount_minor: number; amount_micros: number }>,
  currencyValue: string | null | undefined,
  amountMicros: number | null | undefined,
  amountMinor: number | null | undefined,
) {
  const currency = normalizeCurrency(currencyValue);
  const existing = totals.get(currency) || { currency, amount_minor: 0, amount_micros: 0 };
  if (amountMicros !== null && amountMicros !== undefined) {
    existing.amount_micros += amountMicros;
    existing.amount_minor += Math.round(amountMicros / 10000);
  } else if (amountMinor !== null && amountMinor !== undefined) {
    existing.amount_minor += amountMinor;
    existing.amount_micros += amountMinor * 10000;
  }
  totals.set(currency, existing);
}

export async function getVideoCardSummaryMap(
  videoCardIds: string[],
  options: { taskWhere?: Prisma.VideoTaskWhereInput } = {},
) {
  const uniqueIds = Array.from(new Set(videoCardIds.filter(Boolean)));
  const summaryMap = new Map(uniqueIds.map((id) => [id, emptySummary(id)]));
  if (uniqueIds.length === 0) return summaryMap;

  const tasks = await prisma.videoTask.findMany({
    where: {
      ...(options.taskWhere || {}),
      video_card_id: { in: uniqueIds },
    },
    select: {
      id: true,
      video_card_id: true,
      local_status: true,
      estimated_cost: true,
      actual_cost: true,
      refund_amount: true,
      resolution: true,
    },
  });

  const taskCardById = new Map<string, string>();
  for (const task of tasks) {
    if (!task.video_card_id) continue;
    taskCardById.set(task.id, task.video_card_id);
    const summary = summaryMap.get(task.video_card_id) || emptySummary(task.video_card_id);
    summary.task_count += 1;
    if (task.local_status === 'succeeded') summary.succeeded_count += 1;
    if (task.local_status === 'failed' || task.local_status === 'cancelled') summary.failed_count += 1;
    if (task.local_status === 'submitted' || task.local_status === 'running') summary.running_count += 1;
    summary.estimated_credits += task.estimated_cost || 0;
    summary.charged_credits += task.actual_cost || 0;
    summary.refunded_credits += task.refund_amount || 0;
    const resolution = task.resolution || 'unknown';
    summary.resolution_distribution[resolution] = (summary.resolution_distribution[resolution] || 0) + 1;
    summaryMap.set(task.video_card_id, summary);
  }

  const taskIds = Array.from(taskCardById.keys());
  if (taskIds.length === 0) return summaryMap;

  const [allocationRows, directRows] = await Promise.all([
    prisma.costAllocation.findMany({
      where: {
        task_id: { in: taskIds },
        ledger: { event_type: { in: OFFICIAL_CARD_COST_EVENTS } },
      },
      select: {
        task_id: true,
        amount_minor: true,
        amount_micros: true,
        currency: true,
      },
    }),
    prisma.costLedger.findMany({
      where: {
        task_id: { in: taskIds },
        event_type: { in: OFFICIAL_CARD_COST_EVENTS },
        allocations: { none: {} },
      },
      select: {
        task_id: true,
        amount_minor: true,
        amount_micros: true,
        currency: true,
      },
    }),
  ]);

  const totalsByCard = new Map<string, Map<string, { currency: string; amount_minor: number; amount_micros: number }>>();
  for (const row of [...allocationRows, ...directRows]) {
    if (!row.task_id) continue;
    const videoCardId = taskCardById.get(row.task_id);
    if (!videoCardId) continue;
    const totals = totalsByCard.get(videoCardId) || new Map();
    addOfficialCost(totals, row.currency, row.amount_micros, row.amount_minor);
    totalsByCard.set(videoCardId, totals);
  }

  totalsByCard.forEach((totals, videoCardId) => {
    const summary = summaryMap.get(videoCardId) || emptySummary(videoCardId);
    const costTotals: Array<{ currency: string; amount_minor: number; amount_micros: number }> = Array.from(totals.values());
    summary.official_cost_totals = costTotals
      .sort((a, b) => a.currency.localeCompare(b.currency));
    summaryMap.set(videoCardId, summary);
  });

  return summaryMap;
}

export function serializeVideoCardSummary(summary: VideoCardSummary) {
  return {
    ...summary,
    estimated_credits: Math.round(summary.estimated_credits * 100) / 100,
    charged_credits: Math.round(summary.charged_credits * 100) / 100,
    refunded_credits: Math.round(summary.refunded_credits * 100) / 100,
  };
}
