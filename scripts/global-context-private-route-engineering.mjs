import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = fs.realpathSync(process.cwd()), require = createRequire(import.meta.url), ts = require('typescript');
const baselineCommit = '40466d533767d91cce17129e1d450a14b1b197c7';
const baselineSource = relative => execFileSync('git', ['show', `${baselineCommit}:${relative}`], { encoding: 'utf8' });
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'global-context-private-fixture-')));
fs.chmodSync(fixture, 0o700);
Object.assign(process.env, { NODE_ENV: 'test', PRIVATE_PROMPTS_FIXTURE_ROOT: fixture,
  PRIVATE_PROMPTS_POLICY_FILE: path.join(fixture, 'policy.json'), PRIVATE_PROMPTS_MIN_STATE: 'encrypted-write',
  PRIVATE_PROMPTS_CONSUMER_ID: 'fixture', PRIVATE_PROMPTS_RUNTIME_REVISION: 'a'.repeat(40),
  SESSION_SECRET: randomBytes(48).toString('hex'), DATABASE_URL: `file:${fixture}/fixture.db` });
const write = (file, value) => fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 });
const policy = { schema: 'private-prompt-policy.v1', revision: 'fixture-policy', state: 'encrypted-write', minimumReader: 1,
  identities: [{ userId: 'fixture-admin', tenant: 'fixture-tenant', subject: 'fixture-subject', administrator: true }],
  origins: [], authorKinds: [], destinations: [], consumers: ['fixture'],
  keys: Object.fromEntries(['body', 'index', 'backup'].map(domain => {
    const file = path.join(fixture, `${domain}.key`); write(file, randomBytes(32)); return [domain, { active: domain, files: { [domain]: file } }];
  })),
  activation: { inventoryId: 'fixture-inventory', restoreId: 'fixture-restore', writerFenceId: 'fixture-fence', attestationFile: path.join(fixture, 'consumers.json') },
  migrationVerified: { inventoryId: 'fixture-inventory', restoreId: 'fixture-restore', remainingPlaintext: 0 } };
write(process.env.PRIVATE_PROMPTS_POLICY_FILE, policy);
write(policy.activation.attestationFile, { schema: 'private-prompt-consumers.v1', policyRevision: policy.revision,
  inventoryId: 'fixture-inventory', restoreId: 'fixture-restore', writerFenceId: 'fixture-fence',
  consumers: [{ id: 'fixture', reader: 1, permissionContract: 1, sourceRevision: 'a'.repeat(40) }] });
