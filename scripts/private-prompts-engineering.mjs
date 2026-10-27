import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PRIVATE_PROMPTS_CHECKS, PRIVATE_PROMPTS_SOURCES } from './private-prompts-fixture-inputs.mjs';
import { checkPrivateWorkerFailures } from './private-prompts-worker-fixture.mjs';

const startedAt = new Date().toISOString(), root = fs.realpathSync(process.cwd());
const require = createRequire(path.join(root, 'package.json')), ts = require('typescript');
const fixtureParent = process.env.MULTIVIEW_PRIVATE_FIXTURE_ROOT || os.tmpdir();
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(fixtureParent, 'private-prompts-fixture-')));
fs.chmodSync(fixture, 0o700);
Object.assign(process.env, { NODE_ENV: 'test', PRIVATE_PROMPTS_FIXTURE_ROOT: fixture,
  PRIVATE_PROMPTS_POLICY_FILE: path.join(fixture, 'policy.json'), PRIVATE_PROMPTS_MIN_STATE: 'compatible-read',
  PRIVATE_PROMPTS_CONSUMER_ID: 'fixture', PRIVATE_PROMPTS_RUNTIME_REVISION: 'a'.repeat(40),
  SESSION_SECRET: randomBytes(48).toString('hex'), DATABASE_URL: `file:${fixture}/fixture.db` });
const write = (file, value) => fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 });
const sha = value => createHash('sha256').update(value).digest('hex');
const policy = { schema: 'private-prompt-policy.v1', revision: 'fixture-policy', state: 'compatible-read', minimumReader: 1,
  identities: [{ userId: 'author', tenant: 'tenant', subject: 'author-subject' }, { userId: 'admin', tenant: 'tenant', subject: 'admin-subject', administrator: true }],
  origins: [{ kind: 'image-module', id: 'module', ownerId: 'author' }],
  authorKinds: [{ ownerId: 'author', kinds: ['image-module', 'image-preset', 'skill', 'video-template'] }],
  keys: Object.fromEntries(['body', 'index', 'backup'].map(domain => {
    const file = path.join(fixture, `${domain}.key`); write(file, randomBytes(32));
    return [domain, { active: domain, files: { [domain]: file } }];
  })), destinations: [], consumers: ['fixture'],
  activation: { inventoryId: 'fixture-inventory', restoreId: 'fixture-restore', writerFenceId: 'fixture-fence', attestationFile: path.join(fixture, 'consumers.json') },
  migrationVerified: { inventoryId: 'fixture-inventory', restoreId: 'fixture-restore', remainingPlaintext: 0 } };
const savePolicy = () => write(process.env.PRIVATE_PROMPTS_POLICY_FILE, policy);
savePolicy();
write(policy.activation.attestationFile, { schema: 'private-prompt-consumers.v1', policyRevision: policy.revision,
  ...Object.fromEntries(['inventoryId', 'restoreId', 'writerFenceId'].map(key => [key, policy.activation[key]])),
  consumers: [{ id: 'fixture', reader: 1, permissionContract: 1, sourceRevision: 'a'.repeat(40) }] });
