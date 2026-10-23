import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  assertAttemptBindings,
  createAttemptIdentity,
  continueFailedAttempt,
  validateGuardBuildTailBinding,
  validateGuardBuildTailRetryBinding,
  finishAttempt,
  finishPhase,
  readAttempt,
  recordAttemptEvent,
  refreshAttemptWindow,
  startAttempt,
  startPhase,
  takeoverAttempt,
} from './attempt-state.mjs';
import { aggregateReleaseErrors, classifyReleaseError, releaseError } from './release-errors.mjs';
import { assertTypedFileUnchanged, readTypedFile } from './typed-files.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const UUIDS = Object.freeze({
  first: '10000000-0000-4000-8000-000000000001',
  second: '10000000-0000-4000-8000-000000000002',
  window: '10000000-0000-4000-8000-000000000003',
  takeover: '10000000-0000-4000-8000-000000000004',
  resume: '10000000-0000-4000-8000-000000000005',
  builtFollowup: '10000000-0000-4000-8000-000000000006',
  ownerOne: '20000000-0000-4000-8000-000000000001',
  ownerTwo: '20000000-0000-4000-8000-000000000002',
});

function owner(pid, token) {
  return { pid, host: 'fixture-host', kernelStartTicks: String(9000 + pid), token };
}

function fixtureBindings(root, lifecycle = 'built') {
  const artifact = (kind, source, version) => lifecycle === 'input'
    ? { schema: 'sd2-release-artifact-input.v1', kind, source, version,
      sourceManifestSha256: sha(`${kind}-manifest`), buildInputsSha256: sha(`${kind}-build-inputs`) }
    : { schema: 'sd2-release-artifact-identity.v1', kind, source, version,
      build: `fixture-${kind}`, sourceManifestSha256: sha(`${kind}-manifest`), compiledTreeSha256: sha(`${kind}-tree`),
      immutableSuccessSha256: sha(`${kind}-success`) };
  return {
    engine: { schema: 'sd2-release-engine-identity.v1', version: '1.0.0', sha256: sha('engine-v1') },
    manifest: { schema: 'sd2-release-manifest-identity.v1', file: path.join(root, 'manifest.json'), sha256: sha('manifest-v1') },
    artifacts: {
      main: artifact('main', 'a'.repeat(40), '0.103.1'),
      guard: artifact('guard', 'b'.repeat(40), '0.103.1+guard.1'),
    },
  };
}

function windowReference(root, attemptId, observedAt, expiresAt, label) {
  return { schema: 'sd2-release-window-reference.v1', attemptId, runId: attemptId,
    file: path.join(root, `${label}.window.json`), sha256: sha(`window:${label}`), observedAt, expiresAt };
}

function scene(at, label, facts = {}) {
  const value = { label, ...facts };
  return { schema: 'sd2-release-scene-summary.v1', capturedAt: at, sha256: sha(JSON.stringify(value)), facts: value };
}

function child(status, signal = null, error = null) { return { status, signal, error }; }

function expectCategory(action, category) {
  let caught = null;
  try { action(); } catch (error) { caught = error; }
  assert.equal(caught?.releaseError?.category, category);
  return caught.releaseError;
}

function start(root, taskId, attemptId, controller, now, bindings, expiresAt = now + 1000) {
  return startAttempt({ root, taskId, attemptId, runId: attemptId, owner: controller, ...bindings,
    window: windowReference(root, attemptId, now, expiresAt, `${taskId}-${attemptId}`),
    before: scene(now, `${taskId}-before`, { businessWrites: 0 }), now });
}

