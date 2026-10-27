const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ts = require('typescript');
const root = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-billing-followup-'));
const db = require('./audit-billing-sqlite.cjs')(`${dir}/synthetic.sqlite`);
const cache = new Map();
let sends = 0;
const noop = async () => {};
const mocks = new Map([
  ['src/lib/prisma.ts', { prisma: db }],
  ['src/lib/credits/periodic.ts', { syncPeriodicQuota: async () => ({ managed: true }) }],
  ['src/lib/notifications.ts', { notifyProjectOwner: noop }],
  ['src/lib/feedback/notification.ts', { feedbackConfig: () => ({ enabled: false }), validFeedbackRecipient: () => false }],
  ['src/lib/feedback/delivery.ts', { feedbackTenantToken: async () => { throw new Error('Real network forbidden'); } }],
  ['src/lib/creation/contract.ts', { isCreationV2: () => false }],
  ['src/lib/creation/context.ts', { assertVideoCreationReady: noop }],
  ['src/lib/creation/intents.ts', { acceptVideoCreationIntent: noop }],
  ['src/lib/creation/lineage.ts', { assertLegacyCreationSourceLocks: noop }],
  ['src/lib/admin/usage-attribution.ts', { recordUsageAttribution: noop }],
  ['src/lib/video/multiview-request-receipt.ts', { assertMultiviewRequestFence: noop }],
  ['src/lib/video/multiview-1080p-approval.ts', { restoreMultiview1080pApproval: noop }],
  ['src/lib/pricing/video.ts', { quoteVideoPricing: async () => ({ revision: 'synthetic', pricing: { estimatedCost: 10 } }), requireVideoPricingRevision: () => {}, assertVideoPricingAcceptance: noop }],
  ['src/lib/pricing/video-context.ts', { resolveVideoPricingContext: async () => ({}), savedVideoPricingContextInput: () => ({}), videoPricingRequiresContext: async () => false }],
  ['src/lib/video-cards/permissions.ts', { assertCanGenerateInVideoCard: noop }],
  ['src/lib/projects/permissions.ts', { getProjectForGeneration: async () => ({ id: 'project', type: 'personal' }), assertCanViewTask: noop, assertProjectActiveInTransaction: noop }],
  ['src/lib/provider/seedance-video-edit.ts', { validateRequestCostCeiling: () => null }],
  ['src/lib/approvals.ts', {}],
  ['src/lib/costs/ledger.ts', { createProviderApiRequest: async ({ task }) => db.providerApiRequest.create({ data: { task_id: task.id } }), markProviderApiRequestAccepted: noop, markProviderApiRequestFailed: noop, recordTaskCostEstimate: noop, recordTaskCostSettlement: noop }],
  ['src/lib/provider/jimeng.ts', { createSeedanceDraftUpgradeTask: async () => { sends++; return { provider_task_id: 'original-provider-job', raw: { id: 'original-provider-job' } }; }, getVideoTaskStatusByClientRequestId: async id => ({ provider_task_id: `original:${id}` }) }],
  ['src/lib/provider/seedance-draft.ts', { buildSeedanceDraftUpgradePayload: x => x, isSeedanceDraftUpgradeEnabled: () => true, SEEDANCE_DRAFT_CONTRACT_VERSION: 'synthetic' }],
  ['src/lib/provider/seedance-models.ts', { SEEDANCE_2_5_MODEL_ID: 'synthetic-model', isSeedanceVideoDuration: () => true }],
  ['src/lib/video/task-localization-runner.ts', { startTaskLocalization: () => {} }],
  ['src/lib/creation/settlement.ts', { settleVideoCreationBatch: noop }],
]);
function load(file) {
  file = path.resolve(root, file);
  const key = path.relative(root, file);
  if (mocks.has(key)) return mocks.get(key);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const req = name => name.startsWith('@/') ? load(`src/${name.slice(2)}.ts`) : name.startsWith('.') ? load(path.resolve(path.dirname(file), `${name}.ts`)) : require(name);
  new Function('require', 'module', 'exports', source)(req, module, module.exports);
  return module.exports;
}
async function main() {
  global.fetch = async () => { throw new Error('Real network forbidden'); };
  const user = await db.user.create({ data: { id: 'owner', role: 'user', status: 'active', account_type: 'internal' } });
  await db.creditAccount.create({ data: { user_id: user.id, balance: 100, frozen_credits: 0 } });
  await db.videoCard.create({ data: { id: 'card', project_id: 'project' } });
  await db.videoTask.create({ data: { id: 'draft', provider: 'seedance', model: 'synthetic-model', local_status: 'succeeded',
    is_draft: true, provider_draft_task_id: 'original-draft', project_id: 'project', video_card_id: 'card', duration: 5 } });
  const originalRead = db.videoTask.findUniqueOrThrow;
  let acceptedReads = 0;
  db.videoTask.findUniqueOrThrow = async args => {
    const task = await originalRead(args);
    if (task.source_draft_task_id === 'draft' && task.local_status === 'submitted' && ++acceptedReads === 2) throw new Error('synthetic post-acceptance read failure');
    return task;
  };
  let result, failure;
  try { result = await load('src/lib/tasks/seedance-draft-upgrade.ts').createSeedanceDraftUpgrade({ user, draftTaskId: 'draft', resolutionApprovalConfirmed: true, idempotencyKey: 'original-upgrade' }); }
  catch (error) { failure = error; }
  db.videoTask.findUniqueOrThrow = originalRead;
  const upgrade = await db.videoTask.findFirst({ where: { source_draft_task_id: 'draft' } });
  assert.equal(failure, undefined, 'the actual draft-upgrade entrypoint must not reject/refund an accepted request after a generic local failure');
  assert.equal(result.pending_confirmation, true);
  assert.equal(upgrade.local_status, 'submitted');
  assert.equal((await db.creditHold.findFirst({ where: { business_id: upgrade.id } })).state, 'held');
  assert.equal((await db.creditAccount.findUnique({ where: { user_id: user.id } })).frozen_credits, 10);
  assert.equal(sends, 1);
  assert.equal(await db.creditLedger.count({ where: { related_task_id: upgrade.id, type: 'task_failed_refund' } }), 0);
  console.log('PASS actual createSeedanceDraftUpgrade post-acceptance failure retains the original hold');
}
async function overdue() {
  const state = load('src/lib/video/task-state.ts'), reconciler = load('src/lib/video/reconciler.ts');
  await db.user.create({ data: { id: 'late-owner', role: 'user', status: 'active' } });
  await db.creditAccount.create({ data: { user_id: 'late-owner', balance: 100, frozen_credits: 10 } });
  const task = await db.videoTask.create({ data: { id: 'late-job', local_status: 'unknown', provider: 'synthetic', user_id: 'late-owner', frozen_cost: 10, created_at: new Date('2000-01-01') } });
  const hold = await db.creditHold.create({ data: { business_type: 'video', business_id: task.id, payer_type: 'user', payer_id: 'late-owner', amount: 10,
    freeze_snapshot: JSON.stringify([{ source_type: 'balance', amount: 10 }]), opening_receipt: '{}', created_at: new Date('2000-01-01'), updated_at: new Date('2000-01-01') } });
  await reconciler.reconcileVideoBilling({ now: new Date('2030-01-01'), limit: 100 });
  assert.equal((await db.creditHold.findUnique({ where: { id: hold.id } })).state, 'held', 'age-only alert must not disable original-request recovery');
  await reconciler.reconcileVideoTask(task.id, { lookup: async () => ({ state: 'found', providerTaskId: 'late-upstream' }) });
  const accepted = await db.videoTask.findUnique({ where: { id: task.id } });
  await state.transitionVideoTask(task.id, accepted, 'succeeded');
  assert.equal((await db.creditAccount.findUnique({ where: { user_id: 'late-owner' } })).frozen_credits, 0);
  assert.equal((await db.creditHold.findUnique({ where: { id: hold.id } })).state, 'captured');
  console.log('PASS acceptance and terminal success after 24 hours remain reconcilable');
}
async function legacyVideo() {
  const state = load('src/lib/video/task-state.ts');
  await db.creditAccount.create({ data: { user_id: 'legacy-owner', balance: 100, frozen_credits: 10 } });
  const snapshot = JSON.stringify([{ source_type: 'balance', amount: 10 }]);
  const task = await db.videoTask.create({ data: { id: 'legacy-running', local_status: 'running', provider: 'synthetic', user_id: 'legacy-owner', frozen_cost: 10, credit_freeze_snapshot: snapshot } });
  await db.creditLedger.create({ data: { id: 'legacy-video-freeze', user_id: 'legacy-owner', type: 'task_freeze', amount: -10, related_task_id: task.id, metadata_json: JSON.stringify({ allocations: JSON.parse(snapshot) }) } });
  await state.transitionVideoTask(task.id, task, 'succeeded');
  assert.equal((await db.creditAccount.findUnique({ where: { user_id: 'legacy-owner' } })).frozen_credits, 0, 'ordinary completion of a pre-upgrade active task must still settle its original reservation');
  assert.equal(await db.creditHold.count({ where: { business_id: task.id } }), 0, 'compatibility must not backfill CreditHold');
  await db.creditAccount.create({ data: { user_id: 'old-unknown-owner', balance: 100, frozen_credits: 10 } });
  const unknown = await db.videoTask.create({ data: { id: 'old-submitted-unknown', local_status: 'submitted', provider: 'seedance', user_id: 'old-unknown-owner', frozen_cost: 10, credit_freeze_snapshot: snapshot } });
  await db.creditLedger.create({ data: { id: 'old-unknown-freeze', type: 'task_freeze', related_task_id: unknown.id, user_id: unknown.user_id, amount: -10, metadata_json: JSON.stringify({ allocations: JSON.parse(snapshot) }) } });
  await load('src/lib/video/reconciler.ts').reconcileVideoTask(unknown.id, { lookup: async () => ({ state: 'found', providerTaskId: 'old-original-job' }) });
  assert.equal((await db.videoTask.findUnique({ where: { id: unknown.id } })).provider_task_id, 'old-original-job');
  assert.equal((await db.creditAccount.findUnique({ where: { user_id: unknown.user_id } })).frozen_credits, 10);
  console.log('PASS pre-upgrade active video completes without importing a hold');
}

