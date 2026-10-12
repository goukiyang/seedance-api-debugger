'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LoaderCircle, Pause, Play, RotateCcw } from 'lucide-react';
import { useMediaPreviewState } from '@/lib/hooks/use-media-preview-state';
import type { ContentKey } from '@/lib/content-reactions/types';
import { ASSET_HOVER_DWELL_MS, releaseAssetMediaSource, settleAssetHoverPlay, type AssetPlaybackBoundary, type AssetPlaybackLease, type ReleaseAssetHover } from '@/lib/media/asset-playback';
import styles from './InlineVideoCover.module.css';

type InlineVideoCoverBase = { src: string | null; title: string; children: ReactNode };

type ClickInlineVideoCoverProps = InlineVideoCoverBase & {
  interaction?: 'click'; contentKey: ContentKey; active: boolean;
  onActivate: () => void; onPause: () => void; children: ReactNode;
};

type HoverInlineVideoCoverProps = InlineVideoCoverBase & {
  interaction: 'hover'; assetKey: string; contextKey: string; disabled?: boolean;
  onHoverStart: (key: string, src: string, media: HTMLVideoElement, release: ReleaseAssetHover) => AssetPlaybackLease | null;
  isHoverCurrent: (lease: AssetPlaybackLease, key: string, src: string, media: HTMLVideoElement) => boolean;
  onHoverStop: (lease: AssetPlaybackLease, key: string, src: string, media: HTMLVideoElement, reason: AssetPlaybackBoundary) => void;
};

type InlineVideoCoverProps = ClickInlineVideoCoverProps | HoverInlineVideoCoverProps;

export function InlineVideoCover(props: InlineVideoCoverProps) {
  if (props.interaction === 'hover') return <HoverVideoCover {...props} />;
  return <ClickVideoCover {...props} />;
}

function ClickVideoCover({ src, contentKey, title, active, onActivate, onPause, children }: ClickInlineVideoCoverProps) {
  const video = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const restored = useRef(false);
  const playRequested = useRef(false);
  const playSequence = useRef(0);
  const state = useMediaPreviewState(contentKey, contentKey, src || undefined);
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => { if (!active) { playSequence.current += 1; playRequested.current = false; setStarting(false); video.current?.pause(); } }, [active]);
  useEffect(() => {
    const media = video.current;
    return () => { playSequence.current += 1; if (media) { stateRef.current.update({ currentTime: media.currentTime }); media.pause(); } };
  }, [src]);
  async function toggle() {
    const media = video.current;
    if (!media || !src) return;
    if (playRequested.current) { playSequence.current += 1; playRequested.current = false; setStarting(false); media.pause(); onPause(); return; }
    if (!media.paused) { media.pause(); onPause(); return; }
    setError(''); onActivate(); setStarted(true);
    playRequested.current = true;
    setStarting(true);
    const sequence = ++playSequence.current;
    try { await media.play(); }
    catch { if (sequence === playSequence.current) { setError('视频未能播放，点击重试或使用查看按钮。'); onPause(); } }
    finally { if (sequence === playSequence.current) { playRequested.current = false; setStarting(false); } }
  }
  return <span className={styles.stage} data-playing={playing || undefined} data-starting={starting || undefined} data-error={Boolean(error) || undefined} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <span className={styles.poster} hidden={started && !error}>{children}</span>
    {src && <video ref={video} src={src} playsInline preload="none" muted className={styles.video} hidden={!started || Boolean(error)}
      onLoadedMetadata={event => {
        const saved = stateRef.current;
        if (!restored.current && saved.ready && Number.isFinite(event.currentTarget.duration)) {
          restored.current = true;
          event.currentTarget.currentTime = Math.min(saved.value.currentTime, Math.max(0, event.currentTarget.duration - 0.1));
        }
      }}
      onTimeUpdate={event => stateRef.current.update({ currentTime: event.currentTarget.currentTime })}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); onPause(); }}
      onError={() => { setError('视频地址暂不可用，点击重试或使用查看按钮。'); onPause(); }} />}
    <button type="button" className={styles.toggle} aria-busy={starting} aria-label={`${starting ? '取消等待播放' : playing ? '暂停' : error ? '重试播放' : '播放'}${title}`}
      disabled={!src} onClick={event => { event.stopPropagation(); if (error) video.current?.load(); void toggle(); }}>
      <span className={styles.icon}>{starting ? <LoaderCircle size={22} className={styles.spinner} /> : error ? <RotateCcw size={22} /> : playing ? <Pause size={22} /> : <Play size={22} />}</span>
    </button>
    {(!src || error) && <span className={styles.notice} role="status">{error || '暂无可播放视频，详情请点查看'}</span>}
  </span>;
}

