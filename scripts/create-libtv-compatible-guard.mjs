import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
assert.deepEqual([args[0], args[2]], ['--source', '--ref']);
assert.equal(args.length, 4);
const source = args[1], ref = args[3];
assert.match(source, /^[a-f0-9]{40}$/);
assert.match(ref, /^refs\/heads\/codex\/libtv-compatible-guard-[a-z0-9-]+$/);
const git = (values, options = {}) => execFileSync('git', values, { encoding: 'utf8', ...options }).trim();
assert.equal(git(['rev-parse', `${source}^{commit}`]), source);
const read = file => git(['show', `${source}:${file}`]);
const pricing = 'src/lib/pricing/build-mode.ts', batch = 'src/lib/canvas-video-batches-build-mode.ts';
assert.equal(read(pricing), 'export const PRICING_ADMIN_WRITES_ENABLED: boolean = true;');
assert.equal(read(batch), 'export const CANVAS_VIDEO_BATCH_WRITES_ENABLED: boolean = true;');
const pkg = JSON.parse(read('package.json')), lock = JSON.parse(read('package-lock.json'));
assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
assert.equal(lock.version, pkg.version); assert.equal(lock.packages[''].version, pkg.version);
const version = `${pkg.version}+libtv-guard.1`;
pkg.version = version; lock.version = version; lock.packages[''].version = version;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'libtv-guard-index-'));
try {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(directory, 'index') };
  git(['read-tree', source], { env });
  const changes = {
    [pricing]: 'export const PRICING_ADMIN_WRITES_ENABLED: boolean = false;\n',
    [batch]: 'export const CANVAS_VIDEO_BATCH_WRITES_ENABLED: boolean = false;\n',
    'package.json': `${JSON.stringify(pkg, null, 2)}\n`, 'package-lock.json': `${JSON.stringify(lock, null, 2)}\n`,
  };
  for (const [file, bytes] of Object.entries(changes)) {
    const blob = git(['hash-object', '-w', '--stdin'], { input: bytes });
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], { env });
  }
  const tree = git(['write-tree'], { env });
  const changedFiles = git(['diff', '--name-only', source, tree]).split('\n').filter(Boolean).sort();
  assert.deepEqual(changedFiles, Object.keys(changes).sort());
  const guard = git(['commit-tree', tree, '-p', source], { input:
    `chore: prepare LibTV schema-compatible guard\n\nMain source: ${source}\nDisable new batch admissions and pricing writes; retain original readers, receipts, document gates and fee contracts. No data rollback.\n` });
  git(['update-ref', ref, guard, '0'.repeat(40)]);
  console.log(JSON.stringify({ schema: 'libtv-compatible-guard-source.v1', source: guard, mainSource: source,
    ref, version, tree, changedFiles, verified: false, pushed: false }));
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
