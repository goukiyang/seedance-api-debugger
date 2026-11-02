// Isolated engineering fixtures: no production DB, HTTP, assets or Feishu calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
// Reuse the existing real-module feedback fixture, with an explicit session stub.
const harness = fs.readFileSync(path.join(__dirname, 'test-f24-feedback-flow.cjs'), 'utf8').split("test('actual admin PATCH")[0]
  .replace('const dependencies = {', `const dependencies = {
    '@/lib/auth/session': { getSession: async () => users.get(env.SYNTHETIC_SESSION_USER || 'author') || null },
    '@/lib/assets/upload-log': { recordAssetUploadLog: async () => {} },`);
const fixtureModule = { exports: {} };
vm.runInNewContext(harness + '\nmodule.exports = fixture;', { require, __dirname, module: fixtureModule, console, Response, Request, Headers, Buffer, URL, setTimeout, clearTimeout, AbortSignal });
function fixture() {
  const f = fixtureModule.exports(); let sequence = 0, queue = Promise.resolve();
  f.db.feedback.create = async ({ data }) => { const row = { ...data, id: `synthetic-feedback-${++sequence}` }; f.feedback.set(row.id, row); return row; };
  f.db.platformSetting.findMany = async ({ where }) => [...f.settings.values()].filter(row => where.key.in.includes(row.key));
  f.db.$transaction = run => {
    const operation = queue.then(async () => {
      const before = [f.feedback, f.settings, f.notifications].map(map => [...map]);
      try { return await run(f.db); } catch (error) {
        [f.feedback, f.settings, f.notifications].forEach((map, i) => { map.clear(); before[i].forEach(([key, value]) => map.set(key, value)); }); throw error;
      }
    });
    queue = operation.catch(() => {}); return operation;
  };
  return { ...f, submission: f.load('src/lib/feedback/submission.ts'), bridge: f.load('src/app/api/bridge/feedback/route.ts'), website: f.load('src/app/api/feedback/route.ts') };
}
const body = () => ({ operationId: 'synthetic-original-operation', expectedUserId: 'author', content: 'Synthetic issue', imageUrls: [], uploadedAssetIds: [],
  context: { site: 'chatgpt', extensionVersion: '0.3.7', pageUrl: 'https://chatgpt.com/c/example?secret=excluded#excluded' } });
