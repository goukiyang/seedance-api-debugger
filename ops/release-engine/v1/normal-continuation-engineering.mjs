import { releaseDependencyRoot } from './full-release-contract.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { isSharedEngine } from './engine-context.mjs';
import { MV_DIRECT } from './release-contract.mjs';
import { assertContinuationInput, assertNoCutoverEffects, restoredRefusalCurrentFiles, assertOriginalMigration, assertFreshLegacyCapture, assertFreshPricingCapture, CONTINUATION_V2, EXACT_UNPUBLISHED_PAIR, assertExactUnpublishedFacts, UNPUBLISHED_SCHEMA, verifyExactUnpublishedProvenance } from './normal-continuation.mjs';
import { assertFirstRuntimeAliasProvenance } from './candidate-reuse.mjs';
import { assertDeployedSchemaInput, DEPLOYED_FIELDS, DEPLOYED_SCHEMA } from './deployed-usage-schema.mjs';
import { assertDeployedCanvasInput, DEPLOYED_CANVAS_FIELDS } from './canvas-batch-schema.mjs';
import { assertCanvasBatchSchemaInput } from './canvas-batch-schema-contract.mjs';

assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
const source = fs.readFileSync(new URL('./normal-continuation.mjs', import.meta.url), 'utf8');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const priorRun = '10000000-0000-4000-8000-000000000001', currentRun = '10000000-0000-4000-8000-000000000002';
const priorStage = '/data/video-api-debugger/release-staging/' + priorRun;
const stage = '/data/video-api-debugger/release-staging/' + currentRun;
const checks = [];
const ts = createRequire(releaseDependencyRoot(MV_DIRECT) + '/package.json')('typescript');
function moduleBody(source) {
  const tree = ts.createSourceFile('source.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), edits = [];
  assert.equal(tree.parseDiagnostics.length, 0);
  for (const statement of tree.statements) {
    if (ts.isImportDeclaration(statement)) edits.push([statement.getStart(tree), statement.end, '']);
    else for (const modifier of statement.modifiers || [])
      if (modifier.kind === ts.SyntaxKind.ExportKeyword) edits.push([modifier.getStart(tree), modifier.end, '']);
  }
  for (const [start, end, text] of edits.sort((a, b) => b[0] - a[0])) source = source.slice(0, start) + text + source.slice(end);
  return source;
}
const sameAssert = { ...assert, deepEqual: (a, b, message) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), message) };
function harness({ v2 = false } = {}) {
  const files = new Map(), immutable = new Set(); let writes = 0, schemaReads = 0, capsuleReads = 0;
  const put = (file, value) => files.set(file, typeof value === 'string' ? value : JSON.stringify(value));
  const rootFile = file => { assert.ok(files.has(file), 'Missing original evidence: ' + file); return Buffer.from(files.get(file)); };
  const original = { runId: priorRun, mainSource: 'a'.repeat(40), guardSource: 'b'.repeat(40), database: '/data/video-api-debugger/var-lib/dev.db', live: { identity: 'original' } };
  if (v2) {
    Object.assign(original, { schema: 'rate-impl2-release.v1', project: 'video-api-debugger', stage: priorStage,
      deployedUsageSchema: Object.fromEntries(DEPLOYED_FIELDS.map(key => [key, key === 'schema' ? DEPLOYED_SCHEMA
        : key.endsWith('Sha256') ? 'a'.repeat(64) : '30000000-0000-4000-8000-000000000001'])),
      deployedCanvasBatchSchema: Object.fromEntries(DEPLOYED_CANVAS_FIELDS.map(key => [key, key === 'schema'
        ? 'sd2-deployed-canvas-video-batch-schema-input.v1' : key.endsWith('Sha256') ? 'b'.repeat(64) : '30000000-0000-4000-8000-000000000002'])),
      canvasVideoBatchSchema: { schema: 'sd2-canvas-video-batch-schema-input.v1', previousPrismaSha256: 'c'.repeat(64),
        newPrismaSha256: 'd'.repeat(64), sqlSha256: 'e'.repeat(64), migrationModuleSha256: 'f'.repeat(64) } });
    for (const kind of ['main', 'guard']) original[kind] = { source: original[kind + 'Source'],
      root: '/data/video-api-debugger/managed-releases/' + original[kind + 'Source'], version: '0.102.1' + (kind === 'guard' ? '+guard.1' : ''), buildDist: '.next-prod-candidate' };
  }
  put(priorStage + '/manifest.json', original);
  const receipt = { schema: 'sd2-usage-attribution-migration.v1', runId: priorRun, source: original.mainSource, guardSource: original.guardSource,
    manifestSha256: sha(rootFile(priorStage + '/manifest.json')), sqlSha256: sha('reviewed SQL'), backupSha256: sha('consistent original backup'),
    newSchemaSha256: 'c'.repeat(64), completed: true, businessRowsWritten: 0, historyBackfilled: false, originalSchemaPreserved: true, at: '2026-10-21T00:00:00.000Z' };
  const proof = { ...receipt, consistent: true, integrity: 'ok', originalTableCounts: { Original: 1 } };
  const before = { manifestSha256: 'd'.repeat(64), protection: { databaseIdentity: ['1', '2'] },
    writers: { original: true }, policies: { unchanged: true }, protectedFileIdentities: {}, legacy: [], hdLegacy: {}, captured: { at: '2026-10-21T00:00:00.000Z' },
    roleControl: { state: { pid: 50 }, fragment: {}, dropins: [], loadedModuleSha: {} } };
  const saved = { ...before, runId: priorRun, manifestSha256: receipt.manifestSha256 };
  put(priorStage + '/switch-before.json', saved);
  put(priorStage + '/hd-release-safety-approval.json', { runId: priorRun, manifestSha256: receipt.manifestSha256, expiresAt: 1 });
  put(priorStage + '/normal-switch-refusal.log', 'original HD refusal');
  put(priorStage + '/normal-switch-refusal.json', { schema: 'sd2-normal-switch-refusal.v1', runId: priorRun,
    manifestSha256: receipt.manifestSha256, phase: 'before-maintenance', effectsStarted: false, exitCode: 1,
    logFile: 'normal-switch-refusal.log', logSha256: sha('original HD refusal'), ...(v2 ? {
      at: '2026-10-21T00:01:00.000Z', originalPidAndProtectionFreshlyVerified: true, hdDetailFile: null, hdDetailSha256: null } : {}) });
  put(priorStage + '/lineage-closed.json', { chainId: '20000000-0000-4000-8000-000000000001', run: priorRun, attempt: 8,
    releaseFailureCounts: { hd: 1 }, ...(v2 ? { schema: 'sd2-release-lineage-closed.v1', closedAt: '2026-10-21T00:02:00.000Z',
      registryCloseCommandSha256: 'a'.repeat(64), effectsStarted: false, originalRuntimeAndProtectionUnchanged: true,
      originalEvidencePreserved: true, servicesChanged: false, businessWrites: 0 } : {}) });
  put(priorStage + '/usage-attribution-migration/receipt.json', receipt);
  put(priorStage + '/usage-attribution-migration/backup-proof.json', proof);
  put(priorStage + '/usage-attribution-migration/consistent-backup.sqlite', 'consistent original backup');
  const input = { schema: 'sd2-normal-continuation-input.v1', chainId: '20000000-0000-4000-8000-000000000001', attempt: 9,
    sourceRun: priorRun, sourceManifestSha256: receipt.manifestSha256,
    beforeSha256: sha(rootFile(priorStage + '/switch-before.json')), approvalSha256: sha(rootFile(priorStage + '/hd-release-safety-approval.json')),
    refusalSha256: sha(rootFile(priorStage + '/normal-switch-refusal.json')), lineageSha256: sha(rootFile(priorStage + '/lineage-closed.json')),
    migrationRun: priorRun, migrationManifestSha256: receipt.manifestSha256,
    migrationReceiptSha256: sha(rootFile(priorStage + '/usage-attribution-migration/receipt.json')),
    backupProofSha256: sha(rootFile(priorStage + '/usage-attribution-migration/backup-proof.json')) };
  const m = { ...original, runId: currentRun, stage, normalContinuation: input,
    main: original.main || { root: '/data/main' }, guard: original.guard || { root: '/data/guard' } };
  if (v2) {
    input.schema = CONTINUATION_V2;
    for (const key of ['migrationRun', 'migrationManifestSha256', 'migrationReceiptSha256', 'backupProofSha256']) delete input[key];
    m.reuseBuilds = { schema: 'sd2-original-build-reuse-input.v1', sourceRun: priorRun };
    for (const kind of ['main', 'guard']) {
      const file = priorStage + '/' + kind + '-immutable-success.json';
      put(file, { kind, sourceRun: priorRun, originalManifestSha256: input.sourceManifestSha256, newCompilationClaimed: false,
        originalReceipt: { source: m[kind].source, version: m[kind].version, startedAt: 1000, finishedAt: 2000 } });
      immutable.add(file); m.reuseBuilds[kind] = { file, sha256: sha(rootFile(file)) };
    }
  }
  put(stage + '/manifest.json', m);
  for (const kind of ['main', 'guard']) put(m[kind].root + '/prisma/migrations/20261021073000_usage_attribution/migration.sql', 'reviewed SQL');
  const candidateStat = { isFile: () => true, isSymbolicLink: () => false, nlink: 1, uid: 1004, gid: 1004, mode: 0o100644,
    dev: 1, ino: 2, size: 12, ctimeMs: 1, mtimeMs: 1 };
  const fakeFs = { existsSync: file => files.has(file), realpathSync: file => file,
    constants: { O_RDONLY: 0, O_NOFOLLOW: 1 }, openSync: file => file, closeSync: () => {},
    readFileSync: file => rootFile(file), fstatSync: () => candidateStat,
    lstatSync: file => file.endsWith('/migration.sql') ? candidateStat : ({ isDirectory: () => true, uid: 0, mode: 0o40700 }),
    readdirSync: directory => directory === '/proc' ? [] : [...files.keys()].filter(file => path.dirname(file) === directory).map(file => path.basename(file)) };
  const context = { assert: sameAssert, fs: fakeFs, path, Buffer, JSON, Date, process: { pid: 1 }, sha, rootFile, isSharedEngine,
    assertDeployedSchemaInput, assertDeployedCanvasInput, assertCanvasBatchSchemaInput,
    verifyDeployedUsageSchema: value => { assert.equal(value, m); schemaReads++; return { observed: { databaseWrites: 0, ddlExecuted: false } }; },
    readOriginalSuccess: (value, kind) => {
      capsuleReads++; const pin = value.reuseBuilds[kind]; assert.ok(immutable.has(pin.file));
      assert.equal(sha(rootFile(pin.file)), pin.sha256); return JSON.parse(rootFile(pin.file));
    },
    assertReleaseWindow: value => { assert.equal(value, m); assert.equal(value.expired, undefined); },
    assertProtection: (a, b) => assert.deepEqual(a, b),
    writeJsonExclusive: (file, value) => { assert.equal(files.has(file), false); writes++; put(file, value); },
    call: (name, args) => {
      if (name === 'findmnt') return '/data';
      if (name === 'id') return '1004';
      if (name === 'chattr') { immutable.add(args.at(-1)); return ''; }
      if (name === 'lsattr') return immutable.has(args.at(-1)) ? '----i----' : '---------';
      assert.equal(name, 'python3'); const data = JSON.parse(args.at(-1)); assert.deepEqual(data.identity, ['1', '2']);
      return JSON.stringify({ databaseIdentity: data.identity, newSchemaSha256: data.schemaSha256, databaseWrites: 0 });
    } };
  vm.runInNewContext(moduleBody(source)
    + '\nglobalThis.api={verifyNormalContinuation,verifyDeployedContinuationProvenance,assertDeployedContinuationMode,adoptOriginalMigration,readMigrationEvidence,PROBE};', context);
  return { m, before: { ...before, captured: { at: new Date().toISOString() }, manifestSha256: sha(rootFile(stage + '/manifest.json')) }, files, put, rootFile,
    receipt, proof, original, api: context.api, immutable, schemaReads: () => schemaReads, capsuleReads: () => capsuleReads, writes: () => writes };
}
const good = harness();
assertContinuationInput(good.m.normalContinuation);
assert.equal(good.api.verifyNormalContinuation(good.m, good.before).operation, 'CONTINUE-NORMAL');
const originalReceipt = good.rootFile(priorStage + '/usage-attribution-migration/receipt.json').toString();
const adopted = good.api.adoptOriginalMigration(good.m);
assert.equal(adopted.operation, 'ADOPT'); assert.equal(adopted.ddlExecuted, false);
assert.equal(adopted.original.runId, priorRun); assert.equal(adopted.original.at, good.receipt.at);
assert.equal(good.api.readMigrationEvidence(good.m).runId, priorRun);
good.api.adoptOriginalMigration(good.m); assert.equal(good.writes(), 1);
assert.equal(good.rootFile(priorStage + '/usage-attribution-migration/receipt.json').toString(), originalReceipt);
checks.push('adopt_preserves_original_run_time_bytes_and_never_executes_ddl');
{
  const f = harness({ v2: true }), originals = new Map(f.files);
  assertContinuationInput(f.m.normalContinuation);
  const result = f.api.verifyNormalContinuation(f.m, f.before);
  assert.equal(result.schema, CONTINUATION_V2); assert.equal(result.ddlExecuted, false);
  assert.equal(result.originalBuilds.main.startedAt, 1000); assert.equal(result.originalBuilds.guard.finishedAt, 2000);
  assert.equal(f.schemaReads(), 1); assert.equal(f.capsuleReads(), 2); assert.equal(f.writes(), 0);
  assert.deepEqual(f.files, originals);
  assert.throws(() => f.api.adoptOriginalMigration(f.m)); assert.equal(f.writes(), 0);
  checks.push('v2_verifies_both_deployed_schemas_and_original_full_pair_without_migration_adoption_or_retiming');
  const repin = (fixture, file, field, mutate) => {
    const full = priorStage + '/' + file, value = JSON.parse(fixture.rootFile(full)); mutate(value); fixture.put(full, value);
    fixture.m.normalContinuation[field] = sha(fixture.rootFile(full));
  };
  for (const change of [
    x => { x.m.normalContinuation.schema = 'sd2-normal-continuation-input.v3'; },
    x => { x.m.normalContinuation.migrationRun = priorRun; },
    x => { delete x.m.deployedUsageSchema; }, x => { delete x.m.deployedCanvasBatchSchema; },
    x => { delete x.m.reuseBuilds; }, x => { x.m.reuseBuilds.sourceRun = currentRun; },
    x => { x.m.reuseBuilds.main.file = '/other/main-immutable-success.json'; },
    x => { x.m.reuseBuilds.guard.sha256 = '0'.repeat(64); },
    x => { x.immutable.delete(x.m.reuseBuilds.main.file); },
    x => { x.m.guard.source = 'c'.repeat(40); },
    x => { x.before.roleControl = { ...x.before.roleControl, state: { pid: 51 } }; },
    x => { x.before.captured = { at: new Date(Date.now() - 300001).toISOString() }; },
    x => { x.put(priorStage + '/fixed-guard-recovery-start.json', {}); },
    x => { x.put(priorStage + '/normal-switch-refusal.log', 'changed original failure'); },
    x => repin(x, 'normal-switch-refusal.json', 'refusalSha256', v => { v.effectsStarted = true; }),
    x => repin(x, 'normal-switch-refusal.json', 'refusalSha256', v => { v.originalPidAndProtectionFreshlyVerified = false; }),
    x => repin(x, 'lineage-closed.json', 'lineageSha256', v => { v.releaseFailureCounts.hd = 0; }),
    x => repin(x, 'lineage-closed.json', 'lineageSha256', v => { v.releaseFailureCounts.hd = 1.5; }),
    x => repin(x, 'lineage-closed.json', 'lineageSha256', v => { v.originalEvidencePreserved = false; }),
    x => repin(x, 'manifest.json', 'sourceManifestSha256', v => { v.guardSource = 'c'.repeat(40); }),
  ]) {
    const invalid = harness({ v2: true }); change(invalid);
    assert.throws(() => invalid.api.verifyNormalContinuation(invalid.m, invalid.before)); assert.equal(invalid.writes(), 0);
  }
  checks.push('v2_unknown_schema_mixed_sources_arbitrary_reuse_bad_capsules_open_lineage_effects_and_stale_capture_fail_closed');
}
for (const change of [f => { f.m.normalContinuation.beforeSha256 = '0'.repeat(64); },
  f => { f.files.delete(priorStage + '/usage-attribution-migration/backup-proof.json'); },
  f => { f.put(priorStage + '/usage-attribution-migration/consistent-backup.sqlite', 'changed'); },
  f => { f.before.writers = { changed: true }; }, f => { f.before.protection.databaseIdentity = ['1', '3']; },
  f => { f.m.mainSource = 'e'.repeat(40); }, f => { f.m.database = '/data/other.db'; },
  f => { f.m.normalContinuation.attempt = 10; }, f => { f.m.expired = true; },
  f => { f.put(priorStage + '/network-fence-installed.json', {}); }]) {
  const f = harness(); change(f); assert.throws(() => f.api.verifyNormalContinuation(f.m, f.before)); assert.equal(f.writes(), 0);
}
checks.push('tamper_partial_backup_source_db_pid_lineage_expiry_or_effects_refuse_without_adoption');
for (const name of ['.switch.lock', 'natural-stop-intent-switch-web.json', 'usage-role-transition-0001.json',
  'ingress-503-switch.json', 'network-fence-installed.json', 'pricing-pair-published.json', 'actual-prestart.json',
  'switch-complete.json', 'nginx-run-installed.json', 'nginx-run-install-prepared-1.json', 'nginx-run-install-progress-1.json',
  'nginx-run-installation-aborted.json', 'writer-no-force-install-progress-switch-hd.json', 'hd-manual-start-gate-released-main.json',
  'guard-recovery-attempt.json']) assert.throws(() => assertNoCutoverEffects([name]));
