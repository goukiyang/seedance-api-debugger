import assert from 'node:assert/strict';
import path from 'node:path';
import { mock } from 'node:test';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { stringifyPrivateCredentials } from '@/lib/security/private-credentials.server';
import { capturePricingMenuInputs } from '@/lib/pricing/image-menu-inputs';
import { capturePricingImageMenu, getPricingImageChannelOptions, projectPricingImageChannelOptions } from '@/lib/pricing/image';
import { pricingCanonical } from '@/lib/pricing/catalog';
import { PricingAdminServiceError } from '@/lib/pricing/policy';
import { assertNewPricingCharge, quotePricingCharge } from '@/lib/pricing/charge';
import { PRICING_POLICY_KEY, type PricingAdminIdentity } from '@/lib/pricing/admin-contract';
import { PRICING_IMAGE_CAPABILITY_KEY, PricingRuntimeError } from '@/lib/pricing/runtime';
import { DEFAULT_STUDIO_PRICES } from '@/lib/image-studio/settings';

function freeze(value: unknown) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.values(value).forEach(freeze); Object.freeze(value);
}

/** Runs only on an explicitly supplied disposable DB; the caller owns real consumer setup and disconnect. */
export async function runPricingMenuSnapshotContractFixture(db: PrismaClient,
  input: { databasePath: string; positiveConsumer?: boolean }) {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.ok(path.isAbsolute(input.databasePath));
  assert.equal(process.env.DATABASE_URL, `file:${input.databasePath}`);
  assert.equal(process.env.PRICING_MENU_FIXTURE_DB, input.databasePath);
  const original = await db.platformSetting.findMany();
  let assertions = 0, captures = 0;
  let afterCapture: ((index: number) => Promise<void>) | undefined;
  const equal = (a: unknown, b: unknown) => { assert.deepEqual(a, b); assertions++; };
  const ok = (value: unknown) => { assert.ok(value); assertions++; };
  const reject = async (run: () => Promise<unknown>, predicate: (error: unknown) => boolean) => {
    await assert.rejects(run, predicate); assertions++;
  };
  const putRaw = (key: string, value_json: string) => db.platformSetting.upsert({ where: { key },
    create: { key, value_json }, update: { value_json } });
  const put = (key: string, value: unknown) => putRaw(key, JSON.stringify(value));
  const restore = async (key: string) => {
    const row = original.find(item => item.key === key);
    if (row) await putRaw(key, row.value_json); else await db.platformSetting.deleteMany({ where: { key } });
  };
  const restoreAll = async () => {
    const added = (await db.platformSetting.findMany()).filter(row => !original.some(item => item.key === row.key));
    if (added.length) await db.platformSetting.deleteMany({ where: { key: { in: added.map(row => row.key) } } });
    for (const row of original) await putRaw(row.key, row.value_json);
  };
  const native = prisma.$queryRaw.bind(prisma);
  // Observe actual native SELECT completion and mutate the fixture DB between captures. No query emulation.
  const observation = mock.method(prisma, '$queryRaw', (async (query: Prisma.Sql) => {
    const result = await native(query);
    if (query.sql?.includes('WITH fixed_keys AS')) { captures++; await afterCapture?.(captures); }
    return result;
  }) as typeof prisma.$queryRaw);
  const menu = async () => {
    const context = await capturePricingImageMenu();
    const raw = pricingCanonical(context.options); freeze(context.options);
    const result = await projectPricingImageChannelOptions(prisma, context);
    equal(pricingCanonical(context.options), raw);
    return { context, result };
  };
  let positiveConsumerChecked = false;
  try {
    const first = await menu();
    const initialCaptureCount = captures;
    const transactional = await db.$transaction(tx => getPricingImageChannelOptions(tx));
    equal(first.result, transactional);
    const policyRaw = original.find(row => row.key === PRICING_POLICY_KEY)?.value_json;
    const policy = policyRaw ? JSON.parse(policyRaw) as { rules: Array<{ identity: PricingAdminIdentity }> } : null;
    if (input.positiveConsumer) {
      const identity = policy?.rules.find(rule => rule.identity.kind === 'image')?.identity;
      ok(identity);
      const quoted = await quotePricingCharge(identity!, '1', db); ok(quoted);
      const capability = original.find(row => row.key === PRICING_IMAGE_CAPABILITY_KEY);
      ok(capability);
      await put(PRICING_IMAGE_CAPABILITY_KEY, { ...JSON.parse(capability!.value_json), expiresAt: new Date(0).toISOString() });
      await reject(menu, error => error instanceof PricingRuntimeError);
      await restore(PRICING_IMAGE_CAPABILITY_KEY);
      await db.platformSetting.deleteMany({ where: { key: PRICING_POLICY_KEY } });
      equal(await quotePricingCharge(identity!, '1', db), null);
      await reject(() => assertNewPricingCharge(quoted!.charge, quoted!.charge.revision, db), error => error instanceof Error);
      await restore(PRICING_POLICY_KEY);
      positiveConsumerChecked = true;
    }

    // No-policy and no-adoption paths do not inherit unrelated catalog or consumer failures.
    await db.platformSetting.deleteMany({ where: { key: PRICING_POLICY_KEY } });
    await putRaw(PRICING_IMAGE_CAPABILITY_KEY, '{');
    await putRaw('volcengine_ip_api_v1', '{'); await putRaw('h3_video_api_v1', '{');
    await putRaw('aimediakit_enhance_video_api_v1', '{'); await putRaw('pricing_authoring_v1', '{');
    const noPolicy = await menu(); equal(noPolicy.context.state, undefined);
    const captured = noPolicy.context;
    await putRaw('image_generation_api_v1', '{');
    equal(await projectPricingImageChannelOptions(prisma, captured), noPolicy.result);
    await restore('image_generation_api_v1');
    if (policy) {
      await put(PRICING_POLICY_KEY, { ...policy, rules: [] });
      const unadopted = await menu(); equal(unadopted.context.state, undefined);
      await db.platformSetting.deleteMany({ where: { key: PRICING_POLICY_KEY } });
    }
    await putRaw('image_generation_api_v1', '{');
    equal((await capturePricingMenuInputs()).image.shared, '{');
    await reject(capturePricingImageMenu, error => error instanceof Error && !String(error).includes('malformed JSON'));
    await restore('image_generation_api_v1');

    // Reference capture reads current revisions, including deleted channels, and never prior versions.
    const id = 'image-11111111-1111-4111-8111-111111111111', revision = '22222222-2222-4222-8222-222222222222';
    const versionKey = `image_generation_channel_version_v1:${id}:${revision}`;
    await put('image_generation_channels_v1', { version: 1, channels: [{ id, configRevision: revision, deleted: true }] });
    await putRaw(versionKey, 'current'); await putRaw(`image_generation_channel_version_v1:${id}:old`, 'history');
    await put(PRICING_POLICY_KEY, { revision: 'current-fixture' });
    await putRaw('pricing_policy_revision_v1:current-fixture', 'current-policy');
    await putRaw('pricing_policy_revision_v1:old-fixture', 'history-policy');
    const references = await capturePricingMenuInputs();
    equal(Array.from(references.image.versions.entries()), [[versionKey, 'current']]);
    equal(references.policyRevision, 'current-policy');
    await db.platformSetting.deleteMany({ where: { key: PRICING_POLICY_KEY } });

    // A legal synthetic credential goes through the unchanged private codec and exact scope derivation.
    const apiKey = 'image_generation_api_v1';
    const api = { enabled: true, provider: 'musk', api_key: 'pricing-menu-fixture-a',
      base_url: 'https://api.muskapis.com/v1', default_model: 'gpt-image-2', max_outputs_per_request: 8 };
    const writeApi = (key: string) => putRaw(apiKey, stringifyPrivateCredentials(apiKey, { ...api, api_key: key }));
    await put('image_generation_channels_v1', { version: 1, channels: [] });
    await db.platformSetting.deleteMany({ where: { key: { in: ['image_generation_legacy_model_api_v1:shared', 'image_generation_legacy_model_api_v1:banana'] } } });
    await writeApi('pricing-menu-fixture-a');
    await put('image_actual_billing_intent_v1', { enabled: true, revision: 1, enabledModels: ['gpt-image-2'] });
    await put('gpt_image_studio_v1', { context: '', revision: 0, model: 'gpt-image-2', prices: DEFAULT_STUDIO_PRICES });
    captures = 0;
    afterCapture = async index => {
      if (index !== 1) return;
      await put(PRICING_IMAGE_CAPABILITY_KEY, { heartbeat: 'final-fixture' });
      await put('gpt_image_studio_v1', { context: '', revision: 1, model: 'gpt-image-2', prices: { ...DEFAULT_STUDIO_PRICES, 'gpt-image-2': 31 } });
      await put('image_generation_channels_v1', { version: 1, channels: [{ id: 'fluxport', label: 'final-fixture-label' }] });
    };
    const final = await menu(); equal(captures, 2);
    equal(final.context.channels.legacyPrices['gpt-image-2'], 31);
    equal(final.context.inputs.imageConsumer, JSON.stringify({ heartbeat: 'final-fixture' }));
    equal(final.context.channels.registry.channels.find(item => item.id === 'fluxport')?.label, 'final-fixture-label');
    equal(final.context.state, undefined);

    captures = 0;
    afterCapture = async index => { if (index === 1) await writeApi('pricing-menu-fixture-b'); };
    await reject(capturePricingImageMenu, error => error instanceof PricingAdminServiceError && error.code === 'pricing_conflict');
    equal(captures, 2);
    // Failed global display promises clear immediately; the next ordinary read captures a new request once.
    await writeApi('pricing-menu-fixture-a'); captures = 0;
    await reject(getPricingImageChannelOptions, error => error instanceof PricingAdminServiceError && error.code === 'pricing_conflict');
    equal(captures, 2); afterCapture = undefined;
    await restoreAll(); captures = 0;
    const normal = await getPricingImageChannelOptions(); equal(captures, initialCaptureCount);
    equal(await getPricingImageChannelOptions(), normal); equal(captures, initialCaptureCount);
    return { fixture: 'pricing-menu-snapshot-contract', assertions, positiveConsumerChecked, completed: true };
  } finally {
    afterCapture = undefined; observation.mock.restore();
    await restoreAll();
    const restored = await db.platformSetting.findMany({ orderBy: { key: 'asc' } });
    equal(restored.map(row => [row.key, row.value_json]).sort(([a], [b]) => a.localeCompare(b)),
      original.map(row => [row.key, row.value_json]).sort(([a], [b]) => a.localeCompare(b)));
  }
}
