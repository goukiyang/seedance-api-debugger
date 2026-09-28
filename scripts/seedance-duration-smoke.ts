import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { NextRequest } from 'next/server';
import {
  DEFAULT_SEEDANCE_VIDEO_MODEL_ID, SEEDANCE_2_0_MODEL_ID, SEEDANCE_2_5_MODEL_ID,
  isSeedanceVideoDuration, seedanceVideoDurationOptions, seedanceVideoMaxDuration,
  seedanceVideoDurationCapabilities,
} from '../src/lib/provider/seedance-models';
import { calculateEstimatedCost } from '../src/lib/pricing';
import { calculateEstimatedCostClient } from '../src/lib/pricing-client';
import { validateRequestCostCeiling, validateSeedanceEditReference } from '../src/lib/provider/seedance-video-edit';
import { validateSeedanceReferenceMediaPreflight } from '../src/lib/provider/reference-media-policy';
import { normalizeGenerationDefaults, parseStoredGenerationDefaults, serializeGenerationDefaults } from '../src/lib/preferences/generation';

const ordinaryDurations = Array.from({ length: 12 }, (_, i) => i + 4);
const extendedDurations = Array.from({ length: 27 }, (_, i) => i + 4);
const videos = ['https://example.test/action-first.mp4', 'https://example.test/action-second.mp4'];

function assertDurationContracts() {
  assert.equal(DEFAULT_SEEDANCE_VIDEO_MODEL_ID, SEEDANCE_2_0_MODEL_ID);
  for (const model of [undefined, null, SEEDANCE_2_0_MODEL_ID, 'h3', 'ip', 'unknown']) {
    assert.equal(seedanceVideoMaxDuration(model), 15);
    assert.deepEqual(seedanceVideoDurationOptions(model), ordinaryDurations);
    for (const value of [3, 16, 30, 31, 4.5, NaN, Infinity, '4', '15', '30', null]) {
      assert.equal(isSeedanceVideoDuration(value, model), false, `${model}: ${String(value)}`);
    }
    for (const value of [4, 15]) assert.equal(isSeedanceVideoDuration(value, model), true);
  }
  assert.equal(seedanceVideoMaxDuration(SEEDANCE_2_5_MODEL_ID), 30);
  assert.deepEqual(seedanceVideoDurationOptions(SEEDANCE_2_5_MODEL_ID), extendedDurations);
  for (const value of [4, 15, 16, 30]) assert.equal(isSeedanceVideoDuration(value, SEEDANCE_2_5_MODEL_ID), true);
  for (const value of [3, 31, 4.5, 30.1, NaN, Infinity, '4', '30', '', null, undefined]) {
    assert.equal(isSeedanceVideoDuration(value, SEEDANCE_2_5_MODEL_ID), false, String(value));
  }
  assert.deepEqual(seedanceVideoDurationCapabilities(), {
    [SEEDANCE_2_0_MODEL_ID]: ordinaryDurations,
    [SEEDANCE_2_5_MODEL_ID]: extendedDurations,
  });

  for (const resolution of ['480p', '720p', '1080p']) {
    const pricing = calculateEstimatedCost(resolution, 30, SEEDANCE_2_5_MODEL_ID);
    assert.equal(pricing.baseCostPerSecond, 3, 'Do not import official API pricing into internal credits');
    assert.equal(pricing.internalMultiplier, 1.5);
    assert.equal(pricing.estimatedCost, 135);
    assert.equal(calculateEstimatedCostClient(resolution, 30, SEEDANCE_2_5_MODEL_ID), 135);
    assert.ok(validateRequestCostCeiling(134, pricing.estimatedCost));
    assert.equal(validateRequestCostCeiling(135, pricing.estimatedCost), null);
    assert.equal(calculateEstimatedCost(resolution, 15).estimatedCost, 45);
  }

  for (const duration of [15, 16, 30]) {
    const reference = { url: videos[0], durationSeconds: duration, width: 1280, height: 720 };
    const mediaIssue = validateSeedanceReferenceMediaPreflight({ videos: [{ ...reference, mimeType: 'video/mp4' }] });
    const editIssue = validateSeedanceEditReference({ urls: [videos[0]], reference, duration, ratio: '16:9' });
    if (duration === 15) {
      assert.equal(mediaIssue, null);
      assert.equal(editIssue, null);
    } else {
      assert.equal(mediaIssue?.code, 'REFERENCE_VIDEO_DURATION_UNSUPPORTED');
      assert.ok(editIssue, 'Output expansion must not expand edit duration');
    }
  }

  const saved = normalizeGenerationDefaults({ model: SEEDANCE_2_5_MODEL_ID, duration: 30 });
  assert.equal(saved.duration, 30);
  assert.equal(saved.model, SEEDANCE_2_5_MODEL_ID);
  assert.deepEqual(parseStoredGenerationDefaults(serializeGenerationDefaults(saved)), saved);
  assert.equal(normalizeGenerationDefaults({ duration: 15 }).duration, 15, 'Legacy preferences still load');
  for (const model of [undefined, SEEDANCE_2_0_MODEL_ID, 'h3', 'ip']) {
    assert.equal(normalizeGenerationDefaults({ model, duration: 30 }).duration, 5, '30s must not leak into another model');
  }
}

