import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isSharedEngine, engineDirectory, rootFile, sha } from './common.mjs';
import { currentReleaseContext } from './engine-context.mjs';
import { readAttempt } from './attempt-state.mjs';

export const REUSE_SCHEMA = 'sd2-candidate-build-reuse.v1';
export const GUARD_BUILD_TAIL_SCHEMA = 'sd2-candidate-build-tail.v1';
export const CANDIDATE_OBSERVATION_SCHEMA = 'sd2-release-candidate-observation-proof.v1';
const READER_PHASES = ['verify', 'arm', 'switch', 'proof', 'recovery'];
const PROTECTION_FIELDS = ['databaseIdentity', 'files', 'marker', 'otherServices', 'settingsSha256', 'protectedTasks', 'protectedFailedVideo'];
const TAIL_PHASES = ['guard-build', 'main-build', 'verify', 'arm', 'switch', 'proof', 'recovery'];

function processorBytes(value, m) {
  assert.ok(value.processor && value.processorControllers);
  assert.notEqual(value.processor.root, engineDirectory(m));
  assert.deepEqual(Object.keys(value.processorControllers).sort(), Object.keys(m.privateSha256).sort());
  assert.equal(sha(JSON.stringify(value.processorControllers)), value.processor.controllerSetSha256);
  assert.deepEqual(fs.readdirSync(value.processor.root).filter(name => name.endsWith('.mjs')).sort(), Object.keys(value.processorControllers).sort());
  for (const [name, expected] of Object.entries(value.processorControllers)) {
    assert.equal(path.basename(name), name); assert.match(expected, /^[a-f0-9]{64}$/);
    assert.equal(sha(rootFile(value.processor.root + '/' + name)), expected, 'Compatible reader bytes changed: ' + name);
  }
}
function runtimeRootProof(reference, prefix, schema, m) {
  assert.match(reference.proofSha256 || '', /^[a-f0-9]{64}$/);
  const expected = m.operation.taskRoot + '/attempts/' + m.runId + '/' + prefix + reference.proofSha256 + '.json';
  assert.equal(reference.proofFile, expected);
  const bytes = rootFile(expected, 8 * 1024 * 1024), proof = JSON.parse(bytes);
  assert.equal(sha(bytes), reference.proofSha256); assert.deepEqual(proof, reference.proof); assert.equal(proof.schema, schema);
  assert.equal(proof.runId, m.runId); assert.equal(proof.taskId, m.operation.taskId); assert.equal(proof.attemptId, m.operation.attemptId);
  assert.deepEqual(proof.engine, m.engine); assert.equal(proof.manifestSha256, sha(rootFile(m.stage + '/manifest.json')));
  return proof;
}
function successorJournal(m, runtime) {
  const loaded = readAttempt({ root: m.projectRoot + '/release-tasks', taskId: m.operation.taskId, attemptId: m.runId });
  assert.equal(loaded.headCurrent, true); assert.equal(loaded.derivedState.status, 'running');
  if (loaded.derivedState.activePhase) assert.equal(loaded.derivedState.activePhase.phase, runtime.phase);
  const reader = runtime.reader, proof = reader.proof;
  const records = loaded.events.filter(item => item.value.kind === 'observation' && item.value.name === 'reader_successor');
  assert.equal(records.length, 1, 'A successor reader requires its unique owning journal observation');
  const observed = records[0];
  assert.deepEqual(observed.value.value, { schema: 'sd2-release-reader-successor-reference.v1', proofFile: reader.proofFile, proofSha256: reader.proofSha256 });
  assert.equal(observed.value.previousSha256, proof.eventHeadSha256);
  const takeover = loaded.events.find(item => item.sha256 === proof.eventHeadSha256);
  assert.ok(takeover && takeover.value.kind === 'owner_takeover');
  assert.equal(takeover.value.previousSha256, proof.request.eventHeadSha256);
  assert.equal(loaded.events[loaded.events.indexOf(observed) - 1]?.sha256, takeover.sha256);
  assert.deepEqual(observed.value.owner, takeover.value.owner);
  assert.equal(takeover.value.previousLeaseSha256, proof.previousLeaseSha256);
  assert.deepEqual(takeover.value.previousOwner, proof.previousOwner);
  const main = loaded.events.filter(item => item.value.kind === 'phase_result' && item.value.phase === 'main-build'
    && item.value.sequence < takeover.value.sequence).at(-1);
  assert.ok(main && main.value.outcome === 'succeeded', 'Only a completed successful main build may authorize a read-only successor');
  assert.equal((loaded.derivedState.guardBuildTailRetry || loaded.derivedState.guardBuildTail)?.status, 'completed');
  return { loaded, readerRecord: observed };
}
export function guardBuildTailRuntime(m) {
  const context = currentReleaseContext(), runtime = context?.guardBuildTail;
  if (!runtime) return null;
  assert.equal(runtime.schema, 'sd2-release-guard-build-tail-runtime.v1');
  assert.ok(TAIL_PHASES.includes(runtime.phase));
  assert.match(runtime.continuationSha256 || '', /^[a-f0-9]{64}$/);
  const bytes = rootFile(runtime.proofFile), proof = JSON.parse(bytes);
  assert.equal(sha(bytes), runtime.continuationSha256); assert.deepEqual(proof, runtime.proof);
  assert.equal(proof.schema, 'sd2-release-guard-build-tail-proof.v1');
  assert.equal(proof.runId, m.runId); assert.equal(proof.taskId, m.operation.taskId);
  assert.equal(proof.attemptId, m.operation.attemptId); assert.deepEqual(proof.engine, m.engine);
  assert.equal(proof.manifestSha256, sha(rootFile(m.stage + '/manifest.json')));
  assert.equal(proof.engine.root, engineDirectory(m)); assert.equal(proof.originalCompiledSnapshotUnavailable, true);
  processorBytes(proof, m); let active = proof;
  if (runtime.retry) {
    const retry = runtime.retry;
    assert.equal(retry.schema, 'sd2-release-guard-build-tail-retry-runtime.v1');
    assert.match(retry.proofSha256 || '', /^[a-f0-9]{64}$/);
    const retryBytes = rootFile(retry.proofFile), retryProof = JSON.parse(retryBytes);
    assert.equal(sha(retryBytes), retry.proofSha256); assert.deepEqual(retryProof, retry.proof);
    assert.equal(retryProof.schema, 'sd2-release-guard-build-tail-retry-proof.v1');
    assert.equal(retryProof.originalContinuationSha256, runtime.continuationSha256); assert.equal(retryProof.originalProofFile, runtime.proofFile);
    for (const name of ['runId', 'taskId', 'attemptId', 'manifestSha256']) assert.equal(retryProof[name], proof[name]);
    assert.deepEqual(retryProof.engine, proof.engine); processorBytes(retryProof, m); active = retryProof;
  }
  if (runtime.reader) {
    assert.ok(READER_PHASES.includes(runtime.phase), 'A successor reader cannot build or finish a build tail');
    assert.deepEqual(context.contract.engine, m.engine); assert.deepEqual(context.contract.operation, m.operation);
    assert.equal(runtime.reader.schema, 'sd2-release-reader-successor-runtime.v1');
    const reader = runtimeRootProof(runtime.reader, 'reader-successor-', 'sd2-release-reader-successor-proof.v1', m);
    assert.equal(reader.originalContinuationSha256, runtime.continuationSha256);
    assert.equal(reader.retryProofSha256, runtime.retry?.proofSha256 || null);
    assert.deepEqual(reader.predecessorProcessor, active.processor);
    assert.equal(reader.buildAuthority, false);
    assert.equal(reader.originalProofFile, runtime.proofFile); assert.equal(reader.retryProofFile, runtime.retry?.proofFile);
    assert.equal(reader.request.predecessorControllerSetSha256, active.processor.controllerSetSha256);
    assert.equal(reader.request.processorControllerSetSha256, reader.processor.controllerSetSha256);
    assert.equal(reader.request.originalContinuationSha256, runtime.continuationSha256);
    assert.equal(reader.request.retryProofSha256, runtime.retry?.proofSha256 || null);
    for (const name of ['batchFile', 'batchSha256', 'contextSha256', 'seedSha256', 'artifactsSha256']) assert.equal(reader[name], active[name]);
    processorBytes(reader, m); successorJournal(m, runtime); active = reader;
  } else assert.equal(runtime.candidateObservation, undefined, 'Independent observation requires its authorized reader');
  assert.equal(path.dirname(fileURLToPath(import.meta.url)), active.processor.root);
  return runtime;
}

