import { readFullLiveSourceFiles, verifyFullCandidateSources, fullSchemaBefore } from './full-release-contract.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rootFile, sha, call, writeJsonExclusive, assertReleaseWindow, isSharedEngine, engineDirectory } from './common.mjs';
import { verifyCanvasBatchCandidates, readCanvasBatchMigration } from './canvas-batch-schema.mjs';
import { verifyDeployedContinuationProvenance, verifySharedBuildProvenance } from './normal-continuation.mjs';
import { assertRecoveredGuardInput, readRecoveredGuardBaseline, assertRecoveredGuardLive } from './recovered-guard-baseline.mjs';

export const DEPLOYED_SCHEMA = 'sd2-deployed-usage-schema-input.v1';
export const DEPLOYED_FIELDS = ['schema', 'publicationRun', 'publicationManifestSha256', 'switchCompleteSha256',
  'finalProofSha256', 'finalProofCommandSha256', 'migrationRun', 'migrationManifestSha256', 'migrationBeforeSha256',
  'migrationReceiptSha256', 'backupProofSha256', 'backupSha256'];
export const SCHEMA_FILES = ['prisma/migrations/20261021073000_usage_attribution/migration.sql',
  'ops/sd2-usage-attribution-migrate.py', 'prisma/schema.prisma', 'ops/sd2-usage-role-start.mjs'];
const ROLE_ROOT = '/data/video-api-debugger/controls/usage-role-writer-v1';
const ROLE_SOURCE = '/etc/systemd/system/sd2-role-coordinator.service.d/admin-usage-source.conf';
// 旧 role 来源取自已封存的首次 guard 启动链，不能从已经换成新 pair 的可变 allowlist 反查。
const FULL_PRIOR_ROLE = Object.freeze({ runId: '15fe9bbb-c012-4dae-9a86-6e473e259c67',
  manifestSha256: 'bb99fc3eae449e09c2dc05d0ee0a74a33461cf88ce0a5cdb3da55babddbc5156',
  startSha256: 'd5528e80378d6643dec35f84bf17c4a1ca5cad4a30c833ecadab691ca5eae25d',
  activeSha256: '0b7980a568cb9e880f6e3cbd5c1b3903f29fd2ff5a75671dcab61dc2c788b8d4',
  allowedSha256: '50c1dd232fd6069055354e4c18bd862ee13006c3f23dd8f8306de73eea7bb0be' });
const stageFor = run => '/data/video-api-debugger/release-staging/' + run;
const json = file => JSON.parse(rootFile(file));
const receiptFile = m => m.stage + '/usage-attribution-deployed-schema-adopt.json';

