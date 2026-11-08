import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { SessionUser } from '../src/lib/auth/session';

async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sd2-result-pins-'));
  process.env.DATABASE_URL = `file:${directory}/fixture.sqlite`;
  Object.assign(process.env, { NODE_ENV: 'test', STUDIO_TASK_SETTINGS_V2_WRITE: '1' });
  delete process.env.FEISHU_ALLOWED_TENANT_KEY;
  for (const key of Object.keys(process.env).filter(key => key.startsWith('PRIVATE_PROMPTS_'))) delete process.env[key];
  const created = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate', '--schema', 'prisma/schema.prisma'],
    { env: process.env, encoding: 'utf8', timeout: 120000 });
  assert.equal(created.status, 0, created.stderr);
  const oldFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('Offline fixture only'); };
  const { prisma } = await import('../src/lib/prisma');
  const { STUDIO_TASK_SETTINGS_FILES } = await import('../src/lib/image-studio/task-settings-storage');
  const { saveStudioModule, shareSavedStudioModule } = await import('../src/lib/image-studio/modules');
  const { resolveSharedStudioDefinition, prepareSharedStudioMethodWorkspace, openSharedStudioModule } = await import('../src/lib/image-studio/shared-contract');
  const { mutateStudioPin, readableStudioPins, resolveStudioPinnedAsset } = await import('../src/lib/image-studio/result-pins');
  const { listStudioResultFeed } = await import('../src/lib/image-studio/result-feed');
  const checks: string[] = [];
  const author: SessionUser = { id: 'pin-author', name: 'Author', username: 'pin-author', email: 'pin-author@fixture.invalid',
    role: 'admin', account_type: 'internal', user_profile: '', feature_profile_id: null, status: 'active', expires_at: null };
  const colleague: SessionUser = { ...author, id: 'pin-colleague', name: 'Colleague', username: 'pin-colleague',
    email: 'pin-colleague@fixture.invalid', role: 'user', feishu: { user_id: null, open_id: 'fixture-pin-colleague', union_id: null,
      tenant_key: 'fixture', employee_no: null, department_ids: [], last_sync_at: null } };
  const moduleId = `default-${author.id}`;
  try {
    for (const user of [author, colleague]) await prisma.user.create({ data: { id: user.id, name: user.name, username: user.username,
      email: user.email, role: user.role, account_type: user.account_type, password_hash: 'fixture-only',
      feishu_tenant_key: 'fixture', feishu_open_id: `fixture-${user.id}` } });
    await prisma.platformSetting.create({ data: { key: 'studio_shared_worker_v1', updated_by: author.id, value_json: JSON.stringify({
      taskSettingsProtocol: 'task-settings-v2', expiresAt: new Date(Date.now() + 300000).toISOString(),
      loadedModuleSha: Object.fromEntries(STUDIO_TASK_SETTINGS_FILES.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])) }) } });
    await prisma.imageStudioModule.create({ data: { id: moduleId, owner_id: author.id, name: 'Pin fixture' } });
    const saved = await saveStudioModule(author.id, { id: moduleId, revision: 0, name: 'Pin fixture', prompt: '', context: '',
      count: 1, referenceIds: [], aspectRatio: 'auto' });
    const published = await shareSavedStudioModule(author.id, { id: moduleId, revision: saved.revision, isShared: true, requestId: randomUUID() });
    const presetId = published.sourcePresetId!;
    const output = async (id: string, taskModule: string | null = null, source: string | null = null, owner = author.id) => {
      const assetId = `asset-${id}`;
      await prisma.asset.create({ data: { id: assetId, owner_id: owner, type: 'image', original_url: `/fixture/${id}.png`,
        file_name: `${id}.png`, mime_type: 'image/png', file_size: 32, width: 4, height: 4 } });
      return prisma.imageStudioTask.create({ data: { id, batch_id: id, owner_id: owner, module_id: taskModule, source_preset_id: source,
        ordinal: 1, fingerprint: createHash('sha256').update(id).digest('hex'), prompt: 'synthetic-private-prompt', context: '',
        revision: 1, model: 'fixture', reference_ids: '[]', unit_credits: 1, status: 'succeeded', asset_id: assetId } });
    };
    const legacy = await output('legacy-default');
    const command = { viewerId: author.id, moduleId, taskId: legacy.id, assetId: legacy.asset_id!, active: true,
      expectedRevision: 0, requestId: randomUUID() };
    const original = await mutateStudioPin(author, command);
    assert.equal(original.revision, 1);
    assert.equal((await mutateStudioPin(author, command)).replayed, true);
    assert.equal((await prisma.imageStudioTask.findUniqueOrThrow({ where: { id: legacy.id } })).module_id, null);
    for (const user of [author, colleague]) assert.deepEqual((await readableStudioPins(user, presetId))?.pins.map(pin => pin.taskId), [legacy.id]);
    assert.equal(await readableStudioPins({ ...colleague, feishu: undefined }, presetId), null);
    assert.equal((await resolveStudioPinnedAsset(colleague, legacy.asset_id!))?.asset.id, legacy.asset_id);
    checks.push('null-module default result pins, replays original receipt and stays readable without rewriting the task');

    await assert.rejects(openSharedStudioModule(colleague, presetId, randomUUID()), { status: 409 });
    const live = await openSharedStudioModule(colleague, presetId, randomUUID(), undefined, { explicitSelection: true });
    const shared = await listStudioResultFeed(colleague, live.id);
    assert.equal(shared.sharedPins.length, 1);
    assert.ok(!JSON.stringify(shared).includes('synthetic-private-prompt'));
    checks.push('colleague feed and pinned media resolve output only, without private prompt projection');

    const definition = await resolveSharedStudioDefinition(author, presetId);
    const draftId = await prisma.$transaction(tx => prepareSharedStudioMethodWorkspace(author, presetId,
      definition.definition.sourceRevision, definition.definition.intent.definitionToken, tx, {}));
    const second = await output('legacy-default-from-method');
    const before = await listStudioResultFeed(author, draftId);
    assert.ok(before.tasks.some(task => task.id === second.id));
    assert.equal(before.pinTaskReasons[second.id], null);
    await mutateStudioPin(author, { ...command, moduleId: draftId, taskId: second.id, assetId: second.asset_id!,
      expectedRevision: 1, requestId: randomUUID() });
    assert.ok((await readableStudioPins(colleague, presetId))?.pins.some(pin => pin.taskId === second.id && pin.moduleId === moduleId));
    checks.push('verified method workspace uses original default history for listing, pinning and later reading');

    const wrongSource = await output('wrong-source', moduleId, 'another-template');
    const noSource = await output('colleague-unproven-source', live.id, null, colleague.id);
    await assert.rejects(mutateStudioPin(author, { ...command, taskId: wrongSource.id, assetId: wrongSource.asset_id!, expectedRevision: 2,
      requestId: randomUUID() }), { status: 403 });
    await assert.rejects(mutateStudioPin(colleague, { ...command, viewerId: colleague.id, moduleId: live.id, taskId: noSource.id,
      assetId: noSource.asset_id!, expectedRevision: 2, requestId: randomUUID() }), { status: 403 });
    await assert.rejects(mutateStudioPin(colleague, { ...command, viewerId: colleague.id, moduleId: live.id,
      expectedRevision: 2, requestId: randomUUID() }), { status: 403 });
    const sourceFeed = await listStudioResultFeed(author, moduleId);
    assert.match(sourceFeed.pinTaskReasons[wrongSource.id] || '', /来自其他模板/);
    checks.push('other owner, mismatched source and unproven colleague legacy source remain rejected and explained');

    const protectedTask = await output('protected-reference', moduleId, presetId);
    await prisma.platformSetting.create({ data: { key: 'studio_fixed_references_v1:pin-fixture-protected', value_json: JSON.stringify({
      ownerId: author.id, references: [{ assetId: protectedTask.asset_id }] }) } });
    await assert.rejects(mutateStudioPin(author, { ...command, taskId: protectedTask.id, assetId: protectedTask.asset_id!,
      expectedRevision: 2, requestId: randomUUID() }), (error: unknown) => error instanceof Error && /受保护参考素材/.test(error.message));
    const avatar = await output('avatar-default');
    await prisma.imageStudioTask.update({ where: { id: avatar.id }, data: { snapshot_json: '{"avatar":{}}' } });
    assert.ok(!(await listStudioResultFeed(author, draftId)).tasks.some(task => task.id === avatar.id));
    await assert.rejects(mutateStudioPin(author, { ...command, moduleId: draftId, taskId: avatar.id, assetId: avatar.asset_id!,
      expectedRevision: 2, requestId: randomUUID() }), { status: 403 });
    checks.push('protected reference and avatar task cannot be published through the historical-default path');

    await prisma.asset.update({ where: { id: legacy.asset_id! }, data: { status: 'inactive' } });
    await mutateStudioPin(author, { ...command, active: false, expectedRevision: 2, requestId: randomUUID() });
    assert.equal((await readableStudioPins(colleague, presetId))?.pins.length, 1);
    await assert.rejects(mutateStudioPin(author, { ...command, taskId: second.id, assetId: second.asset_id!, active: false,
      expectedRevision: 2, requestId: randomUUID() }), { status: 409 });
    const origin = await output('original-reproduction-source', 'original-workspace', 'another-template');
    const reproduced = await output('same-workspace-reproduction', moduleId, 'another-template');
    const frozen = JSON.stringify({ version: 1, moduleId, sourcePresetId: 'another-template', reproducedFromTaskId: origin.id, moduleContext: 'private-reproduction-context' });
    await prisma.imageStudioTask.update({ where: { id: reproduced.id }, data: { snapshot_json: frozen } });
    assert.equal((await listStudioResultFeed(author, moduleId)).pinTaskReasons[reproduced.id], null);
    const reproduceCommand = { ...command, taskId: reproduced.id, assetId: reproduced.asset_id!, expectedRevision: 3, requestId: randomUUID() };
    await mutateStudioPin(author, reproduceCommand);
    assert.equal((await mutateStudioPin(author, reproduceCommand)).replayed, true);
    assert.ok((await readableStudioPins(colleague, presetId))?.pins.some(pin => pin.taskId === reproduced.id));
    assert.equal((await resolveStudioPinnedAsset(colleague, reproduced.asset_id!))?.asset.id, reproduced.asset_id);
    const projected = (await readableStudioPins(colleague, presetId))!.pins.find(pin => pin.taskId === reproduced.id)!;
    assert.ok(!('snapshot_json' in projected.task));
    assert.ok(!JSON.stringify(await listStudioResultFeed(colleague, live.id)).includes('private-reproduction-context'));
    const retained = await prisma.imageStudioTask.findUniqueOrThrow({ where: { id: reproduced.id } });
    assert.equal(retained.source_preset_id, 'another-template');
    assert.equal(retained.snapshot_json, frozen);
    checks.push('same-workspace historical reproduction can pin and replay; colleague reads output while original source and snapshot stay frozen');

    // The reported task ran in an older named workspace with no publisher binding.
    const legacyPresetId = randomUUID(), legacyWorkspaceId = randomUUID();
    await prisma.imageStudioPreset.create({ data: { id: legacyPresetId, owner_id: author.id, scope: 'creator',
      is_shared: true, name: 'Legacy nine grid', model: 'fixture' } });
    await prisma.imageStudioModule.create({ data: { id: legacyWorkspaceId, owner_id: author.id, name: 'Legacy nine grid',
      source_preset_id: legacyPresetId } });
    const reported = await output('reported-reproduction-shape', legacyWorkspaceId, 'another-template');
    await prisma.imageStudioTask.update({ where: { id: reported.id }, data: { snapshot_json: JSON.stringify({ version: 1,
      moduleId: legacyWorkspaceId, sourcePresetId: 'another-template', reproducedFromTaskId: origin.id }) } });
    assert.equal((await listStudioResultFeed(author, legacyWorkspaceId)).pinTaskReasons[reported.id], null);
    await mutateStudioPin(author, { ...command, moduleId: legacyWorkspaceId, taskId: reported.id, assetId: reported.asset_id!,
      expectedRevision: 0, requestId: randomUUID() });
    assert.ok((await readableStudioPins(colleague, legacyPresetId))?.pins.some(pin => pin.taskId === reported.id));
    checks.push('reported legacy named-workspace shape without a publisher binding pins under its execution template');

    const invalidReproduction = await output('invalid-reproduction', moduleId, 'another-template');
    for (const invalid of [{ version: 1, moduleId: 'unrelated-workspace', sourcePresetId: 'another-template', reproducedFromTaskId: origin.id },
      { version: 1, moduleId, sourcePresetId: 'forged-source', reproducedFromTaskId: origin.id },
      { version: 1, moduleId, sourcePresetId: 'another-template', reproducedFromTaskId: invalidReproduction.id },
      { version: 1, moduleId, sourcePresetId: 'another-template' }]) {
      await prisma.imageStudioTask.update({ where: { id: invalidReproduction.id }, data: { snapshot_json: JSON.stringify(invalid) } });
      await assert.rejects(mutateStudioPin(author, { ...reproduceCommand, taskId: invalidReproduction.id,
        assetId: invalidReproduction.asset_id!, expectedRevision: 4, requestId: randomUUID() }), { status: 403 });
    }
    const outside = await output('other-workspace-reproduction', 'unrelated-workspace', presetId);
    await prisma.imageStudioTask.update({ where: { id: outside.id }, data: { snapshot_json: JSON.stringify({ version: 1,
      moduleId: outside.module_id, sourcePresetId: presetId, reproducedFromTaskId: origin.id }) } });
    await assert.rejects(mutateStudioPin(author, { ...reproduceCommand, taskId: outside.id, assetId: outside.asset_id!,
      expectedRevision: 4, requestId: randomUUID() }), { status: 403 });
    await prisma.platformSetting.create({ data: { key: 'studio_fixed_references_v1:reproduction-protected', value_json: JSON.stringify({
      ownerId: author.id, references: [{ assetId: reproduced.asset_id }] }) } });
    await assert.rejects(mutateStudioPin(author, { ...reproduceCommand, expectedRevision: 4, requestId: randomUUID() }),
      (error: unknown) => error instanceof Error && /受保护参考素材/.test(error.message));
    assert.ok(!(await readableStudioPins(colleague, presetId))?.pins.some(pin => pin.taskId === reproduced.id));
    checks.push('unproven, inconsistent, self-referencing, other-workspace and protected reproductions stay blocked; private media revocation stays effective');
    assert.equal(networkCalls, 0);
    assert.equal(await prisma.creditLedger.count(), 0);
    checks.push('hidden own result can unpin; stale revision fails; no generation, network or billing writes');
    console.log(JSON.stringify({ ok: true, count: checks.length, checks, networkCalls, productionWrites: 0 }, null, 2));
  } finally { globalThis.fetch = oldFetch; await prisma.$disconnect(); await rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
