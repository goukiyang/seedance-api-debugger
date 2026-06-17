'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent, WheelEvent } from 'react';
import { createPortal } from 'react-dom';
import { RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import styles from './ZoomableImagePreview.module.css';

type ZoomableImagePreviewProps = {
  src: string;
  alt: string;
  fileName?: string;
  onClose: () => void;
};

const MIN_SCALE = 0.5;
const MAX_SCALE = 6;
const SCALE_STEP = 1.2;

function clampScale(value: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

export function ZoomableImagePreview({ src, alt, fileName, onClose }: ZoomableImagePreviewProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);

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
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === '+' || event.key === '=') zoomAtCenter(SCALE_STEP);
      if (event.key === '-') zoomAtCenter(1 / SCALE_STEP);
      if (event.key === '0') resetView();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, resetView, zoomAtCenter]);

  useEffect(() => {
    resetView();
    setImageLoaded(false);
    setImageError(false);
  }, [resetView, src]);

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
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

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

  const preview = (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label="参考图预览"
      onClick={handleBackdropClick}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className={styles.toolbar}>
        <div className={styles.title}>
          <strong>{fileName || alt}</strong>
          <span>{imageError ? '加载失败' : imageLoaded ? `${Math.round(scale * 100)}%` : '加载中...'}</span>
        </div>
        <div className={styles.actions}>
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
        aria-busy={!imageLoaded && !imageError}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onAuxClick={(event) => event.preventDefault()}
        onDoubleClick={() => {
          if (scale > 1) resetView();
          else zoomAtCenter(2);
        }}
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
        <img
          src={src}
          alt={alt}
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
      </div>
    </div>
  );

  if (!portalRoot) return null;
  return createPortal(preview, portalRoot);
}
