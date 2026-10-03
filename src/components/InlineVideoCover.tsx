'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LoaderCircle, Pause, Play, RotateCcw } from 'lucide-react';
import { useMediaPreviewState } from '@/lib/hooks/use-media-preview-state';
import type { ContentKey } from '@/lib/content-reactions/types';
import styles from './InlineVideoCover.module.css';

export function InlineVideoCover({ src, contentKey, title, active, onActivate, onPause, children }: {
  src: string | null; contentKey: ContentKey; title: string; active: boolean;
  onActivate: () => void; onPause: () => void; children: ReactNode;
}) {
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
  return <span className={styles.stage} data-playing={playing || undefined} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
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