function actualFunction(file, name, context) {
  const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `Actual function ${name} exists`);
  const code = ts.transpileModule(declaration.getText(tree), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function('exports', ...Object.keys(context), `${code}\nexports.${name}=${name};`)(exports, ...Object.values(context));
  return exports[name];
}
async function legacyImagesAndTools() {
  const holds = load('src/lib/billing/holds.ts'), legacy = load('src/lib/billing/legacy-inflight.ts');
  const pricing = load('src/lib/image-studio/pricing-state.ts');
  const snapshot = JSON.stringify([{ source_type: 'balance', amount: 10 }]);
  for (const kind of ['image', 'tool']) {
    const id = `legacy-${kind}`, owner = `owner-${kind}`;
    await db.creditAccount.create({ data: { user_id: owner, balance: 100, frozen_credits: 10 } });
    const task = await db.imageStudioTask.create({ data: { id, owner_id: owner, status: kind === 'image' ? 'running' : 'queued', unit_credits: 10,
      freeze_snapshot: snapshot, billing_mode: 'fixed', billing_status: 'fixed', billing_settled_at: null, lease_token: 'lease', lease_until: new Date(Date.now() + 60000) } });
    const freeze = await db.creditLedger.create({ data: { id: `${id}-freeze`, type: 'task_freeze', related_task_id: id, user_id: owner, amount: -10, metadata_json: JSON.stringify({ allocations: JSON.parse(snapshot) }) } });
    const context = { prisma: db, ...holds, ...legacy, ...pricing, parseImageBillingContract: () => null, studioDimensionMismatch: () => false };
    if (kind === 'image') {
      const finish = actualFunction('src/lib/image-studio/tasks.ts', 'finishStudioTask', context);
      assert.equal(await db.$transaction(tx => finish(task, 'succeeded', {}, tx)), true);
      assert.equal(await db.$transaction(tx => finish(task, 'succeeded', {}, tx)), false);
    } else {
      const cancel = actualFunction('src/lib/tools/toolflow-runtime.ts', 'cancelQueuedTask', context);
      await db.$transaction(tx => cancel(tx, task));
      await db.$transaction(tx => cancel(tx, task));
    }
    assert.equal((await db.creditAccount.findUnique({ where: { user_id: owner } })).balance, kind === 'image' ? 90 : 100);
    assert.equal((await db.creditAccount.findUnique({ where: { user_id: owner } })).frozen_credits, 0);
    assert.equal(await db.creditLedger.count({ where: { idempotency_key: `legacy-inflight:${id}:settle` } }), 1);
    assert.equal(await db.creditHold.count({ where: { business_id: id } }), 0);
    assert.deepEqual(await db.creditLedger.findUnique({ where: { id: freeze.id } }), freeze);
  }
  console.log('PASS actual image finish and tool queued-cancel preserve old in-flight completion once, without hold backfill');
}
async function legacyProjectAndD4() {
  const state = load('src/lib/video/task-state.ts'), legacy = load('src/lib/billing/legacy-inflight.ts'), holds = load('src/lib/billing/holds.ts');
  const account = await db.projectBudgetAccount.create({ data: { id: 'old-budget', project_id: 'old-project', budget_credits: 100, used_credits: 0, frozen_credits: 10, status: 'active' } });
  const snapshot = JSON.stringify({ source_type: 'project_budget', project_id: account.project_id, account_id: account.id, amount: 10 });
  const task = await db.videoTask.create({ data: { id: 'old-project-job', local_status: 'running', billing_scope: 'project', project_id: account.project_id, frozen_cost: 10, credit_freeze_snapshot: snapshot } });
  await db.projectBudgetLedger.create({ data: { id: 'old-budget-freeze', type: 'task_freeze', project_id: account.project_id, account_id: account.id, related_task_id: task.id, amount: -10 } });
  await state.transitionVideoTask(task.id, task, 'succeeded');
  assert.equal((await db.projectBudgetAccount.findUnique({ where: { id: account.id } })).used_credits, 10);
  assert.equal(await db.projectBudgetLedger.count({ where: { idempotency_key: `legacy-inflight:${task.id}:settle` } }), 1);
  assert.equal(await db.creditHold.count({ where: { business_id: task.id } }), 0);

  const old = await db.videoTask.create({ data: { id: 'old-terminal-d4', local_status: 'succeeded', frozen_cost: 10, actual_cost: 0, user_id: 'do-not-charge' } });
  await state.transitionVideoTask(old.id, old, 'succeeded');
  await load('src/lib/video/reconciler.ts').reconcileVideoTask(old.id);
  assert.deepEqual(await db.videoTask.findUnique({ where: { id: old.id } }), old);
  await assert.rejects(db.$transaction(async tx => {
    await legacy.authorizeLegacyInflight(tx, 'video', old.id);
    await holds.settleTaskCredits(tx, { taskId: old.id, userId: 'do-not-charge', frozenAmount: 10, terminalStatus: 'succeeded' });
  }), /LEGACY_REVIEW_REQUIRED/);
  const refunded = await db.videoTask.create({ data: { id: 'old-refunded-active', local_status: 'running', user_id: 'already-refunded', frozen_cost: 10, credit_freeze_snapshot: JSON.stringify([{ source_type: 'balance', amount: 10 }]) } });
  await db.creditAccount.create({ data: { user_id: 'already-refunded', balance: 100, frozen_credits: 0 } });
  await db.creditLedger.create({ data: { id: 'refunded-freeze', type: 'task_freeze', user_id: 'already-refunded', related_task_id: refunded.id, amount: -10 } });
  await db.creditLedger.create({ data: { id: 'prior-refund', type: 'task_failed_refund', user_id: 'already-refunded', related_task_id: refunded.id, amount: 10 } });
  await assert.rejects(state.transitionVideoTask(refunded.id, refunded, 'succeeded'), /LEGACY_REVIEW_REQUIRED/);
  assert.equal((await db.creditAccount.findUnique({ where: { user_id: 'already-refunded' } })).balance, 100);
  console.log('PASS old project completion works; terminal history and existing refunds remain D4/read-only with no recharge');
}
async function ageReviewRecovery() {
  const state = load('src/lib/video/task-state.ts'), reconciler = load('src/lib/video/reconciler.ts');
  for (const genuine of [false, true]) {
    const id = genuine ? 'genuine-review' : 'prior-age-review';
    await db.creditAccount.create({ data: { user_id: id, balance: 100, frozen_credits: 10 } });
    const task = await db.videoTask.create({ data: { id, provider: 'seedance', user_id: id, local_status: 'unknown', frozen_cost: 10 } });
    const hold = await db.creditHold.create({ data: { business_type: 'video', business_id: id, payer_type: 'user', payer_id: id,
      amount: 10, freeze_snapshot: JSON.stringify([{ source_type: 'balance', amount: 10 }]), opening_receipt: '{}', state: 'review',
      review_reason: genuine ? 'source_mismatch' : 'held_over_24_hours', created_at: new Date('2000-01-01'), updated_at: new Date('2000-01-01') } });
    await reconciler.reconcileVideoBilling({ now: new Date('2031-01-01'), limit: 100 });
    const fresh = await db.videoTask.findUnique({ where: { id } });
    if (genuine) {
      assert.equal(fresh.local_status, 'unknown');
      await assert.rejects(state.transitionVideoTask(id, fresh, 'succeeded'), /LEGACY_REVIEW_REQUIRED/);
      assert.equal((await db.creditHold.findUnique({ where: { id: hold.id } })).state, 'review');
    } else {
      assert.equal(fresh.local_status, 'submitted', 'age-only review from the earlier candidate must still be scanned');
      await state.transitionVideoTask(id, fresh, 'succeeded');
      assert.equal((await db.creditHold.findUnique({ where: { id: hold.id } })).state, 'captured');
    }
  }
  console.log('PASS prior age-only review can recover; genuine source ambiguity cannot silently finalize');
}
async function migrationCompatibility() {
  const { DatabaseSync } = require('node:sqlite');
  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE VideoTask(id TEXT PRIMARY KEY,local_status TEXT);CREATE TABLE CreditLedger(id TEXT PRIMARY KEY,idempotency_key TEXT,type TEXT,user_id TEXT,related_task_id TEXT,metadata_json TEXT);CREATE TABLE ProjectBudgetLedger(id TEXT PRIMARY KEY,idempotency_key TEXT,type TEXT,project_id TEXT,account_id TEXT,related_task_id TEXT,metadata_json TEXT);');
  sql.exec("INSERT INTO CreditLedger(id,type,user_id,related_task_id) VALUES('original-freeze','task_freeze','owner','old-job');INSERT INTO ProjectBudgetLedger(id,type,project_id,account_id,related_task_id) VALUES('original-project-freeze','task_freeze','p','a','old-project-job')");
  const before = sql.prepare('SELECT * FROM CreditLedger').all();
  for (const name of ['202610270001_audit_billing_holds', '202610270002_legacy_inflight_guards']) sql.exec(fs.readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'));
  assert.deepEqual(sql.prepare('SELECT * FROM CreditLedger').all(), before);
  assert.throws(() => sql.exec(`INSERT INTO CreditLedger(id,type,user_id,related_task_id,metadata_json) VALUES('missing-key','task_success_deduct','owner','old-job','{"legacy_freeze_ledger_id":"original-freeze"}')`));
  sql.exec(`INSERT INTO CreditLedger(id,type,user_id,related_task_id,idempotency_key,metadata_json) VALUES('completion','task_success_deduct','owner','old-job','legacy-inflight:old-job:settle','{"legacy_freeze_ledger_id":"original-freeze"}')`);
  assert.throws(() => sql.exec(`INSERT INTO CreditLedger(id,type,user_id,related_task_id,metadata_json) VALUES('old-style','task_success_deduct','owner','old-job','{"legacy_freeze_ledger_id":"original-freeze"}')`));
  assert.throws(() => sql.exec(`INSERT INTO CreditLedger(id,type,user_id,related_task_id,idempotency_key,metadata_json) VALUES('again','task_failed_refund','owner','old-job','legacy-inflight:old-job:settle','{"legacy_freeze_ledger_id":"original-freeze"}')`));
  assert.throws(() => sql.exec(`INSERT INTO CreditLedger(id,type,user_id,related_task_id,idempotency_key,metadata_json) VALUES('wrong-owner','task_success_deduct','other','old-job','legacy-inflight:old-job:settle','{"legacy_freeze_ledger_id":"original-freeze"}')`));
  sql.exec(`INSERT INTO ProjectBudgetLedger(id,type,project_id,account_id,related_task_id,idempotency_key,metadata_json) VALUES('pc','task_success_deduct','p','a','old-project-job','legacy-inflight:old-project-job:settle','{"legacy_freeze_ledger_id":"original-project-freeze"}')`);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM CreditHold').get().n, 0);
  assert.deepEqual(sql.prepare("SELECT * FROM CreditLedger WHERE id='original-freeze'").all(), before);
  sql.close();
  console.log('PASS actual SQLite guard upgrade permits one anchored legacy completion, rejects replay/wrong owner, and never backfills');
}
async function actualEntryGuards() {
  for (const [surface, file] of [
    ['ordinary', 'src/server/video-tasks/standard-create.ts'], ['multiview', 'src/server/video-tasks/standard-create.ts'],
    ['ip', 'src/server/video-tasks/ip-create.ts'], ['enhance', 'src/app/api/tasks/enhance-video/create/route.ts'],
    ['draft-upgrade', 'src/lib/tasks/seedance-draft-upgrade.ts'],
  ]) {
    const source = fs.readFileSync(file, 'utf8'), tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    let providerTry;
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(tree) === 'submitToProvider') {
        let parent = node.parent;
        while (parent && !ts.isTryStatement(parent)) parent = parent.parent;
        providerTry = parent;
      }
      ts.forEachChild(node, visit);
    }
    visit(tree); assert.ok(providerTry?.catchClause, `${surface} actual provider try/catch`);
    const body = providerTry.catchClause.block.getText(tree);
    const failure = body.search(/await (handleProviderFailure|releaseFrozenCreditsAfterProviderFailure|settleDraftUpgradeFailure)\(/);
    const guard = body.indexOf(surface === 'ip' ? 'if (submissionStarted && !explicitProviderRejection)' : "if (providerSubmissionAttempted && !(" );
    assert.ok(guard >= 0 && failure > guard, `${surface} guards generic post-attempt failures before the refund branch`);
    assert.match(body, /ProviderSubmissionError.*outcome === 'rejected'/s);
    assert.match(providerTry.tryBlock.getText(tree), surface === 'ip' ? /submissionStarted = true/ : /providerSubmissionAttempted = true/);
  }
  console.log('PASS control-flow review of all five actual submission entrypoints; dynamic draft path tested separately');
}
(async () => {
  for (const test of [main, overdue, legacyVideo, legacyImagesAndTools, legacyProjectAndD4, ageReviewRecovery, migrationCompatibility, actualEntryGuards]) {
    try { await test(); } catch (error) { console.error(error); process.exitCode = 1; }
  }
})().finally(async () => { await db.$disconnect(); console.log(`Synthetic DB: ${dir}/synthetic.sqlite`); });
