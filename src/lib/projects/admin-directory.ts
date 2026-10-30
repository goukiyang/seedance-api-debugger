import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

const emptyTables = ['VideoCard', 'VideoTask', 'CanvasDocument', 'ReferenceAlbum', 'ReferenceImage', 'ProviderApiRequest',
  'CostLedger', 'CostAllocation', 'ProjectBudgetLedger', 'ApprovalRecord', 'ContentAuditLog', 'ReviewCard', 'Notification', 'ToolFlow', 'UsageAttribution'] as const;

/** Same historical blockers as the operation preview; mutations still recheck their original contract. */
function emptyProjectSql() {
  return Prisma.sql`p."type" IN ('team', 'public') AND p."status" IN ('active', 'locked', 'archived')
    AND ${Prisma.join(emptyTables.map(table => Prisma.sql`NOT EXISTS (SELECT 1 FROM ${Prisma.raw(`"${table}"`)} e WHERE e."project_id" = p."id")`), ' AND ')}
    AND NOT EXISTS (SELECT 1 FROM "ReferenceImage" e JOIN "ReferenceAlbum" a ON a."id" = e."album_id" WHERE a."project_id" = p."id")
    AND NOT EXISTS (SELECT 1 FROM "FeishuRequirement" e WHERE e."created_project_id" = p."id")
    AND NOT EXISTS (SELECT 1 FROM "ProjectInvite" e WHERE e."project_id" = p."id" AND e."used_count" > 0)
    AND NOT EXISTS (SELECT 1 FROM "ProjectMember" e WHERE e."project_id" = p."id" AND (e."status" <> 'active' OR e."role" NOT IN ('project_owner', 'editor', 'member', 'viewer')))
    AND p."id" NOT IN (SELECT json_extract("snapshot_json", '$.project_id') FROM "ToolFlowRun"
      WHERE json_valid("snapshot_json") AND json_type("snapshot_json", '$.project_id') = 'text')
    AND NOT EXISTS (SELECT 1 FROM "ProjectBudgetAccount" e WHERE e."project_id" = p."id" AND
      (e."budget_credits" IS NOT 0 OR e."used_credits" IS NOT 0 OR e."frozen_credits" IS NOT 0 OR e."status" IS NOT 'active' OR e."currency" IS NOT 'credits'
       OR e."reconciliation_status" IS NOT 'normal' OR e."freeze_reason" IS NOT NULL AND e."freeze_reason" <> ''
       OR e."threshold_notified_json" IS NOT NULL AND e."threshold_notified_json" NOT IN ('', '[]')
       OR EXISTS (SELECT 1 FROM "ProjectBudgetLedger" l WHERE l."account_id" = e."id")))
    AND NOT EXISTS (SELECT 1 FROM "OperationLog" e WHERE e."target_type" = 'project' AND e."target_id" = p."id"
      AND e."action" NOT IN ('project_create', 'project_create_default', 'project_invite_create', 'project_update', 'project_archive', 'project_restore')
      AND NOT (e."action" = 'project_member_join' AND COALESCE(json_extract(CASE WHEN json_valid(e."detail") THEN e."detail" ELSE '{}' END, '$.source'), '') = 'create_project'))`;
}

