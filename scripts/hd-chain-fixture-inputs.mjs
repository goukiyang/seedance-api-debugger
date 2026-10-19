// Shared by the mandatory build gate and the protected release verifier.
export const HD_CHAIN_CHECKS = [
  'existing_hd_resource_discovery_lease_and_publish_contracts',
  'canonical_root_priority_isolated_encoder_and_bounded_recovery',
  'progressive_display_authorized_cache_and_exact_download',
  'committed_visible_output_registration_and_scan_recovery',
  'administrator_origin_cas_and_truthful_state',
];
export const HD_CHAIN_CHILDREN = [
  'scripts/test-hd-stability.ts', 'scripts/hd-backend-engineering.ts',
  'scripts/test-hd-display.ts', 'scripts/hd-registration-engineering.ts',
  'scripts/hd-admin-engineering.ts',
];
export const HD_CHAIN_FIXTURE_SOURCES = [
  'scripts/hd-chain-fixture-inputs.mjs', 'scripts/hd-chain-engineering.mjs',
  ...HD_CHAIN_CHILDREN, 'scripts/hd-display-engineering.ts',
  'scripts/process-hd-derivatives.ts', 'scripts/process-hd-image.ts',
  'src/lib/media/hd-derivatives.ts', 'src/lib/media/hd-storage-root.ts',
  'src/lib/media/hd-encoder.ts', 'src/lib/media/hd-image-processor.ts',
  'src/lib/media/hd-discovery.ts', 'src/lib/media/hd-resource-state.ts',
  'src/lib/media/hd-readonly-db.ts', 'src/lib/media/hd-registration.ts',
  'src/lib/media/authorized-image-response.ts', 'src/lib/media/hd-display-policy.ts',
  'src/lib/media/hd-source-session.ts', 'src/lib/media/image-preview-session.ts',
  'src/lib/media/image-read-session.ts', 'src/lib/media/native-download.ts',
  'src/lib/media/image-comparison.ts', 'src/lib/assets/site-url.ts',
  'src/lib/hooks/use-hd-image-source.ts', 'src/lib/hooks/use-image-neighbors.ts',
  'src/lib/hooks/use-media-preview-state.ts',
  'src/components/ZoomableImagePreview.tsx', 'src/components/ResultImageCover.tsx',
  'src/components/HdDerivativeManagement.tsx',
  'src/components/HdDerivativeManagement.module.css', 'src/components/ZoomableImagePreview.module.css',
  'src/app/api/admin/hd-derivatives/route.ts',
  'src/lib/image-studio/worker.ts', 'src/lib/image-studio/dimension-rejection.ts',
  'src/lib/image-studio/dimension-mismatch.ts', 'src/lib/image-studio/tasks.ts',
];
