import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, type PrismaClient } from '@prisma/client';
import { observeTransaction } from './performance/request-trace';

const marker = Symbol.for('sd2.sqlite-client.v1');
const stateKey = Symbol.for('sd2.sqlite-client-state.v1');
const processState = globalThis as typeof globalThis & {
  sd2SqliteTransactionQueue?: { tail: Promise<void> };
  [stateKey]?: { clients: WeakSet<object>; initializing: AsyncLocalStorage<object> };
};
const state = processState[stateKey] ??= { clients: new WeakSet(), initializing: new AsyncLocalStorage<object>() };
const writes = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'executeRaw', 'queryRaw']);

/** Shared engine admission, independent of catalog invalidation and client logging policy. */
export function sqliteClient<T extends PrismaClient>(client: T, configuration: { synchronous?: 'NORMAL' | 'FULL' } = {}): T {
  const initialized: unknown = Reflect.get(client, marker);
  if (state.clients.has(client) || initialized === true) return client;
  state.clients.add(client);
  const sqlite = process.env.DATABASE_URL?.startsWith('file:');
  const queue = processState.sd2SqliteTransactionQueue ??= { tail: Promise.resolve() };
  function schedule<R>(run: () => Promise<R>, maxWait?: number): Promise<R> {
    if (!sqlite) return run();
    let expired: Error | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const pending = queue.tail.then(() => {
      if (expired) throw expired;
      if (timer) clearTimeout(timer);
      return run();
    });
    queue.tail = pending.then(() => {}, () => {});
    if (maxWait === undefined) return pending;
    const waiting = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = new Prisma.PrismaClientKnownRequestError('Transaction API error: Unable to start a transaction in the given time.',
          { code: 'P2028', clientVersion: Prisma.prismaVersion.client });
        reject(expired);
      }, maxWait);
    });
    return Promise.race([pending, waiting]).finally(() => { if (timer) clearTimeout(timer); });
  }
  const nativeTransaction = client.$transaction;
  const nativeQuery = client.$queryRawUnsafe.bind(client);
  // Each actual client owns this promise. Module copies sharing a singleton do
  // not skip a second client's connection-local busy_timeout/synchronous setup.
  const ready = sqlite ? schedule(() => state.initializing.run(client, async () => {
    await nativeQuery('PRAGMA busy_timeout = 10000');
    await nativeQuery('PRAGMA journal_mode = WAL');
    await nativeQuery(configuration.synchronous === 'FULL' ? 'PRAGMA synchronous = FULL' : 'PRAGMA synchronous = NORMAL');
  })) : Promise.resolve();
  // Retain the rejection for callers, without printing SQLite/Prisma messages
  // that may contain user-provided values on privacy-sensitive clients.
  void ready.catch(() => { console.warn('[Prisma] sqlite_initialization_failed'); });
  client.$use(async (params, next) => {
    if (state.initializing.getStore() === client) return next(params);
    await ready;
    if (params.runInTransaction || !writes.has(params.action)) return next(params);
    return observeTransaction('implicit', enter => schedule(() => enter(() => next(params))));
  });
  Reflect.set(client, '$transaction', function (this: object, input: unknown, options?: unknown) {
    const call = (enter: <R>(body: () => Promise<R>) => Promise<R>) => {
      const callback = typeof input === 'function'
        ? (tx: Prisma.TransactionClient) => enter(() => input(tx)) : input;
      return schedule(async () => {
        await ready;
        return Reflect.apply(nativeTransaction, this, [callback, options]);
      },
        typeof input === 'function' ? (options as { maxWait?: number } | undefined)?.maxWait ?? 2000 : undefined);
    };
    return observeTransaction(typeof input === 'function' ? 'callback' : 'batch', call);
  });
  Reflect.set(client, marker, true);
  return client;
}
