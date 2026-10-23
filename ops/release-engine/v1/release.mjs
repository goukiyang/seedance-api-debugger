import { assertFullLiveRoles, readFullLiveSourceFiles, prepareEngineeringRunDirectory } from './full-release-contract.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, assertReleaseWindow, rootFile, writeJsonExclusive, sha, call, unit, readProtection, liveArtifactSource, engineDirectory, isSharedEngine } from './common.mjs';
import { prepareUploadPrivateDirectory, verifyUploadPrivateDirectory } from './upload-directory-preflight.mjs';
import { APPROVED_HD_LEGACY_READY, APPROVED_HD_HISTORICAL_VERSIONS } from './hd-legacy-ready-allowlist.mjs';
import { MV_DIRECT, assertMvDirectReady } from './release-contract.mjs';
import { captureLegacyWriterContracts } from './legacy-maintenance.mjs';
import { captureHdLegacyContract } from './switch.mjs';
import { captureMultiviewBackupProtection } from './multiview-backup-control.mjs';
import { inspectInstalledMultiviewRecipeAdoption } from './multiview-works-control.mjs';
import { loadHdCompiledCacheProofs } from './hd-compiled-cache.mjs';
import { currentReleaseContext } from './engine-context.mjs';
import { readAttempt } from './attempt-state.mjs';
import { guardBuildTailRuntime as verifiedGuardBuildTailRuntime } from './candidate-evidence.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const protectedTaskIds = [
  'a0a18a0de8e1429f7d016aeebe5b0d9acde30c45230fc89f3ea3794a250ae5b3-0',
  '2629b753fbae8468869e1a9fb4858edb023692af81a4829887df7293b663d0a1-0',
  '0554eee2b0dd09341ab34eea7c0db5a1571c4e48b455365b911adcabc3da6be9-0',
  '12050d61f2d5b095fa3448c0420237b1f6ac1625c9fa4cc32a9e48632ec41d40-0',
  '1a9c4d8116478a35f9f14be2e3c1fb5bfa5104bdca5ad18e0730d5271564c830-0',
  '9f981cc08ace0aea251f8171ef40f8319c555c4dab06d3f5a9ede9bb9d5540f8-0',
  '8033f132084656cce568976d40f7fea546b03f50348c782d2f6834103066887f-0',
  '5b8a6e044d83b48c0ead34c64cc034672de26edf228ad0edf7cca034cadb7963-0',
  'd0c063e99e98a57b922847711f0a15313191fb4578ae9a64351830d8925ce597-0',
];
function protectedDirectory(file) {
  assert.equal(fs.realpathSync(file), file);
  const stat = fs.lstatSync(file); assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022));
}
function trustedCode(m, runtime = null) {
  const processorProof = runtime?.switchTypedRepair?.proof || runtime?.switchAdmissionRepair?.proof || runtime?.armProcessorRepair?.proof || runtime?.armPairRepair?.proof || runtime?.reader?.proof || runtime?.retry?.proof || runtime?.proof;
  const hashes = processorProof ? processorProof.processorControllers : m.privateSha256;
  if (runtime) {
    assert.equal(sha(JSON.stringify(hashes)), processorProof.processor.controllerSetSha256);
    assert.deepEqual(fs.readdirSync(directory).filter(file => file.endsWith('.mjs')).sort(), Object.keys(hashes).sort());
  }
  for (const [file, expected] of Object.entries(hashes)) {
    assert.ok(path.basename(file) === file && file.endsWith('.mjs')); assert.equal(sha(rootFile(path.join(directory, file))), expected, 'Private release code changed: ' + file);
  }
}

export function guardBuildTailReleaseAction(phase, mode, kind) {
  return phase === 'main-build' && mode === 'build' && kind === 'main'
    || phase === 'verify' && mode === 'verify' && ['main', 'guard'].includes(kind)
    || ['arm', 'switch', 'recovery'].includes(phase) && mode === phase && kind === undefined
    || phase === 'proof' && (mode === 'proof' && kind === undefined || mode === 'public' && kind === 'main');
}

