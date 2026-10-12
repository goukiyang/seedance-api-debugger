'use client';

import { useEffect, useState } from 'react';
import styles from './GeneratedImageResults.module.css';

export type ImageGenerationWait = { acceptedAt?: number; normal: boolean; status: string; connectionIssue?: boolean; detail?: string };
const curve = [[0, 0], [15, 10], [60, 32], [120, 55], [180, 73], [240, 87], [300, 95]];

// 明确标识的时间动画，不代表供应商完成比例，也不承诺完成时间。
function simulatedProgress(acceptedAt: number, now: number) {
  const seconds = Math.max(0, (now - acceptedAt) / 1000);
  for (let index = 1; index < curve.length; index++) {
    const [end, value] = curve[index], [start, previous] = curve[index - 1];
    if (seconds <= end) return previous + (value - previous) * (seconds - start) / (end - start);
  }
  return 95;
}

export function ImageGenerationWaiting({ wait, visible, loadingImage = false }: { wait: ImageGenerationWait; visible: boolean; loadingImage?: boolean }) {
  const [now, setNow] = useState<number | null>(null);
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const sync = () => { setOnline(navigator.onLine); if (!document.hidden) setNow(Date.now()); };
    sync();
    window.addEventListener('online', sync); window.addEventListener('offline', sync);
    document.addEventListener('visibilitychange', sync);
    const timer = visible && wait.normal ? window.setInterval(sync, 1000) : undefined;
    return () => { if (timer) clearInterval(timer); window.removeEventListener('online', sync); window.removeEventListener('offline', sync); document.removeEventListener('visibilitychange', sync); };
  }, [visible, wait.normal]);
  const connected = online && !wait.connectionIssue;
  const timed = connected && wait.normal && now !== null && Number.isFinite(wait.acceptedAt) && Number(wait.acceptedAt) > 0 && Number(wait.acceptedAt) <= now;
  const progress = timed ? simulatedProgress(wait.acceptedAt!, now!) : null;
  const status = loadingImage ? '正在加载图片' : !connected ? '状态暂未更新' : wait.normal ? progress === 95 ? '仍在生成' : '正在生成' : wait.status;
  return <div className={styles.waitExperience} data-sweeping={visible && connected && (wait.normal || loadingImage) || undefined} aria-busy="true">
    <span className={styles.waitSweep} aria-hidden="true" />
    <div className={styles.waitCopy}>
      <strong role="status">{status}</strong>
      {progress !== null && !loadingImage && <>
        <span className={styles.waitPercent} aria-hidden="true">预估进度 · {Math.floor(progress)}%</span>
        <span className={styles.waitTrack} aria-hidden="true"><span style={{ transform: `scaleX(${progress / 100})` }} /></span>
        <small>按时间模拟，实际完成时间可能不同</small>
      </>}
      <span className={styles.waitDetail}>{loadingImage ? '图片显示后即可查看' : !connected ? '正在重新连接，保留原任务' : wait.normal ? progress === 95 ? '完成后自动显示' : '任务已受理，无需重复提交' : wait.detail || '保留原任务，等待状态更新'}</span>
    </div>
  </div>;
}
