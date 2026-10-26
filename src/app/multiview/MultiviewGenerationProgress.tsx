'use client';

import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import type { MultiviewGenerationProgressState } from './multiview-generation-progress';
import styles from './multiview-generation.module.css';

export function MultiviewGenerationProgress({ state, taskId, previewReady, preparing }: {
  state?: MultiviewGenerationProgressState | null; taskId?: string; previewReady: boolean; preparing: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!state?.createdAt || previewReady || state.videoReady || state.failed) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state?.createdAt, state?.failed, state?.videoReady, previewReady]);
  if (!state) return null;
  const step = previewReady && !state.failed ? 4 : preparing && !state.failed ? 3 : state.step;
  const label = step === 4 ? '可以选帧' : preparing ? '正在准备选帧' : state.label;
  const elapsed = state.createdAt ? Math.max(0, Math.floor((now - Date.parse(state.createdAt)) / 1000)) : null;
  if (step === 4 || state.videoReady && !preparing && !state.failed) return <section className={styles.progressComplete} aria-label="本次生成">
    <Check size={14} /><span>{step === 4 ? '视频已就绪，可以选帧' : '视频已就绪'}</span>
    {taskId && <a href={`/tasks/${encodeURIComponent(taskId)}`} target="_blank" rel="noreferrer">详情</a>}
  </section>;
  return <section className={styles.progress} aria-label="本次生成" data-failed={state.failed || undefined}>
    <div className={styles.progressHeading}><strong>{label}</strong>
      {elapsed !== null && !state.videoReady && step !== 4 && !state.failed && <small>提交后已用时 {Math.floor(elapsed / 60)}分{elapsed % 60}秒</small>}
      {state.uncertain && step !== 4 && <small>系统会自动确认，不会重复扣点</small>}
    </div>
    <ol className={styles.progressSteps}>{['提交', '等待生成', '生成视频', '准备选帧', '可以选帧'].map((text, index) =>
      <li key={text} data-done={step !== null && index < step || undefined} aria-current={step === index ? 'step' : undefined}>
        <span>{step !== null && index < step ? <Check size={12} /> : index + 1}</span><small>{text}</small>
      </li>)}</ol>
    {taskId && <a href={`/tasks/${encodeURIComponent(taskId)}`} target="_blank" rel="noreferrer">详情</a>}
  </section>;
}
