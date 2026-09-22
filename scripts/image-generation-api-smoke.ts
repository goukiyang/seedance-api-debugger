import assert from 'node:assert/strict';
import { createImageGeneration, normalizeImageGenerationApiSettings } from '../src/lib/integrations/image-generation';

async function main() {
  const settings = normalizeImageGenerationApiSettings({
    enabled: true,
    provider: 'ai_media_vip',
    base_url: 'https://api.ai-media.vip/v1/',
    default_model: 'gpt-image-2.5-flare',
    api_key: 'test-only',
    max_outputs_per_request: 2,
  });
  assert.equal(settings.provider, 'ai_media_vip');
  assert.equal(settings.base_url, 'https://api.ai-media.vip/v1/');
  assert.equal(settings.default_model, 'gpt-image-2.5-flare');

  const calls: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return Response.json({ data: [{ b64_json: 'aW1hZ2U=' }, { b64_json: 'aW1hZ2Uy' }] });
  }) as typeof fetch;
  try {
    const result = await createImageGeneration({ settings, prompt: 'test only', count: 2 });
    assert.equal(result.images.length, 2);
    assert.equal(calls[0].url, 'https://api.ai-media.vip/v1/images/generations');
    assert.equal(calls[0].init.headers && (calls[0].init.headers as Record<string, string>).Authorization, 'Bearer test-only');
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.model, 'gpt-image-2.5-flare');
    assert.equal(body.n, 2);
    assert.ok(!JSON.stringify(body).includes('gpt-5.5'), 'image requests must not use the shared Musk LLM model');

    const bananaSettings = normalizeImageGenerationApiSettings({
      ...settings,
      default_model: 'gemini-3.1-flash-image-preview',
    });
    calls.length = 0;
    await createImageGeneration({ settings: bananaSettings, prompt: 'test only', count: 2 });
    assert.equal(calls[0].url, 'https://api.ai-media.vip/v1/images/generations', 'AI Media VIP keeps the OpenAI-compatible image protocol for Banana models');
    const bananaBody = JSON.parse(String(calls[0].init.body));
    assert.equal(bananaBody.model, 'gemini-3.1-flash-image-preview');
    assert.equal(bananaBody.n, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('PASS: image_generation_api_v1 channel/model routing, AI Media VIP OpenAI-compatible payload, and no shared GPT-5.5 image path; no paid calls.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
