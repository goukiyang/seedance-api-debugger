import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire, Module, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependencyIndex = process.argv.indexOf('--dependency-root');
const require = createRequire(path.join(dependencyIndex < 0 ? root : path.resolve(process.argv[dependencyIndex + 1]), 'package.json'));
const ts = require('typescript'), sharp = require('sharp');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-thumbnail-complete-'));
const previousCwd = process.cwd(), checks = [], sourceSha256 = {}, cache = new Map();
let networkCalls = 0, rawOriginalResponses = 0, allowed = true, downloadable = false;
const user = { id: 'fixture-owner', status: 'active' };
class AuthError extends Error { constructor(message, status = 403) { super(message); this.status = status; } }
class ReactionError extends AuthError {}
class NextResponse extends Response {
  static json(value, init) { return new NextResponse(JSON.stringify(value), { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } }); }
  static redirect(url, init) { return new NextResponse(null, { ...init, headers: { ...init?.headers, Location: String(url) } }); }
}
let reference, content;
const blocked = () => { networkCalls++; throw new Error('External I/O forbidden in thumbnail engineering'); };
const modules = new Map([
  ['server-only', {}], ['next/server', { NextResponse }],
  ['@/lib/auth/session', { AuthError, getSession: async () => allowed ? user : null }],
  ['@/lib/content-reactions/http', { reactionUser: async () => { if (!allowed) throw new ReactionError('denied', 401); return user; },
    reactionError: error => NextResponse.json({ error: error instanceof AuthError ? error.message : 'unavailable' }, { status: error.status || 503 }) }],
  ['@/lib/content-reactions/content', { ReactionError, parseContentKey: key => key, resolveContent: async () => allowed ? content : null }],
  ['@/lib/reference-albums/permissions', { assertCanViewReferenceImage: async () => { if (!allowed) throw new AuthError('denied'); return reference; },
    canDownloadOriginal: async () => downloadable, canUseAlbumImage: async () => false }],
  ['@/lib/media/preview-response', { previewMime: (_url, mime) => mime, mediaPreviewResponse: async () => { rawOriginalResponses++; return new Response('raw-original'); } }],
  ['@/lib/media/hd-derivatives', { removeHdViewingToken: async () => {}, hdControl: blocked, hdDirectory: blocked, hdRepresentationVersion: blocked, lookupHd: blocked, requestHd: blocked }],
  ['@/lib/media/hd-encoder', { hdEncoderStrategy: blocked }],
  ['@/lib/media/image-comparison-version', { comparisonOriginalVersion: blocked }],
]);
function source(file) { const value = fs.readFileSync(path.join(root, file), 'utf8'); sourceSha256[file] = createHash('sha256').update(value).digest('hex'); return value; }
function load(file) {
  const filename = path.resolve(root, file); if (cache.has(filename)) return cache.get(filename).exports;
  const code = ts.transpileModule(source(file), { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = new Module(filename); mod.filename = filename; cache.set(filename, mod);
  mod.require = name => {
    if (modules.has(name)) return modules.get(name);
    if (name === 'node:https') return { get: blocked };
    if (name === 'node:dns/promises') return { lookup: blocked };
    if (name === 'sharp') return sharp;
    if (isBuiltin(name)) return require(name);
    if (name.startsWith('@/')) return load(`src/${name.slice(2)}.ts`);
    if (name.startsWith('.')) {
      const relative = path.relative(root, path.resolve(path.dirname(filename), `${name}.ts`));
      const alias = `@/${relative.replace(/^src\//, '').replace(/\.ts$/, '')}`;
      return modules.has(alias) ? modules.get(alias) : load(relative);
    }
    throw new Error(`Unmocked dependency ${name}`);
  };
  mod._compile(code, filename); return mod.exports;
}
async function check(label, action) { try { await action(); assert.equal(networkCalls, 0); checks.push(label); } catch (error) { error.message = `${label}: ${error.message}`; throw error; } }
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const filePath = url => path.join(temporary, 'public', url);
const readBytes = async response => Buffer.from(await response.arrayBuffer());
const request = (url, method = 'GET', headers = {}) => Object.assign(new Request(`https://fixture.invalid${url}`, { method, headers }), { nextUrl: new URL(`https://fixture.invalid${url}`) });
async function picture(name, width, height, format = 'png') {
  const pixels = Buffer.alloc(width * height * 3, 240);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const start = (y * width + x) * 3;
    if (x < width / 8) { pixels[start] = 255; pixels[start + 1] = 0; pixels[start + 2] = 0; }
    if (x >= width * 7 / 8) { pixels[start] = 0; pixels[start + 1] = 0; pixels[start + 2] = 255; }
  }
  const url = `/uploads/assets/${name}.${format}`;
  const bytes = await sharp(pixels, { raw: { width, height, channels: 3 } }).toFormat(format).toBuffer();
  await fsp.writeFile(filePath(url), bytes); return { url, bytes, width, height };
}
function bitmap(width = 800, height = 400) {
  const stride = Math.ceil(width * 3 / 4) * 4, bytes = Buffer.alloc(54 + stride * height);
  bytes.write('BM'); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(54, 10); bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18); bytes.writeInt32LE(height, 22); bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28); bytes.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const start = 54 + y * stride + x * 3; bytes[start] = x >= width * 7 / 8 ? 255 : 0; bytes[start + 2] = x < width / 8 ? 255 : 0; }
  return bytes;
}
async function fullEdges(bytes, width, height) {
  const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, width); assert.equal(info.height, height);
  const left = (Math.floor(height / 2) * width + Math.floor(width / 16)) * info.channels;
  const right = (Math.floor(height / 2) * width + Math.floor(width * 15 / 16)) * info.channels;
  assert.ok(data[left] > 180 && data[left + 2] < 75, 'left original edge survives');
  assert.ok(data[right + 2] > 180 && data[right] < 75, 'right original edge survives');
}
function declaration(file, name, bindings) {
  const text = source(file), tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const node = tree.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name); assert.ok(node, name);
  const code = ts.transpileModule(`${node.getText(tree)}\nmodule.exports = ${name};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} }; Function(...Object.keys(bindings), 'module', code)(...Object.values(bindings), mod); return mod.exports;
}
async function main() {
  source('scripts/legacy-thumbnail-complete-engineering.mjs');
  await fsp.mkdir(path.join(temporary, 'public/uploads/assets'), { recursive: true }); await fsp.mkdir(path.join(temporary, 'public/uploads/thumbs'));
  process.chdir(temporary);
  const wide = await picture('original-wide', 800, 400), tall = await picture('original-tall', 400, 800), square = await picture('original-square', 800, 800);
  const crop = await sharp(wide.bytes).resize(300, 450, { fit: 'cover', position: 'center' }).png().toBuffer();
  const oldUrl = '/uploads/thumbs/legacy-crop.png'; await fsp.writeFile(filePath(oldUrl), crop);
  const originals = new Map([wide, tall, square].map(item => [item.url, hash(item.bytes)])); originals.set(oldUrl, hash(crop));
  reference = { id: 'fixture-ref', owner_user_id: user.id, url: wide.url, thumbnail_url: oldUrl, asset: { id: 'fixture-asset', owner_id: user.id, status: 'active', type: 'image', mime_type: 'image/png', file_name: 'wide.png' } };
  content = { summary: { category: 'image', title: 'fixture', downloadUrl: null, previewUrl: '/preview' }, source: { url: wide.url, thumbnail: oldUrl, mimeType: 'image/png' } };
  const media = load('src/lib/image-studio/media.ts'); modules.set('@/lib/image-studio/media', media);
  const authorized = load('src/lib/media/authorized-image-response.ts'); modules.set('@/lib/media/authorized-image-response', authorized);
  const contentRoute = load('src/app/api/content-reactions/media/route.ts'), refRoute = load('src/app/api/reference-images/[id]/content/route.ts');
  await check('historical crop cache is ignored; active content/reference thumbnails retain full original edges and proportions', async () => {
    await media.readStudioThumbnail(oldUrl); // Reproduce an existing derived cache of the old cropped file.
    for (const response of [await contentRoute.GET(request('/api/content-reactions/media?key=asset:fixture&variant=thumbnail')), await refRoute.GET(request('/api/reference-images/fixture-ref/content?variant=thumbnail'), { params: { id: reference.id } })]) {
      assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/webp'); await fullEdges(await readBytes(response), 640, 320);
    }
    for (const [item, width, height] of [[tall, 320, 640], [square, 640, 640]]) await fullEdges(await media.readStudioThumbnail(item.url), width, height);
  });
  await check('view-only preview/detail remain 640px derivatives; original/download/HD permissions stay closed', async () => {
    for (const variant of ['preview', 'detail']) { const response = await refRoute.GET(request(`/api/reference-images/fixture-ref/content?variant=${variant}`), { params: { id: reference.id } }); assert.equal(response.status, 200); await fullEdges(await readBytes(response), 640, 320); }
    for (const variant of ['original', 'download', 'hd', 'hd-description', 'hd-download']) assert.equal((await refRoute.GET(request(`/api/reference-images/fixture-ref/content?variant=${variant}`), { params: { id: reference.id } })).status, 403);
    assert.equal(rawOriginalResponses, 0);
  });
  await check('cold HEAD/prefetch stay read-only; warm HEAD/ETag304 bind the same original-derived cache', async () => {
    const cold = await picture('cold', 800, 400); assert.equal(await media.statStudioDisplayImage(cold.url, 'thumbnail'), null);
    for (const req of [request('/cold', 'HEAD'), request('/cold', 'GET', { 'x-image-read-intent': 'prefetch' })]) assert.equal((await authorized.authorizedImageResponse(req, cold.url, 'thumbnail', 'image/png')).status, 409);
    assert.equal(await media.statStudioDisplayImage(cold.url, 'thumbnail'), null);
    assert.equal((await authorized.authorizedImageResponse(request('/remote', 'HEAD'), 'https://public.fixture.invalid/picture.png', 'thumbnail', 'image/png')).status, 409);
    const ready = await authorized.authorizedImageResponse(request('/cold'), cold.url, 'thumbnail', 'image/png'); const etag = ready.headers.get('etag'); await readBytes(ready); assert.ok(etag);
    const head = await authorized.authorizedImageResponse(request('/cold', 'HEAD'), cold.url, 'thumbnail', 'image/png'); assert.equal(head.status, 200); assert.equal(head.headers.get('etag'), etag); assert.equal((await readBytes(head)).length, 0);
    const unchanged = await authorized.authorizedImageResponse(request('/cold', 'GET', { 'if-none-match': etag }), cold.url, 'thumbnail', 'image/png'); assert.equal(unchanged.status, 304); assert.equal((await readBytes(unchanged)).length, 0);
    await fsp.writeFile(filePath(cold.url), await sharp({ create: { width: 800, height: 400, channels: 3, background: 'green' } }).png().toBuffer());
    const changed = await authorized.authorizedImageResponse(request('/cold', 'HEAD', { 'if-none-match': etag }), cold.url, 'thumbnail', 'image/png'); assert.equal(changed.status, 409);
    const next = await authorized.authorizedImageResponse(request('/cold'), cold.url, 'thumbnail', 'image/png'); assert.equal(next.status, 200); assert.notEqual(next.headers.get('etag'), etag); await readBytes(next);
  });
  await check('current permission loss and missing original fail closed instead of serving a cached legacy crop', async () => {
    allowed = false; try { assert.equal((await contentRoute.GET(request('/api/content-reactions/media?key=asset:fixture&variant=thumbnail'))).status, 401); assert.equal((await refRoute.GET(request('/api/reference-images/fixture-ref/content?variant=thumbnail'), { params: { id: reference.id } })).status, 401); } finally { allowed = true; }
    reference.url = '/uploads/assets/missing.png'; const failed = await refRoute.GET(request('/api/reference-images/fixture-ref/content?variant=thumbnail'), { params: { id: reference.id } }); assert.equal(failed.status, 502); reference.url = wide.url;
    assert.equal(rawOriginalResponses, 0);
  });
  await check('supported BMP derives a complete bounded WebP; oversize headers fail without fallback or original mutation', async () => {
    const bmpUrl = '/uploads/assets/original.bmp', bmp = bitmap(); await fsp.writeFile(filePath(bmpUrl), bmp); originals.set(bmpUrl, hash(bmp));
    await fullEdges(await media.readStudioThumbnail(bmpUrl), 640, 320);
    await media.readStudioPreview(bmpUrl);
    const bad = Buffer.from(bmp); bad.writeInt32LE(40_000_001, 18); const badUrl = '/uploads/assets/oversize.bmp'; await fsp.writeFile(filePath(badUrl), bad);
    await assert.rejects(() => media.readStudioThumbnail(badUrl));
    assert.equal((await fsp.readdir(path.join(temporary, 'storage/studio-thumbnails'))).some(name => name.startsWith('bmp-display-')), false);
  });
  await check('JPEG/GIF/WebP sources still produce complete proportional thumbnails within the original pixel limit', async () => {
    for (const format of ['jpeg', 'gif', 'webp']) { const item = await picture(`format-${format}`, 800, 400, format); await fullEdges(await media.readStudioThumbnail(item.url), 640, 320); }
    const excessive = await sharp({ create: { width: 40_000, height: 1001, channels: 3, background: 'white' } }).png().toBuffer(); const url = '/uploads/assets/excessive.png'; await fsp.writeFile(filePath(url), excessive); await assert.rejects(() => media.readStudioThumbnail(url));
  });
  await check('active library/workspace image DTOs use authorized endpoints while inactive history and nonimage posters retain their contract', async () => {
    const bindings = { publicAssetUrl: value => value, userSummary: value => value, legacyAssetOwnerSummary: () => null, nonTaskDeliveryStage: () => ({}) };
    const serializeAsset = declaration('src/app/api/assets/library/route.ts', 'serializeAsset', bindings), serializeReferenceImage = declaration('src/app/api/assets/library/route.ts', 'serializeReferenceImage', bindings);
    const asset = { id: 'fixture-asset', type: 'image', status: 'active', original_url: wide.url, thumbnail_url: oldUrl, owner_id: user.id, created_at: new Date() };
    assert.match(serializeAsset(asset).thumbnailUrl, /^\/api\/content-reactions\/media\?.*&variant=thumbnail$/);
    assert.equal(serializeAsset({ ...asset, status: 'deleted' }).thumbnailUrl, oldUrl); assert.equal(serializeAsset({ ...asset, status: 'hidden' }).thumbnailUrl, oldUrl); assert.equal(serializeAsset({ ...asset, type: 'video' }).thumbnailUrl, oldUrl);
    const ref = { id: 'fixture-ref', status: 'active', url: wide.url, thumbnail_url: oldUrl, created_at: new Date(), asset: null };
    assert.equal(serializeReferenceImage(ref).thumbnailUrl, '/api/reference-images/fixture-ref/content?variant=thumbnail'); assert.equal(serializeReferenceImage({ ...ref, status: 'deleted' }).thumbnailUrl, oldUrl); assert.equal(serializeReferenceImage({ ...ref, asset: { status: 'hidden' } }).thumbnailUrl, oldUrl);
    let workspaceAssets = [{ id: 'wa', asset, reference_image_id: null, reference_image: null }];
    modules.set('@/lib/prisma', { prisma: { workspace: { findUnique: async () => ({ id: 'fixture-workspace' }) }, workspaceAsset: { findMany: async () => workspaceAssets } } });
    modules.set('uuid', { v4: () => 'fixture-id' });
    const workspace = load('src/lib/assets/workspace.ts');
    assert.match((await workspace.getWorkspaceWithAssets('fixture-workspace')).assets[0].thumbnailUrl, /^\/api\/content-reactions\/media\?/);
    workspaceAssets[0].reference_image_id = ref.id; workspaceAssets[0].reference_image = { id: ref.id, status: 'active', album: { id: 'fixture-album', name: 'fixture', status: 'active' } }; assert.equal((await workspace.getWorkspaceWithAssets('fixture-workspace')).assets[0].thumbnailUrl, '/api/reference-images/fixture-ref/content?variant=thumbnail');
    workspaceAssets = [{ ...workspaceAssets[0], asset: { ...asset, type: 'video' } }]; assert.equal((await workspace.getWorkspaceWithAssets('fixture-workspace')).assets[0].thumbnailUrl, oldUrl);
  });
  // Join the same finite background preview work before removing the private fixture directory.
  const displayFiles = (await fsp.readdir(path.join(temporary, 'public/uploads/assets'))).filter(name => !/^(queue-|oversize|excessive)/.test(name));
  await Promise.all(displayFiles.map(name => media.readStudioPreview(`/uploads/assets/${name}`)));
  await media.readStudioPreview(oldUrl);
  await check('existing two-active/32-pending derivative queue remains bounded for first reads of original sources', async () => {
    for (let index = 0; index < 33; index++) await fsp.writeFile(filePath(`/uploads/assets/queue-${index}.png`), wide.bytes);
    const originalRead = fsp.readFile, releases = [], results = Array(33); let active = 0, peak = 0;
    fsp.readFile = async (file, ...args) => {
      if (!String(file).includes('/uploads/assets/queue-')) return originalRead(file, ...args);
      active++; peak = Math.max(peak, active);
      try { await new Promise(resolve => releases.push(resolve)); return await originalRead(file, ...args); }
      finally { active--; }
    };
    try {
      const jobs = Array.from({ length: 33 }, (_, index) => media.readStudioDetail(`/uploads/assets/queue-${index}.png`)
        .then(() => { results[index] = 'ready'; }, () => { results[index] = 'rejected'; }));
      const deadline = Date.now() + 15_000;
      while (!(active === 2 && results.includes('rejected'))) { assert.ok(Date.now() < deadline, 'queue reaches bounded active state'); await new Promise(resolve => setTimeout(resolve, 10)); }
      while (results.filter(Boolean).length !== 33) { while (releases.length) releases.shift()(); assert.ok(Date.now() < deadline, 'queued derivatives finish'); await new Promise(resolve => setTimeout(resolve, 10)); }
      await Promise.all(jobs); assert.equal(peak, 2); assert.equal(results.filter(value => value === 'rejected').length, 1);
    } finally { while (releases.length) releases.shift()(); fsp.readFile = originalRead; }
  });
  await check('originals and historical crop files remain byte-identical; no database or public media is rewritten', async () => {
    for (const [url, digest] of originals) assert.equal(hash(await fsp.readFile(filePath(url))), digest, url);
    assert.equal(rawOriginalResponses, 0); assert.equal(networkCalls, 0);
  });
  console.log(JSON.stringify({ passed: checks.length, checks, sourceSha256, runtime: { typescript: require('typescript/package.json').version, sharp: sharp.versions.sharp },
    isolation: { temporaryMedia: true, realUserFiles: 0, networkCalls, productionDatabaseAccess: 0, productionWrites: 0, modelCalls: 0, browserRuns: 0 }, boundary: 'Targeted engineering with synthetic media and mocked authorization boundaries; user interface remains for manual acceptance.' }, null, 2));
}
try { await main(); }
catch (error) { console.error(error); process.exitCode = 1; }
finally { process.chdir(previousCwd); await fsp.rm(temporary, { recursive: true, force: true }); }
