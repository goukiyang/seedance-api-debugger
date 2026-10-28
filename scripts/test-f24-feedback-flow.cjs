const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function fixture() {
  const env = { NODE_ENV: 'test', FEISHU_FEEDBACK_ENABLED: 'true', FEISHU_FEEDBACK_RECIPIENT_USER_ID: 'admin',
    FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret', FEISHU_ALLOWED_TENANT_KEY: 'synthetic-tenant' };
  env.FEISHU_FEEDBACK_IDENTITY_SHA256 = crypto.createHash('sha256').update(JSON.stringify(['admin', 'synthetic-admin', env.FEISHU_APP_ID, env.FEISHU_ALLOWED_TENANT_KEY])).digest('hex');
  const users = new Map(['admin', 'author', 'foreign'].map(id => [id, { id, status: 'active',
    role: id === 'admin' ? 'admin' : 'user', expires_at: null, feishu_open_id: `synthetic-${id}`, feishu_tenant_key: env.FEISHU_ALLOWED_TENANT_KEY }]));
  const feedback = new Map([['feedback-one', { id: 'feedback-one', user_id: 'author', content: 'Synthetic issue', pathname: '/generate',
    task_id: null, image_urls_json: null, created_at: new Date().toISOString(), status: 'reviewed', admin_note: 'internal-only-do-not-publish' }]]);
  const settings = new Map(), notifications = new Map(), transactionOptions = [], sends = [];
  let sendError = false;
  const select = (row, projection) => row == null ? null : projection ? Object.fromEntries(Object.keys(projection).map(key => [key, row[key]])) : clone(row);
  const insert = (map, key, data) => { if (map.has(key)) throw Object.assign(new Error('duplicate synthetic record'), { code: 'P2002' }); map.set(key, clone(data)); return clone(data); };
  const db = {
    user: { findUnique: async ({ where, select: fields }) => select(users.get(where.id), fields) },
    feedback: { findUnique: async ({ where, select: fields }) => select(feedback.get(where.id), fields),
      update: async ({ where, data }) => { const row = { ...feedback.get(where.id), ...data }; feedback.set(where.id, row); return row; } },
    platformSetting: { findUnique: async ({ where }) => clone(settings.get(where.key)) ?? null,
      create: async ({ data }) => insert(settings, data.key, data),
      updateMany: async ({ where, data }) => {
        const row = settings.get(where.key);
        if (!row || row.value_json !== where.value_json) return { count: 0 };
        settings.set(where.key, { ...row, ...data }); return { count: 1 };
      } },
    notification: { findUnique: async ({ where, select: fields }) => select(notifications.get(where.id), fields),
      findMany: async ({ where, take }) => [...notifications.values()].filter(row => row.type === where.type && row.status === where.status).slice(0, take).map(clone),
      updateMany: async ({ where, data }) => {
        const row = notifications.get(where.id);
        if (!row || row.status !== where.status || row.metadata_json !== where.metadata_json) return { count: 0 };
        Object.assign(row, data); return { count: 1 };
      },
      create: async ({ data }) => insert(notifications, data.id, data) },
    asset: { findMany: async () => [] },
    $transaction: async (run, options) => { transactionOptions.push(options); return run(db); },
  };
  const modules = new Map();
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const module = { exports: {} }; modules.set(file, module.exports);
    const output = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
      fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const dependencies = {
      '@prisma/client': { PrismaClient: class { constructor() { return db; } } }, '@/lib/prisma': { prisma: db },
      'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
      '@/lib/auth/api-helpers': { getAdminUser: async () => users.get('admin'), errorJson: (error, status) => Response.json({ error }, { status }) },
      '@/lib/navigation': { adminNavItems: [], userNavItems: [], isNavItemActive: () => false },
      '@/lib/assets/site-url': { siteUploadPathFromUrl: value => typeof value === 'string' && value.startsWith('/uploads/') ? value : null },
    };
    vm.runInNewContext(`(function(require,module,exports){${output}\n})`, {
      Buffer, URL, Headers, Request, Response, console, process: { env }, setTimeout, clearTimeout, AbortSignal,
      fetch: async (url, init) => {
        if (url.includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'synthetic-token' });
        const body = JSON.parse(init.body); sends.push(body);
        const row = notifications.get(body.uuid), metadata = JSON.parse(row.metadata_json);
        assert.equal(metadata.ambiguousSend, true); assert.ok(metadata.firstSendAt && metadata.leaseUntil);
        if (sendError) throw new Error('synthetic transport interruption');
        return Response.json({ code: 0, data: { message_id: 'synthetic-retest-message' } });
      },
    })(name => {
      if (name in dependencies) return dependencies[name];
      if (name.startsWith('node:') || name === 'sharp') return require(name);
      if (name === '@/lib/feishu/feedback-relay') return load('src/lib/feishu/feedback-relay.ts');
      if (name.startsWith('@/lib/feedback/')) return load(`src/lib/feedback/${name.slice('@/lib/feedback/'.length)}.ts`);
      if (name.startsWith('./')) return load(path.posix.join(path.posix.dirname(file), name.slice(2) + '.ts'));
      throw new Error(`Unexpected fixture dependency: ${name}`);
    }, module, module.exports);
    modules.set(file, module.exports);
    return module.exports;
  }
  const lifecycle = load('src/lib/feedback/lifecycle.ts');
  const notification = load('src/lib/feedback/notification.ts');
  const flow = load('src/lib/feedback/flow-state.ts');
  return { env, users, feedback, settings, notifications, db, load, lifecycle, notification, flow, transactionOptions, sends,
    failSend: () => { sendError = true; } };
}
test('actual admin PATCH has an explicit repair action, distinct from reviewed/archive', async () => {
  const f = fixture(), route = f.load('src/app/api/admin/feedback/[id]/route.ts');
  const response = await route.PATCH(new Request('https://synthetic.invalid/api/admin/feedback/feedback-one', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'mark_fixed', operationId: 'repair-op-one', revision: 0, summary: 'Synthetic public fix' }),
  }), { params: { id: 'feedback-one' } });
  const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.round?.round, 1);
  assert.equal(f.notifications.size, 1);
});
test('repair original operation replays the same round/event, normal view never exposes admin note', async () => {
  const f = fixture(), input = { operationId: 'repair-op-one', revision: 0, summary: 'Synthetic public fix' };
  const first = await f.lifecycle.markFeedbackFixed(f.db, 'admin', 'feedback-one', input);
  const replay = await f.lifecycle.markFeedbackFixed(f.db, 'admin', 'feedback-one', input);
  assert.equal(first.round.round, 1); assert.equal(replay.replayed, true); assert.equal(f.notifications.size, 1);
  await assert.rejects(f.lifecycle.markFeedbackFixed(f.db, 'admin', 'feedback-one', { ...input, summary: 'changed same operation' }));
  const view = await f.lifecycle.feedbackLifecycleView(f.db, 'author', 'feedback-one');
  assert.equal(view.round.review, null); assert.equal(view.round.delivery.status, 'pending');
  assert.ok(!JSON.stringify(view).includes('internal-only-do-not-publish'));
  assert.ok(!JSON.stringify(view).includes(envSecret(f)));
});
test('ordinary reviewed/archive save does not publish a repair or enqueue retest', async () => {
  const f = fixture(), route = f.load('src/app/api/admin/feedback/[id]/route.ts');
  const response = await route.PATCH(new Request('https://synthetic.invalid/api/admin/feedback/feedback-one', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'reviewed' }),
  }), { params: { id: 'feedback-one' } });
  assert.equal(response.status, 200); assert.equal(f.notifications.size, 0); assert.equal(f.settings.size, 0);
});
function envSecret(f) { return f.env.FEISHU_APP_SECRET; }
test('actual author form submits original asset URLs with IDs, not preview URLs; unknown retry preserves the body', async () => {
  const file = path.join(root, 'src/components/feedback/FeedbackLifecyclePanel.tsx');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let submit;
  function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'submit') submit = node; ts.forEachChild(node, visit); }
  visit(source); assert.ok(submit);
  const module = { exports: {} }, bodies = [], pending = { operationId: 'original-unknown-operation', round: 1, result: 'needs_work', note: 'original note', imageUrls: ['/uploads/original.png'], uploadedAssetIds: ['original-asset'] };
  const context = { module, crypto: { randomUUID: () => 'synthetic-review-operation' }, admin: false, owner: 'author',
    usable: () => true, lock: { current: false }, view: { round: { number: 1 } }, hydrated: 'synthetic-scope', scope: 'synthetic-scope', pending: null,
    draft: { result: 'passed', note: ' Synthetic note ', assets: [{ id: 'own-asset', url: '/api/preview/own', originalUrl: '/uploads/original.png' }] },
    endpoint: '/api/feedback/feedback-one', remember: () => {}, setPending: () => {}, setBusy: () => {}, setError: () => {}, setDraft: () => {}, empty: {},
    AbortSignal, refresh: async () => {}, fetch: async (_url, init) => { bodies.push(JSON.parse(init.body)); throw new Error('synthetic unknown transport'); } };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule('module.exports = ' + submit.getText(source), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  await module.exports();
  assert.deepEqual(bodies[0].imageUrls, ['/uploads/original.png']); assert.deepEqual(bodies[0].uploadedAssetIds, ['own-asset']);
  context.pending = pending; await module.exports(); assert.deepEqual(bodies[1], pending);
});
test('retest delivery saves send intent and receipt once, without changing repair or feedback outcome', async () => {
  const f = fixture();
  await f.lifecycle.markFeedbackFixed(f.db, 'admin', 'feedback-one', { operationId: 'repair-op-one', revision: 0, summary: 'Synthetic fix' });
  const original = f.settings.get(f.flow.feedbackRoundKey('feedback-one', 1)).value_json;
  const delivery = f.load('src/lib/feedback/retest-delivery.ts');
  assert.equal((await delivery.processFeedbackRetestDeliveries()).sent, 1);
  assert.equal((await delivery.processFeedbackRetestDeliveries()).sent, 0);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].receive_id, 'synthetic-author');
  assert.equal([...f.notifications.values()][0].status, 'sent');
  assert.equal(f.settings.get(f.flow.feedbackRoundKey('feedback-one', 1)).value_json, original);
  assert.equal(f.feedback.get('feedback-one').status, 'reviewed');
});
test('retest delivery rejects changed author binding or source, never falls back to another recipient', async () => {
  for (const change of ['binding', 'owner', 'inactive']) {
    const f = fixture();
    await f.lifecycle.markFeedbackFixed(f.db, 'admin', 'feedback-one', { operationId: 'repair-op-one', revision: 0, summary: 'Synthetic fix' });
    if (change === 'binding') f.users.get('author').feishu_open_id = 'synthetic-new-binding';
    if (change === 'owner') f.feedback.get('feedback-one').user_id = 'foreign';
    if (change === 'inactive') f.users.get('author').status = 'disabled';
    const result = await f.load('src/lib/feedback/retest-delivery.ts').processFeedbackRetestDeliveries();
    assert.equal(result.failed, 1); assert.equal(f.sends.length, 0);
  }
});
test('an already reviewed or superseded round never starts a new retest send', async () => {
  for (const reason of ['reviewed', 'superseded']) {
    const f = fixture();
    await f.lifecycle.markFeedbackFixed(f.db, 'admin', 'feedback-one', { operationId: 'repair-op-one', revision: 0, summary: 'Synthetic fix' });
    if (reason === 'reviewed') await f.lifecycle.reviewFeedbackFix(f.db, 'author', 'feedback-one', { operationId: 'review-op-one', round: 1, result: 'passed' });
    else await f.lifecycle.markFeedbackFixed(f.db, 'admin', 'feedback-one', { operationId: 'repair-op-two', revision: 1, summary: 'Synthetic newer fix' });
    await f.load('src/lib/feedback/retest-delivery.ts').processFeedbackRetestDeliveries(1);
    const first = [...f.notifications.values()][0];
    assert.equal(first.status, 'failed'); assert.equal(f.sends.length, 0);
    assert.match(first.error_message, /already_reviewed|superseded/);
  }
});
test('retest unknown send keeps original UUID and safety window, and never resends after the window', async () => {
  const f = fixture();
  await f.lifecycle.markFeedbackFixed(f.db, 'admin', 'feedback-one', { operationId: 'repair-op-one', revision: 0, summary: 'Synthetic fix' });
  const delivery = f.load('src/lib/feedback/retest-delivery.ts');
  f.failSend(); await delivery.processFeedbackRetestDeliveries();
  const row = [...f.notifications.values()][0], meta = JSON.parse(row.metadata_json), uuid = meta.uuid;
  assert.equal(row.status, 'pending'); assert.equal(meta.ambiguousSend, true); assert.ok(meta.firstSendAt);
  meta.firstSendAt = Date.now() - 51 * 60_000; meta.nextAttemptAt = 0; row.metadata_json = JSON.stringify(meta);
  assert.equal((await delivery.processFeedbackRetestDeliveries()).unknown, 1);
  assert.equal(f.sends.length, 1); assert.equal(JSON.parse(row.metadata_json).uuid, uuid);
  assert.equal(JSON.parse(row.metadata_json).state, 'unknown');
});
test('only original author may review, needs-work reopens without changing the old round or admin note', async () => {
  const f = fixture();
  await f.lifecycle.markFeedbackFixed(f.db, 'admin', 'feedback-one', { operationId: 'repair-op-one', revision: 0, summary: 'Synthetic public fix' });
  const input = { operationId: 'review-op-one', round: 1, result: 'needs_work', note: 'Synthetic still wrong' };
  for (const user of ['foreign', 'admin']) await assert.rejects(f.lifecycle.reviewFeedbackFix(f.db, user, 'feedback-one', input), error => error.status === 404);
  for (const invalid of [{ result: ['passed'] }, { round: '1' }, { imageUrls: ['/uploads/foreign.png'], uploadedAssetIds: ['foreign'] }]) {
    await assert.rejects(f.lifecycle.reviewFeedbackFix(f.db, 'author', 'feedback-one', { ...input, ...invalid }));
  }
  const first = await f.lifecycle.reviewFeedbackFix(f.db, 'author', 'feedback-one', input);
  const replay = await f.lifecycle.reviewFeedbackFix(f.db, 'author', 'feedback-one', input);
  assert.equal(first.round.review.result, 'needs_work'); assert.equal(replay.replayed, true);
  assert.equal(f.feedback.get('feedback-one').status, 'new');
  assert.equal(f.feedback.get('feedback-one').admin_note, 'internal-only-do-not-publish');
  assert.equal(f.notifications.size, 1, 'review does not enqueue another outbound message');
});
test('unbound or anonymous author records honest unavailable state, no fabricated recipient', async () => {
  for (const anonymous of [true, false]) {
    const f = fixture();
    if (anonymous) f.feedback.get('feedback-one').user_id = null; else f.users.get('author').feishu_open_id = null;
    const saved = await f.lifecycle.markFeedbackFixed(f.db, 'admin', 'feedback-one', { operationId: 'repair-op-one', revision: 0, summary: 'Synthetic public fix' });
    assert.equal(saved.round.notificationId, null); assert.equal(f.notifications.size, 0);
    assert.ok(saved.round.notificationUnavailable);
  }
});
test('new feedback ack binds exact original recipient/nonce/message, duplicates do not rewrite receive state', async () => {
  const f = fixture();
  await f.notification.enqueueFeedbackNotification(f.db, { id: 'feedback-one', content: 'Synthetic issue', pathname: '/generate' }, { id: 'author', name: 'Synthetic' }, 0);
  const job = [...f.notifications.values()][0], meta = JSON.parse(job.metadata_json);
  assert.equal(job.type, 'feedback_ack_feishu_v1'); assert.equal(meta.ackVersion, 1);
  assert.ok(f.settings.has(f.flow.feedbackFlowKey('feedback-one')));
  const args = { feedbackId: 'feedback-one', nonce: meta.ackNonce, openId: 'synthetic-admin', messageId: 'synthetic-message' };
  await assert.rejects(f.lifecycle.acknowledgeFeedback(f.db, args), error => error.status === 409);
  job.status = 'sent'; meta.receiptId = 'synthetic-message'; meta.state = 'sent'; job.metadata_json = JSON.stringify(meta);
  for (const invalid of [{ nonce: '0'.repeat(48) }, { openId: 'synthetic-author' }, { messageId: 'other-message' }]) {
    await assert.rejects(f.lifecycle.acknowledgeFeedback(f.db, { ...args, ...invalid }));
  }
  const received = await f.lifecycle.acknowledgeFeedback(f.db, args);
  const before = f.settings.get(f.flow.feedbackFlowKey('feedback-one')).value_json;
  const replay = await f.lifecycle.acknowledgeFeedback(f.db, args);
  assert.equal(replay.receivedAt, received.receivedAt);
  assert.equal(f.settings.get(f.flow.feedbackFlowKey('feedback-one')).value_json, before);
});
test('actual callback checks independent purpose; card rendering cannot undo durable acknowledgment', async () => {
  const f = fixture();
  await f.notification.enqueueFeedbackNotification(f.db, { id: 'feedback-one', content: 'Synthetic issue', pathname: '/generate' }, { id: 'author', name: 'Synthetic' }, 0);
  const job = [...f.notifications.values()][0], meta = JSON.parse(job.metadata_json);
  job.status = 'sent'; meta.receiptId = 'synthetic-message'; meta.state = 'sent';
  meta.message = { msgType: 'interactive', content: JSON.stringify({ elements: [null] }) };
  job.metadata_json = JSON.stringify(meta);
  const route = f.load('src/app/api/feishu/feedback-actions/route.ts');
  const body = JSON.stringify({ header: { app_id: f.env.FEISHU_APP_ID, tenant_key: f.env.FEISHU_ALLOWED_TENANT_KEY, event_type: 'card.action.trigger' },
    event: { operator: { open_id: 'synthetic-admin', tenant_key: f.env.FEISHU_ALLOWED_TENANT_KEY },
      action: { value: { source: 'sd2_feedback_ack_v1', feedbackId: 'feedback-one', nonce: meta.ackNonce, action: 'ack' } } },
    context: { open_message_id: 'synthetic-message' } });
  const request = purpose => {
    const time = String(Date.now());
    return new Request('https://synthetic.invalid/api/feishu/feedback-actions', { method: 'POST', body,
      headers: { 'x-sd2-feedback-time': time, 'x-sd2-feedback-signature': crypto.createHmac('sha256', f.env.FEISHU_APP_SECRET).update(`${purpose}\n${time}\n${body}`).digest('hex') } });
  };
  assert.equal((await route.POST(request('sd2-credit-relay-v1'))).status, 401);
  const response = await route.POST(request('sd2-feedback-relay-v1')), data = await response.json();
  assert.equal(response.status, 200); assert.equal(data.toast.type, 'success'); assert.equal(data.card, undefined);
  assert.ok(JSON.parse(f.settings.get(f.flow.feedbackFlowKey('feedback-one')).value_json).acknowledgment.receivedAt);
  assert.equal(f.transactionOptions.at(-1).maxWait, 750); assert.equal(f.transactionOptions.at(-1).timeout, 1250);
});
