'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const ref = '24e4c097bcea877135c40c6bf14eba48a5ecc055';
const read = name => baseline ? execFileSync('git', ['show', ref + ':' + name], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, name), 'utf8');
class AuthError extends Error { constructor(message, status = 403) { super(message); this.status = status; } }
let activeDb;
let originalReceiptReads = false;
const globalDb = new Proxy({}, { get: (_, key) => {
  if (key === '$transaction') return async work => work(activeDb);
  if (originalReceiptReads) return activeDb[key];
  throw Error('unexpected global database query ' + String(key));
} });
const denied = new Proxy({}, { get: (_, key) => key === '__esModule' ? false : () => { throw Error('unexpected dependency ' + String(key)); } });
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name).exports;
  const module = { exports: {} }; cache.set(name, module);
  const local = id => {
    if (id === '@prisma/client') return { Prisma: { PrismaClientKnownRequestError: class extends Error {} } };
    if (id.endsWith('/prisma') || id === './prisma') return { prisma: globalDb };
    if (id.endsWith('/auth/session')) return { AuthError };
    if (id.endsWith('/access/feature-guard')) return { assertInternalOnly: user => { if (user.account_type !== 'internal') throw new AuthError('internal'); }, isFeatureAllowed: () => true };
    if (id.endsWith('/canvas-roles/guard')) return { isRoleCollaborationReadOnly: () => false };
    if (id.startsWith('node:') || ['crypto', 'path', 'fs'].includes(id)) return require(id);
    const next = id.startsWith('@/') ? 'src/' + id.slice(2) + '.ts' : id.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(name), id + '.ts')) : '';
    if (['canvas-documents.ts', 'canvas-reference-rollback.ts', 'canvas-video-batches-guards.ts', 'canvas-video-batch-contract.ts',
      'canvas-video-batches-build-mode.ts', 'synchronous-admission.ts', 'permissions.ts', 'workflow-schema.ts', 'types.ts', 'retention.ts', 'site-url.ts'].includes(path.posix.basename(next))) return load(next);
    return denied;
  };
  const code = ts.transpileModule(read(name), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInThisContext('(function(require,module,exports){' + code + '\n})', { filename: name })(local, module, module.exports);
  return module.exports;
}
const user = { id: 'owner', role: 'user', status: 'active', account_type: 'internal' };
const graph = () => ({ schema: 'ultimate_canvas.v1', schemaVersion: 2, context: { project_id: 'project', video_card_id: null },
  canvas: { nodes: [{ id: 'node', type: 'video', x: 0, y: 0, data: {} }], connections: [] } });
function marked() { const value = graph(); value.canvasReferenceVersion = 1; value.requiredCapabilities = ['canvas.references.v1'];
  value.canvas.nodes[0].data.canvas_references = { version: 1, items: [{ kind: 'audio', role: 'reference', assetId: 'synthetic-audio' }] }; return value; }
