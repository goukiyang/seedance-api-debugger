import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { assertFreshCandidateEvidence, GUARD_BUILD_TAIL_SCHEMA } from './candidate-evidence.mjs';

// Importing this module does nothing. The installed guard and original marker
// are read-only inputs. All actual switching belongs to the release controller.
export const PRICING_START_CONTROL = '/data/video-api-debugger/controls/pricing-writer-v1';
export const PRICING_START_GUARD_SHA256 = '81a92dfae4600f81f6fd043a87d440d2e9c46056aad95dd66dfbdb5836830fe0';
export const PRICING_WRITER_SERVICES = ['sd2-gray.service', 'sd2-image-studio.service'];
const PROJECT = '/data/video-api-debugger';
const HASH = /^[a-f0-9]{64}$/;
const SOURCE = /^[a-f0-9]{40}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const realCall = (file, args, extra = {}) => execFileSync(file, args, {
  encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, ...extra,
}).trim();

export function assertPricingPairTransition({ previous, releases, proofs, reuseBuilds, runId, manifestSha256 }, now = Date.now()) {
  const overlap = releases.some(entry => previous.releases.some(old => old.source === entry.source));
  if (!overlap) return;
  assert.deepEqual(releases, previous.releases, 'An existing source may only be reused as the exact unchanged whole main/guard pair');
  assert.equal(reuseBuilds?.schema, 'sd2-original-build-reuse-input.v1');
  for (const [index, kind] of ['main', 'guard'].entries()) {
    const proof = proofs[kind];
    assertFreshCandidateEvidence(proof, { runId, [kind]: releases[index], reuseBuilds }, kind, now);
    assert.equal(proof.manifestSha256, manifestSha256);
    assert.equal(proof.applicationChecksAndContractsUnchanged, true);
    assert.equal(proof.controlChangesCheckedSeparately, true);
    assert.equal(proof.build, releases[index].build);
  }
}

