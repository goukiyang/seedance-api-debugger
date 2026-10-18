import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
const outputSpecificationChecks = [
  'new_2k_reference_and_all_standard_ratios_keep_pixel_budget',
  'four_extreme_2k_ratios_fit_real_domain_and_4k_conflicts_reject',
  'explicit_native_halfk_and_legacy_sizes_are_preserved',
  'saved_version_and_public_plan_are_strict_and_private',
  'new_and_legacy_wire_serialization_use_the_frozen_plan',
  'old_request_key_returns_original_without_repricing_or_writing',
  'fixed_and_actual_quote_plan_hashes_reject_legacy_or_changed_authorization',
  'old_parent_prepared_and_unprepared_items_keep_legacy_after_restart',
  'new_batch_auto_is_resolved_independently_for_each_source',
  'saved_avatar_plan_keeps_legacy_quote_without_new_reservation',
  'new_writer_requires_current_worker_and_helper_only_changes_reject',
  'legacy_synchronous_quote_uses_real_preparation_branch_without_post_or_writes',
  'toolflow_new_known_and_future_auto_freeze_actual_plans_and_reject_old_quote_or_changed_inputs',
  'toolflow_legacy_prepared_and_unprepared_runs_keep_frozen_sizes_without_migration',
  'toolflow_unknown_task_blocks_retry_and_redispatch_without_another_freeze_or_post',
  'canvas_fixed_ordinary_and_style_keep_plan_quote_token_and_original_confirmation_count',
  'canvas_actual_original_confirmation_and_max_authorization_are_unchanged',
  'canvas_role_context_and_unknown_job_identity_survive_query_only_reentry_without_repost',
  'versioned_batch_quote_canonical_keys_preserve_array_order_and_reject_changed_authorization',
  'toolflow_authenticated_frozen_channels_create_only_with_fresh_configuration_and_unchanged_quote_identity',
];
const providerContractChecks = [
  'gzip_deflate_brotli_decode_preserves_body_and_removes_stale_headers',
  'bad_stream_wire_decoded_limits_length_abort_and_timeout_reject',
  'retry_after_seconds_date_body_and_invalid_values_use_receive_clock',
  'long_202_wait_survives_observation_failure_without_early_get',
  'non_json_429_503_persist_header_wait_and_original_get_only',
  'core_partial_request_async_and_database_writes_repair_both_copies_after_restart',
  'core_owner_original_id_and_billing_identity_conflicts_fail_closed',
  'durable_wait_survives_restart_manual_check_and_local_backoff',
  'wait_beyond_auto_deadline_stops_without_spending_attempts_or_money',
  'old_v1_receipt_stays_readable_and_optional_diagnostics_are_private',
  'guard_accepted_only_requires_shared_drain_and_never_dispatches_new_work_or_global_billing',
  'active_wait_manual_original_check_requires_time_owner_lease_cas_and_single_consumption',
  'original_v3_202_restart_uses_same_get_identity_and_settles_once_without_repost',
  'original_v3_unknown_keeps_reservation_but_fresh_and_late_complete_mismatch_refund_once_and_keep_image',
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
  { file: 'scripts/image-output-specification-engineering.ts', schema: 'image-output-specification-engineering.v1',
    marker: 'Image output specification engineering receipt: ', checks: outputSpecificationChecks,
    negativeChecks: ['legacy_gcd_rejected_by_current_pixel_budget', 'legacy_batch_object_key_order_rejects_equivalent_submission',
      'toolflow_quote_hmac_and_fresh_context_reject_changed_intent'],
    sources: ['scripts/image-trace-engineering-fixture.ts', 'scripts/image-canvas-quote-fixture.ts', 'src/lib/image-generation/output-plan.ts',
      'src/lib/image-generation/resolution.ts', 'src/lib/image-studio/ratios.ts', 'src/lib/integrations/image-generation.ts',
      'src/lib/image-studio/tasks.ts', 'src/lib/image-studio/billing-quote.ts', 'src/lib/image-studio/billing-quote-service.ts',
      'src/lib/image-studio/billing-quote-store.ts', 'src/lib/image-studio/batch-billing-quote.ts', 'src/lib/template-studio/validation.ts',
      'src/lib/image-studio/batches.ts', 'src/lib/image-studio/batch-contract.ts', 'src/lib/image-studio/modules.ts', 'src/lib/avatar-random/service.ts',
      'src/app/api/assets/generate/route.ts', 'src/lib/image-studio/provider.ts',
      'src/lib/image-studio/shared-contract.ts', 'src/lib/image-studio/shared-types.ts', 'src/lib/image-studio/read-snapshot.ts',
      'src/lib/image-studio/worker.ts', 'src/lib/image-studio/async-recovery.ts', 'src/lib/image-studio/queue-capacity.ts',
      'src/lib/image-studio/provider-wait.ts', 'src/lib/image-studio/worker-mode.ts', 'src/lib/tools/toolflow-runtime.ts',
      'src/lib/tools/toolflow.ts', 'src/app/api/tools/ultimate-canvas/flows/[id]/quote/route.ts', 'public/tools/ultimate-canvas/toolflow-workflow.js',
      'public/tools/ultimate-canvas/canvas-styles.js', 'public/tools/ultimate-canvas/node-pricing.js', 'public/tools/ultimate-canvas/app.js'] },
  { file: 'scripts/image-provider-contract-engineering.ts', schema: 'image-provider-contract-engineering.v1',
    marker: 'Image provider contract engineering receipt: ', checks: providerContractChecks,
    negativeChecks: ['legacy_wait_schema_rejected', 'conflicting_core_accounting_copy_rejected'],
    sources: ['scripts/image-trace-engineering-fixture.ts', 'scripts/process-image-studio.ts', 'src/lib/image-studio/provider.ts',
      'src/lib/image-studio/provider-wait.ts', 'src/lib/image-studio/delivery.ts', 'src/lib/image-studio/async-recovery.ts',
      'src/lib/image-studio/worker.ts', 'src/lib/image-studio/worker-mode.ts', 'src/lib/image-studio/tasks.ts', 'src/lib/image-studio/response-diagnostics.ts',
      'src/lib/image-studio/response-evidence.ts', 'src/lib/image-generation/output-plan.ts',
      'src/lib/image-studio/dimension-rejection.ts', 'src/lib/image-studio/dimension-mismatch.ts', 'src/lib/image-studio/output.ts'] },
];
const actualVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const guardPackage = /\+trace03-guard\.\d+$/.test(actualVersion);
const packageView = { actualVersion, fixtureVersion: guardPackage ? actualVersion.replace(/\+trace03-guard\.\d+$/, '') : actualVersion,
  kind: guardPackage ? 'in-memory-ordinary' : 'actual', productionFilesChanged: false };
