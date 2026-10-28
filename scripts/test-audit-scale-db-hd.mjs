import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const native = createRequire(path.join(process.env.AUD_NODE_MODULES || path.join(root, 'node_modules'), 'package.json'));
const ts = native('typescript');
process.env.FEISHU_FEEDBACK_ENABLED = 'false';
function loader(mocks = {}, expose = {}) {
  const cache = new Map();
  function load(file) {
    file = path.resolve(root, file);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const source = fs.readFileSync(file, 'utf8') + (expose[file] || '');
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const req = name => {
      if (name in mocks) return mocks[name];
      if (name.startsWith('node:')) return createRequire(file)(name);
      let target = name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : name.startsWith('.') ? path.resolve(path.dirname(file), name) : null;
      if (!target) throw new Error('unmocked_external:' + name);
      if (!path.extname(target)) target += '.ts';
      return load(target);
    };
    new Function('require', 'module', 'exports', '__filename', '__dirname', js)(req, module, module.exports, file, path.dirname(file));
    return module.exports;
  }
  return load;
}

const job = () => ({ key: 'a'.repeat(64), source: '/uploads/wanted.png', version: 'v1', status: 'queued', priority: 0, attempts: 0, updatedAt: new Date().toISOString() });
const repositoryFixture = db => ({
  assetById: id => db.asset.findUnique({ where: { id } }),
  referenceById: id => db.referenceImage.findUnique({ where: { id } }),
  assetsAtUrls: urls => db.asset.findMany({ where: { original_url: { in: urls } }, take: 2 }),
  referencesAtUrls: urls => db.referenceImage.findMany({ where: { url: { in: urls } }, take: 2 }),
});
function ownerHarness(size = 10000) {
  let queries = 0; const sourceReads = [];
  const rows = Array.from({ length: size }, (_, i) => ({ id: 'a' + i, owner_id: 'owner', status: 'active', type: 'image', original_url: '/uploads/' + i + '.png' }));
  rows.push({ id: 'wanted', owner_id: 'owner', status: 'active', type: 'image', original_url: '/uploads/wanted.png' });
  const db = {
    asset: { findMany: async args => {
      queries++;
      if (args.where.original_url) assert.deepEqual(Object.keys(args.where), ['original_url']);
      return rows.filter(row => !args.where.original_url || args.where.original_url.in.includes(row.original_url)).slice(0, args.take || Infinity);
    },
      findUnique: async ({ where }) => { queries++; return rows.find(row => row.id === where.id) || null; } },
    referenceImage: { findMany: async () => { queries++; return []; }, findUnique: async () => { queries++; return null; } },
  };
  const load = loader({ './hd-readonly-db': { hdReadRepository: repositoryFixture(db) },
    './hd-derivatives': { hdSource: async source => { sourceReads.push(source); return { file: source, version: 'v1' }; } },
    './hd-encoder': { hdEncoderStrategy: value => value || 'hd-legacy-e6-v1' },
  }, { [path.join(root, 'src/lib/media/hd-scheduler.ts')]: '\nexport { resolveOwner };' });
  return { scheduler: load('src/lib/media/hd-scheduler.ts'), rows, db, stats: () => ({ queries, sourceReads }) };
}
test('actual scheduler: 10,000 unrelated assets require bounded queries and no unrelated file reads', async () => {
  const h = ownerHarness(); const result = await h.scheduler.resolveOwner(job());
  assert.equal(result.ownerId, 'owner');
  assert.ok(h.stats().queries <= 2, JSON.stringify(h.stats()));
  assert.equal(h.stats().sourceReads.length, 1, 'only the target source may be read');
  assert.equal(h.stats().sourceReads[0], '/uploads/wanted.png');
});

