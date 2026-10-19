import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readPricingFixtureInputs } from './pricing-fixture-input.mjs';
import { MULTIVIEW_SETTINGS_FIXTURE_SOURCES } from './multiview-settings-fixture-inputs.mjs';

const root = fs.realpathSync(process.cwd());
const startedAt = Date.now(), runId = readPricingFixtureInputs(root).runId;
const hash = value => createHash('sha256').update(value).digest('hex');
const hashes = () => Object.fromEntries(MULTIVIEW_SETTINGS_FIXTURE_SOURCES.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
const sourceSha256 = hashes();
const scratch = path.join(root, '.role-tests');
fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
const folder = fs.mkdtempSync(path.join(scratch, 'multiview-settings-batch-'));
const cases = [
  ['saved_settings_permissions_snapshots_and_timing', 'scripts/multiview-settings-engineering.ts', 'settings'],
  ['frame_settings_keep_media_and_layout_private', 'scripts/multiview-frame-settings-client-engineering.ts', 'frames'],
  ['preview_atlas_loop_exact_output_contract', 'scripts/multiview-preview-engineering.ts', 'preview'],
  ['same_work_identity_baseline_and_explicit_original_save', 'scripts/multiview-work-identity-engineering.ts', 'identity'],
];
const childEnv = { ...process.env, NODE_ENV: 'test', TMPDIR: folder };
// Production storage overrides must not reach a synthetic directory/decoder fixture.
delete childEnv.HD_DERIVATIVES_ROOT;
const outcomes = [];
for (const [name, file, kind] of cases) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, file)], {
    cwd: root, env: childEnv, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024,
  });
  const log = path.join(folder, path.basename(file) + '.log');
  fs.writeFileSync(log, (result.stdout || '') + (result.stderr || ''), { flag: 'wx', mode: 0o600 });
  let details = null, failure = null;
  try {
    assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, name + ': ' + log);
    const lines = (result.stdout || '').split(/\r?\n/);
    if (kind === 'preview') {
      assert.equal(lines.filter(line => line === 'multiview preview engineering checks passed').length, 1);
    } else {
      const matches = lines.filter(line => line.startsWith(kind === 'frames' ? '{"schema":"multiview-frame-settings-client-engineering.v1"' : '{"completed":'));
      assert.equal(matches.length, 1, 'One actual completed child result is required');
      details = JSON.parse(matches[0]); assert.equal(details.completed, true);
      assert.ok(Array.isArray(details.checks) && details.checks.length > 0 && new Set(details.checks).size === details.checks.length);
      if (kind === 'settings' || kind === 'identity') {
        assert.equal(fs.realpathSync(details.evidencePath), details.evidencePath);
        assert.ok(details.evidencePath.startsWith(scratch + path.sep));
        const stat = fs.lstatSync(details.evidencePath);
        assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o077) === 0);
        const bytes = fs.readFileSync(details.evidencePath), original = JSON.parse(bytes);
        if (kind === 'identity') assert.equal(original.kind, 'isolated-multiview-work-identity-engineering');
        assert.equal(original.completed, true); assert.deepEqual(original.checks, details.checks);
        assert.equal(original.production, false); assert.equal(original.generatedVideo, 0); assert.equal(original.upstreamRequests, 0);
        details = { ...details, evidenceSha256: hash(bytes) };
      } else {
        for (const key of ['productionWrites', 'generationCalls', 'billingChanges']) assert.equal(details[key], 0);
      }
    }
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  outcomes.push({ name, file, log, logSha256: hash(fs.readFileSync(log)), exitCode: result.status, completed: failure === null, details, failure });
}
assert.deepEqual(hashes(), sourceSha256, 'Multiview sources changed during unified engineering checks');
const value = { schema: 'multiview-settings-batch-engineering.v1', runId, candidateRoot: root, startedAt,
  finishedAt: Date.now(), sourceSha256, fixtureSha256: sourceSha256['scripts/multiview-settings-batch-engineering.mjs'],
  completed: outcomes.every(item => item.completed), synthetic: true, checks: cases.map(item => item[0]), outcomes,
  forbiddenCalls: 0, productionWrites: 0, paidRequests: 0, browserRuns: 0 };
const receipt = path.join(folder, value.completed ? 'receipt.json' : 'failure.json');
fs.writeFileSync(receipt, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
assert.equal(value.completed, true, 'Multiview settings engineering failed: ' + receipt);
console.log('Multiview settings engineering receipt: ' + receipt);

