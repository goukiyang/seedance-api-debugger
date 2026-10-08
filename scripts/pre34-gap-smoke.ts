import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { parseStoryMaterials, validateStoryDraft, composeStoryShot, separateStoryPrompt, storyGenerationPrompt, type StoryShot } from '../src/lib/story-workflow';
import { canvasImageReferencePolicy } from '../src/lib/canvas-image-references';
import { seedanceVideoDurationOptions, SEEDANCE_2_5_IP_MODEL_ID } from '../src/lib/provider/seedance-models';
import { volcengineIpCapabilities } from '../src/lib/integrations/volcengine-ip-models';

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

  for (const scenario of ['cancel', 'save-failure', 'success', 'free', 'restored', 'unknown', 'shared', 'unquoted-seedream']) {
    const context = { userId: 'owner', projectId: 'project', cardId: 'card', documentId: 'document', writable: true };
    const input: any = { nodeId: 'node', prompt: '描述', settings: { model: scenario === 'unquoted-seedream' ? 'seedream' : 'gemini-3.1-flash-image-preview', quality: 'auto', resolution: '2K', ratio: '16:9', count: 1 }, referenceImageIds: scenario === 'shared' ? ['shared-ref'] : [] };
    const job = { kind: 'ordinary', context, requestId: 'existing-request', moduleId: 'existing-module', batchId: 'existing-batch', count: 1, payload: input };
    const node: any = { id: 'node', type: 'image', data: scenario === 'restored' || scenario === 'unknown' ? { styleJob: job } : {} };
    const calls: string[] = []; let saved = false;
    const vm: any = { window: { setTimeout: () => { throw Error('unexpected wait'); } }, document: { hidden: false }, structuredClone, AbortSignal,
      crypto: { randomUUID: () => 'fixture-request-0000000' }, URLSearchParams };
    runInNewContext(source('public/tools/ultimate-canvas/canvas-styles.js'), vm);
    const styles = vm.window.UltimateCanvasStyles.create({ getNode: () => node, context: () => context,
      save: () => {}, render: () => {}, status: () => {}, apply: () => {}, notice: () => {},
      confirm: async () => scenario !== 'cancel', flush: async () => { saved = true; return scenario !== 'save-failure'; },
      request: async (url: string) => {
        calls.push(url);
        if (url.endsWith('/quote')) return scenario === 'unquoted-seedream' ? { status: 'unavailable', estimatedCredits: null } : { status: 'estimate', estimatedCredits: scenario === 'free' ? 0 : 5, revision: 1 };
        if (url.includes('/images/generate?')) return { durable: false };
        if (url.endsWith('/images/generate')) { assert.ok(saved); assert.ok(node.data.styleJob); return { batchId: 'batch' }; }
        if (url.endsWith('/results')) return scenario === 'unknown' ? { status: 'not_found' } : { pending: false, status: 'succeeded', assets: [{ id: 'original' }] };
        throw Error(`unexpected endpoint ${url}`);
      } });
    if (['cancel', 'save-failure', 'unknown', 'unquoted-seedream'].includes(scenario)) await assert.rejects(styles.generateOrdinary(input, input.prompt));
    else {
      const result = await styles.generateOrdinary(input, input.prompt);
      if (scenario === 'shared') {
        assert.equal(result.legacyRequired, true);
        const descriptor = api.imageRequest(input);
        assert.equal(descriptor.payload.input.quality, input.settings.quality);
        assert.equal(descriptor.payload.input.resolution, input.settings.resolution);
      }
    }
    assert.equal(calls.filter(url => url.endsWith('/images/generate')).length, ['success', 'free'].includes(scenario) ? 1 : 0);
    if (scenario === 'restored') assert.deepEqual(calls, ['/api/tools/ultimate-canvas/styles/results']);
    if (scenario === 'unknown') assert.equal(node.data.styleJob.requestId, 'existing-request');
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
  for (const scenario of ['unsent-save', 'unsent-context', 'rejected', 'unknown', 'unknown-with-id', 'local-failed-refund', 'accepted-id', 'free', 'missing-receipt']) {
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
        if (scenario === 'local-failed-refund') return { id: 'task', local_status: 'failed', provider_task_id: null, refunded_cost: 15, provider_cost_status: 'failed_no_charge' };
        if (scenario === 'missing-receipt') return {};
        return { id: 'task', status: 'submitted' };
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
    readCanvasStyleJson: async () => body, parseCanvasStyleContext: (v: any) => v, assertCanvasStyleContext: async () => {}, validStudioModuleId: () => true,
    prisma: { canvasDocument: { findUniqueOrThrow: async () => ({ document_json: JSON.stringify({ canvas: { nodes: [{ id: 'node', type: 'image', data: { styleJob: { kind: 'ordinary', requestId: body.requestId, moduleId: body.moduleId, input: body } } }] } }) }) },
      imageStudioModule: { findFirst: async () => null } },
    getCanvasImageQuote: async () => ({ status: 'estimate', revision: 1, estimatedCredits: 5 }),
    assertCanUseReferenceImage: async (_: unknown, id: string) => ({ asset_id: id, asset: { owner_id: 'user', status: 'active' } }),
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
  console.log(JSON.stringify({ pass: true, checks, scope: 'offline mocks only; no browser/DB/provider/fees' }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
