import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  NATIVE_FIXTURES, RELEASE_PHASES, captureReleaseScene, createReleaseController, nextReleasePhase,
  postcheckReleasePhase, releaseChildAction, releaseResumeDecision, runPhaseTransaction, validateNativeFixture,
  validatePackageRequest, validatePrepareTailContinuation, assertPrepareTailControllerDifference, assertPrepareTailChildRoute,
  validateGuardBuildTailContinuation, assertGuardBuildTailControllerDifference, assertGuardBuildTailPhase, GUARD_BUILD_TAIL_PHASES,
  validateGuardBuildTailRetry, assertGuardBuildTailRetryControllerDifference, assertGuardBuildTailRetryFailure,
  validateReaderSuccessor, assertReaderSuccessorControllerDifference, assertReaderSuccessorPhase,
  assertReaderSuccessorAdmission, READER_SUCCESSOR_PHASES,
  validateArmPairRepair, assertArmPairRepairFailure, assertArmPairRepairControllerDifference,
  assertArmPairRepairAdmission, ARM_PAIR_REPAIR_ORIGIN,
  validateArmProcessorRepair, assertArmProcessorRepairFailure, assertArmProcessorRepairControllerDifference,
  assertArmProcessorRepairAdmission, ARM_PROCESSOR_REPAIR_ORIGIN, assertCandidateReobservationAdmission,
  validateSwitchAdmissionRepair, assertSwitchAdmissionRepairFailure, assertSwitchAdmissionControllerDifference,
  assertSwitchAdmissionRepairAdmission, SWITCH_ADMISSION_REPAIR_ORIGIN, assertSwitchAdmissionApprovalPath,
  assertLegacyTemplateBuildAlias, assertCandidateSwitchObservationAdmission,
  validateSwitchTypedRepair, assertSwitchTypedRepairFailure, assertSwitchTypedRepairRefusalLog,
  assertSwitchTypedRepairControllerDifference, assertSwitchTypedRepairAdmission, assertSwitchTypedApprovalPath, SWITCH_TYPED_REPAIR_ORIGIN,
  validateSwitchScanRepair, assertSwitchScanRepairFailure, assertSwitchScanRepairRefusalLog,
  assertSwitchScanRepairControllerDifference, assertSwitchScanRepairAdmission, assertSwitchScanApprovalPath, SWITCH_SCAN_REPAIR_ORIGIN,
  validateSwitchOwnerRepair, assertSwitchOwnerRepairFailure, assertSwitchOwnerRepairRefusalLog, assertSwitchOwnerStrictResult,
  assertSwitchOwnerRepairControllerDifference, assertSwitchOwnerRepairAdmission, assertSwitchOwnerApprovalPath, SWITCH_OWNER_REPAIR_ORIGIN,
  validateSwitchWindowRepair, assertSwitchWindowRepairFailure, assertSwitchWindowRepairRefusalLog, assertSwitchWindowOriginalSnapshots,
  assertSwitchWindowRepairControllerDifference, assertSwitchWindowRepairAdmission, assertSwitchWindowApprovalPath, SWITCH_WINDOW_REPAIR_ORIGIN,
  assertCandidateSwitchOwnerObservationAdmission, validateRestoredOriginalClosure, validateRestoredOriginalRepair,
  assertRestoredOriginalFailure, assertRestoredOriginalControllerDifference, assertRestoredOriginalClosureAdmission,
  assertRestoredOriginalRepairAdmission, assertRestoredOriginalApprovalPath, assertRestoredOriginalLive, assertRestoredOriginalScene,
  assertCandidateRestoredOriginalObservationAdmission, assertRestoredOriginalMaintenanceOperationId, RESTORED_ORIGINAL_ORIGIN,
  validateGuardRecoveryRepair, assertGuardRecoveryRepairChildPhase, assertGuardRecoveryRepairControllerDifference,
  assertGuardRecoveryRepairFailure, assertGuardRecoveryRepairAdmission, GUARD_RECOVERY_REPAIR_ORIGIN,
} from './release-entry.mjs';
import { createControllerOwner, finishPhase, readAttempt, recordAttemptEvent, startPhase } from './attempt-state.mjs';
import { ENGINE_VERSION } from './engine-version.mjs';
import { readTypedFile, assertTypedFileUnchanged } from './typed-files.mjs';

const HASH = 'a'.repeat(64);
const self = fileURLToPath(import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return file;
}

function loaded(events = []) {
  return { derivedState: { lastEventSha256: HASH }, events: events.map((value, index) => ({ value, sha256: String(index).padStart(64, '0') })) };
}

function scene(label) {
  const facts = { fixtureOnly: true, label };
  return { schema: 'sd2-release-scene-summary.v1', capturedAt: 1, sha256: HASH, facts };
}

async function scenarioA(runTransaction) {
  const order = [], child = { status: 0, signal: null, error: null };
  const kernel = {
    startPhase(input) { order.push('intent'); assert.equal(input.phase, 'capture'); return { eventSha256: HASH }; },
    async recordChild(input) { order.push('child-durable'); assert.deepEqual(input.value.child, child); },
    finishPhase(input) { order.push('result'); assert.equal(input.outcome, 'succeeded'); assert.deepEqual(input.child, child); return input; },
  };
  await runTransaction({ phase: 'capture', loaded: loaded(), owner: {}, before: scene('before'), kernel,
    async executeChild() { order.push('child'); return { child, receipt: { child, stdout: '{}' } }; },
    async persistChild() { order.push('persist'); return { file: '/fixture/child.json', sha256: HASH }; },
    async postcheck() { order.push('postcheck'); assert.deepEqual(order.slice(-2), ['child-durable', 'postcheck']); },
    async after() { order.push('scene'); return scene('after'); }, now: 1 });
  assert.deepEqual(order, ['intent', 'child', 'persist', 'child-durable', 'postcheck', 'scene', 'result']);
  return 'A_original_child_exit_is_durable_before_postcheck';
}

function scenarioDecisions() {
  assert.deepEqual(releaseResumeDecision({ ownerStatus: 'alive', activePhase: null, effectsStarted: false,
    switchComplete: false, childReceiptPresent: false }), { action: 'refuse', reason: 'owner_alive' });
  assert.deepEqual(releaseResumeDecision({ ownerStatus: 'unknown', activePhase: 'verify', effectsStarted: false,
    switchComplete: false, childReceiptPresent: false }), { action: 'refuse', reason: 'owner_unknown' });
  assert.deepEqual(releaseResumeDecision({ ownerStatus: 'dead', activePhase: 'verify', effectsStarted: false,
    switchComplete: false, childReceiptPresent: true }), { action: 'takeover_reconcile', reason: 'durable_child_exit' });
  assert.deepEqual(releaseResumeDecision({ ownerStatus: 'dead', activePhase: 'verify', effectsStarted: false,
    switchComplete: false, childReceiptPresent: false }), { action: 'takeover_stop_or_refuse', reason: 'original_child_exit_missing' });
  return 'decision_table_is_fail_closed';
}

function operation(batch) {
  return { schema: 'sd2-release-operation.v1', taskId: batch.taskId, attemptId: batch.attemptId,
    taskRoot: `${batch.projectRoot}/release-tasks/${batch.taskId}` };
}

function artifact(kind, source) {
  return { schema: 'sd2-release-artifact-identity.v1', kind, source, version: '0.0.0-fixture', build: `${kind}-fixture-build`,
    sourceManifestSha256: digest(`${kind}-source-manifest`), compiledTreeSha256: digest(`${kind}-compiled-tree`),
    immutableSuccessSha256: digest(`${kind}-immutable-success`) };
}

function fixtureFiles(root, boundary, variant) {
  const taskId = randomUUID(), attemptId = randomUUID(), stage = path.join(root, 'release-staging', attemptId);
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  const engineHash = digest('fixture-controller-set'), engine = { schema: 'sd2-release-engine.v1', version: ENGINE_VERSION,
    controllerSetSha256: engineHash, root: `${root}/release-engines/${ENGINE_VERSION}-${engineHash}` };
  const batch = { schema: 'sd2-release-batch.v1', project: 'video-api-debugger', projectRoot: root, taskId, attemptId,
    runId: attemptId, engine, contextFile: path.join(stage, 'context.json'), seedFile: path.join(stage, 'seed.json'),
    manifestFile: path.join(stage, 'manifest.json'), artifacts: { main: artifact('main', '1'.repeat(40)),
      guard: artifact('guard', '2'.repeat(40)) }, phases: RELEASE_PHASES };
  const batchFile = writeJson(path.join(stage, 'release-batch.json'), batch), op = operation(batch), now = Date.now(), expiresAt = now + 300_000;
  writeJson(batch.contextFile, { schema: 'sd2-release-context.v1', contract: { engine, operation: op } });
  writeJson(batch.seedFile, { schema: 'sd2-release-seed-fixture.v1', runId: attemptId, engine, operation: op });
  writeJson(batch.manifestFile, { schema: 'rate-impl2-release.v1', project: batch.project, projectRoot: root, runId: attemptId,
    stage, engine, operation: op, main: { source: batch.artifacts.main.source, version: batch.artifacts.main.version },
    guard: { source: batch.artifacts.guard.source, version: batch.artifacts.guard.version } });
  writeJson(path.join(stage, 'fixed-guard-recovery.json'), { schema: 'fixture-fixed-guard-recovery.v1', runId: attemptId });
  const windowFile = writeJson(path.join(stage, 'window.json'), { schema: 'fixture-window.v1', project: batch.project,
    runId: attemptId, mainSource: batch.artifacts.main.source, guardSource: batch.artifacts.guard.source,
    observedAt: now, expiresAt });
  const approvalFile = writeJson(path.join(stage, 'approval.json'), { schema: 'fixture-approval.v1', runId: attemptId,
    issuedAt: now, expiresAt });
  return { schema: 'sd2-release-entry-process-fixture.v1', root, batchFile, windowFile, approvalFile,
    taskId, attemptId, stage, boundary, variant };
}

function fixtureScene(batch) { return captureReleaseScene(batch, Date.now()); }

function primeThroughArm(config, owner) {
  const batch = JSON.parse(fs.readFileSync(config.batchFile)), root = `${batch.projectRoot}/release-tasks`;
  const common = { root, taskId: batch.taskId, attemptId: batch.attemptId, owner };
  for (const phase of RELEASE_PHASES.slice(0, RELEASE_PHASES.indexOf('switch'))) {
    const current = readAttempt({ root, taskId: batch.taskId, attemptId: batch.attemptId }), before = fixtureScene(batch);
    const intent = startPhase({ ...common, phase, dependencyEventSha256: current.derivedState.lastEventSha256, before, now: Date.now() });
    finishPhase({ ...common, phase, intentSha256: intent.eventSha256, outcome: 'succeeded',
      child: { status: 0, signal: null, error: null }, after: fixtureScene(batch), now: Date.now() });
  }
}

function boundaryRecord(batch, name, edge) {
  return { schema: 'sd2-release-boundary.v1', taskId: batch.taskId, attemptId: batch.attemptId, runId: batch.runId,
    engine: batch.engine, name, edge, manifestSha256: digest(fs.readFileSync(batch.manifestFile)), operation: operation(batch) };
}

function fixtureChild(phase, intentSha256, value = { completed: true }) {
  const child = { status: 0, signal: null, error: null };
  return { child, receipt: { schema: 'sd2-release-phase-child.v1', phase, intentSha256, startedAt: Date.now(),
    finishedAt: Date.now(), child, stdout: JSON.stringify(value) + '\n', stderr: '' } };
}

async function fixtureWorker(mode, configFile) {
  const config = JSON.parse(fs.readFileSync(configFile)), batch = JSON.parse(fs.readFileSync(config.batchFile));
  if (mode === 'setup') {
    let owner;
    const controller = createReleaseController({ createOwner: () => (owner ||= createControllerOwner()), scene: fixtureScene });
    controller.start(config.batchFile, config.windowFile); primeThroughArm(config, owner);
    assert.equal(nextReleasePhase(readAttempt({ root: `${batch.projectRoot}/release-tasks`, taskId: batch.taskId,
      attemptId: batch.attemptId })), 'switch');
    return { setup: true };
  }
  if (mode === 'crash') {
    const controller = createReleaseController({ scene: fixtureScene,
      async runChild({ phase, intentSha256, owner }) {
        assert.equal(phase, 'switch');
        recordAttemptEvent({ root: `${batch.projectRoot}/release-tasks`, taskId: batch.taskId, attemptId: batch.attemptId,
          owner, name: 'switch_boundary', value: boundaryRecord(batch, config.boundary, 'intent'), now: Date.now() });
        writeJson(path.join(config.stage, `fixture-side-effect-${config.boundary}.json`),
          { boundary: config.boundary, source: batch.artifacts.main.source, count: 1 });
        if (config.variant === 'complete-missing') writeJson(path.join(config.stage, 'switch-complete.json'),
          { schema: 'fixture-switch-complete.v1', runId: batch.runId });
        if (config.variant !== 'preserved') process.kill(process.pid, 'SIGKILL');
        return fixtureChild(phase, intentSha256, { schema: 'fixture-switch-result.v1', boundary: config.boundary });
      }, postcheck() { process.kill(process.pid, 'SIGKILL'); } });
    await controller.run(config.batchFile, config.windowFile, 'switch', config.approvalFile);
    throw new Error('Crash fixture unexpectedly returned');
  }
  if (mode === 'resume') {
    const controller = createReleaseController({ scene: fixtureScene,
      async runChild({ phase, intentSha256 }) {
        assert.equal(phase, 'recovery');
        writeJson(path.join(config.stage, 'fixture-recovery.json'), { source: batch.artifacts.guard.source, count: 1 });
        writeJson(path.join(config.stage, 'guard-recovery-complete.json'), { schema: 'fixture-recovery-complete.v1', runId: batch.runId });
        return fixtureChild(phase, intentSha256);
      }, postcheck() { return { fixtureOnly: true }; } });
    return controller.resume(config.batchFile, config.windowFile);
  }
  throw new Error(`Unknown fixture worker mode: ${mode}`);
}

function runWorker(mode, configFile, expectedSignal = null) {
  const result = spawnSync(process.execPath, [self, '--fixture-worker', mode, configFile], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' } });
  if (expectedSignal) assert.equal(result.signal, expectedSignal, result.stderr || result.stdout);
  else { assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr || result.stdout); }
  return result;
}

function journal(config) {
  const batch = JSON.parse(fs.readFileSync(config.batchFile));
  return readAttempt({ root: `${batch.projectRoot}/release-tasks`, taskId: batch.taskId, attemptId: batch.attemptId });
}

function assertBoundaryAndSideEffect(config, state) {
  const windowBytes = fs.readFileSync(config.windowFile), expectedWindowSha256 = digest(windowBytes);
  assert.equal(state.header.window.file, path.join(config.stage, 'window-evidence', `${expectedWindowSha256}.json`));
  assert.equal(state.header.window.sha256, expectedWindowSha256);
  assert.deepEqual(fs.readFileSync(state.header.window.file), windowBytes);
  const boundaries = state.events.filter(item => item.value.kind === 'observation' && item.value.name === 'switch_boundary'
    && item.value.value.name === config.boundary && item.value.value.edge === 'intent');
  assert.equal(boundaries.length, 1); assert.equal(boundaries[0].value.value.schema, 'sd2-release-boundary.v1');
  assert.equal(boundaries[0].value.value.manifestSha256, digest(fs.readFileSync(JSON.parse(fs.readFileSync(config.batchFile)).manifestFile)));
  const effect = JSON.parse(fs.readFileSync(path.join(config.stage, `fixture-side-effect-${config.boundary}.json`)));
  assert.deepEqual(effect, { boundary: config.boundary, source: '1'.repeat(40), count: 1 });
}

function assertPreserved(config) {
  const state = journal(config), exits = state.events.filter(item => item.value.kind === 'observation'
    && item.value.name === 'phase_child_exit' && item.value.value.phase === 'switch');
  assertBoundaryAndSideEffect(config, state);
  assert.equal(exits.length, 1); assert.equal(exits[0].value.value.child.status, 0);
  assert.equal(state.derivedState.lastPhase.phase, 'switch'); assert.equal(state.derivedState.lastPhase.outcome, 'succeeded');
  assert.equal(state.derivedState.status, 'running'); assert.equal(nextReleasePhase(state), 'proof');
  assert.equal(fs.existsSync(path.join(config.stage, 'fixture-recovery.json')), false);
  assert.deepEqual(state.header.artifacts.main.source, '1'.repeat(40));
}

function assertRecovered(config) {
  const state = journal(config), switchExits = state.events.filter(item => item.value.kind === 'observation'
    && item.value.name === 'phase_child_exit' && item.value.value.phase === 'switch');
  assertBoundaryAndSideEffect(config, state);
  assert.equal(switchExits.length, 0, 'A missing original child exit must never be invented as status 0');
  assert.equal(state.derivedState.status, 'rolled_back');
  assert.equal(JSON.parse(fs.readFileSync(path.join(config.stage, 'fixture-recovery.json'))).count, 1);
  assert.deepEqual(state.header.artifacts.guard.source, '2'.repeat(40));
}

