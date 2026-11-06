import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { PricingAdminAction, PricingAdminPreviewInput, PricingAdminRowChange } from '@/lib/pricing/admin-contract';

async function run() {
  const supplied = process.env.PRICING_VIDEO_FIXTURE_DB;
  if (!supplied || !path.isAbsolute(supplied) || !path.basename(supplied).includes('pricing-video-fixture')) throw new Error('Explicit pricing-video-fixture DB required');
  const filename = fs.realpathSync(supplied), root = fs.realpathSync(process.cwd()), temporaryRoot = fs.realpathSync(os.tmpdir());
  if (!filename.startsWith(`${path.join(root, '.role-tests')}${path.sep}`) && !filename.startsWith(`${temporaryRoot}${path.sep}`)) throw new Error('Only an isolated .role-tests/temporary SQLite fixture DB is allowed');
  const fixture = new PrismaClient({ datasources: { db: { url: `file:${filename}` } } });
  const previous = { key: process.env.SEEDANCE_API_KEY, base: process.env.SEEDANCE_BASE_URL, secret: process.env.SESSION_SECRET };
  process.env.SEEDANCE_API_KEY = 'pricing-video-fixture-not-a-provider-credential';
  process.env.SEEDANCE_BASE_URL = 'https://fixture.invalid/video';
  process.env.SESSION_SECRET = 'pricing-video-fixture-signing-not-a-production-secret';
  const rolledBack = new Error('pricing-video-fixture-rollback');
  const evidence: string[] = [];
  let completed = false;
  try {
    if (await fixture.user.count() || await fixture.platformSetting.count()) throw new Error('Fixture DB must be empty and schema-initialized by the build controller');
    const { quoteVideoPricing, requireVideoPricingRevision, assertVideoPricingAcceptance, publicVideoPricing,
      publicVideoTaskPricing, videoPricingIdentity } = await import('@/lib/pricing/video');
    const { getAdminPricingSnapshot, previewAdminPricing, saveAdminPricing } = await import('@/lib/pricing/policy');
    const { frozenPricingCredits } = await import('@/lib/pricing/charge');
    const { calculateEstimatedCost, calculateH3EstimatedCost } = await import('@/lib/pricing');
    const { normalizeEnhanceVideoCreateBody, enhanceVideoSourcePricing } = await import('@/lib/tasks/enhance-video-create');
    const { validateRequestCostCeiling } = await import('@/lib/provider/seedance-video-edit');
    const { buildMultiviewGenerationRequest, defaultMultiviewGenerationDraft } = await import('@/lib/video/multiview-generation-contract');
    await fixture.$transaction(async tx => {
      const actor = await tx.user.create({ data: { name: 'Pricing fixture', username: randomUUID(), email: `${randomUUID()}@fixture.invalid`,
        password_hash: 'not-a-login-credential', role: 'admin', status: 'active' } });
      for (const [key, value] of [
        ['volcengine_ip_api_v1', { enabled: true, base_url: 'https://fixture.invalid/ip', api_key: 'fixture-key', default_model: 'doubao-seedance-2-5-260628' }],
        ['aimediakit_enhance_video_api_v1', { enabled: true, base_url: 'https://fixture.invalid/enhance', api_key: 'fixture-key' }],
        ['h3_video_api_v1', { enabled: true, base_url: 'http://127.0.0.1:8893', api_token: 'fixture-key', default_preset_id: 'lightx2v_4step_turbo',
          health: { api: 'ok', worker: 'ok', comfyui: 'ok', checked_at: new Date().toISOString() } }],
      ] as const) await tx.platformSetting.create({ data: { key, value_json: JSON.stringify(value) } });
      const normal = { provider: 'seedance' as const, model: 'dreamina-seedance-2-0-260128', resolution: '720p', duration: 5 };
      const scopedNormal = { ...normal, referenceVideo: 'none' as const, pricingPurpose: 'standard' as const };
      const ip = { provider: 'volcengine_ip' as const, model: 'doubao-seedance-2-5-260628', resolution: '1080p', duration: 5 };
      const h3 = { provider: 'h3' as const, model: 'lightx2v_4step_turbo', resolution: '480p', duration: 5 };
      const enhance = { provider: 'volcengine_mediakit' as const, model: 'enhance-video', resolution: '540p', duration: 2.2, toolVersion: 'professional', fps: 60 };
      const legacy = { identity: videoPricingIdentity(normal), quantity: '5', pricing: calculateEstimatedCost('720p', 5, normal.model), revision: null, charge: null };
      await assert.rejects(() => quoteVideoPricing(normal, tx), /人民币价格/);
      await assert.rejects(() => quoteVideoPricing(ip, tx), /人民币价格/);
      assert.deepEqual((await quoteVideoPricing(h3, tx)).pricing, calculateH3EstimatedCost(5, h3.model));
      await assert.rejects(() => quoteVideoPricing(enhance, tx), /人民币价格/);
      for (const resolution of ['240p', '360p', '480p', '540p']) assert.equal(videoPricingIdentity({ ...enhance, resolution }).specifications.resolution, '480p');
      for (const resolution of ['480p', '720p', '1080p', '2k', '4k']) for (const toolVersion of ['standard', 'professional']) for (const fps of [30, 60]) {
        await assert.rejects(() => quoteVideoPricing({ ...enhance, resolution, toolVersion, fps }, tx), /人民币价格/);
      }
      evidence.push('G11: new paid video/IP/enhancement quotes without RMB prices reject; only explicit free H3 survives. Historical pricing helpers and low-resolution identities remain unchanged.');
      let snapshot = await getAdminPricingSnapshot(actor, tx);
      const save = async (action: PricingAdminAction, modern = false) => {
        const input: PricingAdminPreviewInput = { expectedRevision: snapshot.revision, catalogFingerprint: snapshot.catalogFingerprint, action,
          ...(modern ? { expectedAuthoringRevision: snapshot.authoring!.revision } : {}) };
        const preview = await previewAdminPricing(actor, input, tx);
        const operation = await saveAdminPricing(actor, { ...input, operationId: randomUUID(), previewToken: preview.previewToken }, tx);
        assert.equal(operation.state, 'succeeded'); assert.ok(operation.snapshot); snapshot = operation.snapshot!;
      };
      const normalRow = snapshot.rows.find(row => row.identity.channelId === 'seedance' && row.identity.modelId === normal.model
        && row.identity.specifications.resolution === normal.resolution && row.identity.specifications.referenceVideo === 'none')!;
      const ipRow = snapshot.rows.find(row => row.identity.channelId === 'volcengine_ark' && row.identity.modelId === ip.model
        && row.identity.specifications.resolution === ip.resolution)!;
      const h3Row = snapshot.rows.find(row => row.identity.kind === 'h3' && row.identity.modelId === h3.model)!;
      const enhanceRow = snapshot.rows.find(row => row.identity.kind === 'enhance' && row.identity.specifications.resolution === '480p'
        && row.identity.specifications.toolVersion === 'professional' && row.identity.specifications.fpsTier === 'gt30')!;
      const source = { type: 'admin_defined' as const, reference: 'isolated engineering fixture', note: '' };
      const changes: PricingAdminRowChange[] = [normalRow, ipRow, enhanceRow].map(row => ({
        id: row.id, mode: 'follow', pricingEnabled: true, base: { currency: 'CNY', amount: '0.15', unit: 'second', source },
      }));
      changes.push({ id: h3Row.id, mode: 'custom', customPointsPerCny: '0.1', base: { currency: 'CNY', amount: '0.5', unit: 'second', source } });
      await save({ kind: 'save', changes: { standards: { site_base_cny: '1.0' }, rows: changes } });
      await assert.rejects(() => quoteVideoPricing(normal, tx), { status: 409, code: 'pricing_context_required' },
        'a precise policy rejects missing video context instead of falling back to the old quote');
      const current = await quoteVideoPricing(scopedNormal, tx);
      assert.deepEqual(current.identity.specifications, { resolution: normal.resolution, referenceVideo: 'none', pricingPurpose: 'standard' });
      assert.equal(current.pricing.estimatedCost, 0.8); assert.equal(current.revision, snapshot.revision);
      assert.equal((await quoteVideoPricing(ip, tx)).pricing.estimatedCost, 0.8);
      assert.equal((await quoteVideoPricing(h3, tx)).pricing.estimatedCost, 0.3);
      const monetaryEnhance = await quoteVideoPricing(enhance, tx);
      assert.equal(monetaryEnhance.pricing.estimatedCost, 0.3);
      assert.equal(monetaryEnhance.quantity, '2.2', 'Monetary enhancement uses measured duration independently of point rounding');
      assert.throws(() => requireVideoPricingRevision(current, undefined));
      assert.throws(() => requireVideoPricingRevision(current, 'old-revision'));
      await assertVideoPricingAcceptance(current, current.revision, tx);
      await assert.rejects(() => assertVideoPricingAcceptance(legacy, null, tx), 'legacy quote cannot cross adoption between quote and acceptance');
      assert.equal(validateRequestCostCeiling(0.8, 0.8), null);
      assert.equal(validateRequestCostCeiling(0.01, 0.01), null, 'old cent-level ceilings remain supported');
      assert.notEqual(validateRequestCostCeiling(0.001, 0.001), null);
      assert.notEqual(validateRequestCostCeiling(0.7, 0.8), null);
      evidence.push('G11/G13/G21: real policy adoption reaches all video charge types, tenth-point amounts and creation-boundary freshness; precise video policy rejects missing context while known no-reference standard scope remains quotable');
      const exposed = publicVideoPricing(current);
      assert.equal('pricingCharge' in exposed, false);
      assert.equal(JSON.stringify(exposed).includes('configFingerprint'), false);
      const task = { id: 'fixture-task', pricing_snapshot: JSON.stringify(current.pricing), prompt: 'unchanged' };
      const projected = publicVideoTaskPricing(task);
      assert.equal(JSON.stringify(projected).includes('configFingerprint'), false);
      assert.ok(task.pricing_snapshot.includes('configFingerprint'), 'projection must not modify frozen backend data');
      assert.equal(projected.prompt, task.prompt);
      const normalized = normalizeEnhanceVideoCreateBody({ source_task_id: 'fixture-source', resolution: '540p', duration: 5,
        tool_version: 'professional', pricing_revision: current.revision });
      assert.equal(normalized.pricingRevision, current.revision);
      const draft = { ...defaultMultiviewGenerationDraft('multiview-fixture'), projectId: 'fixture-project',
        mainImage: { assetId: 'fixture-asset', referenceImageId: 'fixture-reference' } };
      const request = buildMultiviewGenerationRequest(draft, { idempotencyKey: randomUUID(), maxEstimatedCost: 0.8, pricingRevision: current.revision });
      assert.equal(request.pricing_revision, current.revision); assert.equal(request.max_estimated_cost, 0.8);
      evidence.push('G11/G13: real enhance/multiview request contracts carry revisions; public projection excludes internal binding');
      assert.ok(current.charge);
      const frozen = JSON.stringify(current.charge);
      await save({ kind: 'save', changes: { rows: [{ id: normalRow.id, mode: 'custom', customPointsPerCny: '2.0' }] } });
      await assert.rejects(() => assertVideoPricingAcceptance(current, current.revision, tx));
      assert.equal(frozenPricingCredits(JSON.parse(frozen)).credits, 0.8, 'accepted snapshot keeps its original price');
      assert.equal((await quoteVideoPricing(scopedNormal, tx)).pricing.estimatedCost, 1.5);
      assert.deepEqual(calculateEstimatedCost('720p', 5, normal.model), legacy.pricing, 'synchronous legacy function remains unchanged');
      evidence.push('G13/G21: changed current revision rejects stale creation while the accepted frozen contract remains unchanged');
      const oldEnhance = (await quoteVideoPricing(enhance, tx)).charge!;
      assert.equal(oldEnhance.quantity, '2.2', 'New monetary contracts retain exact duration without an integer-rounding marker');
      const historicCeilEnhance = { ...oldEnhance, quantity: '3' };
      await assert.rejects(() => quoteVideoPricing({ ...enhance, fps: null, sourceFps: 60, sourceDuration: 2.2 }, tx),
        { code: 'pricing_scope_unmatched' }, 'New source facts must not bypass an unmatched partially adopted scope');
      const enhanceRows = snapshot.rows.filter(row => row.identity.kind === 'enhance');
      assert.equal(enhanceRows.length, 30, 'All five resolutions, two versions and three frame-rate tiers have independent identities');
      const perSecond: Record<string, string[]> = {
        standard: ['0.0125', '0.0125', '0.025', '0.05', '0.1'],
        professional: ['0.125', '0.125', '0.25', '0.5', '1'],
      };
      const { multiplyDecimal } = await import('@/lib/pricing/math');
      await save({ kind: 'save', changes: { rows: enhanceRows.map(row => {
        const specs = row.identity.specifications;
        const amount = multiplyDecimal([perSecond[specs.toolVersion][['480p', '720p', '1080p', '2k', '4k'].indexOf(specs.resolution)],
          specs.fpsTier === 'gt60' ? '4' : specs.fpsTier === 'gt30' ? '2' : '1']);
        return { id: row.id, mode: 'custom', pricingEnabled: true, customPointsPerCny: '100', rounding: 'half_up_integer',
          base: { currency: 'CNY', amount, unit: 'second', source: {
            type: 'admin_defined', reference: 'https://docs.volcengine.com/docs/intelligent-processing/video-tool-billing?lang=zh',
            note: 'Synthetic adoption of the public list, not an actual account bill',
          } } };
      }) } });
      const estimateInput = { ...enhance, resolution: '1080p', toolVersion: 'standard', fps: 30, duration: 2.2 };
      const exactEnhance = await quoteVideoPricing(estimateInput, tx);
      assert.equal(exactEnhance.quantity, '2.2');
      assert.equal(exactEnhance.pricing.duration, 2.2);
      assert.equal(exactEnhance.pricing.estimatedCost, 6, '2.2 seconds x 0.025 CNY x100 rounds once, not after each second');
      assert.equal((await quoteVideoPricing({ ...estimateInput, duration: 2.2004 }, tx)).pricing.estimatedCost, 6);
      assert.equal((await quoteVideoPricing({ ...estimateInput, fps: 60 }, tx)).pricing.estimatedCost, 11);
      assert.equal((await quoteVideoPricing({ ...estimateInput, fps: 61 }, tx)).pricing.estimatedCost, 22);
      assert.equal((await quoteVideoPricing({ ...estimateInput, fps: 120 }, tx)).pricing.estimatedCost, 22);
      const sourceFacts = enhanceVideoSourcePricing({ raw_status_response: JSON.stringify({ result: { fps: 30.168, duration: 2.2004 } }) });
      assert.deepEqual(sourceFacts, { sourceFps: 30.168, sourceDuration: 2.2004 });
      assert.equal((await quoteVideoPricing({ ...estimateInput, ...sourceFacts, fps: null, duration: 3 }, tx)).pricing.estimatedCost, 11,
        'No interpolation inherits the saved source FPS tier and precise duration without forcing output FPS');
      assert.equal((await quoteVideoPricing({ ...estimateInput, ...sourceFacts, fps: 30, duration: 3 }, tx)).pricing.estimatedCost, 6,
        'Explicit output FPS overrides source FPS, not the source duration');
      assert.deepEqual(enhanceVideoSourcePricing({ raw_status_response: '{' }), { sourceDuration: undefined, sourceFps: undefined });
      await assert.rejects(() => quoteVideoPricing({ ...estimateInput, fps: null }, tx), /帧率尚未确认/);
      assert.equal(frozenPricingCredits(oldEnhance).credits, 0.3, 'Adopting public RMB prices never recharges a prior frozen task');
      assert.equal(frozenPricingCredits(historicCeilEnhance).credits, 0.5, 'Historical ceil-second frozen contracts retain their original quantity');
      const preview = await previewAdminPricing(actor, { expectedRevision: snapshot.revision,
        catalogFingerprint: snapshot.catalogFingerprint, action: { kind: 'save', changes: { rows: [] } },
        scenarios: [{ rowId: exactEnhance.charge!.ruleId, quantity: '2.2' }] }, tx);
      assert.equal(preview.scenarios?.[0].currentCredits, '6', 'Admin preview and accepted task use the same metering');
      evidence.push('Public enhancement adoption: thirty scopes, millisecond estimates and final integer rounding agree with the admin preview; prior frozen contracts remain unchanged');
      await save({ kind: 'save', changes: { authoring: { globalPointsPerCny: '100' },
        rows: enhanceRows.map(row => ({ id: row.id, authoringRateMode: 'follow_global' })) } }, true);
      const scaledInput = { expectedRevision: snapshot.revision, expectedAuthoringRevision: snapshot.authoring!.revision,
        catalogFingerprint: snapshot.catalogFingerprint, action: { kind: 'save' as const, changes: {
          authoring: { globalPointsPerCny: '10' }, rows: [],
        } }, scenarios: [{ rowId: exactEnhance.charge!.ruleId, quantity: '2.2' }] };
      const scaledPreview = await previewAdminPricing(actor, scaledInput, tx);
      const scaledOperation = await saveAdminPricing(actor, { ...scaledInput, operationId: randomUUID(), previewToken: scaledPreview.previewToken }, tx);
      assert.equal(scaledOperation.state, 'succeeded'); snapshot = scaledOperation.snapshot!;
      const scaledEnhance = await quoteVideoPricing(estimateInput, tx);
      assert.equal(scaledEnhance.quantity, '2.2');
      assert.equal(scaledEnhance.pricing.estimatedCost, 0.6);
      assert.equal(scaledPreview.scenarios?.[0].adjustedCredits, '0.6');
      assert.equal((await quoteVideoPricing({ ...estimateInput, ...sourceFacts, fps: null, duration: 3 }, tx)).pricing.estimatedCost, 1.1);
      assert.equal(frozenPricingCredits(exactEnhance.charge!).credits, 6, 'Scaling future prices preserves accepted integer contracts');
      evidence.push('RATE-10 enhancement: preview and runtime keep millisecond duration and measured FPS at 10 points/CNY; original frozen integer and ceil-second contracts retain their prices');

      const { pricingCatalogRowId } = await import('@/lib/pricing/catalog');
      const { PRICING_POLICY_KEY, PRICING_REVISION_PREFIX } = await import('@/lib/pricing/admin-contract');
      const { assertPricingBaseRelation } = await import('@/lib/pricing/pricing-authoring');
      const policy = JSON.parse((await tx.platformSetting.findUniqueOrThrow({ where: { key: PRICING_POLICY_KEY } })).value_json);
      const oldGeneric = { ...policy.rules.find((row: { id: string }) => row.id === normalRow.id),
        identity: { ...normalRow.identity, specifications: {} }, mode: 'legacy_fixed', baseCny: null, source: null,
        customPointsPerCny: null, legacyUnitCredits: '3', legacyRounding: 'ceil_task' };
      oldGeneric.id = pricingCatalogRowId(oldGeneric.identity); delete oldGeneric.rounding;
      policy.rules.push(oldGeneric);
      const revisionKey = `${PRICING_REVISION_PREFIX}${policy.revision}`;
      const revision = JSON.parse((await tx.platformSetting.findUniqueOrThrow({ where: { key: revisionKey } })).value_json);
      revision.policy = policy;
      await tx.platformSetting.update({ where: { key: PRICING_POLICY_KEY }, data: { value_json: JSON.stringify(policy) } });
      await tx.platformSetting.update({ where: { key: revisionKey }, data: { value_json: JSON.stringify(revision) } });
      snapshot = await getAdminPricingSnapshot(actor, tx);
      await assert.rejects(() => quoteVideoPricing({ ...normal, referenceVideo: 'present', pricingPurpose: 'draft' }, tx), /人民币价格/,
        'A stored legacy fixed rule cannot price a new paid request');
      const parents = snapshot.rows.filter(row => row.identity.channelId === 'seedance'
        && row.identity.specifications.referenceVideo === 'none' && row.identity.specifications.pricingPurpose === 'standard');
      const aliases = snapshot.rows.filter(row => row.identity.kind === 'video' && Object.keys(row.identity.specifications).length === 1);
      assert.equal(parents.length, 6); assert.equal(aliases.length, 16);
      const parentFor = (row: typeof aliases[number]) => parents.find(parent => parent.identity.modelId ===
        (/seedance.*2[.\-]5/i.test(row.identity.modelId) ? 'dreamina-seedance-2-5-260628' : normal.model)
        && parent.identity.specifications.resolution === row.identity.specifications.resolution)!;
      await save({ kind: 'save', changes: { rows: [
        ...parents.map(row => ({ id: row.id, pricingEnabled: true, authoringRateMode: 'follow_global' as const,
          base: { currency: 'CNY' as const, amount: row.identity.modelId === normal.model ? '0.1' : '0.15', unit: 'second' as const, source } })),
        ...aliases.map(row => ({ id: row.id, pricingEnabled: true, authoringRateMode: 'follow_global' as const,
          baseRelation: { parentId: parentFor(row).id, factor: '1' as const } })),
        { id: oldGeneric.id, remove: true },
      ] } }, true);
      assert.equal(snapshot.rows.some(row => row.id === oldGeneric.id), false);
      const stored = JSON.parse((await tx.platformSetting.findUniqueOrThrow({ where: { key: PRICING_POLICY_KEY } })).value_json);
      assert.equal(stored.rules.some((row: { mode: string }) => row.mode === 'legacy_fixed'), false);
      for (const row of aliases) {
        for (const pricingPurpose of ['standard', 'draft', 'draft_upgrade'] as const) for (const referenceVideo of ['none', 'present'] as const) {
          const quote = await quoteVideoPricing({ provider: row.identity.channelId === 'seedance' ? 'seedance' : 'volcengine_ip',
            model: row.identity.modelId, resolution: row.identity.specifications.resolution, duration: 5, pricingPurpose, referenceVideo }, tx);
          assert.equal(quote.pricing.estimatedCost, /seedance.*2[.\-]5/i.test(row.identity.modelId) ? 7.5 : 5);
          assert.equal(quote.charge?.pointsPerCny, '10'); assert.equal(quote.charge?.mode, 'custom');
        }
      }
      const generation20 = parents.find(row => row.identity.modelId === normal.model && row.identity.specifications.resolution === '720p')!;
      const generation25 = parents.find(row => row.identity.modelId !== normal.model && row.identity.specifications.resolution === '720p')!;
      await save({ kind: 'save', changes: { rows: [{ id: generation25.id,
        baseRelation: { parentId: generation20.id, factor: '1.5' } }] } }, true);
      await save({ kind: 'save', changes: { rows: [{ id: generation20.id,
        base: { currency: 'CNY', amount: '0.2', unit: 'second', source } }] } }, true);
      for (const row of aliases.filter(row => row.identity.specifications.resolution === '720p')) {
        const currentRow = snapshot.rows.find(item => item.id === row.id)!;
        assert.equal(currentRow.baseCny, /seedance.*2[.\-]5/i.test(row.identity.modelId) ? '0.3' : '0.2');
        assert.equal(currentRow.authoringEntry?.baseRelation?.factor, '1');
      }
      assert.throws(() => assertPricingBaseRelation(generation20.identity, { ...ipRow.identity, modelId: 'unknown-model', specifications: { resolution: '720p' } }, '1'));
      assert.throws(() => assertPricingBaseRelation(generation20.identity, aliases[0].identity, '2'));
      const blocked = aliases.find(row => row.identity.channelId === 'seedance' && row.identity.modelId === normal.model && row.identity.specifications.resolution === '720p')!;
      await save({ kind: 'save', changes: { rows: [{ id: blocked.id, pricingEnabled: false }] } }, true);
      await assert.rejects(() => quoteVideoPricing({ ...normal, referenceVideo: 'present', pricingPurpose: 'draft' }, tx), /停用/);
      await assert.rejects(() => previewAdminPricing(actor, { expectedRevision: snapshot.revision,
        expectedAuthoringRevision: snapshot.authoring!.revision, catalogFingerprint: snapshot.catalogFingerprint,
        action: { kind: 'save', changes: { rows: [{ id: generation20.id, remove: true }] } } }, tx), /仅可移除/);
      assert.equal(frozenPricingCredits(exactEnhance.charge!).credits, 6);
      assert.equal(await tx.creditLedger.count(), 0); assert.equal(await tx.videoTask.count(), 0);
      evidence.push('RATE-VIDEO01: sixteen Seedance/IP scopes quote normal/draft/upgrade/reference modes at 10 points/CNY; 2.0 -> 2.5 -> IP/common propagation, off switches, restricted legacy retirement and frozen contracts verified with zero task/ledger/provider writes.');
      completed = true; throw rolledBack;
    }, { maxWait: 10000, timeout: 120000 });
  } catch (error) { if (error !== rolledBack) throw error; }
  finally {
    if (completed) { assert.equal(await fixture.user.count(), 0); assert.equal(await fixture.platformSetting.count(), 0); }
    for (const [key, value] of [['SEEDANCE_API_KEY', previous.key], ['SEEDANCE_BASE_URL', previous.base], ['SESSION_SECRET', previous.secret]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fixture.$disconnect();
  }
  assert.equal(completed, true);
  console.log(JSON.stringify({ schemaVersion: 1, fixture: 'pricing-video-contract', evidence, rolledBack: true,
    exclusions: ['No provider request or browser acceptance', 'Authenticated HTTP concurrency and real queue acceptance remain lead integration gates'] }));
}
run().catch(error => { console.error(error); process.exitCode = 1; });
