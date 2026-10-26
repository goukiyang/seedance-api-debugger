import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { getCanvasImageQuote, type CanvasQuoteInput } from '@/lib/canvas-quote';
import { getPricingImageChannelOptions, resolvePricingImageCandidate } from '@/lib/pricing/image';
import { PricingItemUnavailableError, isPricingItemUnavailable } from '@/lib/pricing/item-unavailable';
import { getImageGenerationApiSettings, getImageGenerationChannels, readPricingImageActualReadiness,
  resolveImageGenerationChannelSnapshot, IMAGE_GENERATION_API_SETTING_KEY, BANANA_IMAGE_API_SETTING_KEY } from '@/lib/integrations/image-generation';
import { IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY, ImageGenerationQualityRouteError } from '@/lib/integrations/image-generation-defaults';
import { IMAGE_STUDIO_SETTING_KEY, DEFAULT_STUDIO_PRICES } from '@/lib/image-studio/settings';
import { PRICING_POLICY_KEY } from '@/lib/pricing/admin-contract';
import { PRICING_IMAGE_CAPABILITY_KEY, PricingRuntimeError } from '@/lib/pricing/runtime';

export const pricingImageCandidateFixtureErrorClasses = Object.freeze({ PricingRuntimeError, PricingItemUnavailableError });

function keyFrom(value: unknown) {
  if (!value || typeof value !== 'object' || !('where' in value)) return null;
  const where = value.where;
  return where && typeof where === 'object' && 'key' in where && typeof where.key === 'string' ? where.key : null;
}

// Only inject database read failures. Permissions, processes, consumers and source bytes remain real.
function failingRead(db: PrismaClient, match: (key: string) => boolean, error: Error) {
  return new Proxy(db, { get(target, property, receiver) {
    if (property !== 'platformSetting') return Reflect.get(target, property, receiver);
    return new Proxy(target.platformSetting, { get(delegate, method, delegateReceiver) {
      const original = Reflect.get(delegate, method, delegateReceiver);
      if (method !== 'findUnique') return original;
      return (input: unknown) => {
        const key = keyFrom(input);
        if (key && match(key)) throw error;
        return Reflect.apply(original, delegate, [input]);
      };
    } });
  } });
}

