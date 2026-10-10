'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useMediaPreviewState } from '@/lib/hooks/use-media-preview-state';
import type { ContentKey } from '@/lib/content-reactions/types';
import { replaceAssetMedia, type AssetPlaybackLease } from '@/lib/media/asset-playback';

type AssetPreviewMediaProps = {
  kind: 'video' | 'audio';
  contentKey: ContentKey;
  src: string;
  poster?: string;
  title: string;
  onClaim: (key: string, src: string, media: HTMLMediaElement) => AssetPlaybackLease;
  onRelease: (lease: AssetPlaybackLease, key: string, src: string, media: HTMLMediaElement) => void;
};

export function AssetPreviewMedia({ kind, contentKey, src, poster, title, onClaim, onRelease }: AssetPreviewMediaProps) {
  const state = useMediaPreviewState(contentKey, contentKey, src);
  const stateRef = useRef(state);
  stateRef.current = state;
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const leaseRef = useRef<AssetPlaybackLease | null>(null);
  const userInteracted = useRef(false);
  const metadataReady = useRef(false);
  const restoredKey = useRef<string | null>(null);
  const restoreTarget = useRef<number | null>(null);
  const propsRef = useRef({ contentKey: String(contentKey), src, onClaim, onRelease });
  propsRef.current = { contentKey: String(contentKey), src, onClaim, onRelease };

  const persistPosition = useCallback((value: number) => {
    const current = stateRef.current;
    if (current.ready && current.key && Number.isFinite(value) && value >= 0) {
      current.update({ currentTime: value });
    }
  }, []);

  const restorePosition = useCallback(() => {
    const media = mediaRef.current;
    const current = stateRef.current;
    if (!media || !current.ready || !current.key || media.readyState < 1 || restoredKey.current === current.key || userInteracted.current) return;
    restoredKey.current = current.key;
    const saved = current.value.currentTime;
    if (!Number.isFinite(saved) || saved <= 0) return;
    const duration = media.duration;
    const safeTime = Number.isFinite(duration) && duration > 0
      ? Math.min(saved, Math.max(0, duration - 0.1))
      : saved;
    if (safeTime <= 0) return;
    media.pause();
    restoreTarget.current = safeTime;
    try { media.currentTime = safeTime; } catch { restoreTarget.current = null; }
  }, []);

  useEffect(() => {
    if (metadataReady.current && state.ready) restorePosition();
  }, [restorePosition, state.key, state.ready]);

  const releaseLease = useCallback((media: HTMLMediaElement, save: boolean, resetToStart = false) => {
    if (userInteracted.current && save) persistPosition(resetToStart ? 0 : media.currentTime);
    const lease = leaseRef.current;
    leaseRef.current = null;
    if (lease !== null) {
      const current = propsRef.current;
      current.onRelease(lease, current.contentKey, current.src, media);
    }
    if (resetToStart) userInteracted.current = false;
  }, [persistPosition]);

  const setMediaRef = useCallback((media: HTMLMediaElement | null) => {
    // React detaches refs before passive cleanup, so release the captured old player here.
    mediaRef.current = replaceAssetMedia(mediaRef.current, media, previous => releaseLease(previous, true));
  }, [releaseLease]);

  const onPlay = (media: HTMLMediaElement) => {
    userInteracted.current = true;
    const current = propsRef.current;
    leaseRef.current = current.onClaim(current.contentKey, current.src, media);
  };

  const onPause = (media: HTMLMediaElement) => {
    if (!media.paused) return;
    releaseLease(media, true);
  };

  const onSeeked = (media: HTMLMediaElement) => {
    const target = restoreTarget.current;
    if (target !== null && Math.abs(media.currentTime - target) < 0.25) {
      restoreTarget.current = null;
      return;
    }
    restoreTarget.current = null;
    userInteracted.current = true;
    persistPosition(media.currentTime);
  };

  const onTimeUpdate = (media: HTMLMediaElement) => {
    if (userInteracted.current) persistPosition(media.currentTime);
  };

  if (kind === 'video') {
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption
      <video
        ref={setMediaRef}
        src={src}
        controls
        playsInline
        preload="metadata"
        poster={poster || undefined}
        aria-label={title}
        onPlay={event => onPlay(event.currentTarget)}
        onPause={event => onPause(event.currentTarget)}
        onSeeked={event => onSeeked(event.currentTarget)}
        onTimeUpdate={event => onTimeUpdate(event.currentTarget)}
        onLoadedMetadata={() => { metadataReady.current = true; restorePosition(); }}
        onEnded={event => { if (event.currentTarget.ended) releaseLease(event.currentTarget, true, true); }}
        onError={event => releaseLease(event.currentTarget, true)}
      />
    );
  }

  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <audio
      ref={setMediaRef}
      src={src}
      controls
      preload="metadata"
      aria-label={title}
      onPlay={event => onPlay(event.currentTarget)}
      onPause={event => onPause(event.currentTarget)}
      onSeeked={event => onSeeked(event.currentTarget)}
      onTimeUpdate={event => onTimeUpdate(event.currentTarget)}
      onLoadedMetadata={() => { metadataReady.current = true; restorePosition(); }}
      onEnded={event => { if (event.currentTarget.ended) releaseLease(event.currentTarget, true, true); }}
      onError={event => releaseLease(event.currentTarget, true)}
    />
  );
}
