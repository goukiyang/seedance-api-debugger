import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { assertPricingImageConsumerReady } from '@/lib/pricing/runtime';
import { studioSettingsSourcePrefixes } from './reproduction-record-keys';

export type CatalogDomain = 'templates' | 'assets';
export const CATALOG_DIRECTORY_PROTOCOL = 'catalog-paged-v2';
export const catalogRevisionKey = (domain: CatalogDomain) => `catalog_directory_revision_v1:${domain}`;
export const CATALOG_DEPENDENCY_PREFIX = 'catalog_dependency_revision_v1:';
const dependencyKey = (scope: string) => CATALOG_DEPENDENCY_PREFIX + createHash('sha256').update(scope).digest('hex');
const dependencyModels = new Set(['PlatformSetting', 'Asset', 'ImageStudioPreset', 'ImageStudioModule', 'ImageStudioTask', 'User']);
const dependencySettingPrefixes = ['studio_shared_', 'studio_fixed_references_', 'studio_reference_policy_', 'studio_style_',
  'studio_skill_', 'studio_preset_archived_', 'studio_deleted_workspace', 'studio_removed_default_groups_', 'studio_module_cover_v1:',
  'studio_parameter_copy_', 'studio_works_method_pin_', 'multiview_rotation_preset_', 'multiview_private_media_access_', 'feature_profile',
  'image_studio_external_access_v1'];
const relevantSetting = (key: string) => dependencySettingPrefixes.some(prefix => key.startsWith(prefix))
  && key !== 'studio_shared_worker_v1' && !key.startsWith('studio_shared_request_v1:');
const mutationFields: Record<string, string[]> = {
  User: ['id', 'role', 'account_type', 'status', 'expires_at', 'feature_profile_id', 'user_profile', 'email',
    'feishu_user_id', 'feishu_open_id', 'feishu_union_id', 'feishu_tenant_key'],
  Asset: ['id', 'owner_id', 'status', 'type', 'original_url', 'thumbnail_url', 'hash', 'width', 'height', 'file_size', 'mime_type', 'created_at'],
  ImageStudioTask: ['id', 'module_id', 'source_preset_id', 'owner_id', 'deleted_at', 'snapshot_json', 'asset_id', 'status', 'usage_json', 'finished_at'],
};
const mutations = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);

function identities(value: unknown): string[] | null {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return null;
  const filter = value as { equals?: unknown; in?: unknown };
  if (typeof filter.equals === 'string') return [filter.equals];
  return Array.isArray(filter.in) && filter.in.every(id => typeof id === 'string') ? filter.in : null;
}
function readDependencyScopes(model: string, args: unknown) {
  const input = args as { where?: Record<string, unknown> } | undefined;
  const ids = identities(input?.where?.[model === 'PlatformSetting' ? 'key' : 'id']);
  if (!dependencyModels.has(model) || model === 'PlatformSetting' && (!ids || ids.some(id => !relevantSetting(id)))) return ['uncacheable'];
  return ids ? [`${model}:?`, ...ids.map(id => `${model}:${id}`)] : [`${model}:*`];
}

