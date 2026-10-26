'use client';
import { useEffect, useRef, useState } from 'react';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { MULTIVIEW_SAVE_PROTOCOL } from '@/lib/video/multiview-work-contract';
type Receipt = { state: string; mutationId: string; action?: string; shareId?: string; workId?: string; href?: string; canResume?: boolean };
export function useMultiviewShareOperation(owner: string, scope: string, onReceipt: (receipt: Receipt) => void) {
  const key = `sd2:multiview-share-operation:v1:${owner}:${scope}`;
  const [pending, setPending] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [canResume, setCanResume] = useState(false);
  const live = useRef(key); live.current = key;
  const lock = useRef(false), original = useRef(''), callback = useRef(onReceipt); callback.current = onReceipt;
  useEffect(() => {
    lock.current = false; setBusy(false); setError(''); setCanResume(false);
    try { const id = localStorage.getItem(key) || ''; if (id && !/^[a-f0-9-]{36}$/.test(id)) throw new Error(); original.current = id; setPending(id); }
    catch { setError('原操作记录无法读取，尚未发送。'); original.current = 'unreadable'; setPending('unreadable'); }
    return () => { if (live.current === key) live.current = ''; };
  }, [key]);
  async function run(body?: Record<string, unknown>, resume = false) {
    if (lock.current || !owner || isClientSessionBlocked() || body && original.current || original.current === 'unreadable') return;
    const captured = key;
    let id = original.current;
    try {
      if (body) {
        const retained = localStorage.getItem(key);
        if (retained) { original.current = retained; setPending(retained); return; }
        id = crypto.randomUUID(); localStorage.setItem(key, id);
        if (localStorage.getItem(key) !== id) throw new Error('原操作编号无法保存，尚未发送。');
        original.current = id; setPending(id);
      }
      if (!id) return;
      lock.current = true; setBusy(true); setError('');
      const response = await fetch(body ? '/api/video/multiview/shares' : `/api/video/multiview/shares/mutations/${id}`, {
        method: body || resume ? 'POST' : 'GET', cache: 'no-store', headers: { 'x-app-session-user': owner, 'Content-Type': 'application/json' },
        ...(body || resume ? { body: JSON.stringify(body ? { ...body, protocol: MULTIVIEW_SAVE_PROTOCOL, mutationId: id } : {}) } : {}), signal: AbortSignal.timeout(120000) });
      const data = await response.json();
      if (live.current !== captured || isClientSessionBlocked()) return;
      if (response.ok && data.state === 'committed' && data.mutationId === id) {
        localStorage.removeItem(key); original.current = ''; setPending(''); setCanResume(false); callback.current(data); return;
      }
      if (data.state === 'rejected' && data.mutationId === id && data.notCommitted === true) { localStorage.removeItem(key); original.current = ''; setPending(''); }
      setCanResume(data.canResume === true);
      setError(data.error || (data.state === 'failed' ? '原操作未完成，可按原编号恢复。' : '原操作结果待确认，请核对原编号。'));
    } catch (cause) { if (live.current === captured) setError(cause instanceof Error ? cause.message : '操作结果待确认，请查询原编号。'); }
    finally { if (live.current === captured) { lock.current = false; setBusy(false); } }
  }
  return { pending, busy, error, canResume, send: (body: Record<string, unknown>) => run(body), query: () => run(), resume: () => run(undefined, true) };
}
