import assert from 'node:assert/strict';
import {
  VOLCENGINE_IP_DEFAULT_BASE_URL,
  buildVolcengineIpCreatePayload,
  getVolcengineIpProviderConfig,
  mapVolcengineTaskStatus,
  normalizeVolcengineIpError,
  redactVolcengineIpLog,
} from '@/lib/provider/volcengine-ip';

const previousEnv = {
  VOLCENGINE_IP_API_KEY: process.env.VOLCENGINE_IP_API_KEY,
  VOLCENGINE_IP_MODEL: process.env.VOLCENGINE_IP_MODEL,
  VOLCENGINE_IP_BASE_URL: process.env.VOLCENGINE_IP_BASE_URL,
};

process.env.VOLCENGINE_IP_API_KEY = 'ark-test-key-1234567890';
process.env.VOLCENGINE_IP_MODEL = 'doubao-seedance-2-0-fast-test';
delete process.env.VOLCENGINE_IP_BASE_URL;

const config = getVolcengineIpProviderConfig();
assert.equal(config.baseUrl, VOLCENGINE_IP_DEFAULT_BASE_URL);
assert.equal(config.model, 'doubao-seedance-2-0-fast-test');
assert.equal(config.ready, true);
assert.equal(config.apiKeyMasked, 'ark-...7890');

const payload = buildVolcengineIpCreatePayload({
  model: config.model,
  prompt: '让授权角色在城市街头挥手，保持角色比例。',
  generation_mode: 'all_in_one_reference',
  ratio: '16:9',
  duration: 5,
  resolution: '720p',
  seed: 42,
  generate_audio: false,
  return_last_frame: true,
  watermark: false,
  callback_url: 'https://sd2.example.com/api/provider-callbacks/volcengine-ip',
  client_request_id: 'task-local-001',
  reference_image_urls: ['asset://asset-character-001', 'https://cdn.example.com/ref.png?X-Tos-Signature=secret'],
  reference_video_urls: ['asset://asset-video-001'],
  reference_audio_urls: ['asset://asset-audio-001'],
});

assert.equal(payload.model, 'doubao-seedance-2-0-fast-test');
assert.equal(payload.content[0]?.type, 'text');
assert.equal(payload.content[0]?.text, '让授权角色在城市街头挥手，保持角色比例。');
assert.deepEqual(payload.content.slice(1).map((item) => item.type), [
  'image_url',
  'image_url',
  'video_url',
  'audio_url',
]);
assert.equal(payload.ratio, '16:9');
assert.equal(payload.duration, 5);
assert.equal(payload.resolution, '720p');
assert.equal(payload.seed, 42);
assert.equal(payload.generate_audio, false);
assert.equal(payload.return_last_frame, true);
assert.equal(payload.watermark, false);
assert.equal(payload.callback_url, 'https://sd2.example.com/api/provider-callbacks/volcengine-ip');
assert.equal(payload.client_request_id, 'task-local-001');
assert.equal(JSON.stringify(payload).includes('ark-test-key'), false);

assert.equal(mapVolcengineTaskStatus('queued'), 'submitted');
assert.equal(mapVolcengineTaskStatus('running'), 'running');
assert.equal(mapVolcengineTaskStatus('succeeded'), 'succeeded');
assert.equal(mapVolcengineTaskStatus('failed'), 'failed');
assert.equal(mapVolcengineTaskStatus('deleted'), 'cancelled');
assert.equal(mapVolcengineTaskStatus('mystery-status'), 'running');

const rateLimit = normalizeVolcengineIpError({
  statusCode: 429,
  raw: { error: { code: 'RateLimitExceeded.ModelAccountRpm', message: 'too many requests' } },
});
assert.equal(rateLimit.category, 'rate_limit');
assert.equal(rateLimit.retryable, true);
assert.ok(rateLimit.userMessage.includes('请求太频繁'));

const safety = normalizeVolcengineIpError({
  statusCode: 400,
  raw: { error: { code: 'SensitiveContentDetected', message: 'content rejected' } },
});
assert.equal(safety.category, 'content_safety');
assert.equal(safety.retryable, false);
assert.ok(safety.userMessage.includes('内容安全'));

const redacted = redactVolcengineIpLog({
  Authorization: 'Bearer ark-test-key-1234567890',
  video_url: 'https://tos.example.com/video.mp4?X-Tos-Signature=secret&X-Tos-Expires=123',
  nested: { byted_token: 'face-token', signature: 'sig' },
});
assert.equal(redacted.Authorization, '[redacted]');
assert.equal(redacted.nested.byted_token, '[redacted]');
assert.equal(redacted.nested.signature, '[redacted]');
assert.equal(redacted.video_url, 'https://tos.example.com/video.mp4?redacted=1');

process.env.VOLCENGINE_IP_API_KEY = previousEnv.VOLCENGINE_IP_API_KEY;
process.env.VOLCENGINE_IP_MODEL = previousEnv.VOLCENGINE_IP_MODEL;
process.env.VOLCENGINE_IP_BASE_URL = previousEnv.VOLCENGINE_IP_BASE_URL;

console.log('volcengine-ip-provider smoke passed');
