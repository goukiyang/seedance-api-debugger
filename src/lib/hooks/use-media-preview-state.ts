'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import type { ContentKey } from '@/lib/content-reactions/types';
import { MAX_STORED_SCALE, DEFAULT_STATE, ZOOM_MODES, clampNumber, parseMediaPreviewStoredState,
  type MediaPreviewStoredState, type MediaPreviewZoomMode } from '@/lib/media/media-preview-state-contract';
export { parseMediaPreviewStoredState, type MediaPreviewStoredState, type MediaPreviewZoomMode } from '@/lib/media/media-preview-state-contract';

interface StoredEntry {
  key: string | null;
  ready: boolean;
  value: MediaPreviewStoredState;
}

const STORAGE_PREFIX = 'sd2:media-preview:v1';

export function isSafeIdentifier(value: unknown, allowContentKey = false): value is string {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  if (!normalized || normalized.length > 200
    || /^(?:https?:\/\/|[a-z][a-z\d+.-]*:\/\/|blob:|data:|file:|\/)/i.test(normalized)
    || /[\/?#\\\u0000-\u001f]/.test(normalized)) return false;
  if (allowContentKey && /^[a-z][a-z\d_-]*:[a-z\d_.:-]+$/i.test(normalized)) return true;
  return /^[a-z\d][a-z\d_.:@-]*$/i.test(normalized)
    && !/\.(?:avif|gif|jpe?g|m4a|mov|mp3|mp4|ogg|png|webm|wav)$/i.test(normalized);
}

export function sourceFingerprint(source?: string) {
  if (!source || source.length > 4096 || /^(?:data:|blob:)/i.test(source)) return '';
  let normalized = source;
  try {
    const url = new URL(source, 'https://preview-state.invalid');
    url.hash = '';
    for (const name of Array.from(url.searchParams.keys())) {
      if (/^(?:token|access_token|auth|authorization|signature|sig|credential|expires?|exp|jwt|session|thumbnail|preview|x-amz-.+)$/i.test(name)) {
        url.searchParams.delete(name);
      }
    }
    url.searchParams.sort();
    normalized = `${url.host}${url.pathname}${url.search}`;
  } catch {
    return '';
  }

  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function storageKeyFor(userId: string | null, previewKey?: string, contentKey?: ContentKey, source?: string) {
  if (!userId) return null;
  const resourceKey = isSafeIdentifier(previewKey)
    ? previewKey.trim()
    : isSafeIdentifier(contentKey, true) ? contentKey.trim() : null;
  if (!resourceKey) return null;
  const fingerprint = sourceFingerprint(source);
  return `${STORAGE_PREFIX}:${encodeURIComponent(userId)}:${encodeURIComponent(resourceKey)}${fingerprint ? `:${fingerprint}` : ''}`;
}

const STATE_EVENT = 'sd2:media-preview-state';

function writeStoredState(key: string, patch: Partial<MediaPreviewStoredState>, defaultLoop: boolean) {
  try {
    const value = { ...parseMediaPreviewStoredState(window.localStorage.getItem(key), defaultLoop), ...patch };
    window.localStorage.setItem(key, JSON.stringify({ version: 1, state: value }));
    window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: { key, patch } }));
    return true;
  } catch {
    // Storage can be disabled or full; preview interactions must remain usable.
    return false;
  }
}

