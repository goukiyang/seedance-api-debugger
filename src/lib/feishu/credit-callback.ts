import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';

function equal(a: string, b: string) {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Feishu EventDispatcher SHA-256 protocol; unlike the SDK's permissive default, missing keys fail closed.
export function verifyCreditCallback(raw: string, headers: Headers, config: {
  encryptKey: string; verificationToken: string; appId: string; tenantKey: string;
}, now = Date.now()) {
  if (Buffer.byteLength(raw) > 32_768 || !config.encryptKey || !config.verificationToken || !config.appId || !config.tenantKey) throw new Error('callback_unavailable');
  const timestamp = headers.get('x-lark-request-timestamp') || '';
  const nonce = headers.get('x-lark-request-nonce') || '';
  const signature = headers.get('x-lark-signature') || '';
  if (!/^\d{10}$/.test(timestamp) || !nonce || nonce.length > 256 || Math.abs(now / 1000 - Number(timestamp)) > 300) throw new Error('callback_expired');
  const expected = createHash('sha256').update(timestamp + nonce + config.encryptKey + raw).digest('hex');
  if (!equal(signature, expected)) throw new Error('callback_signature_invalid');
  let payload = JSON.parse(raw);
  if (typeof payload.encrypt === 'string') {
    const bytes = Buffer.from(payload.encrypt, 'base64');
    const decipher = createDecipheriv('aes-256-cbc', createHash('sha256').update(config.encryptKey).digest(), bytes.subarray(0, 16));
    payload = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8'));
  }
  if (payload.type === 'url_verification') {
    if (!equal(String(payload.token || ''), config.verificationToken) || typeof payload.challenge !== 'string') throw new Error('callback_token_invalid');
    return { challenge: payload.challenge };
  }
  const header = payload.header;
  if (header?.event_type !== 'card.action.trigger' || header.app_id !== config.appId
    || header.tenant_key !== config.tenantKey || !equal(String(header.token || ''), config.verificationToken)) throw new Error('callback_source_invalid');
  return { event: payload.event };
}
