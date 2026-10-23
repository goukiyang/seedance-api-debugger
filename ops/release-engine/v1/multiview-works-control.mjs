import { prepareEngineeringRunDirectory } from './full-release-contract.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { rootFile, sha, call, unit, writeJsonExclusive, assertReleaseWindow } from './common.mjs';
import { candidateEvidenceFile } from './candidate-evidence.mjs';
import { MV_DIRECT } from './release-contract.mjs';
import { publishMultiviewBackupControl, inspectMultiviewBackupProtection } from './multiview-backup-control.mjs';

const NAME = 'sd2-multiview-works.service';
const CONTROL = '/data/video-api-debugger/controls/multiview-works-v1';
const SOURCE = '/etc/systemd/system/' + NAME + '.d/zz-multiview-private-source.conf';
const RUNTIME = '/data/video-api-debugger/var-lib/storage/multiview-works/runtime.json';
const START = 'ops/sd2-multiview-works-start.mjs';
const SOURCES = [START, 'scripts/process-multiview-works.ts', 'src/lib/video/multiview-works-runtime.ts',
  'src/lib/video/multiview-work-render.ts', 'src/lib/video/multiview-output-assets.server.ts',
  'src/lib/video/multiview-output-access.server.ts', 'src/lib/video/multiview-recipe-storage.server.ts',
  'src/lib/video/multiview-works.ts', 'src/lib/video/multiview-work-contract.ts', 'src/lib/prisma.ts',
  'package.json', 'prisma/schema.prisma'];
const exists = file => fs.existsSync(file);
const manifestSha = m => sha(rootFile(m.stage + '/manifest.json'));
const json = file => JSON.parse(rootFile(file));
const baseline = m => ({ pid: String(m.live.works.pid), invocation: m.live.works.invocation, root: m.live.works.root });
const policyFile = m => '/run/systemd/system/' + NAME + '.d/multiview-private-' + m.runId + '.conf';
const policyBytes = m => Buffer.from('# Multiview natural drain ' + m.runId + '\n[Service]\nRestart=no\nKillSignal=SIGTERM\nSendSIGKILL=no\nTimeoutStopSec=infinity\n');
const sourceBytes = (m, kind) => Buffer.from('[Service]\nWorkingDirectory=' + m[kind].root
  + '\nExecStart=\nExecStart=/usr/bin/node --import tsx scripts/process-multiview-works.ts\nExecStartPre=/usr/bin/node '
  + CONTROL + '/start.mjs\n');
const binding = (m, value) => { assert.equal(value.runId, m.runId); assert.equal(value.manifestSha256, manifestSha(m)); return value; };

