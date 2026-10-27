import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { mock } from 'node:test';

async function main() {
  const root = process.cwd(), run = process.env.MEDIA_FIXTURE_RUN_ID || '';
  assert.match(run, /^[a-zA-Z0-9_-]{1,80}$/);
  const directory = path.join(root, '.role-tests/media-fixtures', run), evidence = path.join(directory, 'audit-picker-native.json');
  assert.equal(process.env.DATABASE_URL, `file:${directory}/audit-media.db`); assert(!existsSync(evidence), 'Fresh fixture only; preserve old evidence');
  Object.assign(process.env, { NODE_ENV: 'test', SESSION_SECRET: 'synthetic-picker-native-key-not-production', FEISHU_ALLOWED_TENANT_KEY: 'synthetic-tenant', PRIVATE_PROMPTS_MIN_STATE: 'legacy-read', MEDIA_DATA_ROOT: path.join(directory, 'media-root') });
  delete process.env.MEDIA_SIGNATURE_SECRET; delete process.env.SESSION_DIGEST_SECRET; delete process.env.PRIVATE_PROMPTS_POLICY_FILE;
  global.fetch = async () => { throw new Error('No real provider/network in synthetic picker fixture'); };
  Object.assign(globalThis, { AsyncLocalStorage });
  const require = createRequire(path.join(root, 'package.json')), resolver = require('node:module'), original = resolver._resolveFilename;
  mock.method(resolver, '_resolveFilename', function (this: unknown, name: string, ...args: unknown[]) { return name === 'server-only' ? require.resolve('next/dist/compiled/server-only/empty.js') : Reflect.apply(original, this, [name, ...args]); });
  const { prisma } = await import('../src/lib/prisma');
  const session = await import('../src/lib/auth/session');
  const { requestAsyncStorage } = await import('./fixtures/next-request-context');
  const { NextRequest } = await import('next/server');
  const route = await import('../src/app/api/assets/picker/route');
  const models = new Set(['Asset', 'ReferenceAlbum', 'ReferenceImage', 'ImageStudioTask', 'ImageStudioModule', 'ImageStudioPreset', 'VideoTask', 'ContentReaction']);
  const collectionReads = { queries: 0, invalidTake: 0, maxReturned: 0 };
  prisma.$use(async (params, next) => {
    const guarded = params.action === 'findMany' && models.has(params.model || '');
    if (guarded) { collectionReads.queries++; if (!Number.isInteger(params.args?.take) || params.args.take < 1 || params.args.take > 100) collectionReads.invalidTake++; }
    const value = await next(params);
    if (guarded && Array.isArray(value)) collectionReads.maxReturned = Math.max(collectionReads.maxReturned, value.length);
    return value;
  });
  try {
    const owner = await prisma.user.create({ data: { username: 'picker-native-owner', name: 'Synthetic owner', email: 'picker-owner@example.invalid', password_hash: 'unusable', status: 'active',
      account_type: 'internal', feishu_user_id: 'synthetic-picker-owner', feishu_tenant_key: 'synthetic-tenant' } });
    const other = await prisma.user.create({ data: { username: 'picker-native-other', name: 'Synthetic other', email: 'picker-other@example.invalid', password_hash: 'unusable', status: 'active' } });
    const album = await prisma.referenceAlbum.create({ data: { id: 'picker-native-album', owner_user_id: owner.id, name: 'Synthetic copied source', album_type: 'personal' } });
    for (let start = 0; start < 1000; start += 50) await prisma.asset.createMany({ data: Array.from({ length: 50 }, (_, offset) => {
      const i = start + offset, type = ['image', 'video', 'audio'][i % 3];
      return { id: `picker-native-asset-${String(i).padStart(4, '0')}`, owner_id: i < 220 ? other.id : owner.id, type,
        original_url: `/uploads/assets/picker-native-no-file-${i}`, file_name: `Synthetic${i}`, mime_type: `${type}/${type === 'image' ? 'png' : type === 'video' ? 'mp4' : 'mpeg'}`, file_size: 100, created_at: new Date(1700000000000 + i) };
    }) });
    const ceiling = (allowed: boolean) => JSON.stringify({ view: allowed, use: allowed, copy: false, download: false, viewSource: false, edit: false });
    for (let start = 0; start < 220; start += 20) await prisma.referenceImage.createMany({ data: Array.from({ length: 20 }, (_, offset) => {
      const i = start + offset; return { id: `picker-native-ref-${i}`, album_id: album.id, owner_user_id: owner.id, asset_id: `picker-native-asset-${String(i).padStart(4, '0')}`,
        url: `/uploads/assets/picker-native-no-file-${i}`, source_type: 'copied', rights_ceiling: ceiling(i < 100), created_at: new Date(1700000000000 + i) };
    }) });
    for (let start = 0; start < 60; start += 20) {
      await prisma.referenceImage.createMany({ data: Array.from({ length: 20 }, (_, offset) => ({ id: `picker-native-orphan-${start + offset}`, album_id: album.id, owner_user_id: other.id,
        url: '/uploads/picker-native-orphan-no-file', source_type: 'copied', rights_ceiling: ceiling(true), created_at: new Date(1700000002000 + start + offset) })) });
      await prisma.videoTask.createMany({ data: Array.from({ length: 20 }, (_, offset) => ({ id: `picker-native-video-${start + offset}`, owner_user_id: owner.id, user_id: owner.id,
        provider: 'synthetic', model: 'synthetic', generation_mode: 'text_to_video', prompt: 'synthetic', local_status: 'succeeded', local_video_path: '/videos/picker-native-no-file.mp4', created_at: new Date(1700000004000 + start + offset) })) });
    }
    const preset = await prisma.imageStudioPreset.create({ data: { id: 'picker-native-preset', owner_id: owner.id, name: 'Synthetic template', scope: 'creator', is_shared: false, model: 'synthetic' } });
    for (const [i, moduleId] of ['picker-native-module-a', 'picker-native-module-b'].entries()) {
      await prisma.imageStudioModule.create({ data: { id: moduleId, owner_id: owner.id, name: moduleId, source_preset_id: preset.id } });
      await prisma.imageStudioTask.create({ data: { id: `picker-native-origin-${i}`, owner_id: owner.id, asset_id: `picker-native-asset-${i ? '0225' : '0222'}`,
        module_id: moduleId, source_preset_id: preset.id, batch_id: 'synthetic-origin', ordinal: i, fingerprint: 'synthetic', prompt: '', context: '', revision: 1,
        model: 'synthetic', reference_ids: '[]', unit_credits: 0, status: 'succeeded', snapshot_json: JSON.stringify({ sourcePresetId: preset.id }) } });
    }
    await prisma.contentReaction.create({ data: { user_id: owner.id, content_key: 'asset:picker-native-asset-0222', category: 'image', favorited: true } });
    await prisma.contentReaction.create({ data: { user_id: owner.id, content_key: 'reference_image:picker-native-ref-1', category: 'video', liked: true } });
    const tokens = new Map([[owner.id, await session.createSession(owner.id)], [other.id, await session.createSession(other.id)]]);
    const get = (query: string, id = owner.id) => {
      const params = new URLSearchParams({ target: 'workspace', limit: '100' }); for (const [key, value] of new URLSearchParams(query)) params.set(key, value);
      return requestAsyncStorage.run({ headers: new Headers({ cookie: `${session.SESSION_COOKIE}=${tokens.get(id)}` }) }, () => route.GET(new NextRequest(`http://synthetic.invalid/api/assets/picker?${params}`)));
    };
    let after = '', first = '', ids: string[] = [];
    do {
      const response = await get(after ? `after=${encodeURIComponent(after)}` : ''); assert.equal(response.status, 200); const data = await response.json();
      assert.equal(data.total, 1000); assert(data.items.length <= 100); assert(!JSON.stringify(data.items).includes('/uploads/') && !JSON.stringify(data.items).includes('/videos/'));
      ids.push(...data.items.map((item: { identity: string }) => item.identity)); after = data.nextCursor || ''; first ||= after;
    } while (after);
    assert.equal(ids.length, 1000); assert.equal(new Set(ids).size, 1000);
    assert.equal((await get(`after=${encodeURIComponent(`${first}x`)}`)).status, 400);
    assert.equal((await get(`after=${encodeURIComponent(first)}&source=uploaded`)).status, 400);
    assert.equal((await get(`after=${encodeURIComponent(first)}`, other.id)).status, 400);
    const copied = await (await get('keys=reference_image:picker-native-ref-1')).json(); assert.equal(copied.items.length, 1); assert.equal(copied.items[0].originalUrl, copied.items[0].previewUrl);
    const denied = await (await get('keys=reference_image:picker-native-ref-150')).json(); assert.equal(denied.total, 0);
    const favorites = await (await get('view=favorites')).json(); assert.equal(favorites.total, 2);
    const alias = await (await get('source=template-image&template=picker-native-module-a')).json(); assert.equal(alias.total, 2);
    assert(alias.items.every((item: { generationOrigin?: { templateId?: string } }) => item.generationOrigin?.templateId === preset.id));
    const search = await (await get('q=Synthetic%20copied%20source')).json(); assert.equal(search.total, 160);
    const single = await (await get('keys=asset:picker-native-asset-0222')).json(); assert.equal(single.total, 1);
    const context = await (await get(`directory=templates&template=${preset.id}&template_context=picker-native-module-b`)).json();
    assert(context.templates.find((option: { id: string }) => option.id === preset.id)?.aliases.includes('picker-native-module-b'));
    assert.equal(collectionReads.invalidTake, 0); assert(collectionReads.maxReturned <= 100);
    writeFileSync(evidence, JSON.stringify({ syntheticOnly: true, actualPrismaAndHandler: true, complete: ids.length, duplicates: 0, copiedCeilingProtected: true,
      deniedCeilingExcluded: true, tamperOwnerFilterRejected: true, favoritesTemplateSearchAndFiniteKeys: true, currentContextAliasPreserved: true,
      collectionReads, realMediaOrProvider: false }, null, 2), { flag: 'wx' }); console.log(evidence);
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
