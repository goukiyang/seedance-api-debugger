import { applyFullSchema, publishLegacyReuseWriterProof, readFullLiveSourceFiles, verifyCompletedFullSchemaHeartbeat } from './full-release-contract.mjs';
import { inspectRecoveryCertificate } from './certificate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateManifest, assertReleaseWindow, readProtection, assertProtection,
  writeJsonExclusive, call, unit, rootFile, sha, liveArtifactSource, rejectedPricingRoots, parseReleaseTimestamp, isSharedEngine, engineDirectory, sharedReadOnlyHdBounds } from './common.mjs';
import { verifyCandidate } from './candidate.mjs';
import { verifyNormalContinuation, recordHdAdmission, recordNormalRefusal, assertFreshLegacyCapture, assertFreshPricingCapture } from './normal-continuation.mjs';
import { readDeployedUsageEvidence, assertPriorUsageRoleControl, readPublishedBaselineSourceFiles } from './deployed-usage-schema.mjs';
import { applyCanvasBatchMigration, readCanvasBatchMigration } from './canvas-batch-schema.mjs';
import { capturePricingStartControl, buildPair, publishPricingStartPair, markPricingWriterStartIntent,
  PRICING_START_CONTROL } from './pricing-start-pair.mjs';
import { captureNginxMaintenance, installNginxMaintenance, restoreNginxMaintenance,
  rearmOwnedNginxMaintenance, captureNginxUpstreamSockets } from './nginx-maintenance.mjs';
import { captureLegacyWriterContracts } from './legacy-maintenance.mjs';
import { verifyUploadPrivateDirectory } from './upload-directory-preflight.mjs';
import { inspectHdReconciliation, inspectHdBeforeMaintenance, readHdStorageProtection, assertHdStorageProtection,
  probeHdCandidateResolver } from './hd-storage-preflight.mjs';
import { armGuardRecovery, readGuardRecovery, inspectGuardRecoveryControl, verifyGuardRecovery, runGuardRecovery, markFixedGuardStart } from './guard-recovery.mjs';
import { MV_DIRECT } from './release-contract.mjs';
import { assertFreshCandidateEvidence, candidateEvidenceFile, candidateEvidenceExpiresAt, candidateCompatibilityDirectory, hdMaintenanceApprovalFile, guardRecoveryApprovalFile, assertSwitchAdmissionRepair, guardBuildTailRuntime,
  operationalLive, operationalRecordName, operationalBeforeFile, operationalNginxRunId, operationalNginxStage } from './candidate-evidence.mjs';
import { originalPreparedFile, originalManifestForInputs, assertRuntimeAliasUnchanged } from './candidate-reuse.mjs';
import { captureUsageRole, stopUsageRole, startUsageRole, assertUsageRoleStopped, inspectUsageRoleAdmission,
  restoreOriginalUsageRole, usageRoleProof, captureRestoredUsageRole } from './usage-role-control.mjs';
import { finishPrivateMultiviewPreopen, ensurePrivateMultiviewGuard, stopMultiviewWorksForGuardRecovery } from './multiview-works-control.mjs';
import { inspectMultiviewBackupProtection, privateMultiviewBackupFileProtection } from './multiview-backup-control.mjs';
import { loadHdCompiledCacheProofs } from './hd-compiled-cache.mjs';
import { releaseBoundary } from './engine-context.mjs';
import { assertTypedFileUnchanged } from './typed-files.mjs';

const PRICING_ROLES = ['web', 'image'];
const ROLES = [...PRICING_ROLES, 'hd'];
const CWD_FILES = { web: '/etc/systemd/system/sd2-gray.service.d/default01-web.conf',
  image: '/etc/systemd/system/sd2-image-studio.service.d/imgapi-cwd.conf',
  hd: '/etc/systemd/system/sd2-hd-derivatives.service.d/hd-source.conf' };
const HD_EXEC_START = '/usr/bin/flock --no-fork -n /srv/video-api-debugger/app/storage/hd-worker.lock /usr/bin/node --import tsx scripts/process-hd-derivatives.ts worker';
const HD_LEGACY_FILES = { 'scripts/process-hd-derivatives.ts': '037904c2e9e18794eb745387d29da7d2e30eee1c1170f432468a73d4c63ce57d',
  'src/lib/media/hd-derivatives.ts': '7442f68dd8ce7db49390293e722107c2bc57b72ea43976541427978076858fbf' };
