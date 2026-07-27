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
  const fileUploadHelperForAlbum = read('src/lib/http/file-upload.ts');
  assertIncludes(fileUploadHelperForAlbum, 'validateClientMediaDuration', '统一 Asset 上传必须在图集挂载前校验视频/音频时长');
  assertIncludes(fileUploadHelperForAlbum, '/api/assets/upload-ticket', '统一 Asset 上传必须先走上传票据，不能让图集接口直收文件');
  assertIncludes(albumImagesRoute, "export const maxDuration = 120", '参考图集上传接口必须允许较长视频/音频上传处理时间');
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

  const uploadProgressHelper = read('src/lib/http/upload-progress.ts');
  assertIncludes(uploadProgressHelper, 'xhr.upload.onprogress', '通用上传请求必须读取浏览器真实上传进度');
  assertIncludes(uploadProgressHelper, 'event.lengthComputable', '上传百分比只能在浏览器提供总字节数时计算');
  assertIncludes(uploadProgressHelper, 'percent?: number', '上传进度类型必须允许没有真实百分比的阶段状态');

  const uploadProgressIndicator = read('src/components/UploadProgressIndicator.tsx');
  assertIncludes(uploadProgressIndicator, "role={percentText ? 'progressbar' : 'status'}", '进度组件有真实百分比时才显示 progressbar');
  assertIncludes(uploadProgressIndicator, '<em>处理中</em>', '没有真实百分比时必须显示阶段状态，不能伪造百分比');

  const referenceStrip = read('src/components/ReferenceStrip.tsx');
  assertIncludes(referenceStrip, 'UploadProgressIndicator', '生成工作台参考图上传必须显示进度组件');
  assertIncludes(referenceStrip, 'onUpload(file, (progress)', '生成工作台参考图上传必须接收真实上传进度');
  assertIncludes(referenceStrip, 'ref-strip-upload-progress', '生成工作台参考图上传必须有稳定进度条样式入口');

  const uploadedImagePicker = read('src/components/UploadedImagePicker.tsx');
  assertIncludes(uploadedImagePicker, 'UploadProgressIndicator', '上传历史图片弹窗必须显示进度组件');
  assertIncludes(uploadedImagePicker, 'onUploadFile(file, (progress)', '上传历史图片弹窗必须接收真实上传进度');
  assertIncludes(uploadedImagePicker, 'uploaded-picker-progress', '上传历史图片弹窗必须有稳定进度条样式入口');

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
  assertIncludes(albumDetail, 'uploadFeedback', '图集详情页上传必须显示处理中和成功提示');
  assertIncludes(albumDetail, 'uploadFileAsAsset(file, {', '图集详情页上传必须先走统一 Asset 上传 helper');
  assertIncludes(albumDetail, 'assetIds', '图集详情页上传必须通过 assetIds 挂载业务对象');
  assertIncludes(albumDetail, 'pendingAlbumAttach', '图集详情页挂载失败后必须保留可重试的 assetIds');
  assertIncludes(albumDetail, 'UploadProgressIndicator', '图集详情页上传必须显示进度组件');
  assertIncludes(albumDetail, 'album-upload-progress', '图集详情页上传必须有稳定进度条样式入口');
  assertIncludes(albumDetail, '正在上传', '图集详情页上传开始后必须告诉用户正在处理');
  assertIncludes(albumDetail, '上传成功，正在刷新图集列表', '图集详情页上传成功后必须显示刷新状态');
  assertIncludes(albumDetail, '已上传 ${uploadedCount} 个素材到图集', '图集详情页刷新后必须显示上传成功提示');
  assertIncludes(albumDetail, 'await loadAlbum()', '图集详情页上传成功后必须等待列表刷新完成');
  assertIncludes(albumDetail, '上传处理中...', '图集详情页上传期间按钮文案必须反馈状态');

  const assetLibraryPage = read('src/app/assets/page.tsx');
  assertIncludes(assetLibraryPage, 'UploadProgressIndicator', '资产管理页本地上传必须显示进度组件');
  assertIncludes(assetLibraryPage, 'uploadFileAsAsset(selectedFile, {', '资产管理页本地上传必须走统一 Asset 上传 helper');
  assertIncludes(assetLibraryPage, 'onProgress: (progress)', '资产管理页本地上传必须接收真实上传进度');
  assertIncludes(assetLibraryPage, 'accept="image/*,video/*"', '资产管理页本地上传必须允许视频文件');
  assertIncludes(assetLibraryPage, 'asset-library-upload-progress', '资产管理页本地上传必须有稳定进度条样式入口');
  assertIncludes(assetLibraryPage, '支持图片和 2-15 秒视频', '资产管理页必须向用户说明视频上传范围');

  const globals = read('src/app/globals.css');
  assertIncludes(globals, '.asset-library-upload-panel', '资产管理页上传条必须有稳定布局样式');
  assertIncludes(globals, '.asset-library-upload-progress', '资产管理页上传进度必须有稳定样式入口');

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
