'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudioAttentionSnapshot } from '@/lib/image-studio/result-attention';

export function useResultAttention(userId: string, enabled: boolean) {
  const [state, setState] = useState<{ viewerId: string; unread: string[]; error: string; retryModuleId?: string }>({ viewerId: userId, unread: [], error: '' });
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
    setState(previous => {
      const retryModuleId = previous.viewerId === userId && previous.retryModuleId && snapshot.unreadModuleIds.includes(previous.retryModuleId) ? previous.retryModuleId : undefined;
      return { viewerId: userId, unread: snapshot.unreadModuleIds, retryModuleId, error: retryModuleId ? previous.error : '' };
    });
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
  const saveReceipt = useCallback(async (body: { moduleId: string; versions?: string[]; operation?: 'enter_template'; entrySnapshot?: string }, signal?: AbortSignal) => {
    if (!enabled || currentScope.current !== userId || signal?.aborted) return;
    const controller = new AbortController(); mutations.current.add(controller);
    const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true });
    const request = ++sequence.current;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    epoch.current += 1;
    try {
      const response = await fetch('/api/image-studio/attention', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok) throw new Error();
      const snapshot = await response.json();
      if (!controller.signal.aborted && currentScope.current === userId && (request === sequence.current || snapshot.receiptRevision > revision.current)) {
        setState(previous => previous.retryModuleId === body.moduleId ? { ...previous, retryModuleId: undefined, error: '' } : previous);
        accept(snapshot);
      }
    } catch {
      if ((!controller.signal.aborted || timedOut) && currentScope.current === userId && request === sequence.current) setState(previous => ({ ...previous, retryModuleId: body.moduleId, error: '提醒状态未能保存，请重新打开模板' }));
    } finally { window.clearTimeout(timeout); signal?.removeEventListener('abort', cancel); if (currentScope.current === userId) epoch.current += 1; mutations.current.delete(controller); }
  }, [userId, enabled, accept]);
  const markViewed = useCallback(async (moduleId: string, versions: string[]) => {
    if (versions.length) await saveReceipt({ moduleId, versions });
  }, [saveReceipt]);
  const confirmEntry = useCallback((moduleId: string, entrySnapshot: string, signal: AbortSignal) =>
    saveReceipt({ moduleId, entrySnapshot, operation: 'enter_template' }, signal), [saveReceipt]);
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
  return { unread: new Set(state.viewerId === userId ? state.unread : []), error: state.viewerId === userId ? state.error : '', retryModuleId: state.viewerId === userId ? state.retryModuleId : undefined, refresh, markViewed, confirmEntry };
}
