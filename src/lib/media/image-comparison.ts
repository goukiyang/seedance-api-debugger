import type { ContentKey } from '@/lib/content-reactions/types';
import type { PickerItem, PickerResponse, PickerScope } from '@/lib/assets/picker-types';
import { readJsonResponse } from '@/lib/http/json-response';
import { isSafeIdentifier, sourceFingerprint, type MediaPreviewZoomMode } from '@/lib/hooks/use-media-preview-state';

export type ImageComparisonSource = {
  src: string; alt: string; fileName?: string; thumbnailSrc?: string;
  contentKey?: ContentKey; pickerKey?: string; id?: string; version?: string;
  width?: number; height?: number; fileSize?: number;
};
export type ImageView = { scale: number; x: number; y: number; mode: MediaPreviewZoomMode };
export type ComparisonPreferences = { linked: boolean; axis: 'horizontal' | 'vertical' };
export const fittedImageView: ImageView = { scale: 1, x: 0, y: 0, mode: 'fit' };
export const comparisonScopes: PickerScope[] = ['mine', 'project', 'shared', 'public'];
const prefix = 'sd2:media-preview:comparison:v1';
const validPickerKey = (key: unknown): key is string => typeof key === 'string' && /^(asset|reference_image):[a-zA-Z0-9_-]{1,100}$/.test(key);

export function imageDisplaySource(src: string, mode: 'preview' | 'thumbnail' | 'detail' | 'original' | 'download') {
  try {
    const url = new URL(src, 'https://sd2.youdooart.com');
    if (url.origin !== 'https://sd2.youdooart.com') return src;
    if (/^\/api\/image-studio\/(?:(?:assets|template-assets)\/|style-groups\/[^/]+\/assets\/)/.test(url.pathname)) {
      for (const variant of ['thumbnail', 'preview', 'detail', 'download']) url.searchParams.delete(variant);
      if (mode !== 'original') url.searchParams.set(mode, '1');
    } else if (/^\/api\/reference-images\/[^/]+\/content$/.test(url.pathname)) {
      url.searchParams.set('variant', mode);
    } else if (url.pathname === '/api/content-reactions/media') {
      url.searchParams.set('variant', mode);
    } else return src;
    return url.pathname + url.search;
  } catch { return src; }
}

