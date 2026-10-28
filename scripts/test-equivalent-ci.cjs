'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { COMMANDS, fingerprint, verifyEquivalentCi, hashFile, reusablePrebuild } = require('./equivalent-ci.cjs');
const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'equivalent-ci-contract-'));
try {
  const source = 'a'.repeat(40);
  fs.mkdirSync(path.join(root, '.role-tests'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.mkdirSync(path.join(root, 'src/app/uploads'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/app/uploads/route.ts'), 'synthetic-source');
  fs.writeFileSync(path.join(root, '.deployed-commit'), source);
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(root, 'node_modules/.package-lock.json'), '{}');
  const now = new Date().toISOString();
  const results = COMMANDS.map((name, index) => {
    const log = `.role-tests/${index}.log`;
    fs.writeFileSync(path.join(root, log), `synthetic ${name} output`);
    return { command: `npm run ${name}`, exitCode: 0, signal: null, startedAt: now, finishedAt: now, log, logSha256: hashFile(path.join(root, log)) };
  });
  const receipt = { schema: 'equivalent-ci.v1', source, root, fingerprint: fingerprint(root), results, completed: true };
  const file = path.join(root, '.role-tests/receipt.json');
  const save = () => fs.writeFileSync(file, JSON.stringify(receipt));
  save();
  assert.equal(verifyEquivalentCi(root, source, file), true);
  assert.equal(verifyEquivalentCi(root, 'b'.repeat(40), file), false);
  receipt.results[0].exitCode = 1; save();
  assert.equal(verifyEquivalentCi(root, source, file), false);
  receipt.results[0].exitCode = 0; save();
  fs.writeFileSync(path.join(root, 'src/app/uploads/route.ts'), 'changed-source');
  assert.equal(verifyEquivalentCi(root, source, file), false);
  fs.writeFileSync(path.join(root, 'src/app/uploads/route.ts'), 'synthetic-source');
  fs.writeFileSync(path.join(root, 'node_modules/.package-lock.json'), '{"changed":true}');
  assert.equal(verifyEquivalentCi(root, source, file), false);
  fs.writeFileSync(path.join(root, 'node_modules/.package-lock.json'), '{}');
  fs.appendFileSync(path.join(root, results[0].log), 'changed log');
  assert.equal(verifyEquivalentCi(root, source, file), false);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { prebuild: 'node scripts/check-image-recovery.mjs' } }));
  const contractLog = path.join(root, results[2].log);
  const summary = { schema: 'contract-suites.v1', results: [{ suite: 'scripts/check-image-recovery.mjs', exitCode: 0, passed: true }] };
  fs.writeFileSync(contractLog, JSON.stringify(summary));
  results[2].logSha256 = hashFile(contractLog);
  assert.equal(reusablePrebuild(root, results), true);
  results[2].exitCode = 1;
  assert.equal(reusablePrebuild(root, results), false);
  results[2].exitCode = 0;
  summary.results[0].passed = false;
  fs.writeFileSync(contractLog, JSON.stringify(summary));
  assert.equal(reusablePrebuild(root, results), false);
  results[2].logSha256 = hashFile(contractLog);
  assert.equal(reusablePrebuild(root, results), false);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { prebuild: 'node another-gate.cjs' } }));
  assert.equal(reusablePrebuild(root, results), false);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.111.1', scripts: { prebuild: 'node scripts/check-image-recovery.mjs' } }));
  const priorLog = path.join(root, '.role-tests/prior.log'), priorFile = path.join(root, '.role-tests/prior.json');
  fs.writeFileSync(priorLog, 'synthetic original evidence');
  const prior = { completed: true, source: '2759dba29f15b413c866e89837b18f031a4333b3',
    results: [{ command: 'npm run test:contracts', exitCode: 0, logSha256: hashFile(priorLog) }] };
  fs.writeFileSync(priorFile, JSON.stringify(prior));
  const delta = { schema: 'contract-suites.v1', mode: 'sql01',
    reusedBaseline: { receipt: priorFile, receiptSha256: hashFile(priorFile), log: priorLog, logSha256: hashFile(priorLog) },
    results: ['scripts/verify-sql01-template-server.ts', 'scripts/verify-sql01-video-tx-server.cjs',
      'scripts/verify-sql01-observations-server.ts', 'scripts/test-auth-contract.mjs'].map(suite => ({ suite, exitCode: 0, passed: true })) };
  const saveDelta = () => { fs.writeFileSync(contractLog, JSON.stringify(delta)); results[2].logSha256 = hashFile(contractLog); };
  saveDelta(); assert.equal(reusablePrebuild(root, results), true);
  delta.results[0].passed = false; saveDelta(); assert.equal(reusablePrebuild(root, results), false);
  delta.results[0].passed = true; const missing = delta.results.pop(); saveDelta(); assert.equal(reusablePrebuild(root, results), false);
  delta.results.push(missing); saveDelta(); fs.appendFileSync(priorLog, 'tampered');
  assert.equal(reusablePrebuild(root, results), false, 'A scoped delta cannot reuse altered original evidence');
  console.log('PASS equivalent CI source, lock, runtime, command results and log binding');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