function request(data, query = '') {
  const req = new Request(`https://synthetic.invalid/api/bridge/feedback${query}`, data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {});
  req.nextUrl = new URL(req.url); return req;
}
test('actual website and bridge share one transaction receipt, replay never recreates outbox', async () => {
  const f = fixture(), input = body();
  const first = await f.bridge.POST(request(input)); assert.equal(first.status, 201);
  const accepted = await first.json(); assert.equal(accepted.replayed, false); assert.equal(f.notifications.size, 1);
  const parallel = await Promise.all([f.bridge.POST(request(input)), f.bridge.POST(request(input))]);
  for (const response of parallel) { assert.equal(response.status, 200); assert.equal((await response.json()).feedback.id, accepted.feedback.id); }
  assert.equal(f.feedback.size, 2); assert.equal(f.notifications.size, 1); // includes fixture's pre-existing feedback
  const query = await f.bridge.GET(request(null, '?operationId=synthetic-original-operation&expectedUserId=author'));
  const data = await query.json(); assert.equal(data.status, 'accepted'); assert.equal(data.feedback.id, accepted.feedback.id);
  assert.deepEqual(Object.keys(data).sort(), ['attachments', 'feedback', 'replayed', 'status', 'success']);
  assert.ok(!JSON.stringify(data).includes(input.content));
  const websiteConflict = await f.website.POST(request({ ...input, context: undefined, pathname: '/plugin/chatgpt' }));
  assert.equal(websiteConflict.status, 409); assert.equal((await websiteConflict.json()).code, 'FEEDBACK_OPERATION_CONFLICT');
});
test('mismatch and anonymous bridge are rejected and never write; not_found is a read-only result', async () => {
  const f = fixture();
  let response = await f.bridge.POST(request({ ...body(), expectedUserId: 'foreign' }));
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'FEEDBACK_IDENTITY_MISMATCH');
  f.env.SYNTHETIC_SESSION_USER = 'guest'; response = await f.bridge.POST(request(body()));
  assert.equal(response.status, 401); assert.equal((await response.json()).code, 'FEEDBACK_AUTH_REQUIRED');
  f.env.SYNTHETIC_SESSION_USER = 'foreign'; response = await f.bridge.GET(request(null, '?operationId=synthetic-original-operation&expectedUserId=foreign'));
  assert.equal((await response.json()).status, 'not_found'); assert.equal(f.settings.size, 0); assert.equal(f.notifications.size, 0);
});
test('frozen input conflict, attachment replay and partial-save counts preserve the original decision', async () => {
  const f = fixture(), input = { ...body(), imageUrls: ['/uploads/own.png', '/uploads/foreign.png'], uploadedAssetIds: ['own', 'foreign'] };
  f.db.asset.findMany = async () => [{ id: 'own', owner_id: 'author', type: 'image', status: 'active', original_url: '/uploads/own.png', hash: 'a'.repeat(64), mime_type: 'image/png', file_size: 100 },
    { id: 'foreign', owner_id: 'foreign', type: 'image', status: 'active', original_url: '/uploads/foreign.png', hash: 'b'.repeat(64), mime_type: 'image/png', file_size: 100 }];
  const first = await f.bridge.POST(request(input)), saved = await first.json();
  assert.deepEqual(saved.attachments, { saved: 1, notSaved: 1 });
  f.db.asset.findMany = async () => { throw new Error('Replay must not re-read changed assets'); };
  const replay = await f.bridge.POST(request(input)); assert.equal(replay.status, 200); assert.deepEqual((await replay.json()).attachments, saved.attachments);
  const conflict = await f.bridge.POST(request({ ...input, content: 'Different input' }));
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).code, 'FEEDBACK_OPERATION_CONFLICT');
});
test('source metadata is bounded, canonical and queryable by precise keys; original notification maps source', async () => {
  const f = fixture(), response = await f.bridge.POST(request(body())), data = await response.json();
  const row = f.feedback.get(data.feedback.id); assert.equal(row.pathname, '/plugin/chatgpt'); assert.equal(row.page_url, 'https://chatgpt.com/c/example');
  const sources = await f.submission.feedbackSources(f.db, [row.id]);
  assert.equal(sources.get(row.id).extensionVersion, '0.3.7'); assert.ok(!JSON.stringify([...sources.values()]).includes('excluded'));
  assert.equal(f.notification.feedbackPageName(row.pathname), '插件 · ChatGPT');
  assert.equal(JSON.parse([...f.notifications.values()][0].metadata_json).preparation.page, '插件 · ChatGPT');
  for (const pageUrl of ['https://foreign.invalid/', 'https://user:password@chatgpt.com/', 'http://chatgpt.com/']) {
    const rejected = await f.bridge.POST(request({ ...body(), operationId: `invalid-${Math.random().toString(16).slice(2)}`, context: { ...body().context, pageUrl } }));
    assert.equal(rejected.status, 400);
  }
});
test('notification write failure rolls feedback/source/receipt back; unreadable receipt remains unknown', async () => {
  const f = fixture(); f.db.notification.create = async () => { throw new Error('synthetic write error'); };
  const failed = await f.bridge.POST(request(body())); assert.equal(failed.status, 503); assert.equal((await failed.json()).code, 'FEEDBACK_RESULT_UNKNOWN');
  assert.equal(f.feedback.size, 1); assert.equal(f.settings.size, 0);
  f.settings.set('feedback-submit:v1:author:synthetic-original-operation', { key: 'feedback-submit:v1:author:synthetic-original-operation', value_json: '{invalid' });
  const unknown = await f.bridge.GET(request(null, '?operationId=synthetic-original-operation&expectedUserId=author'));
  assert.equal(unknown.status, 503); assert.equal((await unknown.json()).code, 'FEEDBACK_RESULT_UNKNOWN'); assert.equal(f.feedback.size, 1);
});
test('legacy website anonymous/no-operation behavior remains; new guest request replays in the same domain', async () => {
  const f = fixture(); f.env.SYNTHETIC_SESSION_USER = 'guest';
  const legacy = { content: 'Synthetic visitor feedback', imageUrls: ['/uploads/no-owner.png'], uploadedAssetIds: ['foreign'] };
  const first = await f.website.POST(request(legacy)); assert.equal(first.status, 201); assert.deepEqual((await first.json()).attachments, { saved: 0, notSaved: 1 });
  const input = { ...legacy, operationId: 'guest-original', expectedUserId: null };
  assert.equal((await f.website.POST(request(input))).status, 201); assert.equal((await f.website.POST(request(input))).status, 200);
  assert.equal(f.feedback.size, 3); assert.equal(f.notifications.size, 2);
  const query = await f.website.GET(request(null, '?operationId=guest-original&expectedUserId=')); assert.equal((await query.json()).status, 'accepted');
});
function widgetFunction(name, context) {
  const file = path.join(root, 'src/components/FeedbackWidget.tsx'), source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let value; const walk = node => { if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) value = node.initializer; ts.forEachChild(node, walk); }; walk(source);
  assert.ok(value, name); const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule('module.exports = ' + value.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { ...context, module }); return module.exports;
}
test('actual widget persists frozen operation before emit; unknown action queries, explicit retry keeps original input', async () => {
  const stored = new Map(), calls = [], ctx = { submittingRef: { current: false }, draftIdentityReadyRef: { current: true }, draftKeyRef: { current: 'draft-author' },
    ownerRef: { current: 'author' }, pendingRef: { current: null }, contentRef: { current: 'original content' }, uploadsRef: { current: [] },
    crypto: { randomUUID: () => 'widget-original-operation' }, window: { location: { href: 'https://synthetic.invalid/page', pathname: '/page' } }, URLSearchParams,
    feedbackPendingKey: key => `${key}:pending`, localStorage: { setItem: (key, value) => stored.set(key, value) },
    setError: () => {}, setMessage: () => {}, setOriginalNotFound: () => {}, setPending: value => { ctx.pendingRef.current = value; }, setSubmitting: () => {},
    fetch: async (_url, init) => { assert.ok(stored.size); calls.push(init?.body ? JSON.parse(init.body) : null); throw new Error('synthetic lost receipt'); }, finishSubmission: () => {} };
  const submit = widgetFunction('submit', ctx); await submit();
  assert.equal(calls[0].operationId, 'widget-original-operation');
  ctx.contentRef.current = 'new draft edits'; await submit(); assert.equal(calls[1], null);
  // Reload uses the exact persisted operation, not current editable content.
  const frozen = JSON.parse([...stored.values()][0]); assert.equal(frozen.content, 'original content');
  ctx.pendingRef.current = frozen;
  ctx.fetch = async (_url, init) => { calls.push(init?.body ? JSON.parse(init.body) : null); return Response.json(init?.body ? { success: true, feedback: { id: 'saved' } } : { success: true, status: 'not_found' }); };
  await widgetFunction('submit', ctx)(true); assert.equal(calls.at(-1).content, 'original content'); assert.equal(calls.at(-1).operationId, frozen.operationId);
});
test('actual widget cannot send without durable storage; successful late result cleans only original draft', async () => {
  const stored = new Map(), original = { operationId: 'original', content: 'old content', uploadIds: ['old-image'] };
  const ctx = { draftKeyRef: { current: 'new-account' }, readFeedbackDraft: () => ({ content: 'later original-account edit', uploads: [{ id: 'old-image' }, { id: 'new-image' }] }),
    localStorage: { setItem: (key, value) => stored.set(key, JSON.parse(value)), removeItem: key => stored.delete(key) }, feedbackPendingKey: key => key + ':pending' };
  widgetFunction('finishSubmission', ctx)('old-account', original, { feedback: { id: 'accepted' } });
  assert.equal(stored.get('old-account').content, 'later original-account edit'); assert.equal(stored.get('old-account').uploads[0].id, 'new-image'); assert.ok(!stored.has('new-account'));
});
