import assert from 'node:assert/strict';
import { assertProtectedIncrementCandidate } from './release-contract.mjs';
import fs from 'node:fs';
import { rootFile, sha, call, assertReleaseWindow, writeJsonExclusive, engineDirectory } from './common.mjs';
import { verifyDeployedContinuationProvenance } from './normal-continuation.mjs';
import { assertCanvasBatchSchemaInput, assertCanvasBatchPrismaExtension,
  CANVAS_BATCH_SQL, CANVAS_BATCH_MIGRATOR, CANVAS_BATCH_MODE } from './canvas-batch-schema-contract.mjs';

const receiptPath = m => m.stage + '/canvas-video-batches-migration/receipt.json';
export const DEPLOYED_CANVAS_FIELDS = ['schema', 'migrationRun', 'migrationManifestSha256',
  'migrationReceiptSha256', 'backupProofSha256', 'backupSha256'];
export function assertDeployedCanvasInput(value) {
  assert.deepEqual(Object.keys(value).sort(), [...DEPLOYED_CANVAS_FIELDS].sort());
  assert.equal(value.schema, 'sd2-deployed-canvas-video-batch-schema-input.v1');
  assert.match(value.migrationRun, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  for (const key of DEPLOYED_CANVAS_FIELDS.filter(key => key.endsWith('Sha256'))) assert.match(value[key], /^[a-f0-9]{64}$/);
  return value;
}
const stageFor = run => '/data/video-api-debugger/release-staging/' + run;
const adoptionPath = m => m.stage + '/canvas-video-batches-deployed-schema-adopt.json';
function pinned(file, expected) {
  const bytes = rootFile(file); assert.equal(sha(bytes), expected, 'Original canvas schema evidence changed: ' + file);
  return JSON.parse(bytes);
}
function sourceBytes(root, file) {
  assert.equal(fs.realpathSync(root), root);
  const target = root + '/' + file;
  assert.equal(fs.realpathSync(target), target);
  const stat = fs.lstatSync(target);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && !(stat.mode & 0o022));
  return fs.readFileSync(target);
}
function privateStage(stage) {
  assert.equal(fs.realpathSync(stage), stage);
  const stat = fs.lstatSync(stage);
  assert.ok(stat.isDirectory() && stat.uid === 0 && !(stat.mode & 0o077));
  assert.equal(call('findmnt', ['-n', '-o', 'TARGET', '-T', stage]), '/data');
}
export function readOriginalCanvasBatchMigration(m) {
  const input = assertDeployedCanvasInput(m.deployedCanvasBatchSchema);
  assert.ok(m.canvasVideoBatchSchema && m.deployedUsageSchema);
  if (m.normalContinuation || m.reuseBuilds) verifyDeployedContinuationProvenance(m);
  assert.notEqual(m.runId, input.migrationRun);
  const stage = stageFor(input.migrationRun); privateStage(stage);
  const original = pinned(stage + '/manifest.json', input.migrationManifestSha256);
  assert.equal(original.schema, 'rate-impl2-release.v1'); assert.equal(original.project, 'video-api-debugger');
  assert.equal(original.runId, input.migrationRun); assert.equal(original.stage, stage);
  assert.equal(original.database, m.database);
  assert.deepEqual(original.canvasVideoBatchSchema, m.canvasVideoBatchSchema);
  assert.equal(original.deployedCanvasBatchSchema || null, null, 'Original evidence must be the first real migration');
  const publicationStage = stageFor(m.deployedUsageSchema.publicationRun); privateStage(publicationStage);
  const publication = pinned(publicationStage + '/manifest.json', m.deployedUsageSchema.publicationManifestSha256);
  assert.equal(publication.runId, m.deployedUsageSchema.publicationRun);
  assert.equal(publication.stage, publicationStage); assert.equal(publication.database, m.database);
  assert.equal(publication.schema, 'rate-impl2-release.v1'); assert.equal(publication.project, 'video-api-debugger');
  assert.deepEqual(publication.canvasVideoBatchSchema, m.canvasVideoBatchSchema);
  if (publication.runId !== original.runId) assert.deepEqual(publication.deployedCanvasBatchSchema, input);
  else assert.equal(input.migrationManifestSha256, m.deployedUsageSchema.publicationManifestSha256);
  const receipt = pinned(stage + '/canvas-video-batches-migration/receipt.json', input.migrationReceiptSha256);
  assert.equal(receipt.schema, 'sd2-canvas-video-batches-migration.v1');
  assert.equal(receipt.runId, original.runId); assert.equal(receipt.manifestSha256, input.migrationManifestSha256);
  assert.equal(receipt.source, original.mainSource); assert.equal(receipt.guardSource, original.guardSource);
  assert.equal(receipt.sqlSha256, m.canvasVideoBatchSchema.sqlSha256);
  assert.equal(receipt.completed, true); assert.equal(receipt.businessRowsWritten, 0);
  assert.equal(receipt.historyBackfilled, false); assert.equal(receipt.originalSchemaPreserved, true);
  assert.equal(receipt.backupSha256, input.backupSha256);
  assert.ok(Number.isFinite(Date.parse(receipt.at)) && Date.parse(receipt.at) <= Date.now());
  assert.equal(receipt.newObjects.length, 11); assert.equal(new Set(receipt.newObjects).size, 11);
  const proof = pinned(stage + '/canvas-video-batches-migration/backup-proof.json', input.backupProofSha256);
  for (const key of ['runId', 'source', 'guardSource', 'manifestSha256', 'sqlSha256', 'backupSha256', 'originalSchemaSha256'])
    assert.equal(proof[key], receipt[key]);
  assert.equal(proof.integrity, 'ok'); assert.equal(proof.consistent, true);
  const backup = stage + '/canvas-video-batches-migration/consistent-backup.sqlite';
  assert.equal(sha(rootFile(backup, 4 * 1024 ** 3)), input.backupSha256);
  const prior = sourceBytes(original.live.web.root, 'prisma/schema.prisma');
  for (const kind of ['main', 'guard']) {
    assert.equal(original[kind].source, original[kind + 'Source']);
    assert.equal(original[kind].root, '/data/video-api-debugger/managed-releases/' + original[kind].source);
    assertCanvasBatchPrismaExtension(prior, sourceBytes(original[kind].root, 'prisma/schema.prisma'), m.canvasVideoBatchSchema);
    assert.equal(sha(sourceBytes(original[kind].root, CANVAS_BATCH_SQL)), m.canvasVideoBatchSchema.sqlSha256);
    assert.equal(sha(sourceBytes(original[kind].root, CANVAS_BATCH_MIGRATOR)), m.canvasVideoBatchSchema.migrationModuleSha256);
  }
  const observed = JSON.parse(call('python3', ['-I', '-c', CANVAS_BATCH_PROBE,
    JSON.stringify({ ...receipt, backup, database: m.database })], { timeout: 120000 }));
  assert.deepEqual(observed.databaseIdentity, receipt.databaseIdentity); assert.equal(observed.databaseWrites, 0);
  return { original, publication, receipt, proof, observed, backup };
}
function adoptionReferences(m, value) {
  return { ...m.deployedCanvasBatchSchema, originalAt: value.receipt.at };
}
function readAdoption(m, value, required) {
  if (!fs.existsSync(adoptionPath(m))) {
    assert.equal(required, false, 'Canvas batch schema has no completed deployed adoption receipt'); return null;
  }
  const receipt = JSON.parse(rootFile(adoptionPath(m)));
  assert.equal(receipt.schema, 'sd2-deployed-canvas-video-batch-schema-adopt.v1');
  assert.equal(receipt.operation, 'VERIFY-DEPLOYED-SCHEMA');
  for (const [key, expected] of Object.entries({ runId: m.runId, source: m.mainSource, guardSource: m.guardSource,
    manifestSha256: sha(rootFile(m.stage + '/manifest.json')), completed: true, ddlExecuted: false,
    databaseWrites: 0, businessRowsWritten: 0, historyBackfilled: false })) assert.equal(receipt[key], expected);
  assert.deepEqual(receipt.original, adoptionReferences(m, value));
  assert.deepEqual(receipt.databaseIdentity, value.receipt.databaseIdentity);
  assert.equal(receipt.newSchemaSha256, value.receipt.newSchemaSha256);
  assert.ok(Number.isFinite(Date.parse(receipt.verifiedAt)) && Date.parse(receipt.verifiedAt) >= Date.parse(value.receipt.at)
    && Date.parse(receipt.verifiedAt) <= Date.now());
  assert.ok(call('lsattr', ['-d', adoptionPath(m)]).split(/\s+/)[0].includes('i'));
  return receipt;
}
export function verifyCanvasBatchCandidates(m) {
  if (!m.canvasVideoBatchSchema) return null;
  const input = assertCanvasBatchSchemaInput(m.canvasVideoBatchSchema);
  const previous = fs.readFileSync(m.live.web.root + '/prisma/schema.prisma');
  for (const kind of ['main', 'guard']) {
    const root = m[kind].root;
    const protectedIncrement = assertProtectedIncrementCandidate(m, kind, file => {
      const sourceRoot = [m[kind].root, m.live.web.root].find(candidate => file.startsWith(candidate + '/'));
      assert.ok(sourceRoot); return sourceBytes(sourceRoot, file.slice(sourceRoot.length + 1));
    });
    assert.equal(fs.realpathSync(root), root);
    if (m.deployedCanvasBatchSchema) {
      assert.equal(sha(previous), input.newPrismaSha256);
      assert.equal(sha(sourceBytes(root, 'prisma/schema.prisma')), input.newPrismaSha256);
    } else assertCanvasBatchPrismaExtension(previous, fs.readFileSync(root + '/prisma/schema.prisma'), input);
    assert.equal(sha(fs.readFileSync(root + '/' + CANVAS_BATCH_SQL)), input.sqlSha256);
    assert.equal(sha(fs.readFileSync(root + '/' + CANVAS_BATCH_MIGRATOR)), input.migrationModuleSha256);
    assert.equal(fs.readFileSync(root + '/' + CANVAS_BATCH_MODE, 'utf8').trim(),
      `export const CANVAS_VIDEO_BATCH_WRITES_ENABLED: boolean = ${!protectedIncrement && kind === 'main' ? 'true' : 'false'};`);
    assert.equal(sha(fs.readFileSync(root + '/ops/canvas-video-batch-schema-extension.mjs')),
      sha(rootFile(engineDirectory(m) + '/canvas-batch-schema-contract.mjs')));
  }
  return input;
}

