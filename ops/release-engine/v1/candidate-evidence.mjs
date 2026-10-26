import assert from 'node:assert/strict';
import { isSharedEngine, engineDirectory } from './common.mjs';

export const REUSE_SCHEMA = 'sd2-candidate-build-reuse.v1';
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
