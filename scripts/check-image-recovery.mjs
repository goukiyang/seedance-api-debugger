import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readPricingFixtureInputs } from './pricing-fixture-input.mjs';
import { MULTIVIEW_SETTINGS_FIXTURE_SOURCES } from './multiview-settings-fixture-inputs.mjs';
import { HD_CHAIN_CHECKS, HD_CHAIN_CHILDREN, HD_CHAIN_FIXTURE_SOURCES } from './hd-chain-fixture-inputs.mjs';
import { MULTIVIEW_PRIVATE_BATCH_SOURCES } from './multiview-private-batch-engineering.mjs';
import { MULTIVIEW_FLOW_SOURCES } from './multiview-flow-fixture-inputs.mjs';
import { PRIVATE_PROMPTS_CHECKS, PRIVATE_PROMPTS_SOURCES } from './private-prompts-fixture-inputs.mjs';

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
  { file: 'scripts/private-prompts-engineering.mjs', schema: 'private-prompts-engineering.v1',
    marker: 'Private prompts engineering receipt: ', checks: PRIVATE_PROMPTS_CHECKS, sources: PRIVATE_PROMPTS_SOURCES },
  { file: 'ops/video-creation-contract-check.mjs', schema: 'video-creation-contract-engineering.v1',
    marker: 'Video creation contract engineering receipt: ', checks: [
      'v1_v2_and_unknown_contracts_fail_closed', 'project_only_specs_real_parent_and_child_identity',
      'schema_capability_uses_actual_required_columns', 'delivery_selection_is_not_lock_and_independent_provenance_is_not_lineage',
      'approval_actual_helper_expiry_revoke_scope_cost_cas_and_same_task_once',
      'all_four_acceptors_bind_real_task_and_approval_in_original_transaction', 'reuse_original_identity_scope_and_unknown_never_replays',
    ], sources: [
      'ops/video-creation-contract-check.mjs', 'scripts/video-creation-contract-engineering.ts',
      'src/lib/creation/contract.ts', 'src/lib/creation/context.ts', 'src/lib/creation/intents.ts', 'src/lib/creation/approval.ts',
      'src/lib/creation/availability.ts', 'src/lib/creation/lineage.ts', 'src/lib/navigation/task-reuse-intent.ts',
      'src/lib/navigation/task-reuse-client.ts', 'src/lib/navigation/task-reuse-operation.server.ts',
      'src/lib/hooks/useWorkspace.ts', 'src/components/ResourceLibraryPicker.tsx', 'src/components/useResultPages.ts',
      'src/app/api/tasks/create/route.ts', 'src/app/api/ip/tasks/create/route.ts',
      'src/app/api/tasks/enhance-video/create/route.ts', 'src/lib/tasks/seedance-draft-upgrade.ts',
    ] },
  { file: 'scripts/image-quality-routing-engineering.ts', schema: 'image-quality-routing-engineering.v1',
    marker: 'Image quality routing engineering receipt: ', checks: ['strict_versioned_reader', 'two_quality_routes_reject_channel_override',
      'quote_route_revision_frozen', 'legacy_parent_source_contract_preserved', 'actual_total_reference_count_seven',
      'medium_half_point_not_ceil', 'atomic_activation_source_cas_and_original_receipt', 'guard_reader_and_runtime_capability'],
    sources: ['src/lib/image-studio/quality-routing.ts', 'src/lib/integrations/image-generation-defaults.ts',
      'src/lib/integrations/image-generation-channel.ts', 'src/lib/integrations/image-generation.ts',
      'src/lib/integrations/image-quality-routing.ts', 'src/lib/image-studio/tasks.ts', 'src/lib/image-studio/batches.ts',
      'src/lib/image-studio/batch-billing-quote.ts', 'src/lib/image-studio/billing-quote-store.ts',
      'src/lib/pricing/runtime.ts', 'src/lib/pricing/build-mode.ts', 'src/lib/pricing/frozen-charge.ts',
      'src/app/api/admin/integrations/image-generation/route.ts', 'scripts/activate-image25-quality-routing.ts'] },
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
      'src/lib/assets/direct-upload.ts', 'src/lib/assets/direct-upload-error.ts', 'src/app/api/assets/upload-proxy/route.ts',
      'src/lib/http/upload-session.ts', 'src/lib/hooks/useWorkspace.ts', 'src/components/ResourceLibraryPicker.tsx',
      'src/components/ResourceLibraryPicker.module.css', 'src/app/api/assets/upload/route.ts',
      'src/app/api/assets/upload-complete/route.ts', 'src/app/api/assets/multipart/complete/route.ts',
      'src/lib/assets/raw-upload-recovery-proof.ts', 'src/app/api/assets/upload/recover/route.ts',
    ] },
];
fixtures.push({ file: 'scripts/multiview-settings-batch-engineering.mjs', schema: 'multiview-settings-batch-engineering.v1',
  marker: 'Multiview settings engineering receipt: ', checks: ['saved_settings_permissions_snapshots_and_timing',
    'frame_settings_keep_media_and_layout_private', 'preview_atlas_loop_exact_output_contract',
    'same_work_identity_baseline_and_explicit_original_save', 'authorized_multiview_original_transport'], sources: MULTIVIEW_SETTINGS_FIXTURE_SOURCES });
