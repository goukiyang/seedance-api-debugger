'use client';

import { useCallback, useEffect, useRef } from 'react';

type ScrollOptions = { localFallback?: boolean; skipRestore?: boolean };
type Position = { x: number; y: number };
type PersistentPosition = Position & { version: 1; panes: Record<string, Position>; anchor?: { id: string; offset: number } };

function readPersistentPosition(raw: string | null): PersistentPosition | null {
  try {
    const value = JSON.parse(raw || 'null');
    const valid = (position: Position) => position && Number.isFinite(position.x) && Number.isFinite(position.y) && position.x >= 0 && position.y >= 0 && position.x <= 10_000_000 && position.y <= 10_000_000;
    if (value?.version !== 1 || !valid(value)) return null;
    const panes: Record<string, Position> = {};
    for (const [id, position] of Object.entries(value.panes || {}).slice(0, 32)) {
      if (id.length <= 160 && valid(position as Position)) panes[id] = { x: (position as Position).x, y: (position as Position).y };
    }
    const anchor = value.anchor;
    return { version: 1, x: value.x, y: value.y, panes, ...(typeof anchor?.id === 'string' && anchor.id.length <= 240 && Number.isFinite(anchor.offset) && Math.abs(anchor.offset) <= 100_000 ? { anchor: { id: anchor.id, offset: anchor.offset } } : {}) };
  } catch { return null; }
}

function rememberPersistentScroll(key: string, skipRestore: boolean) {
  const storageKey = `sd2-scroll:${key}`;
  let saved: PersistentPosition | null = null;
  try { saved = readPersistentPosition(sessionStorage.getItem(storageKey)); } catch {}
  if (!saved) { try { saved = readPersistentPosition(localStorage.getItem(storageKey)); } catch {} }
  const previous = history.scrollRestoration;
  history.scrollRestoration = 'manual';
  let restoring = Boolean(saved) && !skipRestore;
  let reset = false;
  let timer = 0;
  let frame = 0;
  let snapshot: PersistentPosition | null = null;
  const panes = () => Array.from(document.querySelectorAll<HTMLElement>('[data-remember-scroll]'));
  const anchors = () => Array.from(document.querySelectorAll<HTMLElement>('[data-remember-scroll-anchor]'));
  const capture = () => {
    if (restoring || reset) return;
    const elements = anchors();
    const anchor = elements.find(element => element.getBoundingClientRect().bottom > 0) || elements[elements.length - 1];
    const rect = anchor?.getBoundingClientRect();
    snapshot = {
      version: 1, x: window.scrollX, y: window.scrollY,
      panes: Object.fromEntries(panes().map(element => [element.dataset.rememberScroll!, { x: element.scrollLeft, y: element.scrollTop }])),
      ...(anchor && rect ? { anchor: { id: anchor.dataset.rememberScrollAnchor!, offset: Math.max(1 - rect.height, Math.min(window.innerHeight, rect.top)) } } : {}),
    };
  };
  const flush = () => {
    clearTimeout(timer); timer = 0;
    if (restoring || reset || !snapshot) return;
    const raw = JSON.stringify(snapshot);
    try { sessionStorage.setItem(storageKey, raw); } catch {}
    try { localStorage.setItem(storageKey, raw); } catch {}
  };
  const save = () => { capture(); flush(); };
  const scheduleSave = () => { capture(); if (!timer) timer = window.setTimeout(flush, 200); };
  const stop = () => { restoring = false; cancelAnimationFrame(frame); };
  const onKey = (event: KeyboardEvent) => { if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) stop(); };
  const onVisibility = () => { if (document.visibilityState === 'hidden') save(); };
  frame = requestAnimationFrame(() => {
    if (!restoring || !saved) { save(); return; }
    const anchor = saved.anchor && anchors().find(element => element.dataset.rememberScrollAnchor === saved!.anchor!.id);
    // A removed item falls back to the list start, not an unrelated item's old pixel offset.
    const top = saved.anchor ? anchor ? window.scrollY + anchor.getBoundingClientRect().top - saved.anchor.offset : 0 : saved.y;
    window.scrollTo({ left: saved.x, top, behavior: 'instant' as ScrollBehavior });
    for (const element of panes()) {
      const position = saved.panes[element.dataset.rememberScroll!];
      if (position) element.scrollTo({ left: position.x, top: position.y, behavior: 'instant' as ScrollBehavior });
    }
    restoring = false;
    save();
  });
  window.addEventListener('wheel', stop, { passive: true });
  window.addEventListener('touchstart', stop, { passive: true });
  window.addEventListener('pointerdown', stop, { passive: true });
  window.addEventListener('keydown', onKey);
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('scroll', scheduleSave, { capture: true, passive: true });
  return {
    reset: () => {
      reset = true; stop(); clearTimeout(timer);
      try { sessionStorage.removeItem(storageKey); } catch {}
      try { localStorage.removeItem(storageKey); } catch {}
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
      panes().forEach(element => element.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior }));
    },
    cleanup: () => {
      // The old DOM may already be gone (or belong to another account) during cleanup.
      flush(); clearTimeout(timer); cancelAnimationFrame(frame);
      window.removeEventListener('wheel', stop); window.removeEventListener('touchstart', stop);
      window.removeEventListener('pointerdown', stop); window.removeEventListener('keydown', onKey);
      window.removeEventListener('pagehide', save); document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('scroll', scheduleSave, true);
      history.scrollRestoration = previous;
    },
  };
}

// Uses the sessionStorage/pagehide strategy of React Router ScrollRestoration,
// adapted for Next.js and independently scrolling workbench panes.
export function useRememberedScroll(key: string, ready = true, { localFallback = false, skipRestore = false }: ScrollOptions = {}) {
  const resetRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (localFallback) {
      const controller = rememberPersistentScroll(key, skipRestore);
      resetRef.current = controller.reset;
      return () => { controller.cleanup(); resetRef.current = null; };
    }
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
  }, [key, ready, localFallback, skipRestore]);
  return useCallback(() => {
    resetRef.current?.();
    if (!resetRef.current) window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
  }, []);
}
