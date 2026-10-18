import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { PrismaClient, type Prisma, type ImageStudioTask } from '@prisma/client';
import type * as RuntimeModule from '../src/lib/pricing/runtime';
import type * as IsolationModule from '../src/lib/pricing/isolation';
import type * as StateModule from '../src/lib/image-studio/pricing-state';
import type * as CapacityModule from '../src/lib/image-studio/queue-capacity';
import type * as BillingContractModule from '../src/lib/image-studio/billing-contract';
import type * as BillingQuoteModule from '../src/lib/image-studio/billing-quote';
import type * as ChargeModule from '../src/lib/pricing/charge';
import type { ToolFlowGraph } from '../src/lib/tools/toolflow';
import { PRICING_LEGACY_SOURCES, PRICING_LEGACY_FILE_SHA256, PRICING_LEGACY_ADAPTATIONS, PRICING_LEGACY_STARTUP_SHA256 } from './pricing-legacy-v0954/provenance';

type ModuleExports = Record<string, unknown>;
type Variant = keyof typeof PRICING_LEGACY_SOURCES;
type Observation = { phase: string; model: string; method: string; selector: unknown; ids: string[] };
type Loader = { load<T>(file: string): T; processState: { exitCode: number }; stageCalls: string[] };
type Tasks = { claimStudioTask(): Promise<ImageStudioTask | null> };
type Worker = { processStudioTask(): Promise<boolean> };
type Billing = { reconcileImageBilling(): Promise<void> };
type Batches = { dispatchStudioBatches(): Promise<void> };
type Toolflow = { dispatchWaitingToolFlowRuns(): Promise<void> };
type FlowHelpers = {
  __fixtureToolFlowState(run: { id?: string; status?: string; contract_version?: string }, status: string): string;
  __fixtureCurrentNodeContract(snapshot: { node_contracts: Record<string, unknown>; node_attempts?: Record<string, unknown[]> }, nodeId: string): unknown;
};
type BatchHelpers = {
  __fixtureBatchKey(owner: string, id: string, channel: boolean, pricing: boolean): string;
  __fixtureBatchItemKey(batch: Record<string, unknown>, ordinal: number): string;
  __fixtureBatchChildId(batch: Record<string, unknown>, item: { ordinal: number; attempt: number }): string;
};
type MarkerCase = 'strict' | 'ordinary' | 'unprotected' | 'wrong-schema' | 'extra-field';
type MarkerEvidence = { file: string; uid: number; mode: number; nlink: number; attributes: string; sha256: string };
type Bootstrap = { schema: string; candidateRoot: string; fixtureRoot: string; source: string; uid: number; gid: number;
  installedAt: string; markers: Record<MarkerCase, string> };

export type PricingLegacyConsumerFixtureInput = { candidateRoot: string; fixtureRoot: string; databasePath: string };
export type PricingLegacyConsumerFixtureResult = {
  schema: 'pricing-legacy-consumer.v2';
  source: string;
  checks: Array<{ id: 'G19'; assertions: number; evidence: string[] }>;
  forbiddenCalls: string[];
  sources: typeof PRICING_LEGACY_SOURCES;
  entrypoints: Array<{ variant: Variant; source: string; file: string; entry: string; phase: string }>;
  rootInputs: Record<MarkerCase, MarkerEvidence>;
  processIdentity: RuntimeModule.PricingWorkerCapability['instance'];
  observations: Observation[];
  database: { path: string; rolledBack: true };
  adaptations: typeof PRICING_LEGACY_ADAPTATIONS;
};

function inside(file: string, root: string) { return file === root || file.startsWith(`${root}${path.sep}`); }
function sha(value: Buffer | string) { return crypto.createHash('sha256').update(value).digest('hex'); }

