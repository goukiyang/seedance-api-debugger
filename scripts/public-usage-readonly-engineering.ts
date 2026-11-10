import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Prisma, PrismaClient } from '@prisma/client';
import type { SessionUser } from '../src/lib/auth/session';
import type { UsageExportSnapshot } from '../src/lib/usage/dto';

const sources = [
  'src/lib/usage/personal.ts', 'src/lib/usage/http.ts', 'src/app/api/projects/route.ts', 'src/lib/admin/usage-report-admission.ts',
  'src/lib/sqlite-prisma-read-snapshot.ts', 'src/lib/usage/sqlite-read-snapshot.ts', 'scripts/usage-sqlite-reader.py',
  'src/lib/usage/access.ts', 'src/lib/usage/source-scope.ts', 'src/lib/usage/project-directory.ts',
  'src/lib/usage/media.ts', 'src/lib/usage/facts.ts', 'src/lib/usage/database.ts', 'src/lib/usage/aggregate.ts',
  'src/lib/usage/row-spool.ts', 'src/lib/usage/csv.ts', 'src/lib/usage/query.ts', 'src/lib/usage/dto.ts',
      'prisma/schema.prisma', 'scripts/public-usage-readonly-engineering.ts',
];
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function main() {
  const root = process.cwd(), destination = path.resolve(process.argv[2] || '');
  assert.ok(destination.startsWith(path.join(root, '.role-tests') + path.sep), 'Explicit private receipt required');
  const directory = await mkdtemp(path.join(tmpdir(), 'public-usage-readonly-'));
  const database = path.join(directory, 'fixture.sqlite'), spoolRoot = path.join(directory, 'spools');
  await mkdir(spoolRoot);
  const prior = { database: process.env.DATABASE_URL, tmp: process.env.TMPDIR, node: process.env.NODE_ENV };
  process.env.DATABASE_URL = 'file:' + database; process.env.TMPDIR = spoolRoot; process.env.NODE_ENV = 'test';
  let phase = 'setup', forbiddenCalls = 0, lateAbort: AbortController | null = null;
  const previousFetch = globalThis.fetch, previousError = console.error;
  const logs: Array<Record<string, any>> = [];
  globalThis.fetch = (async () => { forbiddenCalls++; throw new Error('Offline public report fixture cannot use network'); }) as typeof fetch;
  console.error = (...args: unknown[]) => {
    if (args[0] === '[UsageReadSnapshot]' && typeof args[1] === 'string') {
      const event = JSON.parse(args[1]); logs.push(event);
      if (phase === 'late-abort' && event.event === 'capture-settled' && event.outcome === 'fulfilled') lateAbort!.abort();
      return;
    }
    previousError(...args);
  };
  const base = new PrismaClient({ datasources: { db: { url: 'file:' + database } } });
  base.$use(async (params, next) => {
    if (phase !== 'setup' && phase !== 'baseline') { forbiddenCalls++; throw new Error('Production public report used the writer Prisma client'); }
    return next(params);
  });
  Reflect.set(globalThis, 'prisma', base);
  const checks: string[] = [], details: object[] = [];
  try {
    const epoch = Date.parse('2026-11-01T12:00:00.000Z');
    const models = Prisma.dmmf.datamodel.models;
    const require = createRequire(import.meta.url);
    const prismaCli = path.join(path.dirname(require.resolve('prisma/package.json')), 'build/index.js');
    const engineDirectory = path.dirname(require.resolve('@prisma/engines/package.json'));
    assert.ok((await readdir(engineDirectory)).some(file => file.startsWith('schema-engine-')), 'Installed offline schema engine required');
    const schema = spawnSync(process.execPath, [prismaCli, 'migrate', 'diff', '--from-empty', '--to-schema-datamodel',
      path.join(root, 'prisma/schema.prisma'), '--script'], { encoding: 'utf8', timeout: 30000,
        env: { ...process.env, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1', CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' } });
    assert.equal(schema.status, 0, schema.stderr);
    const ddl = schema.stdout;
    let sequence = 0;
    const seeded: Record<string, Array<Record<string, unknown>>> = {};
    const add = (modelName: string, overrides: Record<string, unknown>) => {
      const model = models.find(item => item.name === modelName)!;
      const row: Record<string, unknown> = {};
      for (const field of model.fields.filter(item => item.kind !== 'object' && item.isRequired)) {
        const value = field.default;
        row[field.dbName || field.name] = value !== undefined && (typeof value !== 'object' || value === null) ? value
          : field.type === 'Boolean' ? false : field.type === 'DateTime' ? epoch
            : ['Int', 'Float', 'BigInt', 'Decimal'].includes(field.type) ? 0 : 'fixture-' + sequence++;
      }
      Object.assign(row, overrides); (seeded[model.dbName || model.name] ||= []).push(row);
    };
    for (const id of ['self', 'other']) add('User', { id, username: id, name: id, email: id + '@example.invalid',
      role: 'user', account_type: 'internal', user_profile: 'fixture', status: 'active', feishu_user_id: id });
    add('Project', { id: 'team', name: 'Team', type: 'team', status: 'active', owner_user_id: 'self' });
    add('Project', { id: 'revoked', name: 'Private other', type: 'team', status: 'active', owner_user_id: 'other' });
    for (const [id, owner, project, retention] of [['own-video', 'self', 'team', 'active'], ['unassigned', 'self', null, 'active'],
      ['other-video', 'other', 'team', 'active'], ['revoked-video', 'self', 'revoked', 'active'], ['deleted-video', 'self', 'team', 'user_deleted']] as const) {
      add('VideoTask', { id, user_id: owner, owner_user_id: owner, project_id: project, retention_status: retention,
        local_status: 'succeeded', provider: 'fixture', model: 'fixture-model', prompt: 'SYNTHETIC',
        created_at: epoch, updated_at: epoch, completed_at: epoch, public_video_url: null, local_video_path: null, result_video_url: null });
    }
    add('ImageStudioTask', { id: 'own-image', owner_id: 'self', module_id: 'fixture-module', model: 'fixture-image',
      status: 'succeeded', billing_status: 'settled', unit_credits: 1, actual_credits: 1, created_at: epoch, updated_at: epoch,
      finished_at: epoch, asset_id: 'own-asset', deleted_at: null });
    add('Asset', { id: 'own-asset', owner_id: 'self', status: 'active', type: 'image', original_url: '/uploads/fixture.png',
      thumbnail_url: null, mime_type: 'image/png', file_name: 'fixture.png' });
    for (const [id, task] of [['bill-video', 'own-video'], ['bill-unassigned', 'unassigned']] as const) add('CostLedger', {
      id, task_id: task, source_type: 'task', source_id: task, user_id: 'self', provider_name: 'fixture',
      provider_account_id: 'fixture-scope', event_type: 'official_charge', currency: 'CNY', amount_micros: 1000000,
      cost_source: 'official_bill', confidence: 'confirmed', official_charge_id: id, occurred_at: epoch,
    });
    const setup = spawnSync('/usr/bin/python3', ['-c', 'import json,sqlite3,sys\np=json.load(sys.stdin)\nc=sqlite3.connect(sys.argv[1]);c.execute("PRAGMA journal_mode=WAL");c.executescript(p["ddl"])\nfor table,rows in p["seed"].items():\n for row in rows:\n  names=list(row);q=lambda x:chr(34)+x.replace(chr(34),chr(34)*2)+chr(34)\n  c.execute("INSERT INTO "+q(table)+"("+",".join(map(q,names))+") VALUES("+",".join("?" for _ in names)+")",[row[k] for k in names])\nc.commit();c.close()', database],
      { input: JSON.stringify({ ddl, seed: seeded }, (_key, value) => typeof value === 'bigint' ? value.toString() : value), encoding: 'utf8', timeout: 10000 });
    assert.equal(setup.status, 0, setup.stderr);
    const { createSelfUsageScope, createProjectUsageScope } = await import('../src/lib/usage/access');
    const { parseUsageQuery } = await import('../src/lib/usage/query');
    const { getUsageExportSnapshot, getUsageReport, readUsagePublicSnapshot } = await import('../src/lib/usage/personal');
    const { usageCsvChunks } = await import('../src/lib/usage/csv');
    const user = (id: string): SessionUser => ({ id, name: id, username: id, email: id + '@example.invalid',
      role: 'user', account_type: 'internal', user_profile: 'fixture', feature_profile_id: null, status: 'active', expires_at: null,
      feishu: { user_id: id, open_id: null, union_id: null, tenant_key: null, employee_no: null, department_ids: [], last_sync_at: null } });
    const self = createSelfUsageScope(user('self')), other = createSelfUsageScope(user('other'));
    const project = await createProjectUsageScope(user('self'), 'team');
    const dump = async (snapshot: UsageExportSnapshot) => {
      const records: unknown[] = [];
      for await (const row of snapshot.records.values()) records.push(row);
      let csv = ''; for await (const chunk of usageCsvChunks(snapshot)) csv += chunk;
      return { report: snapshot.report, records, csv };
    };
    const cases = [[self, 'video'], [self, 'image'], [project, 'video'], [project, 'image'], [other, 'video']] as const;
    for (const [scope, type] of cases) {
      const query = parseUsageQuery(new URLSearchParams({ month: '2026-11', time_zone: 'America/Los_Angeles', type }), scope);
      phase = 'candidate';
      const actualSnapshot = await getUsageExportSnapshot(scope, query);
      const asOf = actualSnapshot.report.asOf;
      const actual = await dump(actualSnapshot);
      assert.equal((await readdir(spoolRoot)).length, 0, 'CSV completion disposes its spool');
      phase = 'baseline';
      const oldSnapshot = await base.$transaction(tx => readUsagePublicSnapshot(tx, scope, query, asOf), { timeout: 30000 });
      const original = await dump(oldSnapshot);
      assert.deepEqual(actual, original, 'Same frozen data/asOf retains complete report, records and CSV');
      if (scope === self && type === 'video') {
        const ids = actual.report.records.items.map(row => row.id);
        assert.ok(ids.includes('video_task:own-video')); assert.ok(ids.includes('video_task:unassigned'));
        assert.ok(!ids.includes('video_task:other-video') && !ids.includes('video_task:revoked-video') && !ids.includes('video_task:deleted-video'));
      }
      details.push({ scope: scope.kind, type, rows: actual.records.length, reportSha256: sha(JSON.stringify(actual.report)), csvSha256: sha(actual.csv) });
    }
    checks.push('actual_public_exports_match_original_full_report_records_csv_self_project_and_other_owner');
    checks.push('original_owner_retention_and_revoked_project_intersection_preserved');
    phase = 'candidate';
    const query = parseUsageQuery(new URLSearchParams({ month: '2026-11', type: 'video' }), self);
    await getUsageReport(self, query);
    assert.equal((await readdir(spoolRoot)).length, 0);
    checks.push('ordinary_report_disposes_after_returning_same_projection');
    const count = logs.filter(row => row.event === 'spawn').length;
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(getUsageReport(self, query, aborted.signal), error => (error as Error).name === 'AbortError');
    assert.equal(logs.filter(row => row.event === 'spawn').length, count);
    checks.push('preaborted_public_request_opens_no_child_or_writer_client');

    const { withUsageReportAdmission, UsageReportBusyError } = await import('../src/lib/admin/usage-report-admission');
    let releaseBudget!: () => void;
    const held = withUsageReportAdmission(() => new Promise<void>(resolve => { releaseBudget = resolve; }));
    await Promise.resolve();
    const queuedAbort = new AbortController();
    const queued = getUsageReport(self, query, queuedAbort.signal); void queued.catch(() => {});
    await assert.rejects(withUsageReportAdmission(async () => null), error => error instanceof UsageReportBusyError);
    queuedAbort.abort(); await assert.rejects(queued, error => (error as Error).name === 'AbortError');
    assert.equal(logs.filter(row => row.event === 'spawn').length, count, 'Queued report must not spawn a reader');
    releaseBudget(); await held;
    checks.push('public_reports_share_existing_computation_budget_and_queued_abort_releases_without_child');

    phase = 'late-abort'; lateAbort = new AbortController();
    await assert.rejects(getUsageExportSnapshot(self, query, lateAbort.signal), error => (error as { code?: string }).code === 'USAGE_READ_ABORTED');
    assert.equal(lateAbort.signal.aborted, true, 'Abort must occur after the actual report capture returned');
    assert.equal((await readdir(spoolRoot)).length, 0, 'Late reader-close failure disposes the completed result spool');
    checks.push('late_cancel_after_capture_closes_child_and_disposes_completed_spool');
    const starts = logs.filter(row => row.event === 'spawn'), closes = logs.filter(row => row.event === 'child-close');
    assert.equal(starts.length, closes.length); assert.ok(starts.every(row => closes.some(close => close.childPID === row.childPID)));
    checks.push('all_real_readonly_children_closed_before_return_or_rejection');
    assert.equal(forbiddenCalls, 0);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, JSON.stringify({ schema: 'public-usage-readonly-engineering.v1', completed: true, synthetic: true,
      checks, details, productionDatabaseOpened: false, productionWrites: 0, forbiddenCalls, paidRequests: 0, browserRuns: 0,
      actualReaderChildren: starts.length, actualClosedChildren: closes.length,
      sourceSha256: Object.fromEntries(sources.map(file => [file, sha(readFileSync(path.join(root, file)))])),
      scope: 'Actual public report exports over isolated SQLite and real read-only child, compared with original Prisma report at same asOf; not browser acceptance' },
    null, 2), { flag: 'wx', mode: 0o600 });
    console.log('PUBLIC_USAGE_READONLY_RECEIPT=' + destination);
  } finally {
    phase = 'baseline'; await base.$disconnect();
    globalThis.fetch = previousFetch; console.error = previousError;
    for (const [key, value] of [['DATABASE_URL', prior.database], ['TMPDIR', prior.tmp], ['NODE_ENV', prior.node]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Public read-only engineering failed'); process.exitCode = 1; });
