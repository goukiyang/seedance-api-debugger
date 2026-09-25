'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowLeftRight, ArrowRight, ArrowUpDown, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import styles from './ZoomableImagePreview.module.css';

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
  metadata?: ImagePreviewMetadata;
  comparison?: ImageComparisonSource;
  hasNavigation?: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
  onClose: () => void;
};

const MIN_SCALE = 0.5;
const MAX_SCALE = 6;
const SCALE_STEP = 1.2;

function clampScale(value: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function displaySource(src: string, mode: 'preview' | 'thumbnail') {
  if (!/^\/api\/image-studio\/(?:assets|template-assets)\//.test(src)) return src;
  const url = new URL(src, 'https://sd2.youdooart.com');
  url.searchParams.delete('thumbnail');
  url.searchParams.delete('preview');
  url.searchParams.set(mode, '1');
  return `${url.pathname}${url.search}`;
}

function PreviewImage({ src, alt, original, className, style }: { src: string; alt: string; original: boolean; className: string; style: CSSProperties }) {
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
    <img ref={image} key={key} src={displaySrc} alt={alt} className={className} style={{ ...style, opacity: loaded ? 1 : 0 }} draggable={false}
      onLoad={() => { setLoadedKey(key); setFailedKey(''); }} onError={() => setFailedKey(key)} />
    {!loaded && <div className={styles.imageStatus} role="status">
      <span>{failed ? '图片未能加载' : original ? '原图加载中' : '高清预览加载中'}</span>
      {failed && <button type="button" title="重新加载" aria-label="重新加载图片" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setAttempt(value => value + 1); }}><RotateCcw size={16} /></button>}
    </div>}
  </>;
}

