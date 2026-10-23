import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { MV_DIRECT, assertMvDirectReady } from './release-contract.mjs';

// Local packaging only. Importing this module does not archive, write, upload or contact a service.
const SHA = /^[a-f0-9]{40}$/;
const BASELINE_SOURCE = MV_DIRECT.baselineSource;
const EXPECTED_VERSIONS = MV_DIRECT.versions;
const REQUIRED_UPLOAD_FILES = ['scripts/check-image-recovery.mjs', 'scripts/upload-recovery-engineering.mjs',
  'scripts/upload-private-directory-engineering.ts', 'scripts/upload-raw-recovery-engineering.mjs',
  'scripts/upload-client-recovery-engineering.ts', 'scripts/upload-root-cure-smoke.ts', 'src/lib/assets/verified-upload.ts',
  'src/app/api/assets/upload/route.ts', 'src/lib/http/file-upload.ts', 'src/components/ResourceLibraryPicker.tsx'];
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TREE_BYTES = 32 * 1024 * 1024;
const MAX_METADATA_BYTES = 65536;
const GIT_ENV = { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', LANG: 'C', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_LITERAL_PATHSPECS: '1',
  GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
const scriptFile = fileURLToPath(import.meta.url);
const projectRoot = '/Volumes/Data/Projects/video-api-debugger';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(code); };

