'use client';

import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import type { ContentKey, ReactionAction, ReactionMutation, ReactionState } from '@/lib/content-reactions/types';
import styles from './reactions.module.css';
import ImageShareButton from './ImageShareButton';
import LikeButton from './LikeButton';

type Entry = { state?: ReactionState; error?: string; busy?: boolean };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const queued = new Map<string, Set<ContentKey>>();
const pending = new Map<string, ReactionMutation>();
let timer: ReturnType<typeof setTimeout> | undefined;
const cacheKey = (userId: string, key: ContentKey) => `${userId}/${key}`;
const emit = () => listeners.forEach(listener => listener());
let channel: BroadcastChannel | null = null;

function broadcast(userId: string, key: ContentKey) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('sd2-reactions-changed', { detail: { userId, key } }));
  channel?.postMessage({ userId, key });
}
function installChannel() {
  if (channel || typeof BroadcastChannel === 'undefined') return;
  channel = new BroadcastChannel('sd2-content-reactions');
  channel.onmessage = event => {
    const { userId, key } = event.data || {};
    if (typeof userId !== 'string' || typeof key !== 'string') return;
    for (const [entryKey, value] of Array.from(entries)) {
      if (entryKey.startsWith(`${userId}/`) && value.state?.key === key) schedule(userId, entryKey.slice(userId.length + 1) as ContentKey);
    }
    window.dispatchEvent(new CustomEvent('sd2-reactions-changed', { detail: { userId, key } }));
  };
}
function update(userId: string, requested: ContentKey, value: Entry) {
  const previous = entries.get(cacheKey(userId, requested));
  if (value.state && previous?.state && value.state.key === previous.state.key && value.state.version < previous.state.version) return;
  entries.set(cacheKey(userId, requested), value);
  if (value.state) for (const [key, item] of Array.from(entries)) {
    if (key.startsWith(`${userId}/`) && item.state?.key === value.state.key) entries.set(key, value);
  }
  emit();
}
function schedule(userId: string, key: ContentKey) {
  const keys = queued.get(userId) || new Set<ContentKey>(); keys.add(key); queued.set(userId, keys);
  if (!timer) timer = setTimeout(() => { timer = undefined; void flush(); }, 40);
}
async function flush() {
  const jobs = Array.from(queued); queued.clear();
  for (const [userId, all] of jobs) {
    const keys = Array.from(all);
    for (let start = 0; start < keys.length; start += 50) {
      const batch = keys.slice(start, start + 50);
      try {
        const response = await fetch('/api/content-reactions/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: batch }), cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '读取失败');
        for (const key of batch) if (!entries.get(cacheKey(userId, key))?.busy) update(userId, key, { state: data.states[key] });
      } catch (error) {
        for (const key of batch) update(userId, key, { ...entries.get(cacheKey(userId, key)), error: error instanceof Error ? error.message : '读取失败' });
      }
    }
  }
}

export async function writeReaction(userId: string, key: ContentKey, action: ReactionAction, active: boolean, state: ReactionState) {
  const id = cacheKey(userId, state.key);
  if (entries.get(id)?.busy) return;
  let body = pending.get(id);
  // Preserve the original request after an uncertain network result; never silently invert it.
  if (!body) {
    body = { key: state.key, action, active, expectedVersion: state.version, requestId: crypto.randomUUID() };
    pending.set(id, body);
  }
  update(userId, key, { state, busy: true }); entries.set(id, { state, busy: true });
  try {
    const response = await fetch('/api/content-reactions', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) {
      if (response.status < 500) { pending.delete(id); schedule(userId, key); }
      throw new Error(data.error || '操作失败，请重试');
    }
    pending.delete(id); update(userId, key, { state: data.state }); broadcast(userId, data.state.key);
    return data.state as ReactionState;
  } catch (error) {
    const message = error instanceof Error ? error.message : '操作失败，请重试';
    update(userId, key, { state, error: message });
    throw new Error(message);
  }
}

export default function ContentReactions({ contentKey, initialState, onChange, disabled = false, overlay = false, imageSharing = true, favoriteOnly = false }: {
  contentKey: ContentKey; initialState?: ReactionState; disabled?: boolean;
  overlay?: boolean;
  imageSharing?: boolean;
  favoriteOnly?: boolean;
  onChange?: (state: ReactionState, action: ReactionAction, active: boolean, previous?: ReactionState) => void;
}) {
  const { user } = useAppSession();
  const [, render] = useState(0);
  const userId = user?.id;
  const identity = `${userId}:${contentKey}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const mounted = useRef(false);
  const [pulse, setPulse] = useState<{ identity: string; version: number; beat: number; active: boolean; count: number | null } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!pulse) return;
    const timer = setTimeout(() => setPulse(null), 900);
    return () => clearTimeout(timer);
  }, [pulse]);
  useEffect(() => {
    if (!userId) return;
    installChannel();
    if (initialState && !entries.get(cacheKey(userId, contentKey))?.busy) update(userId, contentKey, { state: initialState });
    const listener = () => render(value => value + 1); listeners.add(listener);
    schedule(userId, contentKey);
    const refresh = () => { if (document.visibilityState === 'visible') schedule(userId, contentKey); };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { listeners.delete(listener); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [userId, contentKey, initialState]);
  if (!userId) return null;
  const entry = entries.get(cacheKey(userId, contentKey)) || {};
  const state = entry.state;
  const uncertain = Boolean(state && pending.has(cacheKey(userId, state.key)));
  function confirmed(next: ReactionState, active: boolean) {
    if (!mounted.current || currentIdentity.current !== identity) return;
    if (active === Boolean(next.liked || next.favorited)) setPulse({ identity, version: next.version, beat: next.version, active, count: next.likeCount });
    else setPulse(null);
    onChange?.(next, 'like', active, state);
  }
  async function act() {
    if (!state || !userId) return;
    const active = !(state.liked || state.favorited);
    try { const next = await writeReaction(userId, contentKey, 'like', active, state); if (next) confirmed(next, active); } catch { /* Error is retained with a retry action. */ }
  }
  return <span className={`${styles.controls} ${overlay ? styles.overlayControls : ''} ${favoriteOnly ? styles.favoriteOnly : ''}`} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} data-content-reactions data-overlay={overlay || undefined} aria-busy={entry.busy || undefined}>
    <LikeButton key={identity} active={Boolean(state?.liked || state?.favorited)} count={favoriteOnly ? undefined : state?.likeCount} showCount={!favoriteOnly}
      disabled={Boolean(disabled || entry.busy || uncertain || !state || (!state.available && !(state.liked || state.favorited)))}
      animateCount={Boolean(pulse?.identity === identity && pulse.version === state?.version && pulse.count === state?.likeCount)}
      bloom={pulse?.identity === identity && pulse.version === state?.version && pulse.active ? pulse.beat : 0} onClick={() => void act()} />
    {imageSharing && !favoriteOnly && <ImageShareButton key={`${userId}:${contentKey}`} contentKey={contentKey} userId={userId} disabled={disabled} />}
    {entry.busy && <span className={styles.busy} role="status"><RefreshCw size={13} className={styles.busyIcon} />保存中</span>}
    {(entry.error || uncertain && !entry.busy) && <span className={styles.error} role="status">{entry.error || '上次操作尚未确认，请重试'}<button type="button" disabled={entry.busy} aria-label="重试喜欢" title="重试" onClick={() => {
      const retry = state && pending.get(cacheKey(userId, state.key));
      if (retry && state) void writeReaction(userId, contentKey, retry.action, retry.active, state).then(next => { if (next) confirmed(next, retry.active); }).catch(() => {}); else schedule(userId, contentKey);
    }}><RefreshCw size={14} /></button></span>}
  </span>;
}
