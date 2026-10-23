import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { APPROVED_HD_LEGACY_READY, APPROVED_HD_HISTORICAL_VERSIONS } from './hd-legacy-ready-allowlist.mjs';
import { inspectRetiredHdCaches } from './retired-hd-cache.mjs';
import { isSharedEngine, assertSharedEngineContext } from './engine-context.mjs';
import { readTypedFile, assertTypedFileUnchanged } from './typed-files.mjs';

const PROJECT = '/data/video-api-debugger';
const FORK = '/releases/5a59c00aaba195c42d90c612a37224ad59b12ee0/storage/hd-derivatives';
const STORAGE = '/releases/80d5cf6f1ec489ea93257d42e8dd5c7e4e782560/storage';
const HASH = /^[a-f0-9]{64}$/;
const SYSTEM_PATH = '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const call = (bin, args, options = {}) => execFileSync(bin, args, { encoding: 'utf8', timeout: 30000,
  maxBuffer: 16 * 1024 * 1024, env: { PATH: SYSTEM_PATH, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' }, ...options }).trim();
const DISCOVERY_ADMISSION = Symbol('private-before-maintenance-discovery-observation');
const COMPILED_CACHE_PROOFS = new WeakMap();
const LEGACY_EXECUTION_SOURCE_PROOFS = new WeakMap();
const LEGACY_HD_WRITER_SHA256 = '7442f68dd8ce7db49390293e722107c2bc57b72ea43976541427978076858fbf';
class DiscoveryAdmissionBusy extends Error {
  constructor(phase, proof) { super('Known canonical discovery lease observed at ' + phase); this.phase = phase; this.proof = proof; }
}
const DISCOVERY_SOURCES = ['src/lib/media/hd-derivatives.ts', 'src/lib/media/hd-discovery.ts',
  'src/lib/media/hd-resource-state.ts', 'scripts/process-hd-derivatives.ts', 'src/lib/media/hd-storage-root.ts'];
const admissionStat = s => Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'gid', 'mode', 'nlink'].map(k => [k, s[k]]));

function discoveryTreeSnapshot(m, admission) {
  const trees = {};
  for (const [role, root] of [['canonical', m.hdRoot], ['fork', m.hdForkRoot]]) {
    const entries = [], visit = (directory, relative = '') => {
      for (const name of fs.readdirSync(directory).sort()) {
        admission.remaining();
        if (role === 'canonical' && !relative && name === 'discovery.lock') continue;
        const file = path.join(directory, name), item = relative + name, before = fs.lstatSync(file);
        assert.ok(!before.isSymbolicLink(), 'Discovery observation cannot follow an alias');
        if (!relative && (name.includes('.lock') || name.endsWith('.tmp') || name.endsWith('.publish.json')))
          throw Error('Other HD transient remains: ' + role + ':' + name);
        const row = { name: item, stat: admissionStat(before), kind: before.isDirectory() ? 'directory' : before.isFile() ? 'file' : 'other' };
        if (before.isFile() && (name.endsWith('.json') || relative.startsWith('.runs/'))) {
          const bytes = readRegular(file); row.sha256 = sha(bytes);
          if (!relative && HASH.test(name.slice(0, -5)) && name.endsWith('.json')) {
            const job = JSON.parse(bytes), exited = typeof job.executionExitedAt === 'string' && Number.isFinite(Date.parse(job.executionExitedAt));
            const known = !job.processor || job.processor.executionId === job.executionId && /^[a-f0-9-]{36}$/.test(job.executionId || '')
              && Number.isSafeInteger(job.processor.pid) && job.processor.pid > 1 && job.processor.groupId === job.processor.pid
              && job.processor.host === os.hostname() && /^\d+$/.test(job.processor.startTicks || '');
            assert.ok(job.status !== 'running' && !(job.executionId && !exited) && !(job.processor && (!exited || !known)),
              'Discovery waiting must not wait for a real or unexplained execution to finish');
          }
        }
        assert.deepEqual(admissionStat(fs.lstatSync(file)), row.stat, 'HD metadata moved during discovery observation');
        entries.push(row);
        if (before.isDirectory()) visit(file, item + '/');
      }
    };
    const bound = fs.lstatSync(root); assert.equal(fs.realpathSync(root), root); assert.ok(bound.isDirectory());
    visit(root);
    trees[role] = { binding: Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode'].map(k => [k, bound[k]])),
      entryCount: entries.length, sha256: sha(stable(entries)) };
  }
  return trees;
}

