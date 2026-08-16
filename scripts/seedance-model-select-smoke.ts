import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SEEDANCE_VIDEO_MODEL_ID,
  SEEDANCE_2_0_MODEL_ID,
  SEEDANCE_2_5_MODEL_ID,
  SEEDANCE_VIDEO_MODEL_OPTIONS,
  parseSeedanceVideoModel,
  seedanceVideoModelLabel,
} from '../src/lib/provider/seedance-models';
import { calculateEstimatedCost } from '../src/lib/pricing';
import { calculateEstimatedCostClient } from '../src/lib/pricing-client';

function read(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

async function assertProviderPayloadModel() {
  const originalFetch = globalThis.fetch;
  const previousApiKey = process.env.SEEDANCE_API_KEY;
  process.env.SEEDANCE_API_KEY = 'smoke-key';
  const { createVideoTask } = await import('../src/lib/provider/jimeng');
  const capture: { payload?: Record<string, unknown> } = {};
  globalThis.fetch = (async (_input, init) => {
    capture.payload = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: 'seedance-model-smoke-task' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await createVideoTask({
      prompt: 'smoke',
      generation_mode: 'all_in_one_reference',
      ratio: '16:9',
      duration: 4,
      resolution: '480p',
      model: SEEDANCE_2_5_MODEL_ID,
      generate_audio: false,
    });
    assert.ok(capture.payload, 'Provider smoke should capture request payload');
    assert.equal(capture.payload.model, SEEDANCE_2_5_MODEL_ID, 'Provider payload must use selected Seedance 2.5 model');
    assert.equal(capture.payload.apiKey, 'smoke-key', 'Provider smoke should still send configured API key');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousApiKey == null) delete process.env.SEEDANCE_API_KEY;
    else process.env.SEEDANCE_API_KEY = previousApiKey;
  }
}

async function main() {
  assert.equal(DEFAULT_SEEDANCE_VIDEO_MODEL_ID, SEEDANCE_2_0_MODEL_ID, 'Seedance 2.0 remains the default model');
  assert.equal(seedanceVideoModelLabel(SEEDANCE_2_5_MODEL_ID), 'Seedance 2.5');
  assert.ok(
    SEEDANCE_VIDEO_MODEL_OPTIONS.some((option) => option.id === SEEDANCE_2_5_MODEL_ID && option.label === 'Seedance 2.5'),
    'Seedance 2.5 must be visible in model options',
  );
  assert.deepEqual(parseSeedanceVideoModel(null), { ok: true, model: SEEDANCE_2_0_MODEL_ID });
  assert.deepEqual(parseSeedanceVideoModel(SEEDANCE_2_5_MODEL_ID), { ok: true, model: SEEDANCE_2_5_MODEL_ID });
  assert.equal(parseSeedanceVideoModel('bad-model').ok, false, 'Unknown model must not be accepted');

  const seedance20Pricing = calculateEstimatedCost('720p', 4, SEEDANCE_2_0_MODEL_ID);
  const seedance25Pricing = calculateEstimatedCost('720p', 4, SEEDANCE_2_5_MODEL_ID);
  assert.equal(seedance20Pricing.internalMultiplier, 1.0, 'Seedance 2.0 should keep the base internal multiplier');
  assert.equal(seedance25Pricing.internalMultiplier, 1.5, 'Seedance 2.5 should use 1.5x internal multiplier');
  assert.equal(seedance20Pricing.estimatedCost, 12, 'Seedance 2.0 4s cost should keep the old 3 points/s rule');
  assert.equal(seedance25Pricing.estimatedCost, 18, 'Seedance 2.5 4s cost should be 1.5x Seedance 2.0');
  assert.equal(
    calculateEstimatedCostClient('720p', 4, SEEDANCE_2_5_MODEL_ID),
    seedance25Pricing.estimatedCost,
    'Client estimate must match server pricing for Seedance 2.5',
  );

  const providerSource = read('src/lib/provider/jimeng.ts');
  const createRouteSource = read('src/app/api/tasks/create/route.ts');
  const estimateRouteSource = read('src/app/api/tasks/estimate/route.ts');
  const generateClientSource = read('src/components/generate/GeneratePageClient.tsx');
  const generationComposerSource = read('src/components/GenerationComposer.tsx');
  const configRouteSource = read('src/app/api/config/route.ts');
  const codexConfigRouteSource = read('src/app/api/codex/config/route.ts');
  const canvasBootstrapSource = read('src/app/api/tools/ultimate-canvas/bootstrap/route.ts');
  const pricingSource = read('src/lib/pricing.ts');
  const pricingClientSource = read('src/lib/pricing-client.ts');
  const modelRegistrySource = read('src/lib/provider/seedance-models.ts');
  const todoSource = read('tasks/todo/2026-08-13-seedance-25-video-model.md');
  const externalApiDoc = read('docs/sd2-external-api-integration.md');

  assert.ok(providerSource.includes('resolveSeedanceVideoModel(input.model)'), 'Provider must resolve model from input');
  assert.doesNotMatch(providerSource, /const model = 'dreamina-seedance-2-0-260128'/, 'Provider must not hard-code Seedance 2.0');

  assert.ok(createRouteSource.includes('parseSeedanceVideoModel(body.model)'), 'Create route must parse request body model');
  assert.ok(createRouteSource.includes('model: selectedModel'), 'Create route must store selected model');
  assert.ok(createRouteSource.includes('calculateEstimatedCost(resolution, duration, selectedModel)'), 'Pricing snapshot should use selected model id');
  assert.ok(
    /providerPayloadJson:\s*JSON\.stringify\([\s\S]*\{ model: selectedModel, content_item_count/.test(createRouteSource),
    'Task snapshot should record selected model in provider payload metadata',
  );
  assert.ok(
    /const taskParams = \{[\s\S]*provider: requestedProvider,[\s\S]*model: selectedModel,/.test(createRouteSource),
    'Callback/task params should carry selected model',
  );
  assert.ok(
    (createRouteSource.match(/model: selectedModel/g) || []).length >= 5,
    'Selected model should flow through provider input, task params, task record, and response',
  );

  assert.ok(modelRegistrySource.includes('[SEEDANCE_2_5_MODEL_ID]: 1.5'), 'Seedance 2.5 must have 1.5x internal multiplier');
  assert.ok(pricingSource.includes('seedanceVideoModelInternalMultiplier(model)'), 'Server pricing must resolve model multiplier');
  assert.ok(pricingSource.includes('DEFAULT_PRICING_RULE_VERSION = 3'), 'Pricing rule version must bump after multiplier change');
  assert.ok(pricingClientSource.includes('seedanceVideoModelInternalMultiplier(model)'), 'Client pricing must resolve the same model multiplier');
  assert.ok(estimateRouteSource.includes("parseSeedanceVideoModel(searchParams.get('model'))"), 'Estimate API must parse model from query');
  assert.ok(
    estimateRouteSource.includes('calculateEstimatedCost(resolution, duration, parsedModel.model)'),
    'Estimate API must price the parsed selected model',
  );
  assert.ok(
    generationComposerSource.includes('calculateEstimatedCostClient(resolution, duration, selectedModel)'),
    'Composer estimate must include selected model',
  );
  assert.ok(generateClientSource.includes('SEEDANCE_VIDEO_MODEL_OPTIONS'), 'Standard generate page must import Seedance video model options');
  assert.ok(
    generateClientSource.includes('const options = [...SEEDANCE_VIDEO_MODEL_OPTIONS]')
      && generateClientSource.includes('modelOptions={activeModelOptions}'),
    'Standard generate page should pass Seedance model options to the existing footer chip',
  );
  assert.ok(configRouteSource.includes('model_options: config.model_options'), '/api/config must expose model options');
  assert.ok(codexConfigRouteSource.includes('SEEDANCE_VIDEO_MODEL_OPTIONS.map'), 'Codex config must expose Seedance model options');
  assert.ok(codexConfigRouteSource.includes('internal_credit_multiplier'), 'Codex config must expose internal credit multiplier');
  assert.ok(canvasBootstrapSource.includes('model_options: videoConfig.model_options'), 'Ultimate canvas bootstrap must expose video model options');
  assert.ok(pricingSource.includes('model = DEFAULT_SEEDANCE_VIDEO_MODEL_ID'), 'Pricing snapshot should keep Seedance 2.0 as default model');
  assert.ok(externalApiDoc.includes('dreamina-seedance-2-5-260628'), 'External API doc must mention Seedance 2.5 model');
  assert.ok(externalApiDoc.includes('1.5'), 'External API doc must mention Seedance 2.5 internal credit multiplier');

  assert.ok(todoSource.includes('https://sd2.youdooart.com'), 'Plan must use the current server production domain');
  assert.ok(todoSource.includes('sd2-gray.service'), 'Plan must use server systemd service for deployment verification');
  assert.ok(todoSource.includes('.next-prod-candidate'), 'Plan must require candidate production build');
  assert.doesNotMatch(todoSource, /youdoo-sites build sd2|youdoo-sites restart sd2|youdoo-sites build\/restart\/status sd2/, 'Plan must not use old Mac youdoo-sites deployment');

  await assertProviderPayloadModel();

  console.log('seedance-model-select smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
