import { prisma } from '@/lib/prisma';
import { uploadAsset } from '@/lib/assets/storage';
import { isPubliclyReachableUrl, uploadPublicAsset } from '@/lib/assets/public-storage';
import { execFile } from 'child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const SITE_UPLOAD_ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
  'video/mp4', 'video/quicktime', 'video/webm',
  'audio/mpeg', 'audio/wav', 'audio/ogg',
] as const;

type SiteUploadKind = 'image' | 'video' | 'audio';

export type SiteUploadMediaMetadata = {
  durationSeconds?: number | null;
  width?: number | null;
  height?: number | null;
};

export const SITE_UPLOAD_MAX_SIZE_BY_KIND: Record<SiteUploadKind, number> = {
  image: 30 * 1024 * 1024,
  video: 200 * 1024 * 1024,
  audio: 15 * 1024 * 1024,
};

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

export type SiteAssetPublicUrlResult = {
  asset: {
    id: string;
    type: string;
    original_url: string;
    thumbnail_url: string | null;
    file_name: string;
    mime_type: string;
    file_size: number;
  };
  isPubliclyReachable: boolean;
  storageProvider?: string;
  publicUploadWarning?: string;
};

export function isLocalPublicUploadUrl(url: string) {
  return url.startsWith('/uploads/');
}

export function sameOriginPublicUrlForLocalUpload(url: string) {
  if (!isLocalPublicUploadUrl(url)) return null;
  const baseUrl = (process.env.NEXT_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl || !isPubliclyReachableUrl(baseUrl)) return null;
  return `${baseUrl}${url}`;
}

