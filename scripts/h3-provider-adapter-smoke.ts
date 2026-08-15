import assert from 'node:assert/strict';
import {
  H3_ALLOWED_ASPECT_RATIOS,
  H3_ALLOWED_PRESET_IDS,
  H3RequestError,
  buildH3GeneratePayload,
  createH3VideoJob,
  getH3Health,
  getH3TaskStatus,
  listH3JobOutputs,
  listH3Presets,
  uploadH3ReferenceImage,
} from '@/lib/provider/h3';

type FetchCall = {
  url: string;
  init?: RequestInit;
  body?: unknown;
};

const calls: FetchCall[] = [];

const fetchImpl: typeof fetch = async (url, init) => {
  const rawBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  calls.push({ url: String(url), init, body: rawBody });

  if (String(url).endsWith('/health')) {
    return Response.json({
      api: 'ok',
      default_preset: 'larry_v4_6step',
      preset_count: 3,
      worker: { worker: 'ok', comfyui: 'ok' },
    });
  }
  if (String(url).endsWith('/api/h3/presets')) {
    return Response.json({
      presets: H3_ALLOWED_PRESET_IDS.map((id) => ({ id })),
    });
  }
  if (String(url).endsWith('/api/h3/inputs/images')) {
    return Response.json({
      filename: 'h3ref-20260815-013000-abc12345.png',
      original_filename: rawBody.filename,
      size_bytes: 11,
      sha256: 'sha256-smoke',
    });
  }
  if (String(url).endsWith('/api/h3/generate')) {
    return Response.json({
      job_id: 'h3-20260815-013000-abc12345',
      status: 'pending',
      preset: rawBody.preset_id,
      request: rawBody,
      outputs: [],
    });
  }
  if (String(url).endsWith('/api/h3/jobs/h3-20260815-013000-abc12345')) {
    return Response.json({
      job_id: 'h3-20260815-013000-abc12345',
      status: 'done',
      preset: 'larry_v4_6step',
      resolved: { seed: 123456 },
      outputs: [{ index: 0, kind: 'video', download_url: '/api/h3/jobs/h3-20260815-013000-abc12345/outputs/0' }],
    });
  }
  if (String(url).endsWith('/api/h3/jobs/h3-20260815-013000-abc12345/outputs')) {
    return Response.json({
      job_id: 'h3-20260815-013000-abc12345',
      outputs: [{ index: 0, filename: 'out.mp4', kind: 'video', download_url: '/api/h3/jobs/h3-20260815-013000-abc12345/outputs/0' }],
    });
  }
  if (String(url).endsWith('/api/h3/generate-queue-full')) {
    return new Response(JSON.stringify({ error: 'queue is full' }), {
      status: 503,
      headers: { 'content-type': 'application/json', 'retry-after': '7' },
    });
  }

  return new Response('not found', { status: 404 });
};

