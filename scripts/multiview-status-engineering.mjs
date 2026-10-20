import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const ast = relative => ts.createSourceFile(relative, read(relative), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function nodes(rootNode, predicate) {
  const result = [];
  function walk(node) { if (predicate(node)) result.push(node); ts.forEachChild(node, walk); }
  walk(rootNode); return result;
}
function variable(source, name) {
  const result = nodes(source, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name);
  assert.equal(result.length, 1, name);
  return result[0].initializer;
}
function evaluate(source, context = {}) {
  const output = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, require, ...context });
  return exports;
}
const checks = [];
const panel = ast('src/app/multiview/MultiviewGenerationPanel.tsx');
const checkSource = variable(panel, 'checkRequest').arguments[0].getText(panel);
const effects = nodes(panel, node => ts.isCallExpression(node) && node.expression.getText(panel) === 'useEffect'
  && node.arguments[0]?.getText(panel).includes('let pendingChecks = 0'));
assert.equal(effects.length, 1);
const pollSource = effects[0].arguments[0].getText(panel);
const { multiviewGenerationProgress } = evaluate(read('src/app/multiview/multiview-generation-progress.ts'));
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

async function pollFixture(mode) {
  const unknown = mode !== 'manual-overlap';
  const receiptRef = { current: { key: 'original-request', taskId: unknown ? null : 'original-task',
    phase: unknown ? 'unknown' : 'accepted' } };
  const timers = new Map();
  let nextTimer = 0, calls = 0, cleanup, releaseStatus, state;
  const statusReady = new Promise(resolve => { releaseStatus = resolve; });
  const sandbox = {
    owner: 'owner', loadedOwner: 'owner', ready: true, allowed: true, submitting: false,
    receipt: receiptRef.current, receiptRef, liveSessionReady: { current: true },
    checkLock: { current: null }, closeLock: { current: null }, checkAbort: { current: null },
    isClientSessionBlocked: () => false, capture: () => ({}), current: () => true,
    AbortController, AbortSignal, identifier: value => typeof value === 'string' && value.length > 0,
    rejectionFromResponse: () => null, closureFromResponse: () => null,
    invalidateMedia: () => {}, setCloseRetryKey: () => {},
    setChecking: () => {}, setStatus: () => {}, refreshCredits: () => Promise.resolve(),
    pendingActive: value => ['unknown', 'accepted'].includes(value?.phase),
    setTaskProgress: update => { state = update(state); },
    multiviewGenerationProgress, message: value => String(value),
    emittedReady: { current: null }, propsRef: { current: { onReady: () => assert.fail('Unexpected ready') } },
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    readJsonResponse: response => response.json(),
    fetch: async url => {
      assert(url.includes('original-request') || url.includes('original-task'), 'Original identity changed');
      calls++;
      if (url.includes('request-status')) return { ok: true, json: async () => mode === 'unknown-budget'
        ? { lookup: 'pending' } : mode === 'not-found' ? { lookup: 'not_found' } : { task: { id: 'original-task' } } };
      await statusReady;
      return { ok: true, json: async () => ({ id: 'original-task', idempotency_key: 'original-request',
        local_status: 'running', provider_status: 'running', provider_task_id: 'upstream-task' }) };
    },
    saveReceipt: value => {
      receiptRef.current = value; sandbox.receipt = value;
      queueMicrotask(() => { cleanup?.(); cleanup = controller.poll(); });
    },
  };
  const controller = evaluate(`export const checkRequest = ${checkSource}; export const poll = ${pollSource};`, sandbox);
  const runNext = async () => {
    assert.equal(timers.size, 1, 'Exactly one next polling cycle must exist');
    const [id, callback] = timers.entries().next().value;
    timers.delete(id); callback(); await tick();
  };
  if (mode === 'unknown-budget') sandbox.checkLock.current = {};
  if (mode === 'manual-overlap') { void controller.checkRequest(); await tick(); }
  cleanup = controller.poll(); await tick();
  if (mode === 'not-found') {
    assert.equal(calls, 1); assert.equal(timers.size, 0);
  } else if (mode === 'unknown-budget') {
    for (let i = 0; i < 15; i++) await runNext();
    assert.equal(calls, 0, 'A busy check cannot issue or consume unknown lookups');
    sandbox.checkLock.current = null;
    for (let i = 0; i < 12; i++) await runNext();
    assert.equal(calls, 12); assert.equal(timers.size, 0, 'Unknown lookup limit was lost');
  } else {
    assert.equal(timers.size, 1, 'A concurrent check retired the polling loop');
    const before = calls;
    await runNext();
    assert.equal(calls, before, 'An overlapping status request was duplicated');
    releaseStatus(); await tick();
    await runNext();
    assert.equal(calls, before + 1, 'Polling did not continue after the active request completed');
    assert.equal(state.value.step, 2);
    sandbox.liveSessionReady.current = false;
    await runNext();
    assert.equal(calls, before + 1); assert.equal(timers.size, 0, 'Account invalidation must stop polling');
  }
  cleanup?.(); assert.equal(timers.size, 0);
  checks.push(mode);
}

