import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_MUSK_IMAGE_BASE_URL,
  DEFAULT_MUSK_IMAGE_MODEL,
  DEFAULT_SEEDREAM_IMAGE_BASE_URL,
  DEFAULT_SEEDREAM_IMAGE_MODEL,
  buildImageGenerationApiSettingsPatch,
  isImageGenerationApiReady,
} from '@/lib/integrations/image-generation';

const current = {
  enabled: false,
  provider: 'musk' as const,
  base_url: DEFAULT_MUSK_IMAGE_BASE_URL,
  default_model: DEFAULT_MUSK_IMAGE_MODEL,
  api_key: null,
  timeout_ms: 90000,
  max_outputs_per_request: 3,
  default_ratio: '16:9',
  default_size: '2K' as const,
  output_format: 'png' as const,
  response_format: 'url' as const,
  watermark: false,
  supports_text_to_image: true,
  supports_image_to_image: true,
  supports_async_task: false,
};

const saved = buildImageGenerationApiSettingsPatch(current, {
  enabled: true,
  provider: 'seedream',
  api_key: 'fixture-ark-key-1234567890',
});

assert.equal(saved.enabled, true);
assert.equal(saved.provider, 'seedream');
assert.equal(saved.base_url, DEFAULT_SEEDREAM_IMAGE_BASE_URL);
assert.equal(saved.default_model, DEFAULT_SEEDREAM_IMAGE_MODEL);
assert.equal(saved.api_key, 'fixture-ark-key-1234567890');
assert.equal(saved.max_outputs_per_request, 1);
assert.equal(saved.default_size, '2K');
assert.equal(saved.output_format, 'png');
assert.equal(saved.response_format, 'url');
assert.equal(saved.watermark, false);
assert.equal(saved.supports_text_to_image, true);
assert.equal(saved.supports_image_to_image, true);
assert.equal(saved.supports_async_task, false);
assert.equal(isImageGenerationApiReady(saved), true);

async function main() {
  const routeModuleUrl = pathToFileURL(`${process.cwd()}/src/app/api/admin/integrations/image-generation/route.ts`).href;
  const routeModule = await import(routeModuleUrl);
  assert.equal(typeof routeModule.GET, 'function');
  assert.equal(typeof routeModule.PUT, 'function');
  assert.equal(typeof routeModule.POST, 'function');
  assert.equal(routeModule.dynamic, 'force-dynamic');

  const routeSource = fs.readFileSync(
    `${process.cwd()}/src/app/api/admin/integrations/image-generation/route.ts`,
    'utf8',
  );
  assert.ok(routeSource.includes('default_size: settings.default_size'));
  assert.ok(routeSource.includes('output_format: settings.output_format'));
  assert.ok(routeSource.includes('response_format: settings.response_format'));
  assert.ok(routeSource.includes('watermark: settings.watermark'));
  assert.ok(routeSource.includes('api_key_configured'));
  assert.equal(routeSource.includes('api_key: saved.api_key'), false);

  const clientSource = fs.readFileSync(
    `${process.cwd()}/src/app/admin/integrations/AdminIntegrationsClient.tsx`,
    'utf8',
  );
  assert.ok(clientSource.includes("provider: 'musk' | 'seedream'"));
  assert.ok(clientSource.includes('IMAGE_MODEL_OPTIONS'));
  assert.ok(clientSource.includes('Seedream 5.0 Pro'));
  assert.ok(clientSource.includes('Gemini Image (Musk)'));
  assert.ok(clientSource.includes('seedream-reference-limit'));
  assert.ok(clientSource.includes('image-default-size'));
  assert.ok(clientSource.includes('image-output-format'));
  assert.ok(clientSource.includes('image-watermark'));
  assert.ok(clientSource.includes('最多 10 张参考图'));
  assert.ok(clientSource.includes('单张输出'));

  const bootstrapSource = fs.readFileSync(
    `${process.cwd()}/src/app/api/tools/ultimate-canvas/bootstrap/route.ts`,
    'utf8',
  );
  assert.ok(bootstrapSource.includes("if (provider === 'seedream') return 'Seedream 5.0 Pro'"));
  assert.ok(bootstrapSource.includes('reference_image_limit: 10'));
  assert.ok(bootstrapSource.includes('max_outputs_per_request: 1'));
  assert.ok(bootstrapSource.includes("size_options: ['1K', '2K']"));

  console.log('seedream-admin-settings smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
