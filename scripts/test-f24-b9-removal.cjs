const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const test = require('node:test');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
function evaluate(source, globals = {}, imports = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, {
    URLSearchParams, Response, console, crypto: crypto.webcrypto, ...globals,
  })(name => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected fixture dependency: ${name}`);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}
function pickerHarness({ status = 'removed', stale = false } = {}) {
  const source = read('src/components/ResourceLibraryPicker.tsx');
  const ast = ts.createSourceFile('picker.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let arrow;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'upload' && ts.isArrowFunction(node.initializer)) arrow = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(arrow, 'actual upload callback retained');
  const state = { selected: [], removed: [], calls: [], uploaded: 0, error: '' };
  const session = { current: 1 }, active = { current: true };
  const apply = (key, value) => { state[key] = typeof value === 'function' ? value(state[key]) : value; };
  const globals = {
    active, session, sessionReady: true, locked: { current: false }, selected: [],
    browseRevision: { current: 0 }, sequence: { current: 0 }, readingMore: { current: false }, restoring: { current: false },
    types: ['image'], typesKey: 'image', labels: { image: '图片' }, target: 'workspace', confirmLabel: '添加',
    uploadReceipts: { current: new Map() }, failedUploadIds: { current: new WeakMap() },
    uniqueUploadFiles: async files => ({ files, duplicates: 0 }), canSelect: () => '', existing: () => false,
    onUploadFile: async () => { state.uploaded++; return { id: 'removed-original', originalUrl: '/uploads/synthetic.png' }; },
    fetch: async (url, init) => {
      state.calls.push({ url, method: init?.method || 'GET' });
      if (url.startsWith('/api/assets/library/removal?')) {
        if (stale) session.current++;
        return Response.json({ states: [{ identity: 'asset:removed-original', status }] });
      }
      return Response.json({ items: [], hasMore: false });
    },
    readJsonResponse: async response => response.json(), describeUploadFileError: error => ({ message: error.message }),
    reconcileUploadFailures: (_, __, next) => next,
    setSelected: value => apply('selected', value), setRemovedUploads: value => apply('removed', value),
    setError: value => { state.error = value; }, setFailedUploads: () => {}, setEpoch: () => {},
    setBusy: () => {}, setNotice: () => {}, setProgress: () => {}, setUploadLabel: () => {}, setNavigation: () => {},
    defaults: {}, prefs: {}, pickerFilterKey: () => '', setPrefs: () => {}, setQuery: () => {}, setPage: () => {}, setLoadedFilter: () => {},
  };
  const api = evaluate(`export const upload = ${arrow.getText(ast)};`, globals);
  return { state, run: () => api.upload([{ name: 'synthetic.png', type: 'image/png' }]) };
}
test('actual shared picker keeps a removed reused upload out of selection until explicit undo', async () => {
  const fixture = pickerHarness(); await fixture.run();
  assert.equal(fixture.state.uploaded, 1);
  assert.equal(fixture.state.selected.length, 0, 'removed original must not appear selected');
  assert.equal(fixture.state.removed[0]?.identity, 'asset:removed-original');
  assert.ok(fixture.state.calls.every(call => call.method === 'GET'), 'upload cannot silently undo removal');
});
test('stale removed-state response cannot affect a new picker session', async () => {
  const fixture = pickerHarness({ stale: true }); await fixture.run();
  assert.equal(fixture.state.selected.length, 0); assert.equal(fixture.state.removed.length, 0);
});
function restoreHarness({ unavailable = false, stale = false, limit = '', alreadyRestored = false } = {}) {
  const source = read('src/components/ResourceLibraryPicker.tsx');
  const ast = ts.createSourceFile('picker.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let arrow;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'removeItem' && ts.isArrowFunction(node.initializer)) arrow = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(arrow);
  const item = { identity: 'asset:removed-original', assetId: 'removed-original', fileName: 'synthetic.png', type: 'image', canRemoveFromLibrary: true };
  const state = { selected: [], removed: [item], restored: alreadyRestored ? [item.identity] : [], error: '', posts: 0, reads: 0 };
  const session = { current: 1 }, locked = { current: false }, active = { current: true };
  const apply = (key, value) => { state[key] = typeof value === 'function' ? value(state[key]) : value; };
  const api = evaluate(`export const restore = ${arrow.getText(ast)};`, {
    session, locked, active, selected: [], user: { id: 'synthetic-owner' }, removedUploads: [item],
    restoredUploadIds: state.restored, target: 'workspace', typesKey: 'image',
    fetch: async (url, init) => {
      if (init?.method === 'POST') {
        state.posts++; assert.equal(JSON.parse(init.body).removed, false);
        return Response.json({ identity: item.identity, removed: false });
      }
      state.reads++;
      if (stale) { session.current++; locked.current = true; }
      return Response.json({ items: [{ ...item, ...(unavailable ? { unavailableReason: 'synthetic revoked source' } : {}) }] });
    },
    readJsonResponse: response => response.json(), canSelect: () => limit,
    setSelected: value => apply('selected', value), setRemovedUploads: value => apply('removed', value),
    setRestoredUploadIds: value => apply('restored', value), setError: value => { state.error = value; },
    setBusy: () => {}, setRemovedItem: () => {}, setRemovedInSession: () => {}, setEpoch: () => {}, setNotice: () => {},
    localStorage: { removeItem: () => {} },
  });
  return { state, locked, run: () => api.restore(item, true) };
}
test('explicit undo selects only a freshly authorized current item', async () => {
  const fixture = restoreHarness(); await fixture.run();
  assert.equal(fixture.state.posts, 1); assert.equal(fixture.state.reads, 1);
  assert.equal(fixture.state.selected[0]?.identity, 'asset:removed-original');
  assert.equal(fixture.state.removed.length, 0); assert.equal(fixture.state.error, '');
});
test('restoration success with lost permission or selection limit preserves the explicit retry without selecting', async () => {
  for (const options of [{ unavailable: true }, { limit: 'synthetic limit exceeded' }]) {
    const fixture = restoreHarness(options); await fixture.run();
    assert.equal(fixture.state.posts, 1); assert.equal(fixture.state.selected.length, 0);
    assert.equal(fixture.state.removed.length, 1); assert.equal(fixture.state.restored.length, 1);
    assert.ok(fixture.state.error.startsWith('已撤销移出'));
  }
});
test('an already confirmed undo retries metadata only, and stale metadata cannot unlock a new session', async () => {
  const retry = restoreHarness({ alreadyRestored: true }); await retry.run();
  assert.equal(retry.state.posts, 0); assert.equal(retry.state.reads, 1); assert.equal(retry.state.selected.length, 1);
  const stale = restoreHarness({ stale: true }); await stale.run();
  assert.equal(stale.state.selected.length, 0); assert.equal(stale.locked.current, true);
});
test('own-state lookup stays bounded, distinguishes removed from unavailable, and never writes', async () => {
  let writes = 0;
  const db = {
    asset: { findMany: async ({ where, select, take }) => {
      assert.equal(where.owner_id, 'owner'); assert.equal(where.status, 'active'); assert.ok(take <= 60);
      assert.deepEqual(Object.keys(select), ['id']);
      return where.id.in.filter(id => ['removed', 'available'].includes(id)).map(id => ({ id }));
    } },
    platformSetting: { findMany: async ({ where, take }) => {
      assert.ok(take <= 60);
      return where.key.in.filter(key => key.endsWith(':removed')).map(key => ({ key, value_json: '{"removed":true}' }));
    }, upsert: () => { writes++; } },
  };
  const helper = evaluate(read('src/lib/assets/library-removal.ts'), {}, {
    '@/lib/prisma': { prisma: db }, '@/lib/tasks/retention': { USER_VISIBLE_TASK_RETENTION_STATUSES: ['active'] },
  });
  const result = await helper.readOwnLibraryRemovalStates('owner', ['asset:removed', 'asset:available', 'asset:foreign', 'asset:removed'], db);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [
    { identity: 'asset:removed', status: 'removed' }, { identity: 'asset:available', status: 'available' },
    { identity: 'asset:foreign', status: 'unavailable' },
  ]);
  for (const ids of [['asset:../x'], Array.from({ length: 61 }, (_, i) => `asset:x${i}`)]) {
    await assert.rejects(helper.readOwnLibraryRemovalStates('owner', ids, {}));
  }
  assert.equal(writes, 0);
});
