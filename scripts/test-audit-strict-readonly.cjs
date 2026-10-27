const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loader, loadFunction } = require('./audit-readonly-loader.cjs');
process.env.NODE_ENV = 'test'; process.env.SD2_DATABASE_MODE = 'readonly';
process.env.DATABASE_URL = 'file:/tmp/audit-readonly-fake.db';
process.env.FEISHU_FEEDBACK_ENABLED = 'false';

test('actual HD entrypoint: strict native READONLY, no Prisma construction or write initialization', async () => {
  delete globalThis[Symbol.for('video-api.database-client.v1')];
  let prisma = 0; const opened = []; const sql = [];
  class FakePrisma {
    constructor() { prisma++; this.asset = { findUnique: async () => null }; }
    $extends() { return this; }
    async $queryRawUnsafe(query) { sql.push(query); return []; }
  }
  class FakeDatabaseSync {
    constructor(file, options) { opened.push({ file, options }); }
    prepare(query) { sql.push(query); return { all: () => [] }; }
    close() {}
  }
  const load = loader({ '@prisma/client': { PrismaClient: FakePrisma },
    'node:module': { createRequire: () => name => { assert.equal(name, 'node:sqlite'); return { DatabaseSync: FakeDatabaseSync }; } },
    'node:fs/promises': { stat: async () => ({ isFile: () => true }) },
  });
  const api = load('src/lib/media/hd-readonly-db.ts');
  if (api.hdReadRepository) await api.hdReadRepository.assetById('asset');
  else await api.hdReadonlyDb.asset.findUnique({ where: { id: 'asset' } });
  assert.equal(prisma, 0, 'diagnostic process must never construct Prisma');
  assert.equal(opened.length, 1); assert.equal(opened[0].options.readOnly, true);
  assert.equal(sql.some(query => /PRAGMA|BEGIN|INSERT|UPDATE|DELETE/.test(query)), false);
});

test('mode and mount guard fail closed, including writable DB sidecar overmounts', () => {
  const load = loader();
  const { resolveDatabaseProcessMode } = load('src/lib/database/process-mode.ts');
  assert.throws(() => resolveDatabaseProcessMode({ NODE_ENV: 'production' }), /mode_required/);
  assert.throws(() => resolveDatabaseProcessMode({ SD2_DATABASE_MODE: 'typo' }), /mode_required/);
  assert.equal(resolveDatabaseProcessMode({ NODE_ENV: 'production', SD2_DATABASE_MODE: 'readonly' }), 'readonly');
  const { assertReadonlyDatabaseMount } = load('src/lib/database/readonly-mount.ts');
  const base = '1 0 0:1 / / rw - ext4 /dev/root rw\n2 1 0:1 /data /data ro - ext4 /dev/root rw';
  assert.doesNotThrow(() => assertReadonlyDatabaseMount('/data/db.sqlite', base));
  assert.throws(() => assertReadonlyDatabaseMount('/data/db.sqlite', base + '\n3 2 0:1 /shm /data/db.sqlite-shm rw - ext4 /dev/root rw'), /mount_required/);
  assert.throws(() => assertReadonlyDatabaseMount('/data/db.sqlite', base, ['/tmp/escaped-shm']), /mount_required/);
  assert.throws(() => assertReadonlyDatabaseMount('/tmp/db.sqlite', base), /mount_required/);
  assert.throws(() => assertReadonlyDatabaseMount('/data/db.sqlite', 'invalid'), /mount_unknown/);
});

test('actual Prisma factory refuses readonly mode even if called accidentally', async () => {
  let constructed = 0;
  const load = loader({ '@prisma/client': { PrismaClient: class { constructor() { constructed++; } } } });
  const api = load('src/lib/database/client.ts');
  assert.throws(() => api.applicationDatabase.$connect(), /writer_forbidden/);
  await assert.rejects(api.readonlyDatabase.asset.findMany(), /writer_forbidden/);
  assert.equal(constructed, 0);
});

