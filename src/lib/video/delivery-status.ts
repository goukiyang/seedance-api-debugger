export type VideoDeliveryStageTask = {
  local_status: string | null;
  public_video_url?: string | null;
  local_video_path?: string | null;
  result_video_url?: string | null;
  result_last_frame_url?: string | null;
  delivery_status?: string | null;
};

export type VideoDeliveryStage = {
  key: 'generating' | 'preparing' | 'ready' | 'failed' | 'unavailable';
  label: string;
  stableDownloadReady: boolean;
  previewAvailable: boolean;
};

function hasPreview(task: VideoDeliveryStageTask) {
  return Boolean(
    task.public_video_url
    || task.local_video_path
    || task.result_video_url
    || task.result_last_frame_url
  );
}

export function videoDeliveryStageForTask(task: VideoDeliveryStageTask): VideoDeliveryStage {
  if (task.local_status !== 'succeeded') {
    return {
      key: 'generating',
      label: '生成中',
      stableDownloadReady: false,
      previewAvailable: hasPreview(task),
    };
  }

  if (task.public_video_url || task.delivery_status === 'succeeded') {
    return {
      key: 'ready',
      label: '稳定下载已就绪',
      stableDownloadReady: Boolean(task.public_video_url),
      previewAvailable: true,
    };
  }

  if (task.delivery_status === 'failed') {
    return {
      key: 'failed',
      label: '稳定下载准备失败，可重试',
      stableDownloadReady: false,
      previewAvailable: hasPreview(task),
    };
  }

  if (hasPreview(task)) {
    return {
      key: 'preparing',
      label: '已生成，正在准备稳定下载',
      stableDownloadReady: false,
      previewAvailable: true,
    };
  }

  return {
    key: 'unavailable',
    label: '视频暂未就绪',
    stableDownloadReady: false,
    previewAvailable: false,
  };
}
