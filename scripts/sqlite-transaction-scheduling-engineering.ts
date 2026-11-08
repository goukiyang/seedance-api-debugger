import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { PrismaClient } from '@prisma/client';
import * as trace from '../src/lib/performance/request-trace';

const root = realpathSync(process.cwd()), require = createRequire(import.meta.url);
const sources = ['src/lib/catalog-directory-writes.ts', 'src/lib/image-studio/catalog-revision.ts',
  'src/lib/performance/request-trace.ts', 'src/lib/performance/trace-contract.ts'];
const sha = (file: string) => createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex');
process.exitCode = 1;
async function main() {
  const startedAt = new Date().toISOString(), runId = process.env.IMAGE_RECOVERY_GATE_RUN_ID || randomUUID();
  const scratch = path.join(root, '.role-tests'); mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'sqlite-transactions-'));
  // Match the production Works consumer's one-CPU quota before starting the real engine.
  process.env.TOKIO_WORKER_THREADS = '1';
  const databaseUrl = `file:${directory}/synthetic.db`;
  process.env.DATABASE_URL = databaseUrl;
  const { PrismaClient, Prisma } = await import('@prisma/client');
  let forbiddenCalls = 0;
  function evaluate(file: string, imports: Record<string, unknown>): Record<string, any> {
    const module = { exports: {} };
    const compiled = ts.transpileModule(readFileSync(path.join(root, file), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    new Function('require', 'module', 'exports', compiled)((name: string) => {
      if (name in imports) return imports[name];
      if (['node:async_hooks', 'node:crypto'].includes(name)) return require(name);
      forbiddenCalls++; throw new Error(`Fixture import forbidden: ${name}`);
    }, module, module.exports);
    return module.exports;
  }
  const revision = evaluate('src/lib/image-studio/catalog-revision.ts', { '@/lib/pricing/runtime': {
    assertPricingImageConsumerReady() { forbiddenCalls++; throw new Error('Fixture cannot read production readiness'); },
  } });
  const wrap = evaluate('src/lib/catalog-directory-writes.ts', {
    '@prisma/client': { Prisma }, './image-studio/catalog-revision': revision, './performance/request-trace': trace,
  }).catalogDirectoryWrites as (client: PrismaClient) => PrismaClient;
  const raw = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [],
    __internal: { configOverride: (config: Record<string, unknown>) => ({ ...config, relativeEnvPaths: { rootEnvPath: '', schemaEnvPath: '' } }) },
  } as ConstructorParameters<typeof PrismaClient>[0]);
  const db = wrap(raw), checks: string[] = [], metrics: Record<string, number> = {};
  assert.equal(wrap(raw), db); assert.equal(wrap(db), db);
  try {
    await raw.$queryRawUnsafe('PRAGMA journal_mode=WAL');
    await raw.$queryRawUnsafe('PRAGMA busy_timeout=10000');
    await raw.$executeRawUnsafe('CREATE TABLE Probe (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)');
    await raw.$executeRawUnsafe('INSERT INTO Probe VALUES (1,0)');
    await raw.$executeRawUnsafe('CREATE TABLE PlatformSetting (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, value_json TEXT NOT NULL, updated_by TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    const value = async () => Number((await raw.$queryRawUnsafe<Array<{ value: number }>>('SELECT value FROM Probe WHERE id=1'))[0].value);
    async function overlap(name: string, next: () => Promise<unknown>) {
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const started = performance.now();
      const first = db.$transaction(async tx => {
        await tx.$executeRawUnsafe('UPDATE Probe SET value=value+1 WHERE id=1'); entered();
        await barrier; await tx.$queryRawUnsafe('SELECT 1');
      }, { maxWait: 15000, timeout: 15000 });
      await ready;
      const second = next();
      // Controlled overlap reproduces the two normal consumer claims; this is not a page wait.
      const timer = setTimeout(release, 50);
      const results = await Promise.allSettled([first, second]); clearTimeout(timer);
      metrics[name] = performance.now() - started;
      assert.ok(results.every(result => result.status === 'fulfilled'), `${name}: a competing transaction blocked the lock holder: ${JSON.stringify(results)}`);
      assert.ok(metrics[name] < 1500, `${name}: synchronous engine lock wait remains (${metrics[name]}ms)`);
    }
    await overlap('callbackMs', () => db.$transaction(tx => tx.$executeRawUnsafe('UPDATE Probe SET value=value+1 WHERE id=1')));
    assert.equal(await value(), 2); checks.push('single_worker_callbacks_do_not_block_commit');
    await overlap('batchMs', () => db.$transaction([db.$executeRawUnsafe('UPDATE Probe SET value=value+1 WHERE id=1')]));
    assert.equal(await value(), 4); checks.push('batch_transactions_share_the_same_entry_queue');
    await overlap('implicitMs', () => db.platformSetting.upsert({ where: { key: 'studio_style_group_v1:fixture' },
      create: { key: 'studio_style_group_v1:fixture', value_json: '{}' }, update: { value_json: '{}' } }));
    assert.equal(await value(), 5);
    const markers = await db.platformSetting.findMany({ where: { key: { startsWith: 'catalog_directory_revision_v1:' } } });
    assert.equal(markers.length, 2); checks.push('implicit_directory_write_keeps_atomic_markers');
    await overlap('rawWriteMs', () => db.$executeRawUnsafe('UPDATE Probe SET value=value+1 WHERE id=1'));
    assert.equal(await value(), 7); checks.push('bare_sql_write_does_not_starve_transaction_commit');
    const savedMarkers = await db.platformSetting.findMany({ where: { key: { startsWith: 'catalog_directory_revision_v1:' } }, orderBy: { key: 'asc' } });
    await overlap('plainWriteMs', () => db.platformSetting.upsert({ where: { key: 'ordinary-fixture-setting' },
      create: { key: 'ordinary-fixture-setting', value_json: '{}' }, update: { value_json: '{}' } }));
    assert.equal(await value(), 8);
    assert.deepEqual(await db.platformSetting.findMany({ where: { key: { startsWith: 'catalog_directory_revision_v1:' } }, orderBy: { key: 'asc' } }), savedMarkers);
    checks.push('non_catalog_write_is_scheduled_without_new_markers');
    const before = await value(), beforeMarkers = await db.platformSetting.findMany({ orderBy: { key: 'asc' } });
    await assert.rejects(db.$transaction(async tx => {
      await tx.$executeRawUnsafe('UPDATE Probe SET value=value+100 WHERE id=1');
      await tx.platformSetting.update({ where: { key: 'studio_style_group_v1:fixture' }, data: { value_json: '{"rollback":true}' } });
      throw new Error('synthetic rollback');
    }), /synthetic rollback/);
    assert.equal(await value(), before); assert.deepEqual(await db.platformSetting.findMany({ orderBy: { key: 'asc' } }), beforeMarkers);
    await db.$transaction(tx => tx.$executeRawUnsafe('UPDATE Probe SET value=value+1 WHERE id=1'));
    assert.equal(await value(), before + 1); checks.push('rollback_preserves_data_and_releases_queue');
    let extensionReads = 0;
    const extended = db.$extends({ query: { async $allOperations({ args, query }) { extensionReads++; return query(args); } } });
    const beforeExtension = await value();
    await extended.$transaction(tx => tx.$executeRawUnsafe('UPDATE Probe SET value=value+1 WHERE id=1'));
    assert.ok(extensionReads > 0, 'Callback keeps its query extension');
    const callbackReads = extensionReads;
    await extended.$transaction([extended.$executeRawUnsafe('UPDATE Probe SET value=value+1 WHERE id=1')]);
    assert.ok(extensionReads > callbackReads, 'Batch keeps its query extension');
    await extended.platformSetting.upsert({ where: { key: 'ordinary-extension-fixture' },
      create: { key: 'ordinary-extension-fixture', value_json: '{}' }, update: { value_json: '{}' } });
    assert.equal(await value(), beforeExtension + 2); assert.ok(extensionReads > 0);
    const capturedTransaction = db.$transaction.bind(db); let instrumentedCalls = 0;
    Reflect.set(db, '$transaction', async (...args: unknown[]) => {
      instrumentedCalls++;
      await db.platformSetting.update({ where: { key: 'studio_style_group_v1:fixture' }, data: { value_json: '{"beforeTransaction":true}' } });
      return Reflect.apply(capturedTransaction, db, args);
    });
    try { await db.$transaction(async tx => {
      assert.equal((await tx.platformSetting.findUniqueOrThrow({ where: { key: 'studio_style_group_v1:fixture' } })).value_json, '{"beforeTransaction":true}');
      await tx.$executeRawUnsafe('UPDATE Probe SET value=value+1 WHERE id=1');
    }); }
    finally { Reflect.set(db, '$transaction', capturedTransaction); }
    assert.equal(instrumentedCalls, 1);
    await db.$transaction(tx => tx.$executeRawUnsafe('UPDATE Probe SET value=value+1 WHERE id=1'));
    await db.$transaction([db.$executeRawUnsafe('UPDATE Probe SET value=value+1 WHERE id=1')]);
    assert.equal(await value(), beforeExtension + 5);
    checks.push('extended_and_instrumented_clients_enter_transaction_queue_only_once');
    let entered!: () => void, release!: () => void, lateCallback = false;
    const ready = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    const holding = db.$transaction(async tx => { await tx.$queryRawUnsafe('SELECT 1'); entered(); await barrier; });
    await ready;
    const expired = db.$transaction(async () => { lateCallback = true; }, { maxWait: 20 });
    const timer = setTimeout(release, 100);
    await assert.rejects(expired, error => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2028');
    await holding; clearTimeout(timer);
    await db.$transaction(tx => tx.$queryRawUnsafe('SELECT 1'));
    assert.equal(lateCallback, false); checks.push('expired_wait_never_executes_late_callback');
    assert.equal(forbiddenCalls, 0);
    const receipt = path.join(directory, 'receipt.json');
    writeFileSync(receipt, JSON.stringify({ schema: 'sqlite-transaction-scheduling-engineering.v1', synthetic: true, runId,
      startedAt, finishedAt: new Date().toISOString(), completed: true, checks, metrics, prismaVersion: Prisma.prismaVersion.client,
      engineWorkers: 1, sourceSha256: Object.fromEntries(sources.map(file => [file, sha(file)])),
      fixtureSha256: sha('scripts/sqlite-transaction-scheduling-engineering.ts'), forbiddenCalls, productionWrites: 0, paidRequests: 0, browserRuns: 0,
    }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(`SQLite transaction scheduling engineering receipt: ${receipt}`); process.exitCode = 0;
  } finally { await raw.$disconnect(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
