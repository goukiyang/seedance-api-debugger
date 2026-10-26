import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  VOLCENGINE_IP_MODEL_OPTIONS,
  VOLCENGINE_IP_SEEDANCE_2_0_MINI_MODEL_ID,
  isVolcengineIpModelId,
  volcengineIpModelLabel,
  volcengineIpCapabilities,
} from '@/lib/integrations/volcengine-ip-models';
import { SEEDANCE_2_5_IP_MODEL_ID, SEEDANCE_VIDEO_MODEL_OPTIONS } from '@/lib/provider/seedance-models';
import { calculateEstimatedCost } from '@/lib/pricing';
import { calculateEstimatedCostClient } from '@/lib/pricing-client';

const root = process.cwd();
const composerSource = fs.readFileSync(`${root}/src/components/GenerationComposer.tsx`, 'utf8');
const actionBarSource = fs.readFileSync(`${root}/src/components/ComposerActionBar.tsx`, 'utf8');
const generateClientSource = fs.readFileSync(`${root}/src/components/generate/GeneratePageClient.tsx`, 'utf8');
const createRouteSource = fs.readFileSync(`${root}/src/app/api/ip/tasks/create/route.ts`, 'utf8');

assert.ok(
  VOLCENGINE_IP_MODEL_OPTIONS.some((option) => option.id === VOLCENGINE_IP_SEEDANCE_2_0_MINI_MODEL_ID),
  'Seedance 2.0 Mini must be exposed in the IP model presets',
);
assert.ok(
  VOLCENGINE_IP_MODEL_OPTIONS.some((option) => option.id === SEEDANCE_2_5_IP_MODEL_ID),
  'Seedance 2.5 IP model must be exposed in the IP model presets',
);
assert.equal(
  volcengineIpModelLabel(SEEDANCE_2_5_IP_MODEL_ID),
  'Seedance 2.5（IP生成）',
  'IP task labels should distinguish the Volcengine IP model from standard Seedance 2.5',
);
assert.equal(
  SEEDANCE_VIDEO_MODEL_OPTIONS.find((option) => option.id === 'dreamina-seedance-2-5-260628')?.label,
  'Seedance 2.5',
  'Standard generation should keep its existing Seedance 2.5 label',
);
assert.equal(
  volcengineIpCapabilities().find((option) => option.id === SEEDANCE_2_5_IP_MODEL_ID)?.internal_credit_multiplier,
  1.5,
  'IP Seedance 2.5 must retain its published internal price multiplier',
);
assert.equal(isVolcengineIpModelId('unknown-model'), false);
assert.equal(isVolcengineIpModelId(SEEDANCE_2_5_IP_MODEL_ID), true);
for (const duration of [4, 5, 11, 30]) {
  const snapshot = calculateEstimatedCost('720p', duration, SEEDANCE_2_5_IP_MODEL_ID);
  assert.equal(snapshot.finalCostPerSecond, 4.5);
  assert.equal(snapshot.estimatedCost, Math.ceil(4.5 * duration));
  assert.equal(calculateEstimatedCostClient('720p', duration, SEEDANCE_2_5_IP_MODEL_ID), snapshot.estimatedCost);
}
for (const option of VOLCENGINE_IP_MODEL_OPTIONS.filter(option => option.id !== SEEDANCE_2_5_IP_MODEL_ID)) {
  assert.equal(calculateEstimatedCost('720p', 5, option.id).estimatedCost, 15);
}

assert.match(
  composerSource,
  /modelOptions\?:\s*ComposerSelectOption\[\]/,
  'GenerationComposer should accept the shared option shape used by Volcengine IP models',
);
assert.match(
  composerSource,
  /const\s+\[selectedModel,\s*setSelectedModel\]/,
  'GenerationComposer should keep selected model in local UI state',
);
assert.ok(
  actionBarSource.includes('composer-model-options'),
  'ComposerActionBar should render a visible model selector for IP generation',
);
assert.match(
  composerSource,
  /model:\s*selectedModel\s*\|\|\s*null/,
  'GenerationComposer should include the selected model in submit params',
);

assert.ok(
  generateClientSource.includes('VOLCENGINE_IP_MODEL_OPTIONS'),
  'IP generate client should reuse the shared official Volcengine IP model list',
);
assert.ok(
  generateClientSource.includes('{volcengineIpModelLabel(task.model)}'),
  'IP task results should use the IP-specific model label',
);
assert.ok(composerSource.includes('calculateEstimatedCostClient(resolution, duration, selectedModel)'), 'Composer quote must use the selected model');
assert.ok(
  generateClientSource.includes('modelOptions={activeModelOptions}')
    && /const activeModelOptions\s*=\s*useMemo<ComposerSelectOption\[\]>/.test(generateClientSource)
    && /if \(isIpSurface\) return VOLCENGINE_IP_MODEL_OPTIONS;/.test(generateClientSource)
    && /const options = SEEDANCE_VIDEO_MODEL_OPTIONS\.map\(/.test(generateClientSource),
  'IP model list must reach the shared composer through the current memoized option flow; standard models retain their own options',
);
assert.ok(
  generateClientSource.includes('const requestedModel = selectedH3Model')
    && generateClientSource.includes('const selectedH3Model = !isIpSurface && params.model === H3_INLINE_MODEL_ID')
    && generateClientSource.includes(": params.model || ''")
    && generateClientSource.includes('model: requestedModel || undefined')
    && generateClientSource.includes('stableGenerationPayloadJson(requestBody)')
    && generateClientSource.includes('await fetch(createEndpoint, {')
    && generateClientSource.includes('body: JSON.stringify({ ...requestBody, idempotency_key: idempotencyKey })'),
  'The current client model-resolution chain must preserve the selected model in the create payload',
);

assert.match(
  createRouteSource,
  /typeof body\.model === 'string'/,
  'IP create API should read model from the request body',
);
assert.match(
  createRouteSource,
  /const selectedModel\s*=/,
  'IP create API should resolve one selected model for the whole task',
);
const pricingCalculationIndex = createRouteSource.indexOf('calculateEstimatedCost(resolution, duration, selectedModel)');
const firstTaskTransactionIndex = createRouteSource.indexOf('const result = await prisma.$transaction');
assert.ok(
  pricingCalculationIndex >= 0 && firstTaskTransactionIndex > pricingCalculationIndex,
  'IP create must calculate the selected model quote before its credit/task transaction',
);
assert.ok(
  !/^\s+model:\s*volcengineSettings\.default_model,/m.test(createRouteSource),
  'IP create API should not hard-code the admin default model at task creation/provider submit points',
);
assert.ok(
  (createRouteSource.match(/model:\s*selectedModel/g) || []).length >= 3,
  'Selected model should be used for snapshot payload, task record, and provider submit',
);

console.log('volcengine-ip-generate-model-select smoke passed');