assertNoCutoverEffects(['switch-before.json', 'hd-release-safety-approval.json', 'fixed-guard-recovery.json', 'usage-role-readonly-admission.json']);
checks.push('only_zero_side_effect_premaintenance_history_can_continue');

{
  const old = 'e'.repeat(64), current = 'f'.repeat(64), historical = ['natural-stop-switch-hd-' + old + '.json', 'usage-role-transition-0001.json'];
  const preserved = [...historical, 'writer-no-force-final-switch-hd-' + old + '.json', 'switch-before.json'];
  assertNoCutoverEffects(restoredRefusalCurrentFiles(preserved, current, historical, old));
  assert.deepEqual(preserved.slice(0, 2), historical);
  for (const name of ['natural-stop-switch-hd-' + current + '.json', 'usage-role-transition-0001-' + current + '.json',
    'pricing-pair-published.json', 'switch-complete.json', 'writer-no-force-final-switch-hd-' + current + '.json', 'unknown-natural-stop']) {
    const names = restoredRefusalCurrentFiles([...preserved, name], current, historical, old);
    if (name === 'unknown-natural-stop') assert.ok(names.includes(name)); else assert.throws(() => assertNoCutoverEffects(names));
  }
  assert.throws(() => restoredRefusalCurrentFiles(preserved, current, historical, current));
  checks.push('restored_refusal_preserves_historical_effects_but_rejects_current_or_unscoped_cutover_effects');
}

