'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';

type ThumbnailSize = 'compact' | 'medium' | 'card';

type Props = {
  taskId: string;
  localVideoPath?: string | null;
  resultVideoUrl?: string | null;
  resultLastFrameUrl?: string | null;
  status?: string | null;
  href?: string | null;
  size?: ThumbnailSize;
  className?: string;
  overlay?: ReactNode;
};

function statusText(status?: string | null) {
  if (status === 'submitted') return '排队中';
  if (status === 'running') return '生成中';
  if (status === 'failed') return '失败';
  if (status === 'cancelled') return '已取消';
  if (status === 'succeeded') return '暂无截图';
  return '暂无截图';
}

export function TaskVideoThumbnail({
  taskId,
  localVideoPath,
  resultVideoUrl,
  resultLastFrameUrl,
  status,
  href,
  size = 'compact',
  className = '',
  overlay,
}: Props) {
  const [failed, setFailed] = useState(false);
  const hasSource = Boolean(localVideoPath || resultVideoUrl || resultLastFrameUrl);
  const thumbnailSrc = useMemo(() => `/api/video/thumbnail/${taskId}`, [taskId]);
  const content = hasSource && !failed ? (
    <img
      src={thumbnailSrc}
      alt="视频截图"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  ) : (
    <span className="task-video-thumbnail-placeholder">{statusText(status)}</span>
  );
  const classNames = [
    'task-video-thumbnail',
    `task-video-thumbnail-${size}`,
    failed ? 'is-fallback' : '',
    className,
  ].filter(Boolean).join(' ');

  const inner = (
    <>
      {content}
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