function identity(file) {
  const bytes = rootFile(file), stat = fs.lstatSync(file);
  return { path: file, sha256: sha(bytes), identity: { dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid,
    mode: stat.mode & 0o7777, nlink: stat.nlink, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } };
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function ownedDirectory(directory, mode = 0o755) {
  fs.mkdirSync(directory, { recursive: true, mode });
  const stat = fs.lstatSync(directory);
  assert.equal(fs.realpathSync(directory), directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022));
}
function atomicOwned(file, bytes, expected) {
  const present = exists(file);
  if (expected === null) assert.equal(present, false, 'Refusing to overwrite an unrecorded control file');
  else assert.deepEqual(identity(file), expected, 'Control file changed before publication');
  const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); syncDirectory(path.dirname(file)); }
  finally { if (exists(temporary)) fs.unlinkSync(temporary); }
  return identity(file);
}
function service() {
  const fields = ['User', 'Group', 'Restart', 'RestartUSec', 'KillMode', 'KillSignal', 'SendSIGKILL', 'TimeoutStopUSec',
    'TasksMax', 'FragmentPath', 'DropInPaths', 'ControlGroup', 'ExecMainCode', 'ExecMainStatus', 'ExecStart', 'ExecStartPre'];
  const extra = Object.fromEntries(call('systemctl', ['show', NAME, ...fields.flatMap(key => ['-p', key])]).split('\n')
    .map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  if (!Object.hasOwn(extra, 'ExecStartPre')) {
    // systemd255's command-array printer omits a supported empty ExecStartPre,
    // even with --all. Only the real typed empty array proves an empty value;
    // unsupported properties, getter failures and every other omission refuse.
    const typed = JSON.parse(call('busctl', ['--json=short', 'get-property', 'org.freedesktop.systemd1',
      '/org/freedesktop/systemd1/unit/sd2_2dmultiview_2dworks_2eservice', 'org.freedesktop.systemd1.Service', 'ExecStartPre']));
    assert.deepEqual(typed, { type: 'a(sasbttttuii)', data: [] }, 'Missing ExecStartPre is not a verified supported empty command array');
    extra.ExecStartPre = '';
  }
  for (const field of fields) assert.ok(Object.hasOwn(extra, field));
  return { ...unit(NAME), ...extra };
}
function groupPids(group) {
  assert.ok(group.startsWith('/system.slice/') && !group.includes('..'));
  const pending = ['/sys/fs/cgroup' + group], result = new Set();
  if (!exists(pending[0])) return [];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.name === 'cgroup.procs') fs.readFileSync(file, 'utf8').trim().split(/\s+/).filter(Boolean).forEach(pid => result.add(Number(pid)));
    }
  }
  return [...result].sort((a, b) => a - b);
}
function noUnmanagedConsumer(root, pids) {
  for (const name of fs.readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
    try {
      if (fs.realpathSync('/proc/' + name + '/cwd') !== root) continue;
      if (fs.readFileSync('/proc/' + name + '/cmdline', 'utf8').includes('process-multiview-works.ts')) assert.ok(pids.includes(Number(name)), 'Unmanaged multiview consumer exists');
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
}
function journals(m) {
  const names = fs.readdirSync(m.stage).filter(name => /^multiview-works-transition-\d{4}\.json$/.test(name)).sort();
  return names.map((name, index) => {
    const value = binding(m, json(m.stage + '/' + name));
    assert.equal(value.sequence, index + 1);
    assert.equal(value.previousSha256, index ? sha(rootFile(m.stage + '/' + names[index - 1])) : null);
    return value;
  });
}
function record(m, phase, details = {}) {
  const entries = journals(m), sequence = entries.length + 1;
  assert.ok(sequence < 1000);
  const value = { runId: m.runId, manifestSha256: manifestSha(m), sequence,
    previousSha256: entries.length ? sha(rootFile(m.stage + '/multiview-works-transition-' + String(sequence - 1).padStart(4, '0') + '.json')) : null,
    phase, at: new Date().toISOString(), ...details };
  writeJsonExclusive(m.stage + '/multiview-works-transition-' + String(sequence).padStart(4, '0') + '.json', value);
  return value;
}
function assertLock(m, check) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0); check();
  const lock = json(m.stage + '/.switch.lock'); assert.equal(lock.runId, m.runId); assert.equal(lock.pid, process.pid);
  assert.equal(call('findmnt', ['-n', '-o', 'TARGET', '-T', m.stage]), '/data');
}
function original(m) { return binding(m, json(m.stage + '/multiview-works-before.json')); }
function capture(m) {
  if (exists(m.stage + '/multiview-works-before.json')) return original(m);
  const current = service();
  assert.equal(current.ActiveState, 'active'); assert.equal(current.SubState, 'running'); assert.equal(current.ControlPID, '0');
  assert.equal(Number(current.MainPID), m.live.works.pid); assert.equal(current.InvocationID, m.live.works.invocation);
  assert.equal(fs.realpathSync(current.WorkingDirectory), m.live.works.root);
  assert.equal(fs.realpathSync('/proc/' + current.MainPID + '/cwd'), m.live.works.root);
  assert.equal(current.User, m.appUser); assert.equal(current.SendSIGKILL, 'no'); assert.equal(current.KillSignal, '15');
  const pids = groupPids(current.ControlGroup); assert.ok(pids.includes(Number(current.MainPID))); noUnmanagedConsumer(m.live.works.root, pids);
  const value = { runId: m.runId, manifestSha256: manifestSha(m), current, pids,
    fragment: identity(current.FragmentPath), dropins: current.DropInPaths.split(/\s+/).filter(Boolean).map(identity),
    previousAllowed: exists(CONTROL + '/allowed.json') ? identity(CONTROL + '/allowed.json') : null,
    previousSource: exists(SOURCE) ? identity(SOURCE) : null };
  writeJsonExclusive(m.stage + '/multiview-works-before.json', value);
  record(m, 'captured'); return value;
}
function assertUnit(m, captured, current, kind = null) {
  assert.deepEqual(identity(current.FragmentPath), captured.fragment);
  for (const key of ['User', 'Group', 'KillMode', 'KillSignal', 'TasksMax', 'RestartUSec']) assert.equal(current[key], captured.current[key]);
  const known = captured.dropins.map(file => file.path);
  const actual = current.DropInPaths.split(/\s+/).filter(Boolean);
  assert.ok(actual.every(file => known.includes(file) || file === SOURCE || file === policyFile(m)));
  for (const entry of captured.dropins) if (entry.path !== SOURCE) assert.deepEqual(identity(entry.path), entry);
  if (kind) assert.deepEqual(rootFile(SOURCE), sourceBytes(m, kind));
  if (kind) {
    assert.ok(current.ExecStartPre.includes(CONTROL + '/start.mjs'));
    assert.ok(current.ExecStart.includes('scripts/process-multiview-works.ts') && current.ExecStart.includes('--import tsx'));
  }
  if (exists(policyFile(m))) {
    assert.deepEqual(rootFile(policyFile(m)), policyBytes(m));
    assert.equal(current.Restart, 'no'); assert.equal(current.SendSIGKILL, 'no'); assert.equal(current.TimeoutStopUSec, 'infinity');
  } else for (const key of ['Restart', 'SendSIGKILL', 'TimeoutStopUSec']) assert.equal(current[key], captured.current[key]);
}
function contract(m) {
  const appUid = Number(call('id', ['-u', m.appUser]));
  const releases = ['main', 'guard'].map(kind => {
    const candidate = binding(m, json(candidateEvidenceFile(m, kind)));
    assert.equal(candidate.exitCode, 0); assert.equal(candidate.verifiedSourceAndGates, true); assert.equal(candidate.source, m[kind].source);
    const source = json(m[kind].sourceManifest); assert.equal(source.source, m[kind].source);
    const sourceSha256 = Object.fromEntries(SOURCES.map(file => {
      const digest = sha(fs.readFileSync(m[kind].root + '/' + file)); assert.equal(digest, source.files[file]); return [file, digest];
    }));
    return { root: m[kind].root, source: m[kind].source, version: m[kind].version, build: candidate.build, sourceSha256 };
  });
  assert.deepEqual(fs.readFileSync(m.main.root + '/' + START), fs.readFileSync(m.guard.root + '/' + START));
  return { schema: 'sd2-multiview-works-start.v1', runId: m.runId, manifestSha256: manifestSha(m), appUid, releases };
}
function publish(m, captured) {
  const value = contract(m); ownedDirectory(CONTROL);
  const bytes = fs.readFileSync(m.main.root + '/' + START), startFile = CONTROL + '/start.mjs';
  if (exists(startFile)) assert.deepEqual(rootFile(startFile), bytes, 'Existing startup guard differs from the reviewed program');
  else atomicOwned(startFile, bytes, null);
  const target = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  if (!exists(CONTROL + '/allowed.json') || !rootFile(CONTROL + '/allowed.json').equals(target)) {
    record(m, 'control-intent', { nextAllowedSha256: sha(target), previousAllowed: captured.previousAllowed });
    atomicOwned(CONTROL + '/allowed.json', target, captured.previousAllowed);
  }
  const published = { allowed: identity(CONTROL + '/allowed.json'), module: identity(startFile) };
  record(m, 'control-published', { published }); return { value, published };
}
export function assertWorksLifecycleObservation(expected, observed) {
  assert.equal(observed.oldProcessesAbsent, true); assert.equal(observed.oldGroupEmptyOrReusedOnlyByCurrent, true);
  assert.equal(observed.unitUnchangedExceptRecordedSource, true); assert.equal(observed.startupVerified, true);
  assert.equal(observed.current.ActiveState, 'active'); assert.equal(observed.current.SubState, 'running'); assert.equal(observed.current.ControlPID, '0');
  assert.ok(Number(observed.current.MainPID) > 1); assert.match(observed.current.InvocationID, /^[a-f0-9]{32}$/);
  assert.equal(observed.runtime.schema, 'multiview.works.v1'); assert.equal(observed.runtime.protocol, observed.runtime.schema);
  assert.equal(observed.runtime.state, 'active');
  assert.equal(observed.runtime.sourceRoot, expected.root); assert.equal(observed.runtime.source, expected.source);
  assert.equal(observed.runtime.version, expected.version); assert.equal(observed.runtime.build, expected.build);
  assert.deepEqual(observed.runtime.loadedModuleSha, expected.sourceSha256);
  assert.ok(observed.groupPids.includes(Number(observed.current.MainPID)) && observed.groupPids.includes(observed.runtime.pid));
  assert.ok(observed.runtime.parentPid === Number(observed.current.MainPID) || observed.runtime.pid === Number(observed.current.MainPID));
  assert.ok(observed.now - Date.parse(observed.runtime.heartbeatAt) >= -1000 && observed.now - Date.parse(observed.runtime.heartbeatAt) < 45000);
  return true;
}
function verifyRunning(m, captured, kind) {
  const allowed = json(CONTROL + '/allowed.json'), expected = allowed.releases.find(release => release.source === m[kind].source);
  assert.ok(expected); assert.deepEqual(allowed, contract(m));
  const current = service(); assertUnit(m, captured, current, kind);
  assert.equal(fs.realpathSync(current.WorkingDirectory), expected.root);
  assert.equal(fs.realpathSync('/proc/' + current.MainPID + '/cwd'), expected.root);
  const runtimeStat = fs.lstatSync(RUNTIME);
  assert.ok(runtimeStat.isFile() && !runtimeStat.isSymbolicLink() && runtimeStat.nlink === 1 && !(runtimeStat.mode & 0o077) && runtimeStat.uid === allowed.appUid && runtimeStat.size < 65536);
  const runtime = JSON.parse(fs.readFileSync(RUNTIME));
  assert.equal(fs.realpathSync('/proc/' + runtime.pid + '/cwd'), expected.root);
  const pids = groupPids(current.ControlGroup); noUnmanagedConsumer(expected.root, pids);
  for (const pid of captured.pids) assert.equal(exists('/proc/' + pid), false, 'Original consumer process still exists');
  const old = groupPids(captured.current.ControlGroup);
  const oldEmpty = captured.current.ControlGroup === current.ControlGroup ? old.every(pid => pids.includes(pid)) : old.length === 0;
  const verified = JSON.parse(call('runuser', ['-u', m.appUser, '--', 'env', '-i', 'PATH=/usr/bin:/bin', '/usr/bin/node', CONTROL + '/start.mjs'], { cwd: expected.root }));
  assert.equal(verified.source, expected.source); assert.equal(verified.build, expected.build); assert.equal(verified.verified, true);
  assertWorksLifecycleObservation(expected, { current, runtime, groupPids: pids, now: Date.now(), oldProcessesAbsent: true,
    oldGroupEmptyOrReusedOnlyByCurrent: oldEmpty, unitUnchangedExceptRecordedSource: true, startupVerified: verified.verified });
  return { current, runtime, startup: { allowed: identity(CONTROL + '/allowed.json'), module: identity(CONTROL + '/start.mjs'), sourceDropin: identity(SOURCE) } };
}
async function wait(check, predicate, description, milliseconds = 120000, pendingCode = null) {
  const until = Date.now() + milliseconds;
  for (;;) {
    check(); if (predicate()) return;
    if (Date.now() >= until) throw Object.assign(new Error(description), pendingCode ? { code: pendingCode } : {});
    await pause(500);
  }
}
async function stop(m, captured, check) {
  let current = service();
  if (current.ActiveState === 'failed' && current.MainPID === '0' && current.ControlPID === '0'
    && journals(m).some(entry => entry.phase === 'stopped' && entry.naturalExit === true)) {
    assert.deepEqual(groupPids(current.ControlGroup || captured.current.ControlGroup), []);
    record(m, 'failed-new-consumer-stopped', { current, oldNaturalExitRetained: true }); return;
  }
  if (current.ActiveState === 'inactive' && current.MainPID === '0' && current.ControlPID === '0') {
    assert.deepEqual(groupPids(current.ControlGroup || captured.current.ControlGroup), []); return;
  }
  ownedDirectory(path.dirname(policyFile(m)));
  if (exists(policyFile(m))) assert.deepEqual(rootFile(policyFile(m)), policyBytes(m));
  else { record(m, 'policy-intent', { current }); atomicOwned(policyFile(m), policyBytes(m), null); call('systemctl', ['daemon-reload']); }
  current = service(); assertUnit(m, captured, current);
  record(m, 'stop-intent', { current, pids: groupPids(current.ControlGroup), forcedKill: false });
  call('systemctl', ['stop', '--no-block', NAME]);
  await wait(check, () => { const value = service(); assertUnit(m, captured, value); return value.ActiveState === 'inactive'
    && value.MainPID === '0' && value.ControlPID === '0' && groupPids(captured.current.ControlGroup).length === 0; }, 'Natural multiview shutdown remains incomplete', 12 * 60000, 'NATURAL_STOP_PENDING');
  const after = service(); assert.equal(after.Result, 'success'); assert.equal(after.ExecMainStatus, '0');
  assert.ok(['1', 'exited'].includes(after.ExecMainCode));
  for (const pid of captured.pids) assert.equal(exists('/proc/' + pid), false);
  noUnmanagedConsumer(captured.current.WorkingDirectory, []);
  record(m, 'stopped', { after, oldPids: captured.pids, naturalExit: true, forcedKill: false });
}
async function start(m, captured, kind, check) {
  const last = journals(m).at(-1);
  const current = service();
  if (current.ActiveState === 'active' && last?.phase === 'active') {
    const existingKind = last.kind; assert.ok(['main', 'guard'].includes(existingKind));
    return { kind: existingKind, ...verifyRunning(m, captured, existingKind) };
  }
  await stop(m, captured, check); assertLock(m, check);
  const published = publish(m, captured);
  ownedDirectory(path.dirname(SOURCE));
  const present = exists(SOURCE) ? identity(SOURCE) : null;
  if (present && !rootFile(SOURCE).equals(sourceBytes(m, kind))) {
    assert.ok(captured.previousSource && present.sha256 === captured.previousSource.sha256
      || ['main', 'guard'].some(value => rootFile(SOURCE).equals(sourceBytes(m, value))));
  }
  if (!present || !rootFile(SOURCE).equals(sourceBytes(m, kind))) atomicOwned(SOURCE, sourceBytes(m, kind), present);
  record(m, 'start-intent', { kind, published: published.published }); call('systemctl', ['daemon-reload']);
  const accepted = JSON.parse(call('runuser', ['-u', m.appUser, '--', 'env', '-i', 'PATH=/usr/bin:/bin', '/usr/bin/node', CONTROL + '/start.mjs'], { cwd: m[kind].root }));
  assert.equal(accepted.verified, true); check(); call('systemctl', ['start', '--no-block', NAME]);
  let ready;
  await wait(check, () => {
    const state = service(); if (state.ActiveState === 'failed') throw new Error('Admitted multiview consumer could not start; do not restore an old source');
    try { ready = verifyRunning(m, captured, kind); return true; } catch { return false; }
  }, 'Multiview loaded-source heartbeat was not confirmed');
  record(m, 'active', { kind, source: m[kind].source, current: ready.current, runtime: ready.runtime });
  if (exists(policyFile(m))) { assert.deepEqual(rootFile(policyFile(m)), policyBytes(m)); fs.unlinkSync(policyFile(m)); call('systemctl', ['daemon-reload']); }
  ready = verifyRunning(m, captured, kind);
  const value = { schema: 'multiview-works-ready.v1', runId: m.runId, manifestSha256: manifestSha(m), kind,
    source: m[kind].source, version: m[kind].version, build: ready.runtime.build, unit: NAME,
    oldPids: captured.pids, oldCgroup: captured.current.ControlGroup, naturalExit: true, at: new Date().toISOString(),
    current: Object.fromEntries(['MainPID', 'ControlPID', 'ControlGroup', 'InvocationID', 'WorkingDirectory', 'ActiveState', 'SubState']
      .map(key => [key, ready.current[key]])), runtime: ready.runtime, startup: ready.startup };
  const file = m.stage + '/multiview-works-ready-' + kind + '.json';
  if (!exists(file)) writeJsonExclusive(file, value);
  return { kind, ...ready };
}

