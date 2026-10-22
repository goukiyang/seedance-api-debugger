import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = realpathSync(process.cwd());
const destination = path.resolve(process.argv[2] || '');
assert.ok(destination.startsWith(path.join(root, '.role-tests') + path.sep));
const require = createRequire(import.meta.url);
const ts = require('typescript');
const plain = value => JSON.parse(JSON.stringify(value));
const sources = ['scripts/projects-design-alignment-engineering.mjs', 'src/lib/projects/album-projection.ts',
  'src/lib/reference-albums/permissions.ts', 'src/app/api/projects/[id]/route.ts',
  'src/app/collections/ReferenceAlbumsClient.tsx', 'src/app/collections/ReferenceAlbumsClient.module.css',
  'src/app/projects/page.tsx', 'src/app/projects/[id]/page.tsx', 'src/app/projects/Projects.module.css',
  'src/components/projects/ProjectFilters.tsx', 'src/components/usage/UsageWorkspace.tsx',
  'src/components/usage/UsageWorkspace.module.css', 'src/app/tasks/[id]/TaskResult.module.css',
  'src/app/tasks/[id]/page.tsx', 'src/components/AppShell.tsx', 'src/app/globals.css',
  'src/lib/release.ts', 'src/components/ReleaseNotice.tsx'];
let allowed = true;
let reads = 0;
const visible = { asset: { status: 'visible-fixture' } };
const album = { id: 'album1', project_id: 'team', album_type: 'project', visibility: 'project', status: 'active',
  owner_user_id: 'other', name: 'Fixture', description: null, updated_at: new Date(0), cover_image_id: 'cover1',
  shares: [], project: { status: 'active' }, images: ['image1', 'image2', 'image3', 'image4'].map(id => ({ id })), _count: { images: 9 } };
let covers = [{ id: 'cover1', album_id: 'album1' }];
const database = {
  referenceAlbum: { findMany: async args => {
    reads++;
    assert.equal(args.take, 20); assert.equal(args.skip, 20);
    assert.deepEqual(plain(args.where), { project_id: 'team', status: { not: 'deleted' } });
    assert.equal(args.include.images.take, 4);
    assert.deepEqual(plain(args.include.images.where), { status: 'active', AND: [visible] });
    assert.deepEqual(args.include._count.select.images.where, args.include.images.where);
    return [album];
  } },
  referenceImage: { findMany: async args => {
    reads++; assert.equal(args.take, 20);
    assert.deepEqual(plain(args.where), { id: { in: ['cover1'] }, status: 'active', AND: [visible] });
    return covers;
  } },
};
function load(file, bindings) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: file,
  }).outputText;
  vm.runInNewContext(compiled, { module, exports: module.exports, require: id => {
    assert.ok(Object.hasOwn(bindings, id), `Unexpected dependency: ${id}`); return bindings[id];
  }, Date, Set }, { filename: file });
  return module.exports;
}
const auth = { AuthError: class extends Error {} };
const permissions = load('src/lib/reference-albums/permissions.ts', {
  '@/lib/prisma': { prisma: database }, '@/lib/auth/session': auth,
  '@/lib/projects/permissions': { getProjectAccess: async () => ({ canView: allowed, canGenerate: false, canManageAssets: false, role: 'viewer' }) },
  '@/lib/image-studio/protected-assets': {},
});
const { readProjectAlbumPage } = load('src/lib/projects/album-projection.ts', {
  '@/lib/prisma': { prisma: database }, '@/lib/reference-albums/permissions': permissions,
  '@/lib/image-studio/protected-assets': { studioVisibleReferenceWhere: async () => visible },
});
const user = { id: 'self', role: 'user', status: 'active', account_type: 'internal' };
const first = await readProjectAlbumPage(user, 'team', 20);
assert.deepEqual(JSON.parse(JSON.stringify(first[0].thumbnail_urls)), ['cover1', 'image1', 'image2', 'image3'].map(id => `/api/reference-images/${id}/content?variant=thumbnail`));
assert.equal(first[0].image_count, 9);
assert.equal(reads, 2);
assert.equal(first[0].owner_user_id, undefined); assert.equal(first[0].shares, undefined);
covers = [{ id: 'cover1', album_id: 'different-album' }];
const foreign = await readProjectAlbumPage(user, 'team', 20);
assert.ok(foreign[0].thumbnail_urls.every(url => !url.includes('cover1')));
allowed = false;
assert.equal((await readProjectAlbumPage(user, 'team', 20)).length, 0);
allowed = true; album.images = []; covers = []; album._count.images = 0;
const empty = await readProjectAlbumPage(user, 'team', 20);
assert.equal(empty[0].image_count, 0); assert.equal(empty[0].thumbnail_urls.length, 0);
writeFileSync(destination, JSON.stringify({ schema: 'projects-design-alignment-engineering.v1', completed: true, synthetic: true,
  applicationDatabaseOpened: false, productionWrites: 0, forbiddenCalls: 0, paidRequests: 0, browserRuns: 0,
  checks: ['bounded_page_and_visible_active_images_and_count', 'legal_cover_first_and_four_maximum',
    'foreign_album_cover_rejected', 'real_album_permission_denial_omits_projection', 'empty_visible_set_has_no_fabricated_cover'],
  sourceSha256: Object.fromEntries(sources.map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')])),
  scope: 'Isolated actual album projection and permission module; no application database, browser or functional acceptance' }), { flag: 'wx', mode: 0o600 });
console.log(`PROJECTS_DESIGN_ENGINEERING_RECEIPT=${destination}`);
