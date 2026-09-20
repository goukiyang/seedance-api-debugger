import assert from 'node:assert/strict';
import { requestStudioImages } from '../src/lib/image-studio/provider';

async function main() {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init: init || {} });
    return Response.json({ data: [{ b64_json: 'aW1hZ2U=' }], usage: { total_tokens: 10 } });
  };
  const params = {
    baseUrl: 'https://example.invalid/v1/', apiKey: 'test-only', model: 'gpt-image-2.5-flare',
    prompt: 'fixed context\nuser prompt', count: 1, images: [], signal: AbortSignal.timeout(1000),
  };
  const result = await requestStudioImages(params, fetcher);
  assert.equal(result.images.length, 1);
  assert.equal(requests[0].url, 'https://example.invalid/v1/images/generations');
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    model: params.model, prompt: params.prompt, n: 1, output_format: 'png',
  });
  await requestStudioImages({ ...params, images: [
    { bytes: new Uint8Array([1]), mimeType: 'image/png' },
    { bytes: new Uint8Array([2]), mimeType: 'image/jpeg' },
  ] }, fetcher);
  assert.equal(requests[1].url, 'https://example.invalid/v1/images/edits');
  const form = requests[1].init.body as FormData;
  assert.equal(form.getAll('image[]').length, 2);
  assert.equal(form.get('prompt'), params.prompt);
  assert.equal(form.get('n'), '1');
  for (const count of [0, 9, 1.5, NaN]) await assert.rejects(requestStudioImages({ ...params, count }, fetcher));
  await assert.rejects(requestStudioImages({ ...params, model: 'unknown' }, fetcher));
  await assert.rejects(requestStudioImages(params, async () => Response.json({ data: [] })));
  await assert.rejects(requestStudioImages(params, async () => new Response('secret upstream error', { status: 502 })), error => {
    assert.ok(error instanceof Error && !error.message.includes('secret'));
    return true;
  });
  assert.equal(requests.length, 2);
  console.log('PASS: text/image payloads, model/count limits, empty output, sanitized upstream failure; no paid calls.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