/** The projection is constant only after fresh observations prove the recorded transition. */
export function inspectMultiviewWorksProtection(m) {
  if (!journals(m).length) {
    const value = unit(NAME); assert.equal(value.ActiveState, 'active'); assert.equal(Number(value.MainPID), m.live.works.pid);
    assert.equal(value.InvocationID, m.live.works.invocation); assert.equal(fs.realpathSync('/proc/' + value.MainPID + '/cwd'), m.live.works.root);
    return baseline(m);
  }
  const captured = original(m), current = service();
  const kind = ['main', 'guard'].find(value => fs.realpathSync(current.WorkingDirectory) === m[value].root);
  if (current.ActiveState === 'active' && kind) verifyRunning(m, captured, kind);
  else {
    assertUnit(m, captured, current);
    const untouched = Number(current.MainPID) === m.live.works.pid && current.InvocationID === m.live.works.invocation;
    const failedNew = current.ActiveState === 'failed' && kind
      && journals(m).some(entry => entry.phase === 'stopped' && entry.naturalExit === true);
    if (failedNew) assertUnit(m, captured, current, kind);
    const stopped = (current.ActiveState === 'inactive' || failedNew) && current.MainPID === '0' && current.ControlPID === '0'
      && groupPids(captured.current.ControlGroup).length === 0;
    assert.ok(untouched || stopped, 'Unconfirmed consumer transition cannot bypass protection');
  }
  return baseline(m);
}

