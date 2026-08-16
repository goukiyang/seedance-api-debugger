'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  buildTaskThumbnailResetKey,
  buildTaskThumbnailView,
} from '@/lib/video/task-thumbnail-view';

type ThumbnailSize = 'compact' | 'medium' | 'card';
type DeliveryStage = { key?: string | null; label?: string | null } | string | null;

type Props = {
  taskId: string;
  thumbnailUrl?: string | null;
  publicVideoUrl?: string | null;
  localVideoPath?: string | null;
  resultVideoUrl?: string | null;
  resultLastFrameUrl?: string | null;
  status?: string | null;
  deliveryStage?: DeliveryStage;
  previewAvailable?: boolean | null;
  stableDownloadReady?: boolean | null;
  retryAfterMs?: number | null;
  provider?: string | null;
  generationMode?: string | null;
  isEnhanceTask?: boolean;
  href?: string | null;
  size?: ThumbnailSize;
  className?: string;
  overlay?: ReactNode;
};

export function TaskVideoThumbnail({
  taskId,
  thumbnailUrl,
  publicVideoUrl,
  localVideoPath,
  resultVideoUrl,
  resultLastFrameUrl,
  status,
  deliveryStage,
  previewAvailable,
  stableDownloadReady,
  retryAfterMs,
  provider,
  generationMode,
  isEnhanceTask,
  href,
  size = 'compact',
  className = '',
  overlay,
}: Props) {
  const [failed, setFailed] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const resetKey = useMemo(() => buildTaskThumbnailResetKey({
    taskId,
    thumbnailUrl,
    publicVideoUrl,
    localVideoPath,
    resultVideoUrl,
    resultLastFrameUrl,
    status,
    deliveryStage,
    previewAvailable,
    stableDownloadReady,
  }), [
    taskId,
    thumbnailUrl,
    publicVideoUrl,
    localVideoPath,
    resultVideoUrl,
    resultLastFrameUrl,
    status,
    deliveryStage,
    previewAvailable,
    stableDownloadReady,
  ]);
  const view = buildTaskThumbnailView({
    taskId,
    thumbnailUrl,
    publicVideoUrl,
    localVideoPath,
    resultVideoUrl,
    resultLastFrameUrl,
    status,
    deliveryStage,
    previewAvailable,
    stableDownloadReady,
    retryAfterMs,
    failed,
    retryAttempt,
  });

  useEffect(() => {
    setFailed(false);
    setRetryAttempt(0);
  }, [resetKey]);

  useEffect(() => {
    if (!view.shouldScheduleRetry) return undefined;
    const timer = window.setTimeout(() => {
      setRetryAttempt((current) => current + 1);
      setFailed(false);
    }, view.retryDelayMs);
    return () => window.clearTimeout(timer);
  }, [view.shouldScheduleRetry, view.retryDelayMs, resetKey]);

  const content = view.shouldRenderImage && view.imageSrc ? (
    <img
      src={view.imageSrc}
      alt="视频截图"
      loading="lazy"
      onError={() => setFailed(true)}
      onLoad={() => setFailed(false)}
    />
  ) : (
    <span className="task-video-thumbnail-placeholder">{view.placeholderText}</span>
  );
  const shouldShowEnhanceBadge = isEnhanceTask
    ?? (generationMode === 'enhance_video' || provider === 'volcengine_mediakit');
  const classNames = [
    'task-video-thumbnail',
    `task-video-thumbnail-${size}`,
    failed || view.isFinalFallback ? 'is-fallback' : '',
    shouldShowEnhanceBadge ? 'is-enhance-task' : '',
    className,
  ].filter(Boolean).join(' ');

  const inner = (
    <>
      {content}
      {shouldShowEnhanceBadge ? (
        <span className="task-video-thumbnail-enhance-badge" title="视频超分任务" aria-label="视频超分任务">
          超分
        </span>
      ) : null}
      {overlay ? <span className="task-video-thumbnail-overlay">{overlay}</span> : null}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={classNames}>
        {inner}
      </Link>
    );
  }

  return <span className={classNames}>{inner}</span>;
}
