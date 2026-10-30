import './server-runtime.cjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mock } from 'node:test';
import type { SessionUser } from '@/lib/auth/session';

async function main() {
  const root = fs.realpathSync(process.cwd());
  const filename = fs.realpathSync(process.env.DATABASE_URL?.replace(/^file:/, '') || '');
  assert.equal(process.env.NODE_ENV, 'test');
  assert.ok(filename.startsWith(path.join(root, '.role-tests') + path.sep) && path.basename(filename).startsWith('prep02-'));
  assert.equal(Object.hasOwn(process.env, 'HD_DERIVATIVES_ROOT'), false);
  let forbiddenCalls = 0;
  const blocked = () => { forbiddenCalls++; throw new Error('PREP02 forbids external requests'); };
  mock.method(globalThis, 'fetch', blocked); mock.method(http, 'request', blocked); mock.method(https, 'request', blocked);
  mock.method(http, 'get', blocked); mock.method(https, 'get', blocked);
  const require = createRequire(path.join(root, 'scripts/prep02-recovery-engineering.ts'));
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url: `file:${filename}` } } });
  assert.equal(await db.user.count(), 0); assert.equal(await db.platformSetting.count(), 0);
  Reflect.set(globalThis, 'prisma', db);
  process.env.VIDEO_CREATION_FLOW_V2_ENABLED = '1';
  process.env.SEEDANCE_API_KEY = 'prep02-synthetic-not-a-provider-credential';
  process.env.SEEDANCE_BASE_URL = 'https://fixture.invalid/video';
  const { closeUnpreparedVideoCreationRequest: close, prepareVideoCreationIntent: prepare, acceptVideoCreationIntent } =
    require('@/lib/creation/intents') as typeof import('@/lib/creation/intents');
  const { originalPreparationRejection, assertNoPreparationRejection } =
    require('@/lib/creation/preparation-receipts') as typeof import('@/lib/creation/preparation-receipts');
  const actor = await db.user.create({ data: { name: 'PREP02 isolated', username: randomUUID(),
    email: `${randomUUID()}@fixture.invalid`, password_hash: 'fixture-not-a-login', role: 'admin', status: 'active' } });
  const user = { ...actor, account_type: 'internal' } as SessionUser;
  const other = await db.user.create({ data: { name: 'Other isolated', username: randomUUID(),
    email: `${randomUUID()}@fixture.invalid`, password_hash: 'fixture-not-a-login', role: 'admin', status: 'active' } });
  const project = await db.project.create({ data: { name: 'PREP02 fixture', type: 'personal', owner_user_id: actor.id, created_by: actor.id } });
  await db.creditAccount.create({ data: { user_id: actor.id, balance: 1000 } });
  const body = (request_id: string) => ({ request_id, project_id: project.id, creation_contract_version: 2,
    entry: 'ordinary', pricing_preparation: 'current', provider: 'seedance', model: 'dreamina-seedance-2-0-260128',
    generation_mode: 'text_to_video', prompt: 'Synthetic preserved input', duration: 5, resolution: '480p', ratio: '16:9' });
  const intentFor = (requestId: string) => db.videoCreationIntent.findUnique({ where: { owner_id_request_id: { owner_id: user.id, request_id: requestId } } });
  const checks: string[] = [];
  const sealed = await close(user, 'sealed');
  assert.equal(sealed.state, 'closed'); assert.equal('acceptedCount' in sealed && sealed.acceptedCount, 0);
  assert.equal(await intentFor('sealed'), null);
  const original = await originalPreparationRejection(db, user.id, 'sealed');
  assert.equal(original?.state, 'closed');
  await assert.rejects(() => prepare(user, body('sealed')));
  await assert.rejects(() => db.$transaction(tx => assertNoPreparationRejection(tx, user.id, 'sealed', { ...body('sealed'), prompt: 'changed' })));
  assert.deepEqual(await close(user, 'sealed'), sealed);
  assert.equal(await originalPreparationRejection(db, other.id, 'sealed'), null);
  checks.push('explicit closure is durable/idempotent and only fences the same owner/request; changed hash cannot reopen');

  const pending = await prepare(user, body('prepared-first'));
  const found = await close(user, 'prepared-first');
  assert.equal(found.intent?.id, pending.id); assert.notEqual(found.state, 'closed');
  assert.equal(await originalPreparationRejection(db, user.id, 'prepared-first'), null);
  checks.push('existing unaccepted intent is returned rather than silently closed');

  const originalTransaction = db.$transaction.bind(db);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  let holdNext = true;
  const transactionMock = mock.method(db, '$transaction', async (...args: unknown[]) => {
    if (holdNext) { holdNext = false; entered(); await held; }
    return (originalTransaction as (...values: unknown[]) => Promise<unknown>)(...args);
  });
  const late = prepare(user, body('late-prepare')).then(value => ({ value }), error => ({ error }));
  await reached;
  const closeBeforeWrite = await close(user, 'late-prepare');
  assert.equal(closeBeforeWrite.state, 'closed'); release();
  assert.ok('error' in await late); transactionMock.mock.restore();
  assert.equal(await intentFor('late-prepare'), null);
  assert.equal((await originalPreparationRejection(db, user.id, 'late-prepare'))?.state, 'closed');
  checks.push('full preparation paused after preflight loses to closure, then transaction-local guard rejects its late write');

  for (const key of ['race-a', 'race-b']) {
    const outcomes = await Promise.allSettled([prepare(user, body(key)), close(user, key)]);
    const intent = await intentFor(key), receipt = await originalPreparationRejection(db, user.id, key);
    assert.ok(Boolean(intent) !== Boolean(receipt), 'concurrent writers must leave exactly one durable winner');
    if (receipt) await assert.rejects(() => prepare(user, body(key)));
    if (intent) assert.equal((await close(user, key)).intent?.id, intent.id);
    assert.ok(outcomes.some(outcome => outcome.status === 'fulfilled'));
  }
  checks.push('two real SQLite prepare/close transaction races cannot both win; retry reads the committed winner');

  const accepted = await prepare(user, body('accepted-first'));
  assert.ok(accepted.quote);
  const task = await db.$transaction(async tx => {
    const task = await tx.videoTask.create({ data: { user_id: user.id, owner_user_id: user.id, project_id: project.id,
      idempotency_key: accepted.request_id, provider: 'seedance', model: 'dreamina-seedance-2-0-260128',
      generation_mode: 'text_to_video', prompt: 'Synthetic preserved input', retention_status: 'user_deleted' } });
    await acceptVideoCreationIntent(tx, user, { ...body(accepted.request_id), idempotency_key: accepted.request_id,
      intent_id: accepted.id, intent_revision: accepted.revision }, { taskId: task.id,
      cost: accepted.quote!.estimated_cost, pricingRevision: accepted.quote!.pricing_revision });
    return task;
  });
  const acceptedResult = await close(user, accepted.request_id);
  assert.equal(acceptedResult.intent?.accepted_task_id, task.id); assert.equal(acceptedResult.state, 'accepted');
  assert.equal(await originalPreparationRejection(db, user.id, accepted.request_id), null);
  const taskOnly = await db.videoTask.create({ data: { user_id: user.id, idempotency_key: 'task-only',
    provider: 'seedance', model: 'fixture', generation_mode: 'text_to_video', prompt: 'fixture', retention_status: 'admin_hidden' } });
  const taskOnlyResult = await close(user, 'task-only');
  assert.equal('task_id' in taskOnlyResult && taskOnlyResult.task_id, taskOnly.id);
  checks.push('accepted intent and hidden/deleted-retention original task always take precedence');

  await db.providerApiRequest.create({ data: { user_id: user.id, idempotency_key: 'provider-evidence',
    provider_name: 'fixture', endpoint: 'https://fixture.invalid/never-called', status: 'unknown' } });
  await db.creditLedger.create({ data: { user_id: user.id, type: 'task_freeze', amount: -1, balance_before: 2,
    balance_after: 1, metadata_json: JSON.stringify({ requestId: 'fee-evidence' }) } });
  for (const key of ['provider-evidence', 'fee-evidence']) {
    assert.equal((await close(user, key)).state, 'unconfirmed');
    assert.equal(await originalPreparationRejection(db, user.id, key), null);
  }
  await assert.rejects(() => db.$transaction(async tx => {
    const task = await tx.videoTask.create({ data: { id: 'missing-intent-task', user_id: user.id,
      provider: 'seedance', model: 'fixture', generation_mode: 'text_to_video', prompt: 'fixture' } });
    await acceptVideoCreationIntent(tx, user, { creation_contract_version: 2, intent_id: 'missing', intent_revision: 1 },
      { taskId: task.id, cost: 1, pricingRevision: null });
  }));
  assert.equal(await db.videoTask.findUnique({ where: { id: 'missing-intent-task' } }), null);
  checks.push('provider/fee evidence prevents closure; v2 acceptance without an owned intent rolls back its task');
  assert.equal(forbiddenCalls, 0);
  const sources = ['src/lib/creation/intents.ts', 'src/lib/creation/preparation-receipts.ts', 'src/lib/creation/receipts.ts',
    'src/app/api/video/creation-intents/close/route.ts', 'scripts/prep02-recovery-engineering.ts'];
  console.log(JSON.stringify({ completed: true, syntheticSQLite: true, forbiddenCalls, productionWrites: 0, paidRequests: 0,
    checks, hashes: Object.fromEntries(sources.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])) }));
  await db.$disconnect();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
