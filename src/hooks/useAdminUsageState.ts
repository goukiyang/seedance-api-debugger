'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { defaultUsageSearch, patchUsageSearch, readStoredSearch, safeStoredSearch, USAGE_PATHS, withLocalTimeZone, type QueryPatch, type UsageView } from '@/components/admin-usage/query';

type Surface = { y: number; anchor: string | null; offset: number; expanded: string[] };
const EMPTY_SURFACE: Surface = { y: 0, anchor: null, offset: 0, expanded: [] };
function scopeHash(search: string) {
  let hash = 2166136261;
  for (let i = 0; i < search.length; i++) hash = Math.imul(hash ^ search.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}
function readSurface(key: string): Surface {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (!value || typeof value !== 'object') return EMPTY_SURFACE;
    return {
      y: Number.isFinite(value.y) ? Math.max(0, Math.min(value.y, 10_000_000)) : 0,
      anchor: typeof value.anchor === 'string' && /^[\w:.-]{1,220}$/.test(value.anchor) ? value.anchor : null,
      offset: Number.isFinite(value.offset) ? Math.max(-10_000, Math.min(value.offset, 10_000)) : 0,
      expanded: Array.isArray(value.expanded) ? value.expanded.filter((id: unknown): id is string => typeof id === 'string' && /^[\w:.-]{1,220}$/.test(id)).slice(0, 150) : [],
    };
  } catch { return EMPTY_SURFACE; }
}