function git(repo, args, options = {}) {
  return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', repo, ...args],
    { env: GIT_ENV, timeout: 120000, maxBuffer: MAX_TREE_BYTES, ...options });
}
function gitText(repo, args) { return git(repo, args, { encoding: 'utf8' }).trim(); }
function sameRepository(repo) {
  const actual = fs.realpathSync(repo);
  assert.equal(fs.realpathSync(gitText(actual, ['rev-parse', '--show-toplevel'])), actual, 'repoRoot must be the repository root');
  const common = root => fs.realpathSync(path.resolve(root, gitText(root, ['rev-parse', '--git-common-dir'])));
  assert.equal(common(actual), common(fs.realpathSync(projectRoot)), 'repoRoot belongs to a different project repository');
  assert.equal(gitText(actual, ['rev-parse', '--show-object-format']), 'sha1', 'only the project SHA-1 object format is supported');
  return actual;
}
function safePath(value, directory = false) {
  assert.ok(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4096, 'invalid source path');
  const normalized = directory && value.endsWith('/') ? value.slice(0, -1) : value;
  assert.ok(normalized && !path.posix.isAbsolute(normalized) && !/^[A-Za-z]:/.test(normalized)
    && !/[\u0000-\u001f\u007f\\]/.test(normalized), 'unsafe archive path');
  assert.ok(normalized.split('/').every(part => part && part !== '.' && part !== '..'), 'unsafe archive path components');
  return normalized;
}
function excludedPath(file) {
  const parts = file.split('/');
  if (parts.some(part => part.startsWith('.env'))) return 'environment-file';
  if (/\.(?:db|sqlite|sqlite3)(?:[-_.].*)?$/i.test(file)
    || /(?:^|\/)[^/]*(?:backup|dump)[^/]*\.(?:sql|dump|bak|db|sqlite|sqlite3|gz|bz2|xz|zip|tgz|tar)$/i.test(file)
    || /\.bak$/i.test(file)) return 'database-or-backup';
  if (parts.some(part => part === 'node_modules' || part === '.git' || /^\.next/.test(part))) return 'runtime-directory';
  if (/^(?:storage|uploads|videos|runtime|var-lib|backups|logs|cache|tmp|temp|releases|release-staging)(?:\/|$)/.test(file)
    || /^public\/(?:uploads|videos)(?:\/|$)/.test(file)
    || /^docs\/materials(?:\/|$)/.test(file)) return 'runtime-or-private-data';
  return null;
}
function emptyPlaceholder(entry) {
  return entry.bytes === 0 && ['.gitkeep', '.keep', '.placeholder'].includes(path.posix.basename(entry.file));
}
function sourceTree(repo, source) {
  assert.match(source, SHA, 'source must be a full lowercase 40-character committed object');
  assert.equal(gitText(repo, ['cat-file', '-t', source]), 'commit', 'source must be a commit, not a tag/tree/blob');
  assert.equal(gitText(repo, ['rev-parse', `${source}^{commit}`]), source, 'source object changed');
  const tree = gitText(repo, ['rev-parse', `${source}^{tree}`]); assert.match(tree, SHA);
  const bytes = git(repo, ['ls-tree', '-r', '-z', '-l', '--full-tree', source]);
  const files = new Map(), exclusions = []; let totalBytes = 0;
  for (const record of bytes.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    assert.ok(tab > 0, 'invalid git tree record');
    const match = /^(\d{6}) (\S+) ([a-f0-9]{40})\s+(\d+|-)$/u.exec(record.slice(0, tab));
    assert.ok(match, 'unsupported git tree record');
    const file = safePath(record.slice(tab + 1));
    assert.ok(match[2] === 'blob' && ['100644', '100755'].includes(match[1]), 'symlinks, submodules and special source entries are forbidden');
    const entry = { file, mode: match[1], gitBlob: match[3], bytes: Number(match[4]) };
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0, 'invalid source object size');
    // Explicit release-package exclusions: these historical tracked paths are
    // replaced by protected runtime bindings, never read, uploaded or deleted here.
    if (file.split('/')[0].startsWith('.env') || /^public\/(?:uploads|videos)(?:\/|$)/.test(file)
      || /^docs\/materials(?:\/|$)/.test(file)) {
      exclusions.push({ ...entry, reason: file.split('/')[0].startsWith('.env')
        ? 'approved-root-environment-exclusion' : /^docs\/materials(?:\/|$)/.test(file)
          ? 'approved-private-materials-exclusion' : 'approved-root-user-media-exclusion' });
      continue;
    }
    assert.ok(entry.bytes <= MAX_FILE_BYTES, 'source file exceeds package budget');
    const reason = excludedPath(file);
    if (reason) {
      assert.ok(emptyPlaceholder(entry), 'tracked runtime, private data, credentials or database content must not be packaged');
      exclusions.push({ ...entry, reason: `empty-placeholder:${reason}` });
      continue;
    }
    assert.ok(!files.has(file), 'duplicate source tree path');
    files.set(file, entry); totalBytes += entry.bytes;
    assert.ok(files.size <= 50000 && totalBytes <= MAX_SOURCE_BYTES, 'source tree exceeds package budget');
  }
  assert.ok(files.size > 20 && files.has('package.json') && files.has('package-lock.json'), 'incomplete project source tree');
  const argumentsBytes = [...files.keys()].reduce((total, file) => total + Buffer.byteLength(file) + 1, 0);
  assert.ok(argumentsBytes <= 512 * 1024, 'source path arguments exceed the supported local git archive budget');
  return { source, tree, files, exclusions: exclusions.sort((a, b) => a.file.localeCompare(b.file)), totalBytes };
}
function tarText(bytes) {
  const end = bytes.indexOf(0);
  return new TextDecoder('utf-8', { fatal: true }).decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function octal(bytes) {
  const value = tarText(bytes).trim();
  assert.ok(/^[0-7]*$/.test(value), 'unsupported tar number');
  const number = value ? Number.parseInt(value, 8) : 0;
  assert.ok(Number.isSafeInteger(number) && number >= 0, 'invalid tar number'); return number;
}
function paxFields(bytes) {
  const fields = Object.create(null); let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    assert.ok(space > offset && space - offset <= 10, 'invalid pax record');
    const lengthText = bytes.subarray(offset, space).toString('ascii'); assert.match(lengthText, /^\d+$/);
    const length = Number(lengthText), end = offset + length;
    assert.ok(Number.isSafeInteger(length) && end <= bytes.length && end > space + 2 && bytes[end - 1] === 10, 'invalid pax length');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(space + 1, end - 1));
    const equals = text.indexOf('='); assert.ok(equals > 0, 'invalid pax field');
    const key = text.slice(0, equals); assert.ok(!Object.hasOwn(fields, key), 'duplicate pax field');
    fields[key] = text.slice(equals + 1); offset = end;
  }
  return fields;
}
class SourceArchiveVerifier extends Transform {
  constructor(source) {
    super(); this.source = source; this.pending = Buffer.alloc(0); this.entry = null; this.padding = 0;
    this.zeroBlocks = 0; this.files = Object.create(null); this.seen = new Set(); this.localPax = null;
    this.packageBytes = null;
    this.directories = new Set([...source.files.keys()].flatMap(file => {
      const pieces = file.split('/'); return pieces.slice(0, -1).map((_, index) => pieces.slice(0, index + 1).join('/'));
    }));
  }
  _transform(chunk, _encoding, callback) {
    try { this.parse(Buffer.from(chunk)); callback(null, chunk); } catch (error) { callback(error); }
  }
  parse(chunk) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    for (;;) {
      if (this.entry) {
        const take = Math.min(this.entry.remaining, this.pending.length);
        if (!take) return;
        const bytes = this.pending.subarray(0, take); this.pending = this.pending.subarray(take);
        this.entry.remaining -= take;
        if (this.entry.metadata) this.entry.chunks.push(Buffer.from(bytes));
        else { this.entry.sha256.update(bytes); this.entry.gitHash.update(bytes); if (this.entry.file === 'package.json') this.entry.chunks.push(Buffer.from(bytes)); }
        if (this.entry.remaining) continue;
        this.completeEntry();
      }
      if (this.padding) {
        const take = Math.min(this.padding, this.pending.length);
        assert.ok(this.pending.subarray(0, take).every(byte => byte === 0), 'nonzero tar padding');
        this.pending = this.pending.subarray(take); this.padding -= take;
        if (this.padding || !this.pending.length) return;
      }
      if (this.pending.length < 512) return;
      const header = this.pending.subarray(0, 512); this.pending = this.pending.subarray(512);
      if (header.every(byte => byte === 0)) { this.zeroBlocks++; continue; }
      assert.equal(this.zeroBlocks, 0, 'tar contains content after end marker');
      const expectedChecksum = octal(header.subarray(148, 156));
      const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      assert.equal(checksum, expectedChecksum, 'tar header checksum mismatch');
      const prefix = tarText(header.subarray(345, 500)), name = tarText(header.subarray(0, 100));
      const headerPath = prefix ? `${prefix}/${name}` : name;
      const type = String.fromCharCode(header[156] || 48), size = octal(header.subarray(124, 136));
      assert.ok(['0', '5', 'x', 'g'].includes(type), 'archive symlinks, hard links and special entries are forbidden');
      safePath(headerPath, type === '5');
      assert.equal(octal(header.subarray(100, 108)) & 0o7000, 0, 'archive special permissions are forbidden');
      assert.equal(tarText(header.subarray(157, 257)), '', 'archive link target is forbidden');
      if (type === 'g' || type === 'x') {
        assert.ok(size > 0 && size <= MAX_METADATA_BYTES, 'tar metadata exceeds budget');
        this.entry = { metadata: type, remaining: size, size, chunks: [] };
      } else {
        const file = safePath(this.localPax?.path || headerPath, type === '5');
        this.localPax = null;
        assert.ok(!this.seen.has(file), 'duplicate archive entry'); this.seen.add(file);
        if (type === '5') {
          assert.equal(size, 0, 'nonempty archive directory'); assert.ok(this.directories.has(file), 'unexpected archive directory');
          continue;
        }
        const expected = this.source.files.get(file);
        assert.ok(expected && !excludedPath(file), 'archive contains a path outside the committed source selection');
        assert.equal(size, expected.bytes, 'archive file length differs from commit');
        assert.ok(file !== 'package.json' || size <= 1024 * 1024, 'package metadata exceeds budget');
        this.entry = { file, expected, remaining: size, size, chunks: [], sha256: createHash('sha256'),
          gitHash: createHash('sha1').update(Buffer.from(`blob ${size}\0`)) };
        if (!size) this.completeEntry();
      }
    }
  }
  completeEntry() {
    const entry = this.entry;
    if (entry.metadata) {
      const fields = paxFields(Buffer.concat(entry.chunks));
      if (entry.metadata === 'g') {
        assert.ok(Object.keys(fields).every(key => key === 'comment'), 'unsupported global tar metadata');
        if (fields.comment !== undefined) assert.equal(fields.comment, this.source.source, 'tar source commit differs');
      } else {
        assert.ok(!this.localPax && Object.keys(fields).every(key => key === 'path' || key === 'mtime'), 'unsupported local tar metadata');
        if (fields.path !== undefined) safePath(fields.path);
        if (fields.mtime !== undefined) assert.match(fields.mtime, /^-?\d+(?:\.\d+)?$/);
        this.localPax = fields;
      }
    } else {
      assert.equal(entry.gitHash.digest('hex'), entry.expected.gitBlob, 'archive bytes differ from the exact committed blob (including export attributes)');
      this.files[entry.file] = entry.sha256.digest('hex');
      if (entry.file === 'package.json') this.packageBytes = Buffer.concat(entry.chunks);
    }
    this.padding = (512 - entry.size % 512) % 512; this.entry = null;
  }
  _flush(callback) {
    try {
      assert.ok(!this.entry && !this.padding && !this.pending.length && !this.localPax && this.zeroBlocks >= 2, 'incomplete tar archive');
      assert.deepEqual(Object.keys(this.files).sort(), [...this.source.files.keys()].sort(), 'archive omitted committed source files');
      callback();
    } catch (error) { callback(error); }
  }
}
function privateJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
async function hashFile(file) {
  const digest = createHash('sha256'); for await (const bytes of fs.createReadStream(file)) digest.update(bytes); return digest.digest('hex');
}
async function archiveCandidate(repo, output, kind, source) {
  const destination = path.join(output, kind);
  fs.mkdirSync(destination, { mode: 0o700 });
  const archive = path.join(destination, 'source.tar.gz'), sourceManifest = path.join(destination, 'source-manifest.json');
  const child = spawn('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', repo,
    'archive', '--format=tar', source.source, '--', ...source.files.keys()], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrBytes = 0;
  child.stderr.on('data', bytes => { stderrBytes += bytes.length; if (stderrBytes > 65536) child.kill(); });
  const completion = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('git_archive_start_failed')));
    child.once('close', code => code === 0 ? resolve() : reject(new Error('git_archive_failed')));
  });
  const deadline = new AbortController();
  const timer = setTimeout(() => { deadline.abort(); child.kill(); }, 120000);
  const verifier = new SourceArchiveVerifier(source);
  try {
    await Promise.all([completion, pipeline(child.stdout, verifier, createGzip({ level: 9 }),
      fs.createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal: deadline.signal })]);
  } catch (error) { child.kill(); throw error; } finally { clearTimeout(timer); }
  fs.chmodSync(archive, 0o600);
  const packageInfo = JSON.parse(verifier.packageBytes.toString('utf8'));
  assert.equal(packageInfo.name, 'video-api-debugger', 'commit is not the video-api-debugger application');
  assert.equal(packageInfo.version, EXPECTED_VERSIONS[kind], 'candidate version differs from the approved release pair');
  const files = Object.fromEntries(Object.entries(verifier.files).sort(([a], [b]) => a.localeCompare(b)));
  const fileDetails = Object.fromEntries([...source.files].sort(([a], [b]) => a.localeCompare(b))
    .map(([file, entry]) => [file, { gitBlob: entry.gitBlob, mode: entry.mode, bytes: entry.bytes }]));
  const archiveSha256 = await hashFile(archive);
  const manifest = { schema: 'rate-impl2-source-manifest.v1', project: 'video-api-debugger', kind,
    baselineSource: BASELINE_SOURCE,
    source: source.source, tree: source.tree, version: packageInfo.version, archiveSha256, files,
    fileDetails, fileCount: Object.keys(files).length, totalSourceBytes: source.totalBytes,
    exclusions: source.exclusions, coverage: 'all regular committed source blobs except the explicitly listed approved root environment/user-media/private-materials paths and empty runtime/private placeholders',
    verification: 'git archive bytes matched every selected Git blob; SHA-256 hashes cover the same bytes',
    companionFiles: Object.fromEntries(['package.json', 'package-lock.json', 'src/lib/release.ts', 'src/app/api/release/route.ts']
      .filter(file => files[file]).map(file => [file, files[file]])), createdAt: new Date().toISOString() };
  privateJson(sourceManifest, manifest);
  return { source: source.source, tree: source.tree, version: packageInfo.version, archive, sourceManifest, archiveSha256,
    manifestSha256: await hashFile(sourceManifest), fileCount: manifest.fileCount, exclusions: source.exclusions };
}

