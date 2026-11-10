import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import ts from 'typescript';

// Real React component/effects with synthetic server responses and a controlled
// draft timer. No browser, application database or provider is used.
const require = createRequire(import.meta.url);
const editorFile = 'src/app/image-studio/style-groups-view.tsx';
const selectorFile = 'src/app/image-studio/style-skill-selector.tsx';
const source = readFileSync(process.argv[3] || editorFile, 'utf8');
const selector = readFileSync(process.argv[4] || selectorFile, 'utf8');
const checks = [], timers = new Map(), writes = [], storage = new Map();
let timerId = 0;
const asset = { id: 'asset', originalUrl: '/synthetic-image', note: 'image note', available: true };
const group = { id: '11111111-1111-4111-8111-111111111111', name: 'Style', revision: 1, note: '',
  canManage: true, coverAssetId: asset.id, references: [asset], referenceCount: 1, coverUrl: null };
const response = value => ({ ok: true, json: async () => value });
const exports = {};
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
vm.runInNewContext(code, {
  exports, crypto: { randomUUID }, console,
  setTimeout: (callback, delay) => { assert.equal(delay, 700); timers.set(++timerId, callback); return timerId; },
  clearTimeout: id => timers.delete(id),
  localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  fetch: async (_url, options) => {
    if (options?.method === 'POST') return new Promise((resolve, reject) => writes.push({ value: JSON.parse(options.body), resolve: value => resolve(response(value)), reject }));
    return response({ groups: [group], nextCursor: null, draft: null });
  },
  require: name => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name === 'lucide-react') return new Proxy({}, { get: () => () => React.createElement('svg') });
    if (name.endsWith('.css')) return { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
    if (name.endsWith('useProductDialog')) return { useProductDialog: () => ({ confirm: async () => true, prompt: async () => {}, productDialog: null }) };
    if (name.endsWith('limits')) return { MAX_REFERENCE_IMAGES: 10 };
    if (name.endsWith('reference-grid')) return { StudioReferenceGrid: props => React.createElement('reference-grid', props) };
    if (name.endsWith('file-upload')) return { uploadFileAsAsset: () => { throw new Error('Upload prohibited'); } };
    return new Proxy({}, { get: () => () => null });
  },
});
const ref = React.createRef();
let tree;
let observeDraft = false;
const disabledDuringDraft = [];
const footerDuringDraft = [];
await act(async () => {
  tree = Renderer.create(React.createElement(React.Profiler, { id: 'style', onRender: () => {
    if (observeDraft && tree) {
      disabledDuringDraft.push(tree.root.findByProps({ 'aria-label': '风格组整体备注' }).props.disabled);
      footerDuringDraft.push(tree.root.findAllByType('button').some(button => button.children.includes('保存并选用')));
    }
  } }, React.createElement(exports.StudioStyleGroups, { ref, userId: 'owner', selected: [], onChange: () => {}, currentImages: [] })),
    { createNodeMock: element => element.type === 'dialog' ? { open: false, showModal() { this.open = true; }, close() { this.open = false; } } : {} });
});
await act(async () => { ref.current.edit(group); await new Promise(setImmediate); });
const textarea = () => tree.root.findByProps({ 'aria-label': '风格组整体备注' });
const editor = () => tree.root.findByProps({ 'aria-label': '编辑风格组' });
const change = value => act(async () => textarea().props.onChange({ target: { value } }));
const tick = () => act(async () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(run => run()); });
await change('first'); observeDraft = true; await tick();
assert.equal(writes.length, 1);
assert.equal(textarea().props.disabled, false, 'Background draft save disables the active textarea');
assert.equal(tree.root.findByType('reference-grid').props.disabled, false);
assert.ok(tree.root.findAllByType('button').some(button => button.children.includes('保存并选用')), 'Autosave replaced the normal footer');
checks.push('background save keeps text/reference input enabled and footer stable');
await change('second');
writes[0].resolve({ draft: { revision: 1 } });
await new Promise(setImmediate);
observeDraft = false;
assert.ok(disabledDuringDraft.length > 0 && disabledDuringDraft.every(value => value === false), 'Draft receipt causes a transient input lock');
assert.ok(footerDuringDraft.every(Boolean), 'Draft save transiently replaced the editor footer');
checks.push('all React commits keep input enabled while the draft receipt settles');
assert.equal(textarea().props.value, 'second');
await tick(); assert.equal(writes.length, 2);
assert.equal(writes[1].value.expectedRevision, 1); assert.equal(writes[1].value.value.note, 'second');
await act(async () => writes[1].resolve({ draft: { revision: 2 } }));
checks.push('older draft receipt retains newer input and next write advances the real CAS revision');
await act(async () => editor().props.onCompositionStartCapture());
await change('拼音候选'); await tick(); assert.equal(writes.length, 2);
await act(async () => editor().props.onCompositionEndCapture());
await change('完整中文'); await tick(); assert.equal(writes.length, 3);
assert.equal(writes[2].value.value.note, '完整中文');
checks.push('IME composition defers draft submission until completed text');
await act(async () => writes[2].reject(new Error('synthetic lost response')));
await change('input after unknown draft'); await tick(); assert.equal(writes.length, 3);
assert.equal(textarea().props.disabled, false);
assert.ok([...storage.values()].some(value => value.includes(writes[2].value.requestId)));
checks.push('unknown draft preserves original request identity and never resubmits while retaining input');
await act(async () => tree.unmount());

