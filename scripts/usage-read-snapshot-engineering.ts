import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { Prisma, PrismaClient } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';
import { withUsageReadSnapshot } from '../src/lib/usage/sqlite-read-snapshot';
import { usageRowSpool } from '../src/lib/usage/row-spool';

const require = createRequire(import.meta.url);
const fixedAsOf = '2026-11-01T12:00:00.000Z', epoch = Date.parse('2026-11-01T00:00:00.123Z');
const inputs = ['src/lib/usage/database.ts', 'src/lib/usage/facts.ts', 'src/lib/admin/usage-analytics.ts',
  'src/lib/usage/cost-ledger-read.ts', 'src/app/admin/costs/list-filters.ts', 'src/app/api/admin/costs/export/route.ts',
  'src/app/api/admin/usage-analytics/route.ts', 'src/app/api/admin/usage-analytics/records/route.ts', 'src/app/api/admin/usage-analytics/export/route.ts',
  'src/lib/usage/sqlite-read-snapshot.ts', 'scripts/usage-sqlite-reader.py', 'scripts/usage-read-snapshot-engineering.ts'];
const baselineFiles = ['src/lib/usage/facts.ts', 'src/lib/admin/usage-analytics.ts', 'src/app/api/admin/costs/export/route.ts', 'src/app/admin/costs/list-filters.ts'];