function canHoverPreview() {
  return typeof window !== 'undefined'
    && typeof document !== 'undefined'
    && document.visibilityState !== 'hidden'
    && window.matchMedia('(hover: hover) and (pointer: fine)').matches
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function HoverVideoCover({ src, title, children, assetKey, contextKey, disabled = false, onHoverStart, isHoverCurrent, onHoverStop }: HoverInlineVideoCoverProps) {
  const stage = useRef<HTMLSpanElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lease = useRef<AssetPlaybackLease | null>(null);
  const previousContextKey = useRef(contextKey);
  const mounted = useRef(false);
  const pointerInside = useRef(false);
  const visible = useRef(false);
  const generation = useRef(0);
  const cancelFrameWatch = useRef<(() => void) | null>(null);
  const sourceContext = useRef({ src, assetKey, contextKey, disabled });
  sourceContext.current = { src, assetKey, contextKey, disabled };
  const [active, setActive] = useState(false);
  const [frameReady, setFrameReady] = useState(false);
  const [error, setError] = useState(false);

  const cleanup = (reason: AssetPlaybackBoundary) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    generation.current += 1;
    cancelFrameWatch.current?.();
    // Cover the still-present video synchronously, before removing its source.
    stage.current?.setAttribute('data-frame-ready', 'false');
    if (mounted.current) setFrameReady(false);
    lease.current = null;
    pointerInside.current = false;
    const media = video.current;
    if (media) releaseAssetMediaSource(media);
    if (mounted.current) {
      setActive(false);
      if (reason !== 'error') setError(false);
    }
  };

  const cleanupRef = useRef(cleanup);
  cleanupRef.current = cleanup;

  const stop = (reason: AssetPlaybackBoundary, capturedMedia: HTMLVideoElement | null = video.current) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const currentLease = lease.current;
    const media = capturedMedia;
    if (currentLease !== null && media && src) {
      onHoverStop(currentLease, assetKey, src, media, reason);
      if (lease.current === currentLease) cleanupRef.current(reason);
      return;
    }
    cleanupRef.current(reason);
  };

  const stopRef = useRef(stop);
  stopRef.current = stop;

  const start = () => {
    if (!mounted.current || disabled || !src || !visible.current || !pointerInside.current || !canHoverPreview() || lease.current !== null) return;
    const media = video.current;
    if (!media) return;
    setError(false);
    const nextLease = onHoverStart(assetKey, src, media, reason => cleanupRef.current(reason));
    if (nextLease === null) return;
    generation.current += 1;
    stage.current?.setAttribute('data-frame-ready', 'false');
    setFrameReady(false);
    lease.current = nextLease;
    setActive(true);
  };

  const startRef = useRef(start);
  startRef.current = start;

  const arm = () => {
    if (disabled || !src || !visible.current || !pointerInside.current || !canHoverPreview() || lease.current !== null || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      startRef.current();
    }, ASSET_HOVER_DWELL_MS);
  };

  const armRef = useRef(arm);
  armRef.current = arm;

  useEffect(() => {
    const media = video.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopRef.current('unmount', media);
      if (media) releaseAssetMediaSource(media);
    };
  }, []);

  useEffect(() => {
    stopRef.current('source');
  }, [src]);

  useEffect(() => {
    if (previousContextKey.current === contextKey) return;
    previousContextKey.current = contextKey;
    stopRef.current('filter');
  }, [contextKey]);

  useEffect(() => {
    if (disabled) stopRef.current('selection');
  }, [disabled]);

  useEffect(() => {
    const stage = video.current?.parentElement;
    if (!stage || typeof IntersectionObserver === 'undefined') {
      visible.current = Boolean(stage);
      if (visible.current) armRef.current();
      return;
    }
    const observer = new IntersectionObserver(entries => {
      const nextVisible = entries.some(entry => entry.target === stage && entry.isIntersecting);
      visible.current = nextVisible;
      if (!nextVisible) stopRef.current('offscreen');
      else if (pointerInside.current) armRef.current();
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [assetKey, src, disabled]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') stopRef.current('hidden');
    };
    const hover = window.matchMedia('(hover: hover) and (pointer: fine)');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onPreferenceChange = () => {
      if (!canHoverPreview()) stopRef.current(reducedMotion.matches ? 'reduced-motion' : 'pointer-mode');
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    hover.addEventListener('change', onPreferenceChange);
    reducedMotion.addEventListener('change', onPreferenceChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      hover.removeEventListener('change', onPreferenceChange);
      reducedMotion.removeEventListener('change', onPreferenceChange);
    };
  }, [assetKey, src, disabled]);

  useEffect(() => {
    const media = video.current;
    const currentLease = lease.current;
    if (!active || !media || currentLease === null || !src) return;
    const requestGeneration = generation.current;
    const frameMedia = media as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    let disposed = false, handedOff = false, frameCallback: number | null = null, paintCallback: number | null = null;
    const sameRequest = () => !disposed && mounted.current && generation.current === requestGeneration
      && video.current === media && lease.current === currentLease
      && sourceContext.current.src === src && sourceContext.current.assetKey === assetKey
      && sourceContext.current.contextKey === contextKey && !sourceContext.current.disabled
      && media.getAttribute('src') === src && isHoverCurrent(currentLease, assetKey, src, media);
    const allowed = () => sameRequest() && pointerInside.current && visible.current && canHoverPreview();
    const hasCurrentFrame = () => media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      && media.videoWidth > 0 && media.videoHeight > 0 && !media.paused && !media.ended;
    const showFrame = () => {
      if (handedOff || !allowed() || !hasCurrentFrame()) return;
      handedOff = true;
      stage.current?.setAttribute('data-frame-ready', 'true');
      setFrameReady(true);
    };
    const supportsFrameCallback = typeof frameMedia.requestVideoFrameCallback === 'function';
    const watchNextFrame = () => {
      if (!supportsFrameCallback || handedOff || !allowed() || frameCallback !== null) return;
      frameCallback = frameMedia.requestVideoFrameCallback!(() => {
        frameCallback = null;
        if (!allowed()) return;
        if (hasCurrentFrame()) showFrame();
        else watchNextFrame();
      });
    };
    const fallbackReady = () => {
      if (supportsFrameCallback) { watchNextFrame(); return; }
      if (handedOff || !allowed() || !hasCurrentFrame() || paintCallback !== null) return;
      // The data/playing event may precede this effect, so current state is checked too.
      paintCallback = window.requestAnimationFrame(() => { paintCallback = null; showFrame(); });
    };
    const failed = () => {
      if (!sameRequest()) return;
      setError(true); stopRef.current('error', media);
    };
    const ended = () => { if (sameRequest()) stopRef.current('ended', media); };
    const dispose = () => {
      disposed = true;
      if (frameCallback !== null) frameMedia.cancelVideoFrameCallback?.(frameCallback);
      if (paintCallback !== null) window.cancelAnimationFrame(paintCallback);
      frameCallback = null; paintCallback = null;
      media.removeEventListener('loadeddata', fallbackReady);
      media.removeEventListener('playing', fallbackReady);
      media.removeEventListener('canplay', fallbackReady);
      media.removeEventListener('error', failed);
      media.removeEventListener('ended', ended);
      if (cancelFrameWatch.current === dispose) cancelFrameWatch.current = null;
    };
    cancelFrameWatch.current = dispose;
    media.addEventListener('loadeddata', fallbackReady);
    media.addEventListener('playing', fallbackReady);
    media.addEventListener('canplay', fallbackReady);
    media.addEventListener('error', failed);
    media.addEventListener('ended', ended);
    watchNextFrame();
    media.muted = true;
    media.playsInline = true;
    media.loop = true;
    media.preload = 'none';
    try { media.currentTime = 0; } catch { /* The preview can still begin when metadata arrives. */ }
    const settled = (playFailed: boolean) => {
      if (disposed || generation.current !== requestGeneration) return;
      return settleAssetHoverPlay({
        media, currentMedia: video.current, lease: currentLease, currentLease: lease.current,
        isCurrent: sameRequest(),
        keepPlaying: pointerInside.current && visible.current && canHoverPreview(), failed: playFailed,
        stop: reason => {
          if (playFailed && mounted.current) setError(true);
          onHoverStop(currentLease, assetKey, src, media, reason);
          if (lease.current === currentLease) cleanupRef.current(reason);
        },
      });
    };
    void media.play().then(() => { if (settled(false) === 'kept') fallbackReady(); }, () => { settled(true); });
    fallbackReady();
    return dispose;
  }, [active, assetKey, contextKey, disabled, isHoverCurrent, onHoverStop, src]);

  return <span
    ref={stage}
    className={`${styles.stage} ${styles.hoverStage}`}
    data-hover-preview="true"
    data-frame-ready={active && frameReady && !error}
    data-error={error || undefined}
    aria-label={title}
    onPointerEnter={event => {
      if (event.pointerType !== 'mouse' || !canHoverPreview()) return;
      pointerInside.current = true;
      arm();
    }}
    onPointerLeave={() => {
      pointerInside.current = false;
      stopRef.current('mouseleave');
    }}
  >
    <span className={styles.poster}>{children}</span>
    <video
      ref={video}
      src={active ? src || undefined : undefined}
      playsInline
      preload="none"
      muted
      loop
      aria-hidden="true"
      className={styles.video}
    />
  </span>;
}
