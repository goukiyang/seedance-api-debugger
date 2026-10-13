'use client';
import { useCallback, useEffect, useState } from 'react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { imageDisplaySource } from '@/lib/media/image-comparison';
import { acquireHdImageSource, hdImageHint, type HdSourceState } from '@/lib/media/hd-source-session';
import { setImageReadSessionOwner } from '@/lib/media/image-read-session';
import { hdDisplayPolicy } from '@/lib/media/hd-display-policy';
export type { HdDescription } from '@/lib/media/hd-source-session';

export function versionedHdSource(source: string, mode: 'hd' | 'hd-download', version?: string | null) {
  const value = imageDisplaySource(source, mode);
  const url = new URL(value, window.location.origin);
  if (version) url.searchParams.set('hd-version', version);
  return url.origin === window.location.origin ? `${url.pathname}${url.search}` : url.href;
}
export function useHdImageSource(source: string, original: boolean, attempt: number, sourceVersion: string, previewOnly = false) {
  const { user, hasLoadedUser, userLoadError, sessionChanged } = useAppSession();
  const account = hasLoadedUser && !userLoadError && !sessionChanged ? `${user?.id || 'anonymous'}:${user?.role || ''}:${user?.account_type || ''}` : '';
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const refresh = useCallback(() => setRefreshAttempt(value => value + 1), []);
  const key = `${account}:${source}:${sourceVersion}:${attempt}:${refreshAttempt}:${previewOnly}`;
  const [state, setState] = useState<(HdSourceState & { key: string }) | null>(null);
  const descriptionSource = imageDisplaySource(source, 'hd-description');
  const supported = !previewOnly && descriptionSource !== source && !/^(blob:|data:)/i.test(source);
  useEffect(() => {
    if (!account || !supported || original) return;
    setImageReadSessionOwner(account);
    return acquireHdImageSource(account, descriptionSource, sourceVersion, result => setState({ key, ...result }));
  }, [key, account, supported, original, descriptionSource, sourceVersion]);
  const current = state?.key === key ? state : null;
  // Manual original viewing must not erase an already known HD status. It stops
  // descriptor requests, but does not pretend a known ready file is missing.
  const description = current?.description || (account && supported ? hdImageHint(account, descriptionSource, sourceVersion, true) : undefined);
  const display = hdDisplayPolicy({ original, previewOnly, supported, description, error: current?.error });
  const readSource = display.kind === 'preview' ? imageDisplaySource(source, 'preview') : display.kind === 'original' ? imageDisplaySource(source, 'original') : versionedHdSource(source, 'hd', description?.sourceVersion);
  return { readSource, description, pending: display.pending, displayKind: display.kind, denied: current?.denied, error: current?.error,
    refresh, version: display.kind === 'hd' ? description?.sourceVersion || sourceVersion : sourceVersion, fullSize: display.fullSize };
}
