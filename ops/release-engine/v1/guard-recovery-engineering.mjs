import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { guardRecoveryRoute, runGuardRecovery, inspectFixedGuardArtifact } from './guard-recovery.mjs';
import { createRecoverySafetyFixture } from './cutover-safety-engineering.mjs';
import { normalizeSavedSwitchBefore } from './switch.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const cases = [], add = name => cases.push({ name, passed: true });
const switchSource = fs.readFileSync(new URL('./switch.mjs', import.meta.url), 'utf8');
const vmAssert = { ...assert, deepEqual: (actual, expected, message) => assert.deepEqual(
  JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message) };
{
  const runId = '11111111-1111-4111-8111-111111111111', manifestSha256 = 'd'.repeat(64);
  const saved = { runId, schema: 'rate-impl2-switch-before.v1', manifestSha256,
    protection: { databaseIdentity: ['9', '10'] }, writers: { fixture: true },
    extra: { retained: ['all', 'non-wrapper', 'fields'] }, unknownFutureField: { nested: true } };
  const normalized = normalizeSavedSwitchBefore(saved, runId, manifestSha256);
  const expected = structuredClone(saved); delete expected.runId;
  assert.deepEqual(normalized, expected); assert.deepEqual(Object.keys(normalized).sort(), Object.keys(expected).sort());
  assert.deepEqual(normalized.extra, saved.extra); assert.deepEqual(normalized.unknownFutureField, saved.unknownFutureField);
  assert.throws(() => normalizeSavedSwitchBefore({ ...saved, runId: '22222222-2222-4222-8222-222222222222' }, runId, manifestSha256));
  assert.throws(() => normalizeSavedSwitchBefore({ ...saved, manifestSha256: 'e'.repeat(64) }, runId, manifestSha256));
  assert.throws(() => normalizeSavedSwitchBefore({ ...saved, schema: 'wrong-switch-before-schema' }, runId, manifestSha256));
  add('actual-normalize-removes-only-save-run-id-and-rejects-wrong-binding');
}
const base = { certificate: false, startIntent: false, originalPair: true, fencePhase: null, webStopRequested: false };
for (const [name, value, expected] of [
  ['before-fence', {}, 'original-before-fence'],
  ['prepared-only', { fencePhase: 'prepared' }, 'original-before-fence'],
  ['failed-fence-original-active', { fencePhase: 'failed-keep-fence' }, 'original-after-fence-abort'],
  ['already-restored-prestop-abort', { fencePhase: 'restored', fenceRestorePhase: 'pre-stop-installation-abort' }, 'original-after-fence-abort'],
  ['verified-fence-original-active', { fencePhase: 'verified' }, 'fixed-guard'],
  ['old-web-stopped', { fencePhase: 'verified', webStopRequested: true }, 'fixed-guard'],
  ['new-pair-before-start', { originalPair: false, fencePhase: 'verified', webStopRequested: true }, 'fixed-guard'],
  ['canonical-certificate-before-first-start', { certificate: true, originalPair: false, fencePhase: 'verified' }, 'fixed-guard'],
  ['main-hd-only-started', { startIntent: true, originalPair: false, fencePhase: 'restored' }, 'fixed-guard'],
  ['main-image-only-started', { startIntent: true, originalPair: false, fencePhase: 'restored' }, 'fixed-guard'],
  ['main-web-health-failed', { startIntent: true, originalPair: false, fencePhase: 'restored' }, 'fixed-guard'],
  ['policies-partly-restored', { startIntent: true, originalPair: false, fencePhase: 'restored' }, 'fixed-guard'],
  ['ingress-restoration-failed', { startIntent: true, originalPair: false, fencePhase: 'restored' }, 'fixed-guard'],
  ['unknown-network-install', { fencePhase: 'installing' }, 'reject-unknown-stage'],
  ['unknown-network-restore', { fencePhase: 'restore-unknown-keep-fence' }, 'reject-unknown-stage'],
  ['stop-without-fence-proof', { webStopRequested: true }, 'reject-unknown-stage'],
  ['new-pair-with-missing-fence-record', { originalPair: false }, 'reject-unknown-stage'],
]) {
  const state = { ...base, ...value }; assert.equal(guardRecoveryRoute(state), expected);
  assert.equal(guardRecoveryRoute({ ...state, releaseWindowExpired: true, originalBuildAge: 99999999 }), expected);
  add('route-' + name);
}
const guardSteps = ['readAdmission', 'observe', 'verifyFixedGuard', 'record:begin', 'closeIngress', 'ensureNoForce',
  'drainKnownProcesses', 'assertAllGone', 'assertDataContract', 'verifyFixedGuard', 'ensureFixedPair', 'configureGuard',
  'actualGuardPrestart', 'restoreGuardNetwork', 'assertAllGone', 'verifyFixedGuard', 'markGuardStart', 'startGuard',
  'assertDataContract', 'restorePolicies', 'openIngress', 'assertDataContract', 'record:complete'];
