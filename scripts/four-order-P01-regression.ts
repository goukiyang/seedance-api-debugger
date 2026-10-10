import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), 'sd2-four-p01-'));
  const url = `file:${path.join(directory, 'fixture.db')}`;
  if (!directory.startsWith(path.join(tmpdir(), 'sd2-four-p01-'))) throw new Error('Unsafe fixture path');
  process.env.DATABASE_URL = url;
  const db = new PrismaClient({ datasources: { db: { url } } });
  const fixtureGlobal = globalThis as typeof globalThis & { prisma?: PrismaClient; prismaSqlitePragmasStarted?: boolean };
  fixtureGlobal.prisma = db;
  fixtureGlobal.prismaSqlitePragmasStarted = true;
  let checks = 0;
  const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks++; };
  const { executeResolutionOperation: execute, readResolutionOperations: read, ResolutionApplyError } = await import('../src/lib/image-studio/resolution-apply');
  const { getImageStudioSettings, IMAGE_STUDIO_SETTING_KEY, DEFAULT_STUDIO_PRICES, saveImageStudioSettingsInTx, imageStudioSettingsPayload } = await import('../src/lib/image-studio/settings');
  const { defaultStudioTemplateDefaults } = await import('../src/lib/image-studio/template-defaults');
  const { createStudioSettingsController, studioSettingsDirty } = await import('../src/app/image-studio/settings-controller');
  type Receipt = Awaited<ReturnType<typeof execute>>;
  const owner = 'fixture-owner';
  const other = 'fixture-other';
  const defaults = { ...defaultStudioTemplateDefaults(), resolution: '2K' as const };
  const settings: Awaited<ReturnType<typeof getImageStudioSettings>> = { context: 'keep context', model: defaults.model, revision: 10, prices: { ...DEFAULT_STUDIO_PRICES }, templateDefaults: defaults };
  async function expectError(action: () => Promise<unknown>, status: number) {
    await assert.rejects(action, error => error instanceof ResolutionApplyError && error.status === status); checks++;
  }
  function payload(receipt: Receipt, action: string) {
    const op = receipt.operation;
    return { action, requestId: op.requestId, previewDigest: op.previewDigest, operationRevision: op.operationRevision,
      ...(['apply', 'restore'].includes(action) ? { batch: action === 'apply' ? op.nextBatch : op.nextRestoreBatch } : {}) };
  }
  async function prepare(input = settings, excluded = ['dirty'], id: string = randomUUID()) {
    return execute(owner, { action: 'prepare', requestId: id, settings: input, excludeIds: excluded }, db);
  }
  async function commit(receipt: Receipt, input = settings, excluded = ['dirty']) {
    return execute(owner, { ...payload(receipt, 'commit'), settings: input, excludeIds: excluded }, db);
  }
  try {
    // Only this newly-created temporary database is given a schema or fixture rows.
    await db.$executeRawUnsafe('CREATE TABLE User (id TEXT PRIMARY KEY, role TEXT NOT NULL, status TEXT NOT NULL, expires_at DATETIME)');
    await db.$executeRawUnsafe('CREATE TABLE PlatformSetting (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, value_json TEXT NOT NULL, updated_by TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    await db.$executeRawUnsafe(`CREATE TABLE ImageStudioModule (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT 'module', prompt TEXT NOT NULL DEFAULT '', context TEXT NOT NULL DEFAULT '', model TEXT, quality TEXT NOT NULL DEFAULT 'auto', resolution TEXT NOT NULL DEFAULT '4K', group_name TEXT NOT NULL DEFAULT 'group', banner_asset_id TEXT, prices_json TEXT, reproduce_task_id TEXT, source_preset_id TEXT, count INTEGER NOT NULL DEFAULT 1, reference_limit INTEGER NOT NULL DEFAULT 10, aspect_ratio TEXT NOT NULL DEFAULT 'auto', reference_ids TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await db.$executeRawUnsafe('INSERT INTO User (id, role, status) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)', owner, 'admin', 'active', other, 'admin', 'active', 'ordinary', 'user', 'active');
    await db.platformSetting.create({ data: { key: IMAGE_STUDIO_SETTING_KEY, value_json: JSON.stringify(settings) } });
    for (let index = 0; index < 42; index++) await db.imageStudioModule.create({ data: {
      id: `target-${String(index).padStart(3, '0')}`, owner_id: owner, name: `Target ${index}`, prompt: 'private prompt', context: 'private context',
      model: index === 0 ? null : defaults.model, source_preset_id: index === 1 ? 'shared-preset' : null, prices_json: '{"keep":5}', reference_ids: '["original"]',
      resolution: '4K', revision: 3, count: 7, quality: 'high', aspect_ratio: '16:9',
    } });
    for (const [id, data] of [
      ['dirty', {}], ['reproduction', { reproduce_task_id: 'old-task' }], ['unsupported', { model: 'unknown-model' }],
      ['unchanged', { resolution: '2K' }], [`default-${owner}`, {}],
    ] as const) await db.imageStudioModule.create({ data: { id, owner_id: owner, model: defaults.model, resolution: '4K', ...data } });
    await db.imageStudioModule.create({ data: { id: 'foreign', owner_id: other } });
    const before = await db.imageStudioModule.findMany({ orderBy: { id: 'asc' } });
    const settingsBefore = await getImageStudioSettings(db);
    const defaultRowBefore = await db.platformSetting.findUniqueOrThrow({ where: { key: IMAGE_STUDIO_SETTING_KEY } });
    let receipt = await prepare();
    check(receipt.operation.counts.total === 47 && receipt.operation.counts.change === 43, 'Complete persisted owner directory, including actual default');
    check(['dirty', 'reproduction', 'unsupported', 'unchanged'].every(bucket => receipt.operation.counts[bucket as keyof typeof receipt.operation.counts] === 1), 'Disjoint protected buckets');
    check((await db.imageStudioModule.findMany({ orderBy: { id: 'asc' } })).every((row, i) => JSON.stringify(row) === JSON.stringify(before[i])), 'Preview changes no business fields');
    await expectError(() => read(other, receipt.operation.requestId, 0, db), 404);
    await expectError(() => read('ordinary', receipt.operation.requestId, 0, db), 403);
    check((await prepare(settings, ['dirty'], receipt.operation.requestId)).operation.previewDigest === receipt.operation.previewDigest, 'Same request returns original preview');
    await expectError(() => prepare({ ...settings, context: 'different' }, ['dirty'], receipt.operation.requestId), 409);
    await expectError(() => prepare(settings, ['foreign']), 409);
    receipt = await commit(receipt);
    check(receipt.operation.globalRevision === 10 && (await getImageStudioSettings(db)).revision === 10, 'Unchanged default does not fake a revision');
    check(JSON.stringify(await db.platformSetting.findUniqueOrThrow({ where: { key: IMAGE_STUDIO_SETTING_KEY } })) === JSON.stringify(defaultRowBefore), 'Unchanged default preserves JSON, actor and timestamps without a write');
    const batchPayload = payload(receipt, 'apply');
    receipt = await execute(owner, batchPayload, db);
    check(receipt.operation.counts.applied === 20 && receipt.deltas?.length === 20, 'One transaction updates at most 20 targets');
    const replay = await execute(owner, batchPayload, db);
    check(replay.operation.nextBatch === 1 && replay.operation.counts.applied === 20, 'Same batch replay does not increment again');
    await expectError(() => execute(owner, { ...batchPayload, operationRevision: 99 }, db), 409);
    const conflicted = 'target-040';
    await db.imageStudioModule.update({ where: { id: conflicted }, data: { prompt: 'later edit', revision: { increment: 1 } } });
    while (['defaultConfirmed', 'applying'].includes(receipt.operation.phase)) receipt = await execute(owner, payload(receipt, 'apply'), db);
    check(receipt.operation.phase === 'partial' && receipt.operation.counts.applied === 42 && receipt.operation.counts.conflicts === 1, 'CAS conflict preserves later edit');
    check((await read(owner, receipt.operation.requestId, 0, db) as Receipt).deltas?.length === 42, 'Read-only receipt recovers successful deltas from earlier batches after response loss');
    check((await db.imageStudioModule.findUniqueOrThrow({ where: { id: 'foreign' } })).resolution === '4K', 'Other owner untouched');
    const after = await db.imageStudioModule.findMany({ orderBy: { id: 'asc' } });
    for (let index = 0; index < before.length; index++) {
      if (before[index].id === conflicted) continue;
      const { resolution: _r1, revision: _v1, updated_at: _u1, ...a } = before[index];
      const { resolution: _r2, revision: _v2, updated_at: _u2, ...b } = after[index];
      assert.deepEqual(a, b);
    }
    checks++; check(!JSON.stringify(imageStudioSettingsPayload(await getImageStudioSettings(db), true)).includes('studio-resolution-apply'), 'Ordinary settings projection excludes private receipts');
    const restoreConflict = 'target-000';
    await db.imageStudioModule.update({ where: { id: restoreConflict }, data: { revision: { increment: 1 }, resolution: '1K' } });
    while (receipt.operation.phase !== 'restored') receipt = await execute(owner, payload(receipt, 'restore'), db);
    check(receipt.operation.counts.restored === 41 && receipt.operation.counts.restoreConflicts === 1, 'Restore only exact expected-after rows');
    check((await db.imageStudioModule.findUniqueOrThrow({ where: { id: restoreConflict } })).resolution === '1K', 'Restore does not overwrite later resolution');
    assert.deepEqual(await getImageStudioSettings(db), settingsBefore); checks++;
    // Fail a statement after the first target update: target changes and receipt both roll back.
    let atomic = await prepare(settings, []);
    atomic = await commit(atomic, settings, []);
    const preAtomic = await db.imageStudioModule.findMany({ orderBy: { id: 'asc' } });
    await db.$executeRawUnsafe(`CREATE TRIGGER fixture_fail BEFORE UPDATE ON ImageStudioModule WHEN NEW.id = 'target-001' BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END`);
    await assert.rejects(() => execute(owner, payload(atomic, 'apply'), db)); checks++;
    assert.deepEqual(await db.imageStudioModule.findMany({ orderBy: { id: 'asc' } }), preAtomic); checks++;
    const atomicRead = await read(owner, atomic.operation.requestId, 0, db) as Receipt;
    check(atomicRead.operation.nextBatch === 0 && atomicRead.operation.counts.applied === 0, 'Interrupted transaction writes no receipt');
    await db.$executeRawUnsafe('DROP TRIGGER fixture_fail');
    atomic = await execute(owner, payload(atomic, 'apply'), db);
    await db.platformSetting.update({ where: { key: IMAGE_STUDIO_SETTING_KEY }, data: { value_json: JSON.stringify({ ...settings, revision: 11 }) } });
    atomic = await execute(owner, payload(atomic, 'apply'), db);
    check(atomic.operation.phase === 'paused' && atomic.operation.counts.applied === 20, 'Global revision change pauses untouched remainder');
    atomic = await execute(owner, payload(atomic, 'cancel'), db);
    const current = await getImageStudioSettings(db);
    let cas = await prepare(current, []);
    await db.platformSetting.update({ where: { key: IMAGE_STUDIO_SETTING_KEY }, data: { value_json: JSON.stringify({ ...current, revision: 12 }) } });
    const preCas = await db.imageStudioModule.findMany({ orderBy: { id: 'asc' } });
    await expectError(() => commit(cas, current, []), 409);
    assert.deepEqual(await db.imageStudioModule.findMany({ orderBy: { id: 'asc' } }), preCas); checks++;
    cas = await execute(owner, payload(cas, 'cancel'), db);
    await assert.rejects(() => db.$transaction(tx => saveImageStudioSettingsInTx(tx, { ...current, revision: 12, context: '' }, owner, { skipUnchanged: true }))); checks++;
    const bad = await db.imageStudioModule.create({ data: { id: 'too-large', owner_id: owner, name: 'x'.repeat(100000) } });
    await expectError(() => prepare({ ...current, revision: 12 }, []), 413);
    await db.imageStudioModule.delete({ where: { id: bad.id } });
    const controller = createStudioSettingsController(true, { read: async () => ({ ...settings, providerReady: true }), write: async () => { throw new Error('not called'); } });
    await controller.load();
    const submitted = controller.getSnapshot().draft!;
    controller.editContext('late draft');
    check(!controller.acceptCommitted({ ...settings, revision: 11, providerReady: true }, submitted) && studioSettingsDirty(controller.getSnapshot()), 'Late settings draft remains open and dirty');
    check(controller.getSnapshot().draft?.context === 'late draft', 'Late context not replaced by commit');
    await db.$executeRawUnsafe('INSERT INTO User (id, role, status) VALUES (?, ?, ?), (?, ?, ?)', 'paged', 'admin', 'active', 'large', 'admin', 'active');
    await db.$executeRawUnsafe(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<251) INSERT INTO ImageStudioModule (id, owner_id, name) SELECT 'paged-' || n, 'paged', 'Paged ' || n FROM ids`);
    const page = await execute('paged', { action: 'prepare', requestId: randomUUID(), settings: { ...current, revision: 12 }, excludeIds: [] }, db);
    check(page.entries.length === 200 && page.nextCursor === 200 && page.operation.counts.total === 251, 'Frozen complete preview is paged, not truncated');
    const secondPage = await read('paged', page.operation.requestId, 200, db) as Receipt;
    check(secondPage.entries.length === 51 && secondPage.nextCursor === null, 'Second preview page includes every remaining target');
    await execute('paged', payload(page, 'cancel'), db);
    const virtual = await execute('paged', { action: 'prepare', requestId: randomUUID(), settings: { ...current, revision: 12 }, excludeIds: ['default-paged'] }, db);
    check(virtual.operation.counts.total === 251 && virtual.operation.counts.dirty === 0, 'Absent dirty virtual default is not a persisted target');
    await execute('paged', payload(virtual, 'cancel'), db);
    await db.imageStudioModule.create({ data: { id: 'default-paged', owner_id: 'paged' } });
    const persisted = await execute('paged', { action: 'prepare', requestId: randomUUID(), settings: { ...current, revision: 12 }, excludeIds: ['default-paged'] }, db);
    check(persisted.operation.counts.total === 252 && persisted.operation.counts.dirty === 1, 'A virtual default persisted in another tab remains excluded while its local draft is dirty');
    await db.$executeRawUnsafe(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<50001) INSERT INTO ImageStudioModule (id, owner_id, name) SELECT 'large-' || n, 'large', 'Large ' || n FROM ids`);
    await expectError(() => execute('large', { action: 'prepare', requestId: randomUUID(), settings: { ...current, revision: 12 }, excludeIds: [] }, db), 413);
    check(await db.platformSetting.count({ where: { key: { startsWith: 'studio-resolution-apply:v1:large:' } } }) === 0, 'Over-capacity preview creates no partial operation');
    const beforeRead = await db.platformSetting.count();
    await read(owner, atomic.operation.requestId, 0, db);
    check(await db.platformSetting.count() === beforeRead, 'Recovery GET is read-only');
    console.log(JSON.stringify({ package: 'P01', checks, fixture: 'temporary SQLite only', status: 'PASS' }));
  } finally { await db.$disconnect(); await rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
