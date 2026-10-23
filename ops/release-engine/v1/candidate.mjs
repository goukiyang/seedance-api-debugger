import { assertFullDependencyAdoption, verifyFullCandidateSources } from './full-release-contract.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateManifest, assertReleaseWindow, readProtection, assertProtection,
  writeJsonExclusive, call, unit, rootFile, sha, liveArtifactSource, isSharedEngine, sharedReadOnlyHdBounds } from './common.mjs';
import { preparePricingInputs, verifyPricingInputs, verifyPricingGateReceipt } from './candidate-inputs.mjs';
import { verifyRateSourceArchive } from './package-candidates.mjs';
import { verifyUploadPrivateDirectory } from './upload-directory-preflight.mjs';
import { probeHdCandidateResolver, verifyHdCandidateResolver, inspectHdReconciliation } from './hd-storage-preflight.mjs';
import { prepareReusedCandidate, verifyReusedCandidate, sealOriginalSuccess } from './candidate-reuse.mjs';
import { assertControlPreflight } from './control-preflight.mjs';
import { assertProtectedIncrementCandidate } from './release-contract.mjs';
import { captureHdCompiledCache, verifyHdCompiledCacheReceipt } from './hd-compiled-cache.mjs';

const SOURCE_SCHEMA = 'rate-impl2-source-manifest.v1';
const BUILD_SCHEMA = 'rate-impl2-candidate-build.v1';
const IMAGE_FIXTURES = ['ops/video-creation-contract-check.mjs', 'scripts/image-quality-routing-engineering.ts', 'scripts/image-studio-recovery-fairness-engineering.ts',
  'scripts/image-dispatch-fairness-engineering.ts', 'scripts/image-async-recovery-engineering.ts',
  'scripts/image-dimension-mismatch-engineering.ts', 'scripts/upload-recovery-engineering.mjs',
  'scripts/multiview-settings-batch-engineering.mjs', 'scripts/hd-chain-engineering.mjs',
  'scripts/image-size-policy-engineering.ts', 'scripts/image-provider-error-engineering.ts'];
const MULTIVIEW_FIXTURE_CHECKS = ['saved_settings_permissions_snapshots_and_timing',
  'frame_settings_keep_media_and_layout_private', 'preview_atlas_loop_exact_output_contract',
  'same_work_identity_baseline_and_explicit_original_save'];
const MULTIVIEW_TRANSPORT_SOURCES = ['scripts/multiview-reference-transport-engineering.ts',
  'src/lib/provider/reference-image-transport.ts', 'src/lib/provider/jimeng.ts',
  'src/lib/assets/site-url.ts', 'src/lib/reference-albums/permissions.ts'];
const MULTIVIEW_FIXTURE_SOURCES = [
  "scripts/multiview-settings-fixture-inputs.mjs",
  "scripts/multiview-settings-batch-engineering.mjs",
  "scripts/multiview-settings-engineering.ts",
  "scripts/multiview-frame-settings-client-engineering.ts",
  "scripts/multiview-preview-engineering.ts",
  "scripts/multiview-work-identity-engineering.ts",
  "src/lib/video/multiview-settings-contract.ts",
  "src/lib/video/multiview-settings.server.ts",
  "src/lib/video/multiview-settings-api.ts",
  "src/lib/video/multiview-generation-contract.ts",
  "src/lib/video/multiview-preset.server.ts",
  "src/lib/video/multiview-recipe-storage.server.ts",
  "src/lib/video/multiview-private-create.server.ts",
  "src/lib/video/multiview-task-privacy.ts",
  "src/lib/video/multiview-contract.ts",
  "src/lib/video/multiview-work-contract.ts",
  "src/lib/video/multiview-works.ts",
  "src/lib/video/multiview-preview-contract.ts",
  "src/lib/video/multiview-preview.ts",
  "src/lib/hooks/use-media-preview-state.ts",
  "src/lib/media/media-preview-state-contract.ts",
  "src/lib/pricing/video-context.ts",
  "src/app/api/tasks/estimate/route.ts",
  "src/app/api/tasks/create/route.ts",
  "src/app/api/multiview/settings/route.ts",
  "src/app/api/multiview/settings/[id]/route.ts",
  "src/app/api/multiview/settings/[id]/apply/route.ts",
  "src/app/api/multiview/settings/mutations/[mutationId]/route.ts",
  "src/app/multiview/MultiviewGenerationPanel.tsx",
  "src/app/multiview/MultiviewSettingsPicker.tsx",
  "src/app/multiview/MultiviewFrameSettingsPanel.tsx",
  "src/app/multiview/multiview-frame-settings-client.ts",
  "src/app/multiview/useMultiviewWork.ts",
  "src/app/multiview/multiview-work-client.ts",
  "src/app/multiview/multiview-preview-image.ts",
  "src/app/multiview/MultiviewFrameImage.tsx",
  "src/app/multiview/multiview-original-queue.ts",
  "src/app/multiview/multiview-frame-scrub.ts",
  "src/app/multiview/multiview-generation-progress.ts",
  "src/app/multiview/MultiviewFrameControls.tsx",
  "src/app/multiview/MultiviewGenerationProgress.tsx",
  "src/components/ProductActionMenu.tsx",
  "src/components/ProductActionMenu.module.css",
  "src/app/multiview/page.tsx",
  "src/app/multiview/multiview.module.css",
  "src/app/multiview/multiview-generation.module.css"
];
const UPLOAD_FIXTURE_CHECKS = ['private_directory_secure_alias', 'raw_nonce_preflight_history',
  'client_per_file_recovery', 'upload_entry_contracts_preserved'];
