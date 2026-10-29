import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Synthetic database and keys only. This never reads production credentials or sends a request.
const root = fs.realpathSync(process.cwd()), require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'video-prompt-groups-')));
fs.chmodSync(fixture, 0o700);
const write = (file, value) => fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 });
Object.assign(process.env, { NODE_ENV: 'test', PRIVATE_PROMPTS_FIXTURE_ROOT: fixture, PRIVATE_PROMPTS_POLICY_FILE: path.join(fixture, 'policy.json'),
  PRIVATE_PROMPTS_MIN_STATE: 'compatible-read', PRIVATE_PROMPTS_CONSUMER_ID: 'fixture', PRIVATE_PROMPTS_RUNTIME_REVISION: 'a'.repeat(40),
  SESSION_SECRET: randomBytes(48).toString('hex'), DATABASE_URL: `file:${fixture}/fixture.db` });
const policy = { schema: 'private-prompt-policy.v1', revision: 'fixture-policy', state: 'compatible-read', minimumReader: 1,
  identities: [{ userId: 'author', tenant: 'tenant', subject: 'author-subject' }, { userId: 'admin', tenant: 'tenant', subject: 'admin-subject', administrator: true }],
  origins: [], authorKinds: [{ ownerId: 'author', kinds: ['skill'] }], destinations: [], consumers: ['fixture'],
  keys: Object.fromEntries(['body', 'index', 'backup'].map(domain => { const file = path.join(fixture, `${domain}.key`); write(file, randomBytes(32)); return [domain, { active: domain, files: { [domain]: file } }]; })),
  activation: { inventoryId: 'fixture-inventory', restoreId: 'fixture-restore', writerFenceId: 'fixture-fence', attestationFile: path.join(fixture, 'consumers.json') },
  migrationVerified: { inventoryId: 'fixture-inventory', restoreId: 'fixture-restore', remainingPlaintext: 0 } };
write(process.env.PRIVATE_PROMPTS_POLICY_FILE, policy);
write(policy.activation.attestationFile, { schema: 'private-prompt-consumers.v1', policyRevision: policy.revision,
  ...Object.fromEntries(['inventoryId', 'restoreId', 'writerFenceId'].map(key => [key, policy.activation[key]])),
  consumers: [{ id: 'fixture', reader: 1, permissionContract: 1, sourceRevision: 'a'.repeat(40) }] });
