import type { PickerAlbum, PickerResponse, PickerTemplate } from './picker-types';

export async function pickerWithDirectories(params: URLSearchParams, ownerId: string, signal?: AbortSignal): Promise<PickerResponse> {
  if (!ownerId) throw new Error('当前账号尚未确认');
  const read = async (query: URLSearchParams) => {
    const response = await fetch(`/api/assets/picker?${query}`, { cache: 'no-store', signal, headers: { 'x-upload-owner-id': ownerId } });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '素材目录暂不可读取，请重试');
    if (!Array.isArray(data.items) || data.items.length > 100) throw new Error('素材分页结果未能确认');
    return data as PickerResponse;
  };
  const result = await read(params);
  if (!result.directoryDeferred) return result;
  const directories: { albums: PickerAlbum[]; templates: PickerTemplate[] } = { albums: [], templates: [] };
  for (const kind of ['albums', 'templates'] as const) {
    let cursor: string | null = null, total: number | null = null;
    const seen = new Set<string>(), cursors = new Set<string>();
    for (let page = 0; page < 10000; page++) {
      const query = new URLSearchParams(params);
      query.delete('after'); query.delete('page'); query.delete('keys');
      query.set('directory', kind); query.set('limit', '100');
      if (cursor) query.set('directory_after', cursor);
      const data = await read(query), info = data.directoryPage;
      const rows = kind === 'albums' ? data.albums : data.templates || [];
      if (!info || !Array.isArray(rows) || rows.length > 100 || !Number.isSafeInteger(info.total) || info.total < 0
        || total !== null && total !== info.total || info.hasMore && (!rows.length || !info.nextCursor)) throw new Error('素材目录已变化，请重新读取');
      total = info.total;
      for (const row of rows) {
        const identity = kind === 'albums' ? `${(row as PickerAlbum).scope}:${row.id}` : row.id;
        if (seen.has(identity)) throw new Error('素材目录出现重复分页，请重新读取');
        seen.add(identity);
        if (kind === 'albums') directories.albums.push(row as PickerAlbum); else directories.templates.push(row as PickerTemplate);
      }
      if (!info.hasMore) {
        if (seen.size !== total) throw new Error('素材目录未读取完整，请重试');
        break;
      }
      cursor = info.nextCursor;
      if (!cursor || cursors.has(cursor) || page === 9999) throw new Error('素材目录分页未前进，请重新读取');
      cursors.add(cursor);
    }
  }
  return { ...result, ...directories, directoryDeferred: false };
}