export const CANVAS_BATCH_PROBE = String.raw`
import sys,json,sqlite3,hashlib,pathlib,os
d=json.loads(sys.argv[1])
def ro(p):
 c=sqlite3.connect(pathlib.Path(p).as_uri()+'?mode=ro',uri=True,timeout=30)
 c.execute('PRAGMA query_only=ON');c.execute('BEGIN');return c
def schema(c):
 return {r[0]:[r[1],r[2],r[3]] for r in c.execute("SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")}
def digest(o):return hashlib.sha256(json.dumps(o,separators=(',',':'),ensure_ascii=True).encode()).hexdigest()
with ro(d['backup']) as b:
 assert b.execute('PRAGMA integrity_check').fetchall()==[('ok',)]
 original=schema(b)
 assert digest(original)==d['originalSchemaSha256']
 assert not set(d['newObjects']).intersection(original)
with ro(d['database']) as c:
 current=schema(c)
 assert set(current)-set(original)==set(d['newObjects'])
 assert all(current.get(k)==v for k,v in original.items())
 added={n:current[n] for n in sorted(d['newObjects'])}
 assert digest(added)==d['newSchemaSha256']
 assert c.total_changes==0
s=os.stat(d['database']);assert [str(s.st_dev),str(s.st_ino)]==d['databaseIdentity']
print(json.dumps({'objects':added,'databaseIdentity':d['databaseIdentity'],'databaseWrites':0,'backupIntegrity':'ok'}))
`;

