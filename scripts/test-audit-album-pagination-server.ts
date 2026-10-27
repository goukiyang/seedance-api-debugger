import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { mock } from 'node:test';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

async function main() {
  const root = process.cwd(), run = process.env.MEDIA_FIXTURE_RUN_ID || '';
  assert.match(run, /^[a-zA-Z0-9_-]{1,80}$/);
  const directory = path.join(root, '.role-tests/media-fixtures', run);
  assert.equal(process.env.DATABASE_URL, `file:${directory}/audit-media.db`, 'Only newly prepared isolated synthetic fixture');
  const evidence = path.join(directory, 'audit-album-pagination.json');
  assert(!existsSync(evidence), 'Preserve previous evidence; prepare a new run ID');
  Object.assign(process.env, { NODE_ENV: 'test', SESSION_SECRET: 'synthetic-pagination-master-not-production', FEISHU_ALLOWED_TENANT_KEY: 'synthetic-tenant' });
  delete process.env.MEDIA_SIGNATURE_SECRET; delete process.env.SESSION_DIGEST_SECRET;
  process.env.MEDIA_DATA_ROOT = path.join(directory, 'media-root');
  global.fetch = async () => { throw new Error('No external calls in pagination fixture'); };
  Object.assign(globalThis, { AsyncLocalStorage });
  const require = createRequire(path.join(root, 'package.json')), resolver = require('node:module'), original = resolver._resolveFilename;
  mock.method(resolver, '_resolveFilename', function (this: unknown, name: string, ...args: unknown[]) {
    return name === 'server-only' ? require.resolve('next/dist/compiled/server-only/empty.js') : Reflect.apply(original, this, [name, ...args]);
  });
  const { prisma } = await import('../src/lib/prisma');
  const { NextRequest } = await import('next/server');
  const session = await import('../src/lib/auth/session');
  const { requestAsyncStorage } = await import('./fixtures/next-request-context');
  const images = await import('../src/app/api/reference-albums/[id]/images/route');
  const detail = await import('../src/app/api/reference-albums/[id]/route');
  const list = await import('../src/app/api/reference-albums/route');
  const results: Array<{ name: string; ok: boolean }> = [];
  try {
    const owner = await prisma.user.create({ data: { username: 'page83-owner', name: 'Synthetic paging', email: 'page83@example.invalid', password_hash: 'unusable', status: 'active' } });
    const other = await prisma.user.create({ data: { username: 'page83-other', name: 'Synthetic other', email: 'page83-other@example.invalid', password_hash: 'unusable', status: 'active' } });
    const album = await prisma.referenceAlbum.create({ data: { id: 'page83-album', owner_user_id: owner.id, name: 'Synthetic1000', album_type: 'personal' } });
    const otherAlbum = await prisma.referenceAlbum.create({ data: { id: 'page83-other-album', owner_user_id: owner.id, name: 'Synthetic second', album_type: 'personal' } });
    // Sequential chunks only; no Prisma concurrency or long write transaction.
    for (let i = 0; i < 1150; i += 50) await prisma.referenceImage.createMany({ data: Array.from({ length: Math.min(50, 1150 - i) }, (_, offset) => {
      const n = i + offset;
      return { id: `page83-image-${String(n).padStart(4, '0')}`, album_id: album.id, owner_user_id: owner.id,
        sort_order: n < 150 ? -1 : n % 7, created_at: new Date(1700000000000), url: '/uploads/assets/page83-synthetic-no-file.png',
        rights_ceiling: n < 150 ? JSON.stringify({ view: false, use: false, copy: false, download: false, viewSource: false, edit: false }) : null };
    }) });
    const tokens = new Map([[owner.id, await session.createSession(owner.id)], [other.id, await session.createSession(other.id)]]);
    const as = <T>(id: string, call: () => Promise<T>) => requestAsyncStorage.run({ headers: new Headers({ cookie: `${session.SESSION_COOKIE}=${tokens.get(id)}` }) }, call);
    const get = (cursor?: string, id = album.id, account = owner.id) => as(account, () => images.GET(new NextRequest(`http://synthetic.invalid/api/reference-albums/${id}/images?limit=73${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`), { params: Promise.resolve({ id }) }));
    const ids: string[] = []; let cursor: string | undefined, firstCursor = '';
    do {
      const response = await get(cursor); assert.equal(response.status, 200); const data = await response.json();
      assert(data.images.length <= 73); assert.equal(data.pagination.total, 1000);
      assert(data.images.every((image: { sort_order: number }) => image.sort_order >= 0));
      ids.push(...data.images.map((image: { id: string }) => image.id)); cursor = data.pagination.nextCursor || undefined; firstCursor ||= cursor || '';
    } while (cursor);
    assert.equal(ids.length, 1000); assert.equal(new Set(ids).size, 1000); results.push({ name: 'actual Prisma/handler1000 authorized images complete/no duplicates;150 denied rows before page', ok: true });
    assert.equal((await get(`${firstCursor}x`)).status, 400);
    assert.equal((await get(firstCursor, otherAlbum.id)).status, 400);
    // Give the other identity view permission so this checks cursor binding, not just album denial.
    await prisma.albumShare.create({ data: { album_id: album.id, grantee_type: 'user', grantee_id: other.id, created_by: owner.id, permissions_json: '{"view":true,"use":true}' } });
    assert.equal((await get(firstCursor, album.id, other.id)).status, 400); results.push({ name: 'tampered/cross-album/cross-account cursor rejected', ok: true });
    const first = await (await get()).json();
    await prisma.referenceImage.update({ where: { id: first.images.at(-1).id }, data: { status: 'deleted' } });
    assert.equal((await get(first.pagination.nextCursor)).status, 409); results.push({ name: 'deleted cursor anchor rejected', ok: true });
    const response = await as(owner.id, () => detail.GET(new NextRequest(`http://synthetic.invalid/api/reference-albums/${album.id}?limit=13`), { params: Promise.resolve({ id: album.id }) }));
    const payload = await response.json(); assert.equal(response.status, 200); assert.equal(payload.images.length, 13); assert.equal(payload.album.image_count, 999); assert.equal(payload.pagination.total, 999);
    const albumList = await as(owner.id, () => list.GET(new NextRequest('http://synthetic.invalid/api/reference-albums?scope=mine&limit=1')));
    const catalog = await albumList.json(); assert.equal(albumList.status, 200); assert.equal(catalog.albums.length, 1); assert.equal(catalog.pagination.total, 2); assert.equal(catalog.pagination.hasMore, true);
    results.push({ name: 'detail exact authorized total and list pagination envelope', ok: true });
    writeFileSync(evidence, JSON.stringify({ syntheticOnly: true, actualPrisma: true, realProviderOrMedia: false, results }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ evidence, passed: results.length }));
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
