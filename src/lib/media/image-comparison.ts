import type { ContentKey } from '@/lib/content-reactions/types';
import type { PickerItem, PickerResponse, PickerScope } from '@/lib/assets/picker-types';
import { readJsonResponse } from '@/lib/http/json-response';
import { isSafeIdentifier, sourceFingerprint, type MediaPreviewZoomMode } from '@/lib/hooks/use-media-preview-state';

export type ImageComparisonSource = {
  src: string; alt: string; fileName?: string; thumbnailSrc?: string;
  /** Supplied only when the caller knows this image's relationship to the result. */
  role?: 'original' | 'generated' | 'reference';
  contentKey?: ContentKey; pickerKey?: string; id?: string; version?: string;
  width?: number; height?: number; fileSize?: number;
};
export type ImageView = { scale: number; x: number; y: number; mode: MediaPreviewZoomMode; original?: boolean };
export type ComparisonPreferences = { linked: boolean; axis: 'horizontal' | 'vertical' };
export type ComparisonResolveFailureKind = 'permission' | 'deleted' | 'identity-version-change' | 'transient' | 'cancelled';
export class ComparisonResolveError extends Error {
  constructor(readonly kind: ComparisonResolveFailureKind, message: string) {
    super(message);
    this.name = 'ComparisonResolveError';
  }
}
export const fittedImageView: ImageView = { scale: 1, x: 0, y: 0, mode: 'fit' };
export const comparisonScopes: PickerScope[] = ['mine', 'project', 'shared', 'public'];
const prefix = 'sd2:media-preview:comparison:v1';
const validPickerKey = (key: unknown): key is string => typeof key === 'string' && /^(asset|reference_image):[a-zA-Z0-9_-]{1,100}$/.test(key);

