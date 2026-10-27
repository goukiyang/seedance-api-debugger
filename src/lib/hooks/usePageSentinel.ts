'use client';
import { useEffect, useRef } from 'react';

export function usePageSentinel(load: () => void, enabled: boolean) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!enabled || !ref.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) load(); }, { rootMargin: '240px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [enabled, load]);
  return ref;
}
