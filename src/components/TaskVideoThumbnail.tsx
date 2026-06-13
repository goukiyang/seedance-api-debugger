'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';

export type TaskVideoThumbnailSize = 'compact' | 'list' | 'card';
export type TaskVideoThumbnailTone = 'light' | 'dark';

type Props = {
  taskId: string;
  localVideoPath?: string | null;
  resultVideoUrl?: string | null;
  resultLastFrameUrl?: string | null;
  status?: string | null;
  href?: string;
  label?: string;
  className?: string;
  size?: TaskVideoThumbnailSize;
  tone?: TaskVideoThumbnailTone;
  children?: ReactNode;
};

function hasThumbnailSource(props: Pick<Props, 'localVideoPath' | 'resultVideoUrl' | 'resultLastFrameUrl'>) {
  return Boolean(props.localVideoPath || props.resultVideoUrl || props.resultLastFrameUrl);
}

function emptyLabel(status?: string | null) {
  if (status === 'submitted' || status === 'running' || status === 'draft') return '等待截图';
  if (status === 'failed') return '失败无截图';
  if (status === 'cancelled') return '已取消';
  return '暂无截图';
}

export default function TaskVideoThumbnail({
  taskId,
  localVideoPath,
  resultVideoUrl,
  resultLastFrameUrl,
  status,
  href,
  label,
  className,
  size = 'compact',
  tone = 'light',
  children,
}: Props) {
  const [failed, setFailed] = useState(false);
  const canShowImage = hasThumbnailSource({ localVideoPath, resultVideoUrl, resultLastFrameUrl }) && !failed;
  const thumbnailSrc = `/api/video/thumbnail/${encodeURIComponent(taskId)}`;
  const rootClassName = [
    'task-video-thumbnail',
    `task-video-thumbnail-${size}`,
    `task-video-thumbnail-${tone}`,
    canShowImage ? 'has-image' : 'is-empty',
    className,
  ].filter(Boolean).join(' ');

  const content = (
    <>
      <span className="task-video-thumbnail-frame">
        {canShowImage ? (
          <img
            src={thumbnailSrc}
            alt="视频截图"
            loading="lazy"
            onError={() => setFailed(true)}
          />
        ) : (
          <span className="task-video-thumbnail-empty">{emptyLabel(status)}</span>
        )}
      </span>
      {label && <span className="task-video-thumbnail-label">{label}</span>}
    </>
  );

  return (
    <div className={rootClassName}>
      {href ? (
        <Link className="task-video-thumbnail-hitbox" href={href} aria-label={`查看任务 ${taskId} 的视频截图和详情`}>
          {content}
        </Link>
      ) : (
        <span className="task-video-thumbnail-hitbox" aria-label={`任务 ${taskId} 的视频截图`}>
          {content}
        </span>
      )}
      {children && <span className="task-video-thumbnail-overlay">{children}</span>}
    </div>
  );
}
