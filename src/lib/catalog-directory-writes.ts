import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { bumpCatalogRevision, catalogRevisionKey, type CatalogDomain } from './image-studio/catalog-revision';

const operations = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);
const both: CatalogDomain[] = ['templates', 'assets'];
const modelDomains: Record<string, CatalogDomain[]> = {
  Asset: both, User: both, ImageStudioPreset: both, ImageStudioModule: both,
  ContentReaction: both, ReferenceAlbum: ['assets'], ReferenceImage: ['assets'], AlbumShare: ['assets'],
  Project: ['assets'], ProjectMember: ['assets'], MultiviewWork: ['assets'], MultiviewSource: ['assets'],
  MultiviewShare: ['assets'], MultiviewShareRecipient: ['assets'], VideoTask: ['assets'],
};
const templatePrefixes = ['studio_shared_', 'studio_fixed_references_', 'studio_reference_policy_', 'studio_style_',
  'studio_skill_selection_', 'studio_preset_archived_', 'studio_deleted_workspace', 'studio_removed_default_groups_', 'studio_module_cover_v1:',
  'multiview_rotation_preset_v1:', 'multiview_private_media_access_v1:', 'feature_profile'];
const assetPrefixes = ['asset-library-removal:', 'resource-library-removal:', 'multiview_'];
const installed = new WeakMap<object, PrismaClient>();
const marker = Symbol.for('sd2.catalog-directory-writes.v1');

function settingKeys(value: unknown): string[] | null {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return null;
  const input = value as { in?: unknown; equals?: unknown; startsWith?: unknown };
  if (typeof input.equals === 'string') return [input.equals];
  if (typeof input.startsWith === 'string') return [input.startsWith];
  return Array.isArray(input.in) && input.in.every(key => typeof key === 'string') ? input.in : null;
}
function domains(model: string | undefined, operation: string, args: unknown): CatalogDomain[] {
  if (!model || !operations.has(operation)) return [];
  const input = args as { where?: { key?: unknown }; data?: { key?: unknown }; create?: { key?: unknown } } | undefined;
  if (['update', 'updateMany'].includes(operation) && model === 'User') return [
    'id', 'name', 'username', 'email', 'avatar_url', 'role', 'account_type', 'status', 'expires_at', 'feature_profile_id', 'user_profile',
    'feishu_user_id', 'feishu_open_id', 'feishu_union_id', 'feishu_tenant_key',
  ].some(key => key in (input?.data || {})) ? both : [];
  if (['update', 'updateMany'].includes(operation) && model === 'MultiviewWork') return [
    'id', 'owner_id', 'source_task_id', 'source_id', 'save_state', 'removed_at', 'title', 'ready_revision', 'project_id', 'created_at', 'ready_recipe_json', 'ready_manifest_json',
  ].some(key => key in (input?.data || {})) ? ['assets'] : [];
  if (['update', 'updateMany'].includes(operation) && model === 'VideoTask') return [
    'id', 'owner_user_id', 'user_id', 'project_id', 'retention_status', 'source_metadata_json', 'prompt', 'source_label', 'provider_task_id',
    'created_at', 'completed_at', 'duration', 'local_status', 'generation_mode', 'provider', 'video_card_id', 'public_video_url', 'local_video_path', 'result_video_url', 'result_last_frame_url',
  ].some(key => key in (input?.data || {})) ? ['assets'] : [];
  if (model === 'PlatformSetting') {
    const keys = settingKeys(input?.where?.key ?? input?.data?.key ?? input?.create?.key);
    if (!keys) return both;
    const relevant = keys.filter(key => key !== 'studio_shared_worker_v1' && !both.some(domain => key === catalogRevisionKey(domain)));
    if (!relevant.length) return [];
    return Array.from(new Set(relevant.flatMap(key => [
      ...(templatePrefixes.some(prefix => key.startsWith(prefix)) ? both : []),
      ...(assetPrefixes.some(prefix => key.startsWith(prefix)) ? ['assets' as const] : []),
    ])));
  }
  if (model === 'ImageStudioTask') {
    if (!['update', 'updateMany'].includes(operation)) return both;
    const data = input?.data || {};
    return ['status', 'asset_id', 'owner_id', 'module_id', 'source_preset_id', 'deleted_at', 'finished_at', 'created_at', 'snapshot_json', 'usage_json']
      .some(key => key in data) ? both : [];
  }
  return modelDomains[model] || [];
}

/** Directory-only invalidation. Business mutations retain their result and original transaction. */
export function catalogDirectoryWrites<T extends PrismaClient>(base: T): T {
  const alreadyTracked: unknown = Reflect.get(base, marker);
  if (alreadyTracked === true) return base;
  const existing = installed.get(base); if (existing) return existing as T;
  const context = new AsyncLocalStorage<Prisma.TransactionClient>();
  const promises = new WeakMap<object, CatalogDomain[]>();
  const transaction = base.$transaction.bind(base);
  base.$use(async (params, next) => {
    const affected = domains(params.model, params.action, params.args);
    if (!affected.length) return next(params);
    const tx = context.getStore();
    if (!params.runInTransaction) {
      return transaction(async current => context.run(current, async () => {
        const name = params.model![0].toLowerCase() + params.model!.slice(1);
        const delegate = Reflect.get(current, name);
        return Reflect.apply(Reflect.get(delegate, params.action), delegate, [params.args]);
      }), { maxWait: 5000, timeout: 15000 });
    }
    const result = await next(params);
    if (tx && !(result && typeof result === 'object' && 'count' in result && result.count === 0)) await bumpCatalogRevision(tx, affected);
    return result;
  });
  const wrap = (client: object): T => new Proxy(client, { get(target, property) {
    if (property === marker) return true;
    if (property === '$transaction') {
      // Instrumentation may replace the method after capturing this callable.
      const targetTransaction = Reflect.get(target, '$transaction');
      return (input: unknown, options?: unknown) => {
        if (typeof input === 'function') return Reflect.apply(targetTransaction, target, [
          (tx: Prisma.TransactionClient) => context.run(tx, () => input(tx)), options,
        ]);
        if (!Array.isArray(input)) throw new Error('catalog_transaction_invalid');
        const affected = Array.from(new Set(input.flatMap(value => promises.get(value) || [])));
        const markers = affected.map(domain => {
          const key = catalogRevisionKey(domain);
          const value_json = JSON.stringify({ version: 1, revision: randomBytes(32).toString('hex') });
          return base.platformSetting.upsert({ where: { key }, create: { key, value_json }, update: { value_json } });
        });
        const pending = Reflect.apply(targetTransaction, target, [[...input, ...markers], options]) as Promise<unknown[]>;
        return pending.then(values => values.slice(0, input.length));
      };
    }
    if (property === '$extends') return (...args: unknown[]) => wrap(Reflect.apply(Reflect.get(target, '$extends'), target, args));
    const delegate = Reflect.get(target, property);
    if (typeof property !== 'string' || property.startsWith('$') || !delegate || typeof delegate !== 'object') return typeof delegate === 'function' ? delegate.bind(target) : delegate;
    const model = property[0].toUpperCase() + property.slice(1);
    return new Proxy(delegate, { get(value, operation) {
      const method = Reflect.get(value, operation);
      if (typeof method !== 'function') return method;
      return (...args: unknown[]) => {
        const promise = Reflect.apply(method, value, args), affected = domains(model, String(operation), args[0]);
        if (affected.length && promise && typeof promise === 'object') promises.set(promise, affected);
        return promise;
      };
    } });
  } }) as T;
  const wrapped = wrap(base); installed.set(base, wrapped); installed.set(wrapped, wrapped); return wrapped;
}
