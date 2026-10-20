'use client';

import { useEffect, useState, type ReactNode } from 'react';

/** The parent keys this display by source/session so retained pixels cannot cross contexts. */
export function MultiviewFrameImage({ src, alt, children }: { src?: string; alt: string; children: ReactNode }) {
  const [presented, setPresented] = useState<{ src: string; alt: string } | null>(null);

  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    const image = new Image();
    image.src = src;
    void image.decode().then(() => {
      if (!cancelled) setPresented({ src, alt });
    }).catch(() => { /* Keep the last complete frame; the caller owns load errors and retry. */ });
    return () => { cancelled = true; };
  }, [src, alt]);

  return presented
    ? <img src={presented.src} alt={presented.src === src ? alt : `${presented.alt}，正在准备新帧`} aria-busy={presented.src !== src} draggable={false} />
    : <>{children}</>;
}
