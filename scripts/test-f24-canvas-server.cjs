'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
class AuthError extends Error { constructor(message, status = 403) { super(message); this.status = status; } }
const forbidden = new Proxy({}, { get: (_, key) => { throw Error('unexpected global database access: ' + String(key)); } });
const cache = new Map();
const noCall = new Proxy({}, { get: (_, key) => { if (key === '__esModule') return false; return () => { throw Error('unexpected dependency: ' + String(key)); }; } });
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const name = path.relative(root, file).replaceAll(path.sep, '/');
  let source = baseline ? execFileSync('git', ['show', '24e4c097bcea877135c40c6bf14eba48a5ecc055:' + name], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(file, 'utf8');
  if (name === 'src/lib/canvas-documents.ts') source += '\nexport { duplicateSnapshot as f24DuplicateSnapshot };';
  const module = { exports: {} }; cache.set(file, module);
  const local = id => {
    if (id === '@prisma/client') return { Prisma: { PrismaClientKnownRequestError: class extends Error {} } };
    if (id.endsWith('/prisma') || id === './prisma') return { prisma: forbidden };
    if (id.endsWith('/auth/session') || id === './auth/session') return { AuthError };
    if (id.endsWith('/access/feature-guard')) return { assertInternalOnly: user => { if (user.account_type !== 'internal') throw new AuthError('internal', 403); }, isFeatureAllowed: () => true };
    if (id.endsWith('/image-studio/protected-assets') || id === './image-studio/protected-assets') return { canReadStudioAsset: async (_user, asset, db) => { assert.equal(db, activeDb); return !asset.syntheticProtected; }, studioHiddenAssetUrls: async () => [] };
    if (id.endsWith('/canvas-video-batches-guards') || id === './canvas-video-batches-guards') return noCall;
    if (id.endsWith('/canvas-roles/guard')) return { isRoleCollaborationReadOnly: () => false };
    if (id === 'uuid') return { v4: () => 'synthetic-workspace' };
    if (id.startsWith('node:') || ['crypto', 'fs', 'path'].includes(id)) return require(id);
    let next = id.startsWith('@/') ? path.join(root, 'src', id.slice(2)) : id.startsWith('.') ? path.resolve(path.dirname(file), id) : null;
    if (!next) return noCall;
    next += path.extname(next) === '.ts' ? '' : '.ts';
    if (['canvas-documents.ts', 'canvas-workspace.ts', 'canvas-reference-inputs.ts', 'canvas-references.ts', 'workspace.ts',
      'permissions.ts', 'site-url.ts', 'reference-media-policy.ts', 'seedance-models.ts', 'multiview-task-privacy.ts', 'retention.ts',
      'workflow-schema.ts', 'types.ts', 'text-models.ts', 'quality-routing.ts', 'shared-capabilities.ts', 'ratios.ts', 'limits.ts'].includes(path.basename(next))) return load(next);
    return noCall;
  };
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: file })(local, module, module.exports);
  return module.exports;
}
let activeDb;
const user = { id: 'user-a', role: 'user', account_type: 'internal', status: 'active' };
const snapshot = () => ({ schema: 'ultimate_canvas.v1', schemaVersion: 2, canvas: { nodes: [{ id: 'target', type: 'video', x: 0, y: 0, data: {} }], connections: [] }, context: { project_id: 'project-a', video_card_id: null } });
const document = graph => ({ id: 'document-a', owner_user_id: user.id, project_id: 'project-a', title: 'synthetic',
  status: 'active', revision: 1, schema_version: 2, protocol_version: 2, created_at: new Date(0), updated_at: new Date(0), document_json: JSON.stringify(graph) });
