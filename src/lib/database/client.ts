import { PrismaClient } from '@prisma/client';
import fs from 'node:fs/promises';
import path from 'node:path';
import { databaseTransactionFinished, databaseTransactionStarted, databaseWriterReady, observeDatabaseError } from './observations';
import { assertDatabaseWriterMode } from './process-mode';

export function databaseUrl(input: string) {
  if (!input.startsWith('file:')) return { url: input, file: undefined };
  const [name, query = ''] = input.slice(5).split('?');
  // Prisma SQLite relative paths are schema-relative, not process-relative.
  const file = path.isAbsolute(name) ? name : path.resolve(process.cwd(), 'prisma', name);
  const params = new URLSearchParams(query); params.set('connection_limit', '1');
  // Keep this one initialized connection, rather than silently expiring it in
  // the native pool. socket_timeout also applies to any engine-created handle.
  params.set('max_connection_lifetime', '0'); params.set('max_idle_connection_lifetime', '0'); params.set('socket_timeout', '10');
  return { url: `file:${file}?${params}`, file };
}
type Shared = { raw: PrismaClient; extended: PrismaClient; mode: 'cold' | 'read' | 'write'; initialization?: Promise<void>;
  writing?: Promise<void>; file?: string; sqlite: boolean };
const key = Symbol.for('video-api.database-client.v1');
const globals = globalThis as typeof globalThis & { [key]?: Shared };
function shared(): Shared {
  assertDatabaseWriterMode();
  if (globals[key]) return globals[key]!;
  if (!process.env.DATABASE_URL) throw new Error('database_url_required');
  const configured = databaseUrl(process.env.DATABASE_URL);
  const raw = new PrismaClient({ datasources: { db: { url: configured.url } }, log: [], errorFormat: 'minimal' });
  const state = { raw, mode: 'cold', file: configured.file, sqlite: Boolean(configured.file) } as Shared;
  globals[key] = state;
  state.extended = raw.$extends({ query: { async $allOperations({ args, query }) {
    await initialize(state, true);
    try { return await query(args); } catch (error) { observeDatabaseError(error); throw error; }
  } } }) as unknown as PrismaClient;
  return state;
}
async function initialize(state: Shared, write: boolean) {
  if (write && state.mode === 'write') return;
  if (write && state.writing) return state.writing;
  if (!write && state.initialization) return state.initialization;
  if (!write && state.mode !== 'cold') return;
  const prior = state.initialization;
  const run = (async () => {
    await prior;
    if (state.sqlite) {
      if (!write) {
        // Opening a missing SQLite file would create it before query_only applies.
        if (!(await fs.stat(state.file!)).isFile()) throw new Error('readonly_database_missing');
      }
      await state.raw.$queryRawUnsafe('PRAGMA busy_timeout = 10000');
      await state.raw.$queryRawUnsafe(write ? 'PRAGMA query_only = OFF' : 'PRAGMA query_only = ON');
      if (write) {
        await state.raw.$queryRawUnsafe('PRAGMA journal_mode = WAL');
        await state.raw.$queryRawUnsafe('PRAGMA synchronous = NORMAL');
      }
    }
    state.mode = write ? 'write' : 'read';
    if (write) databaseWriterReady();
  })();
  state.initialization = run;
  if (write) state.writing = run;
  try { await run; }
  catch (error) {
    state.mode = 'cold'; state.initialization = undefined; state.writing = undefined;
    observeDatabaseError(error); throw error;
  }
}
async function disconnect() {
  assertDatabaseWriterMode();
  const state = globals[key]; if (!state) return;
  await state.initialization?.catch(() => {});
  await state.raw.$disconnect();
  state.mode = 'cold'; state.initialization = undefined; state.writing = undefined;
}
export const applicationDatabase = new Proxy({} as PrismaClient, {
  get(_target, property) {
    if (property === '$disconnect') return disconnect;
    const state = shared();
    if (property === '$connect') return async () => { await initialize(state, true); };
    if (property === '$transaction') return async (...args: Parameters<PrismaClient['$transaction']>) => {
      // Initialization must complete before BEGIN, including array transactions.
      await initialize(state, true);
      databaseTransactionStarted(); const started = performance.now();
      try {
        const transaction = state.extended.$transaction as unknown as (...values: unknown[]) => Promise<unknown>;
        return await transaction.apply(state.extended, args);
      }
      catch (error) { observeDatabaseError(error); throw error; }
      finally { databaseTransactionFinished(performance.now() - started); }
    };
    const value = Reflect.get(state.extended, property);
    return typeof value === 'function' ? value.bind(state.extended) : value;
  },
});
const readOperations = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy']);
export type ReadonlyDatabase = { [K in keyof PrismaClient as K extends `$${string}` ? never : K]: {
  [M in keyof PrismaClient[K]]: M extends 'findMany' | 'findFirst' | 'findFirstOrThrow' | 'findUnique' | 'findUniqueOrThrow' | 'count' | 'aggregate' | 'groupBy' ? PrismaClient[K][M] : never
} } & { $disconnect: () => Promise<void> };
export const readonlyDatabase = new Proxy({} as ReadonlyDatabase, {
  get(_target, property) {
    if (property === '$disconnect') return disconnect;
    if (typeof property !== 'string' || !/^[a-z][a-zA-Z0-9]*$/.test(property)) throw new Error('hd_readonly_query_required');
    return new Proxy({}, { get(_delegate, operation) {
      if (typeof operation !== 'string' || !readOperations.has(operation)) throw new Error('hd_readonly_query_required');
      return async (...args: unknown[]) => {
        const state = shared(); await initialize(state, false);
        const delegate = Reflect.get(state.raw, property);
        if (!delegate || typeof delegate[operation] !== 'function') throw new Error('hd_readonly_query_required');
        try { return await delegate[operation](...args); }
        catch (error) { observeDatabaseError(error); throw error; }
      };
    } });
  },
});
export function databaseClientState() {
  const state = globals[key];
  return { clientsConstructed: state ? 1 : 0, mode: state?.mode || 'cold', sqliteConnectionLimit: state?.sqlite ? 1 : null };
}
