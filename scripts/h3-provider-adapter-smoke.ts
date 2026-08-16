import assert from 'node:assert/strict';
import {
  H3_ALLOWED_ASPECT_RATIOS,
  H3_ALLOWED_PRESET_IDS,
  H3RequestError,
  buildH3GeneratePayload,
  createH3VideoJob,
  getH3Health,
  getH3TaskStatus,
  isH3InternalOutputUrl,
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
      version: 'h3-api-0.3.1',
      public_base_url: null,
      default_preset: 'larry_v4_6step',
      preset_count: 3,
      billing: { charged: false, cost: 0, currency: null, cost_model: 'free_local' },
      worker: { worker: 'ok', comfyui: 'ok' },
      queue: { paused: false, pending: 0, running: 0, max_pending_jobs: 20 },
    });
  }
  if (String(url).endsWith('/api/h3/presets')) {
    return Response.json({
      presets: H3_ALLOWED_PRESET_IDS.map((id) => ({
        id,
        estimated_runtime_sec: id === 'lightx2v_4step_turbo' ? 89.33 : id === 'larry_v4_8step' ? 342.14 : 266.96,
        recommended_timeout_sec: id === 'lightx2v_4step_turbo' ? 300 : id === 'larry_v4_8step' ? 750 : 630,
        runtime_policy: 'benchmark_estimated',
      })),
    });
  }
  if (String(url).endsWith('/api/h3/inputs/images')) {
    return Response.json({
      filename: 'h3ref-20260815-013000-abc12345.png',
      original_filename: rawBody.filename,
      size_bytes: 11,
      sha256: 'sha256-smoke',
      width: 1280,
      height: 720,
      mime_type: 'image/png',
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
      progress_detail: { stage: 'finalizing', elapsed_sec: 95 },
      estimated_runtime_sec: 266.96,
      recommended_timeout_sec: 630,
      risk_flags: [],
      resolved: { seed: 123456 },
      outputs: [{
        index: 0,
        kind: 'video',
        download_url: '/api/h3/jobs/h3-20260815-013000-abc12345/outputs/0',
        content_type: 'video/mp4',
        size_bytes: 152003,
        duration_sec: 5,
        width: 1280,
        height: 720,
        fps: 24,
        sha256: 'video-sha256-smoke',
      }],
    });
  }
  if (String(url).endsWith('/api/h3/jobs/h3-empty-output')) {
    return Response.json({
      job_id: 'h3-empty-output',
      status: 'done',
      preset: 'larry_v4_6step',
      request: { preset_id: 'larry_v4_6step', aspect_ratio: '16:9', duration_sec: 5 },
      outputs: [],
    });
  }
  if (String(url).endsWith('/api/h3/jobs/h3-huge-seed')) {
    return Response.json({
      job_id: 'h3-huge-seed',
      status: 'failed',
      preset: 'larry_v4_6step',
      resolved: { seed: 6412923026406281000 },
      request: { preset_id: 'larry_v4_6step', seed: -1 },
      outputs: [],
      error: 'error',
    });
  }
  if (String(url).endsWith('/api/h3/jobs/h3-oom')) {
    return Response.json({
      job_id: 'h3-oom',
      status: 'failed',
      preset: 'larry_v4_8step',
      request: { preset_id: 'larry_v4_8step', aspect_ratio: '16:9', duration_sec: 15 },
      progress_detail: { stage: 'failed', elapsed_sec: 201 },
      estimated_runtime_sec: 342.14,
      recommended_timeout_sec: 750,
      risk_flags: ['high_vram_margin', 'above_benchmark_frame_count', 'long_720p_oom_risk'],
      error_code: 'gpu_out_of_memory',
      error: 'ComfyUI OOM',
    });
  }
  if (String(url).endsWith('/api/h3/jobs/h3-20260815-013000-abc12345/outputs')) {
    return Response.json({
      job_id: 'h3-20260815-013000-abc12345',
      outputs: [{
        index: 0,
        filename: 'out.mp4',
        kind: 'video',
        download_url: '/api/h3/jobs/h3-20260815-013000-abc12345/outputs/0',
        content_type: 'video/mp4',
        size_bytes: 152003,
        sha256: 'video-sha256-smoke',
      }],
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
  assert.equal(health.version, 'h3-api-0.3.1');
  assert.equal(health.billing?.charged, false);
  assert.equal(health.billing?.cost_model, 'free_local');
  assert.equal(health.queue?.max_pending_jobs, 20);
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
  assert.equal(uploaded.width, 1280);
  assert.equal(uploaded.height, 720);
  assert.equal(uploaded.mime_type, 'image/png');
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
    idempotencyKey: 'req-smoke-001',
    fetchImpl,
  });
  assert.equal(created.provider_task_id, 'h3-20260815-013000-abc12345');
  assert.equal(calls.at(-1)?.url, 'https://h3-api.example.com/api/h3/generate');
  assert.equal((calls.at(-1)?.init?.headers as Record<string, string>).Authorization, 'Bearer secret-user-token');
  assert.equal((calls.at(-1)?.init?.headers as Record<string, string>)['Idempotency-Key'], 'req-smoke-001');
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
  assert.equal(isH3InternalOutputUrl(status.result_video_url), true);
  assert.equal((status.raw as Record<string, unknown>).recommended_timeout_sec, 630);
  assert.deepEqual((status.raw as Record<string, unknown>).risk_flags, []);

  const oomStatus = await getH3TaskStatus('h3-oom', {
    baseUrl: 'https://h3-api.example.com',
    apiToken: 'secret-user-token',
    fetchImpl,
  });
  assert.equal(oomStatus.local_status, 'failed');
  assert.equal(oomStatus.error_message?.includes('显存风险高'), true);
  assert.equal((oomStatus.raw as Record<string, unknown>).error_code, 'gpu_out_of_memory');
  assert.equal((oomStatus.raw as Record<string, unknown>).recommended_timeout_sec, 750);

  const emptyOutputStatus = await getH3TaskStatus('h3-empty-output', {
    baseUrl: 'https://h3-api.example.com',
    apiToken: 'secret-user-token',
    fetchImpl,
  });
  assert.equal(emptyOutputStatus.local_status, 'failed');
  assert.equal(emptyOutputStatus.result_video_url, undefined);
  assert.equal(emptyOutputStatus.error_message, 'H3 任务已完成但没有返回视频输出');
  assert.equal((emptyOutputStatus.raw as Record<string, unknown>).code, 'h3_done_without_output');

  const hugeSeedStatus = await getH3TaskStatus('h3-huge-seed', {
    baseUrl: 'https://h3-api.example.com',
    apiToken: 'secret-user-token',
    fetchImpl,
  });
  assert.equal(hugeSeedStatus.local_status, 'failed');
  assert.equal(hugeSeedStatus.seed, undefined);
  assert.equal((hugeSeedStatus.raw as { resolved?: { seed?: number } }).resolved?.seed, 6412923026406281000);

  const outputs = await listH3JobOutputs('h3-20260815-013000-abc12345', {
    baseUrl: 'https://h3-api.example.com',
    apiToken: 'secret-user-token',
    fetchImpl,
  });
  assert.equal(outputs.outputs[0]?.filename, 'out.mp4');
  assert.equal(outputs.outputs[0]?.size_bytes, 152003);
  assert.equal(outputs.outputs[0]?.sha256, 'video-sha256-smoke');

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
