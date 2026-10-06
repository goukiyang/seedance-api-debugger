'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import type { ContentKey } from '@/lib/content-reactions/types';

export type MediaPreviewZoomMode = 'fit' | 'width' | 'actual' | 'custom';

export interface MediaPreviewStoredState {
  scale: number;
  offsetX: number;
  offsetY: number;
  zoomMode: MediaPreviewZoomMode;
  currentTime: number;
}

interface StoredEntry {
  key: string | null;
  ready: boolean;
  value: MediaPreviewStoredState;
}

const STORAGE_PREFIX = 'sd2:media-preview:v1';
const MAX_STORED_SCALE = 1_000_000;
const DEFAULT_STATE: MediaPreviewStoredState = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  zoomMode: 'fit',
  currentTime: 0,
};
const ZOOM_MODES = new Set<MediaPreviewZoomMode>(['fit', 'width', 'actual', 'custom']);

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

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

function parseStoredState(input: string | null): MediaPreviewStoredState {
  if (!input) return DEFAULT_STATE;
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    if (parsed.version !== 1 || !parsed.state || typeof parsed.state !== 'object') return DEFAULT_STATE;
    const state = parsed.state as Record<string, unknown>;
    const zoomMode = ZOOM_MODES.has(state.zoomMode as MediaPreviewZoomMode)
      ? state.zoomMode as MediaPreviewZoomMode
      : DEFAULT_STATE.zoomMode;
    return {
      scale: clampNumber(state.scale, 0.5, MAX_STORED_SCALE, DEFAULT_STATE.scale),
      offsetX: clampNumber(state.offsetX, -50_000, 50_000, DEFAULT_STATE.offsetX),
      offsetY: clampNumber(state.offsetY, -50_000, 50_000, DEFAULT_STATE.offsetY),
      zoomMode,
      currentTime: clampNumber(state.currentTime, 0, 604_800, DEFAULT_STATE.currentTime),
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function writeStoredState(key: string, value: MediaPreviewStoredState) {
  try {
    window.localStorage.setItem(key, JSON.stringify({ version: 1, state: value }));
  } catch {
    // Storage can be disabled or full; preview interactions must remain usable.
  }
}

export function useMediaPreviewState(previewKey?: string, contentKey?: ContentKey, source?: string) {
  const { user, hasLoadedUser } = useAppSession();
  const key = storageKeyFor(user?.id || null, previewKey, contentKey, source);
  const [entry, setEntry] = useState<StoredEntry>(() => ({ key: null, ready: false, value: DEFAULT_STATE }));
  const entryRef = useRef(entry);
  entryRef.current = entry;

  useEffect(() => {
    if (!key) {
      setEntry({ key: null, ready: hasLoadedUser, value: DEFAULT_STATE });
      return;
    }
    let value = DEFAULT_STATE;
    try {
      value = parseStoredState(window.localStorage.getItem(key));
    } catch {
      // Storage can be unavailable in private or restricted browser contexts.
    }
    setEntry({ key, ready: true, value });
  }, [hasLoadedUser, key]);

  const update = useCallback((patch: Partial<MediaPreviewStoredState>) => {
    setEntry(current => {
      if (!key || !current.ready || current.key !== key) return current;
      const value = {
        scale: clampNumber(patch.scale ?? current.value.scale, 0.5, MAX_STORED_SCALE, DEFAULT_STATE.scale),
        offsetX: clampNumber(patch.offsetX ?? current.value.offsetX, -50_000, 50_000, DEFAULT_STATE.offsetX),
        offsetY: clampNumber(patch.offsetY ?? current.value.offsetY, -50_000, 50_000, DEFAULT_STATE.offsetY),
        zoomMode: ZOOM_MODES.has((patch.zoomMode ?? current.value.zoomMode) as MediaPreviewZoomMode)
          ? (patch.zoomMode ?? current.value.zoomMode) as MediaPreviewZoomMode
          : DEFAULT_STATE.zoomMode,
        currentTime: clampNumber(patch.currentTime ?? current.value.currentTime, 0, 604_800, DEFAULT_STATE.currentTime),
      };
      if (value.scale === current.value.scale
        && value.offsetX === current.value.offsetX
        && value.offsetY === current.value.offsetY
        && value.zoomMode === current.value.zoomMode
        && value.currentTime === current.value.currentTime) return current;
      return { ...current, value };
    });
  }, [key]);

  const reset = useCallback(() => {
    setEntry(current => {
      if (current.key !== key || !current.ready) return current;
      const value = current.value;
      if (value.scale === DEFAULT_STATE.scale && value.offsetX === DEFAULT_STATE.offsetX
        && value.offsetY === DEFAULT_STATE.offsetY && value.zoomMode === DEFAULT_STATE.zoomMode
        && value.currentTime === DEFAULT_STATE.currentTime) return current;
      return { ...current, value: DEFAULT_STATE };
    });
  }, [key]);

  useEffect(() => {
    if (!key || !entry.ready || entry.key !== key) return;
    const timeout = window.setTimeout(() => writeStoredState(key, entry.value), 300);
    return () => window.clearTimeout(timeout);
  }, [entry, key]);

  useEffect(() => {
    if (!key) return;
    const flush = () => {
      const current = entryRef.current;
      if (current.ready && current.key === key) writeStoredState(key, current.value);
    };
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
  }, [key]);

  const ready = entry.ready && entry.key === key;
  return {
    key,
    ready,
    value: ready ? entry.value : DEFAULT_STATE,
    update,
    reset,
  };
}
