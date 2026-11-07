// Engineering fixtures only: no browser, live database, provider calls or charges.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '..');
class AuthError extends Error { constructor(message, status = 403) { super(message); this.status = status; } }
const plain = value => JSON.parse(JSON.stringify(value));
function load(file, dependencies) {
  const exports = {}, source = fs.readFileSync(path.join(root, file), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText,
  { exports, process, console: { info() {}, error() {} }, require(id) {
    if (Object.hasOwn(dependencies, id)) return dependencies[id];
    if (id === 'node:crypto') return require(id);
    throw new Error(`Unregistered dependency ${id}`);
  } }, { filename: file });
  return exports;
}
const actor = { id: 'owner', role: 'user', account_type: 'internal', status: 'active' };
const task = { id: 'source', user_id: actor.id, owner_user_id: actor.id, retention_status: 'active',
  provider: 'seedance', model: 'doubao-seedance-2-5-260628', generation_mode: 'all_in_one_reference',
  prompt: 'original prompt', ratio: '16:9', duration: 5, resolution: '720p', seed: -1,
  generate_audio: true, return_last_frame: false, watermark: false, project_id: null, params_json: null,
  snapshot_id: 'snapshot', reference_image_urls: '["https://fixture.invalid/image.png"]' };
const asset = (id, allowed = false) => ({ id, type: 'image', status: 'active', original_url: 'https://fixture.invalid/image.png', reference_images: [], allowed });
async function routeCases() {
  const state = { assets: [asset('original', true), asset('other-owner')], snapshot: true, outcome: null, promptGroups: false, promptGroupsEnabled: true };
  const prisma = { videoTask: { findUnique: async () => task },
    generationTaskSnapshot: { findUnique: async () => state.snapshot ? {
      asset_mapping_json: '{"图1":"original"}', content_json: '[{"type":"image_url","role":"reference_image","image_url":{"url":"https://fixture.invalid/image.png"}}]' } : null },
    workspaceAsset: { findMany: async () => [] },
    asset: { findMany: async ({ where }) => where.id ? state.assets.filter(a => where.id.in.includes(a.id))
      : state.assets.filter(a => where.OR.some(filter => filter.id?.in.includes(a.id) || filter.original_url?.in.includes(a.original_url))) },
    referenceImage: { findMany: async () => [] } };
  const mod = load('src/app/api/tasks/[id]/reuse/route.ts', {
    'next/server': { NextResponse: { json: (body, options = {}) => ({ body, status: options.status || 200 }) } },
    '@/lib/prisma': { prisma }, '@/lib/auth/session': { AuthError, getSession: async () => actor },
    '@/lib/access/feature-guard': { assertInternalOnly() {} }, '@/lib/projects/permissions': { assertCanViewTask: async () => {} },
    '@/lib/video/multiview-task-privacy': { isPrivateMultiviewTask: () => false, isPrivateMultiviewActionTask: () => false },
    '@/lib/video/prompt-groups': { videoPromptGroupTaskRefs: () => state.promptGroups ? [{ id: 'fixture-group' }] : [] },
    '@/lib/video/prompt-groups-build-mode': { get VIDEO_PROMPT_GROUP_WRITES_ENABLED() { return state.promptGroupsEnabled; } },
    '@/lib/video/prompt-groups.server': { videoPromptGroupSelections: async () => [] }, '@/lib/video/multiview-private-create.server': {},
    '@/lib/navigation/task-reuse-operation.server': { TaskReuseOperationError: class extends Error {},
      taskReuseRequest: () => ({ surface: 'normal' }), taskReuseSourceStamp: () => 'stamp', taskReusePrivateHeaders: {},
      readTaskReuseOperation: async () => ({ body: { reuse: { status: 'unknown' } } }),
      finishTaskReuseOperation: async (_actor, _source, _request, input) => {
        state.outcome = input; return { status: input.rejection?.status || 200, body: { ...input.payload, code: input.rejection?.code } };
      } },
    '@/lib/reference-albums/permissions': { uniquePreserveOrder: a => [...new Set(a)],
      canUseDirectAsset: async (_actor, id) => state.assets.some(a => a.id === id && a.allowed),
      assertCanUseReferenceImage: async () => { throw new AuthError('revoked'); } },
    '@/lib/provider/volcengine-ip': { VOLCENGINE_IP_VIDEO_PROVIDER: 'volcengine_ark' },
    '@/lib/provider/reference-media-policy': { seedanceReferenceMediaCapabilities: () => ({ imageLimit: 9, videoLimit: 3, audioLimit: 3 }) },
  });
  const run = (contract = null) => mod.POST({ headers: { get: key => key === 'x-video-prompt-groups-contract' ? contract : null }, json: async () => ({}) }, { params: { id: task.id } });
  state.promptGroups = true;
  assert.equal((await run()).status, 426, 'old client retains prompt-group upgrade rejection');
  assert.deepEqual(plain(state.outcome.payload), {}, 'early contract rejection must not expose a partial draft');
  state.promptGroupsEnabled = false;
  assert.equal((await run('1')).status, 426, 'server feature gate still rejects a matching client');
  assert.deepEqual(plain(state.outcome.payload), {});
  state.promptGroups = false; state.promptGroupsEnabled = true;
  for (let i = 0; i < 2; i++) {
    assert.equal((await run()).status, 200); assert.deepEqual(plain(state.outcome.items).map(a => a.assetId), ['original']); state.assets.reverse();
  }
  state.snapshot = false; state.assets = [asset('other-owner'), asset('original', true)];
  assert.equal((await run()).status, 200, 'legacy URL-only input searches currently authorized aliases');
  state.snapshot = true; state.assets = [asset('original'), asset('other-owner', true)];
  const response = await run(); assert.equal(response.status, 409); assert.equal(response.body.code, 'REUSE_ASSETS_UNAVAILABLE');
  assert.equal(response.body.draft.prompt, task.prompt); assert.equal(state.outcome.items.length, 0);
  assert(!JSON.stringify(response.body).includes('fixture.invalid'), 'unavailable URLs stay private');
  state.assets = [asset('original', true)]; state.assets[0].status = 'deleted';
  assert.equal((await run()).status, 409, 'deleted frozen asset must not be silently restored');
}
async function receiptCases() {
  const state = { rows: new Map(), mutations: 0, canView: true, workspaceConflict: false };
  const request = { protocolVersion: 2, requestId: 'fixture-request', requestHash: 'hash', nonce: 'nonce',
    tabId: 'tab', surface: 'normal', workspaceId: 'workspace', expectedWorkspaceAssets: [] };
  const db = { user: { findUnique: async () => actor }, videoTask: { findUnique: async () => task },
    workspace: { findFirst: async () => ({ id: 'workspace' }) },
    workspaceAsset: { findMany: async () => state.workspaceConflict ? [{ id: 'later-edit' }] : [],
      deleteMany: async () => { state.mutations++; }, createMany: async () => { state.mutations++; } },
    platformSetting: { findUnique: async ({ where }) => state.rows.get(where.key) || null, create: async ({ data }) => state.rows.set(data.key, data) } };
  const prisma = { ...db, $transaction: async run => run(db) };
  const mod = load('src/lib/navigation/task-reuse-operation.server.ts', {
    'server-only': {}, '@/lib/prisma': { prisma }, '@/lib/auth/session': { AuthError },
    '@/lib/projects/permissions': { getProjectAccess: async () => ({ canView: state.canView }) },
    '@/lib/tasks/retention': { isTaskHiddenFromRegularUsers: () => !state.canView },
    '@/lib/reference-albums/permissions': {}, '@/lib/assets/workspace': { normalizeWorkspaceTabId: a => a },
    '@/lib/image-studio/read-snapshot': { sharedStudioReadDiagnostics: () => ({}) },
    '@/lib/video/prompt-groups-build-mode': { VIDEO_PROMPT_GROUP_WRITES_ENABLED: true }, './task-reuse-intent': { parseTaskReuseOperationRequest: a => a },
  });
  const input = { sourceStamp: mod.taskReuseSourceStamp(task), items: [], payload: { draft: { task_id: task.id, prompt: task.prompt }, skipped_references: 1 },
    rejection: { code: 'REUSE_ASSETS_UNAVAILABLE', message: 'missing', status: 409 } };
  let result = await mod.finishTaskReuseOperation(actor, task.id, request, input);
  assert.equal(result.status, 409); assert.equal(result.body.draft.prompt, task.prompt);
  result = await mod.readTaskReuseOperation(actor, task.id, request); assert.equal(result.status, 409); assert.equal(result.body.draft.prompt, task.prompt);
  assert.equal(state.rows.size, 1); assert.equal(state.mutations, 0);
  state.canView = false; result = await mod.readTaskReuseOperation(actor, task.id, request);
  assert.equal(result.body.draft, undefined); assert.equal(result.body.reuse.code, 'REUSE_RESULT_UNAVAILABLE');
  state.canView = true; state.workspaceConflict = true;
  result = await mod.finishTaskReuseOperation(actor, task.id, { ...request, requestId: 'conflict' }, input);
  assert.equal(result.body.code, 'REUSE_WORKSPACE_CONFLICT'); assert.equal(result.body.draft, undefined); assert.equal(state.mutations, 0);
  state.workspaceConflict = false;
  const appliedRequest = { ...request, requestId: 'applied' };
  const accepted = { sourceStamp: input.sourceStamp, items: [], payload: input.payload };
  result = await mod.finishTaskReuseOperation(actor, task.id, appliedRequest, accepted);
  assert.equal(result.body.reuse.status, 'applied'); assert.equal(state.mutations, 1);
  result = await mod.finishTaskReuseOperation(actor, task.id, appliedRequest, accepted);
  assert.equal(result.body.reuse.status, 'applied'); assert.equal(state.mutations, 1, 'original receipt must not repeat workspace replacement');
}
async function modelCases() {
  const Module = require('node:module'), original = Module._load;
  Module._load = function(id, ...args) { return id === 'server-only' ? {} : original.call(this, id, ...args); };
  try {
    const catalog = require('../src/lib/image-studio/model-catalog.ts'), { DEFAULT_STUDIO_PRICES } = require('../src/lib/image-studio/settings.ts');
    const { requestStudioImages } = require('../src/lib/image-studio/provider.ts');
    const { getImageGenerationChannels } = require('../src/lib/integrations/image-generation.ts');
    const channels = await getImageGenerationChannels({ platformSetting: { findUnique: async () => null } }, false, undefined, false);
    for (const model of ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst']) {
      assert(catalog.IMAGE_STUDIO_NEW_REQUEST_MODELS.includes(model));
      assert.equal(channels.fluxport.modelCapabilities[model].enabled, false);
      assert.equal(channels.fluxport.modelCapabilities[model].protocol, 'openai_images');
      assert.equal(channels.legacyPrices[model], null, 'new model cannot inherit the old 20-point fallback');
      assert.equal(DEFAULT_STUDIO_PRICES[model], null); assert.equal(catalog.IMAGE_STUDIO_MODEL_COST_USD[model], null);
      for (const editing of [false, true]) {
        const calls = [];
        await requestStudioImages({ apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid', protocol: 'openai_images', model,
          prompt: 'fixture', count: 1, quality: 'medium', size: '2048x2048', signal: new AbortController().signal,
          images: editing ? [{ bytes: new Uint8Array([1]), mimeType: 'image/png' }] : [] }, async (url, init) => {
          calls.push({ url: String(url), body: init.body }); return Response.json({ data: [{ b64_json: 'aW1hZ2U=' }] });
        });
        assert.equal(calls.length, 1);
        const body = editing ? Object.fromEntries(calls[0].body.entries()) : JSON.parse(calls[0].body);
        assert.equal(body.model, model); assert.equal(body.quality, 'medium'); assert.equal(body.size, '2048x2048');
        assert(calls[0].url.endsWith(editing ? '/v1/images/edits' : '/v1/images/generations'));
      }
    }
    assert.throws(() => catalog.imageStudioModelForNewSelection('gpt-image-2.6'), /不支持/);
    assert.equal(catalog.imageStudioModelForNewSelection('gpt-image-2.5-sunburst'), 'gpt-image-2.5-sunburst');
  } finally { Module._load = original; }
}
(async () => { await routeCases(); await receiptCases(); await modelCases();
  console.log('PASS: frozen/legacy duplicate URL aliases, permission/deletion rejection, durable parameter-only recovery, revocation, workspace CAS, and 2.6 JSON/multipart payloads with unknown prices. No live generation/database writes.');
})().catch(error => { console.error(error); process.exitCode = 1; });
