import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const hash = value => createHash('sha256').update(value).digest('hex');
const flags = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2], process.argv[3 + i * 2]]));
assert.deepEqual(Object.keys(flags).sort(), ['--manifest', '--manifest-sha256', '--out']);
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
const manifestBytes = fs.readFileSync(flags['--manifest']);
assert.equal(hash(manifestBytes), flags['--manifest-sha256']);
const m = JSON.parse(manifestBytes);
assert.equal(m.project, 'video-api-debugger'); assert.equal(m.publicOrigin, 'https://sd2.youdooart.com');
assert.equal(flags['--manifest'], m.stage + '/manifest.json');
assert.equal(flags['--out'], m.stage + '/admin-usage-public-proof.json');
assert.equal(execFileSync('findmnt', ['-n', '-o', 'TARGET', '-T', m.stage], { encoding: 'utf8' }).trim(), '/data');
const original = JSON.parse(fs.readFileSync(m.stage + '/main-public-proof.json'));
assert.equal(original.source, m.mainSource); assert.equal(original.label, 'main');
const success = JSON.parse(fs.readFileSync(m.stage + '/switch-complete.json'));
assert.ok(success);

function runtime() {
  const result = {};
  for (const role of ['web', 'image', 'hd', 'role']) {
    const text = execFileSync('systemctl', ['show', m.live[role].unit, '--property=MainPID,InvocationID,ActiveState,WorkingDirectory,TasksMax'], { encoding: 'utf8' });
    const unit = Object.fromEntries(text.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
    assert.equal(unit.ActiveState, 'active'); assert.ok(Number(unit.MainPID) > 1);
    const root = fs.realpathSync(unit.WorkingDirectory);
    assert.equal(root, m.main.root);
    assert.equal(fs.realpathSync('/proc/' + unit.MainPID + '/cwd'), root);
    assert.equal(fs.readFileSync(root + '/.deployed-commit', 'utf8').trim(), m.mainSource);
    assert.equal(JSON.parse(fs.readFileSync(root + '/package.json')).version, m.main.version);
    assert.equal(fs.readFileSync(root + '/.next-prod/BUILD_ID', 'utf8').trim(), original.build);
    if (role === 'role') {
      assert.equal(unit.TasksMax, '128');
      assert.equal(success.role.current.InvocationID, unit.InvocationID);
      const loaded = JSON.parse(fs.readFileSync('/data/video-api-debugger/role-coordinator/runtime.json'));
      assert.equal(loaded.state, 'active'); assert.equal(loaded.pid, Number(unit.MainPID));
      assert.equal(loaded.sourceRoot, root); assert.equal(loaded.version, m.main.version);
      assert.equal(loaded.loadedModuleSha['src/lib/admin/usage-attribution.ts'], hash(fs.readFileSync(root + '/src/lib/admin/usage-attribution.ts')));
    }
    result[role] = { pid: Number(unit.MainPID), invocation: unit.InvocationID };
  }
  return result;
}

async function read(route, limit) {
  const response = await fetch(m.publicOrigin + route, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(20000),
    headers: { 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity' } });
  const chunks = []; let length = 0;
  for await (const chunk of response.body || []) {
    length += chunk.length; assert.ok(length <= limit, 'Resource exceeds the release proof budget'); chunks.push(Buffer.from(chunk));
  }
  return { response, bytes: Buffer.concat(chunks) };
}

const startedAt = new Date().toISOString(), observed = runtime();
const buildRoot = fs.realpathSync(m.main.root + '/.next-prod');
const buildManifestBytes = fs.readFileSync(path.join(buildRoot, 'app-build-manifest.json'));
const buildManifest = JSON.parse(buildManifestBytes);
const pages = ['/admin/page', '/admin/users/page', '/admin/projects/page', '/admin/outputs/page', '/admin/image-studio/page',
  '/admin/feedback/page', '/admin/costs/page', '/admin/integrations/page', '/admin/usage-costs/page',
  '/admin/usage-records/[sourceKind]/[sourceId]/page', '/image-studio/page', '/tools/avatar-studio/page',
  '/usage/page', '/projects/page', '/projects/[id]/page', '/tasks/[id]/page', '/collections/page', '/collections/[id]/page'];
for (const page of pages) assert.ok(buildManifest.pages?.[page]?.length, 'Missing compiled batch page: ' + page);
const assets = [];
for (const file of [...new Set(pages.flatMap(page => buildManifest.pages[page]))]) {
  assert.ok(file.startsWith('static/') && file.split('/').every(part => part && part !== '.' && part !== '..') && !/[\\?#\0\r\n]/.test(file));
  const local = path.join(buildRoot, file); assert.equal(fs.realpathSync(local), local);
  const bytes = fs.readFileSync(local), publicFile = await read('/_next/' + file, 64 * 1024 ** 2);
  assert.equal(publicFile.response.status, 200); assert.equal(publicFile.bytes.length, bytes.length);
  assert.equal(hash(publicFile.bytes), hash(bytes));
  assets.push({ file, bytes: bytes.length, sha256: hash(bytes) });
}
const anonymous = [];
for (const route of ['/api/admin/usage-analytics?range=all', '/api/admin/usage-analytics/records?range=all', '/api/admin/usage-analytics/export?range=all',
  '/api/usage', '/api/usage/export', '/api/projects/release-auth-boundary/usage', '/api/projects/release-auth-boundary/usage/export',
  '/api/projects/operations/10000000-0000-4000-8000-000000000000']) {
  const value = await read(route, 32768); assert.equal(value.response.status, 401);
  anonymous.push({ route, status: value.response.status, bytes: value.bytes.length, sha256: hash(value.bytes) });
}
const protectedTools = [];
for (const file of ['tools/ultimate-canvas/index.html', 'tools/ultimate-canvas/canvas-engine.js']) {
  const local = path.join(m.main.root, 'public', file);
  assert.equal(fs.realpathSync(local), local);
  const bytes = fs.readFileSync(local), route = '/' + file;
  if (file.endsWith('index.html')) assert.ok(bytes.includes(Buffer.from('canvas-engine.js?v=input-focus-20261021')));
  const value = await read(route, 32768);
  assert.equal(value.response.status, 307);
  const destination = new URL(value.response.headers.get('location'), m.publicOrigin);
  assert.equal(destination.origin, m.publicOrigin); assert.equal(destination.pathname, '/login');
  assert.equal(destination.searchParams.get('next'), route);
  protectedTools.push({ route, status: value.response.status, liveFileBytes: bytes.length, liveFileSha256: hash(bytes),
    authenticatedBytesVerified: false });
}
assert.deepEqual(runtime(), observed);
assert.equal(hash(fs.readFileSync(path.join(buildRoot, 'app-build-manifest.json'))), hash(buildManifestBytes));
const receipt = { schema: 'admin-usage-public-artifacts.v1', completed: true, runId: m.runId,
  source: m.mainSource, version: m.main.version, build: original.build, manifestSha256: hash(manifestBytes),
  startedAt, finishedAt: new Date().toISOString(), pages, assets, anonymous, protectedTools, observed,
  authenticatedBusinessReads: 0, generationCalls: 0, billingChanges: 0, browserRuns: 0,
  scope: 'release static-byte and anonymous authentication boundaries only; user functional acceptance pending' };
fs.writeFileSync(flags['--out'], JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ completed: true, assets: assets.length, anonymousBoundaries: anonymous.length, source: m.mainSource, version: m.main.version }));
