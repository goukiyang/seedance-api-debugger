import { prisma } from '@/lib/prisma';

const TERMINAL_TASK_STATUSES = ['succeeded', 'failed', 'cancelled'];
const TERMINAL_COST_EVENTS = ['rule_settlement', 'failed_cost_unknown', 'failed_no_charge', 'official_charge'];
const LEDGER_ID_QUERY_CHUNK_SIZE = 500;

export type CostLedgerAuditSummary = Awaited<ReturnType<typeof getCostLedgerAuditSummary>>;

type CostAmountRow = {
  amount_minor: number | null;
  amount_micros: number | null;
  currency: string | null;
};

function countDuplicateProviderTaskIds(rows: Array<{ provider_task_id: string | null }>) {
  const counts = new Map<string, number>();

  rows.forEach((row) => {
    const providerTaskId = row.provider_task_id?.trim();
    if (!providerTaskId) return;
    counts.set(providerTaskId, (counts.get(providerTaskId) || 0) + 1);
  });

  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([providerTaskId, count]) => ({ provider_task_id: providerTaskId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function sumCostByCurrency(rows: Array<{ amount_minor: number | null; amount_micros: number | null; currency: string | null }>) {
  const totals = new Map<string, number>();

  rows.forEach((row) => {
    if (row.amount_micros === null && row.amount_minor === null) return;
    const currency = row.currency || 'UNKNOWN';
    const amountMicros = row.amount_micros ?? (row.amount_minor as number) * 10_000;
    totals.set(currency, (totals.get(currency) || 0) + amountMicros);
  });

  return Array.from(totals.entries())
    .map(([currency, amount_micros]) => ({ currency, amount_micros, amount_minor: Math.round(amount_micros / 10_000) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

async function findOfficialChargeAllocations(ledgerIds: string[]) {
  const rows: CostAmountRow[] = [];

  // Prisma/SQLite 对单次 SQL 参数数量有限制；这里主动分批，避免后台数据增长后 /admin 直接服务端崩溃。
  for (let start = 0; start < ledgerIds.length; start += LEDGER_ID_QUERY_CHUNK_SIZE) {
    const batchLedgerIds = ledgerIds.slice(start, start + LEDGER_ID_QUERY_CHUNK_SIZE);
    if (batchLedgerIds.length === 0) continue;

    const batchRows = await prisma.costAllocation.findMany({
      where: {
        ledger_id: { in: batchLedgerIds },
        amount_minor: { not: null },
      },
      select: {
        amount_minor: true,
        amount_micros: true,
        currency: true,
      },
    });

    rows.push(...batchRows);
  }

  return rows;
}

export async function getCostLedgerAuditSummary() {
  const staleProviderRequestCutoff = new Date(Date.now() - 30 * 60 * 1000);

  const [
    ledgerCount,
    allocationCount,
    officialChargeLedgers,
    amountLedgersWithoutAllocationCount,
    terminalTasksWithoutCostLedgerCount,
    officialConfirmedTasksWithoutChargeLedgerCount,
    acceptedRequestsWithoutProviderTaskCount,
    stalePendingProviderRequestCount,
    duplicateProviderTaskRows,
    costStatusGroups,
    recentLedgers,
  ] = await Promise.all([
    prisma.costLedger.count(),
    prisma.costAllocation.count(),
    prisma.costLedger.findMany({
      where: { event_type: 'official_charge' },
      select: { id: true, amount_minor: true, amount_micros: true, currency: true },
    }),
    prisma.costLedger.count({
      where: {
        OR: [
          { amount_minor: { not: null } },
          { amount_micros: { not: null } },
        ],
        allocations: { none: {} },
      },
    }),
    prisma.videoTask.count({
      where: {
        local_status: { in: TERMINAL_TASK_STATUSES },
        cost_ledgers: { none: { event_type: { in: TERMINAL_COST_EVENTS } } },
      },
    }),
    prisma.videoTask.count({
      where: {
        provider_cost_status: { in: ['official_confirmed', 'reconciled'] },
        cost_ledgers: { none: { event_type: 'official_charge' } },
      },
    }),
    prisma.providerApiRequest.count({
      where: {
        status: 'accepted',
        provider_task_id: null,
      },
    }),
    prisma.providerApiRequest.count({
      where: {
        status: 'pending',
        created_at: { lt: staleProviderRequestCutoff },
      },
    }),
    prisma.videoTask.findMany({
      where: { provider_task_id: { not: null } },
      select: { provider_task_id: true },
    }),
    prisma.videoTask.groupBy({
      by: ['provider_cost_status'],
      _count: { _all: true },
      orderBy: { provider_cost_status: 'asc' },
    }),
    prisma.costLedger.findMany({
      orderBy: [{ occurred_at: 'desc' }, { created_at: 'desc' }],
      take: 8,
      select: {
        id: true,
        task_id: true,
        project_id: true,
        provider_task_id: true,
        event_type: true,
        amount_minor: true,
        currency: true,
        confidence: true,
        cost_source: true,
        official_charge_id: true,
        occurred_at: true,
        project: { select: { name: true } },
        task: { select: { prompt: true } },
      },
    }),
  ]);

  const officialChargeLedgerIds = officialChargeLedgers.map((ledger) => ledger.id);
  const officialAllocations = await findOfficialChargeAllocations(officialChargeLedgerIds);

  const duplicateProviderTaskIds = countDuplicateProviderTaskIds(duplicateProviderTaskRows);
  const issueCount =
    amountLedgersWithoutAllocationCount +
    terminalTasksWithoutCostLedgerCount +
    officialConfirmedTasksWithoutChargeLedgerCount +
    acceptedRequestsWithoutProviderTaskCount +
    stalePendingProviderRequestCount +
    duplicateProviderTaskIds.length;

  return {
    ledger_count: ledgerCount,
    allocation_count: allocationCount,
    official_charge_count: officialChargeLedgers.length,
    official_ledger_totals: sumCostByCurrency(officialChargeLedgers),
    official_allocation_totals: sumCostByCurrency(officialAllocations),
    amount_ledgers_without_allocation_count: amountLedgersWithoutAllocationCount,
    terminal_tasks_without_cost_ledger_count: terminalTasksWithoutCostLedgerCount,
    official_confirmed_tasks_without_charge_ledger_count: officialConfirmedTasksWithoutChargeLedgerCount,
    accepted_requests_without_provider_task_count: acceptedRequestsWithoutProviderTaskCount,
    stale_pending_provider_request_count: stalePendingProviderRequestCount,
    duplicate_provider_task_ids: duplicateProviderTaskIds,
    provider_cost_status_counts: costStatusGroups.map((group) => ({
      status: group.provider_cost_status,
      count: group._count._all,
    })),
    recent_ledgers: recentLedgers,
    issue_count: issueCount,
  };
}