fixtures.push({ file: 'scripts/hd-chain-engineering.mjs', schema: 'hd-chain-engineering.v1',
  marker: 'HD chain engineering receipt: ', checks: HD_CHAIN_CHECKS, sources: HD_CHAIN_FIXTURE_SOURCES });
fixtures.push({ file: 'scripts/image-size-policy-engineering.ts', schema: 'image-size-policy-engineering.v1',
  marker: 'Image size policy engineering receipt: ', checks: [
    'legacy_119_frozen_specifications_unchanged', 'standard_16_ratios_48_tiers_unchanged',
    'fine_ratio_four_expected_dimensions', 'boundary_2403_same_candidates_area_band',
    'auto_decimal_invalid_four_to_one_half_k_boundaries', 'shared_pixel_and_native_adapters_preserve_capabilities',
    'server_only_preparation_version_no_fingerprint_migration', 'old_parent_partial_prepared_accepted_uncertain_frozen_v1',
    'new_v2_parent_and_original_parent_receipt_before_quote_gate', 'accepted_original_request_receipt_precedes_old_quote_gate',
    'old_quotes_and_stale_continuation_rejected_without_consumption_or_reservation',
    'parent_parser_rejects_unknown_versions_without_read_backfill',
    'explicit_reconfirmation_migrates_only_safe_unaccepted_items_in_cas_transaction',
  ], sources: [
    'src/lib/image-studio/ratios.ts', 'src/lib/image-generation/resolution.ts',
    'src/lib/integrations/image-generation.ts', 'src/lib/image-studio/tasks.ts',
    'src/lib/image-studio/billing-quote-service.ts', 'src/lib/image-studio/billing-quote-store.ts',
    'src/lib/image-studio/batch-billing-quote.ts', 'src/lib/image-studio/batches.ts',
    'src/lib/tools/toolflow-runtime.ts', 'src/app/api/assets/generate/route.ts', 'src/lib/image-studio/worker.ts',
  ] });
fixtures.push({ file: 'scripts/image-provider-error-engineering.ts', schema: 'image-provider-error-engineering.v1',
  marker: 'Image provider error engineering receipt: ', checks: [
    'post_errors_preserve_transport_and_safe_serialized_metadata', 'summary_failed_uncertain_and_original_identity',
    'result_errors_and_resume_never_fabricate_post', 'bounded_error_body_cancellation_and_native_compatibility',
    'large_success_download_and_callback_failures_preserve_business',
    'positive_allowlist_rejects_private_echo_and_malicious_fields', 'aggregate_preserves_first_latest_counts_and_limits',
    'sqlite_binding_lease_cas_and_read_projection', 'diagnostic_write_failure_isolated_from_original_business',
    'three_worker_generate_paths_and_local_validation_bound',
  ], sources: [
    'src/lib/image-studio/provider-error-diagnostics.ts', 'src/lib/image-studio/provider-error-evidence.ts',
    'src/lib/image-studio/provider.ts', 'src/lib/image-studio/worker.ts',
  ] });
