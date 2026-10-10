'use client';

import { useEffect, useRef } from 'react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { imageDisplaySource } from '@/lib/media/image-comparison';
import { canPrefetchImages, prefetchImageRead, setImageReadSessionOwner } from '@/lib/media/image-read-session';
import { prefetchHdImageSource } from '@/lib/media/hd-source-session';
import { versionedHdSource } from './use-hd-image-source';

export type ImageReadCandidate = { source: string; sourceVersion?: string; thumbnail?: string; width?: number; height?: number; bytes?: number; variant?: 'original' | 'hd' | 'preview' };
function sourceFamily(source: string) {
  try {
    const url = new URL(source, 'https://sd2.youdooart.com'); url.hash = '';
    for (const name of ['thumbnail', 'preview', 'detail', 'download', 'hd', 'hd-description', 'hd-download', 'hd-version', 'variant']) url.searchParams.delete(name);
    url.searchParams.sort();
    return url.pathname.startsWith('/api/') ? `${url.pathname}${url.search}` : url.href;
  } catch { return source; }
}
export function useImageNeighbors(candidates: ImageReadCandidate[], enabled: boolean, currentSource = '') {
  const { user, hasLoadedUser, userLoadError } = useAppSession();
  const account = hasLoadedUser && !userLoadError ? `${user?.id || 'anonymous'}:${user?.role || ''}:${user?.account_type || ''}` : '';
  const current = sourceFamily(currentSource);
  const movement = useRef<1 | -1 | 0>(0);
  const history = useRef<{ current: string; neighbors: string[] }>({ current: '', neighbors: [] });
  const available = candidates.slice(0, 2);
  const neighborKeys = available.map(candidate => sourceFamily(candidate.source));
  if (enabled && current && current !== history.current.current) {
    const movedTo = history.current.neighbors.indexOf(current);
    movement.current = movedTo === 1 ? 1 : movedTo === 0 ? -1 : 0;
    history.current = { current, neighbors: neighborKeys };
  } else if (enabled && current) history.current.neighbors = neighborKeys;
  const ordered = movement.current === 1 ? [available[1], available[0]] : available;
  const key = JSON.stringify(ordered.filter((candidate): candidate is ImageReadCandidate => Boolean(candidate)));
  useEffect(() => {
    if (!enabled || !account || !canPrefetchImages()) return;
    setImageReadSessionOwner(account);
    const releases: Array<() => void> = [];
    let active = true;
    for (const candidate of JSON.parse(key) as ImageReadCandidate[]) {
      if (!active || !canPrefetchImages(candidate.bytes || 0) || /^(blob:|data:)/i.test(candidate.source)) continue;
      const original = imageDisplaySource(candidate.source, 'original');
      const start = (source: string, version: string) => { if (active && canPrefetchImages(candidate.bytes || 0)) releases.push(prefetchImageRead(account, source, version)); };
      if (candidate.variant === 'original') { start(original, candidate.sourceVersion || ''); continue; }
      if (candidate.variant === 'preview') { start(imageDisplaySource(candidate.source, 'preview'), candidate.sourceVersion || ''); continue; }
      const description = imageDisplaySource(candidate.source, 'hd-description');
      if (description === candidate.source) { start(original, candidate.sourceVersion || ''); continue; }
      const request = prefetchHdImageSource(account, description, candidate.sourceVersion || '');
      releases.push(request.release);
      void request.result.then(state => {
        if (state.denied) return;
        const hd = state.description;
        start(hd?.status === 'ready' ? versionedHdSource(candidate.source, 'hd', hd.sourceVersion) : original,
          hd?.status === 'ready' ? hd.sourceVersion || candidate.sourceVersion || '' : candidate.sourceVersion || '');
      });
    }
    const stop = () => { active = false; for (const release of releases.splice(0)) release(); };
    const visibility = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { stop(); document.removeEventListener('visibilitychange', visibility); };
  }, [account, key, enabled]);
}