// The remote preparer verifies the same tar/blob contract before extraction.
export async function verifyRateSourceArchive({ archive, manifest }) {
  assert.equal(manifest.schema, 'rate-impl2-source-manifest.v1'); assert.equal(manifest.project, 'video-api-debugger');
  assert.ok(Object.hasOwn(EXPECTED_VERSIONS, manifest.kind)); assert.equal(manifest.version, EXPECTED_VERSIONS[manifest.kind]);
  assert.match(manifest.source, SHA); assert.match(manifest.tree, SHA);
  assert.equal(manifest.baselineSource, BASELINE_SOURCE);
  assert.ok(path.isAbsolute(archive)); assert.equal(fs.realpathSync(archive), archive);
  const stat = fs.lstatSync(archive);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= MAX_SOURCE_BYTES);
  assert.equal(await hashFile(archive), manifest.archiveSha256);
  assert.ok(manifest.files && manifest.fileDetails && Object.keys(manifest.files).length > 100);
  for (const file of REQUIRED_UPLOAD_FILES) assert.match(manifest.files[file], /^[a-f0-9]{64}$/, 'Missing upload fix source: ' + file);
  assert.deepEqual(Object.keys(manifest.fileDetails).sort(), Object.keys(manifest.files).sort());
  const files = new Map(); let totalBytes = 0;
  for (const [file, expected] of Object.entries(manifest.files)) {
    safePath(file); assert.equal(excludedPath(file), null); assert.match(expected, /^[a-f0-9]{64}$/);
    const detail = manifest.fileDetails[file]; assert.match(detail.gitBlob, SHA);
    assert.ok(['100644', '100755'].includes(detail.mode));
    assert.ok(Number.isSafeInteger(detail.bytes) && detail.bytes >= 0 && detail.bytes <= MAX_FILE_BYTES);
    totalBytes += detail.bytes; assert.ok(totalBytes <= MAX_SOURCE_BYTES && files.size < 50000);
    files.set(file, { ...detail, file });
  }
  assert.equal(files.size, manifest.fileCount); assert.equal(totalBytes, manifest.totalSourceBytes);
  const verifier = new SourceArchiveVerifier({ source: manifest.source, files });
  await pipeline(fs.createReadStream(archive), createGunzip(), verifier,
    new Writable({ write(_bytes, _encoding, done) { done(); } }), { signal: AbortSignal.timeout(120000) });
  assert.deepEqual(Object.fromEntries(Object.entries(verifier.files).sort(([a], [b]) => a.localeCompare(b))), manifest.files);
  assert.equal(JSON.parse(verifier.packageBytes.toString('utf8')).version, manifest.version);
  assert.equal(await hashFile(archive), manifest.archiveSha256, 'Archive changed while being verified');
  return { source: manifest.source, archiveSha256: manifest.archiveSha256, fileCount: files.size, verifiedCommittedBlobs: true };
}