function guardBuildTailRuntime(m, mode, kind) {
  const context = currentReleaseContext(), runtime = context?.guardBuildTail;
  assert.equal(runtime?.schema, 'sd2-release-guard-build-tail-runtime.v1');
  assert.deepEqual(verifiedGuardBuildTailRuntime(m), runtime);
  assert.equal(runtime.proof.schema, 'sd2-release-guard-build-tail-proof.v1');
  assert.ok(guardBuildTailReleaseAction(runtime.phase, mode, kind), 'Guard-tail processor may not compile guard or enter an unbound phase');
  assert.deepEqual(context.contract.engine, m.engine); assert.deepEqual(runtime.proof.engine, m.engine);
  const processorProof = runtime.switchTypedRepair?.proof || runtime.switchAdmissionRepair?.proof || runtime.armProcessorRepair?.proof || runtime.armPairRepair?.proof || runtime.reader?.proof || runtime.retry?.proof || runtime.proof;
  assert.equal(processorProof.processor.root, directory); assert.notEqual(directory, engineDirectory(m));
  assert.equal(runtime.proof.runId, m.runId); assert.equal(runtime.proof.taskId, m.operation.taskId);
  assert.equal(runtime.proof.manifestSha256, sha(rootFile(m.stage + '/manifest.json')));
  const file = m.operation.taskRoot + '/attempts/' + m.runId + '/guard-build-tail-' + runtime.continuationSha256 + '.json';
  assert.equal(runtime.proofFile, file); const bytes = rootFile(file);
  assert.equal(sha(bytes), runtime.continuationSha256); assert.deepEqual(JSON.parse(bytes), runtime.proof);
  const loaded = readAttempt({ root: m.projectRoot + '/release-tasks', taskId: m.operation.taskId, attemptId: m.runId });
  assert.equal(loaded.derivedState.status, 'running'); assert.equal(loaded.derivedState.activePhase?.phase, runtime.phase);
  assert.equal((loaded.derivedState.guardBuildTailRetry || loaded.derivedState.guardBuildTail)?.status, 'completed');
  assert.equal(loaded.derivedState.guardBuildTail.proofSha256, runtime.continuationSha256);
  assert.equal(loaded.derivedState.guardBuildTail.processorControllerSetSha256, runtime.proof.processor.controllerSetSha256);
  if (runtime.retry) {
    const retry = runtime.retry, proof = retry.proof, retryBytes = rootFile(retry.proofFile);
    assert.equal(retry.schema, 'sd2-release-guard-build-tail-retry-runtime.v1');
    assert.equal(proof.schema, 'sd2-release-guard-build-tail-retry-proof.v1');
    assert.equal(sha(retryBytes), retry.proofSha256); assert.deepEqual(JSON.parse(retryBytes), proof);
    assert.equal(proof.originalContinuationSha256, runtime.continuationSha256); assert.equal(proof.originalProofFile, runtime.proofFile);
    for (const key of ['runId', 'taskId', 'attemptId', 'manifestSha256']) assert.equal(proof[key], runtime.proof[key]);
    assert.deepEqual(proof.engine, runtime.proof.engine);
    assert.equal(loaded.derivedState.guardBuildTail.status, 'failed');
    assert.equal(loaded.derivedState.guardBuildTailRetry.proofSha256, retry.proofSha256);
    assert.equal(loaded.derivedState.guardBuildTailRetry.processorControllerSetSha256, proof.processor.controllerSetSha256);
  } else assert.equal(loaded.derivedState.guardBuildTailRetry, undefined);
  if (runtime.reader) {
    assert.ok(['verify', 'arm', 'switch', 'proof', 'recovery'].includes(runtime.phase), 'The successor reader cannot compile or prepare candidates');
    assert.ok(loaded.events.some(item => item.value.kind === 'observation' && item.value.name === 'reader_successor'
      && item.value.value.proofFile === runtime.reader.proofFile && item.value.value.proofSha256 === runtime.reader.proofSha256),
    'Successor reader is missing its actual journal authorization');
  }
  return runtime;
}
function liveInfo(name) {
  const value = unit(name); assert.equal(value.ActiveState, 'active'); assert.equal(value.SubState, 'running');
  assert.equal(value.ControlPID, '0'); assert.ok(Number(value.MainPID) > 1);
  const root = fs.realpathSync(value.WorkingDirectory); assert.equal(fs.realpathSync('/proc/' + value.MainPID + '/cwd'), root);
  return { unit: name, root, source: liveArtifactSource(root),
    version: JSON.parse(fs.readFileSync(root + '/package.json', 'utf8')).version,
    build: fs.readFileSync(root + '/.next-prod/BUILD_ID', 'utf8').trim(), pid: Number(value.MainPID), invocation: value.InvocationID,
    execMainStartTimestampMonotonic: value.ExecMainStartTimestampMonotonic };
}
export function assertCapturedLive(live) {
  if (MV_DIRECT.fullRelease) assertFullLiveRoles(MV_DIRECT.fullRelease, live);
  else for (const role of ['web', 'image', 'hd']) {
    assert.equal(live[role].source, MV_DIRECT.baselineSource);
    assert.equal(live[role].version, MV_DIRECT.baselineVersion); assert.equal(live[role].build, MV_DIRECT.baselineBuild);
  }
  for (const [role, expected] of Object.entries(MV_DIRECT.starts)) {
    assert.deepEqual([live[role].pid, live[role].invocation, live[role].execMainStartTimestampMonotonic], expected,
      'A service startup changed since the fresh restored-role capture: ' + role);
  }
}
export function captureRuntimeSourceContracts(m) {
  const legacy = captureLegacyWriterContracts(m), hdLegacy = captureHdLegacyContract(m);
  return { legacy, hdLegacy };
}
export async function capture(seedFile) {
  assertMvDirectReady();
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const seed = JSON.parse(rootFile(seedFile, 65536)); assert.match(seed.runId, /^[a-f0-9-]{36}$/);
  const stage = '/data/video-api-debugger/release-staging/' + seed.runId;
  assert.equal(path.dirname(seedFile), stage);
  assert.equal(directory, seed.engine?.schema === 'sd2-release-engine.v1' ? seed.engine.root : stage + '/fix01-release');
  for (let p = directory; p !== '/'; p = path.dirname(p)) protectedDirectory(p);
  assert.equal(call('findmnt', ['-n', '-o', 'TARGET', '-T', stage]), '/data');
  const live = Object.fromEntries(Object.entries({ web: 'sd2-gray.service', image: 'sd2-image-studio.service', hd: 'sd2-hd-derivatives.service',
    works: 'sd2-multiview-works.service', role: 'sd2-role-coordinator.service', template: 'sd2-template-prompts.service' }).map(([role, name]) => [role, liveInfo(name)]));
  assertCapturedLive(live);
  if (seed.engine && MV_DIRECT.recoveredGuardBaseline) {
    const input = MV_DIRECT.recoveredGuardBaseline;
    assert.match(input.runId, /^[a-f0-9-]{36}$/);
    const originalStage = '/data/video-api-debugger/release-staging/' + input.runId;
    const bytes = rootFile(originalStage + '/manifest.json');
    assert.equal(sha(bytes), input.manifestSha256, 'Original live-source authority changed');
    const original = JSON.parse(bytes);
    assert.equal(original.stage, originalStage);
    const matches = ['main', 'guard'].filter(kind => original[kind].source === live.hd.source);
    assert.equal(matches.length, 1, 'Live HD source must have one exact archived authority');
    const kind = matches[0], archived = original[kind];
    assert.equal(archived.sourceManifest, originalStage + '/' + kind + '/source-manifest.json');
    assert.equal(archived.archive, originalStage + '/' + kind + '/source.tar.gz');
    live.hd.sourceProof = { sourceManifest: archived.sourceManifest, archive: archived.archive };
    const capsuleFile = originalStage + '/' + kind + '-immutable-success.json';
    if (fs.existsSync(capsuleFile)) {
      const capsuleBytes = rootFile(capsuleFile, 128 * 1024 * 1024), capsule = JSON.parse(capsuleBytes);
      assert.equal(capsule.kind, kind); assert.equal(capsule.sourceRun, input.runId);
      assert.equal(capsule.originalManifestSha256, input.manifestSha256);
      assert.equal(capsule.originalReceipt.source, live.hd.source);
      if (capsule.originalReceipt.hdCompiledCache) live.hd.sourceProof.compiledCapsule = {
        file: capsuleFile, sha256: sha(capsuleBytes), kind, sourceRun: input.runId,
      };
    }
  }
  if (MV_DIRECT.fullRelease) {
    const provisional = { fullRelease: MV_DIRECT.fullRelease };
    for (const role of ['web', 'image', 'hd', 'works', 'role', 'template']) readFullLiveSourceFiles(provisional, ['package.json'], role);
    const hd = MV_DIRECT.fullRelease.liveRoles.hd;
    live.hd.sourceProof = { sourceManifest: hd.sourceManifest, archive: hd.archive, compiledCapsule: MV_DIRECT.fullRelease.dependencyCapsule };
  }
  const candidate = kind => {
    const c = JSON.parse(rootFile(stage + '/' + kind + '/source-manifest.json'));
    assert.equal(c.source, seed[kind + 'Source']); assert.equal(c.kind, kind);
    assert.equal(c.version, MV_DIRECT.versions[kind]);
    assert.equal(sha(rootFile(stage + '/' + kind + '/source.tar.gz', 512 * 1024 * 1024)), c.archiveSha256);
    return { source: c.source, root: '/data/video-api-debugger/managed-releases/' + c.source,
      version: c.version, archive: stage + '/' + kind + '/source.tar.gz', sourceManifest: stage + '/' + kind + '/source-manifest.json', buildDist: '.next-prod-candidate' };
  };
  const protectedFiles = ['/srv/video-api-debugger/app/.env', '/data/video-api-debugger/feedback-delivery/.env.feedback',
    '/etc/nginx/sites-available/sd2.youdooart.com', '/etc/nginx/sites-available/sd2-server.youdoodesign.com',
    '/data/video-api-debugger/controls/pricing-writer-v1/writer-start-guard.mjs',
    '/data/video-api-debugger/controls/raw-upload-recovery-v1.json',
    ...(MV_DIRECT.privateMultiviewInstall ? ['/etc/systemd/system/sd2-backup.service.d/90-multiview-works.conf'] : [])];
  const m = validateManifest({ schema: 'rate-impl2-release.v1', project: 'video-api-debugger', runId: seed.runId,
    projectRoot: '/data/video-api-debugger', stage, mainSource: seed.mainSource, guardSource: seed.guardSource,
    protectedVideoTaskIds: [...MV_DIRECT.protectedVideoTaskIds],
    main: candidate('main'), guard: candidate('guard'), live,
    protectedTaskIds: MV_DIRECT.protectedTaskIds || protectedTaskIds, protectedFiles,
    retiredPricingRoots: MV_DIRECT.retiredPricingSources.map(source => '/data/video-api-debugger/managed-releases/' + source),
    expectedProtectedFileSha256: Object.fromEntries(protectedFiles.map(file => [file, sha(fs.readFileSync(file))])),
    database: '/data/video-api-debugger/var-lib/dev.db', storageRoot: fs.realpathSync(live.image.root + '/storage'),
    hdRoot: '/data/video-api-debugger/var-lib/storage/hd-derivatives',
    hdForkRoot: '/data/video-api-debugger/releases/5a59c00aaba195c42d90c612a37224ad59b12ee0/storage/hd-derivatives',
    hdWorkerLockPath: '/data/video-api-debugger/var-lib/storage/hd-worker.lock',
    hdLegacyReady: APPROVED_HD_LEGACY_READY,
    hdHistoricalVersions: APPROVED_HD_HISTORICAL_VERSIONS,
    uploadPrivateDirectory: { canonical: '/data/video-api-debugger/var-lib/storage/verified-uploads',
      alias: fs.realpathSync(live.image.root + '/storage') + '/verified-uploads',
      preparedReceipt: stage + '/upload-directory-prepared.json' },
    uploadsRoot: '/data/video-api-debugger/var-lib/uploads', videosRoot: '/data/video-api-debugger/var-lib/videos',
    envFile: '/srv/video-api-debugger/app/.env', appUser: 'gouki', windowFile: stage + '/window.json',
    minimumFreeBytes: 5 * 1024 ** 3, publicOrigin: 'https://sd2.youdooart.com', observedAt: new Date().toISOString(),
    ...(seed.reuseBuilds ? { reuseBuilds: seed.reuseBuilds } : {}),
    ...(seed.engine ? { engine: seed.engine, operation: seed.operation } : {}),
    ...(seed.controlEvidence ? { controlEvidence: seed.controlEvidence } : {}),
    ...(MV_DIRECT.normalContinuation ? { normalContinuation: MV_DIRECT.normalContinuation } : {}),
    ...(MV_DIRECT.deployedUsageSchema ? { deployedUsageSchema: MV_DIRECT.deployedUsageSchema } : {}),
    ...(MV_DIRECT.recoveredGuardBaseline ? { recoveredGuardBaseline: MV_DIRECT.recoveredGuardBaseline } : {}),
    ...(MV_DIRECT.fullRelease ? { fullRelease: MV_DIRECT.fullRelease } : {}),
    ...(MV_DIRECT.protectedIncrement ? { protectedIncrement: MV_DIRECT.protectedIncrement } : {}),
    ...(MV_DIRECT.canvasVideoBatchSchema ? { canvasVideoBatchSchema: MV_DIRECT.canvasVideoBatchSchema } : {}),
    ...(MV_DIRECT.deployedCanvasBatchSchema ? { deployedCanvasBatchSchema: MV_DIRECT.deployedCanvasBatchSchema } : {}),
    ...(MV_DIRECT.privateMultiviewInstall ? { privateMultiviewInstall: true } : {}),
    privateSha256: Object.fromEntries(fs.readdirSync(directory).filter(file => file.endsWith('.mjs')).sort()
      .map(file => [file, sha(rootFile(path.join(directory, file)))])) });
  assertReleaseWindow(m); trustedCode(m);
  await loadHdCompiledCacheProofs(m);
  const control = await import('./pricing-start-pair.mjs');
  const captured = control.capturePricingStartControl();
  assert.equal(seed.expectedAllowedSha256, MV_DIRECT.expectedAllowedSha256);
  assert.equal(captured.allowed.sha256, seed.expectedAllowedSha256, 'Actual startup pair changed since packaging');
  if (m.recoveredGuardBaseline || m.fullRelease) await (await import('./deployed-usage-schema.mjs')).assertCurrentPublishedBaseline(m);
  const { legacy, hdLegacy } = captureRuntimeSourceContracts(m);
  const uploadDirectory = prepareUploadPrivateDirectory(m); verifyUploadPrivateDirectory(m);
  writeJsonExclusive(stage + '/manifest.json', m);
  prepareEngineeringRunDirectory(m);
  if (m.privateMultiviewInstall) captureMultiviewBackupProtection(m);
  if (m.fullRelease || m.recoveredGuardBaseline?.schema === 'sd2-multiview-r17-recovered-guard.v1') inspectInstalledMultiviewRecipeAdoption(m);
  const before = readProtection(m);
  assert.equal(before.pricingRevision, MV_DIRECT.pricingRevision, 'Saved pricing changed; never restore an old revision');
  writeJsonExclusive(stage + '/capture.json', {
    at: new Date().toISOString(), manifestSha256: sha(fs.readFileSync(stage + '/manifest.json')),
    startControl: captured, uploadDirectory, legacy, hdLegacy, protection: before, zeroBusinessWrites: true, servicesChanged: false });
  const loaded = await (await import('./cutover-safety.mjs')).prepareOperationFenceModule(m);
  writeJsonExclusive(stage + '/control-module-preflight.json', {
    runId: m.runId, manifestSha256: sha(fs.readFileSync(stage + '/manifest.json')),
    file: loaded.file, source: loaded.source, sha256: loaded.sha256, snapshot: loaded.snapshot,
    moduleActuallyLoaded: true, servicesChanged: false, businessWrites: 0, at: new Date().toISOString() });
  return { runId: m.runId, mainSource: m.mainSource, guardSource: m.guardSource, live,
    manifest: stage + '/manifest.json', manifestSha256: sha(fs.readFileSync(stage + '/manifest.json')) };
}
export async function execute(mode, manifestFile, kind) {
  assert.equal(process.getuid(), 0); const m = validateManifest(JSON.parse(rootFile(manifestFile)));
  assert.equal(manifestFile, m.stage + '/manifest.json');
  const runtime = directory === engineDirectory(m) ? null : guardBuildTailRuntime(m, mode, kind);
  trustedCode(m, runtime);
  await loadHdCompiledCacheProofs(m);
  if (mode === 'preflight') return (await import('./control-preflight.mjs')).controlPreflight(m);
  if (mode === 'admission') return (await import('./control-preflight.mjs')).controlAdmission(m);
  if (mode === 'adopt') {
    if (m.deployedUsageSchema) {
      const { adoptDeployedUsageSchema } = await import('./deployed-usage-schema.mjs');
      return adoptDeployedUsageSchema(m, { candidates: !m.fullRelease });
    }
    const { captureSwitchBefore } = await import('./switch.mjs');
    const { verifyNormalContinuation, adoptOriginalMigration } = await import('./normal-continuation.mjs');
    assert.ok(m.normalContinuation);
    const verified = verifyNormalContinuation(m, captureSwitchBefore(m, sha(rootFile(manifestFile))));
    writeJsonExclusive(m.stage + '/normal-continuation-verified.json', { runId: m.runId,
      manifestSha256: sha(rootFile(manifestFile)), at: new Date().toISOString(), ...verified });
    return adoptOriginalMigration(m);
  }
  if (['prepare', 'build', 'verify'].includes(mode)) {
    assert.ok(['main', 'guard'].includes(kind)); const c = await import('./candidate.mjs');
    return c[mode === 'prepare' ? 'prepareCandidate' : mode === 'build' ? 'buildCandidate' : 'verifyCandidate'](m, kind);
  }
  if (mode === 'public') {
    assert.ok(['main', 'guard'].includes(kind)); const value = await (await import('./public-proof.mjs')).verifyPublic(m, kind);
    writeJsonExclusive(m.stage + '/' + kind + '-public-proof.json', value); return value;
  }
  const s = await import('./switch.mjs');
  if (mode === 'arm') return s.armSwitch(m);
  if (mode === 'proof') return s.proof(m);
  if (mode === 'recovery') {
    assert.equal(fs.existsSync(m.stage + '/switch-complete.json'), false, 'A successful run is not an interrupted-switch recovery');
    const safety = await (await import('./cutover-driver.mjs')).loadHdReleaseSafety(m, 'recovery');
    return s.recoverStandaloneSwitch(m, { safety, error: new Error('Interrupted frozen switch; explicitly invoked fixed-guard fault recovery') });
  }
  assert.ok(['switch', 'rollback'].includes(mode));
  const safety = await (await import('./cutover-driver.mjs')).loadHdReleaseSafety(m, mode);
  return s.switchPair(m, { mode, safety });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, file, kind] = process.argv.slice(2);
  (mode === 'capture' ? capture(file) : execute(mode, file, kind)).then(value => console.log(JSON.stringify(value)))
    .catch(error => { console.error(error); process.exitCode = 1; });
}

