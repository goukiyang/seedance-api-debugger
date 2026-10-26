'use client';

import { isMultiviewWorkId, multiviewWorkContentSignature, type MultiviewWorkDto, type MultiviewWorkFileRole } from '@/lib/video/multiview-work-contract';
import { parseMultiviewWorkRecipe, type MultiviewWorkRecipe } from '@/lib/video/multiview-work-contract';
import type { MultiviewInfo } from '@/lib/video/multiview-contract';

type Binding = { schema: 1; owner: string; taskId: string; sourceVersion: string; workId: string };
type Baseline = Binding & { revision: number; signatureHash: string };
type SafeStorage = Pick<Storage, 'getItem' | 'setItem'>;
const bindingKey = (owner: string, taskId: string) => `sd2:multiview-work-binding:v1:${owner}:${taskId}`;
const baselineKey = (owner: string, workId: string, sourceVersion: string) => `sd2:multiview-work-baseline:v1:${owner}:${workId}:${sourceVersion}`;
function parseBinding(raw: string | null, owner: string, taskId: string): Binding | null {
  if (raw === null) return null;
  if (raw.length > 2048) throw new Error('原作品绑定记录无法确认，当前内容保留。');
  const value = JSON.parse(raw) as Binding;
  if (!value || value.schema !== 1 || value.owner !== owner || value.taskId !== taskId || !isMultiviewWorkId(value.workId)
    || !/^[a-f0-9]{64}$/.test(value.sourceVersion)) throw new Error('原作品绑定记录无法确认，当前内容保留。');
  return value;
}
export function readMultiviewWorkBinding(storage: SafeStorage, owner: string, taskId: string) {
  return parseBinding(storage.getItem(bindingKey(owner, taskId)), owner, taskId);
}
export function retainMultiviewWorkBinding(storage: SafeStorage, owner: string, work: MultiviewWorkDto) {
  if (!work.sourceVersion || work.sourceState !== 'current' || work.removed) return;
  const value: Binding = { schema: 1, owner, taskId: work.sourceTaskId, sourceVersion: work.sourceVersion, workId: work.id };
  const key = bindingKey(owner, work.sourceTaskId), raw = JSON.stringify(value);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error('当前作品身份无法保存在此设备，请保留页面。');
}
async function signatureHash(work: MultiviewWorkDto) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(multiviewWorkContentSignature(work.recipe, work.title)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function hasMultiviewWorkBaseline(storage: SafeStorage, owner: string, work: MultiviewWorkDto) {
  if (!work.sourceVersion || !work.recipe) return false;
  const raw = storage.getItem(baselineKey(owner, work.id, work.sourceVersion));
  const value = parseBinding(raw, owner, work.sourceTaskId) as Baseline | null;
  return Boolean(value && value.workId === work.id && value.sourceVersion === work.sourceVersion
    && Number.isSafeInteger(value.revision) && value.revision === work.revision && /^[a-f0-9]{64}$/.test(value.signatureHash)
    && value.signatureHash === await signatureHash(work));
}
export async function retainMultiviewWorkBaseline(storage: SafeStorage, owner: string, work: MultiviewWorkDto, isCurrent: () => boolean) {
  if (!work.sourceVersion || !work.recipe || work.sourceState !== 'current' || work.removed) return;
  const hash = await signatureHash(work);
  if (!isCurrent()) return;
  const value: Baseline = { schema: 1, owner, taskId: work.sourceTaskId, sourceVersion: work.sourceVersion, workId: work.id,
    revision: work.revision, signatureHash: hash };
  const key = baselineKey(owner, work.id, work.sourceVersion), raw = JSON.stringify(value);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error('作品保存基线无法保存在此设备，当前修改保留。');
  retainMultiviewWorkBinding(storage, owner, work);
}
/** Freeze the explicitly selected local content before the fresh original-work read. */
export async function prepareMultiviewCurrentWorkSave(input: { workId: string; taskId: string; info: MultiviewInfo;
  recipe: MultiviewWorkRecipe; title: string; readFresh: (id: string) => Promise<MultiviewWorkDto>; isCurrent: () => boolean }) {
  const recipe = parseMultiviewWorkRecipe(input.recipe, input.info), title = input.title;
  if (!recipe || !title.trim() || title.length > 120 || !input.isCurrent()) throw new Error('当前内容尚未确认，本次未保存。');
  const work = await input.readFresh(input.workId);
  if (!input.isCurrent() || work.id !== input.workId || work.sourceTaskId !== input.taskId || work.sourceVersion !== input.info.sourceVersion
    || work.sourceState !== 'current' || work.removed || !work.recipe || !Number.isSafeInteger(work.revision) || work.revision < 1) {
    throw new Error('原作品或视频已变化，当前修改保留；本次没有保存。');
  }
  return { work, recipe, title };
}

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
    let bytes = Array.from(files.values()).reduce((sum, entry) => sum + entry.bytes, 0);
    while (files.size >= 4 || bytes + blob.size > MAX_CACHE) {
      const oldest = files.keys().next().value as string | undefined;
      if (!oldest) break;
      bytes -= files.get(oldest)!.bytes; files.delete(oldest);
    }
    files.set(key, { blob, bytes: blob.size, etag });
  }
  return blob;
}
