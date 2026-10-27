import type { PageInfo } from '@/lib/pagination/cursor';

export type AlbumPageOptions = { signal?: AbortSignal; ownerId?: string; cursor?: string | null; limit?: number };
export class AlbumPageError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function fetchAlbumPage<T>(address: string, key: 'albums' | 'images', options: AlbumPageOptions = {}) {
  const url = new URL(address, 'http://album-pages.invalid');
  url.searchParams.set('limit', String(options.limit || 24));
  if (options.cursor) url.searchParams.set('cursor', options.cursor); else url.searchParams.delete('cursor');
  const response = await fetch(`${url.pathname}${url.search}`, { cache: 'no-store', signal: options.signal,
    headers: options.ownerId ? { 'x-upload-owner-id': options.ownerId } : undefined });
  const data = await response.json();
  if (!response.ok) throw new AlbumPageError(data.error || data.message || '图集读取失败，请重试', response.status);
  const pagination = data.pagination as PageInfo | undefined;
  if (!Array.isArray(data[key]) || !pagination || !Number.isSafeInteger(pagination.total) || pagination.total < 0
    || !Number.isSafeInteger(pagination.limit) || pagination.limit < 1 || pagination.limit > 100
    || data[key].length > pagination.limit || data[key].length > pagination.total || typeof pagination.hasMore !== 'boolean'
    || pagination.hasMore && (!data[key].length || typeof pagination.nextCursor !== 'string' || !pagination.nextCursor)
    || !pagination.hasMore && pagination.nextCursor !== null) throw new Error('图集分页结果未能确认，请刷新后重试');
  return { items: data[key] as T[], pagination, album: data.album };
}

// Complete finite selectors and duplicate checks only. Browsing uses one page.
// A failed/malformed/repeated page rejects instead of returning a partial list.
export async function loadAllAlbumPages<T extends { id: string }>(address: string, key: 'albums' | 'images', options: AlbumPageOptions = {}) {
  const items: T[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let cursor: string | null = null;
  let total: number | null = null;
  for (let pages = 0; pages < 10000; pages++) {
    const page: { items: T[]; pagination: PageInfo } = await fetchAlbumPage<T>(address, key, { ...options, cursor, limit: 100 });
    if (total !== null && total !== page.pagination.total) throw new Error('图集列表已变化，请刷新后重试');
    total = page.pagination.total;
    for (const item of page.items) { if (ids.has(item.id)) throw new Error('图集列表已变化，请刷新后重试'); ids.add(item.id); items.push(item); }
    if (!page.pagination.hasMore) { if (items.length !== total) throw new Error('图集列表未读取完整，请重试'); return items; }
    cursor = page.pagination.nextCursor;
    if (!cursor || cursors.has(cursor)) throw new Error('图集分页未前进，请刷新后重试');
    cursors.add(cursor);
  }
  throw new Error('图集目录过大，请缩小范围后重试');
}

export function appendAlbumPage<T extends { id: string }>(previous: T[], incoming: T[]) {
  const ids = new Set(previous.map(item => item.id));
  return [...previous, ...incoming.filter(item => !ids.has(item.id))];
}
