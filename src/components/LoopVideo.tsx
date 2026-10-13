'use client';

import { useEffect, useRef, type VideoHTMLAttributes } from 'react';
import { useVideoLoopState } from '@/lib/hooks/use-media-preview-state';
import type { ContentKey } from '@/lib/content-reactions/types';
import { VideoLoopButton } from './VideoLoopButton';

/** A native player with a private loop preference, never an autoplay command. */
export function LoopVideo({ contentKey, ...props }: VideoHTMLAttributes<HTMLVideoElement> & { contentKey?: ContentKey }) {
  const video = useRef<HTMLVideoElement>(null);
  const loop = useVideoLoopState(props.src, contentKey);
  useEffect(() => {
    const media = video.current;
    return () => { media?.pause(); };
  }, [props.src]);
  return <>
    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
    <video {...props} ref={video} loop={loop.enabled} />
    <VideoLoopButton enabled={loop.enabled} onToggle={loop.toggle} disabled={!props.src || !loop.ready} storageUnavailable={loop.storageUnavailable} />
  </>;
}
