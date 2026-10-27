import { setFixtureDatabase } from './fixtures/database-client';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mock } from 'node:test';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import type { SessionUser } from '../src/lib/auth/session';

async function main() {
  const root = realpathSync(process.cwd()), startedAt = Date.now();
  const destination = path.resolve(process.argv[2] || '');
  assert.ok(destination.startsWith(path.join(root, '.role-tests') + path.sep));
  let forbiddenCalls = 0, queries = 0;
  const forbidden = () => { forbiddenCalls++; throw new Error('SQL fixture cannot access application services'); };
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'file:/nonexistent/usage-reader-sql.db', FEISHU_ALLOWED_TENANT_KEY: '' });
  setFixtureDatabase(new Proxy({}, { get: () => forbidden }));
  Reflect.set(globalThis, 'prismaSqlitePragmasStarted', true);
  globalThis.fetch = forbidden;
  // Use the same marker-only resolution as the existing server engineering
  // fixture. React 18's react-server entry itself is deliberately unsupported.
  const require = createRequire(import.meta.url);
  const marker = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js');
  assert.equal(statSync(marker).size, 0);
  const resolver = require('node:module') as { _resolveFilename: (...args: unknown[]) => string };
  const originalResolve = resolver._resolveFilename;
  mock.method(resolver, '_resolveFilename', (...args: unknown[]) => args[0] === 'server-only'
    ? marker : originalResolve.apply(resolver, args));
  const identifier = (value: string) => {
    assert.match(value, /^[A-Za-z0-9_]+$/);
    return `"${value}"`;
  };
  // The real generated schema supplies column names; constraints are covered
  // separately. Each query runs only in an anonymous in-memory SQLite DB.
  const migrationFile = 'prisma/migrations/20261021073000_usage_attribution/migration.sql';
  const ddl = Prisma.dmmf.datamodel.models.filter(model => model.name !== 'UsageAttribution').map(model => `CREATE TABLE ${identifier(model.dbName || model.name)} (${model.fields
    .filter(field => field.kind !== 'object').map(field => `${identifier(field.dbName || field.name)} ${['Int', 'BigInt', 'Boolean', 'DateTime'].includes(field.type) ? 'INTEGER' : field.type === 'Float' || field.type === 'Decimal' ? 'REAL' : 'TEXT'}`).join(',')});`).join('\n')
    + '\n' + readFileSync(path.join(root, migrationFile), 'utf8');
  assert.ok(ddl.includes('"UsageAttribution"'));
  const now = Date.parse('2026-10-21T08:00:00Z');
  const seed: Record<string, Array<Record<string, unknown>>> = {
    Project: [
      { id: 'fixture-project', owner_user_id: 'self', type: 'team', status: 'active', name: 'Fixture project', created_at: now, updated_at: now },
      { id: 'other-project', owner_user_id: 'other', type: 'team', status: 'active', name: 'DO_NOT_EXPORT_PROJECT', created_at: now, updated_at: now },
    ],
    VideoTask: [{ id: 'fixture-video', owner_user_id: 'self', user_id: 'self', project_id: 'fixture-project',
      retention_status: 'active', local_status: 'succeeded', provider: 'fixture', model: 'fixture-model',
      prompt: 'synthetic', created_at: now, updated_at: now, actual_cost: 8, frozen_cost: 0, refund_amount: 0,
      provider_task_id: 'fixture-provider-video', public_video_url: '/videos/fixture.mp4' }],
    ImageStudioTask: [{ id: 'fixture-image', owner_id: 'self', asset_id: 'fixture-asset', model: 'fixture-model',
      prompt: 'synthetic', status: 'succeeded', billing_status: 'settled', actual_credits: 5, unit_credits: 5,
      billing_settled_at: now, created_at: now, updated_at: now, deleted_at: null }],
    Asset: [{ id: 'fixture-asset', owner_id: 'self', type: 'image', status: 'active', original_url: '/uploads/fixture.png' }],
    CostLedger: [{ id: 'fixture-cash', task_id: 'fixture-video', source_type: 'task', source_id: 'fixture-video',
      provider_name: 'fixture', provider_account_id: 'fixture-account', provider_task_id: 'fixture-provider-video',
      event_type: 'official_charge', amount_micros: 1000000, currency: 'USD', cost_source: 'official_bill',
      confidence: 'confirmed', official_charge_id: 'fixture-proof', occurred_at: now, created_at: now }],
  };
  seed.VideoTask.push(
    { ...seed.VideoTask[0], id: 'other-video', owner_user_id: 'other', user_id: 'other', project_id: 'other-project' },
    { ...seed.VideoTask[0], id: 'revoked-video', project_id: 'other-project' },
  );
  seed.ImageStudioTask.push({ ...seed.ImageStudioTask[0], id: 'other-image', owner_id: 'other' });
  seed.CostLedger.push({ ...seed.CostLedger[0], id: 'other-cash', task_id: 'other-video', source_id: 'other-video',
    official_charge_id: 'other-proof', provider_task_id: 'other-provider-video' });
  const execute = (sql: string, values: unknown[] = []) => {
    queries++;
    const child = spawnSync('python3', ['-B', '-c', String.raw`
import json,sqlite3,sys
p=json.load(sys.stdin)
c=sqlite3.connect(':memory:')
c.row_factory=sqlite3.Row
c.executescript(p['ddl'])
for table,rows in p['seed'].items():
 for row in rows:
  names=list(row)
  c.execute('INSERT INTO "'+table+'" ('+','.join('"'+n+'"' for n in names)+') VALUES ('+','.join('?' for n in names)+')',[row[n] for n in names])
c.commit()
c.execute('PRAGMA query_only=ON')
print(json.dumps([dict(r) for r in c.execute(p['sql'],p['values'])]))
`], { input: JSON.stringify({ ddl, seed, sql, values }, (_key, value) => typeof value === 'bigint' ? Number(value) : value),
      encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, NODE_ENV: 'test', PYTHONDONTWRITEBYTECODE: '1' } });
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout) as Array<Record<string, unknown>>;
  };
  const user: SessionUser = { id: 'self', name: 'Fixture', username: 'fixture', email: '', role: 'user',
    account_type: 'internal', user_profile: 'fixture', feature_profile_id: null, status: 'active', expires_at: null,
    feishu: { user_id: 'fixture', open_id: null, union_id: null, tenant_key: 'fixture', employee_no: null, department_ids: [], last_sync_at: null } };
  const metadata = { ...user, feishu_user_id: 'fixture', feishu_open_id: null, feishu_union_id: null };
  const db = {
    user: { findUnique: async () => metadata },
    project: {
      findMany: async (args: { where: { id?: { in: string[] } } }) => {
        const ids = args.where.id?.in;
        return ids ? execute(`SELECT id,name,owner_user_id,type,status FROM Project WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
          : execute("SELECT id,name,owner_user_id,type,status FROM Project WHERE status<>'deleted' AND owner_user_id=?", ['self']);
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = execute('SELECT * FROM Project WHERE id=?', [where.id])[0];
        return row ? { ...row, members: [] } : null;
      },
    },
    videoTask: { findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
      execute(`SELECT * FROM VideoTask WHERE id IN (${where.id.in.map(() => '?').join(',')})`, where.id.in) },
    providerApiRequest: { findMany: async () => execute('SELECT id,task_id FROM ProviderApiRequest') },
    $queryRaw: async (input: Prisma.Sql | TemplateStringsArray, ...values: unknown[]) => {
      const query = Array.isArray(input) ? Prisma.sql(input as TemplateStringsArray, ...values) : input as Prisma.Sql;
      return execute(query.sql, query.values);
    },
  } as unknown as Prisma.TransactionClient;
  const { createSelfUsageScope } = await import('../src/lib/usage/access');
  const { parseUsageQuery } = await import('../src/lib/usage/query');
  const { resolveUsageReadOptions } = await import('../src/lib/usage/source-scope');
  const { readUsageFacts } = await import('../src/lib/usage/facts');
  const { readUsageMedia } = await import('../src/lib/usage/media');
  const scope = createSelfUsageScope(user);
  const options = await resolveUsageReadOptions(db, scope, parseUsageQuery(new URLSearchParams('month=2026-10'), scope));
  const snapshot = await readUsageFacts(db, '2026-10-21T09:00:00Z', options);
  assert.deepEqual(snapshot.facts.map(fact => fact.sourceId).sort(), ['fixture-image', 'fixture-video']);
  assert.equal(snapshot.cashEvents.filter(event => event.cashEvidence && event.status === 'confirmed').length, 1);
  assert.ok(snapshot.cashEvents.every(event => event.id !== 'other-cash'));
  assert.ok(snapshot.projectDirectory.some(project => project.id === 'fixture-project'));
  assert.ok(!JSON.stringify(snapshot.projectDirectory).includes('DO_NOT_EXPORT_PROJECT'));
  await readUsageMedia(db, user, snapshot.facts, scope);
  assert.equal(forbiddenCalls, 0); assert.ok(queries > 10);
  const sources = ['scripts/usage-reader-sql-engineering.ts', 'prisma/schema.prisma', migrationFile, 'src/lib/usage/facts.ts',
    'src/lib/usage/source-scope.ts', 'src/lib/usage/media.ts', 'src/lib/usage/access.ts', 'src/lib/usage/query.ts'];
  writeFileSync(destination, JSON.stringify({ schema: 'usage-reader-sql-engineering.v1', completed: true, synthetic: true,
    runId: process.env.IMAGE_RECOVERY_GATE_RUN_ID, candidateRoot: root, startedAt, finishedAt: Date.now(),
    checks: ['real_schema_columns_and_actual_scoped_fact_sql', 'foreign_owner_and_revoked_project_excluded_before_fact_projection',
      'actual_scoped_cash_metadata_proof_queries', 'actual_independent_media_projection_sql'],
    sourceSha256: Object.fromEntries(sources.map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')])),
    queries, forbiddenCalls, applicationDatabaseOpened: false, productionWrites: 0, paidRequests: 0, browserRuns: 0,
    scope: 'Actual read SQL against synthetic in-memory schema; not ORM constraints, production data, functional acceptance or media file availability' }), { flag: 'wx', mode: 0o600 });
  console.log('USAGE_READER_SQL_ENGINEERING_RECEIPT=' + destination);
}

void main().catch(error => { console.error(error instanceof Error ? error.stack : 'SQL engineering failed'); process.exitCode = 1; })
  .finally(() => mock.restoreAll());
