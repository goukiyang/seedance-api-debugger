'use client';

import { useEffect, useState } from 'react';

type ViewState = { trendOpen: boolean; metric: 'cash' | 'points'; groups: Record<string, boolean> };
const empty: ViewState = { trendOpen: true, metric: 'cash', groups: {} };

export function useUsageViewState(identity: string) {
  const key = `sd2:usage-view:v1:${identity}`;
  const [entry, setEntry] = useState<{ key: string; value: ViewState } | null>(null);
  useEffect(() => {
    let value = empty;
    try {
      const source = JSON.parse(localStorage.getItem(key) || 'null');
      if (source && typeof source === 'object') {
        const groups = Object.fromEntries(Object.entries(source.groups || {}).filter(([, open]) => typeof open === 'boolean').slice(-200)) as Record<string, boolean>;
        value = { trendOpen: source.trendOpen !== false, metric: source.metric === 'points' ? 'points' : 'cash', groups };
      }
    } catch { /* Viewing remains available when browser storage is unavailable. */ }
    setEntry({ key, value });
  }, [key]);
  const ready = entry?.key === key;
  const value = ready ? entry.value : empty;
  const update = (patch: Partial<ViewState>) => {
    if (!ready) return;
    setEntry((previous) => {
      if (previous?.key !== key) return previous;
      const next = { ...previous.value, ...patch };
      next.groups = Object.fromEntries(Object.entries(next.groups).slice(-200));
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Do not block the interaction. */ }
      return { key, value: next };
    });
  };
  return { value, ready, update };
}
