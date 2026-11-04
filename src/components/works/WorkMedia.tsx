'use client';

import { useEffect, useState } from 'react';
import { ImageIcon, Play } from 'lucide-react';
import { InlineVideoCover } from '@/components/InlineVideoCover';
import { AssetPlaybackCoordinator } from '@/lib/media/asset-playback';
import type { WorkCard } from '@/lib/works/types';
import styles from './Works.module.css';

export function WorkMedia({ work, playback, contextKey, detailOpen }: { work: WorkCard; playback: AssetPlaybackCoordinator; contextKey: string; detailOpen: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [work.thumbnailUrl, work.mediaVersion]);
  const poster = work.thumbnailUrl && !failed ? <img src={work.thumbnailUrl} width={work.width || undefined} height={work.height || undefined} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} /> : <span className={styles.placeholder}><ImageIcon size={28} /><span>{work.medium === 'video' ? '暂无封面' : work.previewStatus === 'preparing' ? '封面准备中' : '暂时无法预览'}</span></span>;
  return <span className={styles.media} style={{ aspectRatio: work.width && work.height ? `${work.width}/${work.height}` : '1/1' }}>
    {work.medium === 'video' ? <InlineVideoCover interaction="hover" src={work.previewStatus === 'ready' ? work.previewUrl : null} title={work.title} assetKey={`${work.id}:${work.mediaVersion}`} contextKey={contextKey} disabled={detailOpen}
      onHoverStart={(key, src, media, release) => playback.claimHover(key, src, media, release)}
      isHoverCurrent={(lease, key, src, media) => playback.isHoverCurrent(lease, key, src, media)}
      onHoverStop={(lease, key, src, media, reason) => { playback.releaseHover(lease, key, src, media, reason); }}>{poster}</InlineVideoCover> : poster}
    {work.medium === 'video' && <span className={styles.duration}><Play size={12} />{work.duration != null && Number.isFinite(work.duration) && work.duration > 0 ? `${Math.floor(work.duration / 60)}:${Math.floor(work.duration % 60).toString().padStart(2, '0')}` : '视频'}</span>}
  </span>;
}
