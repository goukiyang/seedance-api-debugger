import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url), ts = require('typescript');
const checks = [];
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function runtime(file, component, props, overrides = {}, storage = new Map()) {
  const slots = [], effects = [], queued = [], timers = new Map(), requests = [], confirmations = [], saved = [];
  let index = 0, dirty = false, tree, serial = 0, handler = async () => { throw new Error('Unexpected fixture request'); };
  const react = {
    useState(initial) { const i = index++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; dirty = true; }]; },
    useRef(initial) { const i = index++; return slots[i] ??= { current: initial }; },
    useId() { const i = index++; return slots[i] ??= `fixture-id-${i}`; },
    useEffect(callback, deps) { const i = index++, old = effects[i];
      if (!old || !deps || deps.some((v, n) => v !== old.deps?.[n])) queued.push(() => { old?.cleanup?.(); effects[i] = { deps, cleanup: callback() }; }); },
  };
  const modules = {
    react, 'react/jsx-runtime': { jsx: (tag, props) => ({ tag, props }), jsxs: (tag, props) => ({ tag, props }) },
    'lucide-react': {}, './studio.module.css': {},
    '@/lib/auth/client-session-boundary': { isClientSessionBlocked: () => false, watchSessionExit: () => () => {} },
    '@/components/useProductDialog': { useProductDialog: () => ({ confirm: async (text, options) => { confirmations.push({ text, options }); return false; }, productDialog: null }) },
    './private-draft-migration': { readLegacyPrivateDraft: () => null },
    './settings-controller': { studioSettingsDirty: () => false }, ...overrides,
  };
  const exported = {}, guard = {};
  const context = vm.createContext({ exports: exported, module: { exports: exported },
    require: id => { assert.ok(Object.hasOwn(modules, id), id); return modules[id]; },
    crypto: { randomUUID }, AbortSignal, Response, URL, console,
    window: { addEventListener() {}, removeEventListener() {}, location: { reload() {} } }, document: { addEventListener() {}, removeEventListener() {} },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setTimeout: (callback, delay) => { const id = ++serial; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, init = {}) => { const request = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null }; requests.push(request); return handler(request); },
  });
  const guardSource = ts.transpileModule(fs.readFileSync('src/lib/hooks/page-exit-guard.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInContext(`(function(exports) { ${guardSource}\n})`, context)(guard);
  modules['@/lib/hooks/page-exit-guard'] = guard;
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  vm.runInContext(source, context, { filename: file });
  function render(next = props) { props = next; dirty = false; index = 0; tree = exported[component](props); while (queued.length) queued.shift()(); }
  async function settle() { for (let i = 0; i < 14; i++) { await Promise.resolve(); if (dirty) render(); } }
  function nodes(root) { if (!arguments.length) root = tree; if (root == null || root === false) return []; if (Array.isArray(root)) return root.flatMap(nodes);
    if (typeof root !== 'object') return []; return [root, ...nodes(root.props?.children)]; }
  function text(node) { if (node == null || node === false) return ''; if (Array.isArray(node)) return node.map(text).join('');
    return typeof node === 'object' ? text(node.props?.children) : String(node); }
  function button(label) { const value = nodes().find(n => n.tag === 'button' && text(n) === label); assert.ok(value, label); return value; }
  return { render, settle, nodes, button, requests, confirmations, saved, storage,
    set handler(value) { handler = value; }, get tree() { return tree; },
    textarea: () => nodes().find(n => n.tag === 'textarea'), exitRisk: () => guard.getPageExitRisk(), tryRefresh: () => guard.refreshPage(),
    fire(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); } },
    timerCount: () => timers.size, dispose() { for (const effect of effects) effect?.cleanup?.(); },
  };
}

const props = () => ({ userId: 'fixture-admin', moduleId: 'gpt_image_studio_v1', contextOnly: true, label: '通用上下文',
  endpoint: '/api/image-studio/settings', canRead: true, needsIdentity: false, blocked: false, open: true,
  dialog: { current: { open: true, addEventListener() {}, removeEventListener() {} } }, beforeClose: { current: null }, onSaved() {} });
