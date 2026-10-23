import { MV_DIRECT } from './release-contract.mjs';
import { releaseDependencyRoot } from './full-release-contract.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readHdStorageProtection, assertHdStorageProtection, inspectHdReconciliation, inspectHdBeforeMaintenance,
  createProtectedDiscoveryContinuation, readHdCompiledCacheProofs } from './hd-storage-preflight.mjs';
import { APPROVED_HD_LEGACY_READY, APPROVED_HD_HISTORICAL_VERSIONS } from './hd-legacy-ready-allowlist.mjs';

// No supplied DB, production media, service, network, or release is used. The
// actual site/resolver sources and installed Sharp are read from the source cwd.
process.exitCode = 1;
async function main() {
  const pinnedDependencyRoot = releaseDependencyRoot(MV_DIRECT);
  const applicationRoot = fs.realpathSync(process.argv[2] || (MV_DIRECT.fullRelease ? pinnedDependencyRoot : process.cwd()));
  if (MV_DIRECT.fullRelease) assert.equal(applicationRoot, pinnedDependencyRoot, 'FULL HD engineering must use the pinned HD dependency role');
  const require = createRequire(path.join(applicationRoot, 'package.json')), sharp = require('sharp');
  const tsx = require.resolve('tsx');
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-hd-storage-engineering-')));
  fs.chmodSync(directory, 0o700);
  const previousEnv = process.env.NODE_ENV; process.env.NODE_ENV = 'test';
  const previousMask = process.umask(0o077), checks = [];
  // Only the isolated fixture owns this process projection. Keep actual /proc
  // reads for self and every live child used by the owner/lease negative cases.
  const originalProcReaddir = fs.readdirSync, fixtureProcessIds = new Set([process.pid]);
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const project = path.join(directory, 'project');
  const m = { projectRoot: project, hdStorageIsolationRoot: directory,
    hdRoot: project + '/var-lib/storage/hd-derivatives',
    hdForkRoot: project + '/releases/5a59c00aaba195c42d90c612a37224ad59b12ee0/storage/hd-derivatives',
    hdWorkerLockPath: project + '/var-lib/storage/hd-worker.lock', uploadsRoot: project + '/var-lib/uploads',
    storageRoot: project + '/releases/80d5cf6f1ec489ea93257d42e8dd5c7e4e782560/storage', publicOrigin: 'https://sd2.youdooart.com' };
  try {
    fs.readdirSync = function (target, ...args) {
      const entries = originalProcReaddir.call(this, target, ...args);
      return target === '/proc' ? entries.filter(name => !/^\d+$/.test(name) || fixtureProcessIds.has(Number(name))) : entries;
    };
    for (const dir of [m.hdRoot, m.hdForkRoot, m.uploadsRoot, m.storageRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(m.hdWorkerLockPath, '', { mode: 0o600 });
    const roots = [path.join(directory, 'source-a'), path.join(directory, 'source-b')];
    for (const root of roots) {
      fs.mkdirSync(path.join(root, 'public'), { recursive: true });
      fs.mkdirSync(path.join(root, 'src/lib/assets'), { recursive: true });
      fs.mkdirSync(path.join(root, 'src/lib/media'), { recursive: true });
      fs.symlinkSync(m.uploadsRoot, path.join(root, 'public/uploads'));
      fs.symlinkSync(path.join(applicationRoot, 'node_modules'), path.join(root, 'node_modules'));
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
      for (const file of ['src/lib/assets/site-url.ts', 'src/lib/media/hd-storage-root.ts']) {
        const original = fs.readFileSync(path.join(applicationRoot, file));
        fs.writeFileSync(path.join(root, file), original);
        assert.equal(sha(fs.readFileSync(path.join(root, file))), sha(original));
      }
    }
    const resolver = String.raw`import assert from 'node:assert/strict';
const imported=await import('./src/lib/media/hd-storage-root.ts'),core=imported.default||imported;
const input=JSON.parse(process.argv[1]);
for(const cwd of input.roots)assert.equal(core.resolveHdDirectory({cwd,env:{NODE_ENV:'test',HD_DERIVATIVES_ROOT:input.root}}),input.root);
for(const cwd of input.roots)assert.equal(core.resolveHdDirectory({cwd,env:{NODE_ENV:'production',HD_DERIVATIVES_ROOT:core.HD_CANONICAL_ROOT}}),core.HD_CANONICAL_ROOT);
assert.throws(()=>core.resolveHdDirectory({env:{NODE_ENV:'production',HD_DERIVATIVES_ROOT:input.root}}));
await core.assertHdStorageRoot();assert.equal(core.hdWorkerLockPath(),input.lock);
console.log(JSON.stringify({sameCanonical:true,productionRefusesPrivateRoot:true,readOnly:true}));`;
    const resolverOutput = execFileSync(process.execPath, ['--import', tsx, '--input-type=module', '-e', resolver,
      JSON.stringify({ roots, root: m.hdRoot, lock: m.hdWorkerLockPath })], { cwd: roots[0], encoding: 'utf8', timeout: 30000,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', NODE_ENV: 'test', TSX_DISABLE_CACHE: '1', HD_DERIVATIVES_ROOT: m.hdRoot } });
    assert.deepEqual(JSON.parse(resolverOutput.trim()), { sameCanonical: true, productionRefusesPrivateRoot: true, readOnly: true });
    checks.push('actual_resolver_two_cwds_share_canonical_without_loosening_production');

    const original = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 43, g: 87, b: 112 } } }).png().toBuffer();
    const originalFile = path.join(m.uploadsRoot, 'synthetic.png'); fs.writeFileSync(originalFile, original);
    const createJob = (file, preserveText = true) => {
      const stat = fs.statSync(file), version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      const key = sha(JSON.stringify({ file: fs.realpathSync(file), version, policy: 'hd-f-v1',
        format: 'alpha-or-text-lossless-webp-otherwise-avif', q: 95, chroma: '4:4:4', effort: 6,
        orientation: 'auto', color: '8bit-srgb', library: sharp.versions, preserveText }));
      return { key, source: '/uploads/' + path.basename(file), version, policy: 'hd-f-v1', preserveText,
        priority: 0, status: 'queued', attempts: 0, updatedAt: new Date().toISOString() };
    };
    const save = (root, job) => fs.writeFileSync(path.join(root, job.key + '.json'), JSON.stringify(job), { mode: 0o600 });
    const integrity = (format = 'webp') => ({ version: 'hd-output-integrity-v2', failedChecks: [], checks: {
      output_metadata: { expected: 'readable', actual: 'readable', ok: true }, width: { expected: 16, actual: 16, ok: true },
      height: { expected: 16, actual: 16, ok: true }, alpha: { expected: false, actual: false, ok: true },
      pages: { expected: 1, actual: 1, ok: true }, color: { expected: 'srgb', actual: 'srgb', ok: true },
      bitdepth: { expected: 8, actual: 8, ok: true }, depth: { expected: 'uchar', actual: 'uchar', ok: true },
      format: { expected: format, actual: format, ok: true }, output_full_decode: { expected: 'complete', actual: 'complete', ok: true },
    } });
    const queued = createJob(originalFile), compressed = await sharp(original).webp({ lossless: true }).toBuffer();
    await sharp(compressed).stats();
    const outputFile = path.join(m.hdRoot, queued.key + '.webp'); fs.writeFileSync(outputFile, compressed);
    const ready = { ...queued, status: 'ready', format: 'webp', mime: 'image/webp', file: queued.key + '.webp',
      bytes: compressed.length, width: 16, height: 16, integrity: integrity() };
    save(m.hdRoot, ready); save(m.hdForkRoot, queued);
    fs.writeFileSync(path.join(m.hdRoot, 'control.json'), JSON.stringify({ paused: true, reason: 'admin_pause' }));
    fs.writeFileSync(path.join(m.hdForkRoot, 'control.json'), JSON.stringify({ paused: false }));
    const protectedReady = readHdStorageProtection(m), beforeControl = fs.readFileSync(path.join(m.hdRoot, 'control.json'));
    const initial = await inspectHdReconciliation(m, { sourceRoot: roots[0], final: true });
    assert.equal(initial.safe, true); assert.equal(initial.unstable, false);
    assert.deepEqual(fs.readFileSync(path.join(m.hdRoot, 'control.json')), beforeControl);
    assert.equal(JSON.parse(fs.readFileSync(path.join(m.hdRoot, queued.key + '.json'))).status, 'ready');
    assert.equal(JSON.parse(fs.readFileSync(path.join(m.hdForkRoot, queued.key + '.json'))).status, 'queued');
    save(m.hdRoot, { ...ready, priority: 1, queueRole: 'viewer', stage: 'queued', updatedAt: new Date().toISOString() });
    assert.equal(assertHdStorageProtection(protectedReady, readHdStorageProtection(m)), true);
    assert.equal((await inspectHdReconciliation(m, { sourceRoot: roots[1], final: true })).safe, true);
    checks.push('ready_reused_fork_queued_never_overwrites_and_mutable_scheduling_is_not_frozen');

    const newFile = path.join(m.uploadsRoot, 'queued.png'); fs.writeFileSync(newFile, original);
    const pending = createJob(newFile); save(m.hdRoot, pending); save(m.hdForkRoot, pending);
    assert.equal((await inspectHdReconciliation(m, { sourceRoot: roots[0], final: true })).safe, true);
    checks.push('same_identity_canonical_and_fork_queued_are_legitimate_pending_work');

    const unique = createJob(originalFile, false); save(m.hdForkRoot, unique);
    const uniqueResult = await inspectHdReconciliation(m, { sourceRoot: roots[0], final: true });
    assert.equal(uniqueResult.safe, false); assert.ok(uniqueResult.issues.some(item => item.code === 'fork_unique_key' && item.key === unique.key));
    fs.unlinkSync(path.join(m.hdForkRoot, unique.key + '.json'));
    save(m.hdForkRoot, { ...pending, version: 'synthetic-conflicting-version' });
    const conflict = await inspectHdReconciliation(m, { sourceRoot: roots[0], final: true });
    assert.equal(conflict.safe, false); assert.ok(conflict.issues.some(item => item.code === 'same_key_source_conflict' && item.key === pending.key));
    save(m.hdForkRoot, pending);
    checks.push('fork_unique_and_real_same_key_source_conflicts_refuse_without_selecting_a_winner');

    const publish = path.join(m.hdRoot, pending.key + '.publish.json'); fs.writeFileSync(publish, JSON.stringify({ unknown: true }));
    const prefinal = await inspectHdReconciliation(m, { sourceRoot: roots[0], final: false });
    assert.equal(prefinal.safe, false); assert.equal(prefinal.unstable, true);
    const final = await inspectHdReconciliation(m, { sourceRoot: roots[0], final: true });
    assert.equal(final.safe, false); assert.ok(final.issues.some(item => item.code === 'publish_receipt_present'));
    fs.unlinkSync(publish);
    const lease = path.join(m.hdForkRoot, pending.key + '.lock'); fs.mkdirSync(lease);
    assert.equal((await inspectHdReconciliation(m, { sourceRoot: roots[0], final: true })).safe, false); fs.rmdirSync(lease);
    save(m.hdRoot, { ...pending, processor: { executionId: randomUUID() } });
    assert.equal((await inspectHdReconciliation(m, { sourceRoot: roots[0], final: true })).safe, false); save(m.hdRoot, pending);
    checks.push('unknown_publish_lease_and_execution_stay_unstable_and_final_refuses');

    const bindingBefore = readHdStorageProtection(m), held = m.hdRoot + '.held';
    fs.renameSync(m.hdRoot, held); fs.mkdirSync(m.hdRoot, { mode: 0o700 });
    assert.throws(() => assertHdStorageProtection(bindingBefore, readHdStorageProtection(m)), /binding changed/);
    fs.rmdirSync(m.hdRoot); fs.renameSync(held, m.hdRoot);
    checks.push('actual_directory_inode_binding_changes_are_rejected');

    const old = readHdStorageProtection(m), heldOutput = outputFile + '.held';
    fs.renameSync(outputFile, heldOutput);
    assert.throws(() => readHdStorageProtection(m)); fs.renameSync(heldOutput, outputFile);
    const beforeRewrite = readHdStorageProtection(m);
    fs.writeFileSync(outputFile, Buffer.alloc(compressed.length, 41));
    assert.throws(() => assertHdStorageProtection(beforeRewrite, readHdStorageProtection(m)), /output changed/);
    fs.writeFileSync(outputFile, compressed);
    save(m.hdRoot, { ...ready, width: 17 }); assert.throws(() => readHdStorageProtection(m)); save(m.hdRoot, ready);
    assert.throws(() => assertHdStorageProtection(old, readHdStorageProtection(m)), /output changed/);
    checks.push('old_ready_missing_same_length_rewrite_and_contract_corruption_never_pass');

    const legacyOriginal = path.join(m.uploadsRoot, 'legacy-original.png'); fs.writeFileSync(legacyOriginal, original);
    const legacyQueued = createJob(legacyOriginal, false);
    const legacyBytes = await sharp(original).avif({ quality: 95, chromaSubsampling: '4:4:4', effort: 6 }).toBuffer();
    const legacyFile = path.join(m.hdRoot, legacyQueued.key + '.avif'); fs.writeFileSync(legacyFile, legacyBytes);
    const legacy = { ...legacyQueued, status: 'ready', format: 'avif', mime: 'image/avif', file: legacyQueued.key + '.avif',
      bytes: legacyBytes.length, width: 16, height: 16 };
    save(m.hdRoot, legacy);
    const approvalFor = value => {
      const stat = fs.statSync(m.hdRoot);
      return { schema: 'hd-legacy-ready-approval-v1', inventorySchema: 'hd-legacy-ready-inventory-v1',
        inventorySha256: sha('Synthetic isolated approval, never a production inventory'), canonicalRoot: m.hdRoot,
        binding: { dev: String(stat.dev), ino: String(stat.ino) }, count: 1, observedAt: new Date().toISOString(), sourceObserved: 'a'.repeat(40),
        entries: { [value.key]: { manifestSha256: sha(fs.readFileSync(path.join(m.hdRoot, value.key + '.json'))),
          sourceVersion: value.version, sourceIdentitySha256: sha(fs.realpathSync(legacyOriginal)) } } };
    };
    const approved = approvalFor(legacy); m.hdLegacyReady = approved;
    const legacyManifest = fs.readFileSync(path.join(m.hdRoot, legacy.key + '.json'));
    const legacyProtection = readHdStorageProtection(m);
    assert.equal(legacyProtection.readyByKey[legacy.key].legacy.manifestSha256, sha(legacyManifest));
    const acceptedLegacy = await inspectHdReconciliation(m, { sourceRoot: roots[0], final: true });
    assert.equal(acceptedLegacy.safe, true);
    assert.deepEqual(acceptedLegacy.legacyMetadata, { required: 1, checked: 1, failed: 0, method: 'sharp-metadata-only', fullPixelDecode: false });
    assert.deepEqual(fs.readFileSync(path.join(m.hdRoot, legacy.key + '.json')), legacyManifest);
    assert.deepEqual(fs.readFileSync(legacyFile), legacyBytes);
    assert.equal(assertHdStorageProtection(legacyProtection, readHdStorageProtection(m)), true);
    fs.unlinkSync(path.join(m.hdRoot, legacy.key + '.json'));
    assert.throws(() => readHdStorageProtection(m), /historical output disappeared/);
    save(m.hdRoot, legacy);
    checks.push('explicit_existing_legacy_ready_reused_with_actual_avif_metadata_and_no_mutation');

    const unknownOriginal = path.join(m.uploadsRoot, 'unapproved-original.png'); fs.writeFileSync(unknownOriginal, original);
    const unknownQueued = createJob(unknownOriginal, false);
    const unknown = { ...legacy, ...unknownQueued, status: 'ready', file: unknownQueued.key + '.avif' };
    save(m.hdRoot, unknown); fs.writeFileSync(path.join(m.hdRoot, unknown.file), legacyBytes);
    assert.throws(() => readHdStorageProtection(m), /hd_ready_protection_failed/);
    fs.unlinkSync(path.join(m.hdRoot, unknown.key + '.json')); fs.unlinkSync(path.join(m.hdRoot, unknown.file));
    save(m.hdForkRoot, legacy); fs.writeFileSync(path.join(m.hdForkRoot, legacy.file), legacyBytes);
    const forkLegacy = await inspectHdReconciliation(m, { sourceRoot: roots[0], final: true });
    assert.equal(forkLegacy.safe, false); assert.ok(forkLegacy.issues.some(item => item.role === 'fork' && item.key === legacy.key));
    fs.unlinkSync(path.join(m.hdForkRoot, legacy.key + '.json')); fs.unlinkSync(path.join(m.hdForkRoot, legacy.file));
    checks.push('unknown_legacy_keys_and_noncanonical_ready_cannot_use_the_exception');

    for (const [field, value] of [['protocol', 'hd-job-v2'], ['executionId', randomUUID()],
      ['processor', { executionId: randomUUID() }], ['attemptHistory', []], ['stage', 'queued']]) {
      const forged = { ...legacy, [field]: value }; save(m.hdRoot, forged);
      // Even a synthetic matching raw SHA cannot make a modern record legacy.
      m.hdLegacyReady = approvalFor(forged);
      assert.throws(() => readHdStorageProtection(m), /hd_ready_protection_failed/);
    }
    save(m.hdRoot, { ...legacy, integrity: null }); m.hdLegacyReady = approvalFor({ ...legacy, integrity: null });
    assert.throws(() => readHdStorageProtection(m), /hd_ready_protection_failed/);
    save(m.hdRoot, legacy); m.hdLegacyReady = approved;
    checks.push('deleting_integrity_cannot_downgrade_protocol_execution_or_history_records');

    assert.ok(Object.isFrozen(APPROVED_HD_LEGACY_READY) && Object.isFrozen(APPROVED_HD_LEGACY_READY.entries));
    const tamperedProduction = JSON.parse(JSON.stringify(APPROVED_HD_LEGACY_READY)); tamperedProduction.inventorySha256 = '0'.repeat(64);
    // This fails at the literal approval gate before platform/path access. It
    // therefore cannot touch production even when the fixture runs as root.
    assert.throws(() => readHdStorageProtection({ ...m, hdStorageIsolationRoot: undefined, hdLegacyReady: tamperedProduction }), /root-approved inventory/);
    const wrongManifest = JSON.parse(JSON.stringify(approved)); wrongManifest.entries[legacy.key].manifestSha256 = '0'.repeat(64);
    m.hdLegacyReady = wrongManifest; assert.throws(() => readHdStorageProtection(m), /hd_ready_protection_failed/);
    m.hdLegacyReady = approved; save(m.hdRoot, { ...legacy, priority: 1 });
    assert.throws(() => readHdStorageProtection(m), /hd_ready_protection_failed/);
    save(m.hdRoot, legacy);
    const protectedLegacy = readHdStorageProtection(m);
    assert.equal(protectedLegacy.readyByKey[legacy.key].legacy.manifestSha256, approved.entries[legacy.key].manifestSha256);
    checks.push('production_inventory_and_full_historical_manifest_sha_are_pinned');

    const wrongOriginal = JSON.parse(JSON.stringify(approved)); wrongOriginal.entries[legacy.key].sourceIdentitySha256 = '0'.repeat(64);
    m.hdLegacyReady = wrongOriginal; assert.throws(() => readHdStorageProtection(m), /hd_ready_protection_failed/);
    m.hdLegacyReady = approved; save(m.hdRoot, { ...legacy, width: 17 });
    assert.throws(() => readHdStorageProtection(m), /hd_ready_protection_failed/);
    // A synthetic newly approved declaration still has to match the actual AVIF
    // header. No full pixel decode or re-encode occurs in the release helper.
    m.hdLegacyReady = approvalFor({ ...legacy, width: 17 });
    const wrongDimensions = await inspectHdReconciliation(m, { sourceRoot: roots[0], final: true });
    assert.equal(wrongDimensions.safe, false); assert.equal(wrongDimensions.legacyMetadata.checked, 0);
    assert.equal(wrongDimensions.legacyMetadata.failed, 1);
    assert.ok(wrongDimensions.issues.some(item => item.code === 'legacy_metadata_unconfirmed' && item.key === legacy.key));
    save(m.hdRoot, legacy); m.hdLegacyReady = approved;
    fs.utimesSync(legacyOriginal, new Date(1000), new Date(1000));
    assert.throws(() => readHdStorageProtection(m), /hd_ready_protection_failed/);
    fs.unlinkSync(path.join(m.hdRoot, legacy.key + '.json')); fs.unlinkSync(legacyFile); delete m.hdLegacyReady;
    checks.push('legacy_original_identity_and_actual_dimensions_changes_are_rejected');

    // Only this private NODE_ENV=test root may synthesize old-version approval.
    // The production literal above is never extended, mutated, or rediscovered.
    const historicalReadyOriginal = path.join(m.uploadsRoot, 'historical-ready.png');
    const historicalSkippedOriginal = path.join(m.uploadsRoot, 'historical-skipped.png');
    fs.writeFileSync(historicalReadyOriginal, original); fs.writeFileSync(historicalSkippedOriginal, original);
    const oldReadyQueued = createJob(historicalReadyOriginal, false), oldSkippedQueued = createJob(historicalSkippedOriginal, false);
    const historicalOutput = path.join(m.hdRoot, oldReadyQueued.key + '.avif'); fs.writeFileSync(historicalOutput, legacyBytes);
    const oldReady = { ...oldReadyQueued, status: 'ready', format: 'avif', mime: 'image/avif', file: oldReadyQueued.key + '.avif',
      width: 16, height: 16, bytes: legacyBytes.length, integrity: integrity('heif') };
    const oldSkipped = { ...oldSkippedQueued, status: 'skipped', reason: 'source_changed' };
    save(m.hdRoot, oldReady); save(m.hdRoot, oldSkipped);
    fs.utimesSync(historicalReadyOriginal, new Date(2000), new Date(2000));
    fs.utimesSync(historicalSkippedOriginal, new Date(2000), new Date(2000));
    const statIdentity = file => { const s = fs.statSync(file); return {
      dev: String(s.dev), ino: String(s.ino), bytes: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs,
    }; };
    const historicalApprovalFor = jobs => {
      const bound = fs.statSync(m.hdRoot);
      return { schema: 'hd-historical-versions-approval-v1', inventorySchema: 'hd-historical-version-inventory-v1',
        inventorySha256: sha('Synthetic isolated historical versions, never production approval'),
        canonicalRoot: m.hdRoot, binding: { dev: String(bound.dev), ino: String(bound.ino) },
        count: jobs.length, observedAt: new Date().toISOString(), entries: Object.fromEntries(jobs.map(job => {
          const file = path.join(m.uploadsRoot, job.source.slice('/uploads/'.length)), current = createJob(file, job.preserveText);
          return [job.key, { key: job.key, manifestSha256: sha(fs.readFileSync(path.join(m.hdRoot, job.key + '.json'))),
            status: job.status, reason: job.reason ?? null, historicalVersion: job.version, currentVersion: current.version,
            historicalKeyMatches: true, currentKey: current.key, sourceIdentitySha256: sha(fs.realpathSync(file)),
            currentSource: statIdentity(file), output: job.status === 'ready' ? {
              ...statIdentity(path.join(m.hdRoot, job.file)), lengthMatches: true, width: job.width, height: job.height,
              integrity: job.integrity.version, failedChecks: [],
            } : null }];
        })) };
    };
    const historicalApproved = historicalApprovalFor([oldReady, oldSkipped]); m.hdHistoricalVersions = historicalApproved;
    const historicalProtection = readHdStorageProtection(m);
    assert.equal(historicalProtection.historicalByKey[oldReady.key].currentReusable, false);
    assert.equal(historicalProtection.historicalByKey[oldSkipped.key].reason, 'source_changed');
    assert.notEqual(historicalApproved.entries[oldReady.key].currentKey, oldReady.key);
    assert.equal(Object.hasOwn(historicalProtection.readyByKey, oldReady.key), true, 'Old ready bytes remain protected');
    const historicalAccepted = await inspectHdReconciliation(m, { sourceRoot: roots[0], final: true });
    assert.equal(historicalAccepted.safe, true); assert.equal(historicalAccepted.historicalPreserved.length, 2);
    assert.equal(historicalAccepted.excludedHistoricalReadyCount, 1);
    assert.ok(historicalAccepted.historicalPreserved.every(item => item.currentReusable === false && item.currentKey !== item.key));
    assert.equal(assertHdStorageProtection(historicalProtection, readHdStorageProtection(m)), true);
    const helperSource = fs.readFileSync(fileURLToPath(new URL('./hd-storage-preflight.mjs', import.meta.url)), 'utf8');
    assert.ok(helperSource.includes("Object.keys(before.readyByKey).filter(item => !Object.hasOwn(before.historicalByKey, item))"));
    assert.ok(helperSource.includes("assert.equal(receipt.excludedHistoricalReadyCount, excludedHistoricalReadyCount)"));
    assert.ok(helperSource.includes("Preserved historical ready cannot prove current ready reuse"));
    assert.ok(Object.isFrozen(APPROVED_HD_HISTORICAL_VERSIONS) && Object.isFrozen(APPROVED_HD_HISTORICAL_VERSIONS.entries));
    assert.equal(APPROVED_HD_HISTORICAL_VERSIONS.count, Object.keys(APPROVED_HD_HISTORICAL_VERSIONS.entries).length);
    const alteredHistoricalLiteral = JSON.parse(JSON.stringify(APPROVED_HD_HISTORICAL_VERSIONS));
    alteredHistoricalLiteral.inventorySha256 = '0'.repeat(64);
    assert.throws(() => readHdStorageProtection({ ...m, hdStorageIsolationRoot: undefined,
      hdLegacyReady: APPROVED_HD_LEGACY_READY, hdHistoricalVersions: alteredHistoricalLiteral }), /old-version preservation/);
    checks.push('approved_old_versions_preserved_but_never_selected_as_current_reusable_ready');

    save(m.hdRoot, { ...oldReady, priority: 1 });
    assert.throws(() => readHdStorageProtection(m), /old-version manifest bytes changed/); save(m.hdRoot, oldReady);
    save(m.hdRoot, { ...oldSkipped, reason: 'different_reason' });
    assert.throws(() => readHdStorageProtection(m)); save(m.hdRoot, oldSkipped);
    fs.unlinkSync(path.join(m.hdRoot, oldSkipped.key + '.json'));
    assert.throws(() => readHdStorageProtection(m), /historical version disappeared/); save(m.hdRoot, oldSkipped);
    checks.push('old_version_full_manifest_bytes_and_source_changed_reason_are_frozen');

    delete m.hdHistoricalVersions;
    const unapprovedHistorical = await inspectHdReconciliation(m, { sourceRoot: roots[0], final: true });
    assert.equal(unapprovedHistorical.safe, false);
    for (const key of [oldReady.key, oldSkipped.key]) assert.ok(unapprovedHistorical.issues.some(item => item.key === key && item.code === 'source_identity_unconfirmed'));
    assert.deepEqual(unapprovedHistorical.historicalPreserved, []);
    m.hdHistoricalVersions = historicalApproved;
    const staleFork = { ...oldSkipped }; save(m.hdForkRoot, staleFork);
    const noForkException = await inspectHdReconciliation(m, { sourceRoot: roots[0], final: true });
    assert.equal(noForkException.safe, false);
    assert.ok(noForkException.issues.some(item => item.role === 'fork' && item.key === staleFork.key && item.code === 'source_identity_unconfirmed'));
    fs.unlinkSync(path.join(m.hdForkRoot, staleFork.key + '.json'));
    checks.push('unknown_old_versions_and_fork_records_never_gain_historical_exceptions');

    const badOldIntegrity = { ...oldReady, integrity: { ...oldReady.integrity, checks: {
      ...oldReady.integrity.checks, output_full_decode: { expected: 'complete', actual: 'incomplete', ok: false },
    } } };
    save(m.hdRoot, badOldIntegrity); m.hdHistoricalVersions = historicalApprovalFor([badOldIntegrity, oldSkipped]);
    assert.throws(() => readHdStorageProtection(m), /Ready integrity is unknown or failed/);
    save(m.hdRoot, oldReady); m.hdHistoricalVersions = historicalApproved;
    checks.push('historical_ready_still_requires_the_entire_modern_v2_integrity_gate');

    fs.utimesSync(historicalOutput, new Date(3000), new Date(3000));
    assert.throws(() => readHdStorageProtection(m), /historical output identity changed/);
    // A separate isolated fixture approval establishes the next negative
    // baseline. Production callers can never replace either fixed inventory.
    m.hdHistoricalVersions = historicalApprovalFor([oldReady, oldSkipped]);
    fs.utimesSync(historicalReadyOriginal, new Date(4000), new Date(4000));
    assert.throws(() => readHdStorageProtection(m), /current original identity changed again/);
    fs.unlinkSync(path.join(m.hdRoot, oldReady.key + '.json'));
    fs.unlinkSync(path.join(m.hdRoot, oldSkipped.key + '.json')); fs.unlinkSync(historicalOutput); delete m.hdHistoricalVersions;
    checks.push('historical_output_and_current_source_identity_cannot_change_again');

    // Copy only already approved compiler-cache bytes into this existing private
    // filesystem fixture. No real service/retired-object producer is invoked.
    const cacheReference = '/data/video-api-debugger/var-lib/storage/hd-derivatives/.runs/a62c2e2204ec04289f237d5a7255e348aec0396fef1e464db1bb9838c07c3148.864ee5d2-65fa-405c-bf6d-fd18626d7c79/tsx-1004';
    assert.equal(fs.realpathSync(cacheReference), cacheReference);
    const cacheOriginal = path.join(m.uploadsRoot, 'closed-cache-original.png'); fs.writeFileSync(cacheOriginal, original);
    const cacheQueued = createJob(cacheOriginal), closedProcessor = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      "import fs from 'node:fs';const t=fs.readFileSync('/proc/self/stat','utf8');console.log(JSON.stringify({pid:process.pid,startTicks:t.slice(t.lastIndexOf(')')+2).trim().split(/\\s+/)[19]}))"], { encoding: 'utf8' }));
    const createClosedCache = (storage, superseded = false, cacheInput = cacheReference) => {
      const executionId = randomUUID(), latestExecutionId = superseded ? randomUUID() : executionId;
      const run = cacheQueued.key + '.' + executionId, runPath = path.join(storage, '.runs', run), cachePath = path.join(runPath, 'tsx-' + process.getuid());
      const began = Date.now() - 1000; fs.mkdirSync(cachePath, { recursive: true, mode: 0o700 });
      const referenceNames = fs.readdirSync(cacheInput).sort(); assert.equal(referenceNames.length, 3);
      for (const name of referenceNames) {
        assert.match(name, /^\d+-[a-f0-9]{40}$/);
        const target = path.join(cachePath, Math.floor(Date.now() / 1e8) + '-' + name.split('-')[1]);
        fs.copyFileSync(path.join(cacheInput, name), target); fs.chmodSync(target, 0o600);
      }
      const latestCache = Math.max(...[runPath, cachePath, ...fs.readdirSync(cachePath).map(name => path.join(cachePath, name))]
        .flatMap(file => { const stat = fs.lstatSync(file); return [stat.mtimeMs, stat.ctimeMs]; }));
      while (Date.now() <= Math.ceil(latestCache) + 5) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      const now = Date.now(), attemptHistory = superseded ? [
        { attempt: 1, status: 'queued', reason: 'encode_timeout', sourceVersion: cacheQueued.version,
          startedAt: new Date(began).toISOString(), finishedAt: new Date(now - 4).toISOString() },
        { attempt: 2, status: 'failed', reason: 'encode_timeout', sourceVersion: cacheQueued.version,
          startedAt: new Date(now - 3).toISOString(), finishedAt: new Date(now).toISOString() },
      ] : [{ attempt: 1, status: 'failed', reason: 'encode_timeout', sourceVersion: cacheQueued.version,
        startedAt: new Date(began).toISOString(), finishedAt: new Date(now).toISOString() }];
      const job = { ...cacheQueued, protocol: 'hd-job-v2', status: 'failed', reason: 'encode_timeout', executionId: latestExecutionId,
        processor: { ...closedProcessor, executionId: latestExecutionId, groupId: closedProcessor.pid, host: os.hostname() },
        attempts: attemptHistory.length, attemptHistory, executionExitedAt: new Date(now - 1).toISOString(), updatedAt: new Date(now).toISOString() };
      save(storage, job); return { run, runPath, job };
    };
    const canonicalPending = createClosedCache(m.hdRoot, true);
    // Fork jobs must keep the same original image/version. Isolation permits
    // exercising pending projection, never canonical-drain acceptance for a production fork.
    const forkPending = createClosedCache(m.hdForkRoot, true);
    const pendingCaches = await inspectHdReconciliation(m, { sourceRoot: roots[0], final: true });
    assert.equal(pendingCaches.safe, false); assert.equal(pendingCaches.canEnterControlledDrain, false); assert.equal(pendingCaches.unstable, false);
    assert.equal(pendingCaches.retiredCacheProof, null);
    assert.deepEqual(pendingCaches.pendingWholeDrain, [{ role: 'canonical', run: canonicalPending.run }, { role: 'fork', run: forkPending.run }]);
    for (const [role, cache] of [['canonical', canonicalPending], ['fork', forkPending]]) {
      const item = pendingCaches.closedExecutionCaches[role].find(value => value.run === cache.run);
      assert.equal(item.proofKind, 'superseded-attempt-whole-service-drain');
      assert.equal(item.pendingWholeDrain, true); assert.equal(item.accepted, false);
      assert.equal(item.historicalPidKnown, false); assert.equal(item.historicalExitReceipt, false);
      assert.deepEqual(item.processProof, { complete: true, hdChildrenAbsent: true, privateRunProcessesAbsent: true });
    }
    checks.push('superseded_cache_without_real_whole_drain_stays_pending_unsafe_and_not_admitted');
    fs.rmSync(canonicalPending.runPath, { recursive: true }); fs.rmSync(forkPending.runPath, { recursive: true });
    fs.unlinkSync(path.join(m.hdRoot, cacheQueued.key + '.json')); fs.unlinkSync(path.join(m.hdForkRoot, cacheQueued.key + '.json'));

    const validCache = createClosedCache(m.hdRoot), badRuns = Array.from({ length: 101 }, () => '0'.repeat(64) + '.' + randomUUID());
    assert.ok(badRuns.every(run => run < validCache.run));
    for (const run of badRuns) fs.mkdirSync(path.join(m.hdRoot, '.runs', run), { mode: 0o700 });
    const rejectedCaches = await inspectHdReconciliation(m, { sourceRoot: roots[0], final: true });
    assert.equal(rejectedCaches.safe, false); assert.equal(rejectedCaches.unstable, false); assert.equal(rejectedCaches.canEnterControlledDrain, false);
    assert.deepEqual(rejectedCaches.cacheRefusals.canonical.map(item => item.run).sort(), [...badRuns].sort());
    assert.equal(rejectedCaches.cacheRefusals.canonical.length, 101);
    assert.ok(rejectedCaches.closedExecutionCaches.canonical.some(item => item.run === validCache.run && item.readOnly));
    assert.deepEqual(rejectedCaches.pendingWholeDrain, []);
    assert.equal(rejectedCaches.issues.filter(item => item.code === 'closed_cache_refused').length, 101);
    assert.ok(rejectedCaches.cacheRefusals.canonical.every(item => item.category === 'invalid_cache_evidence'));
    checks.push('each_cache_refusal_is_collected_and_later_100_and_valid_cache_still_checked');
    for (const run of badRuns) fs.rmdirSync(path.join(m.hdRoot, '.runs', run));
    const closedOnly = await inspectHdReconciliation(m, { sourceRoot: roots[0], final: true });
    assert.equal(closedOnly.safe, true); assert.deepEqual(closedOnly.cacheRefusals, { canonical: [], fork: [] });
    assert.deepEqual(closedOnly.pendingWholeDrain, []);
    assert.ok(closedOnly.closedExecutionCaches.canonical.some(item => item.run === validCache.run));
    checks.push('all_refusals_removed_preserves_original_latest_execution_cache_behavior');
    fs.rmSync(validCache.runPath, { recursive: true }); fs.unlinkSync(path.join(m.hdRoot, cacheQueued.key + '.json'));
    fs.rmdirSync(path.join(m.hdRoot, '.runs')); fs.rmdirSync(path.join(m.hdForkRoot, '.runs'));

    // Consumer structure only: these synthetic compiled bytes are never run and
    // are not a claim that an actual successful release capsule was produced.
    // Production's callback is the controller's real readOriginalSuccess path.
    const compileRoot = path.join(directory, 'compiled-candidate'), sealedCache = path.join(directory, 'compiled-snapshot');
    fs.mkdirSync(sealedCache, { mode: 0o700 });
    const sourceFiles = ['scripts/process-hd-image.ts', 'src/lib/media/hd-image-processor.ts', 'src/lib/media/hd-encoder.ts'];
    const compiledEntries = sourceFiles.map(sourceFile => {
      const file = path.join(compileRoot, sourceFile); fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(path.join(applicationRoot, sourceFile), file);
      const bytes = Buffer.from(JSON.stringify({ code: '/* isolated consumer-contract bytes; never executed */',
        map: { version: 3, sources: [file] }, warnings: [] }));
      const cacheKey = createHash('sha1').update(bytes).digest('hex'), cacheFile = path.join(sealedCache, Math.floor(Date.now() / 1e8) + '-' + cacheKey);
      fs.writeFileSync(cacheFile, bytes, { mode: 0o600 });
      return { sourceFile, sourceSha256: sha(fs.readFileSync(file)), cacheFile, cacheKey, cacheSha256: sha(bytes), cacheBytes: bytes.length };
    });
    const source = 'c'.repeat(40), sourceManifest = path.join(compileRoot, 'source-manifest.json'), archive = path.join(compileRoot, 'source.tar.gz');
    const archiveBytes = Buffer.from('Synthetic capsule-consumer structure, not an actual successful build'); fs.writeFileSync(archive, archiveBytes, { mode: 0o600 });
    fs.writeFileSync(sourceManifest, JSON.stringify({ project: 'video-api-debugger', source, archiveSha256: sha(archiveBytes),
      files: Object.fromEntries(compiledEntries.map(item => [item.sourceFile, item.sourceSha256])) }), { mode: 0o600 });
    const compilerDirectory = path.join(directory, 'compiler-inputs'); fs.mkdirSync(compilerDirectory, { mode: 0o700 });
    const compiler = Object.fromEntries([['node', process.version, fs.realpathSync(process.execPath)],
      ['tsx', JSON.parse(fs.readFileSync(applicationRoot + '/node_modules/tsx/package.json')).version, fs.realpathSync(require.resolve('tsx'))],
      ['esbuild', JSON.parse(fs.readFileSync(applicationRoot + '/node_modules/esbuild/package.json')).version, fs.realpathSync(require.resolve('esbuild'))]]
      .map(([kind, version, originalFile]) => {
        const bytes = fs.readFileSync(originalFile), file = kind === 'node' ? originalFile : path.join(compilerDirectory, kind + '.js');
        // Consumer structure only: keep the application bytes, but make this
        // root-owned isolated sample independent of the application's uid.
        if (kind !== 'node') fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
        assert.deepEqual(fs.readFileSync(file), bytes);
        return [kind, { version, file, sha256: sha(bytes) }];
      }));
    const reference = { source, sourceRoot: compileRoot, sourceManifest, archive, compiler, entries: compiledEntries };
    const compiledManifest = { ...m, main: { source, root: compileRoot, sourceManifest, archive } };
    let capsuleCalls = 0;
    const capability = readHdCompiledCacheProofs(compiledManifest, [reference], value => { capsuleCalls++; return structuredClone(value); });
    compiledManifest.hdCompiledCacheProofs = capability; assert.equal(capsuleCalls, 1);
    // The deployed system Node is a real root-owned package-manager hardlink;
    // this positive case reads it without creating/changing any system alias.
    assert.ok(fs.lstatSync(compiler.node.file).nlink >= 2); assert.equal(fs.lstatSync(compiler.node.file).uid, 0);
    const compilerLstat = fs.lstatSync;
    for (const fault of ['owner', 'writable']) {
      let observed = 0;
      fs.lstatSync = function (file, ...args) {
        const value = compilerLstat.call(this, file, ...args);
        if (file !== compiler.node.file) return value;
        observed++;
        return Object.assign(Object.create(Object.getPrototypeOf(value)), value,
          fault === 'owner' ? { uid: 1 } : { mode: value.mode | 0o022 });
      };
      try {
        assert.throws(() => readHdCompiledCacheProofs({ ...m, main: compiledManifest.main }, [reference], value => structuredClone(value)),
          error => error.code === 'EINVAL');
        assert.ok(observed > 0);
      } finally { fs.lstatSync = compilerLstat; }
    }
    const compilerRealpath = fs.realpathSync; let nodeResolutions = 0;
    fs.realpathSync = function (file, ...args) {
      const actual = compilerRealpath.call(this, file, ...args);
      if (file === compiler.node.file && ++nodeResolutions === 2) return compileRoot + '/' + sourceFiles[0];
      return actual;
    };
    try {
      await assert.rejects(inspectHdReconciliation(compiledManifest, { sourceRoot: roots[0], final: true }), error => error.code === 'EINVAL');
      assert.ok(nodeResolutions >= 2, 'Layout must revalidate the complete typed system alias proof');
    } finally { fs.realpathSync = compilerRealpath; }
    assert.throws(() => readHdCompiledCacheProofs({ ...m, main: compiledManifest.main }, [reference], () => true));
    for (const forged of [{ ...capability }, capability]) await assert.rejects(inspectHdReconciliation({ ...m, main: compiledManifest.main,
      hdCompiledCacheProofs: forged }, { sourceRoot: roots[0], final: true }));
    assert.throws(() => readHdCompiledCacheProofs({ ...m, main: compiledManifest.main }, [{ ...reference,
      entries: reference.entries.map((item, index) => index ? item : { ...item, cacheSha256: '0'.repeat(64) }) }], value => structuredClone(value)));
    assert.throws(() => readHdCompiledCacheProofs({ ...m, main: compiledManifest.main }, [{ ...reference,
      compiler: { ...compiler, node: { ...compiler.node, sha256: '0'.repeat(64) } } }], value => structuredClone(value)));
    const compiledRun = createClosedCache(m.hdRoot), compiledDirectory = path.join(compiledRun.runPath, 'tsx-' + process.getuid());
    for (const name of fs.readdirSync(compiledDirectory)) fs.unlinkSync(path.join(compiledDirectory, name));
    for (const entry of compiledEntries) fs.copyFileSync(entry.cacheFile, path.join(compiledDirectory, path.basename(entry.cacheFile)));
    const latestCompiled = Math.max(...[compiledRun.runPath, compiledDirectory, ...fs.readdirSync(compiledDirectory).map(name => path.join(compiledDirectory, name))]
      .flatMap(file => { const s = fs.lstatSync(file); return [s.mtimeMs, s.ctimeMs]; }));
    while (Date.now() <= Math.ceil(latestCompiled) + 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    const compiledFinished = Date.now(); compiledRun.job.executionExitedAt = new Date(compiledFinished - 1).toISOString();
    compiledRun.job.updatedAt = compiledRun.job.attemptHistory[0].finishedAt = new Date(compiledFinished).toISOString(); save(m.hdRoot, compiledRun.job);
    assert.equal((await inspectHdReconciliation(compiledManifest, { sourceRoot: roots[0], final: true })).safe, true);
    assert.equal(capsuleCalls, 1, 'Original capsule verification is not repeated per inventory/cache');
    const readCache = fs.readFileSync;
    fs.readFileSync = function (target, ...args) {
      if (typeof target === 'number' && fs.realpathSync('/proc/self/fd/' + target).startsWith(compiledDirectory + '/'))
        throw Object.assign(new Error('Synthetic outer scan deadline'), { code: 'HD_RECONCILIATION_SCAN_DEADLINE' });
      return readCache.call(this, target, ...args);
    };
    try { await assert.rejects(inspectHdReconciliation(compiledManifest, { sourceRoot: roots[0], final: true }), error => error.code === 'HD_RECONCILIATION_SCAN_DEADLINE'); }
    finally { fs.readFileSync = readCache; }
    fs.appendFileSync(compiledEntries[0].cacheFile, 'changed');
    await assert.rejects(inspectHdReconciliation(compiledManifest, { sourceRoot: roots[0], final: true }));
    fs.rmSync(compiledRun.runPath, { recursive: true }); fs.unlinkSync(path.join(m.hdRoot, cacheQueued.key + '.json')); fs.rmdirSync(m.hdRoot + '/.runs');
    checks.push('compiled_cache_requires_private_verified_capsule_capability_exact_sources_bytes_and_fatal_deadlines');

    // Real previously-proven old writer bytes; the archive/manifest here model
    // the consumer structure only. Production supplies its original archive.
    const legacyFolder = path.join(directory, 'legacy-writer-proof'); fs.mkdirSync(legacyFolder, { mode: 0o700 });
    const oldMap = JSON.parse(fs.readFileSync(path.join(cacheReference, fs.readdirSync(cacheReference)[0]))).map.sources[0];
    const oldRelative = sourceFiles.find(file => oldMap.endsWith('/' + file)); assert.ok(oldRelative);
    const oldRoot = oldMap.slice(0, -(oldRelative.length + 1)), oldSource = path.basename(oldRoot);
    const oldWriter = fs.readFileSync(oldRoot + '/src/lib/media/hd-derivatives.ts');
    assert.equal(sha(oldWriter), '7442f68dd8ce7db49390293e722107c2bc57b72ea43976541427978076858fbf');
    const legacySourceRoot = path.join(legacyFolder, 'source'), legacyCache = path.join(legacyFolder, 'cache');
    fs.mkdirSync(legacyCache, { mode: 0o700 });
    const legacySourceFiles = {};
    for (const sourceFile of [...sourceFiles, 'src/lib/media/hd-derivatives.ts']) {
      const file = path.join(legacySourceRoot, sourceFile), bytes = fs.readFileSync(path.join(oldRoot, sourceFile));
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
      legacySourceFiles[sourceFile] = sha(bytes); assert.equal(sha(fs.readFileSync(file)), sha(bytes));
    }
    // This source/cache pair models the same legacy consumer contract inside
    // this private fixture. It is not an original successful-build capsule.
    const legacyEntries = fs.readdirSync(cacheReference).sort().map(name => {
      const value = JSON.parse(fs.readFileSync(path.join(cacheReference, name)));
      const sourceFile = sourceFiles.find(file => value.map.sources[0] === oldRoot + '/' + file); assert.ok(sourceFile);
      value.map.sources = [legacySourceRoot + '/' + sourceFile];
      const bytes = Buffer.from(JSON.stringify(value)), cacheKey = createHash('sha1').update(bytes).digest('hex');
      const cacheFile = path.join(legacyCache, Math.floor(Date.now() / 1e8) + '-' + cacheKey);
      fs.writeFileSync(cacheFile, bytes, { flag: 'wx', mode: 0o600 });
      return { sourceFile, sourceSha256: legacySourceFiles[sourceFile], cacheFile, cacheKey, cacheSha256: sha(bytes), cacheBytes: bytes.length };
    });
    assert.deepEqual(legacyEntries.map(item => item.sourceFile).sort(), [...sourceFiles].sort());
    const oldArchive = path.join(legacyFolder, 'source.tar.gz'), oldManifest = path.join(legacyFolder, 'source-manifest.json');
    const oldArchiveBytes = Buffer.from('Isolated original-archive consumer structure; not a real sealed archive');
    fs.writeFileSync(oldArchive, oldArchiveBytes, { mode: 0o600 });
    fs.writeFileSync(oldManifest, JSON.stringify({ project: 'video-api-debugger', source: oldSource,
      archiveSha256: sha(oldArchiveBytes), files: legacySourceFiles }), { mode: 0o600 });
    const legacyCandidate = { source: oldSource, root: legacySourceRoot, sourceManifest: oldManifest, archive: oldArchive };
    const legacyReference = { source: oldSource, sourceRoot: legacySourceRoot, sourceManifest: oldManifest, archive: oldArchive,
      compiler, entries: legacyEntries };
    const oldManifestObject = { ...m, main: legacyCandidate, live: { hd: { source: oldSource, root: legacySourceRoot,
      sourceProof: { sourceManifest: oldManifest, archive: oldArchive } } } };
    oldManifestObject.hdCompiledCacheProofs = readHdCompiledCacheProofs(oldManifestObject, [legacyReference], value => structuredClone(value));
    const unrecorded = createClosedCache(m.hdRoot, true, legacyCache), past = Date.now() - 20000;
    Object.assign(unrecorded.job.attemptHistory[0], { startedAt: new Date(past).toISOString(), finishedAt: new Date(past + 1000).toISOString() });
    Object.assign(unrecorded.job.attemptHistory[1], { startedAt: new Date(past + 2000).toISOString(), finishedAt: new Date(past + 3000).toISOString() });
    unrecorded.job.updatedAt = new Date(past + 3000).toISOString(); unrecorded.job.executionExitedAt = new Date(past + 2999).toISOString();
    save(m.hdRoot, unrecorded.job);
    const unrecordedResult = await inspectHdReconciliation(oldManifestObject, { sourceRoot: roots[0], final: true });
    const projection = unrecordedResult.closedExecutionCaches.canonical.find(value => value.run === unrecorded.run);
    assert.equal(unrecordedResult.safe, false); assert.equal(unrecordedResult.canEnterControlledDrain, false);
    assert.equal(projection.historyKind, 'unrecorded-legacy'); assert.equal(projection.historicalAttempt, null);
    assert.equal(projection.historicalPidKnown, false); assert.equal(projection.historicalExitReceipt, false);
    assert.equal(projection.historicalIntervalKnown, false); assert.equal(projection.accepted, false); assert.equal(projection.pendingWholeDrain, true);
    for (const field of ['executionEvidenceProtocol', 'verificationHistory', 'newAttemptEvidence']) {
      const value = structuredClone(unrecorded.job);
      if (field === 'newAttemptEvidence') value.attemptHistory[0].executionId = randomUUID();
      else value[field] = field === 'verificationHistory' ? [] : 'hd-execution-evidence-v1';
      save(m.hdRoot, value);
      const refused = await inspectHdReconciliation(oldManifestObject, { sourceRoot: roots[0], final: true });
      assert.equal(refused.safe, false); assert.equal(refused.pendingWholeDrain.length, 0); assert.equal(refused.cacheRefusals.canonical.length, 1);
    }
    save(m.hdRoot, unrecorded.job);
    const absentSourceManifest = { ...m, main: legacyCandidate };
    absentSourceManifest.hdCompiledCacheProofs = readHdCompiledCacheProofs(absentSourceManifest, [legacyReference], value => structuredClone(value));
    const absentSource = await inspectHdReconciliation(absentSourceManifest, { sourceRoot: roots[0], final: true });
    assert.equal(absentSource.pendingWholeDrain.length, 0); assert.equal(absentSource.cacheRefusals.canonical.length, 1);
    fs.rmSync(unrecorded.runPath, { recursive: true }); fs.unlinkSync(path.join(m.hdRoot, cacheQueued.key + '.json')); fs.rmdirSync(m.hdRoot + '/.runs');
    checks.push('unrecorded_old_verification_requires_exact_legacy_writer_and_original_source_authority_new_protocol_never_downgrades');

    // The new entry's file/proc paths are real and isolated. Only systemd's
    // observation is explicit fixture data; production rejects those fields.
    const discoverySources = ['src/lib/media/hd-derivatives.ts', 'src/lib/media/hd-discovery.ts', 'src/lib/media/hd-resource-state.ts',
      'scripts/process-hd-derivatives.ts', 'src/lib/media/hd-storage-root.ts'];
    for (const root of roots) for (const file of discoverySources) {
      fs.mkdirSync(path.dirname(root + '/' + file), { recursive: true }); fs.copyFileSync(applicationRoot + '/' + file, root + '/' + file);
    }
    const admissionTimings = [];
    async function admissionCase(name, { held = true, trigger, mutate, reject = false, deadlineMs = 5000, clockJump = false } = {}) {
      const lock = m.hdRoot + '/discovery.lock', marker = path.join(directory, 'owner-ready-' + randomUUID());
      const beforeJob = fs.readFileSync(path.join(m.hdRoot, pending.key + '.json'));
      const candidateFile = roots[1] + '/src/lib/media/hd-discovery.ts', beforeSource = fs.readFileSync(candidateFile);
      const records = [], actualNow = Date.now, start = actualNow(); let triggered = false, moved = null, invokedAt, invocationDeadline;
      const program = `const fs=require('node:fs'),os=require('node:os'),crypto=require('node:crypto');process.umask(0o022);
const [lock,marker,held]=process.argv.slice(1);const acquire=()=>{fs.mkdirSync(lock);fs.writeFileSync(lock+'/owner.json',JSON.stringify({pid:process.pid,host:os.hostname(),token:crypto.randomUUID()}),{mode:384});fs.writeFileSync(marker,'ready');};
const release=()=>{if(fs.existsSync(lock)){fs.unlinkSync(lock+'/owner.json');fs.rmdirSync(lock);}};
process.on('message',v=>{if(v==='acquire')acquire();if(v==='release')release();if(v==='exit'){release();process.disconnect();}});
if(held==='yes')acquire();const s=fs.readFileSync('/proc/self/stat','utf8'),f=s.slice(s.lastIndexOf(')')+2).trim().split(/\\s+/);process.send({pid:process.pid,startTicks:f[19],cgroup:fs.readFileSync('/proc/self/cgroup','utf8').trim()});`;
      const child = spawn(process.execPath, ['-e', program, lock, marker, held ? 'yes' : 'no'], { cwd: roots[0], detached: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      fixtureProcessIds.add(child.pid);
      let childError = ''; child.stderr.on('data', b => { childError += b; });
      const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      const info = await new Promise((resolve, rejectReady) => { child.once('message', resolve); child.once('error', rejectReady); });
      const ownerReadyAt = actualNow();
      const unit = { MainPID: String(info.pid), ControlPID: '0', InvocationID: '1'.repeat(32),
        ExecMainStartTimestampMonotonic: String(Number(info.startTicks) * 10000), ControlGroup: '/system.slice/sd2-hd-derivatives.service',
        ActiveState: 'active', SubState: 'running', WorkingDirectory: roots[0] };
      m.privateMultiviewInstall = true; m.main = { root: roots[1] };
      m.live = { hd: { unit: 'sd2-hd-derivatives.service', pid: info.pid, invocation: unit.InvocationID,
        execMainStartTimestampMonotonic: unit.ExecMainStartTimestampMonotonic, root: roots[0] } };
      m.hdAdmissionFixtureUnit = unit; m.hdAdmissionFixtureCgroup = info.cgroup;
      const acquireAtBoundary = () => {
        if (fs.existsSync(marker)) fs.unlinkSync(marker); child.send('acquire');
        const limit = records.find(item => item.kind.startsWith('strict-start-'))?.value.deadline ?? invocationDeadline;
        while (!fs.existsSync(marker) && actualNow() < limit) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        assert.ok(fs.existsSync(marker), 'Isolated owner did not acquire its lease at the requested boundary');
      };
      const originalLstat = fs.lstatSync, originalOpen = fs.openSync, originalFstat = fs.fstatSync;
      const ownerUnlinkedCase = name.startsWith('owner-file-unlinked-');
      let cleanupRequested = false, cleanupStat = null, cleanupInjected = false;
      let ownerReadFd = null, ownerReadStats = 0, ownerFinalLstat = false;
      if (ownerUnlinkedCase) {
        fs.openSync = function (target, ...args) {
          const fd = originalOpen.call(fs, target, ...args);
          if (cleanupRequested && target === lock + '/owner.json') { ownerReadFd = fd; ownerReadStats = 0; }
          return fd;
        };
        fs.fstatSync = function (fd, ...args) {
          const stat = originalFstat.call(fs, fd, ...args);
          if (fd === ownerReadFd && ++ownerReadStats === 2) ownerFinalLstat = true;
          return stat;
        };
        fs.lstatSync = function (target, ...args) {
          if (!ownerFinalLstat || target !== lock + '/owner.json') return originalLstat.call(fs, target, ...args);
          ownerFinalLstat = false; cleanupRequested = false; ownerReadFd = null;
          const prior = originalLstat.call(fs, target, ...args); cleanupInjected = true;
          if (name !== 'owner-file-unlinked-still-present') {
            child.send('release'); let absent = false;
            while (actualNow() < invocationDeadline) {
              try { originalLstat.call(fs, lock); }
              catch (error) { if (error.code !== 'ENOENT') throw error; absent = true; break; }
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
            }
            assert.equal(absent, true, 'The original child must actually release its isolated owner record and directory');
          }
          const changes = { nlink: 0 };
          if (name === 'owner-file-unlinked-inode-changed') changes.ino = prior.ino + 1;
          if (name === 'owner-file-unlinked-owner-changed') changes.uid = prior.uid + 1;
          if (name === 'owner-file-unlinked-mode-changed') changes.mode = prior.mode ^ 0o040;
          return Object.assign(Object.create(Object.getPrototypeOf(prior)), prior, changes);
        };
      }
      if (name === 'natural-release-unlinked-stat') fs.lstatSync = function (target, ...args) {
        if (cleanupStat && target === lock) {
          const prior = cleanupStat; cleanupStat = null; cleanupInjected = true;
          return Object.assign(Object.create(Object.getPrototypeOf(prior)), prior, { nlink: 0 });
        }
        if (cleanupRequested && target === lock + '/owner.json') {
          cleanupRequested = false; const bound = originalLstat.call(fs, lock); child.send('release');
          let absent = false;
          while (actualNow() < invocationDeadline) {
            try { originalLstat.call(fs, lock); }
            catch (error) { if (error.code !== 'ENOENT') throw error; absent = true; break; }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
          }
          assert.equal(absent, true, 'The original child must actually release its isolated directory');
          cleanupStat = bound;
          throw Object.assign(new Error('Original owner removed its record during observation'), { code: 'ENOENT' });
        }
        return originalLstat.call(fs, target, ...args);
      };
      try {
        if (name === 'unknown-owner') fs.writeFileSync(lock + '/owner.json', JSON.stringify({ pid: 1, host: 'unknown', token: randomUUID() }), { mode: 0o600 });
        if (name === 'other-transient') fs.mkdirSync(m.hdRoot + '/unknown.lock');
        if (name === 'running-task') save(m.hdRoot, { ...pending, status: 'running' });
        if (name === 'unknown-processor') save(m.hdRoot, { ...pending, processor: { executionId: 'unknown' } });
        if (name === 'five-source-drift') fs.writeFileSync(candidateFile, beforeSource + '\n// changed isolated candidate\n');
        if (name === 'unknown-cache') fs.mkdirSync(m.hdRoot + '/.runs/' + pending.key + '.' + randomUUID(), { recursive: true });
        const action = async () => {
          invokedAt = Date.now(); invocationDeadline = invokedAt + deadlineMs;
          const result = await inspectHdBeforeMaintenance(m, { sourceRoot: roots[0], deadline: invocationDeadline, check: () => {},
          record: (kind, value) => {
            records.push({ kind, value });
            if (kind.startsWith('boundary-') && value.phase === trigger && !triggered) { triggered = true; acquireAtBoundary(); }
            if (kind === 'known-busy') {
              if (name === 'natural-release-unlinked-stat' || ownerUnlinkedCase) cleanupRequested = true;
              const firstStrictAt = records.find(item => item.kind.startsWith('strict-start-')).value.at;
              assert.ok(value.deadline <= firstStrictAt + 15000); assert.ok(value.deadline <= invocationDeadline);
              if (mutate === 'task') save(m.hdRoot, { ...pending, priority: pending.priority + 1 });
              if (mutate === 'unit') unit.InvocationID = '2'.repeat(32);
              if (mutate === 'owner') fs.writeFileSync(lock + '/owner.json', JSON.stringify({ pid: info.pid, host: os.hostname(), token: randomUUID() }));
              if (name === 'owner-file-replaced') {
                const replacement = marker + '.replacement';
                fs.writeFileSync(replacement, fs.readFileSync(lock + '/owner.json'), { mode: 0o600 });
                fs.renameSync(replacement, lock + '/owner.json');
              }
              if (mutate === 'path') { moved = m.hdRoot + '.held'; const old = fs.statSync(m.hdRoot); fs.renameSync(m.hdRoot, moved); fs.mkdirSync(m.hdRoot, { mode: 0o700 }); assert.notEqual(fs.statSync(m.hdRoot).ino, old.ino); }
              if (clockJump) Date.now = () => actualNow() + 16000;
              if (!ownerUnlinkedCase && name !== 'owner-file-replaced'
                && !['persistent', 'short-deadline', 'hard-cap', 'natural-release-unlinked-stat'].includes(name)
                && !['path', 'owner'].includes(mutate)) child.send('release');
            }
            if (kind === 'natural-release' && name === 'second-strict-collision') acquireAtBoundary();
          } });
          assert.equal(result.safe, true, 'The caller must still require the complete original strict result');
          return result;
        };
        if (reject) await assert.rejects(action, name === 'owner-file-replaced' ? /Bound discovery owner file identity changed/
          : name === 'owner-file-unlinked-still-present' ? /requires a fresh absence/
          : ownerUnlinkedCase ? /Bound discovery owner path changed while reading/ : undefined);
        else { const result = await action(); assert.equal(result.safe, true);
          assert.equal(records.filter(v => v.kind.startsWith('strict-start-')).length, held || trigger ? 2 : 1); }
        if (name === 'natural-release-unlinked-stat' || ownerUnlinkedCase) assert.equal(cleanupInjected, true);
        assert.ok(records.filter(v => v.kind.startsWith('strict-start-')).length <= 2);
        if (name === 'unknown-owner') assert.equal(records.some(v => v.kind === 'known-busy'), false);
        if (name === 'second-strict-collision') assert.equal(records.filter(v => v.kind.startsWith('strict-start-')).length, 2);
        admissionTimings.push({ name, startedAt: start, ownerReadyAt, invokedAt, invocationDeadline,
          boundedDeadline: records.find(v => v.kind.startsWith('strict-start-'))?.value.deadline ?? null,
          invocationElapsedMs: actualNow() - invokedAt, durationMs: actualNow() - start, rejected: reject, strictStarts: records.filter(v => v.kind.startsWith('strict-start-')).length,
          completedResults: records.filter(v => v.kind.startsWith('strict-result-')).length, fixtureFinalOnly: true });
        checks.push('bounded-discovery-' + name);
      } finally {
        fs.lstatSync = originalLstat; fs.openSync = originalOpen; fs.fstatSync = originalFstat;
        Date.now = actualNow;
        if (moved) { fs.rmdirSync(m.hdRoot); fs.renameSync(moved, m.hdRoot); }
        child.send('exit'); assert.deepEqual(await exit, { code: 0, signal: null }); assert.equal(childError, '');
        fixtureProcessIds.delete(child.pid);
        fs.writeFileSync(path.join(m.hdRoot, pending.key + '.json'), beforeJob); fs.writeFileSync(candidateFile, beforeSource);
        if (fs.existsSync(m.hdRoot + '/unknown.lock')) fs.rmdirSync(m.hdRoot + '/unknown.lock');
        if (name === 'unknown-cache') fs.rmSync(m.hdRoot + '/.runs', { recursive: true });
        if (fs.existsSync(marker)) fs.unlinkSync(marker);
        for (const key of ['privateMultiviewInstall', 'main', 'live', 'hdAdmissionFixtureUnit', 'hdAdmissionFixtureCgroup']) delete m[key];
      }
    }
    for (const [name, options] of [
      ['no-collision', { held: false }], ['natural-release', {}], ['natural-release-unlinked-stat', {}],
      ['owner-file-unlinked-stat', {}], ['owner-file-unlinked-inode-changed', { reject: true }],
      ['owner-file-unlinked-owner-changed', { reject: true }], ['owner-file-unlinked-mode-changed', { reject: true }],
      ['owner-file-unlinked-still-present', { reject: true }], ['owner-file-replaced', { reject: true }],
      ['retired-entry-collision', { held: false, trigger: 'retired-cache-entry' }],
      ['inventory-mid-collision', { held: false, trigger: 'inventory-complete' }],
      ['unknown-owner', { reject: true }], ['persistent', { reject: true, deadlineMs: 200 }],
      ['other-transient', { reject: true }], ['running-task', { reject: true }], ['unknown-processor', { reject: true }],
      ['task-changed', { reject: true, mutate: 'task' }], ['unit-changed', { reject: true, mutate: 'unit' }],
      ['path-changed', { reject: true, mutate: 'path' }], ['owner-changed', { reject: true, mutate: 'owner' }],
      ['short-deadline', { reject: true, deadlineMs: 1 }], ['hard-cap', { reject: true, deadlineMs: 60000, clockJump: true }],
      ['second-strict-collision', { reject: true }], ['unknown-cache', { reject: true }], ['five-source-drift', { reject: true }],
    ]) await admissionCase(name, options);

    const protectedContinuationTimings = [], protectedSources = [...discoverySources,
      'src/lib/media/hd-encoder.ts', 'src/lib/media/hd-image-processor.ts'];
    for (const file of protectedSources) {
      fs.mkdirSync(path.dirname(roots[0] + '/' + file), { recursive: true });
      fs.copyFileSync(applicationRoot + '/' + file, roots[0] + '/' + file);
    }
    async function protectedContinuationCase(name, options = {}) {
      const actualNow = Date.now, actualWait = Atomics.wait, actualReadDir = fs.readdirSync, actualOpen = fs.openSync;
      const startedAt = actualNow(), caseId = randomUUID(), lock = m.hdRoot + '/discovery.lock';
      const acquire = path.join(directory, 'protected-acquire-' + caseId), release = path.join(directory, 'protected-release-' + caseId);
      const readyMarker = path.join(directory, 'protected-owner-' + caseId), deletedMarker = path.join(directory, 'protected-empty-' + caseId);
      const emptyAcknowledged = path.join(directory, 'protected-empty-observed-' + caseId);
      const beforeJob = fs.readFileSync(path.join(m.hdRoot, pending.key + '.json'));
      const sourceFile = roots[0] + '/src/lib/media/hd-discovery.ts', beforeSource = fs.readFileSync(sourceFile);
      const baselineSource = '31bff5a6544a3d18d433b81fa7735ed57b0d012c';
      const protectedIncrement = { schema: 'sd2-protected-increment.v1', baselineSource,
        pricingWrites: false, multiviewGeneration: false, canvasVideoBatchWrites: false,
        sizePolicyVersion: 2, diagnosticsSchema: 'image.provider-error.v1' };
      const archived = {};
      for (const [kind, source] of [['live', baselineSource], ['main', '1'.repeat(40)], ['guard', '2'.repeat(40)]]) {
        const folder = path.join(directory, kind); fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
        const root = kind === 'live' ? roots[0] : path.join(folder, 'source');
        if (kind !== 'live') for (const file of protectedSources) {
          fs.mkdirSync(path.dirname(root + '/' + file), { recursive: true });
          fs.copyFileSync(roots[0] + '/' + file, root + '/' + file);
          // New candidates legitimately differ from the still-running writer.
          if (file === 'src/lib/media/hd-image-processor.ts') fs.appendFileSync(root + '/' + file, '\n// isolated ' + kind + ' candidate\n');
        }
        const archiveSources = Object.fromEntries(protectedSources.map(file => [file, sha(fs.readFileSync(root + '/' + file))]));
        const archive = path.join(folder, 'source.tar.gz'), sourceManifest = path.join(folder, 'source-manifest.json');
        const bytes = Buffer.from('Isolated nonempty archive byte pin ' + caseId + ':' + kind);
        fs.writeFileSync(archive, bytes, { mode: 0o600 });
        fs.writeFileSync(sourceManifest, JSON.stringify({ project: 'video-api-debugger', source, archiveSha256: sha(bytes), files: archiveSources }), { mode: 0o600 });
        archived[kind] = { source, archive, sourceManifest, root };
      }
      // The real child owns and releases its real directory while the parent's
      // synchronous observe is blocked. No mocked PID, /proc or service is used.
      const program = `const fs=require('node:fs'),os=require('node:os'),crypto=require('node:crypto');process.umask(0o022);
const [lock,acquire,release,ready,empty,ack,held]=process.argv.slice(1);let releasing=false;
const take=()=>{if(fs.existsSync(ack))fs.unlinkSync(ack);fs.mkdirSync(lock,{mode:493});fs.writeFileSync(lock+'/owner.json',JSON.stringify({pid:process.pid,host:os.hostname(),token:crypto.randomUUID()}),{mode:384});fs.writeFileSync(ready,'ready');};
const drop=()=>{if(!fs.existsSync(lock))return;if(fs.existsSync(lock+'/owner.json'))fs.unlinkSync(lock+'/owner.json');if(fs.readdirSync(lock).length===0)fs.rmdirSync(lock);};
if(held==='yes')take();const timer=setInterval(()=>{if(fs.existsSync(acquire)){fs.unlinkSync(acquire);take();}if(fs.existsSync(release)&&!releasing){fs.unlinkSync(release);releasing=true;if(fs.existsSync(lock+'/owner.json'))fs.unlinkSync(lock+'/owner.json');fs.writeFileSync(empty,'verified-owner-removed');}if(releasing&&fs.existsSync(ack)){fs.unlinkSync(ack);if(fs.existsSync(lock)&&fs.readdirSync(lock).length===0)fs.rmdirSync(lock);releasing=false;}},2);
process.on('message',v=>{if(v==='exit'){clearInterval(timer);drop();process.disconnect();}});
const s=fs.readFileSync('/proc/self/stat','utf8'),f=s.slice(s.lastIndexOf(')')+2).trim().split(/\\s+/);process.send({pid:process.pid,startTicks:f[19],cgroup:fs.readFileSync('/proc/self/cgroup','utf8').trim()});`;
      let pendingCache;
      if (options.pending) pendingCache = createClosedCache(m.hdRoot, true);
      const child = spawn(process.execPath, ['-e', program, lock, acquire, release, readyMarker, deletedMarker, emptyAcknowledged,
        options.held === false ? 'no' : 'yes'], { cwd: roots[0], detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      fixtureProcessIds.add(child.pid);
      let childError = ''; child.stderr.on('data', value => { childError += value; });
      const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      const info = await new Promise((resolve, rejectReady) => { child.once('message', resolve); child.once('error', rejectReady); });
      const unit = { MainPID: String(info.pid), ControlPID: '0', InvocationID: '3'.repeat(32),
        ExecMainStartTimestampMonotonic: String(Number(info.startTicks) * 10000 + (options.execOffsetUs || 0)), ControlGroup: '/system.slice/sd2-hd-derivatives.service',
        ActiveState: 'active', SubState: 'running', WorkingDirectory: roots[0] };
      m.privateMultiviewInstall = true; m.protectedIncrement = protectedIncrement;
      m.main = archived.main; m.guard = archived.guard;
      m.live = { web: { source: baselineSource, root: roots[0] }, hd: { unit: 'sd2-hd-derivatives.service', source: baselineSource,
        pid: info.pid, invocation: unit.InvocationID, execMainStartTimestampMonotonic: unit.ExecMainStartTimestampMonotonic, root: roots[0],
        sourceProof: { sourceManifest: archived.live.sourceManifest, archive: archived.live.archive } } };
      m.hdAdmissionFixtureUnit = unit; m.hdAdmissionFixtureCgroup = info.cgroup;
      let sleeps = 0, firstSleep = true, emptyObservations = 0, rootReads = 0, movedRoot = null, movedLock = null;
      let admission, result, failure, lastInventoryRoot, canonicalInventories = 0, injectedCollision = false, secondCollision = false;
      let releaseRequested = false, boundedDeadline, sleepingTreeReads = null, completedCollisions = 0, clockOffset = 0;
      const archiveOpens = Object.fromEntries(Object.values(archived).map(value => [value.archive, 0]));
      const rootReadsBySleep = [], collisionOwnerInodes = [];
      const acquireAtBoundary = () => {
        if (fs.existsSync(readyMarker)) fs.unlinkSync(readyMarker);
        fs.writeFileSync(acquire, 'acquire'); const limit = admission.deadline;
        while (!fs.existsSync(readyMarker) && actualNow() < limit)
          actualWait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(2, admission.remaining()));
        assert.ok(fs.existsSync(readyMarker), 'The actual protected owner did not acquire at its boundary');
      };
      try {
        if (options.fault === 'missing-owner') fs.unlinkSync(lock + '/owner.json');
        if (options.fault === 'invalid-json') fs.writeFileSync(lock + '/owner.json', '{invalid');
        if (options.fault === 'bad-fields') {
          const owner = JSON.parse(fs.readFileSync(lock + '/owner.json')); owner.unreviewed = true; fs.writeFileSync(lock + '/owner.json', JSON.stringify(owner));
        }
        if (options.fault === 'invalid-token') {
          const owner = JSON.parse(fs.readFileSync(lock + '/owner.json')); owner.token = 'invalid'; fs.writeFileSync(lock + '/owner.json', JSON.stringify(owner));
        }
        if (options.fault === 'unknown-owner') fs.writeFileSync(lock + '/owner.json', JSON.stringify({ pid: process.pid, host: os.hostname(), token: randomUUID() }));
        if (options.fault === 'stale-owner') fs.utimesSync(lock, new Date(actualNow() - 60000), new Date(actualNow() - 60000));
        if (options.fault === 'extra-lock') fs.mkdirSync(m.hdRoot + '/unknown.lock');
        if (options.fault === 'extra-publish') fs.writeFileSync(m.hdRoot + '/unknown.publish.json', '{}');
        if (options.fault === 'extra-tmp') fs.writeFileSync(m.hdRoot + '/unknown.tmp', 'unknown');
        if (options.fault === 'initial-main-archive') fs.appendFileSync(archived.main.archive, 'changed');
        if (options.fault === 'initial-live-archive') fs.appendFileSync(archived.live.archive, 'changed');
        if (options.fault === 'missing-live-proof') delete m.live.hd.sourceProof;
        if (options.fault === 'initial-live-manifest') {
          const manifest = JSON.parse(fs.readFileSync(archived.live.sourceManifest)); manifest.source = 'e'.repeat(40);
          fs.writeFileSync(archived.live.sourceManifest, JSON.stringify(manifest));
        }
        if (options.fault === 'initial-candidate-source') fs.appendFileSync(archived.main.root + '/src/lib/media/hd-image-processor.ts', '\n// unpinned\n');
        if (options.fault === 'initial-guard-manifest') {
          const manifest = JSON.parse(fs.readFileSync(archived.guard.sourceManifest)); manifest.source = 'f'.repeat(40);
          fs.writeFileSync(archived.guard.sourceManifest, JSON.stringify(manifest));
        }
        fs.readdirSync = function (target, ...args) {
          const value = actualReadDir.call(this, target, ...args);
          if (target === m.hdRoot || target === m.hdForkRoot) rootReads++;
          if (target === lock && Array.isArray(value) && value.length === 0) {
            emptyObservations++;
            // The independent owner finishes only after the real empty inode
            // was observed. This removes a scheduler-dependent timing assertion.
            if (releaseRequested && !fs.existsSync(emptyAcknowledged)) fs.writeFileSync(emptyAcknowledged, 'observed');
          }
          return value;
        };
        fs.openSync = function (target, ...args) {
          if (Object.hasOwn(archiveOpens, target)) archiveOpens[target]++;
          return actualOpen.call(this, target, ...args);
        };
        Atomics.wait = function (...args) {
          sleeps++; rootReadsBySleep.push(rootReads);
          if (firstSleep) {
            firstSleep = false; sleepingTreeReads = rootReads;
            if (fs.existsSync(lock)) collisionOwnerInodes.push(fs.lstatSync(lock).ino);
            if (options.fault === 'unit-changed') unit.InvocationID = '4'.repeat(32);
            if (options.fault === 'owner-changed') {
              const owner = JSON.parse(fs.readFileSync(lock + '/owner.json')); owner.token = randomUUID(); fs.writeFileSync(lock + '/owner.json', JSON.stringify(owner));
            }
            if (options.fault === 'owner-replaced') {
              const bytes = fs.readFileSync(lock + '/owner.json'); fs.unlinkSync(lock + '/owner.json'); fs.writeFileSync(lock + '/owner.json', bytes, { mode: 0o600 });
            }
            if (options.fault === 'lock-replaced') {
              movedLock = lock + '.held'; fs.renameSync(lock, movedLock); fs.mkdirSync(lock, { mode: 0o755 });
            }
            if (options.fault === 'root-replaced') {
              movedRoot = m.hdRoot + '.protected-held-' + caseId; fs.renameSync(m.hdRoot, movedRoot); fs.mkdirSync(m.hdRoot, { mode: 0o700 });
            }
            if (options.fault === 'entity-changed') save(m.hdRoot, { ...pending, priority: pending.priority + 1 });
            if (options.fault === 'source-changed') fs.appendFileSync(sourceFile, '\n// isolated source identity changed\n');
            if (options.fault === 'archive-changed') fs.appendFileSync(archived.guard.archive, 'changed-during-wait');
            if (options.fault === 'hard-deadline') Date.now = () => actualNow() + 60001;
            if (options.fault === 'shared-deadline' && completedCollisions > 0) Date.now = () => actualNow() + 16000;
            if (options.cumulativeWait) { clockOffset += 8000; Date.now = () => actualNow() + clockOffset; }
            if (!['owner-changed', 'owner-replaced', 'lock-replaced', 'root-replaced', 'hard-deadline', 'shared-deadline'].includes(options.fault)
              || options.fault === 'shared-deadline' && completedCollisions === 0) if (!options.exhaustWait) {
              fs.writeFileSync(release, 'natural-release'); releaseRequested = true;
            }
          }
          assert.equal(rootReads, sleepingTreeReads, 'A protected wait must not rescan either full HD tree per sleep');
          return actualWait(...args);
        };
        const action = async () => {
          if (options.finalStrict) return inspectHdReconciliation(m, { sourceRoot: roots[0], final: true });
          const factoryStartedAt = actualNow();
          const scanDeadline = factoryStartedAt + 60000;
          admission = createProtectedDiscoveryContinuation(m, { sourceRoot: roots[0], scanDeadline, check: () => {},
            waitBudgetMs: options.waitBudgetMs || 15000 }); boundedDeadline = admission.deadline;
          const factoryFinishedAt = actualNow();
          assert.equal(boundedDeadline, scanDeadline); assert.ok(boundedDeadline >= factoryFinishedAt);
          const observe = admission.observe.bind(admission), inventory = admission.inventory.bind(admission);
          admission.inventory = (root, value) => {
            lastInventoryRoot = root; if (root === m.hdRoot) canonicalInventories++; inventory(root, value);
            if (options.staticScanOver15 && canonicalInventories === 1) Date.now = () => actualNow() + 16000;
          };
          admission.observe = phase => {
            completedCollisions = admission.observations.length;
            const shouldInject = options.trigger && !injectedCollision && phase === 'inventory-complete'
              && lastInventoryRoot === m.hdRoot && canonicalInventories === 2;
            const shouldRepeat = options.repeat && completedCollisions === 1 && !secondCollision && phase === 'inventory-complete';
            if (shouldInject || shouldRepeat) {
              if (shouldInject) injectedCollision = true; else secondCollision = true;
              acquireAtBoundary(); firstSleep = true; sleepingTreeReads = null; releaseRequested = false;
            }
            observe(phase);
          };
          if (options.finishCollision) {
            const finish = admission.finish.bind(admission);
            admission.finish = () => { acquireAtBoundary(); return finish(); };
          }
          return inspectHdReconciliation(m, { sourceRoot: roots[0], final: Boolean(options.finalAdmission), admissionObservation: admission });
        };
        try { result = await action(); } catch (error) { failure = error; }
        const rejected = Boolean(failure) || result?.safe !== true;
        if (options.reject || options.pending || options.finalStrict) assert.equal(rejected, true, 'Protected discovery must not turn this case into safety');
        else { if (failure) throw failure; assert.equal(result.safe, true); }
        if (options.firstReject || options.finalStrict || options.finalAdmission) assert.equal(sleeps, 0);
        if (options.fault === 'hard-deadline' || options.fault === 'shared-deadline' || options.cumulativeWait || options.exhaustWait) {
          assert.equal(failure?.code, options.fault === 'hard-deadline' ? 'HD_RECONCILIATION_SCAN_DEADLINE' : 'HD_DISCOVERY_WAIT_BUDGET_EXHAUSTED');
          if (options.fault === 'hard-deadline') assert.ok(Date.now() > boundedDeadline);
          assert.equal(admission.deadline, boundedDeadline);
        }
        if (!options.reject && !options.finalStrict) {
          assert.ok(result.discoveryContinuation); assert.equal(result.discoveryContinuation.deadline, boundedDeadline);
          assert.equal(result.discoveryContinuation.fullTreeRescans, 0);
          assert.ok(result.discoveryContinuation.observations.every(item => item.sameReconciliation && item.fullTreeRescans === 0));
          assert.equal(result.discoveryContinuation.collisionCount, options.held === false && !options.trigger ? 0 : options.repeat ? 2 : 1);
          if (result.discoveryContinuation.collisionCount) {
            assert.ok(sleeps > 0 && emptyObservations > 0 && releaseRequested);
            assert.ok(result.discoveryContinuation.observations.every(item => item.owner.pid === info.pid && item.sleeps > 0));
            assert.deepEqual(result.discoveryContinuation.observations.map(item => item.owner.directory.ino), collisionOwnerInodes);
            assert.deepEqual(Object.values(archiveOpens), [1, 1, 1], 'Original writer and both candidate archives are each read once, not once per lock');
            assert.equal(result.discoveryContinuation.extraSourceBindings, 21); assert.equal(result.discoveryContinuation.extraArchiveHashes, 3);
          }
          assert.equal(result.discoveryContinuation.waitBudgetMs, 15000);
          assert.ok(result.discoveryContinuation.waitedMs < 15000);
          if (options.staticScanOver15) { assert.equal(result.discoveryContinuation.waitedMs, 0); assert.equal(sleeps, 0); assert.ok(Date.now() - result.discoveryContinuation.startedAt >= 15000); }
        }
        if (options.pending) {
          assert.equal(result.safe, false); assert.equal(result.canEnterControlledDrain, false);
          assert.deepEqual(result.pendingWholeDrain, [{ role: 'canonical', run: pendingCache.run }]);
        }
        if (options.finalStrict) { assert.equal(result.safe, false); assert.equal(result.canEnterControlledDrain, false); assert.ok(fs.existsSync(lock)); }
        protectedContinuationTimings.push({ name, startedAt, finishedAt: actualNow(), rejected, sleeps, emptyObservations,
          deadline: boundedDeadline ?? null, observations: result?.discoveryContinuation?.observations || admission?.observations || [],
          rootReadsBySleep, collisionOwnerInodes, actualOwnerPid: info.pid, actualProcessAndPaths: true, realServiceDrainProven: false });
        checks.push('protected-discovery-' + name);
      } finally {
        Date.now = actualNow; Atomics.wait = actualWait; fs.readdirSync = actualReadDir; fs.openSync = actualOpen;
        if (movedRoot) { fs.rmdirSync(m.hdRoot); fs.renameSync(movedRoot, m.hdRoot); }
        if (movedLock) { fs.rmdirSync(lock); fs.renameSync(movedLock, lock); }
        child.send('exit'); assert.deepEqual(await exited, { code: 0, signal: null }); assert.equal(childError, '');
        fixtureProcessIds.delete(child.pid);
        fs.writeFileSync(path.join(m.hdRoot, pending.key + '.json'), beforeJob); fs.writeFileSync(sourceFile, beforeSource);
        for (const suffix of ['unknown.lock', 'unknown.publish.json', 'unknown.tmp']) {
          const file = m.hdRoot + '/' + suffix;
          if (fs.existsSync(file)) { if (fs.lstatSync(file).isDirectory()) fs.rmdirSync(file); else fs.unlinkSync(file); }
        }
        for (const file of [acquire, release, readyMarker, deletedMarker, emptyAcknowledged]) if (fs.existsSync(file)) fs.unlinkSync(file);
        if (pendingCache) { fs.rmSync(pendingCache.runPath, { recursive: true }); fs.unlinkSync(path.join(m.hdRoot, cacheQueued.key + '.json')); fs.rmdirSync(m.hdRoot + '/.runs'); }
        for (const key of ['privateMultiviewInstall', 'protectedIncrement', 'main', 'guard', 'live', 'hdAdmissionFixtureUnit', 'hdAdmissionFixtureCgroup']) delete m[key];
      }
    }
    const protectedCases = [
      ['no-collision', { held: false }], ['verified-natural-empty-release', {}], ['inventory-mid-release', { held: false, trigger: true }],
      ['actual-fork-tick-before-exec-observation', { execOffsetUs: 15000 }],
      ['kernel-pid-start-after-original-invocation-refused', { execOffsetUs: -10000, reject: true, firstReject: true }],
      ['two-collisions-one-deadline', { repeat: true }], ['pending-whole-drain-never-safe', { pending: true }],
      ['static-scan-over-15s-spends-no-wait-budget', { held: false, staticScanOver15: true }],
      ['two-collisions-share-cumulative-15s-wait', { repeat: true, cumulativeWait: true, reject: true }],
      ['actual-sleep-exhausts-shorter-budget-under-15s-cap', { exhaustWait: true, waitBudgetMs: 50, reject: true }],
      ['missing-owner', { reject: true, firstReject: true, fault: 'missing-owner' }],
      ['invalid-json', { reject: true, firstReject: true, fault: 'invalid-json' }],
      ['bad-fields', { reject: true, firstReject: true, fault: 'bad-fields' }],
      ['invalid-token', { reject: true, firstReject: true, fault: 'invalid-token' }],
      ['unknown-owner', { reject: true, firstReject: true, fault: 'unknown-owner' }],
      ['stale-owner', { reject: true, firstReject: true, fault: 'stale-owner' }],
      ['extra-lock', { reject: true, firstReject: true, fault: 'extra-lock' }],
      ['extra-publish', { reject: true, firstReject: true, fault: 'extra-publish' }],
      ['extra-tmp', { reject: true, firstReject: true, fault: 'extra-tmp' }],
      ['initial-main-archive', { reject: true, firstReject: true, fault: 'initial-main-archive' }],
      ['original-writer-archive', { reject: true, firstReject: true, fault: 'initial-live-archive' }],
      ['original-writer-manifest-source', { reject: true, firstReject: true, fault: 'initial-live-manifest' }],
      ['original-writer-source-proof-required', { reject: true, firstReject: true, fault: 'missing-live-proof' }],
      ['candidate-own-source-mismatch', { reject: true, firstReject: true, fault: 'initial-candidate-source' }],
      ['initial-guard-manifest', { reject: true, firstReject: true, fault: 'initial-guard-manifest' }],
      ['unit-changed', { reject: true, fault: 'unit-changed' }], ['owner-changed', { reject: true, fault: 'owner-changed' }],
      ['owner-replaced', { reject: true, fault: 'owner-replaced' }], ['lock-replaced', { reject: true, fault: 'lock-replaced' }],
      ['root-replaced', { reject: true, fault: 'root-replaced' }], ['entity-changed', { reject: true, fault: 'entity-changed' }],
      ['entity-changed-after-inventory', { held: false, trigger: true, reject: true, fault: 'entity-changed' }],
      ['source-changed', { reject: true, fault: 'source-changed' }], ['archive-changed', { reject: true, fault: 'archive-changed' }],
      ['hard-deadline', { reject: true, fault: 'hard-deadline' }], ['shared-deadline', { repeat: true, reject: true, fault: 'shared-deadline' }],
      ['final-strict-no-wait', { finalStrict: true }], ['final-explicit-admission-refused', { finalAdmission: true, reject: true }],
      ['lease-after-final-snapshot-refused', { held: false, finishCollision: true, firstReject: true, reject: true }],
    ];
    for (const [name, options] of protectedCases) await protectedContinuationCase(name, options);

    const originalOnlyFile = path.join(m.uploadsRoot, 'original-small.png'); fs.writeFileSync(originalOnlyFile, original);
    const originalJob = createJob(originalOnlyFile, false), avif = await sharp(original).avif({ quality: 95, chromaSubsampling: '4:4:4', effort: 6 }).toBuffer();
    await sharp(avif).stats();
    save(m.hdRoot, { ...originalJob, status: 'ready', format: 'original', mime: 'image/png', bytes: original.length,
      width: 16, height: 16, integrity: integrity('heif'), reason: 'original_smaller' });
    const originals = readHdStorageProtection(m); assert.equal(originals.readyByKey[originalJob.key].output.realpath, originalOnlyFile);
    fs.writeFileSync(originalOnlyFile, Buffer.alloc(original.length, 42));
    assert.throws(() => readHdStorageProtection(m), /hd_ready_protection_failed/);
    checks.push('ready_original_is_bound_to_real_original_identity_length_and_version');

    assert.equal(checks.length, 48 + protectedCases.length);
    const helper = fileURLToPath(new URL('./hd-storage-preflight.mjs', import.meta.url));
    const receipt = { schema: 'hd-storage-preflight-engineering-v1', completed: true, checks, total: checks.length,
      passed: checks.length, admissionTimings, protectedContinuationTimings, retiredFourCacheAdmissionProvenByIsolatedCases: false,
      supersededCacheProjectionCovered: true, realWholeServiceDrainProven: false,
      processInventoryScope: 'fixture-self-and-owned-children-real-proc', productionProcessAbsenceProven: false,
      compiledCacheConsumerStructureOnly: true, actualOriginalCapsuleProvenByFixture: false,
      unrecordedLegacyArchiveConsumerStructureOnly: true,
      helperSha256: sha(fs.readFileSync(helper)), productionWrites: 0, productionDatabaseUsed: false,
      legacyAllowlistSha256: sha(fs.readFileSync(fileURLToPath(new URL('./hd-legacy-ready-allowlist.mjs', import.meta.url)))),
      legacyMetadata: acceptedLegacy.legacyMetadata,
      historicalPreserved: historicalAccepted.historicalPreserved,
      excludedHistoricalReadyCount: historicalAccepted.excludedHistoricalReadyCount,
      networkRequests: 0, providerRequests: 0, serviceChanges: 0, releasesSwitched: 0 };
    fs.writeFileSync(path.join(directory, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600 });
    console.log(JSON.stringify(receipt));
  } finally {
    fs.readdirSync = originalProcReaddir;
    process.umask(previousMask);
    if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
  }
}
void main().then(() => { process.exitCode = 0; }).catch(error => { console.error(error); process.exitCode = 1; });
