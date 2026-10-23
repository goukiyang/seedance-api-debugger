import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const CERTIFICATE = '/data/video-api-debugger/controls/raw-upload-recovery-v1.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateRecoveryCertificate(m, before, current, phase = 'observe') {
  assert.ok(['observe', 'early-original'].includes(phase));
  const digest = m.expectedProtectedFileSha256[CERTIFICATE];
  const captured = before.protection.files[CERTIFICATE];
  assert.equal(Boolean(digest), Boolean(captured), 'Certificate baseline must be captured consistently');
  if (digest) {
    assert.equal(captured.sha256, digest);
    assert.ok(current, 'The retained certificate is missing');
    assert.deepEqual(current.state, captured, 'Retained certificate identity, permissions or bytes changed');
    assert.equal(current.state.uid, 0);
    assert.ok(current.state.attributes.includes('i'));
    assert.equal(current.value.schema, 'raw-upload-retired-writer-proof.v1');
    return { retained: true, createdByThisRun: false, sha256: digest, originalRunId: current.value.runId };
  }
  if (!current) return { retained: false, createdByThisRun: false, absent: true };
  assert.notEqual(phase, 'early-original', 'A newly issued certificate forbids original-pair recovery');
  assert.equal(current.state.uid, 0);
  assert.ok(current.state.attributes.includes('i'));
  assert.equal(current.value.schema, 'raw-upload-retired-writer-proof.v1');
  assert.equal(current.value.runId, m.runId);
  assert.equal(current.value.guardSource, m.guardSource);
  return { retained: false, createdByThisRun: true, sha256: current.state.sha256 };
}

export function inspectRecoveryCertificate(m, before, options = {}) {
  const stat = fs.lstatSync(CERTIFICATE, { throwIfNoEntry: false });
  let current = null;
  if (stat) {
    assert.equal(fs.realpathSync(CERTIFICATE), CERTIFICATE);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size < 32 * 1024 * 1024);
    const bytes = fs.readFileSync(CERTIFICATE);
    const state = { identity: [String(stat.dev), String(stat.ino)], uid: stat.uid, gid: stat.gid,
      mode: stat.mode & 0o7777, sha256: sha(bytes),
      attributes: execFileSync('lsattr', ['-d', '--', CERTIFICATE], { encoding: 'utf8' }).split(/\s+/)[0] };
    const after = fs.lstatSync(CERTIFICATE);
    for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'])
      assert.equal(after[key], stat[key], 'Certificate changed during the read');
    assert.equal(sha(fs.readFileSync(CERTIFICATE)), state.sha256);
    current = { state, value: JSON.parse(bytes) };
  }
  return validateRecoveryCertificate(m, before, current, options.phase);
}
