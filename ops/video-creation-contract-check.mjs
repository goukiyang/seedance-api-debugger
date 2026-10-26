import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync } from 'node:fs';

// This is an offline build gate. The child binds its receipt to the actual helpers.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (!args.length) {
  const scratch = path.join(root, '.role-tests'); mkdirSync(scratch, { recursive: true, mode: 0o700 });
  args.push(path.join(mkdtempSync(path.join(scratch, 'video-creation-')), 'receipt.json'));
}
const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/video-creation-contract-engineering.ts', ...args], {
  cwd: root, env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: 'file:/nonexistent/video-creation-build-gate.db' }, stdio: 'inherit',
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
