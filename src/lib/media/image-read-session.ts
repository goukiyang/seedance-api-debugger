'use client';

export type ImageReadProgress = { phase: 'reading' | 'decoding' | 'unavailable' | 'unsupported'; loadedBytes: number; totalBytes?: number; percent?: number; message?: string };
export type ImageReadResult = { imageSrc: string | null; progress: ImageReadProgress; denied?: boolean };
type Listener = (value: ImageReadResult) => void;
type Entry = { source: string; controller: AbortController; listeners: Set<Listener>; result: ImageReadResult; url?: string; etag?: string; bytes: number; at: number; reusable: boolean; checking?: Promise<void> };
const entries = new Map<string, Entry>();
const MAX_ENTRIES = 32, MAX_BYTES = 64 * 1024 * 1024, TTL = 3 * 60_000;
let owner = '', epoch = 0;
const reading = (): ImageReadResult => ({ imageSrc: null, progress: { phase: 'reading', loadedBytes: 0 } });
function publish(entry: Entry, result: ImageReadResult) { entry.result = result; for (const listener of entry.listeners) listener(result); }
function discard(key: string, entry: Entry) {
  if (entries.get(key) === entry) entries.delete(key);
  entry.controller.abort();
  if (entry.url) URL.revokeObjectURL(entry.url);
  entry.url = undefined;
}
function fail(entry: Entry, message: string, denied = false) {
  if (entry.url) URL.revokeObjectURL(entry.url);
  entry.url = undefined; entry.bytes = 0;
  publish(entry, { imageSrc: null, denied, progress: { phase: 'unavailable', loadedBytes: 0, message } });
}
export function setImageReadSessionOwner(next: string) {
  if (owner === next) return;
  owner = next; epoch++;
  for (const [key, entry] of Array.from(entries)) {
    fail(entry, '账号已变化，请重新打开图片', true); discard(key, entry);
  }
}
function reusableSource(source: string) {
  const url = new URL(source, location.href);
  return url.origin === location.origin && /^\/api\/(?:image-studio\/(?:(?:assets|template-assets)\/|style-groups\/[^/]+\/assets\/)|reference-images\/[^/]+\/content|content-reactions\/media)/.test(url.pathname)
    && (['preview', 'thumbnail', 'detail'].includes(url.searchParams.get('variant') || '') || ['preview', 'thumbnail', 'detail'].some(key => url.searchParams.get(key) === '1'));
}
function prune(required = 0) {
  for (const [key, entry] of Array.from(entries)) if (!entry.listeners.size && Date.now() - entry.at > TTL) discard(key, entry);
  let bytes = Array.from(entries.values()).reduce((sum, entry) => sum + entry.bytes, 0);
  for (const [key, entry] of Array.from(entries)) {
    if (bytes + required <= MAX_BYTES && entries.size < MAX_ENTRIES) break;
    if (!entry.listeners.size) { bytes -= entry.bytes; discard(key, entry); }
  }
  return bytes + required <= MAX_BYTES && entries.size < MAX_ENTRIES;
}
async function read(entry: Entry) {
  const expected = epoch, active = () => expected === epoch && !entry.controller.signal.aborted;
  try {
    const response = await fetch(entry.source, { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.any([entry.controller.signal, AbortSignal.timeout(60000)]) });
    if (!active()) return;
    if (!response.ok) { fail(entry, '图片未能读取，请重试', [401, 403, 404].includes(response.status)); return; }
    const mime = response.headers.get('content-type')?.split(';')[0] || '';
    if (!mime.startsWith('image/') || !response.body) { fail(entry, '当前来源不是可读取的图片'); return; }
    const rawLength = response.headers.get('content-length'), encoded = response.headers.get('content-encoding');
    let total = rawLength && /^\d+$/.test(rawLength) && (!encoded || encoded === 'identity') ? Number(rawLength) : undefined;
    if (total !== undefined && (!Number.isSafeInteger(total) || total <= 0)) total = undefined;
    if (total && total > MAX_BYTES) throw Error('图片过大，请使用原图下载');
    const reader = response.body.getReader(), chunks: ArrayBuffer[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!active()) { await reader.cancel(); return; }
      bytes += chunk.value.byteLength;
      prune(chunk.value.byteLength);
      const allBytes = Array.from(entries.values()).reduce((sum, value) => sum + (value === entry ? bytes : value.bytes), 0);
      if (allBytes > MAX_BYTES) { await reader.cancel(); throw Error('图片较大，请使用原图下载或关闭其他预览'); }
      entry.bytes = bytes; chunks.push(chunk.value.slice().buffer as ArrayBuffer);
      if (total && bytes > total) total = undefined;
      publish(entry, { imageSrc: null, progress: { phase: 'reading', loadedBytes: bytes, ...(total ? { totalBytes: total, percent: Math.min(99, Math.floor(bytes / total * 100)) } : {}) } });
    }
    if (!active()) return;
    if (!bytes || total && bytes !== total) throw Error('图片未完整读取，请重试');
    entry.url = URL.createObjectURL(new Blob(chunks, { type: mime }));
    publish(entry, { imageSrc: null, progress: { phase: 'decoding', loadedBytes: bytes, ...(total ? { totalBytes: total } : {}) } });
    const image = new Image(); image.src = entry.url;
    await image.decode();
    if (!active()) return;
    entry.etag = response.headers.get('etag') || undefined; entry.at = Date.now();
    publish(entry, { imageSrc: entry.url, progress: { phase: 'decoding', loadedBytes: bytes, ...(total ? { totalBytes: total, percent: 100 } : {}) } });
  } catch (error) {
    if (!active()) return;
    if (new URL(entry.source, location.href).origin !== location.origin) {
      publish(entry, { imageSrc: entry.source, progress: { phase: 'unavailable', loadedBytes: 0, message: '外部来源由浏览器直接显示，大小与读取进度未知' } });
    } else fail(entry, error instanceof Error && error.message !== 'Failed to fetch' ? error.message : '图片读取失败，请重试');
  }
}
async function validate(entry: Entry) {
  if (entry.checking) return entry.checking;
  const expected = epoch;
  entry.checking = (async () => {
    try {
      const response = await fetch(entry.source, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin', headers: entry.etag ? { 'If-None-Match': entry.etag } : {}, signal: AbortSignal.any([entry.controller.signal, AbortSignal.timeout(15000)]) });
      if (expected !== epoch || entry.controller.signal.aborted) return;
      if (![200, 304].includes(response.status) || !response.headers.get('content-type')?.startsWith('image/')) { fail(entry, '图片权限已失效或文件不可用，请重新选择', true); return; }
      if (!entry.etag || response.headers.get('etag') !== entry.etag) {
        if (entry.url) URL.revokeObjectURL(entry.url);
        entry.url = undefined; entry.bytes = 0; await read(entry); return;
      }
      entry.at = Date.now(); publish(entry, { ...entry.result, imageSrc: entry.url || null });
    } catch { if (!entry.controller.signal.aborted && expected === epoch) fail(entry, '图片权限暂时无法确认，请重试', true); }
    finally { entry.checking = undefined; }
  })();
  return entry.checking;
}
export function revalidateActiveImages(minAge = 0) {
  prune();
  for (const entry of entries.values()) if (entry.url && entry.listeners.size && entry.reusable && !entry.checking && Date.now() - entry.at >= minAge) {
    for (const listener of entry.listeners) listener(reading());
    void validate(entry);
  }
}
export function acquireImageRead(account: string, source: string, version: string, attempt: number, listener: Listener) {
  setImageReadSessionOwner(account);
  if (!account) { listener({ imageSrc: null, denied: true, progress: { phase: 'unavailable', loadedBytes: 0, message: '请先确认登录状态后重试' } }); return () => {}; }
  const key = `${account}\u0000${source}\u0000${version}\u0000${attempt}`;
  let entry = entries.get(key);
  if (entry && !entry.url && !entry.listeners.size) { discard(key, entry); entry = undefined; }
  if (!entry) {
    if (!prune()) { listener({ imageSrc: null, progress: { phase: 'unavailable', loadedBytes: 0, message: '当前打开的图片较多，请关闭部分预览后重试' } }); return () => {}; }
    entry = { source, controller: new AbortController(), listeners: new Set(), result: reading(), bytes: 0, at: Date.now(), reusable: reusableSource(source) };
    entries.set(key, entry); entry.listeners.add(listener); listener(reading()); void read(entry);
  } else {
    entry.listeners.add(listener);
    if (entry.url) { listener(reading()); void validate(entry); } else listener(entry.result);
  }
  const subscribed = entry;
  return () => {
    subscribed.listeners.delete(listener); subscribed.at = Date.now();
    if (!subscribed.listeners.size && (!subscribed.url || !subscribed.reusable)) discard(key, subscribed); else prune();
  };
}