function recipeRows(m) {
  return JSON.parse(call('python3', ['-I', '-c', String.raw`
import sqlite3,hashlib,json,sys
with sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True,timeout=10) as c:
 c.execute('PRAGMA query_only=ON')
 print(json.dumps({k:hashlib.sha256(v.encode()).hexdigest() for k,v in c.execute("SELECT key,value_json FROM PlatformSetting WHERE key LIKE 'multiview_rotation_preset_%' ORDER BY key")}))
`, m.database]));
}
const R17_INSTALLED = Object.freeze({
  schema: 'sd2-multiview-r17-recovered-guard.v1', runId: '19a7cc3d-b11e-44c8-a754-d79e9c5624d1',
  manifestSha256: '00d4c9fa89a4368d0761adff3017ff2e58dcd8e58cc76b7698c3bab167cce7c8',
  recoveryEvidenceIndexSha256: 'd76bc0fa5808b68a5c4b2c347dfbb3d736d6c568b7b5f2d45deb5c54034b5081',
  installedRecipeReceiptSha256: 'ab71ea60b1a7c54f405910ce76389a0a21181058fbb7a81715afd0a47a2349b3',
});
export function assertInstalledMultiviewRecipeAdoption(m, records, observed) {
  const { input, plan, verification, applied, preopen } = records;
  for (const [key, expected] of Object.entries(R17_INSTALLED)) assert.equal((m.fullRelease?.privateRecipeOrigin || m.recoveredGuardBaseline)?.[key], expected);
  assert.equal(m.privateMultiviewInstall, true); assert.notEqual(m.runId, R17_INSTALLED.runId);
  assert.equal(plan.schema, 'multiview-private-recipe-plan.v1');
  assert.equal(verification.schema, 'multiview-private-recipe-verification.v1');
  assert.equal(applied.schema, 'multiview-private-recipe-apply.v1'); assert.equal(applied.production, true);
  assert.equal(applied.revision, 6); assert.equal(applied.version, '1.0.6'); assert.equal(input.expectedRevision, 5);
  for (const value of [plan, verification, applied]) {
    assert.equal(value.payloadSha256, records.payloadSha256); assert.equal(value.guideSha256, input.guideSHA);
  }
  assert.equal(verification.planSha256, records.planSha256); assert.equal(applied.planSha256, records.planSha256);
  assert.equal(applied.verificationSha256, records.verificationSha256); assert.deepEqual(verification.inspection, plan.inspection);
  for (const key of ['sourceTaskMatched', 'guideMatched']) assert.equal(plan.inspection[key], true);
  assert.equal(plan.inspection.revision, applied.revision); assert.equal(plan.inspection.version, applied.version);
  assert.equal(preopen.schema, 'multiview-private-preopen-complete.v1'); assert.equal(preopen.runId, R17_INSTALLED.runId);
  assert.equal(preopen.manifestSha256, R17_INSTALLED.manifestSha256); assert.equal(preopen.readyToOpen, true);
  assert.equal(preopen.recipe.applied, true); assert.equal(preopen.recipe.revision, applied.revision); assert.equal(preopen.recipe.version, applied.version);
  assert.equal(observed.current, observed.immutable); assert.ok(observed.current && observed.activation && observed.protection);
  for (const [key, hashKey] of [['current', 'currentSha256'], ['activation', 'activationSha256'], ['protection', 'protectionSha256']])
    assert.equal(sha(Buffer.from(observed[key])), applied.installedProof[hashKey], 'Installed recipe record drift: ' + key);
  const current = JSON.parse(observed.current), access = JSON.parse(observed.protection);
  assert.equal(current.revision, 6); assert.equal(current.preset.version, '1.0.6');
  assert.equal(current.preset.prompt, input.fullprompt); assert.equal(sha(Buffer.from(input.fullprompt)), input.expectedPromptSHA);
  assert.deepEqual(current.preset.defaults, input.defaults); assert.deepEqual(current.preset.compositionReference, input.ref2binding);
  assert.equal(access.kind, 'system-reference'); assert.equal(access.assetId, input.ref2binding.assetId);
  assert.equal(access.ownerId, input.ref2binding.ownerId); assert.equal(access.sha256, input.guideSHA);
  assert.ok(Array.isArray(access.urls) && access.urls.length > 0 && observed.aliases.length > 0);
  for (const url of observed.aliases) {
    const parsed = new URL(url, 'https://sd2.youdooart.com');
    assert.ok(['https://sd2.youdooart.com', 'https://sd2-server.youdoodesign.com'].includes(parsed.origin));
    assert.ok(parsed.pathname.startsWith('/uploads/'));
    assert.ok(access.urls.includes(url) && access.urls.includes(parsed.pathname + parsed.search), 'An original guide alias lost protection');
  }
  assert.equal(observed.sourceTask.owner, input.ref2binding.ownerId);
  assert.equal(observed.sourceTask.promptSha256, input.expectedPromptSHA); assert.equal(observed.sourceTask.snapshotSha256, input.expectedPromptSHA);
  const operation = observed.operation; assert.ok(operation);
  assert.equal(operation.operator_id, input.ref2binding.ownerId); assert.equal(operation.action, 'multiview_rotation_preset_save');
  assert.equal(operation.target_type, 'MultiviewRotationPreset'); assert.equal(operation.target_id, 'multiview-360');
  const detail = JSON.parse(operation.detail);
  assert.equal(detail.previousRevision, input.expectedRevision); assert.equal(detail.requestHash, applied.requestHash);
  assert.deepEqual(detail.receipt, { state: 'saved', mutationId: input.mutationId, ...current });
  assert.deepEqual(detail.install, { schema: 'multiview-private-recipe-install.v1', state: 'installed', mutationId: input.mutationId,
    revision: 6, version: '1.0.6', requestHash: applied.requestHash, activatedAt: applied.activatedAt,
    activationCreated: applied.activationCreated, sourceTaskMatched: true, guideMatched: true });
  assert.equal(applied.target, '/data/video-api-debugger/var-lib/storage/multiview-recipes/' + input.guideSHA + '.png');
  assert.deepEqual(observed.guide.identity, applied.installedProof.targetIdentity); assert.equal(observed.guide.sha256, input.guideSHA);
  return { phase: 'adopt', applied: false, adopted: true, revision: 6, version: '1.0.6', sourceTaskMatched: true, guideMatched: true,
    sourceRun: R17_INSTALLED.runId, originalInstallReceiptSha256: R17_INSTALLED.installedRecipeReceiptSha256,
    payloadSha256: records.payloadSha256, originalMutationIdSha256: sha(Buffer.from(input.mutationId)), requestHash: applied.requestHash,
    currentSha256: applied.installedProof.currentSha256, activationSha256: applied.installedProof.activationSha256,
    protectionSha256: applied.installedProof.protectionSha256, guideSha256: input.guideSHA, guideIdentity: observed.guide.identity, businessWrites: 0 };
}

