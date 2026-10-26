'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/** The parent keys this display by source/session so retained pixels cannot cross contexts. */
export function MultiviewFrameImage({ src, alt, children, onFailure, onUsage }: { src?: string; alt: string; children: ReactNode;
  onFailure?: (src: string) => void; onUsage?: (src: string, used: boolean) => void }) {
  const [presented, setPresented] = useState<{ src: string; alt: string } | null>(null);
  const callbacks = useRef({ onFailure, onUsage }); callbacks.current = { onFailure, onUsage };

  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    const image = new Image();
    image.src = src;
    void image.decode().then(() => {
      if (!cancelled) setPresented({ src, alt });
    }).catch(() => { if (!cancelled) callbacks.current.onFailure?.(src); });
    return () => { cancelled = true; };
  }, [src, alt]);
  useEffect(() => {
    if (!presented) return;
    callbacks.current.onUsage?.(presented.src, true);
    return () => callbacks.current.onUsage?.(presented.src, false);
  }, [presented]);

  return presented
    ? <img src={presented.src} alt={presented.src === src ? alt : `${presented.alt}，正在准备新帧`} aria-busy={presented.src !== src} draggable={false} />
    : <>{children}</>;
}
