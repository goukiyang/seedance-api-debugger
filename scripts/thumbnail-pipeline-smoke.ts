import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { canRequestTaskThumbnail, shouldExposeTaskThumbnailUrl } from '../src/lib/video/thumbnail-availability';
import { shouldContinueLocalization } from '../src/lib/video/task-localization-runner';

async function assertThumbnailAvailabilityRules() {
  assert.equal(
    canRequestTaskThumbnail({ localVideoPath: null, resultLastFrameUrl: null }),
    false,
    '远端 mp4-only 任务不能请求截图接口',
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
      localVideoPath: null,
      resultLastFrameUrl: null,
    }),
    true,
    '服务端已经有缩略图文件时可以返回 thumbnailUrl',
  );
  assert.equal(
    shouldExposeTaskThumbnailUrl({
      hasExistingThumbnail: false,
      localVideoPath: null,
      resultLastFrameUrl: null,
    }),
    false,
    '没有本地视频、尾帧和已有缩略图时不能返回假 thumbnailUrl',
  );
}

function assertLocalizationRunnerRules() {
  const localizationRunnerSource = fs.readFileSync(
    path.join(process.cwd(), 'src/lib/video/task-localization-runner.ts'),
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

async function main() {
  await assertThumbnailAvailabilityRules();
  assertLocalizationRunnerRules();
  await assertThumbnailExtractPrefersLaterFrame();
  console.log('thumbnail pipeline smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
