import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchH3ReferenceImageBytes, uploadH3ReferenceImagesForTask } from '@/lib/provider/h3-assets';

const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const uploadCalls: Array<Record<string, unknown>> = [];

const mockFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url.includes('/api/h3/inputs/images')) {
    const body = JSON.parse(String(init?.body || '{}')) as { filename?: string; content_b64?: string };
    uploadCalls.push({
      url,
      body: {
        filename: body.filename,
        content_b64_length: body.content_b64?.length || 0,
      },
    });
    return new Response(JSON.stringify({
      filename: `h3-${body.filename}`,
      original_filename: body.filename,
      size_bytes: Buffer.from(body.content_b64 || '', 'base64').byteLength,
      sha256: 'mock-sha256',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.endsWith('/not-image.mp4')) {
    return new Response(Buffer.from('not-image'), {
      status: 200,
      headers: { 'content-type': 'video/mp4' },
    });
  }
  return new Response(imageBytes, {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
};

async function main() {
  const bytes = await fetchH3ReferenceImageBytes('https://assets.example.com/first.png', mockFetch);
  assert.equal(Buffer.compare(bytes, imageBytes), 0);

  await assert.rejects(
    () => fetchH3ReferenceImageBytes('https://assets.example.com/not-image.mp4', mockFetch),
    /只支持图片类型/,
  );

  const result = await uploadH3ReferenceImagesForTask({
    firstFrameUrl: 'https://assets.example.com/first-frame.png',
    lastFrameUrl: 'https://assets.example.com/last-frame.png',
    options: {
      baseUrl: 'https://h3-api.example.com',
      apiToken: 'user-token',
      fetchImpl: mockFetch,
    },
  });

  assert.equal(result.first_frame, 'h3-first-frame.png');
  assert.equal(result.last_frame, 'h3-last-frame.png');
  assert.equal(result.transfers.length, 2);
  assert.equal(uploadCalls.length, 2);
  assert.equal(JSON.stringify(uploadCalls).includes('user-token'), false, 'smoke 日志不能包含 token 明文');
  assert.equal(result.transfers[0].sha256, 'mock-sha256');

  const routeSource = readFileSync('src/app/api/tasks/create/route.ts', 'utf8');
  assert.match(routeSource, /extraReferenceImageUrls/, '多余参考图必须从直传素材中拆出来');
  assert.match(routeSource, /参考图上下文（不直接传给 H3 文件字段）/, '多余参考图只能进入可见上下文');
  assert.match(routeSource, /参考视频上下文（H3 第一版不直传视频文件）/, '参考视频必须进入可见上下文');
  assert.match(routeSource, /参考音频上下文（H3 第一版不直传音频文件）/, '参考音频必须进入可见上下文');

  console.log('h3-reference-image-handoff smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
