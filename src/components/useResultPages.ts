'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

type Position = { id: string | null; index: number };

export function gridPageCapacity(grid: HTMLElement) {
  const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
  return Math.max(1, columns) * 3;
}

export function useResultPages<T extends { id: string }>({ items: inputItems, storageKey, visible, busy, error, hasMore, loadMore, currentId, total }: {
  items: T[]; storageKey: string; visible: boolean; busy: boolean; error: boolean;
  hasMore: boolean; loadMore: () => Promise<unknown>; currentId: string | null;
  total?: number | null;
}) {
  const items = useMemo(() => Array.from(new Map(inputItems.map(item => [item.id, item])).values()), [inputItems]);
  const gridRef = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(3);
  const [position, setPosition] = useState<Position>({ id: null, index: 0 });
  const [requested, setRequested] = useState<Position | null>(null);
  const [completedReads, setCompletedReads] = useState(0);
  const [restoredKey, setRestoredKey] = useState('');
  const readsLeft = useRef(0);
  const reading = useRef(false);
  const generation = useRef(0);
  const suppliedTotal = typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 ? total : null;
  const knownTotal = suppliedTotal ?? (!hasMore && !busy ? items.length : null);
  const anchorIndex = position.id ? items.findIndex(item => item.id === position.id) : -1;
  const index = anchorIndex >= 0 ? anchorIndex : Math.min(position.index, Math.max(0, items.length - 1));
  const start = Math.floor(index / capacity) * capacity;
  const pageItems = restoredKey === storageKey ? items.slice(start, start + capacity) : [];
  const latest = useRef({ items, currentId, start, capacity, position });
  latest.current = { items, currentId, start, capacity, position };

  useEffect(() => {
    generation.current++;
    reading.current = false;
    let saved: { id?: unknown; index?: unknown; version?: unknown } | null = null;
    try { saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { /* Optional preferences. */ }
    const valid = saved?.version === 1 && typeof saved.index === 'number' && Number.isSafeInteger(saved.index) && saved.index >= 0
      && typeof saved.id === 'string' && saved.id.length <= 160;
    readsLeft.current = valid ? Math.min(20, Math.ceil((saved!.index as number) / 24) + 2) : 2;
    setPosition({ id: null, index: 0 });
    setRequested(valid ? { id: saved!.id as string, index: saved!.index as number } : null);
    setRestoredKey(storageKey);
    return () => { generation.current++; };
  }, [storageKey]);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!visible || !grid) return;
    const measure = () => {
      if (grid.getBoundingClientRect().width <= 0) return;
      const next = gridPageCapacity(grid);
      const previous = latest.current;
      if (next === previous.capacity) return;
      const selectedIndex = previous.items.findIndex(item => item.id === previous.currentId);
      const anchor = selectedIndex >= previous.start && selectedIndex < previous.start + previous.capacity ? selectedIndex : previous.start;
      // A resize re-pages around a visible image, never around a selection on another page.
      setPosition({ id: previous.items[anchor]?.id || null, index: anchor });
      readsLeft.current = Math.max(readsLeft.current, 2);
      setCapacity(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [visible, items.length]);

  useEffect(() => {
    if (restoredKey !== storageKey || busy || error || reading.current || !visible) return;
    const target = requested ? requested.id ? items.findIndex(item => item.id === requested.id) : requested.index : index;
    const pageEnd = (Math.floor(Math.max(0, target) / capacity) + 1) * capacity;
    const needsMore = hasMore && (target < 0 || items.length < Math.min(pageEnd, knownTotal ?? pageEnd));
    if (!needsMore && target >= 0 && target < items.length) {
      if (requested) { setPosition({ id: items[target].id, index: target }); setRequested(null); }
      return;
    }
    if (!hasMore || readsLeft.current <= 0) {
      if (!requested) return;
      const nearest = Math.min(requested.index, Math.max(0, items.length - 1));
      setPosition({ id: items[nearest]?.id || null, index: nearest }); setRequested(null);
      return;
    }
    readsLeft.current--;
    reading.current = true;
    const token = generation.current;
    void loadMore().catch(() => { if (generation.current === token) readsLeft.current = 0; }).finally(() => {
      if (generation.current !== token) return;
      reading.current = false; setCompletedReads(value => value + 1);
    });
  }, [busy, capacity, completedReads, error, hasMore, index, items, knownTotal, loadMore, requested, restoredKey, storageKey, visible]);

  useEffect(() => {
    if (restoredKey !== storageKey || requested || !items.length) return;
    const id = items[index]?.id;
    if (id && id !== position.id) { setPosition({ id, index }); return; }
    try { localStorage.setItem(storageKey, JSON.stringify({ version: 1, id, index })); } catch { /* Optional preferences. */ }
  }, [index, items, position, requested, restoredKey, storageKey]);

  function goToIndex(target: number) {
    const next = Math.max(0, Math.min(target, knownTotal === null ? target : Math.max(0, knownTotal - 1)));
    readsLeft.current = 20;
    if (hasMore && (next >= items.length || Math.floor(next / capacity) * capacity + capacity > items.length)) setRequested({ id: null, index: next });
    else { setRequested(null); setPosition({ id: items[next]?.id || null, index: next }); }
  }
  function goToId(id: string) {
    const target = items.findIndex(item => item.id === id);
    if (target >= 0) goToIndex(target);
  }
  return { gridRef, pageItems, capacity, start, page: Math.floor(start / capacity) + 1,
    pages: knownTotal === null ? null : Math.max(1, Math.ceil(knownTotal / capacity)), total: knownTotal, restoring: Boolean(requested),
    canNext: knownTotal === null ? start + capacity < items.length || hasMore : start + capacity < knownTotal,
    previous: () => goToIndex(start - capacity), next: () => goToIndex(start + capacity), goToId,
    reset: () => { try { localStorage.removeItem(storageKey); } catch {} goToIndex(0); } };
}
