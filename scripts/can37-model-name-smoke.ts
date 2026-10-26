import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { CANVAS_PRODUCT_NAME, CANVAS_SOURCE_LABELS, canvasSourceJsonMarkers, isCanvasSource } from '../src/lib/canvas-source';

const read = (path: string) => readFileSync(path, 'utf8');
function extract(path: string, names: string[]) {
  const ast = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
  const found = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) found.set(node.name.text, node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const name of names) assert.ok(found.has(name), `${path}:${name}`);
  return ts.transpileModule(Array.from(found.values()).join('\n').replace(/^export /gm, '')
    + names.map(name => `;this.${name}=${name}`).join(''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
const app = 'public/tools/ultimate-canvas/app.js';
const ordinary = { value: 'dreamina-seedance-2-0-260128', provider: 'seedance', ready: true };
const ip = { value: 'doubao-seedance-2-5-260628', provider: 'volcengine_ip', ready: true };
const node: any = { id: 'node', type: 'video', data: { prompt: '正文@图1', promptMentions: { version: 1, items: [] },
  planReferences: [{ referenceImageId: 'original' }], videoSettings: { model: ordinary.value, provider: ordinary.provider, duration: 5, ratio: '4:3', resolution: '1080p' } } };
const messages: string[] = [], saves: string[] = [];
const scope: any = { canvasRuntime: { documentWritable: true, bootstrap: { capabilities: { video: { model_options: [ordinary, ip,
  { value: 'not-ready', provider: 'seedance', ready: false }] } } }, videoEstimates: new Map([['node', { status: 'success', estimatedCost: 15 }]]) },
  hasCurrentGenerationSubmission: () => false, showCanvasNotice: (text: string) => messages.push(text),
  generationSettingsForNode: (n: any) => n.data.videoSettings, renderGenerationNodeControls: () => {},
  scheduleCanvasSave: (reason: string) => saves.push(reason) };
runInNewContext(extract(app, ['generationSettingsLockReason', 'applyGenerationSettingChoice']), scope);
const references = JSON.stringify(node.data.planReferences), mentions = JSON.stringify(node.data.promptMentions);
assert.equal(scope.applyGenerationSettingChoice(node, 'model', ip.value), true);
assert.equal(node.data.videoSettings.provider, 'volcengine_ip');
assert.equal(node.data.videoSettings.model, ip.value);
assert.equal(node.data.videoSettings.ratio, '4:3'); assert.equal(node.data.videoSettings.resolution, '1080p');
assert.equal(node.data.prompt, '正文@图1'); assert.equal(JSON.stringify(node.data.planReferences), references);
assert.equal(JSON.stringify(node.data.promptMentions), mentions); assert.equal(scope.canvasRuntime.videoEstimates.size, 0);
assert.deepEqual(saves, ['video_settings_change']);
for (const model of ['unknown-model', 'not-ready']) assert.equal(scope.applyGenerationSettingChoice(node, 'model', model), false);
for (const [flag, value] of [['documentWritable', false], ['contextSwitching', true], ['documentRestoring', true], ['saveConflict', true], ['failedSaveRequest', {}]] as const) {
  scope.canvasRuntime[flag] = value;
  assert.ok(scope.generationSettingsLockReason(node));
  assert.equal(scope.applyGenerationSettingChoice(node, 'model', ordinary.value), false);
  delete scope.canvasRuntime[flag]; scope.canvasRuntime.documentWritable = true;
}
for (const data of [{ videoSubmission: { state: 'unconfirmed' } }, { videoSubmissionLegacy: true }, { generationStatus: 'running' }]) {
  Object.assign(node.data, data); assert.ok(scope.generationSettingsLockReason(node));
  assert.equal(scope.applyGenerationSettingChoice(node, 'model', ordinary.value), false);
  delete node.data.videoSubmission; delete node.data.videoSubmissionLegacy; delete node.data.generationStatus;
}
scope.hasCurrentGenerationSubmission = () => true;
assert.equal(scope.applyGenerationSettingChoice(node, 'model', ordinary.value), false);
assert.equal(saves.length, 1); assert.equal(node.data.videoSettings.model, ip.value);
console.log('PASS A1 actual model choice retains originals/parameters, sets provider, invalidates quote, saves once; unknown/config/submit/context locks do not mutate or submit');

let focused = 0, appended = 0, anchorFocused = 0;
const element: any = { dataset: {}, style: {}, isConnected: true, setAttribute: () => {},
  querySelector: () => ({ focus: () => focused++ }), contains: (target: unknown) => target === element,
  remove: () => {}, getBoundingClientRect: () => ({ width: 200, height: 300 }) };
const anchor: any = { isConnected: true, hasAttribute: (name: string) => name === 'data-generation-model-trigger',
  setAttribute: () => {}, focus: () => anchorFocused++, getBoundingClientRect: () => ({ left: 20, top: 100, bottom: 132 }) };
const pop: any = { canvasRuntime: {}, engine: { nodes: new Map([['node', node]]) },
  generationSettingsLockReason: () => '', renderSpecPopover: () => 'model choices', window: { innerWidth: 1000, innerHeight: 800 },
  document: { activeElement: element, createElement: () => element, getElementById: () => null, body: { appendChild: () => appended++ } } };
runInNewContext(extract(app, ['openGenerationPopover', 'positionGenerationPopover', 'closeGenerationPopover']), pop);
pop.openGenerationPopover('node', 'spec', anchor);
assert.equal(pop.canvasRuntime.generationPopover.kind, 'spec'); assert.equal(focused, 1); assert.equal(appended, 1);
pop.closeGenerationPopover(); assert.equal(anchorFocused, 1);
pop.generationSettingsLockReason = () => '受理未知'; pop.showCanvasNotice = (text: string) => messages.push(text);
pop.openGenerationPopover('node', 'spec', anchor); assert.equal(appended, 1);
const rendered: any = { module: { exports: {} }, window: { UltimateCanvasIcons: (name: string) => `<svg data-icon="${name}"></svg>` } };
runInNewContext(read('public/tools/ultimate-canvas/canvas-engine.js'), rendered);
const markup = rendered.module.exports.CanvasEngine.prototype._propsPanel.call({}, 'video', 'node');
assert.match(markup, /<button[^>]+data-generation-model-trigger/);
assert.match(markup, /data-generation-popover="spec"/); assert.match(markup, /data-generation-model-label/);
assert.ok(!read(app).includes('.video-model-info span:nth-child(2)'));
console.log('PASS A1 actual engine native button and shared spec popover/focus/locked reason; no new selector or paid path');

function matches(where: any, row: any): boolean {
  if (where.OR && !where.OR.some((entry: any) => matches(entry, row))) return false;
  if (where.AND && !where.AND.every((entry: any) => matches(entry, row))) return false;
  if (where.NOT && matches(where.NOT, row)) return false;
  return Object.entries(where).filter(([key]) => !['OR', 'AND', 'NOT'].includes(key)).every(([key, expected]: any) =>
    expected?.in ? expected.in.includes(row[key]) : expected?.contains ? String(row[key] || '').includes(expected.contains) : row[key] === expected);
}
async function sourceChecks(root: string) {
  const source: any = { CANVAS_PRODUCT_NAME, CANVAS_SOURCE_LABELS, canvasSourceJsonMarkers, isCanvasSource };
  runInNewContext(extract(root + 'src/app/admin/costs/page.tsx', ['parseSourceMetadata', 'taskSourceInfo', 'ultimateCanvasTaskWhere', 'videoTaskSourceWhere']), source);
  runInNewContext(extract(root + 'src/app/admin/points/AdminPointsClient.tsx', ['parseMetadata', 'recordSourceInfo']), source);
  for (const label of CANVAS_SOURCE_LABELS) {
    for (const spaced of [false, true]) {
      const metadata = JSON.stringify({ source_label: label, interface: 'web' }, null, spaced ? 1 : undefined);
      const row = { source_type: 'web', source_label: label, source_metadata_json: metadata };
      assert.equal(matches(source.ultimateCanvasTaskWhere(), row), true);
      assert.equal(matches(source.videoTaskSourceWhere('web'), row), false);
      assert.equal(source.taskSourceInfo(row).label, CANVAS_PRODUCT_NAME);
      assert.equal(source.recordSourceInfo({ metadata_json: JSON.stringify({ source_metadata: JSON.parse(metadata) }) }).label, CANVAS_PRODUCT_NAME);
      let captured: any;
      const ledger: any = { URL, getAdminUser: async () => {}, NextResponse: { json: (value: unknown) => value },
        canvasSourceJsonMarkers, prisma: { creditLedger: { findMany: async (args: any) => { captured = args; return []; }, count: async () => 0 } } };
      runInNewContext(extract(root + 'src/app/api/admin/credits/ledger/route.ts', ['parseDateParam', 'GET']), ledger);
      await ledger.GET({ url: 'https://offline.invalid/api/admin/credits/ledger?source=ultimate_canvas&user_id=owner&type=consume&page=2' });
      assert.equal(matches(captured.where, { metadata_json: metadata, user_id: 'owner', type: 'consume' }), true);
      assert.equal(matches(captured.where, { metadata_json: metadata, user_id: 'other', type: 'consume' }), false);
      assert.equal(captured.skip, 50); assert.equal(captured.take, 50);
    }
  }
  for (const label of ['我的画布', '无限画布自定义', '无线网络', '普通网页']) {
    const row = { source_type: 'web', source_label: label, source_metadata_json: JSON.stringify({ source_label: label }) };
    assert.equal(matches(source.ultimateCanvasTaskWhere(), row), false);
    assert.equal(source.taskSourceInfo(row).key, 'web');
  }
  assert.equal(source.taskSourceInfo({ source_metadata_json: '{"source":"ultimate_canvas"}', source_label: 'custom' }).label, CANVAS_PRODUCT_NAME);
  assert.equal(source.recordSourceInfo({ metadata_json: 'invalid JSON' }).key, 'unknown');
  assert.equal(read(root + 'src/lib/canvas-source.ts'), read('src/lib/canvas-source.ts'));
}
async function main() {
  await sourceChecks('');
  const guard = process.env.CAN37_GUARDED_ROLLBACK_ROOT;
  assert.ok(guard); await sourceChecks(guard + '/');
  console.log('PASS A2 actual main+guard cost/credit predicates and badges keep old/new labels, user/type/page guards, custom unrelated sources; no DB/ledger writes');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