export async function runPricingImageCandidateContractFixture(db: PrismaClient, user: SessionUser, projectId: string,
  transactionQueries: readonly string[]) {
  let assertions = 0;
  const equal = (actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected); assertions++; };
  const ok = (value: unknown) => { assert.ok(value); assertions++; };
  const transactions = (offset: number, expected: number) => {
    const observed = transactionQueries.slice(offset);
    equal(observed.filter(query => query === 'BEGIN IMMEDIATE').length, expected);
    equal(observed.filter(query => query === 'COMMIT').length, expected);
    equal(observed.filter(query => query === 'ROLLBACK').length, 0);
    equal(observed.length, expected * 2);
  };
  const reject = async (run: () => Promise<unknown>, predicate?: (error: unknown) => boolean) => {
    await assert.rejects(run, error => !predicate || predicate(error)); assertions++;
  };
  const original = await db.platformSetting.findMany();
  const taskCount = await db.imageStudioTask.count();
  const accounts = await db.creditAccount.findMany({ orderBy: { id: 'asc' } });
  const snapshots = () => db.platformSetting.count({ where: { key: { startsWith: 'image_generation_channel_version_v1:' } } });
  const base: CanvasQuoteInput = { kind: 'image', project_id: projectId, model: 'gpt-image-2', count: 3,
    quality: 'auto', resolution: '1K', ratio: '1:1' };
  const quote = (changes: Partial<CanvasQuoteInput> = {}) => getCanvasImageQuote(user, { ...base, ...changes });
  const putRaw = async (key: string, value_json: string) => db.platformSetting.upsert({ where: { key },
    create: { key, value_json }, update: { value_json } });
  const put = (key: string, value: unknown) => putRaw(key, JSON.stringify(value));
  const restore = async (key: string) => {
    const row = original.find(item => item.key === key);
    if (row) await putRaw(key, row.value_json); else await db.platformSetting.deleteMany({ where: { key } });
  };
  try {
    const before = await snapshots(), initialOffset = transactionQueries.length, initial = await quote();
    transactions(initialOffset, 1);
    equal(initial.unitCredits, 0.2); equal(initial.estimatedCredits, 0.6); equal(await snapshots(), before);
    const absent = initial.modelOptions.find(item => item.model === 'gemini-3-pro-image-preview')!;
    equal(absent.status, 'unavailable'); equal(absent.unitCredits, null); equal(absent.estimatedCredits, null); ok(absent.reasonText);
    const concurrentOffset = transactionQueries.length;
    const concurrent = await Promise.all([quote(), quote(), quote()]);
    transactions(concurrentOffset, 3);
    for (const result of concurrent) {
      equal(result.unitCredits, 0.2); equal(result.estimatedCredits, 0.6);
      equal(result.pricingRevision, initial.pricingRevision); equal(result.modelOptions, initial.modelOptions);
    }
    equal(await snapshots(), before);
    const menuOffset = transactionQueries.length;
    const menus = await Promise.all([getPricingImageChannelOptions(), getPricingImageChannelOptions(), getPricingImageChannelOptions()]);
    // Display menus coalesce one readonly projection; the three real quotes above remain independent.
    transactions(menuOffset, 1);
    equal(menus[1], menus[0]); equal(menus[2], menus[0]);
    const options = await db.$transaction(tx => getPricingImageChannelOptions(tx));
    equal(options, menus[0]);
    equal(options.items.find(item => item.id === 'original')!.models['gpt-image-2']!.fixedPoints, 0.2);
    const missing = options.items.find(item => item.id === 'banana')!.models['gemini-3.1-flash-image-preview']!;
    equal(missing.ready, false); equal(missing.fixedPoints, null); // Its old configured price was non-null.
    equal(await snapshots(), before);
    await reject(() => quote({ model: 'gemini-3-pro-image-preview' }), error => error instanceof PricingItemUnavailableError);

    for (const [key, error] of [[IMAGE_GENERATION_API_SETTING_KEY, new Error('fixture database read failure')],
      [IMAGE_STUDIO_SETTING_KEY, new TypeError('fixture unexpected settings failure')],
      [IMAGE_GENERATION_API_SETTING_KEY, Object.assign(new Error('fixture unrelated conflict'), { status: 409, code: 'pricing_scope_unmatched' })]] as const) {
      await reject(() => getPricingImageChannelOptions(failingRead(db, candidate => candidate === key, error)), value => value === error);
    }
    const originalApi = original.find(item => item.key === IMAGE_GENERATION_API_SETTING_KEY)!;
    for (const raw of ['{', JSON.stringify({ enabled: true, provider: 'unknown-provider' }),
      JSON.stringify({ enabled: true, provider: 'musk', base_url: 'not-a-url', api_key: 'fixture' })]) {
      await putRaw(IMAGE_GENERATION_API_SETTING_KEY, raw);
      await reject(() => quote(), error => !(error instanceof PricingItemUnavailableError));
    }
    // The non-pricing historical reader keeps its existing fallback contract.
    await putRaw(IMAGE_GENERATION_API_SETTING_KEY, '{');
    equal((await getImageGenerationApiSettings(db)).enabled, false);
    await putRaw(IMAGE_GENERATION_API_SETTING_KEY, originalApi.value_json);
    await put(IMAGE_STUDIO_SETTING_KEY, { context: '', revision: 0, model: 'gpt-image-2', prices: { 'gpt-image-2': '20' } });
    await reject(() => quote(), error => !(error instanceof PricingItemUnavailableError));
    await restore(IMAGE_STUDIO_SETTING_KEY);

    const policy = original.find(item => item.key === PRICING_POLICY_KEY)!;
    const parsedPolicy = JSON.parse(policy.value_json) as { rules: unknown[] };
    await put(PRICING_POLICY_KEY, { ...parsedPolicy, rules: [...parsedPolicy.rules, parsedPolicy.rules[0]] });
    await reject(() => quote(), error => !(error instanceof PricingItemUnavailableError));
    await restore(PRICING_POLICY_KEY);
    const capability = original.find(item => item.key === PRICING_IMAGE_CAPABILITY_KEY)!;
    await put(PRICING_IMAGE_CAPABILITY_KEY, { ...JSON.parse(capability.value_json), expiresAt: new Date(0).toISOString() });
    await reject(() => quote(), error => error instanceof PricingRuntimeError);
    await restore(PRICING_IMAGE_CAPABILITY_KEY);

    await put('image_actual_billing_intent_v1', { enabled: true, revision: 1, enabledModels: ['gpt-image-2'] });
    const proofError = new TypeError('fixture actual-bill database failure');
    const proofDb = failingRead(db, key => key.startsWith('image_billing_proof_v1:'), proofError);
    await reject(() => getPricingImageChannelOptions(proofDb), error => error === proofError);
    const strictChannels = await getImageGenerationChannels(db, true);
    await reject(() => readPricingImageActualReadiness(strictChannels.shared, 'gpt-image-2', proofDb), error => error === proofError);
    await restore('image_actual_billing_intent_v1');

    // Different model defaults use distinct real configurations, not the selected model's supplier or snapshot.
    await put(IMAGE_GENERATION_API_SETTING_KEY, { enabled: true, provider: 'ai_media_vip', api_key: 'fixture-shared-key',
      base_url: 'https://fixture.invalid/shared', default_model: 'gpt-image-2', max_outputs_per_request: 8 });
    await put(BANANA_IMAGE_API_SETTING_KEY, { enabled: true, provider: 'musk', api_key: 'fixture-banana-key',
      base_url: 'https://api.muskapis.com/v1', max_outputs_per_request: 8 });
    await put(IMAGE_STUDIO_SETTING_KEY, { context: '', revision: 0, model: 'gpt-image-2',
      prices: { ...DEFAULT_STUDIO_PRICES, 'gpt-image-2.5-flare': 2, 'gpt-image-2.5-sunburst': 0, 'gemini-3-pro-image-preview': 7 } });
    await put(IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY, { version: 1, revision: 1,
      models: { 'gpt-image-2.5-flare': 'banana', 'gemini-3-pro-image-preview': 'shared' } });
    const routedChannels = await getImageGenerationChannels(db, true);
    const flareRoute = await resolvePricingImageCandidate(routedChannels, 'gpt-image-2.5-flare', undefined, db);
    const proRoute = await resolvePricingImageCandidate(routedChannels, 'gemini-3-pro-image-preview', 'original', db);
    equal(flareRoute.identity.channelId, 'banana'); equal(flareRoute.settings?.provider, 'musk');
    equal(proRoute.identity.channelId, 'shared'); equal(proRoute.settings?.provider, 'ai_media_vip');
    const beforeRouted = await snapshots();
    const routed = await quote({ model: 'gpt-image-2.5-flare' });
    equal(routed.imageChannel?.channelId, 'banana'); equal(routed.unitCredits, 2); equal(routed.estimatedCredits, 6);
    equal(await snapshots(), beforeRouted + 1);
    equal(routed.modelOptions.find(item => item.model === 'gemini-3-pro-image-preview')!.unitCredits, 7);
    const oldQuality = routed.modelOptions.find(item => item.model === 'gpt-image-2.5-sunburst')!;
    equal(oldQuality.status, 'unavailable'); equal(oldQuality.reason, 'specification_unsupported');
    equal(oldQuality.unitCredits, null); equal(oldQuality.estimatedCredits, null); equal(oldQuality.chargeEnabled, false);
    // Explicit zero remains a real price on a configured, supported quality; auto is not an alias for it.
    await put(IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY, { version: 2, revision: 2,
      models: { 'gpt-image-2.5-flare': 'banana', 'gemini-3-pro-image-preview': 'shared' },
      qualityRoutes: { 'gpt-image-2.5-sunburst': { medium: 'shared', max: 'banana' } } });
    const freeQuality = (await quote({ model: 'gpt-image-2.5-flare', quality: 'medium' }))
      .modelOptions.find(item => item.model === 'gpt-image-2.5-sunburst')!;
    equal(freeQuality.status, 'estimate'); equal(freeQuality.reason, null);
    equal(freeQuality.unitCredits, 0); equal(freeQuality.estimatedCredits, 0); equal(freeQuality.chargeEnabled, false);
    const unsupportedAuto = (await quote({ model: 'gpt-image-2.5-flare', quality: 'auto' }))
      .modelOptions.find(item => item.model === 'gpt-image-2.5-sunburst')!;
    equal(unsupportedAuto.status, 'unavailable'); equal(unsupportedAuto.reason, 'specification_unsupported');
    equal(unsupportedAuto.unitCredits, null); equal(unsupportedAuto.estimatedCredits, null); equal(unsupportedAuto.chargeEnabled, false);
    await reject(() => quote({ model: 'gpt-image-2.5-sunburst', quality: 'auto' }), error => error instanceof ImageGenerationQualityRouteError);
    const unopened = routed.modelOptions.find(item => item.model === 'gemini-nano-banana-2.1')!;
    equal(unopened.status, 'unavailable'); equal(unopened.unitCredits, null); equal(unopened.estimatedCredits, null);
    await reject(() => quote({ model: 'gemini-nano-banana-2.1' }));
    const staleBasis = routed.modelOptions.find(item => item.model === 'gpt-image-2')!;
    equal(staleBasis.status, 'unavailable'); equal(staleBasis.reason, 'evidence_unconfirmed'); equal(staleBasis.unitCredits, null);
    await reject(() => quote(), error => error instanceof PricingItemUnavailableError);
    await reject(() => resolveImageGenerationChannelSnapshot(routed.imageChannel!, db, true, 'gemini-3-pro-image-preview'),
      error => error instanceof Error && 'code' in error && error.code === 'image_channel_quote_model_mismatch');
    const explicit = await quote({ model: 'gpt-image-2.5-flare', channelId: 'shared' });
    equal(explicit.imageChannel?.channelId, 'shared'); equal(explicit.provider, 'ai_media_vip');
    const high = await quote({ model: 'gpt-image-2.5-flare', quality: 'high' });
    const unsupported = high.modelOptions.find(item => item.model === 'gemini-3-pro-image-preview')!;
    equal(unsupported.status, 'unavailable'); equal(unsupported.reason, 'specification_unsupported'); equal(unsupported.unitCredits, null);
    await reject(() => quote({ model: 'gemini-3-pro-image-preview', quality: 'high' }));

    await put(IMAGE_STUDIO_SETTING_KEY, { context: '', revision: 0, model: 'gpt-image-2',
      prices: { ...DEFAULT_STUDIO_PRICES, 'gpt-image-2.5-flare': 2, 'gpt-image-2.5-sunburst': 0, 'gemini-3-pro-image-preview': null } });
    const withoutPrice = await quote({ model: 'gpt-image-2.5-flare' });
    const unpriced = withoutPrice.modelOptions.find(item => item.model === 'gemini-3-pro-image-preview')!;
    equal(unpriced.status, 'unavailable'); equal(unpriced.unitCredits, null); equal(unpriced.estimatedCredits, null);
    await reject(() => quote({ model: 'gemini-3-pro-image-preview' }));
    await put(IMAGE_STUDIO_SETTING_KEY, { context: '', revision: 0, model: 'gpt-image-2',
      prices: { ...DEFAULT_STUDIO_PRICES, 'gpt-image-2.5-flare': 2, 'gpt-image-2.5-sunburst': 0, 'gemini-3-pro-image-preview': 7 } });

    await put(IMAGE_GENERATION_API_SETTING_KEY, { enabled: false, provider: 'ai_media_vip', api_key: 'fixture-shared-key',
      base_url: 'https://fixture.invalid/shared', default_model: 'gpt-image-2', max_outputs_per_request: 8 });
    const disabled = await quote({ model: 'gpt-image-2.5-flare' });
    const disabledPro = disabled.modelOptions.find(item => item.model === 'gemini-3-pro-image-preview')!;
    equal(disabledPro.reason, 'disabled'); equal(disabledPro.unitCredits, null); equal(disabledPro.estimatedCredits, null);
    const beforeAlias = await snapshots();
    // Explicit fresh-price checks use the same transaction boundary as charging, not the display cache.
    const alias = await db.$transaction(tx => getPricingImageChannelOptions(tx));
    equal(await snapshots(), beforeAlias);
    equal(alias.items.find(item => item.id === 'original')!.models['gpt-image-2.5-flare']!.fixedPoints, 2);
    equal(alias.items.find(item => item.id === 'original')!.models['gpt-image-2.5-flare']!.ready, true);
    equal(alias.items.find(item => item.id === 'original')!.models['gemini-3-pro-image-preview']!.fixedPoints, null);
    equal(alias.items.find(item => item.id === 'shared')!.ready, false);
    equal(alias.items.find(item => item.id === 'original')!.ready, true);
    await reject(() => quote({ model: 'gemini-3-pro-image-preview' }));
    await reject(() => quote({ model: 'gpt-image-2.5-flare', channelId: 'shared' }));
    const otherIdentity = { ...flareRoute.identity, modelId: 'gemini-3-pro-image-preview' };
    equal(isPricingItemUnavailable(new PricingItemUnavailableError(otherIdentity, 'disabled', 'fixture'), flareRoute.identity), false);
    equal(await db.imageStudioTask.count(), taskCount); equal(await db.creditAccount.findMany({ orderBy: { id: 'asc' } }), accounts);
  } finally {
    await db.$transaction(async tx => {
      await tx.platformSetting.deleteMany({ where: { key: { notIn: original.map(row => row.key) } } });
      for (const row of original) await tx.platformSetting.upsert({ where: { key: row.key }, create: row,
        update: { value_json: row.value_json, updated_by: row.updated_by, created_at: row.created_at, updated_at: row.updated_at } });
    }, { timeout: 30000 });
  }
  equal(await db.platformSetting.findMany({ orderBy: { key: 'asc' } }), [...original].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { assertions };
}
