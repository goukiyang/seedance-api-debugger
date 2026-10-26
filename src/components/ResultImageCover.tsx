'use client';

import { forwardRef, useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type MutableRefObject, type PointerEvent, type ReactNode } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { prepareImagePreview, type ImagePreviewPreparation, type ImagePreviewPreparationOptions } from '@/lib/media/image-preview-session';
import styles from './ResultImageCover.module.css';

type ResultImageCoverProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onSelect'> & {
  src?: string; alt: string; selected: boolean; applied: boolean; onSelect: () => void; onPreview: (preparation?: ImagePreviewPreparation) => void; onViewed?: () => void;
  previewSource?: ImagePreviewPreparationOptions;
  onQuickUse?: () => void; active?: boolean;
  loadingOverlay?: ReactNode;
  contextMenuEnabled?: boolean;
  menuOpen?: boolean;
  recoverFromThumbnailError?: boolean;
  cancelPreviewRef?: MutableRefObject<(() => void) | null>;
};

export const ResultImageCover = forwardRef<HTMLButtonElement, ResultImageCoverProps>(function ResultImageCover({
  src, alt, selected, applied, onSelect, onPreview, previewSource, onViewed, onQuickUse, active = true, loadingOverlay, contextMenuEnabled = false, menuOpen = false, recoverFromThumbnailError = false, cancelPreviewRef,
  className, onClick, onDoubleClick, onContextMenu, onKeyDown, onPointerDown, onPointerMove, onPointerUp, onPointerCancel,
  onPointerDownCapture, onPointerMoveCapture, onPointerUpCapture, onPointerCancelCapture, onClickCapture, onDoubleClickCapture, ...domProps
}, forwardedRef) {
  const [loaded, setLoaded] = useState('');
  const [failed, setFailed] = useState('');
  const [attempt, setAttempt] = useState(0);
  const identity = `${src}:${attempt}`;
  const failedRead = failed === identity;
  const preparationIdentity = JSON.stringify([previewSource?.account, previewSource?.source, previewSource?.sourceVersion || '', Boolean(previewSource?.previewOnly)]);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preparation = useRef<ImagePreviewPreparation | null>(null);
  const latest = useRef({ onPreview, onQuickUse, active, menuOpen, failedRead, identity, preparationIdentity, recoverFromThumbnailError });
  latest.current = { onPreview, onQuickUse, active, menuOpen, failedRead, identity, preparationIdentity, recoverFromThumbnailError };
  const cancelPreview = useCallback(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = null;
    preparation.current?.release(); preparation.current = null;
  }, []);
  const handOffPreview = () => {
    const prepared = preparation.current;
    preparation.current = null;
    prepared?.confirmOpen();
    try { latest.current.onPreview(prepared || undefined); }
    catch (cause) { prepared?.release(); throw cause; }
  };
  if (cancelPreviewRef) cancelPreviewRef.current = contextMenuEnabled ? cancelPreview : null;
  useEffect(() => cancelPreview, [identity, preparationIdentity, active, menuOpen, failedRead, cancelPreview]);
  useEffect(() => () => { if (cancelPreviewRef?.current === cancelPreview) cancelPreviewRef.current = null; }, [cancelPreviewRef, cancelPreview]);
  function cancelMenuPointerPreview(event: PointerEvent<HTMLButtonElement>) {
    if (event.defaultPrevented || event.button === 2 || event.ctrlKey || contextMenuEnabled && (menuOpen || event.pointerType !== 'mouse')) cancelPreview();
  }
  return <button {...domProps} ref={forwardedRef} type="button" className={`${styles.cover}${className ? ` ${className}` : ''}`} data-result-cover data-selected={selected || undefined}
    aria-label={domProps['aria-label'] || (failedRead && !recoverFromThumbnailError ? `重试读取${alt}` : `查看${alt}`)} aria-pressed={domProps['aria-pressed'] ?? selected}
    title={domProps.title ?? (onQuickUse ? '单击查看图片，双击取回本次输入主图' : undefined)}
    onContextMenu={event => { cancelPreview(); onContextMenu?.(event); }}
    onKeyDown={event => {
      if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) cancelPreview();
      onKeyDown?.(event);
    }}
    onPointerDown={event => { cancelMenuPointerPreview(event); onPointerDown?.(event); }}
    onPointerMove={event => { cancelMenuPointerPreview(event); onPointerMove?.(event); }}
    onPointerUp={event => { cancelMenuPointerPreview(event); onPointerUp?.(event); }}
    onPointerCancel={event => { cancelPreview(); onPointerCancel?.(event); }}
    onPointerDownCapture={event => { cancelMenuPointerPreview(event); onPointerDownCapture?.(event); }}
    onPointerMoveCapture={event => { cancelMenuPointerPreview(event); onPointerMoveCapture?.(event); }}
    onPointerUpCapture={event => { cancelMenuPointerPreview(event); onPointerUpCapture?.(event); }}
    onPointerCancelCapture={event => { cancelPreview(); onPointerCancelCapture?.(event); }}
    onClickCapture={event => {
      if (contextMenuEnabled && (menuOpen || event.ctrlKey || event.button === 2)) cancelPreview();
      onClickCapture?.(event);
      if (contextMenuEnabled && event.defaultPrevented) cancelPreview();
    }}
    onDoubleClickCapture={event => { cancelPreview(); onDoubleClickCapture?.(event); }}
    onClick={event => {
      onClick?.(event);
      if (event.defaultPrevented || menuOpen || event.ctrlKey || event.button !== 0) { cancelPreview(); return; }
      // A thumbnail error is not evidence that the separately authorized
      // original is unavailable. Keep preview and direct-input recovery live.
      if (failedRead && !recoverFromThumbnailError) { setFailed(''); setAttempt(value => value + 1); return; }
      event.stopPropagation();
      if (!active || isClientSessionBlocked()) { cancelPreview(); return; }
      if (event.detail > 1) { cancelPreview(); return; }
      cancelPreview();
      if (previewSource) preparation.current = prepareImagePreview({ ...previewSource, intent: 'prepare' });
      try {
        onSelect();
        const image = event.currentTarget.querySelector('img');
        if (image?.complete && image.naturalWidth > 0) onViewed?.();
      } catch (cause) { cancelPreview(); throw cause; }
      if (!onQuickUse || event.detail === 0) handOffPreview();
      else previewTimer.current = setTimeout(() => {
        previewTimer.current = null;
        if (latest.current.active && !latest.current.menuOpen && (!latest.current.failedRead || latest.current.recoverFromThumbnailError) && latest.current.identity === identity
          && latest.current.preparationIdentity === preparationIdentity && !isClientSessionBlocked()) handOffPreview();
        else cancelPreview();
      }, 500);
    }}
    onDoubleClick={event => {
      onDoubleClick?.(event);
      if (failedRead && !recoverFromThumbnailError || event.defaultPrevented || menuOpen || isClientSessionBlocked()) { cancelPreview(); return; }
      event.preventDefault(); event.stopPropagation(); cancelPreview();
      if (latest.current.active) latest.current.onQuickUse?.();
    }}>
    {failedRead ? <span className={styles.readState}><RefreshCw size={18} />{recoverFromThumbnailError ? '缩略图暂不可用，仍可查看或取回原图' : '图片未能读取，点击重试'}</span> : <>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img key={identity} decoding="async" src={src} alt={alt} loading="lazy" onError={() => { cancelPreview(); setFailed(identity); }} onLoad={event => { setLoaded(identity); if (selected && event.currentTarget.naturalWidth > 0) onViewed?.(); }} />
    {loaded !== identity && (loadingOverlay || <span className={styles.readState} role="status">正在读取图片</span>)}
    {applied && <span className={styles.applied}><Check size={13} />已套用</span>}
    </>}
  </button>;
});
