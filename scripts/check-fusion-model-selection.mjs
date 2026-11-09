import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
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

const access = parseModelAccessSettings(null);
access.models = [{ kind: 'text', model: 'closed-model', enabled: false }];
let signedIn = true, upstream = ['selected-model'], forced = 0, resolved = 0;
const mocks = {
  'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
  '@/lib/auth/session': { getSession: async () => signedIn ? { id: 'actor' } : null },
  '@/lib/integrations/musk': {
    getMuskApiSettings: async () => ({ default_model: 'selected-model' }),
    isMuskApiReady: () => true,
    fetchMuskUpstreamModels: async (_settings, options) => { assert.equal(options.force, true); forced++; return upstream; },
    resolveMuskChatModels: async () => { resolved++; return ['selected-model', 'closed-model']; },
  },
  '@/lib/pricing/model-access.server': { readModelAccessSettings: async () => access },
  '@/lib/pricing/model-availability-contract': { supplementaryModelEnabled },
};
const source = fs.readFileSync(path.resolve('src/app/api/llm/models/route.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
vm.runInNewContext(compiled, { exports, console, require: name => { assert.ok(Object.hasOwn(mocks, name), name); return mocks[name]; } });
const request = refresh => ({ nextUrl: new URL('https://sd2.invalid/api/llm/models' + (refresh ? '?refresh=1' : '')) });
let response = await exports.GET(request(false));
assert.equal(response.status, 200); assert.equal(forced, 0);
assert.deepEqual((await response.json()).models.map(model => model.id), ['selected-model']);
response = await exports.GET(request(true));
assert.equal(response.status, 200); assert.equal(forced, 1);
assert.deepEqual((await response.json()).models.map(model => model.id), ['selected-model']);
upstream = null; const beforeFailure = resolved;
response = await exports.GET(request(true));
assert.equal(response.status, 502); assert.equal(resolved, beforeFailure, 'Failed refresh must not claim cached-list success');
signedIn = false; const beforeAuth = forced;
response = await exports.GET(request(true));
assert.equal(response.status, 401); assert.equal(forced, beforeAuth, 'Anonymous refresh must not contact upstream');
console.log(JSON.stringify({ passed: true, scenarios: 6, capturedLocalRequests: captured.length, realProviderCalls: 0, databaseCalls: 0 }));
