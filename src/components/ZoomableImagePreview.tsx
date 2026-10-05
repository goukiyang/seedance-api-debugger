'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowLeftRight, ArrowRight, ArrowUpDown, Check, Copy, Image as ImageIcon, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { copyImage } from '@/lib/media/copy-image';
import styles from './ZoomableImagePreview.module.css';
import ContentReactions from '@/components/content-reactions/ContentReactions';
import type { ContentKey } from '@/lib/content-reactions/types';
import { useMediaPreviewState, type MediaPreviewZoomMode } from '@/lib/hooks/use-media-preview-state';
import { useImageReadProgress } from '@/lib/hooks/use-image-read-progress';
import { isTopmostDialogLayer, useDialogDismiss } from '@/components/useDialogDismiss';
import { RelativeTime } from '@/components/RelativeTime';

export type ImageComparisonSource = {
  src: string;
  alt: string;
  fileName?: string;
  thumbnailSrc?: string;
};

export type ImagePreviewMetadata = {
  /** Legacy input only. Never rendered by the preview. */
  context?: string;
  model?: string;
  quality?: string;
  ratio?: string;
  resolution?: string;
  time?: string;
};

export type SafeImagePreviewDetails = Omit<ImagePreviewMetadata, 'context'> & { width?: number; height?: number };