// An explicit adapter can supply a virtual fixed /data tree for the lead's
// offline matrix. There is no production path override or automatic fallback.
export function createPricingStartPairHelper({ filesystem = fs, call = realCall,
  now = Date.now, getuid = () => process.getuid(), platform = process.platform } = {}) {
  const io = filesystem;
  const control = PRICING_START_CONTROL;
  const allowedFile = path.join(control, 'allowed.json');
  const guardFile = path.join(control, 'writer-start-guard.mjs');
  const lockFile = path.join(control, '.pair-transition.lock');
  const absent = file => { try { io.lstatSync(file); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };
  const privileged = () => { assert.equal(platform, 'linux'); assert.equal(getuid(), 0, 'Root-only pricing start-pair operation'); };
  const runIdCheck = runId => assert.match(runId, /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/);
  const relative = file => {
    assert.ok(typeof file === 'string' && file && !path.isAbsolute(file)
      && !file.split('/').some(part => !part || part === '.' || part === '..') && !/[\r\n\0]/.test(file));
  };
  function directory(file, rootOwned = true) {
    assert.equal(io.realpathSync(file), file, 'Directory alias refused: ' + file);
    const stat = io.lstatSync(file);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o022)
      && (!rootOwned || stat.uid === 0), 'Untrusted directory: ' + file);
    return { path: file, dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 };
  }
  function rootChain(file) {
    assert.ok(file === '/data' || file.startsWith('/data/'));
    let current = file;
    while (current !== '/data') { directory(current); current = path.dirname(current); }
    directory('/data');
  }
  function attributes(file) {
    const result = /^([^\s]+)\s+([\s\S]+)$/.exec(call('/usr/bin/lsattr', ['-d', '--', file]));
    assert.ok(result && result[2] === file, 'Cannot identify immutable attributes');
    return result[1];
  }
  function snapshot(file, { rootOwned = true, maximum = 32 * 1024 * 1024, immutable = false } = {}) {
    assert.equal(io.realpathSync(file), file, 'File alias refused: ' + file);
    const before = io.lstatSync(file);
    assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1
      && before.size > 0 && before.size <= maximum && (!rootOwned || before.uid === 0)
      && (!rootOwned || !(before.mode & 0o022)), 'Untrusted regular file: ' + file);
    const descriptor = io.openSync(file, io.constants.O_RDONLY | io.constants.O_NOFOLLOW);
    let bytes;
    try {
      const opened = io.fstatSync(descriptor);
      assert.equal(opened.dev, before.dev); assert.equal(opened.ino, before.ino);
      bytes = io.readFileSync(descriptor);
      const after = io.fstatSync(descriptor);
      for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key], 'File changed during read: ' + file);
    } finally { io.closeSync(descriptor); }
    const after = io.lstatSync(file);
    assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
    const attr = attributes(file);
    if (immutable) assert.ok(attr.includes('i'), 'Root marker must remain immutable');
    return { path: file, dev: before.dev, ino: before.ino, uid: before.uid, gid: before.gid,
      mode: before.mode & 0o7777, nlink: before.nlink, size: before.size,
      mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs, attributes: attr,
      sha256: hash(bytes), bytesBase64: bytes.toString('base64') };
  }
  const bytesOf = value => { const bytes = Buffer.from(value.bytesBase64, 'base64'); assert.equal(hash(bytes), value.sha256); return bytes; };
  const jsonOf = value => JSON.parse(bytesOf(value).toString('utf8'));
  const same = (expected, actual, message) => assert.deepEqual(actual, expected, message);
  function markerSnapshot(file) {
    assert.ok(path.isAbsolute(file) && file.startsWith(PROJECT + '/') && path.basename(file) === 'image-studio-drain');
    const state = snapshot(file, { maximum: 4096, immutable: true }), value = jsonOf(state);
    assert.equal(state.mode, 0o444);
    assert.equal(Object.keys(value).sort().join(','), 'guard,installedAt,protocol,schema');
    assert.equal(value.schema, 'pricing-writer-isolation.v1'); assert.equal(value.protocol, 'pricing-policy-v1');
    assert.equal(value.guard, 'reject-legacy-image-writers');
    assert.ok(Number.isFinite(Date.parse(value.installedAt)) && Date.parse(value.installedAt) <= now());
    return state;
  }
  function allowedShape(value) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.equal(value.schema, 'pricing-writer-start-allowlist.v1'); assert.equal(value.project, 'video-api-debugger');
    assert.ok(Number.isSafeInteger(value.serviceUid) && value.serviceUid > 0);
    assert.ok(Number.isFinite(Date.parse(value.at)) && Date.parse(value.at) <= now());
    runIdCheck(value.runId);
    assert.ok(Array.isArray(value.releases) && value.releases.length === 2, 'Exactly main and compatible guard are allowed');
    assert.equal(new Set(value.releases.map(item => item.source)).size, 2);
    for (const entry of value.releases) { assert.match(entry.source, SOURCE); assert.equal(entry.root, PROJECT + '/managed-releases/' + entry.source); }
    return value;
  }
  // Same source/build contract as the unchanged installed sourceCheck. This is
  // fact verification, not execution of that guard or a simulated ExecStartPre.
  function sourceCheck(root, allowed) {
    const entry = allowed.releases.find(item => item.root === root);
    assert.ok(entry, 'Legacy or unapproved program cannot start a pricing writer');
    assert.match(entry.source, SOURCE); assert.equal(root, PROJECT + '/managed-releases/' + entry.source);
    assert.equal(io.realpathSync(root), root);
    assert.equal(io.readFileSync(root + '/.deployed-commit', 'utf8').trim(), entry.source);
    assert.equal(JSON.parse(io.readFileSync(root + '/package.json', 'utf8')).version, entry.version);
    assert.equal(io.realpathSync(root + '/.next-prod'), root + '/.next-prod-candidate');
    assert.equal(io.readFileSync(root + '/.next-prod/BUILD_ID', 'utf8').trim(), entry.build);
    assert.ok(Object.keys(entry.sourceFiles).length > 100 && Object.keys(entry.buildFiles).length > 10);
    for (const [base, files] of [[root, entry.sourceFiles], [root + '/.next-prod-candidate', entry.buildFiles]]) {
      for (const [file, expected] of Object.entries(files)) {
        relative(file); assert.match(expected, HASH);
        const absolute = path.join(base, file);
        assert.equal(io.realpathSync(absolute), absolute, 'Runtime code symlink changed');
        assert.ok(io.lstatSync(absolute).isFile());
        assert.equal(hash(io.readFileSync(absolute)), expected, 'Program content changed: ' + file);
      }
    }
    return entry;
  }
  function capturedControl({ verifyReleases = true } = {}) {
    privileged(); rootChain(control);
    assert.equal(call('/usr/bin/findmnt', ['-n', '-o', 'TARGET', '-T', control]), '/data');
    const guard = snapshot(guardFile, { maximum: 128 * 1024 });
    assert.equal(guard.sha256, PRICING_START_GUARD_SHA256, 'Installed startup guard differs; do not replace it');
    const allowed = snapshot(allowedFile), value = allowedShape(jsonOf(allowed));
    assert.equal(guard.mode, 0o440); assert.equal(allowed.mode, 0o440);
    assert.equal(allowed.gid, guard.gid); assert.equal(allowed.gid, directory(control).gid);
    assert.ok(!allowed.attributes.includes('i'), 'Never unprotect the original allowlist');
    const marker = markerSnapshot(value.marker);
    if (verifyReleases) for (const entry of value.releases) sourceCheck(entry.root, value);
    return { schema: 'pricing-start-control-capture.v1', control, guard, allowed, marker,
      chain: [directory('/data'), directory(PROJECT), directory(path.dirname(control)), directory(control)],
      at: new Date(now()).toISOString(), originalGuardExecuted: false };
  }
  function assertCaptured(captured, expectedAllowed = captured.allowed) {
    assert.equal(captured.schema, 'pricing-start-control-capture.v1'); assert.equal(captured.control, control);
    const actual = capturedControl({ verifyReleases: false });
    same(captured.chain, actual.chain, 'Control directory identity changed');
    same(captured.guard, actual.guard, 'Installed guard changed'); same(captured.marker, actual.marker, 'Original root+i marker changed');
    same(expectedAllowed, actual.allowed, 'Allowlist CAS source bytes or identity changed');
    return actual;
  }
  function compiledHashes(root) {
    const base = path.join(root, '.next-prod-candidate'), result = {};
    const walk = directoryName => {
      const absoluteDirectory = path.join(base, directoryName); directory(absoluteDirectory, false);
      for (const entry of io.readdirSync(absoluteDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.posix.join(directoryName, entry.name), absolute = path.join(base, file);
        assert.ok(!entry.isSymbolicLink(), 'Compiled code symlink refused');
        if (entry.isDirectory()) walk(file);
        else { assert.ok(entry.isFile()); assert.equal(io.realpathSync(absolute), absolute); result[file] = hash(io.readFileSync(absolute)); }
      }
    };
    walk('server'); walk('static');
    for (const file of io.readdirSync(base).filter(file => file === 'BUILD_ID' || file.endsWith('.json')).sort()) {
      const absolute = path.join(base, file); assert.ok(io.lstatSync(absolute).isFile() && !io.lstatSync(absolute).isSymbolicLink());
      result[file] = hash(io.readFileSync(absolute));
    }
    return result;
  }
  function exactSourceFiles(root, files) {
    assert.ok(files && Object.keys(files).length > 100);
    const runtime = new Set(['.env', '.deployed-commit', '.next-prod', '.next-prod-candidate', 'node_modules', 'storage',
      '.role-tests', '.release-tmp', '.candidate-fixtures', 'public/uploads', 'public/videos']);
    const actual = [];
    const walk = current => {
      for (const entry of io.readdirSync(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name), file = path.relative(root, absolute);
        if (runtime.has(file)) continue; // Never read secrets, business files or fixture databases.
        relative(file);
        assert.ok(!/(^|\/)\.env(?:\.|$)|\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$/i.test(file));
        assert.ok(!entry.isSymbolicLink(), 'Unexpected source symlink');
        if (entry.isDirectory()) walk(absolute); else { assert.ok(entry.isFile()); actual.push(file); }
      }
    };
    walk(root); same(Object.keys(files).sort(), actual.sort(), 'Source manifest must cover the exact program source tree');
    for (const [file, expected] of Object.entries(files)) { relative(file); assert.match(expected, HASH); assert.equal(hash(io.readFileSync(path.join(root, file))), expected); }
  }
  function candidateEntry(candidate, label, runId, manifestSha256, releaseManifest) {
    assert.ok(candidate && typeof candidate === 'object'); assert.match(candidate.source, SOURCE);
    assert.equal(candidate.root, PROJECT + '/managed-releases/' + candidate.source);
    assert.equal(io.realpathSync(candidate.root), candidate.root);
    const proof = candidate.buildProof;
    assert.ok(['rate-impl2-candidate-build.v1', 'sd2-candidate-build-reuse.v1', GUARD_BUILD_TAIL_SCHEMA].includes(proof?.schema));
    if (proof.schema === GUARD_BUILD_TAIL_SCHEMA) {
      assert.equal(label, 'guard', 'A retained build tail is only a guard candidate');
      assert.ok(releaseManifest && typeof releaseManifest === 'object', 'A guard tail requires the real private release manifest');
      assert.equal(releaseManifest.reuseBuilds, undefined, 'A guard tail is not a reused candidate admission');
      assert.equal(releaseManifest.runId, runId); assert.equal(releaseManifest.guard.root, candidate.root);
      assert.equal(releaseManifest.guard.source, candidate.source); assert.equal(releaseManifest.guard.version, candidate.version);
      assertFreshCandidateEvidence(proof, releaseManifest, 'guard', now());
    }
    if (proof.schema === 'sd2-candidate-build-reuse.v1') {
      assert.equal(proof.newCompilationClaimed, false); assert.equal(proof.originalTimesChanged, false);
      assert.equal(proof.reuseInputsFullyVerified, true); assert.equal(proof.originalBuild.source, candidate.source);
      assert.equal(proof.originalBuild.build, candidate.build);
    }
    assert.equal(proof.verifiedSourceAndGates, true, 'Controller must actually verify both native gates and locked source');
    assert.equal(proof.runId, runId); assert.equal(proof.manifestSha256, manifestSha256); assert.equal(proof.exitCode, 0);
    for (const key of ['source', 'build']) assert.equal(proof[key], candidate[key]);
    const started = proof.startedAt, finished = proof.finishedAt;
    assert.ok(Number.isSafeInteger(started) && Number.isSafeInteger(finished) && started > 0 && started <= finished && finished <= now());
    assert.ok(typeof proof.gateReceipt === 'string' && path.isAbsolute(proof.gateReceipt), 'Original native gate-receipt path is required');
    assert.match(candidate.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
    if (candidate.buildProof.label !== undefined) assert.equal(candidate.buildProof.label, label);
    const manifest = candidate.sourceManifest;
    assert.equal(manifest.source, candidate.source); if (manifest.version !== undefined) assert.equal(manifest.version, candidate.version);
    exactSourceFiles(candidate.root, manifest.files);
    const entry = { root: candidate.root, source: candidate.source, version: candidate.version, build: candidate.build,
      sourceFiles: structuredClone(manifest.files), buildFiles: compiledHashes(candidate.root) };
    sourceCheck(entry.root, { releases: [entry] });
    return entry;
  }
  function verifyFixedProgramEntry(entry) {
    privileged(); sourceCheck(entry.root, { releases: [entry] }); exactSourceFiles(entry.root, entry.sourceFiles);
    same(entry.buildFiles, compiledHashes(entry.root), 'Fixed program contains changed or additional compiled files');
    return { source: entry.source, build: entry.build, sourceFiles: Object.keys(entry.sourceFiles).length,
      buildFiles: Object.keys(entry.buildFiles).length, readOnly: true, candidateFreshGateClaimed: false };
  }
  function buildPair({ captured, runId, manifestSha256, main, guard, reuseBuilds, manifest }) {
    privileged(); assertCaptured(captured); runIdCheck(runId); assert.match(manifestSha256, HASH);
    const previous = allowedShape(jsonOf(captured.allowed)); assert.notEqual(runId, previous.runId);
    if (guard?.buildProof?.schema === GUARD_BUILD_TAIL_SCHEMA) assert.equal(reuseBuilds, undefined);
    const releases = [candidateEntry(main, 'main', runId, manifestSha256, manifest), candidateEntry(guard, 'guard', runId, manifestSha256, manifest)];
    assert.notEqual(releases[0].source, releases[1].source);
    assertPricingPairTransition({ previous, releases, proofs: { main: main.buildProof, guard: guard.buildProof },
      reuseBuilds, runId, manifestSha256 }, now());
    const allowed = { ...previous, runId, at: new Date(now()).toISOString(), releases };
    const bytes = Buffer.from(JSON.stringify(allowed) + '\n');
    assertCaptured(captured);
    return { schema: 'pricing-start-pair.v1', runId, manifestSha256, baseAllowedSha256: captured.allowed.sha256,
      guardSha256: captured.guard.sha256, markerSha256: captured.marker.sha256,
      bytesBase64: bytes.toString('base64'), sha256: hash(bytes), allowed,
      originalGuardExecuted: false, actualExecStartPreVerified: false };
  }
  function privatePath(file, runId) {
    assert.ok(typeof file === 'string' && path.resolve(file) === file
      && file.startsWith(PROJECT + '/release-staging/' + runId + '/'), 'Receipt must be in this private release stage');
    rootChain(path.dirname(file));
  }
  function fsyncDirectory(file) { const descriptor = io.openSync(file, io.constants.O_RDONLY | io.constants.O_DIRECTORY | io.constants.O_NOFOLLOW); try { io.fsyncSync(descriptor); } finally { io.closeSync(descriptor); } }
  function exclusiveFile(file, bytes, gid, mode) {
    const descriptor = io.openSync(file, io.constants.O_WRONLY | io.constants.O_CREAT | io.constants.O_EXCL | io.constants.O_NOFOLLOW, 0o600);
    try { io.writeFileSync(descriptor, bytes); io.fchownSync(descriptor, 0, gid); io.fchmodSync(descriptor, mode); io.fsyncSync(descriptor); }
    finally { io.closeSync(descriptor); }
    fsyncDirectory(path.dirname(file));
    return snapshot(file);
  }
  async function underLock(work) {
    privileged(); rootChain(control);
    const lock = exclusiveFile(lockFile, Buffer.from(JSON.stringify({ pid: process.pid, token: randomUUID(), at: new Date(now()).toISOString() }) + '\n'), 0, 0o600);
    try { return await work(() => same(lock, snapshot(lockFile), 'Pricing pair lock changed')); }
    finally {
      // Only remove this invocation's own lock. No stale-lock takeover/retry.
      same(lock, snapshot(lockFile), 'Pricing pair lock changed; preserve it for diagnosis');
      io.unlinkSync(lockFile); fsyncDirectory(control);
    }
  }
  function stoppedWriters() {
    return Object.fromEntries(PRICING_WRITER_SERVICES.map(service => {
      const fields = ['MainPID', 'ControlPID', 'ActiveState', 'InvocationID', 'ExecMainStartTimestampMonotonic', 'NRestarts'];
      const output = call('/usr/bin/systemctl', ['show', service, ...fields.flatMap(field => ['-p', field])]);
      const value = Object.fromEntries(output.split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
      assert.equal(value.MainPID, '0'); assert.equal(value.ControlPID, '0'); assert.ok(['inactive', 'failed'].includes(value.ActiveState));
      for (const field of fields) assert.ok(Object.hasOwn(value, field), 'Incomplete service stop observation');
      const cgroup = '/sys/fs/cgroup/system.slice/' + service + '/cgroup.procs';
      if (!absent(cgroup)) assert.equal(io.readFileSync(cgroup, 'utf8').trim(), '', 'Writer cgroup is not empty');
      return [service, value];
    }));
  }
  async function stopHook(assertWritersStopped, phase) {
    assert.equal(typeof assertWritersStopped, 'function', 'The real controller stop/drain assertion is required');
    await assertWritersStopped({ phase, services: [...PRICING_WRITER_SERVICES] });
    return stoppedWriters();
  }
  function pairShape(captured, pair) {
    assert.equal(pair.schema, 'pricing-start-pair.v1'); runIdCheck(pair.runId);
    assert.match(pair.manifestSha256, HASH);
    assert.equal(pair.baseAllowedSha256, captured.allowed.sha256); assert.equal(pair.guardSha256, captured.guard.sha256);
    assert.equal(pair.markerSha256, captured.marker.sha256);
    const value = allowedShape(jsonOf(pair)), previous = jsonOf(captured.allowed);
    const omit = input => Object.fromEntries(Object.entries(input).filter(([key]) => !['runId', 'at', 'releases'].includes(key)));
    same(omit(previous), omit(value), 'Only runId/at/releases may change');
    assert.equal(value.runId, pair.runId); same(value, pair.allowed, 'Serialized pair changed');
    return value;
  }
  const startFence = runId => path.join(control, 'start-' + runId + '.json');
  async function publishPricingStartPair({ captured, pair, backupFile, assertWritersStopped }) {
    privileged(); const value = pairShape(captured, pair); privatePath(backupFile, pair.runId);
    return underLock(async assertLock => {
      assertCaptured(captured); assert.ok(absent(startFence(pair.runId)), 'This run already has a writer-start intent');
      for (const entry of value.releases) { exactSourceFiles(entry.root, entry.sourceFiles); sourceCheck(entry.root, value); same(entry.buildFiles, compiledHashes(entry.root), 'Compiled build changed'); }
      const backup = exclusiveFile(backupFile, bytesOf(captured.allowed), captured.allowed.gid, 0o600);
      const stopped = await stopHook(assertWritersStopped, 'publish-pair');
      assertCaptured(captured); assertLock();
      const temporary = path.join(control, '.allowed-' + pair.runId + '-' + randomUUID() + '.tmp');
      exclusiveFile(temporary, bytesOf(pair), captured.allowed.gid, 0o440);
      // This fixed root-only lock serializes cooperating controllers. The final
      // identity+byte comparison prevents replacing an independently changed pair.
      same(stopped, await stopHook(assertWritersStopped, 'publish-pair-final'), 'A writer restarted during pair publication');
      assertCaptured(captured); assertLock();
      io.renameSync(temporary, allowedFile); fsyncDirectory(control);
      const installed = snapshot(allowedFile);
      assert.equal(installed.sha256, pair.sha256); assertCaptured(captured, installed);
      const receiptFile = backupFile + '.published.json';
      const receipt = { schema: 'pricing-start-pair-published.v1', runId: pair.runId, manifestSha256: pair.manifestSha256, control, backupFile,
        backup, previousAllowed: captured.allowed, installed, guard: captured.guard, marker: captured.marker,
        stoppedWriters: stopped, at: new Date(now()).toISOString(), actualExecStartPreVerified: false };
      const durable = exclusiveFile(receiptFile, Buffer.from(JSON.stringify(receipt) + '\n'), captured.allowed.gid, 0o600);
      return { ...receipt, receiptFile, receiptSha256: durable.sha256 };
    });
  }
  function durablePublished(published) {
    assert.equal(published.schema, 'pricing-start-pair-published.v1'); assert.equal(published.control, control);
    privatePath(published.receiptFile, published.runId);
    const record = snapshot(published.receiptFile); assert.equal(record.sha256, published.receiptSha256);
    const expected = { ...published }; delete expected.receiptFile; delete expected.receiptSha256;
    same(expected, jsonOf(record), 'Published transition receipt changed');
  }
  async function markPricingWriterStartIntent({ captured, published, assertWritersStopped }) {
    privileged(); durablePublished(published);
    return underLock(async assertLock => {
      assertCaptured(captured, published.installed);
      same(published.stoppedWriters, await stopHook(assertWritersStopped, 'before-first-new-writer'), 'A writer already started before its durable intent');
      assertLock();
      const fence = startFence(published.runId);
      const value = { schema: 'pricing-new-writer-start-intent.v1', runId: published.runId,
        allowedSha256: published.installed.sha256, transitionReceiptSha256: published.receiptSha256, at: new Date(now()).toISOString() };
      // Do this before any start command. Never remove this durable one-way latch,
      // even when that start fails or the new writer subsequently stops.
      return exclusiveFile(fence, Buffer.from(JSON.stringify(value) + '\n'), captured.allowed.gid, 0o440);
    });
  }
  async function restorePricingStartPair({ captured, published, noNewWriterProof, assertWritersStopped }) {
    privileged(); durablePublished(published);
    assert.ok(noNewWriterProof && typeof noNewWriterProof.file === 'string', 'Explicit durable no-new-writer proof is required');
    privatePath(noNewWriterProof.file, published.runId); assert.match(noNewWriterProof.sha256, HASH);
    return underLock(async assertLock => {
      assertCaptured(captured, published.installed);
      assert.ok(absent(startFence(published.runId)), 'A new writer start was attempted; only the new compatible guard may recover');
      const record = snapshot(noNewWriterProof.file), proof = jsonOf(record);
      assert.equal(record.sha256, noNewWriterProof.sha256); assert.equal(record.mode, 0o600);
      assert.equal(proof.schema, 'pricing-writer-no-new-start.v1'); assert.equal(proof.runId, published.runId);
      assert.equal(proof.allowedSha256, published.installed.sha256); assert.equal(proof.transitionReceiptSha256, published.receiptSha256);
      assert.equal(proof.newWriterStarted, false); assert.equal(proof.startIntentCount, 0);
      const proofDescriptor = io.openSync(noNewWriterProof.file, io.constants.O_RDONLY | io.constants.O_NOFOLLOW);
      try { io.fsyncSync(proofDescriptor); } finally { io.closeSync(proofDescriptor); }
      fsyncDirectory(path.dirname(noNewWriterProof.file));
      const issued = Date.parse(proof.issuedAt), expires = Date.parse(proof.expiresAt);
      assert.ok(issued >= Date.parse(published.at) && issued <= now() && expires >= now() && expires - issued > 0 && expires - issued <= 300000);
      same(published.stoppedWriters, proof.stoppedWriters, 'No-start proof must bind both original stopped service identities');
      same(published.stoppedWriters, await stopHook(assertWritersStopped, 'restore-pair'), 'A writer invocation changed since pair publication');
      same(published.backup, snapshot(published.backupFile), 'Original allowlist backup changed');
      assert.equal(published.backup.sha256, captured.allowed.sha256);
      const temporary = path.join(control, '.restore-' + published.runId + '-' + randomUUID() + '.tmp');
      exclusiveFile(temporary, bytesOf(published.backup), captured.allowed.gid, 0o440);
      same(published.stoppedWriters, await stopHook(assertWritersStopped, 'restore-pair-final'), 'A new writer was started');
      assert.ok(absent(startFence(published.runId))); assertCaptured(captured, published.installed); assertLock();
      io.renameSync(temporary, allowedFile); fsyncDirectory(control);
      const restored = snapshot(allowedFile); assert.equal(restored.sha256, captured.allowed.sha256);
      assertCaptured(captured, restored);
      const result = { schema: 'pricing-start-pair-restored.v1', runId: published.runId, restored,
        proofSha256: record.sha256, at: new Date(now()).toISOString(), noNewWriterStarted: true };
      exclusiveFile(published.backupFile + '.restored.json', Buffer.from(JSON.stringify(result) + '\n'), captured.allowed.gid, 0o600);
      return result;
    });
  }
  return { capturePricingStartControl: capturedControl, buildPair, publishPricingStartPair, verifyFixedProgramEntry,
    markPricingWriterStartIntent, restorePricingStartPair };
}

const production = createPricingStartPairHelper();
export const capturePricingStartControl = production.capturePricingStartControl;
export const buildPair = production.buildPair;
export const publishPricingStartPair = production.publishPricingStartPair;
export const markPricingWriterStartIntent = production.markPricingWriterStartIntent;
export const restorePricingStartPair = production.restorePricingStartPair;
export const verifyFixedProgramEntry = production.verifyFixedProgramEntry;

