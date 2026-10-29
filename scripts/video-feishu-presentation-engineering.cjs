'use strict';
// Synthetic supplied DB + captured transport only. Never loads the app Prisma client or a real network sender.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { load, root, contract: c, feedback, notification, fakeDb } = require('./fixtures/video-feishu.cjs');
const taskId = 'f04-entire-task-82d65c03-039c-41a6-8fce-13e4f80e78e1';
const siteUrl = `${c.VIDEO_FEISHU_SITE}/tasks/${taskId}`;
const checks = [];
let externalRequests = 0, mockRequests = 0;
const noGlobalDb = new Proxy({}, { get() { throw Error('Production/global DB access prohibited'); } });
const noExternalFetch = async () => { externalRequests++; throw Error('Unmocked network prohibited'); };
const equivalent = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
function snapshot(meta) { return JSON.stringify({ eventId: meta.eventId, presentation: meta.presentation, videoUuid: meta.video.uuid, explanationUuid: meta.explanation.uuid }); }

async function fixture({ legacy = false, context = true } = {}) {
  const f = fakeDb(), task = f.state.tasks.get(f.task.id);
  f.state.tasks.delete(f.task.id); Object.assign(task, { id: taskId, delivery_status: 'completed',
    prompt: 'PRIVATE_PROMPT_F04_DO_NOT_SEND', duration: 47, resolution: 'PRIVATE_RESOLUTION_F04',
    project: context ? { name: '项目甲' } : null, video_card: context ? { title: '视频卡乙' } : null });
  f.task = task; f.state.tasks.set(taskId, task);
  const preference = await notification.saveVideoFeishuPreference(f.db, f.actor.id, { version: 1, enabled: true, revision: 0 });
  const choice = { version: 1, enabled: true, preferenceRevision: preference.revision };
  await notification.enqueueVideoFeishuNotification(f.db, f.actor.id, task, choice);
  const id = c.videoFeishuUuid(taskId, 'event');
  const row = () => f.state.notifications.get(id), meta = () => JSON.parse(row().metadata_json);
  const change = action => { const next = meta(); action(next); row().metadata_json = JSON.stringify(next); };
  if (legacy) change(next => { delete next.presentation; }); // A synthetic pre-upgrade event, never a historical DB row.
  return { ...f, choice, row, meta, change, ready: () => change(next => { next.nextAttemptAt = 0; }) };
}
function consumer(f, { ambiguousPart = null, link = false } = {}) {
  const requests = [], accepted = new Map(); let ambiguousUsed = false;
  const fetchMock = async (input, options) => {
    const url = String(input); mockRequests++;
    assert.equal(options.method, 'POST');
    if (url === 'https://open.feishu.cn/open-apis/im/v1/files') {
      const form = options.body;
      requests.push({ kind: 'file', fileName: form.get('file_name'), blobName: form.get('file').name, duration: form.get('duration') });
      return Response.json({ code: 0, data: { file_key: 'file_f04_original' } });
    }
    if (url === 'https://open.feishu.cn/open-apis/im/v1/images') {
      requests.push({ kind: 'cover' }); return Response.json({ code: 0, data: { image_key: 'img_f04_cover' } });
    }
    assert.equal(url, 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', 'Only captured mock endpoints are permitted');
    const payload = JSON.parse(options.body), content = JSON.parse(payload.content);
    const entry = { kind: 'message', ...payload, content }; requests.push(entry);
    assert.equal(payload.receive_id, f.actor.feishu_open_id);
    const prior = accepted.get(payload.uuid);
    if (prior) equivalent(entry, prior);
    else accepted.set(payload.uuid, entry);
    if (!ambiguousUsed && ambiguousPart === payload.msg_type) {
      ambiguousUsed = true; return new Response('', { status: 502 }); // Accepted upstream, receipt lost locally.
    }
    return Response.json({ code: 0, data: { message_id: `om_${payload.uuid.replaceAll('-', '')}` } });
  };
  const transport = load('src/lib/video/feishu-transport.ts', { './feishu-contract': c }, { fetch: fetchMock });
  const source = { version: 'a'.repeat(64), hash: 'b'.repeat(64), origin: 'local', mode: link ? 'link' : 'video',
    reason: link ? 'original_too_large' : null, video: new Blob(['synthetic-original'], { type: 'video/mp4' }),
    cover: new Blob(['synthetic-cover'], { type: 'image/jpeg' }), durationMs: 1234,
    current: async () => true, close: async () => {} };
  const worker = load('src/lib/video/feishu-delivery.ts', {
    '@/lib/prisma': { prisma: noGlobalDb }, '@/lib/feedback/delivery': { feedbackTenantToken: async () => 'synthetic-not-a-real-token' },
    '@/lib/feedback/notification': feedback, './feishu-contract': c, './feishu-notification': notification, './feishu-transport': transport,
    './feishu-source': { prepareVideoFeishuSource: async () => source, videoFeishuSourceStamp: task => JSON.stringify([task.id, task.local_video_path]) },
  }, { fetch: noExternalFetch });
  return { requests, accepted, transport, run: () => worker.deliverVideoFeishuNotification(f.db, structuredClone(f.row())) };
}

async function main() {
  const presentation = c.newVideoFeishuPresentation(taskId, '项目甲', '视频卡乙');
  assert.equal(c.validVideoFeishuPresentation(presentation, taskId), true);
  assert.equal(presentation.videoText, `视频已生成｜项目甲 · 视频卡乙\n任务：${taskId}\n查看参数与下载原片：\n${siteUrl}`);
  assert.equal(presentation.videoFileName, `项目甲 · 视频卡乙-${taskId}.mp4`);
  assert.ok(presentation.linkText.includes('仅发送查看链接，未发送视频附件。'));
  for (const args of [[], [null, null], ['', '']]) {
    const empty = c.newVideoFeishuPresentation(taskId, ...args);
    assert.equal(empty.videoFileName, `视频-${taskId}.mp4`); assert.ok(empty.videoText.startsWith('视频已生成\n'));
    assert.equal(c.validVideoFeishuPresentation(empty, taskId), true);
  }
  const deduplicated = c.newVideoFeishuPresentation(taskId, '同名', '同名');
  assert.equal(deduplicated.videoText.split('\n')[0], '视频已生成｜同名');
  assert.throws(() => c.newVideoFeishuPresentation('../invalid'), error => error.code === 'task_unavailable');
  checks.push('factory_full_id_exact_url_and_optional_context');

  const dirty = c.newVideoFeishuPresentation(taskId, '安全 https://invalid.test/path <>\u0000\n', '卡 /\\:*?"| @all');
  assert.equal(c.validVideoFeishuPresentation(dirty, taskId), true);
  assert.ok(!/[<>:"/\\|?*\x00-\x1f\x7f]/.test(dirty.videoFileName));
  assert.ok(!dirty.videoText.includes('invalid.test') && !dirty.videoText.includes('@all'));
  assert.deepEqual(Array.from(dirty.videoText.matchAll(/https?:\/\/\S+/g), match => match[0]), [siteUrl]);
  for (const sensitive of ['token=PRIVATE_F04', 'api-key PRIVATE_F04', 'password PRIVATE_F04', '密码 PRIVATE_F04', 'Cookie PRIVATE_F04']) {
    const safe = c.newVideoFeishuPresentation(taskId, sensitive, sensitive);
    assert.equal(safe.videoFileName, `视频-${taskId}.mp4`); assert.ok(!JSON.stringify(safe).includes('PRIVATE_F04'));
  }
  const long = c.newVideoFeishuPresentation(taskId, '长'.repeat(100), '卡'.repeat(100));
  assert.equal(c.validVideoFeishuPresentation(long, taskId), true); assert.ok(Buffer.byteLength(long.videoFileName) <= 240);
  checks.push('context_sanitization_sensitive_names_and_filename_bounds');

  const fresh = await fixture(), frozen = snapshot(fresh.meta());
  equivalent(fresh.meta().presentation, presentation);
  assert.ok(!fresh.row().metadata_json.includes('PRIVATE_PROMPT') && !fresh.row().metadata_json.includes('PRIVATE_RESOLUTION'));
  const parsed = c.parseVideoFeishuEvent(fresh.row().metadata_json); assert.ok(parsed); equivalent(parsed.presentation, presentation);
  for (const invalid of [{ ...presentation, version: 1 }, { ...presentation, videoFileName: `../${taskId}.mp4` },
    { ...presentation, prompt: 'PRIVATE_F04' }, { ...presentation, videoText: presentation.videoText + '\nhttps://invalid.test' },
    { ...presentation, linkText: presentation.videoText }]) {
    assert.equal(c.parseVideoFeishuEvent(JSON.stringify({ ...fresh.meta(), presentation: invalid })), null);
  }
  fresh.task.project.name = '受理后改名'; fresh.task.video_card.title = '受理后改卡名';
  const originalRow = fresh.row().metadata_json, creates = fresh.state.writes.filter(item => item === 'notification.create').length;
  await notification.enqueueVideoFeishuNotification(fresh.db, fresh.actor.id, fresh.task, fresh.choice);
  assert.equal(fresh.row().metadata_json, originalRow); assert.equal(snapshot(fresh.meta()), frozen);
  assert.equal(fresh.state.writes.filter(item => item === 'notification.create').length, creates);
  checks.push('accepted_snapshot_uses_only_legal_context_and_duplicate_enqueue_is_noop');

  for (const legacy of [false, true]) {
    const f = legacy ? await fixture({ legacy: true }) : fresh, before = snapshot(f.meta()), sender = consumer(f);
    assert.ok(c.parseVideoFeishuEvent(f.row().metadata_json));
    if (legacy) {
      assert.equal(Object.hasOwn(f.meta(), 'presentation'), false);
      assert.equal(c.videoFeishuExplanation(f.meta()), `任务 ${taskId}\n视频已发送。\n${siteUrl}`);
      const raw = f.row().metadata_json; f.task.project.name = '旧事件后的新名';
      await notification.enqueueVideoFeishuNotification(f.db, f.actor.id, f.task, f.choice); assert.equal(f.row().metadata_json, raw);
    }
    assert.equal(await sender.run(), 'sent'); assert.equal(snapshot(f.meta()), before);
    const messages = sender.requests.filter(item => item.kind === 'message'), files = sender.requests.filter(item => item.kind === 'file');
    assert.equal(messages.length, 2); assert.deepEqual(messages.map(item => item.msg_type), ['media', 'text']);
    assert.equal(files.length, 1); assert.equal(files[0].fileName, legacy ? `video-${taskId}.mp4` : presentation.videoFileName);
    assert.equal(files[0].blobName, files[0].fileName); assert.equal(files[0].duration, '1234');
    assert.equal(messages[0].uuid, c.videoFeishuUuid(taskId, 'video')); assert.equal(messages[1].uuid, c.videoFeishuUuid(taskId, 'explanation'));
    assert.equal(messages[1].content.text, c.videoFeishuExplanation(f.meta()));
    assert.ok(!JSON.stringify(messages).includes('PRIVATE_PROMPT') && !JSON.stringify(messages).includes('PRIVATE_RESOLUTION'));
    const requestCount = sender.requests.length; assert.equal(await sender.run(), 'ignored'); assert.equal(sender.requests.length, requestCount);
    const status = await notification.readVideoFeishuStatus(f.db, f.actor.id, taskId);
    assert.equal(status.state, 'sent_video'); assert.equal(status.generationSucceeded, true);
    checks.push(legacy ? 'legacy_exact_text_and_native_filename_without_backfill' : 'new_two_messages_and_frozen_transport_filename');
  }

  for (const part of ['media', 'text']) {
    const f = await fixture(), before = snapshot(f.meta()), sender = consumer(f, { ambiguousPart: part });
    await sender.run();
    const first = f.meta(); assert.equal(first.state, 'pending'); assert.equal(snapshot(first), before);
    assert.equal(first[part === 'media' ? 'video' : 'explanation'].ambiguous, true);
    if (part === 'text') {
      assert.ok(first.video.receiptId); const status = await notification.readVideoFeishuStatus(f.db, f.actor.id, taskId);
      assert.equal(status.state, 'video_sent_explanation_pending'); assert.equal(status.videoSent, true); assert.equal(status.generationSucceeded, true);
    }
    f.task.project.name = '重试前新项目名'; f.task.video_card.title = '重试前新卡名';
    await notification.enqueueVideoFeishuNotification(f.db, f.actor.id, f.task, f.choice);
    assert.equal(snapshot(f.meta()), before); f.ready(); assert.equal(await sender.run(), 'sent'); assert.equal(snapshot(f.meta()), before);
    const messages = sender.requests.filter(item => item.kind === 'message');
    assert.equal(messages.length, 3); assert.equal(sender.accepted.size, 2); // Retry the same provider UUID, never a third logical message.
    assert.equal(messages.filter(item => item.msg_type === part).length, 2);
    assert.equal(messages.filter(item => item.msg_type !== part).length, 1);
    assert.equal(sender.requests.filter(item => item.kind === 'file').length, 1);
    for (const message of messages.filter(item => item.msg_type === 'text')) assert.equal(message.content.text, presentation.videoText);
    checks.push(part === 'media' ? 'unknown_video_receipt_keeps_uuid_and_snapshot' : 'partial_success_retries_only_frozen_explanation');
  }

  for (const legacy of [false, true]) {
    const f = await fixture({ legacy }), before = snapshot(f.meta()), sender = consumer(f, { link: true });
    assert.equal(await sender.run(), 'sent'); assert.equal(snapshot(f.meta()), before);
    assert.equal(sender.requests.length, 1); assert.equal(sender.requests[0].msg_type, 'text');
    assert.equal(sender.requests[0].content.text, legacy ? `任务 ${taskId}\n本次仅发送查看链接，未发送视频附件。\n${siteUrl}` : presentation.linkText);
    assert.equal((await notification.readVideoFeishuStatus(f.db, f.actor.id, taskId)).state, 'sent_link');
  }
  const fileCheck = consumer(await fixture()), beforeFileCheck = fileCheck.requests.length;
  await assert.rejects(fileCheck.transport.uploadVideoFeishuFile('synthetic', taskId, new Blob(['x'], { type: 'video/mp4' }), 1000, `../unsafe-${taskId}.mp4`), error => error.code === 'video_file_invalid');
  assert.equal(fileCheck.requests.length, beforeFileCheck);
  checks.push('new_and_legacy_link_fallback_and_invalid_filename_rejected_before_transport');

  // Evaluate the actual component's pure label expression without React/browser rendering.
  const uiFile = path.join(root, 'src/components/generate/VideoFeishuStatus.tsx');
  const ui = ts.createSourceFile(uiFile, fs.readFileSync(uiFile, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const variable = (node, name) => ts.isVariableDeclaration(node) && node.name.getText(ui) === name ? node : ts.forEachChild(node, child => variable(child, name));
  const label = variable(ui, 'label'), labels = variable(ui, 'labels'); assert.ok(label?.initializer && labels?.initializer);
  const show = new Function('value', 'labels', `return (${label.initializer.getText(ui)});`), labelMap = new Function(`return (${labels.initializer.getText(ui)});`)();
  for (const state of ['failed', 'unknown']) {
    const f = await fixture(); f.change(meta => { meta.state = state; meta.reason = 'message_window_ended'; }); f.row().status = 'failed';
    const status = await notification.readVideoFeishuStatus(f.db, f.actor.id, taskId);
    assert.equal(status.state, state); assert.equal(status.generationSucceeded, true); assert.equal(f.task.local_status, 'succeeded');
    assert.equal(show(status, labelMap), state === 'failed' ? '视频已生成，飞书发送未完成' : '视频已生成，飞书结果待核对');
    assert.equal(show({ ...status, videoSent: true }, labelMap), state === 'failed' ? '视频已发送，详情说明未完成' : '视频已发送，详情说明结果待核对');
  }
  const failedSave = await fixture(); failedSave.task.delivery_status = 'failed'; failedSave.task.local_video_path = null;
  const saveStatus = await notification.readVideoFeishuStatus(failedSave.db, failedSave.actor.id, taskId);
  assert.equal(saveStatus.state, 'original_save_failed'); assert.equal(saveStatus.generationSucceeded, true);
  assert.equal(show(saveStatus, labelMap), '视频保存失败，尚未发送飞书');
  checks.push('notification_failure_and_save_failure_do_not_reclassify_successful_generation');

  assert.equal(externalRequests, 0);
  console.log(JSON.stringify({ suite: 'video-feishu-presentation', checks, mockRequests, externalRequests, productionDb: false, realDelivery: false }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
