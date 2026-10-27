'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict'), ts = require('typescript');
const root = process.cwd(), phase = process.env.PICKER_PHASE || 'red';
assert.match(phase, /^[a-z0-9_-]+$/i);
const user = { id: 'picker-owner', status: 'active', role: 'user', account_type: 'internal' };
const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `asset-${String(i).padStart(4, '0')}`, owner_id: user.id, status: 'active', type: i % 3 ? 'image' : 'video',
  original_url: `/uploads/assets/synthetic-${i}.png`, thumbnail_url: null, file_name: `synthetic-${String(i).padStart(4, '0')}`, metadata_json: null, created_at: new Date(1700000000000 + i), width: 48, height: 32, file_size: 100, mime_type: i % 3 ? 'image/png' : 'video/mp4' }));
let reads = [];
let signedPreview = false;
function match(row, where) {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every(w => match(row, w));
    if (key === 'OR') return value.some(w => match(row, w));
    if (key === 'NOT') return !match(row, value);
    if (value && typeof value === 'object' && Object.prototype.toString.call(value) !== '[object Date]') return Object.entries(value).every(([op, v]) => op === 'gt' ? row[key] > v : op === 'lt' ? row[key] < v : op === 'not' ? row[key] !== v : op === 'in' ? v.includes(row[key]) : op === 'notIn' ? !v.includes(row[key]) : op === 'some' ? (row[key] || []).some(r => match(r, v)) : true);
    return row[key] === value;
  });
}
const data = { asset: rows, referenceAlbum: [], referenceImage: [], imageStudioTask: [], contentReaction: [], videoTask: [], platformSetting: [], imageStudioPreset: [], imageStudioModule: [] };
const db = Object.fromEntries(Object.keys(data).map(model => [model, {
  findMany: async args => { const read = { model, take: args.take, returned: 0 }; reads.push(read); let items = data[model].filter(row => match(row, args.where));
    for (const clause of [...(Array.isArray(args.orderBy) ? args.orderBy : args.orderBy ? [args.orderBy] : [])].reverse()) for (const [field, direction] of Object.entries(clause)) items.sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * (direction === 'desc' ? -1 : 1));
    const result = items.slice(args.skip || 0, args.take === undefined ? undefined : (args.skip || 0) + args.take); read.returned = result.length; return result; },
  findFirst: async args => data[model].find(row => match(row, args.where)) || null,
  findUnique: async args => data[model].find(row => match(row, args.where)) || null,
  count: async args => data[model].filter(row => match(row, args.where)).length,
} ]));
const cache = new Map();
class AuthError extends Error { constructor(message, status = 403) { super(message); this.status = status; } }
function load(file) {
  const full = path.resolve(root, file); if (cache.has(full)) return cache.get(full).exports;
  let source = fs.readFileSync(full, 'utf8');
  if (file === 'src/lib/pagination/cursor.ts') source += '\nexport { readCursor as readPageCursor, writeCursor as writePageCursor };';
  const mod = { exports: {} }; cache.set(full, mod);
  const code = ts.transpileModule(source, { fileName: full, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const req = name => {
    if (name === 'next/server') return { NextResponse: { json: (body, options) => Response.json(body, options) } };
    if (name === '@prisma/client') return { Prisma: {} };
    if (name === '@/lib/prisma') return { prisma: db };
    if (name === '@/lib/auth/session') return { getSession: async () => user, AuthError };
    if (name === '@/lib/http/route') return { route: (_, handler) => handler };
    if (name === '@/lib/http/api-error') return { apiErrorResponse: error => { console.error(error); return Response.json({ error: error.message }, { status: 500 }); } };
    if (name === '@/lib/security/secrets') return { requireSecret: () => Buffer.from('synthetic-picker-cursor-not-production') };
    if (name === '@/lib/projects/permissions') return { getAccessibleProjectIds: async () => [], assertCanViewTask: async () => {} };
    if (name === '@/lib/tasks/retention') return { USER_VISIBLE_TASK_RETENTION_STATUSES: ['active'] };
    if (name === '@/lib/image-studio/protected-assets') return { studioHiddenAssetUrls: async () => [], studioVisibleReferenceWhere: async () => ({}) };
    if (name === '@/lib/assets/site-url') return { sameOriginPublicUrlForSiteUpload: () => null };
    if (name === '@/lib/assets/library-removal') return { removedLibraryResources: async () => ({ asset: [], reference_image: [], video_task: [] }) };
    if (name === '@/lib/assets/generation-origin') return { generationOrigins: async () => new Map(), assetGenerationOrigin: () => undefined };
    if (name === '@/lib/video/multiview-task-privacy') return { ordinaryVideoTaskWhere: () => ({}), safeVideoTaskKeywordWhere: q => ({ id: { in: data.videoTask.filter(task => task.id.includes(q)).map(task => task.id) } }) };
    if (name === '@/lib/image-studio/dimension-mismatch') return { studioOutputTaskWhere: {}, studioTaskHasViewableOutput: task => task.status === 'succeeded' };
    if (name === '@/lib/access/media-policy') return { decideMedia: async (_, ref) => ({ allowed: !ref.id.startsWith('denied'), rights: { view: true, use: true, download: !ref.id.startsWith('use-only') } }) };
    if (name === '@/lib/media/outlet') return { mediaProjection: async (_, ref) => ({ previewUrl: `/m/${ref.type}/${ref.id}/preview${signedPreview ? '?exp=1700000000&ticket=synthetic&sig=synthetic' : ''}`, originalUrl: ref.id.startsWith('use-only') ? null : `/m/${ref.type}/${ref.id}/original`, thumbnailUrl: `/m/${ref.type}/${ref.id}/thumbnail`, canUse: true, canDownload: !ref.id.startsWith('use-only') }) };
    if (name === '@/lib/media/image-comparison-version') return { comparisonOriginalVersion: async () => `cmp2-${'a'.repeat(64)}` };
    if (name === '@/lib/hooks/use-media-preview-state') return {};
    if (name === '@/lib/image-studio/access') return { canViewStudioPreset: () => true };
    if (name === '@/lib/image-studio/preset-lifecycle') return { archivedPresetKey: id => `archived:${id}` };
    if (name === '@/lib/reference-albums/permissions') return { getAlbumAccess: async (_, album) => ({ permissions: { view: !album.denied, use: !album.denied, download: true } }),
      getAlbumByIdForAccess: async id => data.referenceAlbum.find(album => album.id === id) || null,
      getReferenceImageByIdForAccess: async id => data.referenceImage.find(r => r.id === id) || null,
      assertCanViewReferenceImage: async (_, id) => data.referenceImage.find(r => r.id === id), canDownloadOriginal: async () => true };
    if (name.startsWith('node:')) return require(name);
    const target = name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : name.startsWith('.') ? path.resolve(path.dirname(full), name) : null;
    if (target && fs.existsSync(`${target}.ts`)) return load(path.relative(root, `${target}.ts`));
    return {};
  };
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { Buffer, URL, URLSearchParams, Response, Headers, console, fetch: (...args) => global.fetch(...args) }, { filename: full })(req, mod, mod.exports);
  return mod.exports;
}
const results = [];
async function test(name, run) { try { await run(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: e.message }); } }
async function main() {
  const route = load('src/app/api/assets/picker/route.ts');
  const get = query => route.GET({ nextUrl: new URL(`http://synthetic.invalid/api/assets/picker?${query}`), headers: new Headers() });
  await test('actual picker bounds all primary source reads and returns no canonical video/audio URLs', async () => {
    const response = await get('scope=mine&types=image,video&target=workspace'); assert.equal(response.status, 200); const value = await response.json();
    assert(value.items.length <= 100); assert.equal(value.total, 1000);
    assert(reads.every(r => r.take > 0 && r.take <= 100), `unbounded reads:${JSON.stringify(reads.filter(r => !r.take || r.take > 100))}`);
    assert(!JSON.stringify(value.items).includes('/uploads/'));
  });
  if (phase !== 'red') {
    const ownAlbum = { id: 'album-mine', owner_user_id: user.id, status: 'active', album_type: 'personal', visibility: 'private', shares: [], project: null, project_id: null, updated_at: new Date(1700000000000), name: 'Album search target' };
    rows[221].type = 'audio'; rows[221].mime_type = 'audio/mpeg'; rows[221].metadata_json = '{"durationSeconds":12}';
    rows[800].created_at = rows[801].created_at = rows[900].created_at; rows[800].file_name = rows[801].file_name = '.same-name';
    const publicAlbum = { ...ownAlbum, id: 'album-public', owner_user_id: 'foreign', visibility: 'public', album_type: 'public', name: 'Public synthetic' };
    data.referenceAlbum.push(ownAlbum, publicAlbum);
    for (let i = 0; i < 124; i++) data.referenceAlbum.push({ ...ownAlbum, id: `catalog-${i}`, name: `Synthetic album${i}` });
    data.referenceAlbum.find(album => album.id === 'catalog-0').updated_at = new Date(1800000000000);
    for (let i = 0; i < 220; i++) {
      const asset = rows[i]; asset.owner_id = 'foreign';
      const ref = { id: `${i < 100 ? 'use-only' : 'denied'}-ref-${i}`, asset_id: asset.id, asset, album_id: ownAlbum.id, album: ownAlbum, owner_user_id: user.id,
        status: 'active', source_type: 'copied', url: asset.original_url, created_at: asset.created_at };
      data.referenceImage.push(ref); asset.reference_images = [ref];
      if (i < 100) { const duplicate = { ...ref, id: `use-only-duplicate-${i}` }; data.referenceImage.push(duplicate); asset.reference_images.push(duplicate); }
    }
    for (let i = 0; i < 70; i++) data.referenceImage.push({ id: `${i < 60 ? 'use-only' : 'denied'}-orphan-${i}`, asset_id: null, asset: null, album_id: ownAlbum.id, album: ownAlbum, owner_user_id: user.id,
      status: 'active', source_type: 'upload', url: '/uploads/synthetic-orphan.png', created_at: new Date(1700000002000 + i) });
    for (let i = 0; i < 70; i++) data.videoTask.push({ id: `${i < 60 ? 'video' : 'denied-video'}-${i}`, owner_user_id: user.id, local_status: 'succeeded', retention_status: 'active',
      local_video_path: '/videos/synthetic.mp4', public_video_url: null, duration: 5, created_at: new Date(1700000004000 + i) });
    const generated = rows.filter((row, i) => i >= 220 && row.type === 'image').slice(0, 126);
    generated.forEach((asset, i) => {
      const id = `preset-${String(i % 125).padStart(3, '0')}`, module = `module-${i}`;
      if (i < 125) data.imageStudioPreset.push({ id, name: `Template${i}`, owner_id: user.id, is_shared: false, scope: 'creator' });
      data.imageStudioModule.push({ id: module, owner_id: user.id, name: module, source_preset_id: id });
      data.imageStudioTask.push({ id: `task-${i}`, asset_id: asset.id, owner_id: user.id, module_id: module, source_preset_id: id, deleted_at: null,
        snapshot_json: JSON.stringify({ sourcePresetId: id }), status: 'succeeded' });
    });
    data.contentReaction.push({ id: 'favorite-one', user_id: user.id, content_key: `asset:${generated[0].id}`, liked: true },
      { id: 'favorite-ref', user_id: user.id, content_key: 'reference_image:use-only-ref-0', favorited: true });
    await test('1000 mixed authorized identities page completely with no duplicate refs or denied early cutoff', async () => {
      let after = '', ids = [], passes = 0, previous = null;
      do { const response = await get(`target=workspace&scope=mine&limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`); assert.equal(response.status, 200); const page = await response.json();
        assert.equal(page.total, 1000); assert(page.items.length <= 100); assert(!JSON.stringify(page.items).includes('/uploads/') && !JSON.stringify(page.items).includes('/videos/'));
        assert(page.items.every(item => !item.referenceImageId?.startsWith('denied') && !item.id.startsWith('denied')));
        for (const item of page.items) { if (previous) assert(previous.createdAt > item.createdAt || previous.createdAt === item.createdAt && previous.identity.localeCompare(item.identity) <= 0); previous = item; }
        ids.push(...page.items.map(item => item.identity)); after = page.nextCursor || ''; assert(++passes <= 11);
      } while (after);
      assert.equal(ids.length, 1000); assert.equal(new Set(ids).size, 1000);
    });
    await test('cursor binds owner and every effective filter and rejects stale anchor', async () => {
      const first = await (await get('target=workspace&scope=mine&limit=40')).json(), token = first.nextCursor;
      assert.equal((await get(`target=workspace&scope=mine&after=${encodeURIComponent(`${token}x`)}`)).status, 400);
      for (const extra of ['source=uploaded', 'q=synthetic', 'sort=name', 'target=image-studio', 'album=album-mine', 'types=image', 'view=favorites', 'template=preset-000', 'template_context=module-0']) {
        const query = new URLSearchParams({ scope: 'mine', target: 'workspace', after: token }); for (const [key, value] of new URLSearchParams(extra)) query.set(key, value);
        assert.equal((await get(query.toString())).status, 400, extra);
      }
      const original = user.id; user.id = 'other-account'; assert.equal((await get(`target=workspace&scope=mine&after=${encodeURIComponent(token)}`)).status, 400); user.id = original;
      const anchor = first.items.at(-1), bucket = anchor.key.startsWith('video_task:') ? data.videoTask : data.asset;
      const index = bucket.findIndex(row => row.id === anchor.id), saved = bucket[index]; bucket.splice(index, 1);
      assert.equal((await get(`target=workspace&scope=mine&after=${encodeURIComponent(token)}`)).status, 409); bucket.splice(index, 0, saved);
    });
    await test('source/template aliases, favorites, album-name search and finite keys remain exact', async () => {
      const favorite = await (await get('target=workspace&scope=mine&view=favorites&limit=100')).json(); assert.equal(favorite.total, 2);
      const template = await (await get('target=workspace&scope=mine&source=template-image&template=module-0&limit=100')).json(); assert.equal(template.total, 2);
      assert(template.items.every(item => item.generationOrigin.templateId === 'preset-000'));
      const search = await (await get('target=workspace&scope=mine&q=Album%20search%20target&limit=100')).json(); assert.equal(search.total, 160);
      reads = []; const finite = await (await get(`target=workspace&scope=mine&keys=asset:${generated[0].id}`)).json(); assert.equal(finite.total, 1);
      assert(reads.filter(read => read.model === 'asset').reduce((count, read) => count + read.returned, 0) <= 1);
      const tooMany = Array.from({ length: 81 }, (_, i) => `asset:x${i}`).join(','); assert.equal((await get(`keys=${tooMany}`)).status, 400);
      assert.equal((await get(`keys=asset:${'a'.repeat(180)}`)).status, 200);
      const recent = await (await get(`target=workspace&view=recent&keys=asset:${generated[1].id},asset:${generated[0].id}`)).json(); assert.deepEqual(recent.items.map(item => item.key), [`asset:${generated[1].id}`, `asset:${generated[0].id}`]);
      const audio = await (await get('target=workspace&keys=asset:asset-0221')).json(); assert.equal(audio.items[0].duration, 12); assert(audio.items[0].originalUrl.startsWith('/m/'));
    });
    await test('use-only copied foreign content stays unavailable for import and never grants original', async () => {
      const value = await (await get('target=assets&keys=reference_image:use-only-ref-1')).json(); assert.equal(value.items.length, 1);
      assert.equal(value.items[0].originalUrl, ''); assert.equal(value.items[0].importUrl, undefined); assert(value.items[0].unavailableReason);
    });
    await test('legacy page offsets agree with signed continuation and name order is stable', async () => {
      const first = await (await get('target=workspace&sort=name')).json();
      const cursor = await (await get(`target=workspace&sort=name&page=2&after=${encodeURIComponent(first.nextCursor)}`)).json();
      const offset = await (await get('target=workspace&sort=name&page=2')).json(); assert.deepEqual(cursor.items.map(item => item.identity), offset.items.map(item => item.identity));
      const joined = [...first.items, ...cursor.items]; for (let i = 1; i < joined.length; i++) { const order = joined[i - 1].fileName.localeCompare(joined[i].fileName, 'zh-CN'); assert(order <= 0); if (!order) assert(joined[i - 1].identity.localeCompare(joined[i].identity) <= 0); }
      assert.equal((await get('limit=0')).status, 400); assert.equal((await get('page=-1')).status, 400);
      const capped = await (await get('limit=999')).json(); assert(capped.items.length <= 100);
      assert.equal((await route.GET({ nextUrl: new URL('http://synthetic.invalid/?target=workspace'), headers: new Headers({ 'x-upload-owner-id': 'wrong-account' }) })).status, 409);
    });
    await test('album/template metadata is separately paged and finite client assembles all pages', async () => {
      const count = async kind => { let after = '', result = []; do { const response = await get(`target=workspace&directory=${kind}&limit=100${after ? `&directory_after=${encodeURIComponent(after)}` : ''}`); assert.equal(response.status, 200);
        const page = await response.json(); assert(page[kind].length <= 100); result.push(...page[kind]); after = page.directoryPage.nextCursor || ''; } while (after); return result; };
      const albumDirectory = await count('albums'); assert.equal(albumDirectory.length, 126); assert.equal(albumDirectory[0].id, 'catalog-0'); assert.equal((await count('templates')).length, 125);
      const client = load('src/lib/assets/picker-client.ts'); global.fetch = async (url, options) => { assert.equal(options.headers['x-upload-owner-id'], user.id); const query = new URL(url, 'http://synthetic.invalid').search.slice(1); return get(query); };
      const complete = await client.pickerWithDirectories(new URLSearchParams('target=workspace&scope=mine'), user.id); assert.equal(complete.albums.length, 126); assert.equal(complete.templates.length, 125);
      assert(reads.every(r => r.take > 0 && r.take <= 100));
      global.fetch = async url => { const query = new URL(url, 'http://synthetic.invalid'); return query.searchParams.get('directory_after') ? Response.json({ error: 'synthetic late directory error' }, { status: 503 }) : get(query.search.slice(1)); };
      await assert.rejects(() => client.pickerWithDirectories(new URLSearchParams('target=workspace&scope=mine'), user.id), /synthetic late directory error/);
    });
    await test('metadata cursor rejects cross-directory, changed scope and deleted metadata anchor', async () => {
      const first = await (await get('target=workspace&directory=albums&limit=100')).json(), token = first.directoryPage.nextCursor;
      assert.equal((await get(`target=workspace&directory=templates&directory_after=${encodeURIComponent(token)}`)).status, 400);
      assert.equal((await get(`target=workspace&directory=albums&scope=public&directory_after=${encodeURIComponent(token)}`)).status, 400);
      const anchor = first.albums.at(-1), index = data.referenceAlbum.findIndex(row => row.id === anchor.id), old = data.referenceAlbum[index]; data.referenceAlbum.splice(index, 1);
      assert.equal((await get(`target=workspace&directory=albums&directory_after=${encodeURIComponent(token)}`)).status, 409); data.referenceAlbum.splice(index, 0, old);
    });
    await test('current workspace context alias remains available after canonical template selection', async () => {
      const response = await get('target=workspace&directory=templates&limit=100&template=preset-000&template_context=module-125');
      assert.equal(response.status, 200); const data = await response.json(); const option = data.templates.find(row => row.id === 'preset-000');
      assert(option?.aliases?.includes('module-125'), 'canonical selection must retain the genuine current workspace alias');
    });
    await test('actual comparison consumer versions the issuing endpoint without corrupting immutable media tickets', async () => {
      signedPreview = true;
      try {
        const { pickerImageSource } = load('src/lib/media/image-comparison.ts');
        const exact = await (await get(`target=workspace&comparison=1&keys=asset:${generated[0].id}`)).json();
        const address = new URL(pickerImageSource(exact.items[0]).src, 'http://synthetic.invalid');
        assert(address.searchParams.has('comparison-version')); assert.equal(address.searchParams.has('ticket'), false, 'version query belongs on the issuing endpoint, not on the signed ticket');
        const normal = await (await get(`target=workspace&keys=asset:${generated[0].id}`)).json(); assert(normal.items[0].previewUrl.includes('ticket=synthetic'));
      } finally { signedPreview = false; }
    });
    await test('syntax and focused static guard preserve bounded reads and fail a deliberate growth violation', async () => {
      const { checkPickerGrowth, files } = require('./check-picker-growth.cjs'); assert.deepEqual(checkPickerGrowth(), []);
      const read = file => fs.readFileSync(file, 'utf8');
      const broken = file => file === 'src/lib/assets/picker-service.ts' ? read(file).replaceAll('orderBy: { id: \'asc\' }, take', 'orderBy: { id: \'asc\' }') : read(file);
      assert(checkPickerGrowth(broken).some(error => error.includes('unbounded findMany')));
      for (const file of [...files, 'src/lib/assets/picker-client.ts', 'src/lib/assets/picker-types.ts', 'src/app/api/assets/picker/route.ts', 'src/components/ResourceLibraryPicker.tsx', 'scripts/test-audit-picker-native.ts']) {
        const result = ts.transpileModule(read(file), { fileName: file, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.Preserve } });
        assert.equal((result.diagnostics || []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error).length, 0, file);
      }
    });
  }
  fs.writeFileSync(`.role-tests/audit-picker-${phase}.json`, JSON.stringify({ phase, scope: 'actual route; synthetic external DB/auth/media boundaries', results, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(results)); if (results.some(r => !r.ok)) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
