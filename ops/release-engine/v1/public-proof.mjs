import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateManifest, rootFile, sha, unit, call } from './common.mjs';
import { verifyCandidate } from './candidate.mjs';

// Source and compiler outputs belong to the application user, not the root-only control package.
export function readApplicationArtifact(file, root, uid, maximum = 32 * 1024 * 1024) {
  assert.ok(path.isAbsolute(file) && file.startsWith(root + '/'));
  assert.equal(fs.realpathSync(file), file);
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === uid
    && !(stat.mode & 0o022) && stat.size > 0 && stat.size <= maximum, 'Untrusted application artifact: ' + file);
  return fs.readFileSync(file);
}

function runningPair(m, c) {
  return Object.fromEntries(['web', 'image', 'hd'].map(role => {
    const value = unit(m.live[role].unit);
    assert.equal(value.ActiveState, 'active'); assert.equal(value.SubState, 'running'); assert.equal(value.ControlPID, '0');
    assert.ok(Number(value.MainPID) > 1); assert.match(value.InvocationID, /^[a-f0-9]{32}$/);
    const root = fs.realpathSync(value.WorkingDirectory);
    assert.equal(root, c.root); assert.equal(fs.realpathSync('/proc/' + value.MainPID + '/cwd'), root);
    const source = fs.readFileSync(root + '/.deployed-commit', 'utf8').trim();
    const version = JSON.parse(fs.readFileSync(root + '/package.json')).version;
    assert.equal(source, c.source); assert.equal(version, c.version);
    // Keep the original RATE runtime alias; never move or manufacture build files here.
    assert.equal(fs.realpathSync(root + '/.next-prod'), path.join(root, c.buildDist));
    const build = fs.readFileSync(root + '/.next-prod/BUILD_ID', 'utf8').trim(); assert.ok(build);
    return [role, { unit: value.Id, pid: Number(value.MainPID), invocation: value.InvocationID, root, source, version, build }];
  }));
}
async function anonymousRead(origin, route, maximum = 2 * 1024 * 1024) {
  assert.ok(route.startsWith('/') && !route.startsWith('//'));
  const response = await fetch(origin + route, { redirect: 'manual', credentials: 'omit',
    signal: AbortSignal.timeout(20000), headers: { 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity' } });
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > maximum) throw new Error('Anonymous resource exceeds evidence budget: ' + route);
    chunks.push(Buffer.from(chunk));
  }
  return { response, bytes: Buffer.concat(chunks), size };
}
function loginDestination(value, origin, route, nextRequired) {
  assert.equal(value.response.status, 307, 'Retain the real anonymous login boundary: ' + route);
  const location = value.response.headers.get('location'); assert.ok(location);
  const target = new URL(location, origin); assert.equal(target.origin, origin);
  assert.ok(['/login', '/register'].includes(target.pathname));
  if (nextRequired) { assert.equal(target.pathname, '/login'); assert.equal(target.searchParams.get('next'), route); }
  return { route, status: value.response.status, destination: target.pathname, location, bodySha256: sha(value.bytes) };
}

export async function verifyPublic(m, kind) {
  validateManifest(m); assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const manifestBytes = rootFile(m.stage + '/manifest.json'); assert.deepEqual(JSON.parse(manifestBytes), m);
  const candidate = await verifyCandidate(m, kind), c = m[kind], startedAt = Date.now();
  const observed = runningPair(m, c);
  for (const value of Object.values(observed)) assert.equal(value.build, candidate.build);
  const release = await anonymousRead(m.publicOrigin, '/api/release');
  assert.equal(release.response.status, 200); assert.equal(release.response.headers.get('x-sd2-origin'), 'server-42-193');
  const publicRelease = JSON.parse(release.bytes); assert.equal(publicRelease.version, observed.web.version);
  for (const field of ['source', 'build', 'sourceSha', 'buildId']) assert.equal(Object.hasOwn(publicRelease, field), false, 'Anonymous release must not expose private source/build data');
  assert.equal(publicRelease.summary, '');
  const config = await anonymousRead(m.publicOrigin, '/api/config');
  assert.equal(config.response.status, 200); assert.ok(JSON.parse(config.bytes).model);
  const page = loginDestination(await anonymousRead(m.publicOrigin, '/admin/pricing'), m.publicOrigin, '/admin/pricing', false);
  const anonymous = [];
  for (const route of ['/api/admin/pricing', '/api/admin/pricing/history', '/api/admin/pricing/export', '/api/admin/integrations/image-generation']) {
    const value = await anonymousRead(m.publicOrigin, route);
    assert.equal(value.response.status, 401, 'Anonymous pricing API must stay authenticated: ' + route);
    anonymous.push({ route, status: value.response.status, bytes: value.size, sha256: sha(value.bytes) });
  }
  const buildRoot = path.join(observed.web.root, c.buildDist);
  const manifestFile = path.join(buildRoot, 'app-build-manifest.json');
  const buildManifestBytes = fs.readFileSync(manifestFile), buildManifest = JSON.parse(buildManifestBytes);
  const expectedPages = ['/multiview/page', '/admin/pricing/page', '/admin/integrations/page', '/image-studio/page', '/template-studio/page', '/admin/image-studio/page'];
  for (const route of expectedPages) assert.ok(buildManifest.pages?.[route]?.length, 'Missing compiled page: ' + route);
  let protectedPricingPage = null;
  if (m.protectedIncrement) {
    const uid = Number(call('id', ['-u', m.appUser])); assert.ok(Number.isSafeInteger(uid) && uid > 0);
    const read = (root, file) => readApplicationArtifact(root + '/' + file, root, uid);
    const sourceFile = 'src/app/admin/pricing/page.tsx', source = read(c.root, sourceFile);
    assert.deepEqual(source, read(m.live.web.root, sourceFile), 'Protected pricing entry changed');
    const mode = read(c.root, 'src/lib/pricing/build-mode.ts').toString().trim();
    assert.equal(mode, 'export const PRICING_ADMIN_WRITES_ENABLED: boolean = false;');
    const relativeFile = 'server/app/admin/pricing/page.js', bytes = read(buildRoot, relativeFile);
    for (const marker of ['费率设置维护中', '已保存的价格和已有任务保持不变，暂不能修改费率。']) {
      assert.ok(source.includes(Buffer.from(marker)) && bytes.includes(Buffer.from(marker)), 'Protected pricing maintenance entry absent from source/artifact');
    }
    protectedPricingPage = { sourceFile, sourceSha256: sha(source), file: relativeFile, bytes: bytes.length,
      sha256: sha(bytes), pricingWrites: false, sourceMatchesProtectedBaseline: true, compiledMaintenanceEntryPresent: true };
  }
  const hdMarkers = ['高清准备中，先显示预览', '重新读取图片', '下次单图重试',
    '视频已就绪', '正在准备视频', 'deferred',
    ...(kind === 'main' && !m.protectedIncrement ? ['当前价格', '当前均已停用', '每个任务最终四舍五入到 0.1 点'] : [])];
  const markerFiles = Object.fromEntries(hdMarkers.map(text => [text, []]));
  function inspectChunks(directory) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      assert.ok(!stat.isSymbolicLink());
      if (stat.isDirectory()) inspectChunks(file);
      else if (stat.isFile() && name.endsWith('.js')) {
        const text = fs.readFileSync(file, 'utf8');
        for (const marker of hdMarkers) if (text.includes(marker)) markerFiles[marker].push(path.relative(buildRoot, file).split(path.sep).join('/'));
      }
    }
  }
  inspectChunks(path.join(buildRoot, 'static/chunks'));
  for (const marker of hdMarkers) assert.ok(markerFiles[marker].length, 'HD client code is missing from the actual compiled output: ' + marker);
  const files = [...new Set([...expectedPages.flatMap(route => buildManifest.pages[route]), ...Object.values(markerFiles).flat()])];
  const assets = [];
  for (const file of files) {
    assert.ok(typeof file === 'string' && file.startsWith('static/') && file.split('/').every(part => part && part !== '.' && part !== '..')
      && !/[\\?#\0\r\n]/.test(file));
    const localFile = path.join(buildRoot, file); assert.equal(fs.realpathSync(localFile), localFile);
    const stat = fs.lstatSync(localFile); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    const localBytes = fs.readFileSync(localFile);
    const value = await anonymousRead(m.publicOrigin, '/_next/' + file, 64 * 1024 * 1024);
    assert.equal(value.response.status, 200); assert.equal(value.size, localBytes.length);
    assert.equal(sha(value.bytes), sha(localBytes), 'Public compiled resource differs from the running candidate: ' + file);
    assets.push({ file, status: value.response.status, bytes: value.size, sha256: sha(value.bytes) });
  }
  const tools = [];
  for (const file of ['tools/ultimate-canvas/node-pricing.js', 'tools/ultimate-canvas/node-pricing.css']) {
    const route = '/' + file;
    tools.push({ ...loginDestination(await anonymousRead(m.publicOrigin, route), m.publicOrigin, route, true),
      liveFileSha256: sha(fs.readFileSync(path.join(observed.web.root, 'public', file))), authenticatedBytesVerified: false });
  }
  assert.deepEqual(runningPair(m, c), observed, 'Running pair changed during public evidence capture');
  assert.equal(sha(fs.readFileSync(manifestFile)), sha(buildManifestBytes));
  return { schema: 'rate-impl2-public-proof.v1', runId: m.runId, label: kind, manifestSha256: sha(manifestBytes),
    source: observed.web.source, version: publicRelease.version, build: observed.web.build, startedAt, finishedAt: Date.now(), observed,
    release: { status: release.response.status, bytes: release.size, sha256: sha(release.bytes), origin: release.response.headers.get('x-sd2-origin') },
    config: { status: config.response.status, bytes: config.size, sha256: sha(config.bytes) }, protectedPage: page, anonymous, assets, tools,
    targetPages: expectedPages, hdClientMarkerFiles: markerFiles, protectedPricingPage,
    generationCalls: 0, billingChanges: 0, browserAcceptance: false, userManualAcceptancePending: true };
}

