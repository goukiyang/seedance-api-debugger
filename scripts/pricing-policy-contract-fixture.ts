import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readPricingFixtureInputs, assertPricingFixtureInputsUnchanged } from './pricing-fixture-input.mjs';
import { pricingRuntimeSourceFiles } from '../src/lib/pricing/runtime';

type Check = { id: string; assertions: number; evidence: string[]; completed: true };
const root = fs.realpathSync(process.cwd());
const prepared = readPricingFixtureInputs(root);
const expected = Array.from({ length: 24 }, (_, index) => `G${String(index + 1).padStart(2, '0')}`);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const startedAt = Date.now();
const runId = process.env.PRICING_GATE_RUN_ID;
assert.ok(runId && /^[a-f0-9-]{36}$/.test(runId), 'A real pricing gate run UUID is required');
assert.equal(prepared.runId, runId);
fs.writeFileSync(path.join(prepared.directory, '.pricing-gate-claim'), JSON.stringify({ runId, startedAt }), { mode: 0o600, flag: 'wx' });
const suppliedManifest = process.env.PRICING_GATE_SOURCE_MANIFEST;
assert.ok(suppliedManifest && path.isAbsolute(suppliedManifest));
assert.ok(fs.realpathSync(suppliedManifest).startsWith(path.join(root, '.role-tests') + path.sep));
const manifestStat = fs.lstatSync(suppliedManifest);
assert.ok(manifestStat.isFile() && !manifestStat.isSymbolicLink() && !(manifestStat.mode & 0o077));
const sourceSha256: Record<string, string> = JSON.parse(fs.readFileSync(suppliedManifest, 'utf8'));
for (const [file, checksum] of Object.entries(sourceSha256)) {
  assert.ok(!path.isAbsolute(file) && !file.split(path.sep).includes('..'));
  assert.equal(sha(fs.readFileSync(path.join(root, file))), checksum, `Candidate changed before fixture: ${file}`);
}
const previousUmask = process.umask(0o077);
const directory = fs.mkdtempSync(path.join(root, '.role-tests', 'pricing-contract-'));
const schemaPath = path.join(directory, 'pricing-empty-schema.db');
const require = createRequire(import.meta.url), prismaPackage = require.resolve('prisma/package.json');
const clean: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: `file:${schemaPath}`, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1',
  SESSION_SECRET: 'pricing-fixture-only-signature-not-a-production-secret' };
