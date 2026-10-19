import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import type { RequestStore } from 'next/dist/client/components/request-async-storage.external';
import type { FrozenPricingCharge } from '../src/lib/pricing/frozen-charge';
import { traceFixture } from './image-trace-engineering-fixture';

async function main() {
  assert.equal(Reflect.get(globalThis, Symbol.for('image-engineering-package-view')), undefined,
    'Guard admission must run against the actual package, without an ordinary test view');
  const checks = ['actual_guard_package_rejects_new_queue_admission', 'guard_requires_env_and_shared_drain_and_only_recovers_accepted_without_global_billing'];
  const fixture = await traceFixture({ file: 'scripts/image-guard-admission-engineering.ts',
    schema: 'image-guard-admission-engineering.v1', marker: 'Image guard admission engineering receipt: ', checks,
    sources: ['scripts/image-trace-engineering-fixture.ts', 'scripts/process-image-studio.ts', 'src/lib/image-studio/queue-capacity.ts', 'src/lib/image-studio/worker-mode.ts', 'src/lib/pricing/build-mode.ts',
      'src/lib/pricing/admin-api.ts', 'src/lib/pricing/admin-contract.ts', 'src/lib/pricing/policy.ts', 'src/lib/pricing/catalog.ts',
      'src/lib/pricing/runtime.ts', 'src/lib/pricing/isolation.ts', 'src/lib/pricing/frozen-charge.ts', 'src/lib/pricing/math.ts', 'src/lib/pricing/resolve.ts',
      'src/lib/auth/api-helpers.ts', 'src/lib/auth/session.ts', 'src/lib/auth/session-account-binding.ts', 'src/lib/auth/password.ts',
      'src/lib/image-studio/billing-contract.ts', 'src/lib/image-studio/billing-quote.ts', 'src/lib/image-studio/pricing-state.ts',
      'src/lib/credits/precision.ts', 'src/lib/costs/currency.ts'] });
  // traceFixture has established the isolated DB and the actual global ALS.
  // Import Next/auth only afterwards: there is no VM, fabricated session, or
  // ordinary-package preload on this actual guard path.
  process.env.SESSION_SECRET = 'trace03-guard-isolated-session-not-a-production-secret';
  const next = await import('next/server');
  const { requestAsyncStorage } = await import('next/dist/client/components/request-async-storage.external');
  const { HeadersAdapter } = await import('next/dist/server/web/spec-extension/adapters/headers');
  const { RequestCookiesAdapter } = await import('next/dist/server/web/spec-extension/adapters/request-cookies');
  const { RequestCookies, ResponseCookies } = await import('next/dist/server/web/spec-extension/cookies');
  const { DraftModeProvider } = await import('next/dist/server/async-storage/draft-mode-provider');
  function inRequest<T>(request: NextRequest, action: () => T): T {
    const headers = HeadersAdapter.seal(new Headers(Object.fromEntries(request.headers.entries())));
    const cookies = RequestCookiesAdapter.seal(new RequestCookies(new Headers(Object.fromEntries(request.headers.entries()))));
    const mutableCookies = new ResponseCookies(new Headers());
    const store: RequestStore = { headers, cookies, mutableCookies,
      draftMode: new DraftModeProvider(undefined, request, cookies, mutableCookies),
      reactLoadableManifest: {}, assetPrefix: '' };
    return requestAsyncStorage.run(store, action);
  }
  const actualVersion = JSON.parse(readFileSync(path.join(fixture.root, 'package.json'), 'utf8')).version;
  assert.match(actualVersion, /\+trace03-guard\.\d+$/);
  const { PRICING_ADMIN_WRITES_ENABLED } = await import('../src/lib/pricing/build-mode');
  assert.equal(PRICING_ADMIN_WRITES_ENABLED, false, 'The TRACE guard must retain the RATE read-only build mode');
  const queue = await import('../src/lib/image-studio/queue-capacity');
  assert.equal(queue.imageStudioAcceptedOnlyMode(), true);
  await assert.rejects(fixture.db.$transaction(tx => queue.reserveImageStudioQueueCapacity(tx, 'synthetic-owner', 1)), queue.QueueMaintenanceError);
  assert.equal(await fixture.db.imageStudioTask.count(), 0); assert.equal(await fixture.db.creditLedger.count(), 0);
  const { createSession, SESSION_COOKIE } = await import('../src/lib/auth/session');
  const { pricingAdminRoute } = await import('../src/lib/pricing/admin-api');
  const { getAdminPricingSnapshot, getAdminPricingOperation } = await import('../src/lib/pricing/policy');
  const { PRICING_POLICY_KEY, PRICING_OPERATION_PREFIX, PRICING_REVISION_PREFIX, PRICING_UNCONFIGURED_REVISION } = await import('../src/lib/pricing/admin-contract');
  const { getPricingCatalog } = await import('../src/lib/pricing/catalog');
  const admin = await fixture.db.user.create({ data: { id: 'guard-admin-' + randomUUID(), name: 'Synthetic guard admin',
    username: randomUUID(), email: randomUUID() + '@fixture.invalid', password_hash: 'isolated-not-a-login',
    role: 'admin', account_type: 'internal', status: 'active' } });
  const actor = { id: admin.id, displayName: admin.name || admin.username, avatarUrl: admin.avatar_url };
  const savedRevision = randomUUID(), savedAt = new Date().toISOString();
  // These are pre-existing synthetic records in the fresh test DB, not saves
  // through the guarded mutation route or modifications to any real prices.
  const policy = { schemaVersion: 1, revision: savedRevision,
    standards: { site_base_cny: '2', supplier_cost_cny: null }, rules: [], updatedAt: savedAt, updatedBy: actor };
  const savedPolicy = JSON.stringify(policy);
  await fixture.db.platformSetting.create({ data: { key: PRICING_POLICY_KEY, value_json: savedPolicy, updated_by: admin.id } });
  await assert.rejects(() => getAdminPricingSnapshot(actor), { status: 503, code: 'pricing_policy_invalid' },
    'An orphan policy pointer is invalid even in the compatible guard');
  const catalog = await getPricingCatalog(fixture.db);
  const revisionKey = PRICING_REVISION_PREFIX + savedRevision;
  const savedRevisionRecord = JSON.stringify({ schemaVersion: 1, policy,
    history: { revisionId: savedRevision, previousRevision: PRICING_UNCONFIGURED_REVISION, createdAt: savedAt,
      actor, action: 'save', changes: [], standardsBefore: { site_base_cny: null, supplier_cost_cny: null },
      standardsAfter: policy.standards }, rows: catalog.rows, bindings: catalog.bindings });
  await fixture.db.platformSetting.create({ data: { key: revisionKey, value_json: savedRevisionRecord, updated_by: admin.id } });
  const savedSnapshot = await getAdminPricingSnapshot(actor);
  assert.equal(savedSnapshot.revision, savedRevision);
  const operationId = randomUUID();
  const savedOperation = { operationId, state: 'succeeded', inputFingerprint: 'd'.repeat(64), revision: savedRevision,
    affectedRuleIds: [], error: null, snapshot: savedSnapshot };
  const operationKey = PRICING_OPERATION_PREFIX + admin.id + ':' + operationId;
  const savedReceipt = JSON.stringify({ schemaVersion: 1, actorId: admin.id, requestFingerprint: 'e'.repeat(64), result: savedOperation });
  await fixture.db.platformSetting.create({ data: { key: operationKey, value_json: savedReceipt, updated_by: admin.id } });
  const token = await createSession(admin.id);
  function adminRequest(method = 'GET', authenticated = true) {
    return new next.NextRequest('https://guard-fixture.invalid/api/admin/pricing', { method,
      headers: { host: 'guard-fixture.invalid', origin: 'https://guard-fixture.invalid',
        'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-app-session-user': admin.id,
        ...(authenticated ? { cookie: SESSION_COOKIE + '=' + token } : {}) },
      ...(method === 'PATCH' ? { body: JSON.stringify({ operationId: randomUUID() }) } : {}) });
  }
  const beforeAdminReads = await fixture.db.platformSetting.findMany({ orderBy: { key: 'asc' } });
  let mutations = 0, reads = 0;
  const mutation = adminRequest('PATCH');
  const refused = await inRequest(mutation, () => pricingAdminRoute(mutation, true, async () => { mutations++; return { unexpectedMutation: true }; }));
  assert.equal(refused.status, 503); assert.equal((await refused.json()).code, 'pricing_admin_read_only'); assert.equal(mutations, 0);
  const unauthenticated = adminRequest('GET', false);
  const noSession = await inRequest(unauthenticated, () => pricingAdminRoute(unauthenticated, false, async () => { reads++; return {}; }));
  assert.equal(noSession.status, 401); assert.equal(reads, 0);
  const snapshotRequest = adminRequest();
  const readable = await inRequest(snapshotRequest, () => pricingAdminRoute(snapshotRequest, false, async sessionActor => {
    reads++; assert.deepEqual(sessionActor, actor); return getAdminPricingSnapshot(sessionActor);
  }));
  assert.equal(readable.status, 200);
  const snapshotView = await readable.json();
  assert.deepEqual(snapshotView.actor, actor); assert.equal(snapshotView.revision, savedRevision);
  assert.deepEqual(snapshotView.standards, { site_base_cny: '2', supplier_cost_cny: null });
  const operationRequest = adminRequest();
  const operation = await inRequest(operationRequest, () => pricingAdminRoute(operationRequest, false, async sessionActor => {
    reads++; assert.deepEqual(sessionActor, actor); return getAdminPricingOperation(sessionActor, operationId);
  }));
  assert.equal(operation.status, 200); assert.deepEqual(await operation.json(), savedOperation); assert.equal(reads, 2);
  assert.deepEqual(await fixture.db.platformSetting.findMany({ orderBy: { key: 'asc' } }), beforeAdminReads);
  assert.equal((await fixture.db.platformSetting.findUniqueOrThrow({ where: { key: PRICING_POLICY_KEY } })).value_json, savedPolicy);
  assert.equal((await fixture.db.platformSetting.findUniqueOrThrow({ where: { key: revisionKey } })).value_json, savedRevisionRecord);
  assert.equal((await fixture.db.platformSetting.findUniqueOrThrow({ where: { key: operationKey } })).value_json, savedReceipt);
  assert.equal(await fixture.db.imageStudioTask.count(), 0); assert.equal(await fixture.db.creditLedger.count(), 0);
  fixture.check(checks[0]);
  const modes = await import('../src/lib/image-studio/worker-mode');
  const billingModes = [
    { acceptedOnly: false, initialHold: false, expected: true },
    { acceptedOnly: false, initialHold: true, expected: false },
    { acceptedOnly: true, initialHold: false, expected: false },
    { acceptedOnly: true, initialHold: true, expected: false },
  ].map(input => {
    const enabled = modes.studioWorkerBillingEnabled(input);
    assert.equal(enabled, input.expected, 'Guard and initial hold must never start global billing work');
    return { ...input, enabled };
  });
  assert.throws(() => modes.assertStudioWorkerMode({ version: actualVersion, acceptedOnlyEnv: '0', draining: true }));
  assert.throws(() => modes.assertStudioWorkerMode({ version: actualVersion, acceptedOnlyEnv: '1', draining: false }));
  const mode = modes.assertStudioWorkerMode({ version: actualVersion, acceptedOnlyEnv: '1', draining: true });
  const calls: string[] = [];
  await modes.runStudioWorkerCycle({ ...mode, draining: () => true, stopping: () => false,
    recover: async options => { assert.equal(options.acceptedOnly, true); calls.push('recover-accepted'); },
    dispatchBatches: async () => { calls.push('new-batch'); }, dispatchToolflows: async () => { calls.push('new-toolflow'); },
    processQueued: async () => { calls.push('new-queue'); } });
  assert.deepEqual(calls, ['recover-accepted']);
  // Exercise real private-contract readers against a persisted accepted fixture
  // task. This is reader compatibility, not an admission or settlement test;
  // the full pricing G01-G24 gate owns those financial checks.
  const pricingRuntime = await import('../src/lib/pricing/runtime');
  const { fixedImageBillingContract, withPricingImageContract } = await import('../src/lib/image-studio/billing-quote');
  const { parseImageBillingContract, billedImageContractCredits, imageBillingView } = await import('../src/lib/image-studio/billing-contract');
  const { publicPricingTaskState, isPricingImageTask } = await import('../src/lib/image-studio/pricing-state');
  const { parseFrozenPricingCharge } = await import('../src/lib/pricing/frozen-charge');
  const charge: FrozenPricingCharge = { schema: 'pricing-charge-v1', revision: 'synthetic-accepted-prior-revision',
    ruleId: 'synthetic-accepted-rule', identity: { kind: 'image', channelId: 'shared', modelId: 'gpt-image-2',
      billingMode: 'fixed', unit: 'image', specifications: {} }, binding: { configRevision: 'synthetic-prior-config',
      billingPrincipalId: 'synthetic-principal', credentialVersion: 'synthetic-credential-version', configFingerprint: 'synthetic-fingerprint' },
    basisKind: 'site_base_cny', mode: 'custom', baseCny: '0.15', pointsPerCny: '1', exchangeRate: null,
    legacyUnitCredits: null, legacyRounding: null, quantity: '1', issuedAt: savedAt, rounding: 'half_up_tenth' };
  const contract = withPricingImageContract(fixedImageBillingContract({ scope: 'a'.repeat(64), model: 'gpt-image-2',
    credits: 0.2, specification: 'b'.repeat(64) }), charge, 0.2);
  const accepted = await fixture.db.imageStudioTask.create({ data: { id: 'rate-' + randomUUID(), batch_id: randomUUID(),
    owner_id: admin.id, ordinal: 1, fingerprint: 'c'.repeat(64), prompt: 'Synthetic accepted guard reader', context: '',
    revision: 0, model: 'gpt-image-2', quality: 'auto', aspect_ratio: '1:1', output_size: '1024x1024', reference_ids: '[]',
    unit_credits: 0.2, status: 'rate_queued', billing_mode: 'fixed', billing_scope: contract.scope,
    billing_status: 'rate_awaiting_response', billing_contract_json: JSON.stringify(contract),
    snapshot_json: JSON.stringify({ version: 1, billingContract: contract, unitCredits: 0.2 }) } });
  const settingsBeforeReaders = await fixture.db.platformSetting.findMany({ orderBy: { key: 'asc' } });
  const acceptedRead = await fixture.db.imageStudioTask.findUniqueOrThrow({ where: { id: accepted.id } });
  const parsedContract = parseImageBillingContract(acceptedRead.billing_contract_json);
  assert.ok(parsedContract); assert.deepEqual(parsedContract, contract);
  assert.deepEqual(parseFrozenPricingCharge(parsedContract.pricing), charge);
  assert.equal(billedImageContractCredits(parsedContract, 0), 0.2);
  assert.equal(isPricingImageTask(acceptedRead), true); assert.equal(publicPricingTaskState(acceptedRead.status), 'queued');
  const billing = imageBillingView(acceptedRead, admin.id, false);
  assert.ok(billing); assert.equal(billing.mode, 'fixed'); assert.equal(billing.creditPrecision, 0.1);
  // The fixture has no root-installed immutable pricing barrier. The actual
  // runtime must continue to deny readiness; never seed a fake READY receipt.
  const consumerState = await pricingRuntime.pricingImageConsumerState(fixture.db);
  assert.equal(consumerState.ready, false);
  await assert.rejects(pricingRuntime.assertPricingImageConsumerReady(fixture.db));
  assert.equal(await fixture.db.platformSetting.count({ where: { key: pricingRuntime.PRICING_IMAGE_CAPABILITY_KEY } }), 0);
  assert.deepEqual(await fixture.db.platformSetting.findMany({ orderBy: { key: 'asc' } }), settingsBeforeReaders);
  assert.deepEqual(await fixture.db.imageStudioTask.findUniqueOrThrow({ where: { id: accepted.id } }), accepted);
  assert.equal(await fixture.db.creditLedger.count(), 0);
  fixture.check(checks[1]);
  await fixture.finish({ actualGuardVersion: actualVersion, packageView: 'actual-guard-without-preload', billingModes,
    adminRoute: { realSession: true, nextRequestStore: true, mutationStatus: refused.status, mutationActions: mutations,
      readActions: reads, incompleteRevisionRejected: true, savedPolicyRevisionAndReceiptUnchanged: true },
    pricingReaders: { persistedAcceptedContract: true, frozenCredits: 0.2, runtimeReady: consumerState.ready,
      fabricatedReadiness: false, acceptedTaskUnchanged: true, completeFinancialCoverage: 'existing-pricing-G01-G24' } });
}
main().catch(error => { console.error(error); process.exit(1); });
