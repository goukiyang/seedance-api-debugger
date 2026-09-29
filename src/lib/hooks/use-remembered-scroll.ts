'use client';

import { useEffect } from 'react';

// Uses the sessionStorage/pagehide strategy of React Router ScrollRestoration,
// adapted for Next.js and independently scrolling workbench panes.
export function useRememberedScroll(key: string, ready = true) {
  useEffect(() => {
    if (!ready) return;
    const storageKey = `sd2-scroll:${key}`;
    const previous = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    let saved: { x: number; y: number; panes: Record<string, { x: number; y: number }> } | null = null;
    try { saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch {}
    if (saved && (!Number.isFinite(saved.x) || !Number.isFinite(saved.y))) saved = null;
    let restoring = Boolean(saved);
    let frame = 0;
    const panes = () => Array.from(document.querySelectorAll<HTMLElement>('[data-remember-scroll]'));
    const save = () => {
      if (restoring) return;
      const positions = Object.fromEntries(panes().map(element => [element.dataset.rememberScroll!, { x: element.scrollLeft, y: element.scrollTop }]));
      try { sessionStorage.setItem(storageKey, JSON.stringify({ x: window.scrollX, y: window.scrollY, panes: positions })); } catch {}
    };
    const restore = () => {
      if (!restoring || !saved) return;
      window.scrollTo({ left: saved.x, top: saved.y, behavior: 'instant' as ScrollBehavior });
      for (const element of panes()) {
        const position = saved.panes?.[element.dataset.rememberScroll!];
        if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) element.scrollTo({ left: position.x, top: position.y, behavior: 'instant' as ScrollBehavior });
      }
    };
    const scheduleRestore = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(restore); };
    const stop = () => { restoring = false; observer.disconnect(); cancelAnimationFrame(frame); };
    const onKey = (event: KeyboardEvent) => { if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) stop(); };
    const observer = new ResizeObserver(scheduleRestore);
    observer.observe(document.body);
    for (const element of panes()) observer.observe(element);
    const mutations = new MutationObserver(scheduleRestore);
    mutations.observe(document.body, { childList: true, subtree: true });
    scheduleRestore();
    const deadline = window.setTimeout(() => { stop(); mutations.disconnect(); }, 10000);
    window.addEventListener('wheel', stop, { passive: true });
    window.addEventListener('touchstart', stop, { passive: true });
    window.addEventListener('pointerdown', stop, { passive: true });
    window.addEventListener('keydown', onKey);
    window.addEventListener('pagehide', save);
    document.addEventListener('scroll', save, { capture: true, passive: true });
    return () => {
      save(); observer.disconnect(); mutations.disconnect(); clearTimeout(deadline); cancelAnimationFrame(frame);
      window.removeEventListener('wheel', stop); window.removeEventListener('touchstart', stop);
      window.removeEventListener('pointerdown', stop); window.removeEventListener('keydown', onKey);
      window.removeEventListener('pagehide', save); document.removeEventListener('scroll', save, true);
      history.scrollRestoration = previous;
    };
  }, [key, ready]);
}
