import { isPublicHttpUrl } from '@/lib/media/public-url';

export function cacheSafeAssetUrl(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;

  if (!isPublicHttpUrl(trimmed)) return null;
  return new URL(trimmed).toString();
}