test('actual client entrypoints: exactly one construction, SQLite connection_limit=1', async () => {
  const configs = [];
  class FakeClient {
    constructor(config) { configs.push(config); }
    $queryRawUnsafe() { return Promise.resolve([]); }
    $extends() { return this; }
  }
  const prior = process.env.DATABASE_URL; process.env.DATABASE_URL = 'file:/tmp/audit-scale-fake.db';
  try {
    delete globalThis[Symbol.for('video-api.database-client.v1')];
    const load = loader({ '@prisma/client': { PrismaClient: FakeClient }, '@/lib/navigation': {}, './attachments': {} });
    const { prisma } = load('src/lib/prisma.ts');
    assert.equal(load('src/lib/db.ts').prisma, prisma);
    load('src/lib/media/hd-readonly-db.ts');
    assert.equal(load('src/lib/feedback/notification.ts').feedbackPrisma, prisma);
    await prisma.$connect();
    assert.equal(configs.length, 1);
    assert.match(configs[0].datasources.db.url, /connection_limit=1/);
  } finally { if (prior === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prior; }
});

test('actual scheduler: server context validation, persisted evidence, version and ambiguous legacy', async () => {
  const h = ownerHarness();
  const result = await h.scheduler.resolveOwner(job(), { owner: { kind: 'asset', id: 'wanted', ownerId: 'owner' }, requesterId: 'viewer' });
  assert.equal(result.ownerId, 'owner'); assert.equal(result.sourceVersion, 'v1');
  assert.equal(h.stats().queries, 1);
  await assert.rejects(h.scheduler.resolveOwner(job(), { owner: { kind: 'asset', id: 'wanted', ownerId: 'viewer' } }), /mismatch/);
  const before = h.stats().queries;
  assert.equal((await h.scheduler.resolveOwner({ ...job(), ownerEvidence: result })).ownerId, 'owner');
  assert.equal(h.stats().queries, before, 'persisted evidence needs no database lookup');
  await assert.rejects(h.scheduler.resolveOwner({ ...job(), version: 'v2', ownerEvidence: result }), /source_changed/);
  await assert.rejects(h.scheduler.resolveOwner({ ...job(), ownerEvidence: { ...result, sourceVersion: 'v0' } }), /invalid_hd_owner_evidence/);
  await assert.rejects(h.scheduler.resolveOwner({ ...job(), source: 'https://untrusted.invalid/uploads/wanted.png' },
    { owner: { kind: 'asset', id: 'wanted', ownerId: 'owner' } }), /mismatch/);
  h.rows.push({ ...h.rows.at(-1), id: 'duplicate', owner_id: 'different' });
  assert.equal((await h.scheduler.resolveOwner(job())).kind, 'legacy');
  h.rows.length = 0;
  assert.equal((await h.scheduler.resolveOwner(job(), { requesterId: 'viewer' })).kind, 'legacy');
  h.db.referenceImage.findMany = async args => {
    assert.equal(args.take, 2); assert.deepEqual(Object.keys(args.where), ['url']); assert.ok(args.where.url.in.includes(job().source));
    return [{ id: 'reference', owner_user_id: 'author', status: 'active', asset_id: null, album: { status: 'active' } }];
  };
  assert.equal((await h.scheduler.resolveOwner(job())).ownerId, 'author');
  h.db.referenceImage.findUnique = async () => ({ owner_user_id: 'author', status: 'active', album: { status: 'active' }, url: 'https://sd2.youdoodesign.com/uploads/wanted.png' });
  assert.equal((await h.scheduler.resolveOwner(job(), { owner: { kind: 'reference', id: 'reference', ownerId: 'author' } })).ownerId, 'author');
});

function selectedFunctions(file, names, bindings) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const selected = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(selected.length, names.length);
  const code = selected.map(node => node.getText(source)).join('\n');
  const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function('exports', ...Object.keys(bindings), js + '\n' + names.map(name => `exports.${name} = ${name};`).join('\n'))(exports, ...Object.values(bindings));
  return exports;
}
test('actual requestHd: persists validated owner before lease and retains old ready source key', async () => {
  const h = ownerHarness();
  let leased = false; const records = new Map();
  const sourceReads = [];
  const owner = loader({ './hd-readonly-db': { hdReadRepository: repositoryFixture(h.db) } })('src/lib/media/hd-owner.ts');
  const { createHash } = await import('node:crypto');
  const bindings = { ...owner, createHash, HD_POLICY: 'hd-f-v1', imageDecoderVersions: { sharp: 'synthetic' },
    hdEncoderStrategy: value => value || 'hd-legacy-e6-v1', defaultHdEncoderStrategy: () => 'hd-avif-e4-v1',
    hdSource: async source => { sourceReads.push(source); return { file: source, version: 'v1' }; },
    readHdJob: async key => records.get(key) || null, hdQueueRole: () => 'new', roleRank: { new: 1 }, now: () => new Date().toISOString(),
    withLease: async (_key, run) => { leased = true; try { return await run(); } finally { leased = false; } },
    validateHdOwner: async (...args) => { assert.equal(leased, false); return owner.validateHdOwner(...args); },
    atomicHdJson: async (_file, value) => records.set(value.key, value), jobPath: key => key,
    require: () => ({ registerHdScheduling: async () => {} }),
  };
  const api = selectedFunctions('src/lib/media/hd-derivatives.ts', ['hdRequestIdentity', 'registeredHd', 'requestHd'], bindings);
  const result = await api.requestHd(job().source, 0, false, undefined, { owner: { kind: 'asset', id: 'wanted', ownerId: 'owner' } });
  assert.equal(result.ownerEvidence.ownerId, 'owner');
  assert.equal(result.ownerEvidence.sourceVersion, 'v1');
  assert.equal(records.get(result.key).ownerEvidence.id, 'wanted');
  assert.equal(sourceReads.every(source => source === job().source), true);
  records.clear();
  const historical = await api.hdRequestIdentity(job().source, true, 'hd-legacy-e6-v1');
  records.set(historical.key, { ...result, key: historical.key, preserveText: true, encoderStrategy: 'hd-legacy-e6-v1', status: 'ready', format: 'original' });
  assert.equal((await api.requestHd(job().source)).key, historical.key, 'old ready key survives changed metadata lookup');
});

