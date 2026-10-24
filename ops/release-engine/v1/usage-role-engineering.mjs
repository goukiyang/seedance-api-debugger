import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertUsageRoleStart } from './usage-role-start.mjs';
import { assertUsageRoleExit } from './usage-role-control.mjs';

assert.equal(process.platform, 'linux');
const directory = path.dirname(fileURLToPath(import.meta.url));
const checks = [];
const contract = { schema: 'sd2-usage-role-start.v1', runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', appUid: 1004,
  schemaSha256: 'a'.repeat(64), releases: ['b', 'c'].map((letter, index) => ({
    source: letter.repeat(40), root: '/data/video-api-debugger/managed-releases/' + letter.repeat(40),
    version: index ? '0.101.0+admin-usage-guard.1' : '0.101.0', build: 'real-built-' + index,
    sourceSha256: { 'src/lib/admin/usage-attribution.ts': 'd'.repeat(64), 'src/lib/canvas-roles/execution.ts': 'e'.repeat(64) },
  })) };
for (const candidate of contract.releases) {
  const observed = { ...candidate, schemaSha256: contract.schemaSha256 };
  assert.equal(assertUsageRoleStart(contract, observed).sourceAndSchemaVerified, true);
  for (const change of [value => { value.source = 'f'.repeat(40); }, value => { value.build += '-old'; },
    value => { value.root = '/data/video-api-debugger/releases/' + candidate.source; },
    value => { value.version = '0.100.2'; }, value => { value.schemaSha256 = '0'.repeat(64); },
    value => { value.sourceSha256['src/lib/admin/usage-attribution.ts'] = '0'.repeat(64); }]) {
    const invalid = structuredClone(observed); change(invalid); assert.throws(() => assertUsageRoleStart(contract, invalid));
  }
}
checks.push('both_real_pair_shapes_reject_old_source_build_schema_or_writer');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-role-native-'));
let worker;
try {
  const program = String.raw`
const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),80));console.log('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','inherit']});
let stopping=false;
child.stdout.once('data',()=>console.log(JSON.stringify({pid:process.pid,child:child.pid})));
process.once('SIGTERM',()=>{stopping=true;child.kill('SIGTERM')});
child.once('exit',code=>{if(stopping&&code===0)process.exit(0);else process.exit(1)});
`;
  worker = spawn(process.execPath, ['-e', program], { detached: true, cwd: temporary,
    env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Isolated role worker did not start')), 10000);
    worker.once('error', reject); worker.stdout.once('data', bytes => { clearTimeout(timer); resolve(JSON.parse(bytes)); });
  });
  const exited = new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', (code, signal) => resolve({ code, signal })); });
  process.kill(-ready.pid, 'SIGTERM');
  const result = await exited; assert.deepEqual(result, { code: 0, signal: null });
  assert.equal(fs.existsSync('/proc/' + ready.pid), false); assert.equal(fs.existsSync('/proc/' + ready.child), false);
  const native = { MainPID: '0', ControlPID: '0', ActiveState: 'inactive', Result: 'success', ExecMainCode: '1', ExecMainStatus: '0' };
  const empty = { pidPresent: false, originalGroupPids: [], unitGroupPids: [] };
  assertUsageRoleExit(native, {}, empty);
  for (const invalid of [{ ...native, ExecMainCode: '2', ExecMainStatus: '9' }, { ...native, MainPID: String(ready.pid) },
    { ...native, ControlPID: '123' }, { ...native, ActiveState: 'deactivating' }]) assert.throws(() => assertUsageRoleExit(invalid, {}, empty));
  for (const invalid of [{ ...empty, pidPresent: true }, { ...empty, originalGroupPids: [ready.child] },
    { ...empty, unitGroupPids: [ready.pid] }]) assert.throws(() => assertUsageRoleExit(native, {}, invalid));
  checks.push('native_sigterm_waits_for_child_and_rejects_residual_or_forced_exit');
} finally {
  if (worker?.exitCode === null) { try { process.kill(-worker.pid, 'SIGTERM'); } catch {} }
  fs.rmSync(temporary, { recursive: true });
}
const source = fs.readFileSync(directory + '/switch.mjs', 'utf8');
const normal = source.slice(source.indexOf('export async function switchPair'));
assert.ok(normal.indexOf('await stopUsageRole(m);') < normal.indexOf('installed = installNginxMaintenance'));
assert.ok(normal.indexOf('await startUsageRole(m, kind)') < normal.indexOf('const restored = await restoreNginxMaintenance'));
assert.ok(source.includes("await startUsageRole(m, 'guard', () => check(m, 'guard'))"));
assert.ok(source.includes('const restoredRole = await restoreOriginalUsageRole'));
assert.ok(source.includes('roleProof: usageRoleProof(m)'));
assert.ok(source.includes('assertUsageRoleStopped(m);'));
assert.ok(fs.readFileSync(directory + '/common.mjs', 'utf8').includes('otherServices.role = inspectUsageRoleProtection(m)'));
const roleSource = fs.readFileSync(directory + '/usage-role-control.mjs', 'utf8');
assert.ok(roleSource.includes("assert.equal(current.TasksMax, '128')"));
assert.ok(!roleSource.includes("'-p', 'Environment'"));
assert.ok(roleSource.includes('SendSIGKILL=no\\nTimeoutStopSec=infinity'));
checks.push('normal_abort_guard_rollback_and_protection_are_actually_wired');

