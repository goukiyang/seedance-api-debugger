'use client';

export type HdDescription = { status: 'queued' | 'running' | 'ready' | 'failed' | 'skipped'; sourceVersion: string | null; policy: string; reason?: string; format?: string; mime?: string; bytes?: number; width?: number; height?: number; original?: boolean };
export type HdSourceState = { description?: HdDescription; denied?: boolean; error?: boolean; httpStatus?: number };
type Listener = (state: HdSourceState) => void;
type Descriptor = { key: string; account: string; source: string; state: HdSourceState; at: number; retryAfter: number; unchangedPolls: number; generation: number; listeners: Set<Listener>; prefetches: number; controller?: AbortController; pending?: Promise<HdSourceState>; refreshing?: Promise<HdSourceState>; timer?: ReturnType<typeof setTimeout> };
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
function stop(entry: Descriptor) { entry.generation++; entry.controller?.abort(); entry.refreshing = undefined; clearTimeout(entry.timer); entry.timer = undefined; }
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
  invalidateFamily(source, account, options.propagateToImageReads !== false);
}
function invalidateFamily(source: string, account: string, propagate: boolean, httpStatus?: number) {
  if (!account || account !== owner) return;
  const family = sourceFamily(source);
  for (const [id, entry] of Array.from(descriptors)) if (entry.account === account && sourceFamily(entry.source) === family) {
    stop(entry); descriptors.delete(id); entry.state = { denied: true, error: true, ...(httpStatus ? { httpStatus } : {}) }; notify(entry);
  }
  // Image-read invalidation is a sink; callers already invalidating that family suppress the return edge.
  if (propagate) invalidateImageReadFamily?.(source, account);
}
function getEntry(account: string, source: string, version: string) {
  setHdImageSessionOwner(account);
  const key = JSON.stringify([account, canonical(source), version]);
  let entry = descriptors.get(key);
  if (!entry) {
    for (const [id, value] of Array.from(descriptors)) if (!value.listeners.size && !value.prefetches && (descriptors.size >= 32 || Date.now() - value.at >= IDLE_TTL)) { stop(value); descriptors.delete(id); }
    if (descriptors.size >= 32) return null;
    entry = { key, account, source: canonical(source), state: {}, at: 0, retryAfter: 0, unchangedPolls: 0, generation: 0, listeners: new Set(), prefetches: 0 };
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
  if (!entry.listeners.size || document.hidden || entry.state.denied) return;
  const ready = entry.state.description?.status === 'ready';
  const pending = ['queued', 'running'].includes(entry.state.description?.status || '');
  if (!ready && !pending && !entry.state.error) return;
  // A temporary status-read failure must not permanently stop an open viewer.
  // Ready checks are read-only, while unchanged queue checks back off to 30s.
  const delay = entry.state.error ? Math.max(1000, entry.retryAfter - Date.now())
    : ready ? Math.max(1000, READY_TTL - (Date.now() - entry.at))
      : Math.min(30_000, 5000 * 2 ** Math.min(entry.unchangedPolls, 3));
  entry.timer = setTimeout(() => { void read(entry, ready); }, delay);
}
async function read(entry: Descriptor, readonly: boolean): Promise<HdSourceState> {
  if (entry.pending) return entry.pending;
  const previous = entry.state, controller = new AbortController(), expected = epoch, generation = entry.generation; entry.controller = controller;
  const pending = (async () => {
    let state: HdSourceState, status = 0;
    try {
      const response = await fetch(entry.source, { credentials: 'same-origin', cache: 'no-store', headers: readonly ? { 'X-Image-Read-Intent': 'prefetch' } : {}, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
      status = response.status;
      state = response.ok ? { description: parseDescription(await response.json()), httpStatus: status } : { denied: [401, 403, 404].includes(status), error: true, httpStatus: status };
    } catch { state = { error: true, ...(status ? { httpStatus: status } : {}) }; }
    if (expected !== epoch || generation !== entry.generation || controller.signal.aborted || descriptors.get(entry.key) !== entry) return { error: true };
    if (state.denied) {
      invalidateFamily(entry.source, entry.account, true, state.httpStatus);
      return state;
    }
    if (state.error) {
      const notPrepared = status === 409;
      entry.state = !notPrepared && previous.description?.status === 'ready'
        ? { ...previous, error: true, httpStatus: state.httpStatus } : { error: true, httpStatus: state.httpStatus };
      if (notPrepared) { entry.at = Date.now(); entry.retryAfter = Date.now() + READY_TTL; }
      else entry.retryAfter = Date.now() + READY_TTL;
    } else {
      entry.unchangedPolls = previous.description?.status === state.description?.status
        && previous.description?.sourceVersion === state.description?.sourceVersion
        && previous.description?.reason === state.description?.reason ? Math.min(3, entry.unchangedPolls + 1) : 0;
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
// A current HD byte 409 can request one new descriptor lookup. Coalesce callers
// on that descriptor, but do not mistake an older pending read for a fresh check
// or restart work after its last consumer has canceled.
export async function refreshHdImageSource(account: string, source: string, version = ''): Promise<HdSourceState> {
  if (!account || account !== owner) return { error: true };
  let entry: Descriptor | undefined;
  try { entry = descriptors.get(JSON.stringify([account, canonical(source), version])); } catch { return { error: true }; }
  if (!entry) return { error: true };
  if (entry.refreshing) return entry.refreshing;
  const current = entry, expected = epoch, generation = entry.generation;
  clearTimeout(entry.timer); entry.timer = undefined;
  const pending = (async () => {
    if (current.pending) await current.pending;
    if (owner !== account || epoch !== expected || current.generation !== generation || descriptors.get(current.key) !== current) return { error: true };
    return read(current, true);
  })();
  entry.refreshing = pending;
  const state = await pending;
  if (entry.refreshing === pending) entry.refreshing = undefined;
  return state;
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
      else poll(entry);
    // A speculative readonly 409 means "not prepared", not a foreground
    // failure. The first actual viewer must obtain its own current descriptor
    // now, instead of inheriting the neighbor's quiet retry interval.
    } else if (entry.state.httpStatus === 409 || Date.now() >= entry.retryAfter) void read(entry, false);
    else { listener(entry.state); poll(entry); }
  }
  const foreground = () => {
    if (document.hidden) { clearTimeout(entry.timer); entry.timer = undefined; }
    else if ((['queued', 'running'].includes(entry.state.description?.status || '') || entry.state.error) && Date.now() >= entry.retryAfter) void read(entry, entry.state.description?.status === 'ready');
    else if (entry.state.description?.status === 'ready' && Date.now() - entry.at >= READY_TTL && Date.now() >= entry.retryAfter) void read(entry, true);
    else poll(entry);
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