type ZoomableImagePreviewProps = {
  src: string;
  alt: string;
  fileName?: string;
  title?: string;
  previewKey?: string;
  contentKey?: ContentKey;
  metadata?: ImagePreviewMetadata;
  safeDetails?: SafeImagePreviewDetails;
  comparison?: ImageComparisonSource;
  /** Caller-provided status/reactions/file metadata only; remove prompts before passing. */
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

type IntrinsicSize = { width: number; height: number };

const IMAGE_PREVIEW_HISTORY_STATE_KEY = '__sd2ImagePreviewHistoryEntry';
let imagePreviewHistorySequence = 0;

type ImagePreviewHistorySession = {
  token: string;
  url: string;
  ownsEntry: boolean;
};

type ImagePreviewHistoryMarker = {
  token: string;
  url: string;
  active: boolean;
};

function getImagePreviewHistoryMarker(): ImagePreviewHistoryMarker | null {
  const state = window.history.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const marker = state[IMAGE_PREVIEW_HISTORY_STATE_KEY];
  if (!marker || typeof marker !== 'object'
    || typeof marker.token !== 'string'
    || typeof marker.url !== 'string'
    || typeof marker.active !== 'boolean') return null;
  return marker as ImagePreviewHistoryMarker;
}

function hasActiveImagePreviewHistoryEntry(token: string) {
  const marker = getImagePreviewHistoryMarker();
  return marker?.active === true && marker.token === token;
}

function writeImagePreviewHistoryMarker(marker: ImagePreviewHistoryMarker, replace = false) {
  const state = window.history.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  try {
    const nextState = { ...state, [IMAGE_PREVIEW_HISTORY_STATE_KEY]: marker };
    if (replace) window.history.replaceState(nextState, '');
    else window.history.pushState(nextState, '');
    return true;
  } catch {
    return false;
  }
}

function useImagePreviewHistoryDismiss<T extends HTMLElement>(open: boolean, dialogRef: RefObject<T>, onClose: () => void) {
  const instanceId = useId();
  const onCloseRef = useRef(onClose);
  const sessionRef = useRef<ImagePreviewHistorySession | null>(null);
  const effectGenerationRef = useRef(0);
  const closeRequestedRef = useRef(false);
  const closeCalledRef = useRef(false);
  onCloseRef.current = onClose;

  const closeOnce = useCallback(() => {
    if (closeCalledRef.current) return;
    closeCalledRef.current = true;
    if (sessionRef.current) sessionRef.current.ownsEntry = false;
    onCloseRef.current();
  }, []);

  useEffect(() => {
    const generation = ++effectGenerationRef.current;
    if (!open) {
      const inactiveSession = sessionRef.current;
      if (inactiveSession?.ownsEntry
        && inactiveSession.url === window.location.href
        && hasActiveImagePreviewHistoryEntry(inactiveSession.token)) {
        writeImagePreviewHistoryMarker({ token: inactiveSession.token, url: inactiveSession.url, active: false }, true);
      }
      sessionRef.current = null;
      closeRequestedRef.current = false;
      closeCalledRef.current = false;
      return undefined;
    }

    closeRequestedRef.current = false;
    closeCalledRef.current = false;
    let session = sessionRef.current;
    if (!session || !session.ownsEntry || !hasActiveImagePreviewHistoryEntry(session.token)) {
      const token = `${instanceId}:${++imagePreviewHistorySequence}`;
      const url = window.location.href;
      const existingMarker = getImagePreviewHistoryMarker();
      const reuseEntry = existingMarker?.active === false && existingMarker.url === url;
      const ownsEntry = writeImagePreviewHistoryMarker({ token, url, active: true }, reuseEntry);
      session = { token, url, ownsEntry };
      sessionRef.current = session;
    }

    const handlePopState = () => {
      const activeSession = sessionRef.current;
      if (!activeSession?.ownsEntry || closeCalledRef.current) return;
      if (hasActiveImagePreviewHistoryEntry(activeSession.token)) return;
      if (!isTopmostDialogLayer(dialogRef.current)) {
        if (activeSession.url === window.location.href) {
          activeSession.ownsEntry = writeImagePreviewHistoryMarker({ token: activeSession.token, url: activeSession.url, active: true });
        } else {
          activeSession.ownsEntry = false;
        }
        closeRequestedRef.current = false;
        return;
      }
      closeOnce();
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      // Let StrictMode replay this effect before marking its history entry inactive.
      queueMicrotask(() => {
        if (effectGenerationRef.current !== generation) return;
        const activeSession = sessionRef.current;
        if (!activeSession?.ownsEntry
          || activeSession.url !== window.location.href
          || !hasActiveImagePreviewHistoryEntry(activeSession.token)) return;
        if (writeImagePreviewHistoryMarker({ token: activeSession.token, url: activeSession.url, active: false }, true)) {
          activeSession.ownsEntry = false;
        }
      });
    };
  }, [closeOnce, dialogRef, instanceId, open]);

  return useCallback(() => {
    if (closeCalledRef.current || closeRequestedRef.current) return;
    const session = sessionRef.current;
    if (session?.ownsEntry
      && session.url === window.location.href
      && hasActiveImagePreviewHistoryEntry(session.token)) {
      closeRequestedRef.current = true;
      try {
        window.history.back();
        return;
      } catch {
        closeRequestedRef.current = false;
      }
    }
    closeOnce();
  }, [closeOnce]);
}

function safeImageLabel(title?: string, fileName?: string) {
  const trimmedTitle = title?.trim();
  if (trimmedTitle && /^(?:生成结果|图片预览)\s+\d{1,5}$/.test(trimmedTitle)) return trimmedTitle;
  const trimmedFileName = fileName?.trim();
  if (trimmedFileName && /^(?:IMG[_-]\d{3,10}|(?:image|output|result)[_-]\d{1,8})\.(?:png|jpe?g|webp|avif|gif)$/i.test(trimmedFileName)) return trimmedFileName;
  return '图片预览';
}

function safeMetadataValue(value?: string) {
  const text = value?.trim();
  if (!text || text.length > 32 || /[<>\r\n,;!?]/.test(text) || text.split(/\s+/).length > 3) return undefined;
  return text;
}

function safeMetadataTime(value?: string) {
  const text = value?.trim();
  if (!text || text.length > 32 || !/^[\d年月日时分秒TtZz:./+\- ]+$/.test(text)) return undefined;
  if (/^\d{4}-\d{2}-\d{2}T/i.test(text)) {
    const date = new Date(text);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : undefined;
  }
  return text;
}

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

function displaySource(src: string, mode: 'preview' | 'thumbnail' | 'original') {
  if (!/^\/api\/image-studio\/(?:assets|template-assets)\//.test(src)) return src;
  const url = new URL(src, 'https://sd2.youdooart.com');
  url.searchParams.delete('thumbnail');
  url.searchParams.delete('preview');
  if (mode !== 'original') url.searchParams.set(mode, '1');
  return `${url.pathname}${url.search}`;
}

function parseImageDimensions(value?: string): IntrinsicSize | undefined {
  const match = value?.trim().match(/^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i);
  if (!match) return undefined;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function formatImageBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

function PreviewImage({ src, alt, original, className, style, onReady }: { src: string; alt: string; original: boolean; className: string; style: CSSProperties; onReady?: (size: IntrinsicSize) => void }) {
  const image = useRef<HTMLImageElement>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const [attempt, setAttempt] = useState(0);
  const [loadedKey, setLoadedKey] = useState('');
  const [failedKey, setFailedKey] = useState('');
  const displaySrc = displaySource(src, original ? 'original' : 'preview');
  const thumbnail = displaySource(src, 'thumbnail');
  const key = `${displaySrc}:${attempt}`;
  const currentKeyRef = useRef(key);
  currentKeyRef.current = key;
  const readResult = useImageReadProgress(displaySrc, attempt);
  const readProgress = readResult.progress;
  const imageSrc = readResult.imageSrc || undefined;
  const loaded = loadedKey === key;
  const unsupported = readProgress.phase === 'unsupported';
  const failed = failedKey === key || unsupported;
  useEffect(() => {
    if (loaded || unsupported) return;
    if (image.current?.complete && image.current.naturalWidth > 0) {
      setLoadedKey(key);
      onReadyRef.current?.({ width: image.current.naturalWidth, height: image.current.naturalHeight });
      return;
    }
    if (readProgress.phase === 'reading') return;
    const timer = window.setTimeout(() => setFailedKey(key), 30000);
    return () => window.clearTimeout(timer);
  }, [key, loaded, readProgress.phase, unsupported]);
  const progressLabel = readProgress.phase === 'unsupported'
    ? readProgress.message || '该来源不是图片，未读取文件内容'
    : readProgress.phase === 'unavailable'
      ? readProgress.message || '当前来源无法提供读取进度'
      : readProgress.phase === 'decoding' ? '正在解码' : '正在读取';
  return <>
    {thumbnail !== src && !loaded && <img src={thumbnail} alt="" aria-hidden="true" className={className} style={style} draggable={false} />}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {imageSrc && <img ref={image} key={key} src={imageSrc} alt={alt} className={className} style={{ ...style, opacity: loaded ? 1 : 0 }} draggable={false} data-image-preview-image
      onLoad={event => { if (currentKeyRef.current !== key) return; setLoadedKey(key); setFailedKey(''); onReadyRef.current?.({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); }} onError={() => { if (currentKeyRef.current === key) setFailedKey(key); }} />}
    {!loaded && <div className={styles.imageStatus} role="status">
      <span>{failed ? (unsupported ? progressLabel : '图片未能加载') : `${alt} · ${original ? '完整原图' : '高清预览'} · ${progressLabel}`}</span>
      {failed && !unsupported && readProgress.phase === 'unavailable' && <span>{readProgress.message || '当前来源无法提供读取进度'}</span>}
      {!failed && readProgress.phase === 'reading' && readProgress.percent != null && <>
        <progress className={styles.imageProgress} max={100} value={readProgress.percent} aria-label={`${alt}读取进度 ${readProgress.percent}%`} />
        {readProgress.totalBytes != null && <span>{readProgress.percent}% · {formatImageBytes(readProgress.loadedBytes)} / {formatImageBytes(readProgress.totalBytes)}</span>}
      </>}
      {!failed && readProgress.phase === 'reading' && readProgress.percent == null && <span>已读取 {formatImageBytes(readProgress.loadedBytes)}</span>}
      {!failed && readProgress.phase === 'decoding' && <span>已读取 {formatImageBytes(readProgress.loadedBytes)}</span>}
      {failed && !unsupported && <button type="button" title="重新加载" aria-label="重新加载图片" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setAttempt(value => value + 1); }}><RotateCcw size={16} /></button>}
    </div>}
  </>;
}

export function ZoomableImagePreview({ src, fileName, title, previewKey, contentKey, metadata, safeDetails, comparison, details, notice, hasNavigation, onPrevious, onNext, onClose }: ZoomableImagePreviewProps) {
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
  const portalAnchorRef = useRef<HTMLSpanElement>(null);
  const [zoomMode, setZoomMode] = useState<MediaPreviewZoomMode>('fit');
  const [showOriginal, setShowOriginal] = useState(false);
  const [comparisonMode, setComparisonMode] = useState(false);
  const [comparisonAxis, setComparisonAxis] = useState<'horizontal' | 'vertical'>('horizontal');
  const [showReference, setShowReference] = useState(false);
  const [copyState, setCopyState] = useState<{ src: string; busy?: boolean; message?: string; success?: boolean } | null>(null);
  const [dimensionsBySource, setDimensionsBySource] = useState<Record<string, IntrinsicSize>>({});
  const dimensionsTooltipId = useId();
  const dismissPreview = useImagePreviewHistoryDismiss(Boolean(portalRoot), backdropRef, onClose);

  useDialogDismiss({
    open: Boolean(portalRoot),
    dialogRef: backdropRef,
    dismissSurfaceRef: backdropRef,
    onDismiss: dismissPreview,
    initialFocusRef: backdropRef,
    isDismissTarget: (target) => {
      if (target === backdropRef.current || target === stageRef.current) return true;
      const element = target instanceof Element ? target : null;
      const pane = element?.closest('[data-image-preview-pane]');
      if (!pane || !stageRef.current?.contains(pane)) return false;
      return !element?.closest('[data-image-preview-image], button, a[href], input, textarea, select, summary');
    },
  });

  const activeSrc = showReference && comparison ? comparison.src : src;
  const generatedComparisonThumbnail = comparison ? displaySource(comparison.src, 'thumbnail') : undefined;
  const comparisonThumbnail = comparison?.thumbnailSrc && comparison.thumbnailSrc !== comparison.src
    ? comparison.thumbnailSrc
    : generatedComparisonThumbnail !== comparison?.src ? generatedComparisonThumbnail : undefined;
  const imageTitle = safeImageLabel(title, fileName);
  const activeAlt = showReference && comparison ? '参考图' : imageTitle;

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
    const nativeDialog = portalAnchorRef.current?.closest('dialog[open]');
    try {
      setPortalRoot(nativeDialog?.matches(':modal') ? nativeDialog as HTMLElement : document.body);
    } catch {
      setPortalRoot(document.body);
    }
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
    const elements = [document.documentElement, document.body];
    const previous = elements.map(element => ({ overflow: element.style.overflow, overscrollBehavior: element.style.overscrollBehavior }));
    elements.forEach(element => {
      element.style.overflow = 'hidden';
      element.style.overscrollBehavior = 'none';
    });
    return () => {
      elements.forEach((element, index) => {
        element.style.overflow = previous[index].overflow;
        element.style.overscrollBehavior = previous[index].overscrollBehavior;
      });
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostDialogLayer(backdropRef.current)) return;
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
  }, [hasNavigation, onNext, onPrevious, resetView, zoomFromControls]);

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
      if (!isTopmostDialogLayer(backdropRef.current)
        || !(event.target instanceof Node) || !stageRef.current?.contains(event.target)) return;
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
      if (closeFromBackground && isTopmostDialogLayer(backdropRef.current)) dismissPreview();
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
    if (closeFromBackground && isTopmostDialogLayer(backdropRef.current)) dismissPreview();
  }, [dismissPreview, scale]);

  const comparisonLayoutLabel = comparisonAxis === 'horizontal' ? '左右' : '上下';
  const handleImageReady = useCallback((imageSrc: string) => (size: IntrinsicSize) => {
    setDimensionsBySource(current => current[imageSrc]?.width === size.width && current[imageSrc]?.height === size.height
      ? current
      : { ...current, [imageSrc]: size });
    if (imageSrc === (comparisonMode ? src : activeSrc) && (zoomMode === 'width' || zoomMode === 'actual')) applyZoomMode(zoomMode, false);
  }, [activeSrc, applyZoomMode, comparisonMode, src, zoomMode]);

  const visibleMetadata = {
    model: safeMetadataValue(safeDetails?.model ?? metadata?.model),
    quality: safeMetadataValue(safeDetails?.quality ?? metadata?.quality),
    ratio: safeMetadataValue(safeDetails?.ratio ?? metadata?.ratio),
    resolution: safeMetadataValue(safeDetails?.resolution ?? metadata?.resolution),
    time: safeMetadataTime(safeDetails?.time ?? metadata?.time),
  };
  const rawMetadataTime = safeDetails?.time ?? metadata?.time;
  const validMetadataTime = rawMetadataTime && Number.isFinite(Date.parse(rawMetadataTime));
  const dimensionsSource = comparisonMode ? src : activeSrc;
  const suppliedDimensions = dimensionsSource !== src ? undefined : safeDetails?.width && safeDetails.height && safeDetails.width > 0 && safeDetails.height > 0
    ? { width: safeDetails.width, height: safeDetails.height }
    : parseImageDimensions(safeDetails?.resolution ?? metadata?.resolution);
  const measuredDimensions = dimensionsBySource[dimensionsSource];
  const sourceUsesResizedPreview = /^\/api\/image-studio\/(?:assets|template-assets)\//.test(dimensionsSource) && !showOriginal;
  const visibleDimensions = suppliedDimensions || (!sourceUsesResizedPreview ? measuredDimensions : undefined);
  const hasVisibleMetadata = Object.values(visibleMetadata).some(Boolean) || Boolean(visibleDimensions);

  const preview = (
    <div
      ref={backdropRef}
      className={styles.backdrop}
      data-media-preview="sd2-media-preview"
      role="dialog"
      aria-modal="true"
      aria-label={imageTitle}
      tabIndex={-1}
      onClick={(event) => {
        event.stopPropagation();
        if (event.detail === 0 && event.target === event.currentTarget && isTopmostDialogLayer(backdropRef.current)) dismissPreview();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onMouseMove={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div ref={toolbarRef} className={styles.toolbar} data-has-comparison={comparison ? 'true' : undefined} data-has-metadata={hasVisibleMetadata ? 'true' : undefined}>
        <div className={styles.leading}>
          {contentKey && <ContentReactions contentKey={contentKey} imageSharing={!showReference || comparisonMode} />}
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
            {comparisonThumbnail
              ? <img src={comparisonThumbnail} alt="" aria-hidden="true" draggable={false} />
              : <ImageIcon className={styles.referenceThumbFallback} size={18} aria-hidden="true" />}
          </button>}
          <div className={styles.title}>
            <strong>{imageTitle}</strong>
            <span>{comparisonMode ? `${comparisonLayoutLabel}对比 · ` : ''}{Math.round(scale * 100)}%</span>
          </div>
        </div>
        {comparison && <div className={styles.comparisonActions}>
          <button type="button" data-image-preview-compare aria-pressed={comparisonMode} onClick={() => { interactedRef.current = true; setComparisonMode(current => !current); resetView(); }} title={comparisonMode ? '退出对比' : '对比参考图'} aria-label={comparisonMode ? '退出对比' : '对比参考图'}>
            <ArrowLeftRight size={16} /><span className={styles.actionLabel}>对比</span>
          </button>
          {comparisonMode && <button type="button" data-image-preview-direction onClick={() => { interactedRef.current = true; setComparisonAxis(current => current === 'horizontal' ? 'vertical' : 'horizontal'); resetView(); }} title={comparisonAxis === 'horizontal' ? '切换上下对比' : '切换左右对比'} aria-label={comparisonAxis === 'horizontal' ? '切换上下对比' : '切换左右对比'}>
            {comparisonAxis === 'horizontal' ? <ArrowUpDown size={16} /> : <ArrowLeftRight size={16} />}<span className={styles.actionLabel}>{comparisonLayoutLabel}</span>
          </button>}
        </div>}
        <div className={styles.actions}>
          <button type="button" disabled={copyState?.busy} title="复制图片" aria-label="复制图片" onClick={() => {
            const copySrc = displaySource(comparisonMode ? src : activeSrc, showOriginal ? 'original' : 'preview');
            setCopyState({ src: copySrc, busy: true, message: '正在复制图片…' });
            void copyImage(copySrc).then(() => setCopyState({ src: copySrc, success: true, message: '图片已复制' }))
              .catch(error => setCopyState({ src: copySrc, message: error instanceof Error && error.name !== 'NotAllowedError' ? error.message : '浏览器未允许复制，请使用图片右键菜单' }));
          }}>{copyState?.success && copyState.src === displaySource(comparisonMode ? src : activeSrc, showOriginal ? 'original' : 'preview') ? <Check size={16} /> : <Copy size={16} />}</button>
          {displaySource(activeSrc, 'preview') !== displaySource(activeSrc, 'original') && <button type="button" aria-pressed={showOriginal} onClick={() => { interactedRef.current = true; setShowOriginal(value => !value); }} title={showOriginal ? '切换高清预览' : '加载完整原图'}><span className={styles.actionLabel}>{showOriginal ? '原图' : '高清预览'}</span></button>}
          {hasNavigation && onPrevious && <button type="button" onClick={onPrevious} title="上一张" aria-label="上一张生成图片"><ArrowLeft size={16} /></button>}
          {hasNavigation && onNext && <button type="button" onClick={onNext} title="下一张" aria-label="下一张生成图片"><ArrowRight size={16} /></button>}
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
          <button type="button" onClick={dismissPreview} title="关闭" aria-label="关闭预览">
            <X size={16} />
          </button>
        </div>
        {hasVisibleMetadata && <div className={styles.metadata}>
          <div className={styles.metadataValues}>
            {visibleMetadata.model && <span>{visibleMetadata.model}</span>}
            {visibleMetadata.quality && <span>{visibleMetadata.quality}</span>}
            {visibleMetadata.ratio && <span>{visibleMetadata.ratio}</span>}
            {(visibleMetadata.resolution || visibleDimensions) && <span className={styles.dimensionHint}>
              <span tabIndex={0} aria-describedby={dimensionsTooltipId}>
                {visibleMetadata.resolution && !parseImageDimensions(visibleMetadata.resolution) ? visibleMetadata.resolution : '尺寸'}
              </span>
              <span id={dimensionsTooltipId} className={styles.dimensionTooltip} role="tooltip">{visibleDimensions ? `原始尺寸：${visibleDimensions.width} × ${visibleDimensions.height} 像素` : '原始尺寸暂不可用'}</span>
            </span>}
          </div>
          {visibleMetadata.time && <span className={styles.metadataTime}>
            {validMetadataTime ? <RelativeTime value={rawMetadataTime!} /> : visibleMetadata.time}
          </span>}
        </div>}
        {copyState?.message && copyState.src === displaySource(comparisonMode ? src : activeSrc, showOriginal ? 'original' : 'preview') && <div className={styles.notice} role="status">{copyState.message}</div>}
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
        onContextMenu={(event) => event.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {comparison && comparisonMode ? <div className={`${styles.compareFrame} ${comparisonAxis === 'vertical' ? styles.compareVertical : styles.compareHorizontal}`} data-image-preview-compare-frame>
          <div className={styles.comparePane} data-image-preview-pane="reference">
            <span className={styles.compareLabel}>参考图</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <PreviewImage src={comparison.src} alt="参考图" original={showOriginal} className={styles.compareImage}
              style={{ transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale})` }} />
          </div>
          <div className={styles.comparePane} data-image-preview-pane="result">
            <span className={styles.compareLabel}>生成图</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <PreviewImage src={src} alt="生成图" original={showOriginal} className={styles.compareImage}
              style={{ transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale})` }} onReady={handleImageReady(src)} />
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
            onReady={handleImageReady(activeSrc)}
          />
        </>}
      </div>
    </div>
  );

  return <>
    <span ref={portalAnchorRef} hidden />
    {portalRoot && createPortal(preview, portalRoot)}
  </>;
}
