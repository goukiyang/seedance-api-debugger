'use client';
import { useEffect, useRef, useState } from 'react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { readReadyStudioInputMain } from '@/lib/image-studio/input-main-client';
import type { StudioInputMainSource } from '@/lib/image-studio/input-main';
import type { UploadedAssetPayload } from '@/lib/http/file-upload';
import { ZoomableImagePreview } from './ZoomableImagePreview';
export function StudioInputMainViewer({ source, scopeKey, onClose }: { source: StudioInputMainSource; scopeKey: string; onClose: () => void }) {
  const { user, sessionChanged } = useAppSession();
  const owner = useRef(user?.id), sequence = useRef(0);
  const [images, setImages] = useState<UploadedAssetPayload[]>([]), [index, setIndex] = useState(0), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    const token = ++sequence.current; setImages([]); setError('');
    if (!user || sessionChanged || owner.current !== user.id) { onClose(); return; }
    void readReadyStudioInputMain(source).then(result => { if (token === sequence.current) { setImages(result.images); setIndex(0); } })
      .catch(cause => { if (token === sequence.current) setError(cause instanceof Error ? cause.message : '输入主图暂不可读'); });
    return () => { sequence.current++; };
  }, [scopeKey, user?.id, sessionChanged, retry]);
  const image = images[index];
  if (!image) return <div role="status">{error || '正在读取本次输入主图'}{error && <button type="button" onClick={() => setRetry(value => value + 1)}>重新读取</button>}<button type="button" onClick={onClose}>关闭</button></div>;
  return <ZoomableImagePreview src={image.originalUrl || ''} thumbnailSrc={image.thumbnailUrl || undefined} alt={`输入主图 ${index + 1}/${images.length}`} previewKey={`${scopeKey}:${image.id}`} fileName={image.fileName}
    safeDetails={{ width: image.width || undefined, height: image.height || undefined }} contentKey={image.id ? `asset:${image.id}` : undefined} imageSharing={false} hasNavigation={images.length > 1} onClose={onClose}
    onPrevious={index > 0 ? () => setIndex(value => value - 1) : undefined} onNext={index + 1 < images.length ? () => setIndex(value => value + 1) : undefined} />;
}
