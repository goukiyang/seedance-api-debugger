'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const root = process.cwd();
const privateEvidence = '/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-08-ai-collaboration-workflow/role-implementation';
const scratch = path.join(root, '.role-tests'); fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
const directory = fs.mkdtempSync(path.join(scratch, 'verify-'));
const checks = [];
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
Object.assign(env, { NEXT_TELEMETRY_DISABLED: '1', PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' });
for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  if (fs.existsSync(path.join(root, file))) throw new Error('Verify refuses private environment files: ' + file);
}
function run(name, command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd || root, env: { ...env, ...options.env }, encoding: 'utf8',
    timeout: options.timeout || 240000, maxBuffer: 24 * 1024 * 1024 });
  const output = (result.stdout || '') + (result.stderr || '') + (result.error ? '\n' + result.error.message : '');
  const log = path.join(directory, name + '.log'); fs.writeFileSync(log, output, { mode: 0o600 });
  const check = { name, command: [command, ...args], exitCode: result.status, passed: result.status === 0 && !result.error, log };
  checks.push(check); console.log((check.passed ? 'PASS ' : 'FAIL ') + name + ': ' + log);
  return { ...check, output };
}
const tsx = script => [path.join(root, 'node_modules/tsx/dist/cli.mjs'), script];
const node = process.execPath;
const jsFiles = ['app.js', 'backend-contract.js', 'canvas-commands.js', 'canvas-engine.js', 'icons.js', 'role-creator.js', 'role-workflow.js'];
for (const file of jsFiles) run('syntax-' + file.replace('.js', ''), node, ['--check', 'public/tools/ultimate-canvas/' + file]);
for (const file of ['role-c1-ui-serve.cjs', 'role-c1-ui-network-block.cjs', 'role-c1-api-smoke.cjs']) run('syntax-' + file.replace('.cjs', ''), node, ['--check', 'scripts/' + file]);
run('core-regression', node, tsx('scripts/role-c1-core-contract-smoke.ts'));
run('isolated-contract', node, tsx('scripts/role-c1-isolated-smoke.ts'));
run('additive-old-writer', node, tsx('scripts/role-c1-additive-smoke.ts'));
run('locked-ddl-script', 'python3', ['scripts/role-c1-ddl-script-smoke.py', path.join(privateEvidence, 'apply-role-ddl.py')]);
run('complete-typecheck', node, ['node_modules/typescript/bin/tsc', '--noEmit', '--pretty', 'false']);
const guard = run('guard-runtime', node, tsx('scripts/role-c1-guard-smoke.ts'));
const guardReceiptPath = guard.output.match(/Evidence: (.+guard-receipt\.json)/)?.[1]?.trim();
const fixture = run('actual-ui-fixture', node, tsx('scripts/role-c1-ui-fixture.ts'));
let fixturePath;
for (const line of fixture.output.split('\n')) {
  try { const row = JSON.parse(line); if (typeof row.fixturePath === 'string') fixturePath = row.fixturePath; } catch {}
}
const networkGuard = '--require=' + path.join(root, 'scripts/role-c1-ui-network-block.cjs');
if (fixture.passed && fixturePath) {
  const data = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const buildEnv = { DATABASE_URL: data.databaseUrl, SESSION_SECRET: data.sessionSecret, NODE_OPTIONS: networkGuard,
    NEXT_DIST_DIR: '.next-prod-candidate', NODE_ENV: 'production' };
  const build = run('candidate-build', node, ['node_modules/next/dist/bin/next', 'build'], { env: buildEnv, timeout: 1200000 });
  if (guard.passed && guardReceiptPath) {
    const receipt = JSON.parse(fs.readFileSync(guardReceiptPath, 'utf8'));
    const guarded = run('guard-build', node, [path.join(root, 'node_modules/next/dist/bin/next'), 'build'], {
      cwd: receipt.directory, env: { ...buildEnv, NEXT_DIST_DIR: '.next-role-guard' }, timeout: 1200000 });
    receipt.guardBuildVerified = guarded.passed;
    if (guarded.passed) receipt.guardBuildId = fs.readFileSync(path.join(receipt.directory, '.next-role-guard/BUILD_ID'), 'utf8').trim();
    receipt.guardBuildDependencyNote = 'Exact ea7 source with schema3-only guard; reused installed candidate dependency runtime, not server original BUILD protection.';
    fs.writeFileSync(guardReceiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  }
  if (build.passed) run('actual-next-api', node, ['scripts/role-c1-api-smoke.cjs', fixturePath, '3327'], { timeout: 240000 });
  else checks.push({ name: 'actual-next-api', passed: false, skipped: 'Candidate build failed; no service started' });
} else checks.push({ name: 'candidate-build-and-api', passed: false, skipped: 'Synthetic fixture preparation failed or returned no fixture path' });
const tracked = spawnSync('git', ['diff', '--name-only'], { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n')
  .filter(file => /^(src\/|public\/tools\/ultimate-canvas\/|scripts\/role-c1-|prisma\/migrations\/)/.test(file));
const sourceHashes = Object.fromEntries([...new Set([...tracked, ...untracked])].filter(file => fs.existsSync(file))
  .map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const result = { phase: 'Verify', version: require('../package.json').version, directory, checks, fixturePath, guardReceiptPath,
  sourceHashes, productionWrites: 0, realProviderCalls: 0, browserRuns: 0, allPassed: checks.every(c => c.passed),
  note: 'Browser-free isolated engineering/API batch, not production functionality or paid AI acceptance.' };
const receipt = path.join(directory, 'verify-receipt.json'); fs.writeFileSync(receipt, JSON.stringify(result, null, 2), { mode: 0o600 });
console.log('Verify receipt: ' + receipt);
process.exitCode = result.allPassed ? 0 : 1;
