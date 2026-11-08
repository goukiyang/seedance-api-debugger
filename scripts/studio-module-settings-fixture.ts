import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const run = await mkdtemp(path.join(os.tmpdir(), 'sd2-module-settings-'));
  process.env.DATABASE_URL = `file:${run}/fixture.sqlite`;
  process.env.NODE_ENV = 'test'; process.env.STUDIO_TASK_SETTINGS_V2_WRITE = '1';
  delete process.env.FEISHU_ALLOWED_TENANT_KEY;
  for (const key of Object.keys(process.env).filter(key => key.startsWith('PRIVATE_PROMPTS_'))) delete process.env[key];
  const schema = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate', '--schema', 'prisma/schema.prisma'],
    { env: process.env, encoding: 'utf8', timeout: 120000 });
  if (schema.status !== 0) { await rm(run, { recursive: true, force: true }); assert.equal(schema.status, 0, schema.stderr || schema.stdout); }
  const oldFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Offline fixture only'); };
  const { prisma } = await import('../src/lib/prisma');
  const { STUDIO_TASK_SETTINGS_FILES } = await import('../src/lib/image-studio/task-settings-storage');
  const { saveStudioModule, shareSavedStudioModule } = await import('../src/lib/image-studio/modules');
  const { openSharedStudioModule, resolveSharedStudioDefinition } = await import('../src/lib/image-studio/shared-contract');
  const { saveStudioStyleGroup, setStudioPresetStyleIds } = await import('../src/lib/image-studio/style-groups');
  const { setStudioPresetSharing } = await import('../src/lib/image-studio/presets');
  const { saveStudioModuleSettings: save, listStudioModuleSettings: list, studioModuleSettingsStatus: status } = await import('../src/lib/image-studio/module-settings');
  const { normalizeSharedAuthorDraftForUse, parseStudioRequest } = await import('../src/lib/image-studio/tasks');
  const checks: string[] = [];
  try {
    assert.ok(process.env.DATABASE_URL.startsWith(`file:${run}/`));
    for (const [id, role] of [['author', 'admin'], ['member', 'user'], ['admin-colleague', 'admin']]) await prisma.user.create({ data: {
      id, role, name: id, username: id, email: `${id}@fixture.invalid`, password_hash: 'fixture-only', account_type: 'internal',
      feishu_tenant_key: 'fixture-tenant', feishu_open_id: `fixture-${id}` } });
    const author = { id: 'author', role: 'admin', account_type: 'internal' };
    const member = { id: 'member', role: 'user', account_type: 'internal' };
    const other = { id: 'admin-colleague', role: 'admin', account_type: 'internal' };
    await prisma.platformSetting.create({ data: { key: 'studio_shared_worker_v1', updated_by: author.id, value_json: JSON.stringify({
      taskSettingsProtocol: 'task-settings-v2', expiresAt: new Date(Date.now() + 300000).toISOString(),
      loadedModuleSha: Object.fromEntries(STUDIO_TASK_SETTINGS_FILES.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])) }) } });
    await prisma.imageStudioModule.create({ data: { id: 'default-author', owner_id: author.id, name: '技能03', context: 'root-context-never-copied' } });
    const module = await saveStudioModule(author.id, { id: 'default-author', revision: 0, name: '技能03', prompt: '', context: 'root-context-never-copied', count: 1, referenceIds: [], aspectRatio: 'auto' });
    const publication = await shareSavedStudioModule(author.id, { id: module.id, revision: module.revision, isShared: true, requestId: randomUUID() });
    const rootId = publication.sourcePresetId!;
    const styleAsset = await prisma.asset.create({ data: { id: randomUUID(), owner_id: author.id, type: 'image', status: 'active',
      original_url: '/uploads/style-fixture.png', file_name: 'fixture.png', mime_type: 'image/png', file_size: 1, width: 32, height: 32 } });
    const templateStyle = await saveStudioStyleGroup(author, { requestId: randomUUID(), name: 'template-style', shared: true,
      references: [{ assetId: styleAsset.id, note: '' }] });
    await setStudioPresetStyleIds(author, rootId, [templateStyle.id]);
    const opened = await openSharedStudioModule(member, rootId, randomUUID(), undefined, { explicitSelection: true });
    const freshModule = await prisma.imageStudioModule.findUniqueOrThrow({ where: { id: module.id } });
    const definition = await resolveSharedStudioDefinition(author, rootId);
    const rootBefore = await prisma.imageStudioPreset.findUniqueOrThrow({ where: { id: rootId } });
    const before = { presets: await prisma.imageStudioPreset.count(), modules: await prisma.imageStudioModule.count() };
    const values = { model: 'gpt-image-2.5-sunburst', quality: 'medium', resolution: '2K', count: 2, aspectRatio: '1:1', prompt: 'this use only', styleGroupIds: [templateStyle.id], referenceIds: [] };
    const command = { requestId: randomUUID(), moduleId: freshModule.id, moduleRevision: freshModule.revision,
      definitionToken: definition.definition.intent.definitionToken, name: '双张中画质', values };
    const saved = await save(author, command);
    assert.equal(saved.setting.moduleId, freshModule.id); assert.equal(saved.setting.ownerId, author.id);
    assert.equal(saved.setting.values.count, 2);
    assert.equal(await prisma.imageStudioPreset.count(), before.presets); assert.equal(await prisma.imageStudioModule.count(), before.modules);
    assert.deepEqual(await prisma.imageStudioPreset.findUniqueOrThrow({ where: { id: rootId } }), rootBefore);
    assert.deepEqual(await prisma.imageStudioModule.findUniqueOrThrow({ where: { id: freshModule.id } }), freshModule);
    checks.push('author saves named settings under original workspace without creating presets, modules, sharing changes or defaults writes');
    const record = await prisma.platformSetting.findFirstOrThrow({ where: { key: { startsWith: `studio_named_settings_v1:author:${freshModule.id}:` } } });
    assert.ok(!record.value_json.includes('root-context-never-copied'));
    assert.ok(!record.value_json.includes('context')); assert.ok(!record.value_json.includes('primaryIds'));
    checks.push('record contains personal settings only; no template context, primary image, private definition or shared copy');
    const repeated = await save(author, command); assert.equal(repeated.setting.id, saved.setting.id); assert.equal(repeated.replayed, true);
    await assert.rejects(save(author, { ...command, name: 'changed same command' }), { status: 409 });
    assert.equal((await status(author, freshModule.id, command.requestId)).status, 'completed');
    checks.push('lost response recovers by original receipt read; exact retry replays once and changed payload cannot reuse identity');
    const memberDefinition = await resolveSharedStudioDefinition(member, rootId);
    const memberCommand = { ...command, requestId: randomUUID(), moduleId: opened.id, moduleRevision: opened.revision,
      definitionToken: memberDefinition.definition.intent.definitionToken, name: '同事自己的设置' };
    const memberSaved = await save(member, memberCommand); assert.equal(memberSaved.setting.ownerId, member.id);
    assert.deepEqual(await prisma.imageStudioPreset.findUniqueOrThrow({ where: { id: rootId } }), rootBefore);
    assert.deepEqual(await prisma.imageStudioModule.findUniqueOrThrow({ where: { id: opened.id } }), opened);
    const inherited = (await list(member, opened.id, memberSaved.setting.id)).setting;
    assert.deepEqual(inherited?.styleGroups.map(group => group.id), [templateStyle.id]);
    checks.push('template-provided style remains usable when saving and applying named settings');
    checks.push('non-author saves own scheme on same shared template without altering author defaults, source binding or current workspace');
    assert.equal((await list(author, freshModule.id)).settings?.length, 1);
    assert.equal((await list(member, opened.id)).settings?.length, 1);
    await assert.rejects(list(other, freshModule.id), { status: 404 });
    assert.equal((await status(other, opened.id, memberCommand.requestId)).status, 'not-found');
    checks.push('list, apply and original-command reads remain scoped to actor and workspace; administrator cannot read another actor settings');
    const rejected = { ...command, requestId: randomUUID(), moduleRevision: command.moduleRevision + 100 };
    await assert.rejects(save(author, rejected), (error: unknown) => (error as { commandOutcome?: { status: string } }).commandOutcome?.status === 'not-applied');
    assert.equal((await status(author, rejected.moduleId, rejected.requestId)).status, 'not-found');
    await assert.rejects(save(author, { ...command, requestId: randomUUID(), values: { ...values, context: 'forbidden' } }), { status: 400 });
    checks.push('stale workspace is explicitly not-applied with no receipt; template definitions cannot be smuggled into named personal settings');
    const second = await save(author, { ...command, requestId: randomUUID(), name: '单张设置', values: { ...values, count: 1, prompt: 'another scene', styleGroupIds: [] } });
    assert.equal((await list(author, freshModule.id)).settings?.length, 2);
    const applied = (await list(author, freshModule.id, second.setting.id)).setting;
    assert.equal(applied?.values.count, 1); assert.equal(applied?.values.prompt, 'another scene');
    assert.deepEqual(applied?.images, []); assert.deepEqual(applied?.styleGroups, []);
    checks.push('multiple different schemes coexist under one template and explicit apply returns the exact saved values');
    const badReference = { ...command, requestId: randomUUID(), values: { ...values, referenceIds: ['missing-asset'] } };
    await assert.rejects(save(author, badReference), { status: 409 });
    assert.equal((await status(author, freshModule.id, badReference.requestId)).status, 'not-found');
    checks.push('unavailable temporary reference rejects atomically; no successful-looking settings record remains');
    const draft = parseStudioRequest({ requestId: randomUUID(), prompt: '', count: 1, revision: 1, referenceIds: [], draft: { styleGroupIds: [] } });
    const binding = { protocol: 'shared-live-v1', ownerId: author.id, presetId: rootId, mode: 'publisher' as const };
    normalizeSharedAuthorDraftForUse(author, { binding, definition: { ...definition.definition, styleGroupIds: ['saved-style'] } } as never, draft);
    assert.deepEqual(draft.draft?.styleGroupIds, []);
    const forbidden = parseStudioRequest({ requestId: randomUUID(), prompt: '', count: 1, revision: 1, referenceIds: [], draft: { moduleContext: 'unsaved change', styleGroupIds: [] } });
    assert.throws(() => normalizeSharedAuthorDraftForUse(author, { binding, definition: definition.definition } as never, forbidden), { status: 409 });
    checks.push('explicit per-use style choice works for author too; unsaved template context retains original publication protection');
    await setStudioPresetSharing(author, rootId, false, rootBefore.updated_at.toISOString(), randomUUID());
    await assert.rejects(list(member, opened.id, memberSaved.setting.id));
    assert.equal((await status(member, opened.id, memberCommand.requestId)).status, 'completed');
    checks.push('source withdrawal blocks applying another author source while own original save receipt remains recoverable');
    assert.equal(await prisma.imageStudioPreset.count(), before.presets); assert.equal(await prisma.imageStudioModule.count(), before.modules);
    assert.equal(await prisma.imageStudioTask.count(), 0); assert.equal(await prisma.creditLedger.count(), 0); assert.equal(calls, 0);
    checks.push('no extra templates, workspaces, generation, ledger entries or network calls across all settings operations');
    console.log(JSON.stringify({ ok: true, checks, count: checks.length, networkCalls: calls, productionWrites: 0 }, null, 2));
  } finally { globalThis.fetch = oldFetch; await prisma.$disconnect(); await rm(run, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