const UPLOAD_HELPER = 'src/lib/assets/verified-upload.ts';
const UPLOAD_FIXTURE_SOURCES = ['scripts/upload-recovery-engineering.mjs',
  'scripts/upload-private-directory-engineering.ts', 'scripts/upload-client-recovery-engineering.ts',
  'scripts/upload-raw-recovery-engineering.mjs', 'scripts/upload-root-cure-smoke.ts',
  'src/lib/assets/verified-upload.ts', 'src/lib/assets/raw-upload-state.ts', 'src/lib/assets/upload-log.ts', 'src/lib/assets/direct-upload.ts', 'src/lib/assets/direct-upload-error.ts',
  'src/lib/assets/storage.ts', 'src/lib/assets/site-upload.ts', 'src/lib/http/file-upload.ts',
  'src/lib/http/upload-session.ts', 'src/components/ResourceLibraryPicker.tsx',
  'src/components/ResourceLibraryPicker.module.css', 'src/app/api/assets/upload/route.ts', 'src/app/api/assets/upload-proxy/route.ts',
  'src/app/api/assets/upload-complete/route.ts', 'src/app/api/assets/multipart/complete/route.ts',
  'src/lib/assets/raw-upload-recovery-proof.ts', 'src/app/api/assets/upload/recover/route.ts'];
const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
const absent = file => assert.equal(fs.lstatSync(file, { throwIfNoEntry: false }), undefined, 'Never overwrite candidate state: ' + file);

