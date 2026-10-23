import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { rootFile, sha, writeJsonExclusive, isSharedEngine, engineDirectory } from './common.mjs';
import { candidateEvidenceFile, assertFreshCandidateEvidence, REUSE_SCHEMA } from './candidate-evidence.mjs';
import { probeHdCandidateResolver } from './hd-storage-preflight.mjs';
import { CONTINUATION_V2, SHARED_BUILD_PROVENANCE, assertContinuationInput, assertDeployedContinuationSources,
  verifyDeployedContinuationProvenance, assertSharedBuildSources, verifySharedBuildProvenance } from './normal-continuation.mjs';

function sourceStage(m) {
  const run = m.reuseBuilds?.sourceRun || m.runId;
  assert.match(run, /^[a-f0-9-]{36}$/);
  return '/data/video-api-debugger/release-staging/' + run;
}
const originalFile = (m, kind) => sourceStage(m) + '/' + kind + '-immutable-success.json';
const json = file => JSON.parse(rootFile(file, 128 * 1024 * 1024));
function entry(file, hash = true) {
  const s = fs.lstatSync(file);
  assert.ok(s.isFile() || s.isDirectory() || s.isSymbolicLink());
  const value = Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, s[key]]));
  if (s.isSymbolicLink()) value.link = fs.readlinkSync(file);
  else if (s.isFile() && hash) value.sha256 = sha(fs.readFileSync(file));
  return value;
}
function tree(root, { hash = true, latest = null, aliasBoundary = root } = {}) {
  const records = {}; let count = 0;
  const visit = file => {
    assert.ok(++count <= 120000); const value = entry(file, hash);
    if (latest !== null) assert.ok(value.ctimeMs <= latest, 'Dependency metadata changed after the original build began: ' + file);
    if (value.link) assert.ok(fs.realpathSync(file).startsWith(aliasBoundary + '/'), 'Alias escapes its verified input boundary');
    records[path.relative(root, file) || '.'] = value;
    if (fs.lstatSync(file).isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
  };
  visit(root); return records;
}
function buildFiles(root) {
  const output = {};
  for (const name of ['server', 'static', ...fs.readdirSync(root).filter(name => name === 'BUILD_ID' || name.endsWith('.json')).sort()]) {
    const file = path.join(root, name), s = fs.lstatSync(file);
    if (s.isDirectory()) for (const [relative, value] of Object.entries(tree(file))) output[name + (relative === '.' ? '' : '/' + relative)] = value;
    else output[name] = entry(file);
  }
  return output;
}
function exactSourceList(root, expected) {
  const runtime = new Set(['.env', '.deployed-commit', '.next-prod', '.next-prod-candidate', 'node_modules', 'storage',
    '.role-tests', '.release-tmp', '.candidate-fixtures', 'public/uploads', 'public/videos']);
  const actual = [];
  const visit = relative => {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const file = relative ? relative + '/' + name : name; if (runtime.has(file)) continue;
      const s = fs.lstatSync(path.join(root, file)); assert.equal(s.isSymbolicLink(), false);
      if (s.isDirectory()) visit(file); else { assert.ok(s.isFile()); actual.push(file); }
    }
  };
  visit(''); assert.deepEqual(actual.sort(), [...expected].sort(), 'Actual application source set changed');
}
function capture(m, kind, receipt, prepared) {
  const c = m[kind], source = json(c.sourceManifest);
  exactSourceList(c.root, Object.keys(source.files));
  const sourceFiles = Object.fromEntries(Object.keys(source.files).sort().map(file => {
    const value = entry(c.root + '/' + file); assert.equal(value.sha256, source.files[file]); return [file, value];
  }));
  const env = entry(m.envFile); assert.equal(env.sha256, m.expectedProtectedFileSha256[m.envFile]);
  const node = execFileSync('node', ['-p', 'process.execPath'], { env: prepared.buildEnv, encoding: 'utf8' }).trim();
  assert.equal(fs.realpathSync(node), node); const nodeBinary = entry(node);
  assert.ok(nodeBinary.ctimeMs <= receipt.startedAt, 'Node installation changed since the original build');
  return { sourceFiles, lock: sourceFiles['package-lock.json'], dependencies: tree(c.root + '/node_modules', { latest: receipt.startedAt }),
    build: buildFiles(c.root + '/' + c.buildDist), checks: tree(c.root + '/.role-tests', { aliasBoundary: c.root }),
    buildEnvironment: prepared.buildEnv, node: { path: node, ...nodeBinary }, env,
    bindings: Object.fromEntries(['.env', 'storage', 'public/uploads', 'public/videos'].map(file => [file, entry(c.root + '/' + file)])) };
}
export async function sealOriginalSuccess(m, kind) {
  assert.ok(['main', 'guard'].includes(kind)); assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  assert.equal(m.reuseBuilds, undefined, 'Only a new full build can create original success evidence');
  const originalStage = sourceStage(m);
  assert.deepEqual(json(originalStage + '/manifest.json'), m);
  for (const [file, digest] of Object.entries(m.privateSha256)) assert.equal(sha(rootFile(engineDirectory(m) + '/' + file)), digest);
  const { verifyCandidate } = await import(pathToFileURL(engineDirectory(m) + '/candidate.mjs').href);
  const receipt = await verifyCandidate(m, kind), prepared = json(originalStage + '/' + kind + '-prepared.json');
  assert.ok(Date.now() - receipt.startedAt < 1800000);
  const value = { schema: 'sd2-immutable-successful-build.v1', kind, sourceRun: m.runId,
    sealedAt: new Date().toISOString(), originallyVerifiedWithinThirtyMinuteGate: true,
    originalReceiptFile: originalStage + '/' + kind + '-build.json', originalReceiptSha256: sha(rootFile(originalStage + '/' + kind + '-build.json')),
    originalReceipt: receipt, originalManifestSha256: sha(rootFile(originalStage + '/manifest.json')),
    originalSourceManifestSha256: sha(rootFile(m[kind].sourceManifest)), originalPreparedSha256: sha(rootFile(originalStage + '/' + kind + '-prepared.json')),
    originalPrivateSha256: m.privateSha256, snapshot: capture(m, kind, receipt, prepared),
    compatibility: 'Exact original application/source/lock/dependency/environment/compiled/check inputs; later runtime data and permission compatibility remain separate fresh release gates',
    originalTimesChanged: false, newCompilationClaimed: false };
  assert.deepEqual(await verifyCandidate(m, kind), receipt);
  writeJsonExclusive(originalFile(m, kind), value); execFileSync('chattr', ['+i', originalFile(m, kind)]);
  return { kind, file: originalFile(m, kind), sha256: sha(rootFile(originalFile(m, kind), 128 * 1024 * 1024)),
    sourceRun: m.runId, source: receipt.source, build: receipt.build, startedAt: receipt.startedAt, finishedAt: receipt.finishedAt };
}
export function readOriginalSuccess(m, kind) {
  if (m.normalContinuation) assertContinuationInput(m.normalContinuation);
  const originalStage = sourceStage(m), file = originalFile(m, kind), value = json(file);
  assert.equal(value.schema, 'sd2-immutable-successful-build.v1'); assert.equal(value.kind, kind);
  assert.equal(value.sourceRun, m.reuseBuilds?.sourceRun || m.runId);
  assert.equal(value.originalReceiptFile, originalStage + '/' + kind + '-build.json');
  assert.ok(execFileSync('lsattr', ['-d', '--', file], { encoding: 'utf8' }).split(/\s+/)[0].includes('i'));
  assert.equal(value.originallyVerifiedWithinThirtyMinuteGate, true); assert.equal(value.originalTimesChanged, false);
  assert.equal(value.newCompilationClaimed, false);
  if (m.reuseBuilds) {
    assert.equal(m.reuseBuilds[kind].file, file);
    assert.equal(sha(rootFile(file, 128 * 1024 * 1024)), m.reuseBuilds[kind].sha256);
  }
  const originalManifestBytes = rootFile(originalStage + '/manifest.json'), originalManifest = JSON.parse(originalManifestBytes);
  assert.equal(sha(originalManifestBytes), value.originalManifestSha256);
  if (isSharedEngine(m) && m.reuseBuilds) assertSharedBuildSources(m, originalManifest);
  if (m.normalContinuation?.schema === CONTINUATION_V2) {
    assertDeployedContinuationSources(m, json(originalStage + '/manifest.json'));
    assert.equal(value.originalManifestSha256, m.normalContinuation.sourceManifestSha256);
  }
  assert.equal(sha(rootFile(value.originalReceiptFile)), value.originalReceiptSha256);
  assert.deepEqual(value.originalPrivateSha256, originalManifest.privateSha256);
  for (const [file, digest] of Object.entries(value.originalPrivateSha256))
    assert.equal(sha(rootFile(engineDirectory(originalManifest) + '/' + file)), digest);
  assert.deepEqual(json(value.originalReceiptFile), value.originalReceipt); return value;
}
export function verifyOriginalSuccess(m, kind) {
  const originalStage = sourceStage(m), value = readOriginalSuccess(m, kind), old = json(originalStage + '/manifest.json');
  assert.equal(sha(rootFile(originalStage + '/manifest.json')), value.originalManifestSha256);
  assert.equal(sha(rootFile(old[kind].sourceManifest)), value.originalSourceManifestSha256);
  assert.equal(sha(rootFile(originalStage + '/' + kind + '-prepared.json')), value.originalPreparedSha256);
  assert.deepEqual(capture(old, kind, value.originalReceipt, json(originalStage + '/' + kind + '-prepared.json')), value.snapshot,
    'Original application, dependencies, environment, artifact or required check evidence changed; reuse is refused');
  assert.deepEqual(readOriginalSuccess(m, kind), value, 'Original full-build evidence changed during verification');
  return value;
}