export function readCanvasBatchMigration(m, { required = false, candidates = true } = {}) {
  if (!m.canvasVideoBatchSchema) return null;
  if (candidates) verifyCanvasBatchCandidates(m);
  if (m.deployedCanvasBatchSchema) {
    const value = readOriginalCanvasBatchMigration(m);
    return { receipt: value.receipt, observed: value.observed, adoption: readAdoption(m, value, required), originalManifest: value.original };
  }
  if (!fs.existsSync(receiptPath(m))) { assert.equal(required, false, 'Canvas batch schema has no completed original migration receipt'); return null; }
  const receipt = JSON.parse(rootFile(receiptPath(m)));
  assert.equal(receipt.schema, 'sd2-canvas-video-batches-migration.v1');
  assert.equal(receipt.runId, m.runId); assert.equal(receipt.source, m.mainSource); assert.equal(receipt.guardSource, m.guardSource);
  assert.equal(receipt.manifestSha256, sha(rootFile(m.stage + '/manifest.json')));
  assert.equal(receipt.sqlSha256, m.canvasVideoBatchSchema.sqlSha256);
  assert.equal(receipt.completed, true); assert.equal(receipt.businessRowsWritten, 0);
  assert.equal(receipt.historyBackfilled, false); assert.equal(receipt.originalSchemaPreserved, true);
  assert.equal(receipt.newObjects.length, 11); assert.equal(new Set(receipt.newObjects).size, 11);
  const backup = m.stage + '/canvas-video-batches-migration/consistent-backup.sqlite';
  assert.equal(sha(rootFile(backup, 4 * 1024 ** 3)), receipt.backupSha256);
  const proof = JSON.parse(rootFile(m.stage + '/canvas-video-batches-migration/backup-proof.json'));
  for (const key of ['runId', 'source', 'guardSource', 'manifestSha256', 'sqlSha256', 'backupSha256', 'originalSchemaSha256'])
    assert.equal(proof[key], receipt[key]);
  assert.equal(proof.integrity, 'ok'); assert.equal(proof.consistent, true);
  const observed = JSON.parse(call('python3', ['-I', '-c', CANVAS_BATCH_PROBE, JSON.stringify({ ...receipt, backup, database: m.database })], { timeout: 120000 }));
  assert.deepEqual(observed.databaseIdentity, receipt.databaseIdentity); assert.equal(observed.databaseWrites, 0);
  return { receipt, observed };
}

