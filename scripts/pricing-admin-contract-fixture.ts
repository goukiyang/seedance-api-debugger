import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { getAdminPricingSnapshot, previewAdminPricing, saveAdminPricing, getAdminPricingOperation,
  getAdminPricingHistory, exportAdminPricingCsv, resolvePricingCharge } from '@/lib/pricing/policy';
import { getPricingCatalog, pricingCanonical } from '@/lib/pricing/catalog';
import { PRICING_POLICY_KEY, PRICING_OPERATION_PREFIX, PRICING_REVISION_PREFIX, type PricingAdminAction,
  type PricingAdminSnapshot, type PricingAdminPreviewInput, type PricingAdminSaveInput } from '@/lib/pricing/admin-contract';
import { VOLCENGINE_IP_API_SETTING_KEY } from '@/lib/integrations/volcengine-ip';
import { AIMEDIAKIT_API_SETTING_KEY } from '@/lib/integrations/aimediakit';
import { BANANA_IMAGE_API_SETTING_KEY, IMAGE_GENERATION_CHANNEL_REGISTRY_SETTING_KEY } from '@/lib/integrations/image-generation';
import { IMAGE_STUDIO_SETTING_KEY } from '@/lib/image-studio/settings';

// The build controller supplies an already-schema-initialized, empty SQLite fixture DB.
// No schema command, production client, provider request, or committed fixture row is used here.
const supplied = process.env.PRICING_ADMIN_FIXTURE_DB;
if (!supplied || !path.isAbsolute(supplied) || !path.basename(supplied).includes('pricing-admin-fixture')) {
  throw new Error('PRICING_ADMIN_FIXTURE_DB must identify an explicit pricing-admin-fixture SQLite file');
}
const filename = fs.realpathSync(supplied), temporaryRoot = fs.realpathSync(os.tmpdir());
const candidateRoot = fs.realpathSync(process.cwd()), fixtureRoot = path.join(candidateRoot, '.role-tests');
if ((!filename.startsWith(`${temporaryRoot}${path.sep}`) && !filename.startsWith(`${fixtureRoot}${path.sep}`)) || !fs.statSync(filename).isFile()) {
  throw new Error('Pricing fixture DB must be an existing isolated file under candidate .role-tests or OS temporary directory');
}
const fixture = new PrismaClient({ datasources: { db: { url: `file:${filename}` } } });
const rollback = new Error('pricing-admin-fixture-rollback');
const previousSecret = process.env.SESSION_SECRET;
process.env.SESSION_SECRET = 'pricing-admin-fixture-only-not-a-production-secret';
let completed = false;
const evidence: string[] = [];
const actorA = { id: `pricing-fixture-${randomUUID()}` }, actorB = { id: `pricing-fixture-${randomUUID()}` };
const defined = { type: 'admin_defined' as const, reference: '=fixture,"source"', note: 'isolated administrative base' };

async function setting(tx: Prisma.TransactionClient, key: string, value: unknown) {
  await tx.platformSetting.upsert({ where: { key }, create: { key, value_json: JSON.stringify(value) }, update: { value_json: JSON.stringify(value) } });
}
function input(snapshot: PricingAdminSnapshot, action: PricingAdminAction): PricingAdminPreviewInput {
  return { expectedRevision: snapshot.revision, catalogFingerprint: snapshot.catalogFingerprint, action };
}
async function persist(tx: Prisma.TransactionClient, snapshot: PricingAdminSnapshot, action: PricingAdminAction, actor = actorA) {
  const previewInput = input(snapshot, action), preview = await previewAdminPricing(actor, previewInput, tx);
  const request: PricingAdminSaveInput = { ...previewInput, operationId: randomUUID(), previewToken: preview.previewToken };
  const result = await saveAdminPricing(actor, request, tx);
  assert.equal(result.state, 'succeeded'); assert.ok(result.snapshot);
  return { request, result, snapshot: result.snapshot! };
}

