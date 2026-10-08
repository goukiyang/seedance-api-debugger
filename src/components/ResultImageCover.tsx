'use client';

import { useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import styles from './ResultImageCover.module.css';

export function ResultImageCover({ src, alt, selected, applied, onSelect, onPreview, onViewed }: {
  src?: string; alt: string; selected: boolean; applied: boolean; onSelect: () => void; onPreview: () => void; onViewed?: () => void;
}) {
  const [loaded, setLoaded] = useState('');
  const [failed, setFailed] = useState('');
  const [attempt, setAttempt] = useState(0);
  const identity = `${src}:${attempt}`;
  if (failed === identity) return <button type="button" className={styles.cover} aria-label={`重试读取${alt}`} onClick={() => { setFailed(''); setAttempt(value => value + 1); }}><span className={styles.readState}><RefreshCw size={18} />图片未能读取，点击重试</span></button>;
  return <button type="button" className={styles.cover} data-result-cover data-selected={selected || undefined}
    aria-label={`查看${alt}`} aria-pressed={selected}
    onClick={event => {
      event.stopPropagation();
      if (event.detail > 1) return;
      onSelect();
      const image = event.currentTarget.querySelector('img');
      if (image?.complete && image.naturalWidth > 0) onViewed?.();
      onPreview();
    }}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img key={identity} decoding="async" src={src} alt={alt} loading="lazy" onError={() => setFailed(identity)} onLoad={event => { setLoaded(identity); if (selected && event.currentTarget.naturalWidth > 0) onViewed?.(); }} />
    {loaded !== identity && <span className={styles.readState} role="status">正在读取图片</span>}
    {applied && <span className={styles.applied}><Check size={13} />已套用</span>}
  </button>;
}
