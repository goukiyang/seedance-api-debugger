import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readPricingFixtureInputs } from './pricing-fixture-input.mjs';

// The build and the protected release controller use the same offline gate.
// No application database, credentials, provider or browser is accepted here.
const root = realpathSync(process.cwd());
const entry = 'scripts/check-image-recovery.mjs';
const command = `node ${entry}`;
const recoveryChecks = [
  'isolated_creation_first_counterexample_repeats_old_task_after_two_slow_queries',
  'real_recovery_rotates_seven_expired_leases_preserves_unknowns_then_original_get_decodes_publishes_and_settles_once',
  'equal_expired_deadline_orders_created_at_then_id_and_does_not_claim_live_lease',
  'real_sqlite_competing_claim_loses_cas_without_query_refund_repost_or_duplicate_settlement',
  'original_poll_diagnostics_are_bounded_factual_and_private',
];
const dispatchChecks = [
  'blocked_prefix_suffix_reached',
  'bounded_sweep_revisits_unlocked_items_with_continuous_tail',
  'captured_cursor_survives_move_and_delete',
  'cold_start_and_wrap_are_safe',
  'candidate_exception_does_not_pin_scan',
  'original_identity_cas_admission_and_credits_preserved',
];
const asyncRecoveryChecks = [
  'explicit_provider_states_release_without_refund',
  'owner_shared_capacity_includes_synchronous_running',
  'expiry_timeout_and_non_summary_404_do_not_release',
  'two_independent_original_summary_404_observations',
  'original_get_delivers_once_preserving_frozen_identity',
  'durable_claim_cas_restart_and_bounded_fair_scan',
  'manual_once_after_auto_budget_keeps_limits',
  'legacy_identity_and_partial_checkpoint_fail_closed',
];
const dimensionMismatchChecks = [
  'fresh_mismatch_retains_viewable_asset_refunds_once',
  'native_mismatch_preserves_original_uncertain_refund_policy',
  'late_mismatch_retains_image_without_billing_decision_or_repeat_query',
  'publication_failure_resumes_private_original_without_provider',
  'decoded_format_mismatch_keeps_original_mime_bytes_and_original_billing_policy',
  'settled_backfill_idempotent_hidden_by_default_exact_visibility_cas',
  'normal_actions_follow_owner_source_permissions_not_size_status',
  'plain_failure_corrupt_or_unproven_output_stays_unavailable',
];
const fixtures = [
  { file: 'scripts/image-studio-recovery-fairness-engineering.ts', schema: 'image-recovery-fairness-engineering.v1',
    marker: 'Image recovery fairness engineering receipt: ', checks: recoveryChecks,
    sources: ['src/lib/image-studio/worker.ts', 'src/lib/image-studio/provider.ts'] },
  { file: 'scripts/image-dispatch-fairness-engineering.ts', schema: 'image-dispatch-fairness-engineering.v1',
    marker: 'Image dispatch fairness engineering receipt: ', checks: dispatchChecks,
    sources: ['src/lib/image-studio/batches.ts', 'src/lib/tools/toolflow-runtime.ts', 'src/lib/image-studio/queue-capacity.ts'] },
  { file: 'scripts/image-async-recovery-engineering.ts', schema: 'image-async-recovery-engineering.v1',
    marker: 'Image async recovery engineering receipt: ', checks: asyncRecoveryChecks,
    sources: ['src/lib/image-studio/worker.ts', 'src/lib/image-studio/provider.ts', 'src/lib/image-studio/tasks.ts',
      'src/lib/image-studio/async-recovery.ts', 'src/lib/image-studio/delivery.ts', 'src/lib/image-studio/queue-capacity.ts',
      'src/lib/image-studio/synchronous-admission.ts', 'src/app/api/image-studio/tasks/route.ts'] },
  { file: 'scripts/image-dimension-mismatch-engineering.ts', schema: 'image-dimension-mismatch-engineering.v1',
    marker: 'Image dimension mismatch engineering receipt: ', checks: dimensionMismatchChecks,
    sources: ['src/lib/image-studio/dimension-rejection.ts', 'src/lib/image-studio/dimension-mismatch.ts',
      'src/lib/image-studio/tasks.ts', 'src/lib/image-studio/output.ts', 'src/lib/image-studio/delivery.ts',
      'src/app/api/image-studio/assets/[assetId]/route.ts', 'src/app/api/image-studio/download/route.ts',
      'src/app/image-studio/studio.tsx', 'src/components/GeneratedImageResults.tsx', 'src/lib/image-studio/worker.ts',
      'src/app/api/image-studio/upload-access/route.ts', 'src/lib/image-studio/input-main.ts', 'src/lib/image-studio/result-pins.ts',
      'src/lib/image-studio/result-feed.ts', 'src/lib/image-studio/result-attention.ts', 'src/lib/image-studio/viewer-receipts.ts',
      'src/lib/image-result-next/server.ts', 'src/lib/assets/generation-origin.ts', 'src/lib/image-studio/modules.ts',
      'src/lib/image-studio/batches.ts', 'src/lib/image-studio/batch-contract.ts', 'src/app/image-studio/batch-results.tsx',
      'src/app/api/assets/picker/route.ts', 'src/app/api/assets/library/route.ts', 'src/lib/avatar-random/service.ts',
      'src/lib/avatar-random/handoff.ts', 'src/lib/canvas-roles/media.ts', 'src/lib/canvas-roles/media-bindings.ts',
      'src/app/api/avatar-studio/route.ts', 'src/app/tools/avatar-studio/studio.tsx', 'src/app/story-studio/story-studio.tsx'] },
  { file: 'scripts/upload-recovery-engineering.mjs', schema: 'upload-recovery-engineering.v1',
    marker: 'Upload recovery engineering receipt: ', checks: ['private_directory_secure_alias', 'raw_nonce_preflight_history',
      'client_per_file_recovery', 'upload_entry_contracts_preserved'], sources: [
      'scripts/upload-private-directory-engineering.ts', 'scripts/upload-client-recovery-engineering.ts',
      'scripts/upload-raw-recovery-engineering.mjs', 'scripts/upload-root-cure-smoke.ts',
      'src/lib/assets/verified-upload.ts', 'src/lib/assets/raw-upload-state.ts', 'src/lib/assets/upload-log.ts',
      'src/lib/assets/storage.ts', 'src/lib/assets/site-upload.ts', 'src/lib/http/file-upload.ts',
      'src/lib/http/upload-session.ts', 'src/components/ResourceLibraryPicker.tsx',
      'src/components/ResourceLibraryPicker.module.css', 'src/app/api/assets/upload/route.ts',
      'src/app/api/assets/upload-complete/route.ts', 'src/app/api/assets/multipart/complete/route.ts',
    ] },
];
const pricingGate = 'scripts/check-pricing-policy.mjs';
const sourceFiles = ['package.json', entry, pricingGate, ...fixtures.flatMap(fixture => [fixture.file, ...fixture.sources])];
const hash = value => createHash('sha256').update(value).digest('hex');
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, hash(readFileSync(path.join(root, file)))]));
const time = value => typeof value === 'number' ? value : Date.parse(value);

