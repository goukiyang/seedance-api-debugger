import { loadEnvConfig } from '@next/env';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import type { MultiviewWorksRuntime } from '../src/lib/video/multiview-works-runtime';

loadEnvConfig(process.cwd());

const lockedFlag = '--multiview-worker-lock-held';
let stopping = false;
let finishWait: (() => void) | null = null;
let runtimeStopping: (() => void) | null = null;
function requestStop() { stopping = true; finishWait?.(); runtimeStopping?.(); }
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
    function done() { clearTimeout(timer); finishWait = null; resolve(); }
    finishWait = done;
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
    const { startMultiviewWorksRuntime } = await import('../src/lib/video/multiview-works-runtime');
    runtime = await startMultiviewWorksRuntime({ lockPath,
      ...(process.env.NODE_ENV === 'production' ? {} : { fixtureRoot: path.join(path.dirname(lockPath), 'multiview-works') }),
      onFailure: () => { process.exitCode = 1; requestStop(); },
    });
    runtimeStopping = () => runtime?.markStopping();
    if (stopping) runtime.markStopping();
    const once = process.argv.includes('--once');
    let lastMessage = '';
    while (!stopping) {
      try {
        runtime.assertHealthy();
        const result = await processNextMultiviewWork();
        runtime.assertHealthy();
        const message = JSON.stringify(result);
        if (result.state !== 'empty' || message !== lastMessage) console.log('[multiview-works]', message);
        lastMessage = message;
        if (once) break;
        if (result.state !== 'empty') continue;
      } catch {
        // No user content, source URLs or environment values are included in the service log.
        if (lastMessage !== 'deferred') console.warn('[multiview-works] preparation deferred; recipe and existing output retained');
        lastMessage = 'deferred';
        if (once) { process.exitCode = 1; break; }
      }
      await waitForNextScan();
    }
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
