import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import bridges from './seamless-bridges.mjs';
import { DEFAULT_DELIVERY, SEAMLESS_CONTROL, SEAMLESS_STATIC, digest, assertSeamlessCompatible } from './seamless-policy.mjs';
import { verifyFixedProgramEntry, PRICING_START_GUARD_SHA256 } from './pricing-start-pair.mjs';
import { parseAllOwnerSynchronousRows } from './cutover-safety.mjs';

export const PROJECT = '/data/video-api-debugger';
export const WEB_UNITS = ['sd2-gray', 'sd2-image-studio', 'sd2-hd-derivatives', 'sd2-multiview-works',
  'sd2-role-coordinator', 'sd2-template-prompts', 'sd2-periodic-credits'];
export const AUX_UNITS = ['sd2-backup', 'sd2-credit-delivery', 'sd2-feedback-delivery', 'sd2-video-delivery', 'sd2-finalize-pending'];
export const TIMERS = ['sd2-backup', 'sd2-credit-delivery', 'sd2-feedback-delivery', 'sd2-video-delivery'];
export const SITES = ['/etc/nginx/sites-available/sd2.youdooart.com', '/etc/nginx/sites-available/sd2-server.youdoodesign.com'];
const PRIVATE = '/etc/video-api-debugger/private-prompts';
const CONTROLS = ['pricing-writer-v1', 'usage-role-writer-v1', 'multiview-works-v1'];
const CLEAN = { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
export const nativeCall = (bin, args, options = {}) => execFileSync(bin, args, { encoding: 'utf8',
  timeout: 30000, maxBuffer: 64 * 1024 * 1024, env: CLEAN, ...options }).trim();
export function rootBytes(file) {
  assert.equal(fs.realpathSync(file), file);
  const s = fs.lstatSync(file); assert.ok(s.isFile() && s.uid === 0 && !(s.mode & 0o022) && s.nlink === 1);
  return fs.readFileSync(file);
}
const json = file => JSON.parse(rootBytes(file));
function mkdir(file, mode = 0o700, gid = 0) {
  if (!fs.existsSync(file)) { fs.mkdirSync(file, { mode }); fs.chownSync(file, 0, gid); }
  const s = fs.lstatSync(file); assert.ok(s.isDirectory() && s.uid === 0 && !(s.mode & 0o022));
  assert.equal(fs.realpathSync(file), file);
}
export function writeExclusive(file, bytes, mode = 0o600, gid = 0) {
  const fd = fs.openSync(file, 'wx', mode);
  try { fs.writeFileSync(fd, bytes); fs.fchownSync(fd, 0, gid); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const d = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
}
function ensure(file, bytes, mode = 0o600, gid = 0) {
  if (fs.existsSync(file)) assert.deepEqual(rootBytes(file), Buffer.from(bytes)); else writeExclusive(file, bytes, mode, gid);
}
function replace(file, expected, bytes) {
  assert.deepEqual(rootBytes(file), Buffer.from(expected), 'Configuration changed independently: ' + file);
  if (Buffer.from(expected).equals(Buffer.from(bytes))) return;
  const s = fs.lstatSync(file), temporary = file + '.seamless-' + randomUUID();
  writeExclusive(temporary, bytes, s.mode & 0o777, s.gid); fs.renameSync(temporary, file);
  const d = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
}
const properties = unit => Object.fromEntries(nativeCall('/usr/bin/systemctl', ['show', unit,
  ...['MainPID', 'ControlPID', 'ActiveState', 'WorkingDirectory', 'ControlGroup', 'InvocationID', 'SubState',
    'Restart', 'SendSIGKILL', 'TimeoutStopUSec', 'KillSignal', 'Delegate'].flatMap(f => ['-p', f])])
  .split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
export function processIdentity(pid) {
  assert.ok(Number.isSafeInteger(Number(pid)) && Number(pid) > 1);
  const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'), a = s.slice(s.lastIndexOf(')') + 2).split(/\s+/);
  assert.ok(!['Z', 'X', 'x'].includes(a[0]));
  return { pid: Number(pid), startTicks: a[19], parent: Number(a[1]),
    root: fs.realpathSync('/proc/' + pid + '/cwd'), cgroup: /^0::([^\n]+)$/m.exec(fs.readFileSync('/proc/' + pid + '/cgroup', 'utf8'))?.[1] };
}
function stillSame(p) {
  try { return processIdentity(p.pid).startTicks === p.startTicks; }
  catch (e) { if (e.code === 'ENOENT' || e.code === 'ESRCH') return false; throw e; }
}
function groupPids(group) {
  assert.ok(group.startsWith('/system.slice/') && !group.split('/').includes('..'));
  const root = '/sys/fs/cgroup' + group; if (!fs.existsSync(root)) return [];
  const result = fs.readFileSync(root + '/cgroup.procs', 'utf8').trim().split(/\s+/).filter(Boolean);
  for (const item of fs.readdirSync(root, { withFileTypes: true })) if (item.isDirectory()) {
    result.push(...groupPids(group + '/' + item.name));
  }
  return result;
}
function nginxWorkers() {
  const master = properties('nginx.service').MainPID, pids = nativeCall('/usr/bin/pgrep', ['-P', master]).split(/\s+/).filter(Boolean);
  return pids.filter(pid => fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').includes('nginx: worker process')).map(processIdentity);
}
export function findOldRootProcesses(root, io = fs) {
  const found = [];
  for (const name of io.readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
    try { if (io.realpathSync('/proc/' + name + '/cwd') === root) found.push(Number(name)); }
    catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code)) throw e; }
  }
  return found;
}

