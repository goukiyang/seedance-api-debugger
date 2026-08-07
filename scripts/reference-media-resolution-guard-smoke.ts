import assert from 'assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import {
  PROVIDER_REFERENCE_MEDIA_MIN_PIXELS,
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
assert.match(taskCreate, /REFERENCE_MEDIA_TOO_SMALL/);
assert.match(taskCreate, /REFERENCE_MEDIA_DIMENSIONS_MISSING/);
assert.match(taskCreate, /probePublicImageDimensions/);
assert.match(taskCreate, /probePublicVideoDimensions/);
assert.match(taskCreate, /urlHost: safeUrlHost/);
assert.match(taskCreate, /frameImageUrls: string\[\] = normalizeReferenceMediaUrls\(body\.frame_image_urls, 9\)/);
assert.doesNotMatch(taskCreate, /\\n\\s*url,\\n\\s*message:/);
assert.doesNotMatch(taskCreate, /const imageUrls = uniquePreserveOrder\(input\.imageUrls\)\.slice\(0, 9\)/);

const composer = read('src/components/GenerationComposer.tsx');
assert.match(composer, /referenceMediaResolutionBlocker/);
assert.match(composer, /reference-media-quality-warning/);

const referenceStrip = read('src/components/ReferenceStrip.tsx');
assert.match(referenceStrip, /ref-thumb-low-resolution/);
assert.match(referenceStrip, /ref-thumb-warning-badge/);

console.log('reference-media-resolution-guard smoke passed');
