import assert from 'node:assert/strict';
import { sha, rootFile, writeJsonExclusive } from './common.mjs';
import { CERTIFICATE, inspectRecoveryCertificate } from './certificate.mjs';

export function assertRetainedUploadCertificate(existing) {
  assert.equal(existing.schema, 'raw-upload-retired-writer-proof.v1');
  assert.equal(existing.runId, '36c11143-e1aa-48a4-a801-fe439d2d91ff');
  assert.equal(existing.oldWritersDrained, true);
  assert.equal(existing.source, 'aa5e1681d5e677ff5fdd96e78eac6fb7e47e6fa4');
  assert.equal(existing.guardSource, 'fdd5b70722a118c62b67729c399fe1cdc2b8d4fe');
}

export function inspectRetainedUploadProof(m, before) {
  const captured = inspectRecoveryCertificate(m, before);
  assert.equal(captured.retained, true); assert.equal(captured.createdByThisRun, false);
  const existingFile = CERTIFICATE;
  const existingBytes = rootFile(existingFile);
  assert.equal(sha(existingBytes), m.expectedProtectedFileSha256[existingFile]);
  const existing = JSON.parse(existingBytes);
  assertRetainedUploadCertificate(existing);
  return { runId: m.runId, file: existingFile, sha256: sha(existingBytes),
    originalRunId: existing.runId, retainedUnchanged: true, certified: 0, productionStateChanges: 0, mediaWrites: 0 };
}

export function issueRawUploadRecoveryProof(m, { before, assertWritersStopped, published }) {
  assert.equal(process.getuid(), 0); assertWritersStopped();
  assert.ok(published, 'The startup pair must be published after all captured writers stopped');
  // Preserve the historical certificate, not a new claim about this run's writers.
  const kept = inspectRetainedUploadProof(m, before);
  writeJsonExclusive(m.stage + '/raw-upload-recovery-proof.json', kept);
  assertWritersStopped();
  return kept;
}