function directory(file, owner = 0) {
  assert.equal(fs.realpathSync(file), file);
  const stat = fs.lstatSync(file);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === owner && !(stat.mode & 0o022), 'Untrusted directory: ' + file);
}
function context(m, kind) {
  validateManifest(m); assert.ok(['main', 'guard'].includes(kind));
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  for (const file of ['/data', m.projectRoot, m.projectRoot + '/release-staging', m.stage, m.stage + '/' + kind]) directory(file);
  assert.equal(call('findmnt', ['-n', '-o', 'TARGET', '-T', m.stage]), '/data');
  const free = Number(call('df', ['-Pk', m.stage]).split('\n').at(-1).trim().split(/\s+/)[3]);
  assert.ok(Number.isFinite(free) && free * 1024 >= m.minimumFreeBytes, 'Insufficient real data-volume capacity');
  const manifestBytes = rootFile(m.stage + '/manifest.json');
  assert.deepEqual(JSON.parse(manifestBytes), m, 'Use the exact captured manifest, not a caller projection');
  const c = m[kind], sourceBytes = rootFile(c.sourceManifest), source = JSON.parse(sourceBytes);
  verifyUploadPrivateDirectory(m);
  assert.equal(source.schema, SOURCE_SCHEMA); assert.equal(source.project, m.project);
  assert.equal(source.kind, kind); assert.equal(source.source, c.source); assert.equal(source.version, c.version);
  assert.equal(source.baselineSource, m.live.web.source); assert.match(source.archiveSha256, /^[a-f0-9]{64}$/);
  assert.ok(source.files && source.fileDetails && Object.keys(source.files).length > 100);
  assert.equal(Object.keys(source.files).length, source.fileCount);
  for (const file of ['package.json', 'package-lock.json', 'src/lib/release.ts', 'src/app/api/release/route.ts']) {
    assert.equal(source.companionFiles[file], source.files[file]); assert.match(source.files[file], /^[a-f0-9]{64}$/);
  }
  return { c, source, sourceManifestSha256: sha(sourceBytes), manifestSha256: sha(manifestBytes) };
}
function requireOriginalLive(m) {
  for (const v of Object.values(m.live)) {
    const actual = unit(v.unit); assert.equal(actual.ActiveState, 'active'); assert.equal(actual.SubState, 'running');
    assert.equal(Number(actual.MainPID), v.pid); assert.equal(actual.ControlPID, '0'); assert.equal(actual.InvocationID, v.invocation);
    assert.equal(fs.realpathSync(actual.WorkingDirectory), v.root); assert.equal(fs.realpathSync('/proc/' + actual.MainPID + '/cwd'), v.root);
    assert.equal(liveArtifactSource(v.root), v.source);
    assert.equal(JSON.parse(fs.readFileSync(v.root + '/package.json')).version, v.version);
    assert.equal(fs.readFileSync(v.root + '/.next-prod/BUILD_ID', 'utf8').trim(), v.build);
  }
  for (const file of m.protectedFiles) assert.equal(sha(fs.readFileSync(file)), m.expectedProtectedFileSha256[file], 'Protected input changed: ' + file);
}
function safeSource(file) {
  assert.ok(typeof file === 'string' && file && !path.isAbsolute(file) && !/[\0-\x1f\x7f\\]/.test(file));
  assert.ok(file.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.env')));
  assert.ok(!/^(?:storage|node_modules|\.git|\.next[^/]*|\.role-tests|\.release-tmp|public\/(?:uploads|videos)|docs\/materials)(?:\/|$)/.test(file));
  assert.ok(!/\.(?:db|sqlite|sqlite3)(?:[-_.].*)?$/i.test(file));
  assert.notEqual(file, '.deployed-commit'); return file;
}
function sourceCheck(c, source, exact = false) {
  for (const [file, expected] of Object.entries(source.files)) {
    safeSource(file); assert.match(expected, /^[a-f0-9]{64}$/);
    const target = path.join(c.root, file); assert.equal(fs.realpathSync(target), target);
    const stat = fs.lstatSync(target);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    assert.equal(stat.size, source.fileDetails[file].bytes);
    assert.equal(stat.mode & 0o777, source.fileDetails[file].mode === '100755' ? 0o755 : 0o644);
    assert.equal(sha(fs.readFileSync(target)), expected, 'Candidate source changed: ' + file);
  }
  if (exact) {
    const files = [];
    const visit = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const target = path.join(dir, entry.name); assert.ok(!entry.isSymbolicLink());
        if (entry.isDirectory()) visit(target);
        else { assert.ok(entry.isFile()); files.push(safeSource(path.relative(c.root, target))); }
      }
    };
    visit(c.root); assert.deepEqual(files.sort(), Object.keys(source.files).sort(), 'Archive contains unmanifested files');
  }
  assert.equal(JSON.parse(fs.readFileSync(c.root + '/package.json')).version, c.version);
}
function lockView(file) {
  const value = JSON.parse(fs.readFileSync(file)); delete value.version;
  if (value.packages?.['']) delete value.packages[''].version;
  return value;
}
function runtimeBindings(m, c) {
  for (const [file, target] of Object.entries({ '.env': m.envFile, storage: m.storageRoot,
    'public/uploads': m.uploadsRoot, 'public/videos': m.videosRoot })) {
    const binding = path.join(c.root, file); assert.ok(fs.lstatSync(binding).isSymbolicLink());
    assert.equal(fs.readlinkSync(binding), target); assert.equal(fs.realpathSync(binding), fs.realpathSync(target));
  }
  assert.equal(fs.readFileSync(c.root + '/.deployed-commit', 'utf8').trim(), c.source);
}
function uploadDirectoryIdentity(file) {
  const stat = fs.lstatSync(file);
  return { dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid, gid: stat.gid,
    mode: stat.mode & 0o7777, kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'other' };
}
function verifyUploadHelperProbe(m, c, source, prepared, probe, phase) {
  assert.equal(probe.schema, 'upload-private-directory-candidate-probe.v1'); assert.equal(probe.phase, phase);
  assert.equal(probe.source, c.source); assert.equal(probe.candidateRoot, c.root); assert.equal(probe.helper, UPLOAD_HELPER);
  assert.equal(probe.helperSourceSha256, source.files[UPLOAD_HELPER]);
  assert.equal(probe.returnedCanonical, m.uploadPrivateDirectory.canonical);
  assert.deepEqual(probe.canonicalIdentity, uploadDirectoryIdentity(m.uploadPrivateDirectory.canonical));
  assert.deepEqual(probe.aliasIdentity, uploadDirectoryIdentity(m.uploadPrivateDirectory.alias));
  assert.equal(probe.runtimeUid, Number(call('id', ['-u', m.appUser])));
  assert.equal(probe.runtimeGid, Number(call('id', ['-g', m.appUser])));
  const isolatedDatabase = prepared.buildEnv.DATABASE_URL.slice('file:'.length);
  assert.equal(probe.isolatedDatabase, isolatedDatabase); assert.notEqual(isolatedDatabase, m.database);
  assert.equal(probe.productionDatabaseUsed, false); assert.equal(probe.readOnlyDirectoryProbe, true);
  assert.ok(Number.isSafeInteger(probe.startedAt) && Number.isSafeInteger(probe.finishedAt)
    && probe.finishedAt >= probe.startedAt && probe.finishedAt <= Date.now() + 1000);
  assert.match(probe.stdoutSha256, /^[a-f0-9]{64}$/); return probe;
}
function probeUploadHelper(m, c, source, prepared, phase) {
  assert.ok(['prepare', 'prebuild'].includes(phase)); verifyUploadPrivateDirectory(m);
  const helper = path.join(c.root, UPLOAD_HELPER), helperSourceSha256 = sha(fs.readFileSync(helper));
  assert.equal(helperSourceSha256, source.files[UPLOAD_HELPER], 'Probe only the source-locked upload helper');
  const isolatedDatabase = prepared.buildEnv.DATABASE_URL.slice('file:'.length);
  assert.ok(path.isAbsolute(isolatedDatabase) && isolatedDatabase.startsWith(prepared.preparedRoot + path.sep));
  assert.notEqual(isolatedDatabase, m.database); const databaseStat = fs.lstatSync(isolatedDatabase);
  assert.ok(databaseStat.isFile() && !databaseStat.isSymbolicLink() && databaseStat.nlink === 1
    && databaseStat.uid === Number(call('id', ['-u', m.appUser])) && !(databaseStat.mode & 0o077));
  const beforeCanonical = uploadDirectoryIdentity(m.uploadPrivateDirectory.canonical);
  const beforeAlias = uploadDirectoryIdentity(m.uploadPrivateDirectory.alias), startedAt = Date.now();
  const marker = 'UPLOAD_PRIVATE_DIRECTORY_CANDIDATE_PROBE=';
  const program = String.raw`import fs from 'node:fs';
const helper = await import('./src/lib/assets/verified-upload.ts');
const returnedCanonical = await helper.privateUploadDirectory();
const stat = fs.lstatSync(returnedCanonical);
console.log(${JSON.stringify(marker)} + JSON.stringify({ returnedCanonical, runtimeUid: process.getuid?.(), runtimeGid: process.getgid?.(),
  cwd: process.cwd(), canonicalIdentity: { dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid, gid: stat.gid,
    mode: stat.mode & 0o7777, kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'other' } }));`;
  const output = call('runuser', ['-u', m.appUser, '--', 'env', '-i',
    ...Object.entries(prepared.buildEnv).map(([key, value]) => key + '=' + value), process.execPath,
    '--import', 'tsx', '--input-type=module', '-e', program], { cwd: c.root, timeout: 30000 });
  const lines = output.split(/\r?\n/).filter(line => line.startsWith(marker)); assert.equal(lines.length, 1);
  const observed = JSON.parse(lines[0].slice(marker.length)), finishedAt = Date.now();
  assert.equal(observed.cwd, c.root); assert.equal(observed.returnedCanonical, m.uploadPrivateDirectory.canonical);
  assert.deepEqual(observed.canonicalIdentity, beforeCanonical);
  assert.deepEqual(uploadDirectoryIdentity(m.uploadPrivateDirectory.canonical), beforeCanonical,
    'The production upload helper probe must not alter the canonical directory');
  assert.deepEqual(uploadDirectoryIdentity(m.uploadPrivateDirectory.alias), beforeAlias,
    'The production upload helper probe must not alter the fixed storage alias');
  return verifyUploadHelperProbe(m, c, source, prepared, {
    schema: 'upload-private-directory-candidate-probe.v1', phase, source: c.source, candidateRoot: c.root,
    helper: UPLOAD_HELPER, helperSourceSha256, returnedCanonical: observed.returnedCanonical,
    canonicalIdentity: observed.canonicalIdentity, aliasIdentity: beforeAlias,
    runtimeUid: observed.runtimeUid, runtimeGid: observed.runtimeGid, isolatedDatabase,
    productionDatabaseUsed: false, readOnlyDirectoryProbe: true, startedAt, finishedAt, stdoutSha256: sha(output),
  }, phase);
}
function inputs(m, kind, source) {
  const bytes = rootFile(m.stage + '/' + kind + '-prepared.json'), prepared = JSON.parse(bytes);
  assert.equal(prepared.schema, 'rate-impl2-candidate-prepared.v1'); assert.equal(prepared.label, kind);
  assert.equal(prepared.manifestSha256, sha(rootFile(m.stage + '/manifest.json')));
  assert.equal(prepared.sourceManifestSha256, sha(rootFile(m[kind].sourceManifest)));
  verifyPricingInputs({ candidateRoot: m[kind].root, source: m[kind].source, runId: m.runId,
    appUser: m.appUser, sourceFiles: source.files, prepared });
  verifyUploadHelperProbe(m, m[kind], source, prepared, prepared.uploadHelperProbe, 'prepare');
  runtimeBindings(m, m[kind]); return { prepared, preparedSha256: sha(bytes) };
}
function appBytes(file, root, uid, maximum = 8 * 1024 * 1024) {
  assert.ok(path.isAbsolute(file) && file.startsWith(root + '/.role-tests/')); assert.equal(fs.realpathSync(file), file);
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === uid
    && !(stat.mode & 0o077) && stat.size > 0 && stat.size <= maximum);
  return fs.readFileSync(file);
}
function appReceipt(file, root, uid, maximum = 8 * 1024 * 1024) {
  const bytes = appBytes(file, root, uid, maximum); return { value: JSON.parse(bytes), sha256: sha(bytes) };
}
function compiledTree(c) {
  const root = path.join(c.root, c.buildDist); assert.equal(fs.realpathSync(root), root);
  const files = {};
  const visit = relative => {
    const target = path.join(root, relative), stat = fs.lstatSync(target); assert.ok(!stat.isSymbolicLink());
    if (stat.isDirectory()) for (const name of fs.readdirSync(target).sort()) visit(path.join(relative, name));
    else { assert.ok(stat.isFile() && stat.nlink === 1); files[relative] = sha(fs.readFileSync(target)); }
  };
  visit('server'); visit('static');
  for (const name of fs.readdirSync(root).filter(name => name === 'BUILD_ID' || name.endsWith('.json')).sort()) visit(name);
  const build = fs.readFileSync(root + '/BUILD_ID', 'utf8').trim(); assert.ok(build && build.length <= 256);
  return { build, sha256: sha(JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))))) };
}
function verifyGates(m, kind, source, prepared, receipt) {
  const c = m[kind], uid = Number(call('id', ['-u', m.appUser]));
  const gate = appReceipt(receipt.gateReceipt, c.root, uid);
  assert.equal(gate.value.schema, 'image-recovery-build-gate.v1'); assert.equal(gate.value.completed, true);
  assert.equal(gate.value.runId, m.runId); assert.equal(gate.value.candidateRoot, c.root);
  assert.deepEqual(gate.value.fixtures?.map(item => item.file), IMAGE_FIXTURES,
    'Retain all quality/image/upload/multiview groups and the mandatory HD group');
  for (const [file, schema] of [['scripts/image-size-policy-engineering.ts', 'image-size-policy-engineering.v1'],
    ['scripts/image-provider-error-engineering.ts', 'image-provider-error-engineering.v1']]) {
    const item = gate.value.fixtures.find(entry => entry.file === file);
    assert.ok(item); const child = appReceipt(item.receipt, c.root, uid);
    assert.equal(child.sha256, item.sha256); assert.equal(child.value.schema, schema);
    assert.equal(child.value.synthetic, true); assert.equal(child.value.completed, true);
    assert.equal(child.value.runId, m.runId); assert.equal(child.value.fixtureSha256, source.files[file]);
    for (const [module, digest] of Object.entries(child.value.sourceSha256)) assert.equal(digest, source.files[module]);
    for (const key of ['forbiddenCalls', 'productionWrites', 'paidRequests', 'browserRuns']) assert.equal(child.value[key], 0);
    assert.ok(Array.isArray(child.value.checks) && child.value.checks.length > 0);
    assert.ok(timestamp(child.value.startedAt) >= gate.value.startedAt
      && timestamp(child.value.finishedAt) >= timestamp(child.value.startedAt)
      && timestamp(child.value.finishedAt) <= gate.value.finishedAt + 1000);
  }
  const admin = gate.value.publicUsageFixtures?.find(entry => entry.file === 'scripts/image-provider-admin-engineering.ts');
  assert.ok(admin); const adminReceipt = appReceipt(admin.receipt, c.root, uid);
  assert.equal(adminReceipt.sha256, admin.sha256); assert.equal(adminReceipt.value.schema, 'image-provider-admin-engineering.v1');
  assert.equal(adminReceipt.value.synthetic, true); assert.equal(adminReceipt.value.completed, true);
  assert.equal(adminReceipt.value.applicationDatabaseOpened, false);
  for (const [module, digest] of Object.entries(adminReceipt.value.sourceSha256)) assert.equal(digest, source.files[module]);
  for (const key of ['forbiddenCalls', 'paidRequests', 'browserRuns']) assert.equal(adminReceipt.value[key], 0);
  const hd = gate.value.fixtures.find(item => item.file === 'scripts/hd-chain-engineering.mjs');
  assert.ok(hd); const hdReceipt = appReceipt(hd.receipt, c.root, uid);
  assert.equal(hdReceipt.sha256, hd.sha256); assert.equal(hdReceipt.value.schema, 'hd-chain-engineering.v1');
  assert.equal(hdReceipt.value.completed, true); assert.equal(hdReceipt.value.synthetic, true);
  assert.equal(hdReceipt.value.runId, m.runId); assert.equal(hdReceipt.value.candidateRoot, c.root);
  assert.equal(hdReceipt.value.productionHdRootPassedToFixtures, false);
  assert.equal(hdReceipt.value.fixtureSha256, source.files['scripts/hd-chain-engineering.mjs']);
  assert.ok(Object.keys(hdReceipt.value.sourceSha256).length >= 30);
  for (const [file, digest] of Object.entries(hdReceipt.value.sourceSha256)) assert.equal(digest, source.files[file]);
  assert.deepEqual(hdReceipt.value.outcomes.map(item => item.file), ['scripts/test-hd-stability.ts',
    'scripts/hd-backend-engineering.ts', 'scripts/test-hd-display.ts', 'scripts/hd-registration-engineering.ts', 'scripts/hd-admin-engineering.ts']);
  for (const item of hdReceipt.value.outcomes) {
    assert.equal(item.completed, true); assert.equal(item.exitCode, 0); assert.equal(item.signal, null); assert.equal(item.failure, null);
    assert.equal(item.logSha256, sha(appBytes(item.log, c.root, uid)));
    const safety = appReceipt(item.safetyReceipt, c.root, uid); assert.equal(safety.sha256, item.safetySha256);
    for (const key of ['forbiddenCalls', 'refusedWrites', 'productionWrites', 'paidRequests', 'browserRuns']) assert.equal(safety.value[key], 0);
    assert.equal(safety.value.hdRootAtImport, null);
  }
  for (const key of ['forbiddenCalls', 'productionWrites', 'paidRequests', 'browserRuns']) assert.equal(hdReceipt.value[key], 0);
  assert.ok(timestamp(hdReceipt.value.startedAt) >= gate.value.startedAt
    && timestamp(hdReceipt.value.finishedAt) >= timestamp(hdReceipt.value.startedAt)
    && timestamp(hdReceipt.value.finishedAt) <= gate.value.finishedAt + 1000);
  const upload = gate.value.fixtures.find(item => item.file === 'scripts/upload-recovery-engineering.mjs');
  assert.ok(upload); const uploadReceipt = appReceipt(upload.receipt, c.root, uid);
  assert.equal(uploadReceipt.sha256, upload.sha256); assert.equal(uploadReceipt.value.schema, 'upload-recovery-engineering.v1');
  assert.equal(uploadReceipt.value.synthetic, true); assert.equal(uploadReceipt.value.completed, true);
  assert.equal(uploadReceipt.value.runId, m.runId); assert.deepEqual(uploadReceipt.value.checks, UPLOAD_FIXTURE_CHECKS);
  assert.equal(uploadReceipt.value.fixtureSha256, source.files['scripts/upload-recovery-engineering.mjs']);
  assert.deepEqual(Object.keys(uploadReceipt.value.sourceSha256).sort(), [...UPLOAD_FIXTURE_SOURCES].sort());
  for (const file of UPLOAD_FIXTURE_SOURCES) assert.equal(uploadReceipt.value.sourceSha256[file], source.files[file]);
  for (const key of ['forbiddenCalls', 'productionWrites', 'paidRequests', 'browserRuns']) assert.equal(uploadReceipt.value[key], 0, key);
  assert.ok(timestamp(uploadReceipt.value.startedAt) >= gate.value.startedAt
    && timestamp(uploadReceipt.value.finishedAt) >= timestamp(uploadReceipt.value.startedAt)
    && timestamp(uploadReceipt.value.finishedAt) <= gate.value.finishedAt + 1000);
  const multiview = gate.value.fixtures.find(item => item.file === 'scripts/multiview-settings-batch-engineering.mjs');
  assert.ok(multiview); const multiviewReceipt = appReceipt(multiview.receipt, c.root, uid);
  assert.equal(multiviewReceipt.sha256, multiview.sha256);
  assert.equal(multiviewReceipt.value.schema, 'multiview-settings-batch-engineering.v1');
  assert.equal(multiviewReceipt.value.synthetic, true); assert.equal(multiviewReceipt.value.completed, true);
  assert.equal(multiviewReceipt.value.runId, m.runId); assert.equal(multiviewReceipt.value.candidateRoot, c.root);
  const multiviewChecks = [...MULTIVIEW_FIXTURE_CHECKS,
    'authorized_multiview_original_transport'];
  assert.deepEqual(multiviewReceipt.value.checks, multiviewChecks);
  assert.equal(multiviewReceipt.value.fixtureSha256, source.files['scripts/multiview-settings-batch-engineering.mjs']);
  const multiviewSources = [...MULTIVIEW_FIXTURE_SOURCES, ...MULTIVIEW_TRANSPORT_SOURCES];
  assert.deepEqual(Object.keys(multiviewReceipt.value.sourceSha256).sort(), multiviewSources.sort());
  for (const file of multiviewSources) assert.equal(multiviewReceipt.value.sourceSha256[file], source.files[file]);
  for (const key of ['forbiddenCalls', 'productionWrites', 'paidRequests', 'browserRuns']) assert.equal(multiviewReceipt.value[key], 0, key);
  assert.ok(timestamp(multiviewReceipt.value.startedAt) >= gate.value.startedAt
    && timestamp(multiviewReceipt.value.finishedAt) >= timestamp(multiviewReceipt.value.startedAt)
    && timestamp(multiviewReceipt.value.finishedAt) <= gate.value.finishedAt + 1000);
  assert.deepEqual(multiviewReceipt.value.outcomes?.map(item => item.name), multiviewChecks);
  for (const item of multiviewReceipt.value.outcomes) {
    assert.equal(item.exitCode, 0); assert.equal(item.completed, true); assert.equal(item.failure, null);
    assert.equal(item.logSha256, sha(appBytes(item.log, c.root, uid)));
  }
  for (const value of [gate.value, appReceipt(gate.value.pricingReceipt, c.root, uid).value]) {
    assert.equal(value.runId, m.runId); assert.equal(value.candidateRoot, c.root);
    assert.ok(value.startedAt >= receipt.startedAt && value.finishedAt >= value.startedAt && value.finishedAt <= receipt.finishedAt);
    assert.ok(Date.now() - value.startedAt < 30 * 60_000, 'The complete candidate gate is stale');
  }
  const pricing = verifyPricingGateReceipt({ candidateRoot: c.root, source: c.source, runId: m.runId,
    appUser: m.appUser, sourceFiles: source.files, receipt: gate.value.pricingReceipt, since: receipt.startedAt });
  const output = call('runuser', ['-u', m.appUser, '--', 'env', '-i',
    ...Object.entries(prepared.buildEnv).map(([key, value]) => key + '=' + value),
    'node', 'scripts/check-image-recovery.mjs', '--verify', receipt.gateReceipt, '--since', String(receipt.startedAt)],
  { cwd: c.root, timeout: 60000 });
  assert.match(output, /Image recovery build gate verified/);
  assert.equal(appReceipt(receipt.gateReceipt, c.root, uid).sha256, gate.sha256);
  return { imageReceiptSha256: gate.sha256, pricing };
}

