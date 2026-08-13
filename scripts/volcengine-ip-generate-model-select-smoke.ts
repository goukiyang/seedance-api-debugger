import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  VOLCENGINE_IP_MODEL_OPTIONS,
  VOLCENGINE_IP_SEEDANCE_2_0_MINI_MODEL_ID,
} from '@/lib/integrations/volcengine-ip-models';

const root = process.cwd();
const composerSource = fs.readFileSync(`${root}/src/components/GenerationComposer.tsx`, 'utf8');
const actionBarSource = fs.readFileSync(`${root}/src/components/ComposerActionBar.tsx`, 'utf8');
const generateClientSource = fs.readFileSync(`${root}/src/components/generate/GeneratePageClient.tsx`, 'utf8');
const createRouteSource = fs.readFileSync(`${root}/src/app/api/ip/tasks/create/route.ts`, 'utf8');

assert.ok(
  VOLCENGINE_IP_MODEL_OPTIONS.some((option) => option.id === VOLCENGINE_IP_SEEDANCE_2_0_MINI_MODEL_ID),
  'Seedance 2.0 Mini must be exposed in the IP model presets',
);

assert.match(
  composerSource,
  /modelOptions\?:\s*VolcengineIpModelOption\[\]/,
  'GenerationComposer should accept IP model options as a prop',
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
  generateClientSource.includes('modelOptions={isIpSurface ? VOLCENGINE_IP_MODEL_OPTIONS : SEEDANCE_VIDEO_MODEL_OPTIONS}'),
  'IP surface should keep Volcengine IP model options while standard generation receives Seedance video model options',
);
assert.match(
  generateClientSource,
  /model:\s*params\.model\s*\|\|\s*undefined/,
  'IP create request should include the selected model',
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
assert.ok(
  !/^\s+model:\s*volcengineSettings\.default_model,/m.test(createRouteSource),
  'IP create API should not hard-code the admin default model at task creation/provider submit points',
);
assert.ok(
  (createRouteSource.match(/model:\s*selectedModel/g) || []).length >= 3,
  'Selected model should be used for snapshot payload, task record, and provider submit',
);

console.log('volcengine-ip-generate-model-select smoke passed');
