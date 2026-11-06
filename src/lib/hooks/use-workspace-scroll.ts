'use client';

import { useRememberedScroll } from './use-remembered-scroll';
import { useRef } from 'react';

// Page-owned readiness keeps restoration behind the actual account, filters and data.
// Explicit return anchors continue to use each page's existing focus/return behavior.
export function useWorkspaceScroll(owner: string, view: string, ready: boolean, anchored = false) {
  const key = `workspace:${owner}:${view}`;
  const entry = useRef<{ key: string; anchored: boolean } | null>(null);
  if (entry.current?.key !== key) entry.current = null;
  if (ready && !entry.current && typeof window !== 'undefined') entry.current = {
    key, anchored: Boolean(window.location.hash || new URLSearchParams(window.location.search).get('list_item')),
  };
  useRememberedScroll(key, Boolean(owner && ready), {
    localFallback: true, skipRestore: anchored || Boolean(entry.current?.anchored),
  });
}
