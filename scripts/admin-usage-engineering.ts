import { setFixtureDatabase } from './fixtures/database-client';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

async function main() {
  const root = realpathSync(process.cwd());
  const destination = path.resolve(process.argv[2] || '');
  assert.ok(destination.startsWith(path.join(root, '.role-tests') + path.sep));
  const startedAt = Date.now();
  let forbiddenCalls = 0;
  const forbidden = () => { forbiddenCalls++; throw new Error('Pure usage engineering cannot access business services'); };
  process.env.DATABASE_URL = 'file:/nonexistent/admin-usage-pure-engineering.db';
  Object.assign(process.env, { NODE_ENV: 'test' });
  setFixtureDatabase(new Proxy({}, { get: () => forbidden }));
  Reflect.set(globalThis, 'prismaSqlitePragmasStarted', true);
  globalThis.fetch = forbidden;
  const { parseUsageQuery, usageDateStartUtc } = await import('../src/lib/admin/usage-query');
  const { usageMoneyTotals, usageCnyMicros, usageDecimalUnits, usageUnitsText } = await import('../src/lib/admin/usage-money');
  const checks: string[] = [];
  const params = (value: string) => new URLSearchParams(value);
  const now = new Date('2026-10-21T07:00:00.000Z');
  const q4 = parseUsageQuery(params('range=quarter&year=2026&quarter=4&time_zone=America/Los_Angeles'), now);
  assert.equal(q4.startUtc, '2026-10-01T07:00:00.000Z');
  assert.equal(q4.endUtc, '2027-01-01T08:00:00.000Z');
  const half = parseUsageQuery(params('range=half&year=2024&half=1&time_zone=UTC'), now);
  assert.equal(half.startUtc, '2024-01-01T00:00:00.000Z');
  assert.equal(half.endUtc, '2024-07-01T00:00:00.000Z');
  const recent = parseUsageQuery(params('range=recent6m&time_zone=America/Los_Angeles'), now);
  assert.equal(recent.startUtc, '2026-04-21T07:00:00.000Z');
  assert.equal(recent.endUtc, '2026-10-22T07:00:00.000Z');
  const recentClamp = parseUsageQuery(params('range=recent6m&time_zone=UTC'), new Date('2024-08-31T12:00:00.000Z'));
  assert.equal(recentClamp.startUtc, '2024-02-29T00:00:00.000Z');
  assert.equal(recentClamp.endUtc, '2024-09-01T00:00:00.000Z');
  checks.push('calendar_quarter_half_cross_year_and_leap_boundaries');
  const dayLength = (from: string, to: string) => (Date.parse(usageDateStartUtc(to, 'America/Los_Angeles')) - Date.parse(usageDateStartUtc(from, 'America/Los_Angeles'))) / 3600000;
  assert.equal(dayLength('2026-03-08', '2026-03-09'), 23);
  assert.equal(dayLength('2026-11-01', '2026-11-02'), 25);
  checks.push('iana_timezone_dst_23_and_25_hour_days');
  const all = parseUsageQuery(params('range=all&grain=month&time_zone=UTC&page_size=100'), now);
  assert.equal(all.startUtc, null); assert.equal(all.endUtc, null); assert.equal(all.page_size, 100);
  const february = parseUsageQuery(params('range=custom&date_from=2024-02-29&date_to=2024-02-29&time_zone=UTC'), now);
  assert.equal(february.endUtc, '2024-03-01T00:00:00.000Z');
  for (const invalid of ['range=all&month=10', 'range=custom&date_from=2023-02-29&date_to=2023-03-01',
    'range=quarter&quarter=5', 'page_size=101', 'grain=hour', 'kind=anything', 'page=0',
    'owner_user_id=a&owner_user_id=b', 'source_kind=agent_run', 'result_ready=false',
    'time_zone=Not/A_Timezone']) assert.throws(() => parseUsageQuery(params(invalid), now));
  const exactSource = parseUsageQuery(params('range=all&source_kind=agent_text_step&result_ready=unknown'), now);
  assert.equal(exactSource.source_kind, 'agent_text_step');
  assert.equal(exactSource.result_ready, 'unknown');
  checks.push('unbounded_history_strict_query_and_inclusive_custom_date');
  const large = '90071992547409930';
  const money = usageMoneyTotals([{ currency: 'CNY', amountMicros: large }, { currency: 'CNY', amountMicros: '1' }]);
  assert.equal(money[0].amountMicros, '90071992547409931');
  assert.equal(usageCnyMicros([]), null);
  assert.equal(usageCnyMicros([{ currency: 'OTHER', amountMicros: '0' }]), null);
  assert.equal(usageCnyMicros([{ currency: 'CNY', amountMicros: '0' }]), '0');
  assert.equal(usageUnitsText(usageDecimalUnits('0.1', 2)! + usageDecimalUnits('0.2', 2)!), '0.3');
  checks.push('integer_totals_over_safe_number_unknown_is_not_zero');
  const migrationReceipt = destination.replace(/\.json$/, '') + '-migration.json';
  const migration = spawnSync('python3', ['-B', 'scripts/admin-usage-migration-engineering.py', migrationReceipt], {
    cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.ifError(migration.error);
  assert.equal(migration.status, 0, migration.stderr || 'Isolated schema compatibility failed');
  const migrationProof = JSON.parse(readFileSync(migrationReceipt, 'utf8'));
  assert.equal(migrationProof.completed, true);
  assert.equal(migrationProof.applicationDatabaseOpened, false);
  checks.push('isolated_additive_schema_backup_restore_and_compatible_reader');
  assert.equal(forbiddenCalls, 0);
  const sources = ['scripts/admin-usage-engineering.ts', 'scripts/admin-usage-migration-engineering.py',
    'ops/sd2-usage-attribution-migrate.py', 'prisma/migrations/20261021073000_usage_attribution/migration.sql',
    'src/lib/admin/usage-query.ts', 'src/lib/admin/usage-money.ts'];
  writeFileSync(destination, JSON.stringify({ schema: 'admin-usage-engineering.v1', completed: true, synthetic: true,
    runId: process.env.IMAGE_RECOVERY_GATE_RUN_ID, candidateRoot: root, startedAt, finishedAt: Date.now(), checks,
    sourceSha256: Object.fromEntries(sources.map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')])),
    forbiddenCalls, productionWrites: 0, paidRequests: 0, browserRuns: 0, databaseOpened: false,
    migrationReceipt, migrationReceiptSha256: createHash('sha256').update(readFileSync(migrationReceipt)).digest('hex'),
    scope: 'calendar/query/integer arithmetic and isolated SQLite schema compatibility only; no functional acceptance' }), { flag: 'wx', mode: 0o600 });
  console.log('ADMIN_USAGE_ENGINEERING_RECEIPT=' + destination);
}

void main().catch(error => { console.error(error instanceof Error ? error.message : 'Pure engineering check failed'); process.exitCode = 1; });
