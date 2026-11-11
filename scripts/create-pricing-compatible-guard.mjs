import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
assert.deepEqual([args[0], args[2]], ['--source', '--ref']);
assert.equal(args.length, 4, 'Usage: node scripts/create-pricing-compatible-guard.mjs --source <full-main-40-sha> --ref refs/heads/codex/points-pricing-settings-guard');
const source = args[1], ref = args[3];
assert.match(source, /^[a-f0-9]{40}$/);
assert.match(ref, /^refs\/heads\/codex\/points-pricing-settings-guard(?:-[a-z0-9-]+)?$/);
const git = (values, options = {}) => execFileSync('git', values, { encoding: 'utf8', ...options }).trim();
assert.equal(git(['rev-parse', `${source}^{commit}`]), source);
const read = file => git(['show', `${source}:${file}`]);
const modePath = 'src/lib/pricing/build-mode.ts';
assert.equal(read(modePath), 'export const PRICING_ADMIN_WRITES_ENABLED: boolean = true;', 'Guard must be generated from the full main source');
const pkg = JSON.parse(read('package.json')), lock = JSON.parse(read('package-lock.json'));
assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
assert.equal(lock.version, pkg.version); assert.equal(lock.packages[''].version, pkg.version);
const version = `${pkg.version}+points-pricing-guard.1`;
pkg.version = version; lock.version = version; lock.packages[''].version = version;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-guard-index-'));
try {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(directory, 'index') };
  git(['read-tree', source], { env });
  const changes = { [modePath]: 'export const PRICING_ADMIN_WRITES_ENABLED: boolean = false;\n',
    'package.json': `${JSON.stringify(pkg, null, 2)}\n`, 'package-lock.json': `${JSON.stringify(lock, null, 2)}\n` };
  // Preserve the existing recovery restrictions as well as the new pricing reader.
  for (const [file, names] of [
    ['src/lib/character-lab/service.ts', ['CHARACTER_LAB_BODY_PAIRS_ENABLED', 'CHARACTER_LAB_RECIPE_WRITES_ENABLED', 'CHARACTER_LAB_GRID_WRITES_ENABLED']],
    ['src/lib/cutout/access.ts', ['CUTOUT_MEMBERS_ENABLED']],
    ['src/lib/assets/upload-purpose.ts', ['FEEDBACK_UPLOADS_ENABLED']],
  ]) {
    let bytes = read(file);
    for (const name of names) {
      const before = `export const ${name} = true;`;
      assert.ok(bytes.includes(before), `Expected current main recovery flag: ${name}`);
      bytes = bytes.replace(before, `export const ${name} = false;`);
    }
    changes[file] = bytes + '\n';
  }
  const characterModePath = 'src/lib/character-assets/build-mode.ts';
  if (git(['ls-tree', '--name-only', source, '--', characterModePath]) === characterModePath) {
    const bytes = read(characterModePath);
    const before = 'export const CHARACTER_ASSET_WRITES_ENABLED: boolean = true;';
    assert.ok(bytes.includes(before),
      'Character asset recovery source must be the full writable main');
    changes[characterModePath] = bytes.replace(before, 'export const CHARACTER_ASSET_WRITES_ENABLED: boolean = false;') + '\n';
  }
  const groupModePath = 'src/lib/video/prompt-groups-build-mode.ts';
  if (git(['ls-tree', '--name-only', source, '--', groupModePath]) === groupModePath) {
    const bytes = read(groupModePath);
    const before = 'export const VIDEO_PROMPT_GROUP_WRITES_ENABLED = true;';
    assert.ok(bytes.includes(before), 'Prompt group recovery source must be the full writable main');
    changes[groupModePath] = bytes.replace(before, 'export const VIDEO_PROMPT_GROUP_WRITES_ENABLED = false;') + '\n';
  }
  for (const [file, bytes] of Object.entries(changes)) {
    const blob = git(['hash-object', '-w', '--stdin'], { input: bytes });
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], { env });
  }
  const tree = git(['write-tree'], { env });
  const actualChanges = git(['diff', '--name-only', source, tree]).split('\n').filter(Boolean).sort();
  assert.deepEqual(actualChanges, Object.keys(changes).sort(), 'Guard may change only mode and version metadata');
  const guard = git(['commit-tree', tree, '-p', source], { input: `chore: prepare schema-compatible pricing read-only guard\n\nMain source: ${source}\nPreserves all pricing readers, execution and frozen contracts. No data or policy rollback.\n` });
  git(['update-ref', ref, guard, '0'.repeat(40)]);
  console.log(JSON.stringify({ schema: 'pricing-compatible-guard-source.v1', source: guard, mainSource: source,
    ref, version, tree, changedFiles: actualChanges, verified: false, pushed: false }));
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
