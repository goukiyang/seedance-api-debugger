'use strict';
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const { atLeast, isPie, cleanAudit } = require('./thin-release-preflight.cjs');

assert.equal(atLeast('15.5.27', '15.5.28'), false);
assert.equal(atLeast('15.5.28', '15.5.28'), true);
assert.equal(atLeast('15.5.28-rc.1', '15.5.28'), false);
assert.equal(cleanAudit({ error: 'registry unavailable' }), false);
assert.equal(cleanAudit({ metadata: { vulnerabilities: { high: 1, critical: 0 } } }), false);
assert.equal(cleanAudit({ metadata: { vulnerabilities: { high: 0, critical: 1 } } }), false);
assert.equal(cleanAudit({ metadata: { vulnerabilities: { high: 0, critical: 0, moderate: 2 } } }), true);
const directory = mkdtempSync(path.join(require('node:os').tmpdir(), 'sd2-elf-'));
try {
  const file = path.join(directory, 'node-fixture');
  const bytes = Buffer.alloc(18); bytes.set([127, 69, 76, 70, 2, 1]);
  bytes.writeUInt16LE(2, 16); writeFileSync(file, bytes); assert.equal(isPie(file), false);
  bytes.writeUInt16LE(3, 16); writeFileSync(file, bytes); assert.equal(isPie(file), true);
  bytes[0] = 0; writeFileSync(file, bytes); assert.equal(isPie(file), false);
} finally { rmSync(directory, { recursive: true, force: true }); }
console.log('PASS preflight rejects vulnerable versions, uncertain audit and non-PIE executable');