export function assertOriginalSnapshotStable(m, kind) {
  const value = readOriginalSuccess(m, kind), old = json(sourceStage(m) + '/manifest.json'), root = old[kind].root;
  const withoutHash = record => Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'sha256'));
  exactSourceList(root, Object.keys(value.snapshot.sourceFiles));
  for (const [file, expected] of Object.entries(value.snapshot.sourceFiles))
    assert.deepEqual(entry(root + '/' + file, false), withoutHash(expected));
  for (const [directory, expected] of [[root + '/node_modules', value.snapshot.dependencies], [root + '/.role-tests', value.snapshot.checks]]) {
    const current = tree(directory, { hash: false, aliasBoundary: root });
    assert.deepEqual(current, Object.fromEntries(Object.entries(expected).map(([file, record]) => [file, withoutHash(record)])));
  }
  assert.deepEqual(entry(old.envFile), value.snapshot.env);
  const { path: node, ...expectedNode } = value.snapshot.node; assert.deepEqual(entry(node), expectedNode);
  for (const [file, expected] of Object.entries(value.snapshot.bindings)) assert.deepEqual(entry(root + '/' + file), expected);
  return value;
}
const CONTROL_ONLY = new Set(['release-contract.mjs', 'common.mjs', 'candidate.mjs', 'cutover-driver.mjs', 'cutover-safety.mjs',
  'usage-role-control.mjs', 'preflight-resume-engineering.mjs',
  'guard-recovery.mjs', 'switch.mjs', 'pricing-start-pair.mjs', 'release.mjs', 'retired-hd-cache.mjs', 'retired-hd-cache-engineering.mjs',
  'cutover-safety-engineering.mjs', 'candidate-reuse.mjs', 'candidate-reuse-engineering.mjs', 'nginx-maintenance.mjs',
  'raw-upload-recovery-proof.mjs', 'certificate-engineering.mjs', 'package-candidates.mjs', 'control-preflight.mjs',
  'normal-continuation.mjs', 'normal-continuation-engineering.mjs', 'deployed-usage-schema.mjs',
  'deployed-usage-schema-engineering.mjs', 'canvas-batch-schema.mjs', 'canvas-batch-schema-engineering.mjs',
  'candidate-lifecycle-engineering.mjs', 'writer-network-fence.mjs']);
