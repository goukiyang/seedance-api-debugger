import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { parseStoryMaterials, validateStoryDraft, composeStoryShot, storyGenerationPrompt, type StoryShot } from '../src/lib/story-workflow';
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
  assert.match(composed.imagePrompt, /黄色雨衣/); assert.ok(!composed.imagePrompt.includes('运镜'));
  assert.match(composed.videoPrompt, /运镜：跟随/);
  assert.equal(storyGenerationPrompt(shot, 'image'), shot.description);
  assert.match(storyGenerationPrompt({ ...shot, framing: '中景', camera: '跟随' }, 'video'), /景别：中景\n运镜：跟随/);
  assert.deepEqual(validateStoryDraft({ version: 1, story: '', script: '', shots: [shot], sourceRevision: 0 }).shots[0], shot);
  checks.push('S14/U16: strict materials, bindings, optional controls, description-only and legacy v1');

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

  for (const scenario of ['cancel', 'save-failure', 'success', 'restored', 'unknown']) {
    const context = { userId: 'owner', projectId: 'project', cardId: 'card', documentId: 'document', writable: true };
    const input: any = { nodeId: 'node', prompt: '描述', settings: { model: 'gemini-3.1-flash-image-preview', quality: 'auto', resolution: '2K', ratio: '16:9', count: 1 }, referenceImageIds: [] };
    const job = { kind: 'ordinary', context, requestId: 'existing-request', moduleId: 'existing-module', batchId: 'existing-batch', count: 1, payload: input };
    const node: any = { id: 'node', type: 'image', data: scenario === 'restored' || scenario === 'unknown' ? { styleJob: job } : {} };
    const calls: string[] = []; let saved = false;
    const vm: any = { window: { setTimeout: () => { throw Error('unexpected wait'); } }, document: { hidden: false }, structuredClone, AbortSignal,
      crypto: { randomUUID: () => 'fixture-request-0000000' }, URLSearchParams };
    runInNewContext(source('public/tools/ultimate-canvas/canvas-styles.js'), vm);
    const styles = vm.window.UltimateCanvasStyles.create({ getNode: () => node, context: () => context,
      save: () => {}, render: () => {}, status: () => {}, apply: () => {},
      confirm: async () => scenario !== 'cancel', flush: async () => { saved = true; return scenario !== 'save-failure'; },
      request: async (url: string) => {
        calls.push(url);
        if (url.endsWith('/quote')) return { status: 'estimate', estimatedCredits: 5, revision: 1 };
        if (url.endsWith('/images/generate')) { assert.ok(saved); assert.ok(node.data.styleJob); return { batchId: 'batch' }; }
        if (url.endsWith('/results')) return scenario === 'unknown' ? { status: 'not_found' } : { pending: false, status: 'succeeded', assets: [{ id: 'original' }] };
        throw Error(`unexpected endpoint ${url}`);
      } });
    if (['cancel', 'save-failure', 'unknown'].includes(scenario)) await assert.rejects(styles.generateOrdinary(input, input.prompt));
    else await styles.generateOrdinary(input, input.prompt);
    assert.equal(calls.filter(url => url.endsWith('/images/generate')).length, scenario === 'success' ? 1 : 0);
    if (scenario === 'restored') assert.deepEqual(calls, ['/api/tools/ultimate-canvas/styles/results']);
    if (scenario === 'unknown') assert.equal(node.data.styleJob.requestId, 'existing-request');
  }
  checks.push('C17: cancel/save barrier/one POST/restored zero POST/unknown original preserved');

  for (const scenario of ['cancel', 'success', 'partial-unknown', 'resume']) {
    const current: any = { current: { draft: { shots: [shot, { ...shot, id: 'shot-2', title: '镜头2' }] }, images: {}, references: {}, imageRuns: scenario === 'resume' ? { 'shot-1': { requestId: 'original', status: 'succeeded' } } : {} } };
    const calls: string[] = [], persisted: string[] = [];
    const c: any = { current, mediaSettings: { imageModel: 'model', quality: 'auto', resolution: '2K', ratio: '16:9' }, documentRef: { current: { project_id: 'project' } }, snapshot: { current: { canvas: { nodes: [] } } },
      exports: {}, storyGenerationPrompt, materialShot: () => shot, IMAGE_STUDIO_MODEL_QUALITY_OPTIONS: { model: ['auto'] }, imageResolutionOptions: () => ['2K'], boundReferences: () => [], materialSignature: () => '',
      crypto: { randomUUID: () => `fixture-${persisted.length}` }, setNotice: () => {}, change: (value: any) => { current.current = value; },
      assertCurrentContext: () => {}, confirm: async () => scenario !== 'cancel', save: async () => { persisted.push(JSON.stringify(current.current.imageRuns)); },
      imageDraft: async (value: StoryShot) => { current.current.images[value.id] = { moduleId: value.id }; },
      request: async (url: string, body: any) => {
        calls.push(url);
        if (url.endsWith('/quote')) return { status: 'estimate', estimatedCredits: 5, revision: 1 };
        assert.equal(url, '/api/image-studio/tasks'); assert.ok(persisted.at(-1)?.includes(body.requestId)); assert.equal(body.maxEstimatedCost, 5);
        if (scenario === 'partial-unknown') throw Error('network unknown');
        return { success: true };
      } };
    runInNewContext(functionCode('src/app/story-studio/story-studio.tsx', ['dispatchShots']), c);
    if (scenario === 'partial-unknown') await assert.rejects(c.dispatchShots('image', ['shot-1', 'shot-2']));
    else await c.dispatchShots('image', ['shot-1', 'shot-2']);
    assert.equal(calls.filter(url => url === '/api/image-studio/tasks').length, scenario === 'cancel' ? 0 : scenario === 'success' ? 2 : 1);
    if (scenario === 'resume') assert.equal(current.current.imageRuns['shot-1'].requestId, 'original');
    if (scenario === 'partial-unknown') assert.equal(current.current.imageRuns['shot-1'].status, 'unconfirmed');
  }
  const c: any = { exports: {}, current: { current: { draft: { shots: [shot] }, groups: [] } }, crypto: { randomUUID: () => 'group' }, setNotice: () => {}, save: async () => {}, change: (value: any) => { c.current.current = value; } };
  runInNewContext(functionCode('src/app/story-studio/story-studio.tsx', ['createGroup']), c); await c.createGroup(); assert.equal(c.current.current.groups.length, 1);
  checks.push('B15: build group has no create API; cancel zero create, confirmed count, stop unknown and skip successful');
  console.log(JSON.stringify({ pass: true, checks, scope: 'offline mocks only; no browser/DB/provider/fees' }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
