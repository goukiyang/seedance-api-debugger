'use client';

import type { ImageGenerationWaitDisplay } from '@/lib/image-studio/wait-display';
import type { CSSProperties } from 'react';
import styles from './GeneratedImageResults.module.css';

export type { ImageGenerationWait } from '@/lib/image-studio/wait-display';

export function ImageGenerationWaiting({ display, visible, loadingImage = false }: { display: ImageGenerationWaitDisplay; visible: boolean; loadingImage?: boolean }) {
  const waiting = loadingImage || display.showTrack;
  const status = loadingImage ? '正在加载图片' : display.label;
  const progress = loadingImage ? undefined : display.progress;
  return <div className={styles.waitExperience} data-sweeping={visible && waiting || undefined} aria-busy={loadingImage || display.busy}>
    <span className={styles.waitSweep} aria-hidden="true" />
    <div className={styles.waitCopy}>
      <strong role="status">{status}</strong>
      {waiting && <span className={styles.waitTrack} data-progress={progress !== undefined || undefined} data-finishing={display.finishing || undefined}
        style={progress !== undefined ? { '--image-wait-ratio': progress / 100 } as CSSProperties : undefined}
        role={progress !== undefined ? 'progressbar' : undefined} aria-label={progress !== undefined ? '生成进度' : undefined}
        aria-valuemin={progress !== undefined ? 0 : undefined} aria-valuemax={progress !== undefined ? 100 : undefined}
        aria-valuenow={progress !== undefined ? Math.floor(progress * 10) / 10 : undefined} aria-hidden={progress === undefined || undefined}><span /></span>}
      {waiting && progress !== undefined && <span className={styles.waitPercent} aria-hidden="true">{Math.floor(progress * 10) / 10}%</span>}
    </div>
  </div>;
}
