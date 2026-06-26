import assert from 'node:assert/strict';
import {
  AI_MEDIAKIT_DEFAULT_BASE_URL,
  createEnhanceVideoTask,
  getAiMediaKitTaskStatus,
  requestMediaUploadUrl,
  uploadMediaToAiMediaKit,
} from '@/lib/provider/aimediakit-enhance-video';

const previousEnv = {
  AI_MEDIAKIT_API_KEY: process.env.AI_MEDIAKIT_API_KEY,
  AI_MEDIAKIT_BASE_URL: process.env.AI_MEDIAKIT_BASE_URL,
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

function assertNoApiKeyInPayload(payload: unknown) {
  assert.equal(JSON.stringify(payload).includes('smoke-mediakit-key'), false);
}

async function assertRejectsMessage(action: () => Promise<unknown>, pattern: RegExp) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
    return true;
  });
}

async function main() {
  process.env.AI_MEDIAKIT_API_KEY = 'smoke-mediakit-key-1234567890';
  delete process.env.AI_MEDIAKIT_BASE_URL;

  const uploadUrl = 'https://upload.example.com/bucket/source.mp4?auth_key=secret&X-Tos-Signature=secret';
  const failingUploadUrl = 'https://upload.example.com/bucket/fail.mp4?auth_key=secret&X-Tos-Signature=secret';
  const captured: CapturedRequest[] = [];
  const outputLines: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    captured.push({ url, init: init || {} });

    if (url.endsWith('/api/v1/tools/enhance-video') && init?.method === 'POST') {
      return jsonResponse({ task_id: 'enhance-task-001' });
    }

    if (url.endsWith('/api/v1/tasks/enhance-task-001') && init?.method === 'GET') {
      return jsonResponse({
        task_id: 'enhance-task-001',
        status: 'completed',
        result: {
          video_url: 'https://result.example.com/out.mp4?auth_key=result-secret',
          duration: 8,
          fps: 60,
          resolution: '1080p',
          tool_version: 'professional',
        },
      });
    }

    if (url.endsWith('/api/v1/tasks/failed-task-001') && init?.method === 'GET') {
      return jsonResponse({
        task_id: 'failed-task-001',
        status: 'failed',
        error: {
          code: 'InvalidParameter',
          message: 'fps must be between 15 and 120: https://example.com/bad.mp4?auth_key=secret&X-Tos-Signature=secret',
          type: 'invalid_request_error',
          param: 'fps',
          request_id: 'req-smoke-001',
        },
      });
    }

    if (url.endsWith('/api/v1/tools-sync/request-media-upload-url') && init?.method === 'POST') {
      return jsonResponse({
        file_id: 'mediakit://media-file-001',
        method: 'PUT',
        upload_headers: {
          'Content-Type': 'video/mp4',
          'x-tos-meta-source': 'smoke',
        },
        upload_url: uploadUrl,
      });
    }

    if (url === uploadUrl && init?.method === 'PUT') {
      return new Response('', { status: 200 });
    }

    if (url === failingUploadUrl && init?.method === 'PUT') {
      throw new Error(`upload_url failed: ${failingUploadUrl}`);
    }

    return jsonResponse({ error: { code: 'UnexpectedRequest', message: `${init?.method || 'GET'} ${url}` } }, 500);
  };

  const created = await createEnhanceVideoTask(
    {
      video_url: 'mediakit://media-file-001',
      tool_version: 'professional',
      resolution: '1080p',
      fps: 60,
      client_token: 'smoke-client-token',
    },
    { fetchImpl },
  );
  assert.equal(created.provider_task_id, 'enhance-task-001');

  const createRequest = captured[0];
  assert.ok(createRequest);
  assert.equal(createRequest.url, `${AI_MEDIAKIT_DEFAULT_BASE_URL}/api/v1/tools/enhance-video`);
  assert.equal(createRequest.init.method, 'POST');
  assert.equal(headerValue(createRequest.init, 'Authorization'), 'Bearer smoke-mediakit-key-1234567890');
  assert.equal(headerValue(createRequest.init, 'Content-Type'), 'application/json');
  const createBody = JSON.parse(String(createRequest.init.body));
  assert.equal(createBody.video_url, 'mediakit://media-file-001');
  assert.equal('file_id' in createBody, false);
  assert.equal(createBody.tool_version, 'professional');
  assert.equal(createBody.resolution, '1080p');
  assert.equal(createBody.fps, 60);
  assertNoApiKeyInPayload(createBody);

  const completed = await getAiMediaKitTaskStatus('enhance-task-001', { fetchImpl });
  assert.equal(completed.provider_task_id, 'enhance-task-001');
  assert.equal(completed.provider_status, 'completed');
  assert.equal(completed.local_status, 'succeeded');
  assert.equal(completed.result_video_url, 'https://result.example.com/out.mp4?auth_key=result-secret');
  assert.equal(completed.duration, 8);
  assert.equal(completed.frames_per_second, 60);
  assert.equal(completed.resolution, '1080p');
  assert.equal(completed.tool_version, 'professional');

  const failed = await getAiMediaKitTaskStatus('failed-task-001', { fetchImpl });
  assert.equal(failed.local_status, 'failed');
  assert.equal(failed.error?.code, 'InvalidParameter');
  assert.ok(failed.error?.message?.includes('fps must be between 15 and 120'));
  assert.equal(failed.error?.type, 'invalid_request_error');
  assert.equal(failed.error?.param, 'fps');
  assert.ok(failed.error_message?.includes('[InvalidParameter] fps must be between 15 and 120'));
  assert.equal(failed.error_message?.includes('auth_key=secret'), false);
  assert.equal(failed.error_message?.includes('X-Tos-Signature=secret'), false);
  assert.equal(failed.error_message?.includes('https://example.com/bad.mp4?auth_key=secret&X-Tos-Signature=secret'), false);

  await assertRejectsMessage(
    () => createEnhanceVideoTask({ video_url: 'mediakit://media-file-001', resolution: '720p', resolution_limit: 720 }, { fetchImpl }),
    /resolution 与 resolution_limit 不能同时传/,
  );
  await assertRejectsMessage(
    () => createEnhanceVideoTask({ video_url: 'mediakit://media-file-001', fps: 121 }, { fetchImpl }),
    /fps 必须在 15 到 120 之间/,
  );
  await assertRejectsMessage(
    () => createEnhanceVideoTask({ video_url: 'mediakit://media-file-001', client_token: 'x'.repeat(65) }, { fetchImpl }),
    /client_token 最多 64 个字符/,
  );
  await assertRejectsMessage(
    () => createEnhanceVideoTask({ video_url: 'mediakit://media-file-001', client_token: 'bad\nvalue' }, { fetchImpl }),
    /client_token 只能包含 ASCII 可打印字符/,
  );
  await assertRejectsMessage(
    () => createEnhanceVideoTask({ video_url: 'ftp://media-file-001' }, { fetchImpl }),
    /video_url 协议只允许/,
  );

  const uploadTicket = await requestMediaUploadUrl(
    {
      file_name: 'source.mp4',
      content_type: 'video/mp4',
      content_length: 4,
    },
    { fetchImpl },
  );
  assert.equal(uploadTicket.file_id, 'mediakit://media-file-001');
  assert.equal(uploadTicket.method, 'PUT');
  assert.equal(uploadTicket.upload_headers['Content-Type'], 'video/mp4');
  assert.equal(uploadTicket.upload_url, uploadUrl);

  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    outputLines.push(args.map(String).join(' '));
  };
  try {
    const uploaded = await uploadMediaToAiMediaKit(
      {
        upload_url: uploadTicket.upload_url,
        method: uploadTicket.method,
        upload_headers: uploadTicket.upload_headers,
        body: new Uint8Array([1, 2, 3, 4]),
      },
      { fetchImpl },
    );
    assert.equal(uploaded.ok, true);
    assert.equal(uploaded.status, 200);
  } finally {
    console.log = originalLog;
  }

  const putRequest = captured.find((request) => request.url === uploadUrl);
  assert.ok(putRequest);
  assert.equal(putRequest.init.method, 'PUT');
  assert.equal(headerValue(putRequest.init, 'Content-Type'), 'video/mp4');
  assert.equal(headerValue(putRequest.init, 'x-tos-meta-source'), 'smoke');
  assert.equal(String(headerValue(putRequest.init, 'Content-Type')).includes('multipart/form-data'), false);
  assert.ok(putRequest.init.body instanceof Uint8Array);
  assert.equal(outputLines.join('\n').includes(uploadUrl), false);

  await assert.rejects(
    () => uploadMediaToAiMediaKit(
      {
        upload_url: failingUploadUrl,
        method: 'PUT',
        upload_headers: uploadTicket.upload_headers,
        body: new Uint8Array([1, 2, 3, 4]),
      },
      { fetchImpl },
    ),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(failingUploadUrl), false);
      assert.equal(error.message.includes('auth_key=secret'), false);
      assert.equal(error.message.includes('X-Tos-Signature=secret'), false);
      return true;
    },
  );

  restoreEnv();
  console.log('aimediakit-enhance-video smoke passed');
}

main().catch((error) => {
  restoreEnv();
  throw error;
});
