import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ensureMaintenanceRunDirectory, exchangeOwnedPaths, fileIdentity } from './legacy-maintenance.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const realCall = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 15000,
  env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' } }).trim();
const OBSERVED = [
  { file: '/etc/nginx/sites-available/sd2.youdooart.com', sha256: '2e0265cb30a8c6f27c61ae89bc28ed654b4020c504af52e5ccc0ac4ae7a2342c',
    serverAnchor: 'server {\n  listen 443 ssl;\n  server_name sd2.youdooart.com;\n' },
  { file: '/etc/nginx/sites-available/sd2-server.youdoodesign.com', sha256: '22e6cbe85ea4be067444377770e08f094004c3f39332b1e10b31a87bb640d611',
    serverAnchor: 'server {\n  listen 80;\n  server_name sd2-server.youdoodesign.com;\n' },
];
const LOCATION = '  location / {\n    proxy_pass http://127.0.0.1:3302;';

// Explicit offline adapters exercise these same functions. There is no environment
// flag, production path override, implicit adapter or fallback to an untrusted tree.
export function createNginxMaintenanceHelper({ filesystem = fs, call = realCall,
  getuid = () => process.getuid(), platform = process.platform,
  identity = fileIdentity, exchange = exchangeOwnedPaths, ensureRunDirectory = ensureMaintenanceRunDirectory } = {}) {
const fs = filesystem;
const fileIdentity = identity, exchangeOwnedPaths = exchange, ensureMaintenanceRunDirectory = ensureRunDirectory;
function rootOnly() { assert.equal(platform, 'linux'); assert.equal(getuid(), 0); }
function syncDirectory(directory) { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function bytesUnchanged(item, installed = false) {
  assert.equal(fs.realpathSync(item.file), item.file);
  assert.equal(fs.lstatSync(item.file).nlink, 1);
  assert.deepEqual(fileIdentity(item.file), installed ? item.ownIdentity : item.identity);
  assert.equal(sha(fs.readFileSync(item.file)), installed ? item.maintainedSha256 : item.sha256);
}
function writePrivate(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}
function save(file, value) { writePrivate(file, JSON.stringify(value, null, 2) + '\n'); }
function assertCapturedScope(value) {
  assert.match(value.runId, /^[a-f0-9-]{36}$/);
  assert.equal(value.markerPath, `/data/video-api-debugger/entry-maintenance/${value.runId}/nginx.active`);
  assert.deepEqual(value.files.map(item => ({ file: item.file, sha256: item.sha256, serverAnchor: item.serverAnchor })), OBSERVED);
}

function renderObservedMaintenance(text, { runId, markerPath, serverAnchor }) {
  assert.match(runId, /^[a-f0-9-]{36}$/);
  assert.equal(markerPath, `/data/video-api-debugger/entry-maintenance/${runId}/nginx.active`);
  assert.equal(text.split(serverAnchor).length, 2, 'Exact intended server anchor must occur once');
  assert.equal(text.split(LOCATION).length, 2, 'Exact observed 3302 location must occur once');
  const serverAt = text.indexOf(serverAnchor), locationAt = text.indexOf(LOCATION);
  assert.ok(locationAt > serverAt && !text.slice(serverAt + serverAnchor.length, locationAt).includes('\nserver {'));
  const injection = `  location / {\n    # rate-impl2-maintenance ${runId}\n    if (-f ${markerPath}) { return 503; }\n    proxy_pass http://127.0.0.1:3302;`;
  return text.replace(LOCATION, injection);
}

function captureNginxMaintenance({ runId, stageRoot }) {
  rootOnly(); assert.match(runId, /^[a-f0-9-]{36}$/);
  assert.ok(stageRoot.startsWith('/data/video-api-debugger/'));
  const mount = call('findmnt', ['-n', '-o', 'TARGET', '-T', stageRoot]);
  assert.ok(mount === '/data' || mount.startsWith('/data/'));
  assert.equal(fs.realpathSync(stageRoot), stageRoot);
  const stage = fs.lstatSync(stageRoot); assert.ok(stage.isDirectory() && stage.uid === 0 && !(stage.mode & 0o077));
  const markerPath = `/data/video-api-debugger/entry-maintenance/${runId}/nginx.active`;
  const files = OBSERVED.map((observed, index) => {
    assert.equal(fs.realpathSync(observed.file), observed.file);
    const identity = fileIdentity(observed.file); assert.equal(identity.kind, 'file');
    assert.equal(fs.lstatSync(observed.file).nlink, 1);
    const bytes = fs.readFileSync(observed.file); assert.equal(sha(bytes), observed.sha256, 'Observed nginx grammar changed; recapture and review');
    const maintained = renderObservedMaintenance(bytes.toString('utf8'), { runId, markerPath, serverAnchor: observed.serverAnchor });
    const backup = path.join(stageRoot, `nginx-${runId}-${index}.original`);
    writePrivate(backup, bytes);
    return { ...observed, identity, backup, maintained, maintainedSha256: sha(maintained),
      swapPath: path.join(path.dirname(observed.file), `.rate-impl2-${runId}-${index}.swap`) };
  });
  const result = { schema: 'rate-impl2-nginx-maintenance-capture.v1', runId, stageRoot, markerPath, capturedAt: Date.now(), files };
  save(path.join(stageRoot, `nginx-${runId}-captured.json`), result); return result;
}

function installNginxMaintenance({ captured }) {
  rootOnly(); assertCapturedScope(captured); ensureMaintenanceRunDirectory(captured.runId);
  for (const item of captured.files) bytesUnchanged(item);
  const markerBytes = `rate-impl2 nginx entry maintenance ${captured.runId}\n`;
  const markerFd = fs.openSync(captured.markerPath, 'wx', 0o600);
  try { fs.writeFileSync(markerFd, markerBytes); fs.fsyncSync(markerFd); } finally { fs.closeSync(markerFd); }
  syncDirectory(path.dirname(captured.markerPath));
  const markerIdentity = fileIdentity(captured.markerPath), markerSha256 = sha(markerBytes), installed = [], prepared = [];
  try {
  for (const item of captured.files) {
    bytesUnchanged(item);
    const fd = fs.openSync(item.swapPath, 'wx', item.identity.mode);
    try { fs.writeFileSync(fd, item.maintained); fs.fchownSync(fd, item.identity.uid, item.identity.gid);
      fs.fchmodSync(fd, item.identity.mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const ownIdentity = fileIdentity(item.swapPath); bytesUnchanged(item);
    const written = { ...item, ownIdentity }; prepared.push(written);
    save(path.join(captured.stageRoot, `nginx-${captured.runId}-install-prepared-${prepared.length}.json`),
      { ...captured, markerIdentity, markerSha256, files: prepared });
    exchangeOwnedPaths(item.file, item.swapPath);
    bytesUnchanged(written, true); assert.deepEqual(fileIdentity(item.swapPath), item.identity);
    assert.equal(sha(fs.readFileSync(item.swapPath)), item.sha256); installed.push(written);
    save(path.join(captured.stageRoot, `nginx-${captured.runId}-install-progress-${installed.length}.json`),
      { ...captured, markerIdentity, markerSha256, files: installed });
  }
  call('nginx', ['-t']); call('systemctl', ['reload', 'nginx']);
  const result = { ...captured, schema: 'rate-impl2-nginx-maintenance-installed.v1', markerIdentity, markerSha256,
    installedAt: Date.now(), files: installed, targetUpstreamPort: 3302 };
  save(path.join(captured.stageRoot, `nginx-${captured.runId}-installed.json`), result); return result;
  } catch (cause) {
    const partial = { ...captured, markerIdentity, markerSha256, files: prepared };
    try {
      assert.deepEqual(fileIdentity(captured.markerPath), markerIdentity);
      assert.equal(sha(fs.readFileSync(captured.markerPath)), markerSha256);
      for (const item of prepared) {
        const current = fileIdentity(item.file);
        if (JSON.stringify(current) === JSON.stringify(item.identity)) { bytesUnchanged(item); continue; }
        bytesUnchanged(item, true); assert.deepEqual(fileIdentity(item.swapPath), item.identity);
        assert.equal(sha(fs.readFileSync(item.swapPath)), item.sha256);
        exchangeOwnedPaths(item.file, item.swapPath); bytesUnchanged(item);
      }
      for (const item of captured.files) bytesUnchanged(item);
      call('nginx', ['-t']); call('systemctl', ['reload', 'nginx']);
      save(path.join(captured.stageRoot, `nginx-${captured.runId}-installation-aborted.json`),
        { runId: captured.runId, at: Date.now(), exactOriginalBytesRestored: true, reloadCommandSucceeded: true,
          runtimeRestorationVerified: false, markerRetained: true });
    } catch (recovery) {
      throw Object.assign(new AggregateError([cause, recovery], 'Maintenance installation and exact-file restoration both failed', { cause }),
        { partialMaintenanceInstallation: partial });
    }
    throw Object.assign(cause, { maintenanceInstallationAborted: true, partialMaintenanceInstallation: partial });
  }
}

async function restoreNginxMaintenance({ installed, healthyConsumers, observeRestored, observeMaintenance, nginxMaster }) {
  rootOnly(); assertCapturedScope(installed); assert.equal(healthyConsumers?.runId, installed.runId);
  assert.ok(['main', 'guard'].includes(healthyConsumers.kind));
  assert.equal(healthyConsumers.actualHealthy, true);
  assert.equal(healthyConsumers.readabilityMode, 'normal', 'Both RATE programs must be complete normal readers');
  assert.match(healthyConsumers.source, /^[a-f0-9]{40}$/);
  assert.ok(typeof healthyConsumers.build === 'string' && healthyConsumers.build.length > 0);
  assert.match(healthyConsumers.releaseVersion, /^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/);
  assert.match(healthyConsumers.evidenceSha256, /^[a-f0-9]{64}$/);
  assert.equal(typeof observeRestored, 'function', 'Restoration must observe both actual public host release responses');
  assert.deepEqual(fileIdentity(installed.markerPath), installed.markerIdentity);
  assert.equal(sha(fs.readFileSync(installed.markerPath)), installed.markerSha256);
  for (const item of installed.files) {
    bytesUnchanged(item, true); assert.deepEqual(fileIdentity(item.swapPath), item.identity);
    assert.equal(sha(fs.readFileSync(item.swapPath)), item.sha256);
  }
  try {
    for (const item of installed.files) {
      bytesUnchanged(item, true); exchangeOwnedPaths(item.file, item.swapPath); bytesUnchanged(item);
      assert.deepEqual(fileIdentity(item.swapPath), item.ownIdentity);
    }
    call('nginx', ['-t']); call('systemctl', ['reload', 'nginx']);
    const reloadedAt = Date.now();
    const responseEvidence = await observeRestored({ runId: installed.runId, kind: healthyConsumers.kind,
      source: healthyConsumers.source, build: healthyConsumers.build, releaseVersion: healthyConsumers.releaseVersion });
    assert.ok(Array.isArray(responseEvidence) && responseEvidence.length === 2);
    assert.deepEqual(responseEvidence.map(item => item.host).sort(), ['sd2-server.youdoodesign.com', 'sd2.youdooart.com'].sort());
    for (const response of responseEvidence) {
      assert.equal(response.status, 200, 'Original service release route must be reachable, not only non-503');
      assert.equal(response.source, healthyConsumers.source); assert.equal(response.build, healthyConsumers.build);
      assert.equal(response.releaseVersion, healthyConsumers.releaseVersion);
      assert.ok(Number.isSafeInteger(response.checkedAt) && response.checkedAt >= reloadedAt
        && response.checkedAt <= Date.now() && Date.now() - response.checkedAt < 30000);
      assert.match(response.evidenceSha256, /^[a-f0-9]{64}$/);
      assert.equal(response.sourceEvidence, 'actual-running-unit-and-public-compiled-bytes');
      assert.equal(response.runtime?.source, response.source); assert.equal(response.runtime.build, response.build);
      assert.ok(Number.isSafeInteger(response.runtime.pid) && response.runtime.pid > 1);
      assert.match(response.runtime.invocation, /^[a-f0-9]{32}$/);
      assert.ok(Array.isArray(response.assets) && response.assets.length > 0);
      for (const asset of response.assets) {
        assert.match(asset.path, /^\/_next\/static\//); assert.equal(asset.status, 200);
        assert.match(asset.expectedSha256, /^[a-f0-9]{64}$/); assert.equal(asset.responseSha256, asset.expectedSha256);
      }
    }
    for (const item of installed.files) bytesUnchanged(item);
    const result = { schema: 'rate-impl2-nginx-maintenance-restored.v1', runId: installed.runId, restoredAt: Date.now(),
      exactOriginalBytesRestored: true, reloadCommandSucceeded: true, runtimeRestorationVerified: true,
      runningKind: healthyConsumers.kind, readabilityMode: healthyConsumers.readabilityMode,
      responseEvidence, workerEvidence: null, markerRetained: true,
      markerRetentionProvesMaintenance: false };
    save(path.join(installed.stageRoot, `nginx-${installed.runId}-restored-${result.restoredAt}.json`), result); return result;
  } catch (cause) {
    // One bounded correction, only on the exact two objects owned by this run.
    let rearm;
    try { rearm = await rearmOwnedNginxMaintenance({ installed, observeMaintenance, nginxMaster }); }
    catch (error) { rearm = { attempted: true, status: 'unknown', error: String(error), responseEvidence: null,
      workerEvidence: null, markerRetentionProvesMaintenance: false }; }
    const report = { schema: 'rate-impl2-nginx-maintenance-restore-failure.v1', runId: installed.runId,
      at: Date.now(), completed: false, error: String(cause), rearm };
    save(path.join(installed.stageRoot, `nginx-${installed.runId}-restore-failed-${report.at}.json`), report);
    throw Object.assign(new Error('nginx restoration did not complete; inspect the bounded rearm receipt before proceeding', { cause }),
      { maintenanceRearm: rearm });
  }
}

async function rearmOwnedNginxMaintenance({ installed, observeMaintenance, nginxMaster }) {
  rootOnly(); assertCapturedScope(installed);
  assert.deepEqual(fileIdentity(installed.markerPath), installed.markerIdentity);
  assert.equal(sha(fs.readFileSync(installed.markerPath)), installed.markerSha256);
  const states = installed.files.map(item => {
    const current = fileIdentity(item.file), bytes = sha(fs.readFileSync(item.file));
    if (bytes === item.maintainedSha256 && JSON.stringify(current) === JSON.stringify(item.ownIdentity)) {
      assert.deepEqual(fileIdentity(item.swapPath), item.identity); assert.equal(sha(fs.readFileSync(item.swapPath)), item.sha256);
      return { item, restored: false };
    }
    assert.deepEqual(current, item.identity, 'Another writer changed a config; do not overwrite it');
    assert.equal(bytes, item.sha256); assert.deepEqual(fileIdentity(item.swapPath), item.ownIdentity);
    assert.equal(sha(fs.readFileSync(item.swapPath)), item.maintainedSha256);
    return { item, restored: true };
  });
  for (const { item, restored } of states) {
    if (restored) {
      bytesUnchanged(item); assert.deepEqual(fileIdentity(item.swapPath), item.ownIdentity);
      assert.equal(sha(fs.readFileSync(item.swapPath)), item.maintainedSha256);
      exchangeOwnedPaths(item.file, item.swapPath);
    }
    bytesUnchanged(item, true); assert.deepEqual(fileIdentity(item.swapPath), item.identity);
    assert.equal(sha(fs.readFileSync(item.swapPath)), item.sha256);
  }
  call('nginx', ['-t']); call('systemctl', ['reload', 'nginx']);
  const reloadedAt = Date.now();
  let responseEvidence = null, workerEvidence = null, observationError = null;
  if (observeMaintenance) {
    try {
      const observed = await observeMaintenance({ runId: installed.runId, markerPath: installed.markerPath });
      assert.ok(Array.isArray(observed) && observed.length === 2);
      assert.deepEqual(observed.map(item => item.host).sort(), ['sd2-server.youdoodesign.com', 'sd2.youdooart.com'].sort());
      for (const response of observed) {
        assert.equal(response.status, 503);
        assert.ok(Number.isSafeInteger(response.checkedAt) && response.checkedAt >= reloadedAt
          && response.checkedAt <= Date.now() && Date.now() - response.checkedAt < 30000);
      }
      responseEvidence = observed;
    } catch (error) { observationError = String(error); }
  }
  if (nginxMaster) {
    try { workerEvidence = captureNginxUpstreamSockets({ ...nginxMaster, upstreamPort: 3302 }); }
    catch (error) { observationError = [observationError, String(error)].filter(Boolean).join('; '); }
  }
  for (const item of installed.files) bytesUnchanged(item, true);
  const result = { schema: 'rate-impl2-nginx-maintenance-rearm.v1', runId: installed.runId, attempted: true,
    at: Date.now(), conditionalDiskObjectsVerified: true, reloadCommandSucceeded: true,
    status: responseEvidence ? workerEvidence ? 'responses-and-workers-observed' : 'responses-observed-workers-unknown' : 'runtime-maintenance-unknown',
    responseEvidence, workerEvidence, observationError, markerRetentionProvesMaintenance: false,
    oldWebTargetSocketsDrained: Boolean(responseEvidence && workerEvidence?.count === 0),
    oldWriterDrainVerified: false, requiresOriginalPromiseAndCgroupProof: true };
  save(path.join(installed.stageRoot, `nginx-${installed.runId}-rearm-${result.at}.json`), result); return result;
}

/** Count only sockets owned by this nginx master/its workers targeting old Web. */
function captureNginxUpstreamSockets({ masterPid, masterStart, upstreamPort = 3302 }) {
  assert.equal(platform, 'linux'); assert.ok(Number.isSafeInteger(masterPid) && masterPid > 1);
  assert.ok(Number.isSafeInteger(upstreamPort) && upstreamPort > 0 && upstreamPort <= 65535);
  const stat = fs.readFileSync(`/proc/${masterPid}/stat`, 'utf8');
  assert.equal(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], String(masterStart));
  const workers = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
    try { const text = fs.readFileSync(`/proc/${name}/stat`, 'utf8'), fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
      return Number(name) === masterPid || Number(fields[1]) === masterPid ? [Number(name)] : []; }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return []; throw error; }
  });
  const owned = new Map();
  for (const pid of workers) {
    let fds;
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
    for (const fd of fds) {
      try { const match = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (match) owned.set(match[1], pid); } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
  }
  const connections = [];
  for (const table of ['tcp', 'tcp6']) for (const line of fs.readFileSync(`/proc/${masterPid}/net/${table}`, 'utf8').trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/), remotePort = Number.parseInt(fields[2].split(':')[1], 16);
    if (remotePort === upstreamPort && owned.has(fields[9])) connections.push({ pid: owned.get(fields[9]), inode: fields[9],
      state: fields[3], local: fields[1], remote: fields[2] });
  }
  const confirmed = fs.readFileSync(`/proc/${masterPid}/stat`, 'utf8');
  assert.equal(confirmed.slice(confirmed.lastIndexOf(')') + 2).split(' ')[19], String(masterStart));
  return { masterPid, masterStart, upstreamPort, at: Date.now(), connections, count: connections.length,
    criterion: 'old-target-nginx-owned-sockets-only', allWorkersExitRequired: false };
}
return { renderObservedMaintenance, captureNginxMaintenance, installNginxMaintenance,
  restoreNginxMaintenance, rearmOwnedNginxMaintenance, captureNginxUpstreamSockets };
}
const production = createNginxMaintenanceHelper();
export const renderObservedMaintenance = production.renderObservedMaintenance;
export const captureNginxMaintenance = production.captureNginxMaintenance;
export const installNginxMaintenance = production.installNginxMaintenance;
export const restoreNginxMaintenance = production.restoreNginxMaintenance;
export const rearmOwnedNginxMaintenance = production.rearmOwnedNginxMaintenance;
export const captureNginxUpstreamSockets = production.captureNginxUpstreamSockets;

