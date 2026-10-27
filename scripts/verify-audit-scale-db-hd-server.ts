// Lead's isolated server only. This creates its own disposable synthetic DB;
// it neither pushes the application schema nor reads the configured application DB.
import './server-runtime.cjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

let phase = 'guard';
function safeScaleProofCause(error: unknown) {
  const value = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown; message?: unknown; actual?: unknown; expected?: unknown } : {};
  const names = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AssertionError', 'PrismaClientKnownRequestError', 'PrismaClientInitializationError', 'PrismaClientValidationError'];
  const name = typeof value.name === 'string' && names.includes(value.name) ? value.name : 'Error';
  const codes = ['ERR_ASSERTION', 'ERR_INVALID_ARG_TYPE', 'ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'ENOSPC',
    'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_UNKNOWN_BUILTIN_MODULE', 'ERR_DLOPEN_FAILED'];
  const code = typeof value.code === 'string' && (/^P\d{4}$/.test(value.code) || codes.includes(value.code)) ? value.code : null;
  const raw = typeof value.message === 'string' ? value.message : '';
  const scalar = (input: unknown) => typeof input === 'bigint' ? input.toString().slice(0, 64)
    : typeof input === 'number' && Number.isFinite(input) || typeof input === 'boolean' ? String(input) : 'redacted';
  const messages = ['Do not know how to serialize a BigInt', 'lead_isolated_server_opt_in_required', 'hd_owner_source_mismatch',
    'source_missing', 'source_unreadable', 'source_boundary', 'hd_scheduler_source_changed', 'hd_scheduler_contention',
    'media_storage_root_invalid', 'hd_readonly_query_required', 'readonly_database_missing'];
  const message = messages.includes(raw) ? raw : code === 'ERR_ASSERTION'
    ? `assertion failed (actual=${scalar(value.actual)} expected=${scalar(value.expected)})`
    : code === 'P2021' ? 'synthetic database table unavailable' : code === 'P2022' ? 'synthetic database column unavailable'
      : code?.startsWith('P') ? 'synthetic database request failed'
        : code && ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_UNKNOWN_BUILTIN_MODULE', 'ERR_DLOPEN_FAILED'].includes(code)
          ? 'required native runtime unavailable' : 'unclassified synthetic proof error';
  return { name, code, message, messageSha256: createHash('sha256').update(raw).digest('hex') };
}