const CAPABILITY = 'pricing-authoring-v1:video-scope-v1:image-spec-v1:image-quality-route-v1';
const CLEAN = { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' };
const POLICY_KEYS = ['User', 'Restart', 'RestartUSec', 'KillMode', 'KillSignal', 'SendSIGKILL',
  'TimeoutStopUSec', 'Environment'];
const NETWORK_KEYS = ['IPAddressAllow', 'IPAddressDeny', 'IPIngressFilterPath', 'IPEgressFilterPath'];
const FENCE_NETWORK_FILES = [
  '/run/systemd/system.control/sd2-gray.service.d/50-IPAddressAllow.conf',
  '/run/systemd/system.control/sd2-gray.service.d/50-IPAddressDeny.conf',
];
const SAFETY_PROTOCOL = 'hd-release-safety-v1';
const START_KEYS = ['ExecMainPID', 'ExecMainStartTimestamp', 'ExecMainStartTimestampMonotonic'];
const TARGETS = [
  { host: 'sd2.youdooart.com', origin: 'https://sd2.youdooart.com', resolve: 'sd2.youdooart.com:443:127.0.0.1' },
  { host: 'sd2-server.youdoodesign.com', origin: 'http://sd2-server.youdoodesign.com', resolve: 'sd2-server.youdoodesign.com:80:127.0.0.1' },
];
const json = file => JSON.parse(rootFile(file));
const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
function context(m) {
  validateManifest(m); assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  assert.equal(fs.realpathSync(m.stage), m.stage);
  const stage = fs.lstatSync(m.stage);
  assert.ok(stage.isDirectory() && stage.uid === 0 && !(stage.mode & 0o077));
  const bytes = rootFile(m.stage + '/manifest.json'); assert.deepEqual(JSON.parse(bytes), m);
  for (const file of [m.stage, m.database, m.storageRoot, m.uploadsRoot, m.videosRoot]) {
    assert.equal(call('findmnt', ['-n', '-o', 'TARGET', '-T', file]), '/data');
  }
  for (const file of Object.values(CWD_FILES)) assert.ok(!m.protectedFiles.includes(file), 'An intentionally changed cwd file cannot be a protected constant');
  verifyUploadPrivateDirectory(m);
  return { manifestSha256: sha(bytes) };
}
function save(m, name, value) {
  assert.match(name, /^[a-zA-Z0-9_.-]+$/);
  const file = m.stage + '/' + name + '.json';
  writeJsonExclusive(file, { runId: m.runId, ...value }); return file;
}
function boundRecord(m, name, manifestSha256) {
  const value = json(m.stage + '/' + name + '.json');
  assert.equal(value.runId, m.runId); assert.equal(value.manifestSha256, manifestSha256); return value;
}
export function normalizeEmptyHdExecStartPre(role, name, observed, readProperty = () => call('/usr/bin/busctl', [
  'get-property', 'org.freedesktop.systemd1',
  '/org/freedesktop/systemd1/unit/sd2_2dhd_2dderivatives_2eservice',
  'org.freedesktop.systemd1.Service', 'ExecStartPre'])) {
  if (Object.hasOwn(observed, 'ExecStartPre')) return observed;
  assert.equal(role, 'hd', 'Missing ExecStartPre is not allowed for pricing writers');
  assert.equal(name, 'sd2-hd-derivatives.service', 'Only the fixed HD unit may use an empty exec observation');
  assert.equal(readProperty(), 'a(sasbttttuii) 0', 'HD ExecStartPre must be a proven empty native D-Bus array');
  return { ...observed, ExecStartPre: '' };
}
export function service(m, role) {
  const name = m.live[role].unit, base = unit(name);
  const keys = [...POLICY_KEYS, ...NETWORK_KEYS, ...START_KEYS, 'ExecStartPre', 'ControlGroup', 'FragmentPath', 'DropInPaths', 'ExecMainCode', 'ExecMainStatus'];
  const extra = normalizeEmptyHdExecStartPre(role, name, Object.fromEntries(call('systemctl', ['show', '--all', name, ...keys.flatMap(key => ['-p', key])]).split('\n')
    .map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; })));
  for (const key of keys) assert.ok(Object.hasOwn(extra, key), 'Incomplete unit observation: ' + key);
  return { ...base, ...extra };
}
function processState(pid, cwd = false) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const text = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  assert.ok(text.startsWith(pid + ' (') && !['Z', 'X', 'x'].includes(fields[0]));
  assert.match(fields[19], /^\d+$/); assert.match(fields[1], /^\d+$/);
  return { pid, start: fields[19], parentPid: Number(fields[1]), ...(cwd ? { cwd: fs.realpathSync('/proc/' + pid + '/cwd') } : {}) };
}
function regularBytes(file) {
  assert.equal(fs.realpathSync(file), file);
  const stat = fs.lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  return fs.readFileSync(file);
}
export function originalRuntimeBuild(old) {
  assert.equal(liveArtifactSource(old.root), old.source);
  const root = fs.realpathSync(old.root + '/.next-prod');
  assert.equal(root, old.root + '/.next-prod-candidate', 'Original build alias leaves its fixed runtime artifact');
  assert.equal(regularBytes(root + '/BUILD_ID').toString('utf8').trim(), old.build);
  const app = JSON.parse(regularBytes(root + '/app-build-manifest.json'));
  const asset = app.pages['/multiview/page'].find(file => file.endsWith('.js'));
  assert.ok(asset.startsWith('static/') && path.resolve(root, asset).startsWith(root + '/static/'));
  return { root, asset, expected: sha(regularBytes(root + '/' + asset)) };
}
export function protectedFileSnapshot(file) {
  const real = fs.realpathSync(file), before = fs.lstatSync(file);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    const opened = fs.fstatSync(fd); assert.equal(opened.dev, before.dev); assert.equal(opened.ino, before.ino);
    bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key]);
  } finally { fs.closeSync(fd); }
  const after = fs.lstatSync(file);
  for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key]);
  assert.equal(fs.realpathSync(file), real);
  return { file, real, dev: String(before.dev), ino: String(before.ino), uid: before.uid, gid: before.gid,
    mode: before.mode & 0o7777, nlink: before.nlink, sha256: sha(bytes) };
}
function program(root) {
  assert.equal(fs.realpathSync(root), root);
  return { root, source: regularBytes(root + '/.deployed-commit').toString('utf8').trim(),
    version: JSON.parse(regularBytes(root + '/package.json')).version,
    build: fs.readFileSync(root + '/.next-prod/BUILD_ID', 'utf8').trim() };
}
function approved(m, kind) {
  const value = json(PRICING_START_CONTROL + '/allowed.json');
  assert.equal(value.schema, 'pricing-writer-start-allowlist.v1'); assert.equal(value.runId, m.runId);
  assert.equal(value.releases.length, 2);
  for (const name of ['main', 'guard']) {
    const entry = value.releases.find(item => item.source === m[name].source); assert.ok(entry);
    assert.equal(entry.root, m[name].root); assert.equal(entry.version, m[name].version);
  }
  return value.releases.find(entry => entry.source === m[kind].source);
}
function assertRestoredLiveRole(m, role, expected) {
  for (const key of ['unit', 'root', 'source', 'version', 'build']) assert.equal(expected[key], m.live[role][key], 'Restored observation changed the sealed role: ' + role + ':' + key);
  assert.ok(Number.isSafeInteger(expected.pid) && expected.pid > 1);
  assert.match(expected.invocation || '', /^[a-f0-9]{32}$/);
  assert.match(expected.kernelStartTicks || '', /^[1-9]\d*$/);
  assert.match(expected.execMainStartTimestampMonotonic || '', /^[1-9]\d*$/);
}
function running(m, role, kind = null, overrideExpected) {
  if (overrideExpected) {
    assert.equal(kind, null, 'Restored observation cannot override a candidate identity');
    assertRestoredLiveRole(m, role, overrideExpected);
  }
  const state = service(m, role), expected = overrideExpected || (kind ? m[kind] : operationalLive(m, role));
  assert.equal(state.ActiveState, 'active'); assert.equal(state.SubState, 'running'); assert.equal(state.ControlPID, '0');
  assert.equal(state.User, m.appUser);
  assert.equal(fs.realpathSync(state.WorkingDirectory), expected.root);
  const instance = processState(Number(state.MainPID), true); assert.equal(instance.cwd, expected.root);
  assert.match(state.InvocationID, /^[a-f0-9]{32}$/);
  const actual = role === 'hd' && !kind ? { root: instance.cwd, source: liveArtifactSource(instance.cwd),
    version: JSON.parse(regularBytes(instance.cwd + '/package.json')).version,
    build: fs.readFileSync(instance.cwd + '/.next-prod/BUILD_ID', 'utf8').trim() } : program(instance.cwd);
  assert.equal(actual.source, expected.source); assert.equal(actual.version, expected.version);
  if (kind) {
    assert.equal(fs.realpathSync(actual.root + '/.next-prod'), actual.root + '/' + m[kind].buildDist);
    assert.equal(actual.build, approved(m, kind).build);
  }
  if (!kind) {
    assert.equal(actual.build, expected.build); assert.equal(instance.pid, expected.pid); assert.equal(state.InvocationID, expected.invocation);
    if (expected.kernelStartTicks !== undefined) {
      assert.equal(instance.start, expected.kernelStartTicks); assert.equal(state.ExecMainStartTimestampMonotonic, expected.execMainStartTimestampMonotonic);
    }
  }
  const confirmed = service(m, role);
  assert.equal(confirmed.MainPID, state.MainPID); assert.equal(confirmed.InvocationID, state.InvocationID);
  return { ...actual, pid: instance.pid, start: instance.start, invocation: state.InvocationID, state };
}
function environmentMap(text) {
  const pairs = JSON.parse(call('python3', ['-I', '-c', 'import shlex,json,sys; print(json.dumps([v.split("=",1) for v in shlex.split(sys.argv[1])]))', text]));
  assert.ok(pairs.every(value => value.length === 2 && /^[A-Za-z_][A-Za-z_0-9]*$/.test(value[0])));
  assert.equal(new Set(pairs.map(value => value[0])).size, pairs.length);
  return Object.fromEntries(pairs.sort(([a], [b]) => a.localeCompare(b)));
}
function rootSnapshot(file) {
  const bytes = rootFile(file), s = fs.lstatSync(file);
  return { file, dev: String(s.dev), ino: String(s.ino), uid: s.uid, gid: s.gid, mode: s.mode & 0o7777,
    nlink: s.nlink, sha256: sha(bytes), bytesBase64: bytes.toString('base64') };
}
function policy(m, role) {
  const state = service(m, role), files = state.DropInPaths.split(/\s+/).filter(Boolean).sort();
  assert.equal(state.User, m.appUser); assert.equal(state.KillSignal, '15');
  assert.ok(['control-group', 'mixed'].includes(state.KillMode), 'Natural stop must cover the whole writer group');
  assert.ok(files.includes(CWD_FILES[role]));
  if (role !== 'hd') assert.ok(state.ExecStartPre.includes(PRICING_START_CONTROL + '/writer-start-guard.mjs'));
  return { values: Object.fromEntries(POLICY_KEYS.map(key => [key, state[key]])), fragment: rootSnapshot(state.FragmentPath),
    network: Object.fromEntries(NETWORK_KEYS.map(key => [key, state[key]])), dropins: files.map(rootSnapshot) };
}
export function cwdBytes(m, before, role, root) {
  const original = before.policies[role].dropins.find(file => file.file === CWD_FILES[role]); assert.ok(original);
  let count = 0;
  let text = Buffer.from(original.bytesBase64, 'base64').toString('utf8').split('\n').map(line => {
    if (line === 'WorkingDirectory=' + m.live[role].root) { count++; return 'WorkingDirectory=' + root; }
    return line;
  }).join('\n');
  assert.equal(count, 1, 'Only the existing dedicated WorkingDirectory line may change');
  if (root === m.live[role].root) return Buffer.from(text);
  assert.ok([m.main.root, m.guard.root].includes(root));
  if (m.fullRelease) {
    const kind = root === m.main.root ? 'main' : 'guard';
    text = text.split('\n').filter(line => !/^Environment=VIDEO_CREATION_FLOW_V2_ENABLED=/.test(line)).join('\n');
    text = text.trimEnd() + '\nEnvironment=VIDEO_CREATION_FLOW_V2_ENABLED=' + (m.fullRelease.capabilities[kind].videoCreationV2 ? '1' : '0') + '\n';
  }
  assert.ok(!text.includes('HD_DERIVATIVES_DIR='), 'Unexpected legacy HD root override');
  const lines = text.split('\n');
  const roots = lines.filter(line => line.includes('HD_DERIVATIVES_ROOT='));
  assert.deepEqual(roots, ['Environment=HD_DERIVATIVES_ROOT=' + m.hdRoot], 'Existing HD root must remain exactly canonical');
  const starts = lines.filter(line => line.startsWith('ExecStart='));
  assert.deepEqual(starts, role === 'hd' ? ['ExecStart=', 'ExecStart=' + HD_EXEC_START] : [],
    'Existing canonical HD startup must retain its original lock and command');
  return Buffer.from(text);
}
function assertPolicy(m, before, temporary = null) {
  for (const role of ROLES) {
    const current = policy(m, role), original = before.policies[role], own = temporary?.files[role];
    assert.deepEqual(current.fragment, original.fragment);
    const fence = role === 'web' ? temporary?.fenceNetworkFiles : null;
    if (fence) {
      assert.ok(Array.isArray(fence));
      assert.deepEqual(fence.map(file => file.file).sort(), FENCE_NETWORK_FILES);
      for (const file of fence) {
        assert.deepEqual(current.dropins.find(item => item.file === file.file), file);
        assert.deepEqual(rootSnapshot(file.file), file, 'Owned Web network fence changed');
      }
      assert.equal(current.network.IPAddressAllow, '');
      assert.deepEqual(current.network.IPAddressDeny.trim().split(/\s+/).filter(Boolean).sort(), ['0.0.0.0/0', '::/0']);
      for (const key of ['IPIngressFilterPath', 'IPEgressFilterPath']) assert.equal(current.network[key], original.network[key]);
    } else assert.deepEqual(current.network, original.network);
    const fencePaths = new Set((fence || []).map(file => file.file));
    const actual = current.dropins.filter(file => file.file !== own?.file && !fencePaths.has(file.file));
    assert.deepEqual(actual.map(file => file.file), original.dropins.filter(file => !fencePaths.has(file.file)).map(file => file.file));
    for (const file of actual) {
      const previous = original.dropins.find(item => item.file === file.file);
      if (file.file !== CWD_FILES[role]) assert.deepEqual(file, previous);
      else {
        for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink']) assert.equal(file[key], previous[key]);
        assert.ok([m.live[role].root, m.main.root, m.guard.root].some(root => sha(cwdBytes(m, before, role, root)) === file.sha256));
      }
    }
    if (own) assert.deepEqual(current.dropins.find(file => file.file === own.file), own);
    const cwdFile = current.dropins.find(file => file.file === CWD_FILES[role]);
    const candidateMode = [m.main.root, m.guard.root].some(root => sha(cwdBytes(m, before, role, root)) === cwdFile.sha256);
    const expected = own ? { ...original.values, Restart: 'no', KillSignal: '15', SendSIGKILL: 'no', TimeoutStopUSec: 'infinity' } : { ...original.values };
    const expectedEnvironment = environmentMap(original.values.Environment);
    if (candidateMode) expectedEnvironment.HD_DERIVATIVES_ROOT = m.hdRoot;
    if (candidateMode && m.fullRelease) {
      const kind = sha(cwdBytes(m, before, role, m.main.root)) === cwdFile.sha256 ? 'main' : 'guard';
      expectedEnvironment.VIDEO_CREATION_FLOW_V2_ENABLED = m.fullRelease.capabilities[kind].videoCreationV2 ? '1' : '0';
    }
    assert.deepEqual(environmentMap(current.values.Environment), Object.fromEntries(Object.entries(expectedEnvironment).sort(([a], [b]) => a.localeCompare(b))));
    assert.deepEqual({ ...current.values, Environment: '' }, { ...expected, Environment: '' });
  }
}
function noForceBytes(m) {
  return Buffer.from('# RATE-IMPL2 natural stop ' + m.runId + '\n[Service]\nRestart=no\nKillSignal=SIGTERM\nSendSIGKILL=no\nTimeoutStopSec=infinity\n');
}
function installNoForce(m, before, manifestSha256, mode, check = assertReleaseWindow) {
  const paths = Object.fromEntries(ROLES.map(role => [role, '/run/systemd/system/' + m.live[role].unit + '.d/rate-impl2-' + m.runId + '.conf']));
  const present = ROLES.filter(role => exists(paths[role]));
  if (present.length) {
    assert.equal(present.length, ROLES.length, 'Partial writer policy installation needs lead diagnosis');
    const previous = boundRecord(m, operationalRecordName(m, 'writer-no-force-switch'), manifestSha256);
    for (const role of ROLES) assert.deepEqual(rootSnapshot(paths[role]), previous.files[role]);
    assertPolicy(m, before, previous); return previous;
  }
  assertPolicy(m, before);
  const installationWriters = Object.fromEntries(ROLES.map(role => [role, service(m, role)]));
  const files = {};
  try {
  for (const role of ROLES) {
    check(m);
    const directory = path.dirname(paths[role]);
    if (!exists(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    assert.equal(fs.realpathSync(directory), directory);
    const stat = fs.lstatSync(directory); assert.ok(stat.isDirectory() && stat.uid === 0 && !(stat.mode & 0o022));
    const fd = fs.openSync(paths[role], fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
    try {
      fs.writeFileSync(fd, role === 'hd' ? Buffer.concat([noForceBytes(m), Buffer.from('\n[Unit]\nRefuseManualStart=yes\n')]) : noForceBytes(m)); fs.fsyncSync(fd);
    } finally {
      try {
        const owned = fs.fstatSync(fd);
        files[role] = rootSnapshot(paths[role]);
        assert.equal(String(owned.dev), files[role].dev); assert.equal(String(owned.ino), files[role].ino);
      } finally { fs.closeSync(fd); }
    }
    save(m, operationalRecordName(m, 'writer-no-force-install-progress-' + mode + '-' + role), { manifestSha256, files });
  }
  call('systemctl', ['daemon-reload']);
  const record = { manifestSha256, files }; save(m, operationalRecordName(m, 'writer-no-force-' + mode), record);
  assert.equal(call('systemctl', ['show', m.live.hd.unit, '-p', 'RefuseManualStart', '--value']), 'yes');
  assertPolicy(m, before, record); return record;
  } catch (cause) {
    // No stop/start is allowed during installation. Only this run's exact
    // captured objects can be removed, even if daemon-reload was ambiguous.
    try {
      for (const role of ROLES) {
        assert.equal(exists(m.stage + '/' + operationalRecordName(m, 'natural-stop-intent-' + mode + '-' + role) + '.json'), false);
        const state = service(m, role), original = installationWriters[role];
        for (const key of ['MainPID', 'InvocationID', 'WorkingDirectory']) assert.equal(state[key], original[key]);
        assert.equal(state.ActiveState, 'active');
      }
      for (const item of Object.values(files)) {
        assert.deepEqual(rootSnapshot(item.file), item); fs.unlinkSync(item.file);
      }
      call('systemctl', ['daemon-reload']); assertPolicy(m, before);
      assert.equal(call('systemctl', ['show', m.live.hd.unit, '-p', 'RefuseManualStart', '--value']), 'no');
      save(m, operationalRecordName(m, 'writer-no-force-install-aborted-' + mode), { manifestSha256, files, originalPoliciesRestored: true, noStopsRequested: true });
    } catch (recovery) {
      throw new AggregateError([cause, recovery], 'Partial writer policy installation could not be safely restored', { cause });
    }
    throw cause;
  }
}
function groupPids(group) {
  assert.ok(typeof group === 'string' && group.startsWith('/system.slice/') && !group.split('/').includes('..'));
  const root = '/sys/fs/cgroup' + group;
  if (!exists(root)) return [];
  const pending = [root], result = new Set(); let scanned = 0;
  while (pending.length) {
    const directory = pending.pop(); assert.ok(++scanned <= 256, 'Writer cgroup tree exceeds the reviewed bound');
    assert.equal(fs.realpathSync(directory), directory);
    for (const pid of fs.readFileSync(directory + '/cgroup.procs', 'utf8').trim().split(/\s+/).filter(Boolean)) {
      assert.match(pid, /^\d+$/); result.add(pid);
    }
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      assert.equal(item.isSymbolicLink(), false); if (item.isDirectory()) pending.push(path.join(directory, item.name));
    }
  }
  return [...result].sort();
}
export function assertNaturalExitEvidence(state, original, { originalPidPresent, originalGroupPids, unitGroupPids }) {
  assert.equal(state.MainPID, '0'); assert.equal(state.ControlPID, '0');
  assert.equal(state.ActiveState, 'inactive'); assert.equal(state.Result, 'success');
  assert.ok([original.InvocationID, ''].includes(state.InvocationID));
  const retained = START_KEYS.every(key => state[key] === original[key]);
  const unloaded = state.ExecMainPID === '0' && !state.ExecMainStartTimestamp && state.ExecMainStartTimestampMonotonic === '0';
  assert.ok(retained || unloaded, 'An original writer invocation changed');
  assert.equal(originalPidPresent, false, 'The original PID has not gone');
  assert.deepEqual(originalGroupPids, []); assert.deepEqual(unitGroupPids, []);
  return true;
}
function stopped(m, role, original = null) {
  const state = service(m, role);
  assert.equal(state.MainPID, '0'); assert.equal(state.ControlPID, '0');
  assert.ok(['inactive', 'failed'].includes(state.ActiveState));
  if (state.ControlGroup) assert.deepEqual(groupPids(state.ControlGroup), []);
  assert.deepEqual(groupPids('/system.slice/' + m.live[role].unit), []);
  if (original) {
    assertNaturalExitEvidence(state, original, { originalPidPresent: exists('/proc/' + original.MainPID),
      originalGroupPids: groupPids(original.ControlGroup), unitGroupPids: groupPids('/system.slice/' + m.live[role].unit) });
  }
  return state;
}
async function waitFor(m, description, predicate, milliseconds = 90000, check = assertReleaseWindow, pendingCode = null) {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    check(m);
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      const error = new Error((typeof description === 'function' ? description() : description)
        + '; no forced shutdown or old-writer restart is authorized');
      if (pendingCode) error.code = pendingCode; throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
async function waitForOriginalRecovery(m, description, predicate, milliseconds = 90000) {
  // Waiting for a requested old stop, or restoring the deployed old program,
  // does not authorize a new publication or renew its expired window.
  assert.equal(m.runId, MV_DIRECT.recoveryRunId);
  const deadline = Date.now() + milliseconds;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw Object.assign(new Error(description + '; no forced shutdown or policy restoration while deactivating'), { code: 'NATURAL_STOP_PENDING' });
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
async function stopNaturally(m, before, temporary, role, mode, original, check = assertReleaseWindow) {
  assertPolicy(m, before, temporary); check(m);
  const initial = service(m, role);
  if (original) {
    assert.equal(initial.InvocationID, original.InvocationID); assert.equal(initial.MainPID, original.MainPID);
    assert.equal(initial.WorkingDirectory, original.WorkingDirectory);
    for (const key of START_KEYS) assert.equal(initial[key], original[key]);
  } else assert.ok([m.main.root, m.guard.root].includes(fs.realpathSync(initial.WorkingDirectory)));
  assert.equal(initial.SendSIGKILL, 'no'); assert.equal(initial.TimeoutStopUSec, 'infinity');
  assert.equal(initial.Restart, 'no'); assert.equal(initial.KillSignal, '15');
  save(m, operationalRecordName(m, 'natural-stop-intent-' + mode + '-' + role), { manifestSha256: before.manifestSha256,
    before: initial, capturedOriginal: original, requestedAt: Date.now(), signal: 'SIGTERM', forcedKill: false });
  call('systemctl', ['stop', '--no-block', m.live[role].unit]);
  let result;
  await waitFor(m, 'Natural ' + role + ' shutdown is incomplete', () => {
    const current = service(m, role);
    assert.equal(current.SendSIGKILL, 'no'); assert.equal(current.TimeoutStopUSec, 'infinity');
    if (original) {
      assert.ok(['active', 'deactivating', 'inactive'].includes(current.ActiveState));
      assert.ok([original.InvocationID, ''].includes(current.InvocationID));
      if (['active', 'deactivating'].includes(current.ActiveState)) for (const key of START_KEYS) assert.equal(current[key], original[key]);
    }
    if (!['inactive', 'failed'].includes(current.ActiveState) || current.MainPID !== '0' || current.ControlPID !== '0') return false;
    if (initial.ControlGroup && groupPids(initial.ControlGroup).length) return false;
    result = stopped(m, role, original);
    if (!original && Number(initial.MainPID) > 0) assert.ok(!exists('/proc/' + initial.MainPID));
    return true;
  }, 300000, check, check === assertReleaseWindow ? null : 'NATURAL_STOP_PENDING');
  save(m, operationalRecordName(m, 'natural-stop-' + mode + '-' + role), { manifestSha256: before.manifestSha256, before: initial, after: result,
    originalCgroup: initial.ControlGroup, forcedKill: false, completedAt: new Date().toISOString() });
  return result;
}
function assertOriginalStopped(m, before) {
  assertUsageRoleStopped(m);
  for (const role of ROLES) {
    const intent = boundRecord(m, operationalRecordName(m, 'natural-stop-intent-switch-' + role), before.manifestSha256);
    assert.deepEqual(intent.capturedOriginal, before.writers[role]);
    assert.equal(intent.signal, 'SIGTERM'); assert.equal(intent.forcedKill, false);
    stopped(m, role, before.writers[role]);
  }
}
function captureHdMetadata(m) {
  let bytes = 0;
  return Object.fromEntries([['canonical', m.hdRoot], ['fork', m.hdForkRoot]].map(([role, root]) => [role,
    Object.fromEntries(fs.readdirSync(root).filter(name => name.endsWith('.json')).sort().map(name => {
      assert.ok(/^[a-zA-Z0-9_.-]+\.json$/.test(name));
      const file = path.join(root, name), content = regularBytes(file); bytes += content.length;
      assert.ok(bytes <= 16 * 1024 * 1024, 'HD metadata exceeds the bounded private backup budget');
      return [name, { sha256: sha(content), bytesBase64: content.toString('base64') }];
    }))]));
}
export function captureHdLegacyContract(m) {
  assert.equal(m.live.hd.source, m.fullRelease ? m.fullRelease.liveRoles.hd.source : MV_DIRECT.baselineSource);
  assert.deepEqual(m.deployedUsageSchema || null, MV_DIRECT.deployedUsageSchema || null);
  const published = m.deployedUsageSchema ? readPublishedBaselineSourceFiles(m, Object.keys(HD_LEGACY_FILES), 'hd') : null;
  if (published) {
    assert.equal(published.source, m.live.hd.source); assert.equal(published.root, m.live.hd.root);
  }
  const sourceFiles = published?.sourceFiles || HD_LEGACY_FILES;
  const captured = Object.fromEntries(Object.entries(sourceFiles).map(([file, expected]) => {
    const actual = sha(regularBytes(path.join(m.live.hd.root, file)));
    assert.equal(actual, expected, 'The original HD complete-Promise shutdown source changed'); return [file, actual];
  }));
  const worker = regularBytes(path.join(m.live.hd.root, 'scripts/process-hd-derivatives.ts')).toString();
  for (const text of ["process.on('SIGTERM', stop);", 'shutdown ||= stopHdImageProcessors()',
    'await Promise.all([maintain(), encode()]);', 'await shutdown;'])
    assert.ok(worker.includes(text), 'HD complete-Promise shutdown contract changed');
  return captured;
}
export function projectPrivateMultiviewProtectedFileSnapshot(m, file, actual) {
  if (!MV_DIRECT.privateMultiviewInstall || file !== '/etc/systemd/system/sd2-backup.service.d/90-multiview-works.conf') return actual;
  // The common protection reader already admits only this run's fully verified
  // backup transition. Apply that same projection to this independent FD read;
  // never omit the path or accept an arbitrary changed inode/content.
  inspectMultiviewBackupProtection(m);
  const state = { identity: [actual.dev, actual.ino], uid: actual.uid, gid: actual.gid, mode: actual.mode,
    sha256: actual.sha256, attributes: call('lsattr', ['-d', '--', file]).split(/\s+/)[0] };
  const projected = privateMultiviewBackupFileProtection(m, file, state);
  return { ...actual, dev: projected.identity[0], ino: projected.identity[1], uid: projected.uid, gid: projected.gid,
    mode: projected.mode, sha256: projected.sha256 };
}
function assertProtected(m, before, installed = null) {
  const after = readProtection(m);
  for (const [file, state] of Object.entries(after.files)) {
    const actual = projectPrivateMultiviewProtectedFileSnapshot(m, file, protectedFileSnapshot(file));
    assert.deepEqual([actual.dev, actual.ino], state.identity);
    for (const key of ['uid', 'gid', 'mode', 'sha256']) assert.equal(actual[key], state[key]);
  }
  if (!installed) { assertProtection(before, after); return after; }
  const omitted = new Set(installed.files.map(file => file.file));
  for (const file of installed.files) {
    const actual = protectedFileSnapshot(file.file);
    assert.equal(actual.sha256, file.maintainedSha256);
    for (const key of ['dev', 'ino', 'uid', 'gid', 'mode']) assert.equal(actual[key], file.ownIdentity[key]);
    assert.equal(sha(rootFile(file.backup)), file.sha256);
  }
  // Only this run's two captured nginx files may differ during maintenance.
  const withoutNginx = value => ({ ...value, files: Object.fromEntries(Object.entries(value.files).filter(([file]) => !omitted.has(file))) });
  assertProtection(withoutNginx(before), withoutNginx(after)); return after;
}
function configure(m, before, temporary, kind, check = assertReleaseWindow) {
  check(m, kind); for (const role of ROLES) stopped(m, role);
  assertPolicy(m, before, temporary);
  for (const role of ROLES) {
    check(m, kind);
    const file = CWD_FILES[role], snapshot = rootSnapshot(file), bytes = cwdBytes(m, before, role, m[kind].root);
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd); assert.equal(String(stat.dev), snapshot.dev); assert.equal(String(stat.ino), snapshot.ino);
      assert.equal(stat.nlink, 1); assert.equal(sha(rootFile(file)), snapshot.sha256);
      fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    assert.equal(rootSnapshot(file).sha256, sha(bytes));
  }
  call('systemctl', ['daemon-reload']); assertPolicy(m, before, temporary);
  for (const role of ROLES) assert.equal(fs.realpathSync(service(m, role).WorkingDirectory), m[kind].root);
}
async function verifyBoth(m, manifestSha256) {
  const result = {};
  for (const kind of ['main', 'guard']) {
    const value = await verifyCandidate(m, kind);
    assertFreshCandidateEvidence(value, m, kind); assert.equal(value.label, kind);
    assert.equal(value.runId, m.runId); assert.equal(value.manifestSha256, manifestSha256);
    assert.equal(value.source, m[kind].source); assert.equal(value.version, m[kind].version);
    assert.equal(value.exitCode, 0); assert.equal(value.verifiedSourceAndGates, true);
    assert.ok(value.startedAt > 0 && value.finishedAt >= value.startedAt && value.finishedAt <= Date.now());
    result[kind] = value;
  }
  return result;
}
export function candidateInput(m, kind, buildProof) {
  const c = m[kind], link = c.root + '/.next-prod';
  if (!exists(link)) { assert.equal(Boolean(m.reuseBuilds), false, 'Reused build must retain its existing runtime alias'); fs.symlinkSync(c.buildDist, link); }
  if (m.reuseBuilds) assertRuntimeAliasUnchanged(m, kind, buildProof.runtimeAlias);
  assert.ok(fs.lstatSync(link).isSymbolicLink()); assert.equal(fs.realpathSync(link), c.root + '/' + c.buildDist);
  for (const [alias, target] of [['storage', m.storageRoot], ['public/uploads', m.uploadsRoot], ['public/videos', m.videosRoot], ['.env', m.envFile]]) {
    const file = path.join(c.root, alias); assert.ok(fs.lstatSync(file).isSymbolicLink());
    assert.equal(fs.readlinkSync(file), target); assert.equal(fs.realpathSync(file), fs.realpathSync(target));
  }
  const sourceManifest = json(c.sourceManifest);
  assert.equal(sourceManifest.source, c.source); assert.equal(sourceManifest.version, c.version);
  return { ...c, build: buildProof.build, buildProof, sourceManifest };
}
export function hdLockOwnerRows(text, lock) {
  const device = JSON.parse(call('/usr/bin/python3', ['-I', '-c',
    'import os,json,sys; n=int(sys.argv[1]); print(json.dumps([os.major(n),os.minor(n)]))', String(lock.dev)]));
  assert.ok(device.length === 2 && device.every(Number.isSafeInteger));
  return text.split('\n').filter(line => {
    const fields = line.trim().split(/\s+/), identity = fields[5]?.split(':');
    return fields[1] === 'FLOCK' && fields[3] === 'WRITE' && identity?.length === 3
      && parseInt(identity[0], 16) === device[0] && parseInt(identity[1], 16) === device[1]
      && identity[2] === String(lock.ino);
  });
}
function verifyHdSupervisor(m, kind) {
  const current = running(m, 'hd', kind), state = service(m, 'hd');
  assert.equal(state.KillMode, 'control-group'); assert.equal(state.SendSIGKILL, 'no');
  assert.equal(environmentMap(state.Environment).HD_DERIVATIVES_ROOT, m.hdRoot);
  const argv = fs.readFileSync('/proc/' + current.pid + '/cmdline').toString('utf8').split('\0').filter(Boolean);
  assert.ok(argv[0].endsWith('/node') && argv.includes('scripts/process-hd-derivatives.ts') && argv.at(-1) === 'worker');
  const lock = fs.statSync(m.hdWorkerLockPath), aliases = ['/srv/video-api-debugger/app/storage/hd-worker.lock',
    m[kind].root + '/storage/hd-worker.lock'];
  for (const file of aliases) { const stat = fs.statSync(file); assert.equal(stat.dev, lock.dev); assert.equal(stat.ino, lock.ino); }
  const owners = hdLockOwnerRows(fs.readFileSync('/proc/locks', 'utf8'), lock);
  assert.equal(owners.length, 1, 'The original HD flock must have exactly one kernel owner');
  assert.equal(Number(owners[0].trim().split(/\s+/)[4]), current.pid);
  const fds = fs.readdirSync('/proc/' + current.pid + '/fd').filter(fd => {
    try { const stat = fs.statSync('/proc/' + current.pid + '/fd/' + fd); return stat.dev === lock.dev && stat.ino === lock.ino; } catch { return false; }
  });
  assert.ok(fds.length > 0, 'The supervisor must hold the exact persistent flock descriptor');
  const after = running(m, 'hd', kind); assert.equal(after.pid, current.pid); assert.equal(after.invocation, current.invocation);
  return { source: current.source, root: current.root, pid: current.pid, start: current.start,
    invocation: current.invocation, lock: { dev: String(lock.dev), ino: String(lock.ino), ownerPid: current.pid },
    canonicalRoot: m.hdRoot, controlledProcessGroup: true, noFork: true };
}
function asApp(m, args, cwd) {
  return call('runuser', ['-u', m.appUser, '--', 'env', '-i', 'PATH=/usr/bin:/bin', ...args], { cwd, timeout: 120000 });
}
function actualPrestart(m, before, temporary, builds) {
  const accepted = [], rejected = [];
  for (const kind of ['main', 'guard']) {
    configure(m, before, temporary, kind); assertOriginalStopped(m, before);
    for (const role of PRICING_ROLES) {
      assertReleaseWindow(m);
      const value = JSON.parse(asApp(m, ['/usr/bin/node', PRICING_START_CONTROL + '/writer-start-guard.mjs', m.live[role].unit], m[kind].root));
      assert.equal(value.service, m.live[role].unit); assert.equal(value.source, m[kind].source);
      assert.equal(value.version, m[kind].version); assert.equal(value.build, builds[kind].build);
      assert.equal(value.sourceAndBuildVerified, true); assert.equal(value.barrierVerified, true); accepted.push(value);
    }
  }
  for (const root of rejectedPricingRoots(m)) {
    let refusal;
    try { asApp(m, ['/usr/bin/node', PRICING_START_CONTROL + '/writer-start-guard.mjs', '--verify-source', root], m.main.root); }
    catch (error) { assert.ok(Number.isInteger(error.status) && error.status !== 0); refusal = String(error.stderr || ''); }
    assert.ok(refusal?.includes('legacy or unapproved program'), 'Retired source must be rejected by the unchanged real guard');
    rejected.push({ root, refusal });
  }
  configure(m, before, temporary, 'main');
  return { accepted, rejected, actualExecStartPreVerified: true, cleanServiceUser: m.appUser };
}
function startIntent(m, published) {
  const file = PRICING_START_CONTROL + '/start-' + m.runId + '.json', value = json(file);
  assert.equal(value.schema, 'pricing-new-writer-start-intent.v1'); assert.equal(value.runId, m.runId);
  assert.equal(value.allowedSha256, published.installed.sha256); assert.equal(value.transitionReceiptSha256, published.receiptSha256);
  assert.equal(sha(rootFile(PRICING_START_CONTROL + '/allowed.json')), published.installed.sha256);
  return { file, value, sha256: sha(rootFile(file)) };
}
function capability(m, kind) {
  const image = running(m, 'image', kind);
  const script = "import sqlite3,json,sys\nwith sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True,timeout=10) as c:\n c.execute('PRAGMA query_only=ON')\n r=c.execute(\"SELECT value_json FROM PlatformSetting WHERE key='pricing_worker_capability_v1:image'\").fetchone()\n print(r[0] if r else 'null')\n";
  const value = JSON.parse(call('python3', ['-I', '-c', script, m.database])); assert.ok(value);
  assert.equal(value.protocol, 'pricing-policy-v1'); assert.equal(value.authoringCapability, CAPABILITY);
  assert.equal(value.consumer, 'image'); assert.equal(value.source, image.source); assert.match(value.workerId, /^[a-f0-9-]{36}$/);
  const now = Date.now(), issued = Date.parse(value.issuedAt), expires = Date.parse(value.expiresAt);
  assert.ok(Number.isFinite(issued) && issued <= now && expires > now && expires <= now + 90000);
  const worker = processState(value.instance.pid, true), parent = processState(value.parent.pid);
  assert.equal(worker.cwd, image.root); assert.equal(value.instance.cwd, worker.cwd); assert.equal(worker.start, value.instance.start);
  assert.equal(worker.parentPid, value.instance.parentPid); assert.equal(worker.parentPid, parent.pid); assert.equal(parent.start, value.parent.start);
  const groups = fs.readFileSync('/proc/' + worker.pid + '/cgroup', 'utf8').trim().split('\n').map(line => line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1));
  assert.ok(image.state.ControlGroup && groups.some(group => group === image.state.ControlGroup || group.startsWith(image.state.ControlGroup + '/')));
  const code = "import{pricingRuntimeModuleHashes,PRICING_AUTHORING_RUNTIME_CAPABILITY}from'./src/lib/pricing/runtime.ts';console.log(JSON.stringify({capability:PRICING_AUTHORING_RUNTIME_CAPABILITY,hashes:pricingRuntimeModuleHashes()}));";
  const expected = JSON.parse(asApp(m, ['NODE_ENV=production', '/usr/bin/node', '--import', 'tsx', '--input-type=module', '-e', code], image.root));
  assert.equal(expected.capability, CAPABILITY); assert.ok(Object.keys(expected.hashes).length > 10);
  assert.deepEqual(value.loadedModuleSha, expected.hashes);
  const locked = approved(m, kind);
  for (const [file, digest] of Object.entries(expected.hashes)) {
    if (file === '.deployed-commit') assert.equal(regularBytes(image.root + '/' + file).toString('utf8').trim(), image.source);
    else assert.equal(digest, locked.sourceFiles[file], 'Worker module differs from the locked candidate: ' + file);
  }
  const confirmed = running(m, 'image', kind); assert.equal(confirmed.pid, image.pid); assert.equal(confirmed.invocation, image.invocation);
  assert.equal(processState(worker.pid, true).start, worker.start);
  return { ...value, unitPid: image.pid, invocation: image.invocation, verifiedAt: Date.now(), loadedModules: Object.keys(expected.hashes).length };
}
function request(target, pathname) {
  assert.ok(pathname.startsWith('/') && !/[\r\n\0]/.test(pathname));
  const args = ['-q', '--noproxy', '*', '-sS', '--connect-timeout', '2', '--max-time', '10',
    '-H', 'Cookie:', '-H', 'Authorization:', '-H', 'Accept-Encoding: identity',
    '-H', 'Cache-Control: no-cache', ...(target.resolve ? ['--resolve', target.resolve] : []), '-w', '\n%{http_code}', target.origin + pathname];
  const bytes = execFileSync('curl', args, { encoding: null, env: CLEAN, timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
  const split = bytes.lastIndexOf(10); assert.ok(split >= 0);
  const code = bytes.subarray(split + 1).toString('ascii'); assert.match(code, /^\d{3}$/);
  return { body: bytes.subarray(0, split), status: Number(code), checkedAt: Date.now() };
}
async function observeMaintenance(m, check = assertReleaseWindow) {
  let evidence;
  await waitFor(m, 'Reloaded nginx has not isolated both upload entry points', () => {
    try {
      evidence = TARGETS.map(target => { const r = request(target, '/api/release'); assert.equal(r.status, 503);
        return { host: target.host, status: r.status, checkedAt: r.checkedAt, responseSha256: sha(r.body) }; });
      return true;
    } catch (error) {
      if (error?.code !== 'ERR_ASSERTION' || error.actual !== 200 || error.expected !== 503) throw error;
      return false;
    }
  }, 30000, check);
  return evidence;
}
function observeRestored(m, kind, target) {
  const actual = running(m, 'web', kind), response = request(target, '/api/release'); assert.equal(response.status, 200);
  const release = JSON.parse(response.body); assert.equal(release.version, actual.version);
  assert.ok(!Object.hasOwn(release, 'source') && !Object.hasOwn(release, 'build'), 'Anonymous release JSON is not a source/build proof');
  const login = request(target, '/login'); assert.equal(login.status, 200);
  const urls = [...login.body.toString('utf8').matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)]
    .map(match => new URL(match[1].replaceAll('&amp;', '&'), target.origin))
    .filter(url => url.origin === target.origin && url.pathname.startsWith('/_next/static/') && /\.(?:js|css)$/.test(url.pathname));
  const paths = [...new Set(urls.map(url => url.pathname + url.search))]; assert.ok(paths.length > 0, 'No real compiled client resources found');
  const locked = approved(m, kind);
  const assets = paths.map(url => {
    const parsed = new URL(url, target.origin), relative = decodeURIComponent(parsed.pathname.slice('/_next/static/'.length));
    assert.ok(relative && !relative.split('/').some(part => !part || part === '.' || part === '..') && !/[\\\0]/.test(relative));
    const expected = regularBytes(path.join(actual.root, '.next-prod-candidate/static', relative)), received = request(target, url);
    assert.equal(sha(expected), locked.buildFiles['static/' + relative], 'Public asset differs from the startup-pinned build');
    assert.equal(received.status, 200); assert.equal(sha(received.body), sha(expected), 'Running public compiled resource differs: ' + url);
    return { path: parsed.pathname, status: received.status, expectedSha256: sha(expected), responseSha256: sha(received.body) };
  });
  const confirmed = running(m, 'web', kind); assert.equal(confirmed.pid, actual.pid); assert.equal(confirmed.invocation, actual.invocation);
  const row = { host: target.host, status: response.status, checkedAt: Date.now(), source: actual.source, build: actual.build,
    releaseVersion: release.version, responseSha256: sha(response.body), loginSha256: sha(login.body), assets,
    runtime: { root: actual.root, source: actual.source, build: actual.build, version: actual.version,
      pid: actual.pid, start: actual.start, invocation: actual.invocation }, sourceEvidence: 'actual-running-unit-and-public-compiled-bytes' };
  const file = save(m, 'entry-proof-' + randomUUID(), row); return { ...row, evidenceSha256: sha(rootFile(file)) };
}
async function start(m, before, temporary, kind, published, builds, recovery = null) {
  const check = recovery?.check || assertReleaseWindow, label = recovery ? 'recovery-guard' : kind;
  if (recovery) { assert.equal(kind, 'guard'); recovery.assertStart(); }
  readCanvasBatchMigration(m, { required: true });
  verifyUploadPrivateDirectory(m);
  if (!recovery) startIntent(m, published); check(m, kind); assertPolicy(m, before, temporary);
  for (const role of ROLES) { stopped(m, role); assert.equal(fs.realpathSync(service(m, role).WorkingDirectory), m[kind].root); }
  const gate = temporary.files.hd; assert.deepEqual(rootSnapshot(gate.file), gate);
  const fd = fs.openSync(gate.file, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
  try { assert.equal(String(fs.fstatSync(fd).ino), gate.ino); fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, noForceBytes(m)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  temporary.files.hd = rootSnapshot(gate.file);
  save(m, 'hd-manual-start-gate-released-' + label, { before: gate, after: temporary.files.hd, originalWritersAlreadyStopped: true });
  call('systemctl', ['daemon-reload']); assertPolicy(m, before, temporary);
  assert.equal(call('systemctl', ['show', m.live.hd.unit, '-p', 'RefuseManualStart', '--value']), 'no');
  call('systemctl', ['start', '--no-block', m.live.hd.unit]);
  let hdIdentity, hdError;
  await waitFor(m, () => 'New HD supervisor/unique lock unavailable: ' + (hdError || 'not ready'), () => {
    try { hdIdentity = verifyHdSupervisor(m, kind); return true; } catch (error) { hdError = String(error); return false; }
  }, 30000, check);
  save(m, 'candidate-hd-start-' + label, { manifestSha256: before.manifestSha256, hdIdentity });
  call('systemctl', ['start', '--no-block', m.live.image.unit]);
  let imageCapability, lastError;
  await waitFor(m, () => 'New image capability is unavailable: ' + (lastError || 'not ready'), () => {
    try { imageCapability = capability(m, kind); return true; } catch (error) { lastError = String(error); return false; }
  }, 90000, check);
  save(m, 'candidate-image-start-' + label, { manifestSha256: before.manifestSha256, capability: imageCapability });
  check(m, kind); if (!recovery) startIntent(m, published); else recovery.assertStart();
  call('systemctl', ['start', '--no-block', m.live.web.unit]);
  await waitFor(m, () => 'New Web release is unavailable: ' + (lastError || 'not ready'), () => {
    try {
      const actual = running(m, 'web', kind); assert.equal(actual.build, builds[kind].build);
      const response = request({ origin: 'http://127.0.0.1:3302' }, '/api/release');
      assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).version, actual.version);
      capability(m, kind); return true;
    } catch (error) { lastError = String(error); return false; }
  }, 90000, check);
  const local = observeRestored(m, kind, { host: '127.0.0.1', origin: 'http://127.0.0.1:3302' });
  verifyUploadPrivateDirectory(m);
  assert.equal(local.build, builds[kind].build);
  return { kind, source: local.source, build: local.build, releaseVersion: local.releaseVersion,
    readabilityMode: 'normal', actualHealthy: true, evidenceSha256: local.evidenceSha256,
    imageCapability: capability(m, kind), hd: verifyHdSupervisor(m, kind) };
}
function restorePolicies(m, before, temporary, kind, check = assertReleaseWindow) {
  check(m, kind); running(m, 'web', kind); capability(m, kind); verifyHdSupervisor(m, kind); assertPolicy(m, before, temporary);
  for (const role of ROLES) {
    assert.deepEqual(rootSnapshot(temporary.files[role].file), temporary.files[role]); fs.unlinkSync(temporary.files[role].file);
  }
  call('systemctl', ['daemon-reload']); assertPolicy(m, before);
  assert.equal(call('systemctl', ['show', m.live.hd.unit, '-p', 'RefuseManualStart', '--value']), 'no');
}
async function restoreControlledDrain(m, before, temporary, installed, master, networkRestored = false) {
  assert.equal(m.runId, MV_DIRECT.recoveryRunId);
  for (const name of ['pricing-pair-published', 'pricing-start-intent', 'natural-stop-intent-switch-web', 'raw-upload-recovery-published'])
    for (const recordName of new Set([name, operationalRecordName(m, name)]))
      assert.equal(exists(m.stage + '/' + recordName + '.json'), false, 'Original recovery is only allowed before the writer transition');
  if (!networkRestored) for (const name of new Set(['network-fence-installed', operationalRecordName(m, 'network-fence-installed')]))
    assert.equal(exists(m.stage + '/' + name + '.json'), false);
  inspectRecoveryCertificate(m, before, { phase: 'early-original' });
  assert.equal(exists(PRICING_START_CONTROL + '/start-' + m.runId + '.json'), false);
  const control = capturePricingStartControl();
  for (const key of ['control', 'guard', 'allowed', 'marker', 'chain']) assert.deepEqual(control[key], before.captured[key]);
  assert.equal(service(m, 'web').MainPID, before.writers.web.MainPID);
  assert.equal(service(m, 'web').InvocationID, before.writers.web.InvocationID);
  assertPolicy(m, before, temporary);
  for (const role of ROLES) assert.equal(service(m, role).WorkingDirectory, m.live[role].root);
  for (const role of ['image', 'hd']) {
    const name = operationalRecordName(m, 'natural-stop-intent-switch-' + role), file = m.stage + '/' + name + '.json';
    if (!exists(file)) {
      const current = service(m, role), original = before.writers[role];
      for (const key of ['MainPID', 'InvocationID', 'WorkingDirectory']) assert.equal(current[key], original[key]);
      assert.equal(current.ActiveState, 'active');
      continue;
    }
    const intent = boundRecord(m, name, before.manifestSha256);
    assert.deepEqual(intent.capturedOriginal, before.writers[role]);
    assert.equal(intent.signal, 'SIGTERM'); assert.equal(intent.forcedKill, false);
    await waitForOriginalRecovery(m, 'Requested old ' + role + ' stop has not completed', () => {
      assertPolicy(m, before, temporary);
      const current = service(m, role);
      if (current.ActiveState === 'deactivating' || current.ActiveState === 'active') {
        assert.equal(current.InvocationID, before.writers[role].InvocationID); return false;
      }
      stopped(m, role, before.writers[role]); return true;
    }, 120000);
  }
  assertPolicy(m, before, temporary);
  for (const item of Object.values(temporary?.files || {})) assert.deepEqual(rootSnapshot(item.file), item);
  const restoredRole = await restoreOriginalUsageRole(m, () => {
    inspectRecoveryCertificate(m, before, { phase: 'early-original' });
    assert.equal(exists(PRICING_START_CONTROL + '/start-' + m.runId + '.json'), false);
    const actual = capturePricingStartControl();
    for (const key of ['control', 'guard', 'allowed', 'marker', 'chain']) assert.deepEqual(actual[key], before.captured[key]);
  });
  for (const item of Object.values(temporary?.files || {})) {
    assert.deepEqual(rootSnapshot(item.file), item); fs.unlinkSync(item.file);
  }
  call('systemctl', ['daemon-reload']); assertPolicy(m, before);
  call('systemctl', ['start', '--no-block', m.live.image.unit, m.live.hd.unit]);
  await waitForOriginalRecovery(m, 'Original consumers are not healthy after controlled-drain abort', () => ROLES.every(role => {
    const state = service(m, role);
    const owners = role === 'hd' ? hdLockOwnerRows(fs.readFileSync('/proc/locks', 'utf8'), fs.statSync(m.hdWorkerLockPath)) : null;
    return (!owners || owners.length === 1 && Number(owners[0].trim().split(/\s+/)[4]) === Number(state.MainPID))
      && state.ActiveState === 'active' && state.SubState === 'running' && Number(state.MainPID) > 1
      && state.WorkingDirectory === m.live[role].root && fs.realpathSync('/proc/' + state.MainPID + '/cwd') === m.live[role].root;
  }), 90000);
  const old = m.live.web, local = request({ origin: 'http://127.0.0.1:3302' }, '/api/release');
  assert.equal(local.status, 200); assert.equal(JSON.parse(local.body).version, old.version);
  assert.equal(liveArtifactSource(old.root), old.source);
  const { asset, expected } = originalRuntimeBuild(old);
  const healthy = { runId: m.runId, kind: 'main', actualHealthy: true, readabilityMode: 'normal', source: old.source,
    build: old.build, releaseVersion: old.version, evidenceSha256: sha(local.body) };
  const observeOriginalEntries = async () => {
      let rows;
      await waitForOriginalRecovery(m, 'Original entry has not left maintenance', () => {
        const output = TARGETS.map(target => {
          const response = request(target, '/api/release'); if (response.status === 503) return null;
          assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).version, old.version);
          const resource = request(target, '/_next/' + asset); assert.equal(resource.status, 200); assert.equal(sha(resource.body), expected);
          const state = service(m, 'web'); assert.equal(state.MainPID, before.writers.web.MainPID); assert.equal(state.InvocationID, before.writers.web.InvocationID);
          const row = { host: target.host, status: 200, checkedAt: Date.now(), source: old.source, build: old.build, releaseVersion: old.version,
            sourceEvidence: 'actual-running-unit-and-public-compiled-bytes', runtime: { source: old.source, build: old.build, pid: Number(state.MainPID), invocation: state.InvocationID },
            assets: [{ path: '/_next/' + asset, status: 200, expectedSha256: expected, responseSha256: expected }] };
          return { ...row, evidenceSha256: sha(JSON.stringify(row)) };
        }); if (output.some(row => !row)) return false; rows = output; return true;
      }, 30000); return rows;
    };
  const restored = installed ? await restoreNginxMaintenance({ installed, nginxMaster: master, healthyConsumers: { ...healthy, runId: installed.runId },
    observeRestored: observeOriginalEntries }) : { installationAborted: true, responses: await observeOriginalEntries() };
  assertPolicy(m, before); assertProtection(before.protection, readProtection(m));
  const result = { schema: 'controlled-hd-drain-original-restoration.v1', completed: true, source: old.source, version: old.version,
    build: old.build, restored, restoredRole, originalPairUnchanged: true, businessDataRestored: false, policiesRestored: true, at: new Date().toISOString() };
  save(m, operationalRecordName(m, 'controlled-drain-original-restored'), result); return result;
}
async function locked(m, work) {
  const file = m.stage + '/.switch.lock'; writeJsonExclusive(file, { pid: process.pid, token: randomUUID(), runId: m.runId });
  const owned = rootSnapshot(file);
  try { return await work(); }
  finally { assert.deepEqual(rootSnapshot(file), owned, 'Switch lock changed; preserve it'); fs.unlinkSync(file); }
}

// No import-time operations and no old-pair/database recovery path.
function captureSwitchBeforeState(m, manifestSha256, restoredLive) {
  assert.equal(call('systemctl', ['show', m.live.hd.unit, '-p', 'RefuseManualStart', '--value']), 'no', 'An unrelated manual-start gate is already installed');
  const writers = Object.fromEntries(ROLES.map(role => [role, running(m, role, null, restoredLive?.[role]).state]));
  const policies = Object.fromEntries(ROLES.map(role => [role, policy(m, role)]));
  const protectedFileIdentities = Object.fromEntries(m.protectedFiles.map(file => {
    const captured = protectedFileSnapshot(file); assert.equal(captured.sha256, m.expectedProtectedFileSha256[file]);
    return [file, captured];
  }));
  for (const role of PRICING_ROLES)
    assert.equal(program(m.live[role].root).source, m.fullRelease ? m.fullRelease.liveRoles[role].source : MV_DIRECT.baselineSource);
  const legacy = captureLegacyWriterContracts(m);
  const captured = capturePricingStartControl(), hdLegacy = captureHdLegacyContract(m);
  const roleControl = restoredLive ? captureRestoredUsageRole(m, restoredLive.role) : captureUsageRole(m);
  const protection = readProtection(m);
  if (restoredLive) {
    assert.equal(Number(roleControl.state.MainPID), restoredLive.role.pid); assert.equal(roleControl.state.InvocationID, restoredLive.role.invocation);
    assert.equal(roleControl.state.WorkingDirectory, m.live.role.root);
    protection.otherServices.role = { pid: String(restoredLive.role.pid), invocation: restoredLive.role.invocation, root: m.live.role.root };
  }
  const before = { schema: 'rate-impl2-switch-before.v1', manifestSha256, protection,
    protectedFileIdentities, writers, policies, legacy, hdLegacy, captured,
    roleControl,
    ...(MV_DIRECT.privateMultiviewInstall ? { privateWebPids: groupPids(writers.web.ControlGroup).map(Number) } : {}) };
  for (const [file, captured] of Object.entries(protectedFileIdentities)) assert.deepEqual(protectedFileSnapshot(file), captured);
  return before;
}
export function captureSwitchBefore(m, manifestSha256) { return captureSwitchBeforeState(m, manifestSha256); }
export function captureRestoredSwitchBefore(m, manifestSha256, newLiveSnapshot) {
  assert.ok(newLiveSnapshot && ['web', 'image', 'hd', 'works', 'role', 'template'].every(role => newLiveSnapshot[role]));
  for (const role of ['web', 'image', 'hd', 'works', 'role', 'template']) assertRestoredLiveRole(m, role, newLiveSnapshot[role]);
  return captureSwitchBeforeState(m, manifestSha256, newLiveSnapshot);
}

function assertNoEscapedRecoveryWriter(m) {
  const roots = new Set([...ROLES.map(role => m.live[role].root), m.main.root, m.guard.root]);
  const originalDirectory = engineDirectory(m), compatibleDirectory = candidateCompatibilityDirectory(m);
  const ancestors = new Set(); let parent = process.pid;
  while (parent > 0 && !ancestors.has(parent)) {
    ancestors.add(parent);
    const stat = fs.readFileSync('/proc/' + parent + '/stat', 'utf8');
    parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[1]);
  }
  for (const name of fs.readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
    const pid = Number(name); if (ancestors.has(pid)) continue;
    try {
      const cwd = fs.realpathSync('/proc/' + pid + '/cwd');
      const command = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replaceAll('\0', ' ');
      const related = roots.has(cwd) && /node|next|tsx|esbuild|ffmpeg/.test(command)
        || /ffmpeg/.test(command) && (command.includes(m.hdRoot) || [...roots].some(root => command.includes(root)))
        || command.includes(originalDirectory + '/') || command.includes(compatibleDirectory + '/')
        || command.includes(m.stage + '/hd-release-safety-r03/');
      if (related) throw new Error('Related process remains outside the proven empty writer groups: ' + pid);
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  assert.equal(engineDirectory(m), originalDirectory, 'Original recovery engine changed during the same process inventory');
  assert.equal(candidateCompatibilityDirectory(m), compatibleDirectory, 'Recovery proof or processor changed during the same process inventory');
}

// One attempt, one frozen guard, no window renewal or candidate-age relabeling.
// The normal switch/main/rollback entry above and below keeps its original gates.
export function normalizeSavedSwitchBefore(saved, runId, manifestSha256) {
  assert.equal(saved.runId, runId); assert.equal(saved.manifestSha256, manifestSha256);
  assert.equal(saved.schema, 'rate-impl2-switch-before.v1');
  const before = { ...saved }; delete before.runId;
  assert.deepEqual({ runId, ...before }, saved, 'Only the save-added runId wrapper may be removed');
  return before;
}

function switchBeforeForAttempt(m, manifestSha256, repair, runtime) {
  assert.equal(repair.originalSwitchBeforeFile, m.stage + '/switch-before.json');
  assert.equal(sha(rootFile(repair.originalSwitchBeforeFile)), repair.originalSwitchBeforeSha256);
  const frozenBefore = normalizeSavedSwitchBefore(boundRecord(m, 'switch-before', manifestSha256), m.runId, manifestSha256);
  if (!runtime.restoredOriginalRepair) return { before: frozenBefore, frozenBefore };
  const snapshot = repair.restoredSwitchBeforeSnapshot;
  assert.equal(snapshot?.requestedPath, repair.restoredSwitchBeforeFile);
  assert.equal(snapshot.sha256, repair.restoredSwitchBeforeSha256);
  assert.equal(path.dirname(repair.restoredSwitchBeforeFile), m.stage);
  assert.notEqual(repair.restoredSwitchBeforeFile, repair.originalSwitchBeforeFile);
  assertTypedFileUnchanged(snapshot);
  const bytes = rootFile(repair.restoredSwitchBeforeFile); assert.equal(sha(bytes), repair.restoredSwitchBeforeSha256);
  const before = normalizeSavedSwitchBefore(JSON.parse(bytes), m.runId, manifestSha256);
  assertTypedFileUnchanged(snapshot);
  return { before, frozenBefore };
}

function saveHdDrainResult(m, name, manifestSha256, result, failureMessage) {
  // Persist the complete strict result even when admission must be refused.
  const file = save(m, operationalRecordName(m, name), { manifestSha256, ...result });
  assert.equal(result.safe, true, failureMessage);
  return file;
}

function nginxInstalledFile(m) {
  return operationalNginxStage(m) + '/nginx-' + operationalNginxRunId(m) + '-installed.json';
}
function captureOperationalNginx(m) {
  const runId = operationalNginxRunId(m), stageRoot = operationalNginxStage(m);
  if (stageRoot !== m.stage) {
    assert.equal(path.dirname(stageRoot), m.stage); assert.notEqual(runId, m.runId);
    assert.match(runId, /^[a-f0-9-]{36}$/); assert.equal(fs.realpathSync(m.stage), m.stage);
    const parent = fs.lstatSync(m.stage); assert.ok(parent.isDirectory() && parent.uid === 0 && !(parent.mode & 0o077));
    fs.mkdirSync(stageRoot, { mode: 0o700 });
    const s = fs.lstatSync(stageRoot); assert.equal(fs.realpathSync(stageRoot), stageRoot);
    assert.ok(s.isDirectory() && !s.isSymbolicLink() && s.uid === 0 && (s.mode & 0o7777) === 0o700 && s.dev === parent.dev);
  } else assert.equal(runId, m.runId);
  return captureNginxMaintenance({ runId, stageRoot });
}

function assertSwitchAdmissionBefore(m, current, original, liveSnapshot) {
  assert.equal(current.manifestSha256, original.manifestSha256);
  for (const key of ['writers', 'policies', 'protectedFileIdentities', 'hdLegacy', 'privateWebPids'])
    assert.deepEqual(current[key], original[key], 'Switch admission original configuration changed: ' + key);
  assertFreshLegacyCapture(current.legacy, original.legacy);
  assertFreshPricingCapture(current.captured, original.captured);
  for (const key of ['state', 'fragment', 'dropins', 'loadedModuleSha'])
    assert.deepEqual(current.roleControl[key], original.roleControl[key], 'Original role configuration changed: ' + key);
  const runtimeIdentity = value => { const { heartbeatAt, ...identity } = value; return identity; };
  assert.deepEqual(runtimeIdentity(current.roleControl.runtime), runtimeIdentity(original.roleControl.runtime));
  assertProtection(original.protection, current.protection);
  assert.ok(liveSnapshot?.services && liveSnapshot.configurations, 'Missing bound original six-process observation');
  for (const [file, expected] of Object.entries(liveSnapshot.configurations)) {
    assert.equal(expected.requestedPath, file, 'Bound live configuration path changed');
    const actual = assertTypedFileUnchanged(expected);
    assert.equal(actual.sha256, expected.sha256, 'Original live configuration changed: ' + file);
    assert.deepEqual(actual.identity, expected.identity, 'Original live configuration identity changed: ' + file);
  }
  const live = {};
  for (const role of ['web', 'image', 'hd', 'works', 'role', 'template']) {
    const expected = operationalLive(m, role); assert.ok(expected, 'Missing original live process: ' + role);
    assert.equal(liveArtifactSource(expected.root), expected.source, 'Original live source changed: ' + role);
    const observed = unit(expected.unit);
    assert.equal(observed.ActiveState, 'active'); assert.equal(observed.SubState, 'running'); assert.equal(observed.ControlPID, '0');
    assert.equal(Number(observed.MainPID), expected.pid); assert.equal(observed.InvocationID, expected.invocation);
    assert.equal(fs.realpathSync('/proc/' + observed.MainPID + '/cwd'), expected.root);
    assert.equal(fs.realpathSync(observed.WorkingDirectory), expected.root);
    const instance = processState(expected.pid, true), prior = liveSnapshot.services[role]; assert.ok(prior);
    assert.equal(instance.start, String(prior.kernelStartTicks)); assert.equal(instance.cwd, prior.cwd);
    live[role] = { unit: expected.unit, pid: Number(observed.MainPID), invocation: observed.InvocationID, root: expected.root, kernelStartTicks: instance.start };
  }
  return live;
}
function assertSwitchAdmissionWindows(m, fixed, repair) {
  if (!repair) return;
  assert.equal(repair.originalFixedGuardFile, m.stage + '/fixed-guard-recovery.json');
  assert.equal(sha(rootFile(repair.originalFixedGuardFile)), repair.originalFixedGuardSha256);
  const oldApprovalFile = guardRecoveryApprovalFile(m); assert.equal(oldApprovalFile, repair.oldGuardApprovalFile);
  const oldApprovalBytes = rootFile(oldApprovalFile), oldApproval = JSON.parse(oldApprovalBytes);
  assert.equal(sha(oldApprovalBytes), repair.oldGuardApprovalSha256);
  assert.equal(repair.oldGuardWindowFile, m.stage + '/window-evidence/' + repair.oldGuardWindowSha256 + '.json');
  assert.equal(sha(rootFile(repair.oldGuardWindowFile)), repair.oldGuardWindowSha256);
  assert.equal(fixed.originalWindowSha256, repair.oldGuardWindowSha256);
  assert.equal(fixed.approvalReceiptSha256, repair.oldGuardApprovalSha256);
  assert.equal(oldApproval.windowSha256, repair.oldGuardWindowSha256);
  const approvalFile = hdMaintenanceApprovalFile(m); assert.equal(approvalFile, repair.approvalFile);
  const approvalBytes = rootFile(approvalFile), approval = JSON.parse(approvalBytes);
  assert.equal(sha(approvalBytes), repair.approvalSha256);
  assert.equal(m.windowFile, m.stage + '/window.json', 'Current admission must read the actual mutable window role');
  assert.equal(repair.windowFile, m.stage + '/window-evidence/' + repair.windowSha256 + '.json', 'Repair must retain its immutable window evidence role');
  const currentWindowBytes = rootFile(m.windowFile), sealedWindowBytes = rootFile(repair.windowFile);
  assert.equal(sha(currentWindowBytes), repair.windowSha256); assert.equal(sha(sealedWindowBytes), repair.windowSha256);
  assert.deepEqual(currentWindowBytes, sealedWindowBytes, 'Current admission window differs from its root-bound immutable evidence');
  assert.equal(approval.windowSha256, repair.windowSha256);
  for (const key of ['runId', 'mainSource', 'guardSource', 'manifestSha256', 'mainBuildReceiptSha256', 'guardBuildReceiptSha256'])
    assert.equal(approval[key], oldApproval[key], 'Switch approval changed the frozen candidate binding: ' + key);
  assert.equal(approval.runId, m.runId); assert.equal(approval.mainSource, m.mainSource); assert.equal(approval.guardSource, m.guardSource);
  assert.equal(approval.manifestSha256, sha(rootFile(m.stage + '/manifest.json')));
  for (const kind of ['main', 'guard']) assert.equal(approval[kind + 'BuildReceiptSha256'], sha(rootFile(candidateEvidenceFile(m, kind))));
  const builds = Object.fromEntries(['main', 'guard'].map(kind => [kind, JSON.parse(rootFile(candidateEvidenceFile(m, kind)))]));
  // The immutable historical guard window is not renewed. The actual current
  // window, approval and candidate observation must all still pass their
  // existing fresh bounds immediately before maintenance admission.
  sharedHdAdmissionBounds(m, builds, approval.manifestSha256).check();
}

function captureSwitchPremaintenance(m, manifestSha256, hdBefore, { repair, repairSha256 } = {}) {
  const originals = [];
  let originalMaster;
  if (repair) {
    assert.match(repairSha256 || '', /^[a-f0-9]{64}$/);
    for (const [prefix, name] of [['originalHdBefore', 'hd-reconciliation-before'], ['originalNginxMaster', 'nginx-master']]) {
      const file = m.stage + '/' + name + '.json', snapshot = repair[prefix + 'Snapshot'];
      assert.equal(repair[prefix + 'File'], file); assert.equal(snapshot?.requestedPath, file);
      assert.equal(snapshot.sha256, repair[prefix + 'Sha256']);
      const current = assertTypedFileUnchanged(snapshot);
      assert.equal(current.sha256, repair[prefix + 'Sha256']);
      assert.equal(sha(rootFile(file)), repair[prefix + 'Sha256']);
      originals.push(snapshot);
    }
    const originalHd = boundRecord(m, 'hd-reconciliation-before', manifestSha256);
    assert.equal(originalHd.canEnterControlledDrain, true, 'Original premaintenance HD observation was not admissible for controlled drain');
    originalMaster = boundRecord(m, 'nginx-master', manifestSha256);
    assert.ok(Number.isSafeInteger(originalMaster.masterPid) && originalMaster.masterPid > 1);
    assert.match(originalMaster.masterStart || '', /^[1-9]\d*$/);
  }
  const suffix = repair ? '-' + repairSha256 : '';
  save(m, 'hd-reconciliation-before' + suffix, { manifestSha256, ...hdBefore,
    ...(repair ? { repairProofSha256: repairSha256, originalHdBeforeSha256: repair.originalHdBeforeSha256,
      originalRecoveryBaselineRetained: true } : {}) });
  const masterPid = Number(call('systemctl', ['show', 'nginx.service', '-p', 'MainPID', '--value']));
  const observed = { masterPid, masterStart: processState(masterPid).start };
  if (originalMaster) {
    assert.equal(observed.masterPid, originalMaster.masterPid, 'Original nginx master PID changed before maintenance');
    assert.equal(observed.masterStart, originalMaster.masterStart, 'Original nginx master start changed before maintenance');
    assert.equal(Number(call('systemctl', ['show', 'nginx.service', '-p', 'MainPID', '--value'])), masterPid);
    assert.equal(processState(masterPid).start, observed.masterStart);
  }
  save(m, 'nginx-master' + suffix, { manifestSha256, ...observed,
    ...(repair ? { repairProofSha256: repairSha256, originalNginxMasterSha256: repair.originalNginxMasterSha256,
      originalRecoveryBaselineRetained: true } : {}) });
  for (const snapshot of originals) assertTypedFileUnchanged(snapshot);
  return originalMaster ? { masterPid: originalMaster.masterPid, masterStart: originalMaster.masterStart } : observed;
}

export async function recoverStandaloneSwitch(m, input = {}) {
  const { manifestSha256 } = context(m), saved = boundRecord(m, 'switch-before', manifestSha256);
  const runtime = guardBuildTailRuntime(m);
  const before = runtime?.restoredOriginalRepair
    ? switchBeforeForAttempt(m, manifestSha256, assertSwitchAdmissionRepair(m), runtime).before
    : normalizeSavedSwitchBefore(saved, m.runId, manifestSha256);
  if (input.before !== undefined) assert.deepEqual(input.before, before, 'Standalone before input changed');
  readGuardRecovery(m);
  const file = m.stage + '/.switch.lock';
  if (exists(file)) {
    const snapshot = rootSnapshot(file), owner = JSON.parse(Buffer.from(snapshot.bytesBase64, 'base64'));
    assert.equal(owner.runId, m.runId); assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0);
    assert.match(owner.token, /^[a-f0-9-]{36}$/);
    assert.equal(exists('/proc/' + owner.pid), false, 'Original controller is still alive');
    const retained = m.stage + '/.switch.lock.retained-' + snapshot.sha256;
    assert.equal(exists(retained), false, 'A retained original lock already exists; preserve evidence');
    assert.deepEqual(rootSnapshot(file), snapshot);
    fs.renameSync(file, retained);
    assert.deepEqual(rootSnapshot(retained), { ...snapshot, file: retained });
    save(m, 'standalone-recovery-retained-lock-' + randomUUID(), { manifestSha256, original: snapshot, retained });
  }
  return locked(m, async () => {
    save(m, 'standalone-recovery-input-' + randomUUID(), { manifestSha256,
      savedBeforeSha256: sha(rootFile(m.stage + '/switch-before.json')), onlySaveWrapperRemoved: true });
    return recoverFailedSwitch(m, { ...input, before, alreadyLocked: true });
  });
}

function assertRecoveryContinuationFailure(m, runtime, failure, failureSha256) {
  if (runtime?.guardHeartbeatRepair) {
    assert.equal(runtime.phase, 'recovery'); const proof = runtime.guardHeartbeatRepair.proof;
    assert.equal(proof.recoveryOnly, true); assert.equal(proof.continueMain, false); assert.equal(proof.newWriterStartAbsent, true);
    assert.equal(proof.guardRecoveryResumeFailureFile, m.stage + '/guard-recovery-resume-failed-882d6126-6a46-4065-b653-7e690f8623f2.json');
    assert.equal(proof.guardRecoveryResumeFailureSha256, failureSha256);
    assert.equal(failure.preservedSafetyState, true); assert.equal(failure.businessDataRestored, false);
    assert.equal(failure.forcedKill, false); assert.equal(failure.code, null);
    assert.ok(failure.error.includes('AssertionError: Original business rows changed while stopped'));
    return 'verified-completed-schema-periodic-credit-heartbeat-before-first-guard-start';
  }
  if (!runtime?.guardRecoveryRepair) { assert.equal(failure.code, 'NATURAL_STOP_PENDING'); return 'natural-stop-completed'; }
  assert.equal(runtime.phase, 'recovery'); const proof = runtime.guardRecoveryRepair.proof;
  assert.equal(proof.recoveryOnly, true); assert.equal(proof.continueMain, false);
  assert.equal(proof.guardRecoveryFailureFile, m.stage + '/guard-recovery-failed.json');
  assert.equal(proof.guardRecoveryFailureSha256, failureSha256);
  assert.equal(failure.code, 'E2BIG'); assert.equal(failure.error, 'Error: spawnSync python3 E2BIG');
  assert.equal(failure.preservedSafetyState, true); assert.equal(failure.businessDataRestored, false);
  return 'verified-e2big-transport-repair-before-first-guard-start';
}

export async function recoverFailedSwitch(m, input = {}) {
  const { manifestSha256 } = context(m), runtime = guardBuildTailRuntime(m);
  const before = input.before || (runtime?.restoredOriginalRepair
    ? switchBeforeForAttempt(m, manifestSha256, assertSwitchAdmissionRepair(m), runtime).before
    : boundRecord(m, 'switch-before', manifestSha256));
  const armed = readGuardRecovery(m);
  const switchLock = m.stage + '/.switch.lock';
  if (exists(switchLock)) {
    const owner = json(switchLock); assert.equal(owner.runId, m.runId);
    assert.ok(input.alreadyLocked && owner.pid === process.pid || !exists('/proc/' + owner.pid), 'Original release controller is still alive');
  }
  const attemptFile = m.stage + '/guard-recovery-attempt.json';
  if (exists(attemptFile)) {
    const resumes = fs.readdirSync(m.stage).filter(file => /^guard-recovery-resume-[a-f0-9-]+\.json$/.test(file)).sort();
    if (runtime?.guardHeartbeatRepair) {
      const proof = runtime.guardHeartbeatRepair.proof;
      assert.deepEqual(resumes, [path.basename(proof.originalRecoveryResumeFile)]);
      assert.equal(sha(rootFile(proof.originalRecoveryResumeFile)), proof.originalRecoveryResumeSha256);
      assert.equal(fs.readdirSync(m.stage).some(file => /^guard-recovery-heartbeat-resume-/.test(file)), false,
        'The exact completed-schema recovery continuation was already consumed');
    } else assert.equal(resumes.length, 0,
      'Only one condition-proven pre-start continuation is supported; preserve evidence and escalate further failures');
    const previous = json(attemptFile); assert.equal(previous.manifestSha256, manifestSha256);
    assert.equal(exists('/proc/' + previous.pid), false, 'The first recovery controller is still alive');
    assert.equal(exists(m.stage + '/guard-recovery-start-intent.json'), false, 'A guard start was already attempted; do not retry it blindly');
    const failureFile = runtime?.guardHeartbeatRepair?.proof.guardRecoveryResumeFailureFile || m.stage + '/guard-recovery-failed.json', failure = json(failureFile);
    const continuationReason = assertRecoveryContinuationFailure(m, runtime, failure, sha(rootFile(failureFile)));
    for (const role of ROLES) stopped(m, role);
    if (runtime?.guardHeartbeatRepair) {
      const fresh = verifyCompletedFullSchemaHeartbeat(m), expected = runtime.guardHeartbeatRepair.proof.completedFullSchemaHeartbeat;
      for (const key of Object.keys(expected).filter(key => !['observedAt', 'heartbeatTimeChanged'].includes(key))) assert.deepEqual(fresh[key], expected[key]);
    }
    save(m, runtime?.guardHeartbeatRepair ? 'guard-recovery-heartbeat-resume-' + runtime.guardHeartbeatRepair.proofSha256 : 'guard-recovery-resume-' + randomUUID(), { manifestSha256, previousAttemptSha256: sha(rootFile(attemptFile)),
      reason: continuationReason, originalFailurePreserved: true, firstGuardStartOnly: true });
  } else save(m, 'guard-recovery-attempt', { manifestSha256, pid: process.pid, at: new Date().toISOString(), guardSource: m.guardSource,
    originalBuildStartedAt: armed.originalGuardBuild.startedAt, candidateFreshGateClaimed: false });
  const installed = input.installed || (exists(nginxInstalledFile(m)) ? json(nginxInstalledFile(m)) : null);
  const savedMaster = input.master || boundRecord(m, 'nginx-master', manifestSha256);
  const master = { masterPid: savedMaster.masterPid, masterStart: savedMaster.masterStart };
  let temporary = input.temporary;
  const ctx = { ...input, m, before, installed, master, builds: { guard: armed.originalGuardBuild }, recoveryOnly: true };
  const check = (_m, kind) => {
    assert.equal(_m, m); if (kind !== undefined) assert.equal(kind, 'guard', 'Recovery cannot start or configure main');
    assert.deepEqual(readGuardRecovery(m), armed);
  };
  const currentProtection = readProtection(m), protectedState = { ...currentProtection, files: { ...currentProtection.files } };
  for (const item of installed?.files || []) protectedState.files[item.file] = before.protection.files[item.file];
  let fence;
  const allGone = () => {
    check(m);
    assertUsageRoleStopped(m);
    for (const role of ROLES) {
      stopped(m, role);
      assert.equal(exists('/proc/' + before.writers[role].MainPID), false);
      assert.deepEqual(groupPids(before.writers[role].ControlGroup), []);
      const observed = ctx.recoveryWriters?.[role];
      if (Number(observed?.MainPID) > 1) assert.equal(exists('/proc/' + observed.MainPID), false);
    }
    assertNoEscapedRecoveryWriter(m);
  };
  const safety = input.safety;
  assert.equal(typeof safety?.inspectRecoveryFence, 'function');
  assert.equal(typeof safety?.restoreForRecovery, 'function');
  function currentTemporary() {
    const files = {}, known = [];
    for (const file of fs.readdirSync(m.stage).filter(name => /^(writer-no-force|hd-manual-start-gate-released)/.test(name) && name.endsWith('.json'))) {
      const value = json(m.stage + '/' + file); if (value.files) known.push(...Object.values(value.files));
      if (value.after?.file) known.push(value.after);
    }
    for (const role of ROLES) {
      const file = '/run/systemd/system/' + m.live[role].unit + '.d/rate-impl2-' + m.runId + '.conf';
      const bytes = role === 'hd' ? Buffer.concat([noForceBytes(m), Buffer.from('\n[Unit]\nRefuseManualStart=yes\n')]) : noForceBytes(m);
      if (exists(file)) {
        const current = rootSnapshot(file);
        assert.ok(known.some(item => JSON.stringify(item) === JSON.stringify(current)), 'Unrecorded or damaged stop-protection object');
        if (current.sha256 !== sha(bytes)) {
          assert.equal(role, 'hd'); assert.equal(current.sha256, sha(noForceBytes(m)));
          const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
          try { assert.equal(String(fs.fstatSync(fd).ino), current.ino); fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
          finally { fs.closeSync(fd); }
        }
      } else {
        const directory = path.dirname(file); assert.equal(fs.realpathSync(directory), directory);
        const state = fs.lstatSync(directory); assert.ok(state.isDirectory() && state.uid === 0 && !(state.mode & 0o022));
        const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      files[role] = rootSnapshot(file);
      save(m, 'writer-no-force-recovery-progress-' + role + '-' + randomUUID(), { manifestSha256, files });
    }
    call('systemctl', ['daemon-reload']);
    const result = { manifestSha256, files };
    if (fence && !['restored', 'prepared'].includes(fence.phase)) result.fenceNetworkFiles = FENCE_NETWORK_FILES.map(rootSnapshot);
    assertPolicy(m, before, result);
    assert.equal(call('systemctl', ['show', m.live.hd.unit, '-p', 'RefuseManualStart', '--value']), 'yes');
    save(m, 'writer-no-force-recovery-' + randomUUID(), result); return result;
  }
  const io = {
    readAdmission: async () => ({ value: armed, originalBuildMayBeOld: Date.now() - armed.originalGuardBuild.startedAt >= 1800000 }),
    verifyFixedGuard: async () => verifyGuardRecovery(m, before),
    observe: async () => {
      const verified = inspectGuardRecoveryControl(m, before);
      fence = await safety.inspectRecoveryFence({ ...ctx, temporary });
      const certificateState = inspectRecoveryCertificate(m, before);
      if (certificateState.createdByThisRun) assert.equal(verified.originalPair, false);
      const intent = exists(PRICING_START_CONTROL + '/start-' + m.runId + '.json');
      const writers = Object.fromEntries(ROLES.map(role => [role, service(m, role)]));
      for (const role of ROLES) {
        const state = writers[role]; assert.ok([m.live[role].root, m.main.root, m.guard.root].includes(state.WorkingDirectory));
        if (Number(state.MainPID) > 1) {
          assert.equal(fs.realpathSync('/proc/' + state.MainPID + '/cwd'), state.WorkingDirectory);
          if (state.MainPID !== before.writers[role].MainPID) assert.equal(intent, true, 'An unrecorded new writer started');
        }
      }
      ctx.recoveryWriters = writers;
      return { certificate: certificateState.createdByThisRun, startIntent: intent, originalPair: verified.originalPair,
        fencePhase: fence?.phase, fenceRestorePhase: fence?.restorePhase,
        webStopRequested: exists(m.stage + '/' + operationalRecordName(m, 'natural-stop-intent-switch-web') + '.json') };
    },
    record: async (label, value) => { save(m, 'guard-recovery-' + label + (label === 'complete' ? '' : '-' + randomUUID()), { manifestSha256, ...value }); return value; },
    restoreOriginalNetwork: async () => {
      assert.ok(temporary || exists(m.stage + '/' + operationalRecordName(m, 'writer-no-force-switch') + '.json'));
      temporary ||= boundRecord(m, operationalRecordName(m, 'writer-no-force-switch'), manifestSha256);
      await safety.restoreForRecovery({ ...ctx, temporary, recoveryRoute: 'original' });
      delete temporary.fenceNetworkFiles;
    },
    restoreOriginal: async () => restoreControlledDrain(m, before, temporary, installed, master, Boolean(fence && fence.phase !== 'prepared')),
    closeIngress: async () => {
      assert.ok(installed, 'A guarded recovery requires this run\'s owned maintenance configuration');
      await rearmOwnedNginxMaintenance({ installed, nginxMaster: master, observeMaintenance: () => observeMaintenance(m, check) });
    },
    ensureNoForce: async () => { temporary = currentTemporary(); ctx.temporary = temporary; },
    drainKnownProcesses: async () => {
      await stopUsageRole(m, () => check(m));
      for (const role of ['image', 'hd', 'web']) {
        const current = service(m, role);
        if (current.MainPID === '0' && current.ControlPID === '0' && ['inactive', 'failed'].includes(current.ActiveState)) { stopped(m, role); continue; }
        if (current.ActiveState === 'deactivating') {
          await waitFor(m, 'Previously requested ' + role + ' stop is still pending', () => {
            const state = service(m, role);
            if (!['inactive', 'failed'].includes(state.ActiveState) || state.MainPID !== '0' || state.ControlPID !== '0') return false;
            stopped(m, role, current); return true;
          }, 120000, check, 'NATURAL_STOP_PENDING');
        } else await stopNaturally(m, before, temporary, role, 'recovery', current, check);
      }
      await stopMultiviewWorksForGuardRecovery(m, () => check(m));
    },
    assertAllGone: async () => {
      allGone();
      const originalDrain = boundRecord(m, operationalRecordName(m, 'hd-retired-caches-after-whole-service-drain'), manifestSha256);
      assert.equal(originalDrain.safe, true);
      const hd = await inspectHdReconciliation(m, { sourceRoot: m.guard.root, final: true, retiredCachePhase: 'admission' });
      assert.equal(hd.canEnterControlledDrain, true, 'A lease, publication or unexplained HD artifact remains');
    },
    assertDataContract: async (_context, options = {}) => assertProtected(m, protectedState, options.ingressRestored ? null : installed),
    ensureFixedPair: async (_context, fixed) => {
      allGone();
      if (fixed.originalPair) {
        const published = await publishPricingStartPair({ captured: armed.originalControl, pair: armed.pair,
          backupFile: m.stage + '/recovery-allowed-original.json', assertWritersStopped: allGone });
        save(m, 'recovery-only-pricing-pair-published', { manifestSha256, published, onlyGuardMayStart: true });
      }
      assert.equal(verifyGuardRecovery(m, before).originalPair, false);
      applyCanvasBatchMigration(m, allGone, check);
      applyFullSchema(m, allGone, check);
    },
    configureGuard: async () => configure(m, before, temporary, 'guard', check),
    actualGuardPrestart: async () => {
      const accepted = PRICING_ROLES.map(role => {
        const value = JSON.parse(asApp(m, ['/usr/bin/node', PRICING_START_CONTROL + '/writer-start-guard.mjs', m.live[role].unit], m.guard.root));
        assert.equal(value.source, m.guardSource); assert.equal(value.build, armed.guardEntry.build);
        assert.equal(value.sourceAndBuildVerified, true); assert.equal(value.barrierVerified, true); return value;
      });
      const result = { schema: 'fixed-guard-recovery-prestart.v1', source: m.guardSource, build: armed.guardEntry.build, accepted };
      save(m, 'guard-recovery-actual-prestart', { manifestSha256, ...result }); return result;
    },
    restoreGuardNetwork: async (_context, _fixed, prestart) => {
      await safety.restoreForRecovery({ ...ctx, temporary, recoveryRoute: 'guard', prestart });
      delete temporary.fenceNetworkFiles; assertPolicy(m, before, temporary);
    },
    markGuardStart: async () => {
      allGone();
      if (runtime?.guardHeartbeatRepair) {
        const fresh = verifyCompletedFullSchemaHeartbeat(m), expected = runtime.guardHeartbeatRepair.proof.completedFullSchemaHeartbeat;
        for (const key of Object.keys(expected).filter(key => !['observedAt', 'heartbeatTimeChanged'].includes(key))) assert.deepEqual(fresh[key], expected[key]);
        save(m, 'guard-recovery-completed-schema-before-start', { manifestSha256, verification: fresh });
      }
      const intent = markFixedGuardStart(m, before, allGone); save(m, 'guard-recovery-start-intent', { manifestSha256, intent });
    },
    startGuard: async () => {
      const healthy = await start(m, before, temporary, 'guard', null, ctx.builds, { check,
      assertStart: () => {
        check(m, 'guard'); const value = json(PRICING_START_CONTROL + '/start-' + m.runId + '.json');
        assert.equal(value.runId, m.runId); assert.equal(value.allowedSha256, capturePricingStartControl({ verifyReleases: false }).allowed.sha256);
      } });
      const role = await startUsageRole(m, 'guard', () => check(m, 'guard'));
      const multiviewWorks = await ensurePrivateMultiviewGuard(m, () => check(m, 'guard'));
      return { ...healthy, role, multiviewWorks };
    },
    restorePolicies: async () => restorePolicies(m, before, temporary, 'guard', check),
    openIngress: async (_context, healthy) => restoreNginxMaintenance({ installed, nginxMaster: master,
      healthyConsumers: { ...healthy, runId: installed.runId }, observeMaintenance: () => observeMaintenance(m, check),
      observeRestored: async () => {
        let evidence; await waitFor(m, 'Recovered guard is not reachable at both entries', () => {
          try { evidence = TARGETS.map(target => observeRestored(m, 'guard', target)); return true; }
          catch (error) { if (error?.code !== 'ERR_ASSERTION' || error.actual !== 503 || error.expected !== 200) throw error; return false; }
        }, 30000, check); return evidence;
      } }),
  };
  try { return await runGuardRecovery(ctx, io); }
  catch (error) {
    save(m, exists(m.stage + '/guard-recovery-failed.json') ? 'guard-recovery-resume-failed-' + randomUUID() : 'guard-recovery-failed',
      { manifestSha256, originalFailure: String(input.error), error: String(error), code: error.code || null,
      preservedSafetyState: true, forcedKill: false, businessDataRestored: false, candidateFreshGateClaimed: false }); throw error;
  }
}

export function privateHdAdmissionBounds(m, builds, manifestSha256) {
  assert.equal(m.privateMultiviewInstall, true);
  if (isSharedEngine(m)) return sharedHdAdmissionBounds(m, builds, manifestSha256);
  assert.equal(m.reuseBuilds || null, null, 'Discovery waiting never relabels an original reused build');
  assertReleaseWindow(m);
  const files = { manifest: m.stage + '/manifest.json', window: m.windowFile, approval: hdMaintenanceApprovalFile(m),
    main: m.stage + '/main-build.json', guard: m.stage + '/guard-build.json' };
  const bytes = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, rootFile(file)]));
  const pinnedSha256 = Object.fromEntries(Object.entries(bytes).map(([key, value]) => [key, sha(value)]));
  assert.equal(pinnedSha256.manifest, manifestSha256);
  const window = JSON.parse(bytes.window), approval = JSON.parse(bytes.approval), now = Date.now();
  for (const key of ['project', 'runId', 'mainSource', 'guardSource']) assert.equal(window[key], m[key]);
  for (const key of ['runId', 'mainSource', 'guardSource']) assert.equal(approval[key], m[key]);
  assert.equal(approval.schema, 'hd-release-maintenance-approval.v1');
  assert.equal(approval.manifestSha256, manifestSha256);
  assert.equal(approval.windowSha256, pinnedSha256.window);
  assert.equal(approval.privateFreezeSha256, sha(Buffer.from(JSON.stringify(m.privateSha256))));
  const issued = parseReleaseTimestamp(approval.issuedAt), approvalExpiresAt = parseReleaseTimestamp(approval.expiresAt);
  assert.ok(Number.isSafeInteger(issued) && Number.isSafeInteger(approvalExpiresAt)
    && issued <= now && now < approvalExpiresAt && approvalExpiresAt - issued <= 300000);
  const windowIssuedAt = parseReleaseTimestamp(window.issuedAt), buildExpiresAt = {};
  assert.ok(Number.isSafeInteger(windowIssuedAt) && windowIssuedAt <= now + 30000 && now < windowIssuedAt + 300000);
  for (const kind of ['main', 'guard']) {
    assert.equal(approval[kind + 'BuildReceiptSha256'], pinnedSha256[kind]);
    const receipt = JSON.parse(bytes[kind]);
    for (const key of ['runId', 'manifestSha256', 'source', 'version', 'startedAt', 'finishedAt', 'exitCode'])
      assert.equal(receipt[key], builds[kind][key], 'Original build receipt changed: ' + kind + ':' + key);
    assert.equal(receipt.runId, m.runId); assert.equal(receipt.manifestSha256, manifestSha256);
    assert.equal(receipt.source, m[kind].source); assert.equal(receipt.exitCode, 0);
    const started = parseReleaseTimestamp(receipt.startedAt); assert.ok(Number.isSafeInteger(started) && started > 0);
    buildExpiresAt[kind] = started + 1800000;
  }
  const deadline = Math.min(now + 15000, windowIssuedAt + 300000, approvalExpiresAt, buildExpiresAt.main, buildExpiresAt.guard);
  const check = () => {
    assertReleaseWindow(m);
    assert.ok(Date.now() < deadline, 'Private HD admission deadline expired; retain original site');
    for (const [key, file] of Object.entries(files)) assert.equal(sha(rootFile(file)), pinnedSha256[key], 'Private HD admission input changed: ' + key);
  };
  check();
  return { deadline, check, receipt: { schema: 'mv-private-hd-admission-bounds.v1', manifestSha256,
    startedAt: now, deadline, maximumMs: 15000, windowExpiresAt: windowIssuedAt + 300000,
    approvalExpiresAt, buildExpiresAt, pinnedSha256, originalTimesChanged: false } };
}

