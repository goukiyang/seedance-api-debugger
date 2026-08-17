import assert from 'node:assert/strict';
import {
  DEFAULT_SEEDREAM_IMAGE_BASE_URL,
  DEFAULT_SEEDREAM_IMAGE_MODEL,
  IMAGE_GENERATION_PROVIDERS,
  buildImageGenerationApiSettingsPatch,
  createImageGeneration,
  normalizeImageGenerationApiSettings,
} from '@/lib/integrations/image-generation';

type CapturedRequest = {
  url: string;
  init: RequestInit;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function headerValue(init: RequestInit, key: string) {
  const headers = init.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(key) || undefined;
  if (Array.isArray(headers)) {
    return headers.find(([currentKey]) => currentKey.toLowerCase() === key.toLowerCase())?.[1];
  }
  return headers[key];
}

async function main() {
  assert.ok(IMAGE_GENERATION_PROVIDERS.includes('seedream'));
  assert.equal(DEFAULT_SEEDREAM_IMAGE_BASE_URL, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.equal(DEFAULT_SEEDREAM_IMAGE_MODEL, 'doubao-seedream-5-0-pro-260628');

  const seedreamSettings = normalizeImageGenerationApiSettings({
    enabled: true,
    provider: 'seedream',
    base_url: 'https://ark.example.com/api/v3',
    default_model: DEFAULT_SEEDREAM_IMAGE_MODEL,
    api_key: 'fixture-ark-key',
    timeout_ms: 120000,
    max_outputs_per_request: 8,
    default_ratio: '16:9',
    default_size: '2K',
    output_format: 'png',
    response_format: 'url',
    watermark: false,
    supports_async_task: true,
  });
  assert.equal(seedreamSettings.provider, 'seedream');
  assert.equal(seedreamSettings.base_url, 'https://ark.example.com/api/v3');
  assert.equal(seedreamSettings.default_model, DEFAULT_SEEDREAM_IMAGE_MODEL);
  assert.equal(seedreamSettings.max_outputs_per_request, 1);
  assert.equal(seedreamSettings.default_size, '2K');
  assert.equal(seedreamSettings.output_format, 'png');
  assert.equal(seedreamSettings.response_format, 'url');
  assert.equal(seedreamSettings.watermark, false);
  assert.equal(seedreamSettings.supports_async_task, false);

  const patched = buildImageGenerationApiSettingsPatch(seedreamSettings, {
    provider: 'seedream',
    max_outputs_per_request: 4,
    default_size: '1K',
    output_format: 'jpeg',
    response_format: 'b64_json',
    watermark: true,
  });
  assert.equal(patched.max_outputs_per_request, 1);
  assert.equal(patched.default_size, '1K');
  assert.equal(patched.output_format, 'jpeg');
  assert.equal(patched.response_format, 'b64_json');
  assert.equal(patched.watermark, true);

  const captured: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    captured.push({ url, init: init || {} });
    return jsonResponse({
      created: 123,
      data: [
        {
          url: 'https://tos.example.com/generated/seedream.png?signature=secret',
          revised_prompt: 'Seedream revised prompt',
        },
      ],
    });
  }) as typeof fetch;

  try {
    const result = await createImageGeneration({
      settings: seedreamSettings,
      prompt: '生成一张干净的产品首帧参考图',
      ratio: '16:9',
      count: 4,
      referenceImages: [
        'data:image/png;base64,cmVmMQ==',
        'https://static.example.com/reference-2.png',
      ],
    });

    assert.equal(result.model, DEFAULT_SEEDREAM_IMAGE_MODEL);
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0]?.url, 'https://tos.example.com/generated/seedream.png?signature=secret');
    assert.equal(result.images[0]?.revisedPrompt, 'Seedream revised prompt');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://ark.example.com/api/v3/images/generations');
  assert.equal(captured[0].init.method, 'POST');
  assert.equal(headerValue(captured[0].init, 'Authorization'), 'Bearer fixture-ark-key');
  assert.equal(headerValue(captured[0].init, 'Content-Type'), 'application/json');

  const body = JSON.parse(String(captured[0].init.body));
  assert.equal(body.model, DEFAULT_SEEDREAM_IMAGE_MODEL);
  assert.equal(body.prompt, '生成一张干净的产品首帧参考图');
  assert.deepEqual(body.image, [
    'data:image/png;base64,cmVmMQ==',
    'https://static.example.com/reference-2.png',
  ]);
  assert.equal(body.size, '2K');
  assert.equal(body.output_format, 'png');
  assert.equal(body.response_format, 'url');
  assert.equal(body.watermark, false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'n'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'stream'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'tools'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'sequential_image_generation'), false);

  console.log('seedream-image-generation smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
