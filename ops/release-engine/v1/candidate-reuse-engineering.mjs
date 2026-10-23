import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { candidateEvidenceFile, assertFreshCandidateEvidence, REUSE_SCHEMA } from './candidate-evidence.mjs';
import { inspectReuseTreeForEngineering, assertControlOnlyChange, assertNginxMaintenancePinChange, assertPackagingAncestryChange,
  assertFirstRuntimeAliasProvenance, verifyOriginalSuccess } from './candidate-reuse.mjs';
import { createRecoverySafetyFixture } from './cutover-safety-engineering.mjs';
import { assertPricingPairTransition } from './pricing-start-pair.mjs';
import { rejectedPricingRoots, isSharedEngine, engineDirectory } from './common.mjs';
import { assertCapturedLive } from './release.mjs';
import { MV_DIRECT } from './release-contract.mjs';
import { CONTINUATION_V2, CONTINUATION_COMMON_FIELDS, SHARED_BUILD_PROVENANCE, assertSharedBuildReuseInput,
  assertSharedBuildSources, assertSharedNoEffectsRecords, assertSharedBuildCapsules } from './normal-continuation.mjs';
import { ENGINE_VERSION } from './engine-version.mjs';
import { DEPLOYED_FIELDS, DEPLOYED_SCHEMA } from './deployed-usage-schema.mjs';
import { DEPLOYED_CANVAS_FIELDS } from './canvas-batch-schema.mjs';
import { currentReleaseContext } from './engine-context.mjs';
import { rootFile } from './common.mjs';

