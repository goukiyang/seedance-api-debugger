import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { runSeamlessDelivery, SEAMLESS_STEPS } from './seamless-release.mjs';
import { classifySynchronousRows, renderRoute, renderShadowUnit, renderRetainedStaticLocation, readCurrentBuildEvidence, RUNTIME_ROWS_READER, findOldRootProcesses, processIdentity } from './seamless-web.mjs';
import { privateDataBytes, verifyShadowStart } from './seamless-shadow-start.mjs';
import { assertSeamlessCompatible, digest } from './seamless-policy.mjs';
import bridges from './seamless-bridges.mjs';
const checks = [], check = (name, fn) => { fn(); checks.push(name); };
check('private policy data retains app ownership and mode0600; group-readable copies and foreign owners are refused', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-private-data-'))), file = directory + '/policy.json';
  fs.writeFileSync(file, '{}', { mode: 0o600 });
  assert.equal(privateDataBytes(file, process.getuid()).toString(), '{}');
  assert.throws(() => privateDataBytes(file, process.getuid() + 1));
  fs.chmodSync(file, 0o640); assert.throws(() => privateDataBytes(file, process.getuid()));
  fs.rmSync(directory, { recursive: true });
});
const root = process.argv[4] || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const a = 'a'.repeat(40), b = 'b'.repeat(40), runId = '12345678-1234-4234-8234-123456789abc';
if (process.platform === 'linux' && process.getuid() === 0) check('actual systemd PID1 is a valid worker parent identity', () => assert.equal(processIdentity(1).pid, 1));
const plan = { runId, main: { source: b, root: '/data/video-api-debugger/managed-releases/' + b } };
check('whole old-root process scan catches extra writers and never treats unreadable processes as zero', () => {
  const io = { readdirSync: () => ['100', '101', '102', 'self'], realpathSync: file => {
    if (file.includes('/102/')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    return file.includes('/100/') ? '/old' : '/new';
  } };
  assert.deepEqual(findOldRootProcesses('/old', io), [100]);
  assert.throws(() => findOldRootProcesses('/old', { ...io, realpathSync: () => { throw Object.assign(new Error('unconfirmed'), { code: 'EACCES' }); } }));
});

for (const failure of [null, ...SEAMLESS_STEPS]) {
  let state = null, fail = failure, publicAlive = true; const calls = [];
  const driver = { plan, publicHealthy: async () => publicAlive, recoverGuard: async () => { calls.push('guard'); return { recovered: true }; } };
  for (const step of SEAMLESS_STEPS) driver[step] = async () => { calls.push(step); if (step === fail) throw Object.assign(new Error('pending'), { code: 'SEAMLESS_PENDING' }); return { okay: true }; };
  const store = { read: () => state, write: v => { state = JSON.parse(JSON.stringify(v)); } };
  const result = await runSeamlessDelivery(driver, store);
  if (!failure) assert.equal(result.status, 'complete');
  else {
    assert.equal(result.status, 'pending'); assert.equal(calls.includes('guard'), false);
    assert.deepEqual(result.completed, SEAMLESS_STEPS.slice(0, SEAMLESS_STEPS.indexOf(failure)));
    fail = null; const completed = [...result.completed]; calls.length = 0;
    assert.equal((await runSeamlessDelivery(driver, store)).status, 'complete');
    assert.deepEqual(calls, SEAMLESS_STEPS.slice(completed.length));
  }
}
checks.push('actual controller order and resume at all 8 boundaries; no forced old rollback');
{
  let state = null; const driver = { plan, publicHealthy: async () => false, recoverGuard: async () => ({ recovered: true, source: a }) };
  for (const step of SEAMLESS_STEPS) driver[step] = async () => { if (step === 'drainOriginal') throw new Error('public failed'); return {}; };
  const result = await runSeamlessDelivery(driver, { read: () => state, write: v => { state = v; } });
  assert.equal(result.status, 'recovered'); assert.equal(result.recovery.source, a); assert.equal(result.databaseRestored, false);
  checks.push('unhealthy public target uses fixed guard without business-data restoration');
}
const admission = (owner, req, count = 1) => ({ key: `image_sync_request_v1:${owner}:${req}`,
  value_json: JSON.stringify({ schema: 'image.sync-admission.v1', ownerId: owner, requestId: req, fingerprint: 'fp', count,
    model: 'model', scope: 'scope', createdAt: new Date().toISOString(), finishedAt: null, status: 'running' }) });
const original = admission('one', 'original-request-0001', 5), current = admission('two', 'candidate-request-01', 3);
const provenance = { schema: 'image.sync-process.v1', runId, ...plan.main, pid: 123, startTicks: '987',
  cgroup: '/system.slice/sd2-release-main-' + runId + '.service', fingerprint: 'fp' };
const meta = { key: 'image_sync_process_v1:two:candidate-request-01', value_json: JSON.stringify(provenance) };
const inspect = () => ({ ...provenance });
{
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-release-rows-')), file = path.join(directory, 'isolated.db');
  const db = new DatabaseSync(file); db.exec('CREATE TABLE PlatformSetting (key TEXT PRIMARY KEY,value_json TEXT)');
  const insert = db.prepare('INSERT INTO PlatformSetting VALUES (?,?)');
  for (const row of [original, current, meta]) insert.run(row.key, row.value_json);
  insert.run('image_sync_request_v1:finished:done', JSON.stringify({ status: 'succeeded' }));
  for (const source of ['', ':' + b, ':' + a]) insert.run('pricing_worker_capability_v1:image' + source, '{}');
  const read = () => {
    const child = spawnSync('/usr/bin/python3', ['-I', '-c', RUNTIME_ROWS_READER, file, b], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout).rows;
  };
  assert.equal(read().length, 5);
  insert.run('image_sync_request_v1:bad:unknown', 'not-json');
  assert.equal(read().length, 6); assert.throws(() => classifySynchronousRows(read(), plan, inspect));
  db.close(); fs.rmSync(directory, { recursive: true });
  checks.push('actual read-only SQLite reader selects all owners in flight, joins matching provenance, excludes ended/history, retains malformed unknowns');
}
check('vanished candidate process remains unknown and cannot be retired as completed', () => {
  const result = classifySynchronousRows([current, meta], plan, () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); });
  assert.equal(result.unconfirmedCandidateRunningImages, 3);
});
check('all-owner old/new execution separation without changing the 8-image total', () => {
  assert.deepEqual(classifySynchronousRows([original, current, meta], plan, inspect), { oldRunningImages: 5, candidateRunningImages: 3, unconfirmedCandidateRunningImages: 0 });
});
for (const change of [{ runId: 'wrong' }, { fingerprint: 'wrong' }, { source: a }, { startTicks: 'wrong' }, { cgroup: '/another' }]) {
  check('unconfirmed provenance remains old/unknown: ' + Object.keys(change)[0], () => {
    assert.equal(classifySynchronousRows([current, { ...meta, value_json: JSON.stringify({ ...provenance, ...change }) }], plan, inspect).oldRunningImages, 3);
  });
}
{
  const stage = '/data/video-api-debugger/release-staging/offline-build', files = new Map(), put = (file, value) => files.set(file, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
  const entry = { ...plan.main, build: 'build', version: '1.2.3', sourceFiles: { 'source.ts': digest('source') } };
  put(stage + '/main-source.json', { source: b, files: entry.sourceFiles });
  put(stage + '/prepared-pricing-writer-v1.json', { releases: [entry, { source: a }] });
  const finished = Date.now(), nativeFile = stage + '/main-native-reuse.json';
  put(nativeFile, { source: b, passed: true, completeMatrix: true, runtimeCompatibilityDeltaVerified: true, productionWrites: 0, paidRequests: 0, browserRuns: 0 });
  put(stage + '/main-pricing-prepared.json', { source: b, nativePrebuildPassed: true, freshPricingPassed: true, methodReaderPassed: false,
    nativeEvidence: { receipt: nativeFile, receiptSha256: digest(files.get(nativeFile)) } });
  for (const kind of ['next', 'types']) {
    put(stage + '/main-' + kind + '-process.json', { source: b, exitCode: 0, signal: null, error: null, startedAt: new Date(finished - 2000).toISOString(), finishedAt: new Date(finished - 1000).toISOString() });
  }
  put(stage + '/main-next-build.log', 'full-next'); put(stage + '/main-complete-types.log', 'complete-types');
  const proof = { kind: 'main', stagingRoot: stage, source: b, version: entry.version, build: entry.build, fullNextBuildPassed: true,
    fullTypeAndLintIncluded: true, isolatedBuildDatabase: true, deployed: false, completedAt: new Date(finished).toISOString() };
  for (const [key, suffix] of [['sourceManifestSha256', 'source.json'], ['nextBuildLogSha256', 'next-build.log'], ['completeTypesLogSha256', 'complete-types.log'],
    ['pricingPreparedSha256', 'pricing-prepared.json'], ['nextProcessReceiptSha256', 'next-process.json'], ['typesProcessReceiptSha256', 'types-process.json']]) proof[key] = digest(files.get(stage + '/main-' + suffix));
  const file = stage + '/main-build-success.json'; put(file, proof); const read = name => files.get(name); let verified = 0;
  assert.deepEqual(readCurrentBuildEvidence(file, { read, verify: () => { verified++; } }), entry); assert.equal(verified, 1);
  put(stage + '/main-next-process.json', { source: a, exitCode: 0 });
  assert.throws(() => readCurrentBuildEvidence(file, { read, verify: () => { verified++; } })); assert.equal(verified, 1);
  checks.push('actual current builder adapter binds full Next/types logs, process exits, pricing/native source and exact prepared entry');
}
{
  const control = '/data/video-api-debugger/controls/seamless-web-v1', unit = 'sd2-release-main-' + runId + '.service';
  const file = control + '/authority-main-' + runId + '.json', unitFile = '/run/systemd/system/' + unit;
  const marker = '/data/video-api-debugger/releases/old/storage/image-studio-drain', original = '/data/video-api-debugger/controls/pricing-writer-v1/writer-start-guard.mjs';
  const map = new Map(), put = (name, value) => map.set(name, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
  const entry = { ...plan.main, version: '1.2.3', build: 'test-build', sourceFiles: {}, buildFiles: {} };
  for (let n = 0; n < 101; n++) { entry.sourceFiles['file-' + n] = digest('source'); put(entry.root + '/file-' + n, 'source'); }
  for (let n = 0; n < 12; n++) { entry.buildFiles['file-' + n] = digest('compiled'); put(entry.root + '/.next-prod-candidate/file-' + n, 'compiled'); }
  put(entry.root + '/.deployed-commit', b); put(entry.root + '/package.json', { version: entry.version }); put(entry.root + '/.next-prod/BUILD_ID', entry.build);
  put(unitFile, 'sealed unit'); put(original, 'original guard'); put(marker, { schema: 'pricing-writer-isolation.v1', protocol: 'pricing-policy-v1', guard: 'reject-legacy-image-writers', installedAt: '2026-01-01T00:00:00Z' });
  put(file, { schema: 'sd2-seamless-start-authority.v1', runId, kind: 'main', unit, unitFile, unitSha256: digest(map.get(unitFile)), entry,
    policyFile: '/sealed/policy.json', policySha: 'd'.repeat(64),
    serviceUid: 1000, marker: { file: marker, sha256: digest(map.get(marker)) }, originalGuardSha256: digest(map.get(original)), privateFiles: {} });
  let revoked = false, immutable = true, overrides = '';
  const io = { existsSync: () => revoked, readFileSync: (name, encoding) => encoding ? map.get(name).toString() : map.get(name),
    realpathSync: name => name.endsWith('/storage/image-studio-drain') && name.startsWith(entry.root) ? marker : name === entry.root + '/.next-prod' ? entry.root + '/.next-prod-candidate' : name,
    lstatSync: name => ({ uid: 0, mode: 0o440, nlink: 1, isDirectory: () => !map.has(name), isFile: () => map.has(name), isSymbolicLink: () => false }) };
  const env = { SD2_SEAMLESS_RUN_ID: runId, PRIVATE_PROMPTS_RUNTIME_REVISION: b, PRIVATE_PROMPTS_POLICY_FILE: '/sealed/policy.json',
    PRIVATE_PROMPTS_CONSUMER_ID: 'web', SD2_SEAMLESS_POLICY_SHA256: 'd'.repeat(64) };
  const options = { io, env, cwd: entry.root, uid: 1000, call: bin => bin.endsWith('lsattr') ? (immutable ? '---i--- ' : '------- ') + marker
    : `WorkingDirectory=${entry.root}\nFragmentPath=${unitFile}\nDropInPaths=${overrides}` };
  assert.equal(verifyShadowStart(file, unit, options).sourceAndBuildVerified, true);
  env.SD2_SEAMLESS_RUN_ID = ''; assert.throws(() => verifyShadowStart(file, unit, options)); env.SD2_SEAMLESS_RUN_ID = runId;
  immutable = false; assert.throws(() => verifyShadowStart(file, unit, options)); immutable = true;
  overrides = '/unapproved.conf'; assert.throws(() => verifyShadowStart(file, unit, options)); overrides = '';
  put(entry.root + '/file-1', 'tampered'); assert.throws(() => verifyShadowStart(file, unit, options)); put(entry.root + '/file-1', 'source');
  revoked = true; assert.throws(() => verifyShadowStart(file, unit, options));
  checks.push('temporary start guard verifies actual unit/full artifacts/root+i barrier; denies tampering, overrides and revoked admission');
}
check('legacy/missing metadata never creates a false zero', () => assert.equal(classifySynchronousRows([original], plan, inspect).oldRunningImages, 5));
check('malformed admission refuses drain', () => assert.throws(() => classifySynchronousRows([{ ...original, value_json: '{}' }], plan, inspect)));
{
  const old = { source: a, root: '/old', sourceFiles: { 'prisma/schema.prisma': 'x', 'src/lib/pricing/runtime.ts': bridges['src/lib/pricing/runtime.ts'].previous } };
  const next = { source: b, root: '/new', sourceFiles: { ...old.sourceFiles, 'src/lib/pricing/runtime.ts': bridges['src/lib/pricing/runtime.ts'].current } };
  const guard = { source: 'c', root: '/guard', sourceFiles: {} }, previous = { releases: [old, guard] };
  const read = file => file.endsWith('process-provenance.ts') ? fs.readFileSync(root + '/src/lib/image-studio/process-provenance.ts') : Buffer.from('{}');
  check('only exact reviewed additive bridge is admitted', () => assert.equal(assertSeamlessCompatible(previous, next, guard, read, bridges).sameSchema, true));
  check('schema and persisted contract mismatch retain current site', () => assert.throws(() => assertSeamlessCompatible(previous, { ...next, sourceFiles: { ...next.sourceFiles, 'prisma/schema.prisma': 'new' } }, guard, read, bridges)));
  check('changed recovery artifact is refused', () => assert.throws(() => assertSeamlessCompatible(previous, next, { ...guard, source: 'other' }, read, bridges)));
}
{
  const unit = '[Service]\nUser=gouki\nEnvironmentFile=/private/app.env\nExecStartPre=/usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/node /data/video-api-debugger/controls/pricing-writer-v1/writer-start-guard.mjs %n\nExecStartPre=/usr/bin/node private-check.mjs\nExecStart=/usr/bin/npm run start -- --hostname 127.0.0.1 --port 3302\n';
  const next = renderShadowUnit(unit, { root: plan.main.root, guard: '/sealed/start.mjs', authority: '/sealed/authority.json', kind: 'main', runId, policy: '/sealed/policy.json' });
  check('temporary unit retains account/environment/private checks and no-force stop', () => {
    for (const fragment of ['User=gouki', 'EnvironmentFile=/private/app.env', 'private-check.mjs', '--port 3303', 'SendSIGKILL=no', 'TimeoutStopSec=infinity', 'Restart=no']) assert.ok(next.includes(fragment));
    assert.equal(next.includes('writer-start-guard.mjs %n'), false);
  });
  check('unrecognized startup command refuses instead of weakening guards', () => assert.throws(() => renderShadowUnit(unit.replace('/usr/bin/npm run start', '/bin/custom-server'), { root: plan.main.root, kind: 'main' })));
}

// Execute the changed TS functions, using an actual SQLite transaction and
// deterministic /proc adapters. No Prisma migration, provider, account or media.
const require = createRequire(import.meta.url);
const ts = require(process.argv[2] || path.join(root, 'node_modules/typescript/lib/typescript.js'));
function loadTs(file, replacements, fakeProcess = process) {
  const module = { exports: {} }, code = ts.transpileModule(fs.readFileSync(root + '/' + file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, reportDiagnostics: true });
  assert.equal(code.diagnostics?.length || 0, 0);
  vm.runInNewContext(code.outputText, { module, exports: module.exports, process: fakeProcess, Buffer,
    require: name => name in replacements ? replacements[name] : require(name) }, { filename: file });
  return module.exports;
}
{
  let live = Buffer.from('current live permission policy');
  const env = { SD2_SEAMLESS_RUN_ID: runId, PRIVATE_PROMPTS_POLICY_FILE: '/etc/video-api-debugger/private-prompts/copied-policy.json', SD2_SEAMLESS_POLICY_SHA256: digest(live) };
  const module = loadTs('src/lib/image-studio/process-provenance.ts', { 'node:fs': { readFileSync: () => live } }, { env });
  assert.equal(module.releasePrivatePolicyFresh(), true);
  live = Buffer.from('revoked permission policy'); assert.equal(module.releasePrivatePolicyFresh(), false);
  env.PRIVATE_PROMPTS_POLICY_FILE = '/etc/video-api-debugger/private-prompts/policy-active.json';
  assert.equal(module.releasePrivatePolicyFresh(), true);
  delete env.SD2_SEAMLESS_RUN_ID; assert.equal(module.releasePrivatePolicyFresh(), true);
  checks.push('temporary policy copy expires on live permission change; canonical and fixed guard keep reading live permissions');
}
{
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE PlatformSetting (key TEXT PRIMARY KEY,value_json TEXT,updated_by TEXT)');
  const fsAdapter = { realpathSync: () => plan.main.root, readFileSync: file => file.endsWith('.deployed-commit') ? b : file.endsWith('/stat') ? '123 (node) S 1 ' + Array(17).fill('0').join(' ') + ' 987' : '0::' + provenance.cgroup + '\n' };
  const processModule = loadTs('src/lib/image-studio/process-provenance.ts', { 'node:fs': fsAdapter }, { env: { SD2_SEAMLESS_RUN_ID: runId }, platform: 'linux', cwd: () => plan.main.root, pid: 123 });
  assert.equal(processModule.synchronousProcessProvenance().startTicks, '987');
  const code = loadTs('src/lib/image-studio/synchronous-admission.ts', { '@/lib/prisma': { prisma: {} },
    './submit-receipts.server': { assertStudioRequestWritable: async () => {} }, './process-provenance': processModule });
  const tx = { imageStudioTask: { findFirst: async () => null }, platformSetting: {
    findUnique: async ({ where }) => db.prepare('SELECT value_json FROM PlatformSetting WHERE key=?').get(where.key),
    findMany: async ({ where }) => db.prepare('SELECT value_json FROM PlatformSetting WHERE key LIKE ? AND value_json LIKE ?').all(where.key.startsWith + '%', '%"status":"running"%'),
    create: async ({ data }) => { db.prepare('INSERT INTO PlatformSetting VALUES (?,?,?)').run(data.key, data.value_json, data.updated_by); },
  } };
  const input = { ownerId: 'owner', requestId: 'sync-request-000001', fingerprint: 'fp', count: 3, model: 'model', scope: 'scope' };
  db.exec('BEGIN'); await code.createSynchronousImageAdmission(tx, input); db.exec('COMMIT');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM PlatformSetting').get().n, 2);
  assert.equal(await code.countSynchronousImageAdmissions(tx, 'owner'), 3);
  await assert.rejects(() => code.createSynchronousImageAdmission(tx, input));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM PlatformSetting').get().n, 2);
  db.prepare('INSERT INTO PlatformSetting VALUES (?,?,?)').run('image_sync_process_v1:owner:sync-request-000002', '{}', 'owner');
  db.exec('BEGIN'); await assert.rejects(() => code.createSynchronousImageAdmission(tx, { ...input, requestId: 'sync-request-000002' })); db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM PlatformSetting WHERE key=?').get('image_sync_request_v1:owner:sync-request-000002').n, 0);
  checks.push('real SQLite: transactional provenance, original-id duplicate refusal and rollback without partial admission');
  db.close();
}
{
  const rows = new Map(), roots = { 101: '/data/video-api-debugger/managed-releases/' + a, 100: '/parent-a', 201: plan.main.root, 200: '/parent-b' };
  function module(source, pid, env) {
    const cwd = roots[pid];
    const adapter = { readdirSync: () => ['runtime.ts'], realpathSync: file => /^\/proc\/(\d+)\/cwd$/.test(file) ? roots[Number(file.split('/')[2])] : file,
      readFileSync: file => {
        const proc = /^\/proc\/(\d+)\/stat$/.exec(file);
        if (proc) { const id = Number(proc[1]); return `${id} (node) S ${id === 101 ? 100 : id === 201 ? 200 : 1} ` + Array(17).fill('0').join(' ') + ' ' + (id * 10); }
        if (file.endsWith('.deployed-commit')) return source;
        return 'sealed:' + file.slice(cwd.length);
      } };
    const proc = { env, platform: 'linux', pid, ppid: pid - 1, cwd: () => cwd };
    const scoped = loadTs('src/lib/image-studio/process-provenance.ts', { 'node:fs': adapter }, proc);
    assert.equal(scoped.releaseWorkerKey('studio_shared_worker_v1'), 'studio_shared_worker_v1' + (env.SD2_SEAMLESS_RUN_ID ? ':' + source : ''));
    return loadTs('src/lib/pricing/runtime.ts', { 'node:fs': adapter, './isolation': { assertPricingWriterIsolation: () => {} },
      '../image-studio/process-provenance': scoped }, proc);
  }
  const old = module(a, 101, {}), next = module(b, 201, { SD2_SEAMLESS_RUN_ID: runId });
  const client = { platformSetting: {
    upsert: async ({ where, create, update }) => rows.set(where.key, { id: where.key, ...(rows.has(where.key) ? update : create) }),
    findUnique: async ({ where }) => rows.get(where.key),
    updateMany: async ({ where, data }) => { const v = rows.get(where.key); if (v?.value_json === where.value_json) rows.set(where.key, { ...v, ...data }); },
  } };
  const oc = old.capturePricingWorkerCapability(a), nc = next.capturePricingWorkerCapability(b);
  await old.renewPricingWorkerCapability(client, oc); await next.renewPricingWorkerCapability(client, nc);
  assert.equal(rows.size, 2); assert.equal((await old.assertPricingImageConsumerReady(client)).source, a);
  assert.equal((await next.assertPricingImageConsumerReady(client)).source, b);
  const good = rows.get('pricing_worker_capability_v1:image:' + b).value_json;
  for (const patch of [{ expiresAt: new Date(0).toISOString() }, { source: a }, { loadedModuleSha: {} }, { instance: { ...nc.instance, start: 'wrong' } }]) {
    await assert.rejects(() => next.assertPricingImageConsumerReady(client, JSON.stringify({ ...JSON.parse(good), ...patch })));
  }
  await next.revokePricingWorkerCapability(client, nc); await assert.rejects(() => next.assertPricingImageConsumerReady(client));
  assert.equal((await old.assertPricingImageConsumerReady(client)).source, a);
  checks.push('old/new pricing capabilities coexist; source/module/process/expiry checks and CAS revocation remain effective');
}

// Real nginx HUP + two actual HTTP servers. ALL logs/pid/temp paths are private.
const nginx = process.argv[3] || '/opt/homebrew/bin/nginx', dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-seamless-'));
fs.chmodSync(dir, 0o755); // root-run Linux nginx workers can read only this dummy fixture tree.
for (const name of ['body', 'proxy', 'fastcgi', 'uwsgi', 'scgi']) fs.mkdirSync(path.join(dir, name));
fs.mkdirSync(path.join(dir, 'assets')); fs.writeFileSync(path.join(dir, 'assets/old-hash.js'), 'old-asset');
fs.writeFileSync(path.join(dir, 'assets/new-hash.js'), 'new-asset');
let releaseSlow, slowEntered;
const entered = new Promise(r => { slowEntered = r; }), slow = new Promise(r => { releaseSlow = r; });
const writes = new Map();
const server = kind => http.createServer(async (req, res) => {
  if (req.url === '/slow') { slowEntered(); await slow; res.end(kind + '-slow'); return; }
  if (req.method === 'POST') { let body = ''; for await (const chunk of req) body += chunk;
    const id = req.headers['x-request-id']; writes.set(id, (writes.get(id) || 0) + 1); res.end(JSON.stringify({ kind, body })); return; }
  res.end(kind);
});
const oldServer = server('old'), nextServer = server('new');
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', r));
await listen(oldServer); await listen(nextServer);
const reserve = http.createServer(); await listen(reserve); const port = reserve.address().port; await new Promise(r => reserve.close(r));
const config = path.join(dir, 'nginx.conf');
const site = `server { listen 127.0.0.1:${port}; add_header X-SD2-Origin fixture-origin always; ${renderRetainedStaticLocation(path.join(dir, 'assets'))} location / { proxy_pass http://127.0.0.1:3302; proxy_next_upstream off; proxy_read_timeout 30s; } }`;
const prefix = `worker_processes 1;\npid ${dir}/nginx.pid;\nerror_log ${dir}/error.log notice;\nevents { worker_connections 128; }\nhttp { access_log ${dir}/access.log combined;\nclient_body_temp_path ${dir}/body; proxy_temp_path ${dir}/proxy; fastcgi_temp_path ${dir}/fastcgi; uwsgi_temp_path ${dir}/uwsgi; scgi_temp_path ${dir}/scgi;\n`;
const render = target => prefix + renderRoute(site, target).replace(':3302;', ':' + oldServer.address().port + ';').replace(':3303;', ':' + nextServer.address().port + ';') + '\n}\n';
fs.writeFileSync(config, render(3302));
let worker;
const command = extra => spawnSync(nginx, ['-p', dir + '/', '-c', config, ...extra], { encoding: 'utf8' });
const wait = async predicate => { const end = Date.now() + 10000; while (!await predicate()) { if (Date.now() > end) throw new Error('Fixture readiness deadline'); await new Promise(r => setTimeout(r, 20)); } };
try {
  assert.equal(command(['-t']).status, 0);
  worker = spawn(nginx, ['-p', dir + '/', '-c', config, '-g', 'daemon off;'], { stdio: 'ignore' });
  await wait(async () => { try { return (await (await fetch('http://127.0.0.1:' + port)).text()) === 'old'; } catch { return false; } });
  const outstanding = fetch('http://127.0.0.1:' + port + '/slow').then(r => r.text()); await entered;
  let uploadResponse;
  const uploadDone = new Promise((resolve, reject) => {
    uploadResponse = http.request({ host: '127.0.0.1', port, path: '/upload', method: 'POST',
      headers: { 'Content-Length': 20000, 'x-request-id': 'buffered-before-reload' } }, res => { let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve(JSON.parse(data))); });
    uploadResponse.on('error', reject); uploadResponse.write('x'.repeat(10000));
  });
  await new Promise(r => setTimeout(r, 60));
  fs.writeFileSync(config, render(3303)); assert.equal(command(['-t']).status, 0); assert.equal(command(['-s', 'reload']).status, 0);
  await wait(async () => (await (await fetch('http://127.0.0.1:' + port)).text()) === 'new');
  const retained = await fetch('http://127.0.0.1:' + port + '/_next/static/old-hash.js');
  assert.equal(retained.headers.get('x-sd2-origin'), 'fixture-origin');
  assert.ok(retained.headers.get('cache-control').includes('max-age=31536000'));
  assert.equal(await retained.text(), 'old-asset');
  assert.equal(await (await fetch('http://127.0.0.1:' + port + '/_next/static/new-hash.js')).text(), 'new-asset');
  for (let n = 0; n < 8; n++) {
    const response = await fetch('http://127.0.0.1:' + port, { method: 'POST', body: 'original-body-' + n, headers: { 'x-request-id': String(n) } });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { kind: 'new', body: 'original-body-' + n });
  }
  uploadResponse.end('y'.repeat(10000)); const uploaded = await uploadDone;
  assert.equal(uploaded.kind, 'old'); assert.equal(uploaded.body.length, 20000);
  releaseSlow(); assert.equal(await outstanding, 'old-slow');
  assert.equal(writes.size, 9); assert.ok([...writes.values()].every(v => v === 1));
  fs.writeFileSync(config, render(3303) + '\nbad_directive;\n'); assert.notEqual(command(['-t']).status, 0);
  assert.equal(await (await fetch('http://127.0.0.1:' + port)).text(), 'new');
  fs.writeFileSync(config, render(3303));
  checks.push('real nginx: new requests cut over, long and buffered old requests finish, POST bodies/IDs execute once, bad config keeps live workers');
} finally {
  releaseSlow(); command(['-s', 'quit']);
  if (worker) await new Promise(resolve => { if (worker.exitCode !== null) return resolve(); worker.once('exit', resolve); setTimeout(() => { worker.kill('SIGTERM'); resolve(); }, 3000).unref(); });
  oldServer.closeAllConnections(); nextServer.closeAllConnections(); await Promise.all([new Promise(r => oldServer.close(r)), new Promise(r => nextServer.close(r))]);
}
console.log(JSON.stringify({ schema: 'sd2-seamless-engineering.v1', checks: checks.length, passed: checks, nginxArtifactDirectory: dir,
  productionWrites: 0, providersCalled: 0, businessDataTouched: false }, null, 2));
