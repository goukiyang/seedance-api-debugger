'use client';
import { useEffect, useRef, useState } from 'react';
import { Pin, RefreshCw } from 'lucide-react';
import type { StudioPinMutation, StudioPinState } from '@/lib/image-studio/result-pin-types';
import styles from '@/components/content-reactions/reactions.module.css';
import pinStyles from './result-pin-button.module.css';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { pinRequestKey, readPinRequest, rememberPinRequest } from './pin-request-storage';

// An uncertain request is retried only by the user, with its original identity and intent.
export function StudioResultPinnedIndicator({ showLabel = false }: { showLabel?: boolean }) {
  return <span className={showLabel ? pinStyles.menuReadonly : pinStyles.readonly} data-studio-pin-readonly role="img" aria-label="已置顶" title="同一模板的用户可查看和点赞；只有生成者可取消置顶"><Pin size={16} className={pinStyles.pinIcon} aria-hidden="true" />{showLabel && '已置顶'}</span>;
}
export function StudioResultPinButton({ userId, moduleId, taskId, assetId, state, onSaved, onPublish, showLabel = false, disabledReason }: {
  userId: string; moduleId: string; taskId: string; assetId: string; state: StudioPinState | null;
  onSaved: () => void; onPublish?: () => void; showLabel?: boolean; disabledReason?: string | null;
}) {
  const identity = `${userId}:${moduleId}:${assetId}`;
  const current = useRef(identity); current.current = identity;
  const alive = useRef(true), savedCallback = useRef(onSaved); savedCallback.current = onSaved;
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retained, setRetained] = useState<StudioPinMutation | null>(null), [loadedIdentity, setLoadedIdentity] = useState('');
  const original = retained?.viewerId === userId && retained.moduleId === moduleId && retained.assetId === assetId ? retained : null;
  const uncertain = Boolean(original);
  const active = state?.ownAssetIds ? state.ownAssetIds.includes(assetId)
    : state?.ownPins ? state.ownPins.some(pin => pin.assetId === assetId) : Boolean(state?.assetIds.includes(assetId));
  const reason = loadedIdentity !== identity ? '正在读取置顶状态' : !state ? '正在读取置顶状态'
    : !active && !uncertain ? state.disabledReason || disabledReason : '';
  useEffect(() => {
    alive.current = true; lock.current = false; setBusy(false); setError('');
    const read = () => { setRetained(readPinRequest(userId, moduleId, assetId)); setLoadedIdentity(identity); };
    const changed = (event: Event) => { if ((event as CustomEvent).detail === pinRequestKey(userId, moduleId, assetId)) read(); };
    read(); window.addEventListener('sd2-studio-pin-pending', changed);
    return () => { alive.current = false; window.removeEventListener('sd2-studio-pin-pending', changed); };
  }, [identity, userId, moduleId, assetId]);
  useEffect(() => {
    if (!original || isClientSessionBlocked()) return;
    const controller = new AbortController();
    const query = new URLSearchParams(Object.entries(original).map(([key, value]) => [key, String(value)]));
    void fetch(`/api/image-studio/result-pins?${query}`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
      .then(response => response.ok ? response.json() : null).then(result => {
        if (controller.signal.aborted || !alive.current || current.current !== identity || isClientSessionBlocked()) return;
        if (result?.viewerId === userId && result.status === 'completed') {
          rememberPinRequest(original, true); savedCallback.current();
        }
      }).catch(() => { /* A missing read receipt remains unknown; never replay here. */ });
    return () => controller.abort();
  }, [original, identity, userId]);
  const needsPublication = Boolean(onPublish && state && !state.presetId && !uncertain);
  const label = needsPublication ? '保存并共享模板后置顶' : uncertain ? '重试原置顶操作' : active ? '取消置顶' : '置顶给本模板用户';
  async function save() {
    if (!state?.presetId || lock.current || isClientSessionBlocked()) return;
    lock.current = true; setBusy(true); setError('');
    const expected = identity;
    let body = readPinRequest(userId, moduleId, assetId);
    let persisted = true;
    if (!body) {
      body = { viewerId: userId, moduleId, taskId, assetId, active: !active, expectedRevision: state.revision, requestId: crypto.randomUUID(), presetId: state.presetId };
      persisted = rememberPinRequest(body);
    }
    try {
      const response = await fetch('/api/image-studio/result-pins', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      const result = await response.json();
      if (!response.ok) {
        if (response.status < 500) { rememberPinRequest(body, true); if (alive.current && current.current === expected) onSaved(); }
        throw new Error(result.error || '置顶尚未确认，请重试');
      }
      if (!result.saved || result.viewerId !== userId) throw new Error('保存结果尚未确认，请按原操作重试');
      rememberPinRequest(body, true);
      if (alive.current && current.current === expected && !isClientSessionBlocked()) {
        onSaved();
        window.dispatchEvent(new CustomEvent('sd2-studio-pins-changed', { detail: { userId, moduleId } }));
      }
    } catch (cause) { if (alive.current && current.current === expected) setError((cause instanceof Error ? cause.message : '置顶尚未确认，请重试')
      + (!persisted ? '；浏览器未能保留核对记录，请在本页继续核对' : '')); }
    finally { lock.current = false; if (alive.current && current.current === expected) setBusy(false); }
  }
  return <span className={pinStyles.control} data-studio-pin-control data-active={active || undefined} data-feedback={Boolean(error || uncertain && !busy) || undefined} aria-busy={busy}
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
    onKeyDown={event => { if (!showLabel) event.stopPropagation(); }} onDoubleClick={event => event.stopPropagation()}>
    <button type="button" role={showLabel ? 'menuitem' : undefined} className={showLabel ? pinStyles.menuButton : pinStyles.button} data-studio-result-pin aria-pressed={active} aria-busy={busy}
      title={needsPublication ? '先保存并共享模板，再置顶给同事；点击打开模板设置' : reason || (active ? '取消本模板置顶；原公共分享保留' : '置顶后，同一模板的用户可查看和点赞这张结果图')}
      aria-label={label} disabled={busy || Boolean(reason) && !needsPublication} onClick={() => { if (needsPublication) onPublish?.(); else void save(); }}>
      {busy ? <RefreshCw size={16} className={styles.busyIcon} aria-hidden="true" /> : <Pin size={16} className={pinStyles.pinIcon} aria-hidden="true" />}
      {showLabel && (busy ? '正在保存' : uncertain ? '核对原置顶操作' : active ? '取消置顶' : '置顶')}
    </button>
    {(error || uncertain && !busy || showLabel && reason && !needsPublication) && <span className={`${styles.error} ${pinStyles.feedback}`} role="status">{error || (uncertain ? '上次置顶尚未确认，请点置顶重试' : reason)}</span>}
  </span>;
}
