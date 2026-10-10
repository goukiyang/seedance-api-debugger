'use client';
import { useCallback, useEffect, useState } from 'react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { imageDisplaySource } from '@/lib/media/image-comparison';
import { acquireHdImageSource, hdImageHint, type HdSourceState } from '@/lib/media/hd-source-session';
import { setImageReadSessionOwner } from '@/lib/media/image-read-session';
export type { HdDescription } from '@/lib/media/hd-source-session';

export function versionedHdSource(source: string, mode: 'hd' | 'hd-download', version?: string | null) {
  const value = imageDisplaySource(source, mode);
  const url = new URL(value, window.location.origin);
  if (version) url.searchParams.set('hd-version', version);
  return url.origin === window.location.origin ? `${url.pathname}${url.search}` : url.href;
}
export function useHdImageSource(source: string, original: boolean, attempt: number, sourceVersion: string) {
  const { user, hasLoadedUser, userLoadError } = useAppSession();
  const account = hasLoadedUser && !userLoadError ? `${user?.id || 'anonymous'}:${user?.role || ''}:${user?.account_type || ''}` : '';
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const refresh = useCallback(() => setRefreshAttempt(value => value + 1), []);
  const key = `${account}:${source}:${sourceVersion}:${attempt}:${refreshAttempt}`;
  const [state, setState] = useState<(HdSourceState & { key: string }) | null>(null);
  const descriptionSource = imageDisplaySource(source, 'hd-description');
  const supported = descriptionSource !== source && !/^(blob:|data:)/i.test(source);
  useEffect(() => {
    if (!account || !supported || original) return;
    setImageReadSessionOwner(account);
    return acquireHdImageSource(account, descriptionSource, sourceVersion, result => setState({ key, ...result }));
  }, [key, account, supported, original, descriptionSource, sourceVersion]);
  const current = state?.key === key ? state : null;
  const description = original ? undefined : current?.description || (account && supported ? hdImageHint(account, descriptionSource, sourceVersion) : undefined);
  const pending = supported && !original && !current?.error && (!description || ['queued', 'running'].includes(description.status));
  const raw = original || description?.status !== 'ready';
  const readSource = raw ? imageDisplaySource(source, 'original') : versionedHdSource(source, 'hd', description.sourceVersion);
  return { readSource, description, pending, denied: current?.denied, error: current?.error,
    refresh, version: raw ? sourceVersion : description?.sourceVersion || sourceVersion, fullSize: raw || description?.status === 'ready' || source.startsWith('blob:') };
}
