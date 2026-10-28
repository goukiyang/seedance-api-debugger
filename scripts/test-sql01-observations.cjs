'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), ts = require('typescript');
const { AsyncLocalStorage } = require('node:async_hooks');
const phase = process.env.SQL01_PHASE || 'red'; assert.match(phase, /^[a-z0-9_-]+$/i);
const results = [], root = process.cwd();
async function test(name, fn) { try { await fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: e.stack }); } }
function runtime(extra = {}) {
  let now = Date.parse('2026-10-28T02:00:00Z'), clock = 0, ids = 0;
  class FixtureDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({ Buffer, console, URLSearchParams, AbortSignal, performance: { now: () => clock }, Date: FixtureDate,
    process: { env: { NODE_ENV: 'test', SD2_DATABASE_MODE: 'writer', DATABASE_URL: 'postgresql://synthetic.invalid/test' }, cwd: () => '/synthetic', pid: 123 },
    setTimeout: () => ({ unref() {} }), ...extra });
  const cache = new Map();
  function load(file, imports = {}) {
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} }; cache.set(file, mod);
    const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const req = name => {
      if (Object.hasOwn(imports, name)) return imports[name];
      if (name === 'node:async_hooks') return { AsyncLocalStorage };
      if (name === 'node:crypto') return { ...require(name), randomUUID: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}` };
      if (name === 'node:path') return path;
      if (name === './observations') return load('src/lib/database/observations.ts');
      if (name === './process-mode') return { assertDatabaseWriterMode() {} };
      throw new Error(`Unapproved fixture import ${name}`);
    };
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename: file })(req, mod, mod.exports);
    return mod.exports;
  }
  return { context, load, at: value => { now = value; }, tick: value => { clock += value; } };
}
function alertFixture() {
  const jobs = new Map(), sent = [], config = { enabled: true, recipientId: 'synthetic-admin', identity: 'pinned', appId: 'synthetic-app', tenant: 'synthetic-tenant' };
  const admin = { id: config.recipientId, feishu_open_id: 'synthetic-open-id' };
  let trusted = true, ambiguous = false, duringSend, casFailures = 0;
  const db = { user: { findUnique: async () => admin }, notification: {
    upsert: async ({ where, create }) => { if (!jobs.has(where.id)) jobs.set(where.id, { ...create, created_at: new Date() }); return structuredClone(jobs.get(where.id)); },
    findUnique: async ({ where }) => structuredClone(jobs.get(where.id) || null),
    findMany: async () => [...jobs.values()].filter(job => job.status === 'pending').map(job => structuredClone(job)),
    updateMany: async ({ where, data }) => {
      if (casFailures > 0) { casFailures--; return { count: 0 }; }
      const job = jobs.get(where.id); if (!job || job.status !== where.status || job.metadata_json !== where.metadata_json) return { count: 0 };
      Object.assign(job, data); return { count: 1 };
    },
  } };
  const r = runtime({ fetch: async (url, options) => {
    assert.equal(url, 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id'); assert.equal(options.redirect, 'error');
    sent.push(JSON.parse(options.body)); if (duringSend) { const call = duringSend; duringSend = undefined; await call(); }
    if (ambiguous) throw new Error('private provider error'); return { ok: true, json: async () => ({ code: 0 }) };
  } });
  const alert = r.load('src/lib/database/alerts.ts', { '@/lib/prisma': { prisma: db }, '@/lib/feedback/notification': {
    feedbackConfig: () => config, validFeedbackRecipient: () => trusted }, '@/lib/feedback/delivery': { feedbackTenantToken: async () => 'synthetic-token' } });
  const row = (id, changes = {}) => ({ minute: '2026-10-28T02:00:00.000Z', p1008: 0, p2028: 1, p2024: 0,
    transactions: 2, transactionMs: 15008, maxTransactionMs: 15005, succeeded: 1, failed: 1, outcomeUnknown: 0,
    reporter: { id, pid: 123, consumer: 'application-writer' }, dimensions: [], ...changes });
  return { ...r, jobs, sent, config, alert, row, now: new Date('2026-10-28T02:01:00Z'), trust: v => { trusted = v; },
    ambiguous: v => { ambiguous = v; }, during: v => { duringSend = v; }, failCas: v => { casFailures = v; } };
}
async function main() {
  await test('actual observation records P1008/P2028/P2024 once each without sensitive values', () => {
    const r = runtime(), o = r.load('src/lib/database/observations.ts');
    for (const code of ['P1008', 'P2028', 'P2024']) { const e = Object.assign(new Error('private SQL path username prompt'), { code, meta: { query: 'secret' } }); o.observeDatabaseError(e); o.observeDatabaseError(e); }
    o.observeDatabaseError(Object.assign(new Error('private'), { code: 'P9999' }));
    const s = o.databaseObservations(), row = s.minutes[0];
    assert.equal(row.p1008, 1); assert.equal(row.p2028, 1); assert.equal(row.p2024, 1);
    assert.equal(s.scope, 'process'); assert.match(s.durationScope, /queue.*execution.*failure/); assert.equal(s.heldLockTimeMeasured, false);
    assert(!JSON.stringify(s).includes('private')); assert(!JSON.stringify(s).includes('secret')); assert(!JSON.stringify(s).includes('/synthetic'));
  });
  await test('metrics-only scope preserves sync return/throw and isolated async branches with finite dimensions', async () => {
    const r = runtime(), o = r.load('src/lib/database/observations.ts');
    const object = {}; assert.equal(o.withDatabaseObservationScope('image-studio.shared', () => object), object);
    const failure = new Error('private'); assert.throws(() => o.withDatabaseObservationScope('private-user/path', () => { throw failure; }), e => e === failure);
    await Promise.all(['image-studio.shared', 'video-task.create', 'video-task.draft-upgrade'].map(scope => o.withDatabaseObservationScope(scope, async () => {
      await Promise.resolve(); const captured = o.databaseTransactionStarted(); o.databaseTransactionFinished(15005, 'failed', 'interactive', captured);
    })));
    for (let i = 0; i < 1000; i++) o.withDatabaseObservationScope(`/private/user-${i}`, () => o.observeDatabaseError({ code: 'P2024' }, 'private-query'));
    const s = o.databaseObservations(), row = s.minutes[0];
    assert.equal(row.failed, 3); assert.equal(row.succeeded, 0); assert.equal(row.maxTransactionMs, 15005);
    for (const scope of ['image-studio.shared', 'video-task.create', 'video-task.draft-upgrade']) assert(row.dimensions.some(d => d.scope === scope && d.category === 'interactive' && d.failed === 1));
    assert(row.dimensions.length <= 25); assert(!JSON.stringify(s).includes('user-')); assert(!JSON.stringify(s).includes('private-query'));
    const before = row.transactionMs; row.transactionMs = -1; assert.equal(o.databaseObservations().minutes[0].transactionMs, before);
  });
  await test('actual database facade separates outcome and call category without rerouting/options changes', async () => {
    const r = runtime(), seen = []; let failure, constructions = 0;
    class FakeClient {
      constructor(options) { constructions++; seen.push(options); }
      $extends() { return { $transaction: async (...args) => { seen.push(args); r.tick(15005); if (failure) throw failure; return 'same-result'; } }; }
    }
    const c = r.load('src/lib/database/client.ts', { '@prisma/client': { PrismaClient: FakeClient }, 'node:fs/promises': {} });
    const o = r.load('src/lib/database/observations.ts'), callback = async () => 'unused', options = { timeout: 5000, maxWait: 2000 };
    assert.equal(await o.withDatabaseObservationScope('video-task.create', () => c.applicationDatabase.$transaction(callback, options)), 'same-result');
    failure = Object.assign(new Error('private'), { code: 'P2028' }); const input = [];
    await assert.rejects(c.applicationDatabase.$transaction(input, options), error => error === failure);
    assert.equal(seen[1][0], callback); assert.equal(seen[1][1], options); assert.equal(seen[2][0], input); assert.equal(seen[2][1], options); assert.equal(constructions, 1);
    const row = o.databaseObservations().minutes[0]; assert.equal(row.succeeded, 1); assert.equal(row.failed, 1); assert.equal(row.p2028, 1);
    assert(row.dimensions.some(d => d.category === 'batch' && d.failed === 1)); assert(row.dimensions.some(d => d.scope === 'video-task.create' && d.succeeded === 1));
  });
  await test('retention stays60 minutes and old metrics/API remain compatible but unknown outcomes honest', () => {
    const r = runtime(), o = r.load('src/lib/database/observations.ts');
    for (let i = 0; i < 100; i++) { r.at(Date.parse('2026-10-28T02:00:00Z') + i * 60000); o.databaseTransactionStarted(); o.databaseTransactionFinished(1234); }
    const s = o.databaseObservations(); assert.equal(s.minutes.length, 60);
    assert(s.minutes.every(row => row.transactions === 1 && row.outcomeUnknown === 1 && row.maxTransactionMs === 1234 && row.transactionMs === 1234));
  });
  await test('scheduled reporting cannot inherit the business scope that first armed the timer', async () => {
    const timers = []; let finished; const done = new Promise(resolve => { finished = resolve; });
    const r = runtime({ setTimeout: callback => { timers.push(callback); return { unref() {} }; } });
    let o; o = r.load('src/lib/database/observations.ts', { './alerts': { flushDatabaseAlerts: async () => {
      o.observeDatabaseError({ code: 'P2024' }); finished();
    } } });
    o.withDatabaseObservationScope('image-studio.shared', () => o.databaseWriterReady());
    o.withDatabaseObservationScope('video-task.create', () => timers[0]()); await done;
    const row = o.databaseObservations().minutes[0];
    assert(row.dimensions.some(item => item.scope === 'unscoped' && item.p2024 === 1));
    assert(!row.dimensions.some(item => item.scope === 'video-task.create'));
  });
  await test('P2028/P2024 alerts trigger even with p1008=0 and fast failed call; minute coalescing retains reporter snapshots without sums', async () => {
    const h = alertFixture(); const a = '00000000-0000-4000-8000-000000000001', b = '00000000-0000-4000-8000-000000000002';
    await h.alert.flushDatabaseAlerts([h.row(a, { maxTransactionMs: 10 })], h.now);
    await h.alert.flushDatabaseAlerts([h.row(b, { p2028: 0, p2024: 2, transactions: 7 })], h.now);
    assert.equal(h.jobs.size, 1); assert.equal(h.sent.length, 1);
    const job = [...h.jobs.values()][0], meta = JSON.parse(job.metadata_json);
    assert.equal(meta.reports.length, 2); assert.equal(meta.reports[0].transactions, 2); assert.equal(meta.reports[1].transactions, 7);
    assert(!/contention observed/i.test(job.title)); assert.match(job.body, /not.*site|not.*global/i);
    await h.alert.flushDatabaseAlerts([h.row(a, { transactions: 3 })], h.now);
    assert.equal(JSON.parse([...h.jobs.values()][0].metadata_json).reports.find(r => r.reporter.id === a).transactions, 3);
    assert.equal(h.sent.length, 1);
    await h.alert.flushDatabaseAlerts([h.row(a, { transactions: 2, p2028: 0 })], h.now);
    const retained = JSON.parse([...h.jobs.values()][0].metadata_json).reports.find(r => r.reporter.id === a);
    assert.equal(retained.transactions, 3); assert.equal(retained.p2028, 1);
  });
  await test('concurrent reporting cannot invalidate a successful send receipt or change fixed retry payload/UUID', async () => {
    const h = alertFixture(), a = '00000000-0000-4000-8000-000000000001', b = '00000000-0000-4000-8000-000000000002';
    h.during(() => h.alert.flushDatabaseAlerts([h.row(b)], h.now));
    await h.alert.flushDatabaseAlerts([h.row(a)], h.now);
    assert.equal(h.sent.length, 1); assert.equal([...h.jobs.values()][0].status, 'sent'); assert.equal(JSON.parse([...h.jobs.values()][0].metadata_json).reports.length, 2);
    const unknown = alertFixture(); unknown.ambiguous(true);
    await unknown.alert.flushDatabaseAlerts([unknown.row(a)], unknown.now);
    await unknown.alert.flushDatabaseAlerts([unknown.row(b)], unknown.now);
    assert.equal(unknown.sent.length, 1);
    await unknown.alert.flushDatabaseAlerts([], new Date(+unknown.now + 100000));
    assert.equal(unknown.sent.length, 2); assert.equal(unknown.sent[0].uuid, unknown.sent[1].uuid); assert.equal(unknown.sent[0].content, unknown.sent[1].content);
    await unknown.alert.flushDatabaseAlerts([], new Date(+unknown.now + 51 * 60000));
    assert.equal(unknown.sent.length, 2); assert.equal([...unknown.jobs.values()][0].status, 'failed');
  });
  await test('untrusted recipients and current/expired minutes remain blocked; legacy pending metadata still delivers safely', async () => {
    const h = alertFixture(); h.trust(false); await h.alert.flushDatabaseAlerts([h.row('00000000-0000-4000-8000-000000000001')], h.now); assert.equal(h.jobs.size, 0);
    h.trust(true); await h.alert.flushDatabaseAlerts([h.row('00000000-0000-4000-8000-000000000001', { minute: h.now.toISOString() })], h.now); assert.equal(h.jobs.size, 0);
    const meta = { minute: '2026-10-28T02:00:00.000Z', p1008: 1, transactions: 1, maxTransactionMs: 3,
      identity: h.config.identity, appId: h.config.appId, tenant: h.config.tenant, firstSendAt: null, leaseUntil: null, attempts: 0 };
    h.jobs.set('legacy-uuid', { id: 'legacy-uuid', target_user_id: h.config.recipientId, type: 'audit_database_v1', channel: 'feishu', status: 'pending', metadata_json: JSON.stringify(meta) });
    await h.alert.flushDatabaseAlerts([], h.now); assert.equal(h.sent.length, 1); assert.equal(h.sent[0].uuid, 'legacy-uuid'); assert.match(h.sent[0].content, /legacy|unknown/i);
  });
  await test('v1 unknown-send upgrade retains its exact old payload and fixed UUID, not a rewritten notification', async () => {
    const h = alertFixture();
    const meta = { minute: '2026-10-28T02:00:00.000Z', p1008: 1, transactions: 1, maxTransactionMs: 3,
      identity: h.config.identity, appId: h.config.appId, tenant: h.config.tenant, firstSendAt: +h.now - 100000, leaseUntil: +h.now - 1000, attempts: 1 };
    const { createHash } = require('node:crypto'), id = createHash('sha256').update(`audit_database_v1:${meta.minute}:${h.config.recipientId}`).digest('hex').slice(0, 32);
    h.jobs.set(id, { id, target_user_id: h.config.recipientId, type: 'audit_database_v1', channel: 'feishu', status: 'pending', metadata_json: JSON.stringify(meta) });
    await h.alert.flushDatabaseAlerts([h.row('00000000-0000-4000-8000-000000000001')], h.now);
    assert.equal(h.sent.length, 1); assert.equal(h.sent[0].uuid, id);
    assert.equal(JSON.parse(h.sent[0].content).text, `SQLite contention observed\nScope: reporting process (minute deduplicated)\nSQLite minute: ${meta.minute}\nP1008: 1\nTransactions: 1\nMax transaction ms: 3`);
    assert.equal(JSON.parse(h.jobs.get(id).metadata_json).reports.length, 2);
  });
  await test('reporter and call dimensions are capped with explicit incomplete scope, not silently summed or resent', async () => {
    const h = alertFixture();
    for (let i = 1; i <= 30; i++) await h.alert.flushDatabaseAlerts([h.row(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)], h.now);
    const job = [...h.jobs.values()][0], meta = JSON.parse(job.metadata_json);
    assert.equal(h.jobs.size, 1); assert.equal(h.sent.length, 1); assert.equal(meta.reports.length, 16); assert.equal(meta.reportsTruncated, true);
    assert.match(job.body, /details capped/); assert.equal(meta.transactions, 2);
    assert(!job.body.includes('calls=60'));
    const bad = h.row('private-user-path', { dimensions: Array.from({ length: 1000 }, () => ({ scope: '/secret/user', category: 'SELECT private', p1008: 1 })) });
    await h.alert.flushDatabaseAlerts([bad], h.now); assert(!JSON.stringify([...h.jobs.values()]).includes('/secret')); assert(!JSON.stringify([...h.jobs.values()]).includes('private-user'));
  });
  await test('CAS conflict retries are bounded, retained reports retry without extra send, stale/future minutes do not create jobs', async () => {
    const h = alertFixture(), row = h.row('00000000-0000-4000-8000-000000000001');
    h.failCas(3); await assert.rejects(() => h.alert.flushDatabaseAlerts([row], h.now), /metadata_conflict/);
    assert.equal(h.sent.length, 0); assert.equal(h.jobs.size, 1);
    await h.alert.flushDatabaseAlerts([row], h.now); assert.equal(h.sent.length, 1); assert.equal(h.jobs.size, 1);
    await h.alert.flushDatabaseAlerts([h.row('00000000-0000-4000-8000-000000000002', { minute: '2026-10-28T00:00:00.000Z' }),
      h.row('00000000-0000-4000-8000-000000000002', { minute: '2026-10-28T03:00:00.000Z' })], h.now);
    assert.equal(h.jobs.size, 1); assert.equal(h.sent.length, 1);
  });
  await test('only owned files syntax-transpile without a full typecheck/build or native database', () => {
    for (const file of ['src/lib/database/observations.ts', 'src/lib/database/client.ts', 'src/lib/database/alerts.ts', 'scripts/verify-sql01-observations-server.ts']) {
      const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, reportDiagnostics: true,
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
      assert.equal((result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0, file);
    }
  });
  const evidence = { phase, scope: 'Actual observations/client/alerts source, synthetic client+Notification CAS and fake transport only; no native Prisma or real send', results,
    passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length };
  fs.writeFileSync(`.role-tests/sql01-observations-${phase}.json`, JSON.stringify(evidence, null, 2), { flag: 'wx' }); console.log(JSON.stringify(evidence)); if (evidence.failed) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
