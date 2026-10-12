'use client';

import { useEffect, useState } from 'react';
import styles from './GeneratedImageResults.module.css';

export type ImageGenerationWait = { acceptedAt?: number; normal: boolean; status: string; connectionIssue?: boolean; detail?: string };

export function ImageGenerationWaiting({ wait, visible, loadingImage = false }: { wait: ImageGenerationWait; visible: boolean; loadingImage?: boolean }) {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener('online', sync); window.addEventListener('offline', sync);
    return () => { window.removeEventListener('online', sync); window.removeEventListener('offline', sync); };
  }, []);
  const connected = online && !wait.connectionIssue;
  const waiting = connected && (wait.normal || loadingImage);
  const status = loadingImage ? '正在加载图片' : !connected ? '状态暂未更新' : wait.normal ? '正在生成' : wait.status;
  return <div className={styles.waitExperience} data-sweeping={visible && connected && (wait.normal || loadingImage) || undefined} aria-busy="true">
    <span className={styles.waitSweep} aria-hidden="true" />
    <div className={styles.waitCopy}>
      <strong role="status">{status}</strong>
      {/* This is an indeterminate waiting indicator, not a completion percentage. */}
      {waiting && <span className={styles.waitTrack} aria-hidden="true"><span /></span>}
    </div>
  </div>;
}