export function renderRoute(text, port) {
  assert.ok([3302, 3303, 3304].includes(port));
  const matches = text.match(/proxy_pass http:\/\/127\.0\.0\.1:330[234];/g) || [];
  assert.equal(matches.length, 1, 'One recognized SD2 upstream is required');
  assert.ok(!/return\s+503\s*;/.test(text), 'Do not publish through an active maintenance gate');
  return text.replace(/proxy_pass http:\/\/127\.0\.0\.1:330[234];/, `proxy_pass http://127.0.0.1:${port};`);
}
export function renderRetainedStaticLocation(root = SEAMLESS_STATIC) {
  assert.ok(path.isAbsolute(root) && path.resolve(root) === root && !/[\s;{}]/.test(root));
  // expires adds cache headers without replacing inherited origin/security
  // add_header directives from either existing SD2 server block.
  return `location ^~ /_next/static/ {\n  alias ${root}/;\n  expires 1y;\n}\n`;
}
export function renderShadowUnit(text, { root, guard, authority, kind, runId, policy, policySha = '' }) {
  assert.ok(['main', 'image', 'guard'].includes(kind)); let barrier = 0, start = 0;
  const proofEnv = ['SD2_SEAMLESS_RUN_ID', 'PRIVATE_PROMPTS_RUNTIME_REVISION', 'PRIVATE_PROMPTS_POLICY_FILE',
    'PRIVATE_PROMPTS_CONSUMER_ID', 'SD2_SEAMLESS_POLICY_SHA256'].map(name => name + '=${' + name + '}').join(' ');
  const lines = text.split('\n').map(line => {
    if (kind !== 'image' && line.startsWith('ExecStart=') && line !== 'ExecStart=') {
      assert.equal(line, 'ExecStart=/usr/bin/npm run start -- --hostname 127.0.0.1 --port 3302'); start++;
      return line.replace('--port 3302', '--port ' + (kind === 'guard' ? 3304 : 3303));
    }
    if (line.startsWith('ExecStartPre=') && line.includes('/pricing-writer-v1/writer-start-guard.mjs')) {
      assert.equal(line, 'ExecStartPre=/usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/node /data/video-api-debugger/controls/pricing-writer-v1/writer-start-guard.mjs %n');
      barrier++; return `ExecStartPre=/usr/bin/env -i PATH=/usr/bin:/bin ${proofEnv} /usr/bin/node ${guard} ${authority} %n`;
    }
    return line;
  });
  assert.equal(barrier, 1); if (kind !== 'image') assert.ok(start > 0);
  return lines.join('\n') + `\n[Service]\nWorkingDirectory=${root}\nEnvironment=PRIVATE_PROMPTS_RUNTIME_REVISION=${path.basename(root)}\nEnvironment=PRIVATE_PROMPTS_POLICY_FILE=${policy}\nEnvironment=PRIVATE_PROMPTS_CONSUMER_ID=${kind === 'image' ? 'image-worker' : kind === 'guard' ? 'guard' : 'web'}\nEnvironment=SD2_SEAMLESS_RUN_ID=${runId}\nEnvironment=SD2_SEAMLESS_POLICY_SHA256=${policySha}\nRestart=no\nKillSignal=SIGTERM\nKillMode=control-group\nSendSIGKILL=no\nTimeoutStopSec=infinity\n`;
}

export const RUNTIME_ROWS_READER = `import json,sqlite3,sys,os
p=sys.argv[1];s=os.stat(p)
with sqlite3.connect('file:'+p+'?mode=ro',uri=True,timeout=2) as c:
 c.execute('PRAGMA query_only=ON');c.execute('BEGIN')
 rows=[dict(key=r[0],value_json=r[1]) for r in c.execute("SELECT key,value_json FROM PlatformSetting WHERE key GLOB 'image_sync_request_v1:*' AND CASE WHEN json_valid(value_json) THEN coalesce(json_extract(value_json,'$.status') NOT IN ('succeeded','failed','accepted_unknown'),1) ELSE 1 END ORDER BY key")]
 for r in list(rows):
  k='image_sync_process_v1:'+r['key'][22:]
  m=c.execute('SELECT key,value_json FROM PlatformSetting WHERE key=?',(k,)).fetchone()
  if m:rows.append(dict(key=m[0],value_json=m[1]))
 rows.extend(dict(key=r[0],value_json=r[1]) for r in c.execute('SELECT key,value_json FROM PlatformSetting WHERE key IN (?,?)',('pricing_worker_capability_v1:image','pricing_worker_capability_v1:image:'+sys.argv[2])))
 c.rollback()
a=os.stat(p);assert(s.st_dev,s.st_ino)==(a.st_dev,a.st_ino)
print(json.dumps(dict(identity=[str(a.st_dev),str(a.st_ino)],rows=rows)))`;
export function readRuntimeRows(plan) {
  const v = JSON.parse(nativeCall('/usr/bin/python3', ['-I', '-c', RUNTIME_ROWS_READER, plan.database.file, plan.main.source]));
  assert.deepEqual(v.identity, plan.database.identity); return v.rows;
}
// Unknown, stale or legacy provenance is never evidence of a new process.
export function classifySynchronousRows(rows, plan, inspect = processIdentity) {
  const requests = rows.filter(r => r.key.startsWith('image_sync_request_v1:'));
  parseAllOwnerSynchronousRows(requests);
  const metadata = new Map(rows.filter(r => r.key.startsWith('image_sync_process_v1:')).map(r => [r.key, r.value_json]));
  let old = 0, candidate = 0, unconfirmed = 0;
  for (const row of requests) {
    let v; try { v = JSON.parse(row.value_json); } catch { throw new Error('Synchronous admission content is unconfirmed'); }
    assert.equal(v.schema, 'image.sync-admission.v1');
    assert.equal(row.key, 'image_sync_request_v1:' + v.ownerId + ':' + v.requestId);
    assert.ok(['running', 'succeeded', 'failed', 'accepted_unknown'].includes(v.status));
    assert.ok(Number.isSafeInteger(v.count) && v.count >= 1 && v.count <= 8);
    if (v.status !== 'running') continue;
    let current = false, declaredCandidate = false;
    try {
      const p = JSON.parse(metadata.get('image_sync_process_v1:' + v.ownerId + ':' + v.requestId) || 'null');
      if (p?.schema === 'image.sync-process.v1' && p.runId === plan.runId && p.fingerprint === v.fingerprint
        && p.source === plan.main.source && p.root === plan.main.root
        && p.cgroup === '/system.slice/sd2-release-main-' + plan.runId + '.service') {
        declaredCandidate = true;
        const a = inspect(p.pid); current = a.startTicks === p.startTicks && a.root === p.root && a.cgroup === p.cgroup;
      }
    } catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code) && !(e instanceof SyntaxError)) throw e; }
    if (current) candidate += v.count; else old += v.count;
    if (declaredCandidate && !current) unconfirmed += v.count;
  }
  return { oldRunningImages: old, candidateRunningImages: candidate, unconfirmedCandidateRunningImages: unconfirmed };
}

