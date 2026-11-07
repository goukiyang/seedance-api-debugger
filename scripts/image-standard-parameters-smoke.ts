import assert from 'node:assert/strict';
import { isStandardGptImageParameter } from '../src/lib/image-studio/model-catalog';
import { sharedImageStudioChannelIssue } from '../src/lib/image-studio/shared-capabilities';
import type { ImageStudioChannel } from '../src/lib/image-studio/channels';
import { requestStudioImages } from '../src/lib/image-studio/provider';
import { imageOutputSize } from '../src/lib/image-generation/resolution';

async function main() {
  for (const model of ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst']) {
    const capability = { ready: true, disabledReason: null, billingMode: 'fixed' as const, fixedPoints: 5,
      billingSource: null, actualQuoteRequired: false, qualities: ['auto'], resolutions: ['1K'], ratios: ['1:1'], maxReferences: 0 };
    const channel: ImageStudioChannel = { id: 'image-11111111-1111-4111-8111-111111111111', label: 'Fixture', supplierName: null,
      configured: true, enabled: true, ready: true, disabledReason: null, models: { [model]: capability } };
    const values = { quality: 'max', resolution: '4K', ratio: '1:1', referenceCount: 0 };
    assert.equal(sharedImageStudioChannelIssue(channel, model, values), null);
    assert.ok(sharedImageStudioChannelIssue({ ...channel, enabled: false }, model, values));
    assert.ok(sharedImageStudioChannelIssue(channel, model, { ...values, referenceCount: 1 }));
    assert.ok(sharedImageStudioChannelIssue(channel, model, { ...values, quality: 'unlisted' }));
    assert.ok(sharedImageStudioChannelIssue(channel, model, { ...values, resolution: '8K' }));
    const size = imageOutputSize(model, values.resolution, values.ratio, 'musk');
    for (const [selected, expected] of [['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'high'], ['max', 'high']]) {
      let sent: Record<string, unknown> | undefined;
      const request = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture', protocol: 'openai_images' as const,
        model, prompt: 'public synthetic fixture', quality: selected, size, ratio: values.ratio,
        ratioContractVersion: 2 as const, count: 1, images: [], signal: AbortSignal.timeout(1000) };
      await requestStudioImages(request, async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return Response.json({ data: [{ b64_json: 'aW1hZ2U=' }] });
      });
      assert.equal(request.quality, selected);
      assert.equal(sent?.model, model); assert.equal(sent?.quality, expected); assert.equal(sent?.size, size);
    }
  }
  await requestStudioImages({ baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture', protocol: 'openai_images',
    model: 'gpt-image-2.5-sunburst', prompt: 'synthetic', quality: 'max', count: 1, images: [],
    signal: AbortSignal.timeout(1000) }, async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).quality, 'max');
    return Response.json({ data: [{ b64_json: 'aW1hZ2U=' }] });
  });
  assert.equal(isStandardGptImageParameter('gpt-image-2', 'quality', 'high'), true);
  assert.equal(isStandardGptImageParameter('gpt-image-2.5-sunburst', 'resolution', '4K'), true);
  assert.equal(isStandardGptImageParameter('gemini-nano-banana-2.1', 'quality', 'high'), false);
  assert.equal(isStandardGptImageParameter('unlisted', 'quality', 'max'), false);
  console.log('PASS standard GPT parameters: frontend admission, real provider serialization, disable/reference/native boundaries; no network');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
