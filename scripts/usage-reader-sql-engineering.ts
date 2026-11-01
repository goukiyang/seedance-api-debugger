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
  Reflect.set(globalThis, 'prisma', new Proxy({}, { get: () => forbidden }));
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
    user: { findUnique: async () => metadata,
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        execute(`SELECT id,name FROM User WHERE id IN (${where.id.in.map(() => '?').join(',')})`, where.id.in) },
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
    providerApiRequest: { findMany: async ({ where }: { where: { id?: { in: string[] }; task_id?: { in: string[] } } }) => {
      const filters: string[] = [], values: string[] = [];
      for (const column of ['id', 'task_id'] as const) if (where[column]) {
        const ids = where[column]!.in;
        filters.push(`${column} IN (${ids.map(() => '?').join(',')})`); values.push(...ids);
      }
      assert.ok(filters.length, 'provider request metadata must remain scoped');
      return execute(`SELECT id,task_id FROM ProviderApiRequest WHERE ${filters.join(' AND ')}`, values);
    } },
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

  // Exercise the actual reader across the original 500-leaf boundary. Compare
  // its selected rows with the previous correlated SQL, not source text/mocks.
  for (let index = 0; index < 500; index++) seed.VideoTask.push({ ...seed.VideoTask[0],
    id: `fixture-batch-${String(index).padStart(3, '0')}`, provider_task_id: `fixture-provider-batch-${index}` });
  seed.ImageStudioTask.push(
    { ...seed.ImageStudioTask[0], id: 'fixture-image-a', billing_scope: 'scope-a', gateway_request_id: 'shared-reference' },
    { ...seed.ImageStudioTask[0], id: 'fixture-image-b', billing_scope: 'scope-b', gateway_request_id: 'shared-reference' },
    { ...seed.ImageStudioTask[0], id: 'fixture-image-c', billing_scope: 'scope-c', gateway_request_id: 'different-reference' },
  );
  seed.ProviderApiRequest = Array.from({ length: 501 }, (_, index) => ({ id: `fixture-request-${String(index).padStart(3, '0')}`,
    task_id: 'fixture-batch-000', provider_name: 'fixture', provider_account_id: 'fixture-account' }));
  seed.ProviderApiRequest.push({ id: 'foreign-request', task_id: 'other-video', provider_name: 'fixture', provider_account_id: 'fixture-account' });
  seed.CostLedger.push(...[
    { id: 'z-first-batch', task_id: 'fixture-batch-000' },
    { id: 'a-second-batch', task_id: 'fixture-video' },
    { id: 'cash-video-task-alias', source_type: 'video_task', source_id: 'fixture-video' },
    { id: 'cash-task-alias', source_type: 'task', source_id: 'fixture-video' },
    { id: 'cash-image-direct', image_task_id: 'fixture-image' },
    { id: 'cash-image-alias', source_type: 'image_task', source_id: 'fixture-image' },
    { id: 'cash-image-studio-alias', source_type: 'image_studio_task', source_id: 'fixture-image' },
    { id: 'cash-request-column', provider_request_id: 'fixture-request-000' },
    { id: 'cash-request-source', source_type: 'provider_request', source_id: 'fixture-request-500' },
    { id: 'cash-multiple-links', task_id: 'fixture-batch-000', source_type: 'video_task', source_id: 'fixture-batch-000', provider_request_id: 'fixture-request-000' },
    { id: 'cash-conflict', task_id: 'fixture-batch-000', image_task_id: 'fixture-image' },
    { id: 'cash-scope-a', provider_account_id: 'scope-a', provider_task_id: 'shared-reference' },
    { id: 'cash-scope-b', provider_account_id: 'scope-b', provider_task_id: 'shared-reference' },
    { id: 'cash-scope-c', provider_account_id: 'scope-c', provider_task_id: 'different-reference', provider_name: 'another-provider' },
    { id: 'excluded-scope', provider_account_id: 'scope-foreign', provider_task_id: 'shared-reference' },
    { id: 'excluded-cross-pair', provider_account_id: 'scope-a', provider_task_id: 'different-reference' },
    { id: 'excluded-request', provider_request_id: 'foreign-request' },
    { id: 'excluded-request-source', source_type: 'provider_request', source_id: 'foreign-request' },
    { id: 'cash-mirror-usd', task_id: 'fixture-batch-001', currency: 'USD', official_charge_id: 'mirror-proof' },
    { id: 'cash-mirror-cny', task_id: 'fixture-batch-001', currency: 'CNY', amount_micros: 7000000, official_charge_id: 'mirror-proof' },
  ].map(row => ({ ...seed.CostLedger[0], task_id: null, image_task_id: null, source_type: 'adjustment', source_id: null,
    provider_request_id: null, provider_task_id: null, official_charge_id: `${row.id}-proof`, ...row })));
  const cashSnapshot = await readUsageFacts(db, '2026-10-21T09:00:00Z', options);
  assert.equal(cashSnapshot.facts.length, 505);
  const originalLeaves = [
    ...seed.VideoTask.filter(row => row.owner_user_id === 'self' && row.project_id === 'fixture-project')
      .sort((left, right) => String(left.id) < String(right.id) ? -1 : 1)
      .map(row => ({ kind: 'video_task', id: row.id, scope: null, reference: null })),
    ...seed.ImageStudioTask.filter(row => row.owner_id === 'self').sort((left, right) => String(left.id) < String(right.id) ? -1 : 1)
      .map(row => ({ kind: 'image_task', id: row.id, scope: row.billing_scope, reference: row.gateway_request_id })),
  ];
  const originalSelected = new Map<string, true>();
  for (let offset = 0; offset < originalLeaves.length; offset += 500) {
    const links = originalLeaves.slice(offset, offset + 500).map(leaf => {
      const direct = leaf.kind === 'video_task' ? Prisma.sql`"task_id" = ${leaf.id}` : Prisma.sql`"image_task_id" = ${leaf.id}`;
      const aliases = leaf.kind === 'video_task' ? ['task', 'video_task'] : ['image_task', 'image_studio_task'];
      const request = leaf.kind === 'video_task' ? Prisma.sql`EXISTS (SELECT 1 FROM "ProviderApiRequest" p WHERE p."task_id" = ${leaf.id}
        AND (p."id" = "CostLedger"."provider_request_id" OR "CostLedger"."source_type" = 'provider_request' AND p."id" = "CostLedger"."source_id"))` : Prisma.sql`0 = 1`;
      const reference = leaf.scope && leaf.reference ? Prisma.sql`"provider_account_id" = ${leaf.scope} AND "provider_task_id" = ${leaf.reference}` : Prisma.sql`0 = 1`;
      return Prisma.sql`(${direct} OR "source_type" IN (${Prisma.join(aliases)}) AND "source_id" = ${leaf.id} OR ${request} OR (${reference}))`;
    });
    const originalSql = Prisma.sql`SELECT "id" FROM "CostLedger" WHERE (${Prisma.join(links, ' OR ')}) AND "id" > '' ORDER BY "id" ASC`;
    for (const row of execute(originalSql.sql, originalSql.values)) originalSelected.set(String(row.id), true);
  }
  const expectedCashIds = Array.from(originalSelected.keys()).filter(id => id !== 'cash-mirror-usd');
  assert.deepEqual(cashSnapshot.cashEvents.map(event => event.id), expectedCashIds);
  assert.ok(expectedCashIds.indexOf('z-first-batch') < expectedCashIds.indexOf('a-second-batch'), 'do not globally reorder batches');
  assert.equal(cashSnapshot.cashEvents.filter(event => event.id === 'cash-multiple-links').length, 1);
  for (const id of ['cash-request-column', 'cash-request-source', 'cash-multiple-links']) {
    assert.equal(cashSnapshot.cashEvents.find(event => event.id === id)?.sourceKey, 'video_task:fixture-batch-000');
  }
  for (const suffix of ['a', 'b', 'c']) assert.equal(cashSnapshot.cashEvents.find(event => event.id === `cash-scope-${suffix}`)?.sourceKey,
    `image_task:fixture-image-${suffix}`);
  assert.ok(!cashSnapshot.cashEvents.some(event => event.id.startsWith('excluded-')));
  assert.equal(cashSnapshot.cashEvents.find(event => event.id === 'cash-conflict')?.status, 'conflict');
  assert.equal(cashSnapshot.cashEvents.find(event => event.id === 'cash-conflict')?.sourceKey, null);
  for (const sourceId of ['fixture-batch-000', 'fixture-image']) assert.ok(cashSnapshot.facts.find(fact => fact.sourceId === sourceId)?.ledgerIds.includes('cash-conflict'));
  assert.equal(cashSnapshot.cashEvents.find(event => event.id === 'cash-mirror-cny')?.amountMicros, '7000000');

  // Admin slices expand peers through the real reader. Keep 101 initial rows
  // so the second peer batch must append after the first even for a lower ID.
  seed.User = [{ id: 'self', name: 'Fixture' }];
  const peerBase = { ...seed.CostLedger[0], task_id: 'fixture-video', image_task_id: null, source_type: 'adjustment', source_id: null,
    provider_name: 'peer-provider', provider_account_id: 'peer-scope', provider_task_id: null, provider_request_id: null };
  seed.CostLedger = Array.from({ length: 101 }, (_, index) => ({ ...peerBase, id: `peer-seed-${String(index).padStart(3, '0')}`,
    official_charge_id: `peer-proof-${index}` }));
  Object.assign(seed.CostLedger[0], { official_charge_id: 'shared-proof-0', provider_task_id: 'shared-reference-0' });
  Object.assign(seed.CostLedger[1], { official_charge_id: 'shared-proof-1', provider_task_id: 'shared-reference-1' });
  Object.assign(seed.CostLedger[2], { provider_account_id: null, provider_name: null, official_charge_id: 'empty-scope-proof', provider_task_id: 'empty-scope-reference' });
  Object.assign(seed.CostLedger[3], { provider_account_id: '', provider_name: '', official_charge_id: 'empty-scope-proof-2' });
  Object.assign(seed.CostLedger[4], { provider_account_id: 'scope-a', official_charge_id: 'collision-proof', provider_task_id: 'collision-reference' });
  Object.assign(seed.CostLedger[5], { provider_account_id: 'scope-b', official_charge_id: 'scope-b-proof', provider_task_id: 'scope-b-reference' });
  Object.assign(seed.CostLedger[6], { provider_account_id: 'scope-a', provider_name: 'other-provider', official_charge_id: 'other-name-proof' });
  Object.assign(seed.CostLedger[7], { provider_account_id: 'scope-a', event_type: 'refund', official_charge_id: 'refund-proof' });
  Object.assign(seed.CostLedger[8], { provider_account_id: 'fallback-scope', official_charge_id: null, provider_task_id: '', provider_request_id: 'fallback-reference' });
  Object.assign(seed.CostLedger[9], { provider_account_id: 'no-evidence-scope', official_charge_id: '', provider_task_id: '', provider_request_id: null });
  seed.CostLedger.push(...[
    { id: 'z-peer-first-batch', official_charge_id: 'shared-proof-0', provider_task_id: 'shared-reference-1' },
    { id: 'a-peer-second-batch', official_charge_id: 'peer-proof-100' },
    { id: 'peer-proof-one', official_charge_id: 'shared-proof-1' },
    { id: 'peer-reference-zero', official_charge_id: null, provider_task_id: 'shared-reference-0' },
    { id: 'peer-reference-one', official_charge_id: null, provider_task_id: 'shared-reference-1' },
    { id: 'peer-empty-scope-null', provider_account_id: null, provider_name: null, official_charge_id: 'empty-scope-proof-2' },
    { id: 'peer-empty-scope-string', provider_account_id: '', provider_name: '', official_charge_id: 'empty-scope-proof' },
    { id: 'peer-empty-scope-reference', provider_account_id: '', provider_name: null, official_charge_id: null, provider_task_id: 'empty-scope-reference' },
    { id: 'peer-scope-a', provider_account_id: 'scope-a', official_charge_id: 'collision-proof' },
    { id: 'peer-scope-b', provider_account_id: 'scope-b', official_charge_id: 'scope-b-proof' },
    { id: 'peer-other-name', provider_account_id: 'scope-a', provider_name: 'other-provider', official_charge_id: 'other-name-proof' },
    { id: 'peer-refund', provider_account_id: 'scope-a', event_type: 'refund', official_charge_id: 'refund-proof' },
    { id: 'peer-fallback-empty-task', provider_account_id: 'fallback-scope', official_charge_id: null, provider_task_id: '', provider_request_id: 'fallback-reference' },
    { id: 'peer-fallback-null-task', provider_account_id: 'fallback-scope', official_charge_id: null, provider_task_id: null, provider_request_id: 'fallback-reference' },
    { id: 'excluded-peer-scope', provider_account_id: 'scope-b', official_charge_id: 'collision-proof', provider_task_id: 'collision-reference' },
    { id: 'excluded-peer-name', provider_account_id: 'scope-a', provider_name: 'other-provider', official_charge_id: 'collision-proof', provider_task_id: 'collision-reference' },
    { id: 'excluded-peer-event', provider_account_id: 'scope-a', event_type: 'refund', official_charge_id: 'collision-proof', provider_task_id: 'collision-reference' },
    { id: 'excluded-peer-fallback', provider_account_id: 'fallback-scope', official_charge_id: null, provider_task_id: 'nonempty-task', provider_request_id: 'fallback-reference' },
    { id: 'excluded-peer-no-evidence', provider_account_id: 'no-evidence-scope', official_charge_id: '', provider_task_id: '', provider_request_id: null },
  ].map(row => ({ ...peerBase, task_id: null, ...row })));
  const peerSeeds = execute('SELECT id,provider_account_id,provider_name,event_type,official_charge_id,provider_task_id,provider_request_id FROM CostLedger WHERE task_id=? ORDER BY id', ['fixture-video']);
  assert.equal(peerSeeds.length, 101);
  const originalPeers = new Map(peerSeeds.map(row => [String(row.id), true]));
  const peerText = (value: unknown) => typeof value === 'string' && value.length ? value : null;
  for (let offset = 0; offset < peerSeeds.length; offset += 100) {
    const peers = peerSeeds.slice(offset, offset + 100).map(row => Prisma.sql`(
      COALESCE("provider_account_id", '') = ${peerText(row.provider_account_id) || ''}
      AND COALESCE("provider_name", '') = ${peerText(row.provider_name) || ''} AND "event_type" = ${row.event_type}
      AND ((${peerText(row.official_charge_id)} IS NOT NULL AND "official_charge_id" = ${peerText(row.official_charge_id)})
        OR (${peerText(row.provider_task_id) || peerText(row.provider_request_id)} IS NOT NULL
          AND COALESCE(NULLIF("provider_task_id", ''), "provider_request_id") = ${peerText(row.provider_task_id) || peerText(row.provider_request_id)})))`);
    const originalSql = Prisma.sql`SELECT "id" FROM "CostLedger" WHERE (${Prisma.join(peers, ' OR ')}) AND "id" > '' ORDER BY "id" ASC`;
    for (const row of execute(originalSql.sql, originalSql.values)) originalPeers.set(String(row.id), true);
  }
  const peerSnapshot = await readUsageFacts(db, '2026-10-21T09:00:00Z', undefined, undefined, { kind: 'video_task', ids: ['fixture-video'] });
  assert.deepEqual(peerSnapshot.cashEvents.map(event => event.id), Array.from(originalPeers.keys()));
  assert.ok(peerSnapshot.cashEvents.findIndex(event => event.id === 'z-peer-first-batch') < peerSnapshot.cashEvents.findIndex(event => event.id === 'a-peer-second-batch'));
  assert.equal(peerSnapshot.cashEvents.filter(event => event.id === 'z-peer-first-batch').length, 1);
  for (const id of ['peer-proof-one', 'peer-reference-zero', 'peer-reference-one', 'peer-empty-scope-null', 'peer-empty-scope-string',
    'peer-empty-scope-reference', 'peer-scope-a', 'peer-scope-b', 'peer-other-name', 'peer-refund', 'peer-fallback-empty-task', 'peer-fallback-null-task']) {
    assert.ok(peerSnapshot.cashEvents.some(event => event.id === id), id);
  }
  assert.ok(!peerSnapshot.cashEvents.some(event => event.id.startsWith('excluded-peer-')));
  assert.equal(forbiddenCalls, 0); assert.ok(queries > 10);
  const sources = ['scripts/usage-reader-sql-engineering.ts', 'prisma/schema.prisma', migrationFile, 'src/lib/usage/facts.ts',
    'src/lib/usage/database.ts',
    'src/lib/usage/source-scope.ts', 'src/lib/usage/media.ts', 'src/lib/usage/access.ts', 'src/lib/usage/query.ts'];
  writeFileSync(destination, JSON.stringify({ schema: 'usage-reader-sql-engineering.v1', completed: true, synthetic: true,
    runId: process.env.IMAGE_RECOVERY_GATE_RUN_ID, candidateRoot: root, startedAt, finishedAt: Date.now(),
    checks: ['real_schema_columns_and_actual_scoped_fact_sql', 'foreign_owner_and_revoked_project_excluded_before_fact_projection',
      'actual_scoped_cash_metadata_proof_queries', 'actual_independent_media_projection_sql',
      'cash_candidates_match_original_correlated_sql_and_500_leaf_batch_order', 'cash_provider_request_paging_source_aliases_and_multilink_deduplication',
      'cash_scope_reference_pairing_conflicts_and_currency_mirrors', 'cash_peers_match_original_or_sql_and_100_seed_batch_order',
      'cash_peer_scope_name_event_pairing_null_empty_fallback_and_deduplication'],
    sourceSha256: Object.fromEntries(sources.map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')])),
    queries, forbiddenCalls, applicationDatabaseOpened: false, productionWrites: 0, paidRequests: 0, browserRuns: 0,
    scope: 'Actual read SQL against synthetic in-memory schema; not ORM constraints, production data, functional acceptance or media file availability' }), { flag: 'wx', mode: 0o600 });
  console.log('USAGE_READER_SQL_ENGINEERING_RECEIPT=' + destination);
}

void main().catch(error => { console.error(error instanceof Error ? error.stack : 'SQL engineering failed'); process.exitCode = 1; })
  .finally(() => mock.restoreAll());
