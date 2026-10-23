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

export async function runReleaseEntryEngineering(dependencies = {}) {
  const runTransaction = dependencies.runPhaseTransaction || runPhaseTransaction;
  const processChecks = dependencies.controllerMatrix ? await dependencies.controllerMatrix() : await scenarioControllerMatrix();
  const reuseRoot = fs.mkdtempSync('/data/sd2-release-entry-reuse-'); fs.chmodSync(reuseRoot, 0o700);
  let reuse;
  try { reuse = scenarioReuseNoBuild(reuseRoot); } finally { fs.rmSync(reuseRoot, { recursive: true, force: true }); }
  const checks = [await scenarioA(runTransaction), scenarioDecisions(), ...processChecks, reuse, scenarioE(), scenarioPackageInput(),
    scenarioPrepareTailContract(), scenarioGuardBuildTailContract(), scenarioGuardBuildTailRetry(), scenarioReaderSuccessor(), scenarioArmPairRepair()];
  return { schema: 'sd2-release-entry-engineering.v2', fixtureOnly: true, productionEnvironmentUsed: false,
    productionFaultInjectionUsed: false, realControllerProcessesUsed: true, realAttemptJournalUsed: true, checks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  const [mode, workerMode, configFile] = process.argv.slice(2);
  const action = mode === '--fixture-worker' ? fixtureWorker(workerMode, configFile) : runReleaseEntryEngineering();
  Promise.resolve(action).then(value => process.stdout.write(JSON.stringify(value) + '\n'))
    .catch(error => { process.stderr.write(String(error?.stack || error) + '\n'); process.exitCode = 1; });
}
