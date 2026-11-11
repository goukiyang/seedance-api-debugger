import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-guard-engineering-'));
const flags = {
  'src/lib/pricing/build-mode.ts': ['PRICING_ADMIN_WRITES_ENABLED'],
  'src/lib/character-lab/service.ts': ['CHARACTER_LAB_BODY_PAIRS_ENABLED', 'CHARACTER_LAB_RECIPE_WRITES_ENABLED', 'CHARACTER_LAB_GRID_WRITES_ENABLED'],
  'src/lib/cutout/access.ts': ['CUTOUT_MEMBERS_ENABLED'],
  'src/lib/assets/upload-purpose.ts': ['FEEDBACK_UPLOADS_ENABLED'],
  'src/lib/character-assets/build-mode.ts': ['CHARACTER_ASSET_WRITES_ENABLED'],
};
const reader = 'src/lib/pricing/model-availability-contract.ts';
const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
const commit = () => {
  git(['add', '.']);
  git(['-c', 'user.name=Engineering', '-c', 'user.email=engineering@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'isolated main']);
  return git(['rev-parse', 'HEAD']);
};
try {
  git(['init', '-q']);
  for (const file of ['package.json', 'package-lock.json', reader, ...Object.keys(flags)]) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
  const source = commit(), ref = 'refs/heads/codex/points-pricing-settings-guard-engineering';
  const result = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/create-pricing-compatible-guard.mjs'), '--source', source, '--ref', ref], { cwd: directory, encoding: 'utf8' }));
  for (const [file, names] of Object.entries(flags)) {
    const bytes = git(['show', `${result.source}:${file}`]);
    for (const name of names) assert.match(bytes, new RegExp(`export const ${name}(?:\\s*:\\s*boolean)? = false;`), `${name} must be paused in recovery`);
  }
  assert.deepEqual(git(['diff', '--name-only', source, result.source]).split('\n').sort(), ['package.json', 'package-lock.json', ...Object.keys(flags)].sort());
  assert.equal(git(['show', `${source}:${reader}`]), git(['show', `${result.source}:${reader}`]), 'New model-access reader remains byte-identical');
  assert.equal(fs.readFileSync(path.join(directory, 'src/lib/assets/upload-purpose.ts'), 'utf8').includes('FEEDBACK_UPLOADS_ENABLED = true;'), true, 'Main working files remain open');
  const characterMode = 'src/lib/character-assets/build-mode.ts';
  const characterPath = path.join(directory, characterMode);
  const writableCharacterMode = fs.readFileSync(characterPath, 'utf8');
  fs.writeFileSync(characterPath, writableCharacterMode.replace('= true;', '= false;'));
  const closedCharacterSource = commit(), closedCharacterRef = ref + '-character-rejected';
  assert.notEqual(spawnSync(process.execPath, [path.join(root, 'scripts/create-pricing-compatible-guard.mjs'), '--source', closedCharacterSource, '--ref', closedCharacterRef], { cwd: directory, encoding: 'utf8' }).status, 0,
    'A character-write-disabled recovery cannot masquerade as full main');
  assert.notEqual(spawnSync('git', ['show-ref', '--verify', closedCharacterRef], { cwd: directory }).status, 0);
  git(['rm', characterMode]);
  const legacySource = commit(), legacyRef = ref + '-legacy';
  const legacy = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/create-pricing-compatible-guard.mjs'), '--source', legacySource, '--ref', legacyRef], { cwd: directory, encoding: 'utf8' }));
  assert.deepEqual(git(['diff', '--name-only', legacySource, legacy.source]).split('\n').sort(),
    ['package.json', 'package-lock.json', ...Object.keys(flags).filter(file => file !== characterMode)].sort(),
    'Historical source without character assets retains exactly the original six write switches');
  const file = path.join(directory, 'src/lib/assets/upload-purpose.ts');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('FEEDBACK_UPLOADS_ENABLED = true;', 'FEEDBACK_UPLOADS_ENABLED = false;'));
  const invalid = commit(), rejectedRef = ref + '-rejected';
  const rejected = spawnSync(process.execPath, [path.join(root, 'scripts/create-pricing-compatible-guard.mjs'), '--source', invalid, '--ref', rejectedRef], { cwd: directory, encoding: 'utf8' });
  assert.notEqual(rejected.status, 0, 'A recovery-mode source cannot masquerade as full main');
  assert.notEqual(spawnSync('git', ['show-ref', '--verify', rejectedRef], { cwd: directory }).status, 0);
  console.log(JSON.stringify({ passed: true, closedFlags: 7, checks: 4, legacyClosedFlags: 6, modelCalls: 0, productionWrites: 0 }));
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
