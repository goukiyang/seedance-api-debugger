import { spawnSync } from 'node:child_process';

// Existing recovery/domain suites remain mandatory; this is one entrypoint,
// not a replacement with a smaller collection of new tests.
const suites = [
  'scripts/test-image-decoder-policy.cjs',
  'scripts/test-runtime-secrets.cjs',
  'scripts/test-thin-release-preflight.cjs',
  'scripts/test-equivalent-ci.cjs',
  'scripts/test-static-contracts.mjs',
  'scripts/test-tos-http-compat.cjs',
  'scripts/test-next-request-context.cjs',
  'scripts/test-purpose-signatures.cjs',
  'scripts/test-signed-media-mime.cjs',
  'scripts/test-api-errors.cjs',
  'scripts/test-multiview-error-boundary.cjs',
  'scripts/test-multiview-record-pagination.cjs',
  'scripts/test-video-callback-auth.cjs',
  'scripts/test-rate-limit.cjs',
  'scripts/test-api-route.cjs',
  'scripts/test-route-policies.cjs',
  'scripts/test-task-dto.cjs',
  'scripts/test-original-input-media.cjs',
  'scripts/test-task-list-bounds.cjs',
  'scripts/test-task-seedance-pagination.cjs',
  'scripts/test-seedance-selector-pagination.cjs',
  'scripts/test-task-input-alias.cjs',
  'scripts/test-audit-album-pagination.cjs',
  'scripts/test-audit-picker-growth.cjs',
  'scripts/test-audit-governance-pagination.cjs',
  'scripts/test-task-dto-static.cjs',
  'scripts/test-feedback-digest.cjs',
  'scripts/test-video-create-service.cjs',
  'scripts/test-video-retry-service.cjs',
  'scripts/audit-net-contract.cjs',
  'scripts/audit-decode-upload-contract.cjs',
  'scripts/audit-decode-upload-native.cjs',
  'scripts/test-auth-contract.mjs',
  'scripts/audit-billing-contract.cjs',
  'scripts/audit-billing-followup-contract.cjs',
  'scripts/test-media-contract.mjs',
  'scripts/test-scale-contract.mjs',
  'scripts/check-image-recovery.mjs',
];
const results = suites.map(suite => {
  const result = spawnSync(process.execPath, [suite], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test', ALBUM_PAGE_PHASE: 'handoff', PICKER_PHASE: 'closed', GOVERNANCE_PHASE: 'integrated' } });
  return { suite, exitCode: result.status, passed: !result.error && result.status === 0 };
});
console.log(JSON.stringify({ schema: 'contract-suites.v1', results }));
if (results.some(result => !result.passed)) process.exitCode = 1;
