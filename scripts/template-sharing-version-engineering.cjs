'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const root = process.cwd(), requireAt = createRequire(path.join(root, 'package.json')), ts = requireAt('typescript');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sharing-revision-')); fs.chmodSync(fixture, 0o700);
const write = (f, v) => fs.writeFileSync(f, typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v), { mode: 0o600 });
const sha = v => createHash('sha256').update(v).digest('hex');
Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${fixture}/synthetic.db`, PRIVATE_PROMPTS_FIXTURE_ROOT: fixture,
 PRIVATE_PROMPTS_POLICY_FILE: path.join(fixture, 'policy.json'), PRIVATE_PROMPTS_MIN_STATE: 'encrypted-required',
 PRIVATE_PROMPTS_CONSUMER_ID: 'fixture', PRIVATE_PROMPTS_RUNTIME_REVISION: 'a'.repeat(40), SESSION_SECRET: randomBytes(48).toString('hex') });
const policy = { schema: 'private-prompt-policy.v1', revision: 'fixture-policy', state: 'encrypted-required', minimumReader: 1,
 identities: [{ userId: 'author', tenant: 'tenant', subject: 'author-subject', administrator: true }],
 origins: [{ kind: 'image-module', id: 'default-author', ownerId: 'author' }], authorKinds: [{ ownerId: 'author', kinds: ['image-module', 'image-preset'] }],
 keys: Object.fromEntries(['body', 'index', 'backup'].map(domain => { const file = path.join(fixture, domain + '.key'); write(file, randomBytes(32)); return [domain, { active: domain, files: { [domain]: file } }]; })),
 destinations: [], consumers: ['fixture'], activation: { inventoryId: 'fixture-inventory', restoreId: 'fixture-restore', writerFenceId: 'fixture-fence', attestationFile: path.join(fixture, 'consumers.json') },
 migrationVerified: { inventoryId: 'fixture-inventory', restoreId: 'fixture-restore', remainingPlaintext: 0 } };
write(process.env.PRIVATE_PROMPTS_POLICY_FILE, policy);
write(policy.activation.attestationFile, { schema: 'private-prompt-consumers.v1', policyRevision: policy.revision,
 ...Object.fromEntries(['inventoryId', 'restoreId', 'writerFenceId'].map(k => [k, policy.activation[k]])), consumers: [{ id: 'fixture', reader: 1, permissionContract: 1, sourceRevision: 'a'.repeat(40) }] });
let actor, db, calls = 0;
const block = () => { calls++; throw new Error('Offline synthetic fixture forbids transport'); };
const originalFetch = globalThis.fetch; globalThis.fetch = block;
const cache = new Map();
function load(relative) {
 const file = path.resolve(root, relative); if (cache.has(file)) return cache.get(file).exports;
 if (file.endsWith('.json')) return requireAt(file);
 const m = { exports: {} }; cache.set(file, m);
 const req = id => {
  if (id === 'server-only') return {};
  if (id === '@/lib/prisma') return load('src/lib/prisma.ts');
  if (id === '@/lib/auth/session') return { getSession: async () => actor, AuthError: class extends Error {} };
  if (id.startsWith('@/') || id.startsWith('.')) {
   const base = id.startsWith('@/') ? path.join(root, 'src', id.slice(2)) : path.resolve(path.dirname(file), id);
   const found = [base, base + '.ts', base + '.tsx', base + '.js', path.join(base, 'index.ts')].find(f => fs.existsSync(f) && fs.statSync(f).isFile());
   if (!found) throw new Error('Missing source import ' + id); return load(path.relative(root, found));
  }
  return requireAt(id);
 };
 const src = fs.readFileSync(file, 'utf8');
 const compiled = ts.transpileModule(src, { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } }).outputText;
 new Function('require', 'module', 'exports', '__filename', '__dirname', 'fetch', compiled)(req, m, m.exports, file, path.dirname(file), block);
 return m.exports;
}
function find(node, predicate, acc = []) { if (predicate(node)) acc.push(node); ts.forEachChild(node, n => { find(n, predicate, acc); }); return acc; }
function evalExpression(expression, env) { const compiled = ts.transpileModule(`const _expression = (${expression});`, { fileName: 'expression.tsx', compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText; return new Function('scope', `with(scope){ ${compiled}; return _expression; }`)(env); }
function evalFunction(node, source, env) { const out = ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
 return new Function('scope', `with(scope){${out};return ${node.name.text};}`)(env); }
async function checkContextVersionHook() {
 const runtime = process.env.REQ01_RUNTIME_ROOT ? createRequire(path.join(process.env.REQ01_RUNTIME_ROOT, 'package.json')) : requireAt;
 const React = runtime('react'), Renderer = runtime('react-test-renderer');
 assert.equal(React.version, requireAt('react/package.json').version);
 assert.equal(runtime('react-test-renderer/package.json').version, React.version);
 const file = path.join(root, 'src/app/image-studio/context-version-label.tsx');
 const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
 const node = find(ast, n => ts.isFunctionDeclaration(n) && n.name?.text === 'useModuleContextVersion')[0];
 const timers = new Map(); let timerId = 0, reads = 0, current;
 const env = { exports: {}, useEffect: React.useEffect, useRef: React.useRef, useState: React.useState,
  setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id),
  fetch: async () => { reads++; return new Response(JSON.stringify({ code: reads === 1 ? 'AB123' : 'CD456', state: 'ready' })); } };
 const hook = evalFunction(node, ast, env), tick = () => new Promise(resolve => setImmediate(resolve));
 function Harness(props) { current = hook(props); return null; }
 const props = { moduleId: 'default-author', raw: '', taskId: null, editable: false, enabled: true, composing: false, sourceRevision: '1' };
 let renderer;
 try {
  await Renderer.act(async () => { renderer = Renderer.create(React.createElement(Harness, props)); await tick(); });
  const flush = async () => { const all = [...timers.values()]; timers.clear(); await Renderer.act(async () => { for (const callback of all) await callback(); await tick(); }); };
  await flush(); assert.equal(current.code, 'AB123');
  await Renderer.act(async () => { renderer.update(React.createElement(Harness, { ...props, sourceRevision: '2' })); await tick(); });
  assert.equal(current.code, null); await flush(); assert.equal(reads, 2); assert.equal(current.code, 'CD456');
  await Renderer.act(async () => { renderer.update(React.createElement(Harness, { ...props, taskId: 'frozen-task', sourceRevision: '2' })); await tick(); });
  await flush(); const historyReads = reads;
  await Renderer.act(async () => { renderer.update(React.createElement(Harness, { ...props, taskId: 'frozen-task', sourceRevision: '3' })); await tick(); });
  assert.equal(timers.size, 0); assert.equal(reads, historyReads);
 } finally { if (renderer) await Renderer.act(async () => renderer.unmount()); }
 return ['private_current_context_code_refreshes_on_confirmed_revision_with_real_react_effects', 'historical_context_code_stays_bound_to_the_frozen_task'];
}
async function main() {
 try {
  const setup = spawnSync(process.execPath, [requireAt.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')], { cwd: fixture, env: { NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8', timeout: 120000 });
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  globalThis.prismaSqlitePragmasStarted = true; db = load('src/lib/prisma.ts').prisma;
  await db.user.create({ data: { id: 'author', role: 'admin', account_type: 'internal', username: 'fixture-author', name: 'fixture', email: 'sharing-fixture@invalid.test', password_hash: 'not-a-login', feishu_tenant_key: 'tenant', feishu_open_id: 'author-subject' } });
  const identity = load('src/lib/security/private-prompt-identity.server.ts'); actor = { id: 'author', role: 'admin', account_type: 'internal' };
  const token = 'synthetic-session'; const signed = identity.signVerifiedFeishuIdentity({ userId: actor.id, role: actor.role, tenant: 'tenant', subject: 'author-subject' }, token);
  assert.equal(identity.authenticatePrivateIdentity(actor, signed, token), true);
  const crypto = load('src/lib/security/private-prompts.server.ts');
  const globalId = 'gpt_image_studio_v1';
  await db.platformSetting.create({ data: { key: globalId, updated_by: actor.id, value_json: JSON.stringify({ revision: 1, model: 'gpt-image-2', prices: {}, context: crypto.sealPrivatePrompt('synthetic global rule', { kind: 'image-global', id: globalId, field: 'context', origins: [crypto.privateOrigin('image-global', globalId)] }) }) } });
  const storage = load('src/lib/image-studio/private-storage.server.ts');
  const data = storage.writePrivateStudioDefinition('image-module', { id: 'default-author', owner_id: actor.id, name: 'private fixture', prompt: '', context: 'old synthetic context', revision: 0 });
  await db.imageStudioModule.create({ data });
  const contract = load('src/lib/image-studio/shared-contract.ts'), modules = load('src/lib/image-studio/modules.ts');
  const baselineDTO = await modules.studioModuleDTOForUser(actor, data.id);
  const baseline = await contract.readPrivateStudioEditor(actor, data.id);
  const saved = await contract.savePrivateStudioEditor(actor, data.id, { requestId: randomUUID(), revision: baseline.revision, sourceRevision: baseline.sourceRevision, prompt: '', context: 'new synthetic context' });
  assert.equal(saved.state, 'saved'); assert.equal(saved.revision, baseline.revision + 1);
  let stale;
  try { await modules.saveStudioModule(actor.id, { id: data.id, saveIntent: 'definition', revision: baseline.revision, requestId: randomUUID(), isShared: true, name: 'private fixture', count: 1, referenceIds: [], referencePolicy: { primaryIds: [], primaryMin: 0, primaryMax: 1, auxiliaryMax: 10, styleMax: 10, referenceMax: 10, useFixedReferences: true } }); }
  catch (error) { stale = error; }
  assert.equal(stale?.status, 409); assert.equal(stale?.conflictScope, 'workspace'); assert.equal(stale?.commandOutcome?.status, 'not-applied');
  const current = await contract.readPrivateStudioEditor(actor, data.id);
  assert.ok(crypto.isStoredPrivatePrompt((await db.imageStudioModule.findUniqueOrThrow({ where: { id: data.id } })).context), 'Private definition fixture must use the production encrypted storage format');
  const rejected = await contract.savePrivateStudioEditor(actor, data.id, { requestId: randomUUID(), revision: baseline.revision, sourceRevision: baseline.sourceRevision, prompt: '', context: 'competing synthetic context' });
  assert.equal(rejected.state, 'not-applied'); assert.equal(rejected.revision, undefined);
  const sourceFile = path.join(root, 'src/app/image-studio/studio.tsx'), source = ts.createSourceFile(sourceFile, fs.readFileSync(sourceFile, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const named = name => find(source, n => ts.isFunctionDeclaration(n) && n.name?.text === name)[0];
  const declaration = name => find(source, n => ts.isVariableDeclaration(n) && n.name.getText(source) === name)[0]?.initializer.getText(source);
  const tag = find(source, n => (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText(source) === 'PrivateDefinitionEditor')[0];
  const expression = tag.attributes.properties.find(n => n.name?.getText(source) === 'onSaved').initializer.expression.getText(source);
  function harness(initial, latest) {
    const state = { revision: initial.revision, conflict: false, review: null, moduleChanges: [], reads: [], error: '', busy: false,
      editing: { name: 'UNSAVED NAME', prompt: 'PERSONAL INPUT', primaryIds: ['CURRENT PRIMARY'], count: 7 } };
    const scope = { active: true }, env = { module: initial, sharedLive: initial.sharedLive, revisionRef: { current: initial.revision },
      fixedSaveUnknown: false, definitionReviewBusy: false, moduleSaving: false, moduleSaveRequest: { current: null }, fixedSaveScope: { current: scope }, definitionReadSequence: { current: 0 },
      definitionBaseline: { current: initial }, definitionBaselineFields: { current: null }, savedTemplatePrompt: { current: initial.templatePrompt || '' },
      MAX_REFERENCE_IMAGES: 10, DEFAULT_STUDIO_PRIMARY_MAX: 10,
      isClientSessionBlocked: () => false, onSharedRefresh: () => {},
      setModuleRevision: value => { state.revision = value; }, setDefinitionReviewBusy: value => { state.busy = value; },
      setDefinitionConflict: value => { state.conflict = value; }, setDefinitionReview: value => { state.review = value; },
      setModuleSaveError: value => { state.error = value; }, setSavedModuleContext: value => { state.savedContext = value; },
      onModuleChange: value => { state.moduleChanges.push(value); },
      fetch: async (url, options) => { state.reads.push({ url, method: options?.method || 'GET' });
        const result = typeof latest === 'function' ? await latest() : latest;
        if (result instanceof Error) throw result;
        return new Response(JSON.stringify({ modules: [result] }), { status: 200 }); },
    };
    env.fixedReferencePayload = evalExpression(declaration('fixedReferencePayload'), env);
    env.definitionFieldLabels = evalExpression(declaration('definitionFieldLabels'), env);
    for (const n of ['moduleReferencePolicy', 'readResponse', 'studioRepairModule', 'studioDefinitionFields']) env[n] = evalFunction(named(n), source, env);
    env.definitionBaselineFields.current = env.studioDefinitionFields(initial);
    for (const n of ['readLatestEditableModule', 'onPrivateDefinitionSaved', 'reviewLatestDefinition']) if (named(n)) env[n] = evalFunction(named(n), source, env);
    return { state, env, callback: evalExpression(expression, env), scope };
  }
  const checks = ['encrypted_private_save_advances_workspace_and_stale_publication_is_explicitly_not_applied'];
  const freshDTO = await modules.studioModuleDTOForUser(actor, data.id);
  const client = harness(baselineDTO, freshDTO), inputBefore = structuredClone(client.state.editing);
  await client.callback(saved.revision);
  assert.equal(client.env.revisionRef.current, saved.revision, 'Private acknowledgement must reach outer revision before sharing');
  assert.equal(client.state.revision, saved.revision); assert.equal(client.state.conflict, false); assert.equal(client.state.error, '');
  assert.equal(client.state.moduleChanges.length, 1); assert.deepEqual(client.state.editing, inputBefore);
  assert.ok(client.state.reads.length && client.state.reads.every(r => r.method === 'GET'));
  checks.push('private_save_refreshes_unpublished_workspace_without_replacing_personal_input_or_primary');
  const request = { id: data.id, saveIntent: 'definition', revision: client.env.revisionRef.current, requestId: randomUUID(), isShared: true,
    name: 'private fixture', count: 1, referenceIds: [], referencePolicy: { primaryIds: [], primaryMin: 0, primaryMax: 1, auxiliaryMax: 10, styleMax: 10, referenceMax: 10, useFixedReferences: true } };
  const published = await modules.saveStudioModule(actor.id, request);
  assert.equal(published.sourcePresetShared, true); assert.equal(published.sharedLive.mode, 'publisher');
  assert.equal(published.sourcePresetId, 'module-source:' + data.id); assert.equal(await db.imageStudioPreset.count(), 1);
  assert.equal((await modules.saveStudioModule(actor.id, request)).revision, published.revision);
  checks.push('first_publication_after_private_save_succeeds_and_same_request_replays_once');
  const publisherBase = await contract.readPrivateStudioEditor(actor, data.id);
  const updated = await contract.savePrivateStudioEditor(actor, data.id, { requestId: randomUUID(), revision: publisherBase.revision,
    sourceRevision: publisherBase.sourceRevision, prompt: '', context: 'publisher new synthetic context' });
  assert.equal(updated.state, 'saved');
  const updatedDTO = await modules.studioModuleDTOForUser(actor, data.id);
  assert.notEqual(updatedDTO.sharedLive.intent.definitionToken, published.sharedLive.intent.definitionToken);
  assert.equal(updated.sourceRevision, updatedDTO.sharedLive.intent.definitionToken);
  assert.equal((await contract.privateStudioEditorStatus(actor, data.id, updated.requestId, false)).sourceRevision, updated.sourceRevision);
  const publisher = harness(published, updatedDTO); await publisher.callback(updated.revision);
  assert.equal(publisher.env.definitionBaseline.current.sharedLive.intent.definitionToken, updatedDTO.sharedLive.intent.definitionToken);
  assert.equal(publisher.state.conflict, false); assert.equal(publisher.env.revisionRef.current, updated.revision);
  const continued = await modules.saveStudioModule(actor.id, { ...request, requestId: randomUUID(), revision: publisher.env.revisionRef.current,
    sharedLive: publisher.env.definitionBaseline.current.sharedLive.intent });
  assert.ok(continued.revision > updated.revision); assert.equal(await db.imageStudioPreset.count(), 1);
  checks.push('published_private_save_refreshes_source_token_before_next_definition_save');
  const pfile = path.join(root, 'src/app/image-studio/PrivateDefinitionEditor.tsx'), ps = ts.createSourceFile(pfile, fs.readFileSync(pfile, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const accept = find(ps, n => ts.isFunctionDeclaration(n) && n.name?.text === 'acceptSave')[0];
  function receiptCase(result, originalId) {
    const resultState = { retained: true, conflict: false, notified: 0 };
    const accepted = evalFunction(accept, ps, { retain: () => { resultState.retained = false; }, setConflict: v => { resultState.conflict = v; }, setNotice: () => {},
      submitted: { current: { save: { requestId: originalId, editVersion: 0 } } }, editVersion: { current: 0 }, clear: () => {}, live: { current: { onSaved: () => { resultState.notified++; } } } })(result, originalId);
    return { accepted, ...resultState };
  }
  assert.deepEqual(receiptCase(rejected, rejected.requestId), { accepted: true, retained: false, conflict: true, notified: 0 });
  for (const value of [{ state: 'unknown', requestId: rejected.requestId }, { ...rejected, requestId: randomUUID() }, { state: 'saved', requestId: rejected.requestId }]) {
    assert.deepEqual(receiptCase(value, rejected.requestId), { accepted: false, retained: true, conflict: false, notified: 0 });
  }
  checks.push('durable_not_applied_releases_only_its_original_pending_operation_without_a_revision');
  checks.push('unknown_mismatched_and_incomplete_saved_receipts_remain_pending');
  function continuationCase(result, sourceRevision) {
    const loaded = { revision: result.revision - 1, sourceRevision, prompt: '', context: 'before' };
    const later = { prompt: '', context: 'NEW INPUT AFTER SENDING' };
    const state = { current: { loaded, draft: null, values: later } }; let conflict = false;
    const sent = { requestId: result.requestId, editVersion: 0, values: { prompt: '', context: 'confirmed saved input' } };
    const accepted = evalFunction(accept, ps, { retain: () => {}, setConflict: v => { conflict = v; }, setNotice: () => {},
      submitted: { current: { save: sent } }, editVersion: { current: 1 }, state, setLoaded: () => {}, setDraft: () => {},
      live: { current: { onSaved: () => {} } } })(result, result.requestId);
    assert.equal(accepted, true); assert.deepEqual(state.current.values, later);
    return { sourceRevision: state.current.loaded.sourceRevision, conflict };
  }
  assert.deepEqual(continuationCase(updated, publisherBase.sourceRevision), { sourceRevision: updated.sourceRevision, conflict: false });
  const legacyReceipt = { ...updated }; delete legacyReceipt.sourceRevision;
  assert.deepEqual(continuationCase(legacyReceipt, publisherBase.sourceRevision), { sourceRevision: publisherBase.sourceRevision, conflict: true });
  assert.deepEqual(continuationCase(legacyReceipt, String(updated.revision - 1)), { sourceRevision: String(updated.revision), conflict: false });
  checks.push('typing_during_private_save_keeps_new_input_and_uses_confirmed_source_token');
  checks.push('old_receipts_require_readback_for_source_tokens_and_keep_numeric_global_compatibility');

  const race = harness(baselineDTO, { ...freshDTO, revision: freshDTO.revision + 1, name: 'another saved name' });
  await race.callback(saved.revision); assert.equal(race.state.conflict, true); assert.ok(race.state.review);
  assert.deepEqual(race.state.editing, inputBefore); assert.equal(race.env.definitionBaseline.current.revision, baselineDTO.revision);
  checks.push('other_definition_changes_require_review_and_never_silently_overwrite_current_draft');
  const review = harness(baselineDTO, freshDTO); await review.env.reviewLatestDefinition();
  assert.equal(review.state.review.id, data.id); assert.equal(review.state.busy, false);
  assert.ok(review.state.reads.every(r => r.method === 'GET'));
  checks.push('unpublished_workspace_conflict_has_a_fresh_read_review_path');
  let resolveLate;
  const delayed = harness(baselineDTO, () => new Promise(resolve => { resolveLate = resolve; }));
  const waiting = delayed.callback(saved.revision); delayed.env.fixedSaveScope.current = { active: true }; resolveLate(freshDTO); await waiting;
  assert.equal(delayed.state.moduleChanges.length, 0); assert.equal(delayed.env.definitionBaseline.current.revision, baselineDTO.revision);
  checks.push('late_metadata_from_an_old_editor_scope_cannot_replace_current_module');
  const completions = [], overlap = harness(baselineDTO, () => new Promise(resolve => completions.push(resolve)));
  const firstRead = overlap.callback(saved.revision), secondRead = overlap.callback(saved.revision + 1);
  completions[1]({ ...freshDTO, revision: saved.revision + 1 }); await secondRead;
  completions[0](freshDTO); await firstRead;
  assert.equal(overlap.env.definitionBaseline.current.revision, saved.revision + 1);
  assert.equal(overlap.state.error, ''); assert.equal(overlap.state.busy, false);
  checks.push('older_metadata_cannot_override_a_later_confirmed_save_in_the_same_editor');

  const unavailable = harness(baselineDTO, new Error('offline fixture')); await unavailable.callback(saved.revision);
  assert.equal(unavailable.state.conflict, true); assert.equal(unavailable.env.definitionBaseline.current.revision, baselineDTO.revision);
  assert.deepEqual(unavailable.state.editing, inputBefore);
  checks.push('metadata_failure_keeps_confirmed_revision_and_current_draft_for_read_only_recovery');
  const unauthorized = harness(published, { ...updatedDTO, sourcePresetOwnedByViewer: false });
  await unauthorized.callback(updated.revision); assert.equal(unauthorized.state.conflict, true); assert.equal(unauthorized.state.moduleChanges.length, 0);
  checks.push('fresh_projection_cannot_adopt_another_author_source_even_for_an_admin');
  const pending = harness(baselineDTO, freshDTO); pending.env.moduleSaveRequest.current = { unknown: true }; await pending.callback(saved.revision);
  assert.equal(pending.env.moduleSaveRequest.current.unknown, true); assert.equal(pending.state.reads.length, 0); assert.equal(pending.state.moduleChanges.length, 0);
  checks.push('an_unresolved_original_definition_save_is_not_replaced_or_replayed');
  checks.push(...await checkContextVersionHook());
  assert.equal(await db.imageStudioTask.count(), 0); assert.equal(await db.creditLedger.count(), 0); assert.equal(calls, 0);
  console.log(JSON.stringify({ schema: 'template-sharing-version-engineering.v1', passed: true, checks, sourceSha256: Object.fromEntries([
    'src/app/image-studio/studio.tsx', 'src/app/image-studio/PrivateDefinitionEditor.tsx', 'src/app/image-studio/context-version-label.tsx', 'src/lib/image-studio/shared-contract.ts', 'src/lib/image-studio/modules.ts'
  ].map(n => [n, sha(fs.readFileSync(path.join(root,n)))])), productionWrites: 0, paidRequests: 0, browserRuns: 0, networkCalls: calls }, null, 2));
 } finally { globalThis.fetch = originalFetch; if (db) await db.$disconnect(); fs.rmSync(fixture, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
