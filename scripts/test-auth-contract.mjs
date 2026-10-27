import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const require = createRequire(import.meta.url);
const parent = path.join(root, '.role-tests');
mkdirSync(parent, { recursive: true });
const fixture = mkdtempSync(path.join(parent, 'audit-auth-'));
new DatabaseSync(path.join(fixture, 'contract.db')).close();
const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: `file:${fixture}/contract.db`, AUTH_TEST_PHASE: 'integrated',
  SELF_REGISTRATION_ENABLED: 'true' };
for (const args of [
  [require.resolve('prisma/build/index.js'), 'generate'],
  [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate'],
  ['--import', 'tsx', 'scripts/test-audit-auth.ts'],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    process.exitCode = 1;
    break;
  }
}
console.log(`Synthetic auth evidence: ${fixture}`);
