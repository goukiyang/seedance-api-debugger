import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { call, rootFile, sha, unit, writeJsonExclusive, assertReleaseWindow, liveArtifactSource } from './common.mjs';
import { candidateEvidenceFile, operationalLive, operationalBeforeFile, operationalRecordName } from './candidate-evidence.mjs';
import { readMigrationEvidence } from './normal-continuation.mjs';
import { assertPriorUsageRoleControl, priorUsageRoleControl } from './deployed-usage-schema.mjs';

const NAME = 'sd2-role-coordinator.service';
const CONTROL = '/data/video-api-debugger/controls/usage-role-writer-v1';
const SOURCE = '/etc/systemd/system/' + NAME + '.d/admin-usage-source.conf';
const RUNTIME = '/data/video-api-debugger/role-coordinator/runtime.json';
const FIELDS = ['User', 'Restart', 'RestartUSec', 'KillMode', 'KillSignal', 'SendSIGKILL', 'TimeoutStopUSec',
  'TasksMax', 'FragmentPath', 'DropInPaths', 'ControlGroup', 'ExecMainPID', 'ExecMainCode', 'ExecMainStatus'];
const exists = file => fs.existsSync(file);
function directory(file) {
  fs.mkdirSync(file, { recursive: true, mode: 0o755 });
  assert.equal(fs.realpathSync(file), file);
  const s = fs.lstatSync(file); assert.ok(s.isDirectory() && s.uid === 0 && !(s.mode & 0o022));
}
function syncDirectory(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeProgram(file, bytes) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}
const json = file => JSON.parse(rootFile(file));
const bound = (m, value) => {
  assert.equal(value.runId, m.runId); assert.equal(value.manifestSha256, sha(rootFile(m.stage + '/manifest.json')));
  return value;
};
const baseline = m => { const live = operationalLive(m, 'role'); return { pid: String(live.pid), invocation: live.invocation, root: live.root }; };
function state() {
  const more = Object.fromEntries(call('systemctl', ['show', '--all', NAME, ...FIELDS.flatMap(key => ['-p', key])]).split('\n')
    .map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  for (const field of FIELDS) assert.ok(Object.hasOwn(more, field));
  return { ...unit(NAME), ...more };
}
function opaqueFile(file) {
  assert.equal(fs.realpathSync(file), file);
  const s = fs.lstatSync(file);
  assert.ok(s.isFile() && s.nlink === 1 && s.uid === 0 && !(s.mode & 0o022));
  // Hash the real unit without reading or returning any environment values.
  const digest = call('sha256sum', ['--', file]).split(/\s+/)[0];
  assert.match(digest, /^[a-f0-9]{64}$/);
  return { file, dev: String(s.dev), ino: String(s.ino), mode: s.mode & 0o7777, sha256: digest };
}
function groupPids(group) {
  assert.ok(group.startsWith('/system.slice/') && !group.includes('..'));
  const root = '/sys/fs/cgroup' + group;
  if (!exists(root)) return [];
  const result = new Set();
  const visit = directory => {
    for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, file.name);
      if (file.isDirectory()) visit(target);
      else if (file.name === 'cgroup.procs') for (const pid of fs.readFileSync(target, 'utf8').trim().split(/\s+/).filter(Boolean)) result.add(Number(pid));
    }
  };
  visit(root); return [...result].sort((a, b) => a - b);
}
function runtime(root, expectedHashes, current) {
  const s = fs.lstatSync(RUNTIME);
  assert.ok(s.isFile() && !s.isSymbolicLink() && s.size < 65536 && !(s.mode & 0o077));
  const value = JSON.parse(fs.readFileSync(RUNTIME));
  assert.equal(value.protocol, 'role.collaboration.v2'); assert.equal(value.state, 'active');
  assert.equal(value.pid, Number(current.MainPID)); assert.equal(value.sourceRoot, root);
  assert.ok(Date.now() - Date.parse(value.heartbeatAt) >= -1000 && Date.now() - Date.parse(value.heartbeatAt) < 45000);
  assert.deepEqual(value.loadedModuleSha, expectedHashes);
  return { pid: value.pid, sourceRoot: value.sourceRoot, version: value.version, startedAt: value.startedAt,
    heartbeatAt: value.heartbeatAt, loadedModuleSha: value.loadedModuleSha };
}
function runtimeFiles(root, attribution) {
  return ['scripts/canvas-role-coordinator.ts', 'prisma/schema.prisma', 'src/lib/canvas-documents.ts',
    ...(attribution ? ['src/lib/admin/usage-attribution.ts'] : []),
    ...fs.readdirSync(root + '/src/lib/canvas-roles').filter(file => file.endsWith('.ts')).sort().map(file => 'src/lib/canvas-roles/' + file)];
}
function fileHashes(root, files) { return Object.fromEntries(files.map(file => [file, sha(fs.readFileSync(root + '/' + file))])); }
function originalCapture(m, expected = operationalLive(m, 'role')) {
  if (m.deployedUsageSchema) assertPriorUsageRoleControl(m);
  const v = state();
  assert.equal(v.User, m.appUser); assert.equal(v.TasksMax, '128'); assert.equal(v.KillSignal, '15');
  assert.ok(['mixed', 'control-group'].includes(v.KillMode));
  assert.equal(v.ActiveState, 'active'); assert.equal(v.SubState, 'running'); assert.equal(v.ControlPID, '0');
  assert.equal(Number(v.MainPID), expected.pid); assert.equal(v.InvocationID, expected.invocation);
  assert.equal(fs.realpathSync(v.WorkingDirectory), m.live.role.root);
  assert.equal(fs.realpathSync('/proc/' + v.MainPID + '/cwd'), m.live.role.root);
  assert.equal(liveArtifactSource(m.live.role.root), m.live.role.source);
  const hasAttribution = exists(m.live.role.root + '/src/lib/admin/usage-attribution.ts');
  const loadedModuleSha = fileHashes(m.live.role.root, runtimeFiles(m.live.role.root, hasAttribution));
  return { state: v, fragment: opaqueFile(v.FragmentPath),
    dropins: v.DropInPaths.split(/\s+/).filter(Boolean).map(opaqueFile),
    runtime: runtime(m.live.role.root, loadedModuleSha, v), loadedModuleSha };
}
export function captureUsageRole(m) { return originalCapture(m); }
export function captureRestoredUsageRole(m, identity) {
  assert.ok(m.fullRelease && m.privateMultiviewInstall && !m.protectedIncrement);
  for (const key of ['unit', 'root', 'source', 'version', 'build']) assert.equal(identity[key], m.live.role[key]);
  assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 1); assert.match(identity.invocation, /^[a-f0-9]{32}$/);
  const captured = originalCapture(m, identity), after = state();
  assert.equal(Number(after.MainPID), identity.pid); assert.equal(after.InvocationID, identity.invocation);
  assert.equal(after.ExecMainStartTimestampMonotonic, identity.execMainStartTimestampMonotonic);
  return captured;
}