for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) clean[key] = process.env[key];
const schema = spawnSync(process.execPath, [path.join(path.dirname(prismaPackage), 'build/index.js'), 'db', 'push', '--skip-generate',
  '--schema', path.join(root, 'prisma/schema.prisma')], { cwd: directory, env: clean, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
fs.writeFileSync(path.join(directory, 'isolated-schema.log'), (schema.stdout || '') + (schema.stderr || ''), { mode: 0o600, flag: 'wx' });
if (schema.error || schema.signal || schema.status !== 0) throw new Error(`pricing_fixture_environment: isolated schema initialization failed; see ${path.join(directory, 'isolated-schema.log')}`);
assert.equal(fs.statSync(schemaPath).mode & 0o077, 0);
const checks = new Map<string, Check>();
function complete(id: string, assertions: number, evidence: string[]) {
  assert.ok(expected.includes(id) && Number.isSafeInteger(assertions) && assertions > 0 && evidence.length);
  const entry = checks.get(id) || { id, assertions: 0, evidence: [], completed: true as const };
  entry.assertions += assertions; entry.evidence.push(...evidence); checks.set(id, entry);
}
const transcripts: Array<{ kind: string; log: string; sha256: string }> = [];
type Failure = { kind: string; category: 'execution' | 'contract' | 'dependency' | 'integrity' | 'environment'; message: string; log?: string;
  status?: number | null; signal?: string | null };
const failures: Failure[] = [], outcomes: Array<{ kind: string; completed: boolean; log?: string }> = [];
function run(kind: string, consume: (result: ReturnType<typeof JSON.parse>) => void) {
  const previous = new Map(Array.from(checks, ([id, check]) => [id, { ...check, evidence: [...check.evidence] }]));
  let log: string | undefined, status: number | null | undefined, signal: string | null | undefined;
  let category: Failure['category'] = 'execution';
  try {
    const unit: string = kind === 'parent' ? prepared.roots.legacy
      : ['core', 'toolflow', 'legacy'].includes(kind) ? prepared.roots[kind] : fs.mkdtempSync(path.join(directory, `pricing-${kind}-fixture-`));
    const databasePath = path.join(unit, `pricing-${kind}-fixture.db`);
    fs.copyFileSync(schemaPath, databasePath, fs.constants.COPYFILE_EXCL); fs.chmodSync(databasePath, 0o600);
    const env = { ...clean, DATABASE_URL: `file:${databasePath}`, PRICING_ADMIN_FIXTURE_DB: databasePath,
      PRICING_VIDEO_FIXTURE_DB: databasePath, PRICING_CORE_FIXTURE_DB: databasePath,
      PRICING_CORE_RUNTIME_ROOT: prepared.roots.core, PRICING_TOOLFLOW_RUNTIME_ROOT: prepared.roots.toolflow,
      PRICING_PARENT_RUNTIME_ROOT: prepared.roots.legacy,
      PRICING_SOURCE_SHA: prepared.source, RATE_G19_FIXTURE_SOURCE_SHA: prepared.source };
    const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'scripts/pricing-fixture-runner.ts'), kind], {
      cwd: root, env, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024,
    });
    status = result.status; signal = result.signal;
    const bytes = (result.stdout || '') + (result.stderr || ''); log = path.join(unit, `execution-${kind}.log`);
    fs.writeFileSync(log, bytes, { mode: 0o600, flag: 'wx' }); transcripts.push({ kind, log, sha256: sha(bytes) });
    const childFailure = (result.stderr || '').split(/\r?\n/).flatMap(line => {
      try { const value = JSON.parse(line); return value?.schema === 'pricing-fixture-execution-failure.v1' ? [value] : []; }
      catch { return []; }
    }).at(-1);
    if (childFailure?.category === 'environment') category = 'environment';
    assert.ifError(result.error); assert.equal(result.signal, null, `${kind} fixture interrupted`);
    assert.equal(result.status, 0, `${kind} pricing fixture failed; see ${log}`);
    category = 'contract';
    const rows = (result.stdout || '').split(/\r?\n/).filter(line => line.trim().startsWith('{')).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    assert.ok(rows.length, `${kind} returned no completed execution evidence`);
    consume(rows[rows.length - 1]); outcomes.push({ kind, completed: true, log });
  } catch (error) {
    checks.clear(); previous.forEach((check, id) => checks.set(id, check));
    failures.push({ kind, category, message: error instanceof Error ? error.message : String(error), log, status, signal });
    outcomes.push({ kind, completed: false, log });
  }
}
function continuationSafe() {
  try {
    assertPricingFixtureInputsUnchanged(prepared);
    for (const file of pricingRuntimeSourceFiles(root)) {
      const destination = path.join(prepared.roots.legacy, file), bytes = fs.readFileSync(path.join(root, file));
      assert.ok(file === '.deployed-commit' || sourceSha256[file] === sha(bytes), `Candidate runtime source changed: ${file}`);
      if (fs.existsSync(destination)) assert.deepEqual(fs.readFileSync(destination), bytes, `Shared runtime changed: ${file}`);
      else { fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 }); fs.writeFileSync(destination, bytes, { mode: 0o600, flag: 'wx' }); }
    }
    return true;
  } catch (error) {
    failures.push({ kind: 'shared-runtime', category: 'dependency', message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

run('admin', admin => {
assert.equal(admin.fixture, 'pricing-admin-contract'); assert.equal(admin.rolledBack, true);
assert.ok(Array.isArray(admin.evidence) && admin.evidence.length >= 8);
for (const id of ['G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G08', 'G12', 'G15', 'G18', 'G20', 'G21', 'G22', 'G23']) {
  complete(id, 1, [`Actual Prisma administrative contract fixture completed; see ${transcripts.at(-1)!.log}`, ...admin.evidence.filter((item: unknown) => typeof item === 'string' && item.includes(id))]);
}
});
run('ui', ui => {
assert.equal(ui.fixture, 'pricing-admin-ui-contract'); assert.equal(ui.completed, true); assert.ok(ui.result);
for (const id of ['G13', 'G18', 'G22', 'G23']) complete(id, 1, [`Actual pure UI state/filter/draft/unknown-operation helpers executed: ${transcripts.at(-1)!.log}`]);
});
run('image-ui', ui => {
  assert.equal(ui.completed, true); assert.ok(Array.isArray(ui.checks) && ui.checks.length);
  for (const entry of ui.checks) complete(entry.id, entry.assertions, entry.evidence);
});
run('video', video => {
assert.equal(video.fixture, 'pricing-video-contract'); assert.equal(video.rolledBack, true); assert.ok(video.evidence?.length);
for (const id of ['G09', 'G11', 'G13', 'G21']) complete(id, 1, [`Real Prisma/video quote/acceptance and public projection helpers executed: ${transcripts.at(-1)!.log}`, ...video.evidence]);
});
// The old-consumer fixture requires a source-empty runtime. Later isolated DB
// children reuse its identical source bytes and root marker, never fabricate a second marker.
let legacyEvidence: ReturnType<typeof JSON.parse>;
run('legacy', legacy => {
assert.equal(legacy.completed, true); assert.equal(legacy.schema, 'pricing-legacy-consumer.v2');
assert.deepEqual(legacy.forbiddenCalls, []); assert.equal(legacy.source, prepared.source);
assert.equal(legacy.sources?.web?.commit, '2339086c326a66f0123a12569190446eba36493e');
assert.equal(legacy.sources?.image?.commit, '80d5cf6f1ec489ea93257d42e8dd5c7e4e782560');
assert.equal(legacy.database?.path, path.join(prepared.roots.legacy, 'pricing-legacy-fixture.db'));
assert.equal(legacy.database?.rolledBack, true);
assert.ok(legacy.processIdentity?.pid > 0 && legacy.processIdentity?.start);
assert.ok(Array.isArray(legacy.entrypoints) && legacy.entrypoints.length >= 12);
for (const variant of ['web', 'image']) for (const entry of ['claimStudioTask', 'processStudioTask', 'reconcileImageBilling',
  'dispatchStudioBatches', 'dispatchWaitingToolFlowRuns', 'main']) {
  assert.ok(legacy.entrypoints.some((item: { variant: string; entry: string }) => item.variant === variant && item.entry === entry), `${variant} ${entry} did not execute`);
}
for (const kind of ['strict', 'ordinary', 'unprotected', 'wrong-schema', 'extra-field']) {
  const input = legacy.rootInputs?.[kind];
  assert.ok(input && input.uid === 0 && input.mode === 0o444 && input.nlink === 1);
  assert.equal(input.attributes.includes('i'), !['ordinary', 'unprotected'].includes(kind));
  assert.equal(sha(fs.readFileSync(input.file)), input.sha256, `G19 ${kind} input changed`);
}
assert.ok(Array.isArray(legacy.checks) && legacy.checks.length);
for (const entry of legacy.checks) complete(entry.id, entry.assertions, entry.evidence);
legacyEvidence = { schema: legacy.schema, sources: legacy.sources, entrypoints: legacy.entrypoints, rootInputs: legacy.rootInputs,
  processIdentity: legacy.processIdentity, database: legacy.database };
});
let parentEvidence: ReturnType<typeof JSON.parse>;
if (continuationSafe()) run('parent', parent => {
assert.equal(parent.fixture, 'pricing-parent-identity-contract'); assert.equal(parent.completed, true);
assert.ok(Array.isArray(parent.checks) && parent.checks.length);
const identity = parent.processEvidence;
assert.ok(identity?.worker?.pid > 1 && identity.worker.uid === process.getuid!());
assert.equal(identity.worker.parentPid, 1); assert.match(identity.worker.start, /^\d+$/);
assert.equal(identity.parent.pid, 1); assert.equal(identity.parent.uid, 0);
assert.match(identity.parent.start, /^\d+$/); assert.equal(identity.parentSignalZero, 'EPERM');
assert.equal(identity.capability.instance.pid, identity.worker.pid);
assert.equal(identity.capability.instance.start, identity.worker.start);
assert.equal(identity.capability.instance.cwd, prepared.roots.legacy);
assert.equal(identity.capability.instance.parentPid, 1);
assert.deepEqual(identity.capability.parent, { pid: 1, start: identity.parent.start });
assert.equal(identity.capability.source, prepared.source);
assert.equal(identity.reader.workerId, identity.capability.workerId);
assert.equal(identity.reader.source, prepared.source);
assert.ok(identity.controller?.pid > 1 && identity.controller.uid === identity.worker.uid);
for (const entry of parent.checks) { assert.equal(entry.id, 'G19'); complete(entry.id, entry.assertions, entry.evidence); }
parentEvidence = parent;
});
else outcomes.push({ kind: 'parent', completed: false });
if (continuationSafe()) run('core', core => {
assert.equal(core.schema, 'pricing-core-contract.v1'); assert.equal(core.completed, true);
for (const entry of core.checks) complete(entry.id, entry.assertions, entry.evidence);
});
else outcomes.push({ kind: 'core', completed: false });
if (continuationSafe()) run('toolflow', toolflow => {
assert.equal(toolflow.fixture, 'pricing-toolflow-contract'); assert.equal(toolflow.completed, true);
assert.equal(toolflow.providerCalls, 0); assert.ok(toolflow.evidence?.length);
for (const id of ['G11', 'G17', 'G21']) complete(id, 1, [`Real toolflow runtime executed: ${transcripts.at(-1)!.log}`, ...toolflow.evidence, toolflow.permissionEvidence]);
});
else outcomes.push({ kind: 'toolflow', completed: false });
try {
  assertPricingFixtureInputsUnchanged(prepared);
  for (const [file, checksum] of Object.entries(sourceSha256)) assert.equal(sha(fs.readFileSync(path.join(root, file))), checksum, `Candidate changed during pricing fixture: ${file}`);
} catch (error) { failures.push({ kind: 'integrity', category: 'integrity', message: error instanceof Error ? error.message : String(error) }); }
const missingChecks = expected.filter(id => !checks.has(id));
if (failures.length || missingChecks.length) {
  const file = path.join(directory, 'failure-report.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 'pricing-policy-contract-failure.v1', completed: false, runId, candidateRoot: root,
    startedAt, finishedAt: Date.now(), sourceSha256, failures, missingChecks, outcomes, transcripts,
    completedChecks: Array.from(checks.values()), rootInputManifest: prepared.manifest }), { mode: 0o600, flag: 'wx' });
  process.umask(previousUmask);
  console.error(`Pricing policy contract failure report: ${file}`);
  process.exitCode = 1;
} else {
const receipt = path.join(directory, `receipt-${randomUUID()}.json`);
fs.writeFileSync(receipt, JSON.stringify({ schema: 'pricing-policy-contract-fixture.v1', runId, synthetic: true, completed: true,
  candidateRoot: root, startedAt, finishedAt: Date.now(), fixtureSha256: sourceSha256['scripts/pricing-policy-contract-fixture.ts'],
  sourceSha256, checks: expected.map(id => checks.get(id)), transcripts,
  rootInputManifest: { path: prepared.manifest, sha256: sha(fs.readFileSync(prepared.manifest)), source: prepared.source,
    sourceTreeSha256: prepared.sourceTreeSha256, runId: prepared.runId },
  legacy: legacyEvidence, parent: parentEvidence,
  forbiddenCalls: 0, productionWrites: 0, paidRequests: 0, browserRuns: 0 }), { mode: 0o600, flag: 'wx' });
process.umask(previousUmask);
console.log(`Pricing policy contract fixture receipt: ${receipt}`);
}
