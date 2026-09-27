import { prisma } from '@/lib/prisma';
import { runAnimationWorker } from '@/lib/animation/jobs';

const args = process.argv.slice(2);
const once = args.includes('--once');
if (args.some((arg) => arg !== '--once')) {
  process.stderr.write('Usage: tsx scripts/process-animation-jobs.ts [--once]\n');
  process.exitCode = 2;
} else {
  const shutdown = new AbortController();
  let workerController: AbortController | null = null;
  let stopping = false;
  const requestStop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`Animation worker received ${signal}; stopping claims and aborting active work.\n`);
    shutdown.abort(new Error(signal));
    workerController?.abort(new Error(signal));
  };
  process.once('SIGTERM', () => requestStop('SIGTERM'));
  process.once('SIGINT', () => requestStop('SIGINT'));

  void runAnimationWorker({
    once,
    signal: shutdown.signal,
    onActiveController: (controller) => { workerController = controller; },
  }).catch((error: unknown) => {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code.replace(/[^A-Z0-9_]/g, '').slice(0, 48)
      : 'WORKER_FAILED';
    process.stderr.write(`Animation worker stopped (${code || 'WORKER_FAILED'}).\n`);
    process.exitCode = error instanceof Error && 'status' in error && error.status === 409 ? 0 : 1;
  }).finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
}
