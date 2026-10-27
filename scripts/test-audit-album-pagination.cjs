'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = process.cwd();
const phase = process.env.ALBUM_PAGE_PHASE || 'red';
assert.match(phase, /^[a-z0-9_-]+$/i);
const results = [];
async function test(name, run) { try { await run(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: e.message }); } }
const user = { id: 'synthetic-owner', status: 'active', role: 'user', account_type: 'internal' };
const album = { id: 'synthetic-album', status: 'active', owner_user_id: user.id, album_type: 'personal', shares: [], project: null, public_folder_id: null, _count: { images: 1000 } };
let rows = Array.from({ length: 1000 }, (_, i) => ({ id: `image-${String(i).padStart(4, '0')}`, album_id: album.id, status: 'active', sort_order: i % 7,
  created_at: new Date(1700000000000), updated_at: new Date(1700000000000), asset_id: null, url: '/uploads/synthetic.png', asset: null }));
function matches(row, where) {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every(w => matches(row, w));
    if (key === 'OR') return value.some(w => matches(row, w));
    if (value && typeof value === 'object' && !(value instanceof Date)) return Object.entries(value).every(([op, v]) => op === 'gt' ? row[key] > v : op === 'lt' ? row[key] < v : op === 'not' ? row[key] !== v : op === 'in' ? v.includes(row[key]) : true);
    return row[key] === value;
  });
}
let bounded = true;
const albumRows = Array.from({ length: 220 }, (_, i) => ({ ...album, id: `catalog-${String(i).padStart(4, '0')}`, updated_at: new Date(1700000000000),
  denied: i >= 100, images: [], owner: null, shares: [], _count: { images: 0 } }));
