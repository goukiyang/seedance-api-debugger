export const PROVIDER_REFERENCE_MEDIA_MIN_PIXELS = 409_600;

export type ReferenceMediaKind = 'image' | 'video';

export type ReferenceMediaSizeInput = {
  kind: ReferenceMediaKind;
  name?: string | null;
  width?: number | null;
  height?: number | null;
  index?: number;
};

export function referenceMediaPixelCount(width: number | null | undefined, height: number | null | undefined) {
  if (!width || !height || width <= 0 || height <= 0) return null;
  return width * height;
}

export function isReferenceMediaTooSmall(width: number | null | undefined, height: number | null | undefined) {
  const pixels = referenceMediaPixelCount(width, height);
  return pixels !== null && pixels < PROVIDER_REFERENCE_MEDIA_MIN_PIXELS;
}

export function referenceMediaKindLabel(kind: ReferenceMediaKind) {
  return kind === 'video' ? '视频' : '图片';
}

export function referenceMediaDimensionsText(width: number | null | undefined, height: number | null | undefined) {
  return width && height ? `${width}x${height}` : '未知尺寸';
}

export function referenceMediaTooSmallMessage(input: ReferenceMediaSizeInput) {
  const kindLabel = referenceMediaKindLabel(input.kind);
  const fallbackName = input.index != null ? `${kindLabel}${input.index + 1}` : `参考${kindLabel}`;
  const name = input.name?.trim() || fallbackName;
  const pixels = referenceMediaPixelCount(input.width, input.height);
  const pixelText = pixels === null ? '' : `，约 ${pixels} 像素`;
  return `参考${kindLabel}「${name}」分辨率太低：${referenceMediaDimensionsText(input.width, input.height)}${pixelText}。生成服务要求参考素材至少 ${PROVIDER_REFERENCE_MEDIA_MIN_PIXELS} 像素，请换更清晰的素材，或先放大、重新导出后再提交。`;
}
