'use client';

import { useEffect, useState, type CSSProperties } from 'react';
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
  // User-requested visual pacing, not provider completion: the original accepted
  // timestamp survives reads/remounts; no local start time or task mutation.
  const timed = !loadingImage && wait.normal && Number.isFinite(wait.acceptedAt) && Number(wait.acceptedAt) > 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!timed || !visible || !connected) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const update = () => {
      if (document.hidden) return;
      const current = Date.now();
      setNow(current);
      if (current - wait.acceptedAt! >= 300_000 && timer) clearInterval(timer);
    };
    update();
    if (Date.now() - wait.acceptedAt! < 300_000) timer = setInterval(update, 1000);
    document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, [timed, visible, connected, wait.acceptedAt]);
  const visualRatio = timed ? Math.min(.95, Math.max(0, (now - wait.acceptedAt!) / 300_000 * .95)) : 0;
  const status = loadingImage ? '正在加载图片' : !connected ? '状态暂未更新' : wait.normal ? '正在生成' : wait.status;
  return <div className={styles.waitExperience} data-sweeping={visible && connected && (wait.normal || loadingImage) || undefined} aria-busy="true">
    <span className={styles.waitSweep} aria-hidden="true" />
    <div className={styles.waitCopy}>
      <strong role="status">{status}</strong>
      {/* Decorative only: never expose the timed ratio as true progress or text. */}
      {waiting && <span className={styles.waitTrack} data-timed={timed || undefined}
        style={timed ? { '--image-wait-ratio': visualRatio } as CSSProperties : undefined} aria-hidden="true"><span /></span>}
    </div>
  </div>;
}
