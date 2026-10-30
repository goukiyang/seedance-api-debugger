import assert from 'node:assert/strict';
import { Prisma, type PrismaClient } from '@prisma/client';
import { galleryDirectorySql } from '../src/lib/image-studio/gallery-directory-sql';
import { queryStudioGallery } from '../src/lib/image-studio/gallery';
import { sharedCommandFingerprint } from '../src/lib/image-studio/shared-command-storage';

export async function verifyGalleryDirectory(db: PrismaClient) {
  const owner = 'catalog-writer-fixture', other = 'catalog-gallery-publisher';
  await db.user.create({ data: { id: other, username: other, email: `${other}@example.invalid`, name: 'Publisher', password_hash: 'not-a-password', account_type: 'internal', role: 'admin' } });
  const actor = { id: owner, role: 'admin', account_type: 'internal' };
  const presets = [];
  for (let index = 0; index < 39; index++) {
    const id = `gallery-preset-${index}`;
    presets.push({ id, owner_id: index % 3 ? other : owner, scope: 'creator', name: `Gallery ${index}`,
      model: index === 4 ? 'unsupported-fixture-model' : 'gpt-image-2', group_name: index % 2 ? 'Group A' : 'Group B', is_shared: index !== 3,
      created_at: new Date(1700000000000 + index * 1000), updated_at: new Date(1700000000000 + (39 - index) * 1000) });
  }
  await db.imageStudioPreset.createMany({ data: presets });
  const module = '44444444-4444-4444-8444-444444444444';
  await db.imageStudioModule.create({ data: { id: module, owner_id: owner, name: 'Local copy', source_preset_id: 'gallery-preset-1' } });
  await db.platformSetting.create({ data: { key: `studio_shared_binding_v1:${module}`, value_json: JSON.stringify({ protocol: 'shared-live-v1', ownerId: owner, mode: 'live', presetId: 'gallery-preset-1' }) } });
  const second = '55555555-5555-4555-8555-555555555555';
  await db.imageStudioModule.create({ data: { id: second, owner_id: owner, name: 'Duplicate copy', source_preset_id: 'gallery-preset-1' } });
  await db.platformSetting.create({ data: { key: `studio_shared_binding_v1:${second}`, value_json: JSON.stringify({ protocol: 'shared-live-v1', ownerId: owner, mode: 'live', presetId: 'gallery-preset-1' }) } });
  await db.platformSetting.create({ data: { key: 'studio_preset_archived_v1:gallery-preset-2', value_json: '{}' } });
  await db.contentReaction.create({ data: { user_id: owner, content_key: 'image_template:gallery-preset-5', category: 'image_template', liked: true, favorited: true } });
  let comparisons = 0;
  for (const sort of ['created', 'updated', 'likes', 'recent', 'directory'] as const) for (const scope of ['all', 'mine', 'shared', 'favorites'] as const) {
    const query = { sort, scope, page: 2, pageSize: 12, navigationOnly: true,
      recentHints: { 'image_template:gallery-preset-8': 1000 }, directoryOrder: { groups: ['Group B'], entries: ['preset:gallery-preset-9'] } };
    const original = await queryStudioGallery(actor, query), sql = await galleryDirectorySql(db, actor, query);
    const counts = await db.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`WITH ${sql.ctes} SELECT count(*) AS total FROM filtered`);
    assert.equal(Number(counts[0].total), original.total);
    const rows = await sql.rows(original.page, 12);
    assert.deepEqual(rows.map(row => row.key), original.matches.slice((original.page - 1) * 12, original.page * 12).map(row => row.key), `${sort}/${scope}`);
    comparisons++;
  }
  const authorQuery = { authorKey: `author:${sharedCommandFingerprint(other)}`, query: 'Publisher', navigationOnly: true, sort: 'created' as const };
  const original = await queryStudioGallery(actor, authorQuery), sql = await galleryDirectorySql(db, actor, authorQuery);
  const rows = await sql.rows(1, 24); assert.deepEqual(rows.map(row => row.key), original.matches.slice(0, 24).map(row => row.key));
  const { readGalleryPage } = await import('../src/lib/image-studio/gallery-page');
  const page = await readGalleryPage(db, actor, { protocol: 'catalog-paged-v2', sort: 'created', page: 2, pageSize: 12, navigationPage: 2 });
  assert.equal(page.protocol, 'catalog-paged-v2'); assert.equal(page.items.length, 12); assert.ok(page.navigation.length <= 24);
  const reference = await queryStudioGallery(actor, { sort: 'created', page: 2, pageSize: 12 });
  assert.deepEqual(page.items, reference.items);
  await db.user.update({ where: { id: other }, data: { name: 'Updated Publisher' } });
  await assert.rejects(readGalleryPage(db, actor, { sort: 'created', page: 2, pageSize: 12, catalogRevision: page.catalogRevision }), /目录已变化/);
  return { comparisons, exactCounts: true, canonicalDuplicateWinner: true, authorSearch: true, maximumPage: 24, realPageProjection: true, revisionInvalidatedByUser: true };
}