function clientHarness({ failInit = false } = {}) {
  delete globalThis[Symbol.for('video-api.database-client.v1')];
  const calls = []; let hook; let failure = failInit; let constructions = 0;
  const delegate = { findMany: async () => { calls.push('SELECT'); return []; }, create: async () => { calls.push('INSERT'); return {}; } };
  class FakeClient {
    constructor(config) { constructions++; calls.push(config); this.asset = delegate; }
    async $queryRawUnsafe(sql) { calls.push(sql); if (failure) { failure = false; throw Object.assign(new Error('private'), { code: 'P1008' }); } return []; }
    async $disconnect() { calls.push('DISCONNECT'); }
    $extends(extension) {
      hook = extension.query.$allOperations;
      return { asset: Object.fromEntries(Object.keys(delegate).map(operation => [operation, args => ({
        [Symbol.toStringTag]: 'PrismaPromise', then: (resolve, reject) => hook({ operation, args, query: delegate[operation] }).then(resolve, reject),
      })])), $transaction: async input => { calls.push('BEGIN'); const value = typeof input === 'function' ? await input(this) : await Promise.all(input); calls.push('COMMIT'); return value; } };
    }
  }
  const metrics = { databaseTransactionFinished: value => calls.push({ duration: value }), databaseTransactionStarted: () => {}, databaseWriterReady: () => {}, observeDatabaseError: () => {} };
  const load = loader({ '@prisma/client': { PrismaClient: FakeClient }, './observations': metrics,
    'node:fs/promises': { default: { stat: async () => ({ isFile: () => true }) }, stat: async () => ({ isFile: () => true }) } });
  return { ...load('src/lib/database/client.ts'), calls, constructions: () => constructions };
}
test('actual factory: awaited initialization, retry, transaction boundary and reconnect', async () => {
  process.env.DATABASE_URL = 'file:/tmp/audit-scale-fake.db?connection_limit=8';
  const h = clientHarness({ failInit: true });
  await assert.rejects(async () => await h.applicationDatabase.asset.findMany(), /private/);
  assert.equal(h.calls.includes('SELECT'), false);
  await h.applicationDatabase.asset.findMany();
  assert.ok(h.calls.indexOf('PRAGMA synchronous = NORMAL') < h.calls.indexOf('SELECT'));
  const promise = h.applicationDatabase.asset.findMany();
  assert.equal(promise[Symbol.toStringTag], 'PrismaPromise');
  await h.applicationDatabase.$transaction([promise]);
  assert.equal(h.calls.filter(value => value === 'BEGIN').length, 1);
  assert.ok(h.calls.indexOf('PRAGMA synchronous = NORMAL') < h.calls.indexOf('BEGIN'));
  await h.applicationDatabase.$disconnect();
  await h.applicationDatabase.asset.findMany();
  assert.equal(h.calls.filter(value => value === 'PRAGMA journal_mode = WAL').length, 2);
  assert.equal(h.constructions(), 1);
  assert.match(h.calls[0].datasources.db.url, /connection_limit=1(?:&|$)/);
  assert.equal(h.calls[0].log.length, 0);
});

