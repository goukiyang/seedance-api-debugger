import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createHdReleaseSafety, parseAllOwnerSynchronousRows, assertConfigurationIdentity, logPaths } from './cutover-safety.mjs';
import { protectedFileSnapshot, originalRuntimeBuild } from './switch.mjs';
import { rootFile } from './common.mjs';
import { fileIdentity } from './legacy-maintenance.mjs';
import { assertWriterFenceManifest, assertWriterFencePreconditions, assertWriterFenceRestoreGate, inspectWriterFenceTarget } from './writer-network-fence.mjs';
import { candidateEvidenceFile, REUSE_SCHEMA } from './candidate-evidence.mjs';
import { captureNginxMaintenance } from './nginx-maintenance.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex'), copy = value => structuredClone(value);
const NETWORK = ['/run/systemd/system.control/sd2-gray.service.d/50-IPAddressAllow.conf',
  '/run/systemd/system.control/sd2-gray.service.d/50-IPAddressDeny.conf'];
const CWD = '/etc/systemd/system/sd2-gray.service.d/default01-web.conf';
const roles = ['web', 'image', 'hd'];
const project = '/data/video-api-debugger';
const record = (status = 'succeeded', ownerId = 'private-fixture-owner') => {
  const value = { schema: 'image.sync-admission.v1', ownerId, requestId: 'fixture-request-0001', fingerprint: 'fixture-fingerprint',
    count: 1, model: 'fixture-model', scope: 'fixture-scope', status, createdAt: new Date(1000).toISOString(),
    finishedAt: status === 'running' ? null : new Date(2000).toISOString() };
  return { key: 'image_sync_request_v1:' + ownerId + ':' + value.requestId, value_json: JSON.stringify(value) };
};
function memory({ reuse = false } = {}) {
  let now = reuse ? 10000000 : 100000;
  const runId = '11111111-1111-1111-1111-111111111111', files = new Map(), log = [];
  const put = (file, value) => files.set(file, Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
  const bytes = file => { assert.ok(files.has(file), 'Missing explicit memory input: ' + file); return Buffer.from(files.get(file)); };
  const json = file => JSON.parse(bytes(file));
  const m = { schema: 'rate-impl2-release.v1', project: 'video-api-debugger', projectRoot: project, appUser: 'gouki', runId,
    stage: project + '/release-staging/' + runId, database: project + '/var-lib/dev.db', mainSource: 'a'.repeat(40), guardSource: 'b'.repeat(40),
    hdRoot: project + '/var-lib/storage/hd-derivatives', live: {}, expectedProtectedFileSha256: {},
    privateSha256: { 'cutover-safety.mjs': sha('fixture-adapter-source'), 'writer-network-fence.mjs': sha('fixture-native-helper-source') } };
  for (const kind of ['main', 'guard']) m[kind] = { source: m[kind + 'Source'], root: project + '/managed-releases/' + m[kind + 'Source'],
    version: kind === 'main' ? '0.99.2' : '0.99.2+points-pricing-guard.1' };
  const originalRoot = project + '/managed-releases/' + 'c'.repeat(40), states = {}, pids = new Set();
  roles.forEach((role, index) => {
    const unit = role === 'web' ? 'sd2-gray.service' : role === 'image' ? 'sd2-image-studio.service' : 'sd2-hd-derivatives.service';
    const pid = 101 + index, invocation = String(index + 1).repeat(32);
    m.live[role] = { unit, root: originalRoot, source: 'c'.repeat(40), pid, invocation, version: '0.99.1', build: 'old-build' };
    states[role] = { Id: unit, User: 'gouki', MainPID: String(pid), ControlPID: '0', ActiveState: 'active', SubState: 'running',
      Result: 'success', InvocationID: invocation, ExecMainPID: String(pid), ExecMainStartTimestamp: 'original-start',
      ExecMainStartTimestampMonotonic: '1000', WorkingDirectory: originalRoot, ControlGroup: '/system.slice/' + unit,
      Restart: 'always', SendSIGKILL: 'yes', TimeoutStopUSec: '30s', KillSignal: '15', KillMode: 'control-group', Delegate: 'no' };
    pids.add(pid);
  });
  m.windowFile = m.stage + '/window.json'; put(m.windowFile, { runId });
  if (reuse) m.reuseBuilds = { sourceRun: '22222222-2222-2222-2222-222222222222',
    main: { sha256: 'd'.repeat(64) }, guard: { sha256: 'e'.repeat(64) } };
  for (const [name, source] of [['cutover-safety.mjs', 'fixture-adapter-source'], ['writer-network-fence.mjs', 'fixture-native-helper-source']]) put(m.stage + '/fix01-release/' + name, source);
  const configFile = '/srv/video-api-debugger/app/.env'; put(configFile, 'non-secret-synthetic-config');
  m.expectedProtectedFileSha256[configFile] = sha(bytes(configFile));
  const manifestBytes = Buffer.from(JSON.stringify(m)); put(m.stage + '/manifest.json', manifestBytes); const manifestSha256 = sha(manifestBytes);
  const builds = Object.fromEntries(['main', 'guard'].map(kind => {
    const value = { schema: 'rate-impl2-candidate-build.v1', label: kind, source: m[kind].source, version: m[kind].version, build: kind + '-fixture-build',
      runId, manifestSha256, startedAt: now - 10000, finishedAt: now - 1000, exitCode: 0, verifiedSourceAndGates: true };
    if (reuse) {
      Object.assign(value, { label: kind, schema: REUSE_SCHEMA, startedAt: now - 7200000, finishedAt: now - 6600000,
        gateReceipt: '/original/receipt.json', newCompilationClaimed: false, originalTimesChanged: false, reuseInputsFullyVerified: true,
        originalSuccessSha256: m.reuseBuilds[kind].sha256, validatedAt: now - 1000, expiresAt: now - 1000 + 1800000 });
      value.originalBuild = { ...value, runId: m.reuseBuilds.sourceRun, schema: 'rate-impl2-candidate-build.v1' };
    }
    put(candidateEvidenceFile(m, kind), value); return [kind, value];
  }));
  const approval = { schema: 'hd-release-maintenance-approval.v1', runId, mainSource: m.mainSource, guardSource: m.guardSource,
    manifestSha256, privateFreezeSha256: sha(JSON.stringify(m.privateSha256)), windowSha256: sha(bytes(m.windowFile)),
    mainBuildReceiptSha256: sha(bytes(candidateEvidenceFile(m, 'main'))), guardBuildReceiptSha256: sha(bytes(candidateEvidenceFile(m, 'guard'))),
    issuedAt: now - 1000, expiresAt: now + 200000, manualMaintenanceConfirmed: true, allowCompatibleRollback: true,
    operations: ['switch', 'rollback-to-compatible-guard'], writerFence: { install: true,
      helperSha256: m.privateSha256['writer-network-fence.mjs'],
      restorePhases: ['pre-stop-installation-abort', 'before-new-writer-after-proven-old-stop'] } };
  put(m.stage + '/hd-release-safety-approval.json', approval);
  const metadata = file => ({ file, dev: '9', ino: String(500 + file.length), uid: 0, gid: 0, mode: 0o644,
    nlink: 1, sha256: sha(bytes(file)), bytesBase64: bytes(file).toString('base64') });
  const projectSnapshot = item => Object.fromEntries(['uid', 'gid', 'mode', 'nlink', 'sha256', 'bytesBase64'].map(key => [key, item[key]]));
  const cwdText = root => '[Service]\nWorkingDirectory=' + root + '\nEnvironment=HD_DERIVATIVES_ROOT=' + m.hdRoot + '\n';
  put(CWD, cwdText(originalRoot));
  let control = { guard: { sha256: sha('fixture-root-guard'), mode: 0o440, attributes: '----i----' },
    allowed: { sha256: sha('fixture-original-pair'), bytesBase64: Buffer.from('{}').toString('base64') },
    marker: { sha256: sha('fixture-root-marker'), mode: 0o444, attributes: '----i----' }, chain: [{ path: project, uid: 0, mode: 0o755 }] };
  const originalPolicy = { unit: { name: m.live.web.unit, allow: '', deny: '', ingressFilters: '', egressFilters: '' },
    parents: [{ name: '-.slice', allow: '' }, { name: 'system.slice', allow: '' }], runtimeFiles: {},
    loadedDropins: { [CWD]: projectSnapshot(metadata(CWD)) } };
  const before = { schema: 'rate-impl2-switch-before.v1', manifestSha256, protection: { databaseIdentity: ['9', '10'] },
    writers: copy(states), captured: copy(control), policies: {}, protectedFileIdentities: {} };
  const configuration = file => {
    const { bytesBase64: _bytes, ...value } = metadata(file);
    return { ...value, real: file, uid: file === configFile ? 1004 : value.uid,
      mode: file === configFile ? 0o600 : value.mode, ...(state.configurationMutation || {}) };
  };
  // Captured identity is immutable, not recomputed after test mutations.
  const { bytesBase64: _configBytes, ...configMetadata } = metadata(configFile);
  before.protectedFileIdentities[configFile] = { ...configMetadata, real: configFile, uid: 1004, mode: 0o600 };
  put(m.stage + '/switch-before.json', { runId, ...before });
  const temporary = { files: {} }, installed = { runId, stageRoot: m.stage, files: [] }, master = { masterPid: 999, masterStart: '55' };
  let durable, sealCounter = 0, policy = copy(originalPolicy);
  const state = { rows: [record()], lockRows: null, status: 503, socketCount: 0, targetMutation: null, sourceMutation: null,
    logKnown: true, admittedMutations: 0, installFailure: null, probeFailure: false, configurationMutation: null,
    calls: { install: 0, restore: 0, lock: 0 }, pairMutation: false };
  const target = expected => ({ unit: expected.unit, pid: expected.pid, invocation: expected.invocation, processStartTicks: expected.processStartTicks,
    root: expected.root, processRoot: expected.root, source: expected.source, cgroup: expected.cgroup,
    cgroupDev: expected.cgroupDev, cgroupIno: expected.cgroupIno, user: 'gouki', activeState: 'active', subState: 'running',
    mainProcCgroup: expected.cgroup, ownControllerInTargetCgroup: false, processUid: 1004, expectedAppUid: 1004,
    port3302BoundToCgroup: true, established3302: 0, delegated: false, ...(state.targetMutation || {}) });
  const adapter = {
    kind: 'hd-cutover-offline-v1', now: () => now, bytes, json, snapshot: metadata, configuration, exists: file => files.has(file),
    assertWindow: () => assert.equal(json(m.windowFile).runId, runId), privateFiles: () => Object.keys(m.privateSha256).sort(),
    service: role => copy(states[role]), processIdentity: pid => {
      const role = roles.find(value => Number(states[value].MainPID) === pid);
      return { pid, processStartTicks: '12345', cgroup: '/system.slice/' + m.live[role || 'web'].unit,
        root: role ? states[role].WorkingDirectory : originalRoot };
    },
    pidPresent: pid => pids.has(pid), groupPids: group => {
      const role = roles.find(value => '/system.slice/' + m.live[value].unit === group);
      return role && pids.has(Number(states[role].MainPID)) ? [states[role].MainPID] : [];
    },
    groupIdentity: () => ({ dev: 9, ino: 11 }),
    source: root => state.sourceMutation || (root === originalRoot ? 'c'.repeat(40) : root === m.main.root ? m.mainSource : m.guardSource),
    sync: () => ({ databaseIdentity: ['9', '10'], rows: copy(state.rows) }),
    control: () => { const value = copy(control); if (state.pairMutation) value.allowed.sha256 = '0'.repeat(64); return value; },
    cwd: (_before, root) => cwdText(root), logBoundary: () => state.logKnown ? [{ fileSha256: sha('fixture-log'), offset: 0 }] : [],
    completedObservation: () => ({ completed: 0, deniedMutations: 0, admittedMutations: state.admittedMutations, fullLifecycleProven: false }),
    fenceIO: { kind: 'offline-cutover-observations' },
    seal(name, body) {
      const file = m.stage + '/hd-release-safety-r03/' + name + (name === 'fence-view' ? '' : '-' + ++sealCounter) + '.json';
      assert.equal(files.has(file), false); put(file, JSON.stringify(body) + '\n');
      return { ...body, artifact: { path: file, sha256: sha(bytes(file)) } };
    },
    async inspectFence({ manifest, manifestSha256: digest, phase }) {
      const expected = assertWriterFenceManifest(manifest, digest);
      return inspectWriterFenceTarget({ manifest, manifestSha256: digest, phase,
        io: { now: () => now, inspect: async () => target(expected), policy: async () => copy(policy) } });
    },
    async prepareProbe() { log.push('prepare-probe'); assert.equal(state.probeFailure, false); return { fixtureOnly: true }; },
    async ingress() { return { responses: ['sd2.youdooart.com', 'sd2-server.youdoodesign.com'].map(host => ({
      host, status: state.status, responseSha256: sha('fixture-response'), checkedAt: now })), sockets: { count: state.socketCount } }; },
    async lock(options) {
      state.calls.lock++; log.push('empty-lock-acquired');
      const rows = copy(state.lockRows || state.rows), lock = { syncRows: rows, deadlineAt: now + 20000, databaseIdentity: { dev: '9', ino: '10' } };
      try {
        options.assertNoSynchronousImageAdmissions(rows);
        const value = await options.callback({ lock, signal: { aborted: false }, deadlineAt: now + 8000 });
        log.push('empty-lock-rollback'); return { value, lock, releaseEvidence: { released: true } };
      } catch (error) {
        error.evidence = { released: state.installFailure !== 'unknown', callbackTimedOut: state.installFailure === 'unknown' };
        log.push('empty-lock-rollback'); throw error;
      }
    },
    async install(options) {
      state.calls.install++; log.push('fence-install');
      const expected = assertWriterFenceManifest(options.manifest, options.manifestSha256);
      assertWriterFencePreconditions(options.preconditions, expected, now);
      for (const file of NETWORK) put(file, '[Service]\nIPAddressDeny=any\n');
      durable = { schema: 'trace03-writer-network-fence.v1', binding: expected, phase: state.installFailure ? 'failed-keep-fence' : 'verified',
        expectedRuntimeFiles: Object.fromEntries(NETWORK.map(file => [file, projectSnapshot(metadata(file))])),
        originalPolicy: copy(policy), receiptSha256: sha('fixture-installed-receipt') };
      put(m.stage + '/hd-release-safety-r03/writer-network-fence.v1.json', durable);
      if (state.installFailure) throw Object.assign(new Error('Explicit fixture install failure'), { receipt: copy(durable) });
      return copy(durable);
    },
    async readFence() { assert.ok(durable); return copy(durable); },
    async restore(options) {
      const expected = assertWriterFenceManifest(options.manifest, options.receipt.binding.manifestSha256);
      assertWriterFenceRestoreGate({ expected, authority: options.authority, receipt: options.receipt,
        oldWriterProof: options.oldWriterProof, guardsProof: options.guardsProof, newPairProof: options.newPairProof, now });
      state.calls.restore++; log.push('fence-restore');
      durable = { ...copy(durable), phase: 'restored', restorePhase: options.authority.approvedRestorePhase, receiptSha256: sha('fixture-restored-receipt') };
      put(m.stage + '/hd-release-safety-r03/writer-network-fence.v1.json', durable);
      for (const file of NETWORK) files.delete(file);
      return copy(durable);
    },
  };
  const safety = () => createHdReleaseSafety({ m, manifestSha256, approval, approvalSha256: sha(bytes(m.stage + '/hd-release-safety-approval.json')), offlineAdapter: adapter });
  const context = { m, before, builds, temporary, installed, master };
  function stop(role) {
    if (!temporary.files.web) {
      const file = '/run/systemd/system/sd2-gray.service.d/zz-fixture-no-force.conf'; put(file, '[Service]\nRestart=no\nSendSIGKILL=no\nTimeoutStopSec=infinity\n');
      temporary.files.web = metadata(file); policy.loadedDropins[file] = projectSnapshot(metadata(file));
      for (const item of roles) Object.assign(states[item], { Restart: 'no', SendSIGKILL: 'no', TimeoutStopUSec: 'infinity' });
    }
    const initial = copy(states[role]); pids.delete(Number(initial.MainPID));
    Object.assign(states[role], { MainPID: '0', ActiveState: 'inactive', SubState: 'dead' });
    put(m.stage + '/natural-stop-intent-switch-' + role + '.json', { runId, manifestSha256, before: initial,
      capturedOriginal: before.writers[role], requestedAt: now, signal: 'SIGTERM', forcedKill: false });
    put(m.stage + '/natural-stop-switch-' + role + '.json', { runId, manifestSha256, before: initial, after: copy(states[role]),
      originalCgroup: initial.ControlGroup, forcedKill: false }); log.push('stop-' + role);
  }
  function publish() {
    const allowed = { runId, releases: ['main', 'guard'].map(kind => ({ source: m[kind].source, root: m[kind].root,
      version: m[kind].version, build: builds[kind].build })) };
    const newAllowed = { sha256: sha(JSON.stringify(allowed)), bytesBase64: Buffer.from(JSON.stringify(allowed)).toString('base64') };
    const body = { schema: 'pricing-start-pair-published.v1', runId, manifestSha256, installed: newAllowed };
    const receiptFile = m.stage + '/allowed-original.json.published.json'; put(receiptFile, body);
    context.published = { ...body, receiptFile, receiptSha256: sha(bytes(receiptFile)) }; control.allowed = newAllowed;
    // Real switch service-mode results follow configured unit WorkingDirectory.
    // A process cwd change alone is deliberately not modelled as a guard switch.
    const accepted = [];
    for (const kind of ['main', 'guard']) {
      for (const role of ['web', 'image']) {
        states[role].WorkingDirectory = m[kind].root;
        accepted.push({ service: m.live[role].unit, source: m[kind].source, build: builds[kind].build,
          version: m[kind].version, sourceAndBuildVerified: true, barrierVerified: true });
      }
    }
    for (const role of roles) states[role].WorkingDirectory = m.main.root;
    context.prestart = { accepted, rejected: [{ root: originalRoot, refusal: 'legacy or unapproved program' }],
      actualExecStartPreVerified: true, cleanServiceUser: 'gouki' };
    put(m.stage + '/actual-prestart.json', { runId, manifestSha256, ...context.prestart }); put(CWD, cwdText(m.main.root));
    log.push('pair-and-four-actual-service-prestarts');
  }
  function startNew() {
    roles.forEach((role, index) => { const pid = 201 + index;
      Object.assign(states[role], { MainPID: String(pid), ActiveState: 'active', SubState: 'running',
        InvocationID: String(index + 4).repeat(32), WorkingDirectory: m.main.root }); pids.add(pid);
    }); log.push('start-new');
  }
  return { m, before, context, approval, state, adapter, safety, stop, publish, startNew, files, put, bytes, json, log, pids, states,
    setNow: value => { now = value; } };
}
export function createRecoverySafetyFixture(options) { return memory(options); }

export async function runHdCutoverSafetyEngineering() {
  const cases = [], add = name => cases.push({ name, passed: true });
  const dedicated = '/data/video-api-debugger/logs/nginx-access.log';
  const config = log => 'http {\naccess_log /var/log/nginx/access.log combined;\n' +
    ['sd2.youdooart.com', 'sd2-server.youdoodesign.com'].map(host =>
      'server {\nserver_name ' + host + ';\n' + log + '\nlocation / {\nproxy_pass http://127.0.0.1:3302;\n}\n}\n').join('') + '}\n';
  assert.deepEqual(logPaths(config('access_log ' + dedicated + ' combined;')), [dedicated]); add('dedicated_project_log_accepted');
  for (const log of ['', 'access_log /var/log/nginx/access.log combined;', 'access_log ' + dedicated + ' combined buffer=32k;']) {
    assert.throws(() => logPaths(config(log))); add('shared_or_buffered_log_rejected_' + cases.length);
  }
  assert.throws(() => logPaths(config('access_log ' + dedicated + ' combined;') +
    'server {\nserver_name unrelated.invalid;\naccess_log ' + dedicated + ' combined;\n}\n')); add('unrelated_host_sharing_project_log_rejected');
  const begin = async change => { const f = memory(); change?.(f); const safety = f.safety(); await safety.beforeMaintenance(f.context); return { f, safety }; };
  const installed = async () => {
    const result = await begin(); result.f.stop('image'); result.f.stop('hd'); await result.safety.installFence(result.f.context); return result;
  };
  const ready = async () => { const result = await installed(); result.f.stop('web'); result.f.publish(); return result; };
  {
    const { f, safety } = await begin(value => { value.state.targetMutation = { established3302: 20 }; });
    assert.equal(f.state.calls.install, 0);
    f.stop('image'); f.stop('hd');
    await assert.rejects(() => safety.installFence(f.context));
    assert.equal(f.state.calls.install, 0); add('serving_connections_allowed_before_maintenance_but_rejected_before_fence');
  }
  {
    const { f, safety } = await begin(value => { value.state.targetMutation = { established3302: 20 }; });
    f.stop('image'); f.stop('hd'); f.state.targetMutation = { established3302: 0 };
    await safety.installFence(f.context); assert.equal(f.state.calls.install, 1);
    add('serving_connections_naturally_drained_before_fence');
  }
  {
    const { f, safety } = await ready(); await safety.restoreBeforeStart(f.context); f.startNew();
    assert.equal((await f.safety().assertRollbackAllowed(f.context)).originalIdentityReusable, false);
    assert.ok(f.log.indexOf('fence-install') < f.log.indexOf('stop-web'));
    assert.ok(f.log.indexOf('prepare-probe') < f.log.indexOf('stop-image'));
    assert.ok(f.log.indexOf('prepare-probe') < f.log.indexOf('stop-hd'));
    assert.ok(f.log.indexOf('fence-restore') < f.log.indexOf('start-new'));
    assert.equal(safety.evidence().nativeExecuted, false); add('legal_image_hd_fence_web_pair_restore_start_sequence');
  }
  for (const [name, change] of [
    ['changed_configuration_owner_refused', f => { f.state.configurationMutation = { uid: 0 }; }],
    ['native_probe_preparation_failure_refused_before_maintenance', f => { f.state.probeFailure = true; }],
    ['changed_configuration_mode_refused', f => { f.state.configurationMutation = { mode: 0o644 }; }],
    ['changed_configuration_inode_refused', f => { f.state.configurationMutation = { ino: '9999' }; }],
    ['changed_configuration_bytes_refused', f => { f.state.configurationMutation = { sha256: '0'.repeat(64) }; }],
    ['configuration_alias_refused', f => { f.state.configurationMutation = { real: '/different-config' }; }],
    ['configuration_hardlink_refused', f => { f.state.configurationMutation = { nlink: 2 }; }],
    ['all_owner_running_sync_refused', f => { f.state.rows = [record('running', 'another-fixture-owner')]; }],
    ['bad_sync_schema_refused', f => { const value = JSON.parse(f.state.rows[0].value_json); value.schema = 'unknown'; f.state.rows[0].value_json = JSON.stringify(value); }],
    ['sync_key_owner_mismatch_refused', f => { f.state.rows[0].key += '-other'; }],
    ['unknown_original_identity_refused', f => { f.state.targetMutation = { pid: 99999 }; }],
    ['unknown_log_observation_refused', f => { f.state.logKnown = false; }],
  ]) { await assert.rejects(() => begin(change)); add(name); }
  {
    const { f, safety } = await begin(); f.stop('image'); f.stop('hd'); f.state.lockRows = [record('running')];
    await assert.rejects(() => safety.installFence(f.context)); assert.equal(f.state.calls.install, 0); add('same_lock_running_sync_refused_before_network_install');
  }
  for (const [name, change] of [
    ['missing_real_ingress_503_refused', f => { f.state.status = 200; }],
    ['image_complete_promise_not_settled_refused', f => { f.pids.add(102); }],
    ['new_original_web_identity_refused', f => { f.state.targetMutation = { invocation: 'f'.repeat(32) }; }],
    ['completed_admitted_mutating_request_refused', f => { f.state.admittedMutations = 1; }],
  ]) {
    const { f, safety } = await begin(); f.stop('image'); f.stop('hd'); change(f);
    await assert.rejects(() => safety.installFence(f.context)); assert.equal(f.state.calls.install, 0); add(name);
  }
  for (const [name, change] of [
    ['restore_original_pid_still_present_refused', f => { f.pids.add(101); }],
    ['restore_pair_cas_mismatch_refused', f => { f.state.pairMutation = true; }],
    ['restore_wrong_exact_cwd_refused', f => { f.put(CWD, '[Service]\nWorkingDirectory=' + f.m.guard.root + '\n'); }],
    ['restore_new_writer_already_active_refused', f => { f.startNew(); }],
    ['guard_service_proof_cannot_be_process_cwd_simulation', f => {
      for (const item of f.context.prestart.accepted) if (item.source === f.m.guardSource) item.source = f.m.mainSource;
      f.put(f.m.stage + '/actual-prestart.json', { runId: f.m.runId, manifestSha256: f.before.manifestSha256, ...f.context.prestart });
    }],
  ]) {
    const { f, safety } = await ready(); change(f);
    await assert.rejects(() => safety.restoreBeforeStart(f.context)); assert.equal(f.state.calls.restore, 0); add(name);
  }
  {
    const { f, safety } = await begin(); f.stop('image'); f.stop('hd'); f.state.installFailure = 'unknown';
    await assert.rejects(() => safety.installFence(f.context)); await safety.onFailure(f.context);
    assert.equal(f.state.calls.restore, 0); assert.equal(safety.evidence().installUnknown, true); add('unknown_install_failure_keeps_fence_and_503');
  }
  {
    const { f, safety } = await begin(); f.stop('image'); f.stop('hd'); f.state.installFailure = 'known';
    await assert.rejects(() => safety.installFence(f.context)); await safety.onFailure(f.context);
    assert.equal(f.state.calls.restore, 1); add('known_failed_install_phase_A_requires_original_live_pair');
  }
  {
    const { f, safety } = await ready(); await safety.restoreBeforeStart(f.context); f.startNew(); f.pids.add(101);
    await assert.rejects(() => f.safety().assertRollbackAllowed(f.context)); add('rollback_cannot_reuse_original_identity_or_stop_proof');
  }
  assert.equal(parseAllOwnerSynchronousRows([record('accepted_unknown')], 100000).runningRequests, 0);
  add('ended_unknown_acceptance_is_not_an_executing_promise');
  {
    const source = fs.readFileSync(new URL('./cutover-safety.mjs', import.meta.url), 'utf8');
    const marker = 'const saved = d.bytes(', start = source.indexOf(marker); assert.ok(start > 0);
    assert.equal(source.indexOf(marker, start + 1), -1);
    const end = source.indexOf(');', start), expression = source.slice(start + 'const saved = '.length, end + 1);
    const readCheckpointApproval = new Function('d', 'm', 'hdMaintenanceApprovalFile', 'return ' + expression + ';');
    const m = { stage: '/isolated-current-approval' }, reads = [];
    const io = { bytes: file => { reads.push(file); return Buffer.from(file); } };
    for (const filename of ['hd-release-safety-approval.json', 'hd-release-safety-approval-switch-admission-r01.json']) {
      const selected = m.stage + '/' + filename;
      assert.equal(readCheckpointApproval(io, m, value => { assert.equal(value, m); return selected; }).toString(), selected);
      assert.equal(reads.at(-1), selected);
    }
    const prior = reads.length; assert.throws(() => readCheckpointApproval(io, m, () => { throw Error('Unbound current approval'); }));
    assert.equal(reads.length, prior);
    add('actual_checkpoint_approval_expression_reads_current_bound_file_and_propagates_refusal');
  }


  {
    const source = fs.readFileSync(new URL('./cutover-safety.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('  function checkBefore('), end = source.indexOf('  function establishView(', start);
    assert.ok(start > 0 && end > start);
    const m = { stage: '/isolated-restored-safety', runId: 'isolated-run', live: Object.fromEntries(roles.map((role, i) => [role,
      { pid: 100 + i, invocation: String(i + 1).repeat(32), root: '/sealed/' + role }])) };
    const freshLive = Object.fromEntries(roles.map((role, i) => [role, { ...m.live[role], pid: 300 + i, invocation: String(i + 4).repeat(32) }]));
    const manifestSha256 = 'a'.repeat(64), before = { schema: 'rate-impl2-switch-before.v1', manifestSha256,
      writers: Object.fromEntries(roles.map(role => [role, { MainPID: String(freshLive[role].pid), InvocationID: freshLive[role].invocation, WorkingDirectory: freshLive[role].root }])) };
    const file = m.stage + '/restored-switch-before-r01.json', reads = [];
    const d = { json: name => { reads.push(name); assert.equal(name, file); return { runId: m.runId, ...copy(before) }; } };
    const check = new Function('assert', 'd', 'm', 'manifestSha256', 'ROLES', 'operationalLive', 'operationalBeforeFile',
      source.slice(start, end) + ';return checkBefore;')(assert, d, m, manifestSha256, roles,
      (manifest, role) => { assert.equal(manifest, m); return freshLive[role]; }, manifest => { assert.equal(manifest, m); return file; });
    check(before); assert.deepEqual(reads, [file]);
    const stale = copy(before); stale.writers.hd.MainPID = String(m.live.hd.pid); assert.throws(() => check(stale));
    const actualStart = source.indexOf('function establishActiveView('), actualEnd = source.indexOf('async function readBeforeMaintenance(', actualStart);
    const establish = new Function('assert', 'clone', 'CWD', 'operationalLive', 'assertWriterFenceManifest',
      source.slice(actualStart, actualEnd) + ';return establishActiveView;')(assert, copy, CWD,
      (manifest, role) => freshLive[role], view => { assert.equal(view.live.web.pid, freshLive.web.pid); return { expected: true }; });
    m.main = { root: '/candidate/main' }; m.guard = { root: '/candidate/guard' }; m.live.web.source = 'b'.repeat(40);
    let sealed;
    const adapter = { service: () => ({ MainPID: before.writers.web.MainPID, InvocationID: freshLive.web.invocation, ActiveState: 'active', SubState: 'running', Delegate: 'no' }),
      processIdentity: pid => { assert.equal(pid, freshLive.web.pid); return { root: m.live.web.root, processStartTicks: '1234', cgroup: '/system.slice/sd2-gray.service' }; },
      groupIdentity: () => ({ dev: '1', ino: '2' }), source: () => m.live.web.source, cwd: (value, root) => root,
      seal: (name, value) => { assert.equal(name, 'fence-view'); sealed = value; } };
    const frozen = JSON.stringify(m); const result = establish(adapter, m, before, manifestSha256);
    assert.equal(result.view.live.web.pid, freshLive.web.pid); assert.equal(sealed.view.live.web.invocation, freshLive.web.invocation);
    assert.equal(JSON.stringify(m), frozen); add('actual_restored_safety_bodies_use_fresh_append_baseline_and_identity_without_manifest_mutation');
  }

  const sourceSha256 = Object.fromEntries(['cutover-safety.mjs', 'cutover-safety-engineering.mjs'].map(file => [
    file, sha(fs.readFileSync(fileURLToPath(new URL('./' + file, import.meta.url)))),
  ]));
  return { schema: 'hd-cutover-safety-engineering.v1', completed: true, nativeExecuted: false,
    cases, total: cases.length, passed: cases.length, sourceSha256,
    effects: { productionWrites: 0, serviceCalls: 0, networkRequests: 0, providerRequests: 0, databaseCalls: 0, browserRuns: 0 },
    boundary: 'Explicit in-memory observations exercise real adapter decisions and native pure gates, not native process/BPF/SQLite acceptance' };
}

// Actual Linux filesystem operations are restricted to a new private evidence
// directory. No production configuration, permissions, services or data change.
export function runProtectedConfigurationFileEngineering({ directory }) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  assert.ok(directory.startsWith('/data/video-api-debugger/release-staging/'));
  assert.equal(fs.realpathSync(directory), directory); const parent = fs.lstatSync(directory);
  assert.ok(parent.isDirectory() && parent.uid === 0 && (parent.mode & 0o7777) === 0o700);
  const fixture = fs.mkdtempSync(path.join(directory, 'configuration-fs-'));
  fs.chmodSync(fixture, 0o700);
  const cases = [], add = (name, action) => { action(); cases.push({ name, passed: true }); };
  const original = path.join(fixture, 'nginx.conf'), maintained = path.join(fixture, 'nginx-maintained.conf');
  for (const [file, bytes] of [[original, 'synthetic original config\n'], [maintained, 'synthetic maintained config\n']]) {
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o644 }); fs.chownSync(file, 501, 50); fs.chmodSync(file, 0o644);
  }
  const old = protectedFileSnapshot(original), current = protectedFileSnapshot(maintained);
  add('captured_nonroot_nginx_original_is_valid_without_chown', () => assertConfigurationIdentity(old, fileIdentity(original), old.sha256));
  add('nonroot_maintained_config_exact_identity_and_bytes_is_valid', () => assertConfigurationIdentity(current, fileIdentity(maintained), current.sha256));
  add('original_swap_same_nonroot_owner_is_valid', () => assertConfigurationIdentity(protectedFileSnapshot(original), fileIdentity(original), old.sha256));
  add('root_release_reader_still_rejects_nonroot_nginx', () => assert.throws(() => rootFile(original)));
  for (const [key, value] of [['dev', '999'], ['ino', '999'], ['uid', 0], ['gid', 0], ['mode', 0o600], ['kind', 'symlink']]) {
    add('changed_' + key + '_identity_is_rejected', () => assert.throws(() => assertConfigurationIdentity(current,
      { ...fileIdentity(maintained), [key]: value }, current.sha256)));
  }
  add('wrong_maintained_bytes_are_rejected', () => assert.throws(() => assertConfigurationIdentity(current, fileIdentity(maintained), old.sha256)));
  const app = path.join(fixture, '.env'); fs.writeFileSync(app, 'synthetic secret-free fixture\n', { flag: 'wx', mode: 0o600 }); fs.chownSync(app, 1004, 1004);
  const appBefore = protectedFileSnapshot(app);
  add('captured_app_user_0600_is_valid_without_permission_change', () => assertConfigurationIdentity(appBefore, fileIdentity(app), appBefore.sha256));
  add('root_release_reader_still_rejects_app_user_env', () => assert.throws(() => rootFile(app)));
  const link = path.join(fixture, 'alias'); fs.symlinkSync(app, link);
  add('symbolic_config_leaf_is_rejected', () => assert.throws(() => protectedFileSnapshot(link)));
  const hard = path.join(fixture, 'hard'); fs.linkSync(app, hard);
  add('hardlinked_config_original_is_rejected', () => assert.throws(() => protectedFileSnapshot(app)));
  add('hardlinked_config_alias_is_rejected', () => assert.throws(() => protectedFileSnapshot(hard)));
  add('regular_original_and_maintained_fixtures_unchanged', () => {
    assert.deepEqual(protectedFileSnapshot(original), old); assert.deepEqual(protectedFileSnapshot(maintained), current);
  });
  const runtime = path.join(fixture, 'runtime'), dist = runtime + '/.next-prod-candidate';
  fs.mkdirSync(dist + '/static', { recursive: true });
  const source = 'f'.repeat(40), build = 'original-build-fixture';
  const write = (file, value) => fs.writeFileSync(file, value, { flag: 'wx', mode: 0o644 });
  write(runtime + '/.deployed-commit', source); write(dist + '/BUILD_ID', build);
  write(dist + '/app-build-manifest.json', JSON.stringify({ pages: { '/multiview/page': ['static/app.js'] } }));
  write(dist + '/static/app.js', 'synthetic original compiled file'); fs.symlinkSync('.next-prod-candidate', runtime + '/.next-prod');
  fs.chownSync(dist + '/app-build-manifest.json', 1004, 1004);
  const identity = { root: runtime, source, build };
  add('original_app_owned_build_uses_exact_candidate_alias', () => assert.equal(originalRuntimeBuild(identity).asset, 'static/app.js'));
  add('root_control_reader_still_rejects_build_alias', () => assert.throws(() => rootFile(runtime + '/.next-prod/app-build-manifest.json')));
  add('wrong_original_source_rejected', () => assert.throws(() => originalRuntimeBuild({ ...identity, source: 'e'.repeat(40) })));
  add('wrong_original_build_rejected', () => assert.throws(() => originalRuntimeBuild({ ...identity, build: 'wrong' })));
  fs.renameSync(runtime + '/.next-prod', runtime + '/original-alias'); fs.symlinkSync('.', runtime + '/.next-prod');
  add('original_alias_escape_rejected', () => assert.throws(() => originalRuntimeBuild(identity)));
  fs.unlinkSync(runtime + '/.next-prod'); fs.renameSync(runtime + '/original-alias', runtime + '/.next-prod');
  fs.linkSync(dist + '/static/app.js', dist + '/static/hard.js');
  add('hardlinked_original_asset_rejected', () => assert.throws(() => originalRuntimeBuild(identity)));
  const nginxStage = path.join(fixture, 'nginx-config'); fs.mkdirSync(nginxStage, { mode: 0o700 });
  const nginx = captureNginxMaintenance({ runId: path.basename(directory), stageRoot: nginxStage });
  add('actual_project_nginx_pins_and_maintenance_render_captured_before_switch', () => assert.equal(nginx.files.length, 2));
  return { schema: 'hd-protected-configuration-fs-engineering.v1', completed: true, nativeFilesystem: true,
    nginxCapture: { directory: nginxStage, files: nginx.files.map(item => ({ file: item.file, sha256: item.sha256, maintainedSha256: item.maintainedSha256 })) },
    fixtureDirectory: fixture, cases, total: cases.length, effects: { productionWrites: 0, serviceCalls: 0,
      providerRequests: 0, databaseWrites: 0 }, boundary: 'Real private temporary files only; not production maintenance or functional acceptance' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixtureRoot = path.join('/data/video-api-debugger/release-staging', randomUUID());
  fs.mkdirSync(fixtureRoot, { mode: 0o700 });
  runHdCutoverSafetyEngineering().then(value => console.log(JSON.stringify({ ...value,
    configurationFs: runProtectedConfigurationFileEngineering({ directory: fixtureRoot })
  }))).catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
}
