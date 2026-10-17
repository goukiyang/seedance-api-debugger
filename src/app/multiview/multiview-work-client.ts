'use client';

import type { MultiviewWorkDto, MultiviewWorkFileRole } from '@/lib/video/multiview-work-contract';

type WorkFile = NonNullable<MultiviewWorkDto['ready']>['files'][number];
type CachedFile = { blob: Blob; bytes: number; etag: string };
const files = new Map<string, CachedFile>();
const MAX_CACHE = 128 * 1024 * 1024;
const MAX_FILE = 256 * 1024 * 1024;

export function clearMultiviewWorkFiles() { files.clear(); }
export function multiviewWorkFile(work: MultiviewWorkDto, role: MultiviewWorkFileRole) {
  return work.ready?.files.find(file => file.role === role);
}
export function workFileUrl(workId: string, file: WorkFile) {
  const url = new URL(file.url, window.location.origin);
  const prefix = `/api/video/multiview/works/${encodeURIComponent(workId)}/files/`;
  if (url.origin !== window.location.origin || !url.pathname.startsWith(prefix) || url.hash) throw new Error('作品文件暂不可读取，请重新打开');
  return url.pathname + url.search;
}
export async function readMultiviewWorkFile(owner: string, work: MultiviewWorkDto, role: MultiviewWorkFileRole,
  signal: AbortSignal, isCurrent: () => boolean): Promise<Blob> {
  const file = multiviewWorkFile(work, role);
  if (!owner || !work.ready || !file || !isCurrent()) throw new Error('作品尚未准备好，请稍后重试');
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_FILE) throw new Error('作品文件过大，请使用原编辑器导出');
  const url = workFileUrl(work.id, file);
  const key = JSON.stringify([owner, work.id, work.sourceVersion, work.ready.revision, role, url, file.bytes]);
  const check = (response: Response) => {
    if (!isCurrent() || signal.aborted) throw new Error('当前作品已变化，请重试当前操作');
    if (!response.ok) { files.delete(key); throw new Error(response.status === 401 || response.status === 403 || response.status === 404
      ? '当前作品暂不可读取，请重新打开核对' : '作品读取未完成，请重试；原作品保持不变'); }
    if (response.headers.get('content-type')?.split(';')[0].trim() !== file.mime
      || Number(response.headers.get('content-length')) !== file.bytes) { files.delete(key); throw new Error('作品文件尚未完整，请重试'); }
  };
  // Every reuse rechecks the original protected file endpoint, not only a local cache key.
  const head = await fetch(url, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'x-app-session-user': owner } });
  check(head);
  const etag = head.headers.get('etag') || '';
  const cached = files.get(key);
  if (cached && etag && cached.etag === etag) return cached.blob;
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'x-app-session-user': owner } });
  check(response);
  if (etag && response.headers.get('etag') !== etag) throw new Error('作品文件已变化，请重新打开');
  const blob = await response.blob();
  if (!isCurrent() || signal.aborted || blob.size !== file.bytes || blob.type !== file.mime) throw new Error('作品读取未完成，请重试当前操作');
  if (etag && blob.size <= MAX_CACHE) {
    let bytes = [...files.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (files.size >= 4 || bytes + blob.size > MAX_CACHE) {
      const oldest = files.keys().next().value as string | undefined;
      if (!oldest) break;
      bytes -= files.get(oldest)!.bytes; files.delete(oldest);
    }
    files.set(key, { blob, bytes: blob.size, etag });
  }
  return blob;
}
