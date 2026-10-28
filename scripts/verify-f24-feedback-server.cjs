'use strict';

// Linux-only engineering proof. A new private SQLite file and synthetic identities are mandatory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash, createHmac, randomBytes } = require('node:crypto');
let phase = 'guard', directory, prisma, feedbackDb, externalAttempts = 0;
const passed = [], sent = [];
const root = fs.realpathSync(path.join(__dirname, '..'));
const write = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
async function main() {
  assert.equal(process.platform, 'linux'); assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.F24_FEEDBACK_SYNTHETIC_PROOF, '1');
  assert.equal(globalThis.prisma, undefined); assert.equal(globalThis.feedbackPrisma, undefined);
  directory = fs.mkdtempSync('/tmp/f24-feedback-'); fs.chmodSync(directory, 0o700);
  const database = path.join(directory, 'proof.db'); fs.writeFileSync(database, '', { flag: 'wx', mode: 0o600 });
  for (const key of Object.keys(process.env)) if (/^(FEISHU_|PRIVATE_PROMPTS_|R2_|TOS_|SESSION_SECRET$|DATABASE_URL$)/.test(key)) delete process.env[key];
  Object.assign(process.env, { DATABASE_URL: `file:${database}`, SESSION_SECRET: randomBytes(48).toString('hex'),
    FEISHU_APP_ID: 'f24-synthetic-app', FEISHU_APP_SECRET: randomBytes(32).toString('hex'), FEISHU_ALLOWED_TENANT_KEY: 'f24-synthetic-tenant',
    FEISHU_FEEDBACK_ENABLED: 'true', FEISHU_FEEDBACK_RECIPIENT_USER_ID: 'f24-admin' });
  process.env.FEISHU_FEEDBACK_IDENTITY_SHA256 = createHash('sha256').update(JSON.stringify(['f24-admin', 'f24-open-admin', process.env.FEISHU_APP_ID, process.env.FEISHU_ALLOWED_TENANT_KEY])).digest('hex');
  const deny = () => { externalAttempts++; throw new Error('f24_external_network_prohibited'); };
  for (const name of ['node:http', 'node:https']) { require(name).get = deny; require(name).request = deny; }
  for (const name of ['node:net', 'node:tls']) { require(name).connect = deny; require(name).createConnection = deny; }
  globalThis.fetch = deny;
  phase = 'fresh_schema';
  const platform = await require('@prisma/get-platform').getBinaryTargetForCurrentPlatform();
  const engine = path.join(path.dirname(require.resolve('@prisma/engines/package.json')), `schema-engine-${platform}`);
  assert.ok(fs.existsSync(engine), 'installed schema engine only, no downloads');
  execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')], {
    cwd: directory, env: { ...process.env, PRISMA_SCHEMA_ENGINE_BINARY: engine, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1', CHECKPOINT_DISABLE: '1' }, timeout: 120000, stdio: 'pipe',
  });
  globalThis.AsyncLocalStorage = require('node:async_hooks').AsyncLocalStorage;
  require('./server-runtime.cjs');
  prisma = require('../src/lib/prisma.ts').prisma;
  const notification = require('../src/lib/feedback/notification.ts'); feedbackDb = notification.feedbackPrisma;
  await prisma.$connect(); await feedbackDb.$connect();
  for (const db of [prisma, feedbackDb]) {
    const main = (await db.$queryRawUnsafe('PRAGMA database_list')).find(row => row.name === 'main');
    assert.equal(fs.realpathSync(main.file), database);
  }
  assert.equal(fs.statSync(database).nlink, 1); assert.equal(await prisma.user.count(), 0);
  assert.equal(await prisma.videoTask.count(), 0); assert.equal(await prisma.notification.count(), 0);
  const lifecycle = require('../src/lib/feedback/lifecycle.ts'), flow = require('../src/lib/feedback/flow-state.ts');
  const { NextRequest } = require('next/server'), { requestContext } = require('./fixtures/fb2322-request-context.cjs');
  const session = require('../src/lib/auth/session.ts');
  const { hashPassword } = require('../src/lib/auth/password.ts');
  const password = hashPassword('synthetic-only-not-a-real-credential');
  for (const name of ['admin', 'author', 'foreign']) await prisma.user.create({ data: {
    id: `f24-${name}`, name: 'Synthetic User', username: `f24-${name}`, email: `${name}@synthetic.invalid`, password_hash: password,
    role: name === 'admin' ? 'admin' : 'user', feishu_open_id: `f24-open-${name}`, feishu_tenant_key: process.env.FEISHU_ALLOWED_TENANT_KEY,
  } });
  const tokens = Object.fromEntries(await Promise.all(['admin', 'author', 'foreign'].map(async name => [name, await session.createSession(`f24-${name}`)])));
  const call = (route, method, name, body) => {
    const headers = new Headers({ 'Content-Type': 'application/json', ...(name ? { cookie: `session=${tokens[name]}`, 'x-app-session-user': `f24-${name}` } : {}) });
    const request = new NextRequest('http://synthetic.invalid/api/feedback/f24-feedback', { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    return requestContext(headers, () => route[method](request, { params: { id: 'f24-feedback' } }));
  };
  phase = 'atomic_enqueue_rollback';
  await assert.rejects(feedbackDb.$transaction(async tx => {
    const item = await tx.feedback.create({ data: { id: 'f24-rollback', user_id: 'f24-author', content: 'Synthetic rollback' } });
    await notification.enqueueFeedbackNotification(tx, item, { id: 'f24-author', name: 'Synthetic' }, 0);
    throw new Error('f24_expected_rollback');
  }), /f24_expected_rollback/);
  assert.equal(await prisma.feedback.count(), 0); assert.equal(await prisma.platformSetting.count(), 0); assert.equal(await prisma.notification.count(), 0);
  passed.push(phase);
  const item = await feedbackDb.$transaction(async tx => {
    const created = await tx.feedback.create({ data: { id: 'f24-feedback', user_id: 'f24-author', content: 'Synthetic issue', admin_note: 'synthetic-internal-note', status: 'reviewed' } });
    await notification.enqueueFeedbackNotification(tx, created, { id: 'f24-author', name: 'Synthetic' }, 0); return created;
  });
  phase = 'real_signed_http_identity_and_projection';
  const ownRoute = require('../src/app/api/feedback/[id]/route.ts'), adminRoute = require('../src/app/api/admin/feedback/[id]/route.ts');
  assert.equal((await call(ownRoute, 'GET', null)).status, 401);
  assert.equal((await call(ownRoute, 'GET', 'foreign')).status, 404);
  assert.equal((await call(adminRoute, 'PATCH', 'author', { action: 'mark_fixed' })).status, 403);
  const own = await call(ownRoute, 'GET', 'author'); assert.equal(own.status, 200); assert.ok(!(await own.text()).includes('synthetic-internal-note'));
  passed.push(phase);
  phase = 'callback_exact_message_operator_nonce';
  const ackJob = await prisma.notification.findFirst({ where: { type: notification.FEEDBACK_ACK_NOTIFICATION_TYPE } });
  const ack = JSON.parse(ackJob.metadata_json); ack.state = 'sent'; ack.receiptId = 'f24-synthetic-ack-message';
  await prisma.notification.update({ where: { id: ackJob.id }, data: { status: 'sent', metadata_json: JSON.stringify(ack) } });
  const callback = require('../src/app/api/feishu/feedback-actions/route.ts');
  const { FEEDBACK_CARD_SOURCE } = require('../src/lib/feishu/feedback-relay.ts');
  const postCallback = async (openId, nonce, purpose = 'sd2-feedback-relay-v1') => {
    const body = JSON.stringify({ header: { app_id: process.env.FEISHU_APP_ID, tenant_key: process.env.FEISHU_ALLOWED_TENANT_KEY, event_type: 'card.action.trigger' },
      event: { operator: { open_id: openId, tenant_key: process.env.FEISHU_ALLOWED_TENANT_KEY }, action: { value: { source: FEEDBACK_CARD_SOURCE, action: 'ack', feedbackId: item.id, nonce } } },
      context: { open_message_id: ack.receiptId } });
    const time = String(Date.now()), signature = createHmac('sha256', process.env.FEISHU_APP_SECRET).update(`${purpose}\n${time}\n${body}`).digest('hex');
    return callback.POST(new NextRequest('http://synthetic.invalid/api/feishu/feedback-actions', { method: 'POST', body, headers: { 'x-sd2-feedback-time': time, 'x-sd2-feedback-signature': signature } }));
  };
  assert.equal((await postCallback('f24-open-admin', ack.ackNonce, 'sd2-credit-relay-v1')).status, 401);
  assert.equal((await (await postCallback('f24-open-author', ack.ackNonce)).json()).toast.type, 'error');
  assert.equal((await (await postCallback('f24-open-admin', '0'.repeat(48))).json()).toast.type, 'error');
  assert.equal((await (await postCallback('f24-open-admin', ack.ackNonce)).json()).toast.type, 'success');
  const received = await prisma.platformSetting.findUnique({ where: { key: flow.feedbackFlowKey(item.id) } });
  await postCallback('f24-open-admin', ack.ackNonce);
  assert.equal((await prisma.platformSetting.findUnique({ where: { key: received.key } })).value_json, received.value_json);
  passed.push(phase);
  phase = 'repair_cas_original_operation_and_review_permissions';
  const revision = (await flow.readFeedbackFlow(feedbackDb, item.id)).flow.revision;
  const repair = { action: 'mark_fixed', operationId: 'f24-repair-one', revision, summary: 'Synthetic public fix' };
  assert.equal((await call(adminRoute, 'PATCH', 'admin', repair)).status, 200);
  assert.equal((await call(adminRoute, 'PATCH', 'admin', repair)).status, 200);
  assert.equal((await call(adminRoute, 'PATCH', 'admin', { ...repair, operationId: 'f24-stale-repair' })).status, 409);
  assert.equal(await prisma.notification.count({ where: { type: lifecycle.FEEDBACK_RETEST_TYPE } }), 1);
  const review = { operationId: 'f24-review-one', round: 1, result: 'needs_work', note: 'Synthetic still wrong' };
  assert.equal((await call(ownRoute, 'POST', 'foreign', review)).status, 404);
  assert.equal((await call(ownRoute, 'POST', 'admin', review)).status, 404);
  const asset = await prisma.asset.create({ data: { id: 'f24-foreign-asset', owner_id: 'f24-foreign', type: 'image', status: 'active', original_url: '/uploads/f24-synthetic.png', file_name: 'synthetic.png', file_size: 32, hash: 'a'.repeat(64), mime_type: 'image/png' } });
  assert.equal((await call(ownRoute, 'POST', 'author', { ...review, uploadedAssetIds: [asset.id], imageUrls: [asset.original_url] })).status, 403);
  await prisma.asset.update({ where: { id: asset.id }, data: { owner_id: 'f24-author' } });
  const accepted = { ...review, uploadedAssetIds: [asset.id], imageUrls: [asset.original_url] };
  assert.equal((await call(ownRoute, 'POST', 'author', accepted)).status, 200);
  assert.equal((await call(ownRoute, 'POST', 'author', accepted)).status, 200);
  assert.equal((await prisma.feedback.findUnique({ where: { id: item.id } })).status, 'new');
  assert.equal((await prisma.feedback.findUnique({ where: { id: item.id } })).admin_note, 'synthetic-internal-note');
  assert.equal(await prisma.notification.count({ where: { type: lifecycle.FEEDBACK_RETEST_TYPE } }), 1); passed.push(phase);
  phase = 'library_removed_readonly_and_explicit_restore';
  const removal = require('../src/lib/assets/library-removal.ts'), removalRoute = require('../src/app/api/assets/library/removal/route.ts');
  await removal.setLibraryResourceRemoved('f24-author', `asset:${asset.id}`, true);
  const beforeRead = await prisma.platformSetting.findMany({ orderBy: { key: 'asc' } });
  for (const [name, expected] of [['author', 'removed'], ['foreign', 'unavailable']]) {
    const headers = new Headers({ cookie: `session=${tokens[name]}`, 'x-app-session-user': `f24-${name}` });
    const request = new NextRequest(`http://synthetic.invalid/api/assets/library/removal?identities=asset:${asset.id}`, { headers });
    const response = await requestContext(headers, () => removalRoute.GET(request));
    assert.equal(response.status, 200); assert.equal((await response.json()).states[0].status, expected);
  }
  assert.deepEqual(await prisma.platformSetting.findMany({ orderBy: { key: 'asc' } }), beforeRead);
  await removal.setLibraryResourceRemoved('f24-author', `asset:${asset.id}`, false);
  assert.equal((await removal.readOwnLibraryRemovalStates('f24-author', [`asset:${asset.id}`]))[0].status, 'available');
  await prisma.asset.update({ where: { id: asset.id }, data: { status: 'deleted' } });
  assert.equal((await removal.readOwnLibraryRemovalStates('f24-author', [`asset:${asset.id}`]))[0].status, 'unavailable');
  passed.push(phase);
  phase = 'actual_retest_delivery_synthetic_transport';
  await feedbackDb.$transaction(async tx => lifecycle.markFeedbackFixed(tx, 'f24-admin', item.id, {
    operationId: 'f24-repair-two', revision: (await flow.readFeedbackFlow(tx, item.id)).flow.revision, summary: 'Synthetic followup fix',
  }));
  globalThis.fetch = async (url, init) => {
    if (url === 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal') return Response.json({ code: 0, tenant_access_token: 'synthetic-token' });
    if (url !== 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id') return deny();
    const body = JSON.parse(init.body); assert.equal(body.receive_id, 'f24-open-author'); sent.push(body);
    const job = await prisma.notification.findUnique({ where: { id: body.uuid } }), meta = JSON.parse(job.metadata_json);
    assert.equal(meta.ambiguousSend, true); assert.ok(meta.firstSendAt && meta.leaseToken);
    return Response.json({ code: 0, data: { message_id: 'f24-synthetic-retest-message' } });
  };
  const delivery = require('../src/lib/feedback/retest-delivery.ts');
  assert.equal((await delivery.processFeedbackRetestDeliveries()).sent, 1);
  assert.equal((await delivery.processFeedbackRetestDeliveries()).sent, 0); assert.equal(sent.length, 1); passed.push(phase);
  assert.equal(await prisma.creditLedger.count(), 0); assert.equal(await prisma.videoTask.count(), 0); assert.equal(externalAttempts, 0);
  write('result.json', { syntheticOnly: true, passed, externalRequests: externalAttempts, simulatedMessages: sent.length, productionOrOriginalMutation: false });
  console.log(JSON.stringify({ passed: passed.length, evidence: directory, externalRequests: externalAttempts, scope: 'real Prisma and signed synthetic HTTP/callback; external Feishu replaced, no functional acceptance' }));
}
main().catch(error => { const detail = { phase, name: error.name, code: error.code || null, message: String(error.message).slice(0, 1200), stack: String(error.stack).slice(0, 5000), passed };
  if (directory) write('failure.json', detail); console.error(JSON.stringify(detail)); process.exitCode = 1;
}).finally(async () => { await prisma?.$disconnect(); if (feedbackDb !== prisma) await feedbackDb?.$disconnect(); });
