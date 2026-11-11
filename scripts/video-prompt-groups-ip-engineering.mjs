import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, isBuiltin, Module } from 'node:module';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Synthetic keys/policy and in-memory records only. Actual private crypto,
// identities, compilation, transport checks, intents and projection execute.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json')), ts = require('typescript');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'video-prompt-groups-ip-')));
fs.chmodSync(fixture, 0o700);
const write = (file, value) => fs.writeFileSync(file, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
const environment = { NODE_ENV: 'test', PRIVATE_PROMPTS_FIXTURE_ROOT: fixture, PRIVATE_PROMPTS_POLICY_FILE: path.join(fixture, 'policy.json'),
  PRIVATE_PROMPTS_MIN_STATE: 'compatible-read', PRIVATE_PROMPTS_CONSUMER_ID: 'fixture', PRIVATE_PROMPTS_RUNTIME_REVISION: 'a'.repeat(40),
  SESSION_SECRET: randomBytes(48).toString('hex'), FEISHU_ALLOWED_TENANT_KEY: 'fixture-tenant' };
const previousEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);
const policy = { schema: 'private-prompt-policy.v1', revision: 'fixture-policy', state: 'compatible-read', minimumReader: 1,
  identities: [{ userId: 'author', tenant: 'fixture-tenant', subject: 'author-subject' }], origins: [],
  authorKinds: [{ ownerId: 'author', kinds: ['skill'] }], destinations: [], consumers: ['fixture'],
  keys: Object.fromEntries(['body', 'index', 'backup'].map(domain => {
    const file = path.join(fixture, `${domain}.key`); write(file, randomBytes(32)); return [domain, { active: domain, files: { [domain]: file } }];
  })),
};
const updatePolicy = () => write(environment.PRIVATE_PROMPTS_POLICY_FILE, policy);
updatePolicy();
const realFetch = globalThis.fetch;
let externalRequests = 0;
globalThis.fetch = async () => { externalRequests++; throw new Error('Real transport forbidden'); };
class AuthError extends Error { constructor(message, status = 403) { super(message); this.status = status; } }
const users = Object.fromEntries(['author', 'ordinary', 'outsider'].map(id => [id, { id, role: 'user', status: 'active', account_type: id === 'outsider' ? 'external' : 'internal',
  name: id, username: id, feishu: { user_id: id, open_id: id, tenant_key: 'fixture-tenant' } }]));
let actor = users.ordinary, beforeTransaction = null, transactionGroupReads = 0, inTransaction = false;
const settings = new Map(), intentsStore = new Map(), taskUpdates = [];
const character = { id: 'fixture-character', owner_id: users.ordinary.id, provider: 'volcengine_ark', asset_id: 'asset-Ordered', name: '原角色', revision: 3, enabled: true, deleted_at: null };
let taskFixture = null, approvalCalls = 0;
const db = {
  platformSetting: {
    findUnique: async ({ where }) => {
      if (inTransaction && where.key.startsWith('video_prompt_group_')) transactionGroupReads++;
      return settings.has(where.key) ? { key: where.key, value_json: settings.get(where.key) } : null;
    },
    findMany: async ({ where = {} } = {}) => [...settings].filter(([key]) => !where.key?.startsWith || key.startsWith(where.key.startsWith)).map(([key, value_json]) => ({ key, value_json })),
  },
  user: { findUnique: async ({ where }) => users[where.id] || null },
  asset: { findMany: async () => [], findUnique: async () => null }, referenceImage: { findMany: async () => [] },
  workspaceAsset: { findMany: async () => [] }, generationTaskSnapshot: { findUnique: async () => null, findFirst: async () => null },
  videoTask: {
    findUnique: async () => taskFixture, findMany: async ({ select } = {}) => taskFixture ? [select ? Object.fromEntries(Object.keys(select).filter(key => key in taskFixture).map(key => [key, taskFixture[key]])) : taskFixture] : [],
    findFirst: async ({ where, select }) => taskFixture && Object.entries(where).every(([key, value]) => taskFixture[key] === value)
      ? Object.fromEntries(Object.keys(select).filter(key => key in taskFixture).map(key => [key, taskFixture[key]])) : null,
    count: async () => taskFixture ? 1 : 0, update: async value => { taskUpdates.push(value); return value; },
  },
  videoCreationIntent: {
    findUnique: async ({ where }) => where.id ? intentsStore.get(where.id) || null : [...intentsStore.values()].find(row => row.owner_id === where.owner_id_request_id.owner_id && row.request_id === where.owner_id_request_id.request_id) || null,
    create: async ({ data }) => {
      const row = { id: randomUUID(), revision: 1, accepted_task_id: null, batch_id: null, created_at: new Date(), updated_at: new Date(), ...data };
      intentsStore.set(row.id, row); return row;
    },
    updateMany: async ({ where, data }) => {
      const row = intentsStore.get(where.id);
      if (!row || Object.entries(where).some(([key, value]) => row[key] !== value)) return { count: 0 };
      for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === 'object' && 'increment' in value ? row[key] + value.increment : value;
      return { count: 1 };
    }, findUniqueOrThrow: async ({ where }) => { assert.ok(intentsStore.has(where.id)); return intentsStore.get(where.id); },
  },
  approvalRecord: { findFirst: async () => null }, approvalUsage: { count: async () => 0 },
  $queryRaw: async query => query.values?.includes(users.ordinary.id) ? [character] : [],
  $transaction: async run => {
    const hook = beforeTransaction; beforeTransaction = null; if (hook) await hook();
    inTransaction = true;
    try { return await run(db); } finally { inTransaction = false; }
  },
};
const modules = new Map(), cache = new Map(), sourceSha256 = {}, checks = [], submissionClassification = [];
const groupGuard = { VIDEO_PROMPT_GROUP_WRITES_ENABLED: true };
const readerOnly = process.argv.includes('--reader-only'), simulationOnly = process.argv.includes('--simulate-reader');
let actualGroupWriteFlag;
modules.set('server-only', {});
modules.set('@/lib/prisma', { prisma: db, retrySqliteBusy: run => run() });
modules.set('@/lib/auth/session', { AuthError, getSession: async () => actor });
modules.set('@/lib/auth/session-account-binding', { SESSION_COOKIE_MAX_AGE: 604800 });
modules.set('@/lib/access/external-role', { hasInternalEmailAuthorization: () => false, isExternalUser: user => user.account_type === 'external' });
modules.set('@/lib/image-studio/protected-assets', { studioVisibleAssetWhere: () => ({}) });
modules.set('@/lib/security/private-prompt-drafts.server', { readPrivatePromptDraft: async () => null });
modules.set('@/lib/video/prompt-groups-build-mode', groupGuard);
modules.set('./prompt-groups-build-mode', groupGuard);
modules.set('next/server', { NextResponse: { json: (value, init) => new Response(JSON.stringify(value), init) } });
modules.set('@/lib/video/task-thumbnail-projection', { taskThumbnailProjection: () => ({ result_thumbnail_url: null }) });
modules.set('./task-thumbnail-projection', modules.get('@/lib/video/task-thumbnail-projection'));
modules.set('@/lib/reference-albums/permissions', { assertCanViewReferenceImage: async () => { throw new AuthError('fixture has no thumbnail'); },
  assertCanUseReferenceImage: async () => { throw new AuthError('fixture has no site media'); }, canUseDirectAsset: async () => false, uniquePreserveOrder: values => [...new Set(values)] });