function fixture(fail = null, original = false) {
  const log = [], guardSource = 'b'.repeat(40), context = { m: { runId: 'fixture', guardSource }, before: {}, error: new Error('isolated injected main failure') };
  const fixed = { value: { originalGuardBuild: { startedAt: 1000 }, guardEntry: { build: 'guard-build' } }, originalBuildMayBeOld: true };
  const io = Object.fromEntries([...new Set(guardSteps.filter(value => !value.startsWith('record:')))].map(name => [name, async () => {
    log.push(name); if (name === fail) throw new Error('injected-' + name);
    if (name === 'readAdmission' || name === 'verifyFixedGuard') return fixed;
    if (name === 'observe') return original ? { ...base, fencePhase: 'failed-keep-fence' }
      : { ...base, originalPair: false, startIntent: true, fencePhase: 'restored' };
    if (name === 'startGuard') return { source: guardSource, actualHealthy: true };
    if (name === 'openIngress') return { status: 200 };
    return { completed: true };
  }]));
  io.record = async (name, value) => { log.push('record:' + name); return value; };
  io.restoreOriginalNetwork = async () => { log.push('restoreOriginalNetwork'); };
  io.restoreOriginal = async () => { log.push('restoreOriginal'); return { completed: true, source: 'old' }; };
  return { context, io, log };
}
{
  const f = fixture(); const result = await runGuardRecovery(f.context, f.io);
  assert.deepEqual(f.log, guardSteps); assert.equal(result.originalBuildStartedAt, 1000);
  assert.equal(result.candidateFreshGateClaimed, false); assert.equal(result.originalBuildMayBeOld, true);
  assert.equal(result.source, f.context.m.guardSource); add('same-original-successful-build-is-not-relabeled-fresh');
}
for (const fail of [...new Set(guardSteps.filter(value => !value.startsWith('record:')))]) {
  const f = fixture(fail); await assert.rejects(() => runGuardRecovery(f.context, f.io), new RegExp('injected-' + fail));
  assert.equal(f.log.includes('record:complete'), false);
  if (f.log.indexOf(fail) < guardSteps.indexOf('markGuardStart')) assert.equal(f.log.includes('startGuard'), false);
  if (f.log.indexOf(fail) < guardSteps.indexOf('restorePolicies')) assert.equal(f.log.includes('openIngress'), false);
  add('fault-order-' + fail + '-preserves-remaining-safety');
}
{
  const f = fixture(null, true); const result = await runGuardRecovery(f.context, f.io);
  assert.equal(result.source, 'old'); assert.ok(f.log.includes('restoreOriginalNetwork')); assert.ok(f.log.includes('ensureNoForce'));
  assert.equal(f.log.includes('markGuardStart'), false); assert.equal(f.log.includes('startGuard'), false); add('known-prestop-abort-never-starts-guard-or-main');
}

