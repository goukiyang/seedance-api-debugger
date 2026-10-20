// Mandatory offline upload checks, sharing the existing candidate run and
// private receipt contract. This never accepts production credentials or files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readPricingFixtureInputs } from './pricing-fixture-input.mjs';

const root = fs.realpathSync(process.cwd());
const startedAt = Date.now(), runId = readPricingFixtureInputs(root).runId;
const sources = [
  'scripts/upload-recovery-engineering.mjs', 'scripts/upload-private-directory-engineering.ts',
  'scripts/upload-client-recovery-engineering.ts', 'scripts/upload-raw-recovery-engineering.mjs',
  'scripts/upload-root-cure-smoke.ts', 'src/lib/assets/verified-upload.ts', 'src/lib/assets/raw-upload-state.ts',
  'src/lib/assets/upload-log.ts', 'src/lib/assets/storage.ts', 'src/lib/assets/site-upload.ts',
  'src/lib/http/file-upload.ts', 'src/lib/http/upload-session.ts', 'src/components/ResourceLibraryPicker.tsx',
  'src/components/ResourceLibraryPicker.module.css', 'src/app/api/assets/upload/route.ts',
  'src/app/api/assets/upload-complete/route.ts', 'src/app/api/assets/multipart/complete/route.ts',
  'src/lib/assets/raw-upload-recovery-proof.ts', 'src/app/api/assets/upload/recover/route.ts',
];
const hash = value => createHash('sha256').update(value).digest('hex');
const hashes = () => Object.fromEntries(sources.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
const sourceSha256 = hashes();
const scratch = path.join(root, '.role-tests');
fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
const folder = fs.mkdtempSync(path.join(scratch, 'upload-recovery-'));
const cases = [
  ['private_directory_secure_alias', 'scripts/upload-private-directory-engineering.ts', 'UPLOAD_DIRECTORY_ENGINEERING='],
  ['raw_nonce_preflight_history', 'scripts/upload-raw-recovery-engineering.mjs', 'UPLOAD_RAW_ENGINEERING='],
  ['client_per_file_recovery', 'scripts/upload-client-recovery-engineering.ts', 'UPLOAD_CLIENT_ENGINEERING='],
  ['upload_entry_contracts_preserved', 'scripts/upload-root-cure-smoke.ts', null],
];
const childEnv = { ...process.env, NODE_ENV: 'test' };
// A production HD directory must never reach synthetic filesystem fixtures.
delete childEnv.HD_DERIVATIVES_ROOT;
const outcomes = [];
for (const [name, file, marker] of cases) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, file)], {
    cwd: root, env: childEnv, encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024,
  });
  const log = path.join(folder, path.basename(file) + '.log');
  fs.writeFileSync(log, (result.stdout || '') + (result.stderr || ''), { flag: 'wx', mode: 0o600 });
  let details = null, failure = null;
  try {
    assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, name + ': ' + log);
    if (marker) {
      const lines = result.stdout.split(/\r?\n/).filter(line => line.startsWith(marker));
      assert.equal(lines.length, 1, 'Exactly one completed child result is required');
      details = JSON.parse(lines[0].slice(marker.length));
      assert.equal(details.completed, true); assert.ok(details.checks?.length > 0);
      assert.equal(new Set(details.checks).size, details.checks.length);
      assert.ok(details.forbiddenCalls && Object.keys(details.forbiddenCalls).length > 0);
      for (const count of Object.values(details.forbiddenCalls)) assert.equal(count, 0);
    }
  } catch (error) { failure = error.message; }
  outcomes.push({ name, file, log, logSha256: hash(fs.readFileSync(log)), exitCode: result.status,
    completed: failure === null, details, failure });
}
assert.deepEqual(hashes(), sourceSha256, 'Upload source changed during the unified gate');
if (outcomes.some(item => !item.completed)) {
  const failure = path.join(folder, 'failure.json');
  fs.writeFileSync(failure, JSON.stringify({ completed: false, runId, candidateRoot: root,
    startedAt, finishedAt: Date.now(), sourceSha256, outcomes }, null, 2), { flag: 'wx', mode: 0o600 });
  throw Error('Upload recovery engineering failed: ' + failure);
}
const receipt = path.join(folder, 'receipt.json');
fs.writeFileSync(receipt, JSON.stringify({ schema: 'upload-recovery-engineering.v1', runId,
  candidateRoot: root, startedAt, finishedAt: Date.now(), sourceSha256, completed: true,
  fixtureSha256: sourceSha256['scripts/upload-recovery-engineering.mjs'], synthetic: true,
  checks: cases.map(item => item[0]), outcomes, forbiddenCalls: 0, productionWrites: 0, paidRequests: 0, browserRuns: 0,
}, null, 2), { flag: 'wx', mode: 0o600 });
console.log('Upload recovery engineering receipt: ' + receipt);
