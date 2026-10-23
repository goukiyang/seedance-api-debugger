import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { CERTIFICATE, validateRecoveryCertificate } from './certificate.mjs';
import { assertRetainedUploadCertificate } from './raw-upload-recovery-proof.mjs';
import { patchSwitch, oldEarly, newEarly, oldObserve, newObserve, oldState, newState } from './certificate-patch-fixture.mjs';

const originalDirectory = path.resolve(process.argv[2]);
const actual = fs.readFileSync(originalDirectory + '/switch.mjs', 'utf8');
const original = actual.replace("import { inspectRecoveryCertificate } from './certificate.mjs';\n", '')
  .replace(newEarly, oldEarly).replace(newObserve, oldObserve).replace(newState, oldState);
const patched = patchSwitch(original), cases = [];
assert.equal(patched, actual, 'Fixtures must exercise this frozen controller');
const add = name => cases.push({ name, passed: true });
const historical = { schema: 'raw-upload-retired-writer-proof.v1', runId: '36c11143-e1aa-48a4-a801-fe439d2d91ff',
  oldWritersDrained: true, source: 'aa5e1681d5e677ff5fdd96e78eac6fb7e47e6fa4', guardSource: 'fdd5b70722a118c62b67729c399fe1cdc2b8d4fe' };
assertRetainedUploadCertificate(historical); add('historical-certificate-valid-with-independent-current-guard');
for (const field of ['schema', 'runId', 'source', 'guardSource', 'oldWritersDrained']) {
  assert.throws(() => assertRetainedUploadCertificate({ ...historical, [field]: field === 'oldWritersDrained' ? false : 'changed' }));
  add('historical-certificate-original-' + field + '-required');
}
const { guardRecoveryRoute, runGuardRecovery } = await import(pathToFileURL(originalDirectory + '/guard-recovery.mjs'));
const hash = 'a'.repeat(64), state = { identity: ['1', '2'], uid: 0, gid: 0, mode: 0o400,
  sha256: hash, attributes: '----i--------e-------' };
const retained = { state, value: { schema: 'raw-upload-retired-writer-proof.v1', runId: 'previous-run', guardSource: 'previous-guard' } };
const m = { runId: 'current-run', guardSource: 'fixed-guard', expectedProtectedFileSha256: { [CERTIFICATE]: hash } };
const before = { protection: { files: { [CERTIFICATE]: state } } };
const blank = { ...m, expectedProtectedFileSha256: {} }, blankBefore = { protection: { files: {} } };
const inspect = (manifest, captured, options = {}) => validateRecoveryCertificate(manifest, captured, retained, options.phase);

assert.ok(original.includes(oldEarly)); assert.ok(original.includes(oldObserve));
assert.throws(() => new Function('assert', 'exists', oldEarly)(assert, () => true));
add('actual-original-early-branch-rejects-retained-certificate');
assert.throws(() => new Function('assert', 'exists', 'json', 'm', 'verified', oldObserve)(
  assert, () => true, () => retained.value, m, { originalPair: false }));
add('actual-original-fixed-guard-observation-rejects-previous-run-certificate');
new Function('inspectRecoveryCertificate', 'm', 'before', newEarly)(inspect, m, before);
add('patched-early-branch-preserves-exact-captured-certificate');
for (const originalPair of [false, true]) {
  const value = new Function('inspectRecoveryCertificate', 'assert', 'm', 'before', 'verified',
    newObserve + '\nreturn certificateState;')(inspect, assert, m, before, { originalPair });
  assert.equal(value.createdByThisRun, false);
  add('patched-actual-observation-retained-certificate-originalPair-' + originalPair);
}
for (const phase of ['observe', 'early-original']) {
  assert.equal(validateRecoveryCertificate(blank, blankBefore, null, phase).absent, true);
  add('no-certificate-original-behavior-' + phase);
}
for (const [name, mutate] of [
  ['missing', () => null],
  ['bytes', value => { value.state.sha256 = 'b'.repeat(64); return value; }],
  ['inode', value => { value.state.identity[1] = '3'; return value; }],
  ['owner', value => { value.state.uid = 1; return value; }],
  ['mode', value => { value.state.mode = 0o644; return value; }],
  ['immutable', value => { value.state.attributes = '-------------e-------'; return value; }],
  ['schema', value => { value.value.schema = 'wrong'; return value; }],
]) {
  for (const phase of ['observe', 'early-original'])
    assert.throws(() => validateRecoveryCertificate(m, before, mutate(structuredClone(retained)), phase));
  add('retained-certificate-refuses-' + name);
}
assert.throws(() => validateRecoveryCertificate(m, blankBefore, retained));
assert.throws(() => validateRecoveryCertificate(blank, before, retained));
add('refuses-partial-baseline');
const issued = { state, value: { schema: retained.value.schema, runId: m.runId, guardSource: m.guardSource } };
assert.equal(validateRecoveryCertificate(blank, blankBefore, issued).createdByThisRun, true);
assert.throws(() => validateRecoveryCertificate(blank, blankBefore, issued, 'early-original'));
assert.throws(() => validateRecoveryCertificate(blank, blankBefore, retained));
add('new-certificate-still-requires-this-run-and-forbids-original-recovery');
assert.throws(() => new Function('inspectRecoveryCertificate', 'assert', 'm', 'before', 'verified', newObserve)(
  () => ({ createdByThisRun: true }), assert, blank, blankBefore, { originalPair: true }));