test('actual minute observations: bounded, P1008 deduplicated, no error content', () => {
  delete globalThis[Symbol.for('video-api.database-observations.v1')];
  const observe = loader()('src/lib/database/observations.ts');
  const original = Date.now; let now = Date.parse('2026-10-27T00:00:00Z'); Date.now = () => now;
  try {
    for (let i = 0; i < 100; i++) {
      now += 60000;
      const error = Object.assign(new Error('private-token-and-sql'), { code: 'P1008', args: 'private-prompt' });
      observe.observeDatabaseError(error); observe.observeDatabaseError(error);
      observe.databaseTransactionStarted(); observe.databaseTransactionFinished(1234);
    }
    const snapshot = observe.databaseObservations();
    assert.equal(snapshot.minutes.length, 60);
    assert.equal(snapshot.minutes.every(row => row.p1008 === 1 && row.transactions === 1 && row.maxTransactionMs === 1234), true);
    assert.equal(JSON.stringify(snapshot).includes('private'), false);
  } finally { Date.now = original; }
});

test('actual alert flow: fixed trusted identity, durable UUID, no unknown replay after 50m', async () => {
  const jobs = new Map(); const sent = []; const now = new Date('2026-10-27T10:01:00Z');
  let trusted = true; let loseReceipt = true;
  const admin = { id: 'admin', feishu_open_id: 'pinned-open-id' };
  const config = { enabled: true, recipientId: admin.id, identity: 'pinned', appId: 'app', tenant: 'tenant' };
  const db = { user: { findUnique: async () => admin }, notification: {
    upsert: async ({ where, create }) => { if (!jobs.has(where.id)) jobs.set(where.id, { ...create, created_at: now }); },
    findUnique: async ({ where }) => jobs.has(where.id) ? structuredClone(jobs.get(where.id)) : null,
    findMany: async () => [...jobs.values()].filter(job => job.status === 'pending'),
    updateMany: async ({ where, data }) => {
      const job = jobs.get(where.id); if (!job || job.status !== where.status || job.metadata_json !== where.metadata_json) return { count: 0 };
      Object.assign(job, data); return { count: 1 };
    },
  } };
  const module = loader({ '@/lib/prisma': { prisma: db }, '@/lib/feedback/notification': {
    feedbackConfig: () => config, validFeedbackRecipient: () => trusted },
    '@/lib/feedback/delivery': { feedbackTenantToken: async () => 'synthetic-token' },
  })('src/lib/database/alerts.ts');
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id');
    assert.equal(options.redirect, 'error'); sent.push(JSON.parse(options.body));
    if (loseReceipt) throw new Error('private provider body');
    return { ok: true, json: async () => ({ code: 0 }) };
  };
  const row = { minute: '2026-10-27T10:00:00.000Z', p1008: 1, transactions: 1, transactionMs: 100, maxTransactionMs: 100 };
  try {
    await module.flushDatabaseAlerts([row], now);
    await module.flushDatabaseAlerts([row], now);
    assert.equal(jobs.size, 1); assert.equal(sent.length, 1);
    await module.flushDatabaseAlerts([row], new Date(+now + 100000));
    assert.equal(sent.length, 2); assert.equal(sent[0].uuid, sent[1].uuid);
    await module.flushDatabaseAlerts([], new Date(+now + 51 * 60000));
    assert.equal(sent.length, 2); assert.equal([...jobs.values()][0].status, 'failed');
    assert.equal(JSON.stringify([...jobs.values()]).includes('private'), false);
    trusted = false; loseReceipt = false;
    await module.flushDatabaseAlerts([{ ...row, minute: '2026-10-27T10:59:00.000Z' }], new Date('2026-10-27T11:00:00Z'));
    assert.equal(jobs.size, 1); assert.equal(sent.length, 2);
  } finally { globalThis.fetch = fetch; }
});
test('actual readonly facade: diagnostics do not configure WAL, cannot write/raw/extend/transaction', async () => {
  const h = clientHarness();
  for (const property of ['$queryRaw', '$executeRawUnsafe', '$transaction', '$extends', '_engine', 'constructor']) {
    assert.throws(() => h.readonlyDatabase[property].call?.(), /hd_readonly_query_required/);
  }
  assert.throws(() => h.readonlyDatabase.asset.create({ data: {} }), /hd_readonly_query_required/);
  await h.readonlyDatabase.asset.findMany();
  assert.equal(h.calls.includes('PRAGMA query_only = ON'), true);
  assert.equal(h.calls.includes('PRAGMA journal_mode = WAL'), false);
  assert.equal(h.calls.includes('PRAGMA query_only = OFF'), false);
  await h.applicationDatabase.$connect();
  await h.readonlyDatabase.asset.findMany();
  assert.equal(h.constructions(), 1);
  assert.throws(() => h.readonlyDatabase.asset.update({}), /hd_readonly_query_required/);
});
