import path from 'path';
import sharp from 'sharp';
import { uploadPublicAsset } from '@/lib/assets/public-storage';

export const PROVIDER_REFERENCE_IMAGE_MAX_PIXELS = 36_000_000;
const PROVIDER_REFERENCE_IMAGE_TARGET_PIXELS = 32_000_000;
const PROVIDER_REFERENCE_IMAGE_MAX_EDGE = 8192;
const REFERENCE_IMAGE_FETCH_TIMEOUT_MS = 90_000;

export interface ProviderReferenceImageAsset {
  file_name?: string | null;
  width?: number | null;
  height?: number | null;
  mime_type?: string | null;
}

export interface ProviderSafeReferenceImageResult {
  originalUrl: string;
  providerUrl: string;
  resized: boolean;
  width?: number;
  height?: number;
  outputWidth?: number;
  outputHeight?: number;
  originalPixels?: number;
  maxPixels?: number;
}

export function getProviderSafeImageResizeDimensions(
  width: number | null | undefined,
  height: number | null | undefined,
) {
  if (!width || !height || width <= 0 || height <= 0) return null;

  const pixels = width * height;
  let scale = 1;

  if (pixels > PROVIDER_REFERENCE_IMAGE_TARGET_PIXELS) {
    scale = Math.min(scale, Math.sqrt(PROVIDER_REFERENCE_IMAGE_TARGET_PIXELS / pixels));
  }

  const longestEdge = Math.max(width, height);
  if (longestEdge > PROVIDER_REFERENCE_IMAGE_MAX_EDGE) {
    scale = Math.min(scale, PROVIDER_REFERENCE_IMAGE_MAX_EDGE / longestEdge);
  }

  if (scale >= 1) return null;

  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    originalPixels: pixels,
    maxPixels: PROVIDER_REFERENCE_IMAGE_MAX_PIXELS,
  };
}

function outputName(fileName: string | null | undefined, mimeType: string) {
  const parsed = path.parse(fileName || 'reference-image');
  const ext = mimeType === 'image/png' ? '.png' : '.jpg';
  return `${parsed.name || 'reference-image'}-provider-safe${ext}`;
}

export function isProviderReferenceImageSizeError(message: string | null | undefined) {
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes('image exceeds the maximum allowed total pixels')
    || lower.includes('maximum allowed total pixels')
    || lower.includes('exceeds the maximum allowed')
    || lower.includes('参考图尺寸过大')
    || lower.includes('图片尺寸过大');
}

export function providerReferenceImageSizeMessage(rawMessage?: string | null) {
  const suffix = rawMessage && rawMessage.trim()
    ? ` 原始提示：${rawMessage.trim()}`
    : '';
  return `参考图尺寸过大，已超过视频生成服务允许的图片大小。系统会优先自动压缩到合规尺寸；如果仍失败，请换一张更小的图或先压缩后再提交。${suffix}`;
}

async function fetchImageBuffer(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REFERENCE_IMAGE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`图片下载失败 HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

export async function ensureProviderSafeReferenceImageUrl(params: {
  originalUrl: string;
  asset?: ProviderReferenceImageAsset | null;
}): Promise<ProviderSafeReferenceImageResult> {
  const { originalUrl, asset } = params;
  const knownResize = getProviderSafeImageResizeDimensions(asset?.width, asset?.height);
  if (asset?.width && asset?.height && !knownResize) {
    return { originalUrl, providerUrl: originalUrl, resized: false, width: asset?.width ?? undefined, height: asset?.height ?? undefined };
  }

  const buffer = await fetchImageBuffer(originalUrl);
  const image = sharp(buffer, { limitInputPixels: false }).rotate();
  const metadata = await image.metadata();
  const resize = getProviderSafeImageResizeDimensions(metadata.width, metadata.height);
  if (!resize) {
    return {
      originalUrl,
      providerUrl: originalUrl,
      resized: false,
      width: metadata.width,
      height: metadata.height,
      originalPixels: metadata.width && metadata.height ? metadata.width * metadata.height : undefined,
      maxPixels: PROVIDER_REFERENCE_IMAGE_MAX_PIXELS,
    };
  }

  const resizedImage = image.resize(resize.width, resize.height, {
    fit: 'inside',
    withoutEnlargement: true,
  });
  const outputMimeType = metadata.hasAlpha ? 'image/png' : 'image/jpeg';
  const outputBuffer = metadata.hasAlpha
    ? await resizedImage.png({ compressionLevel: 9 }).toBuffer()
    : await resizedImage.jpeg({ quality: 92, mozjpeg: true }).toBuffer();

  const upload = await uploadPublicAsset(
    outputBuffer,
    outputName(asset?.file_name, outputMimeType),
    outputMimeType,
  );

  if (!upload.isPubliclyReachable) {
    throw new Error(upload.warning || '压缩后的参考图没有公网地址');
  }

  return {
    originalUrl,
    providerUrl: upload.publicUrl,
    resized: true,
    width: metadata.width,
    height: metadata.height,
    outputWidth: resize.width,
    outputHeight: resize.height,
    originalPixels: resize.originalPixels,
    maxPixels: resize.maxPixels,
  };
}
