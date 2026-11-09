import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canUseCompanyTemplates, type ImageStudioIdentity } from './access';
import { siteUploadBaseUrls, siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { hiddenMultiviewSystemReferenceUrls } from '@/lib/video/multiview-recipe-storage.server';
import { multiviewOutputFileAccess } from '@/lib/video/multiview-output-access.server';
import { catalogVisibilitySql, CatalogSqlCompatibilityError } from '@/lib/assets/catalog-visibility-sql';
import { studioReproductionBindingSql, studioReproductionBindingWhere, studioSettingsSourcePrefixes } from './reproduction-record-keys';
import { platformSettingPrefix } from '@/lib/platform-setting-prefix';

type Client = Pick<Prisma.TransactionClient, 'platformSetting' | 'asset'>;
export class StudioAssetProtectionError extends Error {}
type Protection = { assetId: string; ownerId: string; kind: 'template' | 'style' };

export class StudioCoverReferenceError extends Error {
  readonly status = 409;
}
// Cover history is deliberately retained for recovery; task deletion never removes
// these references. Include file aliases so a copied Asset cannot erase the source.
export async function assertStudioCoverAssetNotReferenced(assetId: string,
  client: Pick<Prisma.TransactionClient, 'asset' | '$queryRaw'> = prisma) {
  const asset = await client.asset.findUnique({ where: { id: assetId }, select: { original_url: true, thumbnail_url: true } });
  if (!asset) return;
  const urls = [asset.original_url, ...(asset.thumbnail_url ? [asset.thumbnail_url] : [])].flatMap(url => {
    const pathname = siteUploadPathFromUrl(url);
    return pathname ? [url, pathname, ...siteUploadBaseUrls().map(base => `${base}${pathname}`)] : [url];
  });
  const aliases = await client.asset.findMany({ where: { OR: [{ id: assetId }, { original_url: { in: urls } }, { thumbnail_url: { in: urls } }] }, select: { id: true } });
  const corrupt = await client.$queryRaw<Array<{ key: string }>>(Prisma.sql`
    SELECT key FROM PlatformSetting WHERE (key GLOB 'studio_module_cover_v1:*'
      OR key GLOB 'studio_module_cover_history_v1:*' OR key GLOB 'studio_module_cover_request_v1:*'
      OR key GLOB 'studio_module_cover_prepare_v3:*')
    AND CASE WHEN json_valid(value_json) THEN
      CASE WHEN key GLOB 'studio_module_cover_prepare_v3:*' AND json_extract(value_json, '$.disposition') IN ('none', 'existing')
        THEN json_type(value_json, '$.recipe') IS NOT 'null'
        ELSE json_type(value_json, '$.recipe.sources') IS NOT 'array'
          OR EXISTS (SELECT 1 FROM json_each(value_json, '$.recipe.sources') s WHERE json_type(s.value, '$.assetId') IS NOT 'text') END
    ELSE 1 END LIMIT 1`);
  if (corrupt.length) throw new StudioCoverReferenceError('封面引用无法确认，暂不能移除原图');
  const rows = await client.$queryRaw<Array<{ key: string }>>(Prisma.sql`
    SELECT p.key FROM PlatformSetting p, json_each(p.value_json, '$.recipe.sources') s
    WHERE (p.key GLOB 'studio_module_cover_v1:*' OR p.key GLOB 'studio_module_cover_history_v1:*'
      OR (p.key GLOB 'studio_module_cover_request_v1:*' AND json_extract(p.value_json, '$.status') = 'pending'
        AND json_extract(p.value_json, '$.expiresAt') > ${Date.now()})
      OR (p.key GLOB 'studio_module_cover_prepare_v3:*' AND json_extract(p.value_json, '$.status') IN ('pending', 'ready')
        AND json_extract(p.value_json, '$.expiresAt') > ${Date.now()}))
      AND json_extract(s.value, '$.assetId') IN (${Prisma.join(aliases.map(item => item.id))}) LIMIT 1`);
  if (rows.length) throw new StudioCoverReferenceError('这张原图用于永久封面或封面恢复，不能移除；普通生成记录仍可隐藏');
}

export function studioProtectedBindings(rows: Array<{ key: string; value_json: string }>): Protection[] {
  return rows.flatMap(row => {
    if (studioSettingsSourcePrefixes.some(prefix => row.key.startsWith(prefix))) return [];
    let value: Record<string, unknown>;
    try { value = JSON.parse(row.value_json); } catch { throw new StudioAssetProtectionError('参考内容权限记录无法读取'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioAssetProtectionError('参考内容权限记录无效');
    const historical = row.key.startsWith('studio_shared_reproduction_v1:');
    const ownerId = historical ? value.sourceOwnerId : value.ownerId;
    const references = historical ? value.templateFixedReferences : value.references;
    if (!value || typeof ownerId !== 'string' || !Array.isArray(references)) throw new StudioAssetProtectionError('参考内容权限记录无效');
    return references.flatMap(item => {
      if (!item || typeof item.assetId !== 'string') throw new StudioAssetProtectionError('参考内容权限记录无效');
      return [{ assetId: item.assetId, ownerId,
        kind: row.key.startsWith('studio_style_group_v1:') ? 'style' as const : 'template' as const }];
    });
  });
}

export function canInspectStudioBinding(user: Pick<ImageStudioIdentity, 'id' | 'role' | 'account_type'> | null, binding: Protection) {
  if (!user || user.account_type !== 'internal') return false;
  return user.role === 'admin' || (binding.kind === 'style' && binding.ownerId === user.id);
}

function hiddenStudioBindings<T extends Protection>(user: ImageStudioIdentity | null, bindings: T[]) {
  const ownedStyleIds = new Set(bindings.filter(binding => binding.kind === 'style' && canInspectStudioBinding(user, binding)).map(binding => binding.assetId));
  return bindings.filter(binding => !canInspectStudioBinding(user, binding)
    && (binding.kind === 'template' || !ownedStyleIds.has(binding.assetId)));
}

// Match underlying files as well as ids: older template application copied an
// Asset row with the same URL, so checking just the source id leaves a bypass.
export async function studioHiddenAssetUrls(user: ImageStudioIdentity | null, client: Client = prisma, assetIds?: string[]): Promise<string[]> {
  const sqlClient = client as Prisma.TransactionClient;
  if (assetIds && assetIds.length <= 240 && typeof sqlClient.$queryRaw === 'function' && sqlClient.user) {
    if (!assetIds.length) return [];
    try {
      const visibility = await catalogVisibilitySql(sqlClient, user || { id: 'module-cover-audience' }, !user || user.id === 'module-cover-audience');
      const rows = await sqlClient.$queryRaw<Array<{ url: string }>>(Prisma.sql`WITH ${visibility.ctes}
        SELECT DISTINCT hidden.url FROM hidden_urls hidden JOIN "Asset" a ON a."original_url" = hidden.url OR a."thumbnail_url" = hidden.url
        WHERE a."id" IN (${Prisma.join(assetIds)})`);
      return rows.map(row => row.url);
    } catch (error) { if (!(error instanceof CatalogSqlCompatibilityError)) throw error; }
  }
  const multiviewHidden = await hiddenMultiviewSystemReferenceUrls(user, client);
  if (user?.role === 'admin' && canUseCompanyTemplates(user)) return multiviewHidden;
  const rows = await client.platformSetting.findMany({ where: { OR: [
    { key: platformSettingPrefix('studio_fixed_references_v1:') },
    { key: platformSettingPrefix('studio_style_group_v1:') },
    studioReproductionBindingWhere,
  ] }, select: { key: true, value_json: true } });
  const allBindings = studioProtectedBindings(rows);
  const bindings = hiddenStudioBindings(user, allBindings);
  if (!bindings.length) return multiviewHidden;
  const assets = await client.asset.findMany({ where: { id: { in: Array.from(new Set(bindings.map(binding => binding.assetId))) } },
    select: { original_url: true, thumbnail_url: true } });
  return Array.from(new Set([...multiviewHidden, ...assets.flatMap(asset => [asset.original_url, ...(asset.thumbnail_url ? [asset.thumbnail_url] : [])]).flatMap(url => {
    const pathname = siteUploadPathFromUrl(url);
    return pathname ? [url, pathname, ...siteUploadBaseUrls().map(base => `${base}${pathname}`)] : [url];
  })])).sort();
}

export async function studioVisibleAssetWhere(user: ImageStudioIdentity, client: Client = prisma, assetIds?: string[]): Promise<Prisma.AssetWhereInput> {
  const hidden = await studioHiddenAssetUrls(user, client, assetIds);
  return hidden.length ? { original_url: { notIn: hidden } } : {};
}

export async function canReadStudioAsset(user: ImageStudioIdentity, asset: { id?: string; original_url: string }, client: Prisma.TransactionClient = prisma) {
  if ((await studioHiddenAssetUrls(user, client, asset.id ? [asset.id] : undefined)).includes(asset.original_url)) return false;
  const output = await multiviewOutputFileAccess(user, asset.original_url, false, client);
  return !output.protected || output.allowed;
}

// Homepage covers need the same file-alias protection without loading every
// private reference/note. Overflow or corrupt records fail closed to placeholders.
export async function readableStudioCoverIds(user: ImageStudioIdentity,
  assets: Array<{ id: string; original_url: string }>): Promise<Set<string>> {
  if (!assets.length) return new Set();
  if (assets.length > 40) throw new Error('封面数量超出限制');
  if (user.role === 'admin' && canUseCompanyTemplates(user)) return new Set(assets.map(asset => asset.id));
  const privateMultiviewUrls = new Set(await hiddenMultiviewSystemReferenceUrls(user));
  assets = assets.filter(asset => !privateMultiviewUrls.has(asset.original_url));
  if (!assets.length) return new Set();
  const historical = studioReproductionBindingSql(Prisma.sql`p.key`);
  const keys = Prisma.sql`(p.key GLOB 'studio_fixed_references_v1:*' OR p.key GLOB 'studio_style_group_v1:*' OR ${historical})`;
  const json = Prisma.sql`CASE WHEN json_valid(p.value_json) THEN p.value_json ELSE '{}' END`;
  const referencesPath = Prisma.sql`CASE WHEN ${historical} THEN '$.templateFixedReferences' ELSE '$.references' END`;
  const ownerPath = Prisma.sql`CASE WHEN ${historical} THEN '$.sourceOwnerId' ELSE '$.ownerId' END`;
  const references = Prisma.sql`json_extract(${json}, ${referencesPath})`;
  // A missing binding identity cannot be proved unrelated. Retain the legacy
  // fail-closed result for these records, rather than treating broken JSON as public.
  const unknownBindings = Prisma.sql`
    SELECT 1 AS found FROM PlatformSetting p WHERE ${keys} AND (
      json_type(${json}, ${referencesPath}) IS NOT 'array' OR EXISTS (
        SELECT 1 FROM json_each(COALESCE(${references}, '[]')) r WHERE
          json_type(CASE WHEN r.type = 'object' THEN r.value ELSE '{}' END, '$.assetId') IS NOT 'text')) LIMIT 1`;
  const unknown = await prisma.$queryRaw<Array<{ found: number }>>(unknownBindings);
  if (unknown.length) throw new StudioAssetProtectionError('参考内容权限记录无法读取');
  const bases = siteUploadBaseUrls();
  const normalized = (url: Prisma.Sql) => {
    const trimmed = Prisma.sql`trim(${url})`;
    const pathname = Prisma.sql`CASE WHEN substr(${trimmed}, 1, 9) = '/uploads/' THEN ${trimmed}
      ${Prisma.join(bases.map(base => Prisma.sql`WHEN substr(${trimmed}, 1, ${base.length + 9}) = ${base + '/uploads/'} THEN substr(${trimmed}, ${base.length + 1})`), ' ')}
      ELSE NULL END`;
    return Prisma.sql`substr(${pathname}, 1, min(
      CASE WHEN instr(${pathname}, '?') > 0 THEN instr(${pathname}, '?') ELSE length(${pathname}) + 1 END,
      CASE WHEN instr(${pathname}, '#') > 0 THEN instr(${pathname}, '#') ELSE length(${pathname}) + 1 END) - 1)`;
  };
  const bindingRows = Prisma.sql`SELECT p.key, json_extract(${json}, ${ownerPath}) AS owner_id,
      json_type(${json}, ${ownerPath}) AS owner_type, json_extract(r.value, '$.assetId') AS asset_id,
      CASE WHEN p.key GLOB 'studio_style_group_v1:*' THEN 'style' ELSE 'template' END AS kind
    FROM PlatformSetting p, json_each(${references}) r WHERE ${keys}`;
  // URL() normalizes historical dot paths, host casing and encoded dot segments.
  // Keep the original parser for such rows; SQL equality must never guess their aliases.
  const bindingUrls = Prisma.sql`SELECT a.original_url AS url FROM bindings b JOIN Asset a ON a.id = b.asset_id
      UNION SELECT a.thumbnail_url FROM bindings b JOIN Asset a ON a.id = b.asset_id WHERE a.thumbnail_url IS NOT NULL`;
  const unusualUrls = Prisma.sql`SELECT 1 AS found FROM urls WHERE instr(lower(url), '/uploads/') > 0 AND (
      ${normalized(Prisma.sql`url`)} IS NULL OR instr(url, '/../') > 0 OR instr(url, '/./') > 0
      OR instr(url, char(92)) > 0 OR instr(lower(url), '%2e') > 0
      OR (substr(trim(url), 1, 9) <> '/uploads/' AND (instr(url, ' ') > 0 OR url GLOB '*[^ -~]*'))) LIMIT 1`;
  const unusual = await prisma.$queryRaw<Array<{ found: number }>>(Prisma.sql`WITH bindings AS (${bindingRows}),
    urls AS (${bindingUrls}) ${unusualUrls}`);
  if (unusual.length) {
    const hidden = new Set(await studioHiddenAssetUrls(user));
    return new Set(assets.filter(asset => !hidden.has(asset.original_url)).map(asset => asset.id));
  }
  const targetRows = assets.map(asset => Prisma.sql`SELECT ${asset.id} AS target_id, ${asset.original_url} AS url`);
  const denied = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`WITH bindings AS (${bindingRows}),
    urls AS (${bindingUrls}), targets AS (${Prisma.join(targetRows, ' UNION ALL ')}),
    target_urls AS (SELECT t.target_id, t.url FROM targets t),
    matches AS (SELECT DISTINCT t.target_id, b.key, b.asset_id, b.owner_id, b.owner_type, b.kind FROM target_urls t
      JOIN Asset a ON a.original_url = t.url OR a.thumbnail_url = t.url
        OR ${normalized(Prisma.sql`a.original_url`)} = ${normalized(Prisma.sql`t.url`)}
        OR ${normalized(Prisma.sql`a.thumbnail_url`)} = ${normalized(Prisma.sql`t.url`)}
      JOIN bindings b ON b.asset_id = a.id),
    protection AS (SELECT target_id, asset_id, count(*) AS binding_count,
      max(CASE WHEN owner_type IS NOT 'text' OR kind = 'template' THEN 1 ELSE 0 END) AS hidden,
      max(CASE WHEN kind = 'style' AND owner_id = ${user.id} AND ${user.account_type === 'internal' ? 1 : 0} = 1 THEN 1 ELSE 0 END) AS own_style
      FROM matches GROUP BY target_id, asset_id)
    SELECT target_id AS id FROM protection GROUP BY target_id
      HAVING sum(binding_count) > 256 OR max(CASE WHEN hidden = 1 OR own_style = 0 THEN 1 ELSE 0 END) = 1
    UNION SELECT target_id AS id FROM targets WHERE EXISTS (${unknownBindings}) OR EXISTS (${unusualUrls})`);
  const deniedIds = new Set(denied.map(row => row.id));
  return new Set(assets.filter(asset => !deniedIds.has(asset.id)).map(asset => asset.id));
}

export async function studioVisibleReferenceWhere(user: ImageStudioIdentity, client: Prisma.TransactionClient = prisma, referenceIds?: string[]): Promise<Prisma.ReferenceImageWhereInput> {
  if (referenceIds && referenceIds.length <= 100) {
    if (!referenceIds.length) return {};
    try {
      const visibility = await catalogVisibilitySql(client, user);
      const denied = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`WITH ${visibility.ctes}
        SELECT r."id" FROM "ReferenceImage" r LEFT JOIN "Asset" a ON a."id" = r."asset_id" WHERE r."id" IN (${Prisma.join(referenceIds)})
          AND (NOT (${visibility.visible(Prisma.sql`r."url"`)}) OR a."id" IS NOT NULL AND NOT (${visibility.visible(Prisma.sql`a."original_url"`)})) LIMIT ${referenceIds.length}`);
      return denied.length ? { id: { notIn: denied.map(row => row.id) } } : {};
    } catch (error) { if (!(error instanceof CatalogSqlCompatibilityError)) throw error; }
  }
  const hidden = await studioHiddenAssetUrls(user);
  return hidden.length ? { AND: [{ url: { notIn: hidden } }, { OR: [{ asset: null }, { asset: { original_url: { notIn: hidden } } }] }] } : {};
}
