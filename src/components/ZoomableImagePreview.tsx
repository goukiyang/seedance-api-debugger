'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, PointerEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowLeftRight, ArrowRight, ArrowUpDown, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import styles from './ZoomableImagePreview.module.css';
import ContentReactions from '@/components/content-reactions/ContentReactions';
import type { ContentKey } from '@/lib/content-reactions/types';
import { useMediaPreviewState, type MediaPreviewZoomMode } from '@/lib/hooks/use-media-preview-state';

export type ImageComparisonSource = {
  src: string;
  alt: string;
  fileName?: string;
  thumbnailSrc?: string;
};

export type ImagePreviewMetadata = {
  context?: string;
  model?: string;
  quality?: string;
  ratio?: string;
  resolution?: string;
  time?: string;
};

type ZoomableImagePreviewProps = {
  src: string;
  alt: string;
  fileName?: string;
  title?: string;
  previewKey?: string;
  contentKey?: ContentKey;
  metadata?: ImagePreviewMetadata;
  comparison?: ImageComparisonSource;
  details?: ReactNode;
  notice?: ReactNode;
  hasNavigation?: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
  onClose: () => void;
};

const MIN_SCALE = 0.5;
const MAX_SCALE = 24;
const SCALE_STEP = 1.2;
const DRAG_THRESHOLD = 5;

type ActiveDrag = {
  pointerId: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  moved: boolean;
};
type BackgroundClick = {
  pointerId: number;
  target: HTMLElement;
  startX: number;
  startY: number;
  moved: boolean;
};

type TouchPoint = { x: number; y: number };
type PinchGesture = {
  pointerIds: [number, number];
  distance: number;
  scale: number;
  maximum: number;
  offset: { x: number; y: number };
  point: { x: number; y: number };
};

function clampScale(value: number, maximum = MAX_SCALE) {
  return Math.min(maximum, Math.max(MIN_SCALE, value));
}

function clampRestoredScale(value: number) {
  return Math.min(1_000_000, Math.max(MIN_SCALE, value));
}

function displaySource(src: string, mode: 'preview' | 'thumbnail') {
  if (!/^\/api\/image-studio\/(?:assets|template-assets)\//.test(src)) return src;
  const url = new URL(src, 'https://sd2.youdooart.com');
  url.searchParams.delete('thumbnail');
  url.searchParams.delete('preview');
  url.searchParams.set(mode, '1');
  return `${url.pathname}${url.search}`;
}

function PreviewImage({ src, alt, original, className, style, onReady }: { src: string; alt: string; original: boolean; className: string; style: CSSProperties; onReady?: () => void }) {
  const image = useRef<HTMLImageElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [loadedKey, setLoadedKey] = useState('');
  const [failedKey, setFailedKey] = useState('');
  const displaySrc = original ? src : displaySource(src, 'preview');
  const thumbnail = displaySource(src, 'thumbnail');
  const key = `${displaySrc}:${attempt}`;
  const loaded = loadedKey === key;
  const failed = failedKey === key;
  useEffect(() => {
    if (image.current?.complete && image.current.naturalWidth > 0) {
      setLoadedKey(key);
      return;
    }
    if (loaded) return;
    const timer = window.setTimeout(() => setFailedKey(key), 30000);
    return () => window.clearTimeout(timer);
  }, [key, loaded]);
  return <>
    {thumbnail !== src && !loaded && <img src={thumbnail} alt="" aria-hidden="true" className={className} style={style} draggable={false} />}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img ref={image} key={key} src={displaySrc} alt={alt} className={className} style={{ ...style, opacity: loaded ? 1 : 0 }} draggable={false} data-image-preview-image
      onLoad={() => { setLoadedKey(key); setFailedKey(''); onReady?.(); }} onError={() => setFailedKey(key)} />
    {!loaded && <div className={styles.imageStatus} role="status">
      <span>{failed ? '图片未能加载' : original ? '原图加载中' : '高清预览加载中'}</span>
      {failed && <button type="button" title="重新加载" aria-label="重新加载图片" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setAttempt(value => value + 1); }}><RotateCcw size={16} /></button>}
    </div>}
  </>;
}

