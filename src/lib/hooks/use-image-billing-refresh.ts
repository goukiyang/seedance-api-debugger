'use client';
import { useEffect, useRef } from 'react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { imageBillingPending, type ImageBillingView } from '@/lib/image-studio/billing-contract';

export function useImageBillingRefresh(items: { id: string; billing?: ImageBillingView | null }[], refresh: () => void | Promise<unknown>, enabled = true) {
  const { refreshCredits } = useAppSession();
  const latest = useRef({ items, refresh }); latest.current = { items, refresh };
  const previous = useRef(new Map<string, ImageBillingView>());
  const signature = JSON.stringify(items.map(item => [item.id, item.billing]));
  useEffect(() => {
    let changed = false;
    const next = new Map<string, ImageBillingView>();
    for (const item of latest.current.items) {
      if (!item.billing) continue;
      const old = previous.current.get(item.id);
      if (old && (old.chargedCredits !== item.billing.chargedCredits
        || imageBillingPending(old) && !imageBillingPending(item.billing))) changed = true;
      next.set(item.id, item.billing);
    }
    previous.current = next;
    if (changed) void refreshCredits({ force: true });
  }, [signature, refreshCredits]);
  useEffect(() => {
    if (!enabled || !latest.current.items.some(item => imageBillingPending(item.billing))) return;
    let busy = false, active = true;
    const tick = async () => {
      if (!active || busy || document.hidden) return;
      if (!latest.current.items.some(item => imageBillingPending(item.billing))) { clearInterval(timer); return; }
      busy = true;
      try { await latest.current.refresh(); } catch { /* Keep the existing page's error and retry handling. */ }
      finally { busy = false; }
    };
    const visible = () => { if (!document.hidden) void tick(); };
    const timer = setInterval(() => void tick(), 15000);
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [signature, enabled]);
}
