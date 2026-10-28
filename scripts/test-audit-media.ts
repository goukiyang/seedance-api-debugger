import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { mock } from 'node:test';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { instrumentDatabaseQueries } from './fixtures/audit-query-instrumentation';

async function main() {
  const root = process.cwd();
  const phase = process.env.MEDIA_TEST_PHASE || 'red';
  assert.match(phase, /^[a-zA-Z0-9_-]{1,80}$/, 'Safe evidence phase required');
  const runId = process.env.MEDIA_FIXTURE_RUN_ID;
  if (runId !== undefined) assert.match(runId, /^[a-zA-Z0-9_-]{1,80}$/, 'Safe fixture run ID required');
  const evidenceDirectory = runId ? path.join(root, '.role-tests', 'media-fixtures', runId) : path.join(root, '.role-tests');
  const evidence = (name: string) => path.join(evidenceDirectory, `audit-media-${phase}${name ? `-${name}` : ''}.json`);
  assert.equal(process.env.DATABASE_URL, `file:${evidenceDirectory}/audit-media.db`, 'Only fenced synthetic database');
  assert.equal(existsSync(evidence('')), false, 'Evidence already exists; choose a new phase or fresh fixture run ID');
  mkdirSync(evidenceDirectory, { recursive: true });
  Object.assign(globalThis, { AsyncLocalStorage });
  Object.assign(process.env, { NODE_ENV: 'test', SESSION_SECRET: 'synthetic-media-master-key-not-a-real-secret', SEEDANCE_API_KEY: 'synthetic-provider-key', PRIVATE_PROMPTS_MIN_STATE: 'legacy-read' });
  process.env.FEISHU_ALLOWED_TENANT_KEY = 'synthetic-tenant';
  for (const key of ['SESSION_DIGEST_SECRET', 'UPLOAD_TICKET_SECRET', 'FEISHU_STATE_SECRET', 'REGISTRATION_SECRET', 'PRICING_SIGNATURE_SECRET',
    'MEDIA_SIGNATURE_SECRET', 'VIDEO_DELIVERY_CALLBACK_SECRET', 'PRIVATE_IDENTITY_SECRET', 'ERROR_LOG_SECRET', 'RATE_LIMIT_SECRET']) delete process.env[key];
  process.env.MEDIA_DATA_ROOT = path.join(evidenceDirectory, 'media-root');
  process.env.HD_DERIVATIVES_ROOT = path.join(process.env.MEDIA_DATA_ROOT, 'storage', 'hd-derivatives');
  process.env.MEDIA_LEGACY_TRANSITION_STARTED_AT = new Date().toISOString();
  delete process.env.PRIVATE_PROMPTS_POLICY_FILE;
  global.fetch = async () => { throw new Error('No external calls in media tests'); };
  const req = createRequire(path.join(root, 'package.json'));
  const resolver = req('node:module');
  const originalResolve = resolver._resolveFilename;
  mock.method(resolver, '_resolveFilename', function (this: unknown, name: string, ...args: unknown[]) {
    return name === 'server-only' ? req.resolve('next/dist/compiled/server-only/empty.js') : Reflect.apply(originalResolve, this, [name, ...args]);
  });
  const { prisma } = await import('../src/lib/prisma');
  const session = await import('../src/lib/auth/session');
  const { requestAsyncStorage } = await import('./fixtures/next-request-context');
  const { NextRequest } = await import('next/server');
  const as = async <T>(id: string | null, run: () => Promise<T>) => {
    const token = id ? await session.createSession(id) : '';
    return requestAsyncStorage.run({ headers: new Headers({ cookie: `${session.SESSION_COOKIE}=${token}` }) }, run);
  };
  const users = [];
  for (const name of ['owner', 'member', 'shared', 'external', 'admin']) {
    users.push(await prisma.user.upsert({ where: { username: `media-${name}` }, update: { status: 'active',
      feishu_user_id: name === 'external' ? null : `synthetic-${name}`, feishu_tenant_key: 'synthetic-tenant' }, create: {
      username: `media-${name}`, name: `Synthetic ${name}`, email: `media-${name}@example.invalid`, password_hash: 'unusable',
      role: name === 'admin' ? 'admin' : 'user', account_type: name === 'external' ? 'external' : 'internal',
      feishu_user_id: name === 'external' ? null : `synthetic-${name}`, feishu_tenant_key: 'synthetic-tenant',
    } }));
  }
  const [owner, member, shared, external, admin] = users;
  const album = await prisma.referenceAlbum.upsert({ where: { id: 'media-source-album' }, update: {}, create: { id: 'media-source-album', owner_user_id: owner.id, name: 'Synthetic source' } });
  await prisma.referenceAlbum.upsert({ where: { id: 'media-copy-album' }, update: {}, create: { id: 'media-copy-album', owner_user_id: shared.id, name: 'Synthetic copy' } });
  const asset = await prisma.asset.upsert({ where: { id: 'media-source-asset' }, update: { status: 'active' }, create: {
    id: 'media-source-asset', owner_id: owner.id, type: 'image', original_url: '/uploads/assets/synthetic-source.png',
    thumbnail_url: '/uploads/thumbs/synthetic-source.webp', file_name: 'synthetic.png', mime_type: 'image/png', file_size: 100,
  } });
  await prisma.referenceImage.upsert({ where: { id: 'media-source-reference' }, update: {}, create: {
    id: 'media-source-reference', album_id: album.id, owner_user_id: owner.id, asset_id: asset.id, url: asset.original_url, thumbnail_url: asset.thumbnail_url,
  } });
  await prisma.albumShare.upsert({ where: { album_id_grantee_type_grantee_id: { album_id: album.id, grantee_type: 'user', grantee_id: shared.id } },
    update: {}, create: { album_id: album.id, grantee_type: 'user', grantee_id: shared.id, created_by: owner.id,
      permissions_json: JSON.stringify({ view: true, use: true, copy: true, download: false, edit: false }) } });
  const results: Array<{ name: string; ok: boolean; error?: string }> = [];
  async function test(name: string, run: () => Promise<void>) {
    try { await run(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  await test('actual album copy preserves use-only source ceiling', async () => {
    const route = await import('../src/app/api/reference-albums/[id]/images/route');
    const response = await as(shared.id, () => route.POST(new NextRequest('http://synthetic.invalid/api/reference-albums/media-copy-album/images', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reference_image_id: 'media-source-reference' }),
    }), { params: Promise.resolve({ id: 'media-copy-album' }) }));
    assert.equal(response.status, 201);
    const data = await response.json();
    const permissions = await import('../src/lib/reference-albums/permissions');
    const copied = await permissions.getReferenceImageByIdForAccess(data.images[0].id);
    assert(copied);
    assert.equal(await permissions.canUseAlbumImage(shared as any, copied), true);
    assert.equal(await permissions.canDownloadOriginal(shared as any, copied), false, 'Album ownership must not upgrade content rights');
  });
  await test('anonymous legacy upload internal-check header cannot authorize unregistered files', async () => {
    const file = path.join(root, 'src/app/api/image-studio/upload-access/route.ts');
    if (!existsSync(file)) return;
    const route = await import(file);
    const response = await as<Response>(null, () => route.GET(new NextRequest('http://synthetic.invalid/api/image-studio/upload-access?path=/uploads/assets/unregistered.png', {
      headers: { 'x-image-studio-upload-access-check': '1', 'x-middleware-subrequest': 'middleware:middleware:middleware:middleware:middleware' },
    })));
    assert.equal(response.status, 404);
  });
  await test('unknown historical Seedance ownership cannot be soft-deleted by ordinary internal user', async () => {
    await prisma.seedanceAsset.upsert({ where: { id: 'media-unknown-seedance' }, update: { local_status: 'Active' }, create: {
      id: 'media-unknown-seedance', name: 'Synthetic unknown', provider_asset_id: 'synthetic-provider', original_url: 'https://synthetic.invalid/seedance',
    } });
    const route = await import('../src/app/api/assets/[id]/route');
    const response = await as(member.id, () => route.DELETE(new NextRequest('http://synthetic.invalid/api/assets/media-unknown-seedance', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'media-unknown-seedance' }) }));
    assert.equal(response.status, 403);
    assert.equal((await prisma.seedanceAsset.findUniqueOrThrow({ where: { id: 'media-unknown-seedance' } })).local_status, 'Active');
  });
  await test('private uploads do not receive public immutable cache headers', async () => {
    const config = req('./next.config.js');
    const headers = config.headers ? await config.headers() : [];
    assert.equal(headers.some((row: any) => row.source.startsWith('/uploads') && row.headers.some((header: any) => header.key.toLowerCase() === 'cache-control' && header.value.startsWith('public'))), false);
  });
  await test('image optimizer is explicitly disabled', async () => {
    assert.equal(req('./next.config.js').images?.unoptimized, true);
  });
  if (phase !== 'red') {
    const { toSessionUser } = await import('../src/lib/auth/complete-login');
    const policy = await import('../src/lib/access/media-policy');
    const outlet = await import('../src/lib/media/outlet');
    const signing = await import('../src/lib/media/signed-media');
    const roots = await import('../src/lib/media/storage-roots');
    const actors = users.map(toSessionUser);
    const actorsWithAnonymous = [...actors, null];
    const labels = ['owner', 'member', 'shared', 'external', 'admin', 'anonymous'];
    const sharp = (await import('../src/lib/media/sharp')).default;
    const png = await sharp({ create: { width: 48, height: 32, channels: 3, background: { r: 80, g: 140, b: 210 } } }).png().toBuffer();
    const thumb = await sharp(png).resize(24).webp().toBuffer();
    const jpeg = await sharp(png).jpeg().toBuffer();
    const data = Buffer.from('synthetic-range-payload-0123456789'.repeat(10));
    for (const directory of ['uploads', 'videos', 'display', 'hd', 'supplier'] as const) await fs.mkdir(roots.mediaRoot(directory), { recursive: true });
    await fs.mkdir(path.join(roots.mediaRoot('uploads'), 'assets'), { recursive: true });
    await fs.mkdir(path.join(roots.mediaRoot('uploads'), 'thumbs'), { recursive: true });
    await fs.mkdir(path.join(roots.mediaRoot('videos'), 'thumbnails'), { recursive: true });
    await fs.writeFile(roots.localMediaPath(asset.original_url), png);
    await fs.writeFile(roots.localMediaPath(asset.thumbnail_url!), thumb);
    const project = await prisma.project.upsert({ where: { id: 'media-project' }, update: {}, create: { id: 'media-project', name: 'Synthetic media project', type: 'team', owner_user_id: owner.id, created_by: owner.id } });
    await prisma.projectMember.upsert({ where: { project_id_user_id: { project_id: project.id, user_id: member.id } }, update: {}, create: { project_id: project.id, user_id: member.id, role: 'member' } });
    await prisma.albumShare.upsert({ where: { album_id_grantee_type_grantee_id: { album_id: album.id, grantee_type: 'project', grantee_id: project.id } }, update: {},
      create: { album_id: album.id, grantee_type: 'project', grantee_id: project.id, created_by: owner.id, permissions_json: JSON.stringify({ view: true, use: true, copy: true, download: false }) } });
    await prisma.albumShare.upsert({ where: { album_id_grantee_type_grantee_id: { album_id: album.id, grantee_type: 'user', grantee_id: external.id } }, update: {},
      create: { album_id: album.id, grantee_type: 'user', grantee_id: external.id, created_by: owner.id, permissions_json: JSON.stringify({ view: true, use: true, copy: false, download: false }) } });
    const video = await prisma.videoTask.upsert({ where: { id: 'media-video-task' }, update: {}, create: { id: 'media-video-task', provider: 'synthetic', model: 'synthetic', generation_mode: 'text_to_video', prompt: 'synthetic', local_status: 'succeeded',
      project_id: project.id, owner_user_id: owner.id, user_id: owner.id, local_video_path: '/videos/media-video-task.mp4' } });
    await fs.writeFile(roots.localMediaPath(video.local_video_path!), data);
    await fs.writeFile(roots.localMediaPath('/videos/thumbnails/media-video-task.jpg'), jpeg);
    await prisma.imageStudioTask.upsert({ where: { id: 'media-image-task' }, update: { status: 'succeeded' }, create: {
      id: 'media-image-task', batch_id: 'synthetic-batch', owner_id: owner.id, ordinal: 1, fingerprint: 'synthetic', prompt: '', context: '', revision: 1,
      model: 'synthetic', reference_ids: '[]', unit_credits: 0, status: 'succeeded', asset_id: asset.id } });
    await prisma.imageStudioPreset.upsert({ where: { id: 'media-template' }, update: {}, create: { id: 'media-template', owner_id: owner.id, name: 'Synthetic template', scope: 'creator', is_shared: true, model: 'synthetic', banner_asset_id: asset.id } });
    const mvOutput = await prisma.asset.upsert({ where: { id: 'media-mv-output' }, update: {}, create: { id: 'media-mv-output', owner_id: owner.id, type: 'image', original_url: '/uploads/assets/synthetic-output.png',
      thumbnail_url: '/uploads/thumbs/synthetic-output.webp', file_name: 'synthetic-output.png', mime_type: 'image/png', file_size: png.length, metadata_json: JSON.stringify({ multiviewOutput: { schema: 1 } }) } });
    await fs.writeFile(roots.localMediaPath(mvOutput.original_url), png); await fs.writeFile(roots.localMediaPath(mvOutput.thumbnail_url!), thumb);
    await prisma.referenceImage.upsert({ where: { id: 'media-mv-output-ref' }, update: {}, create: { id: 'media-mv-output-ref', album_id: album.id, asset_id: mvOutput.id, owner_user_id: owner.id, url: mvOutput.original_url, thumbnail_url: mvOutput.thumbnail_url } });
    const mvReference = await prisma.asset.upsert({ where: { id: 'media-mv-system' }, update: {}, create: { id: 'media-mv-system', owner_id: owner.id, type: 'image', original_url: '/uploads/assets/synthetic-system.png', thumbnail_url: '/uploads/thumbs/synthetic-system.webp',
      file_name: 'synthetic-system.png', mime_type: 'image/png', file_size: png.length } });
    await fs.writeFile(roots.localMediaPath(mvReference.original_url), png); await fs.writeFile(roots.localMediaPath(mvReference.thumbnail_url!), thumb);
    const digest = createHash('sha256').update(png).digest('hex');
    await prisma.platformSetting.upsert({ where: { key: `multiview_private_media_access_v1:${digest}` }, update: {}, create: { key: `multiview_private_media_access_v1:${digest}`, updated_by: owner.id,
      value_json: JSON.stringify({ schema: 1, kind: 'system-reference', assetId: mvReference.id, ownerId: owner.id, sha256: digest, urls: [mvReference.original_url, mvReference.thumbnail_url] }) } });
    await prisma.seedanceAsset.upsert({ where: { id: 'media-owned-seedance' }, update: { local_status: 'Active', owner_id: owner.id, ownership_status: 'owned' }, create: {
      id: 'media-owned-seedance', owner_id: owner.id, ownership_status: 'owned', name: 'Synthetic owned', provider_asset_id: 'synthetic-owned', original_url: asset.original_url } });
    const matrix: Array<{ label: string; ref: import('../src/lib/access/media-policy').MediaRef; mode: 'shared' | 'project' | 'owner' | 'template' | 'system' }> = [
      { label: 'upload-image', ref: { type: 'asset', id: asset.id }, mode: 'shared' }, { label: 'reference-image', ref: { type: 'reference', id: 'media-source-reference' }, mode: 'shared' },
      { label: 'video-result', ref: { type: 'video', id: video.id }, mode: 'project' }, { label: 'video-cover', ref: { type: 'video-cover', id: video.id }, mode: 'project' },
      { label: 'image-task-result', ref: { type: 'image-task', id: 'media-image-task' }, mode: 'owner' }, { label: 'template-cover', ref: { type: 'template-cover', id: asset.id }, mode: 'template' },
      { label: 'multiview-system-reference', ref: { type: 'multiview-reference', id: mvReference.id }, mode: 'system' }, { label: 'multiview-output', ref: { type: 'multiview-output', id: mvOutput.id }, mode: 'shared' },
      { label: 'seedance', ref: { type: 'seedance', id: 'media-owned-seedance' }, mode: 'system' },
    ];
    for (const kind of ['video', 'audio']) {
      const extra = await prisma.asset.upsert({ where: { id: `media-upload-${kind}` }, update: {}, create: { id: `media-upload-${kind}`, owner_id: owner.id, type: kind,
        original_url: `/uploads/assets/synthetic-${kind}.${kind === 'video' ? 'mp4' : 'mp3'}`, thumbnail_url: asset.thumbnail_url,
        file_name: `synthetic-${kind}`, mime_type: kind === 'video' ? 'video/mp4' : 'audio/mpeg', file_size: data.length } });
      await fs.writeFile(roots.localMediaPath(extra.original_url), data);
      await prisma.referenceImage.upsert({ where: { id: `media-ref-${kind}` }, update: {}, create: { id: `media-ref-${kind}`, album_id: album.id, owner_user_id: owner.id, asset_id: extra.id, url: extra.original_url, thumbnail_url: extra.thumbnail_url } });
      matrix.push({ label: `upload-${kind}`, ref: { type: 'asset', id: extra.id }, mode: 'shared' }, { label: `reference-${kind}`, ref: { type: 'reference', id: `media-ref-${kind}` }, mode: 'shared' });
    }
    const expected = (mode: string, actorIndex: number, action: string) => {
      if (actorIndex === 5) return false;
      if (actorIndex === 0) return true;
      if (actorIndex === 4) return mode !== 'owner';
      if (mode === 'project') return actorIndex === 1 && action !== 'delete' && action !== 'edit';
      if (mode === 'owner' || mode === 'system') return false;
      if (mode === 'template') return actorIndex !== 3 && ['view-thumbnail', 'view-preview', 'use'].includes(action);
      return ['view-thumbnail', 'view-preview', 'use'].includes(action) || action === 'copy' && actorIndex !== 3;
    };
    const matrixEvidence: Array<Record<string, unknown>> = [];
    for (const row of matrix) for (let i = 0; i < actorsWithAnonymous.length; i++) for (const action of policy.MEDIA_ACTIONS) {
      await test(`matrix ${row.label}/${labels[i]}/${action}`, async () => {
        const actor = actorsWithAnonymous[i], permitted = expected(row.mode, i, action);
        const decision = await policy.decideMedia(actor, row.ref, action);
        assert.equal(decision.allowed, permitted);
        let outletStatus: number | null = null;
        if (['view-thumbnail', 'view-preview', 'download-original'].includes(action)) {
          const variant = action === 'view-thumbnail' ? 'thumbnail' : action === 'view-preview' ? 'preview' : 'original';
          const response = await outlet.redirectMedia(new Request('http://synthetic.invalid/projection'), actor, row.ref, variant);
          outletStatus = response.status;
          assert.equal(response.status, permitted ? 302 : actor ? 403 : 404);
          if (permitted) {
            const signed = await signing.signedMediaResponse(new Request(response.headers.get('location')!), actor!.id);
            assert.equal(signed.status, 200);
            assert.match(signed.headers.get('x-accel-redirect') || '', /^\/_protected_media\//);
          }
        }
        matrixEvidence.push({ type: row.label, role: labels[i], action, allowed: decision.allowed, outletStatus });
      });
    }
    writeFileSync(evidence('matrix'), JSON.stringify(matrixEvidence, null, 2), { flag: 'wx' });
    await test('task input outlet follows the source ceiling and hides source locators', async () => {
      await prisma.videoTask.update({ where: { id: video.id }, data: { reference_image_urls: JSON.stringify([asset.original_url]),
        result_last_frame_url: asset.original_url } });
      const ref = { type: 'video-input' as const, id: `${video.id}--image--0` };
      assert.equal((await policy.decideMedia(actors[1], ref, 'view-preview')).allowed, true);
      assert.equal((await policy.decideMedia(actors[1], ref, 'download-original')).allowed, false);
      assert.equal((await policy.decideMedia(actors[0], ref, 'download-original')).allowed, true);
      await prisma.videoTask.update({ where: { id: video.id }, data: { reference_image_urls: JSON.stringify(['https://sd2.youdooart.com' + asset.original_url]) } });
      assert.equal((await policy.decideMedia(actors[1], ref, 'download-original')).allowed, false);
      assert.equal((await policy.decideMedia(actors[0], ref, 'download-original')).allowed, true);
      const borrowed = await prisma.videoTask.upsert({ where: { id: 'media-borrower-task' }, update: {}, create: {
        id: 'media-borrower-task', owner_user_id: member.id, user_id: member.id, project_id: project.id,
        provider: 'synthetic', model: 'synthetic', generation_mode: 'image_to_video', prompt: 'synthetic', local_status: 'succeeded',
        reference_image_urls: JSON.stringify(['https://sd2.youdooart.com' + asset.original_url]), source_metadata_json: null,
      } });
      assert.equal((await policy.decideMedia(actors[1], { type: 'video-input', id: `${borrowed.id}--image--0` }, 'view-preview')).allowed, true);
      assert.equal((await policy.decideMedia(actors[1], { type: 'video-input', id: `${borrowed.id}--image--0` }, 'download-original')).allowed, false);
      assert.equal((await policy.decideMedia(actors[2], ref, 'view-preview')).allowed, false);
      assert.equal((await policy.decideMedia(actors[0], { ...ref, id: `${video.id}--image--99` }, 'view-preview')).allowed, false);
      const response = await outlet.redirectMedia(new Request('http://synthetic.invalid/task-input'), actors[1], ref, 'preview');
      assert.equal(response.status, 302);
      assert(!(response.headers.get('location') || '').includes('/uploads/'));
      assert.equal((await signing.signedMediaResponse(new Request(response.headers.get('location')!), member.id)).status, 200);
      const frame = await outlet.redirectMedia(new Request('http://synthetic.invalid/frame'), actors[1], { type: 'video-frame', id: video.id }, 'original');
      assert.equal(frame.status, 302);
      await prisma.videoTask.update({ where: { id: video.id }, data: { source_metadata_json: JSON.stringify({ protected_module:
        { kind: 'multiview', schema: 1, recipeVersion: '1.0.1' } }) } });
      assert.equal((await policy.decideMedia(actors[0], ref, 'view-preview')).allowed, false);
      assert.equal((await policy.decideMedia(actors[4], ref, 'view-preview')).allowed, false);
      await prisma.videoTask.update({ where: { id: video.id }, data: { source_metadata_json: null } });
    });
    await test('signature rejects other user, expiry, variant and resource tampering; hides locator', async () => {
      const address = await outlet.mediaAddress(actors[0], { type: 'asset', id: asset.id }, 'original');
      assert(!address.includes('/uploads/') && !address.includes('synthetic-source.png'));
      const url = new URL(address, 'http://synthetic.invalid');
      assert(signing.verifyMediaTicket(url, owner.id));
      assert.equal(signing.verifyMediaTicket(url, shared.id), null);
      assert.equal(signing.verifyMediaTicket(url, owner.id, Date.now() + 601000), null);
      assert.equal((await signing.signedMediaResponse(new Request(url.href.replace('/original?', '/preview?')), owner.id)).status, 403);
      assert.equal((await signing.signedMediaResponse(new Request(url.href.replace(`/asset/${asset.id}/`, '/asset/other-id/')), owner.id)).status, 403);
    });
    await test('private delivery cache never widens originals or HD permissions and HEAD does not copy', async () => {
      const location = { root: 'hd' as const, relative: `${'b'.repeat(64)}.webp` };
      const file = roots.mediaFilePath(location);
      await fs.writeFile(file, thumb, { mode: 0o600 });
      await fs.chmod(roots.mediaRoot('hd'), 0o700);
      const before = await fs.stat(file), rootBefore = (await fs.stat(roots.mediaRoot('hd'))).mode;
      const address = await signing.signUserMedia(owner.id, { type: 'asset', id: asset.id }, 'hd', location, 'image/webp', 'hd.webp');
      const entries = await fs.readdir(roots.mediaRoot('delivery')).catch(() => []);
      const head = await signing.signedMediaResponse(new Request(new URL(address, 'http://synthetic.invalid'), { method: 'HEAD' }), owner.id);
      assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(thumb.length));
      assert.deepEqual(await fs.readdir(roots.mediaRoot('delivery')).catch(() => []), entries);
      const response = await signing.signedMediaResponse(new Request(new URL(address, 'http://synthetic.invalid')), owner.id);
      assert.equal(response.status, 200); assert.match(response.headers.get('x-accel-redirect')!, /^\/_protected_media\/delivery\//);
      const delivery = path.join(roots.mediaRoot('delivery'), path.basename(response.headers.get('x-accel-redirect')!));
      assert.deepEqual(await fs.readFile(delivery), thumb); assert.equal((await fs.stat(delivery)).mode & 0o777, 0o640);
      assert.equal((await fs.stat(file)).mode, before.mode); assert.equal((await fs.stat(file)).nlink, 1);
      assert.equal((await fs.stat(roots.mediaRoot('hd'))).mode, rootBefore);
    });
    await test('use-only copied reference original route denies, canvas gets rendition only', async () => {
      const copied = await prisma.referenceImage.findFirstOrThrow({ where: { album_id: 'media-copy-album', source_image_id: 'media-source-reference' }, orderBy: { created_at: 'desc' } });
      const route = await import('../src/app/api/reference-images/[id]/content/route');
      const response = await as(shared.id, () => route.GET(new NextRequest(`http://synthetic.invalid/api/reference-images/${copied.id}/content?variant=original`), { params: Promise.resolve({ id: copied.id }) }));
      assert.equal(response.status, 403);
      const canvas = await import('../src/lib/canvas-documents');
      const snapshot: any = { canvas: { nodes: [{ id: 'input', type: 'flow-input', data: { assetIds: [asset.id], referenceImageId: copied.id } }], connections: [] } };
      await canvas.validateAssets(prisma, actors[2], snapshot, true);
      const serialized = JSON.stringify(snapshot);
      assert(!serialized.includes('/uploads/') && !serialized.includes(asset.original_url));
      assert(!serialized.includes('/original?') && !serialized.includes('/download?'));
      assert(serialized.includes('/preview?'));
    });
    await test('private recipe file aliases stay hidden even when a task owner owns an alias Asset', async () => {
      const alias = await prisma.asset.upsert({ where: { id: 'media-private-alias' }, update: {}, create: { id: 'media-private-alias', owner_id: shared.id, type: 'image', original_url: mvReference.original_url,
        thumbnail_url: mvReference.thumbnail_url, file_name: 'alias.png', mime_type: 'image/png', file_size: png.length } });
      for (const action of policy.MEDIA_ACTIONS) assert.equal((await policy.decideMedia(actors[2], { type: 'asset', id: alias.id }, action)).allowed, false);
      const descriptor = await outlet.mediaProjection(actors[2], { type: 'asset', id: alias.id });
      assert.equal(descriptor, null);
    });
    await test('copied source ceiling cannot be upgraded by re-sharing with explicit download', async () => {
      const copied = await prisma.referenceImage.findFirstOrThrow({ where: { album_id: 'media-copy-album', source_image_id: 'media-source-reference' } });
      const grant = await prisma.albumShare.upsert({ where: { album_id_grantee_type_grantee_id: { album_id: 'media-copy-album', grantee_type: 'user', grantee_id: external.id } }, update: { status: 'active' },
        create: { album_id: 'media-copy-album', grantee_type: 'user', grantee_id: external.id, created_by: shared.id, permissions_json: JSON.stringify({ view: true, use: true, copy: true, download: true }) } });
      try {
        assert.equal((await policy.decideMedia(actors[3], { type: 'reference', id: copied.id }, 'use')).allowed, true);
        assert.equal((await policy.decideMedia(actors[3], { type: 'reference', id: copied.id }, 'download-original')).allowed, false);
      } finally {
        await prisma.albumShare.update({ where: { id: grant.id }, data: { status: 'revoked' } });
      }
      assert.equal((await policy.decideMedia(actors[3], { type: 'asset', id: asset.id }, 'copy')).allowed, false, 'The temporary re-share must not leak into the next matrix run');
    });
    await test('a private system-image thumbnail alias cannot be smuggled through an owned Asset', async () => {
      const alias = await prisma.asset.upsert({ where: { id: 'media-private-thumb-alias' }, update: { status: 'active' }, create: { id: 'media-private-thumb-alias', owner_id: shared.id, type: 'image', original_url: asset.original_url,
        thumbnail_url: mvReference.original_url, file_name: 'alias.png', mime_type: 'image/png', file_size: png.length } });
      try {
        assert.equal((await policy.decideMedia(actors[2], { type: 'asset', id: alias.id }, 'view-thumbnail')).allowed, false);
        const ref = { type: 'video-input' as const, id: `${video.id}--image--0` };
        assert.equal((await policy.decideMedia(actors[0], ref, 'view-preview')).allowed, false, 'An active duplicate source stays ambiguous even for its owner');
      } finally {
        await prisma.asset.update({ where: { id: alias.id }, data: { status: 'inactive' } });
      }
      assert.equal((await policy.decideMedia(actors[1], { type: 'video-input', id: `${video.id}--image--0` }, 'view-preview')).allowed, true, 'Removing only the synthetic duplicate restores the original authorized source');
    });
    await test('real outlet resolves revocation and cross-user identity before trusting a signed ticket', async () => {
      const route = await import('../src/app/m/[type]/[id]/[variant]/route');
      const address = await outlet.mediaAddress(actors[0], { type: 'asset', id: asset.id }, 'original');
      const params = { params: Promise.resolve({ type: 'asset', id: asset.id, variant: 'original' }) };
      const foreign = await as(shared.id, () => route.GET(new Request(new URL(address, 'http://synthetic.invalid')), params));
      assert.equal(foreign.status, 403);
      const token = await session.createSession(owner.id);
      const store = await import('../src/lib/auth/session-store');
      await store.revokeSession(token, 'synthetic-media-revoke');
      const response = await requestAsyncStorage.run({ headers: new Headers({ cookie: `${session.SESSION_COOKIE}=${token}` }) }, () => route.GET(new Request(new URL(address, 'http://synthetic.invalid')), params));
      assert.equal(response.status, 404);
    });
    await test('legacy anonymous video/private image requests with bypass headers return404; transition expires', async () => {
      const route = await import('../src/app/api/media/legacy/route');
      for (const file of [video.local_video_path!, asset.original_url, '/uploads/unknown.png']) {
        const response = await as(null, () => route.GET(new Request(`http://synthetic.invalid/api/media/legacy?path=${encodeURIComponent(file)}`, { headers: { 'x-middleware-subrequest': 'middleware:middleware:middleware:middleware:middleware', 'x-image-studio-upload-access-check': '1' } })));
        assert.equal(response.status, 404);
      }
      const legacy = await import('../src/lib/media/legacy');
      assert.equal(legacy.legacyMediaWindow(Date.now() + 30 * 86400000 + 1000), false);
      const previous = process.env.MEDIA_LEGACY_TRANSITION_STARTED_AT;
      delete process.env.MEDIA_LEGACY_TRANSITION_STARTED_AT;
      assert.equal(legacy.legacyMediaWindow(), false);
      process.env.MEDIA_LEGACY_TRANSITION_STARTED_AT = previous;
    });
    await test('supplier publication creates only a one-hour anonymous signed outlet; no static file', async () => {
      for (const key of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'TOS_REGION', 'TOS_BUCKET', 'TOS_ACCESS_KEY', 'TOS_SECRET_KEY']) delete process.env[key];
      process.env.SITE_PUBLIC_BASE_URL = 'https://supplier.synthetic.invalid';
      const publication = await import('../src/lib/assets/public-storage');
      const result = await publication.uploadPublicAsset(png, 'synthetic-provider.png', 'image/png');
      const url = new URL(result.publicUrl);
      const claim = signing.verifyMediaTicket(url, null);
      assert(claim && claim.audience === 'supplier');
      assert.equal(claim.location.root, 'supplier');
      assert.equal(signing.verifyMediaTicket(url, null, Date.now() + 3601000), null);
      assert.equal((await signing.signedMediaResponse(new Request(url), null)).status, 200);
      assert.equal(existsSync(path.join(root, 'public', 'uploads', 'assets', `${createHash('sha256').update(png).digest('hex')}.png`)), false);
    });
    await test('Seedance mutations are isolated; provider deletion requires administrator+confirmation+durable audit', async () => {
      const route = await import('../src/app/api/assets/[id]/route');
      const providerRoute = await import('../src/app/api/assets/[id]/provider-delete/route');
      const params = { params: Promise.resolve({ id: 'media-owned-seedance' }) };
      const requestedBefore = await prisma.operationLog.count({ where: { action: 'seedance_provider_delete_requested', target_id: 'media-owned-seedance' } });
      assert.equal((await as(member.id, () => route.PATCH(new NextRequest('http://synthetic.invalid/asset', { method: 'PATCH', body: JSON.stringify({ name: 'unauthorized' }), headers: { 'content-type': 'application/json' } }), params))).status, 403);
      assert.equal((await as(member.id, () => route.DELETE(new NextRequest('http://synthetic.invalid/asset', { method: 'DELETE' }), params))).status, 403);
      assert.equal((await as(owner.id, () => providerRoute.DELETE(new NextRequest('http://synthetic.invalid/asset', { method: 'DELETE', body: JSON.stringify({ confirm_asset_id: 'media-owned-seedance' }) }), params))).status, 403);
      assert.equal((await as(admin.id, () => providerRoute.DELETE(new NextRequest('http://synthetic.invalid/asset', { method: 'DELETE' }), params))).status, 400);
      const beforeFetch = global.fetch;
      let calls = 0;
      global.fetch = async (url, options) => {
        assert.equal(String(url), 'https://etc.seedance-api.net/server/asset/delete');
        assert.equal(JSON.parse(String(options?.body)).apiKey, 'synthetic-provider-key');
        calls++;
        return Response.json({ error: 'Synthetic unknown provider response' }, { status: 502 });
      };
      try {
        const request = () => new NextRequest('http://synthetic.invalid/asset', { method: 'DELETE', body: JSON.stringify({ confirm_asset_id: 'media-owned-seedance' }) });
        const unknownResponse = await as(admin.id, () => providerRoute.DELETE(request(), params));
        assert.equal(unknownResponse.status, 502);
        assert.equal((await prisma.seedanceAsset.findUniqueOrThrow({ where: { id: 'media-owned-seedance' } })).local_status, 'ProviderDeletePending');
        assert.equal(await prisma.operationLog.count({ where: { action: 'seedance_provider_delete_requested', target_id: 'media-owned-seedance' } }), requestedBefore + 1);
        assert.equal((await as(admin.id, () => providerRoute.DELETE(request(), params))).status, 409);
        assert.equal(calls, 1, 'Unknown provider deletion must not be resent');
        assert.equal(await prisma.operationLog.count({ where: { action: 'seedance_provider_delete_requested', target_id: 'media-owned-seedance' } }), requestedBefore + 1);
        await prisma.seedanceAsset.upsert({ where: { id: 'media-delete-success' }, update: { local_status: 'Active' }, create: {
          id: 'media-delete-success', owner_id: owner.id, ownership_status: 'owned', name: 'Synthetic confirmed deletion', provider_asset_id: 'synthetic-delete-success', original_url: asset.original_url } });
        const successRequestedBefore = await prisma.operationLog.count({ where: { action: 'seedance_provider_delete_requested', target_id: 'media-delete-success' } });
        const successCompletedBefore = await prisma.operationLog.count({ where: { action: 'seedance_provider_delete_succeeded', target_id: 'media-delete-success' } });
        let successCalls = 0;
        global.fetch = async (url, options) => {
          assert.equal(String(url), 'https://etc.seedance-api.net/server/asset/delete');
          assert.equal(options?.method, 'POST');
          assert.deepEqual(JSON.parse(String(options?.body)), { apiKey: 'synthetic-provider-key', Id: 'synthetic-delete-success' });
          successCalls++;
          return Response.json({ ResponseMetadata: { RequestId: 'synthetic-delete-success' }, Result: {} });
        };
        const success = await as(admin.id, () => providerRoute.DELETE(new NextRequest('http://synthetic.invalid/asset', { method: 'DELETE', body: JSON.stringify({ confirm_asset_id: 'media-delete-success' }) }),
          { params: Promise.resolve({ id: 'media-delete-success' }) }));
        assert.equal(success.status, 200);
        assert.deepEqual(await success.json(), { success: true, localId: 'media-delete-success', status: 'ProviderDeleted' });
        assert.equal(successCalls, 1);
        assert.equal((await prisma.seedanceAsset.findUniqueOrThrow({ where: { id: 'media-delete-success' } })).local_status, 'ProviderDeleted');
        assert.equal(await prisma.operationLog.count({ where: { action: 'seedance_provider_delete_requested', target_id: 'media-delete-success' } }), successRequestedBefore + 1);
        assert.equal(await prisma.operationLog.count({ where: { action: 'seedance_provider_delete_succeeded', target_id: 'media-delete-success' } }), successCompletedBefore + 1);
      } finally { global.fetch = beforeFetch; }
    });
    await test('workspace browser serialization uses the current reference ceiling, not canonical storage addresses', async () => {
      const copied = await prisma.referenceImage.findFirstOrThrow({ where: { album_id: 'media-copy-album', source_image_id: 'media-source-reference' } });
      const workspace = await import('../src/lib/assets/workspace');
      const selected = await workspace.getOrCreateWorkspace('media-fixture', shared.id);
      await workspace.addAssetToWorkspace(selected.id, asset.id, 'reference_image', shared.id, { referenceImageId: copied.id, allowSharedAsset: true });
      const route = await import('../src/app/api/workspace/route');
      const response = await as(shared.id, () => route.GET(new NextRequest('http://synthetic.invalid/api/workspace', {
        headers: { 'x-tab-id': 'media-fixture', 'x-upload-owner-id': shared.id },
      })));
      assert.equal(response.status, 200);
      const result = await response.json();
      const projected = result.workspace.assets.find((row: { assetId: string }) => row.assetId === asset.id);
      assert(projected);
      assert.equal(projected.referenceImageId, copied.id);
      assert.equal(projected.media.canUse, true);
      assert.equal(projected.media.canDownload, false);
      assert.equal(projected.media.originalUrl, null);
      assert.equal(new URL(projected.originalUrl, 'http://synthetic.invalid').pathname, `/m/reference/${copied.id}/preview`);
      assert(!JSON.stringify(result).includes('/uploads/'));
      await assert.rejects(() => workspace.getWorkspaceWithAssets(selected.id, actors[0]), (error: any) => error.status === 403);
    });
    await test('completed upload and recovery browser projections preserve proof and unknown controls without writes', async () => {
      const { browserUploadResponse } = await import('../src/lib/media/browser-projection.server');
      const before = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
      const logCount = await prisma.operationLog.count();
      const proof = Object.freeze({ requestId: 'synthetic-projection-request', verified: true as const, assetDisposition: 'new' as const, sourceVersion: 'synthetic-source-version' });
      const canonical = Object.freeze({ id: asset.id, originalUrl: asset.original_url, thumbnailUrl: asset.thumbnail_url, fileName: asset.file_name,
        fileSize: asset.file_size, mimeType: asset.mime_type, hash: asset.hash, upload: proof });
      const encoded = JSON.stringify(canonical);
      const projected = await browserUploadResponse(actors[0], { success: true, upload: proof, asset: canonical });
      assert.equal(projected.success, true);
      assert.equal(projected.asset.id, asset.id);
      assert.equal(projected.asset.upload, proof);
      assert.equal(projected.upload, proof);
      assert.equal(JSON.stringify(canonical), encoded);
      assert(projected.asset.originalUrl?.startsWith('/m/'));
      assert(!JSON.stringify(projected).includes('/uploads/'));
      const unknown = Object.freeze({ rawUpload: Object.freeze({ ownerId: owner.id, requestId: 'synthetic-unknown-request', phase: 'writing' }), recoveryToken: 'synthetic-recovery-proof' });
      assert.equal(await browserUploadResponse(actors[0], unknown), unknown);
      assert.deepEqual(await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } }), before);
      assert.equal(await prisma.operationLog.count(), logCount);
    });
    // Raw HTTP through actual local nginx verifies internal mapping and Range.
    // All media and cookies are synthetic; no browser/provider or real media used.
    await test('actual nginx signed outlet serves Range and private thumbnails;100reads add zero resource queries', async () => {
      const m = await import('../src/app/m/[type]/[id]/[variant]/route');
      const counters: Record<string, number> = {};
      await instrumentDatabaseQueries(prisma, async (params, next) => { const model = params.model || 'raw'; counters[model] = (counters[model] || 0) + 1; return next(params); });
      const token = await session.createSession(owner.id);
      const cookie = `${session.SESSION_COOKIE}=${token}`;
      const address = await outlet.mediaAddress(actors[0], { type: 'asset', id: asset.id }, 'thumbnail');
      const videoAddress = await outlet.mediaAddress(actors[0], { type: 'video', id: video.id }, 'preview');
      const upstream = http.createServer(async (incoming, outgoing) => {
        try {
          const url = new URL(incoming.url!, 'http://synthetic.invalid');
          const pieces = url.pathname.split('/');
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
          const request = new Request(url, { method: incoming.method, headers });
          const response = await requestAsyncStorage.run({ headers }, () => m.GET(request, { params: Promise.resolve({ type: pieces[2], id: pieces[3], variant: pieces[4] }) }));
          outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch { outgoing.writeHead(503); outgoing.end(); }
      });
      await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
      const upstreamPort = (upstream.address() as net.AddressInfo).port;
      const reservation = net.createServer();
      await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
      const port = (reservation.address() as net.AddressInfo).port;
      await new Promise<void>(resolve => reservation.close(() => resolve()));
      const prefix = path.join(evidenceDirectory, `nginx-${phase}`); await fs.mkdir(prefix, { recursive: true });
      let candidate = readFileSync('ops/nginx/media-outlet.candidate.conf', 'utf8');
      candidate = candidate.replaceAll('/data/video-api-debugger/var-lib', process.env.MEDIA_DATA_ROOT!);
      const config = `pid ${prefix}/nginx.pid; error_log ${prefix}/error.log; worker_processes 1; events { worker_connections 128; } http { access_log off; server { listen 127.0.0.1:${port}; ${candidate} location / { proxy_pass http://127.0.0.1:${upstreamPort}; proxy_set_header Cookie $http_cookie; } } }`;
      const configPath = path.join(prefix, 'synthetic.conf'); await fs.writeFile(configPath, config);
      const nginxBin = process.env.NGINX_BIN || 'nginx';
      let nginx: ReturnType<typeof spawn> | undefined;
      const get = (url: string, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; bytes: Buffer }>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${url}`, { headers: { cookie, ...headers } }, response => {
          const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, bytes: Buffer.concat(chunks) }));
        }).on('error', reject);
      });
      try {
        execFileSync(nginxBin, ['-t', '-p', prefix, '-c', configPath], { stdio: 'pipe' });
        nginx = spawn(nginxBin, ['-p', prefix, '-c', configPath, '-g', 'daemon off;'], { stdio: ['ignore', 'ignore', 'pipe'] });
        let started = false;
        for (let i = 0; i < 50 && !started; i++) { try { await get('/_protected_media/uploads/assets/synthetic-source.png'); started = true; } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
        assert(started, 'Isolated nginx did not start');
        const denied = await get('/_protected_media/uploads/assets/synthetic-source.png'); assert.equal(denied.status, 404);
        const range = await get(videoAddress, { range: 'bytes=3-12' });
        assert.equal(range.status, 206); assert.equal(range.headers['content-range'], `bytes 3-12/${data.length}`); assert.deepEqual(range.bytes, data.subarray(3, 13));
        for (const key of Object.keys(counters)) counters[key] = 0;
        for (let i = 0; i < 100; i++) {
          const response = await get(address);
          assert.equal(response.status, 200); assert.deepEqual(response.bytes, thumb);
          assert.match(String(response.headers['cache-control']), /private, max-age=/);
          assert.equal(response.headers['x-accel-redirect'], undefined);
        }
        const sessionQueries = (counters.UserSession || 0) + (counters.User || 0);
        const resourceQueries = Object.entries(counters).filter(([key]) => !['UserSession', 'User'].includes(key)).reduce((total, [, value]) => total + value, 0);
        assert.equal(resourceQueries, 0); assert(sessionQueries >= 200);
        writeFileSync(evidence('nginx'), JSON.stringify({ realLocalNginx: true, syntheticOnly: true, rangeStatus: range.status,
          privateThumbnailRequests: 100, resourceQueries, sessionQueries, counters, directInternalStatus: denied.status }, null, 2), { flag: 'wx' });
      } finally {
        if (nginx && nginx.exitCode === null && nginx.signalCode === null) {
          const exited = once(nginx, 'exit'); nginx.kill('SIGQUIT'); await exited;
        }
        await new Promise<void>(resolve => upstream.close(() => resolve()));
      }
    });
  }
  mkdirSync('.role-tests', { recursive: true });
  writeFileSync(evidence(''), JSON.stringify({ phase, runId: runId || null, syntheticOnly: true, results,
    passed: results.filter(row => row.ok).length, failed: results.filter(row => !row.ok).length }, null, 2), { flag: 'wx' });
  await prisma.$disconnect();
  console.log(JSON.stringify({ phase, passed: results.filter(row => row.ok).length, failed: results.filter(row => !row.ok).length, failures: results.filter(row => !row.ok) }));
  if (results.some(row => !row.ok)) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
