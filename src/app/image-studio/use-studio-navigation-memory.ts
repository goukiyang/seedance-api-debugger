'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';

export type StudioNavigationMetadata = {
  account: string; moduleId: string; presetId: string; name: string; groupName: string; sourceRevision: string;
};
type Memory = { version: 1; account: string; lastKnown: StudioNavigationMetadata[] };
type NavigationTarget = { moduleId: string; presetId: string; name?: string; groupName?: string };
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value);
const label = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
const placeholder = (name: string) => !name.trim() || /^(模板已不可用|共享模板暂不可用|共享模板已不可用|模板暂不可用|历史模板(?:\s*[·・].*)?)$/.test(name.trim());
function metadata(value: unknown, owner: string): StudioNavigationMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.account !== owner || !identity(v.moduleId) || !identity(v.presetId) || !label(v.name, 160) || placeholder(v.name)
    || !label(v.groupName, 160) || !label(v.sourceRevision, 160) || !v.sourceRevision) return null;
  // Reconstruct the whitelist instead of persisting a DTO or its controlled body.
  return { account: owner, moduleId: v.moduleId, presetId: v.presetId, name: v.name, groupName: v.groupName, sourceRevision: v.sourceRevision };
}
function readMemory(raw: string | null, owner: string): Memory {
  const empty: Memory = { version: 1, account: owner, lastKnown: [] };
  if (!raw) return empty;
  const v = JSON.parse(raw) as Partial<Memory> | null;
  if (!v || v.version !== 1 || v.account !== owner || !Array.isArray(v.lastKnown) || v.lastKnown.length > 5000) return empty;
  const entries = new Map<string, StudioNavigationMetadata>();
  for (const item of v.lastKnown) {
    const safe = metadata(item, owner);
    if (safe) entries.set(JSON.stringify([safe.moduleId, safe.presetId]), safe);
  }
  return { ...empty, lastKnown: Array.from(entries.values()) };
}

/** Navigation names share the studio preference namespace but never modify
 * sorting, hidden entries, drafts or business records. No cross-device promise. */
export function useStudioNavigationMemory({ userId }: { userId: string }) {
  const key = `sd2:studio-navigation:v1:${encodeURIComponent(userId)}:last-known`;
  const scope = useRef({ key });
  if (scope.current.key !== key) scope.current = { key };
  const currentScope = scope.current;
  const owner = useRef(userId); owner.current = userId;
  const [state, setState] = useState<{ key: string; value: Memory }>({ key: '', value: { version: 1, account: '', lastKnown: [] } });
  const latest = useRef(state); latest.current = state;
  const currentMemory = state.key === key ? state.value : null;
  const [error, setError] = useState('');
  useEffect(() => {
    let value: Memory;
    try { value = readMemory(localStorage.getItem(key), userId); setError(''); }
    catch { value = { version: 1, account: userId, lastKnown: [] }; setError('本机导航记忆暂无法读取'); }
    latest.current = { key, value }; setState({ key, value });
    const receive = (event: StorageEvent) => {
      if (owner.current !== userId || event.key !== key) return;
      try {
        const next = { key, value: readMemory(event.newValue, userId) };
        latest.current = next; setState(next); setError('');
      } catch { setError('另一页面的导航记忆暂无法读取，已保留当前名称'); }
    };
    window.addEventListener('storage', receive);
    return () => window.removeEventListener('storage', receive);
  }, [key, userId]);
  const remember = useCallback((input: StudioNavigationMetadata, proof: { authorized: boolean; available: boolean; repair?: boolean }) => {
    if (scope.current !== currentScope || owner.current !== userId || !userId || isClientSessionBlocked() || latest.current.key !== key
      || !proof.authorized || !proof.available && !proof.repair) return false;
    const safe = metadata(input, userId);
    if (!safe) return false;
    const previous = latest.current.value.lastKnown.find(item => item.moduleId === safe.moduleId && item.presetId === safe.presetId);
    if (previous && JSON.stringify(previous) === JSON.stringify(safe)) return true;
    try {
      // Merge only valid metadata from this account; other tabs may have added
      // names since the last render. Never merge or copy source definitions.
      const saved = readMemory(localStorage.getItem(key), userId);
      const entries = new Map(saved.lastKnown.map(item => [JSON.stringify([item.moduleId, item.presetId]), item]));
      const itemKey = JSON.stringify([safe.moduleId, safe.presetId]);
      const persisted = entries.get(itemKey);
      if (persisted && JSON.stringify(persisted) === JSON.stringify(safe)) return true;
      entries.delete(itemKey); entries.set(itemKey, safe);
      const value: Memory = { version: 1, account: userId, lastKnown: Array.from(entries.values()).slice(-5000) };
      const raw = JSON.stringify(value);
      localStorage.setItem(key, raw);
      if (localStorage.getItem(key) !== raw) throw new Error('memory_not_saved');
      const next = { key, value }; latest.current = next; setState(next); setError(''); return true;
    } catch { setError('本次模板名称无法记住，当前工作仍保留'); return false; }
  }, [userId, key, currentScope]);
  const get = useCallback((target: NavigationTarget): { name: string; groupName: string; sourceRevision?: string } => {
    const memory = scope.current === currentScope && owner.current === userId && currentMemory?.account === userId
      && latest.current.key === key ? latest.current.value : null;
    const found = memory?.lastKnown.find(item => item.moduleId === target.moduleId && item.presetId === target.presetId);
    if (found) return { name: found.name, groupName: found.groupName, sourceRevision: found.sourceRevision };
    if (label(target.name, 160) && !placeholder(target.name)) return {
      name: target.name, groupName: label(target.groupName, 160) ? target.groupName : '',
    };
    const shortId = (target.presetId || target.moduleId).replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || '未知编号';
    return { name: `历史模板 · ${shortId}`, groupName: '' };
  }, [userId, key, currentScope, currentMemory]);
  const reset = useCallback(() => {
    if (scope.current !== currentScope || owner.current !== userId || isClientSessionBlocked()) return false;
    try {
      localStorage.removeItem(key);
      const next = { key, value: { version: 1 as const, account: userId, lastKnown: [] } };
      latest.current = next; setState(next); setError(''); return true;
    } catch { setError('导航记忆未能重置，请允许本机存储后再试'); return false; }
  }, [key, userId, currentScope]);
  return { remember, get, reset, ready: state.key === key, error };
}