export function readCurrentBuildEvidence(file, { read = rootBytes, now = Date.now, verify = verifyFixedProgramEntry } = {}) {
  const load = input => JSON.parse(read(input)), proof = load(file), stage = path.dirname(file);
  assert.equal(path.basename(file), 'main-build-success.json'); assert.equal(proof.kind, 'main');
  assert.equal(proof.stagingRoot, stage); assert.ok(stage.startsWith(PROJECT + '/release-staging/'));
  for (const flag of ['fullNextBuildPassed', 'fullTypeAndLintIncluded', 'isolatedBuildDatabase']) assert.equal(proof[flag], true);
  assert.equal(proof.deployed, false);
  const finished = Date.parse(proof.completedAt); assert.ok(finished <= now() && now() - finished < 1800000, 'Current candidate needs a fresh full build; use an immutable original capsule for exact reuse');
  for (const [key, suffix] of [['sourceManifestSha256', 'source.json'], ['nextBuildLogSha256', 'next-build.log'],
    ['completeTypesLogSha256', 'complete-types.log'], ['pricingPreparedSha256', 'pricing-prepared.json'],
    ['nextProcessReceiptSha256', 'next-process.json'], ['typesProcessReceiptSha256', 'types-process.json']]) {
    assert.equal(digest(read(stage + '/main-' + suffix)), proof[key]);
  }
  for (const kind of ['next', 'types']) {
    const process = load(stage + '/main-' + kind + '-process.json'); assert.equal(process.source, proof.source);
    assert.equal(process.exitCode, 0); assert.equal(process.signal, null); assert.equal(process.error, null);
    assert.ok(Date.parse(process.startedAt) <= Date.parse(process.finishedAt) && Date.parse(process.finishedAt) <= finished);
  }
  const prepared = load(stage + '/main-pricing-prepared.json'); assert.equal(prepared.source, proof.source);
  for (const flag of ['nativePrebuildPassed', 'freshPricingPassed']) assert.equal(prepared[flag], true);
  const native = load(prepared.nativeEvidence.receipt); assert.equal(digest(read(prepared.nativeEvidence.receipt)), prepared.nativeEvidence.receiptSha256);
  assert.equal(native.source, proof.source);
  assert.ok(native.passed === true && native.completeMatrix === true && native.runtimeCompatibilityDeltaVerified === true);
  assert.equal(native.productionWrites, 0); assert.equal(native.paidRequests, 0); assert.equal(native.browserRuns, 0);
  const entry = load(stage + '/prepared-pricing-writer-v1.json').releases[0];
  for (const key of ['source', 'version', 'build']) assert.equal(entry[key], proof[key]);
  const manifest = load(stage + '/main-source.json'); assert.equal(manifest.source, entry.source);
  assert.deepEqual(entry.sourceFiles, manifest.files);
  verify(entry); return entry;
}

function mainEntryFromCapsule(file) {
  if (path.basename(file) === 'main-build-success.json') return readCurrentBuildEvidence(file);
  const capsule = json(file), original = capsule.originalReceipt;
  assert.equal(capsule.schema, 'sd2-immutable-successful-build.v1'); assert.equal(capsule.kind, 'main');
  assert.equal(capsule.originallyVerifiedWithinThirtyMinuteGate, true);
  assert.equal(capsule.originalTimesChanged, false); assert.equal(capsule.newCompilationClaimed, false);
  assert.equal(original.exitCode, 0); assert.equal(original.verifiedSourceAndGates, true);
  assert.equal(digest(rootBytes(capsule.originalReceiptFile)), capsule.originalReceiptSha256);
  assert.deepEqual(json(capsule.originalReceiptFile), original);
  assert.match(nativeCall('/usr/bin/lsattr', ['-d', '--', file]).split(/\s+/)[0], /i/);
  const root = PROJECT + '/managed-releases/' + original.source;
  const entry = { root, source: original.source, version: original.version, build: original.build,
    sourceFiles: Object.fromEntries(Object.entries(capsule.snapshot.sourceFiles).map(([name, value]) => [name, value.sha256])),
    buildFiles: Object.fromEntries(Object.entries(capsule.snapshot.build).filter(([,v]) => v.sha256).map(([name, value]) => [name, value.sha256])) };
  verifyFixedProgramEntry(entry);
  // Keep the original full build and input seal; no retiming or new gate claim.
  for (const [base, records] of [[root + '/node_modules', capsule.snapshot.dependencies], [root + '/.role-tests', capsule.snapshot.checks]]) {
    for (const [relative, expected] of Object.entries(records)) {
      const target = path.join(base, relative), s = fs.lstatSync(target);
      for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(s[key], expected[key], 'Sealed build input changed');
      if (expected.sha256) assert.equal(digest(fs.readFileSync(target)), expected.sha256);
      if (expected.link) assert.equal(fs.readlinkSync(target), expected.link);
    }
  }
  assert.equal(digest(fs.readFileSync(capsule.snapshot.node.path)), capsule.snapshot.node.sha256);
  const unchanged = (file, expected) => {
    const actual = fs.lstatSync(file);
    for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(actual[key], expected[key], 'Original build input identity changed');
    if (expected.link) assert.equal(fs.readlinkSync(file), expected.link);
    if (expected.sha256) assert.equal(digest(fs.readFileSync(file)), expected.sha256);
  };
  unchanged(capsule.snapshot.node.path, capsule.snapshot.node);
  for (const [alias, expected] of Object.entries(capsule.snapshot.bindings)) unchanged(root + '/' + alias, expected);
  unchanged(fs.realpathSync(root + '/.env'), capsule.snapshot.env);
  return entry;
}

