import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

// R03 copy of the reviewed private R02 helper; import has no IO or fallback.
// The caller supplies a fenceView copied from the original rate-impl2 manifest,
// adding exact live process/cgroup identity, healthUrl, Web dropin and both
// candidate cwdBytes snapshots. manifestSha256 always hashes ORIGINAL bytes.
// All fresh root-owned artifacts bind both that original SHA and fenceView SHA.
// Native reference hashes below describe the prior isolated native experiment,
// not execution or production authority for this copy. This module starts no unit.
const PROJECT = '/data/video-api-debugger';
const UNIT = 'sd2-gray.service';
const PORT = 3302;
const SELF = fileURLToPath(import.meta.url);
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_INSTALL_MS = 8000;
const SOCKET_MS = 500;
const RUNTIME_ROOTS = ['/run/systemd/system.control', '/run/systemd/transient', '/run/systemd/system'];
const DROPIN_ROOTS = [...RUNTIME_ROOTS, '/etc/systemd/system', '/usr/lib/systemd/system', '/usr/local/lib/systemd/system'];
export const WRITER_NETWORK_FENCE_LIMITS = Object.freeze({ installVerifyMs: MAX_INSTALL_MS,
  singleSocketMs: SOCKET_MS, requiredExternalLockWatchdogMs: 20000 });
const ENV = { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
export const WRITER_FENCE_NATIVE_REFERENCE_SHA256 = Object.freeze({
  controller: 'f938ddfd1f6ebcb316b8e40b049348b12a1659dc234483025e2a56785686b3dc',
  probe: 'b7cef416f3d35dedb1cd2a6ba20766827a3be03b11c0059b353226bed30c566a',
  sqlite: '7a92aea89828ec5f9313f7a63aaf686b67f04458b2bdeb7707992e1a1ae99fe8',
});
const digest = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b, message) => assert.deepEqual(a, b, message);
const canonical = value => typeof value === 'string' && path.resolve(value) === value;
const inside = (value, root) => canonical(value) && value.startsWith(root + '/');
const operationStage = m => path.join(m.stage, 'hd-release-safety-r03');
const binding = (m, manifestSha256) => ({ runId: m.runId, manifestSha256,
  operationStage: operationStage(m), fenceViewSha256: digest(JSON.stringify(m)), unit: m.live.web.unit,
  pid: m.live.web.pid, invocation: m.live.web.invocation, processStartTicks: m.live.web.processStartTicks,
  cgroup: m.live.web.cgroup, cgroupDev: m.live.web.cgroupDev, cgroupIno: m.live.web.cgroupIno,
  root: m.live.web.root, source: m.live.web.source, projectRoot: PROJECT, port: PORT,
  mainSource: m.mainSource, guardSource: m.guardSource });
const matchBinding = (value, expected) => {
  for (const [key, wanted] of Object.entries(expected)) equal(value?.[key], wanted, 'Fence binding differs: ' + key);
};
const fresh = (value, now, maximum = 10000) => {
  assert.ok(Number.isSafeInteger(value?.observedAt) && value.observedAt <= now && now - value.observedAt <= maximum, 'Stale fence proof');
};

export function assertWriterFenceManifest(m, manifestSha256) {
  assert.equal(m.schema, 'rate-impl2-release.v1'); assert.match(manifestSha256, HASH);
  assert.equal(m.projectRoot, PROJECT); assert.equal(m.appUser, 'gouki'); assert.match(m.runId, UUID);
  assert.match(m.mainSource, SHA); assert.match(m.guardSource, SHA); assert.notEqual(m.mainSource, m.guardSource);
  assert.ok(inside(m.stage, PROJECT + '/release-staging') && m.stage.endsWith('/' + m.runId));
  assert.equal(m.healthUrl, 'http://127.0.0.1:3302/api/release');
  for (const kind of ['main', 'guard']) {
    const source = m[kind + 'Source'];
    assert.equal(m[kind]?.source, source);
    assert.equal(m[kind]?.root, PROJECT + '/managed-releases/' + source);
    writerFenceClosedRuntimeDropin(m[kind].root, kind, m[kind].cwdBytes);
  }
  const web = m.live?.web;
  assert.equal(web?.unit, UNIT); assert.match(web.source, SHA);
  assert.equal(web.root, PROJECT + '/managed-releases/' + web.source);
  assert.ok(Number.isSafeInteger(web.pid) && web.pid > 1); assert.match(web.invocation, /^[a-f0-9]{32}$/);
  assert.match(web.processStartTicks, /^\d+$/);
  assert.equal(web.cgroup, '/system.slice/' + UNIT);
  for (const key of ['cgroupDev', 'cgroupIno']) assert.ok(Number.isSafeInteger(web[key]) && web[key] > 0);
  return binding(m, manifestSha256);
}

export function assertActiveWriterIdentity(target, expected) {
  equal(target.unit, expected.unit); equal(target.pid, expected.pid); equal(target.invocation, expected.invocation);
  equal(target.processStartTicks, expected.processStartTicks); equal(target.root, expected.root);
  equal(target.processRoot, expected.root);
  equal(target.source, expected.source); equal(target.cgroup, expected.cgroup);
  equal(target.cgroupDev, expected.cgroupDev); equal(target.cgroupIno, expected.cgroupIno);
  assert.equal(target.user, 'gouki'); assert.equal(target.activeState, 'active'); assert.equal(target.subState, 'running');
  assert.equal(target.mainProcCgroup, expected.cgroup); assert.equal(target.ownControllerInTargetCgroup, false);
  assert.ok(Number.isSafeInteger(target.processUid) && target.processUid > 0); equal(target.processUid, target.expectedAppUid);
  assert.equal(target.port3302BoundToCgroup, true, '3302 listener does not belong to the frozen writer');
  assert.ok(Number.isSafeInteger(target.established3302) && target.established3302 >= 0, 'Unknown established connection count');
  assert.equal(target.delegated, false, 'A delegated writer needs a separately reviewed subtree contract');
  return target;
}

export function assertWriterFenceTarget(target, expected) {
  assertActiveWriterIdentity(target, expected);
  assert.equal(target.established3302, 0, '3302 still has established connections');
  return target;
}

export function assertWriterFencePreconditions(proof, expected, now) {
  matchBinding(proof, expected); fresh(proof, now, 3000);
  for (const key of ['ingressAdmissionClosed', 'ingress503', 'imageStopped', 'imagePromiseSettled']) assert.equal(proof[key], true);
  assert.equal(proof.connections3302, 0); assert.equal(proof.stopRequested, false);
  assert.equal(proof.shortLock?.held, true); assert.equal(proof.shortLock?.kind, 'BEGIN IMMEDIATE');
  assert.equal(proof.shortLock?.syncCount, 0); assert.equal(proof.shortLock?.watchdogMs, 20000);
  assert.ok(Number.isSafeInteger(proof.shortLock.deadlineAt) && proof.shortLock.deadlineAt >= now + MAX_INSTALL_MS
    && proof.shortLock.deadlineAt <= now + 20000, 'Insufficient or unbounded lock watchdog');
}

function assertAuthority(authority, expected, now, operation) {
  matchBinding(authority, expected); assert.equal(authority.schema, 'trace03-writer-fence-authority.v1');
  assert.equal(authority.productionFenceApproved, true); assert.equal(authority.operation, operation);
  assert.match(authority.approvalSha256, HASH);
  assert.match(authority.helperSha256, HASH);
  assert.ok(Number.isSafeInteger(authority.issuedAt) && authority.issuedAt <= now
    && Number.isSafeInteger(authority.expiresAt) && authority.expiresAt >= now
    && authority.expiresAt - authority.issuedAt > 0 && authority.expiresAt - authority.issuedAt <= 300000);
}

export function assertWriterFenceProbeProgram(program, expected, approvedHelperSha256) {
  matchBinding(program, expected); assert.match(approvedHelperSha256, HASH);
  assert.equal(program.schema, 'trace03-public-fence-probe.v1');
  assert.equal(program.path, PROJECT + '/entry-maintenance/' + expected.runId + '/writer-network-fence-probe.mjs');
  equal(program.sha256, approvedHelperSha256); equal(program.sourceSha256, approvedHelperSha256);
  assert.equal(program.uid, 0); assert.equal(program.nlink, 1); assert.equal(program.mode, 0o444);
  assert.equal(program.runDirectoryUid, 0); assert.equal(program.runDirectoryMode, 0o755);
  assert.equal(program.entryDirectoryUid, 0); assert.equal(program.entryDirectoryMode, 0o755);
  assert.equal(program.privateStageUid, 0); assert.equal(program.privateStageMode, 0o700);
  assert.equal(program.sameByteProbeOnly, true); assert.equal(program.stagePermissionChanged, false);
  return program;
}

export function assertWriterFenceBpfAttachment(value) {
  assert.ok(Array.isArray(value));
  for (const kind of ['cgroup_inet_ingress', 'cgroup_inet_egress']) {
    assert.ok(value.some(item => item.attach_type === kind && Number.isSafeInteger(item.id) && item.id > 0), 'No actual BPF attachment: ' + kind);
  }
  return value;
}

// Historical export name retained for the controller API. "Closed" now means
// only real ingress 503 + all-old-writers-stopped proof; no fake app HOLD mode.
// cwdBytes is an approved exact UTF-8 snapshot supplied by the caller, not an
// environment-based admission gate invented here.
export function writerFenceClosedRuntimeDropin(root, kind = 'main', cwdBytes) {
  assert.ok(typeof root === 'string' && canonical(root) && root.startsWith(PROJECT + '/managed-releases/'));
  assert.match(root.slice((PROJECT + '/managed-releases/').length), SHA, 'Runtime root must be one exact managed source');
  assert.ok(kind === 'main' || kind === 'guard', 'Unknown runtime kind');
  assert.ok(typeof cwdBytes === 'string' && cwdBytes.length > 0 && Buffer.byteLength(cwdBytes) <= 65536);
  assert.ok(!cwdBytes.includes('\0') && cwdBytes.endsWith('\n'), 'Runtime snapshot must be exact UTF-8 text');
  assert.equal(cwdBytes.split('\n').filter(line => /^\s*WorkingDirectory\s*=/.test(line)).length, 1);
  assert.ok(cwdBytes.split('\n').includes('WorkingDirectory=' + root), 'Runtime snapshot has another WorkingDirectory');
  assert.ok(cwdBytes.split('\n').includes('[Service]'));
  assert.ok(!/\b(?:STUDIO_RELEASE_HOLD|STUDIO_ACCEPTED_ONLY)\s*=/.test(cwdBytes),
    'This release does not implement HOLD/accepted-only; ingress 503 is the gate');
  return cwdBytes;
}

function assertOriginalPolicy(policy) {
  for (const key of ['allow', 'deny', 'ingressFilters', 'egressFilters']) assert.equal(typeof policy.unit[key], 'string');
  assert.ok(Array.isArray(policy.parents)); equal(policy.parents.map(value => value.name).sort(), ['-.slice', 'system.slice']);
  for (const parent of policy.parents) {
    assert.ok(parent.name === 'system.slice' || parent.name === '-.slice');
    assert.equal(parent.allow, '', 'Parent Allow can override a unit deny; never edit parent/global policy');
  }
  for (const [file, entry] of Object.entries(policy.runtimeFiles)) {
    assert.ok(isManagedNetworkFile(file));
    assert.equal(entry.uid, 0); assert.equal(entry.nlink, 1); assert.equal(entry.mode & 0o022, 0);
    assert.match(entry.sha256, HASH); equal(digest(Buffer.from(entry.bytesBase64, 'base64')), entry.sha256);
  }
  assert.ok(policy.loadedDropins && typeof policy.loadedDropins === 'object');
  for (const [file, entry] of Object.entries(policy.loadedDropins)) {
    assert.ok(DROPIN_ROOTS.some(root => path.dirname(file) === root + '/' + UNIT + '.d')
      && canonical(file) && /^[A-Za-z0-9_.-]+\.conf$/.test(path.basename(file)), 'Unreviewed loaded unit dropin path');
    assert.equal(entry.uid, 0); assert.equal(entry.nlink, 1); assert.equal(entry.mode & 0o022, 0);
    assert.match(entry.sha256, HASH); equal(digest(Buffer.from(entry.bytesBase64, 'base64')), entry.sha256);
    if (policy.runtimeFiles[file]) equal(entry, policy.runtimeFiles[file], 'Loaded/runtime snapshot differs');
  }
}

