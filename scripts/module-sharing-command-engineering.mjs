import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';
const source = ts.transpileModule(fs.readFileSync('src/app/image-studio/use-module-sharing-preference.ts', 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function setup(storage = {}) {
  const slots = []; let cursor = 0, first = true, transport, calls = [], events = [], settled = [];
  const localStorage = { ...storage, getItem(key) { return this[key] ?? null; },
    setItem(key, value) { events.push('persist'); this[key] = value; }, removeItem(key) { delete this[key]; } };
  const react = { useRef(value) { const n = cursor++; return slots[n] ||= { current: value }; },
    useState(value) { const n = cursor++; if (!(n in slots)) slots[n] = value;
      return [slots[n], next => { slots[n] = typeof next === 'function' ? next(slots[n]) : next; }]; },
    useEffect(callback) { if (first) callback(); } };
  const exports = {};
  vm.runInNewContext(source, { exports, require: name => { assert.equal(name, 'react'); return react; }, localStorage,
    crypto: crypto.webcrypto, AbortSignal, DOMException, Error, TypeError, fetch: async (_, options) => {
      events.push('send'); const command = JSON.parse(options.body); calls.push(command); return transport(command);
    } });
  function render(owner = 'author') { cursor = 0;
    const value = exports.useModuleSharingPreference(owner, result => settled.push(result)); first = false; return value; }
  return { localStorage, events, calls, settled, render, transport(fn) { transport = fn; } };
}
const success = c => ({ ok: true, json: async () => ({ id: c.id, revision: c.revision + 1,
  sharingPreference: { enabled: c.isShared }, canChooseSharing: true,
  sharingCommandReceipt: { action: c.action, moduleId: c.id, requestId: c.requestId, expectedRevision: c.revision } }) });
const a = setup(); a.transport(async () => { throw new TypeError('response lost'); });
await assert.rejects(a.render().submit('module-one', 7, true), /共享结果待确认/);
assert.deepEqual(a.events, ['persist', 'send']);
const original = a.calls[0]; a.transport(success);
await a.render().submit('module-one', 8, false);
assert.deepEqual(a.calls[1], original, 'second click must retain original key, revision, and intended state');
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
d.render('another-account'); finish(); await assert.rejects(old, /账号已切换/); assert.equal(d.settled.length, 0);
const e = setup(); e.transport(async () => { throw new TypeError('response lost'); });
await assert.rejects(e.render().submit('module-refresh', 3, true));
const restored = setup(Object.fromEntries(Object.entries(e.localStorage).filter(([k]) => k.startsWith('sd2:'))));
restored.transport(success); await restored.render().submit('module-refresh', 4, false);
assert.deepEqual(restored.calls[0], e.calls[0]);
console.log(JSON.stringify({ passed: 6, checks: ['persist_before_send', 'lost_response_reuses_original_command',
  'storage_failure_sends_nothing', 'parallel_click_sends_once', 'account_switch_drops_late_response', 'refresh_retains_original_command'],
  productionWrites: 0, networkCalls: 0, generatedTasks: 0 }));
