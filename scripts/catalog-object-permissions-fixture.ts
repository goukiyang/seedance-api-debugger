import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { mock } from 'node:test';
import { PrismaClient, Prisma } from '@prisma/client';

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'catalog-object-permissions-'));
  const databaseUrl = `file:${path.join(scratch, 'synthetic.sqlite')}`;
  const require = createRequire(import.meta.url);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    DATABASE_URL: databaseUrl, NODE_ENV: 'test', PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' };
  execFileSync(process.execPath, [path.join(path.dirname(require.resolve('prisma/package.json')), 'build/index.js'),
    'db', 'push', '--skip-generate', '--schema', path.join(process.cwd(), 'prisma/schema.prisma')], { env, stdio: 'pipe' });
  Object.assign(process.env, { DATABASE_URL: databaseUrl, NODE_ENV: 'test', FEISHU_ALLOWED_TENANT_KEY: 'synthetic-tenant' });
  for (const key of Object.keys(process.env).filter(key => key.startsWith('PRIVATE_PROMPTS_'))) delete process.env[key];
  let networkCalls = 0;
  mock.method(globalThis, 'fetch', () => { networkCalls++; throw new Error('Network forbidden in fixture'); });
  const base = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [{ level: 'query', emit: 'event' }] });
  const queries: Array<{ query: string; params: string }> = [];
  base.$on('query', event => { queries.push({ query: event.query, params: event.params }); });
  const loader = Module as typeof Module & { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown };
  const originalLoad = loader._load;
  // Only the deployment-readiness boundary is controlled. Business readers,
  // marker writes and actor authorization below execute their real implementation.
  loader._load = function(request, parent, isMain) {
    if (parent?.filename?.endsWith('/image-studio/catalog-revision.ts') && /pricing\/runtime(?:\.ts)?$/.test(request)) {
      return { assertPricingImageConsumerReady: async () => ({ ready: true }) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const { catalogDirectoryWrites } = await import('../src/lib/catalog-directory-writes');
  const db = catalogDirectoryWrites(base);
  Reflect.set(globalThis, 'prisma', db); Reflect.set(globalThis, 'prismaSqlitePragmasStarted', true);
  const passed: string[] = [];
  try {
    const { initializeCatalogRevisions, catalogDependencyScopes, readCatalogDependencyStamp, trackCatalogDependencies } = await import('../src/lib/image-studio/catalog-revision');
    const { sharedStudioRevision, studioBindingKey, resolveSharedStudioDefinition, readSharedStudioModules, listSharedStudioCatalog } = await import('../src/lib/image-studio/shared-contract');
    const { readableStudioCoverIds, StudioAssetProtectionError } = await import('../src/lib/image-studio/protected-assets');
    const { studioModuleDTOForUser } = await import('../src/lib/image-studio/modules');
    const { queryStudioGallery } = await import('../src/lib/image-studio/gallery');
    const { platformSettingPrefix } = await import('../src/lib/platform-setting-prefix');
    const { studioReproductionBindingWhere } = await import('../src/lib/image-studio/reproduction-record-keys');
    loader._load = originalLoad;
    const actor = await db.user.create({ data: { id: 'fixture-reader', name: 'Reader', username: 'fixture-reader', email: 'reader@example.invalid',
      password_hash: 'synthetic', role: 'user', account_type: 'internal', feishu_user_id: 'synthetic-reader', feishu_tenant_key: 'synthetic-tenant' } });
    await db.imageStudioPreset.createMany({ data: ['active', 'unrelated'].map(id => ({ id: `fixture-${id}`, owner_id: 'fixture-publisher',
      scope: 'creator', is_shared: true, name: id, model: 'gpt-image-2' })) });
    await db.imageStudioModule.create({ data: { id: 'fixture-module', owner_id: actor.id, source_preset_id: 'fixture-active' } });
    const setting = (key: string, value: unknown) => db.platformSetting.upsert({ where: { key },
      create: { key, value_json: JSON.stringify(value) }, update: { value_json: JSON.stringify(value) } });
    await setting(studioBindingKey('fixture-module'), { protocol: 'shared-live-v1', ownerId: actor.id, presetId: 'fixture-active', mode: 'live' });
    await initializeCatalogRevisions(db);
    let sourceReads = 0;
    base.$use(async (params, next) => { if (params.model === 'ImageStudioPreset' && params.action.startsWith('find')) sourceReads++; return next(params); });
    const revision = () => sharedStudioRevision(actor, 'fixture-active', 'fixture-module', true);
    const first = await revision(); assert.equal(first.activeAvailable, true, JSON.stringify(first));
    const afterFirst = sourceReads;
    assert.ok(afterFirst > 0);
    assert.deepEqual(await revision(), first); assert.equal(sourceReads, afterFirst);
    passed.push('unchanged_active_revision_reuses_authorized_projection');
    await db.imageStudioPreset.update({ where: { id: 'fixture-unrelated' }, data: { name: 'Unrelated changed' } });
    const unrelated = await revision(); assert.equal(unrelated.activeDefinitionToken, first.activeDefinitionToken);
    assert.equal(sourceReads, afterFirst); passed.push('unrelated_object_change_does_not_resolve_active_dependencies');
    await setting('studio_fixed_references_v1:preset:fixture-active', { ownerId: 'fixture-publisher', references: [] });
    const fixed = await revision(); assert.equal(fixed.activeAvailable, true); assert.notEqual(fixed.activeDefinitionToken, first.activeDefinitionToken);
    assert.ok(sourceReads > afterFirst); passed.push('fixed_reference_dependency_change_recomputes_active_projection');
    const styleId = '00000000-0000-4000-8000-000000000001';
    await db.asset.create({ data: { id: 'fixture-style-reference', owner_id: 'fixture-publisher', type: 'image',
      file_name: 'style.png', mime_type: 'image/png', file_size: 0, original_url: '/uploads/fixture-style-reference.png' } });
    const selectedStyle = { id: styleId, ownerId: 'fixture-publisher', name: 'Synthetic selected style', coverAssetId: 'fixture-style-reference',
      references: [{ assetId: 'fixture-style-reference', note: '' }], revision: 1, shared: true };
    await setting(`studio_style_group_v1:${styleId}`, selectedStyle);
    await setting('studio_style_preset_selection_v1:fixture-active', { ownerId: 'fixture-publisher', ids: [styleId] });
    assert.equal((await revision()).activeAvailable, true);
    await setting(`studio_style_group_v1:${styleId}`, { ...selectedStyle, shared: false, revision: 2 });
    assert.equal((await revision()).activeAvailable, false);
    await setting(`studio_style_group_v1:${styleId}`, { ...selectedStyle, revision: 3 });
    assert.equal((await revision()).activeAvailable, true);
    passed.push('selected_style_withdrawal_invalidates_cached_availability');
    await db.asset.update({ where: { id: 'fixture-style-reference' }, data: { status: 'hidden' } });
    assert.equal((await revision()).activeAvailable, false);
    await db.asset.update({ where: { id: 'fixture-style-reference' }, data: { status: 'active' } });
    assert.equal((await revision()).activeAvailable, true);
    passed.push('dependency_asset_availability_invalidates_cached_projection');
    await setting('studio_skill_selection_v1:preset:fixture-active', { ownerId: 'fixture-publisher', ids: [styleId] });
    assert.equal((await revision()).activeAvailable, false);
    await setting('studio_skill_selection_v1:preset:fixture-active', { ownerId: 'fixture-publisher', ids: [] });
    assert.equal((await revision()).activeAvailable, true);
    passed.push('private_skill_selection_never_reuses_a_previously_available_projection');
    await db.imageStudioPreset.update({ where: { id: 'fixture-active' }, data: { is_shared: false } });
    const revoked = await revision(); assert.equal(revoked.activeAvailable, false); assert.equal(revoked.activeState?.reasonCode, 'source-withdrawn');
    passed.push('source_withdrawal_immediately_revokes_cached_projection');
    await db.imageStudioPreset.update({ where: { id: 'fixture-active' }, data: { is_shared: true } });
    assert.equal((await revision()).activeAvailable, true);
    await db.user.update({ where: { id: actor.id }, data: { status: 'disabled' } });
    await assert.rejects(revision(), { status: 403 });
    await db.user.update({ where: { id: actor.id }, data: { status: 'active' } });
    passed.push('fresh_actor_authorization_is_never_reused');
    const coldModule = await studioModuleDTOForUser(actor, 'fixture-module');
    assert.match(coldModule.moduleContextVersion || '', /^[A-Z0-9]{5}$/);
    const contextMappings = await db.platformSetting.findMany({ where: { OR: [
      { key: { startsWith: 'studio_context_hash_v1:' } }, { key: { startsWith: 'studio_context_code_v1:' } },
    ] } });
    assert.equal(contextMappings.length, 2);
    const emptyContextHash = createHash('sha256').update('').digest('hex');
    assert.deepEqual(JSON.parse(contextMappings.find(row => row.key === `studio_context_hash_v1:${emptyContextHash}`)!.value_json),
      { code: coldModule.moduleContextVersion });
    assert.deepEqual(JSON.parse(contextMappings.find(row => row.key === `studio_context_code_v1:${coldModule.moduleContextVersion}`)!.value_json),
      { hash: emptyContextHash });
    passed.push('first_module_display_retains_existing_atomic_context_code_allocation');
    const beforeConsumers = queries.length;
    assert.equal((await resolveSharedStudioDefinition(actor, 'fixture-active')).definition.intent.presetId, 'fixture-active');
    assert.ok((await readSharedStudioModules(actor.id, ['fixture-module'])).get('fixture-module')?.resolved);
    assert.ok((await listSharedStudioCatalog(actor)).items.some(item => item.presetId === 'fixture-active'));
    assert.equal((await sharedStudioRevision(actor, 'fixture-active', 'fixture-module', false)).activeAvailable, true);
    assert.equal((await studioModuleDTOForUser(actor, 'fixture-module')).moduleContextVersion, coldModule.moduleContextVersion);
    const gallery = await queryStudioGallery(actor, { pageSize: 12 });
    assert.ok(gallery.navigation.length > 0);
    assert.ok(!queries.slice(beforeConsumers).some(query => /^BEGIN|^INSERT|^UPDATE|^DELETE/.test(query.query)),
      'Actual display readers must not enter Prisma writer transactions or mutate configuration');
    passed.push('actual_shared_definition_modules_catalog_revision_module_display_and_gallery_use_read_snapshot_without_writer_transactions');
    assert.deepEqual(catalogDependencyScopes('CreditLedger', { data: { id: 'x' } }), []);
    assert.deepEqual(catalogDependencyScopes('User', { where: { id: actor.id }, data: { last_login_at: new Date() } }), []);
    assert.deepEqual(catalogDependencyScopes('PlatformSetting', { data: { key: 'image_billing_quote_v1:irrelevant', value_json: '{}' } }), []);
    const scopes = new Set<string>();
    const tracked = trackCatalogDependencies(db, scopes);
    await tracked.imageStudioPreset.findUnique({ where: { id: 'missing-fixture' } });
    const stamp = await readCatalogDependencyStamp(db, scopes);
    await db.imageStudioPreset.updateMany({ where: { name: 'Unrelated changed' }, data: { name: 'Changed by broad filter' } });
    assert.notEqual(await readCatalogDependencyStamp(db, scopes), stamp);
    const unsupported = new Set<string>();
    await trackCatalogDependencies(db, unsupported).platformSetting.findUnique({ where: { key: 'not-a-template-input' } });
    assert.ok(unsupported.has('uncacheable')); passed.push('bulk_write_guards_and_uncovered_inputs_prevent_stale_cache_without_unrelated_markers');

    const asset = (id: string, url = `/uploads/${id}.png`) => ({ id, owner_id: actor.id, type: 'image', file_name: 'fixture.png',
      mime_type: 'image/png', file_size: 0, original_url: url });
    const covers = ['ordinary', 'private', 'own-style', 'legacy', 'overflow'].map(id => asset(`fixture-${id}`));
    await db.asset.createMany({ data: covers });
    await db.asset.create({ data: asset('fixture-private-alias', 'https://sd2.youdoodesign.com/uploads/fixture-private.png?old=1') });
    await setting('studio_fixed_references_v1:preset:private', { ownerId: 'someone', references: [{ assetId: 'fixture-private-alias', note: '' }] });
    await setting('studio_style_group_v1:own-style', { ownerId: actor.id, references: [{ assetId: 'fixture-own-style', note: '' }] });
    await setting('studio_shared_reproduction_v1:history', { sourceOwnerId: 'someone', templateFixedReferences: [{ assetId: 'fixture-legacy', note: '' }] });
    await db.platformSetting.createMany({ data: Array.from({ length: 300 }, (_, i) => ({ key: `studio_fixed_references_v1:preset:unrelated-${i}`,
      value_json: JSON.stringify({ ownerId: 'other', references: [{ assetId: 'nonexistent-unrelated', note: '' }] }) })) });
    await setting('studio_fixed_references_v1:preset:bad-unrelated-owner', { references: [{ assetId: 'nonexistent-unrelated', note: '' }] });
    assert.deepEqual(Array.from(await readableStudioCoverIds(actor, covers)).sort(), ['fixture-ordinary', 'fixture-overflow', 'fixture-own-style']);
    passed.push('target_file_alias_modern_legacy_and_own_style_permissions_ignore_unrelated_growth_and_bad_owner');
    await db.platformSetting.createMany({ data: Array.from({ length: 257 }, (_, i) => ({ key: `studio_style_group_v1:overflow-${i}`,
      value_json: JSON.stringify({ ownerId: actor.id, references: [{ assetId: 'fixture-overflow', note: '' }] }) })) });
    assert.deepEqual(Array.from(await readableStudioCoverIds(actor, covers)).sort(), ['fixture-ordinary', 'fixture-own-style']);
    passed.push('reference_budget_is_per_target_and_does_not_hide_other_covers');
    await db.platformSetting.create({ data: { key: 'studio_shared_reproduction_v1:unassignable', value_json: '{broken' } });
    await assert.rejects(readableStudioCoverIds(actor, covers), StudioAssetProtectionError);
    await db.platformSetting.delete({ where: { key: 'studio_shared_reproduction_v1:unassignable' } });
    passed.push('unassignable_corrupt_legacy_still_fails_closed');
    await setting('studio_shared_reproduction_v1:workspace:metadata', { taskSettings: {} });
    await setting('Studio_shared_reproduction_v1:wrong-case', { templateFixedReferences: [] });
    await setting('studio_shared_reproduction_v1:UPPERCASE-ID', { sourceOwnerId: 'x', templateFixedReferences: [] });
    const historical = await db.platformSetting.findMany({ where: studioReproductionBindingWhere, select: { key: true } });
    assert.ok(historical.some(row => row.key.endsWith(':UPPERCASE-ID')));
    assert.ok(!historical.some(row => row.key.includes(':workspace:') || row.key.startsWith('Studio_')));
    await setting('studio_fixed_references_v1:module:OWNER-Mixed:Old-ID', { ownerId: 'OWNER-Mixed', references: [] });
    await setting('studio_fixed_references_v1;outside', { ownerId: 'outside', references: [] });
    queries.length = 0;
    const prefixRows = await db.platformSetting.findMany({ where: { key: platformSettingPrefix('studio_fixed_references_v1:') }, select: { key: true } });
    assert.ok(prefixRows.some(row => row.key.endsWith(':OWNER-Mixed:Old-ID')));
    assert.ok(!prefixRows.some(row => row.key.endsWith(';outside')));
    const prefixQuery = queries.find(row => row.query.startsWith('SELECT') && row.query.includes('PlatformSetting'))!;
    assert.ok(prefixQuery.query.includes('>=') && prefixQuery.query.includes('<') && !prefixQuery.query.includes('LIKE'));
    const plan = await db.$queryRawUnsafe<Array<{ detail: string }>>(`EXPLAIN QUERY PLAN ${prefixQuery.query}`, ...JSON.parse(prefixQuery.params));
    assert.ok(plan.some(row => row.detail.includes('SEARCH') && row.detail.includes('key')));
    passed.push('real_prisma_binary_prefix_query_uses_existing_key_index_and_preserves_namespace_boundaries');
    assert.equal(networkCalls, 0);
    console.log(JSON.stringify({ passed: true, checks: passed, prefixPlan: plan.map(row => row.detail), synthetic: true, productionWrites: 0, networkCalls }));
  } finally { loader._load = originalLoad; mock.restoreAll(); await base.$disconnect(); rmSync(scratch, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
