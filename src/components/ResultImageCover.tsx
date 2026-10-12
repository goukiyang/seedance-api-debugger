'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import styles from './ResultImageCover.module.css';

export function ResultImageCover({ src, alt, selected, applied, onSelect, onPreview, onViewed, onQuickUse, active = true, loadingOverlay }: {
  src?: string; alt: string; selected: boolean; applied: boolean; onSelect: () => void; onPreview: () => void; onViewed?: () => void;
  onQuickUse?: () => void; active?: boolean;
  loadingOverlay?: ReactNode;
}) {
  const [loaded, setLoaded] = useState('');
  const [failed, setFailed] = useState('');
  const [attempt, setAttempt] = useState(0);
  const identity = `${src}:${attempt}`;
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ onPreview, onQuickUse, active }); latest.current = { onPreview, onQuickUse, active };
  function cancelPreview() { if (previewTimer.current) clearTimeout(previewTimer.current); previewTimer.current = null; }
  useEffect(() => cancelPreview, [identity, active]);
  if (failed === identity) return <button type="button" className={styles.cover} aria-label={`重试读取${alt}`} onClick={() => { setFailed(''); setAttempt(value => value + 1); }}><span className={styles.readState}><RefreshCw size={18} />图片未能读取，点击重试</span></button>;
  return <button type="button" className={styles.cover} data-result-cover data-selected={selected || undefined}
    aria-label={`查看${alt}`} aria-pressed={selected} title={onQuickUse ? '单击查看图片，双击替换主图' : undefined}
    onClick={event => {
      event.stopPropagation();
      if (!active) return;
      if (event.detail > 1) { cancelPreview(); return; }
      onSelect();
      const image = event.currentTarget.querySelector('img');
      if (image?.complete && image.naturalWidth > 0) onViewed?.();
      cancelPreview();
      if (!onQuickUse || event.detail === 0) onPreview();
      else previewTimer.current = setTimeout(() => { previewTimer.current = null; if (latest.current.active) latest.current.onPreview(); }, 500);
    }}
    onDoubleClick={event => {
      event.preventDefault(); event.stopPropagation(); cancelPreview();
      if (latest.current.active) latest.current.onQuickUse?.();
    }}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img key={identity} decoding="async" src={src} alt={alt} loading="lazy" onError={() => setFailed(identity)} onLoad={event => { setLoaded(identity); if (selected && event.currentTarget.naturalWidth > 0) onViewed?.(); }} />
    {loaded !== identity && (loadingOverlay || <span className={styles.readState} role="status">正在读取图片</span>)}
    {applied && <span className={styles.applied}><Check size={13} />已套用</span>}
  </button>;
}
