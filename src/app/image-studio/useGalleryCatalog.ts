'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GalleryQuery, GalleryQueryResult } from '@/lib/image-studio/gallery-types';
import { watchReactionChanges } from '@/components/content-reactions/ContentReactions';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';

type GalleryRefreshOptions = { invalidateRevision?: true };
type SharedDirectoryRevision = { revision: string; active: boolean };

export function useGalleryCatalog(userId: string, query: GalleryQuery, enabled: boolean, shared?: SharedDirectoryRevision) {
  const { sessionChanged } = useAppSession();
  const [page, setPageState] = useState({ page: 1, pageSize: 12 });
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ owner: string; data: GalleryQueryResult | null; loading: boolean; error: string; denied?: boolean }>({ owner: '', data: null, loading: true, error: '' });
  const scope = JSON.stringify([userId, query]), current = useRef(scope); current.current = scope;
  const latest = useRef(state); latest.current = state;
  const resultScope = useRef('');
  const activeRead = useRef<AbortController | null>(null);
  const reconnectReads = useRef({ scope: '', count: 0 });
  const revisionInvalidationEpoch = useRef(0);
  const revisionInvalidation = useRef<{ scope: string; epoch: number } | null>(null);
  const pendingSharedRevision = useRef<{ owner: string; scope: string; revision: string } | null>(null);
  const observedShared = useRef({ owner: userId, scope, revision: '', active: false });
  if (observedShared.current.owner !== userId) observedShared.current = { owner: userId, scope, revision: '', active: false };
  if (pendingSharedRevision.current?.scope !== scope || sessionChanged || isClientSessionBlocked()) pendingSharedRevision.current = null;
  const sharedRevision = shared?.revision || '', sharedActive = shared?.active === true;
  const refresh = useCallback((options?: GalleryRefreshOptions) => {
    pendingSharedRevision.current = null;
    if (options?.invalidateRevision) {
      revisionInvalidationEpoch.current += 1;
      revisionInvalidation.current = { scope: current.current, epoch: revisionInvalidationEpoch.current };
    }
    setTick(value => value + 1);
  }, []);
  const setPage = useCallback((next: number, pageSize: number) => setPageState(previous => previous.page === next && previous.pageSize === pageSize ? previous : { page: next, pageSize }), []);
  useEffect(() => watchReactionChanges(userId, refresh), [userId, refresh]);
  useEffect(() => {
    const resume = (event: Event) => {
      if (!document.hidden && (event.type === 'online' || !activeRead.current)) refresh();
    };
    window.addEventListener('focus', resume); window.addEventListener('online', resume); document.addEventListener('visibilitychange', resume);
    return () => { window.removeEventListener('focus', resume); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume); };
  }, [refresh]);
  useEffect(() => {
    const previous = observedShared.current;
    observedShared.current = { owner: userId, scope: current.current, revision: sharedRevision, active: sharedActive };
    if (!sharedActive || sessionChanged || isClientSessionBlocked()) { pendingSharedRevision.current = null; return; }
    if (previous.revision === sharedRevision && previous.active === sharedActive || !previous.revision && !sharedRevision) return;
    // Returning with a changed query already starts its own fresh read.
    if (previous.revision === sharedRevision && previous.scope !== current.current) return;
    if (!previous.revision && sharedRevision && !(latest.current.owner === userId && (latest.current.data || latest.current.denied))) {
      pendingSharedRevision.current = { owner: userId, scope: current.current, revision: sharedRevision };
      return;
    }
    refresh(previous.revision !== sharedRevision ? { invalidateRevision: true } : undefined);
  }, [userId, sharedRevision, sharedActive, sessionChanged, refresh]);
  useEffect(() => {
    if (!enabled || sessionChanged || isClientSessionBlocked()) return;
    const controller = new AbortController(), owner = scope;
    activeRead.current = controller;
    const epoch = revisionInvalidationEpoch.current, invalidation = revisionInvalidation.current;
    const revisionInvalidated = invalidation?.scope === scope && invalidation.epoch === epoch;
    let valid = true;
    const previous = latest.current.owner === userId ? latest.current.data : null;
    setState({ owner: userId, data: previous, loading: true, error: '' });
    const run = async () => {
      const revision = !revisionInvalidated && resultScope.current === scope ? previous?.catalogRevision : undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch('/api/image-studio/gallery/query', { method: 'POST', cache: 'no-store',
          signal: controller.signal, headers: { 'Content-Type': 'application/json', 'x-app-session-user': userId }, body: JSON.stringify({ protocol: 'catalog-paged-v2', ...query, ...page,
            ...(attempt === 0 && revision ? { catalogRevision: revision } : {}) }) });
        const result = await response.json();
        if (!valid || current.current !== owner || revisionInvalidationEpoch.current !== epoch || isClientSessionBlocked()) return;
        if (result.code === 'account-changed') { pendingSharedRevision.current = null; setState({ owner: userId, data: null, loading: false, denied: true, error: result.error }); return; }
        if (response.status === 409 && attempt === 0) continue;
        if (!response.ok) {
          if ([401, 403].includes(response.status)) { pendingSharedRevision.current = null; setState({ owner: userId, data: null, loading: false, denied: true, error: result.error || '无权读取封面' }); }
          throw new Error(result.error || '封面目录未能读取');
        }
        if (result.capabilities?.independentReactions !== true || !Array.isArray(result.items) || !Array.isArray(result.navigation) || !Array.isArray(result.matches)) throw new Error('封面目录协议暂不可用');
        const pending = pendingSharedRevision.current;
        pendingSharedRevision.current = null;
        if (pending?.owner === userId && pending.scope === scope
          && (result.protocol !== 'catalog-paged-v2' || result.directoryRevision !== pending.revision)) {
          refresh({ invalidateRevision: true }); return;
        }
        if (revisionInvalidated && revisionInvalidation.current === invalidation) revisionInvalidation.current = null;
        resultScope.current = scope;
        setState({ owner: userId, data: result, loading: false, error: '' }); return;
      }
    };
    void run().catch(error => { if (valid && current.current === owner && revisionInvalidationEpoch.current === epoch && !controller.signal.aborted) setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : '封面目录未能读取' })); })
      .finally(() => { if (activeRead.current === controller) activeRead.current = null; });
    return () => { valid = false; controller.abort(); if (activeRead.current === controller) activeRead.current = null; };
  }, [userId, scope, page, tick, enabled, sessionChanged, refresh]); // query fields are covered by scope.
  const data = !sessionChanged && !isClientSessionBlocked() && state.owner === userId ? state.data : null;
  useEffect(() => {
    const key = JSON.stringify([scope, page]);
    if (reconnectReads.current.scope !== key || !state.loading && !state.error) reconnectReads.current = { scope: key, count: 0 };
    if (!enabled || state.owner !== userId || !state.error || state.denied || state.loading || sessionChanged || isClientSessionBlocked()
      || document.hidden || !navigator.onLine || reconnectReads.current.count >= 3) return;
    const count = reconnectReads.current.count;
    const timer = setTimeout(() => { reconnectReads.current.count++; refresh(); }, [1000, 3000, 8000][count]);
    return () => clearTimeout(timer);
  }, [enabled, scope, page, state.owner, state.error, state.denied, state.loading, sessionChanged, userId, refresh]);
  return { data, matchingScope: Boolean(data && !state.denied && !state.error && resultScope.current === scope && revisionInvalidation.current?.scope !== scope),
    loading: state.owner !== userId || state.loading || !state.error && resultScope.current !== scope,
    error: state.owner === userId ? state.error : '', denied: state.owner === userId && state.denied === true, setPage, refresh };
}
