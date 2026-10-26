'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GalleryQuery, GalleryQueryResult } from '@/lib/image-studio/gallery-types';
import { watchReactionChanges } from '@/components/content-reactions/ContentReactions';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';

export function useGalleryCatalog(userId: string, query: GalleryQuery, enabled: boolean) {
  const { sessionChanged } = useAppSession();
  const [page, setPageState] = useState({ page: 1, pageSize: 12 });
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ owner: string; data: GalleryQueryResult | null; loading: boolean; error: string; denied?: boolean }>({ owner: '', data: null, loading: true, error: '' });
  const scope = JSON.stringify([userId, query]), current = useRef(scope); current.current = scope;
  const latest = useRef(state); latest.current = state;
  const resultScope = useRef('');
  const refresh = useCallback(() => setTick(value => value + 1), []);
  const setPage = useCallback((next: number, pageSize: number) => setPageState(previous => previous.page === next && previous.pageSize === pageSize ? previous : { page: next, pageSize }), []);
  useEffect(() => watchReactionChanges(userId, refresh), [userId, refresh]);
  useEffect(() => {
    const resume = () => { if (!document.hidden) refresh(); };
    window.addEventListener('focus', resume); window.addEventListener('online', resume); document.addEventListener('visibilitychange', resume);
    return () => { window.removeEventListener('focus', resume); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume); };
  }, [refresh]);
  useEffect(() => {
    if (!enabled || sessionChanged || isClientSessionBlocked()) return;
    const controller = new AbortController(), owner = scope;
    let valid = true;
    const previous = latest.current.owner === userId ? latest.current.data : null;
    setState({ owner: userId, data: previous, loading: true, error: '' });
    const run = async () => {
      const revision = resultScope.current === scope ? previous?.catalogRevision : undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch('/api/image-studio/gallery/query', { method: 'POST', cache: 'no-store',
          signal: controller.signal, headers: { 'Content-Type': 'application/json', 'x-app-session-user': userId }, body: JSON.stringify({ ...query, ...page,
            ...(attempt === 0 && revision ? { catalogRevision: revision } : {}) }) });
        const result = await response.json();
        if (!valid || current.current !== owner || isClientSessionBlocked()) return;
        if (result.code === 'account-changed') { setState({ owner: userId, data: null, loading: false, denied: true, error: result.error }); return; }
        if (response.status === 409 && attempt === 0) continue;
        if (!response.ok) {
          if ([401, 403].includes(response.status)) setState({ owner: userId, data: null, loading: false, denied: true, error: result.error || '无权读取封面' });
          throw new Error(result.error || '封面目录未能读取');
        }
        if (result.capabilities?.independentReactions !== true || !Array.isArray(result.items) || !Array.isArray(result.navigation) || !Array.isArray(result.matches)) throw new Error('封面目录协议暂不可用');
        resultScope.current = scope;
        setState({ owner: userId, data: result, loading: false, error: '' }); return;
      }
    };
    void run().catch(error => { if (valid && current.current === owner && !controller.signal.aborted) setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : '封面目录未能读取' })); });
    return () => { valid = false; controller.abort(); };
  }, [userId, scope, page, tick, enabled, sessionChanged]); // query fields are covered by scope.
  return { data: !sessionChanged && !isClientSessionBlocked() && state.owner === userId ? state.data : null, loading: state.owner !== userId || state.loading || !state.error && resultScope.current !== scope,
    error: state.owner === userId ? state.error : '', denied: state.owner === userId && state.denied === true, setPage, refresh };
}
