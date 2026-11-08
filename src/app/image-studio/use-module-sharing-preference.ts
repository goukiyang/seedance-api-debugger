'use client';

import { useEffect, useRef, useState } from 'react';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import type { StudioModuleSharingPreference } from '@/lib/image-studio/module-sharing-preference';
import type { SharedStudioLiveDTO } from '@/lib/image-studio/shared-types';

export type ModuleSharingResult = { id: string; revision: number; canChooseSharing: boolean; sharingPreference: StudioModuleSharingPreference | null;
  sourcePresetId?: string | null; sourcePresetShared?: boolean | null; sharedLive?: SharedStudioLiveDTO | null };

type Command = { id: string; revision: number; isShared: boolean; requestId: string; action?: 'set-sharing-preference' | 'share-saved-module' };
// Both cover and editor retain the same original command when its response is lost.
export function useModuleSharingPreference(userId: string, onSettled: (module: ModuleSharingResult) => void) {
  const active = useRef(userId); active.current = userId;
  const lock = useRef(false);
  const settled = useRef(onSettled); settled.current = onSettled;
  const reconnectAttempts = useRef(new Map<string, number>());
  const [reconnect, setReconnect] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const prefix = `sd2:module-sharing-preference:v1:${encodeURIComponent(userId)}:`;
    const saved: Record<string, boolean> = {};
    try { for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) saved[decodeURIComponent(key.slice(prefix.length))] = true; }
    catch { /* Submitting remains disabled by the durable-storage check. */ }
    reconnectAttempts.current.clear(); setPending(saved); setBusyId(null);
    const resume = () => { if (!document.hidden && !isClientSessionBlocked()) { reconnectAttempts.current.clear(); setReconnect(value => value + 1); } };
    window.addEventListener('online', resume); document.addEventListener('visibilitychange', resume);
    return () => { window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume); };
  }, [userId]);
  async function submit(id: string, revision: number, isShared: boolean, queryOnly = false) {
    if (lock.current || isClientSessionBlocked()) throw new Error('请等当前共享设置完成');
    const owner = userId, key = `sd2:module-sharing-preference:v1:${encodeURIComponent(owner)}:${encodeURIComponent(id)}`;
    let command: Command;
    let retained = false;
    try {
      const saved = localStorage.getItem(key);
      if (queryOnly && !saved) throw new Error('原操作记录已变化，本次没有发送');
      retained = Boolean(saved);
      command = saved ? JSON.parse(saved) : { id, revision, isShared, requestId: crypto.randomUUID(), action: isShared ? 'share-saved-module' : 'set-sharing-preference' };
      if (command.id !== id || !Number.isSafeInteger(command.revision) || typeof command.isShared !== 'boolean'
        || typeof command.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(command.requestId)
        || command.action !== undefined && !['set-sharing-preference', 'share-saved-module'].includes(command.action)) throw new Error();
      const raw = JSON.stringify(command); localStorage.setItem(key, raw);
      if (localStorage.getItem(key) !== raw) throw new Error();
    } catch { throw new Error('原共享请求无法保存或读取，本次未发送，当前内容保留'); }
    const clear = () => {
      if (localStorage.getItem(key) === JSON.stringify(command)) localStorage.removeItem(key);
      if (active.current === owner) setPending(items => { const next = { ...items }; delete next[id]; return next; });
    };
    lock.current = true; setBusyId(id); setPending(items => ({ ...items, [id]: true }));
    try {
      const params = new URLSearchParams({ mode: 'sharing-status', id, requestId: command.requestId, revision: String(command.revision), isShared: String(command.isShared), action: command.action || 'set-sharing-preference' });
      const response = await fetch(retained ? `/api/image-studio/modules?${params}` : '/api/image-studio/modules', {
        method: retained ? 'GET' : 'PUT', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'x-app-session-user': owner },
        ...(retained ? {} : { body: JSON.stringify({ action: command.action || 'set-sharing-preference', ...command, entryPoint: 'workbench' }) }), signal: AbortSignal.timeout(15000) });
      const value = await response.json();
      if (active.current !== owner || isClientSessionBlocked()) throw new Error('账号已变化，原操作仍待确认');
      if (!response.ok) {
        const outcome = value.commandOutcome;
        if (!retained && outcome?.status === 'not-applied' && outcome.actorId === owner && outcome.moduleId === id && outcome.requestId === command.requestId) clear();
        throw new Error(value.error || '共享选择保存未确认，请核对原操作');
      }
      if (retained && value.status !== 'completed') throw new Error('尚未查到原共享回执，原操作保留');
      const result = retained ? value.result : value;
      const receipt = result.sharingCommandReceipt;
      if (receipt?.action !== (command.action || 'set-sharing-preference') || receipt.requestId !== command.requestId
        || receipt.moduleId !== id || receipt.expectedRevision !== command.revision) {
        throw new Error('共享选择尚未确认，请重试原操作，当前内容保留');
      }
      clear();
      if (active.current !== owner) throw new Error('账号已切换，请重新读取共享状态');
      try { settled.current(result); } catch { /* A refresh failure never invalidates a confirmed receipt. */ }
      return result as ModuleSharingResult;
    } catch (cause) {
      if (cause instanceof TypeError || cause instanceof DOMException) throw new Error('共享结果待确认，请点击开关核对原操作，当前内容保留');
      throw cause;
    } finally { lock.current = false; if (active.current === owner) setBusyId(null); }
  }
  const submitRef = useRef(submit); submitRef.current = submit;
  useEffect(() => {
    if (busyId || document.hidden || !navigator.onLine || isClientSessionBlocked()) return;
    const id = Object.keys(pending).find(key => (reconnectAttempts.current.get(key) || 0) < 3);
    if (!id) return;
    const count = reconnectAttempts.current.get(id) || 0;
    const timer = setTimeout(() => {
      reconnectAttempts.current.set(id, count + 1);
      // submit detects the persisted command and performs GET only.
      void submitRef.current(id, 0, false, true).catch(() => {}).finally(() => setReconnect(value => value + 1));
    }, [1000, 3000, 8000][count]);
    return () => clearTimeout(timer);
  }, [userId, pending, busyId, reconnect]);
  return { submit, busyId, pending };
}
