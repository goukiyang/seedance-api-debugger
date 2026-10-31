import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';

async function main() {
  const sourceRoot = process.cwd(), fixtureRoot = process.env.FEISHU_NOTIFICATION_FIXTURE_ROOT;
  assert.ok(fixtureRoot && path.isAbsolute(fixtureRoot) && !fixtureRoot.startsWith('/data/video-api-debugger/')); assert.equal(await realpath(fixtureRoot!), fixtureRoot);
  const run = await mkdtemp(path.join(fixtureRoot!, 'navigation-run-'));
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${run}/isolated.sqlite`, FEISHU_APP_ID: 'fixture-app', FEISHU_APP_SECRET: 'fixture-placeholder', FEISHU_ALLOWED_TENANT_KEY: 'fixture-tenant' });
  for (const key of Object.keys(process.env).filter(key => key.startsWith('PRIVATE_PROMPTS_'))) delete process.env[key];
  await writeFile(`${run}/isolated.sqlite`, '', { mode: 0o600 });
  const schema = spawnSync(process.execPath, [path.join(sourceRoot, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(sourceRoot, 'prisma/schema.prisma')], { env: process.env, encoding: 'utf8', timeout: 120000 }); assert.equal(schema.status, 0, schema.stderr?.slice(-800));
  const [{ prisma }, notification, contract, originalWorker, autoContract, autoWorker, navigation, output] = await Promise.all([
    import('../src/lib/prisma'), import('../src/lib/image-studio/feishu-notification'), import('../src/lib/image-studio/feishu-original-contract'), import('../src/lib/image-studio/feishu-original-delivery'),
    import('../src/lib/image-studio/feishu-contract'), import('../src/lib/image-studio/feishu-delivery'), import('../src/lib/image-studio/feishu-navigation'), import('../src/lib/image-studio/output'),
  ]);
  const oldFetch = globalThis.fetch, oldNow = Date.now; let now = oldNow(); Date.now = () => now;
  let uploads = 0, fail: 'file' | 'post' | 'interactive' | null = null, rejectPost = false;
  const messages: Array<{ uuid: string; msg_type: string; content: string }> = [];
  globalThis.fetch = async (url, init) => {
    const endpoint = String(url); assert.ok(endpoint.startsWith('https://open.feishu.cn/open-apis/'));
    if (endpoint.endsWith('/auth/v3/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'fixture-token' });
    if (endpoint.endsWith('/images') || endpoint.endsWith('/files')) { uploads++; return Response.json({ code: 0, data: endpoint.endsWith('/files') ? { file_key: `file_fixture_${uploads}` } : { image_key: `img_fixture_${uploads}` } }); }
    assert.ok(endpoint.endsWith('/messages?receive_id_type=open_id')); const body = JSON.parse(String(init!.body)); assert.equal(body.receive_id, 'ou_fixture_owner'); messages.push(body);
    if (fail === body.msg_type) { fail = null; return new Response('', { status: 502 }); }
    if (body.msg_type === 'post' && rejectPost) { rejectPost = false; return Response.json({ code: 230001 }); }
    return Response.json({ code: 0, data: { message_id: `om_${body.uuid.replaceAll('-', '')}` } });
  };
  let cases = 0;
  try {
    process.chdir(run); await mkdir('public/uploads', { recursive: true });
    for (const id of ['fixture-owner','fixture-other']) await prisma.user.create({ data: { id, name: id, username: id, email: `${id}@example.invalid`, password_hash: 'fixture-only', role: 'admin', feishu_open_id: id === 'fixture-owner' ? 'ou_fixture_owner' : 'ou_fixture_other', feishu_tenant_key: 'fixture-tenant' } });
    const moduleId = randomUUID(), foreignId = randomUUID(); await prisma.imageStudioModule.create({ data: { id: moduleId, owner_id: 'fixture-owner', name: '动作模块' } });
    await prisma.imageStudioModule.create({ data: { id: foreignId, owner_id: 'fixture-other', name: '不可外发的其他模块' } });
    const png = await sharp({ create: { width: 24, height: 32, channels: 4, background: { r: 20, g: 40, b: 80, alpha: .5 } } }).png().toBuffer(), tiff = await sharp(png).tiff().toBuffer();
    const makeTask = async (id: string, file = false, module: string = moduleId, batch = `batch-${id}`) => {
      const task = await prisma.imageStudioTask.create({ data: { id, owner_id: 'fixture-owner', module_id: module, batch_id: batch, ordinal: 1, fingerprint: id, prompt: 'PRIVATE_PROMPT', context: 'PRIVATE_CONTEXT', revision: 1, model: 'fixture-image', reference_ids: '[]', unit_credits: 0, status: 'succeeded' } });
      const prepared = await output.prepareStudioOutput(file ? tiff : png, task, { width: 24, height: 32 }, async () => {}, file ? 'tiff' : 'png');
      const asset = await prisma.asset.upsert({ where: { owner_id_hash: { owner_id: 'fixture-owner', hash: prepared.hash! } }, create: prepared, update: {} });
      await prisma.imageStudioTask.update({ where: { id }, data: { asset_id: asset.id } }); return { ...task, asset_id: asset.id };
    };
    const rowFor = (id: string) => prisma.notification.findUniqueOrThrow({ where: { id: contract.originalImageFeishuUuid(id, 'event') } });
    const enqueue = async (id: string) => { await notification.requestOriginalImageFeishu(prisma, 'fixture-owner', id); return rowFor(id); };
    const metadata = async (id: string) => contract.parseOriginalImageFeishuEvent((await rowFor(id)).metadata_json)!;
    const partial = async (id: string) => {
      const row = await enqueue(id);
      await originalWorker.deliverOriginalImageFeishuNotification(prisma, row, async () => !(await metadata(id)).message.receiptId);
      const meta = await metadata(id); assert.ok(meta.message.receiptId); assert.equal(meta.state, 'pending'); return meta;
    };
    await notification.saveImageFeishuPreference(prisma, 'fixture-owner', { version: 1, enabled: true, revision: 0 });
    const frozen = await notification.freezeImageFeishuChoice(prisma, 'fixture-owner', { version: 1, enabled: true, preferenceRevision: 1 }); assert.ok(frozen);
    const automatic = await makeTask('auto-v3'); await notification.enqueueFrozenImageFeishuNotification(prisma, automatic, frozen);
    let autoRow = await prisma.notification.findUniqueOrThrow({ where: { id: autoContract.imageFeishuUuid(automatic.id, 'event') } }); fail = 'interactive';
    await autoWorker.deliverImageFeishuNotification(prisma, autoRow);
    const autoBefore = autoContract.parseImageFeishuEvent((await prisma.notification.findUniqueOrThrow({ where: { id: autoRow.id } })).metadata_json)!;
    assert.equal(autoBefore.version, 3); const firstPayload = messages.at(-1)!; assert.equal(JSON.parse(firstPayload.content).elements[2].actions[0].text.content, '动作模块');
    await prisma.imageStudioModule.update({ where: { id: moduleId }, data: { name: '新模块名' } }); now += 61000;
    autoRow = await prisma.notification.findUniqueOrThrow({ where: { id: autoRow.id } }); const beforeRetryUploads = uploads; await autoWorker.deliverImageFeishuNotification(prisma, autoRow);
    assert.equal(messages.at(-1)!.uuid, firstPayload.uuid); assert.equal(messages.at(-1)!.content, firstPayload.content); assert.equal(uploads, beforeRetryUploads);
    const autoAfter = autoContract.parseImageFeishuEvent((await prisma.notification.findUniqueOrThrow({ where: { id: autoRow.id } })).metadata_json)!;
    assert.equal(autoAfter.state, 'sent'); assert.equal(autoAfter.version, 3); assert.equal(autoContract.parseImageFeishuEvent(JSON.stringify({ ...autoAfter, version: 2 })), null); cases++;

    const image = await makeTask('manual-image'); await originalWorker.deliverOriginalImageFeishuNotification(prisma, await enqueue(image.id));
    const imageMeta = await metadata(image.id); assert.equal(imageMeta.version, 2); if (imageMeta.version === 2) { assert.equal(imageMeta.navigationStep.state, 'skipped'); assert.equal(imageMeta.navigationPayload, null); assert.equal(imageMeta.navigation!.label, '新模块名'); }
    assert.equal(messages.at(-1)!.msg_type, 'interactive'); assert.equal(JSON.parse(messages.at(-1)!.content).elements[2].actions[0].text.content, '新模块名'); cases++;

    const planId = randomUUID(); await prisma.platformSetting.create({ data: { key: `character-lab:v1:fixture-owner:plan:${planId}`, value_json: '{}' } });
    const labBatch = createHash('sha256').update(`fixture-owner:${planId}`).digest('hex'); const lab = await makeTask('lab-navigation', false, moduleId, labBatch);
    assert.deepEqual(await navigation.resolveImageFeishuNavigation(prisma, lab, lab.asset_id), { kind: 'character-lab', label: '角色参考图工作台', path: '/tools/character-lab', moduleId: null });
    const virtual = await makeTask('virtual-default', false, 'default-fixture-owner');
    assert.equal((await navigation.resolveImageFeishuNavigation(prisma, virtual, virtual.asset_id)).label, '模块 1');
    await prisma.imageStudioModule.create({ data: { id: 'default-fixture-owner', owner_id: 'fixture-owner', name: '本人默认名称' } });
    assert.equal((await navigation.resolveImageFeishuNavigation(prisma, virtual, virtual.asset_id)).label, '本人默认名称');
    const foreign = await makeTask('foreign-module', false, foreignId), missing = await makeTask('missing-module', false, randomUUID());
    for (const task of [foreign,missing]) { const nav = await navigation.resolveImageFeishuNavigation(prisma, task, task.asset_id); assert.equal(nav.label, '生成结果'); assert.equal(nav.path, `/image-studio/original/${task.asset_id}`); }
    await assert.rejects(notification.requestOriginalImageFeishu(prisma, 'fixture-other', image.id)); cases++;

    const { recordStudioWorkspaceDeletion } = await import('../src/lib/image-studio/workspace-deletion');
    await prisma.imageStudioModule.delete({ where: { id: 'default-fixture-owner' } });
    await recordStudioWorkspaceDeletion(prisma, 'fixture-owner', 'default-fixture-owner', 0, null, 'fixture-default-delete', new Date(now).toISOString());
    const deletion = await prisma.platformSetting.findMany({ where: { key: { startsWith: 'studio_deleted_workspace_v1:' } }, select: { key: true, value_json: true } });
    const deletedDefault = await makeTask('deleted-default', false, 'default-fixture-owner');
    const deletedNavigation = { kind: 'result', label: '生成结果', path: `/image-studio/original/${deletedDefault.asset_id}`, moduleId: null };
    assert.deepEqual(await navigation.resolveImageFeishuNavigation(prisma, deletedDefault, deletedDefault.asset_id), deletedNavigation);
    await originalWorker.deliverOriginalImageFeishuNotification(prisma, await enqueue(deletedDefault.id));
    const deletedMeta = await metadata(deletedDefault.id); assert.equal(deletedMeta.state, 'sent');
    if (deletedMeta.version === 2) assert.deepEqual(deletedMeta.navigation, deletedNavigation);
    assert.equal(JSON.parse(messages.at(-1)!.content).elements[2].actions[0].url, `https://sd2.youdooart.com${deletedNavigation.path}`);
    assert.equal(await prisma.imageStudioModule.findUnique({ where: { id: 'default-fixture-owner' } }), null);
    assert.deepEqual(await prisma.platformSetting.findMany({ where: { key: { startsWith: 'studio_deleted_workspace_v1:' } }, select: { key: true, value_json: true } }), deletion); cases++;

    const file = await makeTask('file-partial', true); const beforeFile = { uploads, messages: messages.length }; const fileBefore = await partial(file.id);
    assert.equal((await notification.readOriginalImageFeishuStatus(prisma, 'fixture-owner', file.id)).state, 'sent_navigation_pending');
    assert.equal(uploads - beforeFile.uploads, 1); assert.equal(messages.length - beforeFile.messages, 1); assert.equal(messages.at(-1)!.msg_type, 'file');
    assert.deepEqual(Object.keys(JSON.parse(messages.at(-1)!.content)), ['file_key']);
    await prisma.imageStudioModule.update({ where: { id: moduleId }, data: { name: '再次改名' } });
    await originalWorker.deliverOriginalImageFeishuNotification(prisma, await rowFor(file.id)); const fileAfter = await metadata(file.id);
    assert.equal(fileAfter.state, 'sent'); assert.equal(uploads - beforeFile.uploads, 1); assert.equal(messages.length - beforeFile.messages, 2); assert.equal(messages.at(-1)!.msg_type, 'post');
    if (fileAfter.version === 2 && fileBefore.version === 2) { assert.ok(fileAfter.navigationStep.receiptId); assert.equal(fileAfter.navigationStep.uuid, fileBefore.navigationStep.uuid); assert.equal(fileAfter.message.receiptId, fileBefore.message.receiptId); assert.equal(fileAfter.payload, fileBefore.payload); assert.equal(fileAfter.navigationPayload, fileBefore.navigationPayload);
      assert.deepEqual(JSON.parse(fileAfter.navigationPayload!), { zh_cn: { content: [[{ tag: 'a', text: '新模块名', href: `https://sd2.youdooart.com/template-studio?type=image&moduleId=${moduleId}` }]] } }); }
    cases++;

    const unknownLink = await makeTask('navigation-unknown', true); fail = 'post'; const beforeUnknown = { uploads, messages: messages.length };
    await originalWorker.deliverOriginalImageFeishuNotification(prisma, await enqueue(unknownLink.id)); const unknownMeta = await metadata(unknownLink.id);
    const unknownRaw = (await rowFor(unknownLink.id)).metadata_json; assert.equal((await notification.readOriginalImageFeishuStatus(prisma, 'fixture-owner', unknownLink.id)).state, 'sent_navigation_unknown');
    assert.ok(unknownMeta.message.receiptId); if (unknownMeta.version === 2) assert.equal(unknownMeta.navigationStep.ambiguous, true);
    await notification.requestOriginalImageFeishu(prisma, 'fixture-owner', unknownLink.id); await originalWorker.deliverOriginalImageFeishuNotification(prisma, await rowFor(unknownLink.id));
    await assert.rejects(notification.changeOriginalImageFeishu(prisma, 'fixture-owner', unknownLink.id, 'retry'));
    assert.equal((await rowFor(unknownLink.id)).metadata_json, unknownRaw); assert.equal(uploads - beforeUnknown.uploads, 1); assert.equal(messages.length - beforeUnknown.messages, 2); cases++;

    const unknownFile = await makeTask('file-message-unknown', true); fail = 'file'; const beforeFileUnknown = { uploads, messages: messages.length };
    await originalWorker.deliverOriginalImageFeishuNotification(prisma, await enqueue(unknownFile.id)); const unknownFileMeta = await metadata(unknownFile.id);
    assert.equal(unknownFileMeta.state, 'unknown'); assert.equal(unknownFileMeta.message.receiptId, null);
    await notification.requestOriginalImageFeishu(prisma, 'fixture-owner', unknownFile.id); await originalWorker.deliverOriginalImageFeishuNotification(prisma, await rowFor(unknownFile.id));
    assert.equal(uploads - beforeFileUnknown.uploads, 1); assert.equal(messages.length - beforeFileUnknown.messages, 1); cases++;

    const rejected = await makeTask('navigation-rejected', true); rejectPost = true; const beforeRejected = { uploads, messages: messages.length };
    await originalWorker.deliverOriginalImageFeishuNotification(prisma, await enqueue(rejected.id)); const rejectedMeta = await metadata(rejected.id);
    const view = await notification.readOriginalImageFeishuStatus(prisma, 'fixture-owner', rejected.id); assert.equal(view.state, 'sent_navigation_failed'); assert.equal(view.originalSent, true); assert.equal(view.canRetry, true);
    await notification.changeOriginalImageFeishu(prisma, 'fixture-owner', rejected.id, 'retry'); assert.equal((await metadata(rejected.id)).message.state, 'sent');
    await originalWorker.deliverOriginalImageFeishuNotification(prisma, await rowFor(rejected.id)); const recovered = await metadata(rejected.id);
    assert.equal(recovered.state, 'sent'); assert.equal(uploads - beforeRejected.uploads, 1); assert.equal(messages.length - beforeRejected.messages, 3);
    if (recovered.version === 2 && rejectedMeta.version === 2) assert.equal(recovered.navigationStep.uuid, rejectedMeta.navigationStep.uuid); cases++;

    const rebound = await makeTask('navigation-rebound', true); await partial(rebound.id); const beforeRebound = { uploads, messages: messages.length };
    await prisma.user.update({ where: { id: 'fixture-owner' }, data: { feishu_open_id: 'ou_changed_binding' } }); await originalWorker.deliverOriginalImageFeishuNotification(prisma, await rowFor(rebound.id));
    assert.deepEqual({ uploads, messages: messages.length }, beforeRebound); const reboundView = await notification.readOriginalImageFeishuStatus(prisma, 'fixture-owner', rebound.id); assert.equal(reboundView.originalSent, true); assert.equal(reboundView.canRetry, false); cases++;
    assert.ok(!JSON.stringify(messages).includes('PRIVATE_')); assert.ok(!JSON.stringify(messages).includes('不可外发的其他模块'));
    console.log(JSON.stringify({ passed: true, cases, realSqlite: true, externalRequests: 0, productionWrites: 0, fileNeverResentForNavigation: true }));
  } finally { process.chdir(sourceRoot); globalThis.fetch = oldFetch; Date.now = oldNow; await prisma.$disconnect(); const { feedbackPrisma } = await import('../src/lib/feedback/notification'); await feedbackPrisma.$disconnect(); await rm(run, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