for (const change of [r => { r.completed = false; }, r => { r.historyBackfilled = true; },
  r => { r.source = 'f'.repeat(40); }, r => { r.originalSchemaPreserved = false; }]) {
  const receipt = structuredClone(good.receipt); change(receipt);
  assert.throws(() => assertOriginalMigration(good.m, good.original, receipt, good.proof));
}
checks.push('original_success_and_backup_contract_cannot_be_invented');
assertFreshLegacyCapture([{ checkedAt: 200, source: 'original' }], [{ checkedAt: 100, source: 'original' }], 300);
for (const current of [{ checkedAt: 301, source: 'original' }, { checkedAt: 0, source: 'original' },
  { checkedAt: 200, source: 'changed' }]) assert.throws(() => assertFreshLegacyCapture([current], [{ checkedAt: 100, source: 'original' }], 300));
assert.throws(() => assertFreshLegacyCapture([{ checkedAt: 200, source: 'original' }], [{ checkedAt: 100, source: 'original' }], 300201));
checks.push('fresh_observation_time_is_not_retimed_or_confused_with_source_drift');
assertFreshPricingCapture({ at: new Date(200).toISOString(), allowed: 'same' }, { at: new Date(100).toISOString(), allowed: 'same' }, 300);
for (const changed of [{ at: new Date(301).toISOString(), allowed: 'same' }, { at: new Date(200).toISOString(), allowed: 'changed' }])
  assert.throws(() => assertFreshPricingCapture(changed, { at: new Date(100).toISOString(), allowed: 'same' }, 300));
