import { releaseDependencyRoot, fullSchemaBefore, verifyFullCandidateSources } from './full-release-contract.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import * as contract from './canvas-batch-schema-contract.mjs';
import { assertCanvasBatchSchemaInput, assertCanvasBatchPrismaExtension } from './canvas-batch-schema-contract.mjs';
import { PROTECTED_INCREMENT, PROTECTED_INCREMENT_SOURCE_FILES,
  assertProtectedIncrementCandidate } from './release-contract.mjs';
import { CANVAS_BATCH_PROBE, readOriginalCanvasBatchMigration, DEPLOYED_CANVAS_FIELDS } from './canvas-batch-schema.mjs';
import { engineDirectory, isSharedEngine } from './common.mjs';
import { verifyDeployedContinuationProvenance, verifySharedBuildProvenance } from './normal-continuation.mjs';
import { verifyDeployedUsageSchema } from './deployed-usage-schema.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const before = 'model CanvasDocument {\n  id String @id\n}\n\nmodel CanvasDocumentRevision {\n  id String @id\n}\n';
const inserted = '// Durable batch/fee identities survive canvas deletion and snapshot retention.\n'
  + '// Amounts are integer credit cents, not floating-point display totals.\n'
  + 'model CanvasVideoBatch {\n  id String @id\n}\n\nmodel CanvasVideoBatchChild {\n  id String @id\n}\n\n';
const after = before.replace('model CanvasDocumentRevision {', inserted + 'model CanvasDocumentRevision {');
const input = { schema: 'sd2-canvas-video-batch-schema-input.v1', sqlSha256: 'a'.repeat(64), migrationModuleSha256: 'b'.repeat(64),
  previousPrismaSha256: hash(before), newPrismaSha256: hash(after) };
assertCanvasBatchSchemaInput(input); assertCanvasBatchPrismaExtension(Buffer.from(before), Buffer.from(after), input);
const changed = after.replace('model CanvasDocument {\n  id String', 'model CanvasDocument {\n  id Int');
assert.throws(() => assertCanvasBatchPrismaExtension(Buffer.from(before), Buffer.from(changed), { ...input, newPrismaSha256: hash(changed) }));
assert.throws(() => assertCanvasBatchSchemaInput({ ...input, allowLegacy: true }));
const deployedCanvasInput = Object.fromEntries(DEPLOYED_CANVAS_FIELDS.map(key => [key, key === 'schema'
  ? 'sd2-deployed-canvas-video-batch-schema-input.v1' : key.endsWith('Sha256') ? 'a'.repeat(64) : '10000000-0000-4000-8000-000000000001']));
for (const mode of [{ reuseBuilds: {} }, { normalContinuation: { schema: 'sd2-normal-continuation-input.v3' } },
  { normalContinuation: { schema: 'sd2-normal-continuation-input.v2' }, reuseBuilds: {} }]) {
  assert.throws(() => readOriginalCanvasBatchMigration({ deployedCanvasBatchSchema: deployedCanvasInput,
    canvasVideoBatchSchema: input, deployedUsageSchema: {}, ...mode }));
}
const deployedCanvasSource = fs.readFileSync(new URL('./canvas-batch-schema.mjs', import.meta.url), 'utf8');

