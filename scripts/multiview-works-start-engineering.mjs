import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { observeMultiviewWorksStart, MULTIVIEW_WORKS_START_FILE } from '../ops/sd2-multiview-works-start.mjs';

const candidateRoot = fs.realpathSync(process.cwd());
const scratch = path.join(candidateRoot, '.role-tests');
fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
fs.chmodSync(scratch, 0o700);
const destination = path.resolve(candidateRoot, process.argv[2] || '');
const relativeDestination = path.relative(scratch, destination);
assert.ok(process.argv[2] && relativeDestination && relativeDestination !== '..'
  && !relativeDestination.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeDestination));
fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
assert.ok(fs.realpathSync(path.dirname(destination)).startsWith(fs.realpathSync(scratch) + path.sep)
  || fs.realpathSync(path.dirname(destination)) === fs.realpathSync(scratch));

const files = ['ops/sd2-multiview-works-start.mjs', 'scripts/multiview-works-start-engineering.mjs'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = () => Object.fromEntries(files.map(file => [file, sha(fs.readFileSync(path.join(candidateRoot, file)))]));
const sourceSha256 = hashes();
const directory = fs.mkdtempSync(path.join(scratch, 'multiview-works-start-'));
const virtualRoot = path.join(directory, 'virtual');
const appUid = 731;
const mainSource = 'a'.repeat(40), guardSource = 'b'.repeat(40);
const requiredSources = [
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
];
const local = virtual => {
  assert.ok(typeof virtual === 'string' && virtual.startsWith('/'));
  return path.join(virtualRoot, virtual.slice(1));
};
const write = (virtual, bytes, mode = 0o644) => {
  const target = local(virtual);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, bytes, { flag: 'wx', mode });
};

function release(source, version, build, label) {
  const root = `/data/video-api-debugger/managed-releases/${source}`;
  const sourceHashes = {};
  write(root + '/.deployed-commit', source + '\n');
  write(root + '/package.json', JSON.stringify({ name: `synthetic-${label}`, version }));
  write(root + '/.next-prod-candidate/BUILD_ID', build + '\n');
  fs.symlinkSync('.next-prod-candidate', local(root + '/.next-prod'));
  for (const file of requiredSources) {
    const bytes = Buffer.from(`synthetic ${label} ${file}\n`);
    write(root + '/' + file, bytes);
    sourceHashes[file] = sha(bytes);
  }
  return { root, source, version, build, sourceSha256: sourceHashes };
}

const main = release(mainSource, '0.103.0', 'synthetic-main-build', 'main');
const guard = release(guardSource, '0.102.1', 'synthetic-guard-build', 'guard');
const contract = {
  schema: 'sd2-multiview-works-start.v1',
  runId: '00000000-0000-4000-8000-000000000731',
  manifestSha256: 'c'.repeat(64),
  appUid,
  releases: [main, guard],
};
write(MULTIVIEW_WORKS_START_FILE, JSON.stringify(contract), 0o644);