// Run in a dedicated child: cwd and Linux process identity are intentionally real.
export async function runPricingLegacyConsumerFixture(input: PricingLegacyConsumerFixtureInput): Promise<PricingLegacyConsumerFixtureResult> {
  const candidateRoot = fs.realpathSync(input.candidateRoot), fixtureRoot = fs.realpathSync(input.fixtureRoot);
  const databasePath = fs.realpathSync(input.databasePath), originalCwd = process.cwd();
  assert.equal(process.platform, 'linux', 'G19 requires real Linux /proc, uid0 files and filesystem immutable support; no metadata simulation');
  assert.ok(typeof process.getuid === 'function' && process.getuid() !== 0, 'Run the fixture as the real non-root build user after root bootstrap');
  assert.ok(inside(fixtureRoot, path.join(candidateRoot, '.role-tests')), 'Isolated candidate .role-tests directory required');
  assert.equal(fixtureRoot, path.resolve(input.fixtureRoot), 'Fixture root cannot be a symlink');
  assert.equal(databasePath, path.join(fixtureRoot, 'pricing-legacy-fixture.db'), 'Only the lead-supplied isolated legacy database is accepted');
  assert.ok(inside(databasePath, fixtureRoot), 'Fixture database must be inside its isolated directory');
  assert.notEqual(candidateRoot, fixtureRoot);
  const dbStat = fs.lstatSync(databasePath);
  assert.ok(dbStat.isFile() && !dbStat.isSymbolicLink() && dbStat.nlink === 1 && dbStat.uid === process.getuid!(), 'Lead must supply a separate build-user-owned schema-only SQLite file, not a production link');
  assert.equal(fs.readFileSync(databasePath).subarray(0, 16).toString(), 'SQLite format 3\0', 'Schema-initialized SQLite file required');
  const archiveRoot = path.join(candidateRoot, 'scripts', 'pricing-legacy-v0954');
  const forbiddenCalls: string[] = [], observations: Observation[] = [], evidence: string[] = [];
  const entrypoints: PricingLegacyConsumerFixtureResult['entrypoints'] = [];
  let phase = 'setup', assertions = 0;
  const check = (condition: unknown, message: string) => { assert.ok(condition, message); assertions += 1; };
  const equal = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); assertions += 1; };
  const reject = async (action: () => unknown | Promise<unknown>, message: string) => { await assert.rejects(async () => action(), undefined, message); assertions += 1; };
  const deny = (name: string): never => { forbiddenCalls.push(`${phase}:${name}`); throw new Error(`Forbidden fixture call: ${name}`); };
  const manifestPath = path.join(fixtureRoot, 'g19-bootstrap.json'), manifestStat = fs.lstatSync(manifestPath);
  check(manifestStat.isFile() && !manifestStat.isSymbolicLink() && manifestStat.uid === 0 && manifestStat.nlink === 1
    && !(manifestStat.mode & 0o022) && manifestStat.size <= 16384, 'Require the real root bootstrap manifest');
  const bootstrap = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Bootstrap;
  equal(bootstrap.schema, 'pricing-legacy-bootstrap.v1', 'Root bootstrap schema');
  equal(bootstrap.candidateRoot, candidateRoot, 'Root input belongs to this candidate');
  equal(bootstrap.fixtureRoot, fixtureRoot, 'Root input belongs to this isolated fixture');
  equal(bootstrap.uid, process.getuid!(), 'Use the actual build UID from root preparation');
  equal(bootstrap.gid, process.getgid!(), 'Use the actual build GID from root preparation');
  const source = process.env.RATE_G19_FIXTURE_SOURCE_SHA;
  check(source && /^[a-f0-9]{40}$/.test(source), 'RATE_G19_FIXTURE_SOURCE_SHA must identify the real candidate');
  equal(bootstrap.source, source, 'Prepared source must match this candidate invocation');
  if (process.env.PRICING_SOURCE_SHA) equal(process.env.PRICING_SOURCE_SHA, source, 'Unified engine source must match root input');
  const markerRoots: Record<MarkerCase, string> = { strict: fixtureRoot, ordinary: path.join(fixtureRoot, 'g19-marker-cases/ordinary'),
    unprotected: path.join(fixtureRoot, 'g19-marker-cases/unprotected'), 'wrong-schema': path.join(fixtureRoot, 'g19-marker-cases/wrong-schema'),
    'extra-field': path.join(fixtureRoot, 'g19-marker-cases/extra-field') };
  function markerEvidence(): Record<MarkerCase, MarkerEvidence> {
    return Object.fromEntries((Object.keys(markerRoots) as MarkerCase[]).map(kind => {
      const file = path.join(markerRoots[kind], 'storage/image-studio-drain');
      equal(bootstrap.markers[kind], file, `Root input path: ${kind}`);
      equal(fs.realpathSync(file), file, `Root input must not escape by symlink: ${kind}`);
      const stat = fs.lstatSync(file);
      check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === 0
        && (stat.mode & 0o777) === 0o444 && stat.size > 0 && stat.size <= 4096, `Real root input metadata: ${kind}`);
      const line = execFileSync('lsattr', ['-d', '--', file], { encoding: 'utf8', timeout: 3000 }).trim();
      const attributes = /^(\S+)\s+([\s\S]+)$/.exec(line);
      check(attributes && attributes[2] === file, `Real filesystem attributes: ${kind}`);
      equal(attributes![1].includes('i'), !['ordinary', 'unprotected'].includes(kind), `Real immutable flag: ${kind}`);
      return [kind, { file, uid: stat.uid, mode: stat.mode & 0o777, nlink: stat.nlink,
        attributes: attributes![1], sha256: sha(fs.readFileSync(file)) }];
    })) as Record<MarkerCase, MarkerEvidence>;
  }
  const rootInputs = markerEvidence();
  let capturedIdentity: RuntimeModule.PricingWorkerCapability['instance'] | undefined;
  for (const variant of ['web', 'image'] as const) {
    for (const [file, expected] of Object.entries({ ...PRICING_LEGACY_FILE_SHA256, ...PRICING_LEGACY_STARTUP_SHA256[variant] })) {
      equal(sha(fs.readFileSync(path.join(archiveRoot, variant, `${file}.source`))), expected, `${variant} original bytes: ${file}`);
    }
    equal(sha(fs.readFileSync(path.join(archiveRoot, variant, 'package.json.source'))), PRICING_LEGACY_SOURCES[variant].packageSha256, `${variant} original package bytes`);
    evidence.push(`${variant}: ${PRICING_LEGACY_SOURCES[variant].commit} v${PRICING_LEGACY_SOURCES[variant].version}; complete source bytes verified against bundled SHA256 manifest`);
  }
  const database = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } });
  const rollback = new Error('pricing-legacy-consumer-fixture-rollback');
  let completed = false;

  async function atRoot<T>(root: string, action: () => T | Promise<T>): Promise<T> {
    const previous = process.cwd();
    process.chdir(root);
    try { return await action(); } finally { process.chdir(previous); }
  }
  function entered(variant: Variant, file: string, entry: string) {
    entrypoints.push({ variant, source: PRICING_LEGACY_SOURCES[variant].commit, file, entry, phase });
  }

  function makeLoader(tx: Prisma.TransactionClient, variant: Variant | 'candidate'): Loader {
    const cache = new Map<string, { exports: ModuleExports }>(), stageCalls: string[] = [];
    const candidateModules = new Set([
      'src/lib/pricing/runtime.ts', 'src/lib/pricing/isolation.ts', 'src/lib/pricing/admin-contract.ts',
      'src/lib/pricing/charge.ts', 'src/lib/pricing/frozen-charge.ts', 'src/lib/pricing/math.ts', 'src/lib/credits/precision.ts', 'src/lib/costs/currency.ts',
      'src/lib/image-studio/pricing-state.ts', 'src/lib/image-studio/queue-capacity.ts',
      'src/lib/image-studio/synchronous-admission.ts', 'src/lib/image-studio/billing-contract.ts',
      'src/lib/image-studio/billing-quote.ts', 'src/lib/image-studio/batches.ts', 'src/lib/tools/toolflow-runtime.ts',
    ]);
    const processState = { exitCode: 0 };
    const modelCache = new Map<string, unknown>();
    const db = new Proxy(tx, {
      get(target, property) {
        if (property === '$transaction') return async (callback: (client: unknown) => Promise<unknown>) => callback(db);
        if (property === '$disconnect') return async () => {};
        const name = String(property), delegate = Reflect.get(target, property);
        if (!delegate || typeof delegate !== 'object') return typeof delegate === 'function' ? deny(`database:${name}`) : delegate;
        if (modelCache.has(name)) return modelCache.get(name);
        const observed = new Proxy(delegate, {
          get(model, method) {
            const fn = Reflect.get(model, method);
            if (typeof fn !== 'function') return fn;
            return async (...args: unknown[]) => {
              const result: unknown = await Reflect.apply(fn, model, structuredClone(args));
              const rows = Array.isArray(result) ? result : result && typeof result === 'object' ? [result] : [];
              const selector = args[0] && typeof args[0] === 'object' && 'where' in args[0] ? args[0].where : null;
              observations.push({ phase, model: name, method: String(method), selector: structuredClone(selector), ids: rows.flatMap(row =>
                row && typeof row === 'object' && 'id' in row && typeof row.id === 'string' ? [row.id] : []) });
              return result;
            };
          },
        });
        modelCache.set(name, observed); return observed;
      },
    });
    function mappedFile(value: unknown): string {
      if (typeof value !== 'string') return deny('filesystem:non-string-path');
      const resolved = path.resolve(value);
      const procFiles = [`/proc/${process.pid}/stat`, `/proc/${process.ppid}/stat`, `/proc/${process.pid}/cwd`, `/proc/${process.ppid}/cwd`];
      if (procFiles.includes(resolved)) return resolved;
      if (inside(resolved, fixtureRoot)) {
        const root = process.cwd();
        const relative = inside(resolved, root) ? path.relative(root, resolved) : path.relative(fixtureRoot, resolved);
        if (variant !== 'candidate' && /^(src\/|scripts\/|package\.json$)/.test(relative)) {
          const original = path.join(archiveRoot, variant, `${relative}.source`);
          if (fs.existsSync(original)) return original;
          const directory = path.join(archiveRoot, variant, relative);
          if (fs.existsSync(directory) && fs.lstatSync(directory).isDirectory()) return directory;
          return deny(`legacy-source:missing:${relative}`);
        }
        return resolved;
      }
      if (inside(resolved, candidateRoot)) return resolved;
      return deny('filesystem:outside-fixture');
    }
    const safeFs = {
      existsSync: (file: string) => fs.existsSync(mappedFile(file)),
      readFileSync: (file: string, encoding?: BufferEncoding) => fs.readFileSync(mappedFile(file), encoding),
      readdirSync: (file: string) => {
        const mapped = mappedFile(file), names = fs.readdirSync(mapped);
        return variant !== 'candidate' && inside(mapped, archiveRoot) ? names.map(name => name.replace(/\.source$/, '')) : names;
      },
      realpathSync: (file: string) => fs.realpathSync(mappedFile(file)),
      lstatSync: (file: string) => fs.lstatSync(mappedFile(file)),
    };
    const guardedFs = new Proxy(safeFs, { get(target, property) { return Reflect.get(target, property) || (() => deny(`filesystem:${String(property)}`)); } });
    const processFixture = { cwd: () => process.cwd(), platform: process.platform, pid: process.pid, ppid: process.ppid,
      env: { NODE_ENV: 'test', SESSION_SECRET: 'pricing-legacy-fixture-only' }, argv: ['node', 'fixture', '--once'],
      kill: (pid: number, signal: number) => { if (![process.pid, process.ppid].includes(pid) || signal !== 0) return deny('process:signal'); return process.kill(pid, 0); },
      on: () => processFixture,
      get exitCode() { return processState.exitCode; }, set exitCode(value: number) { processState.exitCode = value; } };
    const childProcess = { execFileSync: (command: string, args: string[]) => {
      const allowed = Object.values(rootInputs).some(item => args.join('\0') === ['-d', '--', item.file].join('\0'));
      if (command !== 'lsattr' || !allowed) return deny('child_process:spawn');
      return execFileSync(command, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    } };
    const unknownModule = (request: string) => new Proxy({ __esModule: true } as ModuleExports, {
      get(target, property) { return property === '__esModule' ? true : Reflect.get(target, property) || function () { return deny(`dependency:${request}:${String(property)}`); }; },
    });
    function resolveFile(request: string, parent: string) {
      const result = request.startsWith('@/') ? `src/${request.slice(2)}`
        : request.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(parent), request)) : request;
      return path.posix.extname(result) ? result : `${result}.ts`;
    }
    function load<T>(file: string): T {
      if (cache.has(file)) return cache.get(file)!.exports as T;
      if (variant === 'candidate' && !candidateModules.has(file)) return unknownModule(file) as T;
      // Startup-only snapshots are hashed, never executed as accidental dependencies.
      if (variant !== 'candidate' && file !== 'package.json' && !Object.hasOwn(PRICING_LEGACY_FILE_SHA256, file)) return unknownModule(file) as T;
      const bundled = variant === 'candidate' ? path.join(candidateRoot, file) : path.join(archiveRoot, variant, `${file}.source`);
      if (!inside(bundled, variant === 'candidate' ? candidateRoot : archiveRoot)) return deny('module:path-escape');
      if (!fs.existsSync(bundled)) return unknownModule(file) as T;
      const module = { exports: {} as ModuleExports }; cache.set(file, module);
      let source = fs.readFileSync(bundled, 'utf8');
      if (file.endsWith('.json')) { module.exports = JSON.parse(source); return module.exports as T; }
      if (variant === 'candidate' && file === 'src/lib/tools/toolflow-runtime.ts') {
        source += '\nexport { toolFlowState as __fixtureToolFlowState, currentNodeContract as __fixtureCurrentNodeContract };\n';
      }
      if (variant === 'candidate' && file === 'src/lib/image-studio/batches.ts') {
        source += '\nexport { key as __fixtureBatchKey, itemKey as __fixtureBatchItemKey, childId as __fixtureBatchChildId };\n';
      }
      if (file === 'scripts/process-image-studio.ts') {
        const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const entries = parsed.statements.filter(statement => ts.isExpressionStatement(statement) && ts.isVoidExpression(statement.expression)
          && ts.isCallExpression(statement.expression.expression) && ts.isPropertyAccessExpression(statement.expression.expression.expression)
          && statement.expression.expression.expression.name.text === 'catch'
          && ts.isCallExpression(statement.expression.expression.expression.expression)
          && ts.isIdentifier(statement.expression.expression.expression.expression.expression)
          && statement.expression.expression.expression.expression.expression.text === 'main');
        assert.equal(entries.length, 1, 'Only one unchanged automatic worker entry may be adapted');
        source = source.slice(0, entries[0].getFullStart()) + source.slice(entries[0].end) + '\nexport { main as __fixtureMain };\n';
      }
      const requireFixture = (request: string): unknown => {
        if (request === '@/lib/prisma' || request.endsWith('/src/lib/prisma')) return { prisma: db };
        if (request === 'node:fs') return guardedFs;
        if (request === 'node:path') return path;
        if (request === 'node:crypto') return crypto;
        if (request === 'node:child_process') return childProcess;
        if (request === '@next/env') return { loadEnvConfig: () => ({}) };
        if (request.startsWith('node:') || /^(?:https?|net|tls|dns|child_process|fs)$/.test(request)) return unknownModule(request);
        const resolved = resolveFile(request, file);
        const loaded = load<ModuleExports>(resolved);
        if (file === 'scripts/process-image-studio.ts' && ['src/lib/image-studio/worker.ts', 'src/lib/image-studio/batches.ts',
          'src/lib/tools/toolflow-runtime.ts', 'src/lib/image-studio/billing.ts'].includes(resolved)) return new Proxy(loaded, {
            get(target, property) { const value = Reflect.get(target, property);
              return typeof value === 'function' ? (...args: unknown[]) => { stageCalls.push(`${resolved}:${String(property)}`); return Reflect.apply(value, target, args); } : value; },
          });
        return loaded;
      };
      const output = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022, esModuleInterop: true, isolatedModules: true }, reportDiagnostics: true });
      assert.ok(!output.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error), `Cannot transpile original ${file}`);
      const context = { Buffer, Date, Error, TypeError, SyntaxError, URL, URLSearchParams, AbortController, AbortSignal,
        process: processFixture, console: { log: () => {}, error: () => {}, warn: () => {} },
        setInterval: () => 1, clearInterval: () => {},
        setTimeout: () => deny('timer:unexpected-delay'), clearTimeout: () => {},
        fetch: () => deny('network:fetch'), WebSocket: function () { return deny('network:websocket'); } };
      const wrapper = vm.runInNewContext(`(function(exports,require,module,__filename,__dirname){${output.outputText}\n})`, context,
        { filename: bundled, timeout: 10000 }) as (...args: unknown[]) => void;
      wrapper(module.exports, requireFixture, module, bundled, path.dirname(bundled));
      return module.exports as T;
    }
    return { load, processState, stageCalls };
  }

  try {
    process.chdir(fixtureRoot);
    equal(await database.user.count(), 0, 'Fixture user table must be empty');
    equal(await database.platformSetting.count(), 0, 'Fixture settings table must be empty');
    equal(await database.imageStudioTask.count(), 0, 'Fixture image tasks must be empty');
    equal(await database.toolFlowRun.count(), 0, 'Fixture toolflow runs must be empty');
    try {
      await database.$transaction(async tx => {
        const actor = await tx.user.create({ data: { name: 'G19 fixture', username: crypto.randomUUID(), email: `${crypto.randomUUID()}@fixture.invalid`,
          password_hash: 'fixture-not-login', role: 'admin', account_type: 'internal', status: 'active' } });
        const current = makeLoader(tx, 'candidate');
        const states = current.load<typeof StateModule>('src/lib/image-studio/pricing-state.ts');
        const isolation = current.load<typeof IsolationModule>('src/lib/pricing/isolation.ts');
        const runtime = current.load<typeof RuntimeModule>('src/lib/pricing/runtime.ts');
        for (const file of runtime.pricingRuntimeSourceFiles(candidateRoot)) {
          const destination = path.join(fixtureRoot, file);
          check(inside(destination, fixtureRoot), 'Runtime source destination must stay inside the isolated fixture');
          fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
          fs.copyFileSync(path.join(candidateRoot, file), destination, fs.constants.COPYFILE_EXCL);
        }
        equal(runtime.pricingRuntimeModuleHashes(fixtureRoot), runtime.pricingRuntimeModuleHashes(candidateRoot), 'Real process cwd contains the exact candidate runtime source bytes');
        check(isolation.readPricingWriterIsolation(), 'Root-prepared strict marker must be accepted before exercising capacity');
        const capacity = current.load<typeof CapacityModule>('src/lib/image-studio/queue-capacity.ts');
        const contracts = current.load<typeof BillingContractModule>('src/lib/image-studio/billing-contract.ts');
        const quotes = current.load<typeof BillingQuoteModule>('src/lib/image-studio/billing-quote.ts');
        const charges = current.load<typeof ChargeModule>('src/lib/pricing/charge.ts');
        const flowHelpers = current.load<FlowHelpers>('src/lib/tools/toolflow-runtime.ts');
        const batchHelpers = current.load<BatchHelpers>('src/lib/image-studio/batches.ts');
        const issuedAt = new Date().toISOString(), scope = 'c'.repeat(64);
        const fixedCharge: ChargeModule.FrozenPricingCharge = {
          schema: 'pricing-charge-v1', revision: 'G19-isolated-revision', ruleId: 'G19-isolated-rule',
          identity: { kind: 'image', channelId: 'shared', modelId: 'gpt-image-2', billingMode: 'fixed', unit: 'image', specifications: {} },
          binding: { configRevision: 'G19-isolated-config', billingPrincipalId: null,
            credentialVersion: 'G19-no-credential', configFingerprint: sha('G19-no-live-source') },
          basisKind: 'site_base_cny', mode: 'custom', baseCny: '1', pointsPerCny: '1.1', exchangeRate: null,
          legacyUnitCredits: null, legacyRounding: null, quantity: '1', issuedAt, rounding: 'half_up_tenth',
        };
        const actualCharge: ChargeModule.FrozenPricingCharge = { ...fixedCharge,
          identity: { ...fixedCharge.identity, billingMode: 'actual' }, basisKind: 'supplier_cost_cny', baseCny: null,
          exchangeRate: { sourceCurrency: 'USD', targetCurrency: 'CNY', direction: 'CNY_per_source_unit', rate: '7',
            revision: 'G19-isolated-exchange', effectiveFrom: issuedAt, confirmedAt: issuedAt,
            source: { type: 'admin_defined', reference: 'isolated fixture; not a supplier price', note: '' },
            confirmedBy: { id: actor.id, displayName: actor.name, avatarUrl: null } } };
        check(charges.parseFrozenPricingCharge(fixedCharge), 'Fixed seed must satisfy the current real frozen-charge parser');
        check(charges.parseFrozenPricingCharge(actualCharge), 'Actual seed must satisfy the current real frozen-charge parser');
        const specification = quotes.imageSpecification({ model: 'gpt-image-2', quality: 'medium', outputSize: '1K',
          aspectRatio: '1:1', referenceCount: 0, inputCharacters: 7 });
        const fixedContract = quotes.withPricingImageContract(quotes.fixedImageBillingContract({ scope,
          model: 'gpt-image-2', credits: 1.1, specification }), fixedCharge, 1.1);
        const actualContract = quotes.withPricingImageContract(quotes.fixedImageBillingContract({ scope,
          model: 'gpt-image-2', credits: 1.1, specification }), actualCharge, 1.1);
        check(contracts.parseImageBillingContract(JSON.stringify(fixedContract)), 'Private fixed contract must parse without a placeholder');
        check(contracts.parseImageBillingContract(JSON.stringify(actualContract)), 'Private actual contract must parse without a placeholder');
        const imageChannel = { channelId: 'original', configRevision: fixedCharge.binding.configRevision };
        const base = { owner_id: actor.id, batch_id: 'fixture-batch', ordinal: 0, fingerprint: 'fixture-fingerprint', prompt: 'fixture', context: '',
          revision: 0, model: 'gpt-image-2', reference_ids: '[]', unit_credits: 1.1, snapshot_json: '{}' };
        const privateIds: string[] = [];
        for (const status of ['queued', 'running', 'channel_queued', 'channel_running']) {
          const id = `rate-fixture-${status}`; privateIds.push(id);
          await tx.imageStudioTask.create({ data: { ...base, id, status: states.pricingTaskState(status, true),
            lease_token: status.includes('running') ? 'held-fixture' : null,
            lease_until: status.includes('running') ? new Date(Date.now() - 60000) : null,
            billing_mode: 'fixed', billing_scope: scope, billing_contract_json: JSON.stringify(fixedContract),
            snapshot_json: JSON.stringify({ version: 1, model: base.model, unitCredits: 1.1, billingContract: fixedContract, imageChannel }),
            billing_status: states.studioBillingState({ id }, 'awaiting_response') } });
        }
        for (const billing of ['pending', 'channel_pending']) {
          const id = `rate-fixture-${billing}`; privateIds.push(id);
          await tx.imageStudioTask.create({ data: { ...base, id, status: 'succeeded', billing_mode: 'actual',
            billing_scope: scope, gateway_request_id: `G19-${billing}`, billing_deadline: new Date(actualContract.deadline!),
            billing_status: states.studioBillingState({ id }, billing), billing_contract_json: JSON.stringify(actualContract),
            snapshot_json: JSON.stringify({ version: 1, model: base.model, billingContract: actualContract, imageChannel }) } });
        }
        await tx.imageStudioTask.create({ data: { ...base, id: 'legacy-unknown-fixture', status: 'uncertain', billing_status: 'legacy_unknown' } });
        const privateBatchId = 'b'.repeat(64), oldBatchId = 'a'.repeat(64);
        const batch = (id: string, pricing: boolean) => ({ version: pricing ? 2 : 1, ...(pricing ? { pricing: true } : {}), id, ownerId: actor.id,
          requestId: `fixture-${id}`, fingerprint: 'fixture', moduleId: 'fixture-module', moduleName: 'Fixture', state: 'ready', note: '',
          createdAt: new Date().toISOString(), total: 1, budget: 2, committedCredits: 0, unitCredits: 1.1, prepared: 1,
          input: pricing ? { model: base.model, imageChannel } : {},
          ...(pricing ? { billingMode: 'fixed', billingContracts: [fixedContract] } : {}),
          items: pricing ? [{ ordinal: 1, sourceName: 'private', taskId: null, attempt: 0, prepared: true, cancelled: false }]
            : [{ ordinal: 1, sourceName: 'cancelled control', taskId: null, attempt: 0, prepared: true, cancelled: true }] });
        const privateBatch = batch(privateBatchId, true);
        const privateBatchKey = batchHelpers.__fixtureBatchKey(actor.id, privateBatchId, false, true);
        equal(privateBatchKey, `${states.PRICING_BATCH_PREFIX}${actor.id}:${privateBatchId}`, 'Actual parent key must use the adopted namespace');
        const privateItemKey = batchHelpers.__fixtureBatchItemKey(privateBatch, 1);
        equal(privateItemKey, `${states.PRICING_BATCH_ITEM_PREFIX}${privateBatchId}:1`, 'Actual prepared-item key must use the adopted namespace');
        const preparedTask: Prisma.ImageStudioTaskUncheckedCreateInput = { ...base,
          id: batchHelpers.__fixtureBatchChildId(privateBatch, privateBatch.items[0]), batch_id: privateBatchId, ordinal: 1,
          status: states.pricingTaskState('queued', true), billing_status: states.studioBillingState({ billing_contract_json: JSON.stringify(fixedContract) }, 'awaiting_response'),
          billing_mode: 'fixed', billing_scope: scope, billing_contract_json: JSON.stringify(fixedContract),
          snapshot_json: JSON.stringify({ version: 1, batchId: privateBatchId, batchOrdinal: 1,
            model: base.model, billingContract: fixedContract, imageChannel, referenceImages: [], transientReferenceImages: [] }) };
        await tx.platformSetting.create({ data: { key: privateBatchKey, value_json: JSON.stringify(privateBatch) } });
        await tx.platformSetting.create({ data: { key: privateItemKey, value_json: JSON.stringify(preparedTask) } });
        const flow = await tx.toolFlow.create({ data: { owner_id: actor.id, name: 'G19 fixture', graph_json: '{}' } });
        const graph: ToolFlowGraph = { version: 1, nodes: [{ id: 'input', type: 'flow-input', x: 0, y: 0, data: {} },
          { id: 'template', type: 'flow-template', x: 100, y: 0, data: {} }], connections: [{ from: 'input', to: 'template' }] };
        const flowQuote = { flowId: flow.id, flowVersion: 1, settingsRevision: 0, estimatedCredits: 1.1,
          expiresAt: fixedContract.expiresAt, billingMode: 'fixed', steps: [{ nodeId: 'template', templateId: null,
            moduleId: null, templateVersion: null, model: base.model, count: 1, unitCredits: 1.1,
            estimatedCredits: 1.1, status: 'fixed', pricingRevision: fixedCharge.revision, contractDigest: specification }] };
        const frozenNode = { config: { prompt: 'fixture', context: '', model: base.model, quality: 'medium', count: 1,
          aspectRatio: '1:1', outputSize: '1K', referenceIds: [], moduleId: null, templateId: null, templateVersion: null, sourcePresetId: null },
          billingContract: fixedContract, imageChannel, settingsRevision: 0, authorizedCount: 1, maxReferences: 9, quote: flowQuote };
        const flowSnapshot = { schema: 'toolflow.v1', flow_id: flow.id, flow_owner_id: actor.id, version: 1,
          name: flow.name, project_id: null, graph, input_asset_ids: [], billing_mode: 'fixed', billing_quote: flowQuote,
          contract_version: 'toolflow-pricing-v1', node_contracts: { template: frozenNode } };
        equal(flowHelpers.__fixtureCurrentNodeContract(flowSnapshot, 'template'), frozenNode, 'Actual local reader recognizes complete frozen node_contracts');
        const privateRunIds: string[] = [];
        for (const state of ['queued', 'running']) {
          const id = `rate-tf-${sha(`${actor.id}\0${flow.id}\0G19-${state}`)}`;
          const run = await tx.toolFlowRun.create({ data: { id, flow_id: flow.id, owner_id: actor.id, flow_version: 1,
            status: flowHelpers.__fixtureToolFlowState(flowSnapshot, state), snapshot_json: JSON.stringify(flowSnapshot),
            node_runs: { create: [{ node_id: 'input', status: 'succeeded' },
              { node_id: 'template', status: flowHelpers.__fixtureToolFlowState(flowSnapshot, 'pending') }] } } });
          privateRunIds.push(run.id);
        }
        const beforePrivate = JSON.stringify(await tx.imageStudioTask.findMany({ where: { id: { in: privateIds } }, orderBy: { id: 'asc' } }));
        const beforeUnknown = JSON.stringify(await tx.imageStudioTask.findUnique({ where: { id: 'legacy-unknown-fixture' } }));
        const beforeBatch = (await tx.platformSetting.findUniqueOrThrow({ where: { key: privateBatchKey } })).value_json;
        const beforeItem = (await tx.platformSetting.findUniqueOrThrow({ where: { key: privateItemKey } })).value_json;
        const beforeRuns = JSON.stringify(await tx.toolFlowRun.findMany({ where: { id: { in: privateRunIds } }, include: { node_runs: true }, orderBy: { id: 'asc' } }));
        for (const variant of ['web', 'image'] as const) {
          const old = makeLoader(tx, variant), tasks = old.load<Tasks>('src/lib/image-studio/tasks.ts');
          phase = `${variant}:claim-private`;
          entered(variant, 'src/lib/image-studio/tasks.ts', 'claimStudioTask');
          equal(await tasks.claimStudioTask(), null, 'Actual old claim cannot claim a private rate_ task');
          entered(variant, 'src/lib/image-studio/worker.ts', 'processStudioTask');
          equal(await old.load<Worker>('src/lib/image-studio/worker.ts').processStudioTask(), false, 'Actual old worker sees no claimable private image');
          check(observations.some(item => item.phase === phase && item.model === 'imageStudioTask' && item.method === 'findMany'), 'Actual old selector must run against Prisma');
          phase = `${variant}:claim-legacy-control`;
          const controlId = `legacy-queued-${variant}`;
          await tx.imageStudioTask.create({ data: { ...base, id: controlId, status: 'queued', unit_credits: 5 } });
          entered(variant, 'src/lib/image-studio/tasks.ts', 'claimStudioTask');
          equal((await tasks.claimStudioTask())?.id, controlId, 'Actual old claim still claims a legal old queued task');
          await tx.imageStudioTask.update({ where: { id: controlId }, data: { status: 'succeeded' } });
          phase = `${variant}:billing-private`;
          const billId = `legacy-billing-${variant}`;
          await tx.imageStudioTask.create({ data: { ...base, id: billId, status: 'failed', billing_status: 'pending', billing_mode: 'fixed' } });
          entered(variant, 'src/lib/image-studio/billing.ts', 'reconcileImageBilling');
          await old.load<Billing>('src/lib/image-studio/billing.ts').reconcileImageBilling();
          equal((await tx.imageStudioTask.findUniqueOrThrow({ where: { id: billId } })).billing_status, 'unmatched', 'Actual old billing scanner handles its old control');
          check(observations.some(item => item.phase === phase && item.model === 'imageStudioTask' && item.method === 'findMany'), 'Actual old billing reads are required');
          phase = `${variant}:batch-private`;
          const oldKey = `studio_batch_v1:${actor.id}:${oldBatchId}`;
          await tx.platformSetting.upsert({ where: { key: oldKey }, create: { key: oldKey, value_json: JSON.stringify(batch(oldBatchId, false)) }, update: { value_json: JSON.stringify(batch(oldBatchId, false)) } });
          entered(variant, 'src/lib/image-studio/batches.ts', 'dispatchStudioBatches');
          await old.load<Batches>('src/lib/image-studio/batches.ts').dispatchStudioBatches();
          equal(JSON.parse((await tx.platformSetting.findUniqueOrThrow({ where: { key: oldKey } })).value_json).state, 'complete', 'Actual old batch dispatcher processes its old namespace control');
          equal((await tx.platformSetting.findUniqueOrThrow({ where: { key: privateBatchKey } })).value_json, beforeBatch, 'Private parent namespace must remain unchanged');
          equal((await tx.platformSetting.findUniqueOrThrow({ where: { key: privateItemKey } })).value_json, beforeItem, 'Private prepared child contract must remain unchanged');
          equal(await tx.imageStudioTask.count({ where: { id: String(preparedTask.id) } }), 0, 'Old dispatcher must not create the unaccepted private child');
          phase = `${variant}:toolflow-private`;
          const oldRun = await tx.toolFlowRun.create({ data: { flow_id: flow.id, owner_id: actor.id, flow_version: 1, status: 'queued',
            snapshot_json: JSON.stringify({ schema: 'toolflow.v1', graph, input_asset_ids: [] }),
            node_runs: { create: [{ node_id: 'input', status: 'pending' }, { node_id: 'template', status: 'pending' }] } } });
          entered(variant, 'src/lib/tools/toolflow-runtime.ts', 'dispatchWaitingToolFlowRuns');
          await old.load<Toolflow>('src/lib/tools/toolflow-runtime.ts').dispatchWaitingToolFlowRuns();
          equal((await tx.toolFlowNodeRun.findUniqueOrThrow({ where: { run_id_node_id: { run_id: oldRun.id, node_id: 'input' } } })).status, 'succeeded', 'Actual old flow advances its no-provider input wave');
          await tx.toolFlowRun.update({ where: { id: oldRun.id }, data: { status: 'paused' } });
          equal(JSON.stringify(await tx.toolFlowRun.findMany({ where: { id: { in: privateRunIds } }, include: { node_runs: true }, orderBy: { id: 'asc' } })), beforeRuns,
            'Old queued/running flow scanner must not touch private parents or their rate_pending nodes');
          for (const kind of ['ordinary', 'strict'] as const) {
            phase = `${variant}:old-main-${kind}-drain`;
            await atRoot(markerRoots[kind], async () => {
              fs.writeFileSync(path.join(process.cwd(), '.deployed-commit'), PRICING_LEGACY_SOURCES[variant].commit, { mode: 0o600 });
              const entry = makeLoader(tx, variant);
              entered(variant, 'scripts/process-image-studio.ts', 'main');
              await entry.load<{ __fixtureMain(): Promise<void> }>('scripts/process-image-studio.ts').__fixtureMain();
              equal(entry.stageCalls, [], 'Actual old main must break before recovery, billing, batch, flow or generation when marker exists');
              equal(entry.processState.exitCode, 0, 'Old drain must be an orderly stop, not a swallowed execution error');
            });
          }
          equal(JSON.stringify(await tx.imageStudioTask.findMany({ where: { id: { in: privateIds } }, orderBy: { id: 'asc' } })), beforePrivate,
            'No old consumer may change private claims, lease, charge or result fields');
          equal(JSON.stringify(await tx.imageStudioTask.findUnique({ where: { id: 'legacy-unknown-fixture' } })), beforeUnknown, 'Old unknown task must stay unchanged');
          equal(forbiddenCalls, [], 'Any swallowed forbidden provider/dependency attempt invalidates the result');
          evidence.push(`${variant}: original claim/process/billing/batch/toolflow/main executed on real isolated Prisma; private records unchanged; ordinary old controls reached their original branches`);
        }
        phase = 'candidate:capacity';
        await tx.imageStudioTask.updateMany({ where: { id: { in: privateIds.slice(0, 4) } }, data: { status: 'succeeded' } });
        for (let i = 0; i < 7; i += 1) await tx.imageStudioTask.create({ data: { ...base, id: `rate-capacity-${i}`, status: states.pricingTaskState('queued', true) } });
        const syncKey = `image_sync_request_v1:${actor.id}:fixture-sync`;
        await tx.platformSetting.create({ data: { key: syncKey, value_json: JSON.stringify({ schema: 'image.sync-admission.v1', ownerId: actor.id,
          requestId: 'fixture-sync', fingerprint: 'fixture', count: 1, model: 'gpt-image-2', scope: 'fixture', status: 'running', createdAt: new Date().toISOString(), finishedAt: null }) } });
        await reject(() => capacity.reserveImageStudioQueueCapacity(tx, actor.id, 1), 'Seven private plus one synchronous admission must fill capacity eight');
        await tx.platformSetting.update({ where: { key: syncKey }, data: { value_json: JSON.stringify({ schema: 'image.sync-admission.v1', ownerId: actor.id,
          requestId: 'fixture-sync', count: 1, status: 'accepted_unknown' }) } });
        equal((await capacity.reserveImageStudioQueueCapacity(tx, actor.id, 1)).active, 7, 'Ended synchronous unknown is not a live execution slot');
        for (const kind of ['ordinary', 'unprotected', 'wrong-schema', 'extra-field'] as const) {
          phase = `candidate:real-marker-${kind}`;
          await atRoot(markerRoots[kind], async () => {
            equal(isolation.readPricingWriterIsolation(), null, `Actual marker must be rejected: ${kind}`);
            equal(isolation.isImageStudioDraining(), true, `Invalid/ordinary marker must not bypass maintenance: ${kind}`);
            await reject(() => capacity.reserveImageStudioQueueCapacity(tx, actor.id, 1), `Actual ${kind} drain refuses new admission`);
            await reject(() => runtime.assertPricingImageConsumerReady(tx), `Actual ${kind} marker refuses new pricing readiness`);
          });
        }
        phase = 'candidate:live-capability';
        check(isolation.readPricingWriterIsolation(), 'Real root-owned immutable strict marker must reach the positive branch');
        equal(isolation.isImageStudioDraining(), false, 'Only exact strict isolation may allow new-code work');
        const captured = runtime.capturePricingWorkerCapability(source!);
        capturedIdentity = captured.instance;
        equal(captured.instance.pid, process.pid, 'Capability belongs to the real fixture process');
        equal(captured.instance.cwd, fs.realpathSync(process.cwd()), 'Capability cwd comes from real Linux /proc');
        equal(captured.parent.pid, process.ppid, 'Capability includes the actual parent process');
        await runtime.renewPricingWorkerCapability(tx, captured);
        equal((await runtime.assertPricingImageConsumerReady(tx)).workerId, captured.workerId, 'Real process and real root input reach readiness');
        const key = runtime.PRICING_IMAGE_CAPABILITY_KEY;
        await tx.platformSetting.update({ where: { key }, data: { value_json: JSON.stringify({ ...captured, expiresAt: new Date(Date.now() - 1).toISOString() }) } });
        await reject(() => runtime.assertPricingImageConsumerReady(tx), 'Expired capability must refuse new pricing admission');
        await tx.platformSetting.update({ where: { key }, data: { value_json: JSON.stringify({ ...captured, instance: { ...captured.instance, start: `${captured.instance.start}0` } }) } });
        await reject(() => runtime.assertPricingImageConsumerReady(tx), 'Wrong process instance must refuse new pricing admission');
        await tx.platformSetting.update({ where: { key }, data: { value_json: JSON.stringify({ ...captured, parent: { ...captured.parent, start: `${captured.parent.start}0` } }) } });
        await reject(() => runtime.assertPricingImageConsumerReady(tx), 'Wrong parent process instance must refuse new pricing admission');
        await tx.platformSetting.update({ where: { key }, data: { value_json: JSON.stringify({ ...captured,
          loadedModuleSha: { ...captured.loadedModuleSha, 'src/lib/image-studio/tasks.ts': '0'.repeat(64) } }) } });
        await reject(() => runtime.assertPricingImageConsumerReady(tx), 'Wrong loaded source hash must refuse new pricing admission');
        await runtime.renewPricingWorkerCapability(tx, captured);
        await runtime.revokePricingWorkerCapability(tx, captured);
        await reject(() => runtime.assertPricingImageConsumerReady(tx), 'Revoked consumer must refuse new pricing admission');
        equal(await tx.creditLedger.count(), 0, 'No fixture consumer may settle, freeze or refund money');
        equal(forbiddenCalls, [], 'No external/Provider or non-allowlisted subprocess call is allowed; real lsattr is the only subprocess');
        evidence.push('Candidate real capacity predicate counts seven private tasks + one synchronous execution as eight; ordinary drain stays closed; unknown ended sync does not occupy execution');
        evidence.push('Real Linux lstat/lsattr and /proc were used without metadata overrides. Build-user execution accepts only the root-owned immutable strict engineering marker; ordinary/unprotected/wrong-schema/extra-field inputs reject. Live fixture capability passes, then expired/wrong-instance/wrong-parent/wrong-module-hash/revoked receipts reject. This is not a production worker or ExecStartPre proof.');
        evidence.push('Toolflow seeds use current actual toolFlowState/currentNodeContract helpers: rate-tf parent IDs, rate_queued/rate_running, rate_pending nodes, toolflow.v1 + toolflow-pricing-v1 and complete frozen node_contracts. Image contracts are built and parsed by the current real billing factories.');
        evidence.push('Old Web is not claimed to understand the new pricing policy. Preventing its restart still requires the deployment ExecStartPre source/BUILD allowlist, verified separately by operations.');
        evidence.push(...PRICING_LEGACY_ADAPTATIONS);
        completed = true; throw rollback;
      }, { maxWait: 10000, timeout: 120000 });
    } catch (error) { if (error !== rollback) throw error; }
    phase = 'verification:rollback-and-root-inputs';
    check(completed, 'Entire G19 fixture must finish before reporting evidence');
    equal(await database.user.count(), 0, 'Fixture user writes rolled back');
    equal(await database.platformSetting.count(), 0, 'Fixture configuration writes rolled back');
    equal(await database.imageStudioTask.count(), 0, 'Fixture task writes rolled back');
    equal(await database.toolFlowRun.count(), 0, 'Fixture flow writes rolled back');
    equal(markerEvidence(), rootInputs, 'Root-prepared inputs remain byte- and metadata-identical; fixture never rewrites or removes a marker');
    check(capturedIdentity, 'Real process identity must be captured before completion');
    return { schema: 'pricing-legacy-consumer.v2', source: source!, checks: [{ id: 'G19', assertions, evidence }], forbiddenCalls,
      sources: PRICING_LEGACY_SOURCES, entrypoints, rootInputs, processIdentity: capturedIdentity!, observations,
      database: { path: databasePath, rolledBack: true }, adaptations: PRICING_LEGACY_ADAPTATIONS };
  } catch (error) {
    const failure = new Error(`RATE-G19 failed during ${phase}; isolated inputs retained, no success receipt produced`, { cause: error });
    Object.assign(failure, { fixtureFailure: { schema: 'pricing-legacy-consumer-failure.v1', completed: false, phase,
      source, sources: PRICING_LEGACY_SOURCES, databasePath, fixtureRoot, forbiddenCalls: [...forbiddenCalls],
      lastObservations: observations.slice(-20), entrypoints: [...entrypoints], rootInputs,
      recovery: 'Use a fresh root-prepared engineering directory for any retry. Never reuse this database, rewrite root markers, or fall back to production.' } });
    throw failure;
  } finally {
    try { process.chdir(originalCwd); } finally { await database.$disconnect(); }
  }
}