function fixture(value = marked()) {
  const state = { doc: { id: 'document', project_id: 'project', owner_user_id: user.id, title: 'Synthetic', status: 'active',
    revision: 1, schema_version: 2, protocol_version: 2, document_json: ' \n' + JSON.stringify(value, null, 2) + '\n', created_at: new Date(), updated_at: new Date() },
    project: { id: 'project', type: 'personal', owner_user_id: user.id, status: 'active', members: [] }, writes: [], receipts: new Map(), history: new Map(),
    balance: 1234, unknown: { requestId: 'original-unknown', provider_task_id: null, frozen: 10 }, sealScans: 0, child: null, task: null };
  const db = new Proxy({
    project: { findUnique: async () => state.project },
    canvasDocument: {
      findUnique: async ({ where }) => where.id === state.doc.id ? { ...state.doc } : null,
      create: async ({ data }) => { state.writes.push(data); return { ...state.doc, ...data }; },
      updateMany: async ({ where, data }) => {
        if (where.id !== state.doc.id || where.revision !== state.doc.revision || where.protocol_version !== state.doc.protocol_version) return { count: 0 };
        state.writes.push(data); const { revision, ...rest } = data; state.doc = { ...state.doc, ...rest, revision: state.doc.revision + revision.increment }; return { count: 1 };
      },
    },
    canvasDocumentRevision: { create: async ({ data }) => { state.history.set(data.revision, data); return data; },
      findMany: async () => [], findUnique: async ({ where }) => state.history.get(where.document_id_revision.revision) || null },
    canvasDocumentMutation: { findUnique: async ({ where }) => state.receipts.get(where.actor_user_id_mutation_id.mutation_id) || null,
      deleteMany: async () => ({ count: 0 }), create: async ({ data }) => { state.receipts.set(data.mutation_id, { ...data, created_at: new Date() }); return data; } },
    canvasVideoBatch: { findFirst: async () => null, findUnique: async () => null, findMany: async () => { state.sealScans++; return []; } },
    canvasVideoBatchChild: { findUnique: async () => state.child },
    videoTask: { findUnique: async () => state.task },
    asset: { findMany: async () => [] },
  }, { get(target, key) { if (key in target) return target[key]; throw Error('unexpected database operation ' + String(key)); } });
  activeDb = db;
  const body = action => ({ action, document_id: 'document', protocol_version: 2, base_revision: state.doc.revision,
    mutation_id: 'synthetic-' + action, ...(action === 'rename' ? { title: 'Renamed' } : {}) });
  return { state, db, body };
}
const docs = load('src/lib/canvas-documents.ts'), admission = load('src/lib/canvas-video-batches-guards.ts');
const paused = error => error.status === 426 && error.code === 'canvas_reference_rollback_paused';
const tests = [], test = (name, run) => tests.push({ name, run });
test('actual lossless detail read returns original marked JSON without writes', () => {
  const f = fixture(); assert.equal(docs.canvasDetail(f.state.doc).document_json, f.state.doc.document_json); assert.equal(f.state.writes.length, 0);
});
test('actual old writer cannot save a marked document or silently strip references', async () => {
  const f = fixture(), original = f.state.doc.document_json;
  await assert.rejects(() => docs.mutateCanvasDocument(user, { ...f.body('save'), document_json: JSON.stringify(graph()) }, 'POST'), paused);
  assert.equal(f.state.doc.document_json, original); assert.equal(f.state.writes.length, 0);
});
test('actual duplicate and newfield creation are paused before lossy serialization/allocation', async () => {
  const f = fixture(); await assert.rejects(() => docs.mutateCanvasDocument(user, f.body('duplicate'), 'PATCH'), paused);
  await assert.rejects(() => docs.mutateCanvasDocument(user, { ...f.body('save'), document_id: undefined, project_id: 'project', base_revision: 0,
    document_json: JSON.stringify(marked()) }, 'POST'), paused);
  assert.equal(f.state.writes.length, 0);
});
test('actual restore_revision guards selected marked historical JSON even if current doc is old', async () => {
  const f = fixture(graph()); f.state.history.set(1, { title: 'History', document_json: JSON.stringify(marked()) });
  await assert.rejects(() => docs.mutateCanvasDocument(user, { ...f.body('restore_revision'), target_revision: 1 }, 'PATCH'), paused);
  assert.equal(f.state.writes.length, 0);
});
test('metadata rename/archive/restore preserve exact JSON and original receipt replay', async () => {
  const f = fixture(), original = f.state.doc.document_json; let rename;
  for (const action of ['rename', 'archive', 'restore']) {
    const body = { ...f.body(action), document_json: JSON.stringify(graph()) };
    await docs.mutateCanvasDocument(user, body, 'PATCH'); if (action === 'rename') rename = body;
    assert.equal(f.state.doc.document_json, original); assert.equal(Object.hasOwn(f.state.writes.at(-1), 'document_json'), false);
  }
  const count = f.state.writes.length; assert.equal((await docs.mutateCanvasDocument(user, rename, 'PATCH')).replayed, true);
  assert.equal(f.state.writes.length, count); assert.equal(f.state.sealScans, 1);
});
test('original successful save receipt replays before pause after the document becomes marked', async () => {
  const f = fixture(graph()), body = { ...f.body('save'), document_json: JSON.stringify(graph()) };
  await docs.mutateCanvasDocument(user, body, 'POST'); f.state.doc.document_json = JSON.stringify(marked());
  const count = f.state.writes.length; assert.equal((await docs.mutateCanvasDocument(user, body, 'POST')).replayed, true);
  assert.equal(f.state.writes.length, count); assert.deepEqual(f.state.unknown, { requestId: 'original-unknown', provider_task_id: null, frozen: 10 }); assert.equal(f.state.balance, 1234);
});
test('old no-field save/read and original owner/project/CAS/archive protections remain', async () => {
  const f = fixture(graph()); await docs.mutateCanvasDocument(user, { ...f.body('save'), document_json: JSON.stringify(graph()) }, 'POST');
  assert.equal(JSON.parse(f.state.doc.document_json).canvasReferenceVersion, undefined);
  await assert.rejects(() => docs.mutateCanvasDocument(user, { ...f.body('rename'), base_revision: 0 }, 'PATCH'), error => error.code === 'revision_conflict');
  f.state.doc.owner_user_id = 'other'; await assert.rejects(() => docs.mutateCanvasDocument(user, f.body('rename'), 'PATCH'), error => error.status === 403); f.state.doc.owner_user_id = user.id;
  f.state.project.status = 'archived'; await assert.rejects(() => docs.mutateCanvasDocument(user, f.body('rename'), 'PATCH'), error => error.status === 403); f.state.project.status = 'active';
  f.state.doc.status = 'archived'; await assert.rejects(() => docs.mutateCanvasDocument(user, { ...f.body('save'), mutation_id: 'archived-save', document_json: JSON.stringify(graph()) }, 'POST'), error => error.code === 'document_archived');
});
test('actual video admission rejects marked docs before any slot/credit/provider work', async () => {
  const f = fixture(); await assert.rejects(() => admission.assertCanvasVideoAdmission(f.db, user,
    { canvas_document_id: 'document', canvas_node_id: 'node' }, null, { projectId: 'project', videoCardId: null, branchId: null, amount: 5 }), paused);
  assert.equal(f.state.writes.length, 0); assert.equal(f.state.balance, 1234);
});
test('actual accepted/unknown child restoration returns original task before new pause; unaccepted typed child pauses', async () => {
  const f = fixture();
  const frozen = { provider: 'seedance', model: 'seedance_2.0', project_id: 'project', video_card_id: null, video_branch_id: null,
    canvas_document_id: 'document', canvas_node_id: 'node', source_request_id: 'original-source', canvas_references: { version: 1, items: [] } };
  f.state.task = { id: 'original-task', user_id: user.id, owner_user_id: user.id, idempotency_key: 'original-child-key', project_id: 'project',
    video_card_id: null, video_branch_id: null, model: frozen.model, provider: frozen.provider, source_request_id: frozen.source_request_id,
    source_metadata_json: JSON.stringify({ canvas_document_id: 'document', canvas_node_id: 'node' }), local_status: 'submitted', retention_status: 'active', provider_task_id: null };
  f.state.child = { id: 'child', batch_id: 'batch', revision: 1, task_id: f.state.task.id, state: 'accepted', idempotency_key: 'original-child-key',
    business_fingerprint: admission.canvasBatchBusinessFingerprint(frozen), frozen_input_json: JSON.stringify(frozen),
    batch: { owner_user_id: user.id, project_id: 'project', video_card_id: null, video_branch_id: null, document_id: 'document', node_id: 'node', active_node_key: 'original-slot' } };
  const original = JSON.stringify(f.state.task), received = { canvas_video_batch: { contract_version: 1, batch_id: 'batch', child_id: 'child', child_revision: 1 }, idempotency_key: 'original-child-key' };
  originalReceiptReads = true;
  try {
    const result = await admission.restoreCanvasVideoBatchCreate(user, received, 'ordinary');
    assert.equal(result.existingTask, f.state.task); assert.equal(JSON.stringify(f.state.task), original); assert.equal(result.admission, null);
    if (!baseline) { f.state.child.task_id = null; f.state.child.state = 'prepared'; await assert.rejects(() => admission.restoreCanvasVideoBatchCreate(user, received, 'ordinary'), paused); }
    f.state.child.task_id = null; f.state.child.state = 'rejected'; f.state.child.rejection_receipt = JSON.stringify({ original: 'sealed' });
    await assert.rejects(() => admission.restoreCanvasVideoBatchCreate(user, received, 'ordinary'), error => error.code === 'canvas_video_batch_child_sealed' && error.details.rejection_receipt.original === 'sealed');
  } finally { originalReceiptReads = false; }
  assert.equal(f.state.writes.length, 0); assert.equal(f.state.balance, 1234);
});
if (!baseline) {
  const guard = load('src/lib/canvas-reference-rollback.ts');
  test('exact persisted markers and explicit malformed/empty newfields pause, ordinary fields do not', () => {
    for (const value of [marked(), { canvasReferenceVersion: 1 }, { requiredCapabilities: ['canvas.references.v1'] }, { canvas_references: null }, { canvas_references: { version: 1, items: [] } }]) assert.throws(() => guard.assertCanvasReferenceRollbackSafe(value), paused);
    for (const value of [graph(), {}, { required_capabilities: ['canvas.references.v1'] }, { reference_image_ids: ['old'] }]) assert.doesNotThrow(() => guard.assertCanvasReferenceRollbackSafe(value));
  });
  test('generation checks persisted document with supplied DB; no-field path and no-context use remain', async () => {
    const f = fixture(); for (const body of [{ canvas_document_id: 'document' }, { context: { documentId: 'document' } }, { source_metadata: { canvas_document_id: 'document' } }]) await assert.rejects(() => guard.assertCanvasGenerationRollbackSafe(user.id, body, f.db), paused);
    f.state.doc.document_json = JSON.stringify(graph()); await guard.assertCanvasGenerationRollbackSafe(user.id, { canvas_document_id: 'document' }, f.db);
    await guard.assertCanvasGenerationRollbackSafe(user.id, {}, new Proxy({}, { get() { throw Error('unrelated DB query'); } }));
    assert.equal(f.state.writes.length, 0);
  });
  test('actual synchronous admission keeps queued/unknown receipts before pause and writes nothing on new denial', async () => {
    const sync = load('src/lib/image-studio/synchronous-admission.ts');
    const input = { ownerId: user.id, requestId: 'synthetic-original-sync', fingerprint: 'original', count: 1, model: 'synthetic', scope: 'synthetic' };
    let row = { schema: 'image.sync-admission.v1', ...input, status: 'accepted_unknown' }, queued = false, called = 0, writes = 0;
    const db = { imageStudioTask: { findFirst: async () => queued ? { id: 'original-queued' } : null },
      platformSetting: { findUnique: async () => row ? { value_json: JSON.stringify(row) } : null, create: async () => { writes++; } } };
    const gate = async () => { called++; guard.assertCanvasReferenceRollbackSafe(marked()); };
    await assert.rejects(() => sync.createSynchronousImageAdmission(db, input, gate), error => error.status === 409 && error.requestId === input.requestId);
    assert.equal(called, 0); assert.equal(writes, 0);
    row = null; queued = true; await assert.rejects(() => sync.createSynchronousImageAdmission(db, input, gate), error => error.status === 409);
    assert.equal(called, 0); queued = false;
    await assert.rejects(() => sync.createSynchronousImageAdmission(db, input, gate), paused); assert.equal(called, 1); assert.equal(writes, 0);
    await sync.createSynchronousImageAdmission(db, input); assert.equal(writes, 1, 'unchanged no-field caller still admits without the optional guard');
  });
  test('actual image error projection reports known pause without accepting arbitrary 426 errors', () => {
    const file = 'src/lib/image-studio/tasks.ts', source = read(file);
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'studioBusinessErrorStatus');
    assert.ok(fn);
    const js = ts.transpileModule(fn.getText(ast).replace(/^export\s+/, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const project = new Function('StudioError', 'CanvasReferenceRollbackError', js + ';return studioBusinessErrorStatus;')(class extends Error {}, guard.CanvasReferenceRollbackError);
    assert.equal(project(new guard.CanvasReferenceRollbackError()), 426);
    assert.equal(project(Object.assign(new Error('unrelated'), { status: 426 })), null);
    assert.equal(project(Object.assign(new Error('original'), { status: 403 })), 403);
  });
  test('source placement retains original receipts before pause and uses original transaction at acceptance', () => {
    const source = file => fs.readFileSync(path.join(root, file), 'utf8');
    const before = (text, left, right, start = 0) => { const a = text.indexOf(left, start), b = text.indexOf(right, start); assert.ok(a >= 0 && b > a, left + ' must precede ' + right); };
    const image = source('src/lib/image-studio/tasks.ts'), intents = source('src/lib/creation/intents.ts');
    before(image, 'return batchId;', 'await assertCanvasGenerationRollbackSafe(ownerId, body, prisma)', image.indexOf('if (previous)'));
    before(image, 'if (duplicate)', 'await assertCanvasGenerationRollbackSafe(ownerId, body, tx)');
    before(intents, 'return projectIntent(user, previous, prisma)', 'await assertCanvasGenerationRollbackSafe(user.id, body, prisma)');
    assert.match(intents, /assertCanvasGenerationRollbackSafe\(user.id, JSON.parse\(previous.spec_json\).input \|\| \{\}, prisma\)/);
    assert.match(intents, /assertCanvasGenerationRollbackSafe\(user.id, JSON.parse\(current.spec_json\).input \|\| \{\}, tx\)/);
    before(intents, 'if (intent.accepted_task_id === accepted.taskId) return', 'await assertCanvasGenerationRollbackSafe(user.id, { ...spec.input, ...body }, tx)');
    const normal = source('src/app/api/tasks/create/route.ts');
    before(normal, ': NextResponse.json(payload);', '// Existing accepted requests return above');
    before(normal, 'await assertCanvasVideoAdmission(tx, user, body', 'const task = await tx.videoTask.create');
    const ip = source('src/app/api/ip/tasks/create/route.ts');
    before(ip, 'return ipDeduplicatedTaskResponse(existing)', 'await assertCanvasGenerationRollbackSafe(user.id, body, prisma)');
    before(ip, 'await assertCanvasVideoAdmission(tx, user, body', 'const task = await tx.videoTask.create');
    for (const kind of ['images', 'styles']) {
      const route = source('src/app/api/tools/ultimate-canvas/' + kind + '/generate/route.ts');
      assert.match(route, /if \(!original\) await assertCanvasGenerationRollbackSafe\(user.id, body, prisma\)/);
      assert.match(route, /canvas_document_id: context.documentId/);
    }
    const quote = source('src/app/api/tasks/estimate/route.ts');
    assert.match(quote, /await assertCanvasGenerationRollbackSafe\(user.id, body \|\| Object.fromEntries\(searchParams\), prisma\)/);
    assert.match(source('src/lib/pricing/video-context.ts'), /await assertCanvasGenerationRollbackSafe\(user.id, body, db\)/);
    const assets = source('src/app/api/assets/generate/route.ts');
    before(assets, 'await assertCanvasGenerationRollbackSafe(user.id, rollbackInput, prisma)', 'const referenceInputs = resolveImageGenerationReferenceInputs');
    assert.match(assets, /\(\) => assertCanvasGenerationRollbackSafe\(user.id, rollbackInput, tx\)/);
    assert.match(assets, /canvas_document_id: canvasDocumentId/);
    const draft = source('src/lib/tasks/seedance-draft-upgrade.ts');
    before(draft, 'if (existing) return', 'await assertCanvasGenerationRollbackSafe(input.user.id, rollbackInput, prisma)');
    assert.match(draft, /source_metadata: parseObject\(rollbackSource.source_metadata_json\) \}, tx\)/);
  });
}
(async () => { let failed = 0; for (const entry of tests) { try { await entry.run(); console.log('ok ' + entry.name); } catch (error) { failed++; console.error('not ok ' + entry.name + '\n' + error.stack); } }
  console.log(JSON.stringify({ suite: 'f24-derived-24e-rollback', baseline, total: tests.length, failed, nativePrisma: false, providerCalls: 0,
    limits: 'Actual functions with synthetic repository; native rollback/HTTP/private permission acceptance pending' })); process.exitCode = failed ? 1 : 0;
})();