function runAttempts(root, checks) {
  const bindings = fixtureBindings(root), inputBindings = fixtureBindings(root, 'input');
  const firstOwner = owner(2101, UUIDS.ownerOne), secondOwner = owner(2102, UUIDS.ownerTwo);
  let now = 1_800_000_000_000;

  const first = start(root, 'multi-attempt', UUIDS.first, firstOwner, now, bindings);
  const firstIntent = startPhase({ root, taskId: 'multi-attempt', attemptId: UUIDS.first, owner: firstOwner, phase: 'build',
    dependencyEventSha256: first.derivedState.lastEventSha256, before: scene(++now, 'first-build-before'), now });
  finishPhase({ root, taskId: 'multi-attempt', attemptId: UUIDS.first, owner: firstOwner, phase: 'build',
    intentSha256: firstIntent.eventSha256, outcome: 'failed', child: child(7), after: scene(++now, 'first-build-after'), now });
  finishAttempt({ root, taskId: 'multi-attempt', attemptId: UUIDS.first, owner: firstOwner, outcome: 'failed',
    after: scene(++now, 'first-attempt-after'), now });
  const failed = readAttempt({ root, taskId: 'multi-attempt', attemptId: UUIDS.first });
  const failedBytes = fs.readFileSync(path.join(failed.place.events, '000002.json'));
  const failedStateSha = failed.stateSha256, failedEventCount = failed.events.length;
  const firstTaskBytes = fs.readFileSync(path.join(failed.place.task, 'task.json'));

  now += 10;
  const second = start(root, 'multi-attempt', UUIDS.second, secondOwner, now, bindings);
  assert.equal(second.header.createdAt, now);
  assert.equal(second.header.window.attemptId, UUIDS.second);
  assert.notDeepEqual(second.header.window, failed.header.window);
  const secondIntent = startPhase({ root, taskId: 'multi-attempt', attemptId: UUIDS.second, owner: secondOwner, phase: 'build',
    dependencyEventSha256: second.derivedState.lastEventSha256, before: scene(++now, 'second-build-before'), now });
  finishPhase({ root, taskId: 'multi-attempt', attemptId: UUIDS.second, owner: secondOwner, phase: 'build',
    intentSha256: secondIntent.eventSha256, outcome: 'succeeded', child: child(0), after: scene(++now, 'second-build-after'), now });
  finishAttempt({ root, taskId: 'multi-attempt', attemptId: UUIDS.second, owner: secondOwner, outcome: 'succeeded',
    after: scene(++now, 'second-attempt-after'), now });
  const taskState = JSON.parse(fs.readFileSync(path.join(second.place.task, 'task.json')));
  assert.equal(taskState.sequence, 2); assert.equal(taskState.latestAttemptId, UUIDS.second);
  assert.equal(taskState.previousSha256, sha(firstTaskBytes));

  expectCategory(() => finishPhase({ root, taskId: 'multi-attempt', attemptId: UUIDS.first, owner: firstOwner, phase: 'build',
    intentSha256: firstIntent.eventSha256, outcome: 'succeeded', child: child(0), after: scene(++now, 'late-result'), now }),
  'evidence_missing');
  assert.equal(readAttempt({ root, taskId: 'multi-attempt', attemptId: UUIDS.first }).events.length, failedEventCount);
  assert.equal(readAttempt({ root, taskId: 'multi-attempt', attemptId: UUIDS.first }).stateSha256, failedStateSha);
  assert.equal(JSON.parse(failedBytes).kind, 'phase_intent');
  assert.equal(readAttempt({ root, taskId: 'multi-attempt', attemptId: UUIDS.first }).events
    .find(item => item.value.kind === 'phase_result').value.child.status, 7);
  checks.push('B_first_failure_second_success_and_late_result_remain_isolated_by_attempt_and_phase');

  const tamperFile = path.join(failed.place.events, '000002.json'), original = fs.readFileSync(tamperFile);
  const tampered = JSON.parse(original); tampered.phase = 'publish'; fs.writeFileSync(tamperFile, JSON.stringify(tampered));
  assert.throws(() => readAttempt({ root, taskId: 'multi-attempt', attemptId: UUIDS.first }));
  fs.writeFileSync(tamperFile, original);
  assert.equal(readAttempt({ root, taskId: 'multi-attempt', attemptId: UUIDS.first }).derivedState.status, 'failed');
  checks.push('B_hash_chain_refuses_changed_old_failure_instead_of_relabeling_it');

  now += 20;
  const fakeBuiltInput = structuredClone(inputBindings); fakeBuiltInput.artifacts.main.build = 'placeholder';
  assert.throws(() => start(root, 'fake-build-input', UUIDS.window, firstOwner, now, fakeBuiltInput, now + 2));
  const windowed = start(root, 'fresh-window', UUIDS.window, firstOwner, now, inputBindings, now + 2);
  assert.deepEqual(Object.keys(windowed.header.artifacts.main).sort(),
    ['schema', 'kind', 'source', 'version', 'sourceManifestSha256', 'buildInputsSha256'].sort());
  now += 3;
  assert.throws(() => startPhase({ root, taskId: 'fresh-window', attemptId: UUIDS.window, owner: firstOwner, phase: 'prepare',
    dependencyEventSha256: windowed.derivedState.lastEventSha256, before: scene(now, 'stale-before'), now }));
  const refreshed = refreshAttemptWindow({ root, taskId: 'fresh-window', attemptId: UUIDS.window, owner: firstOwner,
    window: windowReference(root, UUIDS.window, now, now + 100, 'fresh-window-refresh'), now });
  const windowIntent = startPhase({ root, taskId: 'fresh-window', attemptId: UUIDS.window, owner: firstOwner, phase: 'prepare',
    dependencyEventSha256: refreshed.eventSha256, before: scene(++now, 'fresh-prepare-before'), now });
  finishPhase({ root, taskId: 'fresh-window', attemptId: UUIDS.window, owner: firstOwner, phase: 'prepare',
    intentSha256: windowIntent.eventSha256, outcome: 'succeeded', child: child(0), after: scene(++now, 'fresh-prepare-after'), now });
  recordAttemptEvent({ root, taskId: 'fresh-window', attemptId: UUIDS.window, owner: firstOwner, name: 'artifact_capsule',
    value: bindings.artifacts, now: ++now });
  expectCategory(() => recordAttemptEvent({ root, taskId: 'fresh-window', attemptId: UUIDS.window, owner: firstOwner,
    name: 'artifact_capsule', value: bindings.artifacts, now: now + 1 }), 'input_permanent');
  finishAttempt({ root, taskId: 'fresh-window', attemptId: UUIDS.window, owner: firstOwner, outcome: 'succeeded',
    after: scene(++now, 'fresh-window-after'), now });
  const refreshedAttempt = readAttempt({ root, taskId: 'fresh-window', attemptId: UUIDS.window });
  assert.equal(assertAttemptBindings(refreshedAttempt, inputBindings), true);
  assert.deepEqual(refreshedAttempt.events.find(item => item.value.name === 'artifact_capsule').value.value, bindings.artifacts);
  const changedInputs = structuredClone(inputBindings.artifacts); changedInputs.main.source = 'c'.repeat(40);
  expectCategory(() => assertAttemptBindings(refreshedAttempt, { ...inputBindings, artifacts: changedInputs }), 'input_permanent');
  const builtAttempt = start(root, 'fresh-window', UUIDS.builtFollowup, secondOwner, ++now, bindings);
  assert.equal(assertAttemptBindings(builtAttempt, bindings), true);
  const changedArtifacts = structuredClone(bindings.artifacts); changedArtifacts.main.compiledTreeSha256 = sha('changed-main-tree');
  expectCategory(() => assertAttemptBindings(builtAttempt, { ...bindings, artifacts: changedArtifacts }), 'input_permanent');
  finishAttempt({ root, taskId: 'fresh-window', attemptId: UUIDS.builtFollowup, owner: secondOwner, outcome: 'stopped',
    after: scene(++now, 'built-followup-after'), now });
  checks.push('A_input_identity_needs_no_fake_build_fields_then_real_capsule_and_new_built_attempt_bind_exactly');
  checks.push('A_expired_window_refreshes_without_rebuild_but_actual_source_or_artifact_change_invalidates');

  now += 20;
  const owned = start(root, 'owner-fence', UUIDS.takeover, firstOwner, now, bindings);
  const leaseFile = path.join(owned.place.attempt, 'owner.lock'), leaseSha256 = sha(fs.readFileSync(leaseFile));
  expectCategory(() => takeoverAttempt({ root, taskId: 'owner-fence', attemptId: UUIDS.takeover, owner: secondOwner,
    priorLeaseSha256: leaseSha256, ...bindings, window: windowReference(root, UUIDS.takeover, now + 1, now + 100, 'unknown-owner'),
    now: now + 1, inspectOwner: () => 'unknown' }), 'evidence_missing');
  expectCategory(() => takeoverAttempt({ root, taskId: 'owner-fence', attemptId: UUIDS.takeover, owner: secondOwner,
    priorLeaseSha256: leaseSha256, ...bindings, window: windowReference(root, UUIDS.takeover, now + 1, now + 100, 'alive-owner'),
    now: now + 1, inspectOwner: () => 'alive' }), 'busy_retryable');
  expectCategory(() => takeoverAttempt({ root, taskId: 'owner-fence', attemptId: UUIDS.takeover, owner: secondOwner,
    priorLeaseSha256: leaseSha256, engine: { ...bindings.engine, sha256: sha('changed-engine') }, manifest: bindings.manifest,
    artifacts: bindings.artifacts, window: windowReference(root, UUIDS.takeover, now + 1, now + 100, 'changed-engine'),
    now: now + 1, inspectOwner: () => 'dead' }), 'input_permanent');
  const takeover = takeoverAttempt({ root, taskId: 'owner-fence', attemptId: UUIDS.takeover, owner: secondOwner,
    priorLeaseSha256: leaseSha256, ...bindings, window: windowReference(root, UUIDS.takeover, ++now, now + 100, 'dead-owner'),
    now, inspectOwner: () => 'dead' });
  assert.equal(takeover.event.previousOwner.token, firstOwner.token);
  finishAttempt({ root, taskId: 'owner-fence', attemptId: UUIDS.takeover, owner: secondOwner, outcome: 'stopped',
    after: scene(++now, 'owner-fence-after'), now });
  checks.push('B_active_or_unknown_owner_and_binding_drift_refuse_takeover_while_proven_dead_owner_can_continue');

  now += 20;
  const resumable = start(root, 'phase-resume', UUIDS.resume, firstOwner, now, bindings);
  const intent = startPhase({ root, taskId: 'phase-resume', attemptId: UUIDS.resume, owner: firstOwner, phase: 'switch',
    dependencyEventSha256: resumable.derivedState.lastEventSha256, before: scene(++now, 'switch-before', { businessWrites: 0 }), now });
  const resumeLeaseFile = path.join(resumable.place.attempt, 'owner.lock'), resumeLeaseSha = sha(fs.readFileSync(resumeLeaseFile));
  takeoverAttempt({ root, taskId: 'phase-resume', attemptId: UUIDS.resume, owner: secondOwner, priorLeaseSha256: resumeLeaseSha,
    ...bindings, window: windowReference(root, UUIDS.resume, ++now, now + 100, 'phase-resume-takeover'), now,
    inspectOwner: () => 'dead' });
  finishPhase({ root, taskId: 'phase-resume', attemptId: UUIDS.resume, owner: secondOwner, phase: 'switch',
    intentSha256: intent.eventSha256, outcome: 'interrupted', child: child(null, 'SIGTERM'),
    after: scene(++now, 'switch-interrupted', { businessWrites: 0 }), now });
  const interrupted = readAttempt({ root, taskId: 'phase-resume', attemptId: UUIDS.resume });
  const retry = startPhase({ root, taskId: 'phase-resume', attemptId: UUIDS.resume, owner: secondOwner, phase: 'switch',
    dependencyEventSha256: interrupted.derivedState.lastEventSha256, before: scene(++now, 'switch-retry-before', { businessWrites: 0 }), now });
  finishPhase({ root, taskId: 'phase-resume', attemptId: UUIDS.resume, owner: secondOwner, phase: 'switch',
    intentSha256: retry.eventSha256, outcome: 'succeeded', child: child(0),
    after: scene(++now, 'switch-retry-after', { businessWrites: 1 }), now });
  recordAttemptEvent({ root, taskId: 'phase-resume', attemptId: UUIDS.resume, owner: secondOwner, name: 'business_invariant',
    value: { duplicateBusinessWrites: 0, taskDataLost: false }, now: ++now });
  finishAttempt({ root, taskId: 'phase-resume', attemptId: UUIDS.resume, owner: secondOwner, outcome: 'succeeded',
    after: scene(++now, 'phase-resume-after', { businessWrites: 1, duplicateBusinessWrites: 0, taskDataLost: false }), now });
  const resumed = readAttempt({ root, taskId: 'phase-resume', attemptId: UUIDS.resume });
  const results = resumed.events.filter(item => item.value.kind === 'phase_result').map(item => item.value);
  assert.equal(results.length, 2); assert.equal(results[0].child.signal, 'SIGTERM'); assert.equal(results[1].child.status, 0);
  assert.notEqual(results[0].intentSha256, results[1].intentSha256);
  checks.push('C_interrupted_phase_preserves_original_signal_and_resumes_only_from_a_new_durable_intent');

  const identity = createAttemptIdentity('identity-check');
  assert.equal(identity.attemptId, identity.runId); assert.notEqual(identity.attemptId, UUIDS.first);
  checks.push('B_new_attempt_identity_is_a_fresh_uuid_bound_one_to_one_with_run_id');

  const tailId = '10000000-0000-4000-8000-000000000007', taskId = 'guard-build-tail';
  const tailStart = start(root, taskId, tailId, firstOwner, ++now, inputBindings);
  const guard = startPhase({ root, taskId, attemptId: tailId, owner: firstOwner, phase: 'guard-build',
    dependencyEventSha256: tailStart.derivedState.lastEventSha256, before: scene(++now, 'original-guard'), now });
  finishPhase({ root, taskId, attemptId: tailId, owner: firstOwner, phase: 'guard-build', intentSha256: guard.eventSha256,
    outcome: 'failed', child: child(7), after: scene(++now, 'original-failed-guard'), now });
  finishAttempt({ root, taskId, attemptId: tailId, owner: firstOwner, outcome: 'failed', after: scene(++now, 'original-terminal'), now });
  const originalTail = readAttempt({ root, taskId, attemptId: tailId });
  const oldHeader = fs.readFileSync(path.join(originalTail.place.attempt, 'attempt.json'));
  const oldEvents = originalTail.events.map((_, index) => fs.readFileSync(path.join(originalTail.place.events, String(index + 1).padStart(6, '0') + '.json')));
  const proof = sha('guard-tail-proof'), continuation = { schema: 'sd2-release-guard-build-tail-binding.v1', phase: 'guard-build',
    proofSha256: proof, processorControllerSetSha256: sha('new-tail-processors') };
  assert.deepEqual(validateGuardBuildTailBinding(continuation), continuation);
  assert.throws(() => validateGuardBuildTailBinding({ ...continuation, phase: 'main-build' }));
  const tailInput = { root, taskId, attemptId: tailId, owner: secondOwner, ...inputBindings,
    terminalEventSha256: originalTail.derivedState.terminal.eventSha256, failureReceiptSha256: proof, continuation,
    window: windowReference(root, tailId, ++now, now + 1000, 'tail-window'),
    before: scene(now, 'tail-observation', { effectsStarted: false, switchComplete: false }), now };
  for (const status of ['alive', 'unknown']) assert.throws(() => continueFailedAttempt({ ...tailInput, inspectOwner: () => status }));
  assert.throws(() => continueFailedAttempt({ ...tailInput, failureReceiptSha256: sha('other-proof'), inspectOwner: () => 'dead' }));
  assert.equal(readAttempt({ root, taskId, attemptId: tailId }).events.length, oldEvents.length);
  const continuedTail = continueFailedAttempt({ ...tailInput, inspectOwner: () => 'dead' });
  assert.equal(continuedTail.state.guardBuildTail.status, 'pending');
  assert.equal(continuedTail.state.guardBuildTail.proofSha256, proof);
  assert.throws(() => startPhase({ root, taskId, attemptId: tailId, owner: secondOwner, phase: 'main-build',
    dependencyEventSha256: continuedTail.eventSha256, before: scene(++now, 'forbidden-main'), now }));
  assert.equal(readAttempt({ root, taskId, attemptId: tailId }).derivedState.lastEventSha256, continuedTail.eventSha256);
  const tailIntent = startPhase({ root, taskId, attemptId: tailId, owner: secondOwner, phase: 'guard-build',
    dependencyEventSha256: continuedTail.eventSha256, before: scene(++now, 'tail-only'), now });
  const tailDone = finishPhase({ root, taskId, attemptId: tailId, owner: secondOwner, phase: 'guard-build',
    intentSha256: tailIntent.eventSha256, outcome: 'succeeded', child: child(0), after: scene(++now, 'tail-complete'), now });
  assert.equal(tailDone.state.guardBuildTail.status, 'completed');
  assert.throws(() => startPhase({ root, taskId, attemptId: tailId, owner: secondOwner, phase: 'guard-build',
    dependencyEventSha256: tailDone.eventSha256, before: scene(++now, 'forbidden-replay'), now }));
  const main = startPhase({ root, taskId, attemptId: tailId, owner: secondOwner, phase: 'main-build',
    dependencyEventSha256: tailDone.eventSha256, before: scene(++now, 'first-main'), now });
  finishPhase({ root, taskId, attemptId: tailId, owner: secondOwner, phase: 'main-build', intentSha256: main.eventSha256,
    outcome: 'succeeded', child: child(0), after: scene(++now, 'main-complete'), now });
  finishAttempt({ root, taskId, attemptId: tailId, owner: secondOwner, outcome: 'succeeded', after: scene(++now, 'tail-final'), now });
  assert.deepEqual(fs.readFileSync(path.join(originalTail.place.attempt, 'attempt.json')), oldHeader);
  for (let index = 0; index < oldEvents.length; index++)
    assert.deepEqual(fs.readFileSync(path.join(originalTail.place.events, String(index + 1).padStart(6, '0') + '.json')), oldEvents[index]);
  assert.equal(readAttempt({ root, taskId, attemptId: tailId }).events.find(item => item.sha256 === guard.eventSha256).value.phase, 'guard-build');
  checks.push('guard_tail_preserves_failed_journal_and_header_requires_dead_owner_then_finishes_once_before_main');
}

