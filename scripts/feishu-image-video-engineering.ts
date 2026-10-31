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
  let uploads = 0, images = 0, texts = 0, cards = 0, uploadUnknown = false, explanationUnknown = false, cardUnknown = false;
  let expectFrozenTaskId: string | null = null, rejectMessage = false, changeBindingOnUpload = false;
  const payloads: Array<Record<string, unknown>> = [], imageBytes: Buffer[] = [];
  globalThis.fetch = async (url, init) => {
    const endpoint = String(url);
    assert.ok(endpoint.startsWith('https://open.feishu.cn/open-apis/'), 'Unexpected network destination');
    if (endpoint.endsWith('/auth/v3/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'fixture-token' });
    if (endpoint.endsWith('/im/v1/images')) {
      uploads++; const form = init!.body as FormData;
      if (expectFrozenTaskId) {
        const event = await prisma.notification.findUniqueOrThrow({ where: { id: contract.imageFeishuUuid(expectFrozenTaskId, 'event') } });
        const meta = contract.parseImageFeishuEvent(event.metadata_json)!; assert.equal(meta.version, 2);
        if (meta.version === 2) { assert.ok(meta.presentation); assert.ok(meta.cardTemplate); assert.equal(meta.cardPayload, null); }
      }
      assert.equal(form.get('image_type'), 'message'); imageBytes.push(Buffer.from(await (form.get('image') as Blob).arrayBuffer()));
      if (uploadUnknown) throw new Error('isolated network interruption');
      if (changeBindingOnUpload) { changeBindingOnUpload = false; await prisma.user.update({ where: { id: 'fixture-owner' }, data: { feishu_open_id: 'ou_changed_binding' } }); }
      return Response.json({ code: 0, data: { image_key: `img_fixture_${uploads}` } });
    }
    assert.ok(endpoint.endsWith('/im/v1/messages?receive_id_type=open_id'));
    const body = JSON.parse(String(init!.body)); payloads.push(body);
    assert.equal(body.receive_id, 'ou_fixture_owner');
    if (body.msg_type === 'image') images++;
    else if (body.msg_type === 'interactive') {
      cards++;
      if (expectFrozenTaskId) {
        const event = await prisma.notification.findUniqueOrThrow({ where: { id: contract.imageFeishuUuid(expectFrozenTaskId, 'event') } });
        const meta = contract.parseImageFeishuEvent(event.metadata_json)!; assert.equal(meta.version, 2);
        if (meta.version === 2) assert.equal(body.content, meta.cardPayload);
      }
      if (cardUnknown) { cardUnknown = false; return new Response('', { status: 502 }); }
    } else { assert.equal(body.msg_type, 'text'); texts++; }
    if (rejectMessage) { rejectMessage = false; return Response.json({ code: 230001 }); }
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
    const makeTask = async (id: string, bytes = png, format = 'png', card = false) => {
      const task = await prisma.imageStudioTask.create({ data: { id, batch_id: `batch-${id}`, owner_id: 'fixture-owner', module_id: 'fixture-module', ordinal: 1,
        fingerprint: id, prompt: 'PRIVATE_PROMPT_MARKER', context: 'PRIVATE_REFERENCE_MARKER', revision: 1, model: 'fixture-image', reference_ids: '[]', unit_credits: 0,
        status: 'succeeded' } });
      const dimensions = await sharp(bytes).metadata();
      const asset = await output.prepareStudioOutput(bytes, task, { width: dimensions.width!, height: dimensions.height! }, async () => {}, format);
      const saved = await prisma.asset.upsert({ where: { owner_id_hash: { owner_id: 'fixture-owner', hash: asset.hash! } }, create: asset, update: {} });
      await prisma.imageStudioTask.update({ where: { id }, data: { asset_id: saved.id } });
      await notification.enqueueFrozenImageFeishuNotification(prisma, task, frozen);
      const row = await prisma.notification.findUniqueOrThrow({ where: { id: contract.imageFeishuUuid(id, 'event') } });
      if (card) return row;
      // Real old v1 rows retain their exact original image + text contract after upgrade.
      const legacy = JSON.parse(row.metadata_json!); legacy.version = 1; legacy.explanation.state = 'pending';
      delete legacy.presentation; delete legacy.cardTemplate; delete legacy.cardPayload;
      return prisma.notification.update({ where: { id: row.id }, data: { metadata_json: JSON.stringify(legacy) } });
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
    assert.equal((await notification.readImageFeishuStatus(prisma, 'fixture-owner', 'fixture-image-corrupt')).state, 'failed');
    await writeFile(path.join(run, 'public', asset.original_url), png); done();
    // A v2 small original is uploaded unchanged and delivered as one frozen card.
    const smallCard = await makeTask('fixture-card-small', png, 'png', true), beforeSmall = { uploads, cards, images, texts };
    expectFrozenTaskId = 'fixture-card-small'; await worker.deliverImageFeishuNotification(prisma, smallCard); expectFrozenTaskId = null;
    const smallMeta = contract.parseImageFeishuEvent((await prisma.notification.findUniqueOrThrow({ where: { id: smallCard.id } })).metadata_json)!;
    assert.equal(smallMeta.version, 2); assert.equal(smallMeta.state, 'sent'); assert.equal(smallMeta.explanation.state, 'skipped');
    assert.equal(uploads - beforeSmall.uploads, 1); assert.equal(cards - beforeSmall.cards, 1); assert.equal(images, beforeSmall.images); assert.equal(texts, beforeSmall.texts);
    assert.ok(imageBytes.at(-1)!.equals(png));
    if (smallMeta.version === 2) {
      assert.equal(smallMeta.presentation!.kind, 'original'); assert.equal(smallMeta.cardPayload, payloads.at(-1)!.content);
      const card = JSON.parse(smallMeta.cardPayload!); assert.equal(card.elements[0].mode, 'fit_horizontal');
      assert.deepEqual(card.elements[0].alt, { tag: 'plain_text', content: '生成图片' });
      assert.equal(card.elements[2].actions[0].text.content, '查看原图');
      assert.equal(card.elements[2].actions[0].url, `${videoContract.VIDEO_FEISHU_SITE}/image-studio/original/${encodeURIComponent(smallMeta.assetId!)}`);
      const visible = JSON.stringify([card.header.title, card.elements[0].alt, card.elements[1], card.elements[2].actions[0].text]);
      assert.ok(!visible.includes('fixture-card-small')); assert.ok(!visible.includes('.png')); assert.ok(!visible.includes('https:'));
      const bad = { ...smallMeta, cardPayload: smallMeta.cardPayload!.replace('查看原图', 'different') };
      assert.equal(contract.parseImageFeishuEvent(JSON.stringify(bad)), null);
      assert.equal(contract.parseImageFeishuEvent(JSON.stringify({ ...smallMeta, version: 1 })), null);
      assert.equal(contract.parseImageFeishuEvent(JSON.stringify({ ...smallMeta, version: 3 })), null);
    }
    await worker.deliverImageFeishuNotification(prisma, smallCard); assert.equal(cards - beforeSmall.cards, 1); done();

    const largeRaw = Buffer.alloc(1900 * 1900 * 4); let seed = 11;
    for (let at = 0; at < largeRaw.length; at++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; largeRaw[at] = at % 4 === 3 ? 128 : seed >>> 24; }
    const largePng = await sharp(largeRaw, { raw: { width: 1900, height: 1900, channels: 4 } }).png().toBuffer();
    assert.ok(largePng.length > contract.IMAGE_FEISHU_MAX_BYTES);
    const largeCard = await makeTask('fixture-card-large', largePng, 'png', true), beforeLarge = { uploads, cards, images, texts };
    expectFrozenTaskId = 'fixture-card-large'; await worker.deliverImageFeishuNotification(prisma, largeCard); expectFrozenTaskId = null;
    const largeMeta = contract.parseImageFeishuEvent((await prisma.notification.findUniqueOrThrow({ where: { id: largeCard.id } })).metadata_json)!;
    assert.equal(largeMeta.version, 2); assert.equal(largeMeta.state, 'sent');
    if (largeMeta.version === 2) { assert.equal(largeMeta.presentation!.kind, 'preview'); assert.ok(largeMeta.cardPayload!.includes('飞书预览图 · 原图 1900×1900')); }
    assert.equal(uploads - beforeLarge.uploads, 1); assert.equal(cards - beforeLarge.cards, 1); assert.equal(images, beforeLarge.images); assert.equal(texts, beforeLarge.texts);
    assert.ok(imageBytes.at(-1)!.length < contract.IMAGE_FEISHU_MAX_BYTES); assert.ok(!imageBytes.at(-1)!.equals(largePng));
    const largeTask = await prisma.imageStudioTask.findUniqueOrThrow({ where: { id: 'fixture-card-large' } });
    const largeAsset = await prisma.asset.findUniqueOrThrow({ where: { id: largeTask.asset_id! } });
    assert.ok((await (await import('node:fs/promises')).readFile(path.join(run, 'public', largeAsset.original_url))).equals(largePng)); done();

    const uncertainCard = await makeTask('fixture-card-unknown', png, 'png', true), beforeCardUnknown = { uploads, cards };
    cardUnknown = true; expectFrozenTaskId = 'fixture-card-unknown'; await worker.deliverImageFeishuNotification(prisma, uncertainCard);
    let uncertainRow = await prisma.notification.findUniqueOrThrow({ where: { id: uncertainCard.id } });
    const uncertainMeta = contract.parseImageFeishuEvent(uncertainRow.metadata_json)!; assert.equal(uncertainMeta.image.ambiguous, true);
    const firstCardAttempt = payloads.at(-1)!; now += 61_000;
    await worker.deliverImageFeishuNotification(prisma, uncertainRow); expectFrozenTaskId = null;
    assert.equal(cards - beforeCardUnknown.cards, 2); assert.equal(uploads - beforeCardUnknown.uploads, 1);
    assert.equal(payloads.at(-1)!.uuid, firstCardAttempt.uuid); assert.equal(payloads.at(-1)!.content, firstCardAttempt.content); done();

    const uncertainUpload = await makeTask('fixture-card-upload-unknown', png, 'png', true), beforeCardUpload = { uploads, cards, texts };
    uploadUnknown = true; await worker.deliverImageFeishuNotification(prisma, uncertainUpload); uploadUnknown = false;
    const uncertainUploadRow = await prisma.notification.findUniqueOrThrow({ where: { id: uncertainUpload.id } });
    assert.equal(contract.parseImageFeishuEvent(uncertainUploadRow.metadata_json)!.state, 'unknown');
    await worker.deliverImageFeishuNotification(prisma, uncertainUploadRow);
    assert.equal(uploads - beforeCardUpload.uploads, 1); assert.equal(cards, beforeCardUpload.cards); assert.equal(texts, beforeCardUpload.texts); done();

    const cardRebound = await makeTask('fixture-card-rebound', png, 'png', true), beforeCardRebound = cards;
    changeBindingOnUpload = true; await worker.deliverImageFeishuNotification(prisma, cardRebound);
    assert.equal(cards, beforeCardRebound);
    assert.equal(contract.parseImageFeishuEvent((await prisma.notification.findUniqueOrThrow({ where: { id: cardRebound.id } })).metadata_json)!.reason, 'binding_changed');
    await prisma.user.update({ where: { id: 'fixture-owner' }, data: { feishu_open_id: 'ou_fixture_owner' } }); done();

    const rejectedCard = await makeTask('fixture-card-rejected', png, 'png', true), beforeRejected = { uploads, cards, texts };
    rejectMessage = true; await worker.deliverImageFeishuNotification(prisma, rejectedCard);
    assert.equal(contract.parseImageFeishuEvent((await prisma.notification.findUniqueOrThrow({ where: { id: rejectedCard.id } })).metadata_json)!.state, 'failed');
    assert.equal(uploads - beforeRejected.uploads, 1); assert.equal(cards - beforeRejected.cards, 1); assert.equal(texts, beforeRejected.texts); done();

    // A legacy durable receipt with an old pending step must never send again.
    const knownReceiptRow = await makeTask('fixture-legacy-known-receipt', tiff, 'tiff');
    const knownReceipt = contract.parseImageFeishuEvent(knownReceiptRow.metadata_json)!;
    knownReceipt.mode = 'link'; knownReceipt.upload.state = 'skipped'; knownReceipt.image.state = 'skipped';
    knownReceipt.explanation.firstSendAt = now; knownReceipt.explanation.attempts = 1;
    knownReceipt.explanation.receiptId = 'om_fixture_already_received'; knownReceipt.explanation.state = 'pending';
    const knownReceiptPending = await prisma.notification.update({ where: { id: knownReceiptRow.id }, data: { metadata_json: JSON.stringify(knownReceipt) } });
    const beforeKnownReceipt = { uploads, cards, texts, images }; await worker.deliverImageFeishuNotification(prisma, knownReceiptPending);
    const knownReceiptAfter = contract.parseImageFeishuEvent((await prisma.notification.findUniqueOrThrow({ where: { id: knownReceiptRow.id } })).metadata_json)!;
    assert.equal(knownReceiptAfter.state, 'sent'); assert.equal(knownReceiptAfter.explanation.state, 'sent');
    assert.equal(knownReceiptAfter.explanation.receiptId, 'om_fixture_already_received');
    assert.deepEqual({ uploads, cards, texts, images }, beforeKnownReceipt); done();

    // Inject one SQLite receipt-save failure, after a successful legacy explanation response.
    // It must retain the durable ambiguous send intent, not rewrite it as a provider rejection or sent-without-receipt.
    const saveFailure = await makeTask('fixture-receipt-save-failure'), beforeSaveFailure = { uploads, images, texts };
    const updateMany = prisma.notification.updateMany.bind(prisma.notification); let failedSave = false;
    const failingNotification = new Proxy(prisma.notification, { get(target, key, receiver) {
      if (key !== 'updateMany') return Reflect.get(target, key, receiver);
      return async (args: Parameters<typeof updateMany>[0]) => {
        const value = args.data?.metadata_json; const next = typeof value === 'string' ? contract.parseImageFeishuEvent(value) : null;
        if (!failedSave && next?.taskId === 'fixture-receipt-save-failure' && next.explanation.receiptId) { failedSave = true; throw new Error('isolated receipt storage failure'); }
        return updateMany(args);
      };
    } });
    const failingDb = new Proxy(prisma, { get(target, key, receiver) {
      return key === 'notification' ? failingNotification : Reflect.get(target, key, receiver);
    } });
    // All other delegates still use the isolated Prisma client.
    assert.equal(await worker.deliverImageFeishuNotification(failingDb, saveFailure), 'lease_lost'); assert.equal(failedSave, true);
    const receiptLost = await prisma.notification.findUniqueOrThrow({ where: { id: saveFailure.id } });
    const receiptLostMeta = contract.parseImageFeishuEvent(receiptLost.metadata_json)!;
    assert.equal(receiptLostMeta.state, 'pending'); assert.equal(receiptLostMeta.explanation.state, 'sending');
    assert.equal(receiptLostMeta.explanation.receiptId, null); assert.equal(receiptLostMeta.explanation.ambiguous, true);
    const lostUuid = receiptLostMeta.explanation.uuid; now += 10 * 60_000;
    await worker.deliverImageFeishuNotification(prisma, receiptLost);
    const recovered = contract.parseImageFeishuEvent((await prisma.notification.findUniqueOrThrow({ where: { id: saveFailure.id } })).metadata_json)!;
    assert.equal(recovered.state, 'sent'); assert.equal(recovered.explanation.state, 'sent'); assert.ok(recovered.explanation.receiptId);
    assert.equal(uploads - beforeSaveFailure.uploads, 1); assert.equal(images - beforeSaveFailure.images, 1); assert.equal(texts - beforeSaveFailure.texts, 2);
    assert.equal(payloads.filter(p => p.uuid === lostUuid).length, 2); done();

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
    console.log(JSON.stringify({ passed: true, cases, uploads, imageMessages: images, explanationAttempts: texts, cardAttempts: cards,
      realSqlite: true, externalRequests: 0, productionWrites: 0, originalFileBytesPreserved: true }));
  } finally {
    process.chdir(sourceRoot); globalThis.fetch = originalFetch; Date.now = originalNow;
    await prisma.$disconnect(); const { feedbackPrisma } = await import('../src/lib/feedback/notification'); await feedbackPrisma.$disconnect();
    await rm(run, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.stack : 'notification engineering failed'); process.exitCode = 1; });