function shape(stat, virtual) {
  return {
    type: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'other',
    nlink: stat.nlink,
    uid: virtual === MULTIVIEW_WORKS_START_FILE || virtual.endsWith('/.next-prod') && stat.isSymbolicLink() ? 0 : appUid,
    mode: stat.mode,
    dev: virtual === '/' ? 11 : 22,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}
function adapter(cwd, uid = appUid) {
  return {
    platform: 'linux', nodeVersion: '20.20.2', uid: () => uid, cwd: () => cwd,
    realpath: virtual => {
      const actual = fs.realpathSync(local(virtual));
      const relative = path.relative(fs.realpathSync(virtualRoot), actual);
      assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`));
      return relative ? '/' + relative.split(path.sep).join('/') : '/';
    },
    lstat: virtual => shape(fs.lstatSync(local(virtual)), virtual),
    stat: virtual => shape(fs.statSync(local(virtual)), virtual),
    readlink: virtual => fs.readlinkSync(local(virtual)),
    readStableFile: virtual => {
      const descriptor = fs.openSync(local(virtual), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const before = shape(fs.fstatSync(descriptor), virtual);
        const bytes = fs.readFileSync(descriptor);
        const after = shape(fs.fstatSync(descriptor), virtual);
        return { bytes, before, after };
      } finally { fs.closeSync(descriptor); }
    },
    accessReadable: virtual => {
      const stat = fs.lstatSync(local(virtual));
      return virtual === MULTIVIEW_WORKS_START_FILE && Boolean(stat.mode & 0o004);
    },
  };
}
const replace = (virtual, bytes, callback) => {
  const target = local(virtual), original = fs.readFileSync(target), mode = fs.lstatSync(target).mode & 0o777;
  fs.writeFileSync(target, bytes, { mode });
  try { callback(); } finally { fs.writeFileSync(target, original, { mode }); }
};
const replaceLink = (virtual, target, callback) => {
  const file = local(virtual), original = fs.readlinkSync(file);
  fs.unlinkSync(file);
  fs.symlinkSync(target, file);
  try { callback(); } finally { fs.unlinkSync(file); fs.symlinkSync(original, file); }
};

const checks = [];
try {
  fs.mkdirSync(local('/'), { recursive: true, mode: 0o700 });
  assert.deepEqual(observeMultiviewWorksStart(contract, adapter(main.root)), {
    source: main.source, build: main.build, actualUid: appUid, verified: true,
  });
  assert.deepEqual(observeMultiviewWorksStart(contract, adapter(guard.root)), {
    source: guard.source, build: guard.build, actualUid: appUid, verified: true,
  });
  checks.push('actual_observer_main_and_guard_complete_allowlist');

  assert.equal(observeMultiviewWorksStart(contract, { ...adapter(main.root), nodeVersion: '22.11.0' }).verified, true);
  assert.throws(() => observeMultiviewWorksStart(contract, { ...adapter(main.root), nodeVersion: '18.20.0' }));
  checks.push('deployed_node20_and_node22_supported_older_runtime_rejected');

  replace(main.root + '/.deployed-commit', 'd'.repeat(40), () => {
    assert.throws(() => observeMultiviewWorksStart(contract, adapter(main.root)));
  });
  assert.throws(() => observeMultiviewWorksStart(contract, adapter(main.root, appUid + 1)));
  const unapproved = `/data/video-api-debugger/managed-releases/${'d'.repeat(40)}`;
  fs.mkdirSync(local(unapproved), { recursive: true, mode: 0o700 });
  assert.throws(() => observeMultiviewWorksStart(contract, adapter(unapproved)));
  checks.push('stale_source_uid_and_unapproved_root_rejected');

  const selectedSource = requiredSources[1];
  replace(main.root + '/' + selectedSource, 'changed source', () => {
    assert.throws(() => observeMultiviewWorksStart(contract, adapter(main.root)));
  });
  replace(main.root + '/package.json', JSON.stringify({ version: '9.9.9' }), () => {
    assert.throws(() => observeMultiviewWorksStart(contract, adapter(main.root)));
  });
  replace(main.root + '/.next-prod-candidate/BUILD_ID', 'changed-build', () => {
    assert.throws(() => observeMultiviewWorksStart(contract, adapter(main.root)));
  });
  checks.push('source_hash_version_and_build_mismatch_rejected');

  replaceLink(main.root + '/.next-prod', '.next-prod-wrong', () => {
    assert.throws(() => observeMultiviewWorksStart(contract, adapter(main.root)));
  });
  replaceLink(main.root + '/.next-prod', `../${guard.source}/.next-prod-candidate`, () => {
    assert.throws(() => observeMultiviewWorksStart(contract, adapter(main.root)));
  });
  const baseAdapter = adapter(main.root);
  let replaced = false;
  const racingAdapter = { ...baseAdapter, readlink: virtual => {
    const value = baseAdapter.readlink(virtual);
    if (!replaced && virtual === main.root + '/.next-prod') {
      replaced = true;
      fs.unlinkSync(local(virtual));
      fs.symlinkSync('.next-prod-candidate', local(virtual));
    }
    return value;
  } };
  assert.throws(() => observeMultiviewWorksStart(contract, racingAdapter));
  fs.unlinkSync(local(main.root + '/.next-prod'));
  fs.symlinkSync('.next-prod-candidate', local(main.root + '/.next-prod'));
  checks.push('fixed_build_alias_allows_real_shape_and_rejects_wrong_cross_root_or_replaced_link');

  replace(MULTIVIEW_WORKS_START_FILE, '{"schema":', () => {
    assert.throws(() => observeMultiviewWorksStart(contract, adapter(main.root)));
  });
  checks.push('fixed_root_owned_allowlist_corruption_rejected');

  assert.deepEqual(hashes(), sourceSha256);
  const receipt = {
    schema: 'multiview-works-start-engineering.v1', completed: true, synthetic: true,
    applicationDatabaseOpened: false, productionWrites: 0, forbiddenCalls: 0, paidRequests: 0, browserRuns: 0,
    checks, sourceSha256, candidateRoot,
    ...(process.env.IMAGE_RECOVERY_GATE_RUN_ID ? { runId: process.env.IMAGE_RECOVERY_GATE_RUN_ID } : {}),
  };
  fs.writeFileSync(destination, JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
  console.log('Multiview works start engineering: PASS');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