export function inspectInstalledMultiviewRecipeAdoption(m) {
  if ((m.fullRelease?.privateRecipeOrigin || m.recoveredGuardBaseline)?.schema !== R17_INSTALLED.schema) return null;
  for (const [key, expected] of Object.entries(R17_INSTALLED)) assert.equal((m.fullRelease?.privateRecipeOrigin || m.recoveredGuardBaseline)[key], expected);
  const stage = '/data/video-api-debugger/release-staging/' + R17_INSTALLED.runId;
  assert.equal(fs.realpathSync(stage), stage); const stat = fs.lstatSync(stage);
  assert.ok(stat.isDirectory() && stat.uid === 0 && stat.gid === 0 && !(stat.mode & 0o077));
  assert.equal(call('findmnt', ['-n', '-o', 'TARGET', '-T', stage]), '/data');
  const indexBytes = rootFile(stage + '/r17-failure-recovery-evidence-index.json');
  assert.equal(sha(indexBytes), R17_INSTALLED.recoveryEvidenceIndexSha256); const index = JSON.parse(indexBytes);
  const get = name => { const bytes = rootFile(stage + '/' + name); assert.equal(sha(bytes), index.pins[name]); return { bytes, value: JSON.parse(bytes) }; };
  const prior = get('manifest.json').value, recovery = get('guard-recovery-complete.json').value;
  assert.equal(sha(rootFile(stage + '/manifest.json')), R17_INSTALLED.manifestSha256);
  assert.equal(recovery.completed, true); assert.equal(recovery.route, 'fixed-guard'); assert.equal(recovery.businessDataRestored, false);
  assert.equal(recovery.source, prior.guardSource); assert.equal(prior.database, m.database);
  const payload = get('private-recipe/payload.json'), plan = get('private-recipe/plan.json'), verification = get('private-recipe/verification.json');
  const applied = get('private-recipe/apply.json'); assert.equal(sha(applied.bytes), R17_INSTALLED.installedRecipeReceiptSha256);
  const input = payload.value, records = { input, plan: plan.value, verification: verification.value, applied: applied.value,
    preopen: get('multiview-private-preopen-complete.json').value, payloadSha256: sha(payload.bytes),
    planSha256: sha(plan.bytes), verificationSha256: sha(verification.bytes) };
  assert.equal(sha(rootFile(m.stage + '/private-recipe/payload.json')), records.payloadSha256, 'New run must retain the exact original install request');
  assert.equal(sha(rootFile(m.stage + '/private-recipe/guide.png')), input.guideSHA);
  const operationId = 'multiview-preset-save-' + sha(Buffer.from(JSON.stringify([input.ref2binding.ownerId, input.mutationId])));
  const observed = JSON.parse(call('python3', ['-I', '-c', String.raw`
import sqlite3,json,hashlib,sys
x=json.loads(sys.argv[2])
with sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True,timeout=10) as c:
 c.execute('PRAGMA query_only=ON');c.row_factory=sqlite3.Row
 def setting(k):
  r=c.execute('SELECT value_json FROM PlatformSetting WHERE key=?',(k,)).fetchone();return r[0] if r else None
 a=c.execute('SELECT original_url,thumbnail_url FROM Asset WHERE id=?',(x['asset'],)).fetchone()
 refs=c.execute('SELECT url,thumbnail_url FROM ReferenceImage WHERE asset_id=?',(x['asset'],)).fetchall()
 task=c.execute('SELECT prompt,final_prompt_snapshot,owner_user_id,user_id FROM VideoTask WHERE id=?',(x['task'],)).fetchone()
 op=c.execute('SELECT operator_id,action,target_type,target_id,detail FROM OperationLog WHERE id=?',(x['operation'],)).fetchone()
 h=lambda s:hashlib.sha256(s.encode()).hexdigest() if isinstance(s,str) else None
 print(json.dumps({'current':setting('multiview_rotation_preset_v1:current'),'immutable':setting('multiview_rotation_preset_v1:version:1.0.6'),
 'activation':setting('multiview_output_registration_v1:activation'),'protection':setting('multiview_private_media_access_v1:'+x['guide']),
 'aliases':[v for row in ([a] if a else [])+refs for v in tuple(row) if isinstance(v,str) and v],
 'sourceTask':{'owner':task['owner_user_id'] or task['user_id'],'promptSha256':h(task['prompt']),'snapshotSha256':h(task['final_prompt_snapshot'])} if task else {},
 'operation':dict(op) if op else None}))
`, m.database, JSON.stringify({ asset: input.ref2binding.assetId, guide: input.guideSHA, task: input.sourceTaskId, operation: operationId })]));
  const target = applied.value.target, expected = applied.value.installedProof.targetIdentity;
  assert.equal(fs.realpathSync(target), target); const named = fs.lstatSync(target);
  assert.ok(named.isFile() && !named.isSymbolicLink() && named.nlink === 1);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); let bytes;
  try {
    const opened = fs.fstatSync(fd); bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd), fresh = fs.lstatSync(target);
    for (const [key, value] of Object.entries(expected)) for (const seen of [named, opened, after, fresh])
      assert.equal(key === 'mode' ? seen.mode & 0o7777 : seen[key], value, 'Installed guide identity changed: ' + key);
  } finally { fs.closeSync(fd); }
  observed.guide = { identity: { ...expected }, sha256: sha(bytes) };
  return assertInstalledMultiviewRecipeAdoption(m, records, observed);
}

