import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyTemplate, contractData, validatePlan, checkSources, reuseInput, renderWrapper, prepare, REUSE_SCHEMA,
  DEPLOYED_SCHEMA, DEPLOYED_FIELDS, deployedProofInput } from './sd2-release-prepare.mjs';

const materials = process.argv[2];
assert.ok(materials && path.isAbsolute(materials), 'Pass the original private release materials directory');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = verifyTemplate(materials, { originalOnly: true });
const activeTemplate = verifyTemplate(materials);
const original = contractData(activeTemplate.files['release-contract.mjs'].toString()).value;
const now = Date.now();
const c = structuredClone(original);
c.recoveryRunId = randomUUID();
// Fixture only: use immutable refs. These historical PIDs are never treated as live evidence.
c.mainBranch = c.mainSource;
c.guardReference = c.recoveryGuardSource;
const plan = { schema: 'sd2-release-plan.v1', repoRoot: repo, outputRoot: path.join(materials, 'offline-fixture-' + randomUUID()),
  liveCapture: { observedAt: new Date(now).toISOString(), source: c.baselineSource, version: c.baselineVersion,
    build: c.baselineBuild, starts: c.starts, pricingRevision: c.pricingRevision, allowedSha256: c.expectedAllowedSha256 },
  contract: c, reuseBuilds: { sourceRun: 'b9c1ea7c-34a4-4834-8d33-83381ff68da0',
    directory: path.join(materials, 'b9c1ea7c-34a4-4834-8d33-83381ff68da0') } };
