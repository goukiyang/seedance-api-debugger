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
    const { calculateEstimatedCost, calculateH3EstimatedCost, calculateEnhanceVideoEstimatedCost } = await import('@/lib/pricing');
    const { normalizeEnhanceVideoCreateBody } = await import('@/lib/tasks/enhance-video-create');
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
      const legacy = await quoteVideoPricing(normal, tx);
      assert.equal(legacy.charge, null); assert.equal(legacy.revision, null);
      assert.deepEqual(legacy.pricing, calculateEstimatedCost('720p', 5, normal.model));
      assert.deepEqual((await quoteVideoPricing(ip, tx)).pricing, calculateEstimatedCost('1080p', 5, ip.model));
      assert.deepEqual((await quoteVideoPricing(h3, tx)).pricing, calculateH3EstimatedCost(5, h3.model));
      assert.deepEqual((await quoteVideoPricing(enhance, tx)).pricing, calculateEnhanceVideoEstimatedCost(enhance));
      for (const resolution of ['240p', '360p', '480p', '540p']) assert.equal(videoPricingIdentity({ ...enhance, resolution }).specifications.resolution, '480p');
      for (const resolution of ['480p', '720p', '1080p', '2k', '4k']) for (const toolVersion of ['standard', 'professional']) for (const fps of [30, 60]) {
        const quote = await quoteVideoPricing({ ...enhance, resolution, toolVersion, fps }, tx);
        assert.equal(quote.pricing.estimatedCost, calculateEnhanceVideoEstimatedCost({ ...enhance, resolution, toolVersion, fps }).estimatedCost);
      }
      evidence.push('G11: real helper preserves normal/IP/H3 legacy formulas and every enhancement price group; low resolutions retain their original group');
      let snapshot = await getAdminPricingSnapshot(actor, tx);
      const save = async (action: PricingAdminAction) => {
        const input: PricingAdminPreviewInput = { expectedRevision: snapshot.revision, catalogFingerprint: snapshot.catalogFingerprint, action };
        const preview = await previewAdminPricing(actor, input, tx);
        const operation = await saveAdminPricing(actor, { ...input, operationId: randomUUID(), previewToken: preview.previewToken }, tx);
        assert.equal(operation.state, 'succeeded'); assert.ok(operation.snapshot); snapshot = operation.snapshot!;
      };
      const normalRow = snapshot.rows.find(row => row.identity.channelId === 'seedance' && row.identity.modelId === normal.model)!;
      const ipRow = snapshot.rows.find(row => row.identity.channelId === 'volcengine_ark' && row.identity.modelId === ip.model)!;
      const h3Row = snapshot.rows.find(row => row.identity.kind === 'h3' && row.identity.modelId === h3.model)!;
      const enhanceRow = snapshot.rows.find(row => row.identity.kind === 'enhance' && row.identity.specifications.resolution === '480p'
        && row.identity.specifications.toolVersion === 'professional' && row.identity.specifications.fpsTier === 'gt30')!;
      const source = { type: 'admin_defined' as const, reference: 'isolated engineering fixture', note: '' };
      const changes: PricingAdminRowChange[] = [normalRow, ipRow, enhanceRow].map(row => ({
        id: row.id, mode: 'follow', base: { currency: 'CNY', amount: '0.15', unit: 'second', source },
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
      assert.equal((await quoteVideoPricing(enhance, tx)).pricing.estimatedCost, 0.5);
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
