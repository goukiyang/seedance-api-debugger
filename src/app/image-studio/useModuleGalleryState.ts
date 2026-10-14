'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  defaultModuleGalleryFilters, isModuleGalleryKey, mergeModuleGalleryLastOpened,
  normalizeModuleGalleryFilters, normalizeModuleGalleryLastOpened,
  type GalleryScope, type GallerySort, type ModuleGalleryFilters, type ModuleGalleryLastOpened,
} from './module-gallery-state';

type Snapshot = ModuleGalleryFilters & { owner: string; lastOpened: ModuleGalleryLastOpened };
const MAX_RECORD_LENGTH = 256_000;

function readRecord(storage: Storage, key: string): Record<string, unknown> | null {
  try {
    const raw = storage.getItem(key);
    if (!raw || raw.length > MAX_RECORD_LENGTH) return null;
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      && (value as Record<string, unknown>).version === 1 ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function storageRecord(kind: 'local' | 'session', key: string) {
  try { return readRecord(kind === 'local' ? window.localStorage : window.sessionStorage, key); } catch { return null; }
}

function writeRecord(kind: 'local' | 'session', key: string, value: unknown) {
  try { (kind === 'local' ? window.localStorage : window.sessionStorage).setItem(key, JSON.stringify(value)); } catch { /* Optional local preferences must not block work. */ }
}

function removeRecord(kind: 'local' | 'session', key: string) {
  try { (kind === 'local' ? window.localStorage : window.sessionStorage).removeItem(key); } catch { /* Optional preferences. */ }
}

export function useModuleGalleryState(userId: string, { enabled = true }: { enabled?: boolean } = {}) {
  const account = typeof userId === 'string' && userId.length > 0 && userId.length <= 160
    && !/[\u0000-\u001f\u007f]/.test(userId) ? encodeURIComponent(userId) : '';
  const persistent = enabled && Boolean(account);
  const owner = `${persistent ? 'saved' : 'temporary'}:${account}`;
  const filtersKey = `sd2:module-gallery:filters:v1:${account}`;
  const tabKey = `${filtersKey}:tab`;
  const recentKey = `sd2:module-gallery:recent:v1:${account}`;
  const empty = (): Snapshot => ({ ...defaultModuleGalleryFilters(), owner, lastOpened: {} });
  const [snapshot, setSnapshot] = useState<Snapshot>(() => ({ ...defaultModuleGalleryFilters(), owner: '', lastOpened: {} }));
  const latest = useRef<Snapshot | null>(null);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;

  const ensureSnapshot = useCallback((): Snapshot => {
    if (latest.current?.owner === owner) return latest.current;
    let next: Snapshot = { ...defaultModuleGalleryFilters(), owner, lastOpened: {} };
    if (persistent && typeof window !== 'undefined') {
      // Tab navigation stays independent; the local copy provides reopen defaults.
      const filters = storageRecord('session', tabKey) || storageRecord('local', filtersKey);
      next = { ...normalizeModuleGalleryFilters(filters), owner,
        lastOpened: normalizeModuleGalleryLastOpened(storageRecord('local', recentKey)?.lastOpened, Date.now()) };
      // Lock the restored filters to this tab before other tabs change defaults.
      writeRecord('session', tabKey, { version: 1, ...normalizeModuleGalleryFilters(filters) });
    }
    latest.current = next;
    return next;
  }, [filtersKey, owner, persistent, recentKey, tabKey]);

  useEffect(() => {
    setSnapshot(ensureSnapshot());
  }, [ensureSnapshot]);

  const setFilters = useCallback((patch: Partial<ModuleGalleryFilters>) => {
    if (currentOwner.current !== owner) return;
    const current = ensureSnapshot();
    const filters = normalizeModuleGalleryFilters({ ...current, ...patch });
    const next = { ...current, ...filters };
    latest.current = next;
    setSnapshot(next);
    if (persistent) {
      const record = { version: 1, ...filters };
      writeRecord('session', tabKey, record);
      writeRecord('local', filtersKey, record);
    }
  }, [ensureSnapshot, filtersKey, owner, persistent, tabKey]);

  const setQuery = useCallback((query: string) => setFilters({ query }), [setFilters]);
  const setScope = useCallback((scope: GalleryScope) => setFilters({ scope }), [setFilters]);
  const setSort = useCallback((sort: GallerySort) => setFilters({ sort }), [setFilters]);

  const markOpened = useCallback((key: string) => {
    if (currentOwner.current !== owner || !enabled || !account || !isModuleGalleryKey(key)) return;
    const current = ensureSnapshot();
    const now = Date.now();
    const disk = persistent ? normalizeModuleGalleryLastOpened(storageRecord('local', recentKey)?.lastOpened, now) : {};
    const lastOpened = mergeModuleGalleryLastOpened(mergeModuleGalleryLastOpened(current.lastOpened, disk, now), { [key]: now }, now);
    const next = { ...current, lastOpened };
    latest.current = next;
    setSnapshot(next);
    if (persistent) writeRecord('local', recentKey, { version: 1, lastOpened });
  }, [account, enabled, ensureSnapshot, owner, persistent, recentKey]);

  useEffect(() => {
    if (!persistent) return;
    const mergeRecent = (event: StorageEvent) => {
      if (currentOwner.current !== owner || event.key !== recentKey) return;
      try { if (event.storageArea !== window.localStorage) return; } catch { return; }
      const current = ensureSnapshot();
      const now = Date.now();
      const diskRecord = storageRecord('local', recentKey);
      const disk = normalizeModuleGalleryLastOpened(diskRecord?.lastOpened, now);
      const lastOpened = event.newValue === null && !diskRecord ? {}
        : mergeModuleGalleryLastOpened(current.lastOpened, disk, now);
      const next = { ...current, lastOpened };
      latest.current = next;
      setSnapshot(next);
      // Do not echo storage events or import another tab's filters/navigation.
    };
    window.addEventListener('storage', mergeRecent);
    return () => window.removeEventListener('storage', mergeRecent);
  }, [ensureSnapshot, owner, persistent, recentKey]);

  const reset = useCallback(() => {
    if (currentOwner.current !== owner) return;
    const next: Snapshot = { ...defaultModuleGalleryFilters(), owner, lastOpened: {} };
    latest.current = next;
    setSnapshot(next);
    if (persistent) {
      // Persist the current tab's default snapshot, leaving other tab filters alone.
      writeRecord('session', tabKey, { version: 1, ...defaultModuleGalleryFilters() });
      removeRecord('local', filtersKey);
      removeRecord('local', recentKey);
    }
  }, [filtersKey, owner, persistent, recentKey, tabKey]);

  // No previous-account values are rendered while the next account initializes.
  const ready = snapshot.owner === owner;
  const state = ready ? snapshot : empty();
  return { query: state.query, setQuery, scope: state.scope, setScope, sort: state.sort, setSort,
    ready, lastOpened: state.lastOpened, markOpened, reset };
}
