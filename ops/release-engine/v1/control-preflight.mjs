import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { rootFile, sha, writeJsonExclusive, validateManifest, assertReleaseWindow, call, isSharedEngine, engineDirectory, sharedReadOnlyHdBounds } from './common.mjs';
import { captureSwitchBefore } from './switch.mjs';
import { inspectNativeBeforeMaintenance } from './cutover-safety.mjs';
import { inspectRetiredHdCaches } from './retired-hd-cache.mjs';
import { inspectHdReconciliation, assertHdE01CacheSourceProof } from './hd-storage-preflight.mjs';
import { verifyRateSourceArchive } from './package-candidates.mjs';
import { inspectRecoveryCertificate } from './certificate.mjs';
import { MV_DIRECT } from './release-contract.mjs';
import { inspectRetainedUploadProof } from './raw-upload-recovery-proof.mjs';
import { verifyNormalContinuation, recordHdAdmission } from './normal-continuation.mjs';
import { verifyDeployedUsageSchema, assertPriorUsageRoleControl, assertCurrentPublishedBaseline } from './deployed-usage-schema.mjs';
import { inspectInstalledMultiviewRecipeAdoption } from './multiview-works-control.mjs';
import { throwReleaseError } from './release-errors.mjs';

const NATIVE_FILES = ['release-protection-engineering.mjs', 'guard-recovery-engineering.mjs',
  'candidate-reuse-engineering.mjs', 'retired-hd-cache-engineering.mjs', 'hd-closed-cache-engineering.mjs',
  'cutover-driver-engineering.mjs', 'cutover-safety-engineering.mjs', 'hd-storage-preflight-engineering.mjs',
  'certificate-engineering.mjs', 'usage-role-engineering.mjs', 'preflight-resume-engineering.mjs', 'normal-continuation-engineering.mjs',
  'candidate-lifecycle-engineering.mjs', 'deployed-usage-schema-engineering.mjs', 'runtime-source-engineering.mjs', 'canvas-batch-schema-engineering.mjs',
  'multiview-works-engineering.mjs'];
const NATIVE_TIMEOUT_MS = 180000;
const SHARED_NATIVE_FILES = [...NATIVE_FILES, 'attempt-state-engineering.mjs', 'release-entry-engineering.mjs'];
const MANIFEST_NATIVE_FILES = ['runtime-source-engineering.mjs', 'canvas-batch-schema-engineering.mjs'];
const SIZE_LOG_ORIGINAL = Object.freeze({
  runId: '10cf6c09-d7b4-4986-b3b8-0868dd8ca1cf',
  manifestSha256: '251e9697976e349f3b004c3c429cbeecac2a957f04e85fb1841dcda353c5becb',
  batchSha256: '486ba29a9a854401e551481aa5609c0d235bc909a9ae0eb29910a0372a4d79eb',
});
const SIZE_LOG_EXECUTED = ['preflight-resume-engineering.mjs'];
const SIZE_LOG_STORAGE_ORIGIN = Object.freeze({
  runId: '009ae041-fd1c-4921-aa4e-7ea225d42434',
  manifestSha256: '981537bd462d8c668baca4da8587f34336164c9e604f656514c469121d00cb7f',
  batchSha256: '4e9e48b2792b6c943295b15168d7b8127dfe31b509bf8aa76678ae9d107f352e',
  file: 'hd-storage-preflight-engineering.mjs',
  receiptSha256: '6c2520f906de7b0a6c970818e6d0e6dc9f6254a28f27b2c3af603ee04d1175d8',
  logSha256: '051fd7fe30e1004cce194b14b165dc553cf81963855ad1e6b508c072eb18f60b',
});
const SIZE_LOG_PRIOR = Object.freeze({
  runId: 'b87ce364-6722-413e-b756-42fd3c78d952',
  manifestSha256: '1b8e8936f3fd6ac1554d20c9de18c52a41b15c4e52b8fdbdcfb7de645b3118ac',
  failedBatchSha256: '867f87f405017d368641136c55fdbafd052e5a00bb17a95ebc95f17f9aa744b2',
  sourceManifests: { main: '80f05175a96757f24d1395964b1f33e1b814d49f66f1faebcaaef6d786640748',
    guard: '85f0f86ebb48f27e4ce1af36329087bd177a9cce025d9f2c00069244c647690d' },
  receipts: {
    'hd-closed-cache-engineering.mjs': '78175ca1287cdbc0b96a212deab216d5e1cef0bb925eef00caaab0fa756ef281',
    'hd-storage-preflight-engineering.mjs': 'a611bfa859d6baf2091c5bfb298bfceb0c6b509b31946c37ff4b99de44db7d76',
    'candidate-lifecycle-engineering.mjs': 'c8ba1d1a5fc1605bf800cd60399a82f8154147d26e5983a06f8ae40688cb8f76',
    'runtime-source-engineering.mjs': '296e5e9f064004085443a18202b37cc39a822498e2e7f5c7d148f05f71e0cfca',
    'canvas-batch-schema-engineering.mjs': '98d49604710388f3bdb77fc1d551e769399d38686097de41c6bfe5c8d77d8b31',
  },
});
const SIZE_LOG_PRIOR_LEAVES = ['candidate-lifecycle-engineering.mjs', 'runtime-source-engineering.mjs',
  'canvas-batch-schema-engineering.mjs'];
const SIZE_LOG_HD_CLOSED_ORIGIN = Object.freeze({
  runId: 'b1a58279-1d4a-4b09-8dfb-929fb9350ba3',
  manifestSha256: 'b3d1568c646114a00e98a99a5080a4bbfb935ff9b9a06bd1fc0456c6c38b94e2',
  batchSha256: 'bc674a7be5cc5581e3fd2231cc5f868742cda75bab296467a29e3dacddd15357',
  file: 'hd-closed-cache-engineering.mjs',
  receiptSha256: '66f95ad6161733b1df366b9e217a086a1fe5fe51981bca04cca6f4082b78b96e',
  logSha256: '9959d9527a8c747d3036278859b80ce38e89633c6550c57acd9abf52dfd14e9a',
  mainSource: 'de9fc0b9a098702e0d88eda599a11d0520c52a21',
  guardSource: '32f3f71683fddedfc83c976eb6c280db22dab64b',
  sourceManifests: { main: 'e6b43c66f41262bd9fd92050d088ab3b274485ea55c928f68280136bd8cf6b33',
    guard: 'a242d80e83a7684c228574e84634204dfd270cba98ffd762a17b38bafa685520' },
});
const SIZE_LOG_HD = Object.freeze({
  'hd-storage-preflight.mjs': '7a55bce97acbe42c6c475038693bf5e907ef25a78467e76691fda47ae235a48b',
  'hd-closed-cache-engineering.mjs': '9c97e55f12dc8076b9889d474b41fd709dc7256d5825c53b4a18bcc64fc4c560',
  'hd-storage-preflight-engineering.mjs': '6cd2e0ae2fa14393b607d5953c8e1c514215ab94daa063c170a14f0f24b8b185',
});
// Exact reviewed R08 corrections only. New candidates must contain the frozen
// repaired bytes; the pinned historical origins must contain the original bytes.
const SIZE_LOG_SOURCE_DELTAS = Object.freeze({
  'src/lib/image-studio/provider.ts': {
    original: { sha256: '158c96efa792278c2be4c4d5d1c63e4de964a79aa8c630731266c2637b3169b6', gitBlob: 'fb137e1364e4bd812d6c789baa357ef0690a74b0', bytes: 41613 },
    repaired: { sha256: '12432fde065dbc3457c9da797229c7e8ddf1c33b0458c09868773caebdb48042', gitBlob: 'a0191ba1e767c288331a6646148f2e2f2b1eafa7', bytes: 42120 },
  },
  'scripts/studio-restored-settings-engineering.ts': {
    original: { sha256: 'b1d9961931fe8cf66d4aca7570c13e4a22e4c8694f73fe133ab9b611f7cab335', gitBlob: 'b812d14cb6a3ec894ec1746b7f42d41cd1f5287a', bytes: 25185 },
    repaired: { sha256: '5967e981ae5fb72a69b538377008a1211e2f9734c1e2ec8a369dbd65a16ea678', gitBlob: 'e49e094631f50aafe97f7de292b95042e0ac08e4', bytes: 25340 },
  },
  'scripts/image-provider-error-engineering.ts': {
    original: { sha256: '7b8c6bfab6ea42593315a4dbce89762336f814facee8539fa47c5e1029f8ee73', gitBlob: 'ed0bf1ffeacfb77cd754d84114c23d24ebd0b58c', bytes: 26603 },
    repaired: { sha256: 'cdfdfb165bf5f8017e4873d4ccbe80f05c607d911f9000f496dd617fad4ba45a', gitBlob: 'd927b920e80f5844ae334adfffa2a2bfc93ce229', bytes: 30618 },
  },
});