const tests = [], test = (name, run) => tests.push({ name, run });
const docs = load(path.join(root, 'src/lib/canvas-documents.ts'));
test('actual lossless document read preserves typed fields without client capability and writes nothing', () => {
  const graph = snapshot(); graph.canvas.nodes[0].data.canvas_references = { version: 1, items: [] };
  const saved = document(graph), before = JSON.stringify(saved);
  assert.equal(docs.canvasDetail(saved, []).document_json, saved.document_json);
  assert.equal(JSON.stringify(saved), before);
  if (!baseline) assert.equal(docs.canvasDetail(saved, []).reference_capability.client_supported, false);
});
test('actual duplicate writer must not discard typed input identity', () => {
  const graph = snapshot(); graph.canvas.nodes[0].data.canvas_references = { version: 1, items: [{ kind: 'audio', role: 'reference', assetId: 'audio-a', sourceVersion: 'a'.repeat(64) }] };
  assert.deepEqual(docs.f24DuplicateSnapshot(graph).canvas.nodes[0].data.canvas_references, graph.canvas.nodes[0].data.canvas_references);
});
if (!baseline) {
  const contract = load(path.join(root, 'src/lib/canvas-references.ts'));
  const workspace = load(path.join(root, 'src/lib/canvas-workspace.ts'));
  const inputs = load(path.join(root, 'src/lib/canvas-reference-inputs.ts'));
  const channels = load(path.join(root, 'src/lib/image-studio/shared-capabilities.ts'));
  const caps = ['canvas.references.v1'];
  function fixture(graph = snapshot()) {
    const state = { user: { ...user }, document: document(graph), project: { id: 'project-a', owner_user_id: user.id, status: 'active', type: 'personal', members: [] },
      assets: new Map(), references: new Map(), workspaces: [], bindings: new Map(), writes: 0, balance: 1234, unknown: { request_id: 'unknown-original', state: 'unknown' } };
    const db = new Proxy({
      user: { findUnique: async () => state.user },
      project: { findUnique: async () => state.project },
      canvasDocument: { findUnique: async ({ where }) => where.id === state.document.id ? state.document : null },
      asset: { findUnique: async ({ where }) => state.assets.get(where.id) || null },
      referenceImage: { findFirst: async ({ where }) => state.references.get(where.id) || null },
      platformSetting: { findUnique: async ({ where }) => state.bindings.get(where.key) || null },
      workspace: {
        findFirst: async ({ where }) => state.workspaces.find(row => (!where.id || row.id === where.id) && row.owner_id === where.owner_id && row.status === where.status && (!where.name || row.name === where.name)) || null,
        findMany: async ({ where, take }) => state.workspaces.filter(row => row.owner_id === where.owner_id && row.status === where.status && where.name.in.includes(row.name)).slice(0, take),
      },
      videoTask: { findFirst: async () => null },
    }, { get(target, key) { if (key in target) return target[key]; throw Error('unexpected DB operation ' + String(key)); } });
    activeDb = db;
    const add = (id, type = 'image', owner = user.id) => {
      const asset = { id, type, owner_id: owner, status: 'active', original_url: 'https://synthetic.invalid/' + id, hash: 'a'.repeat(64),
        file_size: 10, mime_type: type + '/synthetic', created_at: new Date(0) };
      state.assets.set(id, asset); return { kind: type, role: 'reference', assetId: id };
    };
    const body = items => ({ provider: 'seedance', model: 'seedance_2.0', project_id: 'project-a', canvas_document_id: 'document-a', canvas_node_id: 'target',
      generation_mode: 'all_in_one_reference', canvas_references: { version: 1, items }, required_capabilities: caps });
    return { db, state, add, body };
  }
  test('server key binds full user/project/document tuple, fits old96 and rejects foreign document', async () => {
    const f = fixture(); const scope = await workspace.resolveCanvasWorkspaceScope(user, { projectId: 'project-a', documentId: 'document-a' }, f.db);
    assert.match(scope.workspace_key, /^uc2_[a-f0-9]{64}$/); assert.ok(scope.workspace_key.length <= 96);
    assert.notEqual(scope.workspace_key, workspace.canvasWorkspaceKey('user-b', 'project-a', 'document-a'));
    assert.notEqual(scope.workspace_key, workspace.canvasWorkspaceKey(user.id, 'project-a', 'document-b'));
    f.state.document.owner_user_id = 'user-b'; await assert.rejects(() => workspace.resolveCanvasWorkspaceScope(user, { projectId: 'project-a', documentId: 'document-a' }, f.db), error => error.status === 403);
  });
  test('legacy exact constructors/truncation are read-only; ambiguous records conflict', async () => {
    const f = fixture(); const scope = { owner_id: user.id, project_id: 'p'.repeat(90), document_id: 'd'.repeat(80), video_card_id: 'card', snapshot: snapshot() };
    const keys = workspace.legacyCanvasWorkspaceKeys(scope, 'node'); assert.equal(keys.length, 2);
    assert.equal(keys[0], `ultimate-canvas:${scope.project_id}:card`);
    f.state.workspaces.push({ id: 'old-1', owner_id: user.id, status: 'active', name: '默认工作台:' + keys[0].slice(0, 96) });
    assert.equal((await workspace.readLegacyCanvasWorkspace(scope, 'node', undefined, f.db)).id, 'old-1');
    f.state.workspaces.push({ id: 'old-2', owner_id: user.id, status: 'active', name: '默认工作台:' + keys[1].slice(0, 96) });
    await assert.rejects(() => workspace.readLegacyCanvasWorkspace(scope, 'node', undefined, f.db), error => error.status === 409);
    assert.equal((await workspace.readLegacyCanvasWorkspace(scope, 'node', 'old-1', f.db)).id, 'old-1');
    assert.equal(f.state.writes, 0);
  });
  test('actual typed resolver preserves mixed order/version and same tx; strict old/new equality', async () => {
    const f = fixture(); const items = [f.add('image'), f.add('audio', 'audio'), f.add('video', 'video')];
    const result = await inputs.resolveCanvasReferenceInputs(user, f.body(items), f.db);
    assert.deepEqual(result.references.items.map(item => item.kind), ['image', 'audio', 'video']);
    assert.ok(result.references.items.every(item => /^[a-f0-9]{64}$/.test(item.sourceVersion)));
    await assert.rejects(() => inputs.resolveCanvasReferenceInputs(user, { ...f.body(items), reference_audio_urls: [] }, f.db), error => error.status === 409);
    const canonical = inputs.applyCanvasReferenceInputs(f.body(items), result);
    assert.deepEqual((await inputs.resolveCanvasReferenceInputs(user, canonical, f.db)).references, result.references);
    assert.equal(f.state.balance, 1234); assert.deepEqual(f.state.unknown, { request_id: 'unknown-original', state: 'unknown' }); assert.equal(f.state.writes, 0);
  });
  test('no-field legacy generation needs no new capability; missing-cap generation on typed document is denied', async () => {
    const f = fixture();
    const old = { project_id: 'project-a', canvas_document_id: 'document-a', canvas_node_id: 'target' };
    assert.equal(await inputs.resolveCanvasReferenceInputs(user, old, f.db), null);
    const marked = snapshot(); marked.canvas.nodes[0].data.canvas_references = { version: 1, items: [] };
    f.state.document.document_json = JSON.stringify(marked);
    await assert.rejects(() => inputs.resolveCanvasReferenceInputs(user, old, f.db), error => error.status === 426);
    assert.equal(docs.canvasDetail(f.state.document).document_json, f.state.document.document_json);
    assert.equal(f.state.writes, 0);
  });
  test('real resolver refuses foreign/protected/type/version/source-node and revoked project', async () => {
    const f = fixture(); const item = f.add('image');
    const resolved = await inputs.resolveCanvasReferenceInputs(user, f.body([item]), f.db);
    f.state.assets.get('image').hash = 'b'.repeat(64);
    await assert.rejects(() => inputs.resolveCanvasReferenceInputs(user, f.body(resolved.references.items), f.db), error => error.status === 409);
    for (const bad of [{ ...item, kind: 'video' }, { ...item, sourceNodeId: 'missing' }, f.add('foreign', 'image', 'user-b')]) await assert.rejects(() => inputs.resolveCanvasReferenceInputs(user, f.body([bad]), f.db));
    f.state.assets.get('image').syntheticProtected = true;
    await assert.rejects(() => inputs.resolveCanvasReferenceInputs(user, f.body([item]), f.db), error => error.status === 403);
    f.state.project.status = 'archived'; await assert.rejects(() => inputs.resolveCanvasReferenceInputs(user, f.body([]), f.db));
  });
  test('ordinary9/3/3 and visual-audio differ from IP2.5 30/10/10/audioOnly', async () => {
    const f = fixture(); const images = Array.from({ length: 10 }, (_, i) => f.add('image-' + i));
    await assert.rejects(() => inputs.resolveCanvasReferenceInputs(user, f.body(images), f.db), error => error.status === 400);
    const audio = [f.add('audio', 'audio')]; await assert.rejects(() => inputs.resolveCanvasReferenceInputs(user, f.body(audio), f.db), error => error.status === 400);
    const model = load(path.join(root, 'src/lib/provider/seedance-models.ts')).SEEDANCE_2_5_IP_MODEL_ID;
    const videos = Array.from({ length: 4 }, (_, i) => f.add('video-' + i, 'video'));
    const ip = await inputs.resolveCanvasReferenceInputs(user, { ...f.body([...images, ...videos, ...audio]), provider: 'volcengine_ip', model }, f.db);
    assert.equal(ip.references.items.length, 15);
    assert.equal((await inputs.resolveCanvasReferenceInputs(user, { ...f.body(audio), provider: 'volcengine_ip', model }, f.db)).referenceAudioUrls.length, 1);
  });
  test('source kind is verified from actual asset, frame roles and image limits are not truncated', async () => {
    const graph = snapshot(); graph.canvas.nodes[0].type = 'image'; const f = fixture(graph);
    await assert.rejects(() => inputs.resolveCanvasReferenceInputs(user, f.body([f.add('audio', 'audio')]), f.db), error => error.status === 400);
    const frameFixture = fixture(); const frames = [frameFixture.add('first'), frameFixture.add('last')].map((item, i) => ({ ...item, role: i ? 'last' : 'first' }));
    const result = await inputs.resolveCanvasReferenceInputs(user, { ...frameFixture.body(frames), generation_mode: 'first_last_frame' }, frameFixture.db);
    assert.deepEqual(result.references.items.map(item => item.role), ['first', 'last']);
    assert.equal(result.firstFrameUrl, 'https://synthetic.invalid/first'); assert.equal(result.lastFrameUrl, 'https://synthetic.invalid/last');
  });
  test('parse/read sticky capability and canonical metadata survive clear and malformed reference is rejected', () => {
    const old = snapshot(); assert.equal(docs.canvasDetail(document(old)).document_json, JSON.stringify(old));
    assert.equal(contract.canvasReferencesRequired(docs.parseCanvasSnapshot(JSON.stringify(old), 'project-a', true)), false);
    const graph = snapshot(); graph.canvas.nodes[0].data.canvas_references = { version: 1, items: [] };
    const parsed = docs.parseCanvasSnapshot(JSON.stringify(graph), 'project-a', true);
    assert.equal(parsed.canvasReferenceVersion, 1);
    assert.equal(contract.retainCanvasReferencesCapability(snapshot(), parsed).canvasReferenceVersion, 1);
    const detail = docs.canvasDetail(document(parsed), caps);
    assert.equal(detail.workspace_context.owner_id, user.id); assert.deepEqual(detail.canvas_references_by_node.target, { version: 1, items: [] });
    assert.throws(() => contract.requireCanvasReferencesCapability(parsed, []), error => error.status === 426);
    graph.canvas.nodes[0].data.canvas_references.items = [{ kind: 'audio', role: 'first', assetId: 'audio' }];
    assert.throws(() => docs.parseCanvasSnapshot(JSON.stringify(graph), 'project-a', true));
  });
  test('capability null is unknown, 0 denies, positive clamps; only lawful Gemini DTO exception permits unknown', () => {
    const model = 'gemini-3-pro-image-preview';
    const channel = max => ({ id: 'fluxport', enabled: true, configured: true, ready: true, models: { [model]: { ready: true, billingMode: 'fixed', fixedPoints: 10, qualities: null, resolutions: null, ratios: null, maxReferences: max, allowsUnconfirmedParameters: true } } });
    assert.equal(channels.canvasImageChannelProjection(channel(null), model).referenceLimit, 10);
    assert.equal(channels.canvasImageChannelProjection(channel(0), model).referenceLimit, 0);
    assert.match(channels.sharedImageStudioChannelIssue(channel(0), model, { referenceCount: 1 }), /最多使用 0/);
    assert.equal(channels.canvasImageChannelProjection(channel(3), model).referenceLimit, 3);
    const denied = channel(null); denied.models[model].allowsUnconfirmedParameters = false;
    assert.notEqual(channels.canvasImageChannelProjection(denied, model).issue, null);
    const empty = channel(null); empty.models[model].qualities = [];
    assert.notEqual(channels.canvasImageChannelProjection(empty, model).issue, null);
  });
}
(async () => {
  let failed = 0;
  for (const { name, run } of tests) { try { await run(); console.log('ok ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.stack); } }
  console.log(JSON.stringify({ suite: baseline ? 'f24-copy-24e-RED' : 'f24-server-helper', total: tests.length, failed, nativePrisma: false, providerCalls: 0,
    limits: 'Synthetic repository; protected-assets boundary is injected, not private-policy acceptance' }));
  if (failed) process.exitCode = 1;
})();
