import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';
import { fusionAssistant } from '../src/lib/character-fusion/assistant.ts';
import { parseModelAccessSettings, supplementaryModelEnabled } from '../src/lib/pricing/model-availability-contract.ts';

const originalFetch = globalThis.fetch;
const captured = [];
try {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/llm/chat');
    captured.push({ body: JSON.parse(init.body), signal: init.signal });
    return Response.json({ content: '{"draft":"offline"}' });
  };
  const controller = new AbortController();
  await fusionAssistant('system', [{ role: 'user', content: 'draft' }], controller.signal, 'selected-model');
  assert.equal(captured[0].body.model, 'selected-model');
  assert.equal(captured[0].signal, controller.signal);
  assert.deepEqual(captured[0].body.messages, [{ role: 'system', content: 'system' }, { role: 'user', content: 'draft' }]);
  await fusionAssistant('system', [{ role: 'user', content: 'draft' }]);
  assert.equal(Object.hasOwn(captured[1].body, 'model'), false, 'Existing callers still follow the server default');
} finally { globalThis.fetch = originalFetch; }

function loadModule(file, mocks, globals = {}) {
  const source = fs.readFileSync(path.resolve(file), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, console, URL, AbortController, Response, Buffer, setTimeout, clearTimeout,
    require: name => { assert.ok(Object.hasOwn(mocks, name), name); return mocks[name]; }, ...globals });
  return exports;
}
// The real 1395 directory shape that the mocked resolver in the original test missed.
const chatIds = ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra',
  'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-terra'];
const rawIds = [...chatIds, 'gpt-image-2', 'gpt-image-2-ds', 'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst', 'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'];
const access = parseModelAccessSettings(null);
access.models = [{ kind: 'text', model: 'gpt-6.1-terra', enabled: false }];
const settings = { enabled: true, base_url: 'https://catalog.invalid/', api_key: 'offline-only',
  default_model: 'gpt-5.5', allowed_models: [] };
const prisma = { platformSetting: { findUnique: async ({ where }) => {
  if (where.key === 'musk_api_v1') return { value_json: JSON.stringify(settings) };
  if (where.key === 'pricing_model_access_v1') return { value_json: JSON.stringify(access) };
  assert.fail(where.key);
} } };
let metadataCalls = 0, inTransaction = false, upstreamData = { data: rawIds.map(id => ({ id })) }, httpStatus = 200;
class PrivatePromptError extends Error {}
let approvedModels = [...chatIds];
const privatePolicy = {
  PrivatePromptError, isPrivatePromptError: error => error instanceof PrivatePromptError,
  isStoredPrivatePrompt: () => false, privateOrigin: (kind, id) => ({ kind, id, ownerId: 'offline-admin' }),
  assertPrivateOrigins: () => {}, privatePromptIndex: () => 'offline-credential-binding',
  privatePromptPolicy: () => ({ destinations: [{ endpoint: 'https://catalog.invalid/v1/chat/completions',
    provider: 'musk', credentialVersion: 'offline-credential-binding', models: approvedModels }] }),
};
const send = loadModule('src/lib/security/private-prompt-send.server.ts',
  { 'server-only': {}, './private-prompts.server': privatePolicy });
const musk = loadModule(process.argv[2] || 'src/lib/integrations/musk.ts', {
  'node:timers/promises': { setTimeout: async () => assert.fail('No generation retry') },
  '@/lib/prisma': { prisma },
  '@/lib/security/private-credentials.server': { readPrivateCredential: value => value },
  '@/lib/security/private-prompts.server': privatePolicy,
  '@/lib/security/private-prompt-send.server': send,
}, { fetch: async (url, init) => {
  assert.equal(inTransaction, false, 'Provider metadata must never hold the fee writer transaction');
  assert.equal(url, 'https://catalog.invalid/v1/models');
  assert.equal(init.cache, 'no-store');
  metadataCalls++;
  return Response.json(upstreamData, { status: httpStatus });
} });
assert.deepEqual([...await musk.resolveMuskChatModels(await musk.getMuskApiSettings())], chatIds);
approvedModels = chatIds.slice(0, -1);
assert.deepEqual([...await musk.resolveMuskChatModels(settings, rawIds)], chatIds.slice(0, -1),
  'A discovered model must not appear callable before its existing outbound binding allows it');
approvedModels = [...chatIds];
assert.deepEqual([...await musk.resolveMuskChatModels(settings, [])], [], 'An empty real catalog must not reinsert the retired default');
assert.deepEqual([...await musk.resolveMuskChatModels(settings, null)], [], 'An unknown automatic catalog must not invent the default');
assert.deepEqual([...await musk.resolveMuskChatModels({ ...settings, allowed_models: ['gpt-6.1-sol', 'removed-model'] }, rawIds)],
  ['gpt-6.1-sol'], 'Explicit allowlist still restricts the real catalog');
assert.deepEqual([...await musk.resolveMuskChatModels({ ...settings, default_model: 'gpt-6-sol', allowed_models: ['gpt-6.1-sol'] }, rawIds)],
  ['gpt-6-sol', 'gpt-6.1-sol'], 'An actually present default keeps the existing implicit permission');