function assertConfig(candidate = root) {
  assert.equal(realpathSync(candidate), root, 'Gate must run in the exact candidate root');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts?.prebuild, command, 'Candidate is missing the mandatory image recovery prebuild gate');
  assert.equal(pkg.scripts?.['test:image-recovery'], command, 'Manual and build gates must use the same entry');
  assert.equal(pkg.scripts?.build, 'next build', 'Unexpected build contract');
  hashes(); // Missing fixtures or production modules must fail before npm starts.
}

function readPrivateReceipt(file, maximumBytes = 131072) {
  assert.equal(typeof file, 'string');
  const absolute = path.resolve(file);
  const scratch = path.join(root, '.role-tests');
  assert.ok(absolute.startsWith(scratch + path.sep), 'Receipt must belong to this candidate');
  assert.equal(realpathSync(absolute), absolute, 'Receipt symlinks are not accepted');
  const stat = lstatSync(absolute);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= maximumBytes);
  assert.equal(stat.mode & 0o077, 0, 'Receipt must be private');
  if (typeof process.getuid === 'function') assert.equal(stat.uid, process.getuid());
  const bytes = readFileSync(absolute);
  return { value: JSON.parse(bytes.toString('utf8')), sha256: hash(bytes) };
}

function validateFixture(fixture, file, runId, startedAt, finishedAt, sourceSha256) {
  const receipt = readPrivateReceipt(file);
  const value = receipt.value;
  assert.equal(value.schema, fixture.schema);
  assert.equal(value.synthetic, true);
  assert.equal(value.runId, runId, 'Stale or unrelated engineering receipt');
  assert.equal(value.completed, true, 'Engineering process did not finish all assertions');
  for (const key of ['forbiddenCalls', 'productionWrites', 'paidRequests', 'browserRuns']) assert.equal(value[key], 0, key);
  assert.ok(time(value.startedAt) >= startedAt && time(value.finishedAt) >= time(value.startedAt)
    && time(value.finishedAt) <= finishedAt + 1000, 'Engineering receipt time does not match this run');
  assert.equal(value.fixtureSha256, sourceSha256[fixture.file]);
  assert.ok(Array.isArray(value.checks) && value.checks.length > 0 && new Set(value.checks).size === value.checks.length);
  if (fixture.checks) assert.deepEqual(value.checks, fixture.checks);
  for (const source of fixture.sources) {
    const recorded = value.sourceSha256?.[source] ?? (source === 'src/lib/image-studio/worker.ts' ? value.workerSha256
      : source === 'src/lib/image-studio/provider.ts' ? value.providerSha256 : undefined);
    assert.equal(recorded, sourceSha256[source], 'Engineering receipt does not cover the candidate module');
  }
  if (fixture.schema === 'image-recovery-fairness-engineering.v1') {
    assert.deepEqual(value.selected, ['old-a', 'old-b', 'new-a', 'new-b', 'new-c', 'new-d', 'new-e', 'tie-z', 'tie-a', 'tie-b', 'race']);
    assert.equal(value.queries?.length, 18);
    assert.ok(value.queries.every(query => /^provider-(?:old-[ab]|new-[a-e]|tie-[abz])$/.test(query.providerTaskId)
      && ['summary', 'result'].includes(query.view)));
  } else if (fixture.schema === 'image-dispatch-fairness-engineering.v1') {
    assert.equal(value.mode, 'verify');
    for (const kind of ['batch', 'toolflow']) {
      const summary = value.summary?.[kind];
      assert.ok(summary && summary.prefixCount > 10 && summary.calls > 0);
      assert.ok(summary.maxCandidateQueriesPerCall <= 2 && summary.maxCandidateChecksPerCall <= 10
        && summary.maxLoadedPerQuery <= 32);
      for (const key of ['suffixReachedAtCall', 'unlockedReachedAtCall']) assert.ok(summary[key] > 0 && summary[key] <= summary.calls);
      for (const key of ['cursorMoveAndDeleteSurvived', 'exceptionBypassed', 'coldStartSafe']) assert.equal(summary[key], true, key);
    }
  } else if (fixture.schema === 'image-async-recovery-engineering.v1') {
    assert.equal(value.mode, 'verify', 'An old-source counterexample is not a completed candidate check');
  }
  return receipt.sha256;
}

