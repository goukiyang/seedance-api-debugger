import { stat } from 'fs/promises';
import { uploadPublicVideoFile, type PublicUploadResult } from '@/lib/assets/public-storage';
import { cacheTaskVideoToLocal, type CacheableVideoTask, type LocalVideoCacheResult, validateLocalMp4 } from './local-cache';
import { isVideoDeliveryFastPathTask } from './delivery-policy';
import {
  ensureTaskThumbnail,
  localPublicVideoPath,
  type EnsureTaskThumbnailResult,
} from './thumbnail';

const VIDEO_MIME_TYPE = 'video/mp4';
const LOCAL_FALLBACK_PROVIDER = 'not_configured';
import { assertVideoSaveOwnership, commitVideoSaveTask, withVideoSaveProcess, VIDEO_SAVE_TOTAL_TIMEOUT_MS, type VideoSaveOptions } from './save-lock';

export type MediaIngestTask = CacheableVideoTask & {
  generation_mode?: string | null;
  public_video_url?: string | null;
  public_video_storage_provider?: string | null;
  public_video_storage_key?: string | null;
  public_video_file_size?: number | null;
  public_video_cached_at?: Date | null;
};

export type MediaIngestResult = {
  success: boolean;
  public_video_url?: string | null;
  storage_provider?: string | null;
  storage_key?: string | null;
  file_size?: number | null;
  cached_at?: Date | null;
  local_video_path?: string | null;
  cacheResult?: LocalVideoCacheResult;
  thumbnailResult?: EnsureTaskThumbnailResult;
  already_exists?: boolean;
  skipped?: boolean;
  fallback?: boolean;
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

function canAttemptPublicUpload(options: { allowLocalPublic?: boolean } = {}) {
  return hasR2Config() || hasTosConfig() || options.allowLocalPublic === true || envAllowsLocalPublicDelivery();
}

function isAcceleratedVideoDeliveryProvider(
  provider: string | null | undefined,
  options: { allowLocalPublic?: boolean } = {},
) {
  if (provider === 'r2' || provider === 'tos') return true;
  return provider === 'local-public' && options.allowLocalPublic === true;
}

function uploadResultIsUsableForVideo(result: PublicUploadResult, allowLocalPublic: boolean) {
  return result.isPubliclyReachable && isAcceleratedVideoDeliveryProvider(result.storageProvider, { allowLocalPublic });
}

async function markLocalFallback(task: MediaIngestTask, fileSize: number | null, message: string): Promise<MediaIngestResult> {
  const cachedAt = new Date();
  await assertVideoSaveOwnership(task);
  await commitVideoSaveTask(task, {
      public_video_storage_provider: LOCAL_FALLBACK_PROVIDER,
      public_video_storage_key: null,
      public_video_file_size: fileSize,
      public_video_cached_at: cachedAt,
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

async function resolveLocalVideo(task: MediaIngestTask, cacheTimeoutMs?: number) {
  const cacheResult = await cacheTaskVideoToLocal(task, { timeoutMs: cacheTimeoutMs });
  if (!cacheResult.success || !cacheResult.local_video_path) {
    return { cacheResult, localPath: null, absolutePath: null, fileSize: null };
  }

  const absolutePath = localPublicVideoPath(cacheResult.local_video_path);
  if (!absolutePath) {
    return { cacheResult, localPath: cacheResult.local_video_path, absolutePath: null, fileSize: null };
  }

  const info = await stat(absolutePath);
  if (!info.isFile() || info.size <= 0) {
    return { cacheResult, localPath: cacheResult.local_video_path, absolutePath: null, fileSize: null };
  }

  return {
    cacheResult,
    localPath: cacheResult.local_video_path,
    absolutePath,
    fileSize: info.size,
  };
}

export async function ingestTaskMediaFromProvider(
  task: MediaIngestTask,
  options: VideoSaveOptions = {},
): Promise<MediaIngestResult> {
  if (task.public_video_url) return { success: true, public_video_url: task.public_video_url,
    storage_provider: task.public_video_storage_provider, storage_key: task.public_video_storage_key,
    file_size: task.public_video_file_size, cached_at: task.public_video_cached_at, local_video_path: task.local_video_path, already_exists: true };
  return withVideoSaveProcess('ingest', task, options, () => ingestTaskMediaFromProviderInner(task, options));
}

async function ingestTaskMediaFromProviderInner(task: MediaIngestTask, options: VideoSaveOptions): Promise<MediaIngestResult> {
  if (task.public_video_url) {
    return {
      success: true,
      public_video_url: task.public_video_url,
      storage_provider: task.public_video_storage_provider ?? null,
      storage_key: task.public_video_storage_key ?? null,
      file_size: task.public_video_file_size ?? null,
      cached_at: task.public_video_cached_at ?? null,
      local_video_path: task.local_video_path,
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

  const localVideo = await resolveLocalVideo(task, options.cacheTimeoutMs ?? VIDEO_SAVE_TOTAL_TIMEOUT_MS);
  if (!localVideo.cacheResult.success || !localVideo.localPath || !localVideo.absolutePath || !localVideo.fileSize) {
    return {
      success: false,
      cacheResult: localVideo.cacheResult,
      error: localVideo.cacheResult.error || 'local_cache_failed',
      message: localVideo.cacheResult.message || '视频本地缓存失败，无法进入统一媒体入库。',
    };
  }

  try {
    await validateLocalMp4(localVideo.absolutePath);
  } catch (error) {
    // Preserve the existing original; a probe failure never deletes a previously published file.
    return {
      success: false,
      cacheResult: localVideo.cacheResult,
      local_video_path: null,
      file_size: localVideo.fileSize,
      error: 'local_mp4_probe_failed',
      message: error instanceof Error ? error.message : 'MP4 文件不可读，已停止写入稳定下载地址。',
    };
  }

  task = { ...task, result_video_url: localVideo.cacheResult.result_video_url || task.result_video_url };
  await assertVideoSaveOwnership(task);
  const thumbnailResult = await ensureTaskThumbnail({
    id: task.id,
    public_video_url: task.public_video_url,
    local_video_path: localVideo.localPath,
    result_video_url: localVideo.cacheResult.result_video_url || task.result_video_url,
    result_last_frame_url: localVideo.cacheResult.result_last_frame_url || task.result_last_frame_url,
  }, { allowRemoteFallback: false });

  const allowLocalPublic = options.allowLocalPublic === true || envAllowsLocalPublicDelivery();
  if (!canAttemptPublicUpload({ allowLocalPublic })) {
    await assertVideoSaveOwnership(task);
    const fallbackResult = await markLocalFallback(
      task,
      localVideo.fileSize,
      '未配置 R2/TOS 视频分发，当前使用本站慢速备用播放。',
    );
    return {
      ...fallbackResult,
      cacheResult: localVideo.cacheResult,
      thumbnailResult,
      local_video_path: localVideo.localPath,
    };
  }

  const uploadResult = await uploadPublicVideoFile({
    filePath: localVideo.absolutePath,
    fileName: `seedance-video-${task.id}.mp4`,
    mimeType: VIDEO_MIME_TYPE,
    size: localVideo.fileSize,
  });
  const cachedAt = new Date();
  const usableForVideo = uploadResultIsUsableForVideo(uploadResult, allowLocalPublic);

  await assertVideoSaveOwnership(task);
  await commitVideoSaveTask(task, {
      public_video_url: usableForVideo ? uploadResult.publicUrl : null,
      public_video_storage_provider: uploadResult.storageProvider,
      public_video_storage_key: uploadResult.storageKey || null,
      public_video_file_size: uploadResult.size || localVideo.fileSize,
      public_video_cached_at: cachedAt,
      local_video_path: localVideo.localPath,
  });


  if (!usableForVideo) {
    const message = uploadResult.warning || '视频已落到备用存储，但该地址不是稳定 CDN 下载地址。';
    return {
      success: false,
      fallback: true,
      cacheResult: localVideo.cacheResult,
      thumbnailResult,
      local_video_path: localVideo.localPath,
      storage_provider: uploadResult.storageProvider,
      storage_key: uploadResult.storageKey || null,
      file_size: uploadResult.size || localVideo.fileSize,
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
    file_size: uploadResult.size || localVideo.fileSize,
    cached_at: cachedAt,
    local_video_path: localVideo.localPath,
    cacheResult: localVideo.cacheResult,
    thumbnailResult,
    warning: uploadResult.warning,
  };
}
