import assert from 'node:assert/strict';
import {
  getProviderTaskStatus,
  refreshProviderTaskResultUrl,
  type ProviderStatusFetchers,
} from '@/lib/provider/video-task-status';

const calls: string[] = [];

const fetchers: ProviderStatusFetchers = {
  seedance: async (providerTaskId) => {
    calls.push(`seedance:${providerTaskId}`);
    return {
      provider_task_id: providerTaskId,
      provider_status: 'success',
      local_status: 'succeeded',
      result_video_url: 'https://seedance.example.com/out.mp4',
      result_last_frame_url: 'https://seedance.example.com/last.jpg',
      provider_model: 'dreamina-seedance-2-0-260128',
      raw: { provider: 'seedance' },
    };
  },
  volcengineIp: async (providerTaskId) => {
    calls.push(`volcengine-ip:${providerTaskId}`);
    return {
      provider_task_id: providerTaskId,
      provider_status: 'succeeded',
      local_status: 'succeeded',
      result_video_url: 'https://volcengine-ip.example.com/out.mp4',
      provider_model: 'volcengine-ip-model',
      raw: { provider: 'volcengine_ark' },
    };
  },
  aiMediaKitEnhanceVideo: async (providerTaskId) => {
    calls.push(`aimediakit:${providerTaskId}`);
    return {
      provider_task_id: providerTaskId,
      provider_status: 'completed',
      local_status: 'succeeded',
      result_video_url: 'https://mediakit.example.com/out.mp4',
      duration: 12,
      frames_per_second: 60,
      resolution: '1080p',
      raw: { provider: 'volcengine_mediakit' },
    };
  },
};

async function main() {
  const seedance = await getProviderTaskStatus(
    { provider: 'seedance', provider_task_id: 'seedance-task-001' },
    { fetchers },
  );
  assert.equal(seedance.provider_task_id, 'seedance-task-001');
  assert.equal(seedance.result_video_url, 'https://seedance.example.com/out.mp4');
  assert.equal(seedance.provider_model, 'dreamina-seedance-2-0-260128');
  assert.deepEqual(calls, ['seedance:seedance-task-001']);

  const volcengineIp = await getProviderTaskStatus(
    { provider: 'volcengine_ark', provider_task_id: 'volcengine-ip-task-001' },
    { fetchers },
  );
  assert.equal(volcengineIp.provider_task_id, 'volcengine-ip-task-001');
  assert.equal(volcengineIp.result_video_url, 'https://volcengine-ip.example.com/out.mp4');
  assert.equal(volcengineIp.provider_model, 'volcengine-ip-model');
  assert.deepEqual(calls, ['seedance:seedance-task-001', 'volcengine-ip:volcengine-ip-task-001']);

  const mediakit = await getProviderTaskStatus(
    { provider: 'volcengine_mediakit', provider_task_id: 'enhance-task-001' },
    { fetchers },
  );
  assert.equal(mediakit.provider_task_id, 'enhance-task-001');
  assert.equal(mediakit.provider_status, 'completed');
  assert.equal(mediakit.local_status, 'succeeded');
  assert.equal(mediakit.result_video_url, 'https://mediakit.example.com/out.mp4');
  assert.equal(mediakit.duration, 12);
  assert.deepEqual(calls, [
    'seedance:seedance-task-001',
    'volcengine-ip:volcengine-ip-task-001',
    'aimediakit:enhance-task-001',
  ]);

  const refreshed = await refreshProviderTaskResultUrl(
    {
      id: 'task-local-001',
      provider: 'volcengine_mediakit',
      provider_task_id: 'enhance-task-002',
      result_last_frame_url: 'https://old.example.com/last.jpg',
    },
    { fetchers },
  );
  assert.deepEqual(refreshed, {
    result_video_url: 'https://mediakit.example.com/out.mp4',
    result_last_frame_url: 'https://old.example.com/last.jpg',
    raw: { provider: 'volcengine_mediakit' },
  });
  assert.deepEqual(calls, [
    'seedance:seedance-task-001',
    'volcengine-ip:volcengine-ip-task-001',
    'aimediakit:enhance-task-001',
    'aimediakit:enhance-task-002',
  ]);

  await assert.rejects(
    () => getProviderTaskStatus(
      { provider: 'unknown_provider', provider_task_id: 'unknown-task-001' },
      { fetchers },
    ),
    /暂不支持的任务 Provider: unknown_provider/,
  );
  assert.deepEqual(calls, [
    'seedance:seedance-task-001',
    'volcengine-ip:volcengine-ip-task-001',
    'aimediakit:enhance-task-001',
    'aimediakit:enhance-task-002',
  ]);

  await assert.rejects(
    () => getProviderTaskStatus(
      { provider: 'volcengine_mediakit', provider_task_id: null },
      { fetchers },
    ),
    /缺少 provider_task_id/,
  );

  console.log('provider-status-router smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
