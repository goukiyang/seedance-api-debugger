import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DEPLOYED_SCHEMA, DEPLOYED_FIELDS, assertDeployedSchemaInput, DEPLOYED_PROBE, assertRetainedProofCommand, unchangedSchemaInputs, SCHEMA_FILES, assertPriorPublication, readPublishedBaselineSourceFiles, priorUsageRoleControl, assertFullPriorUsageRoleControl } from './deployed-usage-schema.mjs';
import { CANVAS_BATCH_SQL, CANVAS_BATCH_MIGRATOR, CANVAS_BATCH_MODE } from './canvas-batch-schema-contract.mjs';
import { MV_DIRECT } from './release-contract.mjs';
import { rootFile, validateManifest, isSharedEngine } from './common.mjs';
import { R08_RECOVERED_GUARD, R10_RECOVERED_GUARD, R14_RECOVERED_GUARD, R17_RECOVERED_GUARD, assertRecoveredGuardInput, assertRecoveredGuardRecords, readRecoveredGuardBaseline } from './recovered-guard-baseline.mjs';

assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
const fixtureManifest = process.argv[2] === '--fixture-manifest' ? process.argv[3] : null;
if (fixtureManifest) assert.ok(path.isAbsolute(fixtureManifest) && process.argv.length === 4);
const explicitFixture = fixtureManifest ? JSON.parse(rootFile(fixtureManifest)) : null;
const fixtureBaseline = explicitFixture?.live.web.root || '/data/video-api-debugger/managed-releases/' + MV_DIRECT.baselineSource;
const sha = bytes => createHash('sha256').update(bytes).digest('hex'), cases = [];
// Each negative case replaces only its named record/path. All other retained
// evidence is read-only, rather than copying every historical proof per case.
const withEvidence = (records, name, replace) => ({ ...records,
  recoveryEvidence: { ...records.recoveryEvidence, [name]: replace(records.recoveryEvidence[name]) } });
const input = Object.fromEntries(DEPLOYED_FIELDS.map(key => [key, key === 'schema' ? DEPLOYED_SCHEMA
  : key.endsWith('Sha256') ? 'a'.repeat(64) : '10000000-0000-4000-8000-000000000001']));
