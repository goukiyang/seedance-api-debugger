import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const TYPED_FILE_SCHEMA = 'sd2-release-typed-file.v1';
export const TYPED_FILE_CATEGORIES = Object.freeze(['root_control', 'app', 'system', 'tar', 'receipt']);

const CATEGORIES = new Set(TYPED_FILE_CATEGORIES);
const HASH = /^[a-f0-9]{64}$/;
const DEFAULT_LIMITS = Object.freeze({
  root_control: 32 * 1024 * 1024,
  app: 128 * 1024 * 1024,
  system: 512 * 1024 * 1024,
  tar: 512 * 1024 * 1024,
  receipt: 128 * 1024 * 1024,
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function identity(stat) {
  return Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'gid', 'mode', 'nlink']
    .map(key => [key, stat[key]]));
}

function comparableParentSnapshots(parents) {
  return parents.map(parent => {
    const project = value => {
      const result = { ...value };
      if ((value.mode & 0o170000) === 0o040000) {
        delete result.mtimeMs; delete result.ctimeMs;
      }
      return result;
    };
    return { ...parent, identity: project(parent.identity), aliasIdentity: project(parent.aliasIdentity) };
  });
}

function validateIdentity(value, name) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'gid', 'mode', 'nlink'].sort());
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'gid', 'mode', 'nlink'])
    assert.ok(typeof value[key] === 'number' && Number.isFinite(value[key]), `${name}.${key} is invalid`);
  return value;
}

function safeAbsolute(file) {
  assert.ok(typeof file === 'string' && path.isAbsolute(file) && file.length <= 4096 && !file.includes('\0'), 'Typed file path must be absolute');
  return path.resolve(file);
}

function parentSnapshots(file, stopAt = '/') {
  const result = [];
  let directory = path.dirname(file);
  const stop = fs.realpathSync(stopAt);
  for (let count = 0; ; count++) {
    assert.ok(count < 128, 'Typed file parent chain is unbounded');
    const real = fs.realpathSync(directory), stat = fs.lstatSync(real), alias = fs.lstatSync(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Typed file parent is not a real directory');
    assert.equal(stat.uid, 0, 'Typed file parent is not root-owned');
    assert.equal(stat.mode & 0o022, 0, 'Typed file parent is group/world writable');
    assert.equal(alias.uid, 0, 'Typed file parent alias is not root-owned');
    assert.equal(alias.mode & 0o022, 0, 'Typed file parent alias is group/world writable');
    result.push({ path: directory, realPath: real, identity: identity(stat), aliasIdentity: identity(alias) });
    if (real === stop || directory === '/') break;
    assert.ok(real.startsWith(stop + path.sep) || stop === '/', 'Typed file escapes its approved parent boundary');
    directory = path.dirname(directory);
  }
  return result;
}

function validateCategory(category, stat, expectedUid) {
  assert.ok(CATEGORIES.has(category), 'Unknown typed file category');
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Typed input must resolve to a regular file');
  assert.equal(stat.mode & 0o022, 0, 'Typed input is group/world writable');
  if (category === 'root_control' || category === 'receipt') {
    assert.equal(stat.uid, 0, 'Root control/receipt input must be root-owned');
    assert.equal(stat.nlink, 1, 'Root control/receipt input must be single-link');
  } else if (category === 'app') {
    assert.ok(Number.isSafeInteger(expectedUid) && expectedUid >= 0, 'App input requires an expected uid');
    assert.equal(stat.uid, expectedUid, 'App input owner differs from the expected application uid');
    assert.equal(stat.nlink, 1, 'App input must be single-link');
  } else if (category === 'tar') {
    if (expectedUid !== undefined) assert.equal(stat.uid, expectedUid, 'Tar input owner differs from the expected uid');
    assert.equal(stat.nlink, 1, 'Tar input must be single-link');
  } else {
    assert.equal(stat.uid, 0, 'System input must resolve to a root-owned file');
    assert.ok(stat.nlink >= 1, 'System input link count is invalid');
  }
}

export function validateTypedFileSnapshot(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [
    'schema', 'category', 'requestedPath', 'realPath', 'parentBoundary', 'maximumBytes', 'identity', 'alias', 'parents', 'sha256',
  ].sort());
  assert.equal(value.schema, TYPED_FILE_SCHEMA);
  assert.ok(CATEGORIES.has(value.category));
  assert.ok(path.isAbsolute(value.requestedPath) && path.isAbsolute(value.realPath) && path.isAbsolute(value.parentBoundary));
  assert.match(value.sha256, HASH);
  assert.ok(Number.isSafeInteger(value.maximumBytes) && value.maximumBytes > 0);
  validateIdentity(value.identity, 'typed file identity');
  assert.ok(Number.isSafeInteger(value.identity.size) && value.identity.size > 0 && value.identity.size <= value.maximumBytes);
  assert.ok(Array.isArray(value.parents));
  for (const [index, parent] of value.parents.entries()) {
    assert.ok(parent && typeof parent === 'object' && !Array.isArray(parent));
    assert.deepEqual(Object.keys(parent).sort(), ['path', 'realPath', 'identity', 'aliasIdentity'].sort());
    assert.ok(path.isAbsolute(parent.path) && path.isAbsolute(parent.realPath));
    validateIdentity(parent.identity, `typed file parent ${index} identity`);
    validateIdentity(parent.aliasIdentity, `typed file parent ${index} alias identity`);
    assert.equal(parent.identity.uid, 0); assert.equal(parent.identity.mode & 0o022, 0);
    assert.equal(parent.aliasIdentity.uid, 0); assert.equal(parent.aliasIdentity.mode & 0o022, 0);
  }
  if (value.category !== 'system') {
    assert.equal(value.requestedPath, value.realPath);
    assert.equal(value.alias, null);
    assert.equal(value.identity.nlink, 1);
  } else {
    assert.ok(value.parents.length > 0, 'System input requires an approved root-owned parent chain');
    assert.ok(value.alias && value.alias.before && value.alias.after);
    assert.deepEqual(Object.keys(value.alias).sort(), ['before', 'after', 'realPathBefore', 'realPathAfter'].sort());
    assert.equal(value.alias.realPathBefore, value.realPath); assert.equal(value.alias.realPathAfter, value.realPath);
    validateIdentity(value.alias.before, 'typed system alias before identity');
    validateIdentity(value.alias.after, 'typed system alias after identity');
    assert.deepEqual(value.alias.before, value.alias.after, 'System alias identity changed while reading');
  }
  return value;
}

