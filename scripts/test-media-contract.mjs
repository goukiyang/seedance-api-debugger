import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const runId = `linux-${randomUUID()}`;
const database = `file:${path.join(process.cwd(), '.role-tests', 'media-fixtures', runId, 'audit-media.db')}`;
for (const [args, extra] of [
  [['scripts/prepare-audit-media-fixture.cjs', '--run', runId], {}],
  [['--import', 'tsx', 'scripts/test-audit-media.ts'], { MEDIA_TEST_PHASE: 'server-first' }],
  [['--import', 'tsx', 'scripts/test-audit-media.ts'], { MEDIA_TEST_PHASE: 'server-replay' }],
  [['--import', 'tsx', 'scripts/test-audit-album-pagination-server.ts'], {}],
  [['--import', 'tsx', 'scripts/test-audit-picker-native.ts'], {}],
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: {
    ...process.env, NODE_ENV: 'test', MEDIA_FIXTURE_RUN_ID: runId, DATABASE_URL: database, ...extra,
  } });
  if (result.error || result.status !== 0) { process.exitCode = 1; break; }
}
console.log(`Synthetic media evidence: .role-tests/media-fixtures/${runId}`);

// Governance asserts global admin totals, so it needs its own empty database.
if (!process.exitCode) {
  const governanceRun = `governance-${randomUUID()}`;
  const governanceDatabase = `file:${path.join(process.cwd(), '.role-tests', 'media-fixtures', governanceRun, 'audit-media.db')}`;
  for (const args of [
    ['scripts/prepare-audit-media-fixture.cjs', '--run', governanceRun],
    ['--import', 'tsx', 'scripts/test-audit-governance-native.ts'],
  ]) {
    const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: {
      ...process.env, NODE_ENV: 'test', MEDIA_FIXTURE_RUN_ID: governanceRun, DATABASE_URL: governanceDatabase,
    } });
    if (result.error || result.status !== 0) { process.exitCode = 1; break; }
  }
  console.log(`Synthetic governance evidence: .role-tests/media-fixtures/${governanceRun}`);
}
