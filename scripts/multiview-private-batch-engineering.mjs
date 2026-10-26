import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MULTIVIEW_PRIVATE_FIXTURE_SOURCES } from './multiview-private-fixture-inputs.mjs';

export const MULTIVIEW_PRIVATE_BATCH_SOURCES = [...new Set([
  ...MULTIVIEW_PRIVATE_FIXTURE_SOURCES,
  'scripts/multiview-private-batch-engineering.mjs',
  'scripts/install-multiview-private-recipe.ts',
  'scripts/multiview-private-recipe-install-engineering.ts',
  'scripts/multiview-preset-engineering.ts',
  'src/app/api/admin/multiview/preset/route.ts',
  'scripts/multiview-private-query-engineering.ts',
  'src/lib/provider/video-task-status.ts',
  'src/lib/provider/create-diagnostic.ts',
  'scripts/backup-multiview-works.py',
  'scripts/backup-multiview-private-engineering.py',
  'ops/sd2-multiview-works-start.mjs',
  'scripts/multiview-works-start-engineering.mjs',
  'scripts/process-multiview-works.ts',
  'src/lib/video/multiview-works-runtime.ts',
  'scripts/multiview-works-runtime-engineering.ts',
])];

function run() {
  const root = realpathSync(process.cwd());
  const startedAt = Date.now();
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const hashes = () => Object.fromEntries(MULTIVIEW_PRIVATE_BATCH_SOURCES.map(file => [file, hash(readFileSync(path.join(root, file)))]));
  const sourceSha256 = hashes();
  const scratch = path.join(root, '.role-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'multiview-private-batch-'));
  const privacyReceipt = path.join(directory, 'privacy.json');
  const startupReceipt = path.join(directory, 'works-start.json');
  const queryReceipt = path.join(directory, 'query.json');
  const cases = [
    { check: 'private_task_positive_projection_and_all_registered_sinks', file: 'scripts/multiview-private-engineering.ts',
      command: process.execPath, args: ['--import', 'tsx', 'scripts/multiview-private-engineering.ts', privacyReceipt], kind: 'privacy' },
    { check: 'private_install_plan_verify_original_receipt_and_reader_admission', file: 'scripts/multiview-private-recipe-install-engineering.ts',
      command: process.execPath, args: ['--import', 'tsx', 'scripts/multiview-private-recipe-install-engineering.ts'], kind: 'installer' },
    { check: 'private_snapshot_recipe_output_history_and_isolated_restore', file: 'scripts/backup-multiview-private-engineering.py',
      command: 'python3', args: ['scripts/backup-multiview-private-engineering.py'], kind: 'backup' },
    { check: 'private_works_exact_pair_startup_and_fixed_build_alias', file: 'scripts/multiview-works-start-engineering.mjs',
      command: process.execPath, args: ['scripts/multiview-works-start-engineering.mjs', startupReceipt], kind: 'startup' },
    { check: 'private_works_real_lock_heartbeat_and_natural_stop', file: 'scripts/multiview-works-runtime-engineering.ts',
      command: process.execPath, args: ['--import', 'tsx', 'scripts/multiview-works-runtime-engineering.ts'], kind: 'runtime' },
    { check: 'private_admin_real_session_cas_receipt_and_frozen_recipe', file: 'scripts/multiview-preset-engineering.ts',
      command: process.execPath, args: ['--import', 'tsx', 'scripts/multiview-preset-engineering.ts'], kind: 'preset' },
    { check: 'private_provider_query_logs_and_original_status_result_billing', file: 'scripts/multiview-private-query-engineering.ts',
      command: process.execPath, args: ['--import', 'tsx', 'scripts/multiview-private-query-engineering.ts', queryReceipt], kind: 'query' },
  ];
  const env = { ...process.env, NODE_ENV: 'test' };
  delete env.DATABASE_URL;
  const outcomes = cases.map(item => {
    const result = spawnSync(item.command, item.args, { cwd: root, env, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    const log = path.join(directory, path.basename(item.file) + '.log');
    writeFileSync(log, (result.stdout || '') + (result.stderr || ''), { flag: 'wx', mode: 0o600 });
    let failure = null, receipt = null, receiptSha256 = null;
    try {
      assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, item.check);
      if (item.kind !== 'backup') {
        if (item.kind === 'privacy') receipt = privacyReceipt;
        else if (item.kind === 'startup') receipt = startupReceipt;
        else if (item.kind === 'runtime') {
          const found = (result.stdout || '').split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
          assert.equal(found.length, 1, 'Exactly one runtime completion record is required');
          assert.equal(found[0].schema, 'isolated-multiview-works-runtime.v1');
          assert.equal(found[0].completed, true); receipt = found[0].evidencePath;
        } else {
          const prefix = item.kind === 'preset' ? 'MV-PROMPT engineering receipt: '
            : item.kind === 'query' ? 'Multiview private query engineering receipt: '
              : 'Multiview private installer engineering receipt: ';
          const found = (result.stdout || '').split(/\r?\n/).filter(line => line.startsWith(prefix));
          assert.equal(found.length, 1, 'Exactly one installer completion receipt is required');
          receipt = found[0].slice(prefix.length);
        }
        assert.ok(path.isAbsolute(receipt) && receipt.startsWith(scratch + path.sep));
        const stat = lstatSync(receipt);
        assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && !(stat.mode & 0o077));
        const bytes = readFileSync(receipt), value = JSON.parse(bytes);
        receiptSha256 = hash(bytes);
        const schemas = { privacy: 'multiview-private-engineering.v1', installer: 'multiview-private-install-engineering.v1',
          startup: 'multiview-works-start-engineering.v1', runtime: 'isolated-multiview-works-runtime.v1',
          preset: 'mv-prompt-engineering.v1', query: 'multiview-private-query-engineering.v1' };
        assert.equal(value.schema, schemas[item.kind]); assert.equal(value.completed, true);
        if (item.kind === 'runtime') {
          assert.equal(value.production, false); assert.equal(value.workConsumed, 0); assert.equal(value.providerCalls, 0);
        } else { assert.equal(value.synthetic, true); assert.equal(value.productionWrites, 0); }
        assert.ok(Array.isArray(value.checks) && value.checks.length > 0);
        if (item.kind === 'privacy' || item.kind === 'startup') {
          assert.equal(value.applicationDatabaseOpened, false);
          for (const key of ['forbiddenCalls', 'paidRequests', 'browserRuns']) assert.equal(value[key], 0);
          const sources = item.kind === 'privacy' ? MULTIVIEW_PRIVATE_FIXTURE_SOURCES
            : ['ops/sd2-multiview-works-start.mjs', 'scripts/multiview-works-start-engineering.mjs'];
          for (const file of sources) assert.equal(value.sourceSha256?.[file], sourceSha256[file]);
        } else assert.equal(value.providerCalls, 0);
      } else {
        assert.match(result.stderr || '', /Ran [1-9]\d* tests?/);
        assert.match(result.stderr || '', /\bOK\b/);
      }
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    return { check: item.check, file: item.file, completed: failure === null, exitCode: result.status,
      signal: result.signal, log, logSha256: hash(readFileSync(log)), receipt, receiptSha256, failure };
  });
  assert.deepEqual(hashes(), sourceSha256, 'Private multiview source changed during the unified engineering batch');
  const completed = outcomes.every(item => item.completed);
  const receipt = process.argv[2] || path.join(directory, completed ? 'receipt.json' : 'failure.json');
  assert.ok(path.resolve(receipt).startsWith(scratch + path.sep));
  writeFileSync(receipt, JSON.stringify({ schema: 'multiview-private-batch-engineering.v1',
    runId: process.env.IMAGE_RECOVERY_GATE_RUN_ID, candidateRoot: root, startedAt, finishedAt: Date.now(),
    completed, synthetic: true, applicationDatabaseOpened: false, productionWrites: 0,
    forbiddenCalls: 0, paidRequests: 0, browserRuns: 0, checks: cases.map(item => item.check), sourceSha256, outcomes,
  }, null, 2), { flag: 'wx', mode: 0o600 });
  assert.equal(completed, true, 'Private multiview engineering batch failed: ' + receipt);
  console.log('Multiview private batch engineering receipt: ' + receipt);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) run();