function runGuardBuildTailRetryAttempts(root, checks) {
  for (const succeeds of [true, false]) {
    const taskId = 'guard-postcheck-retry-' + succeeds, attemptId = succeeds
      ? '10000000-0000-4000-8000-000000000008' : '10000000-0000-4000-8000-000000000009';
    const bindings = fixtureBindings(root, 'input'), first = owner(2201, UUIDS.ownerOne), tailOwner = owner(2202, UUIDS.ownerTwo),
      retryOwner = owner(2203, UUIDS.ownerOne);
    let now = 1_800_000_001_000;
    const read = () => readAttempt({ root, taskId, attemptId });
    const phase = (controller, outcome) => {
      const loaded = read(), intent = startPhase({ root, taskId, attemptId, owner: controller, phase: 'guard-build',
        dependencyEventSha256: loaded.derivedState.lastEventSha256, before: scene(++now, 'guard'), now });
      return finishPhase({ root, taskId, attemptId, owner: controller, phase: 'guard-build', intentSha256: intent.eventSha256,
        outcome, child: child(outcome === 'succeeded' ? 0 : 1), after: scene(++now, 'guard-result'), now });
    };
    const terminal = (controller, outcome) => finishAttempt({ root, taskId, attemptId, owner: controller, outcome,
      after: scene(++now, 'terminal'), now });
    start(root, taskId, attemptId, first, now, bindings); phase(first, 'failed'); terminal(first, 'failed');
    const originalSha = sha('original-guard-proof-' + succeeds);
    const continueWith = (controller, continuation, inspectOwner = () => 'dead') => continueFailedAttempt({ root, taskId, attemptId,
      owner: controller, ...bindings, terminalEventSha256: read().derivedState.terminal.eventSha256,
      failureReceiptSha256: continuation.proofSha256, continuation,
      window: windowReference(root, attemptId, ++now, now + 1000, 'postcheck-window-' + now),
      before: scene(now, 'postcheck-read', { effectsStarted: false, switchComplete: false }), now, inspectOwner });
    continueWith(tailOwner, { schema: 'sd2-release-guard-build-tail-binding.v1', phase: 'guard-build',
      proofSha256: originalSha, processorControllerSetSha256: sha('first-tail-processor') });
    phase(tailOwner, 'failed'); terminal(tailOwner, 'failed');
    const failed = read(), originalState = structuredClone(failed.derivedState.guardBuildTail);
    const header = fs.readFileSync(path.join(failed.place.attempt, 'attempt.json'));
    const preserved = failed.events.map((_, index) => fs.readFileSync(path.join(failed.place.events, String(index + 1).padStart(6, '0') + '.json')));
    const retry = { schema: 'sd2-release-guard-build-tail-retry-binding.v1', phase: 'guard-build', proofSha256: sha('retry-proof-' + succeeds),
      processorControllerSetSha256: sha('retry-processor'), originalContinuationSha256: originalSha,
      originalFailureResultSha256: originalState.resultSha256 };
    assert.deepEqual(validateGuardBuildTailRetryBinding(retry), retry);
    assert.throws(() => validateGuardBuildTailRetryBinding({ ...retry, phase: 'main-build' }));
    for (const status of ['alive', 'unknown']) assert.throws(() => continueWith(retryOwner, retry, () => status));
    assert.throws(() => continueWith(retryOwner, { ...retry, originalContinuationSha256: sha('wrong-original') }));
    assert.equal(read().events.length, preserved.length);
    continueWith(retryOwner, retry);
    assert.deepEqual(read().derivedState.guardBuildTail, originalState);
    assert.equal(read().derivedState.guardBuildTailRetry.status, 'pending');
    const pending = read();
    assert.throws(() => startPhase({ root, taskId, attemptId, owner: retryOwner, phase: 'main-build',
      dependencyEventSha256: pending.derivedState.lastEventSha256, before: scene(++now, 'too-early'), now }));
    assert.equal(read().events.length, pending.events.length);
    phase(retryOwner, succeeds ? 'succeeded' : 'failed');
    assert.deepEqual(read().derivedState.guardBuildTail, originalState);
    assert.equal(read().derivedState.guardBuildTailRetry.status, succeeds ? 'completed' : 'failed');
    if (succeeds) {
      const done = read();
      assert.throws(() => startPhase({ root, taskId, attemptId, owner: retryOwner, phase: 'guard-build',
        dependencyEventSha256: done.derivedState.lastEventSha256, before: scene(++now, 'forbidden-second-retry'), now }));
      const main = startPhase({ root, taskId, attemptId, owner: retryOwner, phase: 'main-build',
        dependencyEventSha256: done.derivedState.lastEventSha256, before: scene(++now, 'allowed-main'), now });
      finishPhase({ root, taskId, attemptId, owner: retryOwner, phase: 'main-build', intentSha256: main.eventSha256,
        outcome: 'succeeded', child: child(0), after: scene(++now, 'main-result'), now });
      terminal(retryOwner, 'succeeded');
    } else {
      terminal(retryOwner, 'failed'); const count = read().events.length;
      assert.throws(() => continueWith(first, { ...retry, proofSha256: sha('unauthorized-second-retry') }));
      assert.equal(read().events.length, count);
    }
    assert.deepEqual(fs.readFileSync(path.join(failed.place.attempt, 'attempt.json')), header);
    for (let index = 0; index < preserved.length; index++)
      assert.deepEqual(fs.readFileSync(path.join(failed.place.events, String(index + 1).padStart(6, '0') + '.json')), preserved[index]);
    checks.push('guard_tail_single_retry_' + (succeeds ? 'completed_then_main' : 'failed_no_second_retry') + '_preserves_original_failed_state_and_events');
  }
}

