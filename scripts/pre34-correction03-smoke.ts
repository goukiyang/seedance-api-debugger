import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const base = process.argv.find(value => value.startsWith('--baseline='))?.split('=')[1];
if (base && !/^[a-f0-9]{40}$/.test(base)) throw Error('Invalid baseline');
const source = (file: string) => base ? execFileSync('git', ['show', `${base}:${file}`], { encoding: 'utf8' }) : readFileSync(file, 'utf8');
function compile(file: string, names?: string[]) {
  const ast = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const declarations = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && names?.includes(node.name.text)) declarations.set(node.name.text, node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (names) names.forEach(name => assert.ok(declarations.has(name), `${file}:${name}`));
  const code = names ? names.map(name => declarations.get(name)).join('\n')
    : ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n');
  return ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
function referenceGuard() {
  const context: any = { invalid: (message: string) => { throw Error(message); } };
  runInNewContext(compile('src/lib/canvas-documents.ts', ['object', 'id', 'resourceRefs']) + ';this.guard=resourceRefs;', context);
  return context.guard;
}

function taskProjection() {
  const context: any = { window: {}, exports: {} };
  runInNewContext(source('public/tools/ultimate-canvas/generation-node-workflow.js'), context);
  const api = context.UltimateCanvasGenerationNodes;
  const guard = referenceGuard();
  const task = { id: 'task-fixture', local_status: 'failed', provider_task_id: null,
    reference_image_ids: '["reference-fixture"]', reference_album_ids: '["album-fixture"]',
    params_json: '{"private":"not a canvas setting"}', raw_status_response: 'private provider reply',
    owner: { name: 'not a canvas field' }, error_message: 'Reference fetch timed out', actual_cost: 0, frozen_cost: 0, refund_amount: 15 };
  for (const path of ['applyVideoTaskStatus', 'refreshVideoTaskNode']) {
    for (const status of ['queued', 'running', 'failed', 'cancelled', 'succeeded']) {
      const node: any = { id: 'node-video', type: 'video', x: 100, y: 200,
        data: { taskId: task.id, referenceImageIds: ['reference-fixture'], authoredText: 'user input',
          generationStatus: 'submitted', videoSubmission: { state: 'accepted', requestId: 'request-fixture', taskId: task.id },
          generationResult: { reference_image_ids: task.reference_image_ids, raw_status_response: 'legacy raw', task_id: task.id },
          videoHistory: [{ taskId: task.id, requestId: 'request-fixture' }] } };
      const c: any = { window: { UltimateCanvasGenerationNodes: api }, engine: { nodes: new Map([[node.id, node]]) },
        canvasRuntime: { selectedVideoCardId: 'card-fixture' }, CSS: { escape: (value: string) => value },
        document: { querySelector: () => ({}) }, scheduleCanvasSave: () => {}, renderVideoResultHistory: () => {},
        decorateGeneratedNode: () => {}, renderGenerationNodeControls: () => {}, setNodeGenerationStatus: () => {},
        videoPreviewForTask: () => '', taskDescription: () => 'task state', videoStageLabel: () => 'task state' };
      runInNewContext(compile('public/tools/ultimate-canvas/app.js', [path]) + `;this.apply=${path};`, c);
      const reply = { ...task, local_status: status, stable_download_ready: status === 'succeeded', preview_available: status === 'succeeded',
        result_video_url: status === 'succeeded' ? 'https://example.invalid/result.mp4' : '',
        play_url: status === 'succeeded' ? '/api/video/play/task-fixture' : '',
        download_url: status === 'succeeded' ? '/api/video/download/task-fixture' : '' };
      if (path === 'applyVideoTaskStatus') c.apply(node.id, reply); else c.apply(reply, node.id);
      assert.doesNotThrow(() => guard({ canvas: { nodes: [node] } }), `${path}: saved task must pass unchanged reference format guard`);
      assert.equal(node.data.taskId, task.id); assert.equal(node.data.generationStatus, status);
      assert.equal(node.data.videoSubmission.requestId, 'request-fixture');
      assert.equal(node.data.videoHistory.length, 1); assert.equal(node.data.authoredText, 'user input');
      assert.deepEqual(node.data.referenceImageIds, ['reference-fixture']);
      assert.equal(node.data.generationResult.local_status, status);
      assert.equal(node.data.generationResult.task_id, task.id);
      assert.ok(!JSON.stringify(node.data.generationResult).includes('private'));
      assert.ok(!('reference_image_ids' in node.data.generationResult));
      assert.ok(!('raw_status_response' in node.data.generationResult));
      if (status === 'succeeded') {
        assert.equal(node.data.generationResult.stable_download_ready, true);
        assert.equal(node.data.generationResult.download_url, reply.download_url);
      }
      node.data.referenceImageIds = ['["not-an-id"]'];
      assert.throws(() => guard({ canvas: { nodes: [node] } }), /素材或任务引用无效/, 'genuine reference guard must still reject malformed IDs');
    }
  }
  const unknown = api.videoTaskSnapshot({ id: 'task-fixture', local_status: 'submitted', provider_task_id: 'provider-fixture' });
  assert.equal(unknown.provider_task_id, 'provider-fixture');
  assert.equal(unknown.stable_download_ready, false);
  assert.equal(unknown.download_url, '');
  const original = { id: 'task-fixture', local_status: 'failed', reference_image_ids: '["reference-fixture"]' };
  const before = JSON.stringify(original); api.videoTaskSnapshot(original); assert.equal(JSON.stringify(original), before);
}

function jsx(type: unknown, props: any) { return { type, props }; }
function findElement(node: any, type: unknown): any {
  if (!node) return null;
  if (Array.isArray(node)) return node.map(item => findElement(item, type)).find(Boolean);
  return node.type === type ? node : findElement(node.props?.children, type);
}
async function frameContract() {
  const runtime = { jsx, jsxs: jsx, Fragment: 'fragment' };
  const component = 'CanvasFrame-fixture'; let user: any = { id: 'user-fixture' };
  const page: any = { exports: {}, URLSearchParams, encodeURIComponent,
    require: (name: string) => { assert.equal(name, 'react/jsx-runtime'); return runtime; },
    CanvasFrame: component, getSession: async () => user, isExternalUser: (value: any) => value.external,
    externalFallbackPath: () => '/external', redirect: (url: string) => { throw Error(url); } };
  runInNewContext(compile('src/app/tools/ultimate-canvas/page.tsx'), page);
  const result = await page.exports.default({ searchParams: { document_id: 'canvas-fixture', focus_node: 'node-video' } });
  const props = findElement(result, component).props;
  assert.equal(props.documentId, 'canvas-fixture');
  assert.equal(props.focusNodeId, 'node-video', 'outer page must forward explicit focus into iframe component');
  const frame: any = { exports: {}, encodeURIComponent,
    require: () => runtime, useRef: (current: any) => ({ current }), useState: (value: any) => [value, () => {}],
    useCallback: (fn: any) => fn, useEffect: () => {}, useAppSession: () => ({ user }),
    useProductDialog: () => ({ confirm: async () => false, productDialog: null }),
    CanvasReactions: 'reactions', ResourceLibraryPicker: 'picker', MediaPreview: 'preview' };
  runInNewContext(compile('src/app/tools/ultimate-canvas/CanvasFrame.tsx'), frame);
  for (const input of [props, { documentId: 'canvas-fixture' }, { documentId: 'canvas-fixture', focusNodeId: 'invalid/?' }]) {
    const src = findElement(frame.exports.default(input), 'iframe').props.src;
    const url = new URL(src, 'https://example.invalid');
    assert.equal(url.searchParams.get('document_id'), 'canvas-fixture');
    assert.equal(url.searchParams.get('focus_node'), input === props ? 'node-video' : null);
  }
  const ordinary = findElement(await page.exports.default({ searchParams: { document_id: 'canvas-fixture' } }), component).props;
  assert.equal(ordinary.focusNodeId, undefined, 'ordinary reload must retain saved viewport');
  const invalid = findElement(await page.exports.default({ searchParams: { focus_node: 'invalid/?' } }), component).props;
  assert.equal(invalid.focusNodeId, undefined);
  user = null;
  await assert.rejects(page.exports.default({ searchParams: { document_id: 'canvas-fixture', focus_node: 'node-video' } }),
    (error: Error) => { const url = new URL(error.message, 'https://example.invalid');
      const next = new URL(url.searchParams.get('next')!, 'https://example.invalid');
      assert.equal(next.searchParams.get('focus_node'), 'node-video'); return true; });
  user = { external: true };
  await assert.rejects(page.exports.default({ searchParams: { focus_node: 'node-video' } }), /external/);
}

function focusFootprint() {
  for (const width of [1920, 900]) {
    const node = { id: 'node-video', x: 3145, y: 294 };
    const engine: any = { nodes: new Map([[node.id, node], ['old-node', { id: 'old-node', x: 785, y: 254 }]]),
      scale: .75, offsetX: -847.9278, offsetY: -85.7239,
      container: { getBoundingClientRect: () => ({ width, height: 900 }) },
      selectNode: (id: string) => { engine.selected = id; }, _applyTransform: () => {}, _updateZoom: () => {}, _updateConnections: () => {} };
    const initial = plain([...engine.nodes.values()]); let measuredSelected = false;
    const footprint = { left: node.x - 120, right: node.x + 760, top: node.y, bottom: node.y + 740 };
    const rect = (left: number, top: number, right: number, bottom: number) => ({ left: left * engine.scale + engine.offsetX, top: top * engine.scale + engine.offsetY,
      right: right * engine.scale + engine.offsetX, bottom: bottom * engine.scale + engine.offsetY, width: (right - left) * engine.scale, height: (bottom - top) * engine.scale });
    const element = { get offsetWidth() { return 640; }, get offsetHeight() { return engine.selected === node.id ? 658 : 384; },
      getBoundingClientRect: () => { measuredSelected = engine.selected === node.id; return rect(node.x, node.y, node.x + 640, node.y + 658); },
      querySelectorAll: () => [{ getBoundingClientRect: () => rect(footprint.left, footprint.top, footprint.right, footprint.bottom) },
        { getBoundingClientRect: () => ({ width: 0, height: 0 }) }] };
    const c: any = { window: { UltimateCanvasPlanSplit: {} }, CSS: { escape: (s: string) => s },
      document: { querySelector: () => element, addEventListener: () => {} } };
    runInNewContext(source('public/tools/ultimate-canvas/plan-split-ui.js'), c);
    const ui = c.window.UltimateCanvasPlanSplitUI.create({ engine, notice: () => {} });
    ui.focus([node.id], { includeControls: true });
    assert.equal(measuredSelected, true, 'measure only after selection has expanded actual controls');
    const visible = rect(footprint.left, footprint.top, footprint.right, footprint.bottom);
    assert.ok(visible.left >= 39.9 && visible.right <= width - 39.9, 'selected controls must fit horizontally');
    assert.ok(visible.top >= 39.9 && visible.bottom <= 860.1, 'selected controls must fit vertically');
    assert.deepEqual(plain([...engine.nodes.values()]), initial, 'explicit focus changes viewport, never existing node positions');
    assert.equal(engine.selected, node.id);
  }
  const ast = ts.createSourceFile('app.js', source('public/tools/ultimate-canvas/app.js'), ts.ScriptTarget.Latest, true);
  const calls: string[] = [];
  function visit(node: ts.Node) { if (ts.isCallExpression(node) && node.expression.getText(ast) === 'planSplit.focus') calls.push(node.getText(ast)); ts.forEachChild(node, visit); }
  visit(ast);
  assert.equal(calls.length, 1); assert.match(calls[0], /includeControls:\s*true/, 'explicit story handoff uses actual footprint fitting');
}

async function main() {
  const which = process.argv.find(arg => arg.startsWith('--case='))?.split('=')[1];
  if (!which || which === 'M03') taskProjection();
  if (!which || which === 'M01F') { await frameContract(); focusFootprint(); }
  console.log(JSON.stringify({ pass: true, cases: which || ['M03', 'M01F'], baseline: base || null, providerCalls: 0, productionDbCalls: 0, browser: false }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