const baseline = draft => ({ revision: 7, sourceRevision: '7', prompt: '', context: 'synthetic-saved', draft });
const draft = (request, revision) => ({ version: 1, revision, sourceRevision: request.body.sourceRevision, values: request.body.values });
async function openEditor(existing = null, endpoint = '/api/image-studio/settings') {
  const p = props(), r = runtime('src/app/image-studio/PrivateDefinitionEditor.tsx', 'PrivateDefinitionEditor', p);
  p.endpoint = endpoint;
  p.onSaved = (...value) => r.saved.push(value); r.handler = async () => Response.json(baseline(existing)); r.render(); await r.settle();
  r.button('查看通用上下文').props.onClick(); await r.settle(); return { p, r };
}
async function main() {
  const { p, r } = await openEditor();
  assert.equal(r.textarea().props.value, 'synthetic-saved'); assert.equal(r.timerCount(), 0);
  assert.equal(r.exitRisk().unsaved.length, 0); assert.equal(r.exitRisk().busy.length, 0);
  assert.equal(await p.beforeClose.current(), true); assert.equal(r.requests.filter(x => x.method === 'PUT').length, 0);
  checks.push('view_without_manual_change_never_writes_or_blocks_close');
  for (const existing of [
    { version: 1, revision: 2, sourceRevision: '6', values: { prompt: '', context: 'old-applied' }, appliedRequestId: 'old-operation' },
    { version: 1, revision: 3, sourceRevision: '7', values: { prompt: '', context: 'retained-unapplied' } },
  ]) {
    const old = await openEditor(existing); assert.equal(old.r.timerCount(), 0); assert.equal(await old.p.beforeClose.current(), true);
    assert.equal(old.r.textarea().props.value, existing.appliedRequestId ? 'synthetic-saved' : existing.values.context); old.r.dispose();
  }
  checks.push('applied_draft_is_not_dirty_and_unapplied_encrypted_draft_restores');

  const first = deferred(); r.handler = () => first.promise;
  r.textarea().props.onChange({ target: { value: 'first-edit' } }); await r.settle();
  assert.equal(r.exitRisk().unsaved.length, 1); assert.equal(r.tryRefresh(), false);
  assert.equal(r.exitRisk().signature.includes('first-edit'), false);
  r.fire(700); await r.settle(); assert.equal(r.exitRisk().busy.length, 1); assert.equal(r.tryRefresh(), false);
  const firstRequest = r.requests.at(-1); assert.equal(firstRequest.body.action, 'save-private-draft'); assert.notEqual(r.textarea().props.disabled, true);
  r.textarea().props.onChange({ target: { value: 'synthetic-saved' } }); await r.settle();
  assert.equal(r.exitRisk().unsaved.length, 1, 'Reverting while an older draft is in flight still needs the latest intent preserved');
  r.textarea().props.onChange({ target: { value: 'later-edit' } }); await r.settle();
  first.resolve(Response.json(draft(firstRequest, 1))); await r.settle(); assert.equal(r.textarea().props.value, 'later-edit');
  r.handler = async request => Response.json(draft(request, 2)); r.fire(700); await r.settle();
  assert.equal(r.requests.at(-1).body.values.context, 'later-edit'); assert.notEqual(r.requests.at(-1).body.requestId, firstRequest.body.requestId);
  assert.equal(await p.beforeClose.current(), true);
  assert.equal(r.exitRisk().unsaved.length, 0); assert.equal(r.exitRisk().busy.length, 0);
  checks.push('background_draft_does_not_disable_input_and_late_ack_preserves_later_edit');
  checks.push('existing_page_exit_and_release_refresh_guard_tracks_manual_input_and_pending_without_plaintext');

  r.handler = async () => Response.json({ error: 'synthetic storage failure' }, { status: 500 });
  r.textarea().props.onChange({ target: { value: 'unknown-snapshot' } }); await r.settle(); r.fire(700); await r.settle();
  const failed = r.requests.at(-1), before = r.requests.length;
  for (const raw of r.storage.values()) assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['kind', 'requestId']);
  r.textarea().props.onChange({ target: { value: 'after-unknown' } }); await r.settle(); r.fire(700); await r.settle();
  assert.equal(r.requests.length, before); assert.notEqual(r.textarea().props.disabled, true);
  assert.equal(await p.beforeClose.current(), false); assert.equal(r.confirmations.at(-1).options.confirmLabel, '放弃修改并关闭');
  r.handler = async () => Response.json({ requestId: failed.body.requestId, draft: draft(failed, 3) });
  r.button('核对原草稿').props.onClick(); await r.settle();
  assert.ok(r.requests.at(-1).url.includes(failed.body.requestId)); assert.equal(r.textarea().props.value, 'after-unknown');
  checks.push('unknown_retains_original_id_and_requires_explicit_unique_input_close_decision');
  checks.push('query_original_receipt_never_overwrites_new_input_or_resends_unknown');

  r.handler = async request => Response.json(draft(request, 4)); r.fire(700); await r.settle();
  const save = deferred(); r.handler = () => save.promise;
  r.button('保存原文').props.onClick(); await r.settle(); const sent = r.requests.at(-1);
  assert.equal(sent.body.action, 'save-private-definition');
  r.textarea().props.onChange({ target: { value: 'typed-during-explicit-save' } }); await r.settle();
  save.resolve(Response.json({ requestId: sent.body.requestId, state: 'saved', revision: 8 })); await r.settle();
  assert.equal(r.textarea().props.value, 'typed-during-explicit-save'); assert.deepEqual(r.saved.at(-1), [8, true]);
  checks.push('explicit_save_ack_keeps_newer_input_open');
  r.handler = async request => Response.json(draft(request, 5)); r.fire(700); await r.settle();
  r.handler = async request => Response.json({ requestId: request.body.requestId, state: 'saved', revision: 9 });
  r.button('保存原文').props.onClick(); await r.settle(); assert.deepEqual(r.saved.at(-1), [9]); assert.equal(r.textarea(), undefined);
  checks.push('unchanged_explicit_save_ack_notifies_parent_to_close'); r.dispose();

  const independent = await openEditor();
  independent.r.handler = async () => Response.json({ error: 'synthetic old draft unknown' }, { status: 500 });
  independent.r.textarea().props.onChange({ target: { value: 'old-draft-snapshot' } }); await independent.r.settle(); independent.r.fire(700); await independent.r.settle();
  const unknownDraft = independent.r.requests.at(-1);
  independent.r.textarea().props.onChange({ target: { value: 'new-explicit-definition' } }); await independent.r.settle();
  assert.equal(independent.r.button('保存原文').props.disabled, false);
  const definition = deferred(); independent.r.handler = () => definition.promise;
  independent.r.button('保存原文').props.onClick(); await independent.r.settle();
  const definitionRequest = independent.r.requests.at(-1); assert.equal(definitionRequest.body.action, 'save-private-definition');
  assert.equal(definitionRequest.body.context, 'new-explicit-definition'); assert.equal(definitionRequest.body.revision, 7);
  const records = [...independent.r.storage.values()].map(raw => JSON.parse(raw));
  assert.equal(records.length, 2); assert.ok(records.some(v => v.kind === 'draft' && v.requestId === unknownDraft.body.requestId));
  assert.ok(records.some(v => v.kind === 'save' && v.requestId === definitionRequest.body.requestId));
  for (const value of records) assert.deepEqual(Object.keys(value).sort(), ['kind', 'requestId']);
  definition.resolve(Response.json({ requestId: definitionRequest.body.requestId, state: 'saved', revision: 8 })); await independent.r.settle();
  assert.deepEqual(independent.r.saved.at(-1), [8]); assert.equal(independent.r.textarea(), undefined);
  assert.equal(independent.r.requests.filter(v => v.method === 'PUT' && v.body.action === 'save-private-draft').length, 1);
  assert.equal([...independent.r.storage.values()].map(raw => JSON.parse(raw))[0].requestId, unknownDraft.body.requestId);
  checks.push('unknown_draft_allows_independent_definition_cas_save_and_successful_close_without_resend');
  const acceptedOldDraft = { version: 1, revision: 1, sourceRevision: '7', values: unknownDraft.body.values };
  independent.r.handler = async () => Response.json({ ...baseline(acceptedOldDraft), revision: 8, sourceRevision: '8', context: 'new-explicit-definition' });
  independent.r.button('查看通用上下文').props.onClick(); await independent.r.settle();
  assert.equal(independent.r.textarea().props.value, 'new-explicit-definition');
  independent.r.handler = async () => Response.json({ requestId: unknownDraft.body.requestId, draft: acceptedOldDraft });
  independent.r.button('核对原草稿').props.onClick(); await independent.r.settle();
  assert.equal(independent.r.textarea().props.value, 'new-explicit-definition'); assert.equal(independent.r.saved.length, 1);
  independent.r.button('恢复旧版本加密草稿').props.onClick(); await independent.r.settle(); assert.equal(independent.r.textarea().props.value, 'old-draft-snapshot');
  checks.push('both_original_ids_are_retained_separately_and_old_draft_query_cannot_replace_new_definition'); independent.r.dispose();
  const rejectedDraft = await openEditor(); rejectedDraft.r.handler = async () => Response.json({ state: 'not-applied' });
  rejectedDraft.r.textarea().props.onChange({ target: { value: 'definition-after-draft-conflict' } }); await rejectedDraft.r.settle(); rejectedDraft.r.fire(700); await rejectedDraft.r.settle();
  assert.equal(rejectedDraft.r.button('保存原文').props.disabled, false); assert.equal(rejectedDraft.r.tryRefresh(), false);
  rejectedDraft.r.handler = async request => Response.json({ requestId: request.body.requestId, state: 'saved', revision: 8 });
  rejectedDraft.r.button('保存原文').props.onClick(); await rejectedDraft.r.settle();
  assert.equal(rejectedDraft.r.requests.at(-1).body.action, 'save-private-definition'); assert.deepEqual(rejectedDraft.r.saved.at(-1), [8]);
  checks.push('draft_conflict_does_not_lock_independent_definition_save_or_drop_unique_input'); rejectedDraft.r.dispose();

  const late = await openEditor(), pending = deferred(); late.r.handler = () => pending.promise;
  late.r.textarea().props.onChange({ target: { value: 'account-a-input' } }); await late.r.settle(); late.r.fire(700); await late.r.settle(); const original = late.r.requests.at(-1);
  late.r.render({ ...late.p, userId: 'fixture-other' }); await late.r.settle();
  pending.resolve(Response.json(draft(original, 1))); await late.r.settle(); assert.equal(late.r.textarea(), undefined); assert.equal(late.r.saved.length, 0);
  checks.push('account_change_revokes_body_and_late_ack'); late.r.dispose();
  const moduleEditor = await openEditor(null, '/api/image-studio/modules');
  moduleEditor.r.textarea().props.onChange({ target: { value: 'module-edit' } }); await moduleEditor.r.settle();
  assert.equal(moduleEditor.r.exitRisk().unsaved.length, 0); assert.equal(moduleEditor.r.exitRisk().busy.length, 0);
  checks.push('global_exit_risk_does_not_expand_template_editor_policy'); moduleEditor.r.dispose();

  const conflict = await openEditor({ version: 1, revision: 4, sourceRevision: '6', values: { prompt: '', context: 'retained-conflict' } });
  assert.equal(conflict.r.textarea().props.value, 'synthetic-saved');
  conflict.r.button('恢复旧版本加密草稿').props.onClick(); await conflict.r.settle(); assert.equal(conflict.r.textarea().props.value, 'retained-conflict');
  const reread = deferred(); conflict.r.handler = () => reread.promise;
  conflict.r.button('核对最新版本').props.onClick(); await conflict.r.settle();
  assert.notEqual(conflict.r.textarea().props.disabled, true);
  conflict.r.textarea().props.onChange({ target: { value: 'typed-during-reread' } }); await conflict.r.settle();
  reread.resolve(Response.json({ ...baseline(null), revision: 8, sourceRevision: '8' })); await conflict.r.settle();
  assert.equal(conflict.r.textarea().props.value, 'typed-during-reread');
  conflict.r.handler = async request => Response.json(draft(request, 5)); conflict.r.fire(700); await conflict.r.settle();
  assert.equal(conflict.r.requests.at(-1).body.sourceRevision, '8');
  checks.push('explicit_conflict_reread_preserves_later_input_and_keeps_fresh_cas_source'); conflict.r.dispose();

  const storage = new Map(), hp = { open: true, ownerId: 'owner', canEdit: true, editor: { controller: { getSnapshot: () => ({ conflicts: [] }) } }, getExcluded: () => [], onDeltas() {} };
  const h = runtime('src/app/image-studio/use-resolution-apply.ts', 'useResolutionApply', hp, {}, storage);
  h.handler = async () => Response.json({ operations: [] }); h.render(); await h.settle(); assert.equal(h.requests.length, 0);
  h.tree.setScope(true); await h.settle(); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, '/api/image-studio/settings/resolution-apply');
  checks.push('resolution_history_is_read_only_on_explicit_scope_entry'); h.dispose();
  storage.set('sd2:resolution-apply:v1:owner', 'original-known-operation');
  const known = runtime('src/app/image-studio/use-resolution-apply.ts', 'useResolutionApply', hp, {}, storage), waiting = deferred();
  known.handler = () => waiting.promise; known.render(); await known.settle();
  assert.equal(known.requests.length, 1); assert.ok(known.requests[0].url.includes('requestId=original-known-operation'));
  assert.equal(known.tree.busy, true); assert.equal(known.tree.writing, false);
  checks.push('known_pending_queries_original_receipt_without_history_or_write_busy'); known.dispose();

  let closes = 0, loads = 0, dismiss;
  const global = runtime('src/app/image-studio/global-settings-dialog.tsx', 'StudioGlobalSettingsDialog', {
    open: true, ownerId: 'owner', canEdit: true, onClose() { closes++; }, ratios: {}, getExcluded: () => [], onDeltas() {},
    editor: { settings: { revision: 7 }, draft: null, conflicts: [], saving: false, controller: { getSnapshot: () => ({ settings: { revision: 7 } }), load() { loads++; } } },
  }, {
    '@/components/ContextClipboardActions': {}, '@/components/GenerationCompletion': {}, '@/lib/image-studio/model-catalog': {},
    '@/components/useDialogDismiss': { useDialogDismiss: value => { dismiss = value.onDismiss; } }, '@/lib/image-studio/limits': {},
    './ratio-picker': {}, '@/lib/hooks/page-exit-guard': { usePageExitRisk() {} },
    './use-resolution-apply': { useResolutionApply: () => ({ busy: true, writing: false }) }, './resolution-apply-panel': {}, './PrivateDefinitionEditor': {},
  });
  global.render(); await global.settle(); assert.equal(loads, 0);
  await global.nodes().find(node => node.props?.['aria-label'] === '关闭设置').props.onClick();
  await dismiss(); assert.equal(closes, 2);
  checks.push('global_dialog_reuses_loaded_controller_and_read_busy_never_blocks_dismiss'); global.dispose();
  console.log(JSON.stringify({ passed: true, checks, cases: checks.length, productionComponentAndHookExecuted: true,
    syntheticPlaintextOnly: true, networkCalls: 0, productionWrites: 0, browserRuns: 0, paidRequests: 0 }));
}
await main();
