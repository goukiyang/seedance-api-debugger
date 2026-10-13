import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clientSessionNotice, logoutResponseOutcome } from '../src/lib/auth/client-session-boundary';

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
assert.match(accountSource, /if \(!left\) lockClientSession\(\)/);
assert.doesNotMatch(accountSource, /removeItem\([^)]*canvas-draft/);
console.log('Client session boundary offline cases complete');
