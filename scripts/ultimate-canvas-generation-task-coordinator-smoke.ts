import assert from 'node:assert/strict';

const { createGenerationTaskCoordinator } = require('../public/tools/ultimate-canvas/generation-task-coordinator.js');

type TimerCallback = () => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function staleResultSmoke() {
  const pending: Array<ReturnType<typeof deferred<any>>> = [];
  const statuses: string[] = [];
  const errors: string[] = [];
  let timer: TimerCallback | null = null;
  let timerCreates = 0;
  let timerClears = 0;
  let liveTimers = 0;
  let maxLiveTimers = 0;
  const coordinator = createGenerationTaskCoordinator({
    fetchStatus: () => {
      const next = deferred<any>();
      pending.push(next);
      return next.promise;
    },
    onStatus: (nodeId: string) => statuses.push(nodeId),
    onError: (_taskId: string, nodeId: string) => errors.push(nodeId),
    isNodeAlive: () => true,
    isHidden: () => false,
    setTimer: (callback: TimerCallback) => {
      timerCreates += 1;
      liveTimers += 1;
      maxLiveTimers = Math.max(maxLiveTimers, liveTimers);
      timer = callback;
      return timerCreates;
    },
    clearTimer: () => {
      timerClears += 1;
      liveTimers -= 1;
      timer = null;
    },
    delayFor: () => 3000,
  });

  coordinator.register('same-task', 'old-node');
  const staleSuccessCycle = coordinator.runNow();
  coordinator.unregister('same-task');
  coordinator.register('same-task', 'new-node');
  pending[0].resolve({ id: 'same-task', local_status: 'succeeded' });
  await staleSuccessCycle;
  assert.deepEqual(statuses, [], 'stale terminal success is not delivered');
  assert.equal(coordinator.has('same-task'), true, 'stale terminal success cannot remove the replacement');

  const staleDirectUpdateCycle = coordinator.runNow();
  coordinator.register('same-task', 'direct-update-node');
  pending[1].resolve({ id: 'same-task', local_status: 'succeeded' });
  await staleDirectUpdateCycle;
  assert.deepEqual(statuses, [], 'same-task registration for a different node invalidates the captured entry');
  assert.equal(coordinator.has('same-task'), true, 'stale direct-update terminal cannot remove the replacement');
  coordinator.unregister('same-task', 'old-node');
  assert.equal(coordinator.has('same-task'), true, 'deleting an old node cannot unregister the replacement mapping');

  const freshSuccessCycle = coordinator.runNow();
  pending[2].resolve({ id: 'same-task', local_status: 'running' });
  await freshSuccessCycle;
  assert.deepEqual(statuses, ['direct-update-node'], 'the replacement entry receives a fresh result normally');

  coordinator.clear();
  coordinator.register('same-task', 'latest-node');
  const staleErrorCycle = coordinator.runNow();
  coordinator.clear();
  coordinator.register('same-task', 'newest-node');
  pending[3].reject(new Error('stale failure'));
  await staleErrorCycle;
  assert.deepEqual(errors, [], 'stale rejection is not delivered');
  assert.equal(coordinator.has('same-task'), true, 'stale rejection cannot affect the replacement');

  const freshAfterClearCycle = coordinator.runNow();
  pending[4].resolve({ id: 'same-task', local_status: 'succeeded' });
  await freshAfterClearCycle;
  assert.deepEqual(statuses, ['direct-update-node', 'newest-node'], 'a fresh terminal result after clear is delivered normally');
  assert.equal(coordinator.has('same-task'), false);
  assert.ok(timerCreates >= 1, 'the coordinator schedules through the shared timer slot');
  assert.equal(maxLiveTimers, 1, 'the coordinator never owns more than one live timer');
  coordinator.clear();
  assert.equal(timer, null, 'clear cancels the shared timer');
  assert.equal(liveTimers, 0, 'clear leaves no live timer');
  assert.ok(timerClears >= 1, 'the shared timer is cleared rather than duplicated');
}