function authorizeRecipeTransition(m, payload) {
  const input = JSON.parse(rootFile(payload));
  const revision = input.expectedRevision + 1, version = '1.0.' + revision;
  const expected = JSON.stringify({ revision, preset: { id: 'multiview-360', version, prompt: input.fullprompt,
    defaults: input.defaults, compositionReference: input.ref2binding } });
  const value = { runId: m.runId, manifestSha256: manifestSha(m), before: recipeRows(m), payloadSha256: sha(rootFile(payload)),
    planSha256: sha(rootFile(m.stage + '/private-recipe/plan.json')), verificationSha256: sha(rootFile(m.stage + '/private-recipe/verification.json')),
    currentKey: 'multiview_rotation_preset_v1:current', versionKey: 'multiview_rotation_preset_v1:version:' + version,
    expectedSha256: sha(Buffer.from(expected)) };
  assert.equal(Object.hasOwn(value.before, value.versionKey), false, 'A new recipe version cannot overwrite history');
  writeJsonExclusive(m.stage + '/multiview-recipe-transition.json', value); return value;
}
export function privateMultiviewRecipeProtection(m, rows) {
  const file = m.stage + '/multiview-recipe-transition.json';
  if (!MV_DIRECT.privateMultiviewInstall || !exists(file)) return rows;
  const allowed = binding(m, json(file));
  assert.equal(sha(rootFile(m.stage + '/private-recipe/payload.json')), allowed.payloadSha256);
  assert.equal(sha(rootFile(m.stage + '/private-recipe/plan.json')), allowed.planSha256);
  assert.equal(sha(rootFile(m.stage + '/private-recipe/verification.json')), allowed.verificationSha256);
  // Only the exact authorized atomic pointer+new version are normalized. Any
  // other mutation remains visible to the original protection comparison.
  if (rows[allowed.currentKey] !== allowed.expectedSha256 || rows[allowed.versionKey] !== allowed.expectedSha256) return rows;
  const projected = { ...rows, [allowed.currentKey]: allowed.before[allowed.currentKey] };
  delete projected[allowed.versionKey];
  assert.deepEqual(projected, allowed.before, 'Historical recipe or an unrelated version changed');
  return projected;
}

