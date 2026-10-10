'use client';

import { setHdImageSessionOwner } from './hd-source-session';

export type ImageReadProgress = { phase: 'reading' | 'decoding' | 'unavailable' | 'unsupported'; loadedBytes: number; totalBytes?: number; percent?: number; message?: string };
export type ImageReadResult = { imageSrc: string | null; progress: ImageReadProgress; denied?: boolean; unconfirmed?: boolean; refreshSource?: boolean; decoded?: boolean; mime?: string; bytes?: number };
type Listener = (value: ImageReadResult) => void;
type Consumer = { listener: Listener; approval: number };
type Entry = {
  key: string; source: string; controller: AbortController; consumers: Set<Consumer>; prefetches: number;
  result: ImageReadResult; blocked?: ImageReadResult; revision: number; blob?: Blob; url?: string; etag?: string; headTag?: string; bytes: number;
  accessedAt: number; checkedAt: number; reusable: boolean; decoded: boolean; image?: HTMLImageElement;
  checking?: Promise<void>; transfer?: Promise<void>; transferController?: AbortController; decoding?: Promise<void>;
};
type Transfer = { entry: Entry; controller: AbortController; run: () => Promise<void>; resolve: () => void; reject: (error: unknown) => void };
const entries = new Map<string, Entry>();
const waiting: Transfer[] = [], running = new Set<Transfer>();
const MAX_ENTRIES = 32, MAX_BYTES = 64 * 1024 * 1024, IDLE_TTL = 10 * 60_000;
let owner = '', epoch = 0;
const reading = (): ImageReadResult => ({ imageSrc: null, progress: { phase: 'reading', loadedBytes: 0 } });
const mimeOf = (response: Response) => response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
const weakTag = (tag: string) => tag.replace(/^W\//, '');
const inUse = (entry: Entry) => entry.consumers.size > 0 || entry.prefetches > 0;

export function canonicalImageReadSource(source: string) {
  const url = new URL(source, location.href);
  url.hash = ''; url.searchParams.sort();
  return url.origin === location.origin ? `${url.pathname}${url.search}` : url.href;
}
function reusableSource(source: string) {
  const url = new URL(source, location.href);
  return url.origin === location.origin && /^\/api\/(?:image-studio\/(?:(?:assets|template-assets)\/|style-groups\/[^/]+\/assets\/)|reference-images\/[^/]+\/content|content-reactions\/media)/.test(url.pathname)
    && !['download', 'hd-download', 'hd-description'].some(mode => url.searchParams.get('variant') === mode || url.searchParams.get(mode) === '1');
}
function touch(entry: Entry) {
  entry.accessedAt = Date.now();
  if (entries.get(entry.key) === entry) { entries.delete(entry.key); entries.set(entry.key, entry); }
}
function emit(entry: Entry) {
  for (const consumer of Array.from(entry.consumers)) {
    const allowed = consumer.approval === entry.revision;
    consumer.listener(allowed ? entry.result : entry.blocked || reading());
  }
}
function publish(entry: Entry, result: ImageReadResult) { entry.result = result; emit(entry); }
function dropBody(entry: Entry) {
  entry.revision++; entry.transferController?.abort();
  entry.transfer = undefined; entry.transferController = undefined;
  if (entry.url) URL.revokeObjectURL(entry.url);
  if (entry.image) entry.image.src = '';
  entry.blob = undefined; entry.url = undefined; entry.image = undefined; entry.etag = undefined;
  entry.headTag = undefined;
  entry.bytes = 0; entry.decoded = false; entry.decoding = undefined;
}
function discard(entry: Entry) {
  if (entries.get(entry.key) === entry) entries.delete(entry.key);
  entry.controller.abort(); dropBody(entry);
}
function prune(required = 0, reserveEntry = false) {
  for (const entry of Array.from(entries.values())) if (!inUse(entry) && Date.now() - entry.accessedAt >= IDLE_TTL) discard(entry);
  let bytes = Array.from(entries.values()).reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of Array.from(entries.values())) {
    if (bytes + required <= MAX_BYTES && entries.size + Number(reserveEntry) <= MAX_ENTRIES) break;
    if (!inUse(entry)) { bytes -= entry.bytes; discard(entry); }
  }
  return bytes + required <= MAX_BYTES && entries.size + Number(reserveEntry) <= MAX_ENTRIES;
}
function fail(entry: Entry, message: string, denied = false, refreshSource = false) {
  entry.transferController?.abort();
  if (!entry.blob) entry.bytes = 0;
  if (denied || refreshSource) dropBody(entry);
  for (const consumer of Array.from(entry.consumers)) consumer.approval = 0;
  entry.blocked = { imageSrc: null, denied, unconfirmed: !denied, refreshSource, progress: { phase: 'unavailable', loadedBytes: 0, message } };
  emit(entry);
}
function drain() {
  while (running.size < 2) {
    const backgroundRunning = Array.from(running).filter(task => !task.entry.consumers.size).length;
    let index = waiting.findIndex(task => task.entry.consumers.size > 0);
    if (index < 0 && backgroundRunning < 1) index = 0;
    if (index < 0 || !waiting[index]) return;
    const task = waiting.splice(index, 1)[0];
    if (task.controller.signal.aborted) { task.reject(new DOMException('Aborted', 'AbortError')); continue; }
    running.add(task);
    void task.run().then(task.resolve, task.reject).finally(() => { running.delete(task); drain(); });
  }
}
function schedule(entry: Entry, controller: AbortController, run: () => Promise<void>) {
  return new Promise<void>((resolve, reject) => {
    const task: Transfer = { entry, controller, run, resolve, reject };
    waiting.push(task);
    controller.signal.addEventListener('abort', () => {
      const index = waiting.indexOf(task);
      if (index >= 0) { waiting.splice(index, 1); reject(new DOMException('Aborted', 'AbortError')); drain(); }
    }, { once: true });
    drain();
  });
}
async function decode(entry: Entry) {
  if (!entry.blob || !entry.consumers.size) return;
  if (entry.decoded) {
    publish(entry, { imageSrc: entry.url || null, decoded: true, mime: entry.blob.type, bytes: entry.bytes, progress: { phase: 'decoding', loadedBytes: entry.bytes, percent: 100 } });
    return;
  }
  if (entry.decoding) return entry.decoding;
  const revision = entry.revision;
  const pending = (async () => {
    try {
      entry.url ||= URL.createObjectURL(entry.blob!);
      publish(entry, { imageSrc: null, progress: { phase: 'decoding', loadedBytes: entry.bytes } });
      const image = new Image(); entry.image = image; image.src = entry.url;
      await image.decode();
      if (entry.controller.signal.aborted || revision !== entry.revision) return;
      entry.decoded = true;
      if (!entry.consumers.size) { image.src = ''; entry.image = undefined; }
      publish(entry, { imageSrc: entry.url || null, decoded: true, mime: entry.blob?.type, bytes: entry.bytes, progress: { phase: 'decoding', loadedBytes: entry.bytes, percent: 100 } });
    } catch {
      if (entry.controller.signal.aborted || revision !== entry.revision) return;
      dropBody(entry);
      entry.blocked = { imageSrc: null, progress: { phase: 'unsupported', loadedBytes: 0, message: '浏览器无法解码此图片，可查看原图或下载' } };
      emit(entry);
    }
  })();
  entry.decoding = pending;
  await pending;
  if (entry.decoding === pending) entry.decoding = undefined;
}
async function transfer(entry: Entry) {
  if (entry.blob) return decode(entry);
  if (entry.transfer) return entry.transfer;
  const controller = new AbortController(), revision = entry.revision, expected = epoch;
  entry.transferController = controller;
  const active = () => expected === epoch && revision === entry.revision && !controller.signal.aborted && !entry.controller.signal.aborted;
  const pending = schedule(entry, controller, async () => {
    try {
      const response = await fetch(entry.source, { cache: 'no-store', credentials: 'same-origin', headers: entry.consumers.size ? {} : { 'X-Image-Read-Intent': 'prefetch' }, signal: AbortSignal.any([entry.controller.signal, controller.signal, AbortSignal.timeout(60000)]) });
      if (!active()) return;
      if (!response.ok) { fail(entry, '图片未能读取，请重试', [401, 403, 404].includes(response.status), response.status === 409); return; }
      const mime = mimeOf(response);
      if (!mime.startsWith('image/') || !response.body) throw new Error('当前来源不是可读取的图片');
      const length = response.headers.get('content-length'), encoded = response.headers.get('content-encoding');
      let total = length && /^\d+$/.test(length) && (!encoded || encoded === 'identity') ? Number(length) : undefined;
      if (total !== undefined && (!Number.isSafeInteger(total) || total <= 0)) total = undefined;
      if (total && total > MAX_BYTES) throw new Error('图片过大，请使用原图下载');
      const reader = response.body.getReader(), chunks: ArrayBuffer[] = [];
      let bytes = 0, notified = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (!active()) return;
          if (!prune(chunk.value.byteLength)) throw new Error('图片较大，请关闭其他预览或使用原图下载');
          bytes += chunk.value.byteLength; entry.bytes = bytes;
          chunks.push(chunk.value.slice().buffer as ArrayBuffer);
          if (total && bytes > total) total = undefined;
          if (Date.now() - notified >= 60) {
            notified = Date.now();
            publish(entry, { imageSrc: null, progress: { phase: 'reading', loadedBytes: bytes, ...(total ? { totalBytes: total, percent: Math.min(99, Math.floor(bytes / total * 100)) } : {}) } });
          }
        }
        if (!active()) return;
        if (!bytes || total && bytes !== total) throw new Error('图片未完整读取，请重试');
        entry.blob = new Blob(chunks, { type: mime }); entry.etag = response.headers.get('etag') || undefined;
        touch(entry); await decode(entry);
      } finally { await reader.cancel().catch(() => {}); }
    } catch (error) {
      if (!active()) return;
      entry.bytes = 0;
      fail(entry, error instanceof Error && error.message !== 'Failed to fetch' ? error.message : '图片读取失败，请重试');
    }
  }).catch(() => {});
  entry.transfer = pending;
  await pending;
  if (entry.transfer === pending) { entry.transfer = undefined; entry.transferController = undefined; }
}
async function validate(entry: Entry) {
  if (entry.checking) return entry.checking;
  const expected = epoch;
  const pending = (async () => {
    try {
      const response = await fetch(entry.source, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin', headers: entry.blob && entry.etag ? { 'If-None-Match': entry.etag } : {}, signal: AbortSignal.any([entry.controller.signal, AbortSignal.timeout(15000)]) });
      if (expected !== epoch || entry.controller.signal.aborted) return;
      const mime = mimeOf(response), tag = response.headers.get('etag');
      const url = new URL(entry.source, location.href);
      const preparable = ['thumbnail', 'preview', 'detail'].some(mode => url.searchParams.get('variant') === mode || url.searchParams.get(mode) === '1');
      if (response.status === 409 && preparable && entry.consumers.size) {
        if (!entry.transfer) { dropBody(entry); entry.result = reading(); }
      } else if (response.status === 304) {
        if (!entry.blob || !entry.etag || mime && !mime.startsWith('image/') || tag && weakTag(tag) !== weakTag(entry.etag)) throw new Error('没有可复用的有效图片');
      } else if (response.status !== 200 || !mime.startsWith('image/')) {
        fail(entry, '图片暂时不可读取，请重试', [401, 403, 404].includes(response.status), response.status === 409); return;
      } else if (!(entry.blob && entry.etag && tag && weakTag(tag) === weakTag(entry.etag))
        && !(entry.transfer && entry.headTag && tag && weakTag(tag) === weakTag(entry.headTag))) {
        dropBody(entry); entry.result = reading();
      }
      if (response.status === 200) entry.headTag = tag || undefined;
      entry.checkedAt = Date.now(); touch(entry);
      entry.blocked = undefined;
      for (const consumer of Array.from(entry.consumers)) consumer.approval = entry.revision;
      void transfer(entry);
    } catch {
      if (expected === epoch && !entry.controller.signal.aborted) fail(entry, '本次图片权限暂时无法确认，请重试');
    }
  })();
  entry.checking = pending;
  await pending;
  if (entry.checking === pending) entry.checking = undefined;
}
function getEntry(account: string, source: string, version: string) {
  prune();
  const canonical = canonicalImageReadSource(source), key = JSON.stringify(['protected-image-cache-v1', epoch, account, canonical, version]);
  let entry = entries.get(key);
  if (!entry) {
    if (!prune(0, true)) return null;
    entry = { key, source: canonical, controller: new AbortController(), consumers: new Set(), prefetches: 0, result: reading(), revision: 1, bytes: 0, accessedAt: Date.now(), checkedAt: 0, reusable: reusableSource(canonical), decoded: false };
    entries.set(key, entry);
  }
  touch(entry); return entry;
}
function releaseUnused(entry: Entry) {
  touch(entry);
  if (!entry.consumers.size && entry.image && !entry.decoding) { entry.image.src = ''; entry.image = undefined; }
  if (!inUse(entry) && (!entry.blob || !entry.etag || !entry.reusable)) discard(entry);
  else prune();
}
export function setImageReadSessionOwner(next: string) {
  if (owner === next) return;
  owner = next; epoch++; setHdImageSessionOwner(next);
  for (const entry of Array.from(entries.values())) { fail(entry, '账号已变化，请重新打开图片', true); discard(entry); }
}
export function revalidateActiveImages(minAge = 0) {
  prune();
  if (document.hidden) { cancelImagePrefetches(); return; }
  for (const entry of Array.from(entries.values())) if (entry.consumers.size && !entry.checking && Date.now() - entry.checkedAt >= minAge) void validate(entry);
}
export function cancelImagePrefetches(exceptSource?: string) {
  const except = exceptSource ? canonicalImageReadSource(exceptSource) : '';
  for (const entry of Array.from(entries.values())) if (entry.prefetches && !entry.consumers.size && entry.source !== except) {
    entry.prefetches = 0;
    if (!entry.blob) discard(entry);
  }
}
export function canPrefetchImages(expectedBytes = 0) {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return !document.hidden && !connection?.saveData && Number.isFinite(expectedBytes) && expectedBytes >= 0 && prune(expectedBytes);
}
export function acquireImageRead(account: string, source: string, version: string, _attempt: number, listener: Listener) {
  setImageReadSessionOwner(account);
  if (!account) { listener({ imageSrc: null, denied: true, progress: { phase: 'unavailable', loadedBytes: 0, message: '请先确认登录状态后重试' } }); return () => {}; }
  cancelImagePrefetches(source);
  const entry = getEntry(account, source, version);
  if (!entry) { listener({ imageSrc: null, progress: { phase: 'unavailable', loadedBytes: 0, message: '当前打开的图片较多，请关闭部分预览后重试' } }); return () => {}; }
  const consumer = { listener, approval: 0 }; entry.consumers.add(consumer);
  listener(reading()); drain(); void validate(entry);
  return () => { entry.consumers.delete(consumer); releaseUnused(entry); drain(); };
}
export function prefetchImageRead(account: string, source: string, version = '') {
  if (!account || account !== owner || !canPrefetchImages() || !reusableSource(source)) return () => {};
  const entry = getEntry(account, source, version);
  if (!entry) return () => {};
  entry.prefetches++; void validate(entry);
  let released = false;
  return () => {
    if (released) return; released = true; entry.prefetches = Math.max(0, entry.prefetches - 1);
    // Let the same React effect flush hand a neighbor transfer to its new foreground consumer.
    queueMicrotask(() => releaseUnused(entry));
  };
}
