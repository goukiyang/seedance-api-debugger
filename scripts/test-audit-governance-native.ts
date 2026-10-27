import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { mock } from 'node:test';
import type { SessionUser } from '../src/lib/auth/session';
import { instrumentDatabaseQueries } from './fixtures/audit-query-instrumentation';

async function main() {
  const root = process.cwd(), run = process.env.MEDIA_FIXTURE_RUN_ID || '';
  assert.match(run, /^[a-zA-Z0-9_-]{1,80}$/);
  const directory = path.join(root, '.role-tests/media-fixtures', run), evidence = path.join(directory, 'audit-governance-native.json');
  assert.equal(process.env.DATABASE_URL, `file:${directory}/audit-media.db`);
  assert(!existsSync(evidence), 'Fresh prepared synthetic DB only; retain previous evidence');
  Object.assign(process.env, { NODE_ENV: 'test', SESSION_SECRET: 'synthetic-governance-not-production', FEISHU_ALLOWED_TENANT_KEY: 'synthetic-tenant',
    PRIVATE_PROMPTS_MIN_STATE: 'legacy-read', MEDIA_DATA_ROOT: path.join(directory, 'media-root') });
  delete process.env.MEDIA_SIGNATURE_SECRET; delete process.env.SESSION_DIGEST_SECRET; delete process.env.PRIVATE_PROMPTS_POLICY_FILE;
  global.fetch = async () => { throw new Error('No real network/provider/media in governance fixture'); };
  Object.assign(globalThis, { AsyncLocalStorage });
  const require = createRequire(path.join(root, 'package.json')), resolver = require('node:module'), original = resolver._resolveFilename;
  mock.method(resolver, '_resolveFilename', function (this: unknown, name: string, ...args: unknown[]) {
    return name === 'server-only' ? require.resolve('next/dist/compiled/server-only/empty.js') : Reflect.apply(original, this, [name, ...args]);
  });
  const { prisma } = await import('../src/lib/prisma');
  const session = await import('../src/lib/auth/session');
  const { requestAsyncStorage } = await import('./fixtures/next-request-context');
  const { NextRequest } = await import('next/server');
  const folders = await import('../src/app/api/reference-album-folders/route');
  const shares = await import('../src/app/api/reference-albums/[id]/shares/route');
  const submissions = await import('../src/app/api/admin/reference-album-submissions/route');
  const { readProjectAlbumDirectory } = await import('../src/lib/projects/album-projection');
  const collectionReads = { count: 0, unbounded: 0, maxRows: 0 };
  const models = new Set(['ReferenceAlbumFolder', 'AlbumShare', 'PublicAlbumSubmission', 'ReferenceAlbum', 'ReferenceImage', 'User']);
  // Authorization's complete relation edges are semantic inputs, not directory pages.
  // Only top-level collection reads are measured; finite id-IN metadata is bounded by the selected page.
  await instrumentDatabaseQueries(prisma, async (params, next) => {
    const measured = params.action === 'findMany' && models.has(params.model || '');
    if (measured) {
      collectionReads.count++;
      const take = params.args?.take, ids = params.args?.where?.id?.in;
      if (!(Number.isInteger(take) && take >= 1 && take <= 100 || Array.isArray(ids) && ids.length <= 100)) collectionReads.unbounded++;
    }
    const result = await next(params);
    if (measured && Array.isArray(result)) collectionReads.maxRows = Math.max(collectionReads.maxRows, result.length);
    return result;
  });
  const results: string[] = [];
  try {
    assert.equal(await prisma.user.count(), 0, 'Only a newly prepared empty synthetic DB may be populated');
    const createUser = (name: string, role = 'user') => prisma.user.create({ data: { username: `gov-${name}`, name: `Synthetic ${name}`, email: `gov-${name}@example.invalid`,
      password_hash: 'unusable', role, status: 'active', account_type: 'internal', feishu_user_id: `synthetic-${name}`, feishu_tenant_key: 'synthetic-tenant' } });
    const admin = await createUser('admin', 'admin'), otherAdmin = await createUser('other-admin', 'admin'), viewer = await createUser('viewer'), outsider = await createUser('outsider');
    const album = await prisma.referenceAlbum.create({ data: { id: 'gov-album-a', owner_user_id: admin.id, name: 'Synthetic grants' } });
    const second = await prisma.referenceAlbum.create({ data: { id: 'gov-album-b', owner_user_id: admin.id, name: 'Synthetic other' } });
    const project = await prisma.project.create({ data: { id: 'gov-project', name: 'Synthetic preview', owner_user_id: viewer.id, created_by: viewer.id } });
    const stamp = new Date('2026-01-01T00:00:00Z');
    for (let start = 0; start < 1000; start += 50) {
      await prisma.referenceAlbumFolder.createMany({ data: Array.from({ length: 50 }, (_, offset) => ({ id: `gov-folder-${String(start + offset).padStart(4, '0')}`, name: `Synthetic folder${start + offset}`, sort_order: (start + offset) % 5, created_at: stamp })) });
      await prisma.albumShare.createMany({ data: Array.from({ length: 50 }, (_, offset) => ({ id: `gov-share-${String(start + offset).padStart(4, '0')}`, album_id: album.id, grantee_type: 'user', grantee_id: `gov-synthetic-target-${start + offset}`, permissions_json: '{"view":true}', created_by: admin.id, created_at: stamp })) });
      await prisma.publicAlbumSubmission.createMany({ data: Array.from({ length: 50 }, (_, offset) => ({ id: `gov-submission-${String(start + offset).padStart(4, '0')}`, source_album_id: `gov-synthetic-source-${start + offset}`, submitted_by_user_id: viewer.id,
        name: `Synthetic pending${start + offset}`, public_folder_id: `gov-folder-${String(start + offset).padStart(4, '0')}`, created_at: stamp })) });
    }
    await prisma.referenceAlbumFolder.create({ data: { id: 'gov-deleted-folder', name: 'Synthetic deleted', status: 'deleted' } });
    await prisma.albumShare.create({ data: { id: 'gov-expired-share', album_id: album.id, grantee_type: 'user', grantee_id: 'gov-expired-target', permissions_json: '{"view":true}', created_by: admin.id, expires_at: new Date('2000-01-01') } });
    await prisma.publicAlbumSubmission.create({ data: { id: 'gov-approved-submission', source_album_id: 'gov-approved-source', submitted_by_user_id: viewer.id, name: 'Synthetic approved', status: 'approved' } });
    for (let start = 0; start < 250; start += 50) await prisma.referenceAlbum.createMany({ data: Array.from({ length: 50 }, (_, offset) => {
      const i = start + offset; return { id: `gov-project-album-${String(9999 - i).padStart(4, '0')}`, project_id: project.id,
        owner_user_id: i < 120 ? outsider.id : viewer.id, name: `Synthetic private${i}`, album_type: 'personal', visibility: 'private', updated_at: stamp };
    }) });
    const tokens = new Map<string, string>();
    for (const person of [admin, otherAdmin, viewer, outsider]) tokens.set(person.id, await session.createSession(person.id));
    const as = <T>(id: string | null, call: () => Promise<T>) => requestAsyncStorage.run({ headers: new Headers(id ? { cookie: `${session.SESSION_COOKIE}=${tokens.get(id)}` } : {}) }, call);
    const get = (kind: 'folders' | 'shares' | 'submissions', cursor = '', account: string | null = admin.id, id = album.id, status = 'pending', limit = 73, owner = '') => as(account, () => {
      const params = new URLSearchParams({ limit: String(limit), status }); if (cursor) params.set('cursor', cursor);
      const request = new NextRequest(`http://synthetic.invalid/?${params}`, { headers: owner ? { 'x-upload-owner-id': owner } : {} });
      return kind === 'folders' ? folders.GET(request) : kind === 'shares' ? shares.GET(request, { params: Promise.resolve({ id }) }) : submissions.GET(request);
    });
    for (const kind of ['folders', 'shares', 'submissions'] as const) {
      const ids: string[] = []; let cursor = '', firstCursor = '', firstAnchor = '';
      do {
        const response = await get(kind, cursor); assert.equal(response.status, 200); const data = await response.json();
        assert.equal(data.pagination.total, 1000); assert(data[kind].length <= 73);
        ids.push(...data[kind].map((row: { id: string }) => row.id)); cursor = data.pagination.nextCursor || '';
        if (!firstCursor) { firstCursor = cursor; firstAnchor = data[kind].at(-1).id; }
      } while (cursor);
      assert.equal(ids.length, 1000); assert.equal(new Set(ids).size, 1000);
      assert.equal((await get(kind, firstCursor + 'x')).status, 400);
      assert.equal((await get(kind, firstCursor, otherAdmin.id)).status, 400);
      assert.equal((await get(kind, '', admin.id, album.id, 'pending', 0)).status, 400);
      const ceiling = await get(kind, '', admin.id, album.id, 'pending', 999);
      assert.equal(ceiling.status, 200); assert.equal((await ceiling.json())[kind].length, 100);
      assert.equal((await get(kind, '', admin.id, album.id, 'pending', 73, outsider.id)).status, 409);
      assert.equal((await get(kind, '', null)).status, 401);
      if (kind === 'shares') { assert.equal((await get(kind, firstCursor, admin.id, second.id)).status, 400); await prisma.albumShare.update({ where: { id: firstAnchor }, data: { status: 'revoked' } }); }
      if (kind === 'folders') await prisma.referenceAlbumFolder.update({ where: { id: firstAnchor }, data: { status: 'deleted' } });
      if (kind === 'submissions') { assert.equal((await get(kind, firstCursor, admin.id, album.id, 'all')).status, 400); await prisma.publicAlbumSubmission.update({ where: { id: firstAnchor }, data: { status: 'approved' } }); }
      assert.equal((await get(kind, firstCursor)).status, 409);
      results.push(`${kind}:1000 complete/no duplicates/exact count, excluded inactive/expired, owner/scope/tamper/deleted-anchor/limit/auth`);
    }
    assert.equal((await get('shares', '', outsider.id)).status, 403);
    assert.equal((await get('submissions', '', viewer.id)).status, 403);
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'user' } });
    assert.equal((await get('submissions')).status, 403); results.push('fresh role and share management authorization');
    const who: SessionUser = { ...viewer, role: 'user', account_type: 'internal', status: 'active' };
    const first = await readProjectAlbumDirectory(who, project.id); assert.equal(first.total, 130); assert.equal(first.albums.length, 20); assert.equal(first.totalPages, 7);
    const last = await readProjectAlbumDirectory(who, project.id, 999); assert.equal(last.page, 7); assert.equal(last.albums.length, 10);
    const seen: string[] = [];
    for (let page = 1; page <= 7; page++) { const data = await readProjectAlbumDirectory(who, project.id, page); assert.equal(data.total, 130); assert(data.albums.every(row => row.thumbnail_urls.length <= 4)); seen.push(...data.albums.map(row => row.id)); }
    assert.equal(seen.length, 130); assert.equal(new Set(seen).size, 130); results.push('real permission function/private personal project albums:120 denied before130 authorized;20/page and exact authorized total');
    assert(collectionReads.count > 0 && collectionReads.maxRows > 0, 'Query instrumentation must observe actual collection reads and rows');
    assert.equal(collectionReads.unbounded, 0); assert(collectionReads.maxRows <= 100);
    writeFileSync(evidence, JSON.stringify({ syntheticOnly: true, actualPrismaAndHandlers: true, realMediaProviderOrBrowser: false, results, collectionReads }, null, 2), { flag: 'wx' }); console.log(evidence);
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
