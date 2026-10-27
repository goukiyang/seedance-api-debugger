import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const results = [];
for (const [label, steps] of [
  ['media', [
    [['--import', 'tsx', 'scripts/test-audit-media.ts'], { MEDIA_TEST_PHASE: 'server-first' }],
    [['--import', 'tsx', 'scripts/test-audit-media.ts'], { MEDIA_TEST_PHASE: 'server-replay' }],
  ]],
  ['album', [[['--import', 'tsx', 'scripts/test-audit-album-pagination-server.ts'], {}]]],
  ['picker', [[['--import', 'tsx', 'scripts/test-audit-picker-native.ts'], {}]]],
  ['governance', [[['--import', 'tsx', 'scripts/test-audit-governance-native.ts'], {}]]],
]) {
  // Only the explicit media replay shares a DB. Each directory/count proof starts
  // empty, and an independent group can still report after another group fails.
  const runId = `${label}-${randomUUID()}`;
  const database = `file:${path.join(process.cwd(), '.role-tests', 'media-fixtures', runId, 'audit-media.db')}`;
  let passed = true;
  for (const [args, extra] of [[['scripts/prepare-audit-media-fixture.cjs', '--run', runId], {}], ...steps]) {
    const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: {
      ...process.env, NODE_ENV: 'test', MEDIA_FIXTURE_RUN_ID: runId, DATABASE_URL: database, ...extra,
    } });
    if (result.error || result.status !== 0) { passed = false; break; }
  }
  results.push({ label, runId, passed });
  console.log(`Synthetic ${label} evidence: .role-tests/media-fixtures/${runId}`);
}
console.log(JSON.stringify({ schema: 'native-media-groups.v1', results }));
if (results.some(result => !result.passed)) process.exitCode = 1;