const pricingGate = 'scripts/check-pricing-policy.mjs';
const usageGate = 'scripts/admin-usage-engineering.ts';
const usageSources = [usageGate, 'scripts/admin-usage-migration-engineering.py', 'src/lib/admin/usage-query.ts', 'src/lib/admin/usage-money.ts', 'src/lib/admin/usage-types.ts',
  'src/lib/admin/usage-facts.ts', 'src/lib/admin/usage-analytics.ts', 'src/lib/admin/usage-attribution.ts',
  'prisma/schema.prisma', 'prisma/schema-base.prisma', 'prisma/migrations/20261021073000_usage_attribution/migration.sql',
  'ops/sd2-usage-attribution-migrate.py', 'ops/sd2-admin-usage-public-proof.mjs',
  'ops/sd2-usage-role-start.mjs', 'scripts/canvas-role-coordinator.ts'];
const publicUsageFixtures = [
  { file: 'scripts/cover-pool-engineering.ts', schema: 'cover-pool-engineering.v1', databaseFlag: 'applicationDatabaseOpened', sources: [
    'scripts/cover-pool-engineering.ts', 'src/lib/content-reactions/independent.ts', 'src/lib/image-studio/gallery.ts',
    'src/lib/image-studio/gallery-context.ts', 'src/lib/image-studio/gallery-types.ts', 'src/lib/image-studio/shared-contract.ts',
    'src/app/api/content-reactions/independent/route.ts', 'src/app/api/image-studio/gallery/query/route.ts',
    'src/components/content-reactions/GalleryReactionButtons.tsx', 'src/app/image-studio/module-gallery-state.ts',
    'src/app/image-studio/useModuleGalleryState.ts', 'src/app/image-studio/useGalleryCatalog.ts',
    'src/app/image-studio/studio.tsx',
  ] },
  { file: 'scripts/template-author-cover-contract-engineering.ts', schema: 'template-author-cover-contract-engineering.v1',
    databaseFlag: 'applicationDatabaseOpened', checks: [
      'author_colleague_admin_and_fresh_identity_never_impersonate_each_other',
      'missing_or_conflicting_sources_do_not_guess_authors_or_cross_workspace_owners',
      'definition_read_is_separate_from_generation_and_never_projects_source_media_or_writes',
      'author_contact_uses_only_fresh_server_identity_fixed_feishu_route_and_tenant',
      'prepare_none_stays_frozen_after_new_private_result_and_cas_loser_does_not_overwrite',
      'prepare_existing_preserves_old_recipe_and_binds_original_request_target_and_operation',
      'failed_source_preparation_keeps_original_source_task_revision_without_new_latest',
      'protected_output_is_not_published_or_replaced_by_input_fallback',
      'cover_commit_requires_exact_owner_target_operation_source_and_before_after_revision',
      'fixed_cover_public_dto_and_original_status_hide_source_and_recheck_revocation',
    ], sources: [
      'scripts/template-author-cover-contract-engineering.ts', 'src/lib/image-studio/template-author.ts',
      'src/lib/image-studio/definition-read.ts', 'src/lib/image-studio/module-cover.ts', 'src/lib/image-studio/module-cover-types.ts',
      'src/lib/image-studio/shared-contract.ts', 'src/lib/image-studio/shared-command-storage.ts',
      'src/lib/image-studio/workspace-deletion.ts', 'src/lib/image-studio/preset-lifecycle.ts',
      'src/lib/image-studio/context-version.ts', 'src/lib/image-studio/access.ts', 'src/lib/image-studio/dimension-mismatch.ts',
      'src/lib/image-studio/pricing-state.ts', 'src/lib/assets/site-url.ts', 'src/lib/access/external-role.ts',
      'src/lib/users/profiles.ts', 'src/lib/users/display.ts',
    ] },
  { file: 'scripts/image-provider-admin-engineering.ts', schema: 'image-provider-admin-engineering.v1',
    databaseFlag: 'applicationDatabaseOpened', sources: [
      'scripts/image-provider-admin-engineering.ts', 'src/app/api/admin/image-studio/tasks/route.ts',
      'src/app/admin/image-studio/AdminImageStudioClient.tsx',
      'src/app/admin/image-studio/ImageStudioDiagnostics.module.css',
      'src/lib/image-studio/provider-error-diagnostics.ts', 'src/lib/image-studio/provider-error-evidence.ts',
    ] },
  { file: 'scripts/multiview-private-batch-engineering.mjs', schema: 'multiview-private-batch-engineering.v1',
    timeoutMs: 540000, databaseFlag: 'applicationDatabaseOpened', sources: MULTIVIEW_PRIVATE_BATCH_SOURCES },
  { file: 'scripts/multiview-flow-engineering.ts', schema: 'multiview-flow-engineering.v1',
    timeoutMs: 180000, databaseFlag: 'applicationDatabaseOpened', sources: MULTIVIEW_FLOW_SOURCES },
  { file: 'scripts/role-runtime-engineering.mjs', schema: 'role-runtime-engineering.v1',
    databaseFlag: 'applicationDatabaseOpened', sources: ['scripts/role-runtime-engineering.mjs', 'scripts/canvas-role-coordinator.ts'] },
  { file: 'scripts/projects-design-alignment-engineering.mjs', schema: 'projects-design-alignment-engineering.v1',
    databaseFlag: 'applicationDatabaseOpened', sources: [
      'scripts/projects-design-alignment-engineering.mjs', 'src/lib/projects/album-projection.ts',
      'src/lib/reference-albums/permissions.ts', 'src/app/api/projects/[id]/route.ts',
      'src/app/collections/ReferenceAlbumsClient.tsx', 'src/app/collections/ReferenceAlbumsClient.module.css',
      'src/app/projects/page.tsx', 'src/app/projects/[id]/page.tsx', 'src/app/projects/Projects.module.css',
      'src/components/projects/ProjectFilters.tsx', 'src/components/usage/UsageWorkspace.tsx',
      'src/components/usage/UsageWorkspace.module.css', 'src/app/tasks/[id]/TaskResult.module.css',
      'src/app/tasks/[id]/page.tsx', 'src/components/AppShell.tsx', 'src/app/globals.css',
      'src/lib/release.ts', 'src/components/ReleaseNotice.tsx',
    ] },
  { file: 'scripts/studio-restored-settings-engineering.ts', schema: 'studio-restored-settings-engineering.v1',
    databaseFlag: 'applicationDatabaseOpened', sources: [
      'src/lib/image-studio/restored-settings.ts', 'src/lib/image-studio/tasks.ts',
      'src/lib/image-studio/skills.ts', 'src/lib/image-studio/private-storage.server.ts',
      'src/lib/security/private-prompts.server.ts', 'src/lib/security/private-prompt-fields.server.ts', 'scripts/server-runtime.cjs',
      'src/lib/image-studio/task-settings.ts', 'src/lib/image-studio/task-settings-storage.ts',
      'src/lib/image-studio/billing-quote-service.ts', 'src/lib/image-studio/batch-billing-quote.ts',
      'src/lib/image-studio/batches.ts', 'scripts/studio-restored-settings-engineering.ts',
    ] },
  { file: 'scripts/studio-definition-rebase-engineering.ts', schema: 'studio-definition-rebase-engineering.v1',
    databaseFlag: 'applicationDatabaseOpened', sources: [
      'scripts/studio-definition-rebase-engineering.ts', 'src/lib/image-studio/definition-rebase.ts',
    ] },
  { file: 'scripts/canvas-input-engineering.mjs', schema: 'canvas-input-engineering.v1',
    databaseFlag: 'applicationDatabaseOpened', sources: [
      'public/tools/ultimate-canvas/canvas-engine.js', 'scripts/canvas-input-engineering.mjs',
      'public/tools/ultimate-canvas/app.js', 'public/tools/ultimate-canvas/index.html',
    ] },
  { file: 'scripts/project-create-client-engineering.ts', schema: 'project-create-client-engineering.v1',
    databaseFlag: 'applicationDatabaseOpened', sources: [
      'scripts/project-create-client-engineering.ts', 'src/lib/projects/client-operations.ts',
    ] },
  { file: 'scripts/personal-usage-engineering.ts', schema: 'personal-usage-engineering.v1',
    databaseFlag: 'applicationDatabaseOpened', sources: [
      'src/lib/usage/dto.ts', 'src/lib/usage/access.ts', 'src/lib/usage/source-scope.ts', 'src/lib/usage/query.ts',
      'src/lib/usage/aggregate.ts', 'src/lib/usage/personal.ts', 'src/lib/usage/media.ts', 'src/lib/usage/csv.ts', 'src/lib/usage/http.ts',
      'src/lib/usage/facts.ts', 'src/lib/admin/usage-facts.ts', 'scripts/personal-usage-engineering.ts',
    ] },
  { file: 'scripts/project-operations-engineering.ts', schema: 'project-operations-engineering.v1',
    databaseFlag: 'databaseOpened', sources: [
      'scripts/project-operations-engineering.ts', 'src/lib/projects/operations.ts', 'src/lib/projects/permissions.ts',
      'src/app/api/projects/route.ts', 'src/app/api/projects/[id]/route.ts', 'src/app/api/project-invites/[token]/join/route.ts',
    ] },
  { file: 'scripts/usage-reader-sql-engineering.ts', schema: 'usage-reader-sql-engineering.v1',
    timeoutMs: 60000, databaseFlag: 'applicationDatabaseOpened', sources: [
      'scripts/usage-reader-sql-engineering.ts', 'prisma/schema.prisma', 'src/lib/usage/facts.ts',
      'prisma/migrations/20261021073000_usage_attribution/migration.sql',
      'src/lib/usage/source-scope.ts', 'src/lib/usage/media.ts', 'src/lib/usage/access.ts', 'src/lib/usage/query.ts',
    ] },
  { file: 'scripts/usage-video-media-engineering.ts', schema: 'usage-video-media-engineering.v1',
    databaseFlag: 'applicationDatabaseOpened', sources: [
      'src/lib/usage/media.ts', 'src/lib/usage/dto.ts', 'src/lib/usage/personal.ts',
      'src/components/usage/UsageWorkspace.tsx', 'src/components/usage/UsageWorkspace.module.css',
      'src/lib/projects/permissions.ts', 'src/lib/tasks/retention.ts', 'src/lib/video/task-thumbnail-projection.ts',
      'src/lib/video/delivery-status.ts', 'src/lib/video/thumbnail-availability.ts', 'src/lib/video/thumbnail.ts',
      'src/components/MediaPreview.tsx', 'src/lib/hooks/use-media-preview-state.ts', 'scripts/usage-video-media-engineering.ts',
    ] },
];
const projectContractSources = [
  'src/lib/projects/client-operations.ts', 'src/components/ProjectCreateOperationNotice.tsx',
  'src/components/generate/GeneratePageClient.tsx', 'src/components/templates/TemplateGenerateClient.tsx',
  'src/app/multiview/MultiviewGenerationPanel.tsx', 'src/app/admin/projects/AdminProjectsClient.tsx',
  'src/app/api/projects/operations/[requestId]/route.ts', 'src/app/api/projects/operations/[requestId]/close/route.ts',
  'src/app/api/tasks/create/route.ts', 'src/app/api/ip/tasks/create/route.ts', 'src/app/api/tasks/enhance-video/create/route.ts',
  'src/lib/tasks/seedance-draft-upgrade.ts', 'src/lib/canvas-documents.ts', 'src/app/api/tools/ultimate-canvas/flows/route.ts',
  'src/lib/tools/toolflow.ts', 'src/lib/video-cards/workflow.ts', 'src/lib/video-branches/index.ts', 'src/lib/feishu/requirements.ts',
  'src/app/api/reference-albums/route.ts', 'src/app/api/reference-albums/[id]/images/route.ts',
  'src/app/api/usage/route.ts', 'src/app/api/usage/records/route.ts', 'src/app/api/usage/export/route.ts',
  'src/app/api/projects/[id]/usage/route.ts', 'src/app/api/projects/[id]/usage/records/route.ts',
  'src/app/api/projects/[id]/usage/export/route.ts', 'src/app/api/projects/[id]/costs/export/route.ts',
];
const sourceFiles = [...new Set(['package.json', entry, pricingGate, ...usageSources, ...projectContractSources,
  ...publicUsageFixtures.flatMap(fixture => [fixture.file, ...fixture.sources]), ...fixtures.flatMap(fixture => [fixture.file, ...fixture.sources])])];
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
  } else if (fixture.schema === 'hd-chain-engineering.v1') {
    assert.equal(value.candidateRoot, root);
    assert.equal(value.productionHdRootPassedToFixtures, false);
    assert.deepEqual(value.outcomes?.map(item => item.file), HD_CHAIN_CHILDREN);
    for (let index = 0; index < value.outcomes.length; index++) {
      const item = value.outcomes[index];
      assert.equal(item.check, HD_CHAIN_CHECKS[index]); assert.equal(item.completed, true);
      assert.equal(item.exitCode, 0); assert.equal(item.signal, null); assert.equal(item.failure, null);
      const file = path.resolve(item.log), stat = lstatSync(file);
      assert.ok(file.startsWith(path.join(root, '.role-tests') + path.sep));
      assert.equal(realpathSync(file), file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= 4 * 1024 * 1024);
      assert.equal(stat.mode & 0o077, 0);
      if (typeof process.getuid === 'function') assert.equal(stat.uid, process.getuid());
      assert.equal(hash(readFileSync(file)), item.logSha256);
      const safety = readPrivateReceipt(item.safetyReceipt);
      assert.equal(safety.sha256, item.safetySha256);
      for (const key of ['forbiddenCalls', 'refusedWrites', 'productionWrites', 'paidRequests', 'browserRuns']) assert.equal(safety.value[key], 0);
      assert.equal(safety.value.hdRootAtImport, null);
    }
  }
  return receipt.sha256;
}

