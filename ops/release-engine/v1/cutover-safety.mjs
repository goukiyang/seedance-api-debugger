import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rootFile, sha, call, assertReleaseWindow, liveArtifactSource, rejectedPricingRoots, engineDirectory } from './common.mjs';
import { candidateEvidenceFile, assertFreshCandidateEvidence, candidateCompatibilityDirectory } from './candidate-evidence.mjs';
import { cwdBytes, assertNaturalExitEvidence, protectedFileSnapshot } from './switch.mjs';
import { captureNginxUpstreamSockets } from './nginx-maintenance.mjs';
import { fileIdentity } from './legacy-maintenance.mjs';
import { capturePricingStartControl } from './pricing-start-pair.mjs';
import { assertWriterFenceManifest, assertWriterFenceTarget, assertActiveWriterIdentity } from './writer-network-fence.mjs';
import { withEmptyWriterLock } from './empty-writer-lock.mjs';
import { readGuardRecovery, verifyGuardRecovery } from './guard-recovery.mjs';

const HASH = /^[a-f0-9]{64}$/;
const ROLES = ['web', 'image', 'hd'];
const CWD = '/etc/systemd/system/sd2-gray.service.d/default01-web.conf';
const NETWORK = ['/run/systemd/system.control/sd2-gray.service.d/50-IPAddressAllow.conf',
  '/run/systemd/system.control/sd2-gray.service.d/50-IPAddressDeny.conf'];
const HOSTS = ['sd2.youdooart.com', 'sd2-server.youdoodesign.com'];
const clone = value => structuredClone(value);
const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
const exists = file => fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
const SERVICE_FIELDS = ['Id', 'User', 'MainPID', 'ControlPID', 'ActiveState', 'SubState', 'Result', 'InvocationID',
  'ExecMainPID', 'ExecMainStartTimestamp', 'ExecMainStartTimestampMonotonic', 'WorkingDirectory', 'ControlGroup',
  'Restart', 'SendSIGKILL', 'TimeoutStopUSec', 'KillSignal', 'KillMode', 'Delegate'];

// ALL owners, complete records. No substring status filtering and no account
// or request identifiers in the returned receipt.
function parseSynchronousRows(rows, now) {
  assert.ok(Array.isArray(rows)); const seen = new Set(); let runningRequests = 0, runningImages = 0;
  const keys = ['schema', 'ownerId', 'requestId', 'fingerprint', 'count', 'model', 'scope', 'status', 'createdAt', 'finishedAt'].sort();
  for (const item of rows) {
    assert.deepEqual(Object.keys(item).sort(), ['key', 'value_json']);
    assert.equal(typeof item.key, 'string'); assert.equal(typeof item.value_json, 'string');
    assert.ok(!seen.has(item.key)); seen.add(item.key);
    const value = JSON.parse(item.value_json);
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), keys); assert.equal(value.schema, 'image.sync-admission.v1');
    for (const key of ['ownerId', 'requestId', 'fingerprint', 'model', 'scope']) {
      assert.ok(typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 4096);
    }
    assert.match(value.requestId, /^[a-zA-Z0-9-]{16,100}$/);
    assert.equal(item.key, 'image_sync_request_v1:' + value.ownerId + ':' + value.requestId);
    assert.ok(Number.isSafeInteger(value.count) && value.count >= 1 && value.count <= 8);
    assert.ok(['running', 'succeeded', 'failed', 'accepted_unknown'].includes(value.status));
    const created = Date.parse(value.createdAt);
    assert.ok(typeof value.createdAt === 'string' && Number.isFinite(created) && created <= now);
    if (value.status === 'running') {
      assert.equal(value.finishedAt, null); runningRequests++; runningImages += value.count;
    } else assert.ok(typeof value.finishedAt === 'string' && Number.isFinite(Date.parse(value.finishedAt))
      && Date.parse(value.finishedAt) >= created && Date.parse(value.finishedAt) <= now);
  }
  return { rows: rows.length, rowsSha256: sha(JSON.stringify(rows)), runningRequests, runningImages };
}
export function parseAllOwnerSynchronousRows(rows, now = Date.now()) {
  try { return parseSynchronousRows(rows, now); }
  catch { throw new Error('hd_sync_admission_schema_unconfirmed'); } // Never print raw JSON, owner, or request IDs.
}
function rootSnapshot(file) {
  const bytes = rootFile(file), s = fs.lstatSync(file);
  return { file, dev: String(s.dev), ino: String(s.ino), uid: s.uid, gid: s.gid, mode: s.mode & 0o7777,
    nlink: s.nlink, sha256: sha(bytes), bytesBase64: bytes.toString('base64') };
}
function processIdentity(pid) {
  const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'), parts = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
  assert.ok(!['Z', 'X', 'x'].includes(parts[0])); assert.match(parts[19], /^\d+$/);
  const cgroup = /^0::([^\n]+)$/m.exec(fs.readFileSync('/proc/' + pid + '/cgroup', 'utf8'))?.[1];
  assert.ok(cgroup?.startsWith('/system.slice/'));
  return { pid, processStartTicks: parts[19], cgroup, root: fs.realpathSync('/proc/' + pid + '/cwd') };
}
function groupPids(group) {
  assert.ok(typeof group === 'string' && group.startsWith('/system.slice/') && !group.split('/').includes('..'));
  const root = '/sys/fs/cgroup' + group;
  if (!exists(root)) return [];
  const pending = [root], result = new Set(); let scanned = 0;
  while (pending.length) {
    const current = pending.pop(); assert.ok(++scanned <= 256);
    for (const pid of fs.readFileSync(current + '/cgroup.procs', 'utf8').trim().split(/\s+/).filter(Boolean)) result.add(pid);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) if (entry.isDirectory()) pending.push(path.join(current, entry.name));
  }
  return [...result].sort();
}
const SYNC_READ = [
  'import json,os,sqlite3,stat,sys',
  'p=sys.argv[1];s=os.lstat(p)',
  'assert os.path.realpath(p)==p and stat.S_ISREG(s.st_mode) and s.st_nlink==1',
  "with sqlite3.connect('file:'+p+'?mode=ro',uri=True,timeout=2) as c:",
  " c.execute('PRAGMA query_only=ON');c.execute('BEGIN')",
  " rows=[dict(key=r[0],value_json=r[1]) for r in c.execute(\"SELECT key,value_json FROM PlatformSetting WHERE substr(key,1,22)='image_sync_request_v1:' ORDER BY key\")]",
  ' c.rollback()',
  'a=os.lstat(p);assert (s.st_dev,s.st_ino)==(a.st_dev,a.st_ino)',
  "print(json.dumps(dict(databaseIdentity=[str(a.st_dev),str(a.st_ino)],rows=rows),separators=(',',':')))",
].join('\n');

