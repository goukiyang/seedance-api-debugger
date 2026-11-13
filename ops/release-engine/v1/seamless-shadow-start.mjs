import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const CONTROL = '/data/video-api-debugger/controls/seamless-web-v1';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Explicit, root-sealed temporary admission. Permanent pricing membership remains
// exactly main + existing compatible guard; the original root+i barrier stays on.
export function verifyShadowStart(file, unit, { io = fs, cwd = process.cwd(), uid = process.getuid(),
  env = process.env,
  call = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', timeout: 30000 }).trim() } = {}) {
  assert.equal(path.dirname(file), CONTROL);
  assert.match(path.basename(file), /^authority-(?:main|image|guard)-[a-f0-9-]{36}\.json$/);
  for (const directory of ['/data', '/data/video-api-debugger', '/data/video-api-debugger/controls', CONTROL]) {
    const s = io.lstatSync(directory); assert.ok(s.isDirectory() && s.uid === 0 && !(s.mode & 0o022));
    assert.equal(io.realpathSync(directory), directory);
  }
  const bytes = input => {
    const s = io.lstatSync(input);
    assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === 0 && !(s.mode & 0o022));
    assert.equal(io.realpathSync(input), input); return io.readFileSync(input);
  };
  const a = JSON.parse(bytes(file)); assert.equal(a.schema, 'sd2-seamless-start-authority.v1');
  assert.match(a.runId, /^[a-f0-9-]{36}$/); assert.ok(['main', 'image', 'guard'].includes(a.kind));
  assert.equal(file, `${CONTROL}/authority-${a.kind}-${a.runId}.json`);
  assert.equal(unit, `sd2-release-${a.kind}-${a.runId}.service`); assert.equal(a.unit, unit);
  assert.equal(env.SD2_SEAMLESS_RUN_ID, a.runId);
  assert.equal(env.PRIVATE_PROMPTS_RUNTIME_REVISION, a.entry.source);
  assert.equal(env.PRIVATE_PROMPTS_POLICY_FILE, a.policyFile);
  assert.equal(env.SD2_SEAMLESS_POLICY_SHA256, a.policySha);
  assert.equal(env.PRIVATE_PROMPTS_CONSUMER_ID, a.kind === 'image' ? 'image-worker' : a.kind === 'guard' ? 'guard' : 'web');
  assert.equal(io.existsSync(`${CONTROL}/revoked-${a.kind}-${a.runId}`), false);
  assert.equal(a.entry.root, '/data/video-api-debugger/managed-releases/' + a.entry.source);
  assert.equal(io.realpathSync(cwd), a.entry.root); assert.ok(uid === 0 || uid === a.serviceUid);
  assert.equal(a.unitFile, '/run/systemd/system/' + unit); assert.equal(hash(bytes(a.unitFile)), a.unitSha256);
  assert.equal(a.marker.file, io.realpathSync(a.entry.root + '/storage/image-studio-drain'));
  assert.equal(hash(bytes(a.marker.file)), a.marker.sha256);
  const marker = JSON.parse(bytes(a.marker.file));
  assert.equal(marker.schema, 'pricing-writer-isolation.v1'); assert.equal(marker.protocol, 'pricing-policy-v1');
  assert.equal(marker.guard, 'reject-legacy-image-writers');
  assert.deepEqual(Object.keys(marker).sort(), ['guard', 'installedAt', 'protocol', 'schema']);
  assert.ok(Number.isFinite(Date.parse(marker.installedAt)) && Date.parse(marker.installedAt) <= Date.now());
  assert.match(call('/usr/bin/lsattr', ['-d', '--', a.marker.file]).split(/\s+/)[0], /i/);
  const original = '/data/video-api-debugger/controls/pricing-writer-v1/writer-start-guard.mjs';
  assert.equal(hash(bytes(original)), a.originalGuardSha256);
  const properties = Object.fromEntries(call('/usr/bin/systemctl', ['show', unit, '-p', 'WorkingDirectory',
    '-p', 'FragmentPath', '-p', 'DropInPaths']).split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  assert.equal(properties.WorkingDirectory, a.entry.root); assert.equal(properties.FragmentPath, a.unitFile);
  assert.equal(properties.DropInPaths, '');
  assert.equal(io.readFileSync(a.entry.root + '/.deployed-commit', 'utf8').trim(), a.entry.source);
  assert.equal(JSON.parse(io.readFileSync(a.entry.root + '/package.json')).version, a.entry.version);
  assert.equal(io.realpathSync(a.entry.root + '/.next-prod'), a.entry.root + '/.next-prod-candidate');
  assert.equal(io.readFileSync(a.entry.root + '/.next-prod/BUILD_ID', 'utf8').trim(), a.entry.build);
  assert.ok(Object.keys(a.entry.sourceFiles).length > 100 && Object.keys(a.entry.buildFiles).length > 10);
  for (const [base, files] of [[a.entry.root, a.entry.sourceFiles], [a.entry.root + '/.next-prod-candidate', a.entry.buildFiles]]) {
    for (const [relative, expected] of Object.entries(files)) {
      assert.ok(relative && !path.isAbsolute(relative) && !relative.split('/').some(p => !p || p === '.' || p === '..'));
      const absolute = base + '/' + relative; assert.equal(io.realpathSync(absolute), absolute);
      assert.ok(io.lstatSync(absolute).isFile()); assert.equal(hash(io.readFileSync(absolute)), expected);
    }
  }
  for (const [input, expected] of Object.entries(a.privateFiles)) assert.equal(hash(privateDataBytes(input, a.serviceUid, io)), expected);
  return { schema: 'sd2-seamless-start-verified.v1', unit, source: a.entry.source, build: a.entry.build,
    originalBarrierVerified: true, sourceAndBuildVerified: true, permanentMembershipExpanded: false };
}

export function privateDataBytes(file, uid, io = fs) {
  assert.equal(io.realpathSync(file), file);
  const fd = io.openSync(file, io.constants.O_RDONLY | io.constants.O_NOFOLLOW);
  try {
    const before = io.fstatSync(fd);
    assert.ok(before.isFile() && before.uid === uid && before.nlink === 1 && !(before.mode & 0o077)
      && before.size > 0 && before.size <= 256 * 1024, 'Private data must retain its application owner and private mode');
    const data = io.readFileSync(fd), after = io.fstatSync(fd);
    for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key]);
    return data;
  } finally { io.closeSync(fd); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(verifyShadowStart(...process.argv.slice(2)))); }
  catch (error) { console.error('Seamless start refused:', error.message); process.exitCode = 1; }
}
