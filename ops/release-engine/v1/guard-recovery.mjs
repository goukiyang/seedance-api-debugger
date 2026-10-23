import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertReleaseWindow, rootFile, sha, writeJsonExclusive, call, parseReleaseTimestamp, engineDirectory } from './common.mjs';
import { capturePricingStartControl, PRICING_START_CONTROL, verifyFixedProgramEntry } from './pricing-start-pair.mjs';
import { MV_DIRECT } from './release-contract.mjs';
import { candidateEvidenceFile, assertFreshCandidateEvidence, hdMaintenanceApprovalFile } from './candidate-evidence.mjs';
import { assertOriginalSnapshotStable, assertRuntimeAliasUnchanged } from './candidate-reuse.mjs';

const ROLES = ['web', 'image', 'hd'];
const lockFile = m => m.stage + '/fixed-guard-recovery.json';
const json = file => JSON.parse(rootFile(file));
const exists = file => fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
function snapshot(file) {
  assert.equal(fs.realpathSync(file), file);
  const s = fs.lstatSync(file); assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1);
  assert.equal(s.mode & 0o022, 0, 'Fixed program file is writable outside its captured owner');
  return { dev: String(s.dev), ino: String(s.ino), uid: s.uid, gid: s.gid, mode: s.mode & 0o7777,
    bytes: s.size, sha256: sha(fs.readFileSync(file)) };
}
function relative(file) {
  assert.ok(file && !path.isAbsolute(file) && !file.split('/').some(part => !part || part === '.' || part === '..'));
  return file;
}
function artifact(entry) {
  const source = Object.fromEntries(Object.entries(entry.sourceFiles).map(([file, digest]) => {
    const value = snapshot(path.join(entry.root, relative(file))); assert.equal(value.sha256, digest); return [file, value];
  }));
  const build = Object.fromEntries(Object.entries(entry.buildFiles).map(([file, digest]) => {
    const value = snapshot(path.join(entry.root, '.next-prod-candidate', relative(file))); assert.equal(value.sha256, digest); return [file, value];
  }));
  assert.ok(Object.keys(source).length > 100 && Object.keys(build).length > 10);
  assert.equal(fs.readFileSync(entry.root + '/.deployed-commit', 'utf8').trim(), entry.source);
  assert.equal(JSON.parse(fs.readFileSync(entry.root + '/package.json')).version, entry.version);
  assert.equal(fs.realpathSync(entry.root + '/.next-prod'), entry.root + '/.next-prod-candidate');
  assert.equal(fs.readFileSync(entry.root + '/.next-prod/BUILD_ID', 'utf8').trim(), entry.build);
  const roots = [entry.root, entry.root + '/node_modules', entry.root + '/.next-prod-candidate'];
  const directories = Object.fromEntries(roots.map(file => {
    const s = fs.lstatSync(file); assert.ok(s.isDirectory() && !s.isSymbolicLink() && !(s.mode & 0o022));
    assert.equal(fs.realpathSync(file), file);
    return [file, { dev: String(s.dev), ino: String(s.ino), uid: s.uid, gid: s.gid, mode: s.mode & 0o7777 }];
  }));
  return { source, build, directories };
}
export function inspectFixedGuardArtifact(entry) { return artifact(entry); }
function trustedContext(m) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  assert.equal(m.runId, MV_DIRECT.recoveryRunId); assert.equal(m.mainSource, MV_DIRECT.mainSource);
  assert.equal(m.guardSource, MV_DIRECT.recoveryGuardSource);
  assert.equal(m.stage, '/data/video-api-debugger/release-staging/' + m.runId);
  assert.equal(call('findmnt', ['-n', '-o', 'TARGET', '-T', m.stage]), '/data');
  const bytes = rootFile(m.stage + '/manifest.json'); assert.deepEqual(JSON.parse(bytes), m);
  for (const [name, digest] of Object.entries(m.privateSha256)) {
    assert.equal(path.basename(name), name); assert.equal(sha(rootFile(engineDirectory(m) + '/' + name)), digest);
  }
  return sha(bytes);
}
export function armGuardRecovery(m, { before, pair, builds }) {
  const manifestSha256 = trustedContext(m); assertReleaseWindow(m);
  assert.equal(exists(m.stage + '/nginx-' + m.runId + '-installed.json'), false);
  assert.equal(exists(m.stage + '/natural-stop-intent-switch-web.json'), false);
  assert.equal(pair.runId, m.runId); assert.equal(pair.manifestSha256, manifestSha256);
  for (const kind of ['main', 'guard']) {
    const receipt = builds[kind]; assert.equal(receipt.runId, m.runId); assert.equal(receipt.manifestSha256, manifestSha256);
    assert.equal(receipt.source, m[kind].source); assert.equal(receipt.exitCode, 0); assert.equal(receipt.verifiedSourceAndGates, true);
    assertFreshCandidateEvidence(receipt, m, kind);
    assert.deepEqual(json(candidateEvidenceFile(m, kind)), receipt);
  }
  const entry = pair.allowed.releases.find(item => item.source === m.guardSource);
  assert.ok(entry); assert.equal(entry.root, m.guard.root); assert.equal(entry.build, builds.guard.build);
  verifyFixedProgramEntry(entry);
  const approval = json(hdMaintenanceApprovalFile(m)), now = Date.now();
  const issued = parseReleaseTimestamp(approval.issuedAt), expires = parseReleaseTimestamp(approval.expiresAt);
  assert.equal(approval.runId, m.runId); assert.equal(approval.manifestSha256, manifestSha256);
  assert.equal(approval.windowSha256, sha(rootFile(m.windowFile)));
  assert.equal(approval.guardBuildReceiptSha256, sha(rootFile(candidateEvidenceFile(m, 'guard'))));
  assert.ok(Number.isFinite(issued) && Number.isFinite(expires) && issued <= now && now < expires && expires - issued <= 300000);
  const value = { schema: 'mv-hd-upload-fixed-guard-recovery.v1', runId: m.runId, manifestSha256,
    authorization: 'Supervisor explicit one-batch fixed compatible guard recovery contract; no general release-age exception',
    armedAt: new Date().toISOString(), originalGuardBuild: builds.guard,
    approvalReceiptSha256: sha(rootFile(hdMaintenanceApprovalFile(m))),
    originalWindowSha256: sha(rootFile(m.windowFile)),
    guardBuildReceiptSha256: sha(rootFile(candidateEvidenceFile(m, 'guard'))), guardEntry: entry,
    candidateEvidenceKind: builds.guard.schema, originalFullGuardBuild: builds.guard.originalBuild || builds.guard,
    artifact: artifact(entry), pair, originalControl: before.captured,
    bindings: { storage: m.storageRoot, uploads: m.uploadsRoot, videos: m.videosRoot, env: m.envFile, hd: m.hdRoot },
    onlyOperation: 'recover-this-guard-after-this-run-failure', continueMain: false, replaceGuard: false,
    normalPublicationWindowAndBuildAgeUnchanged: true };
  assertReleaseWindow(m); writeJsonExclusive(lockFile(m), value);
  call('chattr', ['+i', lockFile(m)]);
  return { file: lockFile(m), sha256: sha(rootFile(lockFile(m))), source: entry.source, build: entry.build,
    originalBuildStartedAt: builds.guard.startedAt, freshAdmissionOnly: true };
}
export function readGuardRecovery(m) {
  const manifestSha256 = trustedContext(m), file = lockFile(m), value = json(file);
  assert.equal(value.schema, 'mv-hd-upload-fixed-guard-recovery.v1'); assert.equal(value.runId, m.runId);
  assert.equal(value.manifestSha256, manifestSha256); assert.equal(value.guardEntry.source, m.guardSource);
  assert.equal(value.guardEntry.root, m.guard.root); assert.equal(value.onlyOperation, 'recover-this-guard-after-this-run-failure');
  assert.equal(value.continueMain, false); assert.equal(value.replaceGuard, false);
  assert.ok(call('lsattr', ['-d', '--', file]).split(/\s+/)[0].includes('i'));
  assert.equal(sha(rootFile(candidateEvidenceFile(m, 'guard'))), value.guardBuildReceiptSha256);
  assert.deepEqual(json(candidateEvidenceFile(m, 'guard')), value.originalGuardBuild);
  assert.equal(value.originalGuardBuild.exitCode, 0); assert.equal(value.originalGuardBuild.verifiedSourceAndGates, true);
  assert.equal(value.originalGuardBuild.build, value.guardEntry.build);
  assert.equal(sha(rootFile(hdMaintenanceApprovalFile(m))), value.approvalReceiptSha256);
  return value;
}
export function inspectGuardRecoveryControl(m, before) {
  const value = readGuardRecovery(m);
  const control = capturePricingStartControl({ verifyReleases: false });
  for (const key of ['control', 'guard', 'marker', 'chain']) assert.deepEqual(control[key], value.originalControl[key]);
  assert.equal(value.manifestSha256, before.manifestSha256);
  const allowed = JSON.parse(Buffer.from(control.allowed.bytesBase64, 'base64'));
  const original = control.allowed.sha256 === value.originalControl.allowed.sha256;
  if (original) assert.deepEqual(control.allowed, value.originalControl.allowed);
  else {
    const omitTime = input => { const copy = structuredClone(input); delete copy.at; return copy; };
    assert.deepEqual(omitTime(allowed), omitTime(value.pair.allowed), 'Another release changed the startup pair');
  }
  return { value, control, originalPair: original, originalBuildMayBeOld: Date.now() - value.originalGuardBuild.startedAt >= 1800000,
    candidateFreshGateClaimed: false, verifiedAt: new Date().toISOString() };
}
export function verifyGuardRecovery(m, before) {
  const verified = inspectGuardRecoveryControl(m, before), { value } = verified;
  if (m.reuseBuilds) {
    assertOriginalSnapshotStable(m, 'guard');
    assertRuntimeAliasUnchanged(m, 'guard', value.originalGuardBuild.runtimeAlias);
  }
  verifyFixedProgramEntry(value.guardEntry);
  assert.deepEqual(artifact(value.guardEntry), value.artifact, 'Fixed guard bytes or permissions changed');
  for (const [alias, target] of Object.entries({ storage: m.storageRoot, 'public/uploads': m.uploadsRoot,
    'public/videos': m.videosRoot, '.env': m.envFile })) {
    const file = path.join(m.guard.root, alias); assert.ok(fs.lstatSync(file).isSymbolicLink());
    assert.equal(fs.readlinkSync(file), target); assert.equal(fs.realpathSync(file), fs.realpathSync(target));
  }
  return verified;
}
export function guardRecoveryRoute({ certificate, startIntent, originalPair, fencePhase, fenceRestorePhase, webStopRequested }) {
  if (certificate || startIntent || !originalPair) return ['verified', 'restored'].includes(fencePhase) ? 'fixed-guard' : 'reject-unknown-stage';
  if (!fencePhase || fencePhase === 'prepared') return webStopRequested ? 'reject-unknown-stage' : 'original-before-fence';
  if (fencePhase === 'failed-keep-fence' && !webStopRequested) return 'original-after-fence-abort';
  if (fencePhase === 'restored' && fenceRestorePhase === 'pre-stop-installation-abort' && !webStopRequested) return 'original-after-fence-abort';
  if (['verified', 'restored'].includes(fencePhase)) return 'fixed-guard';
  return 'reject-unknown-stage';
}