function verify(file, since) {
  assertConfig();
  assert.ok(Number.isFinite(since) && since > 0, 'A real npm start time is required');
  const { value } = readPrivateReceipt(file);
  assert.equal(value.schema, 'image-recovery-build-gate.v1');
  assert.match(value.runId, /^[0-9a-f-]{36}$/);
  assert.equal(value.completed, true);
  assert.equal(value.candidateRoot, root);
  assert.ok(value.startedAt >= since && value.finishedAt >= value.startedAt && value.finishedAt <= Date.now() + 1000);
  assert.ok(Date.now() - value.startedAt <= 30 * 60_000, 'Build gate receipt is stale');
  assert.deepEqual(value.sourceSha256, hashes(), 'Candidate source changed after the gate ran');
  assert.equal(value.fixtures?.length, fixtures.length);
  assert.equal(typeof value.pricingReceipt, 'string', 'Pricing contracts were not run by this prebuild');
  assert.equal(readPrivateReceipt(value.pricingReceipt, 8 * 1024 * 1024).value.runId, value.runId, 'Image and pricing gates belong to different runs');
  const pricing = spawnSync(process.execPath, [pricingGate, '--verify', value.pricingReceipt, '--since', String(since)], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.ifError(pricing.error);
  assert.equal(pricing.status, 0, (pricing.stderr || '') + (pricing.stdout || ''));
  for (let i = 0; i < fixtures.length; i++) {
    const recorded = value.fixtures[i];
    assert.equal(recorded.file, fixtures[i].file);
    assert.equal(validateFixture(fixtures[i], recorded.receipt, value.runId, value.startedAt, value.finishedAt,
      value.sourceSha256), recorded.sha256);
  }
  console.log('Image recovery build gate verified');
}

function run() {
  assertConfig();
  const startedAt = Date.now();
  const runId = readPricingFixtureInputs(root).runId;
  const sourceSha256 = hashes();
  const scratch = path.join(root, '.role-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'image-recovery-gate-'));
  const recorded = [], failures = [], outcomes = [];
  for (const fixture of fixtures) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, fixture.file)], {
      cwd: root, env: { ...process.env, IMAGE_RECOVERY_GATE_RUN_ID: runId },
      encoding: 'utf8', timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
    });
    // Preserve actual child evidence, including a nonzero exit, without accepting
    // an empty successful wrapper as a completed test.
    const log = path.join(directory, `${path.basename(fixture.file)}.log`);
    writeFileSync(log, (result.stdout || '') + (result.stderr || ''), { mode: 0o600, flag: 'wx' });
    try {
      assert.ifError(result.error);
      assert.equal(result.signal, null, 'Engineering process was interrupted');
      assert.equal(result.status, 0, `Engineering process failed: ${fixture.file}`);
      const lines = (result.stdout || '').split(/\r?\n/).filter(line => line.startsWith(fixture.marker));
      assert.equal(lines.length, 1, 'A unique completed engineering receipt is required');
      const receipt = lines[0].slice(fixture.marker.length);
      const sha256 = validateFixture(fixture, receipt, runId, startedAt, Date.now(), sourceSha256);
      recorded.push({ file: fixture.file, receipt, sha256 });
      outcomes.push({ file: fixture.file, completed: true, log });
      console.log(`Image recovery engineering complete: ${fixture.file}`);
    } catch (error) {
      failures.push({ file: fixture.file, category: result.error || result.signal || result.status !== 0 ? 'execution' : 'contract',
        message: error instanceof Error ? error.message : String(error), log, status: result.status, signal: result.signal });
      outcomes.push({ file: fixture.file, completed: false, log });
    }
  }
  const pricing = spawnSync(process.execPath, [pricingGate], { cwd: root, env: process.env,
    encoding: 'utf8', timeout: 660000, maxBuffer: 4 * 1024 * 1024 });
  const pricingLog = path.join(directory, 'pricing-policy-gate.log');
  writeFileSync(pricingLog, (pricing.stdout || '') + (pricing.stderr || ''), { mode: 0o600, flag: 'wx' });
  let pricingReceipt;
  try {
    assert.ifError(pricing.error);
    assert.equal(pricing.signal, null);
    assert.equal(pricing.status, 0, `Pricing contract gate failed; see ${pricingLog}`);
    const pricingLines = (pricing.stdout || '').split(/\r?\n/).filter(line => line.startsWith('PRICING_POLICY_GATE_RECEIPT='));
    assert.equal(pricingLines.length, 1, 'Pricing gate did not return one completed receipt');
    pricingReceipt = pricingLines[0].slice('PRICING_POLICY_GATE_RECEIPT='.length);
    outcomes.push({ file: pricingGate, completed: true, log: pricingLog });
  } catch (error) {
    failures.push({ file: pricingGate, category: 'pricing', message: error instanceof Error ? error.message : String(error),
      log: pricingLog, status: pricing.status, signal: pricing.signal });
    outcomes.push({ file: pricingGate, completed: false, log: pricingLog });
  }
  try { assert.deepEqual(hashes(), sourceSha256, 'Candidate source changed during the gate'); }
  catch (error) { failures.push({ file: entry, category: 'integrity', message: error instanceof Error ? error.message : String(error) }); }
  if (failures.length) {
    const failureReport = path.join(directory, 'failure-report.json');
    writeFileSync(failureReport, JSON.stringify({ schema: 'image-recovery-build-failure.v1', completed: false,
      runId, candidateRoot: root, startedAt, finishedAt: Date.now(), sourceSha256, outcomes, failures,
      partialReceipts: recorded, pricingReceipt: pricingReceipt || null }, null, 2), { mode: 0o600, flag: 'wx' });
    console.error(`Image recovery build failure report: ${failureReport}`);
    process.exitCode = 1;
    return;
  }
  const receipt = path.join(directory, 'receipt.json');
  writeFileSync(receipt, JSON.stringify({ schema: 'image-recovery-build-gate.v1', runId, candidateRoot: root,
    startedAt, finishedAt: Date.now(), sourceSha256, fixtures: recorded, pricingReceipt, completed: true }, null, 2), { mode: 0o600, flag: 'wx' });
  verify(receipt, startedAt);
  console.log(`PRICING_POLICY_GATE_RECEIPT=${pricingReceipt}`);
  console.log(`IMAGE_RECOVERY_GATE_RECEIPT=${receipt}`);
}

try {
  if (process.argv[2] === '--assert-config' && process.argv.length <= 4) assertConfig(process.argv[3]);
  else if (process.argv[2] === '--verify' && process.argv[4] === '--since' && process.argv.length === 6) verify(process.argv[3], Number(process.argv[5]));
  else { assert.equal(process.argv.length, 2, 'Unknown gate arguments'); run(); }
} catch (error) {
  console.error('Image recovery build gate rejected:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