function isManagedNetworkFile(file) {
  return RUNTIME_ROOTS.some(root => file === root + '/' + UNIT + '.d/50-IPAddressAllow.conf'
    || file === root + '/' + UNIT + '.d/50-IPAddressDeny.conf');
}
function assertOnlyOwnedNetworkDropinsChanged(current, original) {
  for (const file of new Set([...Object.keys(current.loadedDropins), ...Object.keys(original.loadedDropins)])) {
    if (!isManagedNetworkFile(file)) equal(current.loadedDropins[file], original.loadedDropins[file], 'Unowned loaded dropin drift: ' + file);
    else if (current.loadedDropins[file]) equal(current.loadedDropins[file], current.runtimeFiles[file], 'Loaded network file is not the exact runtime CAS object');
  }
}

function expectedRestoredWriterPolicy(m, receipt, phase, guardsProof, newPairProof) {
  const original = receipt.originalPolicy;
  if (phase === 'pre-stop-installation-abort') {
    assert.equal(newPairProof?.runtimeDropin, undefined, 'Pre-stop abort cannot authorize a candidate runtime transition');
    return original;
  }
  assert.equal(phase, 'before-new-writer-after-proven-old-stop');
  const transition = newPairProof?.runtimeDropin;
  assert.ok(transition, 'Post-stop restore needs the exact closed runtime dropin proof');
  assert.equal(guardsProof.closedMode, 'all-old-writers-stopped-ingress-503');
  const kind = transition.kind;
  assert.ok(kind === 'main' || kind === 'guard', 'Unknown candidate runtime kind');
  const source = m[kind + 'Source'], root = PROJECT + '/managed-releases/' + source;
  equal(m[kind]?.source, source, 'Candidate source differs from manifest');
  equal(m[kind]?.root, root, 'Candidate root differs from manifest');
  equal(transition.source, source, 'Runtime source differs from approved pair');
  equal(transition.root, root, 'Runtime root differs from approved pair');
  const file = m.live.web.dropin;
  assert.ok(canonical(file) && DROPIN_ROOTS.some(prefix => path.dirname(file) === prefix + '/' + UNIT + '.d')
    && /^[A-Za-z0-9_.-]+\.conf$/.test(path.basename(file)) && !isManagedNetworkFile(file), 'Unreviewed original runtime dropin');
  equal(transition.path, file, 'Only the original Web runtime dropin may transition');
  const prior = original.loadedDropins[file], entry = transition.entry;
  assert.ok(prior && entry, 'Original and replacement runtime entries must both exist');
  assert.equal(prior.uid, 0); assert.equal(prior.nlink, 1);
  equal(Object.keys(entry).sort(), ['uid', 'gid', 'mode', 'nlink', 'sha256', 'bytesBase64'].sort());
  for (const key of ['uid', 'gid', 'mode', 'nlink']) equal(entry[key], prior[key], 'Runtime metadata changed: ' + key);
  const body = writerFenceClosedRuntimeDropin(root, kind, m[kind].cwdBytes), bytes = Buffer.from(entry.bytesBase64, 'base64');
  equal(bytes.toString('base64'), entry.bytesBase64, 'Runtime bytes must use canonical base64');
  equal(bytes, Buffer.from(body), 'Runtime bytes are not the exact caller-approved CWD snapshot');
  assert.match(entry.sha256, HASH); equal(digest(bytes), entry.sha256, 'Runtime bytes/hash differ');
  // 唯一例外是已停止旧writer后的这一原文件；其它非网络dropin与父策略仍逐项严格相等。
  const expected = { ...original, loadedDropins: { ...original.loadedDropins, [file]: { ...entry } } };
  assertOriginalPolicy(expected);
  return expected;
}

export function assertWriterFenceProbeVerdict(proof, expected, denied) {
  matchBinding(proof, expected);
  assert.equal(proof.schema, 'trace03-exact-writer-cgroup-probe.v1');
  assert.equal(proof.sentinelOutsideTargetCgroup, true); assert.equal(proof.unixControl, true);
  assert.equal(proof.probeIdentityConfirmed, true); assert.equal(proof.inheritedChildIdentityConfirmed, true);
  equal(proof.unixControlEvidence?.map(value => value.pid), [proof.probePid, proof.childPid]);
  for (const value of proof.unixControlEvidence) {
    assert.equal(value.fd, 3); assert.match(value.inode, /^\d+$/);
    assert.equal(value.type, 'AF_UNIX/SOCK_STREAM'); assert.equal(value.kernelObserved, true);
  }
  assert.equal(proof.probeUid, proof.expectedAppUid); assert.ok(proof.probeUid > 0);
  equal(proof.probeCgroup, expected.cgroup); equal(proof.childCgroup, expected.cgroup);
  assert.equal(proof.productionHttpRequests, 0); assert.equal(proof.supplierRequests, 0);
  assert.ok(['old-and-fresh', 'fresh-only'].includes(proof.mode));
  const expectedChannels = denied && proof.mode !== 'fresh-only' ? ['old:4', 'old:6', 'new:4', 'new:6', 'child:4', 'child:6']
    : ['new:4', 'new:6', 'child:4', 'child:6'];
  equal(proof.results.map(value => value.channel + ':' + value.family).sort(), expectedChannels.sort());
  assert.equal(proof.results.every(value => value.ok === !denied), true);
  if (denied) {
    assert.equal(proof.sentinelHits.length, 0);
    assert.ok(proof.results.every(value => ['timeout', 'error', 'closed'].includes(value.outcome)));
  } else {
    assert.equal(proof.sentinelHits.length, 4);
    equal([...new Set(proof.sentinelHits.map(value => value.family))].sort(), [4, 6]);
  }
  return proof;
}

export function assertWriterFenceRestoreGate({ expected, authority, receipt, oldWriterProof, guardsProof, newPairProof, now }) {
  assertAuthority(authority, expected, now, 'restore'); matchBinding(receipt.binding, expected);
  assert.equal(authority.restorePhaseApproved, true, 'Restore phase is denied by default');
  matchBinding(oldWriterProof, expected); matchBinding(guardsProof, expected);
  fresh(oldWriterProof, now, 3000); fresh(guardsProof, now, 3000);
  for (const key of ['ingress503', 'ingressAdmissionClosed', 'noForceStop', 'imageStopped', 'imagePromiseSettled']) {
    assert.equal(guardsProof[key], true);
  }
  const phase = authority.approvedRestorePhase;
  if (phase === 'pre-stop-installation-abort') {
    assert.equal(receipt.phase, 'failed-keep-fence', 'Pre-stop restoration is only an explicitly failed installation abort');
    assert.equal(oldWriterProof.stopRequested, false);
    assertWriterFenceTarget(oldWriterProof.currentTarget, expected);
    assert.equal(oldWriterProof.originalIdentityStillActive, true);
    assert.equal(oldWriterProof.pairChanged, false);
  } else if (phase === 'before-new-writer-after-proven-old-stop') {
    assert.equal(oldWriterProof.stopRequested, true); assert.equal(oldWriterProof.originalProcessGone, true);
    assert.equal(oldWriterProof.oldCgroupGoneOrEmpty, true); equal(oldWriterProof.oldCgroupPids, []);
    assert.equal(oldWriterProof.currentUnitInactive, true); assert.equal(oldWriterProof.currentMainPid, 0);
    assert.equal(oldWriterProof.noNewWriterStarted, true);
    assert.equal(oldWriterProof.allOldWritersStopped, true);
    for (const key of ['allOldWritersStopped', 'hdStopped']) assert.equal(guardsProof[key], true);
    assert.equal(guardsProof.closedMode, 'all-old-writers-stopped-ingress-503');
    for (const key of ['releaseHold', 'acceptedOnly', 'newSourceMaintenance']) {
      assert.equal(guardsProof[key], undefined, 'Unsupported application admission claim: ' + key);
    }
    matchBinding(newPairProof, expected); fresh(newPairProof, now, 3000);
    for (const key of ['pairInstalled', 'execStartPreVerified', 'restartNoForceProtection']) assert.equal(newPairProof[key], true);
    assert.equal(newPairProof.actualNewServiceHealthClaimed, false, 'Build/prestart evidence is not runtime health');
    assert.match(newPairProof.mainSource, SHA); assert.match(newPairProof.guardSource, SHA);
    assert.notEqual(newPairProof.mainSource, newPairProof.guardSource);
  } else assert.fail('Unknown restore phase; keep fence and do not start any writer');
  return phase;
}

function regular(file, maximum = 1024 * 1024) {
  assert.equal(fs.realpathSync(file), file);
  const st = fs.lstatSync(file);
  assert.ok(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.uid === 0 && !(st.mode & 0o022) && st.size <= maximum);
  return st;
}
function proc(pid, allowExited = false) {
  const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
  assert.match(fields[19], /^\d+$/); if (!allowExited) assert.ok(!['Z', 'X', 'x'].includes(fields[0]));
  const uid = Number(/^Uid:\s+(\d+)/m.exec(fs.readFileSync('/proc/' + pid + '/status', 'utf8'))?.[1]);
  const group = /^0::([^\n]+)$/m.exec(fs.readFileSync('/proc/' + pid + '/cgroup', 'utf8'))?.[1];
  assert.ok(Number.isSafeInteger(uid) && group);
  return { pid, uid, state: fields[0], parentPid: Number(fields[1]), processStartTicks: fields[19], cgroup: group,
    root: fs.realpathSync('/proc/' + pid + '/cwd') };
}
function cgroupPids(directory) {
  const all = new Set(), pending = [directory]; let scanned = 0;
  while (pending.length) {
    assert.ok(++scanned <= 128, 'Unbounded cgroup subtree');
    const dir = pending.pop();
    for (const value of fs.readFileSync(path.join(dir, 'cgroup.procs'), 'utf8').split(/\s+/).filter(Boolean)) {
      assert.match(value, /^\d+$/); all.add(Number(value)); assert.ok(all.size <= 4096);
    }
    for (const value of fs.readdirSync(dir, { withFileTypes: true })) if (value.isDirectory()) pending.push(path.join(dir, value.name));
  }
  return [...all].sort((a, b) => a - b);
}