export function useAdminUsageState(viewerId: string, view: UsageView) {
  const locationSearch = useSearchParams().toString();
  const key = `sd2:admin-usage:v1:${viewerId}:${view}`;
  const [state, setState] = useState<{ key: string; search: string } | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const stateRef = useRef(state);
  const surfaceKey = useRef('');
  const pendingRestore = useRef<Surface | null>(null);
  const interacted = useRef(false);
  const initialized = useRef('');
  const restored = useRef(false);

  const saveSurface = useCallback(() => {
    if (!surfaceKey.current || pendingRestore.current) return;
    const anchors = Array.from(document.querySelectorAll<HTMLElement>('[data-usage-anchor]'));
    const anchor = anchors.find(element => element.getBoundingClientRect().bottom > 0);
    const surface: Surface = { y: window.scrollY, anchor: anchor?.dataset.usageAnchor || null, offset: anchor?.getBoundingClientRect().top || 0, expanded: expandedRef.current };
    try { sessionStorage.setItem(surfaceKey.current, JSON.stringify(surface)); } catch { /* Storage is optional. */ }
  }, []);

  useEffect(() => {
    if (stateRef.current?.key === key && stateRef.current.search === locationSearch) return;
    if (stateRef.current?.key === key) saveSurface();
    const first = initialized.current !== key;
    let params = new URLSearchParams(locationSearch);
    if (first && !locationSearch) {
      try {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        params = saved?.schema === 1 ? readStoredSearch(saved.filters) || defaultUsageSearch() : defaultUsageSearch();
      } catch { params = defaultUsageSearch(); }
    } else if (!locationSearch) params = defaultUsageSearch();
    params = withLocalTimeZone(params);
    const search = params.toString();
    initialized.current = key;
    surfaceKey.current = `${key}:tab:${scopeHash(search)}`;
    const surface = readSurface(surfaceKey.current);
    const explicitAnchor = Boolean(window.location.hash);
    pendingRestore.current = explicitAnchor ? null : surface;
    interacted.current = false;
    restored.current = explicitAnchor;
    setExpanded(surface.expanded);
    stateRef.current = { key, search };
    setState(stateRef.current);
    if (search !== locationSearch) window.history.replaceState(window.history.state, '', `${USAGE_PATHS[view]}?${search}${window.location.hash}`);
  }, [key, locationSearch, view, saveSurface]);

  const rememberValidScope = useCallback((search: string) => {
    if (stateRef.current?.key !== key || stateRef.current.search !== search) return;
    try { localStorage.setItem(key, JSON.stringify({ schema: 1, filters: safeStoredSearch(search) })); } catch { /* No financial data is cached. */ }
  }, [key]);

  useEffect(() => {
    let frame = 0;
    const save = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(saveSurface); };
    const interact = () => { interacted.current = true; pendingRestore.current = null; };
    window.addEventListener('scroll', save, { passive: true });
    window.addEventListener('pagehide', saveSurface);
    document.addEventListener('visibilitychange', saveSurface);
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(event, interact, { passive: true });
    return () => {
      cancelAnimationFrame(frame); saveSurface();
      window.removeEventListener('scroll', save); window.removeEventListener('pagehide', saveSurface);
      document.removeEventListener('visibilitychange', saveSurface);
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.removeEventListener(event, interact);
    };
  }, [saveSurface]);

  const update = useCallback((patch: QueryPatch, options?: { pages?: boolean; replace?: boolean }) => {
    const current = stateRef.current;
    if (!current || current.key !== key) return;
    saveSurface();
    const search = patchUsageSearch(current.search, patch, options?.pages !== false).toString();
    if (search === current.search) return;
    pendingRestore.current = null;
    surfaceKey.current = `${key}:tab:${scopeHash(search)}`;
    stateRef.current = { key, search };
    setState(stateRef.current);
    window.history[options?.replace ? 'replaceState' : 'pushState'](window.history.state, '', `${USAGE_PATHS[view]}?${search}`);
  }, [key, saveSurface, view]);

  const reset = useCallback(() => {
    saveSurface();
    try {
      localStorage.removeItem(key);
      for (const entry of Object.keys(sessionStorage)) if (entry.startsWith(`${key}:tab:`)) sessionStorage.removeItem(entry);
    } catch { /* Only these analysis preferences are reset. */ }
    const search = defaultUsageSearch().toString();
    stateRef.current = { key, search }; setState(stateRef.current); setExpanded([]);
    surfaceKey.current = `${key}:tab:${scopeHash(search)}`;
    pendingRestore.current = null;
    window.history.pushState(window.history.state, '', `${USAGE_PATHS[view]}?${search}`);
  }, [key, saveSurface, view]);

  const preserveLayout = useCallback(() => {
    saveSurface();
    pendingRestore.current = readSurface(surfaceKey.current);
    interacted.current = false;
    restored.current = false;
  }, [saveSurface]);

  const restoreLayout = useCallback(() => {
    if (restored.current || interacted.current || !pendingRestore.current) return;
    const surface = pendingRestore.current;
    let frame = 0;
    const root = document.querySelector<HTMLElement>('.admin-usage-page');
    const observer = new MutationObserver(() => schedule());
    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (interacted.current || pendingRestore.current !== surface) { observer.disconnect(); return; }
        const waiting = Array.from(document.querySelectorAll<HTMLElement>('[data-usage-layout-pending="true"]')).some(element => element.getClientRects().length > 0);
        if (waiting) return;
        const anchor = surface.anchor ? Array.from(document.querySelectorAll<HTMLElement>('[data-usage-anchor]')).find(element => element.dataset.usageAnchor === surface.anchor) : null;
        const y = anchor ? window.scrollY + anchor.getBoundingClientRect().top - surface.offset : surface.y;
        window.scrollTo({ top: Math.max(0, y), behavior: 'auto' });
        pendingRestore.current = null; restored.current = true; observer.disconnect();
      });
    }
    if (root) observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-usage-layout-pending', 'open'] });
    schedule();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, []);

  const toggleExpanded = useCallback((id: string, open: boolean) => {
    setExpanded(current => open ? Array.from(new Set([...current, id])) : current.filter(item => item !== id));
  }, []);
  useEffect(() => { saveSurface(); }, [expanded, saveSurface]);

  return { search: state?.key === key ? state.search : null, update, reset, expanded, toggleExpanded, restoreLayout, rememberValidScope, preserveLayout };
}
