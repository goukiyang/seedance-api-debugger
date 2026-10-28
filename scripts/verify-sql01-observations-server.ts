import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// A new directory per run. Never accept an existing database or load .env files.
async function main() {
  const root = fs.realpathSync(process.cwd()), run = process.env.SQL01_FIXTURE_RUN_ID || '';
  assert.match(run, /^[a-zA-Z0-9_-]{1,80}$/);
  const parent = path.join(root, '.role-tests');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  assert.equal(fs.realpathSync(parent), parent);
  const directory = path.join(parent, `sql01-native-${run}`);
  assert(!fs.existsSync(directory), 'Use a new run ID; old database/evidence must remain intact');
  fs.mkdirSync(directory, { mode: 0o700 });
  const databaseUrl = `file:${directory}/synthetic.db`;
  assert(!process.env.DATABASE_URL || process.env.DATABASE_URL === databaseUrl, 'Do not inherit any other database configuration');
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: databaseUrl, SD2_DATABASE_MODE: 'writer' });
  assert(!Reflect.get(globalThis, Symbol.for('video-api.database-client.v1')), 'Run in a fresh process, never an existing application process');
  globalThis.fetch = async () => { throw new Error('Real transport prohibited in SQL01 native fixture'); };
  const { applicationDatabase: prisma, databaseClientState } = await import('../src/lib/database/client');
  const { withDatabaseObservationScope, databaseObservations } = await import('../src/lib/database/observations');
  let nativeCode = '';
  try {
    const result = await withDatabaseObservationScope('image-studio.shared', () => prisma.$transaction(async tx => {
      return tx.$queryRawUnsafe('SELECT 1 AS synthetic_value');
    }));
    assert.equal((result as Array<{ synthetic_value: bigint | number }>)[0].synthetic_value.toString(), '1');
    await assert.rejects(withDatabaseObservationScope('video-task.create', () => prisma.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT 1');
      await new Promise(resolve => setTimeout(resolve, 250));
      return tx.$queryRawUnsafe('SELECT 1');
    }, { timeout: 50 })), error => {
      nativeCode = (error as { code?: string }).code || ''; return nativeCode === 'P2028';
    });
    const snapshot = databaseObservations(), rows = snapshot.minutes;
    assert.equal(rows.reduce((total, row) => total + row.transactions, 0), 2);
    assert.equal(rows.reduce((total, row) => total + (row.succeeded || 0), 0), 1);
    assert.equal(rows.reduce((total, row) => total + (row.failed || 0), 0), 1);
    assert(rows.some(row => row.p2028 && row.dimensions.some(item => item.scope === 'video-task.create' && item.failed === 1)));
    assert.equal(snapshot.heldLockTimeMeasured, false);
    assert.equal(databaseClientState().clientsConstructed, 1); assert.equal(databaseClientState().sqliteConnectionLimit, 1);
    fs.writeFileSync(path.join(directory, 'observations.json'), JSON.stringify({ syntheticOnly: true, databaseUrl,
      nativeCode, scope: 'single-process call wall duration and real interactive transaction timeout; not held-lock timing or site aggregation',
      snapshot, client: databaseClientState(), realNetworkCalls: 0 }, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(path.join(directory, 'observations.json'));
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
