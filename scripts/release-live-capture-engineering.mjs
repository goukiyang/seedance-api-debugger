import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const file = 'ops/sd2-release-live-capture.mjs';
const before = execFileSync('git', ['show', '6a0d74f2b5782a52b797cdf99434bb48e15e7bf4:' + file], { encoding: 'utf8' });
const after = fs.readFileSync(file, 'utf8');
const source = '6a0d74f2b5782a52b797cdf99434bb48e15e7bf4';
const root = '/data/video-api-debugger/managed-releases/' + source;
function capture(code, { unmanaged = false, otherSource = false, wrongUid = false } = {}) {
  const units = ['sd2-gray', 'sd2-image-studio', 'sd2-hd-derivatives', 'sd2-multiview-works', 'sd2-role-coordinator', 'sd2-template-prompts', 'sd2-periodic-credits'];
  const states = Object.fromEntries(units.map((unit, index) => [unit + '.service', {
    MainPID: String(201 + index), User: 'gouki', InvocationID: 'a'.repeat(32), ExecMainStartTimestampMonotonic: '123456',
    WorkingDirectory: otherSource && index === 6 ? root + '-other' : root,
    ActiveState: 'active', SubState: 'running', ControlPID: '0', ControlGroup: '/system.slice/' + unit + '.service',
  }]));
  const pids = Object.values(states).map(value => value.MainPID).concat(unmanaged ? ['999'] : []);
  const stdout = [], stderr = [];
  const readFileSync = name => {
    if (name.endsWith('/cgroup.procs')) return Object.values(states).find(value => name.includes(value.ControlGroup)).MainPID + '\n';
    if (name.endsWith('/status')) return 'Uid:\t' + Array(4).fill(wrongUid ? '0' : '1004').join('\t') + '\n';
    if (name === root + '/package.json') return JSON.stringify({ version: '0.121.5' });
    if (name.endsWith('/.deployed-commit')) return source + '\n';
    if (name.endsWith('/.next-prod/BUILD_ID')) return 'fixture-build\n';
    if (name.endsWith('/allowed.json')) return '{}';
    throw new Error('unexpected fixture file: ' + name);
  };
  const fixtureFs = { readFileSync, realpathSync(name) {
    const match = name.match(/^\/proc\/(\d+)\/cwd$/);
    return match ? Object.values(states).find(value => value.MainPID === match[1])?.WorkingDirectory || root : name;
  }, readdirSync(name) {
    if (name === '/proc') return pids;
    if (name.startsWith('/sys/fs/cgroup/')) return [{ name: 'cgroup.procs', isDirectory: () => false }];
    throw new Error('unexpected fixture directory: ' + name);
  } };
  const exec = (bin, args) => {
    if (bin === 'findmnt') return '/data';
    if (bin === 'python3') return 'fixture-pricing-revision';
    if (bin === 'systemctl') return Object.entries(states[args[1]]).map(([key, value]) => key + '=' + value).join('\n');
    throw new Error('unexpected fixture executable: ' + bin);
  };
  vm.runInNewContext(code.replace(/^import .*;\n/gm, ''), { assert, fs: fixtureFs, path, createHash, execFileSync: exec,
    process: { platform: 'linux', getuid: () => 0 }, Date, console: { log: text => stdout.push(text), error: text => stderr.push(text) } }, { filename: file });
  return { value: JSON.parse(stdout[0]), proof: JSON.parse(stderr[0]) };
}
assert.throws(() => capture(before), /unmanaged process/);
const current = capture(after);
assert.deepEqual(Object.keys(current.value.starts), ['web', 'image', 'hd', 'works', 'role', 'template']);
assert.equal(current.proof.roleSameSourceProcesses, 7); assert.equal(current.proof.unmanagedRoleSourceProcesses, 0);
assert.throws(() => capture(after, { unmanaged: true }), /unmanaged process/);
assert.throws(() => capture(after, { otherSource: true }));
assert.throws(() => capture(after, { wrongUid: true }));
console.log(JSON.stringify({ passed: true, cases: 5, beforeSha256: createHash('sha256').update(before).digest('hex'),
  afterSha256: createHash('sha256').update(after).digest('hex'), originalSixStartsPreserved: true,
  checks: ['old_six_units_reject_managed_periodic', 'new_reader_captures_seven_managed_processes', 'real_unmanaged_rejected', 'periodic_source_mismatch_rejected', 'periodic_uid_mismatch_rejected'],
  productionReads: 0, productionWrites: 0, serviceOperations: 0 }));
