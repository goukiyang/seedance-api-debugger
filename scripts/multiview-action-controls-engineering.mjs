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
console.log(JSON.stringify({ passed: true, checks, isolation: { realFetches: 0, realGeneration: 0, browserRuns: 0, productionWrites: 0, productionDatabaseOpened: false } }));
