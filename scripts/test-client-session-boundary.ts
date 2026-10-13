import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { broadcastSessionExit, clientSessionNotice, isClientSessionBlocked, logoutResponseOutcome, parseClientSessionEvent, watchSessionExit } from '../src/lib/auth/client-session-boundary';

// Offline response-contract cases. No auth request, browser, or credential access.
assert.equal(logoutResponseOutcome({ ok: true, status: 200 }, { ok: true }), 'confirmed');
assert.equal(logoutResponseOutcome({ ok: false, status: 400 }, { ok: false }), 'known_failure');
for (const [response, body] of [
  [{ ok: false, status: 502 }, { ok: false }],
  [{ ok: false, status: 401 }, { error: 'unauthorized' }],
  [{ ok: false, status: 500 }, { ok: true }],
  [{ ok: true, status: 200 }, { ok: false }],
  [{ ok: true, status: 200 }, null],
  [{ ok: true, status: 200 }, 'unexpected response'],
] as const) assert.equal(logoutResponseOutcome(response, body), 'unknown');

assert.equal(clientSessionNotice('logged_out').title, '账号已退出');
assert.equal(clientSessionNotice('unconfirmed').title, '登录状态待确认');
assert.match(clientSessionNotice('unconfirmed').message, /尚未确认.*可能已退出/);
assert.match(clientSessionNotice('unconfirmed').message, /输入仍保留/);
assert.match(clientSessionNotice('unconfirmed').message, /草稿不会清除/);

// Verify the component binds navigation approval to the pre-request snapshot.
const accountSource = readFileSync(new URL('../src/components/AccountMenu.tsx', import.meta.url), 'utf8');
const postStart = accountSource.indexOf("outcome = 'unknown';");
assert.ok(postStart > accountSource.indexOf('const currentRisk = getPageExitRisk()'));
assert.match(accountSource.slice(postStart), /runApprovedPageExit\([^\n]+currentRisk\.signature\)/);
assert.doesNotMatch(accountSource.slice(postStart), /const exitRisk\s*=\s*getPageExitRisk/);
assert.match(accountSource, /outcome === 'unknown'[\s\S]*lockClientSession\('unconfirmed'\)/);
assert.match(accountSource, /outcome === 'unknown'[\s\S]*broadcastSessionExit\('unconfirmed'\);\s*lockClientSession\('unconfirmed'\)/);
assert.match(accountSource, /if \(!left\) lockClientSession\(\)/);
assert.doesNotMatch(accountSource, /removeItem\([^)]*canvas-draft/);

const initialId = '00000000-0000-4000-8000-000000000001';
assert.deepEqual(parseClientSessionEvent(initialId), { eventId: initialId, reason: 'logged_out' });
const initialMarker = JSON.stringify({ eventId: initialId, reason: 'unconfirmed' });
assert.deepEqual(parseClientSessionEvent(initialMarker), { eventId: initialId, reason: 'unconfirmed' });
assert.deepEqual(parseClientSessionEvent({ eventId: initialId, reason: 'logged_out' }), { eventId: initialId, reason: 'logged_out' });
assert.equal(parseClientSessionEvent({ eventId: initialId, reason: 'other' }), null);
assert.equal(parseClientSessionEvent({ eventId: '<invalid>', reason: 'unconfirmed' }), null);
assert.equal(parseClientSessionEvent('not a marker'), null);

// Exercise the actual subscription using memory-only event surfaces. These
// fixtures do not access a browser profile, authentication, or persistent data.
const originalDescriptors = {
  window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  BroadcastChannel: Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel'),
};
const surface = new EventTarget();
const memory = new Map<string, string>([['sd2:session-exit', initialMarker]]);
const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); } };
const channelMessages: unknown[] = [];
class MemoryChannel {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage(value: unknown) { channelMessages.push(value); }
  close() {}
}
const reasons: string[] = [];
let stop: (() => void) | undefined;
function storageEvent(value: string) {
  const event = new Event('storage');
  Object.defineProperties(event, { key: { value: 'sd2:session-exit' }, storageArea: { value: storage }, newValue: { value } });
  surface.dispatchEvent(event);
}
try {
  Object.defineProperty(globalThis, 'window', { value: surface, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  Object.defineProperty(globalThis, 'BroadcastChannel', { value: MemoryChannel, configurable: true });
  stop = watchSessionExit(reason => reasons.push(reason));
  assert.equal(isClientSessionBlocked(), false, 'existing unconfirmed marker must not lock a fresh page');
  storageEvent(initialMarker);
  storageEvent(initialId);
  assert.deepEqual(reasons, [], 'existing structured or legacy event is only a baseline');

  broadcastSessionExit();
  assert.equal(JSON.parse(memory.get('sd2:session-exit')!).reason, 'logged_out', 'confirmed logout retains its own reason');
  Object.defineProperty(globalThis, 'localStorage', { value: { setItem() { throw new Error('storage unavailable'); } }, configurable: true });
  Object.defineProperty(globalThis, 'BroadcastChannel', { value: class { constructor() { throw new Error('channel unavailable'); } }, configurable: true });
  assert.doesNotThrow(() => broadcastSessionExit('unconfirmed'), 'failed cross-tab transports must not prevent the following local lock');
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  Object.defineProperty(globalThis, 'BroadcastChannel', { value: MemoryChannel, configurable: true });

  broadcastSessionExit('unconfirmed');
  const stored = memory.get('sd2:session-exit');
  assert.ok(stored);
  const message = JSON.parse(stored) as { eventId: string; reason: string };
  assert.deepEqual(Object.keys(message).sort(), ['eventId', 'reason']);
  assert.equal(message.reason, 'unconfirmed');
  assert.notEqual(message.eventId, initialId);
  assert.deepEqual(channelMessages.at(-1), message);
  assert.deepEqual(reasons, [], 'broadcast does not replace the issuing page local lock');
  storageEvent(stored);
  assert.equal(isClientSessionBlocked(), true);
  assert.deepEqual(reasons, ['unconfirmed'], 'another old page locks without claiming confirmed logout');
  storageEvent(stored);
  assert.deepEqual(reasons, ['unconfirmed'], 'the same event is not replayed');
} finally {
  stop?.();
  for (const name of ['window', 'localStorage', 'BroadcastChannel'] as const) {
    const descriptor = originalDescriptors[name];
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}
console.log('Client session boundary offline cases complete');