function actualDrainKnownProcesses(fault, events) {
  const marker = '    drainKnownProcesses: ', start = switchSource.indexOf(marker);
  const end = switchSource.indexOf('\n    assertAllGone:', start);
  assert.ok(start >= 0 && end > start);
  const expression = switchSource.slice(start + marker.length, end).replace(/,\s*$/, '');
  const states = Object.fromEntries(['image', 'hd', 'web'].map(role => [role, {
    MainPID: role === 'image' ? '101' : role === 'hd' ? '102' : '103', ControlPID: '0', ActiveState: 'active', SubState: 'running',
  }]));
  return vm.runInNewContext('(' + expression + ')', {
    m: { fixture: true }, before: { fixture: true }, temporary: { fixture: true },
    check: () => true,
    stopUsageRole: async (_m, check) => { events.push('usage-stop'); check(_m); },
    service: (_m, role) => ({ ...states[role] }),
    stopped: (_m, role) => {
      assert.equal(states[role].MainPID, '0'); assert.equal(states[role].ControlPID, '0');
      assert.ok(['inactive', 'failed'].includes(states[role].ActiveState));
    },
    waitFor: async () => assert.fail('The active-role fixture must use the real natural-stop branch'),
    stopNaturally: async (_m, _before, _temporary, role) => {
      events.push(role + '-stop'); Object.assign(states[role], { MainPID: '0', ControlPID: '0', ActiveState: 'inactive', SubState: 'dead' });
    },
    stopMultiviewWorksForGuardRecovery: async (_m, check) => {
      for (const role of ['image', 'hd', 'web']) assert.equal(states[role].MainPID, '0', 'Works stop must follow all three role drains');
      check(_m); events.push(fault === 'not-empty' ? 'works-not-empty' : 'works-stop');
      if (fault === 'refused') throw new Error('injected-works-refused');
      if (fault === 'not-empty') return { stopped: false, naturalExit: false };
      return { stopped: true, naturalExit: true };
    },
    assert,
  });
}
{
  const events = [], drain = actualDrainKnownProcesses(null, events);
  await drain(); events.push('allGone');
  assert.deepEqual(events, ['usage-stop', 'image-stop', 'hd-stop', 'web-stop', 'works-stop', 'allGone']);
  assert.ok(guardSteps.indexOf('drainKnownProcesses') < guardSteps.indexOf('assertAllGone'));
  add('actual-switch-drain-stops-works-after-three-roles-and-before-all-gone');
}
for (const fault of ['refused', 'not-empty']) {
  const f = fixture(), events = [], drain = actualDrainKnownProcesses(fault, events);
  f.io.drainKnownProcesses = async () => { f.log.push('drainKnownProcesses'); return drain(); };
  if (fault === 'not-empty') f.io.assertAllGone = async () => {
    f.log.push('assertAllGone'); throw new Error('injected-works-not-naturally-empty');
  };
  await assert.rejects(() => runGuardRecovery(f.context, f.io), new RegExp('injected-works-' + (fault === 'refused' ? 'refused' : 'not-naturally-empty')));
  assert.equal(f.log.includes('assertAllGone'), fault === 'not-empty'); assert.equal(f.log.includes('markGuardStart'), false);
  assert.equal(f.log.includes('startGuard'), false); assert.equal(f.log.includes('openIngress'), false);
  add('actual-switch-drain-' + fault + '-blocks-all-later-guard-start-steps');
}

