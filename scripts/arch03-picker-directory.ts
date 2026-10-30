import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { Prisma, type PrismaClient } from '@prisma/client';
import { readPickerDirectory } from '../src/lib/assets/picker-directory';
import { directoryPermissionsSql } from '../src/lib/assets/directory-permissions-sql';
import type { SessionUser } from '../src/lib/auth/session';

export async function verifyPickerDirectory(db: PrismaClient, root: string) {
  const owner = 'picker-directory-owner', publisher = 'catalog-gallery-publisher';
  const actor = await db.user.create({ data: { id: owner, username: owner, email: `${owner}@example.invalid`, name: 'Picker Owner', password_hash: 'not-a-password' } });
  const user: SessionUser = { ...actor, role: 'user', account_type: 'internal', status: 'active' };
  const projects = ['active', 'archived'].map(status => ({ id: `picker-project-${status}`, name: `Picker ${status}`, type: 'team', status, owner_user_id: publisher, created_by: publisher }));
  await db.project.createMany({ data: projects });
  await db.projectMember.createMany({ data: projects.map(project => ({ project_id: project.id, user_id: owner, role: 'viewer', status: 'active', joined_by: publisher })) });
  const albums = [
    { id: 'picker-own', name: 'Own album', owner_user_id: owner, album_type: 'personal', visibility: 'private' },
    { id: 'picker-public', name: 'Public album', owner_user_id: publisher, album_type: 'public', visibility: 'public' },
    { id: 'picker-shared', name: 'Shared album', owner_user_id: publisher, album_type: 'personal', visibility: 'private' },
    { id: 'picker-denied', name: 'Denied album', owner_user_id: publisher, album_type: 'personal', visibility: 'private' },
    { id: 'picker-project', name: 'Project viewer', owner_user_id: publisher, album_type: 'project', visibility: 'project', project_id: projects[0].id },
    { id: 'picker-archived', name: 'Archived public', owner_user_id: publisher, album_type: 'project', visibility: 'public', project_id: projects[1].id },
  ];
  await db.referenceAlbum.createMany({ data: albums });
  await db.albumShare.createMany({ data: [
    { album_id: 'picker-shared', grantee_type: 'user', grantee_id: owner, created_by: publisher, permissions_json: '{"view":true,"use":true,"download":false}' },
    { album_id: 'picker-denied', grantee_type: 'user', grantee_id: owner, created_by: publisher, permissions_json: '{"view":true,"use":false,"download":true}' },
    { album_id: 'picker-project', grantee_type: 'project', grantee_id: projects[0].id, created_by: publisher, permissions_json: '{"view":true,"use":true}' },
    { album_id: 'picker-archived', grantee_type: 'user', grantee_id: owner, created_by: publisher, permissions_json: '{"view":true,"use":true,"download":true}' },
  ] });
  const assets = Array.from({ length: 65 }, (_, index) => ({ id: `picker-asset-${index}`, owner_id: index < 55 ? owner : publisher,
    file_name: `Picker ${index}.png`, type: 'image', mime_type: 'image/png', file_size: 0, original_url: `/uploads/picker-fixture-${index}.png`,
    created_at: new Date(1700000000000 + index * 1000) }));
  await db.asset.createMany({ data: assets });
  await db.referenceImage.createMany({ data: assets.map((asset, index) => ({ id: `picker-reference-${index}`, asset_id: asset.id, owner_user_id: asset.owner_id,
    album_id: index < 55 ? 'picker-own' : index % 2 ? 'picker-shared' : 'picker-public', url: asset.original_url, created_at: asset.created_at })) });
  await db.referenceImage.createMany({ data: [
    { id: 'picker-duplicate', asset_id: assets[0].id, owner_user_id: owner, album_id: 'picker-own', url: assets[0].original_url },
    { id: 'picker-standalone', owner_user_id: publisher, album_id: 'picker-shared', url: '/uploads/standalone-synthetic.png' },
    { id: 'picker-no-use', owner_user_id: publisher, album_id: 'picker-denied', url: '/uploads/denied-synthetic.png' },
  ] });
  const access = await directoryPermissionsSql(db, user);
  const permissions = await db.$queryRaw<Array<{ id: string; can_view: number; can_use: number; can_download: number }>>(Prisma.sql`WITH ${access.ctes} SELECT id, can_view, can_use, can_download FROM authorized_albums`);
  const { getAlbumByIdForAccess, getAlbumAccess } = await import('../src/lib/reference-albums/permissions');
  for (const permission of permissions) {
    const album = await getAlbumByIdForAccess(permission.id, db), original = await getAlbumAccess(user, album!, db);
    assert.deepEqual([Boolean(permission.can_view), Boolean(permission.can_use), Boolean(permission.can_download)],
      [original.permissions.view, original.permissions.use, original.permissions.download], permission.id);
  }
  const require = createRequire(import.meta.url), { NextRequest } = require('next/server') as typeof import('next/server');
  const { requestAsyncStorage } = require('next/dist/client/components/request-async-storage.external') as typeof import('next/dist/client/components/request-async-storage.external');
  const { RequestCookies } = require('next/dist/compiled/@edge-runtime/cookies') as typeof import('next/dist/compiled/@edge-runtime/cookies');
  const { createSession } = require('../src/lib/auth/session') as typeof import('../src/lib/auth/session');
  const originalRoute = require('../src/app/api/assets/picker/route') as typeof import('../src/app/api/assets/picker/route');
  const filename = path.join(root, 'src/app/api/assets/picker/route.ts');
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as typeof originalRoute };
  const fixtureRequire = (name: string) => {
    const value = require(name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : name);
    // Select only the new reader branch in this isolated DB. Authorization and all SQL stay real;
    // the production process/source capability is checked separately, never asserted by this fixture.
    return name === '@/lib/image-studio/catalog-revision' ? { ...value, catalogReaderReady: async () => true } : value;
  };
  new Function('require', 'module', 'exports', compiled)(fixtureRequire, module, module.exports);
  const token = await createSession(owner);
  const invoke = async (query: URLSearchParams, paged: boolean) => {
    query = new URLSearchParams(query); if (paged) query.set('protocol', 'catalog-paged-v2');
    const headers = new Headers({ host: 'arch03-fixture.invalid', Cookie: `session=${token}` });
    const request = new NextRequest(`http://arch03-fixture.invalid/api/assets/picker?${query}`, { headers });
    const store = { headers, cookies: new RequestCookies(headers) } as unknown as Parameters<typeof requestAsyncStorage.run>[0];
    const response = await requestAsyncStorage.run(store, () => (paged ? module.exports : originalRoute).GET(request));
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  let comparisons = 0;
  for (const scope of ['mine', 'project', 'shared', 'public']) for (const source of ['all', 'uploaded', 'generated']) {
    const query = new URLSearchParams({ scope, source, types: 'image', target: 'image-studio' });
    const legacy = await invoke(query, false), directory = await readPickerDirectory(db, user, query, null);
    assert.equal(directory.total, legacy.total, `${scope}/${source}`);
    assert.deepEqual(directory.keys, legacy.items.slice(0, 24).map((item: { identity: string }) => item.identity));
    const projected = await invoke(query, true);
    assert.deepEqual(projected.items, legacy.items.slice(0, 24));
    assert.deepEqual(projected.albums, legacy.albums);
    comparisons++;
  }
  const query = new URLSearchParams({ scope: 'mine', types: 'image', target: 'image-studio' });
  const first = await readPickerDirectory(db, user, query, null);
  assert.equal(first.keys.length, 24); assert.ok(first.hasMore);
  const second = await readPickerDirectory(db, user, new URLSearchParams({ ...Object.fromEntries(query), after: first.nextCursor!, directory_revision: first.revision, page: '2' }), null);
  assert.equal(second.keys.length, 24); assert.equal(new Set([...first.keys, ...second.keys]).size, 48);
  const exact = await readPickerDirectory(db, user, query, ['asset:picker-asset-0', 'reference_image:picker-standalone']);
  assert.deepEqual(exact.keys, ['asset:picker-asset-0']);
  const revoked = await db.albumShare.findUniqueOrThrow({ where: { album_id_grantee_type_grantee_id: { album_id: 'picker-shared', grantee_type: 'user', grantee_id: owner } } });
  await db.albumShare.update({ where: { id: revoked.id }, data: { status: 'revoked' } });
  await assert.rejects(readPickerDirectory(db, user, new URLSearchParams({ scope: 'mine', types: 'image', target: 'image-studio', directory_revision: first.revision }), null), /目录已变化/);
  assert.equal((await readPickerDirectory(db, user, new URLSearchParams('scope=shared&types=image&target=image-studio'), null)).keys.includes('reference_image:picker-standalone'), false);
  return { comparisons, realRouteProjection: true, albumPermissionMatrix: true, canonicalDedup: true, pageMaximum: 24, exactKeys: true, revokedShareInvalidates: true };
}
