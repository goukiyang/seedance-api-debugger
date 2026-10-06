'use client';

import { useId, useState } from 'react';
import { Check } from 'lucide-react';
import styles from './ResultImageCover.module.css';

export function ResultImageCover({ src, alt, selected, applied, onSelect, onPreview, onViewed }: {
  src?: string; alt: string; selected: boolean; applied: boolean; onSelect: () => void; onPreview: () => void; onViewed?: () => void;
}) {
  const tooltipId = useId();
  const [hintDismissed, setHintDismissed] = useState(false);
  return <button type="button" className={styles.cover} data-result-cover={tooltipId} data-selected={selected || undefined}
    aria-label={`选择${alt}`} aria-pressed={selected} aria-describedby={tooltipId}
    onMouseEnter={() => setHintDismissed(false)} onFocus={() => setHintDismissed(false)}
    onKeyDown={event => { if (event.key === 'Escape') setHintDismissed(true); }}
    onClick={event => {
      event.stopPropagation();
      if (event.detail > 1) return;
      onSelect();
      const image = event.currentTarget.querySelector('img');
      if (image?.complete && image.naturalWidth > 0) onViewed?.();
    }}
    onDoubleClick={event => { event.stopPropagation(); onPreview(); }}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img decoding="async" src={src} alt={alt} loading="lazy" onLoad={event => { if (selected && event.currentTarget.naturalWidth > 0) onViewed?.(); }} />
    {!hintDismissed && <span id={tooltipId} role="tooltip" className={styles.hint}>双击放大</span>}
    {applied && <span className={styles.applied}><Check size={13} />已套用</span>}
  </button>;
}