const parsed = ts.createSourceFile(selectorFile, selector, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let updated, undoClick;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'styleUpdated') updated = node.initializer.getText(parsed);
  if (ts.isJsxOpeningElement(node) && node.tagName.getText(parsed) === 'button'
    && node.attributes.properties.some(item => ts.isJsxAttribute(item) && item.name.getText(parsed) === 'aria-label' && item.initializer?.text === '撤销本次选择修改')) {
    undoClick = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(parsed) === 'onClick').initializer.expression.getText(parsed);
  }
  ts.forEachChild(node, visit);
}
visit(parsed); assert.ok(updated); assert.ok(undoClick);
for (const scenario of ['current', 'historical', 'use', 'replace-history']) {
  const historical = scenario === 'historical' || scenario === 'replace-history';
  const use = scenario === 'use' || scenario === 'replace-history';
  let applied = scenario === 'use' ? [] : [{ ...group, historical }];
  const originalApplied = [...applied];
  let pending = [...applied, { ...group, id: 'other-pending' }], refreshes = 0, appliedSkills = [];
  const set = key => value => { if (key === 'pending') pending = typeof value === 'function' ? value(pending) : value; };
  const context = { appliedStyles: applied, appliedSkills, open: false, undo: { styles: pending, skills: [{ id: 'unconfirmed-skill' }] },
    setPendingStyles: set('pending'), setPendingSkills: () => {}, applyStyles: value => { applied = value; }, applySkills: value => { appliedSkills = value; },
    setUndo: value => { context.undo = typeof value === 'function' ? value(context.undo) : value; }, setDetail: () => {}, setPreferences: () => {}, setRetry: () => {}, pendingScroll: {}, scroll: { current: 0 },
    onStyleUpdated: () => refreshes++ };
  const compiled = ts.transpileModule(`globalThis.run = ${updated};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compiled, context);
  context.run({ ...group, revision: 2, note: 'new group note', referenceCount: 2 }, use);
  assert.equal(refreshes, 1, 'Confirmed save must refresh shared generation intent');
  assert.equal(applied.length, 1, 'Unrelated pending choices must not be applied by save/use');
  assert.equal(applied[0].revision, historical && !use ? 1 : 2);
  assert.equal(pending.find(item => item.id === group.id).revision, historical && !use ? 1 : 2);
  assert.ok(pending.some(item => item.id === 'other-pending'));
  if (use) {
    vm.runInNewContext(ts.transpileModule(`(${undoClick})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    assert.deepEqual(applied.map(item => item.id), originalApplied.map(item => item.id), 'Undo applied an unconfirmed style');
    assert.equal(appliedSkills.length, 0, 'Undo applied unconfirmed skills');
    if (historical) assert.equal(applied[0].revision, 1, 'Undo lost the original frozen selection');
  }
  checks.push(`confirmed style update: ${scenario}`);
}
checks.push('save/use undo restores actual prior selection without unconfirmed styles or skills');
const files = [editorFile, selectorFile, 'src/app/image-studio/studio.tsx', 'scripts/studio-style-input-engineering.mjs'];
const report = { passed: checks.length, checks, browserUsed: false, providerCalls: 0, productionWrites: 0,
  sourceSha256: Object.fromEntries(files.map(name => [name, createHash('sha256').update(readFileSync(name)).digest('hex')])) };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
