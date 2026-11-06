import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mock } from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import type { SessionUser } from '../src/lib/auth/session';
import type { UsageFact } from '../src/lib/admin/usage-types';

async function main() {
  const root = process.cwd(), scratch = mkdtempSync(path.join(tmpdir(), 'works-reproduction-'));
  const databaseUrl = `file:${path.join(scratch, 'synthetic.db')}`;
  const require = createRequire(import.meta.url);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    DATABASE_URL: databaseUrl, NODE_ENV: 'test', PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' };
  execFileSync(process.execPath, [path.join(path.dirname(require.resolve('prisma/package.json')), 'build/index.js'),
    'db', 'push', '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')], { env, stdio: 'pipe' });
  process.env.DATABASE_URL = databaseUrl;
  process.env.FEISHU_ALLOWED_TENANT_KEY = 'synthetic-tenant';
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  Reflect.set(globalThis, 'prisma', db); Reflect.set(globalThis, 'prismaSqlitePragmasStarted', true);
  let networkCalls = 0;
  mock.method(globalThis, 'fetch', () => { networkCalls++; throw new Error('Network forbidden in this fixture'); });
  const passed: string[] = [];
  try {
    const { catalogVisibilitySql, CatalogSqlCompatibilityError } = await import('../src/lib/assets/catalog-visibility-sql');
    const { studioHiddenAssetUrls, readableStudioCoverIds } = await import('../src/lib/image-studio/protected-assets');
    const { galleryDirectorySql } = await import('../src/lib/image-studio/gallery-directory-sql');
    const { readWorkPage, readWorkDetail } = await import('../src/lib/works/query');
    const { readUsageMedia } = await import('../src/lib/usage/media');
    const reader = await db.user.create({ data: { id: 'synthetic-reader', name: 'Reader', username: 'synthetic-reader',
      email: 'reader@example.invalid', password_hash: 'synthetic', role: 'user', account_type: 'internal', feishu_user_id: 'synthetic-feishu', feishu_tenant_key: 'synthetic-tenant' } });
    const actor = { ...reader, role: 'user', account_type: 'internal', status: 'active' } as SessionUser;
    const assets = ['ordinary', 'private'].map(kind => ({ id: `synthetic-${kind}`, owner_id: reader.id,
      type: 'image', file_name: 'synthetic.png', mime_type: 'image/png', file_size: 0, original_url: `/uploads/synthetic-${kind}.png` }));
    await db.asset.createMany({ data: assets });
    await db.platformSetting.create({ data: { key: 'studio_shared_reproduction_v1:real-snapshot', value_json: JSON.stringify({
      version: 2, sourceOwnerId: reader.id, sourceTaskId: 'synthetic-source', moduleContext: 'synthetic',
      taskSettings: { protocol: 'task-settings-v2', mode: 'current' }, templateFixedReferences: [{ assetId: assets[1].id, note: '' }],
    }) } });
    const visible = async () => {
      const access = await catalogVisibilitySql(db, actor);
      const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`WITH ${access.ctes}
        SELECT a.id FROM Asset a WHERE ${access.visible(Prisma.sql`a.original_url`)} ORDER BY a.id`);
      return rows.map(row => row.id);
    };
    assert.deepEqual(await visible(), [assets[0].id]); passed.push('real_v2_snapshot_keeps_private_binding');
    await db.platformSetting.createMany({ data: Array.from({ length: 260 }, (_, index) => ({
      key: `studio_shared_reproduction_v1:${index % 2 ? 'workspace' : 'preset'}:synthetic-${index}`,
      value_json: JSON.stringify({ version: 2, ownerId: reader.id, moduleId: `synthetic-${index}`, sourceTaskId: null,
        taskSettings: { protocol: 'task-settings-v2', mode: 'current' } }),
    })) });
    assert.deepEqual(await visible(), [assets[0].id]); passed.push('workspace_and_preset_metadata_do_not_block_sql');
    const hidden = await studioHiddenAssetUrls(actor, db);
    assert.ok(hidden.includes(assets[1].original_url)); assert.ok(!hidden.includes(assets[0].original_url));
    passed.push('legacy_reader_preserves_private_binding');
    assert.deepEqual([...await readableStudioCoverIds(actor, assets)].sort(), [assets[0].id]);
    passed.push('metadata_does_not_consume_cover_binding_limit');
    await galleryDirectorySql(db, actor, { scope: 'all' }); passed.push('gallery_canonical_metadata_accepts_source_records');
    for (const asset of assets) {
      const work = await db.work.create({ data: { id: `work-${asset.id}`, source_kind: 'upload_asset', source_id: asset.id,
        author_id: reader.id, title: 'Synthetic', medium: 'image', completed_at: new Date() } });
      const media = await db.workMediaVersion.create({ data: { work_id: work.id, source_revision: '1', asset_id: asset.id,
        source_url: asset.original_url } });
      await db.work.update({ where: { id: work.id }, data: { current_version_id: media.id } });
    }
    const page = await readWorkPage(actor, new URLSearchParams('scope=all'), db);
    assert.deepEqual(page.items.map(item => item.id), [`work-${assets[0].id}`]);
    assert.ok(await readWorkDetail(actor, page.items[0].id, db));
    const privateDetail = await readWorkDetail(actor, `work-${assets[1].id}`, db);
    assert.ok(privateDetail?.canManage, 'Owners retain their management record');
    for (const key of ['thumbnailUrl', 'previewUrl', 'detailPreviewUrl', 'downloadUrl', 'reuse'] as const)
      assert.equal(privateDetail[key], null, `Private binding still blocks ${key}`);
    passed.push('works_list_and_detail_keep_acl');
    await db.imageStudioTask.createMany({ data: assets.map((asset, ordinal) => ({ id: `task-${asset.id}`, batch_id: 'synthetic',
      owner_id: reader.id, ordinal, fingerprint: asset.id, prompt: '', context: '', revision: 1, model: 'synthetic',
      reference_ids: '[]', unit_credits: 0, status: 'succeeded', asset_id: asset.id })) });
    const facts = assets.map(asset => ({ sourceKind: 'image_task', sourceId: `task-${asset.id}`, ownerUserId: reader.id,
      currentOwnerUserId: reader.id, retentionStatus: 'active', outputCount: 1, leaf: true })) as UsageFact[];
    const media = await readUsageMedia(db, actor, facts, { kind: 'self', viewerId: reader.id });
    assert.deepEqual([...media.keys()], [`image_task:task-${assets[0].id}`]); passed.push('usage_media_keeps_acl');
    await db.platformSetting.update({ where: { key: 'studio_shared_reproduction_v1:real-snapshot' }, data: { value_json: '{broken' } });
    await assert.rejects(visible(), CatalogSqlCompatibilityError);
    await assert.rejects(studioHiddenAssetUrls(actor, db)); passed.push('corrupt_real_binding_still_fails_closed');
    assert.equal(networkCalls, 0);
    console.log(JSON.stringify({ passed: true, checks: passed, synthetic: true, productionWrites: 0, networkCalls }));
  } finally { mock.restoreAll(); await db.$disconnect(); rmSync(scratch, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
