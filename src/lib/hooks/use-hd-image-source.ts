'use client';
import { useEffect, useState } from 'react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { imageDisplaySource } from '@/lib/media/image-comparison';

export type HdDescription = { status: 'queued' | 'running' | 'ready' | 'failed' | 'skipped';
  sourceVersion: string | null; policy: string; reason?: string; format?: string;
  mime?: string; bytes?: number; width?: number; height?: number; original?: boolean };
export function versionedHdSource(source: string, mode: 'hd' | 'hd-download', version?: string | null) {
  const value = imageDisplaySource(source, mode);
  const url = new URL(value, window.location.origin);
  if (version) url.searchParams.set('hd-version', version);
  return url.origin === window.location.origin ? `${url.pathname}${url.search}` : url.href;
}
export function useHdImageSource(source: string, original: boolean, attempt: number, sourceVersion: string) {
  const { user, hasLoadedUser, userLoadError } = useAppSession();
  const account = hasLoadedUser && !userLoadError ? `${user?.id || 'anonymous'}:${user?.role || ''}:${user?.account_type || ''}` : '';
  const key = `${account}:${source}:${sourceVersion}:${attempt}`;
  const [state, setState] = useState<{ key: string; description?: HdDescription; denied?: boolean; error?: boolean } | null>(null);
  const descriptionSource = imageDisplaySource(source, 'hd-description');
  const supported = descriptionSource !== source && !/^(blob:|data:)/i.test(source);
  useEffect(() => {
    if (!account || !supported) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const response = await fetch(descriptionSource, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok) {
          if (!controller.signal.aborted) setState({ key, denied: [401, 403, 404].includes(response.status), error: true });
          return;
        }
        const data = await response.json() as HdDescription;
        if (controller.signal.aborted) return;
        if (data.policy !== 'hd-f-v1' || !['queued', 'running', 'ready', 'failed', 'skipped'].includes(data.status)) throw new Error('invalid_descriptor');
        setState({ key, description: data });
        if (['queued', 'running'].includes(data.status)) timer = setTimeout(read, 5000);
      } catch {
        if (!controller.signal.aborted) setState({ key, error: true });
      }
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key, account, supported, descriptionSource]);
  const current = state?.key === key ? state : null;
  const description = current?.description;
  const pending = supported && !original && !current?.error && (!description || ['queued', 'running'].includes(description.status));
  const raw = original || description?.status === 'skipped' || description?.status === 'failed' || Boolean(pending && description);
  const readSource = pending && !raw ? '' : raw ? imageDisplaySource(source, 'original') : description?.status === 'ready'
    ? versionedHdSource(source, 'hd', description.sourceVersion) : imageDisplaySource(source, 'preview');
  return { readSource, description, pending, denied: current?.denied, error: current?.error,
    version: description?.sourceVersion || sourceVersion, fullSize: raw || description?.status === 'ready' || source.startsWith('blob:') };
}
