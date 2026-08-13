type TaskThumbnailSource = {
  publicVideoUrl?: string | null;
  localVideoPath?: string | null;
  resultLastFrameUrl?: string | null;
};

export function canRequestTaskThumbnail(source: TaskThumbnailSource) {
  return Boolean(source.localVideoPath || source.publicVideoUrl || source.resultLastFrameUrl);
}

export function shouldExposeTaskThumbnailUrl(
  source: TaskThumbnailSource & { hasExistingThumbnail?: boolean },
) {
  return Boolean(source.hasExistingThumbnail || canRequestTaskThumbnail(source));
}