// The controller supplies real operations; explicit isolated adapters exercise
// the same ordering without a native fallback or a business request.
export async function runGuardRecovery(context, io) {
  const { m, before } = context;
  const admission = await io.readAdmission(m, before);
  const state = await io.observe(context), route = guardRecoveryRoute(state);
  assert.notEqual(route, 'reject-unknown-stage', 'Unknown fence/writer stage; preserve the safety state');
  if (route === 'fixed-guard') await io.verifyFixedGuard(m, before);
  const record = { schema: 'mv-hd-upload-fault-recovery.v1', runId: m.runId, route,
    startedAt: new Date().toISOString(), originalBuildStartedAt: admission.value.originalGuardBuild.startedAt,
    originalBuildMayBeOld: admission.originalBuildMayBeOld, candidateFreshGateClaimed: false,
    businessDataRestored: false, originalFailure: String(context.error) };
  await io.record('begin', record);
  if (route !== 'fixed-guard') {
    await io.ensureNoForce(context);
    if (route === 'original-after-fence-abort') await io.restoreOriginalNetwork(context, admission);
    const result = await io.restoreOriginal(context, admission);
    return io.record('complete', { ...record, ...result, completed: true, finishedAt: new Date().toISOString() });
  }
  await io.closeIngress(context);
  await io.ensureNoForce(context);
  await io.drainKnownProcesses(context);
  await io.assertAllGone(context);
  await io.assertDataContract(context);
  const fixed = await io.verifyFixedGuard(m, before);
  await io.ensureFixedPair(context, fixed);
  await io.configureGuard(context, fixed);
  const prestart = await io.actualGuardPrestart(context, fixed);
  await io.restoreGuardNetwork(context, fixed, prestart);
  await io.assertAllGone(context);
  await io.verifyFixedGuard(m, before);
  await io.markGuardStart(context, fixed);
  const healthy = await io.startGuard(context, fixed);
  await io.assertDataContract(context);
  await io.restorePolicies(context, fixed);
  const ingress = await io.openIngress(context, healthy);
  await io.assertDataContract(context, { ingressRestored: true });
  return io.record('complete', { ...record, completed: true, source: m.guardSource, build: fixed.value.guardEntry.build,
    healthy, ingress, originalProofAndReceiptsPreserved: true, finishedAt: new Date().toISOString() });
}

export function markFixedGuardStart(m, before, assertAllGone) {
  const verified = verifyGuardRecovery(m, before); assert.equal(verified.originalPair, false); assertAllGone();
  const file = PRICING_START_CONTROL + '/start-' + m.runId + '.json';
  if (exists(file)) {
    const value = json(file); assert.equal(value.runId, m.runId); assert.equal(value.allowedSha256, verified.control.allowed.sha256);
    return { file, sha256: sha(rootFile(file)), retainedExistingLatch: true };
  }
  const body = { schema: 'pricing-compatible-recovery-start-intent.v1', runId: m.runId,
    allowedSha256: verified.control.allowed.sha256, guardSource: m.guardSource, build: verified.value.guardEntry.build,
    fixedRecoverySha256: sha(rootFile(lockFile(m))), issuedAt: new Date().toISOString(), nonce: randomUUID(), onlyGuard: true };
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o440);
  try { fs.writeFileSync(fd, JSON.stringify(body) + '\n'); fs.fchownSync(fd, 0, verified.control.allowed.gid); fs.fchmodSync(fd, 0o440); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const directory = fs.openSync(PRICING_START_CONTROL, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  return { file, sha256: sha(rootFile(file)), retainedExistingLatch: false };
}
