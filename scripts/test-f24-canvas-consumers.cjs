'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const workflow = require('../public/tools/ultimate-canvas/generation-node-workflow.js');
const interactions = require('../public/tools/ultimate-canvas/generation-node-interactions.js');
const commands = require('../public/tools/ultimate-canvas/canvas-commands.js');
const root = path.resolve(__dirname, '..');
function functions(file, names, context) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JS);
  const found = new Map();
  const visit = node => { if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) found.set(node.name.text, node.getText(ast)); ts.forEachChild(node, visit); };
  visit(ast); assert.equal(found.size, names.length, 'all tests invoke real named consumer functions');
  const code = [...found.values()].join('\n') + '\nthis.actual = {' + names.join(',') + '};';
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context.actual;
}
const tests = [], test = (name, run) => tests.push({ name, run });
const plain = value => JSON.parse(JSON.stringify(value));
test('actual collector retains connected video/audio identity and clears disconnected references', () => {
  const engine = { nodes: new Map([
    ['target', { id: 'target', type: 'video', data: { mode: 'all-reference-video' } }],
    ['video', { id: 'video', type: 'video', data: { taskId: 'task-a', selectedVideoResult: { taskId: 'task-a' } } }],
    ['audio', { id: 'audio', type: 'audio', data: { assetId: 'audio-a', sourceVersion: 'a'.repeat(64) } }],
  ]), connections: [{ from: 'video', to: 'target' }, { from: 'audio', to: 'target' }] };
  const ctx = vm.createContext({ engine, window: { UltimateCanvasGenerationNodes: workflow, UltimateCanvasGenerationInteractions: interactions } });
  const actual = functions('public/tools/ultimate-canvas/app.js', ['generationReferenceItems', 'canvasReferencesForNode', 'referenceIdsFromNodeData', 'referenceUrlsFromNodeData', 'uniqueList'], ctx);
  const result = plain(actual.canvasReferencesForNode('target'));
  assert.deepEqual(result.items.map(item => item.kind), ['video', 'audio']);
  assert.equal(result.items[0].taskId, 'task-a'); assert.equal(result.items[0].sourceNodeId, 'video');
  engine.nodes.get('target').data.canvas_references = result;
  engine.connections = engine.connections.filter(edge => edge.from !== 'video');
  assert.deepEqual(plain(actual.canvasReferencesForNode('target')).items.map(item => item.kind), ['audio']);
  engine.nodes.get('audio').data.assetId = 'audio-b'; delete engine.nodes.get('audio').data.sourceVersion;
  assert.equal(actual.canvasReferencesForNode('target').items[0].sourceVersion, undefined, 'old version is not borrowed by a replacement source');
});
test('actual workspace consumer accepts server scope only and isolates account/document', () => {
  const runtime = { selectedProjectId: 'p', documentId: 'd', bootstrap: { user: { id: 'u' } },
    workspaceContext: { owner_id: 'u', project_id: 'p', document_id: 'd', workspace_key: 'uc2_' + 'a'.repeat(64) } };
  const ctx = vm.createContext({ canvasRuntime: runtime });
  const actual = functions('public/tools/ultimate-canvas/app.js', ['canvasWorkspaceKey'], ctx);
  assert.equal(actual.canvasWorkspaceKey(), runtime.workspaceContext.workspace_key);
  runtime.selectedProjectId = 'other'; assert.equal(actual.canvasWorkspaceKey(), '');
  runtime.selectedProjectId = 'p';
  runtime.documentId = 'other'; assert.equal(actual.canvasWorkspaceKey(), '');
  runtime.documentId = 'd'; runtime.bootstrap.user.id = 'other'; assert.equal(actual.canvasWorkspaceKey(), '');
  runtime.bootstrap.user.id = 'u'; runtime.workspaceContext = null; assert.equal(actual.canvasWorkspaceKey(), '', 'no historical/default key invention');
});
test('actual workspace consumer rejects absent identity and malformed keys', () => {
  const scope = { project_id: 'p', document_id: 'd', workspace_key: 'uc2_' + 'a'.repeat(64) };
  const runtime = { selectedProjectId: 'p', documentId: 'd', bootstrap: null, workspaceContext: scope };
  const actual = functions('public/tools/ultimate-canvas/app.js', ['canvasWorkspaceKey'], vm.createContext({ canvasRuntime: runtime }));
  for (const bootstrap of [null, {}, { user: {} }, { user: { id: '' } }]) {
    runtime.bootstrap = bootstrap;
    assert.equal(actual.canvasWorkspaceKey(), '', 'missing identity must not match a missing owner');
  }
  runtime.bootstrap = { user: { id: 'u' } }; scope.owner_id = 'u';
  for (const key of ['', 'legacy-workspace', 'uc2_short']) {
    scope.workspace_key = key;
    assert.equal(actual.canvasWorkspaceKey(), '');
  }
});
test('actual initial reads reach fetch without an uninitialized workspace header', async () => {
  const runtime = { selectedProjectId: null, documentId: null, bootstrap: null, workspaceContext: null };
  const requests = [];
  const ctx = vm.createContext({ canvasRuntime: runtime, backendEndpoint: url => url,
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, text: async () => '{"ok":true}' }; },
  });
  const actual = functions('public/tools/ultimate-canvas/app.js', ['canvasWorkspaceKey', 'workspaceHeaders', 'requestJson'], ctx);
  for (const endpoint of ['/api/tools/ultimate-canvas/bootstrap', '/api/tools/ultimate-canvas/document?document_id=existing']) {
    assert.deepEqual(plain(await actual.requestJson(endpoint, { cache: 'no-store' })), { ok: true });
    const request = requests.at(-1);
    assert.equal(request.url, endpoint);
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.credentials, 'same-origin');
    assert.equal(request.options.headers['x-tab-id'], undefined);
    assert.equal(request.options.headers['x-canvas-project-id'], undefined);
    assert.ok(request.options.headers['x-canvas-capabilities'].includes('canvas.references.v1'));
  }
  assert.equal(requests.length, 2);
  assert.equal(runtime.bootstrap, null);
  assert.equal(runtime.workspaceContext, null);
});
test('actual duplicate preserves typed input task identity but strips execution state', () => {
  const references = { version: 1, items: [{ kind: 'video', role: 'reference', taskId: 'input-task', sourceNodeId: 'source', sourceVersion: 'a'.repeat(64) }] };
  const data = commands.duplicateNodeData({ type: 'video', data: { canvas_references: references,
    taskId: 'execution-task', videoSubmission: { state: 'unconfirmed' }, generationStatus: 'running', prompt: 'synthetic' } }, new Map([['source', 'copied-source']]), new Map());
  assert.equal(data.taskId, undefined); assert.equal(data.videoSubmission, undefined);
  assert.equal(data.canvas_references.items[0].taskId, 'input-task'); assert.equal(data.canvas_references.items[0].sourceNodeId, 'copied-source');
  assert.deepEqual(references.items[0].sourceNodeId, 'source');
});
test('actual upload recovery keeps original request and never resends unknown bytes; stale account stops', async () => {
  const saved = new Map(); let rawUploads = 0, queries = 0;
  const identity = { hash: 'a'.repeat(64), fileSize: 10, mimeType: 'image/png' };
  const ctx = vm.createContext({
    validId: value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value), URLSearchParams,
    canvasHeaders: () => ({ 'x-canvas-capabilities': 'canvas.references.v1' }), UploadNotAcceptedError: class extends Error {},
    localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    uploadFileAsAsset: async (_file, options) => { const existing = await options.beforeUpload(identity); if (existing) return existing; rawUploads++; throw Error('raw boundary must not be used'); },
    fetch: async url => { queries++; const query = new URL('https://synthetic.invalid' + url).searchParams; assert.equal(query.get('request_id'), 'original-request'); return { ok: true }; },
    readJsonResponse: async () => ({ found: true, associated: true, asset: { id: 'asset-a' } }),
  });
  const actual = functions('src/app/tools/ultimate-canvas/CanvasFrame.tsx', ['uploadCanvasOriginal'], ctx);
  const context = { userId: 'user-a', projectId: 'project-a', documentId: 'document-a', nodeId: 'node-a', cardId: 'card-a', requestId: 'current-request' };
  const key = `sd2_canvas_upload:${context.userId}:${context.projectId}:${context.cardId}:${context.documentId}:${identity.hash}`;
  saved.set(key, JSON.stringify({ requestId: 'original-request', ...identity }));
  const result = await actual.uploadCanvasOriginal({}, context, () => true);
  assert.equal(result.requestId, 'original-request'); assert.equal(rawUploads, 0); assert.equal(queries, 1); assert.ok(saved.has(key));
  await assert.rejects(() => actual.uploadCanvasOriginal({}, context, () => false));
  assert.equal(queries, 1); assert.ok(saved.has(key));
});
(async () => {
  let failed = 0;
  for (const { name, run } of tests) { try { await run(); console.log('ok ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.stack); } }
  console.log(JSON.stringify({ suite: 'f24-actual-consumers', total: tests.length, failed, nativePrisma: false, providerCalls: 0, browser: false }));
  if (failed) process.exitCode = 1;
})();
