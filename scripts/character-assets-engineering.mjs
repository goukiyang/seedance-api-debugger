import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, Module, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';

// Offline engineering simulations: actual modules, a new temporary SQLite DB,
// simulated receipts/quotes and intercepted provider fetch. No real generation.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const { PrismaClient, Prisma } = require('@prisma/client');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'character-assets-engineering-'));
const prisma = new PrismaClient({ datasources: { db: { url: `file:${path.join(temporary, 'fixture.db')}` } } });
const originalFetch = globalThis.fetch;
let forbiddenFetches = 0;
globalThis.fetch = async () => { forbiddenFetches++; throw new Error('Real network forbidden'); };
const passed = [], modules = new Map(), cache = new Map();
const owner = { id: 'fixture-owner', status: 'active', account_type: 'internal' };
const other = { ...owner, id: 'fixture-other' };
class AuthError extends Error { constructor(message, status = 403) { super(message); this.status = status; } }
const allowed = new Set([
  'src/lib/character-assets/errors.ts', 'src/lib/character-assets/inputs.ts', 'src/lib/character-assets/service.ts',
  'src/lib/character-assets/video-reference.server.ts', 'src/lib/character-assets/privacy.ts', 'src/lib/provider/seedance-models.ts',
  'src/lib/provider/reference-media-policy.ts', 'src/lib/provider/volcengine-ip.ts', 'src/lib/creation/contract.ts',
  'src/lib/creation/intents.ts', 'src/lib/navigation/task-reuse-client.ts', 'src/lib/navigation/task-reuse-intent.ts',
  'src/app/api/character-assets/_shared.ts', 'src/app/api/character-assets/route.ts', 'src/app/api/character-assets/[id]/route.ts',
]);
function load(file) {
  const filename = path.resolve(root, file);
  if (cache.has(filename)) return cache.get(filename).exports;
  assert.ok(allowed.has(path.relative(root, filename)), `Unmocked product dependency ${file}`);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }, fileName: filename,
  }).outputText;
  const mod = new Module(filename); mod.filename = filename;
  mod.require = request => {
    if (modules.has(request)) return modules.get(request);
    if (isBuiltin(request)) return require(request);
    if (request === '@prisma/client') return { Prisma };
    if (request.startsWith('@/')) return load(`src/${request.slice(2)}.ts`);
    if (request.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), `${request}.ts`)));
    throw new Error(`Unmocked dependency ${request} in ${file}`);
  };
  cache.set(filename, mod); mod._compile(code, filename); return mod.exports;
}
// Extract complete unchanged functions only when the unrelated import graph adds
// I/O. Existing repository fixtures use the same AST/transpile execution pattern.
function functions(file, names, environment = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const declarations = names.map(name => {
    const node = parsed.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert.ok(node, `${file}:${name}`); return node.getText(parsed);
  });
  const code = ts.transpileModule(`${declarations.join('\n')}\nmodule.exports = { ${names.join(',')} };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  Function('module', 'exports', ...Object.keys(environment), code)(mod, mod.exports, ...Object.values(environment));
  return mod.exports;
}
async function check(label, run) { await run(); passed.push(label); }
const rejectsCode = (run, code) => assert.rejects(run, error => error.code === code);
const throwsStatus = (run, status = 400) => assert.throws(run, error => error.status === status);
const writes = { CHARACTER_ASSET_WRITES_ENABLED: true };
let thumbnailAllowed = true, actor = owner, codexActor = other;
modules.set('./build-mode', writes);
modules.set('@/lib/auth/session', { AuthError });
const { retrySqliteBusy } = functions('src/lib/prisma.ts', ['retrySqliteBusy']);
modules.set('@/lib/prisma', { prisma, retrySqliteBusy });
modules.set('@/lib/reference-albums/permissions', { assertCanViewReferenceImage: async (user, id) => {
  if (!thumbnailAllowed || user.id !== owner.id || id !== 'allowed-thumbnail') throw new AuthError('无权查看缩略图');
  return { id, asset: { status: 'active', type: 'image' } };
} });
modules.set('next/server', { NextResponse: { json: (value, options) => new Response(JSON.stringify(value), options) } });
modules.set('@/lib/auth/api-helpers', { getSessionUser: async () => actor });
modules.set('@/lib/integrations/codex', {
  hasCodexApiAuthSignal: request => request.headers.get('x-fixture-codex') === '1',
  authenticateCodexVideoApi: async () => ({ user: codexActor }), CodexApiAuthError: class extends Error {},
});
const input = load('src/lib/character-assets/inputs.ts');
const service = load('src/lib/character-assets/service.ts');
const reference = load('src/lib/character-assets/video-reference.server.ts');
const privacy = load('src/lib/character-assets/privacy.ts');
const directoryApi = load('src/app/api/character-assets/route.ts');
const itemApi = load('src/app/api/character-assets/[id]/route.ts');
const { SEEDANCE_2_5_IP_MODEL_ID: model25 } = load('src/lib/provider/seedance-models.ts');
const model20 = 'doubao-seedance-2-0-260128';
const policy = load('src/lib/provider/reference-media-policy.ts');
modules.set('@/lib/integrations/volcengine-ip', {
  VOLCENGINE_IP_CREATE_TASK_PATH: '/api/v3/contents/generations/tasks',
  getVolcengineIpApiSettings: async () => ({ enabled: true, api_key: 'fixture-key', default_model: model20, base_url: 'https://provider.fixture.invalid' }),
  isVolcengineIpApiReady: () => true,
});
const provider = load('src/lib/provider/volcengine-ip.ts');
const { pricingFingerprint } = functions('src/lib/pricing/catalog.ts', ['pricingCanonical', 'pricingFingerprint'], { createHash: require('node:crypto').createHash });
const intentRows = new Map(), effects = { quotes: 0, taskUpdates: [], approvalConsumes: 0 };
const receipts = {
  videoCreationIntent: {
    findUnique: async ({ where }) => where.id ? intentRows.get(where.id) || null : [...intentRows.values()].find(row => row.owner_id === where.owner_id_request_id.owner_id && row.request_id === where.owner_id_request_id.request_id) || null,
    create: async ({ data }) => {
      const row = { id: `intent-${intentRows.size + 1}`, revision: 1, accepted_task_id: null, batch_id: null, created_at: new Date(), updated_at: new Date(), ...data };
      intentRows.set(row.id, row); return row;
    },
    updateMany: async ({ where, data }) => {
      const row = intentRows.get(where.id);
      if (!row || Object.entries(where).some(([key, value]) => row[key] !== value)) return { count: 0 };
      for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === 'object' && 'increment' in value ? row[key] + value.increment : value;
      return { count: 1 };
    },
    findUniqueOrThrow: async ({ where }) => { assert.ok(intentRows.has(where.id)); return intentRows.get(where.id); },
  },
  approvalRecord: { findFirst: async () => null }, approvalUsage: { count: async () => 0 },
  videoTask: { count: async () => 0, update: async value => { effects.taskUpdates.push(value); return value; } },
};
function receiptDb(db) {
  return new Proxy(db, { get(target, key) {
    if (key in receipts) return receipts[key];
    if (key === '$transaction') return run => prisma.$transaction(tx => run(receiptDb(tx)));
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
}
const intentDb = receiptDb(prisma);
const context = { payer: { kind: 'user', id: owner.id, label: 'fixture payer' }, project: { type: 'personal' } };
modules.set('@/lib/prisma', { prisma: intentDb });
modules.set('@/lib/pricing/catalog', { pricingFingerprint });
modules.set('@/lib/pricing/video', {
  quoteVideoPricing: async () => { effects.quotes++; return { revision: 'fixture-price-r1', pricing: { estimatedCost: 5 } }; },
  requireVideoPricingRevision: (quote, revision) => assert.equal(revision, quote.revision),
});
modules.set('@/lib/pricing/video-context', { resolveVideoPricingContext: async () => { throw new Error('IP must not use gateway pricing'); } });
modules.set('@/lib/projects/permissions', { assertProjectActiveInTransaction: async () => {} });
modules.set('@/lib/credits/precision', { creditCents: amount => Math.round(amount * 100) });
modules.set('@/lib/works/source-policy', { freezeWorkSourcePolicy: async () => {} });
modules.set('@/lib/canvas-reference-inputs', { applyCanvasReferenceInputs: body => body, resolveCanvasReferenceInputs: async () => null });
modules.set('@/lib/canvas-references', { normalizeCanvasReferences: value => value });
modules.set('@/lib/video/feishu-contract', { normalizeVideoFeishuChoice: value => value, VideoFeishuError: class extends Error {} });
modules.set('@/lib/video/multiview-action-video.server', { resolveMultiviewActionVideoInput: async () => null });
modules.set('@/lib/video/prompt-groups', { assertVideoPromptGroupSurface: () => {}, parseVideoPromptGroupRefs: value => value || [] });
for (const [name, exports] of Object.entries({
  './context': { assertVideoCreationReady: async () => {}, readCreationContext: async () => context },
  './availability': { readCreationAvailability: async () => ({ canSubmit: true, reasons: [] }), creationNeedsApproval: () => false },
  './lineage': { creationParent: () => null, creationTaskLineage: async () => ({}), assertCreationLineageUnlocked: async () => {} },
  './approval': { consumeCreationApproval: async () => { effects.approvalConsumes++; } },
  './preparation-receipts': { assertNoPreparationRejection: async () => {} }, './receipts': {}, '@/lib/tasks/enhance-video-create': {},
})) modules.set(name, exports);
const intents = load('src/lib/creation/intents.ts');
const reuse = load('src/lib/navigation/task-reuse-client.ts');
function request(body, query = '', codex = false) {
  const value = new Request(`https://app.fixture.invalid/api/character-assets${query}`, { method: body === undefined ? 'GET' : 'POST', headers: codex ? { 'x-fixture-codex': '1' } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  value.nextUrl = new URL(value.url); return value;
}

async function main() {
  await check('missing additive table maps to 503, without creating a runtime table', async () => {
    const response = await directoryApi.GET(request()); assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'CHARACTER_ASSET_SCHEMA_REQUIRED');
    assert.deepEqual(await prisma.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE name='CharacterAsset'"), []);
  });
  await prisma.$executeRawUnsafe('CREATE TABLE "User" ("id" TEXT PRIMARY KEY)');
  await prisma.$executeRaw`INSERT INTO "User" ("id") VALUES (${owner.id}), (${other.id})`;
  const migration = fs.readFileSync(path.join(root, 'prisma/migrations/20261111090000_owner_character_assets/migration.sql'), 'utf8');
  for (const statement of migration.replace(/^\s*--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(statement);

  await check('ID normalization accepts bare/URI and case; malformed/group/path/query/base64 IDs rejected', () => {
    for (const value of ['asset-Mixed_Case-7', '  asset://asset-Mixed_Case-7  ']) assert.equal(input.normalizeArkAssetId(value), 'asset-Mixed_Case-7');
    for (const value of ['', 'group-20261111133644-npdpj', 'asset://group-wrong', 'https://fixture.invalid/asset-one', 'asset://asset-one/path', 'asset-one?x=1', 'asset-one#x', 'data:image/png;base64,AA', 'asset-', null]) assert.throws(() => input.normalizeArkAssetId(value), error => error.code === 'CHARACTER_ASSET_INVALID_ID');
  });
  await check('ordered parser rejects malformed, duplicate IDs even across revisions and injected URI fields', () => {
    assert.equal(input.parseReferenceImageInputs(undefined), undefined); assert.deepEqual(input.parseReferenceImageInputs([]), []);
    for (const value of [null, {}, [null], [{ kind: 'ark_asset', characterAssetId: 'one', revision: 0 }], [{ kind: 'ark_asset', characterAssetId: 'one', revision: '1' }], [{ kind: 'ark_asset', characterAssetId: 'one', revision: 1, uri: 'asset://asset-injected' }]]) assert.throws(() => input.parseReferenceImageInputs(value), error => error.code === 'CHARACTER_ASSET_INVALID_INPUTS');
    for (const duplicate of [[{ kind: 'site_image', referenceImageId: 'one' }, { kind: 'site_image', referenceImageId: ' one ' }], [{ kind: 'ark_asset', characterAssetId: 'one', revision: 1 }, { kind: 'ark_asset', characterAssetId: 'one', revision: 2 }]]) assert.throws(() => input.parseReferenceImageInputs(duplicate), error => error.code === 'CHARACTER_ASSET_DUPLICATE_INPUT');
  });

  let directory;
  await check('actual API/SQL CRUD isolates owners and Codex linked account; duplicate/thumbnail authorization', async () => {
    const created = await directoryApi.POST(request({ name: '  原创角色  ', assetId: ' asset://asset-Directory_A ', groupId: 'group-fixture', notes: '管理备注，不注入提示词', thumbnailReferenceImageId: 'allowed-thumbnail' }));
    assert.equal(created.status, 201); directory = (await created.json()).asset;
    assert.equal(directory.assetId, 'asset-Directory_A'); assert.equal(directory.name, '原创角色');
    assert.equal(directory.projectName, null); assert.equal(directory.upstreamStatus, 'unknown'); assert.ok(directory.thumbnailUrl);
    assert.equal((await service.listCharacterAssets(owner, { q: 'DIRECTORY' })).length, 1);
    assert.equal((await service.listCharacterAssets(owner, { q: "' OR 1=1 --" })).length, 0);
    assert.deepEqual(await service.listCharacterAssets(other), []);
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const response = await itemApi[method](request(method === 'GET' ? undefined : method === 'PATCH' ? { revision: 1, name: '他人修改' } : { revision: 1 }, '', true), { params: { id: directory.id } });
      assert.equal(response.status, 404, `${method} must use the linked account`);
    }
    await rejectsCode(() => service.createCharacterAsset(owner, { name: '重复', assetId: 'asset-Directory_A' }), 'CHARACTER_ASSET_DUPLICATE');
    assert.notEqual((await service.createCharacterAsset(other, { name: '同 ID 不同本人目录', assetId: 'asset-Directory_A' })).id, directory.id);
    await assert.rejects(() => service.createCharacterAsset(other, { name: '无权缩略图', assetId: 'asset-thumb-denied', thumbnailReferenceImageId: 'allowed-thumbnail' }), error => error.status === 403);
    thumbnailAllowed = false; assert.equal((await service.getCharacterAsset(owner, directory.id)).thumbnailUrl, null); thumbnailAllowed = true;
  });
  await check('actual SQL revision CAS, disabled/deleted resolver, tombstone reserve, restore and Boolean/DateTime roundtrip', async () => {
    const changed = await service.updateCharacterAsset(owner, directory.id, { revision: 1, assetId: 'asset-Replaced_B', enabled: false });
    assert.equal(changed.revision, 2); assert.equal(changed.enabled, false);
    await rejectsCode(() => service.updateCharacterAsset(owner, directory.id, { revision: 1, name: '迟到覆盖' }), 'CHARACTER_ASSET_REVISION_CONFLICT');
    await rejectsCode(() => service.resolveCharacterAssetReferences(owner.id, [{ kind: 'ark_asset', characterAssetId: directory.id, revision: 2 }]), 'CHARACTER_ASSET_DISABLED');
    const deletedResponse = await itemApi.DELETE(request({ revision: 2 }), { params: { id: directory.id } });
    assert.equal(deletedResponse.status, 200); const deleted = (await deletedResponse.json()).asset;
    assert.equal(deleted.revision, 3); assert.ok(Number.isFinite(Date.parse(deleted.deletedAt)));
    assert.equal((await service.listCharacterAssets(owner)).length, 0);
    assert.equal((await (await directoryApi.GET(request(undefined, '?includeDeleted=1'))).json()).assets.length, 1);
    await rejectsCode(() => service.createCharacterAsset(owner, { name: '误重新登记', assetId: 'asset-Replaced_B' }), 'CHARACTER_ASSET_DELETED_DUPLICATE');
    await rejectsCode(() => service.updateCharacterAsset(owner, directory.id, { revision: 3, name: '不编辑已删除' }), 'CHARACTER_ASSET_DELETED');
    await rejectsCode(() => service.resolveCharacterAssetReferences(owner.id, [{ kind: 'ark_asset', characterAssetId: directory.id, revision: 3 }]), 'CHARACTER_ASSET_DELETED');
    const restoredResponse = await itemApi.PATCH(request({ revision: 3, restore: true }), { params: { id: directory.id } });
    const restored = (await restoredResponse.json()).asset;
    assert.equal(restored.revision, 4); assert.equal(restored.deletedAt, null); assert.equal(restored.enabled, false);
    directory = await service.updateCharacterAsset(owner, directory.id, { revision: 4, enabled: true });
    await rejectsCode(() => service.updateCharacterAsset(owner, directory.id, { revision: 5, restore: true, enabled: true }), 'CHARACTER_ASSET_INVALID_BODY');
    assert.equal(forbiddenFetches, 0, 'local lifecycle must never call upstream');
  });

  const selected = [{ kind: 'site_image', referenceImageId: 'site-left' }, { kind: 'ark_asset', characterAssetId: directory.id, revision: directory.revision }, { kind: 'site_image', referenceImageId: 'site-right' }];
  const prompt = '图片1是背景，@图片2中的角色看向图3。原文、标点和 camera move 保留。';
  const base = { provider: 'volcengine_ip', entry: 'ip', model: model20, generation_mode: 'all_in_one_reference', reference_image_inputs: selected, reference_image_ids: ['site-left', 'site-right'], prompt, duration: 5, resolution: '720p', ratio: '16:9', project_id: 'fixture-project', pricing_revision: 'fixture-price-r1' };
  let frozen;
  await check('resolve authoritative identity/revision/name/URI at common picture position two; stale/foreign fail', async () => {
    assert.deepEqual(reference.videoReferenceImageInputs(base), selected); frozen = await reference.resolveVideoCharacterReferences(owner, base);
    assert.deepEqual(frozen, [{ characterAssetId: directory.id, revision: 5, name: '原创角色', assetId: 'asset-Replaced_B', uri: 'asset://asset-Replaced_B', position: 2 }]);
    assert.deepEqual(reference.orderedVideoImageUrls(selected, ['https://site.fixture.invalid/left.png', 'https://site.fixture.invalid/right.png'], frozen), ['https://site.fixture.invalid/left.png', 'asset://asset-Replaced_B', 'https://site.fixture.invalid/right.png']);
    throwsStatus(() => reference.orderedVideoImageUrls(selected, ['left'], frozen));
    throwsStatus(() => reference.orderedVideoImageUrls(selected, ['left', 'right'], [{ ...frozen[0], position: 1 }]), 409);
    await assert.rejects(() => reference.resolveVideoCharacterReferences(other, base), error => error.status === 404);
    await assert.rejects(() => reference.resolveVideoCharacterReferences(owner, { ...base, reference_image_inputs: selected.map(item => item.kind === 'ark_asset' ? { ...item, revision: 1 } : item) }), error => error.status === 409);
    assert.equal(reference.validateOrderedImagePrompt(prompt, 3), undefined); assert.equal(base.prompt, prompt);
    for (const invalid of ['图片4', '@图0', '图片30']) throwsStatus(() => reference.validateOrderedImagePrompt(invalid, 3));
  });
  await check('parallel arrays, gateway, first-last/multi-frame modes and raw asset URLs fail closed; legacy retained', () => {
    for (const patch of [{ reference_image_ids: ['site-right', 'site-left'] }, { reference_image_urls: ['https://site.fixture.invalid/left.png'] }, { canvas_references: [] }, { promptMentions: [] }, { provider: 'seedance', entry: 'ordinary' }, { generation_mode: 'first_last_frame' }, { generation_mode: 'smart_multi_frame' }, { first_frame_url: 'https://site.fixture.invalid/first.png' }, { frame_image_urls: ['https://site.fixture.invalid/frame.png'] }]) throwsStatus(() => reference.videoReferenceImageInputs({ ...base, ...patch }));
    for (const key of ['reference_image_urls', 'first_frame_url', 'last_frame_url', 'frame_image_urls']) throwsStatus(() => reference.videoReferenceImageInputs({ [key]: ['asset://asset-hidden'] }));
    assert.equal(reference.videoReferenceImageInputs({ reference_image_urls: ['https://site.fixture.invalid/legacy.png'] }), undefined);
  });
  await check('mixed ordinary/character references share the real 2.0/2.5 aggregate limits', () => {
    for (const model of [model20, model25]) {
      const limit = policy.seedanceReferenceMediaCapabilities(model).imageLimit;
      const sites = Array.from({ length: limit - 1 }, (_, index) => ({ kind: 'site_image', referenceImageId: `site-${index}` }));
      const values = [...sites, selected[1]];
      assert.equal(reference.videoReferenceImageInputs({ ...base, model, reference_image_ids: sites.map(item => item.referenceImageId), reference_image_inputs: values }).length, limit);
      throwsStatus(() => reference.videoReferenceImageInputs({ ...base, model, reference_image_ids: undefined, reference_image_inputs: [...values, { kind: 'site_image', referenceImageId: 'too-many' }] }));
      assert.throws(() => provider.buildVolcengineIpCreatePayload({ ...base, model, reference_image_urls: Array.from({ length: limit + 1 }, (_, index) => index ? `https://site.fixture.invalid/${index}` : frozen[0].uri) }), /上限/);
    }
  });
  await check('actual provider fetch receives unchanged prompt, site/asset/site order and reference_image role for 2.0/2.5', async () => {
    const urls = reference.orderedVideoImageUrls(selected, ['https://site.fixture.invalid/left.png', 'https://site.fixture.invalid/right.png'], frozen), calls = [];
    for (const model of [model20, model25]) {
      const result = await provider.createVolcengineIpVideoTask({ ...base, model, reference_image_urls: urls, client_request_id: `original-${model}` }, { fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body); calls.push({ url, method: init.method });
        assert.equal(init.method, 'POST'); assert.equal(body.model, model); assert.equal(body.content[0].text, prompt);
        assert.deepEqual(body.content.slice(1), urls.map(url => ({ type: 'image_url', image_url: { url }, role: 'reference_image' })));
        assert.equal(body.client_request_id, `original-${model}`); if (model === model25) assert.equal(body.omni_reference_task_type, 'reference');
        return new Response(JSON.stringify({ id: `mock-${model}` }), { status: 200 });
      } });
      assert.equal(result.provider_task_id, `mock-${model}`);
    }
    assert.equal(calls.length, 2); assert.equal(calls.some(call => call.method === 'DELETE'), false);
  });
  await check('provider rejects asset URI in first/last/video/audio and rejects malformed private image IDs', () => {
    for (const model of [model20, model25]) {
      for (const patch of [
        { generation_mode: 'first_last_frame', first_frame_url: frozen[0].uri },
        { generation_mode: 'first_last_frame', first_frame_url: 'https://site.fixture.invalid/first.png', last_frame_url: frozen[0].uri },
        { reference_video_urls: [frozen[0].uri] }, { reference_audio_urls: [frozen[0].uri] },
        { reference_image_urls: ['asset://group-invalid'] }, { reference_image_urls: ['asset://asset-private/path'] },
        { reference_image_urls: ['asset://asset-private?query=1'] },
      ]) assert.throws(() => provider.buildVolcengineIpCreatePayload({ ...base, model, ...patch }));
    }
  });
  await check('actual privacy projection strips URI-only partial DTOs and opaque private params while preserving legacy', () => {
    const legacy = { id: 'legacy', params_json: '{"prompt":"original"}', reference_image_urls: '["https://site.fixture.invalid/plain.png"]' };
    assert.equal(privacy.hasCharacterAssetReferences(legacy), false); assert.equal(privacy.projectCharacterAssetTask(legacy), legacy);
    for (const field of ['reference_image_urls', 'first_frame_url', 'last_frame_url', 'frame_image_urls']) {
      const task = { id: 'partial', [field]: JSON.stringify(['https://site.fixture.invalid/plain.png', 'asset://asset-private']), params_json: 'opaque-frozen-private-settings', snapshot: '{"uri":"asset://asset-private"}', error_message: 'cannot read asset://asset-private' };
      const original = JSON.stringify(task); assert.equal(privacy.hasCharacterAssetReferences(task), true);
      const projected = privacy.projectCharacterAssetTask(task);
      assert.equal(projected.params_json, null); assert.equal(projected.snapshot, null); assert.equal(projected[field].includes('asset://'), false);
      assert.equal(projected.error_message.includes('asset-private'), false); assert.equal(JSON.stringify(task), original);
    }
    const opaque = privacy.projectCharacterAssetTask({ source_metadata_json: '{"private_character_assets":true}', params_json: 'not JSON', provider_payload_json: 'private body', content_json: 'private content', raw_create_response: 'private response' });
    for (const field of ['params_json', 'provider_payload_json', 'content_json', 'raw_create_response']) assert.equal(opaque[field], null);
  });

  let prepared, body, historical;
  await check('actual preparation overrides spoofed frozen metadata; hashes bind order, revision, Asset ID and prompt', async () => {
    body = { ...base, request_id: 'fixture-request-original', character_asset_references: [{ uri: 'asset://asset-Spoofed', revision: 99 }] };
    prepared = await intents.prepareVideoCreationIntent(owner, body);
    const row = intentRows.get(prepared.id), spec = JSON.parse(row.spec_json); historical = row.spec_json;
    assert.deepEqual(spec.input.reference_image_inputs, selected); assert.deepEqual(spec.input.character_asset_references, frozen);
    assert.equal(spec.input.prompt, prompt); assert.equal(row.input_hash, intents.creationSpecHash(spec)); const hash = intents.creationSpecHash(spec);
    for (const input of [
      { ...spec.input, reference_image_inputs: [...selected].reverse() },
      { ...spec.input, character_asset_references: [{ ...frozen[0], revision: 6 }] },
      { ...spec.input, character_asset_references: [{ ...frozen[0], assetId: 'asset-Other', uri: 'asset://asset-Other' }] },
      { ...spec.input, prompt: `${prompt} changed` },
    ]) assert.notEqual(intents.creationSpecHash({ ...spec, input }), hash);
    assert.equal((await intents.prepareVideoCreationIntent(owner, body)).revision, 1);
  });
  await check('actual acceptance rejects reorder, accepts once, original receipt survives later directory edit', async () => {
    const acceptBody = { ...base, creation_contract_version: 2, intent_id: prepared.id, intent_revision: 1, idempotency_key: body.request_id };
    await rejectsCode(() => intents.acceptVideoCreationIntent(intentDb, owner, { ...acceptBody, reference_image_inputs: [selected[1], selected[0], selected[2]] }, { taskId: 'mock-task', cost: 5, pricingRevision: 'fixture-price-r1' }), 'creation_input_changed');
    assert.equal(effects.taskUpdates.length, 0); assert.equal(effects.approvalConsumes, 0);
    for (let index = 0; index < 2; index++) await intents.acceptVideoCreationIntent(intentDb, owner, acceptBody, { taskId: 'mock-task', cost: 5, pricingRevision: 'fixture-price-r1' });
    assert.equal(intentRows.get(prepared.id).accepted_task_id, 'mock-task'); assert.equal(effects.taskUpdates.length, 1); assert.equal(effects.approvalConsumes, 1);
    directory = await service.updateCharacterAsset(owner, directory.id, { revision: 5, assetId: 'asset-New_Revision', name: '新角色名' }); const quotes = effects.quotes;
    assert.equal((await intents.prepareVideoCreationIntent(owner, body)).accepted_task_id, 'mock-task'); assert.equal(effects.quotes, quotes);
    assert.equal(intentRows.get(prepared.id).spec_json, historical); assert.equal(JSON.parse(historical).input.character_asset_references[0].uri, 'asset://asset-Replaced_B');
  });
  await check('stale prepared revision is blocked before acceptance/approval writes', async () => {
    const fresh = { ...base, reference_image_inputs: selected.map(item => item.kind === 'ark_asset' ? { ...item, revision: directory.revision } : item), request_id: 'fixture-request-next' };
    const ready = await intents.prepareVideoCreationIntent(owner, fresh);
    await service.updateCharacterAsset(owner, directory.id, { revision: directory.revision, notes: '修改后旧准备失效' }); const mutations = effects.taskUpdates.length;
    await assert.rejects(() => intents.acceptVideoCreationIntent(intentDb, owner, { ...fresh, creation_contract_version: 2, intent_id: ready.id, intent_revision: ready.revision, idempotency_key: fresh.request_id }, { taskId: 'must-not-accept', cost: 5, pricingRevision: 'fixture-price-r1' }), error => error.status === 409);
    assert.equal(effects.taskUpdates.length, mutations); assert.equal(intentRows.get(ready.id).state, 'ready');
    await assert.rejects(() => intents.prepareVideoCreationIntent(owner, { ...fresh, request_id: 'stale-new-request' }), error => error.status === 409);
  });
  await check('actual normal create POST rejects private input before gateway or task I/O', async () => {
    let unexpected = 0;
    const post = functions('src/app/api/tasks/create/route.ts', ['POST'], {
      AuthError, webRequestSource: () => ({ source_type: 'web' }), hasCodexApiAuthSignal: () => false, getSessionUser: async () => owner,
      assertFeatureAllowed: () => {}, consumeTrustedMultiviewRetry: () => null, videoReferenceImageInputs: reference.videoReferenceImageInputs,
      errorJson: (error, status) => new Response(JSON.stringify({ error }), { status }),
      NextResponse: { json: (data, options) => new Response(JSON.stringify(data), options) },
      prisma: new Proxy({}, { get: () => { unexpected++; throw new Error('normal route reached DB'); } }), createVideoTask: () => { unexpected++; throw new Error('gateway called'); },
    }).POST;
    const response = await post(new Request('https://app.fixture.invalid/api/tasks/create', { method: 'POST', body: JSON.stringify({ ...base, idempotency_key: 'must-stay-local' }) }));
    assert.equal(response.status, 400); assert.match((await response.json()).error, /IP/); assert.equal(unexpected, 0);
  });
  await check('actual mode-switch/draft keeps ordered references, prompt and project/card; account/tab isolation', () => {
    const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    const backup = { version: 1, hadInput: true, workspace: { ownerId: owner.id, tabId: 'fixture-tab', workspaceId: 'fixture-workspace', epoch: 1, items: [{ assetId: 'site-asset', referenceImageId: 'site-left', role: 'reference', sortOrder: 0 }] },
      fields: { prompt, model: 'dreamina-seedance-2-0-260128', provider: 'seedance', generationMode: 'all_in_one_reference', ratio: '16:9', duration: 5, resolution: '720p', seed: -1, generateAudio: true, returnLastFrame: false, watermark: false, resolutionApprovalConfirmed: false, projectId: 'fixture-project', videoCardId: 'fixture-card', videoBranchId: 'fixture-branch', referenceImageInputs: selected, characterAssetReferences: frozen, referenceImageIssue: null } };
    const handoff = reuse.prepareVideoModeSwitch(storage, reuse.videoInputContext(owner.id, 'fixture-tab', 'normal'), 'normal', backup, { id: 'ip-model', surface: 'ip', model: model20, label: 'IP', detail: '' }, 1, '12345678-1234-1234-1234-123456789abc');
    assert.deepEqual(handoff.targetInput.fields.referenceImageInputs, selected); assert.equal(handoff.targetInput.fields.prompt, prompt); assert.equal(handoff.targetInput.fields.videoCardId, 'fixture-card');
    assert.deepEqual(reuse.readVideoModeSwitch(storage, owner.id, 'fixture-tab', handoff.targetContext, handoff.nonce).targetInput.fields.referenceImageInputs, selected);
    assert.equal(reuse.readVideoModeSwitch(storage, other.id, 'fixture-tab', handoff.targetContext, handoff.nonce), null);
    assert.equal(reuse.readVideoModeSwitch(storage, owner.id, 'another-tab', handoff.targetContext, handoff.nonce), null);
    reuse.writeVideoInputDraft(storage, handoff.targetContext, handoff.targetInput);
    const draft = reuse.parseModeInputDraft(storage.getItem(reuse.videoInputDraftKey(handoff.targetContext)), owner.id, 'fixture-tab');
    assert.deepEqual(draft.fields.referenceImageInputs, selected); assert.deepEqual(draft.fields.characterAssetReferences, frozen);
    assert.notEqual(reuse.taskReuseInputSignature(backup), reuse.taskReuseInputSignature({ ...backup, fields: { ...backup.fields, referenceImageInputs: [...selected].reverse() } }));
  });
  await check('compatibility pause rejects new writes/private resolution while existing reads work', async () => {
    writes.CHARACTER_ASSET_WRITES_ENABLED = false;
    try {
      const current = await service.getCharacterAsset(owner, directory.id);
      for (const run of [() => service.createCharacterAsset(owner, { name: 'blocked', assetId: 'asset-blocked' }), () => service.updateCharacterAsset(owner, directory.id, { revision: current.revision, name: 'blocked' }), () => service.updateCharacterAsset(owner, directory.id, { revision: current.revision, restore: true }), () => service.deleteCharacterAsset(owner, directory.id, current.revision)]) await rejectsCode(run, 'CHARACTER_ASSET_WRITES_PAUSED');
      await assert.rejects(() => reference.resolveVideoCharacterReferences(owner, { ...base, reference_image_inputs: [{ kind: 'ark_asset', characterAssetId: directory.id, revision: current.revision }], reference_image_ids: [] }), error => error.status === 503);
      assert.equal((await service.listCharacterAssets(owner)).length, 1);
    } finally { writes.CHARACTER_ASSET_WRITES_ENABLED = true; }
  });
  await check('concurrent actual SQLite edits at one revision have one winner and one revision conflict', async () => {
    const concurrent = await service.createCharacterAsset(owner, { name: '并发修订', assetId: 'asset-Concurrent' });
    const outcomes = await Promise.allSettled([
      service.updateCharacterAsset(owner, concurrent.id, { revision: concurrent.revision, name: '修订甲' }),
      service.updateCharacterAsset(owner, concurrent.id, { revision: concurrent.revision, name: '修订乙' }),
    ]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = outcomes.find(result => result.status === 'rejected');
    assert.equal(rejected?.reason.code, 'CHARACTER_ASSET_REVISION_CONFLICT');
    const saved = await service.getCharacterAsset(owner, concurrent.id); assert.equal(saved.revision, 2);
    assert.ok(['修订甲', '修订乙'].includes(saved.name));
  });
  assert.equal(forbiddenFetches, 0);
  console.log(JSON.stringify({ passed: passed.length, cases: passed, runtime: { node: process.version, typescript: require('typescript/package.json').version, prisma: require('@prisma/client/package.json').version }, isolation: { temporarySqlite: true, realFetches: forbiddenFetches, realGeneration: 0, browserRuns: 0, productionWrites: 0 }, scope: 'Engineering simulation only; full IP HTTP create, deployed runtime and user interaction acceptance remain separate.' }, null, 2));
}
try { await main(); }
catch (error) { console.error(error); process.exitCode = 1; }
finally { await prisma.$disconnect(); globalThis.fetch = originalFetch; fs.rmSync(temporary, { recursive: true, force: true }); }