function freshGuideInventory(m, payloadFile) {
  const result = JSON.parse(call('python3', ['-I', '-c', String.raw`
import json,sqlite3,sys
p=json.load(open(sys.argv[2])); b=p['ref2binding']; needles=[b['assetId'],b['referenceImageId'],p['guideSHA']]
with sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True,timeout=10) as c:
 c.execute('PRAGMA query_only=ON')
 video=[]
 for field in ['reference_image_ids','reference_image_urls','params_json','reference_images_json','provider_payload_json']:
  video += ["instr(COALESCE("+field+",''),?)>0" for _ in needles]
 vals=needles*5
 matched=' OR '.join(video)
 terminal="('succeeded','failed','cancelled','canceled','deleted')"
 v=c.execute('SELECT COUNT(*) FROM VideoTask WHERE ('+matched+') AND local_status NOT IN '+terminal,vals).fetchone()[0]
 i=c.execute("SELECT COUNT(*) FROM ImageStudioTask WHERE status NOT IN ('succeeded','failed','cancelled','canceled') AND ("+' OR '.join("instr(COALESCE("+field+",''),?)>0" for field in ['reference_ids','snapshot_json'] for _ in needles)+')',needles*2).fetchone()[0]
 r=c.execute("SELECT COUNT(*) FROM ProviderApiRequest WHERE completed_at IS NULL AND (task_id=? OR task_id IN (SELECT id FROM VideoTask WHERE "+matched+'))',[p['sourceTaskId']]+vals).fetchone()[0]
 print(json.dumps({'schema':'multiview-guide-inflight.v1','video':v,'image':i,'providerRequests':r,'readonly':True}))
`, m.database, payloadFile]));
  assert.equal(result.readonly, true); assert.equal(result.video, 0); assert.equal(result.image, 0); assert.equal(result.providerRequests, 0);
  writeJsonExclusive(m.stage + '/multiview-guide-fresh-inventory.json', { runId: m.runId, manifestSha256: manifestSha(m), at: new Date().toISOString(), ...result });
}
function privateCommand(m, phase, arguments_) {
  const result = call('/usr/bin/node', ['--import', 'tsx', 'scripts/install-multiview-private-recipe.ts', phase, ...arguments_], {
    cwd: m.main.root, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', NODE_ENV: 'production', DATABASE_URL: 'file:' + m.database }, timeout: 120000 });
  const value = JSON.parse(result); assert.equal(value.phase, phase); return value;
}
function writeAdmission(m, preOpen, worksReady) {
  const captured = json(m.stage + '/switch-before.json');
  const natural = m.stage + '/natural-stop-switch-web.json';
  const before = json(m.stage + '/natural-stop-intent-switch-web.json').before;
  const oldPids = [Number(before.MainPID), Number(before.ControlPID)].filter(pid => pid > 1);
  const value = { schema: 'multiview-private-recipe-admission.v1', runId: m.runId,
    mainSource: m.mainSource, mainBuild: preOpen.healthy.build, guardSource: m.guardSource,
    guardBuild: json(candidateEvidenceFile(m, 'guard')).build, oldWebPids: oldPids,
    oldWebCgroup: before.ControlGroup, oldWebCgroupPids: captured.privateWebPids || oldPids, additionalReaderPids: [],
    evidence: { preOpen: identity(m.stage + '/multiview-private-preopen.json'), worksReady: identity(worksReady),
      allowed: identity(CONTROL + '/allowed.json'), naturalStopWeb: identity(natural),
      pricingPairPublished: identity(m.stage + '/pricing-pair-published.json') } };
  const file = m.stage + '/private-recipe/admission.json'; writeJsonExclusive(file, value); return file;
}
export function createMultiviewIsolatedBackupCopy(m, backup) {
  prepareEngineeringRunDirectory(m);
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  assert.match(m.runId, /^[a-f0-9-]{36}$/); assert.match(m.mainSource, /^[a-f0-9]{40}$/);
  assert.equal(backup, '/data/video-api-debugger/backups/multiview-private-' + m.runId);
  const base = '/data/video-api-debugger-engineering', parent = base + '/' + m.runId;
  const directory = parent + '/restore-' + m.mainSource;
  const data = fs.lstatSync('/data');
  assert.ok(data.isDirectory() && !data.isSymbolicLink() && data.dev !== fs.statSync('/').dev);
  const directoryState = file => {
    const stat = fs.lstatSync(file);
    assert.equal(fs.realpathSync(file), file);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022) && stat.dev === data.dev);
    return { dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid };
  };
  for (const file of ['/data', base, parent]) directoryState(file);
  const original = directoryState(backup); assert.equal(original.mode, 0o700);
  assert.equal(exists(directory), false, 'Never reuse a partial or previous restore copy');
  const digest = file => {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), before = fs.fstatSync(fd);
    try {
      assert.ok(before.isFile() && before.nlink === 1 && before.uid === 0 && before.dev === data.dev && !(before.mode & 0o077));
      const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024); let count = 0, length;
      while ((length = fs.readSync(fd, buffer, 0, buffer.length, null))) { hash.update(buffer.subarray(0, length)); count += length; }
      const after = fs.fstatSync(fd), named = fs.lstatSync(file);
      for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink']) {
        assert.equal(after[key], before[key]); assert.equal(named[key], before[key]);
      }
      assert.equal(count, before.size); return { bytes: count, sha256: hash.digest('hex') };
    } finally { fs.closeSync(fd); }
  };
  const critical = Object.fromEntries(['database.sqlite3', 'mapping.json'].map(name => [name, digest(backup + '/' + name)]));
  const copy = (from, to) => {
    const before = directoryState(from); assert.equal(before.mode, 0o700);
    fs.mkdirSync(to, { mode: 0o700 });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name), target = path.join(to, entry.name), stat = fs.lstatSync(source);
      assert.ok(!stat.isSymbolicLink() && stat.uid === 0 && stat.dev === data.dev);
      if (stat.isDirectory()) copy(source, target);
      else {
        assert.ok(stat.isFile() && stat.nlink === 1 && !(stat.mode & 0o077));
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
        fs.chmodSync(target, 0o600);
        const after = fs.lstatSync(source);
        for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink']) assert.equal(after[key], stat[key]);
      }
    }
    assert.deepEqual(directoryState(from), before); assert.equal(directoryState(to).mode, 0o700);
  };
  copy(backup, directory);
  for (const [name, expected] of Object.entries(critical)) {
    assert.deepEqual(digest(backup + '/' + name), expected); assert.deepEqual(digest(directory + '/' + name), expected);
  }
  assert.deepEqual(directoryState(backup), original);
  const value = { schema: 'multiview-private-isolated-backup-copy.v1', runId: m.runId, manifestSha256: manifestSha(m),
    source: backup, directory, sourceIdentity: original, copyIdentity: directoryState(directory), critical,
    separateDirectory: true, actualDataDisk: true, productionDatabaseRestored: false, at: new Date().toISOString() };
  writeJsonExclusive(m.stage + '/multiview-private-isolated-backup-copy.json', value); return value;
}
export function assertWorksRecoveryActive(m, entries, ready = null, confirmation = null) {
  const last = entries.findLast(entry => entry.phase === 'active');
  assert.ok(last && ['main', 'guard'].includes(last.kind), 'An unconfirmed works start cannot authorize recovery drain');
  if (last.current) {
    assert.equal(last.source, m[last.kind].source);
    assert.equal(last.current.WorkingDirectory, m[last.kind].root);
    return last;
  }
  const marker = last.kind === 'main' ? 'privateReady' : 'guardSafe';
  assert.equal(last[marker], true, 'Unknown active works summary');
  assert.deepEqual(Object.keys(last).sort(), ['runId', 'manifestSha256', 'sequence', 'previousSha256', 'phase', 'at', 'kind', marker].sort());
  const index = entries.indexOf(last), active = entries.slice(0, index).findLast(entry => entry.phase === 'active');
  assert.ok(active?.current && active.runtime, 'The works summary lacks its original full active identity');
  assert.equal(active.kind, last.kind); assert.equal(active.source, m[last.kind].source);
  assert.equal(active.current.WorkingDirectory, m[last.kind].root);
  const between = entries.slice(entries.indexOf(active) + 1, index);
  if (last.kind === 'main') {
    assert.equal(confirmation?.readyToOpen, true);
    assert.equal(confirmation.schema, 'multiview-private-preopen-complete.v1');
    assert.equal(confirmation.source, m.mainSource); assert.equal(confirmation.build, ready?.build);
    const phases = between.map(entry => entry.phase);
    assert.ok(JSON.stringify(phases) === JSON.stringify(['recipe-install-intent', 'recipe-installed'])
      || JSON.stringify(phases) === JSON.stringify(['recipe-adopt-intent', 'recipe-adopted']), 'Unconfirmed work occurred before private readiness');
  } else assert.deepEqual(between, [], 'A guard readiness summary must follow its full active identity');
  assert.equal(ready?.schema, 'multiview-works-ready.v1'); assert.equal(ready.kind, last.kind);
  assert.equal(ready.unit, NAME); assert.equal(ready.naturalExit, true);
  for (const [key, expected] of Object.entries({ source: m[last.kind].source, version: m[last.kind].version })) assert.equal(ready[key], expected);
  const identityFields = ['MainPID', 'ControlPID', 'ControlGroup', 'InvocationID', 'WorkingDirectory', 'ActiveState', 'SubState'];
  assert.deepEqual(Object.keys(ready.current).sort(), [...identityFields].sort());
  for (const key of identityFields) assert.equal(ready.current[key], active.current[key]);
  for (const key of ['pid', 'parentPid', 'sourceRoot', 'source', 'version', 'build', 'startedAt']) assert.equal(ready.runtime[key], active.runtime[key]);
  assert.deepEqual(ready.runtime.loadedModuleSha, active.runtime.loadedModuleSha);
  assert.equal(Object.keys(ready.runtime.loadedModuleSha).length, SOURCES.length);
  assert.equal(ready.runtime.build, ready.build);
  if (last.kind === 'main') {
    for (const key of identityFields) assert.equal(confirmation.works.current[key], ready.current[key]);
    for (const key of ['pid', 'parentPid', 'sourceRoot', 'source', 'version', 'build', 'startedAt']) assert.equal(confirmation.works.runtime[key], ready.runtime[key]);
    assert.deepEqual(confirmation.works.runtime.loadedModuleSha, ready.runtime.loadedModuleSha);
  }
  const times = [active.at, ready.at, ...(confirmation ? [confirmation.at] : []), last.at].map(Date.parse);
  assert.ok(times.every(value => Number.isFinite(value) && value <= Date.now()));
  assert.ok(times.every((value, i) => i === 0 || value >= times[i - 1]), 'Works readiness records are out of order');
  return active;
}
// Keep the escaped-writer check strict: drain only the manifest-bound baseline
// or same-run admitted works lifecycle before proving all writer groups empty.
export async function stopMultiviewWorksForGuardRecovery(m, check) {
  if (!MV_DIRECT.privateMultiviewInstall) return { untouched: true };
  assertLock(m, check);
  const untouched = journals(m).length === 0, captured = capture(m), current = service();
  assertUnit(m, captured, current);
  if (current.ActiveState === 'active' || current.ActiveState === 'deactivating') {
    const entries = journals(m);
    if (untouched) {
      for (const key of ['MainPID', 'InvocationID', 'ControlGroup', 'WorkingDirectory'])
        assert.equal(current[key], captured.current[key], 'Original works identity drifted before recovery drain');
    } else {
      const last = entries.findLast(entry => entry.phase === 'active');
      const ready = last && !last.current ? binding(m, json(m.stage + '/multiview-works-ready-' + last.kind + '.json')) : null;
      const confirmation = last?.privateReady ? binding(m, json(m.stage + '/multiview-private-preopen-complete.json')) : null;
      const active = assertWorksRecoveryActive(m, entries, ready, confirmation);
      for (const key of ['MainPID', 'InvocationID', 'ControlGroup', 'WorkingDirectory', 'ExecMainStartTimestampMonotonic'])
        assert.equal(current[key], active.current[key], 'Admitted works identity drifted before recovery drain');
      assert.equal(current.WorkingDirectory, m[active.kind].root);
      if (current.ActiveState === 'active') verifyRunning(m, captured, active.kind);
      else assert.ok(entries.some(entry => entry.phase === 'stop-intent'
        && entry.current.MainPID === current.MainPID && entry.current.InvocationID === current.InvocationID),
      'A deactivating works consumer requires its recorded natural-stop intent');
    }
  } else inspectMultiviewWorksProtection(m);
  const beforePids = groupPids(current.ControlGroup || captured.current.ControlGroup);
  await stop(m, captured, check); assertLock(m, check);
  const after = service();
  assert.equal(after.MainPID, '0'); assert.equal(after.ControlPID, '0');
  assert.deepEqual(groupPids(captured.current.ControlGroup), []);
  for (const pid of beforePids) assert.equal(exists('/proc/' + pid), false, 'Admitted works process remains after natural drain');
  inspectMultiviewWorksProtection(m);
  const value = { schema: 'multiview-works-fixed-guard-drain.v1', runId: m.runId, manifestSha256: manifestSha(m),
    before: current, beforePids, after, at: new Date().toISOString(), allAdmittedProcessesGone: true,
    naturalExit: after.Result === 'success' && after.ExecMainStatus === '0' && ['1', 'exited'].includes(after.ExecMainCode),
    originalNaturalExitRetained: journals(m).some(entry => entry.phase === 'stopped' && entry.naturalExit === true), forcedKill: false };
  record(m, 'fixed-guard-natural-drain', value); return value;
}