export function ZoomableImagePreview({ src, alt, fileName, title, previewKey, contentKey, metadata, comparison, details, notice, hasNavigation, onPrevious, onNext, onClose }: ZoomableImagePreviewProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ActiveDrag | null>(null);
  const backgroundClickRef = useRef<BackgroundClick | null>(null);
  const touchPointsRef = useRef(new Map<number, TouchPoint>());
  const pinchRef = useRef<PinchGesture | null>(null);
  const interactedRef = useRef(false);
  const pendingRestoreKeyRef = useRef<string | null>(null);
  const activeSourceRef = useRef<string | null>(null);
  const previewState = useMediaPreviewState(previewKey, contentKey, src);
  const [{ scale, offset }, setView] = useState({ scale: 1, offset: { x: 0, y: 0 } });
  const zoomPointRef = useRef<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const [zoomMode, setZoomMode] = useState<MediaPreviewZoomMode>('fit');
  const [showOriginal, setShowOriginal] = useState(false);
  const [comparisonMode, setComparisonMode] = useState(false);
  const [comparisonAxis, setComparisonAxis] = useState<'horizontal' | 'vertical'>('horizontal');
  const [showReference, setShowReference] = useState(false);

  const activeSrc = showReference && comparison ? comparison.src : src;
  const activeAlt = showReference && comparison ? comparison.alt : alt;

  const resetView = useCallback(() => {
    setView({ scale: 1, offset: { x: 0, y: 0 } });
    setZoomMode('fit');
    zoomPointRef.current = null;
  }, []);

  const zoomAtPoint = useCallback((factor: number, point: { x: number; y: number }) => {
    interactedRef.current = true;
    setZoomMode('custom');
    // Scale and translation must use the same previous frame, including batched wheel events.
    setView(current => {
      const nextScale = clampScale(current.scale * factor, zoomMode === 'actual' || current.scale > MAX_SCALE ? 1_000_000 : MAX_SCALE);
      const ratio = nextScale / current.scale;
      return { scale: nextScale, offset: {
        x: point.x - (point.x - current.offset.x) * ratio,
        y: point.y - (point.y - current.offset.y) * ratio,
      } };
    });
  }, [zoomMode]);

  const zoomFromControls = useCallback((factor: number) => {
    zoomAtPoint(factor, zoomPointRef.current || { x: 0, y: 0 });
  }, [zoomAtPoint]);

  const applyZoomMode = useCallback((mode: MediaPreviewZoomMode, explicit = true) => {
    if (explicit) interactedRef.current = true;
    setZoomMode(mode);
    zoomPointRef.current = null;
    if (mode === 'fit') {
      setView({ scale: 1, offset: { x: 0, y: 0 } });
      return;
    }
    if (mode === 'custom') return;

    const stage = stageRef.current;
    const image = stage?.querySelector<HTMLImageElement>(comparisonMode
      ? '[data-image-preview-pane="result"] [data-image-preview-image]'
      : '[data-image-preview-image]');
    if (!stage || !image?.naturalWidth) return;
    const renderedWidth = Number.parseFloat(window.getComputedStyle(image).width) || image.offsetWidth;
    if (!renderedWidth) return;
    const pane = image.closest<HTMLElement>('[data-image-preview-pane]');
    const frame = pane || stage;
    const availableWidth = Math.max(1, frame.clientWidth - 24);
    const nextScale = mode === 'width'
      ? availableWidth / renderedWidth
      : image.naturalWidth / renderedWidth;
    if (!Number.isFinite(nextScale) || nextScale <= 0) return;
    setView({ scale: Math.max(MIN_SCALE, nextScale), offset: { x: 0, y: 0 } });
  }, [comparisonMode]);

  const restoreStateKeyRef = useRef<string | null>(null);
  const lastPreviewStateKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const previousKey = lastPreviewStateKeyRef.current;
    if (previousKey && previousKey !== previewState.key) {
      interactedRef.current = false;
      restoreStateKeyRef.current = null;
      pendingRestoreKeyRef.current = null;
      setView({ scale: 1, offset: { x: 0, y: 0 } });
      setZoomMode('fit');
    }
    lastPreviewStateKeyRef.current = previewState.key;
  }, [previewState.key]);

  useEffect(() => {
    if (!previewState.ready || !previewState.key || interactedRef.current || restoreStateKeyRef.current === previewState.key) return;
    restoreStateKeyRef.current = previewState.key;
    pendingRestoreKeyRef.current = previewState.key;
    const saved = previewState.value;
    setView({ scale: clampRestoredScale(saved.scale), offset: { x: saved.offsetX, y: saved.offsetY } });
    setZoomMode(saved.zoomMode);
  }, [previewState.key, previewState.ready, previewState.value]);

  useEffect(() => {
    if (!previewState.key || !previewState.ready) return;
    if (restoreStateKeyRef.current !== previewState.key && !interactedRef.current) return;
    if (pendingRestoreKeyRef.current === previewState.key) {
      const saved = previewState.value;
      if (scale !== clampRestoredScale(saved.scale) || offset.x !== saved.offsetX || offset.y !== saved.offsetY || zoomMode !== saved.zoomMode) return;
      pendingRestoreKeyRef.current = null;
    }
    previewState.update({ scale, offsetX: offset.x, offsetY: offset.y, zoomMode });
  }, [offset.x, offset.y, previewState.key, previewState.ready, previewState.update, previewState.value, scale, zoomMode]);

  const rememberZoomPoint = useCallback((clientX: number, clientY: number) => {
    const stage = stageRef.current;
    if (!stage) return null;
    const target = document.elementFromPoint(clientX, clientY);
    if (!target || !stage.contains(target)) return null;
    const pane = target.closest('[data-image-preview-pane]');
    const surface = pane && stage.contains(pane) ? pane : stage;
    const rect = surface.getBoundingClientRect();
    const point = { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
    zoomPointRef.current = point;
    return point;
  }, []);

  useEffect(() => {
    setPortalRoot(document.body);
  }, []);

  useEffect(() => {
    const root = backdropRef.current;
    const toolbar = toolbarRef.current;
    if (!root || !toolbar) return;
    const measure = () => root.style.setProperty('--image-toolbar-height', `${Math.ceil(toolbar.getBoundingClientRect().height)}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [portalRoot]);

  useEffect(() => {
    backdropRef.current?.focus({ preventScroll: true });
  }, [portalRoot]);

  useEffect(() => {
    const elements = [document.documentElement, document.body];
    const previous = elements.map(element => ({ overflow: element.style.overflow, overscrollBehavior: element.style.overscrollBehavior }));
    const focused = document.activeElement;
    elements.forEach(element => {
      element.style.overflow = 'hidden';
      element.style.overscrollBehavior = 'none';
    });
    return () => {
      elements.forEach((element, index) => {
        element.style.overflow = previous[index].overflow;
        element.style.overscrollBehavior = previous[index].overscrollBehavior;
      });
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const focusable = Array.from(backdropRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])',
        ) || []).filter(element => element.getClientRects().length > 0 && window.getComputedStyle(element).visibility !== 'hidden');
        if (!focusable.length) {
          event.preventDefault();
          backdropRef.current?.focus({ preventScroll: true });
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === backdropRef.current
          || !backdropRef.current?.contains(document.activeElement))) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === backdropRef.current
          || !backdropRef.current?.contains(document.activeElement))) {
          event.preventDefault();
          first.focus({ preventScroll: true });
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      if (event.target instanceof Element && event.target.closest('select, input, textarea, [contenteditable]:not([contenteditable="false"]), button, a[href], summary, video[controls], audio[controls]')) return;
      const handled = (event.key === 'ArrowLeft' && hasNavigation && Boolean(onPrevious))
        || (event.key === 'ArrowRight' && hasNavigation && Boolean(onNext))
        || event.key === '+' || event.key === '=' || event.key === '-' || event.key === '0';
      if (!handled) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'ArrowLeft' && hasNavigation && onPrevious) onPrevious();
      if (event.key === 'ArrowRight' && hasNavigation && onNext) onNext();
      if (event.key === '+' || event.key === '=') zoomFromControls(SCALE_STEP);
      if (event.key === '-') zoomFromControls(1 / SCALE_STEP);
      if (event.key === '0') {
        interactedRef.current = true;
        resetView();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [hasNavigation, onClose, onNext, onPrevious, resetView, zoomFromControls]);

  const sourceIdentity = JSON.stringify([previewKey || '', src, comparison?.src || '']);
  useEffect(() => {
    if (activeSourceRef.current === null) {
      activeSourceRef.current = sourceIdentity;
      return;
    }
    if (activeSourceRef.current === sourceIdentity) return;
    activeSourceRef.current = sourceIdentity;
    interactedRef.current = false;
    pendingRestoreKeyRef.current = null;
    restoreStateKeyRef.current = null;
    resetView();
    setShowOriginal(false);
    setComparisonMode(false);
    setComparisonAxis('horizontal');
    setShowReference(false);
  }, [resetView, sourceIdentity]);

  const handleWheel = useCallback((event: WheelEvent) => {
    if (!event.deltaY) return;
    const point = rememberZoomPoint(event.clientX, event.clientY);
    if (!point) return;
    const factor = event.deltaY < 0 ? SCALE_STEP : 1 / SCALE_STEP;
    zoomAtPoint(factor, point);
  }, [rememberZoomPoint, zoomAtPoint]);

  useEffect(() => {
    // React delegates wheel listeners as passive; cancel the native event before it reaches the page.
    const wheel = (event: WheelEvent) => {
      if (!(event.target instanceof Node) || !stageRef.current?.contains(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      handleWheel(event);
    };
    window.addEventListener('wheel', wheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener('wheel', wheel, true);
    };
  }, [handleWheel]);

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const stage = event.currentTarget;
    const target = event.target;
    const pane = target instanceof HTMLElement ? target.closest<HTMLElement>('[data-image-preview-pane]') : null;
    const blockedTarget = target instanceof Element && target.closest(
      '[data-image-preview-image], button, a[href], input, textarea, select, summary',
    );
    const background = (event.pointerType === 'touch' || event.button === 0)
      && !blockedTarget && (target === stage || (pane && stage.contains(pane)))
      ? pane || stage
      : null;
    backgroundClickRef.current = background ? {
      pointerId: event.pointerId,
      target: background,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    } : null;
    if (event.pointerType === 'touch') {
      event.preventDefault();
      interactedRef.current = true;
      touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      event.currentTarget.setPointerCapture(event.pointerId);
      if (touchPointsRef.current.size >= 2) {
        backgroundClickRef.current = null;
        const pointerIds = Array.from(touchPointsRef.current.keys()).slice(0, 2) as [number, number];
        const first = touchPointsRef.current.get(pointerIds[0]);
        const second = touchPointsRef.current.get(pointerIds[1]);
        if (first && second) {
          const point = rememberZoomPoint((first.x + second.x) / 2, (first.y + second.y) / 2) || { x: 0, y: 0 };
          pinchRef.current = {
            pointerIds,
            distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
            scale,
            maximum: zoomMode === 'actual' || scale > MAX_SCALE ? 1_000_000 : MAX_SCALE,
            offset: { ...offset },
            point,
          };
          dragRef.current = null;
          setDragging(true);
        }
      } else if (scale > 1) {
        dragRef.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
        };
        setDragging(true);
      }
      return;
    }
    if ((event.button !== 0 && event.button !== 1) || scale <= 1 || dragRef.current) return;
    interactedRef.current = true;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [offset, rememberZoomPoint, scale, zoomMode]);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    rememberZoomPoint(event.clientX, event.clientY);
    const backgroundClick = backgroundClickRef.current;
    if (backgroundClick?.pointerId === event.pointerId
      && Math.hypot(event.clientX - backgroundClick.startX, event.clientY - backgroundClick.startY) > DRAG_THRESHOLD) {
      backgroundClick.moved = true;
    }
    if (event.pointerType === 'touch' && touchPointsRef.current.has(event.pointerId)) {
      touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const pinch = pinchRef.current;
      if (pinch && pinch.pointerIds.includes(event.pointerId)) {
        const first = touchPointsRef.current.get(pinch.pointerIds[0]);
        const second = touchPointsRef.current.get(pinch.pointerIds[1]);
        if (!first || !second) return;
        const nextDistance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
        const nextPoint = rememberZoomPoint((first.x + second.x) / 2, (first.y + second.y) / 2) || pinch.point;
        const nextScale = clampScale(pinch.scale * nextDistance / pinch.distance, pinch.maximum);
        const ratio = nextScale / pinch.scale;
        setZoomMode('custom');
        setView({
          scale: nextScale,
          offset: {
            x: nextPoint.x - (pinch.point.x - pinch.offset.x) * ratio,
            y: nextPoint.y - (pinch.point.y - pinch.offset.y) * ratio,
          },
        });
        return;
      }
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - drag.x;
    const deltaY = event.clientY - drag.y;
    const moved = drag.moved || Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > DRAG_THRESHOLD;
    dragRef.current = { ...drag, x: event.clientX, y: event.clientY, moved };
    interactedRef.current = true;
    setZoomMode('custom');
    setView(current => ({ ...current, offset: { x: current.offset.x + deltaX, y: current.offset.y + deltaY } }));
  }, [rememberZoomPoint]);

  const finishDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const backgroundClick = backgroundClickRef.current;
    let closeFromBackground = false;
    if (backgroundClick?.pointerId === event.pointerId) {
      backgroundClickRef.current = null;
      if (event.type === 'pointerup' && !backgroundClick.moved
        && Math.hypot(event.clientX - backgroundClick.startX, event.clientY - backgroundClick.startY) <= DRAG_THRESHOLD) {
        const hit = document.elementFromPoint(event.clientX, event.clientY);
        const stage = stageRef.current;
        if (hit && stage) {
          if (backgroundClick.target === stage) closeFromBackground = hit === stage;
          else {
            const hitPane = hit.closest('[data-image-preview-pane]');
            const blocked = hit.closest('[data-image-preview-image], button, a[href], input, textarea, select, summary');
            closeFromBackground = hitPane === backgroundClick.target && !blocked;
          }
        }
      }
    }
    if (event.pointerType === 'touch') {
      touchPointsRef.current.delete(event.pointerId);
      if (pinchRef.current?.pointerIds.includes(event.pointerId)) pinchRef.current = null;
      if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
      const remaining = Array.from(touchPointsRef.current.entries())[0];
      if (remaining && scale > 1) {
        const [pointerId, point] = remaining;
        dragRef.current = {
          pointerId,
          x: point.x,
          y: point.y,
          startX: point.x,
          startY: point.y,
          moved: true,
        };
      }
      setDragging(Boolean(remaining && scale > 1));
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (closeFromBackground) onClose();
      return;
    }
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      dragRef.current = null;
      setDragging(false);
      if (event.currentTarget.hasPointerCapture(drag.pointerId)) {
        event.currentTarget.releasePointerCapture(drag.pointerId);
      }
    }
    if (closeFromBackground) onClose();
  }, [onClose, scale]);

  const handleBackdropClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.target === event.currentTarget) onClose();
  }, [onClose]);

  const comparisonLayoutLabel = comparisonAxis === 'horizontal' ? '左右' : '上下';
  const handleImageReady = useCallback(() => {
    if (zoomMode === 'width' || zoomMode === 'actual') applyZoomMode(zoomMode, false);
  }, [applyZoomMode, zoomMode]);

  const preview = (
    <div
      ref={backdropRef}
      className={styles.backdrop}
      data-media-preview="sd2-media-preview"
      role="dialog"
      aria-modal="true"
      aria-label={title || fileName || alt || '图片预览'}
      tabIndex={-1}
      onClick={handleBackdropClick}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onMouseMove={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div ref={toolbarRef} className={styles.toolbar}>
        {contentKey && <ContentReactions contentKey={contentKey} />}
        {comparison && <button
          type="button"
          className={`${styles.referenceThumb} ${showReference ? styles.referenceThumbActive : ''}`}
          onClick={(event) => {
            event.stopPropagation();
            interactedRef.current = true;
            setShowReference((current) => !current);
            setComparisonMode(false);
            resetView();
          }}
          title={showReference ? '查看生成图' : '查看参考图'}
          aria-label={showReference ? '查看生成图' : '查看参考图'}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={comparison.thumbnailSrc || comparison.src} alt="参考图缩略图" draggable={false} />
        </button>}
        <div className={styles.title}>
          <strong>{title || fileName || alt}</strong>
          <span>{comparisonMode ? `${comparisonLayoutLabel}对比 · ` : ''}{Math.round(scale * 100)}%</span>
          {metadata && <div className={styles.metadata}>
            {(metadata.model || metadata.quality || metadata.ratio || metadata.resolution || metadata.time) && <span>{[metadata.model, metadata.quality, metadata.ratio, metadata.resolution, metadata.time].filter(Boolean).join(' · ')}</span>}
          </div>}
        </div>
        <div className={styles.actions}>
          {displaySource(activeSrc, 'preview') !== activeSrc && <button type="button" aria-pressed={showOriginal} onClick={() => { interactedRef.current = true; setShowOriginal(value => !value); }} title={showOriginal ? '切换高清预览' : '加载完整原图'}><span className={styles.actionLabel}>{showOriginal ? '原图' : '高清预览'}</span></button>}
          {hasNavigation && onPrevious && <button type="button" onClick={onPrevious} title="上一张" aria-label="上一张生成图片"><ArrowLeft size={16} /></button>}
          {hasNavigation && onNext && <button type="button" onClick={onNext} title="下一张" aria-label="下一张生成图片"><ArrowRight size={16} /></button>}
          {comparison && <button type="button" data-image-preview-compare aria-pressed={comparisonMode} onClick={() => { interactedRef.current = true; setComparisonMode((current) => !current); resetView(); }} title={comparisonMode ? '退出对比' : '对比参考图'} aria-label={comparisonMode ? '退出对比' : '对比参考图'}>
            <ArrowLeftRight size={16} /><span className={styles.actionLabel}>对比</span>
          </button>}
          {comparison && comparisonMode && <button type="button" data-image-preview-direction onClick={() => { interactedRef.current = true; setComparisonAxis((current) => current === 'horizontal' ? 'vertical' : 'horizontal'); resetView(); }} title={comparisonAxis === 'horizontal' ? '切换上下对比' : '切换左右对比'} aria-label={comparisonAxis === 'horizontal' ? '切换上下对比' : '切换左右对比'}>
            {comparisonAxis === 'horizontal' ? <ArrowUpDown size={16} /> : <ArrowLeftRight size={16} />}<span className={styles.actionLabel}>{comparisonLayoutLabel}</span>
          </button>}
          <label className={styles.zoomMode}>
            <span className={styles.srOnly}>显示比例</span>
            <select aria-label="显示比例" value={zoomMode} onChange={event => applyZoomMode(event.target.value as MediaPreviewZoomMode)}>
              <option value="fit">适合窗口</option>
              <option value="width">适合宽度</option>
              <option value="actual">实际像素</option>
              <option value="custom" disabled>手动缩放</option>
            </select>
          </label>
          <button type="button" onClick={() => zoomFromControls(1 / SCALE_STEP)} title="缩小" aria-label="缩小图片">
            <ZoomOut size={16} />
          </button>
          <button type="button" onClick={() => zoomFromControls(SCALE_STEP)} title="放大" aria-label="放大图片">
            <ZoomIn size={16} />
          </button>
          <button type="button" onClick={() => { interactedRef.current = true; previewState.reset(); resetView(); }} title="还原" aria-label="还原图片大小">
            <RotateCcw size={16} />
          </button>
          <button type="button" onClick={onClose} title="关闭" aria-label="关闭预览">
            <X size={16} />
          </button>
        </div>
        {notice != null && <div className={styles.notice}>{notice}</div>}
        {details != null && <details className={styles.detailDisclosure}>
          <summary>详情</summary>
          <div className={styles.detailContent}>{details}</div>
        </details>}
      </div>
      <div
        ref={stageRef}
        className={`${styles.stage} ${dragging ? styles.stageDragging : ''}`}
        data-zoomed={scale > 1}
        title="滚轮缩放，拖动查看"
        data-image-preview-stage
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
        onAuxClick={(event) => event.preventDefault()}
        onDoubleClick={() => { interactedRef.current = true; resetView(); }}
        onContextMenu={(event) => event.preventDefault()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {comparison && comparisonMode ? <div className={`${styles.compareFrame} ${comparisonAxis === 'vertical' ? styles.compareVertical : styles.compareHorizontal}`} data-image-preview-compare-frame>
          <div className={styles.comparePane} data-image-preview-pane="reference">
            <span className={styles.compareLabel}>参考图</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <PreviewImage src={comparison.src} alt={comparison.alt} original={showOriginal} className={styles.compareImage}
              style={{ transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale})` }} />
          </div>
          <div className={styles.comparePane} data-image-preview-pane="result">
            <span className={styles.compareLabel}>生成图</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <PreviewImage src={src} alt={alt} original={showOriginal} className={styles.compareImage}
              style={{ transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale})` }} onReady={handleImageReady} />
          </div>
        </div> : <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <PreviewImage
            src={activeSrc}
            alt={activeAlt}
            className={styles.image}
            original={showOriginal}
            style={{
              transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale})`,
            }}
            onReady={handleImageReady}
          />
        </>}
      </div>
    </div>
  );

  if (!portalRoot) return null;
  return createPortal(preview, portalRoot);
}
