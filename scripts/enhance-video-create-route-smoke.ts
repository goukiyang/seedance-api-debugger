import assert from 'node:assert/strict';
import {
  assertEnhanceVideoSourceTaskAllowed,
  buildEnhanceVideoProviderInput,
  normalizeEnhanceVideoCreateBody,
} from '@/lib/tasks/enhance-video-create';
import { calculateEnhanceVideoEstimatedCost } from '@/lib/pricing';

async function assertRejectsMessage(action: () => unknown, pattern: RegExp) {
  await assert.rejects(async () => action(), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
    return true;
  });
}

async function main() {
  const sourceBody = normalizeEnhanceVideoCreateBody({
    source_task_id: ' source-task-001 ',
    tool_version: 'professional',
    resolution: '1080p',
    fps: 60,
    idempotency_key: ' enhance-idempotency-001 ',
  });
  assert.equal(sourceBody.sourceTaskId, 'source-task-001');
  assert.equal(sourceBody.videoUrl, null);
  assert.equal(sourceBody.toolVersion, 'professional');
  assert.equal(sourceBody.scene, null);
  assert.equal(sourceBody.resolution, '1080p');
  assert.equal(sourceBody.fps, 60);
  assert.equal(sourceBody.idempotencyKey, 'enhance-idempotency-001');

  const urlBody = normalizeEnhanceVideoCreateBody({
    video_url: 'https://cdn.example.com/input.mp4',
    tool_version: 'standard',
    scene: 'aigc',
    resolution: '720p',
    duration: 12,
  });
  assert.equal(urlBody.videoUrl, 'https://cdn.example.com/input.mp4');
  assert.equal(urlBody.durationSeconds, 12);

  await assertRejectsMessage(
    () => normalizeEnhanceVideoCreateBody({}),
    /必须提供 source_task_id 或 video_url/,
  );
  await assertRejectsMessage(
    () => normalizeEnhanceVideoCreateBody({ source_task_id: 'a', video_url: 'https://cdn.example.com/input.mp4' }),
    /source_task_id 和 video_url 不能同时提供/,
  );
  await assertRejectsMessage(
    () => normalizeEnhanceVideoCreateBody({ video_url: 'file:///tmp/input.mp4' }),
    /video_url 协议只支持/,
  );
  await assertRejectsMessage(
    () => normalizeEnhanceVideoCreateBody({ video_url: 'http://127.0.0.1:3000/input.mp4' }),
    /video_url 不能指向本机或内网地址/,
  );

  const pricing = calculateEnhanceVideoEstimatedCost({
    duration: 12,
    resolution: '1080p',
    toolVersion: 'professional',
    fps: 60,
  });
  assert.equal(pricing.model, 'AI MediaKit enhance-video');
  assert.equal(pricing.costSource, 'rule');
  assert.equal(pricing.confidence, 'estimated');
  assert.equal(pricing.duration, 12);
  assert.equal(pricing.resolution, '1080p');
  assert.equal(pricing.toolVersion, 'professional');
  assert.ok(pricing.estimatedCost > 0);

  assert.doesNotThrow(() => assertEnhanceVideoSourceTaskAllowed({
    provider: 'seedance',
    generation_mode: 'all_in_one_reference',
  }));
  assert.throws(
    () => assertEnhanceVideoSourceTaskAllowed({ provider: 'volcengine_mediakit', generation_mode: 'enhance_video' }),
    /不支持对超分结果再次发起超分/,
  );
  assert.throws(
    () => assertEnhanceVideoSourceTaskAllowed({ provider: 'seedance', generation_mode: 'enhance_video' }),
    /不支持对超分结果再次发起超分/,
  );

  const providerInput = buildEnhanceVideoProviderInput({
    videoUrl: 'https://cdn.example.com/input.mp4',
    toolVersion: 'standard',
    scene: 'aigc',
    resolution: '720p',
    fps: 30,
    clientToken: 'local-task-001',
  });
  assert.deepEqual(providerInput, {
    video_url: 'https://cdn.example.com/input.mp4',
    tool_version: 'standard',
    scene: 'aigc',
    resolution: '720p',
    fps: 30,
    client_token: 'local-task-001',
  });

  const professionalInput = buildEnhanceVideoProviderInput({
    videoUrl: 'https://cdn.example.com/input.mp4',
    toolVersion: 'professional',
    scene: 'aigc',
    resolution: '1080p',
    clientToken: 'local-task-002',
  });
  assert.equal('scene' in professionalInput, false);

  console.log('enhance-video-create-route smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