export function applyCanvasBatchMigration(m, assertWritersStopped, check = assertReleaseWindow) {
  if (!m.canvasVideoBatchSchema) return null;
  check(m); assertWritersStopped(); verifyCanvasBatchCandidates(m);
  if (m.deployedCanvasBatchSchema) {
    const value = readOriginalCanvasBatchMigration(m);
    if (!fs.existsSync(adoptionPath(m))) {
      check(m); assertWritersStopped();
      writeJsonExclusive(adoptionPath(m), { schema: 'sd2-deployed-canvas-video-batch-schema-adopt.v1',
        operation: 'VERIFY-DEPLOYED-SCHEMA', runId: m.runId, source: m.mainSource, guardSource: m.guardSource,
        manifestSha256: sha(rootFile(m.stage + '/manifest.json')), completed: true, ddlExecuted: false,
        databaseWrites: 0, businessRowsWritten: 0, historyBackfilled: false, verifiedAt: new Date().toISOString(),
        databaseIdentity: value.receipt.databaseIdentity, newSchemaSha256: value.receipt.newSchemaSha256,
        original: adoptionReferences(m, value) });
      call('chattr', ['+i', adoptionPath(m)]);
    }
    assertWritersStopped(); check(m);
    return { receipt: value.receipt, observed: value.observed, adoption: readAdoption(m, value, true) };
  }
  const before = readCanvasBatchMigration(m);
  if (before) return before;
  call('python3', ['-I', m.main.root + '/' + CANVAS_BATCH_MIGRATOR,
    '--manifest', m.stage + '/manifest.json', '--manifest-sha256', sha(rootFile(m.stage + '/manifest.json')),
    '--sql-sha256', m.canvasVideoBatchSchema.sqlSha256, '--apply'], { timeout: 180000 });
  assertWritersStopped(); check(m);
  const value = readCanvasBatchMigration(m, { required: true });
  for (const name of ['receipt.json', 'backup-proof.json', 'consistent-backup.sqlite'])
    call('chattr', ['+i', m.stage + '/canvas-video-batches-migration/' + name]);
  return value;
}
