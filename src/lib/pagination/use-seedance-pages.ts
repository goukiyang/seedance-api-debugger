'use client';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { subscribeUploadSession, uploadSession } from '@/lib/http/upload-session';
import { isClientSessionBlocked, watchSessionExit } from '@/lib/auth/client-session-boundary';
import { createSeedancePages, emptySeedancePages, seedancePageScopeKey } from './seedance-pages';

export function useSeedanceAssetPages(visible: boolean, includeDeleted = false) {
  const [session, setSession] = useState(uploadSession);
  const ref = useRef<ReturnType<typeof createSeedancePages> | null>(null);
  if (!ref.current) ref.current = createSeedancePages({ fetch: (...args) => fetch(...args), session: uploadSession, blocked: isClientSessionBlocked });
  const pager = ref.current;
  const value = useSyncExternalStore(pager.subscribe, pager.getSnapshot, pager.getSnapshot);
  const scope = useMemo(() => ({ ...session, includeDeleted, visible }), [session, includeDeleted, visible]);
  const key = seedancePageScopeKey(scope);
  useEffect(() => subscribeUploadSession(() => setSession(uploadSession())), []);
  useEffect(() => watchSessionExit(pager.invalidate), [pager]);
  useEffect(() => { pager.setScope(scope); if (scope.visible) void pager.refresh(); return pager.invalidate; }, [pager, scope]);
  useEffect(() => () => pager.dispose(), [pager]);
  return { ...(value.scope === key ? value : emptySeedancePages(key)), refresh: pager.refresh, more: pager.more, retry: pager.retry };
}
