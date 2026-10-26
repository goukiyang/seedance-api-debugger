import assert from 'node:assert/strict';
import { BANANA_IMAGE_API_SETTING_KEY, IMAGE_GENERATION_API_SETTING_KEY, getImageGenerationApiSettings, getImageGenerationChannels, getImageGenerationSettingsForModel, isImageGenerationApiReady, normalizeImageGenerationApiSettings, selectImageGenerationSettings } from '../src/lib/integrations/image-generation';
import { IMAGE_STUDIO_MODELS } from '../src/lib/image-studio/model-catalog';
import { requestStudioImages } from '../src/lib/image-studio/provider';

async function main() {
  const shared = normalizeImageGenerationApiSettings({ enabled: true, api_key: 'shared-test-key', default_model: 'gpt-image-2', base_url: 'https://shared.example/', provider: 'musk' });
  const banana = normalizeImageGenerationApiSettings({ enabled: true, api_key: 'banana-test-key', base_url: 'https://banana.example/', provider: 'musk' });
  const rows = new Map([[IMAGE_GENERATION_API_SETTING_KEY, shared], [BANANA_IMAGE_API_SETTING_KEY, banana]]);
  const client = { platformSetting: { findUnique: async ({ where }: { where: { key: string } }) => rows.has(where.key) ? { value_json: JSON.stringify(rows.get(where.key)) } : null } } as unknown as Parameters<typeof getImageGenerationApiSettings>[0];
  const channels = await getImageGenerationChannels(client);
  for (const model of IMAGE_STUDIO_MODELS) {
    const isBanana = model.startsWith('gemini-');
    const selected = selectImageGenerationSettings(channels, model);
    assert.equal(selected.api_key, isBanana ? 'banana-test-key' : 'shared-test-key');
    assert.equal(selected.base_url, isBanana ? 'https://banana.example/' : 'https://shared.example/');
    assert.equal(selected.default_model, model);
    let requests = 0;
    await requestStudioImages({ provider:'musk', baseUrl:selected.base_url, apiKey:selected.api_key!, model, prompt:'fixture', count:1, images:[], signal:new AbortController().signal }, async (url, init) => {
      requests++;
      assert.equal(new URL(String(url)).hostname, isBanana ? 'banana.example' : 'shared.example');
      assert.equal((init?.headers as Record<string,string>).Authorization, `Bearer ${isBanana ? 'banana-test-key' : 'shared-test-key'}`);
      return Response.json(isBanana ? { candidates:[{content:{parts:[{inlineData:{data:'eA=='}}]}}] } : {data:[{b64_json:'eA=='}]});
    });
    assert.equal(requests, 1);
  }
  rows.delete(BANANA_IMAGE_API_SETTING_KEY);
  const missing = await getImageGenerationSettingsForModel(IMAGE_STUDIO_MODELS[0], client);
  assert.equal(missing.api_key, null);
  assert.equal(isImageGenerationApiReady(missing), false);
  assert.equal(isImageGenerationApiReady(await getImageGenerationSettingsForModel('gpt-image-2', client)), true);
  rows.set(BANANA_IMAGE_API_SETTING_KEY, { ...banana, api_key:'replacement-test-key' });
  assert.equal((await getImageGenerationSettingsForModel(IMAGE_STUDIO_MODELS[1], client)).api_key, 'replacement-test-key');
  rows.set(IMAGE_GENERATION_API_SETTING_KEY, { ...shared, enabled:false });
  assert.equal(isImageGenerationApiReady(await getImageGenerationSettingsForModel(IMAGE_STUDIO_MODELS[0], client)), true);
  assert.equal(isImageGenerationApiReady(await getImageGenerationSettingsForModel('gpt-image-2', client)), false);
  assert.equal(shared.api_key, 'shared-test-key');
  console.log('PASS: model-specific credentials/endpoints, no fallback, independent availability, immediate reread; mocked transport only, no database/network/API cost.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