function sizeLogReuseEligible(m) {
  return !isSharedEngine(m) && m.protectedIncrement?.baselineSource === '31bff5a6544a3d18d433b81fa7735ed57b0d012c'
    && !m.normalContinuation && !m.reuseBuilds && m.runId !== SIZE_LOG_ORIGINAL.runId;
}
function normalizedSizeLogManifest(m) {
  const value = JSON.parse(JSON.stringify(m));
  assert.equal(m.stage, m.projectRoot + '/release-staging/' + m.runId);
  assert.equal(m.windowFile, m.stage + '/window.json');
  assert.ok(Number.isFinite(Date.parse(m.observedAt)));
  value.runId = '$RUN'; value.stage = '$STAGE'; value.windowFile = '$WINDOW'; value.observedAt = '$OBSERVED';
  value.privateSha256 = '$VERIFIED_PRIVATE';
  assert.equal(m.uploadPrivateDirectory.preparedReceipt, m.stage + '/upload-directory-prepared.json');
  value.uploadPrivateDirectory.preparedReceipt = '$PREPARED_RECEIPT';
  for (const kind of ['main', 'guard']) {
    const source = m[kind].source;
    assert.equal(m[kind + 'Source'], source);
    assert.equal(m[kind].root, m.projectRoot + '/managed-releases/' + source);
    assert.equal(m[kind].archive, m.stage + '/' + kind + '/source.tar.gz');
    assert.equal(m[kind].sourceManifest, m.stage + '/' + kind + '/source-manifest.json');
    value[kind + 'Source'] = '$' + kind;
    for (const field of ['source', 'root', 'archive', 'sourceManifest']) value[kind][field] = '$' + kind + ':' + field;
  }
  return value;
}
function releaseContractParts(bytes, m) {
  const text = bytes.toString(), marker = 'export const MV_DIRECT = Object.freeze(';
  const start = text.indexOf(marker) + marker.length, end = text.indexOf('\n});', start) + 2;
  assert.ok(start >= marker.length && end > start && text.indexOf(marker, start) === -1);
  const contract = JSON.parse(text.slice(start, end));
  for (const [field, expected] of [['recoveryRunId', m.runId], ['mainSource', m.mainSource], ['recoveryGuardSource', m.guardSource]]) {
    assert.equal(contract[field], expected); delete contract[field];
  }
  const restoredFixture = 'scripts/studio-restored-settings-engineering.ts';
  for (const field of ['approvedMainFiles']) {
    assert.ok(Array.isArray(contract[field]));
    assert.equal(contract[field].filter(file => file === restoredFixture).length, m.runId === MV_DIRECT.recoveryRunId ? 1 : 0,
      'Only the current exact restored fixture may extend the reviewed source scope');
    contract[field] = contract[field].filter(file => file !== restoredFixture);
  }
  return { before: text.slice(0, start), contract, after: text.slice(end) };
}
function normalizedSizeLogSource(value, kind, m) {
  assert.equal(value.kind, kind); assert.equal(value.source, m[kind].source); assert.equal(value.version, m[kind].version);
  const result = JSON.parse(JSON.stringify(value)), profile = 'ops/sd2-release-profile.json';
  assert.deepEqual(Object.keys(value.files).sort(), Object.keys(value.fileDetails).sort());
  assert.ok(value.files[profile] && value.fileDetails[profile]);
  result.source = '$SOURCE'; result.tree = '$TREE'; result.archiveSha256 = '$VERIFIED_ARCHIVE'; result.createdAt = '$CREATED';
  result.files[profile] = '$PROFILE';
  result.totalSourceBytes -= result.fileDetails[profile].bytes;
  result.fileDetails[profile] = { ...result.fileDetails[profile], gitBlob: '$PROFILE_BLOB', bytes: '$PROFILE_BYTES' };
  for (const [file, delta] of Object.entries(SIZE_LOG_SOURCE_DELTAS)) {
    const expected = m.runId === MV_DIRECT.recoveryRunId ? delta.repaired : delta.original;
    assert.equal(value.files[file], expected.sha256, 'Unapproved corrected source bytes: ' + file);
    assert.deepEqual(value.fileDetails[file], { gitBlob: expected.gitBlob, mode: '100644', bytes: expected.bytes },
      'Unapproved corrected source metadata: ' + file);
    result.totalSourceBytes -= expected.bytes;
    result.files[file] = '$EXACT_REVIEWED_CORRECTION';
    result.fileDetails[file] = { gitBlob: '$EXACT_REVIEWED_BLOB', mode: '100644', bytes: '$EXACT_REVIEWED_BYTES' };
  }
  return result;
}
function sizeLogHdCandidateDependencies(bytes) {
  const text = bytes.toString(), added = '\nfunction assertNoSupersededHdProcess(', closed = '\nexport function inspectHdClosedExecutionCache(';
  const prefixEnd = text.indexOf(text.includes(added) ? added : closed);
  const bindingsStart = text.indexOf('\nfunction bindings('), bindingsEnd = text.indexOf('\nexport function readHdStorageProtection(', bindingsStart);
  const candidateStart = text.indexOf('\nconst SOURCE_HELPERS = ');
  assert.ok(prefixEnd > 0 && bindingsStart > prefixEnd && bindingsEnd > bindingsStart && candidateStart > bindingsEnd,
    'Prior HD candidate dependency declarations are missing');
  return { prefix: text.slice(0, prefixEnd), bindings: text.slice(bindingsStart, bindingsEnd), candidate: text.slice(candidateStart) };
}
function nativeTasks(m, reference) {
  return [
    ['release-protection-engineering.mjs', []],
    ['guard-recovery-engineering.mjs', []],
    ['candidate-reuse-engineering.mjs', []],
    ['retired-hd-cache-engineering.mjs', []],
    ['hd-closed-cache-engineering.mjs', [reference, m.hdRoot + '/.runs/' + MV_DIRECT.closedCacheReference + '/tsx-1004',
      m.hdRoot + '/.runs/0208f07e63d8493327c22864a73973c8730ef21b48510be1302a1d1174a865c3.f27b0cf8-8156-4500-b195-2105d3f4173c/tsx-1004']],
    ['cutover-driver-engineering.mjs', []],
    ['cutover-safety-engineering.mjs', []],
    ['hd-storage-preflight-engineering.mjs', [m.live.web.root]],
    ['certificate-engineering.mjs', [m.stage + '/fix01-release']],
    ['usage-role-engineering.mjs', []],
    ['preflight-resume-engineering.mjs', []],
    ['normal-continuation-engineering.mjs', []],
    ['candidate-lifecycle-engineering.mjs', []],
    ['deployed-usage-schema-engineering.mjs', []],
    ['runtime-source-engineering.mjs', [m.stage + '/manifest.json']],
    ['canvas-batch-schema-engineering.mjs', [m.stage + '/manifest.json']],
    ['multiview-works-engineering.mjs', []],
  ];
}
function sizeLogApplicationFile(file, root, uid, maximum = 32 * 1024 * 1024, allowEmpty = false) {
  assert.ok(path.isAbsolute(file) && file.startsWith(root + '/'));
  assert.equal(fs.realpathSync(file), file);
  const before = fs.lstatSync(file);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.uid === uid
    && !(before.mode & 0o022) && (allowEmpty || before.size > 0) && before.size <= maximum, 'Untrusted application source/compiler: ' + file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const identity = value => Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'gid', 'mode', 'nlink'].map(key => [key, value[key]]));
    assert.deepEqual(identity(fs.fstatSync(fd)), identity(before));
    const bytes = fs.readFileSync(fd);
    assert.deepEqual(identity(fs.fstatSync(fd)), identity(before));
    assert.deepEqual(identity(fs.lstatSync(file)), identity(before));
    return bytes;
  } finally { fs.closeSync(fd); }
}
function sizeLogRuntimeFile(input, cutoff, owners, system = false) {
  assert.ok(path.isAbsolute(input));
  const file = fs.realpathSync(input), before = fs.lstatSync(file);
  assert.ok(before.isFile() && !before.isSymbolicLink() && owners.includes(before.uid)
    && !(before.mode & 0o022) && before.ctimeMs < cutoff, 'Runtime dependency lacks unchanged pre-batch ownership/time evidence: ' + file);
  const identity = value => Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'gid', 'mode', 'nlink'].map(key => [key, value[key]]));
  let bytes;
  if (system) {
    assert.equal(before.uid, 0);
    assert.ok(Number.isSafeInteger(before.nlink) && before.nlink > 0 && before.size > 0 && before.size <= 512 * 1024 * 1024);
    const inputIdentity = identity(fs.lstatSync(input)), parents = new Map();
    assert.equal(inputIdentity.uid, 0, 'System alias is not root-owned');
    for (const initial of [path.dirname(input), path.dirname(file)]) for (let directory = initial;; directory = path.dirname(directory)) {
      const real = fs.realpathSync(directory), stat = fs.lstatSync(real);
      assert.ok(stat.isDirectory() && stat.uid === 0 && !(stat.mode & 0o022), 'Unsafe system dependency parent');
      const alias = fs.lstatSync(directory);
      assert.equal(alias.uid, 0, 'System parent alias is not root-owned');
      parents.set(directory, { real, identity: identity(stat), pathIdentity: identity(alias) });
      if (directory === '/') break;
    }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      assert.deepEqual(identity(fs.fstatSync(fd)), identity(before));
      bytes = fs.readFileSync(fd);
      assert.equal(bytes.length, before.size);
      assert.deepEqual(identity(fs.fstatSync(fd)), identity(before));
    } finally { fs.closeSync(fd); }
    assert.equal(fs.realpathSync(input), file, 'System alias changed while reading');
    assert.deepEqual(identity(fs.lstatSync(input)), inputIdentity);
    for (const [directory, parent] of parents) {
      assert.equal(fs.realpathSync(directory), parent.real);
      assert.deepEqual(identity(fs.lstatSync(parent.real)), parent.identity);
      assert.deepEqual(identity(fs.lstatSync(directory)), parent.pathIdentity);
    }
  } else {
    assert.equal(input, file, 'Application dependency alias refused');
    bytes = sizeLogApplicationFile(file, path.dirname(file), before.uid);
  }
  assert.deepEqual(identity(fs.lstatSync(file)), identity(before));
  return { input, file, category: system ? 'system' : 'application', observedSha256: sha(bytes), ...identity(before),
    proof: 'current-observation-with-ctime-predating-original-batch' };
}
function sizeLogOriginalCheckpoint(m) {
  assert.ok(sizeLogReuseEligible(m), 'This checkpoint is limited to the approved protected increment');
  assert.deepEqual(JSON.parse(rootFile(m.stage + '/manifest.json')), m, 'Current locked manifest changed');
  assert.equal(m.runId, MV_DIRECT.recoveryRunId);
  assert.equal(m.normalContinuation || null, null); assert.equal(m.reuseBuilds || null, null);
  const stage = m.projectRoot + '/release-staging/' + SIZE_LOG_ORIGINAL.runId;
  const manifestBytes = rootFile(stage + '/manifest.json'); assert.equal(sha(manifestBytes), SIZE_LOG_ORIGINAL.manifestSha256);
  const original = JSON.parse(manifestBytes);
  assert.equal(original.runId, SIZE_LOG_ORIGINAL.runId); assert.equal(original.stage, stage);
  assert.deepEqual(normalizedSizeLogManifest(m), normalizedSizeLogManifest(original), 'Protected increment manifest contract drift');
  assert.deepEqual(Object.keys(m.privateSha256).sort(), Object.keys(original.privateSha256).sort(), 'Private file set drift');
  const privateFiles = {};
  for (const file of Object.keys(m.privateSha256).sort()) {
    assert.ok(path.basename(file) === file && file.endsWith('.mjs'));
    const oldBytes = rootFile(stage + '/fix01-release/' + file), newBytes = rootFile(engineDirectory(m) + '/' + file);
    assert.equal(sha(oldBytes), original.privateSha256[file]); assert.equal(sha(newBytes), m.privateSha256[file]);
    privateFiles[file] = { original: sha(oldBytes), current: sha(newBytes) };
    if (Object.hasOwn(SIZE_LOG_HD, file)) assert.equal(sha(newBytes), SIZE_LOG_HD[file]);
    else if (file === 'release-contract.mjs') assert.deepEqual(releaseContractParts(newBytes, m), releaseContractParts(oldBytes, original), 'Generated release contract widened');
    else if (!['control-preflight.mjs', 'preflight-resume-engineering.mjs'].includes(file)) assert.deepEqual(newBytes, oldBytes, 'Unapproved private delta: ' + file);
  }
  const oldController = rootFile(stage + '/fix01-release/control-preflight.mjs').toString();
  const oldStart = oldController.indexOf('for (const [file, args] of [') + 'for (const [file, args] of '.length;
  const oldEnd = oldController.indexOf('\n  ]) {', oldStart) + '\n  ]'.length;
  const taskText = nativeTasks.toString(), newStart = taskText.indexOf('return [') + 'return '.length;
  const newEnd = taskText.indexOf('\n  ];', newStart) + '\n  ]'.length;
  assert.ok(oldStart >= 25 && oldEnd > oldStart && newStart >= 7 && newEnd > newStart);
  assert.equal(taskText.slice(newStart, newEnd), oldController.slice(oldStart, oldEnd), 'Native task argv projection changed');
  const sources = {};
  for (const kind of ['main', 'guard']) {
    const oldSourceBytes = rootFile(original[kind].sourceManifest), newSourceBytes = rootFile(m[kind].sourceManifest);
    assert.equal(sha(oldSourceBytes), kind === 'main'
      ? '79ba38c50c6531a8965793bb065f999167a130bd575687327e5738b9ee2b0101'
      : '631dde9de8a191e77393b3fa2b0fe2fdb543c17a099f887a2bc650ab8c19c73b', 'Original source manifest changed');
    const oldSource = JSON.parse(oldSourceBytes), newSource = JSON.parse(newSourceBytes);
    assert.deepEqual(normalizedSizeLogSource(newSource, kind, m), normalizedSizeLogSource(oldSource, kind, original), 'Unapproved source delta: ' + kind);
    assert.equal(sha(rootFile(original[kind].archive, 512 * 1024 * 1024)), oldSource.archiveSha256);
    assert.equal(sha(rootFile(m[kind].archive, 512 * 1024 * 1024)), newSource.archiveSha256);
    sources[kind] = { originalManifestSha256: sha(oldSourceBytes), currentManifestSha256: sha(newSourceBytes),
      originalArchiveSha256: oldSource.archiveSha256, currentArchiveSha256: newSource.archiveSha256 };
  }
  const batchBytes = rootFile(stage + '/native-control-preflight/batch.json');
  assert.equal(sha(batchBytes), SIZE_LOG_ORIGINAL.batchSha256);
  const batch = assertOriginalNativeBatch(original, JSON.parse(batchBytes));
  const cutoff = Date.parse(batch.startedAt), runtime = sizeLogRuntimeFile(process.execPath, cutoff, [0], true), executable = runtime.file;
  assert.equal(fs.realpathSync('/proc/' + m.live.web.pid + '/exe'), executable, 'Runtime differs from the bound original live process');
  const sourceFiles = ['scripts/process-hd-image.ts', 'src/lib/media/hd-image-processor.ts', 'src/lib/media/hd-encoder.ts',
    'node_modules/tsx/dist/index-7AaEi15b.mjs', 'tsconfig.json'];
  const applicationUid = Number(call('id', ['-u', m.appUser]));
  assert.ok(Number.isSafeInteger(applicationUid) && applicationUid > 0);
  const compilerProof = Object.fromEntries(sourceFiles.map(file => [file,
    sha(sizeLogApplicationFile(m.live.hd.root + '/' + file, m.live.hd.root, applicationUid))]));
  assertHdE01CacheSourceProof(compilerProof);
  const python = JSON.parse(call('python3', ['-I', '-c',
    "import sys,os,json,sqlite3,_sqlite3; libraries=sorted(set(os.path.realpath(line.split()[-1]) for line in open('/proc/self/maps') if '/libsqlite3.so' in line)); print(json.dumps({'python':os.path.realpath(sys.executable),'wrapper':os.path.realpath(sqlite3.__file__),'extension':os.path.realpath(_sqlite3.__file__),'libraries':libraries,'sqliteVersion':sqlite3.sqlite_version}))"]));
  assert.deepEqual(Object.keys(python).sort(), ['extension', 'libraries', 'python', 'sqliteVersion', 'wrapper']);
  assert.ok(Array.isArray(python.libraries) && python.libraries.length === 1);
  assert.match(python.sqliteVersion, /^\d+\.\d+\.\d+$/);
  const pythonSqlite = { sqliteVersion: python.sqliteVersion,
    files: [python.python, python.wrapper, python.extension, ...python.libraries].map(file => sizeLogRuntimeFile(file, cutoff, [0], true)) };
  const typescriptResolved = createRequire(m.live.web.root + '/package.json').resolve('typescript');
  const typescript = { resolved: typescriptResolved, ...sizeLogRuntimeFile(typescriptResolved, cutoff, [0, applicationUid]) };
  const proof = { schema: 'sd2-size-log-native-origin.v1', ...SIZE_LOG_ORIGINAL, stage, privateFiles, sources, compilerProof,
    runtime, pythonSqlite, typescript };
  // The R04 aggregate remains failed. Only these three independently complete,
  // explicitly pinned successful leaves may be referenced; no recursive batch adoption.
  assert.notEqual(m.runId, SIZE_LOG_PRIOR.runId);
  const priorStage = m.projectRoot + '/release-staging/' + SIZE_LOG_PRIOR.runId;
  const priorBytes = rootFile(priorStage + '/manifest.json'); assert.equal(sha(priorBytes), SIZE_LOG_PRIOR.manifestSha256);
  const prior = JSON.parse(priorBytes);
  assert.equal(prior.runId, SIZE_LOG_PRIOR.runId); assert.equal(prior.stage, priorStage);
  assert.deepEqual(normalizedSizeLogManifest(m), normalizedSizeLogManifest(prior), 'Prior successful-leaf manifest input drift');
  assert.deepEqual(Object.keys(m.privateSha256).sort(), Object.keys(prior.privateSha256).sort());
  for (const file of Object.keys(m.privateSha256).sort()) {
    const oldBytes = rootFile(priorStage + '/fix01-release/' + file), newBytes = rootFile(engineDirectory(m) + '/' + file);
    assert.equal(sha(oldBytes), prior.privateSha256[file]);
    if (file === 'hd-storage-preflight.mjs') assert.deepEqual(sizeLogHdCandidateDependencies(newBytes),
      sizeLogHdCandidateDependencies(oldBytes), 'Prior successful-leaf HD candidate/wait dependency drift');
    else if (Object.hasOwn(SIZE_LOG_HD, file)) assert.equal(sha(newBytes), SIZE_LOG_HD[file]);
    else if (file === 'release-contract.mjs') assert.deepEqual(releaseContractParts(newBytes, m), releaseContractParts(oldBytes, prior));
    else if (!['control-preflight.mjs', 'preflight-resume-engineering.mjs'].includes(file)) assert.deepEqual(newBytes, oldBytes, 'Prior successful-leaf dependency drift: ' + file);
  }
  const priorController = rootFile(priorStage + '/fix01-release/control-preflight.mjs').toString();
  const tasksStart = priorController.indexOf('function nativeTasks(m, reference) {');
  const tasksEnd = priorController.indexOf('\nfunction sizeLogApplicationFile(', tasksStart);
  assert.ok(tasksStart >= 0 && tasksEnd > tasksStart);
  assert.equal(priorController.slice(tasksStart, tasksEnd).trim(), nativeTasks.toString(), 'Prior successful-leaf argv drift');
  const priorSources = {};
  for (const kind of ['main', 'guard']) {
    const bytes = rootFile(prior[kind].sourceManifest); assert.equal(sha(bytes), SIZE_LOG_PRIOR.sourceManifests[kind]);
    const source = JSON.parse(bytes), current = JSON.parse(rootFile(m[kind].sourceManifest));
    assert.deepEqual(normalizedSizeLogSource(source, kind, prior), normalizedSizeLogSource(current, kind, m), 'Prior successful-leaf source input drift');
    assert.equal(sha(rootFile(prior[kind].archive, 512 * 1024 * 1024)), source.archiveSha256);
    priorSources[kind] = { manifestSha256: sha(bytes), archiveSha256: source.archiveSha256 };
  }
  const priorBatchBytes = rootFile(priorStage + '/native-control-preflight/batch.json');
  assert.equal(sha(priorBatchBytes), SIZE_LOG_PRIOR.failedBatchSha256);
  const failed = JSON.parse(priorBatchBytes);
  assert.equal(failed.runId, prior.runId); assert.equal(failed.manifestSha256, SIZE_LOG_PRIOR.manifestSha256);
  assert.equal(failed.completed, false); assert.deepEqual(failed.outcomes.map(item => item.file), NATIVE_FILES);
  assert.deepEqual(failed.outcomes.filter(item => item.status !== 0).map(item => item.file), ['preflight-resume-engineering.mjs']);
  for (const field of ['compilerProof', 'runtime', 'pythonSqlite', 'typescript'])
    assert.deepEqual(failed.reusedOriginal[field], proof[field], 'Prior successful-leaf runtime dependency drift: ' + field);
  const leaves = {};
  for (const file of SIZE_LOG_PRIOR_LEAVES) {
    const expected = SIZE_LOG_PRIOR.receipts[file];
    const bytes = rootFile(atomicReceiptFile(prior, file), 64 * 1024 * 1024); assert.equal(sha(bytes), expected);
    const receipt = JSON.parse(bytes), outcome = outcomeFromAtomicReceipt(prior, receipt, expected);
    assertAtomicOutcome(prior, outcome);
    assert.equal(outcome.status, 0); assert.equal(outcome.signal, null); assert.equal(outcome.error, null); assert.equal(outcome.errorCode, null);
    assert.deepEqual(failed.outcomes.find(item => item.file === file), { ...outcome, execution: 'executed' });
    leaves[file] = outcome;
  }
  proof.priorSuccessfulLeaves = { ...SIZE_LOG_PRIOR,
    receipts: Object.fromEntries(SIZE_LOG_PRIOR_LEAVES.map(file => [file, SIZE_LOG_PRIOR.receipts[file]])),
    failedAggregateRetained: true, failedAggregateAdopted: false, sources: priorSources };
  // R06 contributes only its original successful HD atomic leaf, never its
  // completed native aggregate or its failed outer control preflight.
  assert.notEqual(m.runId, SIZE_LOG_HD_CLOSED_ORIGIN.runId);
  const hdClosedStage = m.projectRoot + '/release-staging/' + SIZE_LOG_HD_CLOSED_ORIGIN.runId;
  const hdClosedBytes = rootFile(hdClosedStage + '/manifest.json');
  assert.equal(sha(hdClosedBytes), SIZE_LOG_HD_CLOSED_ORIGIN.manifestSha256);
  const hdClosed = JSON.parse(hdClosedBytes);
  assert.equal(hdClosed.runId, SIZE_LOG_HD_CLOSED_ORIGIN.runId); assert.equal(hdClosed.stage, hdClosedStage);
  assert.equal(hdClosed.mainSource, SIZE_LOG_HD_CLOSED_ORIGIN.mainSource); assert.equal(hdClosed.guardSource, SIZE_LOG_HD_CLOSED_ORIGIN.guardSource);
  assert.deepEqual(normalizedSizeLogManifest(m), normalizedSizeLogManifest(hdClosed), 'R06 HD leaf manifest input drift');
  assert.deepEqual(Object.keys(m.privateSha256).sort(), Object.keys(hdClosed.privateSha256).sort());
  for (const file of Object.keys(m.privateSha256).sort()) {
    const oldBytes = rootFile(hdClosedStage + '/fix01-release/' + file), newBytes = rootFile(engineDirectory(m) + '/' + file);
    assert.equal(sha(oldBytes), hdClosed.privateSha256[file]);
    if (file === 'hd-storage-preflight.mjs') {
      const oldText = oldBytes.toString(), newText = newBytes.toString();
      const oldEnd = oldText.indexOf('\nfunction inventory('), newEnd = newText.indexOf('\nfunction createProtectedDiscoveryContinuation(');
      assert.ok(oldEnd > 0 && newEnd > 0);
      assert.equal(newText.slice(0, newEnd), oldText.slice(0, oldEnd), 'R06 HD closed-cache full dependency prefix drift');
    } else if (file === 'release-contract.mjs') assert.deepEqual(releaseContractParts(newBytes, m), releaseContractParts(oldBytes, hdClosed));
    else if (file === 'hd-storage-preflight-engineering.mjs') assert.equal(sha(newBytes), SIZE_LOG_HD[file]);
    else if (!['control-preflight.mjs', 'preflight-resume-engineering.mjs'].includes(file))
      assert.deepEqual(newBytes, oldBytes, 'R06 HD leaf dependency drift: ' + file);
  }
  const hdController = rootFile(hdClosedStage + '/fix01-release/control-preflight.mjs').toString();
  const hdTasksStart = hdController.indexOf('function nativeTasks(m, reference) {'), hdTasksEnd = hdController.indexOf('\nfunction sizeLogApplicationFile(', hdTasksStart);
  assert.ok(hdTasksStart >= 0 && hdTasksEnd > hdTasksStart);
  assert.equal(hdController.slice(hdTasksStart, hdTasksEnd).trim(), nativeTasks.toString(), 'R06 HD leaf argv drift');
  const hdSources = {};
  for (const kind of ['main', 'guard']) {
    const bytes = rootFile(hdClosed[kind].sourceManifest); assert.equal(sha(bytes), SIZE_LOG_HD_CLOSED_ORIGIN.sourceManifests[kind]);
    const source = JSON.parse(bytes), current = JSON.parse(rootFile(m[kind].sourceManifest));
    assert.deepEqual(normalizedSizeLogSource(source, kind, hdClosed), normalizedSizeLogSource(current, kind, m), 'R06 HD leaf source input drift');
    assert.equal(sha(rootFile(hdClosed[kind].archive, 512 * 1024 * 1024)), source.archiveSha256);
    hdSources[kind] = { manifestSha256: sha(bytes), archiveSha256: source.archiveSha256 };
  }
  const hdBatchBytes = rootFile(hdClosedStage + '/native-control-preflight/batch.json');
  assert.equal(sha(hdBatchBytes), SIZE_LOG_HD_CLOSED_ORIGIN.batchSha256);
  const hdBatch = JSON.parse(hdBatchBytes);
  assert.equal(hdBatch.schema, 'sd2-native-control-batch.v1'); assert.equal(hdBatch.runId, hdClosed.runId);
  assert.equal(hdBatch.manifestSha256, SIZE_LOG_HD_CLOSED_ORIGIN.manifestSha256); assert.equal(hdBatch.completed, true);
  assert.deepEqual(hdBatch.privateSha256, hdClosed.privateSha256); assert.deepEqual(hdBatch.outcomes.map(item => item.file), NATIVE_FILES);
  assert.equal(hdBatch.servicesChanged, false); assert.equal(hdBatch.productionWrites, 0);
  assert.ok(Number.isFinite(Date.parse(hdBatch.startedAt)) && Date.parse(hdBatch.startedAt) <= Date.parse(hdBatch.finishedAt)
    && Date.parse(hdBatch.finishedAt) <= Date.now());
  for (const field of ['compilerProof', 'runtime', 'pythonSqlite', 'typescript'])
    assert.deepEqual(hdBatch.reusedOriginal[field], proof[field], 'R06 HD leaf runtime dependency drift: ' + field);
  const hdAtomic = rootFile(atomicReceiptFile(hdClosed, SIZE_LOG_HD_CLOSED_ORIGIN.file), 64 * 1024 * 1024);
  assert.equal(sha(hdAtomic), SIZE_LOG_HD_CLOSED_ORIGIN.receiptSha256);
  const hdClosedOutcome = outcomeFromAtomicReceipt(hdClosed, JSON.parse(hdAtomic), sha(hdAtomic));
  assertAtomicOutcome(hdClosed, hdClosedOutcome);
  assert.equal(hdClosedOutcome.status, 0); assert.equal(hdClosedOutcome.signal, null); assert.equal(hdClosedOutcome.error, null); assert.equal(hdClosedOutcome.errorCode, null);
  assert.equal(hdClosedOutcome.sha256, SIZE_LOG_HD_CLOSED_ORIGIN.logSha256);
  assert.ok(Date.parse(hdClosedOutcome.startedAt) >= Date.parse(hdBatch.startedAt) && Date.parse(hdClosedOutcome.finishedAt) <= Date.parse(hdBatch.finishedAt));
  assert.deepEqual(hdBatch.outcomes.find(item => item.file === SIZE_LOG_HD_CLOSED_ORIGIN.file), { ...hdClosedOutcome, execution: 'executed' });
  proof.hdClosedLeaf = { ...SIZE_LOG_HD_CLOSED_ORIGIN, sources: hdSources, nativeBatchCompleted: true, aggregateAdopted: false, outerPreflightAdopted: false };
  // R08 supplies one independently complete storage leaf only. Its failed
  // product build and its reused native outcomes are never recursively adopted.
  const storageStage = m.projectRoot + '/release-staging/' + SIZE_LOG_STORAGE_ORIGIN.runId;
  const storageBytes = rootFile(storageStage + '/manifest.json');
  assert.equal(sha(storageBytes), SIZE_LOG_STORAGE_ORIGIN.manifestSha256);
  const storage = JSON.parse(storageBytes);
  assert.notEqual(m.runId, storage.runId); assert.equal(storage.runId, SIZE_LOG_STORAGE_ORIGIN.runId);
  assert.equal(storage.stage, storageStage);
  assert.deepEqual(normalizedSizeLogManifest(m), normalizedSizeLogManifest(storage), 'R08 storage manifest input drift');
  assert.deepEqual(Object.keys(m.privateSha256).sort(), Object.keys(storage.privateSha256).sort());
  for (const file of Object.keys(m.privateSha256).sort()) {
    const oldBytes = rootFile(storageStage + '/fix01-release/' + file), newBytes = rootFile(engineDirectory(m) + '/' + file);
    assert.equal(sha(oldBytes), storage.privateSha256[file]);
    if (file === 'release-contract.mjs') assert.deepEqual(releaseContractParts(newBytes, m), releaseContractParts(oldBytes, storage));
    else if (!['control-preflight.mjs', 'preflight-resume-engineering.mjs'].includes(file))
      assert.deepEqual(newBytes, oldBytes, 'R08 storage execution dependency drift: ' + file);
  }
  const storageController = rootFile(storageStage + '/fix01-release/control-preflight.mjs').toString();
  const storageTaskStart = storageController.indexOf('function nativeTasks(m, reference) {');
  const storageTaskEnd = storageController.indexOf('\nfunction sizeLogApplicationFile(', storageTaskStart);
  assert.ok(storageTaskStart >= 0 && storageTaskEnd > storageTaskStart);
  assert.equal(storageController.slice(storageTaskStart, storageTaskEnd).trim(), nativeTasks.toString(), 'R08 storage argv drift');
  const storageBatchBytes = rootFile(storageStage + '/native-control-preflight/batch.json');
  assert.equal(sha(storageBatchBytes), SIZE_LOG_STORAGE_ORIGIN.batchSha256);
  const storageBatch = JSON.parse(storageBatchBytes);
  assert.equal(storageBatch.runId, storage.runId); assert.equal(storageBatch.manifestSha256, SIZE_LOG_STORAGE_ORIGIN.manifestSha256);
  assert.deepEqual(storageBatch.privateSha256, storage.privateSha256);
  for (const field of ['compilerProof', 'runtime', 'pythonSqlite', 'typescript'])
    assert.deepEqual(storageBatch.reusedOriginal[field], proof[field], 'R08 storage runtime dependency drift: ' + field);
  const storageAtomic = rootFile(atomicReceiptFile(storage, SIZE_LOG_STORAGE_ORIGIN.file), 64 * 1024 * 1024);
  assert.equal(sha(storageAtomic), SIZE_LOG_STORAGE_ORIGIN.receiptSha256);
  const storageOutcome = outcomeFromAtomicReceipt(storage, JSON.parse(storageAtomic), sha(storageAtomic));
  const storageReceipt = assertAtomicOutcome(storage, storageOutcome);
  assert.equal(storageOutcome.status, 0); assert.equal(storageOutcome.signal, null);
  assert.equal(storageOutcome.error, null); assert.equal(storageOutcome.errorCode, null);
  assert.equal(storageOutcome.sha256, SIZE_LOG_STORAGE_ORIGIN.logSha256);
  assert.deepEqual(storageBatch.outcomes.find(item => item.file === SIZE_LOG_STORAGE_ORIGIN.file), { ...storageOutcome, execution: 'executed' });
  const storageResult = JSON.parse(storageReceipt.stdout.trim());
  assert.equal(storageResult.schema, 'hd-storage-preflight-engineering-v1'); assert.equal(storageResult.completed, true);
  assert.equal(storageResult.total, 71); assert.equal(storageResult.passed, 71);
  assert.equal(storageResult.helperSha256, m.privateSha256['hd-storage-preflight.mjs']);
  assert.equal(storageResult.legacyAllowlistSha256, m.privateSha256['hd-legacy-ready-allowlist.mjs']);
  for (const field of ['productionWrites', 'networkRequests', 'providerRequests', 'serviceChanges', 'releasesSwitched']) assert.equal(storageResult[field], 0);
  proof.storageLeaf = { ...SIZE_LOG_STORAGE_ORIGIN, aggregateAdopted: false, productBuildAdopted: false,
    candidateArchivesAreNotLeafExecutionInputs: true, liveRoot: storage.live.web.root };
  return { original, batch, proof, prior, leaves, hdClosed, hdClosedOutcome, storage, storageOutcome };
}
function reusedSizeLogOutcome(checkpoint, item) {
  const storage = item.file === SIZE_LOG_STORAGE_ORIGIN.file, hdClosed = item.file === SIZE_LOG_HD_CLOSED_ORIGIN.file, prior = checkpoint.leaves[item.file];
  const origin = storage ? checkpoint.storage : hdClosed ? checkpoint.hdClosed : prior ? checkpoint.prior : checkpoint.original;
  const outcome = storage ? checkpoint.storageOutcome : hdClosed ? checkpoint.hdClosedOutcome : prior || item, stage = origin.stage;
  return { ...outcome, execution: 'reused', original: { runId: origin.runId, stage,
    manifestSha256: storage ? SIZE_LOG_STORAGE_ORIGIN.manifestSha256 : hdClosed ? SIZE_LOG_HD_CLOSED_ORIGIN.manifestSha256 : prior ? SIZE_LOG_PRIOR.manifestSha256 : SIZE_LOG_ORIGINAL.manifestSha256,
    ...(storage ? { batchSha256: SIZE_LOG_STORAGE_ORIGIN.batchSha256, aggregateAdopted: false, productBuildAdopted: false }
      : hdClosed ? { batchSha256: SIZE_LOG_HD_CLOSED_ORIGIN.batchSha256, aggregateAdopted: false, outerPreflightAdopted: false }
      : prior ? { failedAggregateSha256: SIZE_LOG_PRIOR.failedBatchSha256, aggregateAdopted: false }
      : { batchSha256: SIZE_LOG_ORIGINAL.batchSha256 }),
    receipt: atomicReceiptFile(origin, item.file), receiptSha256: outcome.receiptSha256,
    log: stage + '/native-control-preflight/' + item.file + '.log', logSha256: outcome.sha256 } };
}

