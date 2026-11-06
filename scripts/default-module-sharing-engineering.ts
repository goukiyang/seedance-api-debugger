import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const sourceRoot = process.cwd();
  const run = await mkdtemp(path.join(os.tmpdir(), 'sd2-default-sharing-'));
  Object.assign(process.env, { NODE_ENV: 'test' });
  process.env.DATABASE_URL = `file:${run}/fixture.sqlite`;
  for (const key of Object.keys(process.env).filter(key => key.startsWith('PRIVATE_PROMPTS_'))) delete process.env[key];
  const schema = spawnSync(process.execPath, [path.join(sourceRoot, 'node_modules/prisma/build/index.js'),
    'db', 'push', '--skip-generate', '--schema', path.join(sourceRoot, 'prisma/schema.prisma')],
  { env: process.env, encoding: 'utf8', timeout: 120000 });
  assert.equal(schema.status, 0, schema.stderr);
  const oldFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('Fixture must stay offline'); };
  const { prisma } = await import('../src/lib/prisma');
  const { saveStudioModule, studioModuleDTOForUser, chooseStudioModuleSharing, shareSavedStudioModule } = await import('../src/lib/image-studio/modules');
  const { queryStudioGallery } = await import('../src/lib/image-studio/gallery');
  const { setStudioPresetSharing } = await import('../src/lib/image-studio/presets');
  const { canViewStudioPreset } = await import('../src/lib/image-studio/access');
  const checks: string[] = [];
  try {
    for (const id of ['author', 'other']) await prisma.user.create({ data: {
      id, name: id, username: id, email: `${id}@fixture.invalid`, password_hash: 'fixture-only',
      role: 'admin', account_type: 'internal',
    } });
    const author = { id: 'author', role: 'admin', account_type: 'internal' };
    const other = { id: 'other', role: 'admin', account_type: 'internal' };
    const id = 'default-author';
    await prisma.imageStudioModule.create({ data: { id, owner_id: author.id, name: '模块 1', context: 'fixture context' } });
    const saved = await saveStudioModule(author.id, { id, revision: 0, name: '过度帧', prompt: '', count: 1, referenceIds: [], context: 'fixture context', aspectRatio: 'auto' });
    assert.ok('canChooseSharing' in saved && 'sharingPreference' in saved);
    assert.equal(saved.canChooseSharing, true);
    assert.equal(saved.sharingPreference, null);
    assert.equal(saved.sourcePresetId, null);
    assert.equal(await prisma.imageStudioPreset.count(), 0);
    checks.push('saving_a_named_default_exposes_sharing_without_publishing');

    await assert.rejects(() => chooseStudioModuleSharing(other.id,
      { id, revision: saved.revision, isShared: true, requestId: randomUUID() }));
    await assert.rejects(() => chooseStudioModuleSharing(author.id,
      { id: 'default-other', revision: saved.revision, isShared: true, requestId: randomUUID() }));
    checks.push('another_account_cannot_choose_sharing_for_the_default');

    const preferenceRequest = { id, revision: saved.revision, isShared: true, requestId: randomUUID() };
    const chosen = await chooseStudioModuleSharing(author.id, preferenceRequest);
    assert.ok('sharingPreference' in chosen);
    assert.equal(chosen.sharingPreference?.enabled, true);
    assert.equal(chosen.sourcePresetId, null);
    assert.equal(await prisma.imageStudioPreset.count(), 0);
    assert.equal((await chooseStudioModuleSharing(author.id, preferenceRequest)).revision, chosen.revision);
    checks.push('explicit_preference_is_durable_and_replay_does_not_publish');
    const selectedGallery = await queryStudioGallery(author, { pageSize: 12 });
    const selectedCard = selectedGallery.items.find(item => item.id === id)!;
    assert.equal(selectedCard.shared, false);
    assert.deepEqual(selectedCard.sharing, { kind: 'module', id, selected: true, revision: chosen.revision });
    assert.equal(JSON.stringify(selectedCard.sharing).includes('context'), false);
    checks.push('unpublished_cover_projects_preference_without_claiming_shared_or_exposing_definition');

    await assert.rejects(() => chooseStudioModuleSharing(author.id,
      { ...preferenceRequest, isShared: false, requestId: randomUUID() }), error => (error as { status: number }).status === 409);
    const publication = { id, revision: chosen.revision, saveIntent: 'definition', isShared: true,
      sharingPreferenceRevision: chosen.sharingPreference!.revision, requestId: randomUUID() };
    await assert.rejects(() => saveStudioModule(author.id, { ...publication, requestId: randomUUID(), revision: saved.revision }),
      error => (error as { status: number }).status === 409);
    assert.equal(await prisma.imageStudioPreset.count(), 0);
    checks.push('stale_preference_and_publication_revisions_remain_rejected');

    const published = await saveStudioModule(author.id, publication);
    assert.equal(published.sourcePresetId, `module-source:${id}`);
    assert.equal(published.sourcePresetCanManageSharing, true);
    assert.equal(published.sourcePresetShared, true);
    const source = await prisma.imageStudioPreset.findUniqueOrThrow({ where: { id: published.sourcePresetId! } });
    assert.equal(source.owner_id, author.id);
    assert.equal(source.name, '过度帧');
    assert.equal(canViewStudioPreset(other, source), true);
    assert.equal((await prisma.imageStudioModule.findUniqueOrThrow({ where: { id } })).context, 'fixture context');
    assert.equal((await saveStudioModule(author.id, publication)).revision, published.revision);
    assert.equal(await prisma.imageStudioPreset.count(), 1);
    checks.push('normal_save_publishes_once_and_preserves_the_default_workspace');
    const publishedGallery = await queryStudioGallery(author, { pageSize: 12 });
    assert.deepEqual(publishedGallery.items.find(item => item.id === id)!.sharing,
      { kind: 'preset', id: source.id, shared: true, revision: source.updated_at.toISOString() });
    const colleagueGallery = await queryStudioGallery(other, { pageSize: 12 });
    assert.equal(colleagueGallery.items.find(item => item.presetId === source.id)!.sharing, undefined);
    checks.push('published_cover_uses_source_revision_and_colleague_cannot_toggle_it');

    await assert.rejects(() => setStudioPresetSharing(other, source.id, false, source.updated_at.toISOString(), randomUUID()));
    await setStudioPresetSharing(author, source.id, false, source.updated_at.toISOString(), randomUUID());
    const withdrawn = await prisma.imageStudioPreset.findUniqueOrThrow({ where: { id: source.id } });
    assert.equal(withdrawn.is_shared, false);
    assert.equal(canViewStudioPreset(other, withdrawn), false);
    const after = await studioModuleDTOForUser(author, id);
    assert.equal(after.sourcePresetCanManageSharing, true);
    assert.equal(after.sourcePresetShared, false);
    checks.push('only_the_author_can_withdraw_and_current_source_access_tracks_it');

    await prisma.imageStudioModule.create({ data: { id: 'default-other', owner_id: other.id, name: '未命名模块' } });
    await assert.rejects(() => saveStudioModule(other.id, {
      id: 'default-other', revision: 0, saveIntent: 'definition', isShared: true, requestId: randomUUID(),
    }), error => (error as Error).message.includes('名称'));
    assert.equal(await prisma.imageStudioPreset.count(), 1);
    checks.push('unnamed_default_cannot_be_published');

    const copyId = randomUUID();
    await prisma.imageStudioModule.create({ data: { id: copyId, owner_id: other.id, name: 'legacy copy', source_preset_id: source.id } });
    await assert.rejects(() => studioModuleDTOForUser(other, copyId), error => (error as { status: number }).status === 403);
    await assert.rejects(() => chooseStudioModuleSharing(other.id,
      { id: copyId, revision: 0, isShared: true, requestId: randomUUID() }));
    checks.push('legacy_copies_cannot_share_a_foreign_definition');
    const copyGallery = await queryStudioGallery(other, { pageSize: 12 });
    assert.equal(copyGallery.items.find(item => item.id === copyId)!.sharing, undefined);
    checks.push('foreign_legacy_copy_does_not_receive_cover_sharing_capability');

    const regularId = randomUUID();
    await prisma.imageStudioModule.create({ data: { id: regularId, owner_id: other.id, name: 'regular template' } });
    const regular = await studioModuleDTOForUser(other, regularId);
    assert.ok('canChooseSharing' in regular);
    assert.equal(regular.canChooseSharing, true);
    const privateChoice = await chooseStudioModuleSharing(other.id,
      { id: regularId, revision: 0, isShared: false, requestId: randomUUID() });
    assert.ok('sharingPreference' in privateChoice);
    assert.equal(privateChoice.sharingPreference?.enabled, false);
    checks.push('regular_template_controls_remain_available');
    await prisma.asset.create({ data: { id: 'personal-image', owner_id: other.id, type: 'image',
      original_url: '/uploads/assets/fixture.png', file_name: 'fixture.png', mime_type: 'image/png', file_size: 100 } });
    await prisma.imageStudioModule.update({ where: { id: regularId }, data: {
      prompt: 'personal supplement stays private', context: 'saved template context', reference_ids: '["personal-image"]',
    } });
    const command = { id: regularId, revision: privateChoice.revision, isShared: true, requestId: randomUUID() };
    await assert.rejects(() => shareSavedStudioModule(author.id, command), error => [403, 404].includes((error as { status: number }).status));
    await assert.rejects(() => shareSavedStudioModule(other.id, { ...command, revision: command.revision - 1, requestId: randomUUID() }),
      error => (error as { status: number }).status === 409);
    checks.push('immediate_publication_keeps_owner_and_revision_protection');
    const immediate = await shareSavedStudioModule(other.id, { ...command, prompt: 'must not publish client draft', context: 'unsaved context', referenceIds: ['personal-image'] });
    const immediateSource = await prisma.imageStudioPreset.findUniqueOrThrow({ where: { id: immediate.sourcePresetId! } });
    assert.equal(immediateSource.is_shared, true);
    assert.equal(immediateSource.context, 'saved template context');
    assert.equal(immediateSource.prompt, '');
    assert.equal(immediateSource.reference_ids, '[]');
    assert.equal(immediate.prompt, 'personal supplement stays private');
    assert.deepEqual(immediate.images.map(image => image.id), ['personal-image']);
    assert.equal(immediate.sharingCommandReceipt.action, 'share-saved-module');
    assert.equal(canViewStudioPreset(author, immediateSource), true);
    checks.push('one_command_publishes_saved_definition_without_personal_or_unsaved_inputs');
    const replay = await shareSavedStudioModule(other.id, command);
    assert.equal(replay.revision, immediate.revision);
    assert.equal(replay.sourcePresetId, immediate.sourcePresetId);
    assert.equal(await prisma.imageStudioPreset.count(), 2);
    await assert.rejects(() => shareSavedStudioModule(other.id, { ...command, revision: replay.revision, requestId: randomUUID() }),
      error => (error as { status: number }).status === 409);
    checks.push('lost_response_replay_returns_original_publication_without_overwriting');
    await setStudioPresetSharing(other, immediateSource.id, false, immediateSource.updated_at.toISOString(), randomUUID());
    const withdrawnReplay = await shareSavedStudioModule(other.id, command);
    assert.equal(withdrawnReplay.sourcePresetShared, false);
    assert.equal((await prisma.imageStudioPreset.findUniqueOrThrow({ where: { id: immediateSource.id } })).is_shared, false);
    checks.push('original_publication_replay_cannot_reshare_after_withdrawal');
    await assert.rejects(() => shareSavedStudioModule(other.id, {
      id: 'default-other', revision: 0, isShared: true, requestId: randomUUID(),
    }), error => (error as Error).message.includes('名称'));
    checks.push('immediate_switch_also_rejects_unnamed_default');
    await prisma.imageStudioModule.update({ where: { id: 'default-other' }, data: { name: '过度帧', context: 'default saved context' } });
    const directDefault = await shareSavedStudioModule(other.id, {
      id: 'default-other', revision: 0, isShared: true, requestId: randomUUID(),
    });
    assert.equal(directDefault.sourcePresetId, 'module-source:default-other');
    assert.equal(directDefault.sourcePresetShared, true);
    assert.equal(directDefault.sourcePresetCanManageSharing, true);
    assert.equal((await queryStudioGallery(author, { pageSize: 12 })).items.some(item => item.presetId === directDefault.sourcePresetId), true);
    checks.push('default_module_publishes_directly_and_appears_in_colleague_gallery');
    assert.equal(networkCalls, 0);
    assert.equal(await prisma.imageStudioTask.count(), 0);
    console.log(JSON.stringify({ passed: checks.length, checks, networkCalls, generatedTasks: 0 }));
  } finally {
    globalThis.fetch = oldFetch;
    await prisma.$disconnect();
    await rm(run, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