function validatePublicUsageFixture(fixture, recorded, runId, batchStart, batchEnd, sourceSha256) {
  assert.equal(recorded.file, fixture.file);
  assert.ok(recorded.startedAt >= batchStart && recorded.finishedAt >= recorded.startedAt && recorded.finishedAt <= batchEnd);
  const receipt = readPrivateReceipt(recorded.receipt);
  assert.equal(receipt.sha256, recorded.sha256);
  const value = receipt.value;
  assert.equal(value.schema, fixture.schema); assert.equal(value.completed, true); assert.equal(value.synthetic, true);
  if (value.runId !== undefined) assert.equal(value.runId, runId);
  if (value.candidateRoot !== undefined) assert.equal(value.candidateRoot, root);
  assert.equal(value[fixture.databaseFlag], false);
  for (const key of ['forbiddenCalls', 'paidRequests', 'browserRuns']) assert.equal(value[key], 0);
  if (value.productionWrites !== undefined) assert.equal(value.productionWrites, 0);
  assert.ok(Array.isArray(value.checks) && value.checks.length > 0 && new Set(value.checks).size === value.checks.length);
  if (fixture.checks) assert.deepEqual(value.checks, fixture.checks);
  if (fixture.schema === 'role-runtime-engineering.v1') {
    assert.equal(value.mode, 'verify'); assert.equal(value.maximumWrites, 1); assert.deepEqual(value.rejectedCodes, []);
    assert.deepEqual(value.checks, ['actual_runtime_writer_serializes_concurrent_atomic_publication',
      'write_failure_propagates_and_later_publication_recovers',
      'actual_shutdown_waits_pending_heartbeat_before_terminal_publication_and_disconnect']);
  }
  for (const file of fixture.sources) assert.equal(value.sourceSha256?.[file], sourceSha256[file]);
  for (const [file, digest] of Object.entries(value.sourceSha256 || {})) assert.equal(sourceSha256[file], digest);
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
  assert.equal(value.publicUsageFixtures?.length, publicUsageFixtures.length);
  publicUsageFixtures.forEach((fixture, index) => validatePublicUsageFixture(fixture, value.publicUsageFixtures[index], value.runId,
    value.startedAt, value.finishedAt, value.sourceSha256));
  const usage = readPrivateReceipt(value.usageEngineeringReceipt);
  assert.equal(usage.value.schema, 'admin-usage-engineering.v1'); assert.equal(usage.value.completed, true);
  assert.equal(usage.value.runId, value.runId); assert.equal(usage.value.candidateRoot, root);
  assert.equal(usage.value.databaseOpened, false);
  for (const key of ['forbiddenCalls', 'productionWrites', 'paidRequests', 'browserRuns']) assert.equal(usage.value[key], 0);
  for (const [file, digest] of Object.entries(usage.value.sourceSha256)) assert.equal(value.sourceSha256[file], digest);
  const migration = readPrivateReceipt(usage.value.migrationReceipt);
  assert.equal(migration.sha256, usage.value.migrationReceiptSha256);
  assert.equal(migration.value.schema, 'admin-usage-migration-engineering.v1'); assert.equal(migration.value.completed, true);
  assert.equal(migration.value.applicationDatabaseOpened, false);
  for (const key of ['productionWrites', 'paidRequests', 'browserRuns']) assert.equal(migration.value[key], 0);
  for (const [file, digest] of Object.entries(migration.value.sourceSha256)) assert.equal(value.sourceSha256[file], digest);
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
  const recorded = [], publicUsageRecorded = [], failures = [], outcomes = [];
  const fixtureEnvironment = { ...process.env, NODE_ENV: 'test', IMAGE_RECOVERY_GATE_RUN_ID: runId,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${JSON.stringify(path.join(root, 'scripts/server-runtime.cjs'))}`.trim() };
  delete fixtureEnvironment.HD_DERIVATIVES_ROOT;
  delete fixtureEnvironment.HD_DERIVATIVES_DIR;
  const usageEngineeringReceipt = path.join(directory, 'admin-usage-pure.json');
  const usageResult = spawnSync(process.execPath, ['--import', 'tsx', usageGate, usageEngineeringReceipt], {
    cwd: root, env: fixtureEnvironment, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
  });
  const usageLog = path.join(directory, 'admin-usage-pure.log');
  writeFileSync(usageLog, (usageResult.stdout || '') + (usageResult.stderr || ''), { mode: 0o600, flag: 'wx' });
  if (usageResult.error || usageResult.signal || usageResult.status !== 0) {
    failures.push({ file: usageGate, category: 'pure-engineering', message: 'Calendar/query/integer check failed', log: usageLog, status: usageResult.status, signal: usageResult.signal });
  }
  for (const fixture of publicUsageFixtures) {
    const receipt = path.join(directory, path.basename(fixture.file) + '.json');
    const fixtureStart = Date.now();
    const result = spawnSync(process.execPath, ['--import', 'tsx', fixture.file, receipt], {
      cwd: root, env: fixtureEnvironment, encoding: 'utf8', timeout: fixture.timeoutMs || 30000, maxBuffer: 1024 * 1024,
    });
    const finishedAt = Date.now();
    const log = path.join(directory, path.basename(fixture.file) + '.log');
    writeFileSync(log, (result.stdout || '') + (result.stderr || ''), { mode: 0o600, flag: 'wx' });
    try {
      assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0);
      const item = { file: fixture.file, receipt, sha256: readPrivateReceipt(receipt).sha256, startedAt: fixtureStart, finishedAt };
      validatePublicUsageFixture(fixture, item, runId, startedAt, Date.now(), sourceSha256);
      publicUsageRecorded.push(item); outcomes.push({ file: fixture.file, completed: true, log });
    } catch (error) {
      failures.push({ file: fixture.file, category: 'public-usage-contract',
        message: error instanceof Error ? error.message : String(error), log, status: result.status, signal: result.signal });
      outcomes.push({ file: fixture.file, completed: false, log });
    }
  }
  // No isolated child may inherit the runtime canonical HD root. Existing
  // image/fee fixtures now also execute the post-commit registration hook.
  delete fixtureEnvironment.HD_DERIVATIVES_ROOT;
  delete fixtureEnvironment.HD_DERIVATIVES_DIR;
  for (const fixture of fixtures) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, fixture.file)], {
      cwd: root, env: fixtureEnvironment,
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
  const pricing = spawnSync(process.execPath, [pricingGate], { cwd: root, env: fixtureEnvironment,
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
      partialReceipts: recorded, publicUsageFixtures: publicUsageRecorded, pricingReceipt: pricingReceipt || null }, null, 2), { mode: 0o600, flag: 'wx' });
    console.error(`Image recovery build failure report: ${failureReport}`);
    process.exitCode = 1;
    return;
  }
  const receipt = path.join(directory, 'receipt.json');
  writeFileSync(receipt, JSON.stringify({ schema: 'image-recovery-build-gate.v1', runId, candidateRoot: root,
    startedAt, finishedAt: Date.now(), sourceSha256, fixtures: recorded, publicUsageFixtures: publicUsageRecorded,
    pricingReceipt, usageEngineeringReceipt, completed: true }, null, 2), { mode: 0o600, flag: 'wx' });
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
