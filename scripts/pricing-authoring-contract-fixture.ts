import { setFixtureDatabase } from './fixtures/database-client';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { PricingAdminAction, PricingAdminPreviewInput, PricingAdminSaveInput } from '@/lib/pricing/admin-contract';
import type { PricingEvidence } from '@/lib/pricing/pricing-authoring-contract';
import type { VideoPricingContext } from '@/lib/pricing/video-context';
import type { FrozenPricingCharge } from '@/lib/pricing/frozen-charge';

export async function runPricingAuthoringContractFixture(): Promise<{
  fixture: 'pricing-authoring-contract'; completed: true; assertions: number; evidence: string[];
}> {
  const supplied = process.env.PRICING_AUTHORING_FIXTURE_DB;
  assert.ok(supplied && path.isAbsolute(supplied) && !/[?#\0]/.test(supplied), 'Explicit authoring SQLite file required');
  assert.equal(process.env.NODE_ENV, 'test', 'Lead must supply an isolated test process');
  const initialCwd = process.cwd();
  const root = fs.realpathSync(initialCwd);
  const fixtureRoot = fs.realpathSync(path.join(root, '.role-tests'));
  const filename = fs.realpathSync(supplied);
  assert.equal(fixtureRoot, path.join(root, '.role-tests'), 'The fixture directory cannot redirect outside the candidate');
  assert.ok(filename.startsWith(`${fixtureRoot}${path.sep}`), 'Only candidate .role-tests databases are allowed');
  const stat = fs.lstatSync(supplied);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'No database symlinks or hard links');
  assert.equal(Reflect.get(globalThis, 'prisma'), undefined, 'Run this fixture in a fresh process, not a cached application context');
  const previousEnvironment = Object.fromEntries(['DATABASE_URL', 'SESSION_SECRET', 'SEEDANCE_API_KEY', 'SEEDANCE_BASE_URL']
    .map(key => [key, process.env[key]]));
  const previousPragmas = Reflect.get(globalThis, 'prismaSqlitePragmasStarted');
  const db = new PrismaClient({ datasources: { db: { url: `file:${filename}` } } });
  process.env.DATABASE_URL = `file:${filename}`;
  process.env.SESSION_SECRET = 'authoring-fixture-only-not-a-production-secret';
  process.env.SEEDANCE_API_KEY = 'authoring-fixture-not-a-provider-key';
  process.env.SEEDANCE_BASE_URL = 'https://fixture.invalid/seedance';
  setFixtureDatabase(db);
  let assertions = 0;
  const evidence: string[] = [];
  const equal = (actual: unknown, expected: unknown, message?: string) => { assert.deepEqual(actual, expected, message); assertions++; };
  const ok = (value: unknown, message?: string) => { assert.ok(value, message); assertions++; };
  const throws = (run: () => unknown) => { assert.throws(run); assertions++; };
  const rejects = async (run: () => Promise<unknown>, predicate: (error: unknown) => boolean = () => true) => {
    await assert.rejects(run, predicate); assertions++;
  };
  const rollback = new Error('pricing-authoring-contract-deliberate-rollback');
  let completed = false;
  try {
    const { prisma } = await import('@/lib/prisma');
    equal(Reflect.get(globalThis, Symbol.for('video-api.database-client.v1')).raw, db, 'No implementation helper may resolve a production/default database');
    const attached = await prisma.$queryRawUnsafe<Array<{ name: string; file: string }>>('PRAGMA database_list');
    equal(fs.realpathSync(attached.find(row => row.name === 'main')!.file), filename, 'Business queries must use the supplied isolated file');
    const { getAdminPricingSnapshot, previewAdminPricing, saveAdminPricing, getAdminPricingOperation,
      getAdminPricingHistory } = await import('@/lib/pricing/policy');
    const { PRICING_POLICY_KEY, PRICING_REVISION_PREFIX } = await import('@/lib/pricing/admin-contract');
    const { PRICING_AUTHORING_KEY } = await import('@/lib/pricing/pricing-authoring-contract');
    const { parsePricingAuthoring, pricingAuthoringContent, derivedPricingBase, assertPricingBaseRelation } = await import('@/lib/pricing/pricing-authoring');
    const { getPricingCatalog, pricingFingerprint, pricingCanonical } = await import('@/lib/pricing/catalog');
    const { fixedPricingCredits, sumDecimal, multiplyDecimal } = await import('@/lib/pricing/math');
    const { frozenPricingCredits, frozenPricingReservation } = await import('@/lib/pricing/frozen-charge');
    const { normalizedVideoPricingReferenceScope, assertVideoPricingFinalReferences, issueVideoPricingCredential,
      verifyVideoPricingCredential, videoPricingBusinessFingerprint } = await import('@/lib/pricing/video-context');
    const { videoPricingIdentity, quoteVideoPricing } = await import('@/lib/pricing/video');
    const { selectPricingRule } = await import('@/lib/pricing/resolve');
    const { VOLCENGINE_IP_API_SETTING_KEY } = await import('@/lib/integrations/volcengine-ip');
    const { IMAGE_GENERATION_API_SETTING_KEY, getImageGenerationChannels, selectImageGenerationSettings,
      resolveImageGenerationModelSettings } = await import('@/lib/integrations/image-generation');
    const { imageBillingScope } = await import('@/lib/image-studio/billing-scope');
    const { imageBillingReady, recordImageBillingProof } = await import('@/lib/image-studio/billing-readiness');
    const { capturePricingWorkerCapability, renewPricingWorkerCapability, assertPricingImageConsumerReady,
      pricingRuntimeModuleHashes } = await import('@/lib/pricing/runtime');
    const { readPricingWriterIsolation } = await import('@/lib/pricing/isolation');
    equal(await db.user.count(), 0); equal(await db.platformSetting.count(), 0);
    equal(await db.videoTask.count(), 0); equal(await db.imageStudioTask.count(), 0);
    equal(await db.creditAccount.count(), 0); equal(await db.creditLedger.count(), 0);
    await db.$transaction(async tx => {
      const actor = await tx.user.create({ data: { id: `authoring-${randomUUID()}`, username: `authoring-${randomUUID()}`,
        email: `${randomUUID()}@fixture.invalid`, name: 'Synthetic authoring administrator', password_hash: 'not-a-login-credential', role: 'admin', status: 'active' } });
      const source = { type: 'admin_defined' as const, reference: 'Synthetic authoring fixture, not a supplier statement', note: '' };
      const base = (amount: string) => ({ amount, currency: 'CNY' as const, unit: 'second' as const, source });
      const put = async (key: string, value: unknown) => tx.platformSetting.upsert({ where: { key },
        create: { key, value_json: JSON.stringify(value) }, update: { value_json: JSON.stringify(value) } });
      const ip = { enabled: true, api_key: 'authoring-fixture-ip-key', base_url: 'https://fixture.invalid/ip', default_model: 'doubao-seedance-2-5-260628' };
      await put(VOLCENGINE_IP_API_SETTING_KEY, ip);
      let snapshot = await getAdminPricingSnapshot(actor, tx);
      const row = (id: string) => {
        const found = snapshot.rows.find(value => value.id === id); assert.ok(found, `Missing fixture row ${id}`); return found;
      };
      const input = (action: PricingAdminAction, modern = true): PricingAdminPreviewInput => ({ expectedRevision: snapshot.revision,
        catalogFingerprint: snapshot.catalogFingerprint, action,
        ...(modern ? { expectedAuthoringRevision: snapshot.authoring!.revision } : {}) });
      const save = async (action: PricingAdminAction, modern = true) => {
        const requestInput = input(action, modern), preview = await previewAdminPricing(actor, requestInput, tx);
        const request: PricingAdminSaveInput = { ...requestInput, operationId: randomUUID(), previewToken: preview.previewToken };
        const result = await saveAdminPricing(actor, request, tx);
        equal(result.state, 'succeeded'); ok(result.snapshot); snapshot = result.snapshot!;
        return { preview, request, result };
      };
      const stateBytes = async () => (await tx.platformSetting.findMany({ where: { key: { in: [PRICING_POLICY_KEY, PRICING_AUTHORING_KEY] } },
        select: { key: true, value_json: true }, orderBy: { key: 'asc' } }));
      const revisionCount = () => tx.platformSetting.count({ where: { key: { startsWith: PRICING_REVISION_PREFIX } } });
      const hash = (value: unknown) => ok(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Adopted revisions must be content hashes, never pending');
      const ipRows = snapshot.rows.filter(value => value.identity.channelId === 'volcengine_ark');
      ok(ipRows.length >= 2);
      const a = ipRows[0].id, b = ipRows[1].id;
      await save({ kind: 'save', changes: { standards: { site_base_cny: '6' }, rows: [
        { id: a, mode: 'follow', base: base('1') }, { id: b, mode: 'follow', base: base('1') },
      ] } }, false);
      const historicalLegacyFollow = snapshot.revision;
      equal(row(a).currentPointsPerCny, '6'); equal(row(b).mode, 'follow');
      await save({ kind: 'save', changes: { authoring: { globalPointsPerCny: '10' }, rows: [{ id: a, authoringRateMode: 'follow_global' }] } });
      equal(row(a).currentPointsPerCny, '10'); equal(row(a).authoringRateMode, 'follow_global');
      equal(row(b).currentPointsPerCny, '6'); equal(row(b).mode, 'follow'); equal(snapshot.standards.site_base_cny, '6');
      await save({ kind: 'save', changes: { authoring: { globalPointsPerCny: '12' }, rows: [] } });
      equal(row(a).currentPointsPerCny, '12'); equal(row(b).currentPointsPerCny, '6'); equal(row(b).mode, 'follow');
      evidence.push('C01: real policy saves move only A from legacy follow 6 to unified 10 and 12; B remains legacy follow 6, with the old standard untouched.');

      const beforeExit = { policy: snapshot.revision, authoring: snapshot.authoring!.revision, price: row(a).currentUnitCredits };
      const exited = await save({ kind: 'save', changes: { rows: [{ id: a, authoringRateMode: 'custom' }] } });
      equal(row(a).currentUnitCredits, beforeExit.price); ok(snapshot.revision !== beforeExit.policy); ok(snapshot.authoring!.revision !== beforeExit.authoring);
      equal(snapshot.authoring!.members, []);
      const zeroMemberPrice = row(a).currentUnitCredits;
      const beforeZero = snapshot.revision;
      await save({ kind: 'save', changes: { authoring: { globalPointsPerCny: '14' }, rows: [] } });
      ok(snapshot.revision !== beforeZero); equal(snapshot.authoring!.globalPointsPerCny, '14'); equal(snapshot.authoring!.members, []);
      equal(row(a).currentUnitCredits, zeroMemberPrice); equal(row(b).currentPointsPerCny, '6');
      await save({ kind: 'save', changes: { authoring: { globalPointsPerCny: '12' }, rows: [] } });
      const beforeJoin = { policy: snapshot.revision, authoring: snapshot.authoring!.revision, price: row(a).currentUnitCredits };
      const joined = await save({ kind: 'save', changes: { rows: [{ id: a, authoringRateMode: 'follow_global' }] } });
      equal(row(a).currentUnitCredits, beforeJoin.price); ok(snapshot.revision !== beforeJoin.policy); ok(snapshot.authoring!.revision !== beforeJoin.authoring);
      equal(joined.result.authoringRevision, snapshot.authoring!.revision);
      const history = await getAdminPricingHistory(actor, { limit: 1 }, tx);
      equal(history.entries[0].revisionId, joined.result.revision);
      equal(history.entries[0].authoringBefore!.members, []); equal(history.entries[0].authoringAfter!.members, [a]);
      const rawAuthoring = await tx.platformSetting.findUniqueOrThrow({ where: { key: PRICING_AUTHORING_KEY } });
      equal(pricingAuthoringContent(parsePricingAuthoring(rawAuthoring.value_json, snapshot.revision)), pricingAuthoringContent(snapshot.authoring!));
      throws(() => parsePricingAuthoring(rawAuthoring.value_json, 'wrong-policy-revision'));
      equal(await saveAdminPricing(actor, exited.request, tx), exited.result);
      equal(await getAdminPricingOperation(actor, joined.request.operationId, tx), joined.result);
      evidence.push('C03: same-price membership join/exit advance both revisions and retain historical authoring plus original operation receipts; a zero-member standard change is durable without repricing A/B.');

      const noAuthoring = input({ kind: 'save', changes: { rows: [] } }, false);
      const beforeOldWriter = await stateBytes();
      await rejects(() => previewAdminPricing(actor, noAuthoring, tx), error => !!error && typeof error === 'object' && 'code' in error && error.code === 'pricing_authoring_client_required');
      const modernPreview = await previewAdminPricing(actor, input({ kind: 'save', changes: { rows: [] } }), tx);
      const oldWrite = await saveAdminPricing(actor, { ...noAuthoring, operationId: randomUUID(), previewToken: modernPreview.previewToken }, tx);
      equal(oldWrite.state, 'rejected'); equal(oldWrite.error?.code, 'pricing_authoring_client_required'); equal(await stateBytes(), beforeOldWriter);
      const beforeUnavailable = await stateBytes(), beforeUnavailableHistory = await revisionCount();
      await put(VOLCENGINE_IP_API_SETTING_KEY, { ...ip, enabled: false });
      snapshot = await getAdminPricingSnapshot(actor, tx);
      await rejects(() => previewAdminPricing(actor, input({ kind: 'save', changes: { authoring: { globalPointsPerCny: '13' }, rows: [] } }), tx));
      equal(await stateBytes(), beforeUnavailable); equal(await revisionCount(), beforeUnavailableHistory);
      await save({ kind: 'save', changes: { authoring: { globalPointsPerCny: '13' }, rows: [{ id: a, authoringRateMode: 'custom' }] } });
      equal(snapshot.authoring!.members, []);
      const storedPolicy = JSON.parse((await tx.platformSetting.findUniqueOrThrow({ where: { key: PRICING_POLICY_KEY } })).value_json);
      equal(storedPolicy.rules.find((value: { id: string }) => value.id === a).customPointsPerCny, '12');
      equal(storedPolicy.rules.find((value: { id: string }) => value.id === b).mode, 'follow');
      await put(VOLCENGINE_IP_API_SETTING_KEY, ip); snapshot = await getAdminPricingSnapshot(actor, tx);
      equal(row(a).currentPointsPerCny, '12'); equal(row(b).currentPointsPerCny, '6');
      evidence.push('C01/C03: an unavailable existing member rejects the whole group; metadata-only explicit removal keeps its materialized price and permits saving the remaining setting. Old writers lacking the authoring revision reject without changing either record.');

      await save({ kind: 'save', changes: { standards: { site_base_cny: '8' }, rows: [] } });
      equal(row(b).currentPointsPerCny, '8');
      await save({ kind: 'restore', revisionId: historicalLegacyFollow, ruleIds: [b] });
      equal(row(b).currentPointsPerCny, '6'); equal(row(b).mode, 'custom'); equal(snapshot.standards.site_base_cny, '8');
      hash(row(b).authoringEntry?.adoptedRevision);
      const parent = snapshot.rows.find(value => value.identity.channelId === 'seedance' && value.identity.modelId === 'dreamina-seedance-2-0-260128'
        && value.identity.specifications.resolution === '480p' && value.identity.specifications.referenceVideo === 'none' && value.identity.specifications.pricingPurpose === 'standard')!;
      const child = snapshot.rows.find(value => value.identity.channelId === 'seedance' && value.identity.modelId === 'dreamina-seedance-2-5-260628'
        && pricingCanonical(value.identity.specifications) === pricingCanonical(parent?.identity.specifications))!;
      ok(parent); ok(child);
      await save({ kind: 'save', changes: { authoring: { globalPointsPerCny: '10' }, rows: [
        { id: parent.id, mode: 'custom', customPointsPerCny: '10', base: base('0.10') },
        { id: child.id, mode: 'custom', customPointsPerCny: '10', base: base('0.15') },
      ] } });
      await save({ kind: 'save', changes: { rows: [{ id: parent.id, authoringRateMode: 'follow_global' },
        { id: child.id, authoringRateMode: 'follow_global', baseRelation: { parentId: parent.id, factor: '1.5' } }] } });
      const historicalChild = snapshot.revision;
      equal(row(child.id).baseCny, '0.15'); equal(row(child.id).authoringEntry!.baseRelation!.parentRevision, row(parent.id).authoringEntry!.adoptedRevision);
      await save({ kind: 'save', changes: { rows: [{ id: child.id, authoringRateMode: 'custom', customPointsPerCny: '8' }] } });
      ok(row(child.id).authoringEntry!.baseRelation);
      await save({ kind: 'save', changes: { rows: [{ id: parent.id, base: base('0.20') }] } });
      equal(row(child.id).baseCny, '0.3'); equal(row(child.id).currentPointsPerCny, '8');
      await save({ kind: 'restore', revisionId: historicalChild, ruleIds: [child.id] });
      equal(row(parent.id).baseCny, '0.2'); equal(row(child.id).baseCny, '0.15'); equal(row(child.id).authoringEntry!.baseRelation, null);
      evidence.push('C02: restoring only the historical child keeps 0.15 rather than current-parent 0.20 x 1.5; unselected parent and standard stay current. Old follow restores its historical effective 6, not the current legacy standard 8.');

      await save({ kind: 'save', changes: { rows: [{ id: child.id, customPointsPerCny: '7', baseRelation: { parentId: parent.id, factor: '1.5' } }] } });
      await save({ kind: 'save', changes: { rows: [{ id: parent.id, base: base('0.48229127') }] } });
      equal(derivedPricingBase('0.48229127', '1.5'), { exact: '0.723436905', adopted: '0.72343691' });
      equal(row(child.id).baseCny, '0.72343691'); equal(row(child.id).authoringEntry!.baseRelation!.exactProduct, '0.723436905');
      hash(row(parent.id).authoringEntry!.adoptedRevision);
      equal(row(child.id).authoringEntry!.baseRelation!.parentRevision, row(parent.id).authoringEntry!.adoptedRevision);
      await save({ kind: 'save', changes: { authoring: { globalPointsPerCny: '12' }, rows: [] } });
      equal(row(parent.id).currentPointsPerCny, '12'); equal(row(child.id).currentPointsPerCny, '7');
      await save({ kind: 'save', changes: { rows: [{ id: child.id, base: base('0.5') }] } });
      equal(row(child.id).authoringEntry!.baseRelation, null);
      await save({ kind: 'save', changes: { rows: [{ id: parent.id, base: base('0.4') }] } });
      equal(row(child.id).baseCny, '0.5'); equal(row(child.id).currentPointsPerCny, '7');
      const beforeBadRelation = await stateBytes();
      await rejects(() => previewAdminPricing(actor, input({ kind: 'save', changes: { rows: [{ id: child.id, base: base('0.1'), baseRelation: { parentId: parent.id, factor: '1.5' } }] } }), tx));
      equal(await stateBytes(), beforeBadRelation);
      for (const specifications of [{ ...child.identity.specifications, resolution: '720p' },
        { ...child.identity.specifications, referenceVideo: 'present' }, { ...child.identity.specifications, pricingPurpose: 'draft' }]) {
        throws(() => assertPricingBaseRelation(parent.identity, { ...child.identity, specifications }));
      }
      throws(() => assertPricingBaseRelation(parent.identity, { ...child.identity, channelId: 'volcengine_ark' }));
      throws(() => derivedPricingBase('1000000', '1.5')); throws(() => derivedPricingBase('0.000000001', '1.5'));
      evidence.push('C04/C05: independent rate and base follows survive the other override; exact parent multiplication rounds once to eight places, tracks the real parent content hash, and rejects incompatible scopes, simultaneous child-base/relation writes, zero or overflowing derived bases.');

      const historicalEvidence: PricingEvidence = { kind: 'historical_statement', amount: '0.482291270', currency: 'CNY', unit: 'second',
        specifications: parent.identity.specifications, sampledAt: null, exchangeAssumption: '7 CNY per USD, fixture assumption only',
        reference: 'Synthetic date-only sample 2026-10-18; not a supplier bill', version: 'fixture-evidence-v1' };
      await save({ kind: 'save', changes: { rows: [{ id: parent.id, base: base('0.48229127'), evidence: historicalEvidence }] } });
      equal(row(parent.id).authoringEntry!.sourceKind, 'historical_statement');
      const originalEvidence = structuredClone(row(parent.id).authoringEntry!.evidence), adoptedRevision = row(parent.id).authoringEntry!.adoptedRevision;
      await save({ kind: 'save', changes: { rows: [{ id: parent.id, base: { ...base('0.5'), source: { ...source, type: 'supplier_statement' } } }] } });
      equal(row(parent.id).authoringEntry!.sourceKind, 'admin_defined'); equal(row(parent.id).source!.type, 'admin_defined');
      equal(row(parent.id).authoringEntry!.evidence, originalEvidence); ok(row(parent.id).authoringEntry!.adoptedRevision !== adoptedRevision);
      const beforeEvidence = { revision: snapshot.revision, authoring: snapshot.authoring!.revision, price: row(parent.id).currentUnitCredits };
      await save({ kind: 'save', changes: { rows: [{ id: parent.id, evidence: { ...historicalEvidence, version: 'fixture-evidence-v2' } }] } });
      equal(row(parent.id).currentUnitCredits, beforeEvidence.price); ok(snapshot.revision !== beforeEvidence.revision); ok(snapshot.authoring!.revision !== beforeEvidence.authoring);
      equal(row(parent.id).authoringEntry!.evidence!.sampledAt, null); equal(row(parent.id).authoringEntry!.sourceKind, 'admin_defined');
      evidence.push('C03/C04: numerically equal evidence/base formats still match; manual adoption changes become administrator pricing while preserving original evidence and date precision. Same-price evidence revisions still advance both saved revisions.');

      const scenarioInput = { ...input({ kind: 'save', changes: { rows: [{ id: parent.id, customPointsPerCny: '10', base: base('0.48229127') }] } }),
        scenarios: [{ rowId: parent.id, quantity: '5' }, { rowId: parent.id, quantity: '4' }] };
      const scenarios = await previewAdminPricing(actor, scenarioInput, tx);
      equal(scenarios.scenarios!.map(value => value.adjustedCredits), ['24.1', '19.3']);
      equal(scenarios.scenarios![0].exactCredits, '24.1145635'); equal(scenarios.scenarios![0].deltaCredits, '-5.9');
      equal(scenarios.scenarios![0].authorizedMaximumCredits, null);
      const scenarioBytes = await stateBytes();
      const changedScenario = await saveAdminPricing(actor, { ...scenarioInput, scenarios: [{ rowId: parent.id, quantity: '6' }],
        operationId: randomUUID(), previewToken: scenarios.previewToken }, tx);
      equal(changedScenario.state, 'rejected'); equal(await stateBytes(), scenarioBytes);
      const scenarioSaved = await saveAdminPricing(actor, { ...scenarioInput, operationId: randomUUID(), previewToken: scenarios.previewToken }, tx);
      equal(scenarioSaved.state, 'succeeded'); snapshot = scenarioSaved.snapshot!;
      equal(fixedPricingCredits('0.15', '1', '3').credits, '0.5');
      equal(sumDecimal(Array.from({ length: 3 }, () => fixedPricingCredits('0.15', '1', '1').credits)), '0.6');
      equal(multiplyDecimal([row(parent.id).currentUnitCredits!, '5']), '24', 'Displayed unit rounding is not the task calculation');
      evidence.push('C09/C10: signed real multi-scenario preview returns 5-second 24.1 rather than displayed-unit 24.0, exact intermediate values and current-price delta; changing a signed scenario rejects. Independent tenth rounding remains 0.6 versus one aggregate task 0.5.');

      const normalInput = { provider: 'seedance' as const, model: parent.identity.modelId, resolution: '480p', duration: 5 };
      const scopedRules = [{ id: 'scoped', identity: parent.identity }, { id: 'legacy-wide', identity: { ...parent.identity, specifications: {} } }];
      for (const pricingPurpose of ['standard', 'draft', 'draft_upgrade', 'unknown'] as const) {
        for (const referenceVideo of ['none', 'present', 'unknown'] as const) {
          const identity = videoPricingIdentity({ ...normalInput, referenceVideo, pricingPurpose });
          equal(selectPricingRule(scopedRules, identity)?.id, pricingPurpose === 'standard' && referenceVideo === 'none' ? 'scoped' : 'legacy-wide');
        }
      }
      await rejects(() => quoteVideoPricing(normalInput, tx));
      equal((await quoteVideoPricing({ ...normalInput, referenceVideo: 'none', pricingPurpose: 'standard' }, tx)).pricing.estimatedCost, 24.1);
      const templateScope = normalizedVideoPricingReferenceScope([], ['https://fixture.invalid/template-reference']);
      equal(templateScope.referenceVideo, 'present'); equal(templateScope.referenceVideoCount, 1);
      equal(normalizedVideoPricingReferenceScope(['https://fixture.invalid/body'], []).referenceVideo, 'none');
      const referenceContext: VideoPricingContext = { fingerprint: pricingFingerprint({ fixture: 'scope-a' }), actorId: actor.id,
        projectId: 'fixture-project-a', videoCardId: 'fixture-card-a', payer: { kind: 'user', id: actor.id },
        purpose: 'standard', templateRunId: 'fixture-template', ...templateScope };
      assertVideoPricingFinalReferences(referenceContext, templateScope.urls); assertions++;
      throws(() => assertVideoPricingFinalReferences(referenceContext, ['https://fixture.invalid/different-reference']));
      const pair = normalizedVideoPricingReferenceScope(['https://fixture.invalid/a', 'https://fixture.invalid/b']);
      assertVideoPricingFinalReferences({ ...referenceContext, ...pair }, [...pair.urls].reverse()); assertions++;
      equal(normalizedVideoPricingReferenceScope([' https://fixture.invalid/a ', 'https://fixture.invalid/a']).referenceVideoCount, 1);
      const localReference = normalizedVideoPricingReferenceScope(['/uploads/fixture-reference.mp4']);
      equal(normalizedVideoPricingReferenceScope(['https://sd2.youdooart.com/uploads/fixture-reference.mp4']).referenceVideoFingerprint,
        localReference.referenceVideoFingerprint);
      equal(normalizedVideoPricingReferenceScope(['/uploads/fixture-reference.mp4', 'https://sd2.youdooart.com/uploads/fixture-reference.mp4']).referenceVideoCount, 1);
      ok(normalizedVideoPricingReferenceScope(['https://foreign.invalid/uploads/fixture-reference.mp4']).referenceVideoFingerprint !== localReference.referenceVideoFingerprint,
        'An unrelated origin cannot impersonate a local upload');
      throws(() => normalizedVideoPricingReferenceScope(['a', 'b', 'c', 'd']));
      evidence.push('C06: production identity selection separates none/present/unknown and standard/draft/upgrade; contextless scoped quotes reject. The shared normalizer lets explicit template references override an empty body and final-reference verification rejects equal-count substitutions. This is pure scope evidence, not a real template-authorization exercise.');

      const token = issueVideoPricingCredential(referenceContext, snapshot.revision, 24.1);
      verifyVideoPricingCredential(token, referenceContext, snapshot.revision, 24.1); assertions++;
      throws(() => verifyVideoPricingCredential(token, { ...referenceContext, actorId: 'other-actor' }, snapshot.revision, 24.1));
      for (const changed of [{ projectId: 'fixture-project-b' }, { purpose: 'draft' as const }, { purpose: 'draft_upgrade' as const }, { videoCardId: 'fixture-card-b' }]) {
        throws(() => verifyVideoPricingCredential(token, { ...referenceContext, ...changed,
          fingerprint: pricingFingerprint({ fixture: 'distinct-resolved-scope', changed }) }, snapshot.revision, 24.1));
      }
      throws(() => verifyVideoPricingCredential(token, { ...referenceContext, fingerprint: pricingFingerprint({ resolution: '720p', duration: 6 }) }, snapshot.revision, 24.1));
      throws(() => verifyVideoPricingCredential(token, referenceContext, 'new-revision', 24.1));
      throws(() => verifyVideoPricingCredential(token, referenceContext, snapshot.revision, 24.2));
      throws(() => verifyVideoPricingCredential(`${token}x`, referenceContext, snapshot.revision, 24.1));
      const expired = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
      expired.expires = Date.now() - 1000;
      const expiredBody = Buffer.from(JSON.stringify(expired)).toString('base64url');
      const expiredSignature = createHmac('sha256', process.env.SESSION_SECRET!).update(`video-pricing-context-v1\0${expiredBody}`).digest('base64url');
      throws(() => verifyVideoPricingCredential(`${expiredBody}.${expiredSignature}`, referenceContext, snapshot.revision, 24.1));
      const stable = { idempotency_key: 'fixture-original-request', project_id: referenceContext.projectId, duration: 5,
        reference_video_urls: templateScope.urls, max_estimated_cost: 24.1 };
      const firstFingerprint = videoPricingBusinessFingerprint({ ...stable, pricing_quote_token: token, pricing_revision: snapshot.revision, pricing_fingerprint_version: 2 });
      const refreshedToken = issueVideoPricingCredential(referenceContext, 'later-price-revision', 24.1);
      equal(videoPricingBusinessFingerprint({ ...stable, pricing_quote_token: refreshedToken, pricing_revision: 'later-price-revision', pricing_fingerprint_version: 2 }), firstFingerprint);
      ok(firstFingerprint.startsWith('pricing-v2:'));
      ok(videoPricingBusinessFingerprint({ ...stable, max_estimated_cost: 25 }) !== firstFingerprint);
      evidence.push('C06: real token helpers reject a different actor/resolved project, card, parameters, purpose, revision, amount, tampering and a correctly signed expired token. Refreshed credentials do not change the pricing-v2 fingerprint; the authorization ceiling still does.');

      // Synthetic frozen input only: no supplier proof, bill, task or readiness claim is created.
      const actual: FrozenPricingCharge = { schema: 'pricing-charge-v1', revision: 'fixture-actual', ruleId: 'fixture-actual',
        identity: { kind: 'image', channelId: 'shared', modelId: 'gpt-image-2', billingMode: 'actual', unit: 'image', specifications: {} },
        binding: { configRevision: 'fixture-only', billingPrincipalId: 'fixture-only', credentialVersion: 'fixture-only', configFingerprint: 'fixture-only' },
        basisKind: 'supplier_cost_cny', mode: 'custom', baseCny: null, pointsPerCny: '1', legacyUnitCredits: null, legacyRounding: null,
        quantity: '1', issuedAt: new Date().toISOString(), rounding: 'half_up_tenth',
        exchangeRate: { sourceCurrency: 'USD', targetCurrency: 'CNY', direction: 'CNY_per_source_unit', rate: '1', revision: 'fixture-fx',
          effectiveFrom: '2026-01-01T00:00:00.000Z', confirmedAt: '2026-01-01T00:00:00.000Z', confirmedBy: snapshot.actor, source } };
      const authorizedBefore = frozenPricingReservation(actual, 35), frozenBefore = JSON.stringify(actual);
      equal(sumDecimal(Array.from({ length: 3 }, () => String(frozenPricingCredits(actual, 150000).credits))), '0.6');
      equal(frozenPricingCredits(actual, 450000).credits, 0.5);
      await put(IMAGE_GENERATION_API_SETTING_KEY, { enabled: true, provider: 'musk', api_key: 'fixture-never-used-key',
        base_url: 'https://api.muskapis.com/v1', default_model: 'gpt-image-2', supports_text_to_image: true, supports_image_to_image: true });
      await put('image_actual_billing_intent_v1', { enabled: true, revision: 1, enabledModels: ['gpt-image-2'] });
      snapshot = await getAdminPricingSnapshot(actor, tx);
      const unverifiedActual = snapshot.rows.find(value => value.identity.kind === 'image' && value.identity.channelId === 'shared'
        && value.identity.modelId === 'gpt-image-2' && value.identity.billingMode === 'actual');
      ok(unverifiedActual); ok(unverifiedActual!.availability !== 'ready');
      const actualPreview = await previewAdminPricing(actor, { ...input({ kind: 'save', changes: { rows: [] } }),
        scenarios: [{ rowId: unverifiedActual!.id, quantity: '3', exampleAmount: '0.15' }] }, tx);
      equal(actualPreview.scenarios![0].isExample, true); equal(actualPreview.scenarios![0].adjustedCredits, null);
      equal(actualPreview.scenarios![0].authorizedMaximumCredits, null);

      const suppliedRuntime = process.env.PRICING_AUTHORING_RUNTIME_ROOT, runtimeSource = process.env.PRICING_SOURCE_SHA;
      ok(suppliedRuntime && path.isAbsolute(suppliedRuntime) && !/[?#\0]/.test(suppliedRuntime), 'Lead must supply the prepared core runtime, with no fallback');
      ok(runtimeSource && /^[a-f0-9]{40}$/.test(runtimeSource), 'The isolated runtime must identify this candidate source');
      equal(process.platform, 'linux', 'C09 readiness requires the actual Linux root/immutable/process gates');
      ok(typeof process.getuid === 'function' && process.getuid() > 0, 'Use the provisioned non-root build identity');
      const runtimeRoot = fs.realpathSync(suppliedRuntime!);
      equal(runtimeRoot, suppliedRuntime); ok(runtimeRoot.startsWith(`${fixtureRoot}${path.sep}`));
      const runtimeStat = fs.lstatSync(runtimeRoot);
      ok(runtimeStat.isDirectory() && !runtimeStat.isSymbolicLink() && runtimeStat.uid === process.getuid!()
        && !(runtimeStat.mode & 0o077), 'The prepared runtime must be private to the build user');
      equal(fs.readFileSync(path.join(root, '.deployed-commit'), 'utf8').trim(), runtimeSource);
      const runtimeCommit = path.join(runtimeRoot, '.deployed-commit');
      equal(fs.realpathSync(runtimeCommit), runtimeCommit);
      equal(fs.readFileSync(runtimeCommit, 'utf8').trim(), runtimeSource);
      equal(pricingRuntimeModuleHashes(runtimeRoot), pricingRuntimeModuleHashes(root), 'Readiness must use the same real candidate module bytes');
      const manifestPath = path.join(runtimeRoot, 'g19-bootstrap.json'), manifestStat = fs.lstatSync(manifestPath);
      equal(fs.realpathSync(manifestPath), manifestPath);
      ok(manifestStat.isFile() && !manifestStat.isSymbolicLink() && manifestStat.nlink === 1 && manifestStat.uid === 0
        && !(manifestStat.mode & 0o222) && manifestStat.size > 0 && manifestStat.size <= 65536, 'Require the original root-prepared manifest');
      const manifestBytes = fs.readFileSync(manifestPath), manifest = JSON.parse(manifestBytes.toString('utf8'));
      equal(manifest.schema, 'pricing-legacy-bootstrap.v1'); equal(manifest.candidateRoot, root);
      equal(manifest.fixtureRoot, runtimeRoot); equal(manifest.source, runtimeSource);
      equal(manifest.uid, process.getuid!()); equal(manifest.gid, process.getgid!());
      const markerPath = path.join(runtimeRoot, 'storage/image-studio-drain'), markerStat = fs.lstatSync(markerPath);
      equal(manifest.markers?.strict, markerPath); equal(fs.realpathSync(markerPath), markerPath);
      ok(markerStat.isFile() && !markerStat.isSymbolicLink() && markerStat.nlink === 1 && markerStat.uid === 0
        && (markerStat.mode & 0o777) === 0o444, 'Never substitute a writable or linked isolation marker');
      const markerBytes = fs.readFileSync(markerPath), isolation = readPricingWriterIsolation(runtimeRoot);
      ok(isolation, 'The production reader must accept the actual root-owned immutable isolated marker');
      equal(isolation!.installedAt, manifest.installedAt);
      const markerShaBefore = createHash('sha256').update(markerBytes).digest('hex');
      const previousCwd = process.cwd();
      try {
        process.chdir(runtimeRoot);
        const capability = capturePricingWorkerCapability(runtimeSource!);
        equal(capability.instance.pid, process.pid); equal(capability.instance.cwd, runtimeRoot);
        await renewPricingWorkerCapability(tx, capability);
        equal((await assertPricingImageConsumerReady(tx)).workerId, capability.workerId);
        const settings = resolveImageGenerationModelSettings(selectImageGenerationSettings(
          await getImageGenerationChannels(tx, true), 'gpt-image-2', 'shared'), 'gpt-image-2');
        equal(settings.api_key, 'fixture-never-used-key');
        const scope = imageBillingScope(settings);
        equal((await imageBillingReady(scope, 'gpt-image-2', tx)).ready, false);
        // Synthetic proof exercises only the transaction-local readiness branch, not supplier verification.
        const proof = { scope, model: 'gpt-image-2', taskId: `synthetic-authoring-no-generation-${randomUUID()}`,
          ledgerId: `synthetic-authoring-no-charge-${randomUUID()}` };
        await recordImageBillingProof(tx, proof);
        equal((await imageBillingReady(scope, 'gpt-image-2', tx)).ready, true);
        const readyCatalog = await getPricingCatalog(tx);
        equal(readyCatalog.rows.find(value => value.id === unverifiedActual!.id)?.availability, 'ready');
        snapshot = await getAdminPricingSnapshot(actor, tx);
        equal(snapshot.runtime.imageReady, true); equal(snapshot.authoring!.members, []);
        const standardsBefore = structuredClone(snapshot.standards);
        const videoPrices = () => snapshot.rows.filter(value => value.identity.kind === 'video').map(value => ({
          id: value.id, mode: value.mode, baseCny: value.baseCny, exchangeRate: value.exchangeRate,
          currentPointsPerCny: value.currentPointsPerCny, currentUnitCredits: value.currentUnitCredits,
        }));
        const videoPricesBefore = structuredClone(videoPrices());
        await save({ kind: 'save', changes: { rows: [{ id: unverifiedActual!.id, mode: 'custom', customPointsPerCny: '1',
          exchangeRate: { sourceCurrency: 'USD', targetCurrency: 'CNY', direction: 'CNY_per_source_unit', rate: '1',
            effectiveFrom: '2026-01-01T00:00:00.000Z', source: { type: 'admin_defined',
              reference: 'Synthetic C09 test exchange only; not a supplier statement', note: 'Isolated rollback-only fixture' } } }] } });
        await save({ kind: 'save', changes: { authoring: { globalPointsPerCny: '1' },
          rows: [{ id: unverifiedActual!.id, authoringRateMode: 'follow_global' }] } });
        equal(row(unverifiedActual!.id).authoringRateMode, 'follow_global'); equal(snapshot.authoring!.members, [unverifiedActual!.id]);
        const previewExamples = () => previewAdminPricing(actor, { ...input({ kind: 'save', changes: { rows: [] } }),
          scenarios: [{ rowId: unverifiedActual!.id, quantity: '3', exampleAmount: '0.15' }] }, tx);
        const threeExamples = (await previewExamples()).scenarios![0];
        equal(threeExamples.isExample, true); equal(threeExamples.exactCredits, '0.45');
        equal(threeExamples.currentCredits, '0.6'); equal(threeExamples.adjustedCredits, '0.6');
        equal(threeExamples.authorizedMaximumCredits, null);
        ok(threeExamples.adjustedCredits !== String(frozenPricingCredits(actual, 450000).credits), 'Three independent bills cannot be rounded as one aggregate bill');
        await renewPricingWorkerCapability(tx, capability);
        await save({ kind: 'save', changes: { authoring: { globalPointsPerCny: '2' }, rows: [] } });
        const changedExamples = (await previewExamples()).scenarios![0];
        equal(row(unverifiedActual!.id).currentPointsPerCny, '2');
        equal(changedExamples.currentCredits, '0.9'); equal(changedExamples.adjustedCredits, '0.9');
        equal(changedExamples.authorizedMaximumCredits, null); equal(changedExamples.isExample, true);
        equal(snapshot.standards, standardsBefore); equal(videoPrices(), videoPricesBefore);
      } finally {
        process.chdir(previousCwd);
        equal(fs.readFileSync(manifestPath), manifestBytes, 'The fixture never changes the root manifest');
        equal(createHash('sha256').update(fs.readFileSync(markerPath)).digest('hex'), markerShaBefore, 'The fixture never changes the root marker');
        ok(readPricingWriterIsolation(runtimeRoot), 'The real immutable marker remains valid');
      }
      equal(frozenPricingReservation(actual, 35), authorizedBefore); equal(JSON.stringify(actual), frozenBefore);
      equal(await tx.videoTask.count(), 0); equal(await tx.imageStudioTask.count(), 0); equal(await tx.creditLedger.count(), 0);
      evidence.push('C09: synthetic actual bills and the real policy preview round three independent 0.15 examples to 0.6, not aggregate 0.45 to 0.5; adopting exchange 1/rate 1 then unified rate 2 changes the real preview to 0.9 without changing authorization, frozen reservation, old standards or unselected video prices. Unverified actual readiness still yields no invented price. The candidate-matched isolated runtime uses the real root/immutable reader and live process/module capability; proof IDs are explicitly synthetic and transaction-local, not real supplier, production readiness or billing evidence. All settings/capability/proof roll back; old cent balances and ledger conservation remain the existing G gates.');
      completed = true;
      throw rollback;
    }, { maxWait: 10000, timeout: 120000 });
  } catch (error) { if (error !== rollback) throw error; }
  finally {
    try {
      process.chdir(initialCwd);
      if (completed) {
        equal(await db.user.count(), 0); equal(await db.platformSetting.count(), 0);
        equal(await db.videoTask.count(), 0); equal(await db.imageStudioTask.count(), 0); equal(await db.creditLedger.count(), 0);
      }
    } finally {
      await db.$disconnect();
      setFixtureDatabase(undefined);
      if (previousPragmas === undefined) Reflect.deleteProperty(globalThis, 'prismaSqlitePragmasStarted');
      else Reflect.set(globalThis, 'prismaSqlitePragmasStarted', previousPragmas);
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }
  equal(completed, true);
  return { fixture: 'pricing-authoring-contract', completed: true, assertions, evidence };
}
