import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getExternalCallbackUrlFromParams,
  isVideoDeliveryFastPathTask,
  mergeVideoDeliveryCallbackParams,
  resolveVideoDeliveryCallbackConfig,
} from '@/lib/video/delivery-policy';
import { videoDeliveryStageForTask } from '@/lib/video/delivery-status';

assert.equal(
  isVideoDeliveryFastPathTask({ provider: 'seedance', generation_mode: 'text_to_video' }),
  true,
  'ordinary Seedance tasks should use the fast delivery path',
);
assert.equal(
  isVideoDeliveryFastPathTask({ provider: 'seedance', generation_mode: 'first_last_frame' }),
  true,
  'ordinary first/last-frame Seedance tasks should use the fast delivery path',
);
assert.equal(
  isVideoDeliveryFastPathTask({ provider: 'volcengine_mediakit', generation_mode: 'enhance_video' }),
  false,
  'enhance video tasks must not be accidentally routed through ordinary Seedance delivery',
);
assert.equal(
  isVideoDeliveryFastPathTask({ provider: 'volcengine_ark', generation_mode: 'text_to_video' }),
  false,
  'IP video tasks must keep their existing provider-specific flow',
);
assert.equal(
  isVideoDeliveryFastPathTask({ provider: 'seedance', generation_mode: 'enhance_video' }),
  false,
  'enhance generation_mode stays out even if provider is malformed as seedance',
);

const callbackConfig = resolveVideoDeliveryCallbackConfig({
  baseUrl: 'https://sd2.youdoodesign.com',
  taskId: 'task-fast-001',
  requestCallbackUrl: 'https://client.example.com/original-callback',
  callbackSecret: 'secret value',
});
assert.equal(callbackConfig.systemCallbackUrl, 'https://sd2.youdoodesign.com/api/provider/seedance/callback?taskId=task-fast-001&token=secret+value');
assert.equal(callbackConfig.providerCallbackUrl, callbackConfig.systemCallbackUrl);
assert.equal(callbackConfig.externalCallbackUrl, 'https://client.example.com/original-callback');
assert.throws(
  () => resolveVideoDeliveryCallbackConfig({
    baseUrl: 'https://sd2.youdoodesign.com',
    taskId: 'task-fast-no-secret',
    callbackSecret: '',
  }),
  /VIDEO_DELIVERY_CALLBACK_SECRET/,
  'fast-path callback setup must fail closed when no callback secret is configured',
);

const mergedParams = mergeVideoDeliveryCallbackParams(
  JSON.stringify({ existing: true }),
  callbackConfig,
);
assert.equal(getExternalCallbackUrlFromParams(mergedParams), 'https://client.example.com/original-callback');
assert.deepEqual(JSON.parse(mergedParams).existing, true, 'callback metadata merge must preserve existing task params');

assert.deepEqual(
  videoDeliveryStageForTask({ local_status: 'running', public_video_url: null, delivery_status: null }),
  { key: 'generating', label: '生成中', stableDownloadReady: false, previewAvailable: false },
);
assert.deepEqual(
  videoDeliveryStageForTask({ local_status: 'succeeded', public_video_url: null, delivery_status: 'queued', result_video_url: 'https://provider.example.com/tmp.mp4' }),
  { key: 'preparing', label: '已生成，正在准备稳定下载', stableDownloadReady: false, previewAvailable: true },
);
assert.deepEqual(
  videoDeliveryStageForTask({ local_status: 'succeeded', public_video_url: 'https://cdn.example.com/out.mp4', delivery_status: 'succeeded' }),
  { key: 'ready', label: '稳定下载已就绪', stableDownloadReady: true, previewAvailable: true },
);
assert.deepEqual(
  videoDeliveryStageForTask({ local_status: 'succeeded', public_video_url: null, delivery_status: 'failed', result_video_url: 'https://provider.example.com/tmp.mp4' }),
  { key: 'failed', label: '稳定下载准备失败，可重试', stableDownloadReady: false, previewAvailable: true },
);

const publicStorageSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/assets/public-storage.ts'), 'utf8');
assert.match(
  publicStorageSource,
  /export async function uploadPublicVideoStream/,
  'video delivery must add a dedicated stream upload helper',
);
assert.match(
  publicStorageSource,
  /export async function uploadPublicAsset\(\s*buffer: Buffer,/,
  'existing buffer upload API must remain for image and asset uploads',
);

const downloadRouteSource = fs.readFileSync(path.join(process.cwd(), 'src/app/api/video/download/[id]/route.ts'), 'utf8');
assert.match(downloadRouteSource, /getSession/, 'download preparation must keep login checks');
assert.match(downloadRouteSource, /assertCanViewTask/, 'download preparation must keep task visibility checks');
assert.match(downloadRouteSource, /enqueueVideoDeliveryJob/, 'download preparation should enqueue stable delivery instead of blocking on large files');

const statusRouteSource = fs.readFileSync(path.join(process.cwd(), 'src/app/api/video/status/[id]/route.ts'), 'utf8');
assert.match(statusRouteSource, /const fastPathDelivery = isVideoDeliveryFastPathTask\(task\)/, 'status route must classify fast-path tasks before finalizing');
assert.match(statusRouteSource, /cacheOnSuccess:\s*!fastPathDelivery/, 'status route must keep old cache fallback for non-fast-path tasks');
assert.match(statusRouteSource, /generateThumbnail:\s*!fastPathDelivery/, 'status route must avoid blocking thumbnail work for fast-path status checks');
assert.match(statusRouteSource, /enqueueVideoDeliveryJob/, 'status route must enqueue stable delivery when provider is already done');
assert.match(statusRouteSource, /videoDeliveryStageForTask/, 'status route should expose stable delivery stage');

const assetLibrarySource = fs.readFileSync(path.join(process.cwd(), 'src/app/api/assets/library/route.ts'), 'utf8');
assert.match(assetLibrarySource, /videoDeliveryStageForTask/, 'asset library must distinguish preview availability from stable download readiness');
assert.match(assetLibrarySource, /stableDownloadReady/, 'asset library items must expose stable download readiness');

const createRouteSource = fs.readFileSync(path.join(process.cwd(), 'src/app/api/tasks/create/route.ts'), 'utf8');
assert.match(createRouteSource, /resolveVideoDeliveryCallbackConfig/, 'ordinary create route must set the system callback URL');
assert.match(createRouteSource, /VIDEO_DELIVERY_CALLBACK_CONFIG_ERROR/, 'ordinary create route must preflight callback config before creating a task');
assert.match(createRouteSource, /mergeVideoDeliveryCallbackParams/, 'ordinary create route must preserve external callback metadata');
assert.match(createRouteSource, /enqueueDeliveryOnSuccess:\s*true/, 'ordinary create route should use the delivery queue fallback runner');

const taskDetailSource = fs.readFileSync(path.join(process.cwd(), 'src/app/tasks/[id]/page.tsx'), 'utf8');
assert.match(taskDetailSource, /data\.public_video_url/, 'task detail download must handle stable public video URLs');
assert.match(taskDetailSource, /res\.status === 202/, 'task detail download must show stable-download preparing state instead of generic failure');
assert.match(taskDetailSource, /准备稳定下载/, 'task detail should expose a stable-download preparation action');

const bulkDownloadSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/video/bulk-download.ts'), 'utf8');
assert.match(bulkDownloadSource, /public_video_url/, 'bulk download must include stable public video URLs');
assert.match(bulkDownloadSource, /addReadStream/, 'bulk download ZIP should stream public URLs without forcing local cache first');
assert.match(bulkDownloadSource, /cacheTaskVideoToLocal/, 'bulk download should retain local cache fallback for legacy tasks');

const assetsPageSource = fs.readFileSync(path.join(process.cwd(), 'src/app/assets/page.tsx'), 'utf8');
assert.match(assetsPageSource, /deliveryStageClassName/, 'asset page should show stable delivery stage without overlaying the cover');
assert.match(assetsPageSource, /prepareStableDownload/, 'asset page detail should let users trigger stable-download preparation');

const runnerSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/video/task-localization-runner.ts'), 'utf8');
assert.match(runnerSource, /enqueueDeliveryOnSuccess\?: boolean/, 'localization runner must support delivery queue fallback without affecting IP/enhance defaults');

const callbackRouteSource = fs.readFileSync(path.join(process.cwd(), 'src/app/api/provider/seedance/callback/route.ts'), 'utf8');
assert.match(callbackRouteSource, /callback_secret_not_configured/, 'callback route must reject requests when no secret is configured');
assert.match(callbackRouteSource, /finalizeVideoTaskStatus/, 'callback route must reuse the existing finalizer and billing path');
assert.match(callbackRouteSource, /enqueueVideoDeliveryJob/, 'callback route must enqueue stable delivery after finalization');
assert.doesNotMatch(callbackRouteSource, /cacheTaskVideoToLocal|uploadPublicAsset/, 'callback route must not do heavy file download or upload work');

const publicDeliverySource = fs.readFileSync(path.join(process.cwd(), 'src/lib/video/public-delivery.ts'), 'utf8');
assert.match(publicDeliverySource, /ensurePublicVideoDeliveryFromProvider/, 'worker should use provider-to-public delivery without local readFile buffering');

const workerScriptSource = fs.readFileSync(path.join(process.cwd(), 'scripts/process-video-delivery-jobs.ts'), 'utf8');
assert.match(workerScriptSource, /processVideoDeliveryQueueBatch/, 'delivery worker script must process durable queue jobs');

console.log('video-delivery-fast-path smoke passed');