export function prepareSeamlessPlan(capsuleFile) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const main = mainEntryFromCapsule(capsuleFile), pricingFile = PROJECT + '/controls/pricing-writer-v1/allowed.json';
  const allowedBytes = rootBytes(pricingFile), previous = JSON.parse(allowedBytes);
  assert.equal(previous.schema, 'pricing-writer-start-allowlist.v1'); assert.equal(previous.releases.length, 2);
  for (const e of previous.releases) verifyFixedProgramEntry(e);
  const guard = previous.releases[1], old = previous.releases[0];
  const admission = assertSeamlessCompatible(previous, main, guard, f => fs.readFileSync(f), bridges);
  assert.equal(digest(rootBytes(PROJECT + '/controls/pricing-writer-v1/writer-start-guard.mjs')), PRICING_START_GUARD_SHA256);
  const markerFile = fs.realpathSync(old.root + '/storage/image-studio-drain'); assert.equal(previous.marker, markerFile);
  assert.match(nativeCall('/usr/bin/lsattr', ['-d', '--', markerFile]).split(/\s+/)[0], /i/);
  for (const alias of ['.env', 'storage', 'public/uploads', 'public/videos']) assert.equal(fs.realpathSync(main.root + '/' + alias), fs.realpathSync(old.root + '/' + alias));
  const units = Object.fromEntries([...WEB_UNITS, ...AUX_UNITS].map(name => {
    const file = '/etc/systemd/system/' + name + '.service.d/zzzzzzzzzzzz-upload-recovery.conf';
    const bytes = rootBytes(file), actual = properties(name + '.service');
    assert.equal(actual.WorkingDirectory, old.root, 'Effective service root differs: ' + name);
    assert.ok(bytes.toString().includes('WorkingDirectory=' + old.root));
    return [name, { file, bytesBase64: bytes.toString('base64'), properties: actual,
      ...(['sd2-gray', 'sd2-image-studio'].includes(name) ? { definition: nativeCall('/usr/bin/systemctl', ['cat', name + '.service']) } : {}) }];
  }));
  const sites = SITES.map(file => ({ file, bytesBase64: rootBytes(file).toString('base64') }));
  for (const s of sites) assert.ok(renderRoute(Buffer.from(s.bytesBase64, 'base64').toString(), 3302).includes(':3302;'));
  const controls = Object.fromEntries(CONTROLS.map(name => [name, rootBytes(PROJECT + '/controls/' + name + '/allowed.json').toString('base64')]));
  const privateFiles = Object.fromEntries(['policy-active.json', 'consumers-active.json', 'backup-proof.json'].map(n => [PRIVATE + '/' + n, rootBytes(PRIVATE + '/' + n).toString('base64')]));
  const db = PROJECT + '/var-lib/dev.db', s = fs.lstatSync(db); assert.ok(s.isFile()); assert.equal(fs.realpathSync(db), db);
  const runId = randomUUID(), stage = PROJECT + '/release-staging/' + runId; mkdir(stage);
  const plan = { schema: 'sd2-seamless-plan.v1', runId, stage, delivery: DEFAULT_DELIVERY, main, guard, previous,
    admission, units, sites, controls, privateFiles, marker: { file: markerFile, sha256: digest(rootBytes(markerFile)) },
    database: { file: db, identity: [String(s.dev), String(s.ino)] }, pricingSha256: digest(allowedBytes),
    capsuleFile, capsuleSha256: digest(rootBytes(capsuleFile)), timers: Object.fromEntries(TIMERS.map(n => [n, properties(n + '.timer').ActiveState])),
    engineRoot: path.dirname(fileURLToPath(import.meta.url)), createdAt: Date.now() };
  ensure(stage + '/seamless-plan.json', JSON.stringify(plan, null, 2) + '\n');
  return { file: stage + '/seamless-plan.json', runId, source: main.source, build: main.build, delivery: DEFAULT_DELIVERY };
}