const ts = createRequire('/data/video-api-debugger/managed-releases/' + MV_DIRECT.baselineSource + '/package.json')('typescript');
function moduleBody(source) {
  const tree = ts.createSourceFile('source.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), edits = [];
  assert.equal(tree.parseDiagnostics.length, 0);
  for (const statement of tree.statements) {
    if (ts.isImportDeclaration(statement)) edits.push([statement.getStart(tree), statement.end, '']);
    else for (const modifier of statement.modifiers || [])
      if (modifier.kind === ts.SyntaxKind.ExportKeyword) edits.push([modifier.getStart(tree), modifier.end, '']);
  }
  for (const [start, end, text] of edits.sort((a, b) => b[0] - a[0])) source = source.slice(0, start) + text + source.slice(end);
  return source;
}
const checks = [], add = name => checks.push(name), now = 100_000_000;
{
  const m = { reuseBuilds: { sourceRun: 'original-full-run' }, main: { source: 'a'.repeat(40), root: '/data/candidate' }, live: { web: { root: '/data/old', source: 'b'.repeat(40) } } };
  const capsule = { kind: 'main', sourceRun: 'original-full-run', originallyVerifiedWithinThirtyMinuteGate: true,
    originalTimesChanged: false, newCompilationClaimed: false, originalReceipt: { source: m.main.source, exitCode: 0, verifiedSourceAndGates: true } };
  assertFirstRuntimeAliasProvenance(m, 'main', capsule, ['main-build.json', 'main-immutable-success.json'], []);
  for (const name of ['switch-before.json', 'switch-complete.json', 'fixed-guard-recovery.json', 'natural-stop-intent-switch-web.json',
    'usage-role-transition-0001.json', 'ingress-503-switch.json', 'network-fence-installed.json', 'pricing-pair-published.json'])
    assert.throws(() => assertFirstRuntimeAliasProvenance(m, 'main', capsule, [name], []));
  assert.throws(() => assertFirstRuntimeAliasProvenance(m, 'main', capsule, [], [123]));
  assert.throws(() => assertFirstRuntimeAliasProvenance({ ...m, live: { web: m.main } }, 'main', capsule, [], []));
  assert.throws(() => assertFirstRuntimeAliasProvenance(m, 'main', { ...capsule, originalTimesChanged: true }, [], []));
  const implementation = fs.readFileSync(new URL('./candidate-reuse.mjs', import.meta.url), 'utf8');
  assert.ok(implementation.indexOf('assertFirstRuntimeAliasProvenance(m, kind, capsule, fs.readdirSync(sourceStage(m)), activePids, continuation)')
    < implementation.indexOf('fs.symlinkSync(c.buildDist, link)'));
  const provenanceCall = implementation.indexOf('const continuation = isSharedEngine(m)');
  assert.ok(provenanceCall >= 0 && provenanceCall
    < implementation.indexOf('assertFirstRuntimeAliasProvenance(m, kind, capsule, fs.readdirSync(sourceStage(m)), activePids, continuation)'));
  assert.ok(implementation.includes("if (error.code !== 'ENOENT') throw error"));
  assert.ok(implementation.includes('value.isSymbolicLink() && value.uid === 0'));
  add('never-published-original-pair-first-alias-only-no-repair-of-existing-alias-or-active-candidate');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'first-runtime-alias-'));
  try {
    const candidate = temporary + '/candidate', original = temporary + '/original', stage = temporary + '/current';
    for (const directory of [candidate, original, stage, candidate + '/.next-prod-candidate']) fs.mkdirSync(directory);
    const actual = { ...m, runId: 'current-fixture', stage, main: { ...m.main, root: candidate, buildDist: '.next-prod-candidate' } };
    fs.writeFileSync(original + '/manifest.json', JSON.stringify({ main: actual.main }));
    const context = { fs, path, vm, process, Buffer, JSON, Date, CONTINUATION_V2, isSharedEngine, engineDirectory,
      assert: { ...assert, deepEqual: (a, b, message) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), message) },
      rootFile: file => fs.readFileSync(file), writeJsonExclusive: (file, value) => fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 }),
      fixtureOriginal: original };
    vm.runInNewContext(moduleBody(implementation)
      + '\nsourceStage=()=>globalThis.fixtureOriginal;globalThis.prepareAlias=prepareFirstRuntimeAlias;', context);
    context.prepareAlias(actual, 'main', capsule);
    assert.equal(fs.readlinkSync(candidate + '/.next-prod'), '.next-prod-candidate');
    const initial = fs.lstatSync(candidate + '/.next-prod'); context.prepareAlias(actual, 'main', capsule);
    assert.equal(fs.lstatSync(candidate + '/.next-prod').ino, initial.ino);
    let continuationChecks = 0;
    context.verifyDeployedContinuationProvenance = () => { continuationChecks++; throw new Error('Unverified original refusal'); };
    assert.throws(() => context.prepareAlias({ ...actual, normalContinuation: { schema: CONTINUATION_V2 } }, 'main', capsule), /Unverified original refusal/);
    assert.equal(continuationChecks, 1); assert.equal(fs.lstatSync(candidate + '/.next-prod').ino, initial.ino);
    add('actual_alias_call_site_checks_v2_original_refusal_before_any_alias_write');
    fs.unlinkSync(candidate + '/.next-prod'); fs.symlinkSync('missing-artifact', candidate + '/.next-prod');
    assert.throws(() => context.prepareAlias(actual, 'main', capsule));
    assert.equal(fs.readlinkSync(candidate + '/.next-prod'), 'missing-artifact');
    fs.unlinkSync(candidate + '/.next-prod'); fs.mkdirSync(candidate + '/.next-prod');
    assert.throws(() => context.prepareAlias(actual, 'main', capsule));
    assert.equal(fs.lstatSync(candidate + '/.next-prod').isDirectory(), true);
    add('actual_isolated_first_symlink_and_existing_wrong_or_broken_alias_never_overwritten');
  } finally { fs.rmSync(temporary, { recursive: true }); }
}
{
  const sourceRun = '30000000-0000-4000-8000-000000000001', runId = '30000000-0000-4000-8000-000000000002';
  const digest = value => createHash('sha256').update(value).digest('hex');
  const projectRoot = '/data/video-api-debugger', privateSha256 = { 'hd-storage-preflight.mjs': 'a'.repeat(64) };
  const controllerSetSha256 = digest(JSON.stringify(privateSha256));
  const m = { schema: 'rate-impl2-release.v1', project: 'video-api-debugger', projectRoot, runId,
    stage: projectRoot + '/release-staging/' + runId, privateSha256,
    engine: { schema: 'sd2-release-engine.v1', version: ENGINE_VERSION, controllerSetSha256,
      root: projectRoot + '/release-engines/' + ENGINE_VERSION + '-' + controllerSetSha256 },
    operation: { schema: 'sd2-release-operation.v1', taskId: '30000000-0000-4000-8000-000000000003', attemptId: runId,
      taskRoot: projectRoot + '/release-tasks/30000000-0000-4000-8000-000000000003' },
    mainSource: 'b'.repeat(40), guardSource: 'c'.repeat(40),
    protectedIncrement: { pricingWrites: false, multiviewGeneration: false, canvasVideoBatchWrites: false },
    recoveredGuardBaseline: { schema: 'synthetic-recovered-source' },
    live: { hd: { unit: 'sd2-hd-derivatives.service', source: 'd'.repeat(40), root: '/data/live', version: '0.1.0', build: 'live',
      pid: 123, invocation: 'e'.repeat(32), execMainStartTimestampMonotonic: '123456' } },
    reuseBuilds: { schema: 'sd2-original-build-reuse-input.v1', sourceRun } };
  for (const kind of ['main', 'guard']) {
    m[kind] = { source: m[kind + 'Source'], version: '0.1.1' + (kind === 'guard' ? '+guard.1' : ''),
      root: projectRoot + '/managed-releases/' + m[kind + 'Source'], buildDist: '.next-prod-candidate' };
    m.reuseBuilds[kind] = { file: projectRoot + '/release-staging/' + sourceRun + '/' + kind + '-immutable-success.json', sha256: 'f'.repeat(64) };
  }
  const prior = { ...structuredClone(m), runId: sourceRun, stage: projectRoot + '/release-staging/' + sourceRun,
    engine: undefined, operation: undefined, reuseBuilds: null };
  assertSharedBuildReuseInput(m); assertSharedBuildSources(m, prior);
  const sharedPrior = { ...structuredClone(prior), engine: structuredClone(m.engine), operation: {
    schema: 'sd2-release-operation.v1', taskId: '30000000-0000-4000-8000-000000000005', attemptId: sourceRun,
    taskRoot: projectRoot + '/release-tasks/30000000-0000-4000-8000-000000000005' } };
  assertSharedBuildSources(m, sharedPrior);
  add('shared_engine_accepts_direct_sealed_pair_without_concrete_run_id_exception');
  for (const [name, mutate] of [
    ['engine-version', value => { value.engine.version = '999.0.0'; }],
    ['engine-root', value => { value.engine.root += '-other'; }],
    ['engine-hash', value => { value.engine.controllerSetSha256 = '0'.repeat(64); }],
    ['attempt', value => { value.operation.attemptId = sourceRun; }],
    ['task', value => { value.operation.taskId = 'not-a-uuid'; }],
    ['pair-source', value => { value.main.source = value.guard.source; }],
    ['legacy-continuation', value => { value.normalContinuation = { schema: CONTINUATION_V2 }; }],
  ]) { const changed = structuredClone(m); mutate(changed); assert.throws(() => assertSharedBuildReuseInput(changed)); add('shared_rejects_' + name); }
  for (const [name, mutate] of [
    ['recursive-build-origin', value => { value.reuseBuilds = m.reuseBuilds; }],
    ['changed-original-pair', value => { value.guard.source = '0'.repeat(40); }],
    ['protected-writes', value => { value.protectedIncrement.pricingWrites = true; }],
    ['recovered-source', value => { value.recoveredGuardBaseline.schema = 'other'; }],
    ['live-pid', value => { value.live.hd.pid++; }],
    ['live-start', value => { value.live.hd.execMainStartTimestampMonotonic = '999'; }],
    ['unknown-live-field', value => { value.live.hd.unreviewed = true; }],
  ]) { const changed = structuredClone(prior); mutate(changed); assert.throws(() => assertSharedBuildSources(m, changed)); add('shared_origin_rejects_' + name); }
  const manifestSha256 = '1'.repeat(64), group = prior.stage;
  const capsules = Object.fromEntries(['main', 'guard'].map(kind => [kind, { schema: 'sd2-immutable-successful-build.v1', kind,
    sourceRun, originalManifestSha256: manifestSha256, originalTimesChanged: false, newCompilationClaimed: false,
    originallyVerifiedWithinThirtyMinuteGate: true, sealedAt: new Date(3000).toISOString(),
    originalReceipt: { schema: 'rate-impl2-candidate-build.v1', label: kind, runId: sourceRun,
      source: m[kind].source, version: m[kind].version, build: kind + '-original-build', exitCode: 0,
      verifiedSourceAndGates: true, startedAt: 1000, finishedAt: 2000 } }]));
  assertSharedBuildCapsules(m, prior, manifestSha256, capsules);
  for (const [name, mutate] of [
    ['failed-original-leaf', value => { value.main.originalReceipt.exitCode = 1; }],
    ['partial-original-leaf', value => { value.guard.originalReceipt.verifiedSourceAndGates = false; }],
    ['missing-original-leaf', value => { delete value.guard; }],
    ['mixed-original-run', value => { value.guard.sourceRun = runId; }],
    ['changed-original-manifest', value => { value.main.originalManifestSha256 = '0'.repeat(64); }],
    ['relabeled-original-time', value => { value.main.originalTimesChanged = true; }],
    ['new-compilation-claim', value => { value.guard.newCompilationClaimed = true; }],
    ['late-original-seal', value => { value.main.sealedAt = new Date(1801001).toISOString(); }],
  ]) { const changed = structuredClone(capsules); mutate(changed); assert.throws(() => assertSharedBuildCapsules(m, prior, manifestSha256, changed)); add('shared_capsules_reject_' + name); }
  const refusal = { name: 'normal-switch-refusal.json', group, value: { schema: 'sd2-normal-switch-refusal.v1',
    runId: sourceRun, manifestSha256, phase: 'before-maintenance', effectsStarted: false,
    originalPidAndProtectionFreshlyVerified: true, exitCode: 1, at: new Date(now).toISOString() } };
  const command = { name: 'normal-switch-command-return.json', group, value: { runId: sourceRun, status: 1,
    signal: null, error: null, at: new Date(now + 1).toISOString() } };
  const observed = { name: 'switch-before.json', group, value: { schema: 'rate-impl2-switch-before.v1', runId: sourceRun, manifestSha256 } };
  const records = [observed, refusal, command];
  assertSharedNoEffectsRecords(prior, manifestSha256, records, [], []);
  assertSharedNoEffectsRecords(prior, manifestSha256, [], [], []);
  add('shared_no_effects_requires_factual_refusal_but_untouched_success_needs_no_fake_refusal');
  for (const field of ['effectsStarted', 'originalPidAndProtectionFreshlyVerified', 'runId', 'manifestSha256', 'phase', 'exitCode']) {
    const changed = structuredClone(records), value = changed[1].value;
    value[field] = field === 'effectsStarted' ? true : field === 'originalPidAndProtectionFreshlyVerified' ? false : field === 'exitCode' ? 0 : 'other';
    assert.throws(() => assertSharedNoEffectsRecords(prior, manifestSha256, changed, [], [])); add('shared_refusal_rejects_' + field);
  }
  assert.throws(() => assertSharedNoEffectsRecords(prior, manifestSha256, [observed], [], []));
  assert.throws(() => assertSharedNoEffectsRecords(prior, manifestSha256, [refusal], [], []));
  assert.throws(() => assertSharedNoEffectsRecords(prior, manifestSha256, records, [123], []));
  assert.throws(() => assertSharedNoEffectsRecords(prior, manifestSha256, records, [], [124]));
  add('shared_missing_refusal_or_actual_return_or_live_candidate_controller_refused');
  for (const name of ['natural-stop-intent-switch-hd.json', 'usage-role-transition-0001.json', 'network-fence-installed.json',
    'ingress-503-switch.json', 'pricing-pair-published.json', 'actual-prestart.json', 'fixed-guard-recovery-start-intent.json',
    'multiview-backup-published.json', 'nginx-test-installed.json', 'switch-complete.json']) {
    assert.throws(() => assertSharedNoEffectsRecords(prior, manifestSha256, [...records, { name, group, value: { effectsStarted: false } }], [], []));
    add('shared_actual_effect_not_excused_by_false_summary_' + name);
  }
  const originalBuild = { schema: 'rate-impl2-candidate-build.v1', label: 'main', runId: sourceRun, ...m.main,
    build: 'original-build', startedAt: 1000, finishedAt: 2000, gateReceipt: '/original/receipt', exitCode: 0, verifiedSourceAndGates: true };
  const admission = { ...originalBuild, schema: REUSE_SCHEMA, runId, engine: m.engine, operation: m.operation,
    originalBuild, originalSuccessSha256: m.reuseBuilds.main.sha256, originalTimesChanged: false, newCompilationClaimed: false,
    reuseInputsFullyVerified: true, validatedAt: now, expiresAt: now + 1800000 };
  assertFreshCandidateEvidence(admission, m, 'main', now);
  const capsule = { kind: 'main', sourceRun, originalManifestSha256: manifestSha256,
    originallyVerifiedWithinThirtyMinuteGate: true, originalTimesChanged: false, newCompilationClaimed: false,
    originalReceipt: { source: m.main.source, exitCode: 0, verifiedSourceAndGates: true } };
  const provenance = { schema: SHARED_BUILD_PROVENANCE, input: m.reuseBuilds, prior, originalManifestSha256: manifestSha256,
    noEffects: true, originalControllerStopped: true, candidateProcessesStopped: true, originalEvidencePreserved: true,
    originalBuilds: { main: { sha256: m.reuseBuilds.main.sha256 } } };
  assertFirstRuntimeAliasProvenance(m, 'main', capsule, ['switch-before.json', 'fixed-guard-recovery.json'], [], provenance);
  for (const key of ['noEffects', 'originalControllerStopped', 'candidateProcessesStopped', 'originalEvidencePreserved']) {
    assert.throws(() => assertFirstRuntimeAliasProvenance(m, 'main', capsule, [], [], { ...provenance, [key]: false }));
    add('shared_first_alias_requires_' + key);
  }
  assert.throws(() => assertFirstRuntimeAliasProvenance(m, 'main', capsule, [], [], null));
  assert.throws(() => assertFirstRuntimeAliasProvenance(m, 'main', capsule, [], [123], provenance));
  add('shared_first_alias_uses_verified_no_effects_facts_not_legacy_filename_filter');
  for (const field of ['engine', 'operation']) {
    const changed = structuredClone(admission); changed[field][field === 'engine' ? 'controllerSetSha256' : 'attemptId'] = 'other';
    assert.throws(() => assertFreshCandidateEvidence(changed, m, 'main', now)); add('shared_admission_rejects_different_' + field);
  }
  assert.throws(() => assertFreshCandidateEvidence(admission, m, 'main', now + 1800000));
  const next = structuredClone(m); next.runId = '30000000-0000-4000-8000-000000000004';
  next.stage = projectRoot + '/release-staging/' + next.runId; next.operation.attemptId = next.runId;
  const renewed = { ...admission, runId: next.runId, operation: next.operation, validatedAt: now + 1800000, expiresAt: now + 3600000 };
  assertFreshCandidateEvidence(renewed, next, 'main', now + 1800000);
  assert.equal(renewed.startedAt, admission.startedAt); assert.equal(renewed.finishedAt, admission.finishedAt);
  assert.notEqual(candidateEvidenceFile(next, 'main'), candidateEvidenceFile(m, 'main'));
  add('expired_shared_admission_revalidated_in_new_attempt_without_overwriting_original_or_rebuilding');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-build-origin-'));
  try {
    const stage = temporary + '/original', archive = stage + '/switch-attempt01';
    fs.mkdirSync(stage, { mode: 0o700 }); fs.mkdirSync(archive, { mode: 0o700 });
    fs.writeFileSync(stage + '/capture.json', JSON.stringify({ manifestSha256, zeroBusinessWrites: true, servicesChanged: false }), { mode: 0o600 });
    const write = (name, value) => {
      const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
      fs.writeFileSync(archive + '/' + name, bytes, { mode: 0o600 });
      return { originalPath: stage + '/' + name, archivedPath: archive + '/' + name, sha256: digest(bytes), bytes: bytes.length };
    };
    const refusalLog = 'original refusal transcript', controllerLog = 'actual exited controller transcript';
    const archivedRefusal = { ...refusal.value, logFile: 'normal-switch-refusal.log', logSha256: digest(refusalLog), hdDetailFile: null, hdDetailSha256: null };
    const archivedCommand = { ...command.value, log: stage + '/normal-switch-controller.log', logSha256: digest(controllerLog) };
    const mapping = [write('switch-before.json', observed.value), write('normal-switch-refusal.json', archivedRefusal),
      write('normal-switch-command-return.json', archivedCommand), write('normal-switch-refusal.log', refusalLog), write('normal-switch-controller.log', controllerLog)];
    const map = { runId: sourceRun, at: new Date(now + 2).toISOString(), effectsStarted: false,
      originalPidAndProtectionFreshlyVerified: true, originalBytesUnchanged: true, originalFailurePreserved: true, mapping };
    const saveMap = () => fs.writeFileSync(archive + '/path-mapping.json', JSON.stringify(map), { mode: 0o600 }); saveMap();
    const source = fs.readFileSync(new URL('./normal-continuation.mjs', import.meta.url), 'utf8');
    const context = { fs, path, Buffer, JSON, Date, process, structuredClone,
      assert: { ...assert, deepEqual: (a, b, message) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), message) },
      rootFile: file => {
        assert.equal(fs.realpathSync(file), file); const stat = fs.lstatSync(file);
        assert.ok(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o022) && stat.size > 0);
        return fs.readFileSync(file);
      }, sha: digest };
    vm.runInNewContext(moduleBody(source)
      + '\nglobalThis.collectOrigin=sharedOriginRecords;', context);
    const actualPrior = { ...prior, stage }, proof = context.collectOrigin(actualPrior);
    assertSharedNoEffectsRecords(prior, manifestSha256, proof.records, [], []);
    assert.equal(proof.evidence[archive + '/normal-switch-refusal.log'], digest(refusalLog));
    add('actual_archived_attempt_reads_explicit_original_paths_hashes_logs_and_refusal_facts');
    fs.writeFileSync(archive + '/normal-switch-refusal.log', 'tampered'); assert.throws(() => context.collectOrigin(actualPrior));
    fs.writeFileSync(archive + '/normal-switch-refusal.log', refusalLog);
    const savedPath = mapping[0].originalPath; mapping[0].originalPath = '/outside/switch-before.json'; saveMap();
    assert.throws(() => context.collectOrigin(actualPrior)); mapping[0].originalPath = savedPath; saveMap();
    const savedArchive = mapping[0].archivedPath; mapping[0].archivedPath = stage + '/switch-before.json'; saveMap();
    assert.throws(() => context.collectOrigin(actualPrior)); mapping[0].archivedPath = savedArchive; saveMap();
    fs.writeFileSync(archive + '/unmapped.json', '{}'); assert.throws(() => context.collectOrigin(actualPrior));
    fs.unlinkSync(archive + '/unmapped.json');
    mapping.push(write('network-fence-installed.json', { effectsStarted: false })); saveMap();
    const unsafe = context.collectOrigin(actualPrior);
    assert.throws(() => assertSharedNoEffectsRecords(prior, manifestSha256, unsafe.records, [], []));
    add('actual_archive_tampered_log_outside_original_path_wrong_archive_unmapped_and_hidden_effect_refused');
  } finally { fs.rmSync(temporary, { recursive: true }); }
  const aliasTemporary = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-artifact-alias-'));
  try {
    const actual = structuredClone(m); actual.projectRoot = aliasTemporary;
    actual.stage = aliasTemporary + '/release-staging/' + runId;
    actual.operation.taskRoot = aliasTemporary + '/release-tasks/' + actual.operation.taskId;
    actual.engine.root = aliasTemporary + '/release-engines/' + ENGINE_VERSION + '-' + controllerSetSha256;
    for (const kind of ['main', 'guard']) actual[kind].root = aliasTemporary + '/managed-releases/' + actual[kind].source;
    const originalStage = aliasTemporary + '/release-staging/' + sourceRun;
    for (const directory of [actual.stage, originalStage, actual.operation.taskRoot, actual.main.root + '/.next-prod-candidate'])
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(originalStage + '/manifest.json', JSON.stringify({ main: actual.main }), { mode: 0o600 });
    fs.writeFileSync(actual.stage + '/manifest.json', JSON.stringify(actual), { mode: 0o600 });
    const implementation = fs.readFileSync(new URL('./candidate-reuse.mjs', import.meta.url), 'utf8');
    const context = { fs, path, Buffer, JSON, Date, process, structuredClone, CONTINUATION_V2, SHARED_BUILD_PROVENANCE,
      isSharedEngine, engineDirectory, sha: digest,
      assert: { ...assert, deepEqual: (a, b, message) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), message) },
      rootFile: file => fs.readFileSync(file),
      writeJsonExclusive: (file, value) => fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 }),
      assertSharedBuildSources: (value, origin) => assert.equal(value.main.source, origin.main.source),
      verifySharedBuildProvenance: (value, before, options) => {
        assert.equal(options.requireCandidatesStopped, true);
        return { ...provenance, prior: { main: value.main }, input: value.reuseBuilds };
      }, fixtureOriginal: originalStage };
    vm.runInNewContext(moduleBody(implementation)
      + '\nsourceStage=()=>globalThis.fixtureOriginal;globalThis.prepareAlias=prepareFirstRuntimeAlias;globalThis.readBinding=readSharedRuntimeAliasBinding;', context);
    context.prepareAlias(actual, 'main', capsule);
    const binding = context.readBinding(actual, 'main', capsule), bindingBytes = fs.readFileSync(binding.file);
    assert.equal(fs.lstatSync(path.dirname(binding.file)).mode & 0o7777, 0o700);
    assert.equal(fs.lstatSync(binding.file).mode & 0o7777, 0o600);
    const nextAttempt = structuredClone(actual); nextAttempt.runId = next.runId; nextAttempt.operation.attemptId = next.runId;
    nextAttempt.stage = aliasTemporary + '/release-staging/' + next.runId;
    fs.mkdirSync(nextAttempt.stage, { mode: 0o700 }); fs.writeFileSync(nextAttempt.stage + '/manifest.json', JSON.stringify(nextAttempt), { mode: 0o600 });
    context.prepareAlias(nextAttempt, 'main', capsule);
    assert.deepEqual(fs.readFileSync(binding.file), bindingBytes);
    assert.deepEqual(context.readBinding(nextAttempt, 'main', capsule), binding);
    add('actual_shared_alias_root_binding_persists_identity_and_original_time_across_attempts_without_overwrite');
    const crossTask = structuredClone(actual); crossTask.operation.taskId = '30000000-0000-4000-8000-000000000006';
    crossTask.operation.taskRoot = aliasTemporary + '/release-tasks/' + crossTask.operation.taskId;
    fs.mkdirSync(crossTask.operation.taskRoot, { mode: 0o700 });
    assert.throws(() => context.prepareAlias(crossTask, 'main', capsule), error => error.code === 'evidence_missing');
    fs.renameSync(binding.file, binding.file + '.retained');
    assert.throws(() => context.prepareAlias(actual, 'main', capsule), error => error.code === 'evidence_missing');
    fs.renameSync(binding.file + '.retained', binding.file);
    const alias = actual.main.root + '/.next-prod'; fs.renameSync(alias, alias + '.retained');
    fs.symlinkSync(actual.main.buildDist, alias);
    assert.throws(() => context.prepareAlias(actual, 'main', capsule));
    fs.unlinkSync(alias);
    assert.throws(() => context.prepareAlias(actual, 'main', capsule));
    assert.equal(fs.existsSync(alias), false);
    add('actual_shared_alias_same_target_recreation_missing_proof_cross_task_and_missing_alias_refused_without_repair');
  } finally { fs.rmSync(aliasTemporary, { recursive: true }); }
}
{
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-complete-build-'));
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const implementation = fs.readFileSync(new URL('./candidate-reuse.mjs', import.meta.url), 'utf8');
  try {
    for (const changed of ['source', 'lock', 'configuration', 'dependencies', 'node', 'environment', 'role-tests', 'compiled', 'prepared']) {
      const base = temporary + '/' + changed, root = base + '/application', stage = base + '/original';
      fs.mkdirSync(base); fs.mkdirSync(root); fs.mkdirSync(stage);
      const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { mode: 0o600 }); };
      const files = { 'package.json': '{"version":"0.1.1"}', 'package-lock.json': '{"lockfileVersion":3}',
        'next.config.mjs': 'export default {};', 'src/input.ts': 'export const value=1;' };
      for (const [file, bytes] of Object.entries(files)) write(root + '/' + file, bytes);
      const paths = { source: root + '/src/input.ts', lock: root + '/package-lock.json', configuration: root + '/next.config.mjs',
        dependencies: root + '/node_modules/dependency/index.js', node: base + '/node', environment: base + '/env',
        'role-tests': root + '/.role-tests/original.log', compiled: root + '/.next-prod-candidate/server/page.js', prepared: stage + '/main-prepared.json' };
      for (const file of [paths.dependencies, paths.node, paths.environment, paths['role-tests'], paths.compiled]) write(file, 'original');
      write(root + '/.next-prod-candidate/static/chunk.js', 'compiled-original'); write(root + '/.next-prod-candidate/BUILD_ID', 'original-build');
      for (const [alias, target] of [['.env', paths.environment], ['storage', base + '/storage'], ['public/uploads', base + '/uploads'], ['public/videos', base + '/videos']]) {
        if (alias !== '.env') fs.mkdirSync(target);
        fs.mkdirSync(path.dirname(root + '/' + alias), { recursive: true }); fs.symlinkSync(target, root + '/' + alias);
      }
      const source = { files: Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, digest(bytes)])) };
      write(stage + '/source-manifest.json', JSON.stringify(source));
      const old = { main: { root, buildDist: '.next-prod-candidate', sourceManifest: stage + '/source-manifest.json' },
        envFile: paths.environment, expectedProtectedFileSha256: { [paths.environment]: digest('original') } };
      const prepared = { buildEnv: { PATH: '/synthetic-original-tools', FIXTURE: 'isolated' } };
      write(stage + '/manifest.json', JSON.stringify(old)); write(paths.prepared, JSON.stringify(prepared));
      const context = { fs, path, Buffer, JSON, Date, process, isSharedEngine, engineDirectory,
        assert: { ...assert, deepEqual: (a, b, message) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), message) },
        rootFile: file => fs.readFileSync(file), sha: digest, execFileSync: () => paths.node };
      vm.runInNewContext(moduleBody(implementation)
        + '\nglobalThis.captureBuild=capture;globalThis.checkOriginal=verifyOriginalSuccess;', context);
      // The isolated metadata-only snapshot does not execute this synthetic tool.
      const metadataCutoff = Date.now() + 1000;
      const receipt = { startedAt: metadataCutoff, finishedAt: metadataCutoff, build: 'original-build' };
      const capsule = { originalReceipt: receipt, originalManifestSha256: digest(fs.readFileSync(stage + '/manifest.json')),
        originalSourceManifestSha256: digest(fs.readFileSync(old.main.sourceManifest)),
        originalPreparedSha256: digest(fs.readFileSync(paths.prepared)), snapshot: context.captureBuild(old, 'main', receipt, prepared) };
      context.fixtureStage = stage; context.fixtureCapsule = capsule;
      vm.runInNewContext('sourceStage=()=>globalThis.fixtureStage;readOriginalSuccess=()=>globalThis.fixtureCapsule;', context);
      context.checkOriginal({}, 'main');
      fs.appendFileSync(paths[changed], '\nchanged-after-original-build');
      assert.throws(() => context.checkOriginal({}, 'main'));
      add('actual_complete_original_snapshot_rejects_changed_' + changed);
    }
  } finally { fs.rmSync(temporary, { recursive: true }); }
}
{
  const sourceRun = '10000000-0000-4000-8000-000000000001', runId = '10000000-0000-4000-8000-000000000002';
  const root = source => '/data/video-api-debugger/managed-releases/' + source;
  const m = { runId, mainSource: 'a'.repeat(40), guardSource: 'b'.repeat(40), database: '/data/video-api-debugger/var-lib/dev.db',
    normalContinuation: Object.fromEntries(CONTINUATION_COMMON_FIELDS.map(key => [key,
      key === 'schema' ? CONTINUATION_V2 : key === 'attempt' ? 2 : key === 'sourceRun' || key === 'chainId' ? sourceRun : 'c'.repeat(64)])),
    deployedUsageSchema: Object.fromEntries(DEPLOYED_FIELDS.map(key => [key, key === 'schema' ? DEPLOYED_SCHEMA
      : key.endsWith('Sha256') ? 'd'.repeat(64) : '20000000-0000-4000-8000-000000000001'])),
    deployedCanvasBatchSchema: Object.fromEntries(DEPLOYED_CANVAS_FIELDS.map(key => [key, key === 'schema'
      ? 'sd2-deployed-canvas-video-batch-schema-input.v1' : key.endsWith('Sha256') ? 'e'.repeat(64) : '20000000-0000-4000-8000-000000000002'])),
    canvasVideoBatchSchema: { schema: 'sd2-canvas-video-batch-schema-input.v1', previousPrismaSha256: '1'.repeat(64),
      newPrismaSha256: '2'.repeat(64), sqlSha256: '3'.repeat(64), migrationModuleSha256: '4'.repeat(64) },
    live: { web: { source: 'f'.repeat(40), root: root('f'.repeat(40)) } },
    reuseBuilds: { schema: 'sd2-original-build-reuse-input.v1', sourceRun } };
  for (const kind of ['main', 'guard']) {
    m[kind] = { source: m[kind + 'Source'], root: root(m[kind + 'Source']), version: '0.102.1', buildDist: '.next-prod-candidate' };
    m.reuseBuilds[kind] = { file: '/data/video-api-debugger/release-staging/' + sourceRun + '/' + kind + '-immutable-success.json', sha256: '5'.repeat(64) };
  }
  const prior = { ...m, schema: 'rate-impl2-release.v1', project: 'video-api-debugger', runId: sourceRun,
    stage: '/data/video-api-debugger/release-staging/' + sourceRun, normalContinuation: null, reuseBuilds: null };
  const continuation = { input: m.normalContinuation, prior,
    refusal: { effectsStarted: false, originalPidAndProtectionFreshlyVerified: true } };
  const capsule = { kind: 'main', sourceRun, originalManifestSha256: m.normalContinuation.sourceManifestSha256,
    originallyVerifiedWithinThirtyMinuteGate: true, originalTimesChanged: false, newCompilationClaimed: false,
    originalReceipt: { source: m.mainSource, exitCode: 0, verifiedSourceAndGates: true } };
  const allowed = ['switch-before.json', 'fixed-guard-recovery.json', 'fixed-guard-recovery-armed.json', 'normal-switch-refusal.json', 'lineage-closed.json'];
  assertFirstRuntimeAliasProvenance(m, 'main', capsule, allowed, [], continuation);
  assert.throws(() => assertFirstRuntimeAliasProvenance(m, 'main', capsule, allowed, []));
  for (const name of ['switch-before-other.json', 'fixed-guard-recovery-start.json', 'switch-complete.json',
    'natural-stop-intent-switch-web.json', 'network-fence-installed.json', 'ingress-503-switch.json'])
    assert.throws(() => assertFirstRuntimeAliasProvenance(m, 'main', capsule, [...allowed, name], [], continuation));
  assert.throws(() => assertFirstRuntimeAliasProvenance(m, 'main', { ...capsule, originalManifestSha256: '0'.repeat(64) }, allowed, [], continuation));
  assert.throws(() => assertFirstRuntimeAliasProvenance(m, 'main', capsule, allowed, [123], continuation));
  const mixed = structuredClone(continuation); mixed.prior.guardSource = '0'.repeat(40);
  assert.throws(() => assertFirstRuntimeAliasProvenance(m, 'main', capsule, allowed, [], mixed));
  add('v2_alias_exception_requires_verified_original_refusal_exact_pair_and_only_three_exact_preparation_names');
}
{
  const current = fs.readFileSync(new URL('./package-candidates.mjs', import.meta.url), 'utf8');
  const original = current.replace("git(repo, ['merge-base', '--is-ancestor', MV_DIRECT.sourceBase, source.source]);",
    "git(repo, ['merge-base', '--is-ancestor', BASELINE_SOURCE, source.source]);");
  assertPackagingAncestryChange(original, current); add('packaging-only-ancestry-uses-existing-sourceBase');
  assertPackagingAncestryChange(current, current); add('already-reviewed-identical-packaging-is-reusable');
  assertPackagingAncestryChange(original, original); add('unchanged-original-packaging-is-reusable');
  for (const changed of [current.replace('baselineSource: BASELINE_SOURCE', 'baselineSource: MV_DIRECT.sourceBase'),
    current.replace('const BASELINE_SOURCE = MV_DIRECT.baselineSource;', 'const BASELINE_SOURCE = MV_DIRECT.sourceBase;'),
    current.replace('MV_DIRECT.approvedMainFiles', '[]')]) {
    assert.throws(() => assertPackagingAncestryChange(original, changed)); add('packaging-runtime-binding-and-exact-scope-not-weakened');
    assert.throws(() => assertPackagingAncestryChange(current, changed)); add('already-upgraded-packaging-still-rejects-drift');
  }
}
{
  const live = Object.fromEntries(Object.entries(MV_DIRECT.starts).map(([role, [pid, invocation, execMainStartTimestampMonotonic]]) =>
    [role, { pid, invocation, execMainStartTimestampMonotonic, source: MV_DIRECT.baselineSource,
      version: MV_DIRECT.baselineVersion, build: MV_DIRECT.baselineBuild }]));
  assertCapturedLive(live); add('exact-captured-current-guard-starts-accepted');
  for (const key of ['pid', 'invocation', 'execMainStartTimestampMonotonic', 'source', 'version', 'build']) {
    const changed = structuredClone(live); changed.web[key] = key === 'pid' ? 1 : 'changed';
    assert.throws(() => assertCapturedLive(changed)); add('current-guard-capture-rejects-' + key);
  }
}
{
  const releases = ['main', 'guard'].map((kind, index) => ({ root: '/data/' + kind, source: (index ? 'b' : 'a').repeat(40),
    version: '0.100.2' + (index ? '+guard.1' : ''), build: kind + '-original-build',
    sourceFiles: { file: 'unchanged' }, buildFiles: { file: 'unchanged' } }));
  const runId = 'new-run', manifestSha256 = 'f'.repeat(64), sourceRun = 'original-run';
  const reuseBuilds = { schema: 'sd2-original-build-reuse-input.v1', sourceRun,
    main: { sha256: 'c'.repeat(64) }, guard: { sha256: 'd'.repeat(64) } };
  const proofs = Object.fromEntries(['main', 'guard'].map((kind, index) => {
    const originalBuild = { label: kind, runId: sourceRun, ...releases[index], startedAt: 1000, finishedAt: 2000,
      gateReceipt: '/original/' + kind, exitCode: 0, verifiedSourceAndGates: true };
    return [kind, { ...originalBuild, schema: REUSE_SCHEMA, runId, manifestSha256, originalBuild,
      originalSuccessSha256: reuseBuilds[kind].sha256, newCompilationClaimed: false, originalTimesChanged: false,
      reuseInputsFullyVerified: true, applicationChecksAndContractsUnchanged: true, controlChangesCheckedSeparately: true,
      validatedAt: now, expiresAt: now + 1800000 }];
  }));
  const input = { previous: { releases: structuredClone(releases) }, releases, proofs, reuseBuilds, runId, manifestSha256 };
  assertPricingPairTransition(input, now); add('exact-whole-pair-with-fresh-original-input-proofs-accepted');
  for (const [name, mutate] of [
    ['mixed-pair', x => { x.releases[0].source = 'e'.repeat(40); }],
    ['build', x => { x.releases[0].build = 'changed'; }],
    ['source-files', x => { x.releases[1].sourceFiles.file = 'changed'; }],
    ['compiled-files', x => { x.releases[1].buildFiles.file = 'changed'; }],
    ['missing-reuse', x => { delete x.reuseBuilds; }],
    ['input-not-verified', x => { x.proofs.main.reuseInputsFullyVerified = false; }],
    ['original-hash', x => { x.proofs.guard.originalSuccessSha256 = '0'.repeat(64); }],
    ['original-time', x => { x.proofs.main.startedAt = 1001; }],
    ['manifest', x => { x.proofs.guard.manifestSha256 = '0'.repeat(64); }],
    ['expired', x => { x.proofs.guard.validatedAt = now - 1800001; x.proofs.guard.expiresAt = now - 1; }],
  ]) { const changed = structuredClone(input); mutate(changed); assert.throws(() => assertPricingPairTransition(changed, now)); add('whole-pair-rejects-' + name); }
  const fresh = structuredClone(input); fresh.previous.releases.forEach((entry, index) => { entry.source = (index ? '8' : '9').repeat(40); });
  delete fresh.reuseBuilds; assertPricingPairTransition(fresh, now); add('disjoint-new-pair-existing-behavior-preserved');
}
{
  const m = { main: { root: '/data/main' }, guard: { root: '/data/guard' },
    live: { web: { root: '/data/guard' }, image: { root: '/data/guard' } }, retiredPricingRoots: ['/data/retired'] };
  assert.deepEqual(rejectedPricingRoots(m), ['/data/retired']); add('valid-current-guard-not-confused-with-retired-source');
  assert.throws(() => rejectedPricingRoots({ ...m, retiredPricingRoots: ['/data/guard'] })); add('candidate-cannot-be-declared-retired');
  assert.throws(() => rejectedPricingRoots({ ...m, retiredPricingRoots: [] })); add('retired-source-proof-cannot-be-omitted');
  const original = structuredClone(m); original.live.web.root = '/data/old';
  assert.deepEqual(rejectedPricingRoots(original), ['/data/old', '/data/retired']); add('old-outside-pair-source-still-rejected');
}
const nginxCurrent = fs.readFileSync(new URL('./nginx-maintenance.mjs', import.meta.url), 'utf8');
const nginxOriginal = nginxCurrent
  .replace('2e0265cb30a8c6f27c61ae89bc28ed654b4020c504af52e5ccc0ac4ae7a2342c', '052b32cb614ee17383648c2d017bf499350144e468f7af21fcc105f50f7a6ab9')
  .replace('22e6cbe85ea4be067444377770e08f094004c3f39332b1e10b31a87bb640d611', 'c994fdfd218a9aa18552825582cceab93e3104c5aa7b8b600c8366975c5d0319');
