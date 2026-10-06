import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = file => ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
function find(file, predicate) {
  let match;
  const visit = node => { if (!match && predicate(node)) match = node; if (!match) ts.forEachChild(node, visit); };
  visit(source(file));
  assert.ok(match, `Missing production callback in ${file}`);
  return match;
}
const functionNode = (file, name) => find(file, node => ts.isFunctionDeclaration(node) && node.name?.text === name);
function evaluate(node, globals) {
  const code = ts.transpileModule(`(${node.getText()})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(code, globals);
}
const studioFile = 'src/app/image-studio/studio.tsx';
const previewFile = 'src/components/ZoomableImagePreview.tsx';
const coverFile = 'src/components/ResultImageCover.tsx';
let checks = 0;
const check = (name, run) => { run(); checks += 1; console.log(`PASS ${name}`); };

check('successful preview image load reaches the existing read signal', () => {
  const node = find(previewFile, node => ts.isVariableDeclaration(node) && node.name.getText() === 'handleImageReady');
  const observed = [];
  const ready = evaluate(node.initializer.arguments[0], {
    setDimensionsBySource: () => {}, comparisonMode: false, src: '/result-a', activeSrc: '/result-a', zoomMode: 'fit',
    applyZoomMode: () => {}, onImageLoaded: src => observed.push(src),
  });
  ready('/result-a')({ width: 32, height: 32 });
  assert.deepEqual(observed, ['/result-a']);
});

check('only the exact displayed result version is scheduled, including a zero navigation token', () => {
  const node = functionNode(studioFile, 'observeResultVersion');
  const receipts = [];
  const globals = { templateWorkbench: true, hidden: false, document: { hidden: false }, taskReadScope: 'viewer-a:module-a',
    currentView: { current: { active: true, token: 0 } }, resultReadSequence: { current: 0 }, readAttemptToken: { current: 0 },
    setViewedResults: update => receipts.push(typeof update === 'function' ? update(receipts.at(-1) || null) : update) };
  const observe = evaluate(node, globals);
  observe('task-a:asset-a:2026-10-06T00:00:00.000Z');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].scope, 'viewer-a:module-a');
  assert.equal(receipts[0].token, 0);
  assert.deepEqual(Array.from(receipts[0].versions), ['task-a:asset-a:2026-10-06T00:00:00.000Z']);
  globals.hidden = true; observe('hidden-result');
  globals.hidden = false; globals.document.hidden = true; observe('background-result');
  globals.document.hidden = false; globals.templateWorkbench = false; observe('other-page');
  globals.templateWorkbench = true; observe(null);
  assert.equal(receipts.length, 1);
});

check('rapid image loads retain all exact observations before the commit effect', () => {
  let receipt = null;
  const globals = { templateWorkbench: true, hidden: false, document: { hidden: false }, taskReadScope: 'viewer-a:module-a',
    currentView: { current: { token: 3 } }, resultReadSequence: { current: 0 }, readAttemptToken: { current: 0 },
    setViewedResults: update => { receipt = update(receipt); } };
  const observe = evaluate(functionNode(studioFile, 'observeResultVersion'), globals);
  observe('observed-a'); observe('observed-b'); observe('observed-a');
  assert.deepEqual(Array.from(receipt.versions), ['observed-a', 'observed-b']);
  globals.readAttemptToken.current = receipt.sequence;
  observe('observed-c'); assert.deepEqual(Array.from(receipt.versions), ['observed-c']);
});

check('thumbnail selection waits for an actual decoded image, not a broken complete image', () => {
  const node = find(coverFile, node => ts.isJsxAttribute(node) && node.name.getText() === 'onClick');
  const observed = [];
  const click = evaluate(node.initializer.expression, { onSelect: () => {}, onViewed: () => observed.push('seen') });
  const event = image => ({ detail: 1, stopPropagation() {}, currentTarget: { querySelector: () => image } });
  click(event({ complete: false, naturalWidth: 0 }));
  click(event({ complete: true, naturalWidth: 0 }));
  click(event({ complete: true, naturalWidth: 32 }));
  assert.deepEqual(observed, ['seen']);
});

check('the committed read is scoped to the active module and observed view instance', () => {
  const node = find(studioFile, node => ts.isCallExpression(node) && node.expression.getText() === 'useEffect'
    && node.arguments[0]?.getText().includes('readAttemptToken.current = viewedResults.sequence'));
  const writes = [];
  const globals = { templateWorkbench: true, hidden: false, active: true, taskReadScope: 'viewer-a:module-a', viewToken: 0,
    viewedResults: { scope: 'viewer-a:module-a', token: 0, sequence: 1, versions: ['observed-a'] },
    readAttemptToken: { current: 0 }, module: { id: 'module-a' }, onResultsViewed: (id, versions) => writes.push({ id, versions }) };
  const commit = evaluate(node.arguments[0], globals);
  commit(); commit();
  assert.equal(writes.length, 1); assert.equal(writes[0].id, 'module-a');
  globals.viewedResults = { scope: 'viewer-b:module-a', token: 0, sequence: 2, versions: ['other-viewer'] }; commit();
  globals.viewedResults = { scope: 'viewer-a:module-a', token: 1, sequence: 2, versions: ['old-view'] }; commit();
  globals.viewedResults = { scope: 'viewer-a:module-a', token: 0, sequence: 2, versions: ['hidden-view'] }; globals.hidden = true; commit();
  globals.hidden = false; globals.active = false; commit();
  assert.equal(writes.length, 1);
  globals.active = true; globals.viewedResults = { scope: 'viewer-a:module-a', token: 0, sequence: 2, versions: Array.from({ length: 25 }, (_, i) => `observed-${i}`) }; commit();
  assert.equal(writes.length, 3); assert.equal(writes[1].versions.length, 24); assert.equal(writes[2].versions.length, 1);
});

check('preview callback ignores reference images and results that did not actually load', () => {
  const node = find(studioFile, node => ts.isJsxAttribute(node) && node.name.getText() === 'onImageLoaded');
  const writes = [];
  const globals = { preview: { taskId: 'task-a', src: '/result-a', resultVersion: 'observed-a' }, observeResultVersion: version => writes.push(version) };
  const loaded = evaluate(node.initializer.expression, globals);
  loaded('/reference-a'); assert.equal(writes.length, 0);
  loaded('/result-a'); assert.deepEqual(writes, ['observed-a']);
  globals.preview = { src: '/reference-a' }; loaded('/reference-a'); assert.equal(writes.length, 1);
});

// Execute the production hook with controlled hooks/network; this is not browser or account acceptance.
async function hookChecks() {
  const pending = [];
  let state;
  const effects = [];
  const fakeReact = {
    useState(initial) { state = initial; return [state, value => { state = typeof value === 'function' ? value(state) : value; }]; },
    useRef: current => ({ current }), useCallback: callback => callback, useEffect: callback => effects.push(callback),
  };
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(root, 'src/app/image-studio/use-result-attention.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { exports, require: name => { assert.equal(name, 'react'); return fakeReact; }, AbortController, Date,
    window: { setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    fetch: (url, options) => new Promise(resolve => pending.push({ url, options, resolve })),
  });
  const hook = exports.useResultAttention('viewer-a', true);
  const cleanup = effects[0]();
  const respond = async (request, snapshot, ok = true) => {
    request.resolve({ ok, json: async () => snapshot });
    await new Promise(resolve => setImmediate(resolve));
  };
  await respond(pending.shift(), { viewerId: 'viewer-a', receiptRevision: 1, unreadModuleIds: ['module-a', 'module-b'] });
  const get = hook.refresh(true);
  const staleGet = pending.shift();
  const post = hook.markViewed('module-a', ['exact-version-a']);
  const mutation = pending.shift();
  assert.deepEqual(JSON.parse(mutation.options.body), { moduleId: 'module-a', versions: ['exact-version-a'] });
  await respond(mutation, { viewerId: 'viewer-a', receiptRevision: 2, unreadModuleIds: ['module-b'] }); await post;
  await respond(staleGet, { viewerId: 'viewer-a', receiptRevision: 1, unreadModuleIds: ['module-a', 'module-b'] }); await get;
  assert.deepEqual(Array.from(state.unread), ['module-b']); checks += 1; console.log('PASS old GET cannot relight a successfully read result');
  const failed = hook.markViewed('module-b', ['exact-version-b']);
  await respond(pending.shift(), null, false); await failed;
  assert.deepEqual(Array.from(state.unread), ['module-b']); assert.ok(state.error); checks += 1; console.log('PASS failed receipt preserves unread and recovery');
  const refresh = hook.refresh(true);
  await respond(pending.shift(), { viewerId: 'viewer-a', receiptRevision: 2, unreadModuleIds: ['module-a', 'module-b'] }); await refresh;
  assert.deepEqual(Array.from(state.unread), ['module-a', 'module-b']); checks += 1; console.log('PASS genuinely newer content with unchanged receipt revision remains unread');
  cleanup();
}
await hookChecks();
console.log(JSON.stringify({ checks, modelTasks: 0, fees: 0, productionWrites: 0, browserAcceptance: false }));
