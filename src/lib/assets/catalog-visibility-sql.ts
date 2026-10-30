import { Prisma } from '@prisma/client';
import { siteUploadBaseUrls } from './site-url';

export class CatalogSqlCompatibilityError extends Error {}
type Db = Pick<Prisma.TransactionClient, '$queryRaw' | 'user'>;
const studioKeys = Prisma.sql`(p."key" GLOB 'studio_fixed_references_v1:*' OR p."key" GLOB 'studio_style_group_v1:*' OR p."key" GLOB 'studio_shared_reproduction_v1:*')`;
const recipeKeys = Prisma.sql`(p."key" = 'multiview_rotation_preset_v1:current' OR p."key" GLOB 'multiview_rotation_preset_v1:version:*')`;
const fileKeys = Prisma.sql`p."key" GLOB 'multiview_private_media_access_v1:*'`;
const safeJson = Prisma.sql`CASE WHEN json_valid(p."value_json") THEN p."value_json" ELSE '{}' END`;
const historical = Prisma.sql`p."key" GLOB 'studio_shared_reproduction_v1:*'`;
const bindingOwner = Prisma.sql`json_extract(${safeJson}, CASE WHEN ${historical} THEN '$.sourceOwnerId' ELSE '$.ownerId' END)`;
const bindingReferences = Prisma.sql`json_extract(${safeJson}, CASE WHEN ${historical} THEN '$.templateFixedReferences' ELSE '$.references' END)`;