async function copyOriginalSourcePackage(output, kind, selected, original) {
  const read = (file, maximum = MAX_SOURCE_BYTES) => {
    assert.equal(fs.realpathSync(file), file); const stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && !(stat.mode & 0o022)
      && stat.size > 0 && stat.size <= maximum);
    const bytes = fs.readFileSync(file), after = fs.lstatSync(file);
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid', 'gid', 'nlink']) assert.equal(after[key], stat[key]);
    return bytes;
  };
  const directory = fs.realpathSync(original.directory); assert.equal(directory, original.directory);
  const originBytes = read(directory + '/manifest.json', MAX_TREE_BYTES), origin = JSON.parse(originBytes);
  assert.equal(hash(originBytes), original.manifestSha256); assert.equal(origin.runId, original.sourceRun);
  const capsuleBytes = read(directory + '/' + kind + '-immutable-success.json', 128 * 1024 * 1024), capsule = JSON.parse(capsuleBytes);
  assert.equal(hash(capsuleBytes), original[kind + 'Sha256']); assert.equal(capsule.schema, 'sd2-immutable-successful-build.v1');
  assert.equal(capsule.kind, kind); assert.equal(capsule.sourceRun, original.sourceRun);
  assert.equal(capsule.originalManifestSha256, original.manifestSha256);
  assert.equal(capsule.originalReceipt.source, selected.source); assert.equal(capsule.originalReceipt.exitCode, 0);
  assert.equal(capsule.originalTimesChanged, false); assert.equal(capsule.newCompilationClaimed, false);
  const bytes = read(directory + '/' + kind + '/source-manifest.json', MAX_TREE_BYTES), manifest = JSON.parse(bytes);
  assert.equal(hash(bytes), capsule.originalSourceManifestSha256);
  assert.equal(hash(bytes), capsule.originalReceipt.sourceManifestSha256);
  assert.equal(manifest.source, selected.source); assert.equal(manifest.tree, selected.tree);
  assert.deepEqual(manifest.fileDetails, Object.fromEntries([...selected.files].sort(([a], [b]) => a.localeCompare(b))
    .map(([file, entry]) => [file, { gitBlob: entry.gitBlob, mode: entry.mode, bytes: entry.bytes }])));
  const archiveBytes = read(directory + '/' + kind + '/source.tar.gz'); assert.equal(hash(archiveBytes), manifest.archiveSha256);
  await verifyRateSourceArchive({ archive: directory + '/' + kind + '/source.tar.gz', manifest });
  const destination = path.join(output, kind); fs.mkdirSync(destination, { mode: 0o700 });
  const sourceManifest = destination + '/source-manifest.json', archive = destination + '/source.tar.gz';
  // Preserve the original byte identity and its real createdAt. A packaging time
  // belongs only to the new package receipt, never to the sealed build input.
  fs.writeFileSync(sourceManifest, bytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(archive, archiveBytes, { flag: 'wx', mode: 0o600 });
  return { source: selected.source, tree: selected.tree, version: manifest.version, archive, sourceManifest,
    archiveSha256: manifest.archiveSha256, manifestSha256: hash(bytes), fileCount: manifest.fileCount,
    exclusions: manifest.exclusions, originalSourceManifestPreserved: true, originalCreatedAt: manifest.createdAt };
}

