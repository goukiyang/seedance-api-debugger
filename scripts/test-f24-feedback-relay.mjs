import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { routePayload } from '../ops/feishu-credit-gateway.mjs';

const now = 1793174400000;
const env = { FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-app-secret',
  FEISHU_EVENT_ENCRYPT_KEY: 'synthetic-encryption-key', FEISHU_VERIFICATION_TOKEN: 'synthetic-verification-token' };
function signed(source) {
  const payload = { header: { app_id: env.FEISHU_APP_ID, tenant_key: 'synthetic-tenant', event_type: 'card.action.trigger', token: env.FEISHU_VERIFICATION_TOKEN },
    event: { operator: { open_id: 'synthetic-operator', tenant_key: 'synthetic-tenant' },
      action: { value: { source, feedbackId: 'synthetic-feedback', action: 'ack', nonce: 'synthetic-nonce' } } },
    context: { open_message_id: 'synthetic-message', open_chat_id: 'synthetic-chat' } };
  const raw = JSON.stringify(payload), timestamp = String(now / 1000), nonce = 'synthetic-request-nonce';
  return { raw, headers: { 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce,
    'x-lark-signature': createHash('sha256').update(timestamp + nonce + env.FEISHU_EVENT_ENCRYPT_KEY + raw).digest('hex') }, payload };
}
test('feedback has an independent signed route and retains official top-level callback message context', () => {
  const fixture = signed('sd2_feedback_ack_v1');
  const result = routePayload(fixture.raw, fixture.headers, env, now);
  assert.equal(result.kind, 'feedback');
  assert.deepEqual(JSON.parse(result.body).context, fixture.payload.context);
  assert.equal(result.headers['x-sd2-feedback-time'], String(now));
  const expected = createHmac('sha256', env.FEISHU_APP_SECRET).update(`sd2-feedback-relay-v1\n${now}\n${result.body}`).digest('hex');
  assert.equal(result.headers['x-sd2-feedback-signature'], expected);
  assert.equal(result.headers['x-sd2-credit-signature'], undefined);
});
test('existing credit body/purpose and all unrelated legacy raw payloads stay unchanged', () => {
  const fixture = signed('sd2_credit_requests_v1');
  const result = routePayload(fixture.raw, fixture.headers, env, now);
  assert.equal(result.kind, 'credit');
  assert.equal(result.body, JSON.stringify({ header: { app_id: env.FEISHU_APP_ID, tenant_key: 'synthetic-tenant', event_type: 'card.action.trigger' }, event: fixture.payload.event }));
  assert.equal(result.headers['x-sd2-credit-signature'], createHmac('sha256', env.FEISHU_APP_SECRET).update(`sd2-credit-relay-v1\n${now}\n${result.body}`).digest('hex'));
  const legacy = signed('another-existing-project');
  assert.deepEqual(routePayload(legacy.raw, legacy.headers, env, now), { kind: 'legacy', body: legacy.raw });
});
test('feedback bad signature, expired timestamp and missing configured key fail closed', () => {
  const fixture = signed('sd2_feedback_ack_v1');
  assert.throws(() => routePayload(fixture.raw, { ...fixture.headers, 'x-lark-signature': '0'.repeat(64) }, env, now));
  assert.throws(() => routePayload(fixture.raw, fixture.headers, env, now + 301000));
  assert.throws(() => routePayload(fixture.raw, fixture.headers, { ...env, FEISHU_EVENT_ENCRYPT_KEY: '' }, now));
});
