import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { parseStoryMaterials, validateStoryDraft, composeStoryShot, separateStoryPrompt, storyGenerationPrompt, type StoryShot } from '../src/lib/story-workflow';
import { canvasImageReferencePolicy } from '../src/lib/canvas-image-references';
import { seedanceVideoDurationOptions, SEEDANCE_2_5_IP_MODEL_ID } from '../src/lib/provider/seedance-models';
import { volcengineIpCapabilities } from '../src/lib/integrations/volcengine-ip-models';
import { parseCanvasPromptMentions } from '../src/lib/canvas-prompt-references';

const checks: string[] = [];
const source = (file: string) => readFileSync(file, 'utf8');
function functionCode(file: string, names: string[]) {
  const ast = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true);
  const found = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) found.set(node.name.text, node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast); names.forEach(name => assert.ok(found.has(name), name));
  return ts.transpileModule(names.map(name => found.get(name)).join('\n') + names.map(name => `;this.${name}=${name}`).join(''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}
const shot: StoryShot = { id: 'shot-1', title: '镜头1', description: '雨夜公交站', dialogue: '', imagePrompt: '', videoPrompt: '', durationSeconds: 5 };

class FixtureAuthError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

async function verifyReviewCorrections(api: any) {
  const appFile = 'public/tools/ultimate-canvas/app.js';
  const ast = ts.createSourceFile(appFile, source(appFile), ts.ScriptTarget.Latest, true);
  let optionsCode = '';
  const findOptions = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'window.UltimateCanvasGenerationTaskCoordinator.createGenerationTaskCoordinator') optionsCode = node.arguments[0].getText(ast);
    ts.forEachChild(node, findOptions);
  };
  findOptions(ast); assert.ok(optionsCode);
  const contract: any = { URL, module: { exports: {} } };
  runInNewContext(source('public/tools/ultimate-canvas/backend-contract.js'), contract);
  for (const provider of ['seedance', 'volcengine_ip']) {
    const calls: string[] = [];
    const node = { data: { taskId: 'task', videoSubmission: { state: 'unconfirmed', input: { source_metadata: { provider } } } } };
    const vm: any = { exports: {}, window: { location: { origin: 'https://sd2.youdooart.com' }, UltimateCanvasBackendContract: contract.module.exports, UltimateCanvasGenerationNodes: api },
      engine: { nodes: new Map([['node', node]]) }, canvasRuntime: { bootstrap: {} }, CSS: { escape: (v: string) => v },
      document: { querySelector: () => null }, setNodeGenerationStatus: () => {},
      requestJson: async (url: string) => { calls.push(url); return { task: { id: 'task', local_status: 'submitted', error_code: 'IP_SUBMISSION_UNCONFIRMED' } }; } };
    runInNewContext(functionCode(appFile, ['videoStatusUrl']), vm);
    runInNewContext(`this.options = ${optionsCode};`, vm);
    const result = await vm.options.fetchStatus('task', { nodeId: 'node' });
    assert.deepEqual(calls, [provider === 'volcengine_ip' ? '/api/ip/video/status/task?refresh=true' : '/api/video/status/task?refresh=true']);
    assert.equal(result.local_status, 'unconfirmed');
  }
  checks.push('R1: actual coordinator fetchStatus callback issues ordinary/IP GET exactly once using entry.nodeId');

  const input = { model: 'ip-model', source_metadata: { provider: 'volcengine_ip' } };
  const submission = { requestId: 'original-request', state: 'unconfirmed', userId: 'user', documentId: 'doc', input,
    generationPayload: { nodeId: 'node', requestId: 'original-request', settings: { provider: 'volcengine_ip' } } };
  const storedTask = { id: 'task', user_id: 'user', project_id: 'project', video_card_id: 'card',
    source_request_id: 'ultimate_canvas:node:original-request', source_metadata_json: JSON.stringify({ canvas_document_id: 'doc', canvas_node_id: 'node' }),
    provider: 'volcengine_ark', model: 'ip-model', local_status: 'submitted', provider_task_id: null, error_code: 'IP_SUBMISSION_UNCONFIRMED' };
  const docSubmission = { ...submission, projectId: 'project', cardId: 'card' };
  let viewCalls = 0;
  const query: any = { exports: {}, AuthError: FixtureAuthError, VOLCENGINE_IP_VIDEO_PROVIDER: 'volcengine_ark',
    getSession: async () => ({ id: 'user' }), assertCanEditCanvasDocument: async () => ({ id: 'doc', project_id: 'project', document_json: JSON.stringify({ canvas: { nodes: [{ id: 'node', data: { videoSubmission: docSubmission } }] } }) }),
    prisma: { videoTask: { findUnique: async (arg: any) => { assert.equal(arg.where.user_id_idempotency_key.idempotency_key, 'node:original-request'); return storedTask; } } },
    assertCanViewTask: async () => { viewCalls++; }, json: (value: any, status = 200) => ({ value, status }) };
  runInNewContext(functionCode('src/app/api/tools/ultimate-canvas/video-submission/route.ts', ['GET']), query);
  const req = { nextUrl: { searchParams: new URLSearchParams({ document_id: 'doc', node_id: 'node', request_id: 'original-request' }) } };
  const found = await query.GET(req); assert.equal(found.status, 200); assert.equal(found.value.state, 'unconfirmed'); assert.equal(viewCalls, 1);
  assert.equal(found.value.task.error_code, 'IP_SUBMISSION_UNCONFIRMED');
  for (const field of ['user_id', 'project_id', 'video_card_id', 'source_request_id', 'provider', 'model', 'source_metadata_json'] as const) {
    const original = storedTask[field]; storedTask[field] = 'other';
    const result = await query.GET(req); assert.notEqual(result.status, 200); storedTask[field] = original;
  }
  storedTask.source_metadata_json = JSON.stringify({ canvas_document_id: 'other', canvas_node_id: 'node' });
  assert.equal((await query.GET(req)).status, 403);
  storedTask.source_metadata_json = JSON.stringify({ canvas_document_id: 'doc', canvas_node_id: 'other' });
  assert.equal((await query.GET(req)).status, 403);
  checks.push('R2/R3: real lookup accepts persisted volcengine_ark mapping; user/project/card/request/document/node/model/provider guards retained; IP error_code stays unknown');

  const node: any = { id: 'node', data: { videoSubmission: submission } };
  const polled: string[] = [], lookedUp: string[] = [];
  const noop = () => {};
  const vm: any = { exports: {}, window: { UltimateCanvasGenerationNodes: api, UltimateCanvasGenerationInteractions: { generationContextMatches: () => true } },
    canvasRuntime: { bootstrap: { user: { id: 'user' } }, documentId: 'doc', selectedVideoCardId: 'card' },
    engine: { nodes: new Map([['node', node]]) }, document: { querySelector: () => null }, CSS: { escape: (v: string) => v }, URLSearchParams,
    syncNodeDataFromDom: noop, decorateGeneratedNode: noop, renderGenerationNodeControls: noop, renderVideoResultHistory: noop,
    setNodeGenerationStatus: noop, scheduleCanvasSave: noop, showCanvasNotice: noop, taskDescription: () => '', videoStageLabel: () => '', videoPreviewForTask: () => '',
    pollVideoTask: (task: string) => polled.push(task), currentGenerationContext: () => ({}), flushCanvasSave: async () => true,
    requestJson: async (url: string) => { lookedUp.push(url); return { state: 'unconfirmed', task: { id: 'task', local_status: 'submitted', error_code: 'IP_SUBMISSION_UNCONFIRMED' } }; } };
  runInNewContext(functionCode(appFile, ['applyVideoGenerationResult', 'applyVideoTaskStatus', 'recoverVideoSubmission']), vm);
  vm.applyVideoGenerationResult(null, submission.generationPayload, { id: 'task', status: 'submitted', error_code: 'IP_SUBMISSION_UNCONFIRMED' });
  assert.equal(submission.state, 'unconfirmed'); assert.equal(node.data.taskId, 'task'); assert.equal(node.data.generationStatus, 'unconfirmed');
  await vm.recoverVideoSubmission('node', 'task');
  assert.equal(submission.state, 'unconfirmed'); assert.equal(lookedUp.length, 1); assert.ok(lookedUp[0].includes('original-request'));
  assert.equal(polled.length, 2); assert.ok(polled.every(id => id === 'task'));
  vm.applyVideoTaskStatus('node', { id: 'task', local_status: 'failed', provider_task_id: null, refunded_cost: 15 });
  assert.equal(submission.state, 'unconfirmed');
  vm.applyVideoTaskStatus('node', { id: 'task', local_status: 'running', provider_task_id: 'upstream-task' });
  assert.equal(submission.state, 'accepted');
  checks.push('R3: actual create/apply/recover preserves IP unknown and original task; refund without upstream identity cannot clear; confirmed original polling resolves it');

  const use: any = { exports: {}, AuthError: FixtureAuthError, assertCanUseReferenceImage: async (_: unknown, id: string) => ({ asset_id: id === 'legacy' ? null : 'shared-asset', asset: { id: 'shared-asset', owner_id: 'other-owner', status: 'active', type: 'image' } }) };
  runInNewContext(functionCode('src/lib/canvas-studio-reference-use.ts', ['resolveCanvasStudioReferenceUse']), use);
  const owners = await use.resolveCanvasStudioReferenceUse({ id: 'user' }, ['shared-ref']);
  assert.equal(owners.get('shared-asset'), 'other-owner');
  await assert.rejects(use.resolveCanvasStudioReferenceUse({ id: 'user' }, ['legacy']), /持久原件/);
  use.assertCanUseReferenceImage = async () => { throw new FixtureAuthError('not permitted', 403); };
  await assert.rejects(use.resolveCanvasStudioReferenceUse({ id: 'user' }, ['denied']), /not permitted/);

  const queued: any[] = [], ledger: any[] = [], assetReads: any[] = [];
  const tx: any = { imageStudioTask: { findFirst: async (arg: any) => queued.find(row => row.batch_id === arg.where.batch_id) || null, count: async () => 0, create: async ({ data }: any) => queued.push(data) },
    user: { findUnique: async () => ({ id: 'user', status: 'active', role: 'member' }) },
    asset: { count: async () => 0, findMany: async (arg: any) => { assetReads.push(arg); return [{ id: 'shared-asset', owner_id: 'other-owner', width: 1024, height: 1024 }]; } },
    creditLedger: { create: async ({ data }: any) => ledger.push(data) } };
  const submit: any = { exports: {}, createHash, StudioError: FixtureAuthError, StudioStyleError: FixtureAuthError, StudioReferencePolicyError: FixtureAuthError,
    parseStudioRequest: (body: any) => ({ ...body }), validStudioModuleId: () => true,
    prisma: { imageStudioTask: tx.imageStudioTask, $transaction: async (fn: any) => fn(tx) },
    getImageStudioSettings: async () => ({ revision: 1, context: '' }), withContextVersionRetry: (fn: any) => fn(), canUseCompanyTemplates: () => true,
    resolveCanvasStudioReferenceUse: async () => owners,
    resolveStudioModuleGenerationConfig: () => ({ model: 'gemini', quality: 'auto', resolution: '2K', prices: { gemini: 5 } }),
    IMAGE_STUDIO_MODEL_QUALITY_OPTIONS: { gemini: ['auto'] }, IMAGE_STUDIO_MODEL_COST_USD: { gemini: 0 },
    getImageGenerationSettingsForModel: async () => ({ provider: 'configured' }), isStudioImageGenerationProvider: () => true, isImageGenerationApiReady: () => true,
    resolveStudioStyleReferences: async () => ({ groups: [] }), resolveSkills: async () => [], evolutionCapability: () => null,
    validateStudioReferenceCounts: () => {}, studioVisibleAssetWhere: async () => ({}), studioTemplateAssetUrl: (id: string) => `private/${id}`,
    resolveStudioAspectRatio: () => ({ requested: '1:1', resolved: '1:1', source: 'manual' }), studioFourToOneIssue: () => '', supportsStudioFourToOne: () => false,
    normalizeImageResolution: () => '2K', imageOutputSize: () => '2048x2048', bindModuleContextVersion: async () => 'v1', MODULE_CONTEXT_VERSION_RULE: 'existing',
    allocateTaskCredits: async () => ({ snapshot: 'freeze', allocations: [], balance_before: 100, balance_after: 95, frozen_before: 0, frozen_after: 5 }) };
  runInNewContext(functionCode('src/lib/image-studio/tasks.ts', ['submitStudioBatch']), submit);
  const request: any = { requestId: 'original-shared-request', prompt: '描述', count: 1, revision: 1, referenceIds: ['shared-asset'], model: 'gemini', quality: 'auto', maxEstimatedCost: 5,
    draft: { referencePolicy: canvasImageReferencePolicy(['shared-asset']) } };
  const canvasUse = { user: { id: 'user' }, referenceImageIds: ['shared-ref'] };
  const batch = await submit.submitStudioBatch('user', request, undefined, undefined, canvasUse);
  assert.equal(queued.length, 1); assert.equal(ledger.length, 1); assert.equal(queued[0].quality, 'auto');
  assert.deepEqual(JSON.parse(queued[0].reference_ids), ['shared-asset']);
  const snapshot = JSON.parse(queued[0].snapshot_json);
  assert.equal(snapshot.authorizedReferenceOwners['shared-asset'], 'other-owner'); assert.equal(snapshot.requestId, request.requestId);
  assert.equal(snapshot.referenceImages[0].originalUrl, null); assert.equal(snapshot.referenceImages[0].thumbnailUrl, null);
  assert.ok(assetReads[0].where.OR.some((clause: any) => clause.id === 'shared-asset' && clause.owner_id === 'other-owner'));
  assert.equal(await submit.submitStudioBatch('user', request, undefined, undefined, canvasUse), batch);
  assert.equal(queued.length, 1); assert.equal(ledger.length, 1);
  await assert.rejects(submit.submitStudioBatch('user', { ...request, prompt: 'changed' }, undefined, undefined, canvasUse), /其他请求/);
  submit.resolveCanvasStudioReferenceUse = async () => { throw new FixtureAuthError('revoked use', 403); };
  await assert.rejects(submit.submitStudioBatch('user', { ...request, requestId: 'new-request' }, undefined, undefined, canvasUse), /revoked use/);
  assert.equal(queued.length, 1); assert.equal(ledger.length, 1);
  checks.push('R4: actual existing batch submit queues shared original ID/owner/quality, no copy/original URL grant; original-request dedupe prevents second queue/freeze; changed/revoked use rejected');

  for (const status of ['queued', 'uncertain', 'failed']) {
    const results: any = { exports: {}, AuthError: FixtureAuthError, requireCanvasStyleUser: async () => ({ id: 'user' }),
      readCanvasStyleJson: async () => ({ moduleId: 'module', requestId: 'fixture-request-00000', count: 1 }),
      parseCanvasStyleContext: () => ({}), assertCanvasStyleContext: async () => {}, validStudioModuleId: () => true, REQUEST_ID_PATTERN: /^[a-zA-Z0-9-]{16,80}$/, canvasStyleBatchId: () => 'batch',
      prisma: { imageStudioModule: { findFirst: async () => ({ id: 'module' }) }, imageStudioTask: { findMany: async () => [{ id: 'task', status, asset_id: null }] } },
      canvasStyleJson: (value: any) => value, canvasStyleFailure: (error: any) => { throw error; } };
    runInNewContext(functionCode('src/app/api/tools/ultimate-canvas/styles/results/route.ts', ['POST']), results);
    const result = await results.POST({}); assert.equal(result.pending, status !== 'failed'); assert.equal(result.submission_unconfirmed, status === 'uncertain');
    assert.equal(result.status, status === 'uncertain' ? 'unconfirmed' : status);
  }
  checks.push('R4: actual results API keeps uncertain/refunded tasks pending-unknown instead of unlocking new generation');
}

