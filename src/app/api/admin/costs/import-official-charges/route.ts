import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { officialChargeIdempotencyKey, recordTaskOfficialCharge } from '@/lib/costs/ledger';

export const dynamic = 'force-dynamic';

const ALLOWED_CURRENCIES = new Set(['CNY', 'USD']);
const MAX_ROWS = 200;

type ImportRow = {
  rowNumber: number;
  taskId: string;
  providerTaskId: string;
  officialChargeId: string;
  amountMinor: number | null;
  currency: string;
  occurredAt?: Date;
  reason: string;
  errors: string[];
  raw: Record<string, string>;
};

type ImportResult = {
  row_number: number;
  status: 'ready' | 'imported' | 'duplicated' | 'unmatched' | 'ambiguous' | 'invalid' | 'failed';
  message: string;
  task_id?: string;
  provider_task_id?: string | null;
  official_charge_id?: string;
  amount_minor?: number | null;
  currency?: string;
  ledger_id?: string;
};

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function normalizeHeader(header: string) {
  return header.trim().replace(/^\uFEFF/, '').toLowerCase().replace(/[\s_-]+/g, '');
}

function canonicalField(header: string): string | null {
  const normalized = normalizeHeader(header);
  if (['taskid', 'internaltaskid', 'videotaskid', '任务id', '内部任务id'].includes(normalized)) return 'taskId';
  if (['providertaskid', 'seedancetaskid', 'externaltaskid', '官方任务id', '供应商任务id'].includes(normalized)) return 'providerTaskId';
  if (['officialchargeid', 'chargeid', 'billid', 'billingid', 'invoicelineid', '账单id', '扣费id', '官方扣费id'].includes(normalized)) return 'officialChargeId';
  if (['amount', 'cost', 'charge', 'officialcost', '金额', '扣费', '费用'].includes(normalized)) return 'amount';
  if (['amountminor', 'costminor', 'chargeminor', 'officialcostminor', '分', '金额分'].includes(normalized)) return 'amountMinor';
  if (['currency', '币种'].includes(normalized)) return 'currency';
  if (['occurredat', 'chargedat', 'date', 'time', '扣费时间', '账单时间', '日期'].includes(normalized)) return 'occurredAt';
  if (['reason', 'note', 'remark', '备注', '说明'].includes(normalized)) return 'reason';
  return null;
}

function parseAmountMinor(row: Record<string, string>): number | null {
  const amountMinor = row.amountMinor?.trim();
  if (amountMinor) {
    const parsed = Number(amountMinor.replace(/[,，]/g, ''));
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
    return null;
  }

  const amount = row.amount?.trim();
  if (!amount) return null;

  const normalized = amount.replace(/[¥$,，]/g, '').trim();
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function parseOccurredAt(value: string | undefined, errors: string[]) {
  if (!value?.trim()) return undefined;
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) {
    errors.push('扣费时间无法解析');
    return undefined;
  }
  return parsed;
}

function buildRows(csv: string, defaultCurrency: string, defaultReason: string): ImportRow[] {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error('CSV 至少需要表头和一行数据');
  if (rows.length - 1 > MAX_ROWS) throw new Error(`单次最多导入 ${MAX_ROWS} 行`);

  const headers = rows[0].map(canonicalField);
  if (!headers.some(Boolean)) throw new Error('无法识别 CSV 表头');

  return rows.slice(1).map((values, index) => {
    const normalized: Record<string, string> = {};
    const raw: Record<string, string> = {};
    const errors: string[] = [];

    values.forEach((value, valueIndex) => {
      const rawHeader = rows[0][valueIndex] || `column_${valueIndex + 1}`;
      raw[rawHeader] = value.trim();
      const field = headers[valueIndex];
      if (field) normalized[field] = value.trim();
    });

    const currency = (normalized.currency || defaultCurrency || 'CNY').trim().toUpperCase();
    const amountMinor = parseAmountMinor(normalized);
    if (amountMinor === null) errors.push('金额不合法');
    if (!ALLOWED_CURRENCIES.has(currency)) errors.push('币种暂只支持 CNY 或 USD');
    if (!normalized.officialChargeId?.trim()) errors.push('官方扣费 ID 不能为空');
    if (!normalized.taskId?.trim() && !normalized.providerTaskId?.trim()) {
      errors.push('task_id 和 provider_task_id 至少需要一个');
    }

    return {
      rowNumber: index + 2,
      taskId: normalized.taskId || '',
      providerTaskId: normalized.providerTaskId || '',
      officialChargeId: normalized.officialChargeId || '',
      amountMinor,
      currency,
      occurredAt: parseOccurredAt(normalized.occurredAt, errors),
      reason: normalized.reason || defaultReason,
      errors,
      raw,
    };
  });
}

