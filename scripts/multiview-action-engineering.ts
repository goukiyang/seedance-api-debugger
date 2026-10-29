import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, realpath, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import ts from 'typescript';
import path from 'node:path';
import type { SessionUser } from '../src/lib/auth/session';
import type { StudioRunSnapshot } from '../src/lib/template-studio/types';

async function main() {
  const temporary = await mkdtemp('/tmp/sd2-multiview-action-engineering-');
  const fixture = await realpath(temporary);
  await chmod(fixture, 0o700);
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${fixture}/isolated.sqlite`, PRIVATE_PROMPTS_FIXTURE_ROOT: fixture,
    PRIVATE_PROMPTS_POLICY_FILE: `${fixture}/policy.json`, PRIVATE_PROMPTS_MIN_STATE: 'encrypted-write', PRIVATE_PROMPTS_CONSUMER_ID: 'action-fixture',
    PRIVATE_PROMPTS_RUNTIME_REVISION: 'a'.repeat(40), MULTIVIEW_ACTION_ACCEPTING: '1' });
  const keyring: Record<string, { active: string; files: Record<string, string> }> = {};
  for (const domain of ['body', 'index', 'backup']) {
    const file = `${fixture}/${domain}.key`; await writeFile(file, randomBytes(32), { mode: 0o600 });
    keyring[domain] = { active: 'fixture', files: { fixture: file } };
  }
  await writeFile(`${fixture}/attestation.json`, JSON.stringify({ schema: 'private-prompt-consumers.v1', policyRevision: 'fixture', inventoryId: 'fixture', restoreId: 'fixture', writerFenceId: 'fixture',
    consumers: [{ id: 'action-fixture', reader: 1, permissionContract: 1, sourceRevision: 'a'.repeat(40) }] }), { mode: 0o600 });
  await writeFile(`${fixture}/policy.json`, JSON.stringify({ schema: 'private-prompt-policy.v1', revision: 'fixture', state: 'encrypted-write', minimumReader: 1,
    identities: [], origins: [], authorKinds: [], keys: keyring, destinations: [], consumers: ['action-fixture'],
    activation: { inventoryId: 'fixture', restoreId: 'fixture', writerFenceId: 'fixture', attestationFile: `${fixture}/attestation.json` } }), { mode: 0o600 });
  await writeFile(`${fixture}/isolated.sqlite`, '', { mode: 0o600, flag: 'wx' });
  const initialize = spawnSync(process.execPath, [path.join(process.cwd(), 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.resolve('prisma/schema.prisma')], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 120000 });
  assert.equal(initialize.status, 0, `isolated schema initialization failed: ${initialize.error?.message || ''} ${initialize.stdout?.slice(-1000) || ''} ${initialize.stderr?.slice(-1000) || ''}`);
  const [{ prisma }, contexts, privateStorage, projection, drafts, runs, handoff, admin, context, worker, actions, contract, security, settingMigration, runMigration] = await Promise.all([
    import('../src/lib/prisma'), import('../src/lib/video/multiview-action-context.server'), import('../src/lib/template-studio/private-storage.server'),
    import('../src/lib/template-studio/projection'), import('../src/lib/template-studio/drafts'), import('../src/lib/template-studio/runs'), import('../src/lib/template-studio/handoff'),
    import('../src/lib/template-studio/admin-runs'), import('../src/lib/template-studio/context'), import('../src/lib/template-studio/worker'),
    import('../src/lib/video/multiview-action.server'), import('../src/lib/video/multiview-action-contract'), import('../src/lib/security/private-prompts.server'),
    import('../src/lib/security/private-setting-migration.server'), import('../src/lib/template-studio/private-migration.server'),
  ]);
  const noAccess = (error: unknown) => Boolean(error && typeof error === 'object' && 'status' in error && [404, 409].includes(Number(error.status)));
  try {
    const row = await prisma.user.create({ data: { id: 'fixture-owner', name: 'Fixture', username: 'fixture-owner', email: 'fixture-owner@example.invalid', password_hash: 'fixture-only', role: 'admin' } });
    const user: SessionUser = { id: row.id, name: row.name, username: row.username, email: row.email, role: 'admin', account_type: 'internal', status: 'active', user_profile: row.user_profile,
      feature_profile_id: null, expires_at: null, mobile: null, avatar_url: null, feishu: { user_id: null, open_id: null, union_id: null, tenant_key: null, employee_no: null, department_ids: [], last_sync_at: null } };
    const params = { provider: 'seedance' as const, model: 'dreamina-seedance-2-0-260128', duration: 5, resolution: '720p' as const, ratio: '16:9' as const, project_id: '', video_card_id: null };
    const format = 'synthetic private format marker 93274', sync = 'synthetic private synchronization marker 88342';
    assert.deepEqual(await contexts.initializeMultiviewActionContexts({ format, sync }, user.id), { format: 'initialized', sync: 'initialized' });
    assert.deepEqual(await contexts.initializeMultiviewActionContexts({ format: 'replacement', sync: 'replacement' }, user.id), { format: 'preserved', sync: 'preserved' });
    assert.equal((await contexts.readMultiviewActionContext('format')).context, format);
    const storedContext = await prisma.platformSetting.findUniqueOrThrow({ where: { key: contexts.MULTIVIEW_ACTION_CONTEXT_KEYS.format } });
    assert.ok(!storedContext.value_json.includes(format), 'fixed rule leaked to its stored envelope');
    await assert.rejects(contexts.readMultiviewActionContextEditor(user, 'format'), /身份|私密|不可用/, 'database admin role must not replace a verified signed identity');
    const actionDraft = await prisma.videoStudioDraft.create({ data: { id: 'fixture-action-draft', owner_user_id: user.id, purpose: 'multiview-action', name: 'Action',
      prompt: 'turn and return', values_json: JSON.stringify({ workId: 'fixture-work', workRevision: 1 }), parameters_json: JSON.stringify(params) } });
    const value: StudioRunSnapshot = { purpose: 'multiview-action', input: { name: 'Action', groupName: '3D多视图', values: {}, draftPrompt: 'turn and return' }, templateVersion: null, recipe: null,
      prompt: 'turn and return', parameters: params, assets: [], owner: { userId: user.id, username: user.username, displayName: 'Fixture', accountType: 'internal' },
      privateContext: { global: format, module: sync, globalRevision: 1, moduleRevision: 1 },
      multiviewAction: { stage: 'final', workId: 'fixture-work', revision: 1, recipeHash: 'b'.repeat(64), outputHash: 'c'.repeat(64), inputHash: 'd'.repeat(64),
        sourceTaskId: 'fixture-task', sourceVersion: 'e'.repeat(64), geometry: { panels: [] }, assetId: 'fixture-asset', formatRevision: 1, syncRevision: 1 } };
    const encrypted = privateStorage.transformPrivateVideoRun(value, 'fixture-action-run', actionDraft.id, true);
    assert.ok(!JSON.stringify(encrypted).includes(format) && !JSON.stringify(encrypted).includes(sync), 'private fixed rule leaked to the run snapshot');
    const decoded = privateStorage.transformPrivateVideoRun(encrypted, 'fixture-action-run', actionDraft.id, false);
    assert.equal(decoded.privateContext?.global, format); assert.equal(decoded.privateContext?.module, sync);
    assert.ok(!JSON.stringify(projection.publicRunSnapshot(decoded)).includes(format) && !JSON.stringify(projection.publicRunSnapshot(decoded)).includes(sync), 'private fixed rule leaked to public projection');
    const tampered = { ...encrypted, privateContext: { ...encrypted.privateContext!, global: encrypted.privateContext!.module } };
    assert.throws(() => privateStorage.transformPrivateVideoRun(tampered, 'fixture-action-run', actionDraft.id, false),
      (error: any) => error?.code === 'PRIVATE_PROMPT_UNAVAILABLE', 'fixed rule source binding was interchangeable');
    const actionRun = await prisma.videoStudioRun.create({ data: { id: 'fixture-action-run', owner_user_id: user.id, purpose: 'multiview-action', draft_id: actionDraft.id, request_id: 'mv-action:fixture-request',
      request_fingerprint: 'fixture', source: 'blank', mode: 'direct', status: 'succeeded', prompt: value.prompt, snapshot_json: JSON.stringify(encrypted) } });
    const oldDraft = await drafts.createStudioDraft(user, {});
    assert.equal((await prisma.videoStudioDraft.findUniqueOrThrow({ where: { id: oldDraft.id } })).purpose, 'studio');
    assert.ok(!(await drafts.listStudioDrafts(user)).items.some(item => item.id === actionDraft.id));
    assert.ok(!(await runs.listStudioRuns(user, {})).items.some(item => item.id === actionRun.id));
    await assert.rejects(drafts.getStudioDraft(user, actionDraft.id), noAccess);
    await assert.rejects(drafts.updateStudioDraft(user, actionDraft.id, { name: 'changed', groupName: 'changed', prompt: 'changed', values: {}, assets: [], parameters: {}, revision: 1 }), noAccess);
    await assert.rejects(drafts.createStudioDraft(user, { fromRunId: actionRun.id }), noAccess);
    await assert.rejects(drafts.createStudioDraft(user, { fromDraftId: actionDraft.id, recovery: { prompt: 'copy', values: {}, assets: [], parameters: {} } }), noAccess);
    await assert.rejects(runs.createStudioRun(user, { draftId: actionDraft.id, revision: 1, mode: 'direct', requestId: 'another-request' }), noAccess);
    await assert.rejects(runs.createStudioRun(user, { draftId: actionDraft.id, revision: 1, mode: 'direct', requestId: actionRun.request_id }), noAccess);
    await assert.rejects(runs.getStudioRun(user, actionRun.id), noAccess);
    await assert.rejects(handoff.getStudioRunHandoff(user, actionRun.id), noAccess);
    await assert.rejects(handoff.saveStudioFinalText(user, actionRun.id, { prompt: 'changed' }), noAccess);
    await assert.rejects(admin.getAdminStudioRun(user, actionRun.id), noAccess);
    await assert.rejects(context.getVideoContext(user, actionDraft.id, true), noAccess);
    const safeRun = await actions.getMultiviewActionRun(user, actionRun.id);
    assert.equal(safeRun.inputText, 'turn and return'); assert.equal(safeRun.text, 'turn and return'); assert.equal(safeRun.draftRevision, 1);
    assert.ok(!JSON.stringify(safeRun).includes(format) && !JSON.stringify(safeRun).includes(sync));
    assert.equal((await actions.findMultiviewActionRunRequest(user, 'fixture-request'))?.id, actionRun.id);
    assert.equal(await actions.findMultiviewActionRunRequest(user, 'missing-request'), null, 'missing request lookup must be nullable without creating a new run');
    await assert.rejects(actions.getMultiviewActionRun({ ...user, id: 'another-owner' }, actionRun.id), noAccess);
    await prisma.videoStudioRun.create({ data: { id: 'expired-action', owner_user_id: user.id, purpose: 'multiview-action', draft_id: actionDraft.id, request_id: 'expired-original', request_fingerprint: 'fixture', source: 'blank', mode: 'llm', status: 'running',
      delivery_state: 'sending', lease_token: 'expired', lease_expires_at: new Date(1), snapshot_json: '{}', attempt: 1 } });
    await worker.recoverExpiredStudioRuns();
    const unknown = await prisma.videoStudioRun.findUniqueOrThrow({ where: { id: 'expired-action' } });
    assert.equal(unknown.status, 'uncertain'); assert.equal(unknown.delivery_state, 'unknown'); assert.equal(unknown.request_id, 'expired-original'); assert.equal(unknown.attempt, 1);
    await prisma.videoStudioRun.create({ data: { id: 'unrecognized-purpose', owner_user_id: user.id, purpose: 'unrecognized', draft_id: oldDraft.id, request_id: 'unrecognized', request_fingerprint: 'fixture', source: 'blank', mode: 'llm', status: 'queued', snapshot_json: '{}' } });
    assert.equal(await worker.processStudioPromptOnce(), false, 'worker claimed an unsupported purpose');
    const parsed = { runId: actionRun.id, workId: 'fixture-work', revision: 1, recipeHash: 'b'.repeat(64), inputHash: 'd'.repeat(64) };
    assert.deepEqual(contract.parseMultiviewActionBinding(parsed), parsed);
    assert.equal(contract.parseMultiviewActionBinding({ ...parsed, revision: NaN }), null);
    assert.equal(contract.parseMultiviewActionBinding({ ...parsed, provider: 'unrelated' }), null);
    assert.equal(actions.normalizeMultiviewActionParameters(params).provider, 'seedance');
    assert.throws(() => actions.normalizeMultiviewActionParameters({ ...params, provider: 'volcengine_ip' }));
    assert.throws(() => actions.normalizeMultiviewActionParameters({ ...params, model: 'unknown-model' }));
    assert.throws(() => actions.normalizeMultiviewActionParameters({ ...params, duration: 16 }));
    assert.equal(actions.normalizeMultiviewActionParameters({ ...params, model: 'dreamina-seedance-2-5-260628', duration: 30 }).duration, 30);
    // The accepted source artifact is an isolated boundary fixture; final-version logic,
    // private rules and all idempotent writes run from the actual service against SQLite.
    const serviceFile = path.resolve('src/lib/video/multiview-action.server.ts');
    const compiled = ts.transpileModule(await readFile(serviceFile, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const fixtureReference = { assetId: 'fixture-asset', recipeHash: 'b'.repeat(64), outputHash: 'c'.repeat(64), sourceTaskId: 'fixture-task', sourceVersion: 'e'.repeat(64),
      geometry: { output: { width: 1920, height: 1080, background: '#d6dbdf' }, panels: [], placements: [], divider: { enabled: true, color: '#5b6570', widthPx: 2 } } };
    const nativeRequire = createRequire(serviceFile), evaluated = { exports: {} };
    const requireBoundary = (id: string) => id === './multiview-output-assets.server' ? {
      ensureMultiviewReferenceAsset: async () => fixtureReference, readMultiviewReferenceBinding: async () => fixtureReference,
    } : nativeRequire(id);
    new Function('require', 'module', 'exports', compiled)(requireBoundary, evaluated, evaluated.exports);
    const finalActions = evaluated.exports as typeof import('../src/lib/video/multiview-action.server');
    const finalInput = { draftId: actionDraft.id, revision: 1, text: 'perform a distinct movement', parameters: { ...params, project_id: 'fixture-project' } };
    const initialFinal = await finalActions.finalizeMultiviewAction(user, finalInput);
    const replayFinal = await finalActions.finalizeMultiviewAction(user, { ...finalInput, attemptId: 'initial' });
    assert.equal(initialFinal.run.id, replayFinal.run.id, 'same attempt created another immutable final run');
    const repeatedFinal = await finalActions.finalizeMultiviewAction(user, { ...finalInput, attemptId: 'a96f5352-3acd-4da7-84d7-8bbc3e733da3' });
    assert.notEqual(initialFinal.run.id, repeatedFinal.run.id, 'explicit new attempt could not create a fresh immutable version');
    assert.equal(initialFinal.binding.inputHash, repeatedFinal.binding.inputHash, 'attempt identity changed the actual frozen input signature');
    assert.equal(await prisma.videoStudioRun.count({ where: { purpose: 'multiview-action', mode: 'direct', prompt: finalInput.text } }), 2, 'same-attempt replay wrote an extra version');
    const transaction = prisma.$transaction.bind(prisma);
    let attempts = 0;
    try {
      prisma.$transaction = (async (...args: Parameters<typeof transaction>) => {
        if (++attempts === 1) throw Object.assign(new Error('isolated busy transaction'), { code: 'P1008' });
        return transaction(...args);
      }) as typeof prisma.$transaction;
      const busyInput = { ...finalInput, attemptId: 'ff9da034-c478-4410-b577-86cd6bdb08f4' };
      const busyFinal = await finalActions.finalizeMultiviewAction(user, busyInput);
      assert.equal(attempts, 2, 'rolled-back busy preparation was not retried');
      assert.equal((await finalActions.finalizeMultiviewAction(user, busyInput)).run.id, busyFinal.run.id, 'busy retry changed the immutable request identity');
      attempts = 0;
      prisma.$transaction = (async () => { attempts++; throw Object.assign(new Error('isolated non-busy failure'), { code: 'P2002' }); }) as typeof prisma.$transaction;
      await assert.rejects(finalActions.finalizeMultiviewAction(user, { ...finalInput, attemptId: '73b77315-b7d5-4e57-a537-faa9d8b9aabb' }), (error: any) => error.code === 'P2002');
      assert.equal(attempts, 1, 'a non-busy or uncertain error was retried');
      attempts = 0;
      prisma.$transaction = (async () => { attempts++; throw Object.assign(new Error('isolated persistent busy failure'), { code: 'P1008' }); }) as typeof prisma.$transaction;
      await assert.rejects(finalActions.finalizeMultiviewAction(user, { ...finalInput, attemptId: '73b77315-b7d5-4e57-a537-faa9d8b9aabb' }), (error: any) => error.code === 'P1008');
      assert.equal(attempts, 3, 'preparation retry was unbounded');
    } finally { prisma.$transaction = transaction; }
    assert.equal(await prisma.videoStudioRun.count({ where: { purpose: 'multiview-action', mode: 'direct', prompt: finalInput.text } }), 3, 'busy or rejected preparation created duplicate versions');
    await assert.rejects(finalActions.finalizeMultiviewAction(user, { ...finalInput, attemptId: 'not-a-uuid' }), /编号无效/);
    process.env.MULTIVIEW_ACTION_ACCEPTING = '0';
    assert.equal((await actions.getMultiviewActionCapabilities(user)).actionReady, false);
    await assert.rejects(actions.finalizeMultiviewAction(user, { draftId: actionDraft.id, revision: 1, text: 'action', parameters: params }), noAccess);
    assert.equal((await actions.getMultiviewActionRun(user, actionRun.id)).id, actionRun.id, 'closed acceptance gate blocked an original record read');
    const nextKey = `${fixture}/next-body.key`; await writeFile(nextKey, randomBytes(32), { mode: 0o600 });
    keyring.body.active = 'next'; keyring.body.files.next = nextKey;
    const policy = security.privatePromptPolicy()!;
    await writeFile(`${fixture}/policy.json`, JSON.stringify({ ...policy, keys: keyring }), { mode: 0o600 });
    const contextRotation = await settingMigration.preparePrivateSettingMigration(prisma, [storedContext.id], { rotateBodyKey: true });
    assert.equal(contextRotation.rows.length, 1, 'new fixed context was not classified for body key rotation');
    const runRotation = await runMigration.prepareVideoStudioPrivateMigration(prisma, { templates: [], versions: [], drafts: [], runs: [actionRun.id] }, { rotateBodyKey: true });
    assert.equal(runRotation.rows.length, 1, 'action run private fields were not classified for body key rotation');
    console.log('multiview action engineering: real SQLite purpose isolation, encrypted rules/AAD, safe projections, owner/request recovery, unknown lease, provider/model/duration and guard boundaries passed');
  } finally { await prisma.$disconnect(); await rm(fixture, { recursive: true, force: true }); }
}
void main().catch(error => { console.error('multiview action engineering failed:', error instanceof Error ? error.message : 'unknown'); process.exitCode = 1; });
