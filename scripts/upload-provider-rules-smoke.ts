import assert from 'node:assert/strict';

import {
  validateSiteUploadDuration,
  validateSiteUploadBuffer,
} from '../src/lib/assets/site-upload';
import {
  SEEDANCE_REFERENCE_MEDIA_RULES,
  validateSeedanceReferenceMediaPreflight,
} from '../src/lib/provider/reference-media-policy';

function rule(id: string) {
  return SEEDANCE_REFERENCE_MEDIA_RULES.find((item) => item.id === id);
}

async function main() {
  assert.equal(
    validateSiteUploadDuration('video/mp4', 1),
    null,
    '素材库上传不应再用 Seedance 2.0 生成时长规则拦截短视频入库',
  );
  assert.equal(
    validateSiteUploadDuration('audio/mpeg', 30),
    null,
    '素材库上传不应再用 Seedance 2.0 生成时长规则拦截长音频入库',
  );
  assert.equal(
    await validateSiteUploadBuffer(Buffer.from('not a real video'), 'broken.mp4', 'video/mp4'),
    null,
    '视频/音频元数据读取失败不应直接阻断素材入库，生成前再补探测或提示',
  );

  assert.equal(rule('upload.file_size.image')?.source, 'official');
  assert.equal(rule('upload.file_size.image')?.stage, 'asset_ingest');
  assert.equal(rule('seedance2.video.duration')?.source, 'official');
  assert.equal(rule('seedance2.video.duration')?.stage, 'generation_preflight');
  assert.equal(rule('upload.legacy_multipart_8mb')?.source, 'internal_link');
  assert.equal(rule('upload.legacy_multipart_8mb')?.stage, 'transport_capability');

  const tooManyImagesIssue = validateSeedanceReferenceMediaPreflight({
    images: Array.from({ length: 10 }, (_, index) => ({
      url: `https://example.invalid/image-${index}.png`,
      width: 1280,
      height: 720,
    })),
    videos: [],
    audios: [],
  });
  assert.equal(tooManyImagesIssue?.code, 'REFERENCE_IMAGE_COUNT_EXCEEDED');

  const tooManyVideosIssue = validateSeedanceReferenceMediaPreflight({
    images: [{ url: 'https://example.invalid/image.png', width: 1280, height: 720 }],
    videos: Array.from({ length: 4 }, (_, index) => ({
      url: `https://example.invalid/video-${index}.mp4`,
      mimeType: 'video/mp4',
    })),
    audios: [],
  });
  assert.equal(tooManyVideosIssue?.code, 'REFERENCE_VIDEO_COUNT_EXCEEDED');

  const tooManyAudiosIssue = validateSeedanceReferenceMediaPreflight({
    images: [{ url: 'https://example.invalid/image.png', width: 1280, height: 720 }],
    videos: [],
    audios: Array.from({ length: 4 }, (_, index) => ({
      url: `https://example.invalid/audio-${index}.mp3`,
      mimeType: 'audio/mpeg',
    })),
  });
  assert.equal(tooManyAudiosIssue?.code, 'REFERENCE_AUDIO_COUNT_EXCEEDED');

  const audioOnlyIssue = validateSeedanceReferenceMediaPreflight({
    images: [],
    videos: [],
    audios: [{ url: 'https://example.invalid/audio.mp3', mimeType: 'audio/mpeg' }],
  });
  assert.equal(audioOnlyIssue?.code, 'REFERENCE_AUDIO_REQUIRES_VISUAL');

  const shortVideoIssue = validateSeedanceReferenceMediaPreflight({
    videos: [{
      url: 'https://example.invalid/short.mp4',
      mimeType: 'video/mp4',
      durationSeconds: 1,
      width: 1280,
      height: 720,
    }],
    audios: [],
    images: [],
  });
  assert.equal(shortVideoIssue?.code, 'REFERENCE_VIDEO_DURATION_UNSUPPORTED');
  assert.match(shortVideoIssue?.message || '', /2-15 秒/);

  const webmIssue = validateSeedanceReferenceMediaPreflight({
    videos: [{
      url: 'https://example.invalid/clip.webm',
      mimeType: 'video/webm',
      durationSeconds: 5,
      width: 1280,
      height: 720,
    }],
    audios: [],
    images: [],
  });
  assert.equal(webmIssue?.code, 'REFERENCE_VIDEO_FORMAT_UNSUPPORTED');
  assert.match(webmIssue?.message || '', /MP4\/MOV/);

  const unknownMetadataIssue = validateSeedanceReferenceMediaPreflight({
    videos: [{
      url: 'https://example.invalid/missing-metadata.mp4',
      mimeType: 'video/mp4',
      durationSeconds: null,
      width: null,
      height: null,
    }],
    audios: [],
    images: [],
  });
  assert.equal(
    unknownMetadataIssue,
    null,
    '缺少元数据属于待确认风险，不应在生成前静态硬拦；后端可再探测并记录',
  );

  console.log('upload-provider-rules-smoke: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