export async function readAdminProjectPage(db: Pick<PrismaClient, '$queryRaw' | 'project'>, params: URLSearchParams, canManage: boolean) {
  const query = (params.get('search') || '').trim().slice(0, 120), filter = params.get('filter') || 'active';
  const requested = Number(params.get('page') || 1), pageSize = 20;
  const pageNumber = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 1_000_000) : 1;
  const exactName = params.get('exact_name');
  const nontechnical = (field: Prisma.Sql) => Prisma.sql`trim(COALESCE(${field}, '')) <> '' AND length(trim(${field})) <= 40
    AND lower(trim(${field})) NOT GLOB 'ou_*' AND lower(trim(${field})) NOT GLOB 'ou-*'
    AND lower(trim(${field})) NOT GLOB 'feishu_*' AND lower(trim(${field})) NOT GLOB 'open_*' AND lower(trim(${field})) NOT GLOB 'union_*'`;
  const ownerLabel = Prisma.sql`CASE WHEN ${nontechnical(Prisma.sql`u."name"`)} THEN trim(u."name")
    WHEN trim(COALESCE(u."email", '')) <> '' AND lower(trim(u."email")) NOT GLOB '*@feishu.local' AND lower(trim(u."email")) NOT GLOB 'feishu_*' THEN trim(u."email")
    WHEN ${nontechnical(Prisma.sql`u."username"`)} THEN trim(u."username") ELSE '用户 ' || substr(u."id", 1, 6) END`;
  const condition = Prisma.sql`p."status" <> 'deleted'
    AND (${query ? Prisma.sql`(instr(lower(p."name"), lower(${query})) > 0 OR instr(lower(p."id"), lower(${query})) > 0
      OR instr(lower(COALESCE(p."description", '')), lower(${query})) > 0 OR EXISTS (SELECT 1 FROM "User" u
        WHERE u."id" = p."owner_user_id" AND instr(lower(${ownerLabel}), lower(${query})) > 0))` : Prisma.sql`1 = 1`})
    AND (${exactName ? Prisma.sql`p."name" = ${exactName}` : Prisma.sql`1 = 1`})
    AND (${filter === 'active' || filter === 'archived' ? Prisma.sql`p."status" = ${filter}` : filter === 'empty'
      ? canManage ? emptyProjectSql() : Prisma.sql`0 = 1`
      : filter === 'smoke' ? Prisma.sql`((' ' || lower(p."name") || ' ') GLOB '*[^a-z0-9_]smoke project[^a-z0-9_]*' OR instr(lower(COALESCE(p."description", '')), 'closure smoke') > 0)` : Prisma.sql`1 = 1`})`;
  const focus = params.get('focus');
  const focusedProject = focus ? await db.project.findFirst({ where: { id: focus, status: { not: 'deleted' } }, select: { id: true, type: true, updated_at: true } }) : null;
  const where = focus ? Prisma.sql`p."status" <> 'deleted' AND (p."id" = ${focus} OR (${condition}))` : condition;
  let requestedPage = pageNumber;
  if (focus && params.get('locate') === '1') {
    const target = focusedProject;
    if (target) {
      const before = await db.$queryRaw<Array<{ total: number | bigint }>>(Prisma.sql`SELECT COUNT(*) AS total FROM "Project" p
        WHERE ${where} AND (p."type" < ${target.type} OR p."type" = ${target.type} AND
          (p."updated_at" > ${target.updated_at} OR p."updated_at" = ${target.updated_at} AND p."id" > ${target.id}))`);
      requestedPage = Math.floor(Number(before[0]?.total || 0) / pageSize) + 1;
    }
  }
  const counts = await db.$queryRaw<Array<{ total: number | bigint }>>(Prisma.sql`SELECT COUNT(*) AS total FROM "Project" p WHERE ${where}`);
  const total = Number(counts[0]?.total || 0), totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT p."id" FROM "Project" p WHERE ${where}
    ORDER BY p."type" ASC, p."updated_at" DESC, p."id" DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
  const projects = await db.project.findMany({ where: { id: { in: rows.map(row => row.id) }, status: { not: 'deleted' } },
    include: { owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
      _count: { select: { members: true, tasks: true, reference_albums: { where: { status: { not: 'deleted' } } } } } } });
  const byId = new Map(projects.map(project => [project.id, project]));
  return { projects: rows.flatMap(row => byId.has(row.id) ? [byId.get(row.id)!] : []), focusedAvailable: Boolean(focusedProject), pagination: { page, page_size: pageSize, total, total_pages: totalPages } };
}
