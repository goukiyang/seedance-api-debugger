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
  const [{ prisma }, notification, contract, worker, output, source, automatic, video] = await Promise.all([
    import('../src/lib/prisma'), import('../src/lib/image-studio/feishu-notification'), import('../src/lib/image-studio/feishu-original-contract'),
    import('../src/lib/image-studio/feishu-original-delivery'), import('../src/lib/image-studio/output'), import('../src/lib/image-studio/feishu-source'),
    import('../src/lib/image-studio/feishu-contract'), import('../src/lib/video/feishu-notification'),
  ]);
  const originalFetch = globalThis.fetch, originalNow = Date.now; let now = originalNow(); Date.now = () => now;
  const uploaded: Array<{ endpoint: string; bytes: Buffer }> = [], messages: Array<Record<string, unknown>> = [];
  let uploadUnknown = false, messageUnknown = false, changeBinding = false, rejectUpload = false;
  globalThis.fetch = async (url, init) => {
    const endpoint = String(url); assert.ok(endpoint.startsWith('https://open.feishu.cn/open-apis/'));
    if (endpoint.endsWith('/auth/v3/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'fixture-token' });
    if (endpoint.endsWith('/im/v1/images') || endpoint.endsWith('/im/v1/files')) {
      const form = init!.body as FormData, file = form.get(endpoint.endsWith('/files') ? 'file' : 'image') as File;
      if (endpoint.endsWith('/files')) { assert.equal(form.get('file_type'), 'stream'); assert.equal(form.get('file_name'), '原图'); assert.equal(file.name, '原图'); }
      uploaded.push({ endpoint, bytes: Buffer.from(await file.arrayBuffer()) });
      if (uploadUnknown) throw new Error('fixture upload interrupted');
      if (rejectUpload) { rejectUpload = false; return Response.json({ code: 230001 }); }
      if (changeBinding) { changeBinding = false; await prisma.user.update({ where: { id: 'fixture-owner' }, data: { feishu_open_id: 'ou_changed_binding' } }); }
      return Response.json({ code: 0, data: endpoint.endsWith('/files') ? { file_key: `file_fixture_${uploaded.length}` } : { image_key: `img_fixture_${uploaded.length}` } });
    }
    assert.ok(endpoint.endsWith('/im/v1/messages?receive_id_type=open_id'));
    const body = JSON.parse(String(init!.body)); assert.equal(body.receive_id, 'ou_fixture_owner'); messages.push(body);
    const rows = await prisma.notification.findMany({ where: { type: contract.IMAGE_FEISHU_ORIGINAL_TYPE } });
    const frozen = rows.map(row => contract.parseOriginalImageFeishuEvent(row.metadata_json)).find(meta => meta?.message.uuid === body.uuid)!;
    assert.ok(frozen); assert.equal(frozen.payload, body.content); assert.equal(frozen.fileName, '原图'); assert.ok(frozen.source?.contentHash);
    if (messageUnknown) { messageUnknown = false; return new Response('', { status: 502 }); }
    return Response.json({ code: 0, data: { message_id: `om_fixture_${body.uuid.replaceAll('-', '')}` } });
  };
  let cases = 0; const done = () => { cases++; };
  try {
    process.chdir(run); await mkdir('public/uploads', { recursive: true });
    for (const id of ['fixture-owner','fixture-other']) await prisma.user.create({ data: { id, name: 'Fixture', username: id, email: `${id}@example.invalid`, password_hash: 'fixture-only', role: 'admin', feishu_open_id: id === 'fixture-owner' ? 'ou_fixture_owner' : 'ou_fixture_other', feishu_tenant_key: 'fixture-tenant' } });
    const small = await sharp({ create: { width: 32, height: 48, channels: 4, background: { r: 22, g: 44, b: 88, alpha: 0.5 } } }).png().toBuffer();
    const makeTask = async (id: string, bytes = small) => {
      const dimensions = await sharp(bytes).metadata();
      const task = await prisma.imageStudioTask.create({ data: { id, batch_id: `batch-${id}`, owner_id: 'fixture-owner', module_id: 'fixture-module', ordinal: 1, fingerprint: id,
        prompt: 'PRIVATE_PROMPT_MARKER', context: 'PRIVATE_REFERENCE_MARKER', revision: 1, model: 'fixture-image', reference_ids: '[]', unit_credits: 0, status: 'succeeded' } });
      const asset = await output.prepareStudioOutput(bytes, task, { width: dimensions.width!, height: dimensions.height! }, async () => {}, 'png');
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
    assert.equal(messages.at(-1)!.msg_type, 'file'); assert.deepEqual(Object.keys(JSON.parse(String(messages.at(-1)!.content))), ['file_key']);
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
      const meta = JSON.parse(JSON.stringify(auto)); if (version === 1) { meta.version = 1; delete meta.presentation; delete meta.cardTemplate; delete meta.cardPayload; meta.explanation.state = 'pending'; }
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
    const autoPreview = automatic.newImageFeishuEvent(preview.task.id, { version: 1, actorId: 'fixture-owner', identity, choice: { version: 1, enabled: true, preferenceRevision: 1 } });
    assert.equal(autoPreview.version, 2); if (autoPreview.version === 2) {
      autoPreview.presentation = previewSource.presentation!; autoPreview.sourceVersion = previewSource.version; autoPreview.contentHash = previewSource.contentHash; autoPreview.assetId = preview.asset.id;
      autoPreview.cardTemplate = automatic.imageFeishuCardTemplate(preview.asset.id, autoPreview.presentation); autoPreview.cardPayload = automatic.imageFeishuCardPayload(autoPreview.cardTemplate, 'img_preview');
      Object.assign(autoPreview.upload, { state: 'ready', key: 'img_preview', startedAt: now, attempts: 1 }); Object.assign(autoPreview.image, { state: 'sent', firstSendAt: now, receiptId: 'om_preview', attempts: 1 }); autoPreview.state = 'sent';
    }
    const previewRaw = JSON.stringify(autoPreview); await prisma.notification.create({ data: { id: autoPreview.eventId, type: automatic.IMAGE_FEISHU_TYPE, channel: 'feishu', status: 'sent', target_user_id: 'fixture-owner', title: 'Fixture', metadata_json: previewRaw } });
    assert.equal((await notification.readOriginalImageFeishuStatus(prisma, 'fixture-owner', preview.task.id)).canSend, true);
    await notification.requestOriginalImageFeishu(prisma, 'fixture-owner', preview.task.id); await worker.deliverOriginalImageFeishuNotification(prisma, await rowFor(preview.task.id));
    assert.equal(messages.at(-1)!.msg_type, 'file'); assert.ok(uploaded.at(-1)!.bytes.equals(large)); assert.equal((await prisma.notification.findUniqueOrThrow({ where: { id: autoPreview.eventId } })).metadata_json, previewRaw); done();

    const over = await noise(2496,3312); assert.ok(over.length > contract.IMAGE_FEISHU_ORIGINAL_MAX_BYTES);
    const oversized = await makeTask('original-over-limit', over), overView = await notification.readOriginalImageFeishuStatus(prisma, 'fixture-owner', oversized.task.id);
    assert.equal(overView.canSend, false); assert.equal(overView.reason, 'image_original_too_large');
    const beforeOver = uploaded.length; await assert.rejects(notification.requestOriginalImageFeishu(prisma, 'fixture-owner', oversized.task.id));
    await assert.rejects(source.prepareImageFeishuSource(await notification.authorizedImageFeishuTask(prisma, 'fixture-owner', oversized.task.id), 'original'));
    assert.equal(uploaded.length, beforeOver); assert.ok((await readFile(path.join(run, 'public', oversized.asset.original_url))).equals(over)); done();

    const cancelled = await makeTask('original-cancel'); await notification.requestOriginalImageFeishu(prisma, 'fixture-owner', cancelled.task.id);
    await notification.changeOriginalImageFeishu(prisma, 'fixture-owner', cancelled.task.id, 'cancel'); const beforeCancel = uploaded.length;
    await worker.deliverOriginalImageFeishuNotification(prisma, await rowFor(cancelled.task.id)); assert.equal(uploaded.length, beforeCancel);
    const recorded = contract.parseOriginalImageFeishuEvent((await rowFor(big.task.id)).metadata_json)!; assert.equal(recorded.state, 'sent');
    assert.ok(contract.parseOriginalImageFeishuEvent(JSON.stringify(recorded))); assert.equal(contract.parseOriginalImageFeishuEvent(JSON.stringify({ ...recorded, fileName: 'source.png' })), null);
    assert.equal(automatic.parseImageFeishuEvent(JSON.stringify(recorded)), null); assert.ok(!JSON.stringify(messages).includes('PRIVATE_')); done();
    console.log(JSON.stringify({ passed: true, cases, uploaded: uploaded.length, messages: messages.length, largeOriginalBytes: large.length, oversizedOriginalBytes: over.length, realSqlite: true, externalRequests: 0, productionWrites: 0, originalBytesPreserved: true }));
  } finally {
    process.chdir(sourceRoot); globalThis.fetch = originalFetch; Date.now = originalNow; await prisma.$disconnect();
    const { feedbackPrisma } = await import('../src/lib/feedback/notification'); await feedbackPrisma.$disconnect(); await rm(run, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.stack : 'original notification engineering failed'); process.exitCode = 1; });