/** Exact identities invalidate exact readers; unknown bulk writes also invalidate their fallback guard. */
export function catalogDependencyScopes(model: string, args: unknown): string[] {
  const input = args as { where?: Record<string, unknown>; data?: Record<string, unknown>; create?: Record<string, unknown> } | undefined;
  if (!dependencyModels.has(model)) return [];
  if (input?.data && !Array.isArray(input.data) && mutationFields[model]
    && !mutationFields[model].some(field => field in input.data!)) return [];
  const field = model === 'PlatformSetting' ? 'key' : 'id';
  const previous = identities(input?.where?.[field]);
  const written = identities(input?.data?.[field] ?? input?.create?.[field]);
  const ids = previous ? Array.from(new Set([...previous, ...(written || [])])) : input?.where ? null : written;
  if (model === 'PlatformSetting' && ids?.every(id => !relevantSetting(id))) return [];
  const scopes = [`${model}:*`, ...(ids ? ids.map(id => `${model}:${id}`) : [`${model}:?`])];
  if (model === 'PlatformSetting' && (!ids || ids.some(id => ['studio_fixed_references_', 'studio_style_group_',
    'studio_shared_reproduction_', 'multiview_rotation_preset_', 'multiview_private_media_access_'].some(prefix => id.startsWith(prefix))
    && !studioSettingsSourcePrefixes.some(prefix => id.startsWith(prefix))))) scopes.push('protection');
  if (model === 'Asset' && (!input?.data || ['original_url', 'thumbnail_url'].some(key => key in input.data!))) scopes.push('protection');
  return scopes;
}
export function catalogDependencyMarkerData(scopes: string[]) {
  return Array.from(new Set(scopes), scope => ({ key: dependencyKey(scope),
    value_json: JSON.stringify({ version: 1, revision: randomBytes(32).toString('hex') }) }));
}
export async function bumpCatalogDependencies(tx: Pick<Prisma.TransactionClient, 'platformSetting'>, scopes: string[]) {
  for (const row of catalogDependencyMarkerData(scopes)) {
    await tx.platformSetting.upsert({ where: { key: row.key }, create: row, update: { value_json: row.value_json } });
  }
}
export async function readCatalogDependencyStamp(tx: Pick<Prisma.TransactionClient, 'platformSetting'>, scopes: Iterable<string>) {
  const keys = Array.from(new Set(scopes), dependencyKey).sort();
  const rows = await tx.platformSetting.findMany({ where: { key: { in: keys } }, select: { key: true, value_json: true } });
  const revisions = new Map(rows.map(row => {
    const value = JSON.parse(row.value_json);
    if (value?.version !== 1 || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)) throw new Error('catalog_dependency_unavailable');
    return [row.key, value.revision] as const;
  }));
  return createHash('sha256').update(JSON.stringify(keys.map(key => [key, revisions.get(key) ?? null]))).digest('hex');
}

/** Capture the resolver's real read identities, including missing rows. No private values enter the cache key. */
export function trackCatalogDependencies<T extends object>(client: T, scopes: Set<string>): T {
  return new Proxy(client, { get(target, property) {
    const delegate = Reflect.get(target, property);
    if (typeof property !== 'string') return delegate;
    if (property.startsWith('$')) {
      if (typeof delegate !== 'function') return delegate;
      return (...args: unknown[]) => { scopes.add('protection'); return Reflect.apply(delegate, target, args); };
    }
    if (!delegate || typeof delegate !== 'object') return delegate;
    const model = property[0].toUpperCase() + property.slice(1);
    return new Proxy(delegate, { get(value, operation) {
      const method = Reflect.get(value, operation);
      if (typeof method !== 'function') return method;
      return (...args: unknown[]) => {
        if (mutations.has(String(operation))) throw new Error('catalog_dependency_read_only');
        for (const scope of readDependencyScopes(model, args[0])) scopes.add(scope);
        return Reflect.apply(method, value, args);
      };
    } });
  } });
}
export async function bumpCatalogRevision(tx: Pick<Prisma.TransactionClient, 'platformSetting'>, domains: CatalogDomain[]) {
  for (const domain of Array.from(new Set(domains))) {
    const key = catalogRevisionKey(domain), value_json = JSON.stringify({ version: 1, revision: randomBytes(32).toString('hex') });
    await tx.platformSetting.upsert({ where: { key }, create: { key, value_json }, update: { value_json } });
  }
}
export async function readCatalogRevision(tx: Pick<Prisma.TransactionClient, 'platformSetting'>, domain: CatalogDomain) {
  const row = await tx.platformSetting.findUnique({ where: { key: catalogRevisionKey(domain) }, select: { value_json: true } });
  if (!row) return null;
  const value = JSON.parse(row.value_json);
  if (value?.version !== 1 || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)) throw new Error('catalog_revision_unavailable');
  return value.revision as string;
}
export async function initializeCatalogRevisions(tx: Pick<Prisma.TransactionClient, 'platformSetting'>) {
  for (const domain of ['templates', 'assets'] as const) {
    const key = catalogRevisionKey(domain), value_json = JSON.stringify({ version: 1, revision: randomBytes(32).toString('hex') });
    await tx.platformSetting.upsert({ where: { key }, create: { key, value_json }, update: { value_json } });
  }
}
export async function catalogReaderReady(tx: Pick<Prisma.TransactionClient, 'platformSetting'>) {
  try { await assertPricingImageConsumerReady(tx); return true; } catch { return false; }
}
