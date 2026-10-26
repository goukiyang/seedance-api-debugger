import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', timeout: 30000,
  env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' } }).trim();
assert.equal(run('findmnt', ['-n', '-o', 'TARGET', '-T', '/data/video-api-debugger']), '/data');
const units = { web: 'sd2-gray.service', image: 'sd2-image-studio.service', hd: 'sd2-hd-derivatives.service',
  works: 'sd2-multiview-works.service', role: 'sd2-role-coordinator.service', template: 'sd2-template-prompts.service' };
const starts = {}, runtime = {};
for (const [role, name] of Object.entries(units)) {
  const value = Object.fromEntries(run('systemctl', ['show', name,
    '--property=MainPID,InvocationID,ExecMainStartTimestampMonotonic,WorkingDirectory,ActiveState,SubState,ControlPID,ControlGroup']).split('\n')
    .map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  assert.equal(value.ActiveState, 'active'); assert.equal(value.SubState, 'running'); assert.equal(value.ControlPID, '0');
  const root = fs.realpathSync(value.WorkingDirectory);
  assert.equal(fs.realpathSync('/proc/' + value.MainPID + '/cwd'), root);
  starts[role] = [Number(value.MainPID), value.InvocationID, value.ExecMainStartTimestampMonotonic];
  runtime[role] = { root, group: value.ControlGroup, version: JSON.parse(fs.readFileSync(root + '/package.json')).version };
}
assert.equal(runtime.web.root, runtime.image.root); assert.equal(runtime.web.root, runtime.hd.root);
const managedPids = new Set();
function groupPids(directory) {
  for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, file.name);
    if (file.isDirectory()) groupPids(target);
    else if (file.name === 'cgroup.procs') for (const pid of fs.readFileSync(target, 'utf8').trim().split(/\s+/).filter(Boolean)) managedPids.add(pid);
  }
}
for (const value of Object.values(runtime)) if (value.root === runtime.role.root) {
  assert.ok(value.group.startsWith('/system.slice/') && !value.group.includes('..'));
  groupPids('/sys/fs/cgroup' + value.group);
}
const sameSourcePids = [];
for (const pid of fs.readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
  try { if (fs.realpathSync('/proc/' + pid + '/cwd') === runtime.role.root) sameSourcePids.push(pid); }
  catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
}
assert.ok(sameSourcePids.every(pid => managedPids.has(pid)), 'An unmanaged process shares the role source; reconcile before release');
const root = runtime.web.root;
const pricingRevision = run('python3', ['-I', '-c', String.raw`
import sqlite3
with sqlite3.connect('file:/data/video-api-debugger/var-lib/dev.db?mode=ro',uri=True) as c:
 c.execute('PRAGMA query_only=ON')
 rows=c.execute("SELECT json_extract(value_json,'$.revision') FROM PlatformSetting WHERE key='pricing_policy_v1'").fetchall()
 assert len(rows)==1 and isinstance(rows[0][0],str)
 print(rows[0][0])
`]);
const allowedSha256 = createHash('sha256').update(fs.readFileSync('/data/video-api-debugger/controls/pricing-writer-v1/allowed.json')).digest('hex');
console.log(JSON.stringify({ observedAt: new Date().toISOString(), source: fs.readFileSync(root + '/.deployed-commit', 'utf8').trim(),
  version: runtime.web.version, build: fs.readFileSync(root + '/.next-prod/BUILD_ID', 'utf8').trim(), starts, pricingRevision, allowedSha256 }));
console.error(JSON.stringify({ schema: 'sd2-release-live-capture-proof.v1', pricingKey: 'pricing_policy_v1.revision',
  roleSameSourceProcesses: sameSourcePids.length, unmanagedRoleSourceProcesses: 0, servicesChanged: false, businessWrites: 0 }));
