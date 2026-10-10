'use client';

export type HdDescription = { status: 'queued' | 'running' | 'ready' | 'failed' | 'skipped'; sourceVersion: string | null; policy: string; reason?: string; format?: string; mime?: string; bytes?: number; width?: number; height?: number; original?: boolean };
export type HdSourceState = { description?: HdDescription; denied?: boolean; error?: boolean };
type Listener = (state: HdSourceState) => void;
type Descriptor = { key: string; account: string; source: string; state: HdSourceState; at: number; retryAfter: number; listeners: Set<Listener>; prefetches: number; controller?: AbortController; pending?: Promise<HdSourceState>; timer?: ReturnType<typeof setTimeout> };
type ImageReadFamilyInvalidator = (source: string, account: string) => void;
const descriptors = new Map<string, Descriptor>();
const READY_TTL = 60_000, IDLE_TTL = 10 * 60_000;
let owner = '', epoch = 0;
let invalidateImageReadFamily: ImageReadFamilyInvalidator | undefined;
function canonical(source: string) {
  const url = new URL(source, location.href); url.hash = ''; url.searchParams.sort();
  return url.origin === location.origin ? `${url.pathname}${url.search}` : url.href;
}
function sourceFamily(source: string) {
  const url = new URL(source, location.href); url.hash = '';
  for (const name of ['thumbnail', 'preview', 'detail', 'download', 'hd', 'hd-description', 'hd-download', 'hd-version', 'variant']) url.searchParams.delete(name);
  url.searchParams.sort();
  return url.origin === location.origin ? `${url.pathname}${url.search}` : url.href;
}
function stop(entry: Descriptor) { entry.controller?.abort(); clearTimeout(entry.timer); entry.timer = undefined; }
function notify(entry: Descriptor) { for (const listener of Array.from(entry.listeners)) listener(entry.state); }
export function setHdImageSessionOwner(next: string) {
  if (owner === next) return;
  owner = next; epoch++;
  for (const entry of Array.from(descriptors.values())) { stop(entry); for (const listener of Array.from(entry.listeners)) listener({ denied: true, error: true }); }
  descriptors.clear();
}
export function registerImageReadFamilyInvalidator(invalidator: ImageReadFamilyInvalidator) {
  invalidateImageReadFamily = invalidator;
}
export function invalidateHdImageSource(source: string, account = owner, options: { propagateToImageReads?: boolean } = {}) {
  if (!account || account !== owner) return;
  const family = sourceFamily(source);
  for (const [id, entry] of Array.from(descriptors)) if (entry.account === account && sourceFamily(entry.source) === family) {
    stop(entry); descriptors.delete(id); entry.state = { denied: true, error: true }; notify(entry);
  }
  // Image-read invalidation is a sink; callers already invalidating that family suppress the return edge.
  if (options.propagateToImageReads !== false) invalidateImageReadFamily?.(source, account);
}
function getEntry(account: string, source: string, version: string) {
  setHdImageSessionOwner(account);
  const key = JSON.stringify([account, canonical(source), version]);
  let entry = descriptors.get(key);
  if (!entry) {
    for (const [id, value] of Array.from(descriptors)) if (!value.listeners.size && !value.prefetches && (descriptors.size >= 32 || Date.now() - value.at >= IDLE_TTL)) { stop(value); descriptors.delete(id); }
    if (descriptors.size >= 32) return null;
    entry = { key, account, source: canonical(source), state: {}, at: 0, retryAfter: 0, listeners: new Set(), prefetches: 0 };
    descriptors.set(key, entry);
  }
  return entry;
}
function parseDescription(value: unknown): HdDescription {
  if (!value || typeof value !== 'object') throw new Error('invalid_descriptor');
  const data = value as HdDescription;
  if (data.policy !== 'hd-f-v1' || !['queued', 'running', 'ready', 'failed', 'skipped'].includes(data.status) || !(data.sourceVersion === null || typeof data.sourceVersion === 'string' && data.sourceVersion.length <= 256)) throw new Error('invalid_descriptor');
  if (data.status === 'ready' && (!data.sourceVersion || ![data.bytes, data.width, data.height].every(number => Number.isSafeInteger(number) && number! > 0) || !data.mime?.startsWith('image/'))) throw new Error('invalid_descriptor');
  return data;
}
function poll(entry: Descriptor) {
  clearTimeout(entry.timer); entry.timer = undefined;
  if (entry.listeners.size && !document.hidden && ['queued', 'running'].includes(entry.state.description?.status || '')) entry.timer = setTimeout(() => { void read(entry, false); }, 5000);
}
async function read(entry: Descriptor, readonly: boolean): Promise<HdSourceState> {
  if (entry.pending) return entry.pending;
  const previous = entry.state, controller = new AbortController(), expected = epoch; entry.controller = controller;
  const pending = (async () => {
    let state: HdSourceState, status = 0;
    try {
      const response = await fetch(entry.source, { credentials: 'same-origin', cache: 'no-store', headers: readonly ? { 'X-Image-Read-Intent': 'prefetch' } : {}, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
      status = response.status;
      state = response.ok ? { description: parseDescription(await response.json()) } : { denied: [401, 403, 404].includes(status), error: true };
    } catch { state = { error: true }; }
    if (expected !== epoch || controller.signal.aborted || descriptors.get(entry.key) !== entry) return { error: true };
    if (state.denied) {
      invalidateHdImageSource(entry.source, entry.account);
      return state;
    }
    if (state.error) {
      const notPrepared = status === 409;
      entry.state = !notPrepared && previous.description?.status === 'ready' ? { ...previous, error: true } : { error: true };
      if (notPrepared) { entry.at = Date.now(); entry.retryAfter = 0; }
      else entry.retryAfter = Date.now() + READY_TTL;
    } else {
      entry.state = state; entry.at = Date.now(); entry.retryAfter = 0;
    }
    descriptors.delete(entry.key); descriptors.set(entry.key, entry);
    notify(entry); poll(entry); return entry.state;
  })();
  entry.pending = pending;
  const state = await pending;
  if (entry.pending === pending) { entry.pending = undefined; entry.controller = undefined; }
  return state;
}
export function hdImageHint(account: string, source: string, version = '', allowExpired = false) {
  const entry = account === owner ? descriptors.get(JSON.stringify([account, canonical(source), version])) : undefined;
  return entry && (allowExpired || Date.now() - entry.at < READY_TTL) && entry.state.description?.status === 'ready' ? entry.state.description : undefined;
}
export function acquireHdImageSource(account: string, source: string, version: string, listener: Listener) {
  const entry = getEntry(account, source, version);
  if (!entry) { listener({ error: true }); return () => {}; }
  entry.listeners.add(listener);
  const ready = entry.state.description?.status === 'ready';
  if (entry.at && ready) listener(entry.state);
  if (!entry.pending) {
    if (ready) {
      if (Date.now() - entry.at >= READY_TTL && Date.now() >= entry.retryAfter) void read(entry, true);
    } else void read(entry, false);
  }
  const foreground = () => {
    if (document.hidden) { clearTimeout(entry.timer); entry.timer = undefined; }
    else if (['queued', 'running'].includes(entry.state.description?.status || '')) void read(entry, false);
    else if (entry.state.description?.status === 'ready' && Date.now() - entry.at >= READY_TTL && Date.now() >= entry.retryAfter) void read(entry, true);
  };
  document.addEventListener('visibilitychange', foreground);
  return () => {
    document.removeEventListener('visibilitychange', foreground); entry.listeners.delete(listener);
    if (!entry.listeners.size) { clearTimeout(entry.timer); entry.timer = undefined; if (!entry.prefetches) { stop(entry); entry.pending = undefined; } }
  };
}
export function prefetchHdImageSource(account: string, source: string, version = '') {
  const entry = getEntry(account, source, version);
  if (!entry) return { result: Promise.resolve<HdSourceState>({ error: true }), release: () => {} };
  const hint = hdImageHint(account, source, version);
  entry.prefetches++;
  const result: Promise<HdSourceState> = hint ? Promise.resolve({ description: hint })
    : entry.pending ? entry.pending
      : entry.state.description?.status === 'ready' && Date.now() < entry.retryAfter ? Promise.resolve(entry.state)
        : read(entry, true);
  let released = false;
  return { result, release: () => {
    if (released) return; released = true; entry.prefetches = Math.max(0, entry.prefetches - 1);
    queueMicrotask(() => { if (!entry.listeners.size && !entry.prefetches) { stop(entry); entry.pending = undefined; } });
  } };
}
