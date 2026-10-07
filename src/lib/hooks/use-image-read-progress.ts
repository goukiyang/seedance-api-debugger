'use client';
import { useEffect, useState } from 'react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { acquireImageRead, type ImageReadResult } from '@/lib/media/image-read-session';
export type { ImageReadProgress } from '@/lib/media/image-read-session';

export function useImageReadProgress(source: string, attempt: number, enabled = true, version = ''): ImageReadResult {
  const { user, hasLoadedUser, userLoadError } = useAppSession();
  const account = hasLoadedUser && !userLoadError ? user ? `${user.id}:${user.role}:${user.account_type || ''}` : 'anonymous' : '';
  const key = `${account}\u0000${source}\u0000${version}\u0000${attempt}`;
  const [entry, setEntry] = useState<(ImageReadResult & { key: string }) | null>(null);
  useEffect(() => {
    if (!enabled) return;
    if (/^(blob:|data:)/i.test(source)) {
      let current = true;
      const image = new Image(); image.src = source;
      void image.decode().then(() => { if (current) setEntry({ key, imageSrc: source, progress: { phase: 'decoding', loadedBytes: 0 } }); }).catch(() => { if (current) setEntry({ key, imageSrc: null, progress: { phase: 'unavailable', loadedBytes: 0, message: '本地图片无法解码，请重试' } }); });
      return () => { current = false; };
    }
    let current = true;
    const release = acquireImageRead(account, source, version, attempt, result => { if (current) setEntry({ key, ...result }); });
    return () => { current = false; release(); };
  }, [key, account, source, attempt, enabled, version]);
  return enabled && entry?.key === key ? entry : { imageSrc: null, denied: !account, progress: { phase: 'reading', loadedBytes: 0 } };
}