async function main() {
  const materials = parseStoryMaterials(JSON.stringify({ materials: [{ id: 'coat', kind: 'character', name: '女子', description: '黄色雨衣', shotIds: ['shot-1'] }] }));
  assert.throws(() => parseStoryMaterials('{"materials":[{"id":"bad","kind":"command"}]}'));
  assert.throws(() => parseStoryMaterials(JSON.stringify({ materials: [...materials, ...materials] })));
  const composed = composeStoryShot({ ...shot, materialIds: ['coat'], framing: '中景', lighting: '柔光', camera: '跟随' }, materials);
  assert.match(composed.materialPrompt!, /黄色雨衣/); assert.ok(!composed.imagePrompt.includes('景别'));
  const readyShot = { ...shot, framing: '中景', lighting: '柔光', camera: '跟随', ...composed };
  assert.match(storyGenerationPrompt(readyShot, 'video'), /运镜：跟随/);
  const changed = { ...readyShot, framing: '远景', lighting: '', camera: '' };
  assert.ok(!storyGenerationPrompt(changed, 'video').includes('中景'));
  assert.ok(!storyGenerationPrompt(changed, 'video').includes('柔光'));
  assert.ok(!storyGenerationPrompt(changed, 'video').includes('运镜'));
  const edited = composeStoryShot({ ...shot, imagePrompt: '手写保留雨丝细节', videoPrompt: '手写缓慢离开', framing: '中景' }, materials);
  assert.equal(edited.imagePrompt, '手写保留雨丝细节'); assert.equal(edited.videoPrompt, '手写缓慢离开');
  const legacy = { ...shot, materialIds: ['coat'], framing: '中景', lighting: '柔光', camera: '跟随',
    imagePrompt: `${shot.description}\n角色：女子；黄色雨衣\n景别：中景；光线：柔光\n手写追加`,
    videoPrompt: `${shot.description}\n角色：女子；黄色雨衣\n景别：中景；光线：柔光\n运镜：跟随` };
  const separated = separateStoryPrompt(legacy, materials);
  assert.equal(separated.imagePrompt, `${shot.description}\n手写追加`);
  assert.ok(!storyGenerationPrompt({ ...separated, framing: '', lighting: '', camera: '' }, 'video').includes('运镜'));
  assert.equal(storyGenerationPrompt(shot, 'image'), shot.description);
  assert.match(storyGenerationPrompt({ ...shot, framing: '中景', camera: '跟随' }, 'video'), /景别：中景\n运镜：跟随/);
  assert.deepEqual(validateStoryDraft({ version: 1, story: '', script: '', shots: [shot], sourceRevision: 0 }).shots[0], shot);
  checks.push('S14/U16: strict materials, bindings, optional controls, description-only and legacy v1');
  const refs = ['main', 'character', 'scene', 'prop'];
  const policy = canvasImageReferencePolicy(refs);
  assert.deepEqual(policy.primaryIds, ['main']); assert.equal(policy.primaryMax, 1);
  assert.equal(canvasImageReferencePolicy(refs, []).primaryIds.length, 0);
  assert.throws(() => canvasImageReferencePolicy(refs, ['main', 'character']));
  assert.throws(() => canvasImageReferencePolicy(Array.from({ length: 11 }, (_, i) => `asset-${i}`)));
  checks.push('C17/S14: explicit primary1/auxiliary references, materials without primary, limit10 rejection');

  const workflow: any = { module: { exports: {} } }; runInNewContext(source('public/tools/ultimate-canvas/generation-node-workflow.js'), workflow);
  const api = workflow.module.exports;
  const model = SEEDANCE_2_5_IP_MODEL_ID;
  const options = volcengineIpCapabilities().map(item => ({ ...item, value: item.id, provider: 'volcengine_ip', ready: true }));
  const capabilities = { model_options: options, interaction: { duration_by_model: Object.fromEntries(options.map(item => [item.id, item.durations])) } };
  const payload = { projectId: 'project', cardId: 'card', documentId: 'document', nodeId: 'node', requestId: 'request', prompt: '描述', mode: 'text-to-video', referenceImageIds: [], settings: { model, provider: 'volcengine_ip', resolution: '720p', duration: 30, ratio: '16:9', maxEstimatedCost: 135 }, capabilities };
  assert.equal(api.validateVideo(payload).valid, true);
  assert.equal(api.videoRequest(payload).url, '/api/ip/tasks/create');
  assert.equal(api.videoRequest(payload).payload.max_estimated_cost, 135);
  assert.equal(api.validateVideo({ ...payload, settings: { ...payload.settings, provider: 'seedance' } }).valid, false);
  const fast = options.find(item => item.id.includes('-fast-'))!;
  assert.equal(api.validateVideo({ ...payload, settings: { ...payload.settings, model: fast.id, resolution: '1080p', duration: 5 } }).valid, false);
  assert.equal(seedanceVideoDurationOptions(model).at(-1), 30);
  const references = Array.from({ length: 30 }, (_, index) => `reference-${index}`);
  assert.equal(api.validateVideo({ ...payload, referenceImageIds: references }).valid, true);
  assert.equal(api.videoRequest({ ...payload, referenceImageIds: references, settings: { ...payload.settings, referenceImageLimit: 30 } }).payload.reference_image_ids.length, 30);
  checks.push('M13: IP identity/provider, official route, duration30, Fast1080 rejection and cap');

  for (const scenario of ['cancel', 'save-failure', 'success', 'free', 'restored', 'unknown', 'shared', 'shared-pending', 'shared-disconnect', 'shared-uncertain', 'shared-no-asset', 'unquoted-seedream']) {
    const context = { userId: 'owner', projectId: 'project', cardId: 'card', documentId: 'document', writable: true };
    const input: any = { nodeId: 'node', prompt: '描述', settings: { model: scenario === 'unquoted-seedream' ? 'seedream' : 'gemini-3.1-flash-image-preview', quality: 'auto', resolution: '2K', ratio: '16:9', count: 1 }, referenceImageIds: scenario.startsWith('shared') ? ['shared-ref'] : [] };
    const job = { kind: 'ordinary', context, requestId: 'existing-request', moduleId: 'existing-module', batchId: 'existing-batch', count: 1, payload: input };
    const node: any = { id: 'node', type: 'image', data: scenario === 'restored' || scenario === 'unknown' ? { styleJob: job } : {} };
    const calls: string[] = []; let saved = false, resultReads = 0;
    const vm: any = { window: { setTimeout: (callback: () => void) => { if (scenario === 'shared-pending') callback(); else throw Error('unexpected wait'); } }, document: { hidden: false }, structuredClone, AbortSignal,
      crypto: { randomUUID: () => 'fixture-request-0000000' }, URLSearchParams };
    runInNewContext(source('public/tools/ultimate-canvas/canvas-styles.js'), vm);
    const styles = vm.window.UltimateCanvasStyles.create({ getNode: () => node, context: () => context,
      save: () => {}, render: () => {}, status: () => {}, apply: () => {}, notice: () => {},
      confirm: async () => scenario !== 'cancel', flush: async () => { saved = true; return scenario !== 'save-failure'; },
      request: async (url: string, body: any) => {
        calls.push(url);
        if (url.endsWith('/quote')) return scenario === 'unquoted-seedream' ? { status: 'unavailable', estimatedCredits: null } : { status: 'estimate', estimatedCredits: scenario === 'free' ? 0 : 5, revision: 1 };
        if (url.includes('/images/generate?')) return { durable: scenario !== 'shared-no-asset' };
        if (url.endsWith('/images/generate')) {
          assert.ok(saved); assert.ok(node.data.styleJob); assert.equal(body.payload.settings.quality, 'auto');
          if (scenario === 'shared-disconnect') throw Error('connection reset after POST');
          return { batchId: 'batch' };
        }
        if (url.endsWith('/results')) return scenario === 'shared-pending' && resultReads++ === 0 ? { status: 'queued', pending: true, completedCount: 0, totalCount: 1 }
          : scenario === 'unknown' ? { status: 'not_found' }
          : scenario === 'shared-uncertain' ? { status: 'unconfirmed', pending: true, submission_unconfirmed: true }
          : { pending: false, status: 'succeeded', assets: [{ id: 'original' }] };
        throw Error(`unexpected endpoint ${url}`);
      } });
    if (['cancel', 'save-failure', 'unknown', 'shared-disconnect', 'shared-uncertain', 'shared-no-asset', 'unquoted-seedream'].includes(scenario)) await assert.rejects(styles.generateOrdinary(input, input.prompt));
    else {
      const result = await styles.generateOrdinary(input, input.prompt);
      if (scenario === 'shared') {
        assert.equal(result.legacyRequired, undefined);
        assert.equal(result.assets.length, 1);
        const descriptor = api.imageRequest(input);
        assert.equal(descriptor.payload.input.quality, input.settings.quality);
        assert.equal(descriptor.payload.input.resolution, input.settings.resolution);
      }
    }
    assert.equal(calls.filter(url => url.endsWith('/images/generate')).length, ['success', 'free', 'shared', 'shared-pending', 'shared-disconnect', 'shared-uncertain'].includes(scenario) ? 1 : 0);
    if (scenario === 'restored') assert.deepEqual(calls, ['/api/tools/ultimate-canvas/styles/results']);
    if (scenario === 'unknown') assert.equal(node.data.styleJob.requestId, 'existing-request');
    if (['shared-disconnect', 'shared-uncertain'].includes(scenario)) {
      const persisted = JSON.parse(JSON.stringify(node.data.styleJob));
      assert.equal(persisted.state, 'unconfirmed');
      node.data.styleJob = persisted;
      const before = calls.length;
      if (scenario === 'shared-uncertain') await assert.rejects(styles.generateOrdinary(input, input.prompt));
      else await styles.generateOrdinary(input, input.prompt);
      assert.deepEqual(calls.slice(before), ['/api/tools/ultimate-canvas/styles/results']);
    }
  }
  checks.push('C17: cancel/save barrier/one POST/restored zero POST/unknown original preserved');

  for (const scenario of ['cancel', 'success', 'partial-unknown', 'resume', 'legacy-success', 'legacy-pending', 'legacy-unknown', 'legacy-failed', 'unsent-save', 'rejected', 'unbound-inventory']) {
    const current: any = { current: { draft: { shots: [shot, { ...shot, id: 'shot-2', title: '镜头2' }] }, images: {}, references: {}, imageRuns: scenario === 'resume' ? { 'shot-1': { requestId: 'original', status: 'succeeded' } } : {} } };
    const calls: string[] = [], persisted: string[] = [];
    if (scenario.startsWith('legacy-')) current.current.images['shot-1'] = { moduleId: 'legacy-module', state: scenario === 'legacy-unknown' ? 'unconfirmed' : 'ready' };
    if (scenario === 'unbound-inventory') current.current.materials = [{ id: 'unused', name: '', kind: 'character', description: '', shotIds: [] }];
    const c: any = { current, mediaSettings: { imageModel: 'model', quality: 'auto', resolution: '2K', ratio: '16:9' }, documentRef: { current: { project_id: 'project' } }, snapshot: { current: { canvas: { nodes: [] } } },
      exports: {}, storyGenerationPrompt, materialShot: (item: any) => ({ ...shot, id: `material:${item.id}` }), IMAGE_STUDIO_MODEL_QUALITY_OPTIONS: { model: ['auto'] }, imageResolutionOptions: () => ['2K'], boundReferences: () => [], materialSignature: () => '',
      canvasImageReferencePolicy, URLSearchParams, Set,
      crypto: { randomUUID: () => `fixture-${persisted.length}` }, setNotice: () => {}, change: (value: any) => { current.current = value; },
      assertCurrentContext: () => {}, confirm: async () => scenario !== 'cancel', save: async () => {
        persisted.push(JSON.stringify(current.current.imageRuns));
        if (scenario === 'unsent-save' && Object.values(current.current.imageRuns || {}).some((run: any) => run.status === 'unconfirmed')) throw Error('save failed');
      },
      imageDraft: async (value: StoryShot) => { current.current.images[value.id] = { moduleId: value.id }; },
      request: async (url: string, body: any) => {
        calls.push(url);
        if (url.includes('moduleId=legacy-module')) return { tasks: scenario === 'legacy-unknown' ? [] : [{ id: 'old-task', status: scenario === 'legacy-success' ? 'succeeded' : scenario === 'legacy-pending' ? 'running' : 'failed' }] };
        if (url.endsWith('/quote')) return { status: 'estimate', estimatedCredits: 5, revision: 1 };
        assert.equal(url, '/api/image-studio/tasks'); assert.ok(persisted.at(-1)?.includes(body.requestId)); assert.equal(body.maxEstimatedCost, 5);
        if (scenario === 'partial-unknown') throw Error('network unknown');
        if (scenario === 'rejected') throw Object.assign(Error('invalid parameters'), { status: 400, response: { error: 'invalid' } });
        return { batchId: 'batch' };
      } };
    runInNewContext(functionCode('src/app/story-studio/story-studio.tsx', ['dispatchShots', 'guardOriginalImages', 'mediaFailureState', 'videoReceptionStatus']), c);
    if (['partial-unknown', 'unsent-save', 'rejected'].includes(scenario)) await assert.rejects(c.dispatchShots('image', ['shot-1', 'shot-2']));
    else await c.dispatchShots('image', ['shot-1', 'shot-2']);
    assert.equal(calls.filter(url => url === '/api/image-studio/tasks').length, ['cancel', 'unsent-save'].includes(scenario) ? 0 : ['success', 'legacy-failed', 'unbound-inventory'].includes(scenario) ? 2 : 1);
    if (scenario.startsWith('legacy-') && scenario !== 'legacy-failed') assert.equal(calls.filter(url => url.endsWith('/quote')).length, 1);
    if (scenario === 'resume') assert.equal(current.current.imageRuns['shot-1'].requestId, 'original');
    if (scenario === 'partial-unknown') assert.equal(current.current.imageRuns['shot-1'].status, 'unconfirmed');
    if (scenario === 'unsent-save') assert.equal(current.current.imageRuns['shot-1'].status, 'not_sent');
    if (scenario === 'rejected') assert.equal(current.current.imageRuns['shot-1'].status, 'rejected');
  }
  const c: any = { exports: {}, current: { current: { draft: { shots: [shot] }, groups: [] } }, crypto: { randomUUID: () => 'group' }, setNotice: () => {}, save: async () => {}, change: (value: any) => { c.current.current = value; } };
  runInNewContext(functionCode('src/app/story-studio/story-studio.tsx', ['createGroup']), c); await c.createGroup(); assert.equal(c.current.current.groups.length, 1);
  checks.push('B15: build group has no create API; cancel zero create, confirmed count, stop unknown and skip successful');
  for (const scenario of ['unsent-save', 'unsent-context', 'rejected', 'unknown', 'unknown-with-id', 'ip-error-code', 'local-failed-refund', 'accepted-id', 'free', 'missing-receipt']) {
    const current: any = { current: { draft: { shots: [shot] }, images: {}, references: {}, mediaNodes: { 'shot-1': 'video' } } };
    const node: any = { id: 'video', data: {} }, calls: string[] = [];
    const c: any = { exports: {}, current, mediaSettings: { videoModel: 'video-model', provider: 'seedance', videoResolution: '720p', ratio: '16:9' },
      mediaCapabilities: { video: { model_options: [{ value: 'video-model', provider: 'seedance', ready: true, resolutions: ['720p'] }] } },
      snapshot: { current: { canvas: { nodes: [node] } } }, documentId: 'doc', userId: 'user', documentRef: { current: { project_id: 'project' } },
      materialShot: () => shot, storyGenerationPrompt, boundReferences: () => [], materialSignature: () => '', canvasImageReferencePolicy,
      crypto: { randomUUID: () => 'original-request' }, URLSearchParams, change: (value: any) => { current.current = value; }, setNotice: () => {},
      confirm: async () => true, mediaNode: async () => {},
      assertCurrentContext: () => { if (scenario === 'unsent-context') throw Error('context switched'); },
      save: async (_: unknown, transform: any) => {
        if (scenario === 'unsent-save' && current.current.videoRuns?.['shot-1']?.status === 'unconfirmed') throw Error('save failed');
        transform?.({ canvas: { nodes: [node] } });
      }, request: async (url: string) => {
        calls.push(url);
        if (url.includes('/estimate?')) return { estimatedCost: scenario === 'free' ? 0 : 15 };
        if (scenario === 'rejected') throw Object.assign(Error('rejected'), { status: 422, response: { error: 'invalid' } });
        if (scenario === 'unknown') throw Error('network lost');
        if (scenario === 'unknown-with-id') return { id: 'task', submission_unconfirmed: true, status: 'submitted' };
        if (scenario === 'ip-error-code') return { id: 'task', error_code: 'IP_SUBMISSION_UNCONFIRMED', local_status: 'submitted', provider_task_id: null };
        if (scenario === 'local-failed-refund') return { id: 'task', local_status: 'failed', provider_task_id: null, refunded_cost: 15, provider_cost_status: 'failed_no_charge' };
        if (scenario === 'missing-receipt') return {};
        return { id: 'task', status: 'submitted', provider_task_id: 'upstream-task' };
      } };
    runInNewContext(functionCode('src/app/story-studio/story-studio.tsx', ['dispatchShots', 'mediaFailureState', 'videoReceptionStatus']), c);
    if (['accepted-id', 'free'].includes(scenario)) await c.dispatchShots('video', ['shot-1']);
    else await assert.rejects(c.dispatchShots('video', ['shot-1']));
    assert.equal(calls.filter(url => url === '/api/tasks/create').length, scenario.startsWith('unsent-') ? 0 : 1);
    const expected = scenario.startsWith('unsent-') ? 'not_sent' : scenario === 'rejected' ? 'rejected' : ['accepted-id', 'free'].includes(scenario) ? 'submitted' : 'unconfirmed';
    assert.equal(current.current.videoRuns['shot-1'].status, expected);
    if (scenario !== 'unsent-save') assert.equal(node.data.videoSubmission.state, ['accepted-id', 'free'].includes(scenario) ? 'accepted' : expected);
  }
  const failure: any = { exports: {} }; runInNewContext(functionCode('src/app/story-studio/story-studio.tsx', ['mediaFailureState']), failure);
  assert.equal(failure.mediaFailureState({ status: 409, response: { existing_task_id: 'existing' } }, true), 'unconfirmed');
  assert.equal(failure.mediaFailureState({ status: 400, response: { task_id: 'failed-but-reception-unknown' } }, true), 'unconfirmed');
  assert.equal(failure.mediaFailureState({ status: 408 }, true), 'unconfirmed');
  assert.equal(failure.mediaFailureState({ status: 400, response: { error_code: 'IP_SUBMISSION_UNCONFIRMED' } }, true), 'unconfirmed');
  checks.push('B15 recovery: image/video definitely-unsent, rejection, unknown, original task-bearing error, normal id receipt and unconfirmed202 stop');
  const unknownWork: any = { current: { imageRuns: { 'shot-1': { requestId: 'original-image', status: 'unconfirmed', input: {} } },
    videoRuns: { 'shot-1': { requestId: 'original-video', status: 'unconfirmed', provider: 'seedance' } }, mediaNodes: { 'shot-1': 'video' } } };
  const lookupCalls: string[] = [];
  const lookup: any = { exports: {}, current: unknownWork, documentId: 'doc', URLSearchParams,
    snapshot: { current: { canvas: { nodes: [{ id: 'video', data: {} }] } } },
    change: () => { throw Error('empty lookup must not clear/change unknown'); }, save: async () => {}, setNotice: () => {},
    request: async (url: string) => { lookupCalls.push(url); return url.includes('/image-studio/') ? { tasks: [] } : { state: 'unconfirmed', task: null }; } };
  runInNewContext(functionCode('src/app/story-studio/story-studio.tsx', ['queryRuns', 'videoReceptionStatus']), lookup);
  await lookup.queryRuns(); assert.equal(lookupCalls.length, 2);
  assert.ok(lookupCalls[0].includes('original-image')); assert.ok(lookupCalls[1].includes('original-video'));
  assert.equal(unknownWork.current.videoRuns['shot-1'].status, 'unconfirmed');
  for (const hasTaskId of [false, true]) {
    const work: any = { current: { draft: { shots: [shot] }, imageRuns: {}, videoRuns: { 'shot-1': { requestId: 'original', taskId: hasTaskId ? 'local-task' : undefined, status: 'unconfirmed', provider: 'seedance' } }, mediaNodes: { 'shot-1': 'video' } } };
    const graph: any = { canvas: { nodes: [{ id: 'video', data: { videoSubmission: { requestId: 'original', state: 'unconfirmed' } } }] } };
    const failed: any = { exports: {}, current: work, documentId: 'doc', URLSearchParams, snapshot: { current: graph },
      change: (value: any) => { work.current = value; }, save: async (_: unknown, transform: any) => transform?.(graph), setNotice: () => {},
      request: async () => ({ state: 'unconfirmed', task: { id: 'local-task', local_status: 'failed', provider_task_id: null, refund: 15, provider_cost_status: 'failed_no_charge' } }) };
    runInNewContext(functionCode('src/app/story-studio/story-studio.tsx', ['queryRuns', 'videoReceptionStatus']), failed);
    await failed.queryRuns(); assert.equal(work.current.videoRuns['shot-1'].status, 'unconfirmed');
    assert.equal(graph.canvas.nodes[0].data.videoSubmission.state, 'unconfirmed');
    await assert.rejects(failed.queryRuns().then(() => {
      runInNewContext(functionCode('src/app/story-studio/story-studio.tsx', ['dispatchShots', 'videoReceptionStatus']), failed);
      return failed.dispatchShots('video', ['shot-1']);
    }), /没有需要派发/);
    work.current.videoRuns['shot-1'].status = 'failed';
    await assert.rejects(failed.dispatchShots('video', ['shot-1']), /没有需要派发/);
  }
  checks.push('V18/B15: failed/refund15/failed_no_charge with null upstream task stays unknown on original lookup; configured zero quote allowed');

  for (const bound of [false, true]) {
    const item: any = { id: 'coat', name: '女子', kind: 'character', description: '雨衣', shotIds: ['shot-1'] };
    const current: any = { current: { draft: { shots: [{ ...shot, materialIds: bound ? ['coat'] : [] }] }, materials: [item], materialReferences: {}, versions: [] } };
    const c: any = { exports: {}, current, parseStoryMaterials, composeStoryShot, materialSignature: () => 'confirmed', archived: (v: any) => v,
      change: (v: any) => { current.current = v; }, confirm: async () => true, save: async () => {}, setNotice: () => {} };
    runInNewContext(functionCode('src/app/story-studio/story-studio.tsx', ['confirmMaterials']), c);
    if (bound) await assert.rejects(c.confirmMaterials());
    else await c.confirmMaterials();
  }
  const countVm: any = { exports: {}, MAX_REFERENCE_IMAGES: 10, StudioReferencePolicyError: Error };
  runInNewContext(functionCode('src/lib/image-studio/reference-policy.ts', ['validateStudioReferenceCounts', 'orderedUnique']), countVm);
  countVm.validateStudioReferenceCounts(policy, refs, 0, 0, true);
  assert.throws(() => countVm.validateStudioReferenceCounts({ ...policy, primaryIds: refs }, refs, 0, 0, true));
  const body: any = { projectId: 'project', documentId: 'doc', nodeId: 'node', moduleId: 'module', requestId: 'fixture-request-00000',
    settings: { model: 'gemini', quality: 'auto', resolution: '2K', ratio: '16:9', count: 1 }, referenceImageIds: refs,
    settingsRevision: 1, maxEstimatedCost: 5, prompt: '描述' };
  let submitted: any;
  const routeVm: any = { exports: {}, AuthError: Error, requireCanvasStyleUser: async () => ({ id: 'user', role: 'admin' }),
    parseCanvasPromptMentions, assertCanvasPromptCompatibility: async (_: unknown, __: unknown, ___: unknown, ____: unknown, mentions: unknown) => { assert.equal(mentions, undefined); },
    readCanvasStyleJson: async () => body, parseCanvasStyleContext: (v: any) => v, assertCanvasStyleContext: async () => {}, validStudioModuleId: () => true,
    prisma: { canvasDocument: { findUniqueOrThrow: async () => ({ document_json: JSON.stringify({ canvas: { nodes: [{ id: 'node', type: 'image', data: { styleJob: { kind: 'ordinary', requestId: body.requestId, moduleId: body.moduleId, input: body } } }] } }) }) },
      imageStudioModule: { findFirst: async () => null } },
    getCanvasImageQuote: async () => ({ status: 'estimate', revision: 1, estimatedCredits: 5 }),
    resolveCanvasStudioReferenceUse: async (_: unknown, ids: string[]) => new Map(ids.map(id => [id, 'user'])),
    canvasImageReferencePolicy, validateStudioReferenceCounts: countVm.validateStudioReferenceCounts,
    saveStudioModule: async () => {}, submitStudioBatch: async (_: unknown, v: any) => { submitted = v; return 'batch'; },
    canvasStyleJson: (v: any) => v, canvasStyleFailure: (e: unknown) => { throw e; } };
  runInNewContext(functionCode('src/app/api/tools/ultimate-canvas/images/generate/route.ts', ['POST']), routeVm);
  assert.equal((await routeVm.POST({})).batchId, 'batch');
  assert.equal(submitted.draft.referencePolicy.primaryIds.length, 1); assert.equal(submitted.referenceIds.length, 4);
  assert.equal(submitted.draft.referencePolicy.useFixedReferences, false);
  checks.push('S14/C17: unbound inventory no required image; bound missing image rejects; real count validator and canvas POST forwards role contract');

  let adapter: any, legacyCreates = 0, quotes = 0;
  const adapterVm: any = { window: { CanvasGenerationAPI: { setAdapter: (v: any) => { adapter = v; } } },
    canvasRuntime: { bootstrap: { capabilities: { image: { model_options: [{ value: 'seedream' }] } } } },
    engine: { nodes: new Map([['node', { data: {} }]]) }, promptWithConnectedText: (v: any) => v.prompt,
    collectReferenceImageIds: () => [], canvasStyles: { generateOrdinary: async () => { quotes++; throw Error('unavailable quote'); } },
    requestJson: async () => { legacyCreates++; }, exports: {} };
  runInNewContext(functionCode('public/tools/ultimate-canvas/app.js', ['installGenerationAdapter']), adapterVm);
  adapterVm.installGenerationAdapter(); await assert.rejects(adapter.generate({ kind: 'image', nodeId: 'node', prompt: '描述', settings: { model: 'seedream' } }));
  assert.equal(quotes, 1); assert.equal(legacyCreates, 0);
  checks.push('M13/C17: adapter quotes models with no quality_options; unavailable quote prevents legacy assets POST');
  await verifyReviewCorrections(api);
  console.log(JSON.stringify({ pass: true, checks, scope: 'offline mocks only; no browser/DB/provider/fees' }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