{
  const start = roleSource.indexOf('function roleJournalFile('), end = roleSource.indexOf('function noForce(', start);
  assert.ok(start > 0 && end > start);
  const bytes = new Map(), root = '/isolated-restored-role', proofSha256 = 'f'.repeat(64);
  const sha = value => requireHash(value);
  const requireHash = value => createHash('sha256').update(value).digest('hex');
  bytes.set(root + '/manifest.json', Buffer.from('isolated-manifest'));
  const oldFile = root + '/usage-role-transition-0001.json', oldBytes = Buffer.from('{"phase":"historical-restoration"}'); bytes.set(oldFile, oldBytes);
  const m = { stage: root, runId: 'isolated-restored-run' };
  const functions = new Function('assert', 'fs', 'bound', 'json', 'operationalRecordName', 'sha', 'rootFile', 'writeJsonExclusive',
    roleSource.slice(start, end) + '; return { journals, record };')(
    assert, { readdirSync: () => [...bytes.keys()].filter(file => file.startsWith(root + '/')).map(file => path.basename(file)) },
    (manifest, value) => { assert.equal(value.runId, manifest.runId); assert.equal(value.manifestSha256, sha(bytes.get(root + '/manifest.json'))); return value; },
    file => JSON.parse(bytes.get(file)), (manifest, name) => { assert.equal(manifest, m); return name + '-' + proofSha256; }, sha,
    file => { assert.ok(bytes.has(file)); return bytes.get(file); },
    (file, value) => { assert.equal(bytes.has(file), false); bytes.set(file, Buffer.from(JSON.stringify(value))); });
  assert.deepEqual(functions.journals(m), []);
  const first = functions.record(m, 'policy-intent'), firstFile = root + '/usage-role-transition-0001-' + proofSha256 + '.json';
  assert.equal(first.sequence, 1); assert.equal(first.previousSha256, null); assert.ok(bytes.has(firstFile));
  const second = functions.record(m, 'stopped'); assert.equal(second.sequence, 2); assert.equal(second.previousSha256, sha(bytes.get(firstFile)));
  assert.equal(functions.journals(m).length, 2); assert.deepEqual(bytes.get(oldFile), oldBytes);
  const captureStart = roleSource.indexOf('export function captureRestoredUsageRole('), captureEnd = roleSource.indexOf('\nfunction before(', captureStart);
  const identity = { unit: 'role.service', root: '/sealed/old-source', source: 'b'.repeat(40), version: '0.103.2', build: 'old-build',
    pid: 303, invocation: 'c'.repeat(32), execMainStartTimestampMonotonic: '1234567' };
  const captureM = { fullRelease: {}, privateMultiviewInstall: true, live: { role: { ...identity, pid: 101, invocation: 'd'.repeat(32) } } };
  const capture = new Function('assert', 'originalCapture', 'state', roleSource.slice(captureStart, captureEnd).replace('export ', '') + ';return captureRestoredUsageRole;')(
    assert, (manifest, expected) => { assert.equal(manifest, captureM); assert.equal(expected, identity); return { fresh: true }; },
    () => ({ MainPID: '303', InvocationID: identity.invocation, ExecMainStartTimestampMonotonic: identity.execMainStartTimestampMonotonic }));
  assert.deepEqual(capture(captureM, identity), { fresh: true });
  assert.throws(() => capture(captureM, { ...identity, source: 'e'.repeat(40) }));
  checks.push('actual_role_journal_bodies_append_new_identity_namespace_and_preserve_original_history');
  checks.push('actual_restored_capture_body_binds_new_invocation_without_changing_original_source_authority');
}

console.log(JSON.stringify({ schema: 'sd2-usage-role-engineering.v1', completed: true, checks,
  fixtureOnly: true, nativeSigtermExecuted: true, servicesChanged: false, productionWrites: 0,
  paidRequests: 0, browserRuns: 0, functionalAcceptance: false }));
