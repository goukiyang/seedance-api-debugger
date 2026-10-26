import { isPublicHttpUrl } from '@/lib/media/public-url';

type TaskThumbnailSource = {
  publicVideoUrl?: string | null;
  localVideoPath?: string | null;
  resultVideoUrl?: string | null;
  resultLastFrameUrl?: string | null;
};

export function canRequestTaskThumbnail(source: TaskThumbnailSource) {
  return Boolean(
    source.localVideoPath
    || isPublicHttpUrl(source.publicVideoUrl)
    || isPublicHttpUrl(source.resultVideoUrl)
    || isPublicHttpUrl(source.resultLastFrameUrl)
  );
}

export function shouldExposeTaskThumbnailUrl(
  source: TaskThumbnailSource & { hasExistingThumbnail?: boolean },
) {
  return Boolean(source.hasExistingThumbnail || canRequestTaskThumbnail(source));
}
