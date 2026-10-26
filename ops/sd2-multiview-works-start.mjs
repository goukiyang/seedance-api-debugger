import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MULTIVIEW_WORKS_START_ROOT = '/data/video-api-debugger/controls/multiview-works-v1';
export const MULTIVIEW_WORKS_START_FILE = MULTIVIEW_WORKS_START_ROOT + '/allowed.json';

const RELEASE_ROOT = '/data/video-api-debugger/managed-releases/';
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REQUIRED_SOURCES = Object.freeze([
  'ops/sd2-multiview-works-start.mjs',
  'scripts/process-multiview-works.ts',
  'src/lib/video/multiview-work-render.ts',
  'src/lib/video/multiview-output-assets.server.ts',
  'src/lib/video/multiview-output-access.server.ts',
  'src/lib/video/multiview-recipe-storage.server.ts',
  'src/lib/video/multiview-works.ts',
  'src/lib/video/multiview-works-runtime.ts',
  'src/lib/video/multiview-work-contract.ts',
  'src/lib/prisma.ts',
]);

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function exactKeys(value, keys, label) {
  assert.ok(object(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} keys changed`);
}
function safeRelative(file) {
  return typeof file === 'string' && !path.posix.isAbsolute(file)
    && file.split('/').every(part => part && part !== '.' && part !== '..')
    && !/[\\\0\r\n?#]/.test(file);
}
function statShape(stat) {
  return {
    type: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'other',
    nlink: stat.nlink, uid: stat.uid, mode: stat.mode, dev: stat.dev, ino: stat.ino, size: stat.size,
    mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
  };
}
function stableIdentity(value) {
  return Object.fromEntries(['type', 'nlink', 'uid', 'mode', 'dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, value[key]]));
}
function defaultObservationAdapter() {
  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    uid: () => typeof process.getuid === 'function' ? process.getuid() : null,
    cwd: () => process.cwd(),
    realpath: file => fs.realpathSync(file),
    lstat: file => statShape(fs.lstatSync(file)),
    stat: file => statShape(fs.statSync(file)),
    readlink: file => fs.readlinkSync(file),
    readStableFile: file => {
      const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const before = statShape(fs.fstatSync(descriptor));
        const bytes = fs.readFileSync(descriptor);
        const after = statShape(fs.fstatSync(descriptor));
        return { bytes, before, after };
      } finally { fs.closeSync(descriptor); }
    },
    accessReadable: file => { fs.accessSync(file, fs.constants.R_OK); return true; },
  };
}
function stableRead(adapter, file, expected) {
  const opened = adapter.readStableFile(file);
  assert.deepEqual(stableIdentity(opened.before), stableIdentity(expected), `File identity changed before open: ${file}`);
  assert.deepEqual(stableIdentity(opened.after), stableIdentity(opened.before), `File changed while open: ${file}`);
  assert.deepEqual(stableIdentity(adapter.lstat(file)), stableIdentity(opened.before), `File path changed after read: ${file}`);
  assert.equal(opened.bytes.length, expected.size, `File length changed while reading: ${file}`);
  return opened.bytes;
}
function regular(adapter, file, owner, maximum = 64 * 1024 * 1024) {
  assert.equal(adapter.realpath(file), file, `Non-canonical file: ${file}`);
  const stat = adapter.lstat(file);
  assert.equal(stat.type, 'file', `Not a regular file: ${file}`);
  assert.equal(stat.nlink, 1, `Hard-linked file rejected: ${file}`);
  assert.equal(stat.uid, owner, `Unexpected file owner: ${file}`);
  assert.equal(stat.mode & 0o022, 0, `Writable deployment file rejected: ${file}`);
  assert.ok(Number.isSafeInteger(stat.size) && stat.size > 0 && stat.size <= maximum, `Unsafe file size: ${file}`);
  return stableRead(adapter, file, stat);
}
function controlledContract(adapter) {
  const file = MULTIVIEW_WORKS_START_FILE;
  assert.equal(adapter.realpath(file), file, 'Allowed manifest path is not canonical');
  const stat = adapter.lstat(file);
  assert.equal(stat.type, 'file');
  assert.equal(stat.nlink, 1);
  assert.equal(stat.uid, 0);
  assert.equal(stat.mode & 0o133, 0, 'Allowed manifest permissions exceed 0644');
  assert.ok(stat.mode & 0o400, 'Allowed manifest is not owner-readable');
  assert.equal(adapter.accessReadable(file), true, 'Allowed manifest is not readable by the application user');
  assert.ok(Number.isSafeInteger(stat.size) && stat.size > 0 && stat.size <= 1024 * 1024);
  const bytes = stableRead(adapter, file, stat);
  return JSON.parse(bytes.toString('utf8'));
}
function validateContract(contract) {
  exactKeys(contract, ['schema', 'runId', 'manifestSha256', 'appUid', 'releases'], 'contract');
  assert.equal(contract.schema, 'sd2-multiview-works-start.v1');
  assert.match(contract.runId, RUN_ID);
  assert.match(contract.manifestSha256, SHA256);
  assert.ok(Number.isSafeInteger(contract.appUid) && contract.appUid > 0);
  assert.ok(Array.isArray(contract.releases));
  assert.equal(contract.releases.length, 2);
  for (const [index, release] of contract.releases.entries()) {
    exactKeys(release, ['root', 'source', 'version', 'build', 'sourceSha256'], `release[${index}]`);
    assert.match(release.source, SHA);
    assert.equal(release.root, RELEASE_ROOT + release.source);
    assert.ok(typeof release.version === 'string' && release.version.length > 0 && release.version.length <= 160);
    assert.ok(typeof release.build === 'string' && release.build.length > 0 && release.build.length <= 200);
    assert.ok(object(release.sourceSha256));
    const sources = Object.keys(release.sourceSha256);
    assert.ok(REQUIRED_SOURCES.every(file => sources.includes(file)), `release[${index}] misses a required consumer source`);
    for (const file of sources) {
      assert.ok(safeRelative(file), `Unsafe source path: ${file}`);
      assert.match(release.sourceSha256[file], SHA256);
    }
  }
  assert.notEqual(contract.releases[0].source, contract.releases[1].source);
  assert.deepEqual(Object.keys(contract.releases[0].sourceSha256).sort(), Object.keys(contract.releases[1].sourceSha256).sort());
}
function directory(adapter, file, owner = null) {
  assert.equal(adapter.realpath(file), file, `Non-canonical directory: ${file}`);
  const stat = adapter.lstat(file);
  assert.equal(stat.type, 'directory', `Not a directory: ${file}`);
  if (owner !== null) assert.equal(stat.uid, owner, `Unexpected directory owner: ${file}`);
  assert.equal(stat.mode & 0o022, 0, `Writable deployment directory rejected: ${file}`);
  return stat;
}
function buildDirectory(adapter, release) {
  const alias = release.root + '/.next-prod';
  const target = release.root + '/.next-prod-candidate';
  const aliasStat = adapter.lstat(alias);
  if (aliasStat.type === 'directory') return { root: alias, identity: directory(adapter, alias, release.appUid) };
  assert.equal(aliasStat.type, 'symlink', 'Build alias must be a directory or the fixed managed symlink');
  assert.equal(aliasStat.nlink, 1, 'Build alias must have one link');
  assert.equal(aliasStat.uid, 0, 'Build alias must be root-owned');
  assert.equal(adapter.readlink(alias), '.next-prod-candidate', 'Build alias target changed');
  assert.equal(adapter.realpath(alias), target, 'Build alias escaped its release root');
  const identity = directory(adapter, target, release.appUid);
  assert.equal(adapter.readlink(alias), '.next-prod-candidate', 'Build alias changed during verification');
  assert.deepEqual(stableIdentity(adapter.lstat(alias)), stableIdentity(aliasStat), 'Build alias identity changed during verification');
  return { root: target, identity };
}

export function observeMultiviewWorksStart(contract, observationAdapter) {
  const adapter = observationAdapter || defaultObservationAdapter();
  validateContract(contract);
  assert.equal(adapter.platform, 'linux');
  const nodeMajor = Number(String(adapter.nodeVersion).split('.')[0]);
  assert.ok(Number.isSafeInteger(nodeMajor) && nodeMajor >= 20, 'Node 20 or newer is required');
  assert.equal(adapter.uid(), contract.appUid, 'The consumer is not running as the admitted application UID');
  const data = directory(adapter, '/data');
  const system = adapter.stat('/');
  assert.equal(system.type, 'directory');
  assert.notEqual(data.dev, system.dev, '/data must be a real mounted data volume');
  const fromFile = controlledContract(adapter);
  assert.deepEqual(fromFile, contract, 'The observed contract differs from the fixed allowed manifest');

  const cwd = adapter.realpath(adapter.cwd());
  const release = contract.releases.find(item => item.root === cwd);
  assert.ok(release, 'Consumer cwd is not one of the admitted releases');
  const releaseRootIdentity = directory(adapter, release.root, contract.appUid);
  const source = regular(adapter, release.root + '/.deployed-commit', contract.appUid, 256).toString('utf8').trim();
  assert.equal(source, release.source);
  const packageValue = JSON.parse(regular(adapter, release.root + '/package.json', contract.appUid, 8 * 1024 * 1024).toString('utf8'));
  assert.equal(packageValue.version, release.version);
  const buildDirectoryObservation = buildDirectory(adapter, { ...release, appUid: contract.appUid });
  const build = regular(adapter, buildDirectoryObservation.root + '/BUILD_ID', contract.appUid, 1024).toString('utf8').trim();
  assert.deepEqual(stableIdentity(adapter.lstat(buildDirectoryObservation.root)), stableIdentity(buildDirectoryObservation.identity),
    'Build directory identity changed while reading BUILD_ID');
  assert.equal(build, release.build);
  const sourceSha256 = Object.fromEntries(Object.keys(release.sourceSha256).map(file => [
    file,
    hash(regular(adapter, release.root + '/' + file, contract.appUid)),
  ]));
  assert.deepEqual(sourceSha256, release.sourceSha256);
  assert.deepEqual(stableIdentity(adapter.lstat(release.root)), stableIdentity(releaseRootIdentity),
    'Release root identity changed during verification');
  return { source: release.source, build: release.build, actualUid: adapter.uid(), verified: true };
}

export function verifyMultiviewWorksStart() {
  const adapter = defaultObservationAdapter();
  return observeMultiviewWorksStart(controlledContract(adapter), adapter);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(verifyMultiviewWorksStart())); }
  catch { console.error('3D multiview works consumer source is not admitted; no worker started.'); process.exitCode = 1; }
}
