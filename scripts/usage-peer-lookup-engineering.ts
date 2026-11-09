import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { Prisma } from '@prisma/client';
import { withUsageReadSnapshot, type UsageSqlReader } from '../src/lib/usage/sqlite-read-snapshot';
import { usageReaderDatabase, type UsageDb } from '../src/lib/usage/database';
import type { UsageCashEvent } from '../src/lib/usage/facts';

type Ledger = { id: string; [field: string]: string | number | null };
type Projection = Array<Record<string, unknown>>;
type Trace = { kind: string; sql: string; parameters: unknown[]; rows: number; ids: string[]; plan?: object[] };
type Consumer = {
  engineeringAttachCash(db: UsageDb, items: [], scoped: boolean, window: undefined, adminSlice: boolean, ids: string[]): Promise<UsageCashEvent[]>;
  iterateUsageCashBatches(db: UsageDb): AsyncIterable<UsageCashEvent[]>;
};
const factFile = 'src/lib/usage/facts.ts';
const inputs = [factFile, 'src/lib/usage/database.ts', 'src/lib/usage/read-window.ts', 'src/lib/admin/usage-money.ts',
  'src/lib/admin/usage-record-link.ts', 'src/lib/costs/currency.ts', 'src/lib/usage/sqlite-read-snapshot.ts',
  'scripts/usage-sqlite-reader.py', 'prisma/schema.prisma', 'scripts/usage-peer-lookup-engineering.ts'];
const json = (value: unknown) => JSON.stringify(value, (_key, cell) => typeof cell === 'bigint' ? { bigint: cell.toString() } : cell);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const binary = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const fixedTime = Date.parse('2026-11-09T00:00:00.000Z');
const sqlKind = (sql: string) => {
  const condition = sql.replace(/\s+/g, ' ').split(' WHERE (')[1] || '';
  if (condition.startsWith('"provider_task_id" IN (')) return 'task-peer';
  if (condition.startsWith('"provider_request_id" IN (')) return 'request-peer';
  if (condition.startsWith(' COALESCE(') || condition.startsWith('COALESCE(')) return 'legacy-peer';
  return 'other';
};

