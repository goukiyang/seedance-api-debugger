import { canRequestTaskThumbnail } from '@/lib/video/thumbnail-availability';

type DeliveryStageLike = {
  key?: string | null;
  label?: string | null;
} | string | null | undefined;

export type TaskThumbnailViewInput = {
  taskId: string;
  thumbnailUrl?: string | null;
  publicVideoUrl?: string | null;
  localVideoPath?: string | null;
  resultVideoUrl?: string | null;
  resultLastFrameUrl?: string | null;
  status?: string | null;
  deliveryStage?: DeliveryStageLike;
  previewAvailable?: boolean | null;
  stableDownloadReady?: boolean | null;
  retryAfterMs?: number | null;
  failed?: boolean;
  retryAttempt?: number;
  maxRetryAttempts?: number;
};

export type TaskThumbnailView = {
  imageSrc: string | null;
  placeholderText: string;
  shouldRenderImage: boolean;
  shouldScheduleRetry: boolean;
  retryDelayMs: number;
  isFinalFallback: boolean;
};

const DEFAULT_MAX_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [2000, 4000, 8000] as const;

export function deliveryStageKey(stage: DeliveryStageLike) {
  if (!stage) return null;
  if (typeof stage === 'string') return stage || null;
  return stage.key || null;
}

export function appendTaskThumbnailRetryParam(src: string, retryAttempt: number) {
  if (retryAttempt <= 0) return src;
  const hashIndex = src.indexOf('#');
  const withoutHash = hashIndex >= 0 ? src.slice(0, hashIndex) : src;
  const hash = hashIndex >= 0 ? src.slice(hashIndex) : '';
  const separator = withoutHash.includes('?') ? '&' : '?';
  return `${withoutHash}${separator}thumb_retry=${retryAttempt}${hash}`;
}

export function buildTaskThumbnailResetKey(input: Pick<
  TaskThumbnailViewInput,
  | 'taskId'
  | 'thumbnailUrl'
  | 'publicVideoUrl'
  | 'localVideoPath'
  | 'resultVideoUrl'
  | 'resultLastFrameUrl'
  | 'status'
  | 'deliveryStage'
  | 'previewAvailable'
  | 'stableDownloadReady'
>) {
  return [
    input.taskId,
    input.thumbnailUrl || '',
    input.publicVideoUrl || '',
    input.localVideoPath || '',
    input.resultVideoUrl || '',
    input.resultLastFrameUrl || '',
    input.status || '',
    deliveryStageKey(input.deliveryStage) || '',
    input.previewAvailable === undefined ? '' : String(input.previewAvailable),
    input.stableDownloadReady === undefined ? '' : String(input.stableDownloadReady),
  ].join('|');
}

function thumbnailBaseSrc(input: TaskThumbnailViewInput) {
  if (input.thumbnailUrl) return input.thumbnailUrl;
  if (!input.taskId) return null;
  const hasSource = canRequestTaskThumbnail({
    publicVideoUrl: input.publicVideoUrl,
    localVideoPath: input.localVideoPath,
    resultVideoUrl: input.resultVideoUrl,
    resultLastFrameUrl: input.resultLastFrameUrl,
  });
  return hasSource ? `/api/video/thumbnail/${input.taskId}` : null;
}

function placeholderText(input: TaskThumbnailViewInput) {
  if (input.status === 'submitted' || input.status === 'draft') return '排队中';
  if (input.status === 'running') return '生成中';
  if (input.status === 'failed') return '失败';
  if (input.status === 'cancelled') return '已取消';

  const stageKey = deliveryStageKey(input.deliveryStage);
  if (stageKey === 'preparing') return '正在准备预览';
  if (stageKey === 'unavailable') return '视频未产出';
  if (stageKey === 'failed' && !input.previewAvailable) return '视频未产出';
  if (input.status === 'succeeded' && input.stableDownloadReady === false && input.retryAfterMs) {
    return '正在准备预览';
  }
  if (input.status === 'succeeded') return '暂无截图';
  return '暂无截图';
}

function retryDelay(input: TaskThumbnailViewInput) {
  if (input.retryAfterMs && input.retryAfterMs > 0) return input.retryAfterMs;
  const attempt = Math.max(0, input.retryAttempt || 0);
  return DEFAULT_RETRY_DELAYS_MS[Math.min(attempt, DEFAULT_RETRY_DELAYS_MS.length - 1)];
}

export function buildTaskThumbnailView(input: TaskThumbnailViewInput): TaskThumbnailView {
  const baseSrc = thumbnailBaseSrc(input);
  const retryAttempt = Math.max(0, input.retryAttempt || 0);
  const maxRetryAttempts = input.maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;
  const terminalTask = input.status === 'failed' || input.status === 'cancelled';
  const canRetry = Boolean(baseSrc) && !terminalTask && retryAttempt < maxRetryAttempts;
  const shouldRenderImage = Boolean(baseSrc) && !input.failed && !terminalTask;

  return {
    imageSrc: shouldRenderImage && baseSrc ? appendTaskThumbnailRetryParam(baseSrc, retryAttempt) : null,
    placeholderText: placeholderText(input),
    shouldRenderImage,
    shouldScheduleRetry: Boolean(input.failed && canRetry),
    retryDelayMs: retryDelay(input),
    isFinalFallback: Boolean(input.failed && !canRetry),
  };
}