async function main() {
  assert.deepEqual(H3_ALLOWED_PRESET_IDS, ['larry_v4_6step', 'larry_v4_8step', 'lightx2v_4step_turbo']);
  assert.deepEqual(H3_ALLOWED_ASPECT_RATIOS, ['16:9', '9:16', '1:1', '4:3', '3:4']);

  const health = await getH3Health({ baseUrl: 'https://h3-api.example.com/', fetchImpl });
  assert.equal(health.api, 'ok');
  assert.equal(calls.at(-1)?.url, 'https://h3-api.example.com/health');
  assert.equal((calls.at(-1)?.init?.headers as Record<string, string> | undefined)?.Authorization, undefined);

  await listH3Presets({ baseUrl: 'https://h3-api.example.com', apiToken: 'secret-user-token', fetchImpl });
  assert.equal(calls.at(-1)?.url, 'https://h3-api.example.com/api/h3/presets');
  assert.equal((calls.at(-1)?.init?.headers as Record<string, string>).Authorization, 'Bearer secret-user-token');

  const uploaded = await uploadH3ReferenceImage({
    filename: 'first-frame.png',
    contentB64: Buffer.from('hello image').toString('base64'),
  }, { baseUrl: 'https://h3-api.example.com', apiToken: 'secret-user-token', fetchImpl });
  assert.equal(uploaded.filename, 'h3ref-20260815-013000-abc12345.png');
  assert.equal((calls.at(-1)?.body as Record<string, unknown>).filename, 'first-frame.png');
  assert.equal((calls.at(-1)?.body as Record<string, unknown>).content_b64, Buffer.from('hello image').toString('base64'));

  const payload = buildH3GeneratePayload({
    prompt: 'A clean product video.',
    preset_id: 'larry_v4_8step',
    audio_prompt: 'soft room tone',
    music_prompt: 'light ambient music',
    aspect_ratio: '9:16',
    duration_sec: 15,
    seed: -1,
    first_frame: 'h3ref-first.png',
    last_frame: 'h3ref-last.png',
    metadata: { external_user_id: 'user_1' },
    width: 9999,
    height: 9999,
  });
  assert.deepEqual(payload, {
    preset_id: 'larry_v4_8step',
    prompt: 'A clean product video.',
    audio_prompt: 'soft room tone',
    music_prompt: 'light ambient music',
    aspect_ratio: '9:16',
    duration_sec: 15,
    seed: -1,
    first_frame: 'h3ref-first.png',
    last_frame: 'h3ref-last.png',
    metadata: { external_user_id: 'user_1' },
  });

  assert.throws(() => buildH3GeneratePayload({ prompt: 'x', preset_id: 'unknown' }), /H3 preset 只允许/);
  assert.throws(() => buildH3GeneratePayload({ prompt: 'x', aspect_ratio: '21:9' }), /H3 比例只允许/);
  assert.throws(() => buildH3GeneratePayload({ prompt: 'x', duration_sec: 16 }), /H3 时长最多 15 秒/);
  assert.throws(() => buildH3GeneratePayload({ prompt: 'x', seed: 1.5 }), /H3 seed/);

  const created = await createH3VideoJob(payload, {
    baseUrl: 'https://h3-api.example.com',
    apiToken: 'secret-user-token',
    fetchImpl,
  });
  assert.equal(created.provider_task_id, 'h3-20260815-013000-abc12345');
  assert.equal(calls.at(-1)?.url, 'https://h3-api.example.com/api/h3/generate');
  assert.equal((calls.at(-1)?.init?.headers as Record<string, string>).Authorization, 'Bearer secret-user-token');
  assert.equal(JSON.stringify(calls.at(-1)?.body).includes('width'), false);
  assert.equal(JSON.stringify(calls.at(-1)?.body).includes('height'), false);

  const status = await getH3TaskStatus('h3-20260815-013000-abc12345', {
    baseUrl: 'https://h3-api.example.com',
    apiToken: 'secret-user-token',
    fetchImpl,
  });
  assert.equal(status.provider_task_id, 'h3-20260815-013000-abc12345');
  assert.equal(status.provider_status, 'done');
  assert.equal(status.local_status, 'succeeded');
  assert.equal(status.provider_model, 'larry_v4_6step');
  assert.equal(status.seed, 123456);
  assert.equal(status.result_video_url, 'h3-internal-output://h3-20260815-013000-abc12345/0');

  const outputs = await listH3JobOutputs('h3-20260815-013000-abc12345', {
    baseUrl: 'https://h3-api.example.com',
    apiToken: 'secret-user-token',
    fetchImpl,
  });
  assert.equal(outputs.outputs[0]?.filename, 'out.mp4');

  const queueFullFetch: typeof fetch = async () => new Response(JSON.stringify({ error: 'queue is full' }), {
    status: 503,
    headers: { 'content-type': 'application/json', 'retry-after': '7' },
  });
  await assert.rejects(
    () => createH3VideoJob({ prompt: 'x' }, {
      baseUrl: 'https://h3-api.example.com',
      apiToken: 'secret-user-token',
      fetchImpl: queueFullFetch,
    }),
    (error: unknown) => {
      assert.ok(error instanceof H3RequestError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.retryAfterSeconds, 7);
      assert.equal(error.message.includes('secret-user-token'), false);
      return true;
    },
  );

  console.log('h3-provider-adapter smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
