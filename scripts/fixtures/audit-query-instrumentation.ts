import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';

type SharedClient = { raw: PrismaClient; extended: PrismaClient; mode: string };

// Extended Prisma clients hide $use. Initialize through the application facade,
// then observe its existing raw client without changing any query execution path.
export async function instrumentDatabaseQueries(
  prisma: Pick<PrismaClient, '$connect'>,
  middleware: Parameters<PrismaClient['$use']>[0],
) {
  await prisma.$connect();
  const key = Symbol.for('video-api.database-client.v1');
  const state = (globalThis as typeof globalThis & { [key]?: SharedClient })[key];
  assert(state, 'Existing application database registry required for query instrumentation');
  assert.equal(state.mode, 'write', 'Application database initialization must finish before instrumentation');
  assert(state.raw && state.extended && state.raw !== state.extended, 'Expected one raw client and its extension');
  assert.equal(typeof state.raw.$use, 'function', 'Existing raw Prisma client does not support query middleware');
  state.raw.$use(middleware);
}
