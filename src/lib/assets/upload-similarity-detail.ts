import { openUntrustedImage, imageResizeKernel } from '@/lib/media/decode-image';
import pixelmatch from 'pixelmatch';

export const UPLOAD_SIMILARITY_DETAIL_ALGORITHM = 'imagehash-phash8-colorhash3-pixelmatch8-rgba384-window32-v2';
export const UPLOAD_SIMILARITY_DETAIL_SIZE = 384;
export const UPLOAD_SIMILARITY_DETAIL_BYTES = 384 * 384 * 4;
export const UPLOAD_SIMILARITY_LOCAL_THRESHOLDS = [0.1, 0.15, 0.2] as const;
export const UPLOAD_SIMILARITY_LOCAL_MAX_DIFFERENT_PIXELS = [0, 2, 4, 8, 16] as const;
export type UploadSimilarityDetail = { data: Buffer; width: 384; height: 384; sourceWidth: number; sourceHeight: number };
export type UploadSimilarityDetailDescriptor = { key: string; width: 384; height: 384; sourceWidth: number; sourceHeight: number;
  sha256: string; rgbaSha256: string };

export async function normalizeUploadSimilarityDetail(input: Buffer): Promise<UploadSimilarityDetail> {
  if (!Buffer.isBuffer(input) || input.length === 0 || input.length > 30 * 1024 * 1024) throw new Error('similarity_detail_input_invalid');
  const image = (await openUntrustedImage(input, 'ordinary', { animated: false })).timeout({ seconds: 45 });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height || (metadata.pages || 1) !== 1) throw new Error('similarity_detail_dimensions_invalid');
  const swap = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
  const sourceWidth = swap ? metadata.height : metadata.width, sourceHeight = swap ? metadata.width : metadata.height;
  if (sourceWidth * sourceHeight > 40_000_000) throw new Error('similarity_detail_dimensions_invalid');
  const result = await image.rotate().toColourspace('srgb')
    .resize(384, 384, { fit: 'fill', kernel: imageResizeKernel.lanczos3 })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (result.info.width !== 384 || result.info.height !== 384 || result.info.channels !== 4
    || result.data.length !== UPLOAD_SIMILARITY_DETAIL_BYTES) throw new Error('similarity_detail_rgba_invalid');
  return { data: result.data, width: 384, height: 384, sourceWidth, sourceHeight };
}

function validateDetail(value: UploadSimilarityDetail) {
  if (value.width !== 384 || value.height !== 384 || !Buffer.isBuffer(value.data) || value.data.length !== UPLOAD_SIMILARITY_DETAIL_BYTES
    || !Number.isSafeInteger(value.sourceWidth) || !Number.isSafeInteger(value.sourceHeight) || value.sourceWidth <= 0 || value.sourceHeight <= 0
    || value.sourceWidth * value.sourceHeight > 40_000_000) throw new Error('similarity_detail_rgba_invalid');
}

export function compareUploadSimilarityDetail(left: UploadSimilarityDetail, right: UploadSimilarityDetail, threshold: number): number {
  validateDetail(left); validateDetail(right);
  if (!(UPLOAD_SIMILARITY_LOCAL_THRESHOLDS as readonly number[]).includes(threshold)) throw new Error('similarity_detail_threshold_invalid');
  const leftAspect = left.sourceWidth / left.sourceHeight, rightAspect = right.sourceWidth / right.sourceHeight;
  if (Math.abs(leftAspect - rightAspect) / Math.min(leftAspect, rightAspect) > 0.01) return Infinity;
  // Pixelmatch 8's windowed return is the maximum over every 32x32 sliding
  // window, not the total count. Copies also guarantee aligned byte offsets.
  return pixelmatch(Buffer.from(left.data), Buffer.from(right.data), null, 384, 384,
    { threshold, windowSize: 32, includeAA: false, checkerboard: true });
}