// Narrow parser for this release's actual nginx -T: only the two server_name
// blocks proxying 3302 and an inherited/default combined access_log. Any unknown
// grammar/path/format is a refusal, not an inferred zero or a new log framework.
export function logPaths(text) {
  let depth = 0, httpDepth = null, server = null;
  const defaults = [], servers = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim(); if (!line) continue;
    if (/^http\s*\{/.test(line)) httpDepth = depth + 1;
    if (/^server\s*\{/.test(line)) { assert.equal(server, null); server = { depth: depth + 1, names: [], logs: [], proxy: false }; }
    if (server && /^server_name\s/.test(line)) server.names.push(...line.slice(12).replace(/;$/, '').trim().split(/\s+/));
    if (server && /proxy_pass\s+http:\/\/127\.0\.0\.1:3302;/.test(line)) server.proxy = true;
    if (/^access_log\s/.test(line) && (server ? depth === server.depth : depth === httpDepth)) {
      const match = /^access_log\s+(\/[^\s;$"'\\]+)(?:\s+(combined))?(?:\s+(?:buffer|flush|gzip)=[^\s;]+)*;$/.exec(line);
      assert.ok(match, 'Unknown nginx access_log declaration');
      if (match[1] === '/data/video-api-debugger/logs/nginx-access.log')
        assert.equal(line, 'access_log /data/video-api-debugger/logs/nginx-access.log combined;', 'Project admission log must be unbuffered combined');
      (server ? server.logs : defaults).push(match[1]);
    }
    const braces = line.replace(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'/g, '');
    depth += (braces.match(/\{/g) || []).length - (braces.match(/\}/g) || []).length;
    assert.ok(depth >= 0);
    if (server && depth < server.depth) { servers.push(server); server = null; }
    if (httpDepth !== null && depth < httpDepth) httpDepth = null;
  }
  assert.equal(depth, 0); assert.equal(server, null);
  assert.ok(!defaults.includes('/data/video-api-debugger/logs/nginx-access.log'));
  for (const entry of servers.filter(value => value.logs.includes('/data/video-api-debugger/logs/nginx-access.log')))
    assert.ok(entry.names.length && entry.names.every(name => HOSTS.includes(name)), 'Unrelated host shares the project admission log');
  const paths = [];
  for (const host of HOSTS) {
    const matches = servers.filter(value => value.names.includes(host) && value.proxy); assert.equal(matches.length, 1);
    const selected = matches[0].logs;
    assert.deepEqual(selected, ['/data/video-api-debugger/logs/nginx-access.log'], 'Release admission requires the dedicated project access log');
    paths.push(...selected);
  }
  return [...new Set(paths)].sort();
}
function logBoundary() {
  const paths = logPaths(call('nginx', ['-T'], { timeout: 15000 }));
  return paths.map(file => {
    assert.equal(fs.realpathSync(file), file); const s = fs.lstatSync(file);
    assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { if (s.size) { const last = Buffer.alloc(1); assert.equal(fs.readSync(fd, last, 0, 1, s.size - 1), 1); assert.equal(last[0], 10); } }
    finally { fs.closeSync(fd); }
    return { file, dev: String(s.dev), ino: String(s.ino), offset: s.size };
  });
}
function completedObservation(boundary) {
  let completed = 0, deniedMutations = 0, admittedMutations = 0; const hashes = [];
  assert.deepEqual(logPaths(call('nginx', ['-T'], { timeout: 15000 })), boundary.map(value => value.file));
  for (const prior of boundary) {
    assert.equal(fs.realpathSync(prior.file), prior.file); const s = fs.lstatSync(prior.file);
    assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1);
    assert.equal(String(s.dev), prior.dev); assert.equal(String(s.ino), prior.ino);
    assert.ok(s.size >= prior.offset && s.size - prior.offset <= 4 * 1024 * 1024, 'Log rotated or observation exceeded its bound');
    const bytes = Buffer.alloc(s.size - prior.offset), fd = fs.openSync(prior.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { assert.equal(fs.readSync(fd, bytes, 0, bytes.length, prior.offset), bytes.length); } finally { fs.closeSync(fd); }
    assert.ok(!bytes.length || bytes.at(-1) === 10);
    for (const line of bytes.toString().split('\n').filter(Boolean)) {
      const match = /^[^"]*"([A-Z]+) [^"]* HTTP\/[0-9.]+"\s+(\d{3})\s/.exec(line);
      assert.ok(match, 'Access log is not the confirmed combined grammar'); completed++;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(match[1])) {
        if (Number(match[2]) === 503) deniedMutations++; else admittedMutations++;
      }
    }
    hashes.push(sha(bytes));
  }
  return { completed, deniedMutations, admittedMutations, bytesSha256: sha(JSON.stringify(hashes)), fullLifecycleProven: false };
}

// The native helper deliberately binds SELF to the operation directory. Keep
// its reviewed bytes unchanged; prepare the one exact executable copy before
// any maintenance, then use that actual module for every native operation.
export async function prepareOperationFenceModule(m) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  assert.match(m.runId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.equal(m.stage, '/data/video-api-debugger/release-staging/' + m.runId);
  const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
  if (sourceDirectory !== engineDirectory(m)) {
    assert.equal(sourceDirectory, candidateCompatibilityDirectory(m), 'Only the journal-bound compatible reader may delegate the original fence preparation');
    const originalDirectory = engineDirectory(m);
    for (const [name, expected] of Object.entries(m.privateSha256)) {
      assert.equal(path.basename(name), name); assert.match(expected, HASH);
      assert.equal(sha(rootFile(path.join(originalDirectory, name))), expected, 'Original release control changed before fence delegation: ' + name);
    }
    const original = await import(pathToFileURL(path.join(originalDirectory, 'cutover-safety.mjs')).href);
    assert.equal(typeof original.prepareOperationFenceModule, 'function');
    return original.prepareOperationFenceModule(m);
  }
  assert.equal(sourceDirectory, engineDirectory(m));
  assert.equal(fs.realpathSync(sourceDirectory), sourceDirectory);
  for (let directory = sourceDirectory; directory !== '/'; directory = path.dirname(directory)) {
    const state = fs.lstatSync(directory);
    assert.ok(state.isDirectory() && !state.isSymbolicLink() && state.uid === 0 && !(state.mode & 0o022));
    assert.equal(fs.realpathSync(directory), directory);
  }
  assert.equal(fs.lstatSync(m.stage).mode & 0o7777, 0o700);
  const name = 'writer-network-fence.mjs', expected = m.privateSha256[name];
  assert.match(expected, HASH);
  const source = path.join(sourceDirectory, name), bytes = rootFile(source);
  assert.equal(sha(bytes), expected, 'Original native helper is not the approved source');
  const operationStage = m.stage + '/hd-release-safety-r03';
  if (!exists(operationStage)) fs.mkdirSync(operationStage, { mode: 0o700 });
  const directoryState = fs.lstatSync(operationStage);
  assert.ok(directoryState.isDirectory() && !directoryState.isSymbolicLink() && directoryState.uid === 0
    && (directoryState.mode & 0o7777) === 0o700);
  assert.equal(fs.realpathSync(operationStage), operationStage);
  const target = path.join(operationStage, name);
  if (!exists(target)) {
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const directory = fs.openSync(operationStage, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
  const captured = rootSnapshot(target);
  assert.equal(captured.mode, 0o600); assert.equal(captured.nlink, 1);
  assert.equal(captured.sha256, expected, 'Existing operation helper differs; never overwrite it');
  const namespace = await import(pathToFileURL(target).href);
  assert.deepEqual(rootSnapshot(target), captured, 'Operation helper changed during import');
  assert.equal(sha(rootFile(source)), expected);
  for (const key of ['createNativeWriterFenceIO', 'prepareWriterFenceProbe', 'inspectWriterFenceTarget',
    'installWriterNetworkFence', 'restoreWriterNetworkFence', 'readWriterNetworkFenceReceipt']) assert.equal(typeof namespace[key], 'function');
  return Object.freeze({ kind: 'verified-operation-fence-module.v1', file: target, source,
    sha256: expected, snapshot: captured, namespace });
}

function nativeDependencies(m, operationStage = m.stage + '/hd-release-safety-r03', loaded) {
  assert.equal(loaded?.kind, 'verified-operation-fence-module.v1');
  assert.equal(loaded.file, m.stage + '/hd-release-safety-r03/writer-network-fence.mjs');
  assert.equal(loaded.sha256, m.privateSha256['writer-network-fence.mjs']);
  assert.deepEqual(rootSnapshot(loaded.file), loaded.snapshot);
  const native = loaded.namespace;
  const json = file => JSON.parse(rootFile(file));
  return {
    kind: 'native', now: Date.now, bytes: rootFile, json, snapshot: rootSnapshot, configuration: protectedFileSnapshot, exists,
    assertWindow: () => assertReleaseWindow(m),
    recoveryProof: context => context.recoveryRoute === 'original' ? { value: readGuardRecovery(m) } : verifyGuardRecovery(m, context.before),
    recoveryLockSha256: () => sha(rootFile(m.stage + '/fixed-guard-recovery.json')),
    network: () => Object.fromEntries(call('systemctl', ['show', m.live.web.unit,
      ...['IPAddressAllow', 'IPAddressDeny', 'IPIngressFilterPath', 'IPEgressFilterPath'].flatMap(field => ['-p', field])])
      .split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; })),
    privateFiles: () => fs.readdirSync(path.dirname(fileURLToPath(import.meta.url))).filter(file => file.endsWith('.mjs')).sort(),
    service: role => Object.fromEntries(call('systemctl', ['show', m.live[role].unit,
      ...SERVICE_FIELDS.flatMap(field => ['-p', field])]).split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; })),
    processIdentity, pidPresent: pid => exists('/proc/' + pid), groupPids,
    groupIdentity: group => { const s = fs.statSync('/sys/fs/cgroup' + group); return { dev: s.dev, ino: s.ino }; },
    sync: () => JSON.parse(call('python3', ['-I', '-c', SYNC_READ, m.database])),
    source: root => liveArtifactSource(root), control: () => capturePricingStartControl({ verifyReleases: false }),
    logBoundary, completedObservation,
    fenceIO: native.createNativeWriterFenceIO(), inspectFence: native.inspectWriterFenceTarget, prepareProbe: native.prepareWriterFenceProbe,
    install: native.installWriterNetworkFence, restore: native.restoreWriterNetworkFence, readFence: native.readWriterNetworkFenceReceipt,
    lock: withEmptyWriterLock, cwd: (before, root) => cwdBytes(m, before, 'web', root).toString('utf8'),
    seal(name, body) {
      assert.match(name, /^[a-z-]+$/);
      const file = operationStage + '/' + name + (name === 'fence-view' ? '' : '-' + randomUUID()) + '.json';
      const s = fs.lstatSync(operationStage);
      assert.ok(s.isDirectory() && !s.isSymbolicLink() && s.uid === 0 && (s.mode & 0o7777) === 0o700);
      assert.equal(fs.realpathSync(operationStage), operationStage);
      const bytes = Buffer.from(JSON.stringify(body) + '\n');
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fchownSync(fd, 0, 0); fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const dir = fs.openSync(operationStage, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      const saved = rootSnapshot(file); assert.equal(saved.mode, 0o600); assert.equal(saved.nlink, 1);
      return { ...body, artifact: { path: file, sha256: sha(bytes) } };
    },
    async ingress(installed, master) {
      assert.deepEqual(json(m.stage + '/nginx-' + m.runId + '-installed.json'), installed);
      assert.equal(installed.runId, m.runId); assert.equal(installed.stageRoot, m.stage);
      assert.equal(installed.markerPath, '/data/video-api-debugger/entry-maintenance/' + m.runId + '/nginx.active');
      assert.deepEqual(fileIdentity(installed.markerPath), installed.markerIdentity);
      assert.equal(sha(rootFile(installed.markerPath)), installed.markerSha256);
      assert.equal(rootFile(installed.markerPath).toString(), 'rate-impl2 nginx entry maintenance ' + m.runId + '\n');
      assert.deepEqual(installed.files.map(item => item.file).sort(),
        ['/etc/nginx/sites-available/sd2.youdooart.com', '/etc/nginx/sites-available/sd2-server.youdoodesign.com'].sort());
      for (const item of installed.files) {
        assertConfigurationIdentity(protectedFileSnapshot(item.file), item.ownIdentity, item.maintainedSha256);
        assert.equal(item.maintainedSha256, sha(item.maintained));
        assert.ok(item.maintained.includes('# rate-impl2-maintenance ' + m.runId)
          && item.maintained.includes('if (-f ' + installed.markerPath + ') { return 503; }'));
        assertConfigurationIdentity(protectedFileSnapshot(item.swapPath), item.identity, item.sha256);
      }
      const responses = HOSTS.map((host, index) => {
        const origin = index === 0 ? 'https://' + host : 'http://' + host;
        const output = call('curl', ['-q', '--noproxy', '*', '-sS', '--connect-timeout', '1', '--max-time', '2',
          '--resolve', host + (index === 0 ? ':443:127.0.0.1' : ':80:127.0.0.1'),
          '-H', 'Cookie:', '-H', 'Authorization:', '-w', '\n%{http_code}', origin + '/api/release'], { timeout: 2500 });
        const split = output.lastIndexOf('\n');
        return { host, status: Number(output.slice(split + 1)), responseSha256: sha(output.slice(0, split)), checkedAt: Date.now() };
      });
      return { responses, sockets: captureNginxUpstreamSockets({ ...master, upstreamPort: 3302 }) };
    },
  };
}

function requireInitialPolicy(policy) {
  assert.ok(policy && policy.unit && Array.isArray(policy.parents));
  for (const key of ['allow', 'deny', 'ingressFilters', 'egressFilters']) assert.equal(policy.unit[key], '', 'Nonempty original Web network policy');
  assert.deepEqual(policy.runtimeFiles, {});
  assert.deepEqual(policy.parents.map(item => item.name).sort(), ['-.slice', 'system.slice']);
  for (const parent of policy.parents) assert.equal(parent.allow, '', 'Parent Allow is not authorized');
}

// Existing application/nginx configurations retain their captured owner. They
// are not root-owned release inputs. The exact path, inode, owner, mode, single
// link and bytes remain mandatory; this does not weaken rootFile elsewhere.
export function assertConfigurationIdentity(actual, identity, digest) {
  assert.equal(actual.real, actual.file); assert.equal(actual.nlink, 1);
  assert.deepEqual({ dev: actual.dev, ino: actual.ino, uid: actual.uid, gid: actual.gid,
    mode: actual.mode, kind: 'file' }, identity);
  assert.equal(actual.sha256, digest, 'A protected configuration changed');
}
function checkConfigurations(d, m, before, installed) {
  assert.deepEqual(Object.keys(before.protectedFileIdentities).sort(), Object.keys(m.expectedProtectedFileSha256).sort());
  for (const [file, digest] of Object.entries(m.expectedProtectedFileSha256)) {
    const captured = before.protectedFileIdentities[file];
    assert.equal(captured.file, file); assert.equal(captured.real, file); assert.equal(captured.nlink, 1); assert.equal(captured.sha256, digest);
    const maintained = installed?.files?.find(item => item.file === file);
    const actual = d.configuration(file);
    if (maintained) {
      assert.deepEqual({ dev: captured.dev, ino: captured.ino, uid: captured.uid, gid: captured.gid,
        mode: captured.mode, kind: 'file' }, maintained.identity);
      assert.equal(maintained.sha256, digest);
      assertConfigurationIdentity(actual, maintained.ownIdentity, maintained.maintainedSha256);
    } else assert.deepEqual(actual, captured, 'A protected configuration identity or bytes changed');
  }
}
function establishActiveView(d, m, before, manifestSha256) {
  const state = d.service('web'), process = d.processIdentity(m.live.web.pid), group = d.groupIdentity(process.cgroup);
  assert.equal(state.MainPID, before.writers.web.MainPID); assert.equal(state.InvocationID, m.live.web.invocation);
  assert.equal(state.ActiveState, 'active'); assert.equal(state.SubState, 'running'); assert.equal(state.Delegate, 'no');
  assert.equal(process.root, m.live.web.root); assert.equal(process.cgroup, '/system.slice/sd2-gray.service');
  assert.equal(d.source(process.root), m.live.web.source);
  const view = { ...clone(m), healthUrl: 'http://127.0.0.1:3302/api/release',
    live: { ...clone(m.live), web: { ...clone(m.live.web), processStartTicks: process.processStartTicks,
      cgroup: process.cgroup, cgroupDev: group.dev, cgroupIno: group.ino, dropin: CWD } },
    main: { ...clone(m.main), cwdBytes: d.cwd(before, m.main.root) },
    guard: { ...clone(m.guard), cwdBytes: d.cwd(before, m.guard.root) } };
  d.seal('fence-view', { manifestSha256, view });
  const expected = assertWriterFenceManifest(view, manifestSha256);
  for (const kind of ['main', 'guard']) assert.equal(view[kind].cwdBytes, d.cwd(before, m[kind].root));
  return { view, expected };
}
async function readBeforeMaintenance(d, m, before, manifestSha256) {
  checkConfigurations(d, m, before);
  const { view, expected } = establishActiveView(d, m, before, manifestSha256);
  const sync = d.sync(); assert.deepEqual(sync.databaseIdentity, before.protection.databaseIdentity);
  const parsed = parseAllOwnerSynchronousRows(sync.rows, d.now()); assert.equal(parsed.runningRequests, 0);
  const inspected = await d.inspectFence({ manifest: view, manifestSha256, phase: 'live-before-maintenance', io: d.fenceIO });
  assert.deepEqual(inspected.binding, expected); assertActiveWriterIdentity(inspected.target, expected);
  requireInitialPolicy(inspected.policy);
  const baselineControl = d.control();
  for (const key of ['guard', 'allowed', 'marker', 'chain']) assert.deepEqual(baselineControl[key], before.captured[key]);
  for (const role of ROLES) {
    const current = d.service(role); assert.equal(current.MainPID, before.writers[role].MainPID);
    assert.equal(current.InvocationID, before.writers[role].InvocationID);
  }
  const logStart = d.logBoundary(); assert.ok(Array.isArray(logStart) && logStart.length > 0, 'Completed-request log observation is unknown');
  return { view, expected, parsed, originalPolicy: clone(inspected.policy), baselineControl, logStart };
}

// Engineering-only, read-only body shared with beforeMaintenance. It returns no
// install/restore callbacks and cannot authorize a release. Expired approval and
// build receipts are NOT refreshed, rewritten or treated as current by this path.
export async function inspectNativeBeforeMaintenance({ m, manifestSha256, before, evidenceDirectory,
  beforeFile = m.stage + '/switch-before.json' }) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const evidenceRoot = m.stage + '/readonly-before-maintenance';
  const attempt = path.relative(evidenceRoot, evidenceDirectory);
  const namespacedAttempt = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(attempt)
    && evidenceDirectory === path.join(evidenceRoot, attempt);
  assert.ok(evidenceDirectory === evidenceRoot || namespacedAttempt);
  assert.deepEqual(JSON.parse(rootFile(m.stage + '/manifest.json')), m);
  assert.equal(sha(rootFile(m.stage + '/manifest.json')), manifestSha256);
  assert.ok([m.stage + '/switch-before.json', m.stage + '/preflight-switch-before.json',
    ...(namespacedAttempt ? [evidenceDirectory + '/before.json'] : [])].includes(beforeFile));
  const saved = JSON.parse(rootFile(beforeFile)); assert.equal(saved.runId, m.runId); delete saved.runId;
  assert.deepEqual(saved, before); assert.equal(before.manifestSha256, manifestSha256);
  const loaded = await prepareOperationFenceModule(m);
  const result = await readBeforeMaintenance(nativeDependencies(m, evidenceDirectory, loaded), m, before, manifestSha256);
  return { schema: 'hd-native-before-maintenance-readonly.v1', completed: true, nativeExecuted: true,
    releaseApproved: false, releaseAuthorityAndBuildFreshnessChecked: false, observedAt: new Date().toISOString(),
    manifestSha256, sync: result.parsed, originalPolicySha256: sha(JSON.stringify(result.originalPolicy)),
    logBoundary: result.logStart, liveIdentitiesChecked: ROLES,
    effects: { maintenance: 0, serviceMutation: 0, fence: 0, provider: 0, databaseWrites: 0, productionFileWrites: 0 },
    evidenceDirectory, boundary: 'Actual native read-only body only; not a release approval, fresh build receipt or functional acceptance' };
}

// Explicit offline dependencies exercise the actual adapter decisions. There
// is no environment flag, HTTP entry, native failure fallback, or app writer.
export function createHdReleaseSafety({ m, manifestSha256, approval, approvalSha256, offlineAdapter, nativeFenceModule } = {}) {
  if (offlineAdapter) assert.equal(offlineAdapter.kind, 'hd-cutover-offline-v1');
  const d = offlineAdapter || nativeDependencies(m, undefined, nativeFenceModule), frozenM = JSON.stringify(m), operationStage = m.stage + '/hd-release-safety-r03';
  let view, expected, originalPolicy, receipt, baselineControl, logStart, installUnknown = false, beforeSeen = false, restored = false;
  const events = [], record = (phase, details = {}) => events.push({ phase, at: d.now(), ...details });
  const boundJson = name => {
    const value = d.json(m.stage + '/' + name + '.json');
    assert.equal(value.runId, m.runId); assert.equal(value.manifestSha256, manifestSha256); return value;
  };
  function checkpoint(context, builds) {
    assert.equal(JSON.stringify(m), frozenM, 'Original manifest object was mutated'); assert.deepEqual(context.m, m);
    assert.match(manifestSha256, HASH); assert.match(approvalSha256, HASH);
    const manifest = d.bytes(m.stage + '/manifest.json'); assert.equal(sha(manifest), manifestSha256); assert.deepEqual(JSON.parse(manifest), m);
    d.assertWindow();
    const saved = d.bytes(m.stage + '/hd-release-safety-approval.json');
    assert.equal(sha(saved), approvalSha256); assert.deepEqual(JSON.parse(saved), approval);
    assert.equal(approval.schema, 'hd-release-maintenance-approval.v1');
    for (const key of ['runId', 'mainSource', 'guardSource']) assert.equal(approval[key], m[key]);
    assert.equal(approval.manifestSha256, manifestSha256);
    assert.equal(approval.privateFreezeSha256, sha(JSON.stringify(m.privateSha256)));
    assert.equal(approval.windowSha256, sha(d.bytes(m.windowFile)));
    assert.deepEqual(d.privateFiles(), Object.keys(m.privateSha256).sort());
    for (const [name, digest] of Object.entries(m.privateSha256)) {
      assert.equal(path.basename(name), name); assert.match(digest, HASH);
      assert.equal(sha(d.bytes(engineDirectory(m) + '/' + name)), digest);
    }
    const issued = timestamp(approval.issuedAt), expires = timestamp(approval.expiresAt);
    assert.ok(Number.isSafeInteger(issued) && Number.isSafeInteger(expires)
      && issued <= d.now() && d.now() < expires && expires > issued && expires - issued <= 300000);
    assert.equal(approval.manualMaintenanceConfirmed, true); assert.equal(approval.allowCompatibleRollback, true);
    assert.deepEqual(approval.operations, ['switch', 'rollback-to-compatible-guard']);
    assert.equal(approval.writerFence.install, true);
    assert.equal(approval.writerFence.helperSha256, m.privateSha256['writer-network-fence.mjs']);
    assert.deepEqual(approval.writerFence.restorePhases, ['pre-stop-installation-abort', 'before-new-writer-after-proven-old-stop']);
    for (const kind of ['main', 'guard']) {
      const bytes = d.bytes(candidateEvidenceFile(m, kind)), savedBuild = JSON.parse(bytes);
      assert.equal(approval[kind + 'BuildReceiptSha256'], sha(bytes));
      assert.equal(savedBuild.source, m[kind].source); assert.equal(savedBuild.version, m[kind].version);
      assert.equal(savedBuild.runId, m.runId); assert.equal(savedBuild.manifestSha256, manifestSha256);
      assert.equal(savedBuild.exitCode, 0); assert.equal(savedBuild.verifiedSourceAndGates, true);
      assertFreshCandidateEvidence(savedBuild, m, kind, d.now());
      if (builds) assert.deepEqual(savedBuild, builds[kind]);
    }
  }
  function recoveryCheckpoint(context) {
    assert.equal(context.recoveryOnly, true); assert.equal(JSON.stringify(m), frozenM); assert.deepEqual(context.m, m);
    const bytes = d.bytes(m.stage + '/manifest.json'); assert.equal(sha(bytes), manifestSha256); assert.deepEqual(JSON.parse(bytes), m);
    assert.deepEqual(d.privateFiles(), Object.keys(m.privateSha256).sort());
    for (const [name, digest] of Object.entries(m.privateSha256)) assert.equal(sha(d.bytes(engineDirectory(m) + '/' + name)), digest);
    const fixed = d.recoveryProof(context).value;
    assert.equal(fixed.runId, m.runId); assert.equal(fixed.manifestSha256, manifestSha256);
    assert.equal(fixed.guardEntry.source, m.guardSource); assert.equal(fixed.guardEntry.root, m.guard.root);
    assert.equal(fixed.onlyOperation, 'recover-this-guard-after-this-run-failure'); assert.equal(fixed.continueMain, false);
    return fixed;
  }
  function checkBefore(before) {
    const saved = boundJson('switch-before'), actual = { ...saved }; delete actual.runId;
    assert.deepEqual(actual, before); assert.equal(before.schema, 'rate-impl2-switch-before.v1');
    for (const role of ROLES) {
      const original = before.writers[role]; assert.equal(Number(original.MainPID), m.live[role].pid);
      assert.equal(original.InvocationID, m.live[role].invocation); assert.equal(original.WorkingDirectory, m.live[role].root);
    }
  }
  function establishView(before, rollback = false) {
    if (rollback) {
      const saved = d.json(operationStage + '/fence-view.json'); assert.equal(saved.manifestSha256, manifestSha256); view = saved.view;
      const original = clone(view);
      delete original.healthUrl;
      for (const key of ['processStartTicks', 'cgroup', 'cgroupDev', 'cgroupIno', 'dropin']) delete original.live.web[key];
      for (const kind of ['main', 'guard']) delete original[kind].cwdBytes;
      assert.deepEqual(original, m);
    } else ({ view, expected } = establishActiveView(d, m, before, manifestSha256));
    expected = assertWriterFenceManifest(view, manifestSha256);
    for (const kind of ['main', 'guard']) assert.equal(view[kind].cwdBytes, d.cwd(before, m[kind].root));
  }
  function noForce() {
    for (const role of ROLES) {
      const state = d.service(role);
      assert.equal(state.Restart, 'no'); assert.equal(state.SendSIGKILL, 'no'); assert.equal(state.TimeoutStopUSec, 'infinity');
      assert.equal(state.KillSignal, '15'); assert.ok(['control-group', 'mixed'].includes(state.KillMode));
    }
  }
  function stopped(before, roles) {
    for (const role of roles) {
      const original = before.writers[role], intent = boundJson('natural-stop-intent-switch-' + role);
      assert.deepEqual(intent.capturedOriginal, original); assert.equal(intent.signal, 'SIGTERM'); assert.equal(intent.forcedKill, false);
      for (const key of ['MainPID', 'InvocationID', 'WorkingDirectory', 'ExecMainPID', 'ExecMainStartTimestamp', 'ExecMainStartTimestampMonotonic']) {
        assert.equal(intent.before[key], original[key]);
      }
      const complete = boundJson('natural-stop-switch-' + role);
      assert.equal(complete.forcedKill, false); assert.deepEqual(complete.before, intent.before); assert.equal(complete.originalCgroup, intent.before.ControlGroup);
      const observed = { originalPidPresent: d.pidPresent(Number(original.MainPID)),
        originalGroupPids: d.groupPids(original.ControlGroup), unitGroupPids: d.groupPids('/system.slice/' + m.live[role].unit) };
      assertNaturalExitEvidence(complete.after, original, observed); assertNaturalExitEvidence(d.service(role), original, observed);
    }
  }
  function recoveryStopped(before, roles) {
    assert.equal(d.exists('/data/video-api-debugger/controls/pricing-writer-v1/start-' + m.runId + '.json'), false);
    for (const role of roles) {
      const original = before.writers[role];
      const prefix = d.exists(m.stage + '/natural-stop-intent-switch-' + role + '.json') ? 'switch' : 'recovery';
      const intent = boundJson('natural-stop-intent-' + prefix + '-' + role);
      if (prefix === 'switch') assert.deepEqual(intent.capturedOriginal, original);
      else for (const key of ['MainPID', 'InvocationID', 'WorkingDirectory', 'ExecMainPID', 'ExecMainStartTimestamp', 'ExecMainStartTimestampMonotonic'])
        assert.equal(intent.capturedOriginal[key], original[key]);
      assert.equal(intent.signal, 'SIGTERM'); assert.equal(intent.forcedKill, false);
      assert.equal(intent.before.SendSIGKILL, 'no'); assert.equal(intent.before.TimeoutStopUSec, 'infinity');
      assert.equal(intent.before.Restart, 'no');
      assertNaturalExitEvidence(d.service(role), original, { originalPidPresent: d.pidPresent(Number(original.MainPID)),
        originalGroupPids: d.groupPids(original.ControlGroup), unitGroupPids: d.groupPids('/system.slice/' + m.live[role].unit) });
    }
  }
  async function ingress(installed, master) {
    const sampledAt = d.now(), value = await d.ingress(installed, master);
    assert.deepEqual(value.responses.map(item => item.host).sort(), [...HOSTS].sort());
    for (const response of value.responses) {
      assert.equal(response.status, 503); assert.match(response.responseSha256, HASH);
      assert.ok(response.checkedAt <= d.now() && d.now() - response.checkedAt < 3000);
    }
    assert.equal(value.sockets.count, 0);
    return { sampledAt, responseSha256: sha(JSON.stringify(value.responses)), socketsSha256: sha(JSON.stringify(value.sockets)) };
  }
  const seal = (name, fields) => d.seal(name, { ...expected, observedAt: d.now(), ...fields });
  const authority = (operation, phase) => seal('authority-' + operation, {
    schema: 'trace03-writer-fence-authority.v1', productionFenceApproved: true, operation,
    approvalSha256, helperSha256: approval.writerFence.helperSha256,
    issuedAt: timestamp(approval.issuedAt), expiresAt: timestamp(approval.expiresAt),
    ...(phase ? { restorePhaseApproved: true, approvedRestorePhase: phase } : {}) });
  const fenceArgs = () => ({ manifest: view, manifestSha256, io: d.fenceIO });
  async function oldWebActive() {
    const fresh = await d.inspectFence(fenceArgs()); assert.deepEqual(fresh.binding, expected);
    assertWriterFenceTarget(fresh.target, expected); return fresh;
  }
  function noForcePolicy(current, temporary) {
    requireInitialPolicy(current);
    for (const key of ['unit', 'parents', 'runtimeFiles']) assert.deepEqual(current[key], originalPolicy[key]);
    const extra = temporary.files.web, projected = Object.fromEntries(
      ['uid', 'gid', 'mode', 'nlink', 'sha256', 'bytesBase64'].map(key => [key, extra[key]]));
    assert.deepEqual(d.snapshot(extra.file), extra, 'The one Web no-force dropin changed');
    assert.deepEqual(current.loadedDropins, { ...originalPolicy.loadedDropins, [extra.file]: projected },
      'Only the exact current no-force dropin may have been added before the fence');
  }
  function checkPair(before, published, builds) {
    const current = d.control();
    const same = published ? { allowed: published.installed, guard: before.captured.guard, marker: before.captured.marker, chain: before.captured.chain } : baselineControl || before.captured;
    for (const key of ['guard', 'allowed', 'marker', 'chain']) assert.deepEqual(current[key], same[key], 'Pricing start control changed');
    if (!published) return current;
    assert.equal(published.schema, 'pricing-start-pair-published.v1'); assert.equal(published.runId, m.runId);
    assert.equal(published.manifestSha256, manifestSha256);
    const bytes = d.bytes(published.receiptFile); assert.equal(sha(bytes), published.receiptSha256);
    const saved = clone(published); delete saved.receiptFile; delete saved.receiptSha256; assert.deepEqual(JSON.parse(bytes), saved);
    const value = JSON.parse(Buffer.from(current.allowed.bytesBase64, 'base64'));
    assert.equal(value.runId, m.runId); assert.equal(value.releases.length, 2);
    for (const kind of ['main', 'guard']) {
      const release = value.releases.find(item => item.source === m[kind].source); assert.ok(release);
      assert.equal(release.root, m[kind].root); assert.equal(release.version, m[kind].version); assert.equal(release.build, builds[kind].build);
    }
    return current;
  }
  function verifyPrestart(builds, provided) {
    const saved = boundJson('actual-prestart'); delete saved.runId; delete saved.manifestSha256;
    assert.deepEqual(saved, provided); assert.equal(provided.actualExecStartPreVerified, true); assert.equal(provided.cleanServiceUser, m.appUser);
    // The real service guard follows systemctl WorkingDirectory, NOT cwd.
    // switch.actualPrestart actually configured main->guard->main. Re-read its
    // root receipt; never pretend that changing child cwd repeats those gates.
    for (const value of [provided]) {
      assert.equal(value.accepted.length, 4);
      for (const kind of ['main', 'guard']) for (const role of ['web', 'image']) {
        const matches = value.accepted.filter(item => item.service === m.live[role].unit && item.source === m[kind].source);
        assert.equal(matches.length, 1); const item = matches[0];
        assert.equal(item.build, builds[kind].build); assert.equal(item.version, m[kind].version);
        assert.equal(item.sourceAndBuildVerified, true); assert.equal(item.barrierVerified, true);
      }
      assert.deepEqual(value.rejected.map(item => item.root).sort(), rejectedPricingRoots(m));
      for (const item of value.rejected) assert.ok(item.refusalSha256 || item.refusal?.includes('legacy or unapproved program'));
    }
    return sha(d.bytes(m.stage + '/actual-prestart.json'));
  }
  async function restore(context, phase) {
    checkpoint(context, context.builds); checkBefore(context.before); noForce(); checkConfigurations(d, m, context.before, context.installed);
    let oldFields, newPairFields;
    if (phase === 'pre-stop-installation-abort') {
      assert.equal(d.exists(m.stage + '/natural-stop-intent-switch-web.json'), false);
      const active = await oldWebActive(); checkPair(context.before, null);
      oldFields = { stopRequested: false, currentTarget: active.target, originalIdentityStillActive: true, pairChanged: false };
    } else {
      checkPair(context.before, context.published, context.builds);
      const prestartSha256 = verifyPrestart(context.builds, context.prestart), currentCwd = d.snapshot(CWD);
      assert.equal(d.service('web').WorkingDirectory, m.main.root);
      assert.equal(Buffer.from(currentCwd.bytesBase64, 'base64').toString(), view.main.cwdBytes);
      const entry = Object.fromEntries(['uid', 'gid', 'mode', 'nlink', 'sha256', 'bytesBase64'].map(key => [key, currentCwd[key]]));
      oldFields = { stopRequested: true, originalProcessGone: true, oldCgroupGoneOrEmpty: true, oldCgroupPids: [],
        currentUnitInactive: true, currentMainPid: 0, noNewWriterStarted: true, allOldWritersStopped: true };
      newPairFields = { pairInstalled: true, execStartPreVerified: true, restartNoForceProtection: true, actualNewServiceHealthClaimed: false,
        prestartSha256, runtimeDropin: { kind: 'main', source: m.mainSource, root: m.main.root, path: CWD, entry } };
    }
    // Slow source/prestart work is outside the helper's fresh proof interval.
    const ingressProof = await ingress(context.installed, context.master); noForce();
    stopped(context.before, phase === 'pre-stop-installation-abort' ? ['image', 'hd'] : ROLES);
    assert.ok(d.now() - ingressProof.sampledAt < 3000);
    const oldWriterProof = seal('old-writer', oldFields);
    const newPairProof = newPairFields ? seal('new-pair', newPairFields) : undefined;
    const guardsProof = seal('guards', { ...ingressProof, ingress503: true, ingressAdmissionClosed: true, noForceStop: true,
      imageStopped: true, imagePromiseSettled: true, hdStopped: true,
      ...(phase === 'before-new-writer-after-proven-old-stop' ? { allOldWritersStopped: true, closedMode: 'all-old-writers-stopped-ingress-503' } : {}) });
    receipt = await d.restore({ ...fenceArgs(), receipt, authority: authority('restore', phase), oldWriterProof, guardsProof, newPairProof });
    assert.equal(receipt.phase, 'restored'); restored = true; record('network-restored', { restorePhase: phase, receiptSha256: receipt.receiptSha256 });
    return { restored: true, receipt };
  }
  return Object.freeze({
    protocol: 'hd-release-safety-v1',
    async inspectRecoveryFence(context) {
      recoveryCheckpoint({ ...context, recoveryRoute: context.recoveryRoute || 'original' }); checkBefore(context.before);
      if (!view) establishView(context.before, true);
      if (!d.exists(operationStage + '/writer-network-fence.v1.json')) {
        for (const file of NETWORK) assert.equal(d.exists(file), false);
        assert.deepEqual(d.network(), context.before.policies.web.network); return null;
      }
      receipt = await d.readFence(fenceArgs()); return receipt;
    },
    async restoreForRecovery(context) {
      const fixed = recoveryCheckpoint(context); checkBefore(context.before);
      if (!view) establishView(context.before, true);
      if (!d.exists(operationStage + '/writer-network-fence.v1.json')) {
        for (const file of NETWORK) assert.equal(d.exists(file), false);
        assert.deepEqual(d.network(), context.before.policies.web.network); return { restored: true, noFenceInstalled: true };
      }
      receipt = await d.readFence(fenceArgs());
      if (receipt.phase === 'restored') {
        for (const file of NETWORK) assert.equal(d.exists(file), false);
        assert.deepEqual(d.network(), context.before.policies.web.network);
        restored = true; return { restored: true, existingReceiptRetained: true, receipt };
      }
      noForce(); checkConfigurations(d, m, context.before, context.installed);
      const original = context.recoveryRoute === 'original';
      const phase = original ? 'pre-stop-installation-abort' : 'before-new-writer-after-proven-old-stop';
      let oldFields, newPairFields;
      if (original) {
        assert.equal(receipt.phase, 'failed-keep-fence');
        assert.equal(d.exists(m.stage + '/natural-stop-intent-switch-web.json'), false);
        const current = await oldWebActive(); checkPair(context.before, null);
        oldFields = { stopRequested: false, currentTarget: current.target, originalIdentityStillActive: true, pairChanged: false };
      } else {
        assert.ok(['verified', 'installed-unverified', 'installing', 'failed-keep-fence'].includes(receipt.phase));
        recoveryStopped(context.before, ROLES);
        const current = d.control();
        const omitTime = value => { const result = clone(value); delete result.at; return result; };
        assert.deepEqual(omitTime(JSON.parse(Buffer.from(current.allowed.bytesBase64, 'base64'))), omitTime(fixed.pair.allowed));
        const prestart = boundJson('guard-recovery-actual-prestart'); delete prestart.runId; delete prestart.manifestSha256;
        assert.deepEqual(prestart, context.prestart); assert.equal(prestart.schema, 'fixed-guard-recovery-prestart.v1');
        assert.equal(prestart.source, m.guardSource); assert.equal(prestart.build, fixed.guardEntry.build);
        assert.equal(prestart.accepted.length, 2);
        assert.deepEqual(prestart.accepted.map(value => value.service).sort(), ['web', 'image'].map(role => m.live[role].unit).sort());
        for (const value of prestart.accepted) {
          assert.equal(value.source, m.guardSource); assert.equal(value.build, fixed.guardEntry.build);
          assert.equal(value.sourceAndBuildVerified, true); assert.equal(value.barrierVerified, true);
        }
        const cwd = d.snapshot(CWD); assert.equal(d.service('web').WorkingDirectory, m.guard.root);
        assert.equal(Buffer.from(cwd.bytesBase64, 'base64').toString(), view.guard.cwdBytes);
        oldFields = { stopRequested: true, originalProcessGone: true, oldCgroupGoneOrEmpty: true, oldCgroupPids: [],
          currentUnitInactive: true, currentMainPid: 0, noNewWriterStarted: true, allOldWritersStopped: true };
        newPairFields = { pairInstalled: true, execStartPreVerified: true, restartNoForceProtection: true, actualNewServiceHealthClaimed: false,
          prestartSha256: sha(d.bytes(m.stage + '/guard-recovery-actual-prestart.json')),
          runtimeDropin: { kind: 'guard', source: m.guardSource, root: m.guard.root, path: CWD,
            entry: Object.fromEntries(['uid', 'gid', 'mode', 'nlink', 'sha256', 'bytesBase64'].map(key => [key, cwd[key]])) } };
      }
      const proof = await ingress(context.installed, context.master); noForce();
      recoveryStopped(context.before, original ? ['image', 'hd'] : ROLES);
      const now = d.now();
      const freshAuthority = seal('authority-restore', { schema: 'trace03-writer-fence-authority.v1', productionFenceApproved: true,
        operation: 'restore', approvalSha256: d.recoveryLockSha256(), parentApprovalSha256: approvalSha256,
        helperSha256: m.privateSha256['writer-network-fence.mjs'], issuedAt: now, expiresAt: now + 60000,
        restorePhaseApproved: true, approvedRestorePhase: phase, onlyFixedGuardOrOriginalAbort: true,
        originalBuildStartedAt: fixed.originalGuardBuild.startedAt, candidateFreshGateClaimed: false });
      const oldWriterProof = seal('old-writer', oldFields);
      const guardsProof = seal('guards', { ...proof, ingress503: true, ingressAdmissionClosed: true, noForceStop: true,
        imageStopped: true, imagePromiseSettled: true, hdStopped: true,
        ...(!original ? { allOldWritersStopped: true, closedMode: 'all-old-writers-stopped-ingress-503' } : {}) });
      const newPairProof = newPairFields ? seal('new-pair', newPairFields) : undefined;
      receipt = await d.restore({ ...fenceArgs(), receipt, authority: freshAuthority, oldWriterProof, guardsProof, newPairProof });
      assert.equal(receipt.phase, 'restored'); restored = true;
      record('fault-only-network-restored', { restorePhase: phase, receiptSha256: receipt.receiptSha256, candidateFreshGateClaimed: false });
      return { restored: true, receipt, normalPublicationNotAuthorized: true };
    },
    async beforeMaintenance(context) {
      checkpoint(context, context.builds); checkBefore(context.before); assert.equal(beforeSeen, false);
      const result = await readBeforeMaintenance(d, m, context.before, manifestSha256);
      ({ view, expected, originalPolicy, baselineControl, logStart } = result); const { parsed } = result;
      const prepared = await d.prepareProbe({ ...fenceArgs(), authority: authority('install'),
        approvedHelperSha256: approval.writerFence.helperSha256 });
      record('native-probe-prepared-before-maintenance', { path: prepared.path || null, sha256: prepared.sha256 || null });
      beforeSeen = true; record('before-maintenance', { sync: parsed, originalPolicySha256: sha(JSON.stringify(originalPolicy)),
        logBoundarySha256: sha(JSON.stringify(logStart)), unrelatedHandlerPremise: 'manual-confirmation-only-not-a-full-lifecycle-proof' });
    },
    async installFence(context) {
      assert.equal(beforeSeen, true); assert.equal(receipt, undefined); checkpoint(context); checkBefore(context.before);
      noForce(); stopped(context.before, ['image', 'hd']); checkConfigurations(d, m, context.before, context.installed); checkPair(context.before, null);
      const completed = d.completedObservation(logStart); assert.equal(completed.admittedMutations, 0); assert.equal(completed.fullLifecycleProven, false);
      const installAuthority = authority('install');
      const probeProgram = await d.prepareProbe({ ...fenceArgs(), authority: installAuthority, approvedHelperSha256: approval.writerFence.helperSha256 });
      const ingressProof = await ingress(context.installed, context.master);
      const current = await oldWebActive(); noForcePolicy(current.policy, context.temporary);
      try {
        const result = await d.lock({ manifest: m, manifestSha256, operationStage,
          assertNoSynchronousImageAdmissions: rows => {
            const parsed = parseAllOwnerSynchronousRows(rows, d.now()); assert.equal(parsed.runningRequests, 0); return parsed;
          },
          callback: async ({ lock, signal, deadlineAt }) => {
            assert.equal(signal.aborted, false); assert.deepEqual([lock.databaseIdentity.dev, lock.databaseIdentity.ino], context.before.protection.databaseIdentity);
            const parsed = parseAllOwnerSynchronousRows(lock.syncRows, d.now()); assert.equal(parsed.runningRequests, 0);
            assert.ok(d.now() - ingressProof.sampledAt < 3000, 'Ingress observation expired before the same-lock installation');
            const preconditions = seal('install-preconditions', { ...ingressProof, observedAt: ingressProof.sampledAt,
              ingressAdmissionClosed: true, ingress503: true, imageStopped: true, imagePromiseSettled: true,
              connections3302: 0, stopRequested: false, syncRowsSha256: parsed.rowsSha256,
              shortLock: { held: true, kind: 'BEGIN IMMEDIATE', syncCount: 0, watchdogMs: 20000, deadlineAt: lock.deadlineAt } });
            assert.ok(d.now() < deadlineAt);
            receipt = await d.install({ ...fenceArgs(), authority: installAuthority, preconditions, probeProgram });
            assert.equal(signal.aborted, false); assert.ok(d.now() <= deadlineAt); return receipt;
          } });
        assert.equal(result.releaseEvidence.released, true); assert.equal(receipt.phase, 'verified');
        const networkDropins = NETWORK.map(file => d.snapshot(file));
        assert.deepEqual(Object.keys(receipt.expectedRuntimeFiles).sort(), [...NETWORK].sort());
        for (const file of networkDropins) {
          assert.equal(file.uid, 0); assert.equal(file.nlink, 1);
          assert.deepEqual(Object.fromEntries(['uid', 'gid', 'mode', 'nlink', 'sha256', 'bytesBase64'].map(key => [key, file[key]])),
            receipt.expectedRuntimeFiles[file.file]);
        }
        record('fence-installed', { receiptSha256: receipt.receiptSha256, emptyLockReleased: true, completed });
        return { networkDropins, receipt };
      } catch (error) {
        try { receipt = await d.readFence(fenceArgs()); } catch {}
        installUnknown = error.evidence?.released !== true || error.evidence?.callbackTimedOut === true || receipt?.phase !== 'failed-keep-fence';
        record('install-failed-keep-fence', { phase: receipt?.phase || 'unknown', installUnknown }); throw error;
      }
    },
    async restoreBeforeStart(context) {
      assert.equal(receipt?.phase, 'verified'); assert.equal(installUnknown, false);
      return restore(context, 'before-new-writer-after-proven-old-stop');
    },
    async onFailure(context) {
      if (restored || !beforeSeen) return { action: 'keep-maintenance-no-start', phase: receipt?.phase || 'not-installed' };
      if (!receipt) { try { receipt = await d.readFence(fenceArgs()); } catch {} }
      if (installUnknown || receipt?.phase !== 'failed-keep-fence' || context.published
        || d.exists(m.stage + '/natural-stop-intent-switch-web.json')) {
        record('failure-kept-fence', { phase: receipt?.phase || 'unknown' });
        return { action: 'keep-fence-and-503-no-start', phase: receipt?.phase || 'unknown' };
      }
      return restore(context, 'pre-stop-installation-abort');
    },
    async assertRollbackAllowed(context) {
      checkpoint(context, context.builds); checkBefore(context.before);
      if (!view) establishView(context.before, true);
      const durable = await d.readFence(fenceArgs()); assert.equal(durable.phase, 'restored');
      assert.equal(durable.restorePhase, 'before-new-writer-after-proven-old-stop'); checkPair(context.before, context.published, context.builds);
      assert.equal(d.pidPresent(Number(context.before.writers.web.MainPID)), false);
      let kind;
      for (const role of ROLES) {
        const state = d.service(role); assert.equal(state.ActiveState, 'active'); assert.equal(state.SubState, 'running');
        assert.ok(Number(state.MainPID) > 1); assert.notEqual(state.MainPID, context.before.writers[role].MainPID);
        assert.notEqual(state.InvocationID, context.before.writers[role].InvocationID);
        assert.ok([m.main.root, m.guard.root].includes(state.WorkingDirectory));
        const actualKind = state.WorkingDirectory === m.main.root ? 'main' : 'guard';
        if (kind) assert.equal(actualKind, kind); kind = actualKind;
        assert.equal(d.processIdentity(Number(state.MainPID)).root, state.WorkingDirectory);
        assert.equal(d.source(state.WorkingDirectory), m[actualKind].source);
      }
      record('rollback-admitted-new-writers-only', { fenceReceiptSha256: durable.receiptSha256 });
      return { allowed: true, originalIdentityReusable: false };
    },
    evidence: () => ({ protocol: 'hd-release-safety-v1', nativeExecuted: d.kind === 'native' && events.length > 0,
      manifestSha256, approvalSha256, fenceViewSha256: expected?.fenceViewSha256 || null, phase: receipt?.phase || null,
      restored, installUnknown, events: clone(events), businessWrites: 0, providerRequests: 0 }),
  });
}
