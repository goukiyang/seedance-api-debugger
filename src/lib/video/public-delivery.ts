import { readFile, stat } from 'fs/promises';
import type { VideoTask } from '@prisma/client';
import { uploadPublicAsset, uploadPublicVideoStream, type PublicUploadResult } from '@/lib/assets/public-storage';
import { prisma } from '@/lib/prisma';
import { refreshProviderTaskResultUrl } from '@/lib/provider/video-task-status';
import { cacheTaskVideoToLocal, type CacheableVideoTask, type LocalVideoCacheResult } from './local-cache';
import { localPublicVideoPath } from './thumbnail';
import { isVideoDeliveryFastPathTask } from './delivery-policy';

const VIDEO_MIME_TYPE = 'video/mp4';
const LOCAL_FALLBACK_PROVIDER = 'not_configured';
const PROVIDER_VIDEO_FETCH_TIMEOUT_MS = 120 * 1000;

type PublicVideoDeliveryTask = CacheableVideoTask & {
  generation_mode?: string | null;
  public_video_url?: string | null;
  public_video_storage_provider?: string | null;
  public_video_storage_key?: string | null;
  public_video_file_size?: number | null;
  public_video_cached_at?: Date | null;
};

type ProviderVideoDeliveryTask = PublicVideoDeliveryTask & {
  generation_mode?: string | null;
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

function parseContentLength(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

async function fetchProviderVideo(url: string, timeoutMs = PROVIDER_VIDEO_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'video/mp4,*/*',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshResultUrl(task: ProviderVideoDeliveryTask) {
  const refreshed = await refreshProviderTaskResultUrl({
    id: task.id,
    provider: task.provider,
    provider_task_id: task.provider_task_id,
    result_last_frame_url: task.result_last_frame_url,
  });
  if (!refreshed) return null;

  await prisma.videoTask.update({
    where: { id: task.id },
    data: {
      result_video_url: refreshed.result_video_url,
      result_last_frame_url: refreshed.result_last_frame_url,
      raw_status_response: refreshed.raw !== undefined ? JSON.stringify(refreshed.raw) : undefined,
    },
  });

  return refreshed.result_video_url;
}

async function fetchProviderVideoWithRefresh(
  task: ProviderVideoDeliveryTask,
): Promise<Response & { body: ReadableStream<Uint8Array> }> {
  let url = await refreshResultUrl(task) || task.result_video_url;
  if (!url) throw new Error('任务没有可交付的视频结果 URL');

  let response = await fetchProviderVideo(url);
  if (response.status === 401 || response.status === 403) {
    const refreshedUrl = await refreshResultUrl(task);
    if (refreshedUrl && refreshedUrl !== url) {
      url = refreshedUrl;
      response = await fetchProviderVideo(url);
    }
  }
  if (!response.ok) {
    throw new Error(`Provider 视频下载失败：HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error('Provider 视频响应没有可读取的 body');
  }
  return response as Response & { body: ReadableStream<Uint8Array> };
}

export async function ensurePublicVideoDeliveryFromProvider(
  task: ProviderVideoDeliveryTask | VideoTask,
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

  if (!isVideoDeliveryFastPathTask(task)) {
    return {
      success: false,
      skipped: true,
      message: '非普通 Seedance 视频任务，保持现有本地缓存/播放链路。',
    };
  }

  const response = await fetchProviderVideoWithRefresh(task);
  const uploadResult = await uploadPublicVideoStream({
    body: response.body,
    fileName: `seedance-video-${task.id}.mp4`,
    mimeType: response.headers.get('content-type')?.split(';')[0]?.trim() || VIDEO_MIME_TYPE,
    size: parseContentLength(response.headers.get('content-length')),
  });
  const cachedAt = new Date();
  const allowLocalPublic = options.allowLocalPublic === true || envAllowsLocalPublicDelivery();
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
    const message = uploadResult.warning || '视频已落到备用存储，但该地址不是稳定 CDN 下载地址。';
    return {
      success: false,
      fallback: true,
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
    warning: uploadResult.warning,
  };
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