export async function armSwitch(m) {
  assert.equal(isSharedEngine(m), true, 'Legacy callers retain their original in-switch arming');
  const { manifestSha256 } = context(m); assertReleaseWindow(m);
  const builds = await verifyBoth(m, manifestSha256);
  await loadHdCompiledCacheProofs(m);
  const before = captureSwitchBefore(m, manifestSha256);
  verifyNormalContinuation(m, before);
  if (m.deployedUsageSchema) { readDeployedUsageEvidence(m); assertPriorUsageRoleControl(m); }
  const pair = buildPair({ captured: before.captured, manifest: m, runId: m.runId, manifestSha256, reuseBuilds: m.reuseBuilds,
    main: candidateInput(m, 'main', builds.main), guard: candidateInput(m, 'guard', builds.guard) });
  save(m, 'arm-before', before);
  const armed = armGuardRecovery(m, { before, pair, builds });
  save(m, 'fixed-guard-recovery-armed', { manifestSha256, ...armed });
  return armed;
}

function sharedHdAdmissionBounds(m, builds, manifestSha256) {
  const outer = sharedReadOnlyHdBounds(m);
  const files = { manifest: m.stage + '/manifest.json', window: m.windowFile,
    approval: hdMaintenanceApprovalFile(m),
    main: candidateEvidenceFile(m, 'main'), guard: candidateEvidenceFile(m, 'guard') };
  const bytes = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, rootFile(file)]));
  const pinnedSha256 = Object.fromEntries(Object.entries(bytes).map(([key, value]) => [key, sha(value)]));
  const identity = stat => Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, stat[key]]));
  const pinnedIdentity = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, identity(fs.lstatSync(file))]));
  assert.equal(pinnedSha256.manifest, manifestSha256);
  const window = JSON.parse(bytes.window), approval = JSON.parse(bytes.approval), now = Date.now();
  for (const key of ['project', 'runId', 'mainSource', 'guardSource']) assert.equal(window[key], m[key]);
  for (const key of ['runId', 'mainSource', 'guardSource']) assert.equal(approval[key], m[key]);
  assert.equal(approval.schema, 'hd-release-maintenance-approval.v1');
  assert.equal(approval.manifestSha256, manifestSha256);
  assert.equal(approval.windowSha256, pinnedSha256.window);
  assert.equal(approval.privateFreezeSha256, sha(Buffer.from(JSON.stringify(m.privateSha256))));
  const issued = parseReleaseTimestamp(approval.issuedAt), approvalExpiresAt = parseReleaseTimestamp(approval.expiresAt);
  assert.ok(Number.isSafeInteger(issued) && issued <= now && now < approvalExpiresAt && approvalExpiresAt - issued <= 300000);
  const windowIssuedAt = parseReleaseTimestamp(window.issuedAt), candidateExpiresAt = {};
  assert.ok(Number.isSafeInteger(windowIssuedAt) && windowIssuedAt <= now && now < windowIssuedAt + 300000);
  for (const kind of ['main', 'guard']) {
    assert.equal(approval[kind + 'BuildReceiptSha256'], pinnedSha256[kind]);
    const proof = JSON.parse(bytes[kind]); assert.deepEqual(proof, builds[kind]);
    assertFreshCandidateEvidence(proof, m, kind, now);
    assert.equal(proof.manifestSha256, manifestSha256);
    candidateExpiresAt[kind] = candidateEvidenceExpiresAt(proof, m, kind, now);
  }
  const scanDeadline = Math.min(windowIssuedAt + 300000, approvalExpiresAt, candidateExpiresAt.main, candidateExpiresAt.guard);
  const check = () => {
    outer.check();
    assert.ok(Date.now() < scanDeadline, 'Static HD reconciliation exceeded fresh release authority');
    for (const [key, file] of Object.entries(files)) assert.deepEqual(identity(fs.lstatSync(file)), pinnedIdentity[key], 'HD admission input changed: ' + key);
  };
  check();
  return { scanDeadline, deadline: scanDeadline, waitBudgetMs: 15000, check,
    receipt: { schema: 'sd2-shared-hd-admission-bounds.v1', manifestSha256, engine: m.engine, operation: m.operation,
      startedAt: now, scanDeadline, waitBudgetMs: 15000, windowExpiresAt: windowIssuedAt + 300000,
      approvalExpiresAt, candidateExpiresAt, pinnedSha256, originalTimesChanged: false } };
}

