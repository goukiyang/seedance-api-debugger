import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { assertHdMaintenanceApproval, HD_MAINTENANCE_APPROVAL_SCHEMA, privateFreezeSha256 } from './cutover-driver.mjs';

// Pure checks of the actual approval predicate. No FS, SSH, DB, service or
// supplier operation is selected by this fixture; the runtime loader supplies
// the rootFile-validated byte hashes at this exact boundary.
export function runHdMaintenanceApprovalEngineering() {
  const now = Date.parse('2026-10-19T20:00:00.000Z');
  const m = { runId: '11111111-1111-4111-8111-111111111111', mainSource: 'a'.repeat(40), guardSource: 'b'.repeat(40),
    privateSha256: { 'writer-network-fence.mjs': 'c'.repeat(64), 'cutover-driver.mjs': 'd'.repeat(64) } };
  const binding = { now, manifestSha256: '1'.repeat(64), windowSha256: '2'.repeat(64),
    mainBuildReceiptSha256: '3'.repeat(64), guardBuildReceiptSha256: '4'.repeat(64) };
  const approval = { schema: HD_MAINTENANCE_APPROVAL_SCHEMA, runId: m.runId, mainSource: m.mainSource,
    guardSource: m.guardSource, manifestSha256: binding.manifestSha256, privateFreezeSha256: privateFreezeSha256(m),
    windowSha256: binding.windowSha256, mainBuildReceiptSha256: binding.mainBuildReceiptSha256,
    guardBuildReceiptSha256: binding.guardBuildReceiptSha256, issuedAt: '2026-10-19T19:59:30.000Z',
    expiresAt: '2026-10-19T20:04:30.000Z', manualMaintenanceConfirmed: true, allowCompatibleRollback: true,
    operations: ['switch', 'rollback-to-compatible-guard'], writerFence: { install: true,
      helperSha256: m.privateSha256['writer-network-fence.mjs'],
      restorePhases: ['pre-stop-installation-abort', 'before-new-writer-after-proven-old-stop'] } };
  const cases = [];
  const check = (name, change = () => {}, accepted = false, bindingChange = () => {}) => {
    const value = structuredClone(approval), inputs = structuredClone(binding); change(value); bindingChange(inputs);
    if (accepted) assert.equal(assertHdMaintenanceApproval(m, value, inputs), value, name);
    else assert.throws(() => assertHdMaintenanceApproval(m, value, inputs), undefined, name);
    cases.push({ name, accepted, passed: true });
  };
  check('exact ISO approval accepted', () => {}, true);
  check('numeric milliseconds accepted', value => { value.issuedAt = now - 1000; value.expiresAt = now + 299000; }, true);
  for (const key of ['schema', 'runId', 'mainSource', 'guardSource', 'manifestSha256', 'privateFreezeSha256',
    'windowSha256', 'mainBuildReceiptSha256', 'guardBuildReceiptSha256'])
    check(key + ' mismatch rejected', value => { value[key] = 'wrong'; });
  check('expired rejected', value => { value.expiresAt = now; });
  check('future issue rejected', value => { value.issuedAt = now + 1; });
  check('more than five minutes rejected', value => { value.expiresAt = now + 300000; });
  check('locale date rejected', value => { value.issuedAt = '10/19/2026 19:59:30'; });
  check('numeric string rejected', value => { value.issuedAt = String(now - 1000); });
  check('invalid calendar ISO rejected without relying on TTL', value => {
    value.issuedAt = '2026-02-30T19:59:30.000Z'; value.expiresAt = '2026-03-02T20:04:30.000Z';
  }, false, value => { value.now = Date.parse('2026-03-02T20:00:00.000Z'); });
  check('missing manual maintenance confirmation rejected', value => { delete value.manualMaintenanceConfirmed; });
  check('missing compatible rollback confirmation rejected', value => { delete value.allowCompatibleRollback; });
  check('extra operation rejected', value => { value.operations.push('restore-old-writer'); });
  check('wrong operation order rejected', value => { value.operations.reverse(); });
  check('missing fence authority rejected', value => { value.writerFence.install = false; });
  check('wrong fence helper rejected', value => { value.writerFence.helperSha256 = 'f'.repeat(64); });
  check('missing restore phase rejected', value => { value.writerFence.restorePhases.pop(); });
  check('extra restore phase rejected', value => { value.writerFence.restorePhases.push('unconditional'); });
  for (const key of ['manifestSha256', 'windowSha256', 'mainBuildReceiptSha256', 'guardBuildReceiptSha256'])
    check('unvalidated ' + key + ' rejected', () => {}, false, value => { delete value[key]; });
  return { schema: 'hd-maintenance-approval-engineering.v1', completed: true, nativeExecuted: false,
    ioKind: 'pure-predicate', cases, forbiddenCalls: { production: 0, ssh: 0, service: 0, database: 0, supplier: 0 } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.stdout.write(JSON.stringify(runHdMaintenanceApprovalEngineering()) + '\n');
