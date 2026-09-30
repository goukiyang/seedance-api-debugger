'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Music2, RotateCcw, X } from 'lucide-react';
import ContentReactions from '@/components/content-reactions/ContentReactions';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import type { SafeImagePreviewDetails } from '@/components/ZoomableImagePreview';
import type { ContentKey } from '@/lib/content-reactions/types';
import { useMediaPreviewState } from '@/lib/hooks/use-media-preview-state';
import styles from './MediaPreview.module.css';

export type MediaPreviewProps = {
  src: string;
  type: 'image' | 'video' | 'audio';
  title?: string;
  poster?: string;
  contentKey?: ContentKey;
  previewKey?: string;
  safeDetails?: SafeImagePreviewDetails;
  /** Caller-provided status/reactions/file metadata only; remove prompts before passing. */
  details?: ReactNode;
  notice?: ReactNode;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  hasNavigation?: boolean;
};

function mediaErrorMessage(code: number | undefined, mediaName: string) {
  if (code === 1) return `${mediaName}读取被中断，可以重试。`;
  if (code === 2) return `${mediaName}网络连接失败，可以重试。`;
  if (code === 3) return `${mediaName}解码失败，可以重试。`;
  if (code === 4) return `${mediaName}格式或地址不受支持。`;
  return `无法读取${mediaName}，可以重试。`;
}

export default function MediaPreview(props: MediaPreviewProps) {
  if (props.type === 'image') {
    return (
      <ZoomableImagePreview
        src={props.src}
        alt="图片预览"
        title={props.title}
        previewKey={props.previewKey}
        contentKey={props.contentKey}
        safeDetails={props.safeDetails}
        details={props.details}
        notice={props.notice}
        hasNavigation={props.hasNavigation}
        onPrevious={props.onPrevious}
        onNext={props.onNext}
        onClose={props.onClose}
      />
    );
  }
  return <MediaFilePreview {...props} type={props.type} />;
}