export function ZoomableImagePreview({ src, alt, fileName, title, previewKey, metadata, comparison, hasNavigation, onPrevious, onNext, onClose }: ZoomableImagePreviewProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [comparisonMode, setComparisonMode] = useState(false);
  const [comparisonAxis, setComparisonAxis] = useState<'horizontal' | 'vertical'>('horizontal');
  const [showReference, setShowReference] = useState(false);

  const activeSrc = showReference && comparison ? comparison.src : src;
  const activeAlt = showReference && comparison ? comparison.alt : alt;

  const resetView = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const zoomAtCenter = useCallback((factor: number) => {
    setScale((current) => clampScale(current * factor));
  }, []);

  useEffect(() => {
    setPortalRoot(document.body);
  }, []);

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
        const buttons = Array.from(backdropRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
        if (!buttons.length) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus({ preventScroll: true });
        return;
      }
      const handled = event.key === 'Escape' || event.key === 'ArrowLeft' || event.key === 'ArrowRight'
        || event.key === '+' || event.key === '=' || event.key === '-' || event.key === '0'
        || ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key);
      if (!handled) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft' && hasNavigation) onPrevious?.();
      if (event.key === 'ArrowRight' && hasNavigation) onNext?.();
      if (event.key === '+' || event.key === '=') zoomAtCenter(SCALE_STEP);
      if (event.key === '-') zoomAtCenter(1 / SCALE_STEP);
      if (event.key === '0') resetView();
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [hasNavigation, onClose, onNext, onPrevious, resetView, zoomAtCenter]);

  useEffect(() => {
    resetView();
    setShowOriginal(false);
    setComparisonMode(false);
    setComparisonAxis('horizontal');
    setShowReference(false);
  }, [resetView, previewKey, src, comparison?.src]);

  const handleWheel = useCallback((event: WheelEvent) => {
    const stage = stageRef.current;
    if (!stage || !event.deltaY) return;

    const rect = stage.getBoundingClientRect();
    const cursorX = event.clientX - rect.left - rect.width / 2;
    const cursorY = event.clientY - rect.top - rect.height / 2;
    const factor = event.deltaY < 0 ? SCALE_STEP : 1 / SCALE_STEP;
    const nextScale = clampScale(scale * factor);
    const ratio = nextScale / scale;

    setScale(nextScale);
    setOffset((current) => ({
      x: cursorX - (cursorX - current.x) * ratio,
      y: cursorY - (cursorY - current.y) * ratio,
    }));
  }, [scale]);

  useEffect(() => {
    // React delegates wheel listeners as passive; cancel the native event before it reaches the page.
    const wheel = (event: WheelEvent) => {
      if (!(event.target instanceof Node) || !backdropRef.current?.contains(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (stageRef.current?.contains(event.target)) handleWheel(event);
    };
    const touchMove = (event: TouchEvent) => {
      if (!(event.target instanceof Node) || !backdropRef.current?.contains(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('wheel', wheel, { capture: true, passive: false });
    window.addEventListener('touchmove', touchMove, { capture: true, passive: false });
    return () => {
      window.removeEventListener('wheel', wheel, true);
      window.removeEventListener('touchmove', touchMove, true);
    };
  }, [handleWheel]);

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    if (scale <= 1) return;
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [scale]);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - drag.x;
    const deltaY = event.clientY - drag.y;
    dragRef.current = { ...drag, x: event.clientX, y: event.clientY };
    setOffset((current) => ({ x: current.x + deltaX, y: current.y + deltaY }));
  }, []);

  const finishDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag && event.currentTarget.hasPointerCapture(drag.pointerId)) {
      event.currentTarget.releasePointerCapture(drag.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
  }, []);

  const handleBackdropClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.target === event.currentTarget) onClose();
  }, [onClose]);

  const comparisonLayoutLabel = comparisonAxis === 'horizontal' ? '左右' : '上下';

  const preview = (
    <div
      ref={backdropRef}
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label="参考图预览"
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
      <div className={styles.toolbar}>
        {comparison && <button
          type="button"
          className={`${styles.referenceThumb} ${showReference ? styles.referenceThumbActive : ''}`}
          onClick={(event) => {
            event.stopPropagation();
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
          {displaySource(activeSrc, 'preview') !== activeSrc && <button type="button" aria-pressed={showOriginal} onClick={() => setShowOriginal(value => !value)} title={showOriginal ? '切换高清预览' : '加载完整原图'}><span className={styles.actionLabel}>{showOriginal ? '原图' : '高清预览'}</span></button>}
          {hasNavigation && <>
            <button type="button" onClick={onPrevious} title="上一张" aria-label="上一张生成图片"><ArrowLeft size={16} /></button>
            <button type="button" onClick={onNext} title="下一张" aria-label="下一张生成图片"><ArrowRight size={16} /></button>
          </>}
          {comparison && <button type="button" data-image-preview-compare aria-pressed={comparisonMode} onClick={() => { setComparisonMode((current) => !current); resetView(); }} title={comparisonMode ? '退出对比' : '对比参考图'} aria-label={comparisonMode ? '退出对比' : '对比参考图'}>
            <ArrowLeftRight size={16} /><span className={styles.actionLabel}>对比</span>
          </button>}
          {comparison && comparisonMode && <button type="button" data-image-preview-direction onClick={() => { setComparisonAxis((current) => current === 'horizontal' ? 'vertical' : 'horizontal'); resetView(); }} title={comparisonAxis === 'horizontal' ? '切换上下对比' : '切换左右对比'} aria-label={comparisonAxis === 'horizontal' ? '切换上下对比' : '切换左右对比'}>
            {comparisonAxis === 'horizontal' ? <ArrowUpDown size={16} /> : <ArrowLeftRight size={16} />}<span className={styles.actionLabel}>{comparisonLayoutLabel}</span>
          </button>}
          <button type="button" onClick={() => zoomAtCenter(1 / SCALE_STEP)} title="缩小" aria-label="缩小图片">
            <ZoomOut size={16} />
          </button>
          <button type="button" onClick={() => zoomAtCenter(SCALE_STEP)} title="放大" aria-label="放大图片">
            <ZoomIn size={16} />
          </button>
          <button type="button" onClick={resetView} title="还原" aria-label="还原图片大小">
            <RotateCcw size={16} />
          </button>
          <button type="button" onClick={onClose} title="关闭" aria-label="关闭预览">
            <X size={16} />
          </button>
        </div>
      </div>
      <div
        ref={stageRef}
        className={`${styles.stage} ${dragging ? styles.stageDragging : ''}`}
        title="滚轮缩放，拖动查看"
        data-image-preview-stage
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onAuxClick={(event) => event.preventDefault()}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        onDoubleClick={resetView}
        onContextMenu={(event) => event.preventDefault()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {comparison && comparisonMode ? <div className={`${styles.compareFrame} ${comparisonAxis === 'vertical' ? styles.compareVertical : styles.compareHorizontal}`} data-image-preview-compare-frame>
          <div className={styles.comparePane} data-image-preview-pane="reference" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
            <span className={styles.compareLabel}>参考图</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <PreviewImage src={comparison.src} alt={comparison.alt} original={showOriginal} className={styles.compareImage}
              style={{ transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale})` }} />
          </div>
          <div className={styles.comparePane} data-image-preview-pane="result" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
            <span className={styles.compareLabel}>生成图</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <PreviewImage src={src} alt={alt} original={showOriginal} className={styles.compareImage}
              style={{ transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale})` }} />
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
          />
        </>}
      </div>
    </div>
  );

  if (!portalRoot) return null;
  return createPortal(preview, portalRoot);
}