checks.push('pricing_observation_time_is_fresh_but_root_file_bytes_and_metadata_remain_exact');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-adopt-native-'));
try {
  const setup = String.raw`import sqlite3,json,sys,hashlib,os
p=sys.argv[1]
with sqlite3.connect(p+'/backup.sqlite') as b: b.execute('CREATE TABLE Original(id INTEGER PRIMARY KEY)'); b.execute('INSERT INTO Original VALUES (1)')
with sqlite3.connect(p+'/backup.sqlite') as b,sqlite3.connect(p+'/current.sqlite') as c: b.backup(c)
with sqlite3.connect(p+'/current.sqlite') as c:
 c.executescript(sys.argv[2])
 names=['UsageAttribution','UsageAttribution_owner_user_id_occurred_at_idx','UsageAttribution_project_id_occurred_at_idx','UsageAttribution_occurred_at_idx']
 rows={r[0]:[r[1],r[2],r[3]] for r in c.execute("SELECT name,type,tbl_name,sql FROM sqlite_master") if r[0] in names}
 print(json.dumps({'database':p+'/current.sqlite','backup':p+'/backup.sqlite','identity':[str(os.stat(p+'/current.sqlite').st_dev),str(os.stat(p+'/current.sqlite').st_ino)],'backupCounts':{'Original':1},'schemaSha256':hashlib.sha256(json.dumps(rows,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()).hexdigest()}))`;
  const sql = 'CREATE TABLE UsageAttribution(source_kind TEXT,source_id TEXT,owner_user_id TEXT,project_id TEXT,occurred_at TEXT);'
    + 'CREATE INDEX UsageAttribution_owner_user_id_occurred_at_idx ON UsageAttribution(owner_user_id,occurred_at);'
    + 'CREATE INDEX UsageAttribution_project_id_occurred_at_idx ON UsageAttribution(project_id,occurred_at);'
    + 'CREATE INDEX UsageAttribution_occurred_at_idx ON UsageAttribution(occurred_at);';
  const input = JSON.parse(execFileSync('python3', ['-c', setup, temporary, sql], { encoding: 'utf8' }));
  input.requireEmpty = true;
  assert.equal(JSON.parse(execFileSync('python3', ['-c', good.api.PROBE, JSON.stringify(input)], { encoding: 'utf8' })).databaseWrites, 0);
  for (const change of [v => { v.identity = ['0', '0']; }, v => { v.schemaSha256 = '0'.repeat(64); }, v => { v.backupCounts.Original = 0; }]) {
    const value = structuredClone(input); change(value); assert.throws(() => execFileSync('python3', ['-c', good.api.PROBE, JSON.stringify(value)], { stdio: 'pipe' }));
  }
  execFileSync('python3', ['-c', "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('INSERT INTO UsageAttribution(source_kind) VALUES (?)',('unexpected',)); c.commit()", input.database]);
  assert.throws(() => execFileSync('python3', ['-c', good.api.PROBE, JSON.stringify(input)], { stdio: 'pipe' }));
  assert.equal(JSON.parse(execFileSync('python3', ['-c', good.api.PROBE, JSON.stringify({ ...input, requireEmpty: false })], { encoding: 'utf8' })).attributionRows, 1);
  fs.symlinkSync(input.database, temporary + '/alias.sqlite');
  assert.throws(() => execFileSync('python3', ['-c', good.api.PROBE, JSON.stringify({ ...input, database: temporary + '/alias.sqlite', requireEmpty: false })], { stdio: 'pipe' }));
  checks.push('compatible_guard_preserves_new_attribution_rows_after_authorized_writer_start');
  checks.push('real_anonymous_sqlite_backup_schema_identity_counts_and_empty_table_proved');
} finally { fs.rmSync(temporary, { recursive: true }); }
const switching = fs.readFileSync(new URL('./switch.mjs', import.meta.url), 'utf8');
assert.ok(switching.indexOf('hdAdmissionRecord = recordHdAdmission(m, hdBefore)') < switching.indexOf("assert.equal(hdBefore.canEnterControlledDrain, true"));
const role = fs.readFileSync(new URL('./usage-role-control.mjs', import.meta.url), 'utf8');
assert.ok(role.includes('json(candidateEvidenceFile(m, kind))')); assert.ok(role.includes('readMigrationEvidence(m)'));
checks.push('hd_full_result_precedes_gate_and_role_reads_unified_candidate_and_adoption');
{
  const pin = EXACT_UNPUBLISHED_PAIR, originalStage = '/data/video-api-debugger/release-staging/' + pin.run;
  const manifestBytes = fs.readFileSync(originalStage + '/manifest.json'), prior = JSON.parse(manifestBytes);
  const m = structuredClone(prior); m.runId = currentRun;
  m.reuseBuilds = { schema: 'sd2-original-build-reuse-input.v1', sourceRun: pin.run,
    ...Object.fromEntries(['main', 'guard'].map(kind => [kind, { file: originalStage + '/' + kind + '-immutable-success.json', sha256: pin[kind].sha256 }])) };
  const capsules = Object.fromEntries(['main', 'guard'].map(kind => {
    const bytes = fs.readFileSync(m.reuseBuilds[kind].file); assert.equal(sha(bytes), pin[kind].sha256);
    return [kind, JSON.parse(bytes)];
  }));
  const facts = { prior, manifestSha256: sha(manifestBytes), capsules,
    originalFiles: fs.readdirSync(originalStage), candidatePids: [] };
  assert.equal(assertExactUnpublishedFacts(m, facts).schema, UNPUBLISHED_SCHEMA);
  const actualProvenance = verifyExactUnpublishedProvenance(m);
  assert.equal(actualProvenance.schema, UNPUBLISHED_SCHEMA);
  assert.equal(actualProvenance.originalManifestSha256, pin.manifestSha256);
  assert.equal(Object.hasOwn(actualProvenance, 'currentOriginalRuntimeVerified'), false);
  checks.push('unpublished_actual_provenance_reader_terminates_without_recursive_schema_or_runtime_admission');
  checks.push('exact_unpublished_pair_actual_pinned_manifest_and_two_original_successes');
  for (const [name, change] of [
    ['main_pair', x => { x.mainSource = '0'.repeat(40); }],
    ['guard_pair', x => { x.guardSource = '0'.repeat(40); }],
    ['source_run', x => { x.reuseBuilds.sourceRun = currentRun; }],
    ['main_hash', x => { x.reuseBuilds.main.sha256 = '0'.repeat(64); }],
    ['guard_hash', x => { x.reuseBuilds.guard.sha256 = '0'.repeat(64); }],
    ['reuse_schema', x => { x.reuseBuilds.schema += '-forged'; }],
    ['usage_schema', x => { x.deployedUsageSchema.publicationRun = currentRun; }],
    ['canvas_schema', x => { x.deployedCanvasBatchSchema.migrationRun = currentRun; }],
    ['permission_file', x => { x.expectedProtectedFileSha256[x.envFile] = '0'.repeat(64); }],
    ['protected_tasks', x => { x.protectedVideoTaskIds.pop(); }],
    ['live_source', x => { x.live.web.source = '0'.repeat(40); }],
    ['live_invocation', x => { x.live.role.invocation = '0'.repeat(32); }],
    ['normal_continuation', x => { x.normalContinuation = { schema: CONTINUATION_V2 }; }],
    ['already_published', x => { x.live.web.source = pin.main.source; }],
  ]) {
    const changed = structuredClone(m); change(changed);
    assert.throws(() => assertExactUnpublishedFacts(changed, facts)); checks.push('unpublished_reject_' + name);
  }
  for (const [name, change] of [
    ['forged_success', x => { x.capsules.main.originalReceipt.exitCode = 1; }],
    ['forged_gate', x => { x.capsules.guard.originalReceipt.verifiedSourceAndGates = false; }],
    ['late_original_seal', x => { x.capsules.main.sealedAt = new Date(pin.main.startedAt + 1800001).toISOString(); }],
    ['changed_original_time', x => { x.capsules.guard.originalReceipt.startedAt++; }],
    ['changed_original_build', x => { x.capsules.main.originalReceipt.build += 'x'; }],
    ['original_manifest_hash', x => { x.manifestSha256 = '0'.repeat(64); }],
    ['active_writer', x => { x.candidatePids.push(123); }],
  ]) {
    const changed = structuredClone(facts); change(changed);
    assert.throws(() => assertExactUnpublishedFacts(m, changed)); checks.push('unpublished_reject_' + name);
  }
  for (const name of ['switch-before.json', 'switch-complete.json', 'switch-failure-old.json', 'normal-switch-refusal.json',
    'usage-role-transition-0001.json', 'natural-stop-role.json', 'writer-no-force-installed.json', 'ingress-503-switch.json',
    'network-fence-installed.json', 'pricing-pair-published.json', 'nginx-example-installation-aborted.json']) {
    assert.throws(() => assertExactUnpublishedFacts(m, { ...facts, originalFiles: [...facts.originalFiles, name] }));
    checks.push('unpublished_reject_effect_' + name);
  }
  const provenance = { schema: UNPUBLISHED_SCHEMA, originalManifestSha256: pin.manifestSha256,
    originalBuilds: Object.fromEntries(['main', 'guard'].map(kind => [kind, { sha256: pin[kind].sha256 }])) };
  for (const kind of ['main', 'guard']) {
    assertFirstRuntimeAliasProvenance(m, kind, capsules[kind], facts.originalFiles, [], provenance);
    assert.throws(() => assertFirstRuntimeAliasProvenance(m, kind, capsules[kind], facts.originalFiles, [], null));
    assert.throws(() => assertFirstRuntimeAliasProvenance(m, kind, capsules[kind], facts.originalFiles, [123], provenance));
  }
  checks.push('unpublished_alias_actual_callsite_requires_exact_provenance_and_no_candidate');
}
console.log(JSON.stringify({ schema: 'sd2-normal-continuation-engineering.v1', completed: true, checks,
  count: checks.length, productionWrites: 0, servicesChanged: false, functionalAcceptance: false,
  io: 'actual validators and anonymous SQLite; orchestration memory IO is not native admission' }));
