import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, realpathSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import sharp from 'sharp';
import type { RequestStore } from 'next/dist/client/components/request-async-storage.external';
import type { BridgeFeishuEvent } from '../src/lib/bridge/feishu-contract';

async function main() {
  const root = process.cwd();
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'sd2-bridge-feishu-test-')));
  // Never load .env or use the caller's DB/configuration. All external traffic is intercepted.
  Object.assign(process.env, { DATABASE_URL: 'file:' + path.join(scratch, 'synthetic.db'), SESSION_SECRET: 'bridge-feishu-isolated-test',
    NODE_ENV: 'test', PRISMA_GENERATE_SKIP_AUTOINSTALL: '1', NEXT_TELEMETRY_DISABLED: '1', TSX_TSCONFIG_PATH: path.join(root, 'tsconfig.json'),
    FEISHU_APP_ID: 'test-app', FEISHU_APP_SECRET: 'test-secret', FEISHU_ALLOWED_TENANT_KEY: 'test-tenant', FEISHU_FEEDBACK_ENABLED: 'false' });
  Object.assign(globalThis, { AsyncLocalStorage });
  const schema = path.join(scratch, 'schema.prisma');
  copyFileSync(path.join(root, 'prisma/schema.prisma'), schema);
  execFileSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'db', 'push', '--schema', schema, '--skip-generate'],
    { cwd: scratch, env: process.env, stdio: 'pipe', timeout: 120_000 });
  const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
  const originalLoad = loader._load;
  loader._load = (id, ...args) => id === 'server-only' ? {} : originalLoad(id, ...args);

  const { prisma } = await import('../src/lib/prisma');
  const { feedbackPrisma } = await import('../src/lib/feedback/notification');
  const { createSession } = await import('../src/lib/auth/session');
  const { requestAsyncStorage } = await import('next/dist/client/components/request-async-storage.external');
  const { RequestCookies } = await import('next/dist/server/web/spec-extension/cookies');
  const { NextRequest } = await import('next/server');
  const route = await import('../src/app/api/bridge/feishu/send/route');
  const statusRoute = await import('../src/app/api/bridge/feishu/send/[id]/route');
  const { BRIDGE_FEISHU_TYPE, BRIDGE_FEISHU_RATE_KEY, FEISHU_NOT_BOUND, FEISHU_UNKNOWN } = await import('../src/lib/bridge/feishu-contract');
  const { deliverBridgeFeishuNotification, processBridgeFeishuDeliveries } = await import('../src/lib/bridge/feishu-delivery');
  const cookies = new Map<string, string>();
  const cases: string[] = [];
  const images: Array<{ id: string; file: string; bytes: Buffer }> = [];
  const messages: Array<{ uuid: string; receive_id: string; msg_type: string; content: string }> = [];
  let uploads = 0;
  let mockMode = 'success';
  let beforeMessage: (() => Promise<void>) | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal') {
      if (mockMode === 'token-retry') return Response.json({ code: 99991400 }, { status: 429 });
      return Response.json({ code: 0, tenant_access_token: 'synthetic-token' });
    }
    if (url === 'https://open.feishu.cn/open-apis/im/v1/images') {
      uploads++;
      assert.ok(init?.body instanceof FormData);
      const image = init.body.get('image') as Blob;
      const bytes = Buffer.from(await image.arrayBuffer());
      assert.ok(images.some(source => source.bytes.equals(bytes)), 'uploads exact original bytes');
      if (mockMode === 'upload-unknown') throw new Error('synthetic network failure');
      if (mockMode === 'upload-reject') return Response.json({ code: 234001 });
      return Response.json({ code: 0, data: { image_key: `img_test_${uploads}` } });
    }
    if (url === 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id') {
      const body = JSON.parse(String(init?.body)); messages.push(body);
      assert.equal(body.receive_id, 'ou_owner'); assert.equal(body.msg_type, 'interactive');
      await beforeMessage?.();
      if (mockMode === 'message-unknown') throw new Error('synthetic network failure');
      if (mockMode === 'message-reject') return Response.json({ code: 230001 });
      return Response.json({ code: 0, data: { message_id: `om_test_${messages.length}` } });
    }
    throw new Error('Unexpected network call blocked by test');
  };
  async function call(actor: string | null, method: 'GET' | 'POST', body?: unknown, eventId?: string) {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (actor) headers.set('Cookie', 'session=' + cookies.get(actor));
    const request = new NextRequest('http://localhost/api/bridge/feishu/send' + (eventId ? '/' + eventId : ''), {
      method, headers, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    const store = { headers, cookies: new RequestCookies(headers) } as unknown as RequestStore;
    const response = await requestAsyncStorage.run(store, async () => method === 'POST' ? route.POST(request)
      : eventId ? statusRoute.GET(request, { params: { id: eventId } }) : route.GET());
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    return { status: response.status, data: await response.json() };
  }
  const payload = (requestId = 'mj-test-1', assetIds = images.map(image => image.id)) => ({ requestId, source: 'mj', assetIds,
    text: '测试提示词'.repeat(250), link: 'https://www.midjourney.com/jobs/test' });
  const row = (id: string) => prisma.notification.findUniqueOrThrow({ where: { id } });
  const meta = async (id: string) => JSON.parse((await row(id)).metadata_json!) as BridgeFeishuEvent;
  const change = async (id: string, update: (value: BridgeFeishuEvent) => void) => {
    const value = await meta(id); update(value);
    await prisma.notification.update({ where: { id }, data: { metadata_json: JSON.stringify(value) } });
  };
  const deliver = async (id: string) => deliverBridgeFeishuNotification(prisma, await row(id));
  const test = async (name: string, run: () => Promise<void>) => {
    await prisma.notification.deleteMany();
    await prisma.userPreference.deleteMany({ where: { key: BRIDGE_FEISHU_RATE_KEY } });
    mockMode = 'success'; uploads = 0; messages.length = 0; beforeMessage = null;
    await run(); cases.push(name); console.log('PASS ' + name);
  };
  try {
    for (const id of ['owner', 'other', 'unbound']) {
      await prisma.user.create({ data: { id, name: id, username: id, email: id + '@example.test', password_hash: 'synthetic-unused',
        feishu_open_id: id === 'unbound' ? null : `ou_${id}`, feishu_tenant_key: 'test-tenant' } });
      cookies.set(id, await createSession(id));
    }
    mkdirSync(path.join(scratch, 'public/uploads/assets'), { recursive: true });
    process.chdir(scratch);
    for (let index = 0; index < 4; index++) {
      const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: index * 50, g: 30, b: 60 } } }).png().toBuffer();
      const hash = createHash('sha256').update(bytes).digest('hex');
      const file = path.join(scratch, `public/uploads/assets/${hash}.png`); writeFileSync(file, bytes);
      const asset = await prisma.asset.create({ data: { owner_id: 'owner', type: 'image', original_url: `/uploads/assets/${hash}.png`,
        file_name: `test-${index}.png`, mime_type: 'image/png', file_size: bytes.length, hash, width: 2, height: 2 } });
      images.push({ id: asset.id, bytes, file });
    }
    await test('预检与三个入口的 401；bound true / false；未绑定 409 原文', async () => {
      for (const result of [await call(null, 'GET'), await call(null, 'POST', payload()), await call(null, 'GET', undefined, 'missing')]) {
        assert.equal(result.status, 401); assert.deepEqual(result.data, { ok: false, error: '未登录' });
      }
      assert.deepEqual((await call('owner', 'GET')).data, { ok: true, bound: true });
      assert.deepEqual((await call('unbound', 'GET')).data, { ok: true, bound: false, error: FEISHU_NOT_BOUND });
      const missing = await call('unbound', 'POST', payload());
      assert.equal(missing.status, 409); assert.deepEqual(missing.data, { ok: false, code: 'feishu_not_bound', error: FEISHU_NOT_BOUND });
      assert.equal(await prisma.notification.count(), 0); assert.equal(uploads, 0);
    });
    await test('参数校验 400；链接白名单；未知字段不保存', async () => {
      for (const body of ['{', null, [], {}, { ...payload(), requestId: '' }, { ...payload(), requestId: 'x'.repeat(81) },
        { ...payload(), source: 'other' }, { ...payload(), source: ['mj'] }, { ...payload(), assetIds: [] },
        { ...payload(), assetIds: ['../x'] }, { ...payload(), assetIds: [images[0].id, images[0].id] },
        { ...payload(), assetIds: [...images.map(image => image.id), 'fifth'] }, { ...payload(), text: 3 }, { ...payload(), text: '字'.repeat(4001) }]) {
        const result = await call('owner', 'POST', body); assert.equal(result.status, 400); assert.match(result.data.error, /[\u4e00-\u9fff]/);
      }
      const badLinks = ['https://www.midjourney.com.evil.test/x', 'https://www.midjourney.com@evil.test/x', 'http://chatgpt.com/x', 'file:///secret'];
      for (let index = 0; index < badLinks.length; index++) {
        const link = badLinks[index];
        const result = await call('owner', 'POST', { ...payload('bad-link-' + index), link, openId: 'ou_other', cookie: 'discard' });
        assert.equal(result.status, 200); const stored = await row(result.data.id);
        assert.equal((await meta(result.data.id)).input.link, ''); assert.doesNotMatch(stored.metadata_json!, /ou_other|discard/);
      }
      for (const source of ['chatgpt', 'jimeng']) {
        const link = source === 'chatgpt' ? 'https://chatgpt.com/c/test' : 'https://jimeng.jianying.com/test';
        const result = await call('owner', 'POST', { ...payload(source), source, link, text: '' });
        assert.equal(result.status, 200); assert.equal((await meta(result.data.id)).input.link, link);
      }
    });
    await test('asset 归属和不存在 403；超大原图 413；不支持格式 400', async () => {
      assert.equal((await call('other', 'POST', payload())).status, 403);
      assert.equal((await call('owner', 'POST', payload('missing', ['missing']))).status, 403);
      const source = await prisma.asset.findUniqueOrThrow({ where: { id: images[0].id } });
      await prisma.asset.update({ where: { id: source.id }, data: { file_size: 10_000_001 } });
      assert.equal((await call('owner', 'POST', payload())).status, 413);
      await prisma.asset.update({ where: { id: source.id }, data: { file_size: source.file_size, mime_type: 'image/avif' } });
      assert.equal((await call('owner', 'POST', payload())).status, 400);
      await prisma.asset.update({ where: { id: source.id }, data: { mime_type: source.mime_type } });
    });
    await test('重复与并发 POST / worker 只投递一次；四原图和提示词链接卡片', async () => {
      const results = await Promise.all([call('owner', 'POST', payload()), call('owner', 'POST', payload())]);
      results.forEach(result => assert.equal(result.status, 200)); assert.equal(results[0].data.id, results[1].data.id);
      const id = results[0].data.id; assert.equal(await prisma.notification.count(), 1);
      beforeMessage = async () => {
        assert.equal((await meta(id)).message.uncertain, true, 'intent committed before external send');
        const repeated = await call('owner', 'POST', { ...payload(), text: '不应替换原文' });
        assert.equal(repeated.data.state, 'sending');
      };
      const originalRow = await row(id);
      await Promise.all([deliverBridgeFeishuNotification(prisma, originalRow), deliverBridgeFeishuNotification(prisma, originalRow)]);
      assert.equal(messages.length, 1); assert.equal(uploads, 4);
      assert.equal((await call('owner', 'POST', payload())).data.state, 'sent');
      await deliver(id); assert.equal(messages.length, 1);
      const card = JSON.parse(messages[0].content);
      assert.equal(card.header.title.content, 'MJ 出图 · 4 张'); assert.equal(card.elements.filter((item: { tag: string }) => item.tag === 'img').length, 4);
      assert.match(card.elements[0].text.content, /已截断/); assert.ok(card.elements.filter((item: { tag: string }) => item.tag === 'img').every((item: { preview: boolean }) => item.preview));
      assert.equal(card.elements.at(-1).actions[0].url, payload().link);
      assert.equal((await row(id)).status, 'sent'); assert.ok((await row(id)).sent_at);
    });
    await test('GET 仅本人可查；同 requestId 跨用户独立', async () => {
      const result = await call('owner', 'POST', payload());
      assert.equal((await call('owner', 'GET', undefined, result.data.id)).data.state, 'queued');
      assert.equal((await call('other', 'GET', undefined, result.data.id)).status, 404);
      assert.equal((await call('owner', 'GET', undefined, 'missing')).status, 404);
      const ownOther = await prisma.asset.create({ data: { ...(await prisma.asset.findUniqueOrThrow({ where: { id: images[0].id } })), id: 'other-asset', owner_id: 'other' } });
      const other = await call('other', 'POST', payload('mj-test-1', [ownOther.id]));
      assert.equal(other.status, 200); assert.notEqual(other.data.id, result.data.id);
    });
    await test('明确消息失败允许重试；原事件 / 内容 / uuid / 已上传图片均保留', async () => {
      const id = (await call('owner', 'POST', payload())).data.id;
      mockMode = 'message-reject'; assert.equal(await deliver(id), 'failed');
      assert.equal((await call('owner', 'GET', undefined, id)).data.state, 'failed');
      mockMode = 'success';
      const retried = await call('owner', 'POST', { ...payload(), text: '替换文本', assetIds: [images[0].id] });
      assert.equal(retried.data.id, id); assert.equal(retried.data.state, 'queued');
      assert.equal(await deliver(id), 'sent'); assert.equal(messages.length, 2); assert.equal(uploads, 4);
      assert.equal(messages[0].uuid, messages[1].uuid); assert.equal(messages[0].content, messages[1].content);
    });
    await test('明确上传失败后重试可再次上传', async () => {
      const id = (await call('owner', 'POST', payload('upload-retry', [images[0].id]))).data.id;
      mockMode = 'upload-reject'; assert.equal(await deliver(id), 'failed'); assert.equal(messages.length, 0);
      mockMode = 'success'; assert.equal((await call('owner', 'POST', payload('upload-retry'))).data.state, 'queued');
      assert.equal(await deliver(id), 'sent'); assert.equal(uploads, 2); assert.equal(messages.length, 1);
    });
    await test('消息结果未知和上传结果未知都不重发', async () => {
      for (const mode of ['message-unknown', 'upload-unknown']) {
        const body = payload(mode, [images[0].id]); const id = (await call('owner', 'POST', body)).data.id;
        mockMode = mode; assert.equal(await deliver(id), 'unknown');
        const count = { uploads, messages: messages.length }; mockMode = 'success';
        for (const result of [await call('owner', 'POST', body), await call('owner', 'GET', undefined, id)]) {
          assert.equal(result.data.state, 'failed'); assert.equal(result.data.reason, FEISHU_UNKNOWN);
        }
        await deliver(id); assert.deepEqual({ uploads, messages: messages.length }, count);
      }
    });
    await test('过期租约：发送中崩溃不重发；准备中崩溃可恢复', async () => {
      for (const part of ['message', 'upload', 'preparation']) {
        const id = (await call('owner', 'POST', payload(part, [images[0].id]))).data.id;
        await change(id, value => { value.state = 'sending'; value.leaseToken = 'crashed'; value.leaseUntil = Date.now() - 1;
          if (part === 'message') value.message.uncertain = true;
          if (part === 'upload') value.images[0].uploading = true; });
        assert.equal(await deliver(id), part === 'preparation' ? 'sent' : 'unknown');
      }
      assert.equal(uploads, 1); assert.equal(messages.length, 1);
    });
    await test('token 临时失败有限自动重试，租约释放且 GET 不触发发送', async () => {
      const id = (await call('owner', 'POST', payload('token-retry', [images[0].id]))).data.id;
      mockMode = 'token-retry'; assert.equal(await deliver(id), 'deferred');
      assert.equal((await meta(id)).leaseToken, null); assert.equal(await deliver(id), 'waiting');
      await call('owner', 'GET', undefined, id); assert.equal(messages.length, 0);
      await change(id, value => { value.nextAttemptAt = 0; });
      mockMode = 'success'; assert.equal(await deliver(id), 'sent');
    });
    await test('绑定变化、素材归属变化和字节 hash 变化均阻止外发', async () => {
      let id = (await call('owner', 'POST', payload('binding-change'))).data.id;
      await prisma.user.update({ where: { id: 'owner' }, data: { feishu_open_id: 'ou_changed' } });
      assert.equal(await deliver(id), 'failed');
      await prisma.user.update({ where: { id: 'owner' }, data: { feishu_open_id: 'ou_owner' } });
      cookies.set('owner', await createSession('owner'));
      id = (await call('owner', 'POST', payload('ownership-change'))).data.id;
      await prisma.asset.update({ where: { id: images[1].id }, data: { owner_id: 'other' } });
      assert.equal(await deliver(id), 'failed');
      await prisma.asset.update({ where: { id: images[1].id }, data: { owner_id: 'owner' } });
      id = (await call('owner', 'POST', payload('hash-change'))).data.id;
      const changed = Buffer.from(images[0].bytes); changed[changed.length - 1] ^= 1; writeFileSync(images[0].file, changed);
      assert.equal(await deliver(id), 'failed'); writeFileSync(images[0].file, images[0].bytes);
      assert.equal(messages.length, 0); assert.equal(uploads, 0);
    });
    await test('每人每分钟最多十次新投递 / 重试，幂等查询不占次数', async () => {
      const accepted = await Promise.all(Array.from({ length: 11 }, (_, index) => call('owner', 'POST', payload('rate-' + index))));
      assert.equal(accepted.filter(result => result.status === 200).length, 10);
      assert.equal(accepted.filter(result => result.status === 429).length, 1);
      assert.equal(await prisma.notification.count(), 10);
      const first = accepted.findIndex(result => result.status === 200);
      assert.equal((await call('owner', 'POST', payload('rate-' + first))).status, 200);
      const retryId = accepted[first].data.id; mockMode = 'message-reject'; await deliver(retryId);
      assert.equal((await call('owner', 'POST', payload('rate-' + first))).status, 429);
      await prisma.userPreference.update({ where: { user_id_key: { user_id: 'owner', key: BRIDGE_FEISHU_RATE_KEY } }, data: { value_json: JSON.stringify([Date.now() - 60_001]) } });
      assert.equal((await call('owner', 'POST', payload('rate-' + first))).data.state, 'queued');
    });
    await test('bridge 消费者隔离旧通知类型', async () => {
      const old = await prisma.notification.create({ data: { id: 'old-video-event', target_user_id: 'owner', type: 'video_feishu_v1', channel: 'feishu', title: 'existing', metadata_json: '{}' } });
      const id = (await call('owner', 'POST', payload('isolated', [images[0].id]))).data.id;
      assert.equal((await processBridgeFeishuDeliveries()).processed, 1);
      assert.equal((await row(id)).status, 'sent'); assert.deepEqual(await row(old.id), old);
    });
    await test('真实 feedback worker 入口接线，严格 mock 下消费 bridge 队列', async () => {
      const id = (await call('owner', 'POST', payload('worker', [images[0].id]))).data.id;
      const preload = path.join(scratch, 'worker-mock.cjs');
      writeFileSync(preload, `const Module = require('node:module'); const original = Module._load;
Module._load = function(id, ...args) { return id === 'server-only' ? {} : original.call(this, id, ...args); };
globalThis.fetch = async (input, init) => {
 const url = String(input);
 if (url === 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal') return Response.json({code:0,tenant_access_token:'test'});
 if (url === 'https://open.feishu.cn/open-apis/im/v1/images') return Response.json({code:0,data:{image_key:'img_worker'}});
 if (url === 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id') {
  if (JSON.parse(init.body).receive_id !== 'ou_owner') throw new Error('wrong recipient');
  return Response.json({code:0,data:{message_id:'om_worker'}});
 }
 throw new Error('Network blocked');
};`);
      const output = execFileSync(process.execPath, ['--require', preload, '--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'),
        path.join(root, 'scripts/process-feedback-deliveries.ts')], { cwd: scratch, env: { ...process.env, TMPDIR: path.dirname(scratch) }, encoding: 'utf8', timeout: 120_000 });
      const summary = JSON.parse(output.trim().split('\n').at(-1)!);
      assert.deepEqual(summary.failedQueues, []); assert.equal(summary.queues.bridge.processed, 1);
      assert.equal((await row(id)).status, 'sent'); assert.equal((await meta(id)).message.receiptId, 'om_worker');
    });
    const workerSource = readFileSync(path.join(root, 'scripts/process-feedback-deliveries.ts'), 'utf8');
    assert.match(workerSource, /bridgeDeliverySha/);
    console.log(JSON.stringify({ ok: true, cases: cases.length, coverage: cases, productionTouched: false, realFeishuCalls: 0, ddl: false }, null, 2));
  } finally {
    globalThis.fetch = originalFetch; loader._load = originalLoad; process.chdir(root);
    await Promise.all([prisma.$disconnect(), feedbackPrisma.$disconnect()]);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
