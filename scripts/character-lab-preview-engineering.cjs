'use strict';
// Offline real React effects. No browser, database, credentials or provider calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const runtime = createRequire(path.join(process.env.REQ01_RUNTIME_ROOT || root, 'package.json'));
const React = runtime('react'), Renderer = runtime('react-test-renderer'), ts = runtime('typescript');
assert.equal(runtime('react-test-renderer/package.json').version, React.version);
const { act } = Renderer, hashes = {}, checks = [];
function load(file, imports) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  hashes[file] = createHash('sha256').update(source).digest('hex');
  const compiled = ts.transpileModule(source, { fileName: file, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  assert.ok(!compiled.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error));
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputText)(name => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`); return imports[name];
  }, module, module.exports);
  return module.exports;
}
const requests = [], timers = new Map();
let timerId = 0, renderer, commits = [];
const originals = Object.fromEntries(['window', 'document', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const noop = () => {};
const windowStub = { addEventListener: noop, removeEventListener: noop,
  setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
  clearTimeout: id => timers.delete(id) };
for (const [key, value] of Object.entries({ window: windowStub,
  document: { visibilityState: 'visible', addEventListener: noop, removeEventListener: noop },
  fetch: (url, init = {}) => new Promise(resolve => {
    assert.ok(url === '/api/character-lab' || url === '/api/character-lab?recipe=original-plan', 'No external requests');
    if (init.method === 'POST') assert.equal(JSON.parse(init.body).action, 'preview-prompt', 'Never generate or save');
    requests.push({ url, ...init, resolve: (body, status = 200) => resolve(new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' } })) });
  }) })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const Panel = load('src/app/tools/character-lab/prompt-panel.tsx', {
  react: React, 'react/jsx-runtime': runtime('react/jsx-runtime'),
  'lucide-react': { Copy: () => null, Loader2: () => null, X: () => null },
  '@/lib/http/json-response': load('src/lib/http/json-response.ts', {}),
  '@/components/RelativeTime': { RelativeTime: () => null }, './images': { CharacterLabImage: () => null },
  '@/lib/character-lab/types': load('src/lib/character-lab/types.ts', {}), './studio.module.css': { default: {} },
}).CharacterLabPromptPanel;
let props = { ownerId: 'fixture-owner', workspaceId: 'fixture-workspace', title: 'Fixture', configRevision: 1,
  tab: 'next', isAdmin: true, disabled: false, escapeEnabled: true,
  previewPayload: { action: 'preview-prompt', description: 'initial' },
  onTab: noop, onClose: noop, onRestore: noop, onReproduce: noop, onRestorePersonal: noop,
  onPreview: noop, onBrowse: noop, onInspectSource: noop, onPreviewAsset: noop, children: null };
function Harness(value) {
  React.useLayoutEffect(() => { if (renderer) commits.push(JSON.stringify(renderer.toJSON())); });
  return React.createElement(Panel, value);
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function update(patch) {
  props = { ...props, ...patch }; commits = [];
  await act(async () => { renderer.update(React.createElement(Harness, props)); await tick(); });
}
async function flush(delay) {
  const selected = [...timers].filter(([, timer]) => timer.delay === delay);
  assert.equal(selected.length, 1, `Expected one ${delay}ms timer`);
  await act(async () => { for (const [id, timer] of selected) { timers.delete(id); timer.callback(); } await tick(); });
}
async function answer(request, body, status) { await act(async () => { request.resolve(body, status); await tick(); }); }
const tree = () => JSON.stringify(renderer.toJSON());
const preview = (revision, prompt) => ({ revision, prompt, personalText: 'fixture' });
async function main() {
  try {
    await act(async () => { renderer = Renderer.create(React.createElement(Harness, props)); await tick(); });
    await flush(300); await answer(requests.at(-1), preview(1, 'OLD_SAVED_PROMPT'));
    assert.ok(tree().includes('OLD_SAVED_PROMPT'));
    await update({ configRevision: 2 });
    assert.ok(commits.length && !commits[0].includes('OLD_SAVED_PROMPT'), 'Saved revision hides old text before passive effects');
    await flush(0); await answer(requests.at(-1), preview(2, 'NEW_SAVED_PROMPT'));
    assert.ok(tree().includes('NEW_SAVED_PROMPT'));
    checks.push('confirmed_revision_refreshes_without_typing_delay_and_masks_old_commit');
    await update({ previewPayload: { ...props.previewPayload, description: 'edited' } });
    await flush(300); const late = requests.at(-1);
    await update({ configRevision: 3 });
    assert.ok(late.signal.aborted, 'Cancel previous revision');
    await flush(0); const current = requests.at(-1);
    assert.notEqual(current, late); await answer(current, preview(3, 'NEW_STYLE_PROMPT'));
    assert.ok(tree().includes('NEW_STYLE_PROMPT'));
    await answer(late, preview(1, 'LATE_OLD_PROMPT'));
    assert.ok(tree().includes('NEW_STYLE_PROMPT') && !tree().includes('LATE_OLD_PROMPT'));
    checks.push('late_old_response_cannot_overwrite_new_revision');
    await update({ previewPayload: { ...props.previewPayload, description: 'typing' } });
    assert.ok([...timers.values()].some(timer => timer.delay === 300), 'Keep typing debounce');
    await update({ configRevision: 4 });
    assert.ok(![...timers.values()].some(timer => timer.delay === 300), 'Save cancels pending typing delay');
    await flush(0); await answer(requests.at(-1), { error: 'PREVIEW_FAILED' }, 500);
    assert.ok(tree().includes('PREVIEW_FAILED'));
    await update({ configRevision: 5 });
    assert.ok(!commits[0].includes('PREVIEW_FAILED'), 'Old error is scoped to its request');
    await flush(0); await answer(requests.at(-1), preview(5, 'LATEST_RECOVERED_PROMPT'));
    assert.ok(tree().includes('LATEST_RECOVERED_PROMPT'));
    checks.push('save_cancels_debounce_and_new_revision_recovers_from_old_error');
    await update({ tab: 'current', reference: { planId: 'original-plan' } });
    await answer(requests.at(-1), { plan: { id: 'original-plan', kind: 'faces', count: 4, diversity: 0,
      model: 'fixture', quality: 'medium', resolution: '1K', configRevision: 1, aspectRatio: '1:1', createdAt: '2026-11-08T00:00:00Z' },
      personalText: 'original supplement', completePrompt: 'HISTORICAL_FROZEN_PROMPT', instruction: null,
      hasImage: false, references: [] });
    const before = requests.length;
    await update({ configRevision: 6 });
    assert.equal(requests.length, before); assert.ok(tree().includes('HISTORICAL_FROZEN_PROMPT'));
    checks.push('current_image_original_prompt_stays_frozen');
    console.log(JSON.stringify({ schema: 'character-lab-preview-engineering.v1', synthetic: true,
      reactVersion: React.version, sourceSha256: hashes, checks, productionWrites: 0, paidRequests: 0,
      browserRuns: 0, externalRequests: 0 }, null, 2));
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
