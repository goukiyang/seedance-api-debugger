import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { PrismaClient, type Prisma } from '@prisma/client';
import ts from 'typescript';
import * as trace from '../src/lib/performance/request-trace';
import * as contract from '../src/lib/performance/trace-contract';

type Exports = Record<string, any>;
type Log = { label: string; value: Record<string, any>; channel: 'stdout' | 'stderr' };
const root = realpathSync(process.cwd()), require = createRequire(import.meta.url);
const sources = ['src/lib/performance/request-trace.ts', 'src/lib/performance/trace-contract.ts', 'src/lib/catalog-directory-writes.ts',
  'src/lib/performance/server-operations.ts', 'src/lib/image-studio/read-snapshot.ts', 'scripts/request-trace-engineering.ts'];

async function main() {
  const startedAt = Date.now(), checks: string[] = [], logs: Log[] = [];
  const directory = await mkdtemp(path.join(tmpdir(), 'sd2-request-trace-fixture-'));
  const destination = process.argv[2] || '/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-11-01-admin-usage-read-snapshot/stage1-core-engineering.json';
  const previousDatabase = process.env.DATABASE_URL, previousNodeEnv = process.env.NODE_ENV;
  process.env.DATABASE_URL = `file:${directory}/observed.db`; Object.assign(process.env, { NODE_ENV: 'test' });
  const originalInfo = console.info, originalError = console.error;
  const capture = (channel: Log['channel'], label: unknown, value: unknown) => { logs.push({ label: String(label), value: JSON.parse(String(value)), channel }); };
  console.info = (label: unknown, value: unknown) => capture('stdout', label, value);
  console.error = (label: unknown, value: unknown) => capture('stderr', label, value);
  const clients: PrismaClient[] = [];
  let forbiddenCalls = 0, envOverrides = 0;
  const forbidden = (name: string): never => { forbiddenCalls++; throw new Error(`Unapproved fixture boundary: ${name}`); };
  function evaluate(file: string, imports: Exports, text = readFileSync(path.join(root, file), 'utf8')): Exports {
    const evaluated = { exports: {} };
    const compiled = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    new Function('require', 'module', 'exports', 'fetch', compiled)((name: string) => {
      if (Object.hasOwn(imports, name)) return imports[name];
      if (['node:async_hooks', 'node:crypto', 'node:perf_hooks'].includes(name)) return require(name);
      return forbidden(`import:${name}`);
    }, evaluated, evaluated.exports, () => forbidden('fetch'));
    return evaluated.exports;
  }
  async function database(name: string) {
    const url = `file:${directory}/${name}.db`;
    assert.ok(url.startsWith(`file:${directory}/`));
    // Disable generated-client dotenv lookup as well as explicitly binding the
    // datasource. No application Prisma entrypoint, .env or existing DB loads.
    const options = { datasources: { db: { url } }, log: [], __internal: { configOverride: (config: Record<string, unknown>) => {
      envOverrides++; return { ...config, relativeEnvPaths: { rootEnvPath: '', schemaEnvPath: '' } };
    } } };
    const db = new PrismaClient(options as Prisma.PrismaClientOptions); clients.push(db);
    await db.$executeRawUnsafe('CREATE TABLE PlatformSetting (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, value_json TEXT NOT NULL, updated_by TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    return db;
  }
  const revision = evaluate('src/lib/image-studio/catalog-revision.ts', { '@/lib/pricing/runtime': { assertPricingImageConsumerReady: () => forbidden('pricing-readiness') } });
  const loadWrapper = (baseline = false) => evaluate('src/lib/catalog-directory-writes.ts', {
    './image-studio/catalog-revision': revision, './performance/request-trace': trace,
  }, baseline ? execFileSync('git', ['show', '7513df5ce:src/lib/catalog-directory-writes.ts'], { cwd: root, encoding: 'utf8' }) : undefined).catalogDirectoryWrites as (client: PrismaClient) => PrismaClient;
  const headers = (id: string = randomUUID()) => new Headers({ [contract.TRACE_ID_HEADER]: id, [contract.TRACE_START_HEADER]: String(Date.now()) });
  const secret = 'SYNTHETIC_PROMPT_COOKIE_TOKEN_URL_DO_NOT_LOG';
  try {
    const imported = execFileSync(process.execPath, ['--import', 'tsx', '-e',
      "import('./src/lib/performance/request-trace.ts').then(module => { const trace = module.traceMetadata ? module : module.default; if (trace.traceMetadata().requestId !== null) process.exit(2); process.stdout.write('NODE_TRACE_IMPORT_OK'); })"],
    { cwd: root, env: { PATH: process.env.PATH, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 15000 });
    assert.equal(imported, 'NODE_TRACE_IMPORT_OK');
    checks.push('unshimmed_node_import_without_prisma_or_environment_loading');
    const baselineBase = await database('baseline'), observedBase = await database('observed');
    const wrap = loadWrapper(), db = wrap(observedBase), baseline = loadWrapper(true)(baselineBase);
    assert.equal(wrap(observedBase), db); assert.equal(wrap(db), db);
    const revisions = async (client: PrismaClient) => (await client.platformSetting.findMany({ where: { key: { startsWith: 'catalog_directory_revision_v1:' } }, orderBy: { key: 'asc' } })).map(row => [row.key, row.value_json]);
    const scenario = async (client: PrismaClient) => {
      const sentinel = { result: 'callback' };
      assert.equal(await client.$transaction(async tx => {
        await tx.platformSetting.create({ data: { key: 'studio_style_fixture:callback', value_json: secret } });
        return sentinel;
      }, { maxWait: 5000, timeout: 15000 }), sentinel);
      const first = await revisions(client); assert.equal(first.length, 2);
      const failure = Object.assign(new Error(secret), { name: secret, code: 'P1008' });
      await assert.rejects(client.$transaction(async tx => {
        await tx.platformSetting.create({ data: { key: 'studio_style_fixture:rollback', value_json: secret } });
        throw failure;
      }), error => error === failure);
      assert.equal(await client.platformSetting.count({ where: { key: 'studio_style_fixture:rollback' } }), 0);
      assert.deepEqual(await revisions(client), first);
      const array = await client.$transaction([
        client.platformSetting.create({ data: { key: 'studio_style_fixture:batch', value_json: 'batch-value' } }),
        client.platformSetting.count({ where: { key: 'studio_style_fixture:callback' } }),
      ]);
      assert.equal(array.length, 2); assert.equal(array[0].key, 'studio_style_fixture:batch'); assert.equal(array[1], 1);
      const second = await revisions(client); assert.notDeepEqual(second, first);
      await assert.rejects(client.$transaction([
        client.platformSetting.create({ data: { key: 'studio_style_fixture:batch-rollback', value_json: secret } }),
        client.platformSetting.create({ data: { key: 'studio_style_fixture:batch', value_json: secret } }),
      ]), error => (error as { code?: string }).code === 'P2002');
      assert.equal(await client.platformSetting.count({ where: { key: 'studio_style_fixture:batch-rollback' } }), 0);
      assert.deepEqual(await revisions(client), second);
      const implicit = await client.platformSetting.create({ data: { key: 'studio_style_fixture:implicit', value_json: 'implicit-value' } });
      assert.equal(implicit.key, 'studio_style_fixture:implicit');
      const third = await revisions(client); assert.notDeepEqual(third, second);
      assert.deepEqual(await client.platformSetting.updateMany({ where: { key: 'studio_style_fixture:missing' }, data: { value_json: secret } }), { count: 0 });
      assert.deepEqual(await revisions(client), third);
      const business = await client.platformSetting.findMany({ where: { key: { startsWith: 'studio_style_fixture:' } }, orderBy: { key: 'asc' }, select: { key: true, value_json: true } });
      return { business, revisionKeys: third.map(row => row[0]), shape: [array[0].key, array[1], implicit.key] };
    };
    const expected = await scenario(baseline);
    const requestId = randomUUID();
    const actual = await trace.traceServerRequest('studio.modules', headers(requestId), () => trace.tracePhase('module-dto', () => scenario(db)));
    assert.deepEqual(actual, expected);
    const txLogs = logs.filter(log => log.value.event === 'transaction-settled');
    assert.equal(txLogs.length, 6); assert.equal(new Set(txLogs.map(log => log.value.txId)).size, 6);
    assert.ok(txLogs.every(log => log.value.requestId === requestId && log.value.phase === 'module-dto'));
    for (const { value } of txLogs) {
      assert.ok(value.settledEpochMs >= value.requestedEpochMs); assert.ok(value.elapsedMs >= 0);
      if (value.kind === 'batch') { assert.equal(value.enteredEpochMs, null); assert.equal(value.bodyMs, null); assert.equal(value.settleMs, null); }
      else { assert.ok(value.enteredEpochMs >= value.requestedEpochMs); assert.ok(value.bodyEndEpochMs >= value.enteredEpochMs); assert.ok(value.settledEpochMs >= value.bodyEndEpochMs); }
    }
    checks.push('real_prisma_callback_array_implicit_commit_rollback_revision_and_result_match_original_wrapper');

    const captured = db.$transaction, originalTransaction = observedBase.$transaction;
    let calls = 0;
    Reflect.set(observedBase, '$transaction', (...args: unknown[]) => { calls++; return Reflect.apply(captured, db, args); });
    const before = logs.filter(log => log.value.event === 'transaction-settled').length;
    const sentinel = { captured: true };
    try {
      assert.equal(await trace.traceServerRequest('admin.page', headers(), () => db.$transaction(async () => sentinel)), sentinel);
      const array = await db.$transaction([db.platformSetting.create({ data: { key: 'studio_style_fixture:captured-array', value_json: 'captured-array' } })]);
      assert.equal(array.length, 1); assert.equal(array[0].key, 'studio_style_fixture:captured-array');
      assert.equal(calls, 2);
    } finally { Reflect.set(observedBase, '$transaction', originalTransaction); }
    assert.equal(logs.filter(log => log.value.event === 'transaction-settled').length - before, 2);
    assert.equal(await captured(async () => 17), 17);
    checks.push('repeat_wrapper_captured_callable_reentry_is_nonrecursive_single_span_and_original_array_shape');

    const duplicate = evaluate('src/lib/performance/request-trace.ts', { 'server-only': {}, './trace-contract': contract });
    const one = randomUUID(), two = randomUUID(), seen: Array<{ requestId: string | null; phase: unknown; txId: string | null }> = [];
    const perRequest = (id: string) => trace.traceServerRequest('studio.settings', headers(id), async () => {
      await Promise.all((['settings', 'channels'] as const).map(phase => trace.tracePhase(phase, async () => {
        await new Promise<void>(resolve => setImmediate(resolve));
        const current = duplicate.traceMetadata(); seen.push(current);
        assert.equal(current.requestId, id); assert.equal(current.phase, phase);
        assert.equal(current.txId, null);
      })));
      assert.equal(trace.traceMetadata().phase, null);
    });
    await Promise.all([perRequest(one), perRequest(two)]);
    assert.equal(seen.length, 4); assert.equal(trace.traceMetadata().requestId, null);
    checks.push('parallel_requests_and_promise_all_phase_siblings_are_isolated_across_duplicate_bundles');

    const response = new Response(new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } }), { status: 206, headers: { 'Cache-Control': 'private, no-store', 'X-Fixture': 'preserved' } });
    const originalBody = response.body;
    assert.equal(await trace.traceHttpRequest('admin.usage-export', headers(one), async () => response), response);
    assert.equal(response.body, originalBody); assert.equal(response.status, 206); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(response.headers.get(contract.TRACE_ID_HEADER), one); assert.equal(response.bodyUsed, false); await response.body!.cancel();
    const redirected = Object.assign(new Error(secret), { digest: 'NEXT_REDIRECT;' + secret });
    const notFound = Object.assign(new Error(secret), { digest: 'NEXT_NOT_FOUND' });
    for (const error of [redirected, notFound]) await assert.rejects(trace.traceServerRequest('admin.page', headers(), async () => { throw error; }), value => value === error);
    await trace.traceServerRequest('avatar.read', new Headers({ [contract.TRACE_ID_HEADER]: secret, [contract.TRACE_START_HEADER]: secret }), async () => {
      assert.match(trace.traceMetadata().requestId!, /^[a-f0-9-]{36}$/); assert.notEqual(trace.traceMetadata().requestId, secret);
    });
    checks.push('http_response_identity_body_cache_status_preserved_and_ssr_thrown_values_unchanged');

    const capacity = evaluate('src/lib/performance/server-operations.ts', { './request-trace': trace });
    const snapshot = evaluate('src/lib/image-studio/read-snapshot.ts', { '@/lib/prisma': { prisma: db, retrySqliteBusy: (run: () => Promise<unknown>) => run() },
      '@/lib/performance/server-operations': capacity, '@/lib/performance/request-trace': trace });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), active = new Promise<void>(resolve => { entered = resolve; });
    const first = trace.traceServerRequest('studio.modules', headers(one), () => snapshot.readSharedStudioSnapshot(async (tx: Prisma.TransactionClient) => {
      const holder = snapshot.sharedStudioReadDiagnostics().active;
      assert.equal(holder.requestId, one); assert.equal(holder.txId, trace.traceMetadata().txId); assert.ok(holder.txId);
      entered(); await gate; return tx.platformSetting.count();
    }, 'modules'));
    await active;
    const second = trace.traceServerRequest('studio.shared', headers(two), () => snapshot.readSharedStudioSnapshot(async () => {
      assert.equal(snapshot.sharedStudioReadDiagnostics().active.requestId, two); return 'second';
    }, 'catalog'));
    assert.equal(snapshot.sharedStudioReadDiagnostics().pending, 2); release();
    const values = await Promise.all([first, second]); assert.equal(typeof values[0], 'number'); assert.equal(values[1], 'second');
    assert.equal(snapshot.sharedStudioReadDiagnostics().pending, 0); assert.equal(snapshot.sharedStudioReadDiagnostics().active, null);
    const savedInfo = console.info, savedError = console.error;
    console.info = console.error = () => { throw new Error(secret); };
    try {
      assert.equal(await trace.traceServerRequest('studio.shared', headers(), () => snapshot.readSharedStudioSnapshot(async () => 29, 'gallery')), 29);
      const error = Object.assign(new Error(secret), { code: 'P2002' });
      await assert.rejects(trace.traceServerRequest('studio.shared', headers(), () => snapshot.readSharedStudioSnapshot(async () => { throw error; }, 'definition')), value => value === error);
    } finally { console.info = savedInfo; console.error = savedError; }
    assert.equal(snapshot.sharedStudioReadDiagnostics().pending, 0); assert.equal(snapshot.sharedStudioReadDiagnostics().active, null);
    checks.push('existing_shared_read_queue_holder_ids_and_release_survive_log_failure_without_behavior_change');

    assert.equal(contract.traceOperationForPath('/api/image-studio/module-covers/preset/' + secret), 'studio.cover-media');
    assert.equal(contract.traceOperationForPath('/api/image-studio/modules/' + secret + '/cover'), 'studio.cover-editor');
    assert.equal(contract.traceOperationForPath('/admin/usage-records/video_task/' + secret), 'admin.usage-record-page');
    assert.equal(contract.traceOperationForPath('/untraced/' + secret), null);
    assert.equal(contract.traceOperationForPath('/api/release'), 'release.read');
    assert.equal(contract.traceOperationForPath('/api/admin/costs/export'), 'admin.cost-ledger-export');
    const output = JSON.stringify(logs);
    assert.ok(!output.includes(secret)); assert.ok(!output.includes('NEXT_REDIRECT')); assert.ok(!output.includes('value_json'));
    assert.ok(logs.every(log => ['[RequestTrace]', '[Capacity]', '[StudioSharedRead]'].includes(log.label)));
    assert.ok(logs.filter(log => log.label === '[RequestTrace]').every(log => log.channel === 'stderr'));
    assert.ok(logs.filter(log => log.label === '[RequestTrace]').every(log => log.value.at && typeof log.value.epochMs === 'number' && typeof log.value.mono === 'number' && log.value.pid === process.pid));
    assert.ok(logs.some(log => log.value.errorCode === 'P1008')); assert.ok(logs.some(log => log.value.errorCode === 'P2002'));
    assert.equal(forbiddenCalls, 0); assert.equal(envOverrides, 2);
    checks.push('fixed_operation_paths_generated_ids_and_error_whitelist_never_log_sensitive_inputs');
    writeFileSync(destination, JSON.stringify({ schema: 'request-trace-engineering.v1', completed: true, synthetic: true,
      candidateRoot: root, startedAt, finishedAt: Date.now(), checks, sourceSha256: Object.fromEntries(sources.map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')])),
      realPrismaClients: clients.length, isolatedSqliteDatabases: 2, envFilesLoaded: false, forbiddenCalls, traceRecords: logs.length,
      productionWrites: 0, productionDatabaseOpened: false, browserRuns: 0,
      scope: 'Real Prisma and disposable SQLite for wrapper contracts; request/phase/context and log safety; not production timing or functional acceptance' }), { flag: 'wx', mode: 0o600 });
  } finally {
    await Promise.all(clients.map(client => client.$disconnect())); console.info = originalInfo; console.error = originalError;
    if (previousDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabase;
    if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV'); else Object.assign(process.env, { NODE_ENV: previousNodeEnv });
    await rm(directory, { recursive: true, force: true });
  }
  console.log('REQUEST_TRACE_ENGINEERING_RECEIPT=' + destination);
}
void main().catch(error => { console.error(error instanceof Error ? error.stack : 'Request trace engineering failed'); process.exitCode = 1; });