export function sourcePickerKey(source: ImageComparisonSource) {
  if (validPickerKey(source.pickerKey)) return source.pickerKey;
  if (validPickerKey(source.contentKey)) return source.contentKey;
  const match = source.src.match(/^\/api\/(?:image-studio\/(?:assets|template-assets)|reference-images)\/([a-zA-Z0-9_-]+)(?:\/content)?(?:\?|$)/);
  return match ? `${source.src.startsWith('/api/reference-images/') ? 'reference_image' : 'asset'}:${match[1]}` : undefined;
}
export function imageSourceIdentity(source: ImageComparisonSource) {
  let canonicalSource = source.src;
  try { const url = new URL(source.src, 'https://sd2.youdooart.com'); if (url.origin === 'https://sd2.youdooart.com') canonicalSource = url.pathname + url.search; } catch { /* Unknown URLs are not persisted. */ }
  const fingerprint = sourceFingerprint(canonicalSource);
  if (!fingerprint) return source.src; // Temporary object URLs are session-only.
  const id = sourcePickerKey(source) || (isSafeIdentifier(source.id) ? source.id : 'image');
  return `${id}@${fingerprint}`;
}
export function pickerImageSource(item: PickerItem): ImageComparisonSource {
  return { src: item.originalUrl, thumbnailSrc: item.thumbnailUrl || undefined, alt: '图片预览', fileName: item.fileName,
    width: item.width || undefined, height: item.height || undefined, fileSize: item.fileSize ?? undefined,
    contentKey: item.referenceImageId ? `reference_image:${item.referenceImageId}` : item.key,
    pickerKey: item.referenceImageId ? `reference_image:${item.referenceImageId}` : item.key };
}
export async function resolveComparisonImage(key: string, signal?: AbortSignal): Promise<ImageComparisonSource> {
  if (!validPickerKey(key)) throw new Error('图片标识无效，请重新选择');
  for (const scope of comparisonScopes) {
    const params = new URLSearchParams({ target: 'workspace', scope, types: 'image', keys: key });
    const response = await fetch(`/api/assets/picker?${params}`, { signal, cache: 'no-store' });
    const data = await readJsonResponse<PickerResponse>(response);
    if (!response.ok) throw new Error('图片权限暂时无法确认，请重试');
    const item = data.items.find(value => value.type === 'image' && (value.key === key || `reference_image:${value.referenceImageId}` === key));
    if (item?.originalUrl) return pickerImageSource(item);
  }
  throw new Error('图片已失效或无权查看，请重新选择');
}
function read(key: string): Record<string, unknown> {
  try { const value = JSON.parse(localStorage.getItem(key) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
function write(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Restricted storage must not block preview. */ } }
export function readComparisonPreferences(user: string): Partial<ComparisonPreferences> {
  const value = read(`${prefix}:${encodeURIComponent(user)}:prefs`);
  return { ...(typeof value.linked === 'boolean' ? { linked: value.linked } : {}),
    ...(value.axis === 'horizontal' || value.axis === 'vertical' ? { axis: value.axis } : {}) };
}
export function saveComparisonPreferences(user: string, value: ComparisonPreferences) { write(`${prefix}:${encodeURIComponent(user)}:prefs`, value); }
export function readImageView(user: string, identity: string, pair: string, axis: string): ImageView | undefined {
  if (identity.startsWith('blob:') || identity.startsWith('data:')) return;
  const value = read(`${prefix}:${encodeURIComponent(user)}:views`);
  const saved = value[`${pair}:${axis}:${identity}`] || value[identity];
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
  const v = saved as Record<string, unknown>;
  if (![v.scale, v.x, v.y].every(n => typeof n === 'number' && Number.isFinite(n))
    || (v.scale as number) < 0.5 || (v.scale as number) > 1_000_000 || Math.abs(v.x as number) > 10_000 || Math.abs(v.y as number) > 10_000
    || !['fit', 'width', 'actual', 'custom'].includes(String(v.mode))) return;
  return { scale: v.scale as number, x: v.x as number, y: v.y as number, mode: v.mode as MediaPreviewZoomMode };
}
export function saveImageView(user: string, identity: string, pair: string, axis: string, view: ImageView) {
  if (identity.startsWith('blob:') || identity.startsWith('data:')) return;
  const value = read(`${prefix}:${encodeURIComponent(user)}:views`);
  delete value[identity]; delete value[`${pair}:${axis}:${identity}`];
  const entries = Object.entries(value).slice(-78);
  write(`${prefix}:${encodeURIComponent(user)}:views`, { ...Object.fromEntries(entries), [identity]: view, [`${pair}:${axis}:${identity}`]: view });
}
type SelectionRecord = { enabled: boolean; comparison?: { key: string; identity: string } };
function selectionKey(user: string, anchor: string) { return `${prefix}:${encodeURIComponent(user)}:selection:${encodeURIComponent(anchor)}`; }
export function readComparisonSelection(user: string, anchor: string, openedIdentity: string): SelectionRecord {
  const value = read(selectionKey(user, anchor));
  const source = (v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const data = v as Record<string, unknown>;
    return validPickerKey(data.key) && typeof data.identity === 'string' && data.identity.length <= 400 && !/[\/?#\\\u0000-\u001f]/.test(data.identity)
      ? { key: data.key, identity: data.identity } : undefined;
  };
  // Legacy selections may have been swapped. Restore only records with a known left/right assignment.
  const anchored = value.sidePolicy === 'anchored-current' || source(value.current)?.identity === openedIdentity;
  return anchored ? { enabled: value.enabled === true, comparison: source(value.comparison) } : { enabled: false };
}
export function saveComparisonSelection(user: string, anchor: string, current: ImageComparisonSource, comparison: ImageComparisonSource | null, enabled: boolean) {
  const record = (image: ImageComparisonSource | null) => {
    const key = image && sourcePickerKey(image);
    return key && image ? { key, identity: imageSourceIdentity(image) } : undefined;
  };
  write(selectionKey(user, anchor), { sidePolicy: 'anchored-current', enabled: enabled && Boolean(record(comparison)), current: record(current), comparison: record(comparison) });
}
