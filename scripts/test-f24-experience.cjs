'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const tests = [];
const test = (name, work) => tests.push({ name, work });
const location = new URL('https://synthetic.invalid/multiview');
function load(file, imports = {}, globals = {}) {
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const requireFixture = name => {
    if (Object.hasOwn(imports, name)) return imports[name];
    if (name.startsWith('node:') || ['react', 'react/jsx-runtime', 'lucide-react'].includes(name)) return require(name);
    if (name.endsWith('.css')) return new Proxy({}, { get: (_, key) => String(key) });
    throw Error('Unprovided fixture boundary: ' + name);
  };
  vm.runInNewContext(`(function(require,module,exports){${javascript}\n})`, {
    console, URL, Blob, Headers, Response, AbortController, AbortSignal, DOMException, crypto: require('node:crypto').webcrypto,
    location, setTimeout, clearTimeout, queueMicrotask, TextEncoder, TextDecoder, ...globals,
  }, { filename: file })(requireFixture, module, module.exports);
  return module.exports;
}
const readerImports = {
  './hd-source-session': { registerImageReadFamilyInvalidator() {}, invalidateHdImageSource() {}, setHdImageSessionOwner() {} },
  './image-comparison-contract': { COMPARISON_VERSION_HEADER: 'X-Image-Comparison-Version', COMPARISON_VERSION_PARAM: 'comparison-version' },
};
test('actual reader preserves the complete blob scheme and opaque identity', () => {
  const reader = load('src/lib/media/image-read-session.ts', readerImports);
  const blob = 'blob:https://synthetic.invalid/one-frame';
  assert.equal(reader.canonicalImageReadSource(blob), blob);
  assert.equal(reader.canonicalImageReadSource('/api/image?b=2&a=1'), '/api/image?a=1&b=2');
});
test('versioned local frames require explicit original-frame context, not arbitrary blob URLs', () => {
  const reader = load('src/lib/media/image-read-session.ts', readerImports);
  assert.equal(typeof reader.acquireLocalFrameRead, 'function');
  let current = true, retained = 0;
  const controller = new AbortController(), source = 'blob:https://synthetic.invalid/original';
  const frame = { kind: 'local-frame', account: 'actor:user:internal', authority: 'actor-authority', sourceKind: 'work', sourceId: 'work', taskId: 'task', sourceVersion: 'a'.repeat(64),
    frame: 3, width: 16, height: 16, generation: 1, blob: new Blob(['synthetic-png'], { type: 'image/png' }), url: source, signal: controller.signal,
    isCurrent: () => current, retain: () => { retained++; return () => retained--; }, authorize: async () => {} };
  let result;
  const release = reader.acquireLocalFrameRead(frame.account, source, frame.sourceVersion, frame, value => result = value);
  assert.equal(result.imageSrc, source); assert.equal(result.decoded, true); assert.equal(retained, 1);
  for (const [account, url, version] of [['other', source, frame.sourceVersion], [frame.account, source + '-other', frame.sourceVersion], [frame.account, source, 'b'.repeat(64)]]) {
    reader.acquireLocalFrameRead(account, url, version, frame, value => result = value); assert.equal(result.imageSrc, null); assert.equal(result.denied, true);
  }
  current = false; assert.equal(reader.localFrameMatches(frame, frame.account, source, frame.sourceVersion), false);
  controller.abort(); assert.equal(result.imageSrc, null);
  release(); release(); assert.equal(retained, 0);
});
test('actual ordinary HTTP comparison and source version mismatches remain closed', async () => {
  for (const comparison of [true, false]) {
    let resolve, requested;
    const done = new Promise(value => resolve = value);
    const reader = load('src/lib/media/image-read-session.ts', readerImports, {
      navigator: {}, document: { hidden: false }, Image: class { naturalWidth = 16; naturalHeight = 16; async decode() {} },
      fetch: async source => { requested = source; return new Response('synthetic-png', { headers: { 'content-type': 'image/png', 'X-Image-Source-Version': 'wrong', 'X-Image-Comparison-Version': 'wrong' } }); },
    });
    const release = reader.acquireImageRead('actor', '/api/reference-images/ref/content' + (comparison ? '?comparison-version=expected' : ''), 'expected', 0,
      result => { if (result.unconfirmed || result.refreshSource) resolve(result); });
    const result = await done; assert.equal(result.imageSrc, null); assert.match(requested, /^\/api\/reference-images\//); release();
  }
});
test('clipboard write starts in the gesture, uses original PNG and rejects late frame changes', async () => {
  for (const stale of [false, true]) {
    let finish, current = true, retained = 0, written = null;
    const authorization = new Promise(resolve => finish = resolve), events = [];
    const blob = new Blob(['unchanged-original-png'], { type: 'image/png' });
    const frame = { kind: 'local-frame', account: 'actor', authority: 'authority', sourceKind: 'task', sourceId: 'task', taskId: 'task', sourceVersion: 'a'.repeat(64), frame: 0,
      width: 16, height: 16, generation: 1, blob, url: 'blob:https://synthetic.invalid/frame', signal: new AbortController().signal,
      isCurrent: () => current, authorize: () => authorization, retain: () => { retained++; return () => retained--; } };
    const reader = load('src/lib/media/image-read-session.ts', readerImports);
    const copy = load('src/lib/media/copy-image.ts', { './image-read-session': reader }, {
      ClipboardItem: class { constructor(data) { this.data = data; } },
      navigator: { clipboard: { write: async items => { events.push('write'); const value = await items[0].data['image/png']; written = value; } } },
      fetch() { throw Error('Local frames must not HEAD or fetch a forged HTTP source'); },
    });
    const promise = copy.copyImage(frame.url, { localFrame: frame, expectedVersion: frame.sourceVersion });
    assert.deepEqual(events, ['write']); assert.equal(written, null); assert.equal(retained, 1);
    if (stale) current = false;
    finish();
    if (stale) { await assert.rejects(promise, error => error.name === 'AbortError'); assert.equal(written, null); }
    else { await promise; assert.equal(written, blob); }
    await Promise.resolve(); assert.equal(retained, 0);
  }
});
test('actual slot copy keeps committed slot identity through reordering and cancels a reframe', async () => {
  const file = 'src/app/multiview/page.tsx', source = fs.readFileSync(path.join(root, file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); let copySource, slotSource;
  const visit = node => { if (ts.isFunctionDeclaration(node) && node.name?.text === 'copySlotFrame') copySource = node.getText(ast);
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'currentSlotFrame') slotSource = node.initializer.getText(ast); ts.forEachChild(node, visit); }; visit(ast);
  assert.ok(copySource && slotSource);
  for (const stale of [false, true]) {
    const events = [], notices = [], draftRef = { current: { slots: [{ id: 'slot-a', frame: 3 }, { id: 'slot-b', frame: 4 }] } };
    let finish, writePromise, copied = null, retained = 0, releaseFinished;
    const released = new Promise(resolve => releaseFinished = resolve);
    const authorization = new Promise(resolve => finish = resolve), blob = new Blob(['original-committed'], { type: 'image/png' });
    const copy = load('src/lib/media/copy-image.ts', { './image-read-session': {} }, {
      ClipboardItem: class { constructor(data) { this.data = data; } }, navigator: { clipboard: { write: items => {
        events.push('clipboard-start'); writePromise = Promise.resolve(items[0].data['image/png']).then(value => { copied = value; }); return writePromise;
      } } },
    });
    const frameCopy = { current: null }, context = { current: 1 };
    const local = { blob, isCurrent: () => true, retain: () => { retained++; return () => { retained--; releaseFinished(); }; }, authorize: () => authorization };
    const bindings = { draftRef, frameCopy, context, setCopyingFrame() {}, owner: 'actor', authority: 'authority', ownerRef: { current: 'actor' }, authorityRef: { current: 'authority' },
      isClientSessionBlocked: () => false, loadFrame: async () => true, frameRef: { current: { 3: { localFrame: local } } }, copyPngBlob: copy.copyPngBlob, setNotice: value => notices.push(value) };
    const code = ts.transpileModule(`const currentSlotFrame = ${slotSource};\n${copySource}\nreturn copySlotFrame;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const run = new Function(...Object.keys(bindings), code)(...Object.values(bindings));
    run(draftRef.current.slots[0]); assert.deepEqual(events, ['clipboard-start']);
    await Promise.resolve();
    if (stale) draftRef.current.slots[0] = { id: 'slot-a', frame: 5 }; else draftRef.current.slots.reverse();
    finish(); if (stale) await assert.rejects(writePromise, error => error.name === 'AbortError'); else await writePromise;
    await released;
    assert.equal(copied, stale ? null : blob); assert.equal(notices.includes('原尺寸PNG已复制'), !stale); assert.equal(retained, 0);
  }
});
test('actual clipboard helpers keep denied and unsupported writes as failures', async () => {
  for (const supported of [false, true]) {
    const copy = load('src/lib/media/copy-image.ts', { './image-read-session': {} }, {
      ClipboardItem: class { constructor(data) { this.data = data; } }, navigator: supported ? { clipboard: { write: () => Promise.reject(new DOMException('Synthetic denial', 'NotAllowedError')) } } : {},
    });
    await assert.rejects(copy.copyPngBlob(new Blob(['original-png'], { type: 'image/png' })));
  }
});
test('completed reuse accessor retains receipt and applied-target metadata', () => {
  const client = load('src/lib/navigation/task-reuse-client.ts', { './task-reuse-intent': {} });
  assert.equal(typeof client.readCompletedTaskReuse, 'function');
  assert.equal(typeof client.taskReuseUndoMatches, 'function');
});
test('actual completed receipt rejects account/tab/target/receipt changes but allows later edits and two-way target restore', async () => {
  const storage = new Map(); const localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const intent = load('src/lib/navigation/task-reuse-intent.ts');
  const client = load('src/lib/navigation/task-reuse-client.ts', { './task-reuse-intent': intent }, { localStorage, sessionStorage: localStorage });
  const operation = await intent.buildTaskReuseOperationRequest('actor', 'task', { surface: 'normal', tabId: 'tab', workspaceId: 'workspace', expectedWorkspaceAssets: [] });
  const before = { projectId: 'before-project', videoCardId: '', videoBranchId: '' }, after = { projectId: 'after-project', videoCardId: 'card', videoBranchId: '' };
  const backup = { version: 1, workspace: { ownerId: 'actor', epoch: 1, tabId: 'tab', workspaceId: 'workspace', items: [] }, fields: { prompt: 'Original input', generationMode: 'all_in_one_reference', ratio: '16:9', duration: 5, resolution: '480p', seed: -1, generateAudio: false, returnLastFrame: false, watermark: false, resolutionApprovalConfirmed: false, model: 'model', ...before } };
  const record = { version: 2, accountId: 'actor', sourceTaskId: 'task', operation, context: { accountId: 'actor', tabId: 'tab', workspaceBridgeKey: 'bridge' }, backup };
  client.saveTaskReuseClientRecord(record);
  client.finishTaskReuseClientRecord(record, 'unknown'); assert.equal(client.readCompletedTaskReuse('actor', 'tab'), null);
  client.finishTaskReuseClientRecord(record, 'applied'); assert.equal(client.readCompletedTaskReuse('actor', 'tab'), null, 'legacy/partial completion is not proven form application');
  client.finishTaskReuseClientRecord(record, 'applied', { reuseKey: 1, workspaceBridgeKey: 'bridge', target: after, inputReplaced: true });
  const completed = client.readCompletedTaskReuse('actor', 'tab'); assert.ok(completed); assert.equal(completed.operation.nonce, operation.nonce);
  const scope = { accountId: 'actor', surface: 'normal', workspaceBridgeKey: 'bridge', tabId: 'tab', workspaceId: 'workspace', ...after };
  assert.equal(client.taskReuseUndoMatches(completed, { ...scope, editEpoch: 999 }), true, 'later edits do not invalidate an otherwise valid undo');
  for (const key of ['accountId', 'surface', 'workspaceBridgeKey', 'tabId', 'workspaceId', 'projectId', 'videoCardId', 'videoBranchId']) assert.equal(client.taskReuseUndoMatches(completed, { ...scope, [key]: 'different' }), false, key);
  assert.equal(client.taskReuseUndoMatches(completed, { ...scope, ...before }, 'redo'), true);
  assert.equal(client.sameTaskReuseReceipt(completed, { ...completed, operation: { ...operation, nonce: 'changed' } }), false);
  assert.equal(client.taskReuseReplacedInput(backup, backup), false);
  assert.equal(client.taskReuseReplacedInput(backup, { ...backup, fields: { ...backup.fields, prompt: 'Changed' } }), true);
  assert.equal(client.taskReuseReplacedInput({ ...backup, fields: { ...backup.fields, prompt: '' } }, { ...backup, fields: { ...backup.fields, prompt: 'New' } }), false);
  assert.equal(client.readCompletedTaskReuse('other', 'tab'), null); assert.equal(client.readCompletedTaskReuse('actor', 'other-tab'), null);
});
test('actual composer recovery captures later input before writing and never overwrites fields after a stale or unknown result', async () => {
  const file = 'src/components/GenerationComposer.tsx', source = fs.readFileSync(path.join(root, file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); let implementation;
  const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'restoreInputRecovery') implementation = node.initializer.getText(ast); ts.forEachChild(node, visit); }; visit(ast);
  assert.ok(implementation);
  const javascript = ts.transpileModule(`const restore = ${implementation};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText + '\nreturn restore;';
  for (const outcome of ['success', 'later-edit', 'receipt-change', 'unknown']) {
    const events = [], messages = []; let edit = 0, receipt = true, paired = null;
    const previous = { workspace: { ownerId: 'actor', epoch: 1 }, restoreFields: () => events.push('restore-original-fields') };
    const next = { workspace: { ownerId: 'actor', epoch: 1 }, restoreFields: () => events.push('restore-later-fields') };
    class WorkspaceInputRecoveryError extends Error { constructor() { super('Synthetic unknown association'); this.associationConfirmed = false; } }
    const revision = { get current() { return edit; } };
    const bindings = { inputRecovery: previous, inputRecoveryBusy: false, interactionLocked: false, inputRecoveryPair: null,
      workspace: { loading: false, pendingWorkspaceAttach: false, restoreRecovery: async () => { events.push('write-association'); if (outcome === 'later-edit') edit++; if (outcome === 'receipt-change') receipt = false; if (outcome === 'unknown') throw new WorkspaceInputRecoveryError(); } },
      recoveryReceiptCurrent: () => receipt, setInputRecoveryIssue() {}, setInputRecoveryMessage: message => messages.push(message), makeInputRecovery: () => { events.push('capture-later'); return next; },
      setInputRecoveryPair: value => paired = value, markReuseInputChanged: () => edit++, reuseEditRevisionRef: revision, readRecoveryScope: () => 'scope', setInputRecoveryBusy() {},
      runWorkspaceOperation: operation => operation(), uploadSession: () => ({ ownerId: 'actor', epoch: 1 }), setInputRecovery: value => events.push(value === next ? 'retain-later' : 'retain-other'),
      WorkspaceInputRecoveryError, recoveryBinding: { side: 'undo' }, setRecoveryBinding() {},
    };
    const restore = new Function(...Object.keys(bindings), javascript)(...Object.values(bindings));
    await restore(); assert.ok(events.indexOf('capture-later') < events.indexOf('write-association'));
    if (outcome === 'success') { assert.ok(events.includes('restore-original-fields')); assert.ok(events.includes('retain-later')); }
    else { assert.equal(events.includes('restore-original-fields'), false); assert.equal(paired.next, next); assert.ok(messages.length); }
  }
});
test('actual records directory projects the submitter and same-group ready thumbnail without recipe data', async () => {
  const info = { taskId: 'task-synthetic', sourceVersion: 'a'.repeat(64), width: 16, height: 16, timestamps: Array.from({ length: 8 }, (_, i) => i) };
  const recipe = { schema: 2, sourceVersion: info.sourceVersion, slots: [0, 1, 2].map(frame => ({ id: 'slot-' + frame, frame, name: '', manual: false, locked: false })), reserve: [], restoreOrder: [], layout: { columns: 3, margin: 0, gap: 0, background: '#ffffff' } };
  const hash = require('node:crypto').createHash('sha256').update(JSON.stringify(recipe)).digest('hex');
  const manifest = { schema: 1, sourceVersion: info.sourceVersion, revision: 1, recipeHash: hash, width: 48, height: 16, frameCount: 3,
    files: ['thumbnail', 'collage', 'zip', ...recipe.slots.map(slot => 'frame-' + slot.id)].map((role, i) => ({ role, file: `file-${i}.${role === 'zip' ? 'zip' : 'png'}`, mime: role === 'zip' ? 'application/zip' : 'image/png', bytes: 4, sha256: 'b'.repeat(64), ...(role === 'zip' ? {} : { width: 16, height: 16 }) })) };
  const row = { id: 'work-synthetic', owner_id: 'viewer', source_task_id: info.taskId, source_id: null, source_version: info.sourceVersion,
    title: 'Synthetic result', created_at: new Date('2026-10-28T00:00:00Z'), project_id: null, status: 'ready', ready_revision: 1,
    source_info_json: JSON.stringify(info), ready_recipe_json: JSON.stringify(recipe), ready_manifest_json: JSON.stringify(manifest) };
  let people = [{ id: 'submitter', name: 'Synthetic author', username: null, avatar_url: null, account_type: 'internal' }], workRows = [row], inputTask = null, inputView = false, inputReads = 0;
  const prisma = {
    videoTask: { findMany: async () => [{ id: info.taskId, user_id: 'submitter', created_at: row.created_at, local_status: 'succeeded', project_id: null, project: null }], findUnique: async () => inputTask },
    multiviewWork: { findMany: async () => workRows }, user: { findMany: async query => { assert.deepEqual(Object.keys(query.select).sort(), ['avatar_url', 'id', 'name', 'username']); return people; } },
    asset: { findUnique: async () => ({ id: 'main-only', status: 'active', type: 'image' }) },
  };
  class AuthError extends Error { constructor(message, status) { super(message); this.status = status; } }
  const contract = load('src/lib/video/multiview-work-contract.ts', { './multiview-contract': load('src/lib/video/multiview-contract.ts') });
  const server = load('src/lib/video/multiview-records.server.ts', {
    '@/lib/prisma': { prisma }, '@/lib/auth/session': { AuthError }, '@/lib/tasks/retention': { USER_VISIBLE_TASK_RETENTION_STATUSES: ['active'] },
    './multiview-task-privacy': { privateMultiviewTaskWhere: () => ({}) },
    './multiview-works': { currentMultiviewActor: async () => {}, assertMultiviewWorkReference: async () => {}, MultiviewWorkError: Error,
      multiviewWorkRecipeHash: value => require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex') },
    './multiview-work-contract': contract, './multiview-private-create.server': { readSafePrivateMultiviewInput: () => ({ snapshot: { mainAssetId: 'main-only', mainReferenceImageId: 'main-reference', systemImage: 'must-not-project' } }) },
    '@/lib/content-reactions/content': { resolveContent: async () => { inputReads++; return { summary: { category: 'image', thumbnailUrl: '/api/content-reactions/media?key=reference_image%3Amain-reference&variant=thumbnail' }, source: { url: 'https://private-original.invalid', recipe: 'must-not-project' } }; } },
    '@/lib/reference-albums/permissions': { assertCanViewReferenceImage: async () => { if (!inputView) throw new AuthError('No input view right', 403); return { asset_id: 'main-only' }; } },
    '@/lib/users/display': load('src/lib/users/display.ts'),
  }, { Buffer });
  const result = await server.listMultiviewRecords({ id: 'viewer' }, { q: '', projectId: '', removed: false, cursor: null });
  assert.equal(result.items[0].creator?.id, 'submitter');
  assert.equal(result.items[0].cover?.candidates[0].kind, 'result');
  assert.match(result.items[0].coverUrl, /\/files\/thumbnail\?readyRevision=1$/);
  assert.equal(JSON.stringify(result).includes('recipeHash'), false);
  assert.equal(result.total, 1);
  people = []; workRows = [{ ...row, id: 'latest-broken', ready_manifest_json: '{}' }, row];
  inputTask = { owner_user_id: 'viewer', user_id: 'viewer', model: 'synthetic' };
  let next = await server.listMultiviewRecords({ id: 'viewer' }, { q: '', projectId: '', removed: false, cursor: null });
  assert.equal(next.items[0].creator, null, 'missing original creator cannot fall back to the viewer/work owner');
  assert.match(next.items[0].coverUrl, /works\/work-synthetic\/files\/thumbnail/);
  assert.equal(next.items[0].cover.candidates.some(value => value.kind === 'input'), false); assert.equal(inputReads, 0, 'output access does not grant input view');
  inputView = true;
  next = await server.listMultiviewRecords({ id: 'viewer' }, { q: '', projectId: '', removed: false, cursor: null });
  assert.equal(next.items[0].cover.candidates.at(-1).kind, 'input'); assert.equal(inputReads, 1);
  assert.equal(JSON.stringify(next).includes('must-not-project'), false); assert.equal(JSON.stringify(next).includes('private-original.invalid'), false);
  inputTask.owner_user_id = 'other';
  next = await server.listMultiviewRecords({ id: 'viewer' }, { q: '', projectId: '', removed: false, cursor: null });
  assert.equal(next.items[0].cover.candidates.some(value => value.kind === 'input'), false); assert.equal(inputReads, 1);
});
test('actual record aggregation keeps 1000 rows, exact count, all pages and scope filtering independent of cover availability', async () => {
  const rows = Array.from({ length: 1000 }, (_, index) => ({ id: `task-${String(index).padStart(4, '0')}`, user_id: null, owner_user_id: 'actor',
    created_at: new Date('2026-10-28T00:00:00Z'), local_status: 'failed', project_id: null, project: null }));
  const prisma = { videoTask: { findMany: async query => {
    assert.equal(query.take, 128); const owner = query.where.AND[1].OR[0].owner_user_id;
    return rows.filter(row => row.owner_user_id === owner && (!query.cursor || row.id > query.cursor.id)).slice(0, query.take);
  }, findUnique: async () => null }, multiviewWork: { findMany: async () => [] } };
  const server = load('src/lib/video/multiview-records.server.ts', {
    '@/lib/prisma': { prisma }, '@/lib/auth/session': { AuthError: Error }, '@/lib/tasks/retention': { USER_VISIBLE_TASK_RETENTION_STATUSES: ['active'] },
    './multiview-task-privacy': { privateMultiviewTaskWhere: () => ({}) }, './multiview-works': { currentMultiviewActor: async () => {}, MultiviewWorkError: Error },
    './multiview-work-contract': {}, './multiview-private-create.server': {}, '@/lib/content-reactions/content': {}, '@/lib/reference-albums/permissions': {},
    '@/lib/users/display': {},
  }, { Buffer });
  let cursor = null; const seen = new Set();
  do {
    const page = await server.listMultiviewRecords({ id: 'actor' }, { q: '', projectId: '', removed: false, cursor });
    assert.equal(page.total, 1000); assert.ok(page.items.length <= 24);
    for (const item of page.items) { assert.equal(seen.has(item.id), false); seen.add(item.id); assert.equal(item.creator, null); }
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.size, 1000);
  const one = await server.listMultiviewRecords({ id: 'actor' }, { q: 'task-0999', projectId: '', removed: false, cursor: null }); assert.equal(one.total, 1);
  const empty = await server.listMultiviewRecords({ id: 'other' }, { q: '', projectId: '', removed: false, cursor: null }); assert.equal(empty.total, 0);
});
test('drawer scope places tools above the video without changing the default player', () => {
  const { renderToStaticMarkup } = require('react-dom/server');
  const React = require('react');
  const component = load('src/components/AssetPreviewMedia.tsx', {
    '@/lib/hooks/use-media-preview-state': { useMediaPreviewState: () => ({ ready: true, key: 'actor:video', value: { currentTime: 0 }, update() {} }), useVideoLoopState: () => ({ enabled: false, ready: true, toggle() {} }) },
    '@/components/VideoLoopButton': { VideoLoopButton: () => React.createElement('button', null, 'loop-fixture') },
    '@/components/MultiviewEntry': { MultiviewEntry: () => React.createElement('a', null, 'multiview-fixture') },
    '@/lib/context/AppSessionContext': { useAppSession: () => ({ user: { id: 'actor' }, sessionChanged: false }) },
    '@/lib/auth/client-session-boundary': { isClientSessionBlocked: () => false },
    '@/lib/media/asset-playback': { replaceAssetMedia: () => null },
  }).AssetPreviewMedia;
  const props = { kind: 'video', contentKey: 'video_task:synthetic-task', src: '/synthetic-video', title: 'Synthetic', taskId: 'synthetic-task', onClaim() {}, onRelease() {} };
  const drawer = renderToStaticMarkup(React.createElement(component, { ...props, scope: 'drawer' }));
  const ordinary = renderToStaticMarkup(React.createElement(component, props));
  assert.ok(drawer.indexOf('loop-fixture') < drawer.indexOf('<video'));
  assert.ok(drawer.includes('synthetic-task'));
  assert.ok(ordinary.indexOf('loop-fixture') > ordinary.indexOf('<video'));
  assert.equal(ordinary.includes('synthetic-task'), false);
  const uploaded = renderToStaticMarkup(React.createElement(component, { ...props, scope: 'drawer', contentKey: 'asset:synthetic-upload' }));
  assert.equal(uploaded.includes('任务编号'), false);
});
test('drawer copy waits for actual clipboard resolution and rejects stale account/target success', async () => {
  const React = require('react');
  for (const stale of [false, true]) {
    const refs = [], states = []; let finish, written;
    const pending = new Promise(resolve => finish = resolve);
    const hooks = { ...React, useState: initial => [initial, value => states.push(value)], useRef: initial => { const ref = { current: initial }; refs.push(ref); return ref; },
      useEffect: effect => { effect(); }, useCallback: callback => callback };
    const component = load('src/components/AssetPreviewMedia.tsx', {
      react: hooks,
      '@/lib/hooks/use-media-preview-state': { useMediaPreviewState: () => ({ ready: true, key: 'actor:video', value: { currentTime: 0 }, update() {} }), useVideoLoopState: () => ({ enabled: false, ready: true, toggle() {} }) },
      '@/components/VideoLoopButton': { VideoLoopButton() {} }, '@/components/MultiviewEntry': { MultiviewEntry() {} },
      '@/lib/context/AppSessionContext': { useAppSession: () => ({ user: { id: 'actor' }, hasLoadedUser: true, sessionChanged: false }) },
      '@/lib/auth/client-session-boundary': { isClientSessionBlocked: () => false }, '@/lib/media/asset-playback': { replaceAssetMedia: () => null },
    }, { navigator: { clipboard: { writeText: text => { written = text; return pending; } } } }).AssetPreviewMedia;
    const tree = component({ kind: 'video', scope: 'drawer', contentKey: 'video_task:synthetic-task', taskId: 'synthetic-task', src: '/synthetic', title: 'Synthetic', onClaim() {}, onRelease() {} });
    let button;
    const walk = node => { if (!node || typeof node !== 'object') return; if (node.props?.['aria-label'] === '复制任务编号') button = node; const children = node.props?.children; for (const child of Array.isArray(children) ? children : [children]) if (Array.isArray(child)) child.forEach(walk); else walk(child); }; walk(tree);
    assert.ok(button); button.props.onClick(); assert.equal(written, 'synthetic-task'); assert.equal(states.includes('已复制'), false);
    if (stale) refs.find(ref => ref.current?.owner === 'actor').current = { owner: 'other', taskId: 'other', src: '/other' };
    finish(); await pending; await Promise.resolve(); assert.equal(states.includes('已复制'), !stale);
  }
});
test('actual cover reader distinguishes temporary, absent, denied, version and identity outcomes', async () => {
  const module = load('src/app/multiview/multiview-record-cover.ts');
  for (const status of [429, 500, 503, 0]) assert.equal(module.recordCoverFailure(status), 'retryable');
  for (const [status, phase] of [[401, 'signed-out'], [403, 'denied'], [404, 'missing'], [410, 'missing'], [409, 'refresh']]) assert.equal(module.recordCoverFailure(status), phase);
  for (const statuses of [[429], [404], [403], [409], [401, 200], [503, 200]]) {
    let calls = 0;
    const reader = load('src/app/multiview/multiview-record-cover.ts', {}, {
      Image: class { naturalWidth = 16; naturalHeight = 16; async decode() {} },
      fetch: async () => { const status = statuses[calls++]; return new Response(status === 200 ? 'synthetic-image' : '', { status, headers: { 'content-type': 'image/png' } }); },
    }).createRecordCoverReader();
    const result = await reader({ cover: { candidates: statuses.map((_, index) => ({ url: '/api/synthetic/' + index, kind: index ? 'input' : 'result' })), retryable: false } }, 'actor', new AbortController().signal);
    const expected = statuses[0] === 503 ? 'ready' : module.recordCoverFailure(statuses[0]);
    assert.equal(result.phase, expected);
    if (statuses[0] === 401) assert.equal(calls, 1, 'identity rejection never probes another candidate');
    if (statuses[0] === 503) { assert.equal(result.kind, 'input'); assert.equal(result.retryable, true); }
    result.release?.(); result.release?.();
  }
});
test('actual cover reader bounds concurrency and cancels queued stale reads', async () => {
  let running = 0, maximum = 0, requests = 0;
  const gates = [];
  const reader = load('src/app/multiview/multiview-record-cover.ts', {}, {
    Image: class { naturalWidth = 16; naturalHeight = 16; async decode() {} },
    fetch: async () => { requests++; running++; maximum = Math.max(maximum, running); await new Promise(resolve => gates.push(resolve)); running--; return new Response('synthetic-image', { headers: { 'content-type': 'image/png' } }); },
  }).createRecordCoverReader();
  const item = { cover: { candidates: [{ url: '/api/synthetic/image', kind: 'result' }], retryable: false } };
  const a = reader(item, 'actor', new AbortController().signal), b = reader(item, 'actor', new AbortController().signal);
  const controller = new AbortController(), cancelled = reader(item, 'actor', controller.signal); controller.abort();
  assert.equal(requests, 2); gates.splice(0).forEach(resolve => resolve());
  const results = await Promise.all([a, b]); await assert.rejects(cancelled, error => error.name === 'AbortError');
  assert.equal(maximum, 2); assert.equal(requests, 2); results.forEach(result => result.release?.());
});
test('changed TS/TSX parse and original submit assembly remains intact outside the exercised notification field', () => {
  const files = ['src/lib/media/image-read-session.ts', 'src/lib/media/image-preview-session.ts', 'src/lib/media/copy-image.ts',
    'src/lib/navigation/task-reuse-client.ts', 'src/lib/video/multiview-records.server.ts', 'src/app/multiview/page.tsx',
    'src/app/multiview/MultiviewFrameControls.tsx', 'src/app/multiview/MultiviewRecords.tsx', 'src/app/multiview/multiview-record-cover.ts',
    'src/components/ZoomableImagePreview.tsx', 'src/components/AssetPreviewMedia.tsx', 'src/components/GenerationComposer.tsx',
    'src/components/generate/GeneratePageClient.tsx', 'src/components/generate/TaskReuseStatus.tsx', 'src/app/assets/page.tsx'];
  for (const file of files) {
    const result = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { fileName: file, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } });
    assert.equal(result.diagnostics?.filter(value => value.category === ts.DiagnosticCategory.Error).length, 0, file);
  }
  // Preserve 24e assembly, excluding only the two notification additions exercised by test-f24-video-ui.
  const expected = ['7f7f351f3f81c97d84cccb9953ecd6d80e8492f64c5d482ab2d6024d0d56049f', '57ffb387a66f2707e103681a4709217485c9b3a9cd6649cebe9f595e86cb3a19'];
  let index = 0;
  for (const file of ['src/components/generate/GeneratePageClient.tsx', 'src/components/GenerationComposer.tsx']) {
    const current = fs.readFileSync(path.join(root, file), 'utf8');
    const submit = source => { const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); let found;
      const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handleSubmit' || ts.isFunctionDeclaration(node) && node.name?.text === 'handleSubmit') { assert.equal(found, undefined); found = node.getText(ast); } ts.forEachChild(node, visit); }; visit(ast); assert.ok(found); return found; };
    let assembly = submit(current);
    if (file.endsWith('/GeneratePageClient.tsx')) {
      for (const addition of ['\n        ...(!isIpSurface && videoFeishu.choice ? { video_feishu: videoFeishu.choice } : {}),', '\n    videoFeishu.choice,']) {
        assert.equal(assembly.split(addition).length, 2, 'exact notification addition only');
        assembly = assembly.replace(addition, '');
      }
    }
    assert.equal(require('node:crypto').createHash('sha256').update(assembly).digest('hex'), expected[index++], file + ' submit assembly');
  }
});

(async () => {
  let failed = 0;
  const selected = tests.filter(test => !process.env.F24_TEST || test.name.includes(process.env.F24_TEST));
  for (const { name, work } of selected) {
    let timer;
    try { await Promise.race([work(), new Promise((_, reject) => timer = setTimeout(() => reject(Error('bounded pure fixture timeout')), 10000))]); console.log('PASS ' + name); }
    catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.message); }
    finally { clearTimeout(timer); }
  }
  console.log(`${selected.length - failed}/${selected.length} passed; synthetic pure/helper/render only`);
  process.exitCode = failed ? 1 : 0;
})();