export function candidateCompatibilityDirectory(m) {
  const runtime = guardBuildTailRuntime(m);
  return (runtime?.reader?.proof || runtime?.retry?.proof || runtime?.proof)?.processor.root || engineDirectory(m);
}

export function assertGuardBuildTailObservation(value, m, now = Date.now(), { requireFresh = true } = {}) {
  const runtime = guardBuildTailRuntime(m);
  assert.ok(runtime, 'Guard tail evidence requires its journal-bound compatible reader');
  const tail = value.tailPostchecks, request = runtime.proof.request;
  assert.equal(value.schema, GUARD_BUILD_TAIL_SCHEMA); assert.equal(value.label, 'guard');
  assert.equal(value.helperProbePhase, 'prepare');
  assert.equal(tail?.schema, 'sd2-guard-build-tail-seal.v1');
  assert.equal(tail.continuationSha256, runtime.continuationSha256); assert.equal(tail.proofFile, runtime.proofFile);
  if (runtime.retry) {
    assert.equal(tail.retryProofSha256, runtime.retry.proofSha256);
    assert.equal(tail.retryProofFile, runtime.retry.proofFile);
    const retryObservedAt = Date.parse(runtime.retry.proof.observedAt);
    assert.ok(Number.isSafeInteger(retryObservedAt) && tail.observedAt >= retryObservedAt);
  } else {
    assert.equal(tail.retryProofSha256, undefined); assert.equal(tail.retryProofFile, undefined);
  }
  assert.equal(tail.retainedOriginalCommand, true); assert.equal(tail.originalCompiledSnapshotUnavailable, true);
  assert.equal(tail.originalBuildCommandSha256, request.buildCommandSha256);
  assert.equal(value.logSha256, request.buildLogSha256);
  assert.equal(value.compiledTreeSha256, request.observedCompiledTreeSha256);
  assert.equal(value.startedAt, runtime.proof.originalBuild.startedAt);
  assert.equal(value.finishedAt, runtime.proof.originalBuild.finishedAt);
  assert.equal(value.build, runtime.proof.originalBuild.build);
  const requestObservedAt = typeof request.observedAt === 'number' ? request.observedAt : Date.parse(request.observedAt);
  assert.ok(Number.isSafeInteger(requestObservedAt));
  assert.ok(Number.isSafeInteger(tail.observedAt) && tail.observedAt >= value.finishedAt
    && tail.observedAt >= requestObservedAt && tail.observedAt <= now);
  assert.equal(tail.expiresAt, tail.observedAt + 1800000);
  if (requireFresh) assert.ok(now < tail.expiresAt, 'Guard tail observation expired; do not relabel its original successful command');
  return tail;
}