async function findMatchedTask(row: ImportRow) {
  if (row.taskId) {
    const task = await prisma.videoTask.findUnique({ where: { id: row.taskId } });
    if (!task) return { status: 'unmatched' as const, message: '内部任务 ID 未找到' };
    if (row.providerTaskId && task.provider_task_id !== row.providerTaskId) {
      return { status: 'invalid' as const, message: '内部任务 ID 与 provider_task_id 不一致' };
    }
    return { status: 'matched' as const, task };
  }

  const tasks = await prisma.videoTask.findMany({
    where: { provider_task_id: row.providerTaskId },
    orderBy: { created_at: 'desc' },
    take: 2,
  });
  if (tasks.length === 0) return { status: 'unmatched' as const, message: 'provider_task_id 未找到' };
  if (tasks.length > 1) return { status: 'ambiguous' as const, message: 'provider_task_id 匹配到多个任务，请补充 task_id' };
  return { status: 'matched' as const, task: tasks[0] };
}

function resultFromRow(row: ImportRow, status: ImportResult['status'], message: string): ImportResult {
  return {
    row_number: row.rowNumber,
    status,
    message,
    task_id: row.taskId || undefined,
    provider_task_id: row.providerTaskId || undefined,
    official_charge_id: row.officialChargeId || undefined,
    amount_minor: row.amountMinor,
    currency: row.currency,
  };
}

async function processRow(row: ImportRow, dryRun: boolean, adminUserId: string): Promise<ImportResult> {
  if (row.errors.length > 0) {
    return resultFromRow(row, 'invalid', row.errors.join('；'));
  }

  const match = await findMatchedTask(row);
  if (match.status !== 'matched') {
    return resultFromRow(row, match.status, match.message);
  }

  const task = match.task;
  const idempotencyKey = officialChargeIdempotencyKey(task.provider, row.officialChargeId);
  const existingLedger = await prisma.costLedger.findUnique({ where: { idempotency_key: idempotencyKey } });
  if (existingLedger?.task_id && existingLedger.task_id !== task.id) {
    return resultFromRow(row, 'invalid', '官方扣费 ID 已关联其他任务');
  }
  if (existingLedger) {
    return {
      ...resultFromRow(row, dryRun ? 'duplicated' : 'duplicated', '这条官方扣费已入账，本次不会重复记账'),
      task_id: task.id,
      provider_task_id: task.provider_task_id,
      ledger_id: existingLedger.id,
    };
  }

  if (dryRun) {
    return {
      ...resultFromRow(row, 'ready', '可导入'),
      task_id: task.id,
      provider_task_id: task.provider_task_id,
    };
  }

  const charge = await prisma.$transaction((tx) => recordTaskOfficialCharge(tx, task, {
    amountMinor: row.amountMinor as number,
    currency: row.currency,
    officialChargeId: row.officialChargeId,
    reason: row.reason,
    occurredAt: row.occurredAt,
    createdBy: adminUserId,
  }));

  return {
    ...resultFromRow(row, charge.deduplicated ? 'duplicated' : 'imported', charge.deduplicated ? '已存在，未重复入账' : '已入账'),
    task_id: task.id,
    provider_task_id: task.provider_task_id,
    ledger_id: charge.ledger.id,
  };
}

function summarize(results: ImportResult[]) {
  return results.reduce<Record<string, number>>((summary, result) => {
    summary[result.status] = (summary[result.status] || 0) + 1;
    return summary;
  }, {});
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAdminUser(request);
    const body = await request.json() as Record<string, unknown>;
    const csv = typeof body.csv === 'string' ? body.csv.trim() : '';
    const dryRun = body.dry_run !== false;
    const defaultCurrency = typeof body.default_currency === 'string' ? body.default_currency.trim().toUpperCase() : 'CNY';
    const defaultReason = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim()
      : '官方账单批量导入';

    if (!csv) return NextResponse.json({ error: 'CSV 内容不能为空' }, { status: 400 });
    if (!ALLOWED_CURRENCIES.has(defaultCurrency)) {
      return NextResponse.json({ error: '默认币种暂只支持 CNY 或 USD' }, { status: 400 });
    }

    const rows = buildRows(csv, defaultCurrency, defaultReason);
    const results: ImportResult[] = [];

    for (const row of rows) {
      try {
        results.push(await processRow(row, dryRun, user.id));
      } catch (error) {
        results.push(resultFromRow(row, 'failed', error instanceof Error ? error.message : '导入失败'));
      }
    }

    const summary = summarize(results);

    if (!dryRun) {
      await prisma.operationLog.create({
        data: {
          operator_id: user.id,
          action: 'official_charge_import',
          target_type: 'CostLedger',
          target_id: null,
          detail: JSON.stringify({ summary, row_count: rows.length }),
        },
      });
    }

    return NextResponse.json({
      ok: true,
      dry_run: dryRun,
      summary,
      results,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[AdminOfficialChargeImport] Failed:', error);
    return NextResponse.json(
      { error: '导入官方账单失败', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
