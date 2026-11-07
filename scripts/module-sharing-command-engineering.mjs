import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';
const source = ts.transpileModule(fs.readFileSync('src/app/image-studio/use-module-sharing-preference.ts', 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function setup(storage = {}) {
  const slots = []; let cursor = 0, first = true, transport, calls = [], methods = [], events = [], settled = [];
  const localStorage = { ...storage, getItem(key) { return this[key] ?? null; },
    setItem(key, value) { events.push('persist'); this[key] = value; }, removeItem(key) { delete this[key]; } };
  const react = { useRef(value) { const n = cursor++; return slots[n] ||= { current: value }; },
    useState(value) { const n = cursor++; if (!(n in slots)) slots[n] = value;
      return [slots[n], next => { slots[n] = typeof next === 'function' ? next(slots[n]) : next; }]; },
    useEffect(callback) { if (first) callback(); } };
  const exports = {};
  vm.runInNewContext(source, { exports, require: name => name === 'react' ? react : { isClientSessionBlocked: () => false }, localStorage,
    document: { hidden: false, addEventListener() {}, removeEventListener() {} }, window: { addEventListener() {}, removeEventListener() {} }, navigator: { onLine: false }, URLSearchParams,
    crypto: crypto.webcrypto, AbortSignal, DOMException, Error, TypeError, fetch: async (url, options) => {
      events.push('send'); methods.push(options.method);
      const params = new URL(url, 'https://fixture.invalid').searchParams;
      const command = options.method === 'GET' ? { action: params.get('action'), id: params.get('id'), revision: Number(params.get('revision')),
        isShared: params.get('isShared') === 'true', requestId: params.get('requestId'), entryPoint: 'workbench' } : JSON.parse(options.body);
      calls.push(command); const response = await transport(command);
      if (options.method !== 'GET' || !response.ok) return response;
      return { ...response, json: async () => { const value = await response.json(); return value.status ? value : { status: 'completed', result: value }; } };
    } });
  function render(owner = 'author') { cursor = 0;
    const value = exports.useModuleSharingPreference(owner, result => settled.push(result)); first = false; return value; }
  return { localStorage, events, calls, methods, settled, render, transport(fn) { transport = fn; } };
}
const success = c => ({ ok: true, json: async () => ({ id: c.id, revision: c.revision + 1,
  sharingPreference: { enabled: c.isShared }, canChooseSharing: true,
  sharingCommandReceipt: { action: c.action, moduleId: c.id, requestId: c.requestId, expectedRevision: c.revision } }) });
const a = setup(); a.transport(async () => { throw new TypeError('response lost'); });
await assert.rejects(a.render().submit('module-one', 7, true), /共享结果待确认/);
assert.deepEqual(a.events, ['persist', 'send']);
const original = a.calls[0]; a.transport(success);
assert.equal(original.action, 'share-saved-module');
await a.render().submit('module-one', 8, false);
assert.deepEqual(a.calls[1], original, 'second click must retain original key, revision, and intended state');
assert.deepEqual(a.methods, ['PUT', 'GET'], 'unknown response must query, never send a second write');
assert.equal(a.settled.length, 1);
assert.equal(Object.keys(a.localStorage).some(k => k.startsWith('sd2:')), false);
const b = setup(); b.localStorage.setItem = () => { throw new Error('disk unavailable'); };
b.transport(success); await assert.rejects(b.render().submit('module-one', 0, true), /本次未发送/);
assert.equal(b.calls.length, 0);
const c = setup(); let resolve; c.transport(cmd => new Promise(done => { resolve = () => done(success(cmd)); }));
const first = c.render().submit('module-one', 0, true);
await assert.rejects(c.render().submit('module-one', 0, true), /当前共享设置/);
resolve(); await first; assert.equal(c.calls.length, 1);
const d = setup(); let finish; d.transport(cmd => new Promise(done => { finish = () => done(success(cmd)); }));
const old = d.render().submit('module-one', 0, true);
d.render('another-account'); finish(); await assert.rejects(old, /账号已变化|账号已切换/); assert.equal(d.settled.length, 0);
const e = setup(); e.transport(async () => { throw new TypeError('response lost'); });
await assert.rejects(e.render().submit('module-refresh', 3, true));
const restored = setup(Object.fromEntries(Object.entries(e.localStorage).filter(([k]) => k.startsWith('sd2:'))));
restored.transport(success); await restored.render().submit('module-refresh', 4, false);
assert.deepEqual(restored.calls[0], e.calls[0]);
const legacyCommand = { id: 'legacy-module', revision: 2, isShared: true, requestId: crypto.randomUUID() };
const legacy = setup({ 'sd2:module-sharing-preference:v1:author:legacy-module': JSON.stringify(legacyCommand) });
legacy.transport(success); await legacy.render().submit('legacy-module', 3, true);
assert.deepEqual(legacy.calls[0], { action: 'set-sharing-preference', ...legacyCommand, entryPoint: 'workbench' });
await legacy.render().submit('legacy-module', 3, true);
assert.equal(legacy.calls[1].action, 'share-saved-module');
const missing = setup(); missing.transport(success);
await assert.rejects(missing.render().submit('missing-original', 0, false, true), /本次未发送/);
assert.equal(missing.calls.length, 0, 'automatic original query cannot become a write when local record disappeared');
const rejected = setup(); rejected.transport(async command => ({ ok: false, status: 409, json: async () => ({ error: '版本已变化', commandOutcome: { status: 'not-applied', actorId: 'author', moduleId: command.id, requestId: command.requestId } }) }));
await assert.rejects(rejected.render().submit('stale-module', 1, true), /版本已变化/);
assert.equal(Object.keys(rejected.localStorage).some(key => key.startsWith('sd2:')), false, 'only a matched server not-applied proof can retire a rejected command');
const unconfirmed = setup(); unconfirmed.transport(async () => ({ ok: false, status: 409, json: async () => ({ error: '读取未确认' }) }));
await assert.rejects(unconfirmed.render().submit('unknown-module', 1, true));
assert.equal(Object.keys(unconfirmed.localStorage).some(key => key.startsWith('sd2:')), true, 'HTTP409 alone cannot retire a potentially committed write');
const switchSource = ts.transpileModule(fs.readFileSync('src/components/TemplateSharingSwitch.tsx', 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const switchExports = {};
vm.runInNewContext(switchSource, { exports: switchExports, require: name => name === 'react/jsx-runtime'
  ? { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) } : { default: {} } });
const selectedOnly = switchExports.default({ shared: false, selected: true, onChange() {} });
assert.equal(selectedOnly.props.children[0].props.checked, false);
assert.equal(switchExports.default({ shared: true, onChange() {} }).props.children[0].props.checked, true);
// Exercise the actual editor/cover handlers after a lost response changes a module into a published source.
const studioText = fs.readFileSync('src/app/image-studio/studio.tsx', 'utf8');
const studioAst = ts.createSourceFile('studio.tsx', studioText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let editorHandler, coverHandler;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'changeModuleSharing') editorHandler = node.getText(studioAst);
  if (ts.isJsxAttribute(node) && node.name.getText(studioAst) === 'onChange' && node.initializer
    && ts.isJsxExpression(node.initializer) && node.initializer.expression?.getText(studioAst).includes('const state = pageItem.sharing!')) {
    coverHandler = node.initializer.expression.getText(studioAst);
  }
  ts.forEachChild(node, visit);
}
visit(studioAst); assert.ok(editorHandler && coverHandler);
const routed = [], published = { id: 'module-one', sourcePresetId: 'source-one', sourcePresetCanManageSharing: true, canChooseSharing: false };
const editorContext = vm.createContext({ module: published, moduleSaveLock: { current: false }, moduleDeleteLock: { current: false },
  presetSaveLock: { current: false }, uploading: false, bannerUploading: false, submitting: false, pendingSubmission: false,
  preferenceSharingPending: true, sharedLive: {}, revisionRef: { current: 7 },
  setError() {}, setSharingPreferenceSaving() {}, setModuleRevision() {}, setSaveStatus() {},
  onToggleSharing: async () => { routed.push('withdraw'); }, onChooseSharing: async () => {
    routed.push('query-original'); return { revision: 8, sourcePresetShared: true };
  } });
const runEditor = vm.runInContext(ts.transpileModule(editorHandler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\nchangeModuleSharing;', editorContext);
await runEditor(); assert.deepEqual(routed, ['query-original']);
editorContext.preferenceSharingPending = false; await runEditor(); assert.deepEqual(routed, ['query-original', 'withdraw']);
const coverCalls = [], preference = { pending: { 'module-one': true }, submit: async () => { coverCalls.push('query-original'); } };
const runCover = vm.runInNewContext(ts.transpileModule(`const handler = ${coverHandler}; handler;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
  pageItem: { sharing: { kind: 'preset', id: 'source-one', shared: true, revision: 'source-revision' } }, entry: { id: 'module-one' },
  preferenceSharing: preference, modules: [{ id: 'module-one', revision: 8 }], setError() {}, pool: { refresh() {} },
  requestPresetSharing: async (_id, shared) => { assert.equal(shared, false); coverCalls.push('withdraw'); },
});
runCover(); assert.deepEqual(coverCalls, ['query-original']);
preference.pending = {}; runCover(); assert.deepEqual(coverCalls, ['query-original', 'withdraw']);
console.log(JSON.stringify({ passed: 13, checks: ['persist_before_send', 'lost_response_queries_original_receipt',
  'storage_failure_sends_nothing', 'parallel_click_sends_once', 'account_switch_drops_late_response', 'refresh_queries_original_command',
  'new_click_publishes_saved_template', 'legacy_pending_queries_preference_before_explicit_new_publication', 'automatic_query_never_becomes_write', 'only_matched_not_applied_proof_retires_command', 'only_actual_shared_state_checks_switch',
  'editor_queries_pending_original_after_binding_changes', 'cover_queries_pending_original_after_binding_changes'],
  productionWrites: 0, networkCalls: 0, generatedTasks: 0 }));