async function main() {
  const root = process.cwd(), destination = path.resolve(process.argv[2] || ''), baselineRoot = path.resolve(process.argv[3] || '');
  assert.ok(process.argv[2] && process.argv[3], 'Explicit receipt and original source roots required');
  assert.ok(baselineRoot !== root);
  for (const file of baselineFiles) assert.ok(existsSync(path.join(baselineRoot, file)), file);
  const sourceSha256 = Object.fromEntries(inputs.map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')]));
  const baselineSha256 = Object.fromEntries(baselineFiles.map(file => [file, createHash('sha256').update(readFileSync(path.join(baselineRoot, file))).digest('hex')]));
  const directory = await mkdtemp(path.join(tmpdir(), 'usage-read-snapshot-engineering-'));
  const spoolRoot = path.join(directory, 'spools'), filename = path.join(directory, 'fixture.db');
  const previous = { database: process.env.DATABASE_URL, tmp: process.env.TMPDIR, node: process.env.NODE_ENV };
  const { mkdir } = await import('node:fs/promises'); await mkdir(spoolRoot);
  process.env.DATABASE_URL = `file:${filename}`; process.env.TMPDIR = spoolRoot; Object.assign(process.env, { NODE_ENV: 'test' });
  const checks: string[] = [], details: Record<string, unknown> = {}, driverLogs: unknown[] = [];
  let forbiddenCalls = 0, active = false, starts = 0, closes = 0, finishes = 0;
  let fault: 'close' | 'capture' | null = null, cancelOnAdd: AbortController | null = null;
  const forbidden = (label: string): never => { forbiddenCalls++; throw new Error(`Offline fixture boundary: ${label}`); };
  const originalFetch = globalThis.fetch, originalError = console.error;
  globalThis.fetch = () => forbidden('network'); console.error = (...args: unknown[]) => { driverLogs.push(args); };
  let db: PrismaClient | null = null;
  try {
    // Recreate only disposable fixture tables with the generated client's declared
    // scalar affinities. No application DB, .env, migration command or writer loads.
    const quote = (name: string) => { assert.match(name, /^\w+$/); return `"${name}"`; };
    const ddl = Prisma.dmmf.datamodel.models.map(model => `CREATE TABLE ${quote(model.dbName || model.name)} (${model.fields.filter(field => field.kind !== 'object')
      .map(field => `${quote(field.dbName || field.name)} ${field.type === 'DateTime' ? 'DATETIME' : field.type === 'Boolean' ? 'BOOLEAN' : ['Int', 'BigInt'].includes(field.type) ? 'INTEGER' : ['Float', 'Decimal'].includes(field.type) ? 'DOUBLE' : 'TEXT'}${field.isId ? ' PRIMARY KEY' : ''}`)
      .join(',')});`).join('\n');
    const video = (id: string, extra = {}) => ({ id, provider: 'fixture', model: 'fixture-model', generation_mode: 'text', prompt: 'SYNTHETIC_NOT_EXPORTED',
      source_type: 'web', source_label: 'normal', source_metadata_json: '{}', user_id: 'owner', owner_user_id: 'owner', project_id: 'project',
      retention_status: 'active', local_status: 'succeeded', actual_cost: 1.25, frozen_cost: 0, refund_amount: 0,
      created_at: epoch, updated_at: epoch, ...extra });
    const ledger = (id: string, extra = {}) => ({ id, source_type: 'task', source_id: 'v0000', task_id: 'v0000', user_id: 'owner', project_id: 'project',
      provider_name: 'fixture', event_type: 'official_charge', amount_micros: 1250000, currency: 'USD', cost_source: 'official_bill', confidence: 'confirmed',
      occurred_at: epoch, created_at: epoch, ...extra });
    const seed: Record<string, Array<Record<string, unknown>>> = {
      User: [{ id: 'owner', name: 'Fixture Owner' }], Project: [{ id: 'project', name: 'Fixture Project' }],
      VideoTask: Array.from({ length: 501 }, (_, index) => video(`v${String(index).padStart(4, '0')}`)),
      ImageStudioTask: ['A', 'B'].map(scope => ({ id: `image-reference-${scope}`, owner_id: 'owner', model: 'fixture-model', prompt: 'SYNTHETIC_NOT_EXPORTED',
        status: 'succeeded', billing_status: 'settled', actual_credits: 0.5, unit_credits: 1, billing_settled_at: epoch,
        billing_scope: `scope-${scope}`, gateway_request_id: 'same-reference', asset_id: `image-asset-${scope}`, created_at: epoch, updated_at: epoch })),
      ProviderApiRequest: [{ id: 'request-only', task_id: 'v0001', provider_name: 'fixture', endpoint: '/synthetic', status: 'accepted' }],
      CostLedger: [ledger('cash-direct'), ledger('cash-request', { task_id: null, source_type: 'provider_request', source_id: 'request-only', provider_request_id: 'request-only' }),
        ledger('cash-alias', { task_id: null, source_type: 'video_task', source_id: 'v0002' }),
        ledger('cash-ref', { task_id: null, source_type: 'official_bill', source_id: null, provider_account_id: 'scope-A', provider_task_id: 'same-reference' }),
        ledger('cash-other-scope', { task_id: null, source_type: 'official_bill', source_id: null, provider_account_id: 'scope-B', provider_task_id: 'same-reference' }),
        ledger('cash-multi', { task_id: 'v0004', source_id: 'v0004', provider_request_id: 'request-only', official_charge_id: 'proof' }),
        ledger('cash-special', { amount_micros: -1250000, source_id: '=SUM(1,2)', reason: 'first\n"quoted"', usage_unit: '-formula', usage_quantity: 1.25 })],
      CreditLedger: [
        { id: 'points-freeze', type: 'task_freeze', amount: 0, frozen_before: 0, frozen_after: 3 },
        { id: 'points-charge', type: 'task_success_deduct', amount: -1.25, frozen_before: 3, frozen_after: 1.75 },
        { id: 'points-release', type: 'task_freeze_release', amount: 0, frozen_before: 1.75, frozen_after: 0 },
        { id: 'points-refund', type: 'task_refund', amount: 0.25, frozen_before: 0, frozen_after: 0 },
      ].map((row, index) => ({ ...row, user_id: 'owner', related_task_id: 'v0000', created_at: epoch + index, metadata_json: JSON.stringify({ unused_released: 0 }) })),
      CostAllocation: ['z-first', 'a-second', 'm-third'].map((id, index) => ({ id, ledger_id: 'cash-special', allocation_type: 'project', allocation_id: id,
        amount_minor: index, amount_micros: index * 1000, usage_quantity: 1.25, currency: 'USD', usage_unit: 'unit', created_at: epoch })),
    };
    seed.VideoTask[3].provider_task_id = 'same-reference';
    // Every nullable canvas combination and wildcard LIKE stay in the real SQL comparison.
    for (const [index, label, metadata] of [[0, null, null], [1, null, '{}'], [2, 'normal', null], [3, '无限画布', null], [4, null, '{"source":"ultimate_canvas"}']] as const) {
      const id = `canvas-${index}`; seed.VideoTask.push(video(id, { source_label: label, source_metadata_json: metadata })); seed.CostLedger.push(ledger(`canvas-cash-${index}`, { task_id: id }));
    }
    // A second page, equal timestamps and orphan rows exercise cursor semantics.
    for (let index = 0; index < 503; index++) seed.CostLedger.push(ledger(`page-${String(index).padStart(4, '0')}`, { task_id: null, source_id: null, occurred_at: epoch + index % 3, reason: index % 2 ? null : 'fixture' }));
    const setup = spawnSync('/usr/bin/python3', ['-c', `import json,sqlite3,sys\np=json.load(sys.stdin)\nc=sqlite3.connect(p['file'])\nc.executescript(p['ddl'])\nc.execute('CREATE INDEX CostAllocation_ledger_id_idx ON CostAllocation(ledger_id)')\nc.execute('CREATE INDEX CostLedger_occurred_at_idx ON CostLedger(occurred_at)')\nfor table,rows in p['seed'].items():\n for row in rows:\n  names=list(row)\n  c.execute('INSERT INTO "'+table+'" ('+','.join('"'+n+'"' for n in names)+') VALUES ('+','.join('?' for n in names)+')',[row[n] for n in names])\nc.commit()\nc.close()\n`],
      { input: JSON.stringify({ file: filename, ddl, seed }), encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } as unknown as NodeJS.ProcessEnv });
    assert.ifError(setup.error); assert.equal(setup.status, 0, setup.stderr);
    db = new PrismaClient({ datasources: { db: { url: `file:${filename}` } }, log: [] });
    const actualDb = db;
    const trace = { tracePhase: async (_phase: string, run: () => Promise<unknown>) => run(), traceHttpRequest: async (_op: string, _headers: unknown, run: () => Promise<Response>) => run() };
    const load = (file: string, baseline = false, instrument = false): any => {
      const cache = new Map<string, any>();
      const evaluate = (relative: string): any => {
        if (cache.has(relative)) return cache.get(relative);
        const origin = baseline && baselineFiles.includes(relative) ? baselineRoot : root;
        const text = readFileSync(path.join(origin, relative), 'utf8'), evaluated = { exports: {} };
        cache.set(relative, evaluated.exports);
        const code = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
        const resolve = (name: string): any => {
          if (name === 'server-only') return {};
          if (name === '@/lib/prisma') return { prisma: baseline && file.includes('/costs/export/') ? actualDb : new Proxy({}, { get: () => forbidden('application-prisma') }) };
          if (name === '@/lib/auth/api-helpers') return { getAdminUser: async () => ({ id: 'fixture-admin' }) };
          if (name === '@/lib/auth/session') return { AuthError: class extends Error {} };
          if (name === '@/lib/performance/request-trace') return trace;
          if (name === '@/lib/performance/server-operations') return { observeOperation: () => () => {} };
          if (name === 'next/server') return { NextRequest, NextResponse };
          const resolved = name.startsWith('@/') ? `src/${name.slice(2)}` : name.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(relative), name)) : null;
          if (resolved === 'src/lib/usage/sqlite-read-snapshot') return { withUsageReadSnapshot: async (capture: any, options: any = {}) => {
            starts++; active = true;
            try {
              const result = await withUsageReadSnapshot(capture, { ...options, dataAsOf: fixedAsOf });
              if (fault === 'close') throw new Error('synthetic handoff failure after real close');
              return result;
            } finally { active = false; closes++; }
          } };
          if (resolved === 'src/lib/usage/row-spool') return { usageRowSpool: async (compare: any) => {
            const spool = await usageRowSpool(compare);
            return { ...spool, add: async (rows: any[]) => {
              if (instrument && active && fault === 'capture') throw new Error('synthetic capture failure');
              await spool.add(rows); if (instrument && active && cancelOnAdd) cancelOnAdd.abort();
            }, finish: async () => { if (instrument) { assert.equal(active, false, 'finish/fold must follow reader close'); finishes++; } return spool.finish(); } };
          } };
          if (resolved) return evaluate(`${resolved}.ts`);
          if (name.startsWith('node:') || name === '@prisma/client') return require(name);
          return forbidden(`import:${name}`);
        };
        class FixedDate extends Date { constructor(value?: any) { super(value ?? fixedAsOf); } }
        new Function('require', 'module', 'exports', 'Date', code)(resolve, evaluated, evaluated.exports,
          relative === 'src/app/api/admin/costs/export/route.ts' ? FixedDate : Date);
        return evaluated.exports;
      };
      return evaluate(file);
    };
    const filters = load('src/app/admin/costs/list-filters.ts'), costs = load('src/lib/usage/cost-ledger-read.ts');
    const filterEvidence: unknown[] = [];
    for (const query of ['', 'source=web', 'source=ultimate_canvas', 'source=codex_api', 'resolution=unknown', 'keyword=%25', 'keyword=_', 'cost_status=pending', 'project_id=unassigned', 'date_from=2026-11-01&date_to=2026-11-01']) {
      const f = filters.parseCostListFilters(new URLSearchParams(query));
      const original = await actualDb.costLedger.findMany({ where: filters.costLedgerListWhere(f), select: costs.costLedgerExportSelect, orderBy: [{ occurred_at: 'desc' }, { id: 'desc' }] });
      const candidate = await withUsageReadSnapshot(async reader => {
        const total = await costs.countCostLedgers(reader, f), rows: any[] = []; let cursor: string | undefined;
        for (;;) { const batch = await costs.readCostLedgerBatch(reader, f, cursor); rows.push(...batch); if (batch.length < 500) break; cursor = batch.at(-1).id; }
        assert.equal(total, rows.length); return rows;
      }, { dataAsOf: fixedAsOf });
      assert.deepEqual(candidate, original, query || 'all');
      filterEvidence.push({ query, rows: original.length, idsSha: createHash('sha256').update(JSON.stringify(original.map(row => row.id))).digest('hex') });
    }
    details.costFilters = filterEvidence;
    details.allocationOrder = (await actualDb.costLedger.findUniqueOrThrow({ where: { id: 'cash-special' }, select: { allocations: costs.costLedgerExportSelect.allocations } })).allocations.map(row => row.allocation_id);
    checks.push('real_prisma_filters_null_canvas_like_relations_allocation_order_and_500_cursor_match');
    const baseline = load('src/lib/admin/usage-analytics.ts', true), candidate = load('src/lib/admin/usage-analytics.ts', false, true);
    const { parseUsageQuery } = load('src/lib/admin/usage-query.ts');
    const query = parseUsageQuery(new URLSearchParams('range=all'));
    const digest = async (snapshot: any) => {
      try {
        const rows = async (source: any) => { const values = []; if (Array.isArray(source)) return source; for await (const row of source.values()) values.push(row); return values; };
        return { report: snapshot.report, records: await rows(snapshot.records), cash: await rows(snapshot.cashEvents), members: snapshot.members, projects: snapshot.projects };
      } finally { await snapshot.dispose?.(); }
    };
    const original = await digest(await actualDb.$transaction(tx => baseline.readUsageAnalyticsSnapshot(tx, query, fixedAsOf), { timeout: 120000 }));
    const updated = await digest(await candidate.getUsageAnalyticsSnapshot(query));
    assert.deepEqual(updated, original);
    const settled = updated.records.find((fact: any) => fact.sourceId === 'v0000');
    assert.deepEqual({ charged: settled.chargedPoints, reserved: settled.reservedPoints, released: settled.releasedPoints, refunded: settled.refundedPoints },
      { charged: '1.25', reserved: '0', released: '1.75', refunded: '0.25' });
    details.closedPoints = { charged: settled.chargedPoints, reserved: settled.reservedPoints, released: settled.releasedPoints, refunded: settled.refundedPoints };
    const confirmed = updated.records.find((fact: any) => fact.sourceId === 'v0002');
    assert.equal(confirmed.costStatus, 'confirmed');
    assert.deepEqual(confirmed.confirmedCost, [{ currency: 'USD', amountMicros: '1250000' }]);

    assert.ok(updated.cash.some((event: any) => event.id === 'cash-request' && event.sourceKey === 'video_task:v0001'));
    assert.equal(updated.cash.find((event: any) => event.id === 'cash-ref').sourceKey, 'image_task:image-reference-A');
    assert.equal(updated.cash.find((event: any) => event.id === 'cash-other-scope').sourceKey, 'image_task:image-reference-B');
    details.outputSha = Object.fromEntries(Object.entries(updated).map(([key, value]) => [key, createHash('sha256').update(JSON.stringify(value)).digest('hex')]));
    checks.push('actual_fact_alias_request_only_scope_conflict_point_types_batch_boundaries_and_fingerprint_match');
    // Original Prisma infers an expression column's type across a result set.
    // The preserved attempt01 demonstrates INTEGER-first/REAL-next throws there;
    // independent single-row reads test the approved raw scalar boundary directly.
    const raw: any[] = [];
    const { usageDateTime } = load('src/lib/usage/database.ts');
    for (const unused of [0, 1, 1.25, null, '1', true]) {
      const statement = Prisma.sql`SELECT created_at, amount, json_extract(${JSON.stringify({ unused_released: unused })}, '$.unused_released') AS unused_released FROM CreditLedger WHERE id = 'points-charge'`;
      const [originalRow] = await actualDb.$queryRaw<any[]>(statement);
      const [readerRow] = await withUsageReadSnapshot(reader => reader.query(statement));
      assert.deepEqual({ ...readerRow, created_at: usageDateTime(readerRow.created_at) }, originalRow);
      raw.push(originalRow);
    }
    assert.ok(raw.every(row => row.created_at instanceof Date && typeof row.amount === 'number'));
    assert.deepEqual(raw.map(row => typeof row.unused_released), ['bigint', 'bigint', 'number', 'object', 'string', 'bigint']);
    details.pointScalarTypes = raw.map(row => ({ createdAt: row.created_at.toISOString(), amount: typeof row.amount, unused: typeof row.unused_released }));
    checks.push('real_prisma_datetime_float_json_integer_real_null_text_boolean_source_rows');
    // This order succeeds in original Prisma: REAL first, then INTEGER. Its
    // later dynamic values can be strings; pointVersions' existing replacer is
    // the contract, rather than normalizing all JSON scalars to one JS type.
    await actualDb.$executeRaw`UPDATE CreditLedger SET metadata_json = ${JSON.stringify({ unused_released: 1.25 })} WHERE id = 'points-freeze'`;
    await actualDb.$executeRaw`UPDATE CreditLedger SET metadata_json = ${JSON.stringify({ unused_released: 1 })} WHERE id = 'points-charge'`;
    const mixedOriginal = await digest(await actualDb.$transaction(tx => baseline.readUsageAnalyticsSnapshot(tx, query, fixedAsOf), { timeout: 120000 }));
    const mixedCandidate = await digest(await candidate.getUsageAnalyticsSnapshot(query));
    assert.deepEqual(mixedCandidate, mixedOriginal);
    assert.notEqual(mixedCandidate.report.reportFingerprint, updated.report.reportFingerprint);
    details.realThenIntegerFingerprint = mixedCandidate.report.reportFingerprint;
    checks.push('real_first_integer_later_common_success_keeps_complete_report_and_point_version_fingerprint');
    // Known successful DateTime text formats are checked at the actual column
    // boundary. The INTEGER-first/fractional and space-fraction failures remain
    // separately documented original failures, not broadened success claims.
    for (const value of ['2026-11-01 00:00:00', '2026-11-01T00:00:00.123Z', '2026-11-01T08:00:00.123+08:00']) {
      await actualDb.$executeRaw`UPDATE CreditLedger SET created_at = ${value} WHERE id = 'points-charge'`;
      const statement = Prisma.sql`SELECT created_at FROM CreditLedger WHERE id = 'points-charge'`;
      const [expected] = await actualDb.$queryRaw<any[]>(statement);
      const [received] = await withUsageReadSnapshot(reader => reader.query(statement));
      assert.equal(usageDateTime(received.created_at).toISOString(), expected.created_at.toISOString());
    }
    for (const value of ['2026-11-01 00:00:00.123', '2026-11-01T00:00:00.123']) assert.throws(() => usageDateTime(value), /DateTime text/);
    await actualDb.$executeRaw`UPDATE CreditLedger SET created_at = ${new Date(epoch + 1)} WHERE id = 'points-charge'`;
    checks.push('explicit_datetime_default_text_utc_and_rfc3339_column_mapping_matches_prisma');

    const clean = async () => assert.deepEqual(await readdir(spoolRoot), []);
    await clean();
    const oldRoute = load('src/app/api/admin/costs/export/route.ts', true), newRoute = load('src/app/api/admin/costs/export/route.ts', false, true);
    const request = () => new NextRequest('https://fixture.invalid/api/admin/costs/export');
    const oldResponse = await oldRoute.GET(request()), response = await newRoute.GET(request());
    assert.equal(response.status, 200); assert.equal(active, false);
    const oldBytes = Buffer.from(await oldResponse.arrayBuffer()), bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, oldBytes); details.csv = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    await clean(); checks.push('original_handler_full_csv_bytes_and_unconsumed_response_after_real_reader_close');
    const cancelledResponse = await newRoute.GET(request());
    assert.equal(active, false); await cancelledResponse.body!.cancel(); await clean();
    const sendingAbort = new AbortController();
    const abortedResponse = await newRoute.GET(new NextRequest('https://fixture.invalid/api/admin/costs/export', { signal: sendingAbort.signal }));
    assert.equal(abortedResponse.status, 200); sendingAbort.abort();
    const deadline = Date.now() + 5000;
    while ((await readdir(spoolRoot)).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    await clean(); checks.push('cost_stream_cancel_and_abort_without_later_pull_dispose_files_after_reader_close');
    for (const name of ['capture', 'close'] as const) {
      fault = name; await assert.rejects(candidate.getUsageAnalyticsSnapshot(query)); fault = null; await clean();
    }
    cancelOnAdd = new AbortController(); await assert.rejects(candidate.getUsageAnalyticsSnapshot(query, cancelOnAdd.signal)); cancelOnAdd = null; await clean();
    checks.push('capture_failure_close_handoff_failure_and_capture_abort_dispose_private_spools');
    const before = closes, childPage = await candidate.getUsageRecordPage('video_task', 'v0000', 1), unlinked = await candidate.getUsageUnlinkedPage(query);
    assert.equal(childPage.record.sourceId, 'v0000'); assert.ok(unlinked.total > 0); assert.equal(closes, before + 2); await clean();
    checks.push('record_and_unlinked_capture_close_before_fold');
    await actualDb.$disconnect(); db = null;
    assert.equal(forbiddenCalls, 0); assert.equal(starts, closes); assert.ok(finishes > 0);
    for (const [file, sha] of Object.entries(sourceSha256)) assert.equal(createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex'), sha, `Source changed during fixture: ${file}`);
    await rm(directory, { recursive: true, force: true });
    writeFileSync(destination, JSON.stringify({ checks, details, sourceSha256, baselineSha256, sessions: { starts, closes, finishes }, driverLogRecords: driverLogs.length,
      forbiddenCalls, productionWrites: 0, networkCalls: 0, isolatedDatabaseDeleted: !existsSync(directory), evidenceScope: 'Synthetic real SQLite/Prisma and actual reader. Full production clone and performance remain lead-owned.' }, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ checks: checks.length, receipt: destination }) + '\n');
  } finally {
    await db?.$disconnect(); await rm(directory, { recursive: true, force: true });
    globalThis.fetch = originalFetch; console.error = originalError;
    if (previous.database === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.database;
    if (previous.tmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous.tmp;
    if (previous.node === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV'); else Object.assign(process.env, { NODE_ENV: previous.node });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
