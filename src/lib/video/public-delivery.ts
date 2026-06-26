import { readFile, stat } from 'fs/promises';
import type { VideoTask } from '@prisma/client';
import { uploadPublicAsset, type PublicUploadResult } from '@/lib/assets/public-storage';
import { prisma } from '@/lib/prisma';
import { cacheTaskVideoToLocal, type CacheableVideoTask, type LocalVideoCacheResult } from './local-cache';
import { localPublicVideoPath } from './thumbnail';

const VIDEO_MIME_TYPE = 'video/mp4';
const LOCAL_FALLBACK_PROVIDER = 'not_configured';

type PublicVideoDeliveryTask = CacheableVideoTask & {
  public_video_url?: string | null;
  public_video_storage_provider?: string | null;
  public_video_storage_key?: string | null;
  public_video_file_size?: number | null;
  public_video_cached_at?: Date | null;
};

export type PublicVideoDeliveryResult = {
  success: boolean;
  public_video_url?: string | null;
  storage_provider?: string | null;
  storage_key?: string | null;
  file_size?: number | null;
  cached_at?: Date | null;
  already_exists?: boolean;
  skipped?: boolean;
  fallback?: boolean;
  cacheResult?: LocalVideoCacheResult;
  warning?: string;
  error?: string;
  message?: string;
};

function hasR2Config() {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET,
  );
}

function hasTosConfig() {
  return Boolean(
    process.env.TOS_REGION &&
    process.env.TOS_BUCKET &&
    process.env.TOS_ACCESS_KEY &&
    process.env.TOS_SECRET_KEY,
  );
}

function envAllowsLocalPublicDelivery() {
  return process.env.VIDEO_PUBLIC_DELIVERY_ALLOW_LOCAL_PUBLIC === 'true';
}

export function isAcceleratedVideoDeliveryProvider(
  provider: string | null | undefined,
  options: { allowLocalPublic?: boolean } = {},
) {
  if (provider === 'r2' || provider === 'tos') return true;
  return provider === 'local-public' && options.allowLocalPublic === true;
}

function canAttemptPublicUpload(options: { allowLocalPublic?: boolean } = {}) {
  return hasR2Config() || hasTosConfig() || options.allowLocalPublic === true || envAllowsLocalPublicDelivery();
}

async function existingLocalVideo(task: Pick<PublicVideoDeliveryTask, 'local_video_path'>) {
  const absolutePath = localPublicVideoPath(task.local_video_path);
  if (!absolutePath) return null;
  try {
    const info = await stat(absolutePath);
    if (info.isFile() && info.size > 0) return { absolutePath, size: info.size };
  } catch {
    return null;
  }
  return null;
}

async function markLocalFallback(taskId: string, fileSize: number | null, message: string): Promise<PublicVideoDeliveryResult> {
  const cachedAt = new Date();
  await prisma.videoTask.update({
    where: { id: taskId },
    data: {
      public_video_storage_provider: LOCAL_FALLBACK_PROVIDER,
      public_video_storage_key: null,
      public_video_file_size: fileSize,
      public_video_cached_at: cachedAt,
    },
  });
  return {
    success: false,
    skipped: true,
    fallback: true,
    storage_provider: LOCAL_FALLBACK_PROVIDER,
    file_size: fileSize,
    cached_at: cachedAt,
    warning: message,
    message,
  };
}

function uploadResultIsUsableForVideo(result: PublicUploadResult, allowLocalPublic: boolean) {
  return result.isPubliclyReachable && isAcceleratedVideoDeliveryProvider(result.storageProvider, { allowLocalPublic });
}

export async function ensurePublicVideoDelivery(
  task: PublicVideoDeliveryTask | VideoTask,
  options: { allowLocalPublic?: boolean } = {},
): Promise<PublicVideoDeliveryResult> {
  if (task.public_video_url) {
    return {
      success: true,
      public_video_url: task.public_video_url,
      storage_provider: task.public_video_storage_provider ?? null,
      storage_key: task.public_video_storage_key ?? null,
      file_size: task.public_video_file_size ?? null,
      cached_at: task.public_video_cached_at ?? null,
      already_exists: true,
    };
  }

  let localVideo = await existingLocalVideo(task);
  let cacheResult: LocalVideoCacheResult | undefined;
  if (!localVideo) {
    cacheResult = await cacheTaskVideoToLocal(task);
    if (!cacheResult.success || !cacheResult.local_video_path) {
      return {
        success: false,
        cacheResult,
        error: cacheResult.error || 'local_cache_failed',
        message: cacheResult.message || '视频本地缓存失败，无法转存到对象存储',
      };
    }
    localVideo = await existingLocalVideo({ local_video_path: cacheResult.local_video_path });
  }

  if (!localVideo) {
    return {
      success: false,
      cacheResult,
      error: 'local_video_not_found',
      message: '本地视频文件不可读，无法转存到对象存储',
    };
  }

  const allowLocalPublic = options.allowLocalPublic === true || envAllowsLocalPublicDelivery();
  if (!canAttemptPublicUpload({ allowLocalPublic })) {
    return markLocalFallback(task.id, localVideo.size, '未配置 R2/TOS 视频分发，当前使用本站慢速备用播放。');
  }

  const buffer = await readFile(localVideo.absolutePath);
  const uploadResult = await uploadPublicAsset(buffer, `seedance-video-${task.id}.mp4`, VIDEO_MIME_TYPE);
  const cachedAt = new Date();
  const usableForVideo = uploadResultIsUsableForVideo(uploadResult, allowLocalPublic);

  await prisma.videoTask.update({
    where: { id: task.id },
    data: {
      public_video_url: usableForVideo ? uploadResult.publicUrl : null,
      public_video_storage_provider: uploadResult.storageProvider,
      public_video_storage_key: uploadResult.storageKey || null,
      public_video_file_size: uploadResult.size,
      public_video_cached_at: cachedAt,
    },
  });

  if (!usableForVideo) {
    const message = uploadResult.warning || '视频已落到本地公开目录，但该地址仍不是对象存储/CDN，继续使用慢速备用播放。';
    return {
      success: false,
      fallback: true,
      cacheResult,
      storage_provider: uploadResult.storageProvider,
      storage_key: uploadResult.storageKey || null,
      file_size: uploadResult.size,
      cached_at: cachedAt,
      warning: message,
      message,
    };
  }

  return {
    success: true,
    public_video_url: uploadResult.publicUrl,
    storage_provider: uploadResult.storageProvider,
    storage_key: uploadResult.storageKey || null,
    file_size: uploadResult.size,
    cached_at: cachedAt,
    cacheResult,
    warning: uploadResult.warning,
  };
}
