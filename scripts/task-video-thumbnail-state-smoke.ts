import assert from 'assert';
import {
  appendTaskThumbnailRetryParam,
  buildTaskThumbnailResetKey,
  buildTaskThumbnailView,
} from '../src/lib/video/task-thumbnail-view';

const submitted = buildTaskThumbnailView({
  taskId: 'task-submitted',
  status: 'submitted',
});
assert.equal(submitted.shouldRenderImage, false, 'submitted task should not request thumbnail without source');
assert.equal(submitted.placeholderText, '排队中');

const running = buildTaskThumbnailView({
  taskId: 'task-running',
  status: 'running',
});
assert.equal(running.shouldRenderImage, false, 'running task should not request thumbnail without source');
assert.equal(running.placeholderText, '生成中');

const preparingFailedOnce = buildTaskThumbnailView({
  taskId: 'task-preparing',
  status: 'succeeded',
  deliveryStage: { key: 'preparing' },
  publicVideoUrl: 'https://example.com/video.mp4',
  failed: true,
  retryAttempt: 0,
  retryAfterMs: 3000,
});
assert.equal(preparingFailedOnce.shouldRenderImage, false, 'failed image should fall back while waiting for retry');
assert.equal(preparingFailedOnce.shouldScheduleRetry, true, 'preparing task should schedule a retry');
assert.equal(preparingFailedOnce.retryDelayMs, 3000);
assert.equal(preparingFailedOnce.placeholderText, '正在准备预览');

const withThumbnailUrl = buildTaskThumbnailView({
  taskId: 'task-ready',
  status: 'succeeded',
  thumbnailUrl: '/api/video/thumbnail/task-ready',
  deliveryStage: { key: 'ready' },
});
assert.equal(withThumbnailUrl.shouldRenderImage, true);
assert.equal(withThumbnailUrl.imageSrc, '/api/video/thumbnail/task-ready');

const failedTerminal = buildTaskThumbnailView({
  taskId: 'task-failed',
  status: 'failed',
  publicVideoUrl: 'https://example.com/video.mp4',
  failed: true,
});
assert.equal(failedTerminal.shouldScheduleRetry, false, 'failed task should not retry forever');
assert.equal(failedTerminal.placeholderText, '失败');

const oldResetKey = buildTaskThumbnailResetKey({
  taskId: 'task-changing',
  status: 'succeeded',
  deliveryStage: { key: 'preparing' },
  thumbnailUrl: null,
});
const newResetKey = buildTaskThumbnailResetKey({
  taskId: 'task-changing',
  status: 'succeeded',
  deliveryStage: { key: 'ready' },
  thumbnailUrl: '/api/video/thumbnail/task-changing',
});
assert.notEqual(oldResetKey, newResetKey, 'source or delivery change should reset failed thumbnail state');

assert.equal(
  appendTaskThumbnailRetryParam('/api/video/thumbnail/a?x=1', 2),
  '/api/video/thumbnail/a?x=1&thumb_retry=2',
);
assert.equal(
  appendTaskThumbnailRetryParam('/api/video/thumbnail/a#frag', 3),
  '/api/video/thumbnail/a?thumb_retry=3#frag',
);

console.log('task-video-thumbnail-state smoke passed');
