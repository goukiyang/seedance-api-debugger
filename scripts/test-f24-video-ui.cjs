const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
function ast(file) { return ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); }
function find(source, predicate) { const items = []; const visit = node => { if (predicate(node)) items.push(node); ts.forEachChild(node, visit); }; visit(source); assert.equal(items.length, 1); return items[0]; }
function evaluate(text, context) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule('module.exports = ' + text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { ...context, module });
  return module.exports;
}
test('actual submit assembly carries only an explicit standard-page choice and preserves quoted generation inputs', () => {
  const source = ast('src/components/generate/GeneratePageClient.tsx');
  const submit = find(source, node => ts.isVariableDeclaration(node) && node.name.getText(source) === 'handleSubmit');
  const body = find(submit, node => ts.isVariableDeclaration(node) && node.name.getText(source) === 'requestBody');
  const params = { prompt: 'synthetic', generationMode: 'all_in_one_reference', ratio: '16:9', duration: 5, resolution: '720p', seed: 0,
    generateAudio: true, returnLastFrame: false, watermark: false, resolutionApprovalConfirmed: false, templateStudioAssets: [],
    pricingRevision: 'synthetic-price', pricingQuoteToken: 'synthetic-quote', quotedEstimatedCost: 5, referenceImageIds: ['synthetic-reference'],
    referenceVideoUrls: ['https://synthetic.invalid/video'], referenceAudioUrls: ['https://synthetic.invalid/audio'] };
  const context = { params, isIpSurface: false, videoFeishu: { choice: { version: 1, enabled: true, preferenceRevision: 6 } }, readyVideoCard: { id: 'card' },
    selectedProjectId: 'project', selectedVideoBranchId: 'branch', creationBaselineId: null, selectedH3Model: false,
    requestedH3LoraId: null, requestedProvider: 'seedance', requestedModel: 'seedance-2.0', SEEDANCE_2_5_MODEL_ID: 'seedance-2.5',
    URLSearchParams, window: { location: { search: '' } } };
  const read = () => JSON.parse(JSON.stringify(evaluate('(' + body.initializer.getText(source) + ')', context)));
  const enabled = read(); assert.deepEqual(enabled.video_feishu, context.videoFeishu.choice);
  assert.equal(enabled.pricing_quote_token, params.pricingQuoteToken); assert.equal(enabled.max_estimated_cost, 5);
  assert.deepEqual(enabled.reference_image_ids, params.referenceImageIds); assert.deepEqual(enabled.reference_video_urls, params.referenceVideoUrls);
  context.videoFeishu.choice = undefined;
  const off = read(); assert.equal(off.video_feishu, undefined); delete enabled.video_feishu; assert.deepEqual(enabled, off);
  context.isIpSurface = true; context.videoFeishu.choice = { version: 1, enabled: true, preferenceRevision: 6 };
  assert.equal(read().video_feishu, undefined);
});
test('actual preference save removes new-submit consent before an uncertain opt-out and retains the desired choice', async () => {
  const source = ast('src/lib/hooks/use-video-feishu.ts');
  const change = find(source, node => ts.isFunctionDeclaration(node) && node.name?.text === 'change');
  let desired, error, busy;
  const body = [], desiredRef = { current: null };
  const work = evaluate('(' + change.getText(source) + ')', { scope: 'synthetic-owner', saved: { owner: 'synthetic-owner', value: { version: 1, enabled: true, revision: 6, available: true } },
    valid: () => true, lock: { current: false }, sequence: { current: 0 }, desiredRef,
    setDesired: value => { desired = value; }, setError: value => { error = value; }, setBusy: value => { busy = value; }, setSaved: () => {},
    AbortSignal, fetch: async (_url, init) => { assert.equal(desiredRef.current, false); body.push(JSON.parse(init.body)); throw new Error('synthetic unknown'); } });
  await work(false); assert.equal(desired, false); assert.equal(desiredRef.current, false); assert.equal(busy, false); assert.ok(error);
  assert.deepEqual(body, [{ version: 1, enabled: false, revision: 6 }]);
});