export async function prepareCandidate(m, kind) {
  assertControlPreflight(m);
  if (m.reuseBuilds) { validateManifest(m); assertReleaseWindow(m); requireOriginalLive(m); verifyUploadPrivateDirectory(m); return prepareReusedCandidate(m, kind); }
  const info = context(m, kind), { c, source } = info;
  assertReleaseWindow(m); requireOriginalLive(m); const before = readProtection(m);
  absent(m.stage + '/' + kind + '-prepared.json');
  const parent = path.dirname(c.root);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o755 }); directory(parent); absent(c.root);
  assert.equal(sha(rootFile(c.archive, 512 * 1024 * 1024)), source.archiveSha256);
  await verifyRateSourceArchive({ archive: c.archive, manifest: source });
  assertReleaseWindow(m); requireOriginalLive(m);
  fs.mkdirSync(c.root, { mode: 0o755 });
  const previousUmask = process.umask(0o022);
  try { call('tar', ['-xzf', c.archive, '--no-same-owner', '--no-same-permissions', '-C', c.root], { timeout: 120000 }); }
  finally { process.umask(previousUmask); }
  sourceCheck(c, source, true);
  assertProtectedIncrementCandidate(m, kind, fs.readFileSync);
  const dependencyRoot = m.fullRelease ? m.live.hd.root : m.live.web.root;
  const nextLock = lockView(c.root + '/package-lock.json'), liveLock = lockView(dependencyRoot + '/package-lock.json');
  if (m.fullRelease?.dependencyAdoption) assertFullDependencyAdoption(m, nextLock, liveLock, dependencyRoot);
  else assert.deepEqual(nextLock, liveLock, 'Dependencies differ from the actual online 2a lock');
  assert.ok(fs.lstatSync(dependencyRoot + '/node_modules').isDirectory());
  call('cp', ['-a', dependencyRoot + '/node_modules', c.root + '/node_modules'], { timeout: 300000 });
  fs.symlinkSync(m.envFile, c.root + '/.env'); fs.symlinkSync(m.storageRoot, c.root + '/storage');
  fs.mkdirSync(c.root + '/public', { recursive: true });
  for (const [name, target] of Object.entries({ uploads: m.uploadsRoot, videos: m.videosRoot })) {
    absent(c.root + '/public/' + name); fs.symlinkSync(target, c.root + '/public/' + name);
  }
  absent(c.root + '/.deployed-commit'); fs.writeFileSync(c.root + '/.deployed-commit', c.source + '\n', { flag: 'wx', mode: 0o644 });
  const uid = Number(call('id', ['-u', m.appUser])), gid = Number(call('id', ['-g', m.appUser]));
  assert.ok(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0);
  // Chown only before the root/i fixtures exist; -hR does not follow runtime bindings.
  for (const name of fs.readdirSync(c.root)) call('chown', ['-hR', uid + ':' + gid, path.join(c.root, name)], { timeout: 120000 });
  assertReleaseWindow(m);
  const prepared = preparePricingInputs({ candidateRoot: c.root, source: c.source, runId: m.runId,
    appUser: m.appUser, sourceFiles: source.files });
  const uploadHelperProbe = probeUploadHelper(m, c, source, prepared, 'prepare');
  const hdHelperProbe = await probeHdCandidateResolver(m, c, prepared, { phase: 'prepare' });
  const hdReconciliation = await inspectHdReconciliation(m, { sourceRoot: c.root,
    ...(isSharedEngine(m) ? sharedReadOnlyHdBounds(m) : {}) });
  assert.equal(hdReconciliation.issues.length, 0, 'HD roots contain an unexplained identity/receipt conflict');
  sourceCheck(c, source); runtimeBindings(m, c); requireOriginalLive(m); assertProtection(before, readProtection(m));
  const result = { schema: 'rate-impl2-candidate-prepared.v1', label: kind, version: c.version, ...prepared, uploadHelperProbe,
    hdHelperProbe, hdReconciliation,
    manifestSha256: info.manifestSha256, sourceManifestSha256: info.sourceManifestSha256,
    preparedAt: new Date().toISOString(), productionDatabaseCopied: false, servicesChanged: false };
  writeJsonExclusive(m.stage + '/' + kind + '-prepared.json', result); return result;
}

