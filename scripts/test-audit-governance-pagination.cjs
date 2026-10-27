'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const phase = process.env.GOVERNANCE_PHASE || 'red';
assert.match(phase, /^[a-z0-9_-]+$/i);
const root = process.cwd(), results = [], reads = [];
const user = { id: 'synthetic-manager', role: 'admin', account_type: 'internal', status: 'active' };
let session = user, mayShare = true;
const date = new Date('2026-01-01T00:00:00Z');
const makeRows = prefix => Array.from({ length: 1000 }, (_, i) => ({ id: `${prefix}-${String(i).padStart(4, '0')}`, created_at: date, updated_at: date, status: 'active' }));
let folders = makeRows('folder').map((r, i) => ({ ...r, scope: 'public', sort_order: i % 5, name: r.id }));
let shares = makeRows('share').map(r => ({ ...r, album_id: 'album-a', grantee_type: 'user', grantee_id: r.id, expires_at: null, permissions_json: '{}' }));
let submissions = makeRows('submission').map(r => ({ ...r, status: 'pending', source_album_id: r.id, submitted_by_user_id: r.id, publicFolder: null }));
const projectViewer = { ...user, id: 'synthetic-project-viewer', role: 'user' };
const projectAlbums = Array.from({ length: 250 }, (_, i) => ({ id: `project-album-${String(9999 - i).padStart(4, '0')}`, project_id: 'project-a', status: 'active', updated_at: date,
  owner_user_id: i < 120 ? 'synthetic-private-owner' : projectViewer.id, album_type: 'personal', visibility: 'private', shares: [],
  denied: i < 120, images: [{ id: `image-${i}` }], _count: { images: i + 1 }, cover_image_id: null }));
