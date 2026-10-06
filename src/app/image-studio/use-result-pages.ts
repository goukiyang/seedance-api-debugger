'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

type Position = { id: string | null; index: number };

export function useResultPages<T extends { id: string }>({ items, storageKey, visible, busy, error, hasMore, loadMore, currentId }: {
  items: T[]; storageKey: string; visible: boolean; busy: boolean; error: boolean;
  hasMore: boolean; loadMore: () => Promise<unknown>; currentId: string | null;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(3);
  const [position, setPosition] = useState<Position>({ id: null, index: 0 });
  const [requested, setRequested] = useState<Position | null>(null);
  const [completedReads, setCompletedReads] = useState(0);
  const [restoredKey, setRestoredKey] = useState('');
  const readsLeft = useRef(0);
  const reading = useRef(false);
  const anchorIndex = position.id ? items.findIndex(item => item.id === position.id) : -1;
  const index = anchorIndex >= 0 ? anchorIndex : Math.min(position.index, Math.max(0, items.length - 1));
  const start = Math.floor(index / capacity) * capacity;
  const pageItems = restoredKey === storageKey ? items.slice(start, start + capacity) : [];
  const latest = useRef({ items, currentId, start, capacity, position });
  latest.current = { items, currentId, start, capacity, position };

  useEffect(() => {
    let saved: { id?: unknown; index?: unknown; version?: unknown } | null = null;
    try { saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { /* Optional preferences. */ }
    const valid = saved?.version === 1 && typeof saved.index === 'number' && Number.isSafeInteger(saved.index) && saved.index >= 0
      && typeof saved.id === 'string' && saved.id.length <= 160;
    readsLeft.current = valid ? Math.min(20, Math.ceil((saved!.index as number) / 24) + 2) : 0;
    setPosition({ id: null, index: 0 });
    setRequested(valid ? { id: saved!.id as string, index: saved!.index as number } : null);
    setRestoredKey(storageKey);
  }, [storageKey]);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!visible || !grid) return;
    const measure = () => {
      if (grid.getBoundingClientRect().width <= 0) return;
      const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
      const next = Math.max(1, columns) * 3;
      const previous = latest.current;
      if (next === previous.capacity) return;
      const selectedIndex = previous.items.findIndex(item => item.id === previous.currentId);
      const anchor = selectedIndex >= previous.start && selectedIndex < previous.start + previous.capacity ? selectedIndex : previous.start;
      // A resize re-pages around a visible image, never around a selection on another page.
      setPosition({ id: previous.items[anchor]?.id || null, index: anchor });
      setCapacity(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [visible, items.length]);

  useEffect(() => {
    if (restoredKey !== storageKey || !requested || busy || error || reading.current || !visible) return;
    const target = requested.id ? items.findIndex(item => item.id === requested.id) : requested.index;
    if (target >= 0 && target < items.length) {
      setPosition({ id: items[target].id, index: target }); setRequested(null);
      return;
    }
    if (!hasMore || readsLeft.current <= 0) {
      const nearest = Math.min(requested.index, Math.max(0, items.length - 1));
      setPosition({ id: items[nearest]?.id || null, index: nearest }); setRequested(null);
      return;
    }
    readsLeft.current--;
    reading.current = true;
    void loadMore().finally(() => { reading.current = false; setCompletedReads(value => value + 1); });
  }, [busy, completedReads, error, hasMore, items, loadMore, requested, restoredKey, storageKey, visible]);

  useEffect(() => {
    if (restoredKey !== storageKey || requested || !items.length) return;
    const id = items[index]?.id;
    if (id && id !== position.id) { setPosition({ id, index }); return; }
    try { localStorage.setItem(storageKey, JSON.stringify({ version: 1, id, index })); } catch { /* Optional preferences. */ }
  }, [index, items, position, requested, restoredKey, storageKey]);

  function goToIndex(target: number) {
    const next = Math.max(0, target);
    readsLeft.current = 20;
    if (next >= items.length && hasMore) setRequested({ id: null, index: next });
    else { setRequested(null); setPosition({ id: items[next]?.id || null, index: next }); }
  }
  function goToId(id: string) {
    const target = items.findIndex(item => item.id === id);
    if (target >= 0) goToIndex(target);
  }
  return { gridRef, pageItems, capacity, start, page: Math.floor(start / capacity) + 1,
    pages: Math.max(1, Math.ceil(items.length / capacity)), restoring: Boolean(requested),
    canNext: start + capacity < items.length || hasMore,
    previous: () => goToIndex(start - capacity), next: () => goToIndex(start + capacity), goToId,
    reset: () => { try { localStorage.removeItem(storageKey); } catch {} goToIndex(0); } };
}
