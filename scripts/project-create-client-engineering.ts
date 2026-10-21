import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readProjectCreatePending, settleProjectCreatePending, storeProjectCreatePending } from '../src/lib/projects/client-operations';

const root = realpathSync(process.cwd());
const destination = path.resolve(process.argv[2] || '');
assert.ok(destination.startsWith(path.join(root, '.role-tests') + path.sep));
const entries = new Map<string, string>();
const storage = {
  get length() { return entries.size; },
  key(index: number) { return Array.from(entries.keys())[index] ?? null; },
  getItem(key: string) { return entries.get(key) ?? null; },
  setItem(key: string, value: string) { entries.set(key, value); },
  removeItem(key: string) { entries.delete(key); },
};
const key = 'sd2-project-create:v1:self:fixture';
const first = { schema: 1 as const, ownerId: 'self', requestId: '10000000-0000-4000-8000-000000000001',
  input: { name: 'First' }, state: 'unknown' as const };
const second = { ...first, requestId: '10000000-0000-4000-8000-000000000002', input: { name: 'Second' } };
storeProjectCreatePending(storage, key, first);
assert.deepEqual(readProjectCreatePending(storage, key, 'self'), first);
storeProjectCreatePending(storage, key, second);
assert.equal(settleProjectCreatePending(storage, key, 'self', first.requestId)?.requestId, second.requestId);
assert.deepEqual(readProjectCreatePending(storage, key, 'self'), second);
assert.equal(settleProjectCreatePending(storage, key, 'self', first.requestId)?.requestId, second.requestId);
assert.throws(() => readProjectCreatePending(storage, key, 'other'));
assert.equal(readProjectCreatePending(storage, `${key}-other`, 'self'), null);
assert.equal(settleProjectCreatePending(storage, key, 'self', second.requestId), null);
storage.setItem(key, JSON.stringify(first));
storeProjectCreatePending(storage, key, second);
assert.equal(settleProjectCreatePending(storage, key, 'self', first.requestId)?.requestId, second.requestId);
storage.setItem(`${key}:invalid`, '{');
assert.throws(() => readProjectCreatePending(storage, key, 'self'));
const sources = ['scripts/project-create-client-engineering.ts', 'src/lib/projects/client-operations.ts'];
writeFileSync(destination, JSON.stringify({ schema: 'project-create-client-engineering.v1', synthetic: true, completed: true,
  checks: ['original_request_entries_survive_late_other_tab_receipt', 'duplicate_terminal_receipt_does_not_erase_next_request',
    'owner_surface_isolation_and_legacy_pending_preserved', 'corrupt_original_pending_fails_closed'],
  sourceSha256: Object.fromEntries(sources.map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')])),
  applicationDatabaseOpened: false, forbiddenCalls: 0, paidRequests: 0, browserRuns: 0,
  scope: 'Pure pending-storage contract only; no hook, browser, HTTP or functional acceptance' }), { mode: 0o600, flag: 'wx' });
console.log('PROJECT_CREATE_CLIENT_ENGINEERING_RECEIPT=' + destination);