export function imageDisplaySource(src: string, mode: 'preview' | 'thumbnail' | 'detail' | 'original' | 'download' | 'hd' | 'hd-description' | 'hd-download') {
  try {
    const url = new URL(src, 'https://sd2.youdooart.com');
    if (url.origin !== 'https://sd2.youdooart.com') return src;
    if (/^\/api\/image-studio\/(?:(?:assets|template-assets)\/|style-groups\/[^/]+\/assets\/)/.test(url.pathname)) {
      for (const variant of ['thumbnail', 'preview', 'detail', 'download', 'hd', 'hd-description', 'hd-download']) url.searchParams.delete(variant);
      url.searchParams.delete('variant');
      url.searchParams.delete('hd-version');
      url.searchParams.delete('hd-representation');
      if (mode !== 'original') url.searchParams.set(mode, '1');
    } else if (/^\/api\/reference-images\/[^/]+\/content$/.test(url.pathname)) {
      for (const variant of ['thumbnail', 'preview', 'detail', 'download', 'hd', 'hd-description', 'hd-download', 'hd-version', 'hd-representation']) url.searchParams.delete(variant);
      url.searchParams.set('variant', mode);
    } else if (url.pathname === '/api/content-reactions/media') {
      for (const variant of ['thumbnail', 'preview', 'detail', 'download', 'hd', 'hd-description', 'hd-download', 'hd-version', 'hd-representation']) url.searchParams.delete(variant);
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
  return { src: item.previewUrl || item.originalUrl, thumbnailSrc: item.thumbnailUrl || undefined, alt: '图片预览', fileName: item.fileName,
    width: item.width || undefined, height: item.height || undefined, fileSize: item.fileSize ?? undefined,
    contentKey: item.referenceImageId ? `reference_image:${item.referenceImageId}` : item.key,
    pickerKey: item.referenceImageId ? `reference_image:${item.referenceImageId}` : item.key };
}
function responseFailure(status: number) {
  if (status === 401) return new ComparisonResolveError('transient', '登录状态暂时无法确认，请重新登录后重试');
  if (status === 403) return new ComparisonResolveError('permission', '没有权限读取这张对比图，请重新选择');
  if (status === 404 || status === 410) return new ComparisonResolveError('deleted', '这张对比图已删除或不再可用，请重新选择');
  if (status === 409) return new ComparisonResolveError('identity-version-change', '这张对比图已更新，不能自动替换，请重新选择');
  return new ComparisonResolveError('transient', '暂时无法读取对比图，请重试');
}

export function comparisonResolveFailure(error: unknown) {
  if (error instanceof ComparisonResolveError) return error;
  if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') return new ComparisonResolveError('cancelled', '已取消读取对比图');
  return new ComparisonResolveError('transient', '暂时无法读取对比图，请重试');
}

export async function resolveComparisonImage(key: string, signal?: AbortSignal): Promise<ImageComparisonSource> {
  if (!validPickerKey(key)) throw new ComparisonResolveError('identity-version-change', '对比图记录已变更，请重新选择');
  try {
    for (const scope of comparisonScopes) {
      const params = new URLSearchParams({ target: 'workspace', scope, types: 'image', keys: key });
      const response = await fetch(`/api/assets/picker?${params}`, { signal, cache: 'no-store' });
      if (!response.ok) throw responseFailure(response.status);
      const data = await readJsonResponse<PickerResponse>(response);
      const item = data.items.find(value => value.type === 'image' && (value.key === key || `reference_image:${value.referenceImageId}` === key));
      if (item?.previewUrl || item?.originalUrl) return pickerImageSource(item);
    }
    throw new ComparisonResolveError('deleted', '这张对比图已删除或不再可用，请重新选择');
  } catch (error) {
    if (signal?.aborted) throw new ComparisonResolveError('cancelled', '已取消读取对比图');
    throw comparisonResolveFailure(error);
  }
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
  return { scale: v.scale as number, x: v.x as number, y: v.y as number, mode: v.mode as MediaPreviewZoomMode,
    ...(typeof v.original === 'boolean' ? { original: v.original } : {}) };
}
export function saveImageView(user: string, identity: string, pair: string, axis: string, view: ImageView) {
  if (identity.startsWith('blob:') || identity.startsWith('data:')) return;
  const value = read(`${prefix}:${encodeURIComponent(user)}:views`);
  const previous = readImageView(user, identity, pair, axis);
  const persisted = { scale: view.scale, x: view.x, y: view.y, mode: view.mode,
    ...(typeof view.original === 'boolean' ? { original: view.original } : typeof previous?.original === 'boolean' ? { original: previous.original } : {}) };
  delete value[identity]; delete value[`${pair}:${axis}:${identity}`];
  const entries = Object.entries(value).slice(-78);
  write(`${prefix}:${encodeURIComponent(user)}:views`, { ...Object.fromEntries(entries), [identity]: persisted, [`${pair}:${axis}:${identity}`]: persisted });
}
export type ComparisonSelectionRecord = { enabled: boolean; comparison?: { key: string; identity: string }; storageSnapshot?: string; invalid?: boolean };
function selectionKey(user: string, anchor: string) { return `${prefix}:${encodeURIComponent(user)}:selection:${encodeURIComponent(anchor)}`; }
export function readComparisonSelection(user: string, anchor: string, openedIdentity: string): ComparisonSelectionRecord {
  const key = selectionKey(user, anchor);
  let storageSnapshot: string | undefined;
  try { storageSnapshot = localStorage.getItem(key) || undefined; } catch { /* Restricted storage has no restorable selection. */ }
  const value = read(key);
  const source = (v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const data = v as Record<string, unknown>;
    return validPickerKey(data.key) && typeof data.identity === 'string' && data.identity.length <= 400 && !/[\/?#\\\u0000-\u001f]/.test(data.identity)
      ? { key: data.key, identity: data.identity } : undefined;
  };
  // Legacy selections may have been swapped. Restore only records with a known left/right assignment.
  const anchored = value.sidePolicy === 'anchored-current' || source(value.current)?.identity === openedIdentity;
  const comparison = source(value.comparison);
  if (!anchored) return { enabled: false, storageSnapshot, invalid: Boolean(storageSnapshot) };
  return { enabled: value.enabled === true, comparison, storageSnapshot,
    invalid: (value.enabled === true && !comparison) || (value.comparison != null && !comparison) };
}
export function saveComparisonSelection(user: string, anchor: string, current: ImageComparisonSource, comparison: ImageComparisonSource | null, enabled: boolean) {
  const record = (image: ImageComparisonSource | null) => {
    const key = image && sourcePickerKey(image);
    return key && image ? { key, identity: imageSourceIdentity(image) } : undefined;
  };
  write(selectionKey(user, anchor), { sidePolicy: 'anchored-current', enabled: enabled && Boolean(record(comparison)), current: record(current), comparison: record(comparison) });
}

export function clearComparisonSelectionIfUnchanged(user: string, anchor: string, expected: ComparisonSelectionRecord) {
  if (!expected.storageSnapshot) return false;
  const key = selectionKey(user, anchor);
  try {
    if (localStorage.getItem(key) !== expected.storageSnapshot) return false;
    localStorage.removeItem(key);
    return localStorage.getItem(key) === null;
  } catch {
    return false;
  }
}
