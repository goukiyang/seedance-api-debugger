import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const root = process.cwd();

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assertIncludes(source: string, needle: string, message: string) {
  assert.ok(source.includes(needle), message);
}

function assertNotIncludes(source: string, needle: string, message: string) {
  assert.ok(!source.includes(needle), message);
}

function generateTinyVideo(filePath: string, seconds: number) {
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=32x32:d=${seconds}`,
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    filePath,
  ], { stdio: 'pipe' });
}

function generateTinyAudio(filePath: string, seconds: number) {
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${seconds}`,
    '-c:a',
    'libmp3lame',
    filePath,
  ], { stdio: 'pipe' });
}

async function assertMediaDurationValidation() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-ref-smoke-'));
  try {
    const { validateSiteUploadBuffer, validateSiteUploadInput } = await import('../src/lib/assets/site-upload');
    const validVideoPath = path.join(tempDir, 'valid.mp4');
    const shortVideoPath = path.join(tempDir, 'short.mp4');
    const validAudioPath = path.join(tempDir, 'valid.mp3');
    const shortAudioPath = path.join(tempDir, 'short.mp3');

    generateTinyVideo(validVideoPath, 2.2);
    generateTinyVideo(shortVideoPath, 1);
    generateTinyAudio(validAudioPath, 2.2);
    generateTinyAudio(shortAudioPath, 1);

    assert.equal(
      await validateSiteUploadBuffer(fs.readFileSync(validVideoPath), 'valid.mp4', 'video/mp4'),
      null,
      '2 秒以上视频应该通过参考视频时长校验',
    );
    assert.match(
      await validateSiteUploadBuffer(fs.readFileSync(shortVideoPath), 'short.mp4', 'video/mp4') || '',
      /2-15 秒/,
      '1 秒视频应该被参考视频时长校验拦截',
    );
    assert.equal(
      await validateSiteUploadBuffer(fs.readFileSync(validAudioPath), 'valid.mp3', 'audio/mpeg'),
      null,
      '2 秒以上音频应该通过参考音频时长校验',
    );
    assert.match(
      await validateSiteUploadBuffer(fs.readFileSync(shortAudioPath), 'short.mp3', 'audio/mpeg') || '',
      /2-15 秒/,
      '1 秒音频应该被参考音频时长校验拦截',
    );

    const oversizeAudio = { type: 'audio/mpeg', size: 16 * 1024 * 1024, name: 'large.mp3' } as File;
    assert.match(
      validateSiteUploadInput(oversizeAudio) || '',
      /最大 15MB/,
      '音频上传大小上限应该是 15MB',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const albumImagesRoute = read('src/app/api/reference-albums/[id]/images/route.ts');
  assertIncludes(
    albumImagesRoute,
    "type === 'image' || type === 'video' || type === 'audio'",
    '参考图集保存接口必须允许 image/video/audio 三类参考素材',
  );
  assertNotIncludes(
    albumImagesRoute,
    "file.type.startsWith('image/')",
    '参考图集上传不能继续用 image/* 拦截视频和音频',
  );
  assertNotIncludes(
    albumImagesRoute,
    "asset.type !== 'image'",
    '参考图集保存不能继续拒绝非图片素材',
  );
  assertIncludes(albumImagesRoute, 'validateSiteUploadBuffer', '参考图集上传必须校验视频/音频时长');
  assertIncludes(albumImagesRoute, 'ensureSiteAssetPublicUrl', '参考图集复用历史视频/音频素材前必须补公网 URL');
  assertIncludes(albumImagesRoute, 'ensureReferenceAssetReady(sourceImage.asset)', '复制图集里的历史视频/音频素材前必须补公网 URL');

  const siteUpload = read('src/lib/assets/site-upload.ts');
  assertIncludes(siteUpload, 'SITE_UPLOAD_MAX_SIZE_BY_KIND', '上传大小必须按图片/视频/音频分开限制');
  assertIncludes(siteUpload, 'video: 200 * 1024 * 1024', '参考视频上传上限应该是 200MB');
  assertIncludes(siteUpload, 'audio: 15 * 1024 * 1024', '参考音频上传上限应该是 15MB');
  assertNotIncludes(siteUpload, 'SITE_UPLOAD_MAX_SIZE = 50', '不能继续使用 50MB 统一上传上限');
  assertNotIncludes(siteUpload, 'if (localResult.reused)', '复用旧素材时也必须尝试补公网 URL');
  assertIncludes(siteUpload, 'ensureSiteAssetPublicUrl', '必须提供历史素材补公网 URL 的复用兜底函数');
  assertIncludes(siteUpload, '历史素材本地文件不存在', '历史本地素材缺文件时必须给明确错误');

  const workspaceAssetsRoute = read('src/app/api/workspace/assets/route.ts');
  assertIncludes(workspaceAssetsRoute, "return 'reference_video'", '视频素材加入工作台时必须标记为 reference_video');
  assertIncludes(workspaceAssetsRoute, "return 'reference_audio'", '音频素材加入工作台时必须标记为 reference_audio');
  assertIncludes(workspaceAssetsRoute, 'ensureNonImageAssetReadyForGeneration', '工作区复用历史视频/音频素材前必须补公网 URL');

  const codexUploadRoute = read('src/app/api/codex/assets/upload/route.ts');
  assertIncludes(codexUploadRoute, 'roleForMimeType', 'Codex 上传必须按素材类型分配 reference role');
  assertIncludes(codexUploadRoute, "uploadResult.mimeType.startsWith('image/')", 'Codex 上传只有图片才能进入 reference image 归档');
  assertIncludes(codexUploadRoute, 'addAssetToWorkspace', 'Codex 上传视频/音频必须能直接加入 workspace');
  assertIncludes(codexUploadRoute, 'referenceImageId: reference?.referenceImageId || null', 'Codex 上传视频/音频不应伪造 referenceImageId');

  const generationComposer = read('src/components/GenerationComposer.tsx');
  assertIncludes(generationComposer, 'referenceVideoUrls: workspace.assets', '生成提交必须从工作区收集参考视频 URL');
  assertIncludes(generationComposer, "asset.type === 'video'", '生成提交必须按素材类型识别视频');
  assertIncludes(generationComposer, 'referenceAudioUrls: workspace.assets', '生成提交必须从工作区收集参考音频 URL');
  assertIncludes(generationComposer, "asset.type === 'audio'", '生成提交必须按素材类型识别音频');

  const generatePage = read('src/components/generate/GeneratePageClient.tsx');
  assertIncludes(generatePage, 'reference_video_urls: params.referenceVideoUrls || []', '普通生成页必须把参考视频 URL 传给创建任务接口');
  assertIncludes(generatePage, 'reference_audio_urls: params.referenceAudioUrls || []', '普通生成页必须把参考音频 URL 传给创建任务接口');

  const templateGeneratePage = read('src/components/templates/TemplateGenerateClient.tsx');
  assertIncludes(templateGeneratePage, 'reference_video_urls: params.referenceVideoUrls || []', '模板生成页必须把参考视频 URL 传给创建任务接口');
  assertIncludes(templateGeneratePage, 'reference_audio_urls: params.referenceAudioUrls || []', '模板生成页必须把参考音频 URL 传给创建任务接口');

  const tasksCreate = read('src/app/api/tasks/create/route.ts');
  const ipTasksCreate = read('src/app/api/ip/tasks/create/route.ts');
  for (const source of [tasksCreate, ipTasksCreate]) {
    assertIncludes(source, 'isPubliclyReachableUrl', '任务创建接口必须拦截非公网参考视频/音频 URL');
    assertIncludes(source, '音频参考不能单独使用', '任务创建接口必须拦截单独音频参考');
  }

  const contentRoute = read('src/app/api/reference-images/[id]/content/route.ts');
  assertIncludes(contentRoute, 'canUseAlbumImage', '视频/音频无缩略图预览必须要求生成或下载权限');
  assertIncludes(contentRoute, '无权预览原始视频/音频素材', '视频/音频原始预览必须有明确权限错误');

  const albumDetail = read('src/app/collections/[id]/ReferenceAlbumDetailClient.tsx');
  assertIncludes(albumDetail, 'canPreviewOriginalMedia', '图集详情页不应给无使用/下载权限者直接加载原始视频');

  const referenceThumb = read('src/components/ReferenceThumb.tsx');
  assertIncludes(referenceThumb, '<video', '工作区参考素材缩略图必须能展示视频预览');
  assertIncludes(referenceThumb, 'ref-thumb-media-placeholder', '工作区参考素材缩略图必须能展示音频占位');

  await assertMediaDurationValidation();

  console.log('reference-media-chain-smoke: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
