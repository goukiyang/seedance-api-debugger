import assert from 'node:assert/strict';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { SessionUser } from '../src/lib/auth/session';
import { initializeCatalogRevisions, readCatalogRevision } from '../src/lib/image-studio/catalog-revision';

export async function verifyDirectoryWriterTransactions(db: PrismaClient) {
  const owner = 'catalog-writer-fixture', moduleId = '22222222-2222-4222-8222-222222222222';
  await db.user.create({ data: { id: owner, username: owner, email: `${owner}@example.invalid`, name: 'Directory Fixture', password_hash: 'not-a-password', account_type: 'internal', role: 'admin' } });
  const initial = await readCatalogRevision(db, 'templates'); assert.match(initial!, /^[a-f0-9]{64}$/);
  const asset = await db.asset.create({ data: { id: 'directory-fixture-asset', owner_id: owner, type: 'image', file_name: 'synthetic.png', mime_type: 'image/png', file_size: 0, original_url: '/uploads/synthetic-directory-only.png' } });
  const afterCreate = await readCatalogRevision(db, 'templates'); assert.notEqual(afterCreate, initial);
  const beforeRollback = await readCatalogRevision(db, 'assets');
  await assert.rejects(db.$transaction(async tx => {
    await tx.asset.update({ where: { id: asset.id }, data: { status: 'hidden' } });
    assert.notEqual(await readCatalogRevision(tx, 'assets'), beforeRollback);
    throw new Error('fixture-rollback');
  }), /fixture-rollback/);
  assert.equal((await db.asset.findUniqueOrThrow({ where: { id: asset.id } })).status, 'active');
  assert.equal(await readCatalogRevision(db, 'assets'), beforeRollback);
  const result = await db.$transaction([
    db.asset.update({ where: { id: asset.id }, data: { status: 'hidden' } }),
    db.user.update({ where: { id: owner }, data: { name: 'Directory Renamed' } }),
  ]);
  assert.equal(result.length, 2); assert.equal(result[0].status, 'hidden'); assert.equal(result[1].name, 'Directory Renamed');
  assert.notEqual(await readCatalogRevision(db, 'assets'), beforeRollback);
  assert.notEqual(await readCatalogRevision(db, 'templates'), afterCreate);
  const beforeNoop = await readCatalogRevision(db, 'assets');
  assert.equal((await db.asset.updateMany({ where: { id: 'not-an-asset' }, data: { status: 'hidden' } })).count, 0);
  assert.equal(await readCatalogRevision(db, 'assets'), beforeNoop);
  const setting = 'studio_style_group_v1:directory-fixture-style';
  await db.$transaction(async tx => {
    await tx.platformSetting.create({ data: { key: setting, value_json: JSON.stringify({ ownerId: owner, references: [] }) } });
  });
  const afterStyle = await readCatalogRevision(db, 'templates'); assert.notEqual(afterStyle, afterCreate);
  await db.imageStudioModule.create({ data: { id: moduleId, owner_id: owner, name: 'Directory module' } });
  const beforeReaction = await readCatalogRevision(db, 'templates');
  const { setIndependentReaction } = await import('../src/lib/content-reactions/independent');
  const user = await db.user.findUniqueOrThrow({ where: { id: owner } });
  const reaction = await setIndependentReaction({ ...user, role: 'admin', account_type: 'internal', status: 'active', feishu: { user_id: null, open_id: null, union_id: null,
    tenant_key: null, employee_no: null, department_ids: [], last_sync_at: null } },
  { protocol: 2, viewerId: owner, key: `image_module:${moduleId}`, action: 'like', active: true, expectedVersion: 0, requestId: 'directory-fixture-like-1' });
  assert.equal(reaction.state.liked, true); assert.notEqual(await readCatalogRevision(db, 'templates'), beforeReaction);
  const beforeUnrelated = await readCatalogRevision(db, 'templates');
  await db.platformSetting.upsert({ where: { key: 'studio_shared_worker_v1' }, create: { key: 'studio_shared_worker_v1', value_json: '{}' }, update: { value_json: '{}' } });
  assert.equal(await readCatalogRevision(db, 'templates'), beforeUnrelated);
  await db.platformSetting.delete({ where: { key: setting } });
  assert.notEqual(await readCatalogRevision(db, 'templates'), afterStyle);
  const readerId = 'catalog-reader-fixture';
  const reader = await db.user.create({ data: { id: readerId, username: readerId, email: `${readerId}@example.invalid`, name: 'Reader', password_hash: 'not-a-password' } });
  const session: SessionUser = { ...reader, role: 'user', account_type: 'internal', status: 'active' };
  const { catalogVisibilitySql, CatalogSqlCompatibilityError } = await import('../src/lib/assets/catalog-visibility-sql');
  const { studioHiddenAssetUrls } = await import('../src/lib/image-studio/protected-assets');
  const media = [
    { id: 'directory-private-template', owner_id: owner, original_url: '/uploads/directory-private.png' },
    { id: 'directory-private-alias', owner_id: readerId, original_url: 'https://sd2.youdooart.com/uploads/directory-private.png' },
    { id: 'directory-owned-style', owner_id: readerId, original_url: '/uploads/directory-style.png' },
    { id: 'directory-private-mv', owner_id: owner, original_url: '/uploads/directory-mv.png' },
    { id: 'directory-ordinary', owner_id: readerId, original_url: '/uploads/directory-ordinary.png' },
  ];
  await db.asset.createMany({ data: media.map(item => ({ ...item, type: 'image', file_name: `${item.id}.png`, mime_type: 'image/png', file_size: 0 })) });
  const fixedKey = 'studio_fixed_references_v1:preset:directory-private-template';
  const styleKey = 'studio_style_group_v1:33333333-3333-4333-8333-333333333333';
  const mvKey = `multiview_private_media_access_v1:${'a'.repeat(64)}`;
  await db.platformSetting.createMany({ data: [
    { key: fixedKey, value_json: JSON.stringify({ ownerId: owner, references: [{ assetId: media[0].id, note: 'SYNTHETIC_PRIVATE_NOTE' }] }) },
    { key: styleKey, value_json: JSON.stringify({ ownerId: readerId, references: [{ assetId: media[2].id, note: '' }] }) },
    { key: mvKey, value_json: JSON.stringify({ schema: 1, kind: 'system-reference', assetId: media[3].id, ownerId: owner, sha256: 'a'.repeat(64), urls: [media[3].original_url] }) },
  ] });
  const verifyVisibility = async () => {
    const visibility = await catalogVisibilitySql(db, session);
    const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`WITH ${visibility.ctes} SELECT a."id" FROM "Asset" a
      WHERE a."id" IN (${Prisma.join(media.map(item => item.id))}) AND ${visibility.visible(Prisma.sql`a."original_url"`)} ORDER BY a."id"`);
    const current = await db.user.findUniqueOrThrow({ where: { id: readerId } });
    const hidden = new Set(await studioHiddenAssetUrls(current));
    assert.deepEqual(rows.map(row => row.id), media.filter(item => !hidden.has(item.original_url)).map(item => item.id).sort());
    return rows.map(row => row.id);
  };
  assert.deepEqual(await verifyVisibility(), [media[2].id, media[4].id].sort());
  await db.user.update({ where: { id: readerId }, data: { role: 'admin' } });
  assert.equal((await verifyVisibility()).length, media.length, 'The database identity, not the stale session role, decides visibility');
  await db.user.update({ where: { id: readerId }, data: { role: 'user' } });
  await db.asset.update({ where: { id: media[0].id }, data: { original_url: 'https://SD2.youdooart.com:443/uploads/directory-private.png' } });
  await assert.rejects(catalogVisibilitySql(db, session), CatalogSqlCompatibilityError);
  await db.asset.update({ where: { id: media[0].id }, data: { original_url: media[0].original_url } });
  await db.platformSetting.update({ where: { key: fixedKey }, data: { value_json: '{broken' } });
  await assert.rejects(catalogVisibilitySql(db, session));
  await db.platformSetting.deleteMany({ where: { key: { in: [fixedKey, styleKey, mvKey] } } });
  await db.videoTask.create({ data: { id: 'catalog-heartbeat-video', provider: 'synthetic', model: 'synthetic', generation_mode: 'synthetic', prompt: 'synthetic', owner_user_id: owner, user_id: owner } });
  await db.multiviewWork.create({ data: { id: 'catalog-heartbeat-work', owner_id: owner, source_task_id: 'catalog-heartbeat-video', save_state: 'intent' } });
  const beforeHeartbeat = await readCatalogRevision(db, 'assets');
  await db.user.update({ where: { id: owner }, data: { last_login_at: new Date() } });
  await db.videoTask.update({ where: { id: 'catalog-heartbeat-video' }, data: { provider_status: 'synthetic-poll' } });
  await db.multiviewWork.update({ where: { id: 'catalog-heartbeat-work' }, data: { lease_until: new Date() } });
  assert.equal(await readCatalogRevision(db, 'assets'), beforeHeartbeat, 'Unrelated login and worker heartbeats do not invalidate every catalog page');
  assert.equal(await db.creditLedger.count(), 0);
  const beforeRestart = await readCatalogRevision(db, 'templates');
  await db.$transaction(tx => initializeCatalogRevisions(tx));
  assert.notEqual(await readCatalogRevision(db, 'templates'), beforeRestart, 'Restoring the current worker invalidates any marker retained across old-writer recovery');
  const capturedTransaction = db.$transaction.bind(db); let instrumentedCalls = 0;
  Reflect.set(db, '$transaction', (...args: unknown[]) => { instrumentedCalls++; return Reflect.apply(capturedTransaction, db, args); });
  try { assert.equal(await db.$transaction(tx => tx.user.count({ where: { id: owner } })), 1); }
  finally { Reflect.set(db, '$transaction', capturedTransaction); }
  assert.equal(instrumentedCalls, 1, 'A captured transaction can be instrumented without recursively reading its replacement');
  return { directWrite: true, assetWithoutUpdatedAt: true, transactionRollback: true, batchResultContract: true,
    userChange: true, styleDependencyChange: true, realReactionWriter: true, noOpCas: true, workerHeartbeatExcluded: true,
    sqlPrivateAliasesEqualOriginal: true, sqlFreshDatabaseRole: true, unsupportedUrlUsesLegacyOnly: true, corruptPrivacyFailsClosed: true, restartInvalidatesRetainedMarker: true, unrelatedHeartbeatsExcluded: true, capturedTransactionInstrumentation: true };
}
