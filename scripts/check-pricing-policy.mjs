import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pricingSourceHashes } from './pricing-source.mjs';
import { readPricingFixtureInputs } from './pricing-fixture-input.mjs';

const root = realpathSync(process.cwd());
const fixture = 'scripts/pricing-policy-contract-fixture.ts';
const marker = 'Pricing policy contract fixture receipt: ';
const checks = Array.from({ length: 24 }, (_, index) => `G${String(index + 1).padStart(2, '0')}`);
const hash = value => createHash('sha256').update(value).digest('hex');

function hashes() { return pricingSourceHashes(root); }
function assertConfig(candidate = root) {
  assert.equal(realpathSync(candidate), root, 'Pricing gate must use the exact candidate root');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts?.prebuild, 'node scripts/check-image-recovery.mjs', 'The existing mandatory prebuild must be retained');
  assert.equal(pkg.scripts?.build, 'next build');
  for (const file of [fixture, 'src/lib/pricing/admin-contract.ts', 'src/lib/pricing/math.ts',
    'src/lib/pricing/resolve.ts', 'src/lib/pricing/runtime.ts', 'src/lib/pricing/isolation.ts',
    'src/lib/credits/precision.ts', 'scripts/pricing-fixture-input.mjs', 'scripts/pricing-fixture-runner.ts',
    'scripts/pricing-image-ui-contract-fixture.ts', 'scripts/pricing-legacy-consumer-fixture.ts', 'scripts/pricing-legacy-v0954/provenance.ts',
    'scripts/pricing-legacy-v0954/bootstrap-root.sh']) assert.ok(readFileSync(path.join(root, file)).length > 0, file);
  const sources = hashes();
  assert.equal(Object.keys(sources).filter(file => file.startsWith('scripts/pricing-legacy-v0954/') && file.endsWith('.source')).length, 100);
  assert.match(sources['scripts/pricing-legacy-v0954/bootstrap-root.sh'], /^[a-f0-9]{64}$/);
}
function receipt(file) {
  assert.equal(typeof file, 'string');
  const absolute = path.resolve(file), scratch = path.join(root, '.role-tests');
  assert.ok(absolute.startsWith(scratch + path.sep), 'Receipt must be inside the candidate private fixture directory');
  assert.equal(realpathSync(absolute), absolute, 'Receipt symlinks are forbidden');
  const stat = lstatSync(absolute);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= 8 * 1024 * 1024);
  assert.equal(stat.mode & 0o077, 0, 'Receipt must be private');
  if (typeof process.getuid === 'function') assert.equal(stat.uid, process.getuid());
  const bytes = readFileSync(absolute);
  return { value: JSON.parse(bytes.toString('utf8')), sha256: hash(bytes) };
}
function verifyFixture(file, runId, startedAt, finishedAt, sourceSha256) {
  const result = receipt(file), value = result.value;
  assert.equal(value.schema, 'pricing-policy-contract-fixture.v1');
  assert.equal(value.runId, runId);
  assert.equal(value.synthetic, true);
  assert.equal(value.completed, true);
  assert.equal(value.candidateRoot, root);
  assert.ok(value.startedAt >= startedAt && value.finishedAt >= value.startedAt && value.finishedAt <= finishedAt + 1000);
  assert.deepEqual(value.checks?.map(check => check.id), checks, 'Every G01-G24 contract must actually complete');
  for (const check of value.checks) {
    assert.equal(check.completed, true, check.id);
    assert.ok(Number.isSafeInteger(check.assertions) && check.assertions > 0, `${check.id} has no assertions`);
    assert.ok(Array.isArray(check.evidence) && check.evidence.length > 0, `${check.id} has no execution evidence`);
  }
  for (const key of ['forbiddenCalls', 'productionWrites', 'paidRequests', 'browserRuns']) assert.equal(value[key], 0, key);
  assert.equal(value.fixtureSha256, sourceSha256[fixture]);
  assert.deepEqual(value.sourceSha256, sourceSha256, 'Fixture source coverage differs from this candidate');
  assert.deepEqual(value.transcripts?.map(item => item.kind), ['admin', 'ui', 'image-ui', 'video', 'legacy', 'core', 'toolflow']);
  for (const transcript of value.transcripts) assert.equal(receiptLogHash(transcript.log), transcript.sha256, 'Fixture execution log changed');
  assert.equal(value.rootInputManifest?.runId, runId);
  assert.match(value.rootInputManifest?.source, /^[a-f0-9]{40}$/);
  assert.equal(receiptLogHash(value.rootInputManifest?.path, false), value.rootInputManifest?.sha256, 'Root bootstrap receipt changed');
  assert.equal(value.legacy?.schema, 'pricing-legacy-consumer.v2'); assert.equal(value.legacy?.database?.rolledBack, true);
  return result.sha256;
}
function receiptLogHash(file, privateFile = true) {
  assert.equal(typeof file, 'string');
  assert.ok(path.isAbsolute(file) && file.startsWith(path.join(root, '.role-tests') + path.sep));
  assert.equal(realpathSync(file), file);
  const stat = lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 8 * 1024 * 1024);
  if (privateFile) assert.equal(stat.mode & 0o077, 0);
  else assert.ok(stat.uid === 0 && !(stat.mode & 0o222));
  return hash(readFileSync(file));
}
function verify(file, since) {
  assertConfig();
  assert.ok(Number.isFinite(since) && since > 0, 'A real build start timestamp is required');
  const { value } = receipt(file);
  assert.equal(value.schema, 'pricing-policy-build-gate.v1');
  assert.match(value.runId, /^[a-f0-9-]{36}$/);
  assert.equal(value.completed, true);
  assert.equal(value.candidateRoot, root);
  assert.ok(value.startedAt >= since && value.finishedAt >= value.startedAt && value.finishedAt <= Date.now() + 1000);
  assert.ok(Date.now() - value.startedAt <= 30 * 60_000, 'Pricing gate receipt is stale');
  assert.deepEqual(value.sourceSha256, hashes(), 'Source changed after pricing contracts ran');
  assert.equal(verifyFixture(value.fixtureReceipt, value.runId, value.startedAt, value.finishedAt, value.sourceSha256), value.fixtureReceiptSha256);
  console.log('Pricing policy build gate verified');
}
function run() {
  assertConfig();
  const inputs = readPricingFixtureInputs(root);
  const startedAt = Date.now(), runId = inputs.runId, sourceSha256 = hashes();
  const scratch = path.join(root, '.role-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'pricing-policy-gate-'));
  const sourceManifest = path.join(directory, 'source-manifest.json');
  writeFileSync(sourceManifest, JSON.stringify(sourceSha256), { mode: 0o600, flag: 'wx' });
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, fixture)], {
    cwd: root, env: { ...process.env, PRICING_GATE_RUN_ID: runId, PRICING_GATE_SOURCE_MANIFEST: sourceManifest },
    encoding: 'utf8', timeout: 600000, maxBuffer: 4 * 1024 * 1024,
  });
  writeFileSync(path.join(directory, 'fixture.log'), (result.stdout || '') + (result.stderr || ''), { mode: 0o600, flag: 'wx' });
  if (result.error || result.signal || result.status !== 0) {
    const failureReport = path.join(directory, 'failure-report.json');
    const childReport = (result.stderr || '').split(/\r?\n/).find(line => line.startsWith('Pricing policy contract failure report: '));
    writeFileSync(failureReport, JSON.stringify({ schema: 'pricing-policy-build-failure.v1', completed: false,
      runId, candidateRoot: root, startedAt, finishedAt: Date.now(), sourceSha256, fixtureLog: path.join(directory, 'fixture.log'),
      fixtureFailureReport: childReport?.slice('Pricing policy contract failure report: '.length) || null,
      status: result.status, signal: result.signal, error: result.error?.message || null }), { mode: 0o600, flag: 'wx' });
    console.error(`Pricing policy build failure report: ${failureReport}`);
    process.exitCode = 1;
    return;
  }
  const lines = (result.stdout || '').split(/\r?\n/).filter(line => line.startsWith(marker));
  assert.equal(lines.length, 1, 'A unique completed pricing fixture receipt is required');
  const fixtureReceipt = lines[0].slice(marker.length);
  const finishedAt = Date.now();
  const fixtureReceiptSha256 = verifyFixture(fixtureReceipt, runId, startedAt, finishedAt, sourceSha256);
  assert.deepEqual(hashes(), sourceSha256, 'Candidate changed during pricing verification');
  const file = path.join(directory, 'receipt.json');
  writeFileSync(file, JSON.stringify({ schema: 'pricing-policy-build-gate.v1', runId, candidateRoot: root,
    startedAt, finishedAt, sourceSha256, fixtureReceipt, fixtureReceiptSha256, completed: true }), { mode: 0o600, flag: 'wx' });
  verify(file, startedAt);
  console.log(`PRICING_POLICY_GATE_RECEIPT=${file}`);
}
try {
  if (process.argv[2] === '--assert-config' && process.argv.length <= 4) assertConfig(process.argv[3]);
  else if (process.argv[2] === '--verify' && process.argv[4] === '--since' && process.argv.length === 6) verify(process.argv[3], Number(process.argv[5]));
  else { assert.equal(process.argv.length, 2, 'Unknown pricing gate arguments'); run(); }
} catch (error) {
  console.error('Pricing policy build gate rejected:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
