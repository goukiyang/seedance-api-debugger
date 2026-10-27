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
  'scripts/test-api-errors.cjs',
  'scripts/test-video-callback-auth.cjs',
  'scripts/check-image-recovery.mjs',
];
const results = suites.map(suite => {
  const result = spawnSync(process.execPath, [suite], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test' } });
  return { suite, exitCode: result.status, passed: !result.error && result.status === 0 };
});
console.log(JSON.stringify({ schema: 'contract-suites.v1', results }));
if (results.some(result => !result.passed)) process.exitCode = 1;
