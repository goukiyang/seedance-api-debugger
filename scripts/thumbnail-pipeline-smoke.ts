import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { canRequestTaskThumbnail, shouldExposeTaskThumbnailUrl } from '../src/lib/video/thumbnail-availability';
import { shouldContinueLocalization } from '../src/lib/video/task-localization-runner';
import { cacheSafeAssetUrl } from '../src/lib/assets/library-cache-policy';
import { generateAssetVideoThumbnail } from '../src/lib/assets/video-thumbnail';

async function assertThumbnailAvailabilityRules() {
  assert.equal(
    canRequestTaskThumbnail({ publicVideoUrl: null, localVideoPath: null, resultLastFrameUrl: null }),
    false,
    '没有本地视频、公开视频和尾帧时不能请求截图接口',
  );
  assert.equal(
    canRequestTaskThumbnail({
      publicVideoUrl: null,
      localVideoPath: null,
      resultVideoUrl: 'https://provider.example.test/result.mp4',
      resultLastFrameUrl: null,
    }),
    true,
    '只有 provider result_video_url 时也可以请求截图接口，避免资产页显示暂无截图',
  );
  assert.equal(
    canRequestTaskThumbnail({
      publicVideoUrl: null,
      localVideoPath: null,
      resultVideoUrl: 'https://fd-assets.example.test/result.mp4',
      resultLastFrameUrl: null,
    }),
    true,
    '公网 CDN 域名不能因为 fd/fc 前缀被误判成 IPv6 私网',
  );
  assert.equal(
    canRequestTaskThumbnail({
      publicVideoUrl: null,
      localVideoPath: null,
      resultVideoUrl: 'h3-internal-output://job/0',
      resultLastFrameUrl: null,
    }),
    false,
    '内部专用 result_video_url 不能当成可抽帧公网视频',
  );
  assert.equal(
    canRequestTaskThumbnail({
      publicVideoUrl: null,
      localVideoPath: null,
      resultVideoUrl: 'http://127.0.0.1:3000/private.mp4',
      resultLastFrameUrl: null,
    }),
    false,
    '本机 result_video_url 不能当成可抽帧公网视频',
  );
  assert.equal(
    canRequestTaskThumbnail({
      publicVideoUrl: null,
      localVideoPath: null,
      resultVideoUrl: 'http://[::1]/private.mp4',
      resultLastFrameUrl: null,
    }),
    false,
    'IPv6 本机 result_video_url 不能当成可抽帧公网视频',
  );
  assert.equal(
    canRequestTaskThumbnail({
      publicVideoUrl: null,
      localVideoPath: null,
      resultVideoUrl: null,
      resultLastFrameUrl: 'http://10.0.0.8/frame.jpg',
    }),
    false,
    '内网尾帧不能当成可抽帧公网图片',
  );
  assert.equal(
    canRequestTaskThumbnail({ publicVideoUrl: 'https://example.test/video.mp4', localVideoPath: null, resultLastFrameUrl: null }),
    true,
    '已有稳定公开视频时可以请求截图接口',
  );
  assert.equal(
    canRequestTaskThumbnail({ localVideoPath: '/videos/task.mp4', resultLastFrameUrl: null }),
    true,
    '已有本地视频时可以请求截图接口',
  );
  assert.equal(
    canRequestTaskThumbnail({ localVideoPath: null, resultLastFrameUrl: 'https://example.test/frame.jpg' }),
    true,
    '已有尾帧图片时可以请求截图接口',
  );
  assert.equal(
    shouldExposeTaskThumbnailUrl({
      hasExistingThumbnail: true,
      publicVideoUrl: null,
      localVideoPath: null,
      resultLastFrameUrl: null,
    }),
    true,
    '服务端已经有缩略图文件时可以返回 thumbnailUrl',
  );
  assert.equal(
    shouldExposeTaskThumbnailUrl({
      hasExistingThumbnail: false,
      publicVideoUrl: null,
      localVideoPath: null,
      resultVideoUrl: 'https://provider.example.test/result.mp4',
      resultLastFrameUrl: null,
    }),
    true,
    '只有 provider result_video_url 时也应该返回 thumbnailUrl，让缩略图接口按需抽帧',
  );

  const { resolveThumbnailSources } = await import('../src/lib/video/thumbnail');
  assert.deepEqual(
    await resolveThumbnailSources({
      public_video_url: 'http://127.0.0.1:3000/private.mp4',
      local_video_path: null,
      result_video_url: 'http://10.0.0.8/private.mp4',
      result_last_frame_url: 'http://[::1]/frame.jpg',
    }, { allowRemoteFallback: true }),
    [],
    '截图抽帧源不能包含本机或内网地址',
  );
  assert.deepEqual(
    await resolveThumbnailSources({
      public_video_url: 'https://fcdn.example.test/video.mp4',
      local_video_path: null,
      result_video_url: null,
      result_last_frame_url: null,
    }, { allowRemoteFallback: true }),
    ['https://fcdn.example.test/video.mp4'],
    '公网 fcdn 域名必须保留为可抽帧来源',
  );
}

