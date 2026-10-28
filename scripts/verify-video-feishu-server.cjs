'use strict';

// Lead only: Linux, a newly owned synthetic DB, no media preparation or outbound calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
let prisma, feedbackPrisma, directory, phase = 'guard', networkAttempts = 0;
const passed = [], root = fs.realpathSync(path.join(__dirname, '..'));
const inside = (parent, file) => file === parent || file.startsWith(parent + path.sep);
function denyNetwork() {
  const deny = () => { networkAttempts++; throw Error('synthetic_network_prohibited'); };
  globalThis.fetch = deny;
  for (const name of ['node:http', 'node:https']) { require(name).get = deny; require(name).request = deny; }
  for (const name of ['node:net', 'node:tls']) { require(name).connect = deny; require(name).createConnection = deny; }
}
async function baseline() {
  return { tasks: await prisma.videoTask.count(), provider: await prisma.providerApiRequest.count(), credit: await prisma.creditLedger.count(),
    costs: await prisma.costLedger.count(), requests: await prisma.videoCreationIntent.count() };
}
async function main() {
  assert.equal(process.platform, 'linux'); assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.AUD_F24_VIDEO_FEISHU_SYNTHETIC_SERVER, '1');
  assert.equal(globalThis.prisma, undefined); assert.equal(globalThis.feedbackPrisma, undefined);
  const parent = fs.realpathSync(process.env.AUD_F24_VIDEO_FEISHU_TMP_PARENT || '/tmp');
  assert.equal(inside(root, parent), false, 'fresh fixture must not inherit application-cwd TMPDIR');
  directory = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'video-feishu-synthetic-'))); fs.chmodSync(directory, 0o700);
  const database = path.join(directory, 'synthetic.db'); fs.writeFileSync(database, '', { flag: 'wx', mode: 0o600 });
  for (const key of Object.keys(process.env)) if (/^(?:FEISHU_|R2_|TOS_|PRIVATE_PROMPTS_)/.test(key)) delete process.env[key];
  Object.assign(process.env, { DATABASE_URL: `file:${database}`, SESSION_SECRET: randomBytes(48).toString('hex'),
    FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-not-real', FEISHU_ALLOWED_TENANT_KEY: 'synthetic-tenant', FEISHU_FEEDBACK_ENABLED: 'false' });
  denyNetwork();
  phase = 'fresh_schema';
  const platform = await require('@prisma/get-platform').getBinaryTargetForCurrentPlatform();
  const engine = path.join(path.dirname(require.resolve('@prisma/engines/package.json')), `schema-engine-${platform}`);
  assert.ok(fs.existsSync(engine), 'installed engine required; no downloads');
  try {
    const output = execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')],
      { cwd: directory, env: { ...process.env, PRISMA_SCHEMA_ENGINE_BINARY: engine, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' }, timeout: 120000, stdio: 'pipe' });
    fs.writeFileSync(path.join(directory, 'schema.log'), output, { mode: 0o600 });
  } catch (error) {
    for (const name of ['stdout', 'stderr']) if (Buffer.isBuffer(error[name])) fs.writeFileSync(path.join(directory, `schema.${name}.log`), error[name], { mode: 0o600 });
    throw error;
  }
  globalThis.AsyncLocalStorage = require('node:async_hooks').AsyncLocalStorage;
  require('./server-runtime.cjs');
  prisma = require('../src/lib/prisma.ts').prisma;
  await prisma.$connect();
  assert.equal(fs.realpathSync((await prisma.$queryRawUnsafe('PRAGMA database_list')).find(row => row.name === 'main').file), database);
  assert.equal(fs.statSync(database).nlink, 1);
  assert.deepEqual(await baseline(), { tasks: 0, provider: 0, credit: 0, costs: 0, requests: 0 });
  const helper = require('../src/lib/video/feishu-notification.ts'), contract = require('../src/lib/video/feishu-contract.ts');
  feedbackPrisma = require('../src/lib/feedback/notification.ts').feedbackPrisma;
  phase = 'seed_and_read_only_default';
  for (const id of ['actor', 'owner', 'other']) await prisma.user.create({ data: { id, name: 'Synthetic', username: `synthetic-${id}`, email: `${id}@synthetic.invalid`,
    password_hash: 'synthetic-not-a-password', status: 'active', role: 'user', account_type: 'internal',
    ...(id === 'actor' ? { feishu_open_id: 'ou_synthetic', feishu_tenant_key: 'synthetic-tenant' } : {}) } });
  const view = await prisma.$transaction(tx => helper.readVideoFeishuPreference(tx, 'actor'));
  assert.equal(view.enabled, false); assert.equal(view.revision, 0); assert.equal(await prisma.userPreference.count(), 0);
  const saved = await prisma.$transaction(tx => helper.saveVideoFeishuPreference(tx, 'actor', { version: 1, enabled: true, revision: 0 }));
  await assert.rejects(prisma.$transaction(tx => helper.saveVideoFeishuPreference(tx, 'actor', { version: 1, enabled: false, revision: 0 })), /preference_changed/);
  passed.push('same-tx fresh actor, read-only default and native preference CAS');
  const data = id => ({ id, provider: 'synthetic-never-called', model: 'synthetic', generation_mode: 'text', prompt: 'synthetic-not-exported',
    user_id: 'actor', owner_user_id: 'actor', local_status: 'succeeded' });
  const choice = { version: 1, enabled: true, preferenceRevision: saved.revision };
  phase = 'same_creation_tx_and_rollback';
  await prisma.$transaction(async tx => { const task = await tx.videoTask.create({ data: data('synthetic-task') });
    await helper.enqueueVideoFeishuNotification(tx, 'actor', task, choice); });
  const id = contract.videoFeishuUuid('synthetic-task', 'event'), accepted = await prisma.notification.findUniqueOrThrow({ where: { id } });
  await prisma.$transaction(tx => helper.enqueueVideoFeishuNotification(tx, 'actor', { id: 'synthetic-task', user_id: 'actor', source_metadata_json: null }, choice));
  assert.equal(await prisma.notification.count(), 1);
  assert.equal((await prisma.notification.findUniqueOrThrow({ where: { id } })).metadata_json, accepted.metadata_json);
  const before = await baseline();
  for (const [name, override, actorId, input] of [
    ['wrong-revision', {}, 'actor', { ...choice, preferenceRevision: 99 }],
    ['wrong-author', { user_id: 'other' }, 'actor', choice],
    ['private', { source_metadata_json: '{"protected_module":null}' }, 'actor', choice],
    ['injected-recipient', {}, 'actor', { ...choice, openId: 'ou_other' }],
  ]) {
    await assert.rejects(prisma.$transaction(async tx => {
      const task = await tx.videoTask.create({ data: { ...data(name), ...override } }); await helper.enqueueVideoFeishuNotification(tx, actorId, task, input);
    }));
    assert.deepEqual(await baseline(), before); assert.equal(await prisma.notification.count(), 1);
  }
  passed.push('one stable accepted event and atomic rollback for invalid opt-in/private/author/recipient');
  phase = 'current_authority_and_cancel_cas';
  await prisma.project.create({ data: { id: 'project', name: 'Synthetic', type: 'team', owner_user_id: 'owner', created_by: 'owner', status: 'active' } });
  await prisma.projectMember.create({ data: { project_id: 'project', user_id: 'actor', role: 'viewer', status: 'active', joined_by: 'owner' } });
  await prisma.videoTask.update({ where: { id: 'synthetic-task' }, data: { project_id: 'project' } });
  assert.equal((await prisma.$transaction(tx => helper.readVideoFeishuStatus(tx, 'actor', 'synthetic-task'))).state, 'pending');
  await prisma.projectMember.updateMany({ where: { project_id: 'project', user_id: 'actor' }, data: { status: 'removed' } });
  await assert.rejects(prisma.$transaction(tx => helper.readVideoFeishuStatus(tx, 'actor', 'synthetic-task')), /task_unavailable/);
  await prisma.videoTask.update({ where: { id: 'synthetic-task' }, data: { project_id: null } });
  await assert.rejects(prisma.$transaction(tx => helper.readVideoFeishuStatus(tx, 'other', 'synthetic-task')), /task_unavailable/);
  assert.equal((await prisma.$transaction(tx => helper.cancelVideoFeishuNotification(tx, 'actor', 'synthetic-task'))).state, 'cancelled');
  await prisma.videoTask.create({ data: data('old-task-no-event') });
  assert.equal((await prisma.$transaction(tx => helper.readVideoFeishuStatus(tx, 'actor', 'old-task-no-event'))).state, 'not_requested');
  assert.equal(await prisma.notification.count(), 1);
  passed.push('actual project membership revoke, author isolation, cancel CAS and no old-task backfill');
  assert.equal(networkAttempts, 0);
  const after = await baseline(); for (const key of ['provider', 'credit', 'costs', 'requests']) assert.equal(after[key], 0);
  phase = 'complete';
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ phase, passed, networkAttempts, syntheticOnly: true, mediaReadOrSend: false }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ phase, passed, networkAttempts, evidence: directory, nativeDeliveryOrPlaybackVerified: false }));
}
void main().catch(error => {
  const result = { phase, passed, networkAttempts, errorClass: error?.constructor?.name || 'Error', code: /^[A-Za-z0-9_]{1,80}$/.test(error?.code || '') ? error.code : null,
    syntheticOnly: true, nativeDeliveryOrPlaybackVerified: false };
  if (directory) fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.error(JSON.stringify({ ...result, evidence: directory || null })); process.exitCode = 1;
}).finally(async () => { await feedbackPrisma?.$disconnect(); await prisma?.$disconnect(); });