export function createNativeWriterFenceIO() {
  const now = Date.now;
  const checkedStages = new Set();
  const commandAudit = [];
  const root = () => { assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
    assert.equal(Number(process.versions.node.split('.')[0]), 20, 'Reviewed native executor is Node 20'); };
  const call = (bin, args, deadline = now() + 1200) => {
    root(); const remaining = deadline - now(); assert.ok(remaining > 0, 'Fence deadline exceeded');
    const at = now();
    try {
      const stdout = execFileSync(bin, args, { encoding: 'utf8', env: ENV, timeout: Math.min(remaining, 1200), maxBuffer: 1024 * 1024 }).trim();
      commandAudit.push({ bin, args, at, elapsedMs: now() - at, exit: 0, stdout: stdout.slice(0, 16384) });
      return stdout;
    } catch (error) {
      commandAudit.push({ bin, args, at, elapsedMs: now() - at, exit: error.status ?? null,
        code: error.code || null, stderr: String(error.stderr || '').slice(0, 16384) });
      throw error;
    }
  };
  const service = deadline => Object.fromEntries(call('systemctl', ['show', '-p', 'Id', '-p', 'MainPID', '-p', 'User', '-p', 'ActiveState',
    '-p', 'SubState', '-p', 'InvocationID', '-p', 'WorkingDirectory', '-p', 'ControlGroup', '-p', 'Delegate', '-p', 'Job', '--', UNIT], deadline)
    .split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
  const network = (unit, deadline) => {
    assert.ok([UNIT, 'system.slice', '-.slice'].includes(unit));
    const values = Object.fromEntries(call('systemctl', ['show', '-p', 'IPAddressAllow', '-p', 'IPAddressDeny',
      '-p', 'IPIngressFilterPath', '-p', 'IPEgressFilterPath', '-p', 'DropInPaths', '--', unit], deadline).split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
    return { name: unit, allow: values.IPAddressAllow || '', deny: values.IPAddressDeny || '',
      ingressFilters: values.IPIngressFilterPath || '', egressFilters: values.IPEgressFilterPath || '',
      dropInPaths: (values.DropInPaths || '').split(/\s+/).filter(Boolean) };
  };
  const snapshotFile = file => {
    const st = regular(file, 65536), bytes = fs.readFileSync(file);
    return { uid: st.uid, gid: st.gid, mode: st.mode & 0o777, nlink: st.nlink,
      sha256: digest(bytes), bytesBase64: bytes.toString('base64') };
  };
  const files = () => {
    const output = {};
    for (const prefix of RUNTIME_ROOTS) {
      const dir = path.join(prefix, UNIT + '.d');
      if (fs.existsSync(dir)) { assert.equal(fs.realpathSync(dir), dir); const st = fs.statSync(dir);
        assert.equal(st.uid, 0); assert.equal(st.mode & 0o022, 0); }
      for (const name of ['50-IPAddressAllow.conf', '50-IPAddressDeny.conf']) {
        const file = path.join(dir, name); if (!fs.existsSync(file)) continue;
        output[file] = snapshotFile(file);
      }
    }
    return output;
  };
  const stage = m => {
    root(); assert.equal(fs.realpathSync(m.stage), m.stage);
    const opStage = operationStage(m);
    assert.equal(fs.realpathSync(opStage), opStage);
    const opStat = fs.lstatSync(opStage);
    assert.ok(opStat.isDirectory() && !opStat.isSymbolicLink() && opStat.uid === 0 && (opStat.mode & 0o777) === 0o700,
      'R03 operation directory must be exact root0700');
    assert.equal(path.dirname(SELF), opStage, 'Native helper must run from the fixed R03 operation directory');
    equal(fs.lstatSync(m.stage).mode & 0o777, 0o700, 'Private stage must remain root0700');
    for (let dir = m.stage; dir !== '/data'; dir = path.dirname(dir)) {
      const st = fs.lstatSync(dir); assert.ok(st.isDirectory() && !st.isSymbolicLink() && st.uid === 0 && !(st.mode & 0o022));
      assert.ok(inside(dir, '/data'));
    }
    if (!checkedStages.has(m.stage)) {
      assert.equal(call('findmnt', ['-n', '-o', 'TARGET', '-T', m.stage]), '/data');
      checkedStages.add(m.stage);
    }
  };
  const probeProgram = (m, expected, approvedHelperSha256, create = false) => {
    root(); stage(m); assert.match(approvedHelperSha256, HASH);
    regular(SELF); const bytes = fs.readFileSync(SELF); equal(digest(bytes), approvedHelperSha256, 'Executing helper is not the approved source');
    const entry = PROJECT + '/entry-maintenance', run = entry + '/' + expected.runId;
    for (const directory of [entry, run]) {
      if (create && !fs.existsSync(directory)) {
        fs.mkdirSync(directory, { mode: 0o755 });
        const parent = fs.openSync(path.dirname(directory), 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      }
      assert.equal(fs.realpathSync(directory), directory); const st = fs.lstatSync(directory);
      assert.ok(st.isDirectory() && !st.isSymbolicLink()); equal(st.uid, 0); equal(st.mode & 0o777, 0o755);
    }
    const file = run + '/writer-network-fence-probe.mjs';
    if (create && !fs.existsSync(file)) {
      // 只公开同字节无凭据源码，不复制stage/receipt/env，且不改变stage的0700权限。
      const temp = file + '.' + randomUUID() + '.tmp', fd = fs.openSync(temp, 'wx', 0o444);
      try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, 0o444); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try { fs.linkSync(temp, file); } finally { fs.unlinkSync(temp); } // 不覆盖任何并发创建的对象。
      const dir = fs.openSync(run, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
    const st = regular(file); equal(st.mode & 0o777, 0o444); equal(digest(fs.readFileSync(file)), approvedHelperSha256);
    return assertWriterFenceProbeProgram({ schema: 'trace03-public-fence-probe.v1', ...expected, path: file,
      sha256: approvedHelperSha256, sourceSha256: digest(bytes), uid: st.uid, nlink: st.nlink, mode: st.mode & 0o777,
      runDirectoryUid: 0, runDirectoryMode: 0o755, entryDirectoryUid: 0, entryDirectoryMode: 0o755,
      privateStageUid: 0, privateStageMode: 0o700,
      sameByteProbeOnly: true, stagePermissionChanged: false, preparedAt: now() }, expected, approvedHelperSha256);
  };
  const atomic = (file, bytes, existingSha) => {
    if (fs.existsSync(file)) { regular(file); assert.equal(digest(fs.readFileSync(file)), existingSha); }
    else assert.equal(existingSha, null);
    const temp = file + '.' + randomUUID() + '.tmp'; const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file); const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    return digest(bytes);
  };
  return {
    kind: 'native', now, commandEvidence: () => [...commandAudit],
    prepareProbe: (m, expected, approvedHelperSha256) => probeProgram(m, expected, approvedHelperSha256, true),
    acquire: (m, expected, operation, authority) => {
      stage(m);
      const file = path.join(operationStage(m), 'writer-network-fence.operation.lock');
      if (fs.existsSync(file)) {
        regular(file, 16384); const bytes = fs.readFileSync(file), prior = JSON.parse(bytes);
        matchBinding(prior.binding, expected);
        assert.equal(authority?.takeoverDeadController, true, 'Existing operation lease requires explicit dead-owner takeover');
        assert.equal(authority.takeoverLeaseSha256, digest(bytes));
        let gone = false;
        try { gone = proc(prior.pid).processStartTicks !== prior.processStartTicks; }
        catch (error) { if (error.code !== 'ENOENT') throw error; gone = true; }
        assert.equal(gone, true, 'The previous controller still owns this operation');
        const preserved = file + '.dead-' + digest(bytes) + '.json'; assert.equal(fs.existsSync(preserved), false);
        fs.renameSync(file, preserved); // 精确归档死亡控制器lease，不动其网络栅栏。
      }
      const lease = { schema: 'trace03-writer-fence-operation.v1', binding: expected, operation,
        pid: process.pid, processStartTicks: proc(process.pid).processStartTicks, nonce: randomUUID() };
      const bytes = JSON.stringify(lease) + '\n', fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const dir = fs.openSync(operationStage(m), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      return { file, sha256: digest(bytes), ...lease };
    },
    release: lease => {
      regular(lease.file, 16384); equal(digest(fs.readFileSync(lease.file)), lease.sha256, 'Operation lease CAS conflict');
      equal(proc(process.pid).processStartTicks, lease.processStartTicks);
      fs.unlinkSync(lease.file);
      const dir = fs.openSync(path.dirname(lease.file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    },
    inspect: (m, expected, deadline) => {
      const value = service(deadline), current = proc(expected.pid), group = '/sys/fs/cgroup' + expected.cgroup;
      const st = fs.statSync(group);
      const established = call('ss', ['-Htnp', 'state', 'established', '( sport = :3302 or dport = :3302 )'], deadline);
      const listeners = call('ss', ['-Hlnpt', 'sport = :3302'], deadline);
      const listenerPids = [...listeners.matchAll(/pid=(\d+)/g)].map(match => Number(match[1]));
      const expectedAppUid = Number(call('id', ['-u', 'gouki'], deadline));
      const port3302BoundToCgroup = listenerPids.length > 0 && listenerPids.every(pid => {
        const listener = proc(pid);
        return listener.cgroup === expected.cgroup && listener.root === expected.root && listener.uid === expectedAppUid;
      });
      return { unit: value.Id, pid: Number(value.MainPID), invocation: value.InvocationID,
        processStartTicks: current.processStartTicks, root: fs.realpathSync(value.WorkingDirectory), processRoot: current.root,
        source: fs.readFileSync(path.join(current.root, '.deployed-commit'), 'utf8').trim(),
        cgroup: value.ControlGroup, cgroupDev: st.dev, cgroupIno: st.ino, user: value.User,
        activeState: value.ActiveState, subState: value.SubState, mainProcCgroup: current.cgroup,
        processUid: current.uid, expectedAppUid, port3302BoundToCgroup,
        ownControllerInTargetCgroup: proc(process.pid).cgroup === expected.cgroup || proc(process.pid).cgroup.startsWith(expected.cgroup + '/'),
        established3302: established ? established.split('\n').length : 0, delegated: value.Delegate !== 'no' };
    },
    policy: (_m, deadline) => {
      const { dropInPaths, ...unit } = network(UNIT, deadline), loadedDropins = {};
      for (const file of dropInPaths) {
        assert.ok(canonical(file) && DROPIN_ROOTS.some(prefix => path.dirname(file) === prefix + '/' + UNIT + '.d')
          && /^[A-Za-z0-9_.-]+\.conf$/.test(path.basename(file)), 'Unreviewed actual DropInPaths');
        const dir = fs.statSync(path.dirname(file)); assert.equal(dir.uid, 0); assert.equal(dir.mode & 0o022, 0);
        loadedDropins[file] = snapshotFile(file);
      }
      const parents = ['system.slice', '-.slice'].map(name => { const { dropInPaths: _paths, ...value } = network(name, deadline); return value; });
      return { unit, parents, runtimeFiles: files(), loadedDropins };
    },
    setNetwork: (_m, allow, deny, expectedFiles, deadline) => {
      equal(files(), expectedFiles, 'Runtime dropin CAS/owner mismatch');
      call('systemctl', ['set-property', '--runtime', UNIT, 'IPAddressAllow=' + allow, 'IPAddressDeny=' + deny], deadline);
    },
    bpf: (expected, deadline) => {
      const value = JSON.parse(call('bpftool', ['-j', 'cgroup', 'show', '/sys/fs/cgroup' + expected.cgroup], deadline));
      return assertWriterFenceBpfAttachment(value);
    },
    verifyArtifact: (proof, m) => {
      assert.ok(inside(proof.artifact?.path, operationStage(m))); assert.match(proof.artifact?.sha256, HASH);
      regular(proof.artifact.path); const bytes = fs.readFileSync(proof.artifact.path);
      assert.equal(digest(bytes), proof.artifact.sha256);
      const { artifact, ...body } = proof; equal(JSON.parse(bytes), body);
    },
    persist: (m, receipt, priorSha) => { stage(m); return atomic(path.join(operationStage(m), 'writer-network-fence.v1.json'), JSON.stringify(receipt) + '\n', priorSha); },
    readReceipt: m => { stage(m); const file = path.join(operationStage(m), 'writer-network-fence.v1.json'); regular(file);
      const bytes = fs.readFileSync(file); return { ...JSON.parse(bytes), receiptSha256: digest(bytes) }; },
    oldState: (m, expected, deadline) => {
      const value = service(deadline); let originalProcessGone = false;
      try { originalProcessGone = proc(expected.pid).processStartTicks !== expected.processStartTicks; }
      catch (error) { if (error.code !== 'ENOENT') throw error; originalProcessGone = true; }
      const group = '/sys/fs/cgroup' + expected.cgroup;
      let oldCgroupPids = [], oldCgroupGoneOrEmpty = false;
      if (!fs.existsSync(group)) oldCgroupGoneOrEmpty = true;
      else {
        const st = fs.statSync(group), currentPids = cgroupPids(group);
        // 同路径新建的 cgroup 不是旧 inode，但恢复前仍禁止任何新 writer。
        oldCgroupGoneOrEmpty = st.dev !== expected.cgroupDev || st.ino !== expected.cgroupIno || currentPids.length === 0;
        oldCgroupPids = st.dev === expected.cgroupDev && st.ino === expected.cgroupIno ? currentPids : [];
        assert.equal(currentPids.length, 0, 'Another writer already uses the unit cgroup');
      }
      return { originalProcessGone, oldCgroupGoneOrEmpty, oldCgroupPids,
        currentUnitInactive: ['inactive', 'failed'].includes(value.ActiveState) && ['dead', 'failed'].includes(value.SubState)
          && (!value.Job || value.Job === '0'), currentMainPid: Number(value.MainPID), noNewWriterStarted: Number(value.MainPID) === 0 };
    },
    restoreFiles: (original, current, deadline) => {
      equal(files(), current, 'Restore runtime-file CAS mismatch');
      for (const file of new Set([...Object.keys(current), ...Object.keys(original)])) {
        if (original[file]) {
          const before = current[file]?.sha256 ?? null;
          atomic(file, Buffer.from(original[file].bytesBase64, 'base64'), before);
          fs.chownSync(file, original[file].uid, original[file].gid); fs.chmodSync(file, original[file].mode);
          const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        } else {
          regular(file); equal(digest(fs.readFileSync(file)), current[file].sha256);
          fs.unlinkSync(file); // 已有完整字节备份位于耐久receipt；仅删除本run新增的精确网络文件。
        }
        const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      }
      call('systemctl', ['daemon-reload'], deadline);
      equal(files(), original, 'Exact original network dropins not restored');
    },
    openProbe: (m, expected, deadline, preparedProgram) => {
      assertWriterFenceProbeProgram(preparedProgram, expected, preparedProgram.sha256);
      const actual = probeProgram(m, expected, preparedProgram.sha256);
      return openNativeProbe(m, expected, deadline, actual.path);
    },
  };
}

function receiptBody(receipt) { const { receiptSha256, ...body } = receipt; return body; }
function checkReceipt(receipt, expected) {
  matchBinding(receipt.binding, expected); assert.equal(receipt.schema, 'trace03-writer-network-fence.v1');
  assert.match(receipt.receiptSha256, HASH); equal(digest(JSON.stringify(receiptBody(receipt)) + '\n'), receipt.receiptSha256);
  assertOriginalPolicy(receipt.originalPolicy);
}
async function save(io, m, receipt, priorSha) {
  const body = { ...receiptBody(receipt), commandEvidence: io.commandEvidence?.() || [], evidenceKind: io.kind === 'native' ? 'native' : 'offline-fixture' };
  const sha256 = await io.persist(m, body, priorSha);
  return { ...body, receiptSha256: sha256 };
}
function assertFencedPolicy(policy, original) {
  assertOriginalPolicy(policy); assertOnlyOwnedNetworkDropinsChanged(policy, original);
  equal(policy.parents, original.parents, 'Parent policy drift');
  assert.equal(policy.unit.allow, '', 'A remaining Allow overrides Deny');
  const denied = new Set(policy.unit.deny.split(/\s+/));
  assert.ok(denied.has('0.0.0.0/0') && denied.has('::/0'), 'Both families must be denied');
  equal(policy.unit.ingressFilters, original.unit.ingressFilters); equal(policy.unit.egressFilters, original.unit.egressFilters);
}

export async function inspectWriterFenceTarget({ manifest: m, manifestSha256, phase = 'drained', io = createNativeWriterFenceIO() }) {
  assert.ok(['live-before-maintenance', 'drained'].includes(phase));
  const expected = assertWriterFenceManifest(m, manifestSha256);
  const observed = await io.inspect(m, expected, io.now() + MAX_INSTALL_MS);
  const target = phase === 'live-before-maintenance'
    ? assertActiveWriterIdentity(observed, expected) : assertWriterFenceTarget(observed, expected);
  const policy = await io.policy(m, io.now() + MAX_INSTALL_MS); assertOriginalPolicy(policy);
  return { binding: expected, target, policy, observedAt: io.now() };
}

export async function prepareWriterFenceProbe({ manifest: m, manifestSha256, authority, approvedHelperSha256, io = createNativeWriterFenceIO() }) {
  const expected = assertWriterFenceManifest(m, manifestSha256);
  assertAuthority(authority, expected, io.now(), 'install'); equal(authority.helperSha256, approvedHelperSha256);
  await io.verifyArtifact(authority, m);
  return assertWriterFenceProbeProgram(await io.prepareProbe(m, expected, approvedHelperSha256), expected, approvedHelperSha256);
}

async function installFenceImplementation({ manifest: m, manifestSha256, authority, preconditions, probeProgram, io, operationStartedAt }) {
  const startedAt = operationStartedAt, deadline = startedAt + MAX_INSTALL_MS;
  const expected = assertWriterFenceManifest(m, manifestSha256);
  assertAuthority(authority, expected, io.now(), 'install'); assertWriterFencePreconditions(preconditions, expected, io.now());
  assertWriterFenceProbeProgram(probeProgram, expected, authority.helperSha256);
  await io.verifyArtifact(authority, m); await io.verifyArtifact(preconditions, m);
  assertWriterFenceTarget(await io.inspect(m, expected, deadline), expected);
  const originalPolicy = await io.policy(m, deadline); assertOriginalPolicy(originalPolicy);
  let receipt = await save(io, m, { schema: 'trace03-writer-network-fence.v1', binding: expected,
    phase: 'prepared', startedAt, deadline, originalPolicy, probeProgram, authoritySha256: authority.approvalSha256,
    referenceNativeSha256: WRITER_FENCE_NATIVE_REFERENCE_SHA256, expectedRuntimeFiles: originalPolicy.runtimeFiles,
    productionHttpRequests: 0, supplierRequests: 0, stopRequestedByThisModule: false }, null);
  let probe;
  try {
    probe = await io.openProbe(m, expected, deadline, probeProgram);
    const baseline = assertWriterFenceProbeVerdict(await probe.baseline(), expected, false);
    assertWriterFenceTarget(await io.inspect(m, expected, deadline), expected);
    equal((await io.policy(m, deadline)), originalPolicy, 'Policy drift before installation');
    // 先耐久记下将写入的唯一unit。崩溃/SSH断开不执行自动恢复。
    receipt = await save(io, m, { ...receipt, phase: 'installing', baseline }, receipt.receiptSha256);
    await io.setNetwork(m, '', 'any', receipt.expectedRuntimeFiles, deadline);
    const installed = await io.policy(m, deadline);
    receipt = await save(io, m, { ...receipt, phase: 'installed-unverified', expectedRuntimeFiles: installed.runtimeFiles,
      observedInstalledPolicy: installed }, receipt.receiptSha256);
    assertFencedPolicy(installed, originalPolicy);
    const bpf = await io.bpf(expected, deadline);
    const rejection = assertWriterFenceProbeVerdict(await probe.rejection(), expected, true);
    assert.equal(rejection.mode, 'old-and-fresh', 'Install must exercise its actual pre-fence sockets');
    assertWriterFenceTarget(await io.inspect(m, expected, deadline), expected);
    assertFencedPolicy(await io.policy(m, deadline), originalPolicy);
    assert.ok(io.now() <= deadline, 'install+sentinel verification exceeded eight seconds');
    receipt = await save(io, m, { ...receipt, phase: 'verified', bpf, rejection, verifiedAt: io.now(),
      elapsedMs: io.now() - startedAt, actionAfterReturn: 'Immediately rollback the external empty SQLite lock; never wait for Web stop while holding it' }, receipt.receiptSha256);
    assert.ok(io.now() <= deadline, 'Durable install receipt exceeded eight seconds');
    return receipt;
  } catch (error) {
    // 失败不能被当作停止许可。主控只能走显式pre-stop abort gate；未知/已stop一律保栅栏。
    receipt = await save(io, m, { ...receipt, phase: 'failed-keep-fence', failure: String(error.message).slice(0, 1000),
      failedAt: io.now(), actionAfterReturn: 'Release external short lock. Do not stop/switch until resolved; explicit pre-stop abort restore requires fresh exact-live/503 proof.' }, receipt.receiptSha256);
    throw Object.assign(new Error('writer_network_fence_install_unverified'), { cause: error, receipt });
  } finally { await probe?.close(); }
}

async function verifyFenceImplementation({ manifest: m, receipt, io, operationStartedAt }) {
  const expected = assertWriterFenceManifest(m, receipt.binding.manifestSha256); checkReceipt(receipt, expected);
  if (io.kind === 'native') { assert.equal(receipt.evidenceKind, 'native'); equal(await io.readReceipt(m), receipt, 'Stale durable fence receipt'); }
  assert.equal(receipt.phase, 'verified');
  const deadline = operationStartedAt + MAX_INSTALL_MS;
  assertWriterFenceTarget(await io.inspect(m, expected, deadline), expected);
  const policy = await io.policy(m, deadline); assertFencedPolicy(policy, receipt.originalPolicy);
  equal(policy.runtimeFiles, receipt.expectedRuntimeFiles, 'Fence runtime owner/CAS drift');
  const probe = await io.openProbe(m, expected, deadline, receipt.probeProgram);
  try {
    // 验证已有栅栏时不能再次要求baseline联网；旧socket项目由原install同会话证据保留。
    const rejection = assertWriterFenceProbeVerdict(await probe.rejection(), expected, true);
    return { binding: expected, observedAt: io.now(), bpf: await io.bpf(expected, deadline), rejection };
  } finally { await probe.close(); }
}

async function restoreFenceImplementation({ manifest: m, receipt, authority, oldWriterProof, guardsProof, newPairProof, io, operationStartedAt }) {
  const expected = assertWriterFenceManifest(m, receipt.binding.manifestSha256); checkReceipt(receipt, expected);
  if (io.kind === 'native') { assert.equal(receipt.evidenceKind, 'native'); equal(await io.readReceipt(m), receipt, 'Stale durable fence receipt'); }
  assert.ok(['verified', 'installed-unverified', 'installing', 'failed-keep-fence'].includes(receipt.phase));
  const now = io.now(), deadline = operationStartedAt + MAX_INSTALL_MS;
  const phase = assertWriterFenceRestoreGate({ expected, authority, receipt, oldWriterProof, guardsProof, newPairProof, now });
  const expectedRestoredPolicy = expectedRestoredWriterPolicy(m, receipt, phase, guardsProof, newPairProof);
  for (const proof of [authority, oldWriterProof, guardsProof, ...(newPairProof ? [newPairProof] : [])]) await io.verifyArtifact(proof, m);
  if (phase === 'pre-stop-installation-abort') assertWriterFenceTarget(await io.inspect(m, expected, deadline), expected);
  else equal(await io.oldState(m, expected, deadline), {
    originalProcessGone: true, oldCgroupGoneOrEmpty: true, oldCgroupPids: [], currentUnitInactive: true, currentMainPid: 0, noNewWriterStarted: true });
  const current = await io.policy(m, deadline);
  assertOriginalPolicy(current); assertOnlyOwnedNetworkDropinsChanged(current, expectedRestoredPolicy);
  for (const key of ['name', 'ingressFilters', 'egressFilters']) equal(current.unit[key], receipt.originalPolicy.unit[key], 'Non-address unit policy drift: ' + key);
  equal(current.parents, receipt.originalPolicy.parents, 'Parent policy drift');
  equal(current.runtimeFiles, receipt.expectedRuntimeFiles, 'Restore network-file owner/CAS conflict');
  let updated = await save(io, m, { ...receipt, phase: 'restoring', restorePhase: phase,
    restoreApprovalSha256: authority.approvalSha256, restoreStartedAt: io.now(),
    expectedRestoredPolicy, allowedRuntimeDropinTransition: phase === 'pre-stop-installation-abort' ? null : {
      ...newPairProof.runtimeDropin, originalEntry: receipt.originalPolicy.loadedDropins[m.live.web.dropin],
      approvedPhase: phase, closedMode: guardsProof.closedMode } }, receipt.receiptSha256);
  try {
    await io.setNetwork(m, receipt.originalPolicy.unit.allow, receipt.originalPolicy.unit.deny, current.runtimeFiles, deadline);
    const changed = await io.policy(m, deadline);
    equal(changed.unit, receipt.originalPolicy.unit, 'Original effective policy not restored');
    await io.restoreFiles(receipt.originalPolicy.runtimeFiles, changed.runtimeFiles, deadline);
    equal(await io.policy(m, deadline), expectedRestoredPolicy, 'Exact policy/files differ after approved restoration');
    if (phase === 'pre-stop-installation-abort') assertWriterFenceTarget(await io.inspect(m, expected, deadline), expected);
    else equal(await io.oldState(m, expected, deadline), {
      originalProcessGone: true, oldCgroupGoneOrEmpty: true, oldCgroupPids: [], currentUnitInactive: true, currentMainPid: 0, noNewWriterStarted: true });
    updated = await save(io, m, { ...updated, phase: 'restored', restoredAt: io.now(),
      next: phase === 'pre-stop-installation-abort' ? 'Keep the original live pair and report the aborted switch' : 'Outer controller may now start the already-authorized main/guard and collect actual service health' }, updated.receiptSha256);
    return updated;
  } catch (error) {
    // 恢复过程中若身份漂移，重新请求此唯一unit的deny，不启动/回滚pair；失败状态必须人工核对。
    let reFenced = false;
    try { const observed = await io.policy(m, io.now() + 1200); await io.setNetwork(m, '', 'any', observed.runtimeFiles, io.now() + 1200); reFenced = true; } catch {}
    updated = await save(io, m, { ...updated, phase: 'restore-unknown-keep-fence', reFenceRequested: reFenced,
      failure: String(error.message).slice(0, 1000), next: 'Do not start or restore any writer pair' }, updated.receiptSha256);
    throw Object.assign(new Error('writer_network_fence_restore_unknown'), { cause: error, receipt: updated });
  }
}

async function withOperation(operation, input, implementation) {
  const io = input.io || createNativeWriterFenceIO(), operationStartedAt = io.now();
  const expected = assertWriterFenceManifest(input.manifest, input.manifestSha256 || input.receipt?.binding?.manifestSha256);
  if (operation !== 'verify') assertAuthority(input.authority, expected, operationStartedAt, operation);
  const lease = await io.acquire?.(input.manifest, expected, operation, input.authority);
  let result;
  try { result = await implementation({ ...input, io, operationStartedAt }); }
  finally { if (lease) await io.release(lease); }
  if (operation !== 'restore' && io.now() > operationStartedAt + MAX_INSTALL_MS) {
    if (operation === 'install') result = await save(io, input.manifest, { ...result, phase: 'failed-keep-fence',
      failure: 'Cleanup/durable operation exceeded eight-second budget; no stop permission', failedAt: io.now() }, result.receiptSha256);
    throw Object.assign(new Error('writer_network_fence_total_deadline_exceeded'), { receipt: operation === 'install' ? result : undefined });
  }
  return result;
}

export const installWriterNetworkFence = input => withOperation('install', input, installFenceImplementation);
export const verifyWriterNetworkFence = input => withOperation('verify', input, verifyFenceImplementation);
export const restoreWriterNetworkFence = input => withOperation('restore', input, restoreFenceImplementation);

export function assertWriterFencePolicy({ current, original }) {
  assertOriginalPolicy(original); assertFencedPolicy(current, original);
}

export async function readWriterNetworkFenceReceipt({ manifest, manifestSha256, io = createNativeWriterFenceIO() }) {
  const expected = assertWriterFenceManifest(manifest, manifestSha256);
  const receipt = await io.readReceipt(manifest); checkReceipt(receipt, expected); return receipt;
}

// 下面仅是受控网络探针，不加载应用、.env、数据库或供应商；IPC为继承的AF_UNIX socketpair。
function probeIdentity() { return { ...proc(process.pid), node: process.version }; }
function unixIpcEvidence(pid) {
  // Node spawn 的第4个stdio固定为继承IPC；从内核unix表实核它，不只把“IPC”文字当证据。
  const link = fs.readlinkSync('/proc/' + pid + '/fd/3'), match = /^socket:\[(\d+)\]$/.exec(link);
  assert.ok(match, 'Controlled probe has no actual IPC socket');
  const row = fs.readFileSync('/proc/net/unix', 'utf8').split('\n')
    .map(line => line.trim().split(/\s+/)).find(fields => fields[6] === match[1]);
  assert.ok(row && row[4] === '0001', 'IPC fd is not an actual AF_UNIX stream socket');
  return { pid, fd: 3, inode: match[1], type: 'AF_UNIX/SOCK_STREAM', kernelObserved: true };
}
function rawPost(target, label, existing, deadline) {
  return new Promise(resolve => {
    const socket = existing || net.createConnection({ host: target.host, port: target.port, family: target.family });
    let done = false, response = '';
    const finish = value => { if (done) return; done = true; clearTimeout(timer);
      socket.removeListener('data', data); socket.removeListener('close', closed); socket.removeListener('error', error);
      if (!value.ok) socket.destroy(); resolve({ family: target.family, ...value, socket }); };
    const data = chunk => { response += chunk.toString(); if (response.includes('\r\n\r\n')) finish({ ok: /^HTTP\/1\.1 200/.test(response), outcome: 'http' }); };
    const closed = () => finish({ ok: false, outcome: 'closed' });
    const error = value => finish({ ok: false, outcome: 'error', code: value.code || 'unknown' });
    const timer = setTimeout(() => finish({ ok: false, outcome: 'timeout' }), Math.max(1, Math.min(SOCKET_MS, deadline - Date.now())));
    socket.on('data', data); socket.once('close', closed); socket.once('error', error); socket.on('error', () => {});
    const send = () => socket.write(`POST /${label} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n`);
    if (existing) send(); else socket.once('connect', send);
  });
}
const cleanNetworkResult = ({ socket, ...value }) => value;
function ipcChannel(child, deadline) {
  const messages = [], waiters = new Set(); let exited = false;
  const notify = () => { for (const fn of [...waiters]) fn(); };
  child.on('message', message => { messages.push(message); notify(); });
  child.once('exit', () => { exited = true; notify(); }); child.on('error', () => { exited = true; notify(); });
  return {
    send: value => { assert.ok(child.connected && !exited); child.send(value); },
    wait: predicate => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error('probe_deadline')); }, Math.max(1, deadline - Date.now()));
      const check = () => { const value = messages.find(predicate);
        if (value) { clearTimeout(timer); waiters.delete(check); resolve(value); }
        else if (exited) { clearTimeout(timer); waiters.delete(check); reject(new Error('controlled_probe_exited')); } };
      waiters.add(check); check();
    }),
  };
}
async function internalProbeChild() {
  assert.equal(process.platform, 'linux'); assert.ok(process.send && process.getuid() > 0);
  const oldSockets = new Map(); let config, grandchild, grandchildChannel;
  const watchdog = setTimeout(() => { grandchild?.kill('SIGKILL'); process.exit(2); }, MAX_INSTALL_MS + 2000);
  process.on('disconnect', () => { grandchild?.kill('SIGKILL'); process.exit(0); });
  process.on('message', async message => {
    try {
      if (message.action === 'init') {
        config = message;
        for (const target of config.targets) assert.ok(['127.0.0.1', '::1'].includes(target.host) && target.port > 0 && target.port <= 65535);
        process.send({ kind: 'ready', identity: probeIdentity() }); return;
      }
      assert.ok(config && message.nonce === config.nonce);
      if (message.action === 'spawn-child') {
        grandchild = spawn(process.execPath, [SELF, '--internal-fence-probe'], { env: ENV, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        grandchildChannel = ipcChannel(grandchild, config.deadline);
        grandchildChannel.send({ ...config, action: 'init', grandchild: true });
        const ready = await grandchildChannel.wait(value => value.kind === 'ready');
        process.send({ kind: 'child-ready', identity: ready.identity }); return;
      }
      if (message.action === 'stop') { clearTimeout(watchdog); grandchild?.kill('SIGKILL'); process.exit(0); }
      if (message.action === 'attempt') {
        const inherited = grandchildChannel ? (async () => {
          grandchildChannel.send({ ...message, includeOld: false });
          return (await grandchildChannel.wait(value => value.kind === 'result' && value.phase === message.phase)).results
            .map(value => ({ ...value, channel: 'child' }));
        })() : Promise.resolve([]);
        const attempts = config.targets.flatMap(target => {
          const values = [(async () => { const result = await rawPost(target, message.label + '-new', undefined, config.deadline);
            if (message.keepOld) oldSockets.set(target.family, result.socket); else result.socket.destroy();
            return { ...cleanNetworkResult(result), channel: 'new' }; })()];
          if (message.includeOld) values.push((async () => {
            const socket = oldSockets.get(target.family);
            assert.ok(socket && !socket.destroyed, 'No actual pre-fence socket');
            return { ...cleanNetworkResult(await rawPost(target, message.label + '-old', socket, config.deadline)), channel: 'old' };
          })());
          return values;
        });
        process.send({ kind: 'result', phase: message.phase, results: [...await Promise.all(attempts), ...await inherited] });
      }
    } catch (error) { process.send?.({ kind: 'failure', message: String(error.message).slice(0, 300) }); }
  });
}

async function openNativeProbe(m, expected, deadline, publicProgram) {
  assert.equal(process.getuid(), 0); regular(SELF, 1024 * 1024);
  const controllerGroup = proc(process.pid).cgroup;
  assert.ok(controllerGroup !== expected.cgroup && !controllerGroup.startsWith(expected.cgroup + '/'));
  const nonce = randomUUID(), hits = [], servers = [];
  const deadlineRemaining = () => { const value = deadline - Date.now(); assert.ok(value > 0, 'Probe deadline'); return value; };
  const closeServers = () => { for (const server of servers) { server.closeAllConnections(); server.close(); } };
  let child, channel, identity, inheritedIdentity;
  const requireFrozenGroup = () => {
    const writer = proc(expected.pid), group = fs.statSync('/sys/fs/cgroup' + expected.cgroup);
    equal(writer.processStartTicks, expected.processStartTicks); equal(writer.cgroup, expected.cgroup);
    equal(group.dev, expected.cgroupDev); equal(group.ino, expected.cgroupIno);
  };
  const killOwnProbe = () => {
    // 只杀本模块所生且start/uid仍匹配的探针（允许父退出后reparent），绝不扫杀业务进程。
    for (const recorded of [inheritedIdentity, identity]) {
      if (!recorded) continue;
      try { const current = proc(recorded.pid, true);
        if (current.processStartTicks === recorded.processStartTicks && current.uid === recorded.uid
          && !['Z', 'X', 'x'].includes(current.state)) process.kill(recorded.pid, 'SIGKILL');
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
    if (!identity) child?.kill('SIGKILL');
  };
  try {
    const targets = [];
    for (const family of [4, 6]) {
      const server = http.createServer((req, res) => {
        hits.push({ family, path: req.url, at: Date.now() }); res.writeHead(200, { 'Content-Length': '0' }); res.end();
      });
      servers.push(server);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('sentinel_listen_deadline')), deadlineRemaining());
        server.once('error', reject); server.listen({ host: family === 4 ? '127.0.0.1' : '::1', port: 0, ipv6Only: family === 6 }, () => { clearTimeout(timer); resolve(); });
      });
      targets.push({ family, host: family === 4 ? '127.0.0.1' : '::1', port: server.address().port });
    }
    const uid = Number(execFileSync('id', ['-u', 'gouki'], { encoding: 'utf8', env: ENV, timeout: Math.min(500, deadlineRemaining()) }));
    const gid = Number(execFileSync('id', ['-g', 'gouki'], { encoding: 'utf8', env: ENV, timeout: Math.min(500, deadlineRemaining()) }));
    child = spawn(process.execPath, [publicProgram, '--internal-fence-probe'], { uid, gid, env: ENV,
      cwd: path.dirname(publicProgram), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    channel = ipcChannel(child, deadline); channel.send({ action: 'init', targets, nonce, deadline });
    const ready = await channel.wait(value => value.kind === 'ready'); identity = proc(child.pid);
    // 进程身份以父root从/proc实读为准，不能相信探针自报。
    for (const key of ['pid', 'uid', 'parentPid', 'processStartTicks', 'cgroup']) equal(identity[key], ready.identity[key]);
    equal(identity.pid, child.pid); equal(identity.uid, uid); equal(identity.parentPid, process.pid);
    equal(identity.processStartTicks, ready.identity.processStartTicks);
    assert.notEqual(identity.cgroup, expected.cgroup, 'Probe must be born outside the writer cgroup');
    requireFrozenGroup();
    fs.writeFileSync('/sys/fs/cgroup' + expected.cgroup + '/cgroup.procs', String(child.pid));
    identity = proc(child.pid); equal(identity.cgroup, expected.cgroup);
    channel.send({ action: 'spawn-child', nonce });
    const descendant = await channel.wait(value => value.kind === 'child-ready'); inheritedIdentity = proc(descendant.identity.pid);
    equal(inheritedIdentity.uid, uid); equal(inheritedIdentity.parentPid, child.pid); equal(inheritedIdentity.cgroup, expected.cgroup);
    equal(inheritedIdentity.processStartTicks, descendant.identity.processStartTicks);
    const unixControlEvidence = [unixIpcEvidence(child.pid), unixIpcEvidence(inheritedIdentity.pid)];
    let hasBaseline = false;
    const attempt = async denied => {
      requireFrozenGroup();
      for (const recorded of [identity, inheritedIdentity]) {
        const current = proc(recorded.pid); equal(current.processStartTicks, recorded.processStartTicks);
        equal(current.uid, uid); equal(current.cgroup, expected.cgroup);
      }
      const phase = randomUUID(), label = nonce + '-' + phase;
      channel.send({ action: 'attempt', nonce, phase, label, keepOld: !denied, includeOld: denied && hasBaseline });
      const value = await channel.wait(message => message.kind === 'result' && message.phase === phase || message.kind === 'failure');
      assert.notEqual(value.kind, 'failure', value.message);
      const results = value.results;
      const mode = denied && !hasBaseline ? 'fresh-only' : 'old-and-fresh';
      hasBaseline ||= !denied;
      return { schema: 'trace03-exact-writer-cgroup-probe.v1', ...expected, observedAt: Date.now(),
        mode, sentinelOutsideTargetCgroup: true, unixControl: true, probeIdentityConfirmed: true,
        inheritedChildIdentityConfirmed: true, probeUid: uid, expectedAppUid: uid,
        unixControlEvidence,
        probePid: child.pid, probeProcessStartTicks: identity.processStartTicks, childPid: inheritedIdentity.pid,
        childProcessStartTicks: inheritedIdentity.processStartTicks,
        probeCgroup: identity.cgroup, childCgroup: inheritedIdentity.cgroup,
        productionHttpRequests: 0, supplierRequests: 0, results,
        sentinelHits: hits.filter(item => item.path.startsWith('/' + label)) };
    };
    return { baseline: () => attempt(false), rejection: () => attempt(true),
      close: async () => { try { if (child?.connected) channel.send({ action: 'stop', nonce }); } catch {}
        try { killOwnProbe(); } finally { closeServers(); } } };
  } catch (error) { try { killOwnProbe(); } finally { closeServers(); } throw error; }
}

export function runWriterNetworkFenceOfflineFixtures() {
  // 纯state门，不接systemctl/文件系统/网络；由统一工程门调用，不能冒原生栅栏证据。
  const now = 100000, manifestSha256 = 'a'.repeat(64), source = 'b'.repeat(40);
  const manifest = { schema: 'rate-impl2-release.v1', projectRoot: PROJECT, appUser: 'gouki',
    mainSource: source, guardSource: 'e'.repeat(40),
    main: { source, root: PROJECT + '/managed-releases/' + source,
      cwdBytes: '[Service]\nWorkingDirectory=' + PROJECT + '/managed-releases/' + source + '\n' },
    guard: { source: 'e'.repeat(40), root: PROJECT + '/managed-releases/' + 'e'.repeat(40),
      cwdBytes: '[Service]\nWorkingDirectory=' + PROJECT + '/managed-releases/' + 'e'.repeat(40) + '\n' },
    runId: '11111111-1111-1111-1111-111111111111', stage: PROJECT + '/release-staging/11111111-1111-1111-1111-111111111111',
    healthUrl: 'http://127.0.0.1:3302/api/release', live: { web: { unit: UNIT, pid: 123, invocation: 'c'.repeat(32),
      root: PROJECT + '/managed-releases/' + source, source, processStartTicks: '12345', cgroup: '/system.slice/' + UNIT, cgroupDev: 29, cgroupIno: 123 } } };
  const expected = assertWriterFenceManifest(manifest, manifestSha256);
  const target = { unit: UNIT, pid: 123, invocation: 'c'.repeat(32), root: expected.root, source,
    processStartTicks: '12345', cgroup: expected.cgroup, cgroupDev: 29, cgroupIno: 123, user: 'gouki', activeState: 'active',
    subState: 'running', mainProcCgroup: expected.cgroup, ownControllerInTargetCgroup: false, established3302: 0, delegated: false };
  Object.assign(target, { processUid: 1004, expectedAppUid: 1004, port3302BoundToCgroup: true, processRoot: expected.root });
  const authority = { schema: 'trace03-writer-fence-authority.v1', ...expected, productionFenceApproved: true,
    approvalSha256: 'd'.repeat(64), helperSha256: '9'.repeat(64), operation: 'restore', issuedAt: now - 100, expiresAt: now + 1000,
    restorePhaseApproved: true, approvedRestorePhase: 'pre-stop-installation-abort' };
  const oldWriterProof = { ...expected, observedAt: now, stopRequested: false, currentTarget: target,
    originalIdentityStillActive: true, pairChanged: false };
  const guardsProof = { ...expected, observedAt: now, ingress503: true, ingressAdmissionClosed: true, noForceStop: true,
    imageStopped: true, imagePromiseSettled: true };
  const input = { expected, authority, receipt: { binding: expected, phase: 'failed-keep-fence' }, oldWriterProof, guardsProof, now };
  const results = [];
  const check = (name, operation, rejects = false) => { if (rejects) assert.throws(operation); else operation(); results.push(name); };
  check('exact live identity', () => assertWriterFenceTarget(target, expected));
  check('active serving connections allowed only for identity observation', () => assertActiveWriterIdentity({ ...target, established3302: 20 }, expected));
  check('undrained connections still reject fence target', () => assertWriterFenceTarget({ ...target, established3302: 20 }, expected), true);
  check('unknown active connection count rejected', () => assertActiveWriterIdentity({ ...target, established3302: NaN }, expected), true);
  check('active identity still rejects PID drift', () => assertActiveWriterIdentity({ ...target, pid: 124, established3302: 20 }, expected), true);
  check('PID drift rejected', () => assertWriterFenceTarget({ ...target, pid: 124 }, expected), true);
  check('cgroup inode drift rejected', () => assertWriterFenceTarget({ ...target, cgroupIno: 124 }, expected), true);
  check('pre-stop explicit restore allowed', () => assertWriterFenceRestoreGate(input));
  check('default restore denied', () => assertWriterFenceRestoreGate({ ...input, authority: { ...authority, restorePhaseApproved: false } }), true);
  check('stop requested cannot use pre-stop restore', () => assertWriterFenceRestoreGate({ ...input, oldWriterProof: { ...oldWriterProof, stopRequested: true } }), true);
  check('expired approval rejected', () => assertWriterFenceRestoreGate({ ...input, now: now + 1001 }), true);
  check('unknown phase rejected', () => assertWriterFenceRestoreGate({ ...input, authority: { ...authority, approvedRestorePhase: 'unknown' } }), true);
  const stopped = { ...oldWriterProof, stopRequested: true, originalProcessGone: true, oldCgroupGoneOrEmpty: true,
    oldCgroupPids: [], currentUnitInactive: true, currentMainPid: 0, noNewWriterStarted: true, allOldWritersStopped: true };
  const postGuards = { ...guardsProof, closedMode: 'all-old-writers-stopped-ingress-503',
    allOldWritersStopped: true, hdStopped: true };
  const newPairProof = { ...expected, observedAt: now, mainSource: source, guardSource: 'e'.repeat(40),
    pairInstalled: true, execStartPreVerified: true, restartNoForceProtection: true, actualNewServiceHealthClaimed: false };
  const post = { ...input, authority: { ...authority, approvedRestorePhase: 'before-new-writer-after-proven-old-stop' },
    oldWriterProof: stopped, guardsProof: postGuards, newPairProof };
  check('old gone plus guarded new pair allows prestart restore', () => assertWriterFenceRestoreGate(post));
  check('all-old-writers-stopped ingress503 mode allows prestart restore', () => assertWriterFenceRestoreGate(post));
  check('guard cannot pretend release hold', () => assertWriterFenceRestoreGate({ ...post,
    guardsProof: { ...postGuards, closedMode: 'guard-accepted-only', releaseHold: 1, acceptedOnly: 1 } }), true);
  check('old cgroup nonempty rejected', () => assertWriterFenceRestoreGate({ ...post, oldWriterProof: { ...stopped, oldCgroupPids: [999] } }), true);
  check('new writer already started rejected', () => assertWriterFenceRestoreGate({ ...post, oldWriterProof: { ...stopped, noNewWriterStarted: false } }), true);
  check('build evidence cannot claim actual health', () => assertWriterFenceRestoreGate({ ...post, newPairProof: { ...newPairProof, actualNewServiceHealthClaimed: true } }), true);
  check('new pair source must match approved manifest', () => assertWriterFenceRestoreGate({ ...post,
    newPairProof: { ...newPairProof, mainSource: 'f'.repeat(40) } }), true);
  check('main hold cannot be guard accepted-only', () => assertWriterFenceRestoreGate({ ...post,
    guardsProof: { ...postGuards, acceptedOnly: 1 } }), true);
  const preconditions = { ...expected, observedAt: now, ingressAdmissionClosed: true, ingress503: true, imageStopped: true, imagePromiseSettled: true,
    connections3302: 0, stopRequested: false,
    shortLock: { held: true, kind: 'BEGIN IMMEDIATE', syncCount: 0, watchdogMs: 20000, deadlineAt: now + 20000 } };
  check('empty short lock with bounded watchdog accepted', () => assertWriterFencePreconditions(preconditions, expected, now));
  check('lock with sync effects rejected', () => assertWriterFencePreconditions({ ...preconditions,
    shortLock: { ...preconditions.shortLock, syncCount: 1 } }, expected, now), true);
  check('unbounded lock watchdog rejected', () => assertWriterFencePreconditions({ ...preconditions,
    shortLock: { ...preconditions.shortLock, watchdogMs: 30000 } }, expected, now), true);
  check('insufficient lock budget rejected', () => assertWriterFencePreconditions({ ...preconditions,
    shortLock: { ...preconditions.shortLock, deadlineAt: now + 7999 } }, expected, now), true);
  const fileEntry = text => { const bytes = Buffer.from(text); return { uid: 0, gid: 0, mode: 0o644, nlink: 1,
    sha256: digest(bytes), bytesBase64: bytes.toString('base64') }; };
  const allowPath = '/run/systemd/system.control/' + UNIT + '.d/50-IPAddressAllow.conf';
  const denyPath = '/run/systemd/system.control/' + UNIT + '.d/50-IPAddressDeny.conf';
  const holdPath = '/etc/systemd/system/' + UNIT + '.d/default01-web.conf';
  const originalPolicy = { unit: { name: UNIT, allow: '127.0.0.0/8 ::1/128', deny: '', ingressFilters: '', egressFilters: '' },
    parents: ['system.slice', '-.slice'].map(name => ({ name, allow: '', deny: '', ingressFilters: '', egressFilters: '' })),
    runtimeFiles: { [allowPath]: fileEntry('[Service]\nIPAddressAllow=localhost\n') },
    loadedDropins: { [holdPath]: fileEntry('[Service]\nWorkingDirectory=' + expected.root + '\n'),
      [allowPath]: fileEntry('[Service]\nIPAddressAllow=localhost\n') } };
  const installedFiles = { [allowPath]: fileEntry('[Service]\nIPAddressAllow=\n'),
    [denyPath]: fileEntry('[Service]\nIPAddressDeny=any\n') };
  const installedPolicy = { ...originalPolicy, unit: { ...originalPolicy.unit, allow: '', deny: '0.0.0.0/0 ::/0' },
    runtimeFiles: installedFiles, loadedDropins: { [holdPath]: originalPolicy.loadedDropins[holdPath], ...installedFiles } };
  check('normal persistent unit system.control exact dropins accepted', () => assertWriterFencePolicy({ current: installedPolicy, original: originalPolicy }));
  check('Allow localhost overrides deny and is rejected', () => assertWriterFencePolicy({ original: originalPolicy,
    current: { ...installedPolicy, unit: { ...installedPolicy.unit, allow: '127.0.0.0/8 ::1/128' } } }), true);
  check('IPv6 not denied rejected', () => assertWriterFencePolicy({ original: originalPolicy,
    current: { ...installedPolicy, unit: { ...installedPolicy.unit, deny: '0.0.0.0/0' } } }), true);
  check('parent Allow rejected without modifying parent', () => assertWriterFencePolicy({ current: installedPolicy,
    original: { ...originalPolicy, parents: originalPolicy.parents.map(value => ({ ...value, allow: '127.0.0.0/8' })) } }), true);
  check('runtime dropin nonroot owner rejected', () => assertWriterFencePolicy({ original: originalPolicy,
    current: { ...installedPolicy, runtimeFiles: { ...installedFiles, [denyPath]: { ...installedFiles[denyPath], uid: 1004 } } } }), true);
  check('runtime dropin writable mode rejected', () => assertWriterFencePolicy({ original: originalPolicy,
    current: { ...installedPolicy, runtimeFiles: { ...installedFiles, [denyPath]: { ...installedFiles[denyPath], mode: 0o666 } } } }), true);
  check('actual loaded DropInPaths cannot name another unit', () => assertWriterFencePolicy({ original: originalPolicy,
    current: { ...installedPolicy, loadedDropins: { ...installedPolicy.loadedDropins,
      ['/run/systemd/system.control/other.service.d/50-IPAddressDeny.conf']: installedFiles[denyPath] } } }), true);
  check('unowned loaded dropin change rejected', () => assertWriterFencePolicy({ original: originalPolicy,
    current: { ...installedPolicy, loadedDropins: { ...installedPolicy.loadedDropins, [holdPath]: fileEntry('[Service]\nWorkingDirectory=' + PROJECT + '/managed-releases/' + 'f'.repeat(40) + '\n') } } }), true);
  check('loaded network dropin must match runtime bytes CAS', () => assertWriterFencePolicy({ original: originalPolicy,
    current: { ...installedPolicy, loadedDropins: { ...installedPolicy.loadedDropins,
      [denyPath]: fileEntry('[Service]\nIPAddressDeny=localhost\n') } } }), true);
  check('arbitrary runtime file never becomes a managed target', () => assertWriterFencePolicy({ original: originalPolicy,
    current: { ...installedPolicy, runtimeFiles: { ...installedFiles,
      ['/run/systemd/system.control/' + UNIT + '.d/51-unowned.conf']: installedFiles[denyPath] } } }), true);
  const publicProgram = { schema: 'trace03-public-fence-probe.v1', ...expected,
    path: PROJECT + '/entry-maintenance/' + expected.runId + '/writer-network-fence-probe.mjs',
    sha256: authority.helperSha256, sourceSha256: authority.helperSha256, uid: 0, nlink: 1, mode: 0o444,
    runDirectoryUid: 0, runDirectoryMode: 0o755, entryDirectoryUid: 0, entryDirectoryMode: 0o755,
    privateStageUid: 0, privateStageMode: 0o700, sameByteProbeOnly: true, stagePermissionChanged: false };
  check('private root0700 stage plus separate same-byte public probe accepted', () => assertWriterFenceProbeProgram(publicProgram, expected, authority.helperSha256));
  check('private stage is never child program path', () => assertWriterFenceProbeProgram({ ...publicProgram,
    path: manifest.stage + '/writer-network-fence.mjs' }, expected, authority.helperSha256), true);
  check('public probe tampering rejected', () => assertWriterFenceProbeProgram({ ...publicProgram,
    sha256: '8'.repeat(64) }, expected, authority.helperSha256), true);
  check('stage permission widening rejected', () => assertWriterFenceProbeProgram({ ...publicProgram,
    privateStageMode: 0o755 }, expected, authority.helperSha256), true);
  check('public writable program rejected', () => assertWriterFenceProbeProgram({ ...publicProgram,
    mode: 0o644 }, expected, authority.helperSha256), true);
  check('missing BPF cannot be proved by systemd properties', () => assertWriterFenceBpfAttachment([]), true);
  check('egress-only BPF is insufficient', () => assertWriterFenceBpfAttachment([{ id: 1, attach_type: 'cgroup_inet_egress' }]), true);
  check('both actual BPF attachment directions accepted', () => assertWriterFenceBpfAttachment([
    { id: 1, attach_type: 'cgroup_inet_egress' }, { id: 2, attach_type: 'cgroup_inet_ingress' }]));
  const rejection = { schema: 'trace03-exact-writer-cgroup-probe.v1', ...expected, mode: 'old-and-fresh',
    sentinelOutsideTargetCgroup: true, unixControl: true, probeIdentityConfirmed: true, inheritedChildIdentityConfirmed: true,
    probeUid: 1004, expectedAppUid: 1004, probeCgroup: expected.cgroup, childCgroup: expected.cgroup, probePid: 234, childPid: 235,
    unixControlEvidence: [234, 235].map(pid => ({ pid, fd: 3, inode: String(pid), type: 'AF_UNIX/SOCK_STREAM', kernelObserved: true })),
    productionHttpRequests: 0, supplierRequests: 0, sentinelHits: [],
    results: ['old', 'new', 'child'].flatMap(channel => [4, 6].map(family => ({ channel, family, ok: false, outcome: 'timeout' }))) };
  check('IPv4 IPv6 old new inherited-child denial accepted', () => assertWriterFenceProbeVerdict(rejection, expected, true));
  check('one sentinel hit prevents verified fence', () => assertWriterFenceProbeVerdict({ ...rejection,
    sentinelHits: [{ family: 6 }] }, expected, true), true);
  check('missing inherited child family rejected', () => assertWriterFenceProbeVerdict({ ...rejection,
    results: rejection.results.slice(0, 5) }, expected, true), true);
  check('missing actual Unix control evidence rejected', () => assertWriterFenceProbeVerdict({ ...rejection,
    unixControlEvidence: [] }, expected, true), true);
  check('current release manifest is accepted', () => assertWriterFenceManifest(manifest, manifestSha256));
  check('old manifest schema cannot silently fall back', () => assertWriterFenceManifest({ ...manifest, schema: 'trace03-rate-release-manifest.v1' }, manifestSha256), true);
  check('derived PID-start field is locked by fresh artifact binding', () => assertWriterFencePreconditions({ ...preconditions,
    processStartTicks: '999' }, expected, now), true);
  check('entire derived fence view is locked by fresh artifact binding', () => assertWriterFencePreconditions({ ...preconditions,
    fenceViewSha256: '0'.repeat(64) }, expected, now), true);
  check('R03 operation stage cannot drift', () => assertWriterFencePreconditions({ ...preconditions,
    operationStage: manifest.stage + '/rate-compat-private' }, expected, now), true);
  check('image complete Promise must settle before install', () => assertWriterFencePreconditions({ ...preconditions,
    imagePromiseSettled: false }, expected, now), true);
  check('ingress admission must really be closed', () => assertWriterFencePreconditions({ ...preconditions,
    ingressAdmissionClosed: false }, expected, now), true);
  check('verified install is not a pre-stop failed-install abort', () => assertWriterFenceRestoreGate({ ...input,
    receipt: { ...input.receipt, phase: 'verified' } }), true);
  check('all old HD writers must stop before restore', () => assertWriterFenceRestoreGate({ ...post,
    guardsProof: { ...postGuards, hdStopped: false } }), true);
  check('all old image Promises must settle before restore', () => assertWriterFenceRestoreGate({ ...post,
    guardsProof: { ...postGuards, imagePromiseSettled: false } }), true);
  check('all old writer proof must cover all roles', () => assertWriterFenceRestoreGate({ ...post,
    oldWriterProof: { ...stopped, allOldWritersStopped: false } }), true);
  check('main HOLD is unsupported and rejected', () => assertWriterFenceRestoreGate({ ...post,
    guardsProof: { ...postGuards, closedMode: 'main-hold', releaseHold: 1 } }), true);
  return { schema: 'trace03-writer-fence-offline-fixtures.v1', nativeExecuted: false, assertions: results };
}

export async function runWriterNetworkRestoreTransitionFixtures() {
  // 明确的内存IO：跑下方真实install/restore函数的控制流，不运行systemd、探针、FS或网络。
  // 此结果仅证明状态过渡，不是新原生BPF/业务安全证据，native receipt reader会拒绝它。
  const copy = value => structuredClone(value), now = 100000;
  const entry = text => { const bytes = Buffer.from(text); return { uid: 0, gid: 0, mode: 0o644, nlink: 1,
    sha256: digest(bytes), bytesBase64: bytes.toString('base64') }; };
  const oldSource = 'b'.repeat(40), mainSource = 'd'.repeat(40), guardSource = 'e'.repeat(40);
  const runtimePath = '/etc/systemd/system/' + UNIT + '.d/default01-web.conf';
  const protectionPath = '/run/systemd/system/' + UNIT + '.d/trace03-fixture-no-force.conf';
  const allowPath = '/run/systemd/system.control/' + UNIT + '.d/50-IPAddressAllow.conf';
  const denyPath = '/run/systemd/system.control/' + UNIT + '.d/50-IPAddressDeny.conf';
  const manifest = { schema: 'rate-impl2-release.v1', projectRoot: PROJECT, appUser: 'gouki',
    mainSource, guardSource, main: { source: mainSource, root: PROJECT + '/managed-releases/' + mainSource,
      cwdBytes: '[Service]\nWorkingDirectory=' + PROJECT + '/managed-releases/' + mainSource + '\nEnvironment=HD_DERIVATIVES_ROOT=' + PROJECT + '/var-lib/storage/hd-derivatives\n' },
    guard: { source: guardSource, root: PROJECT + '/managed-releases/' + guardSource,
      cwdBytes: '[Service]\nWorkingDirectory=' + PROJECT + '/managed-releases/' + guardSource + '\nEnvironment=HD_DERIVATIVES_ROOT=' + PROJECT + '/var-lib/storage/hd-derivatives\n' },
    runId: '11111111-1111-1111-1111-111111111111', stage: PROJECT + '/release-staging/11111111-1111-1111-1111-111111111111',
    healthUrl: 'http://127.0.0.1:3302/api/release', live: { web: { unit: UNIT, pid: 123, invocation: 'c'.repeat(32),
      root: PROJECT + '/managed-releases/' + oldSource, source: oldSource, dropin: runtimePath,
      processStartTicks: '12345', cgroup: '/system.slice/' + UNIT, cgroupDev: 29, cgroupIno: 123 } } };
  const manifestSha256 = digest(JSON.stringify(manifest)), expected = assertWriterFenceManifest(manifest, manifestSha256);
  const originalPolicy = { unit: { name: UNIT, allow: '127.0.0.0/8 ::1/128', deny: '192.0.2.0/24', ingressFilters: '', egressFilters: '' },
    parents: ['system.slice', '-.slice'].map(name => ({ name, allow: '', deny: '', ingressFilters: '', egressFilters: '' })),
    runtimeFiles: { [allowPath]: entry('[Service]\nIPAddressAllow=localhost\n'),
      [denyPath]: entry('[Service]\nIPAddressDeny=192.0.2.0/24\n') },
    loadedDropins: { [runtimePath]: entry('[Service]\nWorkingDirectory=' + manifest.live.web.root + '\nEnvironment=HD_DERIVATIVES_ROOT=' + PROJECT + '/var-lib/storage/hd-derivatives\n'),
      [protectionPath]: entry('[Service]\nRestart=no\nSendSIGKILL=no\nTimeoutStopSec=infinity\n') } };
  Object.assign(originalPolicy.loadedDropins, copy(originalPolicy.runtimeFiles));
  const target = { unit: UNIT, pid: 123, invocation: manifest.live.web.invocation, root: manifest.live.web.root,
    processRoot: manifest.live.web.root, source: oldSource, processStartTicks: '12345', cgroup: expected.cgroup,
    cgroupDev: 29, cgroupIno: 123, user: 'gouki', processUid: 1004, expectedAppUid: 1004,
    activeState: 'active', subState: 'running', mainProcCgroup: expected.cgroup, ownControllerInTargetCgroup: false,
    established3302: 0, port3302BoundToCgroup: true, delegated: false };
  const gone = { originalProcessGone: true, oldCgroupGoneOrEmpty: true, oldCgroupPids: [],
    currentUnitInactive: true, currentMainPid: 0, noNewWriterStarted: true };
  const live = { originalProcessGone: false, oldCgroupGoneOrEmpty: false, oldCgroupPids: [123],
    currentUnitInactive: false, currentMainPid: 123, noNewWriterStarted: true };
  const program = { schema: 'trace03-public-fence-probe.v1', ...expected,
    path: PROJECT + '/entry-maintenance/' + expected.runId + '/writer-network-fence-probe.mjs',
    sha256: '9'.repeat(64), sourceSha256: '9'.repeat(64), uid: 0, nlink: 1, mode: 0o444,
    runDirectoryUid: 0, runDirectoryMode: 0o755, entryDirectoryUid: 0, entryDirectoryMode: 0o755,
    privateStageUid: 0, privateStageMode: 0o700, sameByteProbeOnly: true, stagePermissionChanged: false };
  const createMemory = () => {
    const state = { policy: copy(originalPolicy), oldState: copy(live), receipt: null, lease: null, leaseSequence: 0,
      artifacts: new Map(), log: [], effects: { networkWrites: 0, networkRestores: 0, starts: 0, pairWrites: 0 } };
    const seal = (name, body) => { const file = operationStage(manifest) + '/fixture-' + name + '.json', bytes = JSON.stringify(body) + '\n';
      state.artifacts.set(file, { uid: 0, mode: 0o600, bytes });
      return { ...copy(body), artifact: { path: file, sha256: digest(bytes) } }; };
    const io = { kind: 'explicit-memory', now: () => now, commandEvidence: () => copy(state.log),
      acquire: (_m, _binding, operation) => { assert.equal(state.lease, null); const lease = { operation, sequence: ++state.leaseSequence };
        state.lease = lease; return lease; },
      release: lease => { equal(state.lease, lease); state.lease = null; },
      verifyArtifact: proof => { assert.ok(inside(proof.artifact?.path, operationStage(manifest)));
        const value = state.artifacts.get(proof.artifact?.path);
        assert.ok(value); equal(value.uid, 0); equal(value.mode, 0o600); equal(digest(value.bytes), proof.artifact.sha256);
        const { artifact: _artifact, ...body } = proof; equal(JSON.parse(value.bytes), body); },
      inspect: () => { equal(state.oldState.originalProcessGone, false); return copy(target); },
      oldState: () => copy(state.oldState), policy: () => copy(state.policy),
      persist: (_m, body, priorSha) => {
        equal(state.receipt ? digest(state.receipt) : null, priorSha, 'Memory durable receipt CAS conflict');
        state.receipt = JSON.stringify(body) + '\n'; return digest(state.receipt);
      },
      readReceipt: () => ({ ...JSON.parse(state.receipt), receiptSha256: digest(state.receipt) }),
      setNetwork: (_m, allow, deny, expectedFiles) => {
        equal(state.policy.runtimeFiles, expectedFiles, 'Memory runtime-file CAS conflict');
        state.effects.networkWrites++;
        if (allow === originalPolicy.unit.allow && deny === originalPolicy.unit.deny) state.effects.networkRestores++;
        state.policy.unit.allow = allow; state.policy.unit.deny = deny === 'any' ? '0.0.0.0/0 ::/0' : deny;
        const changed = { [allowPath]: entry('[Service]\nIPAddressAllow=' + allow + '\n'),
          [denyPath]: entry('[Service]\nIPAddressDeny=' + deny + '\n') };
        state.policy.runtimeFiles = changed; Object.assign(state.policy.loadedDropins, copy(changed));
        state.log.push({ io: 'explicit-memory', operation: 'setNetwork', allow, deny });
      },
      restoreFiles: (original, current) => {
        equal(state.policy.runtimeFiles, current);
        for (const file of Object.keys(state.policy.runtimeFiles)) delete state.policy.loadedDropins[file];
        state.policy.runtimeFiles = copy(original); Object.assign(state.policy.loadedDropins, copy(original));
      },
      bpf: () => assertWriterFenceBpfAttachment([{ id: 1, attach_type: 'cgroup_inet_ingress' }, { id: 2, attach_type: 'cgroup_inet_egress' }]),
      openProbe: () => {
        let baselineCalled = false;
        const verdict = denied => {
          const fenced = state.policy.unit.allow === '' && state.policy.unit.deny === '0.0.0.0/0 ::/0';
          equal(fenced, denied, 'Explicit memory fence model does not match requested phase');
          const channels = denied && baselineCalled ? ['old', 'new', 'child'] : ['new', 'child'];
          return { schema: 'trace03-exact-writer-cgroup-probe.v1', ...expected, fixtureOnly: true,
            mode: denied && !baselineCalled ? 'fresh-only' : 'old-and-fresh', sentinelOutsideTargetCgroup: true, unixControl: true,
            probeIdentityConfirmed: true, inheritedChildIdentityConfirmed: true, probeUid: 1004, expectedAppUid: 1004,
            probeCgroup: expected.cgroup, childCgroup: expected.cgroup, probePid: 234, childPid: 235,
            unixControlEvidence: [234, 235].map(pid => ({ pid, fd: 3, inode: String(pid), type: 'AF_UNIX/SOCK_STREAM', kernelObserved: true })),
            productionHttpRequests: 0, supplierRequests: 0,
            results: channels.flatMap(channel => [4, 6].map(family => ({ channel, family, ok: !denied, outcome: denied ? 'timeout' : 'http' }))),
            sentinelHits: denied ? [] : [4, 6, 4, 6].map(family => ({ family })) };
        };
        return { baseline: () => { const value = verdict(false); baselineCalled = true; return value; },
          rejection: () => verdict(true), close: () => state.log.push({ io: 'explicit-memory', operation: 'closeProbe' }) };
      },
      startWriter: () => { state.effects.starts++; assert.fail('Network helper must never start a writer'); },
      writePair: () => { state.effects.pairWrites++; assert.fail('Network helper must never write a source pair'); } };
    return { state, io, seal };
  };
  const definitions = [
    { name: 'main_ingress503_restores_exact_network_and_preserves_only_approved_CWD_snapshot', kind: 'main', succeeds: true },
    { name: 'guard_ingress503_restores_exact_network_and_preserves_only_approved_CWD_snapshot', kind: 'guard', succeeds: true },
    { name: 'prestop_abort_without_transition_restores_complete_original_policy', kind: 'main', succeeds: true, preStop: true, configure: false },
    { name: 'wrong_working_directory_rejected', kind: 'main', mutate: context => {
      context.transition.entry = copy(originalPolicy.loadedDropins[runtimePath]); } },
    { name: 'wrong_closed_mode_body_rejected', kind: 'main', mutate: context => {
      context.transition.entry = entry(manifest.main.cwdBytes + 'Environment=STUDIO_RELEASE_HOLD=1\n'); } },
    { name: 'unsupported_guard_accepted_only_mode_rejected', kind: 'guard', mutate: context => {
      context.guards.closedMode = 'guard-accepted-only'; context.guards.acceptedOnly = 1; } },
    { name: 'unsupported_main_HOLD_mode_rejected', kind: 'main', mutate: context => {
      context.guards.closedMode = 'main-hold'; context.guards.releaseHold = 1; } },
    { name: 'image_complete_Promise_not_settled_rejected', kind: 'main', mutate: context => { context.guards.imagePromiseSettled = false; } },
    { name: 'old_HD_writer_not_stopped_rejected', kind: 'main', mutate: context => { context.guards.hdStopped = false; } },
    { name: 'all_old_writer_coverage_missing_rejected', kind: 'main', mutate: context => { context.guards.allOldWritersStopped = false; } },
    { name: 'ingress_admission_open_rejected', kind: 'main', mutate: context => { context.guards.ingressAdmissionClosed = false; } },
    { name: 'fresh_artifact_derived_view_tamper_rejected', kind: 'main', mutate: context => { context.pair.fenceViewSha256 = '0'.repeat(64); } },
    { name: 'CWD_snapshot_extra_environment_rejected', kind: 'main', mutate: context => {
      context.transition.entry = entry(manifest.main.cwdBytes + 'Environment=UNAPPROVED=1\n'); } },
    { name: 'wrong_runtime_hash_rejected', kind: 'main', mutate: context => { context.transition.entry.sha256 = '0'.repeat(64); } },
    { name: 'wrong_runtime_source_rejected', kind: 'main', mutate: context => { context.transition.source = 'f'.repeat(40); } },
    { name: 'wrong_pair_binding_rejected', kind: 'main', mutate: context => { context.pair.mainSource = 'f'.repeat(40); } },
    { name: 'extra_nonnetwork_dropin_rejected', kind: 'main', mutateState: state => {
      state.policy.loadedDropins['/etc/systemd/system/' + UNIT + '.d/foreign.conf'] = entry('[Service]\nEnvironment=FOREIGN=1\n'); } },
    { name: 'no_restart_no_force_dropin_drift_rejected', kind: 'main', mutateState: state => {
      state.policy.loadedDropins[protectionPath] = entry('[Service]\nRestart=always\nSendSIGKILL=yes\n'); } },
    { name: 'runtime_owner_change_rejected', kind: 'main', mutate: context => { context.transition.entry.uid = 1004; } },
    { name: 'runtime_group_change_rejected', kind: 'main', mutate: context => { context.transition.entry.gid = 1004; } },
    { name: 'runtime_permission_change_rejected', kind: 'main', mutate: context => { context.transition.entry.mode = 0o640; } },
    { name: 'runtime_writable_permission_rejected', kind: 'main', mutate: context => { context.transition.entry.mode = 0o666; } },
    { name: 'actual_runtime_owner_differs_from_durable_proof_rejected', kind: 'main', mutateState: state => {
      state.policy.loadedDropins[runtimePath].uid = 1004; } },
    { name: 'actual_runtime_permissions_differ_from_durable_proof_rejected', kind: 'main', mutateState: state => {
      state.policy.loadedDropins[runtimePath].mode = 0o640; } },
    { name: 'wrong_runtime_path_rejected', kind: 'main', mutate: context => { context.transition.path = '/etc/systemd/system/' + UNIT + '.d/other.conf'; } },
    { name: 'old_process_not_stopped_rejected_by_actual_io_state', kind: 'main', mutateState: state => { state.oldState = copy(live); } },
    { name: 'old_cgroup_not_empty_rejected_by_actual_io_state', kind: 'main', mutateState: state => { state.oldState.oldCgroupPids = [999]; } },
    { name: 'prestop_abort_with_candidate_mode_without_proof_rejected', kind: 'main', preStop: true },
    { name: 'prestop_abort_with_candidate_transition_proof_rejected', kind: 'main', preStop: true, supplyPreStopPair: true },
    { name: 'parent_policy_drift_rejected', kind: 'main', mutateState: state => { state.policy.parents[0].deny = '198.51.100.0/24'; } },
    { name: 'network_runtime_bytes_CAS_drift_rejected', kind: 'main', mutateState: state => {
      state.policy.runtimeFiles[denyPath] = entry('[Service]\nIPAddressDeny=localhost\n');
      state.policy.loadedDropins[denyPath] = copy(state.policy.runtimeFiles[denyPath]); } },
    { name: 'nonaddress_filter_drift_rejected_before_unseal', kind: 'main', mutateState: state => { state.policy.unit.egressFilters = '/run/foreign-bpf'; } },
  ];
  const cases = [];
  for (const definition of definitions) {
    const { state, io, seal } = createMemory();
    const authorityBody = { schema: 'trace03-writer-fence-authority.v1', ...expected, productionFenceApproved: true,
      approvalSha256: 'a'.repeat(64), helperSha256: program.sha256, operation: 'install', issuedAt: now - 1, expiresAt: now + 10000 };
    const authority = seal('install-authority', authorityBody);
    const preconditions = seal('short-lock', { ...expected, observedAt: now, ingressAdmissionClosed: true, ingress503: true,
      imageStopped: true, imagePromiseSettled: true, connections3302: 0, stopRequested: false,
      shortLock: { held: true, kind: 'BEGIN IMMEDIATE', syncCount: 0, watchdogMs: 20000, deadlineAt: now + 20000 } });
    if (definition.preStop) {
      // Explicit in-memory install failure AFTER the deny is installed.
      // Exercise the real failure receipt/cleanup rather than relabel a
      // successful install as an abort. Native probing is never selected.
      const openProbe = io.openProbe;
      io.openProbe = (...args) => {
        const probe = openProbe(...args);
        return { ...probe, rejection: () => { throw new Error('fixture-install-verification-failed'); } };
      };
    }
    let receipt;
    try {
      receipt = await installWriterNetworkFence({ manifest, manifestSha256, authority, preconditions, probeProgram: program, io });
      equal(definition.preStop === true, false, 'Pre-stop fixture must exercise a failed install');
    } catch (error) {
      if (!definition.preStop) throw error;
      equal(error.message, 'writer_network_fence_install_unverified');
      receipt = error.receipt;
    }
    equal(receipt.phase, definition.preStop ? 'failed-keep-fence' : 'verified');
    equal(receipt.evidenceKind, 'offline-fixture'); equal(state.effects.networkWrites, 1);
    const kind = definition.kind, candidate = manifest[kind];
    const transition = { path: runtimePath, kind, source: candidate.source, root: candidate.root,
      entry: entry(writerFenceClosedRuntimeDropin(candidate.root, kind, candidate.cwdBytes)) };
    const guards = { ...expected, observedAt: now, ingress503: true, ingressAdmissionClosed: true,
      noForceStop: true, imageStopped: true, imagePromiseSettled: true,
      ...(definition.preStop ? {} : { allOldWritersStopped: true, hdStopped: true,
        closedMode: 'all-old-writers-stopped-ingress-503' }) };
    const pair = { ...expected, observedAt: now, pairInstalled: true, execStartPreVerified: true,
      restartNoForceProtection: true, actualNewServiceHealthClaimed: false, runtimeDropin: transition };
    const context = { transition, pair, guards }; definition.mutate?.(context);
    if (definition.configure !== false) state.policy.loadedDropins[runtimePath] = copy(context.transition.entry);
    state.oldState = copy(definition.preStop ? live : gone); definition.mutateState?.(state);
    const beforeRestore = copy(state.policy), writesBeforeRestore = state.effects.networkWrites;
    const oldWriter = definition.preStop ? { ...expected, observedAt: now, stopRequested: false,
      currentTarget: copy(target), originalIdentityStillActive: true, pairChanged: false }
      : { ...expected, observedAt: now, stopRequested: true, ...gone, allOldWritersStopped: true };
    const restoreInput = { manifest, receipt, io,
      authority: seal('restore-authority', { ...authorityBody, operation: 'restore', restorePhaseApproved: true,
        approvedRestorePhase: definition.preStop ? 'pre-stop-installation-abort' : 'before-new-writer-after-proven-old-stop' }),
      oldWriterProof: seal('old-writer', oldWriter), guardsProof: seal('guards', context.guards),
      newPairProof: !definition.preStop || definition.supplyPreStopPair ? seal('pair', context.pair) : undefined };
    let finalPhase;
    if (definition.succeeds) {
      const restored = await restoreWriterNetworkFence(restoreInput); equal(restored.phase, 'restored');
      const expectedPolicy = definition.preStop ? copy(originalPolicy) : {
        ...copy(originalPolicy), loadedDropins: { ...copy(originalPolicy.loadedDropins), [runtimePath]: copy(transition.entry) } };
      equal(state.policy, expectedPolicy); equal(restored.expectedRestoredPolicy, expectedPolicy);
      equal(restored.allowedRuntimeDropinTransition, definition.preStop ? null : {
        ...transition, originalEntry: originalPolicy.loadedDropins[runtimePath],
        approvedPhase: 'before-new-writer-after-proven-old-stop', closedMode: context.guards.closedMode });
      equal(state.effects.networkRestores, 1); finalPhase = restored.phase;
    } else {
      await assert.rejects(() => restoreWriterNetworkFence(restoreInput));
      equal(state.effects.networkRestores, 0, 'Rejected transition must not restore outbound access');
      equal(state.effects.networkWrites, writesBeforeRestore, 'Rejected transition must not mutate policy');
      equal(state.policy, beforeRestore, 'Rejected transition must not alter the configured pair or any policy');
      finalPhase = JSON.parse(state.receipt).phase;
    }
    equal(state.effects.starts, 0); equal(state.effects.pairWrites, 0); equal(state.lease, null);
    cases.push({ name: definition.name, kind, outcome: definition.succeeds ? 'restored' : 'rejected',
      finalPhase, networkRestores: state.effects.networkRestores, starts: state.effects.starts, pairWrites: state.effects.pairWrites,
      nativeExecuted: false });
  }
  return { schema: 'trace03-writer-network-restore-transition-fixtures.v1', nativeExecuted: false, ioKind: 'explicit-memory',
    realImplementations: ['installWriterNetworkFence', 'restoreWriterNetworkFence'], assertions: cases.map(value => value.name), cases };
}

if (process.argv[2] === '--internal-fence-probe' && process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await internalProbeChild();
}