add('actual-observation-new-certificate-still-requires-published-pair');

const retainedView = validateRecoveryCertificate(m, before, retained);
const routes = [
  ['early-original', { certificate: retainedView.createdByThisRun, startIntent: false, originalPair: true, fencePhase: 'prepared' }, 'original-before-fence'],
  ['fixed-after-main-start', { certificate: retainedView.createdByThisRun, startIntent: true, originalPair: false, fencePhase: 'restored' }, 'fixed-guard'],
  ['fixed-before-start', { certificate: retainedView.createdByThisRun, startIntent: false, originalPair: false, fencePhase: 'verified' }, 'fixed-guard'],
];
for (const [name, observed, expected] of routes) {
  assert.equal(guardRecoveryRoute(observed), expected);
  const calls = [], fixed = { originalPair: observed.originalPair, value: { guardEntry: { build: 'fixed-build' },
    originalGuardBuild: { startedAt: 1 } } };
  const io = {
    readAdmission: async () => ({ value: fixed.value, originalBuildMayBeOld: true }),
    observe: async () => observed,
    record: async (label, value) => { calls.push('record:' + label); return value; },
    verifyFixedGuard: async () => { calls.push('verifyFixedGuard'); return fixed; },
    restoreOriginal: async () => { calls.push('restoreOriginal'); assert.equal(expected, 'original-before-fence'); return {}; },
  };
  for (const method of ['ensureNoForce', 'restoreOriginalNetwork', 'closeIngress', 'drainKnownProcesses', 'assertAllGone',
    'assertDataContract', 'ensureFixedPair', 'configureGuard', 'actualGuardPrestart', 'restoreGuardNetwork',
    'markGuardStart', 'startGuard', 'restorePolicies', 'openIngress'])
    io[method] = async () => { calls.push(method); return {}; };
  const result = await runGuardRecovery({ m, before, error: new Error('isolated fault') }, io);
  assert.equal(result.completed, true); assert.equal(result.route, expected);
  if (expected === 'fixed-guard') {
    assert.equal(calls.includes('restoreOriginal'), false);
    assert.ok(calls.indexOf('drainKnownProcesses') < calls.indexOf('configureGuard'));
    assert.ok(calls.indexOf('actualGuardPrestart') < calls.indexOf('markGuardStart'));
    assert.ok(calls.indexOf('assertDataContract') < calls.indexOf('startGuard'));
    assert.equal(result.source, m.guardSource);
  } else assert.equal(calls.includes('startGuard'), false);
  add('actual-orchestrator-retained-certificate-' + name);
}
const expectedPatchedBody = original
  .replace(oldEarly, newEarly).replace(oldObserve, newObserve)
  .replace('return { certificate: exists(certificateFile), startIntent: intent, originalPair: verified.originalPair,',
    'return { certificate: certificateState.createdByThisRun, startIntent: intent, originalPair: verified.originalPair,');
const fullReleaseImport = "import { applyFullSchema, publishLegacyReuseWriterProof, readFullLiveSourceFiles } from './full-release-contract.mjs';\n";
const importBoundary = expectedPatchedBody.startsWith(fullReleaseImport) ? fullReleaseImport.length : 0;
assert.equal(patched, expectedPatchedBody.slice(0, importBoundary)
  + "import { inspectRecoveryCertificate } from './certificate.mjs';\n" + expectedPatchedBody.slice(importBoundary));
add('exact-two-certificate-sites-and-derived-route-bit-only');
const sha = b => createHash('sha256').update(b).digest('hex');
console.log(JSON.stringify({ schema: 'recovery-certificate-engineering.v1', completed: true, cases, count: cases.length,
  originalSwitchSha256: sha(original), patchedSwitchSha256: sha(patched),
  productionWrites: 0, servicesChanged: false, rollbackExecuted: false,
  boundary: 'Actual original/changed certificate fragments and unchanged orchestrator with isolated I/O; no online recovery drill' }));