class AuthError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
let signedIn = true;
const auth = { AuthError, getSession: async () => signedIn ? { id: 'actor' } : null };
const next = { NextResponse: { json: (body, init) => Response.json(body, init) } };
const route = loadModule('src/app/api/llm/models/route.ts', {
  'next/server': next, '@/lib/auth/session': auth, '@/lib/integrations/musk': musk,
  '@/lib/pricing/model-access.server': { readModelAccessSettings: async () => access },
  '@/lib/pricing/model-availability-contract': { supplementaryModelEnabled },
});
const request = refresh => ({ nextUrl: new URL('https://sd2.invalid/api/llm/models' + (refresh ? '?refresh=1' : '')) });
let response = await route.GET(request(false));
assert.equal(response.status, 200);
let result = await response.json();
assert.deepEqual(result.models.map(model => model.id), chatIds.slice(0, -1));
assert.equal(result.default, '', 'The retired default is not advertised');
const beforeRefresh = metadataCalls;
response = await route.GET(request(true));
assert.equal(response.status, 200);
assert.equal(metadataCalls, beforeRefresh + 1, 'Refresh really reads upstream once');
assert.deepEqual((await response.json()).models.map(model => model.id), chatIds.slice(0, -1));
httpStatus = 503;
assert.equal((await route.GET(request(true))).status, 502);
httpStatus = 200; upstreamData = { error: 'HTTP 200 without a directory is not a successful refresh' };
assert.equal((await route.GET(request(true))).status, 502);
signedIn = false;
const beforeAuth = metadataCalls;
assert.equal((await route.GET(request(true))).status, 401);
assert.equal(metadataCalls, beforeAuth);
signedIn = true; upstreamData = { data: rawIds.map(id => ({ id })) };
await musk.fetchMuskUpstreamModels(settings, { force: true });

let generatedRequests = 0, preparedMessages = 0;
const noGeneration = () => { generatedRequests++; assert.fail('Generation is outside this test'); };
const chat = loadModule('src/app/api/llm/chat/route.ts', {
  'next/server': next, '@/lib/auth/session': auth,
  '@/lib/integrations/musk': { ...musk, createMuskChatCompletion: noGeneration, openMuskChatStream: noGeneration },
  '@/lib/integrations/musk-chat-images': { MuskChatImageError: class extends Error {},
    prepareMuskChatMessages: () => { preparedMessages++; assert.fail('No input processing before admission'); } },
  '@/lib/pricing/model-access.server': { assertSupplementaryModelEnabled: async (_kind, model) => {
    if (!supplementaryModelEnabled(access, 'text', model)) throw new AuthError('Closed by fee switch', 403);
  } },
});
const chatRequest = model => ({ json: async () => ({ model, messages: [{ role: 'user', content: 'Offline admission check' }] }) });
assert.equal((await chat.POST(chatRequest('gpt-5.5'))).status, 400, 'Explicit retired default must not bypass current catalog admission');
assert.equal((await chat.POST(chatRequest('gpt-6.1-terra'))).status, 403, 'Current model still obeys the fee switch');
assert.equal(generatedRequests, 0); assert.equal(preparedMessages, 0);
let capturedProviderPayloads = 0;
await musk.createMuskChatCompletion({ settings, model: 'gpt-6.1-sol', jsonMode: false,
  messages: [{ role: 'user', content: 'Offline payload capture' }],
  fetchImpl: async (url, init) => {
    assert.equal(url, 'https://catalog.invalid/v1/chat/completions');
    assert.equal(JSON.parse(init.body).model, 'gpt-6.1-sol');
    capturedProviderPayloads++;
    return Response.json({ model: 'gpt-6.1-sol', choices: [{ message: { content: 'offline' } }] });
  } });
assert.equal(capturedProviderPayloads, 1);

const pricing = loadModule('src/lib/pricing/model-access.server.ts', {
  'server-only': {}, 'node:crypto': crypto, '@prisma/client': { Prisma: {} },
  '@/lib/prisma': { prisma }, '@/lib/auth/session': auth,
  '@/lib/template-studio/text-models': loadModule('src/lib/template-studio/text-models.ts', {}),
  '@/lib/integrations/musk': musk,
  './model-availability-contract': loadModule('src/lib/pricing/model-availability-contract.ts',
    { './resolve': { selectPricingRule: () => assert.fail('No image price resolution on a model-directory read') } }),
  './policy': { PricingAdminServiceError: class extends Error {} }, './catalog': { pricingFingerprint: () => assert.fail('No save in catalog read') },
});
const managed = await pricing.getSupplementaryModelChoices();
assert.ok(managed.some(model => model.kind === 'text' && model.model === 'gpt-6.1-terra'));
assert.ok(managed.some(model => model.kind === 'text' && model.model === 'gpt-6.1-sol'));
const beforeTransaction = metadataCalls;
inTransaction = true;
await pricing.getSupplementaryModelChoices(prisma, chatIds);
inTransaction = false;
assert.equal(metadataCalls, beforeTransaction, 'Discovered IDs are reused during transaction validation');
console.log(JSON.stringify({ passed: true, realDirectoryShape: { total: rawIds.length, text: chatIds.length },
  capturedLocalRequests: captured.length, capturedMetadataRequests: metadataCalls, capturedProviderPayloads, generatedRequests,
  realProviderCalls: 0, realDatabaseCalls: 0, productionWrites: 0 }));
