import { Prisma } from '@prisma/client';
import { AuthError } from '@/lib/auth/session';
import type { SessionUser } from '@/lib/auth/session';
import { catalogVisibilitySql } from './catalog-visibility-sql';

export const validJson = (value: Prisma.Sql) => Prisma.sql`CASE WHEN json_valid(${value}) THEN ${value} ELSE '{}' END`;
export const jsonField = (value: Prisma.Sql, path: string) => Prisma.sql`json_extract(${validJson(value)}, ${path})`;
export const sqlRemoved = (owner: string, kind: 'asset' | 'reference_image' | 'video_task', id: Prisma.Sql) => Prisma.sql`EXISTS (
  SELECT 1 FROM "PlatformSetting" removal WHERE removal."key" = ${kind === 'asset' ? `asset-library-removal:v1:${owner}:` : `resource-library-removal:v1:${owner}:${kind}:`} || ${id}
    AND json_type(${validJson(Prisma.sql`removal."value_json"`)}, '$.removed') = 'true')`;

/** These expressions mirror getProjectAccess/getAlbumAccess, not cached grant flags. */
export async function directoryPermissionsSql(db: Prisma.TransactionClient, session: SessionUser) {
  const user = await db.user.findUnique({ where: { id: session.id } });
  if (!user || user.status !== 'active' || user.expires_at && user.expires_at.getTime() <= Date.now()
    || !['admin', 'user'].includes(user.role) || !['internal', 'external'].includes(user.account_type)) throw new AuthError('账号当前不可用', 403);
  const current: SessionUser = { ...session, ...user, role: user.role as SessionUser['role'], account_type: user.account_type as SessionUser['account_type'], status: 'active' };
  const visibility = await catalogVisibilitySql(db, current);
  const projectView = (projectId: Prisma.Sql) => Prisma.sql`EXISTS (SELECT 1 FROM "Project" project_access WHERE project_access."id" = ${projectId}
    AND project_access."status" <> 'deleted' AND (${user.role === 'admin' ? Prisma.sql`1 = 1` : Prisma.sql`project_access."owner_user_id" = ${user.id}
      OR project_access."type" IN ('team', 'public') AND EXISTS (SELECT 1 FROM "ProjectMember" member_access
        WHERE member_access."project_id" = project_access."id" AND member_access."user_id" = ${user.id} AND member_access."status" = 'active')`}))`;
  const projectGenerate = (projectId: Prisma.Sql) => Prisma.sql`EXISTS (SELECT 1 FROM "Project" project_use WHERE project_use."id" = ${projectId}
    AND project_use."status" = 'active' AND project_use."type" <> 'system' AND (${user.role === 'admin' ? Prisma.sql`1 = 1` : Prisma.sql`project_use."owner_user_id" = ${user.id}
      OR project_use."type" IN ('team', 'public') AND EXISTS (SELECT 1 FROM "ProjectMember" member_use WHERE member_use."project_id" = project_use."id"
        AND member_use."user_id" = ${user.id} AND member_use."status" = 'active' AND member_use."role" <> 'viewer')`}))`;
  const flag = (name: 'view' | 'use' | 'download') => {
    const value = Prisma.sql`s."permissions_json"`, type = Prisma.sql`json_type(${validJson(value)}, ${'$.' + name})`, field = jsonField(value, '$.' + name);
    return Prisma.sql`CASE WHEN ${type} IS NULL THEN ${name === 'download' ? 0 : 1}
      WHEN ${type} IN ('false', 'null') OR ${type} IN ('integer', 'real') AND ${field} = 0 OR ${type} = 'text' AND ${field} = '' THEN 0 ELSE 1 END`;
  };
  const publicAlbum = Prisma.sql`a."visibility" = 'public' OR a."album_type" IN ('public', 'system')`;
  const projectScoped = Prisma.sql`a."project_id" IS NOT NULL AND (a."album_type" = 'project' OR a."visibility" = 'project')`;
  const owner = Prisma.sql`a."owner_user_id" = ${user.id}`;
  const shares = Prisma.sql`s."status" = 'active' AND (s."expires_at" IS NULL OR s."expires_at" > ${new Date()})
    AND (s."grantee_type" = 'user' AND s."grantee_id" = ${user.id} OR s."grantee_type" = 'project' AND ${projectView(Prisma.sql`s."grantee_id"`)})`;
  const sharePermission = (name: 'view' | 'use' | 'download') => Prisma.sql`EXISTS (SELECT 1 FROM "AlbumShare" s WHERE s."album_id" = a."id" AND ${shares} AND ${flag(name)} = 1)`;
  const common = (name: 'view' | 'use' | 'download') => Prisma.sql`(
    (NOT (${projectScoped}) AND (${user.role === 'admin' ? Prisma.sql`1 = 1` : owner}))
    OR (${projectScoped} AND ${name === 'view' ? Prisma.sql`(${projectView(Prisma.sql`a."project_id"`)} OR ${owner} OR ${user.role === 'admin' ? 1 : 0} = 1)`
      : name === 'use' ? projectGenerate(Prisma.sql`a."project_id"`) : Prisma.sql`0 = 1`})
    OR ${sharePermission(name)} ${name !== 'download' ? Prisma.sql`OR (${publicAlbum})` : Prisma.empty})`;
  const candidate = Prisma.sql`${owner} OR ${projectView(Prisma.sql`a."project_id"`)} OR (${publicAlbum})
    OR EXISTS (SELECT 1 FROM "AlbumShare" s WHERE s."album_id" = a."id" AND ${shares})`;
  const ctes = Prisma.sql`${visibility.ctes}, authorized_albums AS MATERIALIZED (
    SELECT a.*, (${common('view')}) AS can_view,
      (${common('use')} AND (NOT (${projectScoped}) OR EXISTS (SELECT 1 FROM "Project" project_state WHERE project_state."id" = a."project_id" AND project_state."status" = 'active'))) AS can_use,
      (${common('download')}) AS can_download,
      (${owner} AND a."album_type" = 'personal') AS scope_mine,
      (${projectView(Prisma.sql`a."project_id"`)} AND a."album_type" = 'project') AS scope_project,
      EXISTS (SELECT 1 FROM "AlbumShare" s WHERE s."album_id" = a."id" AND ${shares}) AS scope_shared,
      (${publicAlbum}) AS scope_public,
      (${candidate}) AS picker_candidate
    FROM "ReferenceAlbum" a WHERE a."status" = 'active'
  )`;
  return { user: current, visibility, ctes, projectView, projectGenerate };
}
