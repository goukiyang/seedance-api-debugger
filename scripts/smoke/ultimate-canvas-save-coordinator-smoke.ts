import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { createCanvasSaveCoordinator } = require('../public/tools/ultimate-canvas/canvas-save-coordinator.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function latestWinsSmoke() {
  const pending: Array<ReturnType<typeof deferred<any>>> = [];
  const calls: number[] = [];
  let concurrency = 0;
  let maxConcurrency = 0;
  const coordinator = createCanvasSaveCoordinator({
    executor: async (job: any) => {
      calls.push(job.snapshot.revision);
      concurrency += 1;
      maxConcurrency = Math.max(maxConcurrency, concurrency);
      const operation = deferred<any>();
      pending.push(operation);
      try {
        return await operation.promise;
      } finally {
        concurrency -= 1;
      }
    },
  });

  const first = coordinator.request({ revision: 1 });
  const second = coordinator.request({ revision: 2 });
  const third = coordinator.request({ revision: 3 });
  await Promise.resolve();
  assert.deepEqual(calls, [1], 'first save starts immediately and alone');
  pending[0].resolve({ document: { id: 'doc-1' } });
  await first;
  await Promise.resolve();
  assert.deepEqual(calls, [1, 3], 'revisions arriving in flight coalesce to the newest snapshot');
  pending[1].resolve({ document: { id: 'doc-3' } });
  const [secondOutcome, thirdOutcome] = await Promise.all([second, third]);
  assert.equal(secondOutcome.revision, 3, 'coalesced waiter settles with newest persisted revision');
  assert.equal(thirdOutcome.ok, true);
  assert.equal(maxConcurrency, 1, 'save POST executor never runs concurrently');
}

async function failureRecoveryAndFlushSmoke() {
  const calls: number[] = [];
  const coordinator = createCanvasSaveCoordinator({
    executor: async (job: any) => {
      calls.push(job.snapshot.revision);
      if (job.snapshot.revision === 1) throw new Error('temporary save failure');
      return { document: { id: `doc-${job.snapshot.revision}` } };
    },
  });
  const failed = await coordinator.request({ revision: 1 });
  assert.equal(failed.ok, false, 'executor failure is reported without wedging the queue');
  const recovered = await coordinator.request({ revision: 2 });
  assert.equal(recovered.ok, true, 'a later save recovers after failure');
  const flushed = await coordinator.flush({ revision: 3 });
  assert.equal(flushed.ok, true);
  assert.equal(flushed.revision, 3, 'flush persists the latest dirty snapshot');
  assert.deepEqual(calls, [1, 2, 3]);
}

async function staleContextResponseSmoke() {
  const operation = deferred<any>();
  const state = { context: 'context-a', documentId: 'current-document', saveState: 'idle' };
  const coordinator = createCanvasSaveCoordinator({
    executor: () => operation.promise,
    isCurrent: (job: any) => job.snapshot.context === state.context,
    onStart: () => { state.saveState = 'saving'; },
    onSuccess: (result: any) => {
      state.documentId = result.document.id;
      state.saveState = 'saved';
    },
  });
  const save = coordinator.request({ context: 'context-a', revision: 1 });
  state.context = 'context-b';
  state.documentId = 'replacement-document';
  state.saveState = 'idle';
  operation.resolve({ document: { id: 'stale-document' } });
  await save;
  assert.equal(state.documentId, 'replacement-document', 'stale save response cannot replace current document ID');
  assert.equal(state.saveState, 'idle', 'stale save response cannot update current save state');
}

async function main() {
  await latestWinsSmoke();
  await failureRecoveryAndFlushSmoke();
  await staleContextResponseSmoke();
  const indexSource = readFileSync('public/tools/ultimate-canvas/index.html', 'utf8');
  const appSource = readFileSync('public/tools/ultimate-canvas/app.js', 'utf8');
  assert.ok(indexSource.indexOf('canvas-save-coordinator.js') < indexSource.indexOf('app.js'), 'save coordinator loads before app');
  assert.ok(appSource.includes('createCanvasSaveCoordinator'), 'app uses the single-flight save queue');
  console.log('ultimate canvas save coordinator smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
