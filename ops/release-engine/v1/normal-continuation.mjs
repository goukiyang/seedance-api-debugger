import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rootFile, sha, call, writeJsonExclusive, assertProtection, assertReleaseWindow, unit, readProtection,
  isSharedEngine, engineDirectory } from './common.mjs';
import { readDeployedUsageEvidence, verifyDeployedUsageSchema, assertDeployedSchemaInput } from './deployed-usage-schema.mjs';
import { assertDeployedCanvasInput } from './canvas-batch-schema.mjs';
import { assertCanvasBatchSchemaInput } from './canvas-batch-schema-contract.mjs';
import { readOriginalSuccess } from './candidate-reuse.mjs';
import { guardBuildTailRuntime, operationalLive } from './candidate-evidence.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const stageFor = run => '/data/video-api-debugger/release-staging/' + run;
const json = file => JSON.parse(rootFile(file));
export const SHARED_BUILD_PROVENANCE = 'sd2-shared-build-provenance.v1';
export function assertSharedBuildReuseInput(m) {
  engineDirectory(m); assert.equal(isSharedEngine(m), true);
  assert.equal(m.normalContinuation || null, null, 'Shared attempts do not impersonate legacy normal continuations');
  const reuse = m.reuseBuilds; assert.ok(reuse);
  assert.deepEqual(Object.keys(reuse).sort(), ['schema', 'sourceRun', 'main', 'guard'].sort());
  assert.equal(reuse.schema, 'sd2-original-build-reuse-input.v1');
  assert.match(reuse.sourceRun, UUID); assert.notEqual(reuse.sourceRun, m.runId);
  for (const kind of ['main', 'guard']) {
    assert.deepEqual(Object.keys(reuse[kind]).sort(), ['file', 'sha256']);
    assert.equal(reuse[kind].file, stageFor(reuse.sourceRun) + '/' + kind + '-immutable-success.json');
    assert.match(reuse[kind].sha256, HASH);
    assert.equal(m[kind].source, m[kind + 'Source']);
    assert.equal(m[kind].root, m.projectRoot + '/managed-releases/' + m[kind].source);
  }
  assert.notEqual(m.mainSource, m.guardSource);
  return reuse;
}
export function assertSharedBuildSources(m, prior) {
  const reuse = assertSharedBuildReuseInput(m);
  assert.equal(prior.schema, 'rate-impl2-release.v1'); assert.equal(prior.project, m.project);
  assert.equal(prior.runId, reuse.sourceRun); assert.equal(prior.stage, stageFor(reuse.sourceRun));
  assert.equal(prior.reuseBuilds || null, null, 'Only a direct original complete build may be reused');
  assert.equal(prior.normalContinuation || null, null);
  if (isSharedEngine(prior)) engineDirectory(prior);
  for (const key of ['mainSource', 'guardSource', 'fullRelease', 'protectedIncrement', 'recoveredGuardBaseline', 'privateMultiviewInstall',
    'deployedUsageSchema', 'deployedCanvasBatchSchema', 'canvasVideoBatchSchema', 'database', 'envFile',
    'expectedProtectedFileSha256', 'protectedFiles', 'protectedTaskIds', 'protectedVideoTaskIds', 'retiredPricingRoots',
    'storageRoot', 'hdRoot', 'hdForkRoot', 'hdWorkerLockPath', 'hdLegacyReady', 'hdHistoricalVersions',
    'uploadsRoot', 'videosRoot', 'appUser', 'publicOrigin'])
    assert.deepEqual(prior[key], m[key], 'Original application/protection contract changed: ' + key);
  for (const kind of ['main', 'guard']) for (const key of ['source', 'root', 'version', 'buildDist'])
    assert.equal(prior[kind][key], m[kind][key], 'Original complete build pair changed: ' + kind + '.' + key);
  const live = structuredClone(m.live);
  if (m.fullRelease) {
    assert.deepEqual(live.hd?.sourceProof, { sourceManifest: m.fullRelease.liveRoles.hd.sourceManifest,
      archive: m.fullRelease.liveRoles.hd.archive, compiledCapsule: m.fullRelease.dependencyCapsule });
  } else if (live.hd?.sourceProof) {
    const input = m.recoveredGuardBaseline; assert.ok(input);
    const bytes = rootFile(stageFor(input.runId) + '/manifest.json'); assert.equal(sha(bytes), input.manifestSha256);
    const recovered = JSON.parse(bytes); assert.equal(recovered.guard.source, live.hd.source);
    const expectedProof = { sourceManifest: recovered.guard.sourceManifest, archive: recovered.guard.archive };
    const capsuleFile = stageFor(input.runId) + '/guard-immutable-success.json';
    if (fs.existsSync(capsuleFile)) {
      const capsuleBytes = rootFile(capsuleFile, 128 * 1024 * 1024), capsule = JSON.parse(capsuleBytes);
      assert.equal(capsule.schema, 'sd2-immutable-successful-build.v1'); assert.equal(capsule.kind, 'guard');
      assert.equal(capsule.sourceRun, input.runId); assert.equal(capsule.originalManifestSha256, input.manifestSha256);
      assert.equal(capsule.originalReceipt.source, live.hd.source);
      if (capsule.originalReceipt.hdCompiledCache) expectedProof.compiledCapsule = {
        file: capsuleFile, sha256: sha(capsuleBytes), kind: 'guard', sourceRun: input.runId };
    }
    assert.deepEqual(live.hd.sourceProof, expectedProof,
      'Live writer proof must derive from the pinned recovered guard, not a new candidate');
    if (prior.live.hd?.sourceProof) {
      const originalProof = prior.live.hd.sourceProof;
      assert.deepEqual(originalProof, originalProof.compiledCapsule ? expectedProof
        : { sourceManifest: expectedProof.sourceManifest, archive: expectedProof.archive });
      live.hd.sourceProof = structuredClone(originalProof);
    } else delete live.hd.sourceProof;
  }
  assert.deepEqual(live, prior.live, 'Original live/PID/invocation/start/cwd binding changed');
  return reuse;
}
export function assertSharedNoEffectsRecords(prior, manifestSha256, records, candidatePids, controllerPids) {
  assert.deepEqual(candidatePids, [], 'An original candidate process is active');
  assert.deepEqual(controllerPids, [], 'An original attempt controller is active');
  const effects = /^(?:\.switch\.lock$|natural-stop|usage-role-transition|writer-no-force|hd-manual-start|ingress-|network-fence|pricing-pair|actual-prestart|raw-upload-recovery-published|switch-complete|rollback-|guard-recovery|fixed-guard-recovery-(?:attempt|start|complete)|multiview-works-transition|multiview-private-preopen|multiview-backup-(?:transition|published)|nginx-.*(?:installed|install-prepared|install-progress|installation-aborted))/;
  const refusals = [];
  for (const record of records) {
    assert.equal(effects.test(record.name), false, 'Original attempt has cutover effects: ' + record.name);
    const value = record.value;
    if (record.name === 'capture.json') {
      assert.equal(value.manifestSha256, manifestSha256);
      assert.equal(value.zeroBusinessWrites, true); assert.equal(value.servicesChanged, false);
    } else if (record.name === 'switch-before.json') {
      assert.equal(value.schema, 'rate-impl2-switch-before.v1');
      assert.equal(value.runId, prior.runId); assert.equal(value.manifestSha256, manifestSha256);
    } else if (record.name === 'normal-switch-refusal.json') {
      assert.equal(value.schema, 'sd2-normal-switch-refusal.v1');
      assert.equal(value.runId, prior.runId); assert.equal(value.manifestSha256, manifestSha256);
      assert.equal(value.phase, 'before-maintenance'); assert.equal(value.effectsStarted, false);
      assert.equal(value.originalPidAndProtectionFreshlyVerified, true); assert.equal(value.exitCode, 1);
      assert.ok(Number.isFinite(Date.parse(value.at)) && Date.parse(value.at) <= Date.now());
      refusals.push(record);
    } else if (record.name === 'normal-switch-command-return.json') {
      assert.equal(value.runId, prior.runId); assert.equal(value.status, 1);
      assert.equal(value.signal, null); assert.equal(value.error, null);
      assert.ok(Number.isFinite(Date.parse(value.at)) && Date.parse(value.at) <= Date.now());
    } else if (['fixed-guard-recovery.json', 'fixed-guard-recovery-armed.json'].includes(record.name)) {
      assert.equal(value.runId, prior.runId); assert.equal(value.manifestSha256, manifestSha256);
      if (record.name === 'fixed-guard-recovery.json') {
        assert.equal(value.onlyOperation, 'recover-this-guard-after-this-run-failure');
        assert.equal(value.continueMain, false); assert.equal(value.replaceGuard, false);
      }
    } else if (/^switch-failure-.*\.json$/.test(record.name)) {
      assert.equal(value.schema, 'rate-impl2-switch-failure.v1');
      assert.equal(value.runId, prior.runId); assert.equal(value.manifestSha256, manifestSha256);
      assert.equal(value.maintenance, null); assert.equal(value.writerStartIntentPresent, false);
      assert.equal(value.automaticOldPairRecovery, false); assert.equal(value.databaseRestored, false);
      assert.deepEqual(value.safetyFailure, { action: 'keep-maintenance-no-start', phase: 'not-installed' });
      assert.ok(records.some(other => other.group === record.group && other.name === 'normal-switch-refusal.json'),
        'An original failed attempt is missing its explicit no-effects refusal');
    }
  }
  for (const record of records.filter(item => ['switch-before.json', 'fixed-guard-recovery.json', 'fixed-guard-recovery-armed.json'].includes(item.name)))
    assert.ok(refusals.some(item => item.group === record.group), 'An original switch observation lacks a no-effects refusal');
  for (const refusal of refusals)
    assert.ok(records.some(item => item.group === refusal.group && item.name === 'normal-switch-command-return.json'),
      'Original refused controller lacks its actual completed command receipt');
  return refusals;
}
function sharedOriginRecords(prior) {
  const stage = prior.stage, records = [], evidence = {}, inventory = {}, groups = [{ directory: stage, mapping: null }];
  inventory[stage] = fs.readdirSync(stage).sort();
  for (const name of inventory[stage]) {
    const directory = stage + '/' + name;
    if (name.startsWith('switch-attempt')) assert.match(name, /^switch-attempt\d+$/, 'Unrecognized attempt archive');
    if (!/^switch-attempt\d+$/.test(name)) continue;
    assert.equal(fs.realpathSync(directory), directory);
    const stat = fs.lstatSync(directory); assert.ok(stat.isDirectory() && stat.uid === 0 && !(stat.mode & 0o077));
    const mapFile = directory + '/path-mapping.json', bytes = rootFile(mapFile), value = JSON.parse(bytes);
    assert.equal(value.runId, prior.runId); assert.equal(value.effectsStarted, false);
    assert.equal(value.originalPidAndProtectionFreshlyVerified, true);
    assert.equal(value.originalBytesUnchanged, true); assert.equal(value.originalFailurePreserved, true);
    assert.ok(Number.isFinite(Date.parse(value.at)) && Date.parse(value.at) <= Date.now());
    assert.ok(Array.isArray(value.mapping) && value.mapping.length > 0 && value.mapping.length <= 128);
    const mapped = new Map();
    for (const item of value.mapping) {
      assert.equal(path.dirname(item.originalPath), stage); assert.equal(path.dirname(item.archivedPath), directory);
      const file = path.basename(item.originalPath);
      assert.equal(path.basename(item.archivedPath), file); assert.ok(!mapped.has(file)); assert.match(item.sha256, HASH);
      const original = rootFile(item.archivedPath); assert.equal(original.length, item.bytes); assert.equal(sha(original), item.sha256);
      mapped.set(file, original); evidence[item.archivedPath] = item.sha256;
    }
    inventory[directory] = fs.readdirSync(directory).sort();
    assert.deepEqual(inventory[directory], ['path-mapping.json', ...mapped.keys()].sort(), 'Unmapped archived attempt evidence');
    evidence[mapFile] = sha(bytes); groups.push({ directory, mapping: mapped });
  }
  for (const { directory, mapping } of groups) {
    const names = mapping ? [...mapping.keys()] : fs.readdirSync(directory).sort();
    for (const name of names) {
      if (!/^(?:\.switch\.lock$|capture\.json$|switch-before\.json$|normal-switch-(?:refusal|command-return)\.json$|switch-failure-|natural-stop|usage-role-transition|writer-no-force|hd-manual-start|ingress-|network-fence|pricing-pair|actual-prestart|raw-upload-recovery-published|switch-complete|rollback-|guard-recovery|fixed-guard-recovery(?:\.json$|-armed\.json$|-(?:attempt|start|complete))|multiview-works-transition|multiview-private-preopen|multiview-backup-(?:transition|published)|nginx-.*(?:installed|install-prepared|install-progress|installation-aborted))/.test(name)) continue;
      const file = directory + '/' + name;
      const bytes = mapping?.get(name) || rootFile(file);
      evidence[file] = sha(bytes);
      records.push({ name, file, group: directory, value: name.endsWith('.json') ? JSON.parse(bytes) : null });
    }
    for (const refusal of records.filter(item => item.group === directory && item.name === 'normal-switch-refusal.json')) {
      for (const [name, digest] of [[refusal.value.logFile, refusal.value.logSha256],
        ...(refusal.value.hdDetailFile === null ? [] : [[refusal.value.hdDetailFile, refusal.value.hdDetailSha256]])]) {
        assert.equal(path.basename(name), name); assert.ok(!name.includes('..')); assert.match(digest, HASH);
        const bytes = mapping ? mapping.get(name) : rootFile(directory + '/' + name);
        assert.ok(bytes, 'Archived refusal evidence was not explicitly mapped: ' + name);
        assert.equal(sha(bytes), digest); evidence[directory + '/' + name] = digest;
      }
      if (refusal.value.hdDetailFile === null) assert.equal(refusal.value.hdDetailSha256, null);
    }
    for (const record of records.filter(item => item.group === directory && item.name === 'normal-switch-command-return.json')) {
      const name = path.basename(record.value.log); assert.equal(record.value.log, stage + '/' + name);
      assert.match(record.value.logSha256, HASH);
      const bytes = mapping ? mapping.get(name) : rootFile(directory + '/' + name);
      assert.ok(bytes, 'Original controller log was not explicitly mapped'); assert.equal(sha(bytes), record.value.logSha256);
      evidence[directory + '/' + name] = record.value.logSha256;
    }
  }
  for (const file of [stage + '/private-recipe/apply.json', '/data/video-api-debugger/controls/pricing-writer-v1/start-' + prior.runId + '.json',
    stage + '/allowed-original.json.published.json']) assert.equal(fs.existsSync(file), false, 'Original attempt published or started a writer: ' + file);
  assert.equal(records.filter(item => item.group === stage && item.name === 'capture.json').length, 1,
    'Original complete build lacks its original no-write capture');
  return { records, evidence, inventory };
}
export function assertSharedBuildCapsules(m, prior, manifestSha256, capsules) {
  const reuse = assertSharedBuildSources(m, prior);
  for (const [kind, capsule] of Object.entries(capsules)) {
    assert.ok(['main', 'guard'].includes(kind));
    assert.equal(capsule.schema, 'sd2-immutable-successful-build.v1'); assert.equal(capsule.kind, kind);
    assert.equal(capsule.sourceRun, reuse.sourceRun); assert.equal(capsule.originalReceipt.schema, 'rate-impl2-candidate-build.v1');
    assert.equal(capsule.originalReceipt.label, kind);
    assert.equal(capsule.originalManifestSha256, manifestSha256);
    assert.equal(capsule.originalReceipt.runId, prior.runId); assert.equal(capsule.originalReceipt.source, m[kind].source);
    assert.equal(capsule.originalReceipt.version, m[kind].version); assert.equal(capsule.originalReceipt.exitCode, 0);
    assert.equal(capsule.originalReceipt.verifiedSourceAndGates, true);
    assert.equal(capsule.originallyVerifiedWithinThirtyMinuteGate, true);
    assert.ok(typeof capsule.originalReceipt.build === 'string' && capsule.originalReceipt.build.length > 0);
    assert.equal(capsule.originalTimesChanged, false); assert.equal(capsule.newCompilationClaimed, false);
    const receipt = capsule.originalReceipt, sealedAt = Date.parse(capsule.sealedAt);
    assert.ok(Number.isSafeInteger(receipt.startedAt) && Number.isSafeInteger(receipt.finishedAt)
      && receipt.startedAt > 0 && receipt.startedAt <= receipt.finishedAt && receipt.finishedAt <= sealedAt
      && sealedAt <= Date.now() && sealedAt - receipt.startedAt < 1800000, 'Original complete build was not sealed within its original gate');
  }
  assert.deepEqual(Object.keys(capsules).sort(), ['guard', 'main']);
  return capsules;
}
export function verifySharedBuildProvenance(m, before = null, { requireCandidatesStopped = Boolean(before) } = {}) {
  const reuse = assertSharedBuildReuseInput(m), stage = stageFor(reuse.sourceRun); stageIdentity(stage);
  const manifestBytes = rootFile(stage + '/manifest.json'), prior = JSON.parse(manifestBytes), manifestSha256 = sha(manifestBytes);
  const capsules = assertSharedBuildCapsules(m, prior, manifestSha256,
    Object.fromEntries(['main', 'guard'].map(kind => [kind, readOriginalSuccess(m, kind)])));
  const { records, evidence, inventory } = sharedOriginRecords(prior), ancestors = new Set(); let parent = process.pid;
  while (parent > 1 && !ancestors.has(parent)) {
    ancestors.add(parent); const stat = fs.readFileSync('/proc/' + parent + '/stat', 'utf8');
    parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[1]);
  }
  const candidatePids = [], controllerPids = [];
  for (const name of fs.readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
    const pid = Number(name); if (ancestors.has(pid)) continue;
    try {
      const cwd = fs.realpathSync('/proc/' + pid + '/cwd'), command = fs.readFileSync('/proc/' + pid + '/cmdline');
      if ([m.main.root, m.guard.root].includes(cwd) || [m.main.root, m.guard.root].some(root => command.includes(Buffer.from(root + '/')))) candidatePids.push(pid);
      if (cwd === stage || command.includes(Buffer.from(stage + '/'))) controllerPids.push(pid);
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  const refusals = assertSharedNoEffectsRecords(prior, manifestSha256, records, requireCandidatesStopped ? candidatePids : [], controllerPids);
  if (before) {
    assertReleaseWindow(m); assert.equal(before.manifestSha256, sha(rootFile(m.stage + '/manifest.json')));
    const original = records.find(item => item.group === stage && item.name === 'switch-before.json')?.value
      || json(stage + '/capture.json');
    assertProtection(original.protection, before.protection);
    const captured = original.captured || original.startControl;
    assertFreshPricingCapture(before.captured, captured);
    for (const live of Object.values(m.live)) {
      const current = unit(live.unit); assert.equal(current.ActiveState, 'active'); assert.equal(current.SubState, 'running');
      assert.equal(current.ControlPID, '0'); assert.equal(Number(current.MainPID), live.pid); assert.equal(current.InvocationID, live.invocation);
      assert.equal(fs.realpathSync('/proc/' + current.MainPID + '/cwd'), live.root);
    }
    if (m.deployedUsageSchema) verifyDeployedUsageSchema(m);
  }
  for (const [directory, names] of Object.entries(inventory)) assert.deepEqual(fs.readdirSync(directory).sort(), names,
    'Original attempt inventory changed during provenance verification');
  for (const [file, digest] of Object.entries(evidence)) assert.equal(sha(rootFile(file)), digest,
    'Original refusal/archive evidence changed during provenance verification');
  assert.equal(sha(rootFile(stage + '/manifest.json')), manifestSha256);
  const stableEvidence = Object.fromEntries(Object.entries(evidence).sort(([a], [b]) => a.localeCompare(b)));
  return { schema: SHARED_BUILD_PROVENANCE, input: structuredClone(reuse), prior, originalManifestSha256: manifestSha256,
    evidenceSha256: sha(JSON.stringify(stableEvidence)), evidence: stableEvidence,
    refusals: refusals.map(item => ({ file: item.file, at: item.value.at, effectsStarted: false, originalPidAndProtectionFreshlyVerified: true })),
    originalBuilds: Object.fromEntries(Object.entries(capsules).map(([kind, capsule]) => [kind,
      { sha256: reuse[kind].sha256, ...capsule.originalReceipt }])),
    noEffects: true, originalControllerStopped: true, candidateProcessesStopped: candidatePids.length === 0,
    originalEvidencePreserved: true, originalTimesChanged: false, newCompilationClaimed: false };
}
export const CONTINUATION_V2 = 'sd2-normal-continuation-input.v2';
export const UNPUBLISHED_SCHEMA = 'sd2-exact-unpublished-pair-admission.v1';
export const EXACT_UNPUBLISHED_PAIR = Object.freeze({
  run: 'e6044ae3-4f29-4dfd-8f12-93a94cdfa9ff',
  manifestSha256: '9ce497c4318e25234c251b2a96d2795523d4d8dd37cb81600313e29ab93d030a',
  main: { source: '4fb7f841ec05f38759bede3e3b4bea73e19c027f', version: '0.102.2', build: 'qwBCyuUR2RcM8M-vL8KoV',
    startedAt: 1792660050513, finishedAt: 1792660740036, sealedAt: '2026-10-22T09:19:10.955Z',
    sha256: '9bac43895caf236770eda2f7f71ffc45dc567277f573ee3e48ccba5c446f8496' },
  guard: { source: '4b1adbbab77c80449ec1a7fc326d59b28249e34b', version: '0.102.2+projects-design-guard.1', build: 'oNhpz_gPaennYmwMTqTBf',
    startedAt: 1792660893881, finishedAt: 1792661603151, sealedAt: '2026-10-22T09:33:30.231Z',
    sha256: 'a5bd86c476f13cb1104e2dc21154c4d2a6f2d42cc67b0470cc975ba98d961a57' },
});
export function isExactUnpublishedReuse(m) { return m.reuseBuilds?.sourceRun === EXACT_UNPUBLISHED_PAIR.run; }
export function assertExactUnpublishedInput(m) {
  const pin = EXACT_UNPUBLISHED_PAIR;
  assert.equal(m.normalContinuation || null, null); assert.notEqual(m.runId, pin.run); assert.match(m.runId, UUID);
  assertDeployedSchemaInput(m.deployedUsageSchema); assertDeployedCanvasInput(m.deployedCanvasBatchSchema);
  assertCanvasBatchSchemaInput(m.canvasVideoBatchSchema);
  assert.deepEqual(Object.keys(m.reuseBuilds).sort(), ['schema', 'sourceRun', 'main', 'guard'].sort());
  assert.equal(m.reuseBuilds.schema, 'sd2-original-build-reuse-input.v1'); assert.equal(m.reuseBuilds.sourceRun, pin.run);
  for (const kind of ['main', 'guard']) {
    assert.equal(m[kind + 'Source'], pin[kind].source);
    assert.equal(m[kind].source, pin[kind].source); assert.equal(m[kind].version, pin[kind].version);
    assert.equal(m[kind].root, '/data/video-api-debugger/managed-releases/' + pin[kind].source);
    assert.equal(m[kind].buildDist, '.next-prod-candidate');
    assert.deepEqual(m.reuseBuilds[kind], { file: stageFor(pin.run) + '/' + kind + '-immutable-success.json', sha256: pin[kind].sha256 });
  }
  return { schema: UNPUBLISHED_SCHEMA, sourceRun: pin.run, sourceManifestSha256: pin.manifestSha256 };
}
export function assertExactUnpublishedFacts(m, { prior, manifestSha256, capsules, originalFiles, candidatePids }) {
  const input = assertExactUnpublishedInput(m), pin = EXACT_UNPUBLISHED_PAIR;
  assert.equal(manifestSha256, pin.manifestSha256);
  assert.equal(prior.schema, 'rate-impl2-release.v1'); assert.equal(prior.project, 'video-api-debugger');
  assert.equal(prior.runId, pin.run); assert.equal(prior.stage, stageFor(pin.run));
  assert.equal(prior.normalContinuation || null, null); assert.equal(prior.reuseBuilds || null, null);
  for (const key of ['live', 'deployedUsageSchema', 'deployedCanvasBatchSchema', 'canvasVideoBatchSchema',
    'database', 'envFile', 'expectedProtectedFileSha256', 'protectedFiles', 'protectedTaskIds', 'protectedVideoTaskIds',
    'retiredPricingRoots', 'storageRoot', 'hdRoot', 'hdForkRoot', 'hdWorkerLockPath', 'hdLegacyReady',
    'hdHistoricalVersions', 'uploadsRoot', 'videosRoot', 'appUser', 'publicOrigin']) assert.deepEqual(prior[key], m[key], 'Original protected input changed: ' + key);
  assertNoCutoverEffects(originalFiles);
  assert.ok(!originalFiles.some(name => /^(?:switch-|normal-switch-|fixed-guard-recovery|guard-recovery|writer-no-force|hd-manual-start|network-fence|nginx-.*-install)/.test(name)), 'Original run was not wholly unpublished');
  assert.deepEqual(candidatePids, [], 'Original controller or candidate writer is active');
  for (const kind of ['main', 'guard']) {
    const capsule = capsules[kind], receipt = capsule.originalReceipt;
    assert.equal(capsule.schema, 'sd2-immutable-successful-build.v1'); assert.equal(capsule.kind, kind);
    assert.equal(capsule.sourceRun, pin.run); assert.equal(capsule.originalManifestSha256, pin.manifestSha256);
    assert.equal(capsule.originallyVerifiedWithinThirtyMinuteGate, true);
    assert.equal(capsule.originalTimesChanged, false); assert.equal(capsule.newCompilationClaimed, false);
    assert.equal(capsule.sealedAt, pin[kind].sealedAt);
    assert.ok(Date.parse(capsule.sealedAt) >= receipt.finishedAt && Date.parse(capsule.sealedAt) - receipt.startedAt < 1800000);
    assert.equal(receipt.runId, pin.run); assert.equal(receipt.exitCode, 0); assert.equal(receipt.verifiedSourceAndGates, true);
    for (const key of ['source', 'version', 'build', 'startedAt', 'finishedAt']) assert.equal(receipt[key], pin[kind][key]);
    for (const key of ['source', 'root', 'version', 'buildDist']) assert.equal(prior[kind][key], m[kind][key]);
    assert.ok(!Object.values(m.live).some(value => value.source === pin[kind].source || value.root === m[kind].root));
  }
  return input;
}
export function verifyExactUnpublishedProvenance(m, before = null) {
  assertExactUnpublishedInput(m);
  if (before) assertReleaseWindow(m);
  const stage = stageFor(EXACT_UNPUBLISHED_PAIR.run); stageIdentity(stage);
  const prior = pinned(stage + '/manifest.json', EXACT_UNPUBLISHED_PAIR.manifestSha256);
  const ancestors = new Set(); let p = process.pid;
  while (p > 1 && !ancestors.has(p)) { ancestors.add(p); const s = fs.readFileSync('/proc/' + p + '/stat', 'utf8'); p = Number(s.slice(s.lastIndexOf(')') + 2).split(/\s+/)[1]); }
  const candidatePids = [];
  for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    if (ancestors.has(Number(pid))) continue;
    try {
      const cwd = fs.realpathSync('/proc/' + pid + '/cwd'), command = fs.readFileSync('/proc/' + pid + '/cmdline');
      if (command.includes(Buffer.from(stage + '/fix01-release/')) || (before && ([m.main.root, m.guard.root].includes(cwd)
        || [m.main.root, m.guard.root].some(root => command.includes(Buffer.from(root + '/')))))) candidatePids.push(Number(pid));
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  const capsules = Object.fromEntries(['main', 'guard'].map(kind => [kind, readOriginalSuccess(m, kind)]));
  const input = assertExactUnpublishedFacts(m, { prior, manifestSha256: sha(rootFile(stage + '/manifest.json')), capsules,
    originalFiles: fs.readdirSync(stage), candidatePids });
  const result = { schema: UNPUBLISHED_SCHEMA, input, prior, originalManifestSha256: EXACT_UNPUBLISHED_PAIR.manifestSha256,
    originalBuilds: Object.fromEntries(['main', 'guard'].map(kind => [kind, { sha256: m.reuseBuilds[kind].sha256, ...capsules[kind].originalReceipt }])),
    originalEvidencePreserved: true, originalApprovalReused: false, originalTimesChanged: false, newCompilationClaimed: false,
    servicesChanged: false, productionWrites: 0, ddlExecuted: false };
  // Schema readers also use provenance after cutover. Only the normal admission
  // caller owns current-runtime checks; recursing into schema readers here would
  // call this provenance function again.
  if (!before) return result;
  for (const live of Object.values(m.live)) {
    const current = unit(live.unit);
    assert.equal(current.ActiveState, 'active'); assert.equal(current.SubState, 'running'); assert.equal(current.ControlPID, '0');
    assert.equal(Number(current.MainPID), live.pid); assert.equal(current.InvocationID, live.invocation);
    assert.equal(fs.realpathSync('/proc/' + current.MainPID + '/cwd'), live.root);
  }
  const captured = json(stage + '/capture.json');
  assert.equal(captured.manifestSha256, EXACT_UNPUBLISHED_PAIR.manifestSha256);
  assert.equal(captured.zeroBusinessWrites, true); assert.equal(captured.servicesChanged, false);
  assertProtection(captured.protection, before.protection);
  assertFreshPricingCapture(before.captured, captured.startControl);
  const deployed = verifyDeployedUsageSchema(m);
  if (before) {
    assert.equal(before.manifestSha256, sha(rootFile(m.stage + '/manifest.json')));
    assertFreshLegacyCapture(before.legacy, captured.legacy); assert.deepEqual(before.hdLegacy, captured.hdLegacy);
  }
  return { ...result, currentOriginalRuntimeVerified: true, database: deployed.observed };
}
export const CONTINUATION_COMMON_FIELDS = ['schema', 'chainId', 'attempt', 'sourceRun', 'sourceManifestSha256',
  'beforeSha256', 'approvalSha256', 'refusalSha256', 'lineageSha256'];
export function assertContinuationInput(value) {
  assert.ok(['sd2-normal-continuation-input.v1', CONTINUATION_V2].includes(value.schema), 'Unknown normal continuation schema');
  const migration = value.schema === 'sd2-normal-continuation-input.v1';
  assert.deepEqual(Object.keys(value).sort(), [...CONTINUATION_COMMON_FIELDS, ...(migration
    ? ['migrationRun', 'migrationManifestSha256', 'migrationReceiptSha256', 'backupProofSha256'] : [])].sort());
  for (const key of ['chainId', 'sourceRun', ...(migration ? ['migrationRun'] : [])]) assert.match(value[key], UUID);
  for (const key of Object.keys(value).filter(key => key.endsWith('Sha256'))) assert.match(value[key], HASH);
  assert.ok(Number.isSafeInteger(value.attempt) && value.attempt > 1);
  return value;
}
export function assertDeployedContinuationMode(m) {
  if (isExactUnpublishedReuse(m)) return assertExactUnpublishedInput(m);
  if (!m.normalContinuation) {
    assert.equal(m.reuseBuilds || null, null, 'Deployed schema reuse requires exact normal continuation v2');
    return null;
  }
  const input = assertContinuationInput(m.normalContinuation);
  assert.equal(input.schema, CONTINUATION_V2);
  assertDeployedSchemaInput(m.deployedUsageSchema);
  assertDeployedCanvasInput(m.deployedCanvasBatchSchema);
  assertCanvasBatchSchemaInput(m.canvasVideoBatchSchema);
  assert.match(m.runId, UUID); assert.notEqual(input.sourceRun, m.runId);
  const reuse = m.reuseBuilds;
  assert.ok(reuse);
  assert.deepEqual(Object.keys(reuse).sort(), ['schema', 'sourceRun', 'main', 'guard'].sort());
  assert.equal(reuse.schema, 'sd2-original-build-reuse-input.v1'); assert.equal(reuse.sourceRun, input.sourceRun);
  assert.notEqual(m.mainSource, m.guardSource);
  for (const kind of ['main', 'guard']) {
    assert.deepEqual(Object.keys(reuse[kind]).sort(), ['file', 'sha256']);
    assert.equal(reuse[kind].file, stageFor(input.sourceRun) + '/' + kind + '-immutable-success.json');
    assert.match(reuse[kind].sha256, HASH); assert.match(m[kind + 'Source'], /^[a-f0-9]{40}$/);
    assert.equal(m[kind].source, m[kind + 'Source']);
    assert.equal(m[kind].root, '/data/video-api-debugger/managed-releases/' + m[kind].source);
  }
  return input;
}
export function assertDeployedContinuationSources(m, prior) {
  const input = assertDeployedContinuationMode(m);
  assert.ok(input);
  assert.equal(prior.schema, 'rate-impl2-release.v1'); assert.equal(prior.project, 'video-api-debugger');
  assert.equal(prior.runId, input.sourceRun); assert.equal(prior.stage, stageFor(input.sourceRun));
  assert.equal(prior.normalContinuation || null, null); assert.equal(prior.reuseBuilds || null, null,
    'Continuation must point directly to the original full-build run');
  for (const key of ['mainSource', 'guardSource', 'database']) assert.equal(prior[key], m[key]);
  for (const key of ['deployedUsageSchema', 'deployedCanvasBatchSchema', 'canvasVideoBatchSchema']) assert.deepEqual(prior[key], m[key]);
  for (const kind of ['main', 'guard']) for (const key of ['source', 'root', 'version', 'buildDist'])
    assert.equal(prior[kind][key], m[kind][key], 'Original candidate pair changed: ' + kind + '.' + key);
  return input;
}
export function assertNoCutoverEffects(names) {
  const blocked = /^(?:\.switch\.lock$|guard-recovery-attempt|guard-recovery-start|fixed-guard-recovery-(?:attempt|start|complete)|natural-stop|usage-role-transition|writer-no-force|hd-manual-start|ingress-|network-fence-installed|pricing-pair|actual-prestart|raw-upload-recovery-published|switch-complete|rollback-|nginx-.*-(?:installed|install-prepared-\d+|install-progress-\d+|installation-aborted)\.json$)/;
  assert.ok(!names.some(name => blocked.test(name)), 'Previous attempt has cutover effects; use original recovery, not normal continuation');
}
export function assertFreshLegacyCapture(current, previous, now = Date.now()) {
  assert.equal(current.length, previous.length);
  for (let i = 0; i < current.length; i++) {
    const { checkedAt, ...rest } = current[i], { checkedAt: originalCheckedAt, ...original } = previous[i];
    assert.ok(Number.isSafeInteger(checkedAt) && Number.isSafeInteger(originalCheckedAt)
      && originalCheckedAt > 0 && checkedAt >= originalCheckedAt && checkedAt <= now && now - checkedAt < 300000);
    assert.deepEqual(rest, original);
  }
}
export function assertFreshPricingCapture(current, previous, now = Date.now()) {
  const { at, ...rest } = current, { at: originalAt, ...original } = previous;
  const observed = Date.parse(at), prior = Date.parse(originalAt);
  assert.ok(Number.isSafeInteger(observed) && Number.isSafeInteger(prior) && prior > 0
    && observed >= prior && observed <= now && now - observed < 300000);
  assert.deepEqual(rest, original);
}
function candidateSql(m, kind) {
  const file = m[kind].root + '/prisma/migrations/20261021073000_usage_attribution/migration.sql';
  assert.equal(fs.realpathSync(file), file);
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o777) === 0o644);
  assert.equal(stat.uid, Number(call('id', ['-u', m.appUser])));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'ctimeMs', 'mtimeMs']) assert.equal(after[key], stat[key]);
    assert.equal(fs.lstatSync(file).ino, stat.ino); return bytes;
  } finally { fs.closeSync(fd); }
}
function pinned(file, digest) {
  const bytes = rootFile(file); assert.equal(sha(bytes), digest, 'Original continuation evidence changed'); return JSON.parse(bytes);
}
function stageIdentity(directory) {
  assert.equal(fs.realpathSync(directory), directory);
  const s = fs.lstatSync(directory); assert.ok(s.isDirectory() && s.uid === 0 && !(s.mode & 0o077));
  assert.equal(call('findmnt', ['-n', '-o', 'TARGET', '-T', directory]), '/data');
}
export function assertOriginalMigration(m, originalManifest, receipt, backupProof) {
  assert.equal(originalManifest.mainSource, m.mainSource); assert.equal(originalManifest.guardSource, m.guardSource);
  assert.equal(originalManifest.database, m.database);
  assert.equal(receipt.schema, 'sd2-usage-attribution-migration.v1'); assert.equal(receipt.completed, true);
  assert.equal(receipt.runId, originalManifest.runId); assert.equal(receipt.source, m.mainSource); assert.equal(receipt.guardSource, m.guardSource);
  assert.equal(receipt.businessRowsWritten, 0); assert.equal(receipt.historyBackfilled, false); assert.equal(receipt.originalSchemaPreserved, true);
  assert.equal(backupProof.runId, receipt.runId); assert.equal(backupProof.consistent, true); assert.equal(backupProof.integrity, 'ok');
  for (const key of ['source', 'guardSource', 'manifestSha256', 'sqlSha256', 'backupSha256']) assert.equal(backupProof[key], receipt[key]);
  assert.ok(Number.isFinite(Date.parse(receipt.at)) && Date.parse(receipt.at) <= Date.now());
}
const PROBE = String.raw`
import sys,json,sqlite3,hashlib,os,pathlib
data=json.loads(sys.argv[1]); db=data['database']; backup=data['backup']
assert not os.path.islink(db) and os.path.isfile(db)
def schema(c):
 return {r[0]:[r[1],r[2],r[3]] for r in c.execute("SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")}
def digest(o): return hashlib.sha256(json.dumps(o,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()).hexdigest()
names=['UsageAttribution','UsageAttribution_owner_user_id_occurred_at_idx','UsageAttribution_project_id_occurred_at_idx','UsageAttribution_occurred_at_idx']
identity=[str(os.stat(db).st_dev),str(os.stat(db).st_ino)]
assert identity==data['identity']
with sqlite3.connect(pathlib.Path(backup).as_uri()+'?mode=ro',uri=True,timeout=30) as b:
 b.execute('PRAGMA query_only=ON'); b.execute('BEGIN')
 assert b.execute('PRAGMA integrity_check').fetchall()==[('ok',)]
 old=schema(b); assert not set(names).intersection(old)
 counts={n:b.execute('SELECT COUNT(*) FROM "'+n.replace('"','""')+'"').fetchone()[0] for n,v in old.items() if v[0]=='table'}
 assert counts==data['backupCounts']
with sqlite3.connect(pathlib.Path(db).as_uri()+'?mode=ro',uri=True,timeout=30) as c:
 c.execute('PRAGMA query_only=ON'); c.execute('BEGIN'); current=schema(c)
 assert set(current)-set(old)==set(names)
 assert all(current.get(k)==v for k,v in old.items())
 new={k:current[k] for k in sorted(names)}
 assert digest(new)==data['schemaSha256']
 rows=c.execute('SELECT COUNT(*) FROM UsageAttribution').fetchone()[0]
 if data['requireEmpty']: assert rows==0
assert [str(os.stat(db).st_dev),str(os.stat(db).st_ino)]==identity
print(json.dumps({'databaseIdentity':identity,'newSchemaSha256':digest(new),'backupIntegrity':'ok','originalSchemaPreserved':True,'attributionRows':rows,'databaseWrites':0}))
`;
function originalMigration(m, { requireEmpty = true } = {}) {
  const input = assertContinuationInput(m.normalContinuation), stage = stageFor(input.migrationRun);
  assert.equal(input.schema, 'sd2-normal-continuation-input.v1', 'Only v1 may adopt the first migration');
  stageIdentity(stage);
  const original = pinned(stage + '/manifest.json', input.migrationManifestSha256);
  const receipt = pinned(stage + '/usage-attribution-migration/receipt.json', input.migrationReceiptSha256);
  const proof = pinned(stage + '/usage-attribution-migration/backup-proof.json', input.backupProofSha256);
  assertOriginalMigration(m, original, receipt, proof);
  assert.equal(receipt.manifestSha256, input.migrationManifestSha256);
  const backup = stage + '/usage-attribution-migration/consistent-backup.sqlite';
  assert.equal(sha(rootFile(backup, 4 * 1024 ** 3)), receipt.backupSha256);
  for (const kind of ['main', 'guard']) assert.equal(sha(candidateSql(m, kind)), receipt.sqlSha256);
  const initial = json(stage + '/switch-before.json');
  const observed = JSON.parse(call('python3', ['-c', PROBE, JSON.stringify({ database: m.database, backup,
    identity: initial.protection.databaseIdentity, schemaSha256: receipt.newSchemaSha256, backupCounts: proof.originalTableCounts, requireEmpty })], { timeout: 120000 }));
  return { original, receipt, proof, backup, observed };
}
export function readNormalContinuationProvenance(m) {
  const input = assertContinuationInput(m.normalContinuation); assert.notEqual(input.sourceRun, m.runId);
  const stage = stageFor(input.sourceRun); stageIdentity(stage);
  const prior = pinned(stage + '/manifest.json', input.sourceManifestSha256);
  const saved = pinned(stage + '/switch-before.json', input.beforeSha256);
  const approval = pinned(stage + '/hd-release-safety-approval.json', input.approvalSha256);
  const refusal = pinned(stage + '/normal-switch-refusal.json', input.refusalSha256);
  const lineage = pinned(stage + '/lineage-closed.json', input.lineageSha256);
  assert.equal(prior.runId, input.sourceRun); assert.equal(saved.runId, prior.runId);
  assert.equal(saved.manifestSha256, input.sourceManifestSha256);
  assert.equal(prior.mainSource, m.mainSource); assert.equal(prior.guardSource, m.guardSource); assert.equal(prior.database, m.database);
  assert.equal(approval.runId, prior.runId); assert.equal(approval.manifestSha256, input.sourceManifestSha256);
  assert.equal(refusal.schema, 'sd2-normal-switch-refusal.v1'); assert.equal(refusal.runId, prior.runId);
  assert.equal(refusal.manifestSha256, input.sourceManifestSha256); assert.equal(refusal.effectsStarted, false);
  assert.equal(refusal.phase, 'before-maintenance'); assert.equal(refusal.exitCode, 1);
  assert.equal(path.basename(refusal.logFile), refusal.logFile); assert.ok(!refusal.logFile.includes('..'));
  assert.equal(sha(rootFile(stage + '/' + refusal.logFile)), refusal.logSha256);
  assert.equal(lineage.chainId, input.chainId); assert.equal(lineage.run, prior.runId); assert.equal(lineage.attempt + 1, input.attempt);
  assert.ok(Object.keys(lineage.releaseFailureCounts).length > 0);
  if (input.schema === CONTINUATION_V2) {
    assertDeployedContinuationSources(m, prior);
    assert.equal(refusal.originalPidAndProtectionFreshlyVerified, true);
    assert.equal(lineage.schema, 'sd2-release-lineage-closed.v1');
    assert.ok(Number.isSafeInteger(lineage.attempt) && lineage.attempt > 0);
    assert.ok(lineage.releaseFailureCounts && typeof lineage.releaseFailureCounts === 'object' && !Array.isArray(lineage.releaseFailureCounts));
    for (const count of Object.values(lineage.releaseFailureCounts)) assert.ok(Number.isSafeInteger(count) && count > 0);
    for (const key of ['originalRuntimeAndProtectionUnchanged', 'originalEvidencePreserved']) assert.equal(lineage[key], true);
    assert.equal(lineage.effectsStarted, false); assert.equal(lineage.servicesChanged, false); assert.equal(lineage.businessWrites, 0);
    assert.match(lineage.registryCloseCommandSha256, HASH);
    const refusedAt = Date.parse(refusal.at), closedAt = Date.parse(lineage.closedAt);
    assert.ok(Number.isFinite(refusedAt) && Number.isFinite(closedAt) && refusedAt <= closedAt && closedAt <= Date.now());
    if (refusal.hdDetailFile !== null) {
      assert.equal(path.basename(refusal.hdDetailFile), refusal.hdDetailFile); assert.ok(!refusal.hdDetailFile.includes('..'));
      assert.match(refusal.hdDetailSha256, HASH);
      const hd = pinned(stage + '/' + refusal.hdDetailFile, refusal.hdDetailSha256);
      assert.equal(hd.runId, prior.runId); assert.equal(hd.manifestSha256, input.sourceManifestSha256);
    } else assert.equal(refusal.hdDetailSha256, null);
  }
  assertNoCutoverEffects(fs.readdirSync(stage));
  const ancestors = new Set(); let p = process.pid;
  while (p > 1 && !ancestors.has(p)) { ancestors.add(p); const s = fs.readFileSync('/proc/' + p + '/stat', 'utf8'); p = Number(s.slice(s.lastIndexOf(')') + 2).split(/\s+/)[1]); }
  for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    if (ancestors.has(Number(pid))) continue;
    try { assert.equal(fs.readFileSync('/proc/' + pid + '/cmdline').includes(Buffer.from(stage + '/fix01-release/')), false, 'Previous controller is still running'); }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  assert.equal(sha(rootFile(stage + '/manifest.json')), input.sourceManifestSha256, 'Original manifest changed during provenance verification');
  return { input, prior, saved, approval, refusal, lineage };
}
export function verifyDeployedContinuationProvenance(m) {
  if (isExactUnpublishedReuse(m)) return verifyExactUnpublishedProvenance(m);
  assertDeployedContinuationMode(m);
  const value = readNormalContinuationProvenance(m);
  assert.equal(value.input.schema, CONTINUATION_V2);
  return value;
}
export function verifyNormalContinuation(m, before) {
  if (isSharedEngine(m) && m.reuseBuilds) return verifySharedBuildProvenance(m, before);
  if (isExactUnpublishedReuse(m)) return verifyExactUnpublishedProvenance(m, before);
  if (!m.normalContinuation) return null;
  assertReleaseWindow(m);
  const { input, prior, saved } = readNormalContinuationProvenance(m);
  if (input.schema === CONTINUATION_V2)
    assert.equal(before.manifestSha256, sha(rootFile(m.stage + '/manifest.json')), 'Fresh capture belongs to a different continuation manifest');
  assert.deepEqual(prior.live, m.live, 'Original running source/PID/invocation changed');
  for (const key of ['writers', 'policies', 'protectedFileIdentities', 'hdLegacy']) assert.deepEqual(before[key], saved[key]);
  assertFreshLegacyCapture(before.legacy, saved.legacy);
  assertFreshPricingCapture(before.captured, saved.captured);
  assert.deepEqual(before.roleControl.state, saved.roleControl.state);
  for (const key of ['fragment', 'dropins', 'loadedModuleSha']) assert.deepEqual(before.roleControl[key], saved.roleControl[key]);
  assertProtection(saved.protection, before.protection);
  if (input.schema === CONTINUATION_V2) {
    const deployed = verifyDeployedUsageSchema(m);
    const originals = {};
    for (const kind of ['main', 'guard']) {
      const capsule = readOriginalSuccess(m, kind);
      assert.equal(capsule.originalManifestSha256, input.sourceManifestSha256);
      assert.equal(capsule.originalReceipt.source, m[kind].source);
      assert.equal(capsule.originalReceipt.version, m[kind].version);
      assert.equal(capsule.newCompilationClaimed, false);
      originals[kind] = { sourceRun: capsule.sourceRun, sha256: m.reuseBuilds[kind].sha256,
        startedAt: capsule.originalReceipt.startedAt, finishedAt: capsule.originalReceipt.finishedAt };
    }
    return { operation: 'CONTINUE-NORMAL', schema: CONTINUATION_V2, chainId: input.chainId, attempt: input.attempt,
      sourceRun: input.sourceRun, originalEvidencePreserved: true, originalApprovalReused: false,
      servicesChanged: false, productionWrites: 0, ddlExecuted: false, originalBuilds: originals,
      deployedUsageSchema: m.deployedUsageSchema, deployedCanvasBatchSchema: m.deployedCanvasBatchSchema, database: deployed.observed };
  }
  const migration = originalMigration(m);
  return { operation: 'CONTINUE-NORMAL', chainId: input.chainId, attempt: input.attempt, sourceRun: input.sourceRun,
    originalEvidencePreserved: true, originalApprovalReused: false, servicesChanged: false, productionWrites: 0,
    originalMigration: { runId: migration.receipt.runId, at: migration.receipt.at, receiptSha256: input.migrationReceiptSha256,
      backupSha256: migration.receipt.backupSha256 }, database: migration.observed };
}
export function adoptOriginalMigration(m) {
  assert.equal(assertContinuationInput(m.normalContinuation).schema, 'sd2-normal-continuation-input.v1');
  if (fs.existsSync(m.stage + '/usage-attribution-migration-adopt.json')) {
    readMigrationEvidence(m); return json(m.stage + '/usage-attribution-migration-adopt.json');
  }
  const value = originalMigration(m), file = m.stage + '/usage-attribution-migration-adopt.json';
  const receipt = { schema: 'sd2-usage-attribution-migration-adopt.v1', operation: 'ADOPT', runId: m.runId,
    manifestSha256: sha(rootFile(m.stage + '/manifest.json')), source: m.mainSource, guardSource: m.guardSource,
    adoptedAt: new Date().toISOString(), completed: true, ddlExecuted: false, databaseWrites: 0, historyBackfilled: false,
    newSchemaSha256: value.receipt.newSchemaSha256, original: { runId: value.receipt.runId, at: value.receipt.at,
      manifestSha256: value.receipt.manifestSha256, receiptSha256: m.normalContinuation.migrationReceiptSha256,
      sqlSha256: value.receipt.sqlSha256, backupSha256: value.receipt.backupSha256, backupFile: value.backup }, observed: value.observed };
  writeJsonExclusive(file, receipt); call('chattr', ['+i', file]); return receipt;
}
export function readMigrationEvidence(m) {
  if (m.normalContinuation) assertContinuationInput(m.normalContinuation);
  if (m.deployedUsageSchema) return readDeployedUsageEvidence(m);
  if (!m.normalContinuation) return json(m.stage + '/usage-attribution-migration/receipt.json');
  const value = json(m.stage + '/usage-attribution-migration-adopt.json'), original = originalMigration(m, { requireEmpty: false });
  assert.equal(value.schema, 'sd2-usage-attribution-migration-adopt.v1'); assert.equal(value.operation, 'ADOPT');
  assert.equal(value.runId, m.runId); assert.equal(value.manifestSha256, sha(rootFile(m.stage + '/manifest.json')));
  assert.equal(value.completed, true); assert.equal(value.ddlExecuted, false); assert.equal(value.databaseWrites, 0);
  assert.ok(call('lsattr', ['-d', m.stage + '/usage-attribution-migration-adopt.json']).split(/\s+/)[0].includes('i'));
  assert.equal(value.original.runId, original.receipt.runId); assert.equal(value.original.at, original.receipt.at);
  assert.equal(value.original.receiptSha256, m.normalContinuation.migrationReceiptSha256);
  assert.equal(value.original.backupSha256, original.receipt.backupSha256); assert.equal(value.newSchemaSha256, original.receipt.newSchemaSha256);
  return { ...original.receipt, adoptedByRun: m.runId, adoptionFile: m.stage + '/usage-attribution-migration-adopt.json' };
}
export function recordHdAdmission(m, detail) {
  const file = m.stage + '/hd-admission-attempt-' + Date.now() + '-' + process.pid + '.json';
  writeJsonExclusive(file, { runId: m.runId, manifestSha256: sha(rootFile(m.stage + '/manifest.json')),
    observedAt: new Date().toISOString(), detail }); return file;
}
export function restoredRefusalCurrentFiles(names, proofSha256, historicalDynamic, predecessorProofSha256) {
  assert.match(proofSha256, HASH); assert.match(predecessorProofSha256, HASH); assert.notEqual(proofSha256, predecessorProofSha256);
  assert.ok(Array.isArray(historicalDynamic) && historicalDynamic.every(name => typeof name === 'string' && path.basename(name) === name));
  const historical = new Set(historicalDynamic);
  return names.filter(name => !historical.has(name) && !name.endsWith('-' + predecessorProofSha256 + '.json'));
}
export function recordNormalRefusal(m, before, error, hdFile, { receiptName = 'normal-switch-refusal.json',
  logName = 'normal-switch-refusal.log' } = {}) {
  assert.match(receiptName, /^normal-switch-refusal(?:-[a-f0-9]{64})?\.json$/);
  assert.match(logName, /^normal-switch-refusal(?:-[a-f0-9]{64})?\.log$/);
  assert.equal(receiptName.slice(0, -5), logName.slice(0, -4), 'Refusal receipt and log must belong to the same attempt');
  const runtime = guardBuildTailRuntime(m), repair = runtime?.restoredOriginalRepair;
  let names = fs.readdirSync(m.stage).filter(file => file !== '.switch.lock');
  if (repair) {
    assert.equal(receiptName, 'normal-switch-refusal-' + repair.proofSha256 + '.json');
    const terminal = JSON.parse(rootFile(runtime.restoredOriginalClosure.terminal.file, 4 * 1024 * 1024));
    assert.equal(sha(rootFile(runtime.restoredOriginalClosure.terminal.file)), runtime.restoredOriginalClosure.terminal.sha256);
    assert.equal(terminal.kind, 'attempt_finished'); assert.equal(terminal.outcome, 'failed'); assert.equal(terminal.after.facts.effectsStarted, true);
    names = restoredRefusalCurrentFiles(names, repair.proofSha256, terminal.after.facts.dynamic, runtime.switchWindowRepair.proofSha256);
  }
  assertNoCutoverEffects(names);
  for (const role of ['web', 'image', 'hd', 'role']) {
    const live = operationalLive(m, role), current = unit(live.unit);
    assert.equal(current.ActiveState, 'active'); assert.equal(current.SubState, 'running'); assert.equal(current.ControlPID, '0');
    assert.equal(Number(current.MainPID), live.pid); assert.equal(current.InvocationID, live.invocation);
    assert.equal(fs.realpathSync('/proc/' + current.MainPID + '/cwd'), live.root);
  }
  assertProtection(before.protection, readProtection(m));
  const logFile = logName, bytes = Buffer.from(String(error.stack || error));
  fs.writeFileSync(m.stage + '/' + logFile, bytes, { flag: 'wx', mode: 0o600 });
  const fd = fs.openSync(m.stage + '/' + logFile, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  writeJsonExclusive(m.stage + '/' + receiptName, { schema: 'sd2-normal-switch-refusal.v1', runId: m.runId,
    manifestSha256: sha(rootFile(m.stage + '/manifest.json')), phase: 'before-maintenance', effectsStarted: false,
    exitCode: 1, at: new Date().toISOString(), logFile, logSha256: sha(bytes),
    hdDetailFile: hdFile ? path.basename(hdFile) : null, hdDetailSha256: hdFile ? sha(rootFile(hdFile)) : null,
    ...(repair ? { historicalEffectsRetained: true, restoredOriginalClosureProofSha256: runtime.restoredOriginalClosure.proofSha256,
      currentRepairProofSha256: repair.proofSha256 } : {}), originalPidAndProtectionFreshlyVerified: true });
}
