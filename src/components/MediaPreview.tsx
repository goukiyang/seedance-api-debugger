'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Music2, RotateCcw, X } from 'lucide-react';
import ContentReactions from '@/components/content-reactions/ContentReactions';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import type { SafeImagePreviewDetails } from '@/components/ZoomableImagePreview';
import type { ImageReadCandidate } from '@/lib/hooks/use-image-neighbors';
import type { ContentKey } from '@/lib/content-reactions/types';
import { useMediaPreviewState } from '@/lib/hooks/use-media-preview-state';
import { isTopmostDialogLayer, useDialogDismiss } from '@/components/useDialogDismiss';
import styles from './MediaPreview.module.css';

export type MediaPreviewProps = {
  src: string;
  type: 'image' | 'video' | 'audio';
  title?: string;
  poster?: string;
  contentKey?: ContentKey;
  previewKey?: string;
  safeDetails?: SafeImagePreviewDetails;
  imageDownload?: () => void | Promise<unknown>;
  /** Caller-provided status/file metadata only; shared preview owns reactions. */
  details?: ReactNode;
  notice?: ReactNode;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  hasNavigation?: boolean;
  imageNeighbors?: ImageReadCandidate[];
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
        thumbnailSrc={props.poster}
        alt="图片预览"
        title={props.title}
        previewKey={props.previewKey}
        contentKey={props.contentKey}
        resolveDownload={src => src === props.src ? props.imageDownload : undefined}
        safeDetails={props.safeDetails}
        details={props.details}
        notice={props.notice}
        hasNavigation={props.hasNavigation}
        imageNeighbors={props.imageNeighbors}
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
  const mountPointRef = useRef<HTMLSpanElement>(null);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const errorProbeRef = useRef<AbortController | null>(null);
  const activeSourceRef = useRef(src);
  activeSourceRef.current = src;
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

  useDialogDismiss({
    open: Boolean(portalRoot),
    dialogRef: backdropRef,
    dismissSurfaceRef: backdropRef,
    onDismiss: onClose,
    isDismissTarget: (target) => target === backdropRef.current || target === stageRef.current,
    initialFocusRef: backdropRef,
  });

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
    const dialog = mountPointRef.current?.closest('dialog[open]');
    try {
      setPortalRoot(dialog?.matches(':modal') ? dialog as HTMLElement : document.body);
    } catch {
      setPortalRoot(document.body);
    }
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
      if (!isTopmostDialogLayer(backdropRef.current)) return;
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
  }, [hasNavigation, onNext, onPrevious]);

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
      onClick={event => {
        event.stopPropagation();
        if (event.detail === 0 && event.target === event.currentTarget && isTopmostDialogLayer(backdropRef.current)) onClose();
      }}
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

  return <>
    <span ref={mountPointRef} hidden aria-hidden="true" />
    {portalRoot ? createPortal(preview, portalRoot) : null}
  </>;
}