const { PrismaClient } = require('@prisma/client'), rawDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } }, log: [] });
let db = rawDb;
let actor = { id: 'fixture-admin', role: 'admin' };
class AuthError extends Error { constructor(message, status) { super(message); this.status = status; } }
const empty = {}, cache = new Map(), checks = [];
const mocks = {
  'server-only': empty, '@/lib/prisma': { get prisma() { return db; } },
  '@/lib/auth/session': { getSession: async () => actor, AuthError },
  '@/lib/auth/api-helpers': { getAdminUser: async () => { if (actor?.role !== 'admin') throw new AuthError('fixture forbidden', 403); return actor; } },
  '@/lib/integrations/image-generation': { ImageGenerationChannelError: class extends Error {} },
  '@/lib/integrations/image-generation-defaults': empty, '@/lib/image-studio/billing-readiness': empty,
  '@/lib/pricing/image': empty, '@/lib/image-studio/task-settings-storage': empty, '@/lib/image-studio/task-settings': empty,
  '@/lib/pricing/runtime': empty,
};
function load(relative, baselineSource) {
  const file = path.resolve(root, relative), cacheKey = file + (baselineSource ? '#baseline' : '');
  if (cache.has(cacheKey)) return cache.get(cacheKey).exports;
  const module = { exports: {} }; cache.set(cacheKey, module);
  const localRequire = id => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (id.startsWith('@/') || id.startsWith('.')) {
      const base = id.startsWith('@/') ? path.join(root, 'src', id.slice(2)) : path.resolve(path.dirname(file), id);
      const actual = [base, base + '.ts', base + '.tsx', base + '.js'].find(f => fs.existsSync(f) && fs.statSync(f).isFile());
      assert.ok(actual, id); return load(path.relative(root, actual));
    }
    return require(id);
  };
  const source = ts.transpileModule(baselineSource ?? fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  new Function('require', 'module', 'exports', '__filename', '__dirname', 'fetch', source)(localRequire, module, module.exports,
    file, path.dirname(file), () => { throw new Error('External network forbidden'); });
  return module.exports;
}
const { NextRequest } = require('next/server');
try {
  await db.$executeRawUnsafe('CREATE TABLE PlatformSetting (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, value_json TEXT NOT NULL, updated_by TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  await db.$executeRawUnsafe('CREATE TABLE User (id TEXT PRIMARY KEY, role TEXT NOT NULL, status TEXT NOT NULL, expires_at DATETIME)');
  await db.$executeRawUnsafe("INSERT INTO User (id,role,status) VALUES ('fixture-admin','admin','active'),('fixture-ordinary','user','active')");
  await db.$queryRawUnsafe('PRAGMA journal_mode = WAL');
  const wrapped = load('src/lib/catalog-directory-writes.ts').catalogDirectoryWrites(rawDb);
  let transactionError;
  db = new Proxy(wrapped, { get(target, key) {
    const value = Reflect.get(target, key);
    if (key !== '$transaction') return value;
    return async (...args) => { const started = Date.now();
      try { return await value(...args); } catch (error) { transactionError = { code: error.code, elapsedMs: Date.now() - started }; throw error; } };
  } });
  const crypto = load('src/lib/security/private-prompts.server.ts'), identity = load('src/lib/security/private-prompt-identity.server.ts');
  const proof = identity.signVerifiedFeishuIdentity({ userId: actor.id, role: actor.role, tenant: 'fixture-tenant', subject: 'fixture-subject' }, 'synthetic-session');
  assert.equal(identity.authenticatePrivateIdentity(actor, proof, 'synthetic-session'), true);
  const origins = [crypto.privateOrigin('image-global', 'gpt_image_studio_v1')];
  await db.platformSetting.create({ data: { key: 'gpt_image_studio_v1', value_json: JSON.stringify({
    context: crypto.sealPrivatePrompt('synthetic-original-only', { kind: 'image-global', id: 'gpt_image_studio_v1', field: 'context', origins }),
    model: 'gpt-image-2.5-sunburst', revision: 7, prices: {} }), updated_by: actor.id } });
  const route = load('src/app/api/image-studio/settings/route.ts');
  const get = query => route.GET(new NextRequest(`https://fixture.invalid/api/image-studio/settings?${query}`));
  const put = body => route.PUT(new NextRequest('https://fixture.invalid/api/image-studio/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  let response = await get('mode=private-editor&id=gpt_image_studio_v1');
  assert.equal(response.status, 200); assert.equal((await response.json()).draft, null);
  const rowsBefore = await db.platformSetting.count();
  response = await get('mode=private-editor&id=gpt_image_studio_v1'); await response.json();
  assert.equal(await db.platformSetting.count(), rowsBefore); checks.push('private_read_uses_real_cipher_without_draft_writes');
  const original = { action: 'save-private-draft', id: 'gpt_image_studio_v1', requestId: randomUUID(), expectedRevision: 0,
    sourceRevision: '7', values: { prompt: '', context: 'synthetic-edited-only' } };
  response = await put(original); assert.equal(response.status, 200); const saved = await response.json();
  assert.equal(saved.revision, 1); assert.equal(saved.values.context, original.values.context);
  assert.equal((await db.platformSetting.findMany()).some(row => row.value_json.includes('synthetic-edited-only')), false);
  const count = await db.platformSetting.count(); response = await put(original); assert.equal(response.status, 200); assert.deepEqual(await response.json(), saved);
  assert.equal(await db.platformSetting.count(), count); checks.push('real_encrypted_draft_and_receipt_are_atomic_and_idempotent');
  response = await get(`mode=private-draft-status&requestId=${original.requestId}`); const status = await response.json();
  assert.equal(status.requestId, original.requestId); assert.deepEqual(status.draft, saved);
  response = await put({ ...original, values: { ...original.values, context: 'different-fingerprint' } }); assert.equal(response.status, 409);
  response = await put({ ...original, requestId: randomUUID() }); assert.equal(response.status, 200); assert.equal((await response.json()).state, 'not-applied');
  checks.push('original_receipt_fingerprint_and_revision_conflicts_remain_enforced');
  response = await get(`mode=private-draft-status&requestId=${randomUUID()}`); assert.equal((await response.json()).draft, null);
  checks.push('absent_original_receipt_is_unknown_without_rewriting_it');
  const definition = { action: 'save-private-definition', id: 'gpt_image_studio_v1', requestId: randomUUID(), revision: 7, sourceRevision: '7',
    prompt: '', context: original.values.context };
  response = await put(definition); assert.equal(response.status, 200); assert.equal((await response.json()).revision, 8);
  response = await get(`mode=private-save-status&requestId=${definition.requestId}`); assert.equal((await response.json()).state, 'saved');
  response = await get('mode=private-editor&id=gpt_image_studio_v1'); const after = await response.json();
  assert.equal(after.context, original.values.context); assert.equal(after.draft.appliedRequestId, definition.requestId);
  assert.equal(await db.platformSetting.count({ where: { key: { startsWith: 'catalog_directory_revision_v1:' } } }), 2);
  checks.push('explicit_definition_save_uses_real_cas_and_marks_exact_draft_applied');
  checks.push('production_catalog_directory_wrapper_executes_real_revision_writes');
  const earlierDraft = { ...original, requestId: randomUUID(), expectedRevision: 1, sourceRevision: '8', values: { prompt: '', context: 'synthetic-earlier-draft' } };
  response = await put(earlierDraft); assert.equal(response.status, 200); assert.equal((await response.json()).revision, 2);
  const independentDefinition = { ...definition, requestId: randomUUID(), revision: 8, sourceRevision: '8', context: 'synthetic-current-definition' };
  response = await put(independentDefinition); assert.equal(response.status, 200); assert.equal((await response.json()).state, 'saved');
  checks.push('explicit_definition_can_commit_without_a_confirmed_draft_receipt');
  response = await get('mode=private-editor&id=gpt_image_studio_v1'); const earlier = await response.json();
  assert.equal(earlier.context, independentDefinition.context); assert.equal(earlier.draft.values.context, earlierDraft.values.context);
  assert.equal(earlier.draft.sourceRevision, '8'); assert.equal(earlier.draft.appliedRequestId, undefined);
  response = await get(`mode=private-draft-status&requestId=${earlierDraft.requestId}`); assert.equal((await response.json()).draft.values.context, earlierDraft.values.context);
  checks.push('earlier_different_draft_remains_queryable_and_unapplied_after_new_definition_commit');
  const lateDraft = { ...original, requestId: randomUUID(), expectedRevision: 2, sourceRevision: '8', values: { prompt: '', context: 'synthetic-late-old-draft' } };
  response = await put(lateDraft); assert.equal(response.status, 200); assert.equal((await response.json()).state, 'not-applied');
  response = await get(`mode=private-draft-status&requestId=${lateDraft.requestId}`); assert.equal((await response.json()).draft.state, 'not-applied');
  response = await get('mode=private-editor&id=gpt_image_studio_v1'); const unchangedDefinition = await response.json();
  assert.equal(unchangedDefinition.revision, 9); assert.equal(unchangedDefinition.context, independentDefinition.context);
  assert.equal(unchangedDefinition.draft.values.context, earlierDraft.values.context); assert.equal(unchangedDefinition.draft.appliedRequestId, undefined);
  response = await get(`mode=private-draft-status&requestId=${original.requestId}`); assert.deepEqual((await response.json()).draft, saved);
  checks.push('late_old_global_draft_is_rejected_atomically_without_rewriting_prior_receipts_or_new_definition');

  const baselineRoute = load('src/app/api/image-studio/settings/route.ts', baselineSource('src/app/api/image-studio/settings/route.ts'));
  const blockedInput = { ...original, requestId: randomUUID(), expectedRevision: 2, sourceRevision: '9' };
  const locker = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } }, log: [] });
  const lockProof = [];
  try {
    await locker.$queryRawUnsafe('PRAGMA busy_timeout = 0');
    for (const [name, writeRoute, expected] of [['baseline', baselineRoute, 500], ['current', route, 503]]) {
      const input = { ...blockedInput, requestId: randomUUID() };
      await locker.$executeRawUnsafe('BEGIN IMMEDIATE');
      try {
        transactionError = null;
        const result = await writeRoute.PUT(new NextRequest('https://fixture.invalid/api/image-studio/settings', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }));
        const body = await result.json();
        assert.ok(['P1008', 'P2028'].includes(transactionError?.code), JSON.stringify(transactionError));
        assert.equal(result.status, expected);
        if (name === 'current') assert.equal(body.requestId, input.requestId);
        lockProof.push({ name, status: result.status, ...transactionError });
      } finally { await locker.$executeRawUnsafe('ROLLBACK'); }
      const status = await (await get(`mode=private-draft-status&requestId=${input.requestId}`)).json();
      assert.equal(status.draft, null);
    }
    checks.push('real_sqlite_busy_is_old_500_and_recoverable_503_with_original_id_and_no_receipt_fabrication');
    const resolution = load('src/lib/image-studio/resolution-apply.ts');
    const baselineResolution = load('src/lib/image-studio/resolution-apply.ts', baselineSource('src/lib/image-studio/resolution-apply.ts'));
    function delayedClient() {
      let entered, release;
      const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
      const user = delegate => ({ findUnique: async args => { entered(); await gate; return delegate.findUnique(args); } });
      return { started, release, client: { user: user(db.user), platformSetting: db.platformSetting,
        $transaction: callback => db.$transaction(tx => callback(new Proxy(tx, { get(target, key) { return key === 'user' ? user(tx.user) : Reflect.get(target, key); } }))) } };
    }
    const old = delayedClient(), oldRead = baselineResolution.readResolutionOperations('fixture-admin', undefined, 0, old.client);
    await old.started;
    try { await assert.rejects(locker.$executeRawUnsafe('BEGIN IMMEDIATE'), error => error.code === 'P2010' && /locked|busy/i.test(String(error.meta?.message))); }
    finally { old.release(); await oldRead; }
    const current = delayedClient(), currentRead = resolution.readResolutionOperations('fixture-admin', undefined, 0, current.client);
    await current.started;
    try {
      await locker.$executeRawUnsafe('BEGIN IMMEDIATE'); await locker.$executeRawUnsafe('ROLLBACK');
      const result = await put({ ...blockedInput, requestId: randomUUID() }); assert.equal(result.status, 200); assert.equal((await result.json()).revision, 3);
    } finally { current.release(); await currentRead; }
    checks.push('baseline_history_holds_sqlite_writer_lock_current_history_allows_real_draft_during_slow_read');
  } finally { await locker.$disconnect(); }
  actor = { id: 'fixture-ordinary', role: 'user' }; response = await put(original); assert.equal(response.status, 403);
  checks.push('ordinary_account_cannot_write_private_global');
  const resolution = load('src/lib/image-studio/resolution-apply.ts');
  const readOnly = { user: db.user, platformSetting: db.platformSetting, $transaction() { throw new Error('History list must not acquire transaction'); } };
  const history = await resolution.readResolutionOperations('fixture-admin', undefined, 0, readOnly); assert.deepEqual(history.operations, []);
  await assert.rejects(resolution.readResolutionOperations('fixture-ordinary', undefined, 0, readOnly), error => error.status === 403);
  checks.push('history_listing_uses_no_interactive_transaction_and_keeps_admin_gate');
  console.log(JSON.stringify({ passed: true, checks, cases: checks.length, fixture, realEncryption: true, realSQLite: true,
    productionRouteExecuted: true, productionCatalogDirectoryWrapper: true, baselineCommit, lockProof, authenticationTransportStubOnly: true, live500RootCauseProven: false,
    syntheticPlaintextOnly: true, externalRequests: 0, productionReads: 0, productionWrites: 0 }));
} finally { await db.$disconnect(); }