async function run() {
  if (await fixture.user.count() || await fixture.platformSetting.count()) throw new Error('Fixture DB must be empty; no existing data may be changed');
  try {
    await fixture.$transaction(async tx => {
      for (const actor of [actorA, actorB]) await tx.user.create({ data: { id: actor.id, name: actor.id, username: actor.id,
        email: `${actor.id}@fixture.invalid`, password_hash: 'not-a-login-credential', role: 'admin', status: 'active' } });
      await setting(tx, VOLCENGINE_IP_API_SETTING_KEY, { enabled: true, api_key: 'fixture-key-not-valid',
        base_url: 'https://fixture.invalid/api/v3', default_model: 'doubao-seedance-2-5-260628' });
      await setting(tx, AIMEDIAKIT_API_SETTING_KEY, { enabled: false, api_key: null, base_url: 'https://fixture.invalid' });
      const before = await tx.platformSetting.count();
      let snapshot = await getAdminPricingSnapshot(actorA, tx);
      assert.equal(await tx.platformSetting.count(), before, 'first open must not write defaults');
      assert.equal(snapshot.revision, 'unconfigured');
      assert.deepEqual(snapshot.standards, { site_base_cny: null, supplier_cost_cny: null });
      assert.equal(snapshot.rows.filter(row => row.identity.kind === 'enhance').length, 20);
      assert.ok(snapshot.rows.filter(row => row.identity.kind === 'h3').every(row => row.currentUnitCredits === '0' && row.mode === 'free'));
      const rowA = snapshot.rows.find(row => row.identity.channelId === 'volcengine_ark' && row.isDefault)!;
      const rowB = snapshot.rows.find(row => row.identity.channelId === 'volcengine_ark' && row.id !== rowA.id)!;
      assert.ok(rowA && rowB); assert.equal(rowA.baseCny, null); assert.equal(rowA.confirmation, 'unconfirmed');
      assert.equal(await resolvePricingCharge(rowA.identity, tx), null);
      await assert.rejects(() => resolvePricingCharge({ ...rowA.identity, modelId: 'unregistered-model' }, tx));
      evidence.push('G05/G12: real catalog, 20 enhancement scopes, no first-open write, no missing-scope fallback');

      const baseline = await persist(tx, snapshot, { kind: 'save', changes: { standards: { site_base_cny: '1.0' }, rows: [] } });
      snapshot = baseline.snapshot;
      const baselineRevision = snapshot.revision;
      const adopted = await persist(tx, snapshot, { kind: 'save', changes: { rows: [
        { id: rowA.id, mode: 'follow', base: { amount: '0.15', currency: 'CNY', unit: 'second', source: defined } },
        { id: rowB.id, mode: 'custom', customPointsPerCny: '2.0', base: { amount: '0.5', currency: 'CNY', unit: 'second', source: defined } },
      ] } });
      snapshot = adopted.snapshot;
      const adoptedRevision = snapshot.revision;
      assert.equal(snapshot.rows.find(row => row.id === rowA.id)!.currentUnitCredits, '0.2');
      assert.equal(snapshot.rows.find(row => row.id === rowB.id)!.currentUnitCredits, '1');
      const simulation = await previewAdminPricing(actorA, { ...input(snapshot, { kind: 'save', changes: { rows: [] } }),
        simulation: { rowId: rowA.id, quantity: '5' } }, tx);
      assert.equal(simulation.simulation!.adjustedCredits, '0.8');
      const unitChanged = await persist(tx, snapshot, { kind: 'save', changes: { standards: { site_base_cny: '1.2' }, rows: [] } });
      snapshot = unitChanged.snapshot;
      assert.equal(snapshot.rows.find(row => row.id === rowA.id)!.currentPointsPerCny, '1.2');
      assert.equal(snapshot.rows.find(row => row.id === rowB.id)!.currentPointsPerCny, '2');
      assert.equal(snapshot.rows.find(row => row.id === rowB.id)!.hasDifference, true);
      assert.ok(unitChanged.result.affectedRuleIds.includes(rowB.id), 'custom comparison changes belong to full preview impact');
      evidence.push('G01-G04/G06/G18/G23: shared math, independent base, follow/custom standard impact, full affected set');

      snapshot = (await persist(tx, snapshot, { kind: 'save', changes: { standards: { site_base_cny: '10' }, rows: [
        { id: rowA.id, mode: 'custom', customPointsPerCny: '15', base: { amount: '1', currency: 'CNY', unit: 'second', source: defined } },
        { id: rowB.id, mode: 'custom', customPointsPerCny: '16', base: { amount: '0.5', currency: 'CNY', unit: 'second', source: defined } },
      ] } })).snapshot;
      assert.equal(Number(snapshot.rows.find(row => row.id === rowA.id)!.currentUnitCredits), 15);
      assert.equal(Number(snapshot.rows.find(row => row.id === rowB.id)!.currentUnitCredits), 8);
      assert.equal(Number(snapshot.rows.find(row => row.id === rowA.id)!.differencePercent), 50);
      assert.equal(Number(snapshot.rows.find(row => row.id === rowB.id)!.differencePercent), 60);
      snapshot = (await persist(tx, snapshot, { kind: 'unify', basisKind: 'site_base_cny', ruleIds: [rowA.id, rowB.id] })).snapshot;
      assert.equal(Number(snapshot.rows.find(row => row.id === rowA.id)!.currentUnitCredits), 10);
      assert.equal(Number(snapshot.rows.find(row => row.id === rowB.id)!.currentUnitCredits), 5);
      assert.ok([rowA.id, rowB.id].every(id => snapshot.rows.find(row => row.id === id)!.mode === 'follow'));
      const independentB = snapshot.rows.find(row => row.id === rowB.id)!;
      snapshot = (await persist(tx, snapshot, { kind: 'save', changes: { rows: [{ id: rowA.id, mode: 'custom', customPointsPerCny: '12' }] } })).snapshot;
      assert.equal(Number(snapshot.rows.find(row => row.id === rowA.id)!.currentUnitCredits), 12);
      assert.deepEqual(snapshot.rows.find(row => row.id === rowB.id), independentB);
      snapshot = (await persist(tx, snapshot, { kind: 'save', changes: { rows: [{ id: rowA.id, mode: 'follow' }] } })).snapshot;
      assert.equal(Number(snapshot.rows.find(row => row.id === rowA.id)!.currentUnitCredits), 10);
      assert.equal(snapshot.standards.site_base_cny, '10');
      evidence.push('G03/G04: actual policy single-row edit and follow restore leave base/standard/other row unchanged; selected unify turns 15/8 into 10/5 with 50%/60% differences');
      snapshot = (await persist(tx, snapshot, { kind: 'save', changes: { standards: { site_base_cny: '1.2' }, rows: [
        { id: rowA.id, mode: 'follow', base: { amount: '0.15', currency: 'CNY', unit: 'second', source: defined } },
        { id: rowB.id, mode: 'custom', customPointsPerCny: '2', base: { amount: '0.5', currency: 'CNY', unit: 'second', source: defined } },
      ] } })).snapshot;

      const firstReplay = await saveAdminPricing(actorA, adopted.request, tx);
      assert.equal(firstReplay.revision, adoptedRevision);
      assert.equal((await getAdminPricingOperation(actorA, adopted.request.operationId, tx)).revision, adoptedRevision);
      assert.equal((await getAdminPricingOperation(actorB, adopted.request.operationId, tx)).state, 'unknown');
      await assert.rejects(() => saveAdminPricing(actorA, { ...adopted.request, catalogFingerprint: 'f'.repeat(64) }, tx));
      const stale = await saveAdminPricing(actorB, { ...baseline.request, operationId: randomUUID() }, tx);
      assert.equal(stale.state, 'rejected'); assert.equal(stale.error!.code, 'pricing_conflict');
      assert.deepEqual(await getAdminPricingOperation(actorB, stale.operationId, tx), stale);
      const unknown = await getAdminPricingOperation(actorA, randomUUID(), tx); assert.equal(unknown.state, 'unknown');
      evidence.push('G07/G22: durable same-operation replay, distinct-body refusal, actor isolation, stale revision rejection, unknown remains unknown');

      const signedInput = input(snapshot, { kind: 'save', changes: { rows: [{ id: rowA.id, mode: 'custom', customPointsPerCny: '1.3' }] } });
      const signed = await previewAdminPricing(actorA, signedInput, tx);
      const changedBody = await saveAdminPricing(actorA, { ...signedInput, action: { kind: 'save', changes: { rows: [{ id: rowA.id, mode: 'custom', customPointsPerCny: '1.4' }] } },
        operationId: randomUUID(), previewToken: signed.previewToken }, tx);
      assert.equal(changedBody.state, 'rejected');
      const wrongActor = await saveAdminPricing(actorB, { ...signedInput, operationId: randomUUID(), previewToken: signed.previewToken }, tx);
      assert.equal(wrongActor.state, 'rejected');
      const badSignature = await saveAdminPricing(actorA, { ...signedInput, operationId: randomUUID(), previewToken: `${signed.previewToken}x` }, tx);
      assert.equal(badSignature.state, 'rejected');
      const payload = JSON.parse(Buffer.from(signed.previewToken.split('.')[0], 'base64url').toString('utf8'));
      payload.confirmedAt = new Date(Date.now() - 301000).toISOString(); payload.expiresAt = new Date(Date.now() - 1000).toISOString();
      const expiredBody = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const expiredSignature = createHmac('sha256', process.env.SESSION_SECRET!).update(`pricing-preview-v1\0${expiredBody}`).digest('base64url');
      const expired = await saveAdminPricing(actorA, { ...signedInput, operationId: randomUUID(), previewToken: `${expiredBody}.${expiredSignature}` }, tx);
      assert.equal(expired.state, 'rejected');
      assert.equal((await getAdminPricingSnapshot(actorA, tx)).revision, snapshot.revision);
      evidence.push('G18: signed preview binds actor, exact body, scope and output; tampering and a genuinely valid but expired signature cannot commit, without overriding the clock');

      const csv = await exportAdminPricingCsv(actorA, { channelId: 'volcengine_ark' }, tx);
      assert.ok(csv.includes("'=fixture,")); assert.ok(csv.includes('""source""'));
      assert.ok(!csv.includes('fixture-key-not-valid')); assert.ok(!csv.includes('fixture.invalid/api'));
      assert.ok(!csv.includes('credentialVersion')); assert.ok(!csv.includes('configFingerprint'));
      assert.ok(csv.includes(snapshot.revision)); assert.ok(csv.includes('UTC'));
      const history = await getAdminPricingHistory(actorA, { limit: 1 }, tx);
      assert.equal(history.entries.length, 1); assert.ok(history.nextCursor);
      const more = await getAdminPricingHistory(actorA, { cursor: history.nextCursor!, limit: 1 }, tx);
      assert.notEqual(more.entries[0].revisionId, history.entries[0].revisionId);
      const laterChannel = `image-${randomUUID()}`;
      await setting(tx, IMAGE_GENERATION_CHANNEL_REGISTRY_SETTING_KEY, { version: 1, channels: [{ id: laterChannel,
        label: 'Later isolated supplier', supplierName: 'Later isolated supplier', supplierKind: 'other', protocol: 'openai_images',
        baseUrl: 'https://fixture.invalid/later', enabled: false, deleted: false, modelCapabilities: {} }] });
      snapshot = await getAdminPricingSnapshot(actorA, tx);
      const laterRows = snapshot.rows.filter(row => row.identity.channelId === laterChannel);
      assert.ok(laterRows.length > 0);
      assert.ok(laterRows.every(row => row.currentUnitCredits === null && row.mode === 'unset'));
      const beforeRowB = snapshot.rows.find(row => row.id === rowB.id)!;
      const restored = await persist(tx, snapshot, { kind: 'restore', revisionId: baselineRevision, ruleIds: [rowA.id] });
      snapshot = restored.snapshot;
      assert.equal(snapshot.rows.find(row => row.id === rowA.id)!.mode, 'legacy_fixed');
      assert.deepEqual(snapshot.rows.find(row => row.id === rowB.id), beforeRowB);
      assert.notEqual(snapshot.revision, baselineRevision);
      assert.equal(snapshot.standards.site_base_cny, '1.2', 'unselected standard stays current');
      assert.deepEqual(snapshot.rows.filter(row => row.identity.channelId === laterChannel), laterRows);
      evidence.push('G08/G12/G20: injection-safe effective CSV, cursor history, selected legacy restore creates a new revision and retains unrelated rows plus a later supplier with no invented default price');

      const rowsBefore = await tx.platformSetting.findMany({ where: { key: { startsWith: PRICING_REVISION_PREFIX } }, orderBy: { key: 'asc' } });
      const draft = input(snapshot, { kind: 'save', changes: { rows: [{ id: rowA.id, mode: 'custom', customPointsPerCny: '2.1',
        base: { amount: '1', currency: 'CNY', unit: 'second', source: defined } }] } });
      const proof = await previewAdminPricing(actorA, draft, tx);
      await setting(tx, VOLCENGINE_IP_API_SETTING_KEY, { enabled: true, api_key: 'fixture-rotated-key',
        base_url: 'https://fixture.invalid/api/v3', default_model: rowA.identity.modelId });
      const changedSource = await saveAdminPricing(actorA, { ...draft, operationId: randomUUID(), previewToken: proof.previewToken }, tx);
      assert.equal(changedSource.state, 'rejected');
      await assert.rejects(() => resolvePricingCharge(rowA.identity, tx), 'adopted/restored scope must not silently fall back after key rotation');
      const refusal = await previewAdminPricing(actorA, input(await getAdminPricingSnapshot(actorA, tx),
        { kind: 'restore', revisionId: adoptedRevision, ruleIds: [rowA.id] }), tx);
      assert.equal(refusal.skipped[0].id, rowA.id); assert.equal(refusal.affectedRuleIds.length, 0);
      const rowsAfter = await tx.platformSetting.findMany({ where: { key: { startsWith: PRICING_REVISION_PREFIX } }, orderBy: { key: 'asc' } });
      assert.equal(pricingCanonical(rowsAfter), pricingCanonical(rowsBefore));
      evidence.push('G15/G18/G20: configuration rotation invalidates token/evidence; historical revisions remain immutable');

      for (const invalid of ['0', '-1', 'NaN', 'Infinity', '1e1', '0.11', '10000.1', '1'.repeat(33)]) {
        const fresh = await getAdminPricingSnapshot(actorA, tx);
        await assert.rejects(() => previewAdminPricing(actorA, input(fresh, { kind: 'save', changes: { standards: { site_base_cny: invalid }, rows: [] } }), tx));
      }
      const fresh = await getAdminPricingSnapshot(actorA, tx);
      await assert.rejects(() => previewAdminPricing(actorA, input(fresh, { kind: 'unify', basisKind: 'site_base_cny', ruleIds: [rowA.id, rowA.id] }), tx));
      await assert.rejects(() => previewAdminPricing(actorA, { ...input(fresh, { kind: 'save', changes: { rows: [] } }), extra: true } as PricingAdminPreviewInput, tx));
      await tx.user.update({ where: { id: actorB.id }, data: { role: 'user' } });
      await assert.rejects(() => getAdminPricingSnapshot(actorB, tx));
      await assert.rejects(() => getAdminPricingOperation(actorB, stale.operationId, tx));
      await assert.rejects(() => getAdminPricingHistory(actorB, {}, tx));
      await assert.rejects(() => exportAdminPricingCsv(actorB, {}, tx));
      evidence.push('G08/G21/G22: strict numeric/selection/unknown-field limits and fresh permission on every read');

      const source = await tx.platformSetting.findUniqueOrThrow({ where: { key: VOLCENGINE_IP_API_SETTING_KEY } });
      await tx.platformSetting.update({ where: { id: source.id }, data: { value_json: '{broken' } });
      await assert.rejects(() => getPricingCatalog(tx));
      await tx.platformSetting.update({ where: { id: source.id }, data: { value_json: source.value_json } });
      await setting(tx, IMAGE_STUDIO_SETTING_KEY, { context: '', model: 'gpt-image-2', revision: 0, prices: { 'gpt-image-2': -1 } });
      await assert.rejects(() => getPricingCatalog(tx));
      await tx.platformSetting.delete({ where: { key: IMAGE_STUDIO_SETTING_KEY } });
      await setting(tx, BANANA_IMAGE_API_SETTING_KEY, { enabled: false, api_key: null, base_url: 'https://fixture.invalid' });
      const policy = await tx.platformSetting.findUniqueOrThrow({ where: { key: PRICING_POLICY_KEY } });
      await tx.platformSetting.update({ where: { id: policy.id }, data: { value_json: '{}' } });
      await assert.rejects(() => getAdminPricingSnapshot(actorA, tx));
      assert.equal((await tx.platformSetting.findUniqueOrThrow({ where: { key: PRICING_POLICY_KEY } })).value_json, '{}');
      await tx.platformSetting.update({ where: { id: policy.id }, data: { value_json: policy.value_json } });
      assert.ok(await tx.platformSetting.count({ where: { key: { startsWith: PRICING_OPERATION_PREFIX } } }));
      evidence.push('G12/G21: malformed source/policy rejects instead of defaulting or overwriting');
      completed = true;
      throw rollback;
    }, { timeout: 120000, maxWait: 10000 });
  } catch (error) { if (error !== rollback) throw error; }
  assert.equal(completed, true);
  assert.equal(await fixture.user.count(), 0);
  assert.equal(await fixture.platformSetting.count(), 0);
  console.log(JSON.stringify({ schemaVersion: 1, fixture: 'pricing-admin-contract', evidence, rolledBack: true,
    exclusions: ['No provider requests', 'No browser or functional acceptance', 'Concurrency scheduler and live image writer belong to the unified core/legacy gates'] }));
}

run().finally(async () => {
  if (previousSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previousSecret;
  await fixture.$disconnect();
}).catch(error => { console.error(error); process.exitCode = 1; });