function assertAssetLibraryCachePolicy() {
  assert.equal(cacheSafeAssetUrl('/api/video/thumbnail/task-001'), '/api/video/thumbnail/task-001');
  assert.equal(cacheSafeAssetUrl('https://sd2.youdooart.com/uploads/thumbs/a.jpg'), 'https://sd2.youdooart.com/uploads/thumbs/a.jpg');
  assert.equal(cacheSafeAssetUrl('https://sd2.youdoodesign.com/uploads/thumbs/a.jpg'), 'https://sd2.youdoodesign.com/uploads/thumbs/a.jpg');
  assert.equal(cacheSafeAssetUrl('https://cdn.example.test/a.jpg'), 'https://cdn.example.test/a.jpg', 'R2/TOS/CDN 公网素材地址应该允许进入资产页离线缓存');
  assert.equal(cacheSafeAssetUrl('https://fcdn.example.test/a.jpg'), 'https://fcdn.example.test/a.jpg', 'fcdn 公网域名不能被误当成 IPv6 私网');
  assert.equal(cacheSafeAssetUrl('https://fd-assets.example.test/a.jpg'), 'https://fd-assets.example.test/a.jpg', 'fd-assets 公网域名不能被误当成 IPv6 私网');
  assert.equal(cacheSafeAssetUrl('http://127.0.0.1:3000/uploads/a.jpg'), null, '本机地址不能进入浏览器缓存');
  assert.equal(cacheSafeAssetUrl('http://[::1]/uploads/a.jpg'), null, 'IPv6 本机地址不能进入浏览器缓存');
  assert.equal(cacheSafeAssetUrl('javascript:alert(1)'), null);
}

function assertDirectUploadVideoThumbnailRules() {
  const directUploadSource = fs.readFileSync(
    path.join(process.cwd(), 'src/lib/assets/direct-upload.ts'),
    'utf8',
  );
  assert.match(
    directUploadSource,
    /generateAssetVideoThumbnail/,
    '浏览器直传完成链路也必须复用视频封面生成模块',
  );
  assert.doesNotMatch(
    directUploadSource,
    /thumbnail_url:\s*kind === 'image' \? publicUrl : null/,
    '浏览器直传视频不能继续固定写入 thumbnail_url=null',
  );
}

function assertReferenceImportPublicUrlRules() {
  const referenceImportSource = fs.readFileSync(
    path.join(process.cwd(), 'src/lib/assets/reference-import.ts'),
    'utf8',
  );
  assert.match(
    referenceImportSource,
    /isPrivateNetworkHost/,
    '参考图导入也必须复用统一私网地址判断，避免 IPv6 本机地址漏过',
  );
  assert.doesNotMatch(
    referenceImportSource,
    /const isPrivateHost =/,
    '参考图导入不能保留独立旧私网判断',
  );
}

