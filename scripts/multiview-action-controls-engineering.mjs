import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

// Exercise the real HTTP decoder with recorded response shapes, without credentials or network.
const root = path.resolve(process.argv[2] || process.cwd());
const require = createRequire(import.meta.url);
const ts = require(process.argv[3] || path.join(root, 'node_modules/typescript'));
const source = fs.readFileSync(path.join(root, 'src/lib/integrations/musk.ts'), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
const privatePrompts = { isPrivatePromptError: () => false, isStoredPrivatePrompt: () => false, PrivatePromptError: class extends Error {} };
const context = vm.createContext({ module, exports: module.exports, AbortController, Response, Buffer, URL, setTimeout, clearTimeout,
  console: { error() {} }, fetch() { throw new Error('Real fetch is forbidden'); },
  require(name) {
    if (name === 'node:timers/promises') return require(name);
    if (name === '@/lib/prisma') return { prisma: new Proxy({}, { get() { throw new Error('Database access is forbidden'); } }) };
    if (name === '@/lib/security/private-prompts.server') return privatePrompts;
    if (name === '@/lib/security/private-credentials.server') return {};
    if (name === '@/lib/security/private-prompt-send.server') return { privateCredentialSendOrigins: origins => origins || [] };
    throw new Error('Unexpected import: ' + name);
  },
});
vm.runInContext(javascript, context, { filename: 'musk.ts' });
const musk = module.exports;
const settings = { enabled: true, base_url: 'https://fixture.invalid', default_model: 'gpt-5.5', api_key: 'fixture-not-a-credential', allowed_models: [] };
const checks = [];
async function rejection(name, body, status, code, expectedCalls, stream = false) {
  let calls = 0;
  const parameters = { settings, messages: [{ role: 'user', content: 'fixture' }], retryDelayMs: 0,
    fetchImpl: async () => { calls++; return new Response(body, { status }); } };
  let error;
  try { await (stream ? musk.openMuskChatStream(parameters) : musk.createMuskChatCompletion(parameters)); } catch (cause) { error = cause; }
  assert.ok(error instanceof musk.MuskApiError, name);
  assert.equal(error.code, code, name); assert.equal(error.status, status, name); assert.equal(calls, expectedCalls, name);
  checks.push(name);
}
const unavailable = 'No available channel for model gpt-5.5 under group fixture (distributor) (request id: fixture)';
await rejection('recorded plain no-channel 503 is definite, one attempt', unavailable, 503, 'musk_api_model_unavailable', 1);
await rejection('JSON no-channel 503 is definite, one attempt', JSON.stringify({ error: { message: unavailable } }), 503, 'musk_api_model_unavailable', 1);
await rejection('generic 503 retains existing uncertainty and retry', 'Service temporarily unavailable', 503, 'musk_api_upstream_error', 2);
await rejection('model text alone does not turn generic 503 into rejection', 'An error occurred while processing model gpt-5.5', 503, 'musk_api_upstream_error', 2);
await rejection('generic 504 remains unknown', 'Gateway timeout', 504, 'musk_api_upstream_error', 2);
await rejection('404 remains an ordinary client rejection', 'Model not found', 404, 'musk_api_upstream_error', 1);
await rejection('stream no-channel rejection also avoids retry', unavailable, 503, 'musk_api_model_unavailable', 1, true);
await rejection('stream generic 503 keeps original retry', 'Service unavailable', 503, 'musk_api_upstream_error', 2, true);
let calls = 0;
const success = await musk.createMuskChatCompletion({ settings, messages: [], fetchImpl: async () => {
  calls++; return Response.json({ choices: [{ message: { content: '{"prompt":"fixture"}' } }], model: 'gpt-6.1-sol', usage: { total_tokens: 1 } });
} });
assert.equal(calls, 1); assert.equal(success.model, 'gpt-6.1-sol'); assert.equal(success.content, '{"prompt":"fixture"}');
checks.push('successful response content and actual model remain intact');
const catalog = ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-image-1', 'unrelated-model'];
assert.deepEqual(Array.from(await musk.resolveMuskChatModels(settings, catalog)), ['gpt-6.1-sol', 'gpt-6-luna']);
assert.deepEqual(Array.from(await musk.resolveMuskChatModels({ ...settings, allowed_models: ['gpt-6-luna'] }, catalog)), ['gpt-6-luna']);
checks.push('current catalog accepts new GPT text IDs, excludes image and delisted default, honors explicit whitelist');

// Run the component's actual request handlers with state adapters; React layout stays manual.
const actionSource = fs.readFileSync(path.join(root, 'src/app/multiview/MultiviewActionPanel.tsx'), 'utf8');
const ast = ts.createSourceFile('action.tsx', actionSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlers = [];
function collect(node) {
  if (ts.isFunctionDeclaration(node) && ['rememberModel', 'keepAiJournal', 'consumeAi', 'organize', 'queryAi'].includes(node.name?.text)) handlers.push(node.getText(ast));
  ts.forEachChild(node, collect);
}
collect(ast); assert.equal(handlers.length, 5);
const handlerCode = ts.transpileModule(handlers.join('\n') + '\nglobalThis.handlers={organize,consumeAi,queryAi,rememberModel};', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const original = { requestId: 'original-request', runId: 'original-run', model: 'gpt-5.5', status: 'uncertain', edit: -1 };
function actionHarness(journal, result, error) {
  const calls = [], storage = new Map(), writes = [], suggestions = [];
  const env = { aiLock: { current: false }, aiPending: journal.current, aiJournalRef: { current: journal },
    state: { capabilities: { llmEnabled: true } }, llmReady: true, text: '保留人工动作', llmModel: 'gpt-6.1-sol', aiKey: 'owner:work', modelKey: 'owner:model',
    input: { current: { text: '保留人工动作' } }, editRevision: { current: 4 }, aiPoll: { current: { key: '', count: 0 } },
    finished: new Set(['succeeded', 'failed', 'cancelled']), crypto: { randomUUID: () => 'new-request' },
    confirm: async () => true, saveDraft: async () => ({ id: 'draft', revision: 1 }), active: () => true,
    setLlmModel() {}, setModelMessage() {}, setAiBusy() {}, setMessage() {}, setAiJournal() {}, setState(update) { update({ runs: [] }); },
    setBeforeAi() {}, setAppliedRunId() {}, setText(value) { writes.push(value); }, setSuggestion(value) { suggestions.push(value); },
    localStorage: { setItem(key, value) { storage.set(key, key === 'owner:model' ? value : JSON.parse(value)); } },
    api: async (url, body) => { calls.push({ url, body }); if (error) throw error; return { run: result }; },
  };
  vm.runInNewContext(handlerCode, env);
  return { env, calls, storage, writes, suggestions };
}
const queued = { id: 'new-run', status: 'queued', llmModel: 'gpt-6.1-sol', tasks: [] };
let action = actionHarness({ current: { ...original }, retained: [] }, queued);
await action.env.handlers.organize();
assert.equal(action.calls.length, 1); assert.equal(action.calls[0].body.requestId, 'new-request');
assert.equal(action.env.aiJournalRef.current.current.runId, 'new-run'); assert.equal(action.env.aiJournalRef.current.retained[0].requestId, original.requestId);
assert.equal(action.storage.get('owner:work').retained[0].runId, original.runId);
checks.push('deliberate new organization retains the original unknown receipt atomically and never resends it');
action = actionHarness({ current: { ...original }, retained: [] }, null, { result: { details: { notAccepted: true } } });
await action.env.handlers.organize();
assert.equal(action.env.aiJournalRef.current.current, null); assert.equal(action.env.aiJournalRef.current.retained[0].requestId, original.requestId); assert.equal(action.writes.length, 0);
checks.push('explicit pre-admission rejection releases only the new pointer and preserves original text and unknown receipt');
action = actionHarness({ current: { ...original }, retained: [] }, null, new Error('network timeout'));
await action.env.handlers.organize();
assert.equal(action.env.aiJournalRef.current.current.requestId, 'new-request'); assert.equal(action.env.aiJournalRef.current.retained.length, 1); assert.equal(action.calls.length, 1);
checks.push('transport uncertainty retains both receipts without retrying or silently unlocking');
action = actionHarness({ current: { ...original }, retained: [] }, null);
await action.env.handlers.queryAi();
assert.equal(action.calls[0].url, '/api/video/multiview/actions/runs/original-run'); assert.equal(action.env.aiJournalRef.current.current.requestId, original.requestId);
checks.push('an empty original-request query never clears or replaces its original identity');
const newPending = { requestId: 'new-request', runId: 'new-run', edit: 4, status: 'running' };
action = actionHarness({ current: { ...newPending }, retained: [{ ...original }] });
action.env.handlers.consumeAi({ id: original.runId, status: 'succeeded', text: 'late old result', tasks: [] }, original);
assert.equal(action.env.aiJournalRef.current.current.requestId, newPending.requestId); assert.equal(action.env.aiJournalRef.current.retained.length, 0); assert.equal(action.writes.length, 0); assert.equal(action.suggestions.length, 1);
checks.push('a late retained result offers a version and cannot clear a newer request or overwrite current text');
action = actionHarness({ current: { ...newPending }, retained: [] });
action.env.handlers.consumeAi({ id: newPending.runId, status: 'failed', error: 'no channel', tasks: [] }, newPending);
assert.equal(action.env.aiJournalRef.current.current, null); assert.equal(action.writes.length, 0);
checks.push('a definite failed run stops blocking organization while preserving hand-written action');
action = actionHarness({ current: { ...newPending, edit: 3 }, retained: [] });
action.env.handlers.consumeAi({ id: newPending.runId, status: 'succeeded', text: 'older result', tasks: [] }, { ...newPending, edit: 3 });
assert.equal(action.writes.length, 0); assert.equal(action.suggestions.length, 1);
checks.push('manual edits made during organization are not overwritten by the completed result');
action = actionHarness({ current: null, retained: [] }, queued);
let releaseDraft;
action.env.saveDraft = () => new Promise(resolve => { releaseDraft = resolve; });
const organizing = action.env.handlers.organize();
action.env.handlers.rememberModel('gpt-6-luna');
releaseDraft({ id: 'draft', revision: 1 });
await organizing;
assert.equal(action.calls[0].body.llmModel, 'gpt-6.1-sol');
assert.equal(action.storage.get('owner:model'), 'gpt-6-luna');
checks.push('a model chosen during draft saving remains the next preference while the submitted model stays frozen');
console.log(JSON.stringify({ passed: true, checks, isolation: { realFetches: 0, realGeneration: 0, browserRuns: 0, productionWrites: 0, productionDatabaseOpened: false } }));
