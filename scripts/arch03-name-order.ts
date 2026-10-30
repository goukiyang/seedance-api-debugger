import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { mock } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';

async function main() {
  const root = process.cwd(), source = path.resolve(process.argv[2] || '');
  assert.ok(source.startsWith(path.join(root, '.role-tests') + path.sep));
  const originalReceipt = JSON.parse(await readFile(path.join(source, 'receipt.json'), 'utf8'));
  assert.equal(originalReceipt.synthetic, true); assert.equal(originalReceipt.completed, true); assert.equal(originalReceipt.productionWrites, 0);
  const directory = await mkdtemp(path.join(root, '.role-tests/arch03-names-'));
  await copyFile(path.join(source, 'synthetic.db'), path.join(directory, 'synthetic.db'));
  for (const key of Object.keys(process.env)) if (!['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'].includes(key)) delete process.env[key];
  Object.assign(process.env, { DATABASE_URL: `file:${path.join(directory, 'synthetic.db')}`, NODE_ENV: 'test', SESSION_SECRET: randomUUID() });
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
  const require = createRequire(import.meta.url), resolver = require('node:module');
  const originalResolve = resolver._resolveFilename;
  const marker = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js');
  mock.method(resolver, '_resolveFilename', (...args: unknown[]) => args[0] === 'server-only' ? marker : originalResolve.apply(resolver, args));
  let forbiddenCalls = 0, measuring = false, largestRead = 0;
  const forbidden = () => { forbiddenCalls++; throw new Error('ARCH03 names fixture has no network or business services'); };
  mock.method(globalThis, 'fetch', forbidden); mock.method(http, 'request', forbidden); mock.method(http, 'get', forbidden); mock.method(https, 'request', forbidden); mock.method(https, 'get', forbidden);
  const { PrismaClient } = await import('@prisma/client'), { catalogDirectoryWrites } = await import('../src/lib/catalog-directory-writes');
  const base = new PrismaClient(), observed = catalogDirectoryWrites(base).$extends({ query: { async $allOperations({ args, query }) {
    const result = await query(args); if (measuring && Array.isArray(result)) largestRead = Math.max(largestRead, result.length); return result;
  } } });
  const db = observed as unknown as typeof base;
  Reflect.set(globalThis, 'prisma', db); Reflect.set(globalThis, 'prismaSqlitePragmasStarted', true);
  const startedAt = new Date().toISOString(), checks: string[] = []; let completed = false;
  try {
    const labels = ['阿', '张', '中', 'A', 'a', 'é', 'É', '图10', '图2', '九月', '😀'];
    await db.imageStudioPreset.createMany({ data: Array.from({ length: 1001 }, (_, index) => ({ id: `name-order-preset-${index}`,
      owner_id: 'catalog-gallery-publisher', scope: 'creator', name: `${labels[index % labels.length]} ${index}`, model: 'gpt-image-2',
      created_at: new Date(1700000000000 + index), updated_at: new Date(1700000000000 + index) })) });
    await db.asset.createMany({ data: Array.from({ length: 1001 }, (_, index) => ({ id: `name-order-asset-${index}`, owner_id: 'picker-directory-owner',
      type: 'image', file_name: `${labels[index % labels.length]} ${index}.png`, mime_type: 'image/png', file_size: 0,
      original_url: `/uploads/name-order-${index}.png`, created_at: new Date(1700000000000 + index) })) });
    const { queryStudioGallery } = await import('../src/lib/image-studio/gallery');
    const { readGalleryPage } = await import('../src/lib/image-studio/gallery-page');
    const actor = { id: 'catalog-writer-fixture', role: 'admin', account_type: 'internal' };
    const query = { sort: 'name' as const, page: 31, pageSize: 24, navigationOnly: false };
    const original = await queryStudioGallery(actor, query);
    measuring = true; const gallery = await readGalleryPage(db, actor, query); measuring = false;
    assert.deepEqual(gallery.items, original.items); assert.equal(gallery.total, original.total); checks.push('gallery_zh_cn_name_page_equals_original_over_multiple_sort_runs');
    const { NextRequest } = require('next/server') as typeof import('next/server');
    const { requestAsyncStorage } = require('next/dist/client/components/request-async-storage.external') as typeof import('next/dist/client/components/request-async-storage.external');
    const { RequestCookies } = require('next/dist/compiled/@edge-runtime/cookies') as typeof import('next/dist/compiled/@edge-runtime/cookies');
    const { createSession } = await import('../src/lib/auth/session');
    const pickerRoute = await import('../src/app/api/assets/picker/route'), libraryRoute = await import('../src/app/api/assets/library/route');
    const token = await createSession('picker-directory-owner');
    const invoke = async (kind: 'picker' | 'library', params: URLSearchParams) => {
      const headers = new Headers({ host: 'arch03-fixture.invalid', Cookie: `session=${token}` });
      const request = new NextRequest(`http://arch03-fixture.invalid/api/assets/${kind}?${params}`, { headers });
      const store = { headers, cookies: new RequestCookies(headers) } as unknown as Parameters<typeof requestAsyncStorage.run>[0];
      const response = await requestAsyncStorage.run(store, () => (kind === 'picker' ? pickerRoute : libraryRoute).GET(request));
      assert.equal(response.status, 200, await response.clone().text()); return response.json();
    };
    const { readPickerDirectory } = await import('../src/lib/assets/picker-directory');
    const user = await db.user.findUniqueOrThrow({ where: { id: 'picker-directory-owner' } });
    const viewer = { ...user, role: 'user' as const, account_type: 'internal' as const, status: 'active' as const };
    const pickerQuery = new URLSearchParams('scope=mine&types=image&target=image-studio&sort=name');
    const pickerOriginal = await invoke('picker', pickerQuery);
    measuring = true; const picker = await readPickerDirectory(db, viewer, pickerQuery, null); measuring = false;
    assert.deepEqual(picker.keys, pickerOriginal.items.slice(0, 24).map((item: { identity: string }) => item.identity));
    const afterQuery = new URLSearchParams(pickerQuery); afterQuery.set('after', picker.nextCursor!); afterQuery.set('page', '2');
    const afterOriginal = await invoke('picker', afterQuery);
    measuring = true; const after = await readPickerDirectory(db, viewer, afterQuery, null); measuring = false;
    assert.deepEqual(after.keys, afterOriginal.items.slice(0, 24).map((item: { identity: string }) => item.identity));
    checks.push('picker_zh_cn_names_and_after_cursor_keep_original_order');
    const { readLibraryDirectory } = await import('../src/lib/assets/library-directory');
    await db.user.update({ where: { id: 'catalog-gallery-publisher' }, data: { name: '阿 作者' } });
    await db.project.update({ where: { id: 'picker-project-active' }, data: { name: '张 项目' } });
    for (const sort of ['project', 'user']) {
      const params = new URLSearchParams({ type: 'all', scope: 'history', status: 'all', sort, page: '2', limit: '24', include_uploads: 'true', include_generated: 'true', collapse_multiview: '1' });
      const reference = await invoke('library', params);
      measuring = true; const page = await readLibraryDirectory(db, viewer, { type: 'all', scope: 'history', status: 'all', sort, page: 2, limit: 24, includeUploads: true,
        includeGenerated: true, collapseMultiview: true, multiviewOutputsOnly: false, projectId: null, ownerUserId: null, keyword: null, enhance: 'none' }); measuring = false;
      assert.deepEqual(page.keys, reference.items.map((item: { id: string }) => item.id)); assert.equal(page.total, reference.pagination.total);
    }
    checks.push('library_project_and_user_zh_cn_order_equals_original');
    assert.ok(largestRead <= 500, `A name reader returned ${largestRead} rows at once`); assert.equal(forbiddenCalls, 0); completed = true;
  } finally {
    await base.$disconnect(); mock.restoreAll();
    const files = ['src/lib/assets/catalog-batches.ts', 'src/lib/image-studio/gallery-directory-sql.ts', 'src/lib/assets/picker-directory.ts', 'src/lib/assets/library-directory.ts', 'src/lib/usage/row-spool.ts'];
    const sourceSha256 = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
    const receipt = path.join(directory, 'receipt.json');
    await writeFile(receipt, JSON.stringify({ schema: 'arch03-name-order.v1', startedAt, finishedAt: new Date().toISOString(), source: path.basename(source), checks,
      sourceSha256, largestRead, completed, synthetic: true, productionWrites: 0, forbiddenCalls, paidRequests: 0, browserRuns: 0,
      boundary: 'Names are processed in bounded batches and sorted in private request-local files; total work and temporary bytes still grow with candidate count.' }, null, 2), { mode: 0o600 });
    console.log(`ARCH03 name order receipt: ${receipt}`);
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
