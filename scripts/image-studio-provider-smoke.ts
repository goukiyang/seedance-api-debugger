import assert from 'node:assert/strict';
import { requestStudioImages, StudioProviderError } from '../src/lib/image-studio/provider';
import { readStudioImage } from '../src/lib/image-studio/media';
import { normalizeStudioRatio, STUDIO_RATIOS, studioRatioSize } from '../src/lib/image-studio/ratios';

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
    { bytes: new Uint8Array([3]), mimeType: 'image/png' },
    { bytes: new Uint8Array([4]), mimeType: 'image/png' },
    { bytes: new Uint8Array([5]), mimeType: 'image/png' },
    { bytes: new Uint8Array([6]), mimeType: 'image/png' },
    { bytes: new Uint8Array([7]), mimeType: 'image/png' },
    { bytes: new Uint8Array([8]), mimeType: 'image/png' },
    { bytes: new Uint8Array([9]), mimeType: 'image/png' },
    { bytes: new Uint8Array([10]), mimeType: 'image/png' },
  ] }, fetcher);
  assert.equal(requests[1].url, 'https://example.invalid/v1/images/edits');
  const form = requests[1].init.body as FormData;
  assert.equal(form.getAll('image[]').length, 10, 'all ten references must reach the provider request');
  assert.equal(form.get('prompt'), params.prompt);
  assert.equal(form.get('n'), '1');
  assert.equal(studioRatioSize('auto'), undefined);
  assert.equal(normalizeStudioRatio('1920:1080'), '16:9');
  assert.equal(normalizeStudioRatio('1.5：1'), '3:2');
  assert.throws(() => normalizeStudioRatio('99999.99:50000'));
  for (const value of ['1.41:1', '9999:5000', '21:9']) assert.equal(normalizeStudioRatio(normalizeStudioRatio(value)), normalizeStudioRatio(value));
  for (const invalid of ['0:1', '4:1', '1:4', '-1:2', 'NaN:1', '1:Infinity', 'garbage', '1:']) assert.throws(() => normalizeStudioRatio(invalid));
  for (const ratio of [...STUDIO_RATIOS, '5:3', '1.41:1', '9999:5000']) {
    const size = studioRatioSize(ratio)!;
    const [w, h] = size.split('x').map(Number);
    const [rw, rh] = normalizeStudioRatio(ratio).split(':').map(Number);
    assert.ok(w % 16 === 0 && h % 16 === 0 && w * h >= 655360 && w * h <= 1572864 && Math.max(w, h) <= 2048);
    assert.ok(Math.abs(w / h / (rw / rh) - 1) < .01);
  }
  await requestStudioImages({ ...params, size: studioRatioSize('16:9') }, fetcher);
  assert.equal(JSON.parse(String(requests[2].init.body)).size, '1280x720');
  await requestStudioImages({ ...params, size: studioRatioSize('5:3'), images: [{ bytes: new Uint8Array([1]), mimeType: 'image/png' }] }, fetcher);
  assert.equal((requests[3].init.body as FormData).get('size'), '1360x816');
  await assert.rejects(requestStudioImages({ ...params, size: '99999x16' }, fetcher));
  for (const count of [0, 9, 1.5, NaN]) await assert.rejects(requestStudioImages({ ...params, count }, fetcher));
  await assert.rejects(requestStudioImages({ ...params, model: 'unknown' }, fetcher));
  await assert.rejects(requestStudioImages({ ...params, images: Array.from({ length: 11 }, () => ({ bytes: new Uint8Array([1]), mimeType: 'image/png' })) }, fetcher), /最多使用 10 张/);
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
  assert.equal(requests.length, 4);
  console.log('PASS: text/image payloads, URL/base64 outputs, private-address rejection, limits, sanitized stage errors; no paid calls.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
