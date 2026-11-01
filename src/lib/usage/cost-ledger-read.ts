import { Prisma } from '@prisma/client';
import { costLedgerListSql, type CostListFilters } from '@/app/admin/costs/list-filters';
import type { UsageSqlReader, UsageSqlRow, UsageSqlCell } from './sqlite-read-snapshot';
import { usageDateTime } from './database';

export const costLedgerExportSelect = {
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

export type CostLedgerExportRow = Prisma.CostLedgerGetPayload<{ select: typeof costLedgerExportSelect }>;

function text(value: UsageSqlCell, nullable: true): string | null;
function text(value: UsageSqlCell, nullable?: false): string;
function text(value: UsageSqlCell, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') throw new Error('Invalid cost ledger text');
  return value;
}
function integer(value: UsageSqlCell, nullable: true): number | null;
function integer(value: UsageSqlCell, nullable?: false): number;
function integer(value: UsageSqlCell, nullable = false): number | null {
  if (nullable && value === null) return null;
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < -2147483648 || number > 2147483647) throw new Error('Invalid cost ledger Int');
  return number;
}
function real(value: UsageSqlCell): number | null {
  if (value === null) return null;
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) throw new Error('Invalid cost ledger Float');
  return number;
}
function date(value: UsageSqlCell): Date {
  const result = usageDateTime(value);
  if (!(result instanceof Date) || !Number.isFinite(result.getTime())) throw new Error('Invalid cost ledger DateTime');
  return result;
}

export async function countCostLedgers(reader: UsageSqlReader, filters: CostListFilters): Promise<number> {
  const [row] = await reader.query<{ total: bigint | number }>(Prisma.sql`SELECT COUNT(*) AS "total" FROM "CostLedger" l WHERE ${costLedgerListSql(filters)}`);
  const total = Number(row.total);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Invalid cost ledger count');
  return total;
}

export async function readCostLedgerBatch(reader: UsageSqlReader, filters: CostListFilters, cursorId?: string): Promise<CostLedgerExportRow[]> {
  // Compare the cursor's stored time in SQLite; do not rebind a decoded Date.
  const cursor = cursorId ? Prisma.sql`AND (l."occurred_at" < (SELECT c."occurred_at" FROM "CostLedger" c WHERE c."id" = ${cursorId})
    OR (l."occurred_at" = (SELECT c."occurred_at" FROM "CostLedger" c WHERE c."id" = ${cursorId}) AND l."id" < ${cursorId}))` : Prisma.empty;
  const rows = await reader.query(Prisma.sql`SELECT l."id", l."source_type", l."source_id", l."task_id", l."user_id", l."project_id", l."provider_request_id",
    l."provider_name", l."provider_account_id", l."provider_task_id", l."event_type", l."amount_minor", l."amount_micros", l."currency", l."usage_quantity", l."usage_unit",
    l."cost_source", l."confidence", l."pricing_rule_id", l."official_charge_id", l."reason", l."idempotency_key", l."occurred_at", l."created_at",
    t."id" AS "task_relation_id", t."source_type" AS "task_source_type", t."source_label" AS "task_source_label", t."source_request_id" AS "task_source_request_id",
    t."local_status" AS "task_local_status", t."model" AS "task_model", t."resolution" AS "task_resolution", t."duration" AS "task_duration",
    p."id" AS "project_relation_id", p."name" AS "project_name", r."id" AS "request_relation_id", r."status" AS "request_status", r."endpoint" AS "request_endpoint",
    r."http_status" AS "request_http_status", r."error_code" AS "request_error_code"
    FROM "CostLedger" l LEFT JOIN "VideoTask" t ON t."id" = l."task_id" LEFT JOIN "Project" p ON p."id" = l."project_id"
      LEFT JOIN "ProviderApiRequest" r ON r."id" = l."provider_request_id"
    WHERE (${costLedgerListSql(filters)}) ${cursor} ORDER BY l."occurred_at" DESC, l."id" DESC LIMIT 500`);
  const allocations = new Map<string, CostLedgerExportRow['allocations']>();
  if (rows.length) {
    // No ORDER BY: retain the original Prisma relation query's SQLite order.
    const values = await reader.query(Prisma.sql`SELECT "ledger_id", "allocation_type", "allocation_id", "amount_minor", "amount_micros", "currency", "usage_quantity", "usage_unit"
      FROM "CostAllocation" WHERE "ledger_id" IN (${Prisma.join(rows.map(row => row.id))})`);
    for (const row of values) {
      const id = text(row.ledger_id), items = allocations.get(id) || [];
      items.push({ allocation_type: text(row.allocation_type), allocation_id: text(row.allocation_id), amount_minor: integer(row.amount_minor, true),
        amount_micros: integer(row.amount_micros, true), currency: text(row.currency, true), usage_quantity: real(row.usage_quantity), usage_unit: text(row.usage_unit, true) });
      allocations.set(id, items);
    }
  }
  return rows.map((row: UsageSqlRow) => ({
    id: text(row.id), source_type: text(row.source_type), source_id: text(row.source_id, true), task_id: text(row.task_id, true), user_id: text(row.user_id, true), project_id: text(row.project_id, true),
    provider_request_id: text(row.provider_request_id, true), provider_name: text(row.provider_name), provider_account_id: text(row.provider_account_id, true), provider_task_id: text(row.provider_task_id, true),
    event_type: text(row.event_type), amount_minor: integer(row.amount_minor, true), amount_micros: integer(row.amount_micros, true), currency: text(row.currency, true),
    usage_quantity: real(row.usage_quantity), usage_unit: text(row.usage_unit, true), cost_source: text(row.cost_source), confidence: text(row.confidence), pricing_rule_id: text(row.pricing_rule_id, true),
    official_charge_id: text(row.official_charge_id, true), reason: text(row.reason, true), idempotency_key: text(row.idempotency_key, true), occurred_at: date(row.occurred_at), created_at: date(row.created_at),
    task: row.task_relation_id === null ? null : { source_type: text(row.task_source_type), source_label: text(row.task_source_label, true), source_request_id: text(row.task_source_request_id, true),
      local_status: text(row.task_local_status), model: text(row.task_model), resolution: text(row.task_resolution, true), duration: integer(row.task_duration, true) },
    project: row.project_relation_id === null ? null : { name: text(row.project_name) },
    provider_request: row.request_relation_id === null ? null : { status: text(row.request_status), endpoint: text(row.request_endpoint), http_status: integer(row.request_http_status, true), error_code: text(row.request_error_code, true) },
    allocations: allocations.get(text(row.id)) || [],
  }));
}