async function query(data, args) {
  if (!(args.take > 0 && args.take <= 100)) bounded = false;
  const selected = data.filter(row => matches(row, args.where));
  const order = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy];
  selected.sort((a, b) => { for (const clause of order) for (const [key, dir] of Object.entries(clause)) { const cmp = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0; if (cmp) return dir === 'desc' ? -cmp : cmp; } return 0; });
  return selected.slice(args.skip || 0, args.take === undefined ? undefined : (args.skip || 0) + args.take);
}
const db = {
  referenceImage: { findMany: args => query(rows, args), findFirst: async () => null },
  referenceAlbum: { findMany: args => query(albumRows, args) },
  albumShare: { count: async () => 0, groupBy: async () => [] }, referenceAlbumFolder: { findUnique: async () => null },
};
class AuthError extends Error { constructor(message, status = 403) { super(message); this.status = status; } }
const cache = new Map();
function load(file) {
  const full = path.resolve(root, file);
  if (cache.has(full)) return cache.get(full).exports;
  const mod = { exports: {} }; cache.set(full, mod);
  const output = ts.transpileModule(fs.readFileSync(full, 'utf8'), { fileName: full, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const request = name => {
    if (name === 'next/server') return { NextResponse: { json: (data, init) => Response.json(data, init) } };
    if (name === '@/lib/prisma') return { prisma: db };
    if (name === '@/lib/auth/session') return { AuthError, getSession: async () => user };
    if (name === '@/lib/security/secrets') return { requireSecret: () => Buffer.from('synthetic-pagination-key-never-production') };
    if (name === '@/lib/reference-albums/permissions') return { assertCanViewAlbum: async (_, id) => { if (id !== album.id) throw new AuthError('missing', 404); return album; },
      getAlbumAccess: async (_, row) => ({ permissions: { view: !row.denied, viewSource: false } }), canViewReferenceImage: async (_, row) => !row.denied };
    if (name === '@/lib/access/media-policy') return { referenceContentRights: async (_, row) => ({ view: !row.denied, viewSource: false }) };
    if (name === '@/lib/image-studio/protected-assets') return { studioVisibleReferenceWhere: async () => ({}) };
    if (name === '@/lib/media/outlet') return { mediaProjection: async (_, ref) => ({ previewUrl: `/m/reference/${ref.id}/preview`, thumbnailUrl: `/m/reference/${ref.id}/thumbnail`, originalUrl: null, canUse: true, canDownload: false }) };
    if (name === '@/lib/projects/permissions') return { getAccessibleProjectIds: async () => [] };
    if (['@/lib/assets/site-upload', '@/lib/assets/upload-log', '@/lib/access/feature-guard'].includes(name)) return {};
    if (name.startsWith('node:')) return require(name);
    const target = name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : name.startsWith('.') ? path.resolve(path.dirname(full), name) : null;
    if (target && fs.existsSync(`${target}.ts`)) return load(`${target}.ts`);
    return {};
  };
  vm.runInNewContext(`(function(require,module,exports,Buffer,URL,URLSearchParams,Response){${output}\n})`, { console, fetch: (...args) => global.fetch(...args) }, { filename: full })(request, mod, mod.exports, Buffer, URL, URLSearchParams, Response);
  return mod.exports;
}
async function main() {
  const route = load('src/app/api/reference-albums/[id]/images/route.ts');
  const get = async (cursor, limit = 73, id = album.id) => {
    const url = new URL(`http://synthetic.invalid/api/reference-albums/${id}/images`); url.searchParams.set('limit', String(limit)); if (cursor) url.searchParams.set('cursor', cursor);
    return route.GET({ nextUrl: url, headers: new Headers() }, { params: Promise.resolve({ id }) });
  };
  await test('actual images handler bounds a1000-image synthetic album and publishes exact pagination total', async () => {
    const response = await get(); assert.equal(response.status, 200); const data = await response.json();
    assert(data.images.length <= 73, `actual handler returned${data.images.length}, expected<=73`);
    assert.equal(data.pagination.total, 1000); assert.equal(data.pagination.hasMore, true); assert(bounded);
  });
  if (!phase.startsWith('red')) {
    await test('all pages are complete with stable ties and no duplicates', async () => {
      const ids = []; let cursor; do { const response = await get(cursor); assert.equal(response.status, 200); const data = await response.json(); assert(data.images.length <= 73); ids.push(...data.images.map(r => r.id)); cursor = data.pagination.nextCursor; } while (cursor);
      assert.equal(ids.length, 1000); assert.equal(new Set(ids).size, 1000);
    });
    await test('permissions filter before page, including more than one denied scan batch', async () => {
      rows.forEach((row, i) => row.denied = i % 7 < 3); const response = await get(); const data = await response.json();
      assert.equal(data.images.length, 73); assert.equal(data.pagination.total, rows.filter(r => !r.denied).length); assert(data.images.every(r => !rows.find(x => x.id === r.id).denied)); rows.forEach(r => delete r.denied);
    });
    await test('cursor rejects tampering, cross-account, cross-album and removed anchors', async () => {
      const data = await (await get()).json(), cursor = data.pagination.nextCursor;
      assert.equal((await get(`${cursor}x`)).status, 400);
      const original = user.id; user.id = 'synthetic-other'; assert.equal((await get(cursor)).status, 400); user.id = original;
      const originalAlbum = album.id; album.id = 'synthetic-other-album'; assert.equal((await get(cursor, 73, album.id)).status, 400); album.id = originalAlbum;
      const anchor = data.images.at(-1).id, saved = rows; rows = rows.filter(r => r.id !== anchor); assert.equal((await get(cursor)).status, 409); rows = saved;
      const record = rows.find(r => r.id === anchor); record.denied = true; assert.equal((await get(cursor)).status, 409); delete record.denied;
    });
    await test('limit ceiling and invalid inputs fail explicitly', async () => {
      assert((await (await get(null, 999)).json()).images.length <= 100); assert.equal((await get(null, 0)).status, 400); assert.equal((await get(null, 'abc')).status, 400);
      for (const query of ['cursor=', 'cursor=x&cursor=y']) {
        const response = await route.GET({ nextUrl: new URL(`http://synthetic.invalid/?${query}`), headers: new Headers() }, { params: Promise.resolve({ id: album.id }) });
        assert.equal(response.status, 400, 'Invalid cursor presence cannot restart the first page');
      }
      const cursor = encodeURIComponent((await (await get()).json()).pagination.nextCursor);
      const duplicated = await route.GET({ nextUrl: new URL(`http://synthetic.invalid/?cursor=${cursor}&cursor=${cursor}`), headers: new Headers() }, { params: Promise.resolve({ id: album.id }) });
      assert.equal(duplicated.status, 400);
    });
    await test('actual detail handler returns exact total instead of page length', async () => {
      const detail = load('src/app/api/reference-albums/[id]/route.ts');
      const response = await detail.GET({ nextUrl: new URL('http://synthetic.invalid/?limit=11'), headers: new Headers() }, { params: Promise.resolve({ id: album.id }) });
      assert.equal(response.status, 200); const data = await response.json(); assert.equal(data.images.length, 11); assert.equal(data.album.image_count, 1000); assert.equal(data.pagination.total, 1000);
    });
    await test('actual list handler scans past120 denied albums before paging and binds scope', async () => {
      const list = load('src/app/api/reference-albums/route.ts');
      const response = await list.GET({ nextUrl: new URL('http://synthetic.invalid/?scope=mine&limit=17'), headers: new Headers() });
      assert.equal(response.status, 200); const data = await response.json(); assert.equal(data.albums.length, 17); assert.equal(data.pagination.total, 100); assert(bounded);
      const foreign = await list.GET({ nextUrl: new URL(`http://synthetic.invalid/?scope=all&cursor=${encodeURIComponent(data.pagination.nextCursor)}`), headers: new Headers() });
      assert.equal(foreign.status, 400);
    });
    await test('complete client loader traverses all selector and duplicate-check pages', async () => {
      const client = load('src/lib/reference-albums/client-pages.ts'); let calls = 0;
      const data = Array.from({ length: 257 }, (_, i) => ({ id: `synthetic-${i}` }));
      global.fetch = async url => { const offset = Number(new URL(url, 'http://synthetic.invalid').searchParams.get('cursor') || 0); calls++;
        return Response.json({ albums: data.slice(offset, offset + 100), pagination: { total: 257, limit: 100, hasMore: offset + 100 < 257, nextCursor: offset + 100 < 257 ? String(offset + 100) : null } }); };
      const all = await client.loadAllAlbumPages('/api/reference-albums?scope=mine', 'albums'); assert.equal(all.length, 257); assert.equal(calls, 3);
      global.fetch = async () => Response.json({ albums: [{ id: 'repeat' }], pagination: { total: 2, limit: 100, hasMore: true, nextCursor: 'repeat' } });
      await assert.rejects(() => client.loadAllAlbumPages('/api/reference-albums', 'albums'));
      let page = 0;
      global.fetch = async (_, options) => { assert.equal(options.headers['x-upload-owner-id'], user.id); page++;
        return page === 1 ? Response.json({ albums: [{ id: 'first' }], pagination: { total: 2, limit: 100, hasMore: true, nextCursor: 'second' } }) : Response.json({ error: 'synthetic late failure' }, { status: 503 }); };
      await assert.rejects(() => client.loadAllAlbumPages('/api/reference-albums', 'albums', { ownerId: user.id }), /synthetic late failure/);
    });
    await test('owned TS and TSX syntax transpiles without a full typecheck or loading application runtime', async () => {
      const files = [...require('./check-album-pagination.cjs').ownedFiles, 'scripts/test-audit-album-pagination-server.ts'];
      for (const file of files) { const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.Preserve } });
        assert.equal((result.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0, file); }
    });
    await test('focused static guard rejects unpaged handlers and guards all enumerated consumers', async () => {
      const { checkAlbumPagination } = require('./check-album-pagination.cjs'); assert.deepEqual(checkAlbumPagination(), []);
      const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'album-static-negative-'));
      try {
        const originalRead = fs.readFileSync;
        fs.readFileSync = function(file, ...args) { const data = originalRead.call(this, file, ...args); return String(file).endsWith('/src/app/api/reference-albums/[id]/images/route.ts') ? String(data).replace('readAlbumImagePage(user, album, request.nextUrl.searchParams)', 'unboundedImages()') : data; };
        try { assert(checkAlbumPagination().some(error => error.includes('GET must use'))); } finally { fs.readFileSync = originalRead; }
      } finally { fs.rmdirSync(temp); }
    });
  }
  const result = { phase, scope: 'actual GET handler and pagination implementation; synthetic DB/auth/media boundaries, not real Prisma or browser', results, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length };
  fs.writeFileSync(`.role-tests/audit-pagination-${phase}.json`, JSON.stringify(result, null, 2), { flag: 'wx' }); console.log(JSON.stringify(result)); if (result.failed) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
