import assert from 'node:assert/strict';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import { verifyCreditRelay } from '../src/lib/feishu/credit-relay';
import { newerRelease } from '../src/lib/release';

async function main() {
  const { routePayload, createGateway } = await import('../ops/feishu-credit-gateway.mjs');
  const env = { NODE_ENV: 'test' as const, FEISHU_APP_ID: 'test-app', FEISHU_APP_SECRET: 'test-secret', FEISHU_EVENT_ENCRYPT_KEY: 'test-encrypt', FEISHU_VERIFICATION_TOKEN: 'test-token' };
  Object.assign(process.env, env, { FEISHU_ALLOWED_TENANT_KEY: 'test-tenant', CREDIT_CALLBACK_MODE: 'relay-v1' });
  const event = { header: { app_id: 'test-app', tenant_key: 'test-tenant', token: 'test-token', event_type: 'card.action.trigger' }, event: { operator: { open_id: 'test-admin' }, action: { value: { source: 'sd2_credit_requests_v1', requestId: 'test', action: 'prepare' } } } };
  const sign = (raw: string, time = String(Math.floor(Date.now() / 1000))) => {
    return { 'x-lark-request-timestamp': time, 'x-lark-request-nonce': 'test-nonce', 'x-lark-signature': createHash('sha256').update(time + 'test-nonce' + env.FEISHU_EVENT_ENCRYPT_KEY + raw).digest('hex') };
  };
  const raw = JSON.stringify(event);
  const goTime = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '.123456789 +0000 UTC m=+12345.123456789');
  assert.equal(routePayload(raw, sign(raw, goTime), env).kind, 'credit');
  assert.equal(routePayload(raw, sign(raw, String(Date.now())), env).kind, 'credit');
  assert.throws(() => routePayload(raw, sign(raw, '2000-01-01 00:00:00.12345678 +0000 UTC m=+12.1'), env));
  assert.throws(() => routePayload(raw, sign(raw, 'not-a-date'), env));
  const routed = routePayload(raw, sign(raw), env);
  assert.equal(routed.kind, 'credit');
  assert(verifyCreditRelay(routed.body, new Headers(routed.headers)).event);
  assert.throws(() => verifyCreditRelay(routed.body + ' ', new Headers(routed.headers)));
  assert.throws(() => verifyCreditRelay(routed.body, new Headers(routed.headers), Date.now() + 61000));
  process.env.FEISHU_ALLOWED_TENANT_KEY = 'other';
  assert.throws(() => verifyCreditRelay(routed.body, new Headers(routed.headers)));
  process.env.FEISHU_ALLOWED_TENANT_KEY = 'test-tenant';
  assert.throws(() => routePayload(raw, { ...sign(raw), 'x-lark-signature': 'bad' }, env));
  assert.throws(() => routePayload(raw, sign(raw), { ...env, FEISHU_APP_ID: 'other' }));
  const iv = randomBytes(16), cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(env.FEISHU_EVENT_ENCRYPT_KEY).digest(), iv);
  const encrypted = JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(raw), cipher.final()]).toString('base64') });
  assert.equal(routePayload(encrypted, sign(encrypted), env).kind, 'credit');
  const legacy = JSON.stringify({ event: { action: { value: { deliveryId: 'legacy-test', decision: 'confirm' } } } });
  assert.equal(routePayload(legacy, sign(legacy), env).body, legacy);
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const gateway = createGateway(env, async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body), headers: init?.headers as Record<string, string> }); return new Response(JSON.stringify({ toast: { type: 'success', content: 'test' } }));
  });
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const address = gateway.address(); assert(address && typeof address !== 'string');
    const port = address.port;
    const send = (body: string) => fetch(`http://127.0.0.1:${port}/webhooks/feishu/card-actions`, { method: 'POST', headers: sign(body), body });
    assert.equal((await send(legacy)).status, 200);
    assert.equal(calls[0].url, 'http://127.0.0.1:8788/webhooks/feishu/card-actions');
    assert.equal(calls[0].body, legacy); assert.equal(calls[0].headers['x-lark-signature'], sign(legacy)['x-lark-signature']);
    assert.equal((await send(encrypted)).status, 200);
    assert.equal(calls[1].url, 'http://127.0.0.1:3302/api/feishu/credit-actions');
    assert(verifyCreditRelay(calls[1].body, new Headers(calls[1].headers)).event);
  } finally { await new Promise<void>(resolve => gateway.close(() => resolve())); }
  assert(newerRelease('0.10.0', '0.2.0')); assert(!newerRelease('0.2.0', '0.2.0')); assert(!newerRelease('bad', '0.2.0'));
  console.log('PASS: gateway legacy passthrough, encrypted routing, internal signature, expiry, tenant isolation, SemVer');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