export async function finishPrivateMultiviewPreopen(m, context) {
  if (!MV_DIRECT.privateMultiviewInstall) return { notRequested: true };
  const check = () => assertReleaseWindow(m); assertLock(m, check);
  if (context.kind !== 'main') return ensurePrivateMultiviewGuard(m, check);
  const captured = capture(m); await start(m, captured, 'main', check);
  const ready = verifyRunning(m, captured, 'main');
  const directory = m.stage + '/private-recipe', payload = directory + '/payload.json', guide = directory + '/guide.png';
  freshGuideInventory(m, payload);
  const maintenance = await context.observeMaintenance(); assert.ok(maintenance.length >= 2 && maintenance.every(item => item.status === 503));
  const preOpen = { schema: 'multiview-private-preopen.v1', stage: 'private-preopen', runId: m.runId, manifestSha256: manifestSha(m),
    kind: 'main', mode: 'switch', healthy: context.healthy, web: context.web, maintenance, at: new Date().toISOString() };
  writeJsonExclusive(m.stage + '/multiview-private-preopen.json', preOpen);
  const backupControl = publishMultiviewBackupControl(m);
  let installed;
  const adopted = inspectInstalledMultiviewRecipeAdoption(m);
  if (adopted) {
    check(); record(m, 'recipe-adopt-intent', { sourceRun: adopted.sourceRun, originalInstallReceiptSha256: adopted.originalInstallReceiptSha256 });
    installed = inspectInstalledMultiviewRecipeAdoption(m);
    assert.deepEqual(installed, adopted); assert.equal(installed.adopted, true); assert.equal(installed.businessWrites, 0);
    writeJsonExclusive(m.stage + '/multiview-private-recipe-adopted.json', { schema: 'multiview-private-recipe-adopted.v1',
      runId: m.runId, manifestSha256: manifestSha(m), ...installed });
    record(m, 'recipe-adopted', { revision: installed.revision, version: installed.version, businessWrites: 0 });
  } else {
    const admission = writeAdmission(m, preOpen, m.stage + '/multiview-works-ready-main.json');
    authorizeRecipeTransition(m, payload);
    check(); record(m, 'recipe-install-intent', { admitted: true });
    installed = privateCommand(m, 'apply', ['--payload-file', payload, '--guide-file', guide, '--plan-file', directory + '/plan.json',
      '--verification-file', directory + '/verification.json', '--admission-file', admission, '--receipt-file', directory + '/apply.json']);
    assert.equal(installed.applied, true); record(m, 'recipe-installed', { revision: installed.revision, version: installed.version });
  }
  const backup = '/data/video-api-debugger/backups/multiview-private-' + m.runId;
  const output = JSON.parse(call('python3', ['-I', m.main.root + '/scripts/backup-multiview-works.py', '--database', m.database,
    '--source-root', '/data/video-api-debugger/var-lib/storage/multiview-works', '--destination', backup], { timeout: 240000 }));
  assert.equal(output.complete, true); assert.equal(output.directory, backup);
  const isolatedCopy = createMultiviewIsolatedBackupCopy(m, backup);
  const restored = JSON.parse(call('python3', ['-I', m.main.root + '/scripts/backup-multiview-works.py', '--verify-backup', isolatedCopy.directory, '--non-production'], { timeout: 240000 }));
  assert.equal(restored.verified, true); assert.equal(restored.directory, isolatedCopy.directory); assert.ok(restored.recipeVersions >= 1);
  inspectMultiviewBackupProtection(m);
  const final = verifyRunning(m, captured, 'main');
  const result = { schema: 'multiview-private-preopen-complete.v1', runId: m.runId, manifestSha256: manifestSha(m),
    source: m.mainSource, build: preOpen.healthy.build, recipe: installed, works: final, backupControl, backup: output, isolatedCopy, isolatedRestore: restored,
    maintenance: await context.observeMaintenance(), at: new Date().toISOString(), readyToOpen: true };
  check(); writeJsonExclusive(m.stage + '/multiview-private-preopen-complete.json', result); record(m, 'active', { kind: 'main', privateReady: true });
  return result;
}
export async function ensurePrivateMultiviewGuard(m, check = () => assertReleaseWindow(m)) {
  if (!MV_DIRECT.privateMultiviewInstall || !journals(m).length) return { untouched: true };
  inspectMultiviewBackupProtection(m);
  assertLock(m, check); const captured = original(m);
  const current = service();
  if (current.ActiveState === 'active') {
    for (const kind of ['main', 'guard']) try { return { preservedCompatibleConsumer: true, kind, ...verifyRunning(m, captured, kind) }; } catch { /* Only exact compatible sources may be retained. */ }
  }
  const result = await start(m, captured, 'guard', check);
  record(m, 'active', { kind: result.kind, guardSafe: true }); return result;
}
