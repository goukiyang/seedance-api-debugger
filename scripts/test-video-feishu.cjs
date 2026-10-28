'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..'), tests = [];
const { load, contract, AuthError, feedback, notification, fakeDb, eventFixture, delivery } = require('./fixtures/video-feishu.cjs');
const test = (name, run) => tests.push({ name, run });
test('frozen supplied-db preference and enqueue API exists on actual source', () => {
  for (const name of ['readVideoFeishuPreference', 'saveVideoFeishuPreference', 'enqueueVideoFeishuNotification']) assert.equal(typeof notification[name], 'function', name);
});
test('strict choice rejects malformed and recipient-bearing opt-in', () => {
  for (const value of [null, true, [], {}, { version: 2, enabled: true, preferenceRevision: 1 }, { version: 1, enabled: true, preferenceRevision: -1 },
    { version: 1, enabled: true, preferenceRevision: 1, openId: 'ou_other' }]) assert.throws(() => contract.normalizeVideoFeishuChoice(value));
});
test('GET is read-only default false; missing binding disables notification only', async () => {
  const { db, state, actor, task } = fakeDb();
  assert.equal((await notification.readVideoFeishuPreference(db, 'actor')).enabled, false); assert.equal(state.writes.length, 0);
  actor.feishu_open_id = null;
  assert.equal((await notification.readVideoFeishuPreference(db, 'actor')).available, false);
  await assert.rejects(notification.saveVideoFeishuPreference(db, 'actor', { version: 1, enabled: true, revision: 0 }), /binding_unavailable/);
  await notification.enqueueVideoFeishuNotification(db, 'actor', task, undefined);
  await notification.enqueueVideoFeishuNotification(db, 'actor', task, { version: 1, enabled: false, preferenceRevision: 0 });
  assert.equal(state.writes.length, 0);
});
test('preference CAS rejects stale concurrent writes and binding/revision are not guessed', async () => {
  const { db, state } = fakeDb();
  const results = await Promise.allSettled([true, false].map(enabled => notification.saveVideoFeishuPreference(db, 'actor', { version: 1, enabled, revision: 0 })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(state.preferences.size, 1);
  await assert.rejects(notification.saveVideoFeishuPreference(db, 'actor', { version: 1, enabled: false, revision: 0 }), /preference_changed/);
});
test('fresh active/expiry/tenant/app binding enforced without modifying normal tasks', async () => {
  for (const change of [actor => { actor.status = 'disabled'; }, actor => { actor.expires_at = new Date(0); }]) {
    const fixture = fakeDb(); change(fixture.actor);
    await assert.rejects(notification.readVideoFeishuPreference(fixture.db, 'actor'), /account_unavailable/);
    assert.equal(fixture.state.writes.length, 0);
  }
  const f = await eventFixture(); f.actor.feishu_tenant_key = 'other';
  assert.equal((await notification.readVideoFeishuPreference(f.db, 'actor')).enabled, false);
  await assert.rejects(notification.enqueueVideoFeishuNotification(f.db, 'actor', f.task, f.meta().choice), /preference_changed/);
});
test('only actual author ordinary task enqueues one stable event; no recipe or prompt retained', async () => {
  const f = await eventFixture(), first = f.row();
  await notification.enqueueVideoFeishuNotification(f.db, 'actor', f.task, f.meta().choice);
  assert.equal(f.state.notifications.size, 1); assert.equal(f.row().metadata_json, first.metadata_json);
  await assert.rejects(notification.enqueueVideoFeishuNotification(f.db, 'other', f.task, f.meta().choice), /notification_source_forbidden/);
  f.actor.role = 'admin'; f.task.source_metadata_json = '{"protected_module":';
  await assert.rejects(notification.enqueueVideoFeishuNotification(f.db, 'actor', { ...f.task, source_metadata_json: null }, f.meta().choice), /notification_source_forbidden/);
  assert.doesNotMatch(first.metadata_json, /synthetic-token|ou_synthetic|prompt|recipe|local_video|\/videos/);
});
test('actual project access/retention/private checks apply to author status, not viewer/admin fallback', async () => {
  const f = await eventFixture(); f.task.project_id = 'project';
  f.state.project = { id: 'project', status: 'active', type: 'team', owner_user_id: 'owner', members: [{ status: 'active', role: 'viewer' }] };
  assert.equal((await notification.readVideoFeishuStatus(f.db, 'actor', f.task.id)).state, 'pending');
  f.state.project.members = [];
  await assert.rejects(notification.readVideoFeishuStatus(f.db, 'actor', f.task.id), /task_unavailable/);
  f.actor.role = 'admin'; f.task.source_metadata_json = JSON.stringify({ protected_module: null });
  await assert.rejects(notification.readVideoFeishuStatus(f.db, 'actor', f.task.id), /task_unavailable/);
  f.task.source_metadata_json = null; f.task.retention_status = 'user_deleted';
  await assert.rejects(notification.readVideoFeishuStatus(f.db, 'actor', f.task.id), /task_unavailable/);
});
test('old task without event remains not_requested and GET creates nothing', async () => {
  const f = fakeDb(); assert.equal((await notification.readVideoFeishuStatus(f.db, 'actor', f.task.id)).state, 'not_requested');
  assert.equal(f.state.writes.length, 0);
});
test('cancel CAS wins only before any claim/external intent, repeat cancel is honest', async () => {
  const f = await eventFixture();
  assert.equal((await notification.cancelVideoFeishuNotification(f.db, 'actor', f.task.id)).state, 'cancelled');
  assert.equal((await notification.cancelVideoFeishuNotification(f.db, 'actor', f.task.id)).state, 'cancelled');
  const c = delivery(f); await c.run(); assert.deepEqual(c.calls, []);
  for (const change of [meta => { meta.leaseToken = 'leased'; meta.leaseUntil = Date.now() + 10000; },
    meta => { meta.upload.state = 'uploading'; meta.upload.startedAt = Date.now(); meta.externalStartedAt = Date.now(); },
    meta => { meta.video.state = 'sending'; meta.video.firstSendAt = Date.now(); meta.video.ambiguous = true; }]) {
    const g = await eventFixture(); g.changeMeta(change);
    await assert.rejects(notification.cancelVideoFeishuNotification(g.db, 'actor', g.task.id), /notification_cannot_cancel/);
  }
});
test('event parser rejects tampered UUID, privilege extras and invalid receipt combinations', async () => {
  const f = await eventFixture(); assert.ok(contract.parseVideoFeishuEvent(f.row().metadata_json));
  for (const change of [meta => { meta.video.uuid = meta.explanation.uuid; }, meta => { meta.prompt = 'secret'; },
    meta => { meta.video.state = 'sent'; }, meta => { meta.upload.key = '../private'; }]) {
    const meta = f.meta(); change(meta); assert.equal(contract.parseVideoFeishuEvent(JSON.stringify(meta)), null);
  }
});
test('complete real-helper delivery has durable intent before upload/send and separate receipts', async () => {
  const f = await eventFixture(), c = delivery(f, {
    upload: () => { assert.equal(f.meta().upload.state, 'uploading'); assert.equal(f.meta().video.firstSendAt, null); return 'file_synthetic'; },
    send: args => { const part = args[3] === 'media' ? 'video' : 'explanation'; assert.equal(f.meta()[part].state, 'sending');
      assert.ok(f.meta()[part].firstSendAt); assert.equal(args[2], f.meta()[part].uuid); return `om_${part}`; },
  });
  assert.equal(await c.run(), 'sent'); assert.equal(f.row().status, 'sent');
  assert.equal(f.meta().video.receiptId, 'om_video'); assert.equal(f.meta().explanation.receiptId, 'om_explanation');
  assert.notEqual(f.meta().video.uuid, f.meta().explanation.uuid);
  assert.equal(f.state.writes.filter(write => write.includes('task') || write.includes('ledger') || write.includes('provider')).length, 0);
});
test('saved preference change after acceptance does not rewrite accepted choice', async () => {
  const f = await eventFixture(); await notification.saveVideoFeishuPreference(f.db, 'actor', { version: 1, enabled: false, revision: 1 });
  const c = delivery(f); assert.equal(await c.run(), 'sent');
});
test('binding/permission/private/source change stops before upload or before message', async () => {
  for (const change of [f => { f.actor.status = 'disabled'; }, f => { f.actor.feishu_open_id = 'ou_other'; },
    f => { f.task.source_metadata_json = '{"protected_module":null}'; }, f => { f.task.retention_status = 'admin_hidden'; }]) {
    const f = await eventFixture(); change(f); const c = delivery(f); await c.run(); assert.equal(c.calls.includes('upload'), false); assert.equal(c.calls.includes('media'), false);
  }
  const f = await eventFixture(), c = delivery(f, { upload: () => { f.task.local_video_path = '/videos/changed.mp4'; return 'file_synthetic'; } });
  await c.run(); assert.equal(c.calls.includes('media'), false); assert.equal(f.meta().reason, 'original_changed');
  const g = await eventFixture(), d = delivery(g, { current: () => false }); await d.run(); assert.equal(d.calls.includes('upload'), false);
});
test('waiting/failed/cancelled generation sends nothing and does not mutate generation', async () => {
  for (const status of ['queued', 'failed', 'cancelled']) {
    const f = await eventFixture(); f.task.local_status = status; const before = JSON.stringify(f.task), c = delivery(f);
    await c.run(); assert.equal(c.calls.includes('upload'), false); assert.equal(c.calls.includes('media'), false); assert.equal(JSON.stringify(f.task), before);
  }
  const f = await eventFixture(), c = delivery(f, { prepare: () => { throw new contract.VideoFeishuError('original_not_ready', 409, false, true); } });
  assert.equal(await c.run(), 'deferred'); assert.equal(f.row().status, 'pending'); assert.equal(c.calls.includes('upload'), false);
});
test('oversize/unsupported is explicit link-only; no media upload and no fake video success', async () => {
  for (const reason of ['video_oversize', 'video_format_unsupported']) {
    const f = await eventFixture(), c = delivery(f, { source: { mode: 'link', hash: null, reason, video: null, cover: null },
      send: args => { assert.equal(args[3], 'text'); assert.match(args[4].text, /仅发送查看链接/); assert.match(args[4].text, /\/tasks\/synthetic-task$/); return 'om_link'; } });
    await c.run(); assert.equal(c.calls.includes('upload'), false); assert.equal(f.meta().mode, 'link');
    assert.equal(contract.videoFeishuStatus(f.meta()).videoSent, false);
  }
});
test('upload unknown safely links only before messages; crashed upload is never repeated', async () => {
  const f = await eventFixture(), c = delivery(f, { upload: () => { throw new contract.VideoFeishuError('file_upload_unknown', 503, true); } });
  assert.equal(await c.run(), 'sent'); assert.equal(f.meta().mode, 'link'); assert.equal(c.calls.includes('media'), false);
  const g = await eventFixture(); g.changeMeta(meta => { meta.upload.state = 'uploading'; meta.upload.startedAt = Date.now(); meta.externalStartedAt = Date.now(); });
  const d = delivery(g); await d.run(); assert.equal(d.calls.includes('upload'), false); assert.equal(g.meta().mode, 'link');
});
test('video receipt survives explanation failure and is not resent on retry', async () => {
  const f = await eventFixture(); let explain = 0;
  const c = delivery(f, { send: args => { if (args[3] === 'text' && ++explain === 1) throw new contract.VideoFeishuError('unknown', 503, true, true); return `om_${args[3]}`; } });
  await c.run(); assert.equal(f.meta().video.receiptId, 'om_media'); assert.equal(f.row().status, 'pending');
  f.ready(); await c.run(); assert.equal(f.row().status, 'sent'); assert.equal(c.calls.filter(call => call === 'media').length, 1);
  assert.equal(c.calls.filter(call => call === 'upload').length, 1);
});
test('message unknown retries same UUID/content only inside 50m and never sends link fallback', async () => {
  const f = await eventFixture(), messages = [];
  const c = delivery(f, { send: args => { messages.push(JSON.stringify([args[2], args[3], args[4]])); throw new contract.VideoFeishuError('unknown', 503, true, true); } });
  await c.run(); f.ready(); await c.run(); assert.equal(messages[0], messages[1]); assert.equal(f.meta().mode, 'video');
  f.changeMeta(meta => { meta.nextAttemptAt = 0; meta.video.firstSendAt = Date.now() - feedback.SEND_WINDOW_MS - 1; });
  await c.run(); assert.equal(messages.length, 2); assert.equal(f.meta().state, 'unknown'); assert.equal(c.calls.includes('text'), false);
});
test('twelve attempts are finite, earlier ambiguity survives later explicit rejection', async () => {
  const f = await eventFixture(); let calls = 0;
  const c = delivery(f, { send: () => { calls++; throw new contract.VideoFeishuError('rejected', 503, calls === 1, true); } });
  for (let i = 0; i < 14; i++) { f.ready(); await c.run(); }
  assert.equal(calls, 12); assert.equal(f.meta().state, 'unknown'); assert.equal(f.meta().video.attempts, 12);
});
test('row lease rejects duplicate execution; losing receipt CAS never causes another send', async () => {
  const f = await eventFixture(); let release;
  const paused = new Promise(resolve => { release = resolve; });
  const c = delivery(f, { upload: async () => { await paused; return 'file_synthetic'; } });
  const first = c.run();
  while (!c.calls.includes('upload')) await new Promise(resolve => setImmediate(resolve));
  assert.equal(await c.run(), 'waiting');
  release(); await first; assert.equal(c.calls.filter(call => call === 'upload').length, 1);
  const g = await eventFixture(), d = delivery(g, { send: () => { g.changeMeta(meta => { meta.leaseToken = 'other-lease'; }); return 'om_media'; } });
  assert.equal(await d.run(), 'lease_lost'); assert.equal(d.calls.filter(call => call === 'media').length, 1); assert.equal(d.calls.includes('text'), false);
});
const sourceImports = { './feishu-contract': contract, '@aws-sdk/client-s3': {}, '@volcengine/tos-sdk': {} };
function sourceFixture(options = {}) {
  const { Readable } = require('node:stream'), file = Buffer.alloc(32);
  file.writeUInt32BE(32, 0); file.write('ftyp', 4); file.write(options.brand || 'isom', 8);
  const calls = [], info = { dev: 1, ino: 2, size: options.size || file.length, mtimeMs: 100, ctimeMs: 100, isFile: () => true };
  const task = { ...fakeDb().task }, env = { NODE_ENV: 'test' };
  const bytes = () => Readable.from(options.chunks || [file]);
  const fsModel = {
    realpath: async value => options.symlink && value.endsWith('.mp4') ? '/outside/original.mp4' : value,
    open: async (value, flags) => {
      if (value.endsWith('/original.mp4')) return { write: async (_bytes, _offset, length) => ({ bytesWritten: length }), close: async () => calls.push('output-close') };
      calls.push(['open', flags]);
      return { stat: async () => ({ ...info }), createReadStream: bytes, close: async () => calls.push('original-close') };
    },
    stat: async value => value.endsWith('cover.jpg') ? { isFile: () => true, size: 24 } : { ...info },
    mkdir: async () => {}, mkdtemp: async () => '/synthetic-tmp/delivery-owned', rm: async () => calls.push('cleanup'),
  };
  const child = { execFile: (binary, args, _options, done) => {
    calls.push(binary); assert.ok(args.includes('file,pipe'));
    done(null, binary === 'ffprobe' ? JSON.stringify({ format: { format_name: 'mov,mp4', duration: '1.25' }, streams: [{ codec_type: 'video' }] }) : '');
  } };
  let headCount = 0;
  class S3Client {
    async send(command) {
      calls.push(command.kind);
      if (command.kind === 'HEAD') return { ContentLength: info.size, ETag: options.remoteChanged && ++headCount > 1 ? 'changed' : 'original', VersionId: 'version-a' };
      assert.equal(command.input.IfMatch, 'original'); assert.equal(command.input.VersionId, 'version-a'); return { Body: bytes() };
    }
    destroy() { calls.push('sdk-close'); }
  }
  if (options.remote) {
    Object.assign(env, { R2_ACCOUNT_ID: 'a'.repeat(32), R2_ACCESS_KEY_ID: 'synthetic', R2_SECRET_ACCESS_KEY: 'synthetic', R2_BUCKET: 'synthetic', R2_PUBLIC_BASE_URL: 'https://synthetic.invalid' });
    Object.assign(task, { local_video_path: null, public_video_storage_provider: 'r2', public_video_storage_key: 'seedance-videos/seedance-video-synthetic-task-uuid.mp4',
      public_video_url: 'https://synthetic.invalid/seedance-videos/seedance-video-synthetic-task-uuid.mp4' });
  }
  const source = load('src/lib/video/feishu-source.ts', { ...sourceImports, 'node:fs/promises': fsModel,
    'node:fs': { constants: require('node:fs').constants, openAsBlob: async (_file, input) => new Blob(['synthetic'], { type: input.type }) },
    'node:child_process': child, '@aws-sdk/client-s3': { S3Client,
      HeadObjectCommand: class { constructor(input) { this.input = input; this.kind = 'HEAD'; } },
      GetObjectCommand: class { constructor(input) { this.input = input; this.kind = 'GET'; } } },
  }, { process: { env, cwd: () => '/synthetic-runtime' } });
  return { source, task, info, calls };
}
test('actual local source reader binds realpath/no-follow/fd/version and owns temp cleanup', async () => {
  const f = sourceFixture(), prepared = await f.source.prepareVideoFeishuSource(f.task);
  assert.equal(prepared.mode, 'video'); assert.equal(prepared.durationMs, 1250); assert.ok(prepared.cover);
  assert.ok(f.calls.find(call => Array.isArray(call) && (call[1] & require('node:fs').constants.O_NOFOLLOW)));
  assert.equal(await prepared.current(), true); f.info.mtimeMs++; assert.equal(await prepared.current(), false);
  await prepared.close(); assert.ok(f.calls.includes('original-close')); assert.ok(f.calls.includes('cleanup'));
  const escaped = sourceFixture({ symlink: true });
  await assert.rejects(escaped.source.prepareVideoFeishuSource(escaped.task), /original_not_ready/);
  assert.equal(escaped.calls.some(call => Array.isArray(call)), false);
});
test('actual bounded stream rejects excess/incomplete bytes and never transcodes originals', async () => {
  for (const options of [{ chunks: [Buffer.alloc(33)] }, { chunks: [Buffer.alloc(3)] }]) {
    const f = sourceFixture(options); await assert.rejects(f.source.prepareVideoFeishuSource(f.task), /original_not_ready/);
    assert.ok(f.calls.includes('original-close')); assert.ok(f.calls.includes('cleanup')); assert.equal(f.calls.includes('ffmpeg'), false);
  }
  const big = sourceFixture({ size: contract.VIDEO_FEISHU_MAX_BYTES + 1 }), result = await big.source.prepareVideoFeishuSource(big.task);
  assert.equal(result.mode, 'link'); assert.equal(big.calls.includes('ffprobe'), false); await result.close();
  const quicktime = sourceFixture({ brand: 'qt  ' }), other = await quicktime.source.prepareVideoFeishuSource(quicktime.task);
  assert.equal(other.reason, 'video_format_unsupported'); assert.equal(quicktime.calls.includes('ffmpeg'), false); await other.close();
});
test('actual R2 reader uses conditional object GET and verifies unchanged final HEAD', async () => {
  const f = sourceFixture({ remote: true }), prepared = await f.source.prepareVideoFeishuSource(f.task);
  assert.equal(prepared.mode, 'video'); assert.ok(f.calls.includes('GET')); assert.ok(f.calls.filter(call => call === 'HEAD').length >= 2); await prepared.close();
  const changed = sourceFixture({ remote: true, remoteChanged: true });
  await assert.rejects(changed.source.prepareVideoFeishuSource(changed.task), /original_not_ready/);
  assert.ok(changed.calls.includes('sdk-close')); assert.ok(changed.calls.includes('cleanup'));
});
test('source size, probe and canonical configured bucket/key reject filename/URL-only claims', () => {
  const env = { R2_PUBLIC_BASE_URL: 'https://synthetic.invalid' };
  const source = load('src/lib/video/feishu-source.ts', sourceImports, { process: { env, cwd: () => '/synthetic-runtime' } });
  assert.equal(source.videoFeishuSizeMode(contract.VIDEO_FEISHU_MAX_BYTES), 'video'); assert.equal(source.videoFeishuSizeMode(contract.VIDEO_FEISHU_MAX_BYTES + 1), 'link');
  for (const size of [0, -1, NaN, Infinity]) assert.throws(() => source.videoFeishuSizeMode(size));
  assert.equal(source.videoFeishuProbe({ format: { format_name: 'mov,mp4', duration: '1.25' }, streams: [{ codec_type: 'video' }] }).durationMs, 1250);
  assert.equal(source.videoFeishuProbe({ format: { format_name: 'webm', duration: '1' }, streams: [{ codec_type: 'video' }] }).supported, false);
  assert.throws(() => source.videoFeishuProbe({ format: { duration: 'NaN' }, streams: [] }));
  const task = { id: 'synthetic-task', public_video_storage_provider: 'r2', public_video_storage_key: 'seedance-videos/seedance-video-synthetic-task-uuid.mp4',
    public_video_url: 'https://synthetic.invalid/seedance-videos/seedance-video-synthetic-task-uuid.mp4' };
  assert.equal(source.videoFeishuRemoteLocation(task).provider, 'r2');
  for (const changes of [{ public_video_url: 'https://elsewhere.invalid/video.mp4' }, { public_video_storage_key: '../private.mp4' },
    { public_video_storage_key: 'seedance-videos/seedance-video-other-uuid.mp4' }, { public_video_storage_provider: 'unknown' }]) assert.throws(() => source.videoFeishuRemoteLocation({ ...task, ...changes }));
});
test('real transport validates MP4 bounds and official media fields; response errors are bounded/safe', async () => {
  const captured = [];
  const transport = load('src/lib/video/feishu-transport.ts', { './feishu-contract': contract }, { fetch: async (url, options) => {
    captured.push({ url, options }); return Response.json({ code: 0, data: url.endsWith('/files') ? { file_key: 'file_synthetic' } : { message_id: 'om_synthetic' } });
  } });
  const file = new Blob(['synthetic'], { type: 'video/mp4' });
  await transport.uploadVideoFeishuFile('not-real-token', 'synthetic-task', file, 1250);
  assert.equal(captured[0].options.body.get('duration'), '1250'); assert.equal(captured[0].options.body.get('file_type'), 'mp4');
  await transport.sendVideoFeishuMessage('not-real-token', 'ou_synthetic', contract.videoFeishuUuid('synthetic-task', 'video'), 'media', { file_key: 'file_synthetic' }, Date.now() + 10000, Date.now() + 10000);
  const message = JSON.parse(captured[1].options.body); assert.equal(message.msg_type, 'media'); assert.equal(JSON.parse(message.content).file_key, 'file_synthetic');
  await assert.rejects(transport.uploadVideoFeishuFile('not-real-token', 'synthetic-task', new Blob([], { type: 'video/mp4' }), 1000), /video_file_invalid/);
  await assert.rejects(transport.sendVideoFeishuMessage('not-real-token', 'ou_synthetic', message.uuid, 'text', { text: 'test' }, Date.now() - 1, Date.now() + 10000), /message_window_ended/);
  const unsafe = load('src/lib/video/feishu-transport.ts', { './feishu-contract': contract }, { fetch: async () => { throw Error('credential=SHOULD_NOT_ESCAPE'); } });
  await assert.rejects(unsafe.uploadVideoFeishuFile('not-real-token', 'synthetic-task', file, 1000), error => error.ambiguous && !error.message.includes('SHOULD_NOT_ESCAPE'));
});
test('HTTP routes use real dynamic slug, private no-cache and fresh same-tx helpers with no credential output', async () => {
  const f = fakeDb(), prisma = { $transaction: async work => work(f.db) };
  const auth = { AuthError, getSession: async () => ({ id: 'actor' }) };
  const http = load('src/lib/video/feishu-http.ts', { '@/lib/auth/session': auth, './feishu-contract': contract, 'next/server': { NextResponse: Response } });
  const imports = { '@/lib/auth/session': auth, '@/lib/prisma': { prisma }, '@/lib/video/feishu-notification': notification,
    '@/lib/video/feishu-contract': contract, '@/lib/video/feishu-http': http };
  const pref = load('src/app/api/user/video-feishu/route.ts', imports);
  const response = await pref.GET(); assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /private, no-store/);
  const value = await response.json(); assert.equal(value.enabled, false); assert.deepEqual(Object.keys(value).sort(), ['available', 'enabled', 'revision', 'version']);
  const task = load('src/app/api/tasks/[id]/feishu/route.ts', imports);
  const status = await task.GET(new Request('https://synthetic.invalid'), { params: { id: f.task.id } }); assert.equal((await status.json()).state, 'not_requested');
  const bad = await pref.PUT(new Request('https://synthetic.invalid', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, enabled: true, revision: 0, openId: 'ou_other' }) }));
  assert.equal(bad.status, 400); assert.equal(f.state.writes.length, 0);
});
test('consumer singleton CAS blocks another process and retains a finite 50-row scan', async () => {
  const f = await eventFixture(); let platformRow = null, scan;
  const db = { ...f.db, platformSetting: {
    findUnique: async () => platformRow && { ...platformRow },
    create: async ({ data }) => { if (platformRow) throw Object.assign(Error('conflict'), { code: 'P2002' }); platformRow = { ...data }; },
    updateMany: async ({ where, data }) => {
      if (!platformRow || platformRow.key !== where.key || platformRow.value_json !== where.value_json) return { count: 0 };
      Object.assign(platformRow, data); return { count: 1 };
    },
  }, notification: { ...f.db.notification, findMany: async args => { scan = args; return [f.row()]; } } };
  let release; const pause = new Promise(resolve => { release = resolve; });
  const first = delivery(f, { prisma: db, upload: async () => { await pause; return 'file_synthetic'; } }), other = delivery(f, { prisma: db });
  const pending = first.processVideoFeishuDeliveries();
  while (!first.calls.includes('upload')) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await other.processVideoFeishuDeliveries()).processed, 0);
  release(); assert.equal((await pending).processed, 1);
  assert.equal(scan.take, 50); assert.equal(scan.where.type, contract.VIDEO_FEISHU_TYPE); assert.equal(other.calls.length, 0);
  assert.equal(JSON.parse(platformRow.value_json).until, 0);
});
test('new files have syntax diagnostics zero; no direct create/provider/billing write escapes', () => {
  const files = ['feishu-contract', 'feishu-notification', 'feishu-source', 'feishu-transport', 'feishu-delivery', 'feishu-http'].map(name => `src/lib/video/${name}.ts`);
  files.push('src/app/api/user/video-feishu/route.ts', 'src/app/api/tasks/[id]/feishu/route.ts');
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const result = ts.transpileModule(source, { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
    assert.equal(result.diagnostics.length, 0, file);
    assert.doesNotMatch(source, /(?:videoTask|creditLedger|providerRequest)\.(?:update|create|delete)|cacheTaskVideo|ensurePublicVideoDelivery|setInterval/);
  }
});
test('explicit choice normalization never treats missing input as saved preference permission', () => {
  const contract = load('src/lib/video/feishu-contract.ts');
  assert.equal(typeof contract.normalizeVideoFeishuChoice, 'function');
  assert.equal(contract.normalizeVideoFeishuChoice(undefined).enabled, false);
  assert.throws(() => contract.normalizeVideoFeishuChoice({ enabled: true }));
});
test('separate bounded consumer exists without changing the old feedback worker', () => {
  const file = path.join(root, 'src/lib/video/feishu-delivery.ts');
  assert.equal(fs.existsSync(file), true);
  assert.match(fs.readFileSync(file, 'utf8'), /export\s+async\s+function\s+processVideoFeishuDeliveries/);
});
(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log('PASS ' + name); }
    catch (error) { failures++; console.log('FAIL ' + name + ': ' + error.message); }
  }
  console.log(`${tests.length - failures}/${tests.length} synthetic checks passed; no native/media/provider acceptance`);
  process.exitCode = failures ? 1 : 0;
})();