async function main() {
  const root = process.cwd(), baselinePath = process.argv[2];
  assert.ok(baselinePath && existsSync(baselinePath), 'Usage: node --import tsx scripts/usage-peer-lookup-engineering.ts <original-facts.ts> [receipt.json]');
  const currentText = readFileSync(path.join(root, factFile), 'utf8'), baselineText = readFileSync(baselinePath, 'utf8');
  assert.notEqual(sha(currentText), sha(baselineText), 'The fixture needs the actual old and changed facts sources');
  const sourceSha256 = Object.fromEntries(inputs.map(file => [file, sha(readFileSync(path.join(root, file)))]));
  const startedAt = new Date().toISOString(), runId = process.env.IMAGE_RECOVERY_GATE_RUN_ID || randomUUID();
  const directory = await mkdtemp(path.join(tmpdir(), 'usage-peer-lookup-')), filename = path.join(directory, 'fixture.db');
  const receipt = path.resolve(process.argv[3] || path.join(root, '.role-tests', `usage-peer-lookup-${runId}.json`));
  const previousUrl = process.env.DATABASE_URL, originalFetch = globalThis.fetch;
  process.env.DATABASE_URL = `file:${filename}`;
  let forbiddenCalls = 0, globalPrismaCalls = 0;
  const forbidden = (label: string): never => { forbiddenCalls++; throw new Error(`Offline usage-peer fixture boundary: ${label}`); };
  globalThis.fetch = () => forbidden('network');
  const require = createRequire(import.meta.url), imported = new Set<string>();
  const checks: string[] = [], results: object[] = [];
  let capture: Projection[] = [];
  function consumer(source: string): Consumer {
    const cache = new Map<string, Record<string, unknown>>();
    const load = (file: string): Record<string, unknown> => {
      if (cache.has(file)) return cache.get(file)!;
      const module = { exports: {} as Record<string, unknown> }; cache.set(file, module.exports);
      let text = file === factFile ? source : readFileSync(path.join(root, file), 'utf8');
      if (file === factFile) {
        const marker = 'ledgers = Array.from(selected.values());';
        assert.equal(text.split(marker).length, 2, 'Instrument only the actual post-merge projection boundary');
        text = text.replace(marker, marker + '\n__captureLedgers(ledgers);') + '\nexport const engineeringAttachCash = attachCash;';
      }
      const code = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
      new Function('require', 'module', 'exports', '__captureLedgers', code)((name: string) => {
        if (name === 'server-only') return {};
        if (name === '@prisma/client') return { Prisma }; // Deliberately expose no PrismaClient constructor.
        if (name === 'node:crypto') return require(name);
        if (name === '@/lib/prisma') { globalPrismaCalls++; return forbidden('application-global-prisma'); }
        const resolved = name.startsWith('@/') ? `src/${name.slice(2)}.ts` : name.startsWith('.')
          ? path.posix.normalize(path.posix.join(path.posix.dirname(file), name)) + '.ts' : '';
        if (resolved === 'src/lib/usage/accounting.ts') return { attachAccountingCosts: () => forbidden('unrelated-accounting-execution') };
        if (!inputs.includes(resolved) || resolved === factFile) return forbidden(`import:${name}`);
        imported.add(resolved); return load(resolved);
      }, module, module.exports, (rows: Projection) => capture.push(rows.map(row => ({ ...row }))));
      return module.exports;
    };
    return load(factFile) as unknown as Consumer;
  }
  const original = consumer(baselineText), candidate = consumer(currentText);
  const ledger = (id: string, extra: Record<string, string | number | null> = {}): Ledger => ({ id, source_type: 'official_bill', source_id: null, task_id: null, image_task_id: null,
    user_id: 'synthetic-owner', project_id: 'synthetic-project', provider_request_id: null, provider_name: 'Provider', provider_account_id: 'Scope',
    provider_task_id: null, event_type: 'official_charge', amount_micros: 1000000, amount_minor: null, currency: 'USD',
    cost_source: 'official_bill', confidence: 'confirmed', official_charge_id: null, occurred_at: fixedTime, created_at: fixedTime, ...extra });
  const emptyIdentity = { provider_name: null, provider_account_id: null, provider_task_id: 'identity-ref' };
  const seed: Ledger[] = [
    ledger('n-seed', emptyIdentity),
    ledger('n-empty-both', { ...emptyIdentity, provider_name: '', provider_account_id: '' }),
    ledger('n-null-scope', { ...emptyIdentity, provider_name: '' }),
    ledger('n-null-provider', { ...emptyIdentity, provider_account_id: '' }),
    ledger('n-fallback-null', { ...emptyIdentity, provider_task_id: null, provider_request_id: 'identity-ref' }),
    ledger('n-fallback-empty', { ...emptyIdentity, provider_task_id: '', provider_request_id: 'identity-ref' }),
    ledger('n-task-priority', { ...emptyIdentity, provider_request_id: 'ignored' }),
    ledger('n-double-source', { ...emptyIdentity, provider_request_id: 'identity-ref' }),
    ledger('n-reject-task-over-request', { ...emptyIdentity, provider_task_id: 'different-task', provider_request_id: 'identity-ref' }),
    ledger('n-reject-space-task', { ...emptyIdentity, provider_task_id: ' ', provider_request_id: 'identity-ref' }),
    ledger('n-reject-scope', { ...emptyIdentity, provider_account_id: ' ' }),
    ledger('n-reject-provider', { ...emptyIdentity, provider_name: ' ' }),
    ledger('n-reject-event', { ...emptyIdentity, event_type: 'refund' }),
    ledger('n-reject-reference-case', { ...emptyIdentity, provider_task_id: 'IDENTITY-REF' }),
    ledger('c-seed', { provider_task_id: 'RefCase' }), ledger('c-match', { provider_task_id: 'RefCase' }),
    ledger('c-reject-scope', { provider_task_id: 'RefCase', provider_account_id: 'scope' }),
    ledger('c-reject-provider', { provider_task_id: 'RefCase', provider_name: 'provider' }),
    ledger('c-reject-event', { provider_task_id: 'RefCase', event_type: 'Official_charge' }),
    ledger('c-reject-ref', { provider_task_id: 'refcase' }),
    ledger('w-seed', { provider_account_id: 'space-scope', provider_task_id: ' ' }),
    ledger('w-task', { provider_account_id: 'space-scope', provider_task_id: ' ' }),
    ledger('w-request', { provider_account_id: 'space-scope', provider_request_id: ' ' }),
    ledger('w-reject-trim', { provider_account_id: 'space-scope', provider_task_id: '', provider_request_id: '' }),
    ledger('e-seed', { provider_task_id: '', provider_request_id: '' }),
    ledger('proof-seed', { provider_account_id: 'proof-scope', provider_task_id: 'proof-ref', official_charge_id: 'proof-original' }),
    ledger('proof-other-ref', { provider_account_id: 'proof-scope', provider_task_id: 'proof-other', official_charge_id: 'proof-original' }),
    ledger('proof-reference-only', { provider_account_id: 'proof-scope', provider_task_id: 'proof-ref' }),
    ledger('proof-mixed-seed', { provider_account_id: 'proof-scope', provider_task_id: 'proof-mixed' }),
    ledger('proof-mixed-peer', { provider_account_id: 'proof-scope', provider_task_id: 'proof-mixed' }),
    ledger('p-seed', { provider_account_id: 'wide-scope', provider_task_id: 'wide-ref', provider_request_id: 'wide-ref' }),
    ...[...Array.from({ length: 510 }, (_, i) => String(i).padStart(4, '0')), '!', '0', 'A', 'Z', 'a', 'z', '~', 'À', 'Ω'].map(id =>
      ledger(`p-${id}`, { provider_account_id: 'wide-scope', provider_task_id: 'wide-ref', provider_request_id: 'wide-ref' })),
  ];
  try {
    const schema = readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8');
    const costSchema = schema.match(/^model CostLedger \{([\s\S]*?)^\}/m)![1];
    const indexed = ['provider_task_id', 'provider_request_id'];
    for (const column of indexed) assert.ok(costSchema.includes(`@@index([${column}])`), `Index must already exist: ${column}`);
    const tables = ['CostLedger', 'ProviderApiRequest', 'ImageStudioTask', 'CanvasRoleAttempt'];
    const quote = (name: string) => { assert.match(name, /^\w+$/); return `"${name}"`; };
    const ddl = Prisma.dmmf.datamodel.models.filter(model => tables.includes(model.name)).map(model => `CREATE TABLE ${quote(model.dbName || model.name)} (${model.fields.filter(field => field.kind !== 'object').map(field =>
      `${quote(field.dbName || field.name)} ${field.type === 'DateTime' ? 'DATETIME' : ['Int', 'BigInt', 'Boolean'].includes(field.type) ? 'INTEGER' : ['Float', 'Decimal'].includes(field.type) ? 'DOUBLE' : 'TEXT'}${field.isId ? ' PRIMARY KEY' : ''}`).join(',')});`).join('\n')
      + indexed.map(column => `CREATE INDEX CostLedger_${column}_idx ON CostLedger(${column});`).join('\n');
    const setup = spawnSync('/usr/bin/python3', ['-c', `import json,sqlite3,sys\np=json.load(sys.stdin)\nc=sqlite3.connect(p['file'])\nc.executescript(p['ddl'])\nfor row in p['seed']:\n names=list(row)\n c.execute('INSERT INTO CostLedger ('+','.join('"'+n+'"' for n in names)+') VALUES ('+','.join('?' for n in names)+')',[row[n] for n in names])\nc.commit()\nc.close()\n`],
      { input: JSON.stringify({ file: filename, ddl, seed }), encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv });
    assert.ifError(setup.error); assert.equal(setup.status, 0, setup.stderr);
    const run = async (impl: Consumer, ids?: string[]) => {
      const trace: Trace[] = [], projections: Projection[] = [];
      capture = projections;
      const batches = await withUsageReadSnapshot(async reader => {
        const traced: UsageSqlReader = { async query<T extends object>(statement: Prisma.Sql): Promise<T[]> {
          const rows = await reader.query<T>(statement), kind = sqlKind(statement.sql);
          if (kind !== 'other') {
            const plan = await reader.query(Prisma.sql`EXPLAIN QUERY PLAN ${statement}`);
            trace.push({ kind, sql: statement.sql, parameters: statement.values, rows: rows.length,
              ids: rows.flatMap(row => 'id' in row ? [String(row.id)] : []), plan });
          }
          return rows;
        } };
        const db = usageReaderDatabase(traced);
        if (ids) return [await impl.engineeringAttachCash(db, [], true, undefined, true, ids)];
        const all: UsageCashEvent[][] = [];
        for await (const batch of impl.iterateUsageCashBatches(db)) all.push(batch);
        return all;
      });
      return { batches, projections, trace };
    };
    const compare = async (name: string, ids: string[], expectedIds: string[]) => {
      const before = await run(original, ids), after = await run(candidate, ids);
      assert.deepEqual(after.projections, before.projections, `${name}: complete raw ledger projection/order`);
      assert.deepEqual(after.batches, before.batches, `${name}: complete public cash event`);
      assert.deepEqual(after.batches[0].map(event => event.id).sort(binary), expectedIds.slice().sort(binary), name);
      assert.equal(new Set(after.batches[0].map(event => event.id)).size, expectedIds.length, `${name}: merge by original ledger id`);
      results.push({ name, selectedRows: expectedIds.length, projectionSha256: sha(json(after.projections)), eventsSha256: sha(json(after.batches)), beforeQueries: before.trace, afterQueries: after.trace });
      checks.push(name); return { before, after };
    };
    const identities = await compare('null_empty_local_coalesce_task_precedence_and_exact_reference', ['n-seed'], seed.filter(row => row.id.startsWith('n-') && !row.id.startsWith('n-reject')).map(row => String(row.id)));
    assert.ok(identities.after.trace.filter(t => t.kind === 'request-peer').some(t => t.ids.includes('n-reject-task-over-request')));
    assert.equal(identities.after.trace.flatMap(t => t.ids).filter(id => id === 'n-double-source').length, 2);
    await compare('nonempty_scope_provider_event_and_case_remain_isolated', ['c-seed'], ['c-seed', 'c-match']);
    await compare('whitespace_reference_is_not_trimmed', ['w-seed'], ['w-seed', 'w-task', 'w-request']);
    const empty = await compare('empty_reference_does_not_start_peer_lookup', ['e-seed'], ['e-seed']);
    assert.equal(empty.after.trace.length, 0);
    const proof = await compare('proof_and_mixed_proof_groups_keep_original_sql_path', ['proof-seed', 'proof-mixed-seed'], seed.filter(row => row.id.startsWith('proof-')).map(row => String(row.id)));
    assert.deepEqual(proof.after.trace, proof.before.trace, 'Proof SQL, bound parameters, plans and returned rows are unchanged');
    assert.ok(proof.after.trace.length > 0 && proof.after.trace.every(t => t.kind === 'legacy-peer' && t.sql.includes('"official_charge_id" IN')));
    const wideIds = seed.filter(row => row.id.startsWith('p-')).map(row => String(row.id));
    const wide = await compare('more_than_500_peers_keep_binary_order_and_duplicate_merge', ['p-seed'], wideIds);
    for (const kind of ['task-peer', 'request-peer']) {
      const pages = wide.after.trace.filter(t => t.kind === kind);
      assert.deepEqual(pages.map(t => t.rows), [500, wideIds.length - 500]);
      assert.deepEqual(pages.flatMap(t => t.ids), wideIds.slice().sort(binary), `${kind}: native BINARY cursor order`);
    }
    const allBefore = await run(original), allAfter = await run(candidate);
    assert.deepEqual(allAfter.projections, allBefore.projections);
    assert.deepEqual(allAfter.batches, allBefore.batches);
    assert.ok(allAfter.batches.length > 1 && allAfter.batches[0].length === 500);
    assert.deepEqual(allAfter.batches.flat().map(event => event.id), seed.map(row => String(row.id)).sort(binary));
    checks.push('actual_iterate_usage_cash_batches_keeps_500_cursor_and_full_events');
    results.push({ name: checks.at(-1), batchSizes: allAfter.batches.map(batch => batch.length), eventCount: seed.length,
      projectionSha256: sha(json(allAfter.projections)), eventsSha256: sha(json(allAfter.batches)) });
    for (const record of [...identities.after.trace, ...wide.after.trace]) {
      if (record.kind === 'legacy-peer') continue;
      const column = record.kind === 'task-peer' ? 'provider_task_id' : 'provider_request_id';
      assert.ok(record.plan?.some(row => 'detail' in row && String(row.detail).includes(`USING INDEX CostLedger_${column}_idx`)), 'Actual single-column index search required');
      const condition = record.sql.replace(/\s+/g, ' ').split(' WHERE (')[1];
      assert.ok(condition.startsWith(`"${column}" IN (`) && !/COALESCE|event_type|provider_account_id/.test(condition));
    }
    checks.push('actual_peer_sql_uses_existing_single_column_indexes_without_extra_predicates');
    assert.equal(globalPrismaCalls, 0); assert.equal(forbiddenCalls, 0);
    for (const [file, hash] of Object.entries(sourceSha256)) assert.equal(sha(readFileSync(path.join(root, file))), hash, `Source changed while checking ${file}`);
    await rm(directory, { recursive: true, force: true });
    await mkdir(path.dirname(receipt), { recursive: true, mode: 0o700 });
    writeFileSync(receipt, json({ schema: 'usage-peer-lookup-engineering.v1', synthetic: true, completed: true, runId, startedAt,
      finishedAt: new Date().toISOString(), checks, results, sourceSha256, baselineFactsSha256: sha(baselineText),
      fixtureSha256: sourceSha256['scripts/usage-peer-lookup-engineering.ts'], importedPureModules: [...imported].sort(),
      actualConsumers: ['attachCash', 'iterateUsageCashBatches'], observationOnlyInjection: 'Capture the actual post-merge ledgers; no peer filtering or event formulas replaced',
      globalPrismaImportsBlocked: true, prismaClientConstructorExposed: false, globalPrismaCalls, forbiddenCalls,
      productionWrites: 0, paidRequests: 0, browserRuns: 0, isolatedDatabaseDeleted: !existsSync(directory),
      scope: 'Synthetic SQL/parameters and actual original/current projection/event/index plans; no production timing or functional acceptance claim' }) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(`Usage peer lookup engineering receipt: ${receipt}`);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
    await rm(directory, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
