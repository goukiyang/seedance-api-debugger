import './server-runtime.cjs';
import { loadEnvConfig } from '@next/env';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { WorkMediaScheduler } from './works-consumer-scheduler';
import type { MultiviewWorksRuntime } from '../src/lib/video/multiview-works-runtime';

loadEnvConfig(process.cwd());

const lockedFlag = '--multiview-worker-lock-held';
let stopping = false;
const finishWaits = new Set<() => void>();
let runtimeStopping: (() => void) | null = null;
function requestStop() { stopping = true; finishWaits.forEach(finish => finish()); runtimeStopping?.(); }
process.on('SIGTERM', requestStop);
process.on('SIGINT', requestStop);

async function launchLocked(lockPath: string) {
  const entry = await lstat(lockPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)) throw new Error('multiview_consumer_lock_path_invalid');
  const lock = await open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const opened = await lock.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== process.geteuid?.()
      || entry && (entry.dev !== opened.dev || entry.ino !== opened.ino)) throw new Error('multiview_consumer_lock_identity_invalid');
    await lock.chmod(0o600);
    const exitCode = await new Promise<number>((resolve, reject) => {
      // --no-fork preserves the flock owner's PID across exec into the actual Node consumer.
      const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '--no-fork', '--conflict-exit-code', '75', '/proc/self/fd/3',
        process.execPath, ...process.execArgv, ...process.argv.slice(1), lockedFlag], { stdio: ['inherit', 'inherit', 'inherit', lock.fd] });
      const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
      process.on('SIGTERM', stop); process.on('SIGINT', stop);
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        process.off('SIGTERM', stop); process.off('SIGINT', stop);
        resolve(code ?? (signal ? 1 : 0));
      });
      if (stopping) stop();
    });
    if (exitCode === 75) console.log('[multiview-works] another consumer owns the global lock');
    process.exitCode = exitCode;
  } finally { await lock.close(); }
}
async function waitForNextScan() {
  if (stopping) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, 15000);
    function done() { clearTimeout(timer); finishWaits.delete(done); resolve(); }
    finishWaits.add(done);
    if (stopping) done();
  });
}
async function main() {
  if (process.platform !== 'linux') throw new Error('multiview_consumer_requires_linux_proc_locks_and_system_flock');
  const { multiviewWorkLockPath, assertMultiviewWorkConsumerLock, processNextMultiviewWork } = await import('../src/lib/video/multiview-work-render');
  const { prisma } = await import('../src/lib/prisma');
  let runtime: MultiviewWorksRuntime | null = null;
  try {
    const lockPath = await multiviewWorkLockPath();
    if (!process.argv.includes(lockedFlag)) { await launchLocked(lockPath); return; }
    await assertMultiviewWorkConsumerLock(lockPath);
    const { processNextWorkPreview } = await import('../src/lib/works/previews');
    const { startMultiviewWorksRuntime } = await import('../src/lib/video/multiview-works-runtime');
    runtime = await startMultiviewWorksRuntime({ lockPath,
      ...(process.env.NODE_ENV === 'production' ? {} : { fixtureRoot: path.join(path.dirname(lockPath), 'multiview-works') }),
      onFailure: () => { process.exitCode = 1; requestStop(); },
    });
    runtimeStopping = () => runtime?.markStopping();
    if (stopping) runtime.markStopping();
    const once = process.argv.includes('--once');
    const media = new WorkMediaScheduler();
    const currentRuntime = runtime;
    const consume = async (name: 'multiview-works' | 'works-preview', next: () => Promise<{ state: string }>) => {
      let lastMessage = '';
      while (!stopping) {
        try {
          currentRuntime.assertHealthy();
          const result = await next();
          currentRuntime.assertHealthy();
          const message = JSON.stringify(result);
          if (result.state !== 'empty' || message !== lastMessage) console.log(`[${name}]`, message);
          lastMessage = message;
          if (once) break;
          if (!['empty', 'paused', 'deferred', 'yielded', 'poster-pass'].includes(result.state)) continue;
        } catch {
          // No user content, source URLs or environment values enter the service log.
          if (lastMessage !== 'deferred') console.warn(`[${name}] preparation deferred; existing outputs retained`);
          lastMessage = 'deferred';
          if (once) { process.exitCode = 1; break; }
        }
        await waitForNextScan();
      }
    };
    await Promise.all([
      consume('multiview-works', async () => {
        const slot: { release: (() => void) | null } = { release: null };
        try {
          return await processNextMultiviewWork({ beforePrepare: async () => {
            // Empty scans do not interrupt a video. The selected output owns priority.
            if (!slot.release) slot.release = await media.acquireMultiview();
            currentRuntime.assertHealthy();
          } });
        } finally { slot.release?.(); }
      }),
      consume('works-preview', () => media.preview(signal => processNextWorkPreview({ signal }))),
    ]);
  } finally {
    runtimeStopping = null;
    try {
      if (runtime) {
        runtime.markStopping();
        await runtime.stop();
        console.log('[multiview-works] stopped after completing current work');
      }
    } finally { await prisma.$disconnect(); }
  }
}
main().catch(() => {
  console.error('[multiview-works] consumer could not start; Linux flock, private storage and runtime dependencies are required');
  process.exitCode = 1;
});
