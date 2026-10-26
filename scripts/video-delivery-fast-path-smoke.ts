import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getExternalCallbackUrlFromParams,
  isVideoDeliveryFastPathTask,
  mergeVideoDeliveryCallbackParams,
  resolveVideoDeliveryPublicBaseUrl,
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

const previousBaseUrl = process.env.BASE_URL;
const previousNextAuthUrl = process.env.NEXTAUTH_URL;
const previousNextPublicBaseUrl = process.env.NEXT_PUBLIC_BASE_URL;
process.env.BASE_URL = 'https://sd2.youdooart.com';
process.env.NEXTAUTH_URL = '';
process.env.NEXT_PUBLIC_BASE_URL = 'https://sd2.youdoodesign.com';
assert.equal(
  resolveVideoDeliveryPublicBaseUrl(),
  'https://sd2.youdooart.com',
  'server callback base should prefer runtime BASE_URL over a stale build-time public URL',
);
const runtimeCallbackConfig = resolveVideoDeliveryCallbackConfig({
  taskId: 'task-runtime-base',
  callbackSecret: 'secret value',
});
assert.equal(
  runtimeCallbackConfig.systemCallbackUrl,
  'https://sd2.youdooart.com/api/provider/seedance/callback?taskId=task-runtime-base&token=secret+value',
  'server-created tasks should use the runtime public host for provider callbacks',
);
if (previousBaseUrl === undefined) delete process.env.BASE_URL;
else process.env.BASE_URL = previousBaseUrl;
if (previousNextAuthUrl === undefined) delete process.env.NEXTAUTH_URL;
else process.env.NEXTAUTH_URL = previousNextAuthUrl;
if (previousNextPublicBaseUrl === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
else process.env.NEXT_PUBLIC_BASE_URL = previousNextPublicBaseUrl;

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
assert.match(downloadRouteSource, /export async function GET/, 'download route should support direct browser downloads');
assert.match(downloadRouteSource, /Content-Disposition/, 'direct video downloads must be returned as attachments');
assert.match(downloadRouteSource, /NextResponse\.redirect\(task\.public_video_url,\s*302\)/, 'stable public downloads should redirect instead of proxying the whole video through Next');
assert.doesNotMatch(downloadRouteSource, /fetch\(task\.public_video_url/, 'stable public downloads must not keep server-side public URL fetch/proxy');

const statusRouteSource = fs.readFileSync(path.join(process.cwd(), 'src/app/api/video/status/[id]/route.ts'), 'utf8');
assert.match(statusRouteSource, /const fastPathDelivery = isVideoDeliveryFastPathTask\(task\)/, 'status route must classify fast-path tasks before finalizing');
assert.match(statusRouteSource, /cacheOnSuccess:\s*!fastPathDelivery/, 'status route must keep old cache fallback for non-fast-path tasks');
assert.match(statusRouteSource, /generateThumbnail:\s*!fastPathDelivery/, 'status route must avoid blocking thumbnail work for fast-path status checks');
assert.match(statusRouteSource, /enqueueVideoDeliveryJob/, 'status route must enqueue stable delivery when provider is already done');
assert.match(statusRouteSource, /videoDeliveryStageForTask/, 'status route should expose stable delivery stage');
assert.match(statusRouteSource, /play_url/, 'status route should expose a unified play URL for web, canvas, and external API callers');
assert.match(statusRouteSource, /download_url/, 'status route should expose a stable download URL only when stable delivery is ready');
assert.match(statusRouteSource, /thumbnail_url/, 'status route should expose a thumbnail URL when a thumbnail can be requested');
assert.match(statusRouteSource, /retry_after_ms/, 'status route should tell callers when to poll again without guessing');
assert.match(statusRouteSource, /isTerminalLocalStatus/, 'status route should know when a task is already terminal');
assert.match(statusRouteSource, /terminal_fast_path_status_cached/, 'terminal fast-path status checks should not keep refreshing provider status while waiting for stable delivery');

const videoListRouteSource = fs.readFileSync(path.join(process.cwd(), 'src/app/api/video/list/route.ts'), 'utf8');
assert.match(videoListRouteSource, /videoDeliveryStageForTask/, 'video list should expose delivery stage for refreshed recent-task polling');
assert.match(videoListRouteSource, /stable_download_ready/, 'video list should expose stable download readiness');
assert.match(videoListRouteSource, /retry_after_ms/, 'video list should expose backend polling cadence for succeeded-but-preparing tasks');
assert.match(videoListRouteSource, /download_url:\s*deliveryStage\.stableDownloadReady/, 'video list should only expose download URL when stable delivery is ready');

const assetLibrarySource = fs.readFileSync(path.join(process.cwd(), 'src/app/api/assets/library/route.ts'), 'utf8');
assert.match(assetLibrarySource, /videoDeliveryStageForTask/, 'asset library must distinguish preview availability from stable download readiness');
assert.match(assetLibrarySource, /stableDownloadReady/, 'asset library items must expose stable download readiness');
assert.match(assetLibrarySource, /deliveryCompletedAt/, 'asset library items must expose stable download completion time for hover stats');

const createRouteSource = fs.readFileSync(path.join(process.cwd(), 'src/app/api/tasks/create/route.ts'), 'utf8');
assert.match(createRouteSource, /resolveVideoDeliveryCallbackConfig/, 'ordinary create route must set the system callback URL');
assert.doesNotMatch(
  createRouteSource,
  /baseUrl:\s*process\.env\.NEXT_PUBLIC_BASE_URL/,
  'ordinary create route must not pass build-time NEXT_PUBLIC_BASE_URL into server callback config',
);
assert.match(
  createRouteSource,
  /requestSource\.source_type === 'codex_api'\s*\?\s*\[\]/,
  'Codex API requests without explicit references must not inherit stale workspace reference images',
);
assert.match(createRouteSource, /VIDEO_DELIVERY_CALLBACK_CONFIG_ERROR/, 'ordinary create route must preflight callback config before creating a task');
assert.match(createRouteSource, /mergeVideoDeliveryCallbackParams/, 'ordinary create route must preserve external callback metadata');
assert.match(createRouteSource, /enqueueDeliveryOnSuccess:\s*true/, 'ordinary create route should use the delivery queue fallback runner');

const taskDetailSource = fs.readFileSync(path.join(process.cwd(), 'src/app/tasks/[id]/page.tsx'), 'utf8');
assert.match(taskDetailSource, /data\.public_video_url/, 'task detail download must handle stable public video URLs');
assert.match(taskDetailSource, /res\.status === 202/, 'task detail download must show stable-download preparing state instead of generic failure');
assert.match(taskDetailSource, /准备稳定下载/, 'task detail should expose a stable-download preparation action');

const generatePageSource = fs.readFileSync(path.join(process.cwd(), 'src/components/generate/GeneratePageClient.tsx'), 'utf8');
assert.match(generatePageSource, /shouldContinuePollingStableDelivery/, 'ordinary generate page should keep polling succeeded videos until stable delivery is ready');
assert.match(generatePageSource, /stable_download_ready/, 'ordinary generate page should read stable download readiness from status API');
assert.match(generatePageSource, /collectPollableTaskIds\(tasks,\s*isIpSurface\)/, 'ordinary generate page should resume polling succeeded-but-preparing tasks loaded from recent list');
assert.match(generatePageSource, /POLLABLE_TASK_STATUSES\.has\(task\.local_status\)[\s\S]*shouldContinuePollingStableDelivery/, 'ordinary generate page should include stable-delivery waits in pollable task collection');

const templateGenerateSource = fs.readFileSync(path.join(process.cwd(), 'src/components/templates/TemplateGenerateClient.tsx'), 'utf8');
assert.match(templateGenerateSource, /shouldContinuePollingStableDelivery/, 'template generate page should keep polling succeeded videos until stable delivery is ready');
assert.match(templateGenerateSource, /stable_download_ready/, 'template generate page should read stable download readiness from status API');
assert.match(templateGenerateSource, /POLLABLE_TASK_STATUSES\.has\(task\.local_status\)[\s\S]*shouldContinuePollingStableDelivery/, 'template generate page should include stable-delivery waits in pollable task collection');

const bulkDownloadSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/video/bulk-download.ts'), 'utf8');
assert.match(bulkDownloadSource, /public_video_url/, 'bulk download must include stable public video URLs');
assert.match(bulkDownloadSource, /addReadStream/, 'bulk download ZIP should stream public URLs without forcing local cache first');
assert.match(bulkDownloadSource, /cacheTaskVideoToLocal/, 'bulk download should retain local cache fallback for legacy tasks');

const assetsPageSource = fs.readFileSync(path.join(process.cwd(), 'src/app/assets/page.tsx'), 'utf8');
assert.match(assetsPageSource, /deliveryStatsTooltip/, 'asset page should show hover timing stats for ready downloads');
assert.match(assetsPageSource, /asset-card-download-action/, 'asset page should render stable-ready downloads as a compact action');
assert.match(assetsPageSource, /<span>下载<\/span>/, 'stable-ready asset card action should use the short 下载 label');
assert.match(assetsPageSource, /data-tooltip=\{deliveryStatsTooltip\(item\)\}/, 'stable-ready download action should use the custom hover bubble payload');
assert.match(assetsPageSource, /提交到生成完成/, 'hover bubble should include generation timing stats');
assert.match(assetsPageSource, /item\.deliveryStage\?\.key !== 'ready'/, 'asset page should not render the ready download state as a separate status line');
assert.match(assetsPageSource, /\/api\/video\/download\/\$\{item\.taskId\}/, 'asset page compact download action should use the direct download route');
assert.match(assetsPageSource, /prepareStableDownload/, 'asset page detail should let users trigger stable-download preparation');

const ultimateCanvasWorkflowSource = fs.readFileSync(path.join(process.cwd(), 'public/tools/ultimate-canvas/generation-node-workflow.js'), 'utf8');
assert.match(ultimateCanvasWorkflowSource, /task\.play_url/, 'ultimate canvas should use the backend-provided play URL');
assert.match(ultimateCanvasWorkflowSource, /task\.download_url/, 'ultimate canvas should use the backend-provided stable download URL');
assert.match(ultimateCanvasWorkflowSource, /stableDownloadReady/, 'ultimate canvas should keep stable download readiness separate from generation success');
assert.doesNotMatch(
  ultimateCanvasWorkflowSource,
  /downloadUrl:\s*taskId\s*\?\s*`\/api\/video\/download/,
  'ultimate canvas should not expose download before stable delivery is ready',
);

const globalStylesSource = fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');
assert.match(globalStylesSource, /asset-card-download-action::after/, 'stable-ready download action should render a custom hover bubble');
assert.match(globalStylesSource, /content: attr\(data-tooltip\)/, 'custom hover bubble should read generated timing text from data-tooltip');

const runnerSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/video/task-localization-runner.ts'), 'utf8');
assert.match(runnerSource, /enqueueDeliveryOnSuccess\?: boolean/, 'localization runner must support delivery queue fallback without affecting IP/enhance defaults');

const callbackRouteSource = fs.readFileSync(path.join(process.cwd(), 'src/app/api/provider/seedance/callback/route.ts'), 'utf8');
assert.match(callbackRouteSource, /callback_secret_not_configured/, 'callback route must reject requests when no secret is configured');
assert.match(callbackRouteSource, /finalizeVideoTaskStatus/, 'callback route must reuse the existing finalizer and billing path');
assert.match(callbackRouteSource, /enqueueVideoDeliveryJob/, 'callback route must enqueue stable delivery after finalization');
assert.doesNotMatch(callbackRouteSource, /cacheTaskVideoToLocal|uploadPublicAsset/, 'callback route must not do heavy file download or upload work');

const publicDeliverySource = fs.readFileSync(path.join(process.cwd(), 'src/lib/video/public-delivery.ts'), 'utf8');
assert.match(publicDeliverySource, /ensurePublicVideoDeliveryFromProvider/, 'worker should use provider-to-public delivery without local readFile buffering');
assert.match(publicDeliverySource, /ingestTaskMediaFromProvider/, 'provider delivery should use the unified media ingest job');

const workerScriptSource = fs.readFileSync(path.join(process.cwd(), 'scripts/process-video-delivery-jobs.ts'), 'utf8');
assert.match(workerScriptSource, /processVideoDeliveryQueueBatch/, 'delivery worker script must process durable queue jobs');

console.log('video-delivery-fast-path smoke passed');
