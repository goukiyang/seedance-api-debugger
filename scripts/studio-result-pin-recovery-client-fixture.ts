import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { readStudioDirectory } from '../src/app/image-studio/result-directory-recovery';

async function main() {
  const checks: string[] = [];
  const changed = () => Object.assign(new Error('directory changed'), { status: 409, code: 'studio-directory-changed' });
  let calls: Array<string | undefined> = [], resets = 0;
  const recovered = await readStudioDirectory('old-cursor', async cursor => {
    calls.push(cursor); if (cursor) throw changed(); return 'fresh-page';
  }, () => { resets++; });
  assert.deepEqual(calls, ['old-cursor', undefined]); assert.equal(resets, 1);
  assert.equal(recovered.page, 'fresh-page'); assert.equal(recovered.restarted, true);
  checks.push('stale directory retries one fresh GET and reports the pagination reset');
  calls = []; resets = 0;
  await assert.rejects(readStudioDirectory('old-cursor', async cursor => { calls.push(cursor); throw changed(); }, () => { resets++; }));
  assert.equal(calls.length, 2); assert.equal(resets, 1);
  checks.push('continued concurrent directory changes stop after one recovery, with no polling loop');
  for (const error of [Object.assign(new Error('network'), { status: 503 }), Object.assign(new Error('other conflict'), { status: 409 }), new DOMException('Aborted', 'AbortError')]) {
    calls = []; resets = 0;
    await assert.rejects(readStudioDirectory('keep-cursor', async cursor => { calls.push(cursor); throw error; }, () => { resets++; }));
    assert.deepEqual(calls, ['keep-cursor']); assert.equal(resets, 0);
  }
  checks.push('network, unrelated409 and abort errors do not discard the original cursor or trigger another read');

  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const code = transformSync(readFileSync('src/app/image-studio/pin-request-storage.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  type Store = typeof import('../src/app/image-studio/pin-request-storage');
  let writes = 0;
  function restored(localStorage = storage): Store {
    const module = { exports: {} };
    const Custom = class extends Event { detail: unknown; constructor(type: string, init: { detail: unknown }) { super(type); this.detail = init.detail; } };
    vm.runInNewContext(code, { module, localStorage, window: new EventTarget(), CustomEvent: Custom, fetch: () => { writes++; throw new Error('restoration must be inert'); } });
    return module.exports as Store;
  }
  const body = { viewerId: 'viewer', moduleId: 'module', taskId: 'task', assetId: 'asset', active: true,
    expectedRevision: 4, requestId: 'original-request', presetId: 'original-preset' };
  assert.equal(restored().rememberPinRequest(body), true);
  const resumed = restored();
  assert.equal(JSON.stringify(resumed.readPinRequest('viewer', 'module', 'asset')), JSON.stringify(body));
  assert.equal(resumed.readPinRequest('other-viewer', 'module', 'asset'), null);
  assert.equal(resumed.readPinRequest('viewer', 'other-module', 'asset'), null);
  assert.equal(writes, 0);
  checks.push('a new page context restores the exact original id/intent/revision, isolated by account and target, without mutation');
  resumed.rememberPinRequest(body, true);
  assert.equal(restored().readPinRequest('viewer', 'module', 'asset'), null);
  const broken = { ...storage, getItem: () => { throw new Error('storage blocked'); }, setItem: () => { throw new Error('storage blocked'); } };
  const memoryOnly = restored(broken);
  assert.equal(memoryOnly.rememberPinRequest(body), false);
  assert.equal(memoryOnly.readPinRequest('viewer', 'module', 'asset')?.requestId, body.requestId);
  assert.equal(restored(broken).readPinRequest('viewer', 'module', 'asset'), null);
  values.set(resumed.pinRequestKey('viewer', 'module', 'asset'), JSON.stringify({ ...body, viewerId: 'other' }));
  assert.equal(restored().readPinRequest('viewer', 'module', 'asset'), null);
  assert.equal(writes, 0);
  checks.push('confirmed records clear across reload; broken storage is not reported as durable; mismatched cached identities are rejected');
  console.log(JSON.stringify({ ok: true, checks, writes, browserRuns: 0 }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