async function scenarioControllerMatrix() {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const root = fs.mkdtempSync('/data/sd2-release-entry-engineering-'); fs.chmodSync(root, 0o700); const checks = [];
  try {
    for (const boundary of ['preparation', 'drain', 'publish', 'health', 'reopen']) {
      for (const variant of ['missing', 'preserved']) {
        const config = fixtureFiles(root, boundary, variant), configFile = writeJson(path.join(config.stage, 'fixture.json'), config);
        runWorker('setup', configFile); runWorker('crash', configFile, 'SIGKILL'); runWorker('resume', configFile);
        variant === 'preserved' ? assertPreserved(config) : assertRecovered(config); checks.push(`C_${boundary}_${variant}`);
      }
    }
    const complete = fixtureFiles(root, 'reopen', 'complete-missing'), completeFile = writeJson(path.join(complete.stage, 'fixture.json'), complete);
    runWorker('setup', completeFile); runWorker('crash', completeFile, 'SIGKILL');
    const refused = spawnSync(process.execPath, [self, '--fixture-worker', 'resume', completeFile], { encoding: 'utf8',
      env: { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' } });
    assert.notEqual(refused.status, 0); assert.equal(journal(complete).events.some(item => item.value.kind === 'observation'
      && item.value.name === 'phase_child_exit' && item.value.value.phase === 'switch'), false);
    assertBoundaryAndSideEffect(complete, journal(complete));
    assert.equal(fs.existsSync(path.join(complete.stage, 'fixture-recovery.json')), false);
    assert.equal(nextReleasePhase(journal(complete)), 'switch'); checks.push('C_complete_marker_without_child_exit_refused');
    const ownership = fixtureFiles(root, 'preparation', 'ownership'), ownershipFile = writeJson(path.join(ownership.stage, 'fixture.json'), ownership);
    runWorker('setup', ownershipFile);
    for (const status of ['alive', 'unknown']) {
      const controller = createReleaseController({ inspectOwner: () => status, scene: fixtureScene });
      await assert.rejects(controller.resume(ownership.batchFile, ownership.windowFile)); checks.push(`C_${status}_owner_refused`);
    }
    return checks;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function scenarioReuseNoBuild(root) {
  const runId = randomUUID(), sourceRun = randomUUID(), stage = path.join(root, 'reuse-stage'), originalStage = path.join(root, 'original-stage');
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 }); fs.mkdirSync(originalStage, { recursive: true, mode: 0o700 });
  const engineHash = digest('reuse-engine'), engine = { schema: 'sd2-release-engine.v1', version: ENGINE_VERSION,
    controllerSetSha256: engineHash, root: `${root}/release-engines/${ENGINE_VERSION}-${engineHash}` };
  const batch = { schema: 'sd2-release-batch.v1', project: 'video-api-debugger', projectRoot: root, taskId: randomUUID(), attemptId: runId,
    runId, engine, contextFile: path.join(stage, 'context.json'), seedFile: path.join(stage, 'seed.json'), manifestFile: path.join(stage, 'manifest.json'),
    artifacts: { main: artifact('main', '3'.repeat(40)), guard: artifact('guard', '4'.repeat(40)) }, phases: RELEASE_PHASES };
  const reuseBuilds = { schema: 'sd2-original-build-reuse-input.v1', sourceRun };
  for (const kind of ['main', 'guard']) {
    const originalBuild = { schema: 'rate-impl2-candidate-build.v1', label: kind, source: batch.artifacts[kind].source,
      version: batch.artifacts[kind].version, build: batch.artifacts[kind].build, runId: sourceRun,
      sourceManifestSha256: batch.artifacts[kind].sourceManifestSha256, compiledTreeSha256: batch.artifacts[kind].compiledTreeSha256,
      startedAt: 1, finishedAt: 2, exitCode: 0, gateReceipt: `${kind}-gate`, verifiedSourceAndGates: true };
    const immutableFile = writeJson(path.join(originalStage, `${kind}-immutable-success.json`),
      { schema: 'sd2-immutable-successful-build.v1', kind, sourceRun, originalReceipt: originalBuild });
    reuseBuilds[kind] = { file: immutableFile, sha256: digest(fs.readFileSync(immutableFile)) };
    batch.artifacts[kind].immutableSuccessSha256 = reuseBuilds[kind].sha256;
    const candidate = { schema: 'sd2-candidate-build-reuse.v1', label: kind, runId, source: originalBuild.source,
      version: originalBuild.version, build: originalBuild.build, startedAt: originalBuild.startedAt, finishedAt: originalBuild.finishedAt,
      gateReceipt: originalBuild.gateReceipt, exitCode: 0, verifiedSourceAndGates: true, engine, originalBuild,
      originalSuccessFile: immutableFile, originalSuccessSha256: reuseBuilds[kind].sha256,
      sourceManifestSha256: originalBuild.sourceManifestSha256, compiledTreeSha256: originalBuild.compiledTreeSha256,
      originalTimesChanged: false, newCompilationClaimed: false, reuseInputsFullyVerified: true };
    writeJson(path.join(stage, `${kind}-candidate-reuse.json`), candidate);
  }
  writeJson(batch.manifestFile, { schema: 'rate-impl2-release.v1', runId, stage, engine, operation: operation(batch), reuseBuilds });
  const prepared = Object.fromEntries(['main', 'guard'].map(kind =>
    [kind, JSON.parse(fs.readFileSync(path.join(stage, `${kind}-candidate-reuse.json`)))]));
  const prepareReceipt = value => ({ child: { status: 0, signal: null, error: null }, stdout: JSON.stringify(value) + '\n' });
  postcheckReleasePhase({ batch, phase: 'prepare', receipt: prepareReceipt(prepared) });
  assert.throws(() => postcheckReleasePhase({ batch, phase: 'prepare', receipt: prepareReceipt({ main: prepared.main }) }));
  const changed = structuredClone(prepared); changed.main.build = 'different-build';
  assert.throws(() => postcheckReleasePhase({ batch, phase: 'prepare', receipt: prepareReceipt(changed) }));
  for (const kind of ['guard', 'main']) {
    const value = JSON.parse(fs.readFileSync(path.join(stage, `${kind}-candidate-reuse.json`))), child = { status: 0, signal: null, error: null };
    postcheckReleasePhase({ batch, phase: `${kind}-build`, receipt: { child, stdout: JSON.stringify(value) + '\n' } });
    assert.equal(fs.existsSync(path.join(stage, `${kind}-build.json`)), false);
    assert.equal(fs.existsSync(path.join(stage, `${kind}-immutable-success.json`)), false);
    assert.equal(fs.existsSync(path.join(stage, `${kind}-prepared.json`)), false);
  }
  return 'reuse_prepare_and_build_reference_original_immutable_without_new_build_or_prepared_markers';
}

function scenarioE() {
  assert.deepEqual(releaseChildAction('guard-build'), { phase: 'guard-build', kind: 'guard' });
  assert.equal(nextReleasePhase(loaded([{ kind: 'phase_result', phase: 'capture', outcome: 'succeeded' },
    { kind: 'phase_result', phase: 'preflight', outcome: 'succeeded' }])), 'admission');
  assert.deepEqual(RELEASE_PHASES, ['capture', 'preflight', 'admission', 'adopt', 'prepare', 'guard-build', 'main-build', 'verify', 'arm', 'switch', 'proof']);
  assert.equal(NATIVE_FIXTURES.length, 19); assert.equal(validateNativeFixture('release-entry-engineering.mjs'), 'release-entry-engineering.mjs');
  assert.throws(() => validateNativeFixture('../release-entry-engineering.mjs')); assert.throws(() => validateNativeFixture('release.mjs'));
  return 'E_native_allowlist_and_phase_order_are_closed';
}

function scenarioPackageInput() {
  const value = { schema: 'sd2-release-package-request.v1', repoRoot: '/fixture/repo', mainSource: '5'.repeat(40),
    guardSource: '6'.repeat(40), outputRoot: '/fixture/output' };
  assert.deepEqual(validatePackageRequest(structuredClone(value)), value);
  assert.throws(() => validatePackageRequest({ ...value, publishRoot: '/data/video-api-debugger' }));
  return 'package_request_rejects_remote_publish_authority_and_unknown_fields';
}

function scenarioPrepareTailContract() {
  const request = { schema: 'sd2-release-prepare-tail-continuation.v1', terminalEventSha256: digest('original-terminal'),
    phaseResultEventSha256: digest('original-prepare-result'), childReceiptSha256: digest('original-child-exit'),
    processorControllerSetSha256: digest('processor'), mainPreparedSha256: digest('original-main-prepared'),
    guardInputSha256: digest('original-guard-input') };
  assert.deepEqual(validatePrepareTailContinuation(structuredClone(request)), request);
  for (const key of Object.keys(request)) {
    const missing = { ...request }; delete missing[key]; assert.throws(() => validatePrepareTailContinuation(missing));
    assert.throws(() => validatePrepareTailContinuation({ ...request, [key]: 'unbound' }));
  }
  assert.throws(() => validatePrepareTailContinuation({ ...request, processorRoot: '/unbound' }));
  const original = Object.fromEntries(['release-entry.mjs', 'candidate.mjs', 'candidate-inputs.mjs',
    'release-entry-engineering.mjs', 'candidate-lifecycle-engineering.mjs', 'release.mjs', 'attempt-state.mjs']
    .map(name => [name, digest('original:' + name)]));
  const processor = { ...original, 'release-entry.mjs': digest('new-entry'), 'candidate.mjs': digest('new-candidate'),
    'candidate-inputs.mjs': digest('new-read-only-input-helper'), 'release-entry-engineering.mjs': digest('new-entry-fixture'),
    'candidate-lifecycle-engineering.mjs': digest('new-tail-fixture') };
  assert.equal(Object.keys(assertPrepareTailControllerDifference(original, processor)).length, 5);
  for (const name of ['release.mjs', 'attempt-state.mjs'])
    assert.throws(() => assertPrepareTailControllerDifference(original, { ...processor, [name]: digest('unauthorized') }));
  assert.throws(() => assertPrepareTailControllerDifference(original, { ...processor, 'new-executor.mjs': HASH }));
  const missing = { ...processor }; delete missing['release.mjs'];
  assert.throws(() => assertPrepareTailControllerDifference(original, missing));
  assert.throws(() => assertPrepareTailControllerDifference(original, original));
  const proof = { schema: 'sd2-release-prepare-tail-proof.v1', engine: { root: '/original-engine' }, processor: { root: '/tail-processor' } };
  assert.equal(assertPrepareTailChildRoute('prepare', '/original-engine', '/tail-processor', proof), true);
  assert.equal(assertPrepareTailChildRoute('guard-build', '/original-engine', '/original-engine', null), false);
  for (const phase of [...RELEASE_PHASES.filter(value => value !== 'prepare'), 'recovery'])
    assert.throws(() => assertPrepareTailChildRoute(phase, '/original-engine', '/tail-processor', proof));
  assert.throws(() => assertPrepareTailChildRoute('prepare', '/original-engine', '/tail-processor', null));
  assert.throws(() => assertPrepareTailChildRoute('prepare', '/wrong-original', '/tail-processor', proof));
  assert.throws(() => assertPrepareTailChildRoute('prepare', '/original-engine', '/wrong-processor', proof));
  return 'prepare_tail_has_exact_failure_hash_inputs_five_file_processor_boundary_and_no_later_phase_authority';
}

function scenarioGuardBuildTailContract() {
  const request = { schema: 'sd2-release-guard-build-tail-continuation.v1', observedAt: new Date().toISOString() };
  for (const key of ['terminalEventSha256', 'phaseResultEventSha256', 'childReceiptSha256', 'processorControllerSetSha256',
    'mainPreparedSha256', 'guardPreparedSha256', 'buildCommandSha256', 'buildLogSha256', 'packageJsonSha256',
    'buildIdSha256', 'observedCompiledTreeSha256', 'imageGateReceiptSha256', 'pricingGateReceiptSha256']) request[key] = digest(key);
  assert.deepEqual(validateGuardBuildTailContinuation(structuredClone(request)), request);
  for (const key of Object.keys(request)) {
    const missing = { ...request }; delete missing[key]; assert.throws(() => validateGuardBuildTailContinuation(missing));
    assert.throws(() => validateGuardBuildTailContinuation({ ...request, [key]: 'unbound' }));
  }
  assert.throws(() => validateGuardBuildTailContinuation({ ...request, compiledTreeSha256: HASH }));
  assert.throws(() => validatePrepareTailContinuation(request));
  const names = ['release-entry.mjs', 'attempt-state.mjs', 'release.mjs', 'release-entry-engineering.mjs', 'attempt-state-engineering.mjs',
    'candidate.mjs', 'candidate-evidence.mjs', 'candidate-reuse.mjs', 'candidate-inputs.mjs', 'candidate-lifecycle-engineering.mjs', 'switch.mjs',
    'hd-compiled-cache.mjs', 'hd-storage-preflight.mjs', 'hd-closed-cache-engineering.mjs', 'hd-storage-preflight-engineering.mjs',
    'engine-context.mjs', 'release-contract.mjs'];
  const original = Object.fromEntries(names.map(name => [name, digest('old:' + name)]));
  const processor = Object.fromEntries(names.map(name => [name, name.startsWith('engine-context') || name.startsWith('release-contract')
    ? original[name] : digest('new:' + name)]));
  assert.equal(Object.keys(assertGuardBuildTailControllerDifference(original, processor)).length, 15);
  for (const name of ['engine-context.mjs', 'release-contract.mjs'])
    assert.throws(() => assertGuardBuildTailControllerDifference(original, { ...processor, [name]: HASH }));
  assert.throws(() => assertGuardBuildTailControllerDifference(original, { ...processor, 'new-compiler.mjs': HASH }));
  assert.throws(() => assertGuardBuildTailControllerDifference(original, { ...processor, 'candidate.mjs': original['candidate.mjs'] }));
  const omitted = { ...processor }; delete omitted['engine-context.mjs'];
  assert.throws(() => assertGuardBuildTailControllerDifference(original, omitted));
  assertGuardBuildTailPhase('guard-build', { status: 'pending' });
  for (const phase of GUARD_BUILD_TAIL_PHASES.filter(value => value !== 'guard-build')) {
    assertGuardBuildTailPhase(phase, { status: 'completed' });
    assert.throws(() => assertGuardBuildTailPhase(phase, { status: 'pending' }));
  }
  for (const phase of ['capture', 'preflight', 'admission', 'adopt', 'prepare', 'rollback'])
    assert.throws(() => assertGuardBuildTailPhase(phase, { status: 'completed' }));
  assert.throws(() => assertGuardBuildTailPhase('guard-build', { status: 'completed' }));
  // Exercise the actual pure action selector without importing/configuring a
  // production release context or executing any native release consumer.
  const releaseSource = fs.readFileSync(new URL('./release.mjs', import.meta.url), 'utf8');
  const marker = 'export function guardBuildTailReleaseAction(';
  assert.equal(releaseSource.split(marker).length, 2);
  const start = releaseSource.indexOf(marker), end = releaseSource.indexOf('\n}', start) + 2;
  assert.ok(end > start);
  const action = vm.runInNewContext('(' + releaseSource.slice(start, end).replace(/^export /, '') + ')');
  for (const [phase, mode, kind] of [['main-build', 'build', 'main'], ['verify', 'verify', 'guard'], ['verify', 'verify', 'main'],
    ['arm', 'arm', undefined], ['switch', 'switch', undefined], ['proof', 'proof', undefined], ['proof', 'public', 'main'],
    ['recovery', 'recovery', undefined]]) assert.equal(action(phase, mode, kind), true);
  for (const [phase, mode, kind] of [['guard-build', 'build', 'guard'], ['main-build', 'build', 'guard'], ['verify', 'build', 'main'],
    ['proof', 'public', 'guard'], ['prepare', 'prepare', 'guard'], ['switch', 'rollback', undefined]]) assert.equal(action(phase, mode, kind), false);
  return 'guard_tail_binds_exact_original_and_observed_inputs_then_uses_only_reviewed_processor_readers_without_guard_recompile';
}

function scenarioGuardBuildTailRetry() {
  const request = { schema: 'sd2-release-guard-build-tail-retry.v1', originalContinuationSha256: digest('original-proof'),
    terminalEventSha256: digest('postcheck-terminal'), phaseResultEventSha256: digest('postcheck-result'),
    childReceiptSha256: digest('postcheck-child'), processorControllerSetSha256: digest('retry-processor'),
    hdCompiledCacheSha256: digest('successful-original-HDv2'), observedAt: new Date().toISOString() };
  assert.deepEqual(validateGuardBuildTailRetry(structuredClone(request)), request);
  for (const key of Object.keys(request)) {
    const missing = { ...request }; delete missing[key]; assert.throws(() => validateGuardBuildTailRetry(missing));
    assert.throws(() => validateGuardBuildTailRetry({ ...request, [key]: 'unbound' }));
  }
  assert.throws(() => validateGuardBuildTailRetry({ ...request, retryCount: 2 }));
  assert.throws(() => validateGuardBuildTailContinuation(request));
  const failure = { error: { schema: 'sd2-release-error.v1', category: 'internal_failure', code: 'unclassified_internal_failure',
    object: { kind: 'release_operation', id: 'child' },
    reason: 'An unclassified release-engine failure occurred; the original exception remains in the private attempt evidence.',
    nextStep: 'Stop dependent or side-effecting work and inspect the preserved attempt evidence.', retryable: false, stop: true },
    cause: ['AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:', '+ actual - expected ... Lines skipped', '',
      '  [', "    'scripts/upload-client-recovery-engineering.ts',", '...', "    'src/lib/assets/upload-log.ts',",
      "    'src/lib/assets/verified-upload.ts',", "+   'src/lib/hooks/useWorkspace.ts',", "    'src/lib/http/file-upload.ts',",
      "    'src/lib/http/upload-session.ts'", '  ]'].join('\n') };
  const child = { schema: 'sd2-release-phase-child.v1', phase: 'guard-build', child: { status: 1, signal: null, error: null },
    stderr: JSON.stringify(failure) + '\n' };
  assertGuardBuildTailRetryFailure(child);
  const withFailure = value => ({ ...child, stderr: JSON.stringify(value) + '\n' });
  for (const value of [{ ...child, stderr: 'ERR_ASSERTION: src/lib/hooks/useWorkspace.ts' },
    withFailure({ ...failure, cause: 'Error: ERR_ASSERTION mentioning src/lib/hooks/useWorkspace.ts' }),
    ...["+   'src/lib/hooks/another-source.ts',", "-   'src/lib/hooks/another-source.ts',"].map(line =>
      withFailure({ ...failure, cause: failure.cause.replace('  ]', line + '\n  ]') })),
    withFailure({ ...failure, error: { ...failure.error, category: 'input_permanent' } }),
    withFailure({ ...failure, error: { ...failure.error, schema: 'another-error.v1' } }),
    withFailure({ ...failure, error: { ...failure.error, code: 'another_internal_failure' } }),
    withFailure({ ...failure, error: { ...failure.error, object: { kind: 'release_operation', id: 'controller' } } }),
    withFailure({ ...failure, error: { ...failure.error, stop: false } }),
    withFailure({ ...failure, unrelated: true }), { ...child, stderr: child.stderr + child.stderr },
    { ...child, schema: 'another-child.v1' }, { ...child, phase: 'main-build' }, { ...child, child: { ...child.child, status: 0 } },
    { ...child, child: { ...child.child, signal: 'SIGTERM' } }]) assert.throws(() => assertGuardBuildTailRetryFailure(value));
  const names = ['release-entry.mjs', 'attempt-state.mjs', 'release.mjs', 'candidate.mjs', 'candidate-evidence.mjs',
    'candidate-inputs.mjs', 'candidate-lifecycle-engineering.mjs', 'hd-compiled-cache.mjs', 'hd-storage-preflight.mjs', 'engine-context.mjs'];
  const original = Object.fromEntries(names.map(name => [name, digest('old:' + name)]));
  const processor = { ...original };
  for (const name of names.filter(name => !name.startsWith('hd-') && name !== 'engine-context.mjs')) processor[name] = digest('retry:' + name);
  assert.equal(Object.keys(assertGuardBuildTailRetryControllerDifference(original, processor)).length, 7);
  for (const name of ['hd-compiled-cache.mjs', 'hd-storage-preflight.mjs', 'engine-context.mjs'])
    assert.throws(() => assertGuardBuildTailRetryControllerDifference(original, { ...processor, [name]: HASH }));
  assert.throws(() => assertGuardBuildTailRetryControllerDifference(original, { ...processor, 'extra-executor.mjs': HASH }));
  return 'single_guard_postcheck_retry_keeps_original_proof_and_successful_HD_implementation_while_refusing_unrelated_failures';
}

function scenarioReaderSuccessor() {
  const request = { schema: 'sd2-release-reader-successor.v1', predecessorControllerSetSha256: digest('cf98-predecessor'),
    originalContinuationSha256: digest('retained-guard-tail'), retryProofSha256: digest('completed-single-retry'),
    eventHeadSha256: digest('main-success-capsule-head'), processorControllerSetSha256: digest('successor-readers'),
    observedAt: new Date().toISOString() };
  assert.deepEqual(validateReaderSuccessor(structuredClone(request)), request);
  for (const key of Object.keys(request)) {
    const missing = { ...request }; delete missing[key]; assert.throws(() => validateReaderSuccessor(missing));
    assert.throws(() => validateReaderSuccessor({ ...request, [key]: 'unbound' }));
  }
  assert.throws(() => validateReaderSuccessor({ ...request, processorControllerSetSha256: request.predecessorControllerSetSha256 }));
  assert.throws(() => validateReaderSuccessor({ ...request, failureReceiptSha256: HASH }));
  const names = ['release-entry.mjs', 'candidate-evidence.mjs', 'release.mjs', 'candidate.mjs', 'candidate-inputs.mjs',
    'cutover-driver.mjs', 'cutover-safety.mjs', 'release-entry-engineering.mjs', 'candidate-lifecycle-engineering.mjs',
    'cutover-driver-engineering.mjs', 'cutover-safety-engineering.mjs', 'hd-release-safety-engineering.mjs', 'attempt-state.mjs', 'switch.mjs',
    'guard-recovery.mjs', 'hd-compiled-cache.mjs', 'hd-storage-preflight.mjs', 'hd-closed-cache-engineering.mjs',
    'hd-storage-preflight-engineering.mjs', 'common.mjs', 'candidate-reuse.mjs'];
  const predecessor = Object.fromEntries(names.map(name => [name, digest('predecessor:' + name)]));
  const processor = { ...predecessor };
  for (const name of names.slice(0, 12)) processor[name] = digest('reader-successor:' + name);
  assert.equal(Object.keys(assertReaderSuccessorControllerDifference(predecessor, processor)).length, 12);
  for (const name of names.slice(12))
    assert.throws(() => assertReaderSuccessorControllerDifference(predecessor, { ...processor, [name]: HASH }));
  assert.throws(() => assertReaderSuccessorControllerDifference(predecessor, { ...processor, 'new-runtime.mjs': HASH }));
  assert.throws(() => assertReaderSuccessorControllerDifference(predecessor, predecessor));
  for (const phase of READER_SUCCESSOR_PHASES) assertReaderSuccessorPhase(phase);
  for (const phase of RELEASE_PHASES.filter(value => !READER_SUCCESSOR_PHASES.includes(value)))
    assert.throws(() => assertReaderSuccessorPhase(phase));
  const events = RELEASE_PHASES.slice(0, RELEASE_PHASES.indexOf('verify')).map(phase => ({ value: {
    kind: 'phase_result', phase, outcome: 'succeeded', child: { status: 0, signal: null, error: null } }, sha256: digest(phase) }));
  events.push({ value: { kind: 'observation', name: 'artifact_capsule' }, sha256: request.eventHeadSha256 });
  const ready = { events, derivedState: { status: 'running', activePhase: null, lastEventSha256: request.eventHeadSha256,
    lastPhase: { phase: 'main-build', outcome: 'succeeded' }, guardBuildTail: { proofSha256: request.originalContinuationSha256 },
    guardBuildTailRetry: { proofSha256: request.retryProofSha256, status: 'completed',
      processorControllerSetSha256: request.predecessorControllerSetSha256 } } };
  const before = { facts: { effectsStarted: false, switchComplete: false, files: {} } };
  assertReaderSuccessorAdmission(ready, request, before);
  const verified = structuredClone(ready), verifiedRequest = { ...request, eventHeadSha256: digest('completed-verify-head') };
  verified.events.push({ value: { kind: 'phase_intent', phase: 'verify' }, sha256: digest('verify-intent') },
    { value: { kind: 'phase_result', phase: 'verify', outcome: 'succeeded', child: { status: 0, signal: null, error: null } },
      sha256: verifiedRequest.eventHeadSha256 });
  verified.derivedState.lastPhase = { phase: 'verify', outcome: 'succeeded' };
  verified.derivedState.lastEventSha256 = verifiedRequest.eventHeadSha256;
  assertReaderSuccessorAdmission(verified, verifiedRequest, before);
  const armed = structuredClone(verified); armed.events.push({ value: { kind: 'phase_intent', phase: 'arm' } });
  assert.throws(() => assertReaderSuccessorAdmission(armed, verifiedRequest, before));
  const altered = change => { const value = structuredClone(ready); change(value); return value; };
  for (const value of [
    altered(value => { value.derivedState.status = 'failed'; }),
    altered(value => { value.derivedState.activePhase = { phase: 'main-build', intentSha256: HASH }; }),
    altered(value => { value.derivedState.lastPhase.outcome = 'failed'; }),
    altered(value => { value.derivedState.lastEventSha256 = HASH; }),
    altered(value => { value.derivedState.guardBuildTailRetry.processorControllerSetSha256 = HASH; }),
    altered(value => { value.derivedState.guardBuildTailRetry.status = 'pending'; }),
    altered(value => { value.events = value.events.filter(item => item.value.phase !== 'main-build'); }),
    altered(value => { value.events.push({ value: { kind: 'phase_intent', phase: 'verify' } }); }),
    altered(value => { value.events.push({ value: { kind: 'observation', name: 'reader_successor' } }); }),
    altered(value => { value.events.push({ value: { kind: 'observation', name: 'candidate_observation' } }); }),
  ]) assert.throws(() => assertReaderSuccessorAdmission(value, request, before));
  for (const facts of [{ ...before.facts, effectsStarted: true }, { ...before.facts, switchComplete: true },
    { ...before.facts, files: { 'fixed-guard-recovery.json': { sha256: HASH } } },
    { ...before.facts, files: { 'switch-before.json': { sha256: HASH } } }])
    assert.throws(() => assertReaderSuccessorAdmission(ready, request, { facts }));
  return 'reader_successor_requires_both_original_successes_once_and_cannot_build_change_HD_or_invent_failed_continuation';
}

function scenarioArmPairRepair() {
  const request = { schema: 'sd2-release-arm-pair-repair.v1',
    ...Object.fromEntries(['terminalEventSha256', 'phaseResultEventSha256', 'readerProofSha256', 'candidateObservationProofSha256']
      .map(key => [key, ARM_PAIR_REPAIR_ORIGIN[key]])), childReceiptSha256: digest('original-arm-child'),
    processorControllerSetSha256: digest('arm-pair-repair-processor'), approvalFile: '/fixture/stage/hd-release-safety-approval-arm-pair-r01.json',
    approvalSha256: digest('new-arm-approval'), windowSha256: digest('same-fresh-window'), observedAt: new Date().toISOString() };
  assert.deepEqual(validateArmPairRepair(structuredClone(request)), request);
  for (const key of Object.keys(request)) {
    const missing = { ...request }; delete missing[key]; assert.throws(() => validateArmPairRepair(missing));
    assert.throws(() => validateArmPairRepair({ ...request, [key]: 'unbound' }));
  }
  assert.throws(() => validateArmPairRepair({ ...request, continuation: {} }));
  for (const key of ['terminalEventSha256', 'phaseResultEventSha256', 'readerProofSha256', 'candidateObservationProofSha256'])
    assert.throws(() => validateArmPairRepair({ ...request, [key]: digest('different-' + key) }));
  const error = { schema: 'sd2-release-error.v1', category: 'internal_failure', code: 'unclassified_internal_failure',
    object: { kind: 'release_operation', id: 'child' },
    reason: 'An unclassified release-engine failure occurred; the original exception remains in the private attempt evidence.',
    nextStep: 'Stop dependent or side-effecting work and inspect the preserved attempt evidence.', retryable: false, stop: true };
  const cause = "AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:\n\n  assert.ok(['rate-impl2-candidate-build.v1', 'sd2-candidate-build-reuse.v1'].includes(proof?.schema))\n";
  const child = { schema: 'sd2-release-phase-child.v1', phase: 'arm', child: { status: 1, signal: null, error: null },
    stderr: JSON.stringify({ error, cause }) + '\n' };
  assertArmPairRepairFailure(child);
  for (const value of [{ ...child, phase: 'verify' }, { ...child, child: { status: 0, signal: null, error: null } },
    { ...child, stderr: JSON.stringify({ error, cause: cause + 'another failure' }) },
    { ...child, stderr: JSON.stringify({ error: { ...error, category: 'input_permanent' }, cause }) },
    { ...child, stderr: child.stderr + child.stderr },
    { ...child, stderr: JSON.stringify({ error, cause: cause.replace('proof?.schema', 'anotherProof?.schema') }) }])
    assert.throws(() => assertArmPairRepairFailure(value));
  const allowed = ['release-entry.mjs', 'candidate-evidence.mjs', 'release.mjs', 'pricing-start-pair.mjs', 'switch.mjs',
    'cutover-driver.mjs', 'guard-recovery.mjs', 'release-entry-engineering.mjs', 'candidate-lifecycle-engineering.mjs', 'cutover-driver-engineering.mjs'];
  const retained = ['attempt-state.mjs', 'common.mjs', 'candidate.mjs', 'candidate-inputs.mjs', 'candidate-reuse.mjs',
    'hd-compiled-cache.mjs', 'hd-storage-preflight.mjs', 'hd-closed-cache-engineering.mjs', 'writer-network-fence.mjs', 'empty-writer-lock.mjs'];
  const predecessor = Object.fromEntries([...allowed, ...retained].map(name => [name, digest('cdc7:' + name)]));
  const processor = { ...predecessor, ...Object.fromEntries(allowed.map(name => [name, digest('repair:' + name)])) };
  assert.equal(Object.keys(assertArmPairRepairControllerDifference(predecessor, processor)).length, allowed.length);
  for (const name of retained) assert.throws(() => assertArmPairRepairControllerDifference(predecessor, { ...processor, [name]: HASH }));
  assert.throws(() => assertArmPairRepairControllerDifference(predecessor, { ...processor, 'another-executor.mjs': HASH }));
  assert.throws(() => assertArmPairRepairControllerDifference(predecessor, predecessor));
  const events = RELEASE_PHASES.slice(0, RELEASE_PHASES.indexOf('arm')).map(phase => ({ value: { kind: 'phase_result', phase, outcome: 'succeeded' } }));
  const failed = { events, derivedState: { status: 'failed', activePhase: null,
    lastPhase: { phase: 'arm', outcome: 'failed', resultSha256: request.phaseResultEventSha256 },
    terminal: { eventSha256: request.terminalEventSha256 }, lastEventSha256: request.terminalEventSha256 } };
  const before = { facts: { effectsStarted: false, switchComplete: false, files: {} } };
  assertArmPairRepairAdmission(failed, request, before);
  for (const edit of [value => { value.derivedState.status = 'running'; }, value => { value.derivedState.activePhase = { phase: 'arm' }; },
    value => { value.derivedState.lastPhase.phase = 'verify'; }, value => { value.derivedState.lastEventSha256 = HASH; },
    value => { value.events.push({ value: { kind: 'observation', name: 'arm_pair_repair' } }); },
    value => { value.events.push({ value: { kind: 'phase_intent', phase: 'switch' } }); }]) {
    const value = structuredClone(failed); edit(value); assert.throws(() => assertArmPairRepairAdmission(value, request, before));
  }
  for (const name of ['arm-before.json', 'fixed-guard-recovery.json', 'switch-before.json'])
    assert.throws(() => assertArmPairRepairAdmission(failed, request, { facts: { ...before.facts, files: { [name]: { sha256: HASH } } } }));
  assert.throws(() => assertArmPairRepairAdmission(failed, request, { facts: { ...before.facts, effectsStarted: true } }));
  const root = fs.realpathSync(fs.mkdtempSync('/data/sd2-arm-pair-parent-engineering-'));
  try {
    const parent = path.join(root, 'attempt'); fs.mkdirSync(parent, { mode: 0o700 });
    const file = writeJson(path.join(parent, 'original-child.json'), { retained: true });
    const original = readTypedFile({ file, category: 'root_control', requireRootParents: true, parentBoundary: root }).snapshot;
    writeJson(path.join(parent, 'new-repair-proof.json'), { appended: true });
    const before = fs.statSync(parent); fs.utimesSync(parent, before.atime, new Date(before.mtimeMs + 1000));
    assert.notEqual(fs.statSync(parent).mtimeMs, original.parents[0].identity.mtimeMs);
    assertTypedFileUnchanged(original);
    fs.chmodSync(parent, 0o770); assert.throws(() => assertTypedFileUnchanged(original)); fs.chmodSync(parent, 0o700);
    assertTypedFileUnchanged(original);
    fs.writeFileSync(file, JSON.stringify({ retained: false }) + '\n');
    assert.throws(() => assertTypedFileUnchanged(original));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  return 'single_exact_failed_arm_pair_repair_preserves_reader_observation_and_refuses_effects_unrelated_causes_and_module_drift';
}

function scenarioArmProcessorRepair() {
  const request = { schema: 'sd2-release-arm-processor-repair.v1',
    ...Object.fromEntries(['terminalEventSha256', 'phaseResultEventSha256', 'armPairRepairProofSha256']
      .map(key => [key, ARM_PROCESSOR_REPAIR_ORIGIN[key]])), childReceiptSha256: digest('trusted-code-child'),
    processorControllerSetSha256: digest('trusted-code-processor'), approvalFile: '/fixture/stage/hd-release-safety-approval-arm-processor-r01.json',
    approvalSha256: digest('processor-approval'), windowSha256: digest('processor-window'), observedAt: new Date().toISOString() };
  assert.deepEqual(validateArmProcessorRepair(structuredClone(request)), request);
  for (const key of Object.keys(request)) {
    const missing = { ...request }; delete missing[key]; assert.throws(() => validateArmProcessorRepair(missing));
    assert.throws(() => validateArmProcessorRepair({ ...request, [key]: 'unbound' }));
  }
  for (const key of ['terminalEventSha256', 'phaseResultEventSha256', 'armPairRepairProofSha256'])
    assert.throws(() => validateArmProcessorRepair({ ...request, [key]: digest('different:' + key) }));
  assert.throws(() => validateArmPairRepair(request)); assert.throws(() => validateArmProcessorRepair({ ...request, retry: 2 }));
  const error = { schema: 'sd2-release-error.v1', category: 'internal_failure', code: 'unclassified_internal_failure',
    object: { kind: 'release_operation', id: 'child' },
    reason: 'An unclassified release-engine failure occurred; the original exception remains in the private attempt evidence.',
    nextStep: 'Stop dependent or side-effecting work and inspect the preserved attempt evidence.', retryable: false, stop: true };
  const cause = "AssertionError [ERR_ASSERTION]: Private release code changed: candidate-evidence.mjs\n+ actual - expected\n\n+ 'fdfd2f1f64e23b6baf165db565dd2dd26a307b2a501db7597d6b33ef575dd468'\n- 'defe51ae9c70099256708e675dd1db27dca204cbb87c96f7e687cc160ccbee71'";
  const child = { schema: 'sd2-release-phase-child.v1', phase: 'arm', child: { status: 1, signal: null, error: null },
    stderr: JSON.stringify({ error, cause }) + '\n' };
  assertArmProcessorRepairFailure(child); assert.throws(() => assertArmPairRepairFailure(child));
  for (const value of [{ ...child, phase: 'switch' }, { ...child, child: { status: 0, signal: null, error: null } },
    { ...child, stderr: JSON.stringify({ error, cause: cause.replace('candidate-evidence.mjs', 'another-module.mjs') }) },
    { ...child, stderr: JSON.stringify({ error, cause: cause.replace('fdfd2f1f', '00000000') }) },
    { ...child, stderr: JSON.stringify({ error: { ...error, stop: false }, cause }) }, { ...child, stderr: child.stderr + child.stderr }])
    assert.throws(() => assertArmProcessorRepairFailure(value));
  const allowed = ['release-entry.mjs', 'candidate-evidence.mjs', 'release.mjs', 'candidate-inputs.mjs',
    'release-entry-engineering.mjs', 'candidate-lifecycle-engineering.mjs'];
  const retained = ['attempt-state.mjs', 'pricing-start-pair.mjs', 'switch.mjs', 'cutover-driver.mjs', 'guard-recovery.mjs',
    'common.mjs', 'candidate.mjs', 'candidate-reuse.mjs', 'hd-compiled-cache.mjs', 'hd-storage-preflight.mjs'];
  const predecessor = Object.fromEntries([...allowed, ...retained].map(name => [name, digest('27d386:' + name)]));
  const processor = { ...predecessor, ...Object.fromEntries(allowed.map(name => [name, digest('processor-repair:' + name)])) };
  assert.equal(Object.keys(assertArmProcessorRepairControllerDifference(predecessor, processor)).length, allowed.length);
  for (const name of retained) assert.throws(() => assertArmProcessorRepairControllerDifference(predecessor, { ...processor, [name]: HASH }));
  assert.throws(() => assertArmProcessorRepairControllerDifference(predecessor, predecessor));
  const events = RELEASE_PHASES.slice(0, RELEASE_PHASES.indexOf('arm')).map(phase => ({ value: { kind: 'phase_result', phase, outcome: 'succeeded' } }));
  events.push({ value: { kind: 'observation', name: 'arm_pair_repair', value: { proofSha256: request.armPairRepairProofSha256 } } });
  const failed = { events, derivedState: { status: 'failed', activePhase: null,
    lastPhase: { phase: 'arm', outcome: 'failed', resultSha256: request.phaseResultEventSha256 },
    terminal: { eventSha256: request.terminalEventSha256 }, lastEventSha256: request.terminalEventSha256 } };
  const before = { facts: { effectsStarted: false, switchComplete: false, files: {} } };
  assertArmProcessorRepairAdmission(failed, request, before);
  for (const edit of [value => { value.derivedState.status = 'running'; }, value => { value.derivedState.activePhase = { phase: 'arm' }; },
    value => { value.events = value.events.filter(item => item.value.name !== 'arm_pair_repair'); },
    value => { value.events.push({ value: { kind: 'observation', name: 'arm_processor_repair' } }); }]) {
    const value = structuredClone(failed); edit(value); assert.throws(() => assertArmProcessorRepairAdmission(value, request, before));
  }
  const repairSha = digest('actual-new-repair'), running = structuredClone(failed); running.derivedState.status = 'running';
  running.events.push({ value: { kind: 'observation', name: 'arm_processor_repair', value: { proofSha256: repairSha } } });
  const runtime = { phase: 'arm', armProcessorRepair: { schema: 'sd2-release-arm-processor-repair-runtime.v1', proofSha256: repairSha },
    candidateObservation: { proof: { expiresAt: 2000 } } };
  assertCandidateReobservationAdmission(running, runtime, 2000);
  assert.throws(() => assertCandidateReobservationAdmission(running, runtime, 1999));
  const active = structuredClone(running); active.derivedState.activePhase = { phase: 'arm' };
  assert.throws(() => assertCandidateReobservationAdmission(active, runtime, 2001));
  const duplicate = structuredClone(running); duplicate.events.push({ value: { kind: 'observation', name: 'candidate_reobservation' } });
  assert.throws(() => assertCandidateReobservationAdmission(duplicate, runtime, 2001));
  assert.throws(() => assertCandidateReobservationAdmission(running, { ...runtime, armProcessorRepair: undefined }, 2001));
  return 'exact_trusted_code_failure_has_one_new_proof_and_only_expired_inactive_candidates_may_be_reobserved_once';
}

function scenarioSwitchAdmissionRepair() {
  const request = { schema: 'sd2-release-switch-admission-repair.v1',
    ...Object.fromEntries(['terminalEventSha256', 'phaseResultEventSha256', 'armProcessorRepairProofSha256']
      .map(key => [key, SWITCH_ADMISSION_REPAIR_ORIGIN[key]])), childReceiptSha256: digest('failed-switch-child'),
    originalFixedGuardSha256: digest('immutable-original-guard'), originalSwitchBeforeSha256: digest('original-switch-before'),
    processorControllerSetSha256: digest('switch-admission-processor'), approvalFile: '/fixture/hd-release-safety-approval-switch-admission-r01.json',
    approvalSha256: digest('new-switch-approval'), windowSha256: digest('new-switch-window'), observedAt: new Date().toISOString() };
  assert.deepEqual(validateSwitchAdmissionRepair(structuredClone(request)), request);
  for (const key of Object.keys(request)) {
    const missing = { ...request }; delete missing[key]; assert.throws(() => validateSwitchAdmissionRepair(missing));
    assert.throws(() => validateSwitchAdmissionRepair({ ...request, [key]: 'unbound' }));
  }
  for (const key of ['terminalEventSha256', 'phaseResultEventSha256', 'armProcessorRepairProofSha256'])
    assert.throws(() => validateSwitchAdmissionRepair({ ...request, [key]: digest('different-' + key) }));
  assert.throws(() => validateSwitchAdmissionRepair({ ...request, resetArm: true }));
  const error = { schema: 'sd2-release-error.v1', category: 'internal_failure', code: 'unclassified_internal_failure',
    object: { kind: 'release_operation', id: 'child' },
    reason: 'An unclassified release-engine failure occurred; the original exception remains in the private attempt evidence.',
    nextStep: 'Stop dependent or side-effecting work and inspect the preserved attempt evidence.', retryable: false, stop: true };
  const cause = "AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:\n\n  assert.ok(Number.isSafeInteger(deadline) && typeof check === 'function' && typeof record === 'function')\n";
  const child = { schema: 'sd2-release-phase-child.v1', phase: 'switch', child: { status: 1, signal: null, error: null }, stderr: JSON.stringify({ error, cause }) + '\n' };
  assertSwitchAdmissionRepairFailure(child); assert.throws(() => assertArmProcessorRepairFailure(child));
  for (const value of [{ ...child, phase: 'arm' }, { ...child, child: { status: 0, signal: null, error: null } },
    { ...child, stderr: JSON.stringify({ error, cause: cause.replace('deadline', 'anotherDeadline') }) },
    { ...child, stderr: JSON.stringify({ error: { ...error, code: 'another_failure' }, cause }) }, { ...child, stderr: child.stderr + child.stderr }])
    assert.throws(() => assertSwitchAdmissionRepairFailure(value));
  const allowed = ['release-entry.mjs', 'candidate-evidence.mjs', 'release.mjs', 'switch.mjs', 'cutover-driver.mjs', 'candidate-inputs.mjs',
    'cutover-safety.mjs', 'guard-recovery.mjs', 'normal-continuation.mjs', 'release-entry-engineering.mjs',
    'candidate-lifecycle-engineering.mjs', 'cutover-driver-engineering.mjs', 'cutover-safety-engineering.mjs'];
  const retained = ['attempt-state.mjs', 'candidate.mjs', 'candidate-reuse.mjs', 'pricing-start-pair.mjs',
    'common.mjs', 'hd-compiled-cache.mjs', 'hd-storage-preflight.mjs', 'writer-network-fence.mjs'];
  const predecessor = Object.fromEntries([...allowed, ...retained].map(name => [name, digest('7d2b:' + name)]));
  const processor = { ...predecessor, ...Object.fromEntries(allowed.map(name => [name, digest('switch-repair:' + name)])) };
  assert.equal(Object.keys(assertSwitchAdmissionControllerDifference(predecessor, processor)).length, 13);
  for (const name of retained) assert.throws(() => assertSwitchAdmissionControllerDifference(predecessor, { ...processor, [name]: HASH }));
  assert.throws(() => assertSwitchAdmissionControllerDifference(predecessor, predecessor));
  const events = RELEASE_PHASES.slice(0, RELEASE_PHASES.indexOf('switch')).map(phase => ({ value: { kind: 'phase_result', phase, outcome: 'succeeded' } }));
  events.push({ value: { kind: 'observation', name: 'arm_processor_repair', value: { proofSha256: request.armProcessorRepairProofSha256 } } });
  const failed = { events, derivedState: { status: 'failed', activePhase: null,
    lastPhase: { phase: 'switch', outcome: 'failed', resultSha256: request.phaseResultEventSha256 },
    terminal: { eventSha256: request.terminalEventSha256 }, lastEventSha256: request.terminalEventSha256 } };
  const before = { facts: { effectsStarted: false, switchComplete: false, files: {
    'fixed-guard-recovery.json': { sha256: request.originalFixedGuardSha256 }, 'switch-before.json': { sha256: request.originalSwitchBeforeSha256 } } } };
  assertSwitchAdmissionRepairAdmission(failed, request, before);
  for (const edit of [value => { value.derivedState.status = 'running'; }, value => { value.derivedState.activePhase = { phase: 'switch' }; },
    value => { value.derivedState.lastPhase.phase = 'arm'; },
    value => { value.events.push({ value: { kind: 'observation', name: 'switch_admission_repair' } }); },
    value => { value.events.push({ value: { kind: 'phase_intent', phase: 'proof' } }); }]) {
    const value = structuredClone(failed); edit(value); assert.throws(() => assertSwitchAdmissionRepairAdmission(value, request, before));
  }
  for (const facts of [{ ...before.facts, effectsStarted: true }, { ...before.facts, switchComplete: true },
    { ...before.facts, files: { ...before.facts.files, 'switch-before.json': { sha256: HASH } } },
    { ...before.facts, files: { ...before.facts.files, 'pricing-pair-published.json': { sha256: HASH } } }])
    assert.throws(() => assertSwitchAdmissionRepairAdmission(failed, request, { facts }));
  for (const round of ['r01', 'r02']) assert.equal(assertSwitchAdmissionApprovalPath('/fixture', `/fixture/hd-release-safety-approval-switch-admission-${round}.json`),
    `/fixture/hd-release-safety-approval-switch-admission-${round}.json`);
  for (const file of ['/fixture/hd-release-safety-approval-switch-admission-r03.json', '/elsewhere/hd-release-safety-approval-switch-admission-r01.json',
    '/fixture/../fixture/hd-release-safety-approval-switch-admission-r02.json', '/fixture/arbitrary.json'])
    assert.throws(() => assertSwitchAdmissionApprovalPath('/fixture', file));
  const switchRepairSha = digest('bound-switch-repair'), previousSha = digest('original-0723'), running = structuredClone(failed);
  running.derivedState.status = 'running';
  running.events.push({ value: { kind: 'observation', name: 'candidate_reobservation', value: { proofSha256: previousSha } } },
    { value: { kind: 'observation', name: 'switch_admission_repair', value: { proofSha256: switchRepairSha } } });
  const runtime = { phase: 'switch', switchAdmissionRepair: { schema: 'sd2-release-switch-admission-repair-runtime.v1',
    proofSha256: switchRepairSha, proof: { request } }, candidateReobservation: {
    schema: 'sd2-release-candidate-observation-runtime.v1', proofSha256: previousSha, proof: { expiresAt: 2000 } } };
  assertCandidateSwitchObservationAdmission(running, runtime, 2000, before);
  assert.throws(() => assertCandidateSwitchObservationAdmission(running, runtime, 1999, before));
  for (const edit of [value => { value.derivedState.activePhase = { phase: 'switch' }; },
    value => { value.derivedState.status = 'failed'; },
    value => { value.events.push({ value: { kind: 'observation', name: 'candidate_switch_observation' } }); },
    value => { value.events = value.events.filter(item => item.value.name !== 'switch_admission_repair'); },
    value => { value.events = value.events.filter(item => item.value.name !== 'candidate_reobservation'); },
    value => { value.events.push({ value: { kind: 'phase_intent', phase: 'proof' } }); }]) {
    const value = structuredClone(running); edit(value);
    assert.throws(() => assertCandidateSwitchObservationAdmission(value, runtime, 2001, before));
  }
  assert.throws(() => assertCandidateSwitchObservationAdmission(running, { ...runtime, phase: 'arm' }, 2001, before));
  assert.throws(() => assertCandidateSwitchObservationAdmission(running, { ...runtime, switchAdmissionRepair: undefined }, 2001, before));
  for (const facts of [{ ...before.facts, effectsStarted: true }, { ...before.facts, switchComplete: true },
    { ...before.facts, files: { ...before.facts.files, 'switch-before.json': { sha256: HASH } } },
    { ...before.facts, files: { ...before.facts.files, 'ingress-503-switch.json': { sha256: HASH } } }])
    assert.throws(() => assertCandidateSwitchObservationAdmission(running, runtime, 2001, { facts }));
  return 'exact_premaintenance_switch_failure_preserves_armed_guard_original_before_and_all_prior_repair_receipts';
}

function scenarioLegacyTemplateBuildAlias() {
  const source = '1a3d1dec878c376b2930c8847f13607aa0d2b35f', releaseRoot = '/data/video-api-debugger/releases/' + source;
  const expected = { root: '/srv/video-api-debugger/app', source, version: '0.63.0', build: '9-SIeKXWbuHjBUnUInI0q' };
  const pinned = { ...expected, sourceManifest: null, archive: null };
  const directory = (file, ino, uid = 1004, gid = 1004) => ({ file, realPath: file, linkTarget: null,
    identity: { dev: 2, ino, uid, gid, mode: 0o040755, nlink: 6, size: 4096, mtimeMs: 1000, ctimeMs: 1000 } });
  const link = (file, realPath, target, ino, uid = 1004, gid = 1004) => ({ file, realPath, linkTarget: target,
    identity: { dev: 2, ino, uid, gid, mode: 0o120777, nlink: 1, size: target.length, mtimeMs: 1000, ctimeMs: 1000 } });
  const snapshot = { alias: link(expected.root + '/.next-prod', releaseRoot + '/.next-prod-candidate',
    '/srv/video-api-debugger/releases/' + source + '/.next-prod-candidate', 100),
    releaseAlias: link('/srv/video-api-debugger/releases', '/data/video-api-debugger/releases', '/data/video-api-debugger/releases', 101, 0, 0),
    releasesDirectory: directory('/data/video-api-debugger/releases', 102, 0, 0),
    releaseDirectory: directory(releaseRoot, 103), buildDirectory: directory(releaseRoot + '/.next-prod-candidate', 104),
    historicalAliasIdentityClaimed: false };
  assert.equal(assertLegacyTemplateBuildAlias(expected, pinned, snapshot, 1004), releaseRoot + '/.next-prod-candidate/BUILD_ID');
  assertLegacyTemplateBuildAlias(expected, pinned, structuredClone(snapshot), 1004, snapshot);
  for (const key of ['root', 'source', 'version', 'build']) {
    assert.throws(() => assertLegacyTemplateBuildAlias({ ...expected, [key]: 'different' }, pinned, snapshot, 1004));
    assert.throws(() => assertLegacyTemplateBuildAlias(expected, { ...pinned, [key]: 'different' }, snapshot, 1004));
  }
  for (const edit of [value => { value.alias.linkTarget = '/srv/video-api-debugger/releases/' + 'f'.repeat(40) + '/.next-prod-candidate'; },
    value => { value.alias.realPath = releaseRoot + '/different-build'; },
    value => { value.alias.identity.mode = 0o040755; }, value => { value.alias.identity.nlink = 2; },
    value => { value.alias.identity.uid = 99; }, value => { value.releaseAlias.linkTarget = '/unapproved/releases'; },
    value => { value.releaseAlias.realPath = '/unapproved/releases'; },
    value => { value.releaseDirectory.realPath = '/unapproved/' + source; },
    value => { value.buildDirectory.identity.mode = 0o040775; }, value => { value.buildDirectory.identity.mode = 0o040757; },
    value => { value.buildDirectory.identity.mode = 0o120777; }, value => { value.historicalAliasIdentityClaimed = true; }]) {
    const value = structuredClone(snapshot); edit(value); assert.throws(() => assertLegacyTemplateBuildAlias(expected, pinned, value, 1004));
  }
  for (const node of ['alias', 'releaseAlias', 'releasesDirectory', 'releaseDirectory', 'buildDirectory'])
    for (const key of ['dev', 'ino', 'gid', 'mtimeMs', 'ctimeMs']) {
      const value = structuredClone(snapshot); value[node].identity[key]++;
      assert.throws(() => assertLegacyTemplateBuildAlias(expected, pinned, value, 1004, snapshot));
    }
  return 'only_exact_legacy_template_build_alias_has_fresh_link_entity_permissions_and_no_historical_alias_claim';
}

function scenarioSwitchTypedRepair() {
  const request = { schema: 'sd2-release-switch-typed-repair.v1',
    ...Object.fromEntries(['terminalEventSha256', 'phaseResultEventSha256', 'switchAdmissionRepairProofSha256',
      'candidateSwitchObservationProofSha256', 'refusalLogSha256'].map(key => [key, SWITCH_TYPED_REPAIR_ORIGIN[key]])),
    childReceiptSha256: digest('original-typed-failure-child'), processorControllerSetSha256: digest('typed-repair-processor'),
    approvalFile: '/fixture/hd-release-safety-approval-switch-typed-r01.json', approvalSha256: digest('new-typed-approval'),
    windowSha256: digest('new-typed-window'), observedAt: new Date().toISOString() };
  assert.deepEqual(validateSwitchTypedRepair(structuredClone(request)), request);
  for (const key of Object.keys(request)) {
    const missing = { ...request }; delete missing[key]; assert.throws(() => validateSwitchTypedRepair(missing));
    assert.throws(() => validateSwitchTypedRepair({ ...request, [key]: 'unbound' }));
  }
  for (const key of ['terminalEventSha256', 'phaseResultEventSha256', 'switchAdmissionRepairProofSha256', 'candidateSwitchObservationProofSha256', 'refusalLogSha256'])
    assert.throws(() => validateSwitchTypedRepair({ ...request, [key]: digest('different:' + key) }));
  assert.throws(() => validateSwitchTypedRepair({ ...request, resetAdmission: true }));
  const error = { schema: 'sd2-release-error.v1', category: 'internal_failure', code: 'unclassified_internal_failure',
    object: { kind: 'release_operation', id: 'child' },
    reason: 'An unclassified release-engine failure occurred; the original exception remains in the private attempt evidence.',
    nextStep: 'Stop dependent or side-effecting work and inspect the preserved attempt evidence.', retryable: false, stop: true };
  const cause = 'AssertionError [ERR_ASSERTION]: Untrusted root input: /srv/video-api-debugger/app/.env';
  const child = { schema: 'sd2-release-phase-child.v1', phase: 'switch', intentSha256: SWITCH_TYPED_REPAIR_ORIGIN.failureIntentSha256,
    child: { status: 1, signal: null, error: null }, stderr: JSON.stringify({ error, cause }) + '\n' };
  assertSwitchTypedRepairFailure(child); assert.throws(() => assertSwitchAdmissionRepairFailure(child));
  for (const value of [{ ...child, phase: 'arm' }, { ...child, intentSha256: HASH }, { ...child, child: { status: 0, signal: null, error: null } },
    { ...child, stderr: JSON.stringify({ error, cause: cause + '\n' }) },
    { ...child, stderr: JSON.stringify({ error, cause: cause.replace('/.env', '/different.env') }) },
    { ...child, stderr: JSON.stringify({ error: { ...error, category: 'another_failure' }, cause }) },
    { ...child, stderr: JSON.stringify({ error: { ...error, stop: false }, cause }) }, { ...child, stderr: child.stderr + child.stderr }])
    assert.throws(() => assertSwitchTypedRepairFailure(value));
  const root = '/data/video-api-debugger/release-engines/1.0.0-' + SWITCH_TYPED_REPAIR_ORIGIN.predecessorControllerSetSha256;
  const stack = cause + '\n' + `    at rootFile (file://${root}/common.mjs:33:10)\n`
    + `    at assertSwitchAdmissionBefore (file://${root}/switch.mjs:869:22)\n`
    + `    at file://${root}/switch.mjs:1255:24\n` + `    at async locked (file://${root}/switch.mjs:800:16)\n`
    + `    at async releaseEntryCli (file://${root}/release-entry.mjs:2785:62)`;
  assertSwitchTypedRepairRefusalLog(Buffer.from(stack));
  for (const value of [stack + '\n', stack.replace(':869:22', ':870:22'), stack.replace('rootFile', 'anotherReader'), stack.replace(root, '/another-processor')])
    assert.throws(() => assertSwitchTypedRepairRefusalLog(Buffer.from(value)));
  const allowed = ['release-entry.mjs', 'candidate-evidence.mjs', 'release.mjs', 'switch.mjs', 'release-entry-engineering.mjs', 'candidate-lifecycle-engineering.mjs'];
  const retained = ['attempt-state.mjs', 'common.mjs', 'typed-files.mjs', 'candidate.mjs', 'candidate-inputs.mjs', 'candidate-reuse.mjs',
    'pricing-start-pair.mjs', 'cutover-driver.mjs', 'cutover-safety.mjs', 'guard-recovery.mjs', 'normal-continuation.mjs',
    'hd-compiled-cache.mjs', 'hd-storage-preflight.mjs'];
  const predecessor = Object.fromEntries([...allowed, ...retained].map(name => [name, digest('cebe:' + name)]));
  const processor = { ...predecessor, ...Object.fromEntries(allowed.map(name => [name, digest('typed-repair:' + name)])) };
  assert.equal(Object.keys(assertSwitchTypedRepairControllerDifference(predecessor, processor)).length, 6);
  for (const name of retained) assert.throws(() => assertSwitchTypedRepairControllerDifference(predecessor, { ...processor, [name]: HASH }));
  assert.throws(() => assertSwitchTypedRepairControllerDifference(predecessor, predecessor));
  const events = RELEASE_PHASES.slice(0, RELEASE_PHASES.indexOf('switch')).map(phase => ({ value: { kind: 'phase_result', phase, outcome: 'succeeded' } }));
  events.push({ value: { kind: 'observation', name: 'switch_admission_repair', value: { proofSha256: request.switchAdmissionRepairProofSha256 } } },
    { value: { kind: 'observation', name: 'candidate_switch_observation', value: { proofSha256: request.candidateSwitchObservationProofSha256 } } });
  const failed = { events, derivedState: { status: 'failed', activePhase: null, lastPhase: {
    phase: 'switch', outcome: 'failed', resultSha256: request.phaseResultEventSha256 }, terminal: { eventSha256: request.terminalEventSha256 },
    lastEventSha256: request.terminalEventSha256 } };
  const originalFixedGuardSha256 = digest('original-fixed-guard'), originalSwitchBeforeSha256 = digest('original-switch-before');
  const runtime = { phase: 'switch', switchAdmissionRepair: { proofSha256: request.switchAdmissionRepairProofSha256,
    proof: { originalFixedGuardSha256, originalSwitchBeforeSha256 } }, candidateSwitchObservation: { proofSha256: request.candidateSwitchObservationProofSha256 } };
  const scene = { facts: { effectsStarted: false, switchComplete: false, files: {
    'fixed-guard-recovery.json': { sha256: originalFixedGuardSha256 }, 'switch-before.json': { sha256: originalSwitchBeforeSha256 } } } };
  assertSwitchTypedRepairAdmission(failed, request, runtime, scene);
  for (const edit of [value => { value.derivedState.status = 'running'; }, value => { value.derivedState.activePhase = { phase: 'switch' }; },
    value => { value.derivedState.lastPhase.phase = 'arm'; }, value => { value.derivedState.terminal.eventSha256 = HASH; },
    value => { value.events = value.events.filter(item => item.value.name !== 'switch_admission_repair'); },
    value => { value.events = value.events.filter(item => item.value.name !== 'candidate_switch_observation'); },
    value => { value.events.push({ value: { kind: 'observation', name: 'switch_typed_repair' } }); },
    value => { value.events.push({ value: { kind: 'phase_intent', phase: 'proof' } }); }]) {
    const value = structuredClone(failed); edit(value); assert.throws(() => assertSwitchTypedRepairAdmission(value, request, runtime, scene));
  }
  assert.throws(() => assertSwitchTypedRepairAdmission(failed, request, { ...runtime, phase: 'arm' }, scene));
  for (const facts of [{ ...scene.facts, effectsStarted: true }, { ...scene.facts, switchComplete: true },
    { ...scene.facts, files: { ...scene.facts.files, 'switch-before.json': { sha256: HASH } } },
    { ...scene.facts, files: { ...scene.facts.files, 'ingress-503-switch.json': { sha256: HASH } } }])
    assert.throws(() => assertSwitchTypedRepairAdmission(failed, request, runtime, { facts }));
  for (const round of ['r01', 'r02']) assertSwitchTypedApprovalPath('/fixture', `/fixture/hd-release-safety-approval-switch-typed-${round}.json`);
  for (const file of ['/fixture/hd-release-safety-approval-switch-typed-r03.json', '/elsewhere/hd-release-safety-approval-switch-typed-r01.json',
    '/fixture/hd-release-safety-approval-switch-admission-r02.json', '/fixture/arbitrary.json'])
    assert.throws(() => assertSwitchTypedApprovalPath('/fixture', file));
  return 'only_exact_typed_env_failure_with_original_ed7_d3ec_stack_and_no_effects_can_continue_switch_once';
}

function scenarioSwitchScanRepair() {
  const request = { schema: 'sd2-release-switch-scan-repair.v1',
    ...Object.fromEntries(['terminalEventSha256', 'phaseResultEventSha256', 'switchTypedRepairProofSha256',
      'candidateSwitchObservationProofSha256', 'refusalLogSha256'].map(key => [key, SWITCH_SCAN_REPAIR_ORIGIN[key]])),
    childReceiptSha256: digest('original-typed-failure-child'), processorControllerSetSha256: digest('typed-repair-processor'),
    approvalFile: '/fixture/hd-release-safety-approval-switch-scan-r01.json', approvalSha256: digest('new-typed-approval'),
    windowSha256: digest('new-typed-window'), observedAt: new Date().toISOString() };
  assert.deepEqual(validateSwitchScanRepair(structuredClone(request)), request);
  for (const key of Object.keys(request)) {
    const missing = { ...request }; delete missing[key]; assert.throws(() => validateSwitchScanRepair(missing));
    assert.throws(() => validateSwitchScanRepair({ ...request, [key]: 'unbound' }));
  }
  for (const key of ['terminalEventSha256', 'phaseResultEventSha256', 'switchTypedRepairProofSha256', 'candidateSwitchObservationProofSha256', 'refusalLogSha256'])
    assert.throws(() => validateSwitchScanRepair({ ...request, [key]: digest('different:' + key) }));
  assert.throws(() => validateSwitchScanRepair({ ...request, resetAdmission: true }));
  const error = { schema: 'sd2-release-error.v1', category: 'internal_failure', code: 'unclassified_internal_failure',
    object: { kind: 'release_operation', id: 'child' },
    reason: 'An unclassified release-engine failure occurred; the original exception remains in the private attempt evidence.',
    nextStep: 'Stop dependent or side-effecting work and inspect the preserved attempt evidence.', retryable: false, stop: true };
  const cause = 'Error: HD discovery admission hard deadline expired';
  const child = { schema: 'sd2-release-phase-child.v1', phase: 'switch', intentSha256: SWITCH_SCAN_REPAIR_ORIGIN.failureIntentSha256,
    child: { status: 1, signal: null, error: null }, stderr: JSON.stringify({ error, cause }) + '\n' };
  assertSwitchScanRepairFailure(child); assert.throws(() => assertSwitchTypedRepairFailure(child));
  for (const value of [{ ...child, phase: 'arm' }, { ...child, intentSha256: HASH }, { ...child, child: { status: 0, signal: null, error: null } },
    { ...child, stderr: JSON.stringify({ error, cause: cause + '\n' }) },
    { ...child, stderr: JSON.stringify({ error, cause: cause.replace('hard deadline expired', 'collision deadline expired') }) },
    { ...child, stderr: JSON.stringify({ error: { ...error, category: 'another_failure' }, cause }) },
    { ...child, stderr: JSON.stringify({ error: { ...error, stop: false }, cause }) }, { ...child, stderr: child.stderr + child.stderr }])
    assert.throws(() => assertSwitchScanRepairFailure(value));
  const root = '/data/video-api-debugger/release-engines/1.0.0-' + SWITCH_SCAN_REPAIR_ORIGIN.predecessorControllerSetSha256;
  const stack = "Error: HD discovery admission hard deadline expired\n    at Object.remaining (file:///data/video-api-debugger/release-engines/1.0.0-0fa9260ec2d8299191545f92ed262ae76b0bda1fba0d31adb716f7041e0ed9f8/hd-storage-preflight.mjs:163:92)\n    at Object.observe (file:///data/video-api-debugger/release-engines/1.0.0-0fa9260ec2d8299191545f92ed262ae76b0bda1fba0d31adb716f7041e0ed9f8/hd-storage-preflight.mjs:167:17)\n    at assertNoTransient (file:///data/video-api-debugger/release-engines/1.0.0-0fa9260ec2d8299191545f92ed262ae76b0bda1fba0d31adb716f7041e0ed9f8/hd-storage-preflight.mjs:777:16)\n    at inspectHdClosedExecutionCache (file:///data/video-api-debugger/release-engines/1.0.0-0fa9260ec2d8299191545f92ed262ae76b0bda1fba0d31adb716f7041e0ed9f8/hd-storage-preflight.mjs:921:3)\n    at inventory (file:///data/video-api-debugger/release-engines/1.0.0-0fa9260ec2d8299191545f92ed262ae76b0bda1fba0d31adb716f7041e0ed9f8/hd-storage-preflight.mjs:1185:27)\n    at readHdStorageProtection (file:///data/video-api-debugger/release-engines/1.0.0-0fa9260ec2d8299191545f92ed262ae76b0bda1fba0d31adb716f7041e0ed9f8/hd-storage-preflight.mjs:1308:70)\n    at inspectHdReconciliation (file:///data/video-api-debugger/release-engines/1.0.0-0fa9260ec2d8299191545f92ed262ae76b0bda1fba0d31adb716f7041e0ed9f8/hd-storage-preflight.mjs:1513:43)\n    at invoke (file:///data/video-api-debugger/release-engines/1.0.0-0fa9260ec2d8299191545f92ed262ae76b0bda1fba0d31adb716f7041e0ed9f8/hd-storage-preflight.mjs:189:28)\n    at inspectHdBeforeMaintenance (file:///data/video-api-debugger/release-engines/1.0.0-0fa9260ec2d8299191545f92ed262ae76b0bda1fba0d31adb716f7041e0ed9f8/hd-storage-preflight.mjs:198:22)\n    at file:///data/video-api-debugger/release-engines/1.0.0-0fa9260ec2d8299191545f92ed262ae76b0bda1fba0d31adb716f7041e0ed9f8/switch.mjs:1272:28";
  assertSwitchScanRepairRefusalLog(Buffer.from(stack));
  for (const value of [stack + '\n', stack.replace(':163:92', ':164:92'), stack.replace('Object.remaining', 'anotherDeadline'), stack.replace(root, '/another-processor')])
    assert.throws(() => assertSwitchScanRepairRefusalLog(Buffer.from(value)));
  const allowed = ['release-entry.mjs', 'candidate-evidence.mjs', 'release.mjs', 'switch.mjs', 'release-entry-engineering.mjs', 'candidate-lifecycle-engineering.mjs', 'hd-storage-preflight.mjs', 'hd-storage-preflight-engineering.mjs'];
  const retained = ['attempt-state.mjs', 'common.mjs', 'typed-files.mjs', 'candidate.mjs', 'candidate-inputs.mjs', 'candidate-reuse.mjs',
    'pricing-start-pair.mjs', 'cutover-driver.mjs', 'cutover-safety.mjs', 'guard-recovery.mjs', 'normal-continuation.mjs',
    'hd-compiled-cache.mjs'];
  const predecessor = Object.fromEntries([...allowed, ...retained].map(name => [name, digest('cebe:' + name)]));
  const processor = { ...predecessor, ...Object.fromEntries(allowed.map(name => [name, digest('typed-repair:' + name)])) };
  assert.equal(Object.keys(assertSwitchScanRepairControllerDifference(predecessor, processor)).length, 8);
  for (const name of retained) assert.throws(() => assertSwitchScanRepairControllerDifference(predecessor, { ...processor, [name]: HASH }));
  assert.throws(() => assertSwitchScanRepairControllerDifference(predecessor, predecessor));
  const events = RELEASE_PHASES.slice(0, RELEASE_PHASES.indexOf('switch')).map(phase => ({ value: { kind: 'phase_result', phase, outcome: 'succeeded' } }));
  events.push({ value: { kind: 'observation', name: 'switch_typed_repair', value: { proofSha256: request.switchTypedRepairProofSha256 } } },
    { value: { kind: 'observation', name: 'candidate_switch_observation', value: { proofSha256: request.candidateSwitchObservationProofSha256 } } });
  const failed = { events, derivedState: { status: 'failed', activePhase: null, lastPhase: {
    phase: 'switch', outcome: 'failed', resultSha256: request.phaseResultEventSha256 }, terminal: { eventSha256: request.terminalEventSha256 },
    lastEventSha256: request.terminalEventSha256 } };
  const originalFixedGuardSha256 = digest('original-fixed-guard'), originalSwitchBeforeSha256 = digest('original-switch-before');
  const runtime = { phase: 'switch', switchTypedRepair: { proofSha256: request.switchTypedRepairProofSha256,
    proof: { originalFixedGuardSha256, originalSwitchBeforeSha256 } }, candidateSwitchObservation: { proofSha256: request.candidateSwitchObservationProofSha256 } };
  const scene = { facts: { effectsStarted: false, switchComplete: false, files: {
    'fixed-guard-recovery.json': { sha256: originalFixedGuardSha256 }, 'switch-before.json': { sha256: originalSwitchBeforeSha256 } } } };
  assertSwitchScanRepairAdmission(failed, request, runtime, scene);
  for (const edit of [value => { value.derivedState.status = 'running'; }, value => { value.derivedState.activePhase = { phase: 'switch' }; },
    value => { value.derivedState.lastPhase.phase = 'arm'; }, value => { value.derivedState.terminal.eventSha256 = HASH; },
    value => { value.events = value.events.filter(item => item.value.name !== 'switch_typed_repair'); },
    value => { value.events = value.events.filter(item => item.value.name !== 'candidate_switch_observation'); },
    value => { value.events.push({ value: { kind: 'observation', name: 'switch_scan_repair' } }); },
    value => { value.events.push({ value: { kind: 'phase_intent', phase: 'proof' } }); }]) {
    const value = structuredClone(failed); edit(value); assert.throws(() => assertSwitchScanRepairAdmission(value, request, runtime, scene));
  }
  assert.throws(() => assertSwitchScanRepairAdmission(failed, request, { ...runtime, phase: 'arm' }, scene));
  for (const facts of [{ ...scene.facts, effectsStarted: true }, { ...scene.facts, switchComplete: true },
    { ...scene.facts, files: { ...scene.facts.files, 'switch-before.json': { sha256: HASH } } },
    { ...scene.facts, files: { ...scene.facts.files, 'ingress-503-switch.json': { sha256: HASH } } }])
    assert.throws(() => assertSwitchScanRepairAdmission(failed, request, runtime, { facts }));
  for (const round of ['r01', 'r02']) assertSwitchScanApprovalPath('/fixture', `/fixture/hd-release-safety-approval-switch-scan-${round}.json`);
  for (const file of ['/fixture/hd-release-safety-approval-switch-scan-r03.json', '/elsewhere/hd-release-safety-approval-switch-scan-r01.json',
    '/fixture/hd-release-safety-approval-switch-admission-r02.json', '/fixture/arbitrary.json'])
    assert.throws(() => assertSwitchScanApprovalPath('/fixture', file));
  return 'only_exact_full_hd_scan_failure_with_consumed_49d_d3ec_and_original_stack_can_continue_switch_once';
}

function scenarioSwitchWindowRepair() {
  const request = { schema: 'sd2-release-switch-window-repair.v1',
    ...Object.fromEntries(['terminalEventSha256', 'phaseResultEventSha256', 'switchOwnerRepairProofSha256',
      'candidateSwitchOwnerObservationProofSha256', 'refusalLogSha256', 'originalHdBeforeSha256', 'originalNginxMasterSha256'].map(key => [key, SWITCH_WINDOW_REPAIR_ORIGIN[key]])),
    childReceiptSha256: digest('original-typed-failure-child'), processorControllerSetSha256: digest('typed-repair-processor'),
    approvalFile: '/fixture/hd-release-safety-approval-switch-window-r01.json', approvalSha256: digest('new-typed-approval'),
    windowSha256: digest('new-typed-window'), observedAt: new Date().toISOString() };
  assert.deepEqual(validateSwitchWindowRepair(structuredClone(request)), request);
  for (const key of Object.keys(request)) {
    const missing = { ...request }; delete missing[key]; assert.throws(() => validateSwitchWindowRepair(missing));
    assert.throws(() => validateSwitchWindowRepair({ ...request, [key]: 'unbound' }));
  }
  for (const key of ['terminalEventSha256', 'phaseResultEventSha256', 'switchOwnerRepairProofSha256', 'candidateSwitchOwnerObservationProofSha256', 'refusalLogSha256', 'originalHdBeforeSha256', 'originalNginxMasterSha256'])
    assert.throws(() => validateSwitchWindowRepair({ ...request, [key]: digest('different:' + key) }));
  assert.throws(() => validateSwitchWindowRepair({ ...request, resetAdmission: true }));
  const error = { schema: 'sd2-release-error.v1', category: 'internal_failure', code: 'unclassified_internal_failure',
    object: { kind: 'release_operation', id: 'child' },
    reason: 'An unclassified release-engine failure occurred; the original exception remains in the private attempt evidence.',
    nextStep: 'Stop dependent or side-effecting work and inspect the preserved attempt evidence.', retryable: false, stop: true };
  const cause = "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n+ actual - expected\n\n+ '/data/video-api-debugger/release-staging/f5646431-2d69-44f6-9c62-5994432f3ade/window.json'\n- '/data/video-api-debugger/release-staging/f5646431-2d69-44f6-9c62-5994432f3ade/window-evidence/46b933f427869b3f2a138558eac4a44bb22ac9abb361f5894c27053cc6102dea.json'";
  const child = { schema: 'sd2-release-phase-child.v1', phase: 'switch', intentSha256: SWITCH_WINDOW_REPAIR_ORIGIN.failureIntentSha256,
    child: { status: 1, signal: null, error: null }, stderr: JSON.stringify({ error, cause }) + '\n' };
  assertSwitchWindowRepairFailure(child); assert.throws(() => assertSwitchOwnerRepairFailure(child));
  for (const value of [{ ...child, phase: 'arm' }, { ...child, intentSha256: HASH }, { ...child, child: { status: 0, signal: null, error: null } },
    { ...child, stderr: JSON.stringify({ error, cause: cause + '\n' }) },
    { ...child, stderr: JSON.stringify({ error, cause: cause.replace('/window.json', '/another-window.json') }) },
    { ...child, stderr: JSON.stringify({ error: { ...error, category: 'another_failure' }, cause }) },
    { ...child, stderr: JSON.stringify({ error: { ...error, stop: false }, cause }) }, { ...child, stderr: child.stderr + child.stderr }])
    assert.throws(() => assertSwitchWindowRepairFailure(value));
  const root = '/data/video-api-debugger/release-engines/1.0.0-' + SWITCH_WINDOW_REPAIR_ORIGIN.predecessorControllerSetSha256;
  const stack = "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n+ actual - expected\n\n+ '/data/video-api-debugger/release-staging/f5646431-2d69-44f6-9c62-5994432f3ade/window.json'\n- '/data/video-api-debugger/release-staging/f5646431-2d69-44f6-9c62-5994432f3ade/window-evidence/46b933f427869b3f2a138558eac4a44bb22ac9abb361f5894c27053cc6102dea.json'\n    at assertSwitchAdmissionWindows (file:///data/video-api-debugger/release-engines/1.0.0-c739426ab49f1355d6e819506de359f61169cac74683ab3eec3ef61a60644938/switch.mjs:903:67)\n    at file:///data/video-api-debugger/release-engines/1.0.0-c739426ab49f1355d6e819506de359f61169cac74683ab3eec3ef61a60644938/switch.mjs:1286:11\n    at async locked (file:///data/video-api-debugger/release-engines/1.0.0-c739426ab49f1355d6e819506de359f61169cac74683ab3eec3ef61a60644938/switch.mjs:801:16)\n    at async releaseEntryCli (file:///data/video-api-debugger/release-engines/1.0.0-c739426ab49f1355d6e819506de359f61169cac74683ab3eec3ef61a60644938/release-entry.mjs:3461:62)";
  assertSwitchWindowRepairRefusalLog(Buffer.from(stack));
  for (const value of [stack + '\n', stack.replace(':903:67', ':904:67'), stack.replace('assertSwitchAdmissionWindows', 'anotherWindowReader'), stack.replace(root, '/another-processor')])
    assert.throws(() => assertSwitchWindowRepairRefusalLog(Buffer.from(value)));
  const allowed = ['release-entry.mjs', 'candidate-evidence.mjs', 'release.mjs', 'switch.mjs', 'release-entry-engineering.mjs', 'candidate-lifecycle-engineering.mjs'];
  const retained = ['attempt-state.mjs', 'common.mjs', 'typed-files.mjs', 'candidate.mjs', 'candidate-inputs.mjs', 'candidate-reuse.mjs',
    'pricing-start-pair.mjs', 'cutover-driver.mjs', 'cutover-safety.mjs', 'guard-recovery.mjs', 'normal-continuation.mjs',
    'hd-compiled-cache.mjs', 'hd-storage-preflight.mjs', 'hd-storage-preflight-engineering.mjs'];
  const predecessor = Object.fromEntries([...allowed, ...retained].map(name => [name, digest('cebe:' + name)]));
  const processor = { ...predecessor, ...Object.fromEntries(allowed.map(name => [name, digest('typed-repair:' + name)])) };
  assert.equal(Object.keys(assertSwitchWindowRepairControllerDifference(predecessor, processor)).length, 6);
  for (const name of retained) assert.throws(() => assertSwitchWindowRepairControllerDifference(predecessor, { ...processor, [name]: HASH }));
  assert.throws(() => assertSwitchWindowRepairControllerDifference(predecessor, predecessor));
  const events = RELEASE_PHASES.slice(0, RELEASE_PHASES.indexOf('switch')).map(phase => ({ value: { kind: 'phase_result', phase, outcome: 'succeeded' } }));
  events.push({ value: { kind: 'observation', name: 'switch_owner_repair', value: { proofSha256: request.switchOwnerRepairProofSha256 } } },
    { value: { kind: 'observation', name: 'candidate_switch_owner_observation', value: { proofSha256: request.candidateSwitchOwnerObservationProofSha256 } } });
  const failed = { events, derivedState: { status: 'failed', activePhase: null, lastPhase: {
    phase: 'switch', outcome: 'failed', resultSha256: request.phaseResultEventSha256 }, terminal: { eventSha256: request.terminalEventSha256 },
    lastEventSha256: request.terminalEventSha256 } };
  const originalFixedGuardSha256 = digest('original-fixed-guard'), originalSwitchBeforeSha256 = digest('original-switch-before');
  const runtime = { phase: 'switch', switchOwnerRepair: { proofSha256: request.switchOwnerRepairProofSha256,
    proof: { originalFixedGuardSha256, originalSwitchBeforeSha256 } }, candidateSwitchOwnerObservation: { proofSha256: request.candidateSwitchOwnerObservationProofSha256 } };
  const scene = { facts: { effectsStarted: false, switchComplete: false, files: {
    'fixed-guard-recovery.json': { sha256: originalFixedGuardSha256 }, 'switch-before.json': { sha256: originalSwitchBeforeSha256 } } } };
  assertSwitchWindowRepairAdmission(failed, request, runtime, scene);
  for (const edit of [value => { value.derivedState.status = 'running'; }, value => { value.derivedState.activePhase = { phase: 'switch' }; },
    value => { value.derivedState.lastPhase.phase = 'arm'; }, value => { value.derivedState.terminal.eventSha256 = HASH; },
    value => { value.events = value.events.filter(item => item.value.name !== 'switch_owner_repair'); },
    value => { value.events = value.events.filter(item => item.value.name !== 'candidate_switch_owner_observation'); },
    value => { value.events.find(item => item.value.name === 'candidate_switch_owner_observation').value.name = 'candidate_switch_observation'; },
    value => { value.events.push({ value: { kind: 'observation', name: 'switch_window_repair' } }); },
    value => { value.events.push({ value: { kind: 'phase_intent', phase: 'proof' } }); }]) {
    const value = structuredClone(failed); edit(value); assert.throws(() => assertSwitchWindowRepairAdmission(value, request, runtime, scene));
  }
  assert.throws(() => assertSwitchWindowRepairAdmission(failed, request, { ...runtime, phase: 'arm' }, scene));
  for (const facts of [{ ...scene.facts, effectsStarted: true }, { ...scene.facts, switchComplete: true },
    { ...scene.facts, files: { ...scene.facts.files, 'switch-before.json': { sha256: HASH } } },
    { ...scene.facts, files: { ...scene.facts.files, 'ingress-503-switch.json': { sha256: HASH } } }])
    assert.throws(() => assertSwitchWindowRepairAdmission(failed, request, runtime, { facts }));
  for (const round of ['r01', 'r02']) assertSwitchWindowApprovalPath('/fixture', `/fixture/hd-release-safety-approval-switch-window-${round}.json`);
  for (const file of ['/fixture/hd-release-safety-approval-switch-window-r03.json', '/elsewhere/hd-release-safety-approval-switch-window-r01.json',
    '/fixture/hd-release-safety-approval-switch-admission-r02.json', '/fixture/arbitrary.json'])
    assert.throws(() => assertSwitchWindowApprovalPath('/fixture', file));
  return 'only_exact_window_path_failure_with_consumed_owner_and_original_497_observation_can_continue_switch_once';
}

function scenarioSwitchOwnerRepair() {
  const request = { schema: 'sd2-release-switch-owner-repair.v1',
    ...Object.fromEntries(['terminalEventSha256', 'phaseResultEventSha256', 'switchScanRepairProofSha256',
      'candidateSwitchObservationProofSha256', 'refusalLogSha256', 'strictResultSha256'].map(key => [key, SWITCH_OWNER_REPAIR_ORIGIN[key]])),
    childReceiptSha256: digest('original-typed-failure-child'), processorControllerSetSha256: digest('typed-repair-processor'),
    approvalFile: '/fixture/hd-release-safety-approval-switch-owner-r01.json', approvalSha256: digest('new-typed-approval'),
    windowSha256: digest('new-typed-window'), observedAt: new Date().toISOString() };
  assert.deepEqual(validateSwitchOwnerRepair(structuredClone(request)), request);
  for (const key of Object.keys(request)) {
    const missing = { ...request }; delete missing[key]; assert.throws(() => validateSwitchOwnerRepair(missing));
    assert.throws(() => validateSwitchOwnerRepair({ ...request, [key]: 'unbound' }));
  }
  for (const key of ['terminalEventSha256', 'phaseResultEventSha256', 'switchScanRepairProofSha256', 'candidateSwitchObservationProofSha256', 'refusalLogSha256', 'strictResultSha256'])
    assert.throws(() => validateSwitchOwnerRepair({ ...request, [key]: digest('different:' + key) }));
  assert.throws(() => validateSwitchOwnerRepair({ ...request, resetAdmission: true }));
  const error = { schema: 'sd2-release-error.v1', category: 'internal_failure', code: 'unclassified_internal_failure',
    object: { kind: 'release_operation', id: 'child' },
    reason: 'An unclassified release-engine failure occurred; the original exception remains in the private attempt evidence.',
    nextStep: 'Stop dependent or side-effecting work and inspect the preserved attempt evidence.', retryable: false, stop: true };
  const cause = 'AssertionError [ERR_ASSERTION]: HD work is in flight or unexplained; keep the original site and do not enter maintenance\n\nfalse !== true\n';
  const child = { schema: 'sd2-release-phase-child.v1', phase: 'switch', intentSha256: SWITCH_OWNER_REPAIR_ORIGIN.failureIntentSha256,
    child: { status: 1, signal: null, error: null }, stderr: JSON.stringify({ error, cause }) + '\n' };
  assertSwitchOwnerRepairFailure(child); assert.throws(() => assertSwitchScanRepairFailure(child));
  for (const value of [{ ...child, phase: 'arm' }, { ...child, intentSha256: HASH }, { ...child, child: { status: 0, signal: null, error: null } },
    { ...child, stderr: JSON.stringify({ error, cause: cause + '\n' }) },
    { ...child, stderr: JSON.stringify({ error, cause: cause.replace('in flight or unexplained', 'in flight') }) },
    { ...child, stderr: JSON.stringify({ error: { ...error, category: 'another_failure' }, cause }) },
    { ...child, stderr: JSON.stringify({ error: { ...error, stop: false }, cause }) }, { ...child, stderr: child.stderr + child.stderr }])
    assert.throws(() => assertSwitchOwnerRepairFailure(value));
  const root = '/data/video-api-debugger/release-engines/1.0.0-' + SWITCH_OWNER_REPAIR_ORIGIN.predecessorControllerSetSha256;
  const stack = "AssertionError [ERR_ASSERTION]: HD work is in flight or unexplained; keep the original site and do not enter maintenance\n\nfalse !== true\n\n    at file:///data/video-api-debugger/release-engines/1.0.0-4ace8cb587fc5020f63110bec2f3e11f30881dcc316f461c494f9ded4e31ae42/switch.mjs:1278:16\n    at async locked (file:///data/video-api-debugger/release-engines/1.0.0-4ace8cb587fc5020f63110bec2f3e11f30881dcc316f461c494f9ded4e31ae42/switch.mjs:801:16)\n    at async releaseEntryCli (file:///data/video-api-debugger/release-engines/1.0.0-4ace8cb587fc5020f63110bec2f3e11f30881dcc316f461c494f9ded4e31ae42/release-entry.mjs:3205:62)";
  assertSwitchOwnerRepairRefusalLog(Buffer.from(stack));
  for (const value of [stack + '\n', stack.replace(':1278:16', ':1279:16'), stack.replace('async locked', 'async anotherLock'), stack.replace(root, '/another-processor')])
    assert.throws(() => assertSwitchOwnerRepairRefusalLog(Buffer.from(value)));
  const allowed = ['release-entry.mjs', 'candidate-evidence.mjs', 'release.mjs', 'switch.mjs', 'release-entry-engineering.mjs', 'candidate-lifecycle-engineering.mjs', 'candidate-inputs.mjs', 'hd-storage-preflight.mjs', 'hd-storage-preflight-engineering.mjs'];
  const retained = ['attempt-state.mjs', 'common.mjs', 'typed-files.mjs', 'candidate.mjs', 'candidate-reuse.mjs',
    'pricing-start-pair.mjs', 'cutover-driver.mjs', 'cutover-safety.mjs', 'guard-recovery.mjs', 'normal-continuation.mjs',
    'hd-compiled-cache.mjs'];
  const predecessor = Object.fromEntries([...allowed, ...retained].map(name => [name, digest('cebe:' + name)]));
  const processor = { ...predecessor, ...Object.fromEntries(allowed.map(name => [name, digest('typed-repair:' + name)])) };
  assert.equal(Object.keys(assertSwitchOwnerRepairControllerDifference(predecessor, processor)).length, 9);
  for (const name of retained) assert.throws(() => assertSwitchOwnerRepairControllerDifference(predecessor, { ...processor, [name]: HASH }));
  assert.throws(() => assertSwitchOwnerRepairControllerDifference(predecessor, predecessor));
  const events = RELEASE_PHASES.slice(0, RELEASE_PHASES.indexOf('switch')).map(phase => ({ value: { kind: 'phase_result', phase, outcome: 'succeeded' } }));
  events.push({ value: { kind: 'observation', name: 'switch_scan_repair', value: { proofSha256: request.switchScanRepairProofSha256 } } },
    { value: { kind: 'observation', name: 'candidate_switch_observation', value: { proofSha256: request.candidateSwitchObservationProofSha256 } } });
  const failed = { events, derivedState: { status: 'failed', activePhase: null, lastPhase: {
    phase: 'switch', outcome: 'failed', resultSha256: request.phaseResultEventSha256 }, terminal: { eventSha256: request.terminalEventSha256 },
    lastEventSha256: request.terminalEventSha256 } };
  const originalFixedGuardSha256 = digest('original-fixed-guard'), originalSwitchBeforeSha256 = digest('original-switch-before');
  const runtime = { phase: 'switch', switchScanRepair: { proofSha256: request.switchScanRepairProofSha256,
    proof: { originalFixedGuardSha256, originalSwitchBeforeSha256 } }, candidateSwitchObservation: { proofSha256: request.candidateSwitchObservationProofSha256 } };
  const scene = { facts: { effectsStarted: false, switchComplete: false, files: {
    'fixed-guard-recovery.json': { sha256: originalFixedGuardSha256 }, 'switch-before.json': { sha256: originalSwitchBeforeSha256 } } } };
  assertSwitchOwnerRepairAdmission(failed, request, runtime, scene);
  for (const edit of [value => { value.derivedState.status = 'running'; }, value => { value.derivedState.activePhase = { phase: 'switch' }; },
    value => { value.derivedState.lastPhase.phase = 'arm'; }, value => { value.derivedState.terminal.eventSha256 = HASH; },
    value => { value.events = value.events.filter(item => item.value.name !== 'switch_scan_repair'); },
    value => { value.events = value.events.filter(item => item.value.name !== 'candidate_switch_observation'); },
    value => { value.events.push({ value: { kind: 'observation', name: 'switch_owner_repair' } }); },
    value => { value.events.push({ value: { kind: 'phase_intent', phase: 'proof' } }); }]) {
    const value = structuredClone(failed); edit(value); assert.throws(() => assertSwitchOwnerRepairAdmission(value, request, runtime, scene));
  }
  assert.throws(() => assertSwitchOwnerRepairAdmission(failed, request, { ...runtime, phase: 'arm' }, scene));
  for (const facts of [{ ...scene.facts, effectsStarted: true }, { ...scene.facts, switchComplete: true },
    { ...scene.facts, files: { ...scene.facts.files, 'switch-before.json': { sha256: HASH } } },
    { ...scene.facts, files: { ...scene.facts.files, 'ingress-503-switch.json': { sha256: HASH } } }])
    assert.throws(() => assertSwitchOwnerRepairAdmission(failed, request, runtime, { facts }));
  for (const round of ['r01', 'r02']) assertSwitchOwnerApprovalPath('/fixture', `/fixture/hd-release-safety-approval-switch-owner-${round}.json`);
  for (const file of ['/fixture/hd-release-safety-approval-switch-owner-r03.json', '/elsewhere/hd-release-safety-approval-switch-owner-r01.json',
    '/fixture/hd-release-safety-approval-switch-admission-r02.json', '/fixture/arbitrary.json'])
    assert.throws(() => assertSwitchOwnerApprovalPath('/fixture', file));
  const strict = { runId: 'fixture-run', manifestSha256: HASH, attempt: 1, result: { schema: 'hd-storage-reconciliation-v1', final: false, safe: false, unstable: true, canEnterControlledDrain: false, counts: { canonical: 1397, fork: 121, overlapping: 121 }, issues: [{"run": "324bd942092794e38be1365e502ca98746a749f3635683d0a9b3362703bbf049.6c6adbba-6e43-42ad-bf5b-4a5a07d71a00", "category": "invalid_cache_evidence", "name": "AssertionError", "code": "closed_cache_refused", "reason": "Expected values to be strictly equal:\n+ actual - expected\n\n+ '1834737865'\n- '1834737866'\n            ^", "cacheCode": "ERR_ASSERTION", "role": "canonical"}] } };
  assertSwitchOwnerStrictResult(strict, 'fixture-run', HASH);
  for (const edit of [value => { value.result.safe = true; }, value => { value.result.unstable = false; }, value => { value.result.issues.push(value.result.issues[0]); }, value => { value.result.issues[0].reason += 'another mismatch'; }, value => { value.result.counts.canonical++; }, value => { value.manifestSha256 = digest('another-manifest'); }]) { const value = structuredClone(strict); edit(value); assert.throws(() => assertSwitchOwnerStrictResult(value, 'fixture-run', HASH)); }
  return 'only_exact_completed_hd_identity_refusal_with_consumed_b3c_d3ec_and_original_strict_record_can_continue_switch_once';
}

function scenarioSwitchWindowOriginalSnapshots() {
  const runId = ARM_PAIR_REPAIR_ORIGIN.runId, stage = '/data/video-api-debugger/release-staging/' + runId;
  const snapshot = (name, sha256, size, ino) => ({ requestedPath: stage + '/' + name, realPath: stage + '/' + name, category: 'root_control', sha256,
    identity: { uid: 0, gid: 0, nlink: 1, size, dev: 64784, ino, mode: 0o100600 } });
  const hd = { snapshot: snapshot('hd-reconciliation-before.json', SWITCH_WINDOW_REPAIR_ORIGIN.originalHdBeforeSha256, 399056, 195992342),
    value: { runId, manifestSha256: HASH, schema: 'hd-storage-reconciliation-v1', final: false, safe: false, unstable: false, canEnterControlledDrain: true } };
  const nginx = { snapshot: snapshot('nginx-master.json', SWITCH_WINDOW_REPAIR_ORIGIN.originalNginxMasterSha256, 196, 195992343),
    value: { runId, manifestSha256: HASH, masterPid: 965238, masterStart: '1213376807' } };
  assertSwitchWindowOriginalSnapshots(hd, nginx, runId, HASH);
  for (const target of ['hd', 'nginx']) for (const edit of [value => { value.snapshot.sha256 = HASH; },
    value => { value.snapshot.requestedPath += '.replacement'; }, value => { value.snapshot.realPath += '.replacement'; },
    value => { value.snapshot.identity.ino++; }, value => { value.snapshot.identity.uid = 1004; },
    value => { value.snapshot.identity.mode = 0o100620; }, value => { value.snapshot.identity.nlink = 2; },
    value => { value.value.manifestSha256 = digest('another-manifest'); }]) {
    const copies = { hd: structuredClone(hd), nginx: structuredClone(nginx) }; edit(copies[target]);
    assert.throws(() => assertSwitchWindowOriginalSnapshots(copies.hd, copies.nginx, runId, HASH));
  }
  const changedHd = structuredClone(hd); changedHd.value.unstable = true;
  assert.throws(() => assertSwitchWindowOriginalSnapshots(changedHd, nginx, runId, HASH));
  const changedNginx = structuredClone(nginx); changedNginx.value.masterStart = '1213376808';
  assert.throws(() => assertSwitchWindowOriginalSnapshots(hd, changedNginx, runId, HASH));
  return 'original_premaintenance_hd_and_nginx_files_keep_exact_bytes_entities_permissions_and_nginx_identity';
}

function scenarioSwitchOwnerObservation() {
  const repairSha = digest('bound-owner-repair'), originalFixedGuardSha256 = digest('retained-fixed-guard'), originalSwitchBeforeSha256 = digest('retained-switch-before');
  const events = RELEASE_PHASES.slice(0, RELEASE_PHASES.indexOf('switch')).map(phase => ({ value: { kind: 'phase_result', phase, outcome: 'succeeded' } }));
  events.push({ value: { kind: 'observation', name: 'candidate_switch_observation', value: { proofSha256: SWITCH_OWNER_REPAIR_ORIGIN.candidateSwitchObservationProofSha256 } } },
    { value: { kind: 'observation', name: 'switch_owner_repair', value: { proofSha256: repairSha } } });
  const loaded = { events, derivedState: { status: 'running', activePhase: null } };
  const runtime = { phase: 'switch', switchOwnerRepair: { schema: 'sd2-release-switch-owner-repair-runtime.v1', proofSha256: repairSha,
    proof: { originalFixedGuardSha256, originalSwitchBeforeSha256 } }, candidateSwitchObservation: {
    schema: 'sd2-release-candidate-observation-runtime.v1', proofSha256: SWITCH_OWNER_REPAIR_ORIGIN.candidateSwitchObservationProofSha256, proof: { expiresAt: 2000 } } };
  const scene = { facts: { effectsStarted: false, switchComplete: false, files: {
    'fixed-guard-recovery.json': { sha256: originalFixedGuardSha256 }, 'switch-before.json': { sha256: originalSwitchBeforeSha256 } } } };
  assertCandidateSwitchOwnerObservationAdmission(loaded, runtime, 2000, scene);
  assert.throws(() => assertCandidateSwitchOwnerObservationAdmission(loaded, runtime, 1999, scene));
  for (const edit of [value => { value.derivedState.activePhase = { phase: 'switch' }; }, value => { value.derivedState.status = 'failed'; },
    value => { value.events.push({ value: { kind: 'observation', name: 'candidate_switch_owner_observation' } }); },
    value => { value.events = value.events.filter(item => item.value.name !== 'switch_owner_repair'); },
    value => { value.events = value.events.filter(item => item.value.name !== 'candidate_switch_observation'); },
    value => { value.events.push({ value: { kind: 'phase_intent', phase: 'proof' } }); }]) {
    const value = structuredClone(loaded); edit(value); assert.throws(() => assertCandidateSwitchOwnerObservationAdmission(value, runtime, 2001, scene));
  }
  assert.throws(() => assertCandidateSwitchOwnerObservationAdmission(loaded, { ...runtime, phase: 'arm' }, 2001, scene));
  for (const facts of [{ ...scene.facts, effectsStarted: true }, { ...scene.facts, switchComplete: true },
    { ...scene.facts, files: { ...scene.facts.files, 'switch-before.json': { sha256: HASH } } },
    { ...scene.facts, files: { ...scene.facts.files, 'ingress-503-switch.json': { sha256: HASH } } }])
    assert.throws(() => assertCandidateSwitchOwnerObservationAdmission(loaded, runtime, 2001, { facts }));
  return 'only_one_owner_bound_expired_d3_candidate_observation_without_active_or_effects_is_permitted';
}

function restoredOriginalRequests() {
  const origin = RESTORED_ORIGINAL_ORIGIN, stage = '/fixture/stage';
  return { closure: { schema: 'sd2-release-restored-original-closure.v1', phaseResultEventSha256: origin.phaseResultEventSha256,
    failureIntentSha256: origin.failureIntentSha256, childReceiptSha256: HASH, switchWindowRepairProofSha256: origin.switchWindowRepairProofSha256,
    restorationReceiptSha256: origin.restorationReceiptSha256, switchFailureFile: stage + '/switch-failure.json', switchFailureSha256: HASH,
    restoredBaselineFile: stage + '/restored-original-baseline-r01.json', restoredBaselineSha256: HASH, processorControllerSetSha256: HASH,
    closureWindowSha256: HASH, observedAt: '2026-10-24T01:00:00.000Z' },
  repair: { schema: 'sd2-release-restored-original-repair.v1', terminalEventSha256: HASH, phaseResultEventSha256: origin.phaseResultEventSha256,
    childReceiptSha256: HASH, closureProofSha256: HASH, processorControllerSetSha256: HASH,
    approvalFile: stage + '/hd-release-safety-approval-restored-original-r01.json', approvalSha256: HASH, windowSha256: HASH, observedAt: '2026-10-24T01:01:00.000Z' } };
}

function restoredOriginalScene() {
  return { facts: { effectsStarted: true, switchComplete: false, files: Object.fromEntries([
    'pricing-pair-published.json', 'switch-complete.json', 'pricing-start-intent.json', 'full-schema-ready.json', 'canvas-batch-schema-ready.json',
    'raw-upload-recovery-published.json', 'guard-recovery-start-intent.json', 'guard-recovery-complete.json'].map(name => [name, null])) } };
}

function scenarioRestoredOriginalFailure() {
  // Exact retained native failure, including nginx output; no fabricated no-effects child.
  const child = {"schema":"sd2-release-phase-child.v1","phase":"switch","intentSha256":"38c3a8b1968ef56cdf036369711081e43fb949127b384ba786830f2fb0b7e49d","startedAt":1792802628703,"finishedAt":1792802763928,"child":{"status":1,"signal":null,"error":null},"stdout":"","stderr":"2026/10/24 00:45:10 [warn] 1517390#1517390: protocol options redefined for [::]:443 in /etc/nginx/sites-enabled/nexflow.youdooart.com:22\nnginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful\n2026/10/24 08:45:28 [warn] 1518061#1518061: protocol options redefined for [::]:443 in /etc/nginx/sites-enabled/nexflow.youdooart.com:22\nnginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful\n2026/10/24 08:45:58 [warn] 1519267#1519267: protocol options redefined for [::]:443 in /etc/nginx/sites-enabled/nexflow.youdooart.com:22\nnginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful\n{\"error\":{\"schema\":\"sd2-release-error.v1\",\"category\":\"internal_failure\",\"code\":\"unclassified_internal_failure\",\"object\":{\"kind\":\"release_operation\",\"id\":\"child\"},\"reason\":\"An unclassified release-engine failure occurred; the original exception remains in the private attempt evidence.\",\"nextStep\":\"Stop dependent or side-effecting work and inspect the preserved attempt evidence.\",\"retryable\":false,\"stop\":true},\"cause\":\"AssertionError [ERR_ASSERTION]: Whole HD service drain or exact retired cache evidence is incomplete\\n\\nfalse !== true\\n\"}\n"};
  assertRestoredOriginalFailure(child);
  for (const edit of [value => { value.stderr += 'unbound output'; }, value => { value.stderr = value.stderr.replace('Whole HD service drain', 'Some other drain'); },
    value => { value.child.status = 0; }, value => { value.intentSha256 = HASH; }, value => { value.phase = 'arm'; }]) {
    const value = structuredClone(child); edit(value); assert.throws(() => assertRestoredOriginalFailure(value));
  }
  const { closure, repair } = restoredOriginalRequests(); validateRestoredOriginalClosure(closure); validateRestoredOriginalRepair(repair);
  const operationId = randomUUID(); assertRestoredOriginalMaintenanceOperationId(operationId, ARM_PAIR_REPAIR_ORIGIN.runId);
  assert.throws(() => assertRestoredOriginalMaintenanceOperationId(ARM_PAIR_REPAIR_ORIGIN.runId, ARM_PAIR_REPAIR_ORIGIN.runId));
  assert.throws(() => assertRestoredOriginalMaintenanceOperationId('unbound-operation', ARM_PAIR_REPAIR_ORIGIN.runId));
  for (const key of ['phaseResultEventSha256', 'failureIntentSha256', 'switchWindowRepairProofSha256', 'restorationReceiptSha256'])
    assert.throws(() => validateRestoredOriginalClosure({ ...closure, [key]: HASH }));
  for (const value of [{ ...closure, schema: repair.schema }, { ...closure, observedAt: 'unknown' }, { ...closure, extra: false },
    { ...closure, restoredBaselineFile: 'relative.json' }]) assert.throws(() => validateRestoredOriginalClosure(value));
  for (const value of [{ ...repair, phaseResultEventSha256: HASH }, { ...repair, schema: closure.schema }, { ...repair, extra: false },
    { ...repair, approvalFile: 'relative.json' }]) assert.throws(() => validateRestoredOriginalRepair(value));
  for (const round of ['r01', 'r02']) assertRestoredOriginalApprovalPath('/fixture', '/fixture/hd-release-safety-approval-restored-original-' + round + '.json');
  for (const file of ['/fixture/hd-release-safety-approval-restored-original-r03.json', '/elsewhere/hd-release-safety-approval-restored-original-r01.json',
    '/fixture/hd-release-safety-approval-switch-window-r01.json']) assert.throws(() => assertRestoredOriginalApprovalPath('/fixture', file));
  return 'restored_original_closure_binds_exact_native_failure_and_separate_typed_closure_continuation_authorities';
}

function scenarioRestoredOriginalLive() {
  const roles = ['web', 'image', 'hd', 'works', 'role', 'template'];
  const original = Object.fromEntries(roles.map((role, i) => [role, { unit: role + '.service', pid: i + 100, invocation: String(i).repeat(32),
    root: '/fixture/' + role, source: String(i).repeat(40), version: '0.0.1', build: role + '-build', execMainStartTimestampMonotonic: '100' }]));
  const restored = Object.fromEntries(roles.map(role => [role, { ...original[role], kernelStartTicks: '10' }]));
  for (const [role, pid, invocation] of [['image', 1519228, '16892719f40742bf8c0d158be6bd5efc'], ['hd', 1519173, 'a8db5ad96e46411f8867b0883ff6c200'],
    ['role', 1518758, '34081608eac84917bdb0af3f35a48450']]) Object.assign(restored[role], { pid, invocation, kernelStartTicks: '200', execMainStartTimestampMonotonic: '200' });
  assertRestoredOriginalLive(original, restored);
  for (const edit of [value => { value.image.pid = original.image.pid; }, value => { value.role.invocation = original.role.invocation; },
    value => { value.hd.source = original.web.source; }, value => { value.template.root += '/elsewhere'; }, value => { value.web.pid++; },
    value => { value.hd.kernelStartTicks = 'unknown'; }, value => { value.web.execMainStartTimestampMonotonic = '101'; },
    value => { delete value.works; }, value => { value.hd.unbound = true; }]) {
    const value = structuredClone(restored); edit(value); assert.throws(() => assertRestoredOriginalLive(original, value));
  }
  const changedNames = ['release-entry.mjs', 'attempt-state.mjs', 'candidate-evidence.mjs', 'release.mjs', 'switch.mjs', 'hd-storage-preflight.mjs'];
  const oldMap = Object.fromEntries([...changedNames, 'common.mjs', 'usage-role-control.mjs', 'retired-hd-cache.mjs', 'cutover-driver.mjs', 'writer-network-fence.mjs'].map(name => [name, HASH]));
  const nextMap = { ...oldMap, ...Object.fromEntries(changedNames.map(name => [name, digest(name)])) };
  assertRestoredOriginalControllerDifference(oldMap, nextMap);
  assert.throws(() => assertRestoredOriginalControllerDifference(oldMap, { ...nextMap, 'common.mjs': digest('unreviewed-common') }));
  assert.throws(() => assertRestoredOriginalControllerDifference(oldMap, { ...nextMap, 'attempt-state.mjs': HASH }));
  assert.throws(() => assertRestoredOriginalControllerDifference(oldMap, { ...nextMap, 'unbound.mjs': HASH }));
  return 'restored_live_has_real_new_three_identities_but_preserves_all_six_sources_and_controller_boundary';
}

function scenarioRestoredOriginalStages() {
  const { closure, repair } = restoredOriginalRequests(), scene = restoredOriginalScene(); assertRestoredOriginalScene(scene);
  const events = RELEASE_PHASES.slice(0, RELEASE_PHASES.indexOf('switch')).map(phase => ({ value: { kind: 'phase_result', phase, outcome: 'succeeded' } }));
  const lastPhase = { phase: 'switch', outcome: 'failed', resultSha256: closure.phaseResultEventSha256, intentSha256: closure.failureIntentSha256 };
  const running = { events, derivedState: { status: 'running', activePhase: null, terminal: null, lastPhase, lastEventSha256: closure.phaseResultEventSha256 } };
  assertRestoredOriginalClosureAdmission(running, closure, scene);
  for (const edit of [value => { value.derivedState.status = 'failed'; }, value => { value.derivedState.activePhase = { phase: 'switch' }; },
    value => { value.derivedState.lastEventSha256 = HASH; }, value => { value.derivedState.lastPhase.resultSha256 = HASH; },
    value => { value.events.push({ value: { kind: 'observation', name: 'restored_original_closure' } }); }]) {
    const value = structuredClone(running); edit(value); assert.throws(() => assertRestoredOriginalClosureAdmission(value, closure, scene));
  }
  for (const facts of [{ ...scene.facts, effectsStarted: false }, { ...scene.facts, switchComplete: true },
    { ...scene.facts, files: { ...scene.facts.files, 'full-schema-ready.json': { sha256: HASH } } },
    { ...scene.facts, files: {} }]) assert.throws(() => assertRestoredOriginalClosureAdmission(running, closure, { facts }));
  const failed = structuredClone(running); Object.assign(failed.derivedState, { status: 'failed', lastEventSha256: HASH, terminal: { eventSha256: HASH } });
  const runtime = { phase: 'switch', restoredOriginalClosure: { proofSha256: HASH, terminalEventSha256: HASH } };
  assertRestoredOriginalRepairAdmission(failed, runtime, repair, scene);
  const consumed = structuredClone(failed); consumed.events.push({ value: { kind: 'restored_original_continued' } });
  assert.throws(() => assertRestoredOriginalRepairAdmission(consumed, runtime, repair, scene));
  assert.throws(() => assertRestoredOriginalRepairAdmission(failed, runtime, { ...repair, terminalEventSha256: digest('other-terminal') }, scene));
  const restored = structuredClone(running); restored.events.push({ value: { kind: 'observation', name: 'restored_original_repair', value: { proofSha256: HASH } } });
  const observation = { phase: 'switch', restoredOriginalRepair: { schema: 'sd2-release-restored-original-repair-runtime.v1', proofSha256: HASH },
    candidateSwitchOwnerObservation: { proofSha256: SWITCH_WINDOW_REPAIR_ORIGIN.candidateSwitchOwnerObservationProofSha256, proof: { expiresAt: 100 } } };
  assertCandidateRestoredOriginalObservationAdmission(restored, observation, 100, scene);
  assert.throws(() => assertCandidateRestoredOriginalObservationAdmission(restored, observation, 99, scene));
  for (const edit of [value => { value.derivedState.activePhase = { phase: 'switch' }; }, value => { value.derivedState.lastPhase.resultSha256 = HASH; },
    value => { value.events.push({ value: { kind: 'observation', name: 'candidate_restored_original_observation' } }); },
    value => { value.events = value.events.filter(item => item.value.name !== 'restored_original_repair'); }]) {
    const value = structuredClone(restored); edit(value); assert.throws(() => assertCandidateRestoredOriginalObservationAdmission(value, observation, 101, scene));
  }
  assert.throws(() => assertCandidateRestoredOriginalObservationAdmission(restored, { ...observation, phase: 'arm' }, 101, scene));
  return 'restored_original_closes_running_failure_then_consumes_native_terminal_once_without_clearing_historical_effects';
}

function scenarioGuardRecoveryRepair() {
  const origin = GUARD_RECOVERY_REPAIR_ORIGIN, request = { schema: 'sd2-release-guard-recovery-repair.v1',
    phaseResultEventSha256: origin.phaseResultEventSha256, failureIntentSha256: origin.failureIntentSha256, childReceiptSha256: HASH,
    restoredOriginalRepairProofSha256: origin.restoredOriginalRepairProofSha256, restoredOriginalClosureProofSha256: origin.restoredOriginalClosureProofSha256,
    guardRecoveryFailureSha256: origin.guardRecoveryFailureSha256, switchFailureSha256: origin.switchFailureSha256,
    processorControllerSetSha256: HASH, windowSha256: HASH, observedAt: '2026-10-24T02:00:00.000Z' };
  validateGuardRecoveryRepair(request);
  for (const key of ['phaseResultEventSha256', 'failureIntentSha256', 'restoredOriginalRepairProofSha256', 'restoredOriginalClosureProofSha256',
    'guardRecoveryFailureSha256', 'switchFailureSha256']) assert.throws(() => validateGuardRecoveryRepair({ ...request, [key]: HASH }));
  for (const value of [{ ...request, schema: 'sd2-release-restored-original-repair.v1' }, { ...request, extra: false },
    { ...request, observedAt: 'unknown' }, { ...request, processorControllerSetSha256: 'unknown' }]) assert.throws(() => validateGuardRecoveryRepair(value));
  const child = {"schema":"sd2-release-phase-child.v1","phase":"switch","intentSha256":"8a3e2207cc19654f1fc634f1b46a041cda54786d141368fc5e737a0c48558adb","startedAt":1792805017973,"finishedAt":1792805554487,"child":{"status":1,"signal":null,"error":null},"stdout":"","stderr":"2026/10/24 01:25:06 [warn] 1568141#1568141: protocol options redefined for [::]:443 in /etc/nginx/sites-enabled/nexflow.youdooart.com:22\nnginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful\n2026/10/24 09:25:30 [warn] 1568935#1568935: protocol options redefined for [::]:443 in /etc/nginx/sites-enabled/nexflow.youdooart.com:22\nnginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful\n2026/10/24 01:25:59 [warn] 1569718#1569718: protocol options redefined for [::]:443 in /etc/nginx/sites-enabled/nexflow.youdooart.com:22\nnginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful\nWarning: The unit file, source configuration file or drop-ins of sd2-gray.service changed on disk. Run 'systemctl daemon-reload' to reload units.\n2026/10/24 09:27:46 [warn] 1572396#1572396: protocol options redefined for [::]:443 in /etc/nginx/sites-enabled/nexflow.youdooart.com:22\nnginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful\n2026/10/24 09:27:58 [warn] 1572778#1572778: protocol options redefined for [::]:443 in /etc/nginx/sites-enabled/nexflow.youdooart.com:22\nnginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful\n{\"error\":{\"schema\":\"sd2-release-error.v1\",\"category\":\"internal_failure\",\"code\":\"unclassified_internal_failure\",\"object\":{\"kind\":\"release_operation\",\"id\":\"child\"},\"reason\":\"An unclassified release-engine failure occurred; the original exception remains in the private attempt evidence.\",\"nextStep\":\"Stop dependent or side-effecting work and inspect the preserved attempt evidence.\",\"retryable\":false,\"stop\":true},\"cause\":\"AggregateError: Release failed and safety recovery failed\"}\n"};
  assertGuardRecoveryRepairFailure(child);
  for (const edit of [value => { value.stderr += 'unbound recovery output'; }, value => { value.child.status = 0; },
    value => { value.intentSha256 = HASH; }, value => { value.phase = 'recovery'; }]) {
    const value = structuredClone(child); edit(value); assert.throws(() => assertGuardRecoveryRepairFailure(value));
  }
  assertGuardRecoveryRepairChildPhase('recovery');
  for (const phase of RELEASE_PHASES) assert.throws(() => assertGuardRecoveryRepairChildPhase(phase));
  const changed = ['release-entry.mjs', 'release-entry-engineering.mjs', 'candidate-evidence.mjs', 'release.mjs',
    'canvas-batch-schema.mjs', 'canvas-batch-schema-engineering.mjs', 'candidate-lifecycle-engineering.mjs', 'switch.mjs'];
  const oldMap = Object.fromEntries([...changed, 'attempt-state.mjs', 'common.mjs', 'full-release-contract.mjs'].map(name => [name, HASH]));
  const newMap = { ...oldMap, ...Object.fromEntries(changed.map(name => [name, digest(name)])) };
  assertGuardRecoveryRepairControllerDifference(oldMap, newMap);
  for (const name of ['attempt-state.mjs', 'common.mjs', 'full-release-contract.mjs'])
    assert.throws(() => assertGuardRecoveryRepairControllerDifference(oldMap, { ...newMap, [name]: digest(name) }));
  assert.throws(() => assertGuardRecoveryRepairControllerDifference(oldMap, { ...newMap, 'canvas-batch-schema.mjs': HASH }));
  const events = RELEASE_PHASES.slice(0, RELEASE_PHASES.indexOf('switch')).map(phase => ({ value: { kind: 'phase_result', phase, outcome: 'succeeded' } }));
  const loaded = { events, derivedState: { status: 'running', activePhase: null, terminal: null, lastEventSha256: origin.phaseResultEventSha256,
    lastPhase: { phase: 'switch', outcome: 'failed', resultSha256: origin.phaseResultEventSha256, intentSha256: origin.failureIntentSha256 } } };
  const runtime = { restoredOriginalRepair: { proofSha256: origin.restoredOriginalRepairProofSha256,
    proof: { processor: { controllerSetSha256: origin.predecessorControllerSetSha256 } } }, restoredOriginalClosure: { proofSha256: origin.restoredOriginalClosureProofSha256 } };
  const scene = { facts: { effectsStarted: true, switchComplete: false, fixedGuardRecoveryAvailable: true, files: {
    'pricing-pair-published.json': { sha256: HASH }, 'full-schema-ready.json': { sha256: HASH }, 'fixed-guard-recovery.json': { sha256: HASH },
    'pricing-start-intent.json': null, 'guard-recovery-start-intent.json': null, 'guard-recovery-complete.json': null, 'switch-complete.json': null } } };
  assertGuardRecoveryRepairAdmission(loaded, request, runtime, scene);
  for (const edit of [value => { value.derivedState.status = 'failed'; }, value => { value.derivedState.activePhase = { phase: 'recovery' }; },
    value => { value.derivedState.lastEventSha256 = HASH; }, value => { value.derivedState.lastPhase.resultSha256 = HASH; },
    value => { value.events.push({ value: { kind: 'observation', name: 'guard_recovery_repair' } }); }]) {
    const value = structuredClone(loaded); edit(value); assert.throws(() => assertGuardRecoveryRepairAdmission(value, request, runtime, scene));
  }
  for (const edit of [value => { value.facts.effectsStarted = false; }, value => { value.facts.fixedGuardRecoveryAvailable = false; },
    value => { value.facts.files['pricing-start-intent.json'] = { sha256: HASH }; }, value => { value.facts.files['guard-recovery-start-intent.json'] = { sha256: HASH }; },
    value => { value.facts.files['pricing-pair-published.json'] = null; }, value => { value.facts.files['full-schema-ready.json'] = null; }]) {
    const value = structuredClone(scene); edit(value); assert.throws(() => assertGuardRecoveryRepairAdmission(loaded, request, runtime, value));
  }
  return 'exact_effectful_guard_recovery_failure_has_one_journal_authority_for_recovery_only_with_frozen_predecessor_and_eight_file_delta';
}

export async function runReleaseEntryEngineering(dependencies = {}) {
  const runTransaction = dependencies.runPhaseTransaction || runPhaseTransaction;
  const processChecks = dependencies.controllerMatrix ? await dependencies.controllerMatrix() : await scenarioControllerMatrix();
  const reuseRoot = fs.mkdtempSync('/data/sd2-release-entry-reuse-'); fs.chmodSync(reuseRoot, 0o700);
  let reuse;
  try { reuse = scenarioReuseNoBuild(reuseRoot); } finally { fs.rmSync(reuseRoot, { recursive: true, force: true }); }
  const checks = [await scenarioA(runTransaction), scenarioDecisions(), ...processChecks, reuse, scenarioE(), scenarioPackageInput(),
    scenarioPrepareTailContract(), scenarioGuardBuildTailContract(), scenarioGuardBuildTailRetry(), scenarioReaderSuccessor(), scenarioArmPairRepair(), scenarioArmProcessorRepair(), scenarioSwitchAdmissionRepair(), scenarioLegacyTemplateBuildAlias(), scenarioSwitchTypedRepair(), scenarioSwitchScanRepair(), scenarioSwitchOwnerRepair(), scenarioSwitchOwnerObservation(), scenarioSwitchWindowRepair(), scenarioSwitchWindowOriginalSnapshots(), scenarioRestoredOriginalFailure(), scenarioRestoredOriginalLive(), scenarioRestoredOriginalStages(), scenarioGuardRecoveryRepair()];
  return { schema: 'sd2-release-entry-engineering.v2', fixtureOnly: true, productionEnvironmentUsed: false,
    productionFaultInjectionUsed: false, realControllerProcessesUsed: true, realAttemptJournalUsed: true, checks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  const [mode, workerMode, configFile] = process.argv.slice(2);
  const action = mode === '--fixture-worker' ? fixtureWorker(workerMode, configFile) : runReleaseEntryEngineering();
  Promise.resolve(action).then(value => process.stdout.write(JSON.stringify(value) + '\n'))
    .catch(error => { process.stderr.write(String(error?.stack || error) + '\n'); process.exitCode = 1; });
}