assert.notEqual(nginxCurrent, nginxOriginal);
assertNginxMaintenancePinChange(nginxOriginal, nginxCurrent); add('exact_two_reviewed_nginx_pins_only_accepted');
for (const altered of [nginxCurrent + '\n// other change', nginxCurrent.replace('sd2.youdooart.com', 'other.invalid'),
  nginxCurrent.replace('2e0265cb30a8c6f27c61ae89bc28ed654b4020c504af52e5ccc0ac4ae7a2342c', '0'.repeat(64))]) {
  assert.throws(() => assertNginxMaintenancePinChange(nginxOriginal, altered)); add('unreviewed_nginx_code_host_or_pin_refused');
}
const m = { stage: '/new-run', runId: 'new-run', main: { source: 'a'.repeat(40), version: '0.99.4' },
  reuseBuilds: { sourceRun: 'original-run', main: { sha256: 'b'.repeat(64) } } };
const original = { schema: 'rate-impl2-candidate-build.v1', runId: 'original-run', source: m.main.source, version: m.main.version,
  label: 'main', build: 'real-original-build', startedAt: 1000, finishedAt: 2000, gateReceipt: '/original/receipt.json', exitCode: 0, verifiedSourceAndGates: true };
const value = { ...original, schema: REUSE_SCHEMA, runId: m.runId, originalBuild: original, originalSuccessSha256: m.reuseBuilds.main.sha256,
  newCompilationClaimed: false, originalTimesChanged: false, reuseInputsFullyVerified: true, validatedAt: now, expiresAt: now + 1800000 };