let db, actor;
const cache = new Map();
function load(relative) {
  const file = path.resolve(root, relative);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const localRequire = id => {
    if (id === 'server-only') return {};
    if (id === '@/lib/prisma') return { prisma: db };
    if (id === '@/lib/auth/session') return { getSession: async () => actor, AuthError: class extends Error {} };
    if (id.startsWith('@/') || id.startsWith('.')) {
      const base = id.startsWith('@/') ? path.join(root, 'src', id.slice(2)) : path.resolve(path.dirname(file), id);
      const found = [base, base + '.ts', base + '.tsx', base + '.js', path.join(base, 'index.ts')].find(value => fs.existsSync(value) && fs.statSync(value).isFile());
      if (!found) throw new Error(`Unresolved fixture import: ${id}`);
      return load(path.relative(root, found));
    }
    return require(id);
  };
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function('require', 'module', 'exports', '__filename', '__dirname', 'fetch', output)(localRequire, module, module.exports, file, path.dirname(file), () => { throw new Error('External transport forbidden'); });
  return module.exports;
}
const checks = [];
try {
  const env = { NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1',
    ...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'].filter(key => process.env[key]).map(key => [key, process.env[key]])) };
  const setup = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')],
    { cwd: fixture, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(setup.status, 0, (setup.stderr || setup.error?.message || 'Synthetic schema setup failed').slice(0, 2000));
  const { PrismaClient } = require('@prisma/client'); db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } }, log: [] });
  for (const id of ['author', 'admin', 'ordinary']) await db.user.create({ data: { id, name: id, username: id, email: `${id}@fixture.invalid`, password_hash: 'synthetic', role: id === 'admin' ? 'admin' : 'user' } });
  const identities = load('src/lib/security/private-prompt-identity.server.ts');
  function user(id, role = 'user', signed = false) {
    const value = { id, role, name: id, username: id, status: 'active', account_type: 'internal',
      feishu: { user_id: id, open_id: id, tenant_key: 'tenant' } };
    if (signed) {
      const proof = identities.signVerifiedFeishuIdentity({ userId: id, role, tenant: 'tenant', subject: `${id}-subject` }, 'synthetic-session');
      assert.equal(identities.authenticatePrivateIdentity(value, proof, 'synthetic-session'), true);
    }
    return value;
  }
  const author = user('author', 'user', true), admin = user('admin', 'admin', true), ordinary = user('ordinary'); actor = author;
  const groups = load('src/lib/video/prompt-groups.server.ts'), contract = load('src/lib/video/prompt-groups.ts');
  if (process.argv.includes('--reader-only')) {
    assert.equal(load('src/lib/video/prompt-groups-build-mode.ts').VIDEO_PROMPT_GROUP_WRITES_ENABLED, false);
    const groupId = randomUUID(), versionId = randomUUID(), body = 'synthetic-historical-secret';
    const crypto = load('src/lib/security/private-prompts.server.ts');
    const origins = [{ kind: 'skill', id: `video-group:${groupId}`, ownerId: author.id }];
    await db.platformSetting.create({ data: { key: `video_prompt_group_v1:${groupId}`, value_json: JSON.stringify({ schema: 1,
      id: groupId, ownerId: author.id, versionId, revision: 1, shared: true, disabled: false }) } });
    await db.platformSetting.create({ data: { key: `video_prompt_group_version_v1:${groupId}:${versionId}`, value_json: JSON.stringify({ schema: 1,
      groupId, versionId, name: 'Historical', description: '', conditions: '', coverAssetId: null, operatorId: author.id,
      createdAt: new Date().toISOString(), body: crypto.sealPrivatePrompt(body, { kind: 'video-prompt-group-version',
        id: `${groupId}:${versionId}`, field: 'body', origins }) }) } });
    const ref = { groupId, versionId };
    assert.equal((await groups.resolveVideoPromptGroups(ordinary, [ref], 'personal')).prompt.includes(body), true);
    assert.equal(JSON.stringify(await groups.videoPromptGroupSelections(ordinary, [ref])).includes(body), false);
    assert.equal((await groups.readVideoPromptGroupEditor(author, ref)).body, body);
    assert.throws(() => contract.assertVideoPromptGroupSurface({ video_prompt_groups: [ref], video_prompt_groups_contract: 1,
      creation_contract_version: 2, entry: 'ordinary' }));
    await assert.rejects(groups.saveVideoPromptGroup(author, {}));
    await assert.rejects(groups.videoPromptGroupDraft(author, groupId, {}));
    assert.equal(groups.videoPromptGroupCreateCapability(author), false);
    assert.deepEqual(await groups.resolveVideoPromptGroups(ordinary, [], 'legacy'), { refs: [], prompt: 'legacy', origins: [], fingerprint: '' });
    assert.equal(contract.containsVideoPromptGroupDraft({ videoPromptGroups: [ref] }), true);
    assert.equal(contract.containsVideoPromptGroupDraft(JSON.stringify({ videoPromptGroups: [ref] })), true);
    assert.equal(contract.containsVideoPromptGroupDraft({ videoPromptGroups: null }), true);
    assert.equal(contract.containsVideoPromptGroupDraft('{"videoPromptGroups":'), true);
    assert.equal(contract.containsVideoPromptGroupDraft({ videoPromptGroups: [] }), false);
    assert.equal(contract.containsVideoPromptGroupDraft({ prompt: 'legacy' }), false);
    const privacy = load('src/lib/video/multiview-task-privacy.ts');
    const task = { id: 'history', prompt: 'personal', local_status: 'succeeded', source_metadata_json: JSON.stringify({ video_prompt_groups: { schema: 1, refs: [ref] } }),
      final_prompt_snapshot: body, raw_status_response: body, public_video_url: 'https://fixture.invalid/output.mp4' };
    assert.equal(JSON.stringify(privacy.projectPrivateMultiviewTask(task)).includes(body), false);
    assert.equal(privacy.projectPrivateMultiviewTask(task).public_video_url, task.public_video_url);
    console.log(JSON.stringify({ passed: true, readerOnly: true, checks: ['immutable history readable', 'ordinary metadata excludes body',
      'signed editor history readable', 'new execution/definition/draft blocked', 'legacy empty path preserved', 'historical task/media projection protected',
      'grouped or malformed browser draft/backup must remain read-only on the legacy composer'],
      fixture, productionDatabaseAccess: 0, externalRequests: 0 }, null, 2));
    await db.$disconnect();
    process.exit(0);
  }
  const groupId = randomUUID(), body = 'synthetic-secret-one', base = { groupId, revision: 0, requestId: randomUUID(), name: 'Camera', description: 'Camera movement', conditions: '', body, coverAssetId: null, shared: false, disabled: false };
  const created = await groups.saveVideoPromptGroup(author, base), ref = { groupId, versionId: created.versionId };
  assert.equal(created.state, 'saved');
  assert.equal((await groups.saveVideoPromptGroup(author, base)).versionId, ref.versionId);
  assert.equal((await db.platformSetting.findMany()).filter(row => row.value_json.includes(body)).length, 0);
  assert.equal((await groups.videoPromptGroupSaveStatus(author, base.requestId)).state, 'saved');
  checks.push('encrypted immutable definition and original save receipt');
  assert.equal((await groups.listVideoPromptGroups(ordinary, {})).groups.length, 0);
  assert.equal((await groups.listVideoPromptGroups(admin, {})).groups.length, 1);
  await assert.rejects(groups.resolveVideoPromptGroups(ordinary, [ref], 'mine'));
  const dto = await groups.videoPromptGroupSummary(author, ref);
  assert.equal(JSON.stringify(dto).includes(body), false); assert.equal('body' in dto, false); assert.equal(dto.author.id, author.id);
  await assert.rejects(groups.readVideoPromptGroupEditor(user('author'), ref));
  checks.push('private default and signed editor authority');
  const shared = await groups.saveVideoPromptGroup(author, { ...base, requestId: randomUUID(), revision: 1, shared: true });
  const sharedRef = { groupId, versionId: shared.versionId };
  assert.equal((await groups.listVideoPromptGroups(ordinary, {})).groups.length, 1);
  assert.equal((await groups.listVideoPromptGroups(ordinary, { query: body })).groups.length, 0);
  assert.equal((await groups.resolveVideoPromptGroups(ordinary, [ref], 'personal')).prompt.includes(body), true);
  await assert.rejects(groups.readVideoPromptGroupEditor(ordinary, sharedRef));
  await assert.rejects(groups.saveVideoPromptGroup(user('admin', 'admin'), { ...base, revision: 2, requestId: randomUUID() }));
  const adminResult = await groups.saveVideoPromptGroup(admin, { ...base, body: 'synthetic-secret-two', shared: true, revision: 2, requestId: randomUUID() });
  assert.equal((await groups.videoPromptGroupSummary(ordinary, { groupId, versionId: adminResult.versionId })).ownerId, author.id);
  assert.equal((await groups.resolveVideoPromptGroups(ordinary, [ref], 'personal')).prompt.includes('synthetic-secret-two'), false);
  checks.push('shared execution without body read, author preserved, exact old version');
  const conflict = await groups.saveVideoPromptGroup(author, { ...base, revision: 1, requestId: randomUUID() });
  assert.equal(conflict.state, 'conflict');
  const savedDraft = await groups.videoPromptGroupDraft(author, groupId, { expectedRevision: 0, sourceRevision: '3', requestId: randomUUID(), values: { body: 'synthetic-draft', metadata: '{}' } });
  assert.equal(savedDraft.revision, 1); assert.equal((await groups.videoPromptGroupDraft(author, groupId)).values.body, 'synthetic-draft');
  const current = await groups.readVideoPromptGroupEditor(author, sharedRef, true);
  assert.equal(current.body, 'synthetic-secret-two');
  checks.push('CAS conflict, encrypted editor draft and current-version lookup');
  const secondId = randomUUID();
  const second = await groups.saveVideoPromptGroup(author, { ...base, groupId: secondId, revision: 0, shared: true, requestId: randomUUID() });
  const secondRef = { groupId: secondId, versionId: second.versionId };
  const project = await db.project.create({ data: { name: 'Synthetic project', owner_user_id: ordinary.id, created_by: ordinary.id } });
  const pricing = load('src/lib/pricing/video-context.ts');
  const quoteInput = { project_id: project.id, provider: 'seedance', model: 'seedance-2.5', resolution: '480p', duration: 5,
    creation_contract_version: 2, entry: 'ordinary', video_prompt_groups_contract: 1, video_prompt_groups: [ref, secondRef], prompt: 'personal' };
  const context = await pricing.resolveVideoPricingContext(ordinary, quoteInput);
  const credential = pricing.issueVideoPricingCredential(context, 'synthetic-price', 3);
  pricing.verifyVideoPricingCredential(credential, context, 'synthetic-price', 3);
  for (const delta of [{ prompt: 'changed' }, { video_prompt_groups: [secondRef, ref] }, { video_prompt_groups: [sharedRef, secondRef] },
    { reference_audio_urls: ['https://fixture.invalid/input.wav'] }, { generate_audio: false }]) {
    const changed = await pricing.resolveVideoPricingContext(ordinary, { ...quoteInput, ...delta });
    assert.throws(() => pricing.verifyVideoPricingCredential(credential, changed, 'synthetic-price', 3));
  }
  await db.$transaction(async tx => {
    await tx.platformSetting.create({ data: { key: 'synthetic-write-lock', value_json: '{}' } });
    const inTransaction = await pricing.resolveVideoPricingContext(ordinary, quoteInput, 'create', tx);
    assert.equal(inTransaction.fingerprint, context.fingerprint);
  }, { timeout: 10000 });
  checks.push('quote binds personal/order/version/media/parameters and rechecks within the same write transaction');
  const disabled = await groups.saveVideoPromptGroup(author, { ...base, body: current.body, revision: 3, shared: true, disabled: true, requestId: randomUUID() });
  await assert.rejects(groups.resolveVideoPromptGroups(ordinary, [ref], 'personal'));
  assert.equal((await groups.videoPromptGroupSelections(ordinary, [ref]))[0].unavailable, true);
  await groups.saveVideoPromptGroup(author, { ...base, body: current.body, revision: disabled.revision, shared: false, requestId: randomUUID() });
  assert.equal((await groups.videoPromptGroupSelections(ordinary, [ref]))[0].name, '提示词组不可用');
  checks.push('disable/revoke blocks new acceptance and hides unauthorized metadata');
  assert.deepEqual(await groups.resolveVideoPromptGroups(ordinary, [], 'legacy'), { refs: [], prompt: 'legacy', origins: [], fingerprint: '' });
  assert.equal(contract.composeVideoPromptGroups('mine', ['a', 'b']).endsWith('mine'), true);
  for (const entry of ['canvas', 'ip', 'template', 'multiview']) assert.throws(() => contract.assertVideoPromptGroupSurface({ entry, creation_contract_version: 2, video_prompt_groups_contract: 1, video_prompt_groups: [ref] }));
  assert.throws(() => contract.parseVideoPromptGroupRefs([ref, ref]));
  checks.push('legacy empty path and unsupported-surface rejection');
  const privacy = load('src/lib/video/multiview-task-privacy.ts');
  const task = { id: 'synthetic-task', prompt: 'personal', local_status: 'submitted', source_metadata_json: JSON.stringify({ video_prompt_groups: { schema: 1, refs: [ref] } }),
    final_prompt_snapshot: body, raw_create_response: body, raw_status_response: body, error_message: body,
    params_json: JSON.stringify({ prompt: body, model: 'model' }), public_video_url: 'https://fixture.invalid/output.mp4', unknown: body };
  const projected = privacy.projectPrivateMultiviewTask(task);
  assert.equal(JSON.stringify(projected).includes(body), false); assert.equal(projected.prompt, 'personal'); assert.deepEqual(projected.video_prompt_groups, [ref]);
  assert.equal(projected.public_video_url, task.public_video_url);
  assert.equal(privacy.projectPrivateMultiviewTask({ ...task, source_metadata_json: null }).unknown, body);
  const protectedTask = load('src/lib/video/prompt-group-execution.server.ts').protectVideoPromptGroupTask({ id: task.id, prompt: 'personal', final_prompt_snapshot: body },
    [{ kind: 'skill', id: `video-group:${groupId}`, ownerId: author.id }]);
  assert.equal(protectedTask.prompt, 'personal'); assert.equal(protectedTask.final_prompt_snapshot.startsWith('ppenc:'), true);
  checks.push('positive task projection and encrypted execution snapshot, legacy untouched');
  const statusRouter = load('src/lib/provider/video-task-status.ts');
  const status = await statusRouter.getProviderTaskStatus({ ...task, provider: 'seedance', provider_task_id: 'synthetic-upstream' }, {
    fetchers: { seedance: async () => ({ provider_status: 'succeeded', local_status: 'succeeded', actual_cost: 1.2,
      currency_or_credit_type: 'CNY', billing_status: 'paid', usage: { completion_tokens: 42, echoed_prompt: body }, raw: { prompt: body } }) } });
  assert.equal(status.actual_cost, 1.2); assert.equal(status.usage.completion_tokens, 42);
  assert.equal(JSON.stringify(status).includes(body), false);
  checks.push('supplier diagnostics exclude internal text while retaining real billing facts');
  const partial = await statusRouter.getProviderTaskStatus({ provider: 'seedance', provider_task_id: 'synthetic-upstream' }, {
    fetchers: { seedance: async () => ({ provider_status: 'succeeded', local_status: 'succeeded', actual_cost: 1.2,
      currency_or_credit_type: 'CNY', usage: { completion_tokens: 42, echoed_prompt: body }, raw: { prompt: body } }) } });
  assert.equal(JSON.stringify(partial).includes(body), false); assert.equal(partial.actual_cost, 1.2);
  checks.push('legacy partial cache refresh cannot persist an unclassified supplier recipe');
  const h3 = load('src/lib/provider/h3.ts');
  let h3Calls = 0;
  await assert.rejects(h3.createH3VideoJob({ preset_id: 'lightx2v_4step_turbo', prompt: body,
    aspect_ratio: '16:9', duration_sec: 5, seed: 1 }, { baseUrl: 'https://h3.fixture.invalid', apiToken: 'synthetic',
    privateOrigins: [{ kind: 'skill', id: `video-group:${groupId}`, ownerId: author.id }],
    fetchImpl: async () => { h3Calls++; throw new Error('Transport must not run'); } }));
  assert.equal(h3Calls, 0);
  checks.push('unapproved H3 private destination rejects before any transport');
  const route = load('src/app/api/video/prompt-groups/route.ts'); actor = ordinary;
  const response = await route.GET(new Request('https://fixture.invalid/api/video/prompt-groups'));
  assert.equal(JSON.stringify(await response.json()).includes(body), false);
  const rejected = await route.POST(new Request('https://fixture.invalid/api/video/prompt-groups', { method: 'POST', headers: { host: 'fixture.invalid', origin: 'https://other.invalid' }, body: JSON.stringify(base) }));
  assert.equal(rejected.status, 403);
  checks.push('ordinary HTTP DTO and cross-origin write rejection');
  console.log(JSON.stringify({ passed: true, checks, fixture, externalRequests: 0, productionDatabaseAccess: 0, browserTests: 0, paidGenerations: 0 }, null, 2));
} finally { await db?.$disconnect(); }