async function nativeAdapterFixture(original = false) {
  const f = createRecoverySafetyFixture();
  const network = { IPAddressAllow: '', IPAddressDeny: '', IPIngressFilterPath: '', IPEgressFilterPath: '' };
  f.before.policies.web = { network };
  const savedBefore = { runId: f.m.runId, ...f.before };
  f.put(f.m.stage + '/switch-before.json', savedBefore);
  f.context.before = normalizeSavedSwitchBefore(savedBefore, f.m.runId, f.before.manifestSha256);
  const s = f.safety(); await s.beforeMaintenance(f.context); f.stop('image'); f.stop('hd');
  if (original) f.state.installFailure = 'known';
  try { await s.installFence(f.context); } catch (error) { if (!original) throw error; }
  if (!original) { f.stop('web'); f.publish(); }
  const fixed = { runId: f.m.runId, manifestSha256: f.before.manifestSha256,
    guardEntry: { source: f.m.guardSource, root: f.m.guard.root, build: f.context.builds.guard.build },
    originalGuardBuild: f.context.builds.guard, onlyOperation: 'recover-this-guard-after-this-run-failure', continueMain: false,
    pair: { allowed: !original ? JSON.parse(Buffer.from(f.adapter.control().allowed.bytesBase64, 'base64')) : {} } };
  f.adapter.recoveryProof = () => ({ value: fixed }); f.adapter.recoveryLockSha256 = () => 'e'.repeat(64);
  f.adapter.network = () => network;
  f.setNow(5_000_000); // Both original five-minute approval and thirty-minute build admission have expired.
  f.context.recoveryOnly = true; f.context.recoveryRoute = original ? 'original' : 'guard';
  if (!original) {
    for (const role of ['web', 'image', 'hd']) f.states[role].WorkingDirectory = f.m.guard.root;
    const cwd = '/etc/systemd/system/sd2-gray.service.d/default01-web.conf';
    f.put(cwd, f.adapter.cwd(f.before, f.m.guard.root));
    f.context.prestart = { schema: 'fixed-guard-recovery-prestart.v1', source: f.m.guardSource,
      build: fixed.guardEntry.build, accepted: ['web', 'image'].map(role => ({ service: f.m.live[role].unit,
        source: f.m.guardSource, build: fixed.guardEntry.build, sourceAndBuildVerified: true, barrierVerified: true })) };
    f.put(f.m.stage + '/guard-recovery-actual-prestart.json', { runId: f.m.runId, manifestSha256: f.before.manifestSha256, ...f.context.prestart });
  }
  return { f, s };
}
for (const original of [true, false]) {
  const { f, s } = await nativeAdapterFixture(original);
  await assert.rejects(() => s.beforeMaintenance(f.context));
  const result = await f.safety().restoreForRecovery(f.context); assert.equal(result.restored, true);
  assert.equal(result.normalPublicationNotAuthorized, true); assert.equal(f.state.calls.restore, 1);
  add('actual-safety-adapter-expired-original-approval-restores-' + (original ? 'original-known-abort' : 'fixed-guard-only'));
}
{
  const { f } = await nativeAdapterFixture();
  f.context.before = { ...f.context.before, changedNonWrapperField: true };
  await assert.rejects(() => f.safety().restoreForRecovery(f.context));
  assert.equal(f.state.calls.restore, 0); add('actual-safety-check-before-rejects-non-run-id-change-after-normalize');
}
for (const [name, mutate] of [
  ['original-pid-alive', f => f.pids.add(101)],
  ['wrong-fixed-guard', f => { f.context.prestart.source = f.m.mainSource; f.put(f.m.stage + '/guard-recovery-actual-prestart.json',
    { runId: f.m.runId, manifestSha256: f.before.manifestSha256, ...f.context.prestart }); }],
  ['missing-original-stop-intent', f => f.files.delete(f.m.stage + '/natural-stop-intent-switch-web.json')],
  ['main-cwd-instead-of-guard', f => { f.states.web.WorkingDirectory = f.m.main.root; }],
  ['new-writer-start-latch-before-network-restore', f => f.put('/data/video-api-debugger/controls/pricing-writer-v1/start-' + f.m.runId + '.json', {})],
  ['new-writer-live', f => f.startNew()],
]) {
  const { f } = await nativeAdapterFixture(); mutate(f);
  await assert.rejects(() => f.safety().restoreForRecovery(f.context)); assert.equal(f.state.calls.restore, 0); add('actual-adapter-rejects-' + name);
}