async function main() {
  if (process.env.AUD_SCALE_SYNTHETIC_SERVER !== '1' || process.env.NODE_ENV !== 'test') throw new Error('lead_isolated_server_opt_in_required');
  process.env.FEISHU_FEEDBACK_ENABLED = 'false';
  phase = 'temporary_database';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aud-scale-synthetic-'));
  const file = path.join(directory, 'synthetic.db');
  const { DatabaseSync } = createRequire(path.join(process.cwd(), 'package.json'))('node:sqlite') as {
    DatabaseSync: new (file: string) => { close(): void };
  };
  new DatabaseSync(file).close();
  process.env.DATABASE_URL = `file:${file}?connection_limit=9`;
  phase = 'runtime_imports';
  const { prisma } = await import('../src/lib/prisma');
  const { prisma: alias } = await import('../src/lib/db');
  const { feedbackPrisma } = await import('../src/lib/feedback/notification');
  const { hdReadRepository } = await import('../src/lib/media/hd-readonly-db');
  const { databaseClientState } = await import('../src/lib/database/client');
  const { lookupLegacyHdOwner, validateHdOwner } = await import('../src/lib/media/hd-owner');
  const { databaseObservations } = await import('../src/lib/database/observations');
  const { requestHd, readHdJob } = await import('../src/lib/media/hd-derivatives');
  const originalCwd = process.cwd(), originalHdRoot = process.env.HD_DERIVATIVES_ROOT, originalMediaRoot = process.env.MEDIA_DATA_ROOT;
  let failed = false;
  try {
    phase = 'shared_client_aliases';
    assert.equal(alias, prisma); assert.equal(feedbackPrisma, prisma);
    phase = 'synthetic_schema';
    await prisma.$executeRawUnsafe('CREATE TABLE Asset (id TEXT PRIMARY KEY, owner_id TEXT, status TEXT, type TEXT, original_url TEXT, metadata_json TEXT, created_at DATETIME DEFAULT 0)');
    await prisma.$executeRawUnsafe('CREATE INDEX Asset_original_url_idx ON Asset(original_url)');
    await prisma.$executeRawUnsafe('CREATE INDEX Asset_status_idx ON Asset(status)');
    await prisma.$executeRawUnsafe('CREATE TABLE ReferenceImage (id TEXT PRIMARY KEY, owner_user_id TEXT, status TEXT, asset_id TEXT, album_id TEXT, url TEXT)');
    await prisma.$executeRawUnsafe('CREATE INDEX ReferenceImage_url_idx ON ReferenceImage(url)');
    await prisma.$executeRawUnsafe('CREATE TABLE ReferenceAlbum (id TEXT PRIMARY KEY, status TEXT)');
    phase = 'synthetic_seed';
    await prisma.$executeRawUnsafe(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000)
      INSERT INTO Asset SELECT 'asset-'||x, 'owner', 'active', 'image', '/uploads/'||x||'.png', '{}', 0 FROM n`);
    await prisma.$executeRawUnsafe("INSERT INTO Asset VALUES ('wanted', 'owner', 'active', 'image', '/uploads/wanted.png', '{}', 0)");
    await prisma.$executeRawUnsafe("INSERT INTO ReferenceAlbum VALUES ('album', 'active')");
    await prisma.$executeRawUnsafe("INSERT INTO ReferenceImage VALUES ('ref', 'author', 'active', NULL, 'album', '/uploads/reference.png')");
    phase = 'explain_index';
    const plan = await prisma.$queryRawUnsafe<Array<{ detail: string }>>("EXPLAIN QUERY PLAN SELECT id FROM Asset WHERE original_url IN ('/uploads/wanted.png') LIMIT 2");
    assert.ok(plan.some(row => /SEARCH.*Asset_original_url_idx/.test(row.detail)), plan.map(row => row.detail).join('\n'));
    phase = 'legacy_owner_lookup';
    const owner = await lookupLegacyHdOwner('/uploads/wanted.png', 'v1');
    assert.equal(owner.kind, 'asset'); assert.equal('ownerId' in owner && owner.ownerId, 'owner');
    phase = 'owner_mismatch_rejection';
    await assert.rejects(validateHdOwner('/uploads/wanted.png', 'v1', { kind: 'asset', id: 'wanted', ownerId: 'different' }));
    // Exercise real requestHd/source stat/manifest/scheduler paths, not encoding.
    // Only generated bytes and this disposable directory are involved.
    phase = 'request_hd_source_setup';
    process.chdir(directory); process.env.HD_DERIVATIVES_ROOT = path.join(directory, 'hd');
    process.env.MEDIA_DATA_ROOT = path.join(directory, '.media');
    await fs.mkdir(path.join(directory, '.media/uploads'), { recursive: true });
    const sourceFile = path.join(directory, '.media/uploads/wanted.png');
    await fs.writeFile(sourceFile, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex'));
    phase = 'request_hd_owner_rejection';
    await assert.rejects(requestHd('/uploads/wanted.png', 0, false, undefined,
      { owner: { kind: 'asset', id: 'wanted', ownerId: 'different' } }));
    phase = 'request_hd_manifest';
    const first = (await requestHd('/uploads/wanted.png', 0, false, undefined,
      { owner: { kind: 'asset', id: 'wanted', ownerId: 'owner' } }))!;
    assert.equal(first.ownerEvidence?.ownerId, 'owner');
    assert.equal((await readHdJob(first.key))?.ownerEvidence?.sourceVersion, first.version);
    phase = 'source_version_fence';
    await fs.appendFile(sourceFile, Buffer.from([0]));
    const changed = (await requestHd('/uploads/wanted.png', 0, false, undefined,
      { owner: { kind: 'asset', id: 'wanted', ownerId: 'owner' } }))!;
    assert.notEqual(changed.key, first.key);
    assert.equal((await readHdJob(first.key))?.version, first.version);
    process.chdir(originalCwd);
    phase = 'transaction_fixture';
    await prisma.$executeRawUnsafe('CREATE TABLE AuditScaleCounter (id INTEGER PRIMARY KEY, value INTEGER)');
    await prisma.$executeRawUnsafe('INSERT INTO AuditScaleCounter VALUES (1,0)');
    phase = 'array_transactions';
    await Promise.all(Array.from({ length: 32 }, () => prisma.$transaction([
      prisma.$executeRawUnsafe('UPDATE AuditScaleCounter SET value=value+1 WHERE id=1'),
      prisma.$queryRawUnsafe('SELECT value FROM AuditScaleCounter WHERE id=1'),
    ])));
    phase = 'interactive_transaction';
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('UPDATE AuditScaleCounter SET value=value+1 WHERE id=1');
      const counter = await tx.$queryRawUnsafe<Array<{ value: bigint }>>('SELECT value FROM AuditScaleCounter WHERE id=1');
      assert.equal(Number(counter[0].value), 33);
    });
    const pragmas = async () => ({
      busy: await prisma.$queryRawUnsafe<Array<{ timeout: bigint }>>('PRAGMA busy_timeout'),
      journal: await prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>('PRAGMA journal_mode'),
      sync: await prisma.$queryRawUnsafe<Array<{ synchronous: bigint }>>('PRAGMA synchronous'),
    });
    phase = 'writer_pragmas';
    let values = await pragmas();
    assert.equal(Number(values.busy[0].timeout), 10000); assert.equal(values.journal[0].journal_mode, 'wal'); assert.equal(Number(values.sync[0].synchronous), 1);
    phase = 'readonly_hash_before';
    await prisma.$disconnect();
    const before = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    phase = 'readonly_reads';
    assert.equal(await hdReadRepository.countActiveImageAssets(), 10001);
    assert.equal((await hdReadRepository.referenceById('ref'))?.album.status, 'active');
    assert.equal(databaseClientState().mode, 'read');
    phase = 'readonly_facade_guards';
    for (const method of ['$executeRawUnsafe', '$queryRaw', '$transaction', '$extends']) {
      assert.throws(() => (hdReadRepository as unknown as Record<string, () => void>)[method]());
    }
    assert.throws(() => (hdReadRepository as unknown as { asset: { create: () => void } }).asset.create());
    phase = 'readonly_hash_after';
    await hdReadRepository.close();
    assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'), before);
    phase = 'writer_reconnect';
    values = await pragmas();
    assert.equal(Number(values.busy[0].timeout), 10000); assert.equal(values.journal[0].journal_mode, 'wal');
    phase = 'client_observations';
    assert.equal(databaseClientState().clientsConstructed, 1);
    assert.equal(databaseClientState().sqliteConnectionLimit, 1);
    assert.ok(databaseObservations().minutes.reduce((sum, row) => sum + row.transactions, 0) >= 33);
    console.log(JSON.stringify({ syntheticOnly: true, assets: 10001, concurrentArrayTransactions: 32,
      interactiveTransactions: 1, indexedLookup: true, realRequestHdManifestPath: true, sourceVersionFenced: true,
      readonlyMainFileUnchanged: true, client: databaseClientState() }));
  } catch (error) { failed = true; throw error; }
  finally {
    try {
      process.chdir(originalCwd);
      if (originalHdRoot === undefined) delete process.env.HD_DERIVATIVES_ROOT; else process.env.HD_DERIVATIVES_ROOT = originalHdRoot;
      if (originalMediaRoot === undefined) delete process.env.MEDIA_DATA_ROOT; else process.env.MEDIA_DATA_ROOT = originalMediaRoot;
      await prisma.$disconnect(); await fs.rm(directory, { recursive: true, force: true });
    } catch (error) {
      if (!failed) { phase = 'cleanup'; throw error; }
      console.error(JSON.stringify({ error: 'audit_scale_cleanup_failed', phase: 'cleanup', cause: safeScaleProofCause(error) }));
    }
  }
}
void main().catch(error => { console.error(JSON.stringify({ error: 'audit_scale_server_proof_failed', phase, cause: safeScaleProofCause(error) })); process.exitCode = 1; });
