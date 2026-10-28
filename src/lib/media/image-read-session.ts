'use client';

import { invalidateHdImageSource, registerImageReadFamilyInvalidator, setHdImageSessionOwner } from './hd-source-session';
import { COMPARISON_VERSION_HEADER, COMPARISON_VERSION_PARAM } from './image-comparison-contract';

export type ImageReadProgress = { phase: 'reading' | 'confirming' | 'decoding' | 'unavailable' | 'unsupported'; loadedBytes: number; totalBytes?: number; percent?: number; message?: string; transferId?: string; bodyComplete?: boolean };
export type ImageReadResult = { imageSrc: string | null; progress: ImageReadProgress; denied?: boolean; unconfirmed?: boolean; refreshSource?: boolean; decoded?: boolean; mime?: string; bytes?: number; width?: number; height?: number; authorizationVersion?: string; representationVersion?: string };
export type ImageReadBorrowProof = { sourceVersion: string; representationVersion?: string; bytes: number; mime: string; variant: 'hd'; policy: 'hd-f-v1' };
export type ImageReadBorrow = { blob: Blob; bytes: number; mime: string; sourceVersion: string; isValid: () => boolean; release: () => void };
/** Only the authorized, decoded original-frame producer supplies this object. No URL-only trust flag. */
export type LocalFrameContext = Readonly<{
  kind: 'local-frame'; account: string; authority: string; sourceKind: 'task' | 'work' | 'share'; sourceId: string;
  taskId: string; sourceVersion: string; frame: number; width: number; height: number; generation: number;
  blob: Blob; url: string; signal: AbortSignal; isCurrent: () => boolean;
  retain: () => (() => void); authorize: () => Promise<void>;
}>;
type Listener = (value: ImageReadResult) => void;
type Consumer = { listener: Listener; approval: number; expectedVersion: string };
type BodyBorrow = { blob: Blob; references: number; detached: boolean };
type Entry = {
  key: string; account: string; source: string; controller: AbortController; consumers: Set<Consumer>; prefetches: number; prefetchRevision: number;
  result: ImageReadResult; blocked?: ImageReadResult; revision: number; blob?: Blob; url?: string; etag?: string; sourceVersion?: string; actualVersion?: string;
  headTag?: string; bytes: number; width?: number; height?: number; accessedAt: number; checkedAt: number; retryAfter: number;
  reusableAllowed: boolean; reusable: boolean; stale: boolean; decoded: boolean; complete: boolean; image?: HTMLImageElement; borrow?: BodyBorrow;
  checking?: Promise<void>; transfer?: Promise<void>; transferController?: AbortController; decoding?: Promise<void>;
  transferExpectedVersion?: string;
  representationVersion?: string; transferId?: string;
};
type Transfer = { entry: Entry; controller: AbortController; run: () => Promise<void>; resolve: () => void; reject: (error: unknown) => void };
const entries = new Map<string, Entry>();
const waiting: Transfer[] = [], running = new Set<Transfer>();
const MAX_ENTRIES = 32, MAX_BYTES = 64 * 1024 * 1024, IDLE_TTL = 10 * 60_000;
const REVALIDATE_AFTER = 60_000, MAX_DECODED_IMAGES = 3, MAX_DECODED_BYTES = 96 * 1024 * 1024;
let owner = '', epoch = 0, foregroundPreparations = 0, detachedBorrowBytes = 0;
const reading = (): ImageReadResult => ({ imageSrc: null, progress: { phase: 'reading', loadedBytes: 0 } });
const decoding = (entry: Entry): ImageReadResult => ({ imageSrc: null, progress: { phase: 'decoding', loadedBytes: entry.bytes, bodyComplete: entry.complete, transferId: entry.transferId }, bytes: entry.bytes });
const mimeOf = (response: Response) => response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
const weakTag = (tag: string) => tag.trim().replace(/^W\//, '');
const versionsMatch = (expected: string, actual: string) => Boolean(expected && actual && weakTag(expected) === weakTag(actual));
const inUse = (entry: Entry) => entry.consumers.size > 0 || entry.prefetches > 0 || Boolean(entry.borrow?.references);
const backgroundAllowed = () => {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return !foregroundPreparations && !document.hidden && !connection?.saveData;
};

export function isImagePreviewReady(result: ImageReadResult, domDecoded = false) {
  return Boolean(result.imageSrc && (result.decoded === true || domDecoded));
}

export function canonicalImageReadSource(source: string) {
  const url = new URL(source, location.href);
  if (url.protocol === 'blob:') return url.href;
  url.hash = ''; url.searchParams.sort();
  return url.origin === location.origin ? `${url.pathname}${url.search}` : url.href;
}
function sourceFamily(source: string) {
  const url = new URL(source, location.href);
  if (url.protocol === 'blob:') return url.href;
  url.hash = '';
  for (const name of ['thumbnail', 'preview', 'detail', 'download', 'hd', 'hd-description', 'hd-download', 'hd-version', 'hd-representation', 'variant']) url.searchParams.delete(name);
  url.searchParams.sort();
  return url.origin === location.origin ? `${url.pathname}${url.search}` : url.href;
}
function reusableSource(source: string) {
  const url = new URL(source, location.href);
  return url.origin === location.origin && /^\/api\/(?:image-studio\/(?:(?:assets|template-assets)\/|style-groups\/[^/]+\/assets\/)|reference-images\/[^/]+\/content|content-reactions\/media)/.test(url.pathname)
    && !['download', 'hd-download', 'hd-description'].some(mode => url.searchParams.get('variant') === mode || url.searchParams.get(mode) === '1');
}
function responseVersion(response: Response) {
  return response.headers.get('X-Image-Source-Version')?.trim() || response.headers.get('etag')?.trim() || '';
}
function comparisonResponseMatches(source: string, response: Response) {
  const url = new URL(source, location.href), expected = url.searchParams.get(COMPARISON_VERSION_PARAM);
  const preview = ['thumbnail', 'preview', 'detail'].some(mode => url.searchParams.get('variant') === mode || url.searchParams.get(mode) === '1');
  return !expected || preview || response.headers.get(COMPARISON_VERSION_HEADER) === expected;
}
function representationChanged(entry: Entry, response: Response): boolean | null {
  const representation = response.headers.get('X-Image-Representation-Version')?.trim();
  if (representation && entry.representationVersion && representation !== entry.representationVersion) return true;
  const sourceVersion = response.headers.get('X-Image-Source-Version')?.trim() || '';
  const etag = response.headers.get('etag')?.trim() || '';
  if (sourceVersion && entry.sourceVersion) return !versionsMatch(entry.sourceVersion, sourceVersion) || Boolean(etag && entry.etag && !versionsMatch(entry.etag, etag));
  if (etag && entry.etag) return !versionsMatch(entry.etag, etag);
  const observed = sourceVersion || etag;
  return observed && entry.actualVersion ? !versionsMatch(entry.actualVersion, observed) : null;
}
function touch(entry: Entry) {
  entry.accessedAt = Date.now();
  if (entries.get(entry.key) === entry) { entries.delete(entry.key); entries.set(entry.key, entry); }
}
function consumerResult(entry: Entry, consumer: Consumer) {
  if (consumer.approval !== entry.revision) return entry.blocked || reading();
  if (entry.result.imageSrc && consumer.expectedVersion && (!entry.actualVersion || !versionsMatch(consumer.expectedVersion, entry.actualVersion))) {
    return { imageSrc: null, refreshSource: true, progress: { phase: 'unavailable' as const, loadedBytes: 0, message: '图片版本已变化，请重新打开' } };
  }
  return entry.result;
}
function emit(entry: Entry) {
  for (const consumer of Array.from(entry.consumers)) consumer.listener(consumerResult(entry, consumer));
}
function publish(entry: Entry, result: ImageReadResult) { entry.result = result; entry.blocked = undefined; emit(entry); }
function dropDecoded(entry: Entry) {
  if (entry.image) entry.image.src = '';
  entry.image = undefined; entry.decoded = false; entry.width = undefined; entry.height = undefined;
  if (entry.blob) entry.result = { imageSrc: entry.url || null, progress: { phase: 'decoding', loadedBytes: entry.bytes }, mime: entry.blob.type, bytes: entry.bytes };
}
function pruneDecoded() {
  const recency = new Map(Array.from(entries.values()).reverse().map((entry, index) => [entry, index]));
  const candidates = Array.from(entries.values()).filter(entry => entry.decoded && entry.image)
    .sort((a, b) => Number(b.consumers.size > 0) - Number(a.consumers.size > 0)
      || Number(b.prefetches > 0) - Number(a.prefetches > 0)
      || (recency.get(a) || 0) - (recency.get(b) || 0));
  let kept = 0, bytes = 0;
  for (const entry of candidates) {
    const estimate = Math.max(1, (entry.width || 0) * (entry.height || 0) * 4);
    // The budget bounds retained neighbors, not images still owned by a visible
    // reader (including both comparison panes and an original-to-HD handoff).
    // Dropping a completing foreground decode here would suppress its ready emit.
    const current = entry.consumers.size > 0;
    if (current || kept < MAX_DECODED_IMAGES && bytes + estimate <= MAX_DECODED_BYTES) { kept++; bytes += estimate; }
    else dropDecoded(entry);
  }
}
function dropBody(entry: Entry) {
  entry.revision++; entry.transferController?.abort();
  entry.transfer = undefined; entry.transferController = undefined; entry.transferExpectedVersion = undefined;
  // A revoked/version-changed body cannot be reused, but an outstanding browser
  // handoff still owns its bytes until release. Keep those bytes in the budget.
  if (entry.borrow?.references) {
    entry.borrow.detached = true; detachedBorrowBytes += entry.borrow.blob.size;
  }
  entry.borrow = undefined;
  if (entry.url) URL.revokeObjectURL(entry.url);
  if (entry.image) entry.image.src = '';
  entry.blob = undefined; entry.url = undefined; entry.image = undefined; entry.etag = undefined; entry.sourceVersion = undefined; entry.actualVersion = undefined;
  entry.headTag = undefined; entry.width = undefined; entry.height = undefined;
  entry.representationVersion = undefined; entry.transferId = undefined;
  entry.bytes = 0; entry.decoded = false; entry.complete = false; entry.decoding = undefined; entry.reusable = false; entry.stale = false; entry.retryAfter = 0;
  entry.result = reading(); entry.blocked = undefined;
}
function discard(entry: Entry) {
  if (entries.get(entry.key) === entry) entries.delete(entry.key);
  entry.controller.abort(); dropBody(entry);
}
function prune(required = 0, reserveEntry = false) {
  for (const entry of Array.from(entries.values())) if (!inUse(entry) && Date.now() - entry.accessedAt >= IDLE_TTL) discard(entry);
  let bytes = detachedBorrowBytes + Array.from(entries.values()).reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of Array.from(entries.values())) {
    if (bytes + required <= MAX_BYTES && entries.size + Number(reserveEntry) <= MAX_ENTRIES) break;
    if (!inUse(entry)) { bytes -= entry.bytes; discard(entry); }
  }
  return bytes + required <= MAX_BYTES && entries.size + Number(reserveEntry) <= MAX_ENTRIES;
}
function blockEntry(entry: Entry, message: string, denied = false, refreshSource = false) {
  dropBody(entry);
  entry.blocked = { imageSrc: null, denied, unconfirmed: !denied && !refreshSource, refreshSource, progress: { phase: 'unavailable', loadedBytes: 0, message } };
  for (const consumer of Array.from(entry.consumers)) consumer.approval = 0;
  emit(entry);
}
function invalidateImageReadFamily(source: string, account: string, message: string, invalidateHd = true) {
  if (!account || account !== owner) return;
  const family = sourceFamily(source);
  for (const entry of Array.from(entries.values())) if (entry.account === account && sourceFamily(entry.source) === family) {
    blockEntry(entry, message, true);
  }
  if (invalidateHd) invalidateHdImageSource(source, account, { propagateToImageReads: false });
}
function blocked(entry: Entry, message: string, denied = false, refreshSource = false) {
  if (denied) { invalidateImageReadFamily(entry.source, entry.account, message); return; }
  blockEntry(entry, message, false, refreshSource);
}
function fail(entry: Entry, message: string, denied = false, refreshSource = false) {
  blocked(entry, message, denied, refreshSource);
}
function drain() {
  while (running.size < 2) {
    const backgroundRunning = Array.from(running).filter(task => !task.entry.consumers.size).length;
    let index = waiting.findIndex(task => task.entry.consumers.size > 0);
    if (index < 0 && backgroundRunning < 1 && backgroundAllowed()) index = 0;
    if (index < 0 || !waiting[index]) return;
    const task = waiting.splice(index, 1)[0];
    if (task.controller.signal.aborted) { task.reject(new DOMException('Aborted', 'AbortError')); continue; }
    running.add(task);
    void task.run().then(task.resolve, task.reject).finally(() => { running.delete(task); drain(); });
  }
}
function schedule(entry: Entry, controller: AbortController, run: () => Promise<void>) {
  return new Promise<void>((resolve, reject) => {
    if (controller.signal.aborted || !entry.consumers.size && !backgroundAllowed()) {
      controller.abort(); reject(new DOMException('Aborted', 'AbortError')); return;
    }
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
  if (!entry.blob || !inUse(entry)) return;
  if (entry.decoded && entry.image) { if (entry.consumers.size) publish(entry, entry.result); return; }
  if (entry.decoding) return entry.decoding;
  const revision = entry.revision;
  const pending = (async () => {
    try {
      entry.url ||= URL.createObjectURL(entry.blob!);
      if (entry.consumers.size) publish(entry, decoding(entry));
      const image = new Image(); entry.image = image; image.src = entry.url;
      await image.decode();
      if (entry.controller.signal.aborted || revision !== entry.revision || !entry.blob) return;
      const width = image.naturalWidth, height = image.naturalHeight;
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new Error('invalid_dimensions');
      entry.decoded = true; entry.width = width; entry.height = height;
      entry.result = { imageSrc: entry.url, decoded: true, mime: entry.blob.type, bytes: entry.bytes, width, height,
        authorizationVersion: entry.actualVersion, representationVersion: entry.representationVersion,
        progress: { phase: 'decoding', loadedBytes: entry.bytes, bodyComplete: entry.complete, transferId: entry.transferId } };
      entry.blocked = undefined; touch(entry); pruneDecoded();
      if (entry.decoded && entry.consumers.size) emit(entry);
    } catch {
      if (entry.controller.signal.aborted || revision !== entry.revision) return;
      dropBody(entry);
      entry.blocked = { imageSrc: null, progress: { phase: 'unsupported', loadedBytes: 0, message: '浏览器无法解码此图片，可查看原图或下载' } };
      for (const consumer of Array.from(entry.consumers)) consumer.approval = 0;
      emit(entry);
    }
  })();
  entry.decoding = pending;
  await pending;
  if (entry.decoding === pending) entry.decoding = undefined;
}
async function transfer(entry: Entry, expectedVersion = '') {
  if (entry.blob) return decode(entry);
  if (entry.transfer) return entry.transfer;
  if (!entry.consumers.size && !backgroundAllowed()) return;
  const controller = new AbortController(), revision = entry.revision, expected = epoch;
  entry.transferController = controller; entry.transferExpectedVersion = expectedVersion;
  const active = () => expected === epoch && revision === entry.revision && !controller.signal.aborted && !entry.controller.signal.aborted;
  const pending = schedule(entry, controller, async () => {
    try {
      const response = await fetch(entry.source, { cache: 'no-store', credentials: 'same-origin', headers: entry.consumers.size ? {} : { 'X-Image-Read-Intent': 'prefetch' }, signal: AbortSignal.any([entry.controller.signal, controller.signal, AbortSignal.timeout(60000)]) });
      if (!active()) return;
      if (!response.ok) { fail(entry, '图片未能读取，请重试', [401, 403, 404].includes(response.status), response.status === 409); return; }
      if (!comparisonResponseMatches(entry.source, response)) {
        void response.body?.cancel().catch(() => {});
        fail(entry, '暂时无法核对原图版本，请重试读取'); return;
      }
      const mime = mimeOf(response);
      if (!mime.startsWith('image/') || !response.body) throw new Error('当前来源不是可读取的图片');
      if (response.status !== 200 || response.headers.has('content-range')) { void response.body.cancel().catch(() => {}); throw new Error('图片响应不完整，请重试'); }
      entry.transferId = crypto.randomUUID();
      const length = response.headers.get('content-length'), encoded = response.headers.get('content-encoding')?.trim().toLowerCase();
      let total = length && /^\d+$/.test(length) && (!encoded || encoded === 'identity') ? Number(length) : undefined;
      if (total !== undefined && (!Number.isSafeInteger(total) || total <= 0)) total = undefined;
      if (total && total > MAX_BYTES) throw new Error('图片过大，请使用原图下载');
      const reader = response.body.getReader(), chunks: ArrayBuffer[] = [];
      let bytes = 0, notified = 0, lengthMatches = true;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (!active()) return;
          if (!prune(chunk.value.byteLength)) throw new Error('图片较大，请关闭其他预览或使用原图下载');
          bytes += chunk.value.byteLength; entry.bytes = bytes;
          chunks.push(chunk.value.slice().buffer as ArrayBuffer);
          if (total && bytes > total) { lengthMatches = false; total = undefined; }
          if (Date.now() - notified >= 60 || total && bytes >= total) {
            notified = Date.now();
            publish(entry, { imageSrc: null, progress: { phase: total && bytes >= total ? 'confirming' : 'reading', loadedBytes: bytes, transferId: entry.transferId,
              ...(total ? { totalBytes: total, ...(bytes < total ? { percent: Math.floor(bytes / total * 100) } : {}) } : {}) } });
          }
        }
        if (!active()) return;
        if (!bytes || total && bytes !== total) throw new Error('图片未完整读取，请重试');
        const blob = new Blob(chunks, { type: mime });
        const etag = response.headers.get('etag')?.trim() || undefined;
        const sourceVersion = response.headers.get('X-Image-Source-Version')?.trim() || undefined;
        const actualVersion = sourceVersion || etag || '';
        entry.blob = blob; entry.etag = etag; entry.sourceVersion = sourceVersion; entry.actualVersion = actualVersion || undefined;
        entry.representationVersion = response.headers.get('X-Image-Representation-Version')?.trim() || undefined;
        entry.complete = response.status === 200 && !response.headers.has('content-range') && lengthMatches;
        entry.reusable = entry.complete && entry.reusableAllowed && Boolean(actualVersion); entry.checkedAt = Date.now(); entry.retryAfter = 0; entry.stale = false;
        touch(entry); await decode(entry);
      } finally { void reader.cancel().catch(() => {}); }
    } catch (error) {
      if (!active()) return;
      fail(entry, error instanceof Error && error.message !== 'Failed to fetch' ? error.message : '图片读取失败，请重试');
    }
  }).catch(() => {});
  entry.transfer = pending;
  await pending;
  if (entry.transfer === pending) { entry.transfer = undefined; entry.transferController = undefined; entry.transferExpectedVersion = undefined; }
}
function keepStale(entry: Entry) {
  entry.stale = true; entry.retryAfter = Date.now() + REVALIDATE_AFTER;
}
function allowBodyAgain(entry: Entry) {
  entry.blocked = undefined; entry.stale = false; entry.retryAfter = 0;
  for (const consumer of Array.from(entry.consumers)) consumer.approval = entry.revision;
  entry.result = reading(); emit(entry);
}
async function revalidate(entry: Entry) {
  if (!entry.blob || !entry.actualVersion || !entry.reusable || entry.checking) return entry.checking;
  const now = Date.now();
  if (now - entry.checkedAt < REVALIDATE_AFTER || now < entry.retryAfter) return;
  const expected = epoch, revision = entry.revision;
  const pending = (async () => {
    try {
      const response = await fetch(entry.source, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin', headers: entry.etag ? { 'If-None-Match': entry.etag } : {}, signal: AbortSignal.any([entry.controller.signal, AbortSignal.timeout(15000)]) });
      if (expected !== epoch || revision !== entry.revision || entry.controller.signal.aborted) return;
      const mime = mimeOf(response);
      if (response.status === 304) {
        if (!comparisonResponseMatches(entry.source, response)) { keepStale(entry); return; }
        const tag = response.headers.get('etag')?.trim() || '';
        const sourceVersion = response.headers.get('X-Image-Source-Version')?.trim() || '';
        if (!entry.etag || mime && !mime.startsWith('image/') || tag && !versionsMatch(entry.etag, tag)
          || sourceVersion && entry.sourceVersion && !versionsMatch(entry.sourceVersion, sourceVersion)) { keepStale(entry); return; }
        entry.checkedAt = Date.now(); entry.retryAfter = 0; entry.stale = false; touch(entry); return;
      }
      if ([401, 403, 404].includes(response.status)) { fail(entry, '图片权限或来源已变化，请重新打开', true); return; }
      if (response.status === 409 && isHdVariant(entry.source)) { fail(entry, '高清图尚未准备好，可查看原图', false, true); return; }
      if (!response.ok || !mime.startsWith('image/')) { keepStale(entry); return; }
      if (!comparisonResponseMatches(entry.source, response)) { keepStale(entry); return; }
      const version = responseVersion(response);
      if (!version) { keepStale(entry); return; }
      const changed = representationChanged(entry, response);
      if (changed === null) { keepStale(entry); return; }
      if (changed) {
        dropBody(entry); allowBodyAgain(entry); void transfer(entry);
        return;
      }
      entry.etag = response.headers.get('etag')?.trim() || entry.etag;
      entry.sourceVersion = response.headers.get('X-Image-Source-Version')?.trim() || entry.sourceVersion;
      entry.actualVersion = entry.sourceVersion || entry.etag || version;
      entry.checkedAt = Date.now(); entry.retryAfter = 0; entry.stale = false; touch(entry);
    } catch {
      if (expected === epoch && revision === entry.revision && !entry.controller.signal.aborted) keepStale(entry);
    }
  })();
  entry.checking = pending;
  await pending;
  if (entry.checking === pending) entry.checking = undefined;
}
function isHdVariant(source: string) {
  const url = new URL(source, location.href);
  return url.searchParams.get('variant') === 'hd' || url.searchParams.get('hd') === '1';
}
function getEntry(account: string, source: string) {
  prune();
  const canonical = canonicalImageReadSource(source), key = JSON.stringify(['protected-image-cache-v2', epoch, account, canonical]);
  let entry = entries.get(key);
  if (!entry) {
    if (!prune(0, true)) return null;
    entry = { key, account, source: canonical, controller: new AbortController(), consumers: new Set(), prefetches: 0, prefetchRevision: 0, result: reading(), revision: 1, bytes: 0,
      accessedAt: Date.now(), checkedAt: 0, retryAfter: 0, reusableAllowed: reusableSource(canonical), reusable: reusableSource(canonical), stale: false, decoded: false, complete: false };
    entries.set(key, entry);
  }
  touch(entry); return entry;
}
function startColdRead(entry: Entry, version = '') {
  entry.blocked = undefined;
  if (!entry.blob && entry.result.progress.phase !== 'reading') publish(entry, reading());
  void transfer(entry, version);
}
function releaseUnused(entry: Entry) {
  touch(entry);
  if (!inUse(entry) && (!entry.blob || !entry.actualVersion || !entry.reusable)) discard(entry);
  else { prune(); pruneDecoded(); }
}
export function setImageReadSessionOwner(next: string) {
  if (owner === next) return;
  owner = next; epoch++; foregroundPreparations = 0; setHdImageSessionOwner(next);
  for (const entry of Array.from(entries.values())) { blockEntry(entry, '账号已变化，请重新打开图片', true); discard(entry); }
}
export function captureImageReadSessionScope(account: string): () => boolean {
  const expected = epoch;
  return () => Boolean(account && owner === account && epoch === expected);
}
export function beginImageForegroundPreparation(account: string): () => void {
  setImageReadSessionOwner(account);
  if (!account) return () => {};
  const expected = epoch;
  foregroundPreparations++;
  cancelImagePrefetches();
  let released = false;
  return () => {
    if (released) return; released = true;
    if (owner !== account || epoch !== expected) return;
    foregroundPreparations = Math.max(0, foregroundPreparations - 1);
    drain();
  };
}
export function invalidateImageReadSource(source: string, account = owner) {
  invalidateImageReadFamily(source, account, '图片权限或来源已变化，请重新打开');
}
// An explicit display retry must not reuse the same failed DOM source forever.
// Reset only this representation; authorization/descriptor invalidation remains
// the separate whole-family path above. The next acquisition performs one GET.
export function resetImageReadForRetry(source: string, account = owner) {
  if (!account || account !== owner || /^(blob:|data:)/i.test(source)) return;
  const canonical = canonicalImageReadSource(source);
  for (const entry of Array.from(entries.values())) if (entry.account === account && entry.source === canonical) {
    dropBody(entry); allowBodyAgain(entry);
  }
}
export function revalidateActiveImages(minAge = REVALIDATE_AFTER) {
  prune();
  if (document.hidden) { cancelImagePrefetches(); return; }
  const now = Date.now();
  for (const entry of Array.from(entries.values())) if (entry.consumers.size && !entry.checking && entry.blob && entry.actualVersion
    && now - entry.checkedAt >= Math.max(REVALIDATE_AFTER, minAge) && now >= entry.retryAfter) void revalidate(entry);
}
export function cancelImagePrefetches(exceptSource?: string) {
  const except = exceptSource ? canonicalImageReadSource(exceptSource) : '';
  for (const entry of Array.from(entries.values())) if (!entry.consumers.size && entry.source !== except && (entry.prefetches || entry.transfer)) {
    entry.prefetches = 0; entry.prefetchRevision++;
    if (!entry.blob) discard(entry);
  }
}
export function canPrefetchImages(expectedBytes = 0) {
  return backgroundAllowed() && Number.isFinite(expectedBytes) && expectedBytes >= 0 && prune(expectedBytes);
}
// Only select a previously authorized decoded preview. This does not fetch or
// compare its representation ETag with the unrelated HD source-version key.
// The normal acquisition still owns revocation and revalidation of the body.
export function hasCachedImagePreview(account: string, source: string) {
  if (!account || account !== owner) return false;
  const canonical = canonicalImageReadSource(source);
  const url = new URL(canonical, location.href);
  if (!(url.searchParams.get('preview') === '1' || url.searchParams.get('variant') === 'preview')) return false;
  const entry = entries.get(JSON.stringify(['protected-image-cache-v2', epoch, account, canonical]));
  return Boolean(entry?.blob && entry.decoded && entry.complete && entry.reusable && entry.actualVersion
    && !entry.blocked && !entry.stale && !entry.controller.signal.aborted && Date.now() - entry.checkedAt < REVALIDATE_AFTER);
}
// source is the exact protected HD display URL used by acquireImageRead. The
// caller must first authorize the matching hd-download route with a fresh HEAD.
// This API never fetches and never exposes another representation or a family.
export function borrowImageRead(account: string, source: string, version: string, proof: ImageReadBorrowProof): ImageReadBorrow | null {
  if (!account || account !== owner || !version || version !== version.trim() || !proof || proof.variant !== 'hd' || proof.policy !== 'hd-f-v1'
    || proof.sourceVersion !== version || !Number.isSafeInteger(proof.bytes) || proof.bytes <= 0 || proof.bytes > MAX_BYTES || typeof proof.mime !== 'string') return null;
  let canonical: string;
  try {
    canonical = canonicalImageReadSource(source);
    const url = new URL(canonical, location.href);
    const assetRoute = /^\/api\/image-studio\/(?:(?:assets|template-assets)\/[^/]+|style-groups\/[^/]+\/assets\/[^/]+)$/.test(url.pathname);
    const variantRoute = /^\/api\/reference-images\/[^/]+\/content$/.test(url.pathname) || url.pathname === '/api/content-reactions/media';
    if (url.origin !== location.origin || url.username || url.password || !reusableSource(canonical)
      || url.searchParams.getAll('hd-version').length !== 1 || url.searchParams.get('hd-version') !== version
      || ['thumbnail', 'preview', 'detail', 'download', 'hd-description', 'hd-download'].some(name => url.searchParams.has(name))
      || !(assetRoute && url.searchParams.getAll('hd').length === 1 && url.searchParams.get('hd') === '1' && !url.searchParams.has('variant')
        || variantRoute && url.searchParams.getAll('variant').length === 1 && url.searchParams.get('variant') === 'hd' && !url.searchParams.has('hd'))) return null;
  } catch { return null; }
  const entry = entries.get(JSON.stringify(['protected-image-cache-v2', epoch, account, canonical]));
  const mime = proof.mime.split(';')[0].trim().toLowerCase(), bytes = proof.bytes;
  if (!entry?.blob || !mime.startsWith('image/')) return null;
  const blob = entry.blob, expected = epoch, revision = entry.revision;
  const valid = () => owner === account && epoch === expected && entries.get(entry.key) === entry && entry.revision === revision
    && !entry.controller.signal.aborted && entry.complete && entry.blob === blob && entry.reusable && !entry.blocked && !entry.stale
    && !entry.result.denied && !entry.result.unconfirmed && !entry.result.refreshSource
    && entry.sourceVersion === version && entry.actualVersion === version && blob.size === bytes && entry.bytes === bytes && blob.type === mime
    && (!proof.representationVersion || entry.representationVersion === proof.representationVersion);
  if (!valid()) return null;
  const reference = entry.borrow || { blob, references: 0, detached: false };
  entry.borrow = reference; reference.references++; touch(entry);
  let released = false;
  return { blob, bytes: blob.size, mime, sourceVersion: version, isValid: () => !released && valid(), release: () => {
    if (released) return; released = true;
    reference.references = Math.max(0, reference.references - 1);
    if (!reference.references) {
      if (reference.detached) detachedBorrowBytes = Math.max(0, detachedBorrowBytes - reference.blob.size);
      if (entry.borrow === reference) entry.borrow = undefined;
    }
    if (owner === account && epoch === expected && entries.get(entry.key) === entry) releaseUnused(entry);
  } };
}
export function localFrameMatches(frame: LocalFrameContext, account: string, source: string, version: string) {
  return Boolean(frame && frame.kind === 'local-frame' && account && frame.account === account && frame.authority
    && ['task', 'work', 'share'].includes(frame.sourceKind) && frame.sourceId && frame.taskId
    && /^blob:/.test(source) && frame.url === source && frame.sourceVersion === version && /^[a-f0-9]{64}$/.test(version)
    && Number.isSafeInteger(frame.frame) && frame.frame >= 0 && Number.isSafeInteger(frame.generation) && frame.generation >= 0
    && Number.isSafeInteger(frame.width) && frame.width > 0 && Number.isSafeInteger(frame.height) && frame.height > 0
    && frame.blob instanceof Blob && frame.blob.type === 'image/png' && frame.blob.size > 0
    && frame.signal instanceof AbortSignal && !frame.signal.aborted && typeof frame.isCurrent === 'function'
    && typeof frame.retain === 'function' && typeof frame.authorize === 'function' && frame.isCurrent());
}
export function acquireLocalFrameRead(account: string, source: string, version: string, frame: LocalFrameContext, listener: Listener) {
  setImageReadSessionOwner(account);
  const currentScope = captureImageReadSessionScope(account);
  const denied = () => listener({ imageSrc: null, denied: true, progress: { phase: 'unavailable', loadedBytes: 0, message: '原帧来源已变化，请重新打开' } });
  if (!localFrameMatches(frame, account, source, version)) { denied(); return () => {}; }
  const release = frame.retain();
  if (!currentScope() || !localFrameMatches(frame, account, source, version)) { release(); denied(); return () => {}; }
  frame.signal.addEventListener('abort', denied, { once: true });
  listener({ imageSrc: source, decoded: true, mime: 'image/png', bytes: frame.blob.size, width: frame.width, height: frame.height,
    authorizationVersion: version, progress: { phase: 'decoding', loadedBytes: frame.blob.size, bodyComplete: true } });
  let released = false;
  return () => { if (released) return; released = true; frame.signal.removeEventListener('abort', denied); release(); };
}
export function acquireImageRead(account: string, source: string, version: string, _attempt: number, listener: Listener, localFrame?: LocalFrameContext) {
  if (localFrame) return acquireLocalFrameRead(account, source, version, localFrame, listener);
  setImageReadSessionOwner(account);
  if (!account) { listener({ imageSrc: null, denied: true, progress: { phase: 'unavailable', loadedBytes: 0, message: '请先确认登录状态后重试' } }); return () => {}; }
  cancelImagePrefetches(source);
  const entry = getEntry(account, source);
  if (!entry) { listener({ imageSrc: null, progress: { phase: 'unavailable', loadedBytes: 0, message: '当前打开的图片较多，请关闭部分预览后重试' } }); return () => {}; }
  const expectedVersion = version.trim();
  const consumer: Consumer = { listener, approval: entry.revision, expectedVersion };
  entry.consumers.add(consumer); touch(entry);
  const cached = Boolean(entry.blob && entry.actualVersion && entry.reusable);
  const knownMismatch = cached && expectedVersion && !versionsMatch(expectedVersion, entry.actualVersion || '');
  if (knownMismatch) {
    dropBody(entry); consumer.approval = entry.revision; allowBodyAgain(entry); startColdRead(entry, expectedVersion);
  } else if (cached) {
    consumer.approval = entry.revision;
    if (entry.decoded && entry.result.decoded) listener(consumerResult(entry, consumer));
    else { listener(decoding(entry)); void decode(entry); }
    void revalidate(entry);
  } else {
    if (entry.blob) dropBody(entry);
    consumer.approval = entry.revision; entry.blocked = undefined;
    listener(entry.transfer ? consumerResult(entry, consumer) : reading());
    if (entry.transfer && expectedVersion && entry.transferExpectedVersion && !versionsMatch(expectedVersion, entry.transferExpectedVersion)) {
      dropBody(entry); consumer.approval = entry.revision; allowBodyAgain(entry); startColdRead(entry, expectedVersion);
    } else if (entry.blob) void decode(entry);
    else startColdRead(entry, expectedVersion);
  }
  drain();
  return () => { entry.consumers.delete(consumer); releaseUnused(entry); drain(); };
}
export function prefetchImageRead(account: string, source: string, version = '') {
  if (!account || account !== owner || !canPrefetchImages() || !reusableSource(source)) return () => {};
  const entry = getEntry(account, source);
  if (!entry) return () => {};
  entry.prefetches++;
  const prefetchRevision = entry.prefetchRevision;
  const expectedVersion = version.trim();
  const cached = Boolean(entry.blob && entry.actualVersion && entry.reusable);
  if (cached && expectedVersion && !versionsMatch(expectedVersion, entry.actualVersion || '')) {
    dropBody(entry); void transfer(entry, expectedVersion);
  } else if (cached) {
    if (entry.decoded) pruneDecoded(); else void decode(entry);
    void revalidate(entry);
  } else {
    if (entry.blob) dropBody(entry);
    void transfer(entry, expectedVersion);
  }
  let released = false;
  return () => {
    if (released) return; released = true;
    if (entry.prefetchRevision !== prefetchRevision) return;
    entry.prefetches = Math.max(0, entry.prefetches - 1);
    queueMicrotask(() => { if (entries.get(entry.key) === entry) releaseUnused(entry); });
  };
}

registerImageReadFamilyInvalidator((source, account) => {
  invalidateImageReadFamily(source, account, '图片权限或来源已变化，请重新打开', false);
});
