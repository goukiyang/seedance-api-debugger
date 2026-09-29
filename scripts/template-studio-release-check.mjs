import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function run(name, command, args, env = {}) {
  process.stdout.write(`\n[template-studio] ${name}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  const passed = result.status === 0;
  results.push({ name, passed, exitCode: result.status, error: result.error?.message });
  return passed;
}
const bin = (name) => path.join(root, 'node_modules', '.bin', name);
const prisma = bin('prisma');
const temporary = mkdtempSync('/tmp/sd2-template-studio-test-');
const isolated = { DATABASE_URL: `file:${path.join(temporary, 'build.db')}` };
function initializeDatabase(name, env) {
  const databasePath = env.DATABASE_URL.slice('file:'.length);
  closeSync(openSync(databasePath, 'a', 0o600));
  return run(name, prisma, ['db', 'push', '--skip-generate'], env);
}

run('prisma validate', prisma, ['validate'], isolated);
run('typecheck', bin('tsc'), ['--noEmit', '--pretty', 'false'], isolated);
run('lint', 'npm', ['run', 'lint'], isolated);
for (const script of [
  'template-llm-contract-smoke.ts',
  'template-bound-image-upload-smoke.ts',
  'template-card-final-context-smoke.ts',
  'seedance-draft-upgrade-smoke.ts',
  'banana-image-channel-smoke.ts',
]) {
  run(script, process.execPath, ['--import', 'tsx', path.join('scripts', script)], isolated);
}
// Each integration suite owns a disposable database, never the inherited URL.
for (const script of ['template-studio-contract-smoke.ts', 'template-studio-flow-smoke.ts']) {
  const env = { DATABASE_URL: `file:/tmp/${path.basename(temporary)}-${script}.db` };
  if (initializeDatabase(`initialize ${script}`, env)) {
    run(script, process.execPath, ['--import', 'tsx', path.join('scripts', script)], env);
  }
}
const imageDirectory = mkdtempSync('/tmp/sd2-image-studio-test-');
const imageEnv = { DATABASE_URL: `file:${path.join(imageDirectory, 'regression.db')}` };
if (initializeDatabase('initialize image regression', imageEnv)) {
  run('image-studio-integration-smoke.ts', process.execPath,
    ['--import', 'tsx', 'scripts/image-studio-integration-smoke.ts'], imageEnv);
}
if (initializeDatabase('initialize build database', isolated)) {
  const built = run('production build', 'npm', ['run', 'build'], isolated);
  if (built) {
    run('template-studio-http-smoke.ts', process.execPath,
      ['--import', 'tsx', 'scripts/template-studio-http-smoke.ts'], isolated);
    run('template-studio-browser-smoke.ts', process.execPath,
      ['--import', 'tsx', 'scripts/template-studio-browser-smoke.ts'], isolated);
  }
}
process.stdout.write(`\n${JSON.stringify({ results, isolatedDirectory: temporary }, null, 2)}\n`);
process.exitCode = results.every((result) => result.passed) ? 0 : 1;
