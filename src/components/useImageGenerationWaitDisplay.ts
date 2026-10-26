'use client';

import { useEffect, useRef, useState } from 'react';
import { advanceImageGenerationWaitDisplay, imageGenerationWaitDisplay, type ImageGenerationWait, type ImageGenerationWaitMemory } from '@/lib/image-studio/wait-display';

/** Progress ticks remain inside the visible card, never the result-list owner. */
export function useImageGenerationWaitDisplay(wait?: ImageGenerationWait, key = '', visible = true) {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const [foreground, setForeground] = useState(() => typeof document === 'undefined' || !document.hidden);
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches));
  const [, refreshClock] = useState(0);
  const memory = useRef<ImageGenerationWaitMemory>();
  const now = Date.now();
  const calculation = wait ? advanceImageGenerationWaitDisplay(imageGenerationWaitDisplay(wait, now, online), memory.current,
    key, now, visible && foreground, reducedMotion) : undefined;
  memory.current = calculation?.memory;
  const display = calculation?.display;
  const active = Boolean(display?.pending || display?.showRecovery || display?.finishing);
  const normalTick = visible && foreground && display?.pending && display.showTrack && display.timeSource
    ? Math.floor(now / 1000) * 1000 + 1000 : undefined;
  const nextTick = display?.nextAnimationAt ?? (normalTick !== undefined && display?.nextCheckAt !== undefined
    ? Math.min(normalTick, display.nextCheckAt) : normalTick ?? display?.nextCheckAt);
  useEffect(() => {
    if (!active) return;
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const sync = () => { setOnline(navigator.onLine); setForeground(!document.hidden); setReducedMotion(Boolean(motion?.matches)); refreshClock(value => value + 1); };
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    motion?.addEventListener('change', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
      motion?.removeEventListener('change', sync);
    };
  }, [active]);
  useEffect(() => {
    if (nextTick === undefined) return;
    // Connectivity does not stop this alarm. A hidden/throttled page also
    // recomputes immediately when it returns to the foreground.
    const timer = window.setTimeout(() => refreshClock(value => value + 1), Math.max(0, nextTick - Date.now()));
    return () => window.clearTimeout(timer);
  }, [key, nextTick]);
  return display;
}
