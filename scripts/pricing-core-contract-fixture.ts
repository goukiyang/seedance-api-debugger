import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Prisma } from '@prisma/client';
import type { FrozenPricingCharge } from '@/lib/pricing/charge';
import type { PricingAdminAction, PricingAdminActor, PricingAdminSnapshot } from '@/lib/pricing/admin-contract';

type Check = { id: string; assertions: number; evidence: string[] };
const checks = new Map<string, Check>();
let active: Check;
function group(id: string, evidence: string) {
  active = checks.get(id) || { id, assertions: 0, evidence: [] };
  active.evidence.push(evidence); checks.set(id, active);
}
function equal(actual: unknown, expected: unknown, message?: string) { assert.deepEqual(actual, expected, message); active.assertions++; }
function ok(value: unknown, message?: string) { assert.ok(value, message); active.assertions++; }
function throws(fn: () => unknown) { assert.throws(fn); active.assertions++; }
async function rejects(fn: () => Promise<unknown>) { await assert.rejects(fn); active.assertions++; }

async function main() {
  const candidateRoot = fs.realpathSync(process.cwd());
  // Keep production errors and fixture predicates in one CJS module cache on Node 20.
  const fixtureRequire = createRequire(path.join(candidateRoot, 'scripts/pricing-core-contract-fixture.ts'));
  const databasePath = process.env.PRICING_CORE_FIXTURE_DB;
  assert.ok(databasePath && path.isAbsolute(databasePath) && path.basename(databasePath).includes('pricing-core-fixture'));
  const fixtureRoot = fs.realpathSync(process.env.PRICING_CORE_RUNTIME_ROOT || path.dirname(databasePath));
  assert.ok(fixtureRoot.startsWith(path.join(candidateRoot, '.role-tests') + path.sep));
  const { PrismaClient } = fixtureRequire('@prisma/client') as typeof import('@prisma/client');
  const pricingTransactionQueries: string[] = [];
  const db = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } }, log: [{ level: 'query', emit: 'event' }] });
  db.$on('query', event => { if (/^(BEGIN|COMMIT|ROLLBACK)\b/.test(event.query)) pricingTransactionQueries.push(event.query); });
  assert.equal(await db.user.count(), 0); assert.equal(await db.platformSetting.count(), 0);
  Reflect.set(globalThis, 'prisma', db);
  const math = fixtureRequire('@/lib/pricing/math') as typeof import('@/lib/pricing/math');
  const { selectPricingRule, assertNoRuleAmbiguity } = fixtureRequire('@/lib/pricing/resolve') as typeof import('@/lib/pricing/resolve');
  const precision = fixtureRequire('@/lib/credits/precision') as typeof import('@/lib/credits/precision');
  const { frozenPricingCredits, frozenPricingReservation, parseFrozenPricingCharge } = fixtureRequire('@/lib/pricing/charge') as typeof import('@/lib/pricing/charge');
  const { fixedImageBillingContract, withPricingImageContract } = fixtureRequire('@/lib/image-studio/billing-quote') as typeof import('@/lib/image-studio/billing-quote');
  const { parseImageBillingContract, billedImageContractCredits } = fixtureRequire('@/lib/image-studio/billing-contract') as typeof import('@/lib/image-studio/billing-contract');
  const { allocateTaskCredits, settleTaskCredits } = fixtureRequire('@/lib/credits/policy') as typeof import('@/lib/credits/policy');
  const { allocateProjectTaskBudget, settleProjectTaskBudget, adjustProjectBudget } = fixtureRequire('@/lib/projects/budget') as typeof import('@/lib/projects/budget');
  const { finishStudioTask, submitStudioBatch, STUDIO_SHARED_WORKER_FILES } = fixtureRequire('@/lib/image-studio/tasks') as typeof import('@/lib/image-studio/tasks');
  const { settleImageSupplierCharge } = fixtureRequire('@/lib/image-studio/billing') as typeof import('@/lib/image-studio/billing');
  const { matchImageSupplierCharge } = fixtureRequire('@/lib/image-studio/billing-provider') as typeof import('@/lib/image-studio/billing-provider');
  const { getAdminPricingSnapshot, previewAdminPricing, saveAdminPricing } = fixtureRequire('@/lib/pricing/policy') as typeof import('@/lib/pricing/policy');
  const { PRICING_REVISION_PREFIX } = fixtureRequire('@/lib/pricing/admin-contract') as typeof import('@/lib/pricing/admin-contract');
  const runtime = fixtureRequire('@/lib/pricing/runtime') as typeof import('@/lib/pricing/runtime');
  const isolation = fixtureRequire('@/lib/pricing/isolation') as typeof import('@/lib/pricing/isolation');
  const { IMAGE_GENERATION_API_SETTING_KEY } = fixtureRequire('@/lib/integrations/image-generation') as typeof import('@/lib/integrations/image-generation');
  const { VOLCENGINE_IP_API_SETTING_KEY } = fixtureRequire('@/lib/integrations/volcengine-ip') as typeof import('@/lib/integrations/volcengine-ip');
  const { quoteStudioBatch, batchQuoteFingerprint, consumeBatchQuote } = fixtureRequire('@/lib/image-studio/batch-billing-quote') as typeof import('@/lib/image-studio/batch-billing-quote');
  const { createStudioBatch, dispatchStudioBatches, continuationInput, updateStudioBatch } = fixtureRequire('@/lib/image-studio/batches') as typeof import('@/lib/image-studio/batches');
  const { studioBatchBudgetPrecision } = fixtureRequire('@/lib/image-studio/batch-contract') as typeof import('@/lib/image-studio/batch-contract');
  const { prepareImageBillingQuote } = fixtureRequire('@/lib/image-studio/billing-quote-service') as typeof import('@/lib/image-studio/billing-quote-service');
  const { imageQuoteKey } = fixtureRequire('@/lib/image-studio/billing-quote-store') as typeof import('@/lib/image-studio/billing-quote-store');
  const { PricingChargeError } = fixtureRequire('@/lib/pricing/charge') as typeof import('@/lib/pricing/charge');
  const { getCanvasImageQuote } = fixtureRequire('@/lib/canvas-quote') as typeof import('@/lib/canvas-quote');
  const { createSynchronousImageAdmission } = fixtureRequire('@/lib/image-studio/synchronous-admission') as typeof import('@/lib/image-studio/synchronous-admission');
  const { runPricingImageCandidateContractFixture, pricingImageCandidateFixtureErrorClasses } = fixtureRequire('./pricing-image-candidate-contract-fixture') as typeof import('./pricing-image-candidate-contract-fixture');
  const { PricingItemUnavailableError } = fixtureRequire('@/lib/pricing/item-unavailable') as typeof import('@/lib/pricing/item-unavailable');
  const frozenCharge = fixtureRequire('@/lib/pricing/frozen-charge') as typeof import('@/lib/pricing/frozen-charge');
  const { prisma } = fixtureRequire('@/lib/prisma') as typeof import('@/lib/prisma');
  assert.equal(prisma, db, 'Business modules must retain the injected isolated client');
  assert.equal(pricingImageCandidateFixtureErrorClasses.PricingRuntimeError, runtime.PricingRuntimeError, 'Runtime error constructors must share one module instance');
  assert.equal(pricingImageCandidateFixtureErrorClasses.PricingItemUnavailableError, PricingItemUnavailableError, 'Item error constructors must share one module instance');
  assert.equal(PricingChargeError, frozenCharge.PricingChargeError, 'Charge re-exports must retain the original error constructor');
  const now = new Date().toISOString();
  const charge = (changes: Partial<FrozenPricingCharge> = {}): FrozenPricingCharge => ({
    schema: 'pricing-charge-v1', revision: 'fixture-revision', ruleId: 'fixture-rule',
    identity: { kind: 'image', channelId: 'shared', modelId: 'gpt-image-2', billingMode: 'fixed', unit: 'image', specifications: {} },
    binding: { configRevision: 'fixture-config', billingPrincipalId: 'fixture-scope', credentialVersion: 'fixture-credential-version', configFingerprint: 'fixture-configuration' },
    basisKind: 'site_base_cny', mode: 'custom', baseCny: '1', pointsPerCny: '10', exchangeRate: null,
    legacyUnitCredits: null, legacyRounding: null, quantity: '1', issuedAt: now, rounding: 'half_up_tenth', ...changes,
  });
  const actual = charge({ identity: { ...charge().identity, billingMode: 'actual' }, basisKind: 'supplier_cost_cny', baseCny: null,
    exchangeRate: { sourceCurrency: 'USD', targetCurrency: 'CNY', direction: 'CNY_per_source_unit', rate: '7', revision: 'fx-one',
      effectiveFrom: now, confirmedAt: now, confirmedBy: { id: 'fixture-admin', displayName: 'Pricing fixture admin', avatarUrl: null },
      source: { type: 'admin_defined', reference: 'fixture FX 7 CNY / USD', note: 'Synthetic exchange rate for isolated contract checks; not a supplier statement.' } } });
  const baseContract = (price: number) => fixedImageBillingContract({ scope: 'a'.repeat(64), model: 'gpt-image-2', credits: price, specification: 'b'.repeat(64) });

  group('G01', 'Production decimal engine and frozen charge distinguish missing basis, explicit free and a rounded nonzero price.');
  equal(frozenPricingCredits(charge({ pointsPerCny: '15' })).credits, 15);
  equal(frozenPricingCredits(charge({ baseCny: '0.5', pointsPerCny: '16' })).credits, 8);
  throws(() => frozenPricingCredits(charge({ baseCny: null })));
  equal(frozenPricingCredits(charge({ mode: 'free', baseCny: null, pointsPerCny: null })).credits, 0);
  for (const value of ['-1', 'NaN', 'Infinity', '1e1', '+1', ' 1', '0.11', '10000.1']) {
    throws(() => math.normalizeDecimal(value, { maxScale: 1, min: '0.1', max: '10000' }));
  }
  group('G04', 'The actual frozen pricing engine computes the two distinct source bases and three independent Pro tasks.');
  const before = [charge({ pointsPerCny: '15' }), charge({ baseCny: '0.5', pointsPerCny: '16' })];
  equal(before.map(item => frozenPricingCredits(item).credits), [15, 8]);
  equal(before.map(item => frozenPricingCredits({ ...item, pointsPerCny: '10' }).credits), [10, 5]);
  equal(precision.sumCredits(Array.from({ length: 3 }, () => frozenPricingCredits(before[0]).credits)), 45);
  equal(precision.sumCredits(Array.from({ length: 3 }, () => frozenPricingCredits(charge()).credits)), 30);
  group('G05', 'Real scope selection keeps channel, unit, model and billing mode distinct.');
  const rule = { id: 'generic', identity: charge().identity };
  equal(selectPricingRule([rule], rule.identity)?.id, 'generic');
  equal(selectPricingRule([rule], { ...rule.identity, channelId: 'banana' }), null);
  equal(selectPricingRule([rule], { ...rule.identity, unit: 'second' }), null);
  equal(selectPricingRule([rule], { ...rule.identity, billingMode: 'actual' }), null);
  group('G06', 'No intermediate rounding: final half-up tenth per independent task, including the non-free rounded-zero flag.');
  equal(frozenPricingCredits(charge({ baseCny: '0.234' })).credits, 2.3);
  equal(frozenPricingCredits(charge({ baseCny: '0.235' })).credits, 2.4);
  equal(frozenPricingCredits(charge({ baseCny: '0.15', pointsPerCny: '1', quantity: '3' })).credits, 0.5);
  equal(precision.sumCredits(Array.from({ length: 3 }, () => frozenPricingCredits(charge({ baseCny: '0.15', pointsPerCny: '1' })).credits)), 0.6);
  equal(frozenPricingCredits(charge({ baseCny: '0.00000001', pointsPerCny: '0.1' })).roundedToZero, true);
  equal(frozenPricingCredits(charge({ mode: 'free' })).roundedToZero, false);
  group('G09', 'Both production image contract parsers and billing formulas execute, without rewriting cost02-v1.');
  const legacyActual = { ...baseContract(2), mode: 'actual' as const, deadline: new Date(Date.now() + 86400000).toISOString() };
  ok(parseImageBillingContract(JSON.stringify(legacyActual)));
  equal(billedImageContractCredits(legacyActual, 35000), 1.23);
  const newActual = withPricingImageContract(baseContract(80), actual, 80);
  ok(parseImageBillingContract(JSON.stringify(newActual)));
  equal(billedImageContractCredits(newActual, 1000000), 70);
  equal(billedImageContractCredits(legacyActual, 35000), 1.23);
  group('G14', 'Actual pricing needs no invented fixed base; reservations round upward on the new tenth boundary.');
  equal(parseFrozenPricingCharge(actual)?.baseCny, null);
  equal(frozenPricingCredits(actual, 1000000).credits, 70);
  const oneUsdPoint = { ...actual, pointsPerCny: '5', exchangeRate: { ...actual.exchangeRate!, rate: '7' } };
  equal(frozenPricingReservation(oneUsdPoint, 1.01), 1.1);
  throws(() => frozenPricingReservation({ ...actual, exchangeRate: { ...actual.exchangeRate!, sourceCurrency: 'CNY', rate: '1' } }, 1.01));
  group('G16', 'Production matcher selects the unique most specific subset and rejects equal-priority overlapping scopes.');
  const specific = { id: 'specific', identity: { ...rule.identity, specifications: { resolution: '2K' } } };
  equal(selectPricingRule([rule, specific], specific.identity)?.id, 'specific');
  const crossing = { id: 'crossing', identity: { ...rule.identity, specifications: { quality: 'high' } } };
  throws(() => assertNoRuleAmbiguity([specific, crossing]));
  throws(() => selectPricingRule([specific, crossing], { ...specific.identity, specifications: { resolution: '2K', quality: 'high' } }));
  equal(selectPricingRule([specific], { ...rule.identity, specifications: { resolution: '4K' } }), null);
  group('G21', 'Production numeric parsers cover bounds, adjacent minimum units, exact cents and bounded binary representation noise.');
  equal(math.normalizeDecimal('0.1', { min: '0.1', max: '10000', maxScale: 1 }), '0.1');
  equal(math.normalizeDecimal('10000.0', { min: '0.1', max: '10000', maxScale: 1 }), '10000');
  for (const value of ['0.0', '10000.1', '1e3', '0.15', '1'.repeat(33), '1.000000000']) throws(() => math.normalizeDecimal(value, { min: '0.1', max: '10000', maxScale: 1 }));
  for (const value of [0.001, 0.100001, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, 1e-20]) throws(() => precision.creditCents(value));
  equal(precision.creditCents(0.1 + 0.2), 30);
  equal(precision.subtractCredits(0.15, 0.1), 0.05);
  equal(precision.addCredits(9999999.9, 0.1), 10000000);
  equal(studioBatchBudgetPrecision(null, 0.01, 100.15), 1);
  equal(studioBatchBudgetPrecision('new-policy', 0.1, 100.1), 0.1);
  equal(studioBatchBudgetPrecision('new-policy', 0.1, 100.15), 0.01);
  equal(studioBatchBudgetPrecision('adopted-legacy', 0.01, 100.15), 0.01);
  group('G24', 'Frozen USD conversion, CNY identity conversion, currency rejection and immutable late-bill values execute in the real engine.');
  equal(frozenPricingCredits(actual, 1000000, 'USD').credits, 70);
  equal(frozenPricingCredits({ ...actual, exchangeRate: { ...actual.exchangeRate!, sourceCurrency: 'CNY', rate: '1' } }, 1000000, 'CNY').credits, 10);
  throws(() => frozenPricingCredits(actual, 1000000, 'CNY'));
  throws(() => frozenPricingCredits(actual, 1000000, 'EUR' as 'USD'));
  const serialized = JSON.stringify(actual), later = { ...actual, exchangeRate: { ...actual.exchangeRate!, rate: '8' } };
  equal(frozenPricingCredits(later, 1000000).credits, 80);
  equal(frozenPricingCredits(JSON.parse(serialized), 1000000).credits, 70);

  const user = await db.user.create({ data: { id: `pricing-core-${randomUUID()}`, name: 'Pricing fixture admin',
    username: randomUUID(), email: `${randomUUID()}@fixture.invalid`, password_hash: 'fixture-not-a-login', role: 'admin', status: 'active' } });
  await db.creditAccount.create({ data: { user_id: user.id, balance: 1000.15 } });
  await db.creditBucket.create({ data: { id: 'pricing-core-bucket', user_id: user.id, source_type: 'daily_quota',
    amount_total: 0.15, amount_remaining: 0.15, expires_at: new Date(Date.now() + 86400000), idempotency_key: 'pricing-core-bucket' } });
  const project = await db.project.create({ data: { name: 'Pricing isolated budget', owner_user_id: user.id, created_by: user.id, type: 'personal' } });
  await db.$transaction(tx => adjustProjectBudget(tx, { projectId: project.id, amount: 100, operatorId: user.id, reason: 'isolated fixture' }));
  group('G21', 'Actual SQLite account/bucket/project allocation and settlement repeat without Float accumulation or snapshot guessing.');
  let consumed = 0;
  for (let index = 0; index < 60; index++) {
    const amount = index % 2 ? 0.2 : 0.1, status = index % 3 ? 'succeeded' as const : 'failed' as const;
    await db.$transaction(async tx => {
      const frozen = await allocateTaskCredits(tx, user, amount, `precision-${index}`);
      const settled = await settleTaskCredits(tx, { taskId: `precision-${index}`, userId: user.id,
        frozenAmount: amount, terminalStatus: status, freezeSnapshot: frozen.snapshot });
      equal(precision.creditCents(settled.frozenBefore) - precision.creditCents(settled.frozenAfter), precision.creditCents(amount));
      equal(settled.actualCost, status === 'succeeded' ? amount : 0);
      const budget = await allocateProjectTaskBudget(tx, { projectId: project.id, taskId: `precision-${index}`, amount, operatorId: user.id });
      await settleProjectTaskBudget(tx, { projectId: project.id, taskId: `precision-${index}`, frozenAmount: amount,
        freezeSnapshot: budget.snapshot, terminalStatus: status, operatorId: user.id });
    });
    if (status === 'succeeded') consumed = precision.addCredits(consumed, amount);
  }
  const account = await db.creditAccount.findUniqueOrThrow({ where: { user_id: user.id } });
  const bucket = await db.creditBucket.findUniqueOrThrow({ where: { id: 'pricing-core-bucket' } });
  equal(precision.addCredits(account.balance, bucket.amount_remaining), precision.subtractCredits(1000.3, consumed));
  equal(account.frozen_credits, 0); equal(bucket.frozen_amount, 0);
  const budget = await db.projectBudgetAccount.findUniqueOrThrow({ where: { project_id: project.id } });
  equal(budget.used_credits, consumed); equal(budget.frozen_credits, 0);
  await rejects(() => db.$transaction(tx => settleTaskCredits(tx, { taskId: 'bad-snapshot', userId: user.id,
    frozenAmount: 0.1, terminalStatus: 'failed', freezeSnapshot: '{broken' })));
  await rejects(() => db.$transaction(tx => allocateTaskCredits(tx, user, 0.001, 'bad-precision')));

  async function task(contract: ReturnType<typeof baseContract>, status = 'succeeded', billingStatus = 'rate_pending') {
    const id = `${contract.pricing ? 'rate-' : ''}${randomUUID()}`;
    return db.$transaction(async tx => {
      const frozen = await allocateTaskCredits(tx, user, contract.authorizedCredits, id);
      await tx.creditLedger.create({ data: { user_id: user.id, type: 'task_freeze', amount: -contract.authorizedCredits,
        balance_before: frozen.balance_before, balance_after: frozen.balance_after, frozen_before: frozen.frozen_before,
        frozen_after: frozen.frozen_after, related_task_id: id, idempotency_key: `image-studio:freeze:${id}` } });
      return tx.imageStudioTask.create({ data: { id, batch_id: id, owner_id: user.id, ordinal: 1, fingerprint: 'c'.repeat(64),
        prompt: 'isolated financial contract fixture', context: '', revision: 0, model: contract.model, quality: 'auto',
        reference_ids: '[]', unit_credits: contract.authorizedCredits, freeze_snapshot: frozen.snapshot,
        billing_mode: contract.mode, billing_scope: contract.scope, billing_contract_json: JSON.stringify(contract), billing_status: billingStatus,
        billing_deadline: contract.deadline ? new Date(contract.deadline) : null, gateway_request_id: `provider-${id}`,
        status, lease_token: 'fixture-lease', lease_until: new Date(Date.now() + 60000) } });
    });
  }
  const bill = (task: { gateway_request_id: string | null; model: string }, amountMicros: number) => ({
    requestId: task.gateway_request_id!, model: task.model, amountMicros, quota: amountMicros / 2,
    occurredAt: new Date(), type: 2, promptTokens: null, completionTokens: null });
  group('G10', 'Real reconciler matches original supplier identity, settles once, refuses unknown/conflicting bills and never charges an over-limit refund.');
  const actualTask = await task(newActual);
  equal(matchImageSupplierCharge([], actualTask.gateway_request_id!, actualTask.model).state, 'missing');
  equal(await settleImageSupplierCharge(actualTask.id, bill(actualTask, 1000000)), true);
  equal((await db.imageStudioTask.findUniqueOrThrow({ where: { id: actualTask.id } })).actual_credits, 70);
  equal(await settleImageSupplierCharge(actualTask.id, bill(actualTask, 1000000)), false);
  equal(await db.costLedger.count({ where: { image_task_id: actualTask.id } }), 1);
  const capped = await task(withPricingImageContract(baseContract(1), actual, 1));
  equal(await settleImageSupplierCharge(capped.id, bill(capped, 1000000)), true);
  const cappedResult = await db.imageStudioTask.findUniqueOrThrow({ where: { id: capped.id } });
  equal(cappedResult.actual_credits, 0); equal(cappedResult.billing_status, 'rate_over_limit');
  const unknown = await task(newActual, 'rate_uncertain', 'rate_channel_awaiting_response');
  equal(await settleImageSupplierCharge(unknown.id, bill(unknown, 1000000)), false);
  equal((await db.imageStudioTask.findUniqueOrThrow({ where: { id: unknown.id } })).billing_settled_at, null);
  const fixed = await task(withPricingImageContract(baseContract(0.2), charge({ baseCny: '0.15', pointsPerCny: '1' }), 0.2), 'rate_running', 'rate_awaiting_response');
  equal(await finishStudioTask(fixed, 'failed'), true);
  equal(await finishStudioTask(fixed, 'failed'), false);
  equal(await db.creditLedger.count({ where: { related_task_id: fixed.id, type: 'task_failed_refund' } }), 1);
  const mismatch = fixtureRequire('@/lib/image-studio/dimension-mismatch') as typeof import('@/lib/image-studio/dimension-mismatch');
  const visibleMismatch = { status: 'rate_uncertain', asset_id: 'fixture-visible-original', usage_json: JSON.stringify({ studioDelivery: {
    code: 'generated_dimensions_mismatch', originalSha256: 'a'.repeat(64), originalBytes: 100,
    validation: { originalFormat: 'png', storedFormat: 'png', width: 64, height: 64, requestedSize: '1024x1024' },
  } }) };
  ok(mismatch.studioTaskHasViewableOutput(visibleMismatch));
  equal(mismatch.studioTaskHasViewableOutput({ ...visibleMismatch, usage_json: '{}' }), false);

  for (const file of new Set([...runtime.pricingRuntimeSourceFiles(candidateRoot), ...STUDIO_SHARED_WORKER_FILES])) {
    const destination = path.join(fixtureRoot, file); fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(candidateRoot, file), destination);
  }
  const marker = path.join(fixtureRoot, 'storage/image-studio-drain');
  assert.equal(process.platform, 'linux', 'The mandatory pricing gate requires actual Linux permission/process evidence');
  assert.ok(isolation.readPricingWriterIsolation(fixtureRoot), 'Root must preinstall the real immutable isolated fixture marker');
  process.chdir(fixtureRoot);
  const source = process.env.PRICING_SOURCE_SHA;
  assert.ok(source && /^[a-f0-9]{40}$/.test(source));
  let captured = runtime.capturePricingWorkerCapability(source);
  await runtime.renewPricingWorkerCapability(db, captured);
  const { publishStudioWorkerReadiness } = fixtureRequire('@/lib/image-studio/worker-mode') as typeof import('@/lib/image-studio/worker-mode');
  const renewBatchReadiness = async () => {
    await runtime.renewPricingWorkerCapability(db, captured);
    await publishStudioWorkerReadiness({ acceptedOnly: false, workerId: captured.workerId, source,
      loadedModuleSha: Object.fromEntries(STUDIO_SHARED_WORKER_FILES.map(file => [file,
        createHash('sha256').update(fs.readFileSync(path.join(fixtureRoot, file))).digest('hex')])) }, db);
  };
  await renewBatchReadiness();
  group('G19', 'Production readiness uses actual Linux PID/start/cwd/module hashes and an actual root-owned immutable isolated marker.');
  ok(await runtime.assertPricingImageConsumerReady(db));
  const capabilityRow = await db.platformSetting.findUniqueOrThrow({ where: { key: runtime.PRICING_IMAGE_CAPABILITY_KEY } });
  await db.platformSetting.update({ where: { id: capabilityRow.id }, data: { value_json: JSON.stringify({ ...captured, expiresAt: new Date(0).toISOString() }) } });
  await rejects(() => runtime.assertPricingImageConsumerReady(db));
  await runtime.renewPricingWorkerCapability(db, captured);
  equal(isolation.isImageStudioDraining(path.join(fixtureRoot, 'g19-marker-cases/ordinary')), true);
  equal(isolation.readPricingWriterIsolation(path.join(fixtureRoot, 'g19-marker-cases/unprotected')), null);
  equal(isolation.readPricingWriterIsolation(path.join(fixtureRoot, 'g19-marker-cases/wrong-schema')), null);
  equal(fs.lstatSync(marker).uid, 0);
  equal(isolation.isImageStudioDraining(), false);

  await db.platformSetting.create({ data: { key: IMAGE_GENERATION_API_SETTING_KEY,
    value_json: JSON.stringify({ enabled: true, provider: 'musk', api_key: 'synthetic-not-a-provider-credential',
      base_url: 'https://api.muskapis.com/v1', default_model: 'gpt-image-2', supports_text_to_image: true, supports_image_to_image: true }) } });
  await db.platformSetting.create({ data: { key: VOLCENGINE_IP_API_SETTING_KEY,
    value_json: JSON.stringify({ enabled: true, api_key: 'synthetic-ip-key', base_url: 'https://fixture.invalid/api/v3', default_model: 'doubao-seedance-2-5-260628' }) } });
  const actor: PricingAdminActor = { id: user.id, displayName: user.name, avatarUrl: user.avatar_url };
  async function save(snapshot: PricingAdminSnapshot, action: PricingAdminAction) {
    const input = { expectedRevision: snapshot.revision, catalogFingerprint: snapshot.catalogFingerprint, action };
    const preview = await previewAdminPricing(actor, input);
    const result = await saveAdminPricing(actor, { ...input, previewToken: preview.previewToken, operationId: randomUUID() });
    assert.equal(result.state, 'succeeded'); assert.ok(result.snapshot); return result.snapshot!;
  }
  group('G11', 'Actual image quote, acceptance, canvas estimate and frozen task use the same adopted policy revision.');
  let snapshot = await getAdminPricingSnapshot(actor);
  const imageRow = snapshot.rows.find(row => row.identity.kind === 'image' && row.identity.channelId === 'shared' && row.identity.modelId === 'gpt-image-2')!;
  ok(imageRow);
  const moduleId = randomUUID();
  await db.imageStudioModule.create({ data: { id: moduleId, owner_id: user.id, name: 'Isolated pricing module', model: 'gpt-image-2', quality: 'auto', resolution: '1K' } });
  const imageBody = { moduleId, prompt: 'isolated fixture prompt', model: 'gpt-image-2', count: 3, quality: 'auto', resolution: '1K', aspectRatio: '1:1',
    referenceIds: [], revision: 0, requestId: randomUUID() };
  group('G17', 'Real v3 legacy-fixed quote acceptance is allowed only before RATE adoption; an old unconsumed quote cannot become a new frozen parent after adoption.');
  const legacyBatchBody = { ...imageBody, count: 1, requestId: randomUUID(), sources: [{ name: 'legacy-one' }], budget: 100 };
  const legacyBatchQuote = await quoteStudioBatch(user.id, legacyBatchBody);
  ok(legacyBatchQuote.batchQuoteId); equal(legacyBatchQuote.pricingRevision, null);
  const legacyParentId = await createStudioBatch(user.id, { ...legacyBatchBody, batchQuoteId: legacyBatchQuote.batchQuoteId,
    imageChannel: legacyBatchQuote.imageChannel });
  equal(await db.platformSetting.count({ where: { key: `image_batch_billing_quote_v1:${user.id}:${legacyBatchQuote.batchQuoteId}` } }), 0);
  const legacyParentKey = `studio_batch_v1:${user.id}:${legacyParentId}`;
  const legacyReady = JSON.parse((await db.platformSetting.findUniqueOrThrow({ where: { key: legacyParentKey } })).value_json);
  equal(legacyReady.state, 'ready'); equal(legacyReady.prepared, 1);
  await updateStudioBatch(user.id, { id: legacyParentId, action: 'pause' });
  const legacyParent = await db.platformSetting.findUniqueOrThrow({ where: { key: legacyParentKey } });
  const legacyContracts = JSON.parse(legacyParent.value_json).billingContracts;
  equal(legacyContracts.length, 1); equal(legacyContracts[0].mode, 'fixed'); equal(legacyContracts[0].pricing, undefined);
  equal(legacyContracts[0].estimateSource, 'legacy_fixed'); equal(legacyContracts[0].estimateVersion, 'legacy-fixed-v1');
  const unconsumedLegacyBody = { ...legacyBatchBody, requestId: randomUUID() };
  const unconsumedLegacy = await quoteStudioBatch(user.id, unconsumedLegacyBody);
  ok(unconsumedLegacy.batchQuoteId); equal(unconsumedLegacy.pricingRevision, null);
  const unconsumedLegacyKey = `image_batch_billing_quote_v1:${user.id}:${unconsumedLegacy.batchQuoteId}`;
  const unconsumedLegacyRow = await db.platformSetting.findUniqueOrThrow({ where: { key: unconsumedLegacyKey } });
  group('G11', 'Actual image quote, acceptance, canvas estimate and frozen task use the same adopted policy revision.');
  snapshot = await save(snapshot, { kind: 'save', changes: { standards: { site_base_cny: '1' }, rows: [
    { id: imageRow.id, mode: 'follow', base: { amount: '0.15', currency: 'CNY', unit: 'image', source: { type: 'admin_defined',
      reference: 'isolated source base', note: 'Synthetic image basis for isolated contract checks; not a supplier statement.' } } },
  ] } });
  captured = runtime.capturePricingWorkerCapability(source); await renewBatchReadiness();
  const adoptionAccount = await db.creditAccount.findUniqueOrThrow({ where: { user_id: user.id } });
  const adoptionTasks = await db.imageStudioTask.count(), adoptionLedger = await db.creditLedger.count();
  const adoptionParents = await db.platformSetting.count({ where: { key: { startsWith: 'studio_', contains: '_batch_v1:' } } });
  group('G17', 'Legacy quote -> real admin RATE adoption -> new parent rejection keeps the exact quote, account, ledger and task counts; accepted request IDs return their original parent before current pricing checks.');
  await assert.rejects(() => createStudioBatch(user.id, { ...unconsumedLegacyBody, batchQuoteId: unconsumedLegacy.batchQuoteId,
    imageChannel: unconsumedLegacy.imageChannel }), { status: 409 }); active.assertions++;
  equal((await db.platformSetting.findUniqueOrThrow({ where: { key: unconsumedLegacyKey } })).value_json, unconsumedLegacyRow.value_json);
  equal(await db.creditAccount.findUniqueOrThrow({ where: { user_id: user.id } }), adoptionAccount);
  equal(await db.imageStudioTask.count(), adoptionTasks); equal(await db.creditLedger.count(), adoptionLedger);
  equal(await db.platformSetting.count({ where: { key: { startsWith: 'studio_', contains: '_batch_v1:' } } }), adoptionParents);
  equal(await createStudioBatch(user.id, { ...legacyBatchBody, batchQuoteId: legacyBatchQuote.batchQuoteId,
    imageChannel: legacyBatchQuote.imageChannel, pricingRevision: 'deliberately-stale-existing-parent' }), legacyParentId);
  equal((await db.platformSetting.findUniqueOrThrow({ where: { key: legacyParentKey } })).value_json, legacyParent.value_json);
  equal(await db.creditAccount.findUniqueOrThrow({ where: { user_id: user.id } }), adoptionAccount);
  equal(await db.imageStudioTask.count(), adoptionTasks); equal(await db.creditLedger.count(), adoptionLedger);
  group('G11', 'Single-image quote acceptance retains the same fresh-pricing presence gate and exact authorization.');
  const quoted = await prepareImageBillingQuote(user.id, imageBody);
  equal(quoted.unitCredits, 0.2); equal(quoted.pricingRevision, snapshot.revision); ok(quoted.billingQuoteId);
  equal(quoted.estimatedCredits, 0.6);
  ok(quoted.imageChannel); equal(quoted.imageChannel?.channelId, 'original');
  const quoteKey = imageQuoteKey(user.id, quoted.billingQuoteId!);
  const storedQuote = await db.platformSetting.findUniqueOrThrow({ where: { key: quoteKey } });
  const beforeAcceptance = await db.creditAccount.findUniqueOrThrow({ where: { user_id: user.id } });
  const beforeTasks = await db.imageStudioTask.count({ where: { owner_id: user.id } });
  await assert.rejects(() => submitStudioBatch(user.id, { ...imageBody, prompt: 'different unquoted input',
    billingQuoteId: quoted.billingQuoteId, pricingRevision: quoted.pricingRevision,
    imageChannel: quoted.imageChannel, maxEstimatedCost: quoted.estimatedCredits }), { status: 409,
    message: '图片规格或报价已更新、过期或被使用，请重新获取实际尺寸与报价；尚未生成' });
  active.assertions++;
  await assert.rejects(() => submitStudioBatch(user.id, { ...imageBody, billingQuoteId: quoted.billingQuoteId,
    imageChannel: quoted.imageChannel, maxEstimatedCost: quoted.estimatedCredits }), PricingChargeError);
  active.assertions++;
  equal((await db.platformSetting.findUniqueOrThrow({ where: { key: quoteKey } })).value_json, storedQuote.value_json);
  equal(await db.imageStudioTask.count({ where: { owner_id: user.id } }), beforeTasks);
  equal(await db.creditAccount.findUniqueOrThrow({ where: { user_id: user.id } }), beforeAcceptance);
  const accepted = await submitStudioBatch(user.id, { ...imageBody, billingQuoteId: quoted.billingQuoteId, pricingRevision: quoted.pricingRevision, imageChannel: quoted.imageChannel, maxEstimatedCost: quoted.estimatedCredits });
  equal(await db.platformSetting.count({ where: { key: quoteKey } }), 0);
  const acceptedImages = await db.imageStudioTask.findMany({ where: { batch_id: accepted, owner_id: user.id } });
  equal(acceptedImages.length, 3); equal(precision.sumCredits(acceptedImages.map(task => task.unit_credits)), 0.6);
  const acceptedImage = await db.imageStudioTask.findFirstOrThrow({ where: { batch_id: accepted, owner_id: user.id } });
  equal(acceptedImage.status, 'rate_queued'); equal(acceptedImage.unit_credits, 0.2);
  equal(parseImageBillingContract(acceptedImage.billing_contract_json)?.pricing?.revision, snapshot.revision);
  equal(parseImageBillingContract(acceptedImage.billing_contract_json)?.specification,
    parseImageBillingContract(JSON.stringify(JSON.parse(storedQuote.value_json).contract))?.specification);
  equal(await submitStudioBatch(user.id, { ...imageBody, billingQuoteId: quoted.billingQuoteId,
    pricingRevision: quoted.pricingRevision, imageChannel: quoted.imageChannel, maxEstimatedCost: quoted.estimatedCredits }), accepted);
  equal(await db.imageStudioTask.count({ where: { batch_id: accepted, owner_id: user.id } }), 3);
  await rejects(() => db.$transaction(tx => createSynchronousImageAdmission(tx, { ownerId: user.id,
    requestId: imageBody.requestId, fingerprint: 'fixture-reverse-original', count: 1, model: imageBody.model, scope: 'fixture-scope' })));
  const originalSyncId = randomUUID();
  await db.$transaction(tx => createSynchronousImageAdmission(tx, { ownerId: user.id, requestId: originalSyncId,
    fingerprint: 'fixture-original', count: 1, model: imageBody.model, scope: 'fixture-scope' }));
  const originalTaskCount = await db.imageStudioTask.count({ where: { owner_id: user.id } });
  await rejects(() => prepareImageBillingQuote(user.id, { ...imageBody, requestId: originalSyncId }));
  equal(await db.imageStudioTask.count({ where: { owner_id: user.id } }), originalTaskCount);
  await db.platformSetting.delete({ where: { key: `image_sync_request_v1:${user.id}:${originalSyncId}` } });
  const canvas = await getCanvasImageQuote(user as never, { kind: 'image', project_id: project.id, model: 'gpt-image-2', count: 3, quality: 'auto', resolution: '1K', ratio: '1:1' });
  equal(canvas.estimatedCredits, 0.6); equal(canvas.pricingRevision, snapshot.revision); equal(canvas.pricingQuoteRequired, true);
  const candidateEvidence = await runPricingImageCandidateContractFixture(db, user as never, project.id, pricingTransactionQueries);
  active.assertions += candidateEvidence.assertions;
  active.evidence.push('R04: selected-model strict quote, typed identity-scoped candidate failures, default routes, null/free separation, real database/runtime failures, snapshot isolation and exact fixture restoration.');
  active.evidence.push('R05: three concurrent complete canvas quotes and three concurrent channel menus use one real transaction per projection; selected price/revision, unavailable null amounts and private snapshots remain intact.');

  group('G17', 'Actual persistent batch acceptance freezes per-child contracts; late dispatch after policy mutation uses the original unit fee.');
  await renewBatchReadiness();
  const batchBody = { ...imageBody, count: 1, requestId: randomUUID(), sources: [{ name: 'one' }, { name: 'two' }], budget: 0.4 };
  const batchQuote = await quoteStudioBatch(user.id, batchBody); ok(batchQuote.batchQuoteId); equal(batchQuote.estimatedCredits, 0.4);
  const batchChannel = batchQuote.imageChannel; assert.ok(batchChannel); active.assertions++;
  const batchQuoteKey = `image_batch_billing_quote_v1:${user.id}:${batchQuote.batchQuoteId}`;
  const batchQuoteRow = await db.platformSetting.findUniqueOrThrow({ where: { key: batchQuoteKey } });
  const storedBatchQuote = JSON.parse(batchQuoteRow.value_json) as Record<string, unknown>;
  equal(storedBatchQuote.fingerprintVersion, 3);
  equal(storedBatchQuote.fingerprint, batchQuoteFingerprint(batchBody, batchChannel));
  equal(batchQuoteFingerprint({ ...batchBody, imageChannel: batchChannel }, batchChannel), storedBatchQuote.fingerprint);
  equal(batchQuoteFingerprint({ ...batchBody, channelId: 'original', imageChannel: batchChannel }, batchChannel), storedBatchQuote.fingerprint);
  ok(batchQuoteFingerprint({ ...batchBody, sources: [...batchBody.sources].reverse() }, batchChannel) !== storedBatchQuote.fingerprint);
  const batchSubmission = { ...batchBody, batchQuoteId: batchQuote.batchQuoteId,
    pricingRevision: batchQuote.pricingRevision, imageChannel: batchChannel };
  const batchTasksBefore = await db.imageStudioTask.count();
  const batchAccountBefore = await db.creditAccount.findUniqueOrThrow({ where: { user_id: user.id } });
  for (const changed of [{ prompt: 'changed parent prompt' }, { sources: [...batchBody.sources].reverse() },
    { budget: 0.3 }, { pricingRevision: undefined }, { pricingRevision: 'unquoted-revision' },
    { imageChannel: { ...batchChannel, configRevision: randomUUID() } }]) {
    await assert.rejects(() => createStudioBatch(user.id, { ...batchSubmission, ...changed }), { status: 409 }); active.assertions++;
    equal((await db.platformSetting.findUniqueOrThrow({ where: { key: batchQuoteKey } })).value_json, batchQuoteRow.value_json);
  }
  try {
    await db.platformSetting.update({ where: { id: batchQuoteRow.id }, data: {
      value_json: JSON.stringify({ ...storedBatchQuote, fingerprintVersion: 99 }) } });
    await assert.rejects(() => createStudioBatch(user.id, batchSubmission), { status: 409 }); active.assertions++;
    const legacyQuote: Record<string, unknown> = { ...storedBatchQuote,
      fingerprint: batchQuoteFingerprint({ ...batchBody, channelId: 'original' }, batchChannel, 1) };
    delete legacyQuote.fingerprintVersion;
    await db.platformSetting.update({ where: { id: batchQuoteRow.id }, data: { value_json: JSON.stringify(legacyQuote) } });
    const rollback = new Error('rollback isolated legacy quote consumption');
    await assert.rejects(() => db.$transaction(async tx => {
      const consumed = await consumeBatchQuote(tx, user.id, batchSubmission);
      equal(consumed.total, 0.4); equal(consumed.contracts.map(contract => contract.authorizedCredits), [0.2, 0.2]);
      throw rollback;
    }), error => error === rollback); active.assertions++;
    equal((await db.platformSetting.findUniqueOrThrow({ where: { key: batchQuoteKey } })).value_json, JSON.stringify(legacyQuote));
  } finally {
    await db.platformSetting.update({ where: { id: batchQuoteRow.id }, data: { value_json: batchQuoteRow.value_json } });
  }
  equal(await db.imageStudioTask.count(), batchTasksBefore);
  equal(await db.creditAccount.findUniqueOrThrow({ where: { user_id: user.id } }), batchAccountBefore);
  const continuationParent: Parameters<typeof continuationInput>[0] = { version: 2, pricing: true,
    id: 'f'.repeat(64), ownerId: user.id, requestId: batchBody.requestId, fingerprint: 'fixture-parent',
    moduleId, moduleName: 'Isolated pricing module', state: 'needs-confirmation', note: '', createdAt: now,
    total: 4, budget: 0.6, committedCredits: 0.2, unitCredits: 0.2, prepared: 1,
    input: { ...imageBody, count: 1, requestId: batchBody.requestId, imageChannel: batchChannel }, items: [
      { ordinal: 1, sourceName: 'accepted', taskId: 'rate-original-accepted', attempt: 0, prepared: true, cancelled: false },
      { ordinal: 2, sourceName: 'one', taskId: null, attempt: 0, prepared: false, cancelled: false },
      { ordinal: 3, sourceName: 'two', taskId: null, attempt: 0, prepared: false, cancelled: false },
      { ordinal: 4, sourceName: 'cancelled', taskId: null, attempt: 0, prepared: false, cancelled: true },
    ] };
  const originalParent = JSON.stringify(continuationParent);
  const continuation = continuationInput(continuationParent, { batchQuoteId: batchQuote.batchQuoteId,
    pricingRevision: batchQuote.pricingRevision, imageChannel: batchChannel, budget: 0.6 });
  equal(continuation.pricingRevision, batchQuote.pricingRevision); equal(continuation.requestId, batchBody.requestId);
  equal(continuation.sources, batchBody.sources); equal(continuation.budget, 0.6);
  equal(continuationInput(continuationParent, { pricingRevision: 'stale-client-revision' }).pricingRevision, 'stale-client-revision');
  equal(continuationInput(continuationParent, {}).pricingRevision, undefined);
  equal(JSON.stringify(continuationParent), originalParent);
  active.evidence.push('R07: server v3 parent quote accepts returned snapshots independent of field insertion order; changed inputs/budget/revision/channel and unknown formats refuse without consuming the quote or reserving credits. Versionless legacy receipts retain their exact original fingerprint rule.');
  active.evidence.push('R07: the actual continuation input helper preserves only pending sources, original request identity and the explicit client pricing revision, never fills a missing/stale revision or mutates the accepted parent.');
  const batchId = await createStudioBatch(user.id, { ...batchBody, batchQuoteId: batchQuote.batchQuoteId, pricingRevision: batchQuote.pricingRevision, imageChannel: batchQuote.imageChannel });
  const acceptedRevision = snapshot.revision;
  const acceptedParentKey = `studio_pricing_batch_v1:${user.id}:${batchId}`;
  const acceptedParent = await db.platformSetting.findUniqueOrThrow({ where: { key: acceptedParentKey } });
  equal(JSON.parse(acceptedParent.value_json).billingContracts.map((contract: { pricing?: { revision: string } }) => contract.pricing?.revision), [acceptedRevision, acceptedRevision]);
  const staleBatchBody = { ...batchBody, requestId: randomUUID() };
  const staleBatchQuote = await quoteStudioBatch(user.id, staleBatchBody);
  const staleBatchKey = `image_batch_billing_quote_v1:${user.id}:${staleBatchQuote.batchQuoteId}`;
  const staleBatchRow = await db.platformSetting.findUniqueOrThrow({ where: { key: staleBatchKey } });
  snapshot = await save(snapshot, { kind: 'save', changes: { rows: [{ id: imageRow.id, mode: 'custom', customPointsPerCny: '2' }] } });
  ok(snapshot.revision !== acceptedRevision);
  await renewBatchReadiness();
  const staleAccount = await db.creditAccount.findUniqueOrThrow({ where: { user_id: user.id } });
  const staleTasks = await db.imageStudioTask.count(), staleLedger = await db.creditLedger.count();
  await assert.rejects(() => createStudioBatch(user.id, { ...staleBatchBody, batchQuoteId: staleBatchQuote.batchQuoteId,
    pricingRevision: staleBatchQuote.pricingRevision, imageChannel: staleBatchQuote.imageChannel }), { status: 409 }); active.assertions++;
  equal((await db.platformSetting.findUniqueOrThrow({ where: { key: staleBatchKey } })).value_json, staleBatchRow.value_json);
  equal(await createStudioBatch(user.id, { ...batchBody, batchQuoteId: batchQuote.batchQuoteId,
    pricingRevision: batchQuote.pricingRevision, imageChannel: batchQuote.imageChannel }), batchId);
  equal((await db.platformSetting.findUniqueOrThrow({ where: { key: acceptedParentKey } })).value_json, acceptedParent.value_json);
  equal(await db.creditAccount.findUniqueOrThrow({ where: { user_id: user.id } }), staleAccount);
  equal(await db.imageStudioTask.count(), staleTasks); equal(await db.creditLedger.count(), staleLedger);
  active.evidence.push('R08: real legacy and RATE quotes accept unchanged; real admin adoption invalidates unconsumed legacy quotes, and revision changes invalidate unconsumed RATE quotes inside new-parent acceptance. Rejections preserve quotes/accounts/tasks/ledger. Existing request IDs return unchanged parents before fresh checks; late children keep the original RATE charge.');
  await dispatchStudioBatches(); await dispatchStudioBatches();
  const lateChildren = await db.imageStudioTask.findMany({ where: { owner_id: user.id, batch_id: batchId }, orderBy: { ordinal: 'asc' } });
  equal(lateChildren.length, 2); equal(lateChildren.map(item => item.unit_credits), [0.2, 0.2]);
  equal(lateChildren.map(item => parseImageBillingContract(item.billing_contract_json)?.pricing?.revision), [acceptedRevision, acceptedRevision]);
  equal(lateChildren.map(item => item.status), ['rate_queued', 'rate_queued']);
  equal(precision.sumCredits(lateChildren.map(item => item.unit_credits)), 0.4);
  equal(parseImageBillingContract(acceptedImage.billing_contract_json)?.pricing?.revision, acceptedRevision);

  group('G07', 'Two real SQLite admin saves race from the same revision; only one immutable policy revision commits.');
  const second = await db.user.create({ data: { name: 'Second fixture admin', username: randomUUID(), email: `${randomUUID()}@fixture.invalid`, password_hash: 'fixture-not-a-login', role: 'admin' } });
  const secondActor: PricingAdminActor = { id: second.id, displayName: second.name, avatarUrl: second.avatar_url };
  const beforeCount = await db.platformSetting.count({ where: { key: { startsWith: PRICING_REVISION_PREFIX } } });
  const changeInput = { expectedRevision: snapshot.revision, catalogFingerprint: snapshot.catalogFingerprint,
    action: { kind: 'save' as const, changes: { rows: [], standards: { site_base_cny: '1.2' } } } };
  const previewA = await previewAdminPricing(actor, changeInput), previewB = await previewAdminPricing(secondActor, changeInput);
  const results = await Promise.allSettled([saveAdminPricing(actor, { ...changeInput, operationId: randomUUID(), previewToken: previewA.previewToken }),
    saveAdminPricing(secondActor, { ...changeInput, operationId: randomUUID(), previewToken: previewB.previewToken })]);
  equal(results.filter(result => result.status === 'fulfilled' && result.value.state === 'succeeded').length, 1);
  equal(await db.platformSetting.count({ where: { key: { startsWith: PRICING_REVISION_PREFIX } } }), beforeCount + 1);

  group('G13', 'The actual browser-safe canvas request builder carries the reviewed pricing revision and maximum without generating anything.');
  const canvasSource = fs.readFileSync(path.join(candidateRoot, 'public/tools/ultimate-canvas/generation-node-workflow.js'), 'utf8');
  const sandbox: { module: { exports: Record<string, (...args: never[]) => unknown> }; exports: object } = { module: { exports: {} }, exports: {} };
  vm.runInNewContext(canvasSource, sandbox, { timeout: 1000 });
  const request = (sandbox.module.exports.videoRequest as (input: object) => { payload: Record<string, unknown> })({ nodeId: 'fixture-node', requestId: 'fixture-original',
    settings: { model: 'doubao-seedance-2-5-260628', ratio: '16:9', duration: 5, resolution: '480p', pricingRevision: 'fixture-revision', maxEstimatedCost: 0.5 } });
  equal(request.payload.pricing_revision, 'fixture-revision'); equal(request.payload.max_estimated_cost, 0.5);
  equal(request.payload.idempotency_key, 'fixture-node:fixture-original');
  const { newerRelease, parseReleaseVersion } = fixtureRequire('@/lib/release') as typeof import('@/lib/release');
  equal(newerRelease('0.96.0', '0.95.4'), true);
  equal(newerRelease('0.96.0+other-build', '0.96.0'), false);
  equal(newerRelease('0.96.0+points-pricing-guard.1', '0.96.0'), false);
  equal(newerRelease('0.96.0', '0.96.0+points-pricing-guard.1'), false);
  equal(newerRelease('0.96.0', '0.96.0-rc.1'), true);
  equal(newerRelease('0.96.0', '000.096.000'), false);
  equal(newerRelease('unknown', '0.95.4'), false);
  equal(parseReleaseVersion('0.96.0-01'), null);
  process.chdir(candidateRoot); await db.$disconnect();
  console.log(JSON.stringify({ schema: 'pricing-core-contract.v1', completed: true, synthetic: true,
    checks: Array.from(checks.values()), forbiddenCalls: 0, productionWrites: 0, paidRequests: 0, browserRuns: 0 }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