function before(m) {
  const value = bound(m, json(operationalBeforeFile(m)));
  assert.ok(value.roleControl); return value.roleControl;
}
function roleJournalFile(m, sequence) { return operationalRecordName(m, 'usage-role-transition-' + String(sequence).padStart(4, '0')) + '.json'; }
function journals(m) {
  const files = fs.readdirSync(m.stage).filter(file => /^usage-role-transition-\d{4}(?:-[a-f0-9]{64})?\.json$/.test(file)
    && file === roleJournalFile(m, Number(file.slice('usage-role-transition-'.length, 'usage-role-transition-'.length + 4)))).sort();
  return files.map((file, index) => {
    const value = bound(m, json(m.stage + '/' + file));
    assert.equal(value.sequence, index + 1);
    assert.equal(value.previousSha256, index ? sha(rootFile(m.stage + '/' + files[index - 1])) : null);
    return value;
  });
}
function record(m, phase, value = {}) {
  const previous = journals(m), sequence = previous.length + 1;
  assert.ok(sequence < 1000);
  const entry = { runId: m.runId, manifestSha256: sha(rootFile(m.stage + '/manifest.json')), sequence,
    previousSha256: previous.length ? sha(rootFile(m.stage + '/' + roleJournalFile(m, sequence - 1))) : null,
    at: new Date().toISOString(), phase, ...value };
  writeJsonExclusive(m.stage + '/' + roleJournalFile(m, sequence), entry);
  return entry;
}
function noForce(m) { return '/run/systemd/system/' + NAME + '.d/admin-usage-' + m.runId + '.conf'; }
function noForceBytes(m) { return Buffer.from('# Usage writer natural drain ' + m.runId + '\n[Service]\nRestart=no\nKillSignal=SIGTERM\nSendSIGKILL=no\nTimeoutStopSec=infinity\n'); }
function assertPolicy(m, captured, current) {
  assert.deepEqual(opaqueFile(current.FragmentPath), captured.fragment);
  assert.equal(current.User, captured.state.User); assert.equal(current.TasksMax, '128');
  assert.equal(current.KillMode, captured.state.KillMode); assert.equal(current.KillSignal, '15');
  assert.equal(current.RestartUSec, captured.state.RestartUSec);
  const original = captured.dropins.map(file => file.file), paths = current.DropInPaths.split(/\s+/).filter(Boolean);
  assert.ok(paths.every(file => original.includes(file) || file === SOURCE || file === noForce(m)));
  for (const file of captured.dropins) {
    if (m.deployedUsageSchema && file.file === SOURCE
      && journals(m).some(entry => entry.phase === 'control-intent')) {
      assert.ok(['main', 'guard'].some(kind => rootFile(SOURCE).equals(sourceBytes(m, kind)))
        || rootFile(SOURCE).equals(priorUsageRoleControl(m).source), 'Unreviewed existing role source replacement');
    } else assert.deepEqual(opaqueFile(file.file), file);
  }
  if (paths.includes(noForce(m))) {
    assert.equal(sha(rootFile(noForce(m))), sha(noForceBytes(m)));
    assert.equal(current.Restart, 'no'); assert.equal(current.SendSIGKILL, 'no'); assert.equal(current.TimeoutStopUSec, 'infinity');
  } else for (const key of ['Restart', 'SendSIGKILL', 'TimeoutStopUSec']) assert.equal(current[key], captured.state[key]);
  if (paths.includes(SOURCE)) {
    const text = rootFile(SOURCE).toString();
    assert.ok(['main', 'guard'].some(kind => text === sourceBytes(m, kind).toString())
      || m.deployedUsageSchema && text === priorUsageRoleControl(m).source.toString(), 'Unreviewed role startup configuration');
  }
}
function sourceBytes(m, kind) {
  return Buffer.from('# Usage origin writer ' + m.runId + '\n[Service]\nWorkingDirectory=' + m[kind].root
    + '\nExecStartPre=/usr/bin/node ' + CONTROL + '/start.mjs\n');
}
export function assertUsageRoleExit(current, stopped, observed) {
  assert.equal(current.MainPID, '0'); assert.equal(current.ControlPID, '0');
  assert.ok(stopped.allowFailed ? ['inactive', 'failed'].includes(current.ActiveState) : current.ActiveState === 'inactive');
  if (!stopped.allowFailed) { assert.equal(current.Result, 'success'); assert.equal(current.ExecMainStatus, '0'); }
  assert.equal(current.ExecMainCode, '1', 'A signalled or force-killed writer is not a natural exit');
  assert.equal(observed.pidPresent, false);
  assert.deepEqual(observed.originalGroupPids, []); assert.deepEqual(observed.unitGroupPids, []);
}
function assertGone(current, stopped) {
  assertUsageRoleExit(current, stopped, { pidPresent: exists('/proc/' + stopped.MainPID),
    originalGroupPids: groupPids(stopped.ControlGroup || '/system.slice/' + NAME), unitGroupPids: groupPids('/system.slice/' + NAME) });
}
function assertRunning(m, captured, current, kind, expectedInvocation) {
  const root = kind === 'original' ? m.live.role.root : m[kind].root;
  assertPolicy(m, captured, current);
  assert.equal(current.ActiveState, 'active'); assert.equal(current.SubState, 'running'); assert.equal(current.ControlPID, '0');
  assert.ok(Number(current.MainPID) > 1); assert.match(current.InvocationID, /^[a-f0-9]{32}$/);
  if (expectedInvocation) assert.equal(current.InvocationID, expectedInvocation);
  assert.equal(fs.realpathSync(current.WorkingDirectory), root); assert.equal(fs.realpathSync('/proc/' + current.MainPID + '/cwd'), root);
  assert.equal(liveArtifactSource(root), kind === 'original' ? m.live.role.source : m[kind].source);
  const hashes = kind === 'original' ? captured.loadedModuleSha : fileHashes(root, runtimeFiles(root, true));
  const loaded = runtime(root, hashes, current);
  assert.equal(loaded.version, kind === 'original' ? m.live.role.version : m[kind].version);
  return loaded;
}
export function inspectUsageRoleProtection(m) {
  const entries = journals(m);
  if (!entries.length) { originalCapture(m); return baseline(m); }
  const captured = before(m), last = entries.at(-1), current = state();
  assertPolicy(m, captured, current);
  if (last.phase === 'stopped' || last.phase === 'control-intent') assertGone(current, last.stopping);
  else if (last.phase === 'start-failed') {
    assert.equal(current.InvocationID, last.current.InvocationID);
    assertGone(current, { ...last.current, MainPID: last.current.ExecMainPID, allowFailed: true });
  }
  else if (last.phase === 'policy-intent') {
    assert.equal(current.MainPID, last.current.MainPID);
    assertRunning(m, captured, current, last.kind, last.current.InvocationID);
  }
  else if (last.phase === 'stop-intent') {
    if (current.MainPID === '0') assertGone(current, last.stopping);
    else {
      assert.equal(current.MainPID, last.stopping.MainPID); assert.equal(current.InvocationID, last.stopping.InvocationID);
      assert.ok(['active', 'deactivating'].includes(current.ActiveState));
    }
  } else if (last.phase === 'start-intent') {
    assert.ok(['inactive', 'activating', 'active'].includes(current.ActiveState));
    if (Number(current.MainPID) > 1) assertRunning(m, captured, current, last.kind);
  } else {
    assert.equal(last.phase, 'active');
    assert.equal(current.MainPID, last.current.MainPID);
    assertRunning(m, captured, current, last.kind, last.current.InvocationID);
  }
  // Preserve the comparable baseline while independently enforcing every real
  // role transition above. The final proof includes the actual new invocation.
  return baseline(m);
}
async function waitFor(check, predicate, message) {
  const until = Date.now() + 120000;
  while (true) {
    check(); if (predicate()) return;
    if (Date.now() > until) { const error = new Error(message); error.code = 'NATURAL_STOP_PENDING'; throw error; }
    await pause(500);
  }
}
export async function stopUsageRole(m, check = () => assertReleaseWindow(m)) {
  const captured = before(m), current = state(), entries = journals(m), last = entries.at(-1);
  if (current.MainPID === '0') {
    assert.ok(last && ['stop-intent', 'stopped', 'start-failed', 'start-intent', 'control-intent'].includes(last.phase));
    let stopping = last.phase === 'start-failed' ? { ...last.current, MainPID: last.current.ExecMainPID, allowFailed: true } : last.stopping;
    if (last.phase === 'start-intent') {
      const previous = entries.filter(entry => entry.phase === 'stopped').at(-1); assert.ok(previous);
      if (current.InvocationID === previous.stopping.InvocationID) stopping = previous.stopping;
      else {
        assert.equal(fs.realpathSync(current.WorkingDirectory), m[last.kind].root);
        assert.ok(Number(current.ExecMainPID) > 1);
        stopping = { ...current, MainPID: current.ExecMainPID, allowFailed: true };
      }
    }
    assertGone(current, stopping);
    if (last.phase !== 'stopped') record(m, 'stopped', { stopping });
    return;
  }
  let kind = 'original';
  if (last && ['active', 'start-intent', 'policy-intent'].includes(last.phase)) kind = last.kind;
  if (last?.phase === 'stop-intent') {
    assert.equal(current.MainPID, last.stopping.MainPID); assert.equal(current.InvocationID, last.stopping.InvocationID);
  } else assertRunning(m, captured, current, kind, last?.current?.InvocationID || captured.state.InvocationID);
  check();
  const temporary = noForce(m);
  if (!exists(temporary)) {
    record(m, 'policy-intent', { kind, current });
    directory(path.dirname(temporary));
    writeProgram(temporary, noForceBytes(m));
    call('systemctl', ['daemon-reload']);
  }
  const protectedState = state(); assertPolicy(m, captured, protectedState);
  assert.equal(protectedState.MainPID, current.MainPID); assert.equal(protectedState.InvocationID, current.InvocationID);
  const stopping = last?.phase === 'stop-intent' ? last.stopping : protectedState;
  if (last?.phase !== 'stop-intent') record(m, 'stop-intent', { kind, stopping });
  check(); call('systemctl', ['stop', '--no-block', NAME]);
  await waitFor(check, () => state().MainPID === '0' && state().ControlPID === '0', 'Role writer natural stop remains pending; never force kill');
  assertGone(state(), stopping); record(m, 'stopped', { stopping });
}
export function assertUsageRoleStopped(m) {
  const last = journals(m).at(-1);
  assert.ok(last?.phase === 'stopped' || m.deployedUsageSchema && last?.phase === 'control-intent');
  assertGone(state(), last.stopping);
}
function replaceOwned(file, bytes, mode = 0o644) {
  const temporary = file + '.next-' + process.pid;
  fs.writeFileSync(temporary, bytes, { flag: 'wx', mode });
  const fd = fs.openSync(temporary, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  syncDirectory(path.dirname(file));
}
function roleStartContract(m) {
  const receipt = readMigrationEvidence(m);
  if (!m.normalContinuation || m.deployedUsageSchema) bound(m, receipt);
  assert.equal(receipt.schema, m.deployedUsageSchema ? 'sd2-deployed-usage-schema-adopt.v1' : 'sd2-usage-attribution-migration.v1');
  assert.equal(receipt.completed, true);
  assert.equal(receipt.source, m.mainSource); assert.equal(receipt.guardSource, m.guardSource);
  assert.equal(receipt.historyBackfilled, false); assert.equal(receipt.businessRowsWritten, 0);
  const appUid = Number(call('id', ['-u', m.appUser]));
  const releases = ['main', 'guard'].map(kind => {
    const root = m[kind].root;
    const built = bound(m, json(candidateEvidenceFile(m, kind)));
    assert.equal(built.exitCode, 0); assert.equal(built.source, m[kind].source); assert.equal(built.verifiedSourceAndGates, true);
    const files = [...runtimeFiles(root, true), 'src/lib/admin/usage-types.ts', 'src/lib/prisma.ts', 'ops/sd2-usage-role-start.mjs',
      ...(m.canvasVideoBatchSchema ? ['src/lib/canvas-video-batches-guards.ts', 'src/lib/canvas-video-batch-contract.ts',
        'src/lib/canvas-video-batches-build-mode.ts'] : [])];
    return { root, source: m[kind].source, version: m[kind].version, build: built.build, sourceSha256: fileHashes(root, files) };
  });
  const moduleBytes = fs.readFileSync(m.main.root + '/ops/sd2-usage-role-start.mjs');
  assert.deepEqual(moduleBytes, fs.readFileSync(m.guard.root + '/ops/sd2-usage-role-start.mjs'));
  assert.deepEqual(moduleBytes, fs.readFileSync(path.dirname(fileURLToPath(import.meta.url)) + '/usage-role-start.mjs'));
  return { moduleBytes, contract: { schema: 'sd2-usage-role-start.v1', runId: m.runId, appUid, schemaSha256: receipt.newSchemaSha256, releases } };
}
export function inspectUsageRoleAdmission(m) {
  const original = captureUsageRole(m), { contract, moduleBytes } = roleStartContract(m);
  const accepted = ['main', 'guard'].map(kind => {
    const code = 'import {observeUsageRoleStart} from ' + JSON.stringify(m[kind].root + '/ops/sd2-usage-role-start.mjs')
      + ';console.log(JSON.stringify(observeUsageRoleStart(JSON.parse(process.argv[1]))));';
    const value = JSON.parse(call('runuser', ['-u', m.appUser, '--', 'env', '-i', 'PATH=/usr/bin:/bin',
      '/usr/bin/node', '--input-type=module', '-e', code, JSON.stringify(contract)], { cwd: m[kind].root }));
    assert.equal(value.source, m[kind].source); assert.equal(value.sourceAndSchemaVerified, true); return value;
  });
  if (m.deployedUsageSchema) assertPriorUsageRoleControl(m);
  else for (const file of [SOURCE, CONTROL + '/allowed.json', CONTROL + '/start.mjs']) assert.equal(exists(file), false,
    'This first role-origin promotion requires a fresh reviewed control path; never overwrite another run');
  return { schema: 'sd2-usage-role-readonly-admission.v1', original, accepted,
    moduleSha256: sha(moduleBytes), contractSha256: sha(Buffer.from(JSON.stringify(contract))), businessWrites: 0, servicesChanged: false };
}
function publishRoleStart(m) {
  assertUsageRoleStopped(m);
  for (const role of ['web', 'image', 'hd']) assert.equal(exists('/proc/' + operationalLive(m, role).pid), false, 'Original writer remains alive');
  const { contract, moduleBytes } = roleStartContract(m);
  directory(CONTROL);
  if (exists(CONTROL + '/start.mjs')) assert.deepEqual(rootFile(CONTROL + '/start.mjs'), moduleBytes);
  else writeProgram(CONTROL + '/start.mjs', moduleBytes);
  const bytes = Buffer.from(JSON.stringify(contract, null, 2) + '\n');
  if (m.deployedUsageSchema) {
    const prior = priorUsageRoleControl(m), current = rootFile(CONTROL + '/allowed.json');
    assert.equal(sha(moduleBytes), prior.moduleSha256);
    assert.ok(current.equals(prior.allowed) || current.equals(bytes), 'Role allowlist is neither prior publication nor current pair');
    const last = journals(m).at(-1);
    if (last.phase !== 'control-intent') record(m, 'control-intent', { kind: 'pair', stopping: last.stopping,
      previousAllowedSha256: sha(prior.allowed), nextAllowedSha256: sha(bytes), moduleSha256: sha(moduleBytes) });
    if (!current.equals(bytes)) replaceOwned(CONTROL + '/allowed.json', bytes);
  }
  else if (exists(CONTROL + '/allowed.json')) assert.deepEqual(rootFile(CONTROL + '/allowed.json'), bytes);
  else writeProgram(CONTROL + '/allowed.json', bytes);
  return { contract, sha256: sha(bytes), moduleSha256: sha(moduleBytes) };
}
export async function startUsageRole(m, kind, check = () => assertReleaseWindow(m)) {
  assert.ok(['main', 'guard', 'original'].includes(kind));
  assertUsageRoleStopped(m); check();
  const captured = before(m);
  if (kind === 'original') {
    assert.equal(journals(m).some(entry => entry.phase === 'control-intent' || entry.phase === 'start-intent' && entry.kind !== 'original'), false,
      'An attempted new writer may only recover to the compatible guard');
    if (m.deployedUsageSchema) assertPriorUsageRoleControl(m);
    else assert.equal(exists(SOURCE), false);
  } else {
    const published = publishRoleStart(m);
    directory(path.dirname(SOURCE));
    if (exists(SOURCE)) assert.ok(['main', 'guard'].some(value => rootFile(SOURCE).equals(sourceBytes(m, value)))
      || m.deployedUsageSchema && rootFile(SOURCE).equals(priorUsageRoleControl(m).source));
    replaceOwned(SOURCE, sourceBytes(m, kind));
    record(m, 'start-intent', { kind, published });
    call('systemctl', ['daemon-reload']);
    const prestart = JSON.parse(call('runuser', ['-u', m.appUser, '--', 'env', '-i', 'PATH=/usr/bin:/bin',
      '/usr/bin/node', CONTROL + '/start.mjs'], { cwd: m[kind].root }));
    assert.equal(prestart.source, m[kind].source); assert.equal(prestart.sourceAndSchemaVerified, true);
  }
  if (kind === 'original') record(m, 'start-intent', { kind });
  check(); call('systemctl', ['start', '--no-block', NAME]);
  let observed;
  await waitFor(check, () => {
    const current = state();
    if (current.ActiveState === 'failed') {
      record(m, 'start-failed', { kind, current });
      throw new Error('Role writer startup failed; retain no-force and compatible recovery proof');
    }
    try { observed = assertRunning(m, captured, current, kind); return true; }
    catch (error) { if (!['activating', 'active'].includes(current.ActiveState)) throw error; return false; }
  }, 'Role writer runtime identity was not confirmed');
  const current = state(); record(m, 'active', { kind, current, runtime: observed });
  assertPolicy(m, captured, current);
  assert.equal(sha(rootFile(noForce(m))), sha(noForceBytes(m)));
  fs.unlinkSync(noForce(m)); call('systemctl', ['daemon-reload']);
  assertRunning(m, captured, state(), kind, current.InvocationID);
  return { kind, source: kind === 'original' ? m.live.role.source : m[kind].source, current: state(), runtime: observed };
}
export async function restoreOriginalUsageRole(m, check) {
  const last = journals(m).at(-1);
  if (!last) return { unchanged: true };
  if (last.phase === 'active' && last.kind === 'original') { inspectUsageRoleProtection(m); return { originalAlreadyRestored: true }; }
  if (last.phase === 'policy-intent' && last.kind === 'original') {
    const captured = before(m), current = state();
    assert.equal(current.MainPID, last.current.MainPID); assert.equal(current.InvocationID, last.current.InvocationID);
    assertRunning(m, captured, current, 'original', last.current.InvocationID);
    if (exists(noForce(m))) {
      assert.equal(sha(rootFile(noForce(m))), sha(noForceBytes(m)));
      fs.unlinkSync(noForce(m)); call('systemctl', ['daemon-reload']);
    }
    record(m, 'active', { kind: 'original', current: state() });
    return { originalUninterrupted: true };
  }
  await stopUsageRole(m, check); return startUsageRole(m, 'original', check);
}
export function usageRoleProof(m) {
  inspectUsageRoleProtection(m);
  const transitions = journals(m);
  return { protocol: 'sd2-usage-role-transition.v1', current: state(), transitions,
    original: baseline(m), allTransitionsBound: true, forcedKill: false, businessDataRestored: false };
}
