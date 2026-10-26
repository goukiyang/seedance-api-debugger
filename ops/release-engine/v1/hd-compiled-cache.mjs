import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFile, sha, writeJsonExclusive, call, isSharedEngine } from './common.mjs';
import { readHdCompiledCacheProofs } from './hd-storage-preflight.mjs';
import { readTypedFile, assertTypedFileUnchanged } from './typed-files.mjs';

const SOURCE_FILES = ['scripts/process-hd-image.ts', 'src/lib/media/hd-image-processor.ts', 'src/lib/media/hd-encoder.ts'];
const loaded = new WeakSet();
const fileIdentity = stat => Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, stat[key]]));
function applicationFile(file, uid, maximum = 8 * 1024 * 1024) {
  assert.equal(fs.realpathSync(file), file);
  const before = fs.lstatSync(file);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.uid === uid && before.nlink === 1
    && !(before.mode & 0o022) && before.size > 0 && before.size <= maximum, 'Untrusted compiler input/output: ' + file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    assert.deepEqual(fileIdentity(fs.fstatSync(fd)), fileIdentity(before));
    const bytes = fs.readFileSync(fd);
    assert.deepEqual(fileIdentity(fs.fstatSync(fd)), fileIdentity(before));
    assert.deepEqual(fileIdentity(fs.lstatSync(file)), fileIdentity(before));
    return { bytes, sha256: sha(bytes), identity: fileIdentity(before) };
  } finally { fs.closeSync(fd); }
}
function compiler(root, uid) {
  const tsxPackage = applicationFile(root + '/node_modules/tsx/package.json', uid);
  const esbuildPackage = applicationFile(root + '/node_modules/esbuild/package.json', uid);
  const transforms = fs.readdirSync(root + '/node_modules/tsx/dist').filter(name => /^index-[A-Za-z0-9_-]+\.mjs$/.test(name));
  assert.equal(transforms.length, 1);
  const component = (file, version) => ({ file, version, sha256: applicationFile(file, uid, 32 * 1024 * 1024).sha256 });
  const node = readTypedFile({ file: process.execPath, category: 'system' });
  return {
    node: { file: node.snapshot.realPath, version: process.versions.node, sha256: node.snapshot.sha256 },
    tsx: component(root + '/node_modules/tsx/dist/' + transforms[0], JSON.parse(tsxPackage.bytes).version),
    esbuild: component(root + '/node_modules/esbuild/lib/main.js', JSON.parse(esbuildPackage.bytes).version),
  };
}

