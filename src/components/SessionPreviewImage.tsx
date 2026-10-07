'use client';
import { useImageReadProgress } from '@/lib/hooks/use-image-read-progress';
import { imageDisplaySource } from '@/lib/media/image-comparison';
import { useAppSession } from '@/lib/context/AppSessionContext';

export function SessionPreviewImage({ src, thumbnail, alt }: { src: string; thumbnail?: string | null; alt: string }) {
  const result = useImageReadProgress(imageDisplaySource(src, 'preview'), 0);
  const { user } = useAppSession();
  return <><img key={`${user?.id || 'anonymous'}:${user?.role || ''}:${user?.account_type || ''}`} src={result.imageSrc || (!result.denied ? thumbnail || undefined : undefined)} alt={alt} decoding="async" />
    {result.progress.phase === 'unavailable' && <span role="status">{result.denied ? '图片权限或来源不可用' : '清晰预览暂不可用，打开大图可重试'}</span>}</>;
}
