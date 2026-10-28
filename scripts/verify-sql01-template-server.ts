import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mock } from 'node:test';

async function main() {
  assert.equal(process.env.AUD_SQL01_SYNTHETIC_SERVER, '1');
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.platform, 'linux');
  const root = fs.realpathSync(process.cwd());
  // Key fixtures must stay outside the app even when the runner's TMPDIR does not.
  const directory = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'sd2-sql01-template-'));
  fs.chmodSync(directory, 0o700);
  const require = createRequire(path.join(root, 'scripts/verify-sql01-template-server.ts'));
  const write = (file: string, value: unknown) => fs.writeFileSync(file, Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 });
  Object.assign(process.env, { DATABASE_URL: `file:${directory}/synthetic.db`, SD2_DATABASE_MODE: 'writer',
    SESSION_SECRET: randomBytes(48).toString('hex'), PRIVATE_PROMPTS_FIXTURE_ROOT: directory,
    PRIVATE_PROMPTS_POLICY_FILE: path.join(directory, 'policy.json'), PRIVATE_PROMPTS_MIN_STATE: 'encrypted-write',
    PRIVATE_PROMPTS_CONSUMER_ID: 'fixture', PRIVATE_PROMPTS_RUNTIME_REVISION: 'a'.repeat(40),
    SELF_REGISTRATION_ENABLED: 'false', FEISHU_FEEDBACK_ENABLED: 'false', FEISHU_ALLOWED_TENANT_KEY: 'synthetic' });
  delete process.env.PRIVATE_PROMPTS_READ_ONLY;
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
  const presetId = randomUUID(), moduleId = randomUUID();
  const policy = { schema: 'private-prompt-policy.v1', revision: 'sql01', state: 'encrypted-write', minimumReader: 1,
    identities: [{ userId: 'author', tenant: 'synthetic', subject: 'author-subject' },
      { userId: 'admin', tenant: 'synthetic', subject: 'admin-subject', administrator: true }],
    origins: [{ kind: 'image-preset', id: presetId, ownerId: 'author' }],
    authorKinds: [{ ownerId: 'author', kinds: ['image-preset', 'image-module', 'skill'] }],
    keys: Object.fromEntries(['body', 'index', 'backup'].map(domain => {
      const file = path.join(directory, domain + '.key'); write(file, randomBytes(32));
      return [domain, { active: domain, files: { [domain]: file } }];
    })), destinations: [], consumers: ['fixture'],
    activation: { inventoryId: 'synthetic', restoreId: 'synthetic', writerFenceId: 'synthetic', attestationFile: path.join(directory, 'consumers.json') },
    migrationVerified: { inventoryId: 'synthetic', restoreId: 'synthetic', remainingPlaintext: 0 } };
  write(process.env.PRIVATE_PROMPTS_POLICY_FILE!, policy);
  write(policy.activation.attestationFile, { schema: 'private-prompt-consumers.v1', policyRevision: policy.revision,
    inventoryId: 'synthetic', restoreId: 'synthetic', writerFenceId: 'synthetic',
    consumers: [{ id: 'fixture', reader: 1, permissionContract: 1, sourceRevision: 'a'.repeat(40) }] });
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (file: string) => { close(): void } };
  new DatabaseSync(path.join(directory, 'synthetic.db')).close();
  const setup = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')],
    { cwd: directory, env: { ...process.env, NODE_OPTIONS: '', PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' }, encoding: 'utf8', timeout: 120000 });
  assert.equal(setup.status, 0, (setup.stderr || setup.error?.message || '').slice(0, 1500));
  require(path.join(root, 'scripts/server-runtime.cjs'));
  const { prisma } = require('../src/lib/prisma') as typeof import('../src/lib/prisma');
  const auth = require('../src/lib/auth/session') as typeof import('../src/lib/auth/session');
  const store = require('../src/lib/auth/session-store') as typeof import('../src/lib/auth/session-store');
  const identity = require('../src/lib/security/private-prompt-identity.server') as typeof import('../src/lib/security/private-prompt-identity.server');
  const privateRequest = require('../src/lib/security/private-prompt-request.server') as typeof import('../src/lib/security/private-prompt-request.server');
  const { privatePromptCapabilities } = identity;
  const shared = require('../src/lib/image-studio/shared-contract') as typeof import('../src/lib/image-studio/shared-contract');
  const privateStorage = require('../src/lib/image-studio/private-storage.server') as typeof import('../src/lib/image-studio/private-storage.server');
  const { readSharedStudioSnapshot } = require('../src/lib/image-studio/read-snapshot') as typeof import('../src/lib/image-studio/read-snapshot');
  const { requestAsyncStorage } = require('./fixtures/next-request-context') as typeof import('./fixtures/next-request-context');
  const { NextRequest } = require('next/server') as typeof import('next/server');
  const { GET } = require('../src/app/api/image-studio/presets/route') as typeof import('../src/app/api/image-studio/presets/route');
  const checks: string[] = [], durations: Record<string, number> = {};
  const tokens: Record<string, string> = {}, proofs: Record<string, string> = {};
  let externalCalls = 0;
  mock.method(globalThis, 'fetch', () => { externalCalls++; throw new Error('SQL01 external calls prohibited'); });
  const origins = [{ kind: 'image-preset' as const, id: presetId, ownerId: 'author' }];
  const context = <T>(id: string | null, action: () => T, proof?: string, token?: string) => {
    const headers = new Headers(id ? { cookie: `${auth.SESSION_COOKIE}=${token ?? tokens[id]}; ${identity.PRIVATE_IDENTITY_COOKIE}=${proof ?? proofs[id] ?? ''}` } : {});
    return requestAsyncStorage.run({ headers }, action);
  };
  const timed = async <T>(label: string, work: () => Promise<T>) => {
    const started = performance.now();
    try { const value = await work(); assert.ok(performance.now() - started < 1500, label + ': transaction must not self-wait'); return value; }
    finally { durations[label] = Math.round(performance.now() - started); console.log(JSON.stringify({ phase: label, elapsedMs: durations[label] })); }
  };
  const moneyCounts = async () => ({ ledger: await prisma.creditLedger.count(), holds: await prisma.creditHold.count(),
    accounts: await prisma.creditAccount.count(), tasks: await prisma.videoTask.count(), budgets: await prisma.projectBudgetLedger.count() });
  try {
    for (const id of ['author', 'admin', 'ordinary']) {
      await prisma.user.create({ data: { id, name: id, username: id, email: `${id}@synthetic.invalid`,
        password_hash: 'synthetic-not-a-password', role: id === 'admin' ? 'admin' : 'user', account_type: 'internal', status: 'active',
        feishu_user_id: id + '-subject', feishu_open_id: id + '-subject', feishu_tenant_key: 'synthetic' } });
      tokens[id] = await store.createSession(id);
      const proof = identity.signVerifiedFeishuIdentity({ userId: id, role: id === 'admin' ? 'admin' : 'user', tenant: 'synthetic', subject: id + '-subject' }, tokens[id]);
      if (proof) proofs[id] = proof;
    }
    const base = { id: presetId, owner_id: 'author', name: 'Synthetic SQL01', prompt: 'synthetic-private-prompt',
      context: 'synthetic-private-context', scope: 'creator', is_shared: true, model: 'gpt-image-1', quality: 'auto',
      resolution: '4K', count: 1, reference_limit: 10, aspect_ratio: 'auto', reference_ids: '[]' };
    const model = require('../src/lib/image-studio/model-catalog') as typeof import('../src/lib/image-studio/model-catalog');
    base.model = model.IMAGE_STUDIO_MODELS[0];
    const encrypted = privateStorage.writePrivateStudioDefinition('image-preset', base);
    await prisma.imageStudioPreset.create({ data: encrypted });
    await prisma.imageStudioModule.create({ data: { id: moduleId, owner_id: 'author', source_preset_id: presetId, model: base.model } });
    for (const [key, value] of [[shared.studioBindingKey(moduleId), { ownerId: 'author', presetId, mode: 'publisher', protocol: shared.SHARED_STUDIO_PROTOCOL }],
      [shared.studioPublisherKey(presetId), { ownerId: 'author', moduleId, presetId, protocol: shared.SHARED_STUDIO_PROTOCOL }]] as const) {
      await prisma.platformSetting.create({ data: { key, value_json: JSON.stringify(value), updated_by: 'author' } });
    }
    const before = await moneyCounts();
    const author = await context('author', () => auth.getSession()); assert.ok(author);
    assert.equal(privatePromptCapabilities(author, origins).canReadPrivatePrompt, true);
    assert.equal(privatePromptCapabilities({ ...author }, origins).canReadPrivatePrompt, false, 'A database/user projection is not a verified HTTP principal');
    checks.push('real_cookie_and_signed_feishu_identity_not_database_user');

    const definition = await timed('full_shared_definition', () => context('author', () => shared.resolveSharedStudioDefinition(author, presetId)));
    assert.equal(definition.publicDTO.canReadPrivatePrompt, true);
    assert.equal(definition.publicDTO.templatePrompt, ''); assert.equal(definition.publicDTO.context, '');
    assert.equal(definition.definition.prompt, base.prompt);
    checks.push('complete_shared_template_transaction_under_1500ms_preserves_redacted_DTO');
    const response = await timed('actual_presets_module_route', () => context('author', () => GET(new NextRequest(`http://synthetic.invalid/api/image-studio/presets?moduleId=${moduleId}`))));
    assert.equal(response.status, 200);
    const body = await response.json(); assert.ok(body.presets.some((row: { id: string }) => row.id === presetId));
    assert.ok(!JSON.stringify(body).includes(base.prompt) && !JSON.stringify(body).includes(base.context));
    checks.push('actual_presets_module_handler_real_request_context_redacts_private_text');

    const editor = await context('author', () => shared.readPrivateStudioEditor(author, moduleId));
    const saveInput = { requestId: randomUUID(), revision: editor.revision, sourceRevision: editor.sourceRevision,
      prompt: base.prompt + '-updated', context: base.context + '-updated' };
    const saved = await timed('private_editor_save', () => context('author', () => shared.savePrivateStudioEditor(author, moduleId, saveInput)));
    assert.equal(saved.state, 'saved');
    assert.deepEqual(await timed('private_editor_original_receipt', () => context('author', () => shared.savePrivateStudioEditor(author, moduleId, saveInput))), saved);
    assert.equal((await context('author', () => shared.readPrivateStudioEditor(author, moduleId))).prompt, saveInput.prompt);
    checks.push('private_editor_same_tx_identity_CAS_and_original_receipt_preserved');
    const skills = require('../src/lib/image-studio/skills') as typeof import('../src/lib/image-studio/skills');
    const skill = await timed('private_skill_create', () => context('author', () => skills.saveSkill(author,
      { name: 'Synthetic SQL01', prompt: 'synthetic-sql01-skill' })));
    assert.equal(skill.canReadPrivatePrompt, true); assert.equal('prompt' in skill, false);
    const skillEditor = require('../src/lib/image-studio/private-skill-editor.server') as typeof import('../src/lib/image-studio/private-skill-editor.server');
    const currentSkill = await context('author', () => skillEditor.readPrivateSkillEditor(author, skill.id));
    const skillSaved = await timed('private_skill_edit', () => context('author', () => skillEditor.savePrivateSkillEditor(author, skill.id,
      { requestId: randomUUID(), revision: currentSkill.revision, sourceRevision: currentSkill.sourceRevision,
        prompt: '', context: 'synthetic-sql01-skill-updated' })));
    assert.equal(skillSaved.state, 'saved');
    checks.push('private_skill_save_and_return_DTO_use_same_transaction');

    for (const id of ['author', 'admin', 'ordinary']) {
      const caps = await timed('transaction_identity_' + id, () => context(id, () => readSharedStudioSnapshot(async tx => {
        await tx.userSession.count();
        return privateRequest.privatePromptRequestCapabilities(id, origins, tx);
      })));
      assert.equal(caps.canReadPrivatePrompt, id !== 'ordinary');
      assert.equal(caps.canEditPrivatePrompt, id !== 'ordinary');
    }
    checks.push('same_transaction_signed_author_admin_allowed_ordinary_denied');
    const staleProof = await timed('session_binding_negative', () => context('admin', () => readSharedStudioSnapshot(tx =>
      privateRequest.privatePromptRequestCapabilities('admin', origins, tx)), proofs.author));
    assert.equal(staleProof.canReadPrivatePrompt, false);
    const passwordOnly = await timed('missing_signed_identity_negative', () => context('author', () => readSharedStudioSnapshot(tx =>
      privateRequest.privatePromptRequestCapabilities('author', origins, tx)), ''));
    assert.equal(passwordOnly.canReadPrivatePrompt, false);
    const noCookie = await context(null, () => readSharedStudioSnapshot(tx => privateRequest.privatePromptRequestCapabilities('author', origins, tx)));
    assert.equal(noCookie.canReadPrivatePrompt, false);
    checks.push('session_bound_proof_missing_proof_and_no_cookie_fail_closed');
    const oldActivity = new Date(Date.now() - 10000);
    await prisma.userSession.update({ where: { token_digest: store.sessionTokenDigest(tokens.author) }, data: { last_activity_at: oldActivity } });
    await assert.rejects(context('author', () => prisma.$transaction(async tx => {
      assert.ok(await auth.getSession(tx)); throw new Error('synthetic rollback');
    })), /synthetic rollback/);
    const afterRollback = await prisma.userSession.findUniqueOrThrow({ where: { token_digest: store.sessionTokenDigest(tokens.author) } });
    assert.equal(+afterRollback.last_activity_at, +oldActivity, 'Renewal must roll back with the enclosing transaction');
    checks.push('session_renewal_does_not_escape_rollback');
    const revoked = await timed('revoked_session_negative', () => context('author', () => prisma.$transaction(async tx => {
      await store.revokeSession(tokens.author, 'synthetic-revoke', tx);
      return privateRequest.privatePromptRequestCapabilities('author', origins, tx);
    })));
    assert.equal(revoked.canReadPrivatePrompt, false);
    checks.push('transaction_fresh_revocation_denied_without_global_client');
    assert.deepEqual(await moneyCounts(), before); assert.equal(externalCalls, 0);
    assert.equal(JSON.stringify(await prisma.imageStudioPreset.findUniqueOrThrow({ where: { id: presetId } })).includes(base.prompt), false);
    checks.push('encrypted_storage_and_all_financial_rows_unchanged_no_external_call');
    console.log(JSON.stringify({ schema: 'sql01-template.v1', syntheticOnly: true, checks, durations,
      total: checks.length, passed: checks.length, productionWrites: 0, providerCalls: externalCalls, databaseClients: 1, connectionLimit: 1 }));
  } finally { mock.restoreAll(); await prisma.$disconnect(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