function matches(row, where) {
  return !where || Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every(w => matches(row, w));
    if (key === 'OR') return value.some(w => matches(row, w));
    if (value && typeof value === 'object' && Object.prototype.toString.call(value) !== '[object Date]') return Object.entries(value).every(([op, v]) => {
      if (op === 'gt') return row[key] > v; if (op === 'lt') return row[key] < v;
      if (op === 'not') return row[key] !== v; if (op === 'in') return v.includes(row[key]);
      throw new Error(`unsupported synthetic predicate ${op}`);
    });
    return Object.prototype.toString.call(value) === '[object Date]' ? +row[key] === +value : row[key] === value;
  });
}
function query(source, args, model) {
  reads.push({ model, take: args.take, size: args.where?.id?.in?.length });
  const rows = source.filter(r => matches(r, args.where));
  const order = Array.isArray(args.orderBy) ? args.orderBy : args.orderBy ? [args.orderBy] : [];
  rows.sort((a, b) => { for (const clause of order) for (const [key, dir] of Object.entries(clause)) {
    const cmp = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0; if (cmp) return dir === 'desc' ? -cmp : cmp;
  } return 0; });
  return Promise.resolve(rows.slice(args.skip || 0, args.take === undefined ? undefined : (args.skip || 0) + args.take));
}
const db = {
  referenceAlbumFolder: { findMany: a => query(folders, a, 'folders') },
  albumShare: { findMany: a => query(shares, a, 'shares') },
  publicAlbumSubmission: { findMany: a => query(submissions, a, 'submissions') },
  referenceAlbum: { findMany: a => query(a.where?.project_id || a.where?.AND ? projectAlbums : [], a, 'albums'), groupBy: async a => { reads.push({ model: 'counts', size: a.where.public_folder_id.in.length }); return []; } },
  referenceImage: { findMany: a => query([], a, 'images') },
  user: { findMany: a => query([], a, 'users') }, project: { findMany: a => query([], a, 'projects'),
    findUnique: async () => ({ id: 'project-a', status: 'active', members: [], invites: [], _count: { reference_albums: 250 } }) },
  $transaction: fn => fn(db),
};
class AuthError extends Error { constructor(message, status = 403) { super(message); this.status = status; } }
const cache = new Map();
function load(file) {
  const full = path.resolve(root, file); if (cache.has(full)) return cache.get(full).exports;
  const mod = { exports: {} }; cache.set(full, mod);
  const output = ts.transpileModule(fs.readFileSync(full, 'utf8'), { fileName: full, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const request = name => {
    if (name === 'next/server') return { NextResponse: { json: (data, init) => Response.json(data, init) } };
    if (name === '@/lib/prisma') return { prisma: db };
    if (name === '@/lib/auth/session') return { AuthError, getSession: async () => session };
    if (name === '@/lib/security/secrets') return { requireSecret: () => Buffer.from('synthetic-governance-key-not-production') };
    if (name === '@/lib/reference-albums/permissions') return { assertCanShareAlbum: async () => { if (!mayShare) throw new AuthError('denied', 403); },
      getAlbumAccess: (...args) => load('src/lib/reference-albums/permissions.ts').getAlbumAccess(...args), parseAlbumPermissions: () => ({ view: true }) };
    if (name === '@/lib/projects/permissions') return { getProjectAccess: async () => ({ canView: true, role: 'viewer' }),
      assertCanViewProject: async () => ({ project: { id: 'project-a' }, role: 'viewer' }),
      readProjectOperationProjection: async () => ({}), projectStatusVersion: () => 'synthetic-version' };
    if (name === '@/lib/projects/budget') return { getProjectBudgetSummary: async () => null };
    if (name === '@/lib/tasks/retention') return { USER_VISIBLE_TASK_RETENTION_STATUSES: [] };
    if (full.endsWith('/src/app/api/projects/[id]/route.ts') && ['@/lib/video-cards/summary', '@/lib/video-cards/suggestions', '@/lib/video/task-thumbnail-projection', '@/lib/provider/error-message', '@/lib/video/multiview-task-privacy', '@/lib/dto/video-task'].includes(name)) return {};
    if (name === '@/lib/access/media-policy') return {};
    if (name === '@/lib/image-studio/protected-assets') return { studioVisibleReferenceWhere: async () => ({}) };
    if (name === '@/lib/users/display') return { displayUserName: u => u.name || u.id };
    if (name === '@/lib/http/route') return { route: (_, handler) => handler };
    if (name === '@/lib/http/api-error') return { apiErrorResponse: e => Response.json({ error: e.message }, { status: e.status || 500 }) };
    if (name.startsWith('node:')) return require(name);
    const target = name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : name.startsWith('.') ? path.resolve(path.dirname(full), name) : null;
    if (target && fs.existsSync(`${target}.ts`)) return load(`${target}.ts`);
    return {};
  };
  vm.runInNewContext(`(function(require,module,exports,Buffer,URL,URLSearchParams,Response){${output}\n})`, { console, fetch: (...args) => global.fetch(...args) }, { filename: full })(request, mod, mod.exports, Buffer, URL, URLSearchParams, Response);
  return mod.exports;
}
async function test(name, fn) { try { await fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: e.message }); } }
const paths = { folders: 'reference-album-folders', shares: 'reference-albums/[id]/shares', submissions: 'admin/reference-album-submissions' };
async function get(kind, { cursor, limit = 73, id = 'album-a', status = 'pending', owner } = {}) {
  const url = new URL(`http://synthetic.invalid/api/${paths[kind]}?limit=${limit}`);
  if (cursor) url.searchParams.set('cursor', cursor); if (kind === 'submissions') url.searchParams.set('status', status);
  const response = await load(`src/app/api/${paths[kind]}/route.ts`).GET({ nextUrl: url, headers: new Headers(owner ? { 'x-upload-owner-id': owner } : {}) }, { params: Promise.resolve({ id }) });
  return { response, data: await response.clone().json() };
}
async function main() {
  for (const kind of Object.keys(paths)) await test(`actual ${kind} GET bounds first page and exposes later1000 synthetic entries`, async () => {
    const { response, data } = await get(kind); assert.equal(response.status, 200);
    assert.equal(data[kind].length, 73, `actual handler returned ${data[kind]?.length}, expected73`);
    assert.equal(data.pagination.total, 1000); assert(data.pagination.nextCursor);
  });
  await test('actual project album projection fills20 after120 denied rows', async () => {
    const list = await load('src/lib/projects/album-projection.ts').readProjectAlbumPage(projectViewer, 'project-a');
    assert.equal(list.length, 20); assert(list.every(r => !projectAlbums.find(a => a.id === r.id).denied));
  });
  await test('actual project albums GET response count agrees with visible page/count', async () => {
    const saved = session; session = projectViewer;
    try {
      const response = await load('src/app/api/projects/[id]/route.ts').GET({ nextUrl: new URL('http://synthetic.invalid/?section=albums&page=1') }, { params: Promise.resolve({ id: 'project-a' }) });
      assert.equal(response.status, 200); const data = await response.json();
      assert.equal(data.pagination.total, 130); assert.equal(data.reference_albums.length, 20);
      assert.equal(data.project._count.reference_albums, 130);
    } finally { session = saved; }
  });
  if (phase !== 'red') {
    for (const kind of Object.keys(paths)) {
      await test(`${kind}: all1000 reachable with stable ties, exact count, bounded reads and no duplicates`, async () => {
        reads.length = 0; const ids = []; let cursor; do { const { response, data } = await get(kind, { cursor }); assert.equal(response.status, 200);
          assert.equal(data.pagination.total, 1000); assert(data[kind].length <= 73); ids.push(...data[kind].map(r => r.id)); cursor = data.pagination.nextCursor;
        } while (cursor);
        assert.equal(ids.length, 1000); assert.equal(new Set(ids).size, 1000);
        assert(reads.every(r => r.take > 0 && r.take <= 100 || r.size > 0 && r.size <= 100), JSON.stringify(reads.find(r => !(r.take > 0 && r.take <= 100 || r.size > 0 && r.size <= 100))));
      });
      await test(`${kind}: owner/scope/tamper/deleted-anchor isolation and explicit bounds`, async () => {
        const { data } = await get(kind), cursor = data.pagination.nextCursor;
        assert.equal((await get(kind, { cursor: cursor + 'x' })).response.status, 400);
        user.id = 'synthetic-other'; assert.equal((await get(kind, { cursor })).response.status, 400); user.id = 'synthetic-manager';
        assert.equal((await get(kind, { owner: 'old-account' })).response.status, 409);
        if (kind === 'shares') assert.equal((await get(kind, { cursor, id: 'album-b' })).response.status, 400);
        if (kind === 'submissions') assert.equal((await get(kind, { cursor, status: 'all' })).response.status, 400);
        const anchor = data[kind].at(-1).id;
        const collection = kind === 'folders' ? folders : kind === 'shares' ? shares : submissions;
        const row = collection.find(r => r.id === anchor), saved = row.status; row.status = 'deleted';
        assert.equal((await get(kind, { cursor })).response.status, 409); row.status = saved;
        assert.equal((await get(kind, { limit: 0 })).response.status, 400);
        assert.equal((await get(kind, { limit: 'abc' })).response.status, 400);
        assert.equal((await get(kind, { limit: 999 })).data[kind].length, 100);
      });
    }
    await test('fresh identity and management authorization are checked on each request before source reads', async () => {
      session = null; for (const kind of Object.keys(paths)) assert.equal((await get(kind)).response.status, 401); session = user;
      user.role = 'user'; reads.length = 0; assert.equal((await get('submissions')).response.status, 403); assert.equal(reads.length, 0); user.role = 'admin';
      mayShare = false; reads.length = 0; assert.equal((await get('shares')).response.status, 403); assert.equal(reads.length, 0); mayShare = true;
    });
    await test('project authorized count/pages agree, preview20/thumbs4 stay bounded', async () => {
      const service = load('src/lib/projects/album-projection.ts');
      const page = await service.readProjectAlbumDirectory(projectViewer, 'project-a', 7); assert.equal(page.total, 130); assert.equal(page.page, 7); assert.equal(page.albums.length, 10);
      const outside = await service.readProjectAlbumDirectory(projectViewer, 'project-a', 999); assert.equal(outside.page, 7); assert.equal(outside.albums.length, 10);
      const first = await service.readProjectAlbumDirectory(projectViewer, 'project-a'); assert.equal(first.albums.length, 20); assert(first.albums.every(a => a.thumbnail_urls.length <= 4));
      const seen = []; for (let i = 1; i <= 7; i++) seen.push(...(await service.readProjectAlbumDirectory(projectViewer, 'project-a', i)).albums.map(a => a.id));
      assert.equal(seen.length, 130); assert.equal(new Set(seen).size, 130);
    });
    await test('finite folder selector consumes all bounded pages and rejects partial/repeated/changed totals', async () => {
      const client = load('src/lib/reference-albums/governance-client.ts');
      global.fetch = async (url, opts) => { const u = new URL(url, 'http://synthetic.invalid'); assert.equal(opts.headers['x-upload-owner-id'], user.id); return (await get('folders', { cursor: u.searchParams.get('cursor'), limit: u.searchParams.get('limit') })).response; };
      const all = await client.loadAllFolderPages({ ownerId: user.id }); assert.equal(all.folders.length, 1000); assert.equal(new Set(all.folders.map(r => r.id)).size, 1000);
      global.fetch = async () => Response.json({ folders: [{ id: 'repeat' }], pagination: { limit: 100, total: 2, hasMore: true, nextCursor: 'repeat' } });
      await assert.rejects(() => client.loadAllFolderPages());
      let calls = 0; global.fetch = async () => ++calls === 1 ? Response.json({ folders: [{ id: 'one' }], pagination: { limit: 100, total: 2, hasMore: true, nextCursor: 'next' } }) : Response.json({ error: 'late503' }, { status: 503 });
      await assert.rejects(() => client.loadAllFolderPages(), /late503/);
      calls = 0; global.fetch = async () => Response.json({ folders: [{ id: `folder-${++calls}` }], pagination: { limit: 100, total: calls === 1 ? 2 : 3, hasMore: calls === 1, nextCursor: calls === 1 ? 'next' : null } });
      await assert.rejects(() => client.loadAllFolderPages(), /列表已变化/);
    });
    await test('inactive/private folders, revoked/expired grants and nonpending moderation are excluded before page/count', async () => {
      const saved = [folders, shares, submissions];
      try {
        folders = [...folders, { ...folders[0], id: 'hidden-folder', status: 'deleted', sort_order: -100 }, { ...folders[0], id: 'private-folder', scope: 'private', sort_order: -100 }];
        shares = [...shares, { ...shares[0], id: 'revoked-share', status: 'revoked' }, { ...shares[0], id: 'expired-share', expires_at: new Date('2000-01-01') }, { ...shares[0], id: 'foreign-share', album_id: 'album-b' }];
        submissions = [...submissions, { ...submissions[0], id: 'old-approved', status: 'approved' }];
        for (const kind of Object.keys(paths)) assert.equal((await get(kind)).data.pagination.total, 1000);
        assert.equal((await get('submissions', { status: 'all' })).data.pagination.total, 1001);
      } finally { [folders, shares, submissions] = saved; }
    });
    await test('owned syntax and focused static rule, including negative unpaged consumer, without full tsc/build', async () => {
      const { ownedFiles, checkGovernancePagination } = require('./check-governance-pagination.cjs');
      for (const file of [...ownedFiles, 'scripts/test-audit-governance-native.ts']) {
        const syntax = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, reportDiagnostics: true,
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.Preserve } });
        assert.equal((syntax.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0, file);
      }
      assert.deepEqual(checkGovernancePagination(), []);
      const originalRead = fs.readFileSync;
      fs.readFileSync = function(file, ...args) { const data = originalRead.call(this, file, ...args);
        return String(file).endsWith('/src/components/ShareAlbumDialog.tsx') ? String(data).replace('loadShares(true)', 'loadFirstPageOnly()') : data; };
      try { assert(checkGovernancePagination().some(error => error.includes('loadShares(true)'))); } finally { fs.readFileSync = originalRead; }
    });
  }
  const result = { phase, scope: 'actual source GETs and helpers; synthetic Prisma/auth boundaries, not native Prisma/browser/production', results,
    passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length };
  fs.writeFileSync(`.role-tests/audit-governance-${phase}.json`, JSON.stringify(result, null, 2), { flag: 'wx' }); console.log(JSON.stringify(result)); if (result.failed) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