export async function buildCandidate(m, kind) {
  assertControlPreflight(m);
  if (m.reuseBuilds) { validateManifest(m); assertReleaseWindow(m); return verifyReusedCandidate(m, kind); }
  const info = context(m, kind), { c, source } = info;
  assertReleaseWindow(m); requireOriginalLive(m); sourceCheck(c, source);
  assertProtectedIncrementCandidate(m, kind, fs.readFileSync);
  const { prepared, preparedSha256 } = inputs(m, kind, source), before = readProtection(m);
  const uploadHelperProbe = probeUploadHelper(m, c, source, prepared, 'prebuild');
  const hdHelperProbe = await probeHdCandidateResolver(m, c, prepared, { phase: 'prebuild' });
  absent(m.stage + '/' + kind + '-build.json'); absent(c.root + '/' + c.buildDist);
  const logFile = m.stage + '/' + kind + '-build.log', fd = fs.openSync(logFile, 'wx', 0o600), startedAt = Date.now();
  let result, commandError;
  try {
    assertReleaseWindow(m);
    result = spawnSync('runuser', ['-u', m.appUser, '--', 'env', '-i',
      ...Object.entries(prepared.buildEnv).map(([key, value]) => key + '=' + value), 'npm', 'run', 'build'],
    { cwd: c.root, stdio: ['ignore', fd, fd], env: { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, timeout: 30 * 60_000 });
  } catch (error) { commandError = error; }
  finally { fs.fsyncSync(fd); fs.closeSync(fd); }
  const finishedAt = Date.now(), exitCode = result?.status ?? 125;
  writeJsonExclusive(m.stage + '/' + kind + '-build-command.json', {
    schema: 'sd2-original-build-command.v1', runId: m.runId, label: kind,
    manifestSha256: info.manifestSha256, source: c.source, startedAt, finishedAt,
    status: result?.status ?? null, signal: result?.signal ?? null,
    error: commandError ? String(commandError) : result?.error?.message || null,
    errorCode: commandError?.code || result?.error?.code || null,
    buildEnvironmentSha256: sha(JSON.stringify(prepared.buildEnv)),
    logFile, logSha256: sha(fs.readFileSync(logFile)), originalExitRecordedBeforePostchecks: true,
  });
  if (commandError) throw commandError;
  if (result.error || result.signal || exitCode !== 0) {
    writeJsonExclusive(m.stage + '/' + kind + '-build-failed.json', { schema: 'rate-impl2-candidate-build-failure.v1',
      label: kind, source: c.source, runId: m.runId, manifestSha256: info.manifestSha256, startedAt, finishedAt,
      exitCode, signal: result.signal, error: result.error?.message, logFile, completed: false });
    throw new Error('Full candidate build failed; retain its log and isolated inputs, do not switch services');
  }
  const logBytes = rootFile(logFile), lines = logBytes.toString('utf8').split(/\r?\n/);
  const image = lines.filter(line => line.startsWith('IMAGE_RECOVERY_GATE_RECEIPT='));
  const pricing = lines.filter(line => line.startsWith('PRICING_POLICY_GATE_RECEIPT='));
  assert.equal(image.length, 1); assert.equal(pricing.length, 1, 'The same full npm build must emit both native gate receipts');
  const built = compiledTree(c);
  const hdCompiledCache = isSharedEngine(m) ? captureHdCompiledCache(m, kind, prepared) : undefined;
  const proof = { schema: BUILD_SCHEMA, label: kind, source: c.source, version: c.version, build: built.build, runId: m.runId,
    ...(isSharedEngine(m) ? { engine: m.engine, operation: m.operation } : {}),
    manifestSha256: info.manifestSha256, startedAt, finishedAt, exitCode: 0,
    gateReceipt: image[0].slice('IMAGE_RECOVERY_GATE_RECEIPT='.length), verifiedSourceAndGates: true,
    sourceManifestSha256: info.sourceManifestSha256, preparedSha256, compiledTreeSha256: built.sha256,
    uploadHelperProbe, hdHelperProbe, ...(hdCompiledCache ? { hdCompiledCache } : {}), logFile, logSha256: sha(logBytes) };
  const gates = verifyGates(m, kind, source, prepared, proof);
  assert.equal(gates.pricing.receipt, pricing[0].slice('PRICING_POLICY_GATE_RECEIPT='.length));
  verifyPricingInputs({ candidateRoot: c.root, source: c.source, runId: m.runId, appUser: m.appUser, sourceFiles: source.files, prepared });
  sourceCheck(c, source); assert.deepEqual(compiledTree(c), built); requireOriginalLive(m); assertProtection(before, readProtection(m));
  writeJsonExclusive(m.stage + '/' + kind + '-build.json', proof);
  await sealOriginalSuccess(m, kind);
  return proof;
}

export async function verifyCandidate(m, kind) {
  if (m.reuseBuilds) { validateManifest(m); verifyUploadPrivateDirectory(m); return verifyReusedCandidate(m, kind); }
  const info = context(m, kind), { c, source } = info;
  if (m.fullRelease) verifyFullCandidateSources(m);
  sourceCheck(c, source); assertProtectedIncrementCandidate(m, kind, fs.readFileSync);
  const { prepared, preparedSha256 } = inputs(m, kind, source);
  const value = JSON.parse(rootFile(m.stage + '/' + kind + '-build.json'));
  assert.equal(value.schema, BUILD_SCHEMA); assert.equal(value.label, kind); assert.equal(value.source, c.source);
  assert.equal(value.version, c.version); assert.equal(value.runId, m.runId); assert.equal(value.manifestSha256, info.manifestSha256);
  assert.equal(value.sourceManifestSha256, info.sourceManifestSha256); assert.equal(value.preparedSha256, preparedSha256);
  verifyUploadHelperProbe(m, c, source, prepared, value.uploadHelperProbe, 'prebuild');
  verifyHdCandidateResolver(m, c, prepared, value.hdHelperProbe, { phase: 'prebuild' });
  if (isSharedEngine(m)) verifyHdCompiledCacheReceipt(m, kind, value.hdCompiledCache);
  assert.equal(value.exitCode, 0); assert.equal(value.verifiedSourceAndGates, true);
  assert.ok(Number.isSafeInteger(value.startedAt) && value.startedAt > 0 && Number.isSafeInteger(value.finishedAt)
    && value.finishedAt >= value.startedAt && value.finishedAt <= Date.now() + 1000);
  assert.ok(Date.now() - value.startedAt < 30 * 60_000, 'Full candidate build is stale');
  assert.equal(value.logFile, m.stage + '/' + kind + '-build.log'); assert.equal(sha(rootFile(value.logFile)), value.logSha256);
  const built = compiledTree(c); assert.equal(value.build, built.build); assert.equal(value.compiledTreeSha256, built.sha256);
  verifyGates(m, kind, source, prepared, value); sourceCheck(c, source);
  assert.deepEqual(compiledTree(c), built, 'Compiled output changed during native receipt verification');
  return value;
}

