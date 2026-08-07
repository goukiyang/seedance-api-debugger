import assert from 'assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import {
  PROVIDER_REFERENCE_MEDIA_MIN_PIXELS,
  validateSeedanceReferenceMediaPreflight,
  isReferenceMediaTooSmall,
  referenceMediaTooSmallMessage,
} from '../src/lib/provider/reference-media-policy';

const root = process.cwd();
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), 'utf8');

assert.equal(PROVIDER_REFERENCE_MEDIA_MIN_PIXELS, 409_600);
assert.equal(isReferenceMediaTooSmall(480, 480), true);
assert.equal(isReferenceMediaTooSmall(640, 640), false);
assert.match(
  referenceMediaTooSmallMessage({
    kind: 'video',
    name: '素材1.mp4',
    width: 480,
    height: 480,
  }),
  /参考视频「素材1\.mp4」分辨率太低/,
);
assert.equal(
  validateSeedanceReferenceMediaPreflight({
    images: [{ url: 'https://cdn.example.com/no-size.png', index: 0, name: '无尺寸图片', mimeType: 'image/png' }],
    videos: [],
    audios: [],
  }),
  null,
  '缺少宽高的素材不应被当成已知低分辨率问题硬拦',
);
assert.match(
  validateSeedanceReferenceMediaPreflight({
    images: [{ url: 'https://cdn.example.com/small.png', index: 0, name: '低清图', mimeType: 'image/png', width: 480, height: 480 }],
    videos: [],
    audios: [],
  })?.message || '',
  /分辨率太低/,
  '已知低分辨率素材仍应在生成前拦截',
);

const browserUpload = read('src/lib/http/file-upload.ts');
assert.match(browserUpload, /videoWidth/);
assert.match(browserUpload, /X-Media-Width/);
assert.match(browserUpload, /X-Media-Height/);

const rawStorage = read('src/lib/assets/storage.ts');
assert.match(rawStorage, /assetType === 'video'/);
assert.match(rawStorage, /providedWidth/);

const directUpload = read('src/lib/assets/direct-upload.ts');
assert.match(directUpload, /fillMissingAssetDimensions/);
assert.match(directUpload, /kind === 'audio' \? null : normalizeOptionalInt/);

const taskCreate = read('src/app/api/tasks/create/route.ts');
assert.match(taskCreate, /validateReferenceMediaResolution/);
assert.match(taskCreate, /validateReferenceMediaProviderPreflight/);
assert.match(taskCreate, /validateSeedanceReferenceMediaPreflight/);
assert.match(taskCreate, /REFERENCE_MEDIA_TOO_SMALL/);
assert.match(taskCreate, /probePublicImageDimensions/);
assert.match(taskCreate, /probePublicVideoDimensions/);
assert.match(taskCreate, /probePublicAudioMetadata/);
assert.match(taskCreate, /urlHost: safeUrlHost/);
assert.match(taskCreate, /frameImageUrls: string\[\] = normalizeReferenceMediaUrlList\(body\.frame_image_urls\)/);
assert.doesNotMatch(taskCreate, /frameImageUrls: string\[\] = normalizeReferenceMediaUrls\(body\.frame_image_urls, 9\)/);
assert.doesNotMatch(taskCreate, /\\n\\s*url,\\n\\s*message:/);
assert.doesNotMatch(taskCreate, /const imageUrls = uniquePreserveOrder\(input\.imageUrls\)\.slice\(0, 9\)/);

const composer = read('src/components/GenerationComposer.tsx');
assert.match(composer, /referenceMediaPreflightBlocker/);
assert.match(composer, /validateSeedanceReferenceMediaPreflight/);
assert.match(composer, /reference-media-quality-warning/);

const referenceStrip = read('src/components/ReferenceStrip.tsx');
assert.match(referenceStrip, /ref-thumb-low-resolution/);
assert.match(referenceStrip, /ref-thumb-warning-badge/);

console.log('reference-media-resolution-guard smoke passed');