async function assertProviderPayload() {
  const previousKey = process.env.SEEDANCE_API_KEY;
  const previousBase = process.env.SEEDANCE_BASE_URL;
  const previousFetch = globalThis.fetch;
  const captured: Array<Record<string, any>> = [];
  process.env.SEEDANCE_API_KEY = 'offline-duration-fixture';
  process.env.SEEDANCE_BASE_URL = 'https://example.test/never-connect';
  globalThis.fetch = (async (request, init) => {
    assert.equal(String(request), 'https://example.test/never-connect/call');
    captured.push(JSON.parse(String(init?.body)));
    return Response.json({ id: 'offline-duration-task' });
  }) as typeof fetch;
  try {
    const { createVideoTask, getProviderConfig } = await import('../src/lib/provider/jimeng');
    const config = getProviderConfig();
    assert.deepEqual(config.model_options.find((option) => option.id === SEEDANCE_2_0_MODEL_ID)?.durations, ordinaryDurations);
    assert.deepEqual(config.model_options.find((option) => option.id === SEEDANCE_2_5_MODEL_ID)?.durations, extendedDurations);
    const input = {
      prompt: 'offline duration test', model: SEEDANCE_2_5_MODEL_ID,
      generation_mode: 'all_in_one_reference' as const, duration: 30 as const,
      ratio: '16:9' as const, resolution: '480p' as const, generate_audio: false,
      reference_video_urls: [...videos],
    };
    const original = structuredClone(input);
    await createVideoTask(input);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].duration, 30);
    assert.equal(captured[0].model, SEEDANCE_2_5_MODEL_ID);
    assert.deepEqual(captured[0].content.filter((item: any) => item.role === 'reference_video')
      .map((item: any) => item.video_url.url), videos, 'Both reference videos preserve the selected order');
    assert.deepEqual(input, original);
    for (const model of [SEEDANCE_2_0_MODEL_ID, undefined]) {
      await assert.rejects(createVideoTask({ ...input, model }), /4–15/);
    }
    for (const duration of [3, 31, 4.5, NaN, '30']) {
      await assert.rejects(createVideoTask({ ...input, duration: duration as any }), /4–30/);
    }
    assert.equal(captured.length, 1, 'Rejected inputs never reach fetch or trigger paid retries');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.SEEDANCE_API_KEY; else process.env.SEEDANCE_API_KEY = previousKey;
    if (previousBase === undefined) delete process.env.SEEDANCE_BASE_URL; else process.env.SEEDANCE_BASE_URL = previousBase;
  }
}