// This invokes the real compiler with the same absolute source entry and loader
// as the HD child. It has no IPC channel and receives no work message. The
// entry's existing unused-child deadline exits 1; no image operation is run.
export function captureHdCompiledCache(m, kind, prepared) {
  assert.equal(isSharedEngine(m), true);
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const c = m[kind], uid = Number(call('id', ['-u', m.appUser])), gid = Number(call('id', ['-g', m.appUser]));
  const source = JSON.parse(rootFile(c.sourceManifest));
  const directory = prepared.preparedRoot + '/hd-compile-probe';
  assert.equal(fs.existsSync(directory), false, 'A compiler probe is never replayed or overwritten');
  fs.mkdirSync(directory, { mode: 0o700 }); fs.chownSync(directory, uid, gid);
  const input = Object.fromEntries([...SOURCE_FILES, 'tsconfig.json'].map(file => {
    const read = applicationFile(c.root + '/' + file, uid);
    assert.equal(read.sha256, source.files[file]); return [file, read.sha256];
  }));
  const nodeSnapshot = readTypedFile({ file: process.execPath, category: 'system' }).snapshot;
  const actualCompiler = compiler(c.root, uid), startedAt = Date.now();
  const args = ['-u', m.appUser, '--', 'env', '-i', 'NODE_ENV=production',
    'PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'TMPDIR=' + directory,
    process.execPath, '--import', 'tsx', c.root + '/scripts/process-hd-image.ts'];
  const result = spawnSync('runuser', args, { cwd: c.root, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
  const finishedAt = Date.now(), logFile = m.stage + '/' + kind + '-hd-compile.log';
  const log = Buffer.from((result.stdout || '') + (result.stderr || ''));
  fs.writeFileSync(logFile, log, { flag: 'wx', mode: 0o600 });
  const command = { status: result.status ?? null, signal: result.signal ?? null,
    error: result.error?.message || null, errorCode: result.error?.code || null, startedAt, finishedAt,
    executable: 'runuser', args, cwd: c.root, ipcChannel: false, workMessagesSent: 0,
    expectedUnusedChildExit: 1, logFile, logSha256: sha(log) };
  writeJsonExclusive(m.stage + '/' + kind + '-hd-compile-command.json', command);
  assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 1);
  assert.ok(finishedAt - startedAt >= 10000, 'The real unused-child deadline, not an early silent failure, must end compilation');
  assert.equal(log.length, 0, 'A no-work compiler probe must not report a runtime error');
  const cache = directory + '/tsx-' + uid;
  assert.deepEqual(fs.readdirSync(directory), ['tsx-' + uid]);
  const entries = fs.readdirSync(cache).sort().map(name => {
    const filename = /^(\d+)-([a-f0-9]{40})$/.exec(name); assert.ok(filename);
    const file = cache + '/' + name, read = applicationFile(file, uid, 1024 * 1024), value = JSON.parse(read.bytes);
    assert.deepEqual(Object.keys(value).sort(), ['code', 'map', 'warnings']);
    assert.ok(typeof value.code === 'string' && value.code.length); assert.deepEqual(value.warnings, []);
    assert.equal(value.map?.version, 3); assert.equal(value.map.sources.length, 1);
    const sourceFile = path.relative(c.root, value.map.sources[0]);
    assert.ok(SOURCE_FILES.includes(sourceFile)); assert.equal(value.map.sources[0], c.root + '/' + sourceFile);
    assert.equal(Number(filename[1]), Math.floor(read.identity.mtimeMs / 1e8));
    return { sourceFile, sourceSha256: input[sourceFile], cacheFile: file, cacheSha256: read.sha256,
      cacheBytes: read.bytes.length, cacheKey: filename[2], mtimeBucket: Number(filename[1]) };
  });
  assert.deepEqual(entries.map(item => item.sourceFile).sort(), [...SOURCE_FILES].sort());
  assert.deepEqual(compiler(c.root, uid), actualCompiler);
  assertTypedFileUnchanged(nodeSnapshot);
  for (const [file, digest] of Object.entries(input)) assert.equal(applicationFile(c.root + '/' + file, uid).sha256, digest);
  const descriptor = { source: c.source, sourceRoot: c.root, sourceManifest: c.sourceManifest, archive: c.archive,
    compiler: actualCompiler, entries };
  const receipt = { schema: 'sd2-hd-compiled-cache.v1', runId: m.runId, kind, descriptor,
    sourceManifestSha256: sha(rootFile(c.sourceManifest)), input, command, nodeSnapshot,
    commandReceiptSha256: sha(rootFile(m.stage + '/' + kind + '-hd-compile-command.json')),
    noBusinessWorkDispatched: true };
  const file = m.stage + '/' + kind + '-hd-compiled-cache.json'; writeJsonExclusive(file, receipt);
  return { file, sha256: sha(rootFile(file)), schema: receipt.schema };
}

export function verifyHdCompiledCacheReceipt(m, kind, reference) {
  const c = m[kind]; assert.equal(reference.file, m.stage + '/' + kind + '-hd-compiled-cache.json');
  const bytes = rootFile(reference.file); assert.equal(sha(bytes), reference.sha256);
  const value = JSON.parse(bytes); assert.equal(value.schema, 'sd2-hd-compiled-cache.v1');
  assert.equal(value.runId, m.runId); assert.equal(value.kind, kind); assert.equal(value.noBusinessWorkDispatched, true);
  assert.equal(value.descriptor.source, c.source); assert.equal(value.descriptor.sourceRoot, c.root);
  assert.equal(value.descriptor.sourceManifest, c.sourceManifest); assert.equal(value.descriptor.archive, c.archive);
  assert.equal(value.sourceManifestSha256, sha(rootFile(c.sourceManifest)));
  const sourceManifest = JSON.parse(rootFile(c.sourceManifest));
  assert.equal(sha(rootFile(c.archive, 512 * 1024 * 1024)), sourceManifest.archiveSha256);
  assertTypedFileUnchanged(value.nodeSnapshot);
  assert.equal(value.commandReceiptSha256, sha(rootFile(m.stage + '/' + kind + '-hd-compile-command.json')));
  assert.deepEqual(JSON.parse(rootFile(m.stage + '/' + kind + '-hd-compile-command.json')), value.command);
  assert.equal(value.command.status, 1); assert.equal(value.command.signal, null); assert.equal(value.command.error, null);
  assert.equal(value.command.workMessagesSent, 0); assert.equal(value.command.ipcChannel, false);
  assert.equal(sha(fs.readFileSync(value.command.logFile)), value.command.logSha256);
  const uid = Number(call('id', ['-u', m.appUser]));
  assert.deepEqual(compiler(c.root, uid), value.descriptor.compiler);
  for (const [file, digest] of Object.entries(value.input))
    assert.equal(applicationFile(c.root + '/' + file, uid).sha256, digest);
  return value;
}

// Original success is a direct immutable leaf, not a later attempt aggregate.
// The loader runs once per manifest object; inventory never rehashes the full
// artifact or controller tree for each tiny discovery-lock collision.
export async function loadHdCompiledCacheProofs(m) {
  if (!isSharedEngine(m) || loaded.has(m)) return;
  const { readOriginalSuccess } = await import('./candidate-reuse.mjs');
  const references = [], authorities = new Map(), origins = ['main', 'guard'].map(kind => ({
    kind, sourceRun: m.reuseBuilds?.sourceRun || m.runId,
  }));
  if (m.live?.hd?.sourceProof?.compiledCapsule) origins.push(m.live.hd.sourceProof.compiledCapsule);
  for (const origin of origins) {
    const { kind, sourceRun } = origin; assert.ok(['main', 'guard'].includes(kind));
    assert.match(sourceRun, /^[a-f0-9-]{36}$/);
    const capsuleFile = m.projectRoot + '/release-staging/' + sourceRun + '/' + kind + '-immutable-success.json';
    if (origin.file) { assert.equal(origin.file, capsuleFile); assert.equal(sha(rootFile(capsuleFile, 128 * 1024 * 1024)), origin.sha256); }
    if (!fs.existsSync(capsuleFile)) { assert.equal(Boolean(origin.file), false); continue; }
    const originalStage = m.projectRoot + '/release-staging/' + sourceRun;
    const original = JSON.parse(rootFile(originalStage + '/manifest.json'));
    const capsule = readOriginalSuccess(origin.file ? original : m, kind), reference = capsule.originalReceipt.hdCompiledCache;
    if (!reference) continue; // Historical R09 uses its already proven byte table.
    const value = verifyHdCompiledCacheReceipt(original, kind, reference), descriptor = value.descriptor;
    assert.equal(value.sourceManifestSha256, capsule.originalSourceManifestSha256);
    const sealedNode = capsule.snapshot.node, currentNode = readTypedFile({ file: descriptor.compiler.node.file, category: 'system' }).snapshot;
    assert.equal(sealedNode.path, currentNode.realPath); assert.equal(sealedNode.sha256, currentNode.sha256);
    for (const [key, actual] of Object.entries(currentNode.identity)) assert.equal(sealedNode[key], actual, 'Original compiler runtime identity changed: ' + key);
    for (const item of descriptor.entries) {
      const relative = path.relative(descriptor.sourceRoot + '/.role-tests', item.cacheFile);
      assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative));
      const sealed = capsule.snapshot.checks[relative];
      assert.equal(sealed?.sha256, item.cacheSha256); assert.equal(sealed.size, item.cacheBytes);
      const current = applicationFile(item.cacheFile, Number(call('id', ['-u', m.appUser])), 1024 * 1024);
      assert.equal(current.sha256, item.cacheSha256); assert.deepEqual(current.identity, Object.fromEntries(Object.keys(current.identity).map(key => [key, sealed[key]])));
      assert.equal(capsule.snapshot.sourceFiles[item.sourceFile]?.sha256, item.sourceSha256);
    }
    if (!references.some(item => item.source === descriptor.source && item.sourceRoot === descriptor.sourceRoot)) {
      references.push(descriptor); authorities.set(descriptor, descriptor);
    }
  }
  if (references.length === 0) { loaded.add(m); return; }
  readHdCompiledCacheProofs(m, references, reference => {
    assert.ok(authorities.has(reference), 'Only this verified direct immutable capsule may authorize cache bytes');
    return authorities.get(reference);
  });
  loaded.add(m);
}