function runTypedFilesAndErrors(root, checks) {
  assert.equal(process.platform, 'linux', 'System-file engineering fixtures require the production Linux semantics');
  assert.equal(process.getuid(), 0, 'System-file engineering fixtures require the production root reader');
  const typedRoot = path.join(root, 'typed-files'); fs.mkdirSync(typedRoot, { mode: 0o700 });
  const system = path.join(typedRoot, 'node-real'), hard = path.join(typedRoot, 'node-hard'), alias = path.join(typedRoot, 'node-alias');
  fs.writeFileSync(system, 'system-program-v1', { mode: 0o644 }); fs.linkSync(system, hard); fs.symlinkSync('node-real', alias);
  const hardSnapshot = readTypedFile({ file: hard, category: 'system', parentBoundary: typedRoot }).snapshot;
  const aliasSnapshot = readTypedFile({ file: alias, category: 'system', parentBoundary: typedRoot }).snapshot;
  assert.equal(hardSnapshot.identity.nlink, 2); assert.equal(aliasSnapshot.realPath, system);
  assertTypedFileUnchanged(hardSnapshot); assertTypedFileUnchanged(aliasSnapshot);
  fs.writeFileSync(system, 'system-program-v2');
  assert.throws(() => assertTypedFileUnchanged(hardSnapshot));
  checks.push('D_system_hardlink_and_alias_are_allowed_only_with_stable_root_parent_identity_and_hash');

  const app = path.join(typedRoot, 'app-input'), appHard = path.join(typedRoot, 'app-hard');
  fs.writeFileSync(app, 'app-input', { mode: 0o644 }); fs.linkSync(app, appHard);
  let appError = null;
  try { readTypedFile({ file: app, category: 'app', expectedUid: 0 }); } catch (error) { appError = error; }
  assert.equal(classifyReleaseError(appError, { object: { kind: 'file', id: app } }).category, 'input_permanent');
  const control = path.join(typedRoot, 'root-control'), controlHard = path.join(typedRoot, 'root-control-hard');
  fs.writeFileSync(control, 'control', { mode: 0o600 });
  assert.equal(readTypedFile({ file: control, category: 'root_control' }).snapshot.identity.nlink, 1);
  fs.linkSync(control, controlHard); assert.throws(() => readTypedFile({ file: control, category: 'root_control' }));
  fs.unlinkSync(controlHard);
  fs.chmodSync(control, 0o622); assert.throws(() => readTypedFile({ file: control, category: 'root_control' }));
  checks.push('D_app_or_root_hardlink_and_group_writable_control_are_permanent_input_rejections');

  const coded = code => Object.assign(new Error(`private-${code}-detail`), { code });
  assert.equal(classifyReleaseError(coded('EAGAIN'), { object: { kind: 'file', id: control } }).category, 'evidence_missing');
  assert.equal(classifyReleaseError(coded('EAGAIN'), { object: { kind: 'lock', id: 'release-window' },
    verifiedBusy: true, busyEvidence: 'reviewed lease is held by a live owner' }).category, 'busy_retryable');
  assert.equal(classifyReleaseError(coded('EBUSY'), { object: { kind: 'file', id: control }, inputError: true }).category,
  'input_permanent');
  const timeout = classifyReleaseError(coded('ETIMEDOUT'), { object: { kind: 'phase', id: 'switch' } });
  assert.equal(timeout.category, 'evidence_missing'); assert.equal(timeout.retryable, false); assert.equal(timeout.stop, true);
  const explicitBusy = releaseError({ category: 'busy_retryable', code: 'verified_release_lock_busy',
    object: { kind: 'lock', id: 'release-window' }, reason: 'The reviewed release lock is held by its live owner.',
    nextStep: 'Keep this attempt unchanged and retry the read after refreshing that exact owner lease.' });
  assert.equal(classifyReleaseError({ releaseError: explicitBusy }).category, 'busy_retryable');
  assert.equal(classifyReleaseError(coded('EINVAL'), { object: { kind: 'file', id: control } }).category, 'input_permanent');
  assert.equal(classifyReleaseError(coded('ENOENT'), { object: { kind: 'receipt', id: 'missing' } }).category, 'evidence_missing');
  assert.equal(classifyReleaseError(coded('NOT_APPLICABLE'), { object: { kind: 'check', id: 'optional' } }).category, 'not_applicable');
  const internal = classifyReleaseError(new Error('token=must-not-be-projected'), { object: { kind: 'check', id: 'internal' } });
  assert.equal(internal.category, 'internal_failure'); assert.equal(internal.reason.includes('must-not-be-projected'), false);
  const aggregate = aggregateReleaseErrors([
    { checkId: 'busy', readOnly: true, independent: true, dependencyValid: true, error: coded('EAGAIN'),
      verifiedBusy: true, busyEvidence: 'reviewed fixture lock is held by a live owner' },
    { checkId: 'input', readOnly: true, independent: true, dependencyValid: true, error: coded('EINVAL') },
    { checkId: 'optional', readOnly: true, independent: true, dependencyValid: true, error: coded('NOT_APPLICABLE') },
  ], { phase: 'preflight' });
  assert.equal(aggregate.count, 3); assert.equal(aggregate.retryableCount, 1); assert.equal(aggregate.stop, true);
  assert.throws(() => aggregateReleaseErrors([
    { checkId: 'side_effect', readOnly: false, independent: true, dependencyValid: true, error: coded('EAGAIN') },
  ]));
  assert.throws(() => aggregateReleaseErrors([
    { checkId: 'dependent', readOnly: true, independent: true, dependencyValid: false, error: coded('EAGAIN') },
  ]));
  checks.push('D_timeout_and_unverified_busy_stop_while_only_verified_or_explicit_busy_is_retryable');
  checks.push('D_errors_keep_specific_category_object_reason_and_next_step_and_only_independent_reads_aggregate');
}

export function runAttemptStateEngineeringFixtures() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-attempt-state-engineering-')));
  const checks = [];
  runAttempts(root, checks);
  runGuardBuildTailRetryAttempts(root, checks);
  runTypedFilesAndErrors(root, checks);
  return { schema: 'sd2-release-attempt-state-engineering.v1', completed: true, checks, count: checks.length,
    root, scenarios: ['A', 'B', 'C', 'D'], productionCalls: 0, serviceCalls: 0, paidRequests: 0, browserRuns: 0,
    completeBuildExecuted: false, productionWrites: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(runAttemptStateEngineeringFixtures()));
