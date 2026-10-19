import assert from 'node:assert/strict';
import { hdAvailabilityLabel, hdDescriptionUsesOriginal, hdDisplayLabel, hdDisplayPolicy } from '../src/lib/media/hd-display-policy';
import { acquireHdImageSource, hdImageHint, invalidateHdImageSource, prefetchHdImageSource, registerImageReadFamilyInvalidator, setHdImageSessionOwner, type HdDescription, type HdSourceState } from '../src/lib/media/hd-source-session';
import { runHdDisplayEngineering } from './hd-display-engineering';

// In-memory engineering matrix only. No browser, server, files, or production requests.
async function main() {
const ready: HdDescription = { policy: 'hd-f-v1', status: 'ready', sourceVersion: 'source-v1', format: 'avif', mime: 'image/avif', bytes: 900, width: 100, height: 200 };
const option = { original: false, previewOnly: false, supported: true };
assert.deepEqual(hdDisplayPolicy(option), { kind: 'pending', pending: true, fullSize: false });
assert.equal(hdDisplayPolicy({ ...option, description: ready }).kind, 'hd');
for (const status of ['queued', 'running', 'failed', 'skipped'] as const) {
  const result = hdDisplayPolicy({ ...option, description: { policy: 'hd-f-v1', status, sourceVersion: 'source-v1' } });
  assert.equal(result.kind, 'preview');
  assert.equal(result.fullSize, false);
  assert.equal(result.pending, status === 'queued' || status === 'running');
}
assert.equal(hdDisplayPolicy({ ...option, original: true, description: ready }).kind, 'original');
assert.deepEqual(hdDisplayPolicy({ ...option, original: true, previewOnly: true, description: ready }), { kind: 'preview', pending: false, fullSize: false });
assert.equal(hdDisplayPolicy({ ...option, error: true }).pending, false);
assert.equal(hdDisplayPolicy({ ...option, error: true }).kind, 'preview');
assert.equal(hdDisplayPolicy({ ...option, description: { ...ready, status: 'skipped', reason: 'existing_webp' } }).kind, 'original');
assert.equal(hdDisplayPolicy({ ...option, description: { ...ready, status: 'skipped', reason: 'source_changed' } }).kind, 'preview');
for (const status of ['queued', 'running'] as const) {
  assert.equal(hdAvailabilityLabel({ ...ready, status }), '高清准备中');
  assert.doesNotMatch(hdAvailabilityLabel({ ...ready, status }), /不可用|失败/);
}
for (const description of [{ ...ready, original: true }, { ...ready, format: 'original' }]) {
  assert.equal(hdDescriptionUsesOriginal(description), true);
  assert.equal(hdDisplayPolicy({ ...option, description }).kind, 'original');
  assert.match(hdDisplayLabel('original', description), /无需额外压缩/);
  assert.doesNotMatch(hdAvailabilityLabel(description), /未就绪|失败|丢失/);
}
assert.match(hdDisplayLabel('original', ready, true), /完整原图.*高清暂不可用/);
assert.match(hdAvailabilityLabel({ ...ready, status: 'skipped', reason: 'remote_version_unknown' }), /版本暂无法确认/);
assert.match(hdAvailabilityLabel({ ...ready, status: 'failed' }), /完整原图/);

const originals = { fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now,
  document: Object.getOwnPropertyDescriptor(globalThis, 'document'), location: Object.getOwnPropertyDescriptor(globalThis, 'location') };
let now = 1_000_000, nextTimer = 0;
const timers = new Map<number, { at: number; run: () => void }>();
const visibilityListeners = new Set<() => void>();
const documentStub = { hidden: false, addEventListener: (type: string, listener: () => void) => { if (type === 'visibilitychange') visibilityListeners.add(listener); },
  removeEventListener: (type: string, listener: () => void) => { if (type === 'visibilitychange') visibilityListeners.delete(listener); } };
type Reply = () => Promise<Response>;
const replies: Reply[] = [], requests: Array<{ url: string; readonly: boolean }> = [];
const states: HdSourceState[] = [];
const response = (description: HdDescription | null, status = 200) => () => Promise.resolve(new Response(description ? JSON.stringify(description) : '', { status, headers: { 'Content-Type': 'application/json' } }));
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const advance = async () => {
  const target = Array.from(timers).sort((a, b) => a[1].at - b[1].at)[0];
  assert.ok(target, 'expected a bounded scheduled check');
  timers.delete(target[0]); now = target[1].at; target[1].run(); await drain();
};
const source = '/api/image-studio/assets/image-a?hd-description=1';
let release: (() => void) | undefined;
try {
  Object.defineProperty(globalThis, 'document', { value: documentStub, configurable: true });
  Object.defineProperty(globalThis, 'location', { value: new URL('https://sd2.youdooart.com/template-studio'), configurable: true });
  Date.now = () => now;
  globalThis.setTimeout = ((callback: () => void, delay = 0) => { const id = ++nextTimer; timers.set(id, { at: now + delay, run: callback }); return id; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), readonly: new Headers(init?.headers).get('X-Image-Read-Intent') === 'prefetch' });
    const next = replies.shift(); assert.ok(next, 'unexpected request'); return next();
  };
  setHdImageSessionOwner('owner-a');
  replies.push(response({ ...ready, status: 'queued' }), response(null, 503), response(ready));
  release = acquireHdImageSource('owner-a', source, '', value => states.push(value));
  await drain();
  assert.equal(states.at(-1)?.description?.status, 'queued');
  await advance();
  assert.equal(states.at(-1)?.error, true);
  assert.equal(states.at(-1)?.description?.status, 'queued', 'temporary errors retain the known source identity');
  const retryDelay = Array.from(timers.values())[0].at - now;
  assert.equal(retryDelay, 60_000, 'transient errors retry at a bounded quiet interval');
  await advance();
  assert.equal(states.at(-1)?.description?.status, 'ready', 'status recovery upgrades the same open image');
  assert.equal(hdImageHint('owner-a', source)?.sourceVersion, 'source-v1');
  replies.push(response({ ...ready, sourceVersion: 'source-v2' }));
  await advance();
  assert.equal(requests.at(-1)?.readonly, true, 'open ready images recheck without queue writes');
  assert.equal(states.at(-1)?.description?.sourceVersion, 'source-v2');

  // Hidden tabs pause; a foreground check remains read-only for a ready source.
  documentStub.hidden = true; visibilityListeners.forEach(listener => listener());
  assert.equal(timers.size, 0);
  now += 60_000; replies.push(response(ready));
  documentStub.hidden = false; visibilityListeners.forEach(listener => listener()); await drain();
  assert.equal(requests.at(-1)?.readonly, true);
  let revoked = 0;
  registerImageReadFamilyInvalidator((_source, account) => { assert.equal(account, 'owner-a'); revoked++; });
  replies.push(response(null, 403));
  await advance();
  assert.equal(states.at(-1)?.denied, true);
  assert.equal(hdImageHint('owner-a', source), undefined);
  assert.equal(revoked, 1, 'revocation clears the matching original/HD family');
  assert.equal(timers.size, 0, 'permission denial is not automatically retried');
  release(); release = undefined;

  // Account changes invalidate pending responses and cached hints, even when
  // the old server response arrives after its AbortSignal was cancelled.
  let resolveOld!: (value: Response) => void;
  replies.push(() => new Promise(resolve => { resolveOld = resolve; }));
  release = acquireHdImageSource('owner-a', source, '', value => states.push(value));
  await drain(); setHdImageSessionOwner('owner-b');
  const boundary = states.length;
  resolveOld(new Response(JSON.stringify(ready), { status: 200 })); await drain();
  assert.equal(states.length, boundary);
  assert.equal(hdImageHint('owner-b', source), undefined);
  release(); release = undefined;

  // A prefetch miss never registers work and can be retried by a real viewer.
  replies.push(response(null, 409));
  const prefetch = prefetchHdImageSource('owner-b', source);
  await prefetch.result; prefetch.release(); await drain();
  assert.equal(requests.at(-1)?.readonly, true);
  replies.push(response(ready));
  release = acquireHdImageSource('owner-b', source, '', value => states.push(value)); await drain();
  assert.equal(requests.at(-1)?.readonly, false, 'actual viewer does not inherit a speculative 409 wait');
  assert.equal(states.at(-1)?.description?.status, 'ready');
  release(); release = undefined;
  invalidateHdImageSource(source, 'owner-b', { propagateToImageReads: false });
  assert.equal(hdImageHint('owner-b', source), undefined);
  assert.equal(replies.length, 0);
  const checks = ['display_selection', 'transient_status_recovery', 'ready_readonly_recheck', 'visibility', 'source_version_change',
    'revocation_clears_family', 'account_boundary', 'readonly_prefetch', 'pending_is_preview_not_original', 'known_incompatibility_only_original',
    ...await runHdDisplayEngineering()];
  console.log(JSON.stringify({ completed: true, passed: checks.length, groups: checks.length, total: checks.length, checks, browser: false, network: 'mocked-only' }));
} finally {
  release?.(); setHdImageSessionOwner('');
  globalThis.fetch = originals.fetch; globalThis.setTimeout = originals.setTimeout; globalThis.clearTimeout = originals.clearTimeout; Date.now = originals.now;
  for (const key of ['document', 'location'] as const) {
    const descriptor = originals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
}
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