export function useMediaPreviewState(previewKey?: string, contentKey?: ContentKey, source?: string, defaultLoop = false) {
  const { user, hasLoadedUser } = useAppSession();
  const key = storageKeyFor(user?.id || null, previewKey, contentKey, source);
  const [entry, setEntry] = useState<StoredEntry>(() => ({ key: null, ready: false, value: DEFAULT_STATE }));
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const pendingRef = useRef<Partial<MediaPreviewStoredState>>({});
  const [storageUnavailable, setStorageUnavailable] = useState(false);

  useEffect(() => {
    if (!key) {
      pendingRef.current = {};
      setEntry({ key: null, ready: hasLoadedUser, value: parseMediaPreviewStoredState(null, defaultLoop) });
      return;
    }
    let value = parseMediaPreviewStoredState(null, defaultLoop);
    pendingRef.current = {};
    setStorageUnavailable(false);
    try {
      value = parseMediaPreviewStoredState(window.localStorage.getItem(key), defaultLoop);
    } catch {
      // Storage can be unavailable in private or restricted browser contexts.
      setStorageUnavailable(true);
    }
    setEntry({ key, ready: true, value });
  }, [defaultLoop, hasLoadedUser, key]);

  const flush = useCallback(() => {
    if (entryRef.current.key !== key || !Object.keys(pendingRef.current).length) return;
    if (!key) { pendingRef.current = {}; setStorageUnavailable(true); return; }
    const patch = pendingRef.current;
    pendingRef.current = {};
    setStorageUnavailable(!writeStoredState(key, patch, defaultLoop));
  }, [defaultLoop, key]);

  const update = useCallback((patch: Partial<MediaPreviewStoredState>) => {
      const current = entryRef.current;
      if (!current.ready || current.key !== key) return;
      const value = {
        scale: clampNumber(patch.scale ?? current.value.scale, 0.5, MAX_STORED_SCALE, DEFAULT_STATE.scale),
        offsetX: clampNumber(patch.offsetX ?? current.value.offsetX, -50_000, 50_000, DEFAULT_STATE.offsetX),
        offsetY: clampNumber(patch.offsetY ?? current.value.offsetY, -50_000, 50_000, DEFAULT_STATE.offsetY),
        zoomMode: ZOOM_MODES.has((patch.zoomMode ?? current.value.zoomMode) as MediaPreviewZoomMode)
          ? (patch.zoomMode ?? current.value.zoomMode) as MediaPreviewZoomMode
          : DEFAULT_STATE.zoomMode,
        currentTime: clampNumber(patch.currentTime ?? current.value.currentTime, 0, 604_800, DEFAULT_STATE.currentTime),
        loop: typeof patch.loop === 'boolean' ? patch.loop : current.value.loop,
      };
      if (value.scale === current.value.scale
        && value.offsetX === current.value.offsetX
        && value.offsetY === current.value.offsetY
        && value.zoomMode === current.value.zoomMode
        && value.currentTime === current.value.currentTime && value.loop === current.value.loop) return;
      const next = { ...current, value };
      entryRef.current = next;
      setEntry(next);
      for (const field of Object.keys(patch) as Array<keyof MediaPreviewStoredState>) {
        Object.assign(pendingRef.current, { [field]: value[field] });
      }
      if (typeof patch.loop === 'boolean') flush();
  }, [flush, key]);

  const reset = useCallback(() => {
    // Reset viewing position only; a replay preference is not a position.
    update({ scale: 1, offsetX: 0, offsetY: 0, zoomMode: 'fit', currentTime: 0 });
  }, [update]);

  useEffect(() => {
    if (!key || !entry.ready || entry.key !== key) return;
    const timeout = window.setTimeout(flush, 300);
    return () => window.clearTimeout(timeout);
  }, [entry, flush, key]);

  useEffect(() => {
    if (!key) return;
    const visibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', visibility);
      flush();
    };
  }, [flush, key]);

  useEffect(() => {
    if (!key) return;
    const merge = (patch: Partial<MediaPreviewStoredState>) => {
      const current = entryRef.current;
      if (!current.ready || current.key !== key) return;
      const value = { ...current.value, ...patch, ...pendingRef.current };
      const next = { ...current, value };
      entryRef.current = next;
      setEntry(next);
    };
    const local = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; patch: Partial<MediaPreviewStoredState> }>).detail;
      if (detail?.key === key) merge(detail.patch);
    };
    const storage = (event: StorageEvent) => {
      if (event.key === key) merge(parseMediaPreviewStoredState(event.newValue, defaultLoop));
    };
    window.addEventListener(STATE_EVENT, local);
    window.addEventListener('storage', storage);
    return () => { window.removeEventListener(STATE_EVENT, local); window.removeEventListener('storage', storage); };
  }, [defaultLoop, key]);

  const ready = entry.ready && entry.key === key;
  return {
    key,
    ready,
    value: ready ? entry.value : parseMediaPreviewStoredState(null, defaultLoop),
    update,
    reset,
    storageUnavailable,
  };
}

/** Task outputs are immutable versions. Signed delivery URLs are not their identity. */
export function useVideoLoopState(source?: string, contentKey?: ContentKey, previewKey?: string, defaultEnabled = false) {
  let taskKey = contentKey?.startsWith('video_task:') ? contentKey : undefined;
  if (!taskKey && source) {
    try {
      const match = new URL(source, 'https://preview-state.invalid').pathname.match(/^\/api\/video\/play\/([a-z\d_-]+)$/i);
      if (match) taskKey = `video_task:${match[1]}`;
    } catch { /* An unrecognised source uses its fingerprint, never a guessed filename. */ }
  }
  const identity = taskKey || (isSafeIdentifier(contentKey, true) ? contentKey : undefined)
    || (isSafeIdentifier(previewKey) ? previewKey : undefined)
    || `video-source:${sourceFingerprint(source) || 'unavailable'}`;
  const versionSource = taskKey ? `/api/video/play/${taskKey.slice('video_task:'.length)}` : source;
  const state = useMediaPreviewState(identity, taskKey, versionSource, defaultEnabled);
  return {
    enabled: state.value.loop,
    ready: state.ready,
    storageUnavailable: state.storageUnavailable,
    toggle: () => state.update({ loop: !state.value.loop }),
  };
}
