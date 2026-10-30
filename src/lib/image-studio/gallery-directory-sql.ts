import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { IMAGE_STUDIO_MODELS } from './model-catalog';
import { MAX_REFERENCE_IMAGES } from './limits';
import type { ImageStudioIdentity } from './access';
import type { GalleryQuery } from './gallery-types';
import { catalogVisibilitySql, CatalogSqlCompatibilityError } from '@/lib/assets/catalog-visibility-sql';
import { sharedCommandFingerprint } from './shared-command-storage';
import { catalogIdsSql, catalogKeyBatches } from '@/lib/assets/catalog-batches';
import { usageRowSpool } from '@/lib/usage/row-spool';

const json = (value: Prisma.Sql) => Prisma.sql`CASE WHEN json_valid(${value}) THEN ${value} ELSE '{}' END`;
const field = (value: Prisma.Sql, path: string) => Prisma.sql`json_extract(${json(value)}, ${path})`;
const array = (value: Prisma.Sql) => Prisma.sql`CASE WHEN json_valid(${value}) AND json_type(${value}) = 'array' THEN ${value} ELSE '[]' END`;
const setting = (key: Prisma.Sql) => Prisma.sql`(SELECT "value_json" FROM "PlatformSetting" WHERE "key" = ${key})`;
const technical = (text: Prisma.Sql) => Prisma.sql`(lower(${text}) GLOB 'ou_*' OR lower(${text}) GLOB 'ou-*'
  OR lower(${text}) GLOB 'feishu_*' OR lower(${text}) GLOB 'open_*' OR lower(${text}) GLOB 'union_*' OR length(${text}) > 40)`;
const display = Prisma.sql`CASE WHEN trim(u."name") <> '' AND NOT ${technical(Prisma.sql`trim(u."name")`)} THEN trim(u."name")
  WHEN trim(u."username") <> '' AND NOT ${technical(Prisma.sql`trim(u."username")`)} THEN trim(u."username") ELSE '用户 ' || substr(u."id", 1, 6) END`;

export type GalleryDirectoryRow = { key: string; targetKind: 'module' | 'preset'; targetId: string };

