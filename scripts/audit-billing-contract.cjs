const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const root = process.cwd();
const deps = createRequire(path.resolve(process.env.AUD_NODE_MODULES || 'node_modules', 'package.json'));
const ts = deps('typescript');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-billing-synthetic-'));
process.env.DATABASE_URL = `file:${dir}/contract.sqlite`;
const realPrisma = process.env.AUD_BILLING_REAL_PRISMA === '1';
let db;
if (realPrisma) {
  new DatabaseSync(path.join(dir, 'contract.sqlite')).close();
  const setup = spawnSync(process.execPath, [deps.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')], { cwd: dir, env: process.env, encoding: 'utf8', timeout: 120_000 });
  if (setup.status !== 0) throw new Error(`Synthetic Prisma setup failed: ${setup.stdout}\n${setup.stderr}`);
  const { PrismaClient } = deps('@prisma/client');
  db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
} else db = require('./audit-billing-sqlite.cjs')(`${dir}/contract.sqlite`);
console.log(`Runtime: ${realPrisma ? 'real Prisma + synthetic SQLite' : 'SQL-backed behavioral adapter; not Prisma integration'}`);
const cache = new Map();
const mocks = new Map([
  ['src/lib/prisma.ts', { prisma: db }],
  ['src/lib/credits/periodic.ts', { syncPeriodicQuota: async () => ({ managed: true }) }],
  ['src/lib/video/multiview-1080p-approval.ts', { restoreMultiview1080pApproval: async () => {} }],
  ['src/lib/feedback/notification.ts', { feedbackConfig: () => ({ enabled: false }), validFeedbackRecipient: () => false }],
  ['src/lib/feedback/delivery.ts', { feedbackTenantToken: async () => { throw new Error('No real Feishu in synthetic contracts'); } }],
  ['src/lib/notifications.ts', { notifyProjectOwner: async () => {} }],
  ['src/lib/provider/video-task-status.ts', {}],
  ['src/lib/costs/ledger.ts', { recordTaskCostSettlement: async () => {}, recordProviderReportedCharge: async () => {} }],
  ['src/lib/creation/settlement.ts', { settleVideoCreationBatch: async () => {} }],
  ['src/lib/video/local-cache.ts', {}],
  ['src/lib/video/thumbnail.ts', {}],
  ['src/lib/video/public-delivery.ts', {}],
  ['src/lib/provider/h3.ts', { H3RequestError: class extends Error {}, H3_VIDEO_PROVIDER: 'h3', isH3InternalOutputUrl: () => false }],
  ['src/lib/provider/h3-diagnostics.ts', { buildH3DiagnosticSnapshot: () => ({}) }],
  ['src/lib/provider/error-message.ts', { normalizeProviderErrorMessage: x => x, providerFailureUserMessage: () => ({}) }],
]);
function load(file) {
  file = path.resolve(root, file);
  const key = path.relative(root, file);
  if (mocks.has(key)) return mocks.get(key);
  if (cache.has(file)) return cache.get(file).exports;
  if (!file.endsWith('.ts')) return deps(file);
  const module = { exports: {} }; cache.set(file, module);
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const req = name => {
    if (name.startsWith('@/')) return load(`src/${name.slice(2)}.ts`);
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), `${name}.ts`));
    return deps(name);
  };
  new Function('require', 'module', 'exports', '__filename', '__dirname', source)(req, module, module.exports, file, path.dirname(file));
  return module.exports;
}
async function main() {
  const userData = id => ({ id, name: 'Synthetic', username: id, email: `${id}@example.invalid`, password_hash: 'not-a-credential' });
  await db.user.create({ data: { id: 'synthetic-user', username: 'synthetic', name: 'Synthetic', email: 'synthetic@example.invalid', password_hash: 'not-a-credential' } });
  await db.creditAccount.create({ data: { user_id: 'synthetic-user', balance: 100, frozen_credits: 10 } });
  const task = await db.videoTask.create({ data: { id: 'synthetic-task', provider: 'synthetic', model: 'synthetic', generation_mode: 'text', prompt: 'synthetic',
    user_id: 'synthetic-user', local_status: 'succeeded', frozen_cost: 10, credit_freeze_snapshot: JSON.stringify([{ source_type: 'balance', amount: 10 }]) } });
  if (fs.existsSync('src/lib/billing/holds.ts')) {
    await db.creditHold.create({ data: { id: 'synthetic-hold', business_type: 'task', business_id: task.id, payer_type: 'user', payer_id: 'synthetic-user',
      amount: 10, freeze_snapshot: task.credit_freeze_snapshot, opening_receipt: '{}' } });
  }
  const { settleTask } = load('src/lib/video/task-finalizer.ts');
  await settleTask(task.id, 'synthetic-user', 10, 'succeeded');
  const first = await db.videoTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(first.actual_cost, 10, 'first settlement captures original reservation');
  await settleTask(task.id, 'synthetic-user', 10, 'succeeded');
  const second = await db.videoTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(second.actual_cost, 10, 'duplicate settlement must not overwrite actual_cost with zero');
  assert.equal(await db.creditLedger.count({ where: { related_task_id: task.id, type: 'task_success_deduct' } }), 1);
  console.log('PASS duplicate settlement preserves amount and one receipt');
  const holds = load('src/lib/billing/holds.ts');
  const state = load('src/lib/video/task-state.ts');
  const submission = load('src/lib/video/submission.ts');
  const reconciler = load('src/lib/video/reconciler.ts');
  const invariants = load('src/lib/billing/invariants.ts');
  const status = load('src/lib/taskStatus.ts');
  for (const pending of ['created', 'submitting', 'unknown']) {
    assert.equal(status.isInProgress(pending), true);
    assert.notEqual(status.getStatusDisplayText(pending), pending);
  }
  const providerTree = ts.createSourceFile('jimeng.ts', fs.readFileSync('src/lib/provider/jimeng.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const mapper = providerTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'buildProviderHttpErrorStatus');
  const compiledMapper = ts.transpileModule(mapper.getText(providerTree), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const mapperExports = {};
  new Function('exports', 'normalizeProviderErrorMessage', 'providerFailureUserMessage', compiledMapper)(mapperExports, x => String(x || ''), () => ({ message: 'synthetic failure' }));
  assert.equal(mapperExports.buildProviderHttpErrorStatus('original-job', 404, { error: 'not found' }), null);
  assert.equal(mapperExports.buildProviderHttpErrorStatus('original-job', 400, { id: 'another-job', status: 'failed', error: 'failure' }), null);
  console.log('PASS pending state vocabulary and failed lookup are not terminal/no-charge evidence');
  global.fetch = async () => { throw new Error('Network forbidden by synthetic contract'); };
  const openingUser = await db.user.create({ data: { ...userData('opening-user'), role: 'user', status: 'active' } });
  await db.creditAccount.create({ data: { user_id: openingUser.id, balance: 100, frozen_credits: 0 } });
  await Promise.all(Array.from({ length: 4 }, () => db.$transaction(tx => holds.allocateTaskCredits(tx, openingUser, 10, 'opening-contract'))));
  const opened = await holds.findTaskHold(db, 'opening-contract');
  assert.equal(await db.creditLedger.count({ where: { idempotency_key: `hold:${opened.id}:open` } }), 1);
  await db.$transaction(tx => holds.captureHold(tx, opened.id, 7));
  await db.$transaction(tx => holds.releaseHold(tx, opened.id));
  assert.equal((await db.creditAccount.findUnique({ where: { user_id: openingUser.id } })).balance, 93);
  assert.equal((await db.creditHold.findUnique({ where: { id: opened.id } })).refunded_amount, 3);
  console.log('PASS duplicate opening reserves once; partial capture retains exact receipt');
  await db.creditLedger.create({ data: { id: 'historical-freeze', type: 'task_freeze', related_task_id: 'historical-business', user_id: openingUser.id, amount: -5, balance_before: 100, balance_after: 100 } });
  await assert.rejects(db.$transaction(tx => holds.allocateTaskCredits(tx, openingUser, 5, 'historical-business')), /LEGACY_REVIEW_REQUIRED/);
  assert.equal(await holds.findTaskHold(db, 'historical-business'), null);
  console.log('PASS normal opening refuses to import an existing historical reservation');
  async function fixture(id, status = 'running', options = {}) {
    const { hold: holdOptions, ...taskOptions } = options;
    const user = await db.user.create({ data: { ...userData(`user-${id}`), role: 'user', status: 'active', account_type: 'internal', user_profile: 'other' } });
    await db.creditAccount.create({ data: { user_id: user.id, balance: 100, frozen_credits: 10 } });
    const task = await db.videoTask.create({ data: { id, provider: 'synthetic', model: 'synthetic', generation_mode: 'text', prompt: 'synthetic', provider_task_id: null, provider_client_request_id: id, user_id: user.id, local_status: status,
      frozen_cost: 10, actual_cost: null, refund_amount: null, credit_freeze_snapshot: JSON.stringify([{ source_type: 'balance', amount: 10 }]), ...taskOptions } });
    const hold = await db.creditHold.create({ data: { business_type: 'video', business_id: id, payer_type: 'user', payer_id: user.id,
      amount: 10, freeze_snapshot: task.credit_freeze_snapshot, opening_receipt: '{}', ...holdOptions } });
    return { user, task, hold };
  }
  const concurrent = await fixture('four-finalizers');
  const completions = await Promise.all(Array.from({ length: 4 }, () => state.transitionVideoTask(concurrent.task.id, concurrent.task, 'succeeded')));
  assert.equal(completions.filter(result => result.changed).length, 1);
  assert.equal((await db.videoTask.findUnique({ where: { id: concurrent.task.id } })).actual_cost, 10);
  assert.equal(await db.creditLedger.count({ where: { idempotency_key: `hold:${concurrent.hold.id}:capture` } }), 1);
  const stale = await state.transitionVideoTask(concurrent.task.id, concurrent.task, 'running', { provider_status: 'running' });
  assert.equal(stale.changed, false); assert.equal(stale.task.local_status, 'succeeded');
  console.log('PASS four concurrent finalizers capture once; stale running cannot demote success');

  const unknown = await fixture('accepted-local-write-failure', 'created');
  const originalUpdate = db.videoTask.updateMany;
  let injected = false, sends = 0;
  const failAcceptedWrite = args => {
    if (!injected && args.data.local_status === 'submitted') {
      injected = true;
      throw new Error('synthetic SQLite write failure after acceptance');
    }
  };
  if (realPrisma) db.$use(async (params, next) => {
    if (params.model === 'VideoTask' && params.action === 'updateMany') failAcceptedWrite(params.args);
    return next(params);
  });
  else db.videoTask.updateMany = async args => { failAcceptedWrite(args); return originalUpdate(args); };
  const outcome = await submission.submitToProvider({ taskId: unknown.task.id, send: async () => { sends++; return { provider_task_id: 'synthetic-upstream-1' }; } });
  if (!realPrisma) db.videoTask.updateMany = originalUpdate;
  assert.equal(injected, true, 'the actual transactional acceptance write must receive the fault');
  assert.equal(outcome.state, 'unknown');
  assert.equal((await db.videoTask.findUnique({ where: { id: unknown.task.id } })).local_status, 'unknown');
  assert.equal((await db.creditHold.findUnique({ where: { id: unknown.hold.id } })).state, 'held');
  await reconciler.reconcileVideoTask(unknown.task.id, { lookup: async task => { assert.equal(task.provider_client_request_id, unknown.task.id); return { state: 'found', providerTaskId: 'synthetic-upstream-1' }; } });
  assert.equal((await db.videoTask.findUnique({ where: { id: unknown.task.id } })).local_status, 'submitted');
  await submission.submitToProvider({ taskId: unknown.task.id, send: async () => { sends++; return { provider_task_id: 'duplicate' }; } });
  assert.equal(sends, 1);
  console.log('PASS accepted/local-write failure preserves hold; original-request lookup recovers; no resubmit');

  for (const code of [400, 408, 409, 425, 429, 500]) {
    const sample = await fixture(`http-${code}`, 'created');
    const result = await submission.submitToProvider({ taskId: sample.task.id, send: async () => { throw Object.assign(new Error('synthetic provider response'), { statusCode: code }); } });
    assert.equal(result.state, code === 400 ? 'rejected' : 'unknown');
    assert.equal((await db.creditHold.findUnique({ where: { id: sample.hold.id } })).state, code === 400 ? 'released' : 'held');
  }
  const lookup404 = await fixture('unknown-404', 'unknown', { created_at: new Date(Date.now() - 3_600_000) });
  await reconciler.reconcileVideoTask(lookup404.task.id, { lookup: async () => ({ state: 'unknown' }) });
  assert.equal((await db.creditHold.findUnique({ where: { id: lookup404.hold.id } })).state, 'held');
  console.log('PASS only explicit eligible 4xx releases; ambiguous 4xx/5xx and lookup404 retain reservation');

  const interrupted = await fixture('process-interruption');
  const crashSql = realPrisma ? "UPDATE CreditHold SET state='captured' WHERE id=?" : "UPDATE creditHold SET body=json_set(body,'$.state','captured') WHERE id=?";
  const crash = spawnSync(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');db.prepare(process.argv[3]).run(process.argv[2]);process.exit(23);`, `${dir}/contract.sqlite`, interrupted.hold.id, crashSql], { encoding: 'utf8' });
  assert.equal(crash.status, 23);
  assert.equal((await db.creditHold.findUnique({ where: { id: interrupted.hold.id } })).state, 'held');
  await assert.rejects(db.$transaction(async tx => { await state.transitionVideoTask(interrupted.task.id, interrupted.task, 'succeeded', {}, tx); throw new Error('synthetic transaction interruption'); }));
  assert.equal((await db.videoTask.findUnique({ where: { id: interrupted.task.id } })).local_status, 'running');
  assert.equal((await db.creditHold.findUnique({ where: { id: interrupted.hold.id } })).state, 'held');
  // A terminal row from a prior compatible run is repaired, never re-reserved.
  await db.videoTask.update({ where: { id: interrupted.task.id }, data: { local_status: 'succeeded' } });
  await reconciler.reconcileVideoTask(interrupted.task.id);
  await reconciler.reconcileVideoTask(interrupted.task.id);
  assert.equal((await db.creditAccount.findUnique({ where: { user_id: interrupted.user.id } })).balance, 90);
  assert.equal(await db.creditLedger.count({ where: { idempotency_key: `hold:${interrupted.hold.id}:capture` } }), 1);
  console.log('PASS real process exit rolls back SQLite; whole terminal transaction rolls back; restart repairs once');

  const refresh = await fixture('refresh-throttle');
  const now = new Date();
  const claims = await Promise.all(Array.from({ length: 4 }, () => state.claimProviderRefresh(refresh.task.id, false, now)));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await state.claimProviderRefresh(refresh.task.id, false, new Date(+now + 9999)), false);
  assert.equal(await state.claimProviderRefresh(refresh.task.id, false, new Date(+now + 10000)), true);
  assert.equal(await state.claimProviderRefresh(refresh.task.id, true, now), true);
  console.log('PASS persisted 10-second refresh lease; callbacks bypass throttle');

  if (realPrisma) await db.project.create({ data: { id: 'synthetic-project', name: 'Synthetic', owner_user_id: openingUser.id, created_by: openingUser.id } });
  const project = await db.projectBudgetAccount.create({ data: { id: 'synthetic-project-account', project_id: 'synthetic-project', budget_credits: 100, used_credits: 0, frozen_credits: 10, status: 'active', currency: 'credits' } });
  const projectHold = await db.creditHold.create({ data: { business_type: 'video', business_id: 'project-task', payer_type: 'project', payer_id: project.project_id,
    amount: 10, freeze_snapshot: JSON.stringify({ source_type: 'project_budget', project_id: project.project_id, account_id: project.id, amount: 10 }), opening_receipt: '{}' } });
  await db.$transaction(tx => holds.captureHold(tx, projectHold.id));
  await db.$transaction(tx => holds.releaseHold(tx, projectHold.id));
  assert.equal(await db.projectBudgetLedger.count({ where: { idempotency_key: `hold:${projectHold.id}:capture` } }), 1);
  assert.equal((await db.projectBudgetAccount.findUnique({ where: { id: project.id } })).used_credits, 10);
  console.log('PASS project payer settles once with canonical hold receipt');

  const legacy = await db.videoTask.create({ data: { id: 'legacy-readonly', provider: 'synthetic', model: 'synthetic', generation_mode: 'text', prompt: 'synthetic', local_status: 'succeeded', frozen_cost: 10, actual_cost: 7 } });
  await reconciler.reconcileVideoTask(legacy.id);
  assert.deepEqual(await db.videoTask.findUnique({ where: { id: legacy.id } }), legacy);
  const broken = await fixture('invariant-mismatch');
  await db.creditAccount.update({ where: { user_id: broken.user.id }, data: { frozen_credits: 9 } });
  await db.user.create({ data: { ...userData('synthetic-admin'), role: 'admin', status: 'active' } });
  const issues = await db.$transaction(tx => invariants.inspectBillingInvariants(tx));
  assert.ok(issues.some(issue => issue.kind === 'personal_frozen_mismatch' && issue.id === broken.user.id));
  await invariants.runDailyBillingInspection(new Date('2030-01-01T00:00:00Z'));
  assert.ok(await db.notification.count() > 0);
  console.log('PASS historical rows untouched; constructed inconsistency produces a durable administrator alert');
  const overdue = await fixture('overdue-hold', 'unknown', { provider: 'unsupported-synthetic', created_at: new Date('2000-01-01'), hold: { created_at: new Date('2000-01-01'), updated_at: new Date('2000-01-01') } });
  await reconciler.reconcileVideoBilling({ now: new Date(), limit: 200 });
  assert.equal((await db.creditHold.findUnique({ where: { id: overdue.hold.id } })).state, 'held');
  assert.ok((await db.creditHold.findUnique({ where: { id: overdue.hold.id } })).review_notified_at);
  assert.equal((await db.creditAccount.findUnique({ where: { user_id: overdue.user.id } })).frozen_credits, 10);
  console.log('PASS 24-hour unresolved reservation alerts without disabling reconciliation or refunding');

  const expired = await fixture('expired-bucket');
  await db.creditAccount.update({ where: { user_id: expired.user.id }, data: { frozen_credits: 0 } });
  await db.creditBucket.create({ data: { id: 'expired-bucket-source', user_id: expired.user.id, source_type: 'daily_quota', amount_total: 10, amount_remaining: 0, frozen_amount: 10, status: 'expired', expires_at: new Date('2000-01-01') } });
  await db.creditHold.update({ where: { id: expired.hold.id }, data: { freeze_snapshot: JSON.stringify([{ source_type: 'daily_quota', bucket_id: 'expired-bucket-source', amount: 10 }]) } });
  await db.$transaction(tx => holds.releaseHold(tx, expired.hold.id));
  await db.$transaction(tx => holds.captureHold(tx, expired.hold.id));
  const expiredResult = await db.creditHold.findUnique({ where: { id: expired.hold.id } });
  assert.equal(expiredResult.state, 'expired_closed'); assert.equal(expiredResult.refunded_amount, 0); assert.equal(expiredResult.expired_closed_amount, 10);
  console.log('PASS expired quota closes without restoring balance or allowing a later capture');

  const migration = fs.readFileSync('prisma/migrations/202610270001_audit_billing_holds/migration.sql', 'utf8');
  for (const duplicate of [false, true]) {
    const ddl = new DatabaseSync(':memory:');
    ddl.exec('CREATE TABLE VideoTask(id TEXT PRIMARY KEY,local_status TEXT);CREATE TABLE CreditLedger(id TEXT PRIMARY KEY,idempotency_key TEXT,type TEXT,user_id TEXT,related_task_id TEXT);CREATE TABLE ProjectBudgetLedger(id TEXT PRIMARY KEY,idempotency_key TEXT,type TEXT,project_id TEXT,related_task_id TEXT);');
    if (duplicate) ddl.exec("INSERT INTO CreditLedger(id,idempotency_key) VALUES('a','duplicate'),('b','duplicate')");
    if (duplicate) {
      assert.throws(() => ddl.exec(migration)); ddl.exec('ROLLBACK');
      assert.equal(ddl.prepare('SELECT count(*) AS n FROM CreditLedger').get().n, 2);
      assert.equal(ddl.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='CreditHold'").get().n, 0);
    } else {
      ddl.exec(migration);
      ddl.exec("INSERT INTO VideoTask(id,local_status) VALUES('guarded','created');INSERT INTO CreditHold(id,business_type,business_id,payer_type,payer_id,amount,freeze_snapshot,opening_receipt,updated_at) VALUES('h','video','guarded','user','synthetic',10,'[]','{}',CURRENT_TIMESTAMP)");
      assert.throws(() => ddl.exec("UPDATE VideoTask SET local_status='running' WHERE id='guarded'"));
      assert.throws(() => ddl.exec("INSERT INTO CreditLedger(id,type,user_id,related_task_id) VALUES('legacy','task_success_deduct','synthetic','guarded')"));
      ddl.exec("UPDATE VideoTask SET local_status='submitting',state_version=state_version+1 WHERE id='guarded'");
    }
    ddl.close();
  }
  console.log('PASS actual migration uniqueness, legacy-writer guard and duplicate-key rollback without ledger rewrites');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await db.$disconnect(); console.log(`Synthetic evidence database: ${dir}/contract.sqlite`);
});
