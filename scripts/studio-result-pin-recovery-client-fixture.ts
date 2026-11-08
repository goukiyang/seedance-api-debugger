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

  // Run the real deletion hook with a small hook scheduler and controlled HTTP
  // receipts. This exercises command boundaries without a browser or live DB.
  const deletionCode = transformSync(readFileSync('src/app/image-studio/use-studio-deletion.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const deleteValues = new Map<string, string>();
  const deleteStorage = { get length() { return deleteValues.size; }, key: (i: number) => Array.from(deleteValues.keys())[i] || null,
    getItem: (key: string) => deleteValues.get(key) || null, setItem: (key: string, value: string) => { deleteValues.set(key, value); }, removeItem: (key: string) => { deleteValues.delete(key); } };
  const retainedDelete = { version: 1, actorId: 'viewer', objectKind: 'workspace', id: 'old-workspace', requestId: 'old-delete', moduleRevision: 0 };
  const deleteKey = 'sd2:studio-delete:v1:viewer:workspace:old-workspace';
  deleteValues.set(deleteKey, JSON.stringify(retainedDelete));
  const slots: unknown[] = [], effects: Array<() => void> = [];
  let index = 0, deleted = false, rejectChanged = false, settled = 0, confirmations = 0;
  const deletionRequests: Array<{ method: string; body?: Record<string, unknown> }> = [];
  const react = {
    useState: (initial: unknown) => { const slot = index++; if (!(slot in slots)) slots[slot] = initial;
      return [slots[slot], (next: unknown) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next; }]; },
    useRef: (initial: unknown) => { const slot = index++; if (!(slot in slots)) slots[slot] = { current: initial }; return slots[slot]; },
    useCallback: (callback: unknown, deps: unknown[]) => { const slot = index++; const old = slots[slot] as { deps: unknown[]; callback: unknown } | undefined;
      if (!old || deps.some((value, i) => value !== old.deps[i])) slots[slot] = { deps, callback };
      return (slots[slot] as { callback: unknown }).callback; },
    useEffect: (effect: () => void, deps: unknown[]) => { const slot = index++; const old = slots[slot] as unknown[] | undefined;
      if (!old || deps.some((value, i) => value !== old[i])) { slots[slot] = deps; effects.push(effect); } },
  };
  const receipt = { ...retainedDelete, deleted: true, sourcePresetId: null, committedAt: new Date().toISOString(), noOp: false };
  const deletionModule = { exports: {} };
  vm.runInNewContext(deletionCode, {
    module: deletionModule, localStorage: deleteStorage, window: new EventTarget(), navigator: { locks: { request: (_: string, callback: () => unknown) => Promise.resolve(callback()) } },
    crypto: { randomUUID: () => 'new-delete-id' }, AbortSignal,
    require: (name: string) => name === 'react' ? react : name.includes('client-session-boundary') ? { isClientSessionBlocked: () => false }
      : name.includes('useProductDialog') ? { useProductDialog: () => ({ productDialog: null, confirm: async (_: string, options: { onSubmit: () => Promise<void> }) => { confirmations++; await options.onSubmit(); } }) }
        : (() => { throw new Error(`Unexpected fixture import ${name}`); })(),
    fetch: async (_: string, options: { method?: string; body?: string } = {}) => {
      const method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : undefined;
      deletionRequests.push({ method, body });
      if (method === 'DELETE') {
        assert.equal(body.requestId, retainedDelete.requestId); assert.equal(body.revision, retainedDelete.moduleRevision);
        if (rejectChanged) return { ok: false, json: async () => ({ error: '模板已更新', commandOutcome: { status: 'not-applied', ...retainedDelete } }) };
        deleted = true; return { ok: true, json: async () => receipt };
      }
      return { ok: true, json: async () => deleted ? { status: 'completed', receipt, current: { exists: false, moduleRevision: null } } : { status: 'not-found' } };
    },
  });
  const deletionHook = deletionModule.exports as typeof import('../src/app/image-studio/use-studio-deletion');
  const render = () => { index = 0; return deletionHook.useStudioDeletion({ userId: 'viewer', onSettled: () => { settled++; }, blocked: () => null }); };
  let deletion = render();
  for (let tick = 0; tick < 4; tick++) { while (effects.length) effects.shift()!(); await new Promise(resolve => setImmediate(resolve)); deletion = render(); }
  assert.equal(deletion.pending.length, 1); assert.equal(confirmations, 0);
  assert.deepEqual(deletionRequests.map(row => row.method), ['GET']);
  await deletion.request({ version: 1, actorId: 'viewer', objectKind: 'workspace', id: 'old-workspace', moduleRevision: 7, allowed: true, reason: null }, 'Old workspace');
  assert.equal(confirmations, 1); assert.equal(settled, 1); assert.equal(deleteValues.size, 0);
  assert.equal(deletionRequests.filter(row => row.method === 'DELETE').length, 1);
  checks.push('real deletion-hook restoration only reads; an explicit continuation retains the original id and revision instead of using newer UI input');
  deleteValues.set(deleteKey, JSON.stringify(retainedDelete)); deleted = false; rejectChanged = true;
  await assert.rejects(deletion.request({ version: 1, actorId: 'viewer', objectKind: 'workspace', id: 'old-workspace', moduleRevision: 7, allowed: true, reason: null }, 'Newer workspace'), /模板已更新/);
  assert.equal(settled, 1); assert.equal(deleteValues.size, 0);
  checks.push('a definitive original-version rejection clears only that pending command and never reports a newer workspace as deleted');
  console.log(JSON.stringify({ ok: true, checks, writes, browserRuns: 0 }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
