'use client';

import { forwardRef, useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type MutableRefObject, type PointerEvent, type ReactNode } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import styles from './ResultImageCover.module.css';

type ResultImageCoverProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onSelect'> & {
  src?: string; alt: string; selected: boolean; applied: boolean; onSelect: () => void; onPreview: () => void; onViewed?: () => void;
  onQuickUse?: () => void; active?: boolean;
  loadingOverlay?: ReactNode;
  contextMenuEnabled?: boolean;
  menuOpen?: boolean;
  cancelPreviewRef?: MutableRefObject<(() => void) | null>;
};

export const ResultImageCover = forwardRef<HTMLButtonElement, ResultImageCoverProps>(function ResultImageCover({
  src, alt, selected, applied, onSelect, onPreview, onViewed, onQuickUse, active = true, loadingOverlay, contextMenuEnabled = false, menuOpen = false, cancelPreviewRef,
  className, onClick, onDoubleClick, onContextMenu, onKeyDown, onPointerDown, onPointerMove, onPointerUp, onPointerCancel,
  onPointerDownCapture, onPointerMoveCapture, onPointerUpCapture, onPointerCancelCapture, onClickCapture, onDoubleClickCapture, ...domProps
}, forwardedRef) {
  const [loaded, setLoaded] = useState('');
  const [failed, setFailed] = useState('');
  const [attempt, setAttempt] = useState(0);
  const identity = `${src}:${attempt}`;
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ onPreview, onQuickUse, active }); latest.current = { onPreview, onQuickUse, active };
  const cancelPreview = useCallback(() => { if (previewTimer.current) clearTimeout(previewTimer.current); previewTimer.current = null; }, []);
  if (cancelPreviewRef) cancelPreviewRef.current = contextMenuEnabled ? cancelPreview : null;
  useEffect(() => cancelPreview, [identity, active, cancelPreview]);
  useEffect(() => () => { if (cancelPreviewRef?.current === cancelPreview) cancelPreviewRef.current = null; }, [cancelPreviewRef, cancelPreview]);
  function cancelMenuPointerPreview(event: PointerEvent<HTMLButtonElement>) {
    if (contextMenuEnabled && (menuOpen || event.defaultPrevented || event.button === 2 || event.ctrlKey || event.pointerType !== 'mouse')) cancelPreview();
  }
  const failedRead = failed === identity;
  return <button {...domProps} ref={forwardedRef} type="button" className={`${styles.cover}${className ? ` ${className}` : ''}`} data-result-cover data-selected={selected || undefined}
    aria-label={domProps['aria-label'] || (failedRead ? `重试读取${alt}` : `查看${alt}`)} aria-pressed={domProps['aria-pressed'] ?? selected}
    title={domProps.title ?? (onQuickUse ? '单击查看图片，双击取回本次输入主图' : undefined)}
    onContextMenu={event => { if (contextMenuEnabled) cancelPreview(); onContextMenu?.(event); }}
    onKeyDown={event => {
      if (contextMenuEnabled && (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) cancelPreview();
      onKeyDown?.(event);
    }}
    onPointerDown={event => { cancelMenuPointerPreview(event); onPointerDown?.(event); }}
    onPointerMove={event => { cancelMenuPointerPreview(event); onPointerMove?.(event); }}
    onPointerUp={event => { cancelMenuPointerPreview(event); onPointerUp?.(event); }}
    onPointerCancel={event => { cancelMenuPointerPreview(event); onPointerCancel?.(event); }}
    onPointerDownCapture={event => { cancelMenuPointerPreview(event); onPointerDownCapture?.(event); }}
    onPointerMoveCapture={event => { cancelMenuPointerPreview(event); onPointerMoveCapture?.(event); }}
    onPointerUpCapture={event => { cancelMenuPointerPreview(event); onPointerUpCapture?.(event); }}
    onPointerCancelCapture={event => { cancelMenuPointerPreview(event); onPointerCancelCapture?.(event); }}
    onClickCapture={event => {
      if (contextMenuEnabled && (menuOpen || event.ctrlKey || event.button === 2)) cancelPreview();
      onClickCapture?.(event);
      if (contextMenuEnabled && event.defaultPrevented) cancelPreview();
    }}
    onDoubleClickCapture={event => { if (contextMenuEnabled) cancelPreview(); onDoubleClickCapture?.(event); }}
    onClick={event => {
      onClick?.(event);
      if (contextMenuEnabled && (event.defaultPrevented || menuOpen)) { cancelPreview(); return; }
      if (failedRead) { setFailed(''); setAttempt(value => value + 1); return; }
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
      onDoubleClick?.(event);
      if (failedRead || contextMenuEnabled && (event.defaultPrevented || menuOpen)) { cancelPreview(); return; }
      event.preventDefault(); event.stopPropagation(); cancelPreview();
      if (latest.current.active) latest.current.onQuickUse?.();
    }}>
    {failedRead ? <span className={styles.readState}><RefreshCw size={18} />图片未能读取，点击重试</span> : <>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img key={identity} decoding="async" src={src} alt={alt} loading="lazy" onError={() => setFailed(identity)} onLoad={event => { setLoaded(identity); if (selected && event.currentTarget.naturalWidth > 0) onViewed?.(); }} />
    {loaded !== identity && (loadingOverlay || <span className={styles.readState} role="status">正在读取图片</span>)}
    {applied && <span className={styles.applied}><Check size={13} />已套用</span>}
    </>}
  </button>;
});
