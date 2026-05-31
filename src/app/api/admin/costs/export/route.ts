import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { costAmountToCnyEstimate, usdToCnyRateText } from '@/lib/costs/currency';

export const dynamic = 'force-dynamic';

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? '' : String(value);
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

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);

    const ledgers = await prisma.costLedger.findMany({
      orderBy: [{ occurred_at: 'desc' }, { created_at: 'desc' }],
      select: {
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
            prompt: true,
            source_type: true,
            source_label: true,
            source_request_id: true,
            local_status: true,
            model: true,
            resolution: true,
            duration: true,
          },
        },
        user: { select: { name: true, username: true, email: true } },
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
      },
    });

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
      'user_name',
      'user_email',
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
      'prompt',
    ];

    const rows = ledgers.map((ledger) => [
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
      ledger.user?.name || ledger.user?.username,
      ledger.user?.email,
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
      ledger.task?.prompt,
    ]);

    const csv = [
      headers.map(csvCell).join(','),
      ...rows.map((row) => row.map(csvCell).join(',')),
    ].join('\n');

    const today = new Date().toISOString().slice(0, 10);
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="cost-ledger-${today}.csv"`,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[AdminCostLedgerExport] Failed:', error);
    return NextResponse.json({ error: '导出总账失败' }, { status: 500 });
  }
}
