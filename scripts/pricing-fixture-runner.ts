import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { mock } from 'node:test';

async function main() {
  const root = fs.realpathSync(process.cwd());
  const kind = process.argv[2];
  const databasePath = process.env.DATABASE_URL?.replace(/^file:/, '');
  assert.ok(databasePath && path.isAbsolute(databasePath));
  assert.ok(fs.realpathSync(databasePath).startsWith(path.join(root, '.role-tests') + path.sep));
  let forbiddenCalls = 0;
  const blocked = () => { forbiddenCalls++; throw new Error('Pricing build fixture attempted a forbidden external call'); };
  mock.method(globalThis, 'fetch', blocked); mock.method(http, 'request', blocked); mock.method(http, 'get', blocked);
  mock.method(https, 'request', blocked); mock.method(https, 'get', blocked);
  process.on('beforeExit', () => { if (forbiddenCalls) { console.error('Forbidden fixture calls:', forbiddenCalls); process.exitCode = 1; } });
  if (kind === 'admin') { await import('./pricing-admin-contract-fixture'); return; }
  if (kind === 'video') { await import('./pricing-video-contract-fixture'); return; }
  if (kind === 'core') { await import('./pricing-core-contract-fixture'); return; }
  if (kind === 'ui') {
    const { runPricingAdminUiContractFixture } = await import('./pricing-admin-ui-contract-fixture');
    console.log(JSON.stringify({ fixture: 'pricing-admin-ui-contract', completed: true, result: runPricingAdminUiContractFixture() })); return;
  }
  if (kind === 'image-ui') {
    const { runPricingImageUiContractFixture } = await import('./pricing-image-ui-contract-fixture');
    const result = await runPricingImageUiContractFixture();
    assert.equal(forbiddenCalls, 0); console.log(JSON.stringify({ fixture: 'pricing-image-ui-contract', ...result })); return;
  }
  if (kind === 'legacy') {
    const { runPricingLegacyConsumerFixture } = await import('./pricing-legacy-consumer-fixture');
    const result = await runPricingLegacyConsumerFixture({ candidateRoot: root, fixtureRoot: path.dirname(databasePath), databasePath });
    assert.equal(forbiddenCalls, 0); console.log(JSON.stringify({ fixture: 'pricing-legacy-consumer-contract', completed: true, ...result })); return;
  }
  assert.equal(kind, 'toolflow');
  const runtimeRoot = fs.realpathSync(process.env.PRICING_TOOLFLOW_RUNTIME_ROOT || '');
  assert.equal(process.platform, 'linux');
  assert.ok(runtimeRoot.startsWith(path.join(root, '.role-tests') + path.sep));
  const { pricingRuntimeSourceFiles } = await import('../src/lib/pricing/runtime');
  for (const file of pricingRuntimeSourceFiles(root)) {
    const destination = path.join(runtimeRoot, file), bytes = fs.readFileSync(path.join(root, file));
    if (fs.existsSync(destination)) assert.deepEqual(fs.readFileSync(destination), bytes, `Prepared runtime source changed: ${file}`);
    else { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 }); }
  }
  const source = process.env.PRICING_SOURCE_SHA;
  assert.ok(source && /^[a-f0-9]{40}$/.test(source));
  const { runPricingToolflowContractFixture } = await import('./pricing-toolflow-contract-fixture');
  const result = await runPricingToolflowContractFixture({ databasePath, runtimeRoot, source });
  assert.equal(forbiddenCalls, 0);
  console.log(JSON.stringify({ fixture: 'pricing-toolflow-contract', completed: true, ...result,
    permissionEvidence: 'Actual Linux root/immutable isolated inputs and actual live process checks; production installation is separately required.' }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
