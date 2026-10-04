'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudioAttentionSnapshot } from '@/lib/image-studio/result-attention';

export function useResultAttention(userId: string, enabled: boolean) {
  const [state, setState] = useState<{ viewerId: string; unread: string[]; error: string }>({ viewerId: userId, unread: [], error: '' });
  const currentScope = useRef(userId); currentScope.current = userId;
  const epoch = useRef(0);
  const revision = useRef(0);
  const sequence = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  const lastRead = useRef(0);
  const mutations = useRef(new Set<AbortController>());
  const accept = useCallback((snapshot: StudioAttentionSnapshot) => {
    if (snapshot.viewerId !== userId || currentScope.current !== userId || !Number.isInteger(snapshot.receiptRevision) || snapshot.receiptRevision < revision.current
      || !Array.isArray(snapshot.unreadModuleIds) || snapshot.unreadModuleIds.some(id => typeof id !== 'string')) return;
    revision.current = snapshot.receiptRevision;
    setState({ viewerId: userId, unread: snapshot.unreadModuleIds, error: '' });
  }, [userId]);
  const refresh = useCallback(async (force = false) => {
    if (!enabled || mutations.current.size || (!force && (inFlight.current || Date.now() - lastRead.current < 10000))) return;
    if (force) inFlight.current?.abort();
    lastRead.current = Date.now();
    const controller = new AbortController(); inFlight.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    const startedEpoch = epoch.current, request = ++sequence.current;
    try {
      const response = await fetch('/api/image-studio/attention', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error();
      const snapshot = await response.json();
      if (!controller.signal.aborted && startedEpoch === epoch.current && request === sequence.current) accept(snapshot);
    } catch {
      if ((!controller.signal.aborted || timedOut) && currentScope.current === userId && startedEpoch === epoch.current && request === sequence.current) setState(previous => ({ ...previous, error: '未读状态读取失败' }));
    } finally { window.clearTimeout(timeout); if (inFlight.current === controller) inFlight.current = null; }
  }, [userId, enabled, accept]);
  const markViewed = useCallback(async (moduleId: string, versions: string[]) => {
    if (!enabled || !versions.length) return;
    const controller = new AbortController(); mutations.current.add(controller);
    const request = ++sequence.current;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    epoch.current += 1;
    try {
      const response = await fetch('/api/image-studio/attention', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moduleId, versions }), signal: controller.signal });
      if (!response.ok) throw new Error();
      const snapshot = await response.json();
      if (!controller.signal.aborted && (request === sequence.current || snapshot.receiptRevision > revision.current)) accept(snapshot);
    } catch {
      if ((!controller.signal.aborted || timedOut) && currentScope.current === userId && request === sequence.current) setState(previous => ({ ...previous, error: '已读未能保存，请重新打开模板' }));
    } finally { window.clearTimeout(timeout); if (currentScope.current === userId) epoch.current += 1; mutations.current.delete(controller); }
  }, [userId, enabled, accept]);
  useEffect(() => {
    epoch.current += 1; revision.current = 0; lastRead.current = 0;
    setState({ viewerId: userId, unread: [], error: '' });
    void refresh(true);
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 30000);
    const foreground = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', foreground);
    return () => {
      epoch.current += 1; inFlight.current?.abort(); inFlight.current = null;
      mutations.current.forEach(controller => controller.abort()); mutations.current.clear();
      window.clearInterval(timer); document.removeEventListener('visibilitychange', foreground);
    };
  }, [userId, refresh]);
  return { unread: new Set(state.viewerId === userId ? state.unread : []), error: state.viewerId === userId ? state.error : '', refresh, markViewed };
}
