import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  runWriterNetworkFenceOfflineFixtures,
  runWriterNetworkRestoreTransitionFixtures,
  WRITER_FENCE_NATIVE_REFERENCE_SHA256,
} from './writer-network-fence.mjs';
import {
  EMPTY_WRITER_DATABASE,
  createBoundedEmptyWriterLock,
  createOfflineEmptyWriterLockAdapter,
  runEmptyWriterLockProtocolFixtures,
  withEmptyWriterLock,
} from './empty-writer-lock.mjs';

// This is a local engineering entry, NOT a production driver. All IO seams
// below are explicit memory adapters. It never selects native IO on a failure.
// Original source identities are provenance, not an execution PASS claim.
export const HD_RELEASE_SAFETY_R03_PROVENANCE = Object.freeze({
  networkSourceSha256: '65b1af6ad353a8a60518521df1bc3a6b838d17e67cdb5cab7dd4c79e6026f88e',
  lockSourceSha256: '2c4d83ef320073533b2c7804ca33ba247f81ef4a0f2a791988ecc022052f2d4d',
  nativeReferenceSummarySha256: '176a543afee11f9835962dde48c92b9390edc34eb68f0b2dc426f0454c779451',
});

// Controller contract:
// 1. Hash ORIGINAL rate-impl2-release.v1 manifest bytes once. Clone to fenceView,
//    adding live.web.{processStartTicks,cgroup,cgroupDev,cgroupIno,dropin},
//    healthUrl, main.cwdBytes and guard.cwdBytes (exact UTF-8 snapshots).
//    assertWriterFenceManifest(fenceView, ORIGINAL_SHA) returns the full binding:
//    original SHA + fenceViewSha256 + fixed operationStage + exact target/pair.
//    Do not mutate fenceView after deriving that binding.
// 2. Root-owned, fsynced, fresh artifacts INSIDE fixed operationStage must contain
//    the ENTIRE binding. Native IO compares artifact SHA, full JSON bytes/body,
//    ownership/mode and <=3s proof freshness, never just a caller's booleans.
// 3. Install preconditions: real this-run two-host ingress503 and
//    ingressAdmissionClosed, imageStopped/imagePromiseSettled, 3302 connections0,
//    no stop intent, shortLock {held:true,kind:'BEGIN IMMEDIATE',syncCount:0,
//    watchdogMs:20000,deadlineAt}. Use withEmptyWriterLock and the established
//    complete ALL-owner PlatformSetting parser as assertNoSynchronousImageAdmissions.
//    Construct shortLock from THAT lease + parser result, not a prior query.
//    Callback is only install+verify <=8s; roll back before waiting for Web stop.
// 4. A restore: failed-keep-fence receipt; explicit pre-stop-installation-abort
//    authority; stopRequested:false; exact active original process/cgroup/pair;
//    pairChanged:false; no runtime transition proof. Never auto-restore unknown.
// 5. B restore: explicit before-new-writer-after-proven-old-stop authority;
//    oldWriterProof has originalProcessGone, oldCgroupGoneOrEmpty, oldCgroupPids:[],
//    inactive/0, noNewWriterStarted, stopRequested and allOldWritersStopped:true.
//    guardsProof has ingressAdmissionClosed/ingress503/noForceStop/imageStopped/
//    imagePromiseSettled/hdStopped/allOldWritersStopped:true and exactly
//    closedMode:'all-old-writers-stopped-ingress-503'. No HOLD/accepted-only.
//    newPairProof contains pairInstalled/execStartPreVerified/
//    restartNoForceProtection:true, actualNewServiceHealthClaimed:false and
//    runtimeDropin:{path: original Web dropin,kind:'main'|'guard',source,root,
//    entry:{uid,gid,mode,nlink,sha256,bytesBase64}}. Entry metadata equals original,
//    bytes equal caller-approved candidate cwdBytes. ALL other dropins, parent
//    policies and filter paths remain exact. Native IO independently rechecks
//    original Web /proc/start/cgroup emptiness both before and after restoring.
//    Controller must independently prove image+HD exits and no new writer;
//    these helpers never infer them from socket0 or inactive alone.
// 6. Only after B restore may controller start already-approved main/guard.
//    Keep both ingress503 until controller's later explicit opening. These
//    helpers never stop/start services, write a pair, reopen ingress, or touch
//    business state. Native requires Linux/Node20/root and no error fallback.