// A reader authorization never changes freshness. This independent root
// observation binds the full predecessor-verified immutable snapshots and the
// original receipts, while explicitly making no continuous-interval claim.
export function assertCandidateObservation(value, m, kind, now = Date.now()) {
  if (!isSharedEngine(m) || m.reuseBuilds) return null;
  const runtime = guardBuildTailRuntime(m), reference = runtime?.candidateObservation;
  if (!reference) return null;
  assert.ok(['main', 'guard'].includes(kind)); assert.ok(runtime.reader);
  assert.equal(reference.schema, 'sd2-release-candidate-observation-runtime.v1');
  const proof = runtimeRootProof(reference, 'candidate-observation-', CANDIDATE_OBSERVATION_SCHEMA, m);
  assert.equal(proof.originalContinuationSha256, runtime.continuationSha256);
  assert.equal(proof.retryProofSha256, runtime.retry?.proofSha256 || null);
  assert.equal(proof.readerProofSha256, runtime.reader.proofSha256);
  assert.equal(proof.eventHeadSha256, runtime.reader.proof.eventHeadSha256);
  const { loaded, readerRecord } = successorJournal(m, runtime);
  const observations = loaded.events.filter(item => item.value.kind === 'observation' && item.value.name === 'candidate_observation');
  assert.equal(observations.length, 1);
  const journal = observations[0]; assert.ok(journal.value.sequence > readerRecord.value.sequence);
  assert.equal(journal.value.previousSha256, readerRecord.sha256); assert.deepEqual(journal.value.owner, readerRecord.value.owner);
  assert.deepEqual(journal.value.value, { schema: 'sd2-release-candidate-observation-reference.v1', proofFile: reference.proofFile, proofSha256: reference.proofSha256 });
  for (const [flag, expected] of Object.entries({ readOnly: true, newCompilationClaimed: false, originalTimesChanged: false,
    continuousUnchangedIntervalClaimed: false })) assert.equal(proof[flag], expected);
  assert.equal(proof.protectionComparison, 'assertProtection'); assert.deepEqual(proof.protectionFields, PROTECTION_FIELDS);
  assert.match(proof.protectionSha256 || '', /^[a-f0-9]{64}$/);
  const predecessor = runtime.retry?.proof || runtime.proof, verifier = proof.verifier;
  assert.equal(verifier.method, 'verifyOriginalSuccess'); assert.equal(verifier.file, predecessor.processor.root + '/candidate-reuse.mjs');
  assert.equal(verifier.sha256, predecessor.processorControllers['candidate-reuse.mjs']);
  assert.equal(sha(rootFile(verifier.file)), verifier.sha256);
  assert.ok(Number.isSafeInteger(verifier.startedAt) && verifier.startedAt > 0 && Number.isSafeInteger(verifier.finishedAt)
    && verifier.finishedAt >= verifier.startedAt && verifier.finishedAt === proof.observedAt && verifier.finishedAt <= now);
  assert.equal(proof.expiresAt, proof.observedAt + 1800000);
  assert.ok(now < proof.expiresAt, 'Independent candidate observation expired');
  assert.deepEqual(Object.keys(proof.candidates).sort(), ['guard', 'main']);
  for (const role of ['main', 'guard']) {
    const record = proof.candidates[role], authorized = runtime.reader.proof.successfulArtifacts[role].inputs;
    assert.equal(record.capsuleFile, authorized.capsule.file); assert.equal(record.capsuleSha256, authorized.capsule.sha256);
    assert.equal(record.receiptFile, authorized.build.file); assert.equal(record.receiptSha256, authorized.build.sha256);
    assert.equal(record.capsuleFile, m.stage + '/' + role + '-immutable-success.json');
    const capsuleBytes = rootFile(record.capsuleFile, 128 * 1024 * 1024), capsule = JSON.parse(capsuleBytes);
    assert.equal(sha(capsuleBytes), record.capsuleSha256);
    assert.equal(capsule.kind, role); assert.equal(capsule.sourceRun, m.runId);
    assert.equal(capsule.originalManifestSha256, proof.manifestSha256);
    assert.equal(record.receiptFile, m.stage + '/' + role + '-build.json');
    assert.equal(capsule.originalReceiptFile, record.receiptFile); assert.equal(capsule.originalReceiptSha256, record.receiptSha256);
    const receiptBytes = rootFile(record.receiptFile), receipt = JSON.parse(receiptBytes);
    assert.equal(sha(receiptBytes), record.receiptSha256); assert.deepEqual(capsule.originalReceipt, receipt);
    assert.equal(receipt.source, m[role].source); assert.equal(receipt.version, m[role].version); assert.equal(receipt.label, role);
    assert.equal(receipt.runId, m.runId); assert.equal(receipt.exitCode, 0); assert.equal(receipt.verifiedSourceAndGates, true);
    assert.ok(receipt.startedAt <= receipt.finishedAt && receipt.finishedAt <= verifier.startedAt);
    assert.equal(capsule.originalTimesChanged, false); assert.equal(capsule.newCompilationClaimed, false);
    assert.equal(capsule.originalSourceManifestSha256, sha(rootFile(m[role].sourceManifest)));
    assert.equal(capsule.originalPreparedSha256, sha(rootFile(m.stage + '/' + role + '-prepared.json')));
    for (const field of ['sourceFiles', 'lock', 'dependencies', 'build', 'checks', 'buildEnvironment', 'node', 'env', 'bindings'])
      assert.ok(capsule.snapshot?.[field] && typeof capsule.snapshot[field] === 'object', 'Incomplete freshly verified candidate snapshot: ' + field);
    assert.equal(sha(JSON.stringify(capsule.snapshot)), record.snapshotSha256);
    if (role === kind) assert.deepEqual(value, receipt, 'Independent observation may only admit its exact original successful receipt');
  }
  if (kind === 'guard') assertGuardBuildTailObservation(value, m, now, { requireFresh: false });
  else assert.equal(value.schema, 'rate-impl2-candidate-build.v1');
  return proof;
}
export function candidateGateObservation(value, m, kind, now = Date.now()) {
  const observation = assertCandidateObservation(value, m, kind, now);
  if (observation) {
    const runtime = guardBuildTailRuntime(m);
    return { manifest: m, runtime, observedAt: observation.observedAt, candidateObservation: runtime.candidateObservation };
  }
  if (kind !== 'guard' || value.schema !== GUARD_BUILD_TAIL_SCHEMA) return undefined;
  const runtime = guardBuildTailRuntime(m); assert.ok(runtime);
  return { manifest: m, runtime, observedAt: value.tailPostchecks?.observedAt ?? now };
}

