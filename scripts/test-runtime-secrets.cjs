'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-startup-secrets-'));
const startup = () => spawnSync(process.execPath, ['--require', path.join(root, 'scripts/server-runtime.cjs'), '-e', 'console.log("runtime-ready")'], {
  cwd: fixture,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production' },
  encoding: 'utf8',
});
const result = startup();
assert.notEqual(result.status, 0, 'Production process must refuse startup without signing secrets');
assert.match(result.stderr, /SECRET_CONFIGURATION_INVALID/, 'Failure must be the startup secret guard, not an import or decoder error');
assert.doesNotMatch(result.stdout, /runtime-ready/);
console.log('PASS production startup refuses missing signing secrets');
try {
  fs.writeFileSync(path.join(fixture, '.env'), 'SESSION_SECRET=' + require('node:crypto').randomBytes(48).toString('base64url') + '\n', { mode: 0o600 });
  const configured = startup();
  assert.equal(configured.status, 0, configured.stderr);
  assert.match(configured.stdout, /runtime-ready/);
  console.log('PASS production startup loads its configured environment before validating keys');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

const { requireSecret, assertStartupSecrets } = require('../src/lib/security/secrets.cjs');
const original = process.env.SESSION_SECRET;
const originalUpload = process.env.UPLOAD_TICKET_SECRET;
try {
  process.env.SESSION_SECRET = require('node:crypto').randomBytes(48).toString('base64url');
  delete process.env.UPLOAD_TICKET_SECRET;
  assert.notDeepEqual(requireSecret('upload'), requireSecret('pricing'));
  assert.deepEqual(requireSecret('upload'), requireSecret('upload'));
  process.env.UPLOAD_TICKET_SECRET = 'short';
  assert.throws(() => requireSecret('upload'), /SECRET_CONFIGURATION_INVALID:upload/);
  assert.throws(() => assertStartupSecrets(), /SECRET_CONFIGURATION_INVALID/);
  console.log('PASS purpose-separated stable keys and explicit invalid-key refusal');
} finally {
  if (original === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = original;
  if (originalUpload === undefined) delete process.env.UPLOAD_TICKET_SECRET; else process.env.UPLOAD_TICKET_SECRET = originalUpload;
}