export function createNativeSeamlessDriver(planFile) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const p = json(planFile); assert.equal(p.schema, 'sd2-seamless-plan.v1'); assert.deepEqual(p.delivery, DEFAULT_DELIVERY);
  assert.equal(p.stage, PROJECT + '/release-staging/' + p.runId); assert.equal(planFile, p.stage + '/seamless-plan.json');
  assert.equal(p.engineRoot, path.dirname(fileURLToPath(import.meta.url)));
  const bytes = v => Buffer.from(v, 'base64'), sleep = ms => new Promise(r => setTimeout(r, ms));
  const save = (name, value) => ensure(p.stage + '/' + name + '.json', JSON.stringify(value, null, 2) + '\n');
  const alive = name => properties(name + '.service').ActiveState === 'active';
  async function until(predicate, description, budget = 120000) {
    const end = Date.now() + budget;
    while (!await predicate()) { if (Date.now() > end) throw Object.assign(new Error(description), { code: 'SEAMLESS_PENDING' }); await sleep(250); }
  }
  async function endpoint(port, entry) {
    const s = await fetch('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(5000) });
    assert.equal(s.status, 200); assert.equal((await s.json()).ok, true);
    const r = await fetch('http://127.0.0.1:' + port + '/api/release', { signal: AbortSignal.timeout(5000) });
    assert.equal(r.status, 200); assert.equal((await r.json()).version, entry.version);
    const asset = 'static/' + entry.build + '/_buildManifest.js'; assert.ok(entry.buildFiles[asset]);
    const a = await fetch('http://127.0.0.1:' + port + '/_next/' + asset, { signal: AbortSignal.timeout(5000) });
    assert.equal(a.status, 200); assert.equal(digest(Buffer.from(await a.arrayBuffer())), entry.buildFiles[asset]);
  }
  function workerReady(temporary) {
    const row = readRuntimeRows(p).find(r => r.key === 'pricing_worker_capability_v1:image' + (temporary ? ':' + p.main.source : ''));
    assert.ok(row, 'Pricing worker has not published its own capability'); const v = JSON.parse(row.value_json);
    assert.equal(v.source, p.main.source); assert.ok(Date.parse(v.expiresAt) > Date.now());
    const identity = processIdentity(v.instance.pid); assert.equal(identity.root, p.main.root); assert.equal(identity.startTicks, v.instance.start);
    assert.equal(identity.parent, v.parent.pid); assert.equal(processIdentity(v.parent.pid).startTicks, v.parent.start);
    assert.equal(identity.cgroup, temporary ? '/system.slice/sd2-release-image-' + p.runId + '.service' : '/system.slice/sd2-image-studio.service');
    for (const [f, h] of Object.entries(v.loadedModuleSha)) assert.equal(digest(fs.readFileSync(p.main.root + '/' + f)), h);
    // Execute the actual reader as the application account, including its exact
    // complete roster, original barrier, process/parent, source and TTL checks.
    // Passing raw capability avoids any database access or business operation.
    const script = "require('./scripts/server-runtime.cjs');const fs=require('node:fs');const p=require('./src/lib/pricing/runtime.ts');p.assertPricingImageConsumerReady({},fs.readFileSync(0,'utf8')).then(v=>console.log(JSON.stringify(v))).catch(()=>process.exit(1));";
    const verified = JSON.parse(nativeCall('/usr/sbin/runuser', ['-u', 'gouki', '--', '/usr/bin/node', '--import', 'tsx', '-e', script],
      { cwd: p.main.root, input: row.value_json }));
    assert.equal(verified.source, p.main.source);
  }
  async function targetReady(kind) {
    const name = `sd2-release-${kind}-${p.runId}.service`, actual = properties(name), entry = kind === 'guard' ? p.guard : p.main;
    assert.equal(actual.ActiveState, 'active'); assert.equal(actual.WorkingDirectory, entry.root);
    assert.equal(processIdentity(actual.MainPID).root, entry.root);
    if (kind === 'image') workerReady(true); else await endpoint(kind === 'guard' ? 3304 : 3303, entry);
  }
  async function prepareTarget(kind) {
    const entry = kind === 'guard' ? p.guard : p.main, source = kind === 'image' ? 'sd2-image-studio.service' : 'sd2-gray.service';
    const gid = fs.lstatSync(PROJECT + '/controls/pricing-writer-v1/writer-start-guard.mjs').gid;
    mkdir(SEAMLESS_CONTROL, 0o750, gid);
    // A same-permission policy snapshot keeps old and candidate source bindings
    // independent. Keys, destinations, identities and encryption state are copied.
    const policy = JSON.parse(bytes(p.privateFiles[PRIVATE + '/policy-active.json']));
    const proof = JSON.parse(bytes(p.privateFiles[PRIVATE + '/consumers-active.json']));
    for (const c of proof.consumers) if (c.id === (kind === 'image' ? 'image-worker' : kind === 'guard' ? 'guard' : 'web')) c.sourceRevision = entry.source;
    const prefix = PRIVATE + '/seamless-' + kind + '-' + p.runId;
    let policyFile = PRIVATE + '/policy-active.json', privateFiles;
    if (kind === 'guard') {
      // Existing guard identity is already admitted by the live policy. Keep
      // reading that policy so permission revocations never depend on a copy.
      privateFiles = Object.fromEntries([policyFile, PRIVATE + '/consumers-active.json'].map(f => [f, digest(rootBytes(f))]));
    } else {
      assert.deepEqual(rootBytes(policyFile), bytes(p.privateFiles[policyFile]));
      policy.activation.attestationFile = prefix + '-consumers.json';
      ensure(prefix + '-consumers.json', JSON.stringify(proof) + '\n', 0o440, gid);
      ensure(prefix + '-policy.json', JSON.stringify(policy) + '\n', 0o440, gid);
      policyFile = prefix + '-policy.json';
      privateFiles = Object.fromEntries([prefix + '-consumers.json', policyFile].map(f => [f, digest(rootBytes(f))]));
    }
    const helperBytes = fs.readFileSync(new URL('./seamless-shadow-start.mjs', import.meta.url));
    const helper = SEAMLESS_CONTROL + '/start-' + digest(helperBytes) + '.mjs'; ensure(helper, helperBytes, 0o440, gid);
    const authority = `${SEAMLESS_CONTROL}/authority-${kind}-${p.runId}.json`, unit = `sd2-release-${kind}-${p.runId}.service`;
    const unitFile = '/run/systemd/system/' + unit;
    const policySha = kind === 'guard' ? digest(rootBytes(policyFile)) : digest(bytes(p.privateFiles[PRIVATE + '/policy-active.json']));
    const unitBytes = renderShadowUnit(p.units[source.slice(0, -8)].definition, { root: entry.root, guard: helper,
      authority, kind, runId: p.runId, policy: policyFile,
      policySha });
    ensure(unitFile, unitBytes, 0o640, gid);
    ensure(authority, JSON.stringify({ schema: 'sd2-seamless-start-authority.v1', runId: p.runId, kind, unit, unitFile,
      unitSha256: digest(unitBytes), entry, policyFile, policySha, serviceUid: p.previous.serviceUid, marker: p.marker,
      originalGuardSha256: PRICING_START_GUARD_SHA256,
      privateFiles }) + '\n', 0o440, gid);
    save('temporary-' + kind + '-start-intent', { runId: p.runId, source: entry.source, unit, noAutomaticOldPairRestore: true });
    nativeCall('/usr/bin/systemctl', ['daemon-reload']); nativeCall('/usr/bin/systemctl', ['start', '--no-block', unit]);
    await until(async () => { try { await targetReady(kind); return true; } catch { return false; } }, kind + ' did not become ready');
  }
  async function route(port) {
    const name = 'route-' + port + '-old-workers', file = p.stage + '/' + name + '.json';
    if (!fs.existsSync(file)) save(name, nginxWorkers());
    const changed = [];
    try {
      for (const site of p.sites) {
        const current = rootBytes(site.file), wanted = Buffer.from(renderRoute(bytes(site.bytesBase64).toString(), port));
        assert.ok([3302, 3303, 3304].some(value => Buffer.from(renderRoute(bytes(site.bytesBase64).toString(), value)).equals(current)), 'Unknown ingress change');
        if (!current.equals(wanted)) { replace(site.file, current, wanted); changed.push({ file: site.file, current, wanted }); }
      }
      nativeCall('/usr/sbin/nginx', ['-t']); nativeCall('/usr/bin/systemctl', ['reload', 'nginx']);
    } catch (error) {
      for (const item of changed.reverse()) replace(item.file, item.wanted, item.current);
      nativeCall('/usr/sbin/nginx', ['-t']); nativeCall('/usr/bin/systemctl', ['reload', 'nginx']); throw error;
    }
    // Actual public TLS responses and retained build asset bytes on both hosts.
    for (const host of ['sd2.youdooart.com', 'sd2-server.youdoodesign.com']) {
      const entry = port === 3304 ? p.guard : p.main;
      const response = nativeCall('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--max-time', '15', 'https://' + host + '/api/release']);
      assert.equal(JSON.parse(response).version, entry.version);
      await endpoint(port, entry);
    }
    return { port, workers: json(file) };
  }
  function retainAssets() {
    for (const parent of ['/data', PROJECT]) assert.ok(fs.statSync(parent).mode & 0o001, 'Existing public-asset ancestry is not traversable; retain the current site');
    mkdir(SEAMLESS_STATIC, 0o755);
    for (const e of [p.previous.releases[0], p.main, p.guard]) {
      for (const [file, h] of Object.entries(e.buildFiles)) if (file.startsWith('static/')) {
        const source = e.root + '/.next-prod-candidate/' + file, relative = file.slice(7);
        assert.ok(relative && !relative.split('/').some(n => !n || n === '.' || n === '..'));
        assert.equal(fs.realpathSync(source), source); const content = fs.readFileSync(source); assert.equal(digest(content), h);
        let parent = SEAMLESS_STATIC;
        for (const n of relative.split('/').slice(0, -1)) { parent += '/' + n; mkdir(parent, 0o755); }
        ensure(SEAMLESS_STATIC + '/' + relative, content, 0o644);
      }
    }
    const location = renderRetainedStaticLocation();
    const config = '/etc/nginx/snippets/sd2-release-static.conf'; ensure(config, location, 0o644);
    const fallback = '/etc/nginx/snippets/sd2-updating.conf', current = rootBytes(fallback), include = '\ninclude ' + config + ';\n';
    assert.ok(p.sites.every(s => bytes(s.bytesBase64).includes(Buffer.from('include /etc/nginx/snippets/sd2-updating.conf;'))));
    if (!current.toString().includes('include ' + config + ';')) {
      const wanted = Buffer.concat([current, Buffer.from(include)]); replace(fallback, current, wanted);
      try { nativeCall('/usr/sbin/nginx', ['-t']); nativeCall('/usr/bin/systemctl', ['reload', 'nginx']); }
      catch (e) { replace(fallback, wanted, current); nativeCall('/usr/sbin/nginx', ['-t']); nativeCall('/usr/bin/systemctl', ['reload', 'nginx']); throw e; }
    }
  }
  function assertOriginalUnitsStopped() {
    for (const name of [...WEB_UNITS, ...AUX_UNITS]) {
      const v = properties(name + '.service'); assert.equal(v.MainPID, '0'); assert.equal(v.ControlPID, '0');
      assert.ok(['inactive', 'failed'].includes(v.ActiveState)); assert.equal(groupPids('/system.slice/' + name + '.service').length, 0);
    }
    assert.equal(findOldRootProcesses(p.previous.releases[0].root).length, 0, 'Another original-root process remains; do not publish a new canonical writer');
  }
  return { plan: p, save, json, rootBytes, writeExclusive,
    async preflight() {
      assert.ok(Date.now() - p.createdAt < 30 * 60 * 1000, 'Prepare a fresh delivery plan');
      assert.equal(digest(rootBytes(p.capsuleFile)), p.capsuleSha256); mainEntryFromCapsule(p.capsuleFile);
      verifyFixedProgramEntry(p.guard);
      assert.equal(digest(rootBytes(PROJECT + '/controls/pricing-writer-v1/allowed.json')), p.pricingSha256);
      assert.equal(properties('sd2-gray.service').WorkingDirectory, p.previous.releases[0].root);
      const legacy = JSON.parse(nativeCall('/usr/sbin/runuser', ['-u', 'gouki', '--', '/usr/bin/node',
        PROJECT + '/controls/pricing-writer-v1/writer-start-guard.mjs', 'sd2-gray.service'], { cwd: p.previous.releases[0].root }));
      assert.equal(legacy.barrierVerified, true); assert.equal(legacy.sourceAndBuildVerified, true);
      assert.equal(legacy.source, p.previous.releases[0].source); assert.equal(legacy.build, p.previous.releases[0].build);
      for (const [file, b] of Object.entries(p.privateFiles)) assert.deepEqual(rootBytes(file), bytes(b));
      for (const [name, u] of Object.entries(p.units)) {
        assert.deepEqual(rootBytes(u.file), bytes(u.bytesBase64)); assert.equal(properties(name + '.service').WorkingDirectory, p.previous.releases[0].root);
      }
      for (const port of [3303, 3304]) assert.equal(nativeCall('/usr/bin/ss', ['-H', '-ltn', 'sport', '=', ':' + port]), '');
      const memory = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
      assert.ok(Number(memory?.[1]) > 2 * 1024 * 1024, 'Insufficient measured memory for parallel web and image worker');
      const backup = p.stage + '/consistent-live-backup.db';
      if (!fs.existsSync(backup)) nativeCall('/usr/bin/python3', ['-I', '-c', `import sqlite3,sys,os\np=sys.argv[1];q=sys.argv[2];t=q+'.partial'\nassert not os.path.exists(q) and not os.path.exists(t)\nwith sqlite3.connect('file:'+p+'?mode=ro',uri=True) as source,sqlite3.connect(t) as target:\n os.chmod(t,0o600);source.backup(target);assert target.execute('PRAGMA integrity_check').fetchall()==[('ok',)]\nwith open(t,'rb') as f:os.fsync(f.fileno())\nos.rename(t,q)`, p.database.file, backup]);
      return p.admission;
    },
    async prepare() { retainAssets(); await prepareTarget('image'); await prepareTarget('main'); return { ready: true, source: p.main.source, build: p.main.build }; },
    async cutToCandidate() { await targetReady('image'); await targetReady('main'); return route(3303); },
    async drainOriginal() {
      const workers = json(p.stage + '/route-3303-old-workers.json');
      await until(() => workers.every(w => !stillSame(w)), 'Original nginx workers still own requests; candidate remains online');
      await until(() => classifySynchronousRows(readRuntimeRows(p), p).oldRunningImages === 0, 'Original synchronous images still running; candidate remains online');
      assert.deepEqual(rootBytes(PRIVATE + '/policy-active.json'), bytes(p.privateFiles[PRIVATE + '/policy-active.json']));
      for (const name of TIMERS) if (p.timers[name] === 'active') nativeCall('/usr/bin/systemctl', ['stop', name + '.timer']);
      await targetReady('image'); await targetReady('main');
      for (const name of [...WEB_UNITS, ...AUX_UNITS]) {
        const file = '/run/systemd/system/' + name + '.service.d/zzzzzzzzzzzzzzzz-seamless-drain.conf'; mkdir(path.dirname(file), 0o755);
        ensure(file, '[Service]\nRestart=no\nSendSIGKILL=no\nTimeoutStopSec=infinity\nKillSignal=SIGTERM\n', 0o644);
      }
      nativeCall('/usr/bin/systemctl', ['daemon-reload']);
      for (const name of [...WEB_UNITS, ...AUX_UNITS]) {
        const state = properties(name + '.service');
        assert.equal(state.Restart, 'no'); assert.equal(state.SendSIGKILL, 'no');
        assert.equal(state.TimeoutStopUSec, 'infinity'); assert.equal(state.KillSignal, '15'); assert.equal(state.Delegate, 'no');
      }
      nativeCall('/usr/bin/systemctl', ['stop', '--no-block', ...[...WEB_UNITS, ...AUX_UNITS].map(n => n + '.service')]);
      await until(() => { try { assertOriginalUnitsStopped(); return true; } catch { return false; } }, 'Original services are still draining; candidate remains online');
      return { originalGroupsEmpty: true, forcedKill: false };
    },
    async publishCanonical() {
      assertOriginalUnitsStopped(); await targetReady('image'); await targetReady('main');
      verifyFixedProgramEntry(p.main); verifyFixedProgramEntry(p.guard);
      assert.deepEqual(rootBytes(PRIVATE + '/policy-active.json'), bytes(p.privateFiles[PRIVATE + '/policy-active.json']));
      for (const name of CONTROLS) {
        const file = PROJECT + '/controls/' + name + '/allowed.json', old = JSON.parse(bytes(p.controls[name]));
        const current = rootBytes(file); let next;
        if (name === 'pricing-writer-v1') next = { ...old, runId: p.runId, at: new Date(p.createdAt).toISOString(), releases: [p.main, p.guard] };
        else {
          const e = old.releases[0];
          assert.equal(e.source, p.previous.releases[0].source);
          const sourceSha256 = Object.fromEntries(Object.keys(e.sourceSha256).map(f => { assert.ok(p.main.sourceFiles[f]); return [f, p.main.sourceFiles[f]]; }));
          next = { ...old, runId: p.runId, ...(Object.hasOwn(old, 'manifestSha256') ? { manifestSha256: digest(rootBytes(planFile)) } : {}),
            releases: [{ ...e, root: p.main.root, source: p.main.source, version: p.main.version, build: p.main.build, sourceSha256 }, old.releases[1]] };
        }
        const wanted = Buffer.from(JSON.stringify(next) + '\n');
        assert.ok(current.equals(bytes(p.controls[name])) || current.equals(wanted), 'Independent startup-control change');
        replace(file, current, wanted);
      }
      // Retain original immutable barrier and guard program, change only source
      // membership after original canonical groups actually exit.
      assert.equal(digest(rootBytes(p.marker.file)), p.marker.sha256);
      assert.equal(digest(rootBytes(PROJECT + '/controls/pricing-writer-v1/writer-start-guard.mjs')), PRICING_START_GUARD_SHA256);
      for (const [name, u] of Object.entries(p.units)) {
        const original = bytes(u.bytesBase64).toString();
        const wanted = original.replace(/^WorkingDirectory=.*$/mg, 'WorkingDirectory=' + p.main.root)
          .replace(/^Environment=PRIVATE_PROMPTS_RUNTIME_REVISION=.*\n?/mg, '') + '\nEnvironment=PRIVATE_PROMPTS_RUNTIME_REVISION=' + p.main.source + '\n';
        const current = rootBytes(u.file); assert.ok(current.equals(bytes(u.bytesBase64)) || current.equals(Buffer.from(wanted)));
        replace(u.file, current, wanted);
      }
      const consumersFile = PRIVATE + '/consumers-active.json', backupFile = PRIVATE + '/backup-proof.json';
      const proof = JSON.parse(bytes(p.privateFiles[consumersFile]));
      for (const c of proof.consumers) c.sourceRevision = c.id === 'guard' ? p.guard.source : p.main.source;
      const consumerBytes = Buffer.from(JSON.stringify(proof, null, 2) + '\n');
      const backup = JSON.parse(bytes(p.privateFiles[backupFile])); backup.consumerDigest = digest(consumerBytes);
      for (const [file, wanted] of [[consumersFile, consumerBytes], [backupFile, Buffer.from(JSON.stringify(backup, null, 2) + '\n')]]) {
        const current = rootBytes(file); assert.ok(current.equals(bytes(p.privateFiles[file])) || current.equals(wanted)); replace(file, current, wanted);
      }
      for (const name of [...WEB_UNITS, ...AUX_UNITS]) {
        const file = '/run/systemd/system/' + name + '.service.d/zzzzzzzzzzzzzzzz-seamless-drain.conf';
        if (fs.existsSync(file)) { assert.equal(rootBytes(file).toString(), '[Service]\nRestart=no\nSendSIGKILL=no\nTimeoutStopSec=infinity\nKillSignal=SIGTERM\n'); fs.unlinkSync(file); }
      }
      nativeCall('/usr/bin/systemctl', ['daemon-reload']);
      return { source: p.main.source, databaseRestored: false, schemaChanged: false };
    },
    async startCanonical() {
      nativeCall('/usr/bin/systemctl', ['start', '--no-block', ...WEB_UNITS.filter(n => p.units[n].properties.ActiveState === 'active').map(n => n + '.service')]);
      await until(async () => {
        try {
          for (const name of WEB_UNITS.filter(n => p.units[n].properties.ActiveState === 'active')) {
            const actual = properties(name + '.service'); assert.equal(actual.ActiveState, 'active');
            assert.equal(actual.WorkingDirectory, p.main.root); assert.equal(processIdentity(actual.MainPID).root, p.main.root);
          }
          workerReady(false); await endpoint(3302, p.main); return true;
        } catch { return false; }
      }, 'Canonical services not ready; temporary new pair remains online');
      return { ready: true, source: p.main.source, build: p.main.build };
    },
    async cutToCanonical() { workerReady(false); await endpoint(3302, p.main); return route(3302); },
    async retireCandidate() {
      await until(() => json(p.stage + '/route-3302-old-workers.json').every(w => !stillSame(w)), 'Temporary nginx requests remain; keep temporary pair');
      await until(() => { const v = classifySynchronousRows(readRuntimeRows(p), p);
        return v.candidateRunningImages === 0 && v.unconfirmedCandidateRunningImages === 0;
      }, 'Temporary synchronous requests remain or are unknown; keep temporary pair');
      for (const kind of ['main', 'image']) nativeCall('/usr/bin/systemctl', ['stop', '--no-block', `sd2-release-${kind}-${p.runId}.service`]);
      await until(() => ['main', 'image'].every(k => groupPids(`/system.slice/sd2-release-${k}-${p.runId}.service`).length === 0), 'Temporary services still completing work');
      for (const kind of ['main', 'image']) ensure(`${SEAMLESS_CONTROL}/revoked-${kind}-${p.runId}`, p.runId + '\n', 0o440);
      for (const name of TIMERS) if (p.timers[name] === 'active') nativeCall('/usr/bin/systemctl', ['start', name + '.timer']);
      return { retired: true, forcedKill: false, staticAssetsRetained: true };
    },
    async publicHealthy() {
      try {
        for (const host of ['sd2.youdooart.com', 'sd2-server.youdoodesign.com']) {
          const response = nativeCall('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--max-time', '10', 'https://' + host + '/api/health']);
          assert.equal(JSON.parse(response).ok, true);
        }
        return true;
      }
      catch { return false; }
    },
    async recoverGuard() { await prepareTarget('guard'); await route(3304); return { recovered: true, guardSource: p.guard.source, databaseRestored: false }; },
  };
}
