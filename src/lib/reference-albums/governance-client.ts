import type { PageInfo } from '@/lib/pagination/cursor';
import { AlbumPageError, type AlbumPageOptions } from '@/lib/reference-albums/client-pages';

export async function fetchGovernancePage<T>(address: string, key: 'folders' | 'shares' | 'submissions', options: AlbumPageOptions = {}) {
  const url = new URL(address, 'http://album-governance.invalid');
  url.searchParams.set('limit', String(options.limit || 24));
  if (options.cursor) url.searchParams.set('cursor', options.cursor); else url.searchParams.delete('cursor');
  const response = await fetch(`${url.pathname}${url.search}`, { cache: 'no-store', signal: options.signal,
    headers: options.ownerId ? { 'x-upload-owner-id': options.ownerId } : undefined });
  const data = await response.json();
  if (!response.ok) throw new AlbumPageError(data.error || data.message || '列表读取失败，请重试', response.status);
  const pagination = data.pagination as PageInfo | undefined;
  if (!Array.isArray(data[key]) || !pagination || !Number.isSafeInteger(pagination.total) || pagination.total < 0
    || !Number.isSafeInteger(pagination.limit) || pagination.limit < 1 || pagination.limit > 100
    || data[key].length > pagination.limit || data[key].length > pagination.total || typeof pagination.hasMore !== 'boolean'
    || pagination.hasMore && (!data[key].length || typeof pagination.nextCursor !== 'string' || !pagination.nextCursor)
    || !pagination.hasMore && pagination.nextCursor !== null) throw new Error('分页结果未能确认，请刷新后重试');
  return { items: data[key] as T[], pagination, canManage: Boolean(data.can_manage) };
}

// Folder selectors need the complete finite directory before validating a target.
// Never return a partial directory after an error or a changing/repeated page.
export async function loadAllFolderPages<T extends { id: string }>(options: AlbumPageOptions = {}) {
  const folders: T[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let cursor: string | null = null, total: number | null = null, canManage = false;
  for (;;) {
    const page: { items: T[]; pagination: PageInfo; canManage: boolean } = await fetchGovernancePage<T>('/api/reference-album-folders', 'folders', { ...options, cursor, limit: 100 });
    if (total !== null && total !== page.pagination.total) throw new Error('文件夹列表已变化，请重试');
    total = page.pagination.total; canManage = page.canManage;
    for (const item of page.items) { if (ids.has(item.id)) throw new Error('文件夹列表已变化，请重试'); ids.add(item.id); folders.push(item); }
    if (!page.pagination.hasMore) {
      if (folders.length !== total) throw new Error('文件夹列表未读取完整，请重试');
      return { folders, canManage };
    }
    cursor = page.pagination.nextCursor;
    if (!cursor || cursors.has(cursor)) throw new Error('文件夹分页未前进，请重试');
    cursors.add(cursor);
  }
}
