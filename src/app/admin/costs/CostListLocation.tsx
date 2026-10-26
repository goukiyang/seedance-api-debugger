'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

export default function CostListLocation({ accountId, query }: { accountId: string; query: string }) {
  const router = useRouter(), ready = useRef(false), restoring = useRef(false);
  const restoreFrom = useRef<string | null>(null);
  const storageKey = `sd2-admin-cost-list-v1:${accountId}`;
  useEffect(() => {
    if (!window.location.search) {
      try {
        const saved: unknown = JSON.parse(localStorage.getItem(storageKey) || 'null');
        if (typeof saved === 'string' && saved.length <= 2000 && saved) {
          const values = new URLSearchParams(saved), safe = new URLSearchParams();
          for (const key of ['source', 'cost_status', 'owner_user_id', 'project_id', 'date_from', 'date_to', 'resolution', 'page', 'page_size', 'task_page']) {
            const value = values.get(key); if (value && value.length <= 120) safe.set(key, value);
          }
          if (safe.size) { restoring.current = true; restoreFrom.current = query; router.replace(`/admin/costs?${safe}`, { scroll: false }); }
        }
      } catch { /* Safe filter recovery is optional. */ }
    }
    ready.current = true;
  }, [router, storageKey]);
  useEffect(() => {
    if (!ready.current) return;
    if (restoring.current && restoreFrom.current === query) return;
    restoring.current = false;
    const safe = new URLSearchParams(query); safe.delete('keyword');
    try { localStorage.setItem(storageKey, JSON.stringify(safe.toString())); } catch { /* Never store financial rows or free text. */ }
  }, [query, storageKey]);
  return null;
}