if (guardPackage) fixtures.push({ file: 'scripts/image-guard-admission-engineering.ts', schema: 'image-guard-admission-engineering.v1',
  marker: 'Image guard admission engineering receipt: ', checks: ['actual_guard_package_rejects_new_queue_admission',
    'guard_requires_env_and_shared_drain_and_only_recovers_accepted_without_global_billing'], actualGuard: true,
  sources: ['scripts/image-trace-engineering-fixture.ts', 'scripts/process-image-studio.ts', 'src/lib/image-studio/queue-capacity.ts', 'src/lib/image-studio/worker-mode.ts'] });
const sourceFiles = ['package.json', 'prisma/schema.prisma', entry, 'scripts/image-engineering-package-view.cjs',
  'scripts/image-guard-admission-engineering.ts', ...fixtures.flatMap(fixture => [fixture.file, ...fixture.sources])];
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

function readPrivateReceipt(file) {
  assert.equal(typeof file, 'string');
  const absolute = path.resolve(file);
  const scratch = path.join(root, '.role-tests');
  assert.ok(absolute.startsWith(scratch + path.sep), 'Receipt must belong to this candidate');
  assert.equal(realpathSync(absolute), absolute, 'Receipt symlinks are not accepted');
  const stat = lstatSync(absolute);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= 131072);
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
  if (fixture.negativeChecks) assert.deepEqual(value.negativeChecks, fixture.negativeChecks,
    'Engineering receipt did not complete its regression counterexamples');
  if (fixture.actualGuard) {
    assert.equal(value.actualGuardVersion, actualVersion);
    assert.equal(value.packageView, 'actual-guard-without-preload');
    assert.equal(value.engineeringPackageView, undefined);
  } else if (guardPackage && ['scripts/image-output-specification-engineering.ts', 'scripts/image-provider-contract-engineering.ts'].includes(fixture.file)) {
    assert.deepEqual(value.engineeringPackageView, packageView);
  }
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
  assert.deepEqual(value.packageView, packageView, 'Engineering package view does not describe this candidate');
  assert.equal(value.candidateRoot, root);
  assert.ok(value.startedAt >= since && value.finishedAt >= value.startedAt && value.finishedAt <= Date.now() + 1000);
  assert.ok(Date.now() - value.startedAt <= 30 * 60_000, 'Build gate receipt is stale');
  assert.deepEqual(value.sourceSha256, hashes(), 'Candidate source changed after the gate ran');
  assert.equal(value.fixtures?.length, fixtures.length);
  for (let i = 0; i < fixtures.length; i++) {
    const recorded = value.fixtures[i];
    assert.equal(recorded.file, fixtures[i].file);
    assert.deepEqual(recorded.packageView, fixtures[i].actualGuard
      ? { actualVersion, fixtureVersion: actualVersion, kind: 'actual-guard-without-preload', productionFilesChanged: false } : packageView);
    assert.equal(validateFixture(fixtures[i], recorded.receipt, value.runId, value.startedAt, value.finishedAt,
      value.sourceSha256), recorded.sha256);
  }
  console.log('Image recovery build gate verified');
}