async function assertEstimateRoute() {
  // Only persistence is replaced. GET, token hashing, account validation and pricing run unchanged.
  const runtime = globalThis as any;
  const previousPrisma = runtime.prisma;
  const previousPragmas = runtime.prismaSqlitePragmasStarted;
  const fixtureToken = 'offline-estimate-fixture-token';
  const user = { id: 'duration-fixture-user', role: 'user', account_type: 'internal', status: 'active', expires_at: null };
  const settings = {
    enabled: true, user_selector: { type: 'id', value: user.id },
    token_hash: `sha256:${crypto.createHash('sha256').update(fixtureToken).digest('hex')}`,
  };
  const forbidUnexpectedAccess = (target: object) => new Proxy(target, {
    get(object, property) {
      if (!(property in object)) throw new Error(`Unexpected database access: ${String(property)}`);
      return Reflect.get(object, property);
    },
  });
  runtime.prisma = forbidUnexpectedAccess({
    platformSetting: forbidUnexpectedAccess({ findUnique: async (args: any) => {
      assert.equal(args.where.key, 'codex_video_api_v1');
      return { value_json: JSON.stringify(settings) };
    } }),
    user: forbidUnexpectedAccess({ findFirst: async (args: any) => {
      assert.deepEqual(args.where, { id: user.id });
      return { ...user };
    } }),
  });
  runtime.prismaSqlitePragmasStarted = true;
  try {
    const { GET } = await import('../src/app/api/tasks/estimate/route');
    const request = (duration = '30', model: string | undefined = SEEDANCE_2_5_MODEL_ID, token: string | null = fixtureToken) => {
      const url = new URL('https://example.test/api/tasks/estimate');
      url.searchParams.set('duration', duration);
      if (model) url.searchParams.set('model', model);
      return GET(new NextRequest(url, { headers: token ? { authorization: `Bearer ${token}` } : {} }));
    };
    for (const duration of ['4', '15', '16', '30']) {
      const response = await request(duration);
      assert.equal(response.status, 200, duration);
      assert.equal((await response.json()).estimatedCost, Math.ceil(Number(duration) * 3 * 1.5));
    }
    for (const duration of ['3', '31', '4.5', 'NaN', 'Infinity', '', '30seconds']) {
      assert.equal((await request(duration)).status, 400, duration);
    }
    assert.equal((await request('30', SEEDANCE_2_0_MODEL_ID)).status, 400);
    assert.equal((await request('30', '')).status, 400, 'Missing model keeps the 2.0 limit');
    assert.equal((await request('15', '')).status, 200);
    assert.equal((await request('30', 'unknown')).status, 400);
    assert.equal((await request('30', SEEDANCE_2_5_MODEL_ID, 'wrong-fixture-token')).status, 401);
    assert.equal((await request('30', SEEDANCE_2_5_MODEL_ID, null)).status, 401, 'No auth signal must not gain Codex access');
    user.role = 'admin';
    assert.equal((await request()).status, 403, 'Codex service account must remain an ordinary user');
    user.role = 'user';
    user.account_type = 'external';
    assert.equal((await request()).status, 403);
    user.account_type = 'internal';
    user.status = 'disabled';
    assert.equal((await request()).status, 403);
    user.status = 'active';
    settings.enabled = false;
    assert.equal((await request()).status, 503);

    const { buildH3GeneratePayload } = await import('../src/lib/provider/h3');
    assert.equal(buildH3GeneratePayload({ prompt: 'fixture', duration_sec: 15 }).duration_sec, 15);
    for (const duration_sec of [16, 30]) {
      assert.throws(() => buildH3GeneratePayload({ prompt: 'fixture', duration_sec }), /15/);
    }
  } finally {
    runtime.prisma = previousPrisma;
    runtime.prismaSqlitePragmasStarted = previousPragmas;
  }
}

function assertRouteWiring() {
  // These are wiring evidence only; authenticated Web/IP route execution needs a Next request context.
  const estimate = fs.readFileSync('src/app/api/tasks/estimate/route.ts', 'utf8');
  assert.match(estimate, /else\s*\{\s*user = await getSessionUser\(request\);\s*assertInternalOnly\(user,/);
  const ip = fs.readFileSync('src/app/api/ip/tasks/create/route.ts', 'utf8');
  assert.match(ip, /!Number\.isInteger\(duration\)\s*\|\|\s*duration < 4\s*\|\|\s*duration > 15/);
  const create = fs.readFileSync('src/app/api/tasks/create/route.ts', 'utf8');
  assert.ok(create.includes('isSeedanceVideoDuration(duration, selectedModel)'));
}

async function main() {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('Real network access is forbidden in this smoke'); }) as typeof fetch;
  try {
    assertDurationContracts();
    assertRouteWiring();
    await assertProviderPayload();
    await assertEstimateRoute();
    console.log('seedance-duration-smoke: PASS (offline provider, real estimate/auth with in-memory persistence; no DB/network/charge)');
  } finally {
    globalThis.fetch = previousFetch;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
