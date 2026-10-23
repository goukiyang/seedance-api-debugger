import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertHdMaintenanceApproval, HD_MAINTENANCE_APPROVAL_SCHEMA, privateFreezeSha256 } from './cutover-driver.mjs';

// Pure checks of the actual approval predicate. No FS, SSH, DB, service or
// supplier operation is selected by this fixture; the runtime loader supplies
// the rootFile-validated byte hashes at this exact boundary.
export function runHdMaintenanceApprovalEngineering() {
  const now = Date.parse('2026-10-19T20:00:00.000Z');
  const m = { runId: '11111111-1111-4111-8111-111111111111', mainSource: 'a'.repeat(40), guardSource: 'b'.repeat(40),
    privateSha256: { 'writer-network-fence.mjs': 'c'.repeat(64), 'cutover-driver.mjs': 'd'.repeat(64) } };
  const binding = { now, manifestSha256: '1'.repeat(64), windowSha256: '2'.repeat(64),
    mainBuildReceiptSha256: '3'.repeat(64), guardBuildReceiptSha256: '4'.repeat(64) };
  const approval = { schema: HD_MAINTENANCE_APPROVAL_SCHEMA, runId: m.runId, mainSource: m.mainSource,
    guardSource: m.guardSource, manifestSha256: binding.manifestSha256, privateFreezeSha256: privateFreezeSha256(m),
    windowSha256: binding.windowSha256, mainBuildReceiptSha256: binding.mainBuildReceiptSha256,
    guardBuildReceiptSha256: binding.guardBuildReceiptSha256, issuedAt: '2026-10-19T19:59:30.000Z',
    expiresAt: '2026-10-19T20:04:30.000Z', manualMaintenanceConfirmed: true, allowCompatibleRollback: true,
    operations: ['switch', 'rollback-to-compatible-guard'], writerFence: { install: true,
      helperSha256: m.privateSha256['writer-network-fence.mjs'],
      restorePhases: ['pre-stop-installation-abort', 'before-new-writer-after-proven-old-stop'] } };
  const cases = [];
  const check = (name, change = () => {}, accepted = false, bindingChange = () => {}) => {
    const value = structuredClone(approval), inputs = structuredClone(binding); change(value); bindingChange(inputs);
    if (accepted) assert.equal(assertHdMaintenanceApproval(m, value, inputs), value, name);
    else assert.throws(() => assertHdMaintenanceApproval(m, value, inputs), undefined, name);
    cases.push({ name, accepted, passed: true });
  };
  check('exact ISO approval accepted', () => {}, true);
  check('numeric milliseconds accepted', value => { value.issuedAt = now - 1000; value.expiresAt = now + 299000; }, true);
  for (const key of ['schema', 'runId', 'mainSource', 'guardSource', 'manifestSha256', 'privateFreezeSha256',
    'windowSha256', 'mainBuildReceiptSha256', 'guardBuildReceiptSha256'])
    check(key + ' mismatch rejected', value => { value[key] = 'wrong'; });
  check('expired rejected', value => { value.expiresAt = now; });
  check('future issue rejected', value => { value.issuedAt = now + 1; });
  check('more than five minutes rejected', value => { value.expiresAt = now + 300000; });
  check('locale date rejected', value => { value.issuedAt = '10/19/2026 19:59:30'; });
  check('numeric string rejected', value => { value.issuedAt = String(now - 1000); });
  check('invalid calendar ISO rejected without relying on TTL', value => {
    value.issuedAt = '2026-02-30T19:59:30.000Z'; value.expiresAt = '2026-03-02T20:04:30.000Z';
  }, false, value => { value.now = Date.parse('2026-03-02T20:00:00.000Z'); });
  check('missing manual maintenance confirmation rejected', value => { delete value.manualMaintenanceConfirmed; });
  check('missing compatible rollback confirmation rejected', value => { delete value.allowCompatibleRollback; });
  check('extra operation rejected', value => { value.operations.push('restore-old-writer'); });
  check('wrong operation order rejected', value => { value.operations.reverse(); });
  check('missing fence authority rejected', value => { value.writerFence.install = false; });
  check('wrong fence helper rejected', value => { value.writerFence.helperSha256 = 'f'.repeat(64); });
  check('missing restore phase rejected', value => { value.writerFence.restorePhases.pop(); });
  check('extra restore phase rejected', value => { value.writerFence.restorePhases.push('unconditional'); });
  for (const key of ['manifestSha256', 'windowSha256', 'mainBuildReceiptSha256', 'guardBuildReceiptSha256'])
    check('unvalidated ' + key + ' rejected', () => {}, false, value => { delete value[key]; });
  return { schema: 'hd-maintenance-approval-engineering.v1', completed: true, nativeExecuted: false,
    ioKind: 'pure-predicate', cases, forbiddenCalls: { production: 0, ssh: 0, service: 0, database: 0, supplier: 0 } };
}

