import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';

const root = process.cwd(), require = createRequire(import.meta.url);
const ts = require('typescript'), { NextRequest, NextResponse } = require('next/server');
const { PrismaClient, Prisma } = require('@prisma/client');
const args = process.argv.slice(2), sourceOnly = args.includes('--source-only'), observeRace = args.includes('--observe-race');
const destination = args.find(value => !value.startsWith('--'));
assert.ok(destination && path.isAbsolute(destination), 'An absolute private receipt path is required');
const baselinePath = process.env.QUEUE_PRESET_BASELINE_SOURCE || path.join(path.dirname(destination), 'queue-preset-engineering-baseline.json');
const libFile = 'src/lib/bridge/queue-presets.ts', sharedFile = 'src/app/api/bridge/queue-presets/_shared.ts';
const routeFile = 'src/app/api/bridge/queue-presets/route.ts';
const migrationFile = 'prisma/migrations/20261101090000_bridge_queue_presets/migration.sql';
const sourceFiles = [libFile, sharedFile, routeFile, 'src/app/api/bridge/queue-presets/[id]/route.ts',
  'src/app/api/bridge/queue-presets/[id]/[action]/route.ts', 'src/lib/users/display.ts', migrationFile,
  'prisma/schema.prisma', 'scripts/queue-preset-engineering.mjs'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
for (const [file, text] of Object.entries(baseline.files)) assert.equal(hash(text), baseline.sha256[file], `Baseline changed: ${file}`);
const source = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, await fs.readFile(path.join(root, file), 'utf8')])));
const sourceSha256 = Object.fromEntries(Object.entries(source).map(([file, text]) => [file, hash(text)]));
const checks = [], examples = {}, observedErrors = [];
let forbiddenCalls = 0, networkCalls = 0, client, scratch, activeUser;
const previousExtensionIds = process.env.SD2B_EXTENSION_IDS, previousFetch = globalThis.fetch;
const forbidden = label => { forbiddenCalls++; throw new Error(`Forbidden fixture boundary: ${label}`); };
globalThis.fetch = () => { networkCalls++; return forbidden('network'); };
const logger = { error: (_label, error) => observedErrors.push({ name: error?.name || 'Error', code: error?.code || null }) };
const evaluate = (file, imports, text = source[file]) => {
  const evaluated = { exports: {} };
  const compiled = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  new Function('require', 'module', 'exports', 'console', 'fetch', compiled)(name => {
    if (Object.hasOwn(imports, name)) return imports[name];
    return forbidden(`import:${name}`);
  }, evaluated, evaluated.exports, logger, globalThis.fetch);
  return evaluated.exports;
};
const display = evaluate('src/lib/users/display.ts', {});
const user = (id, role = 'user') => ({ id, role, name: 'Synthetic ' + id, username: id, email: id + '@fixture.invalid',
  account_type: 'internal', user_profile: 'other', feature_profile_id: null, status: 'active', expires_at: null });
const owner = user('fixture-owner'), other = user('fixture-other'), admin = user('fixture-admin', 'admin');
activeUser = owner;
const services = (db, old = false) => evaluate(libFile, { '@prisma/client': { Prisma }, '@/lib/prisma': { prisma: db }, '@/lib/users/display': display }, old ? baseline.files[libFile] : source[libFile]);
const shared = (service, old = false) => evaluate(sharedFile, { 'next/server': { NextRequest, NextResponse },
  '@/lib/auth/session': { getSession: async () => activeUser }, '@/lib/bridge/queue-presets': service }, old ? baseline.files[sharedFile] : source[sharedFile]);
const route = (service, common, old = false) => evaluate(routeFile, { '@/lib/bridge/queue-presets': service,
  './_shared': common }, old ? baseline.files[routeFile] : source[routeFile]);