function runLockBindingFixtures() {
  const manifest = { schema: 'rate-impl2-release.v1', runId: 'r03-offline-binding',
    stage: '/data/video-api-debugger/release-staging/r03-offline-binding', database: EMPTY_WRITER_DATABASE };
  const base = { manifest, manifestSha256: 'a'.repeat(64),
    operationStage: manifest.stage + '/hd-release-safety-r03' };
  const checks = [];
  const check = (name, mutate, rejects = false) => {
    const input = { ...base, offlineAdapter: createOfflineEmptyWriterLockAdapter() };
    const operation = () => createBoundedEmptyWriterLock(mutate ? mutate(input) : input);
    if (rejects) assert.throws(operation); else assert.equal(typeof operation().acquire, 'function');
    checks.push(name);
  };
  check('R03 current manifest and exact operationStage accepted');
  check('R03 historical manifest refused', value => ({ ...value,
    manifest: { ...manifest, schema: 'trace03-rate-release-manifest.v1' } }), true);
  check('R03 R02 operationStage refused', value => ({ ...value,
    operationStage: manifest.stage + '/rate-compat-private' }), true);
  check('R03 nested alias operationStage refused', value => ({ ...value,
    operationStage: base.operationStage + '/child' }), true);
  check('R03 original database override refused', value => ({ ...value,
    manifest: { ...manifest, database: '/tmp/not-business.db' } }), true);
  check('R03 original manifest digest required', value => ({ ...value, manifestSha256: '' }), true);
  check('R03 non-explicit offline adapter refused', value => ({ ...value, offlineAdapter: { kind: 'fallback' } }), true);
  return checks;
}

export async function runHdReleaseSafetyEngineering() {
  const network = runWriterNetworkFenceOfflineFixtures();
  const restore = await runWriterNetworkRestoreTransitionFixtures();
  const lock = await runEmptyWriterLockProtocolFixtures();
  const binding = runLockBindingFixtures();
  assert.equal(network.nativeExecuted, false);
  assert.ok(network.assertions.length >= 42, 'Original network safety matrix must not shrink');
  assert.equal(restore.nativeExecuted, false);
  assert.equal(restore.ioKind, 'explicit-memory');
  assert.ok(restore.cases.length >= 24, 'Original restore safety matrix must not shrink');
  assert.equal(restore.cases.filter(value => value.outcome === 'restored').length, 3);
  assert.ok(restore.cases.every(value => value.starts === 0 && value.pairWrites === 0 && value.nativeExecuted === false));
  assert.equal(lock.nativeDatabaseOpened, false);
  assert.equal(lock.results.length, 5, 'All original lock release/failure scenarios must remain');
  assert.ok(lock.results.every(value => value.released === true && value.native === false));
  const manifest = { schema: 'rate-impl2-release.v1', runId: 'r03-offline-success',
    stage: '/data/video-api-debugger/release-staging/r03-offline-success', database: EMPTY_WRITER_DATABASE };
  let calls = 0;
  const result = await withEmptyWriterLock({ manifest, manifestSha256: 'a'.repeat(64),
    operationStage: manifest.stage + '/hd-release-safety-r03', offlineAdapter: createOfflineEmptyWriterLockAdapter(),
    assertNoSynchronousImageAdmissions(rows) { assert.deepEqual(rows, []); return { runningRequests: 0 }; },
    callback({ lock: held, signal, deadlineAt }) {
      assert.equal(held.syncRows.length, 0); assert.equal(signal.aborted, false);
      assert.ok(deadlineAt <= held.deadlineAt); calls++; return { fixtureOnly: true };
    },
  });
  assert.equal(calls, 1); assert.equal(result.releaseEvidence.released, true);
  assert.deepEqual(result.value, { fixtureOnly: true });
  const checks = [...network.assertions, ...restore.assertions,
    ...lock.results.map(value => 'empty writer lock ' + value.scenario), ...binding,
    'R03 empty same-lease callback success rolls back'];
  assert.equal(new Set(checks).size, checks.length, 'Every check must be named uniquely');
  return { schema: 'hd-release-safety-r03-engineering.v1', completed: true, checks,
    nativeExecuted: false, nativeDatabaseOpened: false, ioKind: 'explicit-memory',
    counts: { network: network.assertions.length, restore: restore.cases.length, lock: lock.results.length,
      binding: binding.length, sameLeaseSuccess: 1, total: checks.length },
    provenance: HD_RELEASE_SAFETY_R03_PROVENANCE, nativeReferenceSha256: WRITER_FENCE_NATIVE_REFERENCE_SHA256,
    productionAuthorityClaimed: false, network, restore, lock };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.stdout.write(JSON.stringify(await runHdReleaseSafetyEngineering()) + '\n');
}
