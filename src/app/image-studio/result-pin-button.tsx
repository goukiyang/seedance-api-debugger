'use client';
import { useRef, useState } from 'react';
import { Pin, PinOff, RefreshCw } from 'lucide-react';
import type { StudioPinMutation, StudioPinState } from '@/lib/image-studio/result-pin-types';
import styles from '@/components/content-reactions/reactions.module.css';

// An uncertain request is retried only by the user, with its original identity and intent.
const pending = new Map<string, StudioPinMutation>();
export function StudioResultPinButton({ userId, moduleId, taskId, assetId, state, onSaved }: {
  userId: string; moduleId: string; taskId: string; assetId: string; state: StudioPinState | null;
  onSaved: () => void;
}) {
  const identity = `${userId}:${moduleId}:${assetId}`;
  const current = useRef(identity); current.current = identity;
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const uncertain = pending.has(identity);
  const active = Boolean(state?.assetIds.includes(assetId));
  const reason = state?.disabledReason || (!state ? '正在读取置顶状态' : '');
  const label = uncertain ? '重试原置顶操作' : active ? '取消置顶' : '置顶给本模板用户';
  async function save() {
    if (!state?.presetId || lock.current) return;
    lock.current = true; setBusy(true); setError('');
    const expected = identity;
    let body = pending.get(identity);
    if (!body) {
      body = { viewerId: userId, moduleId, taskId, assetId, active: !active, expectedRevision: state.revision, requestId: crypto.randomUUID() };
      pending.set(identity, body);
    }
    try {
      const response = await fetch('/api/image-studio/result-pins', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      const result = await response.json();
      if (!response.ok) {
        if (response.status < 500) { pending.delete(identity); if (current.current === expected) onSaved(); }
        throw new Error(result.error || '置顶尚未确认，请重试');
      }
      if (!result.saved || result.viewerId !== userId) throw new Error('保存结果尚未确认，请按原操作重试');
      pending.delete(identity);
      if (current.current === expected) {
        onSaved();
        window.dispatchEvent(new CustomEvent('sd2-studio-pins-changed', { detail: { userId, moduleId } }));
      }
    } catch (cause) { if (current.current === expected) setError(cause instanceof Error ? cause.message : '置顶尚未确认，请重试'); }
    finally { lock.current = false; if (current.current === expected) setBusy(false); }
  }
  return <>
    <button type="button" data-studio-result-pin aria-pressed={active} aria-busy={busy}
      title={reason || (active ? '取消本模板置顶；原公共分享保留' : '置顶后，同一模板的用户可查看和点赞这张结果图')}
      aria-label={label} disabled={busy || Boolean(reason)} onClick={() => void save()}>
      {busy ? <RefreshCw size={15} className={styles.busyIcon} /> : active ? <PinOff size={15} /> : <Pin size={15} />}
      {active ? '已置顶' : '置顶'}
    </button>
    {(error || uncertain && !busy) && <span className={styles.error} role="status">{error || '上次置顶尚未确认，请点置顶重试'}</span>}
  </>;
}
