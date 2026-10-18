import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { traceFixture } from './image-trace-engineering-fixture';

async function main() {
  assert.equal(Reflect.get(globalThis, Symbol.for('image-engineering-package-view')), undefined,
    'Guard admission must run against the actual package, without an ordinary test view');
  const checks = ['actual_guard_package_rejects_new_queue_admission', 'guard_requires_env_and_shared_drain_and_only_recovers_accepted'];
  const fixture = await traceFixture({ file: 'scripts/image-guard-admission-engineering.ts',
    schema: 'image-guard-admission-engineering.v1', marker: 'Image guard admission engineering receipt: ', checks,
    sources: ['scripts/image-trace-engineering-fixture.ts', 'src/lib/image-studio/queue-capacity.ts', 'src/lib/image-studio/worker-mode.ts'] });
  const actualVersion = JSON.parse(readFileSync(path.join(fixture.root, 'package.json'), 'utf8')).version;
  assert.match(actualVersion, /\+trace03-guard\.\d+$/);
  const queue = await import('../src/lib/image-studio/queue-capacity');
  assert.equal(queue.imageStudioAcceptedOnlyMode(), true);
  await assert.rejects(fixture.db.$transaction(tx => queue.reserveImageStudioQueueCapacity(tx, 'synthetic-owner', 1)), queue.QueueMaintenanceError);
  assert.equal(await fixture.db.imageStudioTask.count(), 0); assert.equal(await fixture.db.creditLedger.count(), 0);
  fixture.check(checks[0]);
  const modes = await import('../src/lib/image-studio/worker-mode');
  assert.throws(() => modes.assertStudioWorkerMode({ version: actualVersion, acceptedOnlyEnv: '0', draining: true }));
  assert.throws(() => modes.assertStudioWorkerMode({ version: actualVersion, acceptedOnlyEnv: '1', draining: false }));
  const mode = modes.assertStudioWorkerMode({ version: actualVersion, acceptedOnlyEnv: '1', draining: true });
  const calls: string[] = [];
  await modes.runStudioWorkerCycle({ ...mode, draining: () => true, stopping: () => false,
    recover: async options => { assert.equal(options.acceptedOnly, true); calls.push('recover-accepted'); },
    dispatchBatches: async () => { calls.push('new-batch'); }, dispatchToolflows: async () => { calls.push('new-toolflow'); },
    processQueued: async () => { calls.push('new-queue'); } });
  assert.deepEqual(calls, ['recover-accepted']); fixture.check(checks[1]);
  await fixture.finish({ actualGuardVersion: actualVersion, packageView: 'actual-guard-without-preload' });
}
main().catch(error => { console.error(error); process.exit(1); });