assert.equal(assertFreshCandidateEvidence(value, m, 'main', now), value);
assert.equal(value.startedAt, 1000); assert.equal(value.finishedAt, 2000); add('old-original-success-with-fresh-independent-reuse-admission');
assert.equal(candidateEvidenceFile(m, 'main'), '/new-run/main-candidate-reuse.json'); add('original-build-file-is-not-renamed-as-new-build');
assert.throws(() => assertFreshCandidateEvidence(original, { ...m, runId: original.runId, reuseBuilds: undefined }, 'main', now)); add('old-original-alone-still-fails-thirty-minute-gate');
assert.throws(() => assertFreshCandidateEvidence(value, m, 'main', now + 1800000)); add('expired-reuse-cannot-publish');
for (const [name, change] of [
  ['changed-source', { source: 'c'.repeat(40) }], ['new-build-claim', { newCompilationClaimed: true }],
  ['relabeled-original-time', { startedAt: now }], ['changed-original-reference', { originalSuccessSha256: 'c'.repeat(64) }],
  ['future-check', { validatedAt: now + 1 }], ['extended-age-gate', { expiresAt: now + 1800001 }],
  ['checks-not-verified', { reuseInputsFullyVerified: false }], ['wrong-run', { runId: 'other' }],
]) { assert.throws(() => assertFreshCandidateEvidence({ ...value, ...change }, m, 'main', now)); add('reject-' + name); }
assertControlOnlyChange({ 'switch.mjs': 'old', 'writer-network-fence.mjs': 'same' },
  { 'switch.mjs': 'new', 'writer-network-fence.mjs': 'same', 'candidate-evidence.mjs': 'new' }); add('reviewed-control-only-change-can-use-independent-control-checks');