function assertLocalizationRunnerRules() {
  const localizationRunnerSource = fs.readFileSync(
    path.join(process.cwd(), 'src/lib/video/task-localization-runner.ts'),
    'utf8',
  );
  const finalizerSource = fs.readFileSync(
    path.join(process.cwd(), 'src/lib/video/task-finalizer.ts'),
    'utf8',
  );
  assert.match(
    localizationRunnerSource,
    /DEFAULT_INTERVAL_MS = 30_000/,
    'localization runner must not poll provider every 15 seconds under load',
  );
  assert.match(
    localizationRunnerSource,
    /DEFAULT_MAX_RUNTIME_MS = 5 \* 60 \* 1000/,
    'localization runner must stop within 5 minutes and leave retries to the scheduled finalizer',
  );
  assert.match(
    localizationRunnerSource,
    /DEFAULT_SUCCESS_CACHE_TIMEOUT_MS = 120_000/,
    'localization runner cache attempts must stay bounded so uploads and browsing are not starved',
  );

  assert.equal(
    shouldContinueLocalization({
      task: {
        id: 'task-success-remote-only',
        local_status: 'succeeded',
        local_video_path: null,
        result_video_url: 'https://example.test/video.mp4',
      },
      cacheResult: { success: false, error: 'Download timeout' },
      thumbnailResult: { success: false, error: 'No thumbnail source' },
    }),
    true,
    '任务成功但本地缓存/截图还没成功时 runner 应继续重试',
  );

  assert.equal(
    shouldContinueLocalization({
      task: {
        id: 'task-success-local-ready',
        local_status: 'succeeded',
        local_video_path: '/videos/task-success-local-ready.mp4',
        result_video_url: 'https://example.test/video.mp4',
      },
      cacheResult: { success: true },
      thumbnailResult: { success: true },
    }),
    false,
    '成功任务已有本地视频和截图后 runner 应停止',
  );

  assert.equal(
    shouldContinueLocalization({
      task: {
        id: 'task-failed',
        local_status: 'failed',
        local_video_path: null,
        result_video_url: 'https://example.test/video.mp4',
      },
      cacheResult: { success: false },
      thumbnailResult: { success: false },
    }),
    false,
    '失败任务不能因为有远端链接继续重试',
  );

  assert.match(
    finalizerSource,
    /ensureTaskThumbnail\(taskForThumbnail,\s*\{\s*allowRemoteFallback:\s*true\s*\}\)/,
    'finalizer 生成任务截图时必须允许 provider 公网结果兜底，不能依赖用户打开页面才抽图',
  );
}

