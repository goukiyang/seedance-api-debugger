import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mock } from 'node:test';

const sources = [
  'src/lib/catalog-directory-writes.ts',
  'src/lib/image-studio/catalog-revision.ts',
  'src/lib/image-studio/shared-command-storage.ts',
  'scripts/process-image-studio.ts',
  'scripts/catalog-receipt-invalidation-fixture.ts',
] as const;
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

async function main() {
  const root = realpathSync(process.cwd()), startedAt = new Date().toISOString();
  const requestedEvidenceRoot = process.env.CATALOG_RECEIPT_EVIDENCE_ROOT
    || path.join(root, '.role-tests', 'catalog-receipt-engineering');
  assert.ok(path.isAbsolute(requestedEvidenceRoot), 'Evidence root must be absolute');
  assert.ok(!requestedEvidenceRoot.startsWith('/data/video-api-debugger'), 'Production paths are forbidden');
  mkdirSync(requestedEvidenceRoot, { recursive: true, mode: 0o700 });
  const evidenceRoot = realpathSync(requestedEvidenceRoot);
  assert.ok(lstatSync(evidenceRoot).isDirectory() && !lstatSync(evidenceRoot).isSymbolicLink());
  const previousUmask = process.umask(0o077);
  const directory = mkdtempSync(path.join(evidenceRoot, 'run-'));
  const databasePath = path.join(directory, 'isolated.sqlite');
  const sourceSha256 = Object.fromEntries(sources.map(file => [file, sha256(readFileSync(path.join(root, file)))]));
  const require = createRequire(import.meta.url), prismaPackage = require.resolve('prisma/package.json');
  const databaseUrl = `file:${databasePath}`;
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: databaseUrl, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[name]) env[name] = process.env[name];
  const schemaLog = execFileSync(process.execPath, [path.join(path.dirname(prismaPackage), 'build/index.js'), 'db', 'push',
    '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')], { cwd: directory, env, encoding: 'utf8', timeout: 300_000 });
  writeFileSync(path.join(directory, 'schema.log'), schemaLog, { mode: 0o600 });
  assert.equal(statSync(databasePath).mode & 0o777, 0o600);
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: databaseUrl });

  let externalRequests = 0, completed = false, failure: unknown;
  const blocked = () => { externalRequests++; throw new Error('External network is forbidden in the catalog receipt fixture'); };
  mock.method(globalThis, 'fetch', blocked); mock.method(http, 'request', blocked); mock.method(http, 'get', blocked);
  mock.method(https, 'request', blocked); mock.method(https, 'get', blocked);
  const { PrismaClient } = await import('@prisma/client');
  const { catalogDirectoryWrites } = await import('../src/lib/catalog-directory-writes');
  const { initializeCatalogRevisions, readCatalogRevision } = await import('../src/lib/image-studio/catalog-revision');
  const { readReceipt, sharedCommandFingerprint, writeReceipt } = await import('../src/lib/image-studio/shared-command-storage');
  const base = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const db = catalogDirectoryWrites(base);
  const checks: string[] = [];
  const revisions = async () => ({
    templates: await readCatalogRevision(db, 'templates'),
    assets: await readCatalogRevision(db, 'assets'),
  });
  const expectUnchanged = async (before: Awaited<ReturnType<typeof revisions>>, label: string) => {
    assert.deepEqual(await revisions(), before, label);
  };
  const expectBothChanged = async (before: Awaited<ReturnType<typeof revisions>>, label: string) => {
    const after = await revisions();
    assert.notEqual(after.templates, before.templates, `${label}: templates revision`);
    assert.notEqual(after.assets, before.assets, `${label}: assets revision`);
  };
  const ownerId = 'catalog-receipt-fixture-owner';
  try {
    await initializeCatalogRevisions(base);
    assert.match((await revisions()).templates || '', /^[a-f0-9]{64}$/);
    assert.match((await revisions()).assets || '', /^[a-f0-9]{64}$/);

    const receiptFingerprint = sharedCommandFingerprint(['open-shared', 'fixture-preset']);
    const beforeReceipt = await revisions();
    await writeReceipt(db, ownerId, 'receipt-only', receiptFingerprint, { moduleId: 'fixture-module', presetId: 'fixture-preset', revision: 1 });
    await expectUnchanged(beforeReceipt, 'A durable operation receipt alone must not invalidate either catalog');
    assert.deepEqual(await readReceipt(db, ownerId, 'receipt-only', receiptFingerprint),
      { moduleId: 'fixture-module', presetId: 'fixture-preset', revision: 1 });
    checks.push('receipt_create_and_read_are_durable_without_revision_change');

    let before = await revisions();
    await db.$transaction(async tx => {
      await tx.imageStudioModule.create({ data: { id: 'fixture-module', owner_id: ownerId, name: 'Fixture module' } });
      await writeReceipt(tx, ownerId, 'module-and-receipt', sharedCommandFingerprint(['module-and-receipt']),
        { moduleId: 'fixture-module', revision: 1 });
    }, { maxWait: 30_000, timeout: 60_000 });
    await expectBothChanged(before, 'A real module write in the same command must invalidate both catalogs');
    checks.push('same_command_module_write_still_invalidates');

    before = await revisions();
    await db.$transaction(async tx => {
      await tx.imageStudioPreset.create({ data: { id: 'fixture-preset', owner_id: ownerId, scope: 'creator', name: 'Fixture preset', model: 'fixture-model' } });
      await writeReceipt(tx, ownerId, 'preset-and-receipt', sharedCommandFingerprint(['preset-and-receipt']),
        { presetId: 'fixture-preset', revision: 1 });
    }, { maxWait: 30_000, timeout: 60_000 });
    await expectBothChanged(before, 'A real preset write in the same command must invalidate both catalogs');
    checks.push('same_command_preset_write_still_invalidates');

    before = await revisions();
    await db.$transaction(async tx => {
      await tx.platformSetting.create({ data: { key: 'studio_shared_reproduction_v1:fixture-preset', value_json: JSON.stringify({ version: 1 }) } });
      await writeReceipt(tx, ownerId, 'definition-and-receipt', sharedCommandFingerprint(['definition-and-receipt']),
        { presetId: 'fixture-preset', definitionToken: 'fixture-token' });
    }, { maxWait: 30_000, timeout: 60_000 });
    await expectBothChanged(before, 'A real shared definition write in the same command must invalidate both catalogs');
    checks.push('same_command_definition_write_still_invalidates');

    const unknown = await base.platformSetting.create({ data: { key: 'avatar_fixture_business_state', value_json: '{"revision":1}' } });
    before = await revisions();
    assert.equal((await db.platformSetting.updateMany({ where: { id: unknown.id, value_json: unknown.value_json },
      data: { value_json: '{"revision":2}' } })).count, 1);
    await expectBothChanged(before, 'An id/value-only PlatformSetting write must remain fail-closed');
    checks.push('unknown_id_value_where_remains_conservative');

    const currentUnknown = await base.platformSetting.findUniqueOrThrow({ where: { id: unknown.id } });
    before = await revisions();
    assert.equal((await db.platformSetting.updateMany({ where: { id: unknown.id, value_json: currentUnknown.value_json },
      data: { value_json: '{"revision":3}' } })).count, 1);
    await expectBothChanged(before, 'A matching id/value CAS must invalidate');
    before = await revisions();
    assert.equal((await db.platformSetting.updateMany({ where: { id: unknown.id, value_json: currentUnknown.value_json },
      data: { value_json: '{"revision":4}' } })).count, 0);
    await expectUnchanged(before, 'A zero-count CAS must not invalidate');
    checks.push('matching_cas_invalidates_but_zero_count_cas_does_not');

    const workerValue = JSON.stringify({ protocol: 'shared-live-v1', workerId: 'fixture-worker', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const worker = await base.platformSetting.create({ data: { key: 'studio_shared_worker_v1', value_json: workerValue } });
    before = await revisions();
    assert.equal((await db.platformSetting.updateMany({ where: { id: worker.id, key: 'studio_shared_worker_v1', value_json: worker.value_json },
      data: { value_json: JSON.stringify({ ...JSON.parse(worker.value_json), expiresAt: new Date(0).toISOString() }) } })).count, 1);
    await expectUnchanged(before, 'The known shared-worker readiness row must not invalidate catalogs');
    const workerSource = readFileSync(path.join(root, 'scripts/process-image-studio.ts'), 'utf8');
    assert.match(workerSource, /where:\s*\{\s*id: row\.id, key: STUDIO_SHARED_WORKER_KEY, value_json: row\.value_json\s*\}/,
      'The production worker revoke must retain id/value CAS and include its already-read key');
    checks.push('known_worker_revoke_keeps_id_key_value_cas_without_revision_change');

    before = await revisions();
    const broad = await db.platformSetting.updateMany({ where: { key: { startsWith: 'studio_shared_' } }, data: { updated_by: 'fixture-broad-write' } });
    assert.ok(broad.count >= 4);
    await expectBothChanged(before, 'A broad startsWith write must not be guessed receipt-only');
    assert.deepEqual(await readReceipt(db, ownerId, 'receipt-only', receiptFingerprint),
      { moduleId: 'fixture-module', presetId: 'fixture-preset', revision: 1 });
    checks.push('broad_starts_with_stays_conservative_and_receipts_remain_readable');

    assert.equal(externalRequests, 0);
    completed = true;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await base.$disconnect();
    mock.restoreAll();
    process.umask(previousUmask);
    const receiptPath = path.join(directory, 'receipt.json');
    writeFileSync(receiptPath, JSON.stringify({ schema: 'catalog-receipt-invalidation-fixture.v1', startedAt,
      finishedAt: new Date().toISOString(), completed, isolated: true, productionWrites: 0, paidRequests: 0,
      browserRuns: 0, externalRequests, checks, sourceSha256,
      ...(failure ? { failure: failure instanceof Error ? failure.message : String(failure) } : {}) }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ completed, receiptPath, checks: checks.length }));
  }
}

void main().catch(error => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
