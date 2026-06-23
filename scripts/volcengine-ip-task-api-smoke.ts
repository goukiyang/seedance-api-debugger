import assert from 'node:assert/strict';
import {
  createVolcengineIpVideoTask,
  deleteVolcengineIpVideoTask,
  getVolcengineIpTaskStatus,
  listVolcengineIpTasks,
} from '@/lib/provider/volcengine-ip';

const previousEnv = {
  VOLCENGINE_IP_API_KEY: process.env.VOLCENGINE_IP_API_KEY,
  VOLCENGINE_IP_MODEL: process.env.VOLCENGINE_IP_MODEL,
  VOLCENGINE_IP_BASE_URL: process.env.VOLCENGINE_IP_BASE_URL,
  ARK_API_KEY: process.env.ARK_API_KEY,
  ARK_MODEL: process.env.ARK_MODEL,
  ARK_BASE_URL: process.env.ARK_BASE_URL,
};

type CapturedRequest = {
  url: string;
  init: RequestInit;
};

function restoreEnv() {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

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

async function expectConfigurationGuard() {
  delete process.env.VOLCENGINE_IP_API_KEY;
  delete process.env.VOLCENGINE_IP_MODEL;
  delete process.env.VOLCENGINE_IP_BASE_URL;
  delete process.env.ARK_API_KEY;
  delete process.env.ARK_MODEL;
  delete process.env.ARK_BASE_URL;

  await assert.rejects(
    () => createVolcengineIpVideoTask({
      prompt: '授权角色跑步',
      generation_mode: 'all_in_one_reference',
      reference_image_urls: ['asset://ip-character-001'],
    }),
    /volcengine_ip_not_configured/,
  );
}

async function main() {
  await expectConfigurationGuard();

  process.env.VOLCENGINE_IP_API_KEY = 'secret-volc-key-1234567890';
  process.env.VOLCENGINE_IP_MODEL = 'doubao-seedance-2-0-fast-test';
  process.env.VOLCENGINE_IP_BASE_URL = 'https://ark.example.com/api/v3/';

  const captured: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    captured.push({ url, init: init || {} });

    if (init?.method === 'POST') {
      return jsonResponse({ id: 'cgt-task-001' });
    }
    if (init?.method === 'GET' && url.includes('/cgt-task-001')) {
      return jsonResponse({
        model: 'doubao-seedance-2-0-fast-test',
        status: 'succeeded',
        content: {
          video_url: 'https://tos.example.com/video.mp4?X-Tos-Signature=secret',
          last_frame_url: 'https://tos.example.com/last.png?X-Tos-Signature=secret',
        },
        usage: {
          completion_tokens: 35800,
          total_tokens: 35800,
        },
      });
    }
    if (init?.method === 'GET') {
      return jsonResponse({
        items: [
          {
            id: 'cgt-task-001',
            status: 'succeeded',
            content: { video_url: 'https://tos.example.com/video.mp4' },
          },
        ],
        total: 1,
      });
    }
    if (init?.method === 'DELETE') {
      return jsonResponse({});
    }
    return jsonResponse({ error: { code: 'UnknownMethod', message: 'unexpected method' } }, 500);
  };

  const created = await createVolcengineIpVideoTask(
    {
      prompt: '让授权角色在城市街头挥手',
      generation_mode: 'all_in_one_reference',
      ratio: '16:9',
      duration: 5,
      reference_image_urls: ['asset://ip-character-001'],
      client_request_id: 'local-task-001',
    },
    { fetchImpl },
  );

  assert.equal(created.provider_task_id, 'cgt-task-001');
  assert.equal((created.raw as Record<string, unknown>).id, 'cgt-task-001');

  const createRequest = captured[0];
  assert.ok(createRequest);
  assert.equal(createRequest.url, 'https://ark.example.com/api/v3/contents/generations/tasks');
  assert.equal(createRequest.init.method, 'POST');
  assert.equal(headerValue(createRequest.init, 'Authorization'), 'Bearer secret-volc-key-1234567890');
  assert.equal(headerValue(createRequest.init, 'Content-Type'), 'application/json');
  const createBody = JSON.parse(String(createRequest.init.body));
  assert.equal(createBody.model, 'doubao-seedance-2-0-fast-test');
  assert.equal(createBody.content[0].type, 'text');
  assert.equal(createBody.content[1].image_url.url, 'asset://ip-character-001');
  assert.equal(JSON.stringify(createBody).includes('secret-volc-key'), false);

  const status = await getVolcengineIpTaskStatus('cgt-task-001', { fetchImpl });
  assert.equal(status.provider_task_id, 'cgt-task-001');
  assert.equal(status.provider_status, 'succeeded');
  assert.equal(status.local_status, 'succeeded');
  assert.equal(status.result_video_url, 'https://tos.example.com/video.mp4?X-Tos-Signature=secret');
  assert.equal(status.result_last_frame_url, 'https://tos.example.com/last.png?X-Tos-Signature=secret');
  assert.deepEqual(status.usage, { completion_tokens: 35800, total_tokens: 35800 });

  const statusRequest = captured[1];
  assert.ok(statusRequest);
  assert.equal(statusRequest.url, 'https://ark.example.com/api/v3/contents/generations/tasks/cgt-task-001');
  assert.equal(statusRequest.init.method, 'GET');

  const listed = await listVolcengineIpTasks(
    {
      page_num: 2,
      page_size: 50,
      filter_status: 'succeeded',
      filter_task_ids: ['cgt-task-001', 'cgt-task-002'],
      filter_model: 'doubao-seedance-2-0-fast-test',
    },
    { fetchImpl },
  );
  assert.equal(listed.total, 1);
  assert.equal(listed.items.length, 1);

  const listRequest = captured[2];
  assert.ok(listRequest);
  assert.equal(listRequest.init.method, 'GET');
  assert.ok(listRequest.url.includes('/contents/generations/tasks?'));
  assert.ok(listRequest.url.includes('page_num=2'));
  assert.ok(listRequest.url.includes('page_size=50'));
  assert.ok(listRequest.url.includes('filter.status=succeeded'));
  assert.ok(listRequest.url.includes('filter.task_ids=cgt-task-001'));
  assert.ok(listRequest.url.includes('filter.task_ids=cgt-task-002'));
  assert.ok(listRequest.url.includes('filter.model=doubao-seedance-2-0-fast-test'));

  const deleted = await deleteVolcengineIpVideoTask('cgt-task-001', { fetchImpl });
  assert.equal(deleted.provider_task_id, 'cgt-task-001');
  assert.equal(deleted.deleted, true);

  const deleteRequest = captured[3];
  assert.ok(deleteRequest);
  assert.equal(deleteRequest.url, 'https://ark.example.com/api/v3/contents/generations/tasks/cgt-task-001');
  assert.equal(deleteRequest.init.method, 'DELETE');

  restoreEnv();
  console.log('volcengine-ip-task-api smoke passed');
}

main().catch((error) => {
  restoreEnv();
  throw error;
});
