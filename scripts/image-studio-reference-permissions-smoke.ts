import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { prisma } from '../src/lib/prisma';
import { canReadStudioAsset, studioHiddenAssetUrls, studioVisibleReferenceWhere } from '../src/lib/image-studio/protected-assets';
import { assertCanViewReferenceImage, canUseDirectAsset } from '../src/lib/reference-albums/permissions';
import type { SessionUser } from '../src/lib/auth/session';
import { canManageStudioStyle, deleteStudioStyleGroup, getStudioStyleGroup, listStudioStyleGroups, saveStudioStyleGroup, studioStyleDTO } from '../src/lib/image-studio/style-groups';
import { applyStudioPreset, saveStudioPreset, setStudioPresetSharing } from '../src/lib/image-studio/presets';
import { listStudioModules, saveStudioModule } from '../src/lib/image-studio/modules';
import { listStudioTasks, submitStudioBatch } from '../src/lib/image-studio/tasks';
import { processStudioTask } from '../src/lib/image-studio/worker';
import { getImageStudioSettings, IMAGE_STUDIO_MODELS, saveImageStudioSettings } from '../src/lib/image-studio/settings';
import { BANANA_IMAGE_API_SETTING_KEY, IMAGE_GENERATION_API_SETTING_KEY } from '../src/lib/integrations/image-generation';