function sharedNativeTasks(m, reference) {
  engineDirectory(m); assert.equal(isSharedEngine(m), true);
  const original = MV_DIRECT.immutableOriginalManifest;
  if (original !== undefined) {
    assert.equal(path.resolve(original), original);
    assert.match(original, new RegExp('^' + m.projectRoot + '/release-staging/[a-f0-9-]{36}/manifest\\.json$'));
  }
  return [...nativeTasks(m, reference).map(([file, args]) => [file,
    file === 'certificate-engineering.mjs' ? [engineDirectory(m)]
      : file === 'candidate-reuse-engineering.mjs' && original ? ['--immutable-original-manifest', original] : args]),
  ['attempt-state-engineering.mjs', []], ['release-entry-engineering.mjs', []]];
}
function sharedNativeContext(m, equivalentEngine = null) {
  const file = m.stage + '/context.json', bytes = rootFile(file, 256 * 1024), value = JSON.parse(bytes);
  assert.equal(value.schema, 'sd2-release-context.v1'); assert.deepEqual(value.contract.engine, m.engine);
  assert.deepEqual(value.contract.operation, m.operation);
  assert.equal(value.contract.recoveryRunId, m.runId);
  const projection = structuredClone(value);
  projection.contract.operation.attemptId = '$ATTEMPT'; projection.contract.recoveryRunId = '$ATTEMPT';
  if (value.contract.batchFile !== undefined) {
    assert.equal(path.dirname(value.contract.batchFile), m.stage);
    assert.equal(path.resolve(value.contract.batchFile), value.contract.batchFile);
    projection.contract.batchFile = '$ATTEMPT_BATCH';
  }
  if (value.contract.batchSha256 !== undefined) {
    assert.ok(value.contract.batchFile);
    assert.equal(sha(rootFile(value.contract.batchFile)), value.contract.batchSha256);
    projection.contract.batchSha256 = '$ATTEMPT_BATCH_SHA';
  }
  if (equivalentEngine) projection.contract.engine = equivalentEngine;
  return { file, sha256: sha(bytes), projectionSha256: sha(JSON.stringify(projection)) };
}
function dependencyBoundary(file, category, code, action) {
  try { return action(); } catch (cause) {
    if (cause?.releaseError) throw cause;
    const actualCategory = ['ENOENT', 'ENODATA'].includes(cause?.code) ? 'evidence_missing' : category;
    try {
      throwReleaseError({ category: actualCategory,
        code, object: { kind: 'application_dependency', id: file },
        reason: actualCategory === 'input_permanent' ? 'The dependency violates its sealed source, ownership, or permission contract.'
          : 'The exact dependency evidence is missing or changed during observation.',
        nextStep: 'Stop dependent work; inspect the preserved original exception and restore or recapture the exact trusted input before a new attempt.' }, { cause });
    } catch (error) {
      // Entry keeps String(error) in its private child evidence, not Error.cause.
      // Keep the fixed public classification separate from bounded private detail.
      error.message += '\nPrivate dependency cause: ' + String(cause).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 2000);
      throw error;
    }
  }
}
function dependencyIdentity(stat) {
  return Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, stat[key]]));
}
function dependencyGroup(appUser, uid) {
  return dependencyBoundary(appUser, 'input_permanent', 'dependency_group_rejected', () => {
    const gid = Number(call('id', ['-g', appUser])); assert.ok(Number.isSafeInteger(gid) && gid > 0);
    const group = call('getent', ['group', String(gid)]).split(':');
    assert.equal(group.length, 4); assert.equal(Number(group[2]), gid);
    const accounts = call('getent', ['passwd']).split('\n').map(line => line.split(':'));
    for (const row of accounts) assert.ok(row.length === 7 && Number.isSafeInteger(Number(row[2])) && Number.isSafeInteger(Number(row[3])));
    const primary = accounts.filter(row => Number(row[3]) === gid).map(row => ({ name: row[0], uid: Number(row[2]) })).sort((a, b) => a.name.localeCompare(b.name));
    assert.ok(primary.some(row => row.name === appUser && row.uid === uid));
    const members = group[3].split(',').filter(Boolean).sort().map(name => ({ name, uid: Number(call('id', ['-u', name])) }));
    assert.ok([...primary, ...members].every(row => row.uid === uid), 'Application dependency group has an additional writer');
    const sources = Object.fromEntries(['/etc/passwd', '/etc/group', '/etc/nsswitch.conf'].map(file => {
      const bytes = rootFile(file); return [file, { ...dependencyIdentity(fs.lstatSync(file)), sha256: sha(bytes) }];
    }));
    return { uid, gid, name: group[0], primary, members, sources };
  });
}
function dependencyAcl(root) {
  return dependencyBoundary(root, 'input_permanent', 'dependency_acl_rejected', () => {
    // One bounded metadata inventory per tree, not one subprocess per entry.
    const code = "import os,sys,json,stat\nroot=sys.argv[1];pending=[root];count=0;acl=[]\nwhile pending:\n p=pending.pop();count+=1\n if count>120000:raise ValueError('dependency ACL inventory exceeded bound')\n s=os.lstat(p)\n if any(n in ('system.posix_acl_access','system.posix_acl_default') for n in os.listxattr(p,follow_symlinks=False)):acl.append(os.path.relpath(p,root))\n if stat.S_ISDIR(s.st_mode):pending.extend(os.path.join(p,n) for n in os.listdir(p))\nprint(json.dumps({'count':count,'acl':sorted(acl)}))";
    const value = JSON.parse(call('/usr/bin/python3', ['-B', '-I', '-c', code, root]));
    assert.deepEqual(Object.keys(value).sort(), ['acl', 'count']); assert.ok(Number.isSafeInteger(value.count) && value.count > 0 && value.count <= 120000);
    assert.deepEqual(value.acl, [], 'Additional/default dependency ACL writers are not authorized'); return value;
  });
}
function sealedDependencyTrust(m, root, uid) {
  return dependencyBoundary(root, 'evidence_missing', 'dependency_seal_rejected', () => {
    const compiled = m.live.hd.sourceProof?.compiledCapsule, recovered = m.recoveredGuardBaseline, normal = m.normalContinuation;
    assert.ok(compiled || recovered || normal && m.reuseBuilds, 'No direct live baseline dependency seal was supplied');
    const runId = compiled?.sourceRun || recovered?.runId || normal.sourceRun;
    assert.match(runId, /^[a-f0-9-]{36}$/);
    const stage = m.projectRoot + '/release-staging/' + runId;
    const manifestFile = stage + '/manifest.json', manifestBytes = rootFile(manifestFile), original = JSON.parse(manifestBytes);
    assert.equal(original.runId, runId); assert.equal(original.stage, stage);
    const kind = compiled?.kind || (recovered ? 'guard' : ['main', 'guard'].find(label => original[label].root + '/node_modules' === root));
    assert.ok(['main', 'guard'].includes(kind)); const candidate = original[kind];
    assert.equal(candidate.root + '/node_modules', root); assert.equal(candidate.source, m.live.web.source);
    assert.equal(candidate.source, m.live.hd.source); assert.equal(original.appUser, m.appUser);
    const file = stage + '/' + kind + '-immutable-success.json', bytes = rootFile(file, 128 * 1024 * 1024), capsule = JSON.parse(bytes);
    if (compiled) { assert.equal(compiled.file, file); assert.equal(sha(bytes), compiled.sha256); assert.ok(capsule.originalReceipt.hdCompiledCache); }
    else if (recovered) { assert.equal(sha(manifestBytes), recovered.manifestSha256); assert.equal(sha(bytes), recovered.guardImmutableSuccessSha256); }
    else {
      assert.equal(m.reuseBuilds.sourceRun, normal.sourceRun); assert.equal(sha(manifestBytes), normal.sourceManifestSha256);
      assert.equal(m.reuseBuilds[kind].file, file); assert.equal(sha(bytes), m.reuseBuilds[kind].sha256);
    }
    assert.ok(call('lsattr', ['-d', '--', file]).split(/\s+/)[0].includes('i'));
    assert.equal(capsule.schema, 'sd2-immutable-successful-build.v1'); assert.equal(capsule.kind, kind); assert.equal(capsule.sourceRun, original.runId);
    assert.equal(capsule.originalManifestSha256, sha(manifestBytes));
    assert.equal(capsule.originalTimesChanged, false); assert.equal(capsule.newCompilationClaimed, false);
    assert.equal(capsule.originallyVerifiedWithinThirtyMinuteGate, true);
    assert.equal(capsule.originalReceiptFile, stage + '/' + kind + '-build.json');
    const receiptBytes = rootFile(capsule.originalReceiptFile);
    assert.equal(sha(receiptBytes), capsule.originalReceiptSha256); assert.deepEqual(JSON.parse(receiptBytes), capsule.originalReceipt);
    const receipt = capsule.originalReceipt; assert.equal(receipt.source, candidate.source); assert.equal(receipt.version, candidate.version); assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.schema, 'rate-impl2-candidate-build.v1'); assert.equal(receipt.verifiedSourceAndGates, true);
    assert.equal(receipt.runId, original.runId); assert.equal(receipt.label, kind); assert.equal(receipt.manifestSha256, sha(manifestBytes));
    assert.deepEqual(capsule.originalPrivateSha256, original.privateSha256);
    assert.ok(Number.isSafeInteger(receipt.startedAt) && receipt.startedAt < receipt.finishedAt && receipt.finishedAt < Date.now());
    if (m.live.hd.sourceProof) {
      assert.equal(candidate.sourceManifest, m.live.hd.sourceProof.sourceManifest); assert.equal(candidate.archive, m.live.hd.sourceProof.archive);
    }
    const sourceBytes = rootFile(candidate.sourceManifest), source = JSON.parse(sourceBytes);
    assert.equal(sha(sourceBytes), capsule.originalSourceManifestSha256); assert.equal(source.source, receipt.source);
    const lock = capsule.snapshot.lock; assert.deepEqual(lock, capsule.snapshot.sourceFiles['package-lock.json']);
    assert.equal(lock.sha256, source.files['package-lock.json']);
    assert.equal(sha(sizeLogApplicationFile(candidate.root + '/package-lock.json', candidate.root, uid)), lock.sha256);
    assert.deepEqual(dependencyIdentity(fs.lstatSync(candidate.root + '/package-lock.json')),
      Object.fromEntries(Object.entries(lock).filter(([key]) => key !== 'sha256')));
    const entries = capsule.snapshot.dependencies; assert.ok(entries && Object.keys(entries).length > 0 && Object.keys(entries).length <= 120000);
    const group = dependencyGroup(m.appUser, uid), acl = dependencyAcl(root);
    return { uid, gid: group.gid, entries, buildStartedAt: receipt.startedAt,
      sourceProof: { sourceManifest: candidate.sourceManifest, archive: candidate.archive },
      proof: { schema: 'sd2-sealed-application-dependencies.v1', manifest: { file: manifestFile, sha256: sha(manifestBytes) },
        capsule: { file, sha256: sha(bytes) }, receipt: { file: capsule.originalReceiptFile, sha256: sha(receiptBytes) },
        sourceManifest: { file: candidate.sourceManifest, sha256: sha(sourceBytes) }, lockSha256: lock.sha256,
        snapshotSha256: sha(JSON.stringify(entries)), group, acl } };
  });
}
function dependencyModeAllowed(stat, trust) {
  return stat.isSymbolicLink() || !(stat.mode & 0o002) && !(stat.mode & 0o7000)
    && (!(stat.mode & 0o020) || trust && stat.uid === trust.uid && stat.gid === trust.gid);
}
function readApplicationDependency(file, root, stat, expected) {
  dependencyBoundary(file, 'input_permanent', 'dependency_input_rejected', () => {
    assert.equal(fs.realpathSync(file), file); assert.ok(file.startsWith(root + '/'));
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size >= 0 && stat.size <= 512 * 1024 * 1024);
  });
  const identity = dependencyIdentity(stat), fd = dependencyBoundary(file, 'input_permanent', 'dependency_input_rejected', () =>
    fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW));
  let bytes;
  try {
    dependencyBoundary(file, 'evidence_missing', 'dependency_changed_during_observation', () => {
      assert.deepEqual(dependencyIdentity(fs.fstatSync(fd)), identity); bytes = fs.readFileSync(fd);
      assert.equal(bytes.length, stat.size); assert.deepEqual(dependencyIdentity(fs.fstatSync(fd)), identity);
      assert.deepEqual(dependencyIdentity(fs.lstatSync(file)), identity);
    });
  } finally { fs.closeSync(fd); }
  dependencyBoundary(file, 'input_permanent', 'dependency_bytes_unsealed', () => assert.equal(sha(bytes), expected.sha256));
  return bytes;
}
function sharedDependencyTree(root, owners, cutoff, trust = null) {
  dependencyBoundary(root, 'input_permanent', 'dependency_input_rejected', () => assert.equal(fs.realpathSync(root), root));
  const entries = {}; let count = 0, latestCtimeMs = 0;
  const visit = file => {
    dependencyBoundary(root, 'input_permanent', 'dependency_inventory_unbounded', () => assert.ok(++count <= 120000));
    const stat = dependencyBoundary(file, 'evidence_missing', 'dependency_changed_during_observation', () => fs.lstatSync(file));
    latestCtimeMs = Math.max(latestCtimeMs, stat.ctimeMs);
    dependencyBoundary(file, 'input_permanent', 'dependency_input_rejected', () => {
      assert.ok(owners.includes(stat.uid) && dependencyModeAllowed(stat, trust), 'Native dependency owner/mode rejected');
      if (stat.isFile()) assert.ok(stat.nlink === 1 && stat.size >= 0 && stat.size <= 512 * 1024 * 1024);
    });
    dependencyBoundary(file, 'evidence_missing', 'dependency_changed_during_observation', () => assert.ok(stat.ctimeMs < cutoff));
    const identity = dependencyIdentity(stat), relative = path.relative(root, file) || '.', expected = trust?.entries[relative];
    if (trust) dependencyBoundary(file, 'evidence_missing', 'dependency_snapshot_mismatch', () => {
      assert.ok(expected && expected.ctimeMs <= trust.buildStartedAt, 'Dependency is absent from the original successful build');
      assert.deepEqual(identity, Object.fromEntries(Object.entries(expected).filter(([key]) => !['sha256', 'link'].includes(key))));
    });
    if (stat.isSymbolicLink()) {
      dependencyBoundary(file, 'input_permanent', 'dependency_alias_rejected', () =>
        assert.ok(fs.realpathSync(file).startsWith(root + '/'), 'Native dependency alias escapes its input tree'));
      identity.link = fs.readlinkSync(file);
    } else if (stat.isFile()) {
      identity.sha256 = sha(trust ? readApplicationDependency(file, root, stat, expected)
        : sizeLogApplicationFile(file, root, stat.uid, 512 * 1024 * 1024, true));
    } else dependencyBoundary(file, 'input_permanent', 'dependency_type_rejected', () => assert.ok(stat.isDirectory()));
    if (trust) dependencyBoundary(file, 'input_permanent', 'dependency_source_mismatch', () => assert.deepEqual(identity, expected));
    entries[relative] = identity;
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
    dependencyBoundary(file, 'evidence_missing', 'dependency_changed_during_observation', () =>
      assert.deepEqual(dependencyIdentity(fs.lstatSync(file)), dependencyIdentity(stat)));
  };
  visit(root);
  if (trust) dependencyBoundary(root, 'evidence_missing', 'dependency_snapshot_mismatch', () => {
    assert.deepEqual(Object.keys(entries).sort(), Object.keys(trust.entries).sort());
    assert.equal(count, trust.proof.acl.count);
  });
  return { root, count, latestCtimeMs, sha256: sha(JSON.stringify(entries)), ...(trust ? { sealedSource: trust.proof } : {}) };
}
function latestDependencyChange(value) {
  if (!value || typeof value !== 'object') return 0;
  return Math.max(value.ctimeMs || 0, value.latestCtimeMs || 0, ...Object.values(value).map(latestDependencyChange));
}
function sharedControlDependencies(m, cutoff) {
  const directory = engineDirectory(m);
  assert.deepEqual(fs.readdirSync(directory).filter(file => file.endsWith('.mjs')).sort(), Object.keys(m.privateSha256).sort());
  for (const [file, digest] of Object.entries(m.privateSha256)) {
    assert.equal(path.basename(file), file); assert.equal(sha(rootFile(directory + '/' + file)), digest);
  }
  const applicationUid = Number(call('id', ['-u', m.appUser])); assert.ok(Number.isSafeInteger(applicationUid) && applicationUid > 0);
  const owners = [0, applicationUid], runtime = sizeLogRuntimeFile(process.execPath, cutoff, [0], true);
  const pythonCode = "import sys,os,json,sqlite3,_sqlite3; libraries=sorted(set(os.path.realpath(line.split()[-1]) for line in open('/proc/self/maps') if '/libsqlite3.so' in line)); print(json.dumps({'python':os.path.realpath(sys.executable),'wrapper':os.path.realpath(sqlite3.__file__),'extension':os.path.realpath(_sqlite3.__file__),'libraries':libraries,'sqliteVersion':sqlite3.sqlite_version}))";
  const pythonSqlite = [...new Set(['python3', '/usr/bin/python3'])].map(binary => {
    const value = JSON.parse(call(binary, ['-I', '-c', pythonCode]));
    assert.deepEqual(Object.keys(value).sort(), ['extension', 'libraries', 'python', 'sqliteVersion', 'wrapper']);
    assert.ok(value.libraries.length === 1); assert.match(value.sqliteVersion, /^\d+\.\d+\.\d+$/);
    return { binary, sqliteVersion: value.sqliteVersion, files: [value.python, value.wrapper, value.extension, ...value.libraries]
      .map(file => sizeLogRuntimeFile(file, cutoff, [0], true)) };
  });
  const dependencyRoot = m.live.web.root + '/node_modules', dependencyTrust = sealedDependencyTrust(m, dependencyRoot, applicationUid);
  const sourceProof = m.live.hd.sourceProof || dependencyTrust.sourceProof;
  const sourceBytes = rootFile(sourceProof.sourceManifest), source = JSON.parse(sourceBytes);
  assert.equal(source.source, m.live.hd.source); assert.equal(source.source, m.live.web.source);
  const sourceFiles = {};
  for (const root of [...new Set([m.live.web.root, m.live.hd.root])]) {
    assert.equal(root, m.projectRoot + '/managed-releases/' + source.source);
    sourceFiles[root] = Object.fromEntries(Object.keys(source.files).sort().map(file => {
      assert.equal(path.resolve(root, file), root + '/' + file);
      const digest = sha(sizeLogApplicationFile(root + '/' + file, root, applicationUid, 32 * 1024 * 1024, true));
      assert.equal(digest, source.files[file], 'Live baseline source changed: ' + file);
      const stat = fs.lstatSync(root + '/' + file);
      return [file, { sha256: digest, ...Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, stat[key]])) }];
    }));
  }
  const closedSource = rootFile(directory + '/hd-closed-cache-engineering.mjs').toString();
  const proofFiles = ['scripts/process-hd-image.ts', 'src/lib/media/hd-image-processor.ts', 'src/lib/media/hd-encoder.ts',
    'node_modules/tsx/dist/index-7AaEi15b.mjs', 'tsconfig.json'];
  const historicalSources = {};
  for (const match of closedSource.matchAll(/const (?:e01|currentRoot|designRoot|sizeLogRoot) = '(\/data\/video-api-debugger\/managed-releases\/[a-f0-9]{40}\/)';/g)) {
    const root = match[1].slice(0, -1);
    const hashes = Object.fromEntries(proofFiles.map(file => [file,
      sha(sizeLogApplicationFile(root + '/' + file, root, applicationUid))]));
    assertHdE01CacheSourceProof(hashes);
    historicalSources[root] = { hashes, identities: Object.fromEntries(proofFiles.map(file => {
      const stat = fs.lstatSync(root + '/' + file);
      return [file, Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, stat[key]]))];
    })) };
  }
  assert.equal(Object.keys(historicalSources).length, 4, 'Closed-cache actual source proof inputs changed');
  const typescript = createRequire(m.live.web.root + '/package.json').resolve('typescript');
  let immutableOriginal = null;
  if (MV_DIRECT.immutableOriginalManifest !== undefined) {
    const file = MV_DIRECT.immutableOriginalManifest, bytes = rootFile(file), original = JSON.parse(bytes);
    assert.equal(file, m.projectRoot + '/release-staging/' + original.runId + '/manifest.json');
    immutableOriginal = { file, sha256: sha(bytes), capsules: Object.fromEntries(['main', 'guard'].map(kind => {
      const capsuleFile = path.dirname(file) + '/' + kind + '-immutable-success.json';
      return [kind, { file: capsuleFile, sha256: sha(rootFile(capsuleFile, 128 * 1024 * 1024)) }];
    })) };
  }
  const result = { engine: m.engine, runtime, pythonSqlite,
    typescript: sizeLogRuntimeFile(typescript, cutoff, owners),
    baseline: { sourceManifest: sourceProof.sourceManifest, sourceManifestSha256: sha(sourceBytes), sourceFiles,
      dependencies: sharedDependencyTree(dependencyRoot, owners, cutoff, dependencyTrust) }, historicalSources, immutableOriginal };
  assert.ok(latestDependencyChange(result) < cutoff, 'Application/runtime dependency metadata changed after this batch began');
  return result;
}
function sharedNativeInput(m, file, args, dependencies, cutoff) {
  assert.ok(SHARED_NATIVE_FILES.includes(file)); const directory = engineDirectory(m), context = sharedNativeContext(m);
  const argv = [directory + '/release-entry.mjs', 'native', context.file, file, ...args];
  const argumentFiles = {};
  if (file === 'hd-closed-cache-engineering.mjs') {
    const fixture = rootFile(directory + '/' + file).toString();
    const roots = [...new Set([...args, ...[...fixture.matchAll(/const \w+Reference = '(\/data\/[^']+\/tsx-\d+)';/g)].map(match => match[1])])];
    const uid = Number(call('id', ['-u', m.appUser]));
    for (const root of roots) argumentFiles[root] = sharedDependencyTree(root, [0, uid], cutoff);
  }
  const normalizedArgv = [...argv]; normalizedArgv[2] = '$ROOT_CONTEXT';
  const inputs = { engine: m.engine, argv: normalizedArgv, contextProjectionSha256: context.projectionSha256,
    cwd: m.live.web.root, environment: { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8',
      TMPDIR: '$EXCLUSIVE_ROOT_0700_ATTEMPT_SCRATCH' }, timeoutMs: NATIVE_TIMEOUT_MS, dependencies, argumentFiles };
  return { schema: 'sd2-native-control-input.v1', argv, context, fingerprint: sha(JSON.stringify(inputs)), inputs };
}
function sharedControlReferences(m) {
  engineDirectory(m); const value = m.controlEvidence;
  if (value === undefined) return new Map();
  assert.deepEqual(Object.keys(value).sort(), ['schema', 'leaves'].sort());
  assert.equal(value.schema, 'sd2-direct-native-control-evidence.v1'); assert.ok(Array.isArray(value.leaves) && value.leaves.length <= 17);
  const leaves = new Map();
  for (const item of value.leaves) {
    assert.deepEqual(Object.keys(item).sort(), ['file', 'manifest', 'manifestSha256', 'receipt', 'receiptSha256', 'log', 'logSha256'].sort());
    assert.ok(SHARED_NATIVE_FILES.includes(item.file) && !MANIFEST_NATIVE_FILES.includes(item.file) && !leaves.has(item.file),
      'Only a unique, non-manifest-dependent direct native leaf may be reused');
    for (const key of ['manifestSha256', 'receiptSha256', 'logSha256']) assert.match(item[key], /^[a-f0-9]{64}$/);
    leaves.set(item.file, item);
  }
  return leaves;
}
function assertSharedLeafEngineCompatibility(m, origin, file) {
  const currentDirectory = engineDirectory(m), originalDirectory = engineDirectory(origin);
  assert.equal(origin.engine.version, m.engine.version, 'Native engine version changed');
  const names = Object.keys(m.privateSha256).sort();
  assert.deepEqual(Object.keys(origin.privateSha256).sort(), names, 'Native engine file set changed');
  const sources = {};
  for (const [manifest, directory] of [[origin, originalDirectory], [m, currentDirectory]]) {
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.mjs')).sort(), names);
    sources[directory] = Object.fromEntries(names.map(name => {
      assert.equal(path.basename(name), name); assert.ok(name.endsWith('.mjs'));
      const bytes = rootFile(directory + '/' + name);
      assert.equal(sha(bytes), manifest.privateSha256[name], 'Native engine original bytes changed: ' + name);
      return [name, bytes];
    }));
  }
  const original = sources[originalDirectory], current = sources[currentDirectory];
  for (const name of names) if (!name.endsWith('-engineering.mjs') && name !== 'control-preflight.mjs')
    assert.deepEqual(current[name], original[name], 'Native production module changed: ' + name);
  assert.ok(Object.hasOwn(current, file), 'Direct native fixture is missing');
  if (originalDirectory !== currentDirectory)
    assert.notEqual(file, 'preflight-resume-engineering.mjs', 'The current outer native validator must actually execute');
  const ts = createRequire(m.live.web.root + '/package.json')('typescript'), visited = new Set(), pending = [file];
  while (pending.length) {
    const name = pending.pop(); if (visited.has(name)) continue; visited.add(name);
    assert.deepEqual(current[name], original[name], 'Direct native fixture dependency changed: ' + name);
    const tree = ts.createSourceFile(name, current[name].toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.equal(tree.parseDiagnostics.length, 0, 'Native fixture dependency is not a valid module: ' + name);
    const visit = node => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const moduleReference = ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)
          || ts.isCallExpression(node.parent) && node.parent.expression.kind === ts.SyntaxKind.ImportKeyword;
        // Production modules are all byte-identical above. Follow their actual
        // imports, not policy inventories containing unrelated fixture names.
        if (name.endsWith('-engineering.mjs') || moduleReference) {
          const reference = path.basename(node.text);
          if (Object.hasOwn(current, reference)) pending.push(reference);
          else if (reference.endsWith('-engineering.mjs')) assert.fail('Unbound native fixture dependency: ' + node.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
}
function sharedReusedOutcome(m, ref, currentInput) {
  const manifestBytes = rootFile(ref.manifest); assert.equal(sha(manifestBytes), ref.manifestSha256);
  const origin = JSON.parse(manifestBytes); assert.equal(isSharedEngine(origin), true); engineDirectory(origin);
  assert.equal(origin.projectRoot, m.projectRoot); assert.notEqual(origin.runId, m.runId);
  assert.equal(ref.manifest, origin.stage + '/manifest.json');
  assertSharedLeafEngineCompatibility(m, origin, ref.file);
  assert.equal(ref.receipt, atomicReceiptFile(origin, ref.file)); assert.equal(ref.log, origin.stage + '/native-control-preflight/' + ref.file + '.log');
  const receiptBytes = rootFile(ref.receipt, 64 * 1024 * 1024); assert.equal(sha(receiptBytes), ref.receiptSha256);
  const receipt = JSON.parse(receiptBytes), item = outcomeFromAtomicReceipt(origin, receipt, ref.receiptSha256);
  assert.equal(receipt.file, ref.file); assert.equal(receipt.log.path, ref.log); assert.equal(receipt.log.sha256, ref.logSha256);
  assertAtomicOutcome(origin, item); assert.equal(item.status, 0); assert.equal(item.signal, null);
  assert.equal(item.error, null); assert.equal(item.errorCode, null);
  // A reused outcome has no new atomic receipt. Consequently only an actual,
  // directly executed original leaf (never a recursive aggregate) can get here.
  assert.ok(receipt.controlInput, 'Historical atomic lacks actual shared control input evidence');
  const oldDependencies = structuredClone(currentInput.inputs.dependencies);
  oldDependencies.engine = origin.engine;
  assert.equal(origin.live.web.root, currentInput.inputs.cwd);
  if (origin.live.hd.sourceProof) assert.equal(origin.live.hd.sourceProof.sourceManifest, oldDependencies.baseline.sourceManifest);
  else assert.ok(origin.normalContinuation && origin.reuseBuilds, 'Original live source proof is missing');
  assert.equal(origin.appUser, m.appUser);
  assert.ok(latestDependencyChange(oldDependencies) < Date.parse(receipt.startedAt), 'Dependency metadata postdates the direct original leaf');
  const oldInput = sharedNativeInput(origin, ref.file, receipt.controlInput.argv.slice(4), oldDependencies, Date.parse(receipt.startedAt));
  assert.deepEqual(receipt.controlInput, oldInput, 'Original native input or runtime dependencies changed');
  const equivalent = structuredClone(oldInput.inputs);
  equivalent.engine = m.engine; equivalent.dependencies.engine = m.engine;
  equivalent.argv[0] = engineDirectory(m) + '/release-entry.mjs';
  if (ref.file === 'certificate-engineering.mjs') {
    assert.deepEqual(oldInput.argv.slice(4), [engineDirectory(origin)]);
    equivalent.argv[4] = engineDirectory(m);
  }
  equivalent.contextProjectionSha256 = sharedNativeContext(origin, m.engine).projectionSha256;
  assert.deepEqual(equivalent, currentInput.inputs, 'Native controller/contract/arguments/dependencies are not equivalent');
  assert.equal(sha(rootFile(ref.log)), ref.logSha256);
  return { ...item, execution: 'reused', original: { runId: origin.runId, manifest: ref.manifest,
    manifestSha256: ref.manifestSha256, receipt: ref.receipt, receiptSha256: ref.receiptSha256,
    log: ref.log, logSha256: ref.logSha256, engine: origin.engine, controlInputSha256: sha(JSON.stringify(oldInput)) } };
}
function assertSharedNativeBatch(m, value, observedDependencies = null) {
  assert.equal(value.schema, 'sd2-native-control-batch.v1'); assert.equal(value.runId, m.runId); assert.equal(value.completed, true);
  assert.equal(value.manifestSha256, sha(rootFile(m.stage + '/manifest.json'))); assert.deepEqual(value.privateSha256, m.privateSha256);
  assert.deepEqual(value.engine, m.engine); assert.deepEqual(value.operation, m.operation);
  assert.equal(value.servicesChanged, false); assert.equal(value.productionWrites, 0);
  const started = Date.parse(value.startedAt), finished = Date.parse(value.finishedAt);
  assert.ok(Number.isFinite(started) && started <= finished && finished <= Date.now());
  assert.deepEqual(value.outcomes.map(item => item.file), SHARED_NATIVE_FILES);
  const references = sharedControlReferences(m), dependencies = observedDependencies || sharedControlDependencies(m, started);
  const admission = inspectRetiredHdCaches(m, 'admission'), reference = m.hdRoot + '/.runs/' + admission.entries[0].run + '/tsx-1004';
  const tasks = new Map(sharedNativeTasks(m, reference));
  for (const item of value.outcomes) {
    const input = sharedNativeInput(m, item.file, tasks.get(item.file), dependencies, started);
    if (references.has(item.file)) {
      assert.deepEqual(item, sharedReusedOutcome(m, references.get(item.file), input));
      assert.ok(Date.parse(item.finishedAt) <= started, 'Direct original native time cannot be changed');
    } else {
      const { execution, ...atomic } = item; assert.equal(execution, 'executed');
      const receipt = assertAtomicOutcome(m, atomic); assert.deepEqual(receipt.controlInput, input);
      assert.ok(Date.parse(item.startedAt) >= started && Date.parse(item.finishedAt) <= finished);
      assert.equal(item.status, 0); assert.equal(item.signal, null); assert.equal(item.error, null); assert.equal(item.errorCode, null);
    }
  }
  if (value.outcomes.some(item => item.execution === 'reused'
    && item.original.engine.controllerSetSha256 !== m.engine.controllerSetSha256)) {
    const validator = value.outcomes.find(item => item.file === 'preflight-resume-engineering.mjs');
    assert.equal(validator.execution, 'executed', 'A changed outer native validator cannot borrow its original result');
    assert.equal(validator.status, 0);
  }
  return value;
}
function atomicReceiptFile(m, file) {
  assert.ok((isSharedEngine(m) ? SHARED_NATIVE_FILES : NATIVE_FILES).includes(file), 'Unknown native control file');
  return m.stage + '/native-control-preflight/' + file + '.receipt.json';
}

function outcomeFromAtomicReceipt(m, receipt, receiptSha256) {
  return { file: receipt.file, receiptSha256, startedAt: receipt.startedAt, finishedAt: receipt.finishedAt,
    durationMs: receipt.durationMs, timeoutMs: receipt.timeoutMs, status: receipt.status, exitCode: receipt.status,
    signal: receipt.signal, error: receipt.error, errorCode: receipt.errorCode,
    stdoutBytes: receipt.stdoutBytes, stderrBytes: receipt.stderrBytes,
    logBytes: receipt.log.bytes, sha256: receipt.log.sha256 };
}

function assertAtomicOutcome(m, item) {
  const receiptBytes = rootFile(atomicReceiptFile(m, item.file), 64 * 1024 * 1024);
  const receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.schema, 'sd2-native-control-atomic-receipt.v1');
  assert.equal(receipt.runId, m.runId); assert.equal(receipt.manifestSha256, sha(rootFile(m.stage + '/manifest.json')));
  assert.equal(receipt.file, item.file); assert.equal(receipt.timeoutMs, NATIVE_TIMEOUT_MS);
  const started = Date.parse(receipt.startedAt), finished = Date.parse(receipt.finishedAt);
  assert.ok(Number.isFinite(started) && Number.isFinite(finished) && started <= finished && finished <= Date.now());
  assert.equal(receipt.durationMs, finished - started); assert.ok(receipt.durationMs >= 0);
  assert.ok(receipt.status === null || Number.isInteger(receipt.status));
  assert.ok(receipt.signal === null || typeof receipt.signal === 'string' && receipt.signal.length > 0);
  assert.ok(receipt.error === null || typeof receipt.error === 'string' && receipt.error.length > 0);
  assert.ok(receipt.errorCode === null || typeof receipt.errorCode === 'string' && receipt.errorCode.length > 0);
  assert.equal(typeof receipt.stdout, 'string'); assert.equal(typeof receipt.stderr, 'string');
  assert.equal(receipt.stdoutBytes, Buffer.byteLength(receipt.stdout));
  assert.equal(receipt.stderrBytes, Buffer.byteLength(receipt.stderr));
  const combined = Buffer.from(receipt.stdout + receipt.stderr);
  assert.equal(receipt.log.path, m.stage + '/native-control-preflight/' + item.file + '.log');
  assert.equal(receipt.log.bytes, combined.length); assert.equal(receipt.log.sha256, sha(combined));
  const logBytes = rootFile(receipt.log.path);
  assert.equal(logBytes.length, receipt.log.bytes); assert.equal(sha(logBytes), receipt.log.sha256);
  assert.deepEqual(logBytes, combined);
  assert.deepEqual(item, outcomeFromAtomicReceipt(m, receipt, sha(receiptBytes)));
  return receipt;
}

function assertOriginalNativeBatch(m, value) {
  assert.equal(value.schema, 'sd2-native-control-batch.v1');
  assert.equal(value.runId, m.runId); assert.equal(value.completed, true);
  assert.equal(value.manifestSha256, sha(rootFile(m.stage + '/manifest.json')));
  assert.deepEqual(value.privateSha256, m.privateSha256);
  assert.equal(value.servicesChanged, false); assert.equal(value.productionWrites, 0);
  assert.ok(Number.isFinite(Date.parse(value.startedAt)) && Number.isFinite(Date.parse(value.finishedAt))
    && Date.parse(value.startedAt) <= Date.parse(value.finishedAt) && Date.parse(value.finishedAt) <= Date.now());
  assert.deepEqual(value.outcomes.map(item => item.file), NATIVE_FILES);
  for (const item of value.outcomes) {
    assertAtomicOutcome(m, item);
    assert.equal(item.status, 0); assert.equal(item.exitCode, 0); assert.equal(item.signal, null);
    assert.equal(item.error, null); assert.equal(item.errorCode, null);
  }
  return value;
}

export function assertNativeBatch(m, value) {
  if (isSharedEngine(m)) return assertSharedNativeBatch(m, value);
  if (value.reusedOriginal === undefined) {
    assert.equal(sizeLogReuseEligible(m), false, 'The protected continuation requires explicit original evidence');
    return assertOriginalNativeBatch(m, value);
  }
  const checkpoint = sizeLogOriginalCheckpoint(m);
  assert.deepEqual(value.reusedOriginal, checkpoint.proof);
  assert.equal(value.schema, 'sd2-native-control-batch.v1'); assert.equal(value.runId, m.runId); assert.equal(value.completed, true);
  assert.equal(value.manifestSha256, sha(rootFile(m.stage + '/manifest.json'))); assert.deepEqual(value.privateSha256, m.privateSha256);
  assert.equal(value.servicesChanged, false); assert.equal(value.productionWrites, 0);
  const started = Date.parse(value.startedAt), finished = Date.parse(value.finishedAt);
  assert.ok(Number.isFinite(started) && Number.isFinite(finished) && started <= finished && finished <= Date.now()
    && Date.parse(checkpoint.batch.finishedAt) <= started);
  assert.deepEqual(value.outcomes.map(item => item.file), NATIVE_FILES);
  for (const item of value.outcomes) {
    if (SIZE_LOG_EXECUTED.includes(item.file)) {
      const { execution, ...atomic } = item; assert.equal(execution, 'executed');
      assertAtomicOutcome(m, atomic);
      assert.ok(Date.parse(item.startedAt) >= started && Date.parse(item.finishedAt) <= finished);
      assert.equal(item.status, 0); assert.equal(item.exitCode, 0); assert.equal(item.signal, null);
      assert.equal(item.error, null); assert.equal(item.errorCode, null);
    } else {
      assert.deepEqual(item, reusedSizeLogOutcome(checkpoint, checkpoint.batch.outcomes.find(old => old.file === item.file)));
      assert.ok(Date.parse(item.finishedAt) <= started, 'Reused leaf cannot postdate the new batch');
    }
  }
  return value;
}

export function assertControlPreflight(m) { return assertControlPreflightObserved(m); }
function assertControlPreflightObserved(m, dependencies = null) {
  const value = JSON.parse(rootFile(m.stage + '/native-control-preflight/receipt.json'));
  assert.equal(value.schema, 'mv-hd-upload-native-control-preflight.v1');
  assert.equal(value.runId, m.runId); assert.equal(value.completed, true);
  assert.equal(value.manifestSha256, sha(rootFile(m.stage + '/manifest.json')));
  assert.deepEqual(value.privateSha256, m.privateSha256);
  assert.equal(value.servicesChanged, false); assert.equal(value.productionWrites, 0);
  assert.equal(value.nativeBeforeMaintenance.completed, true);
  assert.equal(value.nativeBeforeMaintenance.releaseApproved, false);
  const batchFile = m.stage + '/native-control-preflight/batch.json';
  const parsedBatch = JSON.parse(rootFile(batchFile));
  const batch = isSharedEngine(m) ? assertSharedNativeBatch(m, parsedBatch, dependencies) : assertNativeBatch(m, parsedBatch);
  assert.equal(value.nativeBatchSha256, sha(rootFile(batchFile)));
  assert.deepEqual(value.outcomes, batch.outcomes);
  for (const result of value.outcomes) {
    assert.equal(result.exitCode, 0);
    const log = result.execution === 'reused' ? result.original.log : path.join(m.stage, 'native-control-preflight', result.file + '.log');
    assert.equal(result.sha256, sha(rootFile(log)));
  }
  return value;
}

export async function controlPreflight(m) {
  validateManifest(m); if (!isSharedEngine(m)) assertReleaseWindow(m);
  if (m.recoveredGuardBaseline) assertCurrentPublishedBaseline(m);
  if (m.recoveredGuardBaseline?.schema === 'sd2-multiview-r17-recovered-guard.v1') inspectInstalledMultiviewRecipeAdoption(m);
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  for (const [file, digest] of Object.entries(m.privateSha256))
    assert.equal(sha(rootFile(engineDirectory(m) + '/' + file)), digest);
  const loaded = JSON.parse(rootFile(m.stage + '/control-module-preflight.json'));
  assert.equal(loaded.moduleActuallyLoaded, true);
  assert.equal(loaded.sha256, m.privateSha256['writer-network-fence.mjs']);
  const directory = m.stage + '/native-control-preflight';
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  assert.ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink() && directoryStat.uid === 0 && (directoryStat.mode & 0o077) === 0);
  assert.equal(fs.realpathSync(directory), directory);
  assert.equal(fs.existsSync(directory + '/receipt.json'), false, 'A completed preflight cannot be reissued with a new time');
  const admission = inspectRetiredHdCaches(m, 'admission');
  assert.equal(admission.accepted, false);
  assert.throws(() => inspectRetiredHdCaches(m, 'drained'), 'An active old writer cannot count as a drained writer');
  const reference = m.hdRoot + '/.runs/' + admission.entries[0].run + '/tsx-1004';
  const batchFile = directory + '/batch.json';
  const checkpoint = sizeLogReuseEligible(m) ? sizeLogOriginalCheckpoint(m) : null;
  let batch, sharedDependencies = null;
  if (fs.existsSync(batchFile)) {
    const parsed = JSON.parse(rootFile(batchFile));
    sharedDependencies = isSharedEngine(m) ? sharedControlDependencies(m, Date.parse(parsed.startedAt)) : null;
    batch = isSharedEngine(m) ? assertSharedNativeBatch(m, parsed, sharedDependencies) : assertNativeBatch(m, parsed);
  }
  else {
  // A partial batch is not replayable. Only its completed, pinned checkpoint can be reused.
  assert.equal(fs.readdirSync(directory).length, 0, 'Incomplete native batch must retain its failure evidence');
  if (checkpoint) for (const source of [checkpoint.original, checkpoint.prior, checkpoint.hdClosed, m]) for (const kind of ['main', 'guard'])
    await verifyRateSourceArchive({ archive: source[kind].archive, manifest: JSON.parse(rootFile(source[kind].sourceManifest)) });
  const startedAt = new Date().toISOString(), outcomes = [];
  const batchManifestSha256 = sha(rootFile(m.stage + '/manifest.json'));
  const shared = isSharedEngine(m), references = shared ? sharedControlReferences(m) : new Map();
  const dependencies = shared ? sharedControlDependencies(m, Date.parse(startedAt)) : null;
  sharedDependencies = dependencies;
  for (const [file, args] of shared ? sharedNativeTasks(m, reference) : nativeTasks(m, reference)) {
    if (checkpoint && !SIZE_LOG_EXECUTED.includes(file)) {
      outcomes.push(reusedSizeLogOutcome(checkpoint, checkpoint.batch.outcomes.find(item => item.file === file))); continue;
    }
    const controlInput = shared ? sharedNativeInput(m, file, args, dependencies, Date.parse(startedAt)) : null;
    if (references.has(file)) {
      outcomes.push(sharedReusedOutcome(m, references.get(file), controlInput)); continue;
    }
    const startedMs = Date.now(), atomicStartedAt = new Date(startedMs).toISOString();
    const spawnOptions = {
      cwd: m.live.web.root, encoding: 'utf8', timeout: NATIVE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
      env: { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', TMPDIR: directory, LANG: 'C.UTF-8' },
    };
    const result = shared ? spawnSync(process.execPath, controlInput.argv, spawnOptions)
      : spawnSync(process.execPath, [m.stage + '/fix01-release/' + file, ...args], spawnOptions);
    const finishedMs = Date.now(), stdout = typeof result.stdout === 'string' ? result.stdout : '',
      stderr = typeof result.stderr === 'string' ? result.stderr : '', combined = Buffer.from(stdout + stderr);
    const log = path.join(directory, file + '.log');
    fs.writeFileSync(log, combined, { flag: 'wx', mode: 0o600 });
    const atomic = { schema: 'sd2-native-control-atomic-receipt.v1', runId: m.runId,
      manifestSha256: batchManifestSha256, file, startedAt: atomicStartedAt,
      finishedAt: new Date(finishedMs).toISOString(), durationMs: finishedMs - startedMs, timeoutMs: NATIVE_TIMEOUT_MS,
      status: result.status ?? null, signal: result.signal ?? null, error: result.error?.message || null,
      errorCode: result.error?.code === undefined ? null : String(result.error.code),
      stdout, stderr, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
      log: { path: log, bytes: combined.length, sha256: sha(combined) }, ...(shared ? { controlInput } : {}) };
    const atomicFile = atomicReceiptFile(m, file); writeJsonExclusive(atomicFile, atomic);
    const outcome = outcomeFromAtomicReceipt(m, atomic, sha(rootFile(atomicFile, 64 * 1024 * 1024)));
    assertAtomicOutcome(m, outcome); outcomes.push(checkpoint || shared ? { ...outcome, execution: 'executed' } : outcome);
  }
  // Collect the whole controller batch before deciding whether compilation may start.
  const failures = outcomes.filter(result => result.exitCode !== 0 || result.signal || result.error || result.errorCode);
  batch = { schema: 'sd2-native-control-batch.v1', runId: m.runId, completed: failures.length === 0,
    manifestSha256: batchManifestSha256, privateSha256: m.privateSha256,
    startedAt, finishedAt: new Date().toISOString(), outcomes, servicesChanged: false, productionWrites: 0,
    ...(checkpoint ? { reusedOriginal: checkpoint.proof } : {}), ...(shared ? { engine: m.engine, operation: m.operation } : {}) };
  writeJsonExclusive(batchFile, batch);
  if (failures.length) {
    writeJsonExclusive(directory + '/failure.json', { runId: m.runId, completed: false, outcomes, servicesChanged: false, productionWrites: 0 });
    throw new Error('Release controller preflight failed; no full build or service switch started: ' + failures.map(item => item.file).join(', '));
  }
  if (shared) assertSharedNativeBatch(m, batch, sharedDependencies); else assertNativeBatch(m, batch);
  }
  if (isSharedEngine(m)) {
    dependencyBoundary(m.live.web.root + '/node_modules', 'evidence_missing', 'dependency_changed_during_observation', () =>
      assert.deepEqual(sharedControlDependencies(m, Date.parse(batch.startedAt)), sharedDependencies,
        'Static native dependencies changed during execution'));
    return batch;
  }
  return finishControlAdmission(m, batch, batchFile, admission, sharedDependencies);
}

export async function controlAdmission(m) {
  validateManifest(m); assert.equal(isSharedEngine(m), true); engineDirectory(m); assertReleaseWindow(m);
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  if (m.recoveredGuardBaseline) assertCurrentPublishedBaseline(m);
  if (m.recoveredGuardBaseline?.schema === 'sd2-multiview-r17-recovered-guard.v1') inspectInstalledMultiviewRecipeAdoption(m);
  const batchFile = m.stage + '/native-control-preflight/batch.json', parsed = JSON.parse(rootFile(batchFile));
  assert.equal(fs.existsSync(m.stage + '/native-control-preflight/receipt.json'), false, 'A completed preflight cannot be reissued with a new time');
  const dependencies = sharedControlDependencies(m, Date.parse(parsed.startedAt));
  const batch = assertSharedNativeBatch(m, parsed, dependencies), admission = inspectRetiredHdCaches(m, 'admission');
  assert.equal(admission.accepted, false);
  assert.throws(() => inspectRetiredHdCaches(m, 'drained'), 'An active old writer cannot count as a drained writer');
  return finishControlAdmission(m, batch, batchFile, admission, dependencies);
}

async function finishControlAdmission(m, batch, batchFile, admission, sharedDependencies) {
  const directory = m.stage + '/native-control-preflight';
  const manifestSha256 = sha(rootFile(m.stage + '/manifest.json')), before = captureSwitchBefore(m, manifestSha256);
  verifyNormalContinuation(m, before);
  if (m.deployedUsageSchema) {
    verifyDeployedUsageSchema(m, { candidates: false });
    assertPriorUsageRoleControl(m);
  }
  const retainedCertificate = Object.fromEntries(['early-original', 'observe'].map(phase =>
    [phase, inspectRecoveryCertificate(m, before, { phase })]));
  const retainedUploadProof = inspectRetainedUploadProof(m, before);
  const evidenceRoot = m.stage + '/readonly-before-maintenance';
  if (!fs.existsSync(evidenceRoot)) fs.mkdirSync(evidenceRoot, { mode: 0o700 });
  const evidenceStat = fs.lstatSync(evidenceRoot);
  assert.ok(evidenceStat.isDirectory() && !evidenceStat.isSymbolicLink() && evidenceStat.uid === 0 && (evidenceStat.mode & 0o077) === 0);
  assert.equal(fs.realpathSync(evidenceRoot), evidenceRoot);
  const evidenceDirectory = evidenceRoot + '/' + randomUUID(); fs.mkdirSync(evidenceDirectory, { mode: 0o700 });
  const beforeFile = evidenceDirectory + '/before.json';
  writeJsonExclusive(beforeFile, { runId: m.runId, ...before });
  let nativeBeforeMaintenance;
  try {
    nativeBeforeMaintenance = await inspectNativeBeforeMaintenance({ m, manifestSha256, before, evidenceDirectory, beforeFile });
  } catch (error) {
    writeJsonExclusive(evidenceDirectory + '/failure.json', { runId: m.runId, manifestSha256,
      nativeBatchSha256: sha(rootFile(batchFile)), at: new Date().toISOString(),
      completed: false, failure: { name: error.name, code: error.code || null }, servicesChanged: false, productionWrites: 0 });
    throw error;
  }
  assert.equal(nativeBeforeMaintenance.completed, true);
  const hdAdmission = await inspectHdReconciliation(m, { sourceRoot: m.live.web.root, retiredCachePhase: 'admission',
    ...(isSharedEngine(m) ? sharedReadOnlyHdBounds(m) : {}) });
  recordHdAdmission(m, hdAdmission);
  assert.equal(hdAdmission.canEnterControlledDrain, true);
  assert.equal(call('findmnt', ['-n', '-o', 'TARGET', '-T', m.stage]), '/data');
  if (isSharedEngine(m)) {
    const after = sharedControlDependencies(m, Date.parse(batch.startedAt));
    dependencyBoundary(m.live.web.root + '/node_modules', 'evidence_missing', 'dependency_changed_during_observation', () =>
      assert.deepEqual(after, sharedDependencies, 'Native control dependencies changed during the batch/admission interval'));
    sharedDependencies = after;
  }
  writeJsonExclusive(directory + '/receipt.json', { schema: 'mv-hd-upload-native-control-preflight.v1', runId: m.runId,
    manifestSha256, at: new Date().toISOString(), completed: true, outcomes: batch.outcomes, admission, nativeBeforeMaintenance, hdAdmission,
    nativeBatchSha256: sha(rootFile(batchFile)),
    activeOriginalHdRefusedAsDrained: true, privateSha256: m.privateSha256, retainedCertificate, retainedUploadProof,
    productionWrites: 0, servicesChanged: false, completeBuildExecuted: false, functionalAcceptance: false });
  return assertControlPreflightObserved(m, sharedDependencies);
}
