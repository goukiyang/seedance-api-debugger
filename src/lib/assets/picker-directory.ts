import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { StudioSharingError } from '@/lib/image-studio/shared-contract';
import { readCatalogRevision } from '@/lib/image-studio/catalog-revision';
import { CatalogSqlCompatibilityError } from './catalog-visibility-sql';
import { directoryPermissionsSql, jsonField, sqlRemoved } from './directory-permissions-sql';
import { originDirectorySql } from './origin-directory-sql';
import { templateFilterId, type PickerAlbum, type PickerTemplate } from './picker-types';
import { catalogIdsSql, catalogKeyBatches } from './catalog-batches';
import { usageRowSpool } from '@/lib/usage/row-spool';

export type PickerDirectorySelection = { keys: string[]; directAssetIds: string[]; referenceIds: string[]; total: number; page: number; hasMore: boolean; nextCursor: string | null;
  revision: string; marker: string; albums: PickerAlbum[]; templates: PickerTemplate[]; user: SessionUser };

type NameRow = { identity: string; reference_id: string | null; name: string };
type NameBatch = { keys: string[]; marker: string; access: Awaited<ReturnType<typeof directoryPermissionsSql>> };
export function readPickerDirectory(db: Prisma.TransactionClient, session: SessionUser, p: URLSearchParams, keys: string[] | null): Promise<PickerDirectorySelection>;
export function readPickerDirectory(db: Prisma.TransactionClient, session: SessionUser, p: URLSearchParams, keys: string[] | null, batch: NameBatch): Promise<NameRow[]>;
export async function readPickerDirectory(db: Prisma.TransactionClient, session: SessionUser, p: URLSearchParams, keys: string[] | null, batch?: NameBatch): Promise<PickerDirectorySelection | NameRow[]> {
  const before = batch?.marker || await readCatalogRevision(db, 'assets');
  if (!before) throw new CatalogSqlCompatibilityError('目录writer尚未就绪');
  const access = batch?.access || await directoryPermissionsSql(db, session), user = access.user;
  const batchAssetIds = batch?.keys.filter(key => key.startsWith('asset:')).map(key => key.slice(6)) || [];
  const batchReferenceIds = batch?.keys.filter(key => key.startsWith('reference_image:')).map(key => key.slice('reference_image:'.length)) || [];
  const batchVideoIds = batch?.keys.filter(key => key.startsWith('video_task:')).map(key => key.slice('video_task:'.length)) || [];
  const scope = ['mine', 'project', 'shared', 'public'].includes(p.get('scope') || '') ? p.get('scope')! : 'mine';
  const imageStudio = p.get('target') === 'image-studio', album = p.get('album'), project = p.get('project'), keyword = (p.get('q') || '').trim().slice(0, 160);
  const types = imageStudio ? ['image'] : (p.get('types') || 'image,video,audio').split(',').filter(type => ['image', 'video', 'audio'].includes(type));
  const typeCondition = (column: Prisma.Sql) => types.length ? Prisma.sql`${column} IN (${Prisma.join(types)})` : Prisma.sql`0 = 1`;
  const referenceVisible = Prisma.sql`${access.visibility.visible(Prisma.sql`r."url"`)} AND (a."id" IS NULL OR ${access.visibility.visible(Prisma.sql`a."original_url"`)})`;
  const revisionQuery = new URLSearchParams(p); for (const field of ['page', 'after', 'directory_revision']) revisionQuery.delete(field);
  const revision = createHash('sha256').update(JSON.stringify([before, user.id, user.role, user.account_type, revisionQuery.toString()])).digest('hex');
  if (p.get('directory_revision') && p.get('directory_revision') !== revision) throw new StudioSharingError('素材目录已变化，请重新读取', 409);
  const ownFiles = scope === 'mine' && !album && !project;
  const template = templateFilterId(p.get('template'));
  const ctes = Prisma.sql`${access.ctes}, ${originDirectorySql(user, batch ? batchAssetIds : undefined)},
    usable_albums AS MATERIALIZED (SELECT * FROM authorized_albums WHERE can_view = 1 AND can_use = 1 AND picker_candidate = 1),
    permitted_albums AS MATERIALIZED (SELECT * FROM usable_albums WHERE ${Prisma.raw('scope_' + scope)} = 1
      AND (${album ? Prisma.sql`"id" = ${album}` : Prisma.sql`1 = 1`}) AND (${project ? Prisma.sql`"project_id" = ${project}` : Prisma.sql`1 = 1`})),
    allowed_references AS MATERIALIZED (
      SELECT r."id" AS reference_id, r."asset_id", r."owner_user_id", r."album_id", r."source_type", r."created_at", r.rowid AS natural,
        a."file_name", a."type", a."metadata_json", albums."name" AS album_name
      FROM "ReferenceImage" r JOIN usable_albums albums ON albums."id" = r."album_id" LEFT JOIN "Asset" a ON a."id" = r."asset_id"
      WHERE r."status" = 'active' AND ${referenceVisible}
        AND (${batch ? Prisma.sql`${catalogIdsSql(Prisma.sql`r."asset_id"`, batchAssetIds)} OR r."asset_id" IS NULL AND ${catalogIdsSql(Prisma.sql`r."id"`, batchReferenceIds)}` : Prisma.sql`1 = 1`})
        AND (EXISTS (SELECT 1 FROM permitted_albums permitted WHERE permitted."id" = r."album_id")
          OR ${ownFiles ? Prisma.sql`r."owner_user_id" = ${user.id} AND r."asset_id" IS NULL` : Prisma.sql`0 = 1`})
        AND (a."id" IS NOT NULL AND a."status" = 'active' AND ${typeCondition(Prisma.sql`a."type"`)}
          OR r."asset_id" IS NULL AND ${types.includes('image') ? 1 : 0} = 1)
    ), candidates AS MATERIALIZED (
      SELECT 'asset:' || a."id" AS identity, a."id" AS asset_id, NULL AS reference_id, NULL AS video_id, a."file_name" AS name,
        a."created_at" AS created, CASE WHEN o.generated = 1 THEN 'generated' ELSE 'uploaded' END AS source,
        o.origin_kind, o.template_id, o.template_name, o.template_alias, 0 AS priority, 0 AS natural
      FROM "Asset" a JOIN asset_origins o ON o.asset_id = a."id" WHERE ${ownFiles ? 1 : 0} = 1
        AND (${batch ? catalogIdsSql(Prisma.sql`a."id"`, batchAssetIds) : Prisma.sql`1 = 1`})
        AND a."owner_id" = ${user.id} AND a."status" = 'active' AND ${typeCondition(Prisma.sql`a."type"`)} AND ${access.visibility.visible(Prisma.sql`a."original_url"`)}
      UNION ALL SELECT CASE WHEN r.asset_id IS NULL THEN 'reference_image:' || r.reference_id ELSE 'asset:' || r.asset_id END,
        r.asset_id, r.reference_id, NULL, COALESCE(r.file_name, '参考图-' || r.reference_id), r."created_at",
        CASE WHEN r."source_type" = 'generated' OR o.generated = 1 THEN 'generated' WHEN r."source_type" = 'upload' THEN 'uploaded' ELSE 'other' END,
        o.origin_kind, o.template_id, o.template_name, o.template_alias, 1, r.natural
      FROM allowed_references r LEFT JOIN asset_origins o ON o.asset_id = r.asset_id
      UNION ALL SELECT 'video_task:' || v."id", NULL, NULL, v."id", 'seedance-' || v."id" || '.mp4', v."created_at", 'generated', 'video-generated', NULL, NULL, NULL, 2, 0
      FROM "VideoTask" v WHERE ${!imageStudio && types.includes('video') && ownFiles ? 1 : 0} = 1
        AND (${batch ? catalogIdsSql(Prisma.sql`v."id"`, batchVideoIds) : Prisma.sql`1 = 1`})
        AND v."local_status" = 'succeeded' AND v."retention_status" IN ('active', 'retained')
        AND (v."owner_user_id" = ${user.id} OR v."owner_user_id" IS NULL AND v."user_id" = ${user.id})
        AND (v."source_metadata_json" IS NULL OR instr(v."source_metadata_json", '"protected_module"') = 0)
        AND (${user.role === 'admin' ? Prisma.sql`1 = 1` : Prisma.sql`v."project_id" IS NULL OR ${access.projectView(Prisma.sql`v."project_id"`)}`})
        AND (${keyword ? Prisma.sql`instr(lower(v."id"), lower(${keyword})) > 0 OR instr(lower(v."prompt"), lower(${keyword})) > 0` : Prisma.sql`1 = 1`})
    ), unremoved AS MATERIALIZED (SELECT * FROM candidates c WHERE ${scope === 'mine' ? Prisma.sql`NOT CASE WHEN c.asset_id IS NOT NULL THEN ${sqlRemoved(user.id, 'asset', Prisma.sql`c.asset_id`)}
      WHEN c.reference_id IS NOT NULL THEN ${sqlRemoved(user.id, 'reference_image', Prisma.sql`c.reference_id`)} ELSE ${sqlRemoved(user.id, 'video_task', Prisma.sql`c.video_id`)} END` : Prisma.sql`1 = 1`}),
    filtered AS MATERIALIZED (SELECT * FROM unremoved c WHERE (${batch ? catalogIdsSql(Prisma.sql`c.identity`, batch.keys) : Prisma.sql`1 = 1`}) AND
      (${keys ? keys.length ? Prisma.sql`c.identity IN (${Prisma.join(keys)}) OR 'reference_image:' || c.reference_id IN (${Prisma.join(keys)})` : Prisma.sql`0 = 1` : Prisma.sql`1 = 1`})
      AND (${p.get('source') && p.get('source') !== 'all' ? Prisma.sql`c.source = ${p.get('source')} OR c.origin_kind = ${p.get('source')}` : Prisma.sql`1 = 1`})
      AND (${template ? Prisma.sql`c.template_id = ${template} OR c.template_alias = ${template}` : Prisma.sql`1 = 1`})
      AND (${keyword ? Prisma.sql`c.video_id IS NOT NULL OR instr(lower(c.name), lower(${keyword})) > 0 OR instr(lower(COALESCE(c.template_name, '')), lower(${keyword})) > 0
        OR EXISTS (SELECT 1 FROM allowed_references r WHERE (r.asset_id = c.asset_id OR r.reference_id = c.reference_id) AND instr(lower(r.album_name), lower(${keyword})) > 0)` : Prisma.sql`1 = 1`})
      AND (${p.get('view') === 'favorites' ? Prisma.sql`EXISTS (SELECT 1 FROM "ContentReaction" favorite WHERE favorite."user_id" = ${user.id}
        AND (favorite."liked" = 1 OR favorite."favorited" = 1) AND favorite."content_key" IN (c.identity, 'reference_image:' || c.reference_id))` : Prisma.sql`1 = 1`})
    ), normalized AS MATERIALIZED (SELECT *, row_number() OVER (PARTITION BY identity ORDER BY priority, natural) AS duplicateRank FROM filtered),
    directory AS MATERIALIZED (SELECT * FROM normalized WHERE duplicateRank = 1)`;
  if (batch) return db.$queryRaw<NameRow[]>(Prisma.sql`WITH ${ctes} SELECT identity, reference_id, name FROM directory LIMIT 500`);
  const order = p.get('view') === 'recent' && keys ? Prisma.sql`COALESCE((SELECT CAST(key AS INTEGER) FROM json_each(${JSON.stringify(keys)}) h WHERE h.value = identity LIMIT 1), -1), created DESC, identity`
    : Prisma.sql`created DESC, identity`;
  const count = await db.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`WITH ${ctes} SELECT count(*) AS total FROM directory`);
  const total = Number(count[0].total), size = keys ? 80 : 24;
  const requested = Number(p.get('page')), page = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, Math.max(1, Math.ceil(total / size))) : 1;
  let start = (page - 1) * size;
  if (p.get('after') && p.get('sort') !== 'name') {
    const rows = await db.$queryRaw<Array<{ position: bigint }>>(Prisma.sql`WITH ${ctes}, positions AS
      (SELECT identity, row_number() OVER (ORDER BY ${order}) AS position FROM directory) SELECT position FROM positions WHERE identity = ${p.get('after')} LIMIT 1`);
    if (!rows.length) throw new StudioSharingError('素材目录已变化，请重新读取', 409);
    start = Number(rows[0].position);
  }
  let selected: Array<{ identity: string; reference_id: string | null }>;
  if (p.get('sort') === 'name') {
    const compare = (a: NameRow, b: NameRow) => (p.get('view') === 'recent' && keys ? keys.indexOf(a.identity) - keys.indexOf(b.identity) : 0)
      || a.name.localeCompare(b.name, 'zh-CN') || a.identity.localeCompare(b.identity);
    if (keys) {
      const rows = (await db.$queryRaw<NameRow[]>(Prisma.sql`WITH ${ctes} SELECT identity, reference_id, name FROM directory LIMIT 80`)).sort(compare);
      if (p.get('after')) { const index = rows.findIndex(row => row.identity === p.get('after')); if (index < 0) throw new StudioSharingError('素材目录已变化，请重新读取', 409); start = index + 1; }
      selected = rows.slice(start, start + size);
    }
    else {
      const spool = await usageRowSpool<NameRow>(compare);
      try {
        for await (const keys of catalogKeyBatches(db, 'picker', user.id)) await spool.add(await readPickerDirectory(db, session, p, null, { keys, marker: before, access }));
        const rows = await spool.finish(); selected = [];
        if (p.get('after')) {
          let found = false, position = 0;
          for await (const row of rows.values()) {
            if (!found) { if (row.identity === p.get('after')) { found = true; start = position + 1; } position++; continue; }
            selected.push({ identity: row.identity, reference_id: row.reference_id }); if (selected.length >= size) break;
          }
          if (!found) throw new StudioSharingError('素材目录已变化，请重新读取', 409);
        } else for await (const row of rows.values(start, size)) selected.push({ identity: row.identity, reference_id: row.reference_id });
      } finally { await spool.dispose(); }
    }
  } else selected = await db.$queryRaw<Array<{ identity: string; reference_id: string | null }>>(Prisma.sql`WITH ${ctes}
    SELECT identity, reference_id FROM directory ORDER BY ${order} LIMIT ${size} OFFSET ${start}`);
  const albumRows = await db.$queryRaw<Array<{ id: string; name: string; project_id: string | null; project_name: string | null; project_owner: string | null; project_status: string | null;
    scope_mine: number; scope_project: number; scope_shared: number; scope_public: number; count: bigint }>>(Prisma.sql`WITH ${ctes}
    SELECT a."id", a."name", a."project_id", p."name" AS project_name, p."owner_user_id" AS project_owner, p."status" AS project_status,
      a.scope_mine, a.scope_project, a.scope_shared, a.scope_public,
      (SELECT count(*) FROM "ReferenceImage" r LEFT JOIN "Asset" asset ON asset."id" = r."asset_id" WHERE r."album_id" = a."id" AND r."status" = 'active'
        AND ${access.visibility.visible(Prisma.sql`r."url"`)} AND (asset."id" IS NULL OR ${access.visibility.visible(Prisma.sql`asset."original_url"`)})) AS count
      FROM usable_albums a LEFT JOIN "Project" p ON p."id" = a."project_id" ORDER BY a."updated_at" DESC, a."id"`);
  const albums: PickerAlbum[] = albumRows.flatMap(row => (['mine', 'project', 'shared', 'public'] as const).filter(scope => row[`scope_${scope}`]).map(scope => ({
    id: row.id, name: row.name, scope, count: Number(row.count), project: row.project_id ? { id: row.project_id, name: row.project_name!, owner_user_id: row.project_owner!, status: row.project_status! } : null,
  })));
  const templates = new Map<string, PickerTemplate>();
  const templateRows = await db.$queryRaw<Array<{ id: string; name: string; alias: string | null }>>(Prisma.sql`WITH ${ctes}
    SELECT DISTINCT template_id AS id, template_name AS name, template_alias AS alias FROM unremoved WHERE source = 'generated' AND template_id IS NOT NULL AND template_name IS NOT NULL`);
  for (const row of templateRows) {
    const previous = templates.get(row.id), aliases = Array.from(new Set([...(previous?.aliases || []), ...(row.alias ? [row.alias] : [])]));
    templates.set(row.id, { id: row.id, name: row.name, ...(aliases.length ? { aliases } : {}) });
  }
  if (before !== await readCatalogRevision(db, 'assets')) throw new StudioSharingError('素材目录已变化，请重新读取', 409);
  return { keys: selected.map(row => row.identity), directAssetIds: selected.filter(row => !row.reference_id && row.identity.startsWith('asset:')).map(row => row.identity.slice(6)),
    referenceIds: selected.flatMap(row => row.reference_id ? [row.reference_id] : []), total, page, hasMore: start + size < total,
    nextCursor: start + size < total ? selected.at(-1)?.identity || null : null, marker: before, revision, albums, templates: Array.from(templates.values()), user };
}