async function main() {
  if (!process.env.DATABASE_URL?.startsWith('file:/tmp/sd2-image-studio-test-')) throw new Error('Isolated test database required');
  const originalDirectory = process.cwd();
  const directory = await fs.mkdtemp('/tmp/sd2-image-studio-test-media-');
  const tenant = 'permission-fixture';
  process.env.FEISHU_ALLOWED_TENANT_KEY = tenant;
  async function user(role = 'user', account_type = 'internal') {
    const id = randomUUID();
    return prisma.user.create({ data: { id, username: id, email: `${id}@example.invalid`, name: 'Permission fixture',
      password_hash: 'not-a-password', role, account_type, feishu_user_id: id, feishu_tenant_key: tenant } });
  }
  try {
    process.chdir(directory);
    await fs.mkdir(path.join(directory, 'public/uploads'), { recursive: true });
    const admin = await user('admin');
    const creator = await user();
    const member = await user();
    const external = await user('admin', 'external');
    const asset = async (owner_id: string, name: string) => {
      const original_url = `/uploads/${name}.png`;
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#278754' } }).png().toFile(path.join(directory, 'public', original_url));
      return prisma.asset.create({ data: { owner_id, type: 'image', original_url, file_name: `${name}.png`, mime_type: 'image/png', file_size: 100, width: 8, height: 8 } });
    }
    const fixed = await asset(admin.id, 'admin-template');
    const style = await asset(creator.id, 'creator-style');
    const transient = await asset(member.id, 'member-reference');
    const group = await saveStudioStyleGroup(creator, { name: 'Fixture style', references: [{ assetId: style.id, note: 'private-style-note' }] });
    const rawGroup = await getStudioStyleGroup(member, group.id);
    assert.equal(canManageStudioStyle(member, rawGroup), false);
    assert.equal(canManageStudioStyle(creator, rawGroup), true);
    assert.equal(canManageStudioStyle(admin, rawGroup), true);
    const summary = await studioStyleDTO(member, rawGroup);
    assert.ok(summary.coverUrl && summary.referenceCount === 1);
    assert.equal('references' in summary, false);
    assert.equal('coverAssetId' in summary, false);
    assert.ok(!JSON.stringify(summary).includes(style.id));
    assert.equal((await studioStyleDTO(creator, rawGroup)).references?.[0].note, 'private-style-note');
    assert.equal((await studioStyleDTO(admin, rawGroup)).references?.[0].id, style.id);
    await assert.rejects(listStudioStyleGroups(external));
    await assert.rejects(saveStudioStyleGroup(member, { id: group.id, revision: group.revision, name: 'Steal', references: [{ assetId: style.id }] }));
    await assert.rejects(saveStudioStyleGroup(member, { name: 'Steal by merge', references: [], mergeIds: [group.id] }));
    await assert.rejects(deleteStudioStyleGroup(member, group.id, group.revision));
    const edited = await saveStudioStyleGroup(creator, { id: group.id, revision: group.revision, name: 'Edited style', references: [{ assetId: style.id, note: 'edited-private-note' }] });
    await assert.rejects(saveStudioStyleGroup(creator, { id: group.id, revision: group.revision, name: 'Stale', references: [{ assetId: style.id }] }));
    const merged = await saveStudioStyleGroup(creator, { name: 'Merged style', references: [], mergeIds: [group.id] });
    assert.equal((await getStudioStyleGroup(creator, merged.id)).references[0].note, 'edited-private-note');
    assert.equal((await getStudioStyleGroup(creator, group.id)).revision, edited.revision);
    const preset = await saveStudioPreset(admin, { scope: 'admin', name: 'Hidden template', model: IMAGE_STUDIO_MODELS[0], count: 1,
      aspectRatio: 'auto', referenceIds: [], context: 'Private template context', fixedReferences: [{ assetId: fixed.id, note: 'private-template-note' }], styleGroupIds: [group.id] });
    await setStudioPresetSharing(admin, preset.id, true);
    const countBefore = await prisma.asset.count({ where: { owner_id: member.id } });
    const module = await applyStudioPreset(member, preset.id);
    assert.equal(await prisma.asset.count({ where: { owner_id: member.id } }), countBefore, 'applying hidden references must not clone their assets');
    assert.deepEqual(module.fixedReferences, []);
    assert.equal(module.fixedReferenceCount, 1);
    assert.deepEqual(module.styleGroupIds, [group.id]);
    assert.equal('references' in module.styleGroups[0], false);
    const reloaded = await listStudioModules(member.id, undefined, false, [module.id], member);
    assert.deepEqual(reloaded.modules.find(item => item.id === module.id)?.styleGroupIds, [group.id]);
    await assert.rejects(saveStudioModule(member.id, { id: module.id, revision: module.revision, fixedReferences: [] }, false, false, undefined, member));
    assert.equal(await canReadStudioAsset(member, fixed), false);
    assert.equal(await canReadStudioAsset(member, style), false);
    assert.equal(await canReadStudioAsset(creator, style), true);
    assert.equal(await canReadStudioAsset(admin, fixed), true);
    const legacy = await prisma.asset.create({ data: { owner_id: member.id, type: 'image', original_url: fixed.original_url, file_name: 'legacy.png', mime_type: 'image/png', file_size: 100 } });
    assert.equal(await canReadStudioAsset(member, legacy), false, 'legacy copied rows cannot bypass file protection');
    assert.ok((await studioHiddenAssetUrls(null)).includes(fixed.original_url));
    const album = await prisma.referenceAlbum.create({ data: { owner_user_id: member.id, name: 'Legacy fixture album' } });
    const albumImage = await prisma.referenceImage.create({ data: { album_id: album.id, owner_user_id: member.id, asset_id: legacy.id, url: `https://sd2.youdooart.com${fixed.original_url}` } });
    const session = { ...member, role: 'user', account_type: 'internal', status: 'active' } as SessionUser;
    assert.equal(await canUseDirectAsset(session, legacy.id), false);
    await assert.rejects(assertCanViewReferenceImage(session, albumImage.id));
    assert.equal(await prisma.referenceImage.count({ where: { album_id: album.id, AND: [await studioVisibleReferenceWhere(member)] } }), 0);
    const settings = await getImageStudioSettings();
    await saveImageStudioSettings({ ...settings, prices: Object.fromEntries(IMAGE_STUDIO_MODELS.map(model => [model, 0])) as typeof settings.prices }, admin.id);
    for (const key of [IMAGE_GENERATION_API_SETTING_KEY, BANANA_IMAGE_API_SETTING_KEY]) {
      await prisma.platformSetting.upsert({ where: { key }, update: {}, create: { key, updated_by: admin.id,
        value_json: JSON.stringify({ enabled: true, provider: 'musk', base_url: 'https://example.invalid/', api_key: 'test-only', default_model: IMAGE_STUDIO_MODELS[0] }) } });
    }
    const submit = async (reproduceFromTaskId?: string, referenceIds = [transient.id]) => {
      return submitStudioBatch(member.id, { requestId: randomUUID(), prompt: 'Permission fixture', count: 1,
        revision: (await getImageStudioSettings()).revision, moduleId: module.id, moduleRevision: module.revision, referenceIds, reproduceFromTaskId });
    }
    await assert.rejects(submit(undefined, [legacy.id]));
    const batch = await submit();
    const task = await prisma.imageStudioTask.findFirstOrThrow({ where: { batch_id: batch } });
    assert.deepEqual(JSON.parse(task.reference_ids), [fixed.id, style.id, transient.id]);
    assert.ok(task.context.includes('模板A') && task.context.includes('风格1') && task.context.includes('图 1'));
    assert.ok(task.context.includes('private-template-note') && task.context.includes('edited-private-note'));
    const publicTasks = await listStudioTasks(member.id, undefined, module.id, false);
    const publicTask = publicTasks.tasks.find(item => item.id === task.id)!;
    assert.deepEqual(publicTask.referenceIds, [transient.id]);
    assert.deepEqual(publicTask.snapshot.fixedReferenceImages, []);
    assert.equal(publicTask.snapshot.fixedReferenceCount, 2);
    assert.ok(!JSON.stringify(publicTask).includes(fixed.id) && !JSON.stringify(publicTask).includes('edited-private-note'));
    let delivered = false;
    await processStudioTask(async input => {
      assert.equal(input.images.length, 3);
      assert.ok(input.images.every(image => image.bytes.length > 0));
      assert.ok(input.prompt.includes('private-template-note') && input.prompt.includes('edited-private-note'));
      delivered = true;
      throw new Error('Fixture stops before any external generation or output write');
    });
    assert.equal(delivered, true, 'hidden bytes must reach the server-side generator adapter');
    const replay = await submit(task.id);
    assert.ok(replay);
    await deleteStudioStyleGroup(creator, group.id, edited.revision);
    await assert.rejects(submit(task.id));
    assert.equal(await prisma.asset.count({ where: { id: { in: [fixed.id, style.id] } } }), 2);
    assert.equal(await canReadStudioAsset(member, style), false, 'deleted group must not expose historical files');
    console.log('PASS: admin/creator/member/external permissions, safe DTOs, legacy copies, selection persistence, ownership, revisions, merge/delete, hidden generator inputs and historical access. No real generation or production writes.');
  } finally {
    process.chdir(originalDirectory);
    await prisma.$disconnect();
    await fs.rm(directory, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
