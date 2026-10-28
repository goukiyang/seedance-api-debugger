import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Existing recovery/domain suites remain mandatory; this is one entrypoint,
// not a replacement with a smaller collection of new tests.
let suites = [
  'scripts/test-image-decoder-policy.cjs',
  'scripts/test-runtime-secrets.cjs',
  'scripts/test-thin-release-preflight.cjs',
  'scripts/test-equivalent-ci.cjs',
  'scripts/test-static-contracts.mjs',
  'scripts/test-tos-http-compat.cjs',
  'scripts/test-next-request-context.cjs',
  'scripts/test-recovery-factory-facade.cjs',
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
const sql01 = process.argv.includes('--sql01');
let reusedBaseline;
if (sql01) {
  if (JSON.parse(fs.readFileSync('package.json', 'utf8')).version !== '0.111.1') throw new Error('sql01-requires-authorized-patch-version');
  const file = process.env.SQL01_BASELINE_CI_RECEIPT;
  const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (prior.schema !== 'equivalent-ci.v1' || prior.source !== '2759dba29f15b413c866e89837b18f031a4333b3' || !prior.completed) throw new Error('sql01-prior-release-proof-required');
  const entry = prior.results?.find(item => item.command === 'npm run test:contracts');
  const log = path.resolve(prior.root, entry?.log || '');
  const sha = value => createHash('sha256').update(fs.readFileSync(value)).digest('hex');
  if (entry?.exitCode !== 0 || entry.signal !== null || !log.startsWith(path.join(prior.root, '.role-tests') + path.sep)
    || sha(log) !== entry.logSha256) throw new Error('sql01-prior-contract-log-mismatch');
  const summaries = fs.readFileSync(log, 'utf8').split('\n').flatMap(line => {
    try { const value = JSON.parse(line); return value.schema === 'contract-suites.v1' ? [value] : []; } catch { return []; }
  });
  const old = summaries.at(-1);
  if (old?.results?.length !== 39 || old.results.some(item => !item.passed || item.exitCode !== 0)
    || !old.results.some(item => item.suite === 'scripts/check-image-recovery.mjs')) throw new Error('sql01-prior-recovery-not-passed');
  reusedBaseline = { source: prior.source, contractSource: entry.reusedFrom?.source || prior.source,
    receipt: file, receiptSha256: sha(file), log, logSha256: entry.logSha256, startedAt: entry.startedAt, finishedAt: entry.finishedAt,
    scope: 'Unchanged recovery/media/billing evidence retained; SQL01 auth, transactions and observations rerun below, not39 rerun.' };
  suites = ['scripts/test-api-route.cjs', 'scripts/test-recovery-factory-facade.cjs',
    'scripts/test-sql01-admission-closure.cjs', 'scripts/test-sql01-video-tx.cjs', 'scripts/check-sql01-video-tx.cjs',
    'scripts/test-sql01-observations.cjs', 'scripts/verify-sql01-template-server.ts',
    'scripts/verify-sql01-video-tx-server.cjs', 'scripts/verify-sql01-observations-server.ts', 'scripts/test-auth-contract.mjs'];
}
const results = suites.map(suite => {
  const env = { ...process.env, NODE_ENV: 'test', ALBUM_PAGE_PHASE: 'handoff', PICKER_PHASE: 'closed', GOVERNANCE_PHASE: 'integrated' };
  if (sql01) Object.assign(env, { AUD_SQL01_SYNTHETIC_SERVER: '1', AUD_SQL01_VIDEO_SERVER: '1',
    SQL01_FIXTURE_RUN_ID: 'integrated-' + randomUUID(), SQL01_PHASE: 'integrated',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${JSON.stringify(path.join(process.cwd(), 'scripts/server-runtime.cjs'))}`.trim() });
  if (suite === 'scripts/verify-sql01-observations-server.ts') delete env.DATABASE_URL;
  const result = spawnSync(process.execPath, [...(sql01 ? ['--import', 'tsx'] : []), suite], { stdio: 'inherit', env });
  return { suite, exitCode: result.status, passed: !result.error && result.status === 0 };
});
console.log(JSON.stringify({ schema: 'contract-suites.v1', ...(sql01 ? { mode: 'sql01', reusedBaseline } : {}), results }));
if (results.some(result => !result.passed)) process.exitCode = 1;
