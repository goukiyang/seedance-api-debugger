import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, realpath, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';

async function main() {
  const sourceRoot = process.cwd(), isolatedRoot = process.env.FEISHU_NOTIFICATION_FIXTURE_ROOT;
  assert.ok(isolatedRoot && path.isAbsolute(isolatedRoot) && !isolatedRoot.startsWith('/data/video-api-debugger/'));
  assert.equal(await realpath(isolatedRoot!), isolatedRoot);
  const run = await mkdtemp(path.join(isolatedRoot!, 'original-notification-run-'));
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${run}/isolated.sqlite`, FEISHU_APP_ID: 'fixture-app', FEISHU_APP_SECRET: 'fixture-placeholder', FEISHU_ALLOWED_TENANT_KEY: 'fixture-tenant' });
  for (const key of Object.keys(process.env).filter(key => key.startsWith('PRIVATE_PROMPTS_'))) delete process.env[key];
  await writeFile(`${run}/isolated.sqlite`, '', { mode: 0o600, flag: 'wx' });
  const initialized = spawnSync(process.execPath, [path.join(sourceRoot, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(sourceRoot, 'prisma/schema.prisma')], { env: process.env, encoding: 'utf8', timeout: 120000 });
  assert.equal(initialized.status, 0, initialized.stderr?.slice(-800));
  const [{ prisma }, notification, contract, worker, output, source, automatic, video, transport] = await Promise.all([
    import('../src/lib/prisma'), import('../src/lib/image-studio/feishu-notification'), import('../src/lib/image-studio/feishu-original-contract'),
    import('../src/lib/image-studio/feishu-original-delivery'), import('../src/lib/image-studio/output'), import('../src/lib/image-studio/feishu-source'),
    import('../src/lib/image-studio/feishu-contract'), import('../src/lib/video/feishu-notification'), import('../src/lib/video/feishu-transport'),
  ]);
  const originalFetch = globalThis.fetch, originalNow = Date.now; let now = originalNow(); Date.now = () => now;
  const uploaded: Array<{ endpoint: string; bytes: Buffer }> = [], messages: Array<Record<string, unknown>> = [];
  let uploadUnknown = false, messageUnknown = false, changeBinding = false, rejectUpload = false;
  globalThis.fetch = async (url, init) => {
    const endpoint = String(url); assert.ok(endpoint.startsWith('https://open.feishu.cn/open-apis/'));
    if (endpoint.endsWith('/auth/v3/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'fixture-token' });
    if (endpoint.endsWith('/im/v1/images') || endpoint.endsWith('/im/v1/files')) {
      const form = init!.body as FormData, file = form.get(endpoint.endsWith('/files') ? 'file' : 'image') as File;
      if (endpoint.endsWith('/files')) { assert.equal(form.get('file_type'), 'stream'); const names: Record<string,string> = { 'image/png': '原图.png', 'image/jpeg': '原图.jpg', 'image/webp': '原图.webp', 'image/avif': '原图.avif', 'image/tiff': '原图.tiff' }; assert.equal(form.get('file_name'), names[file.type]); assert.equal(file.name, names[file.type]); }
      uploaded.push({ endpoint, bytes: Buffer.from(await file.arrayBuffer()) });
      if (uploadUnknown) throw new Error('fixture upload interrupted');
      if (rejectUpload) { rejectUpload = false; return Response.json({ code: 230001 }); }
      if (changeBinding) { changeBinding = false; await prisma.user.update({ where: { id: 'fixture-owner' }, data: { feishu_open_id: 'ou_changed_binding' } }); }
      return Response.json({ code: 0, data: endpoint.endsWith('/files') ? { file_key: `file_fixture_${uploaded.length}` } : { image_key: `img_fixture_${uploaded.length}` } });
    }
    assert.ok(endpoint.endsWith('/im/v1/messages?receive_id_type=open_id'));
    const body = JSON.parse(String(init!.body)); assert.equal(body.receive_id, 'ou_fixture_owner'); messages.push(body);
    const rows = await prisma.notification.findMany({ where: { type: contract.IMAGE_FEISHU_ORIGINAL_TYPE } });
    const frozen = rows.map(row => contract.parseOriginalImageFeishuEvent(row.metadata_json)).find(meta => meta?.message.uuid === body.uuid || meta?.version === 2 && meta.navigationStep.uuid === body.uuid)!;
    assert.ok(frozen); assert.equal(body.msg_type === 'post' && frozen.version === 2 ? frozen.navigationPayload : frozen.payload, body.content); assert.equal(frozen.fileName, frozen.version === 1 ? '原图' : frozen.mode === 'file' ? contract.originalImageFeishuFileName(frozen.source!) : null); assert.ok(frozen.source?.contentHash);
    if (messageUnknown) { messageUnknown = false; return new Response('', { status: 502 }); }
    return Response.json({ code: 0, data: { message_id: `om_fixture_${body.uuid.replaceAll('-', '')}` } });
  };
  let cases = 0; const done = () => { cases++; };
  try {
    process.chdir(run); await mkdir('public/uploads', { recursive: true });
    for (const id of ['fixture-owner','fixture-other']) await prisma.user.create({ data: { id, name: 'Fixture', username: id, email: `${id}@example.invalid`, password_hash: 'fixture-only', role: 'admin', feishu_open_id: id === 'fixture-owner' ? 'ou_fixture_owner' : 'ou_fixture_other', feishu_tenant_key: 'fixture-tenant' } });
    const small = await sharp({ create: { width: 32, height: 48, channels: 4, background: { r: 22, g: 44, b: 88, alpha: 0.5 } } }).png().toBuffer();
    const makeTask = async (id: string, bytes = small, format = 'png') => {
      const dimensions = await sharp(bytes).metadata();
      const task = await prisma.imageStudioTask.create({ data: { id, batch_id: `batch-${id}`, owner_id: 'fixture-owner', module_id: 'fixture-module', ordinal: 1, fingerprint: id,
        prompt: 'PRIVATE_PROMPT_MARKER', context: 'PRIVATE_REFERENCE_MARKER', revision: 1, model: 'fixture-image', reference_ids: '[]', unit_credits: 0, status: 'succeeded' } });
      const asset = await output.prepareStudioOutput(bytes, task, { width: dimensions.width!, height: dimensions.height! }, async () => {}, format);
      const saved = await prisma.asset.upsert({ where: { owner_id_hash: { owner_id: 'fixture-owner', hash: asset.hash! } }, create: asset, update: {} });
      await prisma.imageStudioTask.update({ where: { id }, data: { asset_id: saved.id } }); return { task, asset: saved };
    };
    const rowFor = (taskId: string) => prisma.notification.findUniqueOrThrow({ where: { id: contract.originalImageFeishuUuid(taskId, 'event') } });
    const first = await makeTask('original-small'); assert.equal((await notification.readImageFeishuPreference(prisma, 'fixture-owner')).enabled, false);
    assert.equal((await notification.readOriginalImageFeishuStatus(prisma, 'fixture-owner', first.task.id)).canSend, true);
    await Promise.all([notification.requestOriginalImageFeishu(prisma, 'fixture-owner', first.task.id), notification.requestOriginalImageFeishu(prisma, 'fixture-owner', first.task.id)]);
    assert.equal(await prisma.notification.count(), 1); const firstRow = await rowFor(first.task.id);
    await Promise.all([worker.deliverOriginalImageFeishuNotification(prisma, firstRow), worker.deliverOriginalImageFeishuNotification(prisma, firstRow)]);
    assert.equal(uploaded.length, 1); assert.equal(messages.length, 1); assert.ok(uploaded[0].bytes.equals(small)); assert.equal(messages[0].msg_type, 'interactive');
    assert.equal((await notification.readOriginalImageFeishuStatus(prisma, 'fixture-owner', first.task.id)).originalSent, true);
    await notification.requestOriginalImageFeishu(prisma, 'fixture-owner', first.task.id); await worker.deliverOriginalImageFeishuNotification(prisma, await rowFor(first.task.id));
    assert.equal(messages.length, 1); assert.equal((await notification.readImageFeishuPreference(prisma, 'fixture-owner')).enabled, false); done();

    const noise = (width: number, height: number) => { const raw = Buffer.alloc(width * height * 4); let seed = 27; for (let at = 0; at < raw.length; at++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; raw[at] = seed >>> 24; } return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer(); };
    const large = await noise(1900,1900); assert.ok(large.length > automatic.IMAGE_FEISHU_MAX_BYTES && large.length < contract.IMAGE_FEISHU_ORIGINAL_MAX_BYTES);
    const big = await makeTask('original-large', large); await notification.requestOriginalImageFeishu(prisma, 'fixture-owner', big.task.id);
    await worker.deliverOriginalImageFeishuNotification(prisma, await rowFor(big.task.id));
    const bigUpload = uploaded.at(-1)!; assert.ok(bigUpload.endpoint.endsWith('/files')); assert.ok(bigUpload.bytes.equals(large));
    assert.equal(messages.filter(message => message.msg_type === 'file').at(-1)!.msg_type, 'file'); assert.deepEqual(Object.keys(JSON.parse(String(messages.filter(message => message.msg_type === 'file').at(-1)!.content))), ['file_key']);
    assert.ok((await readFile(path.join(run, 'public', big.asset.original_url))).equals(large));
    assert.equal(createHash('sha256').update(bigUpload.bytes).digest('hex'), big.asset.hash); assert.deepEqual(await sharp(bigUpload.bytes).metadata(), await sharp(large).metadata()); done();

    await assert.rejects(notification.requestOriginalImageFeishu(prisma, 'fixture-other', big.task.id));
    const bound = await makeTask('original-binding'); await notification.requestOriginalImageFeishu(prisma, 'fixture-owner', bound.task.id);
    await prisma.user.update({ where: { id: 'fixture-owner' }, data: { feishu_open_id: 'ou_changed_binding' } });
    const beforeBinding = uploaded.length; await worker.deliverOriginalImageFeishuNotification(prisma, await rowFor(bound.task.id)); assert.equal(uploaded.length, beforeBinding);
    await prisma.user.update({ where: { id: 'fixture-owner' }, data: { feishu_open_id: 'ou_fixture_owner' } }); done();

    const uncertainUpload = await makeTask('original-upload-unknown'); await notification.requestOriginalImageFeishu(prisma, 'fixture-owner', uncertainUpload.task.id);
    const beforeUploadUnknown = { uploads: uploaded.length, messages: messages.length }; uploadUnknown = true;
    await worker.deliverOriginalImageFeishuNotification(prisma, await rowFor(uncertainUpload.task.id)); uploadUnknown = false;
    const uploadUnknownRow = await rowFor(uncertainUpload.task.id), uploadUnknownRaw = uploadUnknownRow.metadata_json;
    assert.equal((await notification.requestOriginalImageFeishu(prisma, 'fixture-owner', uncertainUpload.task.id)).state, 'unknown');
    await worker.deliverOriginalImageFeishuNotification(prisma, uploadUnknownRow); await assert.rejects(notification.changeOriginalImageFeishu(prisma, 'fixture-owner', uncertainUpload.task.id, 'retry'));
    assert.equal(uploaded.length - beforeUploadUnknown.uploads, 1); assert.equal(messages.length, beforeUploadUnknown.messages); assert.equal((await rowFor(uncertainUpload.task.id)).metadata_json, uploadUnknownRaw); done();

    const uncertainMessage = await makeTask('original-message-unknown'); await notification.requestOriginalImageFeishu(prisma, 'fixture-owner', uncertainMessage.task.id);
    const beforeMessageUnknown = { uploads: uploaded.length, messages: messages.length }; messageUnknown = true;
    await worker.deliverOriginalImageFeishuNotification(prisma, await rowFor(uncertainMessage.task.id)); const messageUnknownRow = await rowFor(uncertainMessage.task.id);
    const unknownMeta = contract.parseOriginalImageFeishuEvent(messageUnknownRow.metadata_json)!; assert.equal(unknownMeta.state, 'unknown'); assert.equal(unknownMeta.message.ambiguous, true);
    now += 51 * 60_000; await notification.requestOriginalImageFeishu(prisma, 'fixture-owner', uncertainMessage.task.id); await worker.deliverOriginalImageFeishuNotification(prisma, messageUnknownRow);
    assert.equal(uploaded.length - beforeMessageUnknown.uploads, 1); assert.equal(messages.length - beforeMessageUnknown.messages, 1); assert.equal((await rowFor(uncertainMessage.task.id)).metadata_json, messageUnknownRow.metadata_json); done();

    const afterUploadBinding = await makeTask('original-after-upload-binding'); await notification.requestOriginalImageFeishu(prisma, 'fixture-owner', afterUploadBinding.task.id);
    const beforeAfterBinding = messages.length; changeBinding = true; await worker.deliverOriginalImageFeishuNotification(prisma, await rowFor(afterUploadBinding.task.id));
    assert.equal(messages.length, beforeAfterBinding); await prisma.user.update({ where: { id: 'fixture-owner' }, data: { feishu_open_id: 'ou_fixture_owner' } }); done();

    const rejected = await makeTask('original-rejected'); await notification.requestOriginalImageFeishu(prisma, 'fixture-owner', rejected.task.id); rejectUpload = true;
    const beforeRejected = messages.length; await worker.deliverOriginalImageFeishuNotification(prisma, await rowFor(rejected.task.id)); assert.equal(messages.length, beforeRejected);
    assert.equal((await notification.readOriginalImageFeishuStatus(prisma, 'fixture-owner', rejected.task.id)).canRetry, true);
    await notification.changeOriginalImageFeishu(prisma, 'fixture-owner', rejected.task.id, 'retry'); await worker.deliverOriginalImageFeishuNotification(prisma, await rowFor(rejected.task.id));
    assert.equal((await notification.readOriginalImageFeishuStatus(prisma, 'fixture-owner', rejected.task.id)).state, 'sent'); done();

    const identity = video.videoFeishuBinding((await notification.authorizedImageFeishuTask(prisma, 'fixture-owner', first.task.id)).actor)!;
    for (const version of [1,2] as const) {
      const existing = await makeTask(`automatic-original-v${version}`), prepared = await source.prepareImageFeishuSource(await notification.authorizedImageFeishuTask(prisma, 'fixture-owner', existing.task.id), version);
      const auto = automatic.newImageFeishuEvent(existing.task.id, { version: 1, actorId: 'fixture-owner', identity, choice: { version: 1, enabled: true, preferenceRevision: 1 } });
      const meta = JSON.parse(JSON.stringify(auto)); meta.version = version; delete meta.navigation; delete meta.cardTemplateSha256; delete meta.cardPayloadSha256; if (version === 1) { meta.version = 1; delete meta.presentation; delete meta.cardTemplate; delete meta.cardPayload; meta.explanation.state = 'pending'; }
      else { meta.presentation = prepared.presentation; meta.cardTemplate = automatic.imageFeishuCardTemplate(existing.asset.id, prepared.presentation!); meta.cardPayload = automatic.imageFeishuCardPayload(meta.cardTemplate, 'img_existing'); }
      Object.assign(meta, { state: 'sent', sourceVersion: prepared.version, contentHash: prepared.contentHash, assetId: existing.asset.id });
      Object.assign(meta.upload, { state: 'ready', key: 'img_existing', startedAt: now, attempts: 1 }); Object.assign(meta.image, { state: 'sent', firstSendAt: now, receiptId: 'om_existing', attempts: 1 });
      const raw = JSON.stringify(meta); await prisma.notification.create({ data: { id: meta.eventId, type: automatic.IMAGE_FEISHU_TYPE, channel: 'feishu', status: 'sent', target_user_id: 'fixture-owner', title: 'Fixture', metadata_json: raw } });
      assert.equal((await notification.requestOriginalImageFeishu(prisma, 'fixture-owner', existing.task.id)).originalSent, true);
      assert.equal(await prisma.notification.count({ where: { id: contract.originalImageFeishuUuid(existing.task.id, 'event') } }), 0);
      assert.equal((await prisma.notification.findUniqueOrThrow({ where: { id: meta.eventId } })).metadata_json, raw);
    } done();

    const preview = await makeTask('automatic-preview', large), previewSource = await source.prepareImageFeishuSource(await notification.authorizedImageFeishuTask(prisma, 'fixture-owner', preview.task.id), 2);
    assert.equal(previewSource.presentation!.kind, 'preview');
    const autoPreviewRaw = JSON.parse(JSON.stringify(automatic.newImageFeishuEvent(preview.task.id, { version: 1, actorId: 'fixture-owner', identity, choice: { version: 1, enabled: true, preferenceRevision: 1 } })));
    autoPreviewRaw.version = 2; delete autoPreviewRaw.navigation; delete autoPreviewRaw.cardTemplateSha256; delete autoPreviewRaw.cardPayloadSha256;
    const autoPreview = automatic.parseImageFeishuEvent(JSON.stringify(autoPreviewRaw))!;
    assert.equal(autoPreview.version, 2); if (autoPreview.version === 2) {
      autoPreview.presentation = previewSource.presentation!; autoPreview.sourceVersion = previewSource.version; autoPreview.contentHash = previewSource.contentHash; autoPreview.assetId = preview.asset.id;
      autoPreview.cardTemplate = automatic.imageFeishuCardTemplate(preview.asset.id, autoPreview.presentation); autoPreview.cardPayload = automatic.imageFeishuCardPayload(autoPreview.cardTemplate, 'img_preview');
      Object.assign(autoPreview.upload, { state: 'ready', key: 'img_preview', startedAt: now, attempts: 1 }); Object.assign(autoPreview.image, { state: 'sent', firstSendAt: now, receiptId: 'om_preview', attempts: 1 }); autoPreview.state = 'sent';
    }
    const previewRaw = JSON.stringify(autoPreview); await prisma.notification.create({ data: { id: autoPreview.eventId, type: automatic.IMAGE_FEISHU_TYPE, channel: 'feishu', status: 'sent', target_user_id: 'fixture-owner', title: 'Fixture', metadata_json: previewRaw } });
    assert.equal((await notification.readOriginalImageFeishuStatus(prisma, 'fixture-owner', preview.task.id)).canSend, true);
    await notification.requestOriginalImageFeishu(prisma, 'fixture-owner', preview.task.id); await worker.deliverOriginalImageFeishuNotification(prisma, await rowFor(preview.task.id));
    assert.equal(messages.filter(message => message.msg_type === 'file').at(-1)!.msg_type, 'file'); assert.ok(uploaded.at(-1)!.bytes.equals(large)); assert.equal((await prisma.notification.findUniqueOrThrow({ where: { id: autoPreview.eventId } })).metadata_json, previewRaw); done();

    const over = await noise(2496,3312); assert.ok(over.length > contract.IMAGE_FEISHU_ORIGINAL_MAX_BYTES);
    const oversized = await makeTask('original-over-limit', over), overView = await notification.readOriginalImageFeishuStatus(prisma, 'fixture-owner', oversized.task.id);
    assert.equal(overView.canSend, false); assert.equal(overView.reason, 'image_original_too_large');
    const beforeOver = uploaded.length; await assert.rejects(notification.requestOriginalImageFeishu(prisma, 'fixture-owner', oversized.task.id));
    await assert.rejects(source.prepareImageFeishuSource(await notification.authorizedImageFeishuTask(prisma, 'fixture-owner', oversized.task.id), 'original'));
    assert.equal(uploaded.length, beforeOver); assert.ok((await readFile(path.join(run, 'public', oversized.asset.original_url))).equals(over)); done();

    // Actual decoded sources define both multipart filename fields; their bytes stay unchanged.
    const formats = [
      { format: 'png', bytes: small, name: '原图.png' }, { format: 'jpeg', bytes: await sharp(small).jpeg().toBuffer(), name: '原图.jpg' },
      { format: 'webp', bytes: await sharp(small).webp().toBuffer(), name: '原图.webp' }, { format: 'avif', bytes: await sharp(small).avif().toBuffer(), name: '原图.avif' },
      { format: 'tiff', bytes: await sharp(small).tiff().toBuffer(), name: '原图.tiff' },
    ];
    for (const item of formats) {
      const task = await makeTask(`format-${item.format}`, item.bytes, item.format);
      const prepared = await source.prepareImageFeishuSource(await notification.authorizedImageFeishuTask(prisma, 'fixture-owner', task.task.id), 'original');
      const name = contract.originalImageFeishuFileName(prepared); assert.equal(name, item.name);
      await transport.uploadImageFeishuFile('fixture-token', prepared.file!, name!); assert.ok(uploaded.at(-1)!.bytes.equals(item.bytes));
    }
    const beforeBadName = uploaded.length;
    await assert.rejects(transport.uploadImageFeishuFile('fixture-token', new Blob([Uint8Array.from(small)], { type: 'image/png' }), '原图.jpg'));
    assert.equal(uploaded.length, beforeBadName); assert.equal(contract.originalImageFeishuFileName({ mimeType: 'image/jpeg', extension: 'png' }), null);
    const fakePng = await sharp({ create: { width: 33, height: 49, channels: 3, background: '#345678' } }).avif().toBuffer();
    const wrongMime = await makeTask('format-avif-wrong-mime', fakePng, 'png');
    await assert.rejects(source.prepareImageFeishuSource(await notification.authorizedImageFeishuTask(prisma, 'fixture-owner', wrongMime.task.id), 'original'));
    assert.equal(uploaded.length, beforeBadName); done();

    const frozenSource = async (taskId: string) => {
      const prepared = await source.prepareImageFeishuSource(await notification.authorizedImageFeishuTask(prisma, 'fixture-owner', taskId), 'original');
      return { version: prepared.version, contentHash: prepared.contentHash, assetId: prepared.assetId, size: prepared.size,
        width: prepared.width, height: prepared.height, mimeType: prepared.mimeType, extension: prepared.extension };
    };
    const legacyRow = async (taskId: string) => {
      await notification.requestOriginalImageFeishu(prisma, 'fixture-owner', taskId); const row = await rowFor(taskId);
      const raw = JSON.parse(row.metadata_json!); raw.version = 1; raw.fileName = '原图';
      for (const key of ['navigation','navigationStep','navigationPayload','navigationPayloadSha256','templateSha256','payloadSha256']) delete raw[key];
      const meta = contract.parseOriginalImageFeishuEvent(JSON.stringify(raw)); assert.ok(meta && meta.version === 1);
      return { row, meta };
    };
    const untouched = await makeTask('legacy-unstarted-file', large), old = await legacyRow(untouched.task.id);
    old.meta.preparations = 3; old.meta.createdAt -= 5000;
    const pendingLegacy = await prisma.notification.update({ where: { id: old.row.id }, data: { metadata_json: JSON.stringify(old.meta) } });
    assert.ok(contract.parseOriginalImageFeishuEvent(pendingLegacy.metadata_json));
    await worker.deliverOriginalImageFeishuNotification(prisma, pendingLegacy);
    const upgraded = contract.parseOriginalImageFeishuEvent((await rowFor(untouched.task.id)).metadata_json)!;
    assert.equal(upgraded.version, 2); assert.equal(upgraded.fileName, '原图.png'); assert.equal(upgraded.eventId, old.meta.eventId);
    assert.equal(upgraded.message.uuid, old.meta.message.uuid); assert.equal(upgraded.createdAt, old.meta.createdAt); assert.equal(upgraded.preparations, 3); done();

    const alreadyUploaded = await makeTask('legacy-upload-ready', large), readyLegacy = await legacyRow(alreadyUploaded.task.id);
    readyLegacy.meta.source = await frozenSource(alreadyUploaded.task.id); readyLegacy.meta.mode = 'file';
    readyLegacy.meta.template = contract.originalImageFeishuTemplate('file', readyLegacy.meta.source);
    readyLegacy.meta.upload = { state: 'ready', key: 'legacy_file_key', startedAt: now, attempts: 1 }; readyLegacy.meta.externalStartedAt = now;
    readyLegacy.meta.payload = contract.originalImageFeishuPayload('file', readyLegacy.meta.template, 'legacy_file_key');
    const readyLegacyRow = await prisma.notification.update({ where: { id: readyLegacy.row.id }, data: { metadata_json: JSON.stringify(readyLegacy.meta) } });
    const beforeLegacyReady = { uploads: uploaded.length, messages: messages.length };
    await worker.deliverOriginalImageFeishuNotification(prisma, readyLegacyRow);
    const legacySent = contract.parseOriginalImageFeishuEvent((await rowFor(alreadyUploaded.task.id)).metadata_json)!;
    assert.equal(legacySent.version, 1); assert.equal(legacySent.fileName, '原图'); assert.equal(uploaded.length, beforeLegacyReady.uploads);
    assert.equal(messages.length - beforeLegacyReady.messages, 1); assert.equal(messages.at(-1)!.content, readyLegacy.meta.payload); done();

    const rejectedLegacyTask = await makeTask('legacy-upload-rejected', large), rejectedLegacy = await legacyRow(rejectedLegacyTask.task.id);
    rejectedLegacy.meta.source = await frozenSource(rejectedLegacyTask.task.id); rejectedLegacy.meta.mode = 'file';
    rejectedLegacy.meta.template = contract.originalImageFeishuTemplate('file', rejectedLegacy.meta.source);
    rejectedLegacy.meta.state = 'failed'; rejectedLegacy.meta.reason = 'image_upload_rejected'; rejectedLegacy.meta.message.state = 'failed';
    rejectedLegacy.meta.upload = { state: 'pending', attempts: 1, startedAt: now, key: null }; rejectedLegacy.meta.externalStartedAt = now;
    await prisma.notification.update({ where: { id: rejectedLegacy.row.id }, data: { status: 'failed', metadata_json: JSON.stringify(rejectedLegacy.meta) } });
    assert.equal((await notification.readOriginalImageFeishuStatus(prisma, 'fixture-owner', rejectedLegacyTask.task.id)).canRetry, true);
    await notification.changeOriginalImageFeishu(prisma, 'fixture-owner', rejectedLegacyTask.task.id, 'retry');
    const retryLegacyRow = await rowFor(rejectedLegacyTask.task.id), retryLegacy = contract.parseOriginalImageFeishuEvent(retryLegacyRow.metadata_json)!;
    assert.equal(retryLegacy.version, 1); assert.equal(retryLegacy.reason, 'image_upload_rejected'); assert.equal(retryLegacy.upload.attempts, 1);
    const beforeLegacyRetry = { uploads: uploaded.length, messages: messages.length };
    await worker.deliverOriginalImageFeishuNotification(prisma, retryLegacyRow);
    const retriedLegacy = contract.parseOriginalImageFeishuEvent((await rowFor(rejectedLegacyTask.task.id)).metadata_json)!;
    assert.equal(retriedLegacy.state, 'sent'); assert.equal(retriedLegacy.version, 2); assert.equal(retriedLegacy.fileName, '原图.png');
    assert.equal(retriedLegacy.eventId, rejectedLegacy.meta.eventId); assert.equal(retriedLegacy.message.uuid, rejectedLegacy.meta.message.uuid);
    assert.equal(retriedLegacy.createdAt, rejectedLegacy.meta.createdAt); assert.equal(retriedLegacy.upload.attempts, 2);
    assert.deepEqual(retriedLegacy.source, rejectedLegacy.meta.source); assert.equal(retriedLegacy.template, rejectedLegacy.meta.template);
    assert.equal(uploaded.length - beforeLegacyRetry.uploads, 1); assert.equal(messages.length - beforeLegacyRetry.messages, 2);
    assert.ok(uploaded.at(-1)!.bytes.equals(large)); assert.deepEqual(messages.slice(beforeLegacyRetry.messages).map(message => message.msg_type), ['file','post']); done();

    const started = await makeTask('legacy-upload-started', large), startedLegacy = await legacyRow(started.task.id);
    startedLegacy.meta.source = await frozenSource(started.task.id); startedLegacy.meta.mode = 'file';
    startedLegacy.meta.template = contract.originalImageFeishuTemplate('file', startedLegacy.meta.source);
    startedLegacy.meta.upload.attempts = 1; startedLegacy.meta.upload.startedAt = now; startedLegacy.meta.externalStartedAt = now;
    const startedRow = await prisma.notification.update({ where: { id: startedLegacy.row.id }, data: { metadata_json: JSON.stringify(startedLegacy.meta) } });
    const beforeLegacyStarted = { uploads: uploaded.length, messages: messages.length };
    await worker.deliverOriginalImageFeishuNotification(prisma, startedRow);
    const stoppedLegacy = contract.parseOriginalImageFeishuEvent((await rowFor(started.task.id)).metadata_json)!;
    assert.equal(stoppedLegacy.version, 1); assert.equal(stoppedLegacy.fileName, '原图'); assert.equal(stoppedLegacy.reason, 'legacy_file_name_unavailable');
    assert.deepEqual({ uploads: uploaded.length, messages: messages.length }, beforeLegacyStarted); done();

    for (const state of ['sent','failed','cancelled','unknown'] as const) {
      const historical = await makeTask(`legacy-${state}`, large), previous = await legacyRow(historical.task.id); previous.meta.state = state;
      const raw = JSON.stringify(previous.meta), row = await prisma.notification.update({ where: { id: previous.row.id }, data: { status: state === 'sent' ? 'sent' : 'failed', metadata_json: raw } });
      await worker.deliverOriginalImageFeishuNotification(prisma, row); assert.equal((await rowFor(historical.task.id)).metadata_json, raw);
    }
    const ambiguous = await makeTask('legacy-upload-ambiguous', large), previousAmbiguous = await legacyRow(ambiguous.task.id);
    previousAmbiguous.meta.source = await frozenSource(ambiguous.task.id); previousAmbiguous.meta.mode = 'file';
    previousAmbiguous.meta.template = contract.originalImageFeishuTemplate('file', previousAmbiguous.meta.source);
    previousAmbiguous.meta.upload = { state: 'unknown', attempts: 1, startedAt: now, key: null }; previousAmbiguous.meta.externalStartedAt = now;
    const ambiguousRow = await prisma.notification.update({ where: { id: previousAmbiguous.row.id }, data: { metadata_json: JSON.stringify(previousAmbiguous.meta) } });
    const beforeAmbiguous = uploaded.length; await worker.deliverOriginalImageFeishuNotification(prisma, ambiguousRow);
    const ambiguousAfter = contract.parseOriginalImageFeishuEvent((await rowFor(ambiguous.task.id)).metadata_json)!;
    assert.equal(ambiguousAfter.state, 'unknown'); assert.equal(ambiguousAfter.version, 1); assert.equal(uploaded.length, beforeAmbiguous); done();

    const cancelled = await makeTask('original-cancel'); await notification.requestOriginalImageFeishu(prisma, 'fixture-owner', cancelled.task.id);
    await notification.changeOriginalImageFeishu(prisma, 'fixture-owner', cancelled.task.id, 'cancel'); const beforeCancel = uploaded.length;
    await worker.deliverOriginalImageFeishuNotification(prisma, await rowFor(cancelled.task.id)); assert.equal(uploaded.length, beforeCancel);
    const recorded = contract.parseOriginalImageFeishuEvent((await rowFor(big.task.id)).metadata_json)!; assert.equal(recorded.state, 'sent');
    assert.ok(contract.parseOriginalImageFeishuEvent(JSON.stringify(recorded))); assert.equal(contract.parseOriginalImageFeishuEvent(JSON.stringify({ ...recorded, fileName: 'source.png' })), null);
    assert.equal(contract.parseOriginalImageFeishuEvent(JSON.stringify({ ...recorded, fileName: '原图.jpg' })), null);
    const legacy = JSON.parse(JSON.stringify(recorded)); legacy.version = 1; legacy.fileName = '原图';
    for (const key of ['navigation','navigationStep','navigationPayload','navigationPayloadSha256','templateSha256','payloadSha256']) delete legacy[key];
    assert.ok(contract.parseOriginalImageFeishuEvent(JSON.stringify(legacy)));
    assert.equal(contract.parseOriginalImageFeishuEvent(JSON.stringify({ ...legacy, fileName: '原图.png' })), null);
    assert.equal(automatic.parseImageFeishuEvent(JSON.stringify(recorded)), null); assert.ok(!JSON.stringify(messages).includes('PRIVATE_')); done();
    console.log(JSON.stringify({ passed: true, cases, uploaded: uploaded.length, messages: messages.length, largeOriginalBytes: large.length, oversizedOriginalBytes: over.length, realSqlite: true, externalRequests: 0, productionWrites: 0, originalBytesPreserved: true }));
  } finally {
    process.chdir(sourceRoot); globalThis.fetch = originalFetch; Date.now = originalNow; await prisma.$disconnect();
    const { feedbackPrisma } = await import('../src/lib/feedback/notification'); await feedbackPrisma.$disconnect(); await rm(run, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.stack : 'original notification engineering failed'); process.exitCode = 1; });