async function assertThumbnailExtractPrefersLaterFrame() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sd2-thumb-smoke-'));
  const fakeFfmpegPath = path.join(tempDir, 'fake-ffmpeg.js');
  const seekLogPath = path.join(tempDir, 'seek.log');
  const taskId = `thumb-smoke-${Date.now()}`;
  const localVideoDir = path.join(process.cwd(), 'public', 'videos');
  const localVideoPath = path.join(localVideoDir, `${taskId}.mp4`);
  const thumbnailPath = path.join(localVideoDir, 'thumbnails', `${taskId}.jpg`);

  await mkdir(localVideoDir, { recursive: true });
  await writeFile(localVideoPath, Buffer.from([1, 2, 3]));
  await writeFile(fakeFfmpegPath, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    `const seekLogPath = ${JSON.stringify(seekLogPath)};`,
    'const args = process.argv.slice(2);',
    "const seek = args[args.indexOf('-ss') + 1];",
    "fs.appendFileSync(seekLogPath, `${seek}\\n`);",
    'const outputPath = args[args.length - 1];',
    "if (seek === '2.5') { fs.writeFileSync(outputPath, Buffer.from('fake-jpeg')); process.exit(0); }",
    "process.stderr.write(`unexpected seek ${seek}\\n`);",
    'process.exit(1);',
  ].join('\n'));
  await chmod(fakeFfmpegPath, 0o755);
  process.env.FFMPEG_PATH = fakeFfmpegPath;

  try {
    const { ensureTaskThumbnail } = await import('../src/lib/video/thumbnail');
    const result = await ensureTaskThumbnail({
      id: taskId,
      local_video_path: `/videos/${taskId}.mp4`,
      result_video_url: null,
      result_last_frame_url: null,
    }, { allowRemoteFallback: false });

    assert.equal(result.success, true);
  } finally {
    await rm(thumbnailPath, { force: true });
    await rm(localVideoPath, { force: true });
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function assertThumbnailExtractUsesPublicVideoFallback() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sd2-thumb-public-smoke-'));
  const fakeFfmpegPath = path.join(tempDir, 'fake-ffmpeg.js');
  const sourceLogPath = path.join(tempDir, 'source.log');
  const taskId = `thumb-public-${Date.now()}`;
  const thumbnailPath = path.join(process.cwd(), 'public', 'videos', 'thumbnails', `${taskId}.jpg`);
  const publicVideoUrl = 'https://cdn.example.test/video.mp4';

  await writeFile(fakeFfmpegPath, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    `const sourceLogPath = ${JSON.stringify(sourceLogPath)};`,
    'const args = process.argv.slice(2);',
    "const input = args[args.indexOf('-i') + 1];",
    "fs.appendFileSync(sourceLogPath, `${input}\\n`);",
    'const outputPath = args[args.length - 1];',
    `if (input === ${JSON.stringify(publicVideoUrl)}) { fs.writeFileSync(outputPath, Buffer.from('fake-jpeg')); process.exit(0); }`,
    "process.stderr.write(`unexpected input ${input}\\n`);",
    'process.exit(1);',
  ].join('\n'));
  await chmod(fakeFfmpegPath, 0o755);
  process.env.FFMPEG_PATH = fakeFfmpegPath;

  try {
    const { ensureTaskThumbnail } = await import('../src/lib/video/thumbnail');
    const result = await ensureTaskThumbnail({
      id: taskId,
      public_video_url: publicVideoUrl,
      local_video_path: `/videos/${taskId}-missing.mp4`,
      result_video_url: 'https://provider.example.test/signed.mp4',
      result_last_frame_url: null,
    }, { allowRemoteFallback: true });

    assert.equal(result.success, true);
    assert.equal((await fs.promises.readFile(sourceLogPath, 'utf8')).trim(), publicVideoUrl);
  } finally {
    await rm(thumbnailPath, { force: true });
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function assertAssetVideoThumbnailExtraction() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sd2-asset-video-thumb-smoke-'));
  const fakeFfmpegPath = path.join(tempDir, 'fake-ffmpeg.js');
  const videoPath = path.join(tempDir, 'asset-video.mp4');
  const outputDir = path.join(tempDir, 'thumbs');
  const outputPathLog = path.join(tempDir, 'output-path.log');

  await writeFile(videoPath, Buffer.from([1, 2, 3]));
  await writeFile(fakeFfmpegPath, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    "const path = require('path');",
    `const outputPathLog = ${JSON.stringify(outputPathLog)};`,
    'const args = process.argv.slice(2);',
    "const input = args[args.indexOf('-i') + 1];",
    'const outputPath = args[args.length - 1];',
    `if (input !== ${JSON.stringify(videoPath)}) { process.stderr.write('unexpected input'); process.exit(1); }`,
    'fs.mkdirSync(path.dirname(outputPath), { recursive: true });',
    "fs.writeFileSync(outputPath, Buffer.from('fake-asset-thumb'));",
    "fs.writeFileSync(outputPathLog, outputPath);",
  ].join('\n'));
  await chmod(fakeFfmpegPath, 0o755);

  try {
    const result = await generateAssetVideoThumbnail({
      sourcePath: videoPath,
      outputDir,
      outputName: 'asset-video',
      ffmpegPath: fakeFfmpegPath,
    });
    assert.equal(result.success, true);
    assert.match(result.thumbnailPath || '', /asset-video_thumb\.jpg$/);
    assert.equal(fs.existsSync(result.thumbnailPath || ''), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function assertAssetVideoThumbnailFailureDoesNotThrow() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sd2-asset-video-thumb-fail-smoke-'));
  const videoPath = path.join(tempDir, 'asset-video.mp4');
  const blockedOutputDir = path.join(tempDir, 'not-a-directory');

  await writeFile(videoPath, Buffer.from([1, 2, 3]));
  await writeFile(blockedOutputDir, Buffer.from('file blocks mkdir'));

  try {
    let result;
    try {
      result = await generateAssetVideoThumbnail({
        sourcePath: videoPath,
        outputDir: blockedOutputDir,
        outputName: 'asset-video',
        ffmpegPath: '/bin/false',
      });
    } catch (error) {
      throw new Error(`视频封面生成失败时不能向上传链路抛异常: ${error instanceof Error ? error.message : String(error)}`);
    }
    assert.equal(result.success, false);
    assert.equal(result.message, '视频封面生成失败');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  await assertThumbnailAvailabilityRules();
  assertAssetLibraryCachePolicy();
  assertDirectUploadVideoThumbnailRules();
  assertReferenceImportPublicUrlRules();
  assertLocalizationRunnerRules();
  await assertThumbnailExtractPrefersLaterFrame();
  await assertThumbnailExtractUsesPublicVideoFallback();
  await assertAssetVideoThumbnailExtraction();
  await assertAssetVideoThumbnailFailureDoesNotThrow();
  console.log('thumbnail pipeline smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
