import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import sharp from 'sharp';

async function main() {
  const sourceRoot = process.cwd();
  const isolatedRoot = process.env.FEISHU_NOTIFICATION_FIXTURE_ROOT;
  assert.ok(isolatedRoot && path.isAbsolute(isolatedRoot) && !isolatedRoot.startsWith('/data/video-api-debugger/'));
  assert.equal(await realpath(isolatedRoot!), isolatedRoot);
  const run = await mkdtemp(path.join(isolatedRoot!, 'notification-run-'));
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${run}/isolated.sqlite`, FEISHU_APP_ID: 'fixture-app',
    FEISHU_APP_SECRET: 'fixture-placeholder', FEISHU_ALLOWED_TENANT_KEY: 'fixture-tenant' });
  for (const key of Object.keys(process.env).filter(key => key.startsWith('PRIVATE_PROMPTS_'))) delete process.env[key];
  await writeFile(`${run}/isolated.sqlite`, '', { mode: 0o600, flag: 'wx' });
  const initialized = spawnSync(process.execPath, [path.join(sourceRoot, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate',
    '--schema', path.join(sourceRoot, 'prisma/schema.prisma')], { env: process.env, encoding: 'utf8', timeout: 120000 });
  assert.equal(initialized.status, 0, `isolated schema initialization failed: ${initialized.stderr?.slice(-800)}`);
  const [{ prisma }, notification, contract, worker, output, video, videoContract, videoWorker, videoSource] = await Promise.all([
    import('../src/lib/prisma'), import('../src/lib/image-studio/feishu-notification'), import('../src/lib/image-studio/feishu-contract'),
    import('../src/lib/image-studio/feishu-delivery'), import('../src/lib/image-studio/output'), import('../src/lib/video/feishu-notification'),
    import('../src/lib/video/feishu-contract'), import('../src/lib/video/feishu-delivery'), import('../src/lib/video/feishu-source'),
  ]);
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let now = originalNow(); Date.now = () => now;
  let uploads = 0, images = 0, texts = 0, uploadUnknown = false, explanationUnknown = false;
  const payloads: Array<Record<string, unknown>> = [], imageBytes: Buffer[] = [];
  globalThis.fetch = async (url, init) => {
    const endpoint = String(url);
    assert.ok(endpoint.startsWith('https://open.feishu.cn/open-apis/'), 'Unexpected network destination');
    if (endpoint.endsWith('/auth/v3/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'fixture-token' });
    if (endpoint.endsWith('/im/v1/images')) {
      uploads++; const form = init!.body as FormData;
      assert.equal(form.get('image_type'), 'message'); imageBytes.push(Buffer.from(await (form.get('image') as Blob).arrayBuffer()));
      if (uploadUnknown) throw new Error('isolated network interruption');
      return Response.json({ code: 0, data: { image_key: `img_fixture_${uploads}` } });
    }
    assert.ok(endpoint.endsWith('/im/v1/messages?receive_id_type=open_id'));
    const body = JSON.parse(String(init!.body)); payloads.push(body);
    assert.equal(body.receive_id, 'ou_fixture_owner');
    if (body.msg_type === 'image') images++; else { assert.equal(body.msg_type, 'text'); texts++; }
    if (body.msg_type === 'text' && explanationUnknown) { explanationUnknown = false; return new Response('', { status: 502 }); }
    return Response.json({ code: 0, data: { message_id: `om_fixture_${body.uuid.replaceAll('-', '')}` } });
  };
  let cases = 0;
  const done = () => { cases++; };
  try {
    process.chdir(run); await mkdir('public/uploads', { recursive: true });
    for (const id of ['fixture-owner', 'fixture-other']) await prisma.user.create({ data: { id, name: 'Fixture', username: id,
      email: `${id}@example.invalid`, password_hash: 'fixture-only', role: 'admin', feishu_open_id: id === 'fixture-owner' ? 'ou_fixture_owner' : 'ou_fixture_other',
      feishu_tenant_key: 'fixture-tenant' } });
    const initial = await notification.readImageFeishuPreference(prisma, 'fixture-owner'); assert.equal(initial.enabled, false); assert.equal(initial.available, true);
    assert.equal(await notification.freezeImageFeishuChoice(prisma, 'fixture-owner', undefined), null); done();
    await notification.saveImageFeishuPreference(prisma, 'fixture-owner', { version: 1, enabled: true, revision: 0 });
    const frozen = await notification.freezeImageFeishuChoice(prisma, 'fixture-owner', { version: 1, enabled: true, preferenceRevision: 1 }); assert.ok(frozen);
    await assert.rejects(notification.freezeImageFeishuChoice(prisma, 'fixture-owner', { version: 1, enabled: true, preferenceRevision: 0 }));
    assert.equal((await video.readVideoFeishuPreference(prisma, 'fixture-owner')).enabled, false); done();
    const png = await sharp({ create: { width: 24, height: 24, channels: 4, background: { r: 28, g: 80, b: 120, alpha: 0.5 } } }).png().toBuffer();
    const makeTask = async (id: string, bytes = png, format = 'png') => {
      const task = await prisma.imageStudioTask.create({ data: { id, batch_id: `batch-${id}`, owner_id: 'fixture-owner', module_id: 'fixture-module', ordinal: 1,
        fingerprint: id, prompt: 'PRIVATE_PROMPT_MARKER', context: 'PRIVATE_REFERENCE_MARKER', revision: 1, model: 'fixture-image', reference_ids: '[]', unit_credits: 0,
        status: 'succeeded' } });
      const asset = await output.prepareStudioOutput(bytes, task, { width: 24, height: 24 }, async () => {}, format);
      const saved = await prisma.asset.upsert({ where: { owner_id_hash: { owner_id: 'fixture-owner', hash: asset.hash! } }, create: asset, update: {} });
      await prisma.imageStudioTask.update({ where: { id }, data: { asset_id: saved.id } });
      await notification.enqueueFrozenImageFeishuNotification(prisma, task, frozen);
      return prisma.notification.findUniqueOrThrow({ where: { id: contract.imageFeishuUuid(id, 'event') } });
    };
    const row = await makeTask('fixture-image-one');
    await notification.enqueueFrozenImageFeishuNotification(prisma, { id: 'fixture-image-one', owner_id: 'fixture-owner' }, frozen);
    assert.equal(await prisma.notification.count(), 1);
    await assert.rejects(notification.readImageFeishuStatus(prisma, 'fixture-other', 'fixture-image-one'));
    await assert.rejects(notification.enqueueFrozenImageFeishuNotification(prisma, { id: 'fixture-image-one', owner_id: 'fixture-other' }, frozen)); done();
    await notification.saveImageFeishuPreference(prisma, 'fixture-owner', { version: 1, enabled: false, revision: 1 });
    await worker.deliverImageFeishuNotification(prisma, row);
    const sent = await notification.readImageFeishuStatus(prisma, 'fixture-owner', 'fixture-image-one');
    assert.equal(sent.state, 'sent_image'); assert.equal(uploads, 1); assert.equal(images, 1); assert.equal(texts, 1); assert.ok(imageBytes[0].equals(png));
    await worker.deliverImageFeishuNotification(prisma, row); assert.equal(uploads, 1); assert.equal(images, 1); done();
    const concurrent = await makeTask('fixture-image-concurrent'); const beforeConcurrent = uploads;
    await Promise.all([worker.deliverImageFeishuNotification(prisma, concurrent), worker.deliverImageFeishuNotification(prisma, concurrent)]);
    assert.equal(uploads - beforeConcurrent, 1); assert.equal((await notification.readImageFeishuStatus(prisma, 'fixture-owner', 'fixture-image-concurrent')).state, 'sent_image'); done();
    const partial = await makeTask('fixture-image-partial'); const beforePartial = { uploads, images, texts }; explanationUnknown = true;
    await worker.deliverImageFeishuNotification(prisma, partial);
    let partialRow = await prisma.notification.findUniqueOrThrow({ where: { id: partial.id } }); let meta = contract.parseImageFeishuEvent(partialRow.metadata_json)!;
    assert.ok(meta.image.receiptId); assert.equal(meta.explanation.ambiguous, true); assert.equal(meta.state, 'pending');
    const explanationUuid = meta.explanation.uuid; now += 61_000;
    await worker.deliverImageFeishuNotification(prisma, partialRow);
    assert.equal(uploads - beforePartial.uploads, 1); assert.equal(images - beforePartial.images, 1); assert.equal(texts - beforePartial.texts, 2);
    assert.equal(payloads.filter(p => p.uuid === explanationUuid).length, 2); done();
    const unknown = await makeTask('fixture-image-upload-unknown'); const beforeUnknown = { uploads, images, texts }; uploadUnknown = true;
    await worker.deliverImageFeishuNotification(prisma, unknown); uploadUnknown = false;
    const unknownRow = await prisma.notification.findUniqueOrThrow({ where: { id: unknown.id } });
    assert.equal(contract.parseImageFeishuEvent(unknownRow.metadata_json)!.state, 'unknown');
    await worker.deliverImageFeishuNotification(prisma, unknownRow);
    await assert.rejects(notification.changeImageFeishuNotification(prisma, 'fixture-owner', 'fixture-image-upload-unknown', 'retry'));
    assert.equal(uploads - beforeUnknown.uploads, 1); assert.equal(images, beforeUnknown.images); assert.equal(texts, beforeUnknown.texts); done();
    const cancelled = await makeTask('fixture-image-cancelled'); await notification.changeImageFeishuNotification(prisma, 'fixture-owner', 'fixture-image-cancelled', 'cancel');
    const beforeCancel = uploads; await worker.deliverImageFeishuNotification(prisma, cancelled); assert.equal(uploads, beforeCancel); done();
    const rebound = await makeTask('fixture-image-rebound'); await prisma.user.update({ where: { id: 'fixture-owner' }, data: { feishu_open_id: 'ou_changed_binding' } });
    const beforeRebound = uploads; await worker.deliverImageFeishuNotification(prisma, rebound); assert.equal(uploads, beforeRebound);
    assert.equal(contract.parseImageFeishuEvent((await prisma.notification.findUniqueOrThrow({ where: { id: rebound.id } })).metadata_json)!.reason, 'binding_changed');
    await prisma.user.update({ where: { id: 'fixture-owner' }, data: { feishu_open_id: 'ou_fixture_owner' } }); done();
    const tiff = await sharp(png).tiff().toBuffer(); const fallback = await makeTask('fixture-image-tiff', tiff, 'tiff'); const beforeFallback = { uploads, images, texts };
    await worker.deliverImageFeishuNotification(prisma, fallback); assert.equal(uploads, beforeFallback.uploads); assert.equal(images, beforeFallback.images); assert.equal(texts - beforeFallback.texts, 1);
    assert.equal((await notification.readImageFeishuStatus(prisma, 'fixture-owner', 'fixture-image-tiff')).state, 'sent_link'); done();
    const corrupt = await makeTask('fixture-image-corrupt'); const corruptTask = await prisma.imageStudioTask.findUniqueOrThrow({ where: { id: 'fixture-image-corrupt' } });
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: corruptTask.asset_id! } }); await writeFile(path.join(run, 'public', asset.original_url), 'broken');
    const brokenMeta = contract.parseImageFeishuEvent(corrupt.metadata_json)!; brokenMeta.preparations = 11;
    const brokenRow = await prisma.notification.update({ where: { id: corrupt.id }, data: { metadata_json: JSON.stringify(brokenMeta) } }); const beforeBroken = uploads;
    await worker.deliverImageFeishuNotification(prisma, brokenRow); assert.equal(uploads, beforeBroken);
    assert.equal((await notification.readImageFeishuStatus(prisma, 'fixture-owner', 'fixture-image-corrupt')).state, 'failed'); done();
    await prisma.videoTask.create({ data: { id: 'fixture-video-failed', provider: 'seedance', model: 'fixture', generation_mode: 'first_frame', prompt: 'PRIVATE_VIDEO_PROMPT',
      user_id: 'fixture-owner', owner_user_id: 'fixture-owner', local_status: 'succeeded', delivery_status: 'failed', delivery_error: 'fixture-stall' } });
    const videoMeta = videoContract.newVideoFeishuEvent('fixture-video-failed', 'fixture-owner', frozen!.identity, frozen!.choice, now);
    const videoRow = await prisma.notification.create({ data: { id: videoMeta.eventId, type: videoContract.VIDEO_FEISHU_TYPE, channel: 'feishu', status: 'pending',
      target_user_id: 'fixture-owner', actor_user_id: 'fixture-owner', title: 'Fixture', metadata_json: JSON.stringify(videoMeta) } });
    const beforeVideo = uploads; await videoWorker.deliverVideoFeishuNotification(prisma, videoRow); assert.equal(uploads, beforeVideo);
    assert.equal((await video.readVideoFeishuStatus(prisma, 'fixture-owner', 'fixture-video-failed')).state, 'original_save_failed');
    const failedVideo = videoContract.parseVideoFeishuEvent((await prisma.notification.findUniqueOrThrow({ where: { id: videoRow.id } })).metadata_json)!;
    assert.equal(failedVideo.video.attempts, 0); assert.equal(failedVideo.explanation.attempts, 0); done();
    assert.equal(await video.wakeVideoFeishuAfterOriginalReady('fixture-video-failed', prisma), false);
    await prisma.videoTask.update({ where: { id: 'fixture-video-failed' }, data: { local_video_path: '/videos/fixture-video-failed.mp4' } });
    assert.equal(await video.wakeVideoFeishuAfterOriginalReady('fixture-video-failed', prisma), true);
    const resumed = videoContract.parseVideoFeishuEvent((await prisma.notification.findUniqueOrThrow({ where: { id: videoRow.id } })).metadata_json)!;
    assert.equal(resumed.video.uuid, videoMeta.video.uuid); assert.equal(resumed.state, 'pending');
    assert.equal(await video.wakeVideoFeishuAfterOriginalReady('fixture-video-failed', prisma), false); done();
    const beforeCache = (await video.authorizedVideoFeishuTask(prisma, 'fixture-owner', 'fixture-video-failed')).task;
    const afterCache = { ...beforeCache, public_video_url: 'https://fixture.invalid/original.mp4', public_video_storage_provider: 'r2',
      public_video_storage_key: 'seedance-videos/fixture.mp4', public_video_file_size: 42, public_video_cached_at: new Date(now) };
    assert.equal(videoSource.videoFeishuSourceStamp(beforeCache, 'local'), videoSource.videoFeishuSourceStamp(afterCache, 'local'));
    assert.notEqual(videoSource.videoFeishuSourceStamp(beforeCache, 'remote'), videoSource.videoFeishuSourceStamp(afterCache, 'remote'));
    const digest = 'a'.repeat(64);
    assert.equal(videoContract.videoFeishuSameOriginal({ sourceVersion: 'b'.repeat(64), contentHash: digest }, { version: 'c'.repeat(64), hash: digest }), true);
    assert.equal(videoContract.videoFeishuSameOriginal({ sourceVersion: 'b'.repeat(64), contentHash: digest }, { version: 'c'.repeat(64), hash: 'd'.repeat(64) }), false);
    assert.equal(videoContract.videoFeishuSameOriginal({ sourceVersion: 'b'.repeat(64), contentHash: null }, { version: 'c'.repeat(64), hash: null }), false); done();
    resumed.state = 'failed'; resumed.reason = 'original_changed';
    await prisma.notification.update({ where: { id: videoRow.id }, data: { status: 'failed', metadata_json: JSON.stringify(resumed) } });
    assert.equal(await video.wakeVideoFeishuAfterOriginalReady('fixture-video-failed', prisma), false);
    assert.equal((await prisma.notification.findUniqueOrThrow({ where: { id: videoRow.id } })).metadata_json, JSON.stringify(resumed)); done();
    assert.equal(videoContract.videoFeishuStatus(videoContract.newVideoFeishuEvent('video-cdn-failed', 'fixture-owner', frozen!.identity, frozen!.choice), 'failed', true).state, 'pending'); done();
    assert.ok(!JSON.stringify(payloads).includes('PRIVATE_')); assert.ok(!JSON.stringify(payloads).includes('/uploads/')); done();
    console.log(JSON.stringify({ passed: true, cases, uploads, imageMessages: images, explanationAttempts: texts,
      realSqlite: true, externalRequests: 0, productionWrites: 0, originalFileBytesPreserved: true }));
  } finally {
    process.chdir(sourceRoot); globalThis.fetch = originalFetch; Date.now = originalNow;
    await prisma.$disconnect(); const { feedbackPrisma } = await import('../src/lib/feedback/notification'); await feedbackPrisma.$disconnect();
    await rm(run, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.stack : 'notification engineering failed'); process.exitCode = 1; });
