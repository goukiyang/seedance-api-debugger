'use client';
import { useEffect, useRef, useState } from 'react';
import { Bookmark, Heart, RefreshCw, RotateCw } from 'lucide-react';
import type { ReactionState } from '@/lib/content-reactions/types';
import type { IndependentReactionMutation } from '@/lib/content-reactions/independent';
import { invalidateReaction, watchReactionChanges } from './ContentReactions';
import styles from './GalleryReactionButtons.module.css';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';

export function GalleryReactionButtons({ userId, initial, enabled }: { userId: string; initial: ReactionState; enabled: boolean }) {
  const { sessionChanged } = useAppSession();
  const identity = `${userId}:${initial.key}`, current = useRef(identity); current.current = identity;
  const recordKey = `sd2:gallery-reaction:v2:${encodeURIComponent(userId)}:${encodeURIComponent(initial.key)}`;
  const [value, setValue] = useState(initial), [pending, setPending] = useState<IndependentReactionMutation | null>(null);
  const [renderOwner, setRenderOwner] = useState(identity);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  useEffect(() => { setValue(previous => previous.key === initial.key && previous.version > initial.version ? previous : initial); }, [initial]);
  const store = (next: IndependentReactionMutation | null) => {
    try { if (next) localStorage.setItem(recordKey, JSON.stringify(next)); else localStorage.removeItem(recordKey); }
    catch { if (next) return false; }
    setPending(next);
    return true;
  };
  const read = async (operation?: IndependentReactionMutation | null) => {
    if (sessionChanged || isClientSessionBlocked()) return;
    const owner = identity;
    const response = await fetch(`/api/content-reactions/independent?key=${encodeURIComponent(initial.key)}${operation ? `&requestId=${encodeURIComponent(operation.requestId)}` : ''}`, { cache: 'no-store', headers: { 'x-app-session-user': userId } });
    const result = await response.json();
    if (current.current !== owner || isClientSessionBlocked()) return;
    if (!response.ok || result.protocol !== 2) throw new Error(result.error || '互动状态未能读取');
    if (result.state?.key === initial.key) setValue(result.state);
    if (operation && result.status === 'committed') { store(null); setError(''); invalidateReaction(userId, initial.key); }
    else if (operation) setError('原操作待确认');
  };
  useEffect(() => {
    lock.current = false; setBusy(false); setPending(null); setError(''); setValue(initial); setRenderOwner(identity);
    try {
      const raw = localStorage.getItem(recordKey);
      const saved = raw && raw.length <= 4096 ? JSON.parse(raw) : null;
      if (saved?.protocol === 2 && saved.viewerId === userId && saved.key === initial.key && ['like', 'favorite'].includes(saved.action)
        && typeof saved.active === 'boolean' && Number.isSafeInteger(saved.expectedVersion) && saved.expectedVersion >= 0
        && typeof saved.requestId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(saved.requestId)) {
        setPending(saved); void read(saved).catch(() => { if (current.current === identity) setError('原操作待确认'); });
      }
    } catch { /* Invalid records never become commands. */ }
    return watchReactionChanges(userId, () => { void read().catch(() => undefined); });
  }, [identity, recordKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async (operation: IndependentReactionMutation) => {
    if (lock.current || !enabled || sessionChanged || isClientSessionBlocked()) return;
    if (!store(operation)) { setError('本地记录无法保存，尚未提交'); return; }
    lock.current = true; setBusy(true); setError('');
    const owner = identity;
    try {
      const response = await fetch('/api/content-reactions/independent', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation) });
      const result = await response.json();
      if (current.current !== owner || isClientSessionBlocked()) return;
      if (result.code === 'account-changed') { setError('账号已变化，原操作仍保留'); return; }
      if (response.status === 409) { store(null); await read(); setError('状态已变化，请重新选择'); return; }
      if (!response.ok || result.protocol !== 2 || result.status !== 'committed') {
        // Auth/content denial cannot disprove an earlier acceptance of this original id.
        throw new Error(result.error || '原操作待确认');
      }
      store(null); setValue(result.state); invalidateReaction(userId, initial.key);
    } catch (cause) { if (current.current === owner) setError(cause instanceof Error ? cause.message : '原操作待确认'); }
    finally { if (current.current === owner) { lock.current = false; setBusy(false); } }
  };
  const act = (action: 'like' | 'favorite') => {
    if (pending) return;
    void submit({ protocol: 2, viewerId: userId, key: initial.key, action, active: action === 'like' ? !value.liked : !value.favorited,
      expectedVersion: value.version, requestId: crypto.randomUUID() });
  };
  if (renderOwner !== identity || sessionChanged || isClientSessionBlocked()) return null;
  return <div className={styles.actions} data-active={value.liked || value.favorited || Boolean(pending)} onClick={event => event.stopPropagation()}>
    <button type="button" title={value.liked ? '取消点赞' : '点赞'} aria-label={value.liked ? '取消点赞' : '点赞'} aria-pressed={value.liked}
      data-like disabled={!enabled || busy || Boolean(pending) || !value.available && !value.liked} onClick={() => act('like')}><Heart size={17} fill={value.liked ? 'currentColor' : 'none'} />{value.likeCount !== null && <span>{value.likeCount}</span>}</button>
    <button type="button" title={value.favorited ? '取消收藏' : '收藏'} aria-label={value.favorited ? '取消收藏' : '收藏'} aria-pressed={value.favorited}
      disabled={!enabled || busy || Boolean(pending) || !value.available && !value.favorited} onClick={() => act('favorite')}><Bookmark size={17} fill={value.favorited ? 'currentColor' : 'none'} /></button>
    {pending && <><button type="button" aria-label="核对原操作" title="核对原操作" disabled={busy} onClick={() => void read(pending).catch(() => setError('原操作待确认'))}><RefreshCw size={16} /></button>
      <button type="button" aria-label="重试同一原操作" title="重试同一原操作，不另建请求" disabled={busy} onClick={() => void submit(pending)}><RotateCw size={16} /></button></>}
    {error && <span role="status" className={styles.message} title={error}>{error}</span>}
  </div>;
}
