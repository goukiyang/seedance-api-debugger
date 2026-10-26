import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { frozenPricingCredits, type FrozenPricingCharge } from '../src/lib/pricing/frozen-charge';
import { sumCredits } from '../src/lib/credits/precision';
import * as quality from '../src/lib/image-studio/quality-routing';

const sources = ['src/lib/image-studio/quality-routing.ts', 'src/lib/integrations/image-generation-defaults.ts',
  'src/lib/integrations/image-generation-channel.ts', 'src/lib/integrations/image-generation.ts',
  'src/lib/integrations/image-quality-routing.ts', 'src/lib/image-studio/tasks.ts', 'src/lib/image-studio/batches.ts',
  'src/lib/image-studio/batch-billing-quote.ts', 'src/lib/image-studio/billing-quote-store.ts',
  'src/lib/pricing/runtime.ts', 'src/lib/pricing/build-mode.ts', 'src/lib/pricing/frozen-charge.ts',
  'src/app/api/admin/integrations/image-generation/route.ts', 'scripts/activate-image25-quality-routing.ts'];
const checks = ['strict_versioned_reader', 'two_quality_routes_reject_channel_override', 'quote_route_revision_frozen',
  'legacy_parent_source_contract_preserved', 'actual_total_reference_count_seven', 'medium_half_point_not_ceil',
  'atomic_activation_source_cas_and_original_receipt', 'guard_reader_and_runtime_capability'];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function main() {
  const root = realpathSync(process.cwd()), startedAt = new Date().toISOString();
  const runId = process.env.IMAGE_RECOVERY_GATE_RUN_ID;
  assert.match(runId || '', /^[a-f0-9-]{36}$/i);
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
  const sourceSha256 = Object.fromEntries(sources.map(file => [file, hash(read(file))]));
  const model = quality.IMAGE_25_QUALITY_MODEL;
  const medium = 'image-11111111-1111-4111-8111-111111111111', max = 'image-22222222-2222-4222-8222-222222222222';
  const legacy = { version: 1, revision: 9, models: { [model]: max, 'gpt-image-2': 'shared' } };
  let value = JSON.stringify(legacy), reads = 0;
  const client = { platformSetting: { findUnique: async () => { reads++; return { value_json: value }; } } };
  const modules: Record<string, unknown> = {
    '@/lib/prisma': { prisma: client }, '@/lib/image-studio/model-catalog': { IMAGE_STUDIO_MODELS: [model, 'gpt-image-2'] },
    '@/lib/image-studio/quality-routing': quality,
  };
  const exports: Record<string, Function> = {};
  const compiled = ts.transpileModule(read('src/lib/integrations/image-generation-defaults.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, { exports, require: (name: string) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency ${name}`); return modules[name];
  } }, { timeout: 1000 });
  const parse = exports.parseImageGenerationDefaultRoutes, serialize = exports.serializeImageGenerationDefaultRoutes;
  assert.equal(JSON.stringify(parse(value).models), JSON.stringify(legacy.models));
  for (const malformed of ['{}', '{', JSON.stringify({ ...legacy, qualityRoutes: {} }), JSON.stringify({ ...legacy, version: 3 })]) assert.throws(() => parse(malformed));
  const routes = { ...legacy, version: 2, qualityRoutes: { [model]: { medium, max } } };
  value = JSON.stringify(routes);
  assert.equal(JSON.parse(serialize(parse(value))).version, 2);
  assert.equal(JSON.stringify(parse(value).models), JSON.stringify(legacy.models));
  const resolve = exports.resolveImageGenerationRequestRoute;
  const resolved = await resolve(model, 'medium', 'original', client);
  assert.equal(resolved.channelId, medium); assert.equal(resolved.qualityRoute.revision, 9);
  assert.equal((await resolve(model, 'max', max, client)).channelId, max);
  await assert.rejects(resolve(model, 'medium', max, client));
  await assert.rejects(resolve(model, 'max', medium, client));
  for (const retained of ['auto', 'low', 'high', 'xhigh', undefined]) await assert.rejects(resolve(model, retained, 'original', client));
  assert.equal((await resolve('gpt-image-2', 'high', 'shared', client)).channelId, 'shared');
  assert.ok(reads > 0);

  const channel = { channelId: medium, configRevision: '11111111-1111-4111-8111-111111111111', qualityRoute: resolved.qualityRoute };
  assert.ok(quality.parseImageQualityRouteSnapshot(channel.qualityRoute));
  assert.equal(quality.parseImageQualityRouteSnapshot({ ...channel.qualityRoute, quality: 'auto' }), null);
  value = JSON.stringify({ ...routes, revision: 10 });
  const fresh = await resolve(model, 'medium', 'original', client);
  assert.notEqual(JSON.stringify(channel.qualityRoute), JSON.stringify(fresh.qualityRoute));
  assert.notEqual(hash(JSON.stringify(channel)), hash(JSON.stringify({ ...channel, qualityRoute: fresh.qualityRoute })));
  assert.match(read('src/lib/image-studio/billing-quote-store.ts'), /sameQualityRoute/);
  assert.match(read('src/lib/integrations/image-generation.ts'), /route\.qualityRoute\?\.revision !== snapshot\.qualityRoute\.revision/);
  const tasks = read('src/lib/image-studio/tasks.ts');
  assert.match(tasks, /acceptedContract && input\.imageChannel/);
  assert.match(tasks, /resolveImageGenerationChannelSnapshot\(imageChannel, tx, !acceptedContract/);
  assert.match(tasks, /IMAGE_25_QUALITY_MODEL && !acceptedContract/);
  assert.doesNotThrow(() => quality.assertImageQualityReferenceCount(undefined, 10));
  assert.doesNotThrow(() => quality.assertImageQualityReferenceCount(resolved.qualityRoute, 7));
  assert.throws(() => quality.assertImageQualityReferenceCount(resolved.qualityRoute, 8));
  assert.doesNotThrow(() => quality.assertImageQualityReferenceCount({ ...resolved.qualityRoute, quality: 'max' }, 10));
  assert.match(tasks, /assertImageQualityReferenceCount\(qualityRoute\?\.qualityRoute, orderedReferenceIds\.length\)/);
  const charge: FrozenPricingCharge = { schema: 'pricing-charge-v1', revision: 'synthetic', ruleId: 'synthetic',
    identity: { kind: 'image', channelId: medium, modelId: model, billingMode: 'fixed', unit: 'image', specifications: {} },
    binding: { configRevision: 'synthetic', billingPrincipalId: null, credentialVersion: 'synthetic', configFingerprint: 'synthetic' },
    basisKind: 'site_base_cny', mode: 'follow', baseCny: '0.05', pointsPerCny: '10', exchangeRate: null,
    legacyUnitCredits: null, legacyRounding: null, quantity: '1', issuedAt: startedAt, rounding: 'half_up_tenth' };
  assert.equal(frozenPricingCredits(charge).credits, 0.5);
  assert.equal(sumCredits(Array.from({ length: 3 }, () => frozenPricingCredits(charge).credits)), 1.5);
  assert.equal(sumCredits(Array.from({ length: 10 }, () => frozenPricingCredits(charge).credits)), 5);
  assert.equal(frozenPricingCredits({ ...charge, pointsPerCny: '20' }).credits, 1);
  assert.equal(frozenPricingCredits({ ...charge, mode: 'legacy_fixed', legacyUnitCredits: '5' }).credits, 5);
  const activation = read('src/lib/integrations/image-quality-routing.ts');
  for (const fragment of ['expectedStateFingerprint', 'expectedMediumRevision', 'expectedMaxRevision', 'maxFingerprint',
    'readImageQualityOperation', 'saveAdminPricing', 'persistImageQualityChannelUpdate', 'swapRoutes', 'writeReceipt']) assert.ok(activation.includes(fragment));
  assert.match(activation, /saveAdminPricing\([\s\S]*?previewToken: plan\.previewToken \}, tx\)/);
  assert.match(activation, /where: \{ key: IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY, value_json: old \}/);
  assert.doesNotMatch(activation, /\$executeRaw|\$queryRaw|api_key:\s*['"]/);
  assert.match(activation, /if \(writing && !PRICING_ADMIN_WRITES_ENABLED\)/);
  const runtime = read('src/lib/pricing/runtime.ts');
  assert.ok(runtime.includes('image-spec-v1:image-quality-route-v1'));
  assert.ok(runtime.includes('src/lib/integrations/image-quality-routing.ts'));
  assert.match(runtime, /src\/lib\/image-studio/);
  for (const file of sources) assert.equal(hash(read(file)), sourceSha256[file]);
  const scratch = path.join(root, '.role-tests'); mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'image-quality-routing-'));
  const receipt = path.join(directory, 'receipt.json');
  writeFileSync(receipt, JSON.stringify({ schema: 'image-quality-routing-engineering.v1', synthetic: true, runId, startedAt,
    finishedAt: new Date().toISOString(), completed: true, checks, fixtureSha256: hash(read('scripts/image-quality-routing-engineering.ts')),
    sourceSha256, forbiddenCalls: 0, productionWrites: 0, paidRequests: 0, browserRuns: 0,
    evidenceKinds: ['actual_pure_reader_and_resolver', 'actual_decimal_charge', 'source_contract_for_integration_and_cas'],
    limitations: 'No production configuration, process barrier, provider, browser or end-to-end generation acceptance' }), { flag: 'wx', mode: 0o600 });
  console.log(`Image quality routing engineering receipt: ${receipt}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
