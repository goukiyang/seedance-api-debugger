import { Prisma } from '@prisma/client';
import { AuthError } from '@/lib/auth/session';
import type { UsageSourceKind } from '@/lib/admin/usage-types';
import type { UsageFactReadOptions } from './facts';
import { isExternalUser } from '@/lib/access/external-role';
import type { PublicUsageScope, UsagePublicQuery } from './dto';
import { usageScopeUser } from './access';
import { MULTIVIEW_PUBLIC_TASK_TITLE } from '@/lib/video/multiview-task-privacy';

const FALSE = Prisma.sql`0 = 1`;

/** Resolve current permission intersections inside the same read snapshot. */
export async function resolveUsageReadOptions(db: Prisma.TransactionClient, scope: PublicUsageScope, query: UsagePublicQuery): Promise<UsageFactReadOptions> {
  if (scope.kind !== 'self' && scope.kind !== 'project') throw new AuthError('此入口不接受管理员全站范围', 403);
  const user = usageScopeUser(scope);
  const current = await db.user.findUnique({ where: { id: user.id }, select: { status: true, role: true, account_type: true, expires_at: true, feature_profile_id: true, user_profile: true,
    feishu_user_id: true, feishu_open_id: true, feishu_union_id: true } });
  if (!current || current.status !== 'active' || current.role !== user.role || current.account_type !== user.account_type
    || current.feature_profile_id !== user.feature_profile_id || current.user_profile !== user.user_profile
    || (current.feishu_user_id || null) !== (user.feishu?.user_id || null) || (current.feishu_open_id || null) !== (user.feishu?.open_id || null)
    || (current.feishu_union_id || null) !== (user.feishu?.union_id || null)
    || current.expires_at && current.expires_at.getTime() <= Date.now()) throw new AuthError('账号权限已变化，请重新登录后核对', 403);
  const projectWhere: Prisma.ProjectWhereInput = { status: { not: 'deleted' }, ...(user.role === 'admin' ? {} : {
    OR: [{ owner_user_id: user.id }, { type: { in: ['team', 'public'] }, members: { some: { user_id: user.id, status: 'active' } } }],
  }) };
  const projects: Array<{ id: string; owner_user_id: string | null }> = [];
  let after = '';
  for (;;) {
    const page = await db.project.findMany({ where: { AND: [projectWhere, { id: { gt: after } }] },
      select: { id: true, owner_user_id: true }, orderBy: { id: 'asc' }, take: 500 });
    projects.push(...page);
    if (page.length < 500) break;
    after = page[page.length - 1].id;
  }
  const projectIds = projects.map(project => project.id);
  const visibleProject = (column: Prisma.Sql) => Prisma.sql`(${column} IS NULL OR EXISTS (SELECT 1 FROM "Project" vp
    WHERE vp."id" = ${column} AND vp."status" <> 'deleted' AND ${user.role === 'admin' ? Prisma.sql`1 = 1`
      : Prisma.sql`(vp."owner_user_id" = ${user.id} OR vp."type" IN ('team', 'public') AND EXISTS
        (SELECT 1 FROM "ProjectMember" pm WHERE pm."project_id" = vp."id" AND pm."user_id" = ${user.id} AND pm."status" = 'active'))`}))`;
  const requestedProjectId = scope.kind === 'project' ? scope.projectId : query.project_id;
  if (requestedProjectId && requestedProjectId !== 'unassigned' && !projectIds.includes(requestedProjectId)) throw new AuthError('项目不存在或已不可访问', 403);
  // A self selector is a report filter, not permission. Keep the owner's
  // readable directory available; the report applies the selected project.
  const projectId = scope.kind === 'project' ? scope.projectId : null;
  if (scope.kind === 'project' && scope.memberOwnerId) {
    const project = projects.find(item => item.id === scope.projectId)!;
    const member = project.owner_user_id === scope.memberOwnerId || await db.projectMember.findFirst({
      where: { project_id: scope.projectId, user_id: scope.memberOwnerId, status: 'active' }, select: { id: true },
    });
    if (!member) throw new AuthError('成员不在当前项目可选范围', 400);
  }
  const table = await db.$queryRaw<Array<{ name: string }>>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'UsageAttribution'`;
  const hasAttribution = table.length > 0;
  const attributed = (kind: UsageSourceKind, id: Prisma.Sql, field: 'owner_user_id' | 'project_id', fallback: Prisma.Sql) => {
    const column = field === 'owner_user_id' ? Prisma.sql`ua."owner_user_id"` : Prisma.sql`ua."project_id"`;
    return hasAttribution ? Prisma.sql`CASE WHEN EXISTS (SELECT 1 FROM "UsageAttribution" ua WHERE ua."source_kind" = ${kind} AND ua."source_id" = ${id})
      THEN (SELECT ${column} FROM "UsageAttribution" ua WHERE ua."source_kind" = ${kind} AND ua."source_id" = ${id} AND ua."context_version" = 1)
      ELSE ${fallback} END` : fallback;
  };
  const wantedOwner = scope.kind === 'self' ? user.id : scope.memberOwnerId || null;
  const common = (kind: UsageSourceKind, id: Prisma.Sql, owner: Prisma.Sql, project: Prisma.Sql) => {
    const frozenOwner = attributed(kind, id, 'owner_user_id', owner);
    const frozenProject = attributed(kind, id, 'project_id', project);
    return Prisma.sql`(${wantedOwner ? Prisma.sql`${frozenOwner} = ${wantedOwner}` : Prisma.sql`1 = 1`})
      AND (${projectId ? projectId === 'unassigned' ? Prisma.sql`${frozenProject} IS NULL` : Prisma.sql`${frozenProject} = ${projectId}` : Prisma.sql`1 = 1`})`;
  };
  const keyword = (id: Prisma.Sql, model: Prisma.Sql, content: Prisma.Sql) => query.keyword
    ? Prisma.sql`(instr(lower(COALESCE(${content}, '')), lower(${query.keyword})) > 0 OR instr(lower(${id}), lower(${query.keyword})) > 0
      OR instr(lower(COALESCE(${model}, '')), lower(${query.keyword})) > 0)` : Prisma.sql`1 = 1`;
  const conditions: Record<UsageSourceKind, Prisma.Sql> = {
    video_task: Prisma.sql`${common('video_task', Prisma.sql`"VideoTask"."id"`, Prisma.sql`COALESCE(NULLIF("owner_user_id", ''), "user_id")`, Prisma.sql`"project_id"`)}
      AND ${visibleProject(Prisma.sql`"VideoTask"."project_id"`)} AND "retention_status" IN ('active', 'retained')
      AND ${scope.kind === 'self' ? Prisma.sql`COALESCE(NULLIF("owner_user_id", ''), "user_id") = ${user.id}` : Prisma.sql`1 = 1`}
      AND ${keyword(Prisma.sql`"VideoTask"."id"`, Prisma.sql`"model"`, Prisma.sql`CASE
        WHEN instr(COALESCE("VideoTask"."source_metadata_json", ''), '"protected_module"') > 0
        THEN ${MULTIVIEW_PUBLIC_TASK_TITLE} ELSE "VideoTask"."prompt" END`)}`,
    image_task: Prisma.sql`${common('image_task', Prisma.sql`"ImageStudioTask"."id"`, Prisma.sql`"owner_id"`, Prisma.sql`(SELECT json_extract(CASE WHEN json_valid(f."snapshot_json") THEN f."snapshot_json" ELSE '{}' END, '$.project_id') FROM "ToolFlowRun" f WHERE f."id" = "tool_flow_run_id" AND json_extract(CASE WHEN json_valid(f."snapshot_json") THEN f."snapshot_json" ELSE '{}' END, '$.schema') = 'toolflow.v1')`)}
      AND ${scope.kind === 'project' && user.role === 'admin' ? Prisma.sql`1 = 1` : Prisma.sql`"owner_id" = ${user.id}`}
      AND ${keyword(Prisma.sql`"ImageStudioTask"."id"`, Prisma.sql`"model"`, Prisma.sql`"prompt"`)}`,
    video_studio_run: Prisma.sql`${common('video_studio_run', Prisma.sql`"VideoStudioRun"."id"`, Prisma.sql`"owner_user_id"`, Prisma.sql`NULL`)}
      AND "owner_user_id" = ${user.id} AND ${keyword(Prisma.sql`"VideoStudioRun"."id"`, Prisma.sql`"model"`, Prisma.sql`"prompt"`)}`,
    role_run: FALSE,
    role_attempt: FALSE,
    toolflow_run: Prisma.sql`${common('toolflow_run', Prisma.sql`"ToolFlowRun"."id"`, Prisma.sql`"owner_id"`, Prisma.sql`json_extract(CASE WHEN json_valid("snapshot_json") THEN "snapshot_json" ELSE '{}' END, '$.project_id')`)}
      AND "owner_id" = ${user.id} AND ${keyword(Prisma.sql`"ToolFlowRun"."id"`, Prisma.sql`NULL`, Prisma.sql`"snapshot_json"`)}`,
    agent_text_step: FALSE,
    cutout_receipt: FALSE,
  };
  if (!isExternalUser(user)) {
    const documentGate = Prisma.sql`EXISTS (SELECT 1 FROM "CanvasDocument" d WHERE d."id" = r."document_id" AND d."owner_user_id" = ${user.id}
      AND d."status" <> 'deleted' AND ${visibleProject(Prisma.sql`d."project_id"`)})`;
    conditions.role_run = Prisma.sql`${common('role_run', Prisma.sql`r."id"`, Prisma.sql`r."owner_user_id"`, Prisma.sql`NULL`)} AND r."owner_user_id" = ${user.id} AND ${documentGate}
      AND ${keyword(Prisma.sql`r."id"`, Prisma.sql`NULL`, Prisma.sql`NULL`)}`;
    conditions.role_attempt = Prisma.sql`${common('role_attempt', Prisma.sql`a."id"`, Prisma.sql`r."owner_user_id"`, Prisma.sql`NULL`)} AND r."owner_user_id" = ${user.id} AND ${documentGate}
      AND ${keyword(Prisma.sql`a."id"`, Prisma.sql`NULL`, Prisma.sql`(SELECT sw."snapshot_json" FROM "CanvasRoleWork" sw WHERE sw."id" = a."work_id")`)}`;
  }
  return { conditions, projectNames: new Map(projects.map(project => [project.id, ''])), scoped: true };
}
