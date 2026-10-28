import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';

const key = Symbol.for('video-api.database-client.v1');
type State = { raw: PrismaClient; extended: PrismaClient; file?: string; sqlite: boolean; mode: string };
export function assertFreshFixtureFactory() {
  assert.equal(Reflect.get(globalThis, key), undefined, 'Fixture factory must start cold in a fresh process');
  assert.equal(Reflect.get(globalThis, 'prisma'), undefined, 'Fixture factory cannot use the retired global injection');
}
export function wrapFixtureTransactions<T extends object>(target: T, before: () => Promise<void>): T {
  const original: unknown = Reflect.get(target, '$transaction', target);
  assert.ok(typeof original === 'function');
  return new Proxy(target, { get(current, property) {
    if (property === '$transaction') return async (...args: unknown[]) => {
      await before(); return Reflect.apply(original, current, args);
    };
    return Reflect.get(current, property, current);
  } });
}

/** Test-only observations on the actual singleton, never a fabricated Shared. */
export async function openRealFixtureDatabase(file: string) {
  assert.equal(process.env.NODE_ENV, 'test');
  assertFreshFixtureFactory();
  const expected = realpathSync(file);
  assert.equal(path.resolve(file), expected, 'Fixture database must not be a symlink');
  assert.equal(process.env.DATABASE_URL, `file:${expected}`, 'Only the newly created fixture database may be opened');
  const { prisma } = await import('../../src/lib/prisma');
  const { databaseClientState } = await import('../../src/lib/database/client');
  await prisma.$connect();
  const state = Reflect.get(globalThis, key) as State;
  assert.ok(state && state.raw && state.extended);
  const raw = state.raw, originalExtended = state.extended;
  let expectedExtended = originalExtended;
  const verify = async (facade: PrismaClient = prisma, observed: unknown = expectedExtended) => {
    assert.equal(facade, prisma); assert.equal(observed, expectedExtended);
    assert.equal(Reflect.get(globalThis, key), state);
    assert.equal(state.raw, raw); assert.equal(state.extended, expectedExtended);
    assert.notEqual(prisma, raw, 'The public facade is intentionally not the raw client');
    assert.equal(state.sqlite, true); assert.equal(state.file, expected); assert.equal(state.mode, 'write');
    const summary = databaseClientState();
    assert.equal(summary.clientsConstructed, 1); assert.equal(summary.sqliteConnectionLimit, 1);
    for (const client of [prisma, raw]) {
      const databases = await client.$queryRawUnsafe<Array<{ name: string; file: string }>>('PRAGMA database_list');
      const main = databases.filter(row => row.name === 'main'); assert.equal(main.length, 1);
      assert.equal(realpathSync(main[0].file), expected, 'Facade and raw queries must reach the same actual SQLite file');
    }
    const timeout = await prisma.$queryRawUnsafe<Array<{ timeout: bigint }>>('PRAGMA busy_timeout');
    assert.equal(Number(timeout[0].timeout), 10000);
  };
  await verify();
  return {
    raw,
    observe<T extends object>(build: (base: PrismaClient) => T): T {
      assert.equal(state.extended, expectedExtended);
      const observed = build(expectedExtended);
      assert.ok(observed && typeof Reflect.get(observed, '$queryRawUnsafe') === 'function');
      state.extended = observed as unknown as PrismaClient; expectedExtended = state.extended;
      return observed;
    },
    verify,
    interceptTransactions(before: () => Promise<void>) {
      assert.equal(state.extended, expectedExtended);
      const previous = expectedExtended, layer = wrapFixtureTransactions(previous, before);
      state.extended = layer; expectedExtended = layer;
      let restored = false;
      return () => {
        if (restored) return;
        assert.equal(state.extended, layer, 'Fixture transaction observations must restore in order');
        state.extended = previous; expectedExtended = previous; restored = true;
      };
    },
    async close() {
      assert.equal(state.extended, expectedExtended);
      state.extended = originalExtended; expectedExtended = originalExtended;
      await prisma.$disconnect();
    },
  };
}
