import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import { isSharedEngine, engineDirectory } from './engine-context.mjs';
import { ENGINE_VERSION } from './engine-version.mjs';
import { throwReleaseError, classifyReleaseError } from './release-errors.mjs';
import { execFileSync } from 'node:child_process';
import { rootFile } from './common.mjs';

assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 0);
const source = fs.readFileSync(new URL('./control-preflight.mjs', import.meta.url), 'utf8');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const normalizedAssert = { ...assert, deepEqual: (a, b, message) =>
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), message) };
const checks = [];
assert.match(source, /import \{ inspectInstalledMultiviewRecipeAdoption \} from '\.\/multiview-works-control\.mjs';/);
assert.match(source, /if \(m\.recoveredGuardBaseline\?\.schema === 'sd2-multiview-r17-recovered-guard\.v1'\) inspectInstalledMultiviewRecipeAdoption\(m\);/);
const stage = '/data/video-api-debugger/release-staging/10000000-0000-4000-8000-000000000001';

function harness(options = {}) {
  const files = new Map(), directories = new Set([stage]);
  const m = { runId: '10000000-0000-4000-8000-000000000001', stage, hdRoot: '/data/hd',
    live: { web: { root: '/data/original' } }, privateSha256: { 'writer-network-fence.mjs': sha('original-fence') } };
  if (options.recoveredBaseline) m.recoveredGuardBaseline = options.recoveredBaseline;
  files.set(stage + '/manifest.json', JSON.stringify(m));
  files.set(stage + '/fix01-release/writer-network-fence.mjs', 'original-fence');
  files.set(stage + '/control-module-preflight.json', JSON.stringify({ moduleActuallyLoaded: true, sha256: sha('original-fence') }));
  let spawnCalls = 0, captures = 0, nativeReads = 0, sequence = 0, rejectAdmission = true, adoptedReads = 0;
  const attempts = [], spawned = [];
  const rootFile = file => {
    assert.ok(files.has(file), 'Missing fixture file: ' + file);
    const bytes = Buffer.from(files.get(file)); assert.ok(bytes.length > 0, 'Untrusted root input: ' + file); return bytes;
  };
  const write = (file, value) => { assert.ok(!files.has(file), 'Exclusive fixture write'); files.set(file, JSON.stringify(value)); };
  const fakeFs = {
    existsSync: file => files.has(file) || directories.has(file),
    mkdirSync: file => { assert.ok(!directories.has(file)); directories.add(file); },
    lstatSync: file => ({ isDirectory: () => directories.has(file), isSymbolicLink: () => false, uid: 0, mode: 0o40700 }),
    realpathSync: file => file,
    readdirSync: directory => [...files.keys(), ...directories].filter(file => path.dirname(file) === directory).map(file => path.basename(file)),
    writeFileSync: (file, value, options) => { assert.equal(options.flag, 'wx'); assert.ok(!files.has(file)); files.set(file, value); },
  };
  const context = { assert: normalizedAssert, fs: fakeFs, path, process, Date, JSON, Buffer,
    structuredClone, isSharedEngine, engineDirectory, throwReleaseError,
    randomUUID: () => `20000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    sha, rootFile, writeJsonExclusive: write, validateManifest: value => assert.equal(value, m), assertReleaseWindow: () => {},
    assertCurrentPublishedBaseline: value => assert.equal(value, m),
    inspectInstalledMultiviewRecipeAdoption: value => {
      assert.equal(value, m); assert.equal(spawnCalls, 0); adoptedReads++;
      if (options.refuseInstalled) throw Error('installed-state-drift');
      return { adopted: true, applied: false, businessWrites: 0 };
    },
    inspectRetiredHdCaches: (_m, phase) => { if (phase === 'drained') throw Error('Old writer still active'); return { accepted: false, entries: [{ run: 'retained-original' }] }; },
    MV_DIRECT: { closedCacheReference: 'closed-original' },
    spawnSync: (_bin, args) => {
      spawned.push([...args]);
      spawnCalls++; const selected = options.spawnResult?.({ file: path.basename(args[0]), call: spawnCalls, args });
      return selected || { stdout: 'completed:' + args[0], stderr: '', status: 0, signal: null };
    },
    captureSwitchBefore: (_m, manifestSha256) => ({ manifestSha256, capture: ++captures }),
    inspectRecoveryCertificate: () => ({ unchanged: true }), inspectRetainedUploadProof: () => ({ unchanged: true }),
    inspectNativeBeforeMaintenance: async args => {
      nativeReads++; attempts.push(args); assert.equal(args.before.capture, captures);
      assert.ok(args.beforeFile.startsWith(args.evidenceDirectory + '/'));
      if (rejectAdmission) throw Error('3302 still has established connections');
      return { completed: true, releaseApproved: false, observedAt: new Date().toISOString(), effects: { productionFileWrites: 0 } };
    },
    inspectHdReconciliation: async () => ({ canEnterControlledDrain: true }), call: () => '/data',
    verifyNormalContinuation: () => null,
    recordHdAdmission: (_m, detail) => write(stage + '/hd-admission-proof.json', detail),
  };
  vm.runInNewContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '')
    + '\nglobalThis.api={controlPreflight,controlAdmission,assertNativeBatch,assertControlPreflight,sizeLogOriginalCheckpoint,nativeTasks,outcomeFromAtomicReceipt,SIZE_LOG_SOURCE_DELTAS,sharedNativeTasks,sharedNativeContext,sharedControlReferences,sharedDependencyTree,sharedNativeInput};', context);
  return { m, files, directories, rootFile, api: context.api, attempts, context, spawned,
    adoptionReads: () => adoptedReads,
    counts: () => ({ spawnCalls, captures, nativeReads }), admit: () => { rejectAdmission = false; } };
}

const first = harness();
await assert.rejects(first.api.controlPreflight(first.m), /3302/);
const batchFile = stage + '/native-control-preflight/batch.json';
const originalBatch = first.rootFile(batchFile).toString();
const parsedOriginalBatch = JSON.parse(originalBatch);
assert.equal(parsedOriginalBatch.completed, true);
assert.equal(first.counts().spawnCalls, 17);
assert.ok(parsedOriginalBatch.outcomes.some(item => item.file === 'canvas-batch-schema-engineering.mjs'));
assert.ok(parsedOriginalBatch.outcomes.some(item => item.file === 'multiview-works-engineering.mjs'));
const originalAtomicReceipts = Object.fromEntries(parsedOriginalBatch.outcomes.map(item => {
  const file = stage + '/native-control-preflight/' + item.file + '.receipt.json';
  const bytes = first.rootFile(file).toString(), receipt = JSON.parse(bytes);
  assert.equal(receipt.schema, 'sd2-native-control-atomic-receipt.v1');
  assert.equal(receipt.runId, first.m.runId); assert.equal(receipt.file, item.file);
  assert.equal(receipt.status, 0); assert.equal(receipt.signal, null); assert.equal(receipt.error, null);
  assert.equal(receipt.errorCode, null); assert.equal(receipt.timeoutMs, 180000);
  assert.equal(receipt.log.bytes, Buffer.byteLength(receipt.stdout + receipt.stderr));
  assert.equal(receipt.log.sha256, sha(receipt.stdout + receipt.stderr));
  return [file, bytes];
}));
assert.equal(Object.keys(originalAtomicReceipts).length, 17);
assert.equal(first.files.has(stage + '/native-control-preflight/receipt.json'), false);
assert.ok(first.files.has(first.attempts[0].evidenceDirectory + '/failure.json'));
checks.push('native_batch_is_durable_before_transient_admission_refusal');
first.admit();
const result = await first.api.controlPreflight(first.m);
assert.equal(result.completed, true); assert.equal(result.nativeBeforeMaintenance.releaseApproved, false);
assert.deepEqual(first.counts(), { spawnCalls: 17, captures: 2, nativeReads: 2 });
assert.notEqual(first.attempts[0].evidenceDirectory, first.attempts[1].evidenceDirectory);
assert.equal(first.rootFile(batchFile).toString(), originalBatch);
for (const [file, bytes] of Object.entries(originalAtomicReceipts)) assert.equal(first.rootFile(file).toString(), bytes);
assert.equal(JSON.parse(first.rootFile(first.attempts[0].beforeFile)).capture, 1);
assert.equal(JSON.parse(first.rootFile(first.attempts[1].beforeFile)).capture, 2);
checks.push('same_run_reuses_only_pinned_batch_and_repeats_fresh_native_admission');
const [changedAtomicFile, originalAtomicBytes] = Object.entries(originalAtomicReceipts)[0];
first.files.delete(changedAtomicFile);
assert.throws(() => first.api.assertNativeBatch(first.m, parsedOriginalBatch));
first.files.set(changedAtomicFile, originalAtomicBytes);
const changedAtomicReceipt = JSON.parse(originalAtomicBytes); changedAtomicReceipt.unrecordedMutation = true;
first.files.set(changedAtomicFile, JSON.stringify(changedAtomicReceipt));
assert.throws(() => first.api.assertNativeBatch(first.m, parsedOriginalBatch));
first.files.set(changedAtomicFile, originalAtomicBytes);
assert.equal(first.api.assertNativeBatch(first.m, parsedOriginalBatch), parsedOriginalBatch);
assert.equal(first.rootFile(changedAtomicFile).toString(), originalAtomicBytes);
checks.push('batch_rejects_missing_or_changed_atomic_receipt_and_original_bytes_remain_reusable');
const originalReceipt = first.rootFile(stage + '/native-control-preflight/receipt.json').toString();
await assert.rejects(first.api.controlPreflight(first.m), /cannot be reissued/);
assert.equal(first.rootFile(stage + '/native-control-preflight/receipt.json').toString(), originalReceipt);
checks.push('completed_receipt_and_original_times_cannot_be_relabeled');

for (const change of [
  value => { value.schema = 'unknown'; }, value => { value.runId = 'other'; },
  value => { value.completed = false; }, value => { value.manifestSha256 = '0'.repeat(64); },
  value => { value.privateSha256 = {}; }, value => { value.servicesChanged = true; },
  value => { value.productionWrites = 1; }, value => { value.finishedAt = new Date(Date.now() + 60000).toISOString(); },
  value => { value.outcomes.pop(); }, value => { value.outcomes.reverse(); },
  value => { value.outcomes[0].exitCode = 1; }, value => { value.outcomes[0].signal = 'SIGTERM'; },
  value => { value.outcomes[0].error = 'failed'; }, value => { value.outcomes[0].sha256 = '0'.repeat(64); },
]) {
  const bad = JSON.parse(originalBatch); change(bad);
  assert.throws(() => first.api.assertNativeBatch(first.m, bad));
}
checks.push('changed_manifest_control_run_log_status_or_partial_batch_fails_closed');
const partial = harness();
partial.directories.add(stage + '/native-control-preflight');
partial.files.set(stage + '/native-control-preflight/partial.log', 'incomplete');
await assert.rejects(partial.api.controlPreflight(partial.m), /Incomplete native batch/);
assert.equal(partial.counts().spawnCalls, 0);
checks.push('missing_checkpoint_does_not_rerun_or_erase_partial_native_logs');

const firstNative = 'release-protection-engineering.mjs';
for (const scenario of [
  { label: 'timeout', result: { stdout: '', stderr: '', status: null, signal: 'SIGTERM',
    error: { message: 'spawnSync timed out', code: 'ETIMEDOUT' } }, status: null, signal: 'SIGTERM', errorCode: 'ETIMEDOUT' },
  { label: 'nonzero', result: { stdout: '', stderr: '', status: 7, signal: null }, status: 7, signal: null, errorCode: null },
  { label: 'zero', result: { stdout: '', stderr: '', status: 0, signal: null }, status: 0, signal: null, errorCode: null },
]) {
  const failed = harness({ spawnResult: ({ call }) => call === 1 ? scenario.result : null });
  await assert.rejects(failed.api.controlPreflight(failed.m), /Untrusted root input/);
  const receiptFile = stage + '/native-control-preflight/' + firstNative + '.receipt.json';
  const receipt = JSON.parse(failed.rootFile(receiptFile));
  assert.equal(receipt.file, firstNative); assert.equal(receipt.status, scenario.status);
  assert.equal(receipt.signal, scenario.signal); assert.equal(receipt.errorCode, scenario.errorCode);
  assert.equal(receipt.stdout, ''); assert.equal(receipt.stderr, ''); assert.equal(receipt.log.bytes, 0);
  assert.equal(receipt.log.sha256, sha(Buffer.alloc(0))); assert.equal(receipt.timeoutMs, 180000);
  assert.ok(receipt.durationMs >= 0); assert.deepEqual(failed.counts(), { spawnCalls: 1, captures: 0, nativeReads: 0 });
  assert.equal(failed.files.has(stage + '/native-control-preflight/' + firstNative + '.log'), true);
  assert.equal(failed.files.has(batchFile), false);
  checks.push('empty_' + scenario.label + '_log_fails_after_atomic_receipt_is_durable');
}

const nonzero = harness({ spawnResult: ({ call }) => call === 1
  ? { stdout: 'synthetic native failure\n', stderr: '', status: 9, signal: null } : null });
await assert.rejects(nonzero.api.controlPreflight(nonzero.m), /Release controller preflight failed/);
const rejectedBatch = JSON.parse(nonzero.rootFile(batchFile));
assert.equal(rejectedBatch.completed, false); assert.equal(rejectedBatch.outcomes.length, 17);
assert.equal(rejectedBatch.outcomes[0].status, 9); assert.equal(rejectedBatch.outcomes[0].exitCode, 9);
assert.equal(nonzero.counts().spawnCalls, 17); assert.equal(nonzero.files.has(stage + '/native-control-preflight/failure.json'), true);
for (const item of rejectedBatch.outcomes)
  assert.ok(nonzero.files.has(stage + '/native-control-preflight/' + item.file + '.receipt.json'));
checks.push('nonempty_nonzero_atomic_outcome_retains_full_batch_failure');

const codedError = harness({ spawnResult: ({ call }) => call === 1
  ? { stdout: 'spawn returned coded error evidence\n', stderr: '', status: 0, signal: null,
    error: { message: '', code: 'EIO' } } : null });
await assert.rejects(codedError.api.controlPreflight(codedError.m), /Release controller preflight failed/);
const codedBatch = JSON.parse(codedError.rootFile(batchFile));
assert.equal(codedBatch.completed, false); assert.equal(codedBatch.outcomes.length, 17);
assert.equal(codedBatch.outcomes[0].status, 0); assert.equal(codedBatch.outcomes[0].error, null);
assert.equal(codedBatch.outcomes[0].errorCode, 'EIO'); assert.equal(codedError.counts().spawnCalls, 17);
checks.push('nonempty_status_zero_error_code_still_marks_complete_batch_failed');

const safety = fs.readFileSync(new URL('./cutover-safety.mjs', import.meta.url), 'utf8');
const begin = safety.indexOf('export async function inspectNativeBeforeMaintenance(');
const end = safety.indexOf('\n// Explicit offline dependencies', begin);
assert.ok(begin > 0 && end > begin);
const body = safety.slice(begin, end).replace(/^export /, '');
const evidenceRoot = stage + '/readonly-before-maintenance';
const attempt = evidenceRoot + '/30000000-0000-4000-8000-000000000001';
const before = { manifestSha256: sha(JSON.stringify(first.m)) };
let permittedReads = 0;
const pathContext = { assert: normalizedAssert, path, process, Date, JSON, ROLES: ['web', 'image', 'hd'], sha,
  rootFile: file => file === stage + '/manifest.json' ? Buffer.from(JSON.stringify(first.m)) : Buffer.from(JSON.stringify({ runId: first.m.runId, ...before })),
  prepareOperationFenceModule: async () => ({}), nativeDependencies: () => ({}),
  readBeforeMaintenance: async () => { permittedReads++; return { parsed: {}, originalPolicy: {}, logStart: [] }; },
};
vm.runInNewContext(body + '\nglobalThis.inspect=inspectNativeBeforeMaintenance;', pathContext);
for (const [directory, file] of [[evidenceRoot, stage + '/preflight-switch-before.json'],
  [evidenceRoot, stage + '/switch-before.json'], [attempt, attempt + '/before.json']]) {
  assert.equal((await pathContext.inspect({ m: first.m, manifestSha256: before.manifestSha256, before,
    evidenceDirectory: directory, beforeFile: file })).completed, true);
}
for (const [directory, file] of [[attempt + '/../escape', attempt + '/before.json'],
  [evidenceRoot + '/unknown', evidenceRoot + '/unknown/before.json'], [attempt, stage + '/other-before.json']]) {
  await assert.rejects(pathContext.inspect({ m: first.m, manifestSha256: before.manifestSha256, before,
    evidenceDirectory: directory, beforeFile: file }));
}
assert.equal(permittedReads, 3);
checks.push('readonly_attempt_paths_are_exactly_namespaced_and_old_paths_preserved');
const activeBegin = safety.indexOf('async function readBeforeMaintenance(');
const activeEnd = safety.indexOf('\n// Engineering-only', activeBegin);
assert.ok(activeBegin > 0 && activeEnd > activeBegin);
const activeRead = safety.slice(activeBegin, activeEnd);
assert.ok(activeRead.includes("phase: 'live-before-maintenance'"));
assert.ok(activeRead.includes('assertActiveWriterIdentity(inspected.target, expected)'));
assert.equal(activeRead.includes('assertWriterFenceTarget('), false);
const fenceBegin = safety.indexOf('async function oldWebActive()');
const fenceEnd = safety.indexOf('\n  function noForcePolicy(', fenceBegin);
assert.ok(fenceBegin > activeEnd && fenceEnd > fenceBegin);
const actualFenceRead = safety.slice(fenceBegin, fenceEnd);
assert.ok(actualFenceRead.includes('await d.inspectFence(fenceArgs())'));
assert.ok(actualFenceRead.includes('assertWriterFenceTarget(fresh.target, expected)'));
assert.ok(safety.includes('parsed.runningRequests, 0'));
const writerFence = fs.readFileSync(new URL('./writer-network-fence.mjs', import.meta.url), 'utf8');
assert.ok(writerFence.includes("phase = 'drained'"));
assert.ok(writerFence.includes('? assertActiveWriterIdentity(observed, expected) : assertWriterFenceTarget(observed, expected)'));
assert.ok(writerFence.includes('assertActiveWriterIdentity(target, expected);\n  assert.equal(target.established3302, 0'));
assert.ok(writerFence.includes('assertWriterFenceTarget(await io.inspect(m, expected, deadline), expected)'));
// The same native batch executes these existing behavioral cases; only pin their wiring here.
const safetyEngineering = fs.readFileSync(new URL('./cutover-safety-engineering.mjs', import.meta.url), 'utf8');
for (const name of ['serving_connections_allowed_before_maintenance_but_rejected_before_fence',
  'serving_connections_naturally_drained_before_fence']) assert.ok(safetyEngineering.includes(name));
checks.push('active_identity_before_maintenance_and_strict_connection_zero_at_actual_fence');
checks.push('sync_zero_and_existing_cutover_behavioral_cases_remain');

for (const refuseInstalled of [false, true]) {
  const f = harness({ recoveredBaseline: { schema: 'sd2-multiview-r17-recovered-guard.v1' }, refuseInstalled });
  await assert.rejects(f.api.controlPreflight(f.m), refuseInstalled ? /installed-state-drift/ : /3302/);
  assert.equal(f.adoptionReads(), 1);
  assert.equal(f.counts().spawnCalls, refuseInstalled ? 0 : 17);
  if (refuseInstalled) assert.equal(f.files.has(stage + '/native-control-preflight/batch.json'), false);
}
checks.push('r17_installed_state_is_freshly_checked_before_engineering_and_drift_refuses_without_native_execution');

// Synthetic trust anchors stand in for the two immutable, root-owned original
// files only. All receipts, logs, private/source bytes and times are independently
// hashed by the real controller; no production checkpoint is created or copied.
function sizeLogHarness(options = {}) {
  const f = harness(options), c = f.context, originalRun = '10cf6c09-d7b4-4986-b3b8-0868dd8ca1cf';
  const originalStage = '/data/video-api-debugger/release-staging/' + originalRun;
  const manifestPin = '251e9697976e349f3b004c3c429cbeecac2a957f04e85fb1841dcda353c5becb';
  const batchPin = '486ba29a9a854401e551481aa5609c0d235bc909a9ae0eb29910a0372a4d79eb';
  const pins = new Map(); c.sha = bytes => pins.get(Buffer.from(bytes).toString()) || sha(bytes);
  const baseline = '31bff5a6544a3d18d433b81fa7735ed57b0d012c', liveRoot = '/data/video-api-debugger/managed-releases/' + baseline;
  Object.assign(f.m, { schema: 'rate-impl2-release.v1', project: 'video-api-debugger', projectRoot: '/data/video-api-debugger',
    appUser: 'fixture-app', observedAt: new Date(Date.now() - 5000).toISOString(), windowFile: stage + '/window.json',
    protectedIncrement: { schema: 'sd2-protected-increment.v1', baselineSource: baseline, pricingWrites: false,
      multiviewGeneration: false, canvasVideoBatchWrites: false, sizePolicyVersion: 2, diagnosticsSchema: 'image.provider-error.v1' },
    uploadPrivateDirectory: { canonical: '/data/verified', alias: '/data/alias', preparedReceipt: stage + '/upload-directory-prepared.json' },
    live: { web: { root: liveRoot, pid: 3881802, invocation: 'synthetic-original-live' }, hd: { root: liveRoot } } });
  for (const [kind, symbol] of [['main', 'a'], ['guard', 'b']]) {
    f.m[kind + 'Source'] = symbol.repeat(40);
    f.m[kind] = { source: symbol.repeat(40), root: '/data/video-api-debugger/managed-releases/' + symbol.repeat(40), version: '0.103.1',
      archive: stage + '/' + kind + '/source.tar.gz', sourceManifest: stage + '/' + kind + '/source-manifest.json', buildDist: '.next-prod-candidate' };
  }
  const original = JSON.parse(JSON.stringify(f.m));
  original.runId = originalRun; original.stage = originalStage; original.windowFile = originalStage + '/window.json';
  original.uploadPrivateDirectory.preparedReceipt = originalStage + '/upload-directory-prepared.json';
  original.observedAt = new Date(Date.now() - 120000).toISOString();
  for (const [kind, symbol] of [['main', 'c'], ['guard', 'd']]) {
    original[kind + 'Source'] = symbol.repeat(40); original[kind].source = symbol.repeat(40);
    original[kind].root = '/data/video-api-debugger/managed-releases/' + symbol.repeat(40);
    original[kind].archive = originalStage + '/' + kind + '/source.tar.gz';
    original[kind].sourceManifest = originalStage + '/' + kind + '/source-manifest.json';
  }
  c.MV_DIRECT.recoveryRunId = f.m.runId;
  const names = parsedOriginalBatch.outcomes.map(item => item.file);
  const privateFiles = [...new Set([...names, 'control-preflight.mjs', 'hd-storage-preflight.mjs', 'release-contract.mjs',
    'writer-network-fence.mjs', 'switch.mjs', 'guard-recovery.mjs', 'certificate.mjs', 'hd-legacy-ready-allowlist.mjs'])];
  const taskStart = source.indexOf('function nativeTasks(m, reference)'), arrayStart = source.indexOf('return [', taskStart) + 'return '.length;
  const arrayEnd = source.indexOf('\n  ];', arrayStart) + '\n  ]'.length;
  const originalController = '// Synthetic original controller projection.\nfor (const [file, args] of ' + source.slice(arrayStart, arrayEnd) + ') {\n}\n';
  const contractBytes = value => "import assert from 'node:assert/strict';\nexport const MV_DIRECT = Object.freeze("
    + JSON.stringify({ recoveryRunId: value.runId, mainSource: value.mainSource, recoveryGuardSource: value.guardSource,
      protectedIncrement: value.protectedIncrement, starts: { web: ['fixed-live'] }, versions: { main: '0.103.1', guard: '0.103.1' },
      approvedMainFiles: ['synthetic-business-source', ...(value.runId === f.m.runId ? ['scripts/studio-restored-settings-engineering.ts'] : [])].sort(),
      guardChangedFiles: ['synthetic-guard-display'],
    }, null, 2) + ');\n// Identical outside the generated object.\n';
  original.privateSha256 = {}; f.m.privateSha256 = {};
  for (const file of privateFiles) {
    let oldBytes = 'synthetic unchanged dependency:' + file, newBytes = oldBytes;
    if (file === 'control-preflight.mjs') { oldBytes = originalController; newBytes = source; }
    else if (file === 'preflight-resume-engineering.mjs') { oldBytes = 'synthetic original resume fixture'; newBytes = fs.readFileSync(new URL('./' + file, import.meta.url), 'utf8'); }
    else if (['hd-storage-preflight.mjs', 'hd-closed-cache-engineering.mjs', 'hd-storage-preflight-engineering.mjs'].includes(file)) {
      oldBytes = 'synthetic original HD helper:' + file; newBytes = fs.readFileSync(new URL('./' + file, import.meta.url), 'utf8');
    } else if (file === 'release-contract.mjs') { oldBytes = contractBytes(original); newBytes = contractBytes(f.m); }
    f.files.set(originalStage + '/fix01-release/' + file, oldBytes); original.privateSha256[file] = sha(oldBytes);
    f.files.set(stage + '/fix01-release/' + file, newBytes); f.m.privateSha256[file] = sha(newBytes);
  }
  f.files.set(stage + '/control-module-preflight.json', JSON.stringify({ moduleActuallyLoaded: true, sha256: f.m.privateSha256['writer-network-fence.mjs'] }));
  for (const value of [original, f.m]) for (const kind of ['main', 'guard']) {
    const profile = value === original ? 'original profile' : 'current profile only';
    const archive = 'synthetic archive:' + kind + ':' + profile;
    const sourceManifest = { schema: 'rate-impl2-source-manifest.v1', project: 'video-api-debugger', kind, baselineSource: baseline,
      source: value[kind].source, tree: value[kind].source, version: value[kind].version, archiveSha256: sha(archive),
      files: { 'ops/sd2-release-profile.json': sha(profile), 'src/unchanged.ts': sha('same business source') },
      fileDetails: { 'ops/sd2-release-profile.json': { gitBlob: value[kind].source, mode: '100644', bytes: Buffer.byteLength(profile) },
        'src/unchanged.ts': { gitBlob: 'f'.repeat(40), mode: '100644', bytes: 20 } },
      fileCount: 2, totalSourceBytes: 20 + Buffer.byteLength(profile), createdAt: value.observedAt };
    for (const [file, delta] of Object.entries(f.api.SIZE_LOG_SOURCE_DELTAS)) {
      const entry = value === original ? delta.original : delta.repaired;
      sourceManifest.files[file] = entry.sha256;
      sourceManifest.fileDetails[file] = { gitBlob: entry.gitBlob, mode: '100644', bytes: entry.bytes };
      sourceManifest.fileCount++; sourceManifest.totalSourceBytes += entry.bytes;
    }
    const sourceManifestBytes = JSON.stringify(sourceManifest);
    f.files.set(value[kind].sourceManifest, sourceManifestBytes); f.files.set(value[kind].archive, archive);
    if (value === original) pins.set(sourceManifestBytes, kind === 'main'
      ? '79ba38c50c6531a8965793bb065f999167a130bd575687327e5738b9ee2b0101'
      : '631dde9de8a191e77393b3fa2b0fe2fdb543c17a099f887a2bc650ab8c19c73b');
  }
  const originalManifest = JSON.stringify(original); f.files.set(originalStage + '/manifest.json', originalManifest); pins.set(originalManifest, manifestPin);
  f.files.set(stage + '/manifest.json', JSON.stringify(f.m));
  const originalStarted = Date.now() - 60000, originalFinished = originalStarted + 1000;
  const outcomes = names.map(file => {
    const stdout = 'synthetic original completed:' + file, log = originalStage + '/native-control-preflight/' + file + '.log';
    const atomic = { schema: 'sd2-native-control-atomic-receipt.v1', runId: originalRun, manifestSha256: manifestPin, file,
      startedAt: new Date(originalStarted).toISOString(), finishedAt: new Date(originalFinished).toISOString(), durationMs: 1000,
      timeoutMs: 180000, status: 0, signal: null, error: null, errorCode: null, stdout, stderr: '', stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: 0, log: { path: log, bytes: Buffer.byteLength(stdout), sha256: sha(stdout) } };
    const bytes = JSON.stringify(atomic); f.files.set(log, stdout);
    f.files.set(originalStage + '/native-control-preflight/' + file + '.receipt.json', bytes);
    return f.api.outcomeFromAtomicReceipt(original, atomic, sha(bytes));
  });
  const batch = { schema: 'sd2-native-control-batch.v1', runId: originalRun, completed: true, manifestSha256: manifestPin,
    privateSha256: original.privateSha256, startedAt: new Date(originalStarted).toISOString(), finishedAt: new Date(originalFinished).toISOString(),
    outcomes, servicesChanged: false, productionWrites: 0 };
  const originalBatchBytes = JSON.stringify(batch); f.files.set(originalStage + '/native-control-preflight/batch.json', originalBatchBytes); pins.set(originalBatchBytes, batchPin);
  const executable = '/usr/bin/synthetic-original-node', stats = new Map(), descriptors = new Map(); let nextFd = 100;
  f.files.set(executable, 'synthetic current runtime observed now');
  stats.set(executable, { isFile: () => true, isSymbolicLink: () => false, uid: 0, gid: 0, mode: 0o100755, nlink: 2,
    dev: 1, ino: 1, size: Buffer.byteLength(f.files.get(executable)), mtimeMs: originalStarted - 60000, ctimeMs: originalStarted - 60000 });
  stats.set(process.execPath, { ...stats.get(executable), isFile: () => false, isSymbolicLink: () => true, mode: 0o120777, nlink: 1 });
  const compilerFiles = ['scripts/process-hd-image.ts', 'src/lib/media/hd-image-processor.ts', 'src/lib/media/hd-encoder.ts',
    'node_modules/tsx/dist/index-7AaEi15b.mjs', 'tsconfig.json'];
  const compilerProof = {};
  for (const [index, relative] of compilerFiles.entries()) {
    const file = liveRoot + '/' + relative, bytes = 'synthetic app-owned compiler source:' + relative;
    f.files.set(file, bytes); compilerProof[relative] = sha(bytes);
    stats.set(file, { isFile: () => true, isSymbolicLink: () => false, uid: 1004, gid: 1004, mode: 0o100644, nlink: 1,
      dev: 1, ino: index + 10, size: Buffer.byteLength(bytes), mtimeMs: originalStarted - 60000, ctimeMs: originalStarted - 60000 });
  }
  const python = { python: '/usr/bin/synthetic-python3', wrapper: '/usr/lib/python/sqlite3/__init__.py',
    extension: '/usr/lib/python/_sqlite3.so', libraries: ['/usr/lib/libsqlite3.so'], sqliteVersion: '3.40.1' };
  const typescript = liveRoot + '/node_modules/typescript/lib/typescript.js';
  for (const [index, file] of [python.python, python.wrapper, python.extension, ...python.libraries, typescript].entries()) {
    const bytes = 'synthetic unchanged runtime dependency:' + file; f.files.set(file, bytes);
    stats.set(file, { isFile: () => true, isSymbolicLink: () => false, uid: file === typescript ? 1004 : 0, gid: file === typescript ? 1004 : 0,
      mode: 0o100644, nlink: 1, dev: 1, ino: index + 20, size: Buffer.byteLength(bytes), mtimeMs: originalStarted - 60000, ctimeMs: originalStarted - 60000 });
  }
  for (const file of [process.execPath, executable, python.python, python.wrapper, python.extension, ...python.libraries]) {
    for (let directory = path.dirname(file);; directory = path.dirname(directory)) {
      if (!stats.has(directory)) stats.set(directory, { isDirectory: () => true, isSymbolicLink: () => false, uid: 0, gid: 0,
        mode: 0o40755, nlink: 2, dev: 1, ino: 1000 + stats.size, size: 4096,
        mtimeMs: originalStarted - 60000, ctimeMs: originalStarted - 60000 });
      if (directory === '/') break;
    }
  }
  const lstat = c.fs.lstatSync;
  Object.assign(c.fs, { constants: fs.constants,
    realpathSync: file => file === process.execPath || file === '/proc/' + f.m.live.web.pid + '/exe' ? executable : file,
    lstatSync: file => stats.get(file) || lstat(file),
    openSync: file => { assert.ok(stats.has(file)); const fd = nextFd++; descriptors.set(fd, file); return fd; },
    fstatSync: fd => stats.get(descriptors.get(fd)), readFileSync: fd => Buffer.from(f.files.get(descriptors.get(fd))),
    closeSync: fd => descriptors.delete(fd) });
  c.call = (bin, args) => bin === 'id' ? (normalizedAssert.deepEqual(args, ['-u', 'fixture-app']), '1004')
    : bin === 'python3' ? JSON.stringify(python) : '/data';
  c.createRequire = from => ({ resolve: name => { assert.equal(from, liveRoot + '/package.json'); assert.equal(name, 'typescript'); return typescript; } });
  c.assertHdE01CacheSourceProof = proof => normalizedAssert.deepEqual(proof, compilerProof);
  const archiveCalls = [];
  c.verifyRateSourceArchive = async value => {
    assert.equal(sha(f.rootFile(value.archive)), value.manifest.archiveSha256); archiveCalls.push(value.archive);
    if (options.archiveFailure) throw Error('synthetic archive mismatch');
    return { verifiedCommittedBlobs: true };
  };
  const prior = JSON.parse(JSON.stringify(f.m)), priorStage = '/data/video-api-debugger/release-staging/b87ce364-6722-413e-b756-42fd3c78d952';
  const priorManifestPin = '1b8e8936f3fd6ac1554d20c9de18c52a41b15c4e52b8fdbdcfb7de645b3118ac';
  prior.runId = 'b87ce364-6722-413e-b756-42fd3c78d952'; prior.stage = priorStage; prior.windowFile = priorStage + '/window.json';
  prior.uploadPrivateDirectory.preparedReceipt = priorStage + '/upload-directory-prepared.json';
  prior.observedAt = new Date(originalStarted + 5000).toISOString(); prior.privateSha256 = {};
  for (const file of privateFiles) {
    let bytes = file === 'release-contract.mjs' ? contractBytes(prior)
      : file === 'preflight-resume-engineering.mjs' ? 'synthetic failed original JSON-construction fixture'
        : f.files.get(stage + '/fix01-release/' + file);
    if (file === 'hd-storage-preflight.mjs') {
      const start = bytes.indexOf('\nfunction assertNoSupersededHdProcess('), end = bytes.indexOf('\nexport function inspectHdClosedExecutionCache(', start);
      assert.ok(start > 0 && end > start); bytes = bytes.slice(0, start) + bytes.slice(end);
    } else if (['hd-closed-cache-engineering.mjs', 'hd-storage-preflight-engineering.mjs'].includes(file))
      bytes = 'synthetic prior independently completed HD engineering:' + file;
    f.files.set(priorStage + '/fix01-release/' + file, bytes); prior.privateSha256[file] = sha(bytes);
  }
  for (const [kind, symbol] of [['main', 'e'], ['guard', 'f']]) {
    prior[kind + 'Source'] = symbol.repeat(40); prior[kind].source = symbol.repeat(40);
    prior[kind].root = '/data/video-api-debugger/managed-releases/' + symbol.repeat(40);
    prior[kind].archive = priorStage + '/' + kind + '/source.tar.gz'; prior[kind].sourceManifest = priorStage + '/' + kind + '/source-manifest.json';
    const value = JSON.parse(f.files.get(f.m[kind].sourceManifest)), profile = 'prior successful leaves profile';
    for (const [file, delta] of Object.entries(f.api.SIZE_LOG_SOURCE_DELTAS)) {
      value.totalSourceBytes += delta.original.bytes - value.fileDetails[file].bytes;
      value.files[file] = delta.original.sha256;
      value.fileDetails[file] = { gitBlob: delta.original.gitBlob, mode: '100644', bytes: delta.original.bytes };
    }
    value.source = prior[kind].source; value.tree = prior[kind].source;
    value.totalSourceBytes += Buffer.byteLength(profile) - value.fileDetails['ops/sd2-release-profile.json'].bytes;
    value.files['ops/sd2-release-profile.json'] = sha(profile);
    value.fileDetails['ops/sd2-release-profile.json'] = { gitBlob: value.source, mode: '100644', bytes: Buffer.byteLength(profile) };
    const archive = 'synthetic independently verified prior archive:' + kind; value.archiveSha256 = sha(archive);
    const bytes = JSON.stringify(value); f.files.set(prior[kind].sourceManifest, bytes); f.files.set(prior[kind].archive, archive);
    pins.set(bytes, kind === 'main' ? '80f05175a96757f24d1395964b1f33e1b814d49f66f1faebcaaef6d786640748'
      : '85f0f86ebb48f27e4ce1af36329087bd177a9cce025d9f2c00069244c647690d');
  }
  f.files.set(priorStage + '/fix01-release/release-contract.mjs', contractBytes(prior));
  prior.privateSha256['release-contract.mjs'] = sha(contractBytes(prior));
  const priorManifestBytes = JSON.stringify(prior); f.files.set(priorStage + '/manifest.json', priorManifestBytes); pins.set(priorManifestBytes, priorManifestPin);
  const priorPins = {
    'hd-closed-cache-engineering.mjs': '78175ca1287cdbc0b96a212deab216d5e1cef0bb925eef00caaab0fa756ef281',
    'hd-storage-preflight-engineering.mjs': 'a611bfa859d6baf2091c5bfb298bfceb0c6b509b31946c37ff4b99de44db7d76',
    'candidate-lifecycle-engineering.mjs': 'c8ba1d1a5fc1605bf800cd60399a82f8154147d26e5983a06f8ae40688cb8f76',
    'runtime-source-engineering.mjs': '296e5e9f064004085443a18202b37cc39a822498e2e7f5c7d148f05f71e0cfca',
    'canvas-batch-schema-engineering.mjs': '98d49604710388f3bdb77fc1d551e769399d38686097de41c6bfe5c8d77d8b31',
  }, priorOutcomes = {};
  const auditOutcomes = outcomes.map(old => {
    if (!Object.hasOwn(priorPins, old.file) && old.file !== 'preflight-resume-engineering.mjs') return { ...old, execution: 'reused' };
    const log = priorStage + '/native-control-preflight/' + old.file + '.log', stdout = 'synthetic original leaf:' + old.file;
    const atomic = { ...JSON.parse(f.files.get(originalStage + '/native-control-preflight/' + old.file + '.receipt.json')),
      runId: prior.runId, manifestSha256: priorManifestPin, status: old.file === 'preflight-resume-engineering.mjs' ? 1 : 0,
      startedAt: new Date(originalStarted + 10000).toISOString(), finishedAt: new Date(originalStarted + 11000).toISOString(),
      stdout, stdoutBytes: Buffer.byteLength(stdout), log: { path: log, bytes: Buffer.byteLength(stdout), sha256: sha(stdout) } };
    const bytes = JSON.stringify(atomic), digest = priorPins[old.file] || sha(bytes);
    pins.set(bytes, digest); f.files.set(log, stdout); f.files.set(priorStage + '/native-control-preflight/' + old.file + '.receipt.json', bytes);
    const leaf = f.api.outcomeFromAtomicReceipt(prior, atomic, digest); priorOutcomes[old.file] = leaf;
    return { ...leaf, execution: 'executed' };
  });
  const identityFields = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'gid', 'mode', 'nlink'];
  const observedRuntime = (input, file, system) => ({ input, file, category: system ? 'system' : 'application', observedSha256: sha(f.files.get(file)),
    ...Object.fromEntries(identityFields.map(key => [key, stats.get(file)[key]])), proof: 'current-observation-with-ctime-predating-original-batch' });
  const priorAudit = { schema: 'sd2-native-control-batch.v1', runId: prior.runId, completed: false, manifestSha256: priorManifestPin,
    privateSha256: prior.privateSha256, outcomes: auditOutcomes, servicesChanged: false, productionWrites: 0,
    reusedOriginal: { compilerProof, runtime: observedRuntime(process.execPath, executable, true),
      pythonSqlite: { sqliteVersion: python.sqliteVersion, files: [python.python, python.wrapper, python.extension, ...python.libraries]
        .map(file => observedRuntime(file, file, true)) }, typescript: { resolved: typescript, ...observedRuntime(typescript, typescript, false) } } };
  const priorBatchBytes = JSON.stringify(priorAudit); f.files.set(priorStage + '/native-control-preflight/batch.json', priorBatchBytes);
  pins.set(priorBatchBytes, '867f87f405017d368641136c55fdbafd052e5a00bb17a95ebc95f17f9aa744b2');
  const hdClosed = JSON.parse(JSON.stringify(f.m)), hdClosedStage = '/data/video-api-debugger/release-staging/b1a58279-1d4a-4b09-8dfb-929fb9350ba3';
  const hdManifestPin = 'b3d1568c646114a00e98a99a5080a4bbfb935ff9b9a06bd1fc0456c6c38b94e2';
  hdClosed.runId = 'b1a58279-1d4a-4b09-8dfb-929fb9350ba3'; hdClosed.stage = hdClosedStage; hdClosed.windowFile = hdClosedStage + '/window.json';
  hdClosed.uploadPrivateDirectory.preparedReceipt = hdClosedStage + '/upload-directory-prepared.json';
  hdClosed.observedAt = new Date(originalStarted + 15000).toISOString(); hdClosed.privateSha256 = {};
  for (const [kind, source] of [['main', 'de9fc0b9a098702e0d88eda599a11d0520c52a21'], ['guard', '32f3f71683fddedfc83c976eb6c280db22dab64b']]) {
    hdClosed[kind + 'Source'] = source; hdClosed[kind].source = source; hdClosed[kind].root = '/data/video-api-debugger/managed-releases/' + source;
    hdClosed[kind].archive = hdClosedStage + '/' + kind + '/source.tar.gz'; hdClosed[kind].sourceManifest = hdClosedStage + '/' + kind + '/source-manifest.json';
    const value = JSON.parse(f.files.get(f.m[kind].sourceManifest)), profile = 'R06 HD leaf profile';
    for (const [file, delta] of Object.entries(f.api.SIZE_LOG_SOURCE_DELTAS)) {
      value.totalSourceBytes += delta.original.bytes - value.fileDetails[file].bytes;
      value.files[file] = delta.original.sha256;
      value.fileDetails[file] = { gitBlob: delta.original.gitBlob, mode: '100644', bytes: delta.original.bytes };
    }
    value.source = source; value.tree = source;
    value.totalSourceBytes += Buffer.byteLength(profile) - value.fileDetails['ops/sd2-release-profile.json'].bytes;
    value.files['ops/sd2-release-profile.json'] = sha(profile);
    value.fileDetails['ops/sd2-release-profile.json'] = { gitBlob: source, mode: '100644', bytes: Buffer.byteLength(profile) };
    const archive = 'synthetic independently verified R06 archive:' + kind; value.archiveSha256 = sha(archive);
    const bytes = JSON.stringify(value); f.files.set(hdClosed[kind].sourceManifest, bytes); f.files.set(hdClosed[kind].archive, archive);
    pins.set(bytes, kind === 'main' ? 'e6b43c66f41262bd9fd92050d088ab3b274485ea55c928f68280136bd8cf6b33'
      : 'a242d80e83a7684c228574e84634204dfd270cba98ffd762a17b38bafa685520');
  }
  for (const file of privateFiles) {
    let bytes = file === 'release-contract.mjs' ? contractBytes(hdClosed) : f.files.get(stage + '/fix01-release/' + file);
    if (file === 'hd-storage-preflight.mjs') {
      const start = bytes.indexOf('\nfunction createProtectedDiscoveryContinuation('), end = bytes.indexOf('\nfunction inventory(', start);
      assert.ok(start > 0 && end > start); bytes = bytes.slice(0, start) + bytes.slice(end);
    } else if (file === 'hd-storage-preflight-engineering.mjs') bytes = 'synthetic R06 completed storage fixture';
    f.files.set(hdClosedStage + '/fix01-release/' + file, bytes); hdClosed.privateSha256[file] = sha(bytes);
  }
  const hdManifestBytes = JSON.stringify(hdClosed); f.files.set(hdClosedStage + '/manifest.json', hdManifestBytes); pins.set(hdManifestBytes, hdManifestPin);
  const hdFile = 'hd-closed-cache-engineering.mjs', hdLog = hdClosedStage + '/native-control-preflight/' + hdFile + '.log';
  const hdStdout = 'synthetic original R06 HD closed-cache leaf', hdLogPin = '9959d9527a8c747d3036278859b80ce38e89633c6550c57acd9abf52dfd14e9a';
  pins.set(hdStdout, hdLogPin);
  const hdAtomic = { ...JSON.parse(f.files.get(originalStage + '/native-control-preflight/' + hdFile + '.receipt.json')),
    runId: hdClosed.runId, manifestSha256: hdManifestPin, startedAt: new Date(originalStarted + 20000).toISOString(),
    finishedAt: new Date(originalStarted + 21000).toISOString(), stdout: hdStdout, stdoutBytes: Buffer.byteLength(hdStdout),
    log: { path: hdLog, bytes: Buffer.byteLength(hdStdout), sha256: hdLogPin } };
  const hdAtomicBytes = JSON.stringify(hdAtomic), hdAtomicPin = '66f95ad6161733b1df366b9e217a086a1fe5fe51981bca04cca6f4082b78b96e';
  pins.set(hdAtomicBytes, hdAtomicPin); f.files.set(hdLog, hdStdout);
  f.files.set(hdClosedStage + '/native-control-preflight/' + hdFile + '.receipt.json', hdAtomicBytes);
  const hdClosedOutcome = f.api.outcomeFromAtomicReceipt(hdClosed, hdAtomic, hdAtomicPin);
  const hdBatch = { schema: 'sd2-native-control-batch.v1', runId: hdClosed.runId, completed: true, manifestSha256: hdManifestPin,
    privateSha256: hdClosed.privateSha256, startedAt: new Date(originalStarted + 19000).toISOString(), finishedAt: new Date(originalStarted + 22000).toISOString(),
    outcomes: outcomes.map(item => item.file === hdFile ? { ...hdClosedOutcome, execution: 'executed' } : { ...item, execution: 'reused' }),
    reusedOriginal: priorAudit.reusedOriginal, servicesChanged: false, productionWrites: 0 };
  const hdBatchBytes = JSON.stringify(hdBatch); f.files.set(hdClosedStage + '/native-control-preflight/batch.json', hdBatchBytes);
  pins.set(hdBatchBytes, 'bc674a7be5cc5581e3fd2231cc5f868742cda75bab296467a29e3dacddd15357');
  f.files.set(hdClosedStage + '/retained-outer-preflight-failure.json', 'synthetic retained outer-preflight failure, not successful native admission');
  const storage = JSON.parse(JSON.stringify(f.m)), storageStage = '/data/video-api-debugger/release-staging/009ae041-fd1c-4921-aa4e-7ea225d42434';
  const storageManifestPin = '981537bd462d8c668baca4da8587f34336164c9e604f656514c469121d00cb7f';
  storage.runId = '009ae041-fd1c-4921-aa4e-7ea225d42434'; storage.stage = storageStage; storage.windowFile = storageStage + '/window.json';
  storage.uploadPrivateDirectory.preparedReceipt = storageStage + '/upload-directory-prepared.json';
  storage.observedAt = new Date(originalStarted + 23000).toISOString(); storage.privateSha256 = {};
  for (const kind of ['main', 'guard']) {
    storage[kind].archive = storageStage + '/' + kind + '/source.tar.gz';
    storage[kind].sourceManifest = storageStage + '/' + kind + '/source-manifest.json';
  }
  for (const file of privateFiles) {
    const bytes = file === 'release-contract.mjs' ? contractBytes(storage) : f.files.get(stage + '/fix01-release/' + file);
    f.files.set(storageStage + '/fix01-release/' + file, bytes); storage.privateSha256[file] = sha(bytes);
  }
  const storageManifestBytes = JSON.stringify(storage); f.files.set(storageStage + '/manifest.json', storageManifestBytes);
  pins.set(storageManifestBytes, storageManifestPin);
  const storageFile = 'hd-storage-preflight-engineering.mjs', storageLog = storageStage + '/native-control-preflight/' + storageFile + '.log';
  const storageStdout = JSON.stringify({ schema: 'hd-storage-preflight-engineering-v1', completed: true, total: 71, passed: 71,
    helperSha256: f.m.privateSha256['hd-storage-preflight.mjs'], legacyAllowlistSha256: f.m.privateSha256['hd-legacy-ready-allowlist.mjs'],
    productionWrites: 0, networkRequests: 0, providerRequests: 0, serviceChanges: 0, releasesSwitched: 0 });
  const storageLogPin = '051fd7fe30e1004cce194b14b165dc553cf81963855ad1e6b508c072eb18f60b'; pins.set(storageStdout, storageLogPin);
  const storageAtomic = { ...JSON.parse(f.files.get(originalStage + '/native-control-preflight/' + storageFile + '.receipt.json')),
    runId: storage.runId, manifestSha256: storageManifestPin, startedAt: new Date(originalStarted + 24000).toISOString(),
    finishedAt: new Date(originalStarted + 25000).toISOString(), stdout: storageStdout, stdoutBytes: Buffer.byteLength(storageStdout),
    log: { path: storageLog, bytes: Buffer.byteLength(storageStdout), sha256: storageLogPin } };
  const storageAtomicBytes = JSON.stringify(storageAtomic), storageAtomicPin = '6c2520f906de7b0a6c970818e6d0e6dc9f6254a28f27b2c3af603ee04d1175d8';
  pins.set(storageAtomicBytes, storageAtomicPin); f.files.set(storageLog, storageStdout);
  f.files.set(storageStage + '/native-control-preflight/' + storageFile + '.receipt.json', storageAtomicBytes);
  const storageOutcome = f.api.outcomeFromAtomicReceipt(storage, storageAtomic, storageAtomicPin);
  const storageBatch = { schema: 'sd2-native-control-batch.v1', runId: storage.runId, completed: true, manifestSha256: storageManifestPin,
    privateSha256: storage.privateSha256, outcomes: [{ ...storageOutcome, execution: 'executed' }],
    reusedOriginal: priorAudit.reusedOriginal, servicesChanged: false, productionWrites: 0 };
  const storageBatchBytes = JSON.stringify(storageBatch); f.files.set(storageStage + '/native-control-preflight/batch.json', storageBatchBytes);
  pins.set(storageBatchBytes, '4e9e48b2792b6c943295b15168d7b8127dfe31b509bf8aa76678ae9d107f352e');
  f.files.set(storageStage + '/retained-product-build-failure.json', 'synthetic retained failed guard build; not adopted');
  return { ...f, original, originalStage, batch, stats, pins, archiveCalls, executable, compilerFiles, liveRoot, python, typescript,
    prior, priorStage, priorOutcomes, priorAudit, hdClosed, hdClosedStage, hdClosedOutcome, storage, storageStage, storageOutcome };
}

const expectedExecuted = ['preflight-resume-engineering.mjs'];
const expectedPriorLeaves = ['candidate-lifecycle-engineering.mjs', 'runtime-source-engineering.mjs', 'canvas-batch-schema-engineering.mjs'];
const reused = sizeLogHarness(), originalFiles = new Map([...reused.files].filter(([file]) => file.startsWith(reused.originalStage + '/') || file.startsWith(reused.priorStage + '/') || file.startsWith(reused.hdClosedStage + '/') || file.startsWith(reused.storageStage + '/')));
await assert.rejects(reused.api.controlPreflight(reused.m), /3302/);
const reusedBatchBytes = reused.rootFile(batchFile).toString(), reusedBatch = JSON.parse(reusedBatchBytes);
assert.equal(reused.counts().spawnCalls, 1); assert.equal(reused.archiveCalls.length, 8);
assert.deepEqual(reused.spawned.map(args => path.basename(args[0])), expectedExecuted);
assert.equal(reusedBatch.outcomes.filter(item => item.execution === 'executed').length, 1);
assert.equal(reusedBatch.outcomes.filter(item => item.execution === 'reused').length, 16);
assert.equal(reusedBatch.outcomes.filter(item => item.original?.runId === reused.original.runId).length, 11);
assert.deepEqual(reusedBatch.outcomes.filter(item => item.original?.runId === reused.prior.runId).map(item => item.file), expectedPriorLeaves);
assert.deepEqual(Object.keys(reusedBatch.reusedOriginal.priorSuccessfulLeaves.receipts), expectedPriorLeaves);
assert.deepEqual(reusedBatch.outcomes.filter(item => item.original?.runId === reused.hdClosed.runId).map(item => item.file), ['hd-closed-cache-engineering.mjs']);
assert.equal(reusedBatch.reusedOriginal.hdClosedLeaf.nativeBatchCompleted, true);
assert.equal(reusedBatch.reusedOriginal.hdClosedLeaf.aggregateAdopted, false); assert.equal(reusedBatch.reusedOriginal.hdClosedLeaf.outerPreflightAdopted, false);
assert.deepEqual(reusedBatch.outcomes.filter(item => item.original?.runId === reused.storage.runId).map(item => item.file), ['hd-storage-preflight-engineering.mjs']);
assert.equal(reusedBatch.reusedOriginal.storageLeaf.aggregateAdopted, false); assert.equal(reusedBatch.reusedOriginal.storageLeaf.productBuildAdopted, false);
for (const item of reusedBatch.outcomes.filter(item => item.execution === 'executed')) assert.equal(item.original, undefined);
assert.equal(reusedBatch.reusedOriginal.priorSuccessfulLeaves.failedAggregateAdopted, false);
for (const item of reusedBatch.outcomes.filter(item => item.execution === 'reused')) {
  const old = item.file === 'hd-storage-preflight-engineering.mjs' ? reused.storageOutcome : item.file === 'hd-closed-cache-engineering.mjs' ? reused.hdClosedOutcome
    : reused.priorOutcomes[item.file] || reused.batch.outcomes.find(value => value.file === item.file);
  for (const field of ['startedAt', 'finishedAt', 'durationMs', 'receiptSha256', 'sha256']) assert.equal(item[field], old[field]);
  assert.equal(reused.files.has(stage + '/native-control-preflight/' + item.file + '.log'), false);
  assert.equal(reused.files.has(stage + '/native-control-preflight/' + item.file + '.receipt.json'), false);
}
reused.admit(); await reused.api.controlPreflight(reused.m);
assert.equal(reused.counts().spawnCalls, 1); assert.equal(reused.archiveCalls.length, 8);
assert.equal(reused.rootFile(batchFile).toString(), reusedBatchBytes);
assert.equal(reused.api.assertControlPreflight(reused.m).completed, true);
for (const [file, bytes] of originalFiles) assert.equal(reused.files.get(file), bytes);
for (const file of ['hd-closed-cache-engineering.mjs', 'hd-storage-preflight-engineering.mjs']) for (const suffix of ['.receipt.json', '.log']) {
  const old = reused.priorStage + '/native-control-preflight/' + file + suffix, bytes = reused.files.get(old);
  reused.files.delete(old); reused.api.assertNativeBatch(reused.m, reusedBatch); reused.files.set(old, bytes);
}
checks.push('protected_size_log_spawns_only_resume_references_eleven_original_three_r04_one_r06_and_one_r08_leaf_without_recursive_adoption');

const originalPaths = [reused.originalStage + '/manifest.json', reused.originalStage + '/native-control-preflight/batch.json',
  reused.original.main.sourceManifest, reused.original.guard.sourceManifest,
  reused.priorStage + '/manifest.json', reused.priorStage + '/native-control-preflight/batch.json',
  reused.prior.main.sourceManifest, reused.prior.guard.sourceManifest,
  reused.hdClosedStage + '/manifest.json', reused.hdClosedStage + '/native-control-preflight/batch.json',
  reused.hdClosed.main.sourceManifest, reused.hdClosed.guard.sourceManifest,
  reused.storageStage + '/manifest.json', reused.storageStage + '/native-control-preflight/batch.json',
  ...reusedBatch.outcomes.filter(item => item.original?.runId === reused.storage.runId).flatMap(item => [item.original.receipt, item.original.log]),
  ...reusedBatch.outcomes.filter(item => item.original?.runId === reused.hdClosed.runId).flatMap(item => [item.original.receipt, item.original.log]),
  ...reusedBatch.outcomes.filter(item => item.original?.runId === reused.prior.runId).flatMap(item => [item.original.receipt, item.original.log]),
  reusedBatch.outcomes.find(item => item.execution === 'reused').original.receipt,
  reusedBatch.outcomes.find(item => item.execution === 'reused').original.log];
for (const file of originalPaths) {
  const bytes = reused.files.get(file); reused.files.delete(file);
  assert.throws(() => reused.api.assertNativeBatch(reused.m, reusedBatch)); reused.files.set(file, bytes + '\nchanged');
  assert.throws(() => reused.api.assertNativeBatch(reused.m, reusedBatch)); reused.files.set(file, bytes);
}
for (const change of [value => { value.reusedOriginal.runId = 'wrong'; }, value => { value.reusedOriginal.manifestSha256 = '0'.repeat(64); },
  value => { value.reusedOriginal.batchSha256 = '0'.repeat(64); }, value => { value.outcomes[0].startedAt = new Date().toISOString(); },
  value => { value.outcomes[0].original.receipt = stage + '/copied.receipt.json'; }, value => { value.outcomes[0].execution = 'executed'; },
  value => { value.reusedOriginal.priorSuccessfulLeaves.failedAggregateAdopted = true; },
  value => { value.reusedOriginal.hdClosedLeaf.aggregateAdopted = true; }, value => { value.reusedOriginal.hdClosedLeaf.outerPreflightAdopted = true; },
  value => { value.reusedOriginal.storageLeaf.aggregateAdopted = true; }, value => { value.reusedOriginal.storageLeaf.productBuildAdopted = true; },
  value => { value.outcomes.find(item => item.file === 'hd-storage-preflight-engineering.mjs').original.runId = value.runId; },
  value => { value.outcomes.find(item => item.file === 'hd-closed-cache-engineering.mjs').startedAt = new Date().toISOString(); },
  value => { value.outcomes.find(item => item.file === 'hd-closed-cache-engineering.mjs').original.runId = value.runId; },
  value => { value.outcomes.find(item => item.execution === 'executed').execution = 'reused'; }, value => { value.completed = false; }]) {
  const changed = JSON.parse(reusedBatchBytes); change(changed); assert.throws(() => reused.api.assertNativeBatch(reused.m, changed));
}
checks.push('protected_reuse_rejects_missing_tampered_original_manifest_batch_atomic_log_and_relabelled_times_or_modes');

const rejectDelta = mutate => {
  const f = sizeLogHarness(); mutate(f); f.files.set(stage + '/manifest.json', JSON.stringify(f.m));
  assert.throws(() => f.api.sizeLogOriginalCheckpoint(f.m)); assert.equal(f.counts().spawnCalls, 0);
};
for (const mutate of [
  f => { f.m.protectedIncrement.multiviewGeneration = true; }, f => { f.m.live.web.pid++; },
  f => { f.m.normalContinuation = { enabled: true }; }, f => { f.m.reuseBuilds = { enabled: true }; },
  f => { f.m.protectedIncrement.sizePolicyVersion = 1; },
  f => { f.m.privateSha256['unknown.mjs'] = sha('unknown'); },
  f => { const file = stage + '/fix01-release/switch.mjs'; f.files.set(file, 'changed switch'); f.m.privateSha256['switch.mjs'] = sha('changed switch'); },
  f => { const file = stage + '/fix01-release/release-contract.mjs'; f.files.set(file, f.files.get(file).replace('synthetic-business-source', 'changed-business-source')); f.m.privateSha256['release-contract.mjs'] = sha(f.files.get(file)); },
  f => { const file = f.m.main.sourceManifest, value = JSON.parse(f.files.get(file)); value.files['src/unchanged.ts'] = sha('changed'); f.files.set(file, JSON.stringify(value)); },
  f => { f.files.set(f.m.guard.archive, 'bad archive'); },
  f => { f.stats.get(f.liveRoot + '/' + f.compilerFiles[0]).uid = 1005; },
  f => { f.stats.get(f.executable).ctimeMs = Date.now(); },
  f => { f.stats.get(f.python.python).ctimeMs = Date.now(); },
  f => { f.stats.get(f.python.libraries[0]).ctimeMs = Date.now(); },
  f => { f.stats.get(f.typescript).ctimeMs = Date.now(); },
  f => { f.context.nativeTasks = () => []; },
]) rejectDelta(mutate);
for (const field of ['approvedMainFiles']) for (const omit of [true, false]) rejectDelta(f => {
  const file = stage + '/fix01-release/release-contract.mjs', text = f.files.get(file);
  const marker = 'export const MV_DIRECT = Object.freeze(', start = text.indexOf(marker) + marker.length, end = text.indexOf('\n});', start) + 2;
  const value = JSON.parse(text.slice(start, end)), restored = 'scripts/studio-restored-settings-engineering.ts';
  value[field] = omit ? value[field].filter(item => item !== restored) : [...value[field], restored];
  const changed = text.slice(0, start) + JSON.stringify(value, null, 2) + text.slice(end);
  f.files.set(file, changed); f.m.privateSha256['release-contract.mjs'] = sha(changed);
});
rejectDelta(f => {
  const file = stage + '/fix01-release/release-contract.mjs', text = f.files.get(file);
  const changed = text.replace('"synthetic-guard-display"', '"scripts/studio-restored-settings-engineering.ts"');
  assert.notEqual(changed, text); f.files.set(file, changed); f.m.privateSha256['release-contract.mjs'] = sha(changed);
});
for (const file of Object.keys(reused.api.SIZE_LOG_SOURCE_DELTAS)) for (const mutate of [
  value => { value.files[file] = '0'.repeat(64); },
  value => { value.files[file] = reused.api.SIZE_LOG_SOURCE_DELTAS[file].original.sha256; },
  value => { value.fileDetails[file].gitBlob = '0'.repeat(40); },
  value => { value.fileDetails[file].bytes++; value.totalSourceBytes++; },
  value => { value.fileDetails[file].mode = '100755'; },
  value => { delete value.files[file]; delete value.fileDetails[file]; value.fileCount--; },
]) rejectDelta(f => {
  const manifest = f.m.main.sourceManifest, value = JSON.parse(f.files.get(manifest));
  mutate(value); f.files.set(manifest, JSON.stringify(value));
});
for (const [before, after] of [
  ['const PROJECT = ', 'const CHANGED_PROJECT = '],
  ['function bindings(m, l)', 'function bindings(m, changed)'],
  ['const SOURCE_HELPERS = ', 'const CHANGED_SOURCE_HELPERS = '],
  ['export function inspectHdClosedExecutionCache(', 'export function changedHdClosedExecutionCache('],
]) rejectDelta(f => {
  const file = stage + '/fix01-release/hd-storage-preflight.mjs', original = f.files.get(file), changed = original.replace(before, after);
  assert.notEqual(changed, original); f.files.set(file, changed);
  // Keep the synthetic approved full-file pin so this specifically exercises
  // the real R04/R06 dependency projections, rather than only hash rejection.
  f.pins.set(changed, f.m.privateSha256['hd-storage-preflight.mjs']);
});
for (const [suffix, field, value] of [
  ['/manifest.json', 'runId', 'wrong-R08-run'],
  ['/native-control-preflight/hd-storage-preflight-engineering.mjs.receipt.json', 'status', 1],
]) rejectDelta(f => {
  const file = f.storageStage + suffix, bytes = f.files.get(file), parsed = JSON.parse(bytes);
  parsed[field] = value; const changed = JSON.stringify(parsed); f.files.set(file, changed); f.pins.set(changed, f.pins.get(bytes));
});
rejectDelta(f => {
  const file = stage + '/fix01-release/hd-closed-cache-engineering.mjs', changed = f.files.get(file) + '\n// unapproved HD leaf fixture delta';
  f.files.set(file, changed); f.pins.set(changed, f.m.privateSha256['hd-closed-cache-engineering.mjs']);
});
for (const [suffix, field, value] of [
  ['/manifest.json', 'runId', 'wrong-R06-run'],
  ['/native-control-preflight/batch.json', 'completed', false],
  ['/native-control-preflight/hd-closed-cache-engineering.mjs.receipt.json', 'status', 1],
]) rejectDelta(f => {
  const file = f.hdClosedStage + suffix, bytes = f.files.get(file), parsed = JSON.parse(bytes);
  parsed[field] = value; const changed = JSON.stringify(parsed); f.files.set(file, changed); f.pins.set(changed, f.pins.get(bytes));
});
checks.push('protected_reuse_requires_exact_contract_flags_live_private_source_argv_runtime_and_real_application_owner');

assert.equal(reusedBatch.reusedOriginal.runtime.category, 'system');
assert.equal(reusedBatch.reusedOriginal.runtime.nlink, 2);
assert.equal(reusedBatch.reusedOriginal.runtime.file, reused.executable);
assert.equal(reusedBatch.reusedOriginal.typescript.category, 'application');
for (const mutate of [
  f => { f.stats.get(f.executable).uid = 1004; },
  f => { f.stats.get(f.executable).mode = 0o100775; },
  f => { f.stats.get(f.executable).size = 0; },
  f => { f.stats.get(f.executable).size = 512 * 1024 * 1024 + 1; },
  f => { f.stats.get(process.execPath).uid = 1004; },
  f => { f.stats.get(path.dirname(f.executable)).mode = 0o40777; },
  f => { f.stats.get(f.typescript).nlink = 2; },
  f => { f.stats.get(f.typescript).uid = 0; f.stats.get(f.typescript).nlink = 2; },
  f => { const read = f.context.fs.readFileSync; f.context.fs.readFileSync = fd => {
    const bytes = read(fd); f.stats.set(f.executable, { ...f.stats.get(f.executable), ctimeMs: Date.now() }); return bytes;
  }; },
  f => { const resolve = f.context.fs.realpathSync; let reads = 0; f.context.fs.realpathSync = file =>
    file === process.execPath && ++reads > 1 ? '/usr/bin/changed-runtime' : resolve(file); },
]) rejectDelta(mutate);
checks.push('system_hardlinks_and_root_owned_aliases_preserve_identity_while_application_hardlinks_unsafe_parents_and_mutation_are_refused');

{
  const fixture = sizeLogHarness(), file = fixture.originalStage + '/manifest.json';
  fixture.stats.set(file, { isFile: () => true, isSymbolicLink: () => false, uid: 0, gid: 0, mode: 0o100600,
    nlink: 1, dev: 1, ino: 5000, size: Buffer.byteLength(fixture.files.get(file)), mtimeMs: 1, ctimeMs: 1 });
  const commonSource = fs.readFileSync(new URL('./common.mjs', import.meta.url), 'utf8');
  const start = commonSource.indexOf('export function rootFile('), end = commonSource.indexOf('export function writeJsonExclusive(', start);
  assert.ok(start >= 0 && end > start);
  const actualRootReader = { assert: normalizedAssert, fs: fixture.context.fs };
  vm.runInNewContext(commonSource.slice(start, end).replace(/^export /, '') + '\nglobalThis.read=rootFile;', actualRootReader);
  assert.deepEqual(actualRootReader.read(file), fixture.rootFile(file));
  fixture.stats.get(file).nlink = 2; assert.throws(() => actualRootReader.read(file));
}
checks.push('unchanged_actual_root_control_reader_still_refuses_hardlinks');

for (const file of [reused.python.python, reused.python.wrapper, reused.python.extension, ...reused.python.libraries, reused.typescript]) {
  const bytes = reused.files.get(file); reused.files.set(file, bytes + '\nchanged');
  assert.throws(() => reused.api.assertNativeBatch(reused.m, reusedBatch)); reused.files.set(file, bytes);
}
checks.push('protected_reuse_rechecks_only_resolved_python_sqlite_and_typescript_hashes_without_relabeling_original_evidence');

const incrementalPartial = sizeLogHarness(); incrementalPartial.directories.add(stage + '/native-control-preflight');
incrementalPartial.files.set(stage + '/native-control-preflight/partial.log', 'retained');
await assert.rejects(incrementalPartial.api.controlPreflight(incrementalPartial.m), /Incomplete native batch/);
assert.equal(incrementalPartial.counts().spawnCalls, 0); assert.equal(incrementalPartial.archiveCalls.length, 0);
assert.equal(incrementalPartial.files.get(stage + '/native-control-preflight/partial.log'), 'retained');
const incrementalFailure = sizeLogHarness({ spawnResult: () => ({ stdout: 'synthetic incremental failure', stderr: '', status: 8, signal: null }) });
await assert.rejects(incrementalFailure.api.controlPreflight(incrementalFailure.m), /Release controller preflight failed/);
assert.equal(incrementalFailure.counts().spawnCalls, 1);
const failedIncrementalBatch = incrementalFailure.rootFile(batchFile).toString();
assert.equal(JSON.parse(failedIncrementalBatch).completed, false);
await assert.rejects(incrementalFailure.api.controlPreflight(incrementalFailure.m));
assert.equal(incrementalFailure.rootFile(batchFile).toString(), failedIncrementalBatch); assert.equal(incrementalFailure.counts().spawnCalls, 1);
const archiveFailure = sizeLogHarness({ archiveFailure: true });
await assert.rejects(archiveFailure.api.controlPreflight(archiveFailure.m), /synthetic archive mismatch/);
assert.equal(archiveFailure.counts().spawnCalls, 0); assert.equal(archiveFailure.files.has(batchFile), false);
checks.push('protected_partial_failed_or_unverified_archive_cannot_be_overwritten_or_promoted_to_completed_evidence');

// These adapters isolate only the filesystem/runtime observations. The real
// controller selects/spawns all 19 actual entry commands, writes and rereads its
// atomic receipts, and makes the direct-leaf/admission decisions itself.
function sharedHarness(options = {}) {
  const f = harness(options), c = f.context, run = options.runId || f.m.runId;
  f.m.runId = run; f.m.projectRoot = '/data/video-api-debugger';
  f.m.stage = f.m.projectRoot + '/release-staging/' + run; f.directories.add(f.m.stage);
  f.m.appUser = 'fixture-app'; f.m.live.web.source = 'a'.repeat(40);
  f.m.live.hd = { root: f.m.live.web.root, source: f.m.live.web.source,
    sourceProof: { sourceManifest: '/data/synthetic-original/source-manifest.json', archive: '/data/synthetic-original/source.tar.gz' } };
  const digest = sha(JSON.stringify(f.m.privateSha256));
  f.m.engine = { schema: 'sd2-release-engine.v1', version: ENGINE_VERSION, controllerSetSha256: digest,
    root: f.m.projectRoot + '/release-engines/' + ENGINE_VERSION + '-' + digest };
  f.m.operation = { schema: 'sd2-release-operation.v1', taskId: '90000000-0000-4000-8000-000000000001', attemptId: run,
    taskRoot: f.m.projectRoot + '/release-tasks/90000000-0000-4000-8000-000000000001' };
  const contract = { engine: f.m.engine, operation: f.m.operation, recoveryRunId: run,
    closedCacheReference: 'closed-original', mainSource: 'b'.repeat(40), recoveryGuardSource: 'c'.repeat(40),
    protectedIncrement: { pricingWrites: false, multiviewGeneration: false, canvasVideoBatchWrites: false } };
  c.MV_DIRECT = contract;
  const saveManifest = () => f.files.set(f.m.stage + '/manifest.json', JSON.stringify(f.m));
  const saveContext = () => f.files.set(f.m.stage + '/context.json', JSON.stringify({ schema: 'sd2-release-context.v1', contract }));
  f.files.set(f.m.engine.root + '/writer-network-fence.mjs', 'original-fence');
  f.files.set(f.m.stage + '/control-module-preflight.json', JSON.stringify({ moduleActuallyLoaded: true, sha256: sha('original-fence') }));
  f.files.set(f.m.engine.root + '/hd-closed-cache-engineering.mjs', 'isolated cache reference declarations');
  saveManifest(); saveContext();
  const dependencies = { engine: f.m.engine, runtime: { observedSha256: sha('actual-runtime-adapter'), ctimeMs: 1 },
    baseline: { sourceManifest: f.m.live.hd.sourceProof.sourceManifest, dependencies: { sha256: sha('dependencies'), latestCtimeMs: 1 } } };
  let dependencyReads = 0, expired = false, bounds = 0;
  c.sharedControlDependencies = value => { engineDirectory(value); dependencyReads++; return structuredClone(dependencies); };
  c.sharedDependencyTree = root => ({ root, count: 3, latestCtimeMs: 1, sha256: sha('closed-cache-argument:' + root) });
  c.assertReleaseWindow = () => { assert.equal(expired, false, 'expired real admission window'); };
  c.sharedReadOnlyHdBounds = value => { assert.equal(value, f.m); bounds++; return { scanDeadline: Date.now() + 5000, check: c.assertReleaseWindow }; };
  c.recordHdAdmission = (_m, detail) => c.writeJsonExclusive(f.m.stage + '/hd-admission-proof.json', detail);
  c.inspectHdReconciliation = async (_m, args) => {
    assert.equal(typeof args.check, 'function'); args.check(); assert.ok(args.scanDeadline > Date.now());
    return { canEnterControlledDrain: true };
  };
  return { ...f, contract, dependencies, saveManifest, saveContext, dependencyReads: () => dependencyReads,
    expire: () => { expired = true; }, boundsReads: () => bounds };
}
const shared = sharedHarness();
shared.expire(); // Static engineering is not granted (or denied by) a live window.
const sharedBatch = await shared.api.controlPreflight(shared.m);
assert.equal(sharedBatch.completed, true); assert.equal(sharedBatch.outcomes.length, 19);
assert.deepEqual(shared.counts(), { spawnCalls: 19, captures: 0, nativeReads: 0 });
assert.equal(shared.dependencyReads(), 2, 'Common inputs are read once before and once after the whole batch');
assert.equal(shared.files.has(shared.m.stage + '/native-control-preflight/receipt.json'), false);
for (const [index, argv] of shared.spawned.entries()) {
  assert.deepEqual(argv.slice(0, 3), [shared.m.engine.root + '/release-entry.mjs', 'native', shared.m.stage + '/context.json']);
  assert.equal(argv[3], sharedBatch.outcomes[index].file);
}
assert.deepEqual(sharedBatch.outcomes.slice(-2).map(item => item.file), ['attempt-state-engineering.mjs', 'release-entry-engineering.mjs']);
assert.deepEqual(shared.spawned.find(args => args[3] === 'certificate-engineering.mjs').slice(4), [shared.m.engine.root]);
const directFiles = sharedBatch.outcomes.filter(item => !['runtime-source-engineering.mjs', 'canvas-batch-schema-engineering.mjs'].includes(item.file));
const refs = directFiles.map(item => {
  const receipt = shared.m.stage + '/native-control-preflight/' + item.file + '.receipt.json', value = JSON.parse(shared.rootFile(receipt));
  assert.deepEqual(value.controlInput.argv, shared.spawned.find(args => args[3] === item.file));
  assert.equal(value.controlInput.context.sha256, sha(shared.rootFile(shared.m.stage + '/context.json')));
  return { file: item.file, manifest: shared.m.stage + '/manifest.json', manifestSha256: sha(shared.rootFile(shared.m.stage + '/manifest.json')),
    receipt, receiptSha256: sha(shared.rootFile(receipt)), log: value.log.path, logSha256: value.log.sha256 };
});
checks.push('shared_first_batch_executes_19_context_bootstrapped_commands_once_without_claiming_fresh_admission');
await assert.rejects(shared.api.controlAdmission(shared.m), /expired real admission window/);
assert.equal(shared.counts().captures, 0);

const nextShared = () => {
  const f = sharedHarness({ runId: '10000000-0000-4000-8000-000000000002' });
  for (const [file, bytes] of shared.files) if (file.startsWith(shared.m.stage + '/')) f.files.set(file, bytes);
  f.m.controlEvidence = { schema: 'sd2-direct-native-control-evidence.v1', leaves: structuredClone(refs) }; f.saveManifest();
  return f;
};
const resumedShared = nextShared(), savedOriginalTimes = directFiles.map(item => [item.file, item.startedAt, item.finishedAt]);
const resumedBatch = await resumedShared.api.controlPreflight(resumedShared.m);
assert.equal(resumedShared.counts().spawnCalls, 2);
assert.deepEqual(resumedShared.spawned.map(args => args[3]), ['runtime-source-engineering.mjs', 'canvas-batch-schema-engineering.mjs']);
assert.deepEqual(resumedBatch.outcomes.filter(item => item.execution === 'reused').map(item => [item.file, item.startedAt, item.finishedAt]), savedOriginalTimes);
for (const ref of refs) assert.equal(resumedShared.files.has(resumedShared.m.stage + '/native-control-preflight/' + ref.file + '.receipt.json'), false);
await assert.rejects(resumedShared.api.controlAdmission(resumedShared.m), /3302/);
assert.equal(resumedShared.counts().spawnCalls, 2); assert.equal(resumedShared.counts().captures, 1);
resumedShared.admit(); await resumedShared.api.controlAdmission(resumedShared.m);
assert.equal(resumedShared.counts().spawnCalls, 2); assert.equal(resumedShared.boundsReads(), 1);
assert.equal(resumedShared.api.assertControlPreflight(resumedShared.m).completed, true);
checks.push('shared_direct_17_leaves_preserve_original_times_while_manifest_two_and_fresh_admission_really_run');

for (const mutate of [
  f => { f.files.delete(refs[0].receipt); }, f => { f.files.delete(refs[0].log); },
  f => { f.files.set(refs[0].receipt, f.files.get(refs[0].receipt) + ' '); },
  f => { f.files.set(refs[0].log, 'tampered original log'); },
  f => { f.m.controlEvidence.leaves[0].manifestSha256 = '0'.repeat(64); f.saveManifest(); },
  f => { f.m.controlEvidence.leaves[0].receipt = refs[1].receipt; f.saveManifest(); },
  f => { f.contract.protectedIncrement.pricingWrites = true; f.saveContext(); },
  f => { f.contract.unapprovedContextContract = 'drift'; f.saveContext(); },
  f => { f.dependencies.runtime.observedSha256 = sha('changed Node'); },
  f => { f.dependencies.baseline.dependencies.sha256 = sha('changed dependency bytes'); },
  f => { f.dependencies.baseline.dependencies.latestCtimeMs = Date.now() + 1; },
  f => { f.m.controlEvidence.leaves.push({ ...refs[0] }); f.saveManifest(); },
  f => { f.m.controlEvidence.leaves[0].file = 'runtime-source-engineering.mjs'; f.saveManifest(); },
]) {
  const f = nextShared(); mutate(f);
  await assert.rejects(f.api.controlPreflight(f.m)); assert.equal(f.counts().spawnCalls, 0);
}
const failedDirect = nextShared(), ref = failedDirect.m.controlEvidence.leaves[0], invalid = JSON.parse(failedDirect.rootFile(ref.receipt));
invalid.status = 1; failedDirect.files.set(ref.receipt, JSON.stringify(invalid)); ref.receiptSha256 = sha(failedDirect.rootFile(ref.receipt)); failedDirect.saveManifest();
await assert.rejects(failedDirect.api.controlPreflight(failedDirect.m));
assert.equal(failedDirect.counts().spawnCalls, 0);
checks.push('shared_missing_tampered_failed_non_direct_or_drifted_controller_contract_runtime_arguments_and_dependencies_refuse');

const sharedFailure = sharedHarness({ spawnResult: ({ call }) => call === 1 ? { stdout: 'actual isolated failure', stderr: '', status: 9, signal: null } : null });
await assert.rejects(sharedFailure.api.controlPreflight(sharedFailure.m), /Release controller preflight failed/);
assert.equal(sharedFailure.counts().spawnCalls, 19);
const sharedFailureFile = sharedFailure.m.stage + '/native-control-preflight/batch.json', failedBytes = sharedFailure.rootFile(sharedFailureFile);
await assert.rejects(sharedFailure.api.controlPreflight(sharedFailure.m));
assert.deepEqual(sharedFailure.rootFile(sharedFailureFile), failedBytes); assert.equal(sharedFailure.counts().spawnCalls, 19);
const changedDuring = sharedHarness({ spawnResult: ({ call }) => {
  if (call === 19) changedDuring.dependencies.runtime.observedSha256 = sha('changed during batch'); return null;
} });
await assert.rejects(changedDuring.api.controlPreflight(changedDuring.m), error => error.releaseError?.code === 'dependency_changed_during_observation');
assert.equal(changedDuring.counts().spawnCalls, 19);
assert.equal(changedDuring.files.has(changedDuring.m.stage + '/native-control-preflight/receipt.json'), false);
checks.push('shared_failed_or_mid_batch_changed_inputs_never_become_admission_and_original_evidence_is_not_overwritten');

const dependencyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-native-input-tree-'));
try {
  fs.chmodSync(dependencyRoot, 0o700); const input = dependencyRoot + '/input.js'; fs.writeFileSync(input, 'original dependency', { mode: 0o600 });
  const scope = { assert: normalizedAssert, fs, path, sha, Date, throwReleaseError };
  const readerStart = source.indexOf('function sizeLogApplicationFile('), readerEnd = source.indexOf('\nfunction sizeLogRuntimeFile(', readerStart);
  const treeStart = source.indexOf('function dependencyBoundary('), treeEnd = source.indexOf('\nfunction latestDependencyChange(', treeStart);
  vm.runInNewContext(source.slice(readerStart, readerEnd) + '\n' + source.slice(treeStart, treeEnd) + '\nglobalThis.read=sharedDependencyTree;', scope);
  const before = scope.read(dependencyRoot, [0], Date.now() + 1000);
  assert.deepEqual(scope.read(dependencyRoot, [0], Date.now() + 1000), before);
  fs.symlinkSync('input.js', dependencyRoot + '/internal-alias');
  assert.equal(scope.read(dependencyRoot, [0], Date.now() + 1000).count, 3); fs.unlinkSync(dependencyRoot + '/internal-alias');
  fs.writeFileSync(input, 'changed dependency'); assert.notEqual(scope.read(dependencyRoot, [0], Date.now() + 1000).sha256, before.sha256);
  assert.throws(() => scope.read(dependencyRoot, [0], 1));
  fs.chownSync(input, 1005, 1005); assert.throws(() => scope.read(dependencyRoot, [0], Date.now() + 1000)); fs.chownSync(input, 0, 0);
  fs.linkSync(input, dependencyRoot + '/hardlink'); assert.throws(() => scope.read(dependencyRoot, [0], Date.now() + 1000)); fs.unlinkSync(dependencyRoot + '/hardlink');
  fs.symlinkSync('/etc/passwd', dependencyRoot + '/escape'); assert.throws(() => scope.read(dependencyRoot, [0], Date.now() + 1000));
} finally { fs.rmSync(dependencyRoot, { recursive: true, force: true }); }
checks.push('shared_actual_bounded_dependency_reader_binds_bytes_identity_owner_time_and_refuses_hardlinks_or_escaping_aliases');

{
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-sealed-dependencies-'));
  try {
    const runId = '91000000-0000-4000-8000-000000000001', sourceId = 'd'.repeat(40), stage = temporary + '/release-staging/' + runId;
    const appRoot = temporary + '/managed-releases/' + sourceId, dependencyRoot = appRoot + '/node_modules';
    fs.mkdirSync(stage + '/guard', { recursive: true, mode: 0o700 }); fs.mkdirSync(dependencyRoot, { recursive: true, mode: 0o755 });
    const uid = 1004, gid = 1004, generated = dependencyRoot + '/generated-native.bin', lockFile = appRoot + '/package-lock.json';
    fs.writeFileSync(generated, 'original sealed native bytes', { mode: 0o775 }); fs.chmodSync(generated, 0o775); fs.chownSync(generated, uid, gid);
    fs.writeFileSync(lockFile, 'original sealed lock', { mode: 0o644 }); fs.chownSync(lockFile, uid, gid);
    fs.writeFileSync(dependencyRoot + '/empty.js', '', { mode: 0o644 }); fs.chownSync(dependencyRoot + '/empty.js', uid, gid);
    fs.chownSync(dependencyRoot, uid, gid); fs.symlinkSync('generated-native.bin', dependencyRoot + '/internal-alias'); fs.lchownSync(dependencyRoot + '/internal-alias', uid, gid);
    const identity = stat => Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, stat[key]]));
    const entry = file => { const stat = fs.lstatSync(file), value = identity(stat);
      if (stat.isSymbolicLink()) value.link = fs.readlinkSync(file); else if (stat.isFile()) value.sha256 = sha(fs.readFileSync(file)); return value; };
    const dependencies = Object.fromEntries(['.', ...fs.readdirSync(dependencyRoot).sort()].map(relative => [relative, entry(relative === '.' ? dependencyRoot : dependencyRoot + '/' + relative)]));
    const lock = entry(lockFile), original = { runId, stage, appUser: 'fixture-app', privateSha256: {},
      main: { root: temporary + '/managed-releases/' + 'e'.repeat(40) },
      guard: { root: appRoot, source: sourceId, version: '0.1.0', sourceManifest: stage + '/guard/source-manifest.json', archive: stage + '/guard/source.tar.gz' } };
    const originalBytes = JSON.stringify(original); fs.writeFileSync(stage + '/manifest.json', originalBytes, { mode: 0o600 });
    const sourceBytes = JSON.stringify({ source: sourceId, files: { 'package-lock.json': lock.sha256 } });
    fs.writeFileSync(original.guard.sourceManifest, sourceBytes, { mode: 0o600 });
    const startedAt = Math.ceil(Math.max(...Object.values(dependencies).map(value => value.ctimeMs), lock.ctimeMs)) + 1;
    while (Date.now() <= startedAt + 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    const receipt = { schema: 'rate-impl2-candidate-build.v1', runId, label: 'guard', source: sourceId, version: '0.1.0',
      manifestSha256: sha(originalBytes), startedAt, finishedAt: startedAt + 1, exitCode: 0, verifiedSourceAndGates: true };
    const capsule = { schema: 'sd2-immutable-successful-build.v1', kind: 'guard', sourceRun: runId,
      originalManifestSha256: sha(originalBytes), originalSourceManifestSha256: sha(sourceBytes), originalPrivateSha256: {},
      originalReceiptFile: stage + '/guard-build.json', originalReceipt: receipt, originalReceiptSha256: sha(JSON.stringify(receipt)),
      originallyVerifiedWithinThirtyMinuteGate: true, originalTimesChanged: false, newCompilationClaimed: false,
      snapshot: { dependencies, lock, sourceFiles: { 'package-lock.json': lock } } };
    fs.writeFileSync(capsule.originalReceiptFile, JSON.stringify(receipt), { mode: 0o600 });
    const capsuleFile = stage + '/guard-immutable-success.json'; fs.writeFileSync(capsuleFile, JSON.stringify(capsule), { mode: 0o600 });
    const m = { projectRoot: temporary, appUser: 'fixture-app', recoveredGuardBaseline: { runId, manifestSha256: sha(originalBytes),
      guardImmutableSuccessSha256: sha(JSON.stringify(capsule)) }, live: { web: { root: appRoot, source: sourceId },
      hd: { root: appRoot, source: sourceId, sourceProof: { sourceManifest: original.guard.sourceManifest, archive: original.guard.archive } } } };
    let otherMember = false, aclWriter = false, immutable = true, aclReads = 0;
    const call = (binary, args) => {
      if (binary === 'id') return args[0] === '-g' ? String(gid) : String(args[1] === 'extra-writer' ? uid + 1 : uid);
      if (binary === 'getent') return args[0] === 'group' ? `fixture-app:x:${gid}:${otherMember ? 'extra-writer' : ''}`
        : `fixture-app:x:${uid}:${gid}::/nonexistent:/usr/sbin/nologin`;
      if (binary === 'lsattr') return (immutable ? '----i-----' : '----------') + ' ' + args.at(-1);
      assert.equal(binary, '/usr/bin/python3'); assert.deepEqual(args.slice(0, 2), ['-B', '-I']); aclReads++;
      if (aclWriter) return JSON.stringify({ count: Object.keys(dependencies).length, acl: ['generated-native.bin'] });
      return execFileSync(binary, args, { encoding: 'utf8', timeout: 30000 }).trim();
    };
    const scope = { assert: normalizedAssert, fs: { ...fs }, path, sha, Date, call, rootFile, throwReleaseError };
    const applicationStart = source.indexOf('function sizeLogApplicationFile('), applicationEnd = source.indexOf('\nfunction sizeLogRuntimeFile(', applicationStart);
    const start = source.indexOf('function dependencyBoundary('), end = source.indexOf('\nfunction latestDependencyChange(', start);
    assert.ok(start > 0 && end > start);
    vm.runInNewContext(source.slice(applicationStart, applicationEnd) + '\n' + source.slice(start, end)
      + '\nglobalThis.api={sealedDependencyTrust,sharedDependencyTree,readApplicationDependency};', scope);
    const trust = () => scope.api.sealedDependencyTrust(m, dependencyRoot, uid), read = () => scope.api.sharedDependencyTree(dependencyRoot, [0, uid], Date.now() + 1000, trust());
    const accepted = read(); assert.equal(accepted.count, 4); assert.equal(accepted.sealedSource.capsule.sha256, m.recoveredGuardBaseline.guardImmutableSuccessSha256);
    assert.deepEqual(read(), accepted); assert.ok(aclReads >= 2, 'ACL metadata must be freshly observed, not accepted from the old seal');
    assert.throws(() => scope.api.sharedDependencyTree(dependencyRoot, [0, uid], Date.now() + 1000), error => error.releaseError.category === 'input_permanent');
    // The original ordinary app reader remains strict: 775 is not a source-file exception.
    const strict = { assert: normalizedAssert, fs, path };
    vm.runInNewContext(source.slice(applicationStart, applicationEnd) + '\nglobalThis.read=sizeLogApplicationFile;', strict);
    assert.throws(() => strict.read(generated, dependencyRoot, uid));
    for (const change of [
      () => { otherMember = true; return () => { otherMember = false; }; },
      () => { aclWriter = true; return () => { aclWriter = false; }; },
      () => { immutable = false; return () => { immutable = true; }; },
      () => { const old = m.recoveredGuardBaseline.guardImmutableSuccessSha256; m.recoveredGuardBaseline.guardImmutableSuccessSha256 = '0'.repeat(64); return () => { m.recoveredGuardBaseline.guardImmutableSuccessSha256 = old; }; },
      () => { const old = m.recoveredGuardBaseline.manifestSha256; m.recoveredGuardBaseline.manifestSha256 = '0'.repeat(64); return () => { m.recoveredGuardBaseline.manifestSha256 = old; }; },
      () => { fs.renameSync(capsuleFile, capsuleFile + '.held'); return () => fs.renameSync(capsuleFile + '.held', capsuleFile); },
      () => { const old = fs.readFileSync(capsule.originalReceiptFile); fs.appendFileSync(capsule.originalReceiptFile, ' '); return () => fs.writeFileSync(capsule.originalReceiptFile, old); },
      () => { const old = fs.readFileSync(original.guard.sourceManifest); fs.appendFileSync(original.guard.sourceManifest, ' '); return () => fs.writeFileSync(original.guard.sourceManifest, old); },
    ]) { const restore = change(); assert.throws(read); restore(); }
    const saved = m.recoveredGuardBaseline; delete m.recoveredGuardBaseline;
    m.normalContinuation = { sourceRun: runId, sourceManifestSha256: sha(originalBytes) };
    m.reuseBuilds = { sourceRun: runId, guard: { file: capsuleFile, sha256: saved.guardImmutableSuccessSha256 } };
    assert.equal(read().sealedSource.capsule.sha256, saved.guardImmutableSuccessSha256);
    delete m.normalContinuation; delete m.reuseBuilds;
    assert.throws(read, error => error.releaseError.category === 'evidence_missing');
    m.recoveredGuardBaseline = saved;
    const capsuleBytes = fs.readFileSync(capsuleFile), receiptBytes = fs.readFileSync(capsule.originalReceiptFile);
    const compiledCapsule = structuredClone(capsule);
    compiledCapsule.originalReceipt.hdCompiledCache = { file: stage + '/guard-hd-compiled-cache.json', sha256: 'a'.repeat(64) };
    const compiledReceiptBytes = JSON.stringify(compiledCapsule.originalReceipt);
    compiledCapsule.originalReceiptSha256 = sha(compiledReceiptBytes);
    fs.writeFileSync(capsule.originalReceiptFile, compiledReceiptBytes); fs.writeFileSync(capsuleFile, JSON.stringify(compiledCapsule));
    delete m.recoveredGuardBaseline;
    m.live.hd.sourceProof.compiledCapsule = { file: capsuleFile, sha256: sha(JSON.stringify(compiledCapsule)), kind: 'guard', sourceRun: runId };
    assert.equal(read().sealedSource.capsule.sha256, m.live.hd.sourceProof.compiledCapsule.sha256);
    m.live.hd.sourceProof.compiledCapsule.sha256 = '0'.repeat(64); assert.throws(read);
    delete m.live.hd.sourceProof.compiledCapsule; m.recoveredGuardBaseline = saved;
    fs.writeFileSync(capsule.originalReceiptFile, receiptBytes); fs.writeFileSync(capsuleFile, capsuleBytes);
    const originalOpen = scope.fs.openSync;
    scope.fs.openSync = () => { const error = new Error('denied exact dependency'); error.code = 'EACCES'; throw error; };
    assert.throws(() => scope.api.readApplicationDependency(generated, dependencyRoot, fs.lstatSync(generated), dependencies['generated-native.bin']),
      error => error.releaseError.category === 'input_permanent' && error.releaseError.object.id === generated && error.cause.code === 'EACCES'
        && String(error).includes('denied exact dependency') && !error.releaseError.reason.includes('denied exact dependency'));
    scope.fs.openSync = originalOpen;
    const originalFstat = scope.fs.fstatSync; let changedFd = false;
    scope.fs.fstatSync = fd => { const stat = originalFstat(fd); if (changedFd) return { ...stat, ino: stat.ino + 1 }; changedFd = true; return stat; };
    assert.throws(() => scope.api.readApplicationDependency(generated, dependencyRoot, fs.lstatSync(generated), dependencies['generated-native.bin']),
      error => classifyReleaseError(error).category === 'evidence_missing' && error.releaseError.code === 'dependency_changed_during_observation' && error.releaseError.retryable === false);
    scope.fs.fstatSync = originalFstat;
    fs.chmodSync(generated, 0o777); assert.throws(read, error => error.releaseError.category === 'input_permanent'); fs.chmodSync(generated, 0o775);
    assert.throws(read, error => error.releaseError.code === 'dependency_snapshot_mismatch', 'Restored same mode does not restore original identity/time');
    const altered = { ...dependencies['generated-native.bin'], sha256: '0'.repeat(64) };
    assert.throws(() => scope.api.readApplicationDependency(generated, dependencyRoot, fs.lstatSync(generated), altered),
      error => error.releaseError.category === 'input_permanent' && error.releaseError.code === 'dependency_bytes_unsealed');
    fs.appendFileSync(lockFile, ' changed');
    assert.throws(read, error => error.releaseError.code === 'dependency_seal_rejected');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
checks.push('shared_sealed_dependencies_accept_private_app_group_only_with_original_seal_source_lock_receipt_and_fresh_acl_while_rejecting_drift');

console.log(JSON.stringify({ schema: 'sd2-preflight-resume-engineering.v1', completed: true, checks,
  count: checks.length, sourceSha256: { 'control-preflight.mjs': sha(source), 'cutover-safety.mjs': sha(safety),
    'writer-network-fence.mjs': sha(writerFence), 'cutover-safety-engineering.mjs': sha(safetyEngineering) },
  ioKind: 'actual-control-orchestration-with-isolated-memory-io', nativeAdmissionExecuted: false,
  servicesChanged: false, productionWrites: 0, paidRequests: 0, browserRuns: 0, functionalAcceptance: false }));
