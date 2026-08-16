import { videoDeliveryStageForTask } from '@/lib/video/delivery-status';
import { shouldExposeTaskThumbnailUrl } from '@/lib/video/thumbnail-availability';

export type TaskThumbnailProjectionSource = {
  id: string;
  local_status: string | null;
  public_video_url?: string | null;
  local_video_path?: string | null;
  result_video_url?: string | null;
  result_last_frame_url?: string | null;
  delivery_status?: string | null;
};

export function retryAfterMsForTaskThumbnailStage(
  stageKey: ReturnType<typeof videoDeliveryStageForTask>['key'],
) {
  if (stageKey === 'generating') return 5_000;
  if (stageKey === 'preparing') return 3_000;
  if (stageKey === 'unavailable') return 10_000;
  return null;
}

export function taskThumbnailProjection(task: TaskThumbnailProjectionSource) {
  const deliveryStage = videoDeliveryStageForTask(task);
  const thumbnailUrl = shouldExposeTaskThumbnailUrl({
    publicVideoUrl: task.public_video_url,
    localVideoPath: task.local_video_path,
    resultVideoUrl: task.result_video_url,
    resultLastFrameUrl: task.result_last_frame_url,
  }) ? `/api/video/thumbnail/${task.id}` : null;

  return {
    delivery_stage: deliveryStage,
    stable_download_ready: deliveryStage.stableDownloadReady,
    preview_available: deliveryStage.previewAvailable,
    play_url: deliveryStage.previewAvailable ? `/api/video/play/${task.id}` : null,
    download_url: deliveryStage.stableDownloadReady ? `/api/video/download/${task.id}` : null,
    thumbnail_url: thumbnailUrl,
    retry_after_ms: retryAfterMsForTaskThumbnailStage(deliveryStage.key),
  };
}
