'use client';

import { useEffect, useState } from 'react';
import { readListReturn } from '@/lib/navigation/return-to';

export function useReturnAnchor(owner: string | undefined, ready: boolean) {
  const [unavailable, setUnavailable] = useState('');
  useEffect(() => {
    if (!owner || !ready) return;
    const address = new URL(window.location.href);
    const item = readListReturn(address.searchParams).item;
    if (!item) return;

    const row = document.querySelector<HTMLElement>(`[data-list-return="${CSS.escape(item)}"]`);
    if (!row) {
      address.searchParams.delete('list_item');
      window.history.replaceState(window.history.state, '', address);
      setUnavailable(owner);
      return;
    }

    const frame = requestAnimationFrame(() => {
      const current = new URL(window.location.href);
      if (!row.isConnected || current.pathname !== address.pathname || current.searchParams.get('list_item') !== item) return;
      current.searchParams.delete('list_item');
      window.history.replaceState(window.history.state, '', current);
      if (document.activeElement !== document.body) return;
      row.scrollIntoView({ block: 'nearest' });
      const target = row.matches('a, button:not([disabled]), [tabindex]') ? row : row.querySelector<HTMLElement>('a, button:not([disabled]), [tabindex]');
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [owner, ready]);
  return Boolean(owner && unavailable === owner);
}