async function main() {
const statuses: Array<{ nodeId: string; status: string }> = [];
const errors: Array<{ taskId: string; count: number }> = [];
const calls: string[] = [];
const delays: number[] = [];
const alive = new Set([
  'node-done',
  'node-failed',
  'node-cancelled',
  'node-running',
  'node-rejected',
  'node-hidden',
]);
let hidden = false;
let timer: TimerCallback | null = null;
let timerCreates = 0;

const coordinator = createGenerationTaskCoordinator({
  fetchStatus: async (taskId: string) => {
    calls.push(taskId);
    if (taskId === 'rejected') throw new Error('temporary status failure');
    const terminalStatus: Record<string, string> = {
      done: 'succeeded',
      failed: 'failed',
      cancelled: 'cancelled',
    };
    return { id: taskId, local_status: terminalStatus[taskId] || 'running' };
  },
  onStatus: (nodeId: string, task: any) => statuses.push({ nodeId, status: task.local_status }),
  onError: (taskId: string, _nodeId: string, errorCount: number) => errors.push({ taskId, count: errorCount }),
  isNodeAlive: (nodeId: string) => alive.has(nodeId),
  isHidden: () => hidden,
  setTimer: (callback: TimerCallback, delay: number) => {
    timerCreates += 1;
    timer = callback;
    delays.push(delay);
    return timerCreates;
  },
  clearTimer: () => { timer = null; },
  delayFor: (entry: any, isHidden: boolean) => isHidden ? 15000 : entry.taskId === 'running' ? 3000 : 5000,
});

coordinator.register('done', 'node-done');
coordinator.register('failed', 'node-failed');
coordinator.register('cancelled', 'node-cancelled');
coordinator.register('running', 'node-running');
coordinator.register('running', 'node-running');
coordinator.register('rejected', 'node-rejected');
coordinator.register('missing', 'node-missing');
assert.equal(coordinator.size(), 6, 'register is idempotent');
assert.equal(timerCreates, 1, 'all registrations share one timer');

await coordinator.runNow();
assert.deepEqual(calls.sort(), ['cancelled', 'done', 'failed', 'rejected', 'running'], 'missing nodes are removed without fetching');
assert.deepEqual(statuses.sort((a, b) => a.nodeId.localeCompare(b.nodeId)), [
  { nodeId: 'node-cancelled', status: 'cancelled' },
  { nodeId: 'node-done', status: 'succeeded' },
  { nodeId: 'node-failed', status: 'failed' },
  { nodeId: 'node-running', status: 'running' },
], 'fulfilled tasks are delivered even when another fetch rejects');
assert.deepEqual(errors, [{ taskId: 'rejected', count: 1 }], 'a rejection increments only its own entry');
assert.equal(coordinator.has('done'), false, 'terminal tasks are unregistered after delivery');
assert.equal(coordinator.has('failed'), false, 'failed tasks are unregistered after delivery');
assert.equal(coordinator.has('cancelled'), false, 'cancelled tasks are unregistered after delivery');
assert.equal(coordinator.has('missing'), false, 'missing-node tasks are unregistered');
assert.equal(coordinator.has('running'), true);
assert.equal(coordinator.has('rejected'), true);
assert.equal(delays.at(-1), 3000, 'next delay is the minimum active delay');
assert.equal(typeof timer, 'function');

hidden = true;
coordinator.register('hidden', 'node-hidden');
await coordinator.runNow();
assert.equal(delays.at(-1), 15000, 'hidden documents use the injected hidden delay');
assert.deepEqual(errors.at(-1), { taskId: 'rejected', count: 2 }, 'error counts remain isolated across cycles');

coordinator.unregister('hidden');
assert.equal(coordinator.has('hidden'), false);
coordinator.clear();
assert.equal(coordinator.size(), 0);
assert.equal(timer, null);

await staleResultSmoke();

console.log('ultimate canvas generation task coordinator smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