assertDeployedSchemaInput(input);
for (const key of DEPLOYED_FIELDS) {
  const missing = { ...input }; delete missing[key]; assert.throws(() => assertDeployedSchemaInput(missing));
  assert.throws(() => assertDeployedSchemaInput({ ...input, [key]: 'wrong' }));
}
assert.throws(() => assertDeployedSchemaInput({ ...input, allowWrites: true }));
cases.push('explicit_complete_input_rejects_unknown_missing_or_malformed_pins');
for (const mode of [
  { reuseBuilds: { sourceRun: '10000000-0000-4000-8000-000000000002' } },
  { normalContinuation: { schema: 'sd2-normal-continuation-input.v3' } },
  { normalContinuation: { schema: 'sd2-normal-continuation-input.v2' }, reuseBuilds: {} },
]) assert.throws(() => assertPriorPublication({ deployedUsageSchema: input, ...mode }, {}, {}, {}, {}, {}, {}, {}));
const deployedSource = fs.readFileSync(new URL('./deployed-usage-schema.mjs', import.meta.url), 'utf8');
{
  // 真实旧记录和当前旧源码只读；适配器仅隔离原生来源读取，不接触数据库、控制文件或服务。
  const stage = '/data/video-api-debugger/release-staging/15fe9bbb-c012-4dae-9a86-6e473e259c67';
  const pins = { 'manifest.json': 'bb99fc3eae449e09c2dc05d0ee0a74a33461cf88ce0a5cdb3da55babddbc5156',
    'usage-role-transition-0011.json': 'd5528e80378d6643dec35f84bf17c4a1ca5cad4a30c833ecadab691ca5eae25d',
    'usage-role-transition-0012.json': '0b7980a568cb9e880f6e3cbd5c1b3903f29fd2ff5a75671dcab61dc2c788b8d4' };
  const originals = new Map(Object.entries(pins).map(([name, digest]) => {
    const file = stage + '/' + name, bytes = rootFile(file); assert.equal(sha(bytes), digest); return [file, bytes];
  }));
  const records = { prior: JSON.parse(originals.get(stage + '/manifest.json')),
    start: JSON.parse(originals.get(stage + '/usage-role-transition-0011.json')),
    active: JSON.parse(originals.get(stage + '/usage-role-transition-0012.json')) };
  const role = records.start.published.contract.releases.find(value => value.source === records.prior.guardSource); assert.ok(role);
  const m = { appUser: 'gouki', fullRelease: { liveRoles: { role } } };
  const sourceManifestBytes = rootFile('/data/video-api-debugger/release-staging/1243443f-ca0d-482c-8ca1-cdfc5accab20/guard/source-manifest.json');
  assert.equal(sha(sourceManifestBytes), '790e5bbfb092d880f2c9446b2b9eaadffc62b6a3b26d0d96ca8205da7b639c05');
  const sourceManifest = JSON.parse(sourceManifestBytes); assert.equal(sourceManifest.source, role.source);
  const proof = { root: role.root, source: role.source, sourceFiles: Object.fromEntries(Object.keys(role.sourceSha256).map(file => {
    const digest = sha(fs.readFileSync(role.root + '/' + file)); assert.equal(digest, sourceManifest.files[file]); return [file, digest];
  })) };
  const allowed = assertFullPriorUsageRoleControl(m, records, proof, 1004);
  assert.equal(sha(allowed.allowed), '50c1dd232fd6069055354e4c18bd862ee13006c3f23dd8f8306de73eea7bb0be');
  assert.equal(sha(allowed.source), '4defd0b850b9c44fce5d1a9123e953b22290578b0e0d6f3dbe89fbf7791e80e9');
  const constantStart = deployedSource.indexOf('const FULL_PRIOR_ROLE ='), constantEnd = deployedSource.indexOf('\nconst stageFor', constantStart);
  const readerStart = deployedSource.indexOf('export function priorUsageRoleControl('), readerEnd = deployedSource.indexOf('\nexport function assertPriorUsageRoleControl(', readerStart);
  assert.ok(constantStart > 0 && constantEnd > constantStart && readerStart > 0 && readerEnd > readerStart);
  const reads = [], changed = new Map();
  const read = new Function('assert', 'stageFor', 'stageIdentity', 'pinned', 'readFullLiveSourceFiles', 'call', 'assertFullPriorUsageRoleControl',
    deployedSource.slice(constantStart, constantEnd) + '\n' + deployedSource.slice(readerStart, readerEnd).replace('export ', '') + ';return priorUsageRoleControl;')(
    assert, run => '/data/video-api-debugger/release-staging/' + run, value => assert.equal(value, stage),
    (file, expected) => { reads.push(file); assert.ok(originals.has(file), 'Old role must not read the mutable current pair');
      const bytes = changed.get(file) || originals.get(file); assert.equal(sha(bytes), expected); return JSON.parse(bytes); },
    (manifest, files, name) => { assert.equal(manifest, m); assert.equal(name, 'role'); assert.deepEqual(files, Object.keys(role.sourceSha256)); return proof; },
    (bin, args) => { assert.equal(bin, 'id'); assert.deepEqual(args, ['-u', 'gouki']); return '1004'; }, assertFullPriorUsageRoleControl);
  assert.deepEqual(read(m), allowed); assert.deepEqual(reads, [...originals.keys()]);
  for (const file of originals.keys()) {
    changed.set(file, Buffer.concat([originals.get(file), Buffer.from(' ')])); assert.throws(() => read(m)); changed.clear();
  }
  for (const change of [v => { v.active.previousSha256 = '0'.repeat(64); }, v => { v.active.kind = 'main'; },
    v => { v.active.current.ActiveState = 'inactive'; }, v => { v.start.published.contract.runId = 'other-run'; },
    v => { v.start.published.contract.releases = []; }]) {
    const invalid = structuredClone(records); change(invalid); assert.throws(() => assertFullPriorUsageRoleControl(m, invalid, proof, 1004));
  }
  for (const change of [v => { v.root += '-other'; }, v => { v.source = '0'.repeat(40); },
    v => { v.sourceFiles['ops/sd2-usage-role-start.mjs'] = '0'.repeat(64); }]) {
    const invalid = structuredClone(proof); change(invalid); assert.throws(() => assertFullPriorUsageRoleControl(m, records, invalid, 1004));
  }
  assert.throws(() => assertFullPriorUsageRoleControl(m, records, proof, 1));
  cases.push('actual_full_role_reader_pins_old_manifest_start_active_and_old_source_table_without_reading_new_pair');
  cases.push('actual_full_role_reader_rejects_old_record_sha_chain_pair_source_module_or_app_identity_drift');
}
assert.ok(deployedSource.includes('if (m.normalContinuation || m.reuseBuilds) verifyDeployedContinuationProvenance(m);'));
assert.ok(deployedSource.indexOf('verifyDeployedContinuationProvenance(m);') < deployedSource.indexOf('const pair = publicationPair(prior, final);'));
cases.push('actual_deployed_usage_publication_consumer_rejects_arbitrary_reuse_and_unknown_or_incomplete_v2_before_native_io');
const now = Date.now(), retained = { at: new Date(now - 1000).toISOString() },
  command = { start: new Date(now - 2000).toISOString(), finish: new Date(now).toISOString(), status: 0, signal: null, error: null };
