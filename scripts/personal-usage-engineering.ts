import { setFixtureDatabase } from './fixtures/database-client';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import type { SessionUser } from '../src/lib/auth/session';
import type { UsageFact } from '../src/lib/admin/usage-types';
import type { UsageCashEvent } from '../src/lib/admin/usage-facts';
import type { UsageExportSnapshot, UsageRecordDTO } from '../src/lib/usage/dto';

async function main() {
  const root = realpathSync(process.cwd());
  const destination = path.resolve(process.argv[2] || '');
  assert.ok(destination.startsWith(path.join(root, '.role-tests') + path.sep));
  let forbiddenCalls = 0;
  const forbidden = () => { forbiddenCalls++; throw new Error('Offline fixture cannot open business services'); };
  process.env.DATABASE_URL = 'file:/nonexistent/personal-usage-offline.db';
  Object.assign(process.env, { NODE_ENV: 'test' });
  setFixtureDatabase(new Proxy({}, { get: () => forbidden }));
  Reflect.set(globalThis, 'prismaSqlitePragmasStarted', true);
  globalThis.fetch = forbidden;
  const { parseUsageQuery, usageMonthRange } = await import('../src/lib/usage/query');
  const { createSelfUsageScope } = await import('../src/lib/usage/access');
  const { resolveUsageReadOptions } = await import('../src/lib/usage/source-scope');
  const { publicUsageCash, publicUsagePoints, publicUsageProject, publicUsageSummaries, preferProvenCnyEvents } = await import('../src/lib/usage/aggregate');
  const { usageCsvChunks, usageCsvCell } = await import('../src/lib/usage/csv');
  const checks: string[] = [];
  const user: SessionUser = { id: 'self', name: 'Fixture', username: 'fixture', email: 'fixture@example.invalid', role: 'user',
    account_type: 'internal', user_profile: 'fixture', feature_profile_id: null, status: 'active', expires_at: null,
    feishu: { user_id: 'fixture', open_id: null, union_id: null, tenant_key: null, employee_no: null, department_ids: [], last_sync_at: null } };
  const scope = createSelfUsageScope(user);
  const now = new Date('2026-10-21T07:00:00.000Z');
  for (const query of ['owner_user_id=other', 'user_id=other', 'member_owner_id=other', 'viewerId=other', 'scope=admin',
    'kind=image', 'limit=51', 'limit=0', 'page=0', 'month=2026-13', 'time_zone=Not/AZone', 'type=video&type=image']) {
    assert.throws(() => parseUsageQuery(new URLSearchParams(query), scope, now));
  }
  const query = parseUsageQuery(new URLSearchParams('month=2026-11&time_zone=America/Los_Angeles&limit=50'), scope, now);
  assert.deepEqual(usageMonthRange(query), { startUtc: '2026-11-01T07:00:00.000Z', endUtc: '2026-12-01T08:00:00.000Z', timeZone: 'America/Los_Angeles' });
  checks.push('strict_self_owner_injection_and_iana_dst_month');

  // Exercise the actual generated source predicates against isolated SQLite,
  // not an application database or an emulated permission decision.
  const fakeMetadata = {
    user: { findUnique: async () => ({ ...user, feishu_user_id: 'fixture', feishu_open_id: null, feishu_union_id: null }) },
    project: { findMany: async () => [{ id: 'readable', owner_user_id: 'self' }] },
    $queryRaw: async () => [{ name: 'UsageAttribution' }],
  } as unknown as Prisma.TransactionClient;
  const options = await resolveUsageReadOptions(fakeMetadata, scope, parseUsageQuery(new URLSearchParams(), scope, now));
  const payload = { video: { sql: options.conditions.video_task.sql, values: options.conditions.video_task.values },
    image: { sql: options.conditions.image_task.sql, values: options.conditions.image_task.values } };
  const isolated = spawnSync('python3', ['-B', '-c', `
import json, sqlite3, sys
p=json.load(sys.stdin)
c=sqlite3.connect(':memory:')
c.executescript('''
CREATE TABLE Project(id TEXT,owner_user_id TEXT,status TEXT,type TEXT);
CREATE TABLE ProjectMember(project_id TEXT,user_id TEXT,status TEXT);
CREATE TABLE UsageAttribution(source_kind TEXT,source_id TEXT,owner_user_id TEXT,project_id TEXT,context_version INTEGER);
CREATE TABLE VideoTask(id TEXT,owner_user_id TEXT,user_id TEXT,project_id TEXT,retention_status TEXT,prompt TEXT,model TEXT);
CREATE TABLE ToolFlowRun(id TEXT,snapshot_json TEXT);
CREATE TABLE ImageStudioTask(id TEXT,owner_id TEXT,tool_flow_run_id TEXT,prompt TEXT,model TEXT);
INSERT INTO Project VALUES ('readable','self','active','team'),('lost','other','active','team');
INSERT INTO VideoTask VALUES ('own','self','self','readable','active','','m'),('lost-video','self','self','lost','active','','m'),
('other','other','self','readable','active','','m'),('hidden','self','self','readable','user_deleted','','m'),
('personal','self','self',NULL,'active','','m'),('frozen-other','self','self','readable','active','','m');
INSERT INTO UsageAttribution VALUES ('video_task','frozen-other','other','readable',1),('image_task','own-image','self','lost',1);
INSERT INTO ImageStudioTask VALUES ('own-image','self',NULL,'','m'),('other-image','other',NULL,'','m');
''')
out={k:[r[0] for r in c.execute('SELECT id FROM '+('VideoTask' if k=='video' else 'ImageStudioTask')+' WHERE '+v['sql']+' ORDER BY id',v['values'])] for k,v in p.items()}
print(json.dumps(out))
`], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, NODE_ENV: 'test', PYTHONDONTWRITEBYTECODE: '1' } });
  assert.ifError(isolated.error);
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.deepEqual(JSON.parse(isolated.stdout), { video: ['own', 'personal'], image: ['own-image'] });
  checks.push('source_sql_owner_retention_and_revoked_project_intersection');

  const fact: UsageFact = { sourceKind: 'video_task', sourceId: 'own', parentSourceKind: null, parentSourceId: null,
    kind: 'video', leaf: true, occurredAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-21T07:00:00.000Z',
    ownerUserId: 'self', ownerLabel: 'DO_NOT_EXPORT_OWNER', actorUserId: 'DO_NOT_EXPORT_ACTOR', billingSubject: 'user:self',
    projectId: 'lost', projectLabel: 'DO_NOT_EXPORT_PROJECT', currentOwnerUserId: 'self', currentProjectId: 'lost',
    attribution: 'frozen', attributionDetail: 'DO_NOT_EXPORT_PROOF', model: 'm', provider: 'supplier', resolution: null,
    status: 'succeeded', retentionStatus: 'active', outputCount: 1, resultReady: true, costStatus: 'confirmed',
    confirmedCost: [], confirmedCostCnyMicros: null, chargedPoints: '10', reservedPoints: '0', releasedPoints: '3', refundedPoints: '2', ledgerIds: ['DO_NOT_EXPORT_LEDGER'], href: '/admin/DO_NOT_EXPORT' };
  assert.deepEqual(publicUsageProject(fact, []), { id: null, label: '项目已不可访问', available: false });
  const event: UsageCashEvent = { id: 'DO_NOT_EXPORT_BILL', sourceKey: 'video_task:own', eventType: 'official_charge', occurredAt: fact.occurredAt,
    currency: 'USD', amountMicros: '2000000', status: 'confirmed', provider: 'supplier', proofId: 'proof', ownerUserId: 'self', projectId: 'lost',
    detail: 'DO_NOT_EXPORT_PROOF', cashEvidence: true, ledgerUserId: 'self', ledgerProjectId: 'lost', providerReference: 'DO_NOT_EXPORT_REQUEST', providerScopeFingerprint: 'scope' };
  const cny: UsageCashEvent = { ...event, id: 'DO_NOT_EXPORT_CNY', currency: 'CNY', amountMicros: '13000000' };
  const refund: UsageCashEvent = { ...event, id: 'DO_NOT_EXPORT_REFUND', eventType: 'refund', proofId: 'refund-proof', currency: 'CNY', amountMicros: '-3000000' };
  assert.equal(preferProvenCnyEvents([event, cny]).length, 1);
  assert.equal(publicUsageCash([fact], [event]).netCnyMicros, '14000000');
  const cash = publicUsageCash([fact], [event, cny, refund]);
  assert.equal(cash.chargeCnyMicros, '13000000');
  assert.equal(cash.refundCnyMicros, '3000000');
  assert.equal(cash.netCnyMicros, '10000000');
  assert.deepEqual(cash.refundOriginal, [{ currency: 'CNY', amountMicros: '3000000' }]);
  assert.equal(publicUsageCash([{ ...fact, costStatus: 'conflict' }], [cny]).netCnyMicros, null);
  assert.equal(publicUsageCash([{ ...fact, costStatus: 'unconnected' }], []).netCnyMicros, null);
  const points = publicUsagePoints([fact]);
  assert.equal(points.net, '8'); assert.equal(points.released, '3'); assert.equal(points.personal.net, '8');
  checks.push('cny_usd_proven_mirror_positive_refund_conflict_and_points_release');
  const record: UsageRecordDTO = { id: 'video_task:own', sourceKind: 'video_task', type: 'video', occurredAt: fact.occurredAt,
    status: fact.status, model: fact.model, project: publicUsageProject(fact, []), taskCount: 1, requestCount: null,
    successfulCount: 1, outputCount: 1, availableCount: 1, cash, points, originalHref: '/tasks/own' };
  const image: UsageFact = { ...fact, sourceKind: 'image_task', sourceId: 'image', kind: 'image' };
  const imageRecord: UsageRecordDTO = { ...record, id: 'image_task:image', sourceKind: 'image_task', type: 'image', originalHref: null };
  const records = new Map([[record.id, record], [imageRecord.id, imageRecord]]);
  const summaries = publicUsageSummaries([fact, image], records, [cny, refund]);
  assert.equal(summaries.video.taskCount, 1); assert.equal(summaries.image.taskCount, 1);
  for (const type of ['video', 'image'] as const) {
    const detail = Array.from(records.values()).filter(item => item.type === type);
    assert.equal(detail.length, 1); assert.equal(summaries.video.taskCount, summaries.image.taskCount);
  }
  checks.push('type_only_selects_records_both_summaries_retained');
  const parent: UsageFact = { ...fact, sourceKind: 'role_run', sourceId: 'parent', kind: 'text', leaf: false };
  const child: UsageFact = { ...fact, sourceKind: 'role_attempt', sourceId: 'child', kind: 'text' };
  const parentRecord: UsageRecordDTO = { ...record, id: 'role_run:parent', sourceKind: 'role_run', type: 'other',
    taskCount: null, requestCount: null, successfulCount: null, outputCount: null, availableCount: null };
  const childRecord: UsageRecordDTO = { ...record, id: 'role_attempt:child', sourceKind: 'role_attempt', type: 'other' };
  const grouped = publicUsageSummaries([parent, child], new Map([[parentRecord.id, parentRecord], [childRecord.id, childRecord]]), []);
  assert.equal(grouped.other.taskCount, 1);
  assert.equal(grouped.other.successfulCount, 1);
  checks.push('parent_group_does_not_count_or_mask_known_leaf_counts');
  const snapshot: UsageExportSnapshot = { report: { schema: 1, scope: 'self', query: parseUsageQuery(new URLSearchParams(), scope, now),
    asOf: now.toISOString(), fingerprint: 'fixture', range: usageMonthRange(query), summary: summaries, coverage: [],
    records: { items: [record], total: 1, page: 1, pageSize: 20 }, projects: [], restricted: true },
    records: [{ ...record, model: '=HYPERLINK("unsafe")', ...({ ownerUserId: 'DO_NOT_EXPORT_OWNER', prompt: 'DO_NOT_EXPORT_PROMPT' } as object) }] };
  const csv = Array.from(usageCsvChunks(snapshot)).join('');
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(!csv.includes('DO_NOT_EXPORT'));
  for (const prefix of ['=', '+', '-', '@', '\t=', '\r=', '  =']) assert.ok(usageCsvCell(prefix + 'unsafe').startsWith('"\''));
  assert.equal(usageCsvCell('-3', true), '"-3"');
  assert.equal(forbiddenCalls, 0);
  checks.push('csv_whitelist_formula_protection_precision_no_private_events');
  const sources = ['src/lib/usage/dto.ts', 'src/lib/usage/access.ts', 'src/lib/usage/source-scope.ts', 'src/lib/usage/query.ts',
    'src/lib/usage/aggregate.ts', 'src/lib/usage/personal.ts', 'src/lib/usage/media.ts', 'src/lib/usage/csv.ts', 'src/lib/usage/http.ts',
    'src/lib/usage/facts.ts', 'src/lib/admin/usage-facts.ts', 'scripts/personal-usage-engineering.ts'];
  writeFileSync(destination, JSON.stringify({ schema: 'personal-usage-engineering.v1', synthetic: true, completed: true,
    checks, forbiddenCalls, applicationDatabaseOpened: false, paidRequests: 0, browserRuns: 0,
    sourceSha256: Object.fromEntries(sources.map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')])),
    scope: 'Offline source SQL, DTO, money, query and CSV contracts only; not functional acceptance' }), { flag: 'wx', mode: 0o600 });
  console.log(`PERSONAL_USAGE_ENGINEERING_RECEIPT=${destination}`);
}

void main().catch(error => { console.error(error instanceof Error ? error.message : 'Offline engineering failed'); process.exitCode = 1; });
