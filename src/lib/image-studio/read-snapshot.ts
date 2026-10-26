import type { Prisma } from '@prisma/client';
import { prisma, retrySqliteBusy } from '@/lib/prisma';

type ReadQueue = { tail: Promise<void>; pending: number };
const processState = globalThis as typeof globalThis & { studioSharedReadQueue?: ReadQueue };
const queue = processState.studioSharedReadQueue ??= { tail: Promise.resolve(), pending: 0 };

function busyError() {
  const error = new Error('Shared studio read capacity exceeded');
  error.name = 'StudioSharedReadBusyError';
  return error;
}

// Prisma's SQLite transactions use BEGIN IMMEDIATE even for reads. Queue these
// snapshots before entering the engine so waiting readers cannot block its lock holder.
export function readSharedStudioSnapshot<T>(read: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if (queue.pending >= 32) return Promise.reject(busyError());
  const requestedAt = Date.now();
  queue.pending++;
  const result = queue.tail.then(() => {
    if (Date.now() - requestedAt > 5000) throw busyError();
    return retrySqliteBusy(() => prisma.$transaction(read, { timeout: 15000 }));
  });
  queue.tail = result.then(() => { queue.pending--; }, () => { queue.pending--; });
  return result;
}