await pollFixture('phase-change');
await pollFixture('manual-overlap');
await pollFixture('unknown-budget');
await pollFixture('not-found');

const component = evaluate(read('src/app/multiview/MultiviewGenerationProgress.tsx'), {
  require: name => name.endsWith('.css') ? {} : name === 'lucide-react'
    ? { Check: () => React.createElement('i') } : require(name),
});
const previous = { step: 2, label: 'running', uncertain: false, failed: false, createdAt: '2026-10-20T00:00:00Z' };
const readyState = multiviewGenerationProgress('video_ready', null, previous);
const render = props => renderToStaticMarkup(React.createElement(component.MultiviewGenerationProgress,
  { state: readyState, taskId: 'new-task', preparing: false, previewReady: false, ...props }));
assert.match(render(), /视频已就绪/);
assert.doesNotMatch(render(), /正在准备选帧|已用时|可以选帧/);
assert.match(render({ preparing: true }), /正在准备选帧/);
assert.match(render({ previewReady: true }), /视频已就绪，可以选帧/);
assert.equal(multiviewGenerationProgress('submitted', { id: 'task', local_status: 'succeeded' }).label, '正在准备视频');
assert(multiviewGenerationProgress('failed', null, readyState).failed);
checks.push('ready-awaiting-open', 'actual-frame-preparation', 'usable-frames', 'delivery-distinct-from-open');

const notice = ast('src/components/ReleaseNotice.tsx');
const versionSource = variable(notice, 'check').arguments[0].getText(notice);
const releaseAst = ast('src/lib/release.ts');
const helpers = evaluate(releaseAst.statements.filter(ts.isFunctionDeclaration).map(n => n.getText(releaseAst)).join('\n'));
let target = null, remoteVersion = '0.100.2', channel = 'production', fail = false, message, risk = {}, refreshError = 'old';
const storage = new Map();
const versionCheck = evaluate(`export const check = ${versionSource};`, {
  inFlight: { current: false }, setChecking: () => {}, setMessage: value => { message = value; },
  setTarget: value => { target = value; }, setRisk: value => { risk = value; },
  setRefreshError: value => { refreshError = value; }, laterKey: 'release-later',
  localStorage: { getItem: key => storage.get(key), removeItem: key => storage.delete(key) },
  release: { version: '0.100.1', channel: 'production' }, ...helpers, AbortSignal,
  fetch: async () => { if (fail) throw Error('offline'); return { ok: true, json: async () => ({ version: remoteVersion, channel }) }; },
});
await versionCheck.check(); assert.equal(target.version, '0.100.2');
fail = true; await versionCheck.check(); assert.equal(message, '检查失败，请重试'); assert.equal(target.version, '0.100.2');
fail = false; channel = 'other'; await versionCheck.check(); assert.equal(target.version, '0.100.2');
channel = 'production'; remoteVersion = '0.100.1'; await versionCheck.check();
assert.equal(target, null); assert.equal(risk, null); assert.equal(refreshError, '');
remoteVersion = '0.100.2'; await versionCheck.check();
remoteVersion = '0.99.9'; await versionCheck.check(); assert.equal(target, null);
assert.notEqual(message, '当前已是最新版本');
remoteVersion = '00.100.01+same'; await versionCheck.check(); assert.equal(target, null); assert.equal(message, '当前已是最新版本');
remoteVersion = '0.100.2'; storage.set('release-later', remoteVersion); await versionCheck.check(); assert.equal(target, null);
await versionCheck.check(true); assert.equal(target.version, remoteVersion);
checks.push('withdrawn-release-cleared', 'rollback-no-false-latest', 'same-semver-build', 'failed-check-preserves-uncertainty',
  'channel-isolation', 'later-deduplication', 'manual-check-reopens');

console.log(JSON.stringify({ passed: true, checks, networkCalls: 0, providerCalls: 0, productionWrites: 0,
  evidence: 'Actual source functions and SSR markup with controlled responses/timers; no browser acceptance' }, null, 2));