export async function packageRateCandidates(input) {
  assertMvDirectReady();
  assert.ok(input && typeof input.repoRoot === 'string' && path.isAbsolute(input.repoRoot), 'repoRoot must be explicit and absolute');
  assert.ok(typeof input.outputRoot === 'string' && path.isAbsolute(input.outputRoot), 'outputRoot must be explicit and absolute');
  assert.match(input.mainSource, SHA); assert.match(input.guardSource, SHA); assert.notEqual(input.mainSource, input.guardSource);
  assert.equal(input.mainSource, MV_DIRECT.mainSource);
  const repo = sameRepository(input.repoRoot);
  // Resolve and reject the entire source selection before opening any blob content or creating output.
  const sources = { main: sourceTree(repo, input.mainSource), guard: sourceTree(repo, input.guardSource) };
  for (const source of Object.values(sources)) git(repo, ['merge-base', '--is-ancestor', MV_DIRECT.sourceBase, source.source]);
  const changed = source => gitText(repo, ['diff', '--name-only', MV_DIRECT.sourceBase, source]).split('\n').filter(Boolean).sort();
  assert.deepEqual(gitText(repo, ['diff', '--name-only', input.mainSource, input.guardSource]).split('\n').filter(Boolean).sort(),
    [...MV_DIRECT.guardChangedFiles].sort(),
    'Guard may revert only the reviewed integrated display and its release summary; original HD, upload recovery, preset receipt readers and prior fixes remain compatible');
  assert.deepEqual(changed(input.mainSource), [...MV_DIRECT.approvedMainFiles].sort(), 'Only the reviewed MV-DIRECT diff may be published');
  const requestedOutput = path.resolve(input.outputRoot), parent = fs.realpathSync(path.dirname(requestedOutput));
  const output = path.join(parent, path.basename(requestedOutput));
  const outputRelative = path.relative(repo, output);
  assert.ok(output !== repo && !repo.startsWith(output + path.sep)
    && !/^(?:\.git|node_modules|\.next[^/]*|storage|public\/(?:uploads|videos))(?:\/|$)/.test(outputRelative), 'unsafe outputRoot');
  fs.mkdirSync(output, { mode: 0o700 }); // Exclusive: never adopt or overwrite an existing package directory.
  fs.chmodSync(output, 0o700);
  assert.equal(fs.realpathSync(output), output);
  try {
    const pack = (kind) => input.originalBuilds ? copyOriginalSourcePackage(output, kind, sources[kind], input.originalBuilds)
      : archiveCandidate(repo, output, kind, sources[kind]);
    const main = await pack('main');
    const guard = await pack('guard');
    const receipt = { schema: 'rate-impl2-package-candidates.v1', project: 'video-api-debugger', repoRoot: repo,
      outputRoot: output, main, guard, createdAt: new Date().toISOString(),
      protections: { exactCommittedBlobs: true, workingTreeRead: false, networkUsed: false, runtimeDataRead: false, oldFilesDeleted: false } };
    const receiptFile = path.join(output, 'rate-impl2-package-receipt.json'); privateJson(receiptFile, receipt);
    return { ...receipt, receiptFile };
  } catch (error) {
    privateJson(path.join(output, 'package-failure.json'), { schema: 'rate-impl2-package-failure.v1', mainSource: input.mainSource,
      guardSource: input.guardSource, status: 'incomplete', partialFilesRetained: true, createdAt: new Date().toISOString() });
    throw error;
  }
}

function cliInput(args) {
  const allowed = { '--repo-root': 'repoRoot', '--main-source': 'mainSource', '--guard-source': 'guardSource', '--output-root': 'outputRoot' };
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = allowed[args[index]];
    assert.ok(key && !Object.hasOwn(result, key) && typeof args[index + 1] === 'string', 'four explicit unique packaging arguments are required');
    result[key] = args[index + 1];
  }
  assert.equal(Object.keys(result).length, 4, 'repoRoot/mainSource/guardSource/outputRoot are required'); return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  packageRateCandidates(cliInput(process.argv.slice(2))).then(result => {
    console.log(JSON.stringify({ status: 'packaged', outputRoot: result.outputRoot, receiptFile: result.receiptFile,
      mainSource: result.main.source, guardSource: result.guard.source }));
  }).catch(() => { console.error('RATE-IMPL2 candidate packaging failed; no existing package was overwritten or removed.'); process.exitCode = 1; });
}


