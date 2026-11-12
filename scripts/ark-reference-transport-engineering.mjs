import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire, isBuiltin, Module } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript'), sharp = require('sharp');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-reference-transport-'));
const previousCwd = process.cwd(), realFetch = globalThis.fetch;
const sourceSha256 = {}, checks = [], cache = new Map(), modules = new Map(), assets = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let externalRequests = 0, mockRequests = 0, mockSettingsReads = 0, privateSends = 0, derivativeCount = 0;
const denied = () => { externalRequests++; throw Error('Real network is prohibited'); };
globalThis.fetch = denied;
const owner = { id: 'fixture-owner' };
modules.set('server-only', {});
modules.set('@/lib/integrations/volcengine-ip', {
  VOLCENGINE_IP_CREATE_TASK_PATH: '/contents/generations/tasks',
  getVolcengineIpApiSettings: async () => { mockSettingsReads++; return { enabled: true, api_key: 'fixture-only-key', default_model: 'doubao-seedance-2-5-260628', base_url: 'https://ark.fixture.invalid/api/v3' }; },
  isVolcengineIpApiReady: () => true,
});
modules.set('@/lib/security/private-prompts.server', { isPrivatePromptError: () => false });
modules.set('@/lib/security/private-prompt-send.server', {
  assertPrivateSend: () => {}, privatePromptFetch: async (identity, _origins, init, transport) => { privateSends++; return transport(identity.endpoint, init); },
});
modules.set('@/lib/video/private-storage.server', { privateMultiviewOrigins: () => [] });
modules.set('@/lib/video/multiview-task-privacy', { privateMultiviewFailure: () => undefined });
modules.set('@/lib/assets/site-upload', { uploadSiteAsset: async (bytes, _name, mimeType) => {
  const id = `fixture-derived-${++derivativeCount}`, url = `/uploads/assets/${id}.${mimeType === 'image/jpeg' ? 'jpg' : 'png'}`;
  await fsp.writeFile(path.join(temporary, 'public', url), bytes, { flag: 'wx' });
  const asset = { id, original_url: url, owner_id: owner.id, status: 'active', type: 'image', mime_type: mimeType, file_size: bytes.length };
  assets.set(id, asset); return { assetId: id, originalUrl: url, isPubliclyReachable: true };
} });
function source(file) {
  const bytes = fs.readFileSync(path.join(root, file)); sourceSha256[file] = hash(bytes); return bytes.toString('utf8');
}
function load(file) {
  const filename = path.resolve(root, file); if (cache.has(filename)) return cache.get(filename).exports;
  const text = source(file), mod = new Module(filename); mod.filename = filename; cache.set(filename, mod);
  mod.require = name => {
    if (modules.has(name)) return modules.get(name);
    if (isBuiltin(name)) return require(name);
    if (name === 'sharp') return sharp;
    if (name.startsWith('@/') || name.startsWith('.')) {
      const next = name.startsWith('@/') ? `src/${name.slice(2)}.ts` : path.relative(root, path.resolve(path.dirname(filename), `${name}.ts`));
      const alias = `@/${next.replace(/^src\//, '').replace(/\.ts$/, '')}`;
      return modules.has(alias) ? modules.get(alias) : load(next);
    }
    throw Error(`Unmocked dependency ${name}`);
  };
  const compiled = ts.transpileModule(text, { fileName: filename, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
  assert.equal((compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0, file);
  mod._compile(compiled.outputText, filename); return mod.exports;
}
function declaration(file, name, bindings) {
  const text = source(file), tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const node = tree.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name); assert.ok(node, name);
  const code = ts.transpileModule(`${node.getText(tree)}\nmodule.exports = ${name};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} }; Function(...Object.keys(bindings), 'module', code)(...Object.values(bindings), mod); return mod.exports;
}
async function check(name, run) { await run(); assert.equal(externalRequests, 0); checks.push(name); }
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const dataUrl = (bytes, mime = 'image/png') => `data:${mime};base64,${bytes.toString('base64')}`;
async function main() {
  source('scripts/ark-reference-transport-engineering.mjs');
  await fsp.mkdir(path.join(temporary, 'public/uploads/assets'), { recursive: true });
  await fsp.mkdir(path.join(temporary, 'public/uploads/thumbs'));
  process.chdir(temporary);
  const transport = load('src/lib/provider/reference-image-transport.ts');
  const ark = load('src/lib/provider/volcengine-ip.ts');
  const safety = load('src/lib/provider/reference-image-safety.ts');
  const site = load('src/lib/assets/site-url.ts');
  const models = ['doubao-seedance-2-0-pro-260215', 'doubao-seedance-2-5-260628'];
  const firstBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
  const secondBytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: 'blue' } }).png().toBuffer();
  async function original(name, bytes = firstBytes, mime = 'image/png', dimensions = { width: 2, height: 2 }) {
    const url = `https://sd2.youdooart.com/uploads/assets/${name}.png`;
    const asset = { id: name, owner_id: owner.id, original_url: url, status: 'active', type: 'image', mime_type: mime, file_size: bytes.length, ...dimensions };
    await fsp.writeFile(path.join(temporary, 'public', site.siteUploadPathFromUrl(url)), bytes, { flag: 'wx' });
    return { url, asset };
  }
  const first = await original('first'), second = await original('second', secondBytes);
  const originals = new Map([[first.url, hash(firstBytes)], [second.url, hash(secondBytes)]]);
  const base = { generation_mode: 'all_in_one_reference', prompt: '图片1和图片2 synthetic', duration: 10, resolution: '480p', ratio: '16:9',
    callback_url: 'https://callback.fixture.invalid/original', client_request_id: '00000000-1111-2222-3333-444444444444', generate_audio: true };
  await check('actual Ark SDK outbound uses exact local bytes for both models and all three modes', async () => {
    for (const model of models) for (const mode of ['all_in_one_reference', 'first_last_frame', 'smart_multi_frame']) {
      const input = { ...base, model, generation_mode: mode, reference_image_urls: [second.url, first.url],
        first_frame_url: second.url, last_frame_url: first.url, frame_image_urls: [second.url, first.url, second.url] };
      const frozen = structuredClone(input), patch = await ark.volcengineIpLocalReferenceTransport(input, [first, second]);
      let sent;
      await ark.createVolcengineIpVideoTask({ ...input, ...patch }, { fetchImpl: async (url, init) => {
        mockRequests++; assert.match(String(url), /^https:\/\/ark\.fixture\.invalid\/api\/v3\/contents\/generations\/tasks$/);
        assert.equal(new Headers(init.headers).has('cookie'), false); sent = JSON.parse(init.body); return json({ id: 'fixture-task' });
      } });
      assert.equal(sent.model, model); assert.equal(sent.callback_url, input.callback_url); assert.equal(sent.client_request_id, input.client_request_id);
      assert.equal(sent.content[0].type, 'text');
      const images = sent.content.filter(item => item.type === 'image_url');
      assert.deepEqual(images.map(item => item.image_url.url), mode === 'smart_multi_frame'
        ? [dataUrl(secondBytes), dataUrl(firstBytes), dataUrl(secondBytes)] : [dataUrl(secondBytes), dataUrl(firstBytes)]);
      assert.deepEqual(images.map(item => item.role), mode === 'first_last_frame' ? ['first_frame', 'last_frame'] : images.map(() => 'reference_image'));
      assert.deepEqual(input, frozen); assert.ok(Buffer.byteLength(JSON.stringify(sent)) < 64_000_000);
    }
  });
  await check('mixed role asset, public URL and local images retain their original positions without image HTTP reads', async () => {
    const urls = ['asset://asset-FixtureRole', second.url, 'https://public.fixture.invalid/original.png', first.url];
    const input = { ...base, model: models[1], reference_image_urls: urls }, patch = await ark.volcengineIpLocalReferenceTransport(input, [first, second]);
    const content = ark.buildVolcengineIpCreatePayload({ ...input, ...patch }).content;
    assert.deepEqual(content.slice(1).map(item => item.image_url.url), [urls[0], dataUrl(secondBytes), urls[2], dataUrl(firstBytes)]);
    assert.ok(content.slice(1).every(item => item.role === 'reference_image')); assert.deepEqual(input.reference_image_urls, urls);
  });
  await check('Ark MIME policy preserves supported raw bytes and aliases while ordinary policy stays unchanged', async () => {
    const formats = { 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/png': 'image/png', 'image/webp': 'image/webp',
      'image/bmp': 'image/bmp', 'image/x-ms-bmp': 'image/bmp', 'image/tiff': 'image/tiff', 'image/gif': 'image/gif' };
    for (const model of models) for (const [mime, expected] of Object.entries(formats)) {
      const patch = await ark.volcengineIpLocalReferenceTransport({ ...base, model, reference_image_urls: [first.url] }, [{ ...first, asset: { ...first.asset, mime_type: mime } }]);
      assert.equal(patch.reference_image_base64_data[0], dataUrl(firstBytes, expected));
    }
    for (const mime of ['image/heic', 'image/heif']) {
      assert.equal((await ark.volcengineIpLocalReferenceTransport({ ...base, model: models[0], reference_image_urls: [first.url] }, [{ ...first, asset: { ...first.asset, mime_type: mime } }])).reference_image_base64_data[0], dataUrl(firstBytes, mime));
      await assert.rejects(() => ark.volcengineIpLocalReferenceTransport({ ...base, model: models[1], reference_image_urls: [first.url] }, [{ ...first, asset: { ...first.asset, mime_type: mime } }]), /格式/);
    }
    const ordinary = { ...base, model: 'dreamina-seedance-2-5-260628', reference_image_urls: [first.url] };
    assert.equal((await transport.seedanceLocalReferenceTransport(ordinary, [first])).reference_image_base64_data[0], dataUrl(firstBytes));
    await assert.rejects(() => transport.seedanceLocalReferenceTransport(ordinary, [{ ...first, asset: { ...first.asset, mime_type: 'image/bmp' } }]), /格式/);
  });
  await check('size limits reject before reading and count repeated content, callback and reserved client ID budget', async () => {
    let reads = 0; const noRead = async () => { reads++; throw Error('must reject before reading'); };
    const input = { ...base, model: models[1], reference_image_urls: [first.url] };
    await assert.rejects(() => ark.volcengineIpLocalReferenceTransport(input, [{ ...first, asset: { ...first.asset, file_size: 30_000_000 } }], noRead), /30MB/);
    await assert.rejects(() => ark.volcengineIpLocalReferenceTransport({ ...input, reference_image_urls: [first.url, first.url, first.url] }, [{ ...first, asset: { ...first.asset, file_size: 20_000_000 } }], noRead), /64MB/);
    // Two individually legal images plus the callback exceed the complete body limit.
    await assert.rejects(() => ark.volcengineIpLocalReferenceTransport({ ...input, callback_url: `https://callback.fixture.invalid/${'x'.repeat(4000)}`, reference_image_urls: [first.url, second.url] },
      [first, second].map(item => ({ ...item, asset: { ...item.asset, file_size: 23_999_000 } })), noRead), /64MB/);
    assert.equal(reads, 0);
  });
  await check('authorization, deleted records, metadata version and realpath guards do not expose another local file', async () => {
    const input = { ...base, model: models[1], reference_image_urls: [first.url] };
    assert.deepEqual(await ark.volcengineIpLocalReferenceTransport(input, []), {});
    assert.deepEqual(await ark.volcengineIpLocalReferenceTransport(input, [{ ...first, asset: { ...first.asset, status: 'deleted' } }]), {});
    await assert.rejects(() => transport.readAuthorizedLocalReferenceOriginal(first.url, []), /授权/);
    await assert.rejects(() => ark.volcengineIpLocalReferenceTransport(input, [{ ...first, asset: { ...first.asset, file_size: firstBytes.length + 1 } }]), /记录不一致/);
    const outside = path.join(temporary, 'outside.png'); await fsp.writeFile(outside, firstBytes);
    const escape = 'https://sd2.youdooart.com/uploads/assets/escape.png';
    await fsp.symlink(outside, path.join(temporary, 'public/uploads/assets/escape.png'));
    await assert.rejects(() => ark.volcengineIpLocalReferenceTransport({ ...input, reference_image_urls: [escape] }, [{ url: escape, asset: { ...first.asset, original_url: escape } }]), /路径/);
    const thumb = 'https://sd2.youdooart.com/uploads/thumbs/crop.png';
    assert.deepEqual(await ark.volcengineIpLocalReferenceTransport({ ...input, reference_image_urls: [thumb] }, [{ url: thumb, asset: { ...first.asset, original_url: thumb } }]), {});
  });

  const routeFile = 'src/app/api/ip/tasks/create/route.ts', route = source(routeFile);
  const tree = ts.createSourceFile(routeFile, route, ts.ScriptTarget.Latest, true), calls = [], tries = [], declarations = [];
  function walk(node) { if (ts.isCallExpression(node)) calls.push(node); if (ts.isTryStatement(node)) tries.push(node); if (ts.isVariableDeclaration(node)) declarations.push(node); ts.forEachChild(node, walk); } walk(tree);
  const authorized = declaration(routeFile, 'isAuthorizedReferenceOriginal', { siteUploadPathFromUrl: site.siteUploadPathFromUrl });
  const db = { workspaceAsset: { findMany: async () => workspaceRows }, asset: { findFirst: async ({ where }) => {
    const asset = assets.get(where.id); return asset && Object.entries(where).every(([key, value]) => asset[key] === value) ? asset : null;
  } } };
  let workspaceRows = [];
  const prepare = declaration(routeFile, 'prepareReferenceImages', { uniquePreserveOrder: values => [...new Set(values)], prisma: db, path, fs,
    isLocalhostHost: () => false, getProviderSafeImageResizeDimensions: safety.getProviderSafeImageResizeDimensions,
    ensureProviderSafeReferenceImageUrl: safety.ensureProviderSafeReferenceImageUrl, isProviderReferenceImageSizeError: safety.isProviderReferenceImageSizeError,
    providerReferenceImageSizeMessage: safety.providerReferenceImageSizeMessage, siteUploadPathFromUrl: site.siteUploadPathFromUrl,
    isAuthorizedReferenceOriginal: authorized, readAuthorizedLocalReferenceOriginal: transport.readAuthorizedLocalReferenceOriginal,
  });
  const transportTry = tries.find(node => node.tryBlock.getText(tree).includes('ipReferenceTransport = await volcengineIpLocalReferenceTransport(')); assert.ok(transportTry);
  const runRoutePreparation = (preparedImages, generationReferenceImages, providerInput) => {
    const context = { preparedImages, generationReferenceImages, providerInput, selectedModel: models[1], user: owner, prisma: db,
      isAuthorizedReferenceOriginal: authorized, volcengineIpLocalReferenceTransport: ark.volcengineIpLocalReferenceTransport,
      errorJson: (error, status) => ({ error, status }) };
    const code = ts.transpileModule(`async function execute() { let ipReferenceTransport = {}; ${transportTry.getText(tree)}; return ipReferenceTransport; } module.exports = execute;`,
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const mod = { exports: {} }; Function(...Object.keys(context), 'module', code)(...Object.values(context), mod); return mod.exports();
  };
  await check('actual preparation uses authorized local bytes for unknown dimensions and binds the current derivative rather than its original', async () => {
    const unknown = { ...first, asset: { ...first.asset, width: null, height: null } };
    workspaceRows = [{ reference_image_id: 'unknown', asset: unknown.asset }];
    const same = await prepare('fixture-workspace', ['unknown'], [], owner.id, false, [unknown]);
    assert.equal(same.prepareErrors.length, 0); assert.equal(same.preparedImages[0].originalUrl, first.url);
    const wideBytes = await sharp({ create: { width: 8193, height: 2, channels: 3, background: 'green' } }).png().toBuffer();
    const wide = await original('wide', wideBytes, 'image/png', { width: 8193, height: 2 }); originals.set(wide.url, hash(wideBytes));
    workspaceRows = [{ reference_image_id: 'wide', asset: wide.asset }];
    const result = await prepare('fixture-workspace', ['wide'], [], owner.id, false, [wide]);
    assert.equal(result.prepareErrors.length, 0); const prepared = result.preparedImages[0];
    assert.ok(prepared.providerAssetId); assert.equal(prepared.sourceOriginalUrl, wide.url); assert.notEqual(prepared.originalUrl, wide.url);
    const derived = await fsp.readFile(path.join(temporary, 'public', prepared.originalUrl));
    const patch = await runRoutePreparation([prepared], [wide], { ...base, reference_image_urls: [prepared.originalUrl] });
    assert.equal(patch.reference_image_base64_data[0], dataUrl(derived, assets.get(prepared.providerAssetId).mime_type)); assert.notEqual(hash(derived), hash(wideBytes));
    const unauthorized = await runRoutePreparation([prepared], [], { ...base, reference_image_urls: [prepared.originalUrl] }); assert.deepEqual(unauthorized, {});
    assets.get(prepared.providerAssetId).status = 'deleted';
    assert.equal((await runRoutePreparation([prepared], [wide], { ...base, reference_image_urls: [prepared.originalUrl] })).status, 400);
  });
  await check('actual route prepares before snapshots and reserve, sends transient patch only to the SDK and leaves history URL based', async () => {
    assert.ok(transportTry.end < route.indexOf('const snapshot = await createTaskSnapshot('));
    assert.ok(transportTry.end < route.indexOf('const task = await tx.videoTask.create('));
    const sdkCall = calls.find(call => call.expression.getText(tree) === 'createVolcengineIpVideoTask'); assert.ok(sdkCall);
    assert.match(sdkCall.arguments[0].getText(tree), /\.\.\.providerInput,\s*\.\.\.ipReferenceTransport,\s*model: selectedModel/);
    const snapshot = calls.find(call => call.expression.getText(tree) === 'createTaskSnapshot'); assert.ok(snapshot);
    assert.ok(!snapshot.getText(tree).includes('ipReferenceTransport'));
    const request = calls.find(call => call.expression.getText(tree) === 'createProviderApiRequest'); assert.ok(request);
    assert.ok(!request.getText(tree).includes('ipReferenceTransport'));
    assert.ok(calls.find(call => call.expression.getText(tree) === 'prepareReferenceImages').getText(tree).includes('generationReferenceImages'));
  });

  await check('actual SDK failure diagnostics preserve safe code, parameter, upstream request id and HTTP without copying sensitive values', async () => {
    for (const privateOrigins of [[], [{ kind: 'fixture-private-group' }]]) {
      let failure;
      try { await ark.createVolcengineIpVideoTask({ ...base, model: models[1], reference_image_urls: ['asset://asset-FixtureRole'] }, {
        privateOrigins, fetchImpl: async () => { mockRequests++; return json({ error: { code: 'InvalidParameter', param: 'content[1].image_url.url',
          message: 'cannot fetch https://private.fixture.invalid/original?secret=do-not-save fixture-private-prompt data:image/png;base64,c2VjcmV0 asset://asset-DoNotSave' } }, 400, { 'x-request-id': '20261112-fixture-request' }); },
      }); } catch (error) { failure = error; }
      assert.ok(failure instanceof ark.VolcengineIpRequestError); assert.equal(failure.statusCode, 400);
      const diagnostic = ark.volcengineIpSafeErrorDiagnostic(failure);
      assert.deepEqual(diagnostic, { category: 'unknown', provider_code: 'InvalidParameter', http_status: 400, parameter: 'content[1].image_url.url', request_id: '20261112-fixture-request', reason: 'reference_unavailable' });
      assert.ok(!/https:|asset:|base64|do-not-save|fixture-private-prompt|fixture-only-key/.test(JSON.stringify(diagnostic)));
      if (privateOrigins.length) { assert.equal(failure.normalized.code, 'PROVIDER_CREATE_FAILED'); assert.equal(failure.raw, undefined); assert.equal(failure.normalized.providerMessage, undefined); }
      else assert.equal(failure.normalized.code, 'InvalidParameter');
    }
    assert.equal(privateSends, 1);
    const unsafe = await ark.createVolcengineIpVideoTask({ ...base, model: models[1] }, { fetchImpl: async () => json({ error: {
      code: 'fixture-private-prompt', param: 'https://private.fixture.invalid', message: 'fixture-private-prompt' }, request_id: 'https://credential.invalid' }, 400) }).catch(error => error);
    assert.deepEqual(ark.volcengineIpSafeErrorDiagnostic(unsafe), { category: 'unknown', http_status: 400 });
  });
  await check('actual failed-request summary and HTTP field receive diagnostics while acceptance and refund classification stay unchanged', async () => {
    const diagnostic = { provider_code: 'InvalidParameter', http_status: 400, category: 'unknown', parameter: 'content[1].image_url.url', request_id: '20261112-fixture-request' };
    const suffix = declarations.find(node => node.name.getText(tree) === 'providerDiagnosticSuffix'); assert.ok(suffix);
    const providerDiagnosticSuffix = Function('providerDiagnostic', `return (${suffix.initializer.getText(tree)});`)(diagnostic);
    const failedCalls = calls.filter(call => call.expression.getText(tree) === 'markProviderApiRequestFailed'); assert.equal(failedCalls.length, 2);
    for (const call of failedCalls) {
      const bindings = { providerRequestId: 'fixture-request', providerErrorCode: 'InvalidParameter', providerErrorMessage: 'generic-safe',
        userFacingProviderMessage: 'generic-safe', providerDiagnostic: diagnostic, providerDiagnosticSuffix, providerHttpStatus: 400, unconfirmedMessage: 'unknown-safe',
        preparedImages: [], finalReferenceImageUrls: [], referenceVideoUrls: [], referenceAudioUrls: [], buildReferenceMediaFailureSummary: () => ({ images: { count: 0 } }) };
      const value = Function(...Object.keys(bindings), `return (${call.arguments[0].getText(tree)});`)(...Object.values(bindings));
      assert.equal(value.httpStatus, 400); assert.deepEqual(value.responseSummary.provider_diagnostic, diagnostic);
      for (const expected of ['HTTP 400', diagnostic.provider_code, diagnostic.parameter, diagnostic.request_id]) assert.ok(value.errorMessage.includes(expected));
      assert.ok(!/https:|asset:|base64|fixture-only-key/.test(value.errorMessage));
    }
    const rejection = declarations.find(node => node.name.getText(tree) === 'explicitProviderRejection'); assert.ok(rejection);
    const expression = rejection.initializer.getText(tree);
    for (const status of [400, 401, 403, 404, 408, 409, 425, 500]) {
      const err = new ark.VolcengineIpRequestError({ statusCode: status, normalized: { code: 'InvalidParameter', category: 'unknown', retryable: false, userMessage: 'safe' } });
      const result = Function('err', 'providerTaskId', 'VolcengineIpRequestError', `return ${expression};`)(err, null, ark.VolcengineIpRequestError);
      assert.equal(result, status >= 400 && status < 500 && ![408, 409, 425].includes(status));
    }
    source('src/lib/costs/ledger.ts'); source('src/lib/reference-albums/permissions.ts');
    const admin = source('src/app/admin/costs/page.tsx');
    assert.match(admin, /prisma\.providerApiRequest\.findMany\([\s\S]*?error_message: true/);
    assert.match(admin, /title=\{request\.error_message \|\| ''\}>\{request\.error_message \|\| '-'\}/);
    for (const [url, digest] of originals) assert.equal(hash(await fsp.readFile(path.join(temporary, 'public', site.siteUploadPathFromUrl(url)))), digest);
  });
  console.log(JSON.stringify({ completed: true, count: checks.length, checks, sourceSha256,
    isolation: { temporaryMedia: true, originalHashesPreserved: true, networkCalls: externalRequests, mockRequests, mockSettingsReads,
      productionDatabaseAccess: 0, productionWrites: 0, realUploads: 0, modelCalls: 0, billingChanges: 0, browserRuns: 0 },
    boundary: 'Synthetic authorized media and mocked provider/auth/database; UI and real upstream output remain manual acceptance.' }, null, 2));
}
try { await main(); } catch (error) { console.error(error); process.exitCode = 1; }
finally { process.chdir(previousCwd); globalThis.fetch = realFetch; await fsp.rm(temporary, { recursive: true, force: true }); }