const request = (query = '', origin, body) => new NextRequest('https://sd2.fixture.invalid/api/bridge/queue-presets' + query,
  { method: body ? 'POST' : 'GET', headers: { host: 'sd2.fixture.invalid', ...(origin === undefined ? {} : { origin }),
    ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
const body = (name, clientId) => ({ name, items: [{ text: 'Synthetic fixture text', images: [{ name: 'fixture', type: 'image/png', url: '/uploads/fixture.png' }] }], ...(clientId ? { clientId } : {}) });
const isPresetError = (service, status) => error => error instanceof service.PresetError && error.status === status;

async function pureChecks() {
  let captured;
  const readArguments = { bridgeQueuePreset: { findMany: async args => { captured = args; return []; }, count: async () => 0 } };
  const old = services(readArguments, true), fixed = services(readArguments);
  const relativeEscapes = ['//outside.fixture.invalid/image.png', '/\\outside.fixture.invalid/image.png', '/\t/outside.fixture.invalid/image.png'];
  examples.relativeEscapes = relativeEscapes.map(url => {
    assert.equal(old.parseItems([{ text: '', images: [{ url }] }])[0].images[0].url, url);
    const resolved = new URL(url, 'https://sd2.fixture.invalid'); assert.notEqual(resolved.origin, 'https://sd2.fixture.invalid');
    assert.throws(() => fixed.parseItems([{ text: '', images: [{ url }] }]), isPresetError(fixed, 400));
    return { input: url, originalAccepted: true, resolvedOrigin: resolved.origin, fixedStatus: 400 };
  });
  for (const url of ['/uploads/fixture.png', '/uploads/file name.png?q=1#view', 'https://legacy.example.org/old.png', 'https://any-other.example.net/image.png']) {
    assert.equal(fixed.parseItems([{ text: '', images: [{ url }] }])[0].images[0].url, url);
  }
  for (const url of ['http://outside.fixture.invalid/x', 'javascript:alert(1)']) assert.throws(() => fixed.parseItems([{ images: [{ url }] }]), isPresetError(fixed, 400));
  checks.push('actual_original_parseItems_relative_origin_escapes_rejected_without_restricting_legacy_https');
  await old.listPresets(owner, { scope: 'mine', limit: 2.9, offset: 1.7 });
  assert.equal(captured.take, 2.9); assert.equal(captured.skip, 1.7);
  await fixed.listPresets(owner, { scope: 'mine', limit: 2.9, offset: 1.7 });
  assert.equal(captured.take, 2); assert.equal(captured.skip, 1);
  await fixed.listPresets(owner, { scope: 'mine', limit: 999, offset: Infinity });
  assert.equal(captured.take, 200); assert.equal(captured.skip, 0);
  examples.paginationArguments = { original: { take: 2.9, skip: 1.7 }, fixed: { take: 2, skip: 1 }, sqlValidationTested: false };
  checks.push('actual_list_function_normalizes_fractional_pagination_arguments_once');
  const oldCommon = shared(old, true), fixedCommon = shared(fixed);
  let called = 0;
  const callback = async () => { called++; return { fixture: true }; };
  const originalBad = await oldCommon.withUser(request('', 'not-an-origin'), true, callback);
  assert.equal(originalBad.status, 500);
  for (const origin of ['not-an-origin', 'null', 'chrome-extension://']) {
    const result = await fixedCommon.withUser(request('', origin), true, callback); assert.equal(result.status, 403);
  }
  assert.equal(called, 0);
  process.env.SD2B_EXTENSION_IDS = 'fixture-extension';
  for (const origin of [undefined, 'https://sd2.fixture.invalid', 'chrome-extension://fixture-extension']) {
    const result = await fixedCommon.withUser(request('', origin), true, callback); assert.equal(result.status, 200);
    assert.equal(result.headers.get('Cache-Control'), 'no-store'); assert.equal(result.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal((await fixedCommon.withUser(request('', 'chrome-extension://other-extension'), true, callback)).status, 403);
  assert.equal((await fixedCommon.withUser(request('', 'not-an-origin'), false, callback)).status, 200);
  activeUser = null; assert.equal((await fixedCommon.withUser(request('', 'not-an-origin'), true, callback)).status, 401); activeUser = owner;
  examples.invalidOrigin = { originalStatus: 500, fixedStatus: 403 };
  checks.push('actual_withUser_invalid_origin_is_403_valid_site_extension_and_login_contract_unchanged');
}

async function createDatabase() {
  const models = Prisma.dmmf.datamodel.models.map(model => model.name);
  assert.ok(models.includes('BridgeQueuePreset') && models.includes('BridgeQueuePresetLike'), 'Private generated Prisma client with both queue models is required; do not generate in shared node_modules');
  assert.equal(await fs.stat(path.join(root, '.env')).then(() => true, () => false), false, 'Isolated source must have no .env');
  const url = process.env.DATABASE_URL;
  assert.ok(url?.startsWith('file:/'), 'Explicit absolute fixture DATABASE_URL is required');
  const file = path.resolve(url.slice(5)); scratch = path.dirname(file);
  assert.ok(path.basename(scratch).startsWith('queue-preset-fixture-'), 'Use a fresh self-owned queue-preset-fixture-* directory');
  assert.equal(await fs.realpath(scratch), scratch); assert.deepEqual(await fs.readdir(scratch), []);
  assert.ok(!destination.startsWith(scratch + path.sep));
  client = new PrismaClient({ datasources: { db: { url } }, log: [] });
  const ddl = source[migrationFile].split(';').map(sql => sql.trim()).filter(Boolean);
  assert.equal(ddl.length, 7);
  for (const sql of ddl) { assert.match(sql.replace(/^--[^\n]*\n/, '').trim(), /^CREATE (TABLE|(?:UNIQUE )?INDEX) /); await client.$executeRawUnsafe(sql); }
  // Only the existing User projection needed by present(); column/default
  // definitions come from this isolated generated client's real schema.
  const model = Prisma.dmmf.datamodel.models.find(item => item.name === 'User');
  const columns = model.fields.filter(field => field.kind !== 'object').map(field => {
    assert.match(field.name, /^[a-zA-Z0-9_]+$/);
    let clause = `"${field.name}" ${['Int', 'BigInt', 'Boolean', 'DateTime'].includes(field.type) ? 'INTEGER' : 'TEXT'}`;
    if (field.isId) clause += ' PRIMARY KEY';
    if (field.isUnique) clause += ' UNIQUE';
    if (field.default?.name === 'now') clause += ' DEFAULT CURRENT_TIMESTAMP';
    else if (typeof field.default === 'string') clause += ` DEFAULT '${field.default.replaceAll("'", "''")}'`;
    else if (typeof field.default === 'boolean' || typeof field.default === 'number') clause += ` DEFAULT ${Number(field.default)}`;
    return clause;
  });
  await client.$executeRawUnsafe(`CREATE TABLE "User" (${columns.join(',')})`);
  for (const actor of [owner, other, admin]) await client.user.create({ data: { id: actor.id, name: actor.name, username: actor.username,
    email: actor.email, password_hash: 'synthetic-unusable-password', role: actor.role, account_type: actor.account_type }, select: { id: true } });
  const indexes = await client.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'BridgeQueuePreset%' ORDER BY name");
  assert.equal(indexes.length, 5);
}

async function race(old) {
  const clientId = 'race-' + randomUUID(), faults = [];
  let arrived = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const delegate = client.bridgeQueuePreset;
  const synchronized = new Proxy(delegate, { get(target, property) {
    if (property === 'findFirst') return async args => {
      const value = await target.findFirst(args);
      if (args.where?.owner_id === owner.id && args.where.client_id === clientId && value === null) {
        if (++arrived === 2) release(); await gate;
      }
      return value;
    };
    if (property === 'create') return async args => {
      try { return await target.create(args); }
      catch (error) { faults.push({ code: error.code || null, name: error.name, target: error.meta?.target || null }); throw error; }
    };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const observed = new Proxy(client, { get(target, property) {
    if (property === 'bridgeQueuePreset') return synchronized;
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const service = services(observed, old), common = shared(service, old), api = route(service, common, old);
  const responses = await Promise.all([api.POST(request('', undefined, body('Race one', clientId))), api.POST(request('', undefined, body('Race two', clientId)))]);
  const values = await Promise.all(responses.map(response => response.json()));
  return { statuses: responses.map(response => response.status), ids: values.map(value => value.preset?.id || null), names: values.map(value => value.preset?.name || null),
    rows: await client.bridgeQueuePreset.count({ where: { owner_id: owner.id, client_id: clientId } }), faults, synchronizedReads: arrived };
}

async function databaseChecks() {
  const fixed = services(client), fixedApi = route(fixed, shared(fixed));
  for (let index = 0; index < 3; index++) await fixed.createPreset(owner, body('Page ' + index));
  const old = services(client, true), oldApi = route(old, shared(old, true), true);
  const oldPage = await oldApi.GET(request('?limit=1.9&offset=0.2'));
  const fixedPage = await fixedApi.GET(request('?limit=1.9&offset=0.2'));
  const oldPageBody = await oldPage.json(), fixedPageBody = await fixedPage.json();
  assert.equal(fixedPage.status, 200); assert.equal(fixedPageBody.presets.length, 1);
  examples.paginationSql = { originalStatus: oldPage.status, originalRows: oldPageBody.presets?.length ?? null,
    fixedStatus: fixedPage.status, fixedRows: fixedPageBody.presets.length, actualPrisma: true };
  checks.push('real_prisma_integer_page_correct_without_assuming_original_fractional_error');
  const input = body('Private preset', 'sequential-client'); input.items[0].images[0].url = 'https://legacy.example.org/saved.png';
  const created = await fixed.createPreset(owner, input);
  assert.equal(created.items[0].images[0].url, input.items[0].images[0].url);
  const duplicate = await fixed.createPreset(owner, body('Ignored duplicate payload', 'sequential-client'));
  assert.equal(duplicate.id, created.id); assert.equal(duplicate.name, created.name); assert.deepEqual(duplicate.items, created.items);
  const separate = await fixed.createPreset(other, body('Other owner', 'sequential-client')); assert.notEqual(separate.id, created.id);
  await assert.rejects(fixed.updatePreset(other, created.id, { name: 'Forbidden' }), isPresetError(fixed, 403));
  await assert.rejects(fixed.recordUse(other, created.id), isPresetError(fixed, 404));
  await fixed.updatePreset(owner, created.id, { shared: true });
  assert.ok((await fixed.listPresets(other, { scope: 'shared' })).presets.some(row => row.id === created.id));
  const liked = await fixed.toggleLike(other, created.id); assert.equal(liked.likes, 1); assert.equal(liked.likedByMe, true);
  const unliked = await fixed.toggleLike(other, created.id); assert.equal(unliked.likes, 0); assert.equal(unliked.likedByMe, false);
  const beforeUse = await client.bridgeQueuePreset.findUnique({ where: { id: created.id } });
  const used = await fixed.recordUse(other, created.id); assert.equal(used.uses, 1); assert.equal(used.updatedAt, beforeUse.updated_at.getTime());
  const copied = await fixed.copyPreset(other, created.id); assert.equal(copied.ownerId, other.id); assert.equal(copied.shared, false); assert.equal(copied.copiedFrom, created.id);
  assert.equal((await fixed.updatePreset(admin, created.id, { name: 'Admin edit' })).name, 'Admin edit');
  await fixed.toggleLike(other, created.id); await fixed.deletePreset(owner, created.id);
  assert.equal(await client.bridgeQueuePresetLike.count({ where: { preset_id: created.id } }), 0);
  assert.equal(await client.bridgeQueuePreset.count({ where: { id: created.id } }), 0);
  checks.push('real_prisma_original_functions_crud_sharing_owner_admin_copy_like_use_contract');
  examples.baselineRace = await race(true);
  if (!observeRace) {
    assert.deepEqual(examples.baselineRace.statuses.slice().sort(), [200, 500]);
    assert.equal(examples.baselineRace.rows, 1); assert.ok(examples.baselineRace.faults.some(error => error.code === 'P2002'));
    examples.fixedRace = await race(false);
    assert.deepEqual(examples.fixedRace.statuses, [200, 200]); assert.equal(examples.fixedRace.rows, 1);
    assert.ok(examples.fixedRace.ids[0] && examples.fixedRace.ids[0] === examples.fixedRace.ids[1]);
    assert.equal(examples.fixedRace.names[0], examples.fixedRace.names[1]);
    checks.push('real_prisma_concurrent_original_unique_error_fixed_same_owner_client_readback');
  }
}

let failure;
const startedAt = Date.now();
try {
  await pureChecks();
  if (!sourceOnly) { await createDatabase(); await databaseChecks(); }
} catch (error) { failure = error; }
finally {
  try { if (client) await client.$disconnect(); if (scratch && client) await fs.rm(scratch, { recursive: true, force: true }); }
  catch (error) { if (!failure) failure = error; else console.error('QUEUE_PRESET_FIXTURE_CLEANUP_FAILED', error); }
  globalThis.fetch = previousFetch;
  if (previousExtensionIds === undefined) delete process.env.SD2B_EXTENSION_IDS; else process.env.SD2B_EXTENSION_IDS = previousExtensionIds;
}
if (failure) throw failure;
assert.equal(forbiddenCalls, 0); assert.equal(networkCalls, 0);
for (const file of sourceFiles) assert.equal(hash(await fs.readFile(path.join(root, file))), sourceSha256[file], `Candidate changed: ${file}`);
await fs.writeFile(destination, JSON.stringify({ schema: 'queue-preset-engineering.v1', completed: true, sourceOnly,
  investigationOnly: observeRace, actualPrismaExecuted: !sourceOnly, startedAt, finishedAt: Date.now(), checks, examples,
  sourceSha256, baselineSha256: baseline.sha256, clientVersion: Prisma.prismaVersion.client, forbiddenCalls, networkCalls,
  productionDatabaseOpened: false, productionWrites: 0, browserRuns: 0, fixtureDatabaseRemoved: !sourceOnly,
  scope: 'Actual source functions; source-only SQL arguments are not DB proof; real mode uses the unchanged additive migration and actual Prisma in a disposable DB; not production auth/CRUD acceptance' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log('QUEUE_PRESET_ENGINEERING_RECEIPT=' + destination);
