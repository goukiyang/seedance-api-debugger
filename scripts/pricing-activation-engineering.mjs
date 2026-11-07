import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

// Reproduce the existing native gate's admin subgroup, using only a new private SQLite fixture.
const root = fs.realpathSync(process.cwd()), scratch = path.join(root, '.role-tests');
const require = createRequire(import.meta.url);
fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
assert.equal(fs.realpathSync(scratch), scratch);
const directory = fs.mkdtempSync(path.join(scratch, 'pricing-activation-'));
fs.chmodSync(directory, 0o700);
const database = path.join(directory, 'pricing-admin-fixture.db');
const env = { NODE_ENV: 'test', DATABASE_URL: `file:${database}`, PRICING_ADMIN_FIXTURE_DB: database,
  PRISMA_GENERATE_SKIP_AUTOINSTALL: '1', SESSION_SECRET: 'activation-fixture-only-not-a-production-secret' };
for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) env[key] = process.env[key];
process.umask(0o077);
const prisma = path.join(path.dirname(require.resolve('prisma/package.json')), 'build/index.js');
const schema = spawnSync(process.execPath, [prisma, 'db', 'push', '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')], {
  cwd: directory, env, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
});
const schemaLog = path.join(directory, 'schema.log');
fs.writeFileSync(schemaLog, (schema.stdout || '') + (schema.stderr || ''), { mode: 0o600, flag: 'wx' });
assert.ifError(schema.error);
assert.equal(schema.status, 0, `Isolated fixture schema failed: ${schemaLog}`);
assert.equal(fs.realpathSync(database), database);
assert.equal(fs.statSync(database).mode & 0o077, 0);
const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'scripts/pricing-fixture-runner.ts'), 'admin'], {
  cwd: root, env, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024,
});
const log = path.join(directory, 'admin.log');
fs.writeFileSync(log, (result.stdout || '') + (result.stderr || ''), { mode: 0o600, flag: 'wx' });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
assert.ifError(result.error);
assert.equal(result.status, 0, `Admin activation fixture failed: ${log}`);
console.log(JSON.stringify({ fixture: 'pricing-activation-engineering', completed: true, log,
  database, isolated: true, subgroup: 'existing-native-admin', productionWrites: 0, paidRequests: 0, browserRuns: 0 }));
