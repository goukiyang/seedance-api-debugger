import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import ts from 'typescript';
const source = ts.transpileModule(fs.readFileSync('src/app/image-studio/result-pin-button.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
const checks = [];
let networkCalls = 0;
function setup(id) {
  const slots = []; let cursor = 0, published = 0, saved = 0, transport;
  const calls = [];
  const react = {
    useRef(value) { const n = cursor++; return slots[n] ||= { current: value }; },
    useState(value) { const n = cursor++; if (!(n in slots)) slots[n] = value;
      return [slots[n], next => { slots[n] = typeof next === 'function' ? next(slots[n]) : next; }]; },
  };
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(source, { exports, require(name) {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'lucide-react') return { Pin: 'Pin', RefreshCw: 'RefreshCw' };
    assert.ok(name.endsWith('.css'), name); return {};
  }, crypto: crypto.webcrypto, AbortSignal, Error, CustomEvent: class {}, window: { dispatchEvent() {} },
  fetch: async (_, options) => { const body = JSON.parse(options.body); calls.push(body); return transport(body); } });
  const base = { userId: 'author', moduleId: id, taskId: `task-${id}`, assetId: `asset-${id}`,
    onSaved() { saved++; }, onPublish() { published++; } };
  function render(state, overrides = {}) {
    cursor = 0;
    const node = exports.StudioResultPinButton({ ...base, state, ...overrides });
    return node.props.children.find(child => child?.props?.['data-studio-result-pin'] !== undefined);
  }
  return { render, calls, transport(fn) { transport = fn; }, get published() { return published; }, get saved() { return saved; } };
}
const privateState = { presetId: null, revision: 0, assetIds: [], disabledReason: '模板尚未共享，暂不能置顶给其他人' };
const sharedState = { presetId: 'published-template', revision: 2, assetIds: [], disabledReason: null };
const a = setup('unpublished');
assert.equal(a.render(null).props.disabled, true);
checks.push('loading_does_not_publish_or_send');
let button = a.render(privateState);
assert.equal(button.props.disabled, false);
assert.equal(button.props['aria-label'], '保存并共享模板后置顶');
button.props.onClick();
assert.equal(a.published, 1); assert.equal(a.calls.length, 0); assert.equal(a.saved, 0);
checks.push('selected_sharing_opens_existing_publication_without_pin_request');
assert.equal(a.render(privateState, { onPublish: undefined }).props.disabled, true);
checks.push('no_publication_capability_keeps_original_gate');
const b = setup('published');
b.transport(async () => ({ ok: true, json: async () => ({ saved: true, viewerId: 'author' }) }));
button = b.render(sharedState); assert.equal(button.props.disabled, false);
button.props.onClick(); await setImmediate();
assert.equal(b.published, 0); assert.equal(b.calls.length, 1); assert.equal(b.calls[0].active, true); assert.equal(b.saved, 1);
checks.push('published_template_uses_original_pin_api');
const c = setup('lost-response');
c.transport(async () => { throw new TypeError('response lost'); });
c.render(sharedState).props.onClick(); await setImmediate();
button = c.render(privateState);
assert.equal(button.props.disabled, true); assert.equal(c.published, 0);
checks.push('uncertain_pin_cannot_switch_to_publication');
c.transport(async () => ({ ok: true, json: async () => ({ saved: true, viewerId: 'author' }) }));
c.render(sharedState).props.onClick(); await setImmediate();
assert.deepEqual(c.calls[1], c.calls[0]); assert.equal(c.saved, 1);
checks.push('uncertain_retry_preserves_original_identity_and_intent');
const d = setup('unpin');
d.transport(async () => ({ ok: true, json: async () => ({ saved: true, viewerId: 'author' }) }));
d.render({ ...sharedState, assetIds: ['asset-unpin'] }).props.onClick(); await setImmediate();
assert.equal(d.calls[0].active, false); assert.equal(d.published, 0);
checks.push('existing_unpin_keeps_original_flow');
console.log(JSON.stringify({ passed: checks.length, checks, productionWrites: 0, networkCalls, generatedTasks: 0 }));
