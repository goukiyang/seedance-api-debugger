import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { inspectHdClosedExecutionCache, assertHdClosedProcessor, assertHdE01CacheSourceProof, readHdTsxCompilerClosure } from './hd-storage-preflight.mjs';

assert.equal(process.platform, 'linux');
if (process.argv.length > 3) {
  const currentReference = '/data/video-api-debugger/var-lib/storage/hd-derivatives/.runs/211d0674b51add76e250295423820aacd142756e819b142dc3c7919785bfd958.79998650-4be5-42ee-86a6-58ba31ab7900/tsx-1004';
  const e00Reference = '/data/video-api-debugger/var-lib/storage/hd-derivatives/.runs/d4df046a30690c5ac49f7d4bac69f321f5b6a1e33d77ca380be0c9a8f160a855.b05e6587-b7b7-43f0-b189-a78d5740f1c4/tsx-1004';
  const projectListReference = '/data/video-api-debugger/var-lib/storage/hd-derivatives/.runs/776498a981de0401bcc0d96eda79b5cc76c8d4a869dbab4023aa799dd56a81c2.3f90e93b-dfd9-4c84-9a05-6658edd776bb/tsx-1004';
  const projectDesignReference = '/data/video-api-debugger/var-lib/storage/hd-derivatives/.runs/986dc0135334f942acbbf4495f99658fdd173173bb2740ad194944caa0a58a73.7c11928c-bb6a-4417-97fd-56728f053d2c/tsx-1004';
  const sizeLogReference = '/data/video-api-debugger/var-lib/storage/hd-derivatives/.runs/a62c2e2204ec04289f237d5a7255e348aec0396fef1e464db1bb9838c07c3148.864ee5d2-65fa-405c-bf6d-fd18626d7c79/tsx-1004';
  const references = [...new Set([...process.argv.slice(2), currentReference, e00Reference, projectListReference, projectDesignReference, sizeLogReference])];
  const outcomes = references.map(reference => JSON.parse(execFileSync(process.execPath,
    [process.argv[1], reference], { encoding: 'utf8', timeout: 120000 })));
  assert.ok(outcomes.every(value => value.ok && value.productionWrites === 0 && value.originalFilesDeleted === 0));
  console.log(JSON.stringify({ schema: 'hd-closed-tsx-cache-engineering-batch.v1', ok: true, outcomes,
    count: outcomes.reduce((total, value) => total + value.count, 0), productionWrites: 0, services: 0 }));
  process.exit(0);
}
const references = process.argv[2];
assert.equal(fs.realpathSync(references), references);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-hd-storage-engineering-closed-'));
fs.chmodSync(directory, 0o700);
const root = path.join(directory, 'jobs'), key = 'a'.repeat(64), executionId = randomUUID(), run = key + '.' + executionId;
const runPath = path.join(root, '.runs', run), cachePath = path.join(runPath, 'tsx-' + process.getuid());
const started = Date.now() - 1000, checks = [];
const processor = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  "import fs from 'node:fs';const t=fs.readFileSync('/proc/self/stat','utf8');console.log(JSON.stringify({pid:process.pid,startTicks:t.slice(t.lastIndexOf(')')+2).trim().split(/\\s+/)[19]}))"], { encoding: 'utf8' }));
Object.assign(processor, { groupId: processor.pid, host: os.hostname(), executionId });
fs.mkdirSync(cachePath, { recursive: true, mode: 0o700 });
const names = [];
for (const name of fs.readdirSync(references).sort()) {
  assert.match(name, /^\d+-[a-f0-9]{40}$/);
  const target = Math.floor(Date.now() / 1e8) + '-' + name.split('-')[1];
  fs.copyFileSync(path.join(references, name), path.join(cachePath, target));
  fs.chmodSync(path.join(cachePath, target), 0o600); names.push(target);
}
assert.equal(names.length, 3);
const uid = process.getuid(), gid = process.getgid(), l = { uid, gid, dataDevice: fs.statSync(root).dev };
let job;
const save = (status = 'ready') => {
  const latest = Math.max(...[runPath, cachePath, ...names.map(name => path.join(cachePath, name))]
    .flatMap(file => { const s = fs.lstatSync(file); return [s.mtimeMs, s.ctimeMs]; }));
  while (Date.now() <= Math.ceil(latest)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  const time = Date.now();
  job = { key, executionId, processor, protocol: 'hd-job-v2', status, attempts: 1, version: 'synthetic-version',
    executionExitedAt: new Date(time - 1).toISOString(), updatedAt: new Date(time).toISOString(),
    attemptHistory: [{ attempt: 1, status, sourceVersion: 'synthetic-version', startedAt: new Date(started).toISOString(), finishedAt: new Date(time).toISOString() }] };
  fs.writeFileSync(path.join(root, key + '.json'), JSON.stringify(job), { mode: 0o600 });
};
const inspect = () => inspectHdClosedExecutionCache(root, run, l, job);
const reject = name => { assert.throws(inspect); checks.push(name); };
const baseline = () => { save(); assert.equal(inspect().readOnly, true); };
// Scope this offline fixture's process namespace, not the production reader.
// Every admitted PID still uses its real stat/cmdline/environ; owned negative
// children remain visible until their original exit has been observed.
const originalProcReaddir = fs.readdirSync, fixtureProcessIds = new Set([process.pid]);
try {
  fs.readdirSync = function (target, ...args) {
    const entries = originalProcReaddir.call(this, target, ...args);
    return target === '/proc' ? entries.filter(name => !/^\d+$/.test(name) || fixtureProcessIds.has(Number(name))) : entries;
  };
  // Exercise the actual closure reader with module syntax, including the
  // literal CJS registration used by tsx 4.21.0. These files are read, not run.
  const closureRoot = path.join(directory, 'compiler-closure'), closurePackage = closureRoot + '/node_modules/tsx';
  const closureSources = {
    'package.json': JSON.stringify({ name: 'tsx', version: '4.21.0', exports: { '.': './dist/loader.mjs' } }),
    'dist/loader.mjs': String.raw`import{r}from"./register.mjs";import"./index-gbaejti9.mjs";export{x}from"./index-7AaEi15b.mjs";
r("./cjs/index.cjs");import("./dynamic.mjs");import(".\x2fescaped.mjs");new URL("./url.mjs",import.meta.url);
const findPackageJson=async t=>{let e=new URL("package.json",t);e=new URL("../package.json",e);return e;};
const runtimeModuleUrl=e=>new URL("./runtime-only.mjs",e);
const derivedModuleUrl=new URL("./derived-only.mjs",import.meta.url+"/runtime/");
const text="require('./ignored.cjs')";const regexp=/import\("\.\/ignored.mjs"\)/;
// import "./comment.mjs";
/* require("./comment.cjs"); */` + '\nconst template=' + '`text ${import("./expression.mjs")}`;',
    'dist/register.mjs': 'export function r(file){}',
    'dist/index-gbaejti9.mjs': 'export * from "./cycle.mjs";',
    'dist/index-7AaEi15b.mjs': 'export const x=1;',
    'dist/cycle.mjs': 'import "./index-gbaejti9.mjs";',
    'dist/cjs/index.cjs': 'module.exports=require("../required.cjs");',
    'dist/required.cjs': 'module.exports={};',
    'dist/dynamic.mjs': 'export const dynamic=true;',
    'dist/escaped.mjs': 'export const escaped=true;',
    'dist/url.mjs': 'export const url=true;',
    'dist/expression.mjs': 'export const expression=true;',
  };
  for (const [relative, bytes] of Object.entries(closureSources)) {
    const file = closurePackage + '/' + relative; fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  }
  const closureRead = file => {
    assert.equal(fs.realpathSync(file), file); const before = fs.lstatSync(file);
    assert.ok(before.isFile() && before.uid === uid && before.nlink === 1 && !(before.mode & 0o022));
    const identity = stat => Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, stat[key]]));
    const bytes = fs.readFileSync(file); assert.deepEqual(identity(fs.lstatSync(file)), identity(before));
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), identity: identity(before) };
  };
  const closure = () => readHdTsxCompilerClosure(closureRoot, closureRead), originalClosure = closure();
  assert.deepEqual(originalClosure.files.map(item => path.relative(closurePackage, item.file)).sort(), Object.keys(closureSources).sort());
  assert.deepEqual(closure(), originalClosure);
  checks.push('compiler_loader_esm_cjs_registration_dynamic_require_exports_templates_cycles_and_decoys_have_exact_closure');
  const registered = closurePackage + '/dist/cjs/index.cjs', heldRegistered = registered + '.held';
  fs.renameSync(registered, heldRegistered); assert.throws(closure); fs.renameSync(heldRegistered, registered);
  const beforeChange = closure(); fs.appendFileSync(registered, '\n/* changed compiler entity */');
  assert.notDeepEqual(closure(), beforeChange); fs.writeFileSync(registered, closureSources['dist/cjs/index.cjs']);
  fs.chmodSync(registered, 0o666); assert.throws(closure); fs.chmodSync(registered, 0o600);
  fs.renameSync(registered, heldRegistered); fs.symlinkSync(heldRegistered, registered); assert.throws(closure);
  fs.unlinkSync(registered); fs.renameSync(heldRegistered, registered);
  const loader = closurePackage + '/dist/loader.mjs'; fs.appendFileSync(loader, '\nimport "../../../outside.mjs";');
  assert.throws(closure); fs.writeFileSync(loader, closureSources['dist/loader.mjs']);
  checks.push('compiler_entire_closure_changes_missing_cjs_alias_modes_and_package_escape_are_refused');
  assert.throws(() => assertHdE01CacheSourceProof({})); checks.push('unproven_published_source_refused');
  const e01 = '/data/video-api-debugger/managed-releases/e01fb18045e2950b45323b4d4ca7f6ce143a2019/';
  const sourceFiles = ['scripts/process-hd-image.ts', 'src/lib/media/hd-image-processor.ts', 'src/lib/media/hd-encoder.ts',
    'node_modules/tsx/dist/index-7AaEi15b.mjs', 'tsconfig.json'];
  const sourceProof = Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(e01 + file)).digest('hex')]));
  assertHdE01CacheSourceProof(sourceProof); checks.push('published_source_and_compiler_verified');
  for (const file of sourceFiles) {
    assert.throws(() => assertHdE01CacheSourceProof({ ...sourceProof, [file]: '0'.repeat(64) }));
    checks.push('changed_' + file + '_refused');
  }
  const currentRoot = '/data/video-api-debugger/managed-releases/91943a8ade19cf11cc9fd4a923d56dc3eef318c7/';
  const currentProof = Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(currentRoot + file)).digest('hex')]));
  assertHdE01CacheSourceProof(currentProof); checks.push('current_published_source_and_compiler_verified');
  for (const file of sourceFiles) {
    assert.throws(() => assertHdE01CacheSourceProof({ ...currentProof, [file]: '0'.repeat(64) }));
    checks.push('changed_current_' + file + '_refused');
  }
  const designRoot = '/data/video-api-debugger/managed-releases/4fb7f841ec05f38759bede3e3b4bea73e19c027f/';
  const designProof = Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(designRoot + file)).digest('hex')]));
  assertHdE01CacheSourceProof(designProof); checks.push('project_design_published_source_and_compiler_verified');
  for (const file of sourceFiles) {
    assert.throws(() => assertHdE01CacheSourceProof({ ...designProof, [file]: '0'.repeat(64) }));
    checks.push('changed_project_design_' + file + '_refused');
  }
  const sizeLogRoot = '/data/video-api-debugger/managed-releases/31bff5a6544a3d18d433b81fa7735ed57b0d012c/';
  const sizeLogProof = Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(sizeLogRoot + file)).digest('hex')]));
  assertHdE01CacheSourceProof(sizeLogProof); checks.push('size_log_published_source_and_compiler_verified');
  for (const file of sourceFiles) {
    assert.throws(() => assertHdE01CacheSourceProof({ ...sizeLogProof, [file]: '0'.repeat(64) }));
    checks.push('changed_size_log_' + file + '_refused');
  }
  for (const status of ['ready', 'failed', 'skipped']) { save(status); assert.equal(inspect().status, status); checks.push('closed_' + status); }
  const bytesBefore = Object.fromEntries(names.map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(cachePath, name))).digest('hex')]));
  baseline(); assert.deepEqual(Object.fromEntries(names.map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(cachePath, name))).digest('hex')])), bytesBefore);
  checks.push('all_original_reference_bytes_preserved');
  for (const status of ['queued', 'running', 'cancelled']) { save(status); reject('status_' + status + '_refused'); }
  baseline(); delete job.executionExitedAt; reject('missing_exit_refused');
  baseline(); job.executionId = randomUUID(); reject('other_execution_refused');
  baseline(); delete job.processor; reject('missing_processor_refused');
  baseline(); job.processor = { ...processor, host: 'unknown-host' }; reject('other_host_refused');
  baseline(); job.processor = { ...processor, pid: process.pid, groupId: process.pid }; reject('live_same_name_pid_refused');
  baseline(); job.processor = { ...processor, pid: process.pid, groupId: process.pid, startTicks: '1' }; reject('pid_reuse_refused');
  assert.throws(() => assertHdClosedProcessor(processor, executionId, [{ pid: processor.pid + 1, group: processor.groupId, startTicks: '1' }]));
  checks.push('remaining_group_member_refused');
  baseline(); job.attemptHistory[0].finishedAt = undefined; reject('missing_finished_attempt_refused');
  baseline(); job.attemptHistory[0].sourceVersion = 'other'; reject('other_source_version_refused');
  baseline(); job.executionExitedAt = new Date(Date.now() + 60000).toISOString(); reject('future_exit_refused');
  for (const suffix of ['.lock', '.publish.json', '.webp.unknown.tmp']) {
    baseline(); const file = path.join(root, key + suffix); fs.writeFileSync(file, 'unknown'); reject('present_' + suffix + '_refused'); fs.unlinkSync(file);
  }
  baseline(); const dangling = path.join(root, key + '.lock'); fs.symlinkSync('/does-not-exist', dangling); reject('dangling_lease_refused'); fs.unlinkSync(dangling);
  baseline(); const unknown = path.join(runPath, 'unknown'); fs.writeFileSync(unknown, 'x'); reject('unknown_run_entry_refused'); fs.unlinkSync(unknown);
  baseline(); const extra = path.join(cachePath, 'unknown'); fs.writeFileSync(extra, '{}'); reject('unknown_cache_filename_refused'); fs.unlinkSync(extra);
  baseline(); const file = path.join(cachePath, names[0]), original = fs.readFileSync(file);
  fs.writeFileSync(file, '{}'); reject('unknown_cache_content_refused'); fs.writeFileSync(file, original); baseline();
  const held = file + '.held'; fs.renameSync(file, held); fs.symlinkSync(held, file); reject('cache_symlink_refused'); fs.unlinkSync(file); fs.renameSync(held, file); baseline();
  const link = path.join(directory, 'hardlink'); fs.linkSync(file, link); reject('cache_hardlink_refused'); fs.unlinkSync(link); baseline();
  fs.chmodSync(file, 0o666); reject('cache_writable_mode_refused'); fs.chmodSync(file, 0o600); baseline();
  if (uid === 0) { fs.chownSync(file, 1, 1); reject('cache_foreign_owner_refused'); fs.chownSync(file, uid, gid); baseline(); }
  fs.utimesSync(file, new Date(started - 10000), new Date(started - 10000)); reject('cache_outside_attempt_refused');
  fs.utimesSync(file, new Date(), new Date()); baseline();
  const read = fs.readFileSync;
  fs.readFileSync = function (target, ...args) {
    const value = read.call(this, target, ...args);
    if (typeof target === 'number' && fs.realpathSync('/proc/self/fd/' + target) === path.join(root, key + '.json'))
      fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
    return value;
  };
  try { reject('cache_changes_during_job_reread_refused'); } finally { fs.readFileSync = read; }
  fs.utimesSync(file, new Date(), new Date()); baseline();
  const runHeld = runPath + '.held'; fs.renameSync(runPath, runHeld); fs.symlinkSync(runHeld, runPath); reject('run_alias_refused'); fs.unlinkSync(runPath); fs.renameSync(runHeld, runPath); baseline();
  const cacheHeld = cachePath + '.held'; fs.renameSync(cachePath, cacheHeld); fs.symlinkSync(cacheHeld, cachePath); reject('cache_directory_alias_refused'); fs.unlinkSync(cachePath); fs.renameSync(cacheHeld, cachePath); baseline();
  fs.writeFileSync(path.join(root, key + '.json'), JSON.stringify({ ...job, status: 'failed' })); reject('job_changed_refused');
  baseline();
  const sizeLogSource = '/data/video-api-debugger/managed-releases/31bff5a6544a3d18d433b81fa7735ed57b0d012c/';
  const sizeLogArtifacts = names.every(name => JSON.parse(fs.readFileSync(path.join(cachePath, name))).map.sources[0].startsWith(sizeLogSource));
  if (sizeLogArtifacts) {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test'; l.isolated = true;
    const latestExecutionId = randomUUID(), rewrite = () => fs.writeFileSync(path.join(root, key + '.json'), JSON.stringify(job), { mode: 0o600 });
    const saveSuperseded = () => {
      const states = [runPath, cachePath, ...fs.readdirSync(cachePath).map(name => path.join(cachePath, name))]
        .map(file => fs.lstatSync(file));
      const latestCache = Math.max(...states.flatMap(stat => [stat.mtimeMs, stat.ctimeMs]));
      while (Date.now() <= Math.ceil(latestCache) + 5) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      const now = Date.now();
      job = { key, executionId: latestExecutionId, processor: { ...processor, executionId: latestExecutionId },
        protocol: 'hd-job-v2', status: 'ready', attempts: 2, version: 'synthetic-version',
        executionExitedAt: new Date(now - 1).toISOString(), updatedAt: new Date(now).toISOString(),
        attemptHistory: [
          { attempt: 1, status: 'queued', reason: 'encode_timeout', sourceVersion: 'synthetic-version',
            startedAt: new Date(started).toISOString(), finishedAt: new Date(now - 4).toISOString() },
          { attempt: 2, status: 'ready', sourceVersion: 'synthetic-version',
            startedAt: new Date(now - 3).toISOString(), finishedAt: new Date(now).toISOString() },
        ] };
      rewrite();
    };
    const inspectSuperseded = proof => inspectHdClosedExecutionCache(root, run, l, job, undefined, proof);
    const rejectSuperseded = (name, change) => {
      saveSuperseded(); change(); rewrite(); assert.throws(() => inspectSuperseded()); checks.push(name);
    };
    const withChild = async (kind, action) => {
      const alias = path.join(directory, 'runs-alias');
      if (kind === 'tmpdir-alias') fs.symlinkSync(path.join(root, '.runs'), alias);
      const temporary = kind === 'tmpdir' ? path.join(root, '.runs', run)
        : kind === 'tmpdir-root' ? path.join(root, '.runs')
          : kind === 'tmpdir-resolved' ? root + '/.runs/../.runs/' + run
            : kind === 'tmpdir-alias' ? path.join(alias, run) : null;
      const child = spawn(process.execPath, ['-e', "process.send('ready');const timer=setInterval(()=>{},1000);process.on('message',v=>{if(v==='exit'){clearInterval(timer);process.disconnect();}})",
        ...(temporary ? [] : [kind])], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env,
          ...(temporary ? { TMPDIR: temporary } : {}) },
      });
      fixtureProcessIds.add(child.pid);
      const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      await new Promise((resolve, rejectReady) => { child.once('message', resolve); child.once('error', rejectReady); });
      try { action(child); }
      finally {
        child.send('exit'); assert.deepEqual(await exited, { code: 0, signal: null });
        fixtureProcessIds.delete(child.pid);
        if (kind === 'tmpdir-alias') fs.unlinkSync(alias);
      }
    };
    try {
      saveSuperseded();
      const pending = inspectSuperseded();
      assert.equal(pending.proofKind, 'superseded-attempt-whole-service-drain');
      assert.equal(pending.historicalPidKnown, false); assert.equal(pending.historicalExitReceipt, false);
      assert.equal(pending.accepted, false); assert.equal(pending.pendingWholeDrain, true);
      assert.equal(pending.executionId, executionId); assert.equal(pending.latestExecutionId, latestExecutionId);
      assert.deepEqual(pending.processProof, { complete: true, hdChildrenAbsent: true, privateRunProcessesAbsent: true });
      checks.push('superseded_exact_timeout_cache_without_drain_is_pending_not_accepted');
      // This is a synthetic producer-shaped value for the consumer contract.
      // It never proves a real systemd drain; release still needs inspectRetiredHdCaches's live receipt.
      const drained = { schema: 'specific-retired-hd-cache.v1', runId: randomUUID(), phase: 'drained', accepted: true,
        historicalPidsRecovered: false, exactObjectCount: 4, readOnly: true,
        authorization: 'Synthetic consumer structure only; no production whole-service drain is claimed',
        entries: Array.from({ length: 4 }, (_, index) => ({
          run: createHash('sha256').update('synthetic-retired-' + index).digest('hex') + '.' + randomUUID(),
          jobSha256: pending.jobSha256, directory: pending.directory, cache: pending.cache, files: pending.files })),
        drain: { state: { ActiveState: 'inactive', MainPID: '0', ControlPID: '0', Result: 'success', Restart: 'no',
          SendSIGKILL: 'no', TimeoutStopUSec: 'infinity', WorkingDirectory: sizeLogSource.slice(0, -1) },
          cgroupEmpty: true, originalPidAbsent: true, relatedProcessorsAbsent: true,
          method: 'current-whole-service-natural-drain-not-historical-PID-reconstruction' } };
      for (const phase of [undefined, 'admission', 'unknown']) {
        const observed = inspectSuperseded({ ...drained, phase });
        assert.equal(observed.accepted, false); assert.equal(observed.pendingWholeDrain, true);
      }
      const accepted = inspectSuperseded(drained);
      assert.equal(accepted.accepted, true); assert.equal(accepted.pendingWholeDrain, false);
      assert.equal(accepted.historicalPidKnown, false); assert.equal(accepted.historicalExitReceipt, false);
      checks.push('superseded_drained_consumer_structure_only_and_admission_stays_pending');
      for (const [field, value] of Object.entries({ ActiveState: 'active', MainPID: String(process.pid), ControlPID: '77', Result: 'timeout',
        Restart: 'on-failure', SendSIGKILL: 'yes', TimeoutStopUSec: '3min', WorkingDirectory: '/unknown-source' })) {
        assert.throws(() => inspectSuperseded({ ...drained, drain: { ...drained.drain, state: { ...drained.drain.state, [field]: value } } }));
        const state = { ...drained.drain.state }; delete state[field];
        assert.throws(() => inspectSuperseded({ ...drained, drain: { ...drained.drain, state } }));
      }
      for (const field of ['cgroupEmpty', 'originalPidAbsent', 'relatedProcessorsAbsent']) {
        assert.throws(() => inspectSuperseded({ ...drained, drain: { ...drained.drain, [field]: false } }));
        const drain = { ...drained.drain }; delete drain[field]; assert.throws(() => inspectSuperseded({ ...drained, drain }));
      }
      for (const proof of [{ ...drained, accepted: false }, { ...drained, historicalPidsRecovered: true },
        { ...drained, schema: 'forged' }, { ...drained, runId: 'unknown' }, { ...drained, drain: null },
        { ...drained, drain: { ...drained.drain, method: 'historical-pid-guess' } }]) assert.throws(() => inspectSuperseded(proof));
      checks.push('superseded_incomplete_forged_or_active_whole_drain_structures_refused');
      rejectSuperseded('superseded_latest_pid_still_live_refused', () => { job.processor = { ...job.processor, pid: process.pid, groupId: process.pid }; });
      for (const kind of ['tmpdir', 'tmpdir-root', 'tmpdir-resolved', 'tmpdir-alias', 'process-hd-image.ts', 'ffmpeg']) {
        saveSuperseded(); await withChild(kind, () => assert.throws(() => inspectSuperseded(drained)));
        checks.push('superseded_live_' + kind.replace(/[^a-z]/g, '_') + '_refused');
      }
      saveSuperseded();
      const originalRead = fs.readFileSync; let deniedReads = 0;
      fs.readFileSync = function (target, ...args) {
        if (target === '/proc/' + process.pid + '/environ') { deniedReads++; throw Object.assign(new Error('Synthetic environment read denied'), { code: 'EACCES' }); }
        return originalRead.call(this, target, ...args);
      };
      try { assert.throws(() => inspectSuperseded(drained)); assert.equal(deniedReads, 1); }
      finally { fs.readFileSync = originalRead; }
      checks.push('superseded_unknown_proc_environment_read_refused');
      for (const status of ['queued', 'failed', 'skipped', 'ready']) {
        saveSuperseded(); job.attemptHistory[0].status = status; job.attemptHistory[0].reason = 'legacy-known-failure'; rewrite();
        assert.equal(inspectSuperseded().pendingWholeDrain, true);
      }
      checks.push('any_unique_compliant_legacy_closed_interval_stays_pending_without_invented_pid_or_exit');
      rejectSuperseded('superseded_unfinished_historical_interval_refused', () => { job.attemptHistory[0].status = 'running'; });
      rejectSuperseded('superseded_incomplete_attempt_sequence_refused', () => { job.attemptHistory[0].attempt = 2; });
      rejectSuperseded('superseded_overlapping_attempts_refused', () => { job.attemptHistory[1].startedAt = job.attemptHistory[0].finishedAt; });
      rejectSuperseded('superseded_ambiguous_timeout_intervals_refused', () => {
        const first = { ...job.attemptHistory[0] }; job.attemptHistory = [first, { ...first, attempt: 2 }, { ...job.attemptHistory[1], attempt: 3 }]; job.attempts = 3;
      });
      rejectSuperseded('superseded_other_source_version_refused', () => { job.attemptHistory[0].sourceVersion = 'other-version'; });
      rejectSuperseded('superseded_cache_outside_historical_interval_refused', () => { job.attemptHistory[0].startedAt = job.attemptHistory[0].finishedAt; });
      const saveIdentified = (verification = false) => {
        saveSuperseded(); const first = job.attemptHistory[0], observedAt = first.finishedAt;
        const record = { executionId, sourceVersion: job.version, startedAt: first.startedAt, finishedAt: first.finishedAt,
          processor: { ...processor }, childClose: { executionId, code: 7, signal: null, observedAt },
          groupExit: { executionId, confirmedAt: observedAt, evidenceKind: 'process-group-gone' } };
        if (verification) job.verificationHistory = [{ ...record, operation: 'validate' }];
        else Object.assign(first, record);
        rewrite(); return verification ? job.verificationHistory[0] : first;
      };
      for (const verification of [false, true]) {
        saveIdentified(verification); const closed = inspectSuperseded();
        assert.equal(closed.accepted, true); assert.equal(closed.pendingWholeDrain, false);
        assert.equal(closed.historicalPidKnown, true); assert.equal(closed.historicalExitReceipt, true);
        assert.equal(closed.historyKind, verification ? 'verification' : 'encode');
        assert.equal(closed.historicalAttempt.childClose.code, 7, 'Never manufacture a successful close');
        for (const field of ['processor', 'childClose', 'groupExit']) {
          const record = saveIdentified(verification); delete record[field]; rewrite();
          const unknown = inspectSuperseded(); assert.equal(unknown.accepted, false); assert.equal(unknown.pendingWholeDrain, true);
        }
        let record = saveIdentified(verification); record.processor.executionId = randomUUID(); rewrite(); assert.throws(() => inspectSuperseded());
        record = saveIdentified(verification); record.childClose.executionId = latestExecutionId; rewrite(); assert.throws(() => inspectSuperseded());
        record = saveIdentified(verification); record.groupExit.evidenceKind = 'assumed-close'; rewrite(); assert.throws(() => inspectSuperseded());
        saveIdentified(verification); job.verificationHistory = [...(job.verificationHistory || []), { ...job.attemptHistory[0], executionId, operation: 'validate' }];
        rewrite(); assert.throws(() => inspectSuperseded());
      }
      checks.push('encode_and_independent_verification_match_unique_execution_and_preserve_real_close_or_unknown');
      saveSuperseded(); l.isolated = false; assert.throws(() => inspectSuperseded(drained)); l.isolated = true;
      process.env.NODE_ENV = 'production'; assert.throws(() => inspectSuperseded(drained)); process.env.NODE_ENV = 'test';
      checks.push('superseded_noncanonical_or_fork_root_and_non_test_isolation_refused');
      const bytes = fs.readFileSync(file); fs.writeFileSync(file, '{}'); saveSuperseded();
      assert.throws(() => inspectSuperseded(drained)); fs.writeFileSync(file, bytes);
      saveSuperseded(); const missing = path.join(directory, 'held-closed-cache'); fs.renameSync(file, missing);
      saveSuperseded(); assert.equal(inspectSuperseded().pendingWholeDrain, true); fs.renameSync(missing, file);
      checks.push('superseded_bad_bytes_refused_and_cache_count_alone_never_proves_historical_exit');
      saveSuperseded();
      const readSource = fs.readFileSync; let wrongSource = 0;
      fs.readFileSync = function (target, ...args) {
        if (typeof target === 'number' && fs.realpathSync('/proc/self/fd/' + target) === sizeLogSource + 'src/lib/media/hd-derivatives.ts') {
          wrongSource++; return Buffer.from('synthetic-untrusted-retry-source');
        }
        return readSource.call(this, target, ...args);
      };
      try { assert.throws(() => inspectSuperseded(drained)); assert.equal(wrongSource, 1); }
      finally { fs.readFileSync = readSource; }
      checks.push('superseded_untrusted_retry_source_refused');
      // Other already-proven source artifacts use the same generic legacy
      // interval/whole-drain contract, not a newly added run-directory list.
      const otherReference = '/data/video-api-debugger/var-lib/storage/hd-derivatives/.runs/211d0674b51add76e250295423820aacd142756e819b142dc3c7919785bfd958.79998650-4be5-42ee-86a6-58ba31ab7900/tsx-1004';
      const originals = Object.fromEntries(names.map(name => [name, fs.readFileSync(path.join(cachePath, name))]));
      for (const name of fs.readdirSync(cachePath)) fs.unlinkSync(path.join(cachePath, name));
      try {
        for (const name of fs.readdirSync(otherReference)) {
          const destination = Math.floor(Date.now() / 1e8) + '-' + name.split('-')[1];
          fs.copyFileSync(path.join(otherReference, name), path.join(cachePath, destination)); fs.chmodSync(path.join(cachePath, destination), 0o600);
        }
        saveSuperseded(); assert.equal(inspectSuperseded().pendingWholeDrain, true);
        assert.equal(inspectSuperseded(drained).accepted, true);
      } finally {
        for (const name of fs.readdirSync(cachePath)) fs.unlinkSync(path.join(cachePath, name));
        for (const [name, value] of Object.entries(originals)) fs.writeFileSync(path.join(cachePath, name), value, { mode: 0o600 });
      }
      checks.push('superseded_other_existing_proven_source_uses_generic_whole_drain');
      saveSuperseded(); assert.equal(inspectSuperseded().pendingWholeDrain, true);
    } finally {
      delete l.isolated;
      if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
    }
    baseline();
  }
  console.log(JSON.stringify({ schema: 'hd-closed-tsx-cache-engineering.v1', ok: true, checks, count: checks.length,
    productionWrites: 0, services: 0, originalFilesDeleted: 0, supersededCasesIncluded: sizeLogArtifacts,
    drainedConsumerStructureOnly: true, actualWholeServiceDrainProven: false,
    processInventoryScope: 'fixture-self-and-owned-children-real-proc', productionProcessAbsenceProven: false,
    cachePolicy: 'exact-observed-published-source-artifact-bytes-only' }));
} finally { fs.readdirSync = originalProcReaddir; fs.rmSync(directory, { recursive: true, force: true }); }