function actualSwitchFunction(startMarker, endMarker, bindings) {
  const start = switchSource.indexOf(startMarker), end = switchSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'Missing actual switch function: ' + startMarker);
  return vm.runInNewContext('(' + switchSource.slice(start, end).replace(/^export /, '') + ')', bindings);
}
async function standaloneRecoveryCase(name, options = {}) {
  const stage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-switch-' + name + '-')));
  fs.chmodSync(stage, 0o700);
  const runId = '11111111-1111-4111-8111-111111111111', manifestSha256 = 'f'.repeat(64);
  const m = { runId, stage }, lockFile = stage + '/.switch.lock';
  const saved = { runId, schema: 'rate-impl2-switch-before.v1', manifestSha256,
    protection: { databaseIdentity: ['9', '10'] }, writers: { preserved: true }, extra: { retained: true } };
  const savedFile = stage + '/switch-before.json'; fs.writeFileSync(savedFile, JSON.stringify(saved) + '\n', { mode: 0o600 });
  const originalOwner = { pid: 424242, token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    runId: options.wrongRun ? '22222222-2222-4222-8222-222222222222' : runId };
  fs.writeFileSync(lockFile, JSON.stringify(originalOwner) + '\n', { mode: 0o600 });
  const events = [], live = new Set(options.liveOwner ? [originalOwner.pid] : []);
  let lockSnapshots = 0, recoveryCalls = 0, uuid = 0;
  const nextUuid = () => '00000000-0000-4000-8000-' + String(++uuid).padStart(12, '0');
  const exists = file => {
    if (file.startsWith('/proc/')) return live.has(Number(path.basename(file)));
    try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  const rootSnapshot = file => {
    const bytes = fs.readFileSync(file), state = fs.lstatSync(file);
    const value = { file, dev: String(state.dev), ino: String(state.ino), uid: state.uid, gid: state.gid,
      mode: state.mode & 0o7777, nlink: state.nlink, sha256: sha(bytes), bytesBase64: bytes.toString('base64') };
    if (file === lockFile && lockSnapshots++ === 0) {
      events.push('snapshot-original-lock');
      if (options.drift === 'bytes') fs.writeFileSync(file, JSON.stringify({ ...originalOwner, changed: true }) + '\n');
      if (options.drift === 'identity') {
        fs.renameSync(file, file + '.drift-original'); fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
      }
    }
    return value;
  };
  const writeJsonExclusive = (file, value) => {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); return file;
  };
  const save = (_m, recordName, value) => {
    assert.equal(_m, m); events.push('save:' + recordName);
    const file = stage + '/' + recordName + '.json'; writeJsonExclusive(file, { runId, ...value });
    if (options.archiveCompetition && recordName.startsWith('standalone-recovery-retained-lock-')) {
      writeJsonExclusive(lockFile, { pid: 515151, token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', runId });
      events.push('archive-lock-competition');
    }
    return file;
  };
  const locked = actualSwitchFunction('async function locked(', '\n\n// No import-time operations', {
    assert: vmAssert, fs, process, randomUUID: nextUuid, writeJsonExclusive, rootSnapshot,
  });
  const recoverFailedSwitch = async (_m, input) => {
    recoveryCalls++; events.push('recover'); assert.equal(_m, m); assert.equal(input.alreadyLocked, true);
    assert.deepEqual(JSON.parse(JSON.stringify(input.before)), JSON.parse(JSON.stringify(normalizeSavedSwitchBefore(saved, runId, manifestSha256))));
    const owned = JSON.parse(fs.readFileSync(lockFile)); assert.equal(owned.pid, process.pid); assert.equal(owned.runId, runId);
    assert.match(owned.token, /^[a-f0-9-]{36}$/);
    const retained = fs.readdirSync(stage).filter(file => file.startsWith('.switch.lock.retained-'));
    assert.equal(retained.length, 1); assert.deepEqual(JSON.parse(fs.readFileSync(stage + '/' + retained[0])), originalOwner);
    return { recovered: true, fixedGuardOnly: true };
  };
  const recover = actualSwitchFunction('export async function recoverStandaloneSwitch(', '\n\nexport async function recoverFailedSwitch(', {
    assert: vmAssert, fs, Buffer, process, randomUUID: nextUuid, sha, rootFile: file => fs.readFileSync(file), exists, rootSnapshot, save, locked,
    context: _m => { assert.equal(_m, m); return { manifestSha256 }; },
    boundRecord: (_m, recordName, digest) => {
      assert.equal(_m, m); assert.equal(recordName, 'switch-before'); assert.equal(digest, manifestSha256);
      return JSON.parse(fs.readFileSync(savedFile));
    },
    normalizeSavedSwitchBefore,
    readGuardRecovery: _m => {
      assert.equal(_m, m); events.push('fixed-guard-verified');
      if (options.guardReject) throw new Error('fixed-guard-refused');
      return { fixedGuard: true };
    },
    recoverFailedSwitch,
  });
  try {
    const input = { before: normalizeSavedSwitchBefore(saved, runId, manifestSha256) };
    if (options.reject) await assert.rejects(() => recover(m, input), options.reject);
    else assert.deepEqual(await recover(m, input), { recovered: true, fixedGuardOnly: true });
    assert.equal(recoveryCalls, options.reject ? 0 : 1);
    assert.equal(events[0], 'fixed-guard-verified', 'The fixed guard must be verified before the original lock is inspected');
    const retained = fs.readdirSync(stage).filter(file => file.startsWith('.switch.lock.retained-'));
    if (options.expectRetained || !options.reject) assert.equal(retained.length, 1);
    else assert.equal(retained.length, 0, 'A rejected recovery must not archive an unapproved or drifting lock');
    if (options.expectOriginalLock) assert.deepEqual(JSON.parse(fs.readFileSync(lockFile)), originalOwner);
    if (options.expectRetained) assert.equal(exists(lockFile), true, 'The competing wx lock must be preserved');
    if (!options.reject) {
      assert.equal(exists(lockFile), false, 'The owned recovery lock must be released without deleting retained evidence');
      assert.ok(events.indexOf('snapshot-original-lock') < events.indexOf('recover'));
    }
    add('actual-standalone-recovery-' + name);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
await standaloneRecoveryCase('dead-owner-retains-original-and-recovers-under-owned-wx-lock');
await standaloneRecoveryCase('fixed-guard-rejection-preserves-original-lock', {
  guardReject: true, expectOriginalLock: true, reject: /fixed-guard-refused/,
});
await standaloneRecoveryCase('live-owner-rejected-without-recovery', {
  liveOwner: true, expectOriginalLock: true, reject: /still alive/,
});
await standaloneRecoveryCase('wrong-run-lock-rejected-without-recovery', {
  wrongRun: true, expectOriginalLock: true, reject: error => error?.code === 'ERR_ASSERTION',
});
await standaloneRecoveryCase('lock-byte-drift-rejected-without-recovery', { drift: 'bytes', reject: error => error?.code === 'ERR_ASSERTION' });
await standaloneRecoveryCase('lock-identity-drift-rejected-without-recovery', { drift: 'identity', reject: error => error?.code === 'ERR_ASSERTION' });
await standaloneRecoveryCase('archive-wx-competition-rejected-without-recovery', {
  archiveCompetition: true, expectRetained: true, reject: error => error?.code === 'EEXIST',
});

export function runGuardArtifactFileEngineering(directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-fixed-guard-'))) {
  directory = fs.realpathSync(directory);
  const entry = { root: directory, source: 'a'.repeat(40), version: '0.99.4+fixture', build: 'fixture-build', sourceFiles: {}, buildFiles: {} };
  const put = (relative, bytes, target) => { const file = path.join(directory, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o644 }); if (target) target[relative] = sha(bytes); return file; };
  fs.mkdirSync(directory + '/node_modules');
  put('.deployed-commit', entry.source + '\n'); put('package.json', JSON.stringify({ version: entry.version }), entry.sourceFiles);
  for (let i = 0; i < 101; i++) put('src/file-' + i + '.ts', 'export const value=' + i + ';\n', entry.sourceFiles);
  for (let i = 0; i < 11; i++) { const file = 'server/file-' + i + '.js'; const bytes = 'module.exports=' + i + ';\n';
    put('.next-prod-candidate/' + file, bytes); entry.buildFiles[file] = sha(bytes); }
  put('.next-prod-candidate/BUILD_ID', entry.build + '\n'); entry.buildFiles.BUILD_ID = sha(entry.build + '\n');
  fs.symlinkSync('.next-prod-candidate', directory + '/.next-prod');
  const expected = inspectFixedGuardArtifact(entry), results = ['actual-files-and-resource-bytes-captured'];
  assert.deepEqual(inspectFixedGuardArtifact(entry), expected); results.push('unchanged-actual-artifact-reused-without-compilation');
  const changed = directory + '/src/file-1.ts', bytes = fs.readFileSync(changed);
  fs.appendFileSync(changed, 'changed'); assert.throws(() => inspectFixedGuardArtifact(entry)); fs.writeFileSync(changed, bytes); results.push('changed-source-rejected');
  fs.chmodSync(changed, 0o666); assert.throws(() => inspectFixedGuardArtifact(entry)); fs.chmodSync(changed, 0o644); results.push('widened-permissions-rejected');
  const resource = directory + '/.next-prod-candidate/server/file-1.js', original = fs.readFileSync(resource);
  fs.appendFileSync(resource, 'changed'); assert.throws(() => inspectFixedGuardArtifact(entry)); fs.writeFileSync(resource, original); results.push('changed-resource-rejected');
  fs.writeFileSync(directory + '/.next-prod-candidate/BUILD_ID', 'wrong'); assert.throws(() => inspectFixedGuardArtifact(entry)); results.push('wrong-build-rejected');
  return { directory, results, productionWrites: 0, serviceCalls: 0, browserRuns: 0, completeBuildExecuted: false };
}
const filesystem = runGuardArtifactFileEngineering();
const sourceDigests = Object.fromEntries(['guard-recovery.mjs', 'switch.mjs', 'cutover-safety.mjs', 'cutover-driver.mjs', 'pricing-start-pair.mjs', 'release.mjs']
  .map(name => [name, sha(fs.readFileSync(new URL(name, import.meta.url)))]));
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(JSON.stringify({
  schema: 'batch-fixed-guard-fault-matrix.v1', completed: true, cases, count: cases.length, filesystem, sourceDigests,
  productionWrites: 0, serviceCalls: 0, networkRequests: 0, browserRuns: 0,
  boundary: 'Actual orchestrator/adapter/pure native restore gates and real isolated artifact files; not a production rollback drill or functional acceptance',
}) + '\n');