let actor = null, db;
const checks = [];
function loader(mutations = {}) {
  const cache = new Map();
  function load(relative) {
    const file = path.resolve(root, relative);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    let source = fs.readFileSync(file, 'utf8');
    if (mutations[relative]) source = mutations[relative](source);
    const localRequire = id => {
      if (id === 'server-only') return {};
      if (id === '@/lib/prisma') return { prisma: db };
      if (id === '@/lib/auth/session') return { getSession: async () => actor, AuthError: class extends Error {} };
      if (id === '@/lib/auth/api-helpers') return { getAdminUser: async () => { if (actor?.role !== 'admin') throw new Error(); return actor; } };
      if (id.startsWith('@/') || id.startsWith('.')) {
        const base = id.startsWith('@/') ? path.join(root, 'src', id.slice(2)) : path.resolve(path.dirname(file), id);
        const found = [base, base + '.ts', base + '.tsx', base + '.js', path.join(base, 'index.ts')].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (!found) throw new Error(`Unresolved fixture import: ${id}`);
        return load(path.relative(root, found));
      }
      return require(id);
    };
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    new Function('require', 'module', 'exports', '__filename', '__dirname', 'fetch', output)(localRequire, module, module.exports,
      file, path.dirname(file), () => { throw new Error('External transport forbidden'); });
    return module.exports;
  }
  return load;
}
const load = loader();
try {
  const schemaEnv = { NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1',
    ...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'].filter(key => process.env[key]).map(key => [key, process.env[key]])) };
  const setup = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')],
    { cwd: fixture, env: schemaEnv, encoding: 'utf8', timeout: 60000 });
  assert.equal(setup.status, 0, `Synthetic schema setup failed: ${(setup.stderr || setup.error?.message || '').slice(0, 3000)}`);
  const emptyBackupDb = path.join(fixture, 'empty-backup.db');
  fs.copyFileSync(path.join(fixture, 'fixture.db'), emptyBackupDb); fs.chmodSync(emptyBackupDb, 0o600);
  const { PrismaClient } = require('@prisma/client');
  db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } }, log: [] });
  for (const id of ['author', 'admin', 'ordinary']) await db.user.create({ data: { id, name: id, username: id, email: `${id}@fixture.invalid`, password_hash: 'not-a-password', role: id === 'admin' ? 'admin' : 'user' } });
  const crypto = load('src/lib/security/private-prompts.server.ts');
  const identity = load('src/lib/security/private-prompt-identity.server.ts');
  const origins = policy.origins.slice(), binding = { kind: 'image-module', id: 'module', field: 'prompt', origins };
  const text = '\uFEFF  synthetic-private\r\n\u4e2d\u6587 e\u0301\n';
  const encrypted = crypto.sealPrivatePrompt(text, binding);
  assert.equal(crypto.openPrivatePrompt(encrypted, binding), text);
  process.env.PRIVATE_PROMPTS_READ_ONLY = '1';
  assert.equal(crypto.openPrivatePrompt(encrypted, binding), text);
  assert.throws(() => crypto.sealPrivatePrompt(text, binding), crypto.PrivatePromptError);
  assert.throws(() => crypto.writePrivatePrompt(text, binding), crypto.PrivatePromptError);
  delete process.env.PRIVATE_PROMPTS_READ_ONLY;
  assert.notEqual(crypto.sealPrivatePrompt(text, binding), encrypted);
  assert.throws(() => crypto.openPrivatePrompt(encrypted, { ...binding, id: 'other' }));
  assert.throws(() => crypto.openPrivatePrompt(encrypted.replace(/"tag":"./, '"tag":"!'), binding));
  const originalIndex = fs.readFileSync(policy.keys.index.files.index);
  write(policy.keys.index.files.index, fs.readFileSync(policy.keys.body.files.body));
  assert.throws(() => crypto.openPrivatePrompt(encrypted, binding)); write(policy.keys.index.files.index, originalIndex);
  checks.push(PRIVATE_PROMPTS_CHECKS[0]);

  const token = 'synthetic-session';
  function principal(id, role = 'user') {
    const user = { id, role }, raw = identity.signVerifiedFeishuIdentity({ userId: id, role, tenant: 'tenant', subject: `${id}-subject` }, token);
    assert.equal(identity.authenticatePrivateIdentity(user, raw, token), true); return { user, raw };
  }
  const author = principal('author'), admin = principal('admin', 'admin');
  assert.equal(identity.privatePromptCapabilities(author.user, origins).canReadPrivatePrompt, true);
  assert.equal(identity.privatePromptCapabilities(admin.user, origins).canReadPrivatePrompt, true);
  for (const user of [{ id: 'ordinary', role: 'user' }, { id: 'admin', role: 'admin' }, { id: 'author', role: 'user', feishu_open_id: 'author-subject' }]) {
    assert.equal(identity.privatePromptCapabilities(user, origins).canReadPrivatePrompt, false);
  }
  assert.equal(identity.authenticatePrivateIdentity({ id: 'ordinary' }, author.raw, token), false);
  assert.equal(identity.authenticatePrivateIdentity({ id: 'author' }, author.raw, 'reset-password-session'), false);
  checks.push(PRIVATE_PROMPTS_CHECKS[1]);

  const send = load('src/lib/security/private-prompt-send.server.ts');
  const destination = { endpoint: 'https://fixture.invalid/generate', provider: 'fixture', credential: 'synthetic-provider-key', model: 'fixture-model' };
  policy.destinations = [{ endpoint: destination.endpoint, provider: destination.provider,
    credentialVersion: send.privateCredentialVersion(destination.provider, destination.credential), models: [destination.model] }]; savePolicy();
  let sent = 0;
  await send.privatePromptFetch(destination, origins, { method: 'POST', body: text }, async (_url, init) => { assert.equal(init.redirect, 'error'); sent++; return new Response('{}'); });
  for (const patch of [{ endpoint: 'https://other.invalid/generate' }, { endpoint: 'http://fixture.invalid/generate' }, { credential: 'other' }, { model: 'other' }]) {
    await assert.rejects(send.privatePromptFetch({ ...destination, ...patch }, origins, {}, async () => { sent++; return new Response('{}'); }));
  }
  assert.equal(sent, 1);
  await assert.rejects(send.privatePromptFetch(destination, origins, {}, async () => new Response(null, { status: 302 })));
  const muskTransport = load('src/lib/integrations/musk.ts');
  const muskSettings = { enabled: true, base_url: 'https://fixture.invalid', api_key: destination.credential, default_model: destination.model };
  policy.destinations.push({ endpoint: 'https://fixture.invalid/v1/chat/completions', provider: 'musk',
    credentialVersion: send.privateCredentialVersion('musk', destination.credential), models: [destination.model] }); savePolicy();
  let ordinarySends = 0;
  const ordinaryRequest = { settings: muskSettings, messages: [{ role: 'user', content: 'ordinary-input' }],
    fetchImpl: async (_url, init) => {
      ordinarySends++; assert.equal(init.redirect, 'error');
      return new Response(JSON.stringify({ choices: [{ message: { content: 'synthetic-output' } }] }));
    } };
  assert.equal((await muskTransport.createMuskChatCompletion(ordinaryRequest)).content, 'synthetic-output');
  await assert.rejects(muskTransport.createMuskChatCompletion({ ...ordinaryRequest,
    settings: { ...muskSettings, base_url: 'https://other.invalid' } }), crypto.PrivatePromptError);
  await assert.rejects(muskTransport.createMuskChatCompletion({ ...ordinaryRequest,
    settings: { ...muskSettings, api_key: 'unapproved-credential' } }), crypto.PrivatePromptError);
  assert.equal(ordinarySends, 1);
  const imageTransport = load('src/lib/image-studio/provider.ts');
  await assert.rejects(imageTransport.requestStudioImages({ baseUrl: 'https://other.invalid', apiKey: destination.credential,
    model: 'gpt-image-2.5-sunburst', provider: 'musk', protocol: 'openai_images', images: [], count: 1, prompt: 'ordinary-input',
    signal: AbortSignal.timeout(10000) }, async () => { ordinarySends++; throw new Error('Unexpected transport'); }), crypto.PrivatePromptError);
  await assert.rejects(send.privateCredentialFetch({ ...destination, endpoint: 'https://other.invalid/generate' }, {},
    async () => { ordinarySends++; return new Response('{}'); }), crypto.PrivatePromptError);
  assert.equal(ordinarySends, 1);
  checks.push(PRIVATE_PROMPTS_CHECKS[2]);

  policy.state = 'encrypted-write'; savePolicy(); actor = author.user;
  const drafts = load('src/lib/security/private-prompt-drafts.server.ts');
  const target = { kind: 'image-module', id: 'module', origins, fields: ['prompt', 'context'] };
  const input = { expectedRevision: 0, sourceRevision: '1', requestId: 'same-original', values: { prompt: text, context: 'synthetic-context' } };
  assert.equal((await drafts.savePrivatePromptDraft('author', target, input)).revision, 1);
  assert.equal((await drafts.savePrivatePromptDraft('author', target, input)).revision, 1);
  assert.equal(await db.platformSetting.count(), 2);
  for (const row of await db.platformSetting.findMany()) { assert.equal(crypto.isStoredPrivatePrompt(row.value_json), true); assert.equal(row.value_json.includes('synthetic-private'), false); }
  await assert.rejects(drafts.savePrivatePromptDraft('author', target, { ...input, values: { ...input.values, prompt: 'changed' } }));
  assert.equal((await drafts.savePrivatePromptDraft('author', target, { ...input, requestId: 'stale-operation' })).state, 'not-applied');
  actor = { id: 'ordinary', role: 'user' }; await assert.rejects(drafts.readPrivatePromptDraft('ordinary', target));
  actor = admin.user; assert.equal(await drafts.readPrivatePromptDraft('admin', target), null);
  checks.push(PRIVATE_PROMPTS_CHECKS[3]);

  const migration = load('src/lib/security/private-prompt-migration.server.ts');
  const imageMigration = load('src/lib/image-studio/private-migration.server.ts');
  const original = await db.imageStudioModule.create({ data: { id: 'module', owner_id: 'author', prompt: text, context: 'context', revision: 9 } });
  const selection = { modules: ['module'], presets: [], tasks: [] };
  const prepared = await imageMigration.prepareImagePrivateMigration(db, selection);
  const plan = migration.preparePrivateMigrationPlan('fixture-inventory', prepared.rows);
  const again = migration.preparePrivateMigrationPlan('fixture-inventory', (await imageMigration.prepareImagePrivateMigration(db, selection)).rows);
  assert.equal(plan.digest, again.digest);
  const authorize = item => ({ inventoryId: item.inventoryId, planDigest: item.digest, restoreId: 'fixture-restore', policyRevision: policy.revision });
  await db.imageStudioModule.update({ where: { id: 'module' }, data: { name: 'concurrent-change' } });
  await assert.rejects(migration.executePrivateMigrationPlan(db, plan, authorize(plan)));
  assert.equal((await db.imageStudioModule.findUniqueOrThrow({ where: { id: 'module' } })).prompt, text);
  const before = await db.imageStudioModule.findUniqueOrThrow({ where: { id: 'module' } });
  const fresh = migration.preparePrivateMigrationPlan('fixture-inventory', (await imageMigration.prepareImagePrivateMigration(db, selection)).rows);
  await migration.executePrivateMigrationPlan(db, fresh, authorize(fresh));
  const after = await db.imageStudioModule.findUniqueOrThrow({ where: { id: 'module' } });
  assert.equal(after.revision, original.revision); assert.equal(after.updated_at.getTime(), before.updated_at.getTime());
  assert.equal(crypto.openPrivatePrompt(after.prompt, binding), text);
  assert.equal((await imageMigration.prepareImagePrivateMigration(db, selection)).rows.length, 0);
  // Exercise the actual Node entrypoint, whose loader must share migration-plan identity.
  const cliOriginal = await db.imageStudioModule.create({ data: { id: 'cli-module', owner_id: 'author', prompt: text, context: 'cli-context' } });
  const cliSelection = path.join(fixture, 'cli-selection.json');
  write(cliSelection, { schema: 'private-prompt-migration-selection.v1', inventoryId: 'fixture-inventory',
    image: { modules: [cliOriginal.id], presets: [], tasks: [] }, video: { templates: [], versions: [], drafts: [], runs: [] },
    settingIds: [], privateVideoTaskIds: [], contextKeys: [] });
  const migrationCli = args => spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'scripts/migrate-private-prompts.ts'), ...args],
    { cwd: root, env: process.env, encoding: 'utf8', timeout: 60000 });
  const cliPrepare = migrationCli(['prepare', 'fields', cliSelection]);
  assert.equal(cliPrepare.status, 0, cliPrepare.stderr);
  const cliPrepared = JSON.parse(cliPrepare.stdout);
  assert.equal(cliPrepared.changedRows, 1); assert.equal(cliPrepared.unclassifiedRows, 0);
  const cliApproval = path.join(fixture, 'cli-approval.json');
  write(cliApproval, { schema: 'private-prompt-migration-approval.v1', phase: 'fields', inventoryId: 'fixture-inventory',
    policyRevision: policy.revision, writerFenceId: 'fixture-fence', restoreId: 'fixture-restore',
    expiresAt: new Date(Date.now() + 60000).toISOString(), digest: cliPrepared.digest });
  const cliApply = migrationCli(['apply', 'fields', cliSelection, cliApproval]);
  assert.equal(cliApply.status, 0, cliApply.stderr);
  const cliAfter = await db.imageStudioModule.findUniqueOrThrow({ where: { id: cliOriginal.id } });
  assert.equal(cliAfter.updated_at.getTime(), cliOriginal.updated_at.getTime());
  assert.equal(crypto.openPrivatePrompt(cliAfter.prompt, { kind: 'image-module', id: cliOriginal.id, field: 'prompt',
    origins: [{ kind: 'image-module', id: cliOriginal.id, ownerId: 'author' }] }), text);
  assert.equal(JSON.parse(migrationCli(['prepare', 'fields', cliSelection]).stdout).changedRows, 0);
  policy.origins.push({ kind: 'image-preset', id: 'receipt-source', ownerId: 'author' }); savePolicy();
  const compatibilityRaw = JSON.stringify({ complete: true, requestId: 'old-request', beforeHash: sha(text),
    presetId: 'receipt-source', before: { module: { id: 'module', owner_id: 'author', source_preset_id: null, prompt: text },
      settings: [{ key: 'gpt_image_studio_v1', value_json: JSON.stringify({ context: text }) }] },
    afterModule: { id: 'module', owner_id: 'author', source_preset_id: 'receipt-source', context: text },
    result: { revision: 7, sourceRevision: 'old-business-revision' } }, null, 2);
  const compatibilityRow = await db.platformSetting.create({ data: { key: 'studio_shared_compat_receipt_v1:fixture', value_json: compatibilityRaw } });
  const settingMigration = load('src/lib/security/private-setting-migration.server.ts');
  const compatibilityPlan = migration.preparePrivateMigrationPlan('fixture-inventory',
    (await settingMigration.preparePrivateSettingMigration(db, [compatibilityRow.id])).rows);
  await migration.executePrivateMigrationPlan(db, compatibilityPlan, authorize(compatibilityPlan));
  const compatibilityStored = (await db.platformSetting.findUniqueOrThrow({ where: { id: compatibilityRow.id } })).value_json;
  assert.equal(compatibilityStored.includes(text.trim()), false);
  const compatibilityReader = load('src/lib/image-studio/private-compat-receipt.server.ts');
  const compatibilityRead = compatibilityReader.readHistoricalStudioCompatibilityReceipt(compatibilityRow.key, compatibilityStored);
  assert.equal(compatibilityRead.raw, compatibilityRaw);
  assert.equal(compatibilityRead.value.beforeHash, sha(text));
  assert.equal(compatibilityRead.value.result.revision, 7);
  assert.equal(identity.privatePromptCapabilities(author.user, compatibilityRead.binding.origins).canReadPrivatePrompt, false);
  assert.equal(identity.privatePromptCapabilities(admin.user, compatibilityRead.binding.origins).canReadPrivatePrompt, true);
  assert.throws(() => compatibilityReader.readHistoricalStudioCompatibilityReceipt(compatibilityRow.key + '-other', compatibilityStored));
  assert.equal((await settingMigration.preparePrivateSettingMigration(db, [compatibilityRow.id])).rows.length, 0);
  assert.throws(() => compatibilityReader.historicalStudioReceiptBinding(compatibilityRow.key,
    compatibilityRaw.replaceAll('receipt-source', 'unknown-source')));
  checks.push(PRIVATE_PROMPTS_CHECKS[4]);

  const { MULTIVIEW_ROTATION_PRESET } = load('src/lib/video/multiview-generation-contract.ts');
  const preset = { ...MULTIVIEW_ROTATION_PRESET, version: '1.0.1', prompt: text,
    compositionReference: { assetId: 'fixture-asset', referenceImageId: 'fixture-reference', ownerId: 'author', sha256: sha('fixture-reference') } };
  const state = { revision: 1, preset };
  const settingRows = [];
  for (const suffix of ['current', 'version:1.0.1']) settingRows.push(await db.platformSetting.create({ data: { key: `multiview_rotation_preset_v1:${suffix}`, value_json: JSON.stringify(state), updated_by: 'admin' } }));
  const mutationId = 'mv-original', receiptId = `multiview-preset-save-${sha(JSON.stringify(['admin', mutationId]))}`;
  await db.operationLog.create({ data: { id: receiptId, operator_id: 'admin', action: 'multiview_rotation_preset_save',
    target_type: 'MultiviewRotationPreset', target_id: MULTIVIEW_ROTATION_PRESET.id,
    detail: JSON.stringify({ requestHash: sha(text), receipt: { state: 'saved', mutationId, ...state } }) } });
  const mv = load('src/lib/video/private-migration.server.ts');
  const mvPlan = migration.preparePrivateMigrationPlan('fixture-inventory', (await mv.prepareMultiviewPrivateMigration(db, { settingIds: settingRows.map(row => row.id), receiptIds: [receiptId] })).rows);
  await migration.executePrivateMigrationPlan(db, mvPlan, authorize(mvPlan));
  const mirrors = await db.platformSetting.findMany({ where: { id: { in: settingRows.map(row => row.id) } } });
  const savedReceipt = JSON.parse((await db.operationLog.findUniqueOrThrow({ where: { id: receiptId } })).detail);
  const storedPrompt = JSON.parse(mirrors[0].value_json).preset.prompt;
  assert.equal(storedPrompt, JSON.parse(mirrors[1].value_json).preset.prompt); assert.equal(storedPrompt, savedReceipt.receipt.preset.prompt);
  assert.equal(crypto.isStoredPrivatePrompt(savedReceipt.requestHash), true);
  assert.equal(crypto.openPrivatePrompt(storedPrompt, crypto.inspectPrivatePrompt(storedPrompt).binding), text);
  const mvReaders = load('src/lib/video/multiview-preset.server.ts');
  assert.equal((await mvReaders.readMultiviewRotationPreset(db)).preset.prompt, text);
  assert.equal((await mvReaders.readMultiviewPresetSaveReceipt('admin', mutationId, db)).receipt.preset.prompt, text);
  checks.push(PRIVATE_PROMPTS_CHECKS[5]);

  const indexMigration = load('src/lib/image-studio/private-context-migration.server.ts');
  const hash = sha('synthetic-context-index'), code = 'AB123';
  await db.platformSetting.create({ data: { key: `studio_context_hash_v1:${hash}`, value_json: JSON.stringify({ code }), updated_by: 'author' } });
  await db.platformSetting.create({ data: { key: `studio_context_code_v1:${code}`, value_json: JSON.stringify({ hash }), updated_by: 'author' } });
  const indexPlan = await indexMigration.preparePrivateContextIndexMigration(db, 'fixture-inventory', [`studio_context_hash_v1:${hash}`]);
  await indexMigration.executePrivateContextIndexMigration(db, indexPlan, { inventoryId: 'fixture-inventory', digest: indexPlan.digest, restoreId: 'fixture-restore' });
  assert.equal(await db.platformSetting.findUnique({ where: { key: `studio_context_hash_v1:${hash}` } }), null);
  assert.equal(JSON.parse((await db.platformSetting.findUniqueOrThrow({ where: { key: indexPlan.pairs[0].newKey } })).value_json).code, code);
  const indexAgain = await indexMigration.preparePrivateContextIndexMigration(db, 'fixture-inventory', [`studio_context_hash_v1:${hash}`]);
  assert.equal(indexAgain.pairs.length, 0); assert.equal(indexAgain.unchangedPairs, 1);
  checks.push(PRIVATE_PROMPTS_CHECKS[6]);

  const backup = load('src/lib/security/private-prompt-backup.server.ts');
  const source = path.join(fixture, 'source'), archive = path.join(fixture, 'archive'), restored = path.join(fixture, 'restored');
  write(source, Buffer.concat([Buffer.from(text), randomBytes(1024 * 1024 + 7)]));
  const proof = { inventoryId: 'fixture-inventory', policyRevision: policy.revision, consumerDigest: sha('fixture'), sourceId: 'fixture-snapshot', dataFormat: 'private-prompt.v1', bodyKeyIds: ['body'], indexKeyIds: ['index'] };
  const sealed = await backup.transformPrivateBackup({ mode: 'seal', source, destination: archive, proof });
  const restoredReceipt = await backup.transformPrivateBackup({ mode: 'restore', source: archive, destination: restored, proof });
  assert.equal(restoredReceipt.sha256, sealed.sha256); assert.deepEqual(fs.readFileSync(restored), fs.readFileSync(source));
  const proofFile = path.join(fixture, 'backup-proof.json'), cliRestored = path.join(fixture, 'cli-restored'); write(proofFile, proof);
  const cliRestore = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'scripts/private-prompt-backup.ts'), 'restore', archive, cliRestored, proofFile],
    { cwd: root, env: process.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(cliRestore.status, 0, 'Actual backup CLI restore failed');
  assert.equal(JSON.parse(cliRestore.stdout).sha256, sealed.sha256); assert.deepEqual(fs.readFileSync(cliRestored), fs.readFileSync(source));
  if (process.platform === 'linux') {
    for (const directory of ['storage/multiview-works', 'storage/multiview-recipes', 'storage/multiview-sources', 'uploads']) {
      fs.mkdirSync(path.join(fixture, 'backup-media', directory), { recursive: true, mode: 0o700 });
    }
    const dailyRoot = path.join(fixture, 'daily-encrypted'); fs.mkdirSync(dailyRoot, { mode: 0o700 });
    const dailyEnv = { ...process.env, DB_PATH: emptyBackupDb, PRIVATE_BACKUP_ROOT: dailyRoot };
    const daily = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'scripts/backup-private-prompts.ts'), proofFile, 'multiview'],
      { cwd: root, env: dailyEnv, encoding: 'utf8', timeout: 120000 });
    assert.equal(daily.status, 0, 'Actual combined daily database and multiview backup job failed');
    const files = fs.readdirSync(dailyRoot); assert.equal(files.length, 1); assert.ok(files[0].endsWith('.ppbackup'));
    const dailyRestore = path.join(fixture, 'daily-restored.tar.gz');
    await backup.transformPrivateBackup({ mode: 'restore', source: path.join(dailyRoot, files[0]), destination: dailyRestore, proof });
    const extracted = path.join(fixture, 'daily-extracted'); fs.mkdirSync(extracted, { mode: 0o700 });
    assert.equal(spawnSync('tar', ['-xzf', dailyRestore, '-C', extracted], { timeout: 30000 }).status, 0);
    const verification = spawnSync('python3', [path.join(root, 'scripts/backup-multiview-works.py'), '--verify-backup', extracted, '--non-production'],
      { encoding: 'utf8', timeout: 30000 });
    assert.equal(verification.status, 0, 'Actual multiview isolated backup verifier rejected authenticated restore');
    const invalidProof = path.join(fixture, 'invalid-backup-proof.json'); write(invalidProof, {});
    const failedDaily = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'scripts/backup-private-prompts.ts'), invalidProof, 'multiview'],
      { cwd: root, env: dailyEnv, encoding: 'utf8', timeout: 120000 });
    assert.notEqual(failedDaily.status, 0); assert.deepEqual(fs.readdirSync(dailyRoot), files);
  }
  const corrupt = path.join(fixture, 'corrupt'), corruptBytes = fs.readFileSync(archive); corruptBytes[corruptBytes.length - 1] ^= 1; write(corrupt, corruptBytes);
  const rejected = path.join(fixture, 'rejected');
  await assert.rejects(backup.transformPrivateBackup({ mode: 'restore', source: corrupt, destination: rejected, proof })); assert.equal(fs.existsSync(rejected), false);
  const backupKey = fs.readFileSync(policy.keys.backup.files.backup); write(policy.keys.backup.files.backup, randomBytes(32));
  await assert.rejects(backup.transformPrivateBackup({ mode: 'restore', source: archive, destination: rejected, proof })); assert.equal(fs.existsSync(rejected), false);
  write(policy.keys.backup.files.backup, backupKey);
  await assert.rejects(backup.transformPrivateBackup({ mode: 'restore', source: archive, destination: restored, proof }));
  assert.deepEqual(fs.readFileSync(restored), fs.readFileSync(source));
  checks.push(PRIVATE_PROMPTS_CHECKS[7]);

  for (const state of crypto.PRIVATE_PROMPT_STATES) {
    policy.state = state; process.env.PRIVATE_PROMPTS_MIN_STATE = state; savePolicy();
    assert.equal(crypto.privatePromptState(), state);
    if (state === 'encrypted-required') assert.throws(() => crypto.readPrivatePrompt(text, binding));
    else assert.equal(crypto.readPrivatePrompt(text, binding), text);
    assert.equal(crypto.openPrivatePrompt(encrypted, binding), text);
  }
  process.env.PRIVATE_PROMPTS_RUNTIME_REVISION = 'b'.repeat(40); assert.throws(() => crypto.privatePromptPolicy());
  process.env.PRIVATE_PROMPTS_RUNTIME_REVISION = 'a'.repeat(40);
  checks.push(PRIVATE_PROMPTS_CHECKS[8]);

  policy.state = 'encrypted-write'; process.env.PRIVATE_PROMPTS_MIN_STATE = 'compatible-read'; savePolicy();
  const taskStorage = load('src/lib/image-studio/private-storage.server.ts');
  const unknownOwnerOrigin = { kind: 'image-module', id: 'known-unbound-owner-module', ownerId: 'unbound-author' };
  policy.origins.push(unknownOwnerOrigin); savePolicy();
  const unboundDefinition = taskStorage.writePrivateStudioDefinition('image-module', {
    id: unknownOwnerOrigin.id, owner_id: unknownOwnerOrigin.ownerId, prompt: text, context: text,
  });
  assert.equal(crypto.isStoredPrivatePrompt(unboundDefinition.context), true);
  assert.equal(identity.privatePromptCapabilities(admin.user, [unknownOwnerOrigin]).canReadPrivatePrompt, true);
  assert.equal(identity.privatePromptCapabilities({ id: 'unbound-author' }, [unknownOwnerOrigin]).canReadPrivatePrompt, false);
  assert.throws(() => taskStorage.writePrivateStudioDefinition('image-module', {
    id: 'uninventoried-module', owner_id: 'unbound-author', prompt: text, context: text,
  }), crypto.PrivatePromptError);
  assert.throws(() => taskStorage.studioDefinitionOrigins('image-module', {
    id: 'copied-module', owner_id: 'author', source_preset_id: 'unknown-original',
  }), crypto.PrivatePromptError);
  policy.origins.push({ kind: 'image-preset', id: 'source-preset', ownerId: 'author' },
    { kind: 'image-module', id: 'copied-module', ownerId: 'author' }); savePolicy();
  assert.deepEqual(taskStorage.studioDefinitionOrigins('image-module', {
    id: 'copied-module', owner_id: 'ordinary', source_preset_id: 'source-preset',
  }), [{ kind: 'image-preset', id: 'source-preset', ownerId: 'author' }]);
  const imageTasks = load('src/lib/image-studio/tasks.ts');
  const taskData = taskStorage.transformPrivateImageTask({ id: 'held-original', batch_id: 'original-batch', owner_id: 'author', module_id: 'module',
    ordinal: 0, fingerprint: 'frozen-business-fingerprint', prompt: text, context: 'synthetic-context', revision: 9,
    model: 'gemini-3.1-flash-image-preview', reference_ids: '[]', unit_credits: 5, status: 'queued', snapshot_json: '{}' }, true);
  await db.imageStudioTask.create({ data: taskData });
  const bodyKey = fs.readFileSync(policy.keys.body.files.body); fs.unlinkSync(policy.keys.body.files.body);
  assert.equal(await imageTasks.claimStudioTask(), null);
  const held = await db.imageStudioTask.findUniqueOrThrow({ where: { id: taskData.id } });
  assert.equal(held.status, 'queued'); assert.equal(held.unit_credits, 5); assert.equal(held.gateway_request_id, null);
  assert.equal(await db.creditLedger.count(), 0);
  write(policy.keys.body.files.body, bodyKey);
  assert.equal((await imageTasks.claimStudioTask()).id, taskData.id);
  const roleFile = path.join(root, 'src/lib/canvas-roles/execution.ts');
  const roleAst = ts.createSourceFile(roleFile, fs.readFileSync(roleFile, 'utf8'), ts.ScriptTarget.Latest, true);
  const roleHoldNode = roleAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'holdRoleAttemptOnPrivateFailure');
  assert.ok(roleHoldNode);
  const roleHoldExports = {};
  new Function('exports', 'isPrivatePromptError', ts.transpileModule(roleHoldNode.getText(roleAst), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(roleHoldExports, crypto.isPrivatePromptError);
  await db.canvasRoleDefinition.create({ data: { id: 'private-role-definition', owner_user_id: 'author', name: 'synthetic' } });
  await db.canvasRoleVersion.create({ data: { id: 'private-role-version', definition_id: 'private-role-definition', version: 1, snapshot_json: '{}' } });
  await db.canvasRoleTaskRun.create({ data: { id: 'private-role-run', owner_user_id: 'author', document_id: 'synthetic-document', max_rounds: 1 } });
  await db.canvasRoleWork.create({ data: { id: 'private-role-work', role_task_run_id: 'private-role-run', requirements_revision: 1,
    node_id: 'synthetic-node', round: 1, role_version_id: 'private-role-version', snapshot_json: '{}' } });
  for (const [index, state] of ['reserved', 'sending', 'succeeded'].entries()) {
    const originalAttempt = await db.canvasRoleAttempt.create({ data: { id: `private-role-attempt-${index}`, work_id: 'private-role-work',
      round: 1, purpose: 'work', attempt: index + 1, request_id: `private-role-request-${index}`, state,
      input_snapshot_json: JSON.stringify({ prompt: 'ordinary-role-input' }), quote_json: '{}', reserved_points: 25,
      reserved_usd_micros: 100, fee_state: 'pending', settlement_applied: state === 'succeeded' } });
    assert.equal(await roleHoldExports.holdRoleAttemptOnPrivateFailure(db, originalAttempt.id, new Error('ordinary')), false);
    assert.equal(await roleHoldExports.holdRoleAttemptOnPrivateFailure(db, originalAttempt.id, new crypto.PrivatePromptError()), true);
    const finalAttempt = await db.canvasRoleAttempt.findUniqueOrThrow({ where: { id: originalAttempt.id } });
    assert.equal(finalAttempt.state, state === 'succeeded' ? 'succeeded' : 'unknown');
    for (const field of ['id', 'request_id', 'input_snapshot_json', 'reserved_points', 'reserved_usd_micros', 'settlement_applied'])
      assert.equal(finalAttempt[field], originalAttempt[field]);
  }
  assert.equal(await db.creditLedger.count(), 0);
  await checkPrivateWorkerFailures({ root, ts, db, crypto, task: taskData });
  checks.push(PRIVATE_PROMPTS_CHECKS[9]);

  const globalOrigins = [crypto.privateOrigin('image-global', 'gpt_image_studio_v1')];
  await db.platformSetting.create({ data: { key: 'gpt_image_studio_v1', value_json: JSON.stringify({ context: crypto.sealPrivatePrompt(text,
    { kind: 'image-global', id: 'gpt_image_studio_v1', field: 'context', origins: globalOrigins }), model: 'gemini-3.1-flash-image-preview', revision: 1, prices: {} }), updated_by: 'admin' } });
  const route = load('src/app/api/image-studio/settings/route.ts');
  const { NextRequest } = require('next/server');
  actor = { id: 'admin', role: 'admin' };
  const denied = await route.GET(new NextRequest('https://fixture.invalid/api/image-studio/settings?mode=private-editor'));
  assert.equal(denied.status, 403);
  actor = admin.user;
  const allowed = await route.GET(new NextRequest('https://fixture.invalid/api/image-studio/settings?mode=private-editor'));
  assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('cache-control'), 'private, no-store');
  assert.equal((await allowed.json()).context, text);
  checks.push(PRIVATE_PROMPTS_CHECKS[10]);

  const local = new Map();
  const priorStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key) };
  try {
    const legacy = load('src/app/image-studio/private-draft-migration.ts');
    local.set('author-module', JSON.stringify({ prompt: 'ordinary-personal-input', context: text,
      authorDefinition: { context: text, templatePrompt: 'old-template', baseFields: { context: 'different-base' } } }));
    local.set('unrelated-account', 'untouched');
    const old = legacy.readLegacyPrivateDraft('author-module');
    const next = legacy.retainLegacyPrivateDraft('author-module', legacy.withoutLegacyPrivateFields({ prompt: 'new-personal-input', context: 'not-yet-saved' }));
    assert.equal(next.context, text); assert.equal(next.prompt, 'new-personal-input');
    assert.equal(legacy.acknowledgeLegacyPrivateDraft(old, { context: text, prompt: 'old-template' }), false);
    assert.equal(legacy.readLegacyPrivateDraft('author-module').context, 'different-base');
    const base = legacy.readLegacyPrivateDraft('author-module');
    assert.equal(legacy.acknowledgeLegacyPrivateDraft(base, { context: 'different-base', prompt: '' }), true);
    assert.equal(JSON.parse(local.get('author-module')).prompt, 'ordinary-personal-input');
    assert.equal(local.get('unrelated-account'), 'untouched');
    local.set('video-draft', JSON.stringify({ draft: { id: 'draft', recipe: { instruction: text } } }));
    const videoLegacy = legacy.readLegacyPrivateDraft('video-draft'); assert.equal(videoLegacy.context, text);
    local.set('video-draft', JSON.stringify({ draft: { id: 'draft', recipe: { instruction: 'concurrent-old-draft' } } }));
    assert.equal(legacy.acknowledgeLegacyPrivateDraft(videoLegacy, { context: text, prompt: '' }), false);
  } finally { if (priorStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = priorStorage; }
  checks.push(PRIVATE_PROMPTS_CHECKS[11]);

  policy.origins.push({ kind: 'video-module-context', id: 'video-draft', ownerId: 'author' }, { kind: 'video-template', id: 'video-template', ownerId: 'author' }); savePolicy();
  const videoStorage = load('src/lib/template-studio/private-storage.server.ts');
  const projection = load('src/lib/template-studio/projection.ts');
  const privateSentence = 'synthetic private rule never public';
  const rawSnapshot = { input: { name: 'ordinary-title', groupName: 'ordinary-group', values: {}, draftPrompt: 'ordinary-personal-input' },
    templateVersion: { templateId: 'video-template', templateSource: 'studio', versionId: 'version', versionNumber: 1, templateName: 'title', sourceRevision: '1' },
    privateContext: { global: privateSentence, module: 'synthetic-module-context', globalRevision: 1, moduleRevision: 1 },
    recipe: { instruction: 'synthetic-template-instruction', fields: [], assetSlots: [], defaultParameters: {} },
    prompt: 'ordinary-personal-input', parameters: {}, assets: [], owner: { userId: 'author', username: 'author', displayName: 'author', avatarUrl: null, accountType: 'internal' } };
  const frozen = videoStorage.transformPrivateVideoRun(rawSnapshot, 'video-run', 'video-draft', true);
  const decoded = videoStorage.transformPrivateVideoRun(frozen, 'video-run', 'video-draft', false);
  assert.equal(projection.containsPrivateContext('synthetic-private-rule-never-public', decoded), true);
  assert.equal(projection.containsPrivateContext('ordinary permitted video description', decoded), false);
  const row = { id: 'video-run', draft_id: 'video-draft', mode: 'llm', snapshot_json: JSON.stringify(frozen), prompt: privateSentence };
  assert.equal(projection.visibleRunPrompt(row), null);
  assert.equal(projection.visibleRunPrompt({ ...row, prompt: 'ordinary permitted video description' }), 'ordinary permitted video description');
  fs.unlinkSync(policy.keys.body.files.body);
  assert.equal(projection.visibleRunPrompt({ ...row, prompt: 'unchecked-output' }), null);
  const publicSnapshot = projection.publicRunSnapshot(frozen);
  assert.equal(publicSnapshot.input.draftPrompt, 'ordinary-personal-input');
  assert.equal(JSON.stringify(publicSnapshot).includes('ppenc:'), false);
  assert.equal(JSON.stringify(publicSnapshot).includes(privateSentence), false);
  write(policy.keys.body.files.body, bodyKey);
  checks.push(PRIVATE_PROMPTS_CHECKS[12]);

  actor = admin.user;
  const editor = load('src/lib/image-studio/private-settings-editor.server.ts');
  const edit = { requestId: 'original-private-save', revision: 1, sourceRevision: '1', prompt: '', context: 'synthetic-new-global' };
  const saved = await editor.savePrivateGlobalEditor('admin', edit);
  assert.equal(saved.state, 'saved'); assert.equal(saved.revision, 2);
  assert.deepEqual(await editor.savePrivateGlobalEditor('admin', edit), saved);
  assert.equal((await editor.privateGlobalEditorStatus('admin', edit.requestId, false)).state, 'saved');
  assert.equal((await editor.savePrivateGlobalEditor('admin', { ...edit, requestId: 'stale-private-save', context: 'stale' })).state, 'not-applied');
  const settingsModule = load('src/lib/image-studio/settings.ts');
  const globalBefore = await db.platformSetting.findUniqueOrThrow({ where: { key: 'gpt_image_studio_v1' } });
  const globalValue = await settingsModule.getImageStudioSettings();
  await settingsModule.saveImageStudioSettings({ ...globalValue, context: '' }, 'admin');
  const globalAfter = await db.platformSetting.findUniqueOrThrow({ where: { key: 'gpt_image_studio_v1' } });
  assert.equal(JSON.parse(globalAfter.value_json).context, JSON.parse(globalBefore.value_json).context);
  checks.push(PRIVATE_PROMPTS_CHECKS[13]);

  const credentials = load('src/lib/security/private-credentials.server.ts');
  const credentialText = 'synthetic-upstream-secret-credential';
  const credentialConfig = { enabled: true, base_url: 'https://fixture.invalid', default_model: 'fixture-model', api_key: credentialText };
  const storedCredentials = credentials.stringifyPrivateCredentials('musk_api_v1', credentialConfig);
  assert.equal(storedCredentials.includes(credentialText), false);
  await db.platformSetting.create({ data: { key: 'musk_api_v1', value_json: storedCredentials, updated_by: 'admin' } });
  const musk = load('src/lib/integrations/musk.ts');
  assert.equal((await musk.getMuskApiSettings()).api_key, credentialText);
  const frozenCredentials = credentials.stringifyPrivateCredentials('image_generation_channel_version_v1:fixture:1', { settings: { api_key: credentialText }, modelApiKeys: { fixture: 'synthetic-model-key' } });
  assert.equal(credentials.parsePrivateCredentials('image_generation_channel_version_v1:fixture:1', frozenCredentials).modelApiKeys.fixture, 'synthetic-model-key');
  assert.throws(() => credentials.parsePrivateCredentials('image_generation_channel_version_v1:other:1', frozenCredentials));
  fs.unlinkSync(policy.keys.body.files.body); await assert.rejects(musk.getMuskApiSettings()); write(policy.keys.body.files.body, bodyKey);
  checks.push(PRIVATE_PROMPTS_CHECKS[14]);

  const nextBody = path.join(fixture, 'body-next.key'); write(nextBody, randomBytes(32));
  policy.keys.body.files['body-next'] = nextBody; policy.keys.body.active = 'body-next'; savePolicy();
  let rotation = migration.preparePrivateMigrationPlan('fixture-inventory', (await mv.prepareMultiviewPrivateMigration(db,
    { settingIds: settingRows.map(row => row.id), receiptIds: [receiptId] }, { rotateBodyKey: true })).rows);
  const mirrorBefore = await db.platformSetting.findUniqueOrThrow({ where: { id: settingRows[0].id } });
  const receiptBeforeRotation = await db.operationLog.findUniqueOrThrow({ where: { id: receiptId } });
  await db.platformSetting.update({ where: { id: settingRows[1].id }, data: { updated_at: new Date(Date.now() + 1000) } });
  await assert.rejects(migration.executePrivateMigrationPlan(db, rotation, authorize(rotation)));
  assert.equal((await db.platformSetting.findUniqueOrThrow({ where: { id: settingRows[0].id } })).value_json, mirrorBefore.value_json);
  assert.equal((await db.operationLog.findUniqueOrThrow({ where: { id: receiptId } })).detail, receiptBeforeRotation.detail);
  rotation = migration.preparePrivateMigrationPlan('fixture-inventory', (await mv.prepareMultiviewPrivateMigration(db,
    { settingIds: settingRows.map(row => row.id), receiptIds: [receiptId] }, { rotateBodyKey: true })).rows);
  await migration.executePrivateMigrationPlan(db, rotation, authorize(rotation));
  const rotatedMirrors = await db.platformSetting.findMany({ where: { id: { in: settingRows.map(row => row.id) } } });
  const rotatedPrompt = JSON.parse(rotatedMirrors[0].value_json).preset.prompt;
  assert.equal(crypto.inspectPrivatePrompt(rotatedPrompt).keyId, 'body-next');
  assert.equal(rotatedPrompt, JSON.parse(rotatedMirrors[1].value_json).preset.prompt);
  assert.equal(rotatedPrompt, JSON.parse((await db.operationLog.findUniqueOrThrow({ where: { id: receiptId } })).detail).receipt.preset.prompt);
  assert.equal((await mvReaders.readMultiviewRotationPreset(db)).preset.prompt, text);
  assert.equal(crypto.openPrivatePrompt(encrypted, binding), text);
  checks.push(PRIVATE_PROMPTS_CHECKS[15]);

  const sqliteCopy = path.join(fixture, 'isolated.sqlite3');
  const sqliteResult = spawnSync('sqlite3', [path.join(fixture, 'fixture.db'), `.backup '${sqliteCopy}'`], { encoding: 'utf8', timeout: 30000 });
  assert.equal(sqliteResult.status, 0, 'Synthetic SQLite backup failed');
  // This maintenance is restricted to the synthetic isolated copy, never the source application database.
  assert.equal(spawnSync('sqlite3', [sqliteCopy, 'VACUUM; PRAGMA integrity_check;'], { encoding: 'utf8', timeout: 30000 }).stdout.trim(), 'ok');
  assert.equal(fs.readFileSync(sqliteCopy).includes(Buffer.from('synthetic-private')), false);
  assert.equal(fs.readFileSync(sqliteCopy).includes(Buffer.from(credentialText)), false);
  const databaseArchive = path.join(fixture, 'database.ppbackup'), databaseRestore = path.join(fixture, 'restored.sqlite3');
  const databaseProof = { ...proof, bodyKeyIds: ['body', 'body-next'], sourceId: 'isolated-sqlite' };
  await backup.transformPrivateBackup({ mode: 'seal', source: sqliteCopy, destination: databaseArchive, proof: databaseProof });
  const originalRings = structuredClone(policy.keys), recoveredKeys = path.join(fixture, 'recovered-keys'); fs.mkdirSync(recoveredKeys, { mode: 0o700 });
  for (const domain of ['body', 'index', 'backup']) for (const [id, file] of Object.entries(originalRings[domain].files)) {
    const replacement = path.join(recoveredKeys, `${domain}-${id}.key`); write(replacement, fs.readFileSync(file));
    fs.renameSync(file, file + '.unavailable'); policy.keys[domain].files[id] = replacement;
  }
  savePolicy();
  await backup.transformPrivateBackup({ mode: 'restore', source: databaseArchive, destination: databaseRestore, proof: databaseProof });
  assert.equal(sha(fs.readFileSync(sqliteCopy)), sha(fs.readFileSync(databaseRestore)));
  const restoredDb = new PrismaClient({ datasources: { db: { url: `file:${databaseRestore}` } }, log: [] });
  try { assert.equal(crypto.openPrivatePrompt((await restoredDb.imageStudioModule.findUniqueOrThrow({ where: { id: 'module' } })).prompt, binding), text); }
  finally { await restoredDb.$disconnect(); }
  for (const domain of ['body', 'index', 'backup']) for (const file of Object.values(originalRings[domain].files)) fs.renameSync(file + '.unavailable', file);
  policy.keys = originalRings; savePolicy();
  checks.push(PRIVATE_PROMPTS_CHECKS[16]);

  const killed = [];
  function mutate(file, search, replacement) {
    return loader({ [file]: source => { assert.equal(source.split(search).length, 2, 'Mutation anchor must be unique'); return source.replace(search, replacement); } });
  }
  const badIdentity = mutate('src/lib/security/private-prompt-identity.server.ts', 'canReadPrivatePrompt: valid', "canReadPrivatePrompt: valid || user.role === 'admin'")('src/lib/security/private-prompt-identity.server.ts');
  assert.throws(() => assert.equal(badIdentity.privatePromptCapabilities({ id: 'admin', role: 'admin' }, origins).canReadPrivatePrompt, false)); killed.push('identity');
  const badSend = mutate('src/lib/security/private-prompt-send.server.ts', 'if (!approved) throw new PrivatePromptError();', 'if (false && !approved) throw new PrivatePromptError();')('src/lib/security/private-prompt-send.server.ts');
  assert.throws(() => assert.throws(() => badSend.assertPrivateSend({ ...destination, endpoint: 'https://other.invalid/generate' }, origins))); killed.push('destination');
  actor = author.user;
  const badLoad = mutate('src/lib/security/private-prompt-drafts.server.ts',
    'value_json: sealPrivatePrompt(JSON.stringify({ version: 1, fingerprint, draft } satisfies Saved), receiptBinding)',
    'value_json: JSON.stringify({ version: 1, fingerprint, draft } satisfies Saved)');
  // Authenticate in the same module graph as the mutated draft writer.
  const badAuth = badLoad('src/lib/security/private-prompt-identity.server.ts');
  badAuth.authenticatePrivateIdentity(actor, author.raw, token);
  await badLoad('src/lib/security/private-prompt-drafts.server.ts').savePrivatePromptDraft('author', target,
    { ...input, expectedRevision: 1, requestId: 'mutation-receipt' });
  const mutatedReceipts = await db.platformSetting.findMany({ where: { key: { startsWith: 'private_prompt_draft_receipt_v1:' } } });
  assert.throws(() => assert.equal(mutatedReceipts.every(row => crypto.isStoredPrivatePrompt(row.value_json)), true)); killed.push('receipt');
  policy.state = 'encrypted-required'; savePolicy();
  const badFormat = mutate('src/lib/security/private-prompts.server.ts', "if (privatePromptState() === 'encrypted-required') return fail();", "if (false && privatePromptState() === 'encrypted-required') return fail();")('src/lib/security/private-prompts.server.ts');
  assert.throws(() => assert.throws(() => badFormat.readPrivatePrompt(text, binding))); killed.push('format');
  assert.equal(killed.length, 4); checks.push(PRIVATE_PROMPTS_CHECKS[17]);
  assert.deepEqual(checks, PRIVATE_PROMPTS_CHECKS);
  const directory = path.join(root, '.role-tests'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const receiptFile = path.join(directory, `private-prompts-${randomUUID()}.json`);
  const sourceSha256 = Object.fromEntries(PRIVATE_PROMPTS_SOURCES.map(file => [file, sha(fs.readFileSync(path.join(root, file)))]));
  write(receiptFile, { schema: 'private-prompts-engineering.v1', synthetic: true, completed: true,
    runId: process.env.IMAGE_RECOVERY_GATE_RUN_ID || `private-prompts-${randomUUID()}`, startedAt, finishedAt: new Date().toISOString(),
    forbiddenCalls: 0, productionWrites: 0, paidRequests: 0, browserRuns: 0, checks, mutationsKilled: killed,
    fixtureSha256: sourceSha256['scripts/private-prompts-engineering.mjs'], sourceSha256 });
  process.stdout.write(`Private prompts engineering receipt: ${receiptFile}\n`);
} finally {
  await db?.$disconnect();
  fs.rmSync(fixture, { recursive: true, force: true });
}
