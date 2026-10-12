'use client';

import { useCallback, useEffect, useState } from 'react';

type StudioOrder = { groups: string[]; entries: string[] };
const emptyOrder = (): StudioOrder => ({ groups: [], entries: [] });
function parseOrder(raw: string | null): StudioOrder {
  const value = raw ? JSON.parse(raw) : null;
  if (!value || value.version !== 1) return emptyOrder();
  const valid = (input: unknown, maxLength: number) => Array.isArray(input)
    ? Array.from(new Set(input.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= maxLength))).slice(0, 5000) : [];
  return { groups: valid(value.groups, 160), entries: valid(value.entries, 200) };
}

/** Stable across a shared catalog entry becoming a hydrated personal binding. */
export function studioOrderKey(entry: { id: string; presetId?: string; sharedLive?: { intent: { presetId: string } } | null }) {
  const presetId = entry.presetId || entry.sharedLive?.intent.presetId || (entry.id.startsWith('shared:') ? entry.id.slice(7) : undefined);
  return presetId ? `preset:${presetId}` : `module:${entry.id}`;
}

export function orderStudioItems<T>(items: T[], saved: string[], identify: (item: T) => string): T[] {
  const ranks = new Map(saved.map((id, index) => [id, index]));
  return items.map((item, index) => ({ item, index })).sort((a, b) =>
    (ranks.get(identify(a.item)) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(identify(b.item)) ?? Number.MAX_SAFE_INTEGER)
      || a.index - b.index).map(value => value.item);
}

export function useStudioOrder(userId: string) {
  const key = `sd2:studio-order:v1:${userId}`;
  const [state, setState] = useState<{ key: string; value: StudioOrder }>({ key: '', value: emptyOrder() });
  const [error, setError] = useState('');
  useEffect(() => {
    setError('');
    try { setState({ key, value: parseOrder(localStorage.getItem(key)) }); }
    catch { setState({ key, value: emptyOrder() }); setError('本机排序无法读取，当前按默认顺序显示。'); }
    const receive = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || event.key !== key) return;
      try { setState({ key, value: parseOrder(event.newValue) }); setError(''); }
      catch { setError('另一页面的排序未能读取，已保留当前顺序。'); }
    };
    window.addEventListener('storage', receive);
    return () => window.removeEventListener('storage', receive);
  }, [key]);
  const ready = state.key === key;
  const value = ready ? state.value : emptyOrder();
  const save = useCallback((next: StudioOrder) => {
    if (state.key !== key) return false;
    try {
      // Persist before presenting success: a failed write keeps the prior order.
      localStorage.setItem(key, JSON.stringify({ version: 1, ...next }));
      setState({ key, value: next }); setError(''); return true;
    } catch { setError('排序未能保存，已保留原顺序。请允许本机存储后重试。'); return false; }
  }, [key, state.key]);
  return { ...value, ready, error, save, reset: () => save(emptyOrder()) };
}
