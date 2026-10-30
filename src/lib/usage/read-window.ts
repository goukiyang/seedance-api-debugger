import { Prisma } from '@prisma/client';
import type { UsageSourceKind } from '@/lib/admin/usage-types';

export type UsageReadWindow = { startUtc: string | null; endUtc: string | null };
export function usageSqlTime(value: Prisma.Sql) {
  return Prisma.sql`CASE WHEN typeof(${value}) IN ('integer', 'real') AND abs(${value}) <= 8640000000000000 THEN ${value}
    WHEN typeof(${value}) = 'text' THEN CAST(round((julianday(${value}) - 2440587.5) * 86400000) AS INTEGER) ELSE NULL END`;
}
const source = (kind: UsageSourceKind): { id: Prisma.Sql; at: Prisma.Sql } => {
  switch (kind) {
    case 'role_run': return { id: Prisma.sql`r."id"`, at: Prisma.sql`r."created_at"` };
    case 'role_attempt': return { id: Prisma.sql`a."id"`, at: Prisma.sql`a."started_at"` };
    case 'agent_text_step': return { id: Prisma.sql`s."id"`, at: Prisma.sql`s."created_at"` };
    case 'cutout_receipt': {
      const json = Prisma.sql`CASE WHEN json_valid("value_json") THEN "value_json" ELSE '{}' END`;
      return { id: Prisma.sql`json_extract(${json}, '$.receiptId')`, at: Prisma.sql`COALESCE(
        json_extract(${json}, '$.submittedAt'), json_extract(${json}, '$.job.created_at') * 1000,
        "created_at", json_extract(${json}, '$.createdAt'))` };
    }
    default: {
      const table = { video_task: 'VideoTask', image_task: 'ImageStudioTask', video_studio_run: 'VideoStudioRun', toolflow_run: 'ToolFlowRun' }[kind];
      return { id: Prisma.raw(`"${table}"."id"`), at: Prisma.raw(`"${table}"."created_at"`) };
    }
  }
};
export const usageSourceTime = (kind: UsageSourceKind) => source(kind).at;

/** The usage cohort uses frozen occurrence, never settlement or cash occurrence. */
export function usageWindowCondition(kind: UsageSourceKind, window: UsageReadWindow, attributionAvailable: boolean) {
  const original = source(kind), at = usageSqlTime(original.at);
  const frozen = Prisma.sql`(SELECT ua."occurred_at" FROM "UsageAttribution" ua WHERE ua."source_kind" = ${kind}
    AND ua."source_id" = ${original.id} AND ua."context_version" = 1)`;
  const effective = attributionAvailable ? Prisma.sql`COALESCE(${usageSqlTime(frozen)}, ${at})` : at;
  // Invalid times remain visible to coverage diagnostics instead of becoming zero usage.
  return Prisma.sql`(${effective} IS NULL OR (${window.startUtc ? Prisma.sql`${effective} >= ${Date.parse(window.startUtc)}` : Prisma.sql`1 = 1`}
    AND ${window.endUtc ? Prisma.sql`${effective} < ${Date.parse(window.endUtc)}` : Prisma.sql`1 = 1`}))`;
}
