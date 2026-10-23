import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { guardBuildTailRuntime, assertGuardBuildTailObservation, assertCandidateObservation } from './candidate-evidence.mjs';

// Preparation and native receipt verification only. No service, production DB,
// build, release switch, upload, or guard process is controlled by this module.
const BOOTSTRAP = 'scripts/pricing-legacy-v0954/bootstrap-root.sh';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const SYSTEM_PATH = '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const MULTIVIEW_ENGINEERING_ROOT = '/data/video-api-debugger-engineering';
const call = (file, args, options = {}) => execFileSync(file, args, {
  encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  env: { PATH: SYSTEM_PATH, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, ...options,
}).trim();
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function regular(file, maximum = 64 * 1024 * 1024) {
  assert.equal(fs.realpathSync(file), file, `Noncanonical file: ${file}`);
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
    && stat.size > 0 && stat.size <= maximum, `Invalid regular file: ${file}`);
  return stat;
}

function identity(appUser) {
  assert.match(appUser, /^[a-z_][a-z0-9_-]{0,31}$/);
  assert.notEqual(appUser, 'root');
  const uid = Number(call('id', ['-u', appUser])), gid = Number(call('id', ['-g', appUser]));
  assert.ok(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0);
  return { uid, gid };
}

function canonicalCandidate(candidateRoot, source) {
  assert.equal(process.platform, 'linux', 'Actual Linux preparation is required');
  assert.equal(process.getuid(), 0, 'Root prepares inputs; the build still runs as the application user');
  assert.match(source, /^[a-f0-9]{40}$/);
  assert.ok(path.isAbsolute(candidateRoot) && candidateRoot.startsWith('/data/video-api-debugger/'));
  assert.equal(fs.realpathSync(candidateRoot), candidateRoot);
  const mount = call('findmnt', ['-n', '-o', 'TARGET', '-T', candidateRoot]);
  assert.ok(mount === '/data' || mount.startsWith('/data/'), 'Candidate must be on a mounted data volume');
  const stat = fs.lstatSync(candidateRoot);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o022));
  regular(path.join(candidateRoot, '.deployed-commit'), 128);
  assert.equal(fs.readFileSync(path.join(candidateRoot, '.deployed-commit'), 'utf8').trim(), source);
  return candidateRoot;
}

// sourceFiles is the controller's already locked relative-path -> SHA256 map.
// Historical .source files are read and checked exactly; never rewritten here.
function sourceSnapshot(root, sourceFiles) {
  assert.ok(sourceFiles && typeof sourceFiles === 'object' && !Array.isArray(sourceFiles));
  for (const required of [BOOTSTRAP, 'scripts/check-image-recovery.mjs', 'scripts/check-pricing-policy.mjs',
    'scripts/pricing-fixture-input.mjs', 'scripts/pricing-policy-contract-fixture.ts',
    'scripts/pricing-authoring-contract-fixture.ts', 'scripts/pricing-authoring-ui-contract-fixture.ts',
    'scripts/pricing-image-spec-contract-fixture.ts', 'scripts/pricing-video-scope-client-fixture.ts',
    'scripts/pricing-video-context-contract-fixture.ts',
    'scripts/pricing-request-status-contract-fixture.ts',
    'src/lib/pricing/isolation.ts', 'prisma/schema.prisma', 'package.json', 'package-lock.json']) {
    assert.ok(Object.hasOwn(sourceFiles, required), `Missing locked source: ${required}`);
  }
  assert.equal(Object.keys(sourceFiles).filter(file => file.startsWith('scripts/pricing-legacy-v0954/') && file.endsWith('.source')).length, 100);
  const checked = {};
  for (const file of Object.keys(sourceFiles).sort()) {
    assert.ok(file && !path.isAbsolute(file) && !file.split('/').some(part => !part || part === '.' || part === '..'));
    assert.match(sourceFiles[file], /^[a-f0-9]{64}$/);
    const target = path.join(root, file); regular(target);
    const digest = sha(fs.readFileSync(target));
    assert.equal(digest, sourceFiles[file], `Locked candidate source changed: ${file}`);
    checked[file] = digest;
  }
  const pkg = json(path.join(root, 'package.json'));
  assert.equal(pkg.scripts?.prebuild, 'node scripts/check-image-recovery.mjs');
  assert.equal(pkg.scripts?.build, 'next build');
  return sha(JSON.stringify(checked));
}

function protectedParents(root) {
  // Privileged setup finishes before handing the candidate root to the worker.
  for (let directory = root; directory !== '/'; directory = path.dirname(directory)) {
    const stat = fs.lstatSync(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022),
      `Root preparation requires protected ancestors: ${directory}`);
    if (directory === '/data') return;
  }
  assert.fail('Candidate has no protected /data ancestor');
}

