import { Prisma } from '@prisma/client';
import type { UsageSourceKind } from '@/lib/admin/usage-types';
import type { UsageFactReadOptions } from './facts';
import { usageSourceTime, usageSqlTime, usageWindowCondition } from './read-window';

/** Keep the all-history selector without loading all-history facts or media. */
export async function readUsageProjectDirectory(db: Prisma.TransactionClient, options: UsageFactReadOptions, status: string | null, asOf: string) {
  const sources: Array<{ kind: UsageSourceKind; from: Prisma.Sql; id: Prisma.Sql; project: Prisma.Sql; state: Prisma.Sql }> = [
    { kind: 'video_task', from: Prisma.sql`"VideoTask"`, id: Prisma.sql`"VideoTask"."id"`, project: Prisma.sql`"project_id"`, state: Prisma.sql`"local_status"` },
    { kind: 'image_task', from: Prisma.sql`"ImageStudioTask"`, id: Prisma.sql`"ImageStudioTask"."id"`, project: Prisma.sql`(SELECT json_extract(CASE WHEN json_valid(f."snapshot_json") THEN f."snapshot_json" ELSE '{}' END, '$.project_id') FROM "ToolFlowRun" f WHERE f."id" = "tool_flow_run_id" AND json_extract(CASE WHEN json_valid(f."snapshot_json") THEN f."snapshot_json" ELSE '{}' END, '$.schema') = 'toolflow.v1')`, state: Prisma.sql`"status"` },
    { kind: 'video_studio_run', from: Prisma.sql`"VideoStudioRun"`, id: Prisma.sql`"VideoStudioRun"."id"`, project: Prisma.sql`NULL`, state: Prisma.sql`"status"` },
    { kind: 'role_run', from: Prisma.sql`"CanvasRoleTaskRun" r`, id: Prisma.sql`r."id"`, project: Prisma.sql`NULL`, state: Prisma.sql`r."status"` },
    { kind: 'role_attempt', from: Prisma.sql`"CanvasRoleAttempt" a LEFT JOIN "CanvasRoleWork" w ON w."id" = a."work_id" LEFT JOIN "CanvasRoleTaskRun" r ON r."id" = w."role_task_run_id"`, id: Prisma.sql`a."id"`, project: Prisma.sql`NULL`, state: Prisma.sql`a."state"` },
    { kind: 'toolflow_run', from: Prisma.sql`"ToolFlowRun"`, id: Prisma.sql`"ToolFlowRun"."id"`, project: Prisma.sql`CASE WHEN json_extract(CASE WHEN json_valid("snapshot_json") THEN "snapshot_json" ELSE '{}' END, '$.schema') = 'toolflow.v1'
      THEN json_extract("snapshot_json", '$.project_id') ELSE NULL END`, state: Prisma.sql`"status"` },
  ];
  const exists = await db.$queryRaw<Array<{ name: string }>>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'UsageAttribution'`;
  const ids = new Set<string | null>();
  for (const source of sources) {
    const rawState = Prisma.sql`CASE WHEN substr(${source.state}, 1, 5) = 'rate_' THEN substr(${source.state}, 6) ELSE ${source.state} END`;
    const state = Prisma.sql`CASE WHEN ${rawState} IN ('channel_queued', 'channel_running') THEN substr(${rawState}, 9) ELSE ${rawState} END`;
    const project = exists.length ? Prisma.sql`CASE WHEN EXISTS (SELECT 1 FROM "UsageAttribution" ua WHERE ua."source_kind" = ${source.kind} AND ua."source_id" = ${source.id})
      THEN (SELECT ua."project_id" FROM "UsageAttribution" ua WHERE ua."source_kind" = ${source.kind} AND ua."source_id" = ${source.id} AND ua."context_version" = 1 AND ${usageSqlTime(Prisma.sql`ua."occurred_at"`)} IS NOT NULL)
      ELSE ${source.project} END` : source.project;
    const rows = await db.$queryRaw<Array<{ projectId: string | null }>>(Prisma.sql`SELECT DISTINCT ${project} AS "projectId" FROM ${source.from}
      WHERE ${options.conditions[source.kind]} AND ${usageSqlTime(usageSourceTime(source.kind))} IS NOT NULL
      AND ${usageWindowCondition(source.kind, { startUtc: null, endUtc: new Date(Date.parse(asOf) + 1).toISOString() }, exists.length > 0)}
      AND (${source.kind === 'video_studio_run' ? Prisma.sql`"mode" = 'llm'` : Prisma.sql`1 = 1`})
      AND (${status ? Prisma.sql`${state} = ${status}` : Prisma.sql`1 = 1`})`);
    for (const row of rows) if (row.projectId === null || options.projectWhere || options.projectNames.has(row.projectId)) ids.add(row.projectId);
  }
  const names: Array<{ id: string | null; label: string }> = ids.has(null) ? [{ id: null, label: '未归属项目' }] : [];
  const selected = Array.from(ids).filter((id): id is string => id !== null);
  for (let offset = 0; offset < selected.length; offset += 400) {
    const projects = await db.project.findMany({ where: { AND: [{ id: { in: selected.slice(offset, offset + 400) } }, options.projectWhere || {}] }, select: { id: true, name: true } });
    names.push(...projects.map(project => ({ id: project.id, label: project.name })));
  }
  return names.sort((a, b) => a.label.localeCompare(b.label) || (a.id || '').localeCompare(b.id || ''));
}