function isSameOriginPublicUploadUrl(url: string) {
  const baseUrl = (process.env.NEXT_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return Boolean(baseUrl && url.startsWith(`${baseUrl}/uploads/`));
}

function resolveLocalPublicPath(url: string) {
  if (!isLocalPublicUploadUrl(url)) {
    throw new Error('本地素材路径非法');
  }
  const publicRoot = path.resolve(process.cwd(), 'public');
  const resolvedPath = path.resolve(publicRoot, url.replace(/^\/+/, ''));
  if (!resolvedPath.startsWith(`${publicRoot}${path.sep}`)) {
    throw new Error('本地素材路径非法');
  }
  return resolvedPath;
}

export function getSiteUploadKind(mimeType: string): SiteUploadKind | null {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return null;
}

function uploadKindLabel(kind: SiteUploadKind) {
  if (kind === 'image') return '图片';
  if (kind === 'video') return '视频';
  return '音频';
}

function formatMb(bytes: number) {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

function normalizeProbeDimension(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const next = Math.floor(parsed);
  return next > 0 && next < 100000 ? next : null;
}

export async function readSiteUploadMediaMetadata(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<SiteUploadMediaMetadata> {
  const kind = getSiteUploadKind(mimeType);
  if (kind !== 'video' && kind !== 'audio') return {};

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sd2-ref-media-'));
  const safeFileName = path.basename(fileName || 'media.bin') || 'media.bin';
  const tempPath = path.join(tempDir, safeFileName);
  try {
    await writeFile(tempPath, buffer);
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height:format=duration',
      '-of',
      'json',
      tempPath,
    ], { timeout: 15000, maxBuffer: 1024 * 64 });
    const parsed = JSON.parse(String(stdout || '{}')) as {
      streams?: Array<{ width?: number; height?: number }>;
      format?: { duration?: string | number };
    };
    const duration = Number.parseFloat(String(parsed.format?.duration ?? ''));
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('duration_unreadable');
    }
    const videoStream = parsed.streams?.[0];
    return {
      durationSeconds: duration,
      width: kind === 'video' ? normalizeProbeDimension(videoStream?.width) : null,
      height: kind === 'video' ? normalizeProbeDimension(videoStream?.height) : null,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function ensureSiteAssetPublicUrl(assetId: string): Promise<SiteAssetPublicUrlResult> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: {
      id: true,
      type: true,
      original_url: true,
      thumbnail_url: true,
      file_name: true,
      mime_type: true,
      file_size: true,
    },
  });
  if (!asset) {
    throw new Error(`素材不存在: ${assetId}`);
  }
  if (isPubliclyReachableUrl(asset.original_url)) {
    return { asset, isPubliclyReachable: true };
  }
  if (!isLocalPublicUploadUrl(asset.original_url)) {
    throw new Error(`素材不是公网地址，也不是可恢复的本地文件: ${asset.original_url}`);
  }

  const filePath = resolveLocalPublicPath(asset.original_url);
  const sameOriginPublicUrl = sameOriginPublicUrlForLocalUpload(asset.original_url);
  if (sameOriginPublicUrl) {
    try {
      await access(filePath);
    } catch {
      throw new Error(`历史素材本地文件不存在，无法补公网 URL: ${asset.file_name}`);
    }
    const updatedAsset = await prisma.asset.update({
      where: { id: asset.id },
      data: { original_url: sameOriginPublicUrl },
      select: {
        id: true,
        type: true,
        original_url: true,
        thumbnail_url: true,
        file_name: true,
        mime_type: true,
        file_size: true,
      },
    });

    return {
      asset: updatedAsset,
      isPubliclyReachable: true,
      storageProvider: 'local-public',
    };
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch {
    throw new Error(`历史素材本地文件不存在，无法补公网 URL: ${asset.file_name}`);
  }
  const pubResult = await uploadPublicAsset(buffer, asset.file_name, asset.mime_type);
  const updatedAsset = await prisma.asset.update({
    where: { id: asset.id },
    data: { original_url: pubResult.publicUrl },
    select: {
      id: true,
      type: true,
      original_url: true,
      thumbnail_url: true,
      file_name: true,
      mime_type: true,
      file_size: true,
    },
  });

  return {
    asset: updatedAsset,
    isPubliclyReachable: pubResult.isPubliclyReachable,
    storageProvider: pubResult.storageProvider,
    publicUploadWarning: pubResult.warning,
  };
}

export function validateSiteUploadMetadata(input: { mimeType: string; fileSize: number }) {
  if (!SITE_UPLOAD_ALLOWED_TYPES.includes(input.mimeType as (typeof SITE_UPLOAD_ALLOWED_TYPES)[number])) {
    return `不支持的文件类型：${input.mimeType || '未知'}。目前支持图片、MP4/MOV/WebM 视频、MP3/WAV/OGG 音频。`;
  }
  const kind = getSiteUploadKind(input.mimeType);
  if (!kind) return `不支持的文件类型：${input.mimeType || '未知'}`;

  const maxSize = SITE_UPLOAD_MAX_SIZE_BY_KIND[kind];
  if (input.fileSize > maxSize) {
    return `${uploadKindLabel(kind)}过大：${(input.fileSize / 1024 / 1024).toFixed(1)}MB，最大 ${formatMb(maxSize)}。`;
  }
  return null;
}

export function validateSiteUploadInput(file: File) {
  return validateSiteUploadMetadata({ mimeType: file.type, fileSize: file.size });
}

export function validateSiteUploadDuration(mimeType: string, durationSeconds: number | null | undefined) {
  const kind = getSiteUploadKind(mimeType);
  if (kind !== 'video' && kind !== 'audio') return null;
  void durationSeconds;
  return null;
}

export async function validateSiteUploadBuffer(buffer: Buffer, fileName: string, mimeType: string) {
  const kind = getSiteUploadKind(mimeType);
  if (kind !== 'video' && kind !== 'audio') return null;

  try {
    const metadata = await readSiteUploadMediaMetadata(buffer, fileName, mimeType);
    return validateSiteUploadDuration(mimeType, metadata.durationSeconds);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn('[SiteUpload] ffprobe unavailable while reading upload metadata:', { fileName, kind });
      return null;
    }
    console.warn('[SiteUpload] Failed to read upload media metadata, accepting asset for ingestion:', {
      fileName,
      kind,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  return null;
}

export async function uploadSiteAsset(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
  fileSize: number,
  ownerId: string,
  mediaMetadata?: SiteUploadMediaMetadata | null,
): Promise<SiteUploadResult> {
  const localResult = await uploadAsset(buffer, fileName, mimeType, ownerId, mediaMetadata);
  const localUrlIsPublic = isPubliclyReachableUrl(localResult.originalUrl);

  if (localUrlIsPublic) {
    return {
      ...localResult,
      fileName,
      fileSize,
      mimeType,
      isPubliclyReachable: true,
      storageProvider: isSameOriginPublicUploadUrl(localResult.originalUrl) ? 'local-public' : undefined,
    };
  }

  const sameOriginPublicUrl = sameOriginPublicUrlForLocalUpload(localResult.originalUrl);
  if (sameOriginPublicUrl) {
    await prisma.asset.update({
      where: { id: localResult.assetId },
      data: { original_url: sameOriginPublicUrl },
    });

    return {
      ...localResult,
      originalUrl: sameOriginPublicUrl,
      fileName,
      fileSize,
      mimeType,
      isPubliclyReachable: true,
      storageProvider: 'local-public',
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
      publicUploadWarning: `公网上传失败: ${pubError instanceof Error ? pubError.message : String(pubError)}，已回退到本地存储。Seedance 无法访问本地 URL，请配置 R2/TOS 或公网静态存储后重新上传。`,
    };
  }
}
