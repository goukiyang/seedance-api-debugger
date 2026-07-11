import assert from 'node:assert/strict';

const { createGenerationTaskCoordinator } = require('../public/tools/ultimate-canvas/generation-task-coordinator.js');

type TimerCallback = () => void;

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

console.log('ultimate canvas generation task coordinator smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
