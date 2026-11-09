import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { traceMetadata } from '../src/lib/performance/request-trace';

type Api = typeof import('../src/lib/admin/usage-report-admission');
const files = ['src/lib/admin/usage-report-admission.ts', 'src/lib/admin/usage-analytics.ts',
  'src/app/api/admin/usage-analytics/route.ts', 'src/app/api/admin/usage-analytics/records/route.ts',
  'src/app/api/admin/usage-analytics/export/route.ts', 'src/components/admin-usage/AdminUsageClient.tsx',
  'scripts/usage-report-admission-engineering.ts'];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const text = (file: string) => readFileSync(path.resolve(file), 'utf8');
const sourceSha256 = Object.fromEntries(files.map(file => [file, sha(text(file))]));
const startedAt = new Date().toISOString(), runId = process.env.IMAGE_RECOVERY_GATE_RUN_ID || randomUUID();
const checks: string[] = [], log = console.info;
const latch = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
const globalState = globalThis, timers = new Map<number, { run: () => void; ms: number }>(); let nextTimer = 0;
function load(): Api {
  const code = ts.transpileModule(text(files[0]), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'globalThis', 'setTimeout', 'clearTimeout', code)(
    (name: string) => { assert.equal(name, '@/lib/performance/request-trace'); return { traceMetadata }; }, module, module.exports, globalState,
    (run: () => void, ms: number) => { const id = ++nextTimer; timers.set(id, { run, ms }); return id; },
    (id: number) => timers.delete(id));
  return module.exports as Api;
}
const a = load(), b = load();
async function main() {
  console.info = () => {};
  assert.notEqual(a.withUsageReportAdmission, b.withUsageReportAdmission, 'Independent module closures required');
  let active = 0, maximum = 0; const order: string[] = [];
  const first = latch();
  const one = a.withUsageReportAdmission(async () => { active++; maximum = Math.max(maximum, active); order.push('overview'); await first.promise; active--; return 'snapshot'; });
  await tick();
  const two = b.withUsageReportAdmission(async () => { active++; maximum = Math.max(maximum, active); order.push('records'); active--; return 'second'; });
  await assert.rejects(a.withUsageReportAdmission(async () => { throw Error('must-not-run'); }), error => error instanceof a.UsageReportBusyError && error.status === 429);
  assert.deepEqual(order, ['overview']); first.resolve();
  assert.equal(await one, 'snapshot'); assert.equal(await two, 'second');
  assert.equal(maximum, 1); assert.deepEqual(order, ['overview', 'records']);
  checks.push('independent_next_bundle_modules_share_one_active_slot_one_fifo_waiter_and_429');
  const held = latch(), controller = new AbortController();
  const running = a.withUsageReportAdmission(async () => held.promise);
  const cancelled = b.withUsageReportAdmission(async () => { throw Error('cancelled-must-not-run'); }, controller.signal);
  const rejected = assert.rejects(cancelled, error => error instanceof Error && error.name === 'AbortError');
  controller.abort(); await rejected;
  const replacement = b.withUsageReportAdmission(async () => 'replacement'); held.resolve(); await running;
  assert.equal(await replacement, 'replacement');
  checks.push('queued_abort_removes_waiter_immediately_and_preserves_running_work');
  const timeoutHeld = latch();
  const current = a.withUsageReportAdmission(async () => timeoutHeld.promise);
  const expired = b.withUsageReportAdmission(async () => { throw Error('expired-must-not-run'); });
  const expiry = assert.rejects(expired, error => error instanceof b.UsageReportBusyError && error.status === 429);
  assert.equal(timers.size, 1); const timer = Array.from(timers.values())[0]; assert.equal(timer.ms, 10000); timer.run();
  await expiry; const afterTimeout = b.withUsageReportAdmission(async () => 'after-timeout'); timeoutHeld.resolve(); await current;
  assert.equal(await afterTimeout, 'after-timeout');
  checks.push('actual_ten_second_queue_timeout_removes_waiter_and_returns_explicit_busy');
  const boom = new Error('actual-callback-failure');
  await assert.rejects(a.withUsageReportAdmission(async () => { throw boom; }), error => error === boom);
  assert.equal(await b.withUsageReportAdmission(async () => 'recovered'), 'recovered');
  const already = new AbortController(); already.abort();
  await assert.rejects(a.withUsageReportAdmission(async () => { throw Error('pre-aborted-must-not-run'); }, already.signal), error => error instanceof Error && error.name === 'AbortError');
  checks.push('callback_failure_and_preaborted_request_release_without_poisoning_global_state');
  const activeAbort = new AbortController(), cleanup = latch();
  const aborting = a.withUsageReportAdmission(async () => { await cleanup.promise; throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); }, activeAbort.signal);
  const abortResult = assert.rejects(aborting, error => error instanceof Error && error.name === 'AbortError');
  let nextEntered = false;
  const next = b.withUsageReportAdmission(async () => { nextEntered = true; }); activeAbort.abort(); await tick();
  assert.equal(nextEntered, false, 'Active cancellation must await actual capture/fold cleanup'); cleanup.resolve(); await abortResult; await next;
  checks.push('active_abort_holds_slot_until_actual_reader_and_spool_cleanup_settles');
  const slowDownload = latch();
  const snapshot = await a.withUsageReportAdmission(async () => ({ stream: slowDownload.promise }));
  assert.equal(await b.withUsageReportAdmission(async () => 'next-report'), 'next-report'); slowDownload.resolve(); await snapshot.stream;
  checks.push('returned_snapshot_releases_compute_slot_before_slow_csv_delivery');
  const ast = ts.createSourceFile(files[1], text(files[1]), ts.ScriptTarget.Latest, true);
  const snapshotFunction = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'getUsageAnalyticsSnapshot') as ts.FunctionDeclaration;
  assert.equal(snapshotFunction.body!.statements.length, 1);
  const returned = snapshotFunction.body!.statements[0] as ts.ReturnStatement, call = returned.expression as ts.CallExpression;
  assert.equal(call.expression.getText(ast), 'withUsageReportAdmission'); assert.equal(call.arguments[1].getText(ast), 'signal');
  const callback = call.arguments[0] as ts.ArrowFunction;
  assert.ok(callback.body.getText(ast).includes('withUsageReadSnapshot(') && callback.body.getText(ast).includes('foldUsageAnalytics(') && callback.body.getText(ast).includes('await spool.dispose()'));
  for (const file of files.slice(2, 5)) { const source = text(file); assert.ok(source.includes("from '@/lib/admin/usage-report-admission'")); assert.ok(source.includes('error instanceof UsageReportBusyError')); assert.ok(source.includes("'Retry-After': '3'")); assert.ok(source.includes(file.includes('/export/') ? 'getUsageAnalyticsSnapshot(query, request.signal)' : 'getUsageAnalytics(')); }
  const exporter = text(files[4]); assert.ok(exporter.indexOf('await getUsageAnalyticsSnapshot(') < exporter.indexOf('streamUsageCsv(snapshot,'));
  checks.push('three_actual_admin_routes_share_full_capture_fold_admission_and_csv_starts_after_snapshot');
  const clientAst = ts.createSourceFile(files[5], text(files[5]), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const requests: string[] = []; let download = '';
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(clientAst) === 'fetch') requests.push(node.arguments[0].getText(clientAst));
    if (ts.isVariableDeclaration(node) && node.name.getText(clientAst) === 'download') download = node.initializer!.getText(clientAst); ts.forEachChild(node, visit); };
  visit(clientAst);
  assert.equal(requests.length, 2); assert.ok(requests.some(value => value.includes('/usage-analytics?')) && requests.some(value => value.includes('/usage-analytics/export?')));
  assert.ok(!requests.some(value => value.includes('/usage-analytics/records')));
  assert.ok(!download.includes('setReload') && !download.includes('正在同步当前分析') && download.includes('X-Usage-Data-As-Of') && download.includes('exportSummary(response.headers)'));
  assert.ok(text(files[5]).includes('page={report.records}') && text(files[5]).includes('重新读取'));
  checks.push('existing_first_page_uses_report_records_and_export_has_no_automatic_second_capture');
  assert.equal(timers.size, 0);
  for (const [file, hash] of Object.entries(sourceSha256)) assert.equal(sha(text(file)), hash, file);
  const output = path.resolve(process.argv[2] || `.role-tests/usage-report-admission-${runId}.json`); mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, JSON.stringify({ schema: 'usage-report-admission-engineering.v1', synthetic: true, completed: true, runId, startedAt, finishedAt: new Date().toISOString(),
    forbiddenCalls: 0, productionWrites: 0, fixtureSha256: sourceSha256['scripts/usage-report-admission-engineering.ts'], checks, sourceSha256,
    independentModuleInstances: 2, actualTenSecondTimerInvokedWithoutWaiting: true, sqlCalls: 0, paidRequests: 0, browserRuns: 0,
    scope: 'Actual admission module scheduling plus AST wiring of actual consumers; no report recomputation or HTTP functional acceptance' }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.info = log; console.info(`Usage report admission engineering receipt: ${output}`);
}
void main().catch(error => { console.info = log; console.error(error); process.exitCode = 1; });
