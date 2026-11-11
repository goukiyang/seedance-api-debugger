import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, isBuiltin, Module } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Actual service/API and component callbacks with isolated I/O. No browser,
// real upload, production DB, provider, dependency install or shared writes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependencyFlag = process.argv.indexOf('--dependency-root');
const dependencyRoot = dependencyFlag < 0 ? root : path.resolve(process.argv[dependencyFlag + 1]);
const require = createRequire(path.join(dependencyRoot, 'package.json'));
const ts = require('typescript'), { PrismaClient, Prisma } = require('@prisma/client');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'character-thumbnail-engineering-'));
const prisma = new PrismaClient({ datasources: { db: { url: `file:${path.join(temporary, 'fixture.db')}` } } });
const originalFetch = globalThis.fetch;
let networkAttempts = 0, protectionAllowed = true, actor;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Network forbidden in thumbnail fixture'); };
class AuthError extends Error { constructor(message, status = 403) { super(message); this.status = status; } }
const owner = { id: 'fixture-owner', role: 'user', account_type: 'internal', status: 'active' };
const other = { ...owner, id: 'fixture-other' }; actor = owner;
const writes = { CHARACTER_ASSET_WRITES_ENABLED: true }, protectionChecks = [], checks = [], sourceSha256 = {};
const modules = new Map([
  ['server-only', {}], ['@/lib/prisma', { prisma, retrySqliteBusy: run => run() }],
  ['@/lib/auth/session', { AuthError }], ['./build-mode', writes],
  ['@/lib/auth/api-helpers', { getSessionUser: async () => actor }],
  ['@/lib/integrations/codex', { hasCodexApiAuthSignal: () => false, CodexApiAuthError: class extends Error {} }],
  ['next/server', { NextResponse: { json: (value, init) => new Response(JSON.stringify(value), init) } }],
  ['@/lib/image-studio/protected-assets', { canReadStudioAsset: async (user, asset, db) => {
    protectionChecks.push({ userId: user.id, assetId: asset.id, transaction: db !== prisma }); return protectionAllowed;
  } }],
  ['@/lib/reference-albums/permissions', { assertCanViewReferenceImage: async (user, id) => {
    const ref = await prisma.referenceImage.findUnique({ where: { id }, include: { asset: true, album: true } });
    if (!ref || ref.owner_user_id !== user.id || ref.status !== 'active' || ref.album.status !== 'active') throw new AuthError('thumbnail denied');
    return ref;
  } }],
]);
const cache = new Map();
function source(file) {
  const text = fs.readFileSync(path.join(root, file), 'utf8'); sourceSha256[file] = createHash('sha256').update(text).digest('hex'); return text;
}
function load(file) {
  const filename = path.resolve(root, file); if (cache.has(filename)) return cache.get(filename).exports;
  assert.ok(filename.startsWith(path.join(root, 'src') + path.sep));
  const code = ts.transpileModule(source(path.relative(root, filename)), { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = new Module(filename); mod.filename = filename; cache.set(filename, mod);
  mod.require = name => {
    if (modules.has(name)) return modules.get(name);
    if (name === '@prisma/client') return { Prisma };
    if (isBuiltin(name)) return require(name);
    if (name.startsWith('@/')) return load(`src/${name.slice(2)}.ts`);
    if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), `${name}.ts`)));
    throw new Error(`Unmocked dependency ${name} in ${file}`);
  };
  mod._compile(code, filename); return mod.exports;
}
async function check(label, run) { await run(); assert.equal(networkAttempts, 0); checks.push(label); }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function setup() {
  const userFields = Prisma.dmmf.datamodel.models.find(model => model.name === 'User').fields.filter(field => field.kind !== 'object');
  const userColumns = userFields.map(field => {
    const type = ({ Int: 'INTEGER', BigInt: 'BIGINT', Float: 'REAL', Boolean: 'BOOLEAN', DateTime: 'DATETIME', Bytes: 'BLOB', Decimal: 'DECIMAL' })[field.type] || 'TEXT';
    const defaults = { status: "'active'", role: "'user'", account_type: "'internal'" };
    const fallback = type === 'TEXT' ? "'fixture'" : type === 'DATETIME' ? 'CURRENT_TIMESTAMP' : type === 'BLOB' ? "X''" : '0';
    return `"${field.name}" ${type}${field.isId ? ' PRIMARY KEY' : ''}${field.isRequired ? ` DEFAULT ${defaults[field.name] || fallback}` : ''}`;
  });
  const ddl = [
    `CREATE TABLE "User" (${userColumns.join(',')})`,
    `CREATE TABLE "Asset" ("id" TEXT PRIMARY KEY,"owner_id" TEXT NOT NULL,"type" TEXT NOT NULL,"original_url" TEXT NOT NULL,"thumbnail_url" TEXT,"file_name" TEXT NOT NULL,"mime_type" TEXT NOT NULL,"width" INTEGER,"height" INTEGER,"file_size" INTEGER NOT NULL,"hash" TEXT,"metadata_json" TEXT,"status" TEXT NOT NULL DEFAULT 'active',"created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE "ReferenceAlbum" ("id" TEXT PRIMARY KEY,"workspace_id" TEXT,"project_id" TEXT,"public_folder_id" TEXT,"owner_user_id" TEXT NOT NULL,"name" TEXT NOT NULL,"description" TEXT,"album_type" TEXT NOT NULL DEFAULT 'personal',"visibility" TEXT NOT NULL DEFAULT 'private',"cover_image_id" TEXT,"status" TEXT NOT NULL DEFAULT 'active',"created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"updated_at" DATETIME NOT NULL)`,
    `CREATE TABLE "ReferenceImage" ("id" TEXT PRIMARY KEY,"album_id" TEXT NOT NULL,"workspace_id" TEXT,"project_id" TEXT,"owner_user_id" TEXT NOT NULL,"asset_id" TEXT,"url" TEXT NOT NULL,"thumbnail_url" TEXT,"source_type" TEXT NOT NULL DEFAULT 'upload',"source_content_id" TEXT,"source_image_id" TEXT,"sort_order" INTEGER NOT NULL DEFAULT 0,"metadata_json" TEXT,"status" TEXT NOT NULL DEFAULT 'active',"created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"updated_at" DATETIME NOT NULL)`,
    `CREATE TABLE "AlbumShare" ("id" TEXT PRIMARY KEY,"album_id" TEXT NOT NULL,"grantee_type" TEXT NOT NULL,"grantee_id" TEXT NOT NULL,"permissions_json" TEXT NOT NULL,"created_by" TEXT NOT NULL,"expires_at" DATETIME,"status" TEXT NOT NULL DEFAULT 'active',"created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    'CREATE UNIQUE INDEX "AlbumShare_album_id_grantee_type_grantee_id_key" ON "AlbumShare"("album_id","grantee_type","grantee_id")',
  ];
  for (const sql of ddl) await prisma.$executeRawUnsafe(sql);
  const migration = source('prisma/migrations/20261111090000_owner_character_assets/migration.sql');
  for (const sql of migration.replace(/^\s*--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(sql);
  await prisma.$executeRaw`INSERT INTO "User" ("id") VALUES (${owner.id}), (${other.id})`;
}
const baseAsset = { id: 'fixture-uploaded-image', owner_id: owner.id, type: 'image', original_url: '/uploads/assets/fixture-image.png', thumbnail_url: '/uploads/thumbs/fixture-image.png',
  file_name: 'fixture.png', mime_type: 'image/png', width: 32, height: 32, file_size: 100, status: 'active' };
const counts = async () => ({ albums: await prisma.referenceAlbum.count(), refs: await prisma.referenceImage.count(), characters: Number((await prisma.$queryRawUnsafe('SELECT count(*) AS n FROM CharacterAsset'))[0].n) });
async function rejectsWithoutWrites(run) {
  const before = await counts(); await assert.rejects(run); assert.deepEqual(await counts(), before);
}

// A small synchronous hook/effect runner executes the actual Panel function and
// JSX callbacks. It deliberately does not claim DOM/layout/browser acceptance.
function panelHarness(directory, session) {
  const slots = [], effects = [], storage = new Map(), uploaded = [], images = [], timeoutMs = [], timers = new Map(), listeners = new Set();
  let cursor = 0, dirty = false, tree, props = { ownerId: owner.id, directory, selectedIds: [], capacity: 9, isIp: true, switchChoices: [], thumbnails: [], onJoin: () => {} };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { const next = typeof value === 'function' ? value(slots[index]) : value; if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; } }]; },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useCallback(fn, deps) { const index = cursor++; if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { fn, deps }; return slots[index].fn; },
    useEffect(fn, deps) { const index = cursor++; const previous = slots[index]; if (!previous || !same(previous.deps, deps)) effects.push(() => { previous?.cleanup?.(); const cleanup = fn(); slots[index] = { deps, cleanup }; }); },
  }; react.useLayoutEffect = react.useEffect;
  const jsx = (type, props, key) => ({ type, props: props || {}, key });
  const panelSource = source('src/components/CharacterAssetPanel.tsx');
  const imports = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'react-dom': { createPortal: value => value },
    'lucide-react': new Proxy({}, { get: (_target, name) => `icon:${String(name)}` }),
    '@/components/useDialogDismiss': { useDialogDismiss: () => {} }, '@/lib/http/upload-session': { uploadSession: () => ({ ...session }), subscribeUploadSession: fn => { listeners.add(fn); return () => listeners.delete(fn); } },
    '@/lib/http/file-upload': { uploadFileToHistory: (file, options) => { const pending = deferred(); uploaded.push({ file, options, ...pending }); return pending.promise; } },
    '@/lib/character-assets/inputs': load('src/lib/character-assets/inputs.ts'), './character-assets.css': {},
  };
  const mod = { exports: {} }, output = ts.transpileModule(panelSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const window = { innerWidth: 1200, innerHeight: 900, addEventListener() {}, removeEventListener() {},
    setTimeout(fn, ms) { const id = timers.size + 1; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); } }, document = { body: {} };
  class Image { constructor() { const pending = deferred(); Object.assign(this, pending); images.push(this); } decode() { return this.promise; } }
  const abortSignal = { timeout(ms) { timeoutMs.push(ms); return new AbortController().signal; } };
  const localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  Function('require', 'module', 'exports', 'window', 'document', 'localStorage', 'Image', 'AbortSignal', output)(name => { assert.ok(name in imports, `Unmocked Panel dependency ${name}`); return imports[name]; }, mod, mod.exports, window, document, localStorage, Image, abortSignal);
  function render(next = {}) {
    props = { ...props, ...next }; let turns = 0;
    do { assert.ok(++turns < 30, 'Panel effects converge'); dirty = false; cursor = 0; tree = mod.exports.CharacterAssetPanel(props); while (effects.length) effects.shift()(); } while (dirty);
    return tree;
  }
  function nodes(value) { if (arguments.length === 0) value = tree; if (Array.isArray(value)) return value.flatMap(item => nodes(item)); if (!value || typeof value !== 'object') return []; return [value, ...nodes(value.props?.children)]; }
  const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : Array.isArray(value) ? value.map(text).join('') : value ? text(value.props?.children) : '';
  const button = label => { const matches = nodes().filter(node => node.type === 'button' && (node.props['aria-label'] === label || text(node) === label)); assert.ok(matches.length, `button ${label}`); return matches[0]; };
  render();
  return { render, nodes, text, button, uploaded, images, timeoutMs, timers, storage, session,
    form(target = 'character-a', userId = owner.id) { const raw = storage.get(`sd2:character-form:v1:${JSON.stringify([userId, target])}`); assert.ok(raw, `form draft ${target}`); return JSON.parse(raw); },
    setSession(patch, nextProps = {}) { Object.assign(session, patch); for (const listener of listeners) listener(); render(nextProps); },
    async click(label) { const item = button(label); assert.notEqual(item.props.disabled, true, `enabled button ${label}`); item.props.onClick(); await flush(); render(); },
    async settle() { await flush(); render(); },
    file(file) { const node = nodes().find(value => value.type === 'input' && value.props.type === 'file'); assert.ok(node, 'actual upload file input'); const target = { files: [file], value: 'fixture-file' }; node.props.onChange({ currentTarget: target, target }); render(); },
  };
}

async function main() {
  source('scripts/character-thumbnail-upload-engineering.mjs'); source('src/components/character-assets.css'); source('src/lib/character-assets/build-mode.ts');
  await setup(); await prisma.asset.create({ data: baseAsset });
  const service = load('src/lib/character-assets/service.ts'); assert.equal(typeof service.registerCharacterThumbnail, 'function', 'implementation ready before fixture run');
  await serviceChecks(service);
  if (!process.argv.includes('--service-only')) await panelChecks();
  console.log(JSON.stringify({ passed: checks.length, checks, sourceSha256, runtime: { typescript: require('typescript/package.json').version, prisma: require('@prisma/client/package.json').version },
    serviceOnly: process.argv.includes('--service-only'), isolation: { temporarySqlite: true, networkAttempts, realUploads: 0, modelCalls: 0, browserRuns: 0, productionDatabaseAccess: 0, productionWrites: 0 }, boundary: 'Engineering callback/state simulation, not browser or user acceptance.' }, null, 2));
}
async function serviceChecks(service) {
  let registered, album, ref;
  await check('actual registration creates one owner-private personal album/ref and no workspace/project/character binding', async () => {
    registered = await service.registerCharacterThumbnail(owner, baseAsset.id);
    assert.equal(registered.assetId, baseAsset.id); assert.ok(registered.referenceImageId);
    assert.equal(registered.thumbnailUrl, `/api/reference-images/${registered.referenceImageId}/content?variant=thumbnail`);
    ref = await prisma.referenceImage.findUnique({ where: { id: registered.referenceImageId } });
    album = await prisma.referenceAlbum.findUnique({ where: { id: ref.album_id } });
    assert.equal(ref.owner_user_id, owner.id); assert.equal(ref.asset_id, baseAsset.id); assert.equal(ref.url, baseAsset.original_url);
    assert.equal(ref.project_id, null); assert.equal(ref.workspace_id, null); assert.equal(ref.status, 'active');
    assert.equal(album.owner_user_id, owner.id); assert.equal(album.album_type, 'personal'); assert.equal(album.visibility, 'private');
    for (const field of ['project_id', 'workspace_id', 'public_folder_id']) assert.equal(album[field], null);
    assert.deepEqual(await counts(), { albums: 1, refs: 1, characters: 0 });
    assert.deepEqual(await prisma.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE name IN ('Workspace','WorkspaceAsset','Project')"), []);
    assert.ok(protectionChecks.length); assert.ok(protectionChecks.every(value => value.transaction));
  });
  await check('repeat registration is stable by owner/Asset and ignores unrelated same-name albums', async () => {
    const sameName = await prisma.referenceAlbum.create({ data: { id: 'unrelated-same-name', owner_user_id: owner.id, name: album.name, album_type: 'personal', visibility: 'private' } });
    for (let attempt = 0; attempt < 2; attempt++) assert.deepEqual(await service.registerCharacterThumbnail(owner, ` ${baseAsset.id} `), registered);
    assert.deepEqual(await prisma.referenceImage.findUnique({ where: { id: ref.id } }), ref);
    assert.equal(await prisma.referenceImage.count({ where: { album_id: sameName.id } }), 0);
    assert.equal((await counts()).characters, 0);
  });
  await check('fresh database account/Asset owner/status/type/MIME/size and protected-read authority reject without writes', async () => {
    await rejectsWithoutWrites(() => service.registerCharacterThumbnail(other, baseAsset.id));
    for (const value of [null, {}, 3, '', ' '.repeat(3), 'x'.repeat(257), 'missing-asset']) await rejectsWithoutWrites(() => service.registerCharacterThumbnail(owner, value));
    await prisma.user.update({ where: { id: owner.id }, data: { status: 'disabled' } });
    await rejectsWithoutWrites(() => service.registerCharacterThumbnail(owner, baseAsset.id));
    await prisma.user.update({ where: { id: owner.id }, data: { status: 'active' } });
    for (const patch of [{ owner_id: other.id }, { status: 'hidden' }, { status: 'deleted' }, { type: 'video' }, { mime_type: 'image/svg+xml' }, { mime_type: 'application/pdf' }, { file_size: 0 }, { file_size: 30 * 1024 * 1024 + 1 }]) {
      await prisma.asset.update({ where: { id: baseAsset.id }, data: patch });
      await rejectsWithoutWrites(() => service.registerCharacterThumbnail(owner, baseAsset.id));
      await prisma.asset.update({ where: { id: baseAsset.id }, data: Object.fromEntries(Object.keys(patch).map(key => [key, baseAsset[key]])) });
    }
    protectionAllowed = false;
    try { await rejectsWithoutWrites(() => service.registerCharacterThumbnail(owner, baseAsset.id)); } finally { protectionAllowed = true; }
    for (const mime_type of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']) {
      await prisma.asset.update({ where: { id: baseAsset.id }, data: { mime_type, file_size: 30 * 1024 * 1024 } });
      assert.deepEqual(await service.registerCharacterThumbnail(owner, baseAsset.id), registered);
    }
    await prisma.asset.update({ where: { id: baseAsset.id }, data: { mime_type: baseAsset.mime_type, file_size: baseAsset.file_size } });
  });
  await check('album ownership/deletion/sharing/project/workspace conflicts are rejected without resurrection or overwrite', async () => {
    for (const patch of [{ owner_user_id: other.id }, { status: 'deleted' }, { status: 'archived' }, { visibility: 'shared' }, { album_type: 'project' }, { project_id: 'project' }, { workspace_id: 'workspace' }, { public_folder_id: 'folder' }]) {
      await prisma.referenceAlbum.update({ where: { id: album.id }, data: patch });
      const before = await prisma.referenceAlbum.findUnique({ where: { id: album.id } });
      await rejectsWithoutWrites(() => service.registerCharacterThumbnail(owner, baseAsset.id));
      assert.deepEqual(await prisma.referenceAlbum.findUnique({ where: { id: album.id } }), before);
      await prisma.referenceAlbum.update({ where: { id: album.id }, data: Object.fromEntries(Object.keys(patch).map(key => [key, album[key]])) });
    }
    for (const [status, expires_at, active] of [['active', null, true], ['active', new Date(Date.now() + 60_000), true], ['revoked', null, false], ['expired', null, false], ['active', new Date(Date.now() - 60_000), false]]) {
      const share = await prisma.albumShare.create({ data: { album_id: album.id, grantee_type: 'user', grantee_id: other.id, permissions_json: '{}', created_by: owner.id, status, expires_at } });
      if (active) await rejectsWithoutWrites(() => service.registerCharacterThumbnail(owner, baseAsset.id));
      else assert.deepEqual(await service.registerCharacterThumbnail(owner, baseAsset.id), registered);
      assert.equal((await prisma.albumShare.findUnique({ where: { id: share.id } })).status, status); await prisma.albumShare.delete({ where: { id: share.id } });
    }
  });
  await check('existing ref owner/Asset/album/deletion/source URL conflicts do not revive or overwrite records', async () => {
    for (const patch of [{ owner_user_id: other.id }, { asset_id: 'different-asset' }, { album_id: 'different-album' }, { status: 'deleted' }, { project_id: 'project' }, { workspace_id: 'workspace' }, { url: '/uploads/another.png' }, { thumbnail_url: '/uploads/another-thumb.png' }]) {
      await prisma.referenceImage.update({ where: { id: ref.id }, data: patch });
      const before = await prisma.referenceImage.findUnique({ where: { id: ref.id } }); await rejectsWithoutWrites(() => service.registerCharacterThumbnail(owner, baseAsset.id));
      assert.deepEqual(await prisma.referenceImage.findUnique({ where: { id: ref.id } }), before);
      await prisma.referenceImage.update({ where: { id: ref.id }, data: Object.fromEntries(Object.keys(patch).map(key => [key, ref[key]])) });
    }
  });
  await check('write pause rejects registration before protected reads, and actual thumbnail API validates/authenticates body', async () => {
    const before = protectionChecks.length; writes.CHARACTER_ASSET_WRITES_ENABLED = false;
    try { await rejectsWithoutWrites(() => service.registerCharacterThumbnail(owner, baseAsset.id)); assert.equal(protectionChecks.length, before); }
    finally { writes.CHARACTER_ASSET_WRITES_ENABLED = true; }
    const route = load('src/app/api/character-assets/thumbnail/route.ts');
    const request = body => new Request('https://fixture.invalid/api/character-assets/thumbnail', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
    const success = await route.POST(request({ assetId: baseAsset.id })); assert.equal(success.status, 200); assert.deepEqual(await success.json(), registered);
    assert.match(success.headers.get('cache-control'), /private.*no-store/); assert.match(success.headers.get('vary'), /Cookie, Authorization/);
    for (const body of [null, [], {}, { assetId: baseAsset.id, unexpected: true }, '{bad']) assert.equal((await route.POST(request(body))).status, 400);
    actor = other; try { assert.equal((await route.POST(request({ assetId: baseAsset.id }))).status, 404); } finally { actor = owner; }
  });
  await check('existing explicit character save keeps revision CAS and applies the chosen thumbnail only on save', async () => {
    const created = await service.createCharacterAsset(owner, { name: '旧角色', assetId: 'asset-Original', thumbnailReferenceImageId: ref.id });
    const second = await prisma.asset.create({ data: { ...baseAsset, id: 'second-own-image', original_url: '/uploads/second.png' } });
    const next = await service.registerCharacterThumbnail(owner, second.id);
    assert.equal((await service.getCharacterAsset(owner, created.id)).thumbnailReferenceImageId, ref.id);
    const saved = await service.updateCharacterAsset(owner, created.id, { revision: created.revision, thumbnailReferenceImageId: next.referenceImageId });
    assert.equal(saved.revision, created.revision + 1); assert.equal(saved.thumbnailReferenceImageId, next.referenceImageId);
    await assert.rejects(() => service.updateCharacterAsset(owner, created.id, { revision: created.revision, thumbnailReferenceImageId: ref.id }), error => error.code === 'CHARACTER_ASSET_REVISION_CONFLICT');
    assert.equal((await service.getCharacterAsset(owner, created.id)).thumbnailReferenceImageId, next.referenceImageId);
    assert.deepEqual(await prisma.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE name IN ('Workspace','WorkspaceAsset','Project')"), []);
  });
}
async function panelChecks() {
  const assetA = { id: 'character-a', name: '角色甲', assetId: 'asset-Character_A', revision: 7, enabled: true, deletedAt: null, groupId: null, projectName: null, notes: null,
    thumbnailReferenceImageId: 'ref-old-a', thumbnailUrl: '/api/reference-images/ref-old-a/content?variant=thumbnail', upstreamStatus: 'unknown' };
  const assetB = { ...assetA, id: 'character-b', name: '角色乙', assetId: 'asset-Character_B', thumbnailReferenceImageId: 'ref-old-b', thumbnailUrl: '/api/reference-images/ref-old-b/content?variant=thumbnail' };
  const file = { name: 'new-cover.png', type: 'image/png', size: 2048 };
  const registration = { assetId: 'uploaded-asset', referenceImageId: 'ref-uploaded', thumbnailUrl: '/api/reference-images/ref-uploaded/content?variant=thumbnail' };
  function harness(assets = [assetA]) {
    const requests = [], directory = { assets, ready: true, error: null, loading: false, refresh: async () => {}, request(path, method, body, signal) {
      const pending = deferred(); requests.push({ path, method, body, signal, ...pending }); return pending.promise;
    } };
    const panel = panelHarness(directory, { ownerId: owner.id, epoch: 1 }); return { ...panel, requests };
  }
  async function open(panel, editing = 'edit') { await panel.click('角色资产'); await panel.click(editing === 'new' ? '新增' : '编辑'); }
  async function pick(panel, value = file) { const label = panel.nodes().find(node => node.type === 'button' && ['上传图片', '上传 / 更换图片'].includes(panel.text(node))); assert.ok(label); await panel.click(panel.text(label)); panel.file(value); }
  async function uploaded(panel) {
    assert.equal(panel.uploaded.length, 1); assert.equal(panel.uploaded[0].options.ownerId, owner.id);
    assert.equal('workspaceId' in panel.uploaded[0].options, false); panel.uploaded[0].resolve({ id: registration.assetId }); await panel.settle();
    assert.equal(panel.requests.length, 1); assert.equal(panel.requests[0].path, '/thumbnail'); assert.equal(panel.requests[0].method, 'POST');
    assert.deepEqual(panel.requests[0].body, { assetId: registration.assetId }); assert.equal(panel.requests[0].signal.aborted, false); assert.deepEqual(panel.timeoutMs, [60_000]);
  }
  await check('actual new/edit keeps old cover until ready and retains the protected selected option after close/reopen', async () => {
    for (const editing of ['new', 'edit']) {
      const panel = harness(); await open(panel, editing); const target = editing === 'new' ? 'new' : assetA.id, previous = editing === 'new' ? '' : assetA.thumbnailReferenceImageId;
      await pick(panel); assert.equal(panel.form(target).thumbnailReferenceImageId, previous); assert.equal(panel.button('保存登记').props.disabled, true);
      panel.uploaded[0].options.onProgress({ label: '正在上传', percent: 47 }); panel.render();
      assert.equal(panel.nodes().find(node => node.type === 'progress').props.value, 47);
      await uploaded(panel); assert.equal(panel.form(target).thumbnailReferenceImageId, previous);
      panel.requests[0].resolve(registration); await panel.settle(); assert.equal(panel.images.length, 1); assert.equal(panel.form(target).thumbnailReferenceImageId, previous);
      assert.equal([...panel.timers.values()][0].ms, 30_000); panel.images[0].resolve(); await panel.settle();
      assert.equal(panel.form(target).thumbnailReferenceImageId, registration.referenceImageId); assert.equal(panel.button('保存登记').props.disabled, false);
      assert.equal(panel.requests.filter(item => item.path !== '/thumbnail').length, 0, 'ready cover selection does not save or bind character');
      await panel.click('关闭角色资产'); await panel.click('角色资产');
      assert.equal(panel.form(target).thumbnailReferenceImageId, registration.referenceImageId);
      const selected = panel.button(`选择${file.name}作为缩略图`); assert.equal(selected.props['aria-pressed'], true);
      assert.ok(panel.nodes(selected).some(node => node.props?.src === registration.thumbnailUrl), 'reopened option uses the protected thumbnail endpoint');
    }
  });
  await check('unknown upload resumes the same File; registration failure retries the same Asset without reuploading', async () => {
    const unknown = harness(); await open(unknown); await pick(unknown);
    const originalFile = unknown.uploaded[0].file; unknown.uploaded[0].reject(new Error('upload outcome unknown')); await unknown.settle();
    assert.equal(unknown.form().thumbnailReferenceImageId, assetA.thumbnailReferenceImageId); assert.equal(unknown.requests.length, 0);
    await unknown.click('继续核对原上传'); assert.equal(unknown.uploaded.length, 2); assert.equal(unknown.uploaded[1].file, originalFile); assert.equal(originalFile, file);
    assert.equal(unknown.requests.length, 0, 'unknown upload is not reset or registered before an Asset receipt');
    unknown.uploaded[1].resolve({ id: registration.assetId }); await unknown.settle(); assert.equal(unknown.requests.length, 1);
    assert.deepEqual(unknown.requests[0].body, { assetId: registration.assetId }); unknown.requests[0].resolve(registration); await unknown.settle();
    unknown.images[0].resolve(); await unknown.settle(); assert.equal(unknown.form().thumbnailReferenceImageId, registration.referenceImageId);
    const panel = harness(); await open(panel); await pick(panel); await uploaded(panel);
    panel.requests[0].reject(new Error('registration unavailable')); await panel.settle(); assert.equal(panel.form().thumbnailReferenceImageId, assetA.thumbnailReferenceImageId);
    await panel.click('重试准备缩略图'); assert.equal(panel.uploaded.length, 1); assert.equal(panel.requests.length, 2);
    assert.deepEqual(panel.requests[1].body, { assetId: registration.assetId }); panel.requests[1].resolve(registration); await panel.settle();
    panel.images[0].resolve(); await panel.settle(); assert.equal(panel.form().thumbnailReferenceImageId, registration.referenceImageId);
  });
  await check('decode failure and decode timeout preserve old cover and retry uses the registered reference', async () => {
    for (const failure of ['decode', 'timeout']) {
      const panel = harness(); await open(panel); await pick(panel); await uploaded(panel); panel.requests[0].resolve(registration); await panel.settle();
      if (failure === 'decode') panel.images[0].reject(new Error('decode unavailable')); else [...panel.timers.values()][0].fn();
      await panel.settle(); assert.equal(panel.form().thumbnailReferenceImageId, assetA.thumbnailReferenceImageId);
      await panel.click('重试准备缩略图'); assert.equal(panel.uploaded.length, 1); assert.equal(panel.requests.length, 1);
      panel.images[1].resolve(); await panel.settle(); assert.equal(panel.form().thumbnailReferenceImageId, registration.referenceImageId);
    }
  });
  await check('account/epoch changes discard delayed upload and registration results without replacing current cover', async () => {
    const account = harness(); await open(account); await pick(account);
    account.setSession({ ownerId: other.id, epoch: 2 }, { ownerId: other.id }); account.uploaded[0].resolve({ id: registration.assetId }); await account.settle();
    assert.equal(account.requests.length, 0); assert.equal(account.form().thumbnailReferenceImageId, assetA.thumbnailReferenceImageId);
    const epoch = harness(); await open(epoch); await pick(epoch); await uploaded(epoch); epoch.setSession({ epoch: 2 });
    epoch.requests[0].resolve(registration); await epoch.settle(); assert.equal(epoch.images.length, 0); assert.equal(epoch.form().thumbnailReferenceImageId, assetA.thumbnailReferenceImageId);
  });
  await check('target changes and a delayed file-dialog choice cannot apply an old thumbnail to another editor', async () => {
    const panel = harness([assetA, assetB]); await panel.click('角色资产');
    const editButtons = panel.nodes().filter(node => node.type === 'button' && panel.text(node) === '编辑'); assert.equal(editButtons.length, 2);
    editButtons[0].props.onClick(); panel.render(); await pick(panel); await uploaded(panel);
    await panel.click('关闭角色资产'); editButtons[1].props.onClick(); panel.render(); await panel.click('角色资产');
    panel.requests[0].resolve(registration); await panel.settle(); panel.images[0].resolve(); await panel.settle();
    assert.equal(panel.form(assetB.id).thumbnailReferenceImageId, assetB.thumbnailReferenceImageId);
    const dialog = harness(); await open(dialog); await dialog.click('上传 / 更换图片');
    const delayedFileInput = dialog.nodes().find(node => node.type === 'input' && node.props.type === 'file');
    await dialog.click('关闭角色资产'); const target = { files: [file], value: 'fixture-file' }; delayedFileInput.props.onChange({ target, currentTarget: target }); await dialog.settle();
    assert.equal(dialog.uploaded.length, 0); assert.equal(dialog.requests.length, 0); assert.equal(dialog.form().thumbnailReferenceImageId, assetA.thumbnailReferenceImageId);
  });
}
try { await main(); }
catch (error) { console.error(error); process.exitCode = 1; }
finally { await prisma.$disconnect(); globalThis.fetch = originalFetch; fs.rmSync(temporary, { recursive: true, force: true }); }
