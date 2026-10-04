'use client';

import { useId, useState } from 'react';
import { Check } from 'lucide-react';
import styles from './ResultImageCover.module.css';

export function ResultImageCover({ src, alt, disabledReason, applied, onRestore, onPreview }: {
  src?: string; alt: string; disabledReason: string; applied: boolean; onRestore: () => string | null; onPreview: () => void;
}) {
  const tooltipId = useId();
  const [hintDismissed, setHintDismissed] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; attempt: number } | null>(null);
  return <button type="button" className={styles.cover} data-result-cover={tooltipId} data-applied={applied || undefined}
    aria-label={`套用${alt}的设置`} aria-disabled={Boolean(disabledReason)} aria-describedby={`${tooltipId} ${tooltipId}-status`}
    onMouseEnter={() => setHintDismissed(false)} onFocus={() => setHintDismissed(false)}
    onKeyDown={event => { if (event.key === 'Escape') setHintDismissed(true); }}
    onClick={event => {
      event.stopPropagation();
      if (event.detail > 1) return;
      const reason = disabledReason || onRestore();
      setFeedback(previous => ({ text: reason || (applied ? '已再次套用' : '已套用'), attempt: (previous?.attempt || 0) + 1 }));
    }}
    onDoubleClick={event => { event.stopPropagation(); onPreview(); }}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img decoding="async" src={src} alt={alt} loading="lazy" />
    {!hintDismissed && <span id={tooltipId} role="tooltip" className={styles.hint}>{disabledReason || '双击放大'}</span>}
    {applied && <span className={styles.applied}><Check size={13} />已套用</span>}
    <span id={`${tooltipId}-status`} role="status" className={feedback?.text && feedback.text !== '已套用' && feedback.text !== '已再次套用' ? styles.feedback : styles.status}>
      {feedback && <span key={feedback.attempt}>{feedback.text}</span>}
    </span>
    {applied && feedback?.text === '已再次套用' && <span key={feedback.attempt} className={styles.repeat}>已再次套用</span>}
  </button>;
}
