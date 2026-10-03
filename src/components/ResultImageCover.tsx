'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import styles from './ResultImageCover.module.css';

// Scope delayed single clicks to one result and cancel them before a double-click preview.
let cancelPendingClick: (() => void) | undefined;
export function ResultImageCover({ src, alt, restoreDisabled, onRestore, onPreview }: {
  src?: string; alt: string; restoreDisabled: boolean; onRestore: () => void; onPreview: () => void;
}) {
  const tooltipId = useId();
  const pathname = usePathname();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const restore = useRef(onRestore);
  restore.current = onRestore;
  const [hintDismissed, setHintDismissed] = useState(false);
  const cancel = useCallback(() => { clearTimeout(timer.current); timer.current = undefined; if (cancelPendingClick === cancel) cancelPendingClick = undefined; }, []);
  useEffect(() => {
    const onPointer = () => { if (timer.current) cancel(); };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', cancel, true);
    return () => { cancel(); document.removeEventListener('pointerdown', onPointer, true); document.removeEventListener('keydown', cancel, true); };
  }, [cancel, pathname, src, tooltipId]);
  useEffect(() => { if (restoreDisabled) cancel(); }, [cancel, restoreDisabled]);
  return <button type="button" className={styles.cover} data-result-cover={tooltipId}
    aria-label={`恢复${alt}的设置`} aria-describedby={tooltipId}
    onMouseEnter={() => setHintDismissed(false)} onFocus={() => setHintDismissed(false)}
    onKeyDown={event => { if (event.key === 'Escape') setHintDismissed(true); }}
    onClick={event => {
      event.stopPropagation();
      cancelPendingClick?.(); cancel();
      if (event.detail > 1 || restoreDisabled) return;
      if (event.detail === 0) { restore.current(); return; }
      cancelPendingClick = cancel;
      timer.current = setTimeout(() => { if (cancelPendingClick === cancel) { cancel(); restore.current(); } }, 1000);
    }}
    onDoubleClick={event => { event.stopPropagation(); cancelPendingClick?.(); cancel(); onPreview(); }}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img decoding="async" src={src} alt={alt} loading="lazy" />
    {!hintDismissed && <span id={tooltipId} role="tooltip" className={styles.hint}>双击放大</span>}
  </button>;
}
