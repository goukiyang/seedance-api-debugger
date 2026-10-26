'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';

type StudioOrder = { groups: string[]; entries: string[] };
const emptyOrder = (): StudioOrder => ({ groups: [], entries: [] });
function parseOrder(raw: string | null): StudioOrder {
  const value = raw ? JSON.parse(raw) : null;
  if (!value || value.version !== 1) return emptyOrder();
  const valid = (input: unknown, maxLength: number) => Array.isArray(input)
    ? Array.from(new Set(input.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= maxLength))).slice(0, 5000) : [];
  return { groups: valid(value.groups, 160), entries: valid(value.entries, 200) };
}

/** Stable across a shared catalog entry becoming a hydrated personal binding. */
export function studioOrderKey(entry: { id: string; presetId?: string; sharedLive?: { intent: { presetId: string } } | null }) {
  const presetId = entry.presetId || entry.sharedLive?.intent.presetId || (entry.id.startsWith('shared:') ? entry.id.slice(7) : undefined);
  return presetId ? `preset:${presetId}` : `module:${entry.id}`;
}

export function orderStudioItems<T>(items: T[], saved: string[], identify: (item: T) => string): T[] {
  const ranks = new Map(saved.map((id, index) => [id, index]));
  return items.map((item, index) => ({ item, index })).sort((a, b) =>
    (ranks.get(identify(a.item)) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(identify(b.item)) ?? Number.MAX_SAFE_INTEGER)
      || a.index - b.index).map(value => value.item);
}

export function useStudioOrder(userId: string) {
  const key = `sd2:studio-order:v1:${userId}`;
  const [state, setState] = useState<{ key: string; value: StudioOrder }>({ key: '', value: emptyOrder() });
  const [error, setError] = useState('');
  useEffect(() => {
    setError('');
    try { setState({ key, value: parseOrder(localStorage.getItem(key)) }); }
    catch { setState({ key, value: emptyOrder() }); setError('本机排序无法读取，当前按默认顺序显示。'); }
    const receive = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || event.key !== key) return;
      try { setState({ key, value: parseOrder(event.newValue) }); setError(''); }
      catch { setError('另一页面的排序未能读取，已保留当前顺序。'); }
    };
    window.addEventListener('storage', receive);
    return () => window.removeEventListener('storage', receive);
  }, [key]);
  const ready = state.key === key;
  const value = ready ? state.value : emptyOrder();
  const save = useCallback((next: StudioOrder) => {
    if (state.key !== key) return false;
    try {
      // Persist before presenting success: a failed write keeps the prior order.
      localStorage.setItem(key, JSON.stringify({ version: 1, ...next }));
      setState({ key, value: next }); setError(''); return true;
    } catch { setError('排序未能保存，已保留原顺序。请允许本机存储后重试。'); return false; }
  }, [key, state.key]);
  return { ...value, ready, error, save, reset: () => save(emptyOrder()) };
}

type NavigationPreference = { version: 1; revision: number; hiddenModuleIds: string[] };
const noHiddenModules: string[] = [];
function navigationPreference(value: unknown): NavigationPreference {
  if (!value || typeof value !== 'object') throw new Error('侧栏设置读取未确认');
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Number.isSafeInteger(record.revision) || Number(record.revision) < 0
    || !Array.isArray(record.hiddenModuleIds) || record.hiddenModuleIds.length > 1000
    || record.hiddenModuleIds.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) throw new Error('侧栏设置读取未确认');
  return record as NavigationPreference;
}

/** Server-backed visibility is separate from local sorting and never deletes module content. */
export function useStudioNavigationVisibility(userId: string, enabled: boolean) {
  const identity = useRef(userId); identity.current = userId;
  const sequence = useRef(0), lock = useRef(false);
  const [state, setState] = useState<{ owner: string; value: NavigationPreference } | null>(null);
  const [loading, setLoading] = useState(false), [restoring, setRestoring] = useState(''), [error, setError] = useState('');
  const reload = useCallback(async () => {
    if (!enabled || isClientSessionBlocked()) return;
    const token = ++sequence.current;
    setLoading(true);
    try {
      const response = await fetch('/api/image-studio/navigation-preferences', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '侧栏设置暂时无法读取');
      if (data.viewerId !== userId) throw new Error('侧栏设置所属账号已变化，请重新登录');
      const value = navigationPreference(data.preference);
      if (identity.current === userId && sequence.current === token && !isClientSessionBlocked()) { setState({ owner: userId, value }); setError(''); return value; }
    } catch (cause) {
      if (identity.current === userId && sequence.current === token && !isClientSessionBlocked()) setError(cause instanceof Error ? cause.message : '侧栏设置暂时无法读取');
    } finally { if (identity.current === userId && sequence.current === token) setLoading(false); }
  }, [enabled, userId]);
  useEffect(() => {
    setState(null); setError(''); setRestoring('');
    if (!enabled) return;
    void reload();
    const refresh = () => { if (!document.hidden && !lock.current) void reload(); };
    window.addEventListener('focus', refresh); window.addEventListener('sd2-studio-navigation-changed', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { sequence.current++; window.removeEventListener('focus', refresh); window.removeEventListener('sd2-studio-navigation-changed', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [enabled, reload]);
  const restore = async (moduleId: string) => {
    if (lock.current || state?.owner !== userId || isClientSessionBlocked()) return false;
    lock.current = true; setRestoring(moduleId);
    const before = state.value;
    try {
      const response = await fetch('/api/image-studio/navigation-preferences', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewerId: userId, moduleId, hidden: false, expectedRevision: before.revision }), signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '恢复侧栏入口尚未确认');
      const value = navigationPreference(data.preference);
      if (data.viewerId !== userId || value.hiddenModuleIds.includes(moduleId)) throw new Error('恢复侧栏入口尚未确认');
      if (identity.current !== userId || isClientSessionBlocked()) return false;
      sequence.current++; setState({ owner: userId, value }); setError('');
      window.dispatchEvent(new Event('sd2-studio-navigation-changed'));
      return true;
    } catch (cause) {
      if (identity.current === userId && !isClientSessionBlocked()) {
        const message = cause instanceof Error ? cause.message : '恢复侧栏入口尚未确认';
        // Reconcile the original preference after an ambiguous reply; do not retry the write.
        const reconciled = await reload();
        if (identity.current === userId && !isClientSessionBlocked() && (!reconciled || reconciled.hiddenModuleIds.includes(moduleId))) setError(message);
      }
      return false;
    } finally { lock.current = false; if (identity.current === userId) setRestoring(''); }
  };
  const ready = !enabled || state?.owner === userId;
  return { ready, loading, restoring, error, reload, restore, hiddenModuleIds: state?.owner === userId ? state.value.hiddenModuleIds : noHiddenModules };
}
