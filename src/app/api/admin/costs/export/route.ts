import { route as apiRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { costAmountToCnyEstimate, usdToCnyRateText } from '@/lib/costs/currency';
import { costLedgerListWhere, parseCostListFilters } from '@/app/admin/costs/list-filters';

export const dynamic = 'force-dynamic';

function csvCell(value: unknown) {
  let text = value === null || value === undefined ? '' : String(value);
  if (typeof value === 'string' && /^[\s]*[=+\-@\t\r]/.test(value)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function formatAllocationSummary(allocations: Array<{
  allocation_type: string;
  allocation_id: string;
  amount_minor: number | null;
  amount_micros: number | null;
  currency: string | null;
  usage_quantity: number | null;
  usage_unit: string | null;
}>) {
  return allocations
    .map((allocation) => {
      const amount = allocation.amount_micros !== null
        ? `${allocation.amount_micros} micros${allocation.currency ? ` ${allocation.currency}` : ''}`
        : allocation.amount_minor === null
          ? ''
          : `${allocation.amount_minor}${allocation.currency ? ` ${allocation.currency}` : ''}`;
      const usage = allocation.usage_quantity === null ? '' : `${allocation.usage_quantity} ${allocation.usage_unit || ''}`.trim();
      return [
        `${allocation.allocation_type}:${allocation.allocation_id}`,
        amount,
        usage,
      ].filter(Boolean).join(' ');
    })
    .join('; ');
}

export const GET = apiRoute({ access: 'admin', rateLimit: false }, async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);

    let filters;
    try { filters = parseCostListFilters(request.nextUrl.searchParams); }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : '筛选条件无效' }, { status: 400 }); }
    const where = costLedgerListWhere(filters);
    let dataAsOf = '';
    const select = {
        id: true,
        source_type: true,
        source_id: true,
        task_id: true,
        user_id: true,
        project_id: true,
        provider_request_id: true,
        provider_name: true,
        provider_account_id: true,
        provider_task_id: true,
        event_type: true,
        amount_minor: true,
        amount_micros: true,
        currency: true,
        usage_quantity: true,
        usage_unit: true,
        cost_source: true,
        confidence: true,
        pricing_rule_id: true,
        official_charge_id: true,
        reason: true,
        idempotency_key: true,
        occurred_at: true,
        created_at: true,
        task: {
          select: {
            source_type: true,
            source_label: true,
            source_request_id: true,
            local_status: true,
            model: true,
            resolution: true,
            duration: true,
          },
        },
        project: { select: { name: true } },
        provider_request: {
          select: {
            status: true,
            endpoint: true,
            http_status: true,
            error_code: true,
          },
        },
        allocations: {
          select: {
            allocation_type: true,
            allocation_id: true,
            amount_minor: true,
            amount_micros: true,
            currency: true,
            usage_quantity: true,
            usage_unit: true,
          },
        },
      } satisfies Prisma.CostLedgerSelect;

    const headers = [
      'ledger_id',
      'occurred_at',
      'created_at',
      'source_type',
      'source_id',
      'event_type',
      'cost_source',
      'confidence',
      'provider',
      'provider_account_id',
      'provider_task_id',
      'provider_request_id',
      'provider_request_status',
      'provider_endpoint',
      'provider_http_status',
      'provider_error_code',
      'task_id',
      'task_source_type',
      'task_source_label',
      'task_source_request_id',
      'task_status',
      'task_model',
      'task_resolution',
      'task_duration',
      'project_id',
      'project_name',
      'user_id',
      'amount_minor',
      'amount_micros',
      'currency',
      'cny_estimate',
      'cny_estimate_rate',
      'usage_quantity',
      'usage_unit',
      'official_charge_id',
      'pricing_rule_id',
      'idempotency_key',
      'allocation_summary',
      'reason',
      'data_as_of',
    ];

    const row = (ledger: Prisma.CostLedgerGetPayload<{ select: typeof select }>) => [
      ledger.id,
      ledger.occurred_at.toISOString(),
      ledger.created_at.toISOString(),
      ledger.source_type,
      ledger.source_id,
      ledger.event_type,
      ledger.cost_source,
      ledger.confidence,
      ledger.provider_name,
      ledger.provider_account_id,
      ledger.provider_task_id,
      ledger.provider_request_id,
      ledger.provider_request?.status,
      ledger.provider_request?.endpoint,
      ledger.provider_request?.http_status,
      ledger.provider_request?.error_code,
      ledger.task_id,
      ledger.task?.source_type,
      ledger.task?.source_label,
      ledger.task?.source_request_id,
      ledger.task?.local_status,
      ledger.task?.model,
      ledger.task?.resolution,
      ledger.task?.duration,
      ledger.project_id,
      ledger.project?.name,
      ledger.user_id,
      ledger.amount_minor,
      ledger.amount_micros,
      ledger.currency,
      costAmountToCnyEstimate(ledger),
      ledger.currency === 'USD' ? usdToCnyRateText() : '',
      ledger.usage_quantity,
      ledger.usage_unit,
      ledger.official_charge_id,
      ledger.pricing_rule_id,
      ledger.idempotency_key,
      formatAllocationSummary(ledger.allocations),
      ledger.reason,
      dataAsOf,
    ];
    const encoder = new TextEncoder();
    let cancelled = false;
    let resume: (() => void) | null = null;
    let resolveSnapshot!: (value: { dataAsOf: string; total: number }) => void;
    let rejectSnapshot!: (error: unknown) => void;
    const snapshot = new Promise<{ dataAsOf: string; total: number }>((resolve, reject) => { resolveSnapshot = resolve; rejectSnapshot = reject; });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void prisma.$transaction(async tx => {
          const total = await tx.costLedger.count({ where });
          dataAsOf = new Date().toISOString();
          resolveSnapshot({ dataAsOf, total });
          const write = async (text: string) => {
            while (!cancelled && controller.desiredSize !== null && controller.desiredSize <= 0) {
              await new Promise<void>(resolve => { resume = resolve; });
            }
            if (cancelled || request.signal.aborted) throw new Error('Cost ledger export interrupted');
            controller.enqueue(encoder.encode(text));
          };
          await write(`\uFEFF${headers.map(csvCell).join(',')}\n`);
          let cursor: string | undefined;
          for (;;) {
            if (cancelled || request.signal.aborted) throw new Error('Cost ledger export interrupted');
            const ledgers = await tx.costLedger.findMany({ where, select,
              orderBy: [{ occurred_at: 'desc' }, { id: 'desc' }], take: 500,
              ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
            if (!ledgers.length) break;
            await write(ledgers.map(ledger => row(ledger).map(csvCell).join(',')).join('\n') + '\n');
            cursor = ledgers[ledgers.length - 1].id;
            if (ledgers.length < 500) break;
          }
        }, { timeout: 120000 }).then(() => { if (!cancelled) controller.close(); }).catch(error => {
          rejectSnapshot(error);
          const wasCancelled = cancelled; cancelled = true; const next = resume; resume = null; next?.();
          if (!wasCancelled) controller.error(error);
        });
      },
      pull() { const next = resume; resume = null; next?.(); },
      cancel() { cancelled = true; const next = resume; resume = null; next?.(); },
    });
    const exported = await snapshot;
    const today = new Date().toISOString().slice(0, 10);
    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="cost-ledger-${today}.csv"`,
        'Cache-Control': 'private, no-store',
        'X-Data-As-Of': exported.dataAsOf,
        'X-Export-Total': String(exported.total),
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[AdminCostLedgerExport] Failed:', error);
    return NextResponse.json({ error: '导出总账失败' }, { status: 500 });
  }
});
