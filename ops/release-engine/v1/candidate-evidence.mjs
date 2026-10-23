import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSharedEngine, engineDirectory, rootFile, sha } from './common.mjs';
import { currentReleaseContext } from './engine-context.mjs';

export const REUSE_SCHEMA = 'sd2-candidate-build-reuse.v1';
export const GUARD_BUILD_TAIL_SCHEMA = 'sd2-candidate-build-tail.v1';
const TAIL_PHASES = ['guard-build', 'main-build', 'verify', 'arm', 'switch', 'proof', 'recovery'];

export function guardBuildTailRuntime(m) {
  const runtime = currentReleaseContext()?.guardBuildTail;
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
  assert.equal(proof.engine.root, engineDirectory(m));
  assert.equal(proof.originalCompiledSnapshotUnavailable, true);
  let active = proof;
  if (runtime.retry) {
    const retry = runtime.retry;
    assert.equal(retry.schema, 'sd2-release-guard-build-tail-retry-runtime.v1');
    assert.match(retry.proofSha256 || '', /^[a-f0-9]{64}$/);
    const retryBytes = rootFile(retry.proofFile), retryProof = JSON.parse(retryBytes);
    assert.equal(sha(retryBytes), retry.proofSha256); assert.deepEqual(retryProof, retry.proof);
    assert.equal(retryProof.schema, 'sd2-release-guard-build-tail-retry-proof.v1');
    assert.equal(retryProof.originalContinuationSha256, runtime.continuationSha256);
    assert.equal(retryProof.originalProofFile, runtime.proofFile);
    for (const name of ['runId', 'taskId', 'attemptId', 'manifestSha256']) assert.equal(retryProof[name], proof[name]);
    assert.deepEqual(retryProof.engine, proof.engine);
    active = retryProof;
  }
  assert.equal(path.dirname(fileURLToPath(import.meta.url)), active.processor.root);
  assert.notEqual(active.processor.root, proof.engine.root);
  assert.deepEqual(Object.keys(active.processorControllers).sort(), Object.keys(m.privateSha256).sort());
  assert.equal(sha(JSON.stringify(active.processorControllers)), active.processor.controllerSetSha256);
  for (const [name, expected] of Object.entries(active.processorControllers)) {
    assert.equal(path.basename(name), name); assert.match(expected, /^[a-f0-9]{64}$/);
    assert.equal(sha(rootFile(active.processor.root + '/' + name)), expected, 'Compatible guard-tail reader changed: ' + name);
  }
  return runtime;
}

export function candidateCompatibilityDirectory(m) {
  const runtime = guardBuildTailRuntime(m);
  return (runtime?.retry?.proof || runtime?.proof)?.processor.root || engineDirectory(m);
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

export function candidateEvidenceExpiresAt(value, m, kind, now = Date.now()) {
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