function readTypedFileUnchecked({ file, category, maximumBytes = DEFAULT_LIMITS[category], expectedUid, expectedSha256,
  requireRootParents = category === 'system', parentBoundary = '/' }) {
  const requestedPath = safeAbsolute(file);
  const resolvedParentBoundary = safeAbsolute(parentBoundary);
  assert.ok(CATEGORIES.has(category), 'Unknown typed file category');
  assert.ok(Number.isSafeInteger(maximumBytes) && maximumBytes > 0 && maximumBytes <= 1024 ** 3, 'Typed file size limit is invalid');
  if (expectedSha256 !== undefined) assert.match(expectedSha256, HASH);
  const aliasBefore = fs.lstatSync(requestedPath), realBefore = fs.realpathSync(requestedPath);
  if (category !== 'system') {
    assert.equal(realBefore, requestedPath, 'Aliases are permitted only for typed system files');
    assert.equal(aliasBefore.isSymbolicLink(), false, 'Typed input path is a symlink');
  }
  const before = fs.lstatSync(realBefore);
  validateCategory(category, before, expectedUid);
  assert.ok(before.size > 0 && before.size <= maximumBytes, 'Typed file size is outside the approved bounds');
  const captureParents = () => {
    const captured = requireRootParents ? parentSnapshots(requestedPath, resolvedParentBoundary) : [];
    if (category === 'system' && realBefore !== requestedPath)
      captured.push(...parentSnapshots(realBefore, resolvedParentBoundary)
        .filter(item => !captured.some(existing => existing.path === item.path)));
    return captured;
  };
  const parents = captureParents();
  const fd = fs.openSync(realBefore, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes, openedBefore, openedAfter;
  try {
    openedBefore = fs.fstatSync(fd);
    assert.deepEqual(identity(openedBefore), identity(before), 'Typed file changed before descriptor read');
    bytes = fs.readFileSync(fd);
    openedAfter = fs.fstatSync(fd);
    assert.deepEqual(identity(openedAfter), identity(before), 'Typed file changed during descriptor read');
  } finally { fs.closeSync(fd); }
  const realAfter = fs.realpathSync(requestedPath), aliasAfter = fs.lstatSync(requestedPath), pathAfter = fs.lstatSync(realAfter);
  assert.equal(realAfter, realBefore, 'Typed file real path changed while reading');
  assert.deepEqual(identity(pathAfter), identity(before), 'Typed file path identity changed while reading');
  assert.deepEqual(identity(aliasAfter), identity(aliasBefore), 'Typed file alias identity changed while reading');
  assert.deepEqual(comparableParentSnapshots(captureParents()), comparableParentSnapshots(parents), 'Typed file parent identity changed while reading');
  const sha256 = digest(bytes);
  if (expectedSha256 !== undefined) assert.equal(sha256, expectedSha256, 'Typed file bytes differ from the approved digest');
  const snapshot = validateTypedFileSnapshot({
    schema: TYPED_FILE_SCHEMA,
    category,
    requestedPath,
    realPath: realBefore,
    parentBoundary: resolvedParentBoundary,
    maximumBytes,
    identity: identity(before),
    alias: category === 'system' ? { realPathBefore: realBefore, realPathAfter: realAfter,
      before: identity(aliasBefore), after: identity(aliasAfter) } : null,
    parents,
    sha256,
  });
  return { bytes, snapshot };
}

export function readTypedFile(input) {
  try { return readTypedFileUnchecked(input); }
  catch (cause) {
    if (cause?.code !== 'ERR_ASSERTION') throw cause;
    const error = new TypeError('Typed file input violates its category, ownership, path, identity, or size contract.', { cause });
    error.code = 'EINVAL'; throw error;
  }
}

export function readTypedJson(input) {
  const result = readTypedFile(input);
  try {
    const value = JSON.parse(result.bytes.toString('utf8'));
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Typed JSON root must be an object');
    return { ...result, value };
  } catch (cause) {
    const error = new TypeError('Typed JSON input is not a valid object document.', { cause });
    error.code = 'EINVAL'; throw error;
  }
}

export function assertTypedFileUnchanged(snapshot, overrides = {}) {
  validateTypedFileSnapshot(snapshot);
  const current = readTypedFile({
    file: snapshot.requestedPath,
    category: snapshot.category,
    maximumBytes: snapshot.maximumBytes,
    expectedUid: overrides.expectedUid ?? snapshot.identity.uid,
    expectedSha256: snapshot.sha256,
    requireRootParents: snapshot.parents.length > 0,
    parentBoundary: overrides.parentBoundary || snapshot.parentBoundary,
  }).snapshot;
  assert.deepEqual({ ...current, parents: comparableParentSnapshots(current.parents) },
    { ...snapshot, parents: comparableParentSnapshots(snapshot.parents) }, 'Typed file identity, alias, parent chain, or bytes changed');
  return current;
}
