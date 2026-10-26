import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import type { Prisma } from '@prisma/client';
import { DEFAULT_IMAGE_GENERATION_API_SETTINGS, imageGenerationModelOutputSize, type ImageGenerationResolvedSettings } from '@/lib/integrations/image-generation';
import { fixedImageBillingContract, imageSpecification } from '@/lib/image-studio/billing-quote';
import { parseImageBillingContract } from '@/lib/image-studio/billing-contract';
import { pricingImageIdentity, samePricingImageCharge, withImagePricing } from '@/lib/pricing/image';
import { imagePricingSpecificationsRequired } from '@/lib/pricing/image-option-contract';
import { normalizePricingImageSpecifications } from '@/lib/pricing/pricing-authoring-contract';
import { selectPricingRule } from '@/lib/pricing/resolve';
import { frozenPricingCredits, type FrozenPricingCharge } from '@/lib/pricing/frozen-charge';
import type { PricingAdminIdentity } from '@/lib/pricing/admin-contract';
import { imageStudioChannelIssue, imageStudioChannelReadyForModel, imageStudioChannelUnitCredits,
  imageStudioEffectiveChannelId, normalizeImageStudioChannels } from '@/lib/image-studio/channels';
import { creditCents, normalizeCredits } from '@/lib/credits/precision';
import { validVideoPricingAmount } from '@/lib/pricing-client';
import type { CanvasImageModelOption } from '@/lib/pricing/image-option-contract';
import { resolveStudioAspectRatio } from '@/lib/image-studio/ratios';
import { normalizeImageResolution } from '@/lib/image-generation/resolution';

type ImageQuoteUi = Pick<typeof import('../src/app/image-studio/use-studio-batch'),
  'formatImageUiCredits' | 'imageUiQuotePriceText' | 'validImageUiQuote' | 'imageUiQuoteAction' | 'imageUiQuoteFields'>;
type CanvasPricingConsumers = {
  validModelOption(value: unknown): boolean;
  fullQuoteRequired(value: unknown): boolean;
  validFullQuote(value: unknown, projection: unknown, now: number): boolean;
  validImageProjection(value: unknown, payload: { project_id: string; model: string; count: number }, expectedChannelId: string | undefined, now: number): boolean;
  modelMenuState(options: Array<{ value: string; label: string }>, values: unknown, model: string, count: number): {
    valid: boolean; rows: Array<{ disabled: boolean; detail: string }>;
  };
};

