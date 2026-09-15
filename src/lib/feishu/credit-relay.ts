import { createHmac, timingSafeEqual } from 'node:crypto';

export const CREDIT_CARD_SOURCE = 'sd2_credit_requests_v1';
export function verifyCreditRelay(raw: string, headers: Headers, now = Date.now()) {
  const secret = process.env.FEISHU_APP_SECRET;
  const timestamp = headers.get('x-sd2-credit-time') || '';
  const signature = headers.get('x-sd2-credit-signature') || '';
  if (!secret || process.env.CREDIT_CALLBACK_MODE !== 'relay-v1' || !/^\d{13}$/.test(timestamp)
    || Math.abs(now - Number(timestamp)) > 60000 || !/^[a-f0-9]{64}$/.test(signature)) throw new Error('invalid_relay');
  const expected = createHmac('sha256', secret).update(`sd2-credit-relay-v1\n${timestamp}\n${raw}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new Error('invalid_relay');
  const payload = JSON.parse(raw);
  if (payload.header?.app_id !== process.env.FEISHU_APP_ID || payload.header?.tenant_key !== process.env.FEISHU_ALLOWED_TENANT_KEY
    || payload.header?.event_type !== 'card.action.trigger' || payload.event?.action?.value?.source !== CREDIT_CARD_SOURCE) throw new Error('invalid_relay_source');
  return { event: payload.event };
}