const protectedBaseline = '31bff5a6544a3d18d433b81fa7735ed57b0d012c';
assert.equal(PROTECTED_INCREMENT.baselineSource, protectedBaseline);
const protectedFixture = () => {
  const roots = { live: '/synthetic/protected/live', main: '/synthetic/protected/main', guard: '/synthetic/protected/guard' };
  const m = { baselineSource: protectedBaseline, recoveredGuardBaseline: { schema: 'sd2-multiview-r17-recovered-guard.v1' },
    privateMultiviewInstall: true, deployedUsageSchema: {}, deployedCanvasBatchSchema: {}, canvasVideoBatchSchema: {},
    normalContinuation: null, reuseBuilds: null, protectedIncrement: structuredClone(PROTECTED_INCREMENT),
    live: { web: { root: roots.live, source: protectedBaseline } }, main: { root: roots.main }, guard: { root: roots.guard } };
  const sources = new Map();
  for (const file of PROTECTED_INCREMENT_SOURCE_FILES) {
    const source = file === 'src/lib/pricing/build-mode.ts'
      ? 'export const PRICING_ADMIN_WRITES_ENABLED: boolean = false;\n'
      : file === 'src/lib/canvas-video-batches-build-mode.ts'
        ? 'export const CANVAS_VIDEO_BATCH_WRITES_ENABLED: boolean = false;\n'
        : `reviewed baseline ${file}\n`;
    for (const root of Object.values(roots)) sources.set(root + '/' + file, Buffer.from(source));
  }
  const read = file => {
    if (!sources.has(file)) throw new Error('Synthetic protected source missing: ' + file);
    return sources.get(file);
  };
  return { m, roots, sources, read };
};
for (const kind of ['main', 'guard']) {
  const fixture = protectedFixture();
  assert.equal(assertProtectedIncrementCandidate(fixture.m, kind, fixture.read), true);
}
for (const file of PROTECTED_INCREMENT_SOURCE_FILES) for (const kind of ['main', 'guard']) {
  let fixture = protectedFixture();
  fixture.sources.set(fixture.roots[kind] + '/' + file, Buffer.from('candidate drift\n'));
  assert.throws(() => assertProtectedIncrementCandidate(fixture.m, kind, fixture.read));
  fixture = protectedFixture();
  fixture.sources.delete(fixture.roots[kind] + '/' + file);
  assert.throws(() => assertProtectedIncrementCandidate(fixture.m, kind, fixture.read));
}
for (const [file, name] of [['src/lib/pricing/build-mode.ts', 'PRICING_ADMIN_WRITES_ENABLED'],
  ['src/lib/canvas-video-batches-build-mode.ts', 'CANVAS_VIDEO_BATCH_WRITES_ENABLED']]) for (const kind of ['main', 'guard']) {
  const fixture = protectedFixture(), enabled = Buffer.from(`export const ${name}: boolean = true;\n`);
  fixture.sources.set(fixture.roots.live + '/' + file, enabled);
  fixture.sources.set(fixture.roots[kind] + '/' + file, enabled);
  assert.throws(() => assertProtectedIncrementCandidate(fixture.m, kind, fixture.read));
}
{
  const fixture = protectedFixture(), route = 'src/app/api/tasks/create/route.ts';
  fixture.sources.set(fixture.roots.main + '/' + route, Buffer.concat([fixture.read(fixture.roots.live + '/' + route), Buffer.from('changed')]));
  assert.throws(() => assertProtectedIncrementCandidate(fixture.m, 'main', fixture.read));
}
for (const protectedIncrement of [{ ...PROTECTED_INCREMENT, extra: true }, { ...PROTECTED_INCREMENT, schema: 'unknown' },
  ...['pricingWrites', 'multiviewGeneration', 'canvasVideoBatchWrites'].map(key => ({ ...PROTECTED_INCREMENT, [key]: true }))]) {
  const fixture = protectedFixture(); fixture.m.protectedIncrement = protectedIncrement;
  assert.throws(() => assertProtectedIncrementCandidate(fixture.m, 'main', fixture.read));
}
for (const change of [m => { m.baselineSource = '0'.repeat(40); }, m => { m.normalContinuation = {}; }, m => { m.reuseBuilds = {}; }]) {
  const fixture = protectedFixture(); change(fixture.m);
  assert.throws(() => assertProtectedIncrementCandidate(fixture.m, 'main', fixture.read));
}
for (const kind of ['main', 'guard']) {
  const fixture = protectedFixture(); fixture.m.protectedIncrement = null;
  assert.equal(assertProtectedIncrementCandidate(fixture.m, kind, () => { throw new Error('Normal branch must not read protected sources'); }), false);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-batch-control-'));
try {
  const setup = String.raw`
import sqlite3,json,hashlib,pathlib,sys,os
p=pathlib.Path(sys.argv[1]);db=p/'live.sqlite';backup=p/'backup.sqlite'
def schema(c):return {r[0]:[r[1],r[2],r[3]] for r in c.execute("SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")}
def digest(o):return hashlib.sha256(json.dumps(o,separators=(',',':'),ensure_ascii=True).encode()).hexdigest()
with sqlite3.connect(db) as c:
 c.execute("CREATE TABLE Original(id TEXT PRIMARY KEY, original_note TEXT DEFAULT '"+'x'*140000+"')")
 c.execute("INSERT INTO Original(id) VALUES ('keep')");c.commit()
 old=schema(c)
 with sqlite3.connect(backup) as b:c.backup(b)
 c.execute('CREATE TABLE CanvasVideoBatch(id TEXT PRIMARY KEY)')
 c.execute('CREATE TABLE CanvasVideoBatchChild(id TEXT PRIMARY KEY)')
 new=schema(c);added={n:new[n] for n in sorted(set(new)-set(old))}
s=os.stat(db)
print(json.dumps({'database':str(db),'backup':str(backup),'databaseIdentity':[str(s.st_dev),str(s.st_ino)],'originalSchemaSha256':digest(old),'newSchemaSha256':digest(added),'newObjects':list(added),'fullSchemaBefore':new}))
`;
  const proof = JSON.parse(execFileSync('python3', ['-I', '-c', setup, root], { encoding: 'utf8' }));
  // The large input is actual SQLite original-schema SQL, not an ignored
  // padding field. Keep one small argv call to prove the old reader contract.
  const legacyProof = { ...proof }; delete legacyProof.fullSchemaBefore;
  const legacyObserved = JSON.parse(execFileSync('python3', ['-I', '-c', CANVAS_BATCH_PROBE, JSON.stringify(legacyProof)], { encoding: 'utf8' }));
  const schemaInput = JSON.stringify(proof), schemaInputBytes = Buffer.byteLength(schemaInput);
  assert.ok(schemaInputBytes > 133499);
  const probeFromStdin = value => JSON.parse(execFileSync('python3', ['-I', '-c', CANVAS_BATCH_PROBE], {
    encoding: 'utf8', timeout: 120000, input: JSON.stringify(value) }));
  const observed = probeFromStdin(proof); assert.deepEqual(observed, legacyObserved);
  assert.equal(observed.databaseWrites, 0); assert.equal(observed.backupIntegrity, 'ok');
  assert.throws(() => probeFromStdin({ ...proof, databaseIdentity: ['0', '0'] }));
  const changedOriginal = structuredClone(proof); changedOriginal.fullSchemaBefore.Original[2] += ' -- changed original SQL';
  assert.throws(() => probeFromStdin(changedOriginal));
  execFileSync('python3', ['-I', '-c', "import sqlite3,sys\nwith sqlite3.connect(sys.argv[1]) as c:c.execute('CREATE TABLE Unexpected(id TEXT)')", proof.database]);
  assert.throws(() => probeFromStdin(legacyProof));
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(directory, 'switch.mjs'), 'utf8');
  assert.ok(source.includes('applyCanvasBatchMigration(m, allGone, check)'));
  assert.ok(source.includes('applyCanvasBatchMigration(m, () => { assertOriginalStopped(m, before); assertUsageRoleStopped(m); })'));
  assert.ok(source.includes('readCanvasBatchMigration(m, { required: true })'));
  if (process.argv[2]) {
    // The shared-reuse path reads the actual pinned migration and backup only.
    // All producer/adoption writes below remain in the isolated sandbox.
    const real = JSON.parse(fs.readFileSync(process.argv[2]));
    assert.ok(real.canvasVideoBatchSchema);
    if (isSharedEngine(real) && real.reuseBuilds) {
      const actual = readOriginalCanvasBatchMigration(real);
      const usage = verifyDeployedUsageSchema(real);
      assert.equal(actual.receipt.completed, true);
      assert.equal(actual.observed.databaseWrites, 0);
      assert.equal(actual.receipt.runId, real.deployedCanvasBatchSchema.migrationRun);
      assert.equal(actual.receipt.backupSha256, real.deployedCanvasBatchSchema.backupSha256);
      assert.deepEqual(usage.observed.databaseIdentity, actual.observed.databaseIdentity);
      assert.equal(usage.observed.databaseWrites, 0); assert.equal(usage.observed.ddlExecuted, false);
      const invalidReuse = change => {
        const invalid = structuredClone(real); change(invalid);
        assert.throws(() => readOriginalCanvasBatchMigration(invalid));
      };
      invalidReuse(value => { value.reuseBuilds.sourceRun = value.runId; });
      invalidReuse(value => { value.reuseBuilds.main.sha256 = '0'.repeat(64); });
      invalidReuse(value => { value.deployedCanvasBatchSchema.backupSha256 = '0'.repeat(64); });
      invalidReuse(value => { value.operation.taskRoot += '-other-task'; });
      assert.throws(() => readOriginalCanvasBatchMigration({ ...real, normalContinuation: {} }),
        /Shared attempts do not impersonate legacy normal continuations/);
      assert.throws(() => readOriginalCanvasBatchMigration({ ...real, engine: undefined, operation: undefined }),
        /Deployed schema reuse requires exact normal continuation v2/);
      console.log(JSON.stringify({ sharedBuildReuseOriginalCanvasMigration: true,
        actualPinnedReaderAndUsageConsumerExecuted: true, invalidOriginSealSchemaTaskAndPrivateReuseRejected: true,
        originalReceiptAndBackupPreserved: true, productionWrites: 0 }));
    }
    const sandbox = path.join(root, 'producer-consumer');
    fs.mkdirSync(sandbox);
    const put = (file, bytes) => { assert.ok(file.startsWith(sandbox + '/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
    const fixture = { runId: 'canvas-isolated-engineering', mainSource: real.mainSource, guardSource: real.guardSource,
      stage: path.join(sandbox, 'stage'), database: path.join(sandbox, 'database.sqlite'),
      main: { root: path.join(sandbox, 'main') }, guard: { root: path.join(sandbox, 'guard') },
      live: { web: { root: path.join(sandbox, 'old') } }, canvasVideoBatchSchema: real.canvasVideoBatchSchema };
    const files = ['prisma/schema.prisma', contract.CANVAS_BATCH_SQL, contract.CANVAS_BATCH_MIGRATOR,
      contract.CANVAS_BATCH_MODE, 'ops/canvas-video-batch-schema-extension.mjs'];
    for (const kind of ['main', 'guard']) {
      const manifest = JSON.parse(fs.readFileSync(real[kind].sourceManifest));
      assert.equal(manifest.source, real[kind].source);
      assert.equal(hash(fs.readFileSync(real[kind].archive)), manifest.archiveSha256);
      for (const file of files) {
        const bytes = execFileSync('tar', ['-xOzf', real[kind].archive, file]);
        assert.equal(hash(bytes), manifest.files[file]);
        put(fixture[kind].root + '/' + file, bytes);
      }
    }
    const archiveRead = file => {
      const candidate = ['main', 'guard'].find(kind => file.startsWith(real[kind].root + '/'));
      if (candidate) return execFileSync('tar', ['-xOzf', real[candidate].archive, file.slice(real[candidate].root.length + 1)]);
      if (file.startsWith(real.live.web.root + '/')) return fs.readFileSync(file);
      throw new Error('Actual protected source is outside the reviewed release roots: ' + file);
    };
    for (const kind of ['main', 'guard'])
      assert.equal(assertProtectedIncrementCandidate(real, kind, archiveRead), Boolean(real.protectedIncrement));
    // This producer/consumer case models the original normal first migration.
    // Only its sandbox mode sources are normalized; actual protected archives above stay untouched and are checked by the real helper.
    put(fixture.main.root + '/' + contract.CANVAS_BATCH_MODE,
      Buffer.from('export const CANVAS_VIDEO_BATCH_WRITES_ENABLED: boolean = true;\n'));
    put(fixture.guard.root + '/' + contract.CANVAS_BATCH_MODE,
      Buffer.from('export const CANVAS_VIDEO_BATCH_WRITES_ENABLED: boolean = false;\n'));
    let oldRoot = real.live.web.root;
    if (real.deployedCanvasBatchSchema) {
      const file = '/data/video-api-debugger/release-staging/' + real.deployedCanvasBatchSchema.migrationRun + '/manifest.json';
      assert.equal(hash(fs.readFileSync(file)), real.deployedCanvasBatchSchema.migrationManifestSha256);
      oldRoot = JSON.parse(fs.readFileSync(file)).live.web.root;
    }
    const oldSchema = fs.readFileSync(oldRoot + '/prisma/schema.prisma');
    assert.equal(hash(oldSchema), real.canvasVideoBatchSchema.previousPrismaSha256);
    if (real.fullRelease) {
      const originalFile = '/data/video-api-debugger/release-staging/' + real.deployedCanvasBatchSchema.migrationRun + '/manifest.json';
      const originalBytes = fs.readFileSync(originalFile); assert.equal(hash(originalBytes), real.deployedCanvasBatchSchema.migrationManifestSha256);
      const original = JSON.parse(originalBytes), oldAddedSchema = execFileSync('tar', ['-xOzf', original.main.archive, 'prisma/schema.prisma']);
      assert.equal(hash(oldAddedSchema), real.canvasVideoBatchSchema.newPrismaSha256);
      // This sandbox still exercises the original v1 additive producer. The
      // later widening/data-preservation contract has its own full fixture.
      for (const kind of ['main', 'guard']) put(fixture[kind].root + '/prisma/schema.prisma', oldAddedSchema);
    }
    put(fixture.live.web.root + '/prisma/schema.prisma', oldSchema);
    put(fixture.stage + '/manifest.json', JSON.stringify(fixture));
    put(fixture.stage + '/fix01-release/canvas-batch-schema-contract.mjs', fs.readFileSync(new URL('./canvas-batch-schema-contract.mjs', import.meta.url)));
    execFileSync('python3', ['-I', '-c', "import sqlite3,sys\nwith sqlite3.connect(sys.argv[1]) as c:\n c.execute('CREATE TABLE Original(id TEXT PRIMARY KEY)')\n c.execute(\"INSERT INTO Original VALUES ('preserve')\")", fixture.database]);
    let writersStopped = false, migrationCalls = 0, windowChecks = 0;
    const immutable = new Set();
    const checked = file => { assert.ok(file.startsWith(sandbox + '/')); assert.equal(fs.realpathSync(file), file); return fs.readFileSync(file); };
    const call = (name, args, options = {}) => {
      if (name === 'chattr') {
        assert.equal(args[0], '+i'); checked(args[1]); immutable.add(args[1]); return '';
      }
      assert.equal(name, 'python3'); assert.equal(args[0], '-I');
      if (args[1] === '-c') {
        assert.equal(args[2], CANVAS_BATCH_PROBE);
        assert.equal(args.length, 3); assert.equal(options.timeout, 120000); assert.equal(typeof options.input, 'string');
        const values = JSON.parse(options.input); assert.equal(values.database, fixture.database);
        assert.ok(values.backup.startsWith(fixture.stage + '/'));
        return execFileSync('python3', args, { encoding: 'utf8', input: options.input, timeout: options.timeout });
      }
      assert.equal(writersStopped, true); migrationCalls++;
      assert.equal(args[1], fixture.main.root + '/' + contract.CANVAS_BATCH_MIGRATOR);
      assert.deepEqual(JSON.parse(JSON.stringify(args.slice(2))), ['--manifest', fixture.stage + '/manifest.json', '--manifest-sha256',
        hash(checked(fixture.stage + '/manifest.json')), '--sql-sha256', fixture.canvasVideoBatchSchema.sqlSha256, '--apply']);
      // Execute the actual migration producer against a private SQLite database.
      const code = String.raw`import importlib.util,json,pathlib,sys
p=pathlib.Path(sys.argv[1]);s=importlib.util.spec_from_file_location('migration',p);mod=importlib.util.module_from_spec(s);s.loader.exec_module(mod)
mf=pathlib.Path(sys.argv[2]);m=json.loads(mf.read_text());sql=pathlib.Path(m['main']['root'])/mod.SQL_PATH
identity={'schema':'sd2-canvas-video-batches-migration.v1','runId':m['runId'],'source':m['mainSource'],'guardSource':m['guardSource'],'manifestSha256':mod.digest(mf),'sqlSha256':mod.digest(sql)}
print(json.dumps(mod.apply_schema(m['database'],pathlib.Path(m['stage'])/'canvas-video-batches-migration',sql.read_text(),identity,True)))`;
      return execFileSync('python3', ['-I', '-c', code, args[1], fixture.stage + '/manifest.json'], { encoding: 'utf8' });
    };
    const normalizedAssert = { ...assert, deepEqual: (a, b, message) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), message) };
    const context = vm.createContext({ assert: normalizedAssert, fs, ...contract, assertProtectedIncrementCandidate, engineDirectory, isSharedEngine,
      verifyDeployedContinuationProvenance, verifySharedBuildProvenance, fullSchemaBefore, verifyFullCandidateSources,
      rootFile: checked, sha: hash, call,
      writeJsonExclusive: () => { throw new Error('First migration must not create deployed adoption evidence'); },
      assertReleaseWindow: value => { assert.equal(value, fixture); windowChecks++; } });
    const moduleText = fs.readFileSync(new URL('./canvas-batch-schema.mjs', import.meta.url), 'utf8');
    assert.ok(moduleText.includes("import { assertProtectedIncrementCandidate } from './release-contract.mjs';"));
    assert.equal(context.assertProtectedIncrementCandidate, assertProtectedIncrementCandidate);
    const ts = createRequire(releaseDependencyRoot(real) + '/package.json')('typescript');
    const parsed = ts.createSourceFile('canvas-batch-schema.mjs', moduleText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.equal(parsed.parseDiagnostics.length, 0);
    const edits = [];
    for (const statement of parsed.statements) {
      if (ts.isImportDeclaration(statement)) edits.push([statement.getStart(parsed), statement.end]);
      else for (const modifier of statement.modifiers || [])
        if (modifier.kind === ts.SyntaxKind.ExportKeyword) edits.push([modifier.getStart(parsed), modifier.end]);
    }
    let body = moduleText;
    for (const [start, end] of edits.sort((a, b) => b[0] - a[0])) body = body.slice(0, start) + body.slice(end);
    vm.runInContext(body
      + '\nglobalThis.api={applyCanvasBatchMigration,readCanvasBatchMigration};', context);
    const { applyCanvasBatchMigration: apply, readCanvasBatchMigration: read } = context.api;
    const stopped = () => assert.equal(writersStopped, true, 'Old writer still running');
    assert.throws(() => apply(fixture, stopped), /Old writer/);
    assert.equal(migrationCalls, 0);
    assert.throws(() => read(fixture, { required: true }), /no completed original/);
    writersStopped = true;
    const result = apply(fixture, stopped);
    assert.equal(migrationCalls, 1); assert.equal(immutable.size, 3);
    assert.equal(result.receipt.newObjects.length, 11);
    assert.equal(result.observed.databaseWrites, 0);
    const receiptFile = fixture.stage + '/canvas-video-batches-migration/receipt.json';
    const receiptBytes = checked(receiptFile);
    const originalTime = result.receipt.at;
    assert.equal(apply(fixture, stopped).receipt.at, originalTime);
    assert.equal(migrationCalls, 1); assert.ok(windowChecks >= 3);
    assert.equal(hash(checked(receiptFile)), hash(receiptBytes));
    assert.equal(read(fixture, { required: true }).receipt.completed, true);
    const tampered = JSON.parse(receiptBytes); tampered.source = '0'.repeat(40); put(receiptFile, JSON.stringify(tampered));
    assert.throws(() => read(fixture, { required: true })); put(receiptFile, receiptBytes);
    const backupFile = fixture.stage + '/canvas-video-batches-migration/consistent-backup.sqlite';
    const backupBytes = checked(backupFile); put(backupFile, Buffer.concat([backupBytes, Buffer.from('changed')]));
    assert.throws(() => read(fixture, { required: true })); put(backupFile, backupBytes);
    assert.equal(read(fixture, { required: true }).receipt.at, originalTime);
    const retained = execFileSync('python3', ['-I', '-c', "import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);assert c.execute('SELECT id FROM Original').fetchall()==[('preserve',)];assert c.execute('SELECT COUNT(*) FROM CanvasVideoBatch').fetchone()[0]==0;print('preserved')", fixture.database], { encoding: 'utf8' });
    assert.equal(retained.trim(), 'preserved');
    // Feed an actual isolated first-migration output into the actual next-run
    // reader/adopter. Only filesystem/native observations are adapted.
    const adoptionSandbox = path.join(sandbox, 'adoption'); fs.mkdirSync(adoptionSandbox);
    const project = '/data/video-api-debugger';
    const physical = file => {
      assert.ok(file.startsWith(project + '/'), 'No native path outside the isolated project');
      return adoptionSandbox + file.slice(project.length);
    };
    const virtualPut = (file, bytes, mode = 0o644) => {
      const target = physical(file); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, bytes, { mode });
    };
    const originRun = '20000000-0000-4000-8000-000000000001', nextRun = '20000000-0000-4000-8000-000000000002';
    const originStage = project + '/release-staging/' + originRun;
    const original = { schema: 'rate-impl2-release.v1', project: 'video-api-debugger', runId: originRun, stage: originStage,
      mainSource: real.mainSource, guardSource: real.guardSource, database: project + '/var-lib/dev.db',
      canvasVideoBatchSchema: real.canvasVideoBatchSchema, deployedCanvasBatchSchema: null,
      live: { web: { root: project + '/managed-releases/' + '3'.repeat(40) } },
      main: { source: real.mainSource, root: project + '/managed-releases/' + real.mainSource },
      guard: { source: real.guardSource, root: project + '/managed-releases/' + real.guardSource } };
    virtualPut(original.live.web.root + '/prisma/schema.prisma', oldSchema);
    for (const kind of ['main', 'guard']) for (const file of files)
      virtualPut(original[kind].root + '/' + file, checked(fixture[kind].root + '/' + file));
    virtualPut(originStage + '/manifest.json', JSON.stringify(original), 0o600);
    const usageSql = fs.readFileSync(real.live.web.root + '/prisma/migrations/20261021073000_usage_attribution/migration.sql', 'utf8');
    const makeOriginal = String.raw`import sqlite3,sys,json,importlib.util,pathlib,hashlib
d=json.loads(sys.argv[1]);db=pathlib.Path(d['db']);db.parent.mkdir(parents=True,exist_ok=True)
with sqlite3.connect(db) as c:
 c.execute('CREATE TABLE Original(id TEXT PRIMARY KEY)');c.execute("INSERT INTO Original VALUES ('preserve')")
 c.executescript(d['usageSql']);c.execute("INSERT INTO UsageAttribution(source_kind,source_id,owner_user_id,context_origin,occurred_at) VALUES ('image','kept','owner','explicit','2026-10-21T00:00:00Z')");c.commit()
s=importlib.util.spec_from_file_location('actual_migration',d['module']);mod=importlib.util.module_from_spec(s);s.loader.exec_module(mod)
mf=pathlib.Path(d['manifest']);m=json.loads(mf.read_text());sql=pathlib.Path(d['sql'])
identity={'schema':'sd2-canvas-video-batches-migration.v1','runId':m['runId'],'source':m['mainSource'],'guardSource':m['guardSource'],'manifestSha256':mod.digest(mf),'sqlSha256':mod.digest(sql)}
mod.apply_schema(str(db),pathlib.Path(d['stage']),sql.read_text(),identity,True)
with sqlite3.connect(db) as c:
 c.execute("INSERT INTO CanvasVideoBatch(id,owner_user_id,document_id,node_id,project_id,client_request_id,request_hash,count,frozen_input_json,authorized_total,updated_at) VALUES ('batch','owner','doc','node','project','request','hash',2,'{}',200,'2026-10-21')")
 c.execute("INSERT INTO CanvasVideoBatchChild(id,batch_id,ordinal,request_id,idempotency_key,business_fingerprint,route_fingerprint,frozen_input_json,authorized_maximum,quote_expires_at,updated_at) VALUES ('child','batch',1,'child-request','key','business','route','{}',100,'2026-10-22','2026-10-21')");c.commit()
print('actual-first-migration-produced')`;
    assert.equal(execFileSync('python3', ['-I', '-c', makeOriginal, JSON.stringify({ db: physical(original.database), usageSql,
      module: physical(original.main.root + '/' + contract.CANVAS_BATCH_MIGRATOR),
      sql: physical(original.main.root + '/' + contract.CANVAS_BATCH_SQL), manifest: physical(originStage + '/manifest.json'),
      stage: physical(originStage + '/canvas-video-batches-migration') })], { encoding: 'utf8' }).trim(), 'actual-first-migration-produced');
    const vbytes = file => fs.readFileSync(physical(file));
    const vjson = file => JSON.parse(vbytes(file));
    const actualReceipt = vjson(originStage + '/canvas-video-batches-migration/receipt.json');
    const next = { ...original, runId: nextRun, stage: project + '/release-staging/' + nextRun,
      mainSource: '4'.repeat(40), guardSource: '5'.repeat(40),
      main: { root: project + '/managed-releases/' + '4'.repeat(40) },
      guard: { root: project + '/managed-releases/' + '5'.repeat(40) }, live: { web: { root: original.main.root } },
      normalContinuation: null, reuseBuilds: null,
      deployedUsageSchema: { ...real.deployedUsageSchema, publicationRun: originRun, publicationManifestSha256: hash(vbytes(originStage + '/manifest.json')) },
      deployedCanvasBatchSchema: { schema: 'sd2-deployed-canvas-video-batch-schema-input.v1', migrationRun: originRun,
        migrationManifestSha256: hash(vbytes(originStage + '/manifest.json')),
        migrationReceiptSha256: hash(vbytes(originStage + '/canvas-video-batches-migration/receipt.json')),
        backupProofSha256: hash(vbytes(originStage + '/canvas-video-batches-migration/backup-proof.json')),
        backupSha256: actualReceipt.backupSha256 } };
    for (const kind of ['main', 'guard']) for (const file of files)
      virtualPut(next[kind].root + '/' + file, checked(fixture[kind].root + '/' + file));
    virtualPut(next.stage + '/manifest.json', JSON.stringify(next), 0o600);
    virtualPut(next.stage + '/fix01-release/canvas-batch-schema-contract.mjs', fs.readFileSync(new URL('./canvas-batch-schema-contract.mjs', import.meta.url)), 0o600);
    const vimmutable = new Set(); let adoptionStopped = false, adoptionWrites = 0, forbiddenMigrationCalls = 0;
    const io = { ...fs, realpathSync: file => { assert.equal(fs.realpathSync(physical(file)), physical(file)); return file; },
      readFileSync: (file, ...args) => fs.readFileSync(physical(file), ...args),
      lstatSync: file => fs.lstatSync(physical(file)), existsSync: file => fs.existsSync(physical(file)) };
    const vcall = (name, args, options = {}) => {
      if (name === 'findmnt') { physical(args.at(-1)); return '/data'; }
      if (name === 'chattr') { assert.equal(args[0], '+i'); vbytes(args[1]); vimmutable.add(args[1]); return ''; }
      if (name === 'lsattr') return (vimmutable.has(args[1]) ? '----i---' : '--------') + ' ' + args[1];
      assert.equal(name, 'python3'); assert.equal(args[0], '-I');
      if (args[1] !== '-c') { forbiddenMigrationCalls++; throw new Error('Deployed adoption invoked a migration'); }
      assert.equal(args[2], CANVAS_BATCH_PROBE);
      assert.equal(args.length, 3); assert.equal(options.timeout, 120000); assert.equal(typeof options.input, 'string');
      const values = JSON.parse(options.input); values.database = physical(values.database); values.backup = physical(values.backup);
      return execFileSync('python3', ['-I', '-c', CANVAS_BATCH_PROBE], { encoding: 'utf8', input: JSON.stringify(values), timeout: options.timeout });
    };
    const adoptionContext = vm.createContext({ assert: normalizedAssert, fs: io, ...contract, assertProtectedIncrementCandidate, engineDirectory, isSharedEngine,
      verifyDeployedContinuationProvenance, verifySharedBuildProvenance, fullSchemaBefore, verifyFullCandidateSources,
      rootFile: vbytes, sha: hash, call: vcall,
      writeJsonExclusive: (file, value) => { adoptionWrites++; fs.writeFileSync(physical(file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); },
      assertReleaseWindow: value => assert.equal(value, next) });
    assert.equal(adoptionContext.assertProtectedIncrementCandidate, assertProtectedIncrementCandidate);
    vm.runInContext(body + '\nglobalThis.api={applyCanvasBatchMigration,readCanvasBatchMigration,assertDeployedCanvasInput};', adoptionContext);
    const adopted = adoptionContext.api, oldReceipt = vbytes(originStage + '/canvas-video-batches-migration/receipt.json');
    const oldBackup = vbytes(originStage + '/canvas-video-batches-migration/consistent-backup.sqlite');
    const dbBefore = hash(vbytes(next.database));
    assert.equal(adopted.readCanvasBatchMigration(next, { candidates: false }).receipt.at, actualReceipt.at);
    assert.throws(() => adopted.readCanvasBatchMigration(next, { required: true }), /no completed deployed adoption/);
    const assertStopped = () => assert.equal(adoptionStopped, true, 'Old writer still running');
    assert.throws(() => adopted.applyCanvasBatchMigration(next, assertStopped), /Old writer/);
    assert.equal(adoptionWrites, 0); adoptionStopped = true;
    const applied = adopted.applyCanvasBatchMigration(next, assertStopped);
    assert.equal(applied.adoption.ddlExecuted, false); assert.equal(applied.adoption.databaseWrites, 0);
    assert.equal(applied.adoption.runId, nextRun); assert.equal(applied.receipt.at, actualReceipt.at);
    const adoptedAt = applied.adoption.verifiedAt;
    assert.equal(adopted.applyCanvasBatchMigration(next, assertStopped).adoption.verifiedAt, adoptedAt);
    assert.equal(adoptionWrites, 1); assert.equal(forbiddenMigrationCalls, 0);
    assert.equal(hash(vbytes(next.database)), dbBefore);
    assert.equal(hash(vbytes(originStage + '/canvas-video-batches-migration/receipt.json')), hash(oldReceipt));
    assert.equal(hash(vbytes(originStage + '/canvas-video-batches-migration/consistent-backup.sqlite')), hash(oldBackup));
    for (const key of ['migrationManifestSha256', 'migrationReceiptSha256', 'backupProofSha256', 'backupSha256']) {
      const invalid = structuredClone(next); invalid.deployedCanvasBatchSchema[key] = '0'.repeat(64);
      assert.throws(() => adopted.readCanvasBatchMigration(invalid, { required: true }));
    }
    for (const key of Object.keys(next.deployedCanvasBatchSchema)) {
      const invalid = { ...next.deployedCanvasBatchSchema }; delete invalid[key];
      assert.throws(() => adopted.assertDeployedCanvasInput(invalid));
    }
    assert.throws(() => adopted.assertDeployedCanvasInput({ ...next.deployedCanvasBatchSchema, allowDDL: true }));
    const originalBackupFile = originStage + '/canvas-video-batches-migration/consistent-backup.sqlite';
    virtualPut(originalBackupFile, Buffer.concat([oldBackup, Buffer.from('tampered')]), 0o600);
    assert.throws(() => adopted.readCanvasBatchMigration(next, { required: true })); virtualPut(originalBackupFile, oldBackup, 0o600);
    const adoptionFile = next.stage + '/canvas-video-batches-deployed-schema-adopt.json', adoptionBytes = vbytes(adoptionFile);
    const badAdoption = vjson(adoptionFile); badAdoption.runId = originRun;
    virtualPut(adoptionFile, JSON.stringify(badAdoption), 0o600);
    assert.throws(() => adopted.readCanvasBatchMigration(next, { required: true })); virtualPut(adoptionFile, adoptionBytes, 0o600);
    vimmutable.delete(adoptionFile); assert.throws(() => adopted.readCanvasBatchMigration(next, { required: true })); vimmutable.add(adoptionFile);
    const privateDb = physical(next.database);
    execFileSync('python3', ['-I', '-c', "import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);assert c.execute('SELECT COUNT(*) FROM CanvasVideoBatch').fetchone()[0]==1;assert c.execute('SELECT COUNT(*) FROM CanvasVideoBatchChild').fetchone()[0]==1;assert c.execute('SELECT COUNT(*) FROM UsageAttribution').fetchone()[0]==1;c.execute('DROP INDEX CanvasVideoBatch_document_id_idx');c.commit()", privateDb]);
    assert.throws(() => adopted.readCanvasBatchMigration(next, { required: true }));
    console.log(JSON.stringify({ deployedCanvasAdoption: true, originalProducerActuallyExecuted: true,
      nonemptyRowsPreserved: true, adoptionWrites, forbiddenMigrationCalls, originalBytesAndTimesUnchanged: true,
      startupRequiresNewReceipt: true, malformedOrTamperedEvidenceRejected: true, productionWrites: 0 }));
    console.log(JSON.stringify({ producerConsumer: true, actualReviewedMigration: true, migrationCalls,
      stoppedWriterRequired: true, startupRequiresOriginalReceipt: true, sameRunTimePreserved: true,
      tamperedReceiptAndBackupRejected: true, originalRowsPreserved: true, productionWrites: 0 }));
  }
  console.log(JSON.stringify({ checks: ['exact old Prisma declarations preserved', 'unbound input rejected',
    'real SQLite read-only schema and backup proof', 'actual original-schema SQL over 133499 bytes preserved through stdin with legacy argv compatibility',
    'stdin rejects changed original schema and wrong database identity', 'unexpected object rejected', 'normal and recovery stopped-writer/start gates wired'],
    schemaInputBytes,
    productionWrites: 0, servicesChanged: false }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