function markerSnapshot(runtimeRoot, bootstrap) {
  return Object.fromEntries(['strict', 'ordinary', 'unprotected', 'wrong-schema', 'extra-field'].map(kind => {
    const file = path.join(kind === 'strict' ? runtimeRoot : path.join(runtimeRoot, 'g19-marker-cases', kind), 'storage/image-studio-drain');
    assert.equal(bootstrap.markers?.[kind], file);
    const stat = regular(file, 4096);
    assert.equal(stat.uid, 0); assert.equal(stat.mode & 0o777, 0o444);
    const match = /^(\S+)\s+([\s\S]+)$/.exec(call('lsattr', ['-d', '--', file]));
    assert.ok(match && match[2] === file);
    assert.equal(match[1].includes('i'), !['ordinary', 'unprotected'].includes(kind));
    return [kind, { file, uid: stat.uid, mode: stat.mode & 0o777, attributes: match[1], sha256: sha(fs.readFileSync(file)) }];
  }));
}

function multiviewFixturePath(source, runId) {
  assert.match(source, /^[a-f0-9]{40}$/);
  assert.match(runId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  return path.join(MULTIVIEW_ENGINEERING_ROOT, `private-${runId}-${source}`);
}
function inspectMultiviewFixtureRoot(source, runId, uid, gid, root = multiviewFixturePath(source, runId)) {
  const current = multiviewFixturePath(source, runId), legacy = path.join(MULTIVIEW_ENGINEERING_ROOT, runId, source);
  assert.ok(root === current || root === legacy, 'Private fixture must match the exact run and source');
  const data = fs.lstatSync('/data'), system = fs.statSync('/');
  assert.ok(data.isDirectory() && !data.isSymbolicLink() && data.dev !== system.dev);
  for (const directory of ['/data', MULTIVIEW_ENGINEERING_ROOT, ...(root === legacy ? [path.dirname(root)] : []), root]) {
    const stat = fs.lstatSync(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(directory) === directory && stat.dev === data.dev);
    assert.equal(stat.uid, directory === root ? uid : 0);
    assert.equal(stat.mode & (directory === root ? 0o077 : 0o022), 0);
    if (directory !== root) {
      // The Python reader opens every ancestor O_RDONLY|O_DIRECTORY. Search
      // alone is insufficient; do not repair a private release-run container.
      const readAndSearch = stat.uid === uid ? 0o500 : stat.gid === gid ? 0o050 : 0o005;
      assert.equal(stat.mode & readAndSearch, readAndSearch, 'Private fixture ancestor is inaccessible to the build identity');
    }
  }
  const stat = fs.lstatSync(root);
  assert.equal(stat.gid, gid); assert.equal(stat.mode & 0o777, 0o700);
  return { path: root, dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
}
function prepareMultiviewFixtureRoot(source, runId, uid, gid) {
  const root = multiviewFixturePath(source, runId);
  // Release-run containers hold root-only restore/binding evidence. New app
  // fixtures are siblings of those containers, never children or adoptees.
  for (const directory of [MULTIVIEW_ENGINEERING_ROOT]) {
    try { fs.mkdirSync(directory, { mode: 0o755 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(directory) === directory && stat.uid === 0 && !(stat.mode & 0o022));
  }
  assert.equal(fs.existsSync(root), false, 'Never adopt a prior or failed private fixture root');
  fs.mkdirSync(root, { mode: 0o700 }); fs.chownSync(root, uid, gid);
  return inspectMultiviewFixtureRoot(source, runId, uid, gid);
}
function cleanBuildEnv({ preparedRoot, source, runId, multiviewFixtureRoot = multiviewFixturePath(source, runId) }) {
  assert.ok(multiviewFixtureRoot === multiviewFixturePath(source, runId)
    || multiviewFixtureRoot === path.join(MULTIVIEW_ENGINEERING_ROOT, runId, source), 'Private fixture must match the exact run and source');
  const temporary = path.join(preparedRoot, 'build-tmp');
  return {
    PATH: SYSTEM_PATH, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', NODE_ENV: 'production',
    TMPDIR: temporary, HOME: path.join(temporary, 'home'), XDG_CACHE_HOME: path.join(temporary, 'cache'),
    NPM_CONFIG_CACHE: path.join(temporary, 'npm-cache'), NEXT_TELEMETRY_DISABLED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    NEXT_DIST_DIR: '.next-prod-candidate', DATABASE_URL: `file:${path.join(preparedRoot, 'candidate-build.db')}`,
    PRICING_GATE_PREPARED_ROOT: preparedRoot, PRICING_SOURCE_SHA: source, RATE_G19_FIXTURE_SOURCE_SHA: source,
    PRICING_GATE_RUN_ID: runId, IMAGE_RECOVERY_GATE_RUN_ID: runId,
    MULTIVIEW_PRIVATE_FIXTURE_ROOT: multiviewFixtureRoot,
    SESSION_SECRET: 'rate-impl2-candidate-isolated-build-not-a-production-secret',
  };
}

export function preparePricingInputs({ candidateRoot, source, runId, appUser, sourceFiles }) {
  const root = canonicalCandidate(candidateRoot, source), { uid, gid } = identity(appUser);
  assert.match(runId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  protectedParents(root);
  const sourceSha256 = sourceSnapshot(root, sourceFiles), startedAt = Date.now();
  const scratch = path.join(root, '.role-tests');
  if (!fs.existsSync(scratch)) fs.mkdirSync(scratch, { mode: 0o700 });
  assert.equal(fs.realpathSync(scratch), scratch);
  const scratchStat = fs.lstatSync(scratch);
  assert.ok(scratchStat.isDirectory() && !scratchStat.isSymbolicLink() && scratchStat.uid === 0 && !(scratchStat.mode & 0o077));
  const preparedRoot = path.join(scratch, `pricing-prepared-${runId}`);
  assert.ok(!fs.existsSync(preparedRoot) && !fs.lstatSync(scratch).isSymbolicLink(), 'Never reuse a consumed or failed candidate run');
  fs.mkdirSync(preparedRoot, { mode: 0o700 });
  const runtimeRoot = path.join(preparedRoot, 'pricing-legacy-fixture-runtime');
  const bootstrapBytes = fs.readFileSync(path.join(root, BOOTSTRAP));
  assert.equal(sha(bootstrapBytes), sourceFiles[BOOTSTRAP]);
  // Execute the verified bytes via stdin, never an application-writable script path.
  call('/bin/bash', ['-s', '--', root, runtimeRoot], { input: bootstrapBytes, timeout: 60000,
    env: { PATH: SYSTEM_PATH, LANG: 'C.UTF-8', TMPDIR: preparedRoot,
      RATE_G19_FIXTURE_UID: String(uid), RATE_G19_FIXTURE_GID: String(gid), RATE_G19_FIXTURE_SOURCE_SHA: source } });
  const manifest = path.join(runtimeRoot, 'g19-bootstrap.json'), stat = regular(manifest, 65536), bootstrap = json(manifest);
  assert.equal(stat.uid, 0); assert.equal(stat.mode & 0o777, 0o444);
  assert.equal(bootstrap.schema, 'pricing-legacy-bootstrap.v1'); assert.equal(bootstrap.candidateRoot, root);
  assert.equal(bootstrap.fixtureRoot, runtimeRoot); assert.equal(bootstrap.source, source);
  assert.equal(bootstrap.uid, uid); assert.equal(bootstrap.gid, gid);
  assert.equal(fs.realpathSync(runtimeRoot), runtimeRoot);
  const runtimeStat = fs.lstatSync(runtimeRoot);
  assert.ok(runtimeStat.isDirectory() && !runtimeStat.isSymbolicLink() && runtimeStat.uid === uid
    && runtimeStat.gid === gid && (runtimeStat.mode & 0o777) === 0o700);
  const installedAt = Date.parse(bootstrap.installedAt);
  assert.ok(Number.isFinite(installedAt) && installedAt >= startedAt - 1000 && installedAt <= Date.now());
  const markers = markerSnapshot(runtimeRoot, bootstrap);
  assert.ok(!fs.existsSync(path.join(preparedRoot, '.pricing-gate-claim')));
  assert.ok(!fs.existsSync(path.join(runtimeRoot, 'pricing-legacy-fixture.db')), 'No production DB is imported');
  const buildEnv = cleanBuildEnv({ preparedRoot, source, runId });
  const privateFixtureRoot = prepareMultiviewFixtureRoot(source, runId, uid, gid);
  for (const directory of [buildEnv.TMPDIR, buildEnv.HOME, buildEnv.XDG_CACHE_HOME, buildEnv.NPM_CONFIG_CACHE]) {
    fs.mkdirSync(directory, { mode: 0o700 }); fs.chownSync(directory, uid, gid);
  }
  const receipt = path.join(preparedRoot, 'candidate-inputs.json');
  fs.writeFileSync(receipt, JSON.stringify({ schema: 'rate-impl2-candidate-inputs.v1', candidateRoot: root, source, runId,
    uid, gid, preparedRoot, runtimeRoot, privateFixtureRoot, sourceSha256, bootstrapSha256: sha(bootstrapBytes),
    bootstrapReceiptSha256: sha(fs.readFileSync(manifest)), markers, startedAt, finishedAt: Date.now(),
    productionDatabaseCopied: false, servicesChanged: false, buildsRun: false }, null, 2), { flag: 'wx', mode: 0o444 });
  for (const directory of [scratch, preparedRoot, root]) fs.chownSync(directory, uid, gid);
  for (const directory of [scratch, preparedRoot]) {
    const owned = fs.lstatSync(directory);
    assert.equal(owned.uid, uid); assert.equal(owned.gid, gid); assert.equal(owned.mode & 0o777, 0o700);
  }
  // Create only an empty isolated schema; neither the fixtures nor the build see a production DB URL.
  const schemaLog = path.join(preparedRoot, 'candidate-schema.log');
  const previousUmask = process.umask(0o077);
  try {
    const output = call('runuser', ['-u', appUser, '--', 'env', '-i', ...Object.entries({ ...buildEnv,
      NODE_ENV: 'test', PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' }).map(([key, value]) => `${key}=${value}`),
    process.execPath, path.join(root, 'node_modules/prisma/build/index.js'), 'db', 'push',
    '--schema', path.join(root, 'prisma/schema.prisma')], { cwd: preparedRoot, timeout: 120000 });
    fs.writeFileSync(schemaLog, output, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    fs.writeFileSync(schemaLog, String(error.stdout || '') + String(error.stderr || ''), { flag: 'wx', mode: 0o600 });
    throw new Error(`Isolated candidate schema initialization failed; preserve ${preparedRoot} for inspection`, { cause: error });
  } finally {
    process.umask(previousUmask);
  }
  const database = buildEnv.DATABASE_URL.slice('file:'.length), databaseStat = regular(database);
  assert.equal(databaseStat.uid, uid); assert.equal(databaseStat.mode & 0o077, 0);
  const generatedSchema = path.join(root, 'node_modules/.prisma/client/schema.prisma');
  regular(generatedSchema);
  const formattedSchema = path.join(preparedRoot, 'candidate-client-schema.prisma');
  fs.writeFileSync(formattedSchema, fs.readFileSync(path.join(root, 'prisma/schema.prisma')), { flag: 'wx', mode: 0o600 });
  fs.chownSync(formattedSchema, uid, gid);
  call('runuser', ['-u', appUser, '--', 'env', '-i', ...Object.entries({ ...buildEnv,
    NODE_ENV: 'test', PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' }).map(([key, value]) => `${key}=${value}`),
  process.execPath, path.join(root, 'node_modules/prisma/build/index.js'), 'format', '--schema', formattedSchema],
  { cwd: preparedRoot, timeout: 120000 });
  regular(formattedSchema);
  assert.equal(sha(fs.readFileSync(generatedSchema)), sha(fs.readFileSync(formattedSchema)),
    'Candidate Prisma client must be generated from the exact new schema before any fixture or build');
  assert.equal(sourceSnapshot(root, sourceFiles), sourceSha256);
  assert.equal(sha(fs.readFileSync(manifest)), json(receipt).bootstrapReceiptSha256);
  assert.deepEqual(markerSnapshot(runtimeRoot, bootstrap), markers);
  assert.ok(!fs.existsSync(path.join(preparedRoot, '.pricing-gate-claim')));
  return { candidateRoot: root, source, runId, appUser, preparedRoot, runtimeRoot, buildEnv, receipt, sourceSha256,
    bootstrapReceiptSha256: sha(fs.readFileSync(manifest)) };
}

export function readPreparedPricingInputs({ candidateRoot, source, runId, appUser, sourceFiles }) {
  const root = canonicalCandidate(candidateRoot, source);
  const preparedRoot = path.join(root, '.role-tests', `pricing-prepared-${runId}`);
  const receipt = path.join(preparedRoot, 'candidate-inputs.json'), stat = regular(receipt, 65536);
  assert.equal(stat.uid, 0); assert.equal(stat.mode & 0o777, 0o444);
  const value = json(receipt);
  assert.equal(value.buildsRun, false, 'Prepared input must not have been consumed');
  const prepared = { candidateRoot: root, source, runId, appUser, preparedRoot,
    runtimeRoot: path.join(preparedRoot, 'pricing-legacy-fixture-runtime'),
    buildEnv: cleanBuildEnv({ preparedRoot, source, runId, multiviewFixtureRoot: value.privateFixtureRoot?.path }), receipt,
    sourceSha256: value.sourceSha256, bootstrapReceiptSha256: value.bootstrapReceiptSha256 };
  verifyPricingInputs({ candidateRoot: root, source, runId, appUser, sourceFiles, prepared });
  return prepared;
}

const NATIVE_GATE_AGES = Object.freeze({
  'scripts/check-image-recovery.mjs': "assert.ok(Date.now() - value.startedAt <= 30 * 60_000, 'Build gate receipt is stale');",
  'scripts/check-pricing-policy.mjs': "assert.ok(Date.now() - value.startedAt <= 30 * 60_000, 'Pricing gate receipt is stale');",
});
const __sd2TailFs = fs, __sd2TailHash = createHash;
function __sd2ReadTailEntity(file, uid, privateFile) {
  assert.equal(__sd2TailFs.realpathSync(file), file);
  const fields = ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'];
  const identity = stat => Object.fromEntries(fields.map(key => [key, stat[key]]));
  const before = __sd2TailFs.lstatSync(file);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.uid === uid && before.nlink === 1
    && before.size > 0 && before.size <= 8 * 1024 * 1024 && !(before.mode & (privateFile ? 0o077 : 0o022)));
  const fd = __sd2TailFs.openSync(file, __sd2TailFs.constants.O_RDONLY | __sd2TailFs.constants.O_NOFOLLOW);
  try {
    assert.deepEqual(identity(__sd2TailFs.fstatSync(fd)), identity(before));
    const bytes = __sd2TailFs.readFileSync(fd);
    assert.deepEqual(identity(__sd2TailFs.fstatSync(fd)), identity(before));
    assert.deepEqual(identity(__sd2TailFs.lstatSync(file)), identity(before));
    return { file, identity: identity(before), sha256: __sd2TailHash('sha256').update(bytes).digest('hex'), bytes };
  } finally { __sd2TailFs.closeSync(fd); }
}
function __sd2AssertTailNativeAge(value, binding, entry) {
  const target = binding.entries.find(item => item.file === entry);
  assert.ok(target, 'Unknown native tail verifier');
  assert.equal(process.argv.length, 6); assert.equal(__sd2TailFs.realpathSync(process.argv[1]), entry);
  assert.equal(process.argv[2], '--verify'); assert.equal(process.argv[3], target.gate.file);
  assert.equal(process.argv[4], '--since'); assert.equal(process.argv[5], String(binding.since));
  assert.equal(__sd2TailFs.realpathSync(process.cwd()), binding.candidateRoot);
  assert.equal(process.getuid(), binding.uid);
  const observed = __sd2ReadTailEntity(target.gate.file, binding.uid, true);
  assert.equal(observed.sha256, target.gate.sha256); assert.deepEqual(observed.identity, target.gate.identity);
  assert.equal(value.runId, binding.runId); assert.equal(value.candidateRoot, binding.candidateRoot);
  assert.equal(value.startedAt, target.gate.startedAt); assert.equal(value.finishedAt, target.gate.finishedAt);
  assert.ok(value.startedAt >= binding.since && value.finishedAt >= value.startedAt && value.finishedAt <= binding.originalFinishedAt);
  const now = Date.now();
  assert.ok(binding.observedAt <= now && now < binding.expiresAt, 'Fresh bound tail observation expired');
  assert.equal(binding.expiresAt, binding.observedAt + 1800000);
}
function nativeTailBinding({ candidateRoot, source, runId, uid, receipt, since, tailContext }) {
  assert.equal(process.getuid(), 0, 'Only the root owning processor may bind a native tail observation');
  const m = tailContext.manifest, runtime = guardBuildTailRuntime(m);
  assert.ok(runtime, 'Native tail verification requires its current journal-bound runtime');
  assert.deepEqual(tailContext.runtime, runtime);
  assert.equal(m.reuseBuilds, undefined);
  assert.equal(m.runId, runId); assert.equal(runtime.proof.runId, runId);
  const now = Date.now(), observedAt = tailContext.observedAt;
  let original, definitions, observationProofSha256 = null;
  if (runtime.candidateObservation) {
    const kind = ['main', 'guard'].find(role => m[role]?.root === candidateRoot);
    assert.ok(kind, 'Independent observation must bind an original candidate');
    assert.equal(m[kind].source, source);
    assert.deepEqual(tailContext.candidateObservation, runtime.candidateObservation);
    const originalFile = m.stage + '/' + kind + '-build.json', stat = regular(originalFile);
    assert.equal(stat.uid, 0); assert.equal(stat.mode & 0o022, 0);
    original = json(originalFile);
    const observation = assertCandidateObservation(original, m, kind, now);
    assert.ok(observation, 'Independent native verification requires the root candidate observation');
    assert.equal(observedAt, observation.observedAt);
    observationProofSha256 = runtime.candidateObservation.proofSha256;
    const capsule = json(observation.candidates[kind].capsuleFile);
    const imageFile = original.gateReceipt;
    assert.ok(typeof imageFile === 'string' && imageFile.startsWith(candidateRoot + '/.role-tests/'));
    const pricingFile = json(imageFile).pricingReceipt;
    definitions = [
      ['scripts/check-image-recovery.mjs', imageFile, 'image-recovery-build-gate.v1'],
      ['scripts/check-pricing-policy.mjs', pricingFile, 'pricing-policy-build-gate.v1'],
    ].map(([entry, file, schema]) => {
      assert.ok(typeof file === 'string' && file.startsWith(candidateRoot + '/.role-tests/'));
      const expected = capsule.snapshot.checks[path.relative(candidateRoot + '/.role-tests', file)]?.sha256;
      assert.match(expected || '', /^[a-f0-9]{64}$/, 'Native receipt must belong to the freshly verified complete check snapshot');
      return [entry, file, expected, schema];
    });
  } else {
    assert.equal(tailContext.candidateObservation, undefined);
    assert.equal(m.guard.root, candidateRoot); assert.equal(m.guard.source, source);
    original = runtime.proof.originalBuild;
    const request = runtime.proof.request;
    const parse = value => typeof value === 'number' ? value : Date.parse(value);
    const requestObservedAt = parse(runtime.retry ? runtime.retry.proof.observedAt : request.observedAt);
    assert.ok(Number.isSafeInteger(requestObservedAt) && requestObservedAt > 0);
    assert.ok(Number.isSafeInteger(observedAt) && observedAt >= requestObservedAt && observedAt >= original.finishedAt
      && observedAt <= now && now < observedAt + 1800000, 'Fresh tail observation is missing or expired');
    const sealedFile = m.stage + '/guard-build.json';
    if (fs.existsSync(sealedFile)) {
      const stat = regular(sealedFile); assert.equal(stat.uid, 0); assert.equal(stat.mode & 0o022, 0);
      const sealed = json(sealedFile); assertGuardBuildTailObservation(sealed, m, now);
      assert.equal(observedAt, sealed.tailPostchecks.observedAt, 'A sealed tail observation cannot be refreshed during verification');
    } else assert.ok(now < requestObservedAt + 1800000, 'The root tail proof needs its own fresh real observation');
    definitions = [
      ['scripts/check-image-recovery.mjs', original.imageGateReceiptFile, request.imageGateReceiptSha256, 'image-recovery-build-gate.v1'],
      ['scripts/check-pricing-policy.mjs', original.pricingGateReceiptFile, request.pricingGateReceiptSha256, 'pricing-policy-build-gate.v1'],
    ];
  }
  assert.equal(since, original.startedAt);
  const entries = definitions.map(([entry, file, expected, schema]) => {
    assert.ok(typeof file === 'string' && file.startsWith(candidateRoot + '/.role-tests/'));
    const read = __sd2ReadTailEntity(file, uid, true), value = JSON.parse(read.bytes);
    assert.equal(read.sha256, expected); assert.equal(value.schema, schema); assert.equal(value.completed, true);
    assert.equal(value.runId, runId); assert.equal(value.candidateRoot, candidateRoot);
    assert.ok(Number.isSafeInteger(value.startedAt) && Number.isSafeInteger(value.finishedAt)
      && value.startedAt >= since && value.finishedAt >= value.startedAt && value.finishedAt <= original.finishedAt);
    return { entry, file: candidateRoot + '/' + entry, gate: { file, sha256: read.sha256, identity: read.identity,
      startedAt: value.startedAt, finishedAt: value.finishedAt } };
  });
  assert.ok(entries.some(item => item.gate.file === receipt));
  assert.equal(json(entries[0].gate.file).pricingReceipt, entries[1].gate.file, 'The original image verifier must retain its bound pricing child');
  return { candidateRoot, source, runId, uid, since, originalFinishedAt: original.finishedAt,
    continuationSha256: runtime.continuationSha256, retryProofSha256: runtime.retry?.proofSha256 || null,
    candidateObservationProofSha256: observationProofSha256, observedAt, expiresAt: observedAt + 1800000, entries };
}
function nativeTailNodeOptions(binding) {
  // Only these two locked modules are transformed, and only their unique age
  // assertion. Hash sets, child logs, receipt intervals and fixture validators
  // remain the original code. The nested pricing --verify inherits NODE_OPTIONS.
  const load = `
export async function load(url, context, nextLoad) {
  const target = binding.entries.find(item => item.url === url);
  if (!target) return nextLoad(url, context);
  const before = __sd2ReadTailEntity(target.file, binding.uid, false);
  assert.equal(before.sha256, target.sha256); assert.deepEqual(before.identity, target.identity);
  const result = await nextLoad(url, context);
  assert.equal(result.format, 'module');
  const source = Buffer.from(result.source).toString('utf8');
  assert.equal(__sd2TailHash('sha256').update(source).digest('hex'), target.sha256);
  assert.equal(source.split(target.age).length, 2, 'Native gate age assertion must occur exactly once');
  const after = __sd2ReadTailEntity(target.file, binding.uid, false);
  assert.equal(after.sha256, before.sha256); assert.deepEqual(after.identity, before.identity);
  const prefix = ${JSON.stringify("import * as __sd2TailFs from 'node:fs';import {createHash as __sd2TailHash} from 'node:crypto';\n" + __sd2ReadTailEntity.toString() + '\n' + __sd2AssertTailNativeAge.toString() + '\n')}
    + 'const __sd2TailBinding=' + JSON.stringify(binding) + ';' + String.fromCharCode(10);
  return {...result, source: prefix + source.replace(target.age,
    '__sd2AssertTailNativeAge(value,__sd2TailBinding,' + JSON.stringify(target.file) + ');')};
}`;
  const module = "import assert from 'node:assert/strict';import * as __sd2TailFs from 'node:fs';import {createHash as __sd2TailHash} from 'node:crypto';\n"
    + __sd2ReadTailEntity.toString() + '\nlet binding;export function initialize(value){binding=value;}\n' + load;
  const loader = 'data:text/javascript;base64,' + Buffer.from(module).toString('base64');
  const bootstrap = "import {register} from 'node:module';register(" + JSON.stringify(loader)
    + ',{parentURL:import.meta.url,data:' + JSON.stringify(binding) + '});';
  return '--import=data:text/javascript;base64,' + Buffer.from(bootstrap).toString('base64');
}

export function verifyNativeGateReceipt({ candidateRoot, source, runId, appUser, sourceFiles, entry, receipt, since, buildEnv, tailContext }) {
  assert.ok(Object.hasOwn(NATIVE_GATE_AGES, entry), 'Only the original image/pricing --verify entries are allowed');
  const root = canonicalCandidate(candidateRoot, source), { uid } = identity(appUser);
  assert.match(runId, /^[a-f0-9-]{36}$/); assert.ok(Number.isSafeInteger(since) && since > 0 && since <= Date.now());
  assert.ok(typeof receipt === 'string' && receipt.startsWith(root + '/.role-tests/'));
  const env = entry === 'scripts/check-image-recovery.mjs' ? { ...buildEnv } : { PATH: SYSTEM_PATH, LANG: 'C.UTF-8' };
  if (entry === 'scripts/check-image-recovery.mjs') assert.ok(buildEnv && Object.keys(buildEnv).length > 0);
  let binding;
  if (tailContext !== undefined) {
    binding = nativeTailBinding({ candidateRoot: root, source, runId, uid, receipt, since, tailContext });
    for (const target of binding.entries) {
      const read = __sd2ReadTailEntity(target.file, uid, false);
      assert.equal(read.sha256, sourceFiles[target.entry], 'Native verifier source changed');
      assert.equal(read.bytes.toString('utf8').split(NATIVE_GATE_AGES[target.entry]).length, 2, 'Unique original native age assertion required');
      Object.assign(target, { url: pathToFileURL(target.file).href, sha256: read.sha256, identity: read.identity, age: NATIVE_GATE_AGES[target.entry] });
    }
    assert.equal(Object.hasOwn(env, 'NODE_OPTIONS'), false, 'Do not replace an existing loader environment');
    env.NODE_OPTIONS = nativeTailNodeOptions(binding);
  }
  const output = call('runuser', ['-u', appUser, '--', 'env', '-i', ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    entry === 'scripts/check-image-recovery.mjs' ? 'node' : process.execPath, entry, '--verify', receipt, '--since', String(since)], { cwd: root, timeout: 60000 });
  if (binding) {
    assert.deepEqual(nativeTailBinding({ candidateRoot: root, source, runId, uid, receipt, since, tailContext }),
      { ...binding, entries: binding.entries.map(({ entry: name, file, gate }) => ({ entry: name, file, gate })) });
    for (const target of binding.entries) {
      const read = __sd2ReadTailEntity(target.file, uid, false); assert.equal(read.sha256, target.sha256); assert.deepEqual(read.identity, target.identity);
    }
  }
  return output;
}

export function verifyPricingGateReceipt({ candidateRoot, source, runId, appUser, sourceFiles, receipt, since, tailContext }) {
  const root = canonicalCandidate(candidateRoot, source), { uid } = identity(appUser);
  assert.match(runId, /^[a-f0-9-]{36}$/);
  assert.ok(Number.isSafeInteger(since) && since > 0 && since <= Date.now());
  const sourceSha256 = sourceSnapshot(root, sourceFiles);
  assert.ok(path.isAbsolute(receipt) && receipt.startsWith(path.join(root, '.role-tests') + path.sep));
  const stat = regular(receipt, 8 * 1024 * 1024);
  assert.equal(stat.uid, uid); assert.equal(stat.mode & 0o077, 0);
  const receiptBytes = fs.readFileSync(receipt), value = JSON.parse(receiptBytes.toString('utf8'));
  const receiptSha256 = sha(receiptBytes);
  assert.equal(value.schema, 'pricing-policy-build-gate.v1'); assert.equal(value.completed, true);
  assert.equal(value.candidateRoot, root); assert.equal(value.runId, runId);
  assert.ok(typeof value.fixtureReceipt === 'string' && path.isAbsolute(value.fixtureReceipt)
    && value.fixtureReceipt.startsWith(path.join(root, '.role-tests') + path.sep));
  const fixtureStat = regular(value.fixtureReceipt, 8 * 1024 * 1024);
  assert.equal(fixtureStat.uid, uid); assert.equal(fixtureStat.mode & 0o077, 0);
  const fixture = json(value.fixtureReceipt);
  assert.equal(fixture.rootInputManifest?.source, source);
  assert.ok(value.startedAt >= since && value.finishedAt >= value.startedAt && value.finishedAt <= Date.now() + 1000);
  if (tailContext === undefined) assert.ok(Date.now() - value.startedAt <= 30 * 60_000, 'Pricing receipt is stale');
  else nativeTailBinding({ candidateRoot: root, source, runId, uid, receipt, since, tailContext });
  // The native verifier proves G01-G30, all fourteen actual transcripts,
  // root/immutable inputs, process identity, every candidate hash, and receipt times.
  const output = verifyNativeGateReceipt({ candidateRoot: root, source, runId, appUser, sourceFiles,
    entry: 'scripts/check-pricing-policy.mjs', receipt, since, tailContext });
  assert.match(output, /Pricing policy build gate verified/);
  assert.equal(sourceSnapshot(root, sourceFiles), sourceSha256);
  assert.equal(sha(fs.readFileSync(receipt)), receiptSha256, 'Pricing receipt changed during native verification');
  return { source, runId, candidateRoot: root, receipt, receiptSha256, sourceSha256,
    nativeGate: 'scripts/check-pricing-policy.mjs', nativeG01G24Verified: true, nativeG25G30Verified: true, output };
}

export function verifyPricingInputs({ candidateRoot, source, runId, appUser, sourceFiles, prepared }) {
  const root = canonicalCandidate(candidateRoot, source), { uid, gid } = identity(appUser);
  assert.equal(prepared.candidateRoot, root); assert.equal(prepared.source, source); assert.equal(prepared.runId, runId);
  assert.equal(prepared.appUser, appUser);
  const preparedRoot = path.join(root, '.role-tests', `pricing-prepared-${runId}`);
  const runtimeRoot = path.join(preparedRoot, 'pricing-legacy-fixture-runtime');
  assert.equal(prepared.preparedRoot, preparedRoot); assert.equal(prepared.runtimeRoot, runtimeRoot);
  assert.equal(fs.realpathSync(preparedRoot), preparedRoot); assert.equal(fs.realpathSync(runtimeRoot), runtimeRoot);
  const privateFixtureRoot = prepared.buildEnv.MULTIVIEW_PRIVATE_FIXTURE_ROOT;
  assert.deepEqual(prepared.buildEnv, cleanBuildEnv({ preparedRoot, source, runId, multiviewFixtureRoot: privateFixtureRoot }));
  const receipt = path.join(preparedRoot, 'candidate-inputs.json'); assert.equal(prepared.receipt, receipt);
  const stat = regular(receipt, 65536); assert.equal(stat.uid, 0); assert.equal(stat.mode & 0o777, 0o444);
  const value = json(receipt);
  assert.equal(value.schema, 'rate-impl2-candidate-inputs.v1'); assert.equal(value.candidateRoot, root);
  assert.equal(value.source, source); assert.equal(value.runId, runId); assert.equal(value.uid, uid); assert.equal(value.gid, gid);
  assert.equal(value.productionDatabaseCopied, false); assert.equal(value.servicesChanged, false);
  assert.equal(value.preparedRoot, preparedRoot); assert.equal(value.runtimeRoot, runtimeRoot);
  assert.deepEqual(inspectMultiviewFixtureRoot(source, runId, uid, gid, privateFixtureRoot), value.privateFixtureRoot);
  assert.equal(value.sourceSha256, sourceSnapshot(root, sourceFiles)); assert.equal(value.sourceSha256, prepared.sourceSha256);
  const manifest = path.join(runtimeRoot, 'g19-bootstrap.json'), bootstrapStat = regular(manifest, 65536);
  assert.equal(bootstrapStat.uid, 0); assert.equal(bootstrapStat.mode & 0o777, 0o444);
  assert.equal(sha(fs.readFileSync(manifest)), value.bootstrapReceiptSha256);
  assert.equal(value.bootstrapReceiptSha256, prepared.bootstrapReceiptSha256);
  const bootstrap = json(manifest);
  assert.equal(bootstrap.schema, 'pricing-legacy-bootstrap.v1'); assert.equal(bootstrap.candidateRoot, root);
  assert.equal(bootstrap.fixtureRoot, runtimeRoot); assert.equal(bootstrap.source, source);
  assert.equal(bootstrap.uid, uid); assert.equal(bootstrap.gid, gid);
  assert.deepEqual(markerSnapshot(runtimeRoot, bootstrap), value.markers);
  const database = prepared.buildEnv.DATABASE_URL.slice('file:'.length), dbStat = regular(database);
  assert.equal(dbStat.uid, uid); assert.equal(dbStat.mode & 0o077, 0);
  assert.equal(fs.readFileSync(database).subarray(0, 16).toString(), 'SQLite format 3\0');
  return { sourceSha256: value.sourceSha256, bootstrapReceiptSha256: value.bootstrapReceiptSha256 };
}