function loadUiFunctions(file: string, names: string[], dependencies: Record<string, unknown>) {
  const filename = resolve(file), source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = source.statements.filter(statement => ts.isFunctionDeclaration(statement) && statement.name
    && names.includes(statement.name.text) && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
  assert.equal(functions.length, names.length, 'Consumer fixture requires the actual exported functions');
  const compiled = ts.transpileModule(functions.map(statement => statement.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, ...dependencies }, { filename, timeout: 1000 });
  return exports;
}

function imageConsumerAssertions(equal: (actual: unknown, expected: unknown) => void) {
  const ui = loadUiFunctions('src/app/image-studio/use-studio-batch.tsx',
    ['formatImageUiCredits', 'imageUiQuotePriceText', 'validImageUiQuote', 'imageUiQuoteAction', 'imageUiQuoteFields'],
    { validVideoPricingAmount, creditCents, normalizeCredits, Date }) as ImageQuoteUi;
  const { avatarPlanChannelMatches } = loadUiFunctions('src/app/tools/avatar-studio/studio.tsx', ['avatarPlanChannelMatches'],
    { imageStudioEffectiveChannelId }) as Pick<typeof import('../src/app/tools/avatar-studio/studio'), 'avatarPlanChannelMatches'>;
  const window: { UltimateCanvasNodePricing?: CanvasPricingConsumers } = {};
  const nodePricingFile = resolve('public/tools/ultimate-canvas/node-pricing.js');
  vm.runInNewContext(readFileSync(nodePricingFile, 'utf8'), { window, Date }, { filename: nodePricingFile, timeout: 1000 });
  assert.ok(window.UltimateCanvasNodePricing);
  const nodePricing = window.UltimateCanvasNodePricing;
  const model = 'gpt-image-2', channelId = 'image-12345678-1234-4123-8123-123456789abc';
  const rawCapability = { ready: true, disabledReason: null, billingMode: 'fixed', fixedPoints: 20,
    billingSource: 'fixture', actualQuoteRequired: false, pricingBySpecification: true,
    qualities: ['auto', 'high'], resolutions: ['1K', '2K', '4K'], ratios: ['auto', '1:1', '3:2'], maxReferences: 9 };
  const channelData = { label: 'fixture', supplierName: null, ready: true, enabled: true, configured: true,
    disabledReason: null, models: { [model]: rawCapability } };
  const channels = normalizeImageStudioChannels({ items: [{ ...channelData, id: 'original' }, { ...channelData, id: channelId }],
    defaultRoutes: { revision: 1, models: { [model]: channelId } } });
  const channel = channels.items.find(item => item.id === channelId)!, capability = channel.models[model]!;
  equal(capability.pricingBySpecification, true); equal(capability.fixedPoints, null);
  equal(imageStudioChannelUnitCredits(capability, false, channelId, 20), null);
  equal(imageStudioChannelUnitCredits(capability, true, 'original', 20), null);
  equal(imageStudioChannelReadyForModel(channel, model), true);
  const choices = { quality: 'auto', resolution: '2K', ratio: 'auto', referenceCount: 1, legacyRoute: false };
  equal(imageStudioChannelIssue(channel, model, choices), null);
  equal(imageStudioChannelIssue({ ...channel, enabled: false }, model, choices) !== null, true);
  equal(imageStudioChannelIssue({ ...channel, configured: false }, model, choices) !== null, true);
  equal(imageStudioChannelIssue(channel, model, { ...choices, resolution: '0.5K' }) !== null, true);
  equal(imageStudioChannelIssue(channel, model, { ...choices, quality: 'low' }) !== null, true);
  equal(imageStudioChannelIssue(channel, model, { ...choices, referenceCount: 10 }) !== null, true);
  equal(imageStudioChannelReadyForModel({ ...channel, models: { [model]: { ...capability, ready: false } } }, model), false);
  equal(imageStudioChannelUnitCredits({ ...capability, pricingBySpecification: false, fixedPoints: 0 }, false, channelId, 20), 0);
  equal(imageStudioChannelReadyForModel({ ...channel, models: { [model]: { ...capability, pricingBySpecification: false } } }, model), false);
  equal(avatarPlanChannelMatches({ model, channelId: 'original', imageChannel: { channelId, configRevision: 'fixture' } }, channels, 'original'), true);
  equal(avatarPlanChannelMatches({ model, channelId, imageChannel: { channelId, configRevision: 'fixture' } }, channels, 'original'), false);
  equal(avatarPlanChannelMatches({ model, channelId: 'original', imageChannel: { channelId: 'shared', configRevision: 'fixture' } }, channels, 'original'), false);
  equal(avatarPlanChannelMatches({ model, channelId: 'original' }, channels, 'original'), false);

  const now = Date.now(), expiry = new Date(now + 60000).toISOString();
  const projection: CanvasImageModelOption = { model, label: 'fixture', status: 'estimate', reason: null, reasonText: null,
    unitCredits: null, estimatedCredits: null, count: 3, chargeEnabled: false, billingMode: 'fixed', actualQuoteRequired: false,
    estimateSource: 'channel_contract', creditPrecision: 0.1, pricingQuoteRequired: true, pricingBySpecification: true };
  equal(nodePricing.validModelOption(projection), true);
  equal(nodePricing.fullQuoteRequired(projection), true);
  equal(nodePricing.validModelOption({ ...projection, unitCredits: 0, estimatedCredits: 0 }), false);
  equal(nodePricing.validModelOption({ ...projection, pricingQuoteRequired: false }), false);
  equal(nodePricing.validModelOption({ ...projection, pricingBySpecification: 'true' }), false);
  const actualProjection = { ...projection, billingMode: 'actual', actualQuoteRequired: true };
  equal(nodePricing.validModelOption(actualProjection), true);
  const menu = nodePricing.modelMenuState([{ value: model, label: 'fixture' }], [projection], model, 3);
  equal(menu.valid, true); equal(menu.rows[0].disabled, false); equal(menu.rows[0].detail, '按规格计费');
  const unavailable = { ...projection, status: 'unavailable', reason: 'disabled', reasonText: 'disabled', pricingBySpecification: false,
    pricingQuoteRequired: false };
  equal(nodePricing.modelMenuState([{ value: model, label: 'fixture' }], [unavailable], model, 3).rows[0].disabled, true);
  const projected = { ...projection, revision: 0, kind: 'image', projectId: 'fixture-project', channelId: 'original',
    expiresAt: expiry, modelOptions: [projection] };
  equal(nodePricing.validImageProjection(projected, { project_id: 'fixture-project', model, count: 3 }, undefined, now), true);
  equal(nodePricing.validImageProjection(projected, { project_id: 'another-project', model, count: 3 }, undefined, now), false);
  const ratio = resolveStudioAspectRatio('auto', { width: 1536, height: 1024 }, true, true);
  equal(ratio.requested, 'auto'); equal(ratio.resolved, '3:2'); equal(ratio.source, 'reference');
  const resolution = normalizeImageResolution(model, '1K', 'ai_media_vip');
  const outputSettings = { ...DEFAULT_IMAGE_GENERATION_API_SETTINGS, provider: 'ai_media_vip' as const };
  const outputSize = imageGenerationModelOutputSize(outputSettings, model, resolution, ratio.resolved);
  equal(outputSize, '1248x832');
  equal(imageGenerationModelOutputSize(outputSettings, model, '2K', ratio.resolved), '2496x1664');
  const v2Snapshot = { ratioContractVersion: 2 as const, quality: 'auto', resolution,
    aspectRatio: ratio.requested, resolvedAspectRatio: ratio.resolved, outputSize, resolvedOutputSize: outputSize };
  equal(v2Snapshot.ratioContractVersion, 2);
  const specification = imageSpecification({ model, quality: v2Snapshot.quality, outputSize: v2Snapshot.outputSize,
    aspectRatio: v2Snapshot.resolvedAspectRatio, referenceCount: 1, inputCharacters: 64 });
  const originalContract = fixedImageBillingContract({ scope: 'a'.repeat(64), model, credits: 0.15, specification });
  equal(parseImageBillingContract(JSON.stringify(originalContract))?.specification, specification);
  equal(specification === imageSpecification({ model, quality: v2Snapshot.quality, outputSize: v2Snapshot.outputSize,
    aspectRatio: 'auto', referenceCount: 1, inputCharacters: 64 }), false);
  const quote = { billingMode: 'fixed' as const, billingQuoteId: 'fixture-quote', pricingRevision: 'fixture-price-r1',
    creditPrecision: 0.1, unitCredits: 0.2, estimatedCredits: 0.6, revision: 0, expiresAt: expiry,
    ratioContractVersion: v2Snapshot.ratioContractVersion };
  equal(nodePricing.validFullQuote(quote, projected, now), true);
  equal(nodePricing.validFullQuote({ ...quote, billingMode: 'actual', actualChargeEnabled: false },
    { ...projected, ...actualProjection }, now), false);
  equal(nodePricing.validFullQuote({ ...quote, billingMode: 'actual', actualChargeEnabled: true },
    { ...projected, ...actualProjection }, now), true);
  equal(nodePricing.validFullQuote({ ...quote, estimatedCredits: null }, projected, now), false);
  equal(nodePricing.validFullQuote(quote, projected, now + 60001), false);
  equal(ui.validImageUiQuote(quote, now), true);
  equal(ui.validImageUiQuote({ ...quote, billingQuoteId: null }, now), false);
  equal(ui.imageUiQuotePriceText(quote), '本次扣 0.6 点');
  equal(ui.imageUiQuotePriceText({ ...quote, billingMode: 'actual', estimatedCredits: 1.2 }), '最多预留 1.2 点，按账单结算');
  equal(ui.imageUiQuotePriceText({ ...quote, estimatedCredits: 0 }), '本次扣 0 点');
  equal(ui.imageUiQuotePriceText({ ...quote, estimatedCredits: NaN }), '费用待报价');
  equal(ui.imageUiQuoteAction('original-request', '2K', '1K', quote, now), 'query');
  equal(ui.imageUiQuoteAction(null, '2K', '1K', quote, now), 'quote');
  equal(ui.imageUiQuoteAction(null, '2K', '2K', quote, now), 'submit');
  const fields = ui.imageUiQuoteFields(quote);
  if (!('billingQuoteId' in fields) || !('maxEstimatedCost' in fields)) {
    assert.fail('A single-image quote must carry its billing quote ID and authorized cost ceiling');
  }
  equal(fields.billingQuoteId, quote.billingQuoteId); equal(fields.maxEstimatedCost, 0.6);
  equal(fields.pricingRevision, quote.pricingRevision);
}

// No database, provider, worker marker or wallet setup is fabricated by this fixture.
export async function runPricingImageSpecContractFixture() {
  let assertions = 0;
  const equal = (actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected); assertions++; };
  const noReads = new Proxy({} as Prisma.TransactionClient, {
    get() { throw new Error('Image specification pure fixture must not access storage'); },
  });
  const model = 'gpt-image-2';
  const settings: ImageGenerationResolvedSettings = { ...DEFAULT_IMAGE_GENERATION_API_SETTINGS,
    enabled: true, provider: 'ai_media_vip', default_model: model, api_key: null,
    channelId: 'shared', configRevision: 'fixture-config', supplierName: 'fixture', supplierKind: 'legacy',
    protocol: 'openai_images', managedChannel: false, modelCapabilities: {} };
  const identity = (specifications: { quality?: string; resolution?: string; ratio?: string } = {}) =>
    pricingImageIdentity(settings, model, noReads, specifications);
  const unknown = await identity();
  equal(unknown.specifications, {});
  equal(normalizePricingImageSpecifications({ resolution: '2k', ratio: 'auto', quality: 'auto' }),
    { quality: 'auto', resolution: '2K', ratio: 'auto' });
  equal(normalizePricingImageSpecifications({ resolution: '', ratio: undefined }), {});
  assert.throws(() => normalizePricingImageSpecifications({ quality: 'not a quality' })); assertions++;

  const base: PricingAdminIdentity = { ...unknown, specifications: {} };
  const rules = [{ id: 'wide', identity: base },
    { id: '1k-auto', identity: await identity({ quality: 'auto', resolution: '1K' }) },
    { id: '2k-auto', identity: await identity({ quality: 'auto', resolution: '2K' }) },
    { id: '2k-high', identity: await identity({ quality: 'high', resolution: '2K' }) },
    { id: '4k-auto', identity: await identity({ quality: 'auto', resolution: '4K' }) },
    { id: '2k-auto-ratio', identity: await identity({ quality: 'auto', resolution: '2K', ratio: 'auto' }) }];
  for (const resolution of ['1K', '2K', '4K']) {
    equal(selectPricingRule(rules, await identity({ quality: 'auto', resolution, ratio: '1:1' }))?.id,
      `${resolution.toLowerCase()}-auto`);
  }
  equal(selectPricingRule(rules, await identity({ quality: 'high', resolution: '2K', ratio: '1:1' }))?.id, '2k-high');
  equal(selectPricingRule(rules, await identity({ quality: 'auto', resolution: '2K', ratio: 'auto' }))?.id, '2k-auto-ratio');
  equal(selectPricingRule(rules, unknown)?.id, 'wide');
  const scoped = rules.filter(rule => rule.id !== 'wide');
  equal(selectPricingRule(scoped, unknown), null);
  equal(selectPricingRule(scoped, await identity({ resolution: '2K' })), null);
  equal(selectPricingRule(scoped, await identity({ quality: 'low', resolution: '2K' })), null);
  equal(selectPricingRule(scoped, await identity({ quality: 'auto', resolution: '1K', ratio: 'auto' }))?.id, '1k-auto');
  equal(imagePricingSpecificationsRequired(unknown, scoped.map(rule => rule.identity)), true);
  equal(imagePricingSpecificationsRequired(await identity({ resolution: '2K' }), scoped.map(rule => rule.identity)), true);
  equal(imagePricingSpecificationsRequired(await identity({ quality: 'auto', resolution: '2K', ratio: 'auto' }),
    scoped.map(rule => rule.identity)), false);
  equal(imagePricingSpecificationsRequired(await identity({ quality: 'low', resolution: '2K' }),
    scoped.map(rule => rule.identity)), false);
  equal(imagePricingSpecificationsRequired({ ...unknown, channelId: 'banana' }, scoped.map(rule => rule.identity)), false);
  equal(imagePricingSpecificationsRequired({ ...unknown, billingMode: 'actual' }, scoped.map(rule => rule.identity)), false);

  const frozen: FrozenPricingCharge = { schema: 'pricing-charge-v1', revision: 'fixture-price-r1', ruleId: '2k-auto-ratio',
    identity: await identity({ quality: 'auto', resolution: '2K', ratio: 'auto' }),
    binding: { configRevision: 'fixture-config', billingPrincipalId: null, credentialVersion: 'fixture-credential',
      configFingerprint: 'fixture-fingerprint' }, basisKind: 'site_base_cny', mode: 'custom',
    baseCny: '0.15', pointsPerCny: '1', exchangeRate: null, legacyUnitCredits: null, legacyRounding: null,
    quantity: '1', issuedAt: '2026-10-19T00:00:00.000Z', rounding: 'half_up_tenth' };
  equal(samePricingImageCharge(frozen, { ...frozen, issuedAt: '2026-10-19T00:01:00.000Z' }), true);
  equal(samePricingImageCharge(frozen, { ...frozen, identity: await identity({ quality: 'auto', resolution: '4K', ratio: 'auto' }) }), false);
  equal(samePricingImageCharge(frozen, { ...frozen, identity: await identity({ quality: 'high', resolution: '2K', ratio: 'auto' }) }), false);
  equal(samePricingImageCharge(frozen, { ...frozen, identity: await identity({ quality: 'auto', resolution: '2K', ratio: '1:1' }) }), false);
  equal(samePricingImageCharge(frozen, { ...frozen, identity: unknown }), false);
  equal(samePricingImageCharge(frozen, { ...frozen, ruleId: 'another-rule' }), false);
  equal(samePricingImageCharge(frozen, { ...frozen, binding: { ...frozen.binding, credentialVersion: 'changed' } }), false);
  equal(samePricingImageCharge(frozen, { ...frozen, pointsPerCny: '2' }), false);
  equal(samePricingImageCharge(undefined, frozen), false);
  equal(samePricingImageCharge(undefined, undefined), true);
  equal(frozenPricingCredits(frozen).credits, 0.2);
  equal([frozen, frozen, frozen].reduce((cents, charge) => cents + Math.round(frozenPricingCredits(charge).credits * 100), 0), 60);

  // Old accepted contracts are not augmented or repriced with today's requested specs.
  const legacy = fixedImageBillingContract({ scope: 'a'.repeat(64), model, credits: 0.15, specification: 'b'.repeat(64) });
  const legacyBefore = JSON.stringify(legacy);
  const accepted = await withImagePricing(settings, model, noReads, legacy, { resolution: '4K', quality: 'high', ratio: 'auto' });
  equal(accepted.quote, null); equal(accepted.settings, settings); equal(JSON.stringify(legacy), legacyBefore);
  const oldPricing = { ...frozen, identity: unknown, mode: 'legacy_fixed' as const, rounding: 'legacy' as const,
    baseCny: null, pointsPerCny: null, legacyUnitCredits: '0.15', legacyRounding: 'fixed_unit' as const };
  const oldContract = { ...legacy, version: 'pricing-image-v1' as const, rounding: 'half_up_tenth' as const, pricing: oldPricing };
  equal(parseImageBillingContract(JSON.stringify(oldContract))?.pricing?.identity.specifications, {});
  equal(frozenPricingCredits(oldPricing).credits, 0.15);
  equal(oldPricing.identity.specifications, {});
  imageConsumerAssertions(equal);

  return { completed: true as const, assertions,
    evidence: ['Real image identity normalization and rule selection: 1K/2K/4K, quality, auto and unknown scopes',
      'Real fresh-charge comparison rejects spec/rule/binding/rate changes; issue-time refresh is allowed',
      'Real accepted legacy overlay performs no storage read and preserves the original contract',
      'New independent rounding and old frozen 0.01-point precision remain distinct',
      'Actual channel/menu/quote consumer functions preserve scoped pricing, model availability and quote-only authorization',
      'Actual avatar plan matching preserves the selected default route and rejects stale supplier snapshots',
      'Existing v2 ratio/output-size/billing specification helpers retain requested auto and the resolved reference ratio without a new output-plan contract'],
    scope: 'pure image specification and consumer functions; no database/queue/browser integration execution' };
}
