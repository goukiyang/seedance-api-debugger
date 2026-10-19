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
const packageViewMarker = 'Pricing fixture package view: ';
const fixtureEnvironment = { NODE_ENV: 'test', HD_DERIVATIVES_ROOT: 'absent', verifiedBeforeBusinessImports: true };
const fixtureEnvironmentMarker = 'Fixture environment isolated before imports: test/no-HD-root';
const fixtureEnvironmentImport = 'data:text/javascript,' + encodeURIComponent(
  `import assert from 'node:assert/strict'; assert.equal(process.env.NODE_ENV,'test'); assert.equal(Object.hasOwn(process.env,'HD_DERIVATIVES_ROOT'),false); console.log(${JSON.stringify(fixtureEnvironmentMarker)});`);
function isolatedFixtureEnv(extra = {}) {
  const env = { ...process.env, ...extra, NODE_ENV: 'test' }; delete env.HD_DERIVATIVES_ROOT; return env;
}

function hashes() { return pricingSourceHashes(root); }
function assertConfig(candidate = root) {
  assert.equal(realpathSync(candidate), root, 'Pricing gate must use the exact candidate root');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts?.prebuild, 'node scripts/check-image-recovery.mjs', 'The existing mandatory prebuild must be retained');
  assert.equal(pkg.scripts?.build, 'next build');
  for (const file of [fixture, 'src/lib/pricing/admin-contract.ts', 'src/lib/pricing/math.ts',
    'src/lib/pricing/resolve.ts', 'src/lib/pricing/runtime.ts', 'src/lib/pricing/isolation.ts',
    'src/lib/credits/precision.ts', 'scripts/pricing-fixture-input.mjs', 'scripts/pricing-fixture-runner.ts',
    'scripts/pricing-image-ui-contract-fixture.ts', 'scripts/pricing-parent-identity-fixture.ts',
    'scripts/pricing-legacy-consumer-fixture.ts', 'scripts/pricing-legacy-v0954/provenance.ts',
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
  assert.deepEqual(value.transcripts?.map(item => item.kind), ['admin', 'ui', 'image-ui', 'video', 'legacy', 'parent', 'core', 'toolflow']);
  for (const transcript of value.transcripts) {
    assert.equal(receiptLogHash(transcript.log), transcript.sha256, 'Fixture execution log changed');
    assert.equal(readFileSync(transcript.log, 'utf8').split(/\r?\n/).filter(line => line === fixtureEnvironmentMarker).length, 1,
      'Every pricing subgroup must verify its actual environment before business imports: ' + transcript.kind);
    const packageLines = readFileSync(transcript.log, 'utf8').split(/\r?\n/).filter(line => line.startsWith(packageViewMarker));
    const ordinaryContract = ['core', 'toolflow'].includes(transcript.kind);
    assert.equal(packageLines.length, ordinaryContract ? 1 : 0, 'Package view must be explicit and limited to ordinary contract children');
    if (ordinaryContract) {
      const actualVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
      const guard = /\+trace03-guard\.\d+$/.test(actualVersion);
      const runtimePackage = path.join(root, '.role-tests', 'pricing-prepared-' + runId, 'pricing-legacy-fixture-runtime/package.json');
      const expected = { actualVersion, fixtureVersion: guard ? actualVersion.replace(/\+trace03-guard\.\d+$/, '') : actualVersion,
        kind: guard ? 'in-memory-ordinary' : 'actual', productionFilesChanged: false, actualSource: value.rootInputManifest.source,
        candidatePackage: { path: path.join(root, 'package.json'), sha256: sourceSha256['package.json'] },
        runtimePackage: { path: runtimePackage, sha256: sourceSha256['package.json'], version: actualVersion },
        admissionModulePath: path.join(root, 'src/lib/image-studio/queue-capacity.ts') };
      assert.deepEqual(transcript.packageView, expected);
      assert.deepEqual(JSON.parse(packageLines[0].slice(packageViewMarker.length)), expected);
      assert.equal(hash(readFileSync(runtimePackage)), sourceSha256['package.json'], 'Runtime source package bytes changed after the child');
    } else assert.equal(transcript.packageView, undefined);
  }
  assert.equal(value.rootInputManifest?.runId, runId);
  assert.match(value.rootInputManifest?.source, /^[a-f0-9]{40}$/);
  assert.equal(receiptLogHash(value.rootInputManifest?.path, false), value.rootInputManifest?.sha256, 'Root bootstrap receipt changed');
  assert.equal(value.legacy?.schema, 'pricing-legacy-consumer.v2'); assert.equal(value.legacy?.database?.rolledBack, true);
  assert.equal(value.parent?.fixture, 'pricing-parent-identity-contract'); assert.equal(value.parent?.completed, true);
  const identity = value.parent.processEvidence;
  assert.ok(identity?.worker?.pid > 1 && identity.worker.uid === process.getuid());
  assert.equal(identity.worker.parentPid, 1); assert.match(identity.worker.start, /^\d+$/);
  assert.equal(identity.parent?.pid, 1); assert.equal(identity.parent.uid, 0);
  assert.match(identity.parent.start, /^\d+$/); assert.equal(identity.parentSignalZero, 'EPERM');
  assert.equal(identity.capability?.source, value.rootInputManifest.source);
  assert.equal(identity.capability.instance.pid, identity.worker.pid);
  assert.equal(identity.capability.instance.start, identity.worker.start);
  assert.equal(identity.capability.instance.parentPid, 1);
  assert.deepEqual(identity.capability.parent, { pid: 1, start: identity.parent.start });
  assert.equal(identity.reader?.workerId, identity.capability.workerId);
  assert.equal(identity.reader.source, value.rootInputManifest.source);
  assert.ok(identity.controller?.pid > 1 && identity.controller.uid === identity.worker.uid);
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
  assert.deepEqual(value.fixtureEnvironment, fixtureEnvironment);
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
  const result = spawnSync(process.execPath, ['--import', fixtureEnvironmentImport, '--import', 'tsx', path.join(root, fixture)], {
    cwd: root, env: isolatedFixtureEnv({ PRICING_GATE_RUN_ID: runId, PRICING_GATE_SOURCE_MANIFEST: sourceManifest }),
    encoding: 'utf8', timeout: 600000, maxBuffer: 4 * 1024 * 1024,
  });
  writeFileSync(path.join(directory, 'fixture.log'), (result.stdout || '') + (result.stderr || ''), { mode: 0o600, flag: 'wx' });
  if (result.error || result.signal || result.status !== 0) {
    const failureReport = path.join(directory, 'failure-report.json');
    const childReport = (result.stderr || '').split(/\r?\n/).find(line => line.startsWith('Pricing policy contract failure report: '));
    writeFileSync(failureReport, JSON.stringify({ schema: 'pricing-policy-build-failure.v1', completed: false,
      runId, candidateRoot: root, startedAt, finishedAt: Date.now(), sourceSha256, fixtureEnvironment, fixtureLog: path.join(directory, 'fixture.log'),
      fixtureFailureReport: childReport?.slice('Pricing policy contract failure report: '.length) || null,
      status: result.status, signal: result.signal, error: result.error?.message || null }), { mode: 0o600, flag: 'wx' });
    console.error(`Pricing policy build failure report: ${failureReport}`);
    process.exitCode = 1;
    return;
  }
  const lines = (result.stdout || '').split(/\r?\n/).filter(line => line.startsWith(marker));
  assert.equal((result.stdout || '').split(/\r?\n/).filter(line => line === fixtureEnvironmentMarker).length, 1,
    'The actual pricing child must verify its isolated environment before importing business modules');
  assert.equal(lines.length, 1, 'A unique completed pricing fixture receipt is required');
  const fixtureReceipt = lines[0].slice(marker.length);
  const finishedAt = Date.now();
  const fixtureReceiptSha256 = verifyFixture(fixtureReceipt, runId, startedAt, finishedAt, sourceSha256);
  assert.deepEqual(hashes(), sourceSha256, 'Candidate changed during pricing verification');
  const file = path.join(directory, 'receipt.json');
  writeFileSync(file, JSON.stringify({ schema: 'pricing-policy-build-gate.v1', runId, candidateRoot: root,
    startedAt, finishedAt, sourceSha256, fixtureEnvironment, fixtureReceipt, fixtureReceiptSha256, completed: true }), { mode: 0o600, flag: 'wx' });
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
