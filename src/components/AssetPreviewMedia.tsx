'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Maximize2 } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { useMediaPreviewState, useVideoLoopState } from '@/lib/hooks/use-media-preview-state';
import { VideoLoopButton } from '@/components/VideoLoopButton';
import { MultiviewEntry } from '@/components/MultiviewEntry';
import styles from './AssetPreviewMedia.module.css';
import type { ContentKey } from '@/lib/content-reactions/types';
import { replaceAssetMedia, type AssetPlaybackLease } from '@/lib/media/asset-playback';

type AssetPreviewMediaProps = {
  kind: 'video' | 'audio';
  contentKey: ContentKey;
  src: string;
  poster?: string;
  title: string;
  scope?: 'drawer';
  taskId?: string | null;
  onExpand?: () => void;
  onClaim: (key: string, src: string, media: HTMLMediaElement) => AssetPlaybackLease;
  onRelease: (lease: AssetPlaybackLease, key: string, src: string, media: HTMLMediaElement) => void;
};

export function AssetPreviewMedia({ kind, contentKey, src, poster, title, scope, taskId, onExpand, onClaim, onRelease }: AssetPreviewMediaProps) {
  const { user, hasLoadedUser, sessionChanged, userLoadError } = useAppSession();
  const actualTaskId = scope === 'drawer' && kind === 'video' && taskId && String(contentKey) === `video_task:${taskId}` ? taskId : null;
  const [copyStatus, setCopyStatus] = useState('');
  const alive = useRef(true), copySequence = useRef(0);
  const copyScope = useRef({ owner: user?.id, taskId: actualTaskId, src, sessionChanged, userLoadError, hasLoadedUser });
  copyScope.current = { owner: user?.id, taskId: actualTaskId, src, sessionChanged, userLoadError, hasLoadedUser };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { copySequence.current++; setCopyStatus(''); }, [actualTaskId, src, user?.id]);
  useEffect(() => {
    if (copyStatus !== '已复制') return;
    const timer = setTimeout(() => setCopyStatus(''), 4000); return () => clearTimeout(timer);
  }, [copyStatus]);
  function copyTaskId() {
    const captured = copyScope.current, sequence = ++copySequence.current;
    const current = () => alive.current && sequence === copySequence.current && copyScope.current.owner === captured.owner
      && copyScope.current.taskId === captured.taskId && copyScope.current.src === captured.src
      && copyScope.current.hasLoadedUser && !copyScope.current.sessionChanged && !copyScope.current.userLoadError
      && captured.owner && captured.hasLoadedUser && !captured.sessionChanged && !captured.userLoadError && !isClientSessionBlocked();
    if (!actualTaskId || !current()) return;
    if (!navigator.clipboard?.writeText) { setCopyStatus('无法自动复制，可选中任务编号复制'); return; }
    try {
      void navigator.clipboard.writeText(actualTaskId).then(() => { if (current()) setCopyStatus('已复制'); })
        .catch(() => { if (current()) setCopyStatus('复制未完成，可选中任务编号复制'); });
    } catch { if (current()) setCopyStatus('复制未完成，可选中任务编号复制'); }
  }
  const state = useMediaPreviewState(contentKey, contentKey, src);
  const loop = useVideoLoopState(kind === 'video' ? src : undefined, contentKey);
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
    const actions = <div className={styles.actions}><VideoLoopButton enabled={loop.enabled} onToggle={loop.toggle} disabled={!src || !loop.ready} storageUnavailable={loop.storageUnavailable} />
      <MultiviewEntry contentKey={contentKey} className={scope === 'drawer' ? styles.primaryAction : undefined} />
      {scope === 'drawer' && onExpand && <button type="button" onClick={onExpand} title="放大预览视频" aria-label="放大预览视频"><Maximize2 size={16} /></button>}</div>;
    return (
      <div className={`${styles.videoShell} ${scope === 'drawer' ? styles.drawer : ''}`}>
      {scope === 'drawer' && <div className={styles.drawerTools}>
        {actualTaskId && <div className={styles.taskId}><span>任务编号</span><code>{actualTaskId}</code><button type="button" title="复制任务编号" aria-label="复制任务编号" disabled={!user?.id || !hasLoadedUser || sessionChanged || Boolean(userLoadError)} onClick={copyTaskId}>{copyStatus === '已复制' ? <Check size={16} /> : <Copy size={16} />}</button></div>}
        {actions}{copyStatus && <span className={styles.copyStatus} role="status">{copyStatus}</span>}
      </div>}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={setMediaRef}
        src={src}
        controls
        loop={loop.enabled}
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
      {scope !== 'drawer' && actions}
      </div>
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