export async function runCompatibleSafetyReaderEngineering() {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex'), cases = [];
  const originalDirectory = '/fixture/original-engine', readerDirectory = '/fixture/compatible-reader';
  const files = new Map([['cutover-driver.mjs', Buffer.from('frozen original driver')],
    ['cutover-safety.mjs', Buffer.from('frozen original safety adapter')],
    ['writer-network-fence.mjs', Buffer.from('frozen original native fence')]]);
  const now = Date.now(), m = { runId: '11111111-1111-4111-8111-111111111111', mainSource: 'a'.repeat(40), guardSource: 'b'.repeat(40),
    stage: '/data/video-api-debugger/release-staging/11111111-1111-4111-8111-111111111111',
    privateSha256: Object.fromEntries([...files].map(([name, bytes]) => [name, hash(bytes)])) };
  const manifest = Buffer.from(JSON.stringify(m)), window = Buffer.from('real-bound-window-fixture');
  const builds = { main: Buffer.from('real-bound-main-fixture'), guard: Buffer.from('real-bound-guard-fixture') };
  const approval = { schema: HD_MAINTENANCE_APPROVAL_SCHEMA, runId: m.runId, mainSource: m.mainSource, guardSource: m.guardSource,
    manifestSha256: hash(manifest), privateFreezeSha256: privateFreezeSha256(m), windowSha256: hash(window),
    mainBuildReceiptSha256: hash(builds.main), guardBuildReceiptSha256: hash(builds.guard), issuedAt: now - 1000, expiresAt: now + 240000,
    manualMaintenanceConfirmed: true, allowCompatibleRollback: true, operations: ['switch', 'rollback-to-compatible-guard'],
    writerFence: { install: true, helperSha256: m.privateSha256['writer-network-fence.mjs'],
      restorePhases: ['pre-stop-installation-abort', 'before-new-writer-after-proven-old-stop'] } };
  m.windowFile = m.stage + '/window.json';
  let bound = true, prepared = 0, constructed = 0, approvalFile = m.stage + '/hd-release-safety-approval.json'; const reads = [];
  const rootFile = file => {
    reads.push(file);
    if (file.startsWith(originalDirectory + '/')) { const bytes = files.get(path.basename(file)); assert.ok(bytes); return bytes; }
    if (file === m.stage + '/manifest.json') return manifest;
    if (file === m.windowFile) return window;
    if (file === approvalFile) return Buffer.from(JSON.stringify(approval));
    for (const kind of ['main', 'guard']) if (file === m.stage + '/' + kind + '-build.json') return builds[kind];
    throw Error('Unexpected isolated reader input: ' + file);
  };
  const namespace = { assert, path, process, Date, Buffer, JSON, Object, sourceFilename: readerDirectory + '/cutover-driver.mjs', rootFile, sha: hash,
    engineDirectory: () => originalDirectory, candidateCompatibilityDirectory: () => bound ? readerDirectory : originalDirectory,
    validateManifest: value => value, assertReleaseWindow: () => {}, assertHdMaintenanceApproval,
    candidateEvidenceFile: (value, kind) => value.stage + '/' + kind + '-build.json',
    hdMaintenanceApprovalFile: value => { assert.equal(value, m); return approvalFile; },
    fs: { readdirSync: file => { assert.equal(file, originalDirectory); return [...files.keys()]; }, existsSync: () => true,
      lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o40700 }), realpathSync: value => value },
    prepareOperationFenceModule: async value => { assert.equal(value, m); prepared++; return { originalFence: true }; },
    createHdReleaseSafety: value => { constructed++; assert.deepEqual(value.nativeFenceModule, { originalFence: true }); return { isolated: true }; } };
  const driver = fs.readFileSync(new URL('./cutover-driver.mjs', import.meta.url), 'utf8');
  const offset = driver.indexOf('export async function loadHdReleaseSafety('); assert.ok(offset > 0);
  const driverBody = driver.slice(offset); assert.equal(driverBody.split('fileURLToPath(import.meta.url)').length, 2);
  vm.runInNewContext(driverBody.replace('export async function', 'async function')
    .replace('fileURLToPath(import.meta.url)', 'sourceFilename') + '\nglobalThis.load=loadHdReleaseSafety;', namespace);
  assert.equal((await namespace.load(m, 'switch')).isolated, true); assert.equal(prepared, 1); assert.equal(constructed, 1);
  for (const name of files.keys()) assert.ok(reads.includes(originalDirectory + '/' + name));
  assert.equal(reads.some(file => file.startsWith(readerDirectory + '/')), false);
  cases.push('bound_reader_keeps_full_original_private_hashes_before_constructing_safety');
  bound = false; await assert.rejects(() => namespace.load(m, 'switch')); bound = true;
  cases.push('unbound_reader_directory_is_refused_before_safety_construction');
  const original = files.get('cutover-driver.mjs'); files.set('cutover-driver.mjs', Buffer.from('drift'));
  await assert.rejects(() => namespace.load(m, 'switch')); files.set('cutover-driver.mjs', original);
  assert.equal(constructed, 1); cases.push('original_engine_source_drift_is_refused_even_with_bound_reader');

  const safety = fs.readFileSync(new URL('./cutover-safety.mjs', import.meta.url), 'utf8');
  const start = safety.indexOf('export async function prepareOperationFenceModule(');
  const end = safety.indexOf('\n  assert.equal(sourceDirectory, engineDirectory(m));', start); assert.ok(start > 0 && end > start);
  let body = safety.slice(start, end) + '\n}';
  const importExpression = "await import(pathToFileURL(path.join(originalDirectory, 'cutover-safety.mjs')).href)";
  assert.equal(body.split(importExpression).length, 2);
  body = body.replace('export async function', 'async function').replace('fileURLToPath(import.meta.url)', 'sourceFilename')
    .replace(importExpression, "await importOriginal(pathToFileURL(path.join(originalDirectory, 'cutover-safety.mjs')).href)");
  const marker = Object.freeze({ originalSource: true, target: 'unchanged-operation-helper', self: 'unchanged' });
  let imports = 0;
  const delegate = { assert, process, path, sourceFilename: readerDirectory + '/cutover-safety.mjs', pathToFileURL,
    HASH: /^[a-f0-9]{64}$/, sha: hash, rootFile, engineDirectory: () => originalDirectory,
    candidateCompatibilityDirectory: () => bound ? readerDirectory : originalDirectory,
    importOriginal: async url => { assert.equal(url, pathToFileURL(originalDirectory + '/cutover-safety.mjs').href); imports++;
      return { prepareOperationFenceModule: async value => { assert.equal(value, m); return marker; } }; } };
  vm.runInNewContext(body + '\nglobalThis.prepare=prepareOperationFenceModule;', delegate);
  assert.equal(await delegate.prepare(m), marker); assert.equal(imports, 1);
  cases.push('compatible_reader_delegates_to_exact_original_absolute_fence_preparation');
  bound = false; await assert.rejects(() => delegate.prepare(m)); bound = true;
  files.set('cutover-driver.mjs', Buffer.from('drift')); await assert.rejects(() => delegate.prepare(m)); files.set('cutover-driver.mjs', original);
  assert.equal(imports, 1); cases.push('unbound_reader_and_original_source_drift_cannot_select_fence_import');
  approvalFile = m.stage + '/hd-release-safety-approval-arm-pair-r01.json';
  assert.equal((await namespace.load(m, 'switch')).isolated, true);
  assert.ok(reads.includes(approvalFile)); assert.equal(constructed, 2);
  cases.push('bound_repair_selects_its_distinct_approval_file_without_overwriting_the_original');
  return { schema: 'sd2-compatible-safety-reader-engineering.v1', completed: true, cases,
    nativeFenceExecuted: false, productionWrites: 0, serviceCalls: 0, databaseCalls: 0,
    boundary: 'Actual reader/delegation decision bodies with isolated IO; original native helper source, target and SELF are not edited' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runCompatibleSafetyReaderEngineering().then(reader => process.stdout.write(JSON.stringify({ ...runHdMaintenanceApprovalEngineering(), reader }) + '\n'))
    .catch(error => { console.error(error); process.exitCode = 1; });
