import { prisma } from '@/lib/prisma';
import { uploadAsset } from '@/lib/assets/storage';
import { isPubliclyReachableUrl, uploadPublicAsset } from '@/lib/assets/public-storage';

export const SITE_UPLOAD_ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
  'video/mp4', 'video/quicktime', 'video/webm',
  'audio/mpeg', 'audio/wav', 'audio/ogg',
] as const;

export const SITE_UPLOAD_MAX_SIZE = 50 * 1024 * 1024;

export type SiteUploadResult = {
  assetId: string;
  originalUrl: string;
  thumbnailUrl: string | null;
  width?: number;
  height?: number;
  fileName: string;
  fileSize: number;
  mimeType: string;
  hash: string;
  reused: boolean;
  isPubliclyReachable: boolean;
  storageProvider?: string;
  publicUploadWarning?: string;
};

export function validateSiteUploadInput(file: File) {
  if (!SITE_UPLOAD_ALLOWED_TYPES.includes(file.type as (typeof SITE_UPLOAD_ALLOWED_TYPES)[number])) {
    return `Unsupported file type: ${file.type}`;
  }
  if (file.size > SITE_UPLOAD_MAX_SIZE) {
    return `File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB (max 50MB)`;
  }
  return null;
}

export async function uploadSiteAsset(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
  fileSize: number,
  ownerId: string,
): Promise<SiteUploadResult> {
  const localResult = await uploadAsset(buffer, fileName, mimeType, ownerId);

  if (localResult.reused) {
    const isPubliclyReachable = isPubliclyReachableUrl(localResult.originalUrl);
    return {
      ...localResult,
      fileName,
      fileSize,
      mimeType,
      isPubliclyReachable,
      publicUploadWarning: isPubliclyReachable
        ? undefined
        : '已复用已有本地素材链接，当前链接不是公网地址。',
    };
  }

  try {
    const pubResult = await uploadPublicAsset(buffer, fileName, mimeType);

    await prisma.asset.update({
      where: { id: localResult.assetId },
      data: { original_url: pubResult.publicUrl },
    });

    return {
      ...localResult,
      originalUrl: pubResult.publicUrl,
      fileName,
      fileSize,
      mimeType,
      isPubliclyReachable: pubResult.isPubliclyReachable,
      storageProvider: pubResult.storageProvider,
      publicUploadWarning: pubResult.warning,
    };
  } catch (pubError) {
    return {
      ...localResult,
      fileName,
      fileSize,
      mimeType,
      isPubliclyReachable: false,
      publicUploadWarning: `公网上传失败: ${pubError instanceof Error ? pubError.message : String(pubError)}，已回退到本地存储。Seedance 无法访问本地 URL。`,
    };
  }
}
