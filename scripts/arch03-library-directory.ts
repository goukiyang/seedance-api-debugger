import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { PrismaClient } from '@prisma/client';

export async function verifyLibraryDirectory(db: PrismaClient, root: string) {
  const owner = 'picker-directory-owner';
  await db.user.update({ where: { id: owner }, data: { feature_profile_id: 'internal_email_authorized' } });
  const tasks = Array.from({ length: 45 }, (_, index) => ({ id: `library-task-${index}`, provider: 'seedance', model: 'synthetic', generation_mode: 'all_in_one_reference', prompt: `Synthetic ${index}`,
    user_id: owner, owner_user_id: owner, local_status: index === 3 ? 'running' : 'succeeded', retention_status: index === 4 ? 'user_deleted' : 'active',
    duration: index % 5, provider_final_amount_micros: 0, created_at: new Date(1700000000000 + index * 2000), completed_at: new Date(1700000050000 + index * 1000) }));
  await db.videoTask.createMany({ data: tasks });
  const source = tasks[0].id;
  await db.multiviewWork.create({ data: { id: 'library-work-fixture', owner_id: owner, source_task_id: source, title: 'Synthetic Work', status: 'ready', ready_revision: 3 } });
  const outputAssets = Array.from({ length: 3 }, (_, index) => ({ id: `library-output-${index}`, owner_id: owner, type: 'image', file_name: `Output ${index}.png`, mime_type: 'image/png', file_size: 0,
    original_url: `/uploads/library-output-${index}.png`, hash: `synthetic-hash-${index}`, metadata_json: '{"source":"multiview-output","multiviewOutput":{"schema":1}}' }));
  await db.asset.createMany({ data: outputAssets });
  const sharedUpload = await db.asset.findUniqueOrThrow({ where: { id: 'picker-asset-0' } });
  const outputs = [...outputAssets.map((asset, index) => ({ state: 'registered', assetId: asset.id, sha256: asset.hash, role: index === 0 ? 'collage' : `frame-${index}` })),
    { state: 'registered', assetId: sharedUpload.id, sha256: sharedUpload.hash, role: 'frame-upload' }];
  await db.platformSetting.createMany({ data: [
    { key: 'multiview_output_registration_v1:receipt:library-work-fixture:2', value_json: JSON.stringify({ schema: 1, state: 'registered', ownerId: owner, workId: 'library-work-fixture', readyRevision: 2, outputs }) },
    { key: 'multiview_output_registration_v1:receipt:library-work-fixture:3', value_json: JSON.stringify({ schema: 1, state: 'registered', ownerId: owner, workId: 'library-work-fixture', readyRevision: 3,
      outputs: outputs.map((output, index) => index === 1 ? { ...output, state: 'unavailable' } : output) }) },
  ] });
  const { multiviewWorkActor } = await import('../src/lib/video/multiview-works');
  const { multiviewOutputGroups } = await import('../src/lib/video/multiview-output-groups.server');
  assert.equal((await multiviewOutputGroups(await multiviewWorkActor(owner))).groups.length, 1, 'The fixture must satisfy the actual internal-user contract before route comparison');
  const require = createRequire(import.meta.url), { NextRequest } = require('next/server') as typeof import('next/server');
  const { requestAsyncStorage } = require('next/dist/client/components/request-async-storage.external') as typeof import('next/dist/client/components/request-async-storage.external');
  const { RequestCookies } = require('next/dist/compiled/@edge-runtime/cookies') as typeof import('next/dist/compiled/@edge-runtime/cookies');
  const { createSession } = require('../src/lib/auth/session') as typeof import('../src/lib/auth/session');
  const original = require('../src/app/api/assets/library/route') as typeof import('../src/app/api/assets/library/route');
  const compiled = ts.transpileModule(readFileSync(path.join(root, 'src/app/api/assets/library/route.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as typeof original };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    const value = require(name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : name);
    return name === '@/lib/image-studio/catalog-revision' ? { ...value, catalogReaderReady: async () => true } : value;
  }, module, module.exports);
  const token = await createSession(owner);
  const invoke = async (query: URLSearchParams, paged: boolean) => {
    query = new URLSearchParams(query); if (paged) query.set('protocol', 'catalog-paged-v2');
    const headers = new Headers({ host: 'arch03-fixture.invalid', Cookie: `session=${token}` });
    const request = new NextRequest(`http://arch03-fixture.invalid/api/assets/library?${query}`, { headers });
    const store = { headers, cookies: new RequestCookies(headers) } as unknown as Parameters<typeof requestAsyncStorage.run>[0];
    const response = await requestAsyncStorage.run(store, () => (paged ? module.exports : original).GET(request));
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  let comparisons = 0;
  for (const sort of ['created_desc', 'created_asc', 'completed_desc', 'duration']) for (const type of ['all', 'video', 'image', 'reference']) {
    const query = new URLSearchParams({ type, scope: 'history', status: 'all', sort, include_uploads: 'true', include_generated: 'true', collapse_multiview: '1', limit: '12', page: '2' });
    const legacy = await invoke(query, false), paged = await invoke(query, true);
    assert.deepEqual(paged.items, legacy.items, `${sort}/${type}`); assert.deepEqual(paged.pagination, legacy.pagination); comparisons++;
  }
  const query = new URLSearchParams('type=all&scope=history&status=all&sort=created_desc&include_uploads=true&include_generated=true&collapse_multiview=1&limit=100');
  const legacy = await invoke(query, false), paged = await invoke(query, true);
  assert.deepEqual(paged.items, legacy.items); assert.equal(paged.pagination.total, legacy.pagination.total);
  query.set('type', 'image');
  const imageLegacy = await invoke(query, false), imagePage = await invoke(query, true); assert.deepEqual(imagePage.items, imageLegacy.items);
  assert.ok(imagePage.items.some((item: { id: string }) => item.id === 'asset:picker-asset-0'), 'An ordinary upload used by a group remains independent');
  assert.ok(imagePage.items.some((item: { id: string }) => item.id === 'multiview_work:library-work-fixture'));
  assert.ok(!imagePage.items.some((item: { id: string }) => item.id === 'asset:library-output-0'));
  const group = imagePage.items.find((item: { id: string }) => item.id === 'multiview_work:library-work-fixture'); assert.equal(group.multiviewGroup.revision, 2);
  const hidden = new URLSearchParams('type=all&scope=history&status=hidden&include_uploads=true&include_generated=true');
  assert.deepEqual((await invoke(hidden, true)).items, (await invoke(hidden, false)).items);
  return { comparisons, realRouteProjection: true, exactTotal: true, groupCompleteReceiptWins: true, dedicatedChildrenCollapsed: true, ordinaryUploadPreserved: true, hiddenPermission: true };
}
