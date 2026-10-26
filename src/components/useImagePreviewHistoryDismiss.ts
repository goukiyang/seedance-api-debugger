'use client';

import { useCallback, useEffect, useId, useRef } from 'react';
import type { RefObject } from 'react';
import { isTopmostDialogLayer } from './useDialogDismiss';

const IMAGE_PREVIEW_HISTORY_STATE_KEY = '__sd2ImagePreviewHistoryEntry';
let imagePreviewHistorySequence = 0;

type ImagePreviewHistorySession = {
  token: string;
  url: string;
  ownsEntry: boolean;
};

type ImagePreviewHistoryMarker = {
  token: string;
  url: string;
  active: boolean;
};

function getImagePreviewHistoryMarker(): ImagePreviewHistoryMarker | null {
  const state = window.history.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const marker = state[IMAGE_PREVIEW_HISTORY_STATE_KEY];
  if (!marker || typeof marker !== 'object'
    || typeof marker.token !== 'string'
    || typeof marker.url !== 'string'
    || typeof marker.active !== 'boolean') return null;
  return marker as ImagePreviewHistoryMarker;
}

function hasActiveImagePreviewHistoryEntry(token: string) {
  const marker = getImagePreviewHistoryMarker();
  return marker?.active === true && marker.token === token;
}

function writeImagePreviewHistoryMarker(marker: ImagePreviewHistoryMarker, replace = false) {
  const state = window.history.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  try {
    const nextState = { ...state, [IMAGE_PREVIEW_HISTORY_STATE_KEY]: marker };
    if (replace) window.history.replaceState(nextState, '');
    else window.history.pushState(nextState, '');
    return true;
  } catch {
    return false;
  }
}

export function useImagePreviewHistoryDismiss<T extends HTMLElement>(open: boolean, dialogRef: RefObject<T>, onClose: () => void) {
  const instanceId = useId();
  const onCloseRef = useRef(onClose);
  const sessionRef = useRef<ImagePreviewHistorySession | null>(null);
  const effectGenerationRef = useRef(0);
  const closeRequestedRef = useRef(false);
  const closeCalledRef = useRef(false);
  onCloseRef.current = onClose;

  const closeOnce = useCallback(() => {
    if (closeCalledRef.current) return;
    closeCalledRef.current = true;
    if (sessionRef.current) sessionRef.current.ownsEntry = false;
    onCloseRef.current();
  }, []);

  useEffect(() => {
    const generation = ++effectGenerationRef.current;
    if (!open) {
      const inactiveSession = sessionRef.current;
      if (inactiveSession?.ownsEntry
        && inactiveSession.url === window.location.href
        && hasActiveImagePreviewHistoryEntry(inactiveSession.token)) {
        writeImagePreviewHistoryMarker({ token: inactiveSession.token, url: inactiveSession.url, active: false }, true);
      }
      sessionRef.current = null;
      closeRequestedRef.current = false;
      closeCalledRef.current = false;
      return undefined;
    }

    closeRequestedRef.current = false;
    closeCalledRef.current = false;
    let session = sessionRef.current;
    if (!session || !session.ownsEntry || !hasActiveImagePreviewHistoryEntry(session.token)) {
      const token = `${instanceId}:${++imagePreviewHistorySequence}`;
      const url = window.location.href;
      const existingMarker = getImagePreviewHistoryMarker();
      const reuseEntry = existingMarker?.active === false && existingMarker.url === url;
      const ownsEntry = writeImagePreviewHistoryMarker({ token, url, active: true }, reuseEntry);
      session = { token, url, ownsEntry };
      sessionRef.current = session;
    }

    const handlePopState = () => {
      const activeSession = sessionRef.current;
      if (!activeSession?.ownsEntry || closeCalledRef.current) return;
      if (hasActiveImagePreviewHistoryEntry(activeSession.token)) return;
      if (!isTopmostDialogLayer(dialogRef.current)) return;
      closeOnce();
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      // Let StrictMode replay this effect before marking its history entry inactive.
      queueMicrotask(() => {
        if (effectGenerationRef.current !== generation) return;
        const activeSession = sessionRef.current;
        if (!activeSession?.ownsEntry
          || activeSession.url !== window.location.href
          || !hasActiveImagePreviewHistoryEntry(activeSession.token)) return;
        if (writeImagePreviewHistoryMarker({ token: activeSession.token, url: activeSession.url, active: false }, true)) {
          activeSession.ownsEntry = false;
        }
      });
    };
  }, [closeOnce, dialogRef, instanceId, open]);

  return useCallback(() => {
    if (closeCalledRef.current || closeRequestedRef.current) return;
    const session = sessionRef.current;
    if (session?.ownsEntry
      && session.url === window.location.href
      && hasActiveImagePreviewHistoryEntry(session.token)) {
      closeRequestedRef.current = true;
      try {
        window.history.back();
        return;
      } catch {
        closeRequestedRef.current = false;
      }
    }
    closeOnce();
  }, [closeOnce]);
}