export function assertDeployedSchemaInput(value) {
  assert.deepEqual(Object.keys(value).sort(), [...DEPLOYED_FIELDS].sort());
  assert.equal(value.schema, DEPLOYED_SCHEMA);
  for (const key of ['publicationRun', 'migrationRun'])
    assert.match(value[key], /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  for (const key of DEPLOYED_FIELDS.filter(key => key.endsWith('Sha256'))) assert.match(value[key], /^[a-f0-9]{64}$/);
  return value;
}
function pinned(file, expected) {
  const bytes = rootFile(file); assert.equal(sha(bytes), expected, 'Pinned deployed-schema history changed: ' + path.basename(file));
  return JSON.parse(bytes);
}
function stageIdentity(stage) {
  assert.equal(fs.realpathSync(stage), stage);
  const stat = fs.lstatSync(stage);
  assert.ok(stat.isDirectory() && stat.uid === 0 && !(stat.mode & 0o077));
  assert.equal(call('findmnt', ['-n', '-o', 'TARGET', '-T', stage]), '/data');
}
function bound(value, runId, manifestSha256) {
  assert.equal(value.runId, runId); assert.equal(value.manifestSha256, manifestSha256); return value;
}
function completedTime(value) {
  const at = Date.parse(value); assert.ok(Number.isFinite(at) && at <= Date.now()); return at;
}
function publicationPair(prior, final) {
  const bytes = Buffer.from(final.pricingStartControl.allowed.bytesBase64, 'base64');
  assert.equal(sha(bytes), final.pricingStartControl.allowed.sha256);
  const pair = JSON.parse(bytes);
  assert.equal(pair.schema, 'pricing-writer-start-allowlist.v1'); assert.equal(pair.project, 'video-api-debugger');
  assert.equal(pair.runId, prior.runId); assert.equal(pair.releases.length, 2);
  assert.equal(final.writerStartIntent.schema, 'pricing-new-writer-start-intent.v1');
  assert.equal(final.writerStartIntent.runId, prior.runId); assert.equal(final.writerStartIntent.allowedSha256, sha(bytes));
  for (const kind of ['main', 'guard']) {
    const entry = pair.releases.find(value => value.source === prior[kind].source); assert.ok(entry);
    assert.equal(entry.root, prior[kind].root); assert.equal(entry.version, prior[kind].version);
    assert.ok(typeof entry.build === 'string' && entry.build);
  }
  return pair;
}
export function assertRetainedProofCommand(final, command) {
  assert.equal(command.status, 0); assert.equal(command.signal, null); assert.equal(command.error, null);
  const start = completedTime(command.start), finish = completedTime(command.finish), at = completedTime(final.at);
  assert.ok(start <= at && at <= finish, 'Prior proof is not within its original successful command');
}
export function assertPriorPublication(m, prior, complete, final, original, receipt, proof, initial) {
  const input = assertDeployedSchemaInput(m.deployedUsageSchema);
  if (m.recoveredGuardBaseline) assertRecoveredGuardInput(m.recoveredGuardBaseline);
  if (isSharedEngine(m)) {
    engineDirectory(m);
    if (m.reuseBuilds) verifySharedBuildProvenance(m);
  } else if (m.normalContinuation || m.reuseBuilds) verifyDeployedContinuationProvenance(m);
  assert.notEqual(m.mainSource, m.guardSource);
  for (const kind of ['main', 'guard']) {
    assert.equal(m[kind].source, m[kind + 'Source']);
    assert.equal(m[kind].root, '/data/video-api-debugger/managed-releases/' + m[kind].source);
  }
  assert.notEqual(m.runId, input.publicationRun); assert.notEqual(m.runId, input.migrationRun);
  assert.equal(prior.runId, input.publicationRun); assert.equal(prior.stage, stageFor(prior.runId));
  assert.equal(prior.schema, 'rate-impl2-release.v1'); assert.equal(prior.project, 'video-api-debugger');
  assert.equal(complete.schema, 'rate-impl2-switch-complete.v1');
  bound(complete, prior.runId, input.publicationManifestSha256);
  assert.equal(complete.mode, 'switch'); assert.equal(complete.kind, 'main');
  assert.equal(complete.databaseRestored, false); assert.equal(complete.oldPairRestored, false);
  assert.equal(complete.healthy.actualHealthy, true);
  assert.equal(complete.healthy.source, prior.mainSource); assert.equal(complete.healthy.releaseVersion, prior.main.version);
  assert.equal(complete.healthy.build, complete.web.build);
  assert.equal(final.schema, 'rate-impl2-switch-proof.v1'); assert.equal(final.readOnly, true);
  bound(final, prior.runId, input.publicationManifestSha256);
  const pair = publicationPair(prior, final);
  assert.equal(pair.releases.find(value => value.source === prior.mainSource).build, complete.healthy.build);
  assert.ok(completedTime(final.at) >= completedTime(complete.at));
  for (const role of ['web', 'image', 'hd', 'role']) {
    const live = m.live[role], current = role === 'role' ? final.role.current : final.units[role];
    assert.equal(current.ActiveState, 'active'); assert.equal(current.SubState, 'running'); assert.equal(current.ControlPID, '0');
    assert.equal(current.WorkingDirectory, prior.main.root);
    if (!m.recoveredGuardBaseline && !m.fullRelease) {
      assert.equal(live.root, prior.main.root); assert.equal(live.source, prior.mainSource);
      assert.equal(live.version, prior.main.version); assert.equal(live.build, complete.healthy.build);
    }
    assert.equal(role === 'role' ? complete.role.source : complete[role].source, prior.mainSource);
  }
  assert.equal(complete.web.version, prior.main.version); assert.equal(complete.image.version, prior.main.version);
  assert.equal(complete.image.build, complete.healthy.build);
  assert.equal(final.role.allTransitionsBound, true); assert.equal(final.role.forcedKill, false);
  assert.equal(original.schema, 'rate-impl2-release.v1'); assert.equal(original.project, 'video-api-debugger');
  assert.equal(original.runId, input.migrationRun); assert.equal(original.stage, stageFor(original.runId));
  for (const manifest of [prior, original]) {
    assert.equal(manifest.database, m.database);
    for (const kind of ['main', 'guard']) {
      assert.equal(manifest[kind].source, manifest[kind + 'Source']);
      assert.match(manifest[kind].source, /^[a-f0-9]{40}$/);
      assert.equal(manifest[kind].root, '/data/video-api-debugger/managed-releases/' + manifest[kind].source);
      assert.ok(![m.mainSource, m.guardSource].includes(manifest[kind].source), 'New pair must not reuse historical publication/migration sources');
    }
  }
  assert.equal(receipt.schema, 'sd2-usage-attribution-migration.v1'); assert.equal(receipt.completed, true);
  bound(receipt, original.runId, input.migrationManifestSha256);
  assert.equal(receipt.source, original.mainSource); assert.equal(receipt.guardSource, original.guardSource);
  assert.equal(receipt.businessRowsWritten, 0); assert.equal(receipt.historyBackfilled, false); assert.equal(receipt.originalSchemaPreserved, true);
  assert.ok(completedTime(receipt.at) <= completedTime(complete.at));
  assert.equal(proof.runId, original.runId); assert.equal(proof.consistent, true); assert.equal(proof.integrity, 'ok');
  for (const key of ['source', 'guardSource', 'manifestSha256', 'sqlSha256', 'backupSha256']) assert.equal(proof[key], receipt[key]);
  assert.equal(receipt.backupSha256, input.backupSha256);
  bound(initial, original.runId, input.migrationManifestSha256);
  const identity = initial.protection.databaseIdentity;
  assert.ok(Array.isArray(identity) && identity.length === 2 && identity.every(part => /^\d+$/.test(part)));
  assert.deepEqual(complete.protection.databaseIdentity, identity); assert.deepEqual(final.protection.databaseIdentity, identity);
  return identity;
}
function history(m) {
  const input = assertDeployedSchemaInput(m.deployedUsageSchema), publication = stageFor(input.publicationRun), migration = stageFor(input.migrationRun);
  stageIdentity(publication); stageIdentity(migration);
  const prior = pinned(publication + '/manifest.json', input.publicationManifestSha256);
  const complete = pinned(publication + '/switch-complete.json', input.switchCompleteSha256);
  // proof() originally returned stdout only. Payload is copied byte-for-byte into THIS new run, never backfilled into history.
  const final = pinned(m.stage + '/deployed-usage-prior-proof.stdout', input.finalProofSha256);
  const proofCommand = pinned(m.stage + '/deployed-usage-prior-proof-command.json', input.finalProofCommandSha256);
  assertRetainedProofCommand(final, proofCommand);
  const original = pinned(migration + '/manifest.json', input.migrationManifestSha256);
  const receipt = pinned(migration + '/usage-attribution-migration/receipt.json', input.migrationReceiptSha256);
  const proof = pinned(migration + '/usage-attribution-migration/backup-proof.json', input.backupProofSha256);
  const initial = pinned(migration + '/switch-before.json', input.migrationBeforeSha256);
  const identity = assertPriorPublication(m, prior, complete, final, original, receipt, proof, initial);
  assert.equal(fs.readdirSync(publication).some(name => /^(?:rollback-|guard-recovery-(?:attempt|start|complete)|switch-failure-)/.test(name)), false,
    'Publication is not a completed normal main release');
  const backup = migration + '/usage-attribution-migration/consistent-backup.sqlite';
  assert.equal(sha(rootFile(backup, 4 * 1024 ** 3)), input.backupSha256);
  const runtimeAuthority = m.recoveredGuardBaseline ? readRecoveredGuardBaseline(m, identity)
    : { prior, final, roleKind: 'main', manifestSha256: input.publicationManifestSha256,
      entry: publicationPair(prior, final).releases.find(value => value.source === prior.mainSource) };
  if (m.recoveredGuardBaseline) for (const file of SCHEMA_FILES)
    assert.equal(runtimeAuthority.entry.sourceFiles[file], publicationPair(prior, final).releases.find(value => value.source === prior.mainSource).sourceFiles[file],
      'Recovered guard changed historical schema/start input: ' + file);
  // Both consumers below use this one authority; 6a remains schema history.
  return { prior, complete, final, proofCommand, original, receipt, proof, identity, backup, runtimeAuthority };
}
function verifiedRuntimeAuthority(value) {
  const authority = value.runtimeAuthority;
  assert.ok(['main', 'guard'].includes(authority.roleKind));
  assert.equal(authority.entry.source, authority.prior[authority.roleKind].source);
  assert.deepEqual(authority.entry, publicationPair(authority.prior, authority.final).releases
    .find(entry => entry.source === authority.entry.source));
  return authority;
}
export function assertCurrentPublishedBaseline(m) {
  if (m.fullRelease) return Object.fromEntries(['web', 'image', 'hd', 'works', 'role', 'template'].map(role =>
    [role, readFullLiveSourceFiles(m, ['package.json'], role)]));
  if (!m.recoveredGuardBaseline) return null;
  const value = history(m), authority = verifiedRuntimeAuthority(value);
  const result = assertRecoveredGuardLive(m, authority);
  assertPriorUsageRoleControl(m);
  return result;
}
export function readPublishedBaselineSourceFiles(m, files, role = 'web') {
  if (m.fullRelease) return readFullLiveSourceFiles(m, files, role);
  assert.ok(m.deployedUsageSchema, 'Published baseline requires pinned successful publication history');
  const value = history(m), entry = verifiedRuntimeAuthority(value).entry;
  assert.equal(entry.source, m.live.web.source);
  assert.equal(entry.root, m.live.web.root);
  assert.ok(Array.isArray(files) && files.length > 0 && new Set(files).size === files.length);
  const sourceFiles = Object.fromEntries(files.map(file => {
    assert.ok(file && !path.isAbsolute(file) && !file.split('/').some(part => !part || part === '.' || part === '..'));
    assert.ok(Object.hasOwn(entry.sourceFiles, file), 'Published source evidence missing: ' + file);
    assert.match(entry.sourceFiles[file], /^[a-f0-9]{64}$/);
    return [file, entry.sourceFiles[file]];
  }));
  return { source: entry.source, root: entry.root, sourceFiles,
    publicationRun: value.prior.runId,
    publicationManifestSha256: m.deployedUsageSchema.publicationManifestSha256,
    finalProofSha256: m.deployedUsageSchema.finalProofSha256,
    finalProofCommandSha256: m.deployedUsageSchema.finalProofCommandSha256,
    ...(m.recoveredGuardBaseline ? { recoveredGuard: value.runtimeAuthority.recovery } : {}) };
}
function candidateBytes(m, root, file) {
  assert.equal(fs.realpathSync(root), root);
  const target = root + '/' + file; assert.equal(fs.realpathSync(target), target);
  const stat = fs.lstatSync(target);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o777) === 0o644);
  assert.equal(stat.uid, Number(call('id', ['-u', m.appUser])));
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'ctimeMs', 'mtimeMs']) assert.equal(after[key], stat[key]);
    assert.equal(fs.lstatSync(target).ino, stat.ino); return bytes;
  } finally { fs.closeSync(fd); }
}
export function unchangedSchemaInputs(m, value, { candidates = true, batchMigration = null } = {}) {
  const reference = {}, pair = publicationPair(value.prior, value.final);
  const adoptedCanvas = Boolean(m.deployedCanvasBatchSchema);
  const canvasOriginal = batchMigration?.originalManifest;
  if (adoptedCanvas) assert.ok(canvasOriginal, 'Original canvas schema provenance is required');
  for (const file of SCHEMA_FILES) {
    reference[file] = pair.releases.find(entry => entry.source === value.prior.mainSource).sourceFiles[file];
    assert.match(reference[file], /^[a-f0-9]{64}$/);
    assert.equal(pair.releases.find(entry => entry.source === value.prior.guardSource).sourceFiles[file], reference[file]);
    if (file === 'prisma/schema.prisma' && adoptedCanvas) {
      assert.equal(reference[file], m.canvasVideoBatchSchema.newPrismaSha256);
      for (const root of new Set([value.original.main.root, value.original.guard.root, canvasOriginal.live.web.root]))
        assert.equal(sha(candidateBytes(m, root, file)), m.canvasVideoBatchSchema.previousPrismaSha256);
      for (const root of new Set([canvasOriginal.main.root, canvasOriginal.guard.root, value.prior.main.root, value.prior.guard.root,
        ...(candidates && !m.fullRelease ? [m.main.root, m.guard.root] : [])]))
        assert.equal(sha(candidateBytes(m, root, file)), m.canvasVideoBatchSchema.newPrismaSha256);
      continue;
    }
    const additivePrisma = file === 'prisma/schema.prisma' && Boolean(m.canvasVideoBatchSchema);
    for (const root of new Set([value.original.main.root, value.original.guard.root, value.prior.main.root, value.prior.guard.root,
      ...(adoptedCanvas ? [canvasOriginal.live.web.root, canvasOriginal.main.root, canvasOriginal.guard.root] : []),
      ...(candidates && !additivePrisma ? [m.main.root, m.guard.root] : [])]))
      assert.equal(sha(candidateBytes(m, root, file)), reference[file], 'Usage schema/migration/start helper changed: ' + file);
  }
  assert.equal(reference[SCHEMA_FILES[0]], value.receipt.sqlSha256);
  if (m.canvasVideoBatchSchema) {
    assert.equal(reference['prisma/schema.prisma'], adoptedCanvas ? m.canvasVideoBatchSchema.newPrismaSha256 : m.canvasVideoBatchSchema.previousPrismaSha256);
    if (candidates) {
      if (m.fullRelease) verifyFullCandidateSources(m); else verifyCanvasBatchCandidates(m);
    }
  }
  return reference;
}
export const DEPLOYED_PROBE = String.raw`
import sys,json,sqlite3,hashlib,os,pathlib
d=json.loads(sys.argv[1]) if len(sys.argv)>1 else json.load(sys.stdin)
db=d['database']; backup=d['backup']
def identity(p):
 assert not os.path.islink(p) and os.path.isfile(p)
 s=os.stat(p); assert s.st_nlink==1
 return [str(s.st_dev),str(s.st_ino)]
def schema(c):
 return {r[0]:[r[1],r[2],r[3]] for r in c.execute("SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")}
def digest(o): return hashlib.sha256(json.dumps(o,separators=(',',':'),ensure_ascii=True).encode()).hexdigest()
names=['UsageAttribution','UsageAttribution_owner_user_id_occurred_at_idx','UsageAttribution_project_id_occurred_at_idx','UsageAttribution_occurred_at_idx']
assert identity(db)==d['identity']
def ro(p):
 c=sqlite3.connect(pathlib.Path(p).as_uri()+'?mode=ro',uri=True,timeout=30)
 c.execute('PRAGMA query_only=ON'); c.execute('BEGIN'); return c
with ro(backup) as b:
 assert b.execute('PRAGMA integrity_check').fetchall()==[('ok',)]
 old=schema(b); assert not set(names).intersection(old)
 counts={n:b.execute('SELECT COUNT(*) FROM "'+n.replace('"','""')+'"').fetchone()[0] for n,v in old.items() if v[0]=='table'}
 assert counts==d['backupCounts']
with ro(db) as c:
 current=d.get('fullSchemaBefore') or schema(c); extra=d.get('canvasBatchObjects',{}); assert set(current)-set(old)==set(names)|set(extra)
 assert all(current.get(k)==v for k,v in extra.items())
 assert all(current.get(k)==v for k,v in old.items())
 new={n:current[n] for n in sorted(names)}
 assert digest(new)==d['schemaSha256']
 rows=c.execute('SELECT COUNT(*) FROM "UsageAttribution"').fetchone()[0]
 assert c.total_changes==0
assert identity(db)==d['identity']
print(json.dumps({'databaseIdentity':d['identity'],'newSchemaSha256':digest(new),'backupIntegrity':'ok','originalSchemaPreserved':True,'attributionRows':rows,'databaseWrites':0,'ddlExecuted':False}))
`;
export function verifyDeployedUsageSchema(m, { candidates = true } = {}) {
  if (!m.deployedUsageSchema) return null;
  const value = history(m);
  const batchMigration = readCanvasBatchMigration(m, { candidates });
  if (batchMigration) assert.deepEqual(batchMigration.receipt.databaseIdentity, value.identity);
  const sourceSha256 = unchangedSchemaInputs(m, value, { candidates, batchMigration });
  assert.equal(call('findmnt', ['-n', '-o', 'TARGET', '-T', m.database]), '/data');
  const observed = JSON.parse(call('python3', ['-I', '-c', DEPLOYED_PROBE], { timeout: 120000, input: JSON.stringify({ database: m.database,
    backup: value.backup, identity: value.identity, schemaSha256: value.receipt.newSchemaSha256,
    backupCounts: value.proof.originalTableCounts, fullSchemaBefore: fullSchemaBefore(m), canvasBatchObjects: batchMigration?.observed.objects || {} }) }));
  assert.deepEqual(observed.databaseIdentity, value.identity); assert.equal(observed.newSchemaSha256, value.receipt.newSchemaSha256);
  assert.equal(observed.databaseWrites, 0); assert.equal(observed.ddlExecuted, false);
  return { ...value, sourceSha256, observed };
}
function references(m, value) {
  return { ...(m.recoveredGuardBaseline ? { runtimeBaseline: value.runtimeAuthority.recovery } : {}),
  publication: { runId: value.prior.runId, at: value.complete.at, manifestSha256: m.deployedUsageSchema.publicationManifestSha256,
    switchCompleteSha256: m.deployedUsageSchema.switchCompleteSha256, finalProofSha256: m.deployedUsageSchema.finalProofSha256,
    finalProofCommandSha256: m.deployedUsageSchema.finalProofCommandSha256,
    proofOrigin: 'original-retained-command-stdout', originalProofAt: value.final.at,
    originalCommandStart: value.proofCommand.start, originalCommandFinish: value.proofCommand.finish,
    stagedInNewRun: m.runId, historicalRunWritten: false },
  original: { runId: value.receipt.runId, at: value.receipt.at, manifestSha256: value.receipt.manifestSha256,
    receiptSha256: m.deployedUsageSchema.migrationReceiptSha256, backupProofSha256: m.deployedUsageSchema.backupProofSha256,
    beforeSha256: m.deployedUsageSchema.migrationBeforeSha256, sqlSha256: value.receipt.sqlSha256, backupSha256: value.receipt.backupSha256 } };
}
export function adoptDeployedUsageSchema(m, { candidates = true } = {}) {
  assertReleaseWindow(m);
  if (fs.existsSync(receiptFile(m))) return readDeployedUsageEvidence(m);
  const value = verifyDeployedUsageSchema(m, { candidates });
  const receipt = { schema: 'sd2-deployed-usage-schema-adopt.v1', operation: 'VERIFY-DEPLOYED-SCHEMA', runId: m.runId,
    manifestSha256: sha(rootFile(m.stage + '/manifest.json')), source: m.mainSource, guardSource: m.guardSource,
    verifiedAt: new Date().toISOString(), completed: true, ddlExecuted: false, databaseWrites: 0, businessRowsWritten: 0,
    historyBackfilled: false, newSchemaSha256: value.receipt.newSchemaSha256, sourceSha256: value.sourceSha256,
    ...references(m, value), observed: value.observed };
  writeJsonExclusive(receiptFile(m), receipt); call('chattr', ['+i', receiptFile(m)]); return receipt;
}
export function readDeployedUsageEvidence(m) {
  const value = verifyDeployedUsageSchema(m), receipt = json(receiptFile(m));
  assert.equal(receipt.schema, 'sd2-deployed-usage-schema-adopt.v1'); assert.equal(receipt.operation, 'VERIFY-DEPLOYED-SCHEMA');
  bound(receipt, m.runId, sha(rootFile(m.stage + '/manifest.json')));
  assert.equal(receipt.source, m.mainSource); assert.equal(receipt.guardSource, m.guardSource);
  assert.equal(receipt.completed, true); assert.equal(receipt.ddlExecuted, false); assert.equal(receipt.databaseWrites, 0);
  assert.equal(receipt.businessRowsWritten, 0); assert.equal(receipt.historyBackfilled, false);
  assert.equal(receipt.newSchemaSha256, value.receipt.newSchemaSha256); assert.deepEqual(receipt.sourceSha256, value.sourceSha256);
  for (const [key, ref] of Object.entries(references(m, value))) assert.deepEqual(receipt[key], ref);
  assert.deepEqual(receipt.observed.databaseIdentity, value.observed.databaseIdentity);
  assert.ok(completedTime(receipt.verifiedAt) >= completedTime(value.complete.at));
  assert.ok(call('lsattr', ['-d', receiptFile(m)]).split(/\s+/)[0].includes('i'));
  return receipt;
}
export function assertFullPriorUsageRoleControl(m, { prior, start, active }, proof, appUid) {
  assert.ok(m.fullRelease); const role = m.fullRelease.liveRoles.role;
  assert.equal(prior.runId, FULL_PRIOR_ROLE.runId); assert.equal(prior.stage, stageFor(prior.runId));
  assert.equal(prior.schema, 'rate-impl2-release.v1'); assert.equal(prior.project, 'video-api-debugger');
  for (const value of [start, active]) bound(value, prior.runId, FULL_PRIOR_ROLE.manifestSha256);
  assert.equal(start.sequence, 11); assert.equal(start.phase, 'start-intent'); assert.equal(start.kind, 'guard');
  assert.equal(active.sequence, 12); assert.equal(active.phase, 'active'); assert.equal(active.kind, 'guard');
  assert.equal(active.previousSha256, FULL_PRIOR_ROLE.startSha256);
  assert.equal(active.current.ActiveState, 'active'); assert.equal(active.current.SubState, 'running');
  assert.equal(active.current.ControlPID, '0'); assert.ok(Number(active.current.MainPID) > 1);
  assert.equal(active.current.WorkingDirectory, role.root); assert.equal(active.runtime.sourceRoot, role.root);
  assert.equal(active.runtime.version, role.version);
  for (const key of ['root', 'source', 'version']) assert.equal(prior.guard[key], role[key]);
  const published = start.published, contract = published.contract;
  assert.equal(contract.schema, 'sd2-usage-role-start.v1'); assert.equal(contract.runId, prior.runId);
  assert.equal(contract.appUid, appUid); assert.equal(contract.releases.length, 2);
  const allowed = Buffer.from(JSON.stringify(contract, null, 2) + '\n');
  assert.equal(sha(allowed), published.sha256); assert.equal(published.sha256, FULL_PRIOR_ROLE.allowedSha256);
  for (const kind of ['main', 'guard']) {
    const matches = contract.releases.filter(value => value.source === prior[kind].source); assert.equal(matches.length, 1);
    for (const key of ['root', 'source', 'version']) assert.equal(matches[0][key], prior[kind][key]);
  }
  const entry = contract.releases.find(value => value.source === role.source); assert.ok(entry);
  for (const key of ['root', 'source', 'version', 'build']) assert.equal(entry[key], role[key]);
  assert.equal(proof.root, role.root); assert.equal(proof.source, role.source);
  assert.deepEqual(proof.sourceFiles, entry.sourceSha256);
  const moduleSha256 = proof.sourceFiles['ops/sd2-usage-role-start.mjs'];
  assert.equal(moduleSha256, published.moduleSha256);
  const source = Buffer.from('# Usage origin writer ' + prior.runId + '\n[Service]\nWorkingDirectory=' + role.root
    + '\nExecStartPre=/usr/bin/node ' + ROLE_ROOT + '/start.mjs\n');
  return { allowed, source, moduleSha256, root: ROLE_ROOT, sourceFile: ROLE_SOURCE };
}
export function priorUsageRoleControl(m) {
  if (m.fullRelease) {
    const stage = stageFor(FULL_PRIOR_ROLE.runId); stageIdentity(stage);
    const records = { prior: pinned(stage + '/manifest.json', FULL_PRIOR_ROLE.manifestSha256),
      start: pinned(stage + '/usage-role-transition-0011.json', FULL_PRIOR_ROLE.startSha256),
      active: pinned(stage + '/usage-role-transition-0012.json', FULL_PRIOR_ROLE.activeSha256) };
    const entry = records.start.published.contract.releases.find(value => value.source === m.fullRelease.liveRoles.role.source);
    assert.ok(entry);
    const proof = readFullLiveSourceFiles(m, Object.keys(entry.sourceSha256), 'role');
    return assertFullPriorUsageRoleControl(m, records, proof, Number(call('id', ['-u', m.appUser])));
  }
  const value = history(m), { prior, final, roleKind, manifestSha256 } = verifiedRuntimeAuthority(value), { receipt } = value;
  const starts = final.role.transitions.filter(entry => entry.phase === 'start-intent' && entry.kind === roleKind);
  assert.equal(starts.length, 1);
  const published = starts[0].published, contract = published.contract;
  bound(starts[0], prior.runId, manifestSha256);
  assert.equal(contract.schema, 'sd2-usage-role-start.v1'); assert.equal(contract.runId, prior.runId);
  assert.equal(contract.appUid, Number(call('id', ['-u', m.appUser])));
  assert.equal(contract.schemaSha256, receipt.newSchemaSha256); assert.equal(contract.releases.length, 2);
  for (const kind of ['main', 'guard']) {
    const candidate = contract.releases.find(entry => entry.source === prior[kind].source); assert.ok(candidate);
    assert.equal(candidate.root, prior[kind].root); assert.equal(candidate.version, prior[kind].version);
    assert.equal(candidate.sourceSha256['ops/sd2-usage-role-start.mjs'], published.moduleSha256);
    const paired = publicationPair(prior, final).releases.find(entry => entry.source === prior[kind].source);
    assert.equal(candidate.build, paired.build);
    assert.equal(published.moduleSha256, paired.sourceFiles['ops/sd2-usage-role-start.mjs']);
  }
  const allowed = Buffer.from(JSON.stringify(contract, null, 2) + '\n'); assert.equal(sha(allowed), published.sha256);
  const source = Buffer.from('# Usage origin writer ' + prior.runId + '\n[Service]\nWorkingDirectory=' + prior[roleKind].root
    + '\nExecStartPre=/usr/bin/node ' + ROLE_ROOT + '/start.mjs\n');
  return { allowed, source, moduleSha256: published.moduleSha256, root: ROLE_ROOT, sourceFile: ROLE_SOURCE };
}
export function assertPriorUsageRoleControl(m) {
  const expected = priorUsageRoleControl(m);
  assert.deepEqual(rootFile(expected.sourceFile), expected.source);
  assert.deepEqual(rootFile(expected.root + '/allowed.json'), expected.allowed);
  assert.equal(sha(rootFile(expected.root + '/start.mjs')), expected.moduleSha256);
  return expected;
}
