'use client';
import { useRef, useState } from 'react';
import { Pin, PinOff, RefreshCw } from 'lucide-react';
import type { StudioPinMutation, StudioPinState } from '@/lib/image-studio/result-pin-types';
import styles from '@/components/content-reactions/reactions.module.css';
import pinStyles from './result-pin-button.module.css';

// An uncertain request is retried only by the user, with its original identity and intent.
const pending = new Map<string, StudioPinMutation>();
export function StudioResultPinnedIndicator() {
  return <span className={pinStyles.readonly} data-studio-pin-readonly role="img" aria-label="已置顶" title="同一模板的用户可查看和点赞；只有生成者可取消置顶"><Pin size={16} aria-hidden="true" /></span>;
}
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
  return <span className={pinStyles.control} data-studio-pin-control data-active={active || undefined} data-feedback={Boolean(error || uncertain && !busy) || undefined} aria-busy={busy}
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <button type="button" className={pinStyles.button} data-studio-result-pin aria-pressed={active} aria-busy={busy}
      title={reason || (active ? '取消本模板置顶；原公共分享保留' : '置顶后，同一模板的用户可查看和点赞这张结果图')}
      aria-label={label} disabled={busy || Boolean(reason)} onClick={() => void save()}>
      {busy ? <RefreshCw size={16} className={styles.busyIcon} aria-hidden="true" /> : active ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}
    </button>
    {(error || uncertain && !busy) && <span className={`${styles.error} ${pinStyles.feedback}`} role="status">{error || '上次置顶尚未确认，请点置顶重试'}</span>}
  </span>;
}