export function candidateEvidenceExpiresAt(value, m, kind, now = Date.now()) {
  const observation = assertCandidateObservation(value, m, kind, now);
  if (observation) return observation.expiresAt;
  if (!m.reuseBuilds && kind === 'guard' && value.schema === GUARD_BUILD_TAIL_SCHEMA)
    return assertGuardBuildTailObservation(value, m, now).expiresAt;
  return m.reuseBuilds ? value.expiresAt : value.startedAt + 1800000;
}
export function candidateEvidenceFile(m, kind) {
  assert.ok(['main', 'guard'].includes(kind));
  return m.stage + '/' + kind + (m.reuseBuilds ? '-candidate-reuse.json' : '-build.json');
}
export function assertFreshCandidateEvidence(value, m, kind, now = Date.now()) {
  if (isSharedEngine(m)) {
    engineDirectory(m);
    assert.deepEqual(value.engine, m.engine, 'Candidate admission belongs to another engine controller set');
    assert.deepEqual(value.operation, m.operation, 'Candidate admission belongs to another task or attempt');
  }
  assert.equal(value.label, kind); assert.equal(value.runId, m.runId);
  assert.equal(value.source, m[kind].source); assert.equal(value.version, m[kind].version);
  assert.equal(value.exitCode, 0); assert.equal(value.verifiedSourceAndGates, true);
  assert.ok(Number.isSafeInteger(value.startedAt) && value.startedAt > 0 && Number.isSafeInteger(value.finishedAt)
    && value.startedAt <= value.finishedAt && value.finishedAt <= now);
  if (assertCandidateObservation(value, m, kind, now)) return value;
  if (!m.reuseBuilds) {
    if (kind === 'guard' && value.schema === GUARD_BUILD_TAIL_SCHEMA) {
      assertGuardBuildTailObservation(value, m, now); return value;
    }
    assert.equal(value.schema, 'rate-impl2-candidate-build.v1');
    assert.ok(now - value.startedAt < 1800000, 'Original full-build candidate gate is stale'); return value;
  }
  assert.equal(value.schema, REUSE_SCHEMA); assert.equal(value.newCompilationClaimed, false);
  assert.equal(value.originalTimesChanged, false); assert.equal(value.reuseInputsFullyVerified, true);
  assert.equal(value.originalSuccessSha256, m.reuseBuilds[kind].sha256);
  const original = value.originalBuild; assert.ok(original && original.runId !== m.runId);
  assert.equal(original.runId, m.reuseBuilds.sourceRun);
  for (const key of ['source', 'version', 'build', 'startedAt', 'finishedAt', 'gateReceipt']) assert.deepEqual(value[key], original[key]);
  assert.equal(original.exitCode, 0); assert.equal(original.verifiedSourceAndGates, true);
  assert.ok(Number.isSafeInteger(value.validatedAt) && value.validatedAt >= value.finishedAt && value.validatedAt <= now);
  assert.equal(value.expiresAt, value.validatedAt + 1800000);
  assert.ok(now < value.expiresAt, 'Fresh candidate reuse admission expired; a new integrity/contract check is required, not an automatic full compile');
  return value;
}
