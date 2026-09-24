'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent, WheelEvent } from 'react';
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

export function ZoomableImagePreview({ src, alt, fileName, title, previewKey, metadata, comparison, hasNavigation, onPrevious, onNext, onClose }: ZoomableImagePreviewProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [comparisonMode, setComparisonMode] = useState(false);
  const [comparisonAxis, setComparisonAxis] = useState<'horizontal' | 'vertical'>('horizontal');
  const [comparisonLoaded, setComparisonLoaded] = useState(false);
  const [comparisonError, setComparisonError] = useState(false);
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
    backdropRef.current?.focus();
  }, [portalRoot]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      const handled = event.key === 'Escape' || event.key === 'ArrowLeft' || event.key === 'ArrowRight'
        || event.key === '+' || event.key === '=' || event.key === '-' || event.key === '0';
      if (!handled) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft' && hasNavigation) onPrevious?.();
      if (event.key === 'ArrowRight' && hasNavigation) onNext?.();
      if (event.key === '+' || event.key === '=') zoomAtCenter(SCALE_STEP);
      if (event.key === '-') zoomAtCenter(1 / SCALE_STEP);
      if (event.key === '0') resetView();
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [hasNavigation, onClose, onNext, onPrevious, resetView, zoomAtCenter]);

  useEffect(() => {
    resetView();
    setImageLoaded(false);
    setImageError(false);
    setComparisonMode(false);
    setComparisonAxis('horizontal');
    setComparisonLoaded(false);
    setComparisonError(false);
    setShowReference(false);
  }, [resetView, previewKey, src, comparison?.src]);

  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;

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
      onWheel={(event) => event.preventDefault()}
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
          <span>{comparisonMode ? `${comparisonLayoutLabel}对比 · ${Math.round(scale * 100)}%` : imageError ? '加载失败' : imageLoaded ? `${Math.round(scale * 100)}%` : '加载中...'}</span>
          {metadata && <div className={styles.metadata}>
            {(metadata.model || metadata.quality || metadata.ratio || metadata.resolution || metadata.time) && <span>{[metadata.model, metadata.quality, metadata.ratio, metadata.resolution, metadata.time].filter(Boolean).join(' · ')}</span>}
          </div>}
        </div>
        <div className={styles.actions}>
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
        aria-busy={!imageLoaded && !imageError || comparisonMode && !comparisonLoaded && !comparisonError}
        onWheel={handleWheel}
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
        {/* 参考图来源可能是本地、远程或临时地址，这里保留原生 img 以支持原图缩放查看。 */}
        {(!imageLoaded || imageError) && (
          <div className={styles.loadingState} role="status" aria-live="polite">
            {!imageError && <span className={styles.loadingSpinner} />}
            <strong>{imageError ? '图片加载失败' : '图片加载中...'}</strong>
            <small>{imageError ? '请关闭后重试，或检查图片地址。' : '原图较大时可能需要几秒。'}</small>
          </div>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {comparison && comparisonMode ? <div className={`${styles.compareFrame} ${comparisonAxis === 'vertical' ? styles.compareVertical : styles.compareHorizontal}`} data-image-preview-compare-frame>
          <div className={styles.comparePane} data-image-preview-pane="reference" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
            <span className={styles.compareLabel}>参考图</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={comparison.src} alt={comparison.alt} className={`${styles.compareImage} ${comparisonLoaded ? styles.imageReady : styles.imageLoading}`} draggable={false}
              onLoad={() => { setComparisonLoaded(true); setComparisonError(false); }} onError={() => { setComparisonLoaded(false); setComparisonError(true); }}
              style={{ transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale})` }} />
          </div>
          <div className={styles.comparePane} data-image-preview-pane="result" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
            <span className={styles.compareLabel}>生成图</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={alt} className={`${styles.compareImage} ${imageLoaded ? styles.imageReady : styles.imageLoading}`} draggable={false}
              onLoad={() => { setImageLoaded(true); setImageError(false); }} onError={() => { setImageLoaded(false); setImageError(true); }}
              style={{ transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale})` }} />
          </div>
        </div> : <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={activeSrc}
            alt={activeAlt}
            className={`${styles.image} ${imageLoaded ? styles.imageReady : styles.imageLoading}`}
            draggable={false}
            onLoad={() => {
              setImageLoaded(true);
              setImageError(false);
            }}
            onError={() => {
              setImageLoaded(false);
              setImageError(true);
            }}
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
