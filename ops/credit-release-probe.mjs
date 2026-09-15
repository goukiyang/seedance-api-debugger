import assert from 'node:assert/strict';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Nonexistent request IDs ensure this signed transport probe cannot grant credits.
const env = process.env;
const approver = process.argv[process.argv.indexOf('--approver') + 1];
assert(process.argv.includes('--approver') && /^[a-z0-9]+$/.test(approver || ''));
const tenant = execFileSync('sqlite3', ['-readonly', '/data/video-api-debugger/var-lib/dev.db',
  `SELECT feishu_tenant_key FROM User WHERE id='${approver}' AND role='admin' AND status='active';`], { encoding: 'utf8' }).trim();
assert(tenant && env.FEISHU_EVENT_ENCRYPT_KEY && env.FEISHU_APP_SECRET);
async function send(url, payload) {
  const key = env.FEISHU_EVENT_ENCRYPT_KEY;
  const iv = randomBytes(16), cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(key).digest(), iv);
  const raw = JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(payload)), cipher.final()]).toString('base64') });
  const time = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '.123456789 +0000 UTC m=+12345.123456789');
  const nonce = randomBytes(12).toString('hex');
  const response = await fetch(url, { method: 'POST', body: raw, headers: {
    'Content-Type': 'application/json', 'x-lark-request-timestamp': time, 'x-lark-request-nonce': nonce,
    'x-lark-signature': createHash('sha256').update(time + nonce + key + raw).digest('hex'),
  }, signal: AbortSignal.timeout(8000) });
  assert.equal(response.status, 200);
  return response.json();
}
const id = `sd2-release-probe-${randomBytes(16).toString('hex')}`;
const event = { schema: '2.0', header: { event_id: id, event_type: 'card.action.trigger', app_id: env.FEISHU_APP_ID,
  tenant_key: tenant, token: env.FEISHU_VERIFICATION_TOKEN || env.ARTREVIEW_FEISHU_VERIFICATION_TOKEN },
  event: { operator: { open_id: 'release-probe-not-a-user' }, action: { value: { source: 'sd2_credit_requests_v1', requestId: id, nonce: id, action: 'prepare', amount: 2000 } } } };
const local = await send('http://127.0.0.1:8790/webhooks/feishu/card-actions', event);
assert.equal(local.toast?.content, '申请不存在');
const legacy = { ...event, event: { ...event.event, action: { value: { deliveryId: id, nonce: id, decision: 'confirm' } } } };
const direct = await send('http://127.0.0.1:8788/webhooks/feishu/card-actions', legacy);
const through = await send('http://127.0.0.1:8790/webhooks/feishu/card-actions', legacy);
assert.deepEqual(through, direct);
assert.match(String(direct.toast?.content), /失效|不存在/);
if (process.argv.includes('--public')) {
  assert.equal((await send('https://artreview.youdooart.com/webhooks/feishu/card-actions', event)).toast?.content, '申请不存在');
  assert.deepEqual(await send('https://artreview.youdooart.com/webhooks/feishu/card-actions', legacy), direct);
}
console.log('PASS: signed encrypted credit transport and unchanged legacy response; nonexistent requests, no credit writes');
