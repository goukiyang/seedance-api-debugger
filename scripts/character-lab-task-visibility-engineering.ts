import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { mock } from 'node:test';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function main() {
  const root = realpathSync(process.cwd());
  const previousUmask = process.umask(0o077);
  const scratch = path.join(root, '.role-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'character-lab-visibility-'));
  const databasePath = path.join(directory, 'synthetic.db');
  process.env.DATABASE_URL = `file:${databasePath}`;
  Reflect.set(process.env, 'NODE_ENV', 'test');
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);

  const require = createRequire(import.meta.url);
  const prismaPackage = require.resolve('prisma/package.json');
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL,
    PRISMA_GENERATE_SKIP_AUTOINSTALL: '1',
  };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  execFileSync(process.execPath, [
    path.join(path.dirname(prismaPackage), 'build/index.js'), 'db', 'push', '--skip-generate',
    '--schema', path.join(root, 'prisma/schema.prisma'),
  ], { cwd: directory, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(statSync(databasePath).mode & 0o777, 0o600);

  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  Reflect.set(globalThis, 'prisma', db);
  const marker = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js');
  const resolver = require('node:module') as { _resolveFilename: (...args: unknown[]) => string };
  const originalResolve = resolver._resolveFilename;
  mock.method(resolver, '_resolveFilename', (...args: unknown[]) => args[0] === 'server-only'
    ? marker : originalResolve.apply(resolver, args));

  const owner = 'lab-visibility-owner';
  const otherOwner = 'lab-visibility-other';
  const ownerPlan = 'owner-plan-00000001';
  const otherPlan = 'other-plan-00000001';
  const ownerBatch = hash(`${owner}:${ownerPlan}`);
  const otherBatch = hash(`${otherOwner}:${otherPlan}`);
  const fakeBatch = hash(`${owner}:missing-plan-000001`);
  const presetId = randomUUID();
  const moduleId = randomUUID();
  const otherModuleId = randomUUID();
  const defaultModuleId = `default-${owner}`;
  const now = Date.now();
  const task = (id: string, taskOwner: string, batchId: string, status: string, module: string | null,
    assetId?: string, created = now) => ({
    id, batch_id: batchId, owner_id: taskOwner, module_id: module, source_preset_id: module ? presetId : null,
    ordinal: 1, fingerprint: hash(id), prompt: 'synthetic', context: '', revision: 1, model: 'fixture-model',
    reference_ids: '[]', unit_credits: 1, status, asset_id: assetId, snapshot_json: null,
    created_at: new Date(created), ...(status === 'succeeded' ? { finished_at: new Date(created + 1) } : {}),
  });
  const asset = (id: string, assetOwner = owner) => ({
    id, owner_id: assetOwner, type: 'image', original_url: `/fixture/${id}.png`, file_name: `${id}.png`,
    mime_type: 'image/png', file_size: 16, width: 4, height: 4,
  });

  try {
    await db.user.createMany({ data: [
      { id: owner, name: 'Owner', username: owner, email: `${owner}@fixture.invalid`, password_hash: 'not-a-login', role: 'admin' },
      { id: otherOwner, name: 'Other', username: otherOwner, email: `${otherOwner}@fixture.invalid`, password_hash: 'not-a-login', role: 'admin' },
    ] });
    await db.imageStudioPreset.create({ data: { id: presetId, owner_id: owner, scope: 'admin', is_shared: true,
      name: 'Fixture preset', model: 'fixture-model' } });
    await db.imageStudioModule.create({ data: { id: moduleId, owner_id: owner, name: 'Fixture module', source_preset_id: presetId } });
    await db.platformSetting.createMany({ data: [
      { key: `character-lab:v1:${owner}:plan:${ownerPlan}`, value_json: '{}' },
      { key: `character-lab:v1:${otherOwner}:plan:${otherPlan}`, value_json: '{}' },
      { key: `character-lab:v1:${owner}:plan:short`, value_json: '{}' },
    ] });

    const defaultLabTasks = Array.from({ length: 30 }, (_, index) =>
      task(`default-lab-${index}`, owner, ownerBatch, 'queued', null, undefined, now + 10_000 + index));
    await db.imageStudioTask.createMany({ data: [
      ...defaultLabTasks,
      task('ordinary-null-module', owner, 'ordinary-null-batch', 'queued', null, undefined, now),
      task('missing-plan-batch', owner, fakeBatch, 'queued', null, undefined, now + 1),
      task('foreign-owner-batch', owner, otherBatch, 'queued', null, undefined, now + 2),
    ] });

    const likedAssets = Array.from({ length: 32 }, (_, index) => asset(`liked-asset-${index}`));
    await db.asset.createMany({ data: likedAssets });
    await db.imageStudioTask.createMany({ data: [
      ...Array.from({ length: 30 }, (_, index) => task(`liked-lab-${index}`, owner, ownerBatch, 'succeeded', moduleId,
        likedAssets[index].id, now + 20_000 + index)),
      task('liked-ordinary-0', owner, 'liked-ordinary-batch-0', 'succeeded', moduleId, likedAssets[30].id, now + 1_000),
      task('liked-ordinary-1', owner, 'liked-ordinary-batch-1', 'succeeded', moduleId, likedAssets[31].id, now + 1_001),
    ] });
    await db.contentReaction.createMany({ data: likedAssets.map(item => ({ user_id: owner, content_key: `asset:${item.id}`,
      category: 'generated', liked: true })) });
    await db.imageStudioTask.createMany({ data: [
      ...Array.from({ length: 30 }, (_, index) => task(`active-lab-${index}`, owner, ownerBatch, 'running', moduleId,
        undefined, now - 20_000 + index)),
      task('active-ordinary-0', owner, 'active-ordinary-batch-0', 'running', moduleId, undefined, now - 1_000),
      task('active-ordinary-1', owner, 'active-ordinary-batch-1', 'queued', moduleId, undefined, now - 999),
    ] });

    const pinAssets = [asset('pin-owner-lab'), asset('pin-owner-ordinary'), asset('pin-other-lab', otherOwner),
      asset('pin-other-ordinary', otherOwner)];
    await db.asset.createMany({ data: pinAssets });
    await db.imageStudioTask.createMany({ data: [
      task('pin-owner-lab-task', owner, ownerBatch, 'succeeded', moduleId, 'pin-owner-lab', now + 30_000),
      task('pin-owner-ordinary-task', owner, 'pin-owner-ordinary-batch', 'succeeded', moduleId, 'pin-owner-ordinary', now + 30_001),
      task('pin-other-lab-task', otherOwner, otherBatch, 'succeeded', otherModuleId, 'pin-other-lab', now + 30_002),
      task('pin-other-ordinary-task', otherOwner, ownerBatch, 'succeeded', otherModuleId, 'pin-other-ordinary', now + 30_003),
    ] });
    const pins = [
      ['pin-owner-lab-task', 'pin-owner-lab', owner, moduleId],
      ['pin-owner-ordinary-task', 'pin-owner-ordinary', owner, moduleId],
      ['pin-other-lab-task', 'pin-other-lab', otherOwner, otherModuleId],
      ['pin-other-ordinary-task', 'pin-other-ordinary', otherOwner, otherModuleId],
    ].map(([taskId, assetId, ownerId, pinModuleId], index) => ({ taskId, assetId, ownerId, moduleId: pinModuleId,
      pinnedAt: new Date(now + index).toISOString() }));
    await db.platformSetting.create({ data: { key: `studio_result_pins_v1:${presetId}`,
      value_json: JSON.stringify({ version: 1, presetId, revision: 1, pins, receipts: [] }) } });

    const { characterLabTaskBatchIds } = await import('../src/lib/character-lab/task-source');
    const { studioTemplateTaskWhere } = await import('../src/lib/image-studio/task-visibility');
    const { activeStudioTaskPage } = await import('../src/lib/image-studio/active-tasks');
    const { likedStudioTaskPage } = await import('../src/lib/image-studio/liked-task-page');
    const { readableStudioPins } = await import('../src/lib/image-studio/result-pins');

    const excluded = await characterLabTaskBatchIds(owner, db);
    assert.deepEqual(excluded, [ownerBatch]);
    assert.deepEqual(await characterLabTaskBatchIds(otherOwner, db), [otherBatch]);

    const normalWhere = studioTemplateTaskWhere(owner, defaultModuleId, false, excluded);
    const normalRows = await db.imageStudioTask.findMany({ where: normalWhere, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 24 });
    assert.ok(normalRows.some(row => row.id === 'ordinary-null-module'));
    assert.ok(normalRows.some(row => row.id === 'missing-plan-batch'));
    assert.ok(normalRows.some(row => row.id === 'foreign-owner-batch'));
    assert.ok(normalRows.every(row => row.batch_id !== ownerBatch));
    assert.equal(await db.imageStudioTask.count({ where: normalWhere }), 3);

    const active = await activeStudioTaskPage(owner, moduleId);
    assert.deepEqual(new Set(active.ids), new Set(['active-ordinary-0', 'active-ordinary-1']));
    assert.equal(active.nextCursor, null);

    const liked = await likedStudioTaskPage(db, owner, moduleId, undefined, 24, [], false, excluded);
    assert.equal(liked.total, 2);
    assert.deepEqual(new Set(liked.rows.map(row => row.id)), new Set(['liked-ordinary-0', 'liked-ordinary-1']));

    const user = { id: owner, name: 'Owner', username: owner, email: `${owner}@fixture.invalid`, role: 'admin',
      account_type: 'internal', user_profile: 'other', feature_profile_id: null, status: 'active', expires_at: null } as const;
    const readable = await readableStudioPins(user, presetId, db);
    assert.deepEqual(new Set(readable?.pins.map(pin => pin.taskId)),
      new Set(['pin-owner-ordinary-task', 'pin-other-ordinary-task']));
    assert.equal(readable?.document.pins.length, 4);

    console.log(JSON.stringify({ schema: 'character-lab-task-visibility-engineering.v1', synthetic: true,
      checks: ['durable_owner_plan_keys_only', 'normal_count_and_page_filter_before_limit', 'active_and_liked_filter_before_limit',
        'pin_projection_uses_actual_task_owner', 'old_pin_document_unchanged'],
      productionWrites: 0, browserRuns: 0, paidRequests: 0, databasePath }, null, 2));
  } finally {
    mock.restoreAll();
    await db.$disconnect();
    process.umask(previousUmask);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