export async function switchPair(m, { mode = 'switch', safety } = {}) {
  assert.ok(['switch', 'rollback'].includes(mode));
  assert.equal(safety?.protocol, SAFETY_PROTOCOL, 'An explicit reviewed release safety adapter is required');
  for (const method of mode === 'switch' ? ['beforeMaintenance', 'installFence', 'restoreBeforeStart'] : ['assertRollbackAllowed']) {
    assert.equal(typeof safety[method], 'function', 'Missing release safety callback: ' + method);
  }
  assert.ok(safety.onFailure === undefined || typeof safety.onFailure === 'function');
  const { manifestSha256 } = context(m); assertReleaseWindow(m);
  return locked(m, async () => {
    const builds = await verifyBoth(m, manifestSha256);
    await loadHdCompiledCacheProofs(m);
    const admissionRepair = mode === 'switch' ? assertSwitchAdmissionRepair(m) : null;
    const repairRuntime = admissionRepair ? guardBuildTailRuntime(m) : null;
    const repairSha256 = repairRuntime ? (repairRuntime.restoredOriginalRepair || repairRuntime.switchWindowRepair || repairRuntime.switchOwnerRepair || repairRuntime.switchScanRepair || repairRuntime.switchTypedRepair || repairRuntime.switchAdmissionRepair).proofSha256 : null;
    if (repairSha256) assert.match(repairSha256, /^[a-f0-9]{64}$/);
    const admissionName = name => repairSha256 ? name + '-' + repairSha256 : name;
    let before, frozenBefore, installed, master, temporary, published, protectedState, hdAdmissionRecord, admissionObservation, controlledDrainPhase = false;
    try {
      if (mode === 'switch') {
        const currentBefore = captureSwitchBefore(m, manifestSha256);
        before = currentBefore;
        if (admissionRepair) {
          ({ before, frozenBefore } = switchBeforeForAttempt(m, manifestSha256, admissionRepair, repairRuntime));
        }
        verifyNormalContinuation(m, currentBefore);
        if (m.deployedUsageSchema) { readDeployedUsageEvidence(m); assertPriorUsageRoleControl(m); }
        if (admissionRepair) {
          const boundLiveSnapshot = admissionRepair.restoredLiveSnapshot || admissionRepair.liveSnapshot;
          const live = assertSwitchAdmissionBefore(m, currentBefore, before, boundLiveSnapshot);
          const file = save(m, admissionName('switch-admission-before'), { ...currentBefore, originalBeforeSha256: admissionRepair.originalSwitchBeforeSha256,
            repairProofSha256: repairSha256, originalRecoveryBaselineRetained: true, live, boundLiveSnapshot,
            ...(repairRuntime.restoredOriginalRepair ? { restoredBeforeFile: admissionRepair.restoredSwitchBeforeFile,
              restoredBeforeSha256: admissionRepair.restoredSwitchBeforeSha256 } : {}) });
          admissionObservation = { file, sha256: sha(rootFile(file)) };
        } else { before = currentBefore; save(m, 'switch-before', before); }
        const { captured, hdLegacy } = currentBefore;
        protectedState = currentBefore.protection;
        let hdBefore;
        if (m.privateMultiviewInstall === true) {
          const bounds = privateHdAdmissionBounds(m, builds, manifestSha256);
          save(m, admissionName('hd-discovery-admission-bounds'), bounds.receipt);
          hdBefore = await inspectHdBeforeMaintenance(m, { sourceRoot: m.main.root, deadline: bounds.deadline,
            ...(isSharedEngine(m) ? { scanDeadline: bounds.scanDeadline, waitBudgetMs: bounds.waitBudgetMs } : {}), check: bounds.check,
            record: (name, value) => save(m, admissionName('hd-discovery-admission-' + name), { manifestSha256, ...value }) });
          bounds.check();
        } else hdBefore = await inspectHdReconciliation(m, { sourceRoot: m.main.root, retiredCachePhase: 'admission' });
        hdAdmissionRecord = recordHdAdmission(m, hdBefore);
        assert.equal(hdBefore.canEnterControlledDrain, true, 'HD work is in flight or unexplained; keep the original site and do not enter maintenance');
        master = captureSwitchPremaintenance(m, manifestSha256, hdBefore, repairRuntime?.restoredOriginalRepair || repairRuntime?.switchWindowRepair
          ? { repair: admissionRepair, repairSha256 } : undefined);
        const recoveryPair = buildPair({ captured, manifest: m, runId: m.runId, manifestSha256, reuseBuilds: m.reuseBuilds,
          main: candidateInput(m, 'main', builds.main), guard: candidateInput(m, 'guard', builds.guard) });
        if (isSharedEngine(m)) {
          const fixed = verifyGuardRecovery(m, frozenBefore || before).value;
          assertSwitchAdmissionWindows(m, fixed, admissionRepair);
          assert.equal(fixed.pair.runId, recoveryPair.runId);
          assert.equal(fixed.pair.manifestSha256, recoveryPair.manifestSha256);
          for (const kind of ['main', 'guard']) {
            const expected = recoveryPair.allowed.releases.find(item => item.source === m[kind].source);
            const actual = fixed.pair.allowed.releases.find(item => item.source === m[kind].source);
            assert.deepEqual(actual, expected, 'Armed fixed recovery artifact changed: ' + kind);
          }
          const armed = boundRecord(m, 'fixed-guard-recovery-armed', manifestSha256);
          assert.equal(armed.sha256, sha(rootFile(m.stage + '/fixed-guard-recovery.json')));
        } else save(m, 'fixed-guard-recovery-armed', { manifestSha256, ...armGuardRecovery(m, { before, pair: recoveryPair, builds }) });
        await releaseBoundary(m, 'preparation', 'intent', { manifestSha256, effectsStarted: false });
        await safety.beforeMaintenance({ m, before, builds });
        await releaseBoundary(m, 'preparation', 'result', { manifestSha256, effectsStarted: false,
          guardArmedSha256: sha(rootFile(m.stage + '/fixed-guard-recovery-armed.json')) });
        assertReleaseWindow(m);
        save(m, operationalRecordName(m, 'usage-role-readonly-admission'), { manifestSha256, ...inspectUsageRoleAdmission(m) });
        await releaseBoundary(m, 'drain', 'intent', { manifestSha256, effectsStarted: true,
          beforeSha256: sha(rootFile(repairRuntime?.restoredOriginalRepair ? admissionRepair.restoredSwitchBeforeFile : m.stage + '/switch-before.json')) });
        await stopUsageRole(m);
        installed = installNginxMaintenance({ captured: captureOperationalNginx(m) });
        controlledDrainPhase = true;
        save(m, operationalRecordName(m, 'ingress-503-switch'), { manifestSha256, responses: await observeMaintenance(m) });
        temporary = installNoForce(m, before, manifestSha256, mode);
        const firstSockets = captureNginxUpstreamSockets({ ...master, upstreamPort: 3302 });
        await waitFor(m, 'Old nginx upstream connections have not drained', () => captureNginxUpstreamSockets({ ...master, upstreamPort: 3302 }).count === 0);
        save(m, operationalRecordName(m, 'old-upstream-drained'), { manifestSha256, before: firstSockets, after: captureNginxUpstreamSockets({ ...master, upstreamPort: 3302 }) });
        for (const role of ['image', 'hd']) await stopNaturally(m, before, temporary, role, mode, before.writers[role]);
        const drainedCaches = await inspectHdReconciliation(m, { sourceRoot: m.main.root, final: true, retiredCachePhase: 'drained',
          ...(isSharedEngine(m) ? sharedReadOnlyHdBounds(m) : {}) });
        saveHdDrainResult(m, 'hd-retired-caches-after-whole-service-drain', manifestSha256, drainedCaches,
          'Whole HD service drain or exact retired cache evidence is incomplete');
        controlledDrainPhase = false;
        const fenced = await safety.installFence({ m, before, temporary, installed, master });
        assert.ok(fenced && Array.isArray(fenced.networkDropins) && fenced.receipt, 'Missing exact network fence evidence');
        temporary.fenceNetworkFiles = fenced.networkDropins.map(file => ({ ...file }));
        assertPolicy(m, before, temporary);
        save(m, 'network-fence-installed', { manifestSha256, protocol: SAFETY_PROTOCOL,
          networkDropins: temporary.fenceNetworkFiles, receipt: fenced.receipt });
        await stopNaturally(m, before, temporary, 'web', mode, before.writers.web);
        assertOriginalStopped(m, before); assertProtected(m, protectedState, installed);
        const hdStopped = await inspectHdReconciliation(m, { sourceRoot: m.main.root, final: true, retiredCachePhase: 'drained',
          ...(isSharedEngine(m) ? sharedReadOnlyHdBounds(m) : {}) });
        saveHdDrainResult(m, 'hd-reconciliation-stopped', manifestSha256, hdStopped, 'HD identity/ready/receipt/lease conflict after natural drain');
        assertHdStorageProtection(before.protection.hdStorage, readHdStorageProtection(m));
        await releaseBoundary(m, 'drain', 'result', { manifestSha256, effectsStarted: true,
          hdWholeDrainSha256: sha(rootFile(m.stage + '/' + operationalRecordName(m, 'hd-retired-caches-after-whole-service-drain') + '.json')) });
        const hdMetadata = captureHdMetadata(m);
        save(m, 'hd-metadata-stopped', { manifestSha256, roots: hdMetadata, sourceFiles: hdLegacy,
          controlOwner: 'canonical-original-worker', copiedLocks: false, copiedImages: false, automaticRestore: false });
        assert.deepEqual(captureHdMetadata(m), hdMetadata, 'HD metadata changed after all original writers stopped');
        const fresh = await verifyBoth(m, manifestSha256); Object.assign(builds, fresh);
        assertReleaseWindow(m);
        const pair = buildPair({ captured, manifest: m, runId: m.runId, manifestSha256, reuseBuilds: m.reuseBuilds,
          main: candidateInput(m, 'main', builds.main), guard: candidateInput(m, 'guard', builds.guard) });
        save(m, 'pricing-pair-definition', { manifestSha256, pair });
        await releaseBoundary(m, 'publish', 'intent', { manifestSha256, effectsStarted: true,
          pairSha256: sha(rootFile(m.stage + '/pricing-pair-definition.json')) });
        published = await publishPricingStartPair({ captured, pair, backupFile: m.stage + '/allowed-original.json',
          assertWritersStopped: () => { assertReleaseWindow(m); assertOriginalStopped(m, before); } });
        save(m, 'pricing-pair-published', { manifestSha256, published });
        const batchSchema = applyCanvasBatchMigration(m, () => { assertOriginalStopped(m, before); assertUsageRoleStopped(m); });
        if (batchSchema) save(m, 'canvas-batch-schema-ready', { manifestSha256, ...batchSchema, oldWritersStopped: true });
        if (m.fullRelease) {
          await stopMultiviewWorksForGuardRecovery(m, () => assertReleaseWindow(m));
          const stopped = () => { assertOriginalStopped(m, before); assertUsageRoleStopped(m); };
          const schema = applyFullSchema(m, stopped, assertReleaseWindow);
          save(m, 'full-schema-ready', { manifestSha256, ...schema, oldWritersStopped: true });
          const reuseProof = publishLegacyReuseWriterProof(m, stopped);
          if (reuseProof) save(m, 'task-reuse-legacy-writer-proof-published', { manifestSha256, ...reuseProof });
        }
        const prestart = actualPrestart(m, before, temporary, builds);
        save(m, 'actual-prestart', { manifestSha256, ...prestart });
        assertOriginalStopped(m, before);
        const uploadRecovery = (await import('./raw-upload-recovery-proof.mjs')).issueRawUploadRecoveryProof(m, {
          before, assertWritersStopped: () => assertOriginalStopped(m, before), published });
        save(m, 'raw-upload-recovery-published', { manifestSha256, ...uploadRecovery });
        await safety.restoreBeforeStart({ m, before, temporary, installed, master, published, builds, prestart });
        delete temporary.fenceNetworkFiles;
        assertPolicy(m, before, temporary);
        assertReleaseWindow(m); assertProtected(m, protectedState, installed);
        const intent = await markPricingWriterStartIntent({ captured, published,
          assertWritersStopped: () => { assertReleaseWindow(m); assertOriginalStopped(m, before); } });
        save(m, 'pricing-start-intent', { manifestSha256, intent });
        await releaseBoundary(m, 'publish', 'result', { manifestSha256, effectsStarted: true,
          publishedSha256: sha(rootFile(m.stage + '/pricing-pair-published.json')) });
      } else {
        before = operationalBeforeFile(m) === m.stage + '/switch-before.json'
          ? boundRecord(m, 'switch-before', manifestSha256)
          : normalizeSavedSwitchBefore(JSON.parse(rootFile(operationalBeforeFile(m))), m.runId, manifestSha256);
        published = boundRecord(m, 'pricing-pair-published', manifestSha256).published;
        await safety.assertRollbackAllowed({ m, before, published, builds });
        startIntent(m, published);
        assert.deepEqual(json(published.receiptFile), Object.fromEntries(Object.entries(published).filter(([key]) => !['receiptFile', 'receiptSha256'].includes(key))));
        assert.equal(sha(rootFile(published.receiptFile)), published.receiptSha256);
        installed = json(nginxInstalledFile(m));
        const currentProtection = readProtection(m);
        protectedState = { ...currentProtection, files: { ...currentProtection.files } };
        for (const file of installed.files) {
          const current = currentProtection.files[file.file];
          if (!current) continue;
          assert.ok([file.sha256, file.maintainedSha256].includes(current.sha256));
          assert.equal(sha(rootFile(file.backup)), file.sha256);
          assert.equal(before.protection.files[file.file].sha256, file.sha256);
          protectedState.files[file.file] = before.protection.files[file.file];
        }
        save(m, 'rollback-before', { manifestSha256, protection: currentProtection,
          expectedAfterOriginalNginxRestoration: protectedState, businessDataBaseline: 'current-at-rollback-not-before-first-switch' });
        const recordedMaster = boundRecord(m, 'nginx-master', manifestSha256);
        master = { masterPid: recordedMaster.masterPid, masterStart: recordedMaster.masterStart };
        const rearm = await rearmOwnedNginxMaintenance({ installed, nginxMaster: master, observeMaintenance: () => observeMaintenance(m) });
        assert.ok(rearm.responseEvidence && rearm.workerEvidence, 'Rollback must actually re-enter the captured nginx maintenance');
        await stopUsageRole(m);
        temporary = installNoForce(m, before, manifestSha256, mode);
        for (const role of ROLES) await stopNaturally(m, before, temporary, role, mode, null);
        for (const role of ROLES) {
          assert.ok(!exists('/proc/' + before.writers[role].MainPID)); assert.deepEqual(groupPids(before.writers[role].ControlGroup), []);
        }
        assertProtected(m, protectedState, installed); configure(m, before, temporary, 'guard');
        for (const role of PRICING_ROLES) {
          const accepted = JSON.parse(asApp(m, ['/usr/bin/node', PRICING_START_CONTROL + '/writer-start-guard.mjs', m.live[role].unit], m.guard.root));
          assert.equal(accepted.source, m.guardSource); assert.equal(accepted.build, builds.guard.build);
          assert.equal(accepted.sourceAndBuildVerified, true); assert.equal(accepted.barrierVerified, true);
        }
      }
      const kind = mode === 'switch' ? 'main' : 'guard';
      await releaseBoundary(m, 'health', 'intent', { manifestSha256, kind, effectsStarted: true,
        source: m[kind].source, build: builds[kind].build });
      const healthy = await start(m, before, temporary, kind, published, builds);
      const role = await startUsageRole(m, kind);
      const multiviewPrivate = await finishPrivateMultiviewPreopen(m, { kind, healthy, web: running(m, 'web', kind),
        observeMaintenance: () => observeMaintenance(m) });
      const prepared = json(originalPreparedFile(m, kind));
      const preparationManifest = originalManifestForInputs(m);
      const hdRuntimeProbe = await probeHdCandidateResolver(preparationManifest, preparationManifest[kind], prepared, { phase: 'runtime' });
      save(m, 'hd-runtime-probe-' + kind, { manifestSha256, ...hdRuntimeProbe,
        requestedByRun: m.runId, preparationRun: preparationManifest.runId,
        units: Object.fromEntries(ROLES.map(role => [role, running(m, role, kind)])) });
      assertReleaseWindow(m); assertProtected(m, protectedState, installed);
      await releaseBoundary(m, 'health', 'result', { manifestSha256, kind, effectsStarted: true,
        source: m[kind].source, build: builds[kind].build, healthy });
      restorePolicies(m, before, temporary, kind);
      assertReleaseWindow(m);
      await releaseBoundary(m, 'reopen', 'intent', { manifestSha256, kind, effectsStarted: true });
      const restored = await restoreNginxMaintenance({ installed, nginxMaster: master,
        healthyConsumers: { ...healthy, runId: installed.runId }, observeMaintenance: () => observeMaintenance(m),
        observeRestored: async () => {
          let evidence;
          await waitFor(m, 'Reloaded nginx has not served both healthy consumers', () => {
            try { evidence = TARGETS.map(target => observeRestored(m, kind, target)); return true; }
            catch (error) {
              if (error?.code !== 'ERR_ASSERTION' || error.actual !== 503 || error.expected !== 200) throw error;
              return false;
            }
          }, 30000);
          return evidence;
        } });
      const finalCapability = capability(m, kind);
      const finalHd = verifyHdSupervisor(m, kind);
      const after = assertProtected(m, protectedState);
      if (admissionObservation) assert.equal(sha(rootFile(admissionObservation.file)), admissionObservation.sha256, 'Fresh switch admission observation changed');
      const result = { schema: 'rate-impl2-switch-complete.v1', runId: m.runId, mode, manifestSha256, kind, healthy,
        imageCapability: finalCapability, nginx: restored,
        web: running(m, 'web', kind), image: running(m, 'image', kind), hd: finalHd, role, multiviewPrivate, roleProof: usageRoleProof(m), protection: after,
        at: new Date().toISOString(), databaseRestored: false, oldPairRestored: false };
      save(m, mode + '-complete', result);
      await releaseBoundary(m, 'reopen', 'result', { manifestSha256, kind, effectsStarted: true,
        completedReceiptSha256: sha(rootFile(m.stage + '/' + mode + '-complete.json')),
        source: m[kind].source, build: builds[kind].build });
      return result;
    } catch (error) {
      if (mode === 'switch' && before && !installed && !published
        && !fs.readdirSync(m.stage).some(file => /^(usage-role-transition|natural-stop)/.test(file)
          && (!repairRuntime?.restoredOriginalRepair || file.endsWith('-' + repairRuntime.restoredOriginalRepair.proofSha256 + '.json')))) {
        recordNormalRefusal(m, before, error, hdAdmissionRecord, repairSha256 ? {
          receiptName: admissionName('normal-switch-refusal') + '.json', logName: admissionName('normal-switch-refusal') + '.log',
        } : undefined);
      }
      if (before && !installed && !published) {
        try {
          await restoreOriginalUsageRole(m, () => {
            inspectRecoveryCertificate(m, before, { phase: 'early-original' });
            assert.equal(exists(PRICING_START_CONTROL + '/start-' + m.runId + '.json'), false);
            const actual = capturePricingStartControl();
            for (const key of ['control', 'guard', 'allowed', 'marker', 'chain']) assert.deepEqual(actual[key], before.captured[key]);
          });
        } catch (restorationError) {
          save(m, 'usage-role-early-restoration-failure-' + randomUUID(), { manifestSha256,
            originalFailure: String(error), restorationFailure: String(restorationError), forcedKill: false, businessDataRestored: false });
          throw new AggregateError([error, restorationError], 'Early role drain failed and original role restoration remains incomplete', { cause: error });
        }
      }
      if ((controlledDrainPhase && installed || error.maintenanceInstallationAborted) && !published) {
        let restoredOriginal, recoveryError;
        try { restoredOriginal = await restoreControlledDrain(m, before, temporary, installed, master); }
        catch (failure) { recoveryError = failure; }
        save(m, mode + '-failure-' + randomUUID(), { schema: 'rate-impl2-switch-failure.v1', manifestSha256, error: String(error),
          maintenance: restoredOriginal ? 'restored-original' : 'restoration-incomplete', restoredOriginal,
          ...(recoveryError ? { originalRecoveryError: String(recoveryError) } : {}),
          automaticOldPairRecovery: Boolean(restoredOriginal), databaseRestored: false,
          writerStartIntentPresent: false, newWriterStarted: false });
        if (recoveryError) throw new AggregateError([error, recoveryError], 'Controlled drain failed; original restoration is incomplete', { cause: error });
        throw error;
      }
      let maintenance = error?.maintenanceRearm || null;
      if (installed && !maintenance) {
        try { maintenance = await rearmOwnedNginxMaintenance({ installed, nginxMaster: master, observeMaintenance: () => observeMaintenance(m) }); }
        catch (rearmError) { maintenance = { status: 'unknown', error: String(rearmError), markerRetentionProvesMaintenance: false }; }
      }
      let safetyFailure = null, recoveryError;
      if (before && installed && exists(m.stage + '/fixed-guard-recovery.json')) {
        try { safetyFailure = await recoverFailedSwitch(m, { error, before, temporary, installed, master, published, builds, safety, alreadyLocked: true }); }
        catch (failure) { recoveryError = failure; }
      } else if (safety.onFailure) {
        try { safetyFailure = await safety.onFailure({ error, m, before, temporary, installed, master, published, builds }); }
        catch (failure) { recoveryError = failure; }
      }
      try {
        save(m, mode + '-failure-' + randomUUID(), { schema: 'rate-impl2-switch-failure.v1', manifestSha256, error: String(error),
          maintenance, safetyProtocol: SAFETY_PROTOCOL, safetyFailure,
          ...(recoveryError ? { safetyRecoveryError: String(recoveryError) } : {}),
          writerStartIntentPresent: exists(PRICING_START_CONTROL + '/start-' + m.runId + '.json'),
          automaticOldPairRecovery: false, databaseRestored: false });
      } catch (receiptError) {
        throw new AggregateError([error, ...(recoveryError ? [recoveryError] : []), receiptError], 'Release failed; failure receipt could not be saved', { cause: error });
      }
      if (recoveryError) throw new AggregateError([error, recoveryError], 'Release failed and safety recovery failed', { cause: error });
      throw error;
    }
  });
}

export function proof(m) {
  const { manifestSha256 } = context(m);
  return { schema: 'rate-impl2-switch-proof.v1', runId: m.runId, manifestSha256, at: new Date().toISOString(),
    units: Object.fromEntries(ROLES.map(role => [role, service(m, role)])), protection: readProtection(m),
    role: usageRoleProof(m),
    pricingStartControl: capturePricingStartControl(),
    writerStartIntent: exists(PRICING_START_CONTROL + '/start-' + m.runId + '.json')
      ? json(PRICING_START_CONTROL + '/start-' + m.runId + '.json') : null,
    readOnly: true };
}

