import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootFile, sha, assertReleaseWindow, validateManifest, parseReleaseTimestamp, engineDirectory } from './common.mjs';
import { createHdReleaseSafety, prepareOperationFenceModule } from './cutover-safety.mjs';
import { readGuardRecovery } from './guard-recovery.mjs';
import { candidateEvidenceFile, REUSE_SCHEMA } from './candidate-evidence.mjs';

export const HD_MAINTENANCE_APPROVAL_SCHEMA = 'hd-release-maintenance-approval.v1';
export const privateFreezeSha256 = m => sha(Buffer.from(JSON.stringify(m.privateSha256)));

// This is an internal source/window-bound authorization receipt. It cannot be
// enabled by an HTTP request, an environment variable or a client-supplied mode.
export function assertHdMaintenanceApproval(m, approval, { now = Date.now(), manifestSha256, windowSha256,
  mainBuildReceiptSha256, guardBuildReceiptSha256 } = {}) {
  assert.ok(approval && typeof approval === 'object' && !Array.isArray(approval));
  for (const digest of [manifestSha256, windowSha256, mainBuildReceiptSha256, guardBuildReceiptSha256])
    assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(approval.schema, HD_MAINTENANCE_APPROVAL_SCHEMA);
  for (const key of ['runId', 'mainSource', 'guardSource']) assert.equal(approval[key], m[key]);
  assert.equal(approval.manifestSha256, manifestSha256);
  assert.equal(approval.privateFreezeSha256, privateFreezeSha256(m));
  assert.equal(approval.windowSha256, windowSha256);
  assert.equal(approval.mainBuildReceiptSha256, mainBuildReceiptSha256);
  assert.equal(approval.guardBuildReceiptSha256, guardBuildReceiptSha256);
  if (m.reuseBuilds) assert.equal(approval.candidateEvidenceKind, REUSE_SCHEMA);
  const issued = parseReleaseTimestamp(approval.issuedAt), expires = parseReleaseTimestamp(approval.expiresAt);
  assert.ok(Number.isSafeInteger(now) && Number.isSafeInteger(issued) && Number.isSafeInteger(expires) && issued <= now && now < expires
    && expires > issued && expires - issued <= 300000, 'Maintenance approval expired or malformed');
  assert.equal(approval.manualMaintenanceConfirmed, true);
  assert.equal(approval.allowCompatibleRollback, true);
  assert.deepEqual(approval.operations, ['switch', 'rollback-to-compatible-guard']);
  assert.equal(approval.writerFence?.install, true);
  assert.equal(approval.writerFence?.helperSha256, m.privateSha256['writer-network-fence.mjs']);
  assert.deepEqual(approval.writerFence?.restorePhases,
    ['pre-stop-installation-abort', 'before-new-writer-after-proven-old-stop']);
  return approval;
}

export async function loadHdReleaseSafety(m, mode) {
  validateManifest(m); assert.ok(['switch', 'rollback', 'recovery'].includes(mode));
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  assert.equal(process.umask(), 0o022, 'Use the original prepared-input/probe directory umask022 contract');
  const directory = path.dirname(fileURLToPath(import.meta.url));
  assert.equal(directory, engineDirectory(m));
  assert.deepEqual(fs.readdirSync(directory).filter(file => file.endsWith('.mjs')).sort(), Object.keys(m.privateSha256).sort());
  for (const [file, expected] of Object.entries(m.privateSha256)) {
    assert.equal(path.basename(file), file); assert.match(expected, /^[a-f0-9]{64}$/);
    assert.equal(sha(rootFile(path.join(directory, file))), expected, 'Frozen private release source changed: ' + file);
  }
  const manifestSha256 = sha(rootFile(m.stage + '/manifest.json'));
  const approvalFile = m.stage + '/hd-release-safety-approval.json';
  const approvalBytes = rootFile(approvalFile, 65536), approval = JSON.parse(approvalBytes);
  if (mode === 'recovery') {
    const fixed = readGuardRecovery(m);
    assert.equal(fixed.manifestSha256, manifestSha256);
    assert.equal(fixed.approvalReceiptSha256, sha(approvalBytes));
    assert.equal(approval.runId, m.runId); assert.equal(approval.guardSource, fixed.guardEntry.source);
    assert.equal(approval.manifestSha256, manifestSha256); assert.equal(approval.privateFreezeSha256, privateFreezeSha256(m));
  } else {
    assertReleaseWindow(m);
    assertHdMaintenanceApproval(m, approval, {
      manifestSha256,
      windowSha256: sha(rootFile(m.windowFile)), mainBuildReceiptSha256: sha(rootFile(candidateEvidenceFile(m, 'main'))),
      guardBuildReceiptSha256: sha(rootFile(candidateEvidenceFile(m, 'guard'))),
    });
  }
  const operationStage = m.stage + '/hd-release-safety-r03';
  if (!fs.existsSync(operationStage)) fs.mkdirSync(operationStage, { mode: 0o700 });
  const stat = fs.lstatSync(operationStage);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o7777) === 0o700);
  assert.equal(fs.realpathSync(operationStage), operationStage);
  const nativeFenceModule = await prepareOperationFenceModule(m);
  return createHdReleaseSafety({ m, manifestSha256, approval, approvalSha256: sha(approvalBytes), nativeFenceModule });
}
