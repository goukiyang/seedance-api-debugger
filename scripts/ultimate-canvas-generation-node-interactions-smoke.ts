import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const interactions = require('../public/tools/ultimate-canvas/generation-node-interactions.js');

const bootstrapSource = readFileSync('src/app/api/tools/ultimate-canvas/bootstrap/route.ts', 'utf8');
assert.ok(bootstrapSource.includes('interaction'));
assert.ok(bootstrapSource.includes('DURATION_OPTIONS'));
assert.ok(bootstrapSource.includes('RESOLUTION_OPTIONS'));
assert.ok(bootstrapSource.includes('RATIO_OPTIONS'));

const videoCapability = interactions.normalizeCapabilities('video', {
  interaction: {
    modes: ['text-to-video', 'image-to-video', 'first-last-frame-video'],
    ratios: ['16:9', '9:16'],
    durations: [5, 10],
    resolutions: ['720p', '1080p'],
    supports_audio: true,
    supports_last_frame: true,
    supports_watermark: false,
    max_reference_images: 2,
  },
});

assert.deepEqual(videoCapability.durations, [5, 10]);
assert.equal(videoCapability.supportsWatermark, false);

const invalidResolutionCapability = interactions.normalizeCapabilities('video', {
  interaction: { resolutions: ['2160p', 'not-a-resolution'] },
});
assert.deepEqual(invalidResolutionCapability.resolutions, ['720p', '1080p']);

const imageResolutionCapability = interactions.normalizeCapabilities('image', {
  interaction: { resolutions: ['1K', '2K', '2160p'] },
});
assert.deepEqual(imageResolutionCapability.resolutions, ['1K', '2K']);
const imageMixedResolutionCapability = interactions.normalizeCapabilities('image', {
  interaction: { resolutions: ['1K', '2160p'] },
});
assert.deepEqual(imageMixedResolutionCapability.resolutions, ['1K']);

const nullInteractionCapability = interactions.normalizeCapabilities('video', { interaction: null });
assert.deepEqual(nullInteractionCapability.modes, [
  'text-to-video',
  'all-reference-video',
  'image-to-video',
  'first-frame-video',
  'first-last-frame-video',
  'image-reference-video',
  'smart-multi-frame-video',
]);

const withoutReferences = interactions.modeOptions('video', videoCapability, 0);
assert.equal(withoutReferences.find((item: any) => item.id === 'text-to-video').enabled, true);
assert.equal(withoutReferences.find((item: any) => item.id === 'image-to-video').enabled, false);
assert.match(withoutReferences.find((item: any) => item.id === 'image-to-video').reason, /1/);

const withTwoReferences = interactions.modeOptions('video', videoCapability, 2);
assert.equal(withTwoReferences.find((item: any) => item.id === 'first-last-frame-video').enabled, true);
assert.equal(interactions.referenceRole('first-last-frame-video', 0), '首帧');
assert.equal(interactions.referenceRole('first-last-frame-video', 1), '尾帧');

assert.equal(
  interactions.replaceCameraLine('产品缓慢旋转\n运镜：镜头前推', '镜头环绕主体'),
  '产品缓慢旋转\n运镜：镜头环绕主体',
);
assert.equal(
  interactions.replaceCameraLine('产品缓慢旋转', '镜头环绕主体'),
  '产品缓慢旋转\n运镜：镜头环绕主体',
);

assert.deepEqual(
  interactions.sanitizeSerializable({ keep: 'https://example.com/a.png', remove: 'blob:temp', nested: ['data:image/png;base64,x', 3] }),
  { keep: 'https://example.com/a.png', remove: '', nested: ['', 3] },
);

assert.equal(interactions.pollDelay(1, 0, false), 3000);
assert.equal(interactions.pollDelay(20, 0, false), 8000);
assert.equal(interactions.pollDelay(2, 3, false), 15000);
assert.equal(interactions.pollDelay(2, 0, true), 15000);

console.log('ultimate-canvas-generation-node-interactions-smoke passed');