const outcomes = [];
async function test(name, callback) {
  try { await callback(); outcomes.push({ name, passed: true }); }
  catch (error) { outcomes.push({ name, passed: false, error: error.message }); }
}
const invalid = change => { const value = structuredClone(plan); change(value); assert.throws(() => validatePlan(value, original, now)); };
await test('Pinned successful template and receipts', () => assert.equal(Object.keys(template.files).length, 36));
await test('Current guard need not be a code ancestor', () => { validatePlan(plan, original, now); checkSources(repo, c); });
await test('Stale capture rejected', () => invalid(p => { p.liveCapture.observedAt = new Date(now - 300001).toISOString(); }));
await test('Future capture rejected', () => invalid(p => { p.liveCapture.observedAt = new Date(now + 1).toISOString(); }));
await test('Historical run cannot be reused', () => invalid(p => { p.contract.recoveryRunId = original.recoveryRunId; }));
await test('Runtime identity not silently changed', () => invalid(p => { p.contract.baselineSource = p.contract.sourceBase; }));
await test('Unexpected fields rejected', () => invalid(p => { p.skipChecks = true; }));
await test('Missing field rejected', () => invalid(p => { delete p.contract.expectedAllowedSha256; }));
await test('Pricing capture mismatch rejected', () => invalid(p => { p.contract.pricingRevision = randomUUID(); }));
await test('Legal guard not marked retired', () => invalid(p => { p.contract.retiredPricingSources.push(p.contract.recoveryGuardSource); }));
await test('Retired source protection cannot be dropped', () => invalid(p => { p.contract.retiredPricingSources = []; }));
await test('Protected tasks cannot be dropped', () => invalid(p => { p.contract.protectedVideoTaskIds.pop(); }));
await test('Same source pair rejected', () => invalid(p => { p.contract.recoveryGuardSource = p.contract.mainSource; }));
await test('Exact source scope required', () => assert.throws(() => checkSources(repo, { ...c, approvedMainFiles: c.approvedMainFiles.slice(1) })));
await test('Code ancestry independently required', () => assert.throws(() => checkSources(repo, { ...c, sourceBase: c.recoveryGuardSource })));
await test('Reuse schema derived with both original receipts', () => {
  const result = reuseInput(plan); assert.equal(result.schema, 'sd2-original-build-reuse-input.v1');
  assert.deepEqual(Object.keys(result).sort(), ['guard', 'main', 'schema', 'sourceRun']);
});
await test('Mixed main and guard cannot reuse old pair', () => {
  const mixed = structuredClone(plan); mixed.contract.recoveryGuardSource = c.sourceBase;
  assert.throws(() => reuseInput(mixed));
});
await test('Fresh builds never claim reused evidence', () => assert.equal(reuseInput({ ...plan, reuseBuilds: null }), null));
const deployedPlan = () => {
  const value = structuredClone(plan); value.reuseBuilds = null;
  value.contract.normalContinuation = null;
  value.contract.deployedUsageSchema = Object.fromEntries(DEPLOYED_FIELDS.map(key => [key,
    key === 'schema' ? DEPLOYED_SCHEMA : key.endsWith('Sha256') ? 'a'.repeat(64) : randomUUID()]));
  value.deployedUsageProof = { stdoutFile: '/tmp/retained-proof.stdout', commandReceiptFile: '/tmp/retained-proof-command.json' };
  return value;
};
await test('Deployed schema is explicit nullable and requires fresh full pair', async () => {
  assert.equal(original.deployedUsageSchema, null);
  const value = deployedPlan(); validatePlan(value, original, now);
  const privateSchema = await import(pathToFileURL(path.join(materials, activeTemplate.templateName, 'deployed-usage-schema.mjs')));
  assert.equal(privateSchema.DEPLOYED_SCHEMA, DEPLOYED_SCHEMA); assert.deepEqual(privateSchema.DEPLOYED_FIELDS, DEPLOYED_FIELDS);
  privateSchema.assertDeployedSchemaInput(value.contract.deployedUsageSchema);
});
await test('Deployed schema rejects missing changed unknown or same-run inputs', () => {
  for (const key of DEPLOYED_FIELDS) {
    const value = deployedPlan(); delete value.contract.deployedUsageSchema[key];
    assert.throws(() => validatePlan(value, original, now));
  }
  for (const change of [v => { v.reuseBuilds = plan.reuseBuilds; },
    v => { v.contract.normalContinuation = {}; }, v => { v.contract.deployedUsageSchema.allowWrites = true; },
    v => { v.contract.deployedUsageSchema.publicationRun = v.contract.recoveryRunId; },
    v => { v.contract.deployedUsageSchema.migrationRun = v.contract.recoveryRunId; },
    v => { delete v.deployedUsageProof; },
    v => { v.contract.deployedUsageSchema.backupSha256 = 'unknown'; }]) {
    const value = deployedPlan(); change(value); assert.throws(() => validatePlan(value, original, now));
  }
});
await test('Original retained stdout and original command receipt are copied without invented history', () => {
  const value = deployedPlan(), directory = path.resolve(materials, '../2026-10-21-projects-usage-ux-preflight/implementation');
  value.deployedUsageProof = { stdoutFile: path.join(directory, 'proof-joint-r07.stdout'),
    commandReceiptFile: path.join(directory, 'proof-joint-r07-command.json') };
  const stdout = fs.readFileSync(value.deployedUsageProof.stdoutFile), command = fs.readFileSync(value.deployedUsageProof.commandReceiptFile),
    proof = JSON.parse(stdout), hash = bytes => createHash('sha256').update(bytes).digest('hex');
  Object.assign(value.contract.deployedUsageSchema, { publicationRun: proof.runId, publicationManifestSha256: proof.manifestSha256,
    finalProofSha256: hash(stdout), finalProofCommandSha256: hash(command) });
  const output = deployedProofInput(value);
  assert.deepEqual(output.stdout, stdout); assert.deepEqual(output.command, command);
  assert.equal(output.provenance.originalBytesAndTimesChanged, false); assert.equal(output.provenance.historicalRunWritten, false);
  value.contract.deployedUsageSchema.finalProofCommandSha256 = '0'.repeat(64);
  assert.throws(() => deployedProofInput(value));
});
await test('Actual controller agrees with evidence schema', async () => {
  const evidence = await import(pathToFileURL(path.join(materials, 'release-r16/candidate-evidence.mjs')));
  assert.equal(REUSE_SCHEMA, evidence.REUSE_SCHEMA);
});
await test('Wrapper transformations require exact known syntax', () => {
  assert.throws(() => renderWrapper(template.wrapper.replace("path.join(base, 'release-r16')", "path.join(base, 'other')"), repo, null, 'release-r16'));
  assert.throws(() => renderWrapper(template.wrapper.replace('reuseBuilds:', 'unexpected:'), repo, null, 'release-r16'));
});
await test('Changed original receipt rejects reuse', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-reuse-test-'));
  try {
    for (const kind of ['main', 'guard']) fs.copyFileSync(path.join(plan.reuseBuilds.directory, kind + '-immutable-success.json'), path.join(temporary, kind + '-immutable-success.json'));
    const file = path.join(temporary, 'guard-immutable-success.json'), receipt = JSON.parse(fs.readFileSync(file));
    receipt.originalTimesChanged = true; fs.writeFileSync(file, JSON.stringify(receipt));
    assert.throws(() => reuseInput({ ...plan, reuseBuilds: { ...plan.reuseBuilds, directory: temporary } }));
  } finally { fs.rmSync(temporary, { recursive: true }); }
});
await test('Preparation preserves all safety modules byte for byte', async () => {
  let created = false;
  try {
    const result = await prepare(plan, materials); created = true;
    assert.equal(result.receipt.serverAdmissionVerified, false);
    assert.equal(result.receipt.candidateEvidenceKind, REUSE_SCHEMA);
    for (const [file, bytes] of Object.entries(activeTemplate.files)) {
      const output = fs.readFileSync(path.join(result.output, 'control', file));
      if (file !== 'release-contract.mjs') assert.deepEqual(output, bytes);
      else assert.deepEqual(contractData(output.toString()).value, c);
      execFileSync(process.execPath, ['--check', path.join(result.output, 'control', file)]);
    }
    execFileSync(process.execPath, ['--check', path.join(result.output, 'run.mjs')]);
    assert.equal(fs.statSync(result.output).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(result.output, 'run.mjs')).mode & 0o777, 0o600);
    await assert.rejects(prepare(plan, materials), /Output must be new/);
    assert.deepEqual(verifyTemplate(materials, { originalOnly: true }).files, template.files);
    assert.deepEqual(verifyTemplate(materials).files, activeTemplate.files);
  } finally { if (created) fs.rmSync(plan.outputRoot, { recursive: true }); }
});
console.log(JSON.stringify({ schema: 'sd2-release-preparer-check.v1', fixtureOnly: true, outcomes,
  passed: outcomes.every(o => o.passed), serverContacted: false, servicesChanged: false, productionWrites: 0,
  applicationBuilt: false, functionalAcceptance: false }, null, 2));
if (outcomes.some(o => !o.passed)) process.exitCode = 1;
