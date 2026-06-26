import assert from 'node:assert/strict';
import {
  buildVolcengineIpCreatePayload,
  createVolcengineIpVideoTask,
  deleteVolcengineIpVideoTask,
  getVolcengineIpTaskStatus,
  listVolcengineIpTasks,
} from '@/lib/provider/volcengine-ip';

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
  const payload = buildVolcengineIpCreatePayload({
    model: 'doubao-seedance-2-0-fast-test',
    prompt: '保持参考图 IP 角色外形，在干净背景中挥手。',
    generation_mode: 'all_in_one_reference',
    reference_image_urls: ['https://static.example.com/reference.jpg'],
    ratio: '16:9',
    resolution: '480p',
    duration: 4,
    seed: -1,
    generate_audio: true,
    watermark: false,
    client_request_id: 'volcengine-ip-smoke-001',
  });
  assert.equal(payload.model, 'doubao-seedance-2-0-fast-test');
  assert.equal(payload.resolution, '480p');
  assert.equal(payload.duration, 4);
  assert.equal(payload.content[0].type, 'text');
  assert.equal(payload.content[1].type, 'image_url');

  const captured: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    captured.push({ url, init: init || {} });

    if (init?.method === 'POST') {
      return jsonResponse({ id: 'cgt-task-001', status: 'queued' });
    }
    if (init?.method === 'GET' && url.includes('/cgt-task-001')) {
      return jsonResponse({
        id: 'cgt-task-001',
        model: 'doubao-seedance-2-0-fast-test',
        status: 'succeeded',
        content: {
          video_url: 'https://tos.example.com/video.mp4?X-Tos-Signature=secret',
        },
        usage: {
          completion_tokens: 32000,
        },
      });
    }
    if (init?.method === 'GET') {
      return jsonResponse({
        items: [{ id: 'cgt-task-001', status: 'succeeded' }],
        total: 1,
      });
    }
    if (init?.method === 'DELETE') {
      return jsonResponse({ id: 'cgt-task-001', deleted: true });
    }
    return jsonResponse({ error: { code: 'UnexpectedMethod' } }, 500);
  };

  const options = {
    fetchImpl,
    apiKey: 'test-api-key-not-real',
    model: 'doubao-seedance-2-0-fast-test',
    baseUrl: 'https://ark.example.com/api/v3/',
  };

  const created = await createVolcengineIpVideoTask({
    prompt: '保持参考图 IP 角色外形，在干净背景中挥手。',
    generation_mode: 'all_in_one_reference',
    reference_image_urls: ['https://static.example.com/reference.jpg'],
    ratio: '16:9',
    resolution: '480p',
    duration: 4,
    seed: -1,
  }, options);
  assert.equal(created.provider_task_id, 'cgt-task-001');

  const createRequest = captured[0];
  assert.equal(createRequest.url, 'https://ark.example.com/api/v3/contents/generations/tasks');
  assert.equal(createRequest.init.method, 'POST');
  assert.equal(headerValue(createRequest.init, 'Authorization'), 'Bearer test-api-key-not-real');
  const createBody = JSON.parse(String(createRequest.init.body));
  assert.equal(createBody.resolution, '480p');
  assert.equal(createBody.duration, 4);
  assert.equal(createBody.content[0].text, '保持参考图 IP 角色外形，在干净背景中挥手。');
  assert.equal(createBody.content[1].image_url.url, 'https://static.example.com/reference.jpg');
  assert.equal(JSON.stringify(createBody).includes('secret-volc-key'), false);

  const status = await getVolcengineIpTaskStatus('cgt-task-001', options);
  assert.equal(status.local_status, 'succeeded');
  assert.equal(status.result_video_url, 'https://tos.example.com/video.mp4?X-Tos-Signature=secret');
  assert.deepEqual(status.usage, { completion_tokens: 32000 });

  const listed = await listVolcengineIpTasks({
    page_num: 1,
    page_size: 20,
    filter_status: 'succeeded',
    filter_task_ids: ['cgt-task-001'],
    filter_model: 'doubao-seedance-2-0-fast-test',
  }, options);
  assert.equal(listed.total, 1);
  assert.equal(listed.items.length, 1);
  assert.ok(captured[2].url.includes('filter.status=succeeded'));
  assert.ok(captured[2].url.includes('filter.task_ids=cgt-task-001'));

  const deleted = await deleteVolcengineIpVideoTask('cgt-task-001', options);
  assert.equal(deleted.deleted, true);
  assert.equal(captured[3].init.method, 'DELETE');

  console.log('volcengine-ip-provider smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
