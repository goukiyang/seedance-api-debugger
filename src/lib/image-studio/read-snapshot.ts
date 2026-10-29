import type { Prisma } from '@prisma/client';
import { prisma, retrySqliteBusy } from '@/lib/prisma';

type ReadQueue = { tail: Promise<void>; pending: number; active?: {
  operation: string; requestedAt: number; startedAt: number; enteredAt: number | null;
} | null };
const processState = globalThis as typeof globalThis & { studioSharedReadQueue?: ReadQueue };
const queue = processState.studioSharedReadQueue ??= { tail: Promise.resolve(), pending: 0 };

// Only this process and these shared reads are observed; an absent holder is
// not proof that another connection or worker is idle.
export function sharedStudioReadDiagnostics() {
  const now = Date.now(), active = queue.active;
  return { scope: 'process-shared-studio-reads', pending: queue.pending,
    active: active ? { operation: active.operation, phase: active.enteredAt === null ? 'transaction_wait' : 'transaction_body',
      queuedMs: active.startedAt - active.requestedAt, elapsedMs: now - active.startedAt,
      heldMs: active.enteredAt === null ? null : now - active.enteredAt } : null };
}

function busyError() {
  const error = new Error('Shared studio read capacity exceeded');
  error.name = 'StudioSharedReadBusyError';
  return error;
}

// Prisma's SQLite transactions use BEGIN IMMEDIATE even for reads. Queue these
// snapshots before entering the engine so waiting readers cannot block its lock holder.
export function readSharedStudioSnapshot<T>(read: (tx: Prisma.TransactionClient) => Promise<T>,
  operation: 'snapshot' | 'definition' | 'modules' | 'open-status' | 'catalog' | 'revision' | 'gallery'
    | 'deletion-status' | 'sharing-status' | 'lifecycle-history' = 'snapshot'): Promise<T> {
  if (queue.pending >= 32) return Promise.reject(busyError());
  const requestedAt = Date.now();
  queue.pending++;
  const result = queue.tail.then(async () => {
    const startedAt = Date.now();
    if (startedAt - requestedAt > 5000) throw busyError();
    let attempt = 0;
    return retrySqliteBusy(async () => {
      const trace = { operation, requestedAt, startedAt: Date.now(), enteredAt: null as number | null };
      queue.active = trace;
      let code: string | null = null;
      try {
        return await prisma.$transaction(tx => { trace.enteredAt = Date.now(); return read(tx); }, { timeout: 15000 });
      } catch (error) {
        const value = (error as { code?: unknown } | null)?.code;
        code = typeof value === 'string' && /^P\d{4}$/.test(value) ? value : 'READ_FAILED';
        throw error;
      } finally {
        if (code || Date.now() - requestedAt >= 500) console.info('[StudioSharedRead]', JSON.stringify({
          pid: process.pid, role: process.env.PROCESS_ROLE || 'web', at: Date.now(), attempt: ++attempt,
          operation, elapsedMs: Date.now() - requestedAt, ...sharedStudioReadDiagnostics(), code,
        }));
        if (queue.active === trace) queue.active = null;
      }
    });
  });
  queue.tail = result.then(() => { queue.pending--; }, () => { queue.pending--; });
  return result;
}
