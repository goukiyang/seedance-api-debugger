'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = process.cwd();
const source = ts.createSourceFile('EnhanceVideoAction.tsx', fs.readFileSync(path.join(root, 'src/components/EnhanceVideoAction.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let submit;
function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'handleSubmit') submit = node.initializer.getText(source); ts.forEachChild(node, visit); }
visit(source); assert.ok(submit);
const hook = ts.createSourceFile('hook.ts', fs.readFileSync(path.join(root, 'src/lib/hooks/use-creation-context.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const resolved = hook.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'isResolvedCreationIntent');
const code = ts.transpileModule(resolved.getText(hook).replace(/^export /, '') + '\nglobalThis.submit = (' + submit + ');', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const sourceId = 'fixture-source', actor = 'fixture-actor';
const baseKey = 'asset-enhance:' + sourceId + ':1080p:source_fps';
const closed = { state: 'rejected', intent: null, rejection: { code: 'creation_preparation_closed', submitted: false, acceptedCount: 0 } };
const checks = [];
function harness(options = {}) {
 const store = new Map(options.storage || []), states = new Map([[baseKey, options.original || closed]]);
 const requests = [], prepared = [], errors = [], routes = []; let uuids = 0, current = true, lost = Boolean(options.loseCreate);
 const creation = { isCurrent: () => current,
  prepare: async (body, key) => { prepared.push({ body, key }); const original = states.get(key);
   if (options.retainedUnknown) throw new Error('Original preparation remains unconfirmed');
   if (original?.state === 'rejected') throw new Error('Original operation is sealed with different content');
   if (original?.intent) return original.intent;
   return { id: 'fixture-intent', revision: 1, request_id: key, state: 'ready', availability: { canSubmit: true } };
  }, acceptTask: async () => {} };
 const sandbox = { disabledReason: '', submitting: false, setSubmitting() {}, setMessage() {}, setError: value => errors.push(value),
  fps: 'none', resolution: '1080p', toolVersion: 'standard', requestOrigin: 'asset', returnTo: '/assets', destination: 'fixture-project',
  task: { id: sourceId, duration: 15, video_card_id: null }, pricing: { actorId: actor, quote: { pricing_revision: 'fixture-price' }, refresh() {} },
  sessionStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) },
  crypto: { randomUUID: () => { uuids++; return 'fixture-request-' + uuids; } }, creation,
  router: { push: value => routes.push(value) }, taskDetailHref: id => '/tasks/' + id,
  fetch: async (url, init = {}) => {
   requests.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
   if (url.startsWith('/api/tasks/request-status?')) return { ok: true, json: async () => ({ task: options.acceptedPending ? { id: 'original-task' } : null }) };
   if (url.startsWith('/api/video/creation-intents?')) { if (options.stale) current = false;
    return { ok: !options.readFailure, json: async () => states.get(new URL(url, 'https://fixture.invalid').searchParams.get('request_id')) || { state: 'unconfirmed', intent: null } }; }
   assert.equal(url, '/api/tasks/enhance-video/create'); const body = JSON.parse(init.body);
   states.set(body.idempotency_key, { state: 'accepted', intent: { id: 'fixture-intent', request_id: body.idempotency_key, state: 'accepted', accepted_task_id: 'created-task' } });
   if (lost) { lost = false; throw new Error('Synthetic lost response'); }
   return { ok: true, json: async () => ({ id: 'created-task' }) };
  } };
 vm.runInNewContext(code, sandbox, { filename: 'actual-enhance-submit' });
 return { run: () => sandbox.submit(), store, states, prepared, errors, routes, requests,
  get uuids() { return uuids; }, get creates() { return requests.filter(r => r.url === '/api/tasks/enhance-video/create'); } };
}
(async () => {
 const first = harness(); await first.run(); assert.equal(first.creates.length, 1, 'A proven closed preparation must permit this explicit fresh submission');
 assert.notEqual(first.prepared[0].key, baseKey); assert.equal(first.prepared[0].body.source_task_id, sourceId); assert.equal(first.prepared[0].body.duration, 15);
 assert.equal(first.states.get(baseKey), closed); const alias = first.store.get('sd2-enhance-preparation:' + actor + ':' + baseKey); assert.ok(alias);
 await first.run(); assert.equal(first.creates.length, 1); assert.equal(first.uuids, 1); checks.push('closed_zero_admission_uses_persisted_new_preparation_once_and_keeps_old_receipt');
 for (const state of ['accepted', 'batch_active']) { const h = harness({ original: { state, intent: { request_id: baseKey, state, accepted_task_id: 'original-task' } } }); await h.run(); assert.equal(h.creates.length, 0); assert.equal(h.uuids, 0); assert.equal(h.prepared[0].key, baseKey); }
 checks.push('accepted_originals_keep_legacy_business_key_and_never_create_again');
 const pendingKey = 'sd2-enhance-acceptance:' + actor + ':' + baseKey;
 for (const acceptedPending of [false, true]) { const h = harness({ storage: [[pendingKey, baseKey]], acceptedPending }); await h.run(); assert.equal(h.prepared.length, 0); assert.equal(h.creates.length, 0); assert.equal(h.uuids, 0); assert.equal(h.requests.length, 1); if (!acceptedPending) assert.equal(h.store.get(pendingKey), baseKey); }
 checks.push('unknown_acceptance_only_queries_original_and_keeps_its_identity');
 const unknown = harness({ original: { state: 'unconfirmed', intent: null }, retainedUnknown: true }); await unknown.run(); assert.equal(unknown.uuids, 0); assert.equal(unknown.creates.length, 0); assert.equal(unknown.prepared[0].key, baseKey);
 checks.push('unknown_preparation_never_rotates_or_submits_a_replacement');
 for (const change of [{ acceptedCount: 1 }, { submitted: true }, { code: 'other' }]) { const h = harness({ original: { ...closed, rejection: { ...closed.rejection, ...change } } }); await h.run(); assert.equal(h.uuids, 0); assert.equal(h.creates.length, 0); }
 for (const flag of ['readFailure', 'stale']) { const h = harness({ [flag]: true }); await h.run(); assert.equal(h.uuids, 0); assert.equal(h.prepared.length, 0); assert.equal(h.creates.length, 0); }
 checks.push('malformed_closure_failed_read_and_changed_scope_do_not_release_a_request');
 const intentClosed = harness({ original: { state: 'closed', intent: { state: 'closed', request_id: baseKey, accepted_task_id: null, batch_id: null } } }); await intentClosed.run(); assert.equal(intentClosed.creates.length, 1);
 const lost = harness({ loseCreate: true }); await lost.run(); const retained = [...lost.store].filter(([key]) => key.startsWith('sd2-enhance-acceptance:')); assert.equal(retained.length, 1); await lost.run(); assert.equal(lost.creates.length, 1); assert.equal(lost.uuids, 1); assert.equal(lost.store.get(retained[0][0]), retained[0][1]);
 checks.push('closed_intent_can_continue_but_lost_new_acceptance_stays_on_the_same_request');
 console.log(JSON.stringify({ task: 'ENHANCE-CLOSED01', checks, productionWrites: 0, paidRequests: 0, browserAcceptance: false }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