assertControlOnlyChange({ 'writer-network-fence.mjs': 'old', 'normal-continuation.mjs': 'old', 'normal-continuation-engineering.mjs': 'old',
  'deployed-usage-schema.mjs': 'old', 'deployed-usage-schema-engineering.mjs': 'old', 'canvas-batch-schema.mjs': 'old', 'canvas-batch-schema-engineering.mjs': 'old' },
{ 'writer-network-fence.mjs': 'new', 'normal-continuation.mjs': 'new', 'normal-continuation-engineering.mjs': 'new',
  'deployed-usage-schema.mjs': 'new', 'deployed-usage-schema-engineering.mjs': 'new', 'canvas-batch-schema.mjs': 'new', 'canvas-batch-schema-engineering.mjs': 'new' });
add('reviewed_v2_continuation_schema_readers_and_parent_writer_fence_are_control_only_not_build_inputs');
for (const changed of [{ 'canvas-batch-schema-contract.mjs': 'changed' }, {}, { 'canvas-batch-schema-contract.mjs': 'same', 'unknown.mjs': 'new' }]) {
  assert.throws(() => assertControlOnlyChange({ 'canvas-batch-schema-contract.mjs': 'same' }, changed)); add('unknown-or-changed-required-contract-refused');
}
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-reuse-engineering-')));
const file = directory + '/input', link = directory + '/alias'; fs.writeFileSync(file, 'original'); fs.symlinkSync('input', link);
const expected = inspectReuseTreeForEngineering(directory);
assert.deepEqual(inspectReuseTreeForEngineering(directory), expected); add('actual-unchanged-files-reused-with-no-compilation');
fs.writeFileSync(file, 'modified'); assert.notDeepEqual(inspectReuseTreeForEngineering(directory), expected); add('actual-source-dependency-artifact-byte-change-invalidates');
fs.chmodSync(file, 0o666); assert.notDeepEqual(inspectReuseTreeForEngineering(directory), expected); add('actual-permission-change-invalidates');
fs.writeFileSync(directory + '/unknown', 'x'); assert.notDeepEqual(inspectReuseTreeForEngineering(directory), expected); add('actual-additional-input-invalidates');
assert.throws(() => inspectReuseTreeForEngineering(directory, { latest: 1 })); add('post-build-dependency-metadata-invalidates');
fs.symlinkSync('/etc/hosts', directory + '/escape'); assert.throws(() => inspectReuseTreeForEngineering(directory)); add('dependency-alias-escape-refused');
{
  const f = createRecoverySafetyFixture({ reuse: true });
  await f.safety().beforeMaintenance(f.context);
  assert.equal(f.context.builds.main.startedAt, f.adapter.now() - 7200000);
  assert.equal(f.state.calls.install, 0); add('actual-adapter-allows-old-build-with-fresh-reuse-not-new-compilation');
}
{
  const f = createRecoverySafetyFixture({ reuse: true });
  const proof = f.context.builds.main; proof.validatedAt = f.adapter.now() - 1800001; proof.expiresAt = f.adapter.now() - 1;
  f.put(candidateEvidenceFile(f.m, 'main'), proof);
  f.approval.mainBuildReceiptSha256 = createHash('sha256').update(f.bytes(candidateEvidenceFile(f.m, 'main'))).digest('hex');
  f.put(f.m.stage + '/hd-release-safety-approval.json', f.approval);
  await assert.rejects(() => f.safety().beforeMaintenance(f.context), /reuse admission expired/);
  assert.equal(f.state.calls.install, 0); add('actual-adapter-rejects-expired-reuse-with-still-fresh-release-approval');
}
let immutableOriginal = null;
if (process.argv.length > 2) {
  assert.equal(process.argv.length, 4); assert.equal(process.argv[2], '--immutable-original-manifest');
  const manifestFile = process.argv[3]; assert.ok(path.isAbsolute(manifestFile));
  const bytes = rootFile(manifestFile), prior = JSON.parse(bytes);
  assert.equal(manifestFile, prior.projectRoot + '/release-staging/' + prior.runId + '/manifest.json');
  assert.equal(prior.reuseBuilds, undefined, 'Acceptance must use a direct original full-build leaf');
  const engine = currentReleaseContext()?.contract?.engine;
  assert.equal(engine?.schema, 'sd2-release-engine.v1', 'Real artifact acceptance requires the verified native shared entry');
  const attemptId = randomUUID(), taskId = randomUUID(), observedAt = Date.now(), capsules = {};
  const fresh = { ...structuredClone(prior), runId: attemptId, stage: prior.projectRoot + '/release-staging/' + attemptId,
    engine, privateSha256: Object.fromEntries(fs.readdirSync(new URL('.', import.meta.url)).filter(file => file.endsWith('.mjs')).sort()
      .map(file => [file, createHash('sha256').update(fs.readFileSync(new URL(file, import.meta.url))).digest('hex')])),
    operation: { schema: 'sd2-release-operation.v1', taskId, attemptId, taskRoot: prior.projectRoot + '/release-tasks/' + taskId },
    reuseBuilds: { schema: 'sd2-original-build-reuse-input.v1', sourceRun: prior.runId } };
  const hash = value => createHash('sha256').update(value).digest('hex');
  for (const kind of ['main', 'guard']) {
    const capsule = verifyOriginalSuccess(prior, kind), original = capsule.originalReceipt;
    const file = prior.stage + '/' + kind + '-immutable-success.json', originalSha256 = hash(rootFile(file, 128 * 1024 * 1024));
    assert.ok(observedAt - original.startedAt >= 1800000, 'Use the real expired original artifact, not a synthetic old date');
    fresh.reuseBuilds[kind] = { file, sha256: originalSha256 };
    const admission = { ...structuredClone(original), schema: REUSE_SCHEMA, runId: attemptId,
      engine, operation: fresh.operation, originalBuild: original, originalSuccessSha256: originalSha256,
      validatedAt: Date.now(), originalTimesChanged: false, newCompilationClaimed: false,
      reuseInputsFullyVerified: true, engineeringAdmissionOnly: true };
    admission.expiresAt = admission.validatedAt + 1800000;
    assertFreshCandidateEvidence(admission, fresh, kind);
    assert.throws(() => assertFreshCandidateEvidence(original, { ...prior, reuseBuilds: undefined }, kind));
    assert.throws(() => assertFreshCandidateEvidence(admission, fresh, kind, admission.expiresAt));
    for (const key of ['source', 'build', 'version', 'startedAt', 'finishedAt']) assert.equal(admission[key], original[key]);
    assert.equal(hash(rootFile(file, 128 * 1024 * 1024)), originalSha256);
    capsules[kind] = { file, sha256: originalSha256, source: original.source, version: original.version,
      build: original.build, startedAt: original.startedAt, finishedAt: original.finishedAt,
      compiledTreeSha256: original.compiledTreeSha256, validatedAt: admission.validatedAt,
      expiresAt: admission.expiresAt, originalSnapshotFullyRehashed: true };
  }
  immutableOriginal = { manifestFile, manifestSha256: hash(bytes), originalRunId: prior.runId, capsules,
    engineeringAdmissionOnly: true, productionAttemptCreated: false, productionPreparationClaimed: false,
    originalTimesChanged: false, applicationWrites: 0, completeBuildsExecuted: 0 };
  add('A_E_actual_expired_original_pair_full_snapshot_verified_and_fresh_validator_accepts_without_rebuild_or_relabel');
}
const sourceSha256 = Object.fromEntries(['candidate-evidence.mjs', 'candidate-reuse.mjs', 'candidate.mjs', 'switch.mjs',
  'cutover-driver.mjs', 'cutover-safety.mjs', 'guard-recovery.mjs', 'retired-hd-cache.mjs',
  'normal-continuation.mjs', 'recovered-guard-baseline.mjs', 'deployed-usage-schema.mjs', 'engine-context.mjs', 'engine-version.mjs'].map(file => [file,
  createHash('sha256').update(fs.readFileSync(new URL(file, import.meta.url))).digest('hex')]));
console.log(JSON.stringify({ schema: 'sd2-candidate-reuse-engineering.v1', completed: true, checks, count: checks.length,
  sourceSha256, directory, immutableOriginal, completeBuildExecuted: false, productionWrites: 0, serviceCalls: 0, browserRuns: 0 }));
