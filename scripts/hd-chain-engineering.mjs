import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { HD_CHAIN_CHECKS, HD_CHAIN_CHILDREN, HD_CHAIN_FIXTURE_SOURCES } from './hd-chain-fixture-inputs.mjs';

const root = fs.realpathSync(process.cwd()), startedAt = Date.now();
const runId = process.env.IMAGE_RECOVERY_GATE_RUN_ID;
assert.match(runId || '', /^[a-f0-9-]{36}$/, 'Use the actual candidate engineering run');
const hash = value => createHash('sha256').update(value).digest('hex');
const sources = () => Object.fromEntries(HD_CHAIN_FIXTURE_SOURCES.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
const sourceSha256 = sources();
const base = path.join(root, '.role-tests'); fs.mkdirSync(base, { recursive: true, mode: 0o700 });
const directory = fs.mkdtempSync(path.join(base, 'hd-chain-')); fs.chmodSync(directory, 0o700);
const guard = path.join(directory, 'isolation.cjs');
// Engineering-process isolation only. No production code reads a testing flag.
fs.writeFileSync(guard, String.raw`
const fs=require('node:fs'), fsp=require('node:fs/promises'), path=require('node:path');
const {syncBuiltinESMExports}=require('node:module');
delete process.env.HD_DERIVATIVES_ROOT; delete process.env.HD_DERIVATIVES_DIR;
const hdRootAtImport=process.env.HD_DERIVATIVES_ROOT||null;
const allowed=fs.realpathSync(process.env.HD_CHAIN_PRIVATE_ROOT);
let forbiddenCalls=0, refusedWrites=0;
const originalWrite=fs.writeFileSync.bind(fs);
function inside(value){
 if(typeof value==='number')return;
 if(value instanceof URL)value=require('node:url').fileURLToPath(value);
 if(Buffer.isBuffer(value))value=value.toString();
 if(typeof value!=='string')throw Error('hd_fixture_invalid_write_target');
 const target=path.resolve(value); let parent=target;
 while(!fs.existsSync(parent)){const next=path.dirname(parent);if(next===parent)break;parent=next;}
 const real=fs.realpathSync(parent), final=path.resolve(real,path.relative(parent,target));
 if(final!==allowed&&!final.startsWith(allowed+path.sep)){refusedWrites++;throw Error('hd_fixture_write_outside_private_root');}
}
for(const key of ['writeFileSync','appendFileSync','mkdirSync','unlinkSync','rmdirSync','rmSync','chmodSync','chownSync','utimesSync','truncateSync','createWriteStream']){
 const fn=fs[key];fs[key]=function(file,...args){inside(file);return fn.call(this,file,...args);};
}
for(const key of ['renameSync','copyFileSync','linkSync','symlinkSync']){
 const fn=fs[key];fs[key]=function(from,to,...args){if(key==='renameSync')inside(from);inside(to);return fn.call(this,from,to,...args);};
}
for(const key of ['writeFile','appendFile','mkdir','unlink','rmdir','rm','chmod','chown','utimes','truncate']){
 const fn=fsp[key];fsp[key]=async function(file,...args){inside(file);return fn.call(this,file,...args);};
}
for(const key of ['rename','copyFile','link','symlink']){
 const fn=fsp[key];fsp[key]=async function(from,to,...args){if(key==='rename')inside(from);inside(to);return fn.call(this,from,to,...args);};
}
for(const target of [fs,fsp]){
 const name=target===fs?'openSync':'open',fn=target[name];
 target[name]=function(file,flags,...args){if(typeof flags==='number'?!!(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC)):typeof flags==='string'&&/[wa+]/.test(flags))inside(file);return fn.call(this,file,flags,...args);};
}
const blocked=()=>{forbiddenCalls++;throw Error('hd_fixture_real_network_forbidden');};
globalThis.fetch=blocked;
for(const name of ['node:http','node:https']){const m=require(name);m.request=blocked;m.get=blocked;}
require('node:dns').lookup=blocked;require('node:dns/promises').lookup=blocked;
syncBuiltinESMExports();
process.on('exit',()=>originalWrite(process.env.HD_CHAIN_SAFETY_RECEIPT,JSON.stringify({forbiddenCalls,refusedWrites,productionWrites:0,paidRequests:0,browserRuns:0,hdRootAtImport}),{mode:0o600,flag:'wx'}));
`, { mode: 0o600, flag: 'wx' });

function summaryOf(stdout) {
  const lines = stdout.trimEnd().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try { return JSON.parse(lines.slice(i).join('\n')); } catch { /* Skip an intermediate diagnostic JSON. */ }
  }
  throw new Error('HD child did not emit its completed assertion summary');
}
const outcomes = [], failures = [];
for (let index = 0; index < HD_CHAIN_CHILDREN.length; index++) {
  const file = HD_CHAIN_CHILDREN[index], privateRoot = path.join(directory, 'child-' + index);
  fs.mkdirSync(privateRoot, { mode: 0o700 });
  const safety = path.join(privateRoot, 'safety.json'), log = path.join(directory, 'child-' + index + '.log');
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: 'file:' + path.join(privateRoot, 'initial-isolated.db'),
    TMPDIR: privateRoot, TMP: privateRoot, TEMP: privateRoot,
    HD_CHAIN_PRIVATE_ROOT: privateRoot, HD_CHAIN_SAFETY_RECEIPT: safety };
  delete env.HD_DERIVATIVES_ROOT; delete env.HD_DERIVATIVES_DIR;
  const result = spawnSync(process.execPath, ['--require', guard, '--import', 'tsx', file], {
    cwd: root, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
  });
  const output = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(log, output, { mode: 0o600, flag: 'wx' });
  const row = { file, check: HD_CHAIN_CHECKS[index], completed: false, exitCode: result.status,
    signal: result.signal, log, logSha256: hash(output), safetyReceipt: safety, boundary: null, failure: null };
  if (fs.existsSync(safety)) row.boundary = JSON.parse(fs.readFileSync(safety));
  try {
    assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, 'HD child failed: ' + file);
    const boundary = row.boundary; assert.ok(boundary, 'A completed child must leave its original safety receipt');
    for (const key of ['forbiddenCalls', 'refusedWrites', 'productionWrites', 'paidRequests', 'browserRuns']) assert.equal(boundary[key], 0, key);
    assert.equal(boundary.hdRootAtImport, null);
    const summary = summaryOf(result.stdout || '');
    if (file === 'scripts/test-hd-stability.ts') {
      assert.ok(Array.isArray(summary.results));
      assert.ok(summary.results.length >= 25, 'Retain all 25 original HD stability cases');
      assert.equal(summary.total, summary.results.length); assert.equal(summary.passed, summary.total);
      assert.ok(summary.results.every(item => item.passed === true));
    } else {
      assert.equal(summary.completed, true); assert.ok(Array.isArray(summary.checks) && summary.checks.length > 0);
      assert.equal(new Set(summary.checks).size, summary.checks.length);
      assert.equal(summary.total, summary.checks.length); assert.equal(summary.passed, summary.total);
      if (Array.isArray(summary.results)) {
        assert.equal(summary.results.length, summary.total);
        assert.ok(summary.results.every(item => item.passed === true));
      }
    }
    row.summary = summary; row.safetySha256 = hash(fs.readFileSync(safety)); row.completed = true;
  } catch (error) {
    row.failure = error instanceof Error ? error.message : String(error); failures.push(row);
  }
  outcomes.push(row);
}
assert.deepEqual(sources(), sourceSha256, 'HD source changed during the unified engineering run');
const receipt = path.join(directory, 'receipt.json');
const counters = Object.fromEntries(['forbiddenCalls', 'productionWrites', 'paidRequests', 'browserRuns'].map(key =>
  [key, outcomes.every(row => row.boundary && Number.isSafeInteger(row.boundary[key]))
    ? outcomes.reduce((total, row) => total + row.boundary[key], 0) : null]));
const value = { schema: 'hd-chain-engineering.v1', synthetic: true, runId, candidateRoot: root,
  startedAt, finishedAt: Date.now(), completed: failures.length === 0,
  checks: HD_CHAIN_CHECKS, fixtureSha256: sourceSha256['scripts/hd-chain-engineering.mjs'], sourceSha256,
  outcomes, ...counters,
  isolation: 'per-child private filesystem, database, environment and denied real network',
  productionHdRootPassedToFixtures: false };
fs.writeFileSync(receipt, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
if (failures.length) { console.error(JSON.stringify({ completed: false, failures, receipt })); process.exitCode = 1; }
else console.log('HD chain engineering receipt: ' + receipt);
