'use client';

import { useEffect, useRef, useState } from 'react';
import type { StudioModuleSharingPreference } from '@/lib/image-studio/module-sharing-preference';
import type { SharedStudioLiveDTO } from '@/lib/image-studio/shared-types';

export type ModuleSharingResult = { id: string; revision: number; canChooseSharing: boolean; sharingPreference: StudioModuleSharingPreference | null;
  sourcePresetId?: string | null; sourcePresetShared?: boolean | null; sharedLive?: SharedStudioLiveDTO | null };

type Command = { id: string; revision: number; isShared: boolean; requestId: string; action?: 'set-sharing-preference' | 'share-saved-module' };
// Both cover and editor retain the same original command when its response is lost.
export function useModuleSharingPreference(userId: string, onSettled: (module: ModuleSharingResult) => void) {
  const active = useRef(userId); active.current = userId;
  const lock = useRef(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const prefix = `sd2:module-sharing-preference:v1:${encodeURIComponent(userId)}:`;
    const saved: Record<string, boolean> = {};
    try { for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) saved[decodeURIComponent(key.slice(prefix.length))] = true; }
    catch { /* Submitting remains disabled by the durable-storage check. */ }
    setPending(saved); setBusyId(null);
  }, [userId]);
  async function submit(id: string, revision: number, isShared: boolean) {
    if (lock.current) throw new Error('请等当前共享设置完成');
    const owner = userId, key = `sd2:module-sharing-preference:v1:${encodeURIComponent(owner)}:${encodeURIComponent(id)}`;
    let command: Command;
    try {
      const saved = localStorage.getItem(key);
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
      const response = await fetch('/api/image-studio/modules', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: command.action || 'set-sharing-preference', ...command, entryPoint: 'workbench' }), signal: AbortSignal.timeout(15000) });
      const result = await response.json();
      if (!response.ok) {
        if ([400, 401, 403, 404, 409, 428].includes(response.status)) clear();
        throw new Error(result.error || '共享选择保存未确认，请核对原操作');
      }
      const receipt = result.sharingCommandReceipt;
      if (receipt?.action !== (command.action || 'set-sharing-preference') || receipt.requestId !== command.requestId
        || receipt.moduleId !== id || receipt.expectedRevision !== command.revision) {
        throw new Error('共享选择尚未确认，请重试原操作，当前内容保留');
      }
      clear();
      if (active.current !== owner) throw new Error('账号已切换，请重新读取共享状态');
      onSettled(result);
      return result as ModuleSharingResult;
    } catch (cause) {
      if (cause instanceof TypeError || cause instanceof DOMException) throw new Error('共享结果待确认，请点击开关核对原操作，当前内容保留');
      throw cause;
    } finally { lock.current = false; if (active.current === owner) setBusyId(null); }
  }
  return { submit, busyId, pending };
}