function readDiscoveryOwner(m, l, admission) {
  admission.check(); admission.remaining();
  const lock = m.hdRoot + '/discovery.lock';
  assert.equal(fs.realpathSync(lock), lock);
  const before = fs.lstatSync(lock); assert.ok(before.isDirectory() && !before.isSymbolicLink());
  assert.equal(before.uid, l.uid); assert.equal(before.gid, l.gid); assert.equal(before.mode & 0o7777, 0o755);
  assert.deepEqual(fs.readdirSync(lock), ['owner.json']);
  const ownerFile = lock + '/owner.json', ownerStat = fs.lstatSync(ownerFile);
  assert.equal(fs.realpathSync(ownerFile), ownerFile); assert.equal(ownerStat.uid, l.uid); assert.equal(ownerStat.gid, l.gid);
  assert.equal(ownerStat.mode & 0o7777, 0o600);
  const bytes = readRegular(ownerFile, 4096), owner = JSON.parse(bytes);
  assert.equal(owner.pid, m.live.hd.pid); assert.equal(owner.host, os.hostname());
  assert.match(owner.token || '', /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  const runtime = readDiscoveryRuntime(m, l, admission);
  assert.deepEqual(admissionStat(fs.lstatSync(ownerFile)), admissionStat(ownerStat));
  assert.deepEqual(admissionStat(fs.lstatSync(lock)), admissionStat(before));
  admission.check(); admission.remaining();
  return { lock, directory: admissionStat(before), ownerFile: admissionStat(ownerStat), ownerRecordSha256: sha(bytes), tokenSha256: sha(owner.token), ...runtime };
}
function readDiscoveryRuntime(m, l, admission) {
  const pid = m.live.hd.pid;
  const keys = ['MainPID', 'ControlPID', 'InvocationID', 'ExecMainStartTimestampMonotonic', 'ControlGroup', 'ActiveState', 'SubState', 'WorkingDirectory'];
  const state = l.isolated ? structuredClone(m.hdAdmissionFixtureUnit) : Object.fromEntries(call('systemctl', ['show', m.live.hd.unit,
    ...keys.flatMap(k => ['-p', k])], { timeout: admission.remaining() }).split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  for (const k of keys) assert.ok(Object.hasOwn(state, k), 'Discovery owner unit field missing: ' + k);
  assert.equal(state.MainPID, String(pid)); assert.equal(state.ControlPID, '0');
  assert.equal(state.InvocationID, m.live.hd.invocation); assert.equal(state.ExecMainStartTimestampMonotonic, m.live.hd.execMainStartTimestampMonotonic);
  assert.equal(state.ActiveState, 'active'); assert.equal(state.SubState, 'running'); assert.equal(state.WorkingDirectory, m.live.hd.root);
  assert.equal(state.ControlGroup, '/system.slice/' + m.live.hd.unit);
  const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  assert.ok(!['Z', 'X', 'x'].includes(fields[0])); assert.match(fields[19], /^\d+$/);
  assert.equal(Number(fields[2]), pid, 'Discovery owner process group changed');
  const hz = Number(call('getconf', ['CLK_TCK'], { timeout: admission.remaining() })); assert.ok(Number.isSafeInteger(hz) && hz > 0);
  assert.equal(fields[19], String(Math.floor(Number(state.ExecMainStartTimestampMonotonic) * hz / 1000000)));
  assert.equal(fs.realpathSync('/proc/' + pid + '/cwd'), m.live.hd.root);
  const cgroup = fs.readFileSync('/proc/' + pid + '/cgroup', 'utf8').trim();
  if (!l.isolated) assert.equal(cgroup, '0::' + state.ControlGroup);
  else assert.equal(cgroup, m.hdAdmissionFixtureCgroup);
  const sources = {};
  for (const file of DISCOVERY_SOURCES) {
    admission.remaining(); const live = sha(readRegular(m.live.hd.root + '/' + file)), candidate = sha(readRegular(m.main.root + '/' + file));
    assert.equal(live, candidate, 'Discovery owner source differs from the current reviewed candidate: ' + file); sources[file] = live;
  }
  admission.remaining();
  return { pid, host: os.hostname(), startTicks: fields[19], processGroup: Number(fields[2]), cgroup, state, sources };
}

export async function inspectHdBeforeMaintenance(m, { sourceRoot, deadline, scanDeadline, check, waitBudgetMs = 15000, record } = {}) {
  if (m.protectedIncrement && (isSharedEngine(m) || scanDeadline !== undefined)) {
    assert.ok(Number.isSafeInteger(scanDeadline) && typeof check === 'function' && typeof record === 'function');
    let sequence = 0;
    const prior = { [DISCOVERY_ADMISSION]: true, deadline: scanDeadline,
      remaining() { check(); const left = scanDeadline - Date.now();
        if (left <= 0) throw Object.assign(Error('HD reconciliation scan admission expired'), { code: 'HD_RECONCILIATION_SCAN_DEADLINE' });
        return Math.min(30000, left); },
      check,
      inventory(root, result) { record('inventory-' + (++sequence), { at: Date.now(), role: root === m.hdRoot ? 'canonical' : 'fork',
        completed: true, signature: result.signature, transients: result.transients, cacheRefusals: result.cacheRefusals,
        jobs: result.jobs.size, controlSha256: result.controlSha256 }); },
    };
    prior.remaining();
    const result = await inspectHdReconciliation(m, { sourceRoot, final: false, retiredCachePhase: 'admission',
      scanDeadline, check, waitBudgetMs, admissionObservation: prior });
    prior.remaining(); record('strict-result', { at: Date.now(), result }); return result;
  }
  const startedAt = Date.now(); assert.ok(Number.isSafeInteger(deadline) && typeof check === 'function' && typeof record === 'function');
  deadline = Math.min(deadline, startedAt + 15000);
  let attempt = 0, sequence = 0;
  const admission = { [DISCOVERY_ADMISSION]: true, deadline, check,
    remaining() { const value = deadline - Date.now(); if (value <= 0) throw Object.assign(Error('HD discovery admission hard deadline expired'), { code: 'HD_DISCOVERY_ADMISSION_DEADLINE' }); return Math.min(30000, value); },
    inventory(root, result) { record('inventory-' + (++sequence), { attempt, at: Date.now(), role: root === m.hdRoot ? 'canonical' : 'fork',
      completed: true, signature: result.signature, transients: result.transients, jobs: result.jobs.size, controlSha256: result.controlSha256 }); },
    observe(phase) {
      admission.remaining();
      record('boundary-' + (++sequence), { attempt, at: Date.now(), phase, completedStrictResult: false });
      if (!fs.existsSync(m.hdRoot + '/discovery.lock')) return;
      const proof = readDiscoveryOwner(m, l, admission);
      assert.ok(initialSnapshot, 'Discovery wait lacks an unchanged pre-inspection metadata snapshot');
      assert.deepEqual(discoveryTreeSnapshot(m, admission), initialSnapshot, 'HD task, cache, control or path identity changed; do not wait into safety');
      throw new DiscoveryAdmissionBusy(phase, proof);
    },
  };
  check(); const l = layout(m, admission);
  assert.equal(m.privateMultiviewInstall, true);
  if (!l.isolated) {
    assert.equal(m.hdAdmissionFixtureUnit, undefined); assert.equal(m.hdAdmissionFixtureCgroup, undefined);
    assert.equal(m.live.hd.unit, 'sd2-hd-derivatives.service'); assert.equal(m.main.root, sourceRoot);
  } else assert.ok(m.hdAdmissionFixtureUnit && typeof m.hdAdmissionFixtureCgroup === 'string');
  let initialSnapshot;
  try { initialSnapshot = discoveryTreeSnapshot(m, admission); }
  catch (error) { record('initial-snapshot-unavailable', { at: Date.now(), error: String(error) }); }
  const invoke = async () => {
    check(); admission.remaining(); attempt++;
    record('strict-start-' + attempt, { attempt, at: Date.now(), deadline, fixtureFinalOnly: l.isolated });
    try {
      const result = await inspectHdReconciliation(m, { sourceRoot, final: l.isolated, ...(l.isolated ? {} : { retiredCachePhase: 'admission' }), admissionObservation: admission });
      check(); admission.remaining();
      record('strict-result-' + attempt, { attempt, at: Date.now(), result }); return result;
    } catch (error) {
      record('strict-refused-' + attempt, { attempt, at: Date.now(), exactKnownDiscoveryCollision: error instanceof DiscoveryAdmissionBusy,
        phase: error.phase || null, proof: error.proof || null, error: String(error), completedStrictResult: false }); throw error;
    }
  };
  let busy;
  try { return await invoke(); }
  catch (error) { if (!(error instanceof DiscoveryAdmissionBusy)) throw error; busy = error; }
  record('known-busy', { at: Date.now(), phase: busy.phase, proof: busy.proof, initialSnapshot, maximumMs: 15000, deadline });
  const originalRuntime = Object.fromEntries(['pid', 'host', 'startTicks', 'processGroup', 'cgroup', 'state', 'sources'].map(k => [k, busy.proof[k]]));
  while (fs.existsSync(busy.proof.lock)) {
    check(); admission.remaining();
    try { assert.deepEqual(readDiscoveryOwner(m, l, admission), busy.proof, 'Discovery owner or file identity drifted while waiting'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!fs.existsSync(busy.proof.lock)) break;
      // The already-bound owner removes owner.json before rmdir. An empty,
      // identical directory is only pending cleanup, never an accepted lease.
      const stat = fs.lstatSync(busy.proof.lock);
      for (const k of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink']) assert.equal(stat[k], busy.proof.directory[k]);
      assert.deepEqual(fs.readdirSync(busy.proof.lock), []);
      assert.deepEqual(readDiscoveryRuntime(m, l, admission), originalRuntime);
    }
    assert.deepEqual(discoveryTreeSnapshot(m, admission), initialSnapshot, 'HD metadata changed while waiting');
    await new Promise(resolve => setTimeout(resolve, Math.min(10, admission.remaining())));
  }
  check(); admission.remaining();
  assert.deepEqual(readDiscoveryRuntime(m, l, admission), originalRuntime, 'HD runtime changed during natural discovery release');
  assert.deepEqual(discoveryTreeSnapshot(m, admission), initialSnapshot, 'HD metadata changed during natural discovery release');
  record('natural-release', { at: Date.now(), originalOwner: busy.proof, forced: false, metadataUnchanged: true });
  // No exception translation on this second call. Only a complete original strict
  // result may reach the caller's unchanged canEnterControlledDrain assertion.
  const result = await invoke();
  assert.equal(l.isolated ? result.safe : result.canEnterControlledDrain, true, 'Fresh original HD admission remains unsafe');
  check(); admission.remaining();
  assert.deepEqual(readDiscoveryRuntime(m, l, admission), originalRuntime, 'HD runtime changed across the fresh strict inspection');
  assert.deepEqual(discoveryTreeSnapshot(m, admission), initialSnapshot, 'HD metadata changed across the single fresh strict inspection');
  record('accepted-fresh', { at: Date.now(), durationMs: Date.now() - startedAt, attempts: attempt, deadline, originalStrictPredicatePassed: true,
    fixtureFinalOnly: l.isolated, admissibleForRelease: !l.isolated });
  return result;
}

function layout(m, admission) {
  if (m.hdStorageIsolationRoot === undefined) {
    assert.deepEqual(m.hdLegacyReady, APPROVED_HD_LEGACY_READY, 'The historical exception must be the exact root-approved inventory');
    assert.deepEqual(m.hdHistoricalVersions, APPROVED_HD_HISTORICAL_VERSIONS, 'The old-version preservation must be the exact root-approved inventory');
  }
  let project = PROJECT, isolated = false;
  if (m.hdStorageIsolationRoot !== undefined) {
    assert.equal(process.env.NODE_ENV, 'test', 'Isolation is available only to the offline engineering process');
    const root = m.hdStorageIsolationRoot;
    assert.equal(fs.realpathSync(root), root);
    assert.ok(root.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)
      && path.basename(root).startsWith('sd2-hd-storage-engineering-'));
    const s = fs.lstatSync(root);
    assert.ok(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid() && (s.mode & 0o7777) === 0o700);
    project = path.join(root, 'project'); isolated = true;
  } else {
    assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  }
  assert.equal(m.projectRoot, project); assert.equal(m.hdRoot, project + '/var-lib/storage/hd-derivatives');
  assert.equal(m.hdForkRoot, project + FORK); assert.equal(m.storageRoot, project + STORAGE);
  assert.equal(m.hdWorkerLockPath, project + '/var-lib/storage/hd-worker.lock');
  assert.equal(m.uploadsRoot, project + '/var-lib/uploads');
  const legacyApproval = m.hdLegacyReady || null;
  if (legacyApproval) validateLegacyApproval(m, legacyApproval);
  const historicalApproval = m.hdHistoricalVersions || null;
  if (historicalApproval) validateHistoricalApproval(m, historicalApproval);
  let uid = process.getuid(), gid = process.getgid();
  if (!isolated) {
    assert.match(m.appUser, /^[a-z_][a-z0-9_-]{0,31}$/); assert.notEqual(m.appUser, 'root');
    uid = Number(call('id', ['-u', m.appUser], admission ? { timeout: admission.remaining() } : {}));
    gid = Number(call('id', ['-g', m.appUser], admission ? { timeout: admission.remaining() } : {}));
    assert.ok(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0);
    assert.equal(fs.realpathSync('/data'), '/data');
    const data = fs.statSync('/data');
    assert.notEqual(data.dev, fs.statSync('/').dev, 'The data volume must be a real distinct mount');
    assert.ok(fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').some(line => line.split(' ')[4] === '/data' && line.includes(' - ')));
  }
  const compiledCacheProof = COMPILED_CACHE_PROOFS.get(m);
  if (m.hdCompiledCacheProofs !== undefined) assert.equal(m.hdCompiledCacheProofs, compiledCacheProof?.capability,
    'HD compiled cache proof must come from the original successful capsule verifier');
  if (compiledCacheProof) for (const descriptor of compiledCacheProof.descriptors) {
    const live = m.live?.hd?.sourceProof ? { ...m.live.hd.sourceProof, source: m.live.hd.source, root: m.live.hd.root } : null;
    assert.ok([m.main, m.guard, live].some(value => value?.source === descriptor.source && value.root === descriptor.sourceRoot
      && value.sourceManifest === descriptor.sourceManifest && value.archive === descriptor.archive), 'Compiled cache release provenance changed');
  }
  if (compiledCacheProof) for (const item of compiledCacheProof.bindings) assert.deepEqual(admissionStat(fs.lstatSync(item.file)), item.stat,
    'Verified HD compiled cache source/capsule binding changed');
  if (compiledCacheProof) for (const snapshot of compiledCacheProof.systemBindings) assertTypedFileUnchanged(snapshot);
  return { isolated, project, uid, gid, legacyApproval, historicalApproval, compiledCaches: compiledCacheProof?.entries,
    legacyExecutionSource: () => readLegacyHdExecutionSource(m, uid),
    dataDevice: fs.statSync(isolated ? project : '/data').dev };
}

function readLegacyHdExecutionSource(m, uid) {
  const live = m.live?.hd, source = live?.sourceProof;
  assert.ok(live && source && typeof source.sourceManifest === 'string' && typeof source.archive === 'string',
    'Unrecorded legacy execution requires the real original writer source archive');
  const identity = { source: live.source, root: live.root, sourceManifest: source.sourceManifest, archive: source.archive };
  const previous = LEGACY_EXECUTION_SOURCE_PROOFS.get(m);
  if (previous) {
    assert.deepEqual(previous.identity, identity);
    for (const item of previous.bindings) assert.deepEqual(admissionStat(fs.lstatSync(item.file)), item.stat);
    return previous.proof;
  }
  const bindings = [], bind = file => {
    assert.equal(fs.realpathSync(file), file); const stat = admissionStat(fs.lstatSync(file));
    assert.ok([0, uid].includes(stat.uid) && !(stat.mode & 0o022) && stat.nlink === 1);
    const bytes = readRegular(file); assert.deepEqual(admissionStat(fs.lstatSync(file)), stat); bindings.push({ file, stat }); return bytes;
  };
  assert.match(live.source || '', /^[a-f0-9]{40}$/); assert.equal(fs.realpathSync(live.root), live.root);
  const manifest = JSON.parse(bind(source.sourceManifest)); assert.equal(manifest.project, 'video-api-debugger'); assert.equal(manifest.source, live.source);
  assert.match(manifest.archiveSha256 || '', HASH);
  assert.equal(fs.realpathSync(source.archive), source.archive); const archive = admissionStat(fs.lstatSync(source.archive));
  assert.ok(fs.lstatSync(source.archive).isFile() && archive.size > 0 && archive.nlink === 1
    && [0, uid].includes(archive.uid) && !(archive.mode & 0o022));
  assert.equal(fileSha256(source.archive), manifest.archiveSha256); assert.deepEqual(admissionStat(fs.lstatSync(source.archive)), archive);
  bindings.push({ file: source.archive, stat: archive });
  const writer = 'src/lib/media/hd-derivatives.ts', bytes = bind(live.root + '/' + writer), digest = sha(bytes);
  assert.equal(manifest.files?.[writer], digest); assert.equal(digest, LEGACY_HD_WRITER_SHA256, 'Legacy writer bytes have not been previously proved');
  // Exact approved bytes plus their real original archive establish the old
  // protocol. A missing property/string alone is never a legacy authority.
  assert.ok(bytes.includes(Buffer.from("protocol = 'hd-job-v2'")) && !bytes.includes(Buffer.from('HD_EXECUTION_EVIDENCE_PROTOCOL')));
  const proof = Object.freeze({ source: live.source, root: live.root, writerSha256: digest, protocol: 'legacy-without-execution-history' });
  LEGACY_EXECUTION_SOURCE_PROOFS.set(m, { identity, bindings, proof }); return proof;
}

// The release controller supplies its actual sealed-capsule verifier, not a
// boolean or an assertion copied from manifest JSON. The capability is local to
// this exact in-memory release manifest and never serializable/replayable.
export function readHdCompiledCacheProofs(m, references, verifyCapsule) {
  assert.ok(Array.isArray(references) && references.length > 0 && references.length <= 3);
  assert.equal(typeof verifyCapsule, 'function');
  const l = layout(m), entries = new Map(), bindings = [], systemBindings = [];
  const bind = (file, maximum = 16 * 1024 * 1024) => {
    assert.equal(fs.realpathSync(file), file); const stat = admissionStat(fs.lstatSync(file));
    assert.ok([0, l.uid].includes(stat.uid) && !(stat.mode & 0o022) && stat.nlink === 1);
    const bytes = readRegular(file, maximum); assert.deepEqual(admissionStat(fs.lstatSync(file)), stat);
    bindings.push({ file, stat }); return bytes;
  };
  const descriptors = [];
  for (const reference of references) {
    const verified = verifyCapsule(reference);
    assert.ok(verified && typeof verified.then !== 'function', 'The original capsule must be synchronously verified before cache use');
    assert.deepEqual(verified, reference, 'Compiled cache descriptor differs from the freshly verified original capsule');
    const live = m.live?.hd?.sourceProof ? { ...m.live.hd.sourceProof, source: m.live.hd.source, root: m.live.hd.root } : null;
    const candidate = [m.main, m.guard, live].find(value => value?.source === reference.source && value.root === reference.sourceRoot
      && value.sourceManifest === reference.sourceManifest && value.archive === reference.archive);
    assert.ok(candidate); assert.equal(reference.sourceRoot, candidate.root); assert.equal(fs.realpathSync(reference.sourceRoot), reference.sourceRoot);
    assert.equal(reference.sourceManifest, candidate.sourceManifest); assert.equal(reference.archive, candidate.archive);
    const manifest = JSON.parse(bind(reference.sourceManifest));
    assert.equal(manifest.project, 'video-api-debugger'); assert.equal(manifest.source, reference.source);
    assert.match(manifest.archiveSha256 || '', HASH); assert.ok(manifest.files && typeof manifest.files === 'object');
    // Archive bytes were verified by the original capsule verifier. Pin that
    // already-verified entity here without rehashing every capsule per cache.
    assert.equal(fs.realpathSync(reference.archive), reference.archive);
    const archive = admissionStat(fs.lstatSync(reference.archive));
    assert.ok(fs.lstatSync(reference.archive).isFile() && archive.size > 0 && archive.nlink === 1
      && [0, l.uid].includes(archive.uid) && !(archive.mode & 0o022));
    bindings.push({ file: reference.archive, stat: archive });
    assert.deepEqual(Object.keys(reference.compiler).sort(), ['esbuild', 'node', 'tsx']);
    for (const [kind, compiler] of Object.entries(reference.compiler)) {
      assert.ok(typeof compiler.version === 'string' && /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(compiler.version));
      assert.match(compiler.sha256 || '', HASH);
      if (kind === 'node') {
        // System package managers may legitimately retain root-owned hardlink
        // or symlink aliases. Preserve the typed reader's complete before/after
        // descriptor, alias, root-parent chain and SHA proof for revalidation.
        const read = readTypedFile({ file: compiler.file, category: 'system', maximumBytes: 128 * 1024 * 1024,
          expectedSha256: compiler.sha256 });
        systemBindings.push(read.snapshot);
      } else assert.equal(sha(bind(compiler.file, 128 * 1024 * 1024)), compiler.sha256);
    }
    assert.ok(Array.isArray(reference.entries) && reference.entries.length === 3);
    const sourceFiles = new Set();
    for (const item of reference.entries) {
      assert.ok(typeof item.sourceFile === 'string' && !path.isAbsolute(item.sourceFile)
        && path.posix.normalize(item.sourceFile) === item.sourceFile && !item.sourceFile.startsWith('../') && !item.sourceFile.includes('\\'));
      assert.ok(['scripts/process-hd-image.ts', 'src/lib/media/hd-image-processor.ts', 'src/lib/media/hd-encoder.ts'].includes(item.sourceFile));
      assert.ok(!sourceFiles.has(item.sourceFile)); sourceFiles.add(item.sourceFile);
      assert.match(item.sourceSha256 || '', HASH); assert.equal(manifest.files[item.sourceFile], item.sourceSha256);
      assert.equal(sha(bind(reference.sourceRoot + '/' + item.sourceFile)), item.sourceSha256);
      assert.match(item.cacheSha256 || '', HASH); assert.ok(Number.isSafeInteger(item.cacheBytes) && item.cacheBytes > 0 && item.cacheBytes <= 1024 * 1024);
      const bytes = bind(item.cacheFile, 1024 * 1024), filename = /^(\d+)-([a-f0-9]{40})$/.exec(path.basename(item.cacheFile));
      assert.ok(filename); assert.equal(bytes.length, item.cacheBytes); assert.equal(sha(bytes), item.cacheSha256);
      if (item.cacheKey !== undefined) assert.equal(item.cacheKey, filename[2]);
      if (item.mtimeBucket !== undefined) assert.equal(String(item.mtimeBucket), filename[1]);
      const value = JSON.parse(bytes); assert.deepEqual(Object.keys(value).sort(), ['code', 'map', 'warnings']);
      assert.ok(typeof value.code === 'string' && value.code.length && Array.isArray(value.warnings) && value.warnings.length === 0);
      assert.equal(value.map?.version, 3); assert.deepEqual(value.map.sources, [reference.sourceRoot + '/' + item.sourceFile]);
      const record = Object.freeze({ source: reference.source, sourceRoot: reference.sourceRoot, sourceFile: item.sourceFile,
        sourceSha256: item.sourceSha256, cacheSha256: item.cacheSha256, cacheBytes: item.cacheBytes, cacheKey: filename[2] });
      if (entries.has(item.cacheSha256)) assert.deepEqual(entries.get(item.cacheSha256), record);
      else entries.set(item.cacheSha256, record);
    }
    descriptors.push({ source: reference.source, sourceRoot: reference.sourceRoot, sourceManifest: reference.sourceManifest,
      archive: reference.archive, compiler: structuredClone(reference.compiler), cacheSha256: reference.entries.map(item => item.cacheSha256).sort() });
  }
  const capability = Object.freeze({ schema: 'hd-compiled-cache-capability.v1', descriptorSha256: sha(stable(descriptors)), candidates: descriptors.length });
  COMPILED_CACHE_PROOFS.set(m, { capability, entries, bindings, systemBindings, descriptors }); return capability;
}

function validateLegacyApproval(m, approval) {
  assert.equal(approval.schema, 'hd-legacy-ready-approval-v1');
  assert.equal(approval.inventorySchema, 'hd-legacy-ready-inventory-v1');
  assert.equal(approval.canonicalRoot, m.hdRoot); assert.match(approval.inventorySha256 || '', HASH);
  assert.ok(Number.isFinite(Date.parse(approval.observedAt))); assert.match(approval.sourceObserved || '', /^[a-f0-9]{40}$/);
  assert.ok(approval.entries && typeof approval.entries === 'object' && !Array.isArray(approval.entries));
  assert.equal(Object.keys(approval.entries).length, approval.count);
  assert.ok(Number.isSafeInteger(approval.count) && approval.count > 0 && approval.count <= APPROVED_HD_LEGACY_READY.count);
  const current = fs.lstatSync(m.hdRoot);
  assert.equal(approval.binding?.dev, String(current.dev), 'HD legacy approval binding changed');
  assert.equal(approval.binding?.ino, String(current.ino), 'HD legacy approval binding changed');
  for (const [key, item] of Object.entries(approval.entries)) {
    assert.match(key, HASH); assert.match(item.manifestSha256 || '', HASH); assert.match(item.sourceIdentitySha256 || '', HASH);
    assert.ok(typeof item.sourceVersion === 'string' && item.sourceVersion.length > 0 && item.sourceVersion.length < 256);
  }
}

const sourceVersion = stat => [stat.dev, stat.ino, stat.bytes, stat.mtimeMs, stat.ctimeMs].join(':');
const identityFields = stat => Object.fromEntries(['dev', 'ino', 'bytes', 'mtimeMs', 'ctimeMs'].map(field => [field, stat[field]]));
function validateHistoricalApproval(m, approval) {
  assert.equal(approval.schema, 'hd-historical-versions-approval-v1');
  assert.equal(approval.inventorySchema, 'hd-historical-version-inventory-v1');
  assert.equal(approval.canonicalRoot, m.hdRoot); assert.match(approval.inventorySha256 || '', HASH);
  assert.ok(Number.isFinite(Date.parse(approval.observedAt)));
  assert.ok(approval.entries && typeof approval.entries === 'object' && !Array.isArray(approval.entries));
  assert.equal(Object.keys(approval.entries).length, approval.count);
  assert.ok(Number.isSafeInteger(approval.count) && approval.count > 0 && approval.count <= APPROVED_HD_HISTORICAL_VERSIONS.count);
  const current = fs.lstatSync(m.hdRoot);
  assert.equal(approval.binding?.dev, String(current.dev)); assert.equal(approval.binding?.ino, String(current.ino));
  for (const [key, item] of Object.entries(approval.entries)) {
    assert.match(key, HASH); assert.equal(item.key, key); assert.match(item.manifestSha256 || '', HASH);
    assert.match(item.sourceIdentitySha256 || '', HASH); assert.match(item.currentKey || '', HASH);
    assert.ok(typeof item.historicalVersion === 'string' && item.historicalVersion.length > 0 && item.historicalVersion.length < 256);
    assert.equal(item.currentVersion, sourceVersion(item.currentSource)); assert.notEqual(item.currentVersion, item.historicalVersion);
    assert.notEqual(item.currentKey, key); assert.equal(item.historicalKeyMatches, true);
    assert.ok(['ready', 'skipped'].includes(item.status));
    if (item.status === 'skipped') { assert.equal(item.reason, 'source_changed'); assert.equal(item.output, null); }
    else {
      assert.equal(item.reason, null); assert.equal(item.output?.lengthMatches, true);
      assert.equal(item.output.integrity, 'hd-output-integrity-v2'); assert.deepEqual(item.output.failedChecks, []);
      for (const field of ['width', 'height', 'bytes']) assert.ok(Number.isSafeInteger(item.output[field]) && item.output[field] > 0);
    }
    for (const value of [item.currentSource, ...(item.output ? [item.output] : [])]) {
      assert.match(value.dev || '', /^\d+$/); assert.match(value.ino || '', /^\d+$/);
      assert.ok(Number.isSafeInteger(value.bytes) && value.bytes > 0 && Number.isFinite(value.mtimeMs) && Number.isFinite(value.ctimeMs));
    }
    assert.equal(Object.hasOwn(m.hdLegacyReady?.entries || {}, key), false, 'Historical versions and reusable legacy exceptions must not overlap');
  }
}

function binding(file, kind, l) {
  const s = fs.lstatSync(file), realpath = fs.realpathSync(file);
  assert.equal(realpath, file, 'HD storage aliases are refused');
  assert.ok(!s.isSymbolicLink() && (kind === 'directory' ? s.isDirectory() : s.isFile()), 'HD binding has the wrong type');
  assert.ok([0, l.uid].includes(s.uid) && !(s.mode & 0o002)
    && (!(s.mode & 0o020) || s.gid === l.gid), 'HD storage ownership or mode is unsafe');
  assert.equal(s.dev, l.dataDevice, 'HD bindings must share the real data volume');
  return { realpath, dev: String(s.dev), ino: String(s.ino), kind, uid: s.uid, gid: s.gid, mode: s.mode & 0o7777 };
}
function fileStat(file, l) {
  const b = binding(file, 'file', l), s = fs.lstatSync(file);
  assert.equal(b.dev, String(s.dev)); assert.equal(b.ino, String(s.ino));
  assert.equal(s.nlink, 1, 'HD files cannot have unknown hard links');
  assert.ok(s.size > 0 && Number.isSafeInteger(s.size));
  return { ...b, bytes: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs };
}
function readRegular(file, maximum = 16 * 1024 * 1024) {
  const before = fs.lstatSync(file);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size > 0 && before.size <= maximum);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd); assert.equal(opened.dev, before.dev); assert.equal(opened.ino, before.ino);
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), linked = fs.lstatSync(file);
    for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'gid', 'mode', 'nlink']) {
      assert.equal(after[field], before[field], 'HD snapshot changed while reading');
      assert.equal(linked[field], before[field], 'HD snapshot was replaced while reading');
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}
function fileSha256(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), digest = createHash('sha256');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) { const length = fs.readSync(fd, buffer, 0, buffer.length, null); if (!length) break; digest.update(buffer.subarray(0, length)); }
    return digest.digest('hex');
  } finally { fs.closeSync(fd); }
}
// Exact tsx 4.21.0 artifacts observed in completed 6512, 76ef, aa5 and 1f7 executions.
// This is a private release exception, not permission to ignore arbitrary caches.
const CLOSED_TSX_CACHE = Object.freeze({
  '1c6da33286272b0e427260d1db85bcd6318e9e2417f2e71bef93cc7bd6ea805b': ['61715c6cae23bef862425316f6761b41be3a1d25', 'src/lib/media/hd-encoder.ts', '/data/video-api-debugger/managed-releases/31bff5a6544a3d18d433b81fa7735ed57b0d012c/'],
  '01c741177ca32ad5cc09f015a5ef9778fcfcc6be7250d4ea4199c4197c2fedc6': ['77be5fcb499ed249a2045f3880a86f805da2db91', 'src/lib/media/hd-image-processor.ts', '/data/video-api-debugger/managed-releases/31bff5a6544a3d18d433b81fa7735ed57b0d012c/'],
  '65eab6f3ed0b03e1790edc31b633c1894e74c98214d9d39911c2c79802ca950d': ['8481e193db6f8d10d578f8fdaaf70e3262397fe6', 'scripts/process-hd-image.ts', '/data/video-api-debugger/managed-releases/31bff5a6544a3d18d433b81fa7735ed57b0d012c/'],
  '1f4126a8b8d061bf60e7ff9bb61ad383ca82cfb83d3623b65542807bbf352595': ['0d75796bda1af1be62f3038e2128d1fa1d27245e', 'src/lib/media/hd-image-processor.ts', '/data/video-api-debugger/managed-releases/4fb7f841ec05f38759bede3e3b4bea73e19c027f/'],
  'd6121d43a9e8b79d890e310929751ba6f945fe1e3c6bd6c105d798c28926b6f6': ['24594e66f13641755dc028c8f5a9bb635970db78', 'src/lib/media/hd-encoder.ts', '/data/video-api-debugger/managed-releases/4fb7f841ec05f38759bede3e3b4bea73e19c027f/'],
  '6238283c3be55d526aecd4e84209cb5a57873d5f812686ec721e81152901c202': ['e59cab488171d517ce50d475b3c6ae3c119d1680', 'scripts/process-hd-image.ts', '/data/video-api-debugger/managed-releases/4fb7f841ec05f38759bede3e3b4bea73e19c027f/'],
  '7ab24fb11c92b3c10e395e9afcdde3e3fae2f7e21b5ddb4c0f66c49128c89e28': ['090e119d1ec39ddad5a8eb0d17a0602e4567fe74', 'src/lib/media/hd-encoder.ts', '/data/video-api-debugger/managed-releases/91943a8ade19cf11cc9fd4a923d56dc3eef318c7/'],
  'fc5b9d49fdc109bafc04d7c186367a169a83f51257afff4043ad89be2ffc67e3': ['18d6e7a81ca2c710572e875889817383d1519eb3', 'src/lib/media/hd-image-processor.ts', '/data/video-api-debugger/managed-releases/91943a8ade19cf11cc9fd4a923d56dc3eef318c7/'],
  'da75f3f3e023b5dd47d737cad3b3433a96fe9148d40c030d8dd200b14aae4b7f': ['d779e8addd8230340c085e574dcfcc40473272fa', 'scripts/process-hd-image.ts', '/data/video-api-debugger/managed-releases/91943a8ade19cf11cc9fd4a923d56dc3eef318c7/'],
  '1848a098d4fc7998c4b79bf5408f9cafadb946f53b7fd4b7a3c672d85e08112d': ['0e1816f24252479507a87fff7fa09ac656a92521', 'scripts/process-hd-image.ts', '/data/video-api-debugger/managed-releases/e00a886e725442e2a330df2ad3fe1b5bf22b63e5/'],
  'e564eec2d029318ddac509a95477a5f223a7ecc625c798870c737dafa968e238': ['591bc0a3f3102ab2dfc91e0cd5b3b13865872510', 'src/lib/media/hd-image-processor.ts', '/data/video-api-debugger/managed-releases/e00a886e725442e2a330df2ad3fe1b5bf22b63e5/'],
  'f0014ea317a1d82e90468f0751e99745f895f4f6ccddbd43aa336e44d0ec65de': ['7d8aff823b786c5a6d3f3f2c929881b7bf6fed49', 'src/lib/media/hd-encoder.ts', '/data/video-api-debugger/managed-releases/e00a886e725442e2a330df2ad3fe1b5bf22b63e5/'],
  '0ea58e832d270cf5c7a2c348c79ae8fb633ddf6f227f06b115ee4b97c122afb8': ['44ed4347635eb13b0b7e83ccc9a2b55c23d16903', 'src/lib/media/hd-image-processor.ts', '/data/video-api-debugger/managed-releases/9c39aeb7de06c3c9e676477febf214c089cb9727/'],
  '5e1cb98f29b939b00f59e8a9c3b7789130bd15030fd7f266a385cae15175db76': ['bee4e21db30359cb2d3e0c1424c6709703eb869d', 'src/lib/media/hd-encoder.ts', '/data/video-api-debugger/managed-releases/9c39aeb7de06c3c9e676477febf214c089cb9727/'],
  '3761edd8bf22b02901422a954125622c4424511786ea462fe95e8d24c395ef35': ['fd1100df7ee417dca950ce4029002ae55652cf34', 'scripts/process-hd-image.ts', '/data/video-api-debugger/managed-releases/9c39aeb7de06c3c9e676477febf214c089cb9727/'],
  'e5f69ac6a6a360fad25886b3d79d7c7fddda326b4e518d42911eab39124593ca': ['9d0708c8eecf214cd6c1c425485e70a52ad2f185', 'src/lib/media/hd-encoder.ts', '/data/video-api-debugger/managed-releases/e01fb18045e2950b45323b4d4ca7f6ce143a2019/'],
  '37800e2e1eb5bba34001d42e35d17a5741453353e575b8b071ad813a442baa3b': ['c14bf5144ec191cd8b6462839285aa1d9b032f75', 'scripts/process-hd-image.ts', '/data/video-api-debugger/managed-releases/e01fb18045e2950b45323b4d4ca7f6ce143a2019/'],
  'e7acbb6768b8ef55305bbebb11684e54d1b875c376d64d7e02649ab9ab1cec18': ['fac1fef79e867c922e3d04b54f2a26fc9b1c9669', 'src/lib/media/hd-image-processor.ts', '/data/video-api-debugger/managed-releases/e01fb18045e2950b45323b4d4ca7f6ce143a2019/'],
  '5927ebec5697865333874724678353ed59ed2c9fe5faacc63716862615639fc0': ['4c4bd8cabc294bf1c5e18b646b63b64fe31d2632', 'src/lib/media/hd-encoder.ts', '/data/video-api-debugger/managed-releases/1f7eb77bf840fa40fef98fa62e8a63df8c944d6a/'],
  'f2ce01b80dbd9997c94c4d78cb4403e9d0bc706ea8b867374af57ab7a439bfd1': ['dcd40435307fd8480afe268104ec5c23d9f85248', 'src/lib/media/hd-image-processor.ts', '/data/video-api-debugger/managed-releases/1f7eb77bf840fa40fef98fa62e8a63df8c944d6a/'],
  '77bd56b281004f739e388f13b4bb404550b0080b8f1469f33e9a537a96e95c5f': ['e9ae92cfa7121d44872e047dc01525bebb77950b', 'scripts/process-hd-image.ts', '/data/video-api-debugger/managed-releases/1f7eb77bf840fa40fef98fa62e8a63df8c944d6a/'],
  'a8cbdf891d38d0a66544b0bc51fbcc5e409dd03a2a61ba90851bcaa2c6b5acad': ['0557deadfefcd2bb54e3f41c91cdb8f7efe5c70e', 'src/lib/media/hd-image-processor.ts'],
  'c07cf1c4f75d8cec2fa97036c410cc739296af1b9ae37730ab639d983b34f487': ['33391d99cfee924dade66d3052aec82be62e314c', 'src/lib/media/hd-encoder.ts'],
  'f312b7e084f51bd68ace6a2ae4edec9fcb53f048c3decbb19a59876041547ac3': ['f06bc3350f8e18645f648098393fa7adeaea1f99', 'scripts/process-hd-image.ts'],
  'adc46ca4830bb0d5f7204bbca6784ef3cb50734414341c6cc1457553427a6aff': ['05dcd673e1692338d7268459c57c8a3c5c41001a', 'scripts/process-hd-image.ts', '/data/video-api-debugger/managed-releases/76ef0f42daeb6969a99e6133b47c0ef8a00019eb/'],
  'cd9eefac1ef045b69aebb9960ad09c9eeff54c8dda591506098ee01f361e26e0': ['43775d5f498166a9f91bcb57602ddbdf24cd6274', 'src/lib/media/hd-image-processor.ts', '/data/video-api-debugger/managed-releases/76ef0f42daeb6969a99e6133b47c0ef8a00019eb/'],
  'd98b1a5b714cebea0949bafe380bdfb557914a2eb8560e0868fb1de135b46c34': ['9c64c857e06356986bc468cf7d6ec29a712901d6', 'src/lib/media/hd-encoder.ts', '/data/video-api-debugger/managed-releases/76ef0f42daeb6969a99e6133b47c0ef8a00019eb/'],
  'd0cf304be5efe657ad5c9c2ef51491b44eba6cc41be3fa62d052f74f9ac61e23': ['479b814ea1a1a0ee72904f827fe130926bf373b9', 'src/lib/media/hd-image-processor.ts', '/data/video-api-debugger/managed-releases/aa5e1681d5e677ff5fdd96e78eac6fb7e47e6fa4/'],
  '672ae2a5c3d8d1c5cb17d823657bddf8f187601e71faed872f1fb2e3c4abf86e': ['76a270fbe44da0c66a8b1941a0b8a1249ff37dbe', 'scripts/process-hd-image.ts', '/data/video-api-debugger/managed-releases/aa5e1681d5e677ff5fdd96e78eac6fb7e47e6fa4/'],
  '7b298473e148d840afc10a5728e31895d61372624dac3584b31c748da47b19c9': ['bc4c294a537e73f60fd81c65267868f2b8d2243e', 'src/lib/media/hd-encoder.ts', '/data/video-api-debugger/managed-releases/aa5e1681d5e677ff5fdd96e78eac6fb7e47e6fa4/'],
});
const CACHE_SOURCE = '/data/video-api-debugger/managed-releases/6512e723804b1e2d1274309498c3e5bb514ee3ae/';
const E01_SOURCE = '/data/video-api-debugger/managed-releases/e01fb18045e2950b45323b4d4ca7f6ce143a2019/';
const C9_SOURCE = '/data/video-api-debugger/managed-releases/9c39aeb7de06c3c9e676477febf214c089cb9727/';
const E00_SOURCE = '/data/video-api-debugger/managed-releases/e00a886e725442e2a330df2ad3fe1b5bf22b63e5/';
const PROJECT_LIST_SOURCE = '/data/video-api-debugger/managed-releases/91943a8ade19cf11cc9fd4a923d56dc3eef318c7/';
const PROJECT_DESIGN_SOURCE = '/data/video-api-debugger/managed-releases/4fb7f841ec05f38759bede3e3b4bea73e19c027f/';
const SIZE_LOG_SOURCE = '/data/video-api-debugger/managed-releases/31bff5a6544a3d18d433b81fa7735ed57b0d012c/';
const E01_SOURCE_PROOF = Object.freeze({
  'scripts/process-hd-image.ts': '2c97cd272b83247ae6720fc2dc12d6572df951fa3a36198ec8d54a5225240639',
  'src/lib/media/hd-image-processor.ts': '59b3662cd0e7d4bdc3723f48477b1e68d4563dce0cca1a4b92e6171b81faa0c5',
  'src/lib/media/hd-encoder.ts': '5fd69b37d024da0fb089d7b02bd723e47d2269f3cabe00137d70994332b4485b',
  'node_modules/tsx/dist/index-7AaEi15b.mjs': '47851348bc3bbc11413edd4bf44758b7a85e28419847583231d74a182b044e22',
  'tsconfig.json': '080e95c3e383af8d51df84f64d06bbee2e53ac8b48da1c1b4020fe3578c622e9',
});
export function assertHdE01CacheSourceProof(observed) {
  assert.deepEqual(observed, E01_SOURCE_PROOF, 'Published HD cache source/compiler provenance changed');
}
function cacheStat(file, kind, l) {
  binding(file, kind, l);
  const s = fs.lstatSync(file);
  assert.equal(s.uid, l.uid); assert.equal(s.gid, l.gid);
  assert.equal(s.mode & 0o022, 0);
  if (kind === 'file') assert.equal(s.nlink, 1);
  return Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'gid', 'mode', 'nlink'].map(key => [key, s[key]]));
}
function hdProcessTable() {
  assert.equal(process.platform, 'linux');
  return fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
    let text;
    try { text = fs.readFileSync('/proc/' + name + '/stat', 'utf8'); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return []; throw error; }
    const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
    assert.ok(fields.length >= 20 && /^\d+$/.test(fields[19]) && /^\d+$/.test(fields[2]));
    return [{ pid: Number(name), group: Number(fields[2]), startTicks: fields[19] }];
  });
}
export function assertHdClosedProcessor(identity, executionId, rows, host = os.hostname()) {
  assert.ok(identity && identity.executionId === executionId && identity.host === host
    && Number.isSafeInteger(identity.pid) && identity.pid > 1 && identity.groupId === identity.pid
    && /^\d+$/.test(identity.startTicks || ''));
  // A reused PID or a zombie is not absence, even if the old start ID differs.
  assert.ok(!rows.some(row => row.pid === identity.pid || row.group === identity.groupId), 'HD processor or group still exists');
}
function assertNoSupersededHdProcess(root) {
  const runs = root + '/.runs/';
  let observed = 0;
  for (const name of fs.readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
    try {
      const identity = () => {
        const text = fs.readFileSync('/proc/' + name + '/stat', 'utf8');
        const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
        assert.ok(fields.length >= 20 && /^\d+$/.test(fields[19]) && /^\d+$/.test(fields[2]));
        return { pid: Number(name), group: Number(fields[2]), startTicks: fields[19] };
      };
      const before = identity();
      const args = fs.readFileSync('/proc/' + name + '/cmdline').toString().split('\0').filter(Boolean);
      const environment = fs.readFileSync('/proc/' + name + '/environ').toString().split('\0');
      const temporary = environment.filter(value => value.startsWith('TMPDIR=')).map(value => value.slice(7));
      const usesRun = value => {
        if (!path.isAbsolute(value)) return false;
        const resolved = path.resolve(value);
        if (resolved === root + '/.runs' || resolved.startsWith(runs)) return true;
        try { const real = fs.realpathSync(value); return real === root + '/.runs' || real.startsWith(runs); }
        catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
      };
      assert.ok(!args.some(value => /(?:^|\/)process-hd-image\.ts$/.test(value)
        || /^(?:ffmpeg|ffmpeg-[\w.-]+)$/.test(path.basename(value)))
        && !temporary.some(usesRun), 'HD child or private run process remains');
      assert.deepEqual(identity(), before, 'HD process inventory identity changed');
      observed++;
    } catch (error) {
      // A process which vanished during this observation cannot still use the
      // old run. Permission failures and unexplained identities are not absence.
      if (['ENOENT', 'ESRCH'].includes(error.code)) continue;
      throw error;
    }
  }
  assert.ok(observed > 0);
  return { observed, complete: true, hdChildrenAbsent: true, privateRunProcessesAbsent: true };
}
function supersededWholeDrainAccepted(proof) {
  if (!proof || proof.phase !== 'drained') return false;
  assert.equal(proof.schema, 'specific-retired-hd-cache.v1');
  assert.equal(proof.accepted, true); assert.equal(proof.historicalPidsRecovered, false);
  assert.match(proof.runId || '', /^[a-f0-9-]{36}$/);
  const drain = proof.drain, state = drain?.state;
  assert.ok(drain && state); assert.equal(drain.cgroupEmpty, true);
  assert.equal(drain.originalPidAbsent, true); assert.equal(drain.relatedProcessorsAbsent, true);
  assert.equal(drain.method, 'current-whole-service-natural-drain-not-historical-PID-reconstruction');
  assert.equal(state.ActiveState, 'inactive'); assert.equal(state.MainPID, '0'); assert.equal(state.ControlPID, '0');
  assert.equal(state.Result, 'success'); assert.equal(state.Restart, 'no'); assert.equal(state.SendSIGKILL, 'no');
  assert.equal(state.TimeoutStopUSec, 'infinity'); assert.equal(state.WorkingDirectory, SIZE_LOG_SOURCE.slice(0, -1));
  return true;
}
export function inspectHdClosedExecutionCache(root, run, l, job, admission, retiredProof) {
  const assertNoTransient = () => {
    admission?.observe('closed-cache-transient-check');
    assert.ok(!fs.readdirSync(root).some(name => name.includes('.lock')
      || name.endsWith('.publish.json') || name.endsWith('.tmp')), 'HD lease, publication or temporary output remains');
  };
  assertNoTransient();
  const match = /^([a-f0-9]{64})\.([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(run);
  assert.ok(match && job && job.key === match[1]);
  const superseded = job.executionId !== match[2];
  if (superseded) {
    assert.match(job.executionId || '', /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    if (l.isolated) assert.equal(process.env.NODE_ENV, 'test');
    else assert.equal(root, PROJECT + '/var-lib/storage/hd-derivatives', 'Superseded attempts require the canonical old worker root');
  }
  assert.ok(['ready', 'failed', 'skipped'].includes(job.status) && job.protocol === 'hd-job-v2'
    && !job.stage && Number.isSafeInteger(job.attempts) && job.attempts > 0);
  assert.ok(job.executionEvidenceProtocol === undefined || job.executionEvidenceProtocol === 'hd-execution-evidence-v1');
  const attempt = job.attemptHistory?.at(-1), started = Date.parse(attempt?.startedAt), exited = Date.parse(job.executionExitedAt);
  const finished = Date.parse(attempt?.finishedAt), updated = Date.parse(job.updatedAt);
  assert.ok(attempt && attempt.attempt === job.attempts && attempt.status === job.status && attempt.sourceVersion === job.version
    && [started, exited, finished, updated].every(Number.isFinite) && started <= exited && exited <= finished
    && finished <= updated && updated <= Date.now());
  assertHdClosedProcessor(job.processor, job.executionId, hdProcessTable());
  const processBefore = superseded || attempt.executionId !== undefined && !(attempt.processor && attempt.childClose && attempt.groupExit)
    ? assertNoSupersededHdProcess(root) : null;
  const directory = path.join(root, '.runs', run), cache = path.join(directory, 'tsx-' + l.uid);
  const runsBefore = cacheStat(path.dirname(directory), 'directory', l);
  const directoryBefore = cacheStat(directory, 'directory', l), cacheBefore = cacheStat(cache, 'directory', l);
  assert.equal(directoryBefore.mode & 0o7777, 0o700);
  assert.deepEqual(fs.readdirSync(directory), ['tsx-' + l.uid]);
  const names = fs.readdirSync(cache).sort(); assert.ok(names.length > 0 && names.length <= 3);
  const proofs = [], cacheSources = new Set();
  for (const name of names) {
    const filename = /^(\d+)-([a-f0-9]{40})$/.exec(name); assert.ok(filename);
    const file = path.join(cache, name), before = cacheStat(file, 'file', l);
    const bytes = readRegular(file, 1024 * 1024), digest = sha(bytes), known = CLOSED_TSX_CACHE[digest], compiled = l.compiledCaches?.get(digest);
    assert.ok(known && known[0] === filename[2] || compiled && compiled.cacheKey === filename[2] && compiled.cacheBytes === bytes.length,
      'Unknown tsx cache bytes: an original successful build capsule is required');
    cacheSources.add(known ? known[2] || CACHE_SOURCE : compiled.sourceRoot + '/');
    if (known && (known[2] === E01_SOURCE || known[2] === C9_SOURCE || known[2] === E00_SOURCE || known[2] === PROJECT_LIST_SOURCE
      || known[2] === PROJECT_DESIGN_SOURCE || known[2] === SIZE_LOG_SOURCE)) {
      assertHdE01CacheSourceProof(Object.fromEntries(Object.keys(E01_SOURCE_PROOF)
        .map(relative => [relative, sha(readRegular(known[2] + relative))])));
    }
    assert.equal(Number(filename[1]), Math.floor(before.mtimeMs / 1e8));
    const value = JSON.parse(bytes); assert.deepEqual(Object.keys(value).sort(), ['code', 'map', 'warnings']);
    assert.ok(typeof value.code === 'string' && value.code.length > 0 && Array.isArray(value.warnings) && !value.warnings.length);
    assert.equal(value.map?.version, 3); assert.deepEqual(value.map.sources,
      [known ? (known[2] || CACHE_SOURCE) + known[1] : compiled.sourceRoot + '/' + compiled.sourceFile]);
    assert.deepEqual(cacheStat(file, 'file', l), before);
    proofs.push({ name, sha256: digest, stat: before });
  }
  let historicalAttempt = null, historyKind = 'encode', legacySource = null;
  assert.equal(cacheSources.size, 1, 'One execution cache cannot mix unrelated compiler sources');
  const cacheStates = [directoryBefore, cacheBefore, ...proofs.map(item => item.stat)];
  if (superseded) {
    const verifications = job.verificationHistory || []; assert.ok(Array.isArray(verifications));
    const explicitTarget = [...job.attemptHistory, ...verifications].some(item => item.executionId === match[2]);
    if (!explicitTarget) assert.equal(job.attemptHistory.length, job.attempts);
    const intervals = job.attemptHistory.map((item, index, all) => {
      if (!explicitTarget) assert.equal(item.attempt, index + 1);
      else {
        assert.ok(Number.isSafeInteger(item.attempt) && item.attempt > 0 && item.attempt <= job.attempts);
        if (index) assert.ok(item.attempt > all[index - 1].attempt
          || item.attempt === all[index - 1].attempt && all[index - 1].reason === 'capacity_guard', 'HD attempt order changed');
      }
      assert.equal(item.sourceVersion, job.version);
      const begin = Date.parse(item.startedAt), end = Date.parse(item.finishedAt);
      assert.ok(Number.isFinite(begin) && Number.isFinite(end) && begin <= end && end <= Date.now());
      if (index) assert.ok(explicitTarget ? Date.parse(all[index - 1].finishedAt) <= begin : Date.parse(all[index - 1].finishedAt) < begin, 'HD attempts overlap');
      return { item, begin, end };
    });
    const identities = [...job.attemptHistory, ...verifications].map(item => item.executionId).filter(value => value !== undefined);
    assert.equal(new Set(identities).size, identities.length, 'Conflicting encode/verification execution identities');
    const verificationIntervals = verifications.map(item => {
      assert.match(item.executionId || '', /^[a-f0-9-]{36}$/); assert.equal(item.sourceVersion, job.version);
      assert.ok(['validate', 'verify-original'].includes(item.operation));
      const begin = Date.parse(item.startedAt), end = Date.parse(item.finishedAt);
      assert.ok(Number.isFinite(begin) && Number.isFinite(end) && begin <= end && end <= Date.now());
      return { item, begin, end, verification: true };
    });
    const identified = [...intervals, ...verificationIntervals].filter(({ item }) => item.executionId === match[2]);
    assert.ok(identified.length <= 1, 'Duplicate historical execution identity');
    const matching = (identified.length ? identified : intervals.slice(0, -1).filter(({ item }) => item.executionId === undefined))
      .filter(({ item, begin, end, verification }) => (verification || ['queued', 'ready', 'failed', 'skipped'].includes(item.status))
        && cacheStates.every(s => s.mtimeMs >= begin && s.ctimeMs >= begin && s.mtimeMs <= end && s.ctimeMs <= end));
    if (!matching.length) {
      assert.equal(explicitTarget, false, 'An identified execution cannot downgrade to unrecorded legacy');
      assert.equal(job.executionEvidenceProtocol, undefined); assert.equal(job.verificationHistory, undefined);
      assert.ok(job.attemptHistory.every(item => ['executionId', 'processor', 'childClose', 'groupExit'].every(field => item[field] === undefined)),
        'A writer which should have recorded evidence cannot downgrade to legacy');
      assert.ok(intervals.every(({ item }) => ['queued', 'ready', 'failed', 'skipped'].includes(item.status))
        && !intervals.some(({ begin, end }) => cacheStates.every(state => state.mtimeMs >= begin && state.ctimeMs >= begin
          && state.mtimeMs <= end && state.ctimeMs <= end)), 'A matched old attempt must retain its original strong rules');
      assert.ok(typeof job.source === 'string' && /^\d+:\d+:\d+:[0-9.]+:[0-9.]+$/.test(job.version), 'Legacy source version is not an original file identity');
      assert.ok(cacheStates.every(state => state.mtimeMs > 0 && state.ctimeMs > 0 && state.mtimeMs <= Date.now() && state.ctimeMs <= Date.now()));
      admission?.remaining(); legacySource = l.legacyExecutionSource?.(); admission?.remaining();
      assert.ok(legacySource && cacheSources.has(legacySource.root + '/'), 'Unknown legacy writer/cache provenance');
      historyKind = 'unrecorded-legacy';
    } else {
      assert.equal(matching.length, 1, 'Superseded cache must match one exact execution or unique closed legacy interval');
      historicalAttempt = matching[0].item; historyKind = matching[0].verification ? 'verification' : 'encode';
    }
    // This is a source/time/byte association, not a reconstructed old PID or
    // historical exit receipt. Actual whole-service drain remains mandatory.
    if (cacheSources.has(SIZE_LOG_SOURCE)) {
      assert.equal(sha(readRegular(SIZE_LOG_SOURCE + 'src/lib/media/hd-derivatives.ts')),
        '7442f68dd8ce7db49390293e722107c2bc57b72ea43976541427978076858fbf');
      assert.equal(sha(readRegular(SIZE_LOG_SOURCE + 'scripts/process-hd-derivatives.ts')),
        '037904c2e9e18794eb745387d29da7d2e30eee1c1170f432468a73d4c63ce57d');
    }
  } else for (const s of cacheStates) {
    assert.ok(s.mtimeMs >= started && s.ctimeMs >= started && s.mtimeMs <= updated && s.ctimeMs <= updated, 'Cache changed outside its finished attempt');
  }
  const boundAttempt = historyKind === 'unrecorded-legacy' ? null : historicalAttempt || attempt, explicitAttempt = boundAttempt?.executionId !== undefined;
  let historicalPidKnown = false, historicalExitReceipt = false;
  if (explicitAttempt) {
    assert.equal(boundAttempt.executionId, match[2]);
    const begin = Date.parse(boundAttempt.startedAt), end = Date.parse(boundAttempt.finishedAt);
    if (boundAttempt.processor) {
      assertHdClosedProcessor(boundAttempt.processor, match[2], hdProcessTable()); historicalPidKnown = true;
    }
    if (boundAttempt.childClose) {
      const close = boundAttempt.childClose, at = Date.parse(close.observedAt);
      assert.equal(close.executionId, match[2]); assert.ok(Number.isFinite(at) && begin <= at && at <= Date.now());
      assert.ok(close.code === null || Number.isInteger(close.code));
      assert.ok(close.signal === null || /^SIG[A-Z0-9]+$/.test(close.signal));
      historicalExitReceipt = true;
    }
    if (boundAttempt.groupExit) {
      const group = boundAttempt.groupExit, at = Date.parse(group.confirmedAt);
      assert.equal(group.executionId, match[2]); assert.equal(group.evidenceKind, 'process-group-gone');
      assert.ok(Number.isFinite(at) && begin <= at && at <= Date.now());
    }
  }
  const completeAttemptExit = explicitAttempt && historicalPidKnown && historicalExitReceipt && Boolean(boundAttempt.groupExit);
  assert.deepEqual(fs.readdirSync(cache).sort(), names);
  assert.deepEqual(fs.readdirSync(directory), ['tsx-' + l.uid]);
  assert.deepEqual(cacheStat(cache, 'directory', l), cacheBefore);
  assert.deepEqual(cacheStat(directory, 'directory', l), directoryBefore);
  assert.deepEqual(cacheStat(path.dirname(directory), 'directory', l), runsBefore);
  const jobBytes = readRegular(path.join(root, job.key + '.json'));
  assert.deepEqual(JSON.parse(jobBytes), job, 'Closed execution job changed');
  assertHdClosedProcessor(job.processor, job.executionId, hdProcessTable());
  for (const proof of proofs) assert.deepEqual(cacheStat(path.join(cache, proof.name), 'file', l), proof.stat);
  assertNoTransient();
  if (superseded || explicitAttempt && !completeAttemptExit) {
    if (l.isolated) assert.equal(process.env.NODE_ENV, 'test');
    else assert.equal(root, PROJECT + '/var-lib/storage/hd-derivatives', 'Unknown attempt exit requires the canonical worker root');
    const processAfter = assertNoSupersededHdProcess(root), processFirst = processBefore || processAfter;
    const accepted = completeAttemptExit || supersededWholeDrainAccepted(retiredProof);
    return { run, status: job.status, executionId: match[2], latestExecutionId: job.executionId,
      proofKind: completeAttemptExit ? 'execution-attempt-closed' : 'superseded-attempt-whole-service-drain', historicalPidKnown, historicalExitReceipt,
      accepted, pendingWholeDrain: !accepted, historyKind, historicalAttempt: boundAttempt,
      ...(legacySource ? { legacySource, sourceVersion: job.version, historicalIntervalKnown: false } : {}), jobSha256: sha(jobBytes),
      directory: directoryBefore, cache: cacheBefore, files: proofs,
      processProof: { complete: processFirst.complete && processAfter.complete,
        hdChildrenAbsent: processFirst.hdChildrenAbsent && processAfter.hdChildrenAbsent,
        privateRunProcessesAbsent: processFirst.privateRunProcessesAbsent && processAfter.privateRunProcessesAbsent }, readOnly: true };
  }
  return { run, status: job.status, executionId: job.executionId, executionExitedAt: job.executionExitedAt,
    jobSha256: sha(jobBytes), directory: directoryBefore, cache: cacheBefore, files: proofs, readOnly: true };
}
function createProtectedDiscoveryContinuation(m, { sourceRoot, prior, scanDeadline, check, waitBudgetMs = 15000 } = {}) {
  const startedAt = Date.now(), deadline = Math.min(prior?.deadline ?? Infinity, scanDeadline ?? Infinity);
  assert.ok(Number.isSafeInteger(deadline) && deadline > startedAt, 'A fresh outer scan admission deadline is required');
  assert.ok(Number.isSafeInteger(waitBudgetMs) && waitBudgetMs > 0 && waitBudgetMs <= 15000);
  // This is one reconciliation's cumulative waiting, not an inventory timer.
  const waitState = { waitedMs: 0 };
  const observations = [], waitCell = new Int32Array(new SharedArrayBuffer(4));
  const admission = { [DISCOVERY_ADMISSION]: true, deadline, observations,
    remaining() { try { prior?.remaining(); check?.(); } catch (error) { error.hdAdmissionFatal = true; throw error; } const left = deadline - Date.now();
      if (left <= 0) throw Object.assign(Error('HD reconciliation scan admission expired'), { code: 'HD_RECONCILIATION_SCAN_DEADLINE' });
      return Math.min(30000, left); },
    check() { try { prior?.check(); } catch (error) { error.hdAdmissionFatal = true; throw error; } admission.remaining(); },
    inventory(root, result) { prior?.inventory(root, result); },
  };
  const l = layout(m, admission), baseline = '31bff5a6544a3d18d433b81fa7735ed57b0d012c';
  assert.deepEqual(m.protectedIncrement, { schema: 'sd2-protected-increment.v1', baselineSource: baseline,
    pricingWrites: false, multiviewGeneration: false, canvasVideoBatchWrites: false,
    sizePolicyVersion: 2, diagnosticsSchema: 'image.provider-error.v1' });
  assert.equal(m.normalContinuation || null, null);
  if (isSharedEngine(m)) {
    assertSharedEngineContext(m);
    if (m.reuseBuilds) {
      assert.deepEqual(Object.keys(m.reuseBuilds).sort(), ['guard', 'main', 'schema', 'sourceRun']);
      assert.equal(m.reuseBuilds.schema, 'sd2-original-build-reuse-input.v1'); assert.match(m.reuseBuilds.sourceRun || '', /^[a-f0-9-]{36}$/);
      assert.notEqual(m.reuseBuilds.sourceRun, m.runId);
      for (const kind of ['main', 'guard']) {
        assert.deepEqual(Object.keys(m.reuseBuilds[kind]).sort(), ['file', 'sha256']);
        assert.equal(m.reuseBuilds[kind].file, m.projectRoot + '/release-staging/' + m.reuseBuilds.sourceRun + '/' + kind + '-immutable-success.json');
        assert.match(m.reuseBuilds[kind].sha256 || '', HASH);
      }
    }
  } else assert.equal(m.reuseBuilds || null, null);
  assert.equal(m.privateMultiviewInstall, true); assert.equal(m.live.web.source, baseline); assert.equal(m.live.hd.source, baseline);
  const runningRoot = m.live.hd.root;
  assert.ok([runningRoot, m.main?.root, m.guard?.root].includes(sourceRoot)); assert.equal(m.live.hd.unit, 'sd2-hd-derivatives.service');
  if (!l.isolated) {
    assert.equal(runningRoot, m.projectRoot + '/managed-releases/' + baseline);
    assert.equal(m.hdAdmissionFixtureUnit, undefined); assert.equal(m.hdAdmissionFixtureCgroup, undefined);
  }
  const lock = m.hdRoot + '/discovery.lock', sources = [...DISCOVERY_SOURCES,
    'src/lib/media/hd-encoder.ts', 'src/lib/media/hd-image-processor.ts'];
  let sourceProof, runtimeProof, collisionCount = 0;
  const entities = new Map();
  const stat = file => admissionStat(fs.lstatSync(file));
  const regular = (file, uid, maximum) => {
    assert.equal(fs.realpathSync(file), file); const before = stat(file);
    assert.equal(before.uid, uid); assert.equal(before.mode & 0o022, 0); assert.equal(before.nlink, 1);
    const bytes = readRegular(file, maximum); assert.deepEqual(stat(file), before);
    return { file, stat: before, sha256: sha(bytes), bytes };
  };
  // One shallow identity snapshot, not a tree/content scan. This covers a lease
  // already held at the first inventory boundary without waiting into a changed
  // job. Contents are hashed only from the original inventory's own reads.
  for (const root of [m.hdRoot, m.hdForkRoot]) for (const name of fs.readdirSync(root)) {
    admission.remaining(); if (/^[a-f0-9]{64}\.json$/.test(name)) {
      const file = path.join(root, name); entities.set(file, { stat: stat(file) });
    }
  }
  function bindSources() {
    // The caller has already verified both immutable source archives. Bind the
    // same bytes here once, never once per cache or once per waiting iteration.
    const live = Object.fromEntries(sources.map(file => [file, regular(runningRoot + '/' + file, l.uid)]));
    const candidates = {};
    const archives = ['live', 'main', 'guard'].map(kind => {
      admission.check(); const c = kind === 'live' ? { ...m.live.hd.sourceProof, source: m.live.hd.source, root: runningRoot } : m[kind];
      assert.match(c.source, /^[a-f0-9]{40}$/);
      assert.ok(typeof c.sourceManifest === 'string' && typeof c.archive === 'string', 'The actual discovery owner requires its own reviewed source archive');
      if (!l.isolated && kind !== 'live') { assert.equal(c.sourceManifest, m.stage + '/' + kind + '/source-manifest.json');
        assert.equal(c.archive, m.stage + '/' + kind + '/source.tar.gz'); }
      const manifest = regular(c.sourceManifest, l.isolated ? l.uid : 0), value = JSON.parse(manifest.bytes);
      assert.equal(value.project, 'video-api-debugger'); assert.equal(value.source, c.source); assert.match(value.archiveSha256 || '', HASH);
      assert.ok(value.files && typeof value.files === 'object');
      for (const file of sources) {
        assert.match(value.files[file] || '', HASH);
        if (kind === 'live') assert.equal(value.files[file], live[file].sha256, 'Discovery running source differs from its original locked archive: ' + file);
        else {
          const actual = regular(c.root + '/' + file, l.uid);
          assert.equal(actual.sha256, value.files[file], 'Candidate source differs from its own locked archive: ' + file);
          candidates[kind + ':' + file] = actual;
        }
      }
      assert.equal(fs.realpathSync(c.archive), c.archive); const before = stat(c.archive);
      assert.ok(fs.lstatSync(c.archive).isFile() && before.nlink === 1 && before.size > 0);
      assert.equal(before.uid, l.isolated ? l.uid : 0); assert.equal(before.mode & 0o022, 0);
      assert.equal(fileSha256(c.archive), value.archiveSha256); assert.deepEqual(stat(c.archive), before); admission.check();
      return { manifest: { file: manifest.file, stat: manifest.stat, sha256: manifest.sha256 }, archive: { file: c.archive, stat: before, sha256: value.archiveSha256 } };
    });
    return { live: Object.fromEntries(Object.entries({ ...live, ...candidates }).map(([file, v]) => [file, { file: v.file, stat: v.stat, sha256: v.sha256 }])), archives };
  }
  function runtime() {
    admission.check(); const pid = m.live.hd.pid;
    const keys = ['MainPID', 'ControlPID', 'InvocationID', 'ExecMainStartTimestampMonotonic', 'ControlGroup', 'ActiveState', 'SubState', 'WorkingDirectory'];
    const state = l.isolated ? structuredClone(m.hdAdmissionFixtureUnit) : Object.fromEntries(call('systemctl', ['show', m.live.hd.unit,
      ...keys.flatMap(k => ['-p', k])], { timeout: admission.remaining() }).split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    assert.equal(state.MainPID, String(pid)); assert.equal(state.ControlPID, '0');
    assert.equal(state.InvocationID, m.live.hd.invocation); assert.equal(state.ExecMainStartTimestampMonotonic, m.live.hd.execMainStartTimestampMonotonic);
    assert.equal(state.ActiveState, 'active'); assert.equal(state.SubState, 'running'); assert.equal(state.WorkingDirectory, runningRoot);
    assert.equal(state.ControlGroup, '/system.slice/' + m.live.hd.unit);
    const raw = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'), fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    assert.ok(!['Z', 'X', 'x'].includes(fields[0])); assert.match(fields[19], /^\d+$/); assert.equal(Number(fields[2]), pid);
    const hz = Number(call('getconf', ['CLK_TCK'], { timeout: admission.remaining() })); assert.ok(Number.isSafeInteger(hz) && hz > 0);
    // Kernel fork ticks can precede systemd's successful exec observation. Bind
    // the actual ticks below and throughout the wait, not a fabricated equality.
    assert.ok(Number(fields[19]) > 0 && Number(fields[19]) <= Math.floor(Number(state.ExecMainStartTimestampMonotonic) * hz / 1000000),
      'Discovery PID began after the bound original service invocation');
    assert.equal(fs.realpathSync('/proc/' + pid + '/cwd'), runningRoot);
    const cgroup = fs.readFileSync('/proc/' + pid + '/cgroup', 'utf8').trim();
    assert.equal(cgroup, l.isolated ? m.hdAdmissionFixtureCgroup : '0::' + state.ControlGroup);
    admission.check(); return { pid, startTicks: fields[19], processGroup: Number(fields[2]), cgroup, state };
  }
  function rootNames() {
    return Object.fromEntries([['canonical', m.hdRoot], ['fork', m.hdForkRoot]].map(([role, root]) => {
      const names = fs.readdirSync(root).sort(), allowed = role === 'canonical' ? ['discovery.lock'] : [];
      assert.ok(!names.some(name => !allowed.includes(name) && (name.includes('.lock') || name.endsWith('.tmp') || name.endsWith('.publish.json'))),
        'Other HD transient remains during discovery continuation');
      const identity = stat(root);
      return [role, { binding: Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode'].map(k => [k, identity[k]])),
        names: names.filter(name => !allowed.includes(name)) }];
    }));
  }
  function owner() {
    admission.check(); assert.equal(fs.realpathSync(lock), lock); const directory = stat(lock);
    assert.ok(fs.lstatSync(lock).isDirectory()); assert.equal(directory.uid, l.uid); assert.equal(directory.gid, l.gid);
    assert.equal(directory.mode & 0o7777, 0o755);
    assert.ok(directory.mtimeMs <= Date.now() + 1000 && directory.mtimeMs >= Date.now() - 15000, 'Discovery lease is stale');
    assert.deepEqual(fs.readdirSync(lock), ['owner.json']);
    const file = regular(lock + '/owner.json', l.uid, 4096); assert.equal(file.stat.gid, l.gid); assert.equal(file.stat.mode & 0o7777, 0o600);
    const value = JSON.parse(file.bytes); assert.deepEqual(Object.keys(value).sort(), ['host', 'pid', 'token']);
    assert.equal(value.pid, m.live.hd.pid); assert.equal(value.host, os.hostname());
    assert.match(value.token || '', /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    assert.deepEqual(stat(lock), directory); return { directory, file: { stat: file.stat, sha256: file.sha256 } };
  }
  admission.observe = phase => {
    admission.check();
    try { fs.lstatSync(lock); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    // First observation must contain the complete owner; no ownerless acquire
    // grace period is admitted. A later empty same-inode directory is cleanup.
    const boundOwner = owner(), names = rootNames();
    sourceProof ??= bindSources(); const originalRuntime = runtime();
    if (runtimeProof) assert.deepEqual(originalRuntime, runtimeProof); else runtimeProof = originalRuntime;
    collisionCount++; const waitStartedAt = Date.now(); let sleeps = 0;
    let accountedAt = waitStartedAt;
    const remainingWait = () => {
      const current = Date.now(); waitState.waitedMs += Math.max(0, current - accountedAt); accountedAt = current;
      const left = waitBudgetMs - waitState.waitedMs;
      if (left <= 0) throw Object.assign(Error('HD discovery cumulative wait budget expired'), { code: 'HD_DISCOVERY_WAIT_BUDGET_EXHAUSTED' });
      return left;
    };
    try { while (true) {
      admission.check(); remainingWait(); let current;
      try { current = stat(lock); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
      for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink']) assert.equal(current[key], boundOwner.directory[key], 'Discovery directory was replaced');
      let entries;
      try { entries = fs.readdirSync(lock); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try { fs.lstatSync(lock); } catch (gone) { if (gone.code === 'ENOENT') break; throw gone; }
        throw error;
      }
      if (entries.length) {
        try { assert.deepEqual(owner(), boundOwner, 'Discovery owner changed while waiting'); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          let cleanup;
          try { cleanup = stat(lock); } catch (gone) { if (gone.code === 'ENOENT') break; throw gone; }
          for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink']) assert.equal(cleanup[key], boundOwner.directory[key]);
          assert.deepEqual(fs.readdirSync(lock), [], 'Missing owner is only allowed in the already-bound cleanup directory');
        }
      } else assert.deepEqual(entries, []);
      const raw = fs.readFileSync('/proc/' + runtimeProof.pid + '/stat', 'utf8'), fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
      assert.ok(!['Z', 'X', 'x'].includes(fields[0])); assert.equal(fields[19], runtimeProof.startTicks); assert.equal(Number(fields[2]), runtimeProof.processGroup);
      assert.equal(fs.realpathSync('/proc/' + runtimeProof.pid + '/cwd'), runningRoot);
      assert.equal(fs.readFileSync('/proc/' + runtimeProof.pid + '/cgroup', 'utf8').trim(), runtimeProof.cgroup);
      Atomics.wait(waitCell, 0, 0, Math.min(10, admission.remaining(), remainingWait())); sleeps++;
    } } finally { const current = Date.now(); waitState.waitedMs += Math.max(0, current - accountedAt); }
    assert.ok(waitState.waitedMs < waitBudgetMs, 'Discovery release exceeded its cumulative waiting allowance');
    assert.deepEqual(rootNames(), names, 'HD entity names or directory identity changed while waiting');
    assert.deepEqual(runtime(), runtimeProof, 'HD runtime changed while waiting');
    for (const value of [...Object.values(sourceProof.live), ...sourceProof.archives.flatMap(v => [v.manifest, v.archive])])
      assert.deepEqual(stat(value.file), value.stat, 'Discovery source/archive identity changed while waiting');
    observations.push({ phase, waitStartedAt, finishedAt: Date.now(), sleeps, forced: false,
      owner: { pid: runtimeProof.pid, startTicks: runtimeProof.startTicks, directory: boundOwner.directory, ownerSha256: boundOwner.file.sha256 },
      sameReconciliation: true, fullTreeRescans: 0 });
  };
  admission.entity = (file, bytes) => {
    // Piggyback on the original inventory's existing read; never reread all jobs
    // in a lease loop. These observations are not part of a cache fingerprint.
    const current = { stat: stat(file), sha256: sha(bytes) }, previous = entities.get(file);
    if (collisionCount && previous) {
      assert.deepEqual(current.stat, previous.stat, 'HD job entity changed across discovery continuation');
      if (previous.sha256) assert.equal(current.sha256, previous.sha256, 'HD job bytes changed across discovery continuation');
    }
    entities.set(file, current);
  };
  admission.finish = () => {
    admission.check();
    try { fs.lstatSync(lock); throw Error('Discovery lease arrived after the last entity snapshot'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (runtimeProof) { assert.deepEqual(runtime(), runtimeProof); for (const value of [...Object.values(sourceProof.live),
      ...sourceProof.archives.flatMap(v => [v.manifest, v.archive])]) assert.deepEqual(stat(value.file), value.stat); }
    return { startedAt, finishedAt: Date.now(), deadline, scanDeadline: deadline, waitBudgetMs, waitedMs: waitState.waitedMs,
      remainingWaitMs: Math.max(0, waitBudgetMs - waitState.waitedMs), collisionCount, observations, snapshotCoverage: 'original-storage-and-two-inventories',
      extraSourceBindings: sourceProof ? Object.keys(sourceProof.live).length : 0, extraArchiveHashes: sourceProof ? sourceProof.archives.length : 0,
      jobEntitiesBoundFromExistingReads: entities.size, fullTreeRescans: 0 };
  };
  return admission;
}
export { createProtectedDiscoveryContinuation };

function inventory(root, l, retired = null, admission) {
  admission?.observe('inventory-start');
  const jobs = new Map(), transients = [], names = fs.readdirSync(root).sort();
  for (const name of names) {
    admission?.remaining();
    if (/^[a-f0-9]{64}\.json$/.test(name)) {
      if (l) binding(path.join(root, name), 'file', l);
      const bytes = readRegular(path.join(root, name)), job = JSON.parse(bytes);
      admission?.entity?.(path.join(root, name), bytes);
      assert.equal(job.key + '.json', name); assert.equal(job.policy, 'hd-f-v1');
      assert.ok(typeof job.source === 'string' && typeof job.version === 'string' && typeof job.preserveText === 'boolean'
        && ['queued', 'running', 'ready', 'failed', 'skipped'].includes(job.status));
      jobs.set(job.key, job);
      const exited = typeof job.executionExitedAt === 'string' && Number.isFinite(Date.parse(job.executionExitedAt));
      const knownProcessor = !job.processor || job.processor.executionId === job.executionId
        && /^[a-f0-9-]{36}$/.test(job.executionId || '') && Number.isSafeInteger(job.processor.pid)
        && job.processor.pid > 1 && job.processor.groupId === job.processor.pid
        && job.processor.host === os.hostname() && /^\d+$/.test(job.processor.startTicks || '');
      if (job.status === 'running' || job.executionId && !exited || job.processor && (!exited || !knownProcessor)) {
        transients.push({ code: 'unsettled_execution', key: job.key });
      }
    } else if (name.includes('.lock')) transients.push({ code: 'lease_present', object: name });
    else if (name.endsWith('.publish.json')) transients.push({ code: 'publish_receipt_present', key: name.slice(0, 64) });
    else if (name.endsWith('.tmp')) transients.push({ code: 'temporary_output_present', object: name });
  }
  const closedCaches = [], cacheRefusals = [], rootTransientCount = transients.length;
  if (names.includes('.runs')) {
    const runs = path.join(root, '.runs'); assert.equal(fs.realpathSync(runs), runs); assert.ok(fs.lstatSync(runs).isDirectory());
    for (const run of fs.readdirSync(runs).sort()) {
      try {
        // A lease/receipt/output of any provenance continues to block globally.
        assert.equal(rootTransientCount, 0);
        const deferred = retired?.entries.find(item => item.run === run);
        if (deferred && root === PROJECT + '/var-lib/storage/hd-derivatives') {
          closedCaches.push({ ...deferred, proofKind: 'whole-service-drain', accepted: retired.accepted });
          continue;
        }
        closedCaches.push(inspectHdClosedExecutionCache(root, run, l, jobs.get(run.slice(0, 64)), admission, retired));
      } catch (error) {
        if (error instanceof DiscoveryAdmissionBusy || error?.hdAdmissionFatal || ['HD_DISCOVERY_ADMISSION_DEADLINE',
          'HD_RECONCILIATION_SCAN_DEADLINE', 'HD_DISCOVERY_WAIT_BUDGET_EXHAUSTED'].includes(error?.code)) throw error;
        const category = rootTransientCount ? 'active_transient' : ['EACCES', 'EPERM'].includes(error.code) ? 'unreadable'
          : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing_evidence' : 'invalid_cache_evidence';
        cacheRefusals.push({ run, category, name: error.name, code: error.code || null, reason: String(error.message).slice(0, 4096) });
      }
    }
  }
  const result = { jobs, transients, closedCaches, cacheRefusals, signature: sha(stable({ closedCaches, cacheRefusals, jobs: [...jobs].map(([key, job]) => [key, {
    status: job.status, source: job.source, version: job.version, preserveText: job.preserveText,
    format: job.format, file: job.file, bytes: job.bytes, integrity: job.integrity,
  }]) })), controlSha256: names.includes('control.json') ? sha(readRegular(path.join(root, 'control.json'))) : null };
  admission?.inventory(root, result); admission?.observe('inventory-complete');
  return result;
}
function sourceFile(m, source, l) {
  let local = source;
  if (!source.startsWith('/uploads/')) {
    const url = new URL(source);
    assert.ok([m.publicOrigin || 'https://sd2.youdooart.com', 'https://sd2.youdooart.com', 'https://sd2.youdoodesign.com'].includes(url.origin));
    local = url.pathname;
  }
  assert.ok(local.startsWith('/uploads/'));
  const decoded = decodeURIComponent(local.split(/[?#]/, 1)[0]);
  assert.ok(!/[\0\\]/.test(decoded));
  const file = fs.realpathSync(path.resolve(m.uploadsRoot, decoded.slice('/uploads/'.length)));
  assert.ok(file.startsWith(m.uploadsRoot + path.sep), 'Original escaped uploads root');
  return { file, stat: fileStat(file, l) };
}
function approvedLegacyReady(m, root, job, l) {
  assert.equal(root, m.hdRoot, 'Only the canonical historical output may use the exception');
  assert.equal(job.status, 'ready'); assert.equal(job.format, 'avif'); assert.equal(job.mime, 'image/avif');
  assert.equal(Object.hasOwn(job, 'integrity'), false, 'An explicit integrity field is never a legacy absence');
  for (const field of ['protocol', 'queueRole', 'stage', 'executionId', 'executionExitedAt', 'processor',
    'attemptHistory', 'lastProgressAt', 'errorKind', 'diagnostic']) {
    assert.equal(Object.hasOwn(job, field), false, 'Modern execution metadata cannot be downgraded to legacy');
  }
  const approval = l.legacyApproval, entry = approval?.entries[job.key];
  assert.ok(entry, 'Missing integrity requires an explicitly approved existing key');
  const bytes = readRegular(path.join(root, job.key + '.json'));
  assert.equal(sha(bytes), entry.manifestSha256, 'Approved historical manifest bytes changed');
  assert.deepEqual(JSON.parse(bytes), job, 'Historical metadata moved during its protection read');
  assert.equal(job.version, entry.sourceVersion);
  const original = sourceFile(m, job.source, l);
  assert.equal(sha(original.file), entry.sourceIdentitySha256, 'Approved historical original path changed');
  assert.equal(`${original.stat.dev}:${original.stat.ino}:${original.stat.bytes}:${original.stat.mtimeMs}:${original.stat.ctimeMs}`,
    entry.sourceVersion, 'Approved historical original identity changed');
  return { schema: 'hd-legacy-ready-exception-v1', inventorySha256: approval.inventorySha256,
    manifestSha256: entry.manifestSha256, sourceVersion: entry.sourceVersion, sourceIdentitySha256: entry.sourceIdentitySha256 };
}
function readyState(m, root, job, l) {
  assert.ok(HASH.test(job.key) && job.policy === 'hd-f-v1' && typeof job.version === 'string'
    && typeof job.preserveText === 'boolean');
  for (const field of ['bytes', 'width', 'height']) assert.ok(Number.isSafeInteger(job[field]) && job[field] > 0, 'Ready dimensions/length are unknown');
  let legacy;
  if ((root === m.hdRoot && l.legacyApproval?.entries[job.key]) || !Object.hasOwn(job, 'integrity')) {
    legacy = approvedLegacyReady(m, root, job, l);
  }
  else {
    const requiredChecks = ['output_metadata', 'width', 'height', 'alpha', 'pages', 'color', 'bitdepth', 'depth', 'format', 'output_full_decode'];
    assert.ok(job.integrity && job.integrity.version === 'hd-output-integrity-v2' && Array.isArray(job.integrity.failedChecks)
      && job.integrity.failedChecks.length === 0 && job.integrity.checks && Object.keys(job.integrity.checks).length > 0
      && requiredChecks.every(name => job.integrity.checks[name]?.ok === true)
      && Object.values(job.integrity.checks).every(check => check?.ok === true), 'Ready integrity is unknown or failed');
    assert.equal(job.integrity.checks.width.actual, job.width); assert.equal(job.integrity.checks.height.actual, job.height);
  }
  let output;
  if (job.format === 'original') {
    const original = sourceFile(m, job.source, l);
    assert.equal(job.version, `${original.stat.dev}:${original.stat.ino}:${original.stat.bytes}:${original.stat.mtimeMs}:${original.stat.ctimeMs}`);
    assert.equal(job.file, undefined); assert.ok(/^image\/(png|jpeg|webp|avif|tiff)$/.test(job.mime));
    output = original.stat;
  } else {
    assert.ok(['avif', 'webp'].includes(job.format)); assert.equal(job.file, `${job.key}.${job.format}`);
    assert.equal(job.mime, 'image/' + job.format);
    output = fileStat(path.join(root, job.file), l);
    assert.ok(output.realpath.startsWith(root + path.sep));
  }
  assert.equal(output.bytes, job.bytes, 'Ready output length disagrees with its receipt');
  const contract = Object.fromEntries(['key', 'version', 'policy', 'preserveText', 'format', 'mime', 'bytes', 'width', 'height', 'file', 'integrity']
    .map(field => [field, job[field] ?? null]));
  return { contract, contractSha256: sha(stable(contract)), output, ...(legacy ? { legacy } : {}) };
}
function historicalState(m, root, job, l) {
  assert.equal(root, m.hdRoot, 'Old-version preservation is canonical only');
  const approval = l.historicalApproval, entry = approval?.entries[job.key];
  assert.ok(entry, 'An old version requires exact existing approval');
  assert.equal(job.status, entry.status); assert.equal(job.reason ?? null, entry.reason);
  assert.equal(job.version, entry.historicalVersion); assert.equal(job.policy, 'hd-f-v1');
  assert.equal(typeof job.preserveText, 'boolean');
  const bytes = readRegular(path.join(root, job.key + '.json'));
  assert.equal(sha(bytes), entry.manifestSha256, 'Approved old-version manifest bytes changed');
  assert.deepEqual(JSON.parse(bytes), job, 'Old-version metadata moved during its protection read');
  const original = sourceFile(m, job.source, l);
  assert.equal(sha(original.file), entry.sourceIdentitySha256, 'Approved old-version original path changed');
  assert.deepEqual(identityFields(original.stat), entry.currentSource, 'Approved current original identity changed again');
  assert.equal(sourceVersion(original.stat), entry.currentVersion);
  let ready = null;
  if (job.status === 'ready') {
    assert.equal(job.format, 'avif'); assert.equal(job.mime, 'image/avif');
    ready = readyState(m, root, job, l); // The complete modern v2 gate is never relaxed.
    assert.deepEqual(identityFields(ready.output), identityFields(entry.output), 'Approved historical output identity changed');
    assert.equal(job.width, entry.output.width); assert.equal(job.height, entry.output.height);
    assert.equal(job.integrity.version, entry.output.integrity); assert.deepEqual(job.integrity.failedChecks, []);
  } else {
    assert.equal(job.status, 'skipped'); assert.equal(job.reason, 'source_changed'); assert.equal(entry.output, null);
  }
  return { schema: 'hd-historical-version-preservation-v1', inventorySha256: approval.inventorySha256,
    manifestSha256: entry.manifestSha256, status: job.status, reason: entry.reason,
    historicalVersion: job.version, currentVersion: entry.currentVersion, currentKey: entry.currentKey,
    sourceIdentitySha256: entry.sourceIdentitySha256, currentSource: outputProof(original.stat),
    output: ready ? outputProof(ready.output) : null, currentReusable: false };
}
function bindings(m, l) {
  return { canonical: binding(m.hdRoot, 'directory', l), fork: binding(m.hdForkRoot, 'directory', l),
    uploads: binding(m.uploadsRoot, 'directory', l), workerLock: binding(m.hdWorkerLockPath, 'file', l),
    storage: binding(m.storageRoot, 'directory', l) };
}

export function readHdStorageProtection(m, admission) {
  if (admission) assert.equal(admission[DISCOVERY_ADMISSION], true);
  const l = layout(m, admission), before = bindings(m, l), current = inventory(m.hdRoot, l, null, admission), readyByKey = {}, historicalByKey = {};
  for (const key of Object.keys(l.legacyApproval?.entries || {})) {
    assert.equal(current.jobs.get(key)?.status, 'ready', 'An approved existing historical output disappeared: ' + key);
  }
  for (const key of Object.keys(l.historicalApproval?.entries || {})) {
    const job = current.jobs.get(key); assert.ok(job, 'An approved historical version disappeared: ' + key);
    historicalByKey[key] = historicalState(m, m.hdRoot, job, l);
  }
  for (const [key, job] of current.jobs) if (job.status === 'ready') {
    admission?.remaining();
    try { readyByKey[key] = readyState(m, m.hdRoot, job, l); }
    catch { throw Error('hd_ready_protection_failed:' + key); }
  }
  assert.deepEqual(bindings(m, l), before, 'HD binding moved during the protection read');
  return { schema: 'hd-storage-protection-v1', bindings: before, readyByKey, historicalByKey };
}
export function assertHdStorageProtection(before, after) {
  assert.equal(before.schema, 'hd-storage-protection-v1'); assert.equal(after.schema, before.schema);
  assert.deepEqual(after.bindings, before.bindings, 'HD storage binding changed');
  assert.ok(before.historicalByKey && after.historicalByKey, 'Historical protection shape is required');
  assert.deepEqual(after.historicalByKey, before.historicalByKey, 'Existing historical metadata, current original, or old output changed');
  for (const [key, original] of Object.entries(before.readyByKey)) {
    assert.ok(after.readyByKey[key], 'Existing ready output disappeared: ' + key);
    assert.deepEqual(after.readyByKey[key], original, 'Existing ready output changed: ' + key);
  }
  return true;
}

// The child executes the inspected site's actual normalizer and the installed
// Sharp formula. Only approved legacy AVIFs additionally read header metadata;
// it never imports a DB client, creates a queue, or decodes full pixel bodies.
const SOURCE_IDENTITY_PROGRAM = String.raw`
import fs from 'node:fs'; import path from 'node:path'; import {createHash} from 'node:crypto';
import {createRequire} from 'node:module'; import {pathToFileURL} from 'node:url';
import http from 'node:http'; import https from 'node:https'; import net from 'node:net';
import tls from 'node:tls'; import dns from 'node:dns'; import dgram from 'node:dgram';
const deny=()=>{throw Error('hd_probe_network_forbidden')}; globalThis.fetch=deny;
for(const [object,methods] of [[http,['request','get']],[https,['request','get']],[net,['connect','createConnection']],
 [tls,['connect']],[dns,['lookup','resolve']],[dgram,['createSocket']]])for(const method of methods)object[method]=deny;
net.Socket.prototype.connect=deny;for(const method of ['lookup','resolve'])dns.promises[method]=deny;
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const require=createRequire(path.join(input.sourceRoot,'package.json')),sharp=require('sharp');
const site=await import(pathToFileURL(path.join(input.sourceRoot,'src/lib/assets/site-url.ts')).href);
const normalize=site.siteUploadPathFromUrl||site.default?.siteUploadPathFromUrl;
if(typeof normalize!=='function')throw Error('hd_site_helper_missing');
const root=fs.realpathSync(path.join(input.sourceRoot,'public/uploads'));
if(root!==input.uploadsRoot)throw Error('hd_source_upload_binding');
const rows=[];
for(const item of input.items){let stage='source';try{
 const local=normalize(item.source);if(!local)throw Error('hd_source_unknown');
 const file=fs.realpathSync(path.resolve(input.sourceRoot,'public',decodeURIComponent(local).slice(1)));
 if(!file.startsWith(root+path.sep))throw Error('hd_source_boundary');
 const stat=fs.statSync(file);if(!stat.isFile()||!stat.size)throw Error('hd_source_missing');
 const version=stat.dev+':'+stat.ino+':'+stat.size+':'+stat.mtimeMs+':'+stat.ctimeMs;
 const keyFor=version=>createHash('sha256').update(JSON.stringify({file,version,policy:'hd-f-v1',
 format:'alpha-or-text-lossless-webp-otherwise-avif',q:95,chroma:'4:4:4',effort:6,orientation:'auto',
 color:'8bit-srgb',library:sharp.versions,preserveText:item.preserveText})).digest('hex');
 const row={id:item.id,key:keyFor(version),version,sourceIdentity:createHash('sha256').update(file).digest('hex')};
 if(item.historicalVersion)row.historicalKey=keyFor(item.historicalVersion);
 if(item.legacy){stage='legacy_metadata';
  if(typeof item.legacy.file!=='string'||!item.legacy.file.endsWith('.avif')||!/^[a-f0-9]{64}$/.test(item.legacy.file.slice(0,-5)))throw Error('hd_legacy_output_name');
  const output=fs.realpathSync(path.join(input.hdRoot,item.legacy.file));
  if(output!==path.join(input.hdRoot,item.legacy.file))throw Error('hd_legacy_output_boundary');
  fs.accessSync(output,fs.constants.R_OK);const before=fs.statSync(output);
  if(!before.isFile()||before.size!==item.legacy.bytes)throw Error('hd_legacy_output_length');
  const metadata=await sharp(output,{limitInputPixels:40000000,failOn:'warning'}).metadata();
  if(metadata.width!==item.legacy.width||metadata.height!==item.legacy.height||metadata.format!=='heif'||metadata.compression!=='av1')throw Error('hd_legacy_output_metadata');
  const after=fs.statSync(output);for(const name of ['dev','ino','size','mtimeMs','ctimeMs'])if(after[name]!==before[name])throw Error('hd_legacy_output_moved');
  row.legacyMetadata={checked:true,width:metadata.width,height:metadata.height,format:metadata.format,compression:metadata.compression,bytes:after.size};
 }
 rows.push(row);
}catch{rows.push({id:item.id,error:stage==='legacy_metadata'?'legacy_metadata_unconfirmed':'source_identity_unconfirmed'})}}
console.log('HD_SOURCE_IDENTITIES='+JSON.stringify({rows}));`;

function globalLock(m, l) {
  if (l.isolated) return { holders: 0, unknown: false };
  const s = fs.statSync(m.hdWorkerLockPath), dev = BigInt(s.dev);
  const major = Number((dev >> 8n & 0xfffn) | (dev >> 32n & 0xfffff000n));
  const minor = Number((dev & 0xffn) | (dev >> 12n & 0xffffff00n));
  const matches = fs.readFileSync('/proc/locks', 'utf8').split('\n').filter(line => {
    const item = line.split(/\s+/).find(value => /^[a-f0-9]+:[a-f0-9]+:\d+$/i.test(value));
    if (!item) return false;
    const parts = item.split(':'); return parseInt(parts[0], 16) === major && parseInt(parts[1], 16) === minor && parts[2] === String(s.ino);
  });
  return { holders: matches.length, unknown: matches.some(line => {
    const fields = line.trim().split(/\s+/), token = fields.findIndex(value => /^[a-f0-9]+:[a-f0-9]+:\d+$/i.test(value));
    return !line.includes(' FLOCK ') || Number(fields[token - 1]) !== m.live?.hd?.pid;
  }) };
}

export async function inspectHdReconciliation(m, { sourceRoot, final = false, retiredCachePhase, admissionObservation, scanDeadline, check, waitBudgetMs = 15000 } = {}) {
  let admission = admissionObservation;
  if (admission) assert.equal(admission[DISCOVERY_ADMISSION], true, 'Only the bounded private admission entry may observe collisions');
  if (!admission && scanDeadline !== undefined) {
    assert.ok(Number.isSafeInteger(scanDeadline) && typeof check === 'function');
    admission = { [DISCOVERY_ADMISSION]: true, deadline: scanDeadline, check, inventory() {}, observe() { this.remaining(); },
      remaining() {
        try { check(); } catch (error) { error.hdAdmissionFatal = true; throw error; }
        const left = scanDeadline - Date.now();
        if (left <= 0) throw Object.assign(Error('HD reconciliation scan admission expired'), { code: 'HD_RECONCILIATION_SCAN_DEADLINE' });
        return Math.min(30000, left);
      } };
  }
  if (!final && retiredCachePhase === 'admission' && m.protectedIncrement)
    admission = createProtectedDiscoveryContinuation(m, { sourceRoot, prior: admission, scanDeadline, check, waitBudgetMs });
  if (final) assert.equal(admission?.finish, undefined, 'Final/drained reconciliation cannot wait for discovery');
  const l = layout(m, admission);
  if (admission?.finish && !l.isolated) assert.equal(retiredCachePhase, 'admission', 'Protected discovery continuation is admission-only');
  const bound = bindings(m, l), issues = [], before = readHdStorageProtection(m, admission);
  admission?.observe('retired-cache-entry');
  const retired = retiredCachePhase ? inspectRetiredHdCaches(m, retiredCachePhase) : null;
  admission?.observe('retired-cache-entry-complete');
  assert.equal(fs.realpathSync(sourceRoot), sourceRoot);
  const canonical = inventory(m.hdRoot, l, retired, admission), fork = inventory(m.hdForkRoot, l, null, admission);
  for (const [role, state] of [['canonical', canonical], ['fork', fork]]) for (const refusal of state.cacheRefusals)
    issues.push({ ...refusal, cacheCode: refusal.code, code: 'closed_cache_refused', role });
  const items = [], historicalPreserved = [];
  for (const [role, state] of [['canonical', canonical], ['fork', fork]]) for (const [key, job] of state.jobs) {
    const item = { id: role + ':' + key, source: job.source, preserveText: job.preserveText };
    if (role === 'canonical' && before.historicalByKey[key]) item.historicalVersion = job.version;
    if (job.status === 'ready') {
      try {
        const prepared = readyState(m, role === 'canonical' ? m.hdRoot : m.hdForkRoot, job, l);
        if (prepared.legacy) item.legacy = { file: job.file, width: job.width, height: job.height, bytes: job.bytes };
      }
      catch { issues.push({ code: 'ready_output_unconfirmed', role, key }); }
    }
    items.push(item);
  }
  let observed;
  try {
    const temporary = l.isolated ? m.hdStorageIsolationRoot : m.stage;
    assert.ok(typeof temporary === 'string' && temporary.startsWith(l.isolated ? m.hdStorageIsolationRoot : m.projectRoot + '/release-staging/'));
    assert.equal(fs.realpathSync(temporary), temporary);
    const output = call(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', SOURCE_IDENTITY_PROGRAM,
      ], { cwd: sourceRoot, input: JSON.stringify({ sourceRoot, uploadsRoot: m.uploadsRoot, hdRoot: m.hdRoot, items }),
      ...(admission ? { timeout: admission.remaining() } : {}),
      env: { PATH: SYSTEM_PATH, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', TSX_DISABLE_CACHE: '1',
        TMPDIR: temporary, NODE_ENV: l.isolated ? 'test' : 'production', SITE_PUBLIC_BASE_URL: m.publicOrigin || 'https://sd2.youdooart.com' } });
    const lines = output.split(/\r?\n/).filter(line => line.startsWith('HD_SOURCE_IDENTITIES=')); assert.equal(lines.length, 1);
    observed = new Map(JSON.parse(lines[0].slice('HD_SOURCE_IDENTITIES='.length)).rows.map(row => [row.id, row]));
  } catch (error) {
    admission?.remaining();
    if (admission) throw Error('hd_reconciliation_source_probe_failed', { cause: error });
    throw Error('hd_reconciliation_source_probe_failed');
  }
  admission?.observe('source-probe-complete');
  for (const [role, state] of [['canonical', canonical], ['fork', fork]]) for (const [key, job] of state.jobs) {
    const row = observed.get(role + ':' + key);
    const historical = role === 'canonical' ? before.historicalByKey[key] : null;
    if (historical) {
      if (!row || row.error || row.historicalKey !== key || row.key !== historical.currentKey
        || row.version !== historical.currentVersion || row.sourceIdentity !== historical.sourceIdentitySha256) {
        issues.push({ code: 'historical_version_unconfirmed', role, key });
      } else historicalPreserved.push({ key, status: historical.status, reason: historical.reason,
        historicalVersion: historical.historicalVersion, currentKey: row.key, currentVersion: row.version, currentReusable: false });
      continue;
    }
    if (!row || row.error || row.key !== key || row.version !== job.version) {
      issues.push({ code: row?.error === 'legacy_metadata_unconfirmed' ? row.error : 'source_identity_unconfirmed', role, key });
    }
  }
  let overlapping = 0;
  for (const [key, other] of fork.jobs) {
    const current = canonical.jobs.get(key);
    if (!current) { issues.push({ code: 'fork_unique_key', key }); continue; }
    overlapping++;
    const left = observed.get('canonical:' + key), right = observed.get('fork:' + key);
    if (!left || !right || left.error || right.error || left.sourceIdentity !== right.sourceIdentity
      || current.version !== other.version || current.preserveText !== other.preserveText || current.policy !== other.policy) {
      issues.push({ code: 'same_key_source_conflict', key }); continue;
    }
    if (current.status === 'ready' && other.status === 'ready') {
      try {
        const leftReady = readyState(m, m.hdRoot, current, l), rightReady = readyState(m, m.hdForkRoot, other, l);
        assert.deepEqual(leftReady.contract, rightReady.contract);
        // Only duplicate ready outputs require a byte comparison. Ordinary
        // protection reads never rehash the entire historical image library.
        if (leftReady.output.dev !== rightReady.output.dev || leftReady.output.ino !== rightReady.output.ino) {
          assert.equal(fileSha256(leftReady.output.realpath), fileSha256(rightReady.output.realpath));
          assert.deepEqual(fileStat(leftReady.output.realpath, l), leftReady.output);
          assert.deepEqual(fileStat(rightReady.output.realpath, l), rightReady.output);
        }
      }
      catch { issues.push({ code: 'same_key_ready_conflict', key }); }
    } else if (current.status !== 'ready' && other.status === 'ready') issues.push({ code: 'fork_ready_requires_reconciliation', key });
    else if (other.status !== 'queued' && !(current.status === other.status && current.reason === other.reason)) {
      issues.push({ code: 'same_key_terminal_conflict', key });
    }
  }
  const transients = [...canonical.transients.map(item => ({ ...item, role: 'canonical' })),
    ...fork.transients.map(item => ({ ...item, role: 'fork' }))];
  const lock = globalLock(m, l);
  if (lock.unknown || lock.holders > 1) issues.push({ code: 'global_lock_owner_unknown' });
  if (final && lock.holders) issues.push({ code: 'global_lock_still_held' });
  if (final) for (const item of transients) issues.push({ code: item.code, role: item.role,
    ...(HASH.test(item.key || '') ? { key: item.key } : { objectSha256: sha(item.object || item.code) }) });
  admission?.observe('retired-cache-exit');
  const retiredAfter = retiredCachePhase ? inspectRetiredHdCaches(m, retiredCachePhase) : null;
  admission?.observe('retired-cache-exit-complete');
  assert.deepEqual(retiredAfter, retired, 'Specific retired HD cache evidence changed during reconciliation');
  const afterCanonical = inventory(m.hdRoot, l, retiredAfter, admission), afterFork = inventory(m.hdForkRoot, l, null, admission);
  let unstable = transients.length > 0 || afterCanonical.transients.length > 0 || afterFork.transients.length > 0
    || canonical.signature !== afterCanonical.signature || fork.signature !== afterFork.signature;
  try { assertHdStorageProtection(before, readHdStorageProtection(m, admission)); }
  catch (error) {
    if (admission && (error instanceof DiscoveryAdmissionBusy || error?.hdAdmissionFatal || ['HD_DISCOVERY_ADMISSION_DEADLINE',
      'HD_RECONCILIATION_SCAN_DEADLINE', 'HD_DISCOVERY_WAIT_BUDGET_EXHAUSTED'].includes(error?.code))) throw error;
    issues.push({ code: 'ready_protection_changed' }); unstable = true;
  }
  assert.deepEqual(bindings(m, l), bound, 'HD bindings changed during reconciliation');
  const pendingWholeDrain = [['canonical', canonical], ['fork', fork]].flatMap(([role, state]) =>
    state.closedCaches.filter(item => item.pendingWholeDrain).map(item => ({ role, run: item.run })));
  const discoveryContinuation = admission?.finish?.();
  return { schema: 'hd-storage-reconciliation-v1', final, safe: issues.length === 0 && !unstable && pendingWholeDrain.length === 0 && retired?.phase !== 'admission', unstable,
    canEnterControlledDrain: issues.length === 0 && !unstable && retired?.phase === 'admission', retiredCacheProof: retired,
    issues, counts: { canonical: canonical.jobs.size, fork: fork.jobs.size, overlapping }, bindings: bound,
    canonicalControlSha256: canonical.controlSha256, forkControlSha256: fork.controlSha256,
    historicalPreserved, excludedHistoricalReadyCount: Object.values(before.historicalByKey).filter(item => item.status === 'ready').length,
    globalLock: lock, closedExecutionCaches: { canonical: canonical.closedCaches, fork: fork.closedCaches }, pendingWholeDrain,
    cacheRefusals: { canonical: canonical.cacheRefusals, fork: fork.cacheRefusals },
    ...(discoveryContinuation ? { discoveryContinuation } : {}),
    legacyMetadata: { required: items.filter(item => item.legacy).length,
      checked: [...observed.values()].filter(row => row.legacyMetadata?.checked === true).length,
      failed: items.filter(item => item.legacy && !observed.get(item.id)?.legacyMetadata?.checked).length,
      method: 'sharp-metadata-only', fullPixelDecode: false }, readOnly: true };
}

const SOURCE_HELPERS = ['src/lib/media/hd-derivatives.ts', 'src/lib/media/hd-storage-root.ts',
  'src/lib/media/hd-readonly-db.ts', 'src/lib/media/hd-resource-state.ts', 'src/lib/media/hd-encoder.ts',
  'src/lib/media/hd-image-processor.ts', 'src/lib/assets/site-url.ts', 'package.json', 'package-lock.json', 'tsconfig.json'];
const outputProof = ({ realpath: _sourcePath, ...proof }) => proof;
function candidateInputs(m, c, prepared) {
  const l = layout(m); assert.equal(l.isolated, false);
  const expected = [m.main, m.guard].find(item => item?.source === c.source); assert.ok(expected);
  assert.equal(c.root, expected.root); assert.equal(c.sourceManifest, expected.sourceManifest);
  assert.equal(fs.realpathSync(c.root), c.root); assert.match(c.source, /^[a-f0-9]{40}$/);
  const manifestBytes = readRegular(c.sourceManifest), manifestStat = fs.lstatSync(c.sourceManifest);
  assert.equal(manifestStat.uid, 0); assert.equal(manifestStat.mode & 0o022, 0);
  const source = JSON.parse(manifestBytes); assert.equal(source.source, c.source);
  assert.equal(source.project, 'video-api-debugger'); assert.ok(source.files && typeof source.files === 'object');
  const helperSourceSha256 = {};
  for (const file of SOURCE_HELPERS) {
    assert.match(source.files[file] || '', HASH); const target = path.join(c.root, file);
    assert.equal(fs.realpathSync(target), target); assert.equal(sha(readRegular(target)), source.files[file]);
    helperSourceSha256[file] = source.files[file];
  }
  assert.equal(prepared.source, c.source); assert.equal(prepared.candidateRoot, c.root); assert.equal(prepared.runId, m.runId);
  assert.ok(prepared.preparedRoot.startsWith(c.root + path.sep)); assert.equal(fs.realpathSync(prepared.preparedRoot), prepared.preparedRoot);
  const preparedStat = fs.lstatSync(prepared.preparedRoot);
  assert.ok(preparedStat.isDirectory() && !preparedStat.isSymbolicLink() && preparedStat.uid === l.uid && !(preparedStat.mode & 0o077));
  assert.equal(prepared.receipt, path.join(prepared.preparedRoot, 'candidate-inputs.json'));
  const receiptStat = fs.lstatSync(prepared.receipt); assert.equal(receiptStat.uid, 0); assert.equal(receiptStat.mode & 0o7777, 0o444);
  const preparation = JSON.parse(readRegular(prepared.receipt));
  assert.equal(preparation.source, c.source); assert.equal(preparation.runId, m.runId); assert.equal(preparation.candidateRoot, c.root);
  assert.ok(Number.isSafeInteger(preparation.finishedAt) && preparation.finishedAt > 0);
  const databaseUrl = prepared.buildEnv?.DATABASE_URL;
  assert.ok(typeof databaseUrl === 'string' && databaseUrl.startsWith('file:/') && !/[?#]/.test(databaseUrl));
  const database = databaseUrl.slice(5); assert.ok(database.startsWith(prepared.preparedRoot + path.sep));
  assert.notEqual(database, m.database); assert.equal(fs.realpathSync(database), database);
  const db = fileStat(database, { ...l, dataDevice: fs.statSync(database).dev });
  assert.equal(db.uid, l.uid); assert.equal(db.mode & 0o077, 0);
  return { l, database, db, helperSourceSha256, preparedAt: preparation.finishedAt, sourceManifestSha256: sha(manifestBytes) };
}
const CANDIDATE_PROGRAM = String.raw`
import fs from 'node:fs'; import fsp from 'node:fs/promises'; import path from 'node:path';
import {createRequire} from 'node:module';
import http from 'node:http'; import https from 'node:https'; import net from 'node:net';
import tls from 'node:tls'; import dns from 'node:dns'; import dgram from 'node:dgram';
const input=JSON.parse(process.argv[1]); let sqlAttempts=0,networkAttempts=0,writeAttempts=0;
const network=()=>{networkAttempts++;throw Error('hd_probe_network_forbidden')};globalThis.fetch=network;
for(const [object,methods] of [[http,['request','get']],[https,['request','get']],[net,['connect','createConnection']],
 [tls,['connect']],[dns,['lookup','resolve']],[dgram,['createSocket']]])for(const method of methods)object[method]=network;
net.Socket.prototype.connect=network;for(const method of ['lookup','resolve'])dns.promises[method]=network;
const sql=()=>{sqlAttempts++;throw Error('hd_probe_sql_forbidden')};
const table=new Proxy(sql,{get:()=>table,apply:sql});globalThis.hdReadonlyDb=table;globalThis.prisma=table;
const denyWrite=()=>{writeAttempts++;throw Error('hd_probe_write_forbidden')};
for(const name of ['writeFile','appendFile','mkdir','mkdtemp','rename','unlink','rmdir','rm','link','symlink','copyFile','truncate','chmod','chown','utimes']){
 if(typeof fsp[name]==='function')fsp[name]=denyWrite;
 if(typeof fs[name]==='function')fs[name]=denyWrite;
 if(typeof fs[name+'Sync']==='function')fs[name+'Sync']=denyWrite;
}
const originalOpen=fsp.open.bind(fsp),originalOpenSync=fs.openSync.bind(fs);
const readonly=flags=>flags==='r'||flags==='rs'||typeof flags==='number'&&(flags&3)===0&&!(flags&(fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND));
fsp.open=(file,flags,...rest)=>readonly(flags)?originalOpen(file,flags,...rest):denyWrite();
fs.openSync=(file,flags,...rest)=>readonly(flags)?originalOpenSync(file,flags,...rest):denyWrite();
const imported=await import('./src/lib/media/hd-derivatives.ts'),core=imported.default||imported;
if(typeof core.hdDirectory!=='function'||typeof core.assertHdDirectoryAccess!=='function'||typeof core.hdWorkerLockPath!=='function'
 ||typeof core.hdRequestIdentity!=='function'||typeof core.readHdJob!=='function')throw Error('hd_probe_exports_missing');
const root=core.hdDirectory();await core.assertHdDirectoryAccess();const lock=core.hdWorkerLockPath();
if(root!==input.hdRoot||lock!==input.lock)throw Error('hd_probe_resolver_mismatch');
const id=file=>{const s=fs.statSync(file);return{realpath:fs.realpathSync(file),dev:String(s.dev),ino:String(s.ino)}};
let ready=null;
if(input.key){const job=await core.readHdJob(input.key);if(!job||job.status!=='ready')throw Error('hd_probe_ready_missing');
 const identity=await core.hdRequestIdentity(job.source,job.preserveText);
 if(!identity||identity.key!==job.key||identity.current.version!==job.version)throw Error('hd_probe_ready_identity');
 const output=job.format==='original'?identity.current.file:path.join(root,job.file);
 await fsp.access(output,fs.constants.R_OK);
 const stat=fs.statSync(output);if(!stat.isFile()||stat.size!==job.bytes)throw Error('hd_probe_ready_length');
 let legacyMetadata=null;
 if(input.legacy){const require=createRequire(path.join(process.cwd(),'package.json')),sharp=require('sharp');
  const metadata=await sharp(output,{limitInputPixels:40000000,failOn:'warning'}).metadata();
  if(metadata.width!==job.width||metadata.height!==job.height||metadata.format!=='heif'||metadata.compression!=='av1')throw Error('hd_probe_legacy_metadata');
  const after=fs.statSync(output);for(const name of ['dev','ino','size','mtimeMs','ctimeMs'])if(after[name]!==stat[name])throw Error('hd_probe_legacy_moved');
  legacyMetadata={checked:true,width:metadata.width,height:metadata.height,format:metadata.format,compression:metadata.compression,bytes:after.size};}
 ready={key:job.key,version:job.version,bytes:job.bytes,legacyMetadata};}
if(sqlAttempts||networkAttempts||writeAttempts)throw Error('hd_probe_forbidden_attempt');
console.log('HD_CANDIDATE_RESOLVER='+JSON.stringify({root:id(root),uploads:id(path.join(process.cwd(),'public/uploads')),
 lock:id(lock),ready,runtimeUid:process.getuid(),runtimeGid:process.getgid(),cwd:process.cwd(),sqlAttempts,networkAttempts,writeAttempts}));`;

export function verifyHdCandidateResolver(m, c, prepared, receipt, { phase }) {
  assert.ok(['prepare', 'prebuild', 'runtime'].includes(phase)); const input = candidateInputs(m, c, prepared);
  assert.equal(receipt.schema, 'hd-candidate-resolver-probe-v1'); assert.equal(receipt.runId, m.runId);
  assert.equal(receipt.phase, phase); assert.equal(receipt.source, c.source); assert.equal(receipt.candidateRoot, c.root);
  assert.equal(receipt.sourceManifestSha256, input.sourceManifestSha256);
  assert.deepEqual(receipt.helperSourceSha256, input.helperSourceSha256);
  assert.equal(receipt.isolatedDatabase, input.database); assert.equal(receipt.productionDatabaseUsed, false);
  assert.deepEqual(receipt.bindings, bindings(m, input.l)); assert.equal(receipt.runtimeUid, input.l.uid); assert.equal(receipt.runtimeGid, input.l.gid);
  assert.equal(receipt.sqlAttempts, 0); assert.equal(receipt.networkAttempts, 0); assert.equal(receipt.writeAttempts, 0);
  assert.equal(receipt.readOnly, true); assert.match(receipt.stdoutSha256 || '', HASH);
  assert.ok(Number.isSafeInteger(receipt.protectedReadyCount) && receipt.protectedReadyCount >= 0);
  const excludedHistoricalReadyCount = Object.values(input.l.historicalApproval?.entries || {}).filter(item => item.status === 'ready').length;
  assert.equal(receipt.excludedHistoricalReadyCount, excludedHistoricalReadyCount);
  assert.ok(receipt.protectedReadyCount >= excludedHistoricalReadyCount);
  assert.equal(Boolean(receipt.ready), receipt.protectedReadyCount > excludedHistoricalReadyCount);
  assert.ok(Number.isSafeInteger(receipt.startedAt) && Number.isSafeInteger(receipt.finishedAt)
    && receipt.startedAt >= input.preparedAt && receipt.finishedAt >= receipt.startedAt && receipt.finishedAt <= Date.now() + 1000);
  if (receipt.ready) {
    assert.match(receipt.ready.key || '', HASH);
    assert.equal(Object.hasOwn(input.l.historicalApproval?.entries || {}, receipt.ready.key), false,
      'Preserved historical ready cannot prove current ready reuse');
    const job = JSON.parse(readRegular(path.join(m.hdRoot, receipt.ready.key + '.json')));
    assert.equal(job.status, 'ready'); const ready = readyState(m, m.hdRoot, job, input.l);
    const original = sourceFile(m, job.source, input.l);
    assert.equal(job.version, `${original.stat.dev}:${original.stat.ino}:${original.stat.bytes}:${original.stat.mtimeMs}:${original.stat.ctimeMs}`);
    assert.equal(receipt.ready.version, job.version); assert.equal(receipt.ready.bytes, job.bytes);
    assert.equal(receipt.ready.contractSha256, ready.contractSha256); assert.deepEqual(receipt.ready.output, outputProof(ready.output));
    assert.deepEqual(receipt.ready.original, outputProof(original.stat));
    assert.deepEqual(receipt.ready.legacy || null, ready.legacy || null);
    const metadata = receipt.ready.legacyMetadata;
    if (ready.legacy) {
      assert.equal(metadata?.checked, true); assert.equal(metadata.width, job.width); assert.equal(metadata.height, job.height);
      assert.equal(metadata.bytes, job.bytes); assert.equal(metadata.format, 'heif'); assert.equal(metadata.compression, 'av1');
    } else assert.equal(metadata || null, null);
  }
  assert.deepEqual(receipt.legacyMetadata, { required: receipt.ready?.legacy ? 1 : 0, checked: receipt.ready?.legacy ? 1 : 0,
    failed: 0, method: 'sharp-metadata-only', fullPixelDecode: false });
  return receipt;
}

export async function probeHdCandidateResolver(m, c, prepared, { phase }) {
  assert.ok(['prepare', 'prebuild', 'runtime'].includes(phase));
  const input = candidateInputs(m, c, prepared), before = readHdStorageProtection(m), startedAt = Date.now();
  const excludedHistoricalReadyCount = Object.values(before.historicalByKey).filter(item => item.status === 'ready').length;
  const key = Object.keys(before.readyByKey).filter(item => !Object.hasOwn(before.historicalByKey, item)).sort()[0] || null;
  const originalBefore = key ? sourceFile(m, JSON.parse(readRegular(path.join(m.hdRoot, key + '.json'))).source, input.l).stat : null;
  const env = { PATH: SYSTEM_PATH, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', NODE_ENV: 'production',
    HD_DERIVATIVES_ROOT: m.hdRoot, DATABASE_URL: `file:${input.database}`, TSX_DISABLE_CACHE: '1',
    SITE_PUBLIC_BASE_URL: m.publicOrigin, NEXT_TELEMETRY_DISABLED: '1' };
  for (const name of ['TMPDIR', 'HOME', 'XDG_CACHE_HOME']) {
    const value = prepared.buildEnv[name]; assert.ok(typeof value === 'string' && value.startsWith(prepared.preparedRoot + path.sep));
    env[name] = value;
  }
  let output;
  try {
    output = call('runuser', ['-u', m.appUser, '--', 'env', '-i', ...Object.entries(env).map(([name, value]) => name + '=' + value),
      process.execPath, '--import', 'tsx', '--input-type=module', '-e', CANDIDATE_PROGRAM,
      JSON.stringify({ hdRoot: m.hdRoot, lock: m.hdWorkerLockPath, key, legacy: Boolean(key && before.readyByKey[key].legacy) })], { cwd: c.root });
  } catch { throw Error('hd_candidate_resolver_probe_failed'); }
  const lines = output.split(/\r?\n/).filter(line => line.startsWith('HD_CANDIDATE_RESOLVER=')); assert.equal(lines.length, 1);
  const observed = JSON.parse(lines[0].slice('HD_CANDIDATE_RESOLVER='.length));
  assert.equal(observed.cwd, c.root);
  assert.equal(Boolean(observed.ready), Boolean(key)); if (key) assert.equal(observed.ready.key, key);
  for (const [name, expected] of [['root', before.bindings.canonical], ['uploads', before.bindings.uploads], ['lock', before.bindings.workerLock]]) {
    assert.deepEqual(observed[name], { realpath: expected.realpath, dev: expected.dev, ino: expected.ino });
  }
  assertHdStorageProtection(before, readHdStorageProtection(m));
  assert.deepEqual(fileStat(input.database, { ...input.l, dataDevice: fs.statSync(input.database).dev }), input.db, 'Probe changed its isolated DB');
  return verifyHdCandidateResolver(m, c, prepared, { schema: 'hd-candidate-resolver-probe-v1', runId: m.runId, phase,
    source: c.source, candidateRoot: c.root, sourceManifestSha256: input.sourceManifestSha256,
    helperSourceSha256: input.helperSourceSha256, isolatedDatabase: input.database, productionDatabaseUsed: false,
    bindings: before.bindings, runtimeUid: observed.runtimeUid, runtimeGid: observed.runtimeGid,
    protectedReadyCount: Object.keys(before.readyByKey).length,
    excludedHistoricalReadyCount,
    ready: observed.ready ? { ...observed.ready, contractSha256: before.readyByKey[key].contractSha256,
      output: outputProof(before.readyByKey[key].output), original: outputProof(originalBefore), legacy: before.readyByKey[key].legacy || null } : null,
    sqlAttempts: observed.sqlAttempts, networkAttempts: observed.networkAttempts, writeAttempts: observed.writeAttempts,
    legacyMetadata: { required: key && before.readyByKey[key].legacy ? 1 : 0, checked: key && before.readyByKey[key].legacy ? 1 : 0,
      failed: 0, method: 'sharp-metadata-only', fullPixelDecode: false },
    readOnly: true, startedAt, finishedAt: Date.now(), stdoutSha256: sha(output) }, { phase });
}