function load(relative) {
  const file = path.resolve(root, relative);
  if (cache.has(file)) return cache.get(file).exports;
  assert.ok(file.startsWith(path.join(root, 'src') + path.sep), `outside source scope: ${relative}`);
  const source = fs.readFileSync(file, 'utf8'), module = new Module(file);
  sourceSha256[path.relative(root, file)] = createHash('sha256').update(source).digest('hex'); cache.set(file, module);
  module.require = id => {
    if (modules.has(id)) return modules.get(id);
    if (isBuiltin(id) || id === '@prisma/client') return require(id);
    if (id.startsWith('@/') || id.startsWith('.')) {
      const base = id.startsWith('@/') ? path.join(root, 'src', id.slice(2)) : path.resolve(path.dirname(file), id);
      const target = [base + '.ts', base + '.tsx', base + '.js', path.join(base, 'index.ts')].find(value => fs.existsSync(value));
      assert.ok(target, `Unresolved fixture dependency ${id}`); return load(path.relative(root, target));
    }
    throw new Error(`Unmocked dependency ${id} in ${relative}`);
  };
  module._compile(ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
  return module.exports;
}
function functions(file, names, context = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8'), parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  sourceSha256[file] = createHash('sha256').update(source).digest('hex');
  const nodes = names.map(name => { const node = parsed.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === name); assert.ok(node, `${file}:${name}`); return node.getText(parsed); });
  const output = ts.transpileModule(`${nodes.join('\n')}\nmodule.exports = {${names.join(',')}};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} }; Function('module', 'exports', ...Object.keys(context), output)(module, module.exports, ...Object.values(context)); return module.exports;
}
function expression(file, select, context) {
  const source = fs.readFileSync(path.join(root, file), 'utf8'), parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  sourceSha256[file] = createHash('sha256').update(source).digest('hex'); let selected;
  const visit = node => { if (!selected) selected = select(node, parsed); if (!selected) ts.forEachChild(node, visit); }; visit(parsed);
  assert.ok(selected, `Actual route expression not found: ${file}`);
  const output = ts.transpileModule(`module.exports = (${selected.getText(parsed)});`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} }; Function('module', ...Object.keys(context), output)(module, ...Object.values(context)); return module.exports;
}
async function check(label, run) { await run(); assert.equal(externalRequests, 0); checks.push(label); }
const secrets = ['synthetic-private-camera-dolly', 'synthetic-private-lighting-backlight'];
const secretFree = value => { for (const body of secrets) assert.equal(JSON.stringify(value).includes(body), false); };
const id = () => randomUUID();
let crypto, identities, contract, groups, execution, transport, provider, reference, creation;
const model20 = 'doubao-seedance-2-0-260128', model25 = 'doubao-seedance-2-5-260628', apiKey = 'synthetic-only-ip-key';
const endpoint = 'https://ark.fixture.invalid/api/v3/contents/generations/tasks';
const definitions = [];
function setHead(index, patch = {}) {
  const value = definitions[index]; value.head = { ...value.head, ...patch }; settings.set(`video_prompt_group_v1:${value.ref.groupId}`, JSON.stringify(value.head));
}
function addVersion(index, body) {
  const value = definitions[index], versionId = id(), ref = { groupId: value.ref.groupId, versionId };
  const origins = [{ kind: 'skill', id: `video-group:${ref.groupId}`, ownerId: users.author.id }];
  const version = { schema: 1, ...ref, name: `Group ${index}`, description: 'metadata only', conditions: '', coverAssetId: null, operatorId: users.author.id, createdAt: new Date().toISOString(),
    body: crypto.sealPrivatePrompt(body, { kind: 'video-prompt-group-version', id: `${ref.groupId}:${ref.versionId}`, field: 'body', origins }) };
  settings.set(`video_prompt_group_version_v1:${ref.groupId}:${ref.versionId}`, JSON.stringify(version)); return ref;
}
async function main() {
  crypto = load('src/lib/security/private-prompts.server.ts'); identities = load('src/lib/security/private-prompt-identity.server.ts');
  const proof = identities.signVerifiedFeishuIdentity({ userId: 'author', role: 'user', tenant: 'fixture-tenant', subject: 'author-subject' }, 'synthetic-session');
  assert.equal(identities.authenticatePrivateIdentity(users.author, proof, 'synthetic-session'), true);
  actualGroupWriteFlag = load('src/lib/video/prompt-groups-build-mode.ts').VIDEO_PROMPT_GROUP_WRITES_ENABLED;
  assert.equal(typeof actualGroupWriteFlag, 'boolean');
  if (simulationOnly) assert.equal(readerOnly, true, '--simulate-reader requires --reader-only');
  groupGuard.VIDEO_PROMPT_GROUP_WRITES_ENABLED = simulationOnly ? false : actualGroupWriteFlag;
  if (readerOnly) assert.equal(groupGuard.VIDEO_PROMPT_GROUP_WRITES_ENABLED, false, 'Run --reader-only in actual guard source, or use explicit --simulate-reader for fixture-only coverage');
  else assert.equal(actualGroupWriteFlag, true, 'Actual guard source must use --reader-only');
  contract = load('src/lib/video/prompt-groups.ts'); groups = load('src/lib/video/prompt-groups.server.ts');
  execution = load('src/lib/video/prompt-group-execution.server.ts'); transport = load('src/lib/security/private-prompt-send.server.ts');
  for (let index = 0; index < secrets.length; index++) {
    const groupId = id(); definitions.push({ ref: { groupId, versionId: '' }, head: { schema: 1, id: groupId, ownerId: users.author.id, revision: 1, shared: true, disabled: false } });
    const ref = addVersion(index, secrets[index]); definitions[index].ref = ref; setHead(index, { versionId: ref.versionId });
  }
  const refs = definitions.map(value => value.ref), personal = '个人要求：缓慢环绕；图片2中的角色保持原设计。';
  if (readerOnly) {
    await checkReaderOnly(refs, personal);
    report(); return;
  }
  await check('ordinary 2.0/2.5/H3 and IP 2.0/2.5 share the prompt-group contract', () => {
    for (const [entry, provider, model] of [['ordinary', 'seedance', 'dreamina-seedance-2-0-260128'], ['ordinary', 'seedance', 'dreamina-seedance-2-5-260628'], ['ordinary', 'h3', 'lightx2v_4step_turbo'], ['ip', 'volcengine_ip', model20], ['ip', 'volcengine_ip', model25]]) {
      assert.deepEqual(contract.assertVideoPromptGroupSurface({ entry, provider, model, creation_contract_version: 2, video_prompt_groups_contract: 1, video_prompt_groups: refs }), refs);
    }
    for (const patch of [{ entry: 'template' }, { entry: 'canvas' }, { entry: 'multiview' }, { canvas_document_id: 'canvas' }, { multiview_generation: {} }, { provider: 'seedance' }, { action: 'enhance' }]) assert.throws(() => contract.assertVideoPromptGroupSurface({ entry: 'ip', provider: 'volcengine_ip', creation_contract_version: 2, video_prompt_groups_contract: 1, video_prompt_groups: refs, ...patch }));
  });
  const compiled = await groups.resolveVideoPromptGroups(users.ordinary, refs, personal);
  await check('actual server composes ordered private groups with personal input last/highest priority; ordinary DTO excludes bodies', async () => {
    assert.ok(compiled.prompt.includes(secrets[0])); assert.ok(compiled.prompt.indexOf(secrets[0]) < compiled.prompt.indexOf(secrets[1]));
    assert.ok(compiled.prompt.endsWith(personal)); assert.ok(compiled.fingerprint); secretFree(await groups.videoPromptGroupSelections(users.ordinary, refs));
    secretFree(await groups.readVideoPromptGroupDetail(users.ordinary, refs[0]));
    await assert.rejects(() => groups.readVideoPromptGroupEditor({ ...users.author }, refs[0]));
    assert.equal((await groups.readVideoPromptGroupEditor(users.author, refs[0])).body, secrets[0]);
    await assert.rejects(() => groups.resolveVideoPromptGroups(users.outsider, refs, personal));
  });
  await check('private/shared authority, disabled/deleted and missing immutable versions remain enforced', async () => {
    for (const patch of [{ shared: false }, { disabled: true }, { deleted: true }]) {
      setHead(0, patch); await assert.rejects(() => groups.resolveVideoPromptGroups(users.ordinary, refs, personal)); setHead(0, { shared: true, disabled: false, deleted: false });
    }
    await assert.rejects(() => groups.resolveVideoPromptGroups(users.ordinary, [{ ...refs[0], versionId: id() }], personal));
    const replacement = addVersion(0, `${secrets[0]}-revision2`); setHead(0, { versionId: replacement.versionId, revision: 2 });
    assert.equal((await groups.resolveVideoPromptGroups(users.ordinary, [refs[0]], personal)).prompt.includes(`${secrets[0]}-revision2`), false);
    assert.notEqual((await groups.resolveVideoPromptGroups(users.ordinary, [replacement], personal)).fingerprint, (await groups.resolveVideoPromptGroups(users.ordinary, [refs[0]], personal)).fingerprint);
  });

  modules.set('@/lib/integrations/volcengine-ip', { VOLCENGINE_IP_CREATE_TASK_PATH: '/api/v3/contents/generations/tasks',
    getVolcengineIpApiSettings: async () => ({ enabled: true, api_key: apiKey, default_model: model20, base_url: 'https://ark.fixture.invalid' }), isVolcengineIpApiReady: () => true });
  provider = load('src/lib/provider/volcengine-ip.ts'); reference = load('src/lib/character-assets/video-reference.server.ts');
  const selected = [{ kind: 'site_image', referenceImageId: 'site-left' }, { kind: 'ark_asset', characterAssetId: character.id, revision: 3 }, { kind: 'site_image', referenceImageId: 'site-right' }];
  const body = { entry: 'ip', provider: 'volcengine_ip', model: model20, generation_mode: 'all_in_one_reference', prompt: personal, duration: 5, resolution: '720p', ratio: '16:9',
    project_id: 'fixture-project', creation_contract_version: 2, video_prompt_groups_contract: 1, video_prompt_groups: refs, reference_image_inputs: selected, reference_image_ids: ['site-left', 'site-right'], pricing_revision: 'fixture-pricing' };
  const characters = await reference.resolveVideoCharacterReferences(users.ordinary, body);
  const orderedUrls = reference.orderedVideoImageUrls(selected, ['https://site.fixture.invalid/left.png', 'https://site.fixture.invalid/right.png'], characters);
  await check('unapproved private Ark endpoint is rejected before any synthetic transport', async () => {
    let calls = 0;
    await assert.rejects(() => provider.createVolcengineIpVideoTask({ ...body, prompt: compiled.prompt, reference_image_urls: orderedUrls }, { privateOrigins: compiled.origins, fetchImpl: async () => { calls++; throw new Error('must not send'); } }));
    assert.equal(calls, 0);
  });
  policy.destinations = [{ endpoint, provider: 'volcengine_ark', credentialVersion: transport.privateCredentialVersion('volcengine_ark', apiKey), models: [model20, model25] }]; updatePolicy();
  await check('actual approved private provider sends compiled body and site/asset/site order for both IP models', async () => {
    for (const model of [model20, model25]) {
      let calls = 0;
      const result = await provider.createVolcengineIpVideoTask({ ...body, model, prompt: compiled.prompt, reference_image_urls: orderedUrls }, { privateOrigins: compiled.origins, fetchImpl: async (url, init) => {
        calls++; assert.equal(url, endpoint); assert.equal(init.redirect, 'error'); const payload = JSON.parse(init.body);
        assert.equal(payload.content[0].text, compiled.prompt); assert.deepEqual(payload.content.slice(1), orderedUrls.map(url => ({ type: 'image_url', image_url: { url }, role: 'reference_image' })));
        return new Response(JSON.stringify({ id: `mock-${model}`, prompt: compiled.prompt, echoed: { prompt: compiled.prompt } }));
      } });
      assert.equal(calls, 1); assert.equal(result.provider_task_id, `mock-${model}`); secretFree(result);
    }
  });
  await check('wrong credential/model/endpoint/provider approval blocks before transport; redirects never follow', async () => {
    for (const patch of [{ apiKey: 'wrong-key' }, { model: 'wrong-model' }, { baseUrl: 'https://unapproved.fixture.invalid' }]) {
      let calls = 0; await assert.rejects(() => provider.createVolcengineIpVideoTask({ ...body, prompt: compiled.prompt, reference_image_urls: orderedUrls, ...(patch.model ? { model: patch.model } : {}) }, { ...patch, privateOrigins: compiled.origins, fetchImpl: async () => { calls++; throw new Error('must not send'); } })); assert.equal(calls, 0);
    }
    const approved = policy.destinations[0]; policy.destinations = [{ ...approved, provider: 'seedance' }]; updatePolicy();
    let wrongProviderCalls = 0; await assert.rejects(() => provider.createVolcengineIpVideoTask({ ...body, prompt: compiled.prompt, reference_image_urls: orderedUrls }, { privateOrigins: compiled.origins, fetchImpl: async () => { wrongProviderCalls++; throw new Error('must not send'); } })); assert.equal(wrongProviderCalls, 0);
    policy.destinations = [approved]; updatePolicy(); let redirects = 0;
    await assert.rejects(() => provider.createVolcengineIpVideoTask({ ...body, prompt: compiled.prompt, reference_image_urls: orderedUrls }, { privateOrigins: compiled.origins, fetchImpl: async (_url, init) => { redirects++; assert.equal(init.redirect, 'error'); return new Response('', { status: 302, headers: { Location: 'https://forbidden.fixture.invalid' } }); } })); assert.equal(redirects, 1);
  });
  // Additional actual preparation/acceptance and browser DTO checks are below.
  await checkCreationAndProjection({ refs, personal, compiled, body, selected, orderedUrls });
  await check('reader-only guard blocks new group execution while encrypted historical definitions remain readable', async () => {
    groupGuard.VIDEO_PROMPT_GROUP_WRITES_ENABLED = false;
    try {
      for (const entry of ['ordinary', 'ip']) assert.throws(() => contract.assertVideoPromptGroupSurface({ ...body, entry, provider: entry === 'ip' ? 'volcengine_ip' : 'seedance' }), error => error.status === 426);
      assert.equal((await groups.readVideoPromptGroupDetail(users.author, refs[0])).body, secrets[0]); secretFree(await groups.videoPromptGroupSelections(users.ordinary, refs));
      assert.ok(settings.get(`video_prompt_group_version_v1:${refs[0].groupId}:${refs[0].versionId}`).includes('ppenc:'));
    } finally { groupGuard.VIDEO_PROMPT_GROUP_WRITES_ENABLED = true; }
  });
  report();
}

function report() {
  console.log(JSON.stringify({ passed: checks.length, checks, readerOnly, simulationOnly, actualGroupWriteFlag, effectiveGroupWriteFlag: groupGuard.VIDEO_PROMPT_GROUP_WRITES_ENABLED, sourceSha256, submissionClassification,
    isolation: { realDatabase: false, productionWrites: 0, externalRequests, paidGenerations: 0, browserRuns: 0 },
    boundary: simulationOnly ? 'Explicit reader-only fixture simulation; actual source flag remains as reported. This is not guard artifact evidence.' : 'Engineering simulation of actual modules with synthetic crypto policy and mocked I/O; no deployed or user interaction acceptance claimed.' }, null, 2));
}
function setupCreation() {
  const { pricingFingerprint } = functions('src/lib/pricing/catalog.ts', ['pricingCanonical', 'pricingFingerprint'], { createHash });
  const context = { payer: { kind: 'user', id: users.ordinary.id, label: 'fixture payer' }, project: { type: 'personal' } };
  modules.set('@/lib/pricing/catalog', { pricingFingerprint });
  modules.set('@/lib/pricing/video', { quoteVideoPricing: async () => ({ revision: 'fixture-pricing', pricing: { estimatedCost: 5 } }),
    requireVideoPricingRevision: (quote, revision) => assert.equal(revision, quote.revision) });
  modules.set('@/lib/pricing/video-context', { resolveVideoPricingContext: async () => { throw new Error('IP must not use gateway quote context'); } });
  modules.set('@/lib/projects/permissions', { assertProjectActiveInTransaction: async () => {},
    assertCanViewTask: async (user, task) => { if (user.id !== (task.owner_user_id || task.user_id)) throw new AuthError('owner denied'); }, getTaskWhereForUser: async user => ({ user_id: user.id }) });
  modules.set('@/lib/credits/precision', { creditCents: cost => Math.round(cost * 100) });
  modules.set('@/lib/works/source-policy', { freezeWorkSourcePolicy: async () => {} });
  modules.set('@/lib/canvas-reference-inputs', { applyCanvasReferenceInputs: value => value, resolveCanvasReferenceInputs: async () => null });
  modules.set('@/lib/canvas-references', { normalizeCanvasReferences: value => value });
  modules.set('@/lib/video/feishu-contract', { normalizeVideoFeishuChoice: value => value, VideoFeishuError: class extends Error {} });
  modules.set('@/lib/video/multiview-action-video.server', { resolveMultiviewActionVideoInput: async () => null });
  for (const [key, value] of Object.entries({
    './context': { assertVideoCreationReady: async () => {}, readCreationContext: async () => context },
    './availability': { readCreationAvailability: async () => ({ canSubmit: true, reasons: [] }), creationNeedsApproval: () => false },
    './lineage': { creationParent: () => null, creationTaskLineage: async () => ({}), assertCreationLineageUnlocked: async () => {} },
    './approval': { consumeCreationApproval: async () => { approvalCalls++; } },
    './preparation-receipts': { assertNoPreparationRejection: async () => {} }, './receipts': {}, '@/lib/tasks/enhance-video-create': {},
  })) modules.set(key, value);
  creation = load('src/lib/creation/intents.ts');
}
async function checkCreationAndProjection({ refs, personal, compiled, body }) {
  setupCreation();
  const preparation = { ...body, request_id: id(), video_prompt_group_fingerprint: 'client-forged-fingerprint' };
  let ready;
  await check('actual prepare freezes authoritative group fingerprint and retains only personal text plus refs', async () => {
    const reads = transactionGroupReads; ready = await creation.prepareVideoCreationIntent(users.ordinary, preparation);
    const row = intentsStore.get(ready.id), spec = JSON.parse(row.spec_json);
    assert.equal(spec.input.video_prompt_group_fingerprint, compiled.fingerprint);
    assert.deepEqual(spec.input.video_prompt_groups, refs); assert.equal(spec.input.prompt, personal); secretFree(row); secretFree(ready);
    assert.equal(row.input_hash, creation.creationSpecHash(spec)); assert.ok(transactionGroupReads > reads);
  });
  await check('actual spec and quote business hashes change for reordered groups, version and personal input', async () => {
    const original = intentsStore.get(ready.id), replacement = { groupId: refs[0].groupId, versionId: definitions[0].head.versionId };
    for (const patch of [{ video_prompt_groups: [...refs].reverse() }, { video_prompt_groups: [replacement, refs[1]] }, { prompt: `${personal} 独立修改` }]) {
      const changed = await creation.prepareVideoCreationIntent(users.ordinary, { ...preparation, ...patch, request_id: id() });
      const row = intentsStore.get(changed.id); assert.notEqual(row.input_hash, original.input_hash); assert.notEqual(row.quote_business_hash, original.quote_business_hash); secretFree(row);
      const before = taskUpdates.length;
      await assert.rejects(() => creation.acceptVideoCreationIntent(db, users.ordinary, { ...body, ...patch, intent_id: ready.id, intent_revision: ready.revision, idempotency_key: preparation.request_id }, { taskId: 'must-not-accept', cost: 5, pricingRevision: 'fixture-pricing' }), error => error.status === 409);
      assert.equal(taskUpdates.length, before);
    }
  });
  await check('actual preparation and acceptance reject permission revocation inside transaction before writes', async () => {
    const count = intentsStore.size;
    beforeTransaction = () => setHead(0, { shared: false });
    await assert.rejects(() => creation.prepareVideoCreationIntent(users.ordinary, { ...preparation, request_id: id() }), error => error.status === 403);
    assert.equal(intentsStore.size, count); setHead(0, { shared: true });
    const before = taskUpdates.length, approvals = approvalCalls;
    beforeTransaction = () => setHead(0, { shared: false });
    await assert.rejects(() => db.$transaction(tx => creation.acceptVideoCreationIntent(tx, users.ordinary, { ...body, intent_id: ready.id, intent_revision: ready.revision, idempotency_key: preparation.request_id }, { taskId: 'must-not-accept', cost: 5, pricingRevision: 'fixture-pricing' })), error => error.status === 403);
    assert.equal(taskUpdates.length, before); assert.equal(approvalCalls, approvals); setHead(0, { shared: true });
  });
  await check('actual acceptance succeeds once with frozen group fingerprint and original identity', async () => {
    const input = { ...body, intent_id: ready.id, intent_revision: ready.revision, idempotency_key: preparation.request_id };
    const before = taskUpdates.length, approvals = approvalCalls;
    for (let index = 0; index < 2; index++) await db.$transaction(tx => creation.acceptVideoCreationIntent(tx, users.ordinary, input, { taskId: 'mock-accepted-task', cost: 5, pricingRevision: 'fixture-pricing' }));
    assert.equal(intentsStore.get(ready.id).accepted_task_id, 'mock-accepted-task'); assert.equal(taskUpdates.length, before + 1); assert.equal(approvalCalls, approvals + 1);
  });
  const taskId = 'fixture-group-task';
  const sealedTask = execution.protectVideoPromptGroupTask({ id: taskId, prompt: personal, final_prompt_snapshot: compiled.prompt }, compiled.origins);
  const sealedSnapshot = execution.protectVideoPromptGroupSnapshot({ id: 'fixture-snapshot', prompt_rendered: compiled.prompt,
    provider_payload_json: JSON.stringify({ model: model20, content: [{ type: 'text', text: compiled.prompt }] }) }, compiled.origins);
  await check('actual task and snapshot protectors encrypt server plaintext and decrypt only with exact frozen binding', () => {
    secretFree(sealedTask); secretFree(sealedSnapshot);
    assert.equal(crypto.openPrivatePrompt(sealedTask.final_prompt_snapshot, { kind: 'video-task', id: taskId, field: 'final_prompt_snapshot', origins: compiled.origins }), compiled.prompt);
    for (const field of ['prompt_rendered', 'provider_payload_json']) assert.ok(sealedSnapshot[field].startsWith('ppenc:'));
    assert.throws(() => crypto.openPrivatePrompt(sealedTask.final_prompt_snapshot, { kind: 'video-task', id: 'wrong-task', field: 'final_prompt_snapshot', origins: compiled.origins }));
  });
  const privacy = load('src/lib/video/multiview-task-privacy.ts');
  taskFixture = { ...sealedTask, user_id: users.ordinary.id, owner_user_id: users.ordinary.id, provider: 'volcengine_ark', model: model20, provider_task_id: 'mock-upstream-task',
    source_metadata_json: JSON.stringify({ video_prompt_groups: { schema: 1, refs } }), generation_mode: 'all_in_one_reference', ratio: '16:9', duration: 5, resolution: '720p',
    seed: -1, generate_audio: true, return_last_frame: false, watermark: false, local_status: 'submitted', provider_status: 'queued',
    params_json: JSON.stringify({ model: model20, prompt: compiled.prompt, raw: compiled.prompt }), snapshot_id: null,
    raw_create_response: compiled.prompt, raw_status_response: compiled.prompt, error_message: compiled.prompt,
    project_id: 'fixture-project', video_card_id: null, video_branch_id: null, public_video_url: 'https://media.fixture.invalid/result.mp4',
    created_at: new Date(), updated_at: new Date(), completed_at: null, unknown: compiled.prompt };
  await check('actual positive projection hides group bodies for task/owner/public DTOs and keeps refs and delivered media', () => {
    const projected = privacy.projectPrivateMultiviewTask(taskFixture); secretFree(projected);
    assert.equal(projected.prompt, personal); assert.deepEqual(projected.video_prompt_groups, refs); assert.equal(projected.public_video_url, taskFixture.public_video_url);
    secretFree(privacy.projectSelectedMultiviewTask(taskFixture));
  });
  modules.set('@/lib/integrations/codex', { hasCodexApiAuthSignal: () => false, CodexApiAuthError: class extends Error {} });
  modules.set('@/lib/video-cards/permissions', { assertCanViewVideoCard: async () => {} });
  modules.set('@/lib/video/task-finalizer', { finalizeVideoTaskStatus: async () => ({ task: taskFixture, providerError: null }) });
  await check('actual IP status and list GET modules do not expose frozen groups or provider echoes', async () => {
    const status = load('src/app/api/ip/video/status/[id]/route.ts'), list = load('src/app/api/ip/video/list/route.ts');
    const request = new Request('https://app.fixture.invalid/api/ip/video/list'); request.nextUrl = new URL(request.url);
    const statusResponse = await status.GET(request, { params: { id: taskId } }); assert.equal(statusResponse.status, 200); secretFree(await statusResponse.json());
    const listResponse = await list.GET(request); assert.equal(listResponse.status, 200); const result = await listResponse.json(); assert.equal(result.tasks.length, 1); secretFree(result);
  });
  await check('combined IP groups/Ark refs retain owner frozen selection and hide private URI/body from authorized nonowners', async () => {
    const original = taskFixture, previousActor = actor, permissions = modules.get('@/lib/projects/permissions'), previousPermission = permissions.assertCanViewTask;
    const typed = [{ kind: 'site_image', referenceImageId: 'site-left' }, { kind: 'ark_asset', characterAssetId: character.id, revision: character.revision }, { kind: 'site_image', referenceImageId: 'site-right' }];
    const frozen = [{ characterAssetId: character.id, revision: character.revision, name: character.name, assetId: character.asset_id, uri: `asset://${character.asset_id}`, position: 2 }];
    taskFixture = { ...original, source_metadata_json: JSON.stringify({ video_prompt_groups: { schema: 1, refs }, private_character_assets: true }),
      reference_image_urls: JSON.stringify(['https://site.fixture.invalid/left.png', frozen[0].uri, 'https://site.fixture.invalid/right.png']),
      params_json: JSON.stringify({ model: model20, prompt: compiled.prompt, characterAssetReferences: frozen, reference_image_inputs: typed }) };
    try {
      const status = load('src/app/api/ip/video/status/[id]/route.ts'), list = load('src/app/api/ip/video/list/route.ts');
      const request = new Request('https://app.fixture.invalid/api/ip/video/list'); request.nextUrl = new URL(request.url);
      const ownResponse = await status.GET(request, { params: { id: taskId } }); assert.equal(ownResponse.status, 200); const own = await ownResponse.json();
      secretFree(own); assert.deepEqual(own.character_asset_references, frozen); assert.deepEqual(own.reference_image_inputs, typed); assert.deepEqual(own.video_prompt_groups, refs);
      actor = users.author; permissions.assertCanViewTask = async () => {};
      const foreignResponse = await status.GET(request, { params: { id: taskId } }); assert.equal(foreignResponse.status, 200); const foreign = await foreignResponse.json();
      secretFree(foreign); assert.equal(JSON.stringify(foreign).includes('asset://'), false); assert.equal(foreign.character_asset_references, undefined); assert.equal(foreign.reference_image_inputs, undefined);
      const listResponse = await list.GET(request); assert.equal(listResponse.status, 200); const listBody = await listResponse.json(); secretFree(listBody); assert.equal(JSON.stringify(listBody).includes('asset://'), false);
      const central = privacy.projectPrivateMultiviewTask(taskFixture); secretFree(central); assert.equal(JSON.stringify(central).includes('asset://'), false);
    } finally { taskFixture = original; actor = previousActor; permissions.assertCanViewTask = previousPermission; }
  });
  await check('actual reuse POST restores only personal prompt and immutable group refs without server bodies', async () => {
    class TaskReuseOperationError extends Error {}
    modules.set('@/lib/access/feature-guard', { assertInternalOnly: () => {} });
    modules.set('@/lib/video/multiview-private-create.server', { readSafePrivateMultiviewInput: () => { throw new Error('not a multiview fixture'); } });
    modules.set('@/lib/navigation/task-reuse-operation.server', {
      TaskReuseOperationError, taskReusePrivateHeaders: { 'Cache-Control': 'private, no-store' }, taskReuseSourceStamp: () => 'fixture-stamp',
      taskReuseRequest: value => value, readTaskReuseOperation: async () => ({ status: 200, body: { reuse: { status: 'unknown' } } }),
      finishTaskReuseOperation: async (_user, _id, _operation, outcome) => ({ status: outcome.rejection?.status || 200, body: { ...outcome.payload, reuse: { status: outcome.rejection ? 'rejected' : 'applied' } } }),
    });
    const reuse = load('src/app/api/tasks/[id]/reuse/route.ts');
    const response = await reuse.POST(new Request('https://app.fixture.invalid/api/tasks/fixture/reuse', { method: 'POST', headers: { 'x-video-prompt-groups-contract': '1' }, body: JSON.stringify({ surface: 'ip' }) }), { params: { id: taskId } });
    assert.equal(response.status, 200); const result = await response.json(); secretFree(result);
    assert.equal(result.draft.prompt, personal); assert.deepEqual(result.draft.video_prompt_groups, refs);
  });
  await check('actual provider-status router removes supplier group echoes but preserves numeric billing facts', async () => {
    modules.set('./h3', { H3_VIDEO_PROVIDER: 'h3', getH3TaskStatus: async () => { throw new Error('unexpected H3'); } });
    modules.set('./jimeng', { getVideoTaskStatus: async () => { throw new Error('unexpected gateway'); } });
    modules.set('./aimediakit-enhance-video', { getAiMediaKitTaskStatus: async () => { throw new Error('unexpected enhance'); } });
    const router = load('src/lib/provider/video-task-status.ts');
    const output = await router.getProviderTaskStatus(taskFixture, { fetchers: { volcengineIp: async () => ({ provider_status: 'succeeded', local_status: 'succeeded', actual_cost: 5, currency_or_credit_type: 'CNY', usage: { completion_tokens: 42, echoed_prompt: compiled.prompt }, raw: { prompt: compiled.prompt } }) } });
    secretFree(output); assert.equal(output.actual_cost, 5); assert.equal(output.usage.completion_tokens, 42);
  });
  await check('actual IP ledger payload and response spread expose immutable refs without compiled body', () => {
    const file = 'src/app/api/ip/tasks/create/route.ts';
    const requestPayload = expression(file, node => {
      if (!ts.isCallExpression(node) || node.expression.getText() !== 'createProviderApiRequest') return;
      const property = node.arguments[0]?.properties?.find(item => ts.isPropertyAssignment(item) && item.name.getText() === 'requestPayload'); return property?.initializer;
    }, { groupRefs: refs, VOLCENGINE_IP_VIDEO_PROVIDER: 'volcengine_ark', selectedModel: model20, generationMode: 'all_in_one_reference', requestedRatio: '16:9', duration: 5, resolution: '720p',
      providerPayload: { content: [{ type: 'text', text: compiled.prompt }] } });
    secretFree(requestPayload); assert.deepEqual(requestPayload.video_prompt_groups.refs, refs); assert.equal(requestPayload.content, undefined);
    const responseSpread = expression(file, node => {
      if (!ts.isCallExpression(node) || node.expression.getText() !== 'NextResponse.json' || !ts.isObjectLiteralExpression(node.arguments[0])) return;
      const object = node.arguments[0];
      if (!object.properties.some(item => ts.isPropertyAssignment(item) && item.name.getText() === 'pricing')) return;
      return object.properties.find(item => ts.isSpreadAssignment(item) && item.expression.getText().includes('groupRefs.length'))?.expression;
    }, { groupRefs: refs, promptRendered: compiled.prompt, assetMapping: { secret: compiled.prompt } });
    secretFree(responseSpread); assert.deepEqual(responseSpread.video_prompt_groups, refs); assert.equal(responseSpread.prompt_rendered, undefined); assert.equal(responseSpread.asset_mapping, undefined);
    const noSend = new crypto.PrivatePromptError(), attempted = new crypto.PrivatePromptError(); attempted.deliveryAttempted = true;
    const refused = new provider.VolcengineIpRequestError({ statusCode: 400, normalized: { code: 'InvalidParameter', category: 'asset', retryable: false, userMessage: '明确拒绝' } });
    for (const [kind, err, expected] of [['private-no-send', noSend, false], ['private-delivery-attempted', attempted, true], ['explicit-provider-4xx', refused, false]]) {
      const explicitProviderRejection = expression(file, node => ts.isVariableDeclaration(node) && node.name.getText() === 'explicitProviderRejection' ? node.initializer : undefined,
        { providerTaskId: null, err, VolcengineIpRequestError: provider.VolcengineIpRequestError });
      const unconfirmed = expression(file, node => ts.isIfStatement(node) && node.expression.getText().startsWith('submissionStarted &&') ? node.expression : undefined,
        { submissionStarted: true, explicitProviderRejection, err, isPrivatePromptError: crypto.isPrivatePromptError });
      assert.equal(unconfirmed, expected, kind); submissionClassification.push({ kind, explicitProviderRejection, unconfirmed });
    }
    const { volcengineProviderHttpStatus } = functions(file, ['volcengineProviderHttpStatus'], { VolcengineIpConfigurationError: provider.VolcengineIpConfigurationError, VolcengineIpRequestError: provider.VolcengineIpRequestError });
    const noSendStatus = expression(file, node => ts.isVariableDeclaration(node) && node.name.getText() === 'providerHttpStatus' ? node.initializer : undefined,
      { err: noSend, isPrivatePromptError: crypto.isPrivatePromptError, volcengineProviderHttpStatus });
    assert.equal(noSendStatus, 503); submissionClassification.push({ kind: 'private-no-send-http-status', status: noSendStatus });
  });
}
async function checkReaderOnly(refs, personal) {
  setupCreation();
  const compiled = await groups.resolveVideoPromptGroups(users.ordinary, refs, personal);
  const input = { entry: 'ip', provider: 'volcengine_ip', model: model20, prompt: personal, duration: 5, resolution: '720p', ratio: '16:9', generation_mode: 'all_in_one_reference',
    project_id: 'fixture-project', creation_contract_version: 2, video_prompt_groups_contract: 1, video_prompt_groups: refs, pricing_revision: 'fixture-pricing' };
  await check('reader: actual group guard rejects new ordinary/IP execution, definition save and new preparation', async () => {
    assert.equal(groupGuard.VIDEO_PROMPT_GROUP_WRITES_ENABLED, false);
    for (const entry of ['ordinary', 'ip']) assert.throws(() => contract.assertVideoPromptGroupSurface({ ...input, entry, provider: entry === 'ip' ? 'volcengine_ip' : 'seedance' }), error => error.status === 426);
    await assert.rejects(() => groups.saveVideoPromptGroup(users.author, {}), error => error.status === 426);
    await assert.rejects(() => creation.prepareVideoCreationIntent(users.ordinary, { ...input, request_id: id() }), error => error.status === 426);
    assert.equal(intentsStore.size, 0); assert.equal(taskUpdates.length, 0);
  });
  await check('reader: encrypted immutable definition and newly encrypted IP task/snapshot stay readable without public body', async () => {
    assert.equal((await groups.readVideoPromptGroupDetail(users.author, refs[0])).body, secrets[0]);
    secretFree(await groups.videoPromptGroupSelections(users.ordinary, refs));
    const task = execution.protectVideoPromptGroupTask({ id: 'reader-task', prompt: personal, final_prompt_snapshot: compiled.prompt }, compiled.origins);
    const snapshot = execution.protectVideoPromptGroupSnapshot({ id: 'reader-snapshot', prompt_rendered: compiled.prompt, provider_payload_json: JSON.stringify({ prompt: compiled.prompt }) }, compiled.origins);
    secretFree(task); secretFree(snapshot);
    assert.equal(crypto.openPrivatePrompt(task.final_prompt_snapshot, { kind: 'video-task', id: task.id, field: 'final_prompt_snapshot', origins: compiled.origins }), compiled.prompt);
    assert.equal(crypto.openPrivatePrompt(snapshot.prompt_rendered, { kind: 'video-generation-snapshot', id: snapshot.id, field: 'prompt_rendered', origins: compiled.origins }), compiled.prompt);
    taskFixture = { ...task, user_id: users.ordinary.id, owner_user_id: users.ordinary.id, provider: 'volcengine_ark', provider_task_id: null, model: model20,
      source_metadata_json: JSON.stringify({ video_prompt_groups: { schema: 1, refs } }), idempotency_key: 'reader-original-key',
      generation_mode: 'all_in_one_reference', duration: 5, resolution: '720p', ratio: '16:9', local_status: 'submitted', provider_status: 'queued',
      project_id: 'fixture-project', video_card_id: null, created_at: new Date(), updated_at: new Date(), completed_at: null,
      raw_create_response: compiled.prompt, raw_status_response: compiled.prompt, error_message: compiled.prompt,
      params_json: JSON.stringify({ model: model20, prompt: compiled.prompt }), unknown: compiled.prompt };
    const privacy = load('src/lib/video/multiview-task-privacy.ts'); secretFree(privacy.projectPrivateMultiviewTask(taskFixture));
  });
  await check('reader: accepted original preparation and intent GET remain readable without new writes', async () => {
    const spec = { version: 2, action: 'generate', entry: 'ip', project_id: 'fixture-project', video_card_id: null, video_branch_id: null,
      continuation: { mode: 'new' }, baseline_task_id: null, input_source_task_ids: [], count: 1,
      input: { ...input, video_prompt_group_fingerprint: compiled.fingerprint } };
    const row = { id: id(), owner_id: users.ordinary.id, request_id: 'reader-accepted-request', revision: 1, count: 1, state: 'accepted', accepted_task_id: taskFixture.id,
      batch_id: null, project_id: spec.project_id, payer_kind: 'user', payer_account_id: users.ordinary.id, input_hash: creation.creationSpecHash(spec),
      quote_business_hash: 'frozen-business-hash', pricing_revision: 'fixture-pricing', spec_json: JSON.stringify(spec), created_at: new Date(), updated_at: new Date() };
    intentsStore.set(row.id, row);
    const prepared = await creation.prepareVideoCreationIntent(users.ordinary, { ...input, request_id: row.request_id });
    assert.equal(prepared.accepted_task_id, taskFixture.id); secretFree(prepared);
    const read = await creation.getVideoCreationIntent(users.ordinary, row.id); assert.equal(read.state, 'accepted'); secretFree(read);
    assert.equal(intentsStore.size, 1); assert.equal(taskUpdates.length, 0);
  });
  await check('reader: actual IP create POST blocks a new group before provider/create writes', async () => {
    let creates = 0;
    const post = functions('src/app/api/ip/tasks/create/route.ts', ['POST'], {
      AuthError, VideoPromptGroupError: contract.VideoPromptGroupError, PrivatePromptError: crypto.PrivatePromptError,
      webRequestSource: () => ({ source_type: 'web', source_label: 'fixture' }), hasCodexApiAuthSignal: () => false, getSessionUser: async () => users.ordinary,
      videoPricingBusinessFingerprint: () => 'fixture-fingerprint', parseVideoPromptGroupRefs: contract.parseVideoPromptGroupRefs,
      getVolcengineIpApiSettings: async () => ({ default_model: model20 }), isVolcengineIpApiReady: () => true,
      restoreCanvasVideoBatchCreate: async (_user, body) => ({ body, admission: null }),
      assertVideoPromptGroupSurface: contract.assertVideoPromptGroupSurface,
      NextResponse: { json: (value, init) => new Response(JSON.stringify(value), init) }, errorJson: (error, status) => new Response(JSON.stringify({ error }), { status }),
      createVolcengineIpVideoTask: async () => { creates++; throw new Error('reader must never create'); },
      prisma: new Proxy({}, { get: () => { creates++; throw new Error('new reader create must stop before task writes'); } }),
    }).POST;
    const response = await post(new Request('https://app.fixture.invalid/api/ip/tasks/create', { method: 'POST', body: JSON.stringify(input) }));
    assert.equal(response.status, 426); assert.equal(creates, 0); secretFree(await response.json());
  });
  await check('reader: actual original-request/status/list GETs remain readable with no private body or provider send', async () => {
    modules.set('@/lib/integrations/codex', { hasCodexApiAuthSignal: () => false, CodexApiAuthError: class extends Error {} });
    modules.set('@/lib/video-cards/permissions', { assertCanViewVideoCard: async () => {} });
    modules.set('@/lib/video/task-finalizer', { finalizeVideoTaskStatus: async () => { throw new Error('reader fixture has no upstream ID'); } });
    const original = load('src/app/api/ip/tasks/request-status/route.ts'), status = load('src/app/api/ip/video/status/[id]/route.ts'), list = load('src/app/api/ip/video/list/route.ts');
    const request = new Request('https://app.fixture.invalid/api/ip/tasks/request-status?idempotency_key=reader-original-key'); request.nextUrl = new URL(request.url);
    const receipt = await original.GET(request); assert.equal(receipt.status, 200); const originalBody = await receipt.json();
    assert.equal(originalBody.task.id, taskFixture.id); assert.equal(originalBody.safeToResubmit, false); secretFree(originalBody);
    const statusResponse = await status.GET(request, { params: { id: taskFixture.id } }); assert.equal(statusResponse.status, 200); secretFree(await statusResponse.json());
    const listResponse = await list.GET(request); assert.equal(listResponse.status, 200); secretFree(await listResponse.json());
    assert.equal(taskUpdates.length, 0);
  });
}
try { await main(); }
catch (error) { console.error(error); process.exitCode = 1; }
finally {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(previousEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(fixture, { recursive: true, force: true });
}
