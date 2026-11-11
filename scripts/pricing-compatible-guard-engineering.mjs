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
  'src/lib/video/prompt-groups-build-mode.ts': ['VIDEO_PROMPT_GROUP_WRITES_ENABLED'],
  'src/lib/character-fusion/build-mode.ts': ['CHARACTER_FUSION_WRITES_ENABLED'],
};
const reader = 'src/lib/pricing/model-availability-contract.ts';
const fusionReader = 'src/lib/character-fusion/catalogue-model.ts';
const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
const commit = () => {
  git(['add', '.']);
  git(['-c', 'user.name=Engineering', '-c', 'user.email=engineering@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'isolated main']);
  return git(['rev-parse', 'HEAD']);
};
try {
  git(['init', '-q']);
  const mainFiles = ['package.json', 'package-lock.json', reader, fusionReader, ...Object.keys(flags)];
  for (const file of mainFiles) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
  const mainBytes = new Map(mainFiles.map(file => [file, fs.readFileSync(path.join(directory, file), 'utf8')]));
  const source = commit(), ref = 'refs/heads/codex/points-pricing-settings-guard-engineering';
  const result = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/create-pricing-compatible-guard.mjs'), '--source', source, '--ref', ref], { cwd: directory, encoding: 'utf8' }));
  for (const [file, names] of Object.entries(flags)) {
    const bytes = git(['show', `${result.source}:${file}`]);
    for (const name of names) assert.match(bytes, new RegExp(`export const ${name}(?:\\s*:\\s*boolean)? = false;`), `${name} must be paused in recovery`);
  }
  assert.deepEqual(git(['diff', '--name-only', source, result.source]).split('\n').sort(), ['package.json', 'package-lock.json', ...Object.keys(flags)].sort());
  assert.equal(git(['show', `${source}:${reader}`]), git(['show', `${result.source}:${reader}`]), 'New model-access reader remains byte-identical');
  assert.equal(git(['show', `${source}:${fusionReader}`]), git(['show', `${result.source}:${fusionReader}`]), 'Fusion catalogue reader remains byte-identical');
  for (const [file, bytes] of mainBytes) assert.equal(fs.readFileSync(path.join(directory, file), 'utf8'), bytes, `${file} in main remains byte-identical`);
  assert.equal(git(['rev-parse', 'HEAD']), source, 'Main ref remains unchanged');
  assert.equal(git(['status', '--porcelain']), '', 'Main index and working tree remain unchanged');
  const fusionMode = 'src/lib/character-fusion/build-mode.ts';
  const fusionPath = path.join(directory, fusionMode);
  const writableFusionMode = fs.readFileSync(fusionPath, 'utf8');
  fs.writeFileSync(fusionPath, writableFusionMode.replace('CHARACTER_FUSION_WRITES_ENABLED: boolean = true;', 'CHARACTER_FUSION_WRITES_ENABLED: boolean = false;'));
  const closedFusionSource = commit(), closedFusionRef = ref + '-fusion-rejected';
  const closedFusion = spawnSync(process.execPath, [path.join(root, 'scripts/create-pricing-compatible-guard.mjs'), '--source', closedFusionSource, '--ref', closedFusionRef], { cwd: directory, encoding: 'utf8' });
  assert.notEqual(closedFusion.status, 0, 'A fusion-write-disabled source cannot masquerade as full main');
  assert.match(closedFusion.stderr, /Character fusion recovery source must be the full writable main/);
  assert.notEqual(spawnSync('git', ['show-ref', '--verify', closedFusionRef], { cwd: directory }).status, 0);
  fs.writeFileSync(fusionPath, writableFusionMode);
  const groupMode = 'src/lib/video/prompt-groups-build-mode.ts';
  const groupPath = path.join(directory, groupMode);
  const writableGroupMode = fs.readFileSync(groupPath, 'utf8');
  fs.writeFileSync(groupPath, writableGroupMode.replace('= true;', '= false;'));
  const closedGroupSource = commit(), closedGroupRef = ref + '-groups-rejected';
  assert.notEqual(spawnSync(process.execPath, [path.join(root, 'scripts/create-pricing-compatible-guard.mjs'), '--source', closedGroupSource, '--ref', closedGroupRef], { cwd: directory, encoding: 'utf8' }).status, 0,
    'A prompt-group-read-only source cannot masquerade as full main');
  assert.notEqual(spawnSync('git', ['show-ref', '--verify', closedGroupRef], { cwd: directory }).status, 0);
  fs.writeFileSync(groupPath, writableGroupMode);
  const characterMode = 'src/lib/character-assets/build-mode.ts';
  const characterPath = path.join(directory, characterMode);
  const writableCharacterMode = fs.readFileSync(characterPath, 'utf8');
  fs.writeFileSync(characterPath, writableCharacterMode.replace('= true;', '= false;'));
  const closedCharacterSource = commit(), closedCharacterRef = ref + '-character-rejected';
  assert.notEqual(spawnSync(process.execPath, [path.join(root, 'scripts/create-pricing-compatible-guard.mjs'), '--source', closedCharacterSource, '--ref', closedCharacterRef], { cwd: directory, encoding: 'utf8' }).status, 0,
    'A character-write-disabled recovery cannot masquerade as full main');
  assert.notEqual(spawnSync('git', ['show-ref', '--verify', closedCharacterRef], { cwd: directory }).status, 0);
  fs.writeFileSync(characterPath, writableCharacterMode);
  git(['rm', fusionMode]);
  const noFusionSource = commit(), noFusionRef = ref + '-no-fusion';
  const noFusion = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/create-pricing-compatible-guard.mjs'), '--source', noFusionSource, '--ref', noFusionRef], { cwd: directory, encoding: 'utf8' }));
  assert.deepEqual(git(['diff', '--name-only', noFusionSource, noFusion.source]).split('\n').sort(),
    ['package.json', 'package-lock.json', ...Object.keys(flags).filter(file => file !== fusionMode)].sort(),
    'Historical source without fusion closes the existing eight write switches');
  for (const [file, names] of Object.entries(flags).filter(([file]) => file !== fusionMode)) {
    const bytes = git(['show', `${noFusion.source}:${file}`]);
    for (const name of names) assert.match(bytes, new RegExp(`export const ${name}(?:\\s*:\\s*boolean)? = false;`), `${name} remains paused without fusion`);
  }
  assert.equal(git(['ls-tree', '--name-only', noFusion.source, '--', fusionMode]), '', 'Historical guard does not invent a fusion mode file');
  git(['rm', characterMode]);
  const legacySource = commit(), legacyRef = ref + '-legacy';
  const legacy = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/create-pricing-compatible-guard.mjs'), '--source', legacySource, '--ref', legacyRef], { cwd: directory, encoding: 'utf8' }));
  assert.deepEqual(git(['diff', '--name-only', legacySource, legacy.source]).split('\n').sort(),
    ['package.json', 'package-lock.json', ...Object.keys(flags).filter(file => ![characterMode, fusionMode].includes(file))].sort(),
    'Historical source with prompt groups but no character assets closes seven write switches');
  git(['rm', groupMode]);
  const oldSource = commit(), oldRef = ref + '-old';
  const old = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/create-pricing-compatible-guard.mjs'), '--source', oldSource, '--ref', oldRef], { cwd: directory, encoding: 'utf8' }));
  assert.deepEqual(git(['diff', '--name-only', oldSource, old.source]).split('\n').sort(),
    ['package.json', 'package-lock.json', ...Object.keys(flags).filter(file => ![characterMode, groupMode, fusionMode].includes(file))].sort(),
    'Historical source without either optional feature retains the original six write switches');
  const file = path.join(directory, 'src/lib/assets/upload-purpose.ts');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('FEEDBACK_UPLOADS_ENABLED = true;', 'FEEDBACK_UPLOADS_ENABLED = false;'));
  const invalid = commit(), rejectedRef = ref + '-rejected';
  const rejected = spawnSync(process.execPath, [path.join(root, 'scripts/create-pricing-compatible-guard.mjs'), '--source', invalid, '--ref', rejectedRef], { cwd: directory, encoding: 'utf8' });
  assert.notEqual(rejected.status, 0, 'A recovery-mode source cannot masquerade as full main');
  assert.notEqual(spawnSync('git', ['show-ref', '--verify', rejectedRef], { cwd: directory }).status, 0);
  console.log(JSON.stringify({ passed: true, closedFlags: 9, checks: 9, historicalNoFusionClosedFlags: 8, legacyClosedFlags: 6, modelCalls: 0, productionWrites: 0 }));
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