/** Only scalar identities and file aliases cross this boundary, never private notes or recipes. */
export async function catalogVisibilitySql(db: Db, session: { id: string }, publicAudience = false) {
  const current = publicAudience ? { id: 'module-cover-audience', role: 'user', account_type: 'internal', status: 'active' }
    : await db.user.findUnique({ where: { id: session.id }, select: { id: true, role: true, account_type: true, status: true } });
  if (!current || current.status !== 'active') throw Object.assign(new Error('账号不可用'), { status: 403 });
  const admin = current.role === 'admin' && current.account_type === 'internal';
  const bases = siteUploadBaseUrls();
  const identity = (value: Prisma.Sql) => Prisma.sql`typeof(${value}) = 'text' AND length(${value}) BETWEEN 1 AND 180 AND ${value} NOT GLOB '*[^a-zA-Z0-9_-]*'`;
  const malformed = await db.$queryRaw<Array<{ found: number }>>(Prisma.sql`SELECT 1 AS found FROM "PlatformSetting" p WHERE
    (${studioKeys} AND (${bindingOwner} IS NULL OR json_type(${safeJson}, CASE WHEN ${historical} THEN '$.sourceOwnerId' ELSE '$.ownerId' END) IS NOT 'text'
      OR json_type(${safeJson}, CASE WHEN ${historical} THEN '$.templateFixedReferences' ELSE '$.references' END) IS NOT 'array'
      OR EXISTS (SELECT 1 FROM json_each(COALESCE(${bindingReferences}, '[]')) r WHERE
        json_type(CASE WHEN json_valid(r.value) THEN r.value ELSE '{}' END, '$.assetId') IS NOT 'text')))
    OR (${recipeKeys} AND (json_type(${safeJson}, '$.preset') IS NOT 'object' OR
      (json_type(${safeJson}, '$.preset.compositionReference') IS NOT NULL AND
        (json_type(${safeJson}, '$.preset.compositionReference') IS NOT 'object'
          OR json_type(${safeJson}, '$.preset.compositionReference.assetId') IS NOT 'text'
          OR json_type(${safeJson}, '$.preset.compositionReference.referenceImageId') IS NOT 'text'
          OR json_type(${safeJson}, '$.preset.compositionReference.ownerId') IS NOT 'text'
          OR NOT (${identity(Prisma.sql`json_extract(${safeJson}, '$.preset.compositionReference.assetId')`)})
          OR NOT (${identity(Prisma.sql`json_extract(${safeJson}, '$.preset.compositionReference.referenceImageId')`)})
          OR NOT (${identity(Prisma.sql`json_extract(${safeJson}, '$.preset.compositionReference.ownerId')`)})
          OR EXISTS (SELECT 1 FROM json_each(${safeJson}, '$.preset.compositionReference') f WHERE f.key NOT IN ('assetId', 'referenceImageId', 'ownerId', 'sha256'))
          OR length(json_extract(${safeJson}, '$.preset.compositionReference.sha256')) IS NOT 64
          OR json_extract(${safeJson}, '$.preset.compositionReference.sha256') GLOB '*[^0-9a-f]*'))))
    OR (${fileKeys} AND (json_extract(${safeJson}, '$.schema') IS NOT 1 OR json_extract(${safeJson}, '$.kind') IS NOT 'system-reference'
      OR json_type(${safeJson}, '$.ownerId') IS NOT 'text' OR json_type(${safeJson}, '$.assetId') IS NOT 'text'
      OR NOT (${identity(Prisma.sql`json_extract(${safeJson}, '$.ownerId')`)}) OR NOT (${identity(Prisma.sql`json_extract(${safeJson}, '$.assetId')`)})
      OR length(json_extract(${safeJson}, '$.sha256')) IS NOT 64 OR json_extract(${safeJson}, '$.sha256') GLOB '*[^0-9a-f]*'
      OR p."key" <> 'multiview_private_media_access_v1:' || json_extract(${safeJson}, '$.sha256')
      OR json_type(${safeJson}, '$.urls') IS NOT 'array' OR json_array_length(${safeJson}, '$.urls') = 0
      OR EXISTS (SELECT 1 FROM json_each(${safeJson}, '$.urls') u WHERE u.type <> 'text' OR
        (substr(trim(u.value), 1, 9) <> '/uploads/' AND NOT (${Prisma.join(bases.map(base => Prisma.sql`substr(trim(u.value), 1, ${base.length + 9}) = ${base + '/uploads/'}`), ' OR ')})))))
    LIMIT 1`);
  if (malformed.length) throw new CatalogSqlCompatibilityError('目录权限记录需要原兼容读取');
  const stripSuffix = (value: Prisma.Sql) => Prisma.sql`substr(${value}, 1, min(
    CASE WHEN instr(${value}, '?') > 0 THEN instr(${value}, '?') ELSE length(${value}) + 1 END,
    CASE WHEN instr(${value}, '#') > 0 THEN instr(${value}, '#') ELSE length(${value}) + 1 END) - 1)`;
  const source = Prisma.sql`trim(url)`;
  const uploadPath = Prisma.sql`CASE WHEN substr(${source}, 1, 9) = '/uploads/' THEN ${stripSuffix(source)}
    ${Prisma.join(bases.map(base => Prisma.sql`WHEN substr(${source}, 1, ${base.length + 9}) = ${base + '/uploads/'} THEN ${stripSuffix(Prisma.sql`substr(${source}, ${base.length + 1})`)}`), ' ')}
    ELSE NULL END`;
  const ctes = Prisma.sql`
    protected_bindings AS MATERIALIZED (
      SELECT json_extract(r.value, '$.assetId') AS asset_id, ${bindingOwner} AS owner_id,
        CASE WHEN p."key" GLOB 'studio_style_group_v1:*' THEN 'style' ELSE 'template' END AS kind
      FROM "PlatformSetting" p, json_each(COALESCE(${bindingReferences}, '[]')) r WHERE ${studioKeys}
    ), private_urls AS MATERIALIZED (
      SELECT a."original_url" AS url FROM protected_bindings b JOIN "Asset" a ON a."id" = b.asset_id
        WHERE ${admin ? Prisma.sql`0 = 1` : Prisma.sql`b.kind = 'template' OR NOT EXISTS (SELECT 1 FROM protected_bindings own
          WHERE own.asset_id = b.asset_id AND own.kind = 'style' AND own.owner_id = ${current.id} AND ${current.account_type === 'internal' ? 1 : 0} = 1)`}
      UNION SELECT a."thumbnail_url" FROM protected_bindings b JOIN "Asset" a ON a."id" = b.asset_id
        WHERE a."thumbnail_url" IS NOT NULL AND (${admin ? Prisma.sql`0 = 1` : Prisma.sql`b.kind = 'template' OR NOT EXISTS (SELECT 1 FROM protected_bindings own
          WHERE own.asset_id = b.asset_id AND own.kind = 'style' AND own.owner_id = ${current.id} AND ${current.account_type === 'internal' ? 1 : 0} = 1)`})
      UNION SELECT u.value FROM "PlatformSetting" p, json_each(${safeJson}, '$.urls') u WHERE ${fileKeys}
        AND (${admin ? Prisma.sql`0 = 1` : Prisma.sql`json_extract(${safeJson}, '$.ownerId') <> ${current.id}`})
      UNION SELECT a."original_url" FROM "PlatformSetting" p JOIN "Asset" a ON a."id" = json_extract(${safeJson}, '$.preset.compositionReference.assetId')
        WHERE ${recipeKeys} AND (${admin ? Prisma.sql`0 = 1` : Prisma.sql`json_extract(${safeJson}, '$.preset.compositionReference.ownerId') <> ${current.id}`})
      UNION SELECT a."thumbnail_url" FROM "PlatformSetting" p JOIN "Asset" a ON a."id" = json_extract(${safeJson}, '$.preset.compositionReference.assetId')
        WHERE ${recipeKeys} AND a."thumbnail_url" IS NOT NULL
          AND (${admin ? Prisma.sql`0 = 1` : Prisma.sql`json_extract(${safeJson}, '$.preset.compositionReference.ownerId') <> ${current.id}`})
    ), private_paths AS MATERIALIZED (SELECT url, ${uploadPath} AS pathname FROM private_urls),
    hidden_urls AS MATERIALIZED (SELECT url FROM private_paths UNION SELECT pathname FROM private_paths WHERE pathname IS NOT NULL
      ${Prisma.join(bases.map(base => Prisma.sql`UNION SELECT ${base} || pathname FROM private_paths WHERE pathname IS NOT NULL`), ' ')})`;
  // Noncanonical historical URLs still use the original URL parser. Never guess aliases.
  const unsupported = await db.$queryRaw<Array<{ found: number }>>(Prisma.sql`WITH ${ctes}
    SELECT 1 AS found FROM private_urls WHERE url LIKE '%/uploads/%' AND (
      instr(url, '/../') > 0 OR instr(url, '/./') > 0 OR instr(url, char(92)) > 0 OR instr(lower(url), '%2e') > 0
      OR (substr(trim(url), 1, 9) <> '/uploads/' AND (instr(url, ' ') > 0 OR url GLOB '*[^ -~]*'))
      OR (substr(trim(url), 1, 9) <> '/uploads/' AND NOT (${Prisma.join(bases.map(base => Prisma.sql`substr(trim(url), 1, ${base.length + 9}) = ${base + '/uploads/'}`), ' OR ')}))) LIMIT 1`);
  if (unsupported.length) throw new CatalogSqlCompatibilityError('历史文件别名需要原兼容读取');
  return { current, ctes, visible: (url: Prisma.Sql) => Prisma.sql`NOT EXISTS (SELECT 1 FROM hidden_urls hidden WHERE hidden.url = ${url})` };
}