function run() {
  assertConfig();
  const startedAt = Date.now();
  const runId = process.env.IMAGE_RECOVERY_GATE_RUN_ID || randomUUID();
  assert.match(runId, /^[0-9a-f-]{36}$/, 'An explicitly coordinated gate run must be a UUID');
  const sourceSha256 = hashes();
  const scratch = path.join(root, '.role-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'image-recovery-gate-'));
  const recorded = [];
  for (const fixture of fixtures) {
    const preload = guardPackage && !fixture.actualGuard ? ['--require', path.join(root, 'scripts/image-engineering-package-view.cjs')] : [];
    const result = spawnSync(process.execPath, [...preload, '--import', 'tsx', path.join(root, fixture.file)], {
      cwd: root, env: { ...process.env, IMAGE_RECOVERY_GATE_RUN_ID: runId },
      encoding: 'utf8', timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
    });
    // Preserve actual child evidence, including a nonzero exit, without accepting
    // an empty successful wrapper as a completed test.
    writeFileSync(path.join(directory, `${path.basename(fixture.file)}.log`), (result.stdout || '') + (result.stderr || ''), { mode: 0o600 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'Engineering process was interrupted');
    assert.equal(result.status, 0, `Engineering process failed: ${fixture.file}`);
    const lines = (result.stdout || '').split(/\r?\n/).filter(line => line.startsWith(fixture.marker));
    assert.equal(lines.length, 1, 'A unique completed engineering receipt is required');
    const receipt = lines[0].slice(fixture.marker.length);
    const sha256 = validateFixture(fixture, receipt, runId, startedAt, Date.now(), sourceSha256);
    recorded.push({ file: fixture.file, receipt, sha256, packageView: fixture.actualGuard
      ? { actualVersion, fixtureVersion: actualVersion, kind: 'actual-guard-without-preload', productionFilesChanged: false } : packageView });
    console.log(`Image recovery engineering complete: ${fixture.file}`);
  }
  assert.deepEqual(hashes(), sourceSha256, 'Candidate source changed during the gate');
  const receipt = path.join(directory, 'receipt.json');
  writeFileSync(receipt, JSON.stringify({ schema: 'image-recovery-build-gate.v1', runId, candidateRoot: root,
    startedAt, finishedAt: Date.now(), sourceSha256, packageView, fixtures: recorded, completed: true }, null, 2), { mode: 0o600, flag: 'wx' });
  verify(receipt, startedAt);
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
