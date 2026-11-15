import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mock } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';

async function main() {
  const root = process.cwd(), scratch = path.join(root, '.role-tests');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(path.join(scratch, 'template-tags-'));
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: `file:${path.join(directory, 'synthetic.db')}`, SESSION_SECRET: randomUUID() };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) env[key] = process.env[key];
  const require = createRequire(import.meta.url);
  execFileSync(process.execPath, [path.join(path.dirname(require.resolve('prisma/package.json')), 'build/index.js'), 'db', 'push', '--skip-generate',
    '--schema', path.join(root, 'prisma/schema.prisma')], { cwd: directory, env, timeout: 120000, stdio: 'pipe' });
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
  const resolver = require('node:module'), originalResolve = resolver._resolveFilename;
  const marker = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js');
  mock.method(resolver, '_resolveFilename', (...args: unknown[]) => args[0] === 'server-only' ? marker : originalResolve.apply(resolver, args));
  mock.method(globalThis, 'fetch', () => { throw new Error('Template tags engineering cannot call external services'); });
  const { PrismaClient } = await import('@prisma/client');
  const { catalogDirectoryWrites } = await import('../src/lib/catalog-directory-writes');
  const base = new PrismaClient(), db = catalogDirectoryWrites(base);
  Reflect.set(globalThis, 'prisma', db); Reflect.set(globalThis, 'prismaSqlitePragmasStarted', true);
  for (const file of ['prisma/schema.prisma', 'scripts/usage-sqlite-reader.py']) {
    const destination = path.join(directory, file); mkdirSync(path.dirname(destination), { recursive: true }); copyFileSync(path.join(root, file), destination);
  }
  const { saveTemplateTags } = await import('../src/lib/image-studio/template-tags.server');
  const { queryStudioGallery } = await import('../src/lib/image-studio/gallery');
  const { readGalleryPage } = await import('../src/lib/image-studio/gallery-page');
  const { readCatalogRevision } = await import('../src/lib/image-studio/catalog-revision');
  const checks: string[] = [];
  process.chdir(directory);
  try {
    for (const id of ['tag-owner', 'tag-other']) await db.user.create({ data: { id, username: id, email: `${id}@example.invalid`,
      name: id, password_hash: 'not-a-password', account_type: 'internal', role: 'admin' } });
    const actor = { id: 'tag-owner', role: 'admin', account_type: 'internal' };
    await db.imageStudioPreset.createMany({ data: Array.from({ length: 31 }, (_, index) => ({ id: `tag-preset-${index}`,
      owner_id: index === 30 ? 'tag-other' : actor.id, scope: 'creator', name: `模板 ${index}`, model: 'gpt-image-2',
      is_shared: index !== 30, group_name: '真实目录', prompt: 'KEEP_ORIGINAL_PROMPT', created_at: new Date(1700000000000 + index) })) });
    const originals = await db.imageStudioPreset.findMany({ orderBy: { id: 'asc' } });
    const before = await readCatalogRevision(db, 'templates');
    const first = { contentKey: 'image_template:tag-preset-0', requestId: randomUUID(), expectedRevision: 0, tags: [' 电商 ', '海报', '电商'] };
    const saved = await saveTemplateTags(actor, first);
    assert.deepEqual(saved.tags, ['电商', '海报']); assert.equal(saved.revision, 1);
    assert.notEqual(await readCatalogRevision(db, 'templates'), before);
    assert.deepEqual(await saveTemplateTags(actor, first), saved);
    await assert.rejects(saveTemplateTags(actor, { ...first, tags: ['角色'] }), { status: 409 });
    await assert.rejects(saveTemplateTags(actor, { ...first, requestId: randomUUID() }), { status: 409 });
    checks.push('persistent_normalized_tags_original_request_idempotence_and_stale_edit');
    for (const contentKey of ['image_template:tag-preset-30', 'image_module:not-mine']) {
      await assert.rejects(saveTemplateTags(actor, { ...first, contentKey, requestId: randomUUID() }), { status: 403 });
    }
    await assert.rejects(saveTemplateTags(actor, { ...first, requestId: randomUUID(), tags: Array(7).fill('标签') }), { status: 400 });
    checks.push('owner_permissions_and_tag_input_limits');
    await db.user.create({ data: { id: 'tag-external', name: 'External', username: 'tag-external', email: 'tag-external@example.invalid', password_hash: 'not-a-password', account_type: 'external' } });
    await assert.rejects(saveTemplateTags({ id: 'tag-external', role: 'user', account_type: 'external' }, { ...first, requestId: randomUUID() }), { status: 403 });
    for (let index = 1; index < 15; index++) await saveTemplateTags(actor, { ...first, contentKey: `image_template:tag-preset-${index}`,
      requestId: randomUUID(), tags: ['电商', index % 2 ? '人物' : '海报'] });
    await saveTemplateTags({ ...actor, id: 'tag-other' }, { ...first, contentKey: 'image_template:tag-preset-30', requestId: randomUUID(), tags: ['私有标签'] });
    for (const sort of ['created', 'updated', 'likes', 'recent', 'directory', 'name'] as const) {
      for (const filter of [{ tag: '电商' }, { query: '海报' }, { tag: '电商', query: '人物' }, { tag: '没有这个标签' }]) {
        const input = { ...filter, sort, scope: 'all' as const, page: 2, pageSize: 12 };
        const legacy = await queryStudioGallery(actor, input), paged = await readGalleryPage(db, actor, input);
        assert.equal(paged.total, legacy.total); assert.equal(paged.page, legacy.page);
        assert.deepEqual(paged.matches.map(row => row.key), legacy.matches.slice((legacy.page - 1) * 12, legacy.page * 12).map(row => row.key));
        assert.deepEqual(paged.availableTags, legacy.availableTags); assert(!paged.availableTags?.includes('私有标签'));
        assert(paged.navigation.filter(row => row.mine && row.key.startsWith('image_template:')).every(row => row.tagsEditable));
      }
    }
    const tagged = await readGalleryPage(db, actor, { tag: '电商', pageSize: 12, page: 2 });
    assert.equal(tagged.total, 15); assert.equal(tagged.items.length, 3); assert(tagged.items.every(item => item.tags?.includes('电商')));
    checks.push('full_catalog_tag_search_and_combined_filters_before_count_and_pagination_for_all_sorts');
    checks.push('authorized_tag_facets_exclude_private_templates_and_project_saved_tags');
    const oldRevision = tagged.catalogRevision;
    await saveTemplateTags(actor, { ...first, requestId: randomUUID(), expectedRevision: 1, tags: [] });
    await assert.rejects(readGalleryPage(db, actor, { tag: '电商', pageSize: 12, page: 2, catalogRevision: oldRevision }), { status: 409 });
    assert.deepEqual(await db.imageStudioPreset.findMany({ orderBy: { id: 'asc' } }), originals);
    assert.equal(await db.imageStudioTask.count(), 0); assert.equal(await db.creditLedger.count(), 0);
    checks.push('clearing_tags_invalidates_catalog_without_changing_template_sources_or_creating_tasks');
    writeFileSync(path.join(directory, 'receipt.json'), JSON.stringify({ completed: true, synthetic: true, productionWrites: 0, checks }, null, 2));
    console.log(JSON.stringify({ completed: true, directory, checks }));
  } finally { process.chdir(root); await base.$disconnect(); mock.restoreAll(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