/** Permission and normalization precede the count and page. No private body leaves SQLite here. */
export async function galleryDirectorySql(db: Prisma.TransactionClient, actor: ImageStudioIdentity, input: GalleryQuery, keys?: string[],
  prepared?: { visibility: Awaited<ReturnType<typeof catalogVisibilitySql>>; authorId: string | null }) {
  const visibility = prepared?.visibility || await catalogVisibilitySql(db, actor);
  if (!prepared) await assertCanonicalGalleryMetadata(db);
  const authorId = input.authorKey ? prepared?.authorId ?? await resolveAuthorId(db, input.authorKey) : null;
  const moduleIds = keys?.filter(key => key.startsWith('image_module:')).map(key => key.slice('image_module:'.length)) || [];
  const presetIds = keys?.filter(key => key.startsWith('image_template:')).map(key => key.slice('image_template:'.length)) || [];
  const ownerHash = sharedCommandFingerprint(actor.id), deletedPrefix = `studio_deleted_workspace_v1:${ownerHash}:`;
  const sourceDeletedPrefix = `studio_deleted_workspace_source_v1:${ownerHash}:`;
  const sourceVisible = Prisma.sql`(p."owner_id" = ${actor.id} OR p."scope" IN ('admin', 'creator') AND p."is_shared" = 1)
    AND NOT EXISTS (SELECT 1 FROM "PlatformSetting" a WHERE a."key" = 'studio_preset_archived_v1:' || p."id")`;
  const fixed = Prisma.sql`CASE WHEN reproduction IS NOT NULL THEN ${field(Prisma.sql`reproduction`, '$.templateFixedReferences')}
    ELSE COALESCE(${field(Prisma.sql`fixed_setting`, '$.references')}, '[]') END`;
  const policy = field(Prisma.sql`policy_setting`, '$.policy');
  const primary = Prisma.sql`CASE WHEN policy_setting IS NULL THEN refs ELSE COALESCE(json_extract(policy, '$.primaryIds'), '[]') END`;
  const validBinding = Prisma.sql`b."id" IS NOT NULL AND ${field(Prisma.sql`b."value_json"`, '$.ownerId')} = m."owner_id"
    AND ${field(Prisma.sql`b."value_json"`, '$.protocol')} = 'shared-live-v1'
    AND ${field(Prisma.sql`b."value_json"`, '$.mode')} IN ('publisher', 'live')
    AND ${field(Prisma.sql`b."value_json"`, '$.presetId')} = m."source_preset_id"
    AND (${field(Prisma.sql`b."value_json"`, '$.mode')} <> 'publisher' OR (
      ${field(Prisma.sql`publisher."value_json"`, '$.ownerId')} = m."owner_id"
      AND ${field(Prisma.sql`publisher."value_json"`, '$.presetId')} = m."source_preset_id"
      AND ${field(Prisma.sql`publisher."value_json"`, '$.moduleId')} = m."id"
      AND ${field(Prisma.sql`publisher."value_json"`, '$.protocol')} = 'shared-live-v1'))`;
  const publisherKnown = Prisma.sql`publisher."id" IS NULL OR (
    ${field(Prisma.sql`publisher."value_json"`, '$.ownerId')} = p."owner_id"
    AND ${field(Prisma.sql`publisher."value_json"`, '$.presetId')} = p."id"
    AND ${field(Prisma.sql`publisher."value_json"`, '$.protocol')} = 'shared-live-v1'
    AND EXISTS (SELECT 1 FROM "ImageStudioModule" pm JOIN "PlatformSetting" pb ON pb."key" = 'studio_shared_binding_v1:' || pm."id"
      WHERE pm."id" = ${field(Prisma.sql`publisher."value_json"`, '$.moduleId')} AND pm."owner_id" = p."owner_id" AND pm."source_preset_id" = p."id"
      AND ${field(Prisma.sql`pb."value_json"`, '$.ownerId')} = p."owner_id"
      AND ${field(Prisma.sql`pb."value_json"`, '$.protocol')} = 'shared-live-v1'
      AND ${field(Prisma.sql`pb."value_json"`, '$.mode')} = 'publisher'
      AND ${field(Prisma.sql`pb."value_json"`, '$.presetId')} = p."id"
      AND NOT EXISTS (SELECT 1 FROM "PlatformSetting" d WHERE d."key" GLOB 'studio_deleted_workspace_v1:*'
        AND ${field(Prisma.sql`d."value_json"`, '$.ownerId')} = p."owner_id" AND ${field(Prisma.sql`d."value_json"`, '$.moduleId')} = pm."id")))`;
  const ctes = Prisma.sql`${visibility.ctes},
    source_settings AS MATERIALIZED (
      SELECT p.*, (${sourceVisible}) AS visible,
        ${setting(Prisma.sql`'studio_fixed_references_v1:preset:' || p."id"`)} AS fixed_setting,
        ${setting(Prisma.sql`'studio_reference_policy_v1:preset:' || p."owner_id" || ':' || p."id"`)} AS policy_setting,
        ${setting(Prisma.sql`'studio_style_preset_selection_v1:' || p."id"`)} AS style_setting,
        ${setting(Prisma.sql`'studio_skill_selection_v1:preset:' || p."id"`)} AS skill_setting,
        ${setting(Prisma.sql`'studio_shared_reproduction_v1:' || p."id"`)} AS reproduction,
        (${publisherKnown}) AS author_known
      FROM "ImageStudioPreset" p LEFT JOIN "PlatformSetting" publisher ON publisher."key" = 'studio_shared_publisher_v1:' || p."id"
      WHERE ${keys ? Prisma.sql`${catalogIdsSql(Prisma.sql`p."id"`, presetIds)} OR p."id" IN (SELECT wanted_module."source_preset_id" FROM "ImageStudioModule" wanted_module
        WHERE wanted_module."owner_id" = ${actor.id} AND ${catalogIdsSql(Prisma.sql`wanted_module."id"`, moduleIds)})` : Prisma.sql`1 = 1`}
    ), source_policy AS MATERIALIZED (
      SELECT *, ${array(Prisma.sql`"reference_ids"`)} AS refs, ${policy} AS policy, ${fixed} AS fixed_refs,
        COALESCE(${field(Prisma.sql`style_setting`, '$.ids')}, '[]') AS style_ids
      FROM source_settings
    ), source_refs AS MATERIALIZED (
      SELECT p."id" AS preset_id, r.value AS asset_id, 'ordinary' AS kind FROM source_policy p, json_each(p.refs) r
        WHERE NOT EXISTS (SELECT 1 FROM json_each(${primary}) main WHERE main.value = r.value)
      UNION ALL SELECT p."id", json_extract(r.value, '$.assetId'), 'fixed' FROM source_policy p, json_each(COALESCE(p.fixed_refs, '[]')) r
      UNION ALL SELECT p."id", json_extract(r.value, '$.assetId'), 'style' FROM source_policy p, json_each(p.style_ids) selected
        JOIN "PlatformSetting" sg ON sg."key" = 'studio_style_group_v1:' || selected.value,
        json_each(${json(Prisma.sql`sg."value_json"`)}, '$.references') r
      UNION ALL SELECT p."id", p."banner_asset_id", 'banner' FROM source_policy p WHERE p."banner_asset_id" IS NOT NULL
    ), source_state AS MATERIALIZED (
      SELECT p.*, (p.visible = 1 AND p."model" IN (${Prisma.join(IMAGE_STUDIO_MODELS)})
        AND (skill_setting IS NULL OR ${field(Prisma.sql`skill_setting`, '$.ownerId')} = p."owner_id"
          AND json_array_length(${field(Prisma.sql`skill_setting`, '$.ids')}) = 0)
        AND (fixed_setting IS NULL OR ${field(Prisma.sql`fixed_setting`, '$.ownerId')} = p."owner_id")
        AND (policy_setting IS NULL OR ${field(Prisma.sql`policy_setting`, '$.ownerId')} = p."owner_id")
        AND (style_setting IS NULL OR ${field(Prisma.sql`style_setting`, '$.ownerId')} = p."owner_id")
        AND NOT EXISTS (SELECT 1 FROM json_each(p.style_ids) selected LEFT JOIN "PlatformSetting" sg ON sg."key" = 'studio_style_group_v1:' || selected.value
          WHERE sg."id" IS NULL OR COALESCE(${field(Prisma.sql`sg."value_json"`, '$.deleted')}, 0) <> 0
            OR COALESCE(${field(Prisma.sql`sg."value_json"`, '$.disabled')}, 0) <> 0
            OR (${field(Prisma.sql`sg."value_json"`, '$.shared')} = 0 AND ${field(Prisma.sql`sg."value_json"`, '$.ownerId')} <> ${actor.id} AND ${actor.role === 'admin' ? 1 : 0} = 0))
        AND (SELECT count(*) FROM source_refs r WHERE r.preset_id = p."id" AND r.kind = 'style') <= COALESCE(json_extract(policy, '$.styleMax'), ${MAX_REFERENCE_IMAGES})
        AND (SELECT count(DISTINCT r.asset_id) FROM source_refs r WHERE r.preset_id = p."id" AND r.kind = 'ordinary')
          + CASE WHEN COALESCE(json_extract(policy, '$.useFixedReferences'), 1) = 1 THEN json_array_length(COALESCE(fixed_refs, '[]')) ELSE 0 END
          <= COALESCE(json_extract(policy, '$.referenceMax'), ${MAX_REFERENCE_IMAGES})
        AND (SELECT count(DISTINCT r.asset_id) FROM source_refs r WHERE r.preset_id = p."id" AND r.kind = 'ordinary')
          + CASE WHEN COALESCE(json_extract(policy, '$.useFixedReferences'), 1) = 1 THEN json_array_length(COALESCE(fixed_refs, '[]')) ELSE 0 END
          + (SELECT count(*) FROM source_refs r WHERE r.preset_id = p."id" AND r.kind = 'style') <= min(COALESCE(json_extract(policy, '$.auxiliaryMax'), ${MAX_REFERENCE_IMAGES}), ${MAX_REFERENCE_IMAGES})
        AND NOT EXISTS (SELECT 1 FROM source_refs r LEFT JOIN "Asset" a ON a."id" = r.asset_id
          WHERE r.preset_id = p."id" AND (a."id" IS NULL OR a."status" <> 'active' OR a."type" <> 'image'
            OR r.kind <> 'style' AND a."owner_id" <> p."owner_id" OR r.kind = 'ordinary' AND NOT (${visibility.visible(Prisma.sql`a."original_url"`)})))
      ) AS available FROM source_policy p
    ), module_bindings AS MATERIALIZED (
      SELECT m.*, CASE WHEN ${validBinding} THEN 1 ELSE 0 END AS binding_valid,
        b."id" IS NOT NULL AS binding_present, ${field(Prisma.sql`b."value_json"`, '$.mode')} AS binding_mode,
        row_number() OVER (ORDER BY m."created_at", m."id") AS natural
      FROM "ImageStudioModule" m LEFT JOIN "PlatformSetting" b ON b."key" = 'studio_shared_binding_v1:' || m."id"
        LEFT JOIN "PlatformSetting" publisher ON publisher."key" = 'studio_shared_publisher_v1:' || m."source_preset_id"
      WHERE m."owner_id" = ${actor.id} AND NOT EXISTS (SELECT 1 FROM "PlatformSetting" d WHERE d."key" = ${deletedPrefix} || m."id")
        AND (${keys ? Prisma.sql`${catalogIdsSql(Prisma.sql`m."id"`, moduleIds)} OR ${catalogIdsSql(Prisma.sql`m."source_preset_id"`, presetIds)}` : Prisma.sql`1 = 1`})
    ), module_entries AS MATERIALIZED (
      SELECT CASE WHEN m.binding_valid = 1 AND p."id" IS NOT NULL THEN 'image_template:' || p."id" ELSE 'image_module:' || m."id" END AS key,
        'module' AS targetKind, m."id" AS targetId,
        CASE WHEN m.binding_valid = 1 AND p.visible = 1 THEN p."name" ELSE m."name" END AS name,
        COALESCE(NULLIF(CASE WHEN m.binding_valid = 1 AND p.visible = 1 THEN p."group_name" ELSE m."group_name" END, ''), '未分组') AS groupName,
        CASE WHEN m.binding_valid = 1 AND p."id" IS NOT NULL THEN p."owner_id" = ${actor.id} ELSE 1 END AS mine,
        m.binding_valid = 1 AND p.visible = 1 AND p."is_shared" = 1 AS shared,
        NOT (m.binding_present = 1 AND m.binding_valid = 0) AND (m."source_preset_id" IS NULL OR p.visible = 1 AND p.available = 1) AS available,
        CASE WHEN m.binding_valid = 1 AND p."id" IS NOT NULL THEN CASE WHEN p.visible = 1 THEN p."created_at" ELSE NULL END ELSE m."created_at" END AS created,
        CASE WHEN m.binding_valid = 1 AND p."id" IS NOT NULL THEN CASE WHEN p.visible = 1 THEN p."updated_at" ELSE NULL END ELSE m."updated_at" END AS updated,
        CASE WHEN NOT (m.binding_present = 1 AND m.binding_valid = 0) AND (m."source_preset_id" IS NULL OR p.visible = 1)
          AND (m."source_preset_id" IS NULL OR p.author_known = 1) THEN COALESCE(p."owner_id", m."owner_id") ELSE NULL END AS authorId,
        m.natural AS natural, m.natural AS lastNatural,
        CASE WHEN m.binding_valid = 1 AND p."id" IS NOT NULL THEN p."id" ELSE NULL END AS presetId
      FROM module_bindings m LEFT JOIN source_state p ON p."id" = m."source_preset_id"
    ), modules_dedup AS MATERIALIZED (
      SELECT *, min(natural) OVER (PARTITION BY key) AS firstNatural, row_number() OVER (PARTITION BY key ORDER BY lastNatural DESC) AS duplicateRank FROM module_entries
    ), entries AS MATERIALIZED (
      SELECT key, targetKind, targetId, name, groupName, mine, shared, available, created, updated, authorId, firstNatural AS natural, presetId
        FROM modules_dedup WHERE duplicateRank = 1
      UNION ALL SELECT 'image_template:' || p."id", 'preset', p."id", p."name", COALESCE(NULLIF(p."group_name", ''), '未分组'),
        p."owner_id" = ${actor.id}, 1, 1, p."created_at", p."updated_at", CASE WHEN p.author_known = 1 THEN p."owner_id" ELSE NULL END,
        1000000000 + row_number() OVER (ORDER BY p."id"), p."id" FROM source_state p
      WHERE p."is_shared" = 1 AND p.available = 1 AND NOT EXISTS (SELECT 1 FROM modules_dedup m WHERE m.key = 'image_template:' || p."id")
        AND NOT EXISTS (SELECT 1 FROM "PlatformSetting" d WHERE d."key" GLOB ${sourceDeletedPrefix + '*'}
          AND ${field(Prisma.sql`d."value_json"`, '$.presetId')} = p."id" AND ${field(Prisma.sql`d."value_json"`, '$.reopenedModuleId')} IS NULL)
      UNION ALL SELECT ${'image_module:default-' + actor.id}, 'module', ${'default-' + actor.id}, '默认模块', '常用', 1, 0, 1, NULL, NULL, NULL, -1, NULL
        WHERE NOT EXISTS (SELECT 1 FROM "ImageStudioModule" m WHERE m."id" = ${'default-' + actor.id} AND m."owner_id" = ${actor.id})
          AND NOT EXISTS (SELECT 1 FROM "PlatformSetting" d WHERE d."key" = ${deletedPrefix + 'default-' + actor.id})
    ), decorated AS MATERIALIZED (
      SELECT e.*, CASE WHEN u."account_type" = 'internal' THEN e.authorId ELSE NULL END AS knownAuthor,
        CASE WHEN u."account_type" = 'internal' THEN ${display} ELSE '' END AS authorName,
        COALESCE(own."favorited", 0) AS favorited,
        CASE WHEN e.available = 1 THEN (SELECT count(*) FROM "ContentReaction" r WHERE r."content_key" = e.key AND r."liked" = 1) ELSE -1 END AS likes,
        COALESCE((SELECT min(CAST(g.key AS INTEGER)) FROM json_each(${JSON.stringify(input.directoryOrder?.groups || [])}) g WHERE g.value = e.groupName), 2147483647) AS groupRank,
        COALESCE((SELECT min(CAST(o.key AS INTEGER)) FROM json_each(${JSON.stringify(input.directoryOrder?.entries || [])}) o WHERE o.value IN (e.key, e.targetId,
          CASE WHEN e.presetId IS NOT NULL THEN 'preset:' || e.presetId ELSE 'module:' || e.targetId END)), 2147483647) AS itemRank,
        COALESCE((SELECT max(h.value) FROM json_each(${JSON.stringify(input.recentHints || {})}) h WHERE h.key IN (e.key,
          CASE WHEN e.presetId IS NOT NULL THEN 'preset:' || e.presetId ELSE 'module:' || e.targetId END)), 0) AS recent
      FROM entries e LEFT JOIN "User" u ON u."id" = e.authorId LEFT JOIN "ContentReaction" own ON own."content_key" = e.key AND own."user_id" = ${actor.id}
    ), filtered AS MATERIALIZED (SELECT * FROM decorated WHERE
      ${input.scope === 'mine' ? Prisma.sql`mine = 1` : input.scope === 'shared' ? Prisma.sql`shared = 1` : input.scope === 'favorites' ? Prisma.sql`favorited = 1` : Prisma.sql`1 = 1`}
      AND (${input.query?.trim() ? Prisma.sql`instr(lower(name), lower(${input.query.trim()})) > 0 OR instr(lower(groupName), lower(${input.query.trim()})) > 0 OR instr(lower(authorName), lower(${input.query.trim()})) > 0` : Prisma.sql`1 = 1`})
      AND (${input.authorKey ? Prisma.sql`knownAuthor = ${authorId}` : Prisma.sql`1 = 1`})
      AND (${keys ? catalogIdsSql(Prisma.sql`key`, keys) : Prisma.sql`1 = 1`})
    )`;
  const directoryOrder = Prisma.sql`groupRank, itemRank, natural`;
  const order = input.sort === 'updated' ? Prisma.sql`COALESCE(updated, 0) DESC, ${directoryOrder}`
    : input.sort === 'likes' ? Prisma.sql`likes DESC, COALESCE(created, 0) DESC`
      : input.sort === 'recent' ? Prisma.sql`recent DESC, ${directoryOrder}`
        : input.sort === 'directory' ? directoryOrder : Prisma.sql`COALESCE(created, 0) DESC, ${directoryOrder}`;
  return { ctes, order: Prisma.sql`${order}, key`, all: Prisma.sql`SELECT * FROM filtered`, rows: async (page: number, size: number): Promise<GalleryDirectoryRow[]> => {
    if (input.sort !== 'name') return db.$queryRaw<GalleryDirectoryRow[]>(Prisma.sql`WITH ${ctes} SELECT key, targetKind, targetId FROM filtered ORDER BY ${order}, key LIMIT ${size} OFFSET ${(page - 1) * size}`);
    const spool = await usageRowSpool<GalleryDirectoryRow & { name: string }>((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.key.localeCompare(b.key));
    try {
      for await (const batch of catalogKeyBatches(db, 'templates', actor.id)) {
        const query = await galleryDirectorySql(db, actor, { ...input, sort: 'directory' }, batch, { visibility, authorId });
        const rows = await db.$queryRaw<Array<GalleryDirectoryRow & { name: string }>>(Prisma.sql`WITH ${query.ctes} SELECT key, targetKind, targetId, name FROM filtered LIMIT 500`);
        await spool.add(rows);
      }
      const sorted = await spool.finish(), result: GalleryDirectoryRow[] = [];
      for await (const { name: _name, ...row } of sorted.values((page - 1) * size, size)) result.push(row);
      return result;
    } finally { await spool.dispose(); }
  } };
}

async function resolveAuthorId(db: Prisma.TransactionClient, key: string) {
  let cursor = '';
  for (;;) {
    const rows = await db.user.findMany({ where: { id: { gt: cursor }, account_type: 'internal' }, select: { id: true }, orderBy: { id: 'asc' }, take: 200 });
    for (const row of rows) if (`author:${createHash('sha256').update(JSON.stringify(row.id)).digest('hex')}` === key) return row.id;
    if (rows.length < 200) return '';
    cursor = rows.at(-1)!.id;
  }
}

async function assertCanonicalGalleryMetadata(db: Prisma.TransactionClient) {
  const refsValid = (refs: Prisma.Sql) => Prisma.sql`json_type(${json(refs)}) = 'array' AND json_array_length(${json(refs)}) <= ${MAX_REFERENCE_IMAGES}
    AND NOT EXISTS (SELECT 1 FROM json_each(${array(refs)}) r WHERE json_type(${json(Prisma.sql`r.value`)}, '$.assetId') IS NOT 'text'
      OR length(json_extract(${json(Prisma.sql`r.value`)}, '$.assetId')) NOT BETWEEN 1 AND 100
      OR json_type(${json(Prisma.sql`r.value`)}, '$.note') IS NOT 'text' OR length(json_extract(${json(Prisma.sql`r.value`)}, '$.note')) > 2000)`;
  const textIds = (ids: Prisma.Sql, maximum: number, uuid = false) => Prisma.sql`json_type(${json(ids)}) = 'array' AND json_array_length(${json(ids)}) <= ${maximum}
    AND NOT EXISTS (SELECT 1 FROM json_each(${array(ids)}) r WHERE r.type <> 'text' OR length(r.value) NOT BETWEEN 1 AND 100
      ${uuid ? Prisma.sql`OR length(r.value) <> 36 OR r.value GLOB '*[^0-9a-fA-F-]*'` : Prisma.empty})
    AND json_array_length(${json(ids)}) = (SELECT count(DISTINCT r.value) FROM json_each(${array(ids)}) r)`;
  const value = Prisma.sql`p."value_json"`, safe = json(value), refs = field(value, '$.references'), ids = field(value, '$.ids');
  const unsupported = await db.$queryRaw<Array<{ found: number }>>(Prisma.sql`SELECT 1 AS found FROM "PlatformSetting" p WHERE CASE
    WHEN p."key" GLOB 'studio_fixed_references_v1:*' THEN NOT (${refsValid(refs)})
    WHEN p."key" GLOB 'studio_style_group_v1:*' THEN NOT (${refsValid(refs)}
      AND json_type(${safe}, '$.id') = 'text' AND json_type(${safe}, '$.name') = 'text' AND json_type(${safe}, '$.coverAssetId') = 'text'
      AND json_type(${safe}, '$.revision') = 'integer'
      AND (json_type(${safe}, '$.note') IS NULL OR json_type(${safe}, '$.note') = 'text')
      AND (json_type(${safe}, '$.deleted') IS NULL OR json_type(${safe}, '$.deleted') IN ('null', 'true', 'false'))
      AND (json_type(${safe}, '$.disabled') IS NULL OR json_type(${safe}, '$.disabled') IN ('null', 'true', 'false'))
      AND (json_type(${safe}, '$.shared') IS NULL OR json_type(${safe}, '$.shared') IN ('null', 'true', 'false')))
    WHEN p."key" GLOB 'studio_style_preset_selection_v1:*' THEN NOT (${textIds(ids, MAX_REFERENCE_IMAGES, true)})
    WHEN p."key" GLOB 'studio_skill_selection_v1:preset:*' THEN NOT (${textIds(ids, 12, true)})
    WHEN p."key" GLOB 'studio_reference_policy_v1:preset:*' THEN NOT (
      json_type(${safe}, '$.ownerId') = 'text' AND json_type(${safe}, '$.policy') = 'object'
      AND ${textIds(field(value, '$.policy.primaryIds'), MAX_REFERENCE_IMAGES)}
      AND json_type(${safe}, '$.policy.primaryMin') = 'integer' AND json_extract(${safe}, '$.policy.primaryMin') >= 0
      AND json_type(${safe}, '$.policy.primaryMax') = 'integer' AND json_extract(${safe}, '$.policy.primaryMax') BETWEEN 1 AND ${MAX_REFERENCE_IMAGES}
      AND json_extract(${safe}, '$.policy.primaryMin') <= json_extract(${safe}, '$.policy.primaryMax')
      AND json_array_length(json_extract(${safe}, '$.policy.primaryIds')) <= json_extract(${safe}, '$.policy.primaryMax')
      AND json_type(${safe}, '$.policy.auxiliaryMax') = 'integer' AND json_extract(${safe}, '$.policy.auxiliaryMax') BETWEEN 0 AND ${MAX_REFERENCE_IMAGES}
      AND json_type(${safe}, '$.policy.useFixedReferences') IN ('true', 'false')
      AND (json_type(${safe}, '$.policy.styleMax') IS NULL OR json_type(${safe}, '$.policy.styleMax') = 'integer' AND json_extract(${safe}, '$.policy.styleMax') BETWEEN 0 AND ${MAX_REFERENCE_IMAGES})
      AND (json_type(${safe}, '$.policy.referenceMax') IS NULL OR json_type(${safe}, '$.policy.referenceMax') = 'integer' AND json_extract(${safe}, '$.policy.referenceMax') BETWEEN 0 AND ${MAX_REFERENCE_IMAGES})
      AND NOT EXISTS (SELECT 1 FROM json_each(${safe}, '$.policy') f WHERE f.key NOT IN ('primaryIds', 'primaryMin', 'primaryMax', 'auxiliaryMax', 'styleMax', 'referenceMax', 'useFixedReferences')))
    WHEN p."key" GLOB 'studio_shared_reproduction_v1:*' THEN NOT (
      json_type(${safe}, '$.version') = 'integer' AND json_extract(${safe}, '$.version') IN (1, 2)
      AND json_type(${safe}, '$.sourceOwnerId') = 'text' AND json_type(${safe}, '$.sourceTaskId') = 'text' AND length(json_extract(${safe}, '$.sourceTaskId')) > 0
      AND json_type(${safe}, '$.moduleContext') = 'text' AND ${refsValid(field(value, '$.templateFixedReferences'))}
      AND (json_extract(${safe}, '$.version') = 1 AND json_type(${safe}, '$.globalContext') = 'text'
        OR json_extract(${safe}, '$.version') = 2 AND json_extract(${safe}, '$.taskSettings.protocol') = 'task-settings-v2'
          AND json_extract(${safe}, '$.taskSettings.mode') IN ('current', 'historical')
          AND (json_extract(${safe}, '$.taskSettings.mode') = 'current' AND json_type(${safe}, '$.globalContext') IS NULL
            OR json_extract(${safe}, '$.taskSettings.mode') = 'historical' AND json_type(${safe}, '$.globalContext') = 'text')))
    ELSE 0 END IS NOT 0 LIMIT 1`);
  const badSources = await db.$queryRaw<Array<{ found: number }>>(Prisma.sql`SELECT 1 AS found FROM "ImageStudioPreset" p
    WHERE NOT (${textIds(Prisma.sql`p."reference_ids"`, MAX_REFERENCE_IMAGES)}) LIMIT 1`);
  if (unsupported.length || badSources.length) throw new CatalogSqlCompatibilityError('历史模板元数据需要原兼容解析');
}
