import assert from 'node:assert/strict';
import { requestStudioImages, StudioProviderError } from '../src/lib/image-studio/provider';
import { readStudioImage } from '../src/lib/image-studio/media';

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
  let downloads = 0;
  const linkResponse = async () => Response.json({ data: [{ url: 'https://example.invalid/result.png?private=not-logged' }] });
  const linked = await requestStudioImages(params, linkResponse, async (_url, signal) => {
    downloads++; assert.equal(signal, params.signal); return Buffer.from('image');
  });
  assert.deepEqual(linked.images, ['aW1hZ2U=']); assert.equal(downloads, 1);
  await assert.rejects(requestStudioImages(params, linkResponse, async () => { throw new Error('secret URL or key'); }), error => {
    assert.ok(error instanceof StudioProviderError && error.stage === 'download' && !error.message.includes('secret')); return true;
  });
  await assert.rejects(requestStudioImages(params, async () => Response.json({ data: [{ url: 'http://127.0.0.1/private' }] })));
  await assert.rejects(requestStudioImages(params, async () => Response.json({ data: [null] })));
  await assert.rejects(readStudioImage('https://127.0.0.1/private'));
  await assert.rejects(readStudioImage('https://169.254.169.254/latest/meta-data'));
  await assert.rejects(readStudioImage('file:///etc/passwd'));
  if (process.env.STUDIO_PUBLIC_DOWNLOAD_TEST === '1') {
    const bytes = await readStudioImage('https://api.muskapis.com/logo.svg', AbortSignal.timeout(15000));
    assert.ok(bytes.length > 0, 'real Node HTTPS lookup must accept the pinned address');
  }
  assert.equal(requests.length, 2);
  console.log('PASS: text/image payloads, URL/base64 outputs, private-address rejection, limits, sanitized stage errors; no paid calls.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
