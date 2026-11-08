'use client';
import { useCallback, useEffect, useState } from 'react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { pricingModelAvailable, type PricingModelAvailability } from './model-availability-contract';

type State = { snapshot: PricingModelAvailability | null; error: string; at: number };
type Entry = State & { pending?: Promise<void>; listeners: Set<() => void> };
const entries = new Map<string, Entry>();
const eventName = 'sd2:model-availability-updated';
const empty: State = { snapshot: null, error: '', at: 0 };
function entryFor(actor: string) {
  let entry = entries.get(actor);
  if (!entry) { entry = { ...empty, listeners: new Set() }; entries.set(actor, entry); }
  return entry;
}
async function read(actor: string, force = false) {
  const entry = entryFor(actor);
  if (entry.pending) return entry.pending;
  if (!force && Date.now() - entry.at < 15000 && entry.snapshot) return;
  entry.pending = (async () => {
    try {
      const response = await fetch('/api/model-availability', { cache: 'no-store', headers: { 'x-app-session-user': actor } });
      const value = await response.json();
      if (!response.ok || !Array.isArray(value.rows) || !value.supplementary) throw new Error(value.error || '模型状态读取失败，请重新读取');
      entry.snapshot = value; entry.error = ''; entry.at = Date.now();
    } catch (error) {
      entry.snapshot = null; entry.error = error instanceof Error ? error.message : '模型状态读取失败，请重新读取';
    } finally {
      entry.pending = undefined;
      for (const listener of entry.listeners) listener();
    }
  })();
  return entry.pending;
}

export function broadcastModelAvailabilityUpdated() {
  window.dispatchEvent(new Event(eventName));
  try { localStorage.setItem(eventName, `${Date.now()}:${crypto.randomUUID()}`); } catch { /* Focus refresh remains available. */ }
}

export function usePricingModelAvailability() {
  const { user } = useAppSession();
  const actor = user?.id || '';
  const [state, setState] = useState<State & { actor: string }>({ ...empty, actor: '' });
  useEffect(() => {
    if (!actor) { setState({ ...empty, actor: '' }); return; }
    const entry = entryFor(actor);
    const update = () => setState({ snapshot: entry.snapshot, error: entry.error, at: entry.at, actor });
    const refresh = () => { if (document.visibilityState !== 'hidden') void read(actor, true); };
    const storage = (event: StorageEvent) => { if (event.key === eventName) refresh(); };
    entry.listeners.add(update); update(); void read(actor);
    window.addEventListener('focus', refresh); window.addEventListener(eventName, refresh);
    document.addEventListener('visibilitychange', refresh); window.addEventListener('storage', storage);
    return () => {
      entry.listeners.delete(update); window.removeEventListener('focus', refresh); window.removeEventListener(eventName, refresh);
      document.removeEventListener('visibilitychange', refresh); window.removeEventListener('storage', storage);
    };
  }, [actor]);
  const snapshot = state.actor === actor ? state.snapshot : null;
  const isAvailable = useCallback((kind: Parameters<typeof pricingModelAvailable>[1], model: string,
    specifications: Record<string, string> = {}, channelId?: string) =>
    pricingModelAvailable(snapshot, kind, model, specifications, channelId), [snapshot]);
  return { snapshot, isAvailable, reason: state.actor === actor && state.error || (snapshot ? '' : '正在读取可用模型'),
    refresh: () => actor ? read(actor, true) : Promise.resolve() };
}
