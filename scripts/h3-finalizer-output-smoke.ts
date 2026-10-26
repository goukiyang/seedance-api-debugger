import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseH3InternalOutputUrl, h3InternalOutputUrl, isH3InternalOutputUrl } from '@/lib/provider/h3';
import { videoDeliveryStageForTask } from '@/lib/video/delivery-status';

const localCacheSource = readFileSync('src/lib/video/local-cache.ts', 'utf8');
const finalizerSource = readFileSync('src/lib/video/task-finalizer.ts', 'utf8');
const runnerSource = readFileSync('src/lib/video/task-localization-runner.ts', 'utf8');
const playRouteSource = readFileSync('src/app/api/video/play/[id]/route.ts', 'utf8');

assert.deepEqual(parseH3InternalOutputUrl(h3InternalOutputUrl('h3-job-001', 0)), {
  jobId: 'h3-job-001',
  index: 0,
});
assert.equal(parseH3InternalOutputUrl('https://example.com/out.mp4'), null);
assert.equal(isH3InternalOutputUrl(h3InternalOutputUrl('h3-job-001', 1)), true);

const internalOnlyStage = videoDeliveryStageForTask({
  local_status: 'succeeded',
  public_video_url: null,
  local_video_path: null,
  result_video_url: h3InternalOutputUrl('h3-job-001', 0),
});
assert.equal(internalOnlyStage.previewAvailable, false, 'H3 内部输出地址不能让前端直接出现播放入口');

assert.match(localCacheSource, /parseH3InternalOutputUrl/, '本地缓存必须识别 H3 内部输出地址');
assert.match(localCacheSource, /downloadH3JobOutput/, 'H3 输出下载必须走后端 token 下载器');
assert.match(localCacheSource, /h3InternalOutput/, 'H3 输出不能把带 token 的真实 URL 暴露给前端');
assert.match(finalizerSource, /markH3OutputDownloadFailed/, 'H3 输出下载失败必须把任务转成失败');
assert.match(finalizerSource, /output_download_failed/, 'H3 输出失败必须写入可审计错误码');
assert.match(finalizerSource, /retryAfterMs/, 'H3 状态错误需要返回 Retry-After 等待时间');
assert.match(runnerSource, /result\.retryAfterMs/, '本地轮询器必须尊重 H3 Retry-After');
assert.match(playRouteSource, /h3-internal-output:\/\//, '播放接口必须识别 H3 内部地址');
assert.match(playRouteSource, /status:\s*425/, 'H3 内部地址不能被 302 重定向到浏览器');

console.log('h3-finalizer-output smoke passed');
