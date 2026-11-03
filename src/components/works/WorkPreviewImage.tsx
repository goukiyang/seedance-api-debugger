'use client';

import { useEffect, useRef, useState } from 'react';
import type { WorkCard } from '@/lib/works/types';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { prepareImagePreview, type ImagePreviewPreparation, type PreparedImagePreviewState } from '@/lib/media/image-preview-session';
import { invalidateImageReadSource } from '@/lib/media/image-read-session';

export function WorkPreviewImage({ work, attempt, onFailure }: { work: WorkCard; attempt: number; onFailure: () => void }) {
  const { user, hasLoadedUser, userLoadError, sessionChanged } = useAppSession();
  const account = hasLoadedUser && !userLoadError && !sessionChanged ? `${user?.id || 'anonymous'}:${user?.role || ''}:${user?.account_type || ''}` : '';
  const source = work.detailPreviewUrl || work.previewUrl || '', previewOnly = !work.downloadUrl && !work.reuse;
  const key = JSON.stringify([account, source, attempt, previewOnly]);
  const [prepared, setPrepared] = useState<{ key: string; handle: ImagePreviewPreparation; state: PreparedImagePreviewState } | null>(null);
  const failure = useRef(onFailure); failure.current = onFailure;
  useEffect(() => {
    if (!account || !source) return;
    if (attempt) invalidateImageReadSource(source, account);
    // The URL binds the Work version; HD describes its own file version.
    const handle = prepareImagePreview({ account, source, previewOnly });
    const release = handle.subscribe(state => setPrepared({ key, handle, state }));
    handle.release(); return release;
  }, [key, account, source, attempt, previewOnly]);
  const current = prepared?.key === key ? prepared : null;
  useEffect(() => {
    if (current && (current.state.denied || current.state.result.unconfirmed || ['unavailable', 'unsupported'].includes(current.state.result.progress.phase))) failure.current();
  }, [current]);
  return <img src={!account || current?.state.denied ? undefined : current?.state.result.decoded ? current.state.result.imageSrc || undefined : work.thumbnailUrl || undefined} alt={work.title}
    onError={() => { if (current?.state.result.decoded) failure.current(); }}
    onLoad={event => {
      const image = event.currentTarget;
      if (current?.state.result.decoded && image.currentSrc === current.state.result.imageSrc) requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!document.hidden && image.isConnected && current.handle.isCurrent()) current.handle.markDisplayed();
      }));
    }} />;
}