test('fixed repository SQL binds values, bounds URL/cursor reads and maps Prisma datetime values', async () => {
  const calls = [];
  const row = { id: 'a', owner_id: 'owner', original_url: '/uploads/a.png', metadata_json: null, status: 'active', type: 'image', created_at: 1700000000000 };
  const ref = { id: 'r', owner_user_id: 'owner', url: '/uploads/r.png', status: 'active', asset_id: null, album_status: 'active' };
  class DatabaseSync {
    constructor(_file, options) { assert.equal(options.readOnly, true); }
    prepare(sql) { return { all: (...values) => {
      calls.push({ sql, values });
      if (sql.includes('COUNT(*)')) return [{ count: 3 }];
      if (sql.includes('FROM ReferenceImage')) return [ref];
      if (sql.includes('FROM ImageStudioTask')) return [{ id: 't', owner_id: 'owner', status: 'succeeded', usage_json: null, finished_at: 1700000000000, asset_id: 'a' }];
      return [row];
    } }; }
    close() {}
  }
  const load = loader({ 'node:module': { createRequire: () => () => ({ DatabaseSync }) } });
  const { openReadonlyHdRepository, hdReadDate, assertReadonlySqliteRuntime } = load('src/lib/database/readonly-hd.ts');
  assert.throws(() => assertReadonlySqliteRuntime('22.11.0'), /runtime_required/);
  assert.throws(() => assertReadonlySqliteRuntime('23.0.0'), /runtime_required/);
  assert.doesNotThrow(() => assertReadonlySqliteRuntime('22.12.0'));
  assert.doesNotThrow(() => assertReadonlySqliteRuntime('24.0.0'));
  const repo = openReadonlyHdRepository('/tmp/synthetic-only.db');
  const injected = "x') OR 1=1; DROP TABLE Asset; --";
  assert.equal((await repo.assetById(injected)).id, 'a');
  await repo.assetsAtUrls([injected]); await repo.referencesAtUrls(['/uploads/r.png']);
  const cursor = { at: '2023-11-14T22:13:20.000Z', id: 'a' }, end = new Date('2023-11-15T00:00:00Z');
  assert.equal((await repo.nextAssets(cursor, end, 45))[0].created_at.toISOString(), '2023-11-14T22:13:20.000Z');
  await repo.nextTasks(cursor, end, 45);
  await repo.taskAsset('a', 'owner'); await repo.referenceById('r');
  assert.equal(await repo.countActiveImageAssets(), 3); await repo.inventoryAssets(); await repo.inventoryReferences();
  assert.equal(calls.every(call => /^SELECT\s/.test(call.sql) && !call.sql.includes(injected)), true);
  assert.equal(calls.filter(call => call.values.includes(injected)).length, 2);
  assert.equal(calls.some(call => call.sql.includes('created_at>?') && call.values.includes(1700000000000)), true);
  assert.equal(calls.some(call => call.sql.includes('t.finished_at=?') && call.values.includes(1700000000000)), true);
  const before = calls.length;
  await assert.rejects(repo.assetsAtUrls(Array(17).fill('x')), /urls_invalid/);
  await assert.rejects(repo.nextAssets(cursor, end, 101), /limit_required/);
  await assert.rejects(repo.nextTasks({ at: 'invalid', id: 'a' }, end, 1), /cursor_invalid/);
  assert.equal(calls.length, before);
  for (const method of ['$queryRaw', '$executeRawUnsafe', '$transaction', 'exec', 'prepare', 'findMany']) assert.equal(repo[method], undefined);
  assert.equal(hdReadDate('2026-10-27 12:00:00').toISOString(), '2026-10-27T12:00:00.000Z');
  assert.equal(hdReadDate('Tue, 27 Oct 2026 12:00:00 +0000').toISOString(), '2026-10-27T12:00:00.000Z');
  assert.equal(hdReadDate('2026-10-27T12:00:00+08:00').toISOString(), '2026-10-27T04:00:00.000Z');
  assert.throws(() => hdReadDate('2026-10-27T12:00:00'), /date_invalid/);
  assert.throws(() => hdReadDate('2026-02-30T12:00:00Z'), /date_invalid/);
  assert.throws(() => hdReadDate('invalid'), /date_invalid/);
  await repo.close();
});

test('missing builtin/open failure cannot fall back to Prisma', async () => {
  let prisma = 0;
  const load = loader({ '@prisma/client': { PrismaClient: class { constructor() { prisma++; } } },
    'node:module': { createRequire: () => () => { throw new Error('builtin_unavailable'); } } });
  const { hdReadRepository } = load('src/lib/media/hd-readonly-db.ts');
  await assert.rejects(hdReadRepository.assetById('asset'), /builtin_unavailable/);
  await assert.rejects(hdReadRepository.assetById('asset'), /builtin_unavailable/);
  await assert.doesNotReject(hdReadRepository.close());
  assert.equal(prisma, 0);
});

test('actual inventory uses guarded HD decoder and retains pixel/multi-frame exclusion', async () => {
  class UntrustedImageError extends Error { constructor(code) { super(code); this.code = code; } }
  const calls = []; let oversized = false;
  const inventory = loadFunction('scripts/process-hd-derivatives.ts', 'inventory', {
    hdReadRepository: { countActiveImageAssets: async () => 1, inventoryAssets: async () => [{ id: 'a', owner_id: 'owner', original_url: '/uploads/a.png', metadata_json: '{}' }], inventoryReferences: async () => [] },
    batch: 'synthetic', textFlag: () => false, hdSource: async () => ({ file: '/synthetic/a.png', size: 32, version: 'v' }),
    fs: { realpath: async () => '/synthetic/storage' }, path: require('node:path'), hdCapacity: async () => ({ safe: true }), listHdJobs: async () => [],
    openUntrustedImage: async (...args) => { calls.push(args); if (oversized) throw new UntrustedImageError('IMAGE_PIXEL_LIMIT'); return { metadata: async () => ({ format: 'gif', pages: 2 }) }; },
    hdEligibility: meta => meta.pages === 2 ? 'multi_frame' : null, hdSourceIsolationReason: () => null, UntrustedImageError,
  });
  assert.equal((await inventory(false)).reasons.multi_frame, 1);
  assert.deepEqual(calls[0], ['/synthetic/a.png', 'hd', { animated: true }]);
  oversized = true;
  assert.equal((await inventory(false)).reasons.pixel_limit, 1);
});