function MediaFilePreview({
  src,
  type,
  poster,
  contentKey,
  previewKey,
  details,
  notice,
  onClose,
  onPrevious,
  onNext,
  hasNavigation,
}: MediaPreviewProps & { type: 'video' | 'audio' }) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const errorProbeRef = useRef<AbortController | null>(null);
  const activeSourceRef = useRef(src);
  activeSourceRef.current = src;
  const backgroundClickRef = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  const interactedRef = useRef(false);
  const restoredKeyRef = useRef<string | null>(null);
  const previewState = useMediaPreviewState(previewKey, contentKey, src);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(Boolean(src.trim()));
  const [loadError, setLoadError] = useState<string | null>(src.trim() ? null : '没有可用的媒体地址。');
  const lastPreviewStateKeyRef = useRef<string | null>(null);
  const mediaName = type === 'video' ? '视频' : '音频';
  const titleText = type === 'video' ? '视频预览' : '音频预览';

  const classifyMediaError = useCallback(async (media: HTMLVideoElement | HTMLAudioElement) => {
    if (activeSourceRef.current !== src) return;
    if (!src.trim()) {
      setLoadError('没有可用的媒体地址。');
      return;
    }
    errorProbeRef.current?.abort();
    const controller = new AbortController();
    errorProbeRef.current = controller;
    setLoadError(mediaErrorMessage(media.error?.code, mediaName));
    try {
      const url = new URL(src, window.location.href);
      if (url.origin !== window.location.origin) return;
      const response = await fetch(url, {
        method: 'HEAD',
        mode: 'same-origin',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'manual',
        signal: controller.signal,
      });
      if (controller.signal.aborted || errorProbeRef.current !== controller || activeSourceRef.current !== src) return;
      if (response.status === 401) setLoadError('登录状态已失效，请重新登录后重试。');
      else if (response.status === 403) setLoadError('当前账号无权查看这个媒体文件。');
      else if (response.status === 404) setLoadError('媒体文件已不存在或链接已失效。');
    } catch {
      // Native media error details remain the fallback when a HEAD probe is unavailable.
    } finally {
      if (errorProbeRef.current === controller) errorProbeRef.current = null;
    }
  }, [mediaName, src]);

  const clearMediaError = useCallback(() => {
    errorProbeRef.current?.abort();
    errorProbeRef.current = null;
    setLoadError(null);
  }, []);

  const restorePosition = useCallback(() => {
    const media = mediaRef.current;
    if (!media || !previewState.ready || !previewState.key || media.readyState < 1
      || restoredKeyRef.current === previewState.key || interactedRef.current) return;
    restoredKeyRef.current = previewState.key;
    media.pause();
    const duration = media.duration;
    const savedTime = previewState.value.currentTime;
    const safeTime = Number.isFinite(duration) && duration > 0
      ? Math.min(savedTime, Math.max(0, duration - 0.1))
      : savedTime;
    if (safeTime > 0) media.currentTime = safeTime;
  }, [previewState.key, previewState.ready, previewState.value.currentTime]);

  useEffect(() => {
    const previousKey = lastPreviewStateKeyRef.current;
    if (previousKey && previousKey !== previewState.key) {
      interactedRef.current = false;
      restoredKeyRef.current = null;
      const media = mediaRef.current;
      if (media) {
        media.pause();
        media.currentTime = 0;
      }
    }
    lastPreviewStateKeyRef.current = previewState.key;
  }, [previewState.key]);

  useEffect(() => {
    setPortalRoot(document.body);
  }, []);

  useEffect(() => {
    const root = backdropRef.current;
    const toolbar = toolbarRef.current;
    if (!root || !toolbar) return;
    const measure = () => root.style.setProperty('--media-toolbar-height', `${Math.ceil(toolbar.getBoundingClientRect().height)}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [portalRoot]);

  useEffect(() => {
    if (!portalRoot) return;
    const active = document.activeElement;
    const focused = active instanceof HTMLElement ? active : null;
    const elements = [document.documentElement, document.body];
    const previous = elements.map(element => ({ overflow: element.style.overflow, overscrollBehavior: element.style.overscrollBehavior }));
    elements.forEach(element => {
      element.style.overflow = 'hidden';
      element.style.overscrollBehavior = 'none';
    });
    const focusFrame = window.requestAnimationFrame(() => backdropRef.current?.focus({ preventScroll: true }));
    return () => {
      window.cancelAnimationFrame(focusFrame);
      elements.forEach((element, index) => {
        element.style.overflow = previous[index].overflow;
        element.style.overscrollBehavior = previous[index].overscrollBehavior;
      });
      if (focused?.isConnected) focused.focus({ preventScroll: true });
    };
  }, [portalRoot]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!portalRoot || !media) return;
    return () => {
      errorProbeRef.current?.abort();
      errorProbeRef.current = null;
      media.pause();
      media.removeAttribute('src');
      if (media instanceof HTMLVideoElement) media.removeAttribute('poster');
      try {
        media.load();
      } catch {
        // Some browsers reject load() after the media element has been detached.
      }
    };
  }, [attempt, portalRoot, src, type]);

  useEffect(() => {
    restoredKeyRef.current = null;
    interactedRef.current = false;
    setLoadError(src.trim() ? null : '没有可用的媒体地址。');
    setLoading(Boolean(src.trim()));
  }, [src, type]);

  useEffect(() => {
    restorePosition();
  }, [attempt, restorePosition, src, type]);

  useEffect(() => {
    if (!previewState.ready || !previewState.key || !mediaRef.current) return;
    restorePosition();
  }, [previewState.key, previewState.ready, restorePosition]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const focusable = Array.from(backdropRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, video[controls], audio[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])',
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
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), button, a[href], summary, video[controls], audio[controls]')) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const navigate = event.key === 'ArrowLeft' ? onPrevious : onNext;
      if (!hasNavigation || !navigate) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      navigate();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [hasNavigation, onClose, onNext, onPrevious]);

  const handleBackdropClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.target === event.currentTarget) onClose();
  }, [onClose]);

  const handleStagePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    backgroundClickRef.current = (event.pointerType === 'touch' || event.button === 0) && event.target === event.currentTarget
      ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
      : null;
  }, []);

  const handleStagePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const candidate = backgroundClickRef.current;
    if (candidate?.pointerId === event.pointerId && Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) > 5) {
      candidate.moved = true;
    }
  }, []);

  const handleStagePointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const candidate = backgroundClickRef.current;
    backgroundClickRef.current = null;
    if (!candidate || candidate.pointerId !== event.pointerId || event.type !== 'pointerup' || candidate.moved
      || Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) > 5) return;
    if (document.elementFromPoint(event.clientX, event.clientY) === stageRef.current) onClose();
  }, [onClose]);

  const resetPlayback = useCallback(() => {
    interactedRef.current = true;
    const media = mediaRef.current;
    if (media) {
      media.pause();
      media.currentTime = 0;
    }
    previewState.reset();
  }, [previewState.reset]);

  const handleTimeUpdate = useCallback((currentTime: number) => {
    previewState.update({ currentTime });
  }, [previewState.update]);

  const visibleError = loadError || (!src.trim() ? '没有可用的媒体地址。' : null);

  const preview = (
    <div
      ref={backdropRef}
      className={styles.backdrop}
      data-media-preview="sd2-media-preview"
      role="dialog"
      aria-modal="true"
      aria-label={titleText}
      tabIndex={-1}
      onClick={handleBackdropClick}
      onPointerDown={event => event.stopPropagation()}
      onPointerMove={event => event.stopPropagation()}
      onPointerUp={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
      onContextMenu={event => event.preventDefault()}
    >
      <div ref={toolbarRef} className={styles.toolbar}>
        <div className={styles.leading}>
          {contentKey && <ContentReactions contentKey={contentKey} />}
          <strong className={styles.title}>{titleText}</strong>
        </div>
        <div className={styles.actions}>
          {hasNavigation && onPrevious && <button type="button" onClick={onPrevious} title="上一项" aria-label="上一项"><ArrowLeft size={16} /></button>}
          {hasNavigation && onNext && <button type="button" onClick={onNext} title="下一项" aria-label="下一项"><ArrowRight size={16} /></button>}
          <button type="button" onClick={resetPlayback} title="回到开头" aria-label="重置播放位置"><RotateCcw size={16} /></button>
          <button type="button" onClick={onClose} title="关闭" aria-label="关闭预览"><X size={16} /></button>
        </div>
        {notice != null && <div className={styles.notice}>{notice}</div>}
        {details != null && <details className={styles.detailDisclosure}>
          <summary>详情</summary>
          <div className={styles.detailContent}>{details}</div>
        </details>}
      </div>

      <div
        ref={stageRef}
        className={`${styles.stage} ${type === 'audio' ? styles.audioStage : ''}`}
        onPointerDown={handleStagePointerDown}
        onPointerMove={handleStagePointerMove}
        onPointerUp={handleStagePointerEnd}
        onPointerCancel={handleStagePointerEnd}
      >
        {type === 'video' ? (
          /* eslint-disable-next-line jsx-a11y/media-has-caption */
          <video
            key={`${src}:${attempt}`}
            ref={mediaRef as RefObject<HTMLVideoElement>}
            className={styles.video}
            src={src.trim() ? src : undefined}
            poster={poster || undefined}
            controls
            playsInline
            preload="metadata"
            aria-label={titleText}
            onLoadStart={() => { setLoading(true); clearMediaError(); }}
            onLoadedMetadata={event => { setLoading(false); clearMediaError(); restorePosition(); }}
            onCanPlay={() => { setLoading(false); clearMediaError(); }}
            onError={event => { setLoading(false); void classifyMediaError(event.currentTarget); }}
            onPlay={() => { interactedRef.current = true; }}
            onSeeking={() => { interactedRef.current = true; }}
            onTimeUpdate={event => handleTimeUpdate(event.currentTarget.currentTime)}
            onEnded={() => handleTimeUpdate(0)}
          />
        ) : (
          <div className={styles.audioShell}>
            <Music2 aria-hidden="true" className={styles.audioMark} size={30} />
            <strong>{titleText}</strong>
            <audio
              key={`${src}:${attempt}`}
              ref={mediaRef as RefObject<HTMLAudioElement>}
              className={styles.audio}
              src={src.trim() ? src : undefined}
              controls
              preload="metadata"
              aria-label={titleText}
              onLoadStart={() => { setLoading(true); clearMediaError(); }}
              onLoadedMetadata={event => { setLoading(false); clearMediaError(); restorePosition(); }}
              onCanPlay={() => { setLoading(false); clearMediaError(); }}
              onError={event => { setLoading(false); void classifyMediaError(event.currentTarget); }}
              onPlay={() => { interactedRef.current = true; }}
              onSeeking={() => { interactedRef.current = true; }}
              onTimeUpdate={event => handleTimeUpdate(event.currentTarget.currentTime)}
              onEnded={() => handleTimeUpdate(0)}
            />
          </div>
        )}
        {loading && !visibleError && <div className={styles.status} role="status">正在读取{mediaName}…</div>}
        {visibleError && <div className={styles.error} role="alert">
          <span>{visibleError}</span>
          {src.trim() && <button type="button" onClick={() => { setLoading(true); setLoadError(null); setAttempt(value => value + 1); }}>
            <RotateCcw size={15} /> 重试读取
          </button>}
        </div>}
      </div>
    </div>
  );

  if (!portalRoot) return null;
  return createPortal(preview, portalRoot);
}