assertRetainedProofCommand(retained, command);
for (const change of [v => { v.status = 1; }, v => { v.signal = 'SIGTERM'; }, v => { v.error = 'failed'; },
  v => { v.start = new Date(now).toISOString(); }, v => { v.finish = new Date(now - 1500).toISOString(); }]) {
  const invalid = structuredClone(command); change(invalid); assert.throws(() => assertRetainedProofCommand(retained, invalid));
}
cases.push('retained_stdout_requires_its_original_successful_command_and_original_time_interval');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-deployed-schema-'));
try {
  const sql = fs.readFileSync(fixtureBaseline + '/prisma/migrations/20261021073000_usage_attribution/migration.sql', 'utf8');
  const create = String.raw`
import sqlite3,sys,json,os,hashlib,pathlib
d=json.loads(sys.argv[1]); backup=d['backup']; db=d['database']
with sqlite3.connect(backup) as c:
 default=(" DEFAULT '"+'x'*140000+"'") if d.get('largeSchema') else ''
 c.execute('CREATE TABLE ExistingBusiness (id TEXT PRIMARY KEY, value TEXT'+default+')')
 c.executemany('INSERT INTO ExistingBusiness VALUES (?,?)',[('a','kept'),('b','kept'),('c','kept')]); c.commit()
with sqlite3.connect(backup) as b,sqlite3.connect(db) as c:
 b.backup(c); c.executescript(d['sql'])
 c.execute("INSERT INTO UsageAttribution (source_kind, source_id, owner_user_id, context_origin, occurred_at) VALUES ('image','a','owner','explicit','2026-10-21T00:00:00Z')")
 c.commit()
 rows={r[0]:[r[1],r[2],r[3]] for r in c.execute("SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name LIKE 'UsageAttribution%' ORDER BY name")}
 allRows={r[0]:[r[1],r[2],r[3]] for r in c.execute("SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")}
s=os.stat(db)
print(json.dumps({'database':db,'backup':backup,'identity':[str(s.st_dev),str(s.st_ino)],'backupCounts':{'ExistingBusiness':3},'schemaSha256':hashlib.sha256(json.dumps(rows,separators=(',',':'),ensure_ascii=True).encode()).hexdigest(),**({'fullSchemaBefore':allRows} if d.get('largeSchema') else {})}))
`;
  const python = (code, value) => {
    const stdin = code === DEPLOYED_PROBE, bytes = JSON.stringify(value);
    return execFileSync('python3', ['-I', '-c', code, ...(stdin ? [] : [bytes])],
      { encoding: 'utf8', timeout: stdin ? 120000 : 30000, env: { PATH: '/usr/bin:/bin' },
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], ...(stdin ? { input: bytes } : {}) }).trim();
  };
  const make = (name, largeSchema = false) => {
    const root = path.join(temporary, name); fs.mkdirSync(root);
    return JSON.parse(python(create, { database: root + '/database.sqlite', backup: root + '/backup.sqlite', sql, largeSchema }));
  };
  const good = make('valid'), before = sha(fs.readFileSync(good.database)), backupBefore = sha(fs.readFileSync(good.backup));
  const observed = JSON.parse(python(DEPLOYED_PROBE, good));
  assert.equal(observed.attributionRows, 1); assert.equal(observed.databaseWrites, 0); assert.equal(observed.ddlExecuted, false);
  assert.equal(sha(fs.readFileSync(good.database)), before); assert.equal(sha(fs.readFileSync(good.backup)), backupBefore);
  cases.push('real_sqlite_nonempty_table_allowed_without_db_or_backup_byte_changes');
  // Actual original SQLite SQL carries the large content. No unconsumed JSON
  // padding is used to make the stdin transport appear to cover the real case.
  const large = make('large-schema', true), largeBefore = sha(fs.readFileSync(large.database)), largeBackupBefore = sha(fs.readFileSync(large.backup));
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 138154);
  const legacy = { ...large }; delete legacy.fullSchemaBefore;
  const legacyObserved = JSON.parse(execFileSync('python3', ['-I', '-c', DEPLOYED_PROBE, JSON.stringify(legacy)], {
    encoding: 'utf8', timeout: 120000, env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.deepEqual(JSON.parse(python(DEPLOYED_PROBE, large)), legacyObserved);
  const changedLarge = structuredClone(large); changedLarge.fullSchemaBefore.ExistingBusiness[2] += ' -- changed original SQL';
  assert.throws(() => python(DEPLOYED_PROBE, changedLarge));
  assert.throws(() => python(DEPLOYED_PROBE, { ...large, identity: ['0', '0'] }));
  assert.equal(sha(fs.readFileSync(large.database)), largeBefore); assert.equal(sha(fs.readFileSync(large.backup)), largeBackupBefore);
  cases.push('actual_original_sqlite_schema_over_138154_bytes_uses_stdin_preserves_legacy_argv_and_rejects_schema_or_identity_drift_without_writes');
  for (const change of [v => { v.identity[1] = '0'; }, v => { v.schemaSha256 = '0'.repeat(64); },
    v => { v.backupCounts.ExistingBusiness = 99; }, v => { v.database += '.missing'; }]) {
    const invalid = structuredClone(good); change(invalid); assert.throws(() => python(DEPLOYED_PROBE, invalid));
  }
  for (const [name, statement] of [
    ['missing-index', 'DROP INDEX "UsageAttribution_occurred_at_idx"'],
    ['changed-index', 'DROP INDEX "UsageAttribution_occurred_at_idx"; CREATE INDEX "UsageAttribution_occurred_at_idx" ON "UsageAttribution"("owner_user_id")'],
    ['extra-object', 'CREATE TABLE Unexpected (id TEXT)'],
    ['changed-old-schema', 'ALTER TABLE ExistingBusiness ADD COLUMN changed TEXT'],
  ]) {
    const invalid = make(name);
    python("import sqlite3,sys,json;d=json.loads(sys.argv[1]);c=sqlite3.connect(d['database']);c.executescript(d['sql']);c.close()",
      { database: invalid.database, sql: statement });
    assert.throws(() => python(DEPLOYED_PROBE, invalid));
  }
  cases.push('real_sqlite_wrong_identity_schema_index_sql_backup_or_missing_database_fails_closed');
  const baseline = fixtureBaseline;
  const canvasSql = fs.readFileSync(baseline + '/' + CANVAS_BATCH_SQL, 'utf8');
  const canvas = make('deployed-canvas');
  const withCanvas = String.raw`import sqlite3,sys,json,hashlib
d=json.loads(sys.argv[1])
with sqlite3.connect(d['database']) as c:
 c.executescript(d['sql'])
 c.execute("INSERT INTO CanvasVideoBatch(id,owner_user_id,document_id,node_id,project_id,client_request_id,request_hash,count,frozen_input_json,authorized_total,updated_at) VALUES ('batch','owner','doc','node','project','request','hash',2,'{}',200,'2026-10-21')")
 c.execute("INSERT INTO CanvasVideoBatchChild(id,batch_id,ordinal,request_id,idempotency_key,business_fingerprint,route_fingerprint,frozen_input_json,authorized_maximum,quote_expires_at,updated_at) VALUES ('child','batch',1,'child-request','key','business','route','{}',100,'2026-10-22','2026-10-21')");c.commit()
 rows={r[0]:[r[1],r[2],r[3]] for r in c.execute("SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name LIKE 'CanvasVideoBatch%' ORDER BY name")}
print(json.dumps(rows))`;
  const canvasBatchObjects = JSON.parse(python(withCanvas, { database: canvas.database, sql: canvasSql }));
  assert.equal(Object.keys(canvasBatchObjects).length, 11);
  const combined = { ...canvas, canvasBatchObjects }, combinedBefore = sha(fs.readFileSync(canvas.database));
  assert.equal(JSON.parse(python(DEPLOYED_PROBE, combined)).attributionRows, 1);
  assert.equal(sha(fs.readFileSync(canvas.database)), combinedBefore);
  assert.throws(() => python(DEPLOYED_PROBE, canvas));
  const changedObjects = structuredClone(combined); changedObjects.canvasBatchObjects.CanvasVideoBatch[2] += ' changed';
  assert.throws(() => python(DEPLOYED_PROBE, changedObjects));
  cases.push('actual_usage_and_canvas_sql_nonempty_rows_read_only_union_requires_all_exact_original_objects');

  const sourceRoot = path.join(temporary, 'prisma-eras'); fs.mkdirSync(sourceRoot);
  const write = (root, file, bytes) => { fs.mkdirSync(path.dirname(root + '/' + file), { recursive: true }); fs.writeFileSync(root + '/' + file, bytes, { mode: 0o644 }); };
  const roots = Object.fromEntries(['usageMain', 'usageGuard', 'canvasPre', 'canvasMain', 'canvasGuard', 'priorMain', 'priorGuard', 'main', 'guard']
    .map(name => [name, sourceRoot + '/' + name]));
  const oldPrisma = Buffer.from('old reviewed Prisma\n'), newPrisma = Buffer.from('new reviewed Prisma with canvas models\n');
  const schemaBytes = Object.fromEntries(SCHEMA_FILES.filter(file => file !== 'prisma/schema.prisma')
    .map(file => [file, fs.readFileSync(baseline + '/' + file)]));
  for (const [name, root] of Object.entries(roots)) {
    for (const [file, bytes] of Object.entries(schemaBytes)) write(root, file, bytes);
    write(root, 'prisma/schema.prisma', ['usageMain', 'usageGuard', 'canvasPre'].includes(name) ? oldPrisma : newPrisma);
  }
  const sourceFiles = Object.fromEntries(SCHEMA_FILES.map(file => [file, sha(file === 'prisma/schema.prisma' ? newPrisma : schemaBytes[file])]));
  const prior = { runId: '30000000-0000-4000-8000-000000000001', mainSource: '1'.repeat(40), guardSource: '2'.repeat(40),
    main: { source: '1'.repeat(40), root: roots.priorMain, version: '0.102.0' },
    guard: { source: '2'.repeat(40), root: roots.priorGuard, version: '0.102.0+guard.1' } };
  const pair = { schema: 'pricing-writer-start-allowlist.v1', project: 'video-api-debugger', runId: prior.runId,
    releases: [prior.main, prior.guard].map(value => ({ ...value, build: 'original-build', sourceFiles })) };
  const allowed = Buffer.from(JSON.stringify(pair));
  const final = { pricingStartControl: { allowed: { bytesBase64: allowed.toString('base64'), sha256: sha(allowed) } },
    writerStartIntent: { schema: 'pricing-new-writer-start-intent.v1', runId: prior.runId, allowedSha256: sha(allowed) } };
  const helper = fs.readFileSync(new URL('./canvas-batch-schema-contract.mjs', import.meta.url));
  const migrator = fs.readFileSync(baseline + '/' + CANVAS_BATCH_MIGRATOR);
  const eraManifest = { appUser: 'root', main: { root: roots.main }, guard: { root: roots.guard },
    live: { web: { root: roots.priorMain } }, stage: sourceRoot + '/stage', deployedCanvasBatchSchema: {},
    canvasVideoBatchSchema: { schema: 'sd2-canvas-video-batch-schema-input.v1', previousPrismaSha256: sha(oldPrisma),
      newPrismaSha256: sha(newPrisma), sqlSha256: sha(canvasSql), migrationModuleSha256: sha(migrator) } };
  write(eraManifest.stage, 'fix01-release/canvas-batch-schema-contract.mjs', helper);
  for (const kind of ['main', 'guard']) {
    write(eraManifest[kind].root, CANVAS_BATCH_SQL, canvasSql); write(eraManifest[kind].root, CANVAS_BATCH_MIGRATOR, migrator);
    write(eraManifest[kind].root, 'ops/canvas-video-batch-schema-extension.mjs', helper);
    write(eraManifest[kind].root, CANVAS_BATCH_MODE, `export const CANVAS_VIDEO_BATCH_WRITES_ENABLED: boolean = ${kind === 'main' ? 'true' : 'false'};\n`);
  }
  const eraHistory = { prior, final, original: { main: { root: roots.usageMain }, guard: { root: roots.usageGuard } },
    receipt: { sqlSha256: sourceFiles[SCHEMA_FILES[0]] } };
  const batchMigration = { originalManifest: { main: { root: roots.canvasMain }, guard: { root: roots.canvasGuard },
    live: { web: { root: roots.canvasPre } } } };
  assert.deepEqual(unchangedSchemaInputs(eraManifest, eraHistory, { batchMigration }), sourceFiles);
  assert.deepEqual(unchangedSchemaInputs({ ...eraManifest, main: { root: sourceRoot + '/not-extracted-main' },
    guard: { root: sourceRoot + '/not-extracted-guard' } }, eraHistory, { candidates: false, batchMigration }), sourceFiles);
  for (const root of [roots.usageMain, roots.canvasPre, roots.canvasMain, roots.priorMain, roots.main]) {
    const bytes = fs.readFileSync(root + '/prisma/schema.prisma'); write(root, 'prisma/schema.prisma', 'changed');
    assert.throws(() => unchangedSchemaInputs(eraManifest, eraHistory, { batchMigration })); write(root, 'prisma/schema.prisma', bytes);
  }
  cases.push('source_provenance_checks_pre_usage_pre_canvas_published_and_new_prisma_eras_without_same_hash_shortcuts');
} finally { fs.rmSync(temporary, { recursive: true }); }

const here = path.dirname(new URL(import.meta.url).pathname);
const lifecycle = fs.readFileSync(here + '/candidate-lifecycle-engineering.mjs', 'utf8');
assert.ok(lifecycle.includes("f.switchApi.proof(f.m)"));
assert.ok(lifecycle.includes('fixture({ previous: f, retainedProof })'));
assert.ok(lifecycle.includes('next.switchApi.switchPair(next.m'));
assert.ok(lifecycle.includes('next.deployed.readDeployedUsageEvidence(next.m)'));
cases.push('connected_second_publication_consumes_actual_first_switch_and_proof_in_native_lifecycle_batch');
if (MV_DIRECT.recoveredGuardBaseline || fixtureManifest) {
  // An explicit root-owned read-only fixture exercises the next-source branch
  // before reserving a normal run; the native release batch keeps its real manifest.
  const current = explicitFixture || JSON.parse(rootFile('/data/video-api-debugger/release-staging/' + MV_DIRECT.recoveryRunId + '/manifest.json'));
  // Preserve the real earlier consumers while exercising the new exact source.
  const priorInputs = current.recoveredGuardBaseline.schema === R17_RECOVERED_GUARD.schema ? [R10_RECOVERED_GUARD, R14_RECOVERED_GUARD, R17_RECOVERED_GUARD]
    : current.recoveredGuardBaseline.schema === R14_RECOVERED_GUARD.schema ? [R10_RECOVERED_GUARD, R14_RECOVERED_GUARD]
    : current.recoveredGuardBaseline.schema === R10_RECOVERED_GUARD.schema ? [R10_RECOVERED_GUARD] : [];
  const manifests = [...priorInputs.map(input => JSON.parse(rootFile('/data/video-api-debugger/release-staging/' + input.runId + '/manifest.json'))), current];
  for (const m of manifests) {
  const retained = assertRecoveredGuardInput(m.recoveredGuardBaseline), r10 = retained.schema === R10_RECOVERED_GUARD.schema,
    r14 = retained.schema === R14_RECOVERED_GUARD.schema, r17 = retained.schema === R17_RECOVERED_GUARD.schema;
  const stage = '/data/video-api-debugger/release-staging/' + retained.runId;
  const get = (file, pin) => { const bytes = rootFile(stage + '/' + file); assert.equal(sha(bytes), retained[pin]); return JSON.parse(bytes); };
  const records = { prior: get('manifest.json', 'manifestSha256'), fixed: get('fixed-guard-recovery.json', 'fixedGuardSha256'),
    build: get('guard-build.json', 'guardBuildReceiptSha256'), seal: get('guard-immutable-success.json', 'guardImmutableSuccessSha256'),
    complete: get('guard-recovery-complete.json', 'recoveryCompleteSha256'), command: get('normal-switch-command-return.json', 'switchCommandSha256'),
    proof: get('guard-baseline-readonly-proof.json', 'proofSha256'), proofCommand: get('guard-baseline-readonly-proof-command.json', 'proofCommandSha256') };
  const publicationBytes = rootFile(stage + '/allowed-original.json.published.json');
  assert.equal(sha(publicationBytes), records.proof.writerStartIntent.transitionReceiptSha256);
  records.pricingPublication = JSON.parse(publicationBytes);
  if (r10 || r14 || r17) {
    records.recoveryEvidenceIndex = get(r17 ? 'r17-failure-recovery-evidence-index.json'
      : r14 ? 'r14-failure-recovery-evidence-index.json' : 'failure-recovery-evidence-index.json', 'recoveryEvidenceIndexSha256');
    records.recoveryEvidence = Object.fromEntries(Object.entries(records.recoveryEvidenceIndex.pins).map(([name, digest]) => {
      assert.ok(path.basename(name) === name || (r17 && ['private-recipe/admission.json', 'private-recipe/apply.json',
        'private-recipe/payload.json', 'private-recipe/plan.json', 'private-recipe/verification.json'].includes(name)));
      const bytes = rootFile(stage + '/' + name); assert.equal(sha(bytes), digest); return [name, JSON.parse(bytes)];
    }));
  }
  const identity = records.proof.protection.databaseIdentity;
  const originalRecordsSha256 = sha(JSON.stringify(records));
  Object.freeze(records);
  if (records.recoveryEvidence) Object.freeze(records.recoveryEvidence);
  assertRecoveredGuardInput(m.recoveredGuardBaseline);
  for (const key of Object.keys(retained)) {
    const missing = { ...m.recoveredGuardBaseline }; delete missing[key]; assert.throws(() => assertRecoveredGuardInput(missing));
    assert.throws(() => assertRecoveredGuardInput({ ...m.recoveredGuardBaseline, [key]: 'wrong' }));
  }
  assert.throws(() => assertRecoveredGuardInput({ ...m.recoveredGuardBaseline, allowOldBuild: true }));
  const authority = assertRecoveredGuardRecords(m, records, identity);
  assert.equal(authority.roleKind, 'guard'); assert.equal(authority.prior.runId, retained.runId);
  const failures = [
    r => ({ ...r, prior: { ...r.prior, guardSource: '0'.repeat(40) } }),
    r => ({ ...r, prior: { ...r.prior, database: r.prior.database + '.other' } }),
    r => ({ ...r, prior: { ...r.prior, deployedUsageSchema: { ...r.prior.deployedUsageSchema, publicationRun: r.prior.runId } } }),
    r => ({ ...r, fixed: { ...r.fixed, continueMain: true } }),
    r => ({ ...r, fixed: { ...r.fixed, bindings: { ...r.fixed.bindings, storage: r.fixed.bindings.storage + '.other' } } }),
    r => ({ ...r, fixed: { ...r.fixed, guardEntry: { ...r.fixed.guardEntry, build: r.fixed.guardEntry.build + '.other' } } }),
    r => ({ ...r, build: { ...r.build, exitCode: 1 } }),
    r => ({ ...r, seal: { ...r.seal, originalTimesChanged: true } }),
    r => ({ ...r, seal: { ...r.seal, sealedAt: new Date(r.build.startedAt + 1800001).toISOString() } }),
    r => ({ ...r, complete: { ...r.complete, completed: false } }),
    r => ({ ...r, complete: { ...r.complete, route: 'original-before-fence' } }),
    r => ({ ...r, complete: { ...r.complete, businessDataRestored: true } }),
    r => ({ ...r, complete: { ...r.complete, healthy: { ...r.complete.healthy, actualHealthy: false } } }),
    r => ({ ...r, complete: { ...r.complete, ingress: { ...r.complete.ingress, exactOriginalBytesRestored: false } } }),
    r => ({ ...r, command: { ...r.command, status: 0 } }),
    r => ({ ...r, proofCommand: { ...r.proofCommand, status: 1 } }),
    r => ({ ...r, proofCommand: { ...r.proofCommand, finish: r.proofCommand.start } }),
    r => ({ ...r, proof: { ...r.proof, protection: { ...r.proof.protection,
      databaseIdentity: r.proof.protection.databaseIdentity.map((value, index) => index === 1 ? '0' : value) } } }),
    r => ({ ...r, proof: { ...r.proof, role: { ...r.proof.role, forcedKill: true } } }),
    r => ({ ...r, proof: { ...r.proof, units: { ...r.proof.units, web: { ...r.proof.units.web, MainPID: '1' } } } }),
    r => ({ ...r, proof: { ...r.proof, units: { ...r.proof.units, image: { ...r.proof.units.image, InvocationID: '0'.repeat(32) } } } }),
    r => ({ ...r, proof: { ...r.proof, units: { ...r.proof.units, hd: { ...r.proof.units.hd, WorkingDirectory: '/other' } } } }),
    r => ({ ...r, proof: { ...r.proof, role: { ...r.proof.role, current: { ...r.proof.role.current, ActiveState: 'failed' } } } }),
    r => ({ ...r, proof: { ...r.proof, writerStartIntent: { ...r.proof.writerStartIntent, allowedSha256: '0'.repeat(64) } } }),
    r => ({ ...r, proof: { ...r.proof, pricingStartControl: { ...r.proof.pricingStartControl, marker: { ...r.proof.pricingStartControl.marker, sha256: '0'.repeat(64) } } } }),
    r => ({ ...r, pricingPublication: { ...r.pricingPublication, runId: 'wrong' } }),
    r => ({ ...r, pricingPublication: { ...r.pricingPublication, installed: { ...r.pricingPublication.installed, sha256: '0'.repeat(64) } } }),
    r => ({ ...r, pricingPublication: { ...r.pricingPublication, at: r.fixed.armedAt } }),
    r => ({ ...r, fixed: { ...r.fixed, pair: { ...r.fixed.pair, allowed: { ...r.fixed.pair.allowed, at: r.pricingPublication.at } } } }),
    r => ({ ...r, proof: { ...r.proof, writerStartIntent: { ...r.proof.writerStartIntent, at: r.fixed.armedAt } } }),
    r => ({ ...r, proof: { ...r.proof, writerStartIntent: { ...r.proof.writerStartIntent, transitionReceiptSha256: '0'.repeat(64) } } }),
  ];
  for (const change of failures) assert.throws(() => assertRecoveredGuardRecords(m, change(records), identity));
  for (const change of [v => { v.reuseBuilds = {}; }, v => { v.privateMultiviewInstall = false; },
    v => { v.mainSource = records.prior.mainSource; }, v => { v.live.web.source = '0'.repeat(40); },
    v => { v.live.role.invocation = '0'.repeat(32); }]) {
    const bad = structuredClone(m); change(bad);
    if (isSharedEngine(bad) && bad.reuseBuilds && bad.reuseBuilds.schema !== 'sd2-original-build-reuse-input.v1') {
      // Shared baseline reading permits reuse; malformed reuse is rejected by
      // the real immutable-manifest entry gate before this baseline consumer.
      assert.throws(() => validateManifest(bad), error => error.code === 'ERR_ASSERTION'
        && error.message.includes('sd2-original-build-reuse-input.v1'));
    } else assert.throws(() => assertRecoveredGuardRecords(bad, records, identity));
  }
  assert.equal(readRecoveredGuardBaseline(m, identity).entry.source, authority.entry.source);
  if (!r10 && !r14 && !r17) {
    assert.deepEqual(retained, R08_RECOVERED_GUARD);
    cases.push('exact_r08_failed_publication_and_fixed_guard_recovery_bind_original_full_build_seal_commands_identity_and_four_roles');
    cases.push('r08_recovery_rejects_all_missing_changed_pins_and_thirty_six_record_or_manifest_drifts_without_ttl_exception');
  } else {
    for (const name of Object.keys(records.recoveryEvidence)) {
      const missing = { ...records, recoveryEvidence: { ...records.recoveryEvidence } }; delete missing.recoveryEvidence[name];
      assert.throws(() => assertRecoveredGuardRecords(m, missing, identity));
      const changed = withEvidence(records, name, value => ({ ...value, unexpected: true }));
      assert.throws(() => assertRecoveredGuardRecords(m, changed, identity));
    }
    for (const change of [r => { const bad = { ...r }; delete bad.recoveryEvidenceIndex; return bad; },
      r => ({ ...r, recoveryEvidenceIndex: { ...r.recoveryEvidenceIndex, pins: { ...r.recoveryEvidenceIndex.pins, '../escape.json': '0'.repeat(64) } } }),
      r => ({ ...r, recoveryEvidenceIndex: { ...r.recoveryEvidenceIndex, pins: { ...r.recoveryEvidenceIndex.pins, 'multiview-works-ready-guard.json': '0'.repeat(64) } } }),
      r => ({ ...r, complete: { ...r.complete, healthy: { ...r.complete.healthy, multiviewWorks: { ...r.complete.healthy.multiviewWorks,
        current: { ...r.complete.healthy.multiviewWorks.current, MainPID: '1' } } } } }),
      r => ({ ...r, proofCommand: { ...r.proofCommand, stdoutSha256: '0'.repeat(64) } }),
    ]) assert.throws(() => assertRecoveredGuardRecords(m, change(records), identity));
    for (const change of [v => { delete v.live.works; }, v => { v.live.works.source = records.prior.mainSource; },
      v => { v.live.works.root = records.prior.main.root; }, v => { v.live.works.pid = records.prior.live.works.pid; },
      v => { v.live.works.invocation = '0'.repeat(32); }, v => { v.live.works.execMainStartTimestampMonotonic = '0'; },
      v => { v.live.works.build += '.other'; }, v => { v.live.template.pid = 1; },
      v => { v.deployedUsageSchema.publicationRun = retained.runId; },
      v => { v.normalContinuation = { schema: 'sd2-normal-continuation-input.v2' }; }]) {
      const bad = structuredClone(m); change(bad); assert.throws(() => assertRecoveredGuardRecords(bad, records, identity));
    }
    assert.equal(fs.existsSync(stage + '/switch-complete.json'), false);
    const published = readPublishedBaselineSourceFiles(m, SCHEMA_FILES), role = priorUsageRoleControl(m);
    const allowed = JSON.parse(role.allowed), guard = allowed.releases.find(value => value.source === published.source);
    assert.equal(published.source, authority.entry.source); assert.equal(published.root, authority.entry.root);
    assert.equal(allowed.runId, retained.runId); assert.equal(published.recoveredGuard.manifestSha256, retained.manifestSha256);
    assert.equal(guard.root, published.root); assert.equal(guard.build, authority.entry.build);
    assert.equal(guard.sourceSha256['ops/sd2-usage-role-start.mjs'], published.sourceFiles['ops/sd2-usage-role-start.mjs']);
    assert.equal(published.publicationRun, m.deployedUsageSchema.publicationRun);
    assert.notEqual(published.publicationRun, retained.runId);
    if (r17) {
      assert.deepEqual(retained, R17_RECOVERED_GUARD);
      const r17Failures = [
        r => withEvidence(r, 'r17-exact-recovery-admission.json', value => ({ ...value, guardOnly: false })),
        r => withEvidence(r, 'r17-exact-recovery-admission.json', value => ({ ...value, productionWrites: 1 })),
        r => withEvidence(r, 'r17-exact-recovery-continuation.json', value => ({ ...value, originalFailureSha256: '0'.repeat(64) })),
        r => withEvidence(r, 'r17-exact-recovery-complete.json', value => ({ ...value, normalPublication: true })),
        r => withEvidence(r, 'guard-recovery-failed.json', value => ({ ...value, preservedSafetyState: false })),
        r => withEvidence(r, 'fixed-guard-recovery-armed.json', value => ({ ...value, source: r.prior.mainSource })),
        r => withEvidence(r, 'multiview-works-transition-0011.json', value => ({ ...value, privateReady: false })),
        r => withEvidence(r, 'multiview-works-transition-0015.json', value => ({ ...value, forcedKill: true })),
        r => withEvidence(r, 'multiview-works-transition-0016.json', value => ({ ...value, allAdmittedProcessesGone: false })),
        r => withEvidence(r, 'multiview-works-transition-0019.json', value => ({ ...value, current: { MainPID: value.current.MainPID } })),
        r => withEvidence(r, 'multiview-works-transition-0020.json', value => ({ ...value, guardSafe: false })),
        r => withEvidence(r, 'multiview-works-ready-guard.json', value => ({ ...value, startup: {} })),
        r => withEvidence(r, 'private-recipe/apply.json', value => ({ ...value, revision: 5, version: '1.0.5' })),
        r => withEvidence(r, 'private-recipe/apply.json', value => ({ ...value, installedProof: {} })),
        r => withEvidence(r, 'private-recipe/verification.json', value => ({ ...value, planSha256: '0'.repeat(64) })),
        r => withEvidence(r, 'multiview-private-preopen-complete.json', value => ({ ...value, recipe: { ...value.recipe, applied: false } })),
        r => withEvidence(r, 'multiview-backup-before.json', value => ({ ...value, mainSource: r.prior.guardSource })),
        r => withEvidence(r, 'multiview-backup-transition.json', value => ({ ...value, captureSha256: '0'.repeat(64) })),
        r => withEvidence(r, 'multiview-backup-published.json', value => ({ ...value, dropin: { ...value.dropin, identity: ['0', '0'] } })),
        r => ({ ...r, command: { ...r.command, at: r.complete.finishedAt } }),
        r => ({ ...r, recoveryEvidenceIndex: { ...r.recoveryEvidenceIndex, installedPrivateRecipeRetained: false } }),
        r => ({ ...r, recoveryEvidenceIndex: { ...r.recoveryEvidenceIndex, compact: [...r.recoveryEvidenceIndex.compact, 'private-recipe/apply.json'] } }),
        r => ({ ...r, recoveryEvidenceIndex: { ...r.recoveryEvidenceIndex,
          pins: { ...r.recoveryEvidenceIndex.pins, 'private-recipe/../apply.json': retained.installedRecipeReceiptSha256 } } }),
      ];
      for (const change of r17Failures) assert.throws(() => assertRecoveredGuardRecords(m, change(records), identity));
      for (const change of [v => { v.guardSource = records.prior.guardSource; },
        v => { v.deployedCanvasBatchSchema.migrationRun = retained.runId; },
        v => { v.reuseBuilds = { sourceRun: retained.runId }; },
        v => { v.live.works.execMainStartTimestampMonotonic = records.prior.live.works.execMainStartTimestampMonotonic; }]) {
        const bad = structuredClone(m); change(bad);
        if (isSharedEngine(bad) && bad.reuseBuilds && bad.reuseBuilds.schema !== 'sd2-original-build-reuse-input.v1') {
          assert.throws(() => validateManifest(bad), error => error.code === 'ERR_ASSERTION'
            && error.message.includes('sd2-original-build-reuse-input.v1'));
        } else assert.throws(() => assertRecoveredGuardRecords(bad, records, identity));
      }
      assert.equal(records.recoveryEvidence['private-recipe/apply.json'].revision, 6);
      assert.equal(records.recoveryEvidence['private-recipe/apply.json'].version, '1.0.6');
      assert.ok(Date.parse(records.command.at) < Date.parse(records.complete.startedAt));
      assert.equal(published.publicationRun, '6a041bed-c909-4370-972f-2299321d7f1f');
      cases.push('exact_r17_55_original_records_bind_failed_publication_independent_guard_recovery_and_twenty_complete_works_transitions');
      cases.push('r17_retains_original_private_revision6_activation_proofs_and_backup_capture_transition_publication_without_reapply');
      cases.push('r17_rejects_every_missing_changed_pin_subpath_private_proof_backup_drift_partial_identity_summary_old_pair_or_continuation');
      cases.push('r17_reader_and_usage_role_allowlist_share_exact_31b_recovery_while_6a_schema_history_and_original_build_times_remain');
    } else if (r14) {
      assert.deepEqual(retained, R14_RECOVERED_GUARD);
      for (const change of [
        r => withEvidence(r, 'r14-private-state-after-recovery.json', value => ({ ...value, activationExists: true })),
        r => withEvidence(r, 'multiview-works-transition-0012.json', value => ({ ...value, forcedKill: true })),
        r => withEvidence(r, 'multiview-works-transition-0012.json', value => ({ ...value, allAdmittedProcessesGone: false })),
        r => withEvidence(r, 'multiview-works-transition-0012.json', value => ({ ...value, before: { ...value.before, InvocationID: '0'.repeat(32) } })),
        r => withEvidence(r, 'multiview-works-transition-0015.json', value => ({ ...value, current: { ...value.current, ExecMainStartTimestampMonotonic: '0' } })),
        r => withEvidence(r, 'multiview-works-ready-guard.json', value => ({ ...value, startup: {} })),
        r => ({ ...r, recoveryEvidenceIndex: { ...r.recoveryEvidenceIndex, compact: [...r.recoveryEvidenceIndex.compact, 'guard-recovery-complete.json'] } }),
      ]) assert.throws(() => assertRecoveredGuardRecords(m, change(records), identity));
      cases.push('exact_r14_43_original_records_bind_normal_fixed_guard_recovery_sixteen_works_transitions_and_no_private_apply');
      cases.push('r14_recovery_rejects_every_missing_changed_pin_wrong_failure_natural_stop_startup_runtime_or_permission_source');
      cases.push('r14_source_reader_and_role_allowlist_share_exact_e06_recovery_while_6a_schema_history_and_fresh_pair_requirement_remain');
    } else {
      cases.push('exact_r10_index_binds_all_47_original_records_failure_emergency_wrapper_natural_stop_and_fifteen_works_transitions');
      cases.push('r10_recovery_rejects_every_missing_changed_record_pin_path_and_same_run_works_or_template_drift');
      cases.push('r10_source_reader_and_usage_role_allowlist_share_verified_guard_authority_while_normal_schema_history_stays_original');
    }
  }
  assert.equal(sha(JSON.stringify(records)), originalRecordsSha256, 'Negative fixtures must not change shared original recovery evidence');
  }
}
console.log(JSON.stringify({ schema: 'sd2-deployed-usage-schema-engineering.v1', completed: true, cases,
  fixtureOnly: true, productionWrites: 0, liveServiceCalls: 0, networkRequests: 0, functionalAcceptance: false }));
