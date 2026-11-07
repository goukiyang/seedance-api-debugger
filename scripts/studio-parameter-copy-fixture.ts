import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const run = await mkdtemp(path.join(os.tmpdir(), 'sd2-parameter-copy-'));
  process.env.DATABASE_URL = `file:${run}/fixture.sqlite`;
  Object.assign(process.env, { NODE_ENV: 'test' });
  process.env.STUDIO_TASK_SETTINGS_V2_WRITE = '1';
  delete process.env.FEISHU_ALLOWED_TENANT_KEY;
  for (const key of Object.keys(process.env).filter(key => key.startsWith('PRIVATE_PROMPTS_'))) delete process.env[key];
  const schema = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate', '--schema', 'prisma/schema.prisma'],
    { env: process.env, encoding: 'utf8', timeout: 120000 });
  assert.equal(schema.status, 0, schema.stderr);
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Offline fixture only'); };
  const { prisma } = await import('../src/lib/prisma');
  const { STUDIO_TASK_SETTINGS_FILES } = await import('../src/lib/image-studio/task-settings-storage');
  const { saveStudioModule, shareSavedStudioModule, studioModuleSharingStatus } = await import('../src/lib/image-studio/modules');
  const { saveStudioParameterCopy, resolveSharedStudioDefinition, openSharedStudioModule, saveSharedStudioPersonal, studioParameterCopyStatus } = await import('../src/lib/image-studio/shared-contract');
  const { setStudioPresetSharing } = await import('../src/lib/image-studio/presets');
  const { readStudioParameterCopy } = await import('../src/lib/image-studio/parameter-copy');
  const { queryStudioGallery } = await import('../src/lib/image-studio/gallery');
  const checks: string[] = [];
  try {
    for (const [id, role] of [['author', 'admin'], ['member', 'user'], ['admin-colleague', 'admin']]) await prisma.user.create({ data: {
      id, name: id, username: id, email: `${id}@fixture.invalid`, password_hash: 'fixture-only', role, account_type: 'internal',
      feishu_tenant_key: 'fixture-tenant', feishu_open_id: `fixture-${id}` } });
    const author = { id: 'author', role: 'admin', account_type: 'internal' };
    const member = { id: 'member', role: 'user', account_type: 'internal' };
    const admin = { id: 'admin-colleague', role: 'admin', account_type: 'internal' };
    await prisma.platformSetting.create({ data: { key: 'studio_shared_worker_v1', updated_by: author.id, value_json: JSON.stringify({
      taskSettingsProtocol: 'task-settings-v2', expiresAt: new Date(Date.now() + 300000).toISOString(),
      loadedModuleSha: Object.fromEntries(STUDIO_TASK_SETTINGS_FILES.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])) }) } });
    await prisma.imageStudioModule.create({ data: { id: 'default-author', owner_id: author.id, name: '过度帧', context: 'root-private-context' } });
    const saved = await saveStudioModule(author.id, { id: 'default-author', revision: 0, name: '过度帧', prompt: '', count: 1, referenceIds: [], context: 'root-private-context', aspectRatio: 'auto' });
    const command = { id: saved.id, revision: saved.revision, isShared: true, requestId: randomUUID() };
    const published = await shareSavedStudioModule(author.id, command);
    const rootId = published.sourcePresetId!;
    const status = await studioModuleSharingStatus(author.id, { ...command, action: 'share-saved-module' });
    assert.equal(status.status, 'completed');
    assert.equal(await prisma.imageStudioPreset.count(), 1);
    const rejected = { ...command, revision: command.revision + 100, requestId: randomUUID() };
    await assert.rejects(shareSavedStudioModule(author.id, rejected), (cause: unknown) => {
      const outcome = (cause as { commandOutcome?: { status: string; actorId: string; requestId: string } }).commandOutcome;
      return outcome?.status === 'not-applied' && outcome.actorId === author.id && outcome.requestId === rejected.requestId;
    });
    checks.push('lost publication response is recovered by authenticated receipt read without another write');
    const workspace = await openSharedStudioModule(member, rootId, randomUUID(), undefined, { explicitSelection: true });
    const adminWorkspace = await openSharedStudioModule(admin, rootId, randomUUID(), undefined, { explicitSelection: true });
    const rootBefore = await prisma.imageStudioPreset.findUniqueOrThrow({ where: { id: rootId } });
    for (const [actor, own] of [[member, workspace], [admin, adminWorkspace]] as const) {
      await assert.rejects(saveSharedStudioPersonal(actor, own.id, { requestId: randomUUID(), revision: own.revision, personalOverrides: { count: 3 } }), { status: 403 });
      assert.equal((await prisma.imageStudioModule.findUniqueOrThrow({ where: { id: own.id } })).revision, own.revision);
    }
    checks.push('member and administrator non-author defaults writes rejected; source and personal revisions unchanged');
    const definition = await resolveSharedStudioDefinition(member, rootId);
    const input = { saveIntent: 'personal-parameters', sourceModuleId: workspace.id, moduleRevision: workspace.revision,
      expectedDefinitionToken: definition.definition.intent.definitionToken, requestId: randomUUID(), name: '我的参数副本', isShared: false,
      model: 'gpt-image-2.5-sunburst', quality: 'medium', resolution: '2K', count: 2, aspectRatio: '1:1', styleGroupIds: [] };
    const copy = await saveStudioParameterCopy(member, input);
    const repeated = await saveStudioParameterCopy(member, input);
    assert.equal(copy.id, repeated.id);
    assert.equal((await studioParameterCopyStatus(member, input.requestId)).status, 'completed');
    assert.equal((await studioParameterCopyStatus(admin, input.requestId)).status, 'not-found');
    const row = await prisma.imageStudioPreset.findUniqueOrThrow({ where: { id: copy.id } });
    assert.equal(row.owner_id, member.id); assert.equal(row.is_shared, false); assert.equal(row.context, ''); assert.equal(row.prompt, '');
    const resolved = await resolveSharedStudioDefinition(member, copy.id);
    assert.equal(resolved.definition.context, 'root-private-context'); assert.equal(resolved.definition.sourceOwnerId, author.id);
    assert.equal(resolved.publicDTO.context, ''); assert.equal(resolved.publicDTO.templatePrompt, ''); assert.equal(resolved.publicDTO.canManageSharing, false);
    assert.equal(resolved.definition.generationDefaults.count, 2);
    assert.deepEqual(await prisma.imageStudioPreset.findUniqueOrThrow({ where: { id: rootId } }), rootBefore);
    checks.push('copy is private, stores parameters only, resolves root server-side, preserves original author, and replays original copy receipt');
    const nextWorkspace = await prisma.imageStudioModule.findUniqueOrThrow({ where: { id: copy.workspaceId } });
    const second = await saveStudioParameterCopy(member, { ...input, name: '第二份', sourceModuleId: nextWorkspace.id,
      moduleRevision: nextWorkspace.revision, expectedDefinitionToken: resolved.definition.intent.definitionToken, requestId: randomUUID() });
    const secondRow = await prisma.imageStudioPreset.findUniqueOrThrow({ where: { id: second.id } });
    assert.equal((await readStudioParameterCopy(prisma, secondRow))?.rootPresetId, rootId);
    await assert.rejects(setStudioPresetSharing(member, copy.id, true, row.updated_at.toISOString(), randomUUID()), { status: 403 });
    await assert.rejects(resolveSharedStudioDefinition(admin, copy.id), { status: 404 });
    checks.push('copy of copy flattens root; private copy cannot be shared or read by another administrator');
    const gallery = await queryStudioGallery(member, { protocol: 'catalog-paged-v2', pageSize: 30 });
    assert.ok(gallery.navigation.some(item => item.id === copy.workspaceId));
    checks.push('wide three-row gallery accepts30 without private linkage cache misprojection');
    await setStudioPresetSharing(author, rootId, false, rootBefore.updated_at.toISOString(), randomUUID());
    await assert.rejects(resolveSharedStudioDefinition(member, copy.id));
    await assert.rejects(resolveSharedStudioDefinition(member, second.id));
    assert.equal(await prisma.imageStudioTask.count(), 0); assert.equal(calls, 0);
    checks.push('root withdrawal blocks both copies; no tasks, network generation, or charges');
    console.log(JSON.stringify({ ok: true, checks, count: checks.length, networkCalls: calls }, null, 2));
  } finally { globalThis.fetch = oldFetch; await prisma.$disconnect(); await rm(run, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
