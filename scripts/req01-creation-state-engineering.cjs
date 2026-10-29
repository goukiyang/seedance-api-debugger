'use strict';
// Offline engineering only. No browser, server, database, credentials, or provider calls.
// Run after the entire batch is ready. REQ01_RUNTIME_ROOT may point to an isolated
// runtime containing typescript, react and the exactly matching react-test-renderer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash, randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const runtime = createRequire(path.join(process.env.REQ01_RUNTIME_ROOT || root, 'package.json'));
let React, Renderer, ts;
try {
  React = runtime('react'); Renderer = runtime('react-test-renderer'); ts = runtime('typescript');
  assert.equal(runtime('react-test-renderer/package.json').version, React.version, 'React renderer must match the installed React version');
} catch (cause) {
  throw new Error(`REQ01 needs real React + matching react-test-renderer + TypeScript; no mock-hook fallback. Use REQ01_RUNTIME_ROOT for an isolated runtime. ${cause.message}`);
}
const { act } = Renderer;
const hashes = {};
function source(file) {
  const value = fs.readFileSync(path.join(root, file), 'utf8');
  hashes[file] = createHash('sha256').update(value).digest('hex');
  return value;
}
function compile(value, file) {
  const result = ts.transpileModule(value, { fileName: file, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  assert.equal((result.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0, `Invalid source: ${file}`);
  return result.outputText;
}
function load(file, dependencies) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compile(source(file), file))(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected import ${name} from ${file}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key), clear: () => values.clear(), values };
}
const session = storage(), local = storage(), requests = [], checks = [];
const originalGlobals = Object.fromEntries(['fetch', 'sessionStorage', 'localStorage', 'window', 'document', 'crypto'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let answer;
function response(value, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => value }; }
for (const [key, value] of Object.entries({ sessionStorage: session, localStorage: local, crypto: { randomUUID },
  window: { location: { search: '' }, crypto: { randomUUID } }, document: { querySelector: () => { throw new Error('query_original must not focus a virtual field'); } },
  fetch: async (url, init = {}) => {
    assert.equal(typeof url, 'string'); assert.ok(url.startsWith('/api/'), 'Absolute/external network calls are forbidden');
    const request = { url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null };
    requests.push(request);
    return answer(request);
  } })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hook = load('src/lib/hooks/use-creation-context.ts', { react: React });
const jsx = runtime('react/jsx-runtime');
const Availability = load('src/components/creation/CreationAvailability.tsx', { react: React, 'react/jsx-runtime': jsx,
  '@/lib/hooks/use-creation-context': hook, '@/lib/navigation/return-to': { taskDetailHref: id => `/tasks/${encodeURIComponent(id)}` },
  '@/components/RelativeTime': { RelativeTime: () => null }, './creation.module.css': { default: {} } }).default;
const options = { ownerId: 'fixture-owner', entry: 'ordinary', draftId: 'fixture-draft', projectId: 'fixture-project' };
const context = { project: { id: options.projectId, name: 'Fixture', type: 'personal' }, payer: { kind: 'user', id: options.ownerId, label: 'Fixture' }, v2Available: true, legacyCard: null };
const ready = key => ({ id: `intent:${key}`, request_id: key, revision: 1, state: 'ready', contract_version: 2,
  accepted_task_id: null, batch_id: null, availability: { canSubmit: true, reasons: [] } });
const accepted = key => ({ ...ready(key), state: 'accepted', accepted_task_id: `task:${key}`,
  availability: { canSubmit: false, reasons: [{ code: 'creation_original_required', action: 'query_original', field: 'intent_id', message: '此请求已有处理结果，请核对原任务' }] } });
function receiptKey(value = options, tab = 'fixture-tab') {
  return `sd2-creation-preparation-v2:${value.ownerId}:${value.entry}:${value.draftId}:tab:${tab}:${value.projectId || ''}:${value.legacyCardId || ''}`;
}
function reset() {
  session.clear(); local.clear(); requests.length = 0; session.setItem('workspace_tab_id', 'fixture-tab');
  answer = request => {
    if (request.url.startsWith('/api/creation/context?')) return response(context);
    if (request.url === '/api/video/creation-intents' && request.method === 'POST') return response({ intent: ready(request.body.request_id) });
    throw new Error(`Unexpected offline request: ${request.method} ${request.url}`);
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { await act(async () => { await tick(); }); }
async function mountHook(value = options, ui = false) {
  let current, renderer;
  function Harness(props) { current = hook.useCreationContext(props.value); return ui ? React.createElement(Availability, { controller: current }) : null; }
  await act(async () => { renderer = Renderer.create(React.createElement(Harness, { value })); await tick(); });
  await settle();
  return { get current() { return current; }, renderer,
    update: async next => { await act(async () => { renderer.update(React.createElement(Harness, { value: next })); await tick(); }); },
    close: async () => { await act(async () => renderer.unmount()); } };
}
async function check(name, callback) { await callback(); checks.push(name); }

async function hookChecks() {
  await check('stale ready snapshot must GET the retained original before any POST', async () => {
    reset(); const old = ready('old');
    session.setItem(receiptKey(), JSON.stringify({ id: old.id, request_id: old.request_id }));
    const base = answer; answer = request => request.url.includes('/creation-intents/intent%3Aold') ? response({ intent: accepted('old') }) : base(request);
    const mounted = await mountHook(); requests.length = 0;
    let result;
    await act(async () => { result = await mounted.current.prepare({}, 'old', old); });
    assert.equal(result.state, 'accepted'); assert.deepEqual(requests.map(row => row.method), ['GET']);
    assert.equal(mounted.current.intent.accepted_task_id, 'task:old');
    requests.length = 0;
    await act(async () => { result = await mounted.current.prepare({}, 'new', null); });
    assert.equal(result.request_id, 'new'); assert.deepEqual(requests.map(row => row.method), ['GET', 'POST']);
    await mounted.close();
  });
  await check('unknown empty GET and transport timeout retain the original key and never POST', async () => {
    for (const fail of [false, true]) {
      reset(); session.setItem(receiptKey(), JSON.stringify({ request_id: 'unknown' }));
      const base = answer; answer = request => request.url.includes('?request_id=unknown')
        ? fail ? Promise.reject(new Error('synthetic local timeout')) : response({ intent: null, state: 'unconfirmed' }) : base(request);
      const mounted = await mountHook(); const retained = session.getItem(receiptKey()); requests.length = 0;
      await act(async () => { await assert.rejects(mounted.current.prepare({}, 'must-not-create', ready('stale'))); });
      assert.equal(session.getItem(receiptKey()), retained); assert.equal(requests.filter(row => row.method === 'POST').length, 0);
      await mounted.close();
    }
  });
  await check('HTTP rejection alone retains preparation; durable rejected GET permits a later explicit preparation', async () => {
    reset(); const base = answer;
    answer = request => request.method === 'POST' ? response({ error: 'synthetic rejected', code: 'creation_input_invalid' }, 400) : base(request);
    const mounted = await mountHook();
    await act(async () => { await assert.rejects(mounted.current.prepare({}, 'rejected')); });
    assert.equal(JSON.parse(session.getItem(receiptKey())).request_id, 'rejected');
    answer = request => request.url.includes('?request_id=rejected') ? response({ intent: null, state: 'rejected' }) : base(request);
    await act(async () => { await mounted.current.prepare({}, 'new'); });
    assert.equal(mounted.current.intent.request_id, 'new'); await mounted.close();
  });
  await check('authenticated task recovery and refresh retain accepted history without creating a new request', async () => {
    reset(); let mounted = await mountHook();
    await act(async () => { await mounted.current.prepare({}, 'recovered'); });
    await act(async () => { await mounted.current.acceptTask('recovered', 'task:recovered'); });
    assert.equal(mounted.current.intent.state, 'accepted'); await mounted.close();
    const base = answer; answer = request => request.url.includes('/creation-intents/intent%3Arecovered') ? response({ intent: accepted('recovered') }) : base(request);
    requests.length = 0; mounted = await mountHook();
    assert.equal(mounted.current.intent.state, 'accepted'); assert.equal(requests.filter(row => row.method === 'POST').length, 0);
    await mounted.close();
  });
  await check('account, project, draft and actual tab identity isolate retained receipts', async () => {
    for (const change of [{ ownerId: 'other-owner' }, { projectId: 'other-project' }, { draftId: 'other-draft' }]) {
      reset(); const mounted = await mountHook(); await act(async () => { await mounted.current.prepare({}, 'private'); });
      const stalePrepare = mounted.current.prepare;
      await mounted.update({ ...options, ...change }); assert.equal(mounted.current.intent, null);
      requests.length = 0; await assert.rejects(stalePrepare({}, 'must-not-create'));
      assert.equal(requests.length, 0); assert.equal(JSON.parse(session.getItem(receiptKey())).request_id, 'private'); await mounted.close();
    }
    reset(); let mounted = await mountHook(); await act(async () => { await mounted.current.prepare({}, 'first-tab'); }); await mounted.close();
    session.setItem('workspace_tab_id', 'other-tab'); requests.length = 0; mounted = await mountHook();
    assert.equal(mounted.current.intent, null); assert.equal(requests.some(row => row.url.includes('first-tab')), false); await mounted.close();
  });
  await check('late original GET after A to B to A cannot POST or overwrite the restored workspace', async () => {
    reset(); const mounted = await mountHook(); await act(async () => { await mounted.current.prepare({}, 'old'); });
    let release; const base = answer;
    answer = request => request.url.includes('/creation-intents/intent%3Aold') ? new Promise(resolve => { release = resolve; }) : base(request);
    let pending; await act(async () => { pending = mounted.current.prepare({}, 'old', ready('old')).then(() => null, cause => cause); await tick(); });
    await mounted.update({ ...options, projectId: 'other-project' });
    answer = request => request.url.includes('/creation-intents/intent%3Aold') ? response({ intent: ready('old') }) : base(request);
    await mounted.update(options);
    await act(async () => { release(response({ intent: accepted('old') })); await pending; });
    assert.ok((await pending) instanceof Error); assert.equal(mounted.current.intent?.state, 'ready');
    assert.equal(requests.filter(row => row.method === 'POST').length, 1); await mounted.close();
  });
  await check('query_original executes authenticated reads and exposes only the matched readable task', async () => {
    for (const status of [200, 403]) {
      reset(); session.setItem(receiptKey(), JSON.stringify({ id: 'intent:old', request_id: 'old' }));
      const base = answer; answer = request => request.url.includes('/creation-intents/intent%3Aold') ? response({ intent: accepted('old') })
        : request.url.startsWith('/api/tasks/request-status?') ? response(status === 200 ? { task: { id: 'task:old' } } : { error: 'synthetic permission denied' }, status) : base(request);
      const mounted = await mountHook(options, true); requests.length = 0;
      const button = mounted.renderer.root.findAllByType('button').find(node => node.props.children === '核对原任务'); assert.ok(button);
      await act(async () => { button.props.onClick(); await tick(); }); await settle();
      assert.equal(requests.filter(row => row.url.startsWith('/api/tasks/request-status?')).length, 1);
      assert.equal(mounted.renderer.root.findAllByType('a').some(node => node.props.href === '/tasks/task%3Aold'), status === 200);
      assert.equal(requests.some(row => row.method === 'POST'), false); await mounted.close();
    }
  });
}

function find(node, predicate) {
  if (predicate(node)) return node;
  let result; ts.forEachChild(node, child => { if (!result) result = find(child, predicate); }); return result;
}
function declaration(file, name) {
  const value = source(file), ast = ts.createSourceFile(file, value, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const node = find(ast, item => ts.isVariableDeclaration(item) && item.name.getText(ast) === name);
  assert.ok(node?.initializer, `Missing actual callback ${name}`);
  return { expression: node.initializer.getText(ast), node, ast };
}
const pageFile = 'src/components/generate/GeneratePageClient.tsx';
async function pageChecks() {
  // The unchanged page body has many unrelated integrations. Mount its actual callback
  // expressions with real React and the actual hook; only unrelated UI/services are fixtures.
  const submit = declaration(pageFile, 'handleSubmit'), query = declaration(pageFile, 'checkOriginalGenerationRequest');
  for (const expected of ['creation.intent', 'creation.prepare', 'creation.context', 'creation.acceptTask', 'creationBaselineId']) {
    assert.ok(submit.node.initializer.arguments[1].elements.some(node => node.getText(submit.ast) === expected), `Missing React callback dependency ${expected}`);
  }
  const body = compile(`return function PageHarness(props) {
    const { useState, useRef, useCallback } = React;
    const creation = useCreationContext(props.options);
    const [submitting, setSubmitting] = useState(false), [error, setError] = useState(null), [generationNotice, setGenerationNotice] = useState('');
    const [result, setResult] = useState(null), [polledResult, setPolledResult] = useState(null), [errorDebug, setErrorDebug] = useState(null);
    const [unconfirmedGenerationRequest, setUnconfirmedGenerationRequest] = useState(false), [activePollingTaskIds, setActivePollingTaskIds] = useState([]);
    const [recentTasks, setRecentTasks] = useState([]), [credits, setCredits] = useState(null);
    const generationOperation = useRef(null), generationScope = useRef({ key: props.scope });
    if (generationScope.current.key !== props.scope) generationScope.current = { key: props.scope };
    const reuseMountedRef = useRef(true), unconfirmedGenerationParamsRef = useRef(null), creationDraftBodyRef = useRef(null);
    const handleSubmit = ${submit.expression};
    const checkOriginalGenerationRequest = ${query.expression};
    props.report({ creation, handleSubmit, checkOriginalGenerationRequest, result, error, generationNotice, unconfirmedGenerationRequest, submitting });
    return null;
  }`, 'page-callback-fixture.tsx');
  async function setup() {
    reset(); const env = { currentUser: { id: options.ownerId }, selectedProjectId: options.projectId, selectedVideoCardId: '', selectedVideoBranchId: '',
      activeAccountIdRef: { current: options.ownerId }, selectedProjectIdRef: { current: options.projectId }, selectedVideoCardIdRef: { current: '' },
      surface: 'standard', isIpSurface: false, isExternalIpUser: false, studioRunId: null, creationBaselineId: '', videoCards: [],
      videoFeishu: { choice: null }, h3Ready: false, h3VideoConfig: null, selectedH3Preset: null, selectedH3Lora: null,
      saveGenerationDefaults: () => {}, loadRecentTasksPage: () => {}, H3_INLINE_MODEL_ID: 'fixture-h3', SEEDANCE_2_5_MODEL_ID: 'fixture-draft',
      stableGenerationPayloadJson: JSON.stringify, videoPricingBusinessInput: value => value, isSeedanceVideoDuration: () => true,
      readJsonResponse: reply => reply.json(), MAX_ACTIVE_POLLING_TASKS: 5,
      activeGenerationRequestStorageKey: `sd2-generation-request-v1:${options.ownerId}:standard:standard` };
    const Harness = new Function('React', 'useCreationContext', 'isResolvedCreationIntent', 'env', `with(env) { ${body} }`)(React, hook.useCreationContext, hook.isResolvedCreationIntent, env);
    let current, renderer; const props = { options, scope: 'initial', report: value => { current = value; } };
    await act(async () => { renderer = Renderer.create(React.createElement(Harness, props)); await tick(); }); await settle();
    return { env, props, get current() { return current; },
      update: async next => { Object.assign(props, next); await act(async () => { renderer.update(React.createElement(Harness, props)); await tick(); }); },
      remount: async () => { await act(async () => renderer.unmount()); await act(async () => { renderer = Renderer.create(React.createElement(Harness, props)); await tick(); }); await settle(); },
      close: async () => { await act(async () => renderer.unmount()); } };
  }
  const params = { prompt: 'synthetic input kept', model: 'fixture-model', duration: 5, resolution: '720p', generationMode: 'text_to_video', ratio: '16:9', templateStudioAssets: [] };
  for (const mode of ['normal', 'response-lost', 'manual', 'refresh']) await check(`actual React page callback: ${mode} acceptance then a later active generation`, async () => {
    const mounted = await setup(), intents = new Map(), tasks = new Map(); const base = answer;
    let loseResponse = mode === 'response-lost';
    answer = request => {
      if (request.url === '/api/video/creation-intents' && request.method === 'POST') { const dto = ready(request.body.request_id); intents.set(dto.id, dto); return response({ intent: dto }); }
      if (request.url.startsWith('/api/video/creation-intents/')) return response({ intent: intents.get(decodeURIComponent(request.url.split('/').pop())) });
      if (request.url.startsWith('/api/video/creation-intents?')) { const key = new URL(request.url, 'https://fixture.invalid').searchParams.get('request_id'); return response({ intent: intents.get(`intent:${key}`) }); }
      if (request.url === '/api/tasks/create') {
        const key = request.body.idempotency_key, task = { id: `task:${key}`, status: 'submitted' }; tasks.set(key, task); intents.set(`intent:${key}`, accepted(key));
        if (loseResponse) { loseResponse = false; throw new Error('synthetic response lost after acceptance'); } return response(task);
      }
      if (request.url.startsWith('/api/tasks/request-status?')) return response({ task: tasks.get(new URL(request.url, 'https://fixture.invalid').searchParams.get('idempotency_key')) || null });
      if (request.url === '/api/me/credits') return response({ available: 1 });
      return base(request);
    };
    if (mode === 'manual' || mode === 'refresh') {
      intents.set('intent:retained', accepted('retained')); tasks.set('retained', { id: 'task:retained', status: 'succeeded' });
      session.setItem(receiptKey(), JSON.stringify({ request_id: 'retained', id: 'intent:retained' }));
      session.setItem(mounted.env.activeGenerationRequestStorageKey, JSON.stringify({ key: 'retained' }));
      if (mode === 'refresh') await mounted.remount();
      await act(async () => { await mounted.current.checkOriginalGenerationRequest(); });
    } else await act(async () => { await mounted.current.handleSubmit(params); });
    assert.equal(mounted.current.error, null); assert.equal(mounted.current.creation.intent.state, 'accepted'); assert.ok(mounted.current.result?.id);
    if (mode !== 'normal') assert.ok(mounted.current.generationNotice.includes('恢复'));
    assert.equal(session.getItem(mounted.env.activeGenerationRequestStorageKey), null);
    const oldKey = mounted.current.creation.intent.request_id, priorCallback = mounted.current.handleSubmit;
    await act(async () => { await mounted.current.handleSubmit({ ...params, prompt: 'next explicit input' }); });
    assert.equal(mounted.current.error, null); assert.notEqual(mounted.current.creation.intent.request_id, oldKey);
    assert.notEqual(mounted.current.handleSubmit, priorCallback); assert.equal(mounted.current.result.id, `task:${mounted.current.creation.intent.request_id}`);
    await mounted.close();
  });
  await check('actual React page callback: unknown empty original query never releases or posts', async () => {
    const mounted = await setup(), base = answer;
    session.setItem(mounted.env.activeGenerationRequestStorageKey, JSON.stringify({ key: 'unknown' }));
    answer = request => request.url.startsWith('/api/tasks/request-status?') ? response({ task: null }) : base(request);
    await act(async () => { await mounted.current.handleSubmit(params); });
    assert.equal(mounted.current.unconfirmedGenerationRequest, true); assert.equal(JSON.parse(session.getItem(mounted.env.activeGenerationRequestStorageKey)).key, 'unknown');
    assert.equal(requests.some(row => row.method === 'POST'), false); await mounted.close();
  });
  await check('actual React page callback: late status after edited/project-changed scope cannot replace result or clear original key', async () => {
    const mounted = await setup(); let release;
    session.setItem(mounted.env.activeGenerationRequestStorageKey, JSON.stringify({ key: 'late' }));
    answer = () => new Promise(resolve => { release = resolve; });
    let pending; await act(async () => { pending = mounted.current.checkOriginalGenerationRequest(); await tick(); });
    await mounted.update({ scope: 'edited-other-project' });
    await act(async () => { release(response({ task: { id: 'late-task' } })); await pending; });
    assert.equal(mounted.current.result, null); assert.ok(session.getItem(mounted.env.activeGenerationRequestStorageKey)); await mounted.close();
  });
}

async function main() {
  try {
    await hookChecks(); await pageChecks();
    console.log(JSON.stringify({ mode: 'offline real React renderer + actual hook/page callbacks; not browser or functional acceptance',
      react: React.version, productionNetworkCalls: 0, databaseCalls: 0, providerCalls: 0, checks, hashes }, null, 2));
  } finally {
    for (const [key, descriptor] of Object.entries(originalGlobals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
}
main().catch(cause => { console.error(cause); process.exitCode = 1; });
