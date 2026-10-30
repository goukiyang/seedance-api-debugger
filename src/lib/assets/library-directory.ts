import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { StudioSharingError } from '@/lib/image-studio/shared-contract';
import { readCatalogRevision } from '@/lib/image-studio/catalog-revision';
import { currentMultiviewActor } from '@/lib/video/multiview-works';
import { CatalogSqlCompatibilityError } from './catalog-visibility-sql';
import { directoryPermissionsSql, jsonField, sqlRemoved, validJson } from './directory-permissions-sql';
import { displayUserName } from '@/lib/users/display';
import { catalogIdsSql, catalogKeyBatches } from './catalog-batches';
import { usageRowSpool } from '@/lib/usage/row-spool';

export type LibraryDirectoryQuery = { type: string; scope: string; status: string; sort: string; enhance: string; projectId: string | null;
  ownerUserId: string | null; keyword: string | null; page: number; limit: number; includeUploads: boolean; includeGenerated: boolean;
  multiviewOutputsOnly: boolean; collapseMultiview: boolean; expectedRevision?: string | null };
export type LibraryDirectoryPage = { keys: string[]; total: number; page: number; revision: string; marker: string; receiptKeys: string[]; childAssetIds: string[]; user: SessionUser };

type NameRow = { identity: string; receipt_key: string | null; sortName: string; created: number };
type NameBatch = { keys: string[]; marker: string; access: Awaited<ReturnType<typeof directoryPermissionsSql>>; collapse: boolean };
export function readLibraryDirectory(db: Prisma.TransactionClient, session: SessionUser, q: LibraryDirectoryQuery): Promise<LibraryDirectoryPage>;
export function readLibraryDirectory(db: Prisma.TransactionClient, session: SessionUser, q: LibraryDirectoryQuery, batch: NameBatch): Promise<NameRow[]>;
export async function readLibraryDirectory(db: Prisma.TransactionClient, session: SessionUser, q: LibraryDirectoryQuery, batch?: NameBatch): Promise<LibraryDirectoryPage | NameRow[]> {
  const marker = batch?.marker || await readCatalogRevision(db, 'assets'); if (!marker) throw new CatalogSqlCompatibilityError('目录writer尚未就绪');
  const access = batch?.access || await directoryPermissionsSql(db, session), user = access.user;
  const batchIds = (prefix: string) => batch?.keys.filter(key => key.startsWith(prefix + ':')).map(key => key.slice(prefix.length + 1)) || [];
  if (q.scope === 'user' && user.role !== 'admin') throw new AuthError('权限不足', 403);
  if (!batch && q.projectId && user.role !== 'admin' && !await db.project.findFirst({ where: { id: q.projectId, status: { not: 'deleted' }, OR: [
    { owner_user_id: user.id }, { type: { in: ['team', 'public'] }, members: { some: { user_id: user.id, status: 'active' } } },
  ] }, select: { id: true } })) throw new AuthError('项目不存在或无权查看', 403);
  const revision = createHash('sha256').update(JSON.stringify([marker, user.id, user.role, user.account_type,
    { ...q, page: undefined, limit: undefined, expectedRevision: undefined }])).digest('hex');
  if (!batch && q.expectedRevision && revision !== q.expectedRevision) throw new StudioSharingError('素材目录已变化，请刷新后继续翻页；当前内容保留', 409);
  const owned = (alias: string) => Prisma.sql`(${Prisma.raw(alias + '."owner_user_id"')} = ${user.id} OR ${Prisma.raw(alias + '."owner_user_id"')} IS NULL AND ${Prisma.raw(alias + '."user_id"')} = ${user.id})`;
  const taskRead = (alias: string) => user.role === 'admin' ? Prisma.sql`1 = 1` : Prisma.sql`(
    ${access.projectView(Prisma.raw(alias + '."project_id"'))} OR ${Prisma.raw(alias + '."project_id"')} IS NULL AND
      (${Prisma.raw(alias + '."owner_user_id"')} = ${user.id} OR ${Prisma.raw(alias + '."user_id"')} = ${user.id}))`;
  const libraryRemovals = q.scope === 'history' && !q.projectId && q.status !== 'hidden';
  const activeMedia = ['all', 'succeeded', 'hidden'].includes(q.status);
  const assetFlag = jsonField(Prisma.sql`a."metadata_json"`, '$.multiviewOutput.schema');
  let collapse = q.collapseMultiview && user.account_type === 'internal' && q.enhance === 'none' && ['all', 'image'].includes(q.type)
    && ['all', 'succeeded'].includes(q.status) && (q.includeGenerated || q.multiviewOutputsOnly) && (!q.ownerUserId || q.ownerUserId === user.id);
  if (batch) collapse = batch.collapse;
  else if (collapse) try { await currentMultiviewActor(user, db); } catch (error) { if (!(error instanceof AuthError)) throw error; collapse = false; }
  const outputs = Prisma.sql`json_extract(receipt, '$.outputs')`;
  const ctes = Prisma.sql`${access.ctes},
    group_works AS MATERIALIZED (SELECT w.* FROM "MultiviewWork" w WHERE ${collapse ? 1 : 0} = 1 AND w."owner_id" = ${user.id} AND w."save_state" <> 'intent'
      AND (w."source_id" IS NOT NULL AND EXISTS (SELECT 1 FROM "MultiviewSource" s WHERE s."id" = w."source_id" AND s."owner_id" = ${user.id} AND s."origin_task_id" = w."source_task_id")
        OR w."source_id" IS NULL AND EXISTS (SELECT 1 FROM "VideoTask" source WHERE source."id" = w."source_task_id"
          AND COALESCE(NULLIF(source."retention_status", ''), 'active') IN ('active', 'retained') AND ${taskRead('source')}))),
    group_receipts AS MATERIALIZED (SELECT w."id" AS work_id, p."key" AS receipt_key, p.rowid AS natural, ${validJson(Prisma.sql`p."value_json"`)} AS receipt
      FROM group_works w JOIN "PlatformSetting" p ON substr(p."key", 1, length('multiview_output_registration_v1:receipt:' || w."id" || ':')) = 'multiview_output_registration_v1:receipt:' || w."id" || ':'),
    valid_group_receipts AS MATERIALIZED (SELECT *,
      NOT EXISTS (SELECT 1 FROM json_each(${outputs}) output WHERE json_extract(output.value, '$.state') <> 'registered') AS complete,
      json_extract(receipt, '$.readyRevision') AS revision
      FROM group_receipts WHERE json_extract(receipt, '$.schema') = 1 AND json_extract(receipt, '$.state') = 'registered'
        AND json_extract(receipt, '$.ownerId') = ${user.id} AND json_extract(receipt, '$.workId') = work_id
        AND json_type(receipt, '$.readyRevision') = 'integer' AND abs(json_extract(receipt, '$.readyRevision')) <= 9007199254740991
        AND json_type(receipt, '$.outputs') = 'array' AND json_array_length(${outputs}) IN (4, 5, 9)
        AND NOT EXISTS (SELECT 1 FROM json_each(${outputs}) output WHERE json_type(${validJson(Prisma.sql`output.value`)}, '$.assetId') IS NOT 'text'
          OR json_type(${validJson(Prisma.sql`output.value`)}, '$.state') IS NOT 'text' OR json_extract(output.value, '$.state') NOT IN ('registered', 'unavailable') OR json_type(${validJson(Prisma.sql`output.value`)}, '$.role') IS NOT 'text'
          OR json_extract(output.value, '$.role') <> 'collage' AND (substr(json_extract(output.value, '$.role'), 1, 6) <> 'frame-'
            OR length(json_extract(output.value, '$.role')) NOT BETWEEN 7 AND 86 OR substr(json_extract(output.value, '$.role'), 7) GLOB '*[^a-zA-Z0-9-]*'))
        AND (SELECT count(DISTINCT json_extract(output.value, '$.role')) FROM json_each(${outputs}) output) = json_array_length(${outputs})
        AND EXISTS (SELECT 1 FROM json_each(${outputs}) output WHERE json_extract(output.value, '$.role') = 'collage')),
    ranked_group_receipts AS MATERIALIZED (SELECT *, row_number() OVER (PARTITION BY work_id ORDER BY complete DESC, revision DESC, natural) AS rank FROM valid_group_receipts),
    dedicated_assets AS MATERIALIZED (SELECT DISTINCT a."id" FROM valid_group_receipts receipt, json_each(receipt.receipt, '$.outputs') output
      JOIN "Asset" a ON a."id" = json_extract(output.value, '$.assetId') AND a."owner_id" = ${user.id}
      WHERE ${jsonField(Prisma.sql`a."metadata_json"`, '$.source')} = 'multiview-output'),
    candidates AS MATERIALIZED (
      SELECT 'video_task:' || v."id" AS identity, v."created_at" AS created, COALESCE(v."completed_at", v."created_at") AS completed, COALESCE(v."duration", 0) AS duration, NULL AS receipt_key,
        v."project_id" AS sort_project, COALESCE(owner."id", legacy."id") AS sort_owner
      FROM "VideoTask" v LEFT JOIN "Project" p ON p."id" = v."project_id" LEFT JOIN "User" owner ON owner."id" = v."owner_user_id" LEFT JOIN "User" legacy ON legacy."id" = v."user_id"
      WHERE ${!q.multiviewOutputsOnly && ['all', 'video'].includes(q.type) ? 1 : 0} = 1 AND ${taskRead('v')}
        AND (${batch ? catalogIdsSql(Prisma.sql`v."id"`, batchIds('video_task')) : Prisma.sql`1 = 1`})
        AND (${q.projectId ? Prisma.sql`v."project_id" = ${q.projectId}` : Prisma.sql`1 = 1`})
        AND (${q.status === 'hidden' ? user.role === 'admin' ? Prisma.sql`v."retention_status" IN ('user_deleted', 'admin_hidden')` : Prisma.sql`0 = 1` : Prisma.sql`v."retention_status" IN ('active', 'retained')`})
        AND (v."source_metadata_json" IS NULL OR instr(v."source_metadata_json", '"protected_module"') = 0)
        AND (${q.status !== 'all' && q.status !== 'hidden' ? Prisma.sql`v."local_status" = ${q.status}` : Prisma.sql`1 = 1`})
        AND (${q.scope === 'user' && q.ownerUserId ? Prisma.sql`v."owner_user_id" = ${q.ownerUserId} OR v."user_id" = ${q.ownerUserId}` : Prisma.sql`1 = 1`})
        AND (${q.enhance === 'all' ? Prisma.sql`v."generation_mode" = 'enhance_video' OR v."provider" = 'volcengine_mediakit'
          OR v."local_status" = 'succeeded' AND v."duration" IS NOT NULL AND v."video_card_id" IS NOT NULL
            AND v."generation_mode" <> 'enhance_video' AND v."provider" <> 'volcengine_mediakit'
            AND (v."public_video_url" IS NOT NULL OR v."local_video_path" IS NOT NULL OR v."result_video_url" IS NOT NULL OR v."result_last_frame_url" IS NOT NULL)` : Prisma.sql`1 = 1`})
        AND (${libraryRemovals ? Prisma.sql`NOT (${owned('v')} AND ${sqlRemoved(user.id, 'video_task', Prisma.sql`v."id"`)})` : Prisma.sql`1 = 1`})
        AND (${q.keyword ? Prisma.sql`v."id" LIKE ${'%' + q.keyword + '%'} OR v."prompt" LIKE ${'%' + q.keyword + '%'} OR v."provider_task_id" LIKE ${'%' + q.keyword + '%'}
          OR v."source_label" LIKE ${'%' + q.keyword + '%'} OR p."name" LIKE ${'%' + q.keyword + '%'} OR owner."name" LIKE ${'%' + q.keyword + '%'} OR legacy."name" LIKE ${'%' + q.keyword + '%'}` : Prisma.sql`1 = 1`})
      UNION ALL SELECT 'asset:' || a."id", a."created_at", a."created_at", 0, NULL, NULL, a."owner_id" FROM "Asset" a
      WHERE ${q.enhance === 'none' && activeMedia && ['all', 'image', 'video', 'audio'].includes(q.type) && (q.includeUploads || q.includeGenerated || q.multiviewOutputsOnly) ? 1 : 0} = 1
        AND (${batch ? catalogIdsSql(Prisma.sql`a."id"`, batchIds('asset')) : Prisma.sql`1 = 1`})
        AND (${q.type === 'all' ? Prisma.sql`a."type" IN ('image', 'video', 'audio')` : Prisma.sql`a."type" = ${q.type}`})
        AND (${q.status === 'hidden' ? Prisma.sql`a."status" IN ('hidden', 'deleted')` : Prisma.sql`a."status" = 'active'`})
        AND (${user.role !== 'admin' ? Prisma.sql`a."owner_id" = ${user.id}` : q.scope === 'user' && q.ownerUserId ? Prisma.sql`a."owner_id" = ${q.ownerUserId}` : Prisma.sql`1 = 1`})
        AND ${access.visibility.visible(Prisma.sql`a."original_url"`)}
        AND (${q.keyword ? Prisma.sql`a."file_name" LIKE ${'%' + q.keyword + '%'}` : Prisma.sql`1 = 1`})
        AND (${q.multiviewOutputsOnly ? q.includeGenerated && !q.includeUploads ? Prisma.sql`${assetFlag} = 1` : Prisma.sql`instr(COALESCE(a."metadata_json", ''), '"multiviewOutput"') > 0`
          : q.includeGenerated && !q.includeUploads ? Prisma.sql`${assetFlag} = 1 OR a."id" IN (SELECT generated."asset_id" FROM "ImageStudioTask" generated WHERE generated."asset_id" IS NOT NULL AND generated."status" = 'succeeded')` : Prisma.sql`1 = 1`})
        AND (${libraryRemovals ? Prisma.sql`NOT (a."owner_id" = ${user.id} AND ${sqlRemoved(user.id, 'asset', Prisma.sql`a."id"`)})` : Prisma.sql`1 = 1`})
        AND NOT EXISTS (SELECT 1 FROM dedicated_assets dedicated WHERE dedicated."id" = a."id")
      UNION ALL SELECT 'reference_image:' || r."id", r."created_at", r."created_at", 0, NULL, r."project_id", r."owner_user_id" FROM "ReferenceImage" r
        JOIN "ReferenceAlbum" album ON album."id" = r."album_id" LEFT JOIN "Asset" a ON a."id" = r."asset_id"
      WHERE ${q.enhance === 'none' && activeMedia && ['all', 'reference'].includes(q.type) ? 1 : 0} = 1
        AND (${batch ? catalogIdsSql(Prisma.sql`r."id"`, batchIds('reference_image')) : Prisma.sql`1 = 1`})
        AND r."status" = ${q.status === 'hidden' ? 'deleted' : 'active'} AND ${access.visibility.visible(Prisma.sql`r."url"`)} AND (a."id" IS NULL OR ${access.visibility.visible(Prisma.sql`a."original_url"`)})
        AND (${q.projectId ? Prisma.sql`r."project_id" = ${q.projectId}` : Prisma.sql`1 = 1`})
        AND (${user.role === 'admin' ? q.scope === 'user' && q.ownerUserId ? Prisma.sql`r."owner_user_id" = ${q.ownerUserId}` : Prisma.sql`1 = 1`
          : Prisma.sql`r."owner_user_id" = ${user.id} OR ${access.projectView(Prisma.sql`r."project_id"`)} OR album."visibility" = 'public' OR album."album_type" IN ('public', 'system')`})
        AND (${q.multiviewOutputsOnly ? Prisma.sql`instr(COALESCE(a."metadata_json", ''), '"multiviewOutput"') > 0` : Prisma.sql`1 = 1`})
        AND (${q.keyword ? Prisma.sql`album."name" LIKE ${'%' + q.keyword + '%'}` : Prisma.sql`1 = 1`})
        AND (${libraryRemovals ? Prisma.sql`NOT (r."owner_user_id" = ${user.id} AND (r."asset_id" IS NULL AND ${sqlRemoved(user.id, 'reference_image', Prisma.sql`r."id"`)}
          OR a."owner_id" = ${user.id} AND ${sqlRemoved(user.id, 'asset', Prisma.sql`a."id"`)}))` : Prisma.sql`1 = 1`})
      UNION ALL SELECT 'multiview_work:' || w."id", w."created_at", w."created_at", 0, receipt.receipt_key, NULL, w."owner_id" FROM group_works w
        JOIN ranked_group_receipts receipt ON receipt.work_id = w."id" AND receipt.rank = 1 WHERE w."removed_at" IS NULL
          AND (${batch ? catalogIdsSql(Prisma.sql`w."id"`, batchIds('multiview_work')) : Prisma.sql`1 = 1`})
          AND (${q.projectId ? Prisma.sql`w."project_id" = ${q.projectId}` : Prisma.sql`1 = 1`}) AND (${q.keyword ? Prisma.sql`instr(w."title", ${q.keyword}) > 0` : Prisma.sql`1 = 1`})
    ), directory AS MATERIALIZED (SELECT * FROM candidates GROUP BY identity)`;
  if (batch) {
    const rows = await db.$queryRaw<Array<{ identity: string; receipt_key: string | null; created: bigint | number | string | Date;
      project_name: string | null; owner_id: string | null; user_id: string | null; name: string | null; username: string | null; email: string | null }>>(Prisma.sql`WITH ${ctes}
      SELECT d.identity, d.receipt_key, d.created, p."name" AS project_name, d.sort_owner AS owner_id, u."id" AS user_id, u."name", u."username", u."email"
      FROM directory d LEFT JOIN "Project" p ON p."id" = d.sort_project LEFT JOIN "User" u ON u."id" = d.sort_owner LIMIT 500`);
    return rows.map(row => ({ identity: row.identity, receipt_key: row.receipt_key,
      created: row.created instanceof Date ? row.created.getTime() : new Date(typeof row.created === 'bigint' ? Number(row.created) : row.created).getTime(),
      sortName: q.sort === 'project' ? row.project_name || '未归属项目' : row.identity.startsWith('multiview_work:') || !row.user_id && row.identity.startsWith('asset:')
        ? row.owner_id ? row.owner_id === 'default-user' ? '历史默认用户' : `用户 ${row.owner_id.trim().slice(0, 6)}` : '未知用户'
        : row.user_id ? displayUserName({ id: row.user_id, name: row.name, username: row.username, email: row.email }) : '未知用户' }));
  }
  const order = q.sort === 'created_asc' ? Prisma.sql`created ASC, identity` : q.sort === 'completed_desc' ? Prisma.sql`completed DESC, created DESC, identity`
    : q.sort === 'duration' ? Prisma.sql`duration DESC, created DESC, identity` : Prisma.sql`created DESC, identity`;
  const count = await db.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`WITH ${ctes} SELECT count(*) AS total FROM directory`), total = Number(count[0].total);
  const page = Math.min(q.page, Math.max(1, Math.ceil(total / q.limit)));
  let selected: Array<{ identity: string; receipt_key: string | null }>;
  if (['project', 'user'].includes(q.sort)) {
    const spool = await usageRowSpool<NameRow>((a, b) => a.sortName.localeCompare(b.sortName, 'zh-CN') || b.created - a.created || a.identity.localeCompare(b.identity));
    try {
      for await (const keys of catalogKeyBatches(db, 'library', user.id)) await spool.add(await readLibraryDirectory(db, session, q, { keys, marker, access, collapse }));
      const sorted = await spool.finish(); selected = [];
      for await (const row of sorted.values((page - 1) * q.limit, q.limit)) selected.push({ identity: row.identity, receipt_key: row.receipt_key });
    } finally { await spool.dispose(); }
  } else selected = await db.$queryRaw<Array<{ identity: string; receipt_key: string | null }>>(Prisma.sql`WITH ${ctes} SELECT identity, receipt_key FROM directory ORDER BY ${order}
    LIMIT ${q.limit} OFFSET ${(page - 1) * q.limit}`);
  const receiptKeys = selected.flatMap(row => row.receipt_key ? [row.receipt_key] : []);
  const children = receiptKeys.length ? await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT DISTINCT json_extract(output.value, '$.assetId') AS id
    FROM "PlatformSetting" p, json_each(${validJson(Prisma.sql`p."value_json"`)}, '$.outputs') output WHERE p."key" IN (${Prisma.join(receiptKeys)})`) : [];
  if (marker !== await readCatalogRevision(db, 'assets')) throw new StudioSharingError('素材目录已变化，请重新读取', 409);
  return { keys: selected.map(row => row.identity), total, page, revision, marker, receiptKeys, childAssetIds: children.map(row => row.id), user };
}
