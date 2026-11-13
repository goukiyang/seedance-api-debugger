import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
const env = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
const destinations = [3302, 3303, 3304];
function rule(port, target, uid) {
  return ['-p', 'tcp', '-d', '127.0.0.1/32', '--dport', String(port), '-m', 'owner', '--uid-owner', String(uid),
    '-m', 'comment', '--comment', 'sd2-seamless-v1', '-j', 'DNAT', '--to-destination', '127.0.0.1:' + target];
}
function present(args) {
  const result = spawnSync('/usr/sbin/iptables', ['-w', '5', '-t', 'nat', '-C', 'OUTPUT', ...args], { encoding: 'utf8', env, timeout: 10000 });
  assert.ifError(result.error); assert.equal(result.signal, null);
  assert.ok(result.status === 0 || result.status === 1, result.stderr); return result.status === 0;
}
function remove(args) {
  if (present(args)) execFileSync('/usr/sbin/iptables', ['-w', '5', '-t', 'nat', '-D', 'OUTPUT', ...args], { env, timeout: 10000 });
}
export function clearLoopback(port, uid) {
  assert.ok([3302, 3303].includes(port) && Number.isSafeInteger(uid) && uid > 0);
  for (const target of destinations) if (target !== port) remove(rule(port, target, uid));
  return { port, cleared: true };
}
export function switchLoopback(port, target, uid) {
  assert.ok([3302, 3303].includes(port) && destinations.includes(target) && port !== target);
  assert.ok(Number.isSafeInteger(uid) && uid > 0);
  const args = rule(port, target, uid);
  if (!present(args)) execFileSync('/usr/sbin/iptables', ['-w', '5', '-t', 'nat', '-I', 'OUTPUT', '1', ...args], { env, timeout: 10000 });
  assert.equal(present(args), true);
  for (const other of destinations) if (other !== port && other !== target) remove(rule(port, other, uid));
  return { port, target, uid, loopbackOnly: true };
}
export function acceptedConnectionCount(port) {
  assert.ok([3302, 3303].includes(port));
  const output = execFileSync('/usr/bin/ss', ['-H', '-t', '-a', '-n', 'sport', '=', ':' + port], { encoding: 'utf8', env, timeout: 10000 });
  return output.split('\n').filter(line => line.trim() && !['LISTEN', 'TIME-WAIT', 'CLOSED'].includes(line.trim().split(/\s+/)[0])).length;
}
