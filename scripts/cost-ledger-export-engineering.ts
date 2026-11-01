import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { NextRequest, NextResponse } from 'next/server';
import * as currency from '../src/lib/costs/currency';
import * as filters from '../src/app/admin/costs/list-filters';
import { usageRowSpool } from '../src/lib/usage/row-spool';

type Ledger = Record<string, unknown> & { id: string };
type Fault = 'prepare' | 'commit' | 'finish' | 'prepare_abort';
const sourceFile = 'src/app/api/admin/costs/export/route.ts';
const fixedTime = Date.parse('2026-10-31T12:00:00.000Z');

async function main() {
  const root = realpathSync(process.cwd()), startedAt = Date.now();
  const destination = path.resolve(process.argv[2] || '');
  assert.ok(destination.startsWith(path.join(root, '.role-tests') + path.sep));
  const sources = [sourceFile, 'scripts/cost-ledger-export-engineering.ts', 'scripts/server-runtime.cjs',
    'src/lib/usage/row-spool.ts', 'src/lib/costs/currency.ts', 'src/app/admin/costs/list-filters.ts'];
  const sourceSha256 = Object.fromEntries(sources.map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')]));
  const previousTmp = process.env.TMPDIR;
  const directory = await mkdtemp(path.join(tmpdir(), 'cost-export-engineering-'));
  process.env.TMPDIR = directory;
  const checks: string[] = [];
  let forbiddenCalls = 0, queryCalls = 0, expectedFailures = 0, largestSendRead = 0;
  const forbidden = (label: string): never => { forbiddenCalls++; throw new Error(`Unapproved offline boundary: ${label}`); };
  const clean = async () => assert.deepEqual(await readdir(directory), [], 'No private spool directory may remain');
  const waitClean = async () => {
    const deadline = Date.now() + 5000;
    while ((await readdir(directory)).length && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
    await clean();
  };
  const ledger = (index: number): Ledger => ({ id: `fixture-${String(index).padStart(6, '0')}`,
    occurred_at: new Date(fixedTime - index * 1000), created_at: new Date(fixedTime - index * 1000), source_type: 'task',
    source_id: 'fixture-task', event_type: 'official_charge', cost_source: 'official_bill', confidence: 'confirmed',
    provider_name: 'fixture-provider', provider_account_id: 'fixture-account', provider_task_id: 'fixture-reference',
    provider_request_id: null, task_id: null, project_id: null, user_id: null, amount_minor: null, amount_micros: -1250000,
    currency: 'USD', usage_quantity: 2, usage_unit: 'seconds', official_charge_id: 'fixture-proof', pricing_rule_id: null,
    idempotency_key: null, reason: 'fixture', allocations: [], task: null, provider_request: null, project: null });
  class FixtureAuthError extends Error { constructor(message: string, public status: number) { super(message); } }
  class FixedDate extends Date { constructor(value?: string | number) { super(value ?? fixedTime); } static now() { return fixedTime; } }
  const compiled = ts.transpileModule(readFileSync(path.join(root, sourceFile), 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  function fixture(rows: Ledger[], fault?: Fault) {
    const abort = new AbortController();
    const observed = { active: false, committed: false, batches: 0, adds: 0, finishes: 0, returns: 0, reads: 0,
      maximumBatch: 0, peakMergeReaders: 0, responseErrors: 0 };
    const prisma = { $transaction: async (run: (tx: unknown) => Promise<unknown>, options: { timeout: number }) => {
      assert.equal(options.timeout, 120000); observed.active = true;
      try {
        const value = await run({ costLedger: {
          count: async () => { assert.equal(observed.active, true); return rows.length; },
          findMany: async (args: { take: number; cursor?: { id: string }; skip?: number; orderBy: unknown }) => {
            assert.equal(observed.active, true); assert.equal(args.take, 500);
            assert.equal(JSON.stringify(args.orderBy), JSON.stringify([{ occurred_at: 'desc' }, { id: 'desc' }]));
            queryCalls++; observed.batches++;
            if (fault === 'prepare' && observed.batches === 2) throw new Error('synthetic preparation failure');
            const offset = args.cursor ? rows.findIndex(row => row.id === args.cursor!.id) + (args.skip || 0) : 0;
            return rows.slice(offset, offset + args.take);
          },
        } });
        if (fault === 'commit') throw new Error('synthetic commit failure');
        observed.committed = true;
        return value;
      } finally { observed.active = false; }
    } };
    const modules: Record<string, unknown> = {
      'next/server': { NextRequest, NextResponse }, '@/lib/prisma': { prisma },
      '@/lib/auth/session': { AuthError: FixtureAuthError }, '@/lib/auth/api-helpers': { getAdminUser: async () => ({ id: 'fixture-admin' }) },
      '@/lib/costs/currency': currency, '@/app/admin/costs/list-filters': filters,
      '@/lib/usage/row-spool': { usageRowSpool: async (compare: (left: string, right: string) => number) => {
        const spool = await usageRowSpool<string>(compare);
        return { ...spool,
          add: async (values: string[]) => {
            assert.equal(observed.active, true); observed.adds++;
            await spool.add(values);
            if (fault === 'prepare_abort') abort.abort();
          },
          finish: async () => {
            assert.equal(observed.active, false); assert.equal(observed.committed, true); observed.finishes++;
            if (fault === 'finish') throw new Error('synthetic spool finish failure');
            const prepared = await spool.finish();
            observed.maximumBatch = prepared.metrics.maxBatchRows; observed.peakMergeReaders = prepared.metrics.peakMergeReaders;
            return { ...prepared, values: () => {
              const iterator = prepared.values(), next = iterator.next.bind(iterator), close = iterator.return.bind(iterator);
              iterator.next = async () => { assert.equal(observed.active, false); observed.reads++; return next(); };
              iterator.return = async value => { observed.returns++; return close(value); };
              return iterator;
            } };
          },
        };
      } },
    };
    const exports: { GET?: (request: NextRequest) => Promise<NextResponse> } = {};
    vm.runInNewContext(compiled, { exports, TextEncoder, ReadableStream, Date: FixedDate, Error, console: {
      error: () => { observed.responseErrors++; expectedFailures++; },
    }, fetch: () => forbidden('fetch'), require: (name: string) => {
      if (!Object.hasOwn(modules, name)) return forbidden(`import:${name}`);
      return modules[name];
    } }, { filename: sourceFile, timeout: 10000 });
    assert.equal(typeof exports.GET, 'function');
    return { abort, observed, run: () => exports.GET!(new NextRequest('https://fixture.invalid/api/admin/costs/export', { signal: abort.signal })) };
  }
  try {
    const empty = fixture([]), emptyResponse = await empty.run();
    assert.equal(emptyResponse.status, 200); assert.equal(empty.observed.active, false); assert.equal(empty.observed.committed, true);
    assert.equal(emptyResponse.headers.get('X-Export-Total'), '0');
    assert.equal(emptyResponse.headers.get('X-Data-As-Of'), new Date(fixedTime).toISOString());
    const emptyBytes = Buffer.from(await emptyResponse.arrayBuffer()), emptyText = emptyBytes.toString('utf8');
    assert.deepEqual(Array.from(emptyBytes.subarray(0, 3)), [239, 187, 191]);
    assert.ok(emptyText.startsWith('\uFEFF"ledger_id","occurred_at"')); assert.ok(emptyText.endsWith('"data_as_of"\n'));
    assert.equal(emptyText.split('\n').length, 2); await clean(); checks.push('zero_rows_preserve_bom_header_lf_and_snapshot_headers');

    const specialRow = { ...ledger(0), reason: 'first\n"quoted"', source_id: '=SUM(1,2)', provider_name: ' +formula', usage_unit: '-formula' };
    const special = fixture([specialRow]), specialResponse = await special.run();
    const specialText = Buffer.from(await specialResponse.arrayBuffer()).toString('utf8');
    for (const cell of ['"first\n""quoted"""', '"\'=SUM(1,2)"', '"\' +formula"', '"\'-formula"', '"-1250000"']) assert.ok(specialText.includes(cell), cell);
    assert.ok(!specialText.includes('"\'-1250000"')); await clean(); checks.push('original_csv_newline_quote_formula_string_and_negative_number_rules');

    const orderedRows = Array.from({ length: 8501 }, (_, index) => ledger(index));
    const many = fixture(orderedRows), manyResponse = await many.run();
    assert.equal(many.observed.active, false); assert.equal(many.observed.committed, true);
    assert.equal(manyResponse.status, 200); assert.equal(manyResponse.headers.get('X-Export-Total'), '8501');
    assert.equal(many.observed.adds, 18); assert.equal(many.observed.maximumBatch, 500); assert.equal(many.observed.peakMergeReaders, 16);
    const manyText = Buffer.from(await manyResponse.arrayBuffer()).toString('utf8');
    const exportedIds = manyText.split('\n').slice(1, -1).map(line => line.slice(1, line.indexOf('"', 1)));
    assert.deepEqual(exportedIds, orderedRows.map(row => row.id)); assert.ok(many.observed.returns > 0);
    await clean(); checks.push('more_than_16_real_spool_runs_keep_original_full_order_and_500_row_bound');

    for (const fault of ['prepare', 'commit', 'finish', 'prepare_abort'] as const) {
      const failed = fixture(Array.from({ length: 1001 }, (_, index) => ledger(index)), fault), response = await failed.run();
      assert.equal(response.status, 500, fault); assert.equal(response.headers.get('X-Export-Total'), null, fault);
      assert.equal(failed.observed.active, false); assert.ok(failed.observed.adds > 0, fault);
      if (fault === 'prepare_abort') assert.equal(failed.observed.batches, 1, 'Cancellation must stop later preparation batches');
      if (fault === 'prepare' || fault === 'commit' || fault === 'prepare_abort') assert.equal(failed.observed.finishes, 0);
      await clean(); checks.push(`${fault}_cannot_return_success_and_removes_private_spool`);
    }

    const cancel = fixture([ledger(0)]), cancelledResponse = await cancel.run();
    assert.equal(cancel.observed.active, false); assert.equal(cancel.observed.committed, true);
    const roots = await readdir(directory); assert.equal(roots.length, 1);
    const spoolRoot = path.join(directory, roots[0]); assert.equal((await stat(spoolRoot)).mode & 0o777, 0o700);
    for (const file of await readdir(spoolRoot)) assert.equal((await stat(path.join(spoolRoot, file))).mode & 0o777, 0o600);
    await cancelledResponse.body!.cancel(); assert.ok(cancel.observed.returns > 0); await clean();
    checks.push('unconsumed_body_has_no_transaction_and_cancel_without_pull_removes_private_files');

    const sending = fixture(Array.from({ length: 1001 }, (_, index) => ledger(index))), sendingResponse = await sending.run();
    const reader = sendingResponse.body!.getReader();
    assert.equal((await reader.read()).done, false);
    const firstBatch = await reader.read(); assert.equal(firstBatch.done, false);
    largestSendRead = Buffer.from(firstBatch.value!).toString('utf8').split('\n').length - 1;
    assert.equal(largestSendRead, 500);
    await reader.cancel(); assert.ok(sending.observed.returns > 0); await clean();
    checks.push('cancel_during_real_file_delivery_without_further_pull_closes_iterator_and_files');

    const aborted = fixture([ledger(0)]), abortedResponse = await aborted.run();
    aborted.abort.abort(); await waitClean(); assert.ok(aborted.observed.returns > 0);
    await assert.rejects(abortedResponse.arrayBuffer(), /Cost ledger export interrupted/);
    checks.push('request_abort_without_further_pull_errors_stream_and_removes_private_files');

    const readFailure = fixture([ledger(0)]), brokenResponse = await readFailure.run();
    const readRoots = await readdir(directory); assert.equal(readRoots.length, 1);
    const readRoot = path.join(directory, readRoots[0]);
    const readFiles = await readdir(readRoot); assert.equal(readFiles.length, 1);
    await rm(path.join(readRoot, readFiles[0]));
    await assert.rejects(brokenResponse.arrayBuffer(), /ENOENT/);
    assert.ok(readFailure.observed.returns > 0); await clean(); checks.push('actual_file_read_error_rejects_body_and_disposes_iterator_and_files');

    assert.equal(forbiddenCalls, 0);
    for (const file of sources) assert.equal(createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex'), sourceSha256[file]);
    writeFileSync(destination, JSON.stringify({ schema: 'cost-ledger-export-engineering.v1', completed: true, synthetic: true,
      runId: process.env.IMAGE_RECOVERY_GATE_RUN_ID, candidateRoot: root, startedAt, finishedAt: Date.now(), checks, sourceSha256,
      queryCalls, expectedFailures, largestSendRead, forbiddenCalls, applicationDatabaseOpened: false, productionWrites: 0,
      paidRequests: 0, browserRuns: 0, privateDirectoriesAfter: 0,
      scope: 'Actual handler VM with real filesystem spool and injected read-only transaction lifecycle; not SQL correctness, production bytes or functional acceptance' }), { flag: 'wx', mode: 0o600 });
    console.log('COST_LEDGER_EXPORT_ENGINEERING_RECEIPT=' + destination);
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    await rm(directory, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
