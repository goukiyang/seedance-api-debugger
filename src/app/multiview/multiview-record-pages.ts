import type { MultiviewRecord } from '@/lib/video/multiview-records.server';
import type { PageInfo } from '@/lib/pagination/cursor';

export type RecordProject = { id: string; title: string };
export class MultiviewRecordReadError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}
function pagination(data: Record<string, unknown>, count: number): PageInfo {
  const page = data.pagination as PageInfo | undefined;
  if (!page || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100 || count > page.limit
    || !Number.isSafeInteger(page.total) || page.total < count || data.total !== page.total
    || typeof page.hasMore !== 'boolean' || data.nextCursor !== page.nextCursor
    || (page.hasMore ? typeof page.nextCursor !== 'string' || !page.nextCursor || count === 0 : page.nextCursor !== null)) {
    throw new MultiviewRecordReadError('列表暂不可读取，请重试。');
  }
  return page;
}
async function read(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new MultiviewRecordReadError(typeof data?.error === 'string' && data.error.length <= 300 ? data.error : '记录暂不可读取，请重试。', response.status);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new MultiviewRecordReadError('列表暂不可读取，请重试。');
  return data as Record<string, unknown>;
}
export async function readMultiviewRecordPage(response: Response) {
  const data = await read(response);
  if (!Array.isArray(data.items) || data.items.some(item => !item || typeof item.id !== 'string')) throw new MultiviewRecordReadError('记录暂不可读取，请重试。');
  const page = pagination(data, data.items.length);
  return { items: data.items as MultiviewRecord[], ...page };
}

// Preferences may be validated only against this complete, finite directory.
// Authority changes abort the whole read; partial pages are never published.
export async function loadMultiviewRecordProjects(options: { owner: string; removed: boolean; fetch: typeof fetch;
  signal: AbortSignal; current: () => boolean }) {
  const projects = new Map<string, RecordProject>(); let cursor: string | null = null, total: number | undefined;
  const assertCurrent = () => { if (options.signal.aborted || !options.current()) throw new DOMException('Aborted', 'AbortError'); };
  do {
    assertCurrent();
    const params = new URLSearchParams({ directory: 'projects', removed: options.removed ? '1' : '0', limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const request = new AbortController(), abort = () => request.abort();
    options.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 30000);
    let data: Record<string, unknown>;
    try {
      const response = await options.fetch(`/api/video/multiview/records?${params}`, { cache: 'no-store', signal: request.signal,
        headers: { 'x-app-session-user': options.owner } });
      data = await read(response);
      if (request.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    } finally { clearTimeout(timeout); options.signal.removeEventListener('abort', abort); }
    assertCurrent();
    if (!Array.isArray(data.projects) || data.projects.some(project => !project || typeof project.id !== 'string' || !project.id || typeof project.title !== 'string')) {
      throw new MultiviewRecordReadError('项目目录暂不可读取，请重试。');
    }
    const page = pagination(data, data.projects.length); total ??= page.total;
    if (page.total !== total) throw new MultiviewRecordReadError('项目目录已变化，请刷新。', 409);
    for (const project of data.projects as RecordProject[]) {
      if (projects.has(project.id)) throw new MultiviewRecordReadError('项目目录已变化，请刷新。', 409);
      projects.set(project.id, project);
    }
    if (projects.size > total || page.nextCursor && page.nextCursor === cursor) throw new MultiviewRecordReadError('项目目录暂不可读取，请重试。');
    cursor = page.nextCursor;
  } while (cursor);
  assertCurrent();
  if (projects.size !== total) throw new MultiviewRecordReadError('项目目录暂不可读取，请重试。');
  return [...projects.values()];
}