const NEW_CONTROL = new Set(['candidate-evidence.mjs', 'candidate-reuse.mjs', 'candidate-reuse-engineering.mjs', 'control-preflight.mjs',
  'normal-continuation.mjs', 'normal-continuation-engineering.mjs', 'candidate-lifecycle-engineering.mjs']);
export function assertControlOnlyChange(original, current) {
  for (const [file, digest] of Object.entries(original)) {
    assert.ok(Object.hasOwn(current, file), 'A required original control module was removed');
    if (current[file] !== digest) assert.ok(CONTROL_ONLY.has(file), 'Unreviewed control/build input change: ' + file);
  }
  for (const file of Object.keys(current)) if (!Object.hasOwn(original, file)) assert.ok(NEW_CONTROL.has(file));
}
export function assertSharedEngineControl(m, control) {
  const directory = engineDirectory(m); assert.equal(isSharedEngine(m), true);
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.mjs')).sort(), Object.keys(m.privateSha256).sort());
  for (const [file, digest] of Object.entries(m.privateSha256)) {
    assert.equal(path.basename(file), file); assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(sha(rootFile(directory + '/' + file)), digest, 'Current engine controller bytes changed: ' + file);
  }
  assert.equal(control.schema, 'mv-hd-upload-native-control-preflight.v1');
  assert.equal(control.completed, true); assert.equal(control.runId, m.runId);
  assert.equal(control.manifestSha256, sha(rootFile(m.stage + '/manifest.json')));
  assert.deepEqual(control.privateSha256, m.privateSha256);
  assert.equal(control.servicesChanged, false); assert.equal(control.productionWrites, 0);
  assert.equal(control.nativeBeforeMaintenance?.completed, true);
  assert.equal(control.nativeBeforeMaintenance?.releaseApproved, false);
  return control;
}
export function assertNginxMaintenancePinChange(original, current) {
  if (original === current) return;
  let expected = original;
  for (const [before, after] of [
    ['052b32cb614ee17383648c2d017bf499350144e468f7af21fcc105f50f7a6ab9', '2e0265cb30a8c6f27c61ae89bc28ed654b4020c504af52e5ccc0ac4ae7a2342c'],
    ['c994fdfd218a9aa18552825582cceab93e3104c5aa7b8b600c8366975c5d0319', '22e6cbe85ea4be067444377770e08f094004c3f39332b1e10b31a87bb640d611'],
  ]) {
    assert.equal(expected.split(before).length, 2, 'Original maintenance pin is not the reviewed configuration');
    expected = expected.replace(before, after);
  }
  assert.equal(current, expected, 'Only the two reviewed project log-configuration pins may change in nginx maintenance');
}
function verifyNginxControlChange(m) {
  assertNginxMaintenancePinChange(rootFile(sourceStage(m) + '/fix01-release/nginx-maintenance.mjs').toString('utf8'),
    rootFile(m.stage + '/fix01-release/nginx-maintenance.mjs').toString('utf8'));
  assertPackagingAncestryChange(rootFile(sourceStage(m) + '/fix01-release/package-candidates.mjs').toString('utf8'),
    rootFile(m.stage + '/fix01-release/package-candidates.mjs').toString('utf8'));
}
export function assertFirstRuntimeAliasProvenance(m, kind, capsule, originalFiles, activePids, continuation = null) {
  if (m.normalContinuation) assertContinuationInput(m.normalContinuation);
  assert.ok(m.reuseBuilds); assert.equal(capsule.kind, kind); assert.equal(capsule.sourceRun, m.reuseBuilds.sourceRun);
  assert.equal(capsule.originalReceipt.source, m[kind].source); assert.equal(capsule.originalReceipt.exitCode, 0);
  assert.equal(capsule.originalReceipt.verifiedSourceAndGates, true);
  assert.equal(capsule.originallyVerifiedWithinThirtyMinuteGate, true);
  assert.equal(capsule.originalTimesChanged, false); assert.equal(capsule.newCompilationClaimed, false);
  let files = originalFiles;
  if (isSharedEngine(m)) {
    engineDirectory(m); assert.ok(continuation);
    assert.equal(continuation.schema, SHARED_BUILD_PROVENANCE);
    assertSharedBuildSources(m, continuation.prior); assert.deepEqual(continuation.input, m.reuseBuilds);
    assert.equal(continuation.originalManifestSha256, capsule.originalManifestSha256);
    for (const key of ['noEffects', 'originalControllerStopped', 'candidateProcessesStopped', 'originalEvidencePreserved'])
      assert.equal(continuation[key], true);
    assert.equal(continuation.originalBuilds[kind].sha256, m.reuseBuilds[kind].sha256);
    assert.deepEqual(activePids, []);
    assert.ok(!Object.values(m.live).some(value => value.root === m[kind].root || value.source === m[kind].source));
    return;
  }
  if (m.reuseBuilds.sourceRun === 'e6044ae3-4f29-4dfd-8f12-93a94cdfa9ff') {
    assert.equal(continuation?.schema, 'sd2-exact-unpublished-pair-admission.v1');
    assert.equal(continuation.originalManifestSha256, capsule.originalManifestSha256);
    assert.equal(continuation.originalBuilds[kind].sha256, m.reuseBuilds[kind].sha256);
  }
  if (m.normalContinuation?.schema === CONTINUATION_V2) {
    assert.ok(continuation, 'Original no-effects refusal must be verified at the actual alias call site');
    assertDeployedContinuationSources(m, continuation.prior);
    assert.deepEqual(continuation.input, m.normalContinuation);
    assert.equal(continuation.refusal.effectsStarted, false); assert.equal(continuation.refusal.originalPidAndProtectionFreshlyVerified, true);
    assert.equal(capsule.originalManifestSha256, m.normalContinuation.sourceManifestSha256);
    files = originalFiles.filter(name => !['switch-before.json', 'fixed-guard-recovery.json', 'fixed-guard-recovery-armed.json'].includes(name));
  }
  assert.ok(!files.some(name => /^(switch-before|switch-complete|fixed-guard-recovery|natural-stop|usage-role-transition|ingress-|network-fence|pricing-pair|actual-prestart|guard-recovery)/.test(name)),
    'Only a never-published original full-build run may prepare its first runtime alias');
  assert.ok(!Object.values(m.live).some(value => value.root === m[kind].root || value.source === m[kind].source));
  assert.deepEqual(activePids, [], 'A candidate process is already running');
}
function sharedAliasFile(m, kind, createDirectory = false) {
  engineDirectory(m); assert.equal(isSharedEngine(m), true); assert.ok(['main', 'guard'].includes(kind));
  assert.match(m[kind].source, /^[a-f0-9]{40}$/);
  for (const directory of [m.operation.taskRoot, m.operation.taskRoot + '/artifact-aliases']) {
    if (createDirectory && directory.endsWith('/artifact-aliases') && !fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
    if (!fs.existsSync(directory)) throw Object.assign(new Error('Original artifact alias evidence directory is missing: ' + directory), { code: 'evidence_missing' });
    assert.equal(fs.realpathSync(directory), directory);
    const stat = fs.lstatSync(directory); assert.ok(stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o7777) === 0o700);
  }
  return m.operation.taskRoot + '/artifact-aliases/' + kind + '-' + m[kind].source + '.json';
}
export function readSharedRuntimeAliasBinding(m, kind, capsule) {
  const file = sharedAliasFile(m, kind);
  if (!fs.existsSync(file)) throw Object.assign(new Error('Existing runtime alias has no original task evidence: ' + file), { code: 'evidence_missing' });
  const bytes = rootFile(file, 65536), value = JSON.parse(bytes); assert.equal(fs.lstatSync(file).mode & 0o7777, 0o600);
  assert.equal(value.schema, 'sd2-artifact-runtime-alias.v1'); assert.equal(value.taskId, m.operation.taskId);
  assert.equal(value.kind, kind); assert.equal(value.source, m[kind].source);
  assert.deepEqual(value.originalSuccess, { file: m.reuseBuilds[kind].file, sha256: m.reuseBuilds[kind].sha256, sourceRun: capsule.sourceRun });
  assert.match(value.createdAttemptId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  const createdFile = m.projectRoot + '/release-staging/' + value.createdAttemptId + '/manifest.json';
  const createdBytes = rootFile(createdFile), created = JSON.parse(createdBytes);
  assert.equal(sha(createdBytes), value.createdManifestSha256); engineDirectory(created);
  assert.equal(created.projectRoot, m.projectRoot);
  assert.deepEqual(value.engine, created.engine); assert.equal(created.operation.taskId, m.operation.taskId);
  assert.equal(created.operation.attemptId, value.createdAttemptId); assert.equal(created[kind].source, m[kind].source);
  assert.equal(created[kind].root, m[kind].root); assert.deepEqual(created.reuseBuilds[kind], m.reuseBuilds[kind]);
  assert.ok(Number.isFinite(Date.parse(value.createdAt)) && Date.parse(value.createdAt) <= Date.now());
  const alias = m[kind].root + '/.next-prod'; assert.equal(value.alias.file, alias); assert.equal(value.alias.target, m[kind].buildDist);
  assert.deepEqual(entry(alias), value.alias.identity, 'Original runtime alias identity changed, even if its target is unchanged');
  assert.equal(fs.realpathSync(alias), m[kind].root + '/' + m[kind].buildDist);
  return { file, sha256: sha(bytes) };
}
export function prepareFirstRuntimeAlias(m, kind, capsule) {
  assert.equal(process.getuid(), 0);
  const c = m[kind], link = c.root + '/.next-prod'; let existing;
  try { existing = fs.lstatSync(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const original = json(sourceStage(m) + '/manifest.json'); assert.equal(original[kind].root, c.root);
  const activePids = [];
  for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try { if (fs.realpathSync('/proc/' + pid + '/cwd') === c.root) activePids.push(Number(pid)); }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  const continuation = isSharedEngine(m) ? verifySharedBuildProvenance(m, null, { requireCandidatesStopped: true }) : m.normalContinuation?.schema === CONTINUATION_V2
    || m.reuseBuilds.sourceRun === 'e6044ae3-4f29-4dfd-8f12-93a94cdfa9ff' ? verifyDeployedContinuationProvenance(m) : null;
  assertFirstRuntimeAliasProvenance(m, kind, capsule, fs.readdirSync(sourceStage(m)), activePids, continuation);
  const shared = isSharedEngine(m);
  if (existing && shared) readSharedRuntimeAliasBinding(m, kind, capsule);
  if (!existing) {
    const bindingFile = shared ? sharedAliasFile(m, kind, true) : null;
    if (bindingFile) assert.equal(fs.existsSync(bindingFile), false, 'Original runtime alias is missing; never recreate it under an existing identity proof');
    assert.equal(fs.realpathSync(c.root + '/' + c.buildDist), c.root + '/' + c.buildDist);
    fs.symlinkSync(c.buildDist, link);
    let runtimeAliasBinding;
    if (shared) {
      writeJsonExclusive(bindingFile, { schema: 'sd2-artifact-runtime-alias.v1', taskId: m.operation.taskId,
        engine: structuredClone(m.engine), kind, source: c.source,
        originalSuccess: { file: m.reuseBuilds[kind].file, sha256: m.reuseBuilds[kind].sha256, sourceRun: capsule.sourceRun },
        alias: { file: link, target: c.buildDist, identity: entry(link) }, createdAttemptId: m.runId,
        createdAt: new Date().toISOString(), createdManifestSha256: sha(rootFile(m.stage + '/manifest.json')) });
      runtimeAliasBinding = readSharedRuntimeAliasBinding(m, kind, capsule);
    }
    const record = { schema: 'sd2-first-runtime-alias.v1', runId: m.runId, kind, source: c.source,
      originalBuildRun: capsule.sourceRun, originalBuildStartedAt: capsule.originalReceipt.startedAt,
      originalBuildTimesChanged: false, firstPreparation: true, oldRuntimeChanged: false, at: new Date().toISOString(),
      ...(shared ? { runtimeAliasBinding } : {}) };
    writeJsonExclusive(m.stage + '/first-runtime-alias-' + kind + '.json', record);
  }
  const value = fs.lstatSync(link);
  assert.ok(value.isSymbolicLink() && value.uid === 0);
  assert.equal(fs.readlinkSync(link), c.buildDist); assert.equal(fs.realpathSync(link), c.root + '/' + c.buildDist);
  return entry(link);
}
export function assertRuntimeAliasUnchanged(m, kind, expected) {
  const c = m[kind], link = c.root + '/.next-prod', actual = entry(link);
  assert.equal(actual.uid, 0); assert.equal(actual.link, c.buildDist);
  assert.equal(fs.realpathSync(link), c.root + '/' + c.buildDist);
  assert.deepEqual(actual, expected, 'Prepared runtime alias identity or metadata changed');
  return actual;
}
export function assertPackagingAncestryChange(original, current) {
  if (original === current) return;
  const before = "git(repo, ['merge-base', '--is-ancestor', BASELINE_SOURCE, source.source]);";
  assert.equal(original.split(before).length, 2);
  assert.equal(current, original.replace(before,
    "git(repo, ['merge-base', '--is-ancestor', MV_DIRECT.sourceBase, source.source]);"),
  'Only packaging ancestry may use the existing sourceBase; archive/runtime bindings remain unchanged');
}
export async function prepareReusedCandidate(m, kind) {
  assert.equal(process.getuid(), 0); assert.ok(m.reuseBuilds);
  const shared = isSharedEngine(m);
  const provenance = shared ? verifySharedBuildProvenance(m, null, { requireCandidatesStopped: true }) : null;
  if (!shared && (m.normalContinuation?.schema === CONTINUATION_V2 || m.deployedUsageSchema || m.deployedCanvasBatchSchema)) verifyDeployedContinuationProvenance(m);
  assert.notEqual(m.reuseBuilds.sourceRun, m.runId);
  const originalStage = sourceStage(m), capsule = verifyOriginalSuccess(m, kind), original = capsule.originalReceipt;
  assert.equal(m.reuseBuilds[kind].file, originalFile(m, kind)); assert.equal(m.reuseBuilds[kind].sha256, sha(rootFile(originalFile(m, kind), 128 * 1024 * 1024)));
  assert.equal(m[kind].source, original.source); assert.equal(m[kind].version, original.version);
  const source = json(m[kind].sourceManifest), old = json(originalStage + '/manifest.json');
  assert.equal(sha(rootFile(m[kind].sourceManifest)), capsule.originalSourceManifestSha256,
    'Reuse must retain the original source manifest bytes, including its original packaging time');
  assert.deepEqual(source.files, json(old[kind].sourceManifest).files);
  assert.deepEqual(source.fileDetails, json(old[kind].sourceManifest).fileDetails);
  assert.equal(m[kind].root, old[kind].root); assert.equal(m.envFile, old.envFile);
  if (shared) {
    for (const other of ['main', 'guard']) if (other !== kind) verifyOriginalSuccess(m, other);
  } else {
    assertControlOnlyChange(capsule.originalPrivateSha256, m.privateSha256);
    verifyNginxControlChange(m);
  }
  const control = json(m.stage + '/native-control-preflight/receipt.json'); assert.equal(control.completed, true);
  assert.equal(control.runId, m.runId); assert.deepEqual(control.privateSha256, m.privateSha256);
  assert.equal(control.activeOriginalHdRefusedAsDrained, true);
  assert.equal(control.nativeBeforeMaintenance?.completed, true);
  if (shared) assertSharedEngineControl(m, control);
  const runtimeAlias = prepareFirstRuntimeAlias(m, kind, capsule);
  const currentReadOnlyCandidateProbe = await probeHdCandidateResolver(old, old[kind], json(originalStage + '/' + kind + '-prepared.json'), { phase: 'prebuild' });
  assertOriginalSnapshotStable(m, kind);
  const validatedAt = Date.now(), value = { schema: REUSE_SCHEMA, label: kind, runId: m.runId,
    manifestSha256: sha(rootFile(m.stage + '/manifest.json')), source: original.source, version: original.version, build: original.build,
    startedAt: original.startedAt, finishedAt: original.finishedAt, gateReceipt: original.gateReceipt,
    exitCode: 0, verifiedSourceAndGates: true, originalBuild: original, originalReceiptFile: capsule.originalReceiptFile,
    originalSuccessFile: originalFile(m, kind), originalSuccessSha256: m.reuseBuilds[kind].sha256,
    originalTimesChanged: false, newCompilationClaimed: false, reuseInputsFullyVerified: true, runtimeAlias,
    validatedAt, expiresAt: validatedAt + 1800000, controlPreflightSha256: sha(rootFile(m.stage + '/native-control-preflight/receipt.json')),
    applicationChecksAndContractsUnchanged: true, controlChangesCheckedSeparately: true,
    currentReadOnlyCandidateProbe: { requestedByRun: m.runId, preparationRun: old.runId, proof: currentReadOnlyCandidateProbe } };
  if (shared) Object.assign(value, { engine: structuredClone(m.engine), operation: structuredClone(m.operation),
    originalProvenanceSha256: provenance.evidenceSha256, originalManifestSha256: provenance.originalManifestSha256,
    runtimeAliasBinding: readSharedRuntimeAliasBinding(m, kind, capsule) });
  assertFreshCandidateEvidence(value, m, kind); writeJsonExclusive(candidateEvidenceFile(m, kind), value);
  execFileSync('chattr', ['+i', candidateEvidenceFile(m, kind)]); return value;
}
export function verifyReusedCandidate(m, kind) {
  const shared = isSharedEngine(m), provenance = shared ? verifySharedBuildProvenance(m) : null;
  if (!shared && (m.normalContinuation?.schema === CONTINUATION_V2 || m.deployedUsageSchema || m.deployedCanvasBatchSchema)) verifyDeployedContinuationProvenance(m);
  const value = json(candidateEvidenceFile(m, kind)); assertFreshCandidateEvidence(value, m, kind);
  assert.equal(value.manifestSha256, sha(rootFile(m.stage + '/manifest.json')));
  assertRuntimeAliasUnchanged(m, kind, value.runtimeAlias);
  const capsule = assertOriginalSnapshotStable(m, kind); assert.deepEqual(capsule.originalReceipt, value.originalBuild);
  assert.equal(sha(rootFile(originalFile(m, kind), 128 * 1024 * 1024)), value.originalSuccessSha256);
  if (shared) {
    assert.deepEqual(readSharedRuntimeAliasBinding(m, kind, capsule), value.runtimeAliasBinding);
    assert.equal(value.originalProvenanceSha256, provenance.evidenceSha256);
    assert.equal(value.originalManifestSha256, provenance.originalManifestSha256);
    assertSharedEngineControl(m, json(m.stage + '/native-control-preflight/receipt.json'));
  } else {
    assertControlOnlyChange(capsule.originalPrivateSha256, m.privateSha256);
    verifyNginxControlChange(m);
  }
  assert.deepEqual(buildFiles(m[kind].root + '/' + m[kind].buildDist), capsule.snapshot.build);
  assert.equal(sha(rootFile(m.stage + '/native-control-preflight/receipt.json')), value.controlPreflightSha256);
  return value;
}
export function originalPreparedFile(m, kind) {
  return sourceStage(m) + '/' + kind + '-prepared.json';
}
export function originalManifestForInputs(m) { return m.reuseBuilds ? json(sourceStage(m) + '/manifest.json') : m; }
export function inspectReuseTreeForEngineering(root, options) { return tree(root, options); }
